// Workspace 1 — hypothesis & protocol generator: the acceptance criteria are fixed BEFORE testing; released protocols are
// immutable and revisions create descendants with a lineage.
import { h, table, callout, kpiGrid, verdicts, recList, toast, provChip } from '../core/ui.js';
import { store } from '../core/state.js';
import { smaAlloys, get as getMat } from '../core/materials.js';
import { preScreen, designWith } from '../core/engine.js';
import { METRICS, TEST_TYPES, INSTRUMENT_TYPES, generateProtocol, sampleSize, addRecord, releaseProtocol, reviseProtocol, removeRecord, lineage, calStatus } from '../core/lab.js';
import { lab, card, grid, field, numIn, txtIn, selIn, btn, val, note, explainList, charts, row, f3 } from './common.js';
import { session } from './common.js';

export async function render(el, { go }) {
  const d = store.project.engine, C = charts(), alloys = smaAlloys().map(m => [m.id, m.name]);
  const st = h('textarea', { class: 'search', rows: 2, style: 'width:100%' }, 'The low-hysteresis NiTiCu ribbon delivers at least 10 % more net closed-cycle work per cycle than the NiTi LT reference at 70 °C / 15 °C under identical loads.');
  const cand = selIn(alloys, 'niticu'), ref = selIn([['', '— none (compare with a threshold) —'], ...alloys], d.alloy), met = selIn(Object.entries(METRICS).map(([k, m]) => [k, m.label]), 'netWork'), test = selIn(Object.entries(TEST_TYPES).map(([k, t]) => [k, t.label]), 'cell-cycle');
  const Th = numIn(d.Th), Tc = numIn(d.Tc), cv = numIn(0.08, { step: 0.01 }), delta = numIn(0.1, { step: 0.01 }), alpha = numIn(0.05, { step: 0.01 }), power = numIn(0.8, { step: 0.05 }), cycles = numIn(20, { step: 1 });
  el.append(card('State the hypothesis', note('Write the claim so it can be falsified: a candidate, a reference (or threshold), one primary metric, the reservoir temperatures and the smallest effect worth detecting. The expected run-to-run coefficient of variation drives the sample size.'),
    field('Hypothesis statement', st),
    grid(field('Candidate alloy', cand), field('Reference (control)', ref), field('Primary metric', met), field('Test type', test), field('Hot reservoir T_h (°C)', Th), field('Cold reservoir T_c (°C)', Tc),
      field('Expected run-to-run CV', cv, 'e.g. 0.05–0.10 for a careful single-ribbon rig'), field('Minimum relative effect δ', delta), field('Significance α', alpha), field('Power 1 − β', power), field('Cycles per run', cycles)),
    row(btn('⚙ Generate protocol', () => gen(), 'primary'))));
  const out = h('div'); el.append(out);
  const reg = h('div'); el.append(card('Protocol register (versioned)', note('Draft protocols can be edited or deleted. Released protocols are permanent and carry a content hash; any change creates a new revision that records its parent, so every dataset can be traced to the exact procedure that produced it.'), reg));
  let draft = null, hypObj = null;

  function gen() {
    out.innerHTML = ''; C.dispose();
    hypObj = { statement: st.value.trim(), candidate: cand.value, reference: ref.value, metric: met.value, test: test.value, Th: val(Th), Tc: val(Tc), cv: val(cv), delta: val(delta), alpha: val(alpha), power: val(power), cycles: val(cycles) };
    if (!(hypObj.Th > hypObj.Tc)) { out.append(callout('fail', 'T_h must exceed T_c: without a temperature difference no heat engine (and no positive net work) is possible.')); return; }
    draft = generateProtocol(hypObj, d);
    const design = designWith(d, { Th: hypObj.Th, Tc: hypObj.Tc, alloy: cand.value }), flags = preScreen(design, getMat(cand.value)), inst = lab().instruments;
    const ss = draft.sampleSize, sCard = card('Generated protocol: ' + draft.name);
    sCard.append(kpiGrid([
      { label: 'Runs per group', value: ss.n, explain: `${ss.design === 'two-sample' ? 'Candidate and reference each' : 'Candidate'} need ${ss.n} independent runs to detect a ${(hypObj.delta * 100).toFixed(0)} % effect with CV ${(hypObj.cv * 100).toFixed(0)} %, α = ${hypObj.alpha}, power ${hypObj.power} (normal approximation ${f3(ss.nNormal)} plus small-sample correction).`, prov: 'calc' },
      { label: 'Total runs', value: ss.n * (hypObj.reference ? 2 : 1) + 2, explain: 'Includes the zero-heat and no-load control runs, which expose instrument or fixture artefacts that could masquerade as net work.', prov: 'calc' },
      { label: 'Recorded cycles per run', value: hypObj.cycles, explain: 'Per-cycle net work is averaged over the recorded cycles; the cycle-to-cycle scatter and drift are reported separately.', prov: 'user' },
      { label: 'Carnot limit', value: (1 - (hypObj.Tc + 273.15) / (hypObj.Th + 273.15)) * 100, unit: '%', explain: 'Upper bound for any measured efficiency at these reservoirs; a measurement above it indicts the instrumentation (acceptance criterion A5).', prov: 'calc' },
    ]));
    sCard.append(h('h4', {}, 'Physical pre-screen of the candidate at these conditions'), verdicts(flags.map(f => ({ test: f.test, status: f.status, detail: f.detail + (f.fix && f.status !== 'pass' ? ' Fix: ' + f.fix : '') }))));
    sCard.append(h('h4', {}, 'Procedure steps'), table(['#', 'Operation', 'Channel / setpoint', 'Duration', 'Instruction'], draft.steps.map((s, i) => [i + 1, s.op, s.channel ? `${s.channel} = ${s.value}` : '', s.duration_s ? `${s.duration_s} s` : '', s.label])));
    sCard.append(h('h4', {}, 'Controls'), explainList(draft.controls));
    sCard.append(h('h4', {}, 'Acceptance criteria (fixed before testing)'), table(['ID', 'Criterion'], draft.acceptance.map(a => [a.id, a.text])));
    sCard.append(h('h4', {}, 'Required instruments and register status'), table(['Instrument', 'Supplies', 'In register', 'Calibration'], draft.instruments.map(k => { const have = inst.filter(i => i.type === k); const best = have.map(i => calStatus(i)).sort((a, b) => (b.days ?? -1e9) - (a.days ?? -1e9))[0]; return [INSTRUMENT_TYPES[k].label, INSTRUMENT_TYPES[k].supplies, have.length ? `${have.length}` : 'missing', best ? best.label : '—']; })));
    sCard.append(h('h4', {}, 'Safety notes'), callout('warn', explainList(draft.safety)));
    sCard.append(h('h4', {}, 'Suites that supply inputs'), h('div', { class: 'row gap wrap' }, ...draft.suites.map(([id, w]) => h('a', { class: 'chip', href: `#/suite/${id}` }, `${id.toUpperCase()} · ${w}`))));
    const cg = C.grid(); sCard.append(cg);
    const ds = [0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3], cvs = [0.04, 0.08, 0.12];
    C.add(cg, { type: 'line', title: 'Runs per group vs. detectable effect', x: { label: 'relative effect δ', unit: '-' }, y: { label: 'runs per group', log: true }, series: cvs.map(c => ({ name: `CV ${(c * 100).toFixed(0)} %`, x: ds, y: ds.map(dd => sampleSize({ cv: c, delta: dd, alpha: hypObj.alpha, power: hypObj.power, design: ss.design }).n) })), annotations: [{ type: 'vline', x: hypObj.delta, label: 'chosen δ' }], explain: 'How many independent runs each group needs. Halving the detectable effect roughly quadruples the runs; reducing run-to-run scatter (better bath stability, grip repeatability, thermal contact) is usually cheaper than more runs.' });
    const recs = [];
    if (ss.n > 10) recs.push({ level: 'warn', text: `${ss.n} runs per group is a large campaign: first reduce the run-to-run CV (currently assumed ${(hypObj.cv * 100).toFixed(0)} %) with bath control to ±0.2 K and a fixed-preload grip, or accept a larger δ.`, basis: 'n ∝ (CV/δ)²' });
    if (flags.some(f => f.status === 'fail')) recs.push({ level: 'critical', text: 'The pre-screen marks the candidate as infeasible at these conditions; the experiment would only confirm a stalled or incomplete transformation. Adjust temperatures or stresses before releasing.', basis: 'engine.preScreen' });
    const m = getMat(cand.value); if (m && m.evidence !== 'certified') recs.push({ level: 'info', text: `The candidate card is “${m.evidence}”: run V0 characterisation (DSC + tensile loops) on the actual lot before cycling tests, as the first-demonstrator order requires.`, basis: 'Specification §33 V0, §41' });
    recs.push({ level: 'good', text: 'Randomise the run order of candidate and reference and keep the reference specimen in every session (persistent control) to expose drift.', basis: 'Specification §34' });
    sCard.append(h('h4', {}, 'Recommendations'), recList(recs));
    sCard.append(row(btn('💾 Save hypothesis & draft protocol', () => save(), 'primary'), btn('🖥 Save and run virtually', () => { const p = save(); if (p) { session.selectedProtocol = p.id; go('virtual'); } })));
    out.append(sCard);
  }
  function save() {
    if (!draft) return null;
    const hy = addRecord(store, 'hypotheses', { ...hypObj, name: hypObj.statement.slice(0, 80), status: 'open', prov: 'hypothetical' });
    const p = addRecord(store, 'protocols', { ...draft, hypothesisId: hy.id }); toast(`Saved ${hy.id} and draft protocol ${p.id}`, 'ok'); drawReg(); return p;
  }
  function drawReg() {
    reg.innerHTML = ''; const P = lab().protocols;
    if (!P.length) { reg.append(note('No protocols yet. Generate one above.')); return; }
    reg.append(table(['ID', 'Name', 'Ver.', 'Status', 'Hash', 'Lineage', 'Actions'], P.map(p => [p.id, p.name, p.version, h('span', { class: `badge ${p.status === 'released' ? 'ok' : 'warn'}` }, p.status), p.hash || '—', lineage(store, p.id).map(x => x.id).reverse().join(' → '),
      h('div', { class: 'row gap wrap' },
        p.status !== 'released' ? btn('Release', () => { const by = prompt('Released by (name):', ''); if (!by) return; try { releaseProtocol(store, p.id, by); toast(`${p.id} released`, 'ok'); } catch (e) { toast(e.message, 'fail'); } drawReg(); }, 'sm') : null,
        btn('Revise', () => { const r = reviseProtocol(store, p.id); toast(`Revision ${r.id} (v${r.version}) created`, 'ok'); drawReg(); }, 'sm'),
        btn('Run virtually', () => { session.selectedProtocol = p.id; go('virtual'); }, 'sm'),
        p.status !== 'released' ? btn('Delete', () => { if (confirm(`Delete draft ${p.id}?`)) { removeRecord(store, 'protocols', p.id); drawReg(); } }, 'sm') : null)])));
    const H = lab().hypotheses; if (H.length) reg.append(h('h4', {}, 'Hypotheses'), table(['ID', 'Statement', 'Status', 'Provenance'], H.map(x => [x.id, x.statement, x.status, provChip(x.prov || 'hypothetical')])));
  }
  drawReg();
  return { dispose: () => C.dispose() };
}
