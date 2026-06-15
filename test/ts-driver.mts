// Runs the canonical TS engine (lib/recommend.ts) for a grid of inputs so parity.mjs can
// diff the JS port against it. Invoked via `npx tsx cli/test/ts-driver.mts '<grid-json>'`
// from the repo root (tsx resolves the @/ alias from tsconfig.json there).
import { getRecommendations, type HardwareInput } from '../../lib/recommend';

const grid: HardwareInput[] = JSON.parse(process.argv[2] ?? '[]');
const out = grid.map((input) =>
  getRecommendations(input).map((r) => ({ id: r.id, score: r.score }))
);
process.stdout.write(JSON.stringify(out));
