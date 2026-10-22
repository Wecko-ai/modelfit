// Mac detection reads chip, memory and GPU cores from ONE system_profiler call
// (SPHardwareDataType + SPDisplaysDataType), and the display part is optional.
// Run: node test/detect.mjs   (or npm test)

import { appleGpuCores, parseMacProfiler } from '../src/detect.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) { console.error(`✗ ${msg}`); failures++; } };

// Shape of `system_profiler SPHardwareDataType SPDisplaysDataType -json` on an Apple silicon Mac
// (identifying fields such as the serial number left out).
const combined = JSON.stringify({
  SPHardwareDataType: [{ machine_name: 'MacBook Pro', chip_type: 'Apple M5 Max', physical_memory: '128 GB', number_processors: 'proc 18:6:12' }],
  SPDisplaysDataType: [{ sppci_model: 'Apple M5 Max', sppci_cores: '40', sppci_device_type: 'spdisplays_gpu' }],
});
const p = parseMacProfiler(combined);
check(p.machineName === 'MacBook Pro', 'machine name from the combined document');
check(p.chipRaw === 'Apple M5 Max', 'chip from the combined document');
check(p.memGb === 128, 'memory from the combined document');
check(p.cpuCores === 18, 'CPU cores from the combined document');
check(appleGpuCores(p.displays) === 40, 'GPU cores from the combined document');

// Hardware only (the display query skipped for a --chip or --gpu-cores override).
const hwOnly = parseMacProfiler(JSON.stringify({ SPHardwareDataType: JSON.parse(combined).SPHardwareDataType }));
check(hwOnly.chipRaw === 'Apple M5 Max' && hwOnly.displays === null, 'hardware-only document');
check(appleGpuCores(hwOnly.displays) === null, 'no display data gives no GPU core count');

// An external display listed first does not hide the Apple GPU; junk gives nothing.
check(appleGpuCores([{ sppci_model: 'DELL U2723QE' }, { sppci_model: 'Apple M4', sppci_cores: '10' }]) === 10, 'Apple GPU found after another display');
check(appleGpuCores([{ sppci_model: 'Apple M4', sppci_cores: 'n/a' }]) === null, 'unparseable core count');
check(parseMacProfiler('not json').chipRaw === '' && parseMacProfiler('').memGb === 0, 'bad or empty output falls back');

if (failures) { console.error(`\n${failures} detect check(s) failed.`); process.exit(1); }
console.log('✓ detect reads chip, memory and GPU cores from one system_profiler call');
