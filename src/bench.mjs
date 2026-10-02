// modelfit bench — measure REAL tokens/sec on this machine with a fixed
// reference model + fixed prompt, so results are comparable across machines.
// With --submit, the datapoint is POSTed to modelfit.io and joins the public
// CC BY measured dataset (Move 3, docs/strategy-become-number-one-2026-08).
//
// Offline-first contract preserved: without --submit nothing leaves the
// machine. Zero dependencies, node built-ins only.

import { spawnSync } from 'node:child_process';
import { detectHardware } from './detect.mjs';
import { ollamaInstalled, ollamaBin, pullModel } from './install.mjs';

// Fixed reference: small enough to run everywhere, big enough to be
// bandwidth-bound on every tracked device. Bump ONLY with BENCH_PROMPT_ID.
export const BENCH_MODEL = 'qwen2.5:1.5b-instruct-q4_K_M';
export const BENCH_PROMPT_ID = 'modelfit-bench-v1';
const BENCH_PROMPT = 'Explain in exactly three sentences why the sky is blue.';

const SUBMIT_URL = 'https://modelfit.io/api/bench/submit/';
const SAFE_TAG = /^[a-z0-9][a-z0-9._:\/-]*$/i;

// `ollama run --verbose` prints BOTH "prompt eval rate" (prefill) and "eval rate"
// (generation), prefill first. An unanchored /eval rate:/ matched the prefill line
// and reported prompt-processing speed (8x the real decode rate on an M4) as tok/s.
// Anchor to the start of the line so only the generation rate can match.
// Fixed in 1.5.2; every submission from 1.5.1 and earlier carries the prefill rate.
export function parseVerboseStats(text) {
  const rate = String(text).match(/^\s*eval rate:\s*([\d.]+)\s*tokens?\/s/im);
  const load = String(text).match(/^\s*load duration:\s*([\d.]+)\s*(ms|s)/im);
  return {
    evalTokensPerSec: rate ? Math.round(parseFloat(rate[1]) * 10) / 10 : null,
    loadMs: load ? Math.round(parseFloat(load[1]) * (load[2].toLowerCase() === 's' ? 1000 : 1)) : null,
  };
}

