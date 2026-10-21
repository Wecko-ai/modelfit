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

// The pre-download notice states the real size when the bundled catalog knows the tag (the registry
// manifest's model layer), names no size otherwise, and never claims "about 1 GB" for every model.
import { BENCH_MODEL, benchNotice, knownPullGb } from '../src/bench.mjs';

const fresh = { preexisting: false, cleanup: false, noPull: false };
const refGb = knownPullGb(BENCH_MODEL);
assert.ok(refGb > 0.9 && refGb < 1.1, `reference model manifest size, got ${refGb}`);
const refNotice = benchNotice(BENCH_MODEL, fresh);
assert.match(refNotice, /downloading the reference model qwen2\.5:1\.5b-instruct-q4_K_M \(0\.99 GB\)/);
// a bigger catalog tag shows its own size, not 1 GB
const big = benchNotice('nemotron-3.5-lightning:30b', fresh);
assert.match(big, /downloading the model nemotron-3\.5-lightning:30b \(25\.4 GB\)/);
assert.doesNotMatch(big, /about 1 GB/);
// a tag the catalog does not list gets no size at all
const unknown = benchNotice('someone/unlisted-model:7b', fresh);
assert.match(unknown, /downloading the model someone\/unlisted-model:7b, then running one fixed prompt\./);
assert.doesNotMatch(unknown, /GB/);
assert.equal(knownPullGb('someone/unlisted-model:7b'), null);
// nothing is downloaded when the model is already local or --no-pull is set: no size either
assert.doesNotMatch(benchNotice(BENCH_MODEL, { ...fresh, preexisting: true }), /GB/);
assert.doesNotMatch(benchNotice(BENCH_MODEL, { ...fresh, noPull: true }), /GB/);

console.log('✓ bench notice states the real download size or none');
