// THERMA-X100 engineering & experimental dossier generator. Builds, from the current project state and every
// supplied dataset, a complete document: document control, executive summary, principle of operation, design
// specification, materials, drawing register with dimensioned part / sub-assembly / general-arrangement / exploded
// drawings, experimental set-up (schematic, instrumentation), methodology, test conditions, input-data dossiers,
// analysis results, safety, manufacturing, economics, assumptions and revision history.
// Pure content: returns HTML strings, SVG sheets and chart specifications; the page renders and exports them.
import { store, hashObj, PROVENANCE, DEPENDS } from './state.js';
import { SUITES } from '../suites/index.js';
import { makeCtx, resolveParams } from './suite.js';
import { get as getMat, componentMaterial, COMPONENTS } from './materials.js';
import { designWith, engineModel, preScreen, REFERENCE_W_PER_KG, MILESTONES, ENGINE_FIELDS } from './engine.js';
import { quasiStaticCycle, phaseDiagram } from './sma.js';
import { fluid, carnot, KELVIN } from './heat.js';
import { Mesh, box, cylinder } from './cad.js';
import { partSheet, explodedSheet, viewsDXF, HATCH_DEFS, mm } from './drafting.js';
import { fmt } from './num.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const T = (cols, rows, cls = '') => `<table class="dz-table ${cls}"><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${typeof c === 'string' && c.startsWith('<') ? c : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const P = (t) => `<p>${t}</p>`, H3 = (t) => `<h3>${esc(t)}</h3>`, UL = (a) => `<ul>${a.map(x => `<li>${x}</li>`).join('')}</ul>`, OL = (a) => `<ol>${a.map(x => `<li>${x}</li>`).join('')}</ol>`;
const n3 = (v, s = 4) => (typeof v === 'number' && Number.isFinite(v) ? fmt(v, s) : '—');
const kg = (m) => (m < 0.1 ? `${fmt(m * 1000, 3)} g` : `${fmt(m, 4)} kg`);
const provBadge = (p) => { const d = PROVENANCE[p] || PROVENANCE.estimated; return `<span class="prov ${d.cls}">${esc(d.label)}</span>`; };
function clone(src, name) { const m = new Mesh(name || src.name, { color: src.color, group: src.group }); m.p = src.p.slice(); m.i = src.i.slice(); m.component = src.component; return m; }
function centre(m) { const b = m.bbox(); return m.translate(-(b[0] + b[3]) / 2, -(b[1] + b[4]) / 2, -(b[2] + b[5]) / 2); }

// ---------------- inputs fingerprint (what the dossier depends on) ----------------
export function inputsSignature() {
  const pr = store.project; const ds = [];
  for (const [id, list] of Object.entries(pr.experiments || {})) for (const d of list) ds.push([id, d.name, d.nRows, d.use, d.prov]);
  for (const d of pr.lab?.datasets || []) ds.push(['lab', d.name, d.n || d.rows?.length || 0, d.provenance]);
  return { hash: hashObj({ engine: pr.engine, site: pr.site, materials: pr.materials, params: pr.params, locks: pr.locks, ds, lab: (pr.lab?.protocols || []).map(p => [p.id, p.version, p.hash]) }), datasets: ds.length };
}

// ---------------- geometry from the CAD suite (identical solids) ----------------
async function geometry() {
  const meta = SUITES.find(s => s.id === 's02'), mod = await meta.load(), def = { ...meta, ...mod.default };
  const ctx = makeCtx(def); const { values: p } = resolveParams(def, ctx, false);
  const design = designWith(store.project.engine, ctx.upstream('s01')?.design || {}), alloy = getMat(p.alloy) || getMat(design.alloy) || getMat('niti-lt');
  const G = mod.buildEngineGeometry(p, { alloy, stroke05: ctx.upstream('s05')?.stroke_m });
  const cart = mod.buildCartridge(G.g, '');
  return { p, design, alloy, G, cart };
}

// ---------------- drawing register ----------------
function partCatalogue(geo) {
  const { p, alloy, G, cart } = geo, g = G.g, N = G.N, mat = (k) => (k === 'ribbon' ? alloy : componentMaterial(store, k));
  const byName = (s) => cart.parts.find(m => m.name.startsWith(s));
  const massOf = (m, comp) => { const mt = mat(comp); let V = m.volume(); if (comp === 'channelPlate') V -= g.nChPlate * p.chW_mm / 1e3 * p.chH_mm / 1e3 * (g.L - g.plateGap); if (m.shellT) V = m.area() * m.shellT; return V * (mt?.rho || 0); };
  const springRate = (() => { const Gs = 76e9, d = g.springWire, D = g.springD, n = Math.max(1, g.springCoils); return Gs * d ** 4 / (8 * D ** 3 * n); })();
  const A = g.nRib * g.w * g.t, Fpre = (geo.design.sigmaL || 70) * 1e6 * A, Fpow = (geo.design.sigmaH || 110) * 1e6 * A;
  const L = [];
  const add = (o) => L.push({ qtyPerCell: 1, ...o });
  add({ no: 'TX-100-101', name: 'SMA ribbon', comp: 'ribbon', mesh: box('SMA ribbon', g.L, g.w, g.t, { color: '#c58b4b' }), qtyPerCell: g.nRib, dims: [['Active length L', `${mm(g.L)} mm`], ['Width w', `${mm(g.w)} mm`], ['Thickness t', `${mm(g.t, 3)} mm`], ['Ribbons per cartridge', g.nRib], ['Transformation Mf / Ms / As / Af', `${alloy.Mf} / ${alloy.Ms} / ${alloy.As} / ${alloy.Af} °C (stress-free)`], ['Max recoverable strain', `${fmt(alloy.epsL * 100, 3)} %`], ['Design stroke', `${mm(G.stroke, 3)} mm`], ['Edge finish', 'Deburred, electropolished, no notches'], ['Heat treatment', 'Shape-set 450–550 °C, trained (see Suite 20)']], detail: 'ribbon' });
  add({ no: 'TX-100-102', name: 'Microchannel heat-exchange plate', comp: 'channelPlate', mesh: box('Plate', g.L - g.plateGap, g.plateW, g.tPlate, { color: '#b8c0cc' }), qtyPerCell: G.nPlates, dims: [['Plate length', `${mm(g.L - g.plateGap)} mm`], ['Plate width', `${mm(g.plateW)} mm`], ['Plate thickness', `${mm(g.tPlate, 3)} mm`], ['Channels per plate', g.nChPlate], ['Channel W × H', `${p.chW_mm} × ${p.chH_mm} mm`], ['Channel pitch', `${mm(G.pitch, 3)} mm`], ['Web / skin', `${p.web_mm} / ${p.skin_mm} mm`], ['Plates per cartridge', G.nPlates], ['Leak test', '1.5 × max operating pressure, 10 min']], detail: 'plate' });
  for (const [s, no, comp, nm, dimsFn] of [
    ['Moving grip', 'TX-100-103', 'grip', 'Moving grip', () => [['Length', `${mm(g.gripL)} mm`], ['Width', `${mm(g.Wc)} mm`], ['Height', `${mm(g.Hc)} mm`], ['Clamping', 'Serrated jaw, M3 ×4 at 1.2 N·m'], ['Edge radius on ribbon side', 'R0.5 min (stress relief)']]],
    ['Fixed grip', 'TX-100-104', 'grip', 'Fixed grip', () => [['Length', `${mm(g.gripL)} mm`], ['Width', `${mm(g.Wc)} mm`], ['Height', `${mm(g.Hc)} mm`], ['Clamping', 'Serrated jaw, M3 ×4 at 1.2 N·m']]],
    ['Carriage', 'TX-100-105', 'carriage', 'Carriage', () => [['Length', `${mm(g.carL)} mm`], ['Width', `${mm(g.Wc * 0.9)} mm`], ['Height', `${mm(g.Hc * 0.9)} mm`], ['Travel', `${p.travel_mm} mm`], ['Guide fit', 'H7/g6 sliding']]],
    ['Push rod', 'TX-100-106', 'carriage', 'Push rod', () => [['Diameter', `Ø${p.rodD_mm} mm`], ['Length', `${mm(g.rodL)} mm`], ['Ends', 'M4 thread, 8 mm engagement']]],
    ['Bias spring', 'TX-100-107', 'biasSpring', 'Bias (return) spring', () => [['Mean coil Ø', `Ø${p.springD_mm} mm`], ['Wire Ø', `Ø${p.springWire_mm} mm`], ['Active coils', g.springCoils], ['Free length', `${p.springFree_mm} mm`], ['Rate (G = 76 GPa)', `${fmt(springRate / 1000, 4)} N/mm`], ['Reset preload σL·A', `${fmt(Fpre, 4)} N`], ['Ends', 'Closed and ground']]],
    ['Housing sleeve', 'TX-100-108', 'housing', 'Housing sleeve', () => [['Outer W × H', `${mm(g.Wout)} × ${mm(g.Hout)} mm`], ['Wall', `${p.wall_mm} mm`], ['Bore W × H', `${mm(g.Wc)} × ${mm(g.Hc)} mm`]]],
    ['Inner flange', 'TX-100-109', 'housing', 'Inner flange', () => [['Flange thickness', `${p.wall_mm} mm`], ['Rod bore', `Ø${fmt(p.rodD_mm + 0.8, 3)} mm`]]],
    ['End cap', 'TX-100-110', 'housing', 'End cap', () => [['Thickness', `${p.wall_mm} mm`], ['Section', `${mm(g.Wc)} × ${mm(g.Hc)} mm`]]],
    ['Hot port', 'TX-100-111', 'manifold', 'Hot fluid port', () => [['Bore', `Ø${mm(g.portD)} mm`], ['Length', `${mm(g.portL)} mm`], ['Connection', 'Push-in, EPDM seal']]],
    ['Cold port', 'TX-100-112', 'manifold', 'Cold fluid port', () => [['Bore', `Ø${mm(g.portD)} mm`], ['Length', `${mm(g.portL)} mm`], ['Connection', 'Push-in, EPDM seal']]],
  ]) { const m0 = byName(s); if (m0) add({ no, name: nm, comp, mesh: clone(m0, nm), dims: dimsFn() }); }
  const ep = (m, no, name, comp, dims) => add({ no, name, comp, mesh: clone(m, name), qtyPerCell: 0, qty: 1, dims });
  ep(G.rotor, 'TX-100-201', 'Rotor / flywheel disc', 'rotor', [['Diameter', `Ø${fmt(2 * G.rotorR * 1000, 4)} mm`], ['Thickness', `${p.rotorT_mm} mm`], ['Bore', `Ø${p.shaftD_mm} mm H7`], ['Balance grade', 'G 2.5 (ISO 21940-11)']]);
  ep(G.shaft, 'TX-100-202', 'Output shaft', 'shaft', [['Diameter', `Ø${p.shaftD_mm} mm h6`], ['Length', `${mm(G.shaftL)} mm`], ['Keyway', 'Per ISO/R 773 at the output end']]);
  ep(G.mHot, 'TX-100-203', 'Hot manifold ring', 'manifold', [['Ring mean Ø', `Ø${fmt(2 * G.rPort * 1000, 4)} mm`], ['Tube Ø', `Ø${fmt(2 * G.rM * 1000, 3)} mm`], ['Wall', '1.5 mm'], ['Ports', `${N} × Ø${mm(g.portD)} mm`]]);
  ep(G.mCold, 'TX-100-204', 'Cold manifold ring', 'manifold', [['Ring mean Ø', `Ø${fmt(2 * G.rPort * 1000, 4)} mm`], ['Tube Ø', `Ø${fmt(2 * G.rM * 1000, 3)} mm`], ['Wall', '1.5 mm'], ['Ports', `${N} × Ø${mm(g.portD)} mm`]]);
  ep(G.casing, 'TX-100-205', 'Casing shell', 'casing', [['Outer Ø', `Ø${fmt(2 * (G.Rcase + G.tCase) * 1000, 4)} mm`], ['Inner Ø', `Ø${fmt(2 * G.Rcase * 1000, 4)} mm`], ['Length', `${mm(G.Lcase)} mm`], ['Containment', 'Sized for ribbon/rotor fragment containment (Suite 21)']]);
  ep(G.endA, 'TX-100-206', 'Front end plate', 'casing', [['Diameter', `Ø${fmt(2 * (G.Rcase + G.tCase) * 1000, 4)} mm`], ['Thickness', `${mm(G.tCase)} mm`], ['Bearing seat', `Ø${p.shaftD_mm} mm shaft bearing`]]);
  ep(G.endB, 'TX-100-207', 'Rear end plate', 'casing', [['Diameter', `Ø${fmt(2 * (G.Rcase + G.tCase) * 1000, 4)} mm`], ['Thickness', `${mm(G.tCase)} mm`]]);
  const AX = { 'Push rod': 'x', 'Bias (return) spring': 'x', 'Inner flange': 'x', 'Hot fluid port': 'z', 'Cold fluid port': 'z', 'Rotor / flywheel disc': 'z', 'Output shaft': 'z', 'Hot manifold ring': 'z', 'Cold manifold ring': 'z', 'Casing shell': 'z', 'Front end plate': 'z', 'Rear end plate': 'z' };
  for (const it of L) { it.round = AX[it.name] || null; it.material = mat(it.comp)?.name || '—'; it.qty = it.qty ?? it.qtyPerCell * N; it.mass = massOf(it.mesh, it.comp); centre(it.mesh); }
  return { list: L, Fpre, Fpow, springRate };
}

