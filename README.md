# modelfit

**Detect your machine and get THE best local LLM it can run — instantly.**

`modelfit` reads your hardware (Apple Silicon unified memory, or GPU VRAM on PCs) and
names the **single most capable general-purpose model (Ollama) your machine can run
comfortably**, using the [ModelFit](https://modelfit.io) hardware-compatibility database.
No use-case quiz, no menu — one answer, ready to run. It's **fully offline**, has **zero
dependencies**, sends **no telemetry**, and is an **embeddable library** so any local-AI
app can ship with the right default model out of the box.

```
npx @wecko-ai/modelfit
```

```
ModelFit — the best local LLM for your machine   modelfit.io
Detected  MacBook Pro · Apple M4 · 16 GB unified memory

  ▶ Qwen3 14B   ~32 tok/s · runs comfortably
    $ ollama run qwen3:14b-q4_K_M
    The most capable model your machine can run. → https://modelfit.io/models/qwen/

Also fits  Qwen3.5 9B · Qwen3 8B   (modelfit --all for the full list)
Estimates, not measured benchmarks · Data: ModelFit (CC BY 4.0)
```

It scales to the machine: 8 GB → a 7B, 16 GB → a 14B, 64 GB → Llama 3.1 70B.

## Install

```bash
npx @wecko-ai/modelfit            # no install, always latest
npm i -g @wecko-ai/modelfit       # then run: modelfit
```

The installed command is just **`modelfit`** (the package is scoped, the binary is not).
Requires Node.js ≥ 18.

## Embed in your app

Building a local-AI tool (chat UI, IDE plugin, agent runtime)? Call `bestModel()` on first
launch and your users start with a great model matched to their hardware — they can always
switch later.

```js
import { bestModel } from '@wecko-ai/modelfit'

const m = bestModel()            // auto-detects this machine
// → {
//     name: 'Qwen3 14B',
//     ollamaCommand: 'ollama run qwen3:14b-q4_K_M',
//     params: '14B', quantization: 'Q4_K_M',
//     estimatedTokensPerSec: 31.9, comfortable: true,
//     fit: 'OK', localVerdict: 'local_feasible',
//     learnMoreUrl: 'https://modelfit.io/models/qwen/',
//     hardware: { deviceType, chip, ramGb, detected },
//     source: { name: 'ModelFit', url: 'https://modelfit.io/' }, ...
//   }

// Or pass known hardware (e.g. you already detected it):
bestModel({ ramGb: 64, chip: 'Apple M4 Max', deviceType: 'MacBook Pro' })
```

Other exports: `getRecommendations(input)` (the full ranked list), `detectHardware()`,
`selectBest(recs)`. No native deps — safe in Electron, servers, and CLIs.

Not a Node app? The same logic is a hosted JSON API and an MCP server at
[modelfit.io](https://modelfit.io) (`/api/search`, `/api/mcp`).

## CLI usage

```
modelfit [options]            # default: THE best model for your machine

--json                 { best, alternatives, hardware } — for apps/agents
--all                  Show the full ranked list instead of just the best
--top <n>              Show the top N local models (ranked list)
--ram <gb>             Override detected memory budget
--chip <name>          Override detected chip (e.g. "Apple M4 Pro")
--device <type>        Override device (MacBook Pro | Mac Studio | ...)
--use-case <type>      Bias the ranked list: coding | chat | translation | mixed
--priority <type>      Bias the ranked list: speed | quality | balanced
--no-color             Disable ANSI colours
-v, --version          Print version
-h, --help             Show help
```

### `--json` (scripts & agents)

```bash
modelfit --json | jq '.best.ollamaCommand'
```

```json
{
  "best": {
    "name": "Qwen3 14B", "params": "14B", "ollamaCommand": "ollama run qwen3:14b-q4_K_M",
    "comfortable": true, "estimatedTokensPerSec": 31.9, "fit": "OK",
    "learnMoreUrl": "https://modelfit.io/models/qwen/"
  },
  "alternatives": [ { "name": "Qwen3.5 9B", "ollamaCommand": "ollama run qwen3.5:9b", "...": "..." } ],
  "hardware": { "os": "macOS", "device": "MacBook Pro", "chip": "Apple M4", "ramGb": 16, "budgetSource": "unified memory" },
  "reportUrl": "https://modelfit.io/search/?ram=16",
  "source": { "name": "ModelFit", "url": "https://modelfit.io/" }
}
```

## How it works

1. **Detect** — macOS uses `system_profiler`/`sysctl` (chip, unified memory); Linux/Windows
   use total RAM + `nvidia-smi` for GPU VRAM.
2. **Rank** — a faithful port of ModelFit's recommendation engine scores every model in the
   bundled database against your memory budget (fit, estimated tok/s, local-feasibility verdict).
3. **Pick** — the most capable **general-purpose** model that runs **comfortably**
   (fits the budget *and* clears a tok/s floor). Specialists still show in `--all`.

The bundled model database and ranking engine are kept in sync with
[modelfit.io](https://modelfit.io) — the site stays the source of truth.

## Notes

- **tok/s figures are estimates, not measured benchmarks.**
- Data is published under **CC BY 4.0**. Full dataset: <https://modelfit.io/data>.
- PC/GPU support ranks against detected VRAM; Apple Silicon ranks against unified memory.

## License

MIT — © [ModelFit](https://modelfit.io)
