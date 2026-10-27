// modelfit bench: measure REAL tokens/sec on this machine with fixed prompts and fixed sampling,
// so results compare across machines. With --submit (or a yes at the prompt) the result is POSTed
// to modelfit.io and joins the public speed test leaderboard, one board per catalog model.
//
// Offline-first contract preserved: without a submit nothing leaves the machine. Zero
// dependencies, node built-ins only. Measurement and payload: docs/plan-speed-test-2026-10.md in
// the modelfit site repo (submission contract v2).

import { spawnSync } from 'node:child_process';
import { detectHardware, toEngineInput } from './detect.mjs';
import { ollamaInstalled, ollamaBin, pullModel, parseModelTag } from './install.mjs';
import { DATASET, getRecommendations, PUBLISHED_CONTEXT_TOKENS } from './engine.mjs';
import { modelPerfInputs } from './perf-model.mjs';
import { ollamaClient, ollamaHost, requestJson } from './ollama-api.mjs';
import { WARMUP_PROMPT, BENCH_PROMPTS } from './bench-prompts.mjs';

/** Reference model of the v1 leaderboard: the default when the bench cannot ask (no TTY, --json). */
export const BENCH_MODEL = 'qwen2.5:1.5b-instruct-q4_K_M';
export const BENCH_PROMPT_ID = 'modelfit-bench-v2';
/** Leaderboard ladder, biggest first: the picker proposes the first one that fits. */
export const BENCH_LADDER = ['qwen3.8:27b', 'qwen3.5:9b', 'qwen3.5:4b'];

/** Same sampling for every run: 4k context (the engine's published context), 256 tokens, greedy. */
export const BENCH_OPTIONS = Object.freeze({ num_ctx: PUBLISHED_CONTEXT_TOKENS, num_predict: 256, temperature: 0, seed: 42 });
/** A run counts when it generated at least this many tokens (a shorter one stopped early). */
export const MIN_EVAL_COUNT = 128;
export const MIN_VALID_RUNS = 2;
/** Prefill is read only from runs that processed at least this many prompt tokens. */
export const MIN_PREFILL_PROMPT_TOKENS = 256;
/** X handle rule, shared with the server. Stored without the '@'. */
export const HANDLE_RE = /^@?[A-Za-z0-9_]{1,15}$/;

const SUBMIT_URL = 'https://modelfit.io/api/bench/submit/';
const SAFE_TAG = /^[a-z0-9][a-z0-9._:\/-]*$/i;

/** The submit endpoint: MODELFIT_BENCH_URL (stage or a local server) or modelfit.io. */
export function submitUrl(env = process.env) {
  const raw = env.MODELFIT_BENCH_URL;
  if (!raw) return SUBMIT_URL;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : SUBMIT_URL;
  } catch {
    return SUBMIT_URL;
  }
}

/** 'llama3' -> 'llama3:latest': Ollama lists a tag without a version under ':latest'. */
export function normalizeTag(tag) {
  const t = String(tag || '');
  const name = t.slice(t.lastIndexOf('/') + 1);
  return name.includes(':') ? t : `${t}:latest`;
}

/** The catalog row whose Ollama command names exactly this tag, or null. */
export function catalogRowForTag(tag) {
  return DATASET.find((m) => !m.cloud_only && parseModelTag(m.ollamaCommand) === tag) ?? null;
}

