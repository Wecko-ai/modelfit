// Engine guard. Three layers, all offline-safe:
//  1. Structural sanity on the JS engine (always).
//  2. Golden-snapshot parity — asserts the engine reproduces test/golden.json
//     (the committed source of truth; works in the standalone repo with no TS around).
//  3. Live parity vs lib/recommend.ts via tsx — only when the monorepo is present;
//     this is what keeps golden.json honest. Re-generate golden via scripts/gen-golden.mjs.
// Run: node test/parity.mjs   (or npm test)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { getRecommendations } from '../src/engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

const golden = JSON.parse(readFileSync(join(__dirname, 'golden.json'), 'utf8'));
const GRID = golden.map((g) => g.input);

let failures = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); failures++; };
const same = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id && Math.abs(x.score - b[i].score) <= 0.01);

// ── 1. Structural sanity ────────────────────────────────────────────────────
for (const input of GRID) {
  const recs = getRecommendations(input);
  const tag = `${input.chip} / ${input.ramGb}GB`;
  if (recs.length !== 83) fail(`${tag}: expected 83 ranked models, got ${recs.length}`);
  for (let i = 1; i < recs.length; i++) {
    if (recs[i - 1].score < recs[i].score) { fail(`${tag}: not sorted desc at ${i}`); break; }
  }
  for (const k of ['id', 'name', 'score', 'fitLevel', 'localVerdict', 'why']) {
    if (recs[0][k] === undefined) fail(`${tag}: top pick missing "${k}"`);
  }
}
console.log(`✓ structural sanity passed (${GRID.length} inputs × 83 models)`);

// ── 2. Golden-snapshot parity (offline source of truth) ─────────────────────
let goldMismatch = 0;
golden.forEach((g, gi) => {
  const got = getRecommendations(g.input).map((r) => ({ id: r.id, score: r.score }));
  if (!same(got, g.ranking)) {
    goldMismatch++;
    if (goldMismatch <= 5) fail(`golden[${gi}] (${g.input.chip}/${g.input.ramGb}GB): engine output differs from test/golden.json`);
  }
});
if (!goldMismatch) console.log(`✓ matches golden snapshot (${golden.length} inputs, ranking + scores)`);
else fail(`${goldMismatch} input(s) drifted from golden.json — re-port the engine or regenerate golden if lib/recommend.ts changed`);

// ── 3. Live parity vs the TS engine (monorepo only, best effort) ────────────
let tsOut = null;
try {
  const raw = execFileSync('npx', ['--no-install', 'tsx', 'cli/test/ts-driver.mts', JSON.stringify(GRID)], {
    cwd: REPO, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  tsOut = JSON.parse(raw);
} catch {
  console.log('· live TS parity skipped (standalone repo / tsx unavailable — golden snapshot is the guard here)');
}
if (tsOut) {
  let tsMismatch = 0;
  golden.forEach((g, gi) => { if (!same(g.ranking, tsOut[gi] ?? [])) tsMismatch++; });
  if (!tsMismatch) console.log(`✓ exact parity with lib/recommend.ts (golden.json is current)`);
  else fail(`${tsMismatch} input(s): golden.json is STALE vs lib/recommend.ts — run: node scripts/gen-golden.mjs`);
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
