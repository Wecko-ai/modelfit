// Optional installer: after modelfit names the best model, offer to pull it via
// Ollama. Zero-dependency (node built-ins only), interactive. Never prompts in
// --json mode or non-TTY pipes. Pulls (not runs) so it downloads the weights
// without dropping the user into a chat session.

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Is the `ollama` binary on PATH? */
export function ollamaInstalled() {
  try {
    return spawnSync('ollama', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** "ollama run qwen3:14b-q4_K_M" -> "qwen3:14b-q4_K_M". Null if unparseable. */
export function parseModelTag(ollamaCommand) {
  if (!ollamaCommand) return null;
  const m = ollamaCommand.match(/ollama\s+(?:run|pull)\s+(\S+)/);
  return m ? m[1] : null;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

/** Pull the model, streaming Ollama's own progress to the terminal. Returns exit code. */
export function pullModel(tag) {
  return spawnSync('ollama', ['pull', tag], { stdio: 'inherit' }).status ?? 1;
}

/**
 * After the best model is shown, offer to install it via Ollama.
 *   - opts.yes        -> install without asking (scripts/CI)
 *   - opts.noInstall  -> never offer
 *   - non-interactive (piped/non-TTY) and not opts.yes -> skip silently
 * Returns true if a pull was attempted.
 */
export async function offerInstall(best, opts = {}) {
  if (!best || opts.noInstall) return false;

  const tag = parseModelTag(best.ollamaCommand);
  if (!tag) return false;

  const auto = !!opts.yes;
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!auto && !interactive) return false; // can't prompt — don't guess

  if (!ollamaInstalled()) {
    console.log('');
    console.log('Ollama is not installed — needed to run local models.');
    console.log('  macOS:  brew install ollama');
    console.log('  Other:  https://ollama.com/download');
    console.log(`Then:   ollama pull ${tag}`);
    return false;
  }

  if (!auto) {
    const a = await ask(`\nInstall ${best.name} now? (ollama pull ${tag}) [y/N] `);
    if (!/^y(es)?$/i.test(a)) {
      console.log(`Skipped. Pull it yourself anytime:  ollama pull ${tag}`);
      return false;
    }
  }

  console.log(`\nPulling ${tag} via Ollama...\n`);
  const code = pullModel(tag);
  if (code === 0) {
    console.log(`\nDone. Start it with:  ollama run ${tag}`);
  } else {
    console.log(`\nOllama pull exited with code ${code}. Try:  ollama pull ${tag}`);
  }
  return true;
}
