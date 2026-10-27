// Faithful JavaScript port of lib/recommend.ts (getRecommendations).
// Source of truth is the TS file in the parent repo; test/parity.mjs asserts this
// port produces identical rankings. Keep them in sync: if you edit one, edit both
// and re-run `node test/parity.mjs`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  appleGeneration,
  appleTier,
  decodeTokensPerSec,
  modelPerfInputs,
  timeToFirstTokenSec,
  typicalErrorPct,
} from './perf-model.mjs';
import { baseModelId } from './model-groups.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The bundled snapshot of data/models.json (synced via scripts/sync-data.mjs). */
export const DATASET = JSON.parse(
  readFileSync(join(__dirname, 'data', 'models.json'), 'utf8')
);

// Usable share of unified memory for model weights. macOS caps GPU-wired memory
// well below total RAM on small machines, but the cap scales up with RAM, and
// high-RAM users routinely raise it further via iogpu.wired_limit_mb (community
// reports ~118 GB usable of 128 GB). Linear ramp: 0.70 at <=32 GB up to 0.85 at
// >=128 GB. 1:1 port of lib/recommend.ts ramBudgetRatio.
export function ramBudgetRatio(ramGb) {
  return 0.70 + Math.min(0.15, Math.max(0, (ramGb - 32) * (0.15 / 96)));
}

const clamp = (min, max, value) => Math.min(max, Math.max(min, value));

// Own keys only: a chip string such as 'constructor' or '__proto__' (a --chip flag, a bench
// submission) must never resolve to an Object.prototype member of the tables below.
const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

const CHIP_SPEED_BOOST = {
  'Apple M5 Ultra': 15,
  'Apple M6': 9,
  'Apple M5 Max': 13, 'Apple M5 Pro': 10, 'Apple M5': 8,
  'Apple M4 Max': 12, 'Apple M4 Pro': 9, 'Apple M4': 7,
  // No M4 Ultra exists: the 2025 Mac Studio tops out at M3 Ultra (819 GB/s).
  'Apple M3 Ultra': 11, 'Apple M3 Max': 9, 'Apple M3 Pro': 7, 'Apple M3': 4,
  'Apple M2 Ultra': 9, 'Apple M2 Max': 7, 'Apple M2 Pro': 5, 'Apple M2': 3,
  'Apple M1 Ultra': 6, 'Apple M1 Max': 5, 'Apple M1 Pro': 4, 'Apple M1': 2,
  'Apple A19 Pro': 6, 'Apple A18 Pro': 5, 'Apple A19': 4, 'Apple A18': 3,
  'Apple A17 Pro': 2, 'Apple A16': 0,
};
const chipSpeedBoost = (chip) => own(CHIP_SPEED_BOOST, chip) ?? 0;

// Top-bin unified-memory bandwidth (GB/s). Apple states the M-series figures;
// A-series are the widely reported LPDDR5/5X numbers. Used only for the roofline
// ceiling below, and a ceiling can only lower an estimate. Lower bins and RAM-tied
// configs live in DECODE_VARIANTS.
const CHIP_BANDWIDTH_GBS = {
  'Apple M5 Ultra': 1228.8, // 1.2 TB/s, apple.com/mac-studio/specs (2026-08-26)
  'Apple M6': 153,          // 16GB config; 24/32GB run 170 GB/s, see DECODE_VARIANTS
  'Apple M5 Max': 614, 'Apple M5 Pro': 307, 'Apple M5': 153,
  'Apple M4 Max': 546, 'Apple M4 Pro': 273, 'Apple M4': 120,
  // No M4 Ultra exists: the 2025 Mac Studio tops out at M3 Ultra (819 GB/s).
  'Apple M3 Ultra': 819, 'Apple M3 Max': 400, 'Apple M3 Pro': 150, 'Apple M3': 100,
  'Apple M2 Ultra': 800, 'Apple M2 Max': 400, 'Apple M2 Pro': 200, 'Apple M2': 100,
  'Apple M1 Ultra': 800, 'Apple M1 Max': 400, 'Apple M1 Pro': 200, 'Apple M1': 68.25,
  'Apple A19 Pro': 68, 'Apple A19': 68, 'Apple A18 Pro': 60, 'Apple A18': 60,
  'Apple A17 Pro': 51.2, 'Apple A16': 51.2,
};

