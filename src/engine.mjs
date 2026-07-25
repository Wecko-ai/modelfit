// Faithful JavaScript port of lib/recommend.ts (getRecommendations).
// Source of truth is the TS file in the parent repo; test/parity.mjs asserts this
// port produces identical rankings. Keep them in sync — if you edit one, edit both
// and re-run `node test/parity.mjs`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

const CHIP_SPEED_BOOST = {
  'Apple M5 Max': 13, 'Apple M5 Pro': 10, 'Apple M5': 8,
  'Apple M4 Max': 12, 'Apple M4 Pro': 9, 'Apple M4': 7,
  // No M4 Ultra exists: the 2025 Mac Studio tops out at M3 Ultra (819 GB/s).
  'Apple M3 Ultra': 11, 'Apple M3 Max': 9, 'Apple M3 Pro': 7, 'Apple M3': 4,
  'Apple M2 Ultra': 9, 'Apple M2 Max': 7, 'Apple M2 Pro': 5, 'Apple M2': 3,
  'Apple M1 Ultra': 6, 'Apple M1 Max': 5, 'Apple M1 Pro': 4, 'Apple M1': 2,
  'Apple A19 Pro': 6, 'Apple A18 Pro': 5, 'Apple A19': 4, 'Apple A18': 3,
  'Apple A17 Pro': 2, 'Apple A16': 0,
};
const chipSpeedBoost = (chip) => CHIP_SPEED_BOOST[chip] ?? 0;

// Published unified-memory bandwidth (GB/s). Apple states the M-series figures;
// A-series are the widely reported LPDDR5/5X numbers. Used only for the roofline
// ceiling below, never displayed, and a ceiling can only lower an estimate.
// Max tiers are the top bin; lower-binned 14-inch SKUs run roughly 25% under.
const CHIP_BANDWIDTH_GBS = {
  'Apple M5 Max': 614, 'Apple M5 Pro': 307, 'Apple M5': 153,
  'Apple M4 Max': 546, 'Apple M4 Pro': 273, 'Apple M4': 120,
  // No M4 Ultra exists: the 2025 Mac Studio tops out at M3 Ultra (819 GB/s).
  'Apple M3 Ultra': 819, 'Apple M3 Max': 400, 'Apple M3 Pro': 150, 'Apple M3': 100,
  'Apple M2 Ultra': 800, 'Apple M2 Max': 400, 'Apple M2 Pro': 200, 'Apple M2': 100,
  'Apple M1 Ultra': 800, 'Apple M1 Max': 400, 'Apple M1 Pro': 200, 'Apple M1': 68.25,
  'Apple A19 Pro': 68, 'Apple A19': 68, 'Apple A18 Pro': 60, 'Apple A18': 60,
  'Apple A17 Pro': 51.2, 'Apple A16': 51.2,
};
const chipBandwidthGbs = (chip) => CHIP_BANDWIDTH_GBS[chip] ?? null;

// Throughput for the reference workload: 7B at Q4 (~4.1 GB of weights) on a well-cooled
// machine with ample headroom. NOT hand-tuned. Values marked measured come from the
// canonical llama.cpp Apple Silicon table (LLaMA 7B Q4_0, Metal, ngl=99):
// https://github.com/ggml-org/llama.cpp/discussions/4167
// The rest are bandwidth-derived: GB/s / reference weight size x the measured bandwidth
// efficiency of that tier (base ~0.80, Pro ~0.71, Max ~0.60, Ultra ~0.42).
const CHIP_BASE_TPS = {
  'Apple M5 Max': 97, 'Apple M5 Pro': 57, 'Apple M5': 32,          // derived
  'Apple M4 Max': 83, 'Apple M4 Pro': 51, 'Apple M4': 24,          // measured
  'Apple M3 Ultra': 90,                                             // derived
  'Apple M3 Max': 66, 'Apple M3 Pro': 28, 'Apple M3': 21,          // M3 Pro derived
  'Apple M2 Ultra': 94, 'Apple M2 Max': 66, 'Apple M2 Pro': 39, 'Apple M2': 22,
  'Apple M1 Ultra': 84, 'Apple M1 Max': 61, 'Apple M1 Pro': 36, 'Apple M1': 14,
  // A-series: no comparable public measurement set, bandwidth-derived at a
  // conservative on-device efficiency, then cut further by the iPhone thermal factor.
  'Apple A19 Pro': 12, 'Apple A19': 11, 'Apple A18 Pro': 10, 'Apple A18': 9,
  'Apple A17 Pro': 8, 'Apple A16': 6,
};
// Unknown/non-enum chip: no basis for a throughput estimate, so null, not a made-up number (gate #7).
const chipBaseTokensPerSec = (chip) => CHIP_BASE_TPS[chip] ?? null;

