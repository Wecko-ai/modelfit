// modelfit bench v2 (promptId modelfit-bench-v2): NDJSON streaming, run validity and the single
// retry, medians, the payload against submission contract v2 (docs/plan-speed-test-2026-10.md in
// the site repo), the local-only Ollama host, the ladder picks, and the submit round trip against
// a local server. No real Ollama and no network beyond 127.0.0.1.
import assert from 'node:assert/strict';
import http from 'node:http';
import { getRecommendations } from '../src/engine.mjs';
import { parseNvidiaSmi } from '../src/detect.mjs';
import { ollamaHost, parseNdjson, ndjsonSplitter, ollamaClient } from '../src/ollama-api.mjs';
import { BENCH_PROMPTS, WARMUP_PROMPT } from '../src/bench-prompts.mjs';
import {
  BENCH_PROMPT_ID, BENCH_OPTIONS, HANDLE_RE, toRun, benchMedians, measureRuns, buildPayload, ollamaBlock,
  loadWarnings, normalizeHandle, normalizeTag, benchChoices, submitBench, submitRefusal, catalogRowForTag,
  renderBench, bigNumber, describeSubmission,
} from '../src/bench.mjs';

// NDJSON: objects split across chunks, a last line without newline, blank lines.
{
  const seen = [];
  const s = ndjsonSplitter((o) => seen.push(o));
  s.push('{"response":"He');
  s.push('llo"}\n\n{"response":" world"}\n{"done":true,');
  s.push('"eval_count":200}');
  s.end();
  assert.deepEqual(seen, [{ response: 'Hello' }, { response: ' world' }, { done: true, eval_count: 200 }]);
  assert.equal(parseNdjson('{"a":1}\n{"a":2}\n').length, 2);
  assert.throws(() => parseNdjson('{"a":1}\nnot json\n'));
}
console.log('✓ NDJSON split across chunks');

// Run validity: 128 generated tokens or more, positive durations.
const final = (evalCount, { evalNs = 4e9, promptCount = 500, promptNs = 1e9 } = {}) => ({
  done: true, eval_count: evalCount, eval_duration: evalNs, prompt_eval_count: promptCount, prompt_eval_duration: promptNs, load_duration: 5e8,
});
assert.equal(toRun(final(127)), null);
assert.deepEqual(toRun(final(128)), { evalCount: 128, evalDurationNs: 4e9, promptEvalCount: 500, promptEvalDurationNs: 1e9 });
assert.equal(toRun({ ...final(200), eval_duration: 0 }), null);
assert.equal(toRun({ ...final(200), eval_duration: undefined }), null);
assert.equal(toRun(null), null);
console.log('✓ a run counts from 128 generated tokens');

// The spare prompt is used once, for the first short run only.
{
  const script = async (counts) => {
    const used = [];
    const res = await measureRuns(async (p) => {
      used.push(BENCH_PROMPTS.indexOf(p));
      return final(counts[used.length - 1]);
    });
    return { ...res, used };
  };
  let r = await script([256, 256, 256]);
  assert.equal(r.runs.length, 3);
  assert.deepEqual(r.used, [0, 1, 2]);
  r = await script([256, 40, 256, 256]);
  assert.equal(r.runs.length, 3);
  assert.deepEqual(r.used, [0, 1, 2, 3]);
  r = await script([40, 40, 256, 256]);
  assert.equal(r.runs.length, 2);
  assert.equal(r.attempts, 4);
  r = await script([40, 40, 40, 40]);
  assert.equal(r.runs.length, 0);
  assert.equal(r.attempts, 4);
}
console.log('✓ one retry with the spare prompt');

