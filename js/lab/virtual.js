// Workspace 2 — virtual experiment construction & simulation: a protocol executed on the shared models; output in the
// laboratory dataset schema, always provenance 'hypothetical' and kind 'virtual'.
import { h, kpiGrid, callout, recList, table, spinner } from '../core/ui.js';
import { store } from '../core/state.js';
import { smaAlloys } from '../core/materials.js';
import { TEST_TYPES, runVirtual, seriesFromDataset, segmentCycles, getRecord } from '../core/lab.js';
import { card, grid, field, numIn, selIn, btn, val, note, charts, row, protocolSelect, saveDataset, dsBadges, session, f3, f4 } from './common.js';

export async function render(el) {
  const d = store.project.engine, C = charts();
  const prot = protocolSelect(session.selectedProtocol || '', true), test = selIn(Object.entries(TEST_TYPES).map(([k, t]) => [k, t.label]), 'cell-cycle'), alloy = selIn(smaAlloys().map(m => [m.id, m.name]), d.alloy);
  const Th = numIn(d.Th), Tc = numIn(d.Tc), sH = numIn(d.sigmaH), sL = numIn(d.sigmaL), freq = numIn(d.freq, { step: 0.1 }), nCyc = numIn(5, { step: 1 }), fid = selIn([['screening', 'Screening (fast)'], ['high', 'High fidelity (finer mesh and time step)']], 'screening'), noise = selIn([['none', 'No sensor noise'], ['rehearse', 'Add synthetic sensor noise (rehearsal)']], 'none');
  const sync = () => { const p = prot.value && getRecord(store, 'protocols', prot.value); if (!p) return; test.value = p.test; alloy.value = p.candidate || d.alloy; const c = p.conditions || {}; for (const [k, e] of [['Th', Th], ['Tc', Tc], ['sigmaH', sH], ['sigmaL', sL], ['freq', freq]]) if (c[k] !== undefined) e.value = c[k]; };
  prot.onchange = sync; sync();
  el.append(card('Construct the virtual experiment', note('Pick a protocol (its conditions are copied) or build an ad-hoc test. The run uses the same physical models as the suites: ribbon-cell transient (finite-volume conduction + kinetics + clutch), quasi-static isobaric loop, isothermal tensile test, simulated DSC or the whole-engine model.'),
    grid(field('Protocol', prot), field('Test type', test), field('Alloy', alloy), field('T_h (°C)', Th), field('T_c (°C)', Tc), field('σ_H power stroke (MPa)', sH), field('σ_L reset (MPa)', sL), field('Cycle frequency (Hz)', freq), field('Cycles to record', nCyc), field('Fidelity', fid), field('Sensor noise', noise)),
    row(btn('▶ Run virtual experiment', () => run(), 'primary'), btn('⇆ Candidate vs reference (matched conditions)', () => matched()))));
  const out = h('div'); el.append(out);

  const build = (alloyId) => {
    const p = prot.value ? getRecord(store, 'protocols', prot.value) : null;
    return { ...(p || {}), test: test.value, candidate: alloyId, conditions: { ...(p?.conditions || {}), Th: val(Th), Tc: val(Tc), sigmaH: val(sH), sigmaL: val(sL), freq: val(freq), alloy: alloyId, recordCycles: val(nCyc) } };
  };
  const noiseSd = () => noise.value === 'rehearse' ? { F_N: 0.5, x_mm: 0.002, T_spec_C: 0.1, T_fluid_C: 0.1, stress_MPa: 0.2, heatflow_mW: 0.05 } : null;
  async function run() {
    out.innerHTML = ''; C.dispose(); out.append(spinner('Solving the model…')); await new Promise(r => setTimeout(r, 30));
    let ds; try { ds = runVirtual(build(alloy.value), { design: d, fidelity: fid.value, noise: noiseSd(), version: window.TX_VERSION || '' }); } catch (e) { out.innerHTML = ''; out.append(callout('fail', 'Virtual run failed: ', e.message, ' — the inputs may be outside the model’s validity range.')); return; }
    out.innerHTML = ''; show(ds);
  }
  function show(ds) {
    const s = ds.meta.summary || {}, cg = C.grid(), c = card(ds.name, h('div', { style: 'margin-bottom:6px' }, dsBadges(ds)), callout('warn', h('b', {}, 'Model prediction, not a measurement. '), 'This dataset is provenance “hypothetical”. It can rehearse the analysis chain and guide the physical test, but it never counts toward the validation ladder.'));
    const k = [], recs = [];
    if (ds.test === 'cell-cycle') {
      const ser = seriesFromDataset(ds); let seg = null; try { seg = segmentCycles(ser); } catch { seg = null; }
      k.push({ label: 'Net work per cycle (load)', value: s.Wout, unit: 'J', explain: 'Work delivered to the output load through the one-way clutch in the last solved cycle, after the reset; this is what can become shaft work.', prov: 'hypothetical', status: s.Wout > 0 ? 'ok' : 'bad' },
        { label: 'Contraction / reset work', value: `${f3(s.Wcontraction)} / ${f3(s.Wreset)}`, unit: 'J', explain: 'Gross work done by the ribbon while contracting vs. work spent re-extending it in the cold phase. Gross contraction alone is never net output.', prov: 'hypothetical' },
        { label: 'Loop work ∮F dx (segmented)', value: seg?.summary.Wnet, unit: 'J', explain: `Same quantity computed from the recorded force–displacement channels exactly as the analysis workspace will treat a physical run (${seg?.summary.n ?? 0} cycles). Small differences from the solver value come from trapezoidal integration across clutch engagement steps.`, prov: 'hypothetical' },
        { label: 'Stroke', value: s.stroke_mm, unit: 'mm', explain: 'Peak-to-peak contraction displacement of the ribbon bundle in one cycle.', prov: 'hypothetical' },
        { label: 'Specific power (active)', value: s.specificPower, unit: 'W/kg', explain: 'Net load work × frequency / active ribbon mass (active-SMA mass basis only).', prov: 'hypothetical' },
        { label: 'Efficiency / Carnot', value: `${f3(s.eta * 100)} % / ${f3(s.etaCarnot * 100)} %`, explain: 'Load work over heat drawn from the hot fluid in the cycle, against the Carnot bound.', prov: 'hypothetical', status: s.eta < s.etaCarnot ? 'ok' : 'bad' },
        { label: 'Energy residual', value: s.energyResidual * 100, unit: '% of Q_hot', explain: 'First-law closure of the solved cycle (verification): should be well below 1 %.', prov: 'calc', status: Math.abs(s.energyResidual) < 0.01 ? 'ok' : 'warn' },
        { label: 'Phase swing Δξ', value: s.xiSwing, explain: 'Fraction of the ribbon that transforms each cycle; below ~0.8 the cycle is too fast or the reservoirs too close to the transformation temperatures.', prov: 'hypothetical', status: s.xiSwing > 0.8 ? 'ok' : 'warn' });
      const t = ds.columns.t_s, P = 1 / val(freq), n1 = t.findIndex(v => v >= Math.min(3, Math.round(val(nCyc))) * P) - 1, sl = (a) => a.slice(0, n1 > 0 ? n1 : a.length), tt = sl(t);
      C.add(cg, { type: 'line', title: 'Temperatures', x: { label: 'time', unit: 's' }, y: { label: 'temperature', unit: '°C' }, series: [{ name: 'fluid', x: tt, y: sl(ds.columns.T_fluid_C) }, { name: 'wall', x: tt, y: sl(ds.columns.T_wall_C) }, { name: 'ribbon (mean)', x: tt, y: sl(ds.columns.T_spec_C) }], explain: 'The switching fluid, the heat-exchange wall and the through-thickness mean ribbon temperature. The ribbon lags the fluid by the wall capacity and contact resistance; if it never reaches A_f under load the reverse transformation is incomplete.' });
      C.add(cg, { type: 'line', title: 'Force and displacement', x: { label: 'time', unit: 's' }, y: { label: 'force (N) / displacement (mm × 100)' }, series: [{ name: 'force F', x: tt, y: sl(ds.columns.F_N) }, { name: 'displacement x ×100', x: tt, y: sl(ds.columns.x_mm).map(v => v * 100) }], explain: 'Force rises by the load when the clutch engages during hot-phase contraction; the bias force alone re-extends the ribbon in the cold phase. Displacement is contraction-positive.' });
      if (seg?.cycles.length) { const c0 = seg.cycles[0]; C.add(cg, { type: 'line', title: 'Work loop F–x (one cycle)', x: { label: 'contraction x', unit: 'mm' }, y: { label: 'force F', unit: 'N' }, series: [{ name: 'cycle 1', x: ser.x.slice(c0.i0, c0.i1 + 1).map(v => v * 1e3), y: ser.F.slice(c0.i0, c0.i1 + 1) }], explain: 'The enclosed area is the net work per cycle: the upper branch is the contraction under load, the lower branch the reset under the bias force. A loop traversed the other way would mean the cycle consumes work.' }); }
      C.add(cg, { type: 'line', title: 'Martensite fraction vs. ribbon temperature', x: { label: 'ribbon temperature', unit: '°C' }, y: { label: 'ξ', unit: '-' }, series: [{ name: 'ξ', x: sl(ds.columns.T_spec_C), y: sl(ds.columns.xi) }], explain: 'The hysteresis loop of the phase transformation under the cycle stresses; its width is the thermal hysteresis that must be overcome every cycle.' });
      if (s.Wout <= 0) recs.push({ level: 'critical', text: 'No positive net work at these conditions: raise T_h above A_f(σ_H), lower σ_H, or lengthen the hot phase.', basis: `W_out = ${f4(s.Wout)} J` });
      if (s.xiSwing < 0.8) recs.push({ level: 'warn', text: `Only ${(s.xiSwing * 100).toFixed(0)} % of the ribbon transforms: reduce frequency or ribbon thickness, or improve contact conductance.`, basis: 'Δξ from the transient model' });
      recs.push({ level: 'info', text: 'Use this run to fix the acquisition rate (≥ 50 samples per cycle), the force and displacement ranges and the interlock limits before the physical test.', basis: `peak force ${f3(Math.max(...ds.columns.F_N))} N, stroke ${f3(s.stroke_mm)} mm` });
    } else if (ds.test === 'quasi-static') {
      k.push({ label: 'Net loop work', value: s.w_J_kg, unit: 'J/kg', explain: 'Enclosed σ–ε loop area per kg (quasi-static upper bound for the material at these stresses and reservoirs).', prov: 'hypothetical' }, { label: 'Contraction / reset', value: `${f3(s.wContraction_J_kg)} / ${f3(s.wReset_J_kg)}`, unit: 'J/kg', explain: 'Gross and reset parts of the loop.', prov: 'hypothetical' }, { label: 'Material efficiency', value: s.eta * 100, unit: '%', explain: 'Loop work over sensible + latent heat input per kg (no regeneration).', prov: 'hypothetical' }, { label: 'Carnot', value: s.etaCarnot * 100, unit: '%', explain: 'Upper bound.', prov: 'calc' });
      C.add(cg, { type: 'line', title: 'Stress–strain work loop', x: { label: 'strain', unit: '-' }, y: { label: 'stress', unit: 'MPa' }, series: [{ name: 'loop', x: ds.columns.strain, y: ds.columns.stress_MPa }], explain: 'Load cold → heat at σ_H (contraction) → unload hot → cool at σ_L (re-extension). The enclosed area is the net work density.' });
      C.add(cg, { type: 'line', title: 'Strain vs. temperature', x: { label: 'T', unit: '°C' }, y: { label: 'strain', unit: '-' }, series: [{ name: 'path', x: ds.columns.T_C, y: ds.columns.strain }], explain: 'Recovery on heating and re-extension on cooling; the horizontal separation of the branches is the stress-shifted hysteresis.' });
    } else if (ds.test === 'tensile') {
      k.push(...Object.entries(s).map(([kk, v]) => ({ label: kk.replace(/_/g, ' '), value: v, explain: kk.startsWith('dissipated') ? 'Hysteresis area of the isothermal load–unload loop (energy dissipated per volume).' : 'Residual strain after unloading (shape-memory strain recoverable on heating).', prov: 'hypothetical' })));
      const T = [...new Set(ds.columns.T_C)];
      C.add(cg, { type: 'line', title: 'Isothermal tensile loops', x: { label: 'strain', unit: '-' }, y: { label: 'stress', unit: 'MPa' }, series: T.map(tt => { const ii = ds.columns.T_C.map((v, i) => v === tt ? i : -1).filter(i => i >= 0); return { name: `${tt} °C`, x: ii.map(i => ds.columns.strain[i]), y: ii.map(i => ds.columns.stress_MPa[i]) }; }), explain: 'Cold: detwinning plateau with residual strain (shape memory). Hot: superelastic loop if above A_f. These loops are what the V0 tensile calibration must reproduce.' });
    } else if (ds.test === 'dsc') {
      k.push({ label: 'A_p / M_p', value: `${f3(s.Ap)} / ${f3(s.Mp)}`, unit: '°C', explain: 'Peak temperatures of the simulated reverse and forward transformations.', prov: 'hypothetical' }, { label: 'Hysteresis', value: s.hysteresis, unit: 'K', explain: 'Peak separation; the heat engine must swing at least this much plus the stress shift.', prov: 'hypothetical' });
      const hs = ds.columns.segment;
      C.add(cg, { type: 'line', title: 'Simulated DSC thermogram', x: { label: 'T', unit: '°C' }, y: { label: 'heat flow', unit: 'mW' }, series: [{ name: 'heating', x: ds.columns.T_C.filter((_, i) => hs[i]), y: ds.columns.heatflow_mW.filter((_, i) => hs[i]) }, { name: 'cooling', x: ds.columns.T_C.filter((_, i) => !hs[i]), y: ds.columns.heatflow_mW.filter((_, i) => !hs[i]) }], explain: `Model output (${s.unit}) — not a measurement. Compare with the measured thermogram of the actual lot in V0.` });
    } else if (ds.test === 'engine') {
      k.push(...['Pnet', 'Pgross', 'Paux', 'eta', 'pActive', 'carnotFraction'].map(kk => ({ label: kk, value: s[kk], explain: { Pnet: 'Net shaft power after all auxiliaries (W).', Pgross: 'Gross mechanical power of all cells (W).', Paux: 'Pumps, valves and controls (W).', eta: 'Net thermal efficiency.', pActive: 'Net W per kg of active SMA.', carnotFraction: 'Fraction of the Carnot limit.' }[kk], prov: 'hypothetical', status: kk === 'Pnet' ? (s.Pnet > 0 ? 'ok' : 'bad') : undefined })));
      C.add(cg, { type: 'bar', title: 'Power ledger', categories: ['gross', 'shaft', 'pumps', 'valves', 'net'], series: [{ name: 'W', values: [s.Pgross, s.Pshaft, -s.Ppump, -s.Pvalves, s.Pnet] }], y: { label: 'W' }, explain: 'Net = gross × transmission − bearing − pumps − valves − controls. A negative net bar means the auxiliaries consume more than the cells convert.' });
    }
    c.append(kpiGrid(k), cg, table(['Model', 'Inputs hash', 'Data hash', 'Rows', 'Note'], [[ds.meta.model, ds.meta.inputsHash, ds.meta.dataHash, ds.nRows, ds.meta.periodicReplication || ds.meta.noise?.note || '']]), h('h4', {}, 'Recommendations'), recList(recs.length ? recs : [{ level: 'info', text: 'Save the run, then rehearse the analysis (workspace 9) on it before recording a physical test.', basis: 'workflow' }]),
      row(btn('💾 Save virtual dataset + run record', () => saveDataset(ds, { protocol: prot.value ? getRecord(store, 'protocols', prot.value) : null }), 'primary')));
    out.append(c);
  }
  async function matched() {
    const p = prot.value ? getRecord(store, 'protocols', prot.value) : null, refId = p?.reference || d.alloy, candId = alloy.value;
    out.innerHTML = ''; C.dispose(); out.append(spinner('Running candidate and reference at matched conditions…')); await new Promise(r => setTimeout(r, 30));
    const tt = test.value === 'engine' || test.value === 'cell-cycle' ? test.value : 'cell-cycle';
    try {
      const a = runVirtual({ ...build(candId), test: tt }, { design: d }), b = runVirtual({ ...build(refId), test: tt }, { design: d }), key = tt === 'engine' ? 'Pnet' : 'Wout';
      out.innerHTML = ''; const c = card(`Matched comparison: ${candId} vs ${refId}`), cg = C.grid();
      const va = a.meta.summary[key], vb = b.meta.summary[key];
      c.append(callout('warn', 'Both runs are model predictions with identical geometry, loads and reservoirs (the only fair basis, specification §34). The difference is a hypothesis to test, not a result.'),
        kpiGrid([{ label: `${candId}`, value: va, unit: tt === 'engine' ? 'W' : 'J', prov: 'hypothetical', explain: 'Candidate.' }, { label: `${refId}`, value: vb, unit: tt === 'engine' ? 'W' : 'J', prov: 'hypothetical', explain: 'Reference.' }, { label: 'Predicted relative difference', value: vb ? (va - vb) / Math.abs(vb) * 100 : NaN, unit: '%', prov: 'hypothetical', explain: 'Compare with the minimum effect δ in the protocol: a predicted difference below δ means the physical test is unlikely to resolve it.' }]), cg);
      C.add(cg, { type: 'bar', title: 'Predicted primary metric', categories: [candId, refId], series: [{ name: key, values: [va, vb] }], y: { label: tt === 'engine' ? 'W' : 'J' }, explain: 'Model prediction for both alloys at matched conditions.' });
      c.append(row(btn('💾 Save both', () => { saveDataset(a, { protocol: p }); saveDataset(b, { protocol: p }); })));
      out.append(c);
    } catch (e) { out.innerHTML = ''; out.append(callout('fail', e.message)); }
  }
  return { dispose: () => C.dispose() };
}
