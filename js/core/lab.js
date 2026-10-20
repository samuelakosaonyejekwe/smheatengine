// THERMA-X100 laboratory core — experimental science & discovery laboratory (virtual, physical and hybrid experiments).
// Pure ES module (no DOM at import); browser-only features (Web Serial / WebUSB / Web Bluetooth) are feature-detected.
//
// API
//  Data model (stored in store.project.lab; every record has id, created, modified, version, status):
//   labOf(store) → lab object {hypotheses, protocols, specimens, instruments, runs, datasets, schedules, reports, events,
//     rigs, calibrated}; addRecord(store, coll, obj), getRecord, updateRecord (refuses released records), removeRecord,
//   releaseProtocol(store, id, by) (immutable + content hash), reviseProtocol(store, id, patch) (descendant, version+1),
//   lineage(store, id), logEvent(store, type, msg, data), stableHash(obj), datasetCSV(ds), runRecord({...}).
//  Hypothesis → protocol: METRICS, TEST_TYPES, sampleSize({cv, delta, alpha, power, design}), generateProtocol(hyp, design).
//  Instruments: INSTRUMENT_TYPES, newInstrument(type, over), calStatus(inst, atMs), instrumentU(inst, value).
//  Uncertainty: tCrit(dof), gum(f, x, u, {names, dof, corr, k}), monteCarlo(f, x, u, {n, seed, dists}),
//   loopWork(F, x), heatInput(t, mdot, cp, dT), cycleWorkUncertainty({F, x}, {uF, uFrel, ux, uxrel, n}),
//   heatInputUncertainty({...}), performanceUncertainty({W, uW, Q, uQ, f, uf, m, um, n}).
//  Time series: segmentCycles({t, F, x, T, q, phase}, opts), resample(t, y, tg), synchronise(channels, opts),
//   estimateLag(ta, ya, tb, yb, maxLag), seriesFromDataset(ds).
//  Filtering: kalman({F, H, Q, R, x0, P0}), ekf({f, h, Q, R, x0, P0}), smoothSeries(y, {q, r}), twinTracker(meas, model, {q, r}).
//  Active learning: expectedImprovement(mu, sd, best, xi, maximize), recommendNext(X, y, bounds, opts).
//  Design of experiments: fullFactorial(factors), fractionalFactorial(factors, p), lhsDesign(factors, n, seed),
//   dOptimal(factors, n, {model}).
//  Models: runVirtual(protocol, {design, mat, noise, seed, version}) → dataset (kind 'virtual', provenance 'hypothetical'),
//   addSensorNoise(ds, sd, seed), replayConstitutive(mat, {T, F}, opts), calibrateTwin(mat, data, opts),
//   hybridReplay(ds, mat, opts), synthAlloy(base, {Af, hyst, epsL, CA}), discoverMaterials(opts).
//  Hardware: hwSupport(), LineParser, connectSerial(opts), connectUSB(opts), connectBluetooth(opts), simulatedSource(opts).
//  Safety & execution: HARDWARE_INTERLOCK_STATEMENT, DEFAULT_LIMITS, limitsFromDesign(design, mat), validateLimits(L),
//   Safety ({limits, source, safeCommand, onTrip, onState}: arm/disarm/reset/check/watchdog/trip/estop/command),
//   Acquisition ({source, safety, maxPoints, watchdogMs}: start/stop/clear/toDataset), Sequencer ({steps, safety, acq, timeScale}: run/abort).
//  Scheduling & evidence: DEFAULT_RIGS, scheduleRuns(jobs, rigs, opts), LADDER, ladderStatus(lab), reportHTML(store, opts).
// Rules: model output and simulated-instrument data are always provenance 'hypothetical' (never 'measured'); only a stream
// from real connected hardware is recorded as 'measured'. Hardware commands require an armed Safety with limits and an
// operator acknowledgement that independent hardware interlocks are fitted.
import { mean, std, sum, clamp, interp1, linspace, range, rng, lhs, normInv, normCdf, levenbergMarquardt, metrics, det, invert, matmul, transpose, percentile, min, max } from './num.js';
import { gpFit } from './analysis.js';
import { SMA, cellTransient, quasiStaticCycle, tensileTest, dscSim, KELVIN } from './sma.js';
import { engineModel, designWith, DEFAULT_ENGINE } from './engine.js';
import { get as getMat } from './materials.js';

// ======================================================================================== data model
export const COLLECTIONS = ['hypotheses', 'protocols', 'specimens', 'instruments', 'runs', 'datasets', 'schedules', 'reports'];
const PFX = { hypotheses: 'HYP', protocols: 'PRT', specimens: 'SPC', instruments: 'INS', runs: 'RUN', datasets: 'DS', schedules: 'SCH', reports: 'RPT' };
export const DEFAULT_RIGS = [
  { id: 'RIG-A', name: 'Rig A — single-ribbon load frame', caps: ['cell-cycle', 'quasi-static', 'tensile'] },
  { id: 'RIG-B', name: 'Rig B — cartridge calorimetric loop', caps: ['cell-cycle', 'engine'] },
  { id: 'DSC-1', name: 'Differential scanning calorimeter', caps: ['dsc'] },
];
const iso = () => new Date().toISOString();
const clone = (o) => JSON.parse(JSON.stringify(o));
export const uid = (p = 'REC') => `${p}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
export function labOf(store) {
  const L = (store.project.lab ||= {});
  for (const c of COLLECTIONS) L[c] ||= [];
  L.events ||= []; L.rigs ||= clone(DEFAULT_RIGS); L.calibrated ||= {}; L.schema = 1;
  return L;
}
export function logEvent(store, type, msg, data) { const L = labOf(store); L.events.push({ t: iso(), type, msg, ...(data ? { data } : {}) }); if (L.events.length > 2000) L.events.splice(0, L.events.length - 2000); }
export function addRecord(store, coll, obj) {
  const L = labOf(store), t = iso();
  const r = { created: t, modified: t, version: 1, status: 'draft', ...obj, id: obj.id || uid(PFX[coll]) };
  L[coll].push(r); logEvent(store, 'create', `${coll}: ${r.id}${r.name ? ' — ' + r.name : ''}`); store.touch({ type: 'lab', coll }); return r;
}
export const getRecord = (store, coll, id) => labOf(store)[coll].find(r => r.id === id) || null;
export function updateRecord(store, coll, id, patch) {
  const r = getRecord(store, coll, id); if (!r) throw new Error(`No ${coll} record ${id}`);
  if (r.status === 'released') throw new Error(`${r.id} is released and immutable — create a revision instead.`);
  Object.assign(r, patch, { modified: iso() }); store.touch({ type: 'lab', coll }); return r;
}
export function removeRecord(store, coll, id) {
  const L = labOf(store), i = L[coll].findIndex(r => r.id === id); if (i < 0) return false;
  const r = L[coll][i]; if (coll === 'protocols' && r.status === 'released') throw new Error('Released protocols are permanent records; supersede them with a revision.');
  L[coll].splice(i, 1); logEvent(store, 'delete', `${coll}: ${id}${r.provenance === 'measured' ? ' (measured dataset removed by operator)' : ''}`); store.touch({ type: 'lab', coll }); return true;
}
const contentOf = (r) => { const c = { ...r }; for (const k of ['id', 'created', 'modified', 'status', 'released', 'releasedBy', 'hash']) delete c[k]; return c; };
export function releaseProtocol(store, id, by = '') {
  const r = getRecord(store, 'protocols', id); if (!r) throw new Error(`No protocol ${id}`); if (r.status === 'released') return r;
  if (!r.acceptance?.length) throw new Error('Acceptance criteria must be defined before release (they are fixed before testing).');
  r.status = 'released'; r.released = iso(); r.releasedBy = by; r.hash = stableHash(contentOf(r)); r.modified = r.released;
  logEvent(store, 'release', `protocol ${r.id} v${r.version} released (hash ${r.hash})`); store.touch({ type: 'lab', coll: 'protocols' }); return r;
}
export function reviseProtocol(store, id, patch = {}) {
  const r = getRecord(store, 'protocols', id); if (!r) throw new Error(`No protocol ${id}`);
  const base = contentOf(clone(r));
  return addRecord(store, 'protocols', { ...base, ...patch, parent: r.id, root: r.root || r.id, version: (r.version || 1) + 1, status: 'draft' });
}
export function lineage(store, id) { const out = []; let r = getRecord(store, 'protocols', id); while (r) { out.push(r); r = r.parent ? getRecord(store, 'protocols', r.parent) : null; } return out; }
// canonical JSON (sorted keys at every level) + two FNV-1a passes → 16 hex digits
export function stableHash(o) {
  const canon = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v ?? null) : Array.isArray(v) || ArrayBuffer.isView(v) ? '[' + Array.from(v, canon).join(',') + ']' : '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  const s = canon(o); let a = 2166136261, b = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 2246822519) ^ (b >>> 13); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
export function datasetCSV(ds) {
  const q = (s) => /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? '');
  const head = [`# THERMA-X100 dataset ${ds.id} — ${ds.name}`, `# kind: ${ds.kind}; provenance: ${ds.provenance}${ds.label ? '; ' + ds.label : ''}`, `# created: ${ds.created}; test: ${ds.test || ''}; hash: ${ds.meta?.dataHash || ''}`];
  if (!ds.columns) return `# THERMA-X100 dataset ${ds.id} — columns not stored on this device`;
  const n = ds.nRows ?? (ds.columns[ds.header[0]] || []).length;
  return [...head, ds.header.map(c => q(ds.units?.[c] ? `${c} [${ds.units[c]}]` : c)).join(','), ...range(n).map(i => ds.header.map(c => q(ds.columns[c][i])).join(','))].join('\n');
}
export function runRecord({ protocol, dataset, specimen, instruments = [], version = '', operator = '', notes = '' }) {
  return {
    software: { name: 'THERMA-X100', version }, operator, notes, t: iso(),
    protocolId: protocol?.id || null, protocolVersion: protocol?.version || null, protocolHash: protocol?.hash || (protocol ? stableHash(contentOf(protocol)) : null),
    specimenId: specimen?.id || null, instrumentIds: instruments.map(i => i.id), instrumentCal: instruments.map(i => ({ id: i.id, cert: i.cert || '', status: calStatus(i).status })),
    datasetId: dataset?.id || null, kind: dataset?.kind || null, provenance: dataset?.provenance || null,
    inputsHash: stableHash({ protocol: protocol ? contentOf(protocol) : null, specimen: specimen || null, inputs: dataset?.meta?.inputs || null }), dataHash: dataset ? stableHash(dataset.columns) : null,
  };
}

