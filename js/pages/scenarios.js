// Standard engineering studies: each preset sets the shared engine design (matched conditions) and opens the suite
// that answers the study question. Presets never alter locked values in suites.
import { h, toast, callout } from '../core/ui.js';
import { store } from '../core/state.js';
import { DEFAULT_ENGINE } from '../core/engine.js';
export const title = 'Standard studies';

export const STUDIES = [
  [1, 'Minimum first demonstrator (spec §41)', 'One conservative NiTi cartridge, adjustable preload, separate hot and cold baths', 'Where is net work per cycle strictly positive?', { nCells: 1, ribbonsPerCell: 10, freq: 0.25, regenEff: 0 }, 's05'],
  [2, 'Reference LT engine', '70 °C / 15 °C, 12 cells, regenerator 0.6', 'Net shaft power, efficiency and specific power on three mass bases', {}, 's18'],
  [3, 'Thin-ribbon fast cycling', '50 µm ribbons at 3 Hz', 'Does thinner ribbon raise net specific power once pumping is counted?', { ribbonT: 50e-6, freq: 3 }, 's08'],
  [4, 'Alloy competition', 'Identical reservoirs, geometry and loads', 'Ranked alloys with uncertainty and feasibility', {}, 's03'],
  [5, 'Regenerator benefit', 'Matched configurations with and without regeneration', 'Does regeneration improve net efficiency after pumping losses? (spec §40)', {}, 's09'],
  [6, 'Phase schedule optimisation', '12 cells, switching latency and heat-supply limit', 'Firing order minimising torque ripple', {}, 's12'],
  [7, 'Cold start under load', 'Engine at rest, cold pre-extended ribbons', 'Self-start threshold and time to steady speed', {}, 's15'],
  [8, 'Pumping penalty', 'Narrow channels, small fluid temperature change', 'When do auxiliaries consume the converted work?', { chH: 0.4e-3, fluidDT: 4 }, 's13'],
  [9, 'Aggressive strain fatigue', 'High stress differential for more work per cycle', 'Life, damage and inspection interval', { sigmaL: 80, sigmaH: 125 }, 's16'],
  [10, '100× specific-power pathway', 'Stretch target 3 600 W/kg on the active-mass basis', 'Greatest sustainable net work per kg with heat, cycle time and fatigue accounted', {}, 's17'],
  [11, 'Industrial waste heat (HT variant)', '190 °C oil / 40 °C water, NiTiHf', 'Feasibility and economics of the HT envelope', { Th: 190, Tc: 40, alloy: 'nitihf', sigmaL: 260, sigmaH: 360, hotFluid: 'fl-oil', variant: 'HT', freq: 0.5 }, 's01'],
  [12, 'Ambient-only operation', 'Hot = cold = ambient', 'Must be rejected: no exergy, no cyclic output (spec §2)', { Th: 25, Tc: 25 }, 's01'],
  [13, 'Warm-climate cold sink', 'Cooling tower at the project site', 'Can the sink complete the martensitic reset all year?', {}, 's07'],
  [14, 'Solar-thermal source', 'Flat-plate collector at the project site', 'Hours per day the source meets engine demand', {}, 's06'],
  [15, 'Fault injection & trips', 'Over-temperature, low flow, overspeed', 'Alarm/trip timing and safe state', {}, 's21'],
  [16, 'Digital-twin calibration', 'Imported (or clearly labelled synthetic) cartridge test', 'Calibrated parameters with confidence intervals', {}, 's19'],
  [17, 'Techno-economics at site', 'Live inflation, interest, FX and grid carbon', 'Levelized cost, payback and carbon payback', {}, 's22'],
  [18, 'Co-simulation convergence', 'Fluid ↔ cartridge ↔ shaft interface iteration', 'Converged interface energy, force and displacement', {}, 's14'],
];

export async function render(root) {
  root.append(h('h1', {}, 'Standard engineering studies'), h('p', { class: 'muted', style: 'max-width:980px' }, 'Ready-made studies drawn from the master specification. Launching one sets the shared engine design (everything else stays at matched conditions) and opens the suite that answers the question. Use “Restore reference design” to return to the baseline.'));
  root.append(h('div', { class: 'row gap wrap', style: 'margin-bottom:12px' }, h('button', { class: 'btn', onclick: () => { store.setEngine({ ...DEFAULT_ENGINE }, 'reference restore'); toast('Reference engine design restored', 'ok'); } }, '⟲ Restore reference design')));
  if (store.project.lastStudy) root.append(callout('info', `Last study applied: ${store.project.lastStudy}.`));
  const grid = h('div', { class: 'suite-grid' });
  for (const [n, name, setup, q, over, target] of STUDIES) grid.append(h('button', { class: 'suite-card', style: 'text-align:left;cursor:pointer;font:inherit', onclick: () => { store.setEngine({ ...DEFAULT_ENGINE, ...over }, 'study ' + n); store.project.lastStudy = `${n} — ${name}`; store.touch(); toast(`Study ${n} applied — opening Suite ${target.slice(1)}`, 'ok'); location.hash = `#/suite/${target}`; } }, h('div', { class: 'top' }, h('span', { class: 'no' }, 'STUDY ' + String(n).padStart(2, '0')), h('span', { class: 'ic' }, '▶')), h('b', {}, name), h('span', { class: 'd' }, setup), h('span', { class: 'd', style: 'color:var(--accent)' }, '→ ' + q)));
  root.append(grid);
}
