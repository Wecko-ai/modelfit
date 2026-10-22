// Refresh the bundled data snapshot. Resolves a source in this order:
//   1. $MODELFIT_REPO/data/models.json           (explicit path to a modelfit checkout)
//   2. ../modelfit/data/models.json or ../../data (sibling / parent monorepo checkout)
//   3. otherwise: keep the committed snapshot (this is the canonical data in the
//      standalone repo — it ships CC BY 4.0 and works fully offline).
// Family slugs come from lib/model-families.ts when a checkout is found, else the
// committed src/data/slugs.json is kept (it changes rarely).

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'src', 'data');

/** Find a modelfit web-app checkout, or null if running standalone. */
function findRepo() {
  const candidates = [
    process.env.MODELFIT_REPO,
    resolve(__dirname, '..', '..'),            // cli/ inside the monorepo
    resolve(__dirname, '..', '..', 'modelfit'), // sibling checkout
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'data', 'models.json'))) return c;
  }
  return null;
}

function syncModels(repo) {
  const src = join(repo, 'data', 'models.json');
  const data = JSON.parse(readFileSync(src, 'utf8')); // parse
  validateModels(data, src); // validate content before it can ship (CWE-20/345)
  console.log(`· source: ${src}`);
  copyFileSync(src, join(OUT, 'models.json'));
  const n = JSON.parse(readFileSync(join(OUT, 'models.json'), 'utf8')).length;
  console.log(`✓ models.json synced from ${repo} (${n} models)`);
}

// Content validation for the synced dataset — JSON.parse alone only checks syntax.
const OLLAMA_CMD_RE = /^ollama (run|pull) [a-z0-9][a-z0-9._:\/-]+$/i;
const CONTROL_RE = /[\x00-\x1f\x7f]/;

function invalid(msg, src) {
  console.error(`✗ models.json failed validation: ${msg}`);
  console.error(`  source: ${src}`);
  process.exit(1);
}

function validateModels(data, src) {
  if (!Array.isArray(data) || data.length < 1 || data.length > 1000) {
    invalid(`expected a non-empty array of 1-1000 models, got ${Array.isArray(data) ? data.length : typeof data}`, src);
  }
  data.forEach((m, i) => {
    const where = `entry #${i} (${typeof m?.name === 'string' ? m.name : 'unnamed'})`;
    if (typeof m?.name !== 'string') invalid(`${where}: missing string "name"`, src);
    if (m.ollamaCommand != null) {
      if (typeof m.ollamaCommand !== 'string') invalid(`${where}: "ollamaCommand" must be a string`, src);
      if (!OLLAMA_CMD_RE.test(m.ollamaCommand)) invalid(`${where}: unsafe "ollamaCommand": ${JSON.stringify(m.ollamaCommand)}`, src);
    }
    for (const key of ['name', 'bestFor', 'why']) {
      if (typeof m[key] === 'string' && CONTROL_RE.test(m[key])) {
        invalid(`${where}: control character in "${key}"`, src);
      }
    }
  });
}

function syncSlugs(repo) {
  const tsPath = join(repo, 'lib', 'model-families.ts');
  if (!existsSync(tsPath)) { console.log('· slugs.json kept (lib/model-families.ts not found)'); return; }
  const ts = readFileSync(tsPath, 'utf8');
  const families = {};
  const re = /slug:\s*'([a-z0-9-]+)',\s*\n\s*name:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(ts))) {
    const [, slug, name] = m;
    if (!slug.includes('-') || slug === name.toLowerCase()) families[name.toLowerCase()] = slug;
  }
  if (!Object.keys(families).length) { console.log('· slugs.json kept (no family slugs parsed)'); return; }
  const body = {
    _comment:
      'Family name (lowercased) -> /models/<slug>/ page. Synced from lib/model-families.ts by scripts/sync-data.mjs. Families absent here fall back to /models/.',
    families,
  };
  writeFileSync(join(OUT, 'slugs.json'), JSON.stringify(body, null, 2) + '\n');
  console.log(`✓ slugs.json synced (${Object.keys(families).length} families)`);
}

/**
 * The speed model's generated inputs: data/derived/perf-fit.json (fitted constants) and
 * data/derived/model-perf.json (per-model physical inputs). Validated for shape: numbers only
 * where numbers belong, so a corrupted file cannot ship.
 */
