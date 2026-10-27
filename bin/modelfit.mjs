#!/usr/bin/env node
// modelfit: detect this machine and name THE best local LLM it can run, from the
// ModelFit database. Offline-first, zero dependencies. https://modelfit.io
//
// Usage:  npx @modelfit/cli       (or: npm i -g @modelfit/cli; modelfit)

import { detectHardware, toEngineInput } from '../src/detect.mjs';
import { getRecommendations } from '../src/engine.mjs';
import { toBest, toList, toJson } from '../src/render.mjs';
import { selectBest } from '../src/best.mjs';
import { offerInstall, ask } from '../src/install.mjs';
import {
  runBench, renderBench, submitBench, submitRefusal, describeSubmission, benchChoicesForThisMachine,
  normalizeHandle, formatGb, BENCH_MODEL, BENCH_LADDER,
} from '../src/bench.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const PRIORITIES = { speed: 'Speed', quality: 'Quality', balanced: 'Balanced' };
const USE_CASES = { translation: 'Translation', coding: 'Coding', chat: 'Chat', mixed: 'Mixed' };

const HELP = `modelfit ${PKG.version}: the best local LLM for your machine (https://modelfit.io)

Detects your hardware and names THE single most capable local AI model (Ollama)
it can run comfortably, from ModelFit's hardware-compatibility database.
Runs fully offline. No telemetry. Also an embeddable library:
  import { bestModel } from '@modelfit/cli'

USAGE
  modelfit [options]            # default: THE best model for your machine
  npx @modelfit/cli

OPTIONS
  --json                 Machine-readable: { best, alternatives, hardware } (for apps/agents)
  --all                  Show the full ranked list instead of just the best
  --top <n>              Show the top N local models (ranked list)
  --ram <gb>             Override detected memory budget
  --chip <name>          Override detected chip (e.g. "Apple M4 Pro")
  --gpu-cores <n>        Override the chip bin by GPU core count (e.g. 32 for a binned M5 Max)
  --device <type>        Override device (MacBook Pro | Mac Studio | ...)
  --use-case <type>      Bias the ranked list: coding | chat | translation | mixed
  --priority <type>      Bias the ranked list: speed | quality | balanced
  -y, --yes              Install the recommended model via Ollama without prompting
  --no-install           Don't offer to install after detection
  --no-color             Disable ANSI colours
  -v, --version          Print version
  -h, --help             Show this help

BENCH
  modelfit bench         Measure REAL tokens/sec on this machine (fixed prompts and
                         sampling, comparable across machines; needs Ollama). In a
                         terminal it proposes the leaderboard model that fits
                         (Qwen3.8 27B, else Qwen3.5 9B, else Qwen3.5 4B), then asks
                         before submitting. Elsewhere it runs the 1.5B reference model.
    --submit             Submit to the leaderboard at modelfit.io/bench (CC BY 4.0)
                         without asking. The only network call, opt-in.
    --handle <@you>      Show your X handle on your result card (optional)
    --model <tag>        Bench this Ollama tag (only ModelFit-validated models can
                         be submitted)
    --no-pull            Never download the model; fail if it is not local
    --cleanup            Remove the model when the bench ends, so nothing is left
                         on disk (a model you already had is kept)
    --json               Print the result as JSON (never asks anything)

After naming the best model, modelfit offers to install it via Ollama (interactive
terminals only). Use --yes to install unattended, or --no-install to skip the prompt.

EXAMPLES
  npx @modelfit/cli                 # name the best model, then offer to install it
  modelfit --yes                         # detect + install the best model unattended
  modelfit --json                        # { best: { ollamaCommand, ... }, ... } (no prompt)
  modelfit --all                         # full ranked list
  modelfit --ram 64 --chip "Apple M4 Max"
  npx -y @modelfit/cli@latest bench               # measure, then choose to share

tok/s figures are estimates, not measured benchmarks, printed as "est. N tok/s, typical error X%".
Typical error is the median gap between the estimate and measured runs on hardware the model
was not fitted on (--json: estimatedErrorPct). Data: ModelFit (CC BY 4.0).`;

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--json': o.json = true; break;
      case '--all': o.all = true; break;
      case '--no-color': o.noColor = true; break;
      case '--top': o.top = Math.max(1, parseInt(next(), 10) || 3); break;
      case '--ram': o.ram = Math.max(1, parseInt(next(), 10) || 0) || undefined; break;
      case '--chip': o.chip = next(); break;
      case '--gpu-cores': o.gpuCores = Math.max(1, parseInt(next(), 10) || 0) || undefined; break;
      case '--device': o.device = next(); break;
      case '--use-case': case '--usecase': o.useCase = USE_CASES[String(next()).toLowerCase()]; break;
      case '--priority': o.priority = PRIORITIES[String(next()).toLowerCase()]; break;
      case '-y': case '--yes': o.yes = true; break;
      case '--no-install': o.noInstall = true; break;
      case '--submit': o.submit = true; break;
      case '--no-pull': o.noPull = true; break;
      case '--cleanup': o.cleanup = true; break;
      case '--model': o.model = next(); break;
      case '--handle': o.handle = next() ?? ''; break;
      case '-v': case '--version': o.version = true; break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('-')) { o.unknown = a; }
    }
  }
  return o;
}