function detailSVG(kind, geo) {
  const { p, G } = geo, g = G.g;
  if (kind === 'ribbon') {
    const W = 140, s = (W - 30) / (g.w * 1000), h = Math.max(1.2, g.t * 1000 * s), x = 15, y = 10;
    const svg = `<text x="0" y="4" font-size="3.2" font-weight="700">SECTION A–A (ribbon) · ${fmt(s, 3)}:1</text><rect x="${x}" y="${y}" width="${g.w * 1000 * s}" height="${h}" fill="url(#hatchX)" stroke="#111" stroke-width="0.35"/>
      <path d="M${x} ${y + h + 2}V${y + h + 7}M${x + g.w * 1000 * s} ${y + h + 2}V${y + h + 7}M${x} ${y + h + 6}H${x + g.w * 1000 * s}" stroke="#111" stroke-width="0.18" fill="none"/><text x="${x + g.w * 500 * s}" y="${y + h + 5}" font-size="3" text-anchor="middle">${mm(g.w)}</text>
      <path d="M${x + g.w * 1000 * s + 2} ${y}H${x + g.w * 1000 * s + 9}M${x + g.w * 1000 * s + 2} ${y + h}H${x + g.w * 1000 * s + 9}" stroke="#111" stroke-width="0.18"/><text x="${x + g.w * 1000 * s + 11}" y="${y + h / 2 + 1}" font-size="3">t = ${mm(g.t, 3)}</text>`;
    return { svg, h: y + h + 10 };
  }
  if (kind === 'plate') {
    const W = 140, s = (W - 20) / (g.plateW * 1000), th = g.tPlate * 1000 * s, x = 10, y = 9, chW = p.chW_mm * s, chH = p.chH_mm * s, web = p.web_mm * s;
    let ch = ''; for (let i = 0; i < g.nChPlate; i++) { const cx = x + (g.plateW - g.w) / 2 * 1000 * s + (i + 0.5) * G.pitch * 1000 * s - chW / 2; ch += `<rect x="${cx.toFixed(2)}" y="${(y + web).toFixed(2)}" width="${chW.toFixed(2)}" height="${chH.toFixed(2)}" fill="#fff" stroke="#111" stroke-width="0.25"/>`; }
    const svg = `<text x="0" y="4" font-size="3.2" font-weight="700">SECTION B–B (plate) · ${fmt(s, 3)}:1</text><rect x="${x}" y="${y}" width="${g.plateW * 1000 * s}" height="${th}" fill="url(#hatch)" stroke="#111" stroke-width="0.35"/>${ch}
      <text x="${x}" y="${y + th + 5}" font-size="2.8">${g.nChPlate} channels ${p.chW_mm} × ${p.chH_mm} mm at ${mm(G.pitch, 3)} mm pitch; web ${p.web_mm} mm; plate ${mm(g.tPlate, 3)} × ${mm(g.plateW)} mm</text>`;
    return { svg, h: y + th + 8 };
  }
  if (kind === 'stack') {
    const W = 140, layers = []; let z = 0; const nShow = Math.min(3, g.nRib);
    for (let k = 0; k < nShow; k++) { layers.push(['plate', g.tPlate]); layers.push(['contact', g.tc]); layers.push(['ribbon', g.t]); layers.push(['contact', g.tc]); } layers.push(['plate', g.tPlate]);
    const tot = layers.reduce((a, l) => a + l[1], 0), s = Math.min(60 / (tot * 1000), (W - 50) / (g.plateW * 1000)), x = 8, y = 8; let svg = `<text x="0" y="4" font-size="3.2" font-weight="700">DETAIL C — plate / contact / ribbon stack (${nShow} of ${g.nRib} ribbons) · ${fmt(s, 3)}:1</text>`;
    for (const [kind2, t] of layers) { const h = Math.max(0.5, t * 1000 * s), wide = (kind2 === 'ribbon' ? g.w : g.plateW) * 1000 * s, off = (g.plateW * 1000 * s - wide) / 2; svg += `<rect x="${(x + off).toFixed(2)}" y="${(y + z).toFixed(2)}" width="${wide.toFixed(2)}" height="${h.toFixed(2)}" fill="${kind2 === 'plate' ? 'url(#hatch)' : kind2 === 'ribbon' ? 'url(#hatchX)' : '#e5e7eb'}" stroke="#111" stroke-width="0.2"/>`; if (kind2 !== 'contact' || h > 1.5) svg += `<text x="${(x + g.plateW * 1000 * s + 3).toFixed(2)}" y="${(y + z + h / 2 + 1).toFixed(2)}" font-size="2.5">${kind2 === 'plate' ? 'channel plate ' + mm(g.tPlate, 3) : kind2 === 'ribbon' ? 'SMA ribbon ' + mm(g.t, 3) : 'contact layer ' + mm(g.tc, 3)}</text>`; z += h; }
    return { svg, h: y + z + 4 };
  }
  return null;
}

