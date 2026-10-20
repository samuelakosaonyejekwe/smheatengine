// Shared helpers for the Experimental Science & Discovery Laboratory workspaces (js/pages/lab.js).
import { h, provChip, toast, table } from '../core/ui.js';
import { store } from '../core/state.js';
import { chart, palette } from '../core/chart.js';
import { fmt } from '../core/num.js';
import { labOf, addRecord, runRecord, calStatus } from '../core/lab.js';

export const WORKSPACES = [
  { id: 'hypothesis', n: 1, icon: '💡', label: 'Hypothesis & protocol generator', short: 'Hypothesis', step: 'hypothesis', d: 'State a hypothesis; generate steps, controls, pre-set acceptance criteria, instruments, sample size and safety notes.' },
  { id: 'virtual', n: 2, icon: '🖥', label: 'Virtual experiment construction & simulation', short: 'Virtual', step: 'design', d: 'Execute a protocol on the physical models and obtain data in the same schema as a laboratory run (labelled hypothetical).' },
  { id: 'apparatus', n: 3, icon: '🔧', label: 'Apparatus & fixture design', short: 'Apparatus', step: 'design', d: 'Parametric test-rig schematic, sensor placement and bill of apparatus with SVG/DXF/JSON export.' },
  { id: 'specimens', n: 4, icon: '🏷', label: 'Specimens, materials & fabrication', short: 'Specimens', step: 'prepare', d: 'Specimen register with alloy lot, heat treatment, geometry, status, fabrication route and traceability.' },
  { id: 'daq', n: 5, icon: '📡', label: 'Instrumentation & real-time acquisition', short: 'Acquisition', step: 'prepare', d: 'Instrument register with calibration status; connect serial / USB / Bluetooth hardware or the simulated instrument; stream and record.' },
  { id: 'control', n: 6, icon: '🛑', label: 'Experiment control & safety interlocks', short: 'Control', step: 'execute', d: 'Armed/disarmed step sequencer with limits, watchdog, event log and emergency stop.' },
  { id: 'schedule', n: 7, icon: '📅', label: 'High-throughput scheduling', short: 'Scheduling', step: 'execute', d: 'Design-of-experiments campaigns, run queue across rigs and specimens, Gantt chart and utilisation.' },
  { id: 'discovery', n: 8, icon: '🧭', label: 'Material discovery & inverse experimental design', short: 'Discovery', step: 'design', d: 'Search bounded alloy property space for the current reservoirs; propose candidate targets as hypotheses.' },
  { id: 'analysis', n: 9, icon: '📈', label: 'Data analysis & uncertainty quantification', short: 'Analysis', step: 'analyse', d: 'Cycle segmentation, work loops, GUM and Monte-Carlo uncertainty, confidence intervals.' },
  { id: 'twin', n: 10, icon: '🪞', label: 'Numerical–experimental correlation & digital twin', short: 'Digital twin', step: 'compare', d: 'Overlay measurement and model, calibrate parameters, Kalman-updated discrepancy, calibrated write-back.' },
  { id: 'autonomous', n: 11, icon: '🎯', label: 'Autonomous experiment recommendation', short: 'Next test', step: 'compare', d: 'Gaussian-process surrogate with expected-improvement or maximum-variance acquisition; operator approval required.' },
  { id: 'evidence', n: 12, icon: '📑', label: 'Reproducibility, evidence & reporting', short: 'Evidence', step: 'report', d: 'Validation ladder V0–V6 from real datasets, run records, printable report and evidence ZIP.' },
];
export const STEPS = [['hypothesis', 'Hypothesis', 'hypothesis'], ['design', 'Design', 'virtual'], ['prepare', 'Prepare lab', 'specimens'], ['execute', 'Execute', 'control'], ['analyse', 'Analyse', 'analysis'], ['compare', 'Compare', 'twin'], ['report', 'Report', 'evidence']];
const KIND = { virtual: ['Virtual (model)', 'warn'], 'simulated-instrument': ['Simulated instrument', 'warn'], physical: ['Physical', 'ok'], hybrid: ['Hybrid', 'cred'], imported: ['Imported file', ''] };
export const kindBadge = (k) => h('span', { class: `badge ${KIND[k]?.[1] || ''}` }, KIND[k]?.[0] || k || '—');
export const dsBadges = (ds) => h('span', { style: 'display:inline-flex;gap:4px;flex-wrap:wrap' }, kindBadge(ds.kind), provChip(ds.provenance));
export const calBadge = (inst) => { const c = calStatus(inst); return h('span', { class: `badge ${{ valid: 'ok', due: 'warn', expired: 'fail', none: 'warn' }[c.status]}` }, c.label); };
export const lab = () => labOf(store);
export const version = () => (typeof window !== 'undefined' && window.TX_VERSION) || '';
export const note = (txt) => h('p', { class: 'small muted', style: 'margin:4px 0 8px' }, txt);
export const grid = (...kids) => h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:8px 12px;align-items:end' }, ...kids);
export const row = (...kids) => h('div', { class: 'row gap wrap', style: 'align-items:center;margin:8px 0' }, ...kids);
export function field(label, input, help) { return h('label', { style: 'display:flex;flex-direction:column;gap:3px;font-size:12.5px' }, h('span', { class: 'muted' }, label), input, help ? h('span', { class: 'small muted' }, help) : null); }
export const numIn = (v, o = {}) => h('input', { type: 'number', value: v, step: o.step ?? 'any', min: o.min, max: o.max, inputmode: 'decimal', class: 'search', style: 'max-width:100%' });
export const txtIn = (v = '', ph = '') => h('input', { type: 'text', value: v, placeholder: ph, class: 'search', style: 'max-width:100%' });
export const selIn = (opts, v) => h('select', { class: 'search', style: 'max-width:100%' }, ...opts.map(o => { const [val, lab_] = Array.isArray(o) ? o : typeof o === 'object' ? [o.value, o.label] : [o, o]; return h('option', { value: val, selected: String(val) === String(v) }, lab_); }));
export const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, onclick }, label);
export const val = (el) => { const v = parseFloat(el.value); return Number.isFinite(v) ? v : NaN; };
export const card = (title, ...kids) => h('section', { class: 'card', style: 'margin-bottom:14px' }, title ? h('h3', { class: 'card-title' }, title) : null, ...kids);
export const explainList = (items) => h('ul', { class: 'small', style: 'margin:6px 0 0 18px;padding:0' }, ...items.map(t => h('li', { style: 'margin:3px 0' }, t)));
export const kpi = (label, value, unit, explain, prov, status) => ({ label, value, unit, explain, prov, status });
export const f3 = (v) => fmt(v, 3), f4 = (v) => fmt(v, 4);

