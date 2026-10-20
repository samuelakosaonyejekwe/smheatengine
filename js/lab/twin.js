// Workspace 10 — numerical–experimental correlation & digital twin: measured temperature and force drive the constitutive
// model (hybrid replay), predicted vs measured displacement is compared, transformation-temperature shift and
// transformation-strain scale are calibrated by Levenberg–Marquardt, the per-cycle work discrepancy is tracked by a Kalman
// filter, and calibrated values are written back with provenance 'calibrated' (never overwriting the measurements).
import { h, table, callout, kpiGrid, recList, toast, provChip, spinner } from '../core/ui.js';
import { store } from '../core/state.js';
import { smaAlloys, get as getMat } from '../core/materials.js';
import { seriesFromDataset, segmentCycles, replayConstitutive, calibrateTwin, twinTracker, loopWork, hybridReplay, getRecord, logEvent } from '../core/lab.js';
import { lab, card, grid, field, numIn, selIn, btn, val, note, row, charts, datasetSelect, dsBadges, saveDataset, f3, f4 } from './common.js';

export async function render(el) {
  const d = store.project.engine, C = charts();
  const dsSel = datasetSelect(x => { const s = seriesFromDataset(x); return !!(s.T && s.F && s.x); }), alloy = selIn(smaAlloys().map(m => [m.id, m.name]), d.alloy);
  const A = numIn(+(d.ribbonsPerCell * d.ribbonW * d.ribbonT * 1e6).toPrecision(4)), Lm = numIn(d.ribbonL * 1e3);
  dsSel.onchange = () => { const ds = getRecord(store, 'datasets', dsSel.value), sp = ds?.meta?.specimenId && getRecord(store, 'specimens', ds.meta.specimenId); if (sp?.dims) { A.value = +(sp.dims.n * sp.dims.w * sp.dims.t * 1e-3).toPrecision(4); Lm.value = sp.dims.L; alloy.value = sp.alloy; } else if (ds?.meta?.inputs?.alloy) alloy.value = ds.meta.inputs.alloy; };
  el.append(card('Correlate a dataset with the model', note('Only datasets with temperature, force and displacement channels are listed. The model is driven by the recorded specimen temperature and force (hybrid replay) and predicts the displacement, so the comparison isolates the material law from the heat-transfer and load models.'),
    grid(field('Dataset', dsSel), field('Alloy card', alloy), field('Bundle cross-section (mm²)', A), field('Active length (mm)', Lm)), row(btn('▶ Compare & calibrate', () => go(), 'primary'))));
  const out = h('div'); el.append(out);
  async function go() {
    out.innerHTML = ''; C.dispose(); const ds = getRecord(store, 'datasets', dsSel.value); if (!ds) { out.append(callout('warn', 'Choose a dataset (record one in workspace 5, run one in workspace 2 or import one in workspace 9).')); return; }
    out.append(spinner('Calibrating…')); await new Promise(r => setTimeout(r, 30));
    const s = seriesFromDataset(ds), mat = getMat(alloy.value), area = val(A) * 1e-6, L = val(Lm) * 1e-3;
    let cal; try { cal = calibrateTwin(mat, { T: s.T, F: s.F, x: s.x }, { area, L }); } catch (e) { out.innerHTML = ''; out.append(callout('fail', 'Calibration failed: ' + e.message)); return; }
    out.innerHTML = '';
    const tt = cal.t.map(i => s.t[i]), mm = (a) => a.map(v => v * 1e3), c = card(`Correlation: ${ds.id}`, h('div', {}, dsBadges(ds)));
    if (ds.provenance !== 'measured') c.append(callout('warn', `This dataset is provenance “${ds.provenance}”: the calibration is a rehearsal of the procedure. Calibrated values can only be written back from measured data.`));
    c.append(kpiGrid([
      { label: 'RMSE before → after', value: `${f3(cal.mBefore.rmse * 1e3)} → ${f3(cal.mAfter.rmse * 1e3)}`, unit: 'mm', explain: 'Root-mean-square displacement error of the library card and of the calibrated card.', prov: 'calc', status: cal.mAfter.rmse < cal.mBefore.rmse ? 'ok' : 'warn' },
      { label: 'R² after', value: cal.mAfter.r2, explain: 'Fraction of the displacement variance explained by the calibrated model.', prov: 'calc', status: cal.mAfter.r2 > 0.9 ? 'ok' : 'warn' },
      { label: 'Transformation-temperature shift', value: `${f3(cal.p.shift)} ± ${f3(cal.se.shift)}`, unit: 'K', explain: `Shift applied to M_s, M_f, A_s, A_f of the card (standard error from the Levenberg–Marquardt covariance). Calibrated A_f = ${f3(cal.calibrated.Af)} °C.`, prov: 'calibrated' },
      { label: 'Transformation-strain scale', value: `${f4(cal.p.epsLScale)} ± ${f3(cal.se.epsLScale)}`, explain: `Calibrated ε_L = ${f4(cal.calibrated.epsL)} (card ${mat.epsL}).`, prov: 'calibrated' },
      { label: 'Normalised RMSE', value: cal.mAfter.nrmse * 100, unit: '% of range', explain: 'Error relative to the displacement range; < 5 % is a good component-level match.', prov: 'calc', status: cal.mAfter.nrmse < 0.05 ? 'ok' : 'warn' },
      { label: 'Bias (mean error)', value: cal.mAfter.bias * 1e3, unit: 'mm', explain: `95 % CI of the bias [${f3(cal.mAfter.biasCI[0] * 1e3)}, ${f3(cal.mAfter.biasCI[1] * 1e3)}] mm; a bias that excludes zero is a systematic model discrepancy.`, prov: 'calc' },
    ]));
    const cg = C.grid(); c.append(cg);
    C.add(cg, { type: 'line', wide: true, title: 'Displacement: measured vs model', x: { label: 'time', unit: 's' }, y: { label: 'contraction x', unit: 'mm' }, series: [{ name: `dataset (${ds.provenance})`, x: tt, y: mm(cal.meas) }, { name: 'library card', x: tt, y: mm(cal.before), dash: '5 4' }, { name: 'calibrated', x: tt, y: mm(cal.pred) }], explain: 'The constitutive model is driven by the recorded temperature and force; differences are pure material-law discrepancy. The calibrated curve should overlay the data in both heating and cooling branches; a residual mismatch confined to one branch points at hysteresis or kinetics, not at the transformation temperatures.' });
    C.add(cg, { type: 'scatter', title: 'Parity plot', x: { label: 'dataset x', unit: 'mm' }, y: { label: 'model x', unit: 'mm' }, series: [{ name: 'calibrated', x: mm(cal.meas), y: mm(cal.pred), mode: 'markers' }, { name: '1:1', x: [Math.min(...mm(cal.meas)), Math.max(...mm(cal.meas))], y: [Math.min(...mm(cal.meas)), Math.max(...mm(cal.meas))] }], explain: 'Points on the 1:1 line are perfectly predicted. Systematic curvature indicates a missing physical effect rather than a wrong parameter value.' });
    C.add(cg, { type: 'line', title: 'Residuals', x: { label: 'time', unit: 's' }, y: { label: 'model − dataset', unit: 'mm' }, series: [{ name: 'residual', x: tt, y: cal.pred.map((v, i) => (v - cal.meas[i]) * 1e3) }], annotations: [{ type: 'hline', y: 0 }], explain: 'Residual structure that repeats every cycle is model discrepancy; random scatter at the sensor noise level means the model explains everything the instruments can resolve.' });
    // Kalman-updated twin on per-cycle work
    let tw = null, seg = null; try {
      seg = segmentCycles(s); const xFull = replayConstitutive(mat, { T: s.T, F: s.F }, { area, L, shift: cal.p.shift, epsLScale: cal.p.epsLScale, x0: cal.p.x0 });
      const Wm = seg.cycles.map(cy => cy.Wnet), Wp = seg.cycles.map(cy => loopWork(s.F, xFull, cy.i0, cy.i1).Wnet);
      if (Wm.length >= 2) { tw = twinTracker(Wm, Wp); C.add(cg, { type: 'line', title: 'Kalman-updated twin: net work per cycle', x: { label: 'cycle' }, y: { label: 'W_net', unit: 'J' }, series: [{ name: 'dataset', x: seg.cycles.map(c2 => c2.k), y: Wm, mode: 'markers' }, { name: 'calibrated model', x: seg.cycles.map(c2 => c2.k), y: Wp }, { name: 'twin (model + δ̂)', x: seg.cycles.map(c2 => c2.k), y: tw.twin }], explain: `A random-walk Kalman filter estimates the remaining discrepancy δ between dataset and model cycle by cycle (final δ̂ = ${f4(tw.finalDelta)} ± ${f3(tw.finalSd)} J). A δ that keeps growing signals drift of the specimen (functional fatigue) that the static calibration cannot capture.` }); }
    } catch (e) { c.append(note('Per-cycle twin unavailable: ' + e.message)); }
    const corr = cal.corr; if (corr) c.append(h('h4', {}, 'Parameter correlation'), table(['', 'shift', 'ε_L scale', 'x₀'], ['shift', 'ε_L scale', 'x₀'].map((n, i) => [n, ...corr[i].map(v => f3(v))])), note('|correlation| > 0.9 means the data cannot separate the two parameters — add a run at a different stress or temperature amplitude.'));
    const recs = [];
    if (Math.abs(cal.p.shift) > 5) recs.push({ level: 'warn', text: `The lot transforms ${f3(cal.p.shift)} K ${cal.p.shift > 0 ? 'higher' : 'lower'} than the card: update the reservoir margins in the pre-screen and re-run Suites 04–05 with the calibrated card.`, basis: `shift ${f3(cal.p.shift)} ± ${f3(cal.se.shift)} K` });
    if (cal.p.epsLScale < 0.8) recs.push({ level: 'warn', text: 'Recoverable strain is well below the card value: check training state, grip slip and preload.', basis: `ε_L scale ${f3(cal.p.epsLScale)}` });
    recs.push({ level: 'good', text: 'Validate the calibrated parameters on a hold-out dataset (different specimen or conditions) before claiming predictive capability; calibration and validation data must stay separate.', basis: 'Module 19 verification evidence' });
    c.append(h('h4', {}, 'Recommendations'), recList(recs));
    c.append(row(btn('✔ Write calibrated values (provenance “calibrated”)', () => {
      if (ds.provenance !== 'measured') return toast('Refused: calibrated values can only come from measured datasets.', 'fail', 7000);
      const Lb = lab(); Lb.calibrated[mat.id] = { values: { Ms: cal.calibrated.Ms, Mf: cal.calibrated.Mf, As: cal.calibrated.As, Af: cal.calibrated.Af, epsL: cal.calibrated.epsL }, u: { Ms: cal.se.shift, Mf: cal.se.shift, As: cal.se.shift, Af: cal.se.shift, epsL: cal.calibrated.uEpsL }, prov: 'calibrated', dataset: ds.id, rmse: cal.mAfter.rmse, t: new Date().toISOString(), twinDelta: tw ? { delta: tw.finalDelta, sd: tw.finalSd } : null };
      logEvent(store, 'calibrate', `${mat.id} calibrated from ${ds.id}: shift ${f3(cal.p.shift)} K, εL ×${f4(cal.p.epsLScale)}`); store.touch({ type: 'lab' }); toast(`Calibrated card values for ${mat.id} stored with provenance “calibrated”`, 'ok'); drawCal();
    }, 'primary'), btn('⇄ Save hybrid dataset (measured + model column)', () => { try { saveDataset(hybridReplay(ds, mat, { area, L, shift: cal.p.shift, epsLScale: cal.p.epsLScale })); } catch (e) { toast(e.message, 'fail'); } })));
    out.append(c);
  }
  const calBox = h('div'); el.append(card('Calibrated parameters (write-back register)', note('Stored separately from the library cards and from the measurements; each entry names the dataset it was fitted to. Suites can adopt them as provenance “calibrated” inputs.'), calBox));
  function drawCal() { calBox.innerHTML = ''; const E = Object.entries(lab().calibrated); calBox.append(E.length ? table(['Alloy', 'Parameter', 'Value', 'Std. unc.', 'Provenance', 'Dataset', 'Time'], E.flatMap(([a, c]) => Object.entries(c.values).map(([k, v]) => [a, k, f4(v), f3(c.u?.[k]), provChip('calibrated'), c.dataset, new Date(c.t).toLocaleString()]))) : note('No calibrated values yet.')); }
  drawCal();
  return { dispose: () => C.dispose() };
}