// ======================================================================================== hypothesis → protocol
export const METRICS = {
  netWork: { label: 'Net closed-cycle work per cycle', unit: 'J', key: 'Wnet', larger: true },
  specificPower: { label: 'Net specific power (active SMA mass)', unit: 'W/kg', key: 'pActive', larger: true },
  efficiency: { label: 'Thermal efficiency (net work / heat input)', unit: '%', key: 'eta', larger: true },
  stroke: { label: 'Recoverable stroke', unit: 'mm', key: 'stroke', larger: true },
  hysteresis: { label: 'Thermal hysteresis (DSC peak separation)', unit: 'K', key: 'hysteresis', larger: false },
  resetWork: { label: 'Reset work per cycle', unit: 'J', key: 'Wres', larger: false },
};
export const TEST_TYPES = {
  'cell-cycle': { label: 'Instrumented thermal cycle (force–displacement–temperature)', model: 'cellTransient', gate: 'V1', instruments: ['loadcell', 'lvdt', 'thermocouple', 'rtd', 'flowmeter', 'daq'] },
  'quasi-static': { label: 'Quasi-static isobaric work loop (two-stress cycle)', model: 'quasiStaticCycle', gate: 'V0', instruments: ['loadcell', 'lvdt', 'thermocouple', 'daq'] },
  tensile: { label: 'Isothermal tensile loading/unloading', model: 'tensileTest', gate: 'V0', instruments: ['loadcell', 'lvdt', 'thermocouple'] },
  dsc: { label: 'Differential scanning calorimetry', model: 'dscSim', gate: 'V0', instruments: ['dsc'] },
  engine: { label: 'Multicell engine / cartridge calorimetry', model: 'engineModel', gate: 'V2', instruments: ['loadcell', 'lvdt', 'rtd', 'flowmeter', 'pressure', 'torque', 'encoder', 'powermeter', 'daq'] },
};
// n per group for a two-sample (or one-sample vs. a threshold) comparison with relative effect δ and run-to-run CV
export function sampleSize({ cv = 0.08, delta = 0.1, alpha = 0.05, power = 0.8, design = 'two-sample' } = {}) {
  const za = normInv(1 - alpha / 2), zb = normInv(power), k = design === 'two-sample' ? 2 : 1;
  const n0 = k * ((za + zb) * cv / Math.max(1e-9, Math.abs(delta))) ** 2; // + Guenther small-sample (t) correction
  return { n: Math.max(3, Math.ceil(n0 + za * za / (design === 'two-sample' ? 4 : 2))), nNormal: n0, za, zb, design };
}
export function generateProtocol(hyp, design = DEFAULT_ENGINE) {
  const d = designWith(design, { Th: hyp.Th, Tc: hyp.Tc }), test = hyp.test || 'cell-cycle', met = METRICS[hyp.metric] || METRICS.netWork;
  const ss = sampleSize({ cv: hyp.cv ?? 0.08, delta: hyp.delta ?? 0.1, alpha: hyp.alpha ?? 0.05, power: hyp.power ?? 0.8, design: hyp.reference ? 'two-sample' : 'one-sample' });
  const cand = hyp.candidate || d.alloy, ref = hyp.reference || '', cyc = hyp.cycles ?? 20;
  const steps = [
    { op: 'mark', label: 'Pre-test checks: specimen ID, lot and heat-treatment record verified; instrument certificates in date; hardware interlocks function-tested' },
    { op: 'set', channel: 'Tc', value: d.Tc, label: `Condition cold bath to ${d.Tc} °C and verify stability (±0.2 K for 5 min)` },
    { op: 'set', channel: 'Th', value: d.Th, label: `Condition hot bath to ${d.Th} °C and verify stability (±0.2 K for 5 min)` },
    { op: 'set', channel: 'preload', value: d.sigmaL, label: `Apply reset (bias) stress ${d.sigmaL} MPa; record zero displacement` },
    { op: 'hold', duration_s: 60, label: 'Thermal soak at cold condition; tare force and displacement' },
    { op: 'record', duration_s: Math.round(cyc / d.freq), label: `Record ${cyc} complete cycles at ${d.freq} Hz (hot fraction ${d.dutyHot}) under load σH = ${d.sigmaH} MPa` },
    { op: 'set', channel: 'Th', value: d.Tc, label: 'Return hot loop to cold condition (safe state)' },
    { op: 'mark', label: 'Post-test: inspect specimen, record residual strain and any slip at the grips' },
  ];
  if (test === 'dsc') steps.splice(1, 5, { op: 'record', duration_s: 1200, label: `DSC heat–cool at 10 K/min between ${(getMat(cand)?.Mf ?? 20) - 30} and ${(getMat(cand)?.Af ?? 60) + 30} °C, three thermal cycles, report the third` });
  if (test === 'tensile') steps.splice(4, 2, { op: 'record', duration_s: 300, label: `Isothermal load–unload to ${Math.round(d.sigmaH * 2)} MPa at ${d.Tc} °C and ${d.Th} °C (quasi-static strain rate ≤ 1e-4 /s)` });
  const controls = [
    ref ? `Reference specimen (${ref}) tested on the same rig, same day, same reservoirs and loads, in randomised order with the candidate (${cand})` : `Persistent control: a reference ribbon of the baseline alloy tested at the start and end of each session to expose drift`,
    'Zero-heat control: identical cycle with both loops at the cold temperature — any apparent net work is an instrument or fixture artefact',
    'No-load control: cycle with the output load disengaged to separate bias-spring work from transmitted work',
  ];
  const better = met.larger ? 'higher' : 'lower', lim = (hyp.delta ?? 0.1) * 100;
  const acceptance = [
    { id: 'A1', text: `Primary: ${met.label} of the candidate is ${better} than ${ref ? 'the reference' : 'the declared threshold'} by at least ${lim.toFixed(0)} %, with the 95 % confidence interval of the difference excluding zero`, metric: met.key, delta: hyp.delta ?? 0.1 },
    { id: 'A2', text: 'Net work counted after reset work and parasitics (never gross contraction work alone); the lower 95 % bound of net work per cycle is strictly positive', metric: 'Wnet', min: 0 },
    { id: 'A3', text: 'Repeatability: coefficient of variation of the per-cycle metric ≤ 10 % over the recorded cycles; work drift per cycle ≤ 0.5 % of the mean', metric: 'cv', max: 0.1 },
    { id: 'A4', text: 'Energy closure: |Q_in − Q_out − W_net| ≤ 5 % of Q_in where calorimetry is available', metric: 'closure', max: 0.05 },
    { id: 'A5', text: 'Measured efficiency never exceeds the Carnot limit for the recorded reservoir temperatures (otherwise the instrumentation is suspect)', metric: 'eta', max: 1 - (d.Tc + KELVIN) / (d.Th + KELVIN) },
  ];
  const safety = [
    `Hot loop ≤ ${Math.max(d.Th + 10, 40)} °C; pressure relief fitted; scald guarding on hot-water lines`,
    `Force limit ${(d.sigmaH * 1.6).toFixed(0)} MPa equivalent (≤ 40 % of UTS) with hardware load-limit switch; guarded specimen zone (ribbon fracture releases stored elastic energy)`,
    'Independent over-temperature cut-out and emergency-stop circuit that removes heater and actuator power without software',
    'Leak detection and drip tray under the flow loop; electrical equipment above the waterline',
  ];
  const suites = [['s03', 'alloy card & uncertainty'], ['s04', 'transformation path'], ['s05', 'cartridge cycle prediction'], ['s08', 'heat-transfer coefficients'], ['s18', 'energy accounting'], ['s19', 'calibration & twin'], ['s21', 'operating envelope & trips']];
  return {
    name: `${TEST_TYPES[test]?.label || test}: ${cand}${ref ? ' vs ' + ref : ''} at ${d.Th}/${d.Tc} °C`, hypothesis: hyp.statement || '', hypothesisId: hyp.id || null, test, candidate: cand, reference: ref, metric: hyp.metric || 'netWork',
    conditions: { Th: d.Th, Tc: d.Tc, sigmaL: d.sigmaL, sigmaH: d.sigmaH, freq: d.freq, dutyHot: d.dutyHot, cycles: cyc, alloy: cand },
    steps, controls, acceptance, instruments: TEST_TYPES[test]?.instruments || [], sampleSize: ss, safety, suites, randomise: true, blind: !!ref,
  };
}

// ======================================================================================== instruments
export const INSTRUMENT_TYPES = {
  dsc: { label: 'Differential scanning calorimeter', supplies: 'transformation heat flow and transition temperatures', channel: 'q_dsc', unit: 'mW', u: 0.3, uRel: 0.02 },
  loadcell: { label: 'Load cell', supplies: 'actuator pulling force', channel: 'F', unit: 'N', u: 0.05, uRel: 0.0025 },
  lvdt: { label: 'Extensometer / LVDT displacement transducer', supplies: 'contraction and reset displacement', channel: 'x', unit: 'mm', u: 0.002, uRel: 0.002 },
  thermocouple: { label: 'Thermocouple (type T/K, class 1)', supplies: 'specimen and fluid temperatures', channel: 'T', unit: '°C', u: 0.3, uRel: 0 },
  rtd: { label: 'Platinum RTD (Pt100, class A)', supplies: 'hot/cold fluid inlet–outlet temperatures', channel: 'T_fluid', unit: '°C', u: 0.1, uRel: 0.001 },
  flowmeter: { label: 'Mass-flow meter', supplies: 'heating and cooling mass flow rates', channel: 'mdot', unit: 'kg/s', u: 1e-5, uRel: 0.005 },
  pressure: { label: 'Differential pressure transducer', supplies: 'fluid pressure drop', channel: 'dp', unit: 'Pa', u: 5, uRel: 0.0025 },
  torque: { label: 'Shaft torque transducer', supplies: 'mechanical shaft torque', channel: 'torque', unit: 'N·m', u: 0.001, uRel: 0.002 },
  encoder: { label: 'Rotary encoder', supplies: 'shaft angle and speed', channel: 'speed', unit: 'rpm', u: 0.05, uRel: 0.0005 },
  powermeter: { label: 'Power meter', supplies: 'electrical consumption of auxiliaries', channel: 'P_aux', unit: 'W', u: 0.05, uRel: 0.005 },
  camera: { label: 'High-speed camera / image correlation', supplies: 'deformation, strain localisation, motion tracking', channel: 'strain_dic', unit: '-', u: 1e-4, uRel: 0.01 },
  daq: { label: 'Data-acquisition unit (common timestamp)', supplies: 'synchronised sampling of all channels', channel: 'V', unit: 'V', u: 1e-4, uRel: 0.0005 },
};
export function newInstrument(type, over = {}) {
  const T = INSTRUMENT_TYPES[type] || INSTRUMENT_TYPES.daq;
  return { type, name: T.label, channel: T.channel, unit: T.unit, u: T.u, uRel: T.uRel, uBasis: 'type-class estimate (replace with certificate value)', range: '', serial: '', cert: '', calDate: '', calDue: '', calLab: '', ...over };
}
export function calStatus(inst, at = Date.now()) {
  if (!inst?.cert || !inst.calDue) return { status: 'none', label: 'No calibration certificate', days: null };
  const days = Math.floor((Date.parse(inst.calDue) - at) / 864e5);
  if (!Number.isFinite(days)) return { status: 'none', label: 'Invalid due date', days: null };
  return days < 0 ? { status: 'expired', label: `Expired ${-days} d ago`, days } : days < 30 ? { status: 'due', label: `Due in ${days} d`, days } : { status: 'valid', label: `Valid (${days} d left)`, days };
}
export const instrumentU = (inst, v) => Math.hypot(inst?.u || 0, (inst?.uRel || 0) * Math.abs(v || 0));