// Throughput for the reference workload: 7B at Q4 (~4.1 GB of weights) on a well-cooled
// machine with ample headroom. NOT hand-tuned. Values marked measured come from the
// canonical llama.cpp Apple Silicon table (LLaMA 7B Q4_0, Metal, ngl=99):
// https://github.com/ggml-org/llama.cpp/discussions/4167
// The rest are bandwidth-derived: GB/s / reference weight size x the measured bandwidth
// efficiency of that tier (base ~0.80, Pro ~0.71, Max ~0.60, Ultra ~0.42).
const CHIP_BASE_TPS = {
  'Apple M5 Ultra': 135,                                      // derived: 1228.8 x 0.45
  'Apple M6': 32,                                             // derived: 153 x 0.80 (same bw as M5 at 16GB)
  'Apple M5 Max': 97, 'Apple M5 Pro': 57, 'Apple M5': 32,          // derived
  'Apple M4 Max': 83, 'Apple M4 Pro': 51, 'Apple M4': 24,          // measured
  'Apple M3 Ultra': 90,                                             // derived; llama.cpp now lists 92.14, not adopted
  'Apple M3 Max': 66, 'Apple M3 Pro': 28, 'Apple M3': 21,          // M3 Pro derived; llama.cpp now lists 30.7, not adopted
  'Apple M2 Ultra': 94, 'Apple M2 Max': 66, 'Apple M2 Pro': 39, 'Apple M2': 22,
  'Apple M1 Ultra': 84, 'Apple M1 Max': 61, 'Apple M1 Pro': 36, 'Apple M1': 14,
  // A-series: no comparable public measurement set, bandwidth-derived at a
  // conservative on-device efficiency, then cut further by the iPhone thermal factor.
  'Apple A19 Pro': 12, 'Apple A19': 11, 'Apple A18 Pro': 10, 'Apple A18': 9,
  'Apple A17 Pro': 8, 'Apple A16': 6,
};

// A chip bin or memory config whose decode inputs differ from the top-bin tables above.
// Apple ties some bins to RAM: a 36GB M5 Max is always the 32-core GPU at 460 GB/s.
// forcedRams: RAM sizes sold ONLY with this variant (RAM alone resolves it).
// rams: sizes where the bin is one option among others (only an explicit gpuCores picks it).
// Sources: Apple spec pages read raw 2026-10-16; base tok/s from the llama.cpp table
// above (LLaMA 7B Q4_0 TG128 per GPU-core count). Pro bins share one bandwidth and
// measure within 3% of each other, so they have no variant. 1:1 port of lib/recommend.ts.
const DECODE_VARIANTS = {
  // apple.com/mac-mini/specs. Base kept at the 153 GB/s value (gate 7).
  'Apple M6': [{ forcedRams: [24, 32], bandwidthGbs: 170, baseTps: 32 }],
  // apple.com/macbook-pro/specs, /mac-studio/specs. Derived 97 x 0.842 (M4 Max 69.95/83.06).
  'Apple M5 Max': [{ gpuCores: 32, forcedRams: [36], bandwidthGbs: 460, baseTps: 82 }],
  // apple.com/mac-studio/specs. Derived 135 x 0.959 (M3 Ultra 88.40/92.14).
  'Apple M5 Ultra': [{ gpuCores: 64, rams: [96, 256], bandwidthGbs: 1228.8, baseTps: 130 }],
  // support.apple.com/en-us/121553, /122211. Measured 69.95.
  'Apple M4 Max': [{ gpuCores: 32, forcedRams: [36], bandwidthGbs: 410, baseTps: 70 }],
  // support.apple.com/en-us/122211. Measured 88.40.
  'Apple M3 Ultra': [{ gpuCores: 60, rams: [96, 256], bandwidthGbs: 819, baseTps: 88 }],
  // support.apple.com/en-us/117736. Measured 56.58.
  'Apple M3 Max': [{ gpuCores: 30, forcedRams: [36, 96], bandwidthGbs: 300, baseTps: 57 }],
  // support.apple.com/en-us/111835. Measured 88.64.
  'Apple M2 Ultra': [{ gpuCores: 60, rams: [64, 128, 192], bandwidthGbs: 800, baseTps: 89 }],
  // support.apple.com/en-us/111340, /111838, /111835. Measured 60.99.
  'Apple M2 Max': [{ gpuCores: 30, rams: [32, 64], bandwidthGbs: 400, baseTps: 61 }],
  // support.apple.com/en-us/111900. Measured 74.93.
  'Apple M1 Ultra': [{ gpuCores: 48, rams: [64, 128], bandwidthGbs: 800, baseTps: 75 }],
  // support.apple.com/en-us/111902, /111901, /111900. Measured 54.61.
  'Apple M1 Max': [{ gpuCores: 24, rams: [32, 64], bandwidthGbs: 400, baseTps: 55 }],
};

