import { h } from '../core/ui.js';
import { SUITES, GROUPS } from '../suites/index.js';
import { store } from '../core/state.js';
import { fmt } from '../core/num.js';
export const title = 'Engineering console';

export async function render(root) {
  const d = store.project.engine;
  const heroAnim = h('div', { class: 'hero-engine card' });
  const stats = h('div', { class: 'stat-row', style: 'margin-top:14px' }, stat('Hot / cold reservoirs', `${d.Th} / ${d.Tc} °C`), stat('Carnot limit', `${fmt((1 - (d.Tc + 273.15) / (d.Th + 273.15)) * 100, 3)} %`), stat('Cells × ribbons', `${d.nCells} × ${d.ribbonsPerCell}`), stat('Reference model', 'computing…'));
  root.append(h('section', { class: 'hero' },
    h('div', {},
      h('div', { class: 'suite-group' }, 'Regenerative, high-performance shape-memory thermal engine'),
      h('h1', {}, 'THERMA-X100 engineering console'),
      h('p', {}, 'A standalone research environment for a multicell shape-memory-alloy heat engine: heat → crystalline phase transformation → contraction → force → shaft torque → cooling and reset → repetition. Choose any of the 22 coupled suites; the input generator (EIGDAS) builds a consistent model from your intent, the library, live global data and upstream results, runs the governing physics and returns explained results, verdicts and recommendations.'),
      h('div', { class: 'row gap wrap' }, h('a', { class: 'btn primary', href: '#/feasibility' }, '▶ Run the feasibility gate'), h('a', { class: 'btn', href: '#/suite/s01' }, '🏛 Define the engine'), h('a', { class: 'btn', href: '#/suite/s05' }, '🧵 Cartridge cycle'), h('a', { class: 'btn', href: '#/library' }, '🧪 Materials library'), h('a', { class: 'btn', href: '#/portal' }, '⇪ Supply data'), h('a', { class: 'btn', href: '#/dossier' }, '📘 Engineering dossier'), h('a', { class: 'btn', href: '#/lab' }, '⚗ Laboratory')),
      stats),
    heroAnim));
  engineAnimation(heroAnim, d);
  import('../core/engine.js').then(({ engineModel, REFERENCE_W_PER_KG }) => setTimeout(() => {
    try {
      const r = engineModel(d, { n: 1, stepsPerCycle: 120, cycles: 3 });
      stats.lastChild.replaceWith(stat('Reference net shaft power', `${fmt(r.Pnet, 3)} W`, r.Pnet > 0 ? 'ok' : 'bad'));
      stats.append(stat('Net specific power (active SMA)', `${fmt(r.pActive, 3)} W/kg`, r.pActive > REFERENCE_W_PER_KG ? 'ok' : 'warn'), stat('Thermal efficiency', `${fmt(r.eta * 100, 3)} % (${fmt(r.carnotFraction * 100, 3)} % of Carnot)`), stat('Auxiliary power', `${fmt(r.Paux, 3)} W`));
    } catch (e) { stats.lastChild.replaceWith(stat('Reference model', 'unavailable: ' + e.message)); }
  }, 50));
  root.append(h('section', { class: 'card' }, h('h3', { class: 'card-title' }, 'How the 22 suites feed one another (primary initialisation sequence)'), flowDiagram(), h('p', { class: 'small muted' }, 'Each arrow is a live data coupling: when an upstream suite is re-run, downstream results are flagged stale and regenerate with the new state. During coupled simulation (Suite 14) quantities are exchanged in both directions until interface energy, force and displacement converge. One whole-engine energy and exergy balance governs every result.')));
  for (const g of GROUPS) {
    root.append(h('div', { class: 'group-title' }, g));
    root.append(h('div', { class: 'suite-grid' }, ...SUITES.filter(s => s.group === g).map(s => { const o = store.outputMeta(s.id); return h('a', { class: 'suite-card', href: `#/suite/${s.id}` }, h('div', { class: 'top' }, h('span', { class: 'ic' }, s.icon), h('span', { class: 'no' }, 'SUITE ' + String(s.num).padStart(2, '0'))), h('b', {}, s.title), h('span', { class: 'd' }, o ? (o.stale ? '⚠ results stale — re-run' : `✔ ${o.credibility} · ${new Date(o.t).toLocaleString()}`) : 'Not yet run — automatic inputs ready')); })));
  }
  root.append(h('section', { class: 'card', style: 'margin-top:18px' }, h('h3', { class: 'card-title' }, 'How to use the console'), h('ol', {},
    h('li', {}, 'Set the installation site (📍 in the top bar): live ambient and wet-bulb temperatures size the cold sink, solar climatology feeds solar-thermal sources, and inflation, interest, exchange rates and grid carbon feed the economics and sustainability advice.'),
    h('li', {}, 'Start with Suite 01 to state the engineering intention (application, reservoirs, target power). Everything else can be generated automatically.'),
    h('li', {}, 'In each suite choose Automatic, Guided, Expert or Experimental-import mode. Lock any value to keep it during regeneration; every value carries a provenance tag (measured, certified, library, calculated, estimated, coupled, live …).'),
    h('li', {}, 'Read the verdicts first: infeasible cases are reported with their cause and the change needed — never silently solved. Every number and plot has an explanation; every run ends with engineering, economics and sustainability recommendations.'),
    h('li', {}, 'Import laboratory data (DSC, force–stroke, temperatures, flow, torque) through the Data portal or a suite’s import mode to calibrate and validate. Simulated values are never presented as measurements.'),
    h('li', {}, 'Install the app (⤓) to use it offline, including in airplane mode. Export evidence packages, CAD (STEP/STL/OBJ/DXF), meshes (MSH/VTK) and reports from each suite.'))));
  return { dispose: () => heroAnim._stop?.() };
}
const stat = (l, v, st) => h('div', { class: 'kpi' + (st ? ' ' + st : '') }, h('div', { class: 'kpi-label' }, l), h('div', { class: 'kpi-val' }, v));

