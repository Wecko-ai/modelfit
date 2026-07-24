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

const repo = findRepo();
if (!repo) {
  console.log('· No modelfit checkout found — keeping the committed snapshot (canonical data in this repo).');
  console.log('  Point at a checkout with MODELFIT_REPO=/path/to/modelfit to refresh.');
  process.exit(0);
}
syncModels(repo);
syncSlugs(repo);
console.log('Sync complete.');