export async function buildDrawings(rev, onStep = () => { }) {
  const geo = await geometry(), cat = partCatalogue(geo), { G, design } = geo, list = cat.list, sheets = [];
  const total = list.length + 4; let sn = 0;
  const meta = (title, no, extra = {}) => ({ title, dwgNo: no, rev, sheetNo: ++sn, sheets: total, project: `THERMA-X100 · ${store.project.name}`, author: store.project.author, ...extra });
  const light = (m) => (m.component === 'casing' ? '#cbd5e1' : m.component === 'housing' ? '#93b4d6' : m.color);
  const engineParts = G.parts.filter(m => !/end plate/.test(m.name)).map(m => ({ mesh: m, color: light(m) }));
  const massAll = list.reduce((a, it) => a + it.mass * it.qty, 0);
  onStep('General arrangement');
  const ga = partSheet({ parts: engineParts, meta: meta('Engine general arrangement', 'TX-100-000', { material: 'See parts list', mass: `${fmt(massAll, 4)} kg`, qty: 1, notes: ['Radial multicell engine: ' + G.N + ' stationary SMA cartridges drive the central rotor through one-way clutches.', 'Hot (red) and cold (blue) manifold rings feed alternate cartridge phases via rotary distribution valves.', 'End plates removed for clarity (see TX-100-001, TX-100-206/207); cartridge internals on TX-100-100.', 'Dimensions in mm from the parametric model of this dossier revision.'] }), keyDims: [['Cartridges', G.N], ['Casing outer Ø', `${fmt(2 * (G.Rcase + G.tCase) * 1000, 4)} mm`], ['Casing length', `${mm(G.Lcase)} mm`], ['Shaft Ø × length', `Ø${geo.p.shaftD_mm} × ${mm(G.shaftL)} mm`], ['Cartridge inner radius', `${mm(G.rInner)} mm`], ['Rotor Ø', `${fmt(2 * G.rotorR * 1000, 4)} mm`], ['Active SMA mass', `${fmt(G.N * geo.alloy.rho * G.g.L * G.g.w * G.g.t * G.nRib, 4)} kg`], ['Hot / cold reservoirs', `${design.Th} / ${design.Tc} °C`]] });
  sheets.push({ id: 'TX-100-000', title: 'Engine general arrangement (front, top, right, isometric)', ...ga, kind: 'assembly' });
  onStep('Exploded engine');
  const offset = (m) => { const b = m.bbox(), c = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]; if (m.component === 'casing') return m.name.startsWith('Front') ? [0, 0, 0.18] : m.name.startsWith('Rear') ? [0, 0, -0.18] : [0, 0, 0.32]; if (m.component === 'manifold' && m.cartridge === undefined) return [0, 0, Math.sign(c[2]) * 0.12]; if (m.component === 'shaft') return [0, 0, -0.42]; if (m.component === 'rotor') return [0, 0, -0.26]; if (m.cartridge !== undefined) { const r = Math.hypot(c[0], c[1]) || 1; return [c[0] / r * 0.12, c[1] / r * 0.12, 0]; } return [0, 0, 0]; };
  const grp = (pred) => G.parts.filter(pred).map(m => ({ mesh: m, color: light(m), offset: offset(m) }));
  const exItems = [
    { n: 1, parts: grp(m => m.name === 'Casing shell'), desc: 'Casing shell', partNo: 'TX-100-205', material: componentMaterial(store, 'casing')?.name, qty: 1, mass: kg(list.find(x => x.no === 'TX-100-205').mass) },
    { n: 2, parts: grp(m => m.name === 'Front end plate'), desc: 'Front end plate', partNo: 'TX-100-206', material: componentMaterial(store, 'casing')?.name, qty: 1, mass: kg(list.find(x => x.no === 'TX-100-206').mass) },
    { n: 3, parts: grp(m => m.name === 'Rear end plate'), desc: 'Rear end plate', partNo: 'TX-100-207', material: componentMaterial(store, 'casing')?.name, qty: 1, mass: kg(list.find(x => x.no === 'TX-100-207').mass) },
    { n: 4, parts: grp(m => m.name === 'Hot manifold ring'), desc: 'Hot manifold ring', partNo: 'TX-100-203', material: componentMaterial(store, 'manifold')?.name, qty: 1, mass: kg(list.find(x => x.no === 'TX-100-203').mass) },
    { n: 5, parts: grp(m => m.name === 'Cold manifold ring'), desc: 'Cold manifold ring', partNo: 'TX-100-204', material: componentMaterial(store, 'manifold')?.name, qty: 1, mass: kg(list.find(x => x.no === 'TX-100-204').mass) },
    { n: 6, parts: grp(m => m.component === 'rotor'), desc: 'Rotor / flywheel disc', partNo: 'TX-100-201', material: componentMaterial(store, 'rotor')?.name, qty: 1, mass: kg(list.find(x => x.no === 'TX-100-201').mass) },
    { n: 7, parts: grp(m => m.component === 'shaft'), desc: 'Output shaft', partNo: 'TX-100-202', material: componentMaterial(store, 'shaft')?.name, qty: 1, mass: kg(list.find(x => x.no === 'TX-100-202').mass) },
    { n: 8, parts: grp(m => m.cartridge !== undefined), desc: 'Cartridge assembly', partNo: 'TX-100-100', material: 'See TX-100-100', qty: G.N, mass: kg(list.filter(x => x.qtyPerCell).reduce((a, x) => a + x.mass * x.qtyPerCell, 0)) },
  ];
  const ex = explodedSheet({ items: exItems, meta: meta('Engine exploded assembly & parts list', 'TX-100-001', { material: 'See parts list', mass: `${fmt(massAll, 4)} kg`, qty: 1 }), explode: true });
  sheets.push({ id: 'TX-100-001', title: 'Engine exploded isometric with balloons and parts list', ...ex, kind: 'assembly' });
  onStep('Cartridge sub-assembly');
  const cartParts = geo.cart.parts.map(m => ({ mesh: m, color: light(m) })), cartOrtho = cartParts.filter(x => !/Housing sleeve/.test(x.mesh.name));
  const stack = detailSVG('stack', geo);
  const cga = partSheet({ parts: cartParts, meta: meta('Cartridge sub-assembly', 'TX-100-100', { material: 'See parts list', mass: kg(list.filter(x => x.qtyPerCell).reduce((a, x) => a + x.mass * x.qtyPerCell, 0)), qty: G.N, notes: ['Ribbons clamped between moving and fixed grips; heat exchanged through the microchannel plate stack.', `Assemble with reset preload ${fmt(cat.Fpre, 4)} N (σL·A); verify with load cell before closing the housing.`, 'Orthographic views drawn with the housing sleeve omitted to show the load train; the isometric view shows the closed cartridge.'] }), orthoParts: cartOrtho, keyDims: [['Overall length', `${mm(G.cartLen)} mm`], ['Outer W × H', `${mm(G.g.Wout)} × ${mm(G.g.Hout)} mm`], ['Ribbons × plates', `${G.nRib} × ${G.nPlates}`], ['Reset preload σL·A', `${fmt(cat.Fpre, 4)} N`], ['Power-stroke load σH·A', `${fmt(cat.Fpow, 4)} N`], ['Design stroke', `${mm(G.stroke, 3)} mm`]], detail: stack });
  sheets.push({ id: 'TX-100-100', title: 'Cartridge sub-assembly (front, top, right, isometric, stack detail)', ...cga, kind: 'assembly' });
  const cOff = (m) => { const nm = m.name; if (/Moving grip/.test(nm)) return [-0.018, 0, 0]; if (/Carriage|Push rod/.test(nm)) return [-0.032, 0, 0]; if (/Bias spring/.test(nm)) return [-0.05, 0, 0]; if (/Inner flange/.test(nm)) return [-0.068, 0, 0]; if (/Fixed grip/.test(nm)) return [0.018, 0, 0]; if (/End cap/.test(nm)) return [0.034, 0, 0]; if (/Hot port/.test(nm)) return [0, 0, 0.022]; if (/Cold port/.test(nm)) return [0, 0, -0.022]; if (/plate stack/.test(nm)) return [0, 0, -0.012]; return [0, 0, 0]; };
  const NAMEMAP = { 'SMA ribbon bundle': 'TX-100-101', 'Microchannel plate stack': 'TX-100-102', 'Moving grip': 'TX-100-103', 'Fixed grip': 'TX-100-104', 'Carriage': 'TX-100-105', 'Push rod': 'TX-100-106', 'Bias spring': 'TX-100-107', 'Inner flange': 'TX-100-109', 'End cap': 'TX-100-110', 'Hot port': 'TX-100-111', 'Cold port': 'TX-100-112' };
  const cItems = geo.cart.parts.filter(m => !/Housing sleeve/.test(m.name)).map((m, i) => { const key = Object.keys(NAMEMAP).find(k => m.name.startsWith(k)), it = list.find(x => x.no === NAMEMAP[key]) || {}; return { n: i + 1, parts: [{ mesh: m, color: light(m), offset: cOff(m) }], desc: m.name, partNo: it.no || '—', material: componentMaterial(store, m.component)?.name || geo.alloy.name, qty: /ribbon bundle/.test(m.name) ? G.nRib : /plate stack/.test(m.name) ? G.nPlates : 1, mass: it.mass ? kg(it.mass * (/ribbon bundle/.test(m.name) ? G.nRib : /plate stack/.test(m.name) ? G.nPlates : 1)) : '' }; });
  const cex = explodedSheet({ items: cItems, meta: meta('Cartridge exploded view & parts list', 'TX-100-099', { material: 'See parts list', qty: G.N }), explode: true });
  sheets.push({ id: 'TX-100-099', title: 'Cartridge exploded isometric with balloons and parts list', ...cex, kind: 'assembly' });
  for (const it of list) {
    onStep(it.name);
    const det = it.detail ? detailSVG(it.detail, geo) : null;
    const sh = partSheet({ parts: [{ mesh: it.mesh, color: it.mesh.color }], meta: meta(it.name, it.no, { material: it.material, mass: kg(it.mass), qty: it.qty, notes: it.comp === 'ribbon' ? ['Ribbon must be free of edge burrs and scratches (fatigue-critical).', 'Record lot number, chemistry certificate and DSC curve for each lot.'] : it.comp === 'channelPlate' ? ['Pressure test each plate; record flow resistance per plate.', 'Channel edges deburred; no blockage permitted.'] : [] }), keyDims: it.dims, detail: det, round: it.round });
    sheets.push({ id: it.no, title: `${it.name} — detail drawing`, ...sh, kind: 'part', dxf: viewsDXF(sh.views, it.name) });
    await new Promise(r => setTimeout(r, 0));
  }
  for (const s of sheets) if (!s.dxf && s.views) s.dxf = viewsDXF(s.views, s.title);
  return { sheets, cat, geo };
}

