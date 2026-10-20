// Workspace 9 — data analysis & uncertainty quantification: import or select a dataset, segment heating/cooling and
// cycles, work loops, per-cycle statistics and drift, GUM and Monte-Carlo uncertainty of work, heat, efficiency and
// specific power, with confidence intervals and the Carnot check.
import { h, table, callout, kpiGrid, recList, toast, verdicts } from '../core/ui.js';
import { store } from '../core/state.js';
import { parseFile, ACCEPT } from '../core/io.js';
import { histogram } from '../core/num.js';
import { seriesFromDataset, segmentCycles, cycleWorkUncertainty, heatInputUncertainty, performanceUncertainty, getRecord, addRecord, calStatus, stableHash, logEvent, datasetCSV } from '../core/lab.js';
import { lab, card, grid, field, numIn, selIn, btn, val, note, row, charts, datasetSelect, dsBadges, f3, f4, dl, session } from './common.js';

export async function render(el) {
  const d = store.project.engine, C = charts();
  let dsSel = datasetSelect(() => true, session.analysisDs || '');
  const sel = dsSel, file = h('input', { type: 'file', accept: ACCEPT }), declare = h('input', { type: 'checkbox' });
  const instSel = h('select', { multiple: true, size: 4, class: 'search', style: 'max-width:100%' }, ...lab().instruments.map(i => h('option', { value: i.id }, `${i.id} · ${i.name} · ${calStatus(i).label}`)));
  el.append(card('Dataset', note('Select a stored dataset or import a CSV / TSV / XLSX / JSON log. Imported files are provenance “imported” unless you declare them as measured — which requires linking at least one registered instrument with a valid calibration certificate.'),
    grid(field('Stored dataset', sel), field('Import a file', file), field('Instruments that produced the file', instSel)),
    h('label', { style: 'display:flex;gap:8px;align-items:center;margin:6px 0' }, declare, h('span', { class: 'small' }, 'Declare the imported file as a measurement from the linked, calibrated instruments')),
    row(btn('▶ Analyse', () => go(), 'primary'))));
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    try {
      const r = await parseFile(f); if (!r.columns) throw new Error('The file has no tabular data.');
      const inst = lab().instruments.filter(i => [...instSel.selectedOptions].some(o => o.value === i.id)), validInst = inst.filter(i => calStatus(i).status === 'valid');
      const meas = declare.checked && validInst.length > 0; if (declare.checked && !meas) toast('Not declared as measured: link at least one instrument with a valid calibration certificate.', 'warn', 7000);
      const header = r.header, columns = {}; for (const hd of header) columns[hd] = r.columns[hd];
      const ds = addRecord(store, 'datasets', { name: f.name, kind: meas ? 'physical' : 'imported', provenance: meas ? 'measured' : 'imported', label: meas ? `Measured — declared by operator with instruments ${validInst.map(i => i.id).join(', ')}` : 'Imported file', test: /dsc/i.test(f.name) ? 'dsc' : /tensile/i.test(f.name) ? 'tensile' : 'cell-cycle', header, columns, units: r.units || {}, nRows: r.nRows, created: new Date().toISOString(), meta: { file: f.name, size: f.size, instrumentIds: inst.map(i => i.id), dataHash: stableHash(columns) } });
      logEvent(store, 'import', `${ds.id} from ${f.name} as ${ds.provenance}`); toast(`Imported ${ds.id} (${ds.provenance})`, 'ok');
      const ns = datasetSelect(() => true, ds.id); dsSel.replaceWith(ns); dsSel = ns; session.analysisDs = ds.id; go(ds.id);
    } catch (e) { toast('Import failed: ' + e.message, 'fail', 8000); }
  };
  const out = h('div'); el.append(out);
  const inst = (type) => lab().instruments.find(i => i.type === type);
  function go(id) {
    const cur = id || dsSel.value; out.innerHTML = ''; C.dispose(); session.analysisDs = cur;
    const ds = cur && getRecord(store, 'datasets', cur); if (!ds) { out.append(callout('warn', 'Choose or import a dataset.')); return; }
    const s = seriesFromDataset(ds), head = card(`${ds.id} · ${ds.name}`, h('div', {}, dsBadges(ds)), ds.provenance === 'measured' ? null : callout('warn', `Provenance “${ds.provenance}”: the analysis is valid as a procedure, but the numbers are ${ds.provenance === 'hypothetical' ? 'model predictions or synthetic data' : 'not traceable to calibrated instruments'} and earn no validation credit.`),
      table(['Quantity', 'Column used'], Object.entries(s.map).map(([k, v]) => [{ t: 'time', F: 'force', x: 'displacement', T: 'specimen temperature', Tf: 'fluid temperature', q: 'heat flow into specimen', phase: 'phase (1 = hot)' }[k], v || '— not found'])));
    out.append(head);
    if (!s.F || !s.x || (!s.T && !s.phase)) { out.append(callout('fail', 'Cycle analysis needs force, displacement and temperature (or phase) columns. Rename the columns (e.g. t_s, F_N, x_mm, T_spec_C) and import again.'), row(btn('⇩ CSV', () => dl(datasetCSV(ds), `${ds.id}.csv`, 'text/csv')))); return; }
    let seg; try { seg = segmentCycles(s); } catch (e) { out.append(callout('fail', e.message)); return; }
    const S = seg.summary, a = card('Cycle segmentation & work loops'), cg = C.grid();
    if (!S.n) { a.append(callout('warn', 'Fewer than two heating onsets were found: no complete cycle to analyse. Record at least three full cycles.')); out.append(a); return; }
    a.append(kpiGrid([
      { label: 'Complete cycles', value: S.n, explain: `Cycles from one heating onset to the next (${seg.threshold === seg.threshold ? `temperature threshold ${f3(seg.threshold)} °C with hysteresis band` : 'from the phase channel'}).`, prov: 'calc' },
      { label: 'Net work per cycle ∮F dx', value: S.Wnet, unit: 'J', explain: `Mean enclosed work-loop area, 95 % CI [${f4(S.ci95[0])}, ${f4(S.ci95[1])}] J (t-distribution over cycles). Net = contraction − reset; never the contraction alone.`, prov: ds.provenance === 'measured' ? 'measured' : 'calc', status: S.positive ? 'ok' : 'bad' },
      { label: 'Contraction / reset work', value: `${f4(S.Wcon)} / ${f4(S.Wres)}`, unit: 'J', explain: 'Gross work delivered while contracting vs. work absorbed while re-extending.', prov: 'calc' },
      { label: 'Cycle-to-cycle CV', value: S.cv * 100, unit: '%', explain: 'Repeatability of the per-cycle net work (V1 requires ≤ 10 %).', prov: 'calc', status: S.cv <= 0.1 ? 'ok' : 'warn' },
      { label: 'Work drift', value: S.driftRel * 100, unit: '%/cycle', explain: 'Linear trend of net work across cycles relative to the mean (functional fatigue, thermal drift or slip).', prov: 'calc', status: Math.abs(S.driftRel) <= 0.005 || !Number.isFinite(S.driftRel) ? 'ok' : 'warn' },
      { label: 'Ratcheting', value: S.xDrift * 1e3, unit: 'mm/cycle', explain: 'Trend of the start-of-cycle displacement: accumulating residual strain or grip slip.', prov: 'calc' },
      { label: 'Stroke', value: S.stroke * 1e3, unit: 'mm', explain: 'Mean peak-to-peak displacement per cycle.', prov: 'calc' },
      { label: 'Period', value: S.period, unit: 's', explain: 'Mean cycle duration.', prov: 'calc' },
      ...(Number.isFinite(S.Qin) ? [{ label: 'Heat input per cycle', value: S.Qin, unit: 'J', explain: 'Positive part of the recorded heat flow integrated over each cycle.', prov: 'calc' }, { label: 'Efficiency', value: S.eta * 100, unit: '%', explain: 'Net work / heat input per cycle (see the uncertainty and Carnot check below).', prov: 'calc' }] : []),
    ]), cg);
    const tt = s.t, Tch = s.T || s.Tf;
    C.add(cg, { type: 'line', wide: true, title: 'Segmented time series', x: { label: 'time', unit: 's' }, y: { label: 'temperature', unit: '°C' }, series: [...(Tch ? [{ name: 'temperature', x: tt, y: Tch }] : []), { name: 'force (scaled to T range)', x: tt, y: scaleTo(s.F, Tch || s.F) }], annotations: seg.segments.filter(g => g.phase === 'heating').slice(0, 60).map(g => ({ type: 'xband', x0: g.t0, x1: g.t1, color: '#ef4444', opacity: 0.12 })), explain: 'Shaded bands are the detected heating segments; cooling segments lie between them. Force is rescaled onto the temperature axis to show phase alignment (the contraction should follow the temperature rise with the thermal lag of the ribbon).' });
    C.add(cg, { type: 'line', title: 'Work loops F–x (first cycles)', x: { label: 'contraction x', unit: 'mm' }, y: { label: 'force F', unit: 'N' }, series: seg.cycles.slice(0, 5).map(c => ({ name: `cycle ${c.k}`, x: s.x.slice(c.i0, c.i1 + 1).map(v => v * 1e3), y: s.F.slice(c.i0, c.i1 + 1) })), explain: 'Each closed loop encloses the net work of one cycle. Clockwise traversal in these axes (upper branch on contraction) means the specimen delivers work; loops that do not close show slip or ratcheting.' });
    C.add(cg, { type: 'line', title: 'Net work per cycle', x: { label: 'cycle' }, y: { label: 'W_net', unit: 'J' }, series: [{ name: 'W_net', x: seg.cycles.map(c => c.k), y: seg.cycles.map(c => c.Wnet), mode: 'markers' }], annotations: [{ type: 'hline', y: S.Wnet, label: 'mean' }, { type: 'band', y0: S.ci95[0], y1: S.ci95[1], label: '95 % CI' }, { type: 'hline', y: 0, label: 'zero', color: '#ef4444' }], explain: 'Per-cycle net work with its mean and 95 % confidence band. A trend through the band indicates drift; points below zero are cycles that consumed work.' });
    a.append(table(['Cycle', 't₀ s', 'Period s', 'Heat s', 'W_net J', 'W_con J', 'W_res J', 'Stroke mm', 'F max N', 'Closure mm', 'Q_in J'], seg.cycles.slice(0, 40).map(c => [c.k, c.t0, c.period, c.heatDur, c.Wnet, c.Wcon, c.Wres, c.stroke * 1e3, c.Fmax, c.closure * 1e3, c.Qin])));
    out.append(a);
    // ---------------- uncertainty
    const lc = inst('loadcell'), lv = inst('lvdt'), U = { uF: numIn(lc?.u ?? 0.05), uFrel: numIn(lc?.uRel ?? 0.0025), uFoff: numIn(lc ? 2 * lc.u : 0.1), ux: numIn((lv?.u ?? 0.002)), uxrel: numIn(lv?.uRel ?? 0.002), m: numIn(+(d.ribbonsPerCell * d.ribbonW * d.ribbonT * d.ribbonL * 6450).toPrecision(4)), um: numIn(1e-5), Q: numIn(Number.isFinite(S.Qin) ? +S.Qin.toPrecision(4) : ''), uQ: numIn(''), mdot: numIn(0.01), umdot: numIn(5e-5), cpw: numIn(4180), dT: numIn(2), uT: numIn(inst('rtd')?.u ?? 0.1), rTT: numIn(0.5, { step: 0.1 }), dt: numIn(+(S.period * 0.5).toPrecision(3)) };
    const ub = h('div'), uc = card('Uncertainty quantification (GUM first-order + Monte Carlo)', note(`Standard uncertainties are pre-filled from the instrument register (${lc ? lc.id : 'no load cell registered — class defaults'}, ${lv ? lv.id : 'no displacement transducer registered — class defaults'}). Displacement inputs in mm.`),
      grid(field('Force noise u_F (N)', U.uF), field('Force scale u_rel', U.uFrel), field('Force offset (N)', U.uFoff), field('Displacement noise (mm)', U.ux), field('Displacement scale u_rel', U.uxrel), field('Active mass (kg)', U.m), field('u(mass) (kg)', U.um)),
      h('h4', {}, 'Heat input Q = ṁ c_p ΔT Δt (if no heat-flow channel)'), grid(field('Q per cycle (J) — blank: use ṁ c_p ΔT Δt', U.Q), field('ṁ (kg/s)', U.mdot), field('u(ṁ)', U.umdot), field('c_p (J/kg K)', U.cpw), field('ΔT across jacket (K)', U.dT), field('u(T) each RTD (K)', U.uT), field('RTD error correlation r', U.rTT), field('Heating time Δt (s)', U.dt)),
      row(btn('Σ Propagate', () => unc(), 'primary')), ub);
    out.append(uc);
    function unc() {
      ub.innerHTML = ''; const c0 = seg.cycles[Math.floor(seg.cycles.length / 2)], F = s.F.slice(c0.i0, c0.i1 + 1), x = s.x.slice(c0.i0, c0.i1 + 1);
      const cw = cycleWorkUncertainty({ F, x }, { uF: val(U.uF), uFrel: val(U.uFrel), uFoff: val(U.uFoff), ux: val(U.ux) * 1e-3, uxrel: val(U.uxrel), n: 1500 });
      const uRand = S.n > 1 ? S.sd / Math.sqrt(S.n) : 0, uW = Math.hypot(cw.uc, uRand);
      const qh = heatInputUncertainty({ mdot: val(U.mdot), umdot: val(U.umdot), cp: val(U.cpw), ucp: val(U.cpw) * 0.002, Tin: val(U.dT), Tout: 0, uT: val(U.uT), rTT: val(U.rTT), dt: val(U.dt), udt: 0.01 });
      const Q = Number.isFinite(val(U.Q)) ? val(U.Q) : qh.y, uQ = Number.isFinite(val(U.uQ)) ? val(U.uQ) : Number.isFinite(val(U.Q)) ? 0.03 * Q : qh.uc;
      const Thot = Math.max(...(s.Tf || s.T)), Tcold = Math.min(...(s.Tf || s.T)), pf = performanceUncertainty({ W: S.Wnet, uW, Q, uQ, f: 1 / S.period, uf: 0.001 / S.period, m: val(U.m), um: val(U.um), Th: Thot, Tc: Tcold, n: 4000 });
      ub.append(kpiGrid([
        { label: 'Net work per cycle', value: `${f4(S.Wnet)} ± ${f3(2 * uW)}`, unit: 'J (k=2)', explain: `Instrument uncertainty of one loop ${f3(cw.uc)} J (GUM) / ${f3(cw.mc.std)} J (Monte Carlo) combined with cycle-to-cycle scatter ${f3(uRand)} J.`, prov: 'calc' },
        { label: 'P(net work > 0)', value: pf.pNetPositive * 100, unit: '%', explain: 'Monte-Carlo probability that the true mean net work per cycle is positive given the uncertainty.', prov: 'calc', status: pf.pNetPositive > 0.975 ? 'ok' : 'bad' },
        { label: 'Heat input per cycle', value: `${f4(Q)} ± ${f3(2 * uQ)}`, unit: 'J (k=2)', explain: Number.isFinite(val(U.Q)) ? 'Operator-supplied Q with 3 % standard uncertainty unless given.' : `From ṁ c_p ΔT Δt; ΔT uncertainty uses correlated RTD errors (r = ${val(U.rTT)}).`, prov: 'calc' },
        { label: 'Efficiency', value: `${f3(pf.eta.y * 100)} ± ${f3(2 * pf.eta.uc * 100)}`, unit: '% (k=2)', explain: `Monte-Carlo 95 % interval [${f3(pf.etaMC.lo * 100)}, ${f3(pf.etaMC.hi * 100)}] %. Carnot limit at the recorded temperatures ${f3(pf.etaC * 100)} %.`, prov: 'calc', status: pf.carnotOK ? 'ok' : 'bad' },
        { label: 'Specific power (active)', value: `${f3(pf.psp.y)} ± ${f3(2 * pf.psp.uc)}`, unit: 'W/kg (k=2)', explain: `Net work × frequency / active mass; Monte-Carlo 95 % [${f3(pf.pspMC.lo)}, ${f3(pf.pspMC.hi)}] W/kg.`, prov: 'calc' },
      ]));
      ub.append(h('h4', {}, 'Work uncertainty budget (one loop)'), table(['Source', 'Contribution (J)', 'Share of variance'], cw.budget.map(b => [b.name, b.contrib, `${f3(b.share * 100)} %`])), h('h4', {}, 'Heat-input budget'), table(['Input', 'Value', 'u', 'Sensitivity', 'Contribution', 'Share'], qh.budget.map(b => [b.name, b.x, b.u, b.c, b.contrib, `${f3(b.share * 100)} %`])));
      const cg2 = C.grid(); ub.append(cg2); const hh = histogram(pf.etaMC.samples.map(v => v * 100), 30);
      C.add(cg2, { type: 'bar', title: 'Monte-Carlo distribution of efficiency', categories: hh.centers.map(v => f3(v)), series: [{ name: 'samples', values: hh.counts }], x: { label: 'η (%)' }, y: { label: 'count' }, explain: `Distribution of the efficiency from ${pf.etaMC.n} Monte-Carlo samples of net work and heat input. The 95 % interval is [${f3(pf.etaMC.lo * 100)}, ${f3(pf.etaMC.hi * 100)}] %. If any appreciable mass lies above the Carnot limit (${f3(pf.etaC * 100)} %), the heat measurement is suspect.` });
      const top = cw.budget[0];
      ub.append(verdicts([{ test: 'Net closed-cycle work is positive with 95 % confidence', status: S.ci95[0] > 0 && pf.pNetPositive > 0.975 ? 'pass' : 'fail', detail: `Mean ${f4(S.Wnet)} J, CI [${f4(S.ci95[0])}, ${f4(S.ci95[1])}] J.` }, { test: 'Efficiency below the Carnot limit', status: pf.carnotOK ? 'pass' : 'fail', detail: `η 95 % lower bound ${f3(pf.etaMC.lo * 100)} % vs Carnot ${f3(pf.etaC * 100)} %.` }, { test: 'Repeatable cycles (CV ≤ 10 %)', status: S.repeatable ? 'pass' : 'warn', detail: `CV ${f3(S.cv * 100)} % over ${S.n} cycles.` }]),
        recList([{ level: top.share > 0.5 ? 'warn' : 'info', text: `Dominant work uncertainty: ${top.name} (${f3(top.share * 100)} % of variance). ${/scale/.test(top.name) ? 'Re-calibrate that transducer against a traceable standard.' : /noise/.test(top.name) ? 'Average more samples per cycle or filter (the analysis can be repeated on a smoothed record).' : 'Close the loop exactly (same start/end position) or zero the load cell before each run.'}`, basis: 'GUM budget' }, ...(ds.provenance !== 'measured' ? [{ level: 'info', text: 'Repeat this analysis on a measured dataset before quoting any of these numbers.', basis: `provenance ${ds.provenance}` }] : []), { level: 'good', text: 'Report net work, heat input, mass basis, temperatures, duration and the uncertainty together whenever a specific-power or efficiency claim is made.', basis: 'Specification §34' }]));
    }
    unc();
    out.append(card('Hand-over', note('Measured or imported datasets can be routed to Suite 19 (experimental management & twin) and appear there as its imported experiments.'), row(btn('→ Send to Suite 19 imports', () => { if (ds.provenance === 'hypothetical') return toast('Virtual or simulated data are not sent as experiments.', 'warn'); const E = (store.project.experiments.s19 ||= []); E.push({ name: `${ds.id} ${ds.name}`, header: ds.header, columns: ds.columns, use: 'validation', provenance: ds.provenance, labId: ds.id }); store.touch({ type: 'experiments', id: 's19' }); toast('Dataset routed to Suite 19', 'ok'); }), btn('⇩ CSV', () => dl(datasetCSV(ds), `${ds.id}.csv`, 'text/csv')))));
  }
  if (session.analysisDs) go(session.analysisDs);
  return { dispose: () => C.dispose() };
}
const scaleTo = (y, ref) => { const a = Math.min(...y), b = Math.max(...y), c = Math.min(...ref), e = Math.max(...ref); return y.map(v => c + (v - a) / ((b - a) || 1) * (e - c)); };