// Medians, prefill only from runs with 256+ prompt tokens.
{
  const runs = [toRun(final(256, { evalNs: 4e9 })), toRun(final(256, { evalNs: 2e9 })), toRun(final(256, { evalNs: 8e9 }))];
  assert.deepEqual(benchMedians(runs), { evalTokensPerSec: 64, prefillTokensPerSec: 500 });
  const cached = [toRun(final(200, { promptCount: 12 })), toRun(final(200, { promptCount: 100 }))];
  assert.equal(benchMedians(cached).prefillTokensPerSec, null);
  assert.equal(benchMedians([toRun(final(200, { evalNs: 2e9 })), toRun(final(200, { evalNs: 4e9 }))]).evalTokensPerSec, 75);
}
console.log('✓ decode and prefill medians');

// Prompts: four distinct first words, the warm-up apart, all of them long.
assert.equal(BENCH_PROMPTS.length, 4);
assert.equal(new Set(BENCH_PROMPTS.map((p) => p.split(/\s+/)[0])).size, 4);
assert.ok(!BENCH_PROMPTS.includes(WARMUP_PROMPT));
for (const p of BENCH_PROMPTS) assert.ok(p.split(/\s+/).length > 330, 'about 500 tokens');
assert.deepEqual({ ...BENCH_OPTIONS }, { num_ctx: 4096, num_predict: 256, temperature: 0, seed: 42 });
console.log('✓ fixed prompts and sampling');

// Payload against contract v2 (the server's rules, checked here so a CLI change cannot drift).
const ps = [{
  name: 'qwen3.5:4b', model: 'qwen3.5:4b', size: 4200000000, size_vram: 4200000000, context_length: 4096,
  digest: '2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b', details: { quantization_level: 'Q4_K_M' },
}];
const hardware = { chip: 'Apple M4', ramGb: 16, gpuCores: 10, accelerator: { kind: 'unified', name: 'Apple M4' } };
const runs = [toRun(final(256)), toRun(final(256, { evalNs: 3e9 })), toRun(final(256, { evalNs: 5e9 }))];
const payload = buildPayload({
  tag: 'qwen3.5:4b', version: '1.7.0', hardware, handle: normalizeHandle('@modelfit_'),
  ollama: ollamaBlock({ version: '0.40.6', loaded: ps[0], show: null }), runs, loadMs: 812, timestamp: '2026-10-27T10:00:00.000Z',
});
{
  assert.deepEqual(Object.keys(payload), [
    'tool', 'toolVersion', 'promptId', 'model', 'hardware', 'handle', 'ollama', 'runs', 'evalTokensPerSec', 'prefillTokensPerSec', 'loadMs', 'timestamp',
  ]);
  assert.equal(payload.tool, 'modelfit');
  assert.equal(payload.promptId, BENCH_PROMPT_ID);
  assert.equal(payload.promptId, 'modelfit-bench-v2');
  assert.equal(payload.handle, 'modelfit_');
  assert.deepEqual(payload.ollama, { version: '0.40.6', quant: 'Q4_K_M', digest: '2a3b4c5d6e7f', sizeBytes: 4200000000, vramBytes: 4200000000, contextLength: 4096 });
  assert.ok(payload.runs.length >= 2 && payload.runs.length <= 4);
  for (const r of payload.runs) {
    assert.deepEqual(Object.keys(r), ['evalCount', 'evalDurationNs', 'promptEvalCount', 'promptEvalDurationNs']);
    assert.ok(Number.isInteger(r.evalCount) && r.evalCount >= 128 && r.evalCount <= 4096);
    for (const d of [r.evalDurationNs, r.promptEvalDurationNs]) assert.ok(Number.isInteger(d) && d > 0 && d < 600e9);
    assert.ok(Number.isInteger(r.promptEvalCount) && r.promptEvalCount >= 0 && r.promptEvalCount <= 65536);
  }
  assert.equal(payload.evalTokensPerSec, 64);
  assert.ok(catalogRowForTag(payload.model), 'model is a catalog tag');
  // No handle: the key is absent, not null.
  assert.ok(!('handle' in buildPayload({ tag: 'qwen3.5:4b', hardware, ollama: {}, runs })));
  // The runner (Ollama 0.40+ /api/ps) rides along when present.
  assert.equal(ollamaBlock({ loaded: { ...ps[0], runner: 'mlx' } }).runner, 'mlx');
  assert.equal(ollamaBlock({ loaded: { ...ps[0], runner: 'm l x' } }).runner, undefined);
  // Malformed ollama fields are dropped.
  assert.deepEqual(ollamaBlock({ version: 'x'.repeat(41), loaded: { digest: 'zz', size: -1, size_vram: 1.5, details: { quantization_level: 'Q4 K M' } } }), {});
}
console.log('✓ payload matches submission contract v2');

