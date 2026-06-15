// Terminal + JSON output. Human mode is ANSI-coloured (honours NO_COLOR / --no-color /
// non-TTY); --json mirrors the MCP recommend_local_models payload so agents get parity.

import { modelUrl, reportUrl, gpuUrl, SOURCE } from './links.mjs';

const useColor = (opts) =>
  !opts.noColor && !process.env.NO_COLOR && process.stdout.isTTY;

function paint(opts) {
  const on = useColor(opts);
  const w = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    bold: w('1'), dim: w('2'), cyan: w('36'), green: w('32'),
    yellow: w('33'), red: w('31'), gray: w('90'),
  };
}

const FIT_ORDER = { Excellent: 0, OK: 1, Heavy: 2 };

/** Pick the best locally-runnable models (drops cloud_only + local_unlikely), top N. */
export function pickLocal(recs, top) {
  const runnable = recs.filter((r) => r.localVerdict !== 'cloud_only' && r.localVerdict !== 'local_unlikely');
  const list = runnable.length ? runnable : recs.filter((r) => r.localVerdict !== 'cloud_only');
  return list.slice(0, top);
}

/** MCP-parity recommendation record (matches /api/mcp recommend_local_models). */
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

export function toJson(profile, input, recs, top) {
  return {
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
    recommendations: pickLocal(recs, top).map(recRecord),
    reportUrl: reportUrl(input.ramGb),
    source: SOURCE,
    note: 'tokens/sec are estimates, not measured benchmarks.',
  };
}

export function toHuman(profile, input, recs, opts) {
  const c = paint(opts);
  const top = opts.top ?? 3;
  const picks = pickLocal(recs, opts.all ? recs.length : top);
  const L = [];

  const overridden = opts.ram != null || opts.chip != null || opts.device != null;
  const detected = overridden
    ? `${input.deviceType} · ${input.chip} · ${input.ramGb} GB ${c.dim('(override)')}`
    : profile.detail;
  const label0 = overridden ? 'Target  ' : 'Detected';

  L.push(`${c.bold(c.cyan('ModelFit'))} ${c.dim('— best local LLMs for your machine')}   ${c.dim('modelfit.io')}`);
  L.push(`${c.gray(label0)}  ${c.bold(detected)}`);
  L.push('');

  if (!picks.length) {
    L.push(c.yellow('No local model fits this memory budget.'));
    if (profile.accelerator?.kind === 'gpu') {
      L.push(`${c.dim('Try a bigger card or rent a cloud GPU →')} ${gpuUrl(profile.accelerator.slug)}`);
    }
    L.push(`${c.dim('Browse options →')} ${reportUrl(input.ramGb)}`);
    return L.join('\n');
  }

  const label = opts.all ? 'Ranked local models' : `Top ${picks.length} you can run locally`;
  L.push(c.bold(label));
  picks.forEach((r, i) => {
    const tps = r.estimatedTokensPerSec != null ? `~${r.estimatedTokensPerSec} tok/s` : '';
    const fitColor = r.fitLevel === 'Excellent' ? c.green : r.fitLevel === 'OK' ? c.yellow : c.red;
    const meta = [fitColor(`${r.fitLevel} fit`), c.dim(tps), c.dim(r.bestFor)].filter(Boolean).join(c.dim(' · '));
    L.push(` ${c.bold(c.cyan(String(i + 1)))}  ${c.bold(r.name)}   ${meta}`);
    if (r.ollamaCommand) L.push(`    ${c.green('$')} ${r.ollamaCommand}`);
    L.push(`    ${c.dim('→')} ${c.dim(modelUrl(r.family))}`);
  });

  L.push('');
  L.push(`${c.gray('Full report')}  ${reportUrl(input.ramGb)}`);
  L.push(c.dim('Estimates, not measured benchmarks · Data: ModelFit (CC BY 4.0)'));
  L.push(c.dim('Weekly local-AI cheat sheet → https://modelfit.io/blog'));
  return L.join('\n');
}