function ollamaVersion() {
  try {
    const out = spawnSync(ollamaBin(), ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = `${out.stdout || ''}${out.stderr || ''}`.match(/(\d+\.\d+[\d.]*)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The `ollama list` row for `tag` ({ size }) or null when it is not local. */
function localModel(tag) {
  try {
    const out = spawnSync(ollamaBin(), ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const row = (out.stdout || '').split('\n').find((l) => l.split(/\s+/)[0] === tag);
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

/**
 * Run the standardized bench. opts:
 *   model     - override the reference tag (must pass the safe-tag check)
 *   noPull    - never download the model; fail if it is not local
 *   submit    - POST the result to modelfit.io (the ONLY network call, opt-in)
 *   cleanup   - remove the model afterwards if this bench downloaded it
 *               (a model the user already had is never deleted)
 *   onNotice  - callback(string) for the pre-run notice (CLI prints it)
 *   timeoutMs - cap for the inference run (default 180s)
 *   version   - CLI version string for the payload
 */
export async function runBench(opts = {}) {
  if (!ollamaInstalled()) {
    return { ok: false, error: 'ollama-not-installed', hint: 'Install Ollama from https://ollama.com/download and retry.' };
  }
  const tag = opts.model || BENCH_MODEL;
  if (!SAFE_TAG.test(tag)) {
    return { ok: false, error: 'unsafe-model-tag' };
  }
  const preexisting = Boolean(localModel(tag));
  if (opts.onNotice) opts.onNotice(benchNotice(tag, { preexisting, cleanup: Boolean(opts.cleanup), noPull: Boolean(opts.noPull) }));
  let pulledNow = false;
  if (!preexisting) {
    if (opts.noPull) {
      return { ok: false, error: 'model-not-pulled', hint: `Run: ollama pull ${tag}` };
    }
    const code = pullModel(tag);
    if (code !== 0) return { ok: false, error: 'pull-failed', model: tag };
    pulledNow = true;
  }

  const res = spawnSync(ollamaBin(), ['run', '--verbose', tag, BENCH_PROMPT], {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Cleanup runs whether or not the measurement succeeded: --cleanup means
  // the bench leaves nothing behind.
  let cleanup = null;
  if (opts.cleanup) {
    cleanup = pulledNow
      ? { model: tag, ...removeModel(tag), keptPreexisting: false }
      : { model: tag, removed: false, size: null, error: null, keptPreexisting: true };
  }

  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  const stats = parseVerboseStats(text);
  if (stats.evalTokensPerSec == null) {
    return { ok: false, error: 'bench-failed', hint: 'ollama run did not report an eval rate. Is the model working interactively?', cleanup, pulledNow };
  }

  const payload = {
    tool: 'modelfit',
    toolVersion: opts.version || null,
    hardware: detectHardware(),
    ollamaVersion: ollamaVersion(),
    model: tag,
    promptId: BENCH_PROMPT_ID,
    evalTokensPerSec: stats.evalTokensPerSec,
    loadMs: stats.loadMs,
    timestamp: new Date().toISOString(),
  };

  if (!opts.submit) return { ok: true, payload, submitted: false, cleanup, pulledNow };

  try {
    const res2 = await fetch(SUBMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res2.ok) {
      return { ok: true, payload, submitted: false, submitError: `HTTP ${res2.status}`, cleanup, pulledNow };
    }
    return { ok: true, payload, submitted: true, cleanup, pulledNow };
  } catch (err) {
    return { ok: true, payload, submitted: false, submitError: String(err?.message || err), cleanup, pulledNow };
  }
}

/** What the bench is about to do, shown before any download. */
export function benchNotice(tag, { preexisting, cleanup, noPull }) {
  const lines = [];
  if (preexisting) {
    lines.push(`modelfit bench: ${tag} is already installed, running one fixed prompt on it.`);
    if (cleanup) lines.push('  --cleanup: you had this model before the bench, so it will be kept.');
  } else if (noPull) {
    lines.push(`modelfit bench: ${tag} is not installed and --no-pull is set.`);
  } else {
    lines.push(`modelfit bench: downloading the reference model ${tag} (about 1 GB), then running one fixed prompt.`);
    lines.push(cleanup
      ? '  --cleanup: the model will be removed when the bench ends, nothing is left on your machine.'
      : '  The model stays installed afterwards. Add --cleanup to remove it automatically.');
  }
  return lines.join('\n');
}

function cleanupLines(result, { green, dim }) {
  const c = result.cleanup;
  const thanks = result.submitted ? ' Thanks for your contribution!' : '';
  if (!c) {
    const out = [];
    if (result.pulledNow && result.payload) {
      out.push(dim(`  ${result.payload.model} is still installed. Remove it with: ollama rm ${result.payload.model} (or rerun with --cleanup)`));
    }
    if (result.submitted) out.push('  Thanks for your contribution!');
    return out;
  }
  if (c.keptPreexisting) {
    return [`  ${green('cleanup')}: ${c.model} was already installed before the bench, kept it. Nothing was added.${thanks}`];
  }
  if (c.removed) {
    return [`  ${green('All cleaned up')}: ${c.model}${c.size ? ` (${c.size})` : ''} removed, nothing from this bench is left on your machine.${thanks}`];
  }
  return [`  cleanup failed (${c.error}). Remove it by hand with: ollama rm ${c.model}`];
}

/** Human-readable rendering of a bench result. */
export function renderBench(result, { color = true } = {}) {
  const paint = (code) => (s) => (color ? `[${code}m${s}[0m` : s);
  const bold = paint('1');
  const dim = paint('2');
  const green = paint('32');
  if (!result.ok) {
    return [`bench: ${result.error}${result.hint ? `\n${result.hint}` : ''}`, ...cleanupLines(result, { green, dim })].join('\n');
  }
  const p = result.payload;
  const hw = p.hardware || {};
  const lines = [
    `${bold('bench result')} ${dim(`(${p.promptId})`)}`,
    `  ${p.model}  ${green(`-> ${p.evalTokensPerSec} tok/s`)} measured`,
    p.loadMs != null ? `  load: ${(p.loadMs / 1000).toFixed(1)}s` : null,
    `  hardware: ${hw.deviceLabel || hw.deviceType || 'unknown'} · ${hw.chip || ''} · ${hw.ramGb || '?'} GB`,
    p.ollamaVersion ? `  ollama: ${p.ollamaVersion}` : null,
    result.submitted
      ? `  ${green('submitted')} to the public measured dataset (CC BY 4.0). Your machine joins the leaderboard at https://modelfit.io/bench/ after the next site update.`
      : '  not submitted: rerun with `modelfit bench --submit --cleanup` to contribute this datapoint',
    result.submitError ? `  submit failed: ${result.submitError}` : null,
    ...cleanupLines(result, { green, dim }),
  ].filter(Boolean);
  return lines.join('\n');
}
