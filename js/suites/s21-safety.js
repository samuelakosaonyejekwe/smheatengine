// Suite 21 — Safety, reliability and operational control (master spec Module 21, §37; EIGDAS Module 21).
// Safe operating envelope, FMEA with RPN, fault tree with AND/OR gates and importance measures, reliability block
// diagram (MTBF), watchdog/trip-logic fault-injection simulations (overtemperature, overspeed, low flow), required vs
// achieved safety-integrity level, rotor-burst containment energy and hot-surface / scald exposure.
import { engineModel } from '../core/engine.js';
import { fatigueLife } from '../core/sma.js';
import { get as getMat } from '../core/materials.js';
import { massBreakdown } from '../core/econ.js';
import { linspace, range, fmt, interp1 } from '../core/num.js';
import { anim2d, seriesPanel, text, theme } from '../core/anim2d.js';

// Approximate burn-threshold data (representative of published contact-burn and hot-water scald studies; verify against
// the applicable standard before use). [contact time s, threshold °C]
const BURN_METAL = [[1, 65], [4, 59], [10, 56], [60, 51], [600, 48], [28800, 43]];
const SCALD_WATER = [[1, 69], [5, 60], [30, 55], [300, 50], [3600, 46]];
const tAllow = (tab, T) => { if (T <= tab[tab.length - 1][1]) return Infinity; if (T >= tab[0][1]) return tab[0][0] * (tab[0][1] / T) ** 8; const xs = tab.map(r => r[1]).reverse(), ys = tab.map(r => Math.log10(r[0])).reverse(); return 10 ** interp1(xs, ys, T); };
const psatBar = (T) => 10 ** (8.07131 - 1730.63 / (233.426 + T)) / 750.062; // water, Antoine (1–100 °C), bar
const OR = (ps) => 1 - ps.reduce((a, p) => a * (1 - p), 1), AND = (ps) => ps.reduce((a, p) => a * p, 1);