// Radial multicell engine: each cell cycles heating → power → cooling → reset with a phase offset; the rotor turns
// in proportion to the number of cells in the power stroke (illustrative kinematics, not a solved schedule).
function engineAnimation(box, d) {
  const N = Math.max(6, Math.min(24, d.nCells || 12)), R = 150, cx = 200, cy = 200;
  const C = { heat: '#f97316', power: '#ef4444', cool: '#38bdf8', reset: '#6366f1' };
  let cells = '';
  for (let i = 0; i < N; i++) { const a = 2 * Math.PI * i / N; cells += `<g transform="rotate(${(a * 180 / Math.PI).toFixed(2)} ${cx} ${cy})"><rect id="c${i}" x="${cx - 9}" y="${cy - R - 26}" width="18" height="60" rx="5"/><line id="l${i}" x1="${cx}" y1="${cy - R + 34}" x2="${cx}" y2="${cy - 62}" stroke="currentColor" stroke-opacity=".45" stroke-width="2.5"/></g>`; }
  box.innerHTML = `<svg viewBox="0 0 400 420" role="img" aria-label="Animated radial multicell shape-memory engine" style="color:var(--fg)">
    <circle cx="${cx}" cy="${cy}" r="${R + 44}" fill="none" stroke="var(--line)" stroke-width="2"/>
    <path d="M ${cx - R - 40} ${cy} A ${R + 40} ${R + 40} 0 0 1 ${cx + R + 40} ${cy}" fill="none" stroke="#f97316" stroke-opacity=".35" stroke-width="8"/>
    <path d="M ${cx + R + 40} ${cy} A ${R + 40} ${R + 40} 0 0 1 ${cx - R - 40} ${cy}" fill="none" stroke="#38bdf8" stroke-opacity=".35" stroke-width="8"/>
    ${cells}
    <g id="rotor"><circle cx="${cx}" cy="${cy}" r="60" fill="var(--panel2)" stroke="var(--accent)" stroke-width="3"/>${[0, 1, 2, 3, 4, 5].map(k => `<line x1="${cx}" y1="${cy}" x2="${cx + 56 * Math.cos(k * Math.PI / 3)}" y2="${cy + 56 * Math.sin(k * Math.PI / 3)}" stroke="var(--accent)" stroke-opacity=".6" stroke-width="3"/>`).join('')}<circle cx="${cx}" cy="${cy}" r="12" fill="var(--accent)"/></g>
    <text x="${cx}" y="18" text-anchor="middle" font-size="12" fill="#f97316">hot manifold ${d.Th} °C</text><text x="${cx}" y="410" text-anchor="middle" font-size="12" fill="#38bdf8">cold manifold ${d.Tc} °C</text>
  </svg><div class="stage-legend"><span><i style="background:${C.heat}"></i>heating</span><span><i style="background:${C.power}"></i>power stroke</span><span><i style="background:${C.cool}"></i>cooling</span><span><i style="background:${C.reset}"></i>reset</span></div>`;
  const svg = box.querySelector('svg'), rotor = svg.querySelector('#rotor'), rects = [...Array(N)].map((_, i) => svg.querySelector('#c' + i));
  let raf = 0, ang = 0, last = performance.now();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now; const t = now / 1000 * 0.35; let powered = 0;
    for (let i = 0; i < N; i++) {
      const ph = ((t + i / N) % 1 + 1) % 1, st = ph < 0.2 ? 'heat' : ph < 0.5 ? 'power' : ph < 0.75 ? 'cool' : 'reset';
      if (st === 'power') powered++;
      const contraction = st === 'power' ? (ph - 0.2) / 0.3 : st === 'cool' ? 1 : st === 'reset' ? 1 - (ph - 0.75) / 0.25 : 0;
      rects[i].setAttribute('fill', C[st]); rects[i].setAttribute('height', (60 - 14 * contraction).toFixed(1));
    }
    ang += powered / N * 70 * dt; rotor.setAttribute('transform', `rotate(${ang.toFixed(2)} ${cx} ${cy})`);
    if (!reduce) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame); box._stop = () => cancelAnimationFrame(raf);
}

