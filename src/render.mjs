// Terminal + JSON output. Default = THE single best model for the machine, big and
// clear. --all/--top show the ranked list. --json emits the stable integration
// contract ({ best, alternatives, ... }) for apps that embed ModelFit.

import { modelUrl, reportUrl, gpuUrl, SOURCE } from './links.mjs';
import { selectBest, bestContract } from './best.mjs';
import { baseModelId, groupVariants } from './model-groups.mjs';

const useColor = (opts) => !opts.noColor && !process.env.NO_COLOR && process.stdout.isTTY;

// Strip control chars from any dataset/hardware string before it reaches the
// terminal — a poisoned dataset must not inject ANSI/cursor sequences (CWE-150).
// Apply BEFORE paint(): paint's own color codes are internal and safe.
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '');

function paint(opts) {
  const on = useColor(opts);
  const w = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    bold: w('1'), dim: w('2'), cyan: w('36'), green: w('32'),
    yellow: w('33'), red: w('31'), gray: w('90'),
  };
}

/**
 * The one wording for a decode-speed estimate: "est. 42 tok/s, typical error 10%". The error is
 * the engine's own (estimatedErrorPct: held-out median error of the fitted speed model for this
 * backend and model size); when it is null (legacy path) the estimate prints alone.
 */
export function estLabel(tps, errorPct) {
  if (tps == null) return '';
  const base = `est. ${Math.round(tps)} tok/s`;
  return errorPct == null ? base : `${base}, typical error ${Math.round(errorPct)}%`;
}

const ERROR_NOTE = 'Typical error: median gap between the estimate and measured runs on hardware the model was not fitted on.';

/** Locally-runnable models (drops cloud_only + local_unlikely), best-first, one row per model
 *  (quant builds of the same model fold into `variants`, as on the site). */
export function localRunnable(recs) {
  const runnable = recs.filter((r) => r.localVerdict !== 'cloud_only' && r.localVerdict !== 'local_unlikely');
  return groupVariants(runnable.length ? runnable : recs.filter((r) => r.localVerdict !== 'cloud_only'));
}

const sameModel = (a, b) => !!a && !!b && baseModelId(a) === baseModelId(b);

function recRecord(r) {
  return {
    name: clean(r.name),
    params: `${r.sizeB}B`,
    quantization: r.quantization,
    ollamaCommand: r.ollamaCommand != null ? clean(r.ollamaCommand) : null,
    fit: r.fitLevel,
    localVerdict: r.localVerdict,
    estimatedTokensPerSec: r.estimatedTokensPerSec,
    estimatedErrorPct: r.estimatedErrorPct ?? null,
    bestFor: clean(r.bestFor),
    why: clean(r.why),
    learnMoreUrl: modelUrl(r.family),
    // Other quantizations of the same model that were ranked (additive field).
    otherQuantizations: (r.variants ?? []).map((v) => v.quantization),
  };
}

/** { best: <contract>, alternatives: [...], hardware, source, reportUrl }. */
export function toJson(profile, input, recs, opts) {
  const best = selectBest(recs);
  const list = localRunnable(recs);
  const altCount = opts.all ? list.length : (opts.top ?? 3);
  return {
    best: bestContract(best, input, profile),
    alternatives: list.filter((r) => !sameModel(r, best)).slice(0, Math.max(0, altCount)).map(recRecord),
    hardware: {
      os: profile.os,
      device: profile.deviceLabel,
      chip: profile.chipLabel,
      accelerator: profile.accelerator,
      ramGb: profile.ramGb,
      budgetGb: profile.budgetGb,
      budgetSource: profile.budgetSource,
      engineInput: input,
    },
    reportUrl: reportUrl(input.ramGb),
    source: SOURCE,
    note: 'tokens/sec are estimates, not measured benchmarks. estimatedErrorPct is their typical error in percent (null when unavailable).',
  };
}

