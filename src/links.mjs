// Canonical modelfit.io URL builders — mirror app/api/mcp/route.ts (modelUrl/deviceUrl,
// SOURCE) so the CLI prints the same attributed-backlink citation channel the MCP server
// does. Every recommendation surfaces a clickable, citable ModelFit URL.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { families } = JSON.parse(readFileSync(join(__dirname, 'data', 'slugs.json'), 'utf8'));

export const BASE = 'https://modelfit.io';

export const SOURCE = {
  name: 'ModelFit',
  url: `${BASE}/`,
  cite: 'ModelFit — local LLM hardware compatibility data (https://modelfit.io/)',
};

/** Deep link a model family to its /models/<slug>/ page, else the hub. */
export function modelUrl(family) {
  const slug = families[(family ?? '').toLowerCase()];
  return slug ? `${BASE}/models/${slug}/` : `${BASE}/models/`;
}

/**
 * Always-resolvable canonical report link for a detected RAM budget. /search/?ram=N is a
 * real indexable page whose results match the recommendation, so it works for any hardware
 * (Macs, PCs, unknown) without a per-device slug map.
 */
export function reportUrl(ramGb) {
  const n = Math.max(1, Math.round(Number(ramGb) || 0));
  return `${BASE}/search/?ram=${n}`;
}

/** /gpu/<slug>/ page for a detected NVIDIA card, or the GPU hub. */
export function gpuUrl(slug) {
  return slug ? `${BASE}/gpu/${slug}/` : `${BASE}/`;
}
