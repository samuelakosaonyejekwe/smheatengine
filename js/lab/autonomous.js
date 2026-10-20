// Workspace 11 — autonomous experiment recommendation: Gaussian-process surrogate of per-cycle net work over two design
// variables, expected-improvement or maximum-variance acquisition, the next most informative test with its rationale.
// Nothing is executed or queued without explicit operator approval; virtual rehearsal results stay 'hypothetical'.
import { h, table, callout, kpiGrid, toast, provChip, spinner } from '../core/ui.js';
import { store } from '../core/state.js';
import { linspace } from '../core/num.js';
import { recommendNext, seriesFromDataset, segmentCycles, runVirtual, getRecord, addRecord, generateProtocol, logEvent, uid } from '../core/lab.js';
import { lab, card, grid, field, numIn, selIn, btn, val, note, row, charts, protocolSelect, saveDataset, f3, f4 } from './common.js';

const VARS = [['Th', 'Hot reservoir T_h', '°C', 50, 90], ['Tc', 'Cold reservoir T_c', '°C', 5, 30], ['sigmaH', 'Power-stroke stress σ_H', 'MPa', 80, 160], ['sigmaL', 'Reset stress σ_L', 'MPa', 40, 100], ['freq', 'Cycle frequency', 'Hz', 0.2, 2], ['dutyHot', 'Hot-phase fraction', '-', 0.3, 0.7]];

