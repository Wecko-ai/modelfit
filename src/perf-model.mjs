// Faithful JavaScript port of lib/perf-model.ts: the speed model fitted on measured runs.
// Constants come from data/perf-fit.json and model inputs from data/model-perf.json (both
// synced from the web repo's data/derived/ by scripts/sync-data.mjs, never hand-edited).
//
//   decode ms per token = [ (S x moe + alpha x KV(ctx)) / (eta x BW) x 1000 + c + extra cards x cmg ] x ollama
//   prefill ms per token = (2 x active params + beta x attention FLOPs) / (etaC x F) x 1000 + cpp

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIT = JSON.parse(readFileSync(join(__dirname, 'data', 'perf-fit.json'), 'utf8'));
const PERF = JSON.parse(readFileSync(join(__dirname, 'data', 'model-perf.json'), 'utf8'));
const MODELS = PERF.models;

/** Verified physical inputs of a catalog model, or null when it has none (cloud entries). */
export function modelPerfInputs(id) {
  return Object.prototype.hasOwnProperty.call(MODELS, id) ? MODELS[id] : null;
}

const dev = (family, key) => FIT.decode.dev[key] ?? FIT.decode.dev[`${family}|${key}`] ?? {};

/** KV-cache bytes a decode step reads at ctx tokens of context (GB). */
export function kvGbAt(m, ctx) {
  const swaCtx = m.kv.window ? Math.min(ctx, m.kv.window) : ctx;
  return (m.kv.fullBytesPerToken * ctx + m.kv.swaBytesPerToken * swaCtx) / 1e9;
}

/** Estimated decode tokens per second at ctx tokens of context, through Ollama. */
export function decodeTokensPerSec(m, hw, ctx) {
  const d = FIT.decode;
  const eta0 = d.eta[hw.family];
  const c0 = d.c[hw.family];
  if (eta0 == null || c0 == null || hw.pools.length === 0) return null;
  let etaMul = 1;
  let cMul = 1;
  for (const k of hw.keys) {
    const x = dev(hw.family, k);
    etaMul *= x.eta ?? 1;
    cMul *= x.c ?? 1;
  }
  const eta = eta0 * etaMul;
  const bytes = m.streamedGb * (m.moe ? d.moe : 1) + d.alpha * kvGbAt(m, ctx);
  let streamMs = 0;
  for (const p of hw.pools) streamMs += ((bytes * p.share) / (eta * p.bandwidthGbs)) * 1000;
  const ms = (streamMs + c0 * cMul + (hw.pools.length - 1) * d.cmg) * d.ollama;
  return ms > 0 ? 1000 / ms : null;
}

const quantKey = (q) => {
  const s = q.toUpperCase();
  if (s.startsWith('Q8')) return 'Q8';
  if (s.startsWith('F16') || s.startsWith('BF16') || s.includes('FP16')) return 'F16';
  if (s.startsWith('MXFP4')) return 'MXFP4';
  if (s.startsWith('Q4') || s.startsWith('IQ4')) return 'Q4';
  return 'other';
};

/** Estimated prompt reading (prefill) tokens per second for a prompt of promptTokens tokens. */
export function prefillTokensPerSec(m, quantization, hw, promptTokens) {
  const p = FIT.prefill;
  const etac = p.etac[`${hw.family}|${quantKey(quantization)}`] ?? p.etac[`${hw.family}|Q4`];
  const cpp = p.cpp[hw.family];
  let F = hw.fp16Tflops;
  if (F == null && hw.appleGen && hw.gpuCores && p.core[hw.appleGen] != null) F = hw.gpuCores * p.core[hw.appleGen];
  if (etac == null || cpp == null || !F) return null;
  const flops = 2 * m.activeB * 1e9 + p.beta * m.attnFlopsPerCtx * (promptTokens / 2);
  const ms = (flops * 1000) / (etac * F * 1e12) + cpp;
  return ms > 0 ? 1000 / ms : null;
}

/** Seconds to read a prompt before the first output token (prefill only, model already loaded). */
export function timeToFirstTokenSec(m, quantization, hw, promptTokens) {
  const tps = prefillTokensPerSec(m, quantization, hw, promptTokens);
  return tps ? promptTokens / tps : null;
}

/** Size bucket the error bands are keyed by (same buckets as the scorer). */
export function sizeBucket(m) {
  if (m.moe) return 'MoE';
  const b = m.paramsB;
  if (b < 2) return '<2B';
  if (b < 5) return '2-5B';
  if (b < 10) return '5-10B';
  if (b < 20) return '10-20B';
  if (b < 40) return '20-40B';
  return '40B+';
}

const BAND_GROUP = { metal: 'Metal', cuda: 'CUDA', rocm: 'ROCm/Vulkan' };

/** Typical error of a decode estimate in percent (held-out median APE, rounded to 5). */
export function typicalErrorPct(m, family) {
  const g = BAND_GROUP[family];
  const v = FIT.bands[`${g}|${sizeBucket(m)}`] ?? FIT.bands[g] ?? FIT.bands.all;
  return Math.round((v ?? 0) * 100 / 5) * 5 || 5;
}

/** Apple tier: base, Pro, Max, Ultra, or the iPhone A-series. */
export function appleTier(chip) {
  if (/^Apple A/.test(chip)) return 'apple-a';
  if (/Ultra$/.test(chip)) return 'apple-ultra';
  if (/Max$/.test(chip)) return 'apple-max';
  if (/Pro$/.test(chip)) return 'apple-pro';
  return 'apple-base';
}

/** Apple chip generation (M1 to M6, A16 to A19). */
export function appleGeneration(chip) {
  return chip.match(/^Apple ([MA]\d+)/)?.[1] ?? null;
}