// RAM a variant is sold exclusively with wins (even over a contradicting gpuCores); then an
// explicit gpuCores the RAM allows; else null = the top bin.
export function decodeVariant(chip, ramGb, gpuCores) {
  const variants = own(DECODE_VARIANTS, chip);
  if (!variants) return null;
  if (ramGb !== undefined) {
    const forced = variants.find((v) => v.forcedRams?.includes(ramGb));
    if (forced) return forced;
  }
  if (gpuCores !== undefined) {
    const picked = variants.find(
      (v) => v.gpuCores === gpuCores && (ramGb === undefined || (v.rams ?? v.forcedRams ?? []).includes(ramGb))
    );
    if (picked) return picked;
  }
  return null;
}

export function chipBandwidthGbs(chip, ramGb, gpuCores) {
  const variant = decodeVariant(chip, ramGb, gpuCores);
  return variant ? variant.bandwidthGbs : own(CHIP_BANDWIDTH_GBS, chip) ?? null;
}

// Unknown/non-enum chip: no basis for a throughput estimate, so null, not a made-up number (gate #7).
// Gate 7 in code: a variant can only lower the base, never raise it.
function chipBaseTokensPerSec(chip, ramGb, gpuCores) {
  const top = own(CHIP_BASE_TPS, chip) ?? null;
  if (top === null) return null;
  const variant = decodeVariant(chip, ramGb, gpuCores);
  return variant ? Math.min(variant.baseTps, top) : top;
}

const getFitLevel = (fitPct) => (fitPct >= 60 ? 'Excellent' : fitPct >= 25 ? 'OK' : 'Heavy');

function segmentBoost(useCase, tags) {
  // Mixed: a specialist without the chat or mixed tag gets no boost (lib/recommend.ts).
  if (useCase === 'Mixed') return tags.includes('chat') || tags.includes('mixed') ? 3 : 0;
  return tags.includes(useCase.toLowerCase()) ? 6 : -2;
}

function quantizationPenalty(q) {
  if (q.startsWith('Q5')) return 3;
  if (q.startsWith('Q6') || q.startsWith('Q8')) return 5;
  // IQ4_XS (about 4.25 bits a weight) is there for the RAM tier below Q4_K_M: where both fit, the
  // K-quant ranks first. Below 4 bits the quality loss is the cost: a 3-bit build ranks under its
  // 4-bit sibling.
  if (q.startsWith('IQ4')) return 1;
  if (/^I?Q3/.test(q)) return 6;
  if (/^I?Q[12]/.test(q)) return 12;
  return 0;
}

// Recency: no penalty up to RECENCY_GRACE_MONTHS behind the newest model in the catalog, then
// RECENCY_PER_MONTH points a month, capped at RECENCY_MAX. The reference is the newest
// releaseDate in the dataset, never the clock, so a ranking only moves when the catalog does.
const RECENCY_GRACE_MONTHS = 6;
const RECENCY_PER_MONTH = 1;
const RECENCY_MAX = 10;
const MONTH_MS = 30.44 * 24 * 3600 * 1000;
const RECENCY_REFERENCE_MS = Math.max(0, ...DATASET.map((m) => (m.releaseDate ? Date.parse(m.releaseDate) : 0)));