const getFitLevel = (fitPct) => (fitPct >= 60 ? 'Excellent' : fitPct >= 25 ? 'OK' : 'Heavy');

function segmentBoost(useCase, tags) {
  if (useCase === 'Mixed') return 3;
  return tags.includes(useCase.toLowerCase()) ? 6 : -2;
}

function quantizationPenalty(q) {
  if (q.startsWith('Q5')) return 3;
  if (q.startsWith('Q6') || q.startsWith('Q8')) return 5;
  return 0;
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

function estimateLocalPerformance(model, input, ramBudget) {
  if (model.cloud_only) return { estimatedTokensPerSec: null, estimatedFirstTokenSec: null };

  const chipBase = chipBaseTokensPerSec(input.chip);
  if (chipBase === null) return { estimatedTokensPerSec: null, estimatedFirstTokenSec: null };

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
  const bandwidthGbs = chipBandwidthGbs(input.chip);
  const roofline = bandwidthGbs === null ? Infinity : bandwidthGbs / weightsGb;

  const estimatedTokensPerSec = clamp(0.4, 180, Math.min(base * sizeFactor * ramPressure, roofline));
  const estimatedFirstTokenSec = clamp(
    0.5, 30,
    0.45 + 10 / estimatedTokensPerSec + (model.sizeB >= 30 ? 0.8 : 0) +
      (model.estimatedLoadGb > ramBudget ? 2.4 : 0)
  );

  return {
    estimatedTokensPerSec: Number(estimatedTokensPerSec.toFixed(1)),
    estimatedFirstTokenSec: Number(estimatedFirstTokenSec.toFixed(1)),
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

  return [...DATASET]
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
                : utilizationRatio <= 1.0 ? 72
                  : 10;

      const fitPct = clamp(0, 100, ((ramBudget - model.estimatedLoadGb) / ramBudget) * 100);
      const fitLevel = getFitLevel(fitPct);
      const { estimatedTokensPerSec, estimatedFirstTokenSec } = estimateLocalPerformance(model, input, ramBudget);
      const localVerdict = getLocalVerdict(model, ramBudget, estimatedTokensPerSec);

      const oomPenalty = !model.cloud_only && model.estimatedLoadGb > ramBudget ? 40 : 0;
      const verdictPenalty =
        localVerdict === 'local_feasible' ? 0
          : localVerdict === 'local_slow' ? 12
            : localVerdict === 'local_unlikely' ? 30
              : 35;

      const adjustedSpeed = model.cloud_only
        ? clamp(0, 100, model.speedScore)
        : clamp(0, 100, model.speedScore + chipBoost);

      const baseRank =
        0.35 * sweetSpotScore + qualW * model.qualityScore +
        speedW * adjustedSpeed + 0.2 * model.popularityScore;

      const boost = segmentBoost(input.useCase, model.tags);
      const thermal = thermalPenalty(input.deviceType, model.sizeB, ramBudget);
      const quant = quantizationPenalty(model.quantization);

      const finalScore = clamp(0, 100, baseRank + boost - thermal - quant - oomPenalty - verdictPenalty);

      return {
        ...model,
        fitLevel,
        fitPct: Math.round(fitPct),
        localVerdict,
        estimatedTokensPerSec,
        estimatedFirstTokenSec,
        score: Number(finalScore.toFixed(2)),
        why: buildWhy(model, fitLevel, input, localVerdict),
      };
    })
    .sort((a, b) => b.score - a.score);
}