// chart registry so workspaces dispose their resize observers
export function charts() {
  const list = [];
  return { add(parent, spec) { const c = h('div', { class: 'chart-cell' + (spec.wide ? ' wide' : '') }); parent.append(c); try { list.push(chart(c, spec)); } catch (e) { c.append(h('div', { class: 'callout fail' }, 'Chart unavailable: ' + e.message)); } return c; }, grid() { return h('div', { class: 'chart-grid' }); }, dispose() { for (const c of list) c.destroy?.(); list.length = 0; } };
}

// save a dataset with a run record (software version, inputs hash, data hash)
export function saveDataset(ds, { protocol = null, specimen = null, instruments = [], operator = '', notes = '' } = {}) {
  const rec = addRecord(store, 'datasets', ds);
  const rr = runRecord({ protocol, dataset: rec, specimen, instruments, version: version(), operator, notes });
  addRecord(store, 'runs', { ...rr, name: `Run of ${rec.name}`, status: 'recorded' });
  toast(`Saved ${rec.id} (${rec.kind}, provenance ${rec.provenance})`, 'ok'); return rec;
}

export function datasetSelect(filter = () => true, selected = '') {
  const L = lab(), list = L.datasets.filter(filter);
  return selIn([['', list.length ? '— choose a dataset —' : '— no datasets yet —'], ...list.map(d => [d.id, `${d.id} · ${d.name} [${d.kind}, ${d.provenance}]`])], selected);
}
export const protocolSelect = (selected = '', withNone = true) => selIn([...(withNone ? [['', '— none —']] : []), ...lab().protocols.map(p => [p.id, `${p.id} v${p.version} · ${p.status} · ${p.name}`])], selected);
export const specimenSelect = (selected = '') => selIn([['', '— none —'], ...lab().specimens.map(s => [s.id, `${s.id} · ${s.alloy} ${s.lot || ''} (${s.status})`])], selected);

