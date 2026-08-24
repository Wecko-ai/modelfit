#!/usr/bin/env node
// modelfit — detect this machine and name THE best local LLM it can run, from the
// ModelFit database. Offline-first, zero dependencies. https://modelfit.io
//
// Usage:  npx @wecko-ai/modelfit       (or: npm i -g @wecko-ai/modelfit; modelfit)

import { detectHardware, toEngineInput } from '../src/detect.mjs';
import { getRecommendations } from '../src/engine.mjs';
import { toBest, toList, toJson } from '../src/render.mjs';
import { selectBest } from '../src/best.mjs';
import { offerInstall } from '../src/install.mjs';
import { runBench, renderBench } from '../src/bench.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const PRIORITIES = { speed: 'Speed', quality: 'Quality', balanced: 'Balanced' };
const USE_CASES = { translation: 'Translation', coding: 'Coding', chat: 'Chat', mixed: 'Mixed' };

const HELP = `modelfit ${PKG.version} — the best local LLM for your machine (https://modelfit.io)

Detects your hardware and names THE single most capable local AI model (Ollama)
it can run comfortably, from ModelFit's hardware-compatibility database.
Runs fully offline. No telemetry. Also an embeddable library:
  import { bestModel } from '@wecko-ai/modelfit'

USAGE
  modelfit [options]            # default: THE best model for your machine
  npx @wecko-ai/modelfit

OPTIONS
  --json                 Machine-readable: { best, alternatives, hardware } (for apps/agents)
  --all                  Show the full ranked list instead of just the best
  --top <n>              Show the top N local models (ranked list)
  --ram <gb>             Override detected memory budget
  --chip <name>          Override detected chip (e.g. "Apple M4 Pro")
  --device <type>        Override device (MacBook Pro | Mac Studio | ...)
  --use-case <type>      Bias the ranked list: coding | chat | translation | mixed
  --priority <type>      Bias the ranked list: speed | quality | balanced
  -y, --yes              Install the recommended model via Ollama without prompting
  --no-install           Don't offer to install after detection
  --no-color             Disable ANSI colours
  -v, --version          Print version
  -h, --help             Show this help

BENCH
  modelfit bench         Measure REAL tokens/sec on this machine (fixed reference
                         model + prompt, comparable across machines; needs Ollama)
    --submit             Contribute the result to the public measured dataset at
                         modelfit.io (CC BY 4.0). The only network call, opt-in.
    --model <tag>        Bench a different Ollama tag instead of the reference
    --no-pull            Never download the model; fail if it is not local

After naming the best model, modelfit offers to install it via Ollama (interactive
terminals only). Use --yes to install unattended, or --no-install to skip the prompt.

EXAMPLES
  npx @wecko-ai/modelfit                 # name the best model, then offer to install it
  modelfit --yes                         # detect + install the best model unattended
  modelfit --json                        # { best: { ollamaCommand, ... }, ... } (no prompt)
  modelfit --all                         # full ranked list
  modelfit --ram 64 --chip "Apple M4 Max"

tok/s figures are estimates, not measured benchmarks. Data: ModelFit (CC BY 4.0).`;

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
      case '--device': o.device = next(); break;
      case '--use-case': case '--usecase': o.useCase = USE_CASES[String(next()).toLowerCase()]; break;
      case '--priority': o.priority = PRIORITIES[String(next()).toLowerCase()]; break;
      case '-y': case '--yes': o.yes = true; break;
      case '--no-install': o.noInstall = true; break;
      case '--submit': o.submit = true; break;
      case '--no-pull': o.noPull = true; break;
      case '--model': o.model = next(); break;
      case '-v': case '--version': o.version = true; break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('-')) { o.unknown = a; }
    }
  }
  return o;
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help) { console.log(HELP); return; }
  if (opts.version) { console.log(PKG.version); return; }

  // `modelfit bench` subcommand: positional, must be the first token.
  if (argv[0] === 'bench') {
    const result = await runBench({
      submit: opts.submit,
      model: opts.model,
      noPull: opts.noPull,
      version: PKG.version,
    });
    if (opts.json) {
      console.log(JSON.stringify(result.ok ? result.payload : result, null, 2));
    } else {
      console.log(renderBench(result, { color: !opts.noColor && !process.env.NO_COLOR }));
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (opts.unknown) {
    console.error(`Unknown option: ${opts.unknown}\nRun "modelfit --help".`);
    process.exitCode = 2;
    return;
  }

  const profile = detectHardware();
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