// ---------------- schematic diagrams (SVG) ----------------
export function setupSchematic(d, eng) {
  const lab = (x, y, t, a = 'middle', sz = 12, w = 400) => `<text x="${x}" y="${y}" font-size="${sz}" text-anchor="${a}" font-weight="${w}">${esc(t)}</text>`;
  const tag = (x, y, t, c = '#111') => `<g><circle cx="${x}" cy="${y}" r="13" fill="#fff" stroke="${c}" stroke-width="1.4"/><text x="${x}" y="${y + 4}" font-size="9.5" text-anchor="middle" font-weight="700" fill="${c}">${t}</text></g>`;
  const pipe = (pts, c, dash = '') => `<path d="M${pts.map(p => p.join(' ')).join('L')}" fill="none" stroke="${c}" stroke-width="4" ${dash ? `stroke-dasharray="${dash}"` : ''} stroke-linejoin="round" marker-mid="url(#flow-${c === '#dc2626' ? 'h' : c === '#2563eb' ? 'c' : 'r'})"/>`;
  const sig = (pts) => `<path d="M${pts.map(p => p.join(' ')).join('L')}" fill="none" stroke="#475569" stroke-width="1.2" stroke-dasharray="5 4"/>`;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600" font-family="Arial, Helvetica, sans-serif" class="dz-diagram"><defs>${['h:#dc2626', 'c:#2563eb', 'r:#7c3aed'].map(x => { const [k, c] = x.split(':'); return `<marker id="flow-${k}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`; }).join('')}</defs><rect width="1000" height="600" fill="#fff"/>`;
  s += lab(500, 26, 'EXPERIMENTAL SET-UP — single-cartridge calorimetric work-cycle rig (spec §41) and multicell dynamometer extension', 'middle', 15, 700);
  // hot loop
  s += `<rect x="30" y="70" width="170" height="120" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>` + lab(115, 95, 'HOT BATH / SOURCE', 'middle', 12, 700) + lab(115, 115, `${d.Th} °C, ${fluid(d.hotFluid, d.Th).name}`) + lab(115, 133, `heater + PID thermostat`) + lab(115, 151, `ṁ ≈ ${fmt(eng?.mdotH ?? 0, 3)} kg/s`) + lab(115, 169, 'over-temperature cut-out');
  s += `<rect x="30" y="400" width="170" height="120" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>` + lab(115, 425, 'COLD BATH / SINK', 'middle', 12, 700) + lab(115, 445, `${d.Tc} °C, ${fluid(d.coldFluid, d.Tc).name}`) + lab(115, 463, 'chiller or tower loop') + lab(115, 481, `ṁ ≈ ${fmt(eng?.mdotC ?? 0, 3)} kg/s`);
  s += pipe([[200, 110], [270, 110], [270, 220], [380, 220]], '#dc2626') + tag(240, 95, 'P-1', '#dc2626') + tag(300, 200, 'FM-1', '#dc2626') + tag(345, 240, 'TT-1', '#dc2626');
  s += pipe([[200, 460], [270, 460], [270, 330], [380, 330]], '#2563eb') + tag(240, 480, 'P-2', '#2563eb') + tag(300, 350, 'FM-2', '#2563eb') + tag(345, 310, 'TT-2', '#2563eb');
  // switching valves & cartridge
  s += `<polygon points="380,205 410,220 380,235" fill="#fff" stroke="#111" stroke-width="2"/><polygon points="440,205 410,220 440,235" fill="#fff" stroke="#111" stroke-width="2"/>` + lab(410, 195, 'XV-1 hot valve', 'middle', 10);
  s += `<polygon points="380,315 410,330 380,345" fill="#fff" stroke="#111" stroke-width="2"/><polygon points="440,315 410,330 440,345" fill="#fff" stroke="#111" stroke-width="2"/>` + lab(410, 365, 'XV-2 cold valve', 'middle', 10);
  s += pipe([[440, 220], [490, 220], [490, 255]], '#dc2626') + pipe([[440, 330], [490, 330], [490, 295]], '#2563eb');
  s += `<rect x="490" y="235" width="250" height="80" rx="6" fill="#fef3c7" stroke="#92400e" stroke-width="2"/>` + `<rect x="505" y="268" width="220" height="14" fill="#c58b4b" stroke="#78350f"/>` + lab(615, 253, `SMA CARTRIDGE TX-100-100 (${d.ribbonsPerCell} ribbons)`, 'middle', 11, 700) + lab(615, 303, 'microchannel plates · contact layers', 'middle', 10);
  s += `<rect x="470" y="262" width="20" height="26" fill="#8b9bb4" stroke="#111"/><rect x="740" y="262" width="20" height="26" fill="#8b9bb4" stroke="#111"/>` + lab(480, 300, 'grip', 'middle', 9) + lab(750, 300, 'grip', 'middle', 9);
  s += tag(560, 222, 'TT-3') + tag(620, 222, 'TT-4') + tag(680, 222, 'TT-5') + lab(620, 205, 'ribbon thermocouples (bulk, contact)', 'middle', 9);
  // return to regen and baths
  s += pipe([[740, 250], [800, 250], [800, 140], [200, 140]], '#dc2626', '8 5') + lab(520, 133, 'hot return (via regenerator HX-1)', 'middle', 10) + tag(800, 200, 'TT-6', '#dc2626');
  s += pipe([[740, 300], [800, 300], [800, 420], [200, 420]], '#2563eb', '8 5') + lab(520, 437, 'cold return', 'middle', 10) + tag(800, 360, 'TT-7', '#2563eb');
  s += `<rect x="770" y="160" width="60" height="30" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>` + lab(800, 180, 'HX-1', 'middle', 10, 700);
  // load train
  s += `<line x1="470" y1="275" x2="410" y2="275" stroke="#111" stroke-width="3"/><rect x="385" y="262" width="26" height="26" fill="#e2e8f0" stroke="#111"/>` + tag(398, 255 - 6, 'LC-1') + lab(370, 300, 'load cell', 'end', 9);
  s += `<path d="M385 275H340" stroke="#111" stroke-width="3"/><path d="M340 262v26M330 262v26M320 262v26" stroke="#111" stroke-width="1.5"/>` + lab(330, 255, 'bias spring', 'middle', 9);
  s += `<path d="M760 275H860" stroke="#111" stroke-width="3"/><rect x="860" y="250" width="50" height="50" fill="#e2e8f0" stroke="#111"/>` + lab(885, 320, 'one-way clutch', 'middle', 9) + `<circle cx="950" cy="275" r="28" fill="#f1f5f9" stroke="#111" stroke-width="2"/>` + lab(950, 279, 'DYNO', 'middle', 10, 700) + tag(950, 225, 'TQ-1') + tag(905, 225, 'ENC');
  s += tag(780, 245, 'DX-1') + lab(800, 233, 'LVDT', 'start', 9);
  // DAQ & safety
  s += `<rect x="560" y="470" width="220" height="90" rx="8" fill="#f8fafc" stroke="#475569" stroke-width="2"/>` + lab(670, 495, 'DAQ + CONTROLLER (common timestamp)', 'middle', 11, 700) + lab(670, 515, 'thermocouples · flow · pressure · force', 'middle', 9) + lab(670, 530, 'stroke · torque · speed · power meter', 'middle', 9) + lab(670, 548, 'valve sequencing · software interlocks', 'middle', 9);
  s += sig([[560, 222], [560, 470]]) + sig([[398, 262], [398, 520], [560, 520]]) + sig([[780, 258], [780, 470]]) + sig([[950, 303], [950, 545], [780, 545]]) + sig([[345, 240], [345, 500], [560, 500]]);
  s += `<rect x="830" y="470" width="150" height="90" rx="8" fill="#fef2f2" stroke="#b91c1c" stroke-width="2"/>` + lab(905, 495, 'HARDWARE SAFETY', 'middle', 11, 700) + lab(905, 513, 'E-stop · PRV · over-temp', 'middle', 9) + lab(905, 528, 'overspeed trip · guards', 'middle', 9) + lab(905, 543, 'leak detection', 'middle', 9);
  s += `<g font-size="10"><rect x="30" y="540" width="500" height="50" fill="#fff" stroke="#cbd5e1"/><line x1="40" y1="555" x2="70" y2="555" stroke="#dc2626" stroke-width="4"/><text x="76" y="559">hot supply</text><line x1="150" y1="555" x2="180" y2="555" stroke="#2563eb" stroke-width="4"/><text x="186" y="559">cold supply</text><line x1="260" y1="555" x2="290" y2="555" stroke="#dc2626" stroke-width="4" stroke-dasharray="8 5"/><text x="296" y="559">return</text><line x1="360" y1="555" x2="390" y2="555" stroke="#475569" stroke-width="1.2" stroke-dasharray="5 4"/><text x="396" y="559">signal</text><text x="40" y="580">Tags (ISA-5.1 style): P pump · FM flow meter · TT temperature transmitter · XV switching valve · LC load cell · DX displacement · TQ torque · ENC encoder</text></g>`;
  return s + '</svg>';
}
export function cycleDiagram(d, a) {
  const st = [['1 · Cold preparation', `Martensite at ≤ ${fmt(a.Mf + d.sigmaL / a.CM, 3)} °C (Mf at σL); ribbon held extended by the bias load σL = ${d.sigmaL} MPa`, '#2563eb'], ['2 · Heat admission', `Hot fluid ${d.Th} °C enters; reverse transformation from As(σH) = ${fmt(a.As + d.sigmaH / a.CA, 3)} °C`, '#f97316'], ['3 · Power stroke', `Ribbon contracts against σH = ${d.sigmaH} MPa; one-way clutch drives the rotor`, '#dc2626'], ['4 · Isolation & cool-down', `Hot valve closes; cold fluid ${d.Tc} °C; heat to regenerator and sink`, '#0ea5e9'], ['5 · Reset stroke', `Bias load re-extends the cold martensite (detwinning above σs = ${a.sigS} MPa); clutch freewheels`, '#6366f1']];
  const cx = 500, cy = 300, R = 210; let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600" font-family="Arial, Helvetica, sans-serif" class="dz-diagram"><defs><marker id="cy-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#334155"/></marker></defs><rect width="1000" height="600" fill="#fff"/><text x="500" y="30" font-size="16" font-weight="700" text-anchor="middle">PRINCIPLE OF OPERATION — one complete thermomechanical cycle of a cell</text>`;
  st.forEach(([t, txt, c], i) => {
    const a0 = -Math.PI / 2 + i * 2 * Math.PI / st.length, x = cx + R * Math.cos(a0) * 1.25, y = cy + R * Math.sin(a0) * 0.95, a1 = a0 + 2 * Math.PI / st.length;
    s += `<path d="M${cx + R * 0.55 * Math.cos(a0 + 0.35)} ${cy + R * 0.55 * Math.sin(a0 + 0.35)} A ${R * 0.55} ${R * 0.55} 0 0 1 ${cx + R * 0.55 * Math.cos(a1 - 0.35)} ${cy + R * 0.55 * Math.sin(a1 - 0.35)}" fill="none" stroke="#334155" stroke-width="2.5" marker-end="url(#cy-a)"/>`;
    s += `<rect x="${x - 120}" y="${y - 38}" width="240" height="76" rx="10" fill="${c}" fill-opacity=".1" stroke="${c}" stroke-width="2"/><text x="${x}" y="${y - 16}" font-size="13" font-weight="700" text-anchor="middle" fill="${c}">${esc(t)}</text>`;
    const words = txt.split(' '); let line = '', ly = y + 2; for (const w of words) { if ((line + ' ' + w).length > 40) { s += `<text x="${x}" y="${ly}" font-size="10.5" text-anchor="middle">${esc(line)}</text>`; ly += 13; line = w; } else line = line ? line + ' ' + w : w; } s += `<text x="${x}" y="${ly}" font-size="10.5" text-anchor="middle">${esc(line)}</text>`;
  });
  s += `<circle cx="${cx}" cy="${cy}" r="62" fill="#f8fafc" stroke="#334155"/><text x="${cx}" y="${cy - 6}" font-size="12" font-weight="700" text-anchor="middle">W_net = ∮F dx</text><text x="${cx}" y="${cy + 12}" font-size="10.5" text-anchor="middle">contraction − reset − losses</text>`;
  return s + '</svg>';
}
export function energyFlowDiagram(e, d) {
  const W = 1000, H = 330, scale = 220 / Math.max(1, e.QhotTot), w = (q) => Math.max(2, q * scale);
  const rows = [['Heat from source Q_hot', e.QhotTot, '#dc2626'], ['Regenerated (internal)', e.N * e.f * d.regenEff * e.sensible, '#7c3aed'], ['Gross cell work', e.Pgross, '#16a34a'], ['Shaft power', e.Pshaft, '#15803d'], ['Auxiliaries (pumps, valves, control)', e.Paux, '#f59e0b'], ['Net shaft power P_net', e.Pnet, e.Pnet > 0 ? '#166534' : '#b91c1c'], ['Heat rejected Q_rej', e.QrejTot, '#2563eb']];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Arial, Helvetica, sans-serif" class="dz-diagram"><rect width="${W}" height="${H}" fill="#fff"/><text x="${W / 2}" y="24" font-size="15" font-weight="700" text-anchor="middle">ENERGY ACCOUNT (cycle-averaged, reference engine model)</text>`;
  rows.forEach(([l, q, c], i) => { const y = 46 + i * 39, bw = Math.min(560, Math.max(2, Math.abs(q) / Math.max(1e-9, e.QhotTot) * 560)); s += `<text x="20" y="${y + 18}" font-size="12">${esc(l)}</text><rect x="300" y="${y + 4}" width="${bw.toFixed(1)}" height="22" fill="${c}" fill-opacity=".85"/><text x="${(310 + bw).toFixed(1)}" y="${y + 20}" font-size="12" font-weight="700">${fmt(q, 4)} W</text>`; });
  void w;
  return s + `<text x="20" y="${H - 8}" font-size="10.5" fill="#475569">η = P_net/Q_hot = ${fmt(e.eta * 100, 3)} % · Carnot ${fmt(e.etaC * 100, 3)} % · ${fmt(e.carnotFraction * 100, 3)} % of Carnot. Bars scaled to Q_hot; small terms enlarged to remain visible.</text></svg>`;
}