// ======================================================================================== uncertainty (GUM & Monte Carlo)
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086];
export const tCrit = (dof) => !Number.isFinite(dof) || dof > 200 ? 1.96 : dof >= 1 ? (T95[Math.round(dof) - 1] ?? 1.96 + 2.4 / dof) : 12.706;
// first-order propagation (GUM): uc² = Σ(cᵢuᵢ)² + 2ΣΣ cᵢcⱼuᵢuⱼrᵢⱼ ; Welch–Satterthwaite effective degrees of freedom
export function gum(f, x, u, { names = [], dof = [], corr = null, k = null } = {}) {
  const y = f(x), n = x.length;
  const c = x.map((xi, i) => { const h = 1e-6 * (Math.abs(xi) || 1), a = x.slice(), b = x.slice(); a[i] += h; b[i] -= h; return (f(a) - f(b)) / (2 * h); });
  let v = 0; const parts = c.map((ci, i) => ci * u[i]);
  for (let i = 0; i < n; i++) v += parts[i] ** 2;
  if (corr) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) v += 2 * parts[i] * parts[j] * (corr[i]?.[j] || 0);
  const uc = Math.sqrt(Math.max(0, v)), den = sum(parts.map((p, i) => Number.isFinite(dof[i]) && dof[i] > 0 ? p ** 4 / dof[i] : 0));
  const veff = den > 0 ? uc ** 4 / den : Infinity, kk = k ?? tCrit(veff);
  return { y, uc, U: kk * uc, k: kk, veff, rel: y ? uc / Math.abs(y) : NaN, budget: x.map((xi, i) => ({ name: names[i] || `x${i + 1}`, x: xi, u: u[i], c: c[i], contrib: Math.abs(parts[i]), share: v > 0 ? parts[i] ** 2 / v : 0 })).sort((a, b) => b.contrib - a.contrib) };
}
// Monte Carlo propagation (GUM Supplement 1): independent inputs, normal (default) or uniform (u = half-width/√3)
export function monteCarlo(f, x, u, { n = 5000, seed = 17, dists = [] } = {}) {
  const R = rng(seed), Y = new Array(n);
  for (let s = 0; s < n; s++) Y[s] = f(x.map((xi, i) => dists[i] === 'uniform' ? xi + u[i] * Math.sqrt(3) * (2 * R() - 1) : R.normal(xi, u[i])));
  const ok = Y.filter(Number.isFinite), srt = ok.slice().sort((a, b) => a - b), q = (p) => srt[Math.min(srt.length - 1, Math.max(0, Math.round(p * (srt.length - 1))))];
  return { mean: mean(ok), std: std(ok), lo: q(0.025), hi: q(0.975), median: q(0.5), n: ok.length, samples: ok };
}
// ∮F dx with x positive in the contraction direction: contraction work (F·dx > 0), reset work (done on the specimen)
export function loopWork(F, x, i0 = 0, i1 = F.length - 1) {
  let Wc = 0, Wr = 0;
  for (let i = i0 + 1; i <= i1; i++) { const dW = 0.5 * (F[i] + F[i - 1]) * (x[i] - x[i - 1]); if (dW > 0) Wc += dW; else Wr -= dW; }
  return { Wnet: Wc - Wr, Wcon: Wc, Wres: Wr };
}
// Q = ∫ ṁ cp ΔT dt (arrays or scalars)
export function heatInput(t, mdot, cp, dT) { const at = (v, i) => Array.isArray(v) ? v[i] : v; let Q = 0; for (let i = 1; i < t.length; i++) Q += 0.5 * (at(mdot, i) * at(cp, i) * at(dT, i) + at(mdot, i - 1) * at(cp, i - 1) * at(dT, i - 1)) * (t[i] - t[i - 1]); return Q; }
// Analytic GUM budget for a sampled closed-cycle work integral, cross-checked by Monte Carlo on the raw samples.
// Force/displacement scale errors scale W; a force offset contributes b·(x_end − x_start) (vanishes for a closed loop);
// a displacement offset does not contribute; independent per-sample noise adds Σcᵢ²σ².
export function cycleWorkUncertainty({ F, x }, { uF = 0, uFrel = 0, ux = 0, uxrel = 0, uFoff = 0, n = 800, seed = 23 } = {}) {
  const N = F.length, W = loopWork(F, x).Wnet;
  let sF = 0, sX = 0;
  for (let i = 0; i < N; i++) { const cF = 0.5 * ((i > 0 ? x[i] - x[i - 1] : 0) + (i < N - 1 ? x[i + 1] - x[i] : 0)), cX = 0.5 * ((i > 0 ? F[i - 1] + F[i] : 0) - (i < N - 1 ? F[i] + F[i + 1] : 0)); sF += cF * cF; sX += cX * cX; }
  const closure = x[N - 1] - x[0];
  const budget = [
    { name: 'Force scale (calibration)', contrib: Math.abs(W) * uFrel }, { name: 'Displacement scale (calibration)', contrib: Math.abs(W) * uxrel },
    { name: 'Force offset × loop closure', contrib: Math.abs(closure) * uFoff }, { name: 'Force noise (per sample)', contrib: Math.sqrt(sF) * uF }, { name: 'Displacement noise (per sample)', contrib: Math.sqrt(sX) * ux },
  ];
  const uc = Math.hypot(...budget.map(b => b.contrib)); budget.forEach(b => b.share = uc > 0 ? (b.contrib / uc) ** 2 : 0);
  const R = rng(seed), Ws = [];
  for (let s = 0; s < n; s++) {
    const kF = 1 + R.normal(0, uFrel), kX = 1 + R.normal(0, uxrel), bF = R.normal(0, uFoff);
    const Fp = F.map(v => v * kF + bF + R.normal(0, uF)), xp = x.map(v => v * kX + R.normal(0, ux)); Ws.push(loopWork(Fp, xp).Wnet);
  }
  const s = Ws.slice().sort((a, b) => a - b);
  return { W, uc, U: 2 * uc, rel: W ? uc / Math.abs(W) : NaN, budget, mc: { mean: mean(Ws), std: std(Ws), lo: s[Math.floor(0.025 * (n - 1))], hi: s[Math.ceil(0.975 * (n - 1))], n } };
}
// Q = ṁ·cp·ΔT·Δt with ΔT from two thermometers (correlation r between their errors cancels common-mode bias)
export function heatInputUncertainty({ mdot, umdot, cp, ucp, Tin, Tout, uT, rTT = 0, dt, udt = 0 }) {
  const uDT = Math.sqrt(Math.max(0, 2 * uT * uT * (1 - rTT)));
  return gum(([m, c, d, t]) => m * c * d * t, [mdot, cp, Tin - Tout, dt], [umdot, ucp, uDT, udt], { names: ['mass flow ṁ', 'specific heat cp', 'temperature drop ΔT', 'integration time Δt'] });
}
export function performanceUncertainty({ W, uW, Q, uQ, f = 1, uf = 0, m = 1, um = 0, Th, Tc, n = 5000 }) {
  const eta = gum(([w, q]) => w / q, [W, Q], [uW, uQ], { names: ['net work W', 'heat input Q'] });
  const psp = gum(([w, ff, mm]) => w * ff / mm, [W, f, m], [uW, uf, um], { names: ['net work W', 'cycle frequency f', 'active mass m'] });
  const etaMC = monteCarlo(([w, q]) => w / q, [W, Q], [uW, uQ], { n }), pspMC = monteCarlo(([w, ff, mm]) => w * ff / mm, [W, f, m], [uW, uf, um], { n });
  const etaC = Th > Tc ? 1 - (Tc + KELVIN) / (Th + KELVIN) : NaN;
  return { eta, psp, etaMC, pspMC, etaC, carnotOK: !(etaMC.lo > etaC), pNetPositive: monteCarlo(([w]) => w > 0 ? 1 : 0, [W], [uW], { n }).mean };
}

// ======================================================================================== time series
export function seriesFromDataset(ds) {
  if (ds && !ds.columns) throw new Error(`Dataset ${ds.id} has no stored columns (dropped by device storage limits?) — re-import it from the evidence ZIP or original file.`);
  const H = ds?.header || [], pick = (...res) => { for (const re of res) { const c = H.find(x => re.test(x)); if (c) return c; } return null; };
  const map = { t: pick(/^t(_s)?$/, /^time/i), F: pick(/^F(_N)?$/i, /force|load/i), x: pick(/^x(_mm)?$/i, /disp|stroke|ext/i), T: pick(/^T_?(spec|specimen|ribbon|s)(_|$)/, /^T_?spec/, /^T_?mean/, /^T(_C)?$/, /temp/i, /^T(?!orque)/), Tf: pick(/^T_?fluid/i, /^T_?f\b/i), q: pick(/^q_?in/i, /heat/i), phase: pick(/^phase$/i, /valve/i) };
  const col = (k) => map[k] ? Array.from(ds.columns[map[k]] || [], Number) : null;
  const t = col('t') || range((ds.columns[H[0]] || []).length), xs = map.x && (/mm/.test(map.x) || /^mm$/.test(ds.units?.[map.x] || '')) ? 1e-3 : 1, x = col('x');
  return { map, t, F: col('F'), x: x ? x.map(v => v * xs) : null, xScale: xs, T: col('T'), Tf: col('Tf'), q: col('q'), phase: col('phase') }; // x returned in metres
}
export const resample = (t, y, tg) => tg.map(v => interp1(t, y, v));
export function synchronise(channels, { dt, t0, t1, lags = {} } = {}) {
  const names = Object.keys(channels); if (!names.length) return { t: [], columns: {} };
  const sh = (n) => channels[n].t.map(v => v - (lags[n] || 0));
  const lo = t0 ?? Math.max(...names.map(n => sh(n)[0])), hi = t1 ?? Math.min(...names.map(n => { const a = sh(n); return a[a.length - 1]; }));
  const step = dt ?? Math.max(...names.map(n => { const a = channels[n].t; return (a[a.length - 1] - a[0]) / Math.max(1, a.length - 1); }));
  const t = hi > lo ? range(Math.floor((hi - lo) / step) + 1).map(i => lo + i * step) : [];
  const columns = {}; for (const n of names) columns[n] = resample(sh(n), channels[n].y, t);
  return { t, columns, dt: step, window: [lo, hi] };
}
// time lag of b relative to a by cross-correlation of first differences on a common grid
export function estimateLag(ta, ya, tb, yb, maxLag = 1) {
  const s = synchronise({ a: { t: ta, y: ya }, b: { t: tb, y: yb } }), dt = s.dt; if (s.t.length < 8) return { lag: 0, r: 0 };
  const da = s.columns.a.slice(1).map((v, i) => v - s.columns.a[i]), db = s.columns.b.slice(1).map((v, i) => v - s.columns.b[i]);
  const K = Math.min(Math.round(maxLag / dt), da.length - 4); let best = { lag: 0, r: -Infinity };
  for (let k = -K; k <= K; k++) { let sab = 0, saa = 0, sbb = 0; for (let i = Math.max(0, -k); i < Math.min(da.length, db.length - k); i++) { sab += da[i] * db[i + k]; saa += da[i] ** 2; sbb += db[i + k] ** 2; } const r = sab / Math.sqrt(saa * sbb || 1); if (r > best.r) best = { lag: k * dt, r }; }
  return best;
}
// Cycle segmentation: heating/cooling segments from a phase channel or a Schmitt trigger on temperature, cycles from one
// heating onset to the next; per-cycle loop work, stroke, closure, heat; repeatability and drift statistics.
export function segmentCycles(d, { threshold, band = 0.15, minSamples = 3 } = {}) {
  const { t, F, x } = d, T = d.T || d.Tf, N = t.length;
  if (!F || !x || (!T && !d.phase)) throw new Error('Cycle segmentation needs force, displacement and a temperature (or phase) channel.');
  let hot, thr = NaN;
  if (d.phase) hot = d.phase.map(v => v > 0.5);
  else {
    const lo = percentile(T, 0.05), hi = percentile(T, 0.95), h = band * (hi - lo); thr = threshold ?? 0.5 * (lo + hi);
    let s = T[0] > thr; hot = T.map(v => { if (v > thr + h / 2) s = true; else if (v < thr - h / 2) s = false; return s; });
  }
  const segments = []; let i0 = 0;
  for (let i = 1; i <= N; i++) if (i === N || hot[i] !== hot[i0]) { if (i - i0 >= minSamples || !segments.length) segments.push({ phase: hot[i0] ? 'heating' : 'cooling', i0, i1: i - 1, t0: t[i0], t1: t[i - 1] }); else { segments[segments.length - 1].i1 = i - 1; segments[segments.length - 1].t1 = t[i - 1]; } i0 = i; }
  const merged = []; for (const s of segments) { const p = merged[merged.length - 1]; if (p && p.phase === s.phase) { p.i1 = s.i1; p.t1 = s.t1; } else merged.push({ ...s }); }
  const starts = merged.filter(s => s.phase === 'heating').map(s => s.i0), cycles = [];
  for (let k = 0; k + 1 < starts.length; k++) {
    const a = starts[k], b = starts[k + 1], lw = loopWork(F, x, a, b), xs = x.slice(a, b + 1), Fs = F.slice(a, b + 1), Ts = T ? T.slice(a, b + 1) : [];
    const hs = merged.find(s => s.i0 === a), heatDur = hs ? t[Math.min(hs.i1 + 1, b)] - t[a] : NaN;
    let Qin = NaN; if (d.q) { Qin = 0; for (let i = a + 1; i <= b; i++) { const qq = 0.5 * (d.q[i] + d.q[i - 1]); if (qq > 0) Qin += qq * (t[i] - t[i - 1]); } }
    cycles.push({ k: k + 1, i0: a, i1: b, t0: t[a], t1: t[b], period: t[b] - t[a], heatDur, coolDur: t[b] - t[a] - heatDur, ...lw, stroke: max(xs) - min(xs), Fmax: max(Fs), Fmin: min(Fs), Tmax: Ts.length ? max(Ts) : NaN, Tmin: Ts.length ? min(Ts) : NaN, closure: x[b] - x[a], xStart: x[a], Qin, eta: Qin > 0 ? lw.Wnet / Qin : NaN });
  }
  const W = cycles.map(c => c.Wnet), n = W.length, m = mean(W), sd = n > 1 ? std(W) : NaN, half = n > 1 ? tCrit(n - 1) * sd / Math.sqrt(n) : NaN;
  const slope = (ys) => { if (ys.length < 3) return NaN; const xs = range(ys.length), mx = mean(xs), my = mean(ys); return sum(xs.map((v, i) => (v - mx) * (ys[i] - my))) / sum(xs.map(v => (v - mx) ** 2)); };
  const summary = { n, Wnet: m, sd, ci95: [m - half, m + half], half, cv: m ? sd / Math.abs(m) : NaN, Wcon: mean(cycles.map(c => c.Wcon)), Wres: mean(cycles.map(c => c.Wres)), stroke: mean(cycles.map(c => c.stroke)), period: mean(cycles.map(c => c.period)), drift: slope(W), driftRel: m ? slope(W) / Math.abs(m) : NaN, xDrift: slope(cycles.map(c => c.xStart)), repeatable: n >= 3 && sd / Math.abs(m) <= 0.1, positive: n > 1 && m - half > 0, Qin: mean(cycles.map(c => c.Qin)), eta: mean(cycles.map(c => c.eta)) };
  return { threshold: thr, segments: merged, cycles, summary };
}

