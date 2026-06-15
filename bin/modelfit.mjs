#!/usr/bin/env node
// modelfit — detect this machine and recommend the top local LLMs from the ModelFit
// database. Offline-first, zero dependencies. https://modelfit.io
//
// Usage:  npx modelfit            (or: npm i -g modelfit; modelfit)

import { detectHardware, toEngineInput } from '../src/detect.mjs';
import { getRecommendations } from '../src/engine.mjs';
import { toHuman, toJson } from '../src/render.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const PRIORITIES = { speed: 'Speed', quality: 'Quality', balanced: 'Balanced' };
const USE_CASES = { translation: 'Translation', coding: 'Coding', chat: 'Chat', mixed: 'Mixed' };

const HELP = `modelfit ${PKG.version} — best local LLMs for your machine (https://modelfit.io)

Detects your hardware and ranks the local AI models (Ollama) that fit, using
ModelFit's hardware-compatibility database. Runs fully offline. No telemetry.

USAGE
  modelfit [options]
  npx @wecko-ai/modelfit

OPTIONS
  --json                 Machine-readable output (agent/script friendly)
  --top <n>              Number of picks to show (default 3)
  --all                  Show the full ranked list
  --use-case <type>      coding | chat | translation | mixed   (default mixed)
  --priority <type>      speed | quality | balanced            (default balanced)
  --ram <gb>             Override detected memory budget
  --chip <name>          Override detected chip (e.g. "Apple M4 Pro")
  --device <type>        Override device (MacBook Pro | Mac Studio | ...)
  --no-color             Disable ANSI colours
  -v, --version          Print version
  -h, --help             Show this help

EXAMPLES
  npx @wecko-ai/modelfit
  modelfit --use-case coding --priority quality
  modelfit --ram 64 --chip "Apple M4 Max" --json

tok/s figures are estimates, not measured benchmarks. Data: ModelFit (CC BY 4.0).`;

function parseArgs(argv) {
  const o = { top: 3 };
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
      case '-v': case '--version': o.version = true; break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('-')) { o.unknown = a; }
    }
  }
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) { console.log(HELP); return; }
  if (opts.version) { console.log(PKG.version); return; }
  if (opts.unknown) {
    console.error(`Unknown option: ${opts.unknown}\nRun "modelfit --help".`);
    process.exitCode = 2;
    return;
  }

  const profile = detectHardware();
  const input = toEngineInput(profile, opts);
  const recs = getRecommendations(input);

  if (opts.json) {
    console.log(JSON.stringify(toJson(profile, input, recs, opts.top), null, 2));
  } else {
    console.log(toHuman(profile, input, recs, opts));
  }
}

main();
