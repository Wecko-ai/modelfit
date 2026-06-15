// Terminal + JSON output. Default = THE single best model for the machine, big and
// clear. --all/--top show the ranked list. --json emits the stable integration
// contract ({ best, alternatives, ... }) for apps that embed ModelFit.

import { modelUrl, reportUrl, gpuUrl, SOURCE } from './links.mjs';
import { selectBest, bestContract } from './best.mjs';

const useColor = (opts) => !opts.noColor && !process.env.NO_COLOR && process.stdout.isTTY;

function paint(opts) {
  const on = useColor(opts);
  const w = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    bold: w('1'), dim: w('2'), cyan: w('36'), green: w('32'),
    yellow: w('33'), red: w('31'), gray: w('90'),
  };
}

/** Locally-runnable models (drops cloud_only + local_unlikely), best-first. */
export function localRunnable(recs) {
  const runnable = recs.filter((r) => r.localVerdict !== 'cloud_only' && r.localVerdict !== 'local_unlikely');
  return runnable.length ? runnable : recs.filter((r) => r.localVerdict !== 'cloud_only');
}

function recRecord(r) {
  return {
    name: r.name,
    params: `${r.sizeB}B`,
    quantization: r.quantization,
    ollamaCommand: r.ollamaCommand ?? null,
    fit: r.fitLevel,
    localVerdict: r.localVerdict,
    estimatedTokensPerSec: r.estimatedTokensPerSec,
    bestFor: r.bestFor,
    why: r.why,
    learnMoreUrl: modelUrl(r.family),
  };
}

/** { best: <contract>, alternatives: [...], hardware, source, reportUrl }. */
export function toJson(profile, input, recs, opts) {
  const best = selectBest(recs);
  const list = localRunnable(recs);
  const altCount = opts.all ? list.length : (opts.top ?? 3);
  return {
    best: bestContract(best, input, profile),
    alternatives: list.filter((r) => r.id !== best?.id).slice(0, Math.max(0, altCount)).map(recRecord),
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
    note: 'tokens/sec are estimates, not measured benchmarks.',
  };
}

function header(c, profile, input, opts) {
  const overridden = opts.ram != null || opts.chip != null || opts.device != null;
  const line = overridden
    ? `${input.deviceType} · ${input.chip} · ${input.ramGb} GB ${c.dim('(override)')}`
    : profile.detail;
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

  const tps = best.estimatedTokensPerSec != null ? `~${best.estimatedTokensPerSec} tok/s` : '';
  const comfort = best.localVerdict === 'local_feasible'
    ? c.green('runs comfortably')
    : c.yellow('runs, but slower — more RAM unlocks bigger models');

  L.push(`  ${c.green('▶')} ${c.bold(best.name)}   ${[tps, comfort].filter(Boolean).join(c.dim(' · '))}`);
  if (best.ollamaCommand) L.push(`    ${c.green('$')} ${best.ollamaCommand}`);
  L.push(`    ${c.dim('The most capable model your machine can run.')} ${c.dim('→')} ${c.dim(modelUrl(best.family))}`);
  L.push('');

  const alts = localRunnable(recs).filter((r) => r.id !== best.id).slice(0, 2);
  if (alts.length) {
    L.push(`${c.gray('Also fits')}  ${alts.map((r) => r.name).join(c.dim(' · '))}   ${c.dim('(modelfit --all for the full list)')}`);
  }
  L.push(c.dim('Estimates, not measured benchmarks · Data: ModelFit (CC BY 4.0)'));
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
    const star = best && r.id === best.id ? c.green('▶') : ' ';
    const tps = r.estimatedTokensPerSec != null ? `~${r.estimatedTokensPerSec} tok/s` : '';
    const fitColor = r.fitLevel === 'Excellent' ? c.green : r.fitLevel === 'OK' ? c.yellow : c.red;
    const meta = [fitColor(`${r.fitLevel} fit`), c.dim(tps), c.dim(r.bestFor)].filter(Boolean).join(c.dim(' · '));
    L.push(` ${star} ${c.bold(r.name)}   ${meta}`);
    if (r.ollamaCommand) L.push(`    ${c.green('$')} ${r.ollamaCommand}`);
    L.push(`    ${c.dim('→')} ${c.dim(modelUrl(r.family))}`);
  });
  L.push('');
  L.push(`${c.gray('Full report')}  ${reportUrl(input.ramGb)}`);
  L.push(c.dim('Estimates, not measured benchmarks · Data: ModelFit (CC BY 4.0)'));
  return L.join('\n');
}