function header(c, profile, input, opts) {
  const overridden = opts.ram != null || opts.chip != null || opts.device != null;
  const line = overridden
    ? `${clean(input.deviceType)} · ${clean(input.chip)} · ${input.ramGb} GB ${c.dim('(override)')}`
    : clean(profile.detail);
  return [
    `${c.bold(c.cyan('ModelFit'))} ${c.dim('— the best local LLM for your machine')}   ${c.dim('modelfit.io')}`,
    `${c.gray(overridden ? 'Target  ' : 'Detected')}  ${c.bold(line)}`,
    '',
  ];
}

/** Default view: THE one model, prominent, with a couple of lighter alternatives. */
export function toBest(profile, input, recs, opts) {
  const c = paint(opts);
  const best = selectBest(recs);
  const L = header(c, profile, input, opts);

  if (!best) {
    L.push(c.yellow('No local model fits this machine.'));
    if (profile.accelerator?.kind === 'gpu') L.push(`${c.dim('Rent a cloud GPU →')} ${gpuUrl(profile.accelerator.slug)}`);
    L.push(`${c.dim('Browse →')} ${reportUrl(input.ramGb)}`);
    return L.join('\n');
  }

  const tps = estLabel(best.estimatedTokensPerSec, best.estimatedErrorPct);
  const comfort = best.localVerdict === 'local_feasible'
    ? c.green('runs comfortably')
    : c.yellow('runs, but slower — more RAM unlocks bigger models');

  L.push(`  ${c.green('▶')} ${c.bold(clean(best.name))}   ${[tps, comfort].filter(Boolean).join(c.dim(' · '))}`);
  if (best.ollamaCommand) L.push(`    ${c.green('$')} ${clean(best.ollamaCommand)}`);
  L.push(`    ${c.dim('The most capable model your machine can run.')} ${c.dim('→')} ${c.dim(modelUrl(best.family))}`);
  L.push('');

  const alts = localRunnable(recs).filter((r) => !sameModel(r, best)).slice(0, 2);
  if (alts.length) {
    L.push(`${c.gray('Also fits')}  ${alts.map((r) => clean(r.name)).join(c.dim(' · '))}   ${c.dim('(modelfit --all for the full list)')}`);
  }
  L.push(c.dim('Estimates, not measured benchmarks · Data: ModelFit (CC BY 4.0)'));
  if (best.estimatedErrorPct != null) L.push(c.dim(ERROR_NOTE));
  return L.join('\n');
}

/** --all / --top: the ranked list (best-first). */
export function toList(profile, input, recs, opts) {
  const c = paint(opts);
  const best = selectBest(recs);
  const picks = localRunnable(recs);
  const shown = opts.all ? picks : picks.slice(0, opts.top ?? 3);
  const L = header(c, profile, input, opts);

  L.push(c.bold(opts.all ? 'Ranked local models' : `Top ${shown.length} local models`));
  shown.forEach((r) => {
    const star = sameModel(r, best) ? c.green('▶') : ' ';
    const tps = estLabel(r.estimatedTokensPerSec, r.estimatedErrorPct);
    const fitColor = r.fitLevel === 'Excellent' ? c.green : r.fitLevel === 'OK' ? c.yellow : c.red;
    const meta = [fitColor(`${r.fitLevel} fit`), c.dim(tps), c.dim(clean(r.bestFor))].filter(Boolean).join(c.dim(' · '));
    L.push(` ${star} ${c.bold(clean(r.name))}   ${meta}`);
    if (r.ollamaCommand) L.push(`    ${c.green('$')} ${clean(r.ollamaCommand)}`);
    L.push(`    ${c.dim('→')} ${c.dim(modelUrl(r.family))}`);
  });
  L.push('');
  L.push(`${c.gray('Full report')}  ${reportUrl(input.ramGb)}`);
  L.push(c.dim('Estimates, not measured benchmarks · Data: ModelFit (CC BY 4.0)'));
  if (shown.some((r) => r.estimatedErrorPct != null)) L.push(c.dim(ERROR_NOTE));
  return L.join('\n');
}