// ======================================================================================== filtering
const mT = (A) => transpose(A.map(r => Float64Array.from(r))), mm = (A, B) => matmul(A.map(r => Float64Array.from(r)), B.map(r => Float64Array.from(r)));
const madd = (A, B, s = 1) => A.map((r, i) => Array.from(r, (v, j) => v + s * B[i][j]));
const toM = (v) => Array.isArray(v[0]) || ArrayBuffer.isView(v[0]) ? v.map(r => Array.from(r)) : v.map(x => [x]);
// linear Kalman filter x' = F x (+B u) + w, z = H x + v
export function kalman({ F, H, Q, R, x0, P0, B = null }) {
  let x = toM(x0), P = P0.map(r => r.slice());
  const predict = (u) => { x = mm(F, x).map(r => Array.from(r)); if (B && u) x = madd(x, mm(B, toM(u))); P = madd(mm(mm(F, P), mT(F)), Q); };
  const update = (z) => {
    const zz = toM(z), y = madd(zz, mm(H, x), -1), S = madd(mm(mm(H, P), mT(H)), R), K = mm(mm(P, mT(H)), invert(S.map(r => Float64Array.from(r))));
    x = madd(x, mm(K, y)); const I = P.map((r, i) => r.map((_, j) => i === j ? 1 : 0)); P = mm(madd(I, mm(K, H), -1), P).map(r => Array.from(r));
    return { innovation: y.map(r => r[0]), S: S.map(r => Array.from(r)) };
  };
  return { predict, update, step(z, u) { predict(u); return update(z); }, get x() { return x.map(r => r[0]); }, get P() { return P.map(r => Array.from(r)); } };
}
// extended Kalman filter with numerical Jacobians: x' = f(x,u), z = h(x)
export function ekf({ f, h, Q, R, x0, P0 }) {
  let x = x0.slice(), P = P0.map(r => r.slice());
  const jac = (g, at) => { const g0 = g(at), J = g0.map(() => new Array(at.length).fill(0)); for (let k = 0; k < at.length; k++) { const e = 1e-6 * (Math.abs(at[k]) + 1e-3), a = at.slice(); a[k] += e; const g1 = g(a); for (let i = 0; i < g0.length; i++) J[i][k] = (g1[i] - g0[i]) / e; } return J; };
  return {
    step(z, u) {
      const Fj = jac(xx => f(xx, u), x); x = f(x, u); P = madd(mm(mm(Fj, P), mT(Fj)), Q);
      const Hj = jac(h, x), y = z.map((zi, i) => zi - h(x)[i]), S = madd(mm(mm(Hj, P), mT(Hj)), R), K = mm(mm(P, mT(Hj)), invert(S.map(r => Float64Array.from(r))));
      x = x.map((v, i) => v + K[i].reduce((s, kij, j) => s + kij * y[j], 0)); const I = P.map((r, i) => r.map((_, j) => i === j ? 1 : 0)); P = mm(madd(I, mm(K, Hj), -1), P).map(r => Array.from(r));
      return { x: x.slice(), P: P.map(r => r.slice()), innovation: y };
    }, get x() { return x.slice(); }, get P() { return P.map(r => r.slice()); },
  };
}
// scalar random-walk Kalman smoother (forward filter + RTS backward pass)
export function smoothSeries(y, { q = 1e-3, r = 1e-2 } = {}) {
  const n = y.length, xf = new Array(n), pf = new Array(n); let x = y[0], p = r;
  for (let i = 0; i < n; i++) { const pp = p + q, k = pp / (pp + r); x = x + k * (y[i] - x); p = (1 - k) * pp; xf[i] = x; pf[i] = p; }
  const xs = xf.slice(), ps = pf.slice(); for (let i = n - 2; i >= 0; i--) { const c = pf[i] / (pf[i] + q); xs[i] = xf[i] + c * (xs[i + 1] - xf[i]); ps[i] = pf[i] + c * c * (ps[i + 1] - pf[i] - q); }
  return { x: xs, sd: ps.map(v => Math.sqrt(Math.max(0, v))) };
}
// digital-twin discrepancy tracker: δ_k = measured − model, random walk; twin prediction = model + δ̂
export function twinTracker(meas, model, { q, r } = {}) {
  const e = meas.map((v, i) => v - model[i]), s = std(e) || Math.abs(mean(e)) || 1;
  const K = kalman({ F: [[1]], H: [[1]], Q: [[q ?? (0.05 * s) ** 2]], R: [[r ?? s * s]], x0: [0], P0: [[(10 * s) ** 2]] });
  const est = [], sd = [];
  for (const v of e) { K.step([v]); est.push(K.x[0]); sd.push(Math.sqrt(K.P[0][0])); }
  return { discrepancy: e, delta: est, sd, twin: model.map((v, i) => v + est[i]), finalDelta: est[est.length - 1], finalSd: sd[sd.length - 1] };
}

// ======================================================================================== active learning
const phi = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
export function expectedImprovement(mu, sd, best, xi = 0.01, maximize = true) { if (!(sd > 1e-12)) return 0; const imp = (maximize ? mu - best : best - mu) - xi; const z = imp / sd; return imp * normCdf(z) + sd * phi(z); }
// recommend the next most informative experiment over bounded design variables (GP surrogate on the unit cube)
export function recommendNext(X, y, bounds, { acquisition = 'ei', maximize = true, nCand = 400, seed = 3, names = [], xi = 0.01, minDist = 0.03 } = {}) {
  const d = bounds.length, toU = (x) => x.map((v, j) => (v - bounds[j][0]) / ((bounds[j][1] - bounds[j][0]) || 1)), toX = (u) => u.map((v, j) => bounds[j][0] + v * (bounds[j][1] - bounds[j][0]));
  const C = lhs(nCand, d, rng(seed));
  if (X.length < Math.max(3, d + 1)) {
    const U = X.map(toU), far = C.map(c => ({ c, dmin: U.length ? Math.min(...U.map(u => Math.hypot(...u.map((v, j) => v - c[j])))) : 1 })).sort((a, b) => b.dmin - a.dmin)[0];
    return { x: toX(far.c), mean: NaN, std: NaN, score: far.dmin, acquisition: 'space-filling', gp: null, top: [], rationale: `Only ${X.length} observation(s): at least ${Math.max(3, d + 1)} are needed before a surrogate is trustworthy. The recommendation is the space-filling point farthest from all existing tests.` };
  }
  const yb = maximize ? max(y) : min(y), gp = gpFit(X.map(toU), y, { noise: 1e-4 });
  const U = X.map(toU), scored = C.map(c => { const p = gp.predict(c), dmin = Math.min(...U.map(u => Math.hypot(...u.map((v, j) => v - c[j])))); const s = acquisition === 'maxvar' ? p.std : expectedImprovement(p.mean, p.std, yb, xi * (Math.abs(yb) || 1), maximize); return { u: c, x: toX(c), mean: p.mean, std: p.std, score: dmin < minDist ? -Infinity : s, dmin }; }).sort((a, b) => b.score - a.score);
  const b = scored[0], nm = (j) => names[j] || `x${j + 1}`;
  const where = b.x.map((v, j) => `${nm(j)} = ${+v.toPrecision(4)}`).join(', ');
  const rationale = acquisition === 'maxvar'
    ? `Maximum-variance acquisition: at ${where} the surrogate is least certain (σ = ${b.std.toPrecision(3)}), so this test reduces model uncertainty the most. Predicted mean ${b.mean.toPrecision(4)}.`
    : `Expected-improvement acquisition: at ${where} the surrogate predicts ${b.mean.toPrecision(4)} ± ${b.std.toPrecision(3)} against the current best ${yb.toPrecision(4)}; EI = ${b.score.toPrecision(3)} balances a promising mean with remaining uncertainty.`;
  return { x: b.x, mean: b.mean, std: b.std, score: b.score, acquisition, best: yb, gp, predictAt: (x) => gp.predict(toU(x)), top: scored.slice(0, 5), rationale, lengthScales: gp.lengthScales };
}

// ======================================================================================== design of experiments
// factors: [{key, label, lo, hi, levels?:[...], n?}]
const fLevels = (f) => f.levels || linspace(f.lo, f.hi, f.n || 2);
export function fullFactorial(factors) {
  let rows = [{}]; for (const f of factors) { const L = fLevels(f), nx = []; for (const r of rows) for (const v of L) nx.push({ ...r, [f.key]: v }); rows = nx; }
  return { rows, kind: 'full factorial', runs: rows.length };
}
// two-level 2^(k−p) fractional factorial; generated factors are products of base-column interactions (largest first)
export function fractionalFactorial(factors, p = 1) {
  const k = factors.length, b = k - p; if (b < 2 || p < 0) throw new Error('A fractional factorial needs at least two base factors (k − p ≥ 2).');
  const combos = []; for (let m = 1; m < 1 << b; m++) if (m.toString(2).split('1').length - 1 >= 2) combos.push(m);
  combos.sort((x, y) => (y.toString(2).split('1').length - x.toString(2).split('1').length) || x - y);
  if (combos.length < p) throw new Error(`Too many generated factors: at most ${combos.length} with ${b} base factors.`);
  const gens = combos.slice(0, p), L = 'ABCDEFGHJKLMNOPQRSTUVWXYZ', word = (m) => range(b).filter(j => m >> j & 1).map(j => L[j]).join('');
  const coded = range(1 << b).map(r => { const base = range(b).map(j => (r >> j & 1) ? 1 : -1); return base.concat(gens.map(g => range(b).reduce((s, j) => g >> j & 1 ? s * base[j] : s, 1))); });
  // defining relation: each generator word (bitmask over k factors) and all their products
  const words = gens.map((g, i) => g | 1 << (b + i)); let group = [0]; for (const w of words) group = group.concat(group.map(g => g ^ w));
  const resolution = Math.min(...group.filter(g => g).map(g => g.toString(2).split('1').length - 1));
  const rows = coded.map(c => Object.fromEntries(factors.map((f, j) => [f.key, c[j] < 0 ? f.lo : f.hi])));
  return { rows, coded, kind: `2^(${k}−${p}) fractional factorial`, runs: rows.length, generators: gens.map((g, i) => `${L[b + i]} = ${word(g)}`), resolution, definingWords: group.filter(g => g).map(g => range(k).filter(j => g >> j & 1).map(j => L[j]).join('')) };
}
export function lhsDesign(factors, n = 10, seed = 7) { const U = lhs(n, factors.length, rng(seed)); return { rows: U.map(u => Object.fromEntries(factors.map((f, j) => [f.key, f.lo + u[j] * (f.hi - f.lo)]))), kind: 'Latin hypercube', runs: n }; }
// D-optimal-lite: Fedorov exchange over a 3-level candidate grid, maximising det(XᵀX) for the chosen model
export function dOptimal(factors, n, { model = 'linear', seed = 5, iters = 30 } = {}) {
  const k = factors.length, cand = fullFactorial(factors.map(f => ({ key: f.key, levels: [-1, 0, 1] }))).rows.map(r => factors.map(f => r[f.key]));
  const terms = (c) => { const t = [1, ...c]; if (model !== 'linear') for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) t.push(c[i] * c[j]); if (model === 'quadratic') for (let i = 0; i < k; i++) t.push(c[i] * c[i]); return t; };
  const P = terms(cand[0]).length; if (n < P) throw new Error(`The ${model} model has ${P} terms: at least ${P} runs are needed.`);
  const ld = (S) => { const X = S.map(i => terms(cand[i])), M = mm(mT(X), X).map(r => Array.from(r)); M.forEach((r, i) => r[i] += 1e-9); const v = det(M); return v > 0 ? Math.log(v) : -Infinity; };
  const R = rng(seed); let S = range(n).map(() => R.int(cand.length)), best = ld(S);
  for (let it = 0; it < iters; it++) { let improved = false; for (let i = 0; i < n; i++) for (let c = 0; c < cand.length; c++) { if (S[i] === c) continue; const T = S.slice(); T[i] = c; const v = ld(T); if (v > best + 1e-12) { S = T; best = v; improved = true; } } if (!improved) break; }
  const rows = S.map(i => Object.fromEntries(factors.map((f, j) => [f.key, f.lo + (cand[i][j] + 1) / 2 * (f.hi - f.lo)])));
  return { rows, coded: S.map(i => cand[i]), kind: `D-optimal (${model} model)`, runs: n, terms: P, logDet: best, dEff: Math.exp(best / P) / n };
}