export function recencyPenalty(releaseDate) {
  if (!releaseDate) return 0;
  const months = (RECENCY_REFERENCE_MS - Date.parse(releaseDate)) / MONTH_MS;
  return clamp(0, RECENCY_MAX, (months - RECENCY_GRACE_MONTHS) * RECENCY_PER_MONTH);
}

// Speed score (0-100) from the engine's own decode estimate: piecewise linear in log2(tok/s)
// through 1 tok/s 0, 5 tok/s 20, 10 tok/s 45, 20 tok/s 70, 40 tok/s 90, 80+ tok/s 100.
// 1:1 with lib/recency.ts engineSpeedScore.
const SPEED_ANCHORS = [[1, 0], [5, 20], [10, 45], [20, 70], [40, 90], [80, 100]];
export function engineSpeedScore(tokensPerSec) {
  if (!(tokensPerSec > SPEED_ANCHORS[0][0])) return 0;
  for (let i = 1; i < SPEED_ANCHORS.length; i++) {
    const [t1, s1] = SPEED_ANCHORS[i];
    if (tokensPerSec <= t1) {
      const [t0, s0] = SPEED_ANCHORS[i - 1];
      return s0 + ((s1 - s0) * Math.log2(tokensPerSec / t0)) / Math.log2(t1 / t0);
    }
  }
  return 100;
}

// Lineage: a row whose successor (any quant of that base model) runs comfortably on the same
// machine drops by LINEAGE_PENALTY, or more when needed to rank under the best comfortable build of
// that successor. Successors resolve first, so a chain stays in order. 1:1 with lib/recency.ts.
export const LINEAGE_PENALTY = 8;
function lineageScores(rows) {
  const feasibleByBase = new Map();
  for (const r of rows) {
    if (r.localVerdict !== 'local_feasible') continue;
    const k = baseModelId(r);
    const list = feasibleByBase.get(k);
    if (list) list.push(r);
    else feasibleByBase.set(k, [r]);
  }
  const memo = new Map();
  // A successor cycle (audit:catalog rejects one) must not recurse forever: a row still being
  // resolved does not count as a successor (1:1 with lib/recency.ts).
  const resolving = new Set();
  const final = (r) => {
    const hit = memo.get(r.id);
    if (hit !== undefined) return hit;
    resolving.add(r.id);
    let s = r.score;
    const succ = r.successor ? feasibleByBase.get(r.successor)?.filter((x) => !resolving.has(x.id)) : undefined;
    if (succ && succ.length) {
      const best = Math.max(...succ.map(final));
      s = r.score - Math.max(LINEAGE_PENALTY, r.score - best + 0.1);
    }
    resolving.delete(r.id);
    memo.set(r.id, s);
    return s;
  };
  for (const r of rows) final(r);
  return memo;
}

// Weight size in GB per billion params, by quantization. Decode is memory-bound, so
// this is what sets throughput: Q8 reads roughly twice the bytes per token of Q4 and
// runs at roughly half the speed. Folding quant into bytes replaces the old standalone
// speed multiplier, which double-counted.
function quantBytesPerParamGb(q) {
  const n = q.toUpperCase();
  if (n.startsWith('Q4')) return 0.58;
  if (n.startsWith('Q5')) return 0.7;
  if (n.startsWith('Q6')) return 0.82;
  if (n.startsWith('Q8')) return 1.06;
  if (n.includes('FP16') || n.includes('F16')) return 2;
  if (n.includes('MXFP4')) return 0.55;
  return 0.65;
}

// The reference workload CHIP_BASE_TPS is quoted against: 7B at Q4.
const REF_SIZE_B = 7;
const REF_WEIGHTS_GB = REF_SIZE_B * 0.58;

function deviceThroughputFactor(deviceType) {
  // The chip carries the bandwidth, which is what sets decode speed. This factor only
  // models sustained thermals, so the spread is small.
  if (deviceType === 'Mac Studio') return 1.05;
  if (deviceType === 'Mac Mini') return 1;
  if (deviceType === 'MacBook Pro') return 1;
  if (deviceType === 'MacBook Air') return 0.9;
  if (deviceType === 'iPhone 17 Pro Max') return 0.7;
  if (deviceType.startsWith('iPhone')) return 0.65;
  return 0.9;
}

