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

const RAM_BUDGET_RATIO = 0.7;

const clamp = (min, max, value) => Math.min(max, Math.max(min, value));

const CHIP_SPEED_BOOST = {
  'Apple M4 Ultra': 15, 'Apple M4 Max': 12, 'Apple M4 Pro': 9, 'Apple M4': 7,
  'Apple M3 Max': 9, 'Apple M3 Pro': 7, 'Apple M3': 4,
  'Apple M2 Ultra': 9, 'Apple M2 Max': 7, 'Apple M2 Pro': 5, 'Apple M2': 3,
  'Apple M1 Ultra': 6, 'Apple M1 Max': 5, 'Apple M1 Pro': 4, 'Apple M1': 2,
  'Apple A19 Pro': 6, 'Apple A18 Pro': 5, 'Apple A19': 4, 'Apple A18': 3,
  'Apple A17 Pro': 2, 'Apple A16': 0,
};
const chipSpeedBoost = (chip) => CHIP_SPEED_BOOST[chip] ?? 0;

const CHIP_BASE_TPS = {
  'Apple M4 Ultra': 180, 'Apple M4 Max': 130, 'Apple M4 Pro': 95, 'Apple M4': 65,
  'Apple M3 Max': 95, 'Apple M3 Pro': 72, 'Apple M3': 52,
  'Apple M2 Ultra': 110, 'Apple M2 Max': 78, 'Apple M2 Pro': 58, 'Apple M2': 40,
  'Apple M1 Ultra': 90, 'Apple M1 Max': 62, 'Apple M1 Pro': 45, 'Apple M1': 28,
  'Apple A19 Pro': 18, 'Apple A18 Pro': 15, 'Apple A19': 14, 'Apple A18': 12,
  'Apple A17 Pro': 10, 'Apple A16': 6,
};
// default 17 matches the TS `default:` branch (used for non-Apple / unknown chips)
const chipBaseTokensPerSec = (chip) => CHIP_BASE_TPS[chip] ?? 17;

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

function quantizationSpeedFactor(q) {
  const n = q.toUpperCase();
  if (n.startsWith('Q4')) return 1;
  if (n.startsWith('Q5')) return 0.86;
  if (n.startsWith('Q6')) return 0.74;
  if (n.startsWith('Q8')) return 0.62;
  if (n.includes('FP16')) return 0.45;
  return 0.9;
}

function deviceThroughputFactor(deviceType) {
  if (deviceType === 'Mac Studio') return 1.3;
  if (deviceType === 'Mac Mini') return 1.05;
  if (deviceType === 'MacBook Pro') return 1;
  if (deviceType === 'MacBook Air') return 0.8;
  if (deviceType === 'iPhone 17 Pro Max') return 0.7;
  if (deviceType.startsWith('iPhone')) return 0.65;
  return 0.8;
}

function estimateLocalPerformance(model, input, ramBudget) {
  if (model.cloud_only) return { estimatedTokensPerSec: null, estimatedFirstTokenSec: null };

  const base = chipBaseTokensPerSec(input.chip) * deviceThroughputFactor(input.deviceType);
  const quantFactor = quantizationSpeedFactor(model.quantization);
  const sizeFactor = Math.pow(7 / Math.max(model.sizeB, 1), 0.9);
  const ramPressure = clamp(0.35, 1.15, (ramBudget / Math.max(model.estimatedLoadGb, 1)) * 0.9);

  const estimatedTokensPerSec = clamp(0.4, 180, base * quantFactor * sizeFactor * ramPressure);
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
  const ramBudget = input.ramGb * RAM_BUDGET_RATIO;

  let speedW, qualW;
  if (input.priority === 'Speed') { speedW = 0.3; qualW = 0.15; }
  else if (input.priority === 'Quality') { speedW = 0.1; qualW = 0.35; }
  else { speedW = 0.2; qualW = 0.25; }
  if (ramBudget > 10) qualW += 0.05;

  const chipBoost = chipSpeedBoost(input.chip);

  return [...DATASET]
    .map((model) => {
      const utilizationRatio = model.cloud_only ? 0 : model.estimatedLoadGb / ramBudget;
      const sweetSpotScore = model.cloud_only ? 30
        : utilizationRatio < 0.15 ? 20
          : utilizationRatio < 0.3 ? 50
            : utilizationRatio <= 0.7 ? 90
              : utilizationRatio <= 0.9 ? 65
                : utilizationRatio <= 1.0 ? 40
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
