// Regenerate test/golden.json — the offline source-of-truth ranking snapshot the parity
// test guards against. Run this whenever the engine or model DB legitimately changes
// (after re-porting lib/recommend.ts), then re-run `npm test` to confirm live TS parity.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getRecommendations } from '../src/engine.mjs';

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
];

const golden = GRID.map((input) => ({
  input,
  ranking: getRecommendations(input).map((r) => ({ id: r.id, score: r.score })),
}));

writeFileSync(join(__dirname, '..', 'test', 'golden.json'), JSON.stringify(golden, null, 0) + '\n');
console.log(`✓ wrote test/golden.json (${golden.length} inputs × ${golden[0].ranking.length} models)`);