// ---------------- datasets ----------------
function classifyDataset(header) {
  const h = header.join(' ').toLowerCase(), has = (re) => re.test(h);
  if (has(/heat.?flow|dsc|mw\b/) && has(/temp/)) return ['DSC thermogram', 'Differential scanning calorimetry of an alloy specimen: heating/cooling at constant rate through the transformation range.'];
  if (has(/stress|mpa/) && has(/strain/)) return ['Thermomechanical tensile loop', 'Uniaxial loading/unloading of a ribbon coupon at controlled temperature.'];
  if (has(/force|load|\bn\b/) && has(/disp|stroke|ext|mm/)) return ['Force–stroke actuator test', 'Ribbon or cartridge cycled between hot and cold fluid with force and displacement recorded.'];
  if (has(/torque/) && has(/rpm|speed|omega/)) return ['Dynamometer / shaft test', 'Shaft torque and speed measured at the dynamometer under controlled load.'];
  if (has(/flow|mdot|lpm/) && has(/press|dp/)) return ['Hydraulic test', 'Flow-rate and pressure-drop characterisation of the manifold / channel network.'];
  if (has(/flow|mdot/) && has(/temp/)) return ['Calorimetric test', 'Enthalpy-flow measurement from fluid flow and inlet/outlet temperatures.'];
  if (has(/cycles|life|fracture/)) return ['Fatigue / endurance data', 'Cycles to failure or residual-strain evolution under repeated cycling.'];
  if (has(/cost|price|usd/)) return ['Cost / quotation data', 'Supplier or fabrication cost information.'];
  return ['General dataset', 'Tabular measurements without a recognised standard structure.'];
}
function colStats(col) { const v = col.map(Number).filter(Number.isFinite); if (!v.length) return null; let mn = Infinity, mx = -Infinity, s = 0; for (const x of v) { if (x < mn) mn = x; if (x > mx) mx = x; s += x; } return { n: v.length, missing: col.length - v.length, min: mn, max: mx, mean: s / v.length }; }
export function datasetList() {
  const out = [];
  for (const [sid, list] of Object.entries(store.project.experiments || {})) for (const [i, d] of list.entries()) out.push({ key: `${sid}-${i}`, suite: sid, name: d.name, use: d.use, prov: d.prov || 'imported', t: d.t, header: d.header || [], columns: d.columns || {}, nRows: d.nRows || 0, kind: d.kind });
  for (const d of store.project.lab?.datasets || []) { const header = d.channels ? Object.keys(d.channels) : (d.header || []); const columns = d.channels || d.columns || {}; out.push({ key: `lab-${d.id}`, suite: 'lab', name: d.name, use: d.kind || 'laboratory', prov: d.provenance || 'imported', t: d.t || d.created, header, columns, nRows: header.length ? (columns[header[0]] || []).length : 0, kind: d.kind }); }
  return out;
}

