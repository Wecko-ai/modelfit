// Regenerate test/golden.json: the offline source-of-truth ranking snapshot the parity
// test guards against. Run this whenever the engine or model DB legitimately changes
// (after re-porting lib/recommend.ts), then re-run `npm test` to confirm live TS parity.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getRecommendations } from '../src/engine.mjs';
import { groupVariants } from '../src/model-groups.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GRID = [
  { deviceType: 'MacBook Air', chip: 'Apple M1', ramGb: 8, priority: 'Balanced', useCase: 'Mixed' },
  { deviceType: 'MacBook Pro', chip: 'Apple M4', ramGb: 16, priority: 'Balanced', useCase: 'Coding' },
  { deviceType: 'MacBook Pro', chip: 'Apple M4 Pro', ramGb: 48, priority: 'Quality', useCase: 'Coding' },
  { deviceType: 'Mac Studio', chip: 'Apple M2 Ultra', ramGb: 192, priority: 'Speed', useCase: 'Chat' },
  { deviceType: 'Mac Studio', chip: 'Apple M3 Ultra', ramGb: 512, priority: 'Quality', useCase: 'Mixed' },
  { deviceType: 'Mac Mini', chip: 'Apple M4', ramGb: 24, priority: 'Balanced', useCase: 'Translation' },
  { deviceType: 'iPhone 16 Pro', chip: 'Apple A18 Pro', ramGb: 8, priority: 'Speed', useCase: 'Chat' },
  { deviceType: 'Linux PC', chip: 'Unknown', ramGb: 24, priority: 'Balanced', useCase: 'Coding' },
  // Chip bins (DECODE_VARIANTS): RAM-tied low bins, RAM-tied bandwidth, explicit gpuCores.
  { deviceType: 'Mac Studio', chip: 'Apple M5 Max', ramGb: 36, priority: 'Balanced', useCase: 'Mixed' },
  { deviceType: 'MacBook Pro', chip: 'Apple M4 Max', ramGb: 36, priority: 'Balanced', useCase: 'Coding' },
  { deviceType: 'MacBook Pro', chip: 'Apple M3 Max', ramGb: 96, priority: 'Quality', useCase: 'Mixed' },
  { deviceType: 'Mac Mini', chip: 'Apple M6', ramGb: 32, priority: 'Balanced', useCase: 'Mixed' },
  { deviceType: 'MacBook Pro', chip: 'Apple M1 Max', ramGb: 32, priority: 'Balanced', useCase: 'Chat', gpuCores: 24 },
  { deviceType: 'Mac Studio', chip: 'Apple M2 Ultra', ramGb: 64, priority: 'Speed', useCase: 'Mixed', gpuCores: 60 },
  { deviceType: 'Mac Mini', chip: 'Apple M5 Pro', ramGb: 24, priority: 'Balanced', useCase: 'Mixed', gpuCores: 16 },
];

const golden = GRID.map((input) => {
  const recs = getRecommendations(input);
  return {
    input,
    ranking: recs.map((r) => ({ id: r.id, score: r.score, tps: r.estimatedTokensPerSec })),
    grouped: groupVariants(recs).map((r) => r.id),
  };
});

writeFileSync(join(__dirname, '..', 'test', 'golden.json'), JSON.stringify(golden, null, 0) + '\n');
console.log(`✓ wrote test/golden.json (${golden.length} inputs × ${golden[0].ranking.length} models)`);
