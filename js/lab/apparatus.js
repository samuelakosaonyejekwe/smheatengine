// Workspace 3 — apparatus & fixture design: parametric schematic of the first-demonstrator rig (specification §35, §41):
// rigid load frame, load cell, grips, ribbon bundle in a heat-exchange jacket, hot/cold baths with switching valves,
// calorimetric flow loop and sensor placement; sized bill of apparatus; SVG / DXF / JSON export.
import { h, table, kpiGrid, recList } from '../core/ui.js';
import { store } from '../core/state.js';
import { get as getMat } from '../core/materials.js';
import { fluid } from '../core/heat.js';
import { stableHash } from '../core/lab.js';
import { card, grid, field, numIn, selIn, btn, val, note, row, dl, f3 } from './common.js';

const STD_LC = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000], STD_LVDT = [1, 2.5, 5, 10, 25, 50];
const up = (list, v) => list.find(x => x >= v) ?? list[list.length - 1];

export async function render(el) {
  const d = store.project.engine;
  const P = { L: numIn(d.ribbonL * 1e3), w: numIn(d.ribbonW * 1e3), t: numIn(d.ribbonT * 1e6), n: numIn(d.ribbonsPerCell, { step: 1 }), Th: numIn(d.Th), Tc: numIn(d.Tc), sH: numIn(d.sigmaH), f: numIn(d.freq, { step: 0.1 }), span: numIn(300), dTf: numIn(2, { step: 0.5 }), stab: numIn(0.05, { step: 0.01 }), bias: selIn([['spring', 'Low-friction bias spring'], ['dead', 'Dead weight on a pulley']], 'spring'), tcs: numIn(3, { step: 1 }), cam: selIn([['yes', 'High-speed camera / image correlation'], ['no', 'No optical strain mapping']], 'yes') };
  el.append(card('Rig parameters', note('Defaults come from the current engine design (one cartridge cell). The rig is deliberately conservative: rigid frame, adjustable preload, separate controllable baths, interchangeable clamps and a calorimetric loop (first demonstrator, specification §41).'),
    grid(field('Ribbon length (mm)', P.L), field('Ribbon width (mm)', P.w), field('Ribbon thickness (µm)', P.t), field('Ribbons in bundle', P.n), field('Hot bath (°C)', P.Th), field('Cold bath (°C)', P.Tc), field('Power-stroke stress σ_H (MPa)', P.sH), field('Cycle frequency (Hz)', P.f), field('Column spacing (mm)', P.span), field('Fluid ΔT across jacket (K)', P.dTf), field('Bath stability per cycle (K)', P.stab), field('Return bias', P.bias), field('Specimen thermocouples', P.tcs), field('Optical strain', P.cam)),
    row(btn('↻ Update design', () => draw(), 'primary'))));
  const out = h('div'); el.append(out);
  function draw() {
    out.innerHTML = '';
    const m = getMat(d.alloy), L = val(P.L) / 1e3, A = val(P.n) * val(P.w) * 1e-3 * val(P.t) * 1e-6, Fpk = val(P.sH) * 1e6 * A, stroke = (m?.epsL || 0.045) * L * 1e3, mass = A * L * (m?.rho || 6450);
    const Qcyc = mass * ((m?.cp || 490) * (val(P.Th) - val(P.Tc)) + (m?.Lh || 2e4)) * 2.5, fw = fluid('fl-water', (val(P.Th) + val(P.Tc)) / 2), f = val(P.f);
    const mdot = Qcyc * f / (fw.cp * val(P.dTf)), Vbath = Math.max(5, Qcyc / (fw.rho * fw.cp * val(P.stab)) * 1e3 * 10), heater = Qcyc * f * 1.5 + 150;
    const lc = up(STD_LC, 2 * Fpk), lv = up(STD_LVDT, 1.5 * stroke), rate = Math.max(100, Math.ceil(200 * f));
    const spec = { ribbon: { L_mm: val(P.L), w_mm: val(P.w), t_um: val(P.t), n: val(P.n), alloy: d.alloy, mass_g: mass * 1e3 }, loads: { Fpeak_N: Fpk, sigmaH_MPa: val(P.sH) }, thermal: { Th: val(P.Th), Tc: val(P.Tc), Qcycle_J: Qcyc, mdot_kgs: mdot, bath_L: Vbath, heater_W: heater }, sensors: { loadcell_N: lc, lvdt_mm: lv, thermocouples: val(P.tcs), rtd: 4, flowmeters: 2, dp: 1, camera: P.cam.value === 'yes' }, daq_Hz: rate, bias: P.bias.value };
    const geo = schematic(spec);
    const c = card('Rig schematic (not to scale; key values annotated)', h('div', { html: geo.svg, style: 'overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:#fff' }), note('Hot and cold baths feed the specimen jacket through a pair of three-way valves (hot phase / cold phase). RTDs at the jacket inlet and outlet with the mass-flow meter give the calorimetric heat ṁ·c_p·ΔT; thermocouples on the ribbon give the specimen temperature; the load cell sits in series with the ribbon and the LVDT measures contraction at the lower grip. The enclosure carries hard-wired over-temperature, pressure-relief, force-limit and emergency-stop circuits.'),
      row(btn('⇩ SVG', () => dl(geo.svg, 'therma-rig.svg', 'image/svg+xml')), btn('⇩ DXF', () => dl(geo.dxf, 'therma-rig.dxf', 'application/dxf')), btn('⇩ JSON', () => dl(JSON.stringify({ ...spec, hash: stableHash(spec), primitives: geo.prims }, null, 2), 'therma-rig.json', 'application/json'))));
    out.append(c);
    out.append(card('Sizing', kpiGrid([
      { label: 'Peak ribbon force', value: Fpk, unit: 'N', explain: `σ_H × bundle cross-section (${f3(A * 1e6)} mm²). The load cell is chosen at ≥ 2× this so the working range stays in its most accurate region while surviving shock.`, prov: 'calc' },
      { label: 'Expected stroke', value: stroke, unit: 'mm', explain: 'ε_L × active length; the LVDT range is ≥ 1.5× the stroke.', prov: 'calc' },
      { label: 'Heat per cycle (estimate)', value: Qcyc, unit: 'J', explain: 'Sensible + latent heat of the ribbon × 2.5 for wall and fixture thermal mass; the calorimetric loop must resolve this.', prov: 'estimated' },
      { label: 'Jacket flow', value: mdot * 60, unit: 'kg/min', explain: `Flow that limits the fluid temperature change across the jacket to ${val(P.dTf)} K (enough ΔT for an accurate calorimetric reading with class-A RTDs).`, prov: 'calc' },
      { label: 'Bath volume (each)', value: Vbath, unit: 'L', explain: `Keeps the bath drift below ${val(P.stab)} K per cycle with a 10× safety factor.`, prov: 'calc' },
      { label: 'Hot-bath heater', value: heater, unit: 'W', explain: 'Mean cycle heat × 1.5 plus 150 W for bath and piping losses.', prov: 'estimated' },
      { label: 'Acquisition rate', value: rate, unit: 'Hz', explain: 'At least 200 samples per cycle on a common timestamp so the work loop and switching transients are resolved.', prov: 'calc' },
    ])));
    const bom = [
      ['Rigid load frame with adjustable crosshead', `≥ ${Math.ceil(3 * Fpk)} N capacity, frame compliance < 1 % of stroke`, 1, 'Mechanical reference; preload adjustment'],
      ['Load cell (S-beam or in-line)', `${lc} N, class ≤ 0.25 %`, 1, 'Actuator pulling force'],
      ['LVDT / displacement encoder', `±${lv} mm, linearity ≤ 0.2 %`, 1, 'Contraction and reset displacement'],
      ['Interchangeable clamp grips', `${val(P.w)} mm ribbon, serrated + insulated faces`, 2, 'Grip without slip or heat leak'],
      [P.bias.value === 'spring' ? 'Low-friction bias spring + linear guide' : 'Dead weight + low-friction pulley', `${f3(d.sigmaL * 1e6 * A)} N reset force`, 1, 'Reset (re-extension) load'],
      ['One-way clutch / output load', `${f3((val(P.sH) - d.sigmaL) * 1e6 * A)} N`, 1, 'Separates transmitted work from bias work'],
      ['Heat-exchange jacket (specimen)', `${val(P.L)} mm active length, microchannel walls`, 1, 'Thermal access to the ribbon'],
      ['Precision bath (hot)', `${f3(Vbath)} L, ${val(P.Th)} °C ± ${val(P.stab)} K, heater ${Math.ceil(heater)} W`, 1, 'Hot reservoir'],
      ['Precision bath (cold) / chiller', `${f3(Vbath)} L, ${val(P.Tc)} °C ± ${val(P.stab)} K`, 1, 'Cold reservoir'],
      ['Circulation pumps', `${f3(mdot * 60)} kg/min at jacket ΔP`, 2, 'Flow loop'],
      ['Three-way switching valves (fast)', 'switching < 20 ms, low dead volume', 2, 'Hot/cold phase switching'],
      ['Mass-flow meters', `${f3(mdot * 60)} kg/min, ≤ 0.5 %`, 2, 'Calorimetry'],
      ['Pt100 class-A RTDs', 'jacket inlet/outlet, hot and cold', 4, 'Calorimetric ΔT'],
      ['Fine thermocouples (type T)', 'bonded on ribbon surface', val(P.tcs), 'Specimen temperature'],
      ['Differential pressure transducer', '0–100 kPa', 1, 'Jacket pressure drop → pump work'],
      ...(P.cam.value === 'yes' ? [['High-speed camera + speckle pattern', '≥ 500 fps', 1, 'Strain localisation / slip at grips']] : []),
      ['Data-acquisition unit', `≥ ${rate} Hz per channel, common timestamp`, 1, 'Synchronised acquisition'],
      ['Safety enclosure', 'hard-wired over-temperature cut-out, pressure relief, force limit switch, E-stop', 1, 'Mandatory independent interlocks'],
    ];
    out.append(card('Bill of apparatus', table(['Item', 'Specification', 'Qty', 'Purpose'], bom), h('h4', {}, 'Recommendations'), recList([
      { level: 'good', text: 'Measure frame compliance and grip slip in a dry mechanical test before commissioning flow; both bias the measured stroke and therefore the work.', basis: 'Specification §36 dry mechanical test' },
      { level: 'warn', text: `The calorimetric resolution is set by ΔT ≈ ${val(P.dTf)} K over ~${f3(Qcyc)} J per cycle; correlated RTD pairs (same calibration batch) cancel common-mode bias in ΔT.`, basis: 'Specification §34 error budget' },
      { level: 'sustain', text: 'Recover the hot-bath heat with a water-to-water regenerator between the outgoing hot and incoming cold streams once V2 is reached.', basis: 'V4 regenerator integration' },
    ])));
  }
  draw();
}

