// The single-answer core: bestModel(hardware?) -> THE most capable local model the
// machine can run COMFORTABLY. This is the primitive other local-AI apps embed: on
// launch, ask ModelFit, pull the answer, run it. No use-case quiz, no menu.
//
// "Best" = highest qualityScore among models the engine rates `local_feasible`
// (fits the ~70% memory budget AND clears the tok/s comfort floor). Capability is
// maximised — we push the machine to the strongest model it can still run well,
// not a safe small default. Falls back a tier (local_slow) only if nothing is
// comfortable, and never returns a cloud-only model.

import { getRecommendations } from './engine.mjs';
import { detectHardware, toEngineInput } from './detect.mjs';
import { modelUrl, reportUrl, SOURCE } from './links.mjs';

// Best-tier first; only drop to a slower tier when nothing comfortable exists.
const TIERS = ['local_feasible', 'local_slow'];

const byCapability = (a, b) =>
  b.qualityScore - a.qualityScore ||
  b.popularityScore - a.popularityScore ||
  (b.estimatedTokensPerSec ?? 0) - (a.estimatedTokensPerSec ?? 0);

// The "best" is a UNIVERSAL default an app embeds, so it must be a general assistant —
// not a narrow specialist. A model is general-purpose if it signals general chat
// ('chat'/'mixed'), or carries no specialist-only tag. A model tagged for coding/
// reasoning/translation WITHOUT a general signal is a specialist and is skipped for
// the single best pick (it still appears in the full --all ranked list).
const SPECIALIST = ['coding', 'reasoning', 'translation'];
const GENERAL = ['chat', 'mixed'];
function isGeneralPurpose(m) {
  const tags = m.tags ?? [];
  if (tags.some((t) => GENERAL.includes(t))) return true;
  if (tags.some((t) => SPECIALIST.includes(t))) return false;
  return true;
}

/** Pick THE best from an already-ranked recommendation list. Pure. */
export function selectBest(recs) {
  for (const tier of TIERS) {
    const pool = recs.filter((r) => !r.cloud_only && r.localVerdict === tier);
    if (!pool.length) continue;
    const general = pool.filter(isGeneralPurpose);
    // Prefer the most capable general-purpose model; fall back to the tier's best
    // only if nothing general is available at this comfort level.
    return [...(general.length ? general : pool)].sort(byCapability)[0];
  }
  // Last resort: any locally-runnable model at all, strongest first.
  const local = recs.filter((r) => !r.cloud_only).sort(byCapability);
  return local[0] ?? null;
}

/** Shape returned to integrators. STABLE contract — additive changes only. */
export function bestContract(pick, engineInput, profile) {
  if (!pick) return null;
  return {
    name: pick.name,
    id: pick.id,
    family: pick.family,
    params: `${pick.sizeB}B`,
    sizeB: pick.sizeB,
    quantization: pick.quantization,
    ollamaCommand: pick.ollamaCommand ?? null,
    estimatedTokensPerSec: pick.estimatedTokensPerSec,
    fit: pick.fitLevel,
    localVerdict: pick.localVerdict,
    comfortable: pick.localVerdict === 'local_feasible',
    qualityScore: pick.qualityScore,
    bestFor: pick.bestFor,
    why: pick.why,
    learnMoreUrl: modelUrl(pick.family),
    hardware: {
      deviceType: engineInput.deviceType,
      chip: engineInput.chip,
      ramGb: engineInput.ramGb,
      detected: profile ? profile.detail : null,
    },
    reportUrl: reportUrl(engineInput.ramGb),
    source: SOURCE,
    note: 'tokens/sec are estimates, not measured benchmarks.',
  };
}

/**
 * THE best local model for this machine. Auto-detects hardware when no input given.
 *
 *   import { bestModel } from '@wecko-ai/modelfit'
 *   const m = bestModel()                 // detect this machine
 *   const m = bestModel({ ramGb: 64, chip: 'Apple M4 Max', deviceType: 'MacBook Pro' })
 *
 * @param {{ramGb?:number, chip?:string, deviceType?:string}} [input]
 * @returns {object|null} the stable contract (see toContract), or null if nothing runs.
 */
export function bestModel(input) {
  let engineInput;
  let profile = null;
  if (input && typeof input.ramGb === 'number') {
    engineInput = {
      deviceType: input.deviceType ?? 'MacBook Pro',
      chip: input.chip ?? 'Unknown',
      ramGb: input.ramGb,
      priority: 'Balanced',
      useCase: 'Mixed',
    };
  } else {
    profile = detectHardware();
    engineInput = toEngineInput(profile, input ?? {});
  }
  const recs = getRecommendations(engineInput);
  return bestContract(selectBest(recs), engineInput, profile);
}
