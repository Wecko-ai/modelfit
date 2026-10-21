// Faithful JavaScript port of lib/model-groups.ts: quant variants of one model, grouped for ranked
// lists (one row per base model, the best-ranked build that runs, the other builds attached).
// Keep them in sync: test/parity.mjs compares the grouped lists of both.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS = JSON.parse(readFileSync(join(__dirname, 'data', 'models.json'), 'utf8'));

/** Quant suffix of an id: the same rule that folds quant siblings onto one model page. */
const ID_QUANT_SUFFIX = /-(q[0-9][a-z0-9_]*|mxfp4|fp16|cloud)$/i;
/** Quant tag at the end of a display name: "Qwen3.5 9B Instruct (Q8)", "... (IQ4_XS)". */
const NAME_QUANT_SUFFIX = /\s*\((?:I?Q[0-9][A-Z0-9_]*|MXFP4|FP16|BF16)\)\s*$/i;

const slugOf = (id) => id.replace(ID_QUANT_SUFFIX, '');
const nameKey = (r) => `${r.family}|${r.name.replace(NAME_QUANT_SUFFIX, '').trim().toLowerCase()}`;

// A few quant rows have an id that does not reduce to their sibling's: "qwen3-30b-a3b-q8" is
// "Qwen3 30B (Q8)", the Q8 build of qwen3-30b-q4. They fold through their display name.
const ALIAS = (() => {
  const byName = new Map();
  for (const r of MODELS) {
    if (!NAME_QUANT_SUFFIX.test(r.name) && !byName.has(nameKey(r))) byName.set(nameKey(r), slugOf(r.id));
  }
  const out = new Map();
  for (const r of MODELS) {
    if (!NAME_QUANT_SUFFIX.test(r.name)) continue;
    const base = byName.get(nameKey(r));
    if (base && base !== slugOf(r.id)) out.set(r.id, base);
  }
  return out;
})();

/** The base model a catalog row belongs to, shared by all its quant rows. */
export function baseModelId(row) {
  return ALIAS.get(row.id) ?? slugOf(row.id);
}

/**
 * One row per base model, engine order kept. The row kept for a model is its best-ranked build that
 * runs comfortably (localVerdict 'local_feasible'), else its best-ranked build; the other builds
 * ride along in `variants`, sorted by score.
 */
export function groupVariants(recs) {
  const byBase = new Map();
  for (const r of recs) {
    const k = baseModelId(r);
    const list = byBase.get(k);
    if (list) list.push(r);
    else byBase.set(k, [r]);
  }
  const keep = new Map();
  for (const [k, list] of byBase) keep.set(k, list.find((r) => r.localVerdict === 'local_feasible') ?? list[0]);
  const out = [];
  for (const r of recs) {
    const k = baseModelId(r);
    if (keep.get(k) !== r) continue;
    const variants = byBase.get(k).filter((v) => v !== r).sort((a, b) => b.score - a.score);
    out.push({ ...r, variants });
  }
  return out;
}
