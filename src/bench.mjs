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

function ollamaVersion() {
  try {
    const out = spawnSync(ollamaBin(), ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = `${out.stdout || ''}${out.stderr || ''}`.match(/(\d+\.\d+[\d.]*)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function modelPulled(tag) {
  try {
    const out = spawnSync(ollamaBin(), ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (out.stdout || '').split('\n').some((l) => l.split(/\s+/)[0] === tag);
  } catch {
    return false;
  }
}

/**
 * Run the standardized bench. opts:
 *   model     — override the reference tag (must pass the safe-tag check)
 *   noPull    — never download the model; fail if it is not local
 *   submit    — POST the result to modelfit.io (the ONLY network call, opt-in)
 *   timeoutMs — cap for the inference run (default 180s)
 *   version   — CLI version string for the payload
 */
export async function runBench(opts = {}) {
  if (!ollamaInstalled()) {
    return { ok: false, error: 'ollama-not-installed', hint: 'Install Ollama from https://ollama.com/download and retry.' };
  }
  const tag = opts.model || BENCH_MODEL;
  if (!SAFE_TAG.test(tag)) {
    return { ok: false, error: 'unsafe-model-tag' };
  }
  if (!modelPulled(tag)) {
    if (opts.noPull) {
      return { ok: false, error: 'model-not-pulled', hint: `Run: ollama pull ${tag}` };
    }
    const code = pullModel(tag);
    if (code !== 0) return { ok: false, error: 'pull-failed', model: tag };
  }

  const res = spawnSync(ollamaBin(), ['run', '--verbose', tag, BENCH_PROMPT], {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  const rate = text.match(/eval rate:\s*([\d.]+)\s*tokens?\/s/i);
  if (!rate) {
    return { ok: false, error: 'bench-failed', hint: 'ollama run did not report an eval rate. Is the model working interactively?' };
  }
  const load = text.match(/load duration:\s*([\d.]+)\s*(ms|s)/i);
  const loadMs = load ? Math.round(parseFloat(load[1]) * (load[2].toLowerCase() === 's' ? 1000 : 1)) : null;

  const payload = {
    tool: 'modelfit',
    toolVersion: opts.version || null,
    hardware: detectHardware(),
    ollamaVersion: ollamaVersion(),
    model: tag,
    promptId: BENCH_PROMPT_ID,
    evalTokensPerSec: Math.round(parseFloat(rate[1]) * 10) / 10,
    loadMs,
    timestamp: new Date().toISOString(),
  };

  if (!opts.submit) return { ok: true, payload, submitted: false };

  try {
    const res2 = await fetch(SUBMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res2.ok) {
      return { ok: true, payload, submitted: false, submitError: `HTTP ${res2.status}` };
    }
    return { ok: true, payload, submitted: true };
  } catch (err) {
    return { ok: true, payload, submitted: false, submitError: String(err?.message || err) };
  }
}

/** Human-readable rendering of a bench result. */
export function renderBench(result, { color = true } = {}) {
  const paint = (code) => (s) => (color ? `[${code}m${s}[0m` : s);
  const bold = paint('1');
  const dim = paint('2');
  const green = paint('32');
  if (!result.ok) {
    return `bench: ${result.error}${result.hint ? `\n${result.hint}` : ''}`;
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
      ? `  ${green('submitted')} — thanks for contributing to the measured dataset (CC BY 4.0)`
      : '  not submitted — rerun with `modelfit bench --submit` to contribute this datapoint',
    result.submitError ? `  submit failed: ${result.submitError}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}
