// Cross-platform local hardware detection. 100% local — runs nothing over the network.
// Produces a normalized profile + an engine input {deviceType, chip, ramGb} that the
// ported recommend engine ranks against.

import os from 'node:os';
import { execFileSync } from 'node:child_process';

const GB = 1024 ** 3;
const round = (n) => Math.round(n);

// Exact ChipType / DeviceType enums accepted by the engine (lib/recommend.ts).
const KNOWN_CHIPS = new Set([
  'Apple M1', 'Apple M2', 'Apple M3', 'Apple M4', 'Apple M5',
  'Apple M1 Pro', 'Apple M1 Max', 'Apple M1 Ultra',
  'Apple M2 Pro', 'Apple M2 Max', 'Apple M2 Ultra',
  'Apple M3 Pro', 'Apple M3 Max',
  'Apple M3 Ultra',
  'Apple M4 Pro', 'Apple M4 Max',
  'Apple M5 Pro', 'Apple M5 Max',
  'Apple A16', 'Apple A17 Pro', 'Apple A18', 'Apple A18 Pro', 'Apple A19', 'Apple A19 Pro',
]);
const KNOWN_DEVICES = new Set([
  'MacBook Air', 'MacBook Pro', 'Mac Studio', 'Mac Mini',
]);

function sh(cmd, args, timeout = 4000) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** "Apple M5 Max" / "Apple M4 Pro" -> nearest enum chip the engine understands. */
function normalizeChip(raw) {
  if (!raw) return 'Unknown';
  const chip = raw.replace(/\s+/g, ' ').trim();
  if (KNOWN_CHIPS.has(chip)) return chip;
  // Newer-than-enum (e.g. M5): downgrade one generation, keep the tier (Pro/Max/Ultra).
  const m = chip.match(/Apple M(\d+)\s*(Pro|Max|Ultra)?/i);
  if (m) {
    const tier = m[2] ? ` ${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}` : '';
    for (let gen = Number(m[1]); gen >= 1; gen--) {
      const cand = `Apple M${gen}${tier}`;
      if (KNOWN_CHIPS.has(cand)) return cand;
    }
  }
  return 'Unknown';
}

/** system_profiler "MacBook Pro" / "Mac Pro" / "iMac" -> engine DeviceType. */
function normalizeDevice(raw) {
  if (KNOWN_DEVICES.has(raw)) return raw;
  if (/macbook air/i.test(raw)) return 'MacBook Air';
  if (/macbook/i.test(raw)) return 'MacBook Pro';
  if (/mac studio/i.test(raw)) return 'Mac Studio';
  if (/mac mini/i.test(raw)) return 'Mac Mini';
  // iMac / Mac Pro / unknown desktop -> neutral desktop profile
  return 'Mac Studio';
}

function detectMac(profile) {
  // Prefer system_profiler JSON (chip + marketing model name), fall back to sysctl.
  let machineName = '', chipRaw = '', memGb = 0;
  const json = sh('system_profiler', ['SPHardwareDataType', '-json'], 6000);
  if (json) {
    try {
      const h = JSON.parse(json).SPHardwareDataType?.[0] ?? {};
      machineName = h.machine_name || '';
      chipRaw = h.chip_type || h.cpu_type || '';
      memGb = parseInt(String(h.physical_memory || ''), 10) || 0;
    } catch { /* fall through to sysctl */ }
  }
  if (!chipRaw) chipRaw = sh('sysctl', ['-n', 'machdep.cpu.brand_string']);
  if (!memGb) {
    const bytes = parseInt(sh('sysctl', ['-n', 'hw.memsize']), 10);
    memGb = bytes ? round(bytes / GB) : round(os.totalmem() / GB);
  }

  const isAppleSilicon = profile.arch === 'arm64' || /^Apple\s/i.test(chipRaw);
  const ramGb = memGb || round(os.totalmem() / GB);

  if (isAppleSilicon) {
    return {
      ...profile,
      isAppleSilicon: true,
      ramGb,
      chip: normalizeChip(chipRaw),
      chipLabel: chipRaw || 'Apple Silicon',
      deviceType: normalizeDevice(machineName),
      deviceLabel: machineName || 'Mac',
      accelerator: { kind: 'unified', name: chipRaw || 'Apple Silicon' },
      budgetGb: ramGb,
      budgetSource: 'unified memory',
      detail: `${machineName || 'Mac'} · ${chipRaw || 'Apple Silicon'} · ${ramGb} GB unified memory`,
    };
  }
  // Intel Mac
  return {
    ...profile,
    isAppleSilicon: false,
    ramGb,
    chip: 'Unknown',
    chipLabel: chipRaw || 'Intel',
    deviceType: normalizeDevice(machineName),
    deviceLabel: machineName || 'Mac',
    accelerator: { kind: 'cpu', name: chipRaw || 'Intel CPU' },
    budgetGb: ramGb,
    budgetSource: 'system RAM (CPU inference)',
    detail: `${machineName || 'Mac'} · ${chipRaw || 'Intel'} · ${ramGb} GB RAM (no GPU acceleration)`,
  };
}