function flowDiagram() {
  const N = (x, y, w, t, id, c) => `<a href="#/suite/${id}"><rect x="${x}" y="${y}" width="${w}" height="34" rx="9" fill="${c}" fill-opacity=".16" stroke="${c}"/><text x="${x + w / 2}" y="${y + 21}" text-anchor="middle" font-size="12" fill="currentColor">${t}</text></a>`;
  const A = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-opacity=".5" stroke-width="1.5" marker-end="url(#ah)"/>`;
  const rows = [
    ['01 Requirements', 's01', '02 Geometry', 's02', '03 Materials', 's03', '04 Transformation', 's04', '#fb923c'],
    ['05 Cartridge', 's05', '06 Hot source', 's06', '07 Cold sink', 's07', '08 Microchannels', 's08', '#ef4444'],
    ['09 Regenerator', 's09', '10 Metamaterial', 's10', '11 Shaft', 's11', '12 Phase timing', 's12', '#38bdf8'],
    ['13 Hydraulics', 's13', '14 Co-simulation', 's14', '15 Start-up', 's15', '16 Fatigue', 's16', '#a78bfa'],
    ['17 Optimisation', 's17', '18 Exergy', 's18', '19 Digital twin', 's19', '20 Manufacturing', 's20', '#22c55e'],
    ['21 Safety', 's21', '22 Economics', 's22', 'Feasibility gate', '', 'Input register', '', '#eab308'],
  ];
  let s = `<svg class="flow" viewBox="0 0 900 ${rows.length * 52 + 10}" style="color:var(--fg)"><defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="currentColor" fill-opacity=".6"/></marker></defs>`;
  rows.forEach((r, i) => { const y = 8 + i * 52, w = 180, xs = [10, 240, 470, 700]; for (let k = 0; k < 4; k++) s += r[k * 2 + 1] ? N(xs[k], y, w, r[k * 2], r[k * 2 + 1], r[8]) : `<a href="#/${k === 2 ? 'feasibility' : 'register'}"><rect x="${xs[k]}" y="${y}" width="${w}" height="34" rx="9" fill="${r[8]}" fill-opacity=".16" stroke="${r[8]}" stroke-dasharray="4 3"/><text x="${xs[k] + w / 2}" y="${y + 21}" text-anchor="middle" font-size="12" fill="currentColor">${r[k * 2]}</text></a>`; for (let k = 0; k < 3; k++) s += A(xs[k] + w + 2, y + 17, xs[k + 1] - 4, y + 17); if (i < rows.length - 1) s += `<path d="M ${xs[3] + w / 2} ${y + 35} C ${xs[3] + w / 2} ${y + 46}, ${xs[0] + w / 2} ${y + 40}, ${xs[0] + w / 2} ${y + 50}" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="1.2" marker-end="url(#ah)"/>`; });
  return h('div', { html: s + '</svg>' });
}
