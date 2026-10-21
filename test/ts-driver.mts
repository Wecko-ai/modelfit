// Runs the canonical TS engine (lib/recommend.ts) for a grid of inputs so parity.mjs can
// diff the JS port against it. Invoked via `npx tsx cli/test/ts-driver.mts '<grid-json>'`
// from the repo root (tsx resolves the @/ alias from tsconfig.json there).
import { getRecommendations, type HardwareInput } from '../../lib/recommend';
import { groupVariants } from '../../lib/model-groups';

const grid: HardwareInput[] = JSON.parse(process.argv[2] ?? '[]');
const out = grid.map((input) => {
  const recs = getRecommendations(input);
  return {
    ranking: recs.map((r) => ({ id: r.id, score: r.score, tps: r.estimatedTokensPerSec })),
    // One row per model, as ranked lists show it (lib/model-groups.ts groupVariants).
    grouped: groupVariants(recs).map((r) => r.id),
  };
});
process.stdout.write(JSON.stringify(out));
