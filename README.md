# modelfit

**Detect your machine and get the top local LLMs that fit — instantly.**

`modelfit` reads your hardware (Apple Silicon chip + unified memory, or GPU VRAM on
PCs) and ranks the local AI models (Ollama) you can actually run, using the
[ModelFit](https://modelfit.io) hardware-compatibility database. It runs **fully
offline**, has **zero dependencies**, and sends **no telemetry**.

```
npx modelfit
```

```
ModelFit — best local LLMs for your machine   modelfit.io
Detected  MacBook Pro · Apple M4 · 16 GB unified memory

Top 3 you can run locally
 1  Qwen3.5 4B            Excellent fit · ~xx tok/s · Coding, Chat
    $ ollama run qwen3.5:4b-instruct-q4_K_M
    → https://modelfit.io/models/qwen/
 2  ...
 3  ...

Full report  https://modelfit.io/search/?ram=16
Estimates, not measured benchmarks · Data: ModelFit (CC BY 4.0)
```

## Install

```bash
npx modelfit            # no install, always latest
npm i -g modelfit       # then: modelfit
```

Requires Node.js ≥ 18.

## Usage

```
modelfit [options]

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
-h, --help             Show help
```

### For scripts and agents

`--json` emits the same payload shape as ModelFit's MCP server
(`recommend_local_models`), so tools can shell out to it:

```bash
modelfit --json | jq '.recommendations[0]'
```

```json
{
  "hardware": { "os": "macOS", "device": "MacBook Pro", "chip": "Apple M4", "ramGb": 16, "budgetGb": 16, "budgetSource": "unified memory", "engineInput": { "...": "..." } },
  "recommendations": [
    { "name": "...", "params": "4B", "ollamaCommand": "ollama run ...", "fit": "Excellent", "localVerdict": "local_feasible", "estimatedTokensPerSec": 0, "bestFor": "...", "why": "...", "learnMoreUrl": "https://modelfit.io/models/qwen/" }
  ],
  "reportUrl": "https://modelfit.io/search/?ram=16",
  "source": { "name": "ModelFit", "url": "https://modelfit.io/" }
}
```

## How it works

1. **Detect** — macOS uses `system_profiler`/`sysctl` (chip, unified memory); Linux/Windows
   use total RAM + `nvidia-smi` for GPU VRAM.
2. **Rank** — a faithful port of ModelFit's recommendation engine scores every model in the
   bundled database against your memory budget (fit, sweet-spot utilisation, quality/speed,
   estimated tok/s, local-feasibility verdict).
3. **Show** — the top picks with the exact `ollama run` command and a link to the matching
   ModelFit page.

The bundled model database and ranking engine are kept in sync with
[modelfit.io](https://modelfit.io) — the site stays the source of truth.

## Notes

- **tok/s figures are estimates, not measured benchmarks.**
- Data is published under **CC BY 4.0**. Full dataset: <https://modelfit.io/data>.
- PC/GPU support ranks against detected VRAM; Apple Silicon ranks against unified memory.

## License

MIT — © [ModelFit](https://modelfit.io)