function schematic(s) {
  const P = []; const L = (x1, y1, x2, y2, c = '#111', w = 1.5) => P.push({ type: 'line', x1, y1, x2, y2, c, w }); const R = (x, y, w, hh, c = '#111', fill = 'none') => P.push({ type: 'rect', x, y, w, h: hh, c, fill }); const C = (x, y, r, c = '#111') => P.push({ type: 'circle', x, y, r, c }); const T = (x, y, t, size = 11, c = '#111') => P.push({ type: 'text', x, y, t, size, c });
  R(250, 470, 300, 18, '#334', '#cbd5e1'); R(270, 60, 14, 410, '#334', '#e2e8f0'); R(516, 60, 14, 410, '#334', '#e2e8f0'); R(250, 44, 300, 22, '#334', '#cbd5e1'); T(258, 38, 'Rigid load frame / adjustable crosshead');
  R(380, 70, 40, 30, '#1d4ed8', '#dbeafe'); T(426, 90, `Load cell ${s.sensors.loadcell_N} N`, 11, '#1d4ed8');
  R(375, 104, 50, 18, '#111', '#e5e7eb'); T(430, 117, 'upper grip');
  R(330, 140, 140, 220, '#0f766e', '#ccfbf1'); T(334, 136, 'Heat-exchange jacket', 10, '#0f766e');
  for (let i = 0; i < 5; i++) L(392 + i * 4, 122, 392 + i * 4, 380, '#7c3aed', 1.2); T(330, 372, `Ribbon ×${s.ribbon.n}: ${s.ribbon.L_mm}×${s.ribbon.w_mm} mm × ${s.ribbon.t_um} µm`, 10, '#7c3aed');
  R(375, 380, 50, 18, '#111', '#e5e7eb'); T(430, 393, 'lower grip');
  L(400, 398, 400, 430); R(370, 430, 60, 26, '#111', '#fef3c7'); T(300, 448, s.bias === 'spring' ? 'bias spring + one-way clutch load' : 'dead weight + clutch load', 10);
  R(450, 400, 50, 12, '#b45309', '#ffedd5'); L(425, 406, 450, 406, '#b45309'); T(452, 426, `LVDT ±${s.sensors.lvdt_mm} mm`, 10, '#b45309');
  for (let i = 0; i < s.sensors.thermocouples; i++) { const y = 180 + i * 60; C(410, y, 5, '#dc2626'); T(414, y - 6, `TC${i + 1}`, 9, '#dc2626'); }
  R(30, 200, 120, 110, '#dc2626', '#fee2e2'); T(36, 196, `Hot bath ${s.thermal.Th} °C · ${s.thermal.bath_L.toFixed(0)} L`, 10, '#dc2626'); T(36, 330, `heater ${Math.ceil(s.thermal.heater_W)} W`, 10, '#dc2626');
  R(650, 200, 120, 110, '#2563eb', '#dbeafe'); T(652, 196, `Cold bath ${s.thermal.Tc} °C`, 10, '#2563eb');
  C(175, 230, 12, '#dc2626'); T(160, 214, 'pump', 9); C(625, 230, 12, '#2563eb'); T(612, 214, 'pump', 9);
  L(150, 230, 163, 230, '#dc2626'); L(187, 230, 230, 230, '#dc2626'); L(637, 230, 650, 230, '#2563eb'); L(570, 230, 613, 230, '#2563eb');
  R(230, 215, 30, 30, '#111', '#fff'); T(222, 262, '3-way valve', 9); R(540, 215, 30, 30, '#111', '#fff'); T(530, 262, '3-way valve', 9);
  L(260, 230, 330, 230, '#7c2d12', 2); L(470, 230, 540, 230, '#7c2d12', 2); T(268, 224, 'to jacket', 9); L(245, 245, 245, 300, '#7c2d12'); L(555, 245, 555, 300, '#7c2d12'); L(245, 300, 555, 300, '#7c2d12', 1); T(270, 314, 'switching manifolds: hot phase ↔ cold phase', 9);
  R(285, 222, 26, 16, '#065f46', '#d1fae5'); T(282, 252, 'ṁ', 11, '#065f46'); C(320, 230, 6, '#b91c1c'); T(306, 210, 'RTD in', 9, '#b91c1c'); C(480, 230, 6, '#b91c1c'); T(472, 210, 'RTD out', 9, '#b91c1c');
  L(330, 160, 310, 160, '#6b21a8'); L(470, 160, 490, 160, '#6b21a8'); T(472, 154, 'ΔP', 11, '#6b21a8'); L(310, 160, 310, 175, '#6b21a8'); L(490, 160, 490, 175, '#6b21a8');
  if (s.sensors.camera) { R(600, 120, 60, 30, '#111', '#e5e7eb'); L(600, 135, 470, 200, '#64748b', 1); T(600, 112, 'high-speed camera', 9); }
  R(14, 20, 772, 486, '#b91c1c'); T(20, 500, 'Safety enclosure — hard-wired over-temperature, pressure relief, force limit, emergency stop', 10, '#b91c1c');
  C(740, 60, 18, '#b91c1c'); T(726, 64, 'E-STOP', 9, '#b91c1c'); R(600, 380, 170, 60, '#334', '#f1f5f9'); T(606, 398, `DAQ ≥ ${s.daq_Hz} Hz, common timestamp`, 10); T(606, 416, `F, x, ${s.sensors.thermocouples}×TC, 4×RTD, 2×ṁ, ΔP`, 10);
  const svgEl = P.map(p => p.type === 'line' ? `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${p.c}" stroke-width="${p.w}"/>` : p.type === 'rect' ? `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" stroke="${p.c}" fill="${p.fill}" stroke-width="1.4"${p.c === '#b91c1c' && p.fill === 'none' ? ' stroke-dasharray="8 5"' : ''}/>` : p.type === 'circle' ? `<circle cx="${p.x}" cy="${p.y}" r="${p.r}" stroke="${p.c}" fill="#fff" stroke-width="1.6"/>` : `<text x="${p.x}" y="${p.y}" font-size="${p.size}" fill="${p.c}" font-family="system-ui,sans-serif">${String(p.t).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 520" width="100%" style="min-width:560px;max-width:900px;display:block">${svgEl}</svg>`;
  const Y = (y) => (520 - y).toFixed(2), e = ['0', 'SECTION', '2', 'ENTITIES'];
  for (const p of P) {
    if (p.type === 'line') e.push('0', 'LINE', '8', 'RIG', '10', p.x1, '20', Y(p.y1), '11', p.x2, '21', Y(p.y2));
    else if (p.type === 'rect') for (const [a, b, c2, d2] of [[p.x, p.y, p.x + p.w, p.y], [p.x + p.w, p.y, p.x + p.w, p.y + p.h], [p.x + p.w, p.y + p.h, p.x, p.y + p.h], [p.x, p.y + p.h, p.x, p.y]]) e.push('0', 'LINE', '8', 'RIG', '10', a, '20', Y(b), '11', c2, '21', Y(d2));
    else if (p.type === 'circle') e.push('0', 'CIRCLE', '8', 'SENSORS', '10', p.x, '20', Y(p.y), '40', p.r);
    else e.push('0', 'TEXT', '8', 'NOTES', '10', p.x, '20', Y(p.y), '40', p.size * 0.8, '1', String(p.t));
  }
  e.push('0', 'ENDSEC', '0', 'EOF');
  return { svg, dxf: e.join('\n'), prims: P };
}