function syncPerf(repo) {
  for (const name of ['perf-fit.json', 'model-perf.json']) {
    const src = join(repo, 'data', 'derived', name);
    if (!existsSync(src)) { console.log(`· ${name} kept (data/derived/${name} not found)`); continue; }
    const data = JSON.parse(readFileSync(src, 'utf8'));
    if (name === 'perf-fit.json') {
      const ok = data?.decode && typeof data.decode.alpha === 'number' && data.decode.eta && data.prefill && data.bands;
      if (!ok) invalid(`${name}: missing decode/prefill/bands sections`, src);
    } else {
      const ok = data?.models && Object.values(data.models).every((m) => typeof m.weightsGb === 'number' && typeof m.streamedGb === 'number' && m.kv && typeof m.kv.fullBytesPerToken === 'number');
      if (!ok) invalid(`${name}: a model lacks numeric weightsGb, streamedGb or kv`, src);
    }
    copyFileSync(src, join(OUT, name));
    console.log(`✓ ${name} synced`);
  }
}

/**
 * GPU core bins per Apple chip, for the engine's prompt-reading core count (prefillGpuCores):
 * every known bin (lib/chip-bins.ts CHIP_BINS plus lib/prefill.ts PP512_Q4_0) and the top
 * measured bin (the last PP512_Q4_0 row, what prefillBasis(chip) returns). Parsed from the TS
 * source so the CLI never carries a hand copy; validated before it is written.
 */
function tableBlock(ts, name, path) {
  const start = ts.indexOf(`export const ${name}`);
  const end = start < 0 ? -1 : ts.indexOf('\n};', start);
  if (start < 0 || end < 0) invalid(`${name} not found`, path);
  const out = {};
  const re = /'(Apple [A-Za-z0-9 ]+)':\s*\[([^\]]*)\]/g;
  const body = ts.slice(start, end);
  let m;
  while ((m = re.exec(body))) {
    const cores = [...m[2].matchAll(/gpuCores:\s*(\d+)/g)].map((x) => Number(x[1]));
    if (!cores.length) invalid(`${name}: no gpuCores for ${m[1]}`, path);
    out[m[1]] = cores;
  }
  return out;
}

function syncGpuBins(repo) {
  const prefillPath = join(repo, 'lib', 'prefill.ts');
  const binsPath = join(repo, 'lib', 'chip-bins.ts');
  if (!existsSync(prefillPath) || !existsSync(binsPath)) { console.log('· gpu-bins.json kept (lib/prefill.ts or lib/chip-bins.ts not found)'); return; }
  const measured = tableBlock(readFileSync(prefillPath, 'utf8'), 'PP512_Q4_0', prefillPath);
  const orderable = tableBlock(readFileSync(binsPath, 'utf8'), 'CHIP_BINS', binsPath);
  const chips = {};
  for (const chip of Object.keys({ ...measured, ...orderable }).sort()) {
    const rows = measured[chip] ?? [];
    for (let i = 1; i < rows.length; i++) if (rows[i] <= rows[i - 1]) invalid(`PP512_Q4_0: ${chip} rows not ascending`, prefillPath);
    const bins = [...new Set([...(orderable[chip] ?? []), ...rows])].sort((a, b) => a - b);
    if (!bins.every((n) => Number.isInteger(n) && n > 0 && n <= 256)) invalid(`gpu-bins: bad core count for ${chip}`, prefillPath);
    chips[chip] = { bins, top: rows.length ? rows[rows.length - 1] : null };
  }
  if (Object.keys(chips).length < 10) invalid(`gpu-bins: only ${Object.keys(chips).length} chips parsed`, prefillPath);
  const body = {
    _comment:
      'GPU core bins per Apple chip: bins = lib/chip-bins.ts CHIP_BINS plus lib/prefill.ts PP512_Q4_0, top = the last PP512_Q4_0 row. Generated by scripts/sync-data.mjs, never hand-edited.',
    chips,
  };
  writeFileSync(join(OUT, 'gpu-bins.json'), JSON.stringify(body, null, 2) + '\n');
  console.log(`✓ gpu-bins.json synced (${Object.keys(chips).length} chips)`);
}

const repo = findRepo();
if (!repo) {
  console.log('· No modelfit checkout found — keeping the committed snapshot (canonical data in this repo).');
  console.log('  Point at a checkout with MODELFIT_REPO=/path/to/modelfit to refresh.');
  process.exit(0);
}
syncModels(repo);
syncSlugs(repo);
syncPerf(repo);
syncGpuBins(repo);
console.log('Sync complete.');
