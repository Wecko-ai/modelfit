// Regression test for parseVerboseStats (bug fixed in 1.5.2): `ollama run --verbose`
// prints the prefill line ("prompt eval rate") BEFORE the generation line
// ("eval rate"). The old unanchored regex returned the prefill rate.
// Fixture = real output captured on an Apple M4 16GB, ollama 0.30.8, 2026-10-03.
import assert from 'node:assert/strict';
import { parseVerboseStats } from '../src/bench.mjs';

const OUTPUT = `The sky appears blue due to Rayleigh scattering.

total duration:       1.204551s
load duration:        98.412ms
prompt eval count:    41 token(s)
prompt eval duration: 67.682ms
prompt eval rate:     605.77 tokens/s
eval count:           48 token(s)
eval duration:        625.802ms
eval rate:            76.70 tokens/s
`;

const stats = parseVerboseStats(OUTPUT);
assert.equal(stats.evalTokensPerSec, 76.7, 'must read the generation rate, not the prefill rate');
assert.equal(stats.loadMs, 98);

// Seconds unit and missing lines.
assert.equal(parseVerboseStats('load duration: 1.5s\neval rate: 12.34 tokens/s').loadMs, 1500);
assert.equal(parseVerboseStats('prompt eval rate: 500 tokens/s').evalTokensPerSec, null);
assert.equal(parseVerboseStats('').evalTokensPerSec, null);

console.log('✓ bench parser reads the generation rate (not prefill)');