// Context every published decode estimate is quoted at, and the first-token prompt length
// (lib/recommend.ts PUBLISHED_CONTEXT_TOKENS, FIRST_TOKEN_PROMPT_TOKENS).
export const PUBLISHED_CONTEXT_TOKENS = 4096;
export const FIRST_TOKEN_PROMPT_TOKENS = 1024;

// GPU core bins per chip (lib/chip-bins.ts CHIP_BINS plus lib/prefill.ts PP512_Q4_0) and the top
// measured bin (the last PP512_Q4_0 row), generated by scripts/sync-data.mjs.
const GPU_BINS = JSON.parse(readFileSync(join(__dirname, 'data', 'gpu-bins.json'), 'utf8')).chips;

/** Known GPU core counts of a chip, lowest first (1:1 port of chipGpuBins). */
export function chipGpuBins(chip) {
  return own(GPU_BINS, chip)?.bins ?? [];
}

// GPU cores the prompt-reading estimate runs on (1:1 port of prefillGpuCores): the bin
// decodeVariant resolves on a chip whose bins differ in decode, else its top bin; on the others a
// known bin of the chip, else its top bin. Never a raw --gpu-cores, never above the top bin.
export function prefillGpuCores(chip, ramGb, gpuCores) {
  const top = own(GPU_BINS, chip)?.top ?? null;
  if (own(DECODE_VARIANTS, chip)) return decodeVariant(chip, ramGb, gpuCores)?.gpuCores ?? top;
  if (gpuCores !== undefined && top !== null && gpuCores <= top && chipGpuBins(chip).includes(gpuCores)) return gpuCores;
  return top;
}

/** An Apple chip as the fitted speed model sees it (1:1 port of applePerfHardware). */
export function applePerfHardware(chip, ramGb, gpuCores) {
  const bw = chipBandwidthGbs(chip, ramGb, gpuCores);
  if (bw === null) return null;
  const gen = appleGeneration(chip);
  const cores = prefillGpuCores(chip, ramGb, gpuCores);
  return {
    family: 'metal',
    keys: [`tier:${appleTier(chip)}`, `gen:${gen}`],
    pools: [{ bandwidthGbs: bw, share: 1 }],
    fp16Tflops: null,
    appleGen: gen,
    gpuCores: cores,
  };
}