export async function render(el) {
  const d = store.project.engine, C = charts(), L = lab(); L.alObs ||= [];
  const v1 = selIn(VARS.map(v => [v[0], v[1]]), 'Th'), v2 = selIn(VARS.map(v => [v[0], v[1]]), 'freq'), lo1 = numIn(50), hi1 = numIn(90), lo2 = numIn(0.2), hi2 = numIn(2);
  const syncB = () => { const a = VARS.find(v => v[0] === v1.value), b = VARS.find(v => v[0] === v2.value); lo1.value = a[3]; hi1.value = a[4]; lo2.value = b[3]; hi2.value = b[4]; }; v1.onchange = syncB; v2.onchange = syncB;
  const acq = selIn([['ei', 'Expected improvement (find the best conditions)'], ['maxvar', 'Maximum variance (reduce model uncertainty)']], 'ei'), useHyp = selIn([['auto', 'Hypothetical results only if no measured ones exist'], ['yes', 'Always include hypothetical (rehearsal)'], ['no', 'Measured / operator-entered only']], 'auto'), prot = protocolSelect('', true);
  el.append(card('Objective & design space', note('The surrogate learns per-cycle net work (∮F dx) as a function of two operating variables from the datasets already in the laboratory plus operator-entered results. Expected improvement balances exploiting the best predicted region with exploring uncertain regions; maximum variance targets pure learning.'),
    grid(field('Variable 1', v1), field('Lower', lo1), field('Upper', hi1), field('Variable 2', v2), field('Lower', lo2), field('Upper', hi2), field('Acquisition', acq), field('Use hypothetical results', useHyp), field('Base protocol for approved tests', prot)),
    row(btn('🎯 Recommend next experiment', () => go(), 'primary'), btn('🖥 Rehearse 5 iterations virtually', () => rehearse(5)))));
  const obsBox = h('div'), out = h('div'), mx1 = numIn(''), mx2 = numIn(''), my = numIn(''), mnote = h('input', { class: 'search', placeholder: 'run / dataset reference' });
  el.append(card('Observations', obsBox, h('h4', {}, 'Enter a result by hand'), grid(field('Variable 1 value', mx1), field('Variable 2 value', mx2), field('Net work per cycle (J)', my), field('Reference', mnote)), row(btn('＋ Add operator-entered result', () => { if (![val(mx1), val(mx2), val(my)].every(Number.isFinite)) return toast('Enter all three numbers.', 'warn'); L.alObs.push({ id: uid('OBS'), x: { [v1.value]: val(mx1), [v2.value]: val(mx2) }, y: val(my), prov: 'user', source: mnote.value || 'operator entry', t: new Date().toISOString() }); store.touch({ type: 'lab' }); drawObs(); }))), out);
  function observations() {
    const k1 = v1.value, k2 = v2.value, obs = [];
    for (const ds of L.datasets) {
      const cond = ds.meta?.inputs?.design || (ds.meta?.protocolId && getRecord(store, 'protocols', ds.meta.protocolId)?.conditions); if (!cond || cond[k1] === undefined || cond[k2] === undefined) continue;
      let W; try { const s = seriesFromDataset(ds); if (!s.F || !s.x) continue; W = segmentCycles(s).summary.Wnet; } catch { continue; }
      if (Number.isFinite(W)) obs.push({ x1: +cond[k1], x2: +cond[k2], y: W, prov: ds.provenance, source: ds.id });
    }
    for (const o of L.alObs) if (o.x[k1] !== undefined && o.x[k2] !== undefined) obs.push({ x1: o.x[k1], x2: o.x[k2], y: o.y, prov: o.prov, source: o.source });
    const real = obs.filter(o => o.prov !== 'hypothetical'), mode = useHyp.value;
    return mode === 'yes' ? obs : mode === 'no' ? real : real.length >= 3 ? real : obs;
  }
  function drawObs() { obsBox.innerHTML = ''; const o = observations(); obsBox.append(o.length ? table([VARS.find(v => v[0] === v1.value)[1], VARS.find(v => v[0] === v2.value)[1], 'W_net per cycle (J)', 'Provenance', 'Source'], o.map(r => [f3(r.x1), f3(r.x2), f4(r.y), provChip(r.prov), r.source])) : note('No usable observations for these two variables yet: the first recommendations are space-filling.')); }
  function go() {
    out.innerHTML = ''; C.dispose(); drawObs();
    const o = observations(), b = [[val(lo1), val(hi1)], [val(lo2), val(hi2)]], n1 = VARS.find(v => v[0] === v1.value), n2 = VARS.find(v => v[0] === v2.value);
    if (v1.value === v2.value) { out.append(callout('warn', 'Choose two different variables.')); return null; }
    const r = recommendNext(o.map(x => [x.x1, x.x2]), o.map(x => x.y), b, { acquisition: acq.value, names: [n1[1], n2[1]], maximize: true });
    const hyp = o.length && o.every(x => x.prov === 'hypothetical'), c = card('Recommended next experiment');
    if (hyp) c.append(callout('warn', 'All observations are hypothetical (virtual or simulated): the surrogate describes the model, not the hardware. Use it to plan; confirm with physical runs.'));
    c.append(kpiGrid([{ label: n1[1], value: r.x[0], unit: n1[2], explain: 'Recommended setting of variable 1.', prov: 'generated' }, { label: n2[1], value: r.x[1], unit: n2[2], explain: 'Recommended setting of variable 2.', prov: 'generated' }, { label: 'Predicted net work', value: Number.isFinite(r.mean) ? `${f4(r.mean)} ± ${f3(r.std)}` : '—', unit: 'J', explain: 'Surrogate mean ± one standard deviation at the recommended point.', prov: 'hypothetical' }, { label: 'Observations used', value: o.length, explain: `${o.filter(x => x.prov !== 'hypothetical').length} measured / operator-entered, ${o.filter(x => x.prov === 'hypothetical').length} hypothetical.` }]), callout('info', h('b', {}, 'Rationale: '), r.rationale));
    if (r.gp) {
      const g1 = linspace(b[0][0], b[0][1], 25), g2 = linspace(b[1][0], b[1][1], 25), M = g2.map(y => g1.map(x => r.predictAt([x, y]))), cg = C.grid(); c.append(cg);
      C.add(cg, { type: 'heatmap', title: 'Surrogate mean of net work per cycle', x: { label: `${n1[1]} (${n1[2]})`, values: g1 }, y: { label: `${n2[1]} (${n2[2]})`, values: g2 }, z: M.map(rw => rw.map(p => p.mean)), zlabel: 'J', isolines: 8, explain: 'Gaussian-process prediction across the design space. It interpolates the observations; far from them it reverts toward the mean and its uncertainty grows.' });
      C.add(cg, { type: 'heatmap', title: 'Surrogate uncertainty (σ)', x: { label: `${n1[1]} (${n1[2]})`, values: g1 }, y: { label: `${n2[1]} (${n2[2]})`, values: g2 }, z: M.map(rw => rw.map(p => p.std)), zlabel: 'J', cmap: 'inferno', explain: 'Standard deviation of the prediction: low near tested conditions, high in unexplored corners. Maximum-variance acquisition picks the brightest point.' });
      c.append(h('h4', {}, 'Alternative candidates'), table(['Rank', n1[1], n2[1], 'Mean (J)', 'σ (J)', 'Acquisition score'], r.top.map((t, i) => [i + 1, f3(t.x[0]), f3(t.x[1]), f4(t.mean), f3(t.std), t.score])));
    }
    const op = h('input', { class: 'search', placeholder: 'approving operator' });
    c.append(h('h4', {}, 'Operator approval'), note('Approval creates a draft protocol with these conditions (to be reviewed and released in workspace 1) and queues the run (workspace 7). Nothing is executed automatically.'), row(op, btn('✔ Approve & queue', () => approve(r, op.value), 'primary'), btn('🖥 Run virtually (rehearsal)', () => rehearseAt(r.x))));
    out.append(c); return r;
  }
  function approve(r, who) {
    if (!who.trim()) return toast('Enter the approving operator.', 'warn');
    const base = prot.value ? getRecord(store, 'protocols', prot.value) : null, cond = { [v1.value]: +r.x[0].toPrecision(4), [v2.value]: +r.x[1].toPrecision(4) };
    const draft = base ? { ...JSON.parse(JSON.stringify(base)), conditions: { ...base.conditions, ...cond } } : generateProtocol({ statement: 'Active-learning recommendation', test: 'cell-cycle', metric: 'netWork', Th: cond.Th ?? d.Th, Tc: cond.Tc ?? d.Tc }, { ...d, ...cond });
    for (const k of ['id', 'created', 'modified', 'status', 'released', 'releasedBy', 'hash']) delete draft[k];
    const p = addRecord(store, 'protocols', { ...draft, name: `${draft.name} · recommended ${Object.entries(cond).map(([k, v]) => `${k}=${v}`).join(', ')}`, parent: base?.id || null, version: (base?.version || 0) + 1, recommendation: { acquisition: r.acquisition, rationale: r.rationale, mean: r.mean, std: r.std, approvedBy: who.trim() } });
    (L.queue ||= []).push({ id: uid('JOB'), name: `Recommended: ${Object.entries(cond).map(([k, v]) => `${k}=${v}`).join(', ')}`, test: p.test, protocolId: p.id, conditions: cond, specimen: '', duration: 2, setup: 0.5, priority: 2, status: 'queued' });
    logEvent(store, 'approve', `recommendation approved by ${who.trim()} → ${p.id}`); store.touch({ type: 'lab' }); toast(`Draft ${p.id} created and queued`, 'ok');
  }
  async function rehearseAt(x) {
    const cond = { [v1.value]: x[0], [v2.value]: x[1] }, p = prot.value ? getRecord(store, 'protocols', prot.value) : null;
    const ds = runVirtual({ ...(p || {}), test: 'cell-cycle', conditions: { ...(p?.conditions || {}), ...cond, recordCycles: 4 } }, { design: d, noise: { F_N: 0.5, x_mm: 0.002, T_spec_C: 0.1 }, seed: L.datasets.length + 1, version: window.TX_VERSION || '' });
    saveDataset(ds, { protocol: p, notes: 'active-learning rehearsal' }); drawObs();
  }
  async function rehearse(k) {
    out.innerHTML = ''; out.append(spinner(`Rehearsing ${k} iterations on the model…`));
    for (let i = 0; i < k; i++) { await new Promise(r => setTimeout(r, 20)); const save = useHyp.value; if (save === 'no') useHyp.value = 'yes'; const r = go(); if (!r) return; await rehearseAt(r.x); }
    go();
  }
  drawObs();
  return { dispose: () => C.dispose() };
}