// ======================================================================================== virtual experiments (model output only)
const geom = (d) => ({ A: d.ribbonsPerCell * d.ribbonW * d.ribbonT, L: d.ribbonL });
const mkDataset = (name, test, cols, units, meta) => { const header = Object.keys(cols), columns = {}; for (const h of header) columns[h] = Array.from(cols[h]); return { name, test, kind: 'virtual', provenance: 'hypothetical', label: 'Virtual experiment — model prediction, not a measurement', header, columns, units, nRows: columns[header[0]].length, created: iso(), meta: { ...meta, dataHash: stableHash(columns) } }; };
export function runVirtual(protocol, { design = DEFAULT_ENGINE, mat = null, noise = null, seed = 1, version = '', fidelity = 'screening' } = {}) {
  const d = designWith(design, protocol.conditions || {}), m = mat || getMat(protocol.candidate || protocol.conditions?.alloy || d.alloy);
  if (!m) throw new Error(`Unknown alloy “${protocol.candidate || d.alloy}”.`);
  const test = protocol.test || 'cell-cycle', g = geom(d), hi = fidelity === 'high', inputs = { test, design: d, alloy: m.id, fidelity };
  const meta = { protocolId: protocol.id || null, model: TEST_TYPES[test]?.model, inputs, inputsHash: stableHash(inputs), version, t0: iso() };
  let ds;
  if (test === 'cell-cycle') {
    const c = cellTransient({ mat: m, t: d.ribbonT, w: d.ribbonW, L: d.ribbonL, nRib: d.ribbonsPerCell, n: hi ? 6 : 3, Th: d.Th, Tc: d.Tc, hHot: d.hHot, hCold: d.hCold, hc: d.hContact, Cw: d.wallCapacity, period: 1 / d.freq, dutyHot: d.dutyHot, tSwitch: d.tSwitch, sBias0: d.sigmaL, kBias: d.kBias, sLoad: Math.max(0, d.sigmaH - d.sigmaL), cycles: hi ? 6 : 4, stepsPerCycle: hi ? 360 : 200 });
    const H = c.hist, nc = clamp(Math.round(protocol.conditions?.recordCycles ?? 5), 1, 50), P = 1 / d.freq, cols = { t_s: [], phase: [], T_fluid_C: [], T_wall_C: [], T_spec_C: [], F_N: [], x_mm: [], q_in_W: [], xi: [] };
    for (let k = 0; k < nc; k++) H.t.forEach((tt, i) => { cols.t_s.push(k * P + tt); cols.phase.push(tt < d.dutyHot * P ? 1 : 0); cols.T_fluid_C.push(H.Tf[i]); cols.T_wall_C.push(H.Tw[i]); cols.T_spec_C.push(H.Tm[i]); cols.F_N.push(H.F[i]); cols.x_mm.push(H.x[i] * 1e3); cols.q_in_W.push(H.qIn[i]); cols.xi.push(H.xi[i]); });
    ds = mkDataset(`Virtual ${TEST_TYPES[test].label} — ${m.id} ${d.Th}/${d.Tc} °C`, test, cols, { t_s: 's', phase: '1 = hot', T_fluid_C: '°C', T_wall_C: '°C', T_spec_C: '°C', F_N: 'N', x_mm: 'mm', q_in_W: 'W', xi: '-' },
      { ...meta, periodicReplication: `last of ${hi ? 6 : 4} solved cycles (periodic steady state) replicated ${nc}×`, summary: { Wout: c.Wout, Wcontraction: c.Wcontraction, Wreset: c.Wreset, Qhot: c.Qhot, stroke_mm: c.stroke * 1e3, mass: c.mass, specificPower: c.specificPower, eta: c.eta, etaCarnot: c.etaCarnot, energyResidual: c.energyResidual, periodicity: c.periodicity, xiSwing: c.xiSwing } });
  } else if (test === 'quasi-static') {
    const q = quasiStaticCycle(m, { Th: d.Th, Tc: d.Tc, sH: d.sigmaH, sL: d.sigmaL, n: 120, cycles: 3 }), e0 = q.path[0].e;
    ds = mkDataset(`Virtual quasi-static work loop — ${m.id}`, test, { step: range(q.path.length), stress_MPa: q.path.map(p => p.s), T_C: q.path.map(p => p.T), strain: q.path.map(p => p.e), xi: q.path.map(p => p.xi), F_N: q.path.map(p => p.s * 1e6 * g.A), x_mm: q.path.map(p => (e0 - p.e) * g.L * 1e3) }, { step: '-', stress_MPa: 'MPa', T_C: '°C', strain: '-', xi: '-', F_N: 'N', x_mm: 'mm' }, { ...meta, summary: { w_J_kg: q.w_J_kg, wContraction_J_kg: q.wContraction_J_kg, wReset_J_kg: q.wReset_J_kg, eta: q.eta, etaCarnot: q.etaCarnot, stroke: q.stroke } });
  } else if (test === 'tensile') {
    const cols = { T_C: [], stress_MPa: [], strain: [], xi: [] }, out = {};
    for (const T of [d.Tc, d.Th]) { const r = tensileTest(m, { T, sMax: Math.max(200, d.sigmaH * 2), n: 80 }); r.path.forEach(p => { cols.T_C.push(T); cols.stress_MPa.push(p.s); cols.strain.push(p.e); cols.xi.push(p.xi); }); out[`dissipated_${T}C_J_m3`] = r.dissipated_J_m3; out[`residual_${T}C`] = r.residual; }
    ds = mkDataset(`Virtual tensile load–unload — ${m.id}`, test, cols, { T_C: '°C', stress_MPa: 'MPa', strain: '-', xi: '-' }, { ...meta, summary: out });
  } else if (test === 'dsc') {
    const r = dscSim(m, { rate: 10 / 60, mass: 0.02 }), cols = { segment: [], T_C: [], heatflow_mW: [], xi: [] };
    r.heat.forEach(p => { cols.segment.push(1); cols.T_C.push(p.T); cols.heatflow_mW.push(p.q); cols.xi.push(p.xi); }); r.cool.forEach(p => { cols.segment.push(0); cols.T_C.push(p.T); cols.heatflow_mW.push(p.q); cols.xi.push(p.xi); });
    ds = mkDataset(`Simulated DSC thermogram — ${m.id}`, test, cols, { segment: '1 = heating', T_C: '°C', heatflow_mW: 'mW', xi: '-' }, { ...meta, summary: { Ap: r.Ap, Mp: r.Mp, hysteresis: r.hysteresis, unit: r.unit } });
  } else if (test === 'engine') {
    const r = engineModel(d, { mat: m, n: hi ? 4 : 2, stepsPerCycle: hi ? 240 : 140, cycles: 3 });
    const keys = ['Pgross', 'Pshaft', 'Ppump', 'Pvalves', 'Paux', 'Pnet', 'QhotTot', 'eta', 'etaC', 'carnotFraction', 'pActive', 'pCart', 'pSys', 'mActive'];
    ds = mkDataset(`Virtual engine calorimetry — ${m.id} ${d.nCells} cells`, test, { quantity: keys, value: keys.map(k => r[k]) }, { quantity: '-', value: 'SI (W, kg, W/kg, -)' }, { ...meta, summary: Object.fromEntries(keys.map(k => [k, r[k]])) });
  } else throw new Error(`Unknown test type ${test}`);
  if (noise) addSensorNoise(ds, noise, seed);
  return ds;
}
// emulate instrument noise on a virtual dataset (still hypothetical; documented in meta)
export function addSensorNoise(ds, sd = {}, seed = 1) {
  const R = rng(seed); for (const [c, s] of Object.entries(sd)) if (ds.columns[c] && s > 0) ds.columns[c] = ds.columns[c].map(v => v + R.normal(0, s));
  ds.meta.noise = { ...sd, seed, note: 'Synthetic sensor noise added to model output to rehearse the analysis chain; the data remain a model prediction.' }; ds.meta.dataHash = stableHash(ds.columns); return ds;
}
// Constitutive replay: drive the SMA model with measured temperature and force, predict displacement (hybrid experiment)
export function replayConstitutive(mat, { T, F }, { area, L, shift = 0, epsLScale = 1, x0 = 0, kinetics = 'cosine' } = {}) {
  const m2 = { ...mat, Ms: mat.Ms + shift, Mf: mat.Mf + shift, As: mat.As + shift, Af: mat.Af + shift }, s = new SMA(m2, { kinetics, epsLScale });
  const sig = F.map(f => Math.max(0, f / area / 1e6)); s.prepare(T[0], sig[0]); s.update(T[0], sig[0]);
  const e0 = s.strain(sig[0], T[0]); return T.map((Ti, i) => { s.update(Ti, sig[i]); return x0 + (e0 - s.strain(sig[i], Ti)) * L; });
}
// calibrate transformation-temperature shift, transformation-strain scale and displacement offset by Levenberg–Marquardt
export function calibrateTwin(mat, { T, F, x }, { area, L, maxPts = 400, kinetics } = {}) {
  const step = Math.max(1, Math.ceil(T.length / maxPts)), idx = range(Math.ceil(T.length / step)).map(i => i * step);
  const xs = idx.map(i => x[i]), x00 = xs[0] || 0, span = (max(xs) - min(xs)) || 1; // replay always on the full record (kinetic memory is path dependent), compare on a subsample
  // offset parameterisation keeps finite-difference Jacobian steps well above round-off: shift = q0 − 50 K, x0 = x00 + (q2 − 10)·span
  const unpack = (q) => ({ shift: q[0] - 50, epsLScale: q[1], x0: x00 + (q[2] - 10) * span });
  const run = (q) => { const full = replayConstitutive(mat, { T, F }, { area, L, kinetics, ...unpack(q) }); return idx.map(i => full[i]); };
  let lastK = '', cache = null; const model = (i, q) => { const k = q.join(','); if (k !== lastK) { cache = run(q); lastK = k; } return cache[i]; };
  const before = run([50, 1, 10]), xi = range(xs.length), sse = (q) => run(q).reduce((a, v, i) => a + (v - xs[i]) ** 2, 0);
  // multi-start: the hysteretic response is only piecewise smooth in the shift, so seed LM from the best grid points
  const starts = [];
  for (let sh = -20; sh <= 20; sh += 2.5) for (const k of [0.6, 1, 1.4]) starts.push({ q: [50 + sh, k, 10], e: sse([50 + sh, k, 10]) });
  starts.sort((a, b) => a.e - b.e);
  let fit = null; for (const st of starts.slice(0, 3)) { const f = levenbergMarquardt(model, xi, xs, st.q, { bounds: [[25, 75], [0.2, 2], [9, 11]], maxIt: 60 }); if (!fit || f.sse < fit.sse) fit = f; }
  const p = unpack(fit.p), pred = run(fit.p), se = { shift: fit.se[0], epsLScale: fit.se[1], x0: fit.se[2] * span };
  return {
    p, se, corr: fit.corr, it: fit.it, t: idx, meas: xs, pred, before, mBefore: metrics(before, xs), mAfter: metrics(pred, xs),
    calibrated: { Ms: mat.Ms + p.shift, Mf: mat.Mf + p.shift, As: mat.As + p.shift, Af: mat.Af + p.shift, epsL: mat.epsL * p.epsLScale, uShift: se.shift, uEpsL: mat.epsL * se.epsLScale },
  };
}
// hybrid computational–physical record: measured channels kept untouched, model columns appended with provenance 'calc'
export function hybridReplay(ds, mat, { area, L, shift = 0, epsLScale = 1 } = {}) { // area m², L m
  const s = seriesFromDataset(ds); if (!s.T || !s.F || !s.x) throw new Error('Hybrid replay needs temperature, force and displacement columns.');
  const col = s.xScale === 1e-3 ? 'x_model_mm' : 'x_model_m', xm = replayConstitutive(mat, { T: s.T, F: s.F }, { area, L, shift, epsLScale, x0: s.x[0] }).map(v => v / s.xScale);
  const out = clone(ds); delete out.id; out.kind = 'hybrid'; out.name = `Hybrid replay of ${ds.name}`; out.header = [...ds.header, col]; out.columns[col] = xm; out.units = { ...(ds.units || {}), [col]: s.xScale === 1e-3 ? 'mm' : 'm' };
  out.colProv = { ...Object.fromEntries(ds.header.map(h => [h, ds.provenance])), [col]: 'calc' }; out.label = 'Hybrid: source channels unchanged, model column computed from them'; out.meta = { ...(ds.meta || {}), parent: ds.id, hybrid: { shift, epsLScale, area, L }, dataHash: stableHash(out.columns) }; out.created = iso();
  return out;
}