// Handles, tags, catalog.
assert.equal(normalizeHandle(''), null);
assert.equal(normalizeHandle(undefined), null);
assert.equal(normalizeHandle('you'), 'you');
for (const bad of ['@', 'a'.repeat(16), 'we cko', '@we-cko', '<script>']) assert.throws(() => normalizeHandle(bad), bad);
assert.ok(HANDLE_RE.test('@A_1'));
assert.equal(normalizeTag('llama3'), 'llama3:latest');
assert.equal(normalizeTag('qwen3.5:4b'), 'qwen3.5:4b');
assert.equal(normalizeTag('hf.co/org/model'), 'hf.co/org/model:latest');
assert.equal(normalizeTag('localhost:5000/model'), 'localhost:5000/model:latest');
assert.equal(submitRefusal('qwen3.8:27b'), null);
assert.equal(submitRefusal('someone/unlisted-model:7b'), 'not-in-catalog');
console.log('✓ handles, :latest tags and the catalog gate');

// The Ollama host must be this machine.
{
  const local = (raw, hostname, port) => assert.deepEqual(ollamaHost(raw), { hostname, port }, String(raw));
  local(undefined, '127.0.0.1', 11434);
  local('', '127.0.0.1', 11434);
  local('127.0.0.1:11434', '127.0.0.1', 11434);
  local('localhost', 'localhost', 11434);
  local('http://localhost:11500', 'localhost', 11500);
  local('0.0.0.0', '127.0.0.1', 11434);
  local('0.0.0.0:8080', '127.0.0.1', 8080);
  local(':11500', '127.0.0.1', 11500);
  local('[::1]:11434', '::1', 11434);
  local('127.0.0.2', '127.0.0.2', 11434);
  for (const remote of ['192.168.1.10:11434', 'http://example.com', 'https://localhost:11434', '127.example.com', 'http://10.0.0.5']) {
    assert.equal(ollamaHost(remote).error, 'ollama-host-not-local', remote);
  }
  assert.throws(() => ollamaClient('192.168.1.10'), /not this machine/);
}
console.log('✓ OLLAMA_HOST must be local');

// Ladder picks: the first ladder model that fits (on a Mac, not Heavy).
{
  const first = (deviceType, chip, ramGb, isAppleSilicon = true) =>
    benchChoices(getRecommendations({ deviceType, chip, ramGb, priority: 'Balanced', useCase: 'Mixed' }), { isAppleSilicon }).ladder[0]?.tag;
  assert.equal(first('MacBook Pro', 'Apple M4', 16), 'qwen3.5:9b');
  assert.equal(first('MacBook Pro', 'Apple M4', 24), 'qwen3.5:9b');
  assert.equal(first('MacBook Pro', 'Apple M4 Pro', 48), 'qwen3.8:27b');
  assert.equal(first('MacBook Air', 'Apple M2', 8), 'qwen3.5:4b');
  // A 24 GB GPU holds the 27B (16.8 GB of weights); the Mac-only Heavy rule does not apply.
  assert.equal(first('NVIDIA GeForce RTX 4090', 'Unknown', 24, false), 'qwen3.8:27b');
  const c = benchChoices(getRecommendations({ deviceType: 'MacBook Pro', chip: 'Apple M4', ramGb: 16, priority: 'Balanced', useCase: 'Mixed' }), { isAppleSilicon: true });
  assert.ok(c.others.length > 0 && c.others.length <= 5);
  assert.ok(c.others.every((o) => !['qwen3.8:27b', 'qwen3.5:9b', 'qwen3.5:4b'].includes(o.tag)));
  assert.ok(Math.abs(c.ladder[0].pullGb - 5.63) < 0.01, 'manifest download size');
}
console.log('✓ ladder picks (M4 16 -> 9B, M4 24 -> 9B, M4 Pro 48 -> 27B, M2 8 -> 4B)');