function estimateLocalPerformance(model, input, ramBudget) {
  if (model.cloud_only) return { estimatedTokensPerSec: null, estimatedFirstTokenSec: null, estimatedErrorPct: null };

  // Catalog models run through the fitted speed model (perf-model.mjs).
  const perf = model.id ? modelPerfInputs(model.id) : null;
  const hw = perf ? applePerfHardware(input.chip, input.ramGb, input.gpuCores) : null;
  if (perf && hw) {
    let tps = decodeTokensPerSec(perf, hw, PUBLISHED_CONTEXT_TOKENS);
    if (tps !== null) {
      // Over the wired-memory budget: the previous pressure penalty, unmeasured, kept as it was.
      if (model.estimatedLoadGb > ramBudget) tps *= clamp(0.35, 1, (ramBudget / model.estimatedLoadGb) * 0.9);
      // Gate 7: never above the bandwidth ceiling of the bytes this model streams per token.
      tps = Math.min(tps, hw.pools[0].bandwidthGbs / perf.streamedGb);
      const prompt = timeToFirstTokenSec(perf, model.quantization, hw, FIRST_TOKEN_PROMPT_TOKENS);
      const firstToken = prompt !== null
        ? prompt + 1 / tps
        : 0.45 + 10 / tps + (model.sizeB >= 30 ? 0.8 : 0) + (model.estimatedLoadGb > ramBudget ? 2.4 : 0);
      return {
        estimatedTokensPerSec: Number(tps.toFixed(1)),
        estimatedFirstTokenSec: Number(clamp(0.1, 600, firstToken).toFixed(1)),
        estimatedErrorPct: typicalErrorPct(perf, 'metal'),
      };
    }
  }

  // Anything else (a model with no verified inputs) keeps the previous formula.
  const chipBase = chipBaseTokensPerSec(input.chip, input.ramGb, input.gpuCores);
  if (chipBase === null) return { estimatedTokensPerSec: null, estimatedFirstTokenSec: null, estimatedErrorPct: null };

  const base = chipBase * deviceThroughputFactor(input.deviceType);
  // MoE decode speed tracks active params, blended with total: effective = sqrt(active * total).
  // Dense models (no moeActiveB) use total params.
  const effectiveSizeB = model.moeActiveB
    ? Math.sqrt(model.moeActiveB * Math.max(model.sizeB, 1))
    : model.sizeB;
  // Decode is memory-bound, so throughput scales with BYTES read per token, not with a
  // power of the parameter count. Quantization is part of that byte count.
  const weightsGb = Math.max(effectiveSizeB, 0.1) * quantBytesPerParamGb(model.quantization);
  const sizeFactor = REF_WEIGHTS_GB / weightsGb;
  // Extra headroom does not make hardware faster, so this only ever penalises.
  const ramPressure = clamp(0.35, 1, (ramBudget / Math.max(model.estimatedLoadGb, 1)) * 0.9);

  // Hard physical ceiling: a decoder cannot emit tokens faster than it streams the
  // weights it reads per token. Can only ever lower an estimate, never raise one.
  const bandwidthGbs = chipBandwidthGbs(input.chip, input.ramGb, input.gpuCores);
  const roofline = bandwidthGbs === null ? Infinity : bandwidthGbs / weightsGb;

  // Order matters: the roofline is applied LAST, so the lower bound can never lift an
  // estimate back above physics. A 405B at Q4 is ~235GB of weights, so an M1 at
  // 68 GB/s tops out near 0.29 tok/s; a 0.4 floor applied afterwards would have
  // published 137% of the ceiling. The floor only keeps the value positive.
  const estimatedTokensPerSec = Math.min(clamp(0.05, 180, base * sizeFactor * ramPressure), roofline);
  const estimatedFirstTokenSec = clamp(
    0.5, 30,
    0.45 + 10 / estimatedTokensPerSec + (model.sizeB >= 30 ? 0.8 : 0) +
      (model.estimatedLoadGb > ramBudget ? 2.4 : 0)
  );

  return {
    estimatedTokensPerSec: Number(estimatedTokensPerSec.toFixed(1)),
    estimatedFirstTokenSec: Number(estimatedFirstTokenSec.toFixed(1)),
    estimatedErrorPct: null,
  };
}

function getLocalVerdict(model, ramBudget, estimatedTokensPerSec) {
  if (model.cloud_only) return 'cloud_only';
  if (model.estimatedLoadGb > ramBudget * 1.25 || (estimatedTokensPerSec !== null && estimatedTokensPerSec < 1.5)) {
    return 'local_unlikely';
  }
  if (model.estimatedLoadGb > ramBudget || (estimatedTokensPerSec !== null && estimatedTokensPerSec < 6)) {
    return 'local_slow';
  }
  return 'local_feasible';
}

function thermalPenalty(deviceType, sizeB, ramBudget) {
  if (deviceType === 'MacBook Air' && sizeB >= 14) return 6;
  if (deviceType.startsWith('iPhone')) {
    const estimatedGb = sizeB * 0.8;
    const budget = ramBudget ?? 4;
    const pressure = estimatedGb / budget;
    if (pressure > 1.0) return 20;
    if (pressure > 0.7) return Math.round(4 + (pressure - 0.7) * 40);
    if (pressure > 0.4) return Math.round(1 + (pressure - 0.4) * 10);
    return 0;
  }
  return 0;
}

function buildWhy(model, fitLevel, input, localVerdict) {
  if (localVerdict === 'cloud_only') {
    return `Cloud/API only: this model is not runnable locally via Ollama on ${input.deviceType}.`;
  }
  const focus =
    input.priority === 'Speed' ? 'higher throughput'
      : input.priority === 'Quality' ? 'better output quality'
        : 'balanced speed and quality';
  if (localVerdict === 'local_unlikely') {
    return `Local run is likely impractical on ${input.ramGb} GB RAM (very low throughput expected).`;
  }
  if (localVerdict === 'local_slow' || fitLevel === 'Heavy') {
    return `This model may feel memory-heavy on ${input.ramGb} GB RAM, but it is still listed for ${focus}.`;
  }
  return `Best for ${model.bestFor.toLowerCase()}. Strong fit for ${input.ramGb} GB RAM with ${focus}.`;
}

