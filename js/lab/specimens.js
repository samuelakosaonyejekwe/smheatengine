// Workspace 4 — specimens, materials & fabrication management: specimen register traceable to the materials library,
// alloy lot and heat-treatment history, fabrication route (specification §36) and a printable identifier label.
import { h, table, callout, toast, provChip } from '../core/ui.js';
import { store } from '../core/state.js';
import { smaAlloys, get as getMat } from '../core/materials.js';
import { addRecord, updateRecord, removeRecord, stableHash, logEvent } from '../core/lab.js';
import { lab, card, grid, field, numIn, txtIn, selIn, btn, val, note, row, f3, dl } from './common.js';

const STATUS = ['received', 'inspected', 'heat-treated', 'trained', 'instrumented', 'in test', 'retired', 'failed', 'quarantined'];
const ROUTE = ['Qualified alloy lot selected (mill certificate on file)', 'Baseline DSC transformation temperatures measured', 'Ribbon cut / slit; edges inspected', 'Shape-setting heat treatment (time, temperature, quench recorded)', 'Thermomechanical training cycles', 'Dimensional inspection (width, thickness, length)', 'Grip ends prepared; thermocouples bonded', 'Mounted with measured preload; dry mechanical test passed'];

export async function render(el) {
  const d = store.project.engine, alloys = smaAlloys();
  const F = { alloy: selIn(alloys.map(m => [m.id, m.name]), d.alloy), lot: txtIn('', 'e.g. heat 24-117'), supplier: txtIn('', 'supplier'), cert: txtIn('', 'mill / lot certificate no.'), ht: txtIn('500 °C × 30 min, water quench', ''), L: numIn(d.ribbonL * 1e3), w: numIn(d.ribbonW * 1e3), t: numIn(d.ribbonT * 1e6), n: numIn(1, { step: 1 }), train: numIn(50, { step: 1 }), status: selIn(STATUS, 'received'), notes: txtIn('', 'notes') };
  el.append(card('Register a specimen', note('Every specimen links to its library alloy card, alloy lot, supplier certificate and heat-treatment history. Datasets recorded on it inherit this traceability, which is what distinguishes a lot-specific measurement from a handbook value.'),
    grid(field('Alloy (library card)', F.alloy), field('Alloy lot / heat', F.lot), field('Supplier', F.supplier), field('Lot certificate', F.cert), field('Heat treatment', F.ht), field('Active length (mm)', F.L), field('Width (mm)', F.w), field('Thickness (µm)', F.t), field('Ribbons in specimen', F.n), field('Training cycles', F.train), field('Status', F.status), field('Notes', F.notes)),
    row(btn('＋ Add specimen', () => add(), 'primary'), btn('＋ Add 6 identical (batch)', () => { for (let i = 0; i < 6; i++) add(true); toast('Batch of 6 specimens registered', 'ok'); draw(); }))));
  const list = h('div'), detail = h('div'); el.append(card('Specimen register', list), detail);
  function add(silent) {
    const m = getMat(F.alloy.value), L = val(F.L), w = val(F.w), t = val(F.t), n = val(F.n);
    const mass = n * L * 1e-3 * w * 1e-3 * t * 1e-6 * (m?.rho || 6450);
    const s = addRecord(store, 'specimens', { alloy: F.alloy.value, lot: F.lot.value.trim(), supplier: F.supplier.value.trim(), cert: F.cert.value.trim(), heatTreatment: F.ht.value.trim(), geometry: `${L} × ${w} mm × ${t} µm ×${n}`, dims: { L, w, t, n }, mass_g: mass * 1e3, training: val(F.train), status: F.status.value, notes: F.notes.value.trim(), fab: {}, history: [{ t: new Date().toISOString(), status: F.status.value }], prov: F.cert.value.trim() ? 'certified' : 'library' });
    s.label = `TX|${s.id}|${s.alloy}|${s.lot || 'no-lot'}|${stableHash({ id: s.id, alloy: s.alloy, lot: s.lot, ht: s.heatTreatment, dims: s.dims }).slice(0, 8)}`;
    if (!silent) { toast(`${s.id} registered`, 'ok'); draw(); }
  }
  function draw() {
    list.innerHTML = ''; const S = lab().specimens;
    if (!S.length) { list.append(note('No specimens registered yet.')); return; }
    const cnt = STATUS.map(s => [s, S.filter(x => x.status === s).length]).filter(x => x[1]);
    list.append(h('div', { class: 'row gap wrap', style: 'margin-bottom:6px' }, ...cnt.map(([s, n]) => h('span', { class: 'chip' }, `${s}: ${n}`))));
    list.append(table(['ID', 'Alloy', 'Lot', 'Heat treatment', 'Geometry', 'Mass (g)', 'Route', 'Status', 'Property basis', ''], S.map(s => {
      const st = selIn(STATUS, s.status); st.onchange = () => { s.history ||= []; s.history.push({ t: new Date().toISOString(), status: st.value }); updateRecord(store, 'specimens', s.id, { status: st.value }); logEvent(store, 'specimen', `${s.id} → ${st.value}`); };
      const done = Object.values(s.fab || {}).filter(Boolean).length;
      return [h('a', { href: 'javascript:void 0', onclick: () => show(s) }, s.id), h('a', { href: '#/library' }, s.alloy), s.lot || '—', s.heatTreatment, s.geometry, f3(s.mass_g), `${done}/${ROUTE.length}`, st, provChip(s.prov || 'library'), btn('✕', () => { if (confirm(`Remove ${s.id}?`)) { removeRecord(store, 'specimens', s.id); detail.innerHTML = ''; draw(); } }, 'sm')];
    })));
  }
  function show(s) {
    detail.innerHTML = ''; const m = getMat(s.alloy), dsCount = lab().datasets.filter(x => x.meta?.specimenId === s.id).length;
    const route = h('div', {}, ...ROUTE.map((r, i) => h('label', { style: 'display:flex;gap:8px;align-items:center;margin:3px 0' }, h('input', { type: 'checkbox', checked: !!s.fab?.[i], onchange: (e) => { s.fab ||= {}; s.fab[i] = e.target.checked ? new Date().toISOString() : false; updateRecord(store, 'specimens', s.id, { fab: s.fab }); draw(); } }), h('span', {}, r), s.fab?.[i] ? h('span', { class: 'small muted' }, new Date(s.fab[i]).toLocaleString()) : null)));
    const procs = (m?.processes || []).join(' → ');
    detail.append(card(`Specimen ${s.id}`,
      h('div', { class: 'row gap wrap', style: 'align-items:flex-start' }, h('div', { html: idPattern(s.label || s.id), style: 'background:#fff;padding:6px;border-radius:6px' }), h('div', { style: 'flex:1;min-width:220px' }, h('div', { class: 'small muted' }, 'Identifier text (for label printer / barcode software):'), h('code', { style: 'word-break:break-all' }, s.label || s.id), note('The square is a visual checksum of the identifier (not a standard QR symbol); print the identifier text with any label or barcode tool.'),
        table(['Field', 'Value'], [['Library card', `${m?.name || s.alloy} (evidence: ${m?.evidence || '—'})`], ['Card A_f / M_f', m ? `${m.Af} / ${m.Mf} °C` : '—'], ['Library process route', procs || '—'], ['Lot / supplier / certificate', `${s.lot || '—'} / ${s.supplier || '—'} / ${s.cert || 'none'}`], ['Heat treatment', s.heatTreatment], ['Training cycles', s.training], ['Datasets recorded', dsCount], ['Status history', (s.history || []).map(x => `${x.status} (${new Date(x.t).toLocaleDateString()})`).join(' → ')]]))),
      h('h4', {}, 'Fabrication & preparation route (specification §36)'), route,
      s.cert ? null : callout('warn', 'No lot certificate: property values for this specimen remain library/estimated until V0 measurements (DSC and tensile loops) are recorded on the same lot.'),
      row(btn('⇩ Specimen record (JSON)', () => dl(JSON.stringify(s, null, 2), `${s.id}.json`, 'application/json')))));
  }
  draw();
}

// deterministic 21×21 visual checksum of the identifier (finder squares + hash-derived cells)
function idPattern(text) {
  const N = 21, cell = 4, bits = []; let hsh = stableHash(text); while (bits.length < N * N) { for (const ch of hsh) bits.push(...parseInt(ch, 16).toString(2).padStart(4, '0').split('').map(Number)); hsh = stableHash(hsh + text); }
  const finder = (x, y) => { for (const [fx, fy] of [[0, 0], [N - 7, 0], [0, N - 7]]) if (x >= fx && x < fx + 7 && y >= fy && y < fy + 7) { const dx = x - fx, dy = y - fy; return dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4) ? 1 : 0; } return -1; };
  let r = ''; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const f = finder(x, y), on = f >= 0 ? f : bits[y * N + x]; if (on) r += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}"/>`; }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N * cell} ${N * cell}" width="96" height="96" fill="#000">${r}</svg>`;
}
