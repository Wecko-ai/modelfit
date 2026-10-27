// The pre-download notice of `modelfit bench`. (Until 1.6.1 this file also tested the parser of
// `ollama run --verbose`; 1.7.0 reads Ollama's API counters instead, see test/bench-v2.mjs.)
import assert from 'node:assert/strict';

// It states the real size when the bundled catalog knows the tag (the registry
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
assert.match(unknown, /downloading the model someone\/unlisted-model:7b, then running 3 fixed prompts\./);
assert.doesNotMatch(unknown, /GB/);
assert.equal(knownPullGb('someone/unlisted-model:7b'), null);
// nothing is downloaded when the model is already local or --no-pull is set: no size either
assert.doesNotMatch(benchNotice(BENCH_MODEL, { ...fresh, preexisting: true }), /GB/);
assert.doesNotMatch(benchNotice(BENCH_MODEL, { ...fresh, noPull: true }), /GB/);

console.log('✓ bench notice states the real download size or none');