// /api/ps checks warn, they never block.
{
  assert.deepEqual(loadWarnings(ps, 'qwen3.5:4b'), []);
  const offload = loadWarnings([{ ...ps[0], size_vram: 2100000000 }], 'qwen3.5:4b');
  assert.match(offload[0], /Only 2\.1 of 4\.2 GB/);
  const crowd = loadWarnings([...ps, { name: 'llama3:latest', size: 5e9, size_vram: 5e9 }], 'qwen3.5:4b');
  assert.match(crowd[0], /Other models are loaded in Ollama \(llama3:latest\)/);
  assert.match(loadWarnings([{ ...ps[0], context_length: 8192 }], 'qwen3.5:4b')[0], /8192-token context/);
}
console.log('✓ offload, context and loaded-model warnings');

assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 4090, 24564\n'), { name: 'NVIDIA GeForce RTX 4090', vramGb: 24, slug: 'rtx-4090', count: 2 });
assert.equal(parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288').count, 1);
assert.equal(parseNvidiaSmi(''), null);
console.log('✓ nvidia-smi GPU count');

// A local HTTP server plays Ollama (NDJSON stream) and the leaderboard (submit).
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.40.6' }));
    if (req.url === '/api/generate') {
      const parsed = JSON.parse(body);
      assert.equal(parsed.stream, true);
      assert.deepEqual(parsed.options, { ...BENCH_OPTIONS });
      assert.ok(!('think' in parsed));
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write('{"response":"A","done":false}\n{"response":"B",');
      setTimeout(() => res.end('"done":false}\n' + JSON.stringify(final(256)) + '\n'), 20);
      return undefined;
    }
    const sent = JSON.parse(body);
    if (req.url === '/listed/api/bench/submit') {
      res.writeHead(308, { Location: '/listed/api/bench/submit/' });
      return res.end();
    }
    if (req.url === '/auth/api/bench/submit/') {
      assert.equal(req.headers.authorization, `Basic ${Buffer.from('user:s3cret').toString('base64')}`);
      return res.end(JSON.stringify({ ok: true, id: 'abcdefgh23', path: '/r/abcdefgh23/', cardPath: '/r/abcdefgh23/card.png?v=1', listed: true, reason: null }));
    }
    if (req.url === '/listed/api/bench/submit/') {
      return res.end(JSON.stringify({ ok: true, id: 'abcdefgh23', path: '/r/abcdefgh23/', cardPath: '/r/abcdefgh23/card.png?v=1', listed: true, reason: null }));
    }
    if (req.url === '/unlisted/api/bench/submit/') {
      return res.end(JSON.stringify({ ok: true, id: 'abcdefgh23', path: null, cardPath: null, listed: false, reason: 'above-ceiling' }));
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: `Invalid model ${sent.model}.` }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
try {
  const client = ollamaClient(`127.0.0.1:${port}`);
  assert.equal(await client.version(), '0.40.6');
  let tokens = 0;
  const done = await client.generate({ model: 'qwen3.5:4b', prompt: 'x', options: BENCH_OPTIONS }, { onToken: () => { tokens++; } });
  assert.equal(tokens, 2);
  assert.equal(done.eval_count, 256);
  console.log('✓ streamed generation resolves the final counters');

  const base = `http://127.0.0.1:${port}`;
  const listed = await submitBench(payload, { url: `${base}/listed/api/bench/submit/` });
  assert.deepEqual(listed, { submitted: true, listed: true, id: 'abcdefgh23', reason: null, link: `${base}/r/abcdefgh23/` });
  const redirected = await submitBench(payload, { url: `${base}/listed/api/bench/submit` });
  assert.equal(redirected.link, `${base}/r/abcdefgh23/`, 'follows one 308 to the trailing slash');
  const authed = await submitBench(payload, { url: `http://user:s3cret@127.0.0.1:${port}/auth/api/bench/submit/` });
  assert.equal(authed.link, `${base}/r/abcdefgh23/`, 'basic auth sent, never printed back');
  const unlisted = await submitBench(payload, { url: `${base}/unlisted/api/bench/submit/` });
  assert.equal(unlisted.listed, false);
  assert.equal(unlisted.reason, 'above-ceiling');
  assert.equal(unlisted.link, null);
  const refused = await submitBench(payload, { url: `${base}/refuse/` });
  assert.equal(refused.submitted, false);
  assert.match(refused.submitError, /^HTTP 400: Invalid model qwen3\.5:4b\./);
  const offCatalog = await submitBench({ ...payload, model: 'someone/unlisted-model:7b' }, { url: `${base}/listed/api/bench/submit/` });
  assert.equal(offCatalog.submitted, false);
  assert.match(offCatalog.submitError, /not a ModelFit-validated model/);
  console.log('✓ submit: listed link on the posted origin, unlisted reason, refusals');
} finally {
  server.close();
}

// The result card: no ANSI codes without color, big digits in a terminal.
{
  const result = { ok: true, payload, warnings: [], submitted: true, listed: true, link: 'https://modelfit.io/r/abcdefgh23/' };
  const plain = renderBench(result, { color: false });
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(plain, /\x1b\[/);
  assert.match(plain, /tok\/s/);
  assert.match(plain, /Qwen3\.5 4B/);
  assert.match(plain, /median of 3 runs · Ollama 0\.40\.6 · 4k context · 2026-10-27/);
  assert.match(plain, /https:\/\/modelfit\.io\/r\/abcdefgh23\//);
  assert.match(plain, /@modelfit_/);
  assert.deepEqual(bigNumber('64'), ['█▀▀ █ █', '█▀█ ▀▀█', '▀▀▀   ▀']);
  const lines = plain.split('\n').filter((l) => l.startsWith('│'));
  assert.equal(new Set(lines.map((l) => l.length)).size, 1, 'box lines line up');
  assert.match(renderBench(result, { color: false, big: false }), /64 tok\/s/);
  const sent = describeSubmission(payload, { url: 'https://modelfit.io/api/bench/submit/' }).join('\n');
  assert.match(sent, /Sent to modelfit\.io/);
  assert.match(sent, /digest 2a3b4c5d6e7f/);
  assert.match(sent, /@modelfit_/);
}
console.log('✓ result card');

// X share link: the result line, the result page as the link and via @modelfit_, nothing else.
{
  const { xShareUrl } = await import('../src/bench.mjs');
  const url = new URL(xShareUrl({
    model: 'qwen3.8:27b',
    evalTokensPerSec: 43,
    hardware: { deviceType: 'Mac Studio', chip: 'Apple M2 Ultra', ramGb: 128 },
  }, 'https://modelfit.io/r/pquamsn5ih/'));
  assert.equal(url.origin + url.pathname, 'https://x.com/intent/post');
  assert.equal(url.searchParams.get('via'), 'modelfit_');
  assert.equal(url.searchParams.get('url'), 'https://modelfit.io/r/pquamsn5ih/');
  assert.equal(url.searchParams.get('text'), 'Qwen3.8 27B: 43.0 tok/s on my Mac Studio Apple M2 Ultra 128 GB. Can your machine beat it?');
  console.log('✓ X share link');
}