/** Ask which model to measure (TTY only). Resolves a tag, or null to quit. */
async function pickModel() {
  const { ladder, others } = benchChoicesForThisMachine();
  const choices = [...ladder, ...others];
  if (!choices.length) return BENCH_MODEL;
  const line = (c, i) => {
    const size = c.pullGb != null ? `${formatGb(c.pullGb)} download` : 'size unknown';
    const est = c.estTokPerSec != null ? `, est. ${c.estTokPerSec} tok/s` : '';
    return `  ${String(i + 1).padStart(2)}) ${c.name} (${c.tag})  ${size}${est}`;
  };
  console.log('\nmodelfit bench: pick a model to measure (ModelFit-validated, fits this machine)');
  if (ladder.length) {
    console.log(`  Leaderboard models${ladder[0].tag === BENCH_LADDER[0] ? '' : ` (${BENCH_LADDER[0]} does not fit here)`}:`);
    ladder.forEach((c, i) => console.log(line(c, i)));
  }
  if (others.length) {
    console.log('  Other validated models that fit:');
    others.forEach((c, i) => console.log(line(c, ladder.length + i)));
  }
  for (;;) {
    const a = (await ask(`Choose 1-${choices.length} [1], q to quit: `)).toLowerCase();
    if (a === 'q') return null;
    if (a === '') return choices[0].tag;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].tag;
  }
}

async function bench(opts) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !opts.json;
  const color = !opts.noColor && !process.env.NO_COLOR;
  try {
    normalizeHandle(opts.handle);
  } catch (err) {
    console.error(`bench: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  let model = opts.model;
  if (!model) model = interactive ? await pickModel() : BENCH_MODEL;
  if (!model) return;
  if (opts.submit && submitRefusal(model)) {
    console.error(`modelfit bench: ${model} is not a ModelFit-validated model: it runs here, but the leaderboard will refuse it.`);
  }

  let result = await runBench({
    submit: opts.submit,
    model,
    handle: opts.handle,
    noPull: opts.noPull,
    cleanup: opts.cleanup,
    onNotice: (msg) => console.error(msg),
    version: PKG.version,
  });

  if (opts.json) {
    const { submitted, listed, reason, id, link, submitError } = result;
    const submission = opts.submit && result.ok ? { submitted, listed, reason, id, link, submitError } : undefined;
    console.log(JSON.stringify(result.ok ? { ...result.payload, ...(submission ? { submission } : {}) } : result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log(renderBench(result, { color, big: interactive }));
  if (!result.ok) {
    process.exitCode = 1;
    return;
  }
  if (!opts.submit && interactive) {
    if (submitRefusal(model)) {
      console.log(`  ${model} is not a ModelFit-validated model, so it cannot join the leaderboard.`);
      return;
    }
    console.log('');
    for (const l of describeSubmission(result.payload)) console.log(l);
    const a = await ask('Submit to the leaderboard? [Y/n] ');
    if (/^n(o)?$/i.test(a)) {
      console.log('  Not submitted. Nothing left this machine.');
      return;
    }
    result = { ...result, ...(await submitBench(result.payload)) };
    if (result.submitted && result.listed && result.link) {
      console.log(`\n  Submitted. Your result page, with the card to post: ${result.link}`);
    } else if (result.submitted && result.listed) {
      console.log('\n  Submitted. See the leaderboard at https://modelfit.io/bench/');
    } else if (result.submitted) {
      console.log(`\n  Stored, but not listed on the leaderboard (${result.reason}).`);
    } else {
      console.log(`\n  Not submitted: ${result.submitError}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help) { console.log(HELP); return; }
  if (opts.version) { console.log(PKG.version); return; }

  // `modelfit bench` subcommand: positional, must be the first token.
  if (argv[0] === 'bench') {
    await bench(opts);
    return;
  }

  if (opts.unknown) {
    console.error(`Unknown option: ${opts.unknown}\nRun "modelfit --help".`);
    process.exitCode = 2;
    return;
  }

  // An overridden chip or bin makes the detected GPU core count moot: skip the slow display query.
  const profile = detectHardware({ gpuCores: opts.chip == null && opts.gpuCores == null });
  const input = toEngineInput(profile, opts);
  const recs = getRecommendations(input);

  if (opts.json) {
    console.log(JSON.stringify(toJson(profile, input, recs, opts), null, 2));
  } else if (opts.all || opts.top != null) {
    console.log(toList(profile, input, recs, opts));   // ranked list view
  } else {
    console.log(toBest(profile, input, recs, opts));   // default: THE one
    await offerInstall(selectBest(recs), opts);         // then offer to pull it via Ollama
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exitCode = 1;
});