// ---------------- main builder ----------------
export async function buildDossier({ withDrawings = true, onStep = () => { } } = {}) {
  const pr = store.project, d = designWith(pr.engine), alloy = getMat(d.alloy) || getMat('niti-lt'), sig = inputsSignature();
  const log = (pr.dossierLog ||= []); const rev = log.length ? `D${log.length}` : 'D0';
  onStep('Reference engine model');
  let e = null; try { e = engineModel(d, { mat: alloy, n: 2, stepsPerCycle: 160, cycles: 3 }); } catch { e = null; }
  const qs = quasiStaticCycle(alloy, { Th: d.Th, Tc: d.Tc, sH: d.sigmaH, sL: d.sigmaL }), pd = phaseDiagram(alloy, Math.max(250, d.sigmaH * 1.6));
  const A = d.ribbonsPerCell * d.ribbonW * d.ribbonT, ds = datasetList(), out = { sections: [], charts: [], sheets: [], rev, sig, generated: new Date().toISOString() };
  const S = (id, title, html) => out.sections.push({ id, title, html });
  const C = (id, spec) => { out.charts.push({ id, spec }); return `<div class="dz-chart" data-chart="${id}"></div>`; };
  const pre = preScreen(d, alloy);

  // 1 Document control
  S('control', 'Document control', T(['Field', 'Value'], [['Document', 'THERMA-X100 engineering & experimental dossier'], ['Project', `${pr.name} (${pr.id})`], ['Dossier revision', rev], ['Project revision', pr.revision], ['Generated', new Date().toLocaleString()], ['Inputs fingerprint', sig.hash], ['Supplied datasets', sig.datasets], ['Software version', (typeof window !== 'undefined' && window.TX_VERSION) || '—'], ['Author', pr.author || '—'], ['Installation site', `${pr.site.name} (${fmt(pr.site.lat, 6)}, ${fmt(pr.site.lon, 6)})`], ['Status', 'PRELIMINARY — model predictions; not validated test evidence unless marked “measured”']]) + P('This dossier is regenerated automatically from the current inputs whenever the design, materials, suite inputs or supplied data change. Every number carries the provenance of the input it came from; predictions from models are never presented as measurements.'));

  // 2 Executive summary
  const verdictRows = SUITES.map(s => { const o = pr.outputs[s.id]; const sm = o?.summary; const nf = sm?.verdicts?.filter(v => v.status === 'fail').length || 0, nw = sm?.verdicts?.filter(v => v.status === 'warn').length || 0; return [`${String(s.num).padStart(2, '0')} ${s.short}`, o ? (o.stale ? 'stale' : 'current') : 'not run', o?.credibility || '—', sm ? (nf ? `${nf} fail` : nw ? `${nw} warn` : 'pass') : '—', sm?.headline ? sm.headline.slice(0, 180) : '—']; });
  S('summary', 'Executive summary', (e ? T(['Quantity', 'Value', 'Basis'], [['Net shaft power', `${fmt(e.Pnet, 4)} W`, 'reference engine model'], ['Gross cell work rate', `${fmt(e.Pgross, 4)} W`, ''], ['Auxiliary power', `${fmt(e.Paux, 4)} W`, 'pumps, valves, control'], ['Heat input', `${fmt(e.QhotTot, 4)} W`, ''], ['Thermal efficiency', `${fmt(e.eta * 100, 3)} %`, `${fmt(e.carnotFraction * 100, 3)} % of Carnot (${fmt(e.etaC * 100, 3)} %)`], ['Net specific power — active SMA', `${fmt(e.pActive, 4)} W/kg`, `${fmt(e.refRatio, 3)} × the ${REFERENCE_W_PER_KG} W/kg published reference`], ['Net specific power — cartridge', `${fmt(e.pCart, 4)} W/kg`, 'cartridge mass basis'], ['Net specific power — system', `${fmt(e.pSys, 4)} W/kg`, 'complete-engine mass basis'], ['Cells needed for target', Number.isFinite(e.cellsForTarget) ? e.cellsForTarget : 'not reachable', `target ${d.targetPower} W`]]) : P('Engine model unavailable for these inputs.')) + H3('Physical pre-screen') + T(['Check', 'Status', 'Detail'], pre.map(v => [v.test, `<span class="badge ${v.status === 'pass' ? 'ok' : v.status === 'fail' ? 'fail' : 'warn'}">${v.status}</span>`, v.detail])) + H3('Status of the 22 suites') + T(['Suite', 'Result', 'Credibility', 'Verdicts', 'Headline'], verdictRows) + P('Suites marked “not run” use defaults in this dossier; open them (or run the Feasibility gate) to include their analyses.'));

  // 3 Principle of operation
  S('principle', 'Principle of operation', P('THERMA-X100 converts a maintained temperature difference into shaft work through the reversible martensite ↔ austenite transformation of trained shape-memory-alloy ribbons: <b>heat → crystalline phase transformation → contraction → force → shaft torque → cooling and reset → repetition</b>. It burns no fuel and needs a hot source and a colder sink; uniform ambient exposure cannot sustain cyclic output, and Carnot efficiency 1 − T<sub>c</sub>/T<sub>h</sub> bounds every result.') + `<div class="dz-figure">${cycleDiagram(d, alloy)}<div class="dz-cap">Figure 1 — The five stages of one cell cycle with the transformation temperatures shifted by the working stresses (Clausius–Clapeyron).</div></div>` +
    P(`<b>Why net work exists.</b> On heating under the power-stroke stress σ<sub>H</sub> = ${d.sigmaH} MPa the ribbon recovers its trained length and delivers work F·dx through a one-way clutch. After cooling below M<sub>f</sub>(σ<sub>L</sub>) the martensite can be re-extended at the lower reset stress σ<sub>L</sub> = ${d.sigmaL} MPa. The enclosed σ–ε loop area is the net specific work: ${fmt(qs.w_J_kg, 4)} J/kg per cycle in the quasi-static limit (contraction ${fmt(qs.wContraction_J_kg, 4)} J/kg − reset ${fmt(qs.wReset_J_kg, 4)} J/kg), stroke ${fmt(qs.stroke * 100, 3)} %.`) +
    C('sigeps', { type: 'line', title: 'Isobaric work loop of the active alloy (quasi-static)', x: { label: 'Strain ε', unit: '%' }, y: { label: 'Stress σ', unit: 'MPa' }, series: [{ name: alloy.name, x: qs.path.map(q => q.e * 100), y: qs.path.map(q => q.s) }], explain: 'Load at the cold reservoir, heat at σH (contraction), unload hot, cool at σL (reset). The enclosed area is the net work per unit volume.' }) +
    C('phase', { type: 'line', title: 'Stress–temperature phase diagram with the operating window', x: { label: 'Temperature', unit: '°C' }, y: { label: 'Stress', unit: 'MPa' }, series: [{ name: 'Mf(σ)', x: pd.Mf, y: pd.s, dash: '4 3' }, { name: 'Ms(σ)', x: pd.Ms, y: pd.s }, { name: 'As(σ)', x: pd.As, y: pd.s }, { name: 'Af(σ)', x: pd.Af, y: pd.s, dash: '4 3' }, { name: 'Operating loop', x: [d.Tc, d.Tc, d.Th, d.Th, d.Tc], y: [d.sigmaL, d.sigmaH, d.sigmaH, d.sigmaL, d.sigmaL] }], explain: 'The hot reservoir must exceed Af at σH and the cold reservoir must be below Mf at σL for complete transformation.' }) +
    P(`<b>Multicell phasing.</b> ${d.nCells} cells are offset in phase so that some are always in the power stroke while others heat, cool or reset; this smooths torque but does not create energy. A regenerator (ε = ${d.regenEff}) recovers part of the sensible heat; the latent heat ρ·L<sub>h</sub>·Δξ cannot be regenerated.`) +
    (e ? `<div class="dz-figure">${energyFlowDiagram(e, d)}<div class="dz-cap">Figure 2 — First-law account of the reference engine.</div></div>` : '') +
    UL(['Start-up: a maintained temperature difference and pre-extended cold ribbons are required; selected cells heat until transmitted torque exceeds static resistance (Suite 15).', 'Shutdown: isolate heat, remove residual heat, decelerate and park cells in a non-damaging state; re-preloading needs an identified energy source.', 'Gearing changes the torque/speed ratio but cannot create power; a flywheel stores and returns energy.']));

  // 4 Design specification
  S('spec', 'Engine design specification', T(['Parameter', 'Value', 'Unit', 'Key'], Object.entries(d).filter(([k]) => typeof d[k] !== 'object').map(([k, v]) => { const f = ENGINE_FIELDS.find(x => x[0] === k); return [f ? f[1] : k, typeof v === 'number' ? fmt(v, 5) : String(v), f ? f[2] : '', k]; })) + H3('Derived design loads') + T(['Quantity', 'Value'], [['Ribbon cross-section per cell', `${fmt(A * 1e6, 4)} mm²`], ['Reset (bias) force σL·A', `${fmt(d.sigmaL * A, 4)} N`], ['Power-stroke force σH·A', `${fmt(d.sigmaH * A, 4)} N`], ['Austenite finish at σH', `${fmt(alloy.Af + d.sigmaH / alloy.CA, 4)} °C`], ['Martensite finish at σL', `${fmt(alloy.Mf + d.sigmaL / alloy.CM, 4)} °C`], ['Carnot limit', `${fmt(carnot(d.Th, d.Tc) * 100, 4)} %`], ['Specific-power milestones', MILESTONES.map(m => `${m[0]} W/kg (${m[1]})`).join(' · ')]]));

  // 5 Materials
  const matRows = Object.entries(COMPONENTS).map(([k, c]) => { const m = k === 'ribbon' ? alloy : componentMaterial(store, k); return [c.name, m?.name || '—', m?.family || '', m ? `${fmt(m.rho, 4)}` : '', m?.E ? fmt(m.E, 3) : '', m?.sy ? fmt(m.sy, 4) : '', m?.k ? fmt(m.k, 4) : '', m ? `±${m.unc} %` : '', m?.evidence || '']; });
  S('materials', 'Materials and datasheets', T(['Component', 'Material', 'Family', 'ρ kg/m³', 'E GPa', 'σy MPa', 'k W/m·K', 'Uncert.', 'Evidence'], matRows) + H3(`Active alloy card — ${alloy.name}`) + T(['Property', 'Value'], [['Mf / Ms / As / Af (stress-free)', `${alloy.Mf} / ${alloy.Ms} / ${alloy.As} / ${alloy.Af} °C`], ['Clausius–Clapeyron CM / CA', `${alloy.CM} / ${alloy.CA} MPa/K`], ['Detwinning σs / σf', `${alloy.sigS} / ${alloy.sigF} MPa`], ['Max recoverable strain εL', `${fmt(alloy.epsL * 100, 3)} %`], ['Latent heat', `${alloy.Lh} J/kg`], ['EA / EM', `${alloy.EA} / ${alloy.EM} GPa`], ['k (austenite / martensite)', `${alloy.k} / ${alloy.kM} W/m·K`], ['cp, ρ', `${alloy.cp} J/kg·K, ${alloy.rho} kg/m³`], ['Indicative cost / embodied CO₂', `${alloy.cost} USD/kg · ${alloy.co2} kg CO₂e/kg`], ['Source', alloy.src]]) + P('Library values are representative, not lot-certified. Before validated claims, import the supplier chemistry certificate, DSC curve and tensile loops for the actual lot (Suite 03 / Laboratory).'));

  // 6 Drawings
  if (withDrawings) { onStep('Drawings'); const dr = await buildDrawings(rev, onStep); out.sheets = dr.sheets; out.bom = dr.cat.list; S('drawings', 'Drawing register', T(['Drawing No.', 'Title', 'Type', 'Scale'], dr.sheets.map(s => [s.id, s.title, s.kind, /exploded/i.test(s.title) ? 'Pictorial (NTS)' : (s.scale >= 1 ? `${Math.round(s.scale)}:1` : `1:${Math.round(1 / s.scale)}`)])) + H3('Bill of materials') + T(['Part No.', 'Description', 'Material', 'Qty (engine)', 'Unit mass kg', 'Total mass kg'], dr.cat.list.map(it => [it.no, it.name, it.material, it.qty, fmt(it.mass, 4), fmt(it.mass * it.qty, 4)])) + `<div class="dz-sheets"></div>`); }

  // 7 Experimental set-up
  let instr = [];
  try { const lab = await import('./lab.js'); instr = Object.entries(lab.INSTRUMENT_TYPES).map(([k, v]) => [v.label, v.supplies, v.unit, `±${v.u} ${v.unit} or ±${fmt(v.uRel * 100, 3)} %`]); out.limits = lab.limitsFromDesign ? lab.limitsFromDesign(d, alloy) : null; } catch { instr = []; }
  S('setup', 'Experimental set-up', `<div class="dz-figure">${setupSchematic(d, e)}<div class="dz-cap">Figure 3 — Instrumented single-cartridge rig with hot/cold switching, calorimetry, load train and dynamometer extension; tags per ISA-5.1 style.</div></div>` + H3('Instrumentation') + (instr.length ? T(['Instrument', 'Supplies', 'Unit', 'Standard uncertainty'], instr) : '') + UL(['Common-timestamp data acquisition for all channels; record instrument IDs and calibration certificates with each run.', 'Thermocouples on the ribbon (bulk), on the plate (contact), and in each fluid inlet/outlet; flow meters on both circuits; differential pressure across the cartridge.', 'Load cell in series with the bias spring; LVDT on the carriage; torque transducer and encoder at the dynamometer; power meter on all auxiliaries.', 'Independent hardware safety: over-temperature cut-out, pressure relief, E-stop, overspeed trip, guards and leak detection.']));

  // 8 Methodology
  const lab = store.project.lab || {}, protos = lab.protocols || [];
  S('method', 'Methodology', OL(['Select qualified alloy lots; obtain chemistry certificates and baseline DSC and tensile loops (V0).', `Fabricate ribbons ${fmt(d.ribbonL * 1000, 4)} × ${fmt(d.ribbonW * 1000, 3)} × ${fmt(d.ribbonT * 1e6, 3)} µm; shape-set and train; inspect edges.`, `Assemble the cartridge with reset preload ${fmt(d.sigmaL * A, 4)} N measured by the load cell; dry mechanical test of the load train.`, 'Pressure-test the fluid circuits (1.5 × maximum operating pressure); commission hot and cold flows; verify thermocouple agreement at isothermal conditions.', `Run the work cycle at ${d.freq} Hz, hot fraction ${d.dutyHot}, load σH = ${d.sigmaH} MPa: record force, stroke, all temperatures, flows, pressures and auxiliary power on a common clock.`, 'Repeat across source/sink temperatures and cycle times (matched-condition matrix) to map where net work per cycle is strictly positive.', 'Compute contraction work, reset work, net work ∮F dx, heat input ṁ·cp·ΔT and efficiency with GUM / Monte-Carlo uncertainty; compare with the model (Suite 19) and recalibrate.', 'Only after V2 evidence (positive net closed-cycle work) proceed to phased multi-cartridge and dynamometer tests (V3–V5).']) + H3('Acceptance criteria (fixed before testing)') + UL(['Net cycle work positive with the lower 95 % confidence bound > 0 over ≥ 1 000 repetitions.', 'First-law closure of the cycle energy balance within ±5 % of heat input.', 'Thermocouple agreement within ±0.5 K at isothermal check points; flow meters within ±2 %.', 'Efficiency never exceeding the Carnot limit of the measured reservoir temperatures (otherwise the measurement is rejected and investigated).']) + (protos.length ? H3('Released laboratory protocols') + T(['Protocol', 'Version', 'Status', 'Hypothesis'], protos.map(p => [p.title || p.name || p.id, p.version ?? '', p.released ? 'released' : 'draft', p.hypothesis?.statement || p.hypothesis || ''])) : ''));

  // 9 Test conditions
  const lim = out.limits; const cond = [['Hot fluid supply temperature', `${d.Th} °C`], ['Cold fluid supply temperature', `${d.Tc} °C`], ['Dead-state (ambient) temperature', `${d.T0} °C`], ['Hot / cold fluid', `${fluid(d.hotFluid, d.Th).name} / ${fluid(d.coldFluid, d.Tc).name}`], ['Hot / cold mass flow', e ? `${fmt(e.mdotH, 4)} / ${fmt(e.mdotC, 4)} kg/s` : '—'], ['Channel Reynolds number (hot)', e ? fmt(e.hydH.Re, 4) : '—'], ['Heat-transfer coefficient used (hot / cold)', e ? `${fmt(e.hHotUsed, 4)} / ${fmt(e.hColdUsed, 4)} W/m²K` : '—'], ['Cycle frequency, hot fraction', `${d.freq} Hz, ${d.dutyHot}`], ['Valve switching ramp', `${d.tSwitch} s`], ['Reset / power-stroke stress', `${d.sigmaL} / ${d.sigmaH} MPa`], ['Reset / power-stroke force per cell', `${fmt(d.sigmaL * A, 4)} / ${fmt(d.sigmaH * A, 4)} N`], ['Regenerator effectiveness', d.regenEff], ['Cells × ribbons', `${d.nCells} × ${d.ribbonsPerCell}`], ['Site', `${pr.site.name}`]];
  if (lim) for (const [k, v] of Object.entries(lim)) if (typeof v === 'number') cond.push([`Safety limit ${k}`, fmt(v, 4)]);
  S('conditions', 'Test and operating conditions', T(['Condition', 'Value'], cond) + H3('Matched-condition test matrix (minimum)') + T(['Run', 'T_hot °C', 'T_cold °C', 'f Hz', 'σL / σH MPa'], [[1, d.Th, d.Tc, d.freq, `${d.sigmaL} / ${d.sigmaH}`], [2, d.Th - 10, d.Tc, d.freq, `${d.sigmaL} / ${d.sigmaH}`], [3, d.Th + 10, d.Tc, d.freq, `${d.sigmaL} / ${d.sigmaH}`], [4, d.Th, d.Tc + 10, d.freq, `${d.sigmaL} / ${d.sigmaH}`], [5, d.Th, d.Tc, d.freq / 2, `${d.sigmaL} / ${d.sigmaH}`], [6, d.Th, d.Tc, d.freq * 2, `${d.sigmaL} / ${d.sigmaH}`], [7, d.Th, d.Tc, d.freq, `${d.sigmaL} / ${d.sigmaH - 10}`], [8, d.Th, d.Tc, d.freq, `${d.sigmaL + 10} / ${d.sigmaH}`]]));

  // 10 Supplied input data — one dossier entry per dataset
  let dsHtml = ds.length ? '' : P('No input data have been supplied yet. Every dataset you import (Data portal, a suite’s import mode or the Laboratory) is added here automatically with its own entry: inferred experiment type, set-up, conditions extracted from the data, column statistics and plots.');
  for (const [i, x] of ds.entries()) {
    const [type, setupTxt] = classifyDataset(x.header), stats = x.header.map(h => [h, colStats(x.columns[h] || [])]).filter(r => r[1]);
    const num = stats.map(r => r[0]), tCol = x.header.find(h => /^(t|time)/i.test(h)) || num[0];
    const cond2 = stats.filter(([h]) => /temp|°c|t_/i.test(h)).map(([h, s]) => `${h}: ${fmt(s.min, 4)} … ${fmt(s.max, 4)}`).join('; ');
    dsHtml += `<div class="dz-ds" id="ds-${esc(x.key)}">` + H3(`Dataset ${i + 1}: ${x.name}`) + T(['Field', 'Value'], [['Routed to', x.suite === 'lab' ? 'Experimental laboratory' : `Suite ${x.suite.slice(1)}`], ['Use', x.use || ''], ['Evidence class', x.prov], ['Imported', x.t ? new Date(x.t).toLocaleString() : '—'], ['Rows × columns', `${x.nRows} × ${x.header.length}`], ['Inferred experiment type', type], ['Implied set-up', setupTxt], ['Conditions found in the data', cond2 || '—']]) + T(['Column', 'n', 'missing', 'min', 'max', 'mean'], stats.map(([h, s]) => [h, s.n, s.missing, fmt(s.min, 4), fmt(s.max, 4), fmt(s.mean, 4)]));
    const ys = num.filter(h => h !== tCol).slice(0, 4);
    if (tCol && ys.length) dsHtml += C(`ds${i}`, { type: 'line', title: `${x.name}: ${ys.join(', ')} vs ${tCol}`, x: { label: tCol }, y: { label: 'value' }, series: ys.map(h => { const X = (x.columns[tCol] || []).map(Number), Y = (x.columns[h] || []).map(Number), step = Math.max(1, Math.floor(X.length / 1500)); return { name: h, x: X.filter((_, k) => k % step === 0), y: Y.filter((_, k) => k % step === 0) }; }), explain: `Measured series as supplied (${x.prov}); not modified by the software.` });
    dsHtml += '</div>';
  }
  S('data', 'Supplied input data', dsHtml);

  // 11 Analysis results by suite
  let res = '';
  for (const s of SUITES) { const o = pr.outputs[s.id], sm = o?.summary; if (!sm) continue; res += H3(`Suite ${String(s.num).padStart(2, '0')} — ${s.title}`) + P(`${esc(sm.headline)} <span class="muted">(${o.stale ? 'stale: ' + esc(o.staleReason || '') : 'current'} · ${esc(o.credibility)} · ${new Date(o.t).toLocaleString()})</span>`) + (sm.kpis.length ? T(['Result', 'Value', 'Unit', 'Provenance'], sm.kpis.map(k => [k.label, typeof k.value === 'number' ? fmt(k.value, 4) : k.value, k.unit, k.prov ? provBadge(k.prov) : ''])) : '') + (sm.verdicts.filter(v => v.status !== 'pass').length ? UL(sm.verdicts.filter(v => v.status !== 'pass').map(v => `<b>${esc(v.status.toUpperCase())}</b> ${esc(v.test)}${v.fix ? ' — fix: ' + esc(v.fix) : ''}`)) : '') + (sm.recs.length ? UL(sm.recs.map(r => `<i>${esc(r.level)}</i>: ${esc(r.text)}`)) : ''); }
  S('results', 'Analysis results (all suites run so far)', res || P('No suite has been run yet. Use “Run all suites and refresh” to populate this section.'));

  // 12 Safety, manufacturing, economics, assumptions
  const o = (id) => pr.outputs[id]?.data || {};
  S('safety', 'Safety, manufacturing and economics', T(['Topic', 'Value', 'Source'], [['Safe-operating envelope worst utilisation', o('s21').envelope ? JSON.stringify(o('s21').envelope).slice(0, 120) : '—', 'Suite 21'], ['MTBF', n3(o('s21').mtbf_h) + ' h', 'Suite 21'], ['Median ribbon life', n3(o('s16').life_cycles) + ' cycles', 'Suite 16'], ['Inspection interval', n3(o('s16').inspectInterval_cycles) + ' cycles', 'Suite 16'], ['Part count / build hours', `${n3(o('s20').partCount)} / ${n3(o('s20').buildHours)} h`, 'Suite 20'], ['Unit cost (estimate)', n3(o('s20').unitCost_USD) + ' USD', 'Suite 20'], ['CAPEX / OPEX', `${n3(o('s22').capex_USD)} USD / ${n3(o('s22').opex_USDyr)} USD/yr`, 'Suite 22'], ['Levelized cost', n3(o('s22').lcoe_USDkWh) + ' USD/kWh_mech', 'Suite 22'], ['Embodied / lifecycle CO₂', n3(o('s22').co2_kg) + ' kg', 'Suite 22']]) + UL(['Hazards: hot surfaces and fluids (scalding), pressurised circuits, stored spring and rotor energy, ribbon fracture, electrical auxiliaries.', 'Controls: guards and containment casing, pressure relief, over-temperature and overspeed trips, E-stop, lock-out before maintenance, PPE for hot-fluid work.', 'Maintenance: ribbon replacement on inspection interval, fluid cleaning, contact rework, clutch inspection, sensor recalibration.']));
  S('assumptions', 'Assumptions, limitations and evidence status', UL(['Material properties are representative library values unless a dataset marked measured or certified is supplied.', 'The engine model is a reduced-order cell transient scaled to the array; 3-D effects are covered by Suites 02, 08 and 14 at screening level.', 'Costs are estimates, never supplier quotations; carbon factors use live grid data when available.', 'Drawings are generated from the parametric model; tolerances follow ISO 2768-mK unless stated; drawings must be checked and approved before manufacture.', 'Validation ladder V0–V6 status is determined only by measured datasets (see the Laboratory evidence workspace).']) + H3('Suite coupling (who supplies whom)') + T(['Suite', 'Receives from'], Object.entries(DEPENDS).map(([k, v]) => [`${k.slice(1)} ${SUITES.find(s => s.id === k)?.short}`, v.map(x => x.slice(1)).join(', ') || '—'])));
  S('history', 'Revision history', log.length ? T(['Revision', 'Time', 'Trigger', 'Inputs fingerprint', 'Datasets'], log.slice().reverse().slice(0, 60).map(r => [r.rev, new Date(r.t).toLocaleString(), r.trigger, r.hash, r.datasets])) : P('First generation.'));
  return out;
}
export { HATCH_DEFS };
void KELVIN;