/** Best-effort NVIDIA detection via nvidia-smi (Linux + Windows). */
function detectNvidia() {
  const out = sh('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (!out) return null;
  const [name, vram] = out.split('\n')[0].split(',').map((s) => s.trim());
  const vramGb = round((parseInt(vram, 10) || 0) / 1024);
  if (!name || !vramGb) return null;
  return { name, vramGb, slug: gpuSlug(name) };
}

/** "NVIDIA GeForce RTX 5070 Ti" -> "rtx-5070-ti" (best effort, for /gpu/<slug>/). */
function gpuSlug(name) {
  const m = name.match(/rtx\s*(\d{3,4})\s*(ti|super)?/i);
  if (m) return `rtx-${m[1]}${m[2] ? `-${m[2].toLowerCase()}` : ''}`;
  const dc = name.match(/\b([ah]100|l40s?|a6000)\b/i);
  if (dc) return dc[1].toLowerCase();
  return '';
}

function detectPc(profile, osName) {
  const ramGb = round(os.totalmem() / GB);
  const gpu = detectNvidia();
  const cpuName = (os.cpus()[0]?.model || 'CPU').replace(/\s+/g, ' ').trim();

  if (gpu) {
    return {
      ...profile,
      isAppleSilicon: false,
      ramGb,
      chip: 'Unknown',
      chipLabel: cpuName,
      deviceType: gpu.name, // non-enum -> engine uses neutral throughput, no thermal penalty
      deviceLabel: `${osName} PC`,
      accelerator: { kind: 'gpu', name: gpu.name, vramGb: gpu.vramGb, slug: gpu.slug },
      budgetGb: gpu.vramGb,
      budgetSource: 'GPU VRAM',
      detail: `${osName} · ${gpu.name} · ${gpu.vramGb} GB VRAM (${ramGb} GB system RAM)`,
    };
  }
  return {
    ...profile,
    isAppleSilicon: false,
    ramGb,
    chip: 'Unknown',
    chipLabel: cpuName,
    deviceType: `${osName} PC`,
    deviceLabel: `${osName} PC`,
    accelerator: { kind: 'cpu', name: cpuName },
    budgetGb: ramGb,
    budgetSource: 'system RAM (CPU inference)',
    detail: `${osName} · ${cpuName} · ${ramGb} GB RAM (no NVIDIA GPU detected)`,
  };
}

/** Detect the host. Returns a normalized profile (see docs/cli-plan). */
export function detectHardware() {
  const platform = os.platform();
  const base = { platform, arch: os.arch(), detectedRamGb: round(os.totalmem() / GB) };

  if (platform === 'darwin') return { ...detectMac({ ...base, os: 'macOS' }) };
  if (platform === 'linux') return detectPc({ ...base, os: 'Linux' }, 'Linux');
  if (platform === 'win32') return detectPc({ ...base, os: 'Windows' }, 'Windows');
  // Unknown OS — RAM-only fallback.
  return detectPc({ ...base, os: platform }, platform);
}

/**
 * Merge CLI overrides (--ram/--chip/--device) onto a detected profile and produce the
 * final engine input. Overrides win; budget follows --ram when given.
 */
export function toEngineInput(profile, overrides = {}) {
  const ramGb = overrides.ram ?? profile.budgetGb ?? profile.ramGb;
  const chip = overrides.chip ?? profile.chip ?? 'Unknown';
  const deviceType = overrides.device ?? profile.deviceType;
  return {
    deviceType,
    chip,
    ramGb,
    priority: overrides.priority ?? 'Balanced',
    useCase: overrides.useCase ?? 'Mixed',
  };
}