// ======================================================================================== material discovery (predictions)
// candidate alloy from a base card: Af, thermal hysteresis H = As − Mf (≈ peak separation), transformation width kept
export function synthAlloy(base, { Af, hyst, epsL, CA }) {
  const w = Math.max(2, base.Af - base.As), As = Af - w, Mf = As - hyst, Ms = Mf + w, r = (CA ?? base.CA) / base.CA;
  return { ...base, id: `cand-${Af.toFixed(0)}-${hyst.toFixed(0)}-${(epsL * 100).toFixed(1)}-${(CA ?? base.CA).toFixed(1)}`, name: 'Candidate (hypothetical)', Af, As, Ms, Mf, epsL, CA: CA ?? base.CA, CM: base.CM * r, hyst, evidence: 'hypothetical' };
}
export function discoverMaterials({ base, Th, Tc, sigmaL, sigmaH, bounds = {}, n = 120, seed = 9, objective = 'work' } = {}) {
  const B = { Af: bounds.Af || [Tc + 15, Th - 3], hyst: bounds.hyst || [5, 35], epsL: bounds.epsL || [0.02, 0.06], CA: bounds.CA || [5, 14] };
  if (!(B.Af[1] > B.Af[0])) throw new Error(`No admissible Af range: the reservoirs ${Th}/${Tc} °C leave no room for a transformation window.`);
  const keys = ['Af', 'hyst', 'epsL', 'CA'], U = lhs(n, 4, rng(seed)), etaC = 1 - (Tc + KELVIN) / (Th + KELVIN), out = [];
  for (const u of U) {
    const v = Object.fromEntries(keys.map((k, j) => [k, B[k][0] + u[j] * (B[k][1] - B[k][0])])), m = synthAlloy(base, v);
    const AfH = m.Af + sigmaH / m.CA, MfL = m.Mf + sigmaL / m.CM, feasible = Th >= AfH && Tc <= MfL;
    const q = quasiStaticCycle(m, { Th, Tc, sH: sigmaH, sL: sigmaL, n: 80, cycles: 2 });
    out.push({ ...v, Ms: m.Ms, Mf: m.Mf, As: m.As, w_J_kg: q.w_J_kg, eta: q.eta, carnotFraction: etaC > 0 ? q.eta / etaC : 0, feasible, margins: { hot: Th - AfH, cold: MfL - Tc }, prov: 'hypothetical' });
  }
  const score = (c) => (c.feasible ? 0 : -1e9) + (objective === 'efficiency' ? c.eta : c.w_J_kg);
  out.sort((a, b) => score(b) - score(a));
  return { candidates: out, bounds: B, etaC, feasibleCount: out.filter(c => c.feasible).length };
}