/**
 * Rank every model for the given hardware. 1:1 with lib/recommend.ts getRecommendations().
 * @param {{deviceType:string, chip:string, ramGb:number, priority:string, useCase:string}} input
 * @returns {Array} ranked recommendations (highest score first)
 */
export function getRecommendations(input) {
  const ramBudget = input.ramGb * ramBudgetRatio(input.ramGb);

  let speedW, qualW;
  if (input.priority === 'Speed') { speedW = 0.3; qualW = 0.15; }
  else if (input.priority === 'Quality') { speedW = 0.1; qualW = 0.35; }
  else { speedW = 0.2; qualW = 0.25; }
  if (ramBudget > 10) qualW += 0.05;

  const chipBoost = chipSpeedBoost(input.chip);

  const scored = [...DATASET]
    .map((model) => {
      const utilizationRatio = model.cloud_only ? 0 : model.estimatedLoadGb / ramBudget;
      // Utilization is measured against the 70-85% RAM budget (ramBudgetRatio), so even 100% here still
      // leaves ~30% of physical memory for OS/context: high utilization is good use
      // of the machine, not risk.
      const sweetSpotScore = model.cloud_only ? 30
        : utilizationRatio < 0.15 ? 20
          : utilizationRatio < 0.3 ? 45
            : utilizationRatio < 0.5 ? 70
              : utilizationRatio <= 0.85 ? 92
                : utilizationRatio <= 1.0 ? 92 - ((utilizationRatio - 0.85) / 0.15) * 20
                  : 10;

      const fitPct = clamp(0, 100, ((ramBudget - model.estimatedLoadGb) / ramBudget) * 100);
      const fitLevel = getFitLevel(fitPct);
      const { estimatedTokensPerSec, estimatedFirstTokenSec, estimatedErrorPct } = estimateLocalPerformance(model, input, ramBudget);
      const localVerdict = getLocalVerdict(model, ramBudget, estimatedTokensPerSec);

      const oomPenalty = !model.cloud_only && model.estimatedLoadGb > ramBudget ? 40 : 0;
      const verdictPenalty =
        localVerdict === 'local_feasible' ? 0
          : localVerdict === 'local_slow' ? 12
            : localVerdict === 'local_unlikely' ? 30
              : 35;

      // Speed: the engine's own estimate (engineSpeedScore); the hand speedScore (+ chip boost)
      // only for cloud rows and rows with no estimate.
      const adjustedSpeed = model.cloud_only
        ? clamp(0, 100, model.speedScore)
        : estimatedTokensPerSec !== null
          ? engineSpeedScore(estimatedTokensPerSec)
          : clamp(0, 100, model.speedScore + chipBoost);

      const baseRank =
        0.35 * sweetSpotScore + qualW * model.qualityScore +
        speedW * adjustedSpeed + 0.2 * model.popularityScore;

      const boost = segmentBoost(input.useCase, model.tags);
      const thermal = thermalPenalty(input.deviceType, model.sizeB, ramBudget);
      const quant = quantizationPenalty(model.quantization);
      const recency = recencyPenalty(model.releaseDate);

      const finalScore = clamp(0, 100, baseRank + boost - thermal - quant - recency - oomPenalty - verdictPenalty);

      return {
        ...model,
        fitLevel,
        fitPct: Math.round(fitPct),
        localVerdict,
        estimatedTokensPerSec,
        estimatedFirstTokenSec,
        estimatedErrorPct,
        score: finalScore,
        why: buildWhy(model, fitLevel, input, localVerdict),
      };
    });

  const lineage = lineageScores(scored);
  return scored
    .map((r) => ({ ...r, score: Number(clamp(0, 100, lineage.get(r.id) ?? r.score).toFixed(2)) }))
    .sort((a, b) => b.score - a.score);
}
