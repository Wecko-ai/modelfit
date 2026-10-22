// Engine guard. Three layers, all offline-safe:
//  1. Structural sanity on the JS engine (always).
//  2. Golden-snapshot parity: asserts the engine reproduces test/golden.json
//     (the committed source of truth; works in the standalone repo with no TS around).
//  3. Live parity vs lib/recommend.ts via tsx, only when the monorepo is present;
//     this is what keeps golden.json honest. Re-generate golden via scripts/gen-golden.mjs.
// Run: node test/parity.mjs   (or npm test)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { getRecommendations, DATASET } from '../src/engine.mjs';
import { bestModel } from '../src/best.mjs';
import { groupVariants } from '../src/model-groups.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

const golden = JSON.parse(readFileSync(join(__dirname, 'golden.json'), 'utf8'));
const GRID = golden.map((g) => g.input);

let failures = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); failures++; };
// tok/s, first-token time and typical error are compared too: a speed change that flips no
// verdict would otherwise go unseen. All three are rounded by the engine (0.1 s, 0.1 tok/s, 5 %).
const sameNum = (x, y, tol) => (x ?? null) === null ? (y ?? null) === null : y != null && Math.abs(x - y) <= tol;
const same = (a, b) => a.length === b.length && a.every((x, i) =>
  x.id === b[i].id && Math.abs(x.score - b[i].score) <= 0.01 &&
  sameNum(x.tps, b[i].tps, 0.05) && sameNum(x.ft, b[i].ft, 0.05) && sameNum(x.err, b[i].err, 0.5));
const sameIds = (a = [], b = []) => a.length === b.length && a.every((x, i) => x === b[i]);

// ── 1. Structural sanity ────────────────────────────────────────────────────
for (const input of GRID) {
  const recs = getRecommendations(input);
  const tag = `${input.chip} / ${input.ramGb}GB`;
  if (recs.length !== DATASET.length) fail(`${tag}: expected ${DATASET.length} ranked models, got ${recs.length}`);
  for (let i = 1; i < recs.length; i++) {
    if (recs[i - 1].score < recs[i].score) { fail(`${tag}: not sorted desc at ${i}`); break; }
  }
  for (const k of ['id', 'name', 'score', 'fitLevel', 'localVerdict', 'why']) {
    if (recs[0][k] === undefined) fail(`${tag}: top pick missing "${k}"`);
  }
}
console.log(`✓ structural sanity passed (${GRID.length} inputs × ${DATASET.length} models)`);

// ── 2. Golden-snapshot parity (offline source of truth) ─────────────────────
let goldMismatch = 0;
golden.forEach((g, gi) => {
  const recs = getRecommendations(g.input);
  const got = recs.map((r) => ({ id: r.id, score: r.score, tps: r.estimatedTokensPerSec, ft: r.estimatedFirstTokenSec, err: r.estimatedErrorPct }));
  if (!same(got, g.ranking) || !sameIds(groupVariants(recs).map((r) => r.id), g.grouped)) {
    goldMismatch++;
    if (goldMismatch <= 5) fail(`golden[${gi}] (${g.input.chip}/${g.input.ramGb}GB): engine output differs from test/golden.json`);
  }
});
if (!goldMismatch) console.log(`✓ matches golden snapshot (${golden.length} inputs, ranking + scores + tok/s + first token + error + grouped list)`);
else fail(`${goldMismatch} input(s) drifted from golden.json: re-port the engine or regenerate golden if lib/recommend.ts changed`);

// ── 3. Live parity vs the TS engine (monorepo only, best effort) ────────────
let tsOut = null;
try {
  const raw = execFileSync('npx', ['--no-install', 'tsx', 'cli/test/ts-driver.mts', JSON.stringify(GRID)], {
    cwd: REPO, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  tsOut = JSON.parse(raw);
} catch {
  console.log('· live TS parity skipped (standalone repo / tsx unavailable; golden snapshot is the guard here)');
}
if (tsOut) {
  let tsMismatch = 0;
  golden.forEach((g, gi) => {
    const ts = tsOut[gi] ?? { ranking: [], grouped: [] };
    if (!same(g.ranking, ts.ranking ?? []) || !sameIds(g.grouped, ts.grouped)) tsMismatch++;
  });
  if (!tsMismatch) console.log(`✓ exact parity with lib/recommend.ts (golden.json is current)`);
  else fail(`${tsMismatch} input(s): golden.json is STALE vs lib/recommend.ts. Run: node scripts/gen-golden.mjs`);
}

// ── 4. bestModel contract (the embeddable single-answer primitive) ──────────
{
  const SPECIALIST = ['coding', 'reasoning', 'translation'];
  const GENERAL = ['chat', 'mixed'];
  const general = (tags = []) =>
    tags.some((t) => GENERAL.includes(t)) || !tags.some((t) => SPECIALIST.includes(t));
  // capability must scale with the machine, and the pick must be a runnable, general model
  let prevSize = 0;
  for (const ram of [8, 16, 24, 48, 64]) {
    const m = bestModel({ ramGb: ram, chip: 'Apple M4 Max', deviceType: 'MacBook Pro' });
    if (!m) { fail(`bestModel(${ram}GB) returned null`); continue; }
    if (!m.ollamaCommand) fail(`bestModel(${ram}GB) ${m.name}: no ollamaCommand (must be locally runnable)`);
    if (m.localVerdict === 'cloud_only') fail(`bestModel(${ram}GB) returned a cloud-only model`);
    if (!general(DATASET.find((d) => d.id === m.id)?.tags)) fail(`bestModel(${ram}GB) ${m.name}: not general-purpose`);
    if (m.sizeB < prevSize) fail(`bestModel(${ram}GB) ${m.name} (${m.sizeB}B) smaller than the ${prevSize}B picked at less RAM`);
    prevSize = m.sizeB;
  }
  console.log('✓ bestModel: scales with RAM, always a runnable general-purpose model');
}

// ── 5. Chip strings named after Object.prototype members ────────────────────
// A --chip flag or a bench row such as 'constructor' must read as an unknown chip, never as a
// prototype member of the engine tables (that threw on the site, 2026-10-22).
{
  const names = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];
  for (const chip of names) {
    try {
      const recs = getRecommendations({ ...GRID[0], chip, ramGb: 16, gpuCores: 40 });
      const local = recs.find((r) => r.localVerdict !== 'cloud_only');
      if (local && local.estimatedTokensPerSec != null) fail(`chip "${chip}": got a speed estimate for an unknown chip`);
    } catch (e) {
      fail(`chip "${chip}": getRecommendations threw ${e}`);
    }
  }
  console.log('✓ prototype-named chips read as unknown chips');
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