// ======================================================================================== hardware connection layer
export const HARDWARE_INTERLOCK_STATEMENT = 'Software interlocks in this application are an operator aid only. Independent, hard-wired hardware safety interlocks — over-temperature cut-outs, pressure relief, force and extension limit switches, overspeed trip and an emergency-stop circuit that removes heater, pump and actuator power without any software — are mandatory before any physical apparatus is operated.';
export function hwSupport() {
  const n = typeof navigator !== 'undefined' ? navigator : {}, secure = typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : false;
  const s = { serial: 'serial' in n, usb: 'usb' in n, bluetooth: 'bluetooth' in n, secure, notes: [] };
  if (!secure) s.notes.push('Hardware APIs need a secure context (https or localhost).');
  if (!s.serial) s.notes.push('Web Serial unavailable (e.g. Firefox, Safari, iOS browsers): use the simulated instrument, or import logged CSV files.');
  if (!s.usb) s.notes.push('WebUSB unavailable in this browser.');
  if (!s.bluetooth) s.notes.push('Web Bluetooth unavailable in this browser (not supported on iOS or Firefox).');
  return s;
}
// configurable line protocol: csv (by column index), kv ("T=25.1,F=3.2"), regex (named or numbered groups) or json
export class LineParser {
  constructor({ mode = 'csv', delimiter = ',', regex = '', channels = [], timeChannel = '' } = {}) { Object.assign(this, { mode, delimiter, channels, timeChannel }); this.re = regex ? new RegExp(regex) : null; }
  parse(line) {
    line = String(line).trim(); if (!line || /^[#;]/.test(line)) return null;
    let raw = {};
    if (this.mode === 'json') { try { raw = JSON.parse(line); } catch { return null; } }
    else if (this.mode === 'kv') for (const p of line.split(/[,;\s]+/)) { const m = p.match(/^([^=:]+)[=:](.+)$/); if (m) raw[m[1].trim()] = m[2].trim(); }
    else if (this.mode === 'regex') { const m = this.re?.exec(line); if (!m) return null; raw = { ...m.groups }; m.slice(1).forEach((v, i) => raw[i + 1] = v); }
    else { const parts = line.split(this.delimiter === 'ws' ? /\s+/ : this.delimiter); parts.forEach((v, i) => raw[i] = v); }
    const values = {}; let any = false;
    for (const c of this.channels) { const r = raw[c.key ?? c.group ?? c.index]; const v = parseFloat(r); if (Number.isFinite(v)) { values[c.name] = v * (c.scale ?? 1) + (c.offset ?? 0); any = true; } }
    return any ? { values, t: this.timeChannel && Number.isFinite(values[this.timeChannel]) ? values[this.timeChannel] : null } : null;
  }
}
const lineSplitter = (onLine) => { let buf = ''; return (chunk) => { buf += chunk; const parts = buf.split(/\r?\n/); buf = parts.pop(); for (const l of parts) onLine(l); if (buf.length > 4096) buf = ''; }; };
function makeSource(kind, label, real, parser, ops) {
  const src = { kind, label, real, parser, listeners: new Set(), status: 'connected', t0: null, lastError: null, info: ops.info || {} };
  src.emit = (line) => { const p = parser.parse(line); if (!p) return; const now = Date.now(); src.t0 ??= now; const s = { t: p.t ?? (now - src.t0) / 1000, wall: now, values: p.values }; for (const fn of src.listeners) fn(s); };
  src.start = (fn) => { src.listeners.add(fn); return () => src.listeners.delete(fn); };
  src.stop = async () => { src.status = 'closed'; src.listeners.clear(); try { await ops.close?.(); } catch (e) { src.lastError = e; } };
  src.write = async (text) => { if (!ops.write) throw new Error(`${label}: this connection has no command channel.`); await ops.write(text.endsWith('\n') ? text : text + '\n'); };
  return src;
}
export async function connectSerial({ baudRate = 115200, filters = [], parser = new LineParser() } = {}) {
  if (!hwSupport().serial) throw new Error('Web Serial is not supported in this browser.');
  const port = await navigator.serial.requestPort({ filters }); await port.open({ baudRate });
  const dec = new TextDecoder(), enc = new TextEncoder(); let reader = null, alive = true;
  const src = makeSource('serial', `Serial port @ ${baudRate} Bd`, true, parser, {
    info: port.getInfo?.() || {}, write: async (t) => { const w = port.writable.getWriter(); try { await w.write(enc.encode(t)); } finally { w.releaseLock(); } },
    close: async () => { alive = false; try { await reader?.cancel(); } catch { /* already closed */ } try { await port.close(); } catch { /* already closed */ } },
  });
  const split = lineSplitter(src.emit);
  (async () => { while (alive && port.readable) { reader = port.readable.getReader(); try { for (;;) { const { value, done } = await reader.read(); if (done) break; split(dec.decode(value, { stream: true })); } } catch (e) { src.lastError = e; src.status = 'error'; } finally { reader.releaseLock(); } } })();
  return src;
}
export async function connectUSB({ filters = [], interfaceNumber = 0, endpointIn = 1, endpointOut = 1, packetSize = 64, parser = new LineParser() } = {}) {
  if (!hwSupport().usb) throw new Error('WebUSB is not supported in this browser.');
  const dev = await navigator.usb.requestDevice({ filters }); await dev.open(); if (!dev.configuration) await dev.selectConfiguration(1); await dev.claimInterface(interfaceNumber);
  const dec = new TextDecoder(), enc = new TextEncoder(); let alive = true;
  const src = makeSource('usb', `USB ${dev.productName || 'device'} (${dev.vendorId?.toString(16)}:${dev.productId?.toString(16)})`, true, parser, {
    info: { vendorId: dev.vendorId, productId: dev.productId, product: dev.productName, serial: dev.serialNumber }, write: (t) => dev.transferOut(endpointOut, enc.encode(t)),
    close: async () => { alive = false; try { await dev.releaseInterface(interfaceNumber); await dev.close(); } catch { /* device gone */ } },
  });
  const split = lineSplitter(src.emit);
  (async () => { while (alive) { try { const r = await dev.transferIn(endpointIn, packetSize); if (r.data) split(dec.decode(r.data, { stream: true })); } catch (e) { src.lastError = e; src.status = 'error'; break; } } })();
  return src;
}
export async function connectBluetooth({ service, characteristic, writeCharacteristic = null, namePrefix = '', parser = new LineParser() } = {}) {
  if (!hwSupport().bluetooth) throw new Error('Web Bluetooth is not supported in this browser.');
  const svc = /^[0-9a-f]{4}$/i.test(service) ? parseInt(service, 16) : service, chr = /^[0-9a-f]{4}$/i.test(characteristic) ? parseInt(characteristic, 16) : characteristic;
  const dev = await navigator.bluetooth.requestDevice(namePrefix ? { filters: [{ namePrefix }], optionalServices: [svc] } : { acceptAllDevices: true, optionalServices: [svc] });
  const server = await dev.gatt.connect(), s = await server.getPrimaryService(svc), ch = await s.getCharacteristic(chr), wch = writeCharacteristic ? await s.getCharacteristic(/^[0-9a-f]{4}$/i.test(writeCharacteristic) ? parseInt(writeCharacteristic, 16) : writeCharacteristic) : null;
  const dec = new TextDecoder(), enc = new TextEncoder();
  const src = makeSource('bluetooth', `Bluetooth ${dev.name || dev.id}`, true, parser, { info: { name: dev.name, id: dev.id }, write: wch ? (t) => wch.writeValue(enc.encode(t)) : null, close: async () => { try { await ch.stopNotifications(); } catch { /* disconnected */ } dev.gatt.disconnect(); } });
  const split = lineSplitter(src.emit);
  ch.addEventListener('characteristicvaluechanged', (e) => split(dec.decode(e.target.value) + (parser.mode === 'json' ? '\n' : '')));
  dev.addEventListener('gattserverdisconnected', () => { src.status = 'disconnected'; });
  await ch.startNotifications();
  return src;
}
// Built-in simulated instrument for software testing: replays a model-solved cell cycle with sensor noise, accepts
// SET/SAFE/FAULT commands. Clearly labelled; recorded data are provenance 'hypothetical'. manual:true → drive with tick().
export function simulatedSource({ design = DEFAULT_ENGINE, mat = null, rateHz = 20, noise = { T: 0.08, F: 0.03, x: 0.002 }, seed = 5, manual = false } = {}) {
  let d = designWith(design), m = mat || getMat(d.alloy), R = rng(seed), cyc = null, t = 0, timer = null, safe = false, fault = null, Tsafe = d.Tc, lastF = 0;
  const solve = () => { const c = cellTransient({ mat: m, t: d.ribbonT, w: d.ribbonW, L: d.ribbonL, nRib: d.ribbonsPerCell, n: 2, Th: d.Th, Tc: d.Tc, hHot: d.hHot, hCold: d.hCold, hc: d.hContact, Cw: d.wallCapacity, period: 1 / d.freq, dutyHot: d.dutyHot, tSwitch: d.tSwitch, sBias0: d.sigmaL, kBias: d.kBias, sLoad: Math.max(0, d.sigmaH - d.sigmaL), cycles: 3, stepsPerCycle: 160 }); cyc = { H: c.hist, P: 1 / d.freq }; };
  solve();
  const src = { kind: 'simulated', label: 'Simulated instrument (synthetic model data — not a measurement)', real: false, listeners: new Set(), status: 'connected', setpoints: { Th: d.Th, Tc: d.Tc, preload: d.sigmaL }, log: [] };
  src.sample = () => {
    const H = cyc.H, tau = t % cyc.P, i = Math.min(H.t.length - 1, Math.floor(tau / cyc.P * H.t.length)); let T, Tf, F, x;
    if (safe) { Tsafe += (d.Tc - Tsafe) * 0.05; T = Tsafe; Tf = d.Tc; F = d.sigmaL * 1e6 * d.ribbonsPerCell * d.ribbonW * d.ribbonT; x = 0; } else { T = H.Tm[i]; Tf = H.Tf[i]; F = H.F[i]; x = H.x[i] * 1e3; Tsafe = T; }
    if (fault === 'overtemp') { T += (t - (src.faultT ?? t)) * 15; Tf = T; }
    if (fault === 'overforce') F *= 1 + (t - (src.faultT ?? t)) * 2;
    lastF = F;
    return { t, wall: Date.now(), values: { T_spec_C: T + R.normal(0, noise.T), T_fluid_C: Tf + R.normal(0, noise.T), F_N: F + R.normal(0, noise.F), x_mm: x + R.normal(0, noise.x), dp_Pa: (safe ? 0 : 2.5e4) * (1 + R.normal(0, 0.01)), speed_rpm: 0 } };
  };
  src.tick = (dt = 1 / rateHz) => { t += dt; if (fault === 'stale') return null; const s = src.sample(); for (const fn of src.listeners) fn(s); return s; };
  src.start = (fn) => { src.listeners.add(fn); if (!manual && !timer) timer = setInterval(() => src.tick(), 1000 / rateHz); return () => src.listeners.delete(fn); };
  src.stop = async () => { clearInterval(timer); timer = null; src.listeners.clear(); src.status = 'closed'; };
  src.write = async (text) => {
    const [cmd, a, b] = String(text).trim().split(/\s+/); src.log.push({ t, cmd: text.trim() });
    if (/^SAFE$/i.test(cmd)) { safe = true; fault = fault === 'stale' ? fault : null; return; }
    if (/^RESUME$/i.test(cmd)) { safe = false; return; }
    if (/^FAULT$/i.test(cmd)) { fault = (a || '').toLowerCase() || null; src.faultT = t; return; }
    if (/^SET$/i.test(cmd) && Number.isFinite(+b)) { src.setpoints[a] = +b; if (a === 'Th' || a === 'Tc') { d = { ...d, [a]: +b }; solve(); } else if (a === 'preload') { d = { ...d, sigmaL: +b }; solve(); } return; }
    throw new Error(`Simulated instrument: unknown command “${text.trim()}”`);
  };
  src.state = () => ({ safe, fault, t, lastF });
  return src;
}

// ======================================================================================== safety, acquisition & sequencing
export const DEFAULT_LIMITS = { Tmax: 95, Tmin: 0, Fmax: 2500, xMax: 12, pMax: 3e5, speedMax: 300, staleMs: 2000 };
// limits derived from the design: reservoirs + margin, 1.6 × power-stroke force, 1.5 × transformation stroke (mm)
export function limitsFromDesign(design, mat = null) {
  const d = designWith(design), m = mat || getMat(d.alloy), A = d.ribbonsPerCell * d.ribbonW * d.ribbonT;
  return { Tmax: Math.round(d.Th + 15), Tmin: Math.round(Math.max(-20, d.Tc - 10)), Fmax: Math.ceil(1.6 * d.sigmaH * 1e6 * A), xMax: +(1.5 * (m?.epsL || 0.05) * d.ribbonL * 1e3).toFixed(2), pMax: 3e5, speedMax: 300, staleMs: 2000 };
}
const LIMIT_MAP = [[/^(t|t_s|time|timestamp)$/i, null, null, 'time'], [/torque/i, null, null, 'torque'], [/^T|temp/i, 'Tmin', 'Tmax', 'temperature'], [/^F|force|load/i, null, 'Fmax', 'force'], [/^x|disp|ext|stroke/i, null, 'xMax', 'extension'], [/^dp|^p_|press/i, null, 'pMax', 'pressure'], [/speed|rpm|omega/i, null, 'speedMax', 'speed']];
export function validateLimits(L) {
  const bad = []; for (const k of Object.keys(DEFAULT_LIMITS)) if (!Number.isFinite(+L?.[k])) bad.push(`${k} is not a number`);
  if (+L?.Tmax <= +L?.Tmin) bad.push('Tmax must exceed Tmin'); if (+L?.staleMs < 100) bad.push('stale-data timeout below 100 ms is not achievable');
  for (const k of ['Fmax', 'xMax', 'pMax', 'speedMax']) if (+L?.[k] <= 0) bad.push(`${k} must be positive`);
  return bad;
}
export class Safety {
  constructor({ limits = DEFAULT_LIMITS, source = null, safeCommand = 'SAFE', onTrip = null, onState = null } = {}) { Object.assign(this, { limits: { ...limits }, source, safeCommand, onTrip, onState }); this.state = 'disarmed'; this.log = []; this.lastSample = null; this.operator = ''; this.monitoring = true; }
  _log(type, msg) { const e = { t: new Date().toISOString(), type, msg }; this.log.push(e); if (this.log.length > 1000) this.log.shift(); return e; }
  _set(s, why) { this.state = s; this._log('state', `${s}${why ? ' — ' + why : ''}`); this.onState?.(s, why); }
  setLimits(L) { if (this.state === 'armed') throw new Error('Disarm before changing limits.'); const bad = validateLimits(L); if (bad.length) throw new Error('Invalid limits: ' + bad.join('; ')); this.limits = { ...L }; this._log('limits', JSON.stringify(this.limits)); }
  arm({ operator = '', acknowledged = false, limits = null } = {}) {
    if (this.state === 'tripped' || this.state === 'estop') throw new Error('Interlock tripped: investigate, then reset before arming.');
    if (!operator.trim()) throw new Error('Operator identification is required to arm.');
    if (acknowledged !== true) throw new Error('The operator must confirm that independent hardware interlocks are fitted and tested.');
    if (limits) this.setLimits(limits); const bad = validateLimits(this.limits); if (bad.length) throw new Error('Invalid limits: ' + bad.join('; '));
    this.operator = operator.trim(); this._set('armed', `operator ${this.operator}; limits ${JSON.stringify(this.limits)}`); return true;
  }
  disarm(why = 'operator') { if (this.state === 'armed') this._set('disarmed', why); }
  reset(operator = '') { if (!operator.trim()) throw new Error('Operator identification is required to reset an interlock.'); if (this.state === 'tripped' || this.state === 'estop') this._set('disarmed', `reset by ${operator.trim()}`); }
  violations(sample) {
    const out = [], L = this.limits; if (!sample?.values) return out;
    for (const [ch, v] of Object.entries(sample.values)) { if (!Number.isFinite(v)) continue; const m = LIMIT_MAP.find(r => r[0].test(ch)); if (!m) continue; const [, , hi, q] = m;
      if (q === 'temperature') { if (v > L.Tmax) out.push(`${ch} = ${v.toFixed(2)} exceeds Tmax ${L.Tmax}`); if (v < L.Tmin) out.push(`${ch} = ${v.toFixed(2)} below Tmin ${L.Tmin}`); }
      else if (hi && Math.abs(v) > L[hi]) out.push(`${q} ${ch} = ${v.toFixed(3)} exceeds ${hi} ${L[hi]}`); }
    return out;
  }
  check(sample, now = Date.now()) { this.lastSample = now; if (!this.monitoring || this.state === 'tripped' || this.state === 'estop') return []; const v = this.violations(sample); if (v.length) this.trip(v.join('; ')); return v; }
  watchdog(now = Date.now()) { if (this.state !== 'armed' || this.lastSample === null) return false; if (now - this.lastSample > this.limits.staleMs) { this.trip(`stale data: no sample for ${now - this.lastSample} ms (limit ${this.limits.staleMs} ms)`); return true; } return false; }
  async _safe() { try { await this.source?.write?.(this.safeCommand); this._log('command', `safe-state command “${this.safeCommand}” sent`); } catch (e) { this._log('error', `safe-state command failed: ${e.message} — rely on the hardware interlock`); } }
  trip(reason) { if (this.state === 'tripped' || this.state === 'estop') return; this._set('tripped', reason); this._safe(); this.onTrip?.(reason, this); }
  estop() { this._set('estop', 'emergency stop pressed'); this._safe(); this.onTrip?.('emergency stop', this); }
  // setpoint commands ("SET <ch> <v>") are checked against the limits; nothing is sent unless armed
  async command(text) {
    if (this.state !== 'armed') { this._log('refused', `“${text}” refused: system not armed`); throw new Error('Commands are refused until the operator arms the system.'); }
    const m = String(text).match(/^SET\s+(\S+)\s+(-?[\d.eE+-]+)/i);
    if (m) { const ch = m[1], v = +m[2], L = this.limits;
      if (/^T/i.test(ch) && (v > L.Tmax || v < L.Tmin)) { this._log('refused', `“${text}” refused: outside ${L.Tmin}–${L.Tmax} °C`); throw new Error(`Setpoint ${v} outside the temperature limits.`); }
      if (/^(F|force|load)/i.test(ch) && Math.abs(v) > L.Fmax) { this._log('refused', `“${text}” refused: above Fmax`); throw new Error('Setpoint above the force limit.'); } }
    if (!this.source?.write) throw new Error('No connected source with a command channel.');
    await this.source.write(text); this._log('command', text); return true;
  }
}
export class Acquisition {
  constructor({ source, safety = null, maxPoints = 20000, watchdogMs = 250 } = {}) { Object.assign(this, { source, safety, maxPoints, watchdogMs }); this.data = { t: [], channels: {} }; this.running = false; this.listeners = new Set(); this.n = 0; this.t0 = null; }
  start() {
    if (this.running) return; this.running = true; this.unsub = this.source.start((s) => this._on(s));
    if (this.safety) { this.safety.source ||= this.source; this.safety.lastSample = Date.now(); if (typeof setInterval !== 'undefined' && this.watchdogMs) this.wd = setInterval(() => { if (this.safety.watchdog(Date.now())) this.stop('watchdog'); }, this.watchdogMs); }
  }
  _on(s) {
    if (!this.running) return; this.t0 ??= s.t; const t = s.t - this.t0;
    this.data.t.push(t); for (const [k, v] of Object.entries(s.values)) { const a = (this.data.channels[k] ||= new Array(this.data.t.length - 1).fill(NaN)); a.push(v); }
    for (const a of Object.values(this.data.channels)) if (a.length < this.data.t.length) a.push(NaN);
    if (this.data.t.length > this.maxPoints) { this.data.t.shift(); for (const a of Object.values(this.data.channels)) a.shift(); }
    this.n++; const v = this.safety ? this.safety.check(s, s.wall ?? Date.now()) : [];
    for (const fn of this.listeners) fn(s, t, v);
    if (v.length) this.stop('interlock');
  }
  stop(why = 'operator') { if (!this.running) return; this.running = false; this.unsub?.(); clearInterval(this.wd); this.stopReason = why; for (const fn of this.listeners) fn(null, null, [], why); }
  clear() { this.data = { t: [], channels: {} }; this.n = 0; this.t0 = null; }
  toDataset(name, { protocolId = null, specimenId = null, instruments = [], version = '' } = {}) {
    const real = !!this.source?.real, header = ['t_s', ...Object.keys(this.data.channels)], columns = { t_s: this.data.t.slice() };
    for (const k of Object.keys(this.data.channels)) columns[k] = this.data.channels[k].slice();
    const units = Object.fromEntries(header.map(h => [h, (h.match(/_(s|C|N|mm|Pa|rpm|W|V)$/) || [])[1]?.replace('C', '°C') || ''])); units.t_s = 's';
    return { name, kind: real ? 'physical' : 'simulated-instrument', provenance: real ? 'measured' : 'hypothetical', label: real ? `Measured — ${this.source.label}` : 'Simulated instrument — synthetic data for software testing, not a measurement', test: 'cell-cycle', header, columns, units, nRows: columns.t_s.length, created: iso(), meta: { source: this.source?.label, sourceKind: this.source?.kind, info: this.source?.info || null, protocolId, specimenId, instrumentIds: instruments.map(i => i.id), stopReason: this.stopReason || null, samples: this.n, version, dataHash: stableHash(columns) } };
  }
}
// step sequencer: ops 'set' (command, armed only), 'hold'/'record' (timed), 'mark' (operator note), 'safe'
export class Sequencer {
  constructor({ steps = [], safety, acq = null, onEvent = null, timeScale = 1, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) { Object.assign(this, { steps, safety, acq, onEvent, timeScale, sleep }); this.i = -1; this.state = 'idle'; this.aborted = false; }
  abort(why = 'operator') { this.aborted = true; this.state = 'aborted'; this.onEvent?.({ type: 'abort', why }); }
  async run() {
    if (this.safety.state !== 'armed') throw new Error('Arm the system (limits + operator + hardware-interlock confirmation) before running a sequence.');
    this.state = 'running'; this.aborted = false;
    for (this.i = 0; this.i < this.steps.length; this.i++) {
      const s = this.steps[this.i]; this.onEvent?.({ type: 'step', i: this.i, step: s });
      if (this.safety.state !== 'armed') { this.abort(`safety state ${this.safety.state}`); break; }
      try {
        if (s.op === 'set') await this.safety.command(`SET ${s.channel} ${s.value}`);
        else if (s.op === 'safe') await this.safety.source?.write?.(this.safety.safeCommand);
        else if (s.op === 'record' && this.acq && !this.acq.running) this.acq.start();
        if (s.op === 'hold' || s.op === 'record') { const end = Date.now() + (s.duration_s || 0) * 1000 * this.timeScale; while (Date.now() < end) { if (this.aborted || this.safety.state !== 'armed') break; await this.sleep(Math.min(100, end - Date.now())); } }
      } catch (e) { this.onEvent?.({ type: 'error', i: this.i, msg: e.message }); this.abort(e.message); break; }
      if (this.aborted || this.safety.state !== 'armed') { if (!this.aborted) this.abort(`safety state ${this.safety.state}`); break; }
    }
    if (this.state === 'running') { this.state = 'done'; this.onEvent?.({ type: 'done' }); }
    return this.state;
  }
}

// ======================================================================================== scheduling
// jobs: [{id, name, test, specimen, duration (h), setup (h), priority (1 high … 5 low), rig?}] → list schedule
export function scheduleRuns(jobs, rigs = DEFAULT_RIGS, { start = 0 } = {}) {
  const free = Object.fromEntries(rigs.map(r => [r.id, start])), busySpec = {}, out = [], unplaced = [];
  const order = jobs.slice().sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || (b.duration || 0) - (a.duration || 0));
  for (const j of order) {
    const ok = rigs.filter(r => (j.rig ? r.id === j.rig : true) && (!j.test || !r.caps || r.caps.includes(j.test)));
    if (!ok.length) { unplaced.push({ ...j, why: `no rig can run “${j.test}”` }); continue; }
    const best = ok.map(r => ({ r, s: Math.max(free[r.id], busySpec[j.specimen] ?? start) })).sort((a, b) => a.s - b.s)[0];
    const s0 = best.s, e = s0 + (j.setup || 0) + (j.duration || 1); free[best.r.id] = e; if (j.specimen) busySpec[j.specimen] = e;
    out.push({ ...j, rig: best.r.id, start: s0, end: e });
  }
  const makespan = Math.max(start, ...out.map(o => o.end)) - start;
  const util = Object.fromEntries(rigs.map(r => [r.id, makespan > 0 ? sum(out.filter(o => o.rig === r.id).map(o => o.end - o.start)) / makespan : 0]));
  return { items: out, unplaced, makespan, util };
}

// ======================================================================================== validation ladder & reporting
export const LADDER = [
  { gate: 'V0', title: 'Material coupon and DSC characterisation', pass: 'Measured phase temperatures, stress–strain loops and uncertainty-backed property model' },
  { gate: 'V1', title: 'Single ribbon + force/displacement/temperature', pass: 'Repeatable gross contraction and lower-work reset pathway' },
  { gate: 'V2', title: 'Single cartridge with calorimetry', pass: 'Positive NET closed-cycle work after reset and parasitic accounting' },
  { gate: 'V3', title: 'Six or more independently phased cartridges', pass: 'Continuous or repeatable shaft rotation, measured positive average power' },
  { gate: 'V4', title: 'Regenerator integration', pass: 'Measured improvement in system net efficiency at matched boundary conditions' },
  { gate: 'V5', title: 'Endurance and off-design operation', pass: 'Durability and safe operation under a defined load, temperature and fault matrix' },
  { gate: 'V6', title: 'Independent benchmark comparison', pass: 'Matched-condition improvement reported with confidence intervals' },
];
// evidence only from measured datasets (virtual, simulated-instrument and hybrid model columns never count)
export function ladderStatus(L) {
  const meas = (L.datasets || []).filter(d => d.provenance === 'measured'), tag = (d, re) => re.test(`${d.test || ''} ${(d.tags || []).join(' ')} ${d.name || ''}`);
  const st = LADDER.map(g => ({ ...g, status: 'open', evidence: [], detail: '' }));
  const set = (i, status, evidence, detail) => Object.assign(st[i], { status, evidence, detail });
  const v0 = meas.filter(d => tag(d, /dsc|tensile/i)); set(0, v0.some(d => tag(d, /dsc/i)) && v0.some(d => tag(d, /tensile/i)) ? 'pass' : v0.length ? 'partial' : 'open', v0.map(d => d.id), v0.length ? `${v0.length} measured DSC/tensile dataset(s)${v0.some(d => tag(d, /tensile/i)) ? '' : '; tensile loops still required'}${v0.some(d => tag(d, /dsc/i)) ? '' : '; DSC still required'}` : 'Import or record measured DSC and tensile datasets.');
  const v1 = []; for (const d of meas.filter(x => tag(x, /cell|ribbon|cycle/i))) { try { const s = segmentCycles(seriesFromDataset(d)).summary; v1.push({ d, s }); } catch { /* unsuitable columns */ } }
  const v1ok = v1.filter(r => r.s.repeatable && r.s.Wcon > r.s.Wres);
  set(1, v1ok.length ? 'pass' : v1.length ? 'partial' : 'open', v1.map(r => r.d.id), v1.length ? v1.map(r => `${r.d.id}: ${r.s.n} cycles, CV ${(r.s.cv * 100).toFixed(1)} %, contraction ${r.s.Wcon.toExponential(2)} J vs reset ${r.s.Wres.toExponential(2)} J`).join('; ') : 'Record a measured single-ribbon F–x–T run with ≥ 3 cycles.');
  const v2 = v1.filter(r => tag(r.d, /cartridge|calorim/i) || Number.isFinite(r.s.Qin)), v2ok = v2.filter(r => r.s.positive);
  set(2, v2ok.length ? 'pass' : v2.length ? 'partial' : 'open', v2.map(r => r.d.id), v2.length ? v2.map(r => `${r.d.id}: net ${r.s.Wnet.toExponential(3)} J, 95 % CI [${r.s.ci95.map(v => v.toExponential(2)).join(', ')}]`).join('; ') : 'Needs a measured cartridge run with calorimetry (heat-flow channel) and the net-work lower confidence bound > 0.');
  const v3 = meas.filter(d => d.columns && d.header?.some(h => /torque/i.test(h)) && d.header?.some(h => /speed|rpm/i.test(h)));
  const v3ok = v3.filter(d => { const T = d.columns[d.header.find(h => /torque/i.test(h))], w = d.columns[d.header.find(h => /speed|rpm/i.test(h))]; return mean(T.map((v, i) => v * w[i] * 2 * Math.PI / 60).filter(Number.isFinite)) > 0; });
  set(3, v3ok.length ? 'pass' : v3.length ? 'partial' : 'open', v3.map(d => d.id), v3.length ? `${v3ok.length}/${v3.length} torque–speed dataset(s) with positive mean shaft power` : 'Needs measured shaft torque and speed from a ≥ 6-cartridge engine.');
  const v4 = meas.filter(d => tag(d, /regen/i)); set(4, v4.length >= 2 ? 'partial' : 'open', v4.map(d => d.id), v4.length >= 2 ? 'Regenerator on/off datasets present: compare net efficiency at matched conditions in Analysis.' : 'Needs matched-condition datasets with and without the regenerator.');
  const v5 = meas.filter(d => tag(d, /endurance|fatigue|fault/i)); set(5, v5.length ? 'partial' : 'open', v5.map(d => d.id), v5.length ? `${v5.length} endurance/fault dataset(s); judge against the fault matrix.` : 'Needs endurance and fault-matrix runs.');
  const v6 = meas.filter(d => tag(d, /benchmark/i)); set(6, v6.length ? 'partial' : 'open', v6.map(d => d.id), v6.length ? 'Benchmark datasets present; report the matched-condition difference with confidence intervals.' : 'Needs an independent benchmark at matched conditions.');
  return st;
}
const escH = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function reportHTML(store, { version = '', title = 'Experimental evidence report', sections = [] } = {}) {
  const L = labOf(store), p = store.project, lad = ladderStatus(L), f = (v) => typeof v === 'number' ? (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v) ? v.toExponential(3) : +v.toPrecision(4)) : escH(v);
  const tbl = (cols, rows) => `<table><thead><tr>${cols.map(c => `<th>${escH(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${f(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escH(title)}</title><style>body{font:13px/1.45 system-ui,sans-serif;color:#111;margin:24px;max-width:1000px}h1{font-size:20px}h2{font-size:15px;border-bottom:1px solid #999;margin-top:22px}table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #bbb;padding:3px 6px;text-align:left;vertical-align:top}th{background:#eee}.pass{color:#166534;font-weight:600}.partial{color:#92400e;font-weight:600}.open{color:#555}.note{font-size:11px;color:#444}</style></head><body>
<h1>${escH(title)}</h1><p class="note">Project ${escH(p.id)} — ${escH(p.name)} · revision ${p.revision} · THERMA-X100 ${escH(version)} · generated ${iso()}<br>Provenance classes: measured = calibrated laboratory instruments; hypothetical = model prediction or simulated instrument (never evidence); calibrated = fitted to measurements.</p>
<h2>Validation ladder (V0–V6) from recorded datasets</h2>${tbl(['Gate', 'Hardware / evidence', 'Pass criterion', 'Status', 'Evidence'], lad.map(g => [g.gate, g.title, g.pass, g.status, g.detail]))}
<h2>Hypotheses</h2>${tbl(['ID', 'Statement', 'Status'], L.hypotheses.map(h => [h.id, h.statement, h.status]))}
<h2>Protocols</h2>${tbl(['ID', 'Name', 'Version', 'Status', 'Hash', 'Parent'], L.protocols.map(r => [r.id, r.name, r.version, r.status, r.hash || '', r.parent || '']))}
<h2>Specimens</h2>${tbl(['ID', 'Alloy / lot', 'Heat treatment', 'Geometry', 'Status'], L.specimens.map(s => [s.id, `${s.alloy || ''} / ${s.lot || ''}`, s.heatTreatment || '', s.geometry || '', s.status]))}
<h2>Instruments and calibration</h2>${tbl(['ID', 'Instrument', 'Channel', 'u (std)', 'u rel', 'Certificate', 'Status'], L.instruments.map(i => [i.id, i.name, i.channel, i.u, i.uRel, i.cert || '—', calStatus(i).label]))}
<h2>Datasets</h2>${tbl(['ID', 'Name', 'Kind', 'Provenance', 'Rows', 'Data hash'], L.datasets.map(d => [d.id, d.name, d.kind, d.provenance, d.nRows, d.meta?.dataHash || '']))}
<h2>Run records</h2>${tbl(['ID', 'Protocol', 'Dataset', 'Kind', 'Inputs hash', 'Software', 'Time'], L.runs.map(r => [r.id, `${r.protocolId || ''} v${r.protocolVersion || ''}`, r.datasetId || '', r.kind || '', r.inputsHash || '', r.software?.version || '', r.t || r.created]))}
${sections.map(s => `<h2>${escH(s.title)}</h2>${s.html}`).join('\n')}
<h2>Calibrated parameters</h2>${tbl(['Alloy', 'Parameter', 'Value', 'Std. uncertainty', 'Source dataset', 'Time'], Object.entries(L.calibrated).flatMap(([a, c]) => Object.entries(c.values || {}).map(([k, v]) => [a, k, v, c.u?.[k] ?? '', c.dataset || '', c.t || ''])))}
<p class="note">Claims of improvement must declare numerator, denominator, normalisation basis, operating temperatures, duration, material-mass definition and uncertainty (specification §34). Model predictions in this report are labelled hypothetical and are not evidence.</p></body></html>`;
}