// persistent acquisition session (survives switching between workspaces; torn down when leaving the laboratory)
export const session = { source: null, acq: null, safety: null, seq: null, listeners: new Set(), emit(e) { for (const fn of this.listeners) { try { fn(e); } catch (err) { console.error(err); } } } };
export async function teardownSession(reason = 'left the laboratory') {
  const s = session;
  try { s.seq?.abort(reason); } catch { /* idle */ }
  try { if (s.safety?.state === 'armed') { await s.source?.write?.(s.safety.safeCommand); s.safety.disarm(reason); } } catch { /* rely on hardware interlock */ }
  try { s.acq?.stop(reason); } catch { /* stopped */ }
  try { await s.source?.stop(); } catch { /* closed */ }
  s.source = s.acq = s.seq = null; s.emit({ type: 'teardown' });
}

// multi-lane live strip chart (each channel autoscaled in its own lane)
export function liveStrip(el, { height = 240, span = 20 } = {}) {
  const cv = h('canvas', { style: `width:100%;height:${height}px;display:block;border:1px solid var(--line,#334);border-radius:8px;background:var(--panel2,#16213a)` }); el.append(cv);
  const g = cv.getContext('2d'); let raf = 0, src = null;
  const css = (n, f) => { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f; } catch { return f; } };
  const draw = () => {
    raf = 0; if (!src) return; const { t, channels } = src(); const names = Object.keys(channels), dpr = Math.min(2, devicePixelRatio || 1), W = cv.clientWidth || 600, H = height;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); g.font = '11px system-ui,sans-serif';
    if (!t.length || !names.length) { g.fillStyle = css('--muted', '#94a3b8'); g.fillText('No samples yet', 12, 20); return; }
    const tEnd = t[t.length - 1], t0 = tEnd - span, lane = H / names.length; let i0 = t.length - 1; while (i0 > 0 && t[i0 - 1] >= t0) i0--;
    names.forEach((n, k) => {
      const y = channels[n], seg = y.slice(i0).filter(Number.isFinite); const lo = Math.min(...seg), hi = Math.max(...seg), pad = (hi - lo) * 0.1 || 1, a = lo - pad, b = hi + pad, top = k * lane;
      g.strokeStyle = css('--grid', 'rgba(148,163,184,.2)'); g.beginPath(); g.moveTo(0, top + lane); g.lineTo(W, top + lane); g.stroke();
      g.strokeStyle = palette(k); g.lineWidth = 1.5; g.beginPath(); let m = false;
      for (let i = i0; i < t.length; i++) { if (!Number.isFinite(y[i])) continue; const X = (t[i] - t0) / span * (W - 90), Y = top + lane - 4 - (y[i] - a) / (b - a) * (lane - 8); if (m) g.lineTo(X, Y); else { g.moveTo(X, Y); m = true; } }
      g.stroke(); g.fillStyle = palette(k); g.fillText(`${n} = ${fmt(y[y.length - 1], 4)}`, W - 88, top + 14); g.fillStyle = css('--muted', '#94a3b8'); g.fillText(`${fmt(hi, 3)} / ${fmt(lo, 3)}`, W - 88, top + 28);
    });
  };
  return { bind(fn) { src = fn; }, request() { if (!raf) raf = requestAnimationFrame(draw); }, destroy() { cancelAnimationFrame(raf); src = null; } };
}

export function provTable(rows) { return table(['Quantity', 'Value', 'Unit', 'Provenance'], rows.map(r => [r[0], typeof r[1] === 'number' ? fmt(r[1], 4) : r[1], r[2] || '', provChip(r[3] || 'calc')])); }
export const dl = (txt, name, type = 'text/plain') => import('../core/chart.js').then(m => m.download(new Blob([txt], { type }), name));