/** The `ollama list` row for `tag` ({ size }) or null when it is not local. */
function localModel(tag) {
  try {
    const out = spawnSync(ollamaBin(), ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const want = normalizeTag(tag);
    const row = (out.stdout || '').split('\n').find((l) => {
      const name = l.split(/\s+/)[0];
      return name && normalizeTag(name) === want;
    });
    if (!row) return null;
    const size = row.match(/(\d+(?:\.\d+)?\s*(?:[KMGT]B|B))\b/);
    return { size: size ? size[1] : null };
  } catch {
    return null;
  }
}

/**
 * Remove a model the bench downloaded: unload it from memory, then delete it.
 * Returns { removed, size, error }.
 */
function removeModel(tag) {
  const entry = localModel(tag);
  try {
    spawnSync(ollamaBin(), ['stop', '--', tag], { stdio: 'ignore', timeout: 30000 });
  } catch {
    // not loaded or older ollama: rm below still works
  }
  let status = 1;
  try {
    status = spawnSync(ollamaBin(), ['rm', '--', tag], { stdio: 'ignore', timeout: 60000 }).status ?? 1;
  } catch {
    status = 1;
  }
  const gone = status === 0 && !localModel(tag);
  return { removed: gone, size: entry?.size || null, error: gone ? null : `ollama rm exited with code ${status}` };
}

/** Disk size of a local model as `ollama list` prints it ('4.0 GB'), or null. */
export function benchModelSize(tag) {
  return localModel(tag)?.size ?? null;
}

/**
 * Remove a model this bench downloaded, when the user says so after the run. The caller only offers
 * it for `pulledNow` (a model the user already had is never offered). Same shape as runBench's cleanup.
 */
export function removeBenchModel(tag) {
  if (!SAFE_TAG.test(tag)) return { model: tag, removed: false, size: null, error: 'unsafe-model-tag', keptPreexisting: false };
  return { model: tag, ...removeModel(tag), keptPreexisting: false };
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round1 = (n) => Math.round(n * 10) / 10;
const posInt = (v) => Number.isInteger(v) && v > 0;

/**
 * The raw counters of one generation (Ollama's final `done: true` object) as a run, or null when
 * the run does not count: fewer than MIN_EVAL_COUNT generated tokens or a missing duration.
 */
export function toRun(final) {
  const run = {
    evalCount: final?.eval_count,
    evalDurationNs: final?.eval_duration,
    promptEvalCount: final?.prompt_eval_count ?? 0,
    promptEvalDurationNs: final?.prompt_eval_duration ?? 0,
  };
  if (!posInt(run.evalCount) || run.evalCount < MIN_EVAL_COUNT || !posInt(run.evalDurationNs)) return null;
  if (!Number.isInteger(run.promptEvalCount) || run.promptEvalCount < 0) run.promptEvalCount = 0;
  if (!Number.isInteger(run.promptEvalDurationNs) || run.promptEvalDurationNs < 0) run.promptEvalDurationNs = 0;
  return run;
}

/**
 * Medians the server recomputes the same way: decode = evalCount / evalDuration over every run,
 * prefill = promptEvalCount / promptEvalDuration over runs that processed MIN_PREFILL_PROMPT_TOKENS
 * or more (null when none did, e.g. the prompt cache served it).
 */
export function benchMedians(runs) {
  const decode = runs.map((r) => r.evalCount / (r.evalDurationNs / 1e9));
  const prefill = runs
    .filter((r) => r.promptEvalCount >= MIN_PREFILL_PROMPT_TOKENS && r.promptEvalDurationNs > 0)
    .map((r) => r.promptEvalCount / (r.promptEvalDurationNs / 1e9));
  return {
    evalTokensPerSec: decode.length ? round1(median(decode)) : null,
    prefillTokensPerSec: prefill.length ? round1(median(prefill)) : null,
  };
}

/**
 * Runs the measured prompts in order. A run that stops early is retried once with the spare (the
 * last prompt); after that a short run is just dropped. `generate(prompt)` resolves Ollama's final
 * object. Resolves { runs, attempts } (runs = the valid ones).
 */
export async function measureRuns(generate, { prompts = BENCH_PROMPTS, onRun } = {}) {
  const measured = prompts.slice(0, -1);
  const spare = prompts[prompts.length - 1];
  const runs = [];
  let attempts = 0;
  let spareUsed = false;
  const queue = [...measured];
  while (queue.length) {
    const prompt = queue.shift();
    attempts++;
    const final = await generate(prompt);
    const run = toRun(final);
    if (run) runs.push(run);
    else if (!spareUsed) {
      spareUsed = true;
      queue.push(spare);
    }
    if (onRun) onRun({ attempt: attempts, run, final });
  }
  return { runs, attempts };
}

/** The `/api/ps` entry of the benched model. */
export function findLoaded(psModels, tag) {
  const want = normalizeTag(tag);
  return (psModels || []).find((m) => normalizeTag(m?.name || m?.model) === want) ?? null;
}

/** The `ollama` block of the payload; malformed or missing fields are left out. */
export function ollamaBlock({ version, loaded, show }) {
  const block = {};
  if (typeof version === 'string' && version.length <= 40) block.version = version;
  const quant = loaded?.details?.quantization_level || show?.details?.quantization_level;
  if (typeof quant === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(quant)) block.quant = quant;
  const digest = String(loaded?.digest || '').replace(/^sha256:/, '').slice(0, 12).toLowerCase();
  if (/^[0-9a-f]{12}$/.test(digest)) block.digest = digest;
  if (posInt(loaded?.size)) block.sizeBytes = loaded.size;
  if (Number.isInteger(loaded?.size_vram) && loaded.size_vram >= 0) block.vramBytes = loaded.size_vram;
  if (posInt(loaded?.context_length)) block.contextLength = loaded.context_length;
  // Ollama 0.40+ on Apple silicon may serve the same tag as MLX safetensors ('mlx', quant 'nvfp4')
  // instead of the GGUF ('llama'): the runner tells the two apart. Not in contract v2 yet.
  if (typeof loaded?.runner === 'string' && /^[a-z0-9_.-]{1,16}$/i.test(loaded.runner)) block.runner = loaded.runner;
  return block;
}

/** Warnings from `/api/ps` after the warm-up. They never block the bench. */
export function loadWarnings(psModels, tag) {
  const out = [];
  const loaded = findLoaded(psModels, tag);
  if (loaded && posInt(loaded.size) && Number.isInteger(loaded.size_vram) && loaded.size_vram < loaded.size) {
    const gb = (b) => (b / 1e9).toFixed(1);
    out.push(`Only ${gb(loaded.size_vram)} of ${gb(loaded.size)} GB of the model is on the GPU: the rest runs on the CPU, so this result is slower than a full GPU load and is marked as a partial offload.`);
  }
  if (loaded && posInt(loaded.context_length) && loaded.context_length !== BENCH_OPTIONS.num_ctx) {
    out.push(`Ollama loaded the model with a ${loaded.context_length}-token context instead of ${BENCH_OPTIONS.num_ctx}.`);
  }
  const others = (psModels || []).filter((m) => m !== loaded).map((m) => m?.name || m?.model).filter(Boolean);
  if (others.length) {
    out.push(`Other models are loaded in Ollama (${others.join(', ')}) and share memory with the bench. For a clean run: ollama stop <name>.`);
  }
  return out;
}

/** '@you_42' -> 'you_42'; null for an empty value; throws on a malformed handle. */
export function normalizeHandle(raw) {
  if (raw == null || raw === '') return null;
  const h = String(raw).trim();
  if (!HANDLE_RE.test(h)) throw new Error(`invalid handle "${h}": 1 to 15 letters, digits or underscores, like @you`);
  return h.replace(/^@/, '');
}

/** The v2 payload (submission contract v2). */
export function buildPayload({ tag, version, hardware, handle, ollama, runs, loadMs, timestamp = new Date().toISOString() }) {
  return {
    tool: 'modelfit',
    toolVersion: version || null,
    promptId: BENCH_PROMPT_ID,
    model: tag,
    hardware,
    ...(handle ? { handle } : {}),
    ollama,
    runs,
    ...benchMedians(runs),
    loadMs: Number.isFinite(loadMs) ? loadMs : null,
    timestamp,
  };
}

/** Why the leaderboard will refuse this tag, or null when it can be submitted. */
export function submitRefusal(tag) {
  return catalogRowForTag(tag) ? null : 'not-in-catalog';
}

/**
 * Models the picker offers on this machine, from the engine's ranking: the ladder models that fit
 * (on a Mac, not 'Heavy'; everywhere, a local_feasible verdict), then up to `others` more
 * validated models that fit. Each choice: { tag, id, name, quantization, pullGb, estTokPerSec }.
 */
export function benchChoices(recs, { isAppleSilicon = false, others = 5 } = {}) {
  const fits = (r) => !r.cloud_only && r.localVerdict === 'local_feasible' && (!isAppleSilicon || r.fitLevel !== 'Heavy');
  const choice = (r) => {
    const tag = parseModelTag(r.ollamaCommand);
    return tag && {
      tag,
      id: r.id,
      name: r.name,
      quantization: r.quantization || null,
      pullGb: knownPullGb(tag),
      estTokPerSec: r.estimatedTokensPerSec ?? null,
    };
  };
  const byTag = new Map(recs.map((r) => [parseModelTag(r.ollamaCommand), r]));
  const ladder = BENCH_LADDER.map((t) => byTag.get(t)).filter((r) => r && fits(r)).map(choice).filter(Boolean);
  const rest = recs
    .filter((r) => fits(r) && !BENCH_LADDER.includes(parseModelTag(r.ollamaCommand)))
    .map(choice)
    .filter(Boolean)
    .slice(0, others);
  return { ladder, others: rest };
}

/** Picker choices for this machine (detects it). */
export function benchChoicesForThisMachine(profile = detectHardware()) {
  return benchChoices(getRecommendations(toEngineInput(profile)), { isAppleSilicon: Boolean(profile.isAppleSilicon) });
}

/**
 * Run the standardized bench. opts:
 *   model     - Ollama tag to measure (default: the reference model)
 *   noPull    - never download the model; fail if it is not local
 *   submit    - POST the result to the leaderboard (the ONLY network call besides the local
 *               Ollama server, opt-in)
 *   handle    - optional X handle shown on the result card
 *   cleanup   - remove the model afterwards if this bench downloaded it
 *               (a model the user already had is never deleted)
 *   askCleanup - the caller asks, once the run is over, whether to remove a model this bench
 *               downloaded (the interactive CLI); only changes the notice
 *   onNotice  - callback(string) for the pre-run notice and progress (the CLI prints to stderr)
 *   timeoutMs - cap for one generation (default 15 min)
 *   version   - CLI version string for the payload
 */
export async function runBench(opts = {}) {
  const host = ollamaHost();
  if (host.error) {
    return { ok: false, error: host.error, hint: `OLLAMA_HOST=${host.host}: modelfit bench measures this machine. Unset OLLAMA_HOST or point it at 127.0.0.1.` };
  }
  const tag = opts.model || BENCH_MODEL;
  if (!SAFE_TAG.test(tag)) return { ok: false, error: 'unsafe-model-tag' };
  let handle = null;
  try {
    handle = normalizeHandle(opts.handle);
  } catch (err) {
    return { ok: false, error: 'invalid-handle', hint: err.message };
  }

  const ollama = ollamaClient();
  let version = null;
  try {
    version = await ollama.version();
  } catch {
    return ollamaInstalled()
      ? { ok: false, error: 'ollama-not-running', hint: 'Start Ollama (open the Ollama app, or run: ollama serve) and retry.' }
      : { ok: false, error: 'ollama-not-installed', hint: 'Install Ollama from https://ollama.com/download and retry.' };
  }

  const notice = opts.onNotice || (() => {});
  let installed = [];
  try {
    installed = await ollama.tags();
  } catch {
    installed = [];
  }
  const preexisting = installed.some((m) => normalizeTag(m?.name || m?.model) === normalizeTag(tag));
  notice(benchNotice(tag, { preexisting, cleanup: Boolean(opts.cleanup), noPull: Boolean(opts.noPull), ask: Boolean(opts.askCleanup) }));
  let pulledNow = false;
  if (!preexisting) {
    if (opts.noPull) return { ok: false, error: 'model-not-pulled', hint: `Run: ollama pull ${tag}` };
    if (!ollamaInstalled()) return { ok: false, error: 'ollama-not-installed', hint: `The ollama command is needed to download ${tag}: https://ollama.com/download` };
    // Pull progress goes to stderr, so `--json` keeps stdout for the result.
    const code = pullModel(tag, { stdio: ['ignore', 2, 2] });
    if (code !== 0) return { ok: false, error: 'pull-failed', model: tag };
    pulledNow = true;
  }

  const finish = (result) => {
    if (!opts.cleanup) return { ...result, cleanup: null, pulledNow };
    const cleanup = pulledNow
      ? { model: tag, ...removeModel(tag), keptPreexisting: false }
      : { model: tag, removed: false, size: null, error: null, keptPreexisting: true };
    return { ...result, cleanup, pulledNow };
  };

  const timing = { idleMs: 180000, totalMs: opts.timeoutMs ?? 900000 };
  const generate = (prompt, options = BENCH_OPTIONS) => ollama.generate({ model: tag, prompt, options }, timing);

  let loadMs = null;
  let loaded = null;
  let show = null;
  let warnings = [];
  let measured;
  try {
    // A model still loaded from an earlier bench keeps these very prompts in its cache, and the
    // prefill would then read as thousands of tok/s: unload it so every bench starts cold.
    if (findLoaded(await ollama.ps().catch(() => []), tag)) {
      notice(`  ${tag} is loaded from an earlier run: unloading it so no cached prompt is reused...`);
      await ollama.unload(tag);
      for (let i = 0; i < 20 && findLoaded(await ollama.ps().catch(() => []), tag); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    notice(`  warming up ${tag} (loads it into memory)...`);
    const warm = await generate(WARMUP_PROMPT, { ...BENCH_OPTIONS, num_predict: 32 });
    loadMs = Number.isFinite(warm.load_duration) ? Math.round(warm.load_duration / 1e6) : null;
    const ps = await ollama.ps().catch(() => []);
    loaded = findLoaded(ps, tag);
    warnings = loadWarnings(ps, tag);
    for (const w of warnings) notice(`  warning: ${w}`);
    show = await ollama.show(tag).catch(() => null);
    const total = BENCH_PROMPTS.length - 1;
    measured = await measureRuns((prompt) => generate(prompt), {
      onRun: ({ attempt, run, final }) => {
        const rate = run ? `${round1(run.evalCount / (run.evalDurationNs / 1e9))} tok/s` : `stopped after ${final?.eval_count ?? 0} tokens, not counted`;
        notice(`  run ${attempt}${attempt <= total ? `/${total}` : ' (retry)'}: ${rate}`);
      },
    });
  } catch (err) {
    return finish({ ok: false, error: 'bench-failed', hint: `Ollama: ${err?.message || err}` });
  }

  if (measured.runs.length < MIN_VALID_RUNS) {
    return finish({
      ok: false,
      error: 'too-few-valid-runs',
      hint: `Only ${measured.runs.length} of ${measured.attempts} runs generated ${MIN_EVAL_COUNT} tokens or more; ${MIN_VALID_RUNS} are needed.`,
    });
  }

  const payload = buildPayload({
    tag,
    version: opts.version,
    hardware: detectHardware(),
    handle,
    ollama: ollamaBlock({ version, loaded, show }),
    runs: measured.runs,
    loadMs,
  });
  const result = finish({ ok: true, payload, warnings, submitted: false });
  if (!opts.submit) return result;
  return { ...result, ...(await submitBench(payload)) };
}

const REASONS = {
  'unknown-hardware': 'ModelFit does not recognize this chip or GPU yet',
  'multi-gpu': 'multi-GPU runs are kept off the leaderboard',
  'below-floor': 'a run was slower than any working setup',
  'above-ceiling': 'a run was faster than this machine\'s memory bandwidth allows',
};

/**
 * POST a payload to the leaderboard. Resolves { submitted, listed, reason, id, link, submitError }:
 * `link` is the result page on the server that was posted to, when the run is listed.
 */
export async function submitBench(payload, { url = submitUrl() } = {}) {
  const refusal = submitRefusal(payload.model);
  if (refusal) {
    return { submitted: false, submitError: `${payload.model} is not a ModelFit-validated model, so the leaderboard does not take it. Run \`modelfit bench\` without --model to pick one.` };
  }
  try {
    const post = (target) => requestJson(target, { method: 'POST', body: payload, idleMs: 15000, totalMs: 20000 });
    let target = url;
    let res = await post(target);
    // One 307/308 (a URL without its trailing slash) is followed, on the same origin only.
    if ((res.status === 307 || res.status === 308) && res.location) {
      const next = new URL(res.location, target);
      if (next.origin === new URL(target).origin) {
        next.username = new URL(target).username;
        next.password = new URL(target).password;
        target = next.href;
        res = await post(target);
      }
    }
    const body = res.json || {};
    if (res.status !== 200 || body.ok !== true) {
      return { submitted: false, submitError: `HTTP ${res.status}${body.error ? `: ${body.error}` : ''}` };
    }
    const listed = body.listed !== false;
    let link = null;
    if (listed && typeof body.path === 'string' && body.path.startsWith('/')) {
      try {
        const page = new URL(body.path, target);
        page.username = '';
        page.password = '';
        link = page.href;
      } catch {
        link = null;
      }
    }
    return {
      submitted: true,
      listed,
      id: typeof body.id === 'string' ? body.id : null,
      reason: listed ? null : (typeof body.reason === 'string' ? body.reason : 'unknown'),
      link,
    };
  } catch (err) {
    return { submitted: false, submitError: String(err?.message || err) };
  }
}

/**
 * A ready-to-post X link for a listed run: the result in one line, the result page as the link
 * (X shows its card) and `via @modelfit_`. Built from the payload only; nothing is sent.
 */
export function xShareUrl(payload, link) {
  const hw = payload?.hardware || {};
  const name = catalogRowForTag(payload?.model)?.name || payload?.model;
  const machine = hw.accelerator?.kind === 'gpu'
    ? hw.accelerator.name
    : [hw.deviceLabel || hw.deviceType, hw.chipLabel || hw.chip, hw.ramGb && `${hw.ramGb} GB`].filter(Boolean).join(' ');
  const rate = Number(payload?.evalTokensPerSec).toFixed(1);
  const text = `${name}: ${rate} tok/s on my ${machine}. Can your machine beat it?`;
  const q = new URLSearchParams({ text, url: link, via: 'modelfit_' });
  return `https://x.com/intent/post?${q}`;
}

/** What a submit sends, one line per field group, for the question before it. */
export function describeSubmission(payload, { url = submitUrl() } = {}) {
  const hw = payload.hardware || {};
  const o = payload.ollama || {};
  const gb = (b) => `${(b / 1e9).toFixed(1)} GB`;
  const machine = [hw.deviceLabel || hw.deviceType, hw.chipLabel || hw.chip, hw.ramGb && `${hw.ramGb} GB`, hw.gpuCores && `${hw.gpuCores}-core GPU`, hw.accelerator?.kind === 'gpu' && hw.accelerator.name, hw.gpuCount > 1 && `${hw.gpuCount} GPUs`]
    .filter(Boolean).join(', ');
  const ollama = [o.version && `Ollama ${o.version}`, o.runner && `${o.runner} runner`, o.quant, o.digest && `digest ${o.digest}`, o.sizeBytes && `${gb(o.sizeBytes)} loaded`, o.vramBytes != null && o.sizeBytes && `${gb(o.vramBytes)} on GPU`, o.contextLength && `${o.contextLength} context`]
    .filter(Boolean).join(', ');
  return [
    `  Sent to ${new URL(url).host} if you say yes:`,
    `    model     ${payload.model}`,
    `    machine   ${machine} (plus OS, CPU architecture and core count)`,
    `    ollama    ${ollama || 'version unknown'}`,
    `    runs      ${payload.runs.length} runs: token counts and durations, ${payload.evalTokensPerSec} tok/s median`,
    `    handle    ${payload.handle ? `@${payload.handle}` : 'none (add --handle @you to show it on your card)'}`,
    `    tool      modelfit ${payload.toolVersion || ''}, time of the run`.trimEnd(),
    '  No account. Your IP address is not stored.',
  ];
}

/**
 * Download size in GB of an Ollama tag when the bundled catalog knows it, else null: the model
 * layer of the tag's registry manifest (data/model-perf.json, weightsSource "ollama-manifest"),
 * found through the catalog row whose ollamaCommand is exactly `ollama run <tag>`. It is not the
 * catalog's estimatedLoadGb, which is a memory figure (1.5 GB for this 0.99 GB reference model).
 * The bench never queries the registry itself: nothing leaves the machine unless it submits.
 */
export function knownPullGb(tag) {
  const row = DATASET.find((m) => m.ollamaCommand === `ollama run ${tag}`);
  const perf = row ? modelPerfInputs(row.id) : null;
  return perf && perf.weightsSource === 'ollama-manifest' ? perf.weightsGb : null;
}

/** '16.8 GB' or '0.99 GB'. */
export function formatGb(gb) {
  return `${gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)} GB`;
}

/** What the bench is about to do, shown before any download. */
export function benchNotice(tag, { preexisting, cleanup, noPull, ask = false }) {
  const runs = `${BENCH_PROMPTS.length - 1} fixed prompts`;
  const lines = [];
  if (preexisting) {
    lines.push(`modelfit bench: ${tag} is already installed, running ${runs} on it.`);
    if (cleanup) lines.push('  --cleanup: you had this model before the bench, so it will be kept.');
  } else if (noPull) {
    lines.push(`modelfit bench: ${tag} is not installed and --no-pull is set.`);
  } else {
    // The size is stated only when the catalog knows it; a --model tag it does not know gets no size.
    const gb = knownPullGb(tag);
    const what = tag === BENCH_MODEL ? 'the reference model' : 'the model';
    const size = gb == null ? '' : ` (${formatGb(gb)})`;
    lines.push(`modelfit bench: downloading ${what} ${tag}${size}, then running ${runs}.`);
    lines.push(cleanup
      ? '  --cleanup: the model will be removed when the bench ends, nothing is left on your machine.'
      : ask
        ? '  When the bench ends, you choose whether to keep it or remove it from disk.'
        : '  The model stays installed afterwards. Add --cleanup to remove it automatically.');
  }
  return lines.join('\n');
}

function cleanupLines(result, { green, dim, askCleanup = false }) {
  const c = result.cleanup;
  if (!c) {
    // The interactive CLI asks after the run instead (removeBenchModel).
    if (result.pulledNow && result.payload && !askCleanup) {
      return [dim(`  ${result.payload.model} is still installed. Remove it with: ollama rm ${result.payload.model} (or rerun with --cleanup)`)];
    }
    return [];
  }
  if (c.keptPreexisting) return [`  ${green('cleanup')}: ${c.model} was already installed before the bench, kept it.`];
  if (c.removed) return [`  ${green('All cleaned up')}: ${c.model}${c.size ? ` (${c.size})` : ''} removed, nothing from this bench is left on your machine.`];
  return [`  cleanup failed (${c.error}). Remove it by hand with: ollama rm ${c.model}`];
}

// 3-row block digits for the headline figure (screenshot-friendly).
const DIGITS = {
  0: ['█▀█', '█ █', '▀▀▀'], 1: ['▀█ ', ' █ ', '▀▀▀'], 2: ['▀▀█', '█▀▀', '▀▀▀'], 3: ['▀▀█', ' ▀█', '▀▀▀'],
  4: ['█ █', '▀▀█', '  ▀'], 5: ['█▀▀', '▀▀█', '▀▀▀'], 6: ['█▀▀', '█▀█', '▀▀▀'], 7: ['▀▀█', '  █', '  ▀'],
  8: ['█▀█', '█▀█', '▀▀▀'], 9: ['█▀█', '▀▀█', '▀▀▀'], '.': [' ', ' ', '▀'],
};

/** A number in block digits, three rows. */
export function bigNumber(value) {
  const chars = String(value).split('').filter((c) => DIGITS[c]);
  return [0, 1, 2].map((row) => chars.map((c) => DIGITS[c][row]).join(' '));
}

// eslint-disable-next-line no-control-regex
const visibleLength = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

/** The machine as one short line, from the detected keys. */
export function machineLine(hw = {}) {
  if (hw.accelerator?.kind === 'gpu') {
    return [hw.accelerator.name, hw.accelerator.vramGb && `${hw.accelerator.vramGb} GB VRAM`, hw.gpuCount > 1 && `${hw.gpuCount} GPUs`].filter(Boolean).join(' · ');
  }
  return [hw.deviceLabel || hw.deviceType, hw.chipLabel || hw.chip, hw.ramGb && `${hw.ramGb} GB`, hw.gpuCores && `${hw.gpuCores}-core GPU`].filter(Boolean).join(' · ');
}

/** Human-readable rendering of a bench result: a framed card when it worked. */
export function renderBench(result, { color = true, big = true, askCleanup = false } = {}) {
  const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = paint('1');
  const dim = paint('2');
  const green = paint('32');
  if (!result.ok) {
    return [`bench: ${result.error}${result.hint ? `\n${result.hint}` : ''}`, ...cleanupLines(result, { green, dim, askCleanup })].join('\n');
  }
  const p = result.payload;
  const row = catalogRowForTag(p.model);
  const quant = p.ollama?.quant || row?.quantization;
  const rate = p.evalTokensPerSec;
  const figure = big
    ? bigNumber(rate).map((l, i) => (i === 1 ? `${green(bold(l))}  ${bold('tok/s')} ${dim('generation')}` : green(bold(l))))
    : [`${green(bold(`${rate} tok/s`))} ${dim('generation')}`];
  const meta = [`median of ${p.runs.length} runs`, p.ollama?.version && `Ollama ${p.ollama.version}`, `${Math.round(BENCH_OPTIONS.num_ctx / 1024)}k context`, p.timestamp?.slice(0, 10)]
    .filter(Boolean).join(' · ');
  const body = [
    `${bold('modelfit')}  ${dim('speed test')}${p.handle ? `   @${p.handle}` : ''}`,
    '',
    machineLine(p.hardware),
    `${row ? row.name : p.model}  ${dim(`${p.model}${quant ? ` · ${quant}` : ''}`)}`,
    '',
    ...figure.map((l) => `  ${l}`),
    ...(p.prefillTokensPerSec != null ? [`  ${p.prefillTokensPerSec} tok/s ${dim('prompt processing')}`] : []),
    '',
    dim(meta),
  ];
  if (result.link) body.push(result.link);
  const width = Math.max(...body.map(visibleLength));
  const pad = (s) => `${s}${' '.repeat(width - visibleLength(s))}`;
  const lines = [
    `╭${'─'.repeat(width + 2)}╮`,
    ...body.map((l) => `│ ${pad(l)} │`),
    `╰${'─'.repeat(width + 2)}╯`,
  ];
  for (const w of result.warnings || []) lines.push(dim(`  note: ${w}`));
  if (result.submitted && result.listed) {
    lines.push(`  ${green('submitted')}: your result page is ${result.link || 'on modelfit.io/bench/'}`);
    if (result.link) lines.push(`  Post it on X: ${xShareUrl(result.payload, result.link)}`);
  } else if (result.submitted) {
    lines.push(`  stored, but not listed on the leaderboard: ${REASONS[result.reason] || result.reason}.`);
  } else if (result.submitError) {
    lines.push(`  not submitted: ${result.submitError}`);
  }
  lines.push(...cleanupLines(result, { green, dim, askCleanup }));
  return lines.join('\n');
}

/** The line that reports a cleanup the user asked for after the run (removeBenchModel). */
export function renderCleanup(cleanup, { color = true } = {}) {
  const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return cleanupLines({ cleanup }, { green: paint('32'), dim: paint('2') }).join('\n');
}