export default {
  description: 'Defines the safe operating envelope (material temperature, fluid pressure, rotor speed, extension, casing pressure, leak rate), ranks failure modes by FMEA, computes the top-event probability of a fault tree, the system MTBF from a reliability block diagram, simulates watchdog trips under injected faults, sizes the required safety-integrity level and checks rotor-burst containment and hot-surface/scald exposure.',
  literature: 'shape memory alloy heat engine safety FMEA fault tree overspeed protection hot surface burn threshold',
  econ: false, sustain: false,
  credibility: 'Analytical screening',
  equations: [
    'Envelope utilisation U = operating value / limit (U < 1 inside the envelope; margin = 1 − U)',
    'FMEA risk priority number RPN = S × O × D (1–10 scales)',
    'Fault tree: P(AND) = Π pᵢ, P(OR) = 1 − Π(1 − pᵢ) (independent basic events); Birnbaum importance I_B = P(top | pᵢ = 1) − P(top | pᵢ = 0); Fussell–Vesely ≈ pᵢ·I_B / P(top)',
    'Series RBD: λ_sys = Σ nᵢλᵢ, MTBF = 1/λ_sys, R(t) = exp(−λ_sys t); redundant pair (1-out-of-2): MTBF = 3/(2λ)',
    'Hot loop: C dT/dt = Q_heat − UA(T − T₀) − Q_engine; sensor τ_s dT_s/dt = T − T_s',
    'Rotor: J dω/dt = τ_e(ω) − τ_load − τ_brake; τ_e = τ₀(1 − ω/ω_free); pump failure: ṁ = ṁ₀e^(−t/τ_p), cold inventory C_c dT/dt = Q_rej − ṁc_p(T − T_c)',
    'Trip channel PFD_avg ≈ λ_DU·T_proof/2; required risk reduction RRF = f_demand·P_exposure/f_tolerable → SIL band (IEC 61508 low-demand bands)',
    'Disc burst stress σ_θ,max = (3 + ν)/8·ρω²R²; kinetic energy E = ½Jω²; casing absorption (screening) E_abs ≈ k·σ_u·ε_f·V_ring',
    'Insulated surface temperature T_s = T₀ + (T_h − T₀)·R_o/(R_ins + R_o), R_ins = t/k, R_o = 1/h_o',
  ],
  methods: ['Time integration (Δt = 0.05 s; rotor speed semi-implicit because the torque–speed slope is stiff for a light rotor) of three fault-injection scenarios with and without the trip active', 'Exact gate algebra on the fault tree; importance by re-evaluation with pᵢ = 0/1', 'Reduced engine model (Suite 18 outputs when available) for flows, torque and stroke'],
  assumptions: [
    'Basic-event probabilities, failure rates and FMEA scores are order-of-magnitude engineering estimates (hypothetical) until field/test data exist',
    'Burn and scald thresholds are approximate published values — verify against the applicable standard for design',
    'Lumped hot-loop and rotor models; fluid properties of water',
    'Casing containment energy is a screening estimate, not a substitute for a burst/containment test',
  ],
  ibc: { initial: ['Steady nominal operation at the design point before each injected fault', 'Healthy sensors (unless sensor drift is selected)'], boundary: ['Injected fault at t = 60 s: heater control stuck on, load loss, circulation-pump failure', 'Trip actions: isolate hot supply, apply brake, safe stop'] },
  cvv: {
    calibration: ['Sensor response times and trip set-points from commissioning tests', 'Failure rates from component data and field records'],
    verification: ['Gate algebra vs exhaustive enumeration', 'Trip simulation energy balance and no-trip reference', 'R(MTBF) = e⁻¹'],
    validation: ['Fault-injection tests on the rig (watchdog, relief, overspeed brake)', 'Relief-valve and pressure tests', 'Safety validation per stage gate V5'],
  },
  formats: { import: ['CSV failure/maintenance records', 'XLSX FMEA'], export: ['FMEA CSV', 'Fault tree JSON', 'Trip test report CSV', 'Plots PNG/SVG'] },
  params: [
    { key: 'TmaxMat', label: 'Maximum permitted material temperature', unit: '°C', type: 'number', min: 40, max: 400, step: 1, default: 120, group: 'Envelope limits', auto: (c) => { const r = c.material('ribbon') || getMat(c.engine.alloy), s = c.material('seal'); const v = Math.min(r?.Tmax ?? 120, s?.Tmax ?? 200); return { value: v, prov: 'library' }; } },
    { key: 'TfluidMax', label: 'Maximum hot-fluid temperature', unit: '°C', type: 'number', min: 30, max: 300, step: 1, default: 90, group: 'Envelope limits', auto: (c) => { const f = getMat(c.engine.hotFluid); return f ? { value: Math.min(f.Tmax - 5, 250), prov: 'library' } : undefined; } },
    { key: 'pMax', label: 'Design pressure of fluid circuit', unit: 'bar(g)', type: 'number', min: 0.5, max: 50, step: 0.1, default: 3, group: 'Envelope limits' },
    { key: 'casingMax', label: 'Casing pressure limit', unit: 'bar(g)', type: 'number', min: 0.01, max: 5, step: 0.01, default: 0.2, group: 'Envelope limits', help: 'Vented casing; internal leaks must not pressurise it.' },
    { key: 'leakMax', label: 'Leak-rate limit', unit: 'mL/min', type: 'number', min: 0.01, max: 100, step: 0.01, default: 1, group: 'Envelope limits' },
    { key: 'strainMax', label: 'Maximum ribbon extension (strain)', unit: '%', type: 'number', min: 1, max: 10, step: 0.1, default: 5, group: 'Envelope limits', auto: (c) => { const m = getMat(c.engine.alloy); return m ? { value: +(m.epsL * 100 + 0.8).toFixed(1), prov: 'library' } : undefined; } },
    { key: 'SFburst', label: 'Rotor burst safety factor', type: 'number', min: 1.2, max: 5, step: 0.1, default: 2, group: 'Envelope limits' },
    { key: 'Rrotor', label: 'Rotor / flywheel radius', unit: 'm', type: 'number', min: 0.02, max: 1, step: 0.005, default: 0.08, group: 'Rotor & containment', auto: (c) => { const e = c.upstream('s02')?.envelope; return e?.D ? { value: +(e.D / 2 * 0.8).toFixed(3), prov: 'coupled' } : undefined; } },
    { key: 'Jrotor', label: 'Rotor inertia (0 = from rotor mass)', unit: 'kg·m²', type: 'number', min: 0, max: 10, step: 0.0001, default: 0, group: 'Rotor & containment', auto: (c) => { const j = c.upstream('s11')?.J_kgm2 ?? c.upstream('s02')?.rotorInertia_kgm2; return j ? { value: j, prov: 'coupled' } : undefined; } },
    { key: 'tCasing', label: 'Casing wall thickness', unit: 'mm', type: 'number', min: 0.5, max: 30, step: 0.5, default: 3, group: 'Rotor & containment' },
    { key: 'tIns', label: 'Insulation thickness on hot parts', unit: 'mm', type: 'number', min: 0, max: 100, step: 1, default: 10, group: 'Hot surfaces' },
    { key: 'trip', label: 'Trips active in simulation', type: 'bool', default: true, group: 'Trip logic' },
    { key: 'otAlarm', label: 'Overtemperature alarm (above T_hot)', unit: 'K', type: 'number', min: 1, max: 50, step: 1, default: 5, group: 'Trip logic' },
    { key: 'otTrip', label: 'Overtemperature trip (above T_hot)', unit: 'K', type: 'number', min: 2, max: 80, step: 1, default: 10, group: 'Trip logic' },
    { key: 'osTrip', label: 'Overspeed trip', unit: '% of nominal', type: 'number', min: 105, max: 200, step: 1, default: 115, group: 'Trip logic' },
    { key: 'lfTrip', label: 'Low-flow trip', unit: '% of nominal', type: 'number', min: 10, max: 95, step: 1, default: 50, group: 'Trip logic' },
    { key: 'tauSensor', label: 'Temperature sensor time constant', unit: 's', type: 'number', min: 0.1, max: 60, step: 0.1, default: 5, group: 'Trip logic' },
    { key: 'actDelay', label: 'Trip actuation delay', unit: 's', type: 'number', min: 0, max: 30, step: 0.1, default: 2, group: 'Trip logic' },
    { key: 'redundantPump', label: 'Redundant circulation pumps (1-out-of-2)', type: 'bool', default: false, group: 'Reliability' },
    { key: 'hoursYr', label: 'Operating hours per year', unit: 'h', type: 'number', min: 100, max: 8760, step: 10, default: 6000, group: 'Reliability' },
    { key: 'proofTest', label: 'Trip proof-test interval', unit: 'h', type: 'number', min: 100, max: 87600, step: 100, default: 8760, group: 'Reliability' },
    { key: 'occupancy', label: 'Probability a person is exposed when the hazard occurs', type: 'number', min: 0.001, max: 1, step: 0.001, default: 0.1, group: 'Reliability', help: 'Occupancy/exposure factor of the risk graph (laboratory rig behind a guard ≈ 0.1).' },
    { key: 'fTol', label: 'Tolerable frequency of injury', unit: '/yr', type: 'number', min: 1e-7, max: 1e-2, step: 1e-7, default: 1e-4, group: 'Reliability' },
  ],
  presets: [
    { label: 'Laboratory rig (guards, trips, 1 pump)', values: { trip: true, redundantPump: false, tIns: 10 } },
    { label: 'Field unit (redundant pump, thicker insulation)', values: { trip: true, redundantPump: true, tIns: 25, proofTest: 4380 } },
    { label: 'Trips disabled (demonstrate consequences)', values: { trip: false } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const d = ctx.engine, mat = getMat(d.alloy), N = d.nCells;
    const em = engineModel(d, { n: 2, stepsPerCycle: 120, cycles: 3 }), c = em.cell;
    const s13 = ctx.upstream('s13'), s16 = ctx.upstream('s16'), s11 = ctx.upstream('s11'), s06 = ctx.upstream('s06');
    const Th = s06?.ThSupply_C ?? d.Th, TribMax = Math.max(...c.hist.Ts, ...c.hist.Tc), dpBar = (s13?.dpTotal_Pa ?? (em.hydH.dp * 1.5)) / 1e5;
    const pOp = dpBar + 0.5; // static head + pump pressure (estimate)
    const omega0 = s11?.omega_rads ?? em.omega, torque0 = s11?.torqueMean_Nm ?? em.torqueMean, rpm0 = omega0 * 60 / (2 * Math.PI);
    const mb = massBreakdown(d, { mat, s02: ctx.upstream('s02') }), rotorM = mb.mass.rotor, rotorMat = ctx.material('rotor') || getMat('al-7075-t6');
    const J = p.Jrotor > 0 ? p.Jrotor : 0.5 * rotorM * p.Rrotor ** 2;
    const sAllow = (rotorMat.sy ?? 300) * 1e6 / p.SFburst, nu = rotorMat.nu ?? 0.33;
    const omegaMax = Math.sqrt(sAllow * 8 / ((3 + nu) * rotorMat.rho * p.Rrotor ** 2)), rpmMax = omegaMax * 60 / (2 * Math.PI);
    const strainOp = (c.stroke / d.ribbonL + d.sigmaH / (mat.EM * 1e3)) * 100 + 0.5 * mat.epsL * 100 * (1 - c.xiSwing); // contraction swing + elastic + residual detwinned strain
    const nSeal = 4 * N + 4, leakOp = nSeal * 0.01; // estimated weep per static seal (mL/min)
    const env = [
      { k: 'Material temperature', unit: '°C', op: TribMax, lim: p.TmaxMat, note: 'Peak ribbon temperature in the cycle vs alloy/seal maximum' },
      { k: 'Hot-fluid temperature', unit: '°C', op: Th, lim: p.TfluidMax, note: 'Supply temperature vs fluid limit (boiling/degradation margin)' },
      { k: 'Fluid pressure', unit: 'bar(g)', op: pOp, lim: p.pMax / 1.1, note: 'Operating pressure vs relief set-point (design/1.1)' },
      { k: 'Rotor speed', unit: 'rpm', op: rpm0 * p.osTrip / 100, lim: rpmMax, note: `Overspeed trip speed vs burst-limited speed (SF ${p.SFburst})` },
      { k: 'Ribbon extension', unit: '% strain', op: strainOp, lim: p.strainMax, note: 'Peak strain (stroke + elastic + residual) vs maximum extension' },
      { k: 'Casing pressure', unit: 'bar(g)', op: 0.02, lim: p.casingMax, note: 'Vented casing (estimate) vs limit' },
      { k: 'Leak rate', unit: 'mL/min', op: leakOp, lim: p.leakMax, note: `${nSeal} static seals × 0.01 mL/min (estimate)` },
    ].map(e => ({ ...e, U: e.op / e.lim }));
    // ---------------- reliability (RBD) ----------------
    const lifeCyc = s16?.life_cycles ?? fatigueLife(mat, c.stroke / d.ribbonL, d.sigmaH), cycH = d.freq * 3600, lifeH = lifeCyc / cycH;
    const lamP = 20e-6, rb = [
      { name: `Ribbon bundles (${N}, wear-out life ${fmt(lifeH, 3)} h)`, n: N, lam: 1 / lifeH, src: s16 ? 'coupled (Suite 16)' : 'calc (fatigue law)' },
      { name: p.redundantPump ? 'Circulation pumps (2 × 1oo2 pairs)' : 'Circulation pumps (2)', n: 2, lam: p.redundantPump ? 2 * lamP / 3 : lamP, src: 'estimated' },
      { name: `Phase valves (${2 * N})`, n: 2 * N, lam: 5e-6, src: 'estimated' },
      { name: `One-way clutches (${N})`, n: N, lam: 3e-6, src: 'estimated' },
      { name: 'Bearings (2)', n: 2, lam: 2e-6, src: 'estimated' },
      { name: `Seals (${nSeal})`, n: nSeal, lam: 0.5e-6, src: 'estimated' },
      { name: `Flexures (${N})`, n: N, lam: 1e-6, src: 'estimated' },
      { name: 'Sensors (6)', n: 6, lam: 2e-6, src: 'estimated' },
      { name: 'Controller & safety relays', n: 1, lam: 5e-6, src: 'estimated' },
    ].map(r => ({ ...r, L: r.n * r.lam }));
    const lamSys = rb.reduce((a, r) => a + r.L, 0), mtbf = 1 / lamSys, tR = linspace(0, Math.min(3 * mtbf, 87600), 120);
    // ---------------- FMEA ----------------
    const occFat = Math.max(1, Math.min(10, Math.round(10 - Math.log10(Math.max(1, lifeH / p.hoursYr * 1000))))); // ribbon fracture occurrence from life vs annual hours
    const otMargin = p.TmaxMat - Th, occOT = otMargin > 40 ? 2 : otMargin > 20 ? 3 : otMargin > 10 ? 5 : 7;
    const occOS = rpmMax / Math.max(rpm0, 1) > 10 ? 2 : 4;
    const FM = [
      ['Active ribbon', 'Ribbon fracture (fatigue)', 'Loss of cell work; projectile/whip of ribbon end', 7, occFat, 4, 'Life monitoring from Suite 16, guard over cartridges, replace at inspection interval'],
      ['Active ribbon', 'Functional fatigue (stroke loss, residual strain)', 'Gradual power loss', 4, Math.min(10, occFat + 2), 3, 'Track stroke per cell (LVDT/encoder), re-tension preload'],
      ['Grip', 'Grip slip / pull-out', 'Sudden preload loss, ribbon damage', 6, 4, 4, 'Serrated + bonded grips, preload check at commissioning, proof load 1.5 × σH'],
      ['Thermal', 'Thermal runaway / overtemperature of source', 'Alloy overheated beyond Tmax, seal damage, scald risk', 8, occOT, 3, `Overtemperature trip at T_hot + ${p.otTrip} K, independent high-limit thermostat`],
      ['Hydraulic', 'Phase valve stuck (open/closed)', 'Cell stalls, torque ripple, thermal shorting', 5, 5, 4, 'Valve position feedback, cell torque monitoring (Suite 12)'],
      ['Hydraulic', 'Circulation pump failure', 'Loss of heating/cooling, stall', 5, 4, 2, `Low-flow trip at ${p.lfTrip} %${p.redundantPump ? ', redundant pump' : ''}`],
      ['Hydraulic', 'Seal leak (hot fluid)', 'Scalding, slip hazard, fluid loss', 7, 4, 4, 'Leak tray + level sensor, EPDM seals rated > Tmax, pressure decay test'],
      ['Drive', 'Overspeed after load loss', 'Rotor/clutch overload, burst', 9, occOS, 3, `Overspeed trip at ${p.osTrip} %, brake, burst SF ${p.SFburst}`],
      ['Drive', 'One-way clutch failure (slip or lock)', 'Reset work fed back to the shaft, net work loss', 5, 4, 5, 'Clutch inspection interval, torque signature monitoring'],
      ['Controls', 'Temperature/flow sensor drift', 'Trip set-points ineffective', 7, 4, 6, 'Annual recalibration, 2-out-of-3 voting on hot-side temperature'],
      ['Structure', 'Corrosion / galvanic attack (Cu/NiTi/Al in water)', 'Leaks, contact degradation', 5, 4, 5, 'Inhibited fluid, compatible material pairs, water chemistry log'],
      ['Personnel', 'Contact with hot surfaces / scalding fluid', 'Burn injury', 8, Th > 55 ? 5 : 3, 3, `Insulation ${p.tIns} mm, guards, warning labels, PPE`],
      ['Personnel', 'Pressure release on disassembly', 'Spray of hot fluid', 7, 3, 3, 'Lock-out/tag-out, depressurise and cool-down procedure'],
      ['Thermal', 'Repeated uncontrolled thermal shock', 'Accelerated fatigue, cracking of plates/bonds', 5, 3, 5, 'Ramp-rate limiter on valve switching at start-up (spec §37)'],
    ].map(r => ({ comp: r[0], mode: r[1], effect: r[2], S: r[3], O: r[4], D: r[5], action: r[6], rpn: r[3] * r[4] * r[5] }));
    const topRisks = FM.slice().sort((a, b) => b.rpn - a.rpn).slice(0, 5).map(f => ({ mode: f.mode, rpn: f.rpn, S: f.S, O: f.O, D: f.D, action: f.action }));
    // ---------------- fault tree (per year, hypothetical basic events) ----------------
    const BE = {
      leak: { name: 'Hot-fluid leak at accessible joint', p: 0.05 }, exposed: { name: 'Person within reach during leak', p: 0.1 }, noGuard: { name: 'Guard/leak tray absent or removed', p: 0.1 },
      ctrlFail: { name: 'Heater control fails high', p: 0.05 }, otTripFail: { name: 'Overtemperature trip fails on demand', p: 0 },
      loadLoss: { name: 'Sudden loss of shaft load', p: 0.2 }, osTripFail: { name: 'Overspeed trip/brake fails on demand', p: 0 },
      overP: { name: 'Blocked outlet / overpressure', p: 0.02 }, reliefFail: { name: 'Relief valve fails to open', p: 0.01 },
      ribFrac: { name: 'Ribbon fracture in service', p: Math.min(0.95, p.hoursYr / Math.max(lifeH, 1)) }, contFail: { name: 'Cartridge guard fails to contain ribbon end', p: 0.01 },
    };
    const pfdOf = (lamDU) => Math.min(1, lamDU * p.proofTest / 2);
    const lamTrip = (2e-6 + 1e-6 + 3e-6) * 0.5; // sensor + logic + final element, 50 % dangerous undetected
    const pfdAch = p.trip ? pfdOf(lamTrip) : 1;
    BE.otTripFail.p = pfdAch; BE.osTripFail.p = pfdAch;
    const top = (P) => { const g1 = AND([P.leak, P.exposed, P.noGuard]), g2 = AND([P.ctrlFail, P.otTripFail]), g3 = OR([AND([P.loadLoss, P.osTripFail]) * (rpmMax / Math.max(rpm0, 1) < 4 ? 1 : 0.01), AND([P.overP, P.reliefFail])]), g4 = AND([P.ribFrac, P.contFail]); return { top: OR([g1, g2, g3, g4]), g1, g2, g3, g4 }; };
    const base = Object.fromEntries(Object.entries(BE).map(([k, v]) => [k, v.p])), FT = top(base);
    const imp = Object.keys(BE).map(k => { const hi = top({ ...base, [k]: 1 }).top, lo = top({ ...base, [k]: 0 }).top, IB = hi - lo; return { k, name: BE[k].name, p: base[k], IB, FV: FT.top > 0 ? base[k] * IB / FT.top : 0 }; }).sort((a, b) => b.FV - a.FV);
    // enumeration check of the gate algebra on a 4-event sub-tree
    const sub = ['ctrlFail', 'otTripFail', 'overP', 'reliefFail']; let pEnum = 0;
    for (let m = 0; m < 16; m++) { let pr = 1; const st = {}; sub.forEach((k, i) => { const on = (m >> i) & 1; st[k] = on; pr *= on ? base[k] : 1 - base[k]; }); if ((st.ctrlFail && st.otTripFail) || (st.overP && st.reliefFail)) pEnum += pr; }
    const pAlg = OR([AND([base.ctrlFail, base.otTripFail]), AND([base.overP, base.reliefFail])]);
    // SIL: demand on the trip = initiating events per year (unmitigated hazard frequency)
    const fDemand = base.ctrlFail + base.loadLoss * (rpmMax / Math.max(rpm0, 1) < 4 ? 1 : 0.01), fHarm = fDemand * p.occupancy, RRF = fHarm / p.fTol;
    const silOf = (rrf) => (rrf <= 10 ? 0 : rrf <= 100 ? 1 : rrf <= 1000 ? 2 : rrf <= 1e4 ? 3 : 4);
    const silReq = silOf(RRF), silAch = p.trip ? (pfdAch < 1e-4 ? 4 : pfdAch < 1e-3 ? 3 : pfdAch < 1e-2 ? 2 : pfdAch < 1e-1 ? 1 : 0) : 0;
    // ---------------- trip simulations ----------------
    const dt = 0.05, tEnd = 300, tF = 60, nT = Math.round(tEnd / dt), ts = range(nT + 1).map(i => i * dt);
    const fh = { rho: 980, cp: 4190 }, Vloop = 0.004 + N * 2e-4, C = fh.rho * Vloop * fh.cp, Qh = em.QhotTot, UA = 0.05 * Qh / Math.max(1, Th - d.T0);
    const simOT = (trip) => { let T = Th, Ts = Th, heatOn = true, tTrip = null, tAl = null; const TT = [], TS = []; const Tal = Th + p.otAlarm, Ttr = Th + p.otTrip; for (const t of ts) { const Qheat = !heatOn ? 0 : t < tF ? Qh + UA * (Th - d.T0) : 2.5 * Qh + UA * (Th - d.T0); T += dt * (Qheat - UA * (T - d.T0) - (t >= tF && tTrip === null ? Qh : heatOn ? Qh : Qh * Math.max(0, (T - d.Tc) / Math.max(1, Th - d.Tc)))) / C; Ts += dt * (T - Ts) / p.tauSensor; if (tAl === null && Ts > Tal) tAl = t; if (trip && tTrip === null && Ts > Ttr) tTrip = t; if (tTrip !== null && t > tTrip + p.actDelay) heatOn = false; TT.push(T); TS.push(Ts); } return { T: TT, Ts: TS, tTrip, tAl, peak: Math.max(...TT), Tal, Ttr }; };
    const tauE = 2, wFree = 4 * Math.max(omega0, 0.5), tau0 = Math.max(torque0, 0.05), wTr = omega0 * p.osTrip / 100;
    const simOS = (trip) => { let w = omega0, tTrip = null, brake = 0, drive = 1; const W = []; for (const t of ts) { const load = t < tF ? tau0 * (1 - omega0 / wFree) : 0; if (trip && tTrip === null && w > wTr) tTrip = t; if (tTrip !== null && t > tTrip + 0.2) { brake = 5 * tau0; drive = Math.max(0, drive - dt / tauE); } const k = dt / J; w = Math.max(0, (w + k * (drive * tau0 - load - brake * (w > 0 ? 1 : 0))) / (1 + k * (drive * tau0 / wFree + 0.002))); /* linear torque–speed slope and friction implicit (stiff for small J) */ W.push(w * 60 / (2 * Math.PI)); } return { rpm: W, tTrip, peak: Math.max(...W) }; };
    const mdot0 = em.mdotC, tauP = 3, dTn = d.fluidDT;
    const Cc = fh.rho * (0.002 + N * 1e-4) * fh.cp; // water inventory of the cold channels and local pipework
    const simLF = (trip) => { let tTrip = null, run = 1, To = d.Tc + em.QrejTot / Math.max(mdot0 * fh.cp, 1e-6); const M = [], TO = []; let low = 0; for (const t of ts) { const m = t < tF ? mdot0 : mdot0 * Math.exp(-(t - tF) / tauP); if (m < mdot0 * p.lfTrip / 100) low += dt; else low = 0; if (trip && tTrip === null && low > 1) tTrip = t; if (tTrip !== null && t > tTrip + p.actDelay) run = Math.max(0, run - dt / 5); const Qr = em.QrejTot * run * Math.max(0, (Th - To) / Math.max(1, Th - d.Tc)); To = Math.min(Th, To + dt * (Qr - m * fh.cp * (To - d.Tc)) / Cc); TO.push(To); M.push(m / mdot0 * 100); } return { flow: M, Tout: TO, tTrip, peak: Math.max(...TO) }; };
    const A1 = simOT(p.trip), A0 = simOT(false), B1 = simOS(p.trip), B0 = simOS(false), C1 = simLF(p.trip), C0 = simLF(false);
    const ToutLim = d.Tc + 2 * dTn;
    const trips = [
      { name: 'Overtemperature (heater control stuck high)', threshold: A1.Ttr, unit: '°C', alarm_s: A1.tAl !== null ? A1.tAl - tF : null, tTrip_s: A1.tTrip !== null ? A1.tTrip - tF : null, response_s: A1.tTrip !== null ? A1.tTrip - tF + p.actDelay : null, peak: A1.peak, peakNoTrip: A0.peak, limit: Math.min(p.TmaxMat, p.TfluidMax + 10), pass: A1.peak < Math.min(p.TmaxMat, p.TfluidMax + 10) },
      { name: 'Overspeed (load loss)', threshold: wTr * 60 / (2 * Math.PI), unit: 'rpm', alarm_s: null, tTrip_s: B1.tTrip !== null ? B1.tTrip - tF : null, response_s: B1.tTrip !== null ? B1.tTrip - tF + 0.2 : null, peak: B1.peak, peakNoTrip: B0.peak, limit: rpmMax, pass: B1.peak < rpmMax },
      { name: 'Low flow (cold-circuit pump failure)', threshold: p.lfTrip, unit: '% flow', alarm_s: null, tTrip_s: C1.tTrip !== null ? C1.tTrip - tF : null, response_s: C1.tTrip !== null ? C1.tTrip - tF + p.actDelay : null, peak: C1.peak, peakNoTrip: C0.peak, limit: ToutLim, pass: C1.peak < ToutLim },
    ];
    // ---------------- burst containment & hot surfaces ----------------
    const wTripMax = Math.max(B1.peak, wTr * 60 / (2 * Math.PI)) * 2 * Math.PI / 60, KEtrip = 0.5 * J * wTripMax ** 2, KEfree = 0.5 * J * wFree ** 2, KEburst = 0.5 * J * omegaMax ** 2 * p.SFburst; // stored energy at actual burst speed ≈ SF·allowable
    const casMat = ctx.material('casing') || getMat('al-6061-t6'), Rc = p.Rrotor + 0.02, hRing = Math.max(0.01, p.Rrotor * 0.25), Vring = 2 * Math.PI * Rc * hRing * p.tCasing / 1000;
    const Eabs = 0.3 * (casMat.su ?? 300) * 1e6 * 0.1 * Vring;
    const kIns = (ctx.material('insulation') || getMat('aerogel')).k, Ro = 1 / 10, Rins = p.tIns / 1000 / kIns, Ts = d.T0 + (Th - d.T0) * Ro / (Rins + Ro);
    const tBurn = tAllow(BURN_METAL, Ts), tScald = tAllow(SCALD_WATER, Th);
    // ---------------- KPIs ----------------
    const worst = env.reduce((a, e) => (e.U > a.U ? e : a));
    const allTrips = trips.every(t => t.pass);
    out.headline = `Envelope: worst utilisation ${fmt(worst.U * 100, 3)} % (${worst.k}); MTBF ≈ ${fmt(mtbf, 3)} h; top-event probability ${fmt(FT.top, 3)}/yr; required SIL ${silReq}, trip channel achieves SIL ${silAch}; ${allTrips ? 'all injected faults tripped safely' : 'at least one injected fault exceeds its limit'}.`;
    out.headlineKind = worst.U < 1 && allTrips && silAch >= silReq ? 'ok' : 'warn';
    out.kpis.push({ label: 'Worst envelope utilisation', value: worst.U * 100, unit: '%', prov: 'calc', explain: `Largest ratio of operating value to its limit across the ${env.length} envelope quantities (${worst.k}: ${fmt(worst.op, 3)} vs ${fmt(worst.lim, 3)} ${worst.unit}). Below 100 % = inside the safe operating envelope.`, status: worst.U < 0.9 ? 'ok' : worst.U < 1 ? 'warn' : 'bad' });
    out.kpis.push({ label: 'System MTBF (series RBD)', value: mtbf, unit: 'h', prov: 'estimated', explain: `1/Σλ over ${rb.length} blocks with estimated failure rates; ribbon wear-out contributes ${fmt(rb[0].L / lamSys * 100, 3)} % of λ. ≈ ${fmt(mtbf / p.hoursYr, 3)} years at ${p.hoursYr} h/yr.`, status: mtbf > 2000 ? 'ok' : 'warn' });
    out.kpis.push({ label: 'Top-event probability (injury/damage)', value: FT.top, unit: '/yr', prov: 'hypothetical', explain: 'Fault-tree OR of scald, uncontrolled overtemperature, burst/overpressure and ribbon-projectile branches with order-of-magnitude basic-event probabilities.', status: FT.top < p.fTol ? 'ok' : 'warn' });
    out.kpis.push({ label: 'Required SIL / achieved', value: `${silReq} / ${silAch}`, unit: '', prov: 'estimated', explain: `Demand rate ${fmt(fDemand, 3)}/yr × exposure ${p.occupancy} vs tolerable ${p.fTol}/yr → risk reduction ${fmt(RRF, 3)} → SIL ${silReq}. Trip channel PFD_avg ${fmt(pfdAch, 3)} (proof test every ${p.proofTest} h) → SIL ${silAch}.`, status: silAch >= silReq ? 'ok' : 'bad' });
    out.kpis.push({ label: 'Highest RPN', value: topRisks[0].rpn, unit: '', prov: 'estimated', explain: `${topRisks[0].mode} (S ${topRisks[0].S} × O ${topRisks[0].O} × D ${topRisks[0].D}). Action: ${topRisks[0].action}.`, status: topRisks[0].rpn < 150 ? 'ok' : 'warn' });
    out.kpis.push({ label: 'Overtemperature peak with trip', value: A1.peak, unit: '°C', prov: 'calc', explain: `Hot-loop peak after the heater control fails high at t = 60 s; without the trip it reaches ${fmt(A0.peak, 3)} °C in 240 s. Limit ${fmt(trips[0].limit, 3)} °C.`, status: trips[0].pass ? 'ok' : 'bad' });
    out.kpis.push({ label: 'Rotor burst speed margin', value: rpmMax / Math.max(rpm0, 1e-6), unit: '× nominal', prov: 'calc', explain: `Burst-limited speed ${fmt(rpmMax, 4)} rpm (σ_y/SF of ${rotorMat.name}, R = ${p.Rrotor} m) vs nominal ${fmt(rpm0, 3)} rpm. Free-run speed of the engine ≈ ${fmt(wFree * 60 / (2 * Math.PI), 3)} rpm.`, status: rpmMax > wFree * 60 / (2 * Math.PI) ? 'ok' : 'warn' });
    out.kpis.push({ label: 'Insulated surface temperature', value: Ts, unit: '°C', prov: 'calc', explain: `With ${p.tIns} mm insulation (k = ${kIns} W/mK) and h_o = 10 W/m²K. Approximate bare-metal burn threshold time at this temperature: ${Number.isFinite(tBurn) ? fmt(tBurn, 3) + ' s' : 'no burn for indefinite contact'}; hot fluid at ${fmt(Th, 3)} °C scalds in ≈ ${Number.isFinite(tScald) ? fmt(tScald, 3) + ' s' : 'no scald threshold reached'}.`, status: Ts < 48 ? 'ok' : 'warn' });
    // ---------------- verdicts ----------------
    for (const e of env) if (e.U >= 0.9) out.verdicts.push({ test: `Envelope: ${e.k}`, status: e.U < 1 ? 'warn' : 'fail', detail: `${fmt(e.op, 3)} ${e.unit} vs limit ${fmt(e.lim, 3)} (${fmt(e.U * 100, 3)} %). ${e.note}.`, fix: e.k === 'Ribbon extension' ? 'Lower σH or the stroke, or add a mechanical end stop on extension.' : e.k === 'Material temperature' ? 'Lower the source temperature or choose an alloy/seal with higher Tmax.' : 'Raise the rating of the part or reduce the operating value.' });
    out.verdicts.push({ test: 'Operating point inside the safe envelope', status: worst.U < 1 ? 'pass' : 'fail', detail: env.map(e => `${e.k} ${fmt(e.U * 100, 3)} %`).join('; '), fix: 'Reduce the variable with the highest utilisation (chart) or raise its rating.' });
    for (const t of trips) out.verdicts.push({ test: `Fault injection: ${t.name}`, status: t.pass ? 'pass' : 'fail', detail: `Peak ${fmt(t.peak, 4)} ${t.unit === '% flow' ? '°C cold outlet' : t.unit} with trip (limit ${fmt(t.limit, 4)}); without trip ${fmt(t.peakNoTrip, 4)}. Trip ${t.tTrip_s !== null ? fmt(t.tTrip_s, 3) + ' s after the fault' : 'did not act'}.${t.unit === 'rpm' && t.peakNoTrip < t.limit ? ` Free-run speed is below the burst limit, so overspeed is inherently bounded${t.peak > 0.95 * t.peakNoTrip ? ' (the light rotor reaches free-run faster than the brake acts — add flywheel inertia if a controlled stop is needed)' : ''}.` : ''}`, fix: t.pass ? '' : 'Lower the trip set-point, use a faster sensor (smaller τ) or a faster actuator.' });
    out.verdicts.push({ test: 'Safety-integrity level achieved ≥ required', status: silAch >= silReq ? 'pass' : 'fail', detail: `Required SIL ${silReq} (RRF ${fmt(RRF, 3)}), achieved SIL ${silAch} (PFD ${fmt(pfdAch, 3)}).`, fix: 'Shorten the proof-test interval, add a redundant (1oo2) sensor/brake channel, or reduce demand (independent high-limit thermostat).' });
    out.verdicts.push({ test: 'Rotor burst containment (screening)', status: Eabs > KEburst ? 'pass' : Eabs > KEfree ? 'warn' : 'fail', detail: `Stored energy: ${fmt(KEtrip, 3)} J at trip, ${fmt(KEfree, 3)} J at free-run, ${fmt(KEburst, 3)} J at burst speed; casing ring absorbs ≈ ${fmt(Eabs, 3)} J (${p.tCasing} mm ${casMat.name}).`, fix: 'Thicken the casing ring, add a steel containment band, or limit rotor inertia/speed.' });
    out.verdicts.push({ test: 'Ribbon life adequate for unattended operation (MTBF > 2000 h)', status: mtbf > 2000 ? 'pass' : 'warn', detail: `Ribbon characteristic life ${fmt(lifeCyc, 3)} cycles = ${fmt(lifeH, 3)} h at ${d.freq} Hz (transformation strain ${fmt(c.stroke / d.ribbonL * 100, 3)} %, σH ${d.sigmaH} MPa) dominates the system MTBF of ${fmt(mtbf, 3)} h.`, fix: 'Reduce the transformation strain toward 1–2 % (life scales ≈ ε⁻³), lower σH, choose a low-fatigue alloy (Suite 03/16) or plan ribbon replacement as a consumable.' });
    out.verdicts.push({ test: 'Failure data are estimates', status: 'info', detail: 'FMEA scores, failure rates and basic-event probabilities are order-of-magnitude engineering estimates (hypothetical).', fix: 'Replace with component data sheets, Suite 16 life results and rig fault-injection records (V5).' });
    // ---------------- checks ----------------
    const ck = (name, pass, value, target, detail) => out.checks.push({ name, pass, value, target, detail });
    ck('Fault-tree gate algebra = exhaustive enumeration (sub-tree)', Math.abs(pEnum - pAlg) < 1e-12, pEnum, fmt(pAlg, 6));
    ck('R(MTBF) = e⁻¹', Math.abs(Math.exp(-lamSys * mtbf) - Math.exp(-1)) < 1e-12, Math.exp(-lamSys * mtbf), '0.3679');
    ck('Trip never worsens the peak (all scenarios)', trips.every(t => t.peak <= t.peakNoTrip + 1e-9), trips.map(t => fmt(t.peak - t.peakNoTrip, 3)).join(', '), '≤ 0');
    ck('Importance measures bounded (0 ≤ FV ≤ 1)', imp.every(i => i.FV >= -1e-12 && i.FV <= 1 + 1e-9), Math.max(...imp.map(i => i.FV)), '[0, 1]');
    ck('Burst-speed formula round trip', Math.abs((3 + nu) / 8 * rotorMat.rho * omegaMax ** 2 * p.Rrotor ** 2 - sAllow) / sAllow < 1e-9, sAllow / 1e6, 'σ_allow (MPa)');
    // ---------------- charts ----------------
    out.charts.push({ type: 'bar', horizontal: true, title: 'Safe operating envelope — utilisation of each limit', categories: env.map(e => `${e.k} (${fmt(e.op, 3)} / ${fmt(e.lim, 3)} ${e.unit})`), series: [{ name: 'Utilisation (%)', values: env.map(e => e.U * 100) }], wide: true, explain: 'Each bar is the operating value divided by its permitted maximum (spec §37). Bars beyond 100 % are outside the envelope; aim for ≤ 80–90 % to leave margin for transients.' });
    const Tl = linspace(20, Math.max(130, p.TmaxMat + 10), 60);
    out.charts.push({ title: 'Temperature–pressure envelope of the hot circuit', x: { label: 'Fluid temperature', unit: '°C' }, y: { label: 'Pressure', unit: 'bar(g)' }, series: [{ name: 'Water saturation (gauge, 1 atm ref.)', x: Tl, y: Tl.map(T => psatBar(T) - 1.013) }], annotations: [{ type: 'hline', y: p.pMax / 1.1, label: 'Relief set-point' }, { type: 'vline', x: p.TfluidMax, label: 'Fluid T limit' }, { type: 'vline', x: p.TmaxMat, label: 'Material T limit', color: '#ef4444' }, { type: 'point', x: Th, y: pOp, label: 'Operating point' }], explain: 'Safe region: left of the temperature limits, below the relief set-point and above the saturation curve (no boiling at the hot-side pressure). The marker is the design point.' });
    const Sx = range(10).map(i => i + 1), Z = Sx.map(o => Sx.map(s => FM.filter(f => f.S === s && f.O === o).reduce((a, f) => Math.max(a, f.rpn), 0)));
    out.charts.push({ type: 'heatmap', title: 'FMEA risk matrix (max RPN per severity × occurrence cell)', x: { label: 'Severity S', values: Sx }, y: { label: 'Occurrence O', values: Sx }, z: Z, cmap: 'inferno', zlabel: 'RPN', explain: 'Failure modes placed by severity and occurrence; colour is the highest RPN in the cell. Upper-right cells need design action, not only detection.' });
    out.charts.push({ type: 'bar', horizontal: true, title: 'Fault-tree basic-event importance (Fussell–Vesely)', categories: imp.map(i => i.name), series: [{ name: 'FV importance', values: imp.map(i => i.FV) }], explain: `Share of the top-event probability (${fmt(FT.top, 3)}/yr) that involves each basic event. Reducing the top-ranked events lowers risk most.` });
    out.charts.push({ title: 'System reliability R(t) from the block diagram', x: { label: 'Operating time', unit: 'h' }, y: { label: 'Reliability', unit: '' }, series: [{ name: 'R(t) series system', x: tR, y: tR.map(t => Math.exp(-lamSys * t)) }, { name: 'Ribbons only', x: tR, y: tR.map(t => Math.exp(-rb[0].L * t)) }], annotations: [{ type: 'vline', x: mtbf, label: 'MTBF' }], explain: 'Probability of operating without any block failure. The ribbon bundles (wear-out treated as an equivalent constant rate) usually dominate — schedule replacement before their characteristic life.' });
    const sub2 = (a) => a.filter((_, i) => i % 4 === 0), tsS = sub2(ts);
    out.charts.push({ title: 'Fault injection: overtemperature (heater control stuck high at 60 s)', x: { label: 'Time', unit: 's' }, y: { label: 'Temperature', unit: '°C' }, series: [{ name: 'Loop T, trip active', x: tsS, y: sub2(A1.T) }, { name: 'Sensor reading', x: tsS, y: sub2(A1.Ts), dash: true }, { name: 'Loop T, no trip', x: tsS, y: sub2(A0.T), dash: true }], annotations: [{ type: 'hline', y: A1.Tal, label: 'Alarm', color: '#f59e0b' }, { type: 'hline', y: A1.Ttr, label: 'Trip' }, { type: 'hline', y: trips[0].limit, label: 'Limit', color: '#a855f7' }], explain: `The sensor lags the loop by τ = ${p.tauSensor} s; the trip isolates the heat supply ${p.actDelay} s after the set-point is crossed. Compare the no-trip curve to see the consequence.` });
    out.charts.push({ title: 'Fault injection: overspeed after load loss at 60 s', x: { label: 'Time', unit: 's' }, y: { label: 'Speed', unit: 'rpm' }, series: [{ name: 'Speed, trip active', x: tsS, y: sub2(B1.rpm) }, { name: 'Speed, no trip', x: tsS, y: sub2(B0.rpm), dash: true }], annotations: [{ type: 'hline', y: wTr * 60 / (2 * Math.PI), label: 'Trip' }, { type: 'hline', y: Math.min(rpmMax, wFree * 60 / Math.PI), label: rpmMax < wFree * 60 / Math.PI ? 'Burst limit' : '', color: '#a855f7' }], explain: `With the load gone the engine accelerates toward its free-run speed; the trip applies the brake (0.2 s) and isolates the hot flow. J = ${fmt(J, 3)} kg·m².` });
    out.charts.push({ title: 'Fault injection: cold-circuit pump failure at 60 s', x: { label: 'Time', unit: 's' }, y: { label: 'Flow (%) / cold outlet (°C)', unit: '' }, series: [{ name: 'Flow %', x: tsS, y: sub2(C1.flow) }, { name: 'Cold outlet T, trip active', x: tsS, y: sub2(C1.Tout) }, { name: 'Cold outlet T, no trip', x: tsS, y: sub2(C0.Tout), dash: true }], annotations: [{ type: 'hline', y: p.lfTrip, label: 'Low-flow trip %' }, { type: 'hline', y: ToutLim, label: 'Outlet limit °C', color: '#a855f7' }], explain: 'Without cooling flow the rejected heat raises the cold-side temperature until the ribbons can no longer re-transform (stall). The low-flow trip (1 s debounce) brings the engine to a safe stop.' });
    const Tb = linspace(42, 75, 60);
    out.charts.push({ title: 'Hot-surface and scald exposure (approximate thresholds)', x: { label: 'Temperature', unit: '°C' }, y: { label: 'Contact time to burn threshold', unit: 's', log: true }, series: [{ name: 'Bare metal contact', x: Tb, y: Tb.map(T => Math.min(1e5, tAllow(BURN_METAL, T))) }, { name: 'Hot water scald', x: Tb, y: Tb.map(T => Math.min(1e5, tAllow(SCALD_WATER, T))) }], annotations: [{ type: 'vline', x: Ts, label: 'Insulated surface' }, { type: 'vline', x: Th, label: 'Hot fluid', color: '#ef4444' }], explain: 'Approximate contact-burn and scald thresholds from published studies (verify against the applicable standard). Surfaces left of ≈ 43–48 °C are safe for prolonged contact; the hot fluid itself must be guarded.' });
    // ---------------- tables ----------------
    out.tables.push({ title: 'Safe operating envelope (spec §37)', cols: ['Quantity', 'Operating', 'Limit', 'Unit', 'Utilisation', 'Basis'], rows: env.map(e => [e.k, fmt(e.op, 4), fmt(e.lim, 4), e.unit, fmt(e.U * 100, 3) + ' %', e.note]), explain: 'Limits come from the materials library (Tmax), design ratings and user inputs; operating values from the reduced engine model or coupled suites.' });
    out.tables.push({ title: 'FMEA (sorted by RPN)', cols: ['Component', 'Failure mode', 'Effect', 'S', 'O', 'D', 'RPN', 'Mitigation / action'], rows: FM.slice().sort((a, b) => b.rpn - a.rpn).map(f => [f.comp, f.mode, f.effect, f.S, f.O, f.D, f.rpn, f.action]), explain: `Occurrence of ribbon fracture derived from the fatigue life (${fmt(lifeH, 3)} h vs ${p.hoursYr} h/yr), overtemperature from the source-to-Tmax margin (${fmt(otMargin, 3)} K), overspeed from the burst margin; others are estimates.` });
    out.tables.push({ title: 'Fault tree', cols: ['Gate / event', 'Logic', 'Probability /yr'], rows: [['TOP: injury or major damage', 'OR(G1, G2, G3, G4)', fmt(FT.top, 4)], ['G1 scald from leak', 'AND(leak, person exposed, no guard)', fmt(FT.g1, 4)], ['G2 uncontrolled overtemperature', 'AND(control fails high, OT trip fails)', fmt(FT.g2, 4)], ['G3 burst / overpressure', 'OR(AND(load loss, overspeed trip fails), AND(overpressure, relief fails))', fmt(FT.g3, 4)], ['G4 ribbon projectile', 'AND(ribbon fracture, guard fails)', fmt(FT.g4, 4)], ...Object.values(BE).map(b => ['  ' + b.name, 'basic event', fmt(b.p, 3)])], explain: 'Independent basic events with order-of-magnitude probabilities (hypothetical). The overspeed branch is weighted down when the burst margin exceeds 4 × nominal speed.' });
    out.tables.push({ title: 'Reliability block diagram (series)', cols: ['Block', 'Quantity', 'λ per item (1/h)', 'Block λ (1/h)', 'Share', 'Source'], rows: rb.map(r => [r.name, r.n, fmt(r.lam, 3), fmt(r.L, 3), fmt(r.L / lamSys * 100, 3) + ' %', r.src]), explain: `λ_sys = ${fmt(lamSys, 3)} /h, MTBF ${fmt(mtbf, 4)} h.` });
    out.tables.push({ title: 'Trip logic and fault-injection results', cols: ['Scenario', 'Set-point', 'Alarm after fault', 'Trip after fault', 'Response', 'Peak (trip)', 'Peak (no trip)', 'Limit', 'Result'], rows: trips.map(t => [t.name, fmt(t.threshold, 4) + ' ' + t.unit, t.alarm_s !== null ? fmt(t.alarm_s, 3) + ' s' : '—', t.tTrip_s !== null ? fmt(t.tTrip_s, 3) + ' s' : 'no trip', t.response_s !== null ? fmt(t.response_s, 3) + ' s' : '—', fmt(t.peak, 4), fmt(t.peakNoTrip, 4), fmt(t.limit, 4), t.pass ? 'safe' : 'LIMIT EXCEEDED']), explain: 'Watchdog validation by fault injection (spec Module 21). Each trip must keep the peak below the limit; the no-trip column shows the consequence that the trip prevents.' });
    out.tables.push({ title: 'Maintenance & service intervals (spec §37)', cols: ['Task', 'Interval', 'Basis'], rows: [['Ribbon replacement', `${fmt(lifeH * 0.5, 3)} h (50 % of characteristic life)`, 'Fatigue life with 2× factor'], ['Fluid cleaning / inhibitor check', '2000 h', 'Corrosion & fouling control'], ['Thermal contact rework (interface sheets)', '4000 h', 'Contact conductance drift (Suite 19 twin bias)'], ['Clutch inspection', '2000 h', 'FMEA clutch failure'], ['Sensor recalibration & trip proof test', `${p.proofTest} h`, 'SIL / PFD calculation'], ['Relief-valve test', '8760 h', 'Overpressure branch of the fault tree']], explain: 'Predictable service intervals for the wear items named in spec §37.' });
    // ---------------- explain & recs ----------------
    out.explain.push({ title: 'What was assessed', text: `The design point (T_hot ${Th} °C, ${fmt(rpm0, 3)} rpm, ${fmt(pOp, 3)} bar) was placed in the spec §37 envelope; ${FM.length} failure modes were scored; a 4-branch fault tree and a ${rb.length}-block RBD were evaluated; and three faults were injected into lumped models of the hot loop, rotor and cold circuit with and without trips.` });
    out.explain.push({ title: 'Reading the trip simulations', text: `Overtemperature: trip ${trips[0].tTrip_s !== null ? fmt(trips[0].tTrip_s, 3) + ' s' : 'not reached'} after the fault, peak ${fmt(A1.peak, 3)} °C (${fmt(A0.peak, 3)} °C without). Overspeed: peak ${fmt(B1.peak, 3)} rpm (${fmt(B0.peak, 3)} without). Low flow: cold outlet ${fmt(C1.peak, 3)} °C (${fmt(C0.peak, 3)} without).` });
    out.recs.push({ level: silAch >= silReq ? 'good' : 'critical', text: silAch >= silReq ? `Trip channel (PFD ${fmt(pfdAch, 3)}) meets the required SIL ${silReq}; keep the ${p.proofTest} h proof test.` : `Trip channel achieves SIL ${silAch} but SIL ${silReq} is required: add an independent high-limit thermostat and a 1oo2 overspeed sensor or halve the proof-test interval.`, basis: `RRF ${fmt(RRF, 3)}` });
    out.recs.push({ level: worst.U > 0.9 ? 'warn' : 'info', text: `Highest envelope utilisation: ${worst.k} at ${fmt(worst.U * 100, 3)} %. ${worst.U > 0.9 ? 'Restore margin before testing at this point.' : 'Margin adequate for transients.'}`, basis: 'Envelope table' });
    out.recs.push({ level: 'warn', text: `Top risk: ${topRisks[0].mode} (RPN ${topRisks[0].rpn}). ${topRisks[0].action}.`, basis: 'FMEA' });
    out.recs.push({ level: Ts > 48 ? 'warn' : 'good', text: Ts > 48 ? `Insulated surfaces reach ${fmt(Ts, 3)} °C: increase insulation beyond ${p.tIns} mm or add guards; hot fluid at ${Th} °C scalds within ≈ ${fmt(tScald, 3)} s.` : `Surfaces at ${fmt(Ts, 3)} °C are below the prolonged-contact burn threshold; still guard hot-fluid joints (scald in ≈ ${fmt(tScald, 3)} s).`, basis: 'Approximate burn thresholds' });
    out.recs.push({ level: 'econ', text: `Ribbon wear-out dominates λ (${fmt(rb[0].L / lamSys * 100, 3)} %); planned replacement every ${fmt(lifeH * 0.5, 3)} h is cheaper than unplanned downtime — feed this interval to Suite 22 maintenance costs.`, basis: 'RBD' });
    out.recs.push({ level: 'sustain', text: 'Use an inhibited, non-toxic water circuit and a leak tray so that leaks are contained and fluid can be recovered; avoid glycol where the source is below 90 °C.', basis: 'FMEA seal leak / corrosion' });
    // ---------------- view ----------------
    out.views.push({ label: '2D animation: watchdog fault injection', icon: '🎞', render: (el) => anim2d(el, { duration: tEnd, label: 'Time', unit: 's', height: 460, explain: 'Three injected faults at t = 60 s (independent runs). Dashed red lines are trip set-points.', draw: (g, t, W, H) => { const th = theme(), h3 = (H - 30) / 3; text(g, p.trip ? 'Trips ACTIVE' : 'Trips DISABLED', 10, 16, p.trip ? '#22c55e' : '#ef4444'); seriesPanel(g, { x: 8, y: 24, w: W - 16, h: h3 - 6, T: ts, series: [{ name: 'loop T', y: A1.T, color: '#f97316' }, { name: 'sensor', y: A1.Ts, color: '#94a3b8' }], t, title: 'Overtemperature', unit: '°C', hlines: [{ y: A1.Ttr, label: 'trip' }] }); seriesPanel(g, { x: 8, y: 24 + h3, w: W - 16, h: h3 - 6, T: ts, series: [{ name: 'speed', y: B1.rpm, color: '#38bdf8' }], t, title: 'Overspeed', unit: 'rpm', hlines: [{ y: wTr * 60 / (2 * Math.PI), label: 'trip' }] }); seriesPanel(g, { x: 8, y: 24 + 2 * h3, w: W - 16, h: h3 - 6, T: ts, series: [{ name: 'flow %', y: C1.flow, color: '#22c55e' }], t, title: 'Low flow', unit: '%', hlines: [{ y: p.lfTrip, label: 'trip' }] }); void th; } }) });
    out.outputs = { envelope: Object.fromEntries(env.map(e => [e.k, { op: e.op, limit: e.lim, unit: e.unit, utilisation: e.U }])), topRisks, sil: silReq, silAchieved: silAch, mtbf_h: mtbf, trips, pTop_yr: FT.top, rpmMax, ribbonLife_h: lifeH, ribbonReplace_h: lifeH * 0.5, surfaceT_C: Ts };
    return out;
  },
};
