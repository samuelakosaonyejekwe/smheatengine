// Suite 15 — Startup, shutdown and off-design dynamics.
// From rest with cold, pre-extended ribbons: first-order warm-up of the hot/cold circuits, heating of selected start
// cells, breakaway against static friction and load, acceleration J dω/dt = τ_drive − τ_load − τ_friction − τ_internal,
// phase sequencing, steady running, controlled shutdown (heat isolation, residual-heat removal, deceleration, parking)
// and the energy needed to re-preload the ribbons for the next start (never assumed free).
import { linspace, range, mean, clamp, fmt, brent } from '../core/num.js';
import { get as getMat } from '../core/materials.js';
import { cellDrive, scaleDrive, ribbonStiffness, driveLookup, simulateShaft, constantSpeedCell, designGear, effRadius, drawRotor, rotorFit, pause } from './s11-shaft.js';

const TAU = 2 * Math.PI, f3 = (v) => fmt(v, 3), f4 = (v) => fmt(v, 4);

export default {
  description: 'Simulates the complete operating envelope from a cold, pre-extended engine at rest: hot/cold circuit warm-up, heating of the start cells, breakaway against static friction and load, acceleration to steady speed, controlled shutdown with residual-heat removal and parking, and restart. Maps the stall envelope over source temperature and load and accounts for the energy needed to re-preload the ribbons — it is never assumed free.',
  literature: 'shape memory alloy heat engine start-up self-starting stall torque shutdown transient dynamics',
  econ: true, sustain: true, credibility: 'Analytical screening',
  equations: [
    'Hot / cold circuits (first-order lags): T_h(t) = T_H − (T_H − T₀)e^{−t/τ_h},  T_c(t) = T_C + (T₀ − T_C)e^{−t/τ_c}',
    'Start condition: start cells heated once T_h ≥ A_s(σ_H) + ΔT_ready,  A_s(σ) = A_s + σ/C_A (Clausius–Clapeyron); full stroke needs T_h ≥ A_f(σ_H)',
    'Breakaway: Σ_start τᵢ − τ_load(0) > τ_static;  static start torque τ_st(T) = n_start·F_blk(T)·R·η',
    'Shaft: J dω/dt = Σᵢ τᵢ − τ_load(ω) − τ_C·tanh(ω/ω_ε) − c_v ω − n_idle·τ_drag  (one-way coupling, anti-reverse backstop)',
    'Cell drive at circuit temperature T: quasi-steady cycle drive interpolated between transient-cell solutions at bracketing source temperatures',
    'Reset readiness: stroke factor f_c = clip((M_s(σ_L) − T_c)/(M_s(σ_L) − M_f(σ_L)), 0, 1)',
    'Residual heat at shutdown: Q_res = N·[(m c_p + C_w A_face)(T̄_cell − T_C) + m L_h ξ_A]',
    'Cell cool-down after isolation: T(t) = T_C + (T_max − T_C)e^{−t/τ_cool}; safe when T < M_f(σ_park) and ω < 1 % ω_ss',
    'Re-preload energy (relaxed parking): E_pre = N·(W_reset + ½F_b δ_b); source must be named (flywheel KE·η, spring reserve, manual or motor)',
    'Overspeed on load rejection: free-running speed where τ̄_drive(ω) = τ_friction(ω) ≤ ω_limit',
  ],
  methods: [
    'Transient ribbon-cell solver (sma.cellFromDesign) at 5–8 source temperatures → periodic drive tables (force capacity, free contraction)',
    'Suite 11 shaft integrator (num.rk4, frozen carriage states per step, stiction/backstop events) over the whole timeline with a clock-driven valve schedule',
    'Quasi-steady constant-speed cycle averages for the stall envelope (source temperature × load) and the free-running overspeed',
    'Root finding (num.brent) for the self-start threshold temperature',
    'Step-halving study of breakaway and time-to-steady-speed; energy balance of the complete transient',
  ],
  assumptions: [
    'Each cell follows the quasi-steady periodic cycle of the instantaneous hot-circuit temperature (circuit lag ≫ cycle period); first-stroke transients of the ribbon are not resolved',
    'Start cells are heated together; the remaining cells join the clock-driven schedule at their next slot once the shaft turns',
    'Static start force is the load-carrying force of the transient cell (conservative: the blocked recovery force can be higher)',
    'Cell cool-down after isolation is a single exponential fitted to the cold-phase temperature of the transient cell',
    'Pumps, valves and controls are powered from an external supply during start-up (their energy is reported in Suites 13 and 18)',
  ],
  ibc: {
    initial: ['Shaft at rest; ribbons cold (T = T₀), fully martensitic and pre-extended at the bias stress (or relaxed, per parking mode)', 'Hot and cold circuits at ambient T₀; flywheel unloaded'],
    boundary: ['Hot-source and cold-sink supply temperatures (engine design)', 'Load torque–speed law from Suite 11 (connected at start unless clutched)', 'Static and running friction from Suite 11', 'Shutdown command at the end of the run window'],
  },
  cvv: {
    calibration: ['Circuit warm-up time constants from loop temperature logs', 'Static friction (breakaway torque) and drag from torque-wrench and coast-down tests'],
    verification: ['Energy balance over the complete start–run–stop transient', 'Breakaway and time-to-speed insensitive to step halving', 'Dynamic breakaway consistent with the static start criterion', 'Shaft comes to rest after shutdown with the kinetic energy fully dissipated'],
    validation: ['Cold-start and thermal-ramp hardware tests; stall and restart tests at reduced source temperature (spec Module 15)'],
  },
  formats: { import: ['CSV start-up logs (t, T_hot, T_cold, ω, τ)', 'CSV breakaway torque measurements'], export: ['CSV start-up/shutdown histories', 'CSV stall envelope', 'PNG/SVG plots', 'JSON operating thresholds'] },
  params: [
    { key: 'nCells', label: 'Number of cells', type: 'number', min: 1, max: 96, step: 1, default: 12, group: 'Engine', auto: (c) => { const o = c.upstream('s12'); return o?.nCells ? { value: o.nCells, prov: 'coupled' } : { value: c.engine.nCells, prov: 'calc' }; } },
    { key: 'Th', label: 'Hot-source supply temperature', unit: '°C', type: 'number', min: 20, max: 250, step: 0.5, default: 70, group: 'Thermal', auto: (c) => { const o = c.upstream('s06'); return o?.ThSupply_C ? { value: o.ThSupply_C, prov: 'coupled' } : { value: c.engine.Th, prov: 'calc' }; } },
    { key: 'Tc', label: 'Cold-sink supply temperature', unit: '°C', type: 'number', min: -20, max: 60, step: 0.5, default: 15, group: 'Thermal', auto: (c) => { const o = c.upstream('s07'); return o?.TcSupply_C !== undefined ? { value: o.TcSupply_C, prov: 'coupled' } : { value: c.engine.Tc, prov: 'calc' }; } },
    { key: 'T0', label: 'Initial (ambient) temperature', unit: '°C', type: 'number', min: -30, max: 50, step: 0.5, default: 20, group: 'Thermal', auto: (c) => ({ value: c.engine.T0, prov: 'calc' }) },
    { key: 'tauHot', label: 'Hot-circuit warm-up time constant', unit: 's', type: 'number', min: 1, max: 3600, step: 1, default: 30, group: 'Thermal' },
    { key: 'tauCold', label: 'Cold-circuit settling time constant', unit: 's', type: 'number', min: 1, max: 3600, step: 1, default: 20, group: 'Thermal' },
    { key: 'readyMargin', label: 'Start margin above A_s(σ_H)', unit: 'K', type: 'number', min: 0, max: 30, step: 0.5, default: 3, group: 'Start-up' },
    { key: 'nStart', label: 'Start cells heated together', type: 'number', min: 1, max: 96, step: 1, default: 3, group: 'Start-up', auto: (c) => ({ value: Math.max(1, Math.ceil(c.engine.nCells / 4)), prov: 'calc' }) },
    { key: 'seqRpm', label: 'Speed at which full phase sequencing begins', unit: 'rpm', type: 'number', min: 0.1, max: 100, step: 0.1, default: 2, group: 'Start-up' },
    { key: 'tRun', label: 'Run window from start-cell heating to shutdown (0 = 3 τ_h + 20 s)', unit: 's', type: 'number', min: 0, max: 1200, step: 1, default: 0, group: 'Start-up' },
    { key: 'J', label: 'Total shaft inertia', unit: 'kg·m²', type: 'number', min: 1e-4, max: 50, step: 0.001, default: 0.52, group: 'Shaft', auto: (c) => { const o = c.upstream('s11'); return o?.J_kgm2 > 0 ? { value: +o.J_kgm2.toPrecision(4), prov: 'coupled' } : undefined; } },
    { key: 'Reff', label: 'Effective coupling radius R', unit: 'mm', type: 'number', min: 0, max: 200, step: 0.001, default: 0, group: 'Shaft', auto: (c) => { const o = c.upstream('s11'); return o?.effRadius_m > 0 ? { value: +(o.effRadius_m * 1000).toPrecision(5), prov: 'coupled' } : undefined; }, help: '0 = derived from the design speed as in Suite 11.' },
    { key: 'eta', label: 'Coupling efficiency', type: 'range', min: 0.5, max: 1, step: 0.005, default: 0.95, group: 'Shaft' },
    { key: 'tauC', label: 'Running (Coulomb) friction torque', unit: 'N·m', type: 'number', min: 0, max: 10, step: 0.001, default: 0.08, group: 'Shaft', auto: (c) => { const o = c.upstream('s11'); return o?.tauC_Nm >= 0 ? { value: o.tauC_Nm, prov: 'coupled' } : { value: +(c.engine.bearingLoss / Math.max(1e-6, c.engine.rpm * TAU / 60)).toPrecision(3), prov: 'calc' }; } },
    { key: 'staticFactor', label: 'Static / running friction ratio', type: 'number', min: 1, max: 5, step: 0.1, default: 1.5, group: 'Shaft' },
    { key: 'cVisc', label: 'Viscous friction', unit: 'N·m·s/rad', type: 'number', min: 0, max: 1, step: 0.0005, default: 0.002, group: 'Shaft' },
    { key: 'tauDrag', label: 'Overrunning-clutch drag (each)', unit: 'N·m', type: 'number', min: 0, max: 0.2, step: 0.001, default: 0.004, group: 'Shaft' },
    { key: 'loadType', label: 'Load law', type: 'select', options: [{ value: 'quadratic', label: 'Quadratic (pump / fan)' }, { value: 'linear', label: 'Linear' }, { value: 'constant', label: 'Constant (hoist / brake)' }], default: 'quadratic', group: 'Load', auto: (c) => { const o = c.upstream('s11'); return o?.loadType ? { value: o.loadType, prov: 'coupled' } : undefined; } },
    { key: 'loadTorque', label: 'Load torque at design speed (0 = match drive)', unit: 'N·m', type: 'number', min: 0, max: 500, step: 0.01, default: 0, group: 'Load', auto: (c) => { const o = c.upstream('s11'); return o?.loadTorque_Nm > 0 ? { value: +o.loadTorque_Nm.toPrecision(4), prov: 'coupled' } : undefined; } },
    { key: 'rpm', label: 'Design shaft speed', unit: 'rpm', type: 'number', min: 1, max: 3000, step: 1, default: 60, group: 'Load', auto: (c) => ({ value: c.engine.rpm, prov: 'calc' }) },
    { key: 'startLoad', label: 'Load during start-up', type: 'select', options: [{ value: 'connected', label: 'Connected from rest' }, { value: 'clutched', label: 'Clutched in at 80 % of design speed' }], default: 'connected', group: 'Load' },
    { key: 'rpmLimit', label: 'Overspeed limit (rotor / clutch rating)', unit: 'rpm', type: 'number', min: 1, max: 10000, step: 1, default: 240, group: 'Load', auto: (c) => ({ value: 4 * c.engine.rpm, prov: 'calc' }) },
    { key: 'parkMode', label: 'Parking state', type: 'select', options: [{ value: 'retained', label: 'Preload retained by bias springs (ready to restart)' }, { value: 'relaxed', label: 'Bias relaxed for storage (re-preload needed)' }], default: 'retained', group: 'Shutdown & restart' },
    { key: 'sigmaRelax', label: 'Residual stress when relaxed', unit: 'MPa', type: 'number', min: 0, max: 200, step: 1, default: 10, group: 'Shutdown & restart' },
    { key: 'TambMax', label: 'Maximum ambient during parking', unit: '°C', type: 'number', min: -20, max: 80, step: 1, default: 40, group: 'Shutdown & restart' },
    { key: 'preloadSource', label: 'Re-preload energy source', type: 'select', options: [{ value: 'flywheel', label: 'Flywheel kinetic energy via a ratchet pretensioner' }, { value: 'spring', label: 'Dedicated spring energy reserve' }, { value: 'manual', label: 'Manual crank (operator work)' }, { value: 'motor', label: 'Electric starter motor (auxiliary energy)' }], default: 'flywheel', group: 'Shutdown & restart' },
    { key: 'pretensionEff', label: 'Pretensioner efficiency', type: 'range', min: 0.1, max: 1, step: 0.01, default: 0.6, group: 'Shutdown & restart' },
    { key: 'springReserve', label: 'Spring energy reserve', unit: 'J', type: 'number', min: 0, max: 10000, step: 1, default: 20, group: 'Shutdown & restart' },
    { key: 'deltaBias', label: 'Bias-spring pre-deflection to restore', unit: 'mm', type: 'number', min: 0, max: 200, step: 0.5, default: 15, group: 'Shutdown & restart' },
    { key: 'nLevels', label: 'Source-temperature levels for drive tables', type: 'number', min: 3, max: 10, step: 1, default: 5, group: 'Solver', expert: true },
    { key: 'cellSpc', label: 'Cell-solver steps per cycle', type: 'number', min: 60, max: 400, step: 10, default: 100, group: 'Solver', expert: true },
    { key: 'spc', label: 'Shaft steps per cycle', type: 'number', min: 30, max: 1000, step: 10, default: 80, group: 'Solver', expert: true },
    { key: 'tCoast', label: 'Maximum coast-down simulation', unit: 's', type: 'number', min: 5, max: 1200, step: 5, default: 90, group: 'Solver', expert: true },
  ],
  presets: [
    { label: 'Cold morning, slow boiler (τ_h = 180 s)', values: { T0: 5, tauHot: 180 } },
    { label: 'Low-grade source (55 °C)', values: { Th: 55 } },
    { label: 'Heavy constant load at start', values: { loadType: 'constant', loadTorque: 2.5 } },
    { label: 'Clutched load, relaxed parking', values: { startLoad: 'clutched', parkMode: 'relaxed' } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const d = { ...ctx.engine, Th: p.Th, Tc: p.Tc }, N = Math.max(1, Math.round(p.nCells)), nS = clamp(Math.round(p.nStart), 1, N), mat = getMat(d.alloy) || getMat('niti-lt');
    const omegaD = p.rpm * TAU / 60, P = 1 / d.freq;
    const s10 = ctx.upstream('s10'), A = s10?.amplification > 0 ? s10.amplification : 1, etaM = s10?.transEff > 0 ? s10.transEff : 0.98;
    const AfH = mat.Af + d.sigmaH / mat.CA, AsH = mat.As + d.sigmaH / mat.CA, MsL = mat.Ms + d.sigmaL / mat.CM, MfL = mat.Mf + d.sigmaL / mat.CM;
    // ---- drive tables at several source temperatures ----
    const Tlo = Math.max(p.Tc + 5, AsH - 2), Thi = Math.max(p.Th + 10, Tlo + 5), levels = linspace(Tlo, Thi, Math.max(3, Math.round(p.nLevels)));
    if (!levels.some(T => Math.abs(T - p.Th) < 1e-9)) { levels.push(p.Th); levels.sort((a, b) => a - b); }
    const tabs = [];
    for (const [j, T] of levels.entries()) {
      ctx.progress(0.05 + 0.4 * j / levels.length, `Cell cycle at ${f3(T)} °C`);
      const r = cellDrive(ctx, d, { spc: p.cellSpc, over: { Th: T }, useUpstream: Math.abs(T - p.Th) < 1e-9 });
      const H = r.cell.hist, nHot = r.drive.nHot, Fbl = Math.max(0, ...range(nHot).map(k => H.F[k] - d.sigmaL * 1e6 * r.cell.area));
      tabs.push({ T, cell: r.cell, dr: scaleDrive(r.drive, A, etaM), Fblk: Fbl * etaM / A, W: r.cell.Wout, src: r.src });
      await pause(ctx);
    }
    const design = tabs.find(t => Math.abs(t.T - p.Th) < 1e-9), cell = design.cell, gearRef = design.dr.Wcell > 0 ? design : tabs[tabs.length - 1]; // gear sized on a working cycle
    const ks = ribbonStiffness(mat, d, cell) / (A * A), cs = 2 * 0.15 * Math.sqrt(ks * 0.05);
    let R = p.Reff > 0 ? p.Reff / 1000 : effRadius(20, designGear(gearRef.dr, 20, omegaD)); const eta = p.eta, tauS = p.tauC * p.staticFactor;
    // quasi-steady characteristic at each level; load sizing
    const qsAt = (tab, w) => N * constantSpeedCell(tab.dr, { omega: w, R, eta, ks, cs }).mean;
    const fricRun = (w) => p.tauC + p.cVisc * w + N * p.tauDrag * 0.5;
    if (!(p.Reff > 0)) { // same design-speed matching as Suite 11: put the maximum-power speed at the design speed
      const wg = linspace(0, 3 * Math.max(gearRef.dr.vMean, 1e-6) / R, 48), c0 = wg.map(w => qsAt(gearRef, w)); let kb = 0; for (let k = 1; k < wg.length; k++) if ((c0[k] - fricRun(wg[k])) * wg[k] > (c0[kb] - fricRun(wg[kb])) * wg[kb]) kb = k;
      if (wg[kb] > 0) R *= wg[kb] / omegaD;
    }
    const wGrid = linspace(0, 3 * Math.max(...tabs.map(t => t.dr.vMean)) / R, 48);
    const curves = tabs.map(t => wGrid.map(w => qsAt(t, w)));
    const cD = curves[tabs.indexOf(design)];
    const shape = (w) => p.loadType === 'constant' ? 1 : p.loadType === 'linear' ? w / omegaD : (w / omegaD) ** 2;
    let kS = 0; for (let k = 1; k < wGrid.length; k++) if ((cD[k] - fricRun(wGrid[k])) * wGrid[k] > (cD[kS] - fricRun(wGrid[kS])) * wGrid[kS]) kS = k;
    const loadRef = p.loadTorque > 0 ? p.loadTorque : Math.max(0, cD[kS] - fricRun(wGrid[kS])) / Math.max(shape(wGrid[kS]), 1e-9) * 0.98;
    let loadOn = p.startLoad !== 'clutched';
    const load = (w) => (loadOn ? loadRef * shape(Math.max(0, w)) : 0);
    // ---- static start torque vs source temperature; self-start threshold ----
    const stT = tabs.map(t => nS * t.Fblk * R * eta), load0 = p.startLoad === 'clutched' ? 0 : loadRef * shape(0), need = tauS + load0;
    const stAt = (T) => { if (T <= levels[0]) return stT[0]; for (let j = 1; j < levels.length; j++) if (T <= levels[j]) return stT[j - 1] + (stT[j] - stT[j - 1]) * (T - levels[j - 1]) / (levels[j] - levels[j - 1]); return stT[stT.length - 1]; };
    const startTorque = stAt(p.Th), selfStartStatic = startTorque > need;
    let Tthr = NaN; if (stAt(levels[levels.length - 1]) > need) { Tthr = stAt(levels[0]) > need ? levels[0] : brent((T) => stAt(T) - need, levels[0], levels[levels.length - 1]).x; }
    const stallLoad = Math.max(0, startTorque - tauS);
    // ---- timeline ----
    const Tready = Math.min(AsH + p.readyMargin, p.Th - 0.5), Thot = (t) => p.Th - (p.Th - p.T0) * Math.exp(-t / p.tauHot), Tcold = (t) => p.Tc + (p.T0 - p.Tc) * Math.exp(-t / p.tauCold);
    const tReady = p.Th > Tready && Tready > p.T0 ? -p.tauHot * Math.log((p.Th - Tready) / (p.Th - p.T0)) : (Tready <= p.T0 ? 0 : Infinity);
    const offs = ctx.upstream('s12')?.offsets?.length === N ? ctx.upstream('s12').offsets.map(Number) : range(N).map(i => i / N);
    const startSet = new Set(range(nS).map(k => Math.round(k * N / nS) % N));
    const tRunE = p.tRun > 0 ? p.tRun : 3 * p.tauHot + 20, tSD = (Number.isFinite(tReady) ? tReady : 0) + tRunE, tEnd = tSD + p.tCoast;
    const st = { tSeq: Infinity, tAct: new Float64Array(N).fill(Infinity), tEndStart: Infinity, tBreak: Infinity, tClutch: Infinity };
    for (const i of startSet) st.tAct[i] = tReady;
    const tmpA = { xf: 0, fc: 0, vf: 0 }, tmpB = { xf: 0, fc: 0, vf: 0 };
    // level bracket for a hot-loop temperature (cached per cell and cycle; the loop lag is slow relative to a cycle)
    const bracket = (T) => { if (T <= levels[0]) return null; let j = 1; while (j < levels.length - 1 && T > levels[j]) j++; return { j, w: clamp((T - levels[j - 1]) / (levels[j] - levels[j - 1]), 0, 1) }; };
    const cache = { cyc: new Float64Array(N).fill(NaN), br: new Array(N).fill(null), t: NaN, fcold: 1 };
    const drive = (i, t, o) => {
      let ta = st.tAct[i];
      if (!(t >= ta)) { if (startSet.has(i) && t >= tReady && t < st.tEndStart) ta = tReady; else { o.xf = 0; o.fc = 0; o.vf = 0; return o; } }
      const tau = t - ta, cycStart = ta + Math.floor(tau / P) * P;
      if (cycStart >= tSD) { o.xf = 0; o.fc = 0; o.vf = 0; return o; }
      if (cache.cyc[i] !== cycStart) { cache.cyc[i] = cycStart; cache.br[i] = bracket(Thot(cycStart)); }
      const b = cache.br[i]; if (!b) { o.xf = 0; o.fc = 0; o.vf = 0; return o; }
      driveLookup(tabs[b.j - 1].dr, tau, tmpA); driveLookup(tabs[b.j].dr, tau, tmpB);
      if (cache.t !== t) { cache.t = t; cache.fcold = clamp((MsL - Tcold(t)) / Math.max(MsL - MfL, 1e-6), 0, 1); }
      const w = b.w, fc = cache.fcold; o.xf = (tmpA.xf + (tmpB.xf - tmpA.xf) * w) * fc; o.fc = tmpA.fc + (tmpB.fc - tmpA.fc) * w; o.vf = (tmpA.vf + (tmpB.vf - tmpA.vf) * w) * fc; return o;
    };
    const onStep = (t, y) => {
      if (y[1] > 1e-6 && t < st.tBreak) st.tBreak = t;
      if (st.tSeq === Infinity && y[1] >= p.seqRpm * TAU / 60) {
        st.tSeq = t; const tE = tReady + Math.ceil((t - tReady) / P + 1e-9) * P; st.tEndStart = tE;
        for (let i = 0; i < N; i++) st.tAct[i] = startSet.has(i) ? tE + ((((1 - offs[i]) - (tE - t) / P) % 1 + 1) % 1) * P : t + (((1 - offs[i]) % 1 + 1) % 1) * P;
      }
      if (!loadOn && y[1] >= 0.8 * omegaD) { loadOn = true; st.tClutch = t; }
    };
    const resetState = () => { st.tSeq = Infinity; st.tEndStart = Infinity; st.tBreak = Infinity; st.tClutch = Infinity; st.tAct.fill(Infinity); cache.cyc.fill(NaN); cache.t = NaN; for (const i of startSet) st.tAct[i] = tReady; loadOn = p.startLoad !== 'clutched'; };
    const seg = (spc, t0, t1, init = {}) => simulateShaft({ N, drive, R: () => R, eta, ks, cs, J: p.J, tauC: p.tauC, cVisc: p.cVisc, tauS, tauDrag: p.tauDrag, load, t0, t1, h: P / spc, record: Math.max(1, Math.round(spc / 25)), onStep, stop: (t, y, stuck) => t > tSD + P && (stuck || y[1] < 1e-5 * omegaD), ...init });
    // whole transient in two segments; the split state (10 cycles before shutdown) seeds the step-halving study
    const tSplit = Math.max(tReady, tSD - 10 * P);
    const runSim = (spc) => {
      resetState(); const a = seg(spc, tReady, tSplit), snap = { omega0: a.omega, theta0: a.theta, xc0: a.xc, st: { ...st, tAct: Float64Array.from(st.tAct) }, loadOn };
      const b = seg(spc, tSplit, tEnd, { omega0: a.omega, theta0: a.theta, xc0: a.xc });
      const H = {}; for (const k of Object.keys(a.H)) H[k] = [...a.H[k], ...b.H[k].slice(1)];
      return { s: { H, Win: a.Win + b.Win, Wload: a.Wload + b.Wload, Wfric: a.Wfric + b.Wfric, KE0: a.KE0, KE1: b.KE1, omega: b.omega }, tBreak: st.tBreak, tSeq: st.tSeq, tClutch: st.tClutch, snap };
    };
    ctx.progress(0.5, 'Start-up → steady → shutdown transient');
    const A1 = Number.isFinite(tReady) ? runSim(p.spc) : null;
    await pause(ctx);
    // ---- post-processing ----
    let wSS = 0, tSteady = NaN, tStop = NaN, safeStop = NaN, Hs = null, KEsd = 0;
    const Tpk = Math.max(...cell.hist.Tm), cIdx = cell.hist.t.map((t, k) => t >= d.dutyHot * P ? k : -1).filter(k => k >= 0);
    let tauCool = P * 0.2; { const T0c = cell.hist.Tm[cIdx[0]], tgt = p.Tc + (T0c - p.Tc) / Math.E; const k = cIdx.find(k => cell.hist.Tm[k] <= tgt); if (k !== undefined) tauCool = Math.max(1e-3, cell.hist.t[k] - cell.hist.t[cIdx[0]]); }
    const sigPark = p.parkMode === 'retained' ? d.sigmaL : p.sigmaRelax, MfPark = mat.Mf + sigPark / mat.CM, AsPark = mat.As + sigPark / mat.CA, Tsafe = Math.min(MfPark, p.Tc + 5);
    const lastHotEnd = tSD + d.dutyHot * P; // the last hot phases started before the command end within one hot phase
    const tCellSafe = lastHotEnd + tauCool * Math.log(Math.max(1, (Tpk - p.Tc) / Math.max(Tsafe - p.Tc, 1e-3)));
    if (A1) {
      Hs = A1.s.H; const iRun = Hs.t.map((t, k) => t >= tSD - 3 * P && t < tSD ? k : -1).filter(k => k >= 0);
      wSS = mean(iRun.map(k => Hs.omega[k]));
      if (wSS > 0) { let kk = -1; for (let k = Hs.t.length - 1; k >= 0; k--) if (Hs.t[k] < tSD && Math.abs(Hs.omega[k] - wSS) > 0.05 * wSS) { kk = k; break; } tSteady = kk >= 0 ? Hs.t[Math.min(kk + 1, Hs.t.length - 1)] : Hs.t[0]; }
      const ksd = Hs.t.findIndex(t => t >= tSD); KEsd = 0.5 * p.J * (Hs.omega[ksd] ?? 0) ** 2;
      const kStop = Hs.t.findIndex((t, k) => t > tSD && Hs.omega[k] <= 0.01 * Math.max(wSS, 1e-9)); tStop = kStop >= 0 ? Hs.t[kStop] : NaN;
      safeStop = Number.isFinite(tStop) ? Math.max(tStop, tCellSafe) - tSD : NaN;
    }
    const selfStartDyn = A1 ? Number.isFinite(A1.tBreak) && A1.tBreak < tSD : false, selfStart = selfStartDyn;
    const tStart = Number.isFinite(tSteady) ? tSteady : NaN;
    // overspeed on load rejection: quasi-steady free-running speed at the design source temperature
    let wFree = cD[0] - fricRun(0) <= 0 ? 0 : wGrid[wGrid.length - 1]; if (wFree > 0) for (let k = 1; k < wGrid.length; k++) if (cD[k] - fricRun(wGrid[k]) <= 0) { const a = cD[k - 1] - fricRun(wGrid[k - 1]), b = cD[k] - fricRun(wGrid[k]); wFree = wGrid[k - 1] + (wGrid[k] - wGrid[k - 1]) * a / (a - b); break; }
    const overspeedOK = wFree * 60 / TAU <= p.rpmLimit;
    // residual heat at shutdown
    const mCell = cell.mass, Cw = d.wallCapacity * cell.faceArea, xiA = 1 - (cell.xiMin ?? 0);
    const Qres = N * ((mCell * mat.cp + Cw) * Math.max(0, mean(cell.hist.Tm) - p.Tc) + mCell * (mat.Lh || 0) * xiA * d.dutyHot);
    // re-preload energy and its source
    const Fb = d.sigmaL * 1e6 * cell.area, Epre = p.parkMode === 'relaxed' ? N * (cell.Wreset + 0.5 * Fb * p.deltaBias / 1000) : 0;
    const Esrc = p.preloadSource === 'flywheel' ? KEsd * p.pretensionEff : p.preloadSource === 'spring' ? p.springReserve : Infinity;
    const preloadOK = Epre <= Esrc, parkSafe = AsPark > p.TambMax && sigPark <= (mat.sigF ?? 200);
    const restartOK = selfStartStatic && (p.parkMode === 'retained' ? AsPark > p.TambMax : preloadOK);
    // ---- stall envelope: source temperature × constant load → steady speed (0 = cannot start / stalls) ----
    const loadsE = linspace(0, Math.max(...stT, 0.1) * 1.3, 22);
    const Zenv = loadsE.map(L => tabs.map((t, j) => { if (stT[j] - L <= tauS) return 0; const c = curves[j]; for (let k = 1; k < wGrid.length; k++) { const a = c[k - 1] - fricRun(wGrid[k - 1]) - L, b = c[k] - fricRun(wGrid[k]) - L; if (a > 0 && b <= 0) return (wGrid[k - 1] + (wGrid[k] - wGrid[k - 1]) * a / (a - b)) * 60 / TAU; } return 0; }));
    // ---- verification ----
    if (A1) {
      const s = A1.s, bal = Math.abs(s.Win - (s.KE1 - s.KE0) - s.Wload - s.Wfric) / Math.max(s.Win, 1e-12);
      out.checks.push({ name: 'Energy balance over the complete start–run–stop transient', value: bal, target: '< 1e-3', pass: bal < 1e-3, detail: `Cell work at shaft ${f4(s.Win)} J = ΔKE ${f4(s.KE1 - s.KE0)} J + load ${f4(s.Wload)} J + friction ${f4(s.Wfric)} J.` });
      ctx.progress(0.75, 'Step-halving study');
      // step halving over the last 10 cycles before shutdown, restarted from the identical hybrid state
      const sn = A1.snap; Object.assign(st, sn.st, { tAct: Float64Array.from(sn.st.tAct) }); loadOn = sn.loadOn; cache.cyc.fill(NaN); cache.t = NaN;
      const rh = [p.spc, 2 * p.spc, 4 * p.spc].map(spc => { const r = seg(spc, tSplit, tSD, { omega0: sn.omega0, theta0: sn.theta0, xc0: sn.xc0 }); return { w: mean(r.H.t.map((x, k) => x >= tSD - 3 * P ? r.H.omega[k] : NaN).filter(Number.isFinite)), E: r.Win }; });
      const ran = rh[2].w > 1e-9, dW = ran ? Math.abs(rh[2].w - rh[1].w) / Math.max(Math.abs(rh[2].w), 1e-9) : 0, dE = ran ? Math.abs(rh[2].E - rh[1].E) / Math.max(Math.abs(rh[2].E), 1e-9) : 0, ordr = Math.log(Math.abs(rh[1].w - rh[0].w) / Math.max(Math.abs(rh[2].w - rh[1].w), 1e-15)) / Math.log(2);
      const pOrd = Number.isFinite(ordr) && ordr > 0.5 ? ordr : 1, errProd = Math.abs(rh[1].w - rh[0].w) / (2 ** pOrd - 1) / Math.max(Math.abs(rh[2].w), 1e-9) + Math.abs(rh[1].w - rh[0].w) / Math.max(Math.abs(rh[2].w), 1e-9);
      out.checks.push({ name: 'Step refinement over the last 10 running cycles (h/2 → h/4)', value: Math.max(dW, dE), target: '< 2 % (first-order hybrid clutch events)', pass: ran ? dW < 0.02 && dE < 0.02 : undefined, detail: !ran ? 'The engine is not running before shutdown, so there is no running state to refine.' : `Cycle-mean speed ${rh.map(r => f4(r.w)).join(' → ')} rad/s; cell work ${rh.map(r => f4(r.E)).join(' → ')} J; observed order ${f3(ordr)}; Richardson estimate of the production-step speed error ${f3(errProd * 100)} %. Clutch engagement is resolved at step boundaries, so the scheme is first order.` });
      if (Number.isFinite(A1.tBreak)) out.checks.push({ name: 'Breakaway time resolved by the time step', value: P / p.spc, target: '< 2 % of a cycle', pass: 1 / p.spc < 0.02 + 1e-12, detail: `Breakaway at ${f4(A1.tBreak)} s is detected to within one step (${f4(P / p.spc)} s).` });
      out.checks.push({ name: 'Dynamic breakaway consistent with static start criterion', value: selfStartDyn === selfStartStatic ? 'consistent' : 'inconsistent', pass: selfStartDyn === selfStartStatic, detail: `Static: τ_start ${f3(startTorque)} vs τ_static + load ${f3(need)} N·m; dynamic breakaway ${selfStartDyn ? 'at ' + f3(A1.tBreak) + ' s' : 'not reached'}.` });
      const wEnd = s.omega; out.checks.push({ name: 'Shaft at rest after shutdown (kinetic energy dissipated)', value: wEnd, target: '< 1e-3·ω_ss', pass: wEnd <= 1e-3 * Math.max(wSS, 1e-6) + 1e-9 || wEnd < 1e-5 * omegaD + 1e-12, detail: `Final ω = ${fmt(wEnd, 3)} rad/s at ${f3(Hs.t[Hs.t.length - 1])} s (coast budget ${f3(p.tCoast)} s).` });
    }
    out.checks.push({ name: 'Start torque non-decreasing with source temperature', value: stT.every((v, j) => j === 0 || v >= stT[j - 1] - 1e-9) ? 'yes' : 'no', pass: undefined, detail: stT.map((v, j) => `${f3(levels[j])} °C: ${f3(v)} N·m`).join('; ') });
    // ---- KPIs ----
    out.kpis.push(
      { label: 'Self-start at design conditions', value: selfStart ? 'yes' : 'no', unit: '', explain: `Whether the shaft breaks away from rest with ${nS} start cells heated at ${p.Th} °C against static friction ${f3(tauS)} N·m and the load at rest ${f3(load0)} N·m.`, prov: 'calc', status: selfStart ? 'ok' : 'bad' },
      { label: 'Static start torque', value: startTorque, unit: 'N·m', explain: `${nS} start cells × ${f3(design.Fblk)} N blocked force × R = ${f3(R * 1000)} mm × η = ${eta}.`, prov: 'calc', status: selfStartStatic ? 'ok' : 'bad' },
      { label: 'Self-start threshold source temperature', value: Number.isFinite(Tthr) ? Tthr : `> ${f3(levels[levels.length - 1])} (not reached in the mapped range)`, unit: '°C', explain: 'Lowest hot-source temperature at which the start cells can break the shaft away (stress-shifted A_f(σ_H) = ' + f3(AfH) + ' °C).', prov: 'calc', status: Number.isFinite(Tthr) && Tthr <= p.Th ? 'ok' : 'bad' },
      { label: 'Time from pump start to steady speed', value: tStart, unit: 's', explain: `Includes hot-circuit warm-up to ${f3(Tready)} °C (${f3(tReady)} s), breakaway${A1 && Number.isFinite(A1.tBreak) ? ` at ${f3(A1.tBreak)} s` : ''} and acceleration until speed stays within ±5 % of ${f3(wSS * 60 / TAU)} rpm.`, prov: 'calc', status: Number.isFinite(tStart) ? 'ok' : 'warn' },
      { label: 'Steady speed reached', value: wSS * 60 / TAU, unit: 'rpm', explain: 'Mean speed over the last three cycles before shutdown.', prov: 'calc' },
      { label: 'Maximum load for self-start (stall load)', value: stallLoad, unit: 'N·m', explain: 'Largest constant load torque the start cells can break away against at the design source temperature (static start torque − static friction).', prov: 'calc' },
      { label: 'Free-running speed on load rejection', value: wFree * 60 / TAU, unit: 'rpm', explain: `If the load is lost the engine speeds up until the carriages can no longer keep pace with the shaft; limit ${p.rpmLimit} rpm.`, prov: 'calc', status: overspeedOK ? 'ok' : 'bad' },
      { label: 'Safe-stop time after shutdown command', value: safeStop, unit: 's', explain: `Until the shaft is below 1 % of steady speed (${f3(tStop - tSD)} s) and the ribbons are below ${f3(Tsafe)} °C (fully martensitic at the park stress; ${f3(tCellSafe - tSD)} s).`, prov: 'calc', status: Number.isFinite(safeStop) ? 'ok' : 'warn' },
      { label: 'Re-preload energy for next start', value: Epre, unit: 'J', explain: p.parkMode === 'relaxed' ? `Bias springs relaxed: re-extending ${N} cells needs W_reset + ½F_bδ_b each; source “${p.preloadSource}” provides ${Number.isFinite(Esrc) ? f3(Esrc) + ' J' : 'external work (counted as auxiliary energy)'}.` : 'Preload retained by the bias springs at shutdown; no re-preload work, but the ribbons stay under the bias stress while parked.', prov: 'calc', status: preloadOK ? 'ok' : 'bad' },
      { label: 'Residual heat removed at shutdown', value: Qres / 1000, unit: 'kJ', explain: 'Sensible heat of ribbons and walls above the sink plus the latent heat of the austenite fraction that the cold circuit must remove before parking.', prov: 'calc' },
    );
    // ---- verdicts ----
    out.verdicts.push(
      { test: 'Hot circuit reaches the start temperature', status: Number.isFinite(tReady) ? 'pass' : 'fail', detail: `Start cells are heated from ${f3(Tready)} °C (A_s(σ_H) ${f3(AsH)} °C + ${p.readyMargin} K; full recovery needs A_f(σ_H) = ${f3(AfH)} °C); source ${p.Th} °C.`, fix: 'Raise the source temperature or lower σ_H / choose an alloy with lower A_f (Suite 03).' },
      { test: 'Self-start from rest', status: selfStart ? 'pass' : 'fail', detail: `Start torque ${f3(startTorque)} N·m vs needed ${f3(need)} N·m.`, fix: `Heat more start cells (${Math.ceil(need / Math.max(design.Fblk * R * eta, 1e-12))} needed), clutch the load in after run-up, or reduce static friction.` },
      { test: 'Overspeed on load rejection', status: overspeedOK ? 'pass' : 'fail', detail: `Free-running ${f3(wFree * 60 / TAU)} rpm vs limit ${p.rpmLimit} rpm.`, fix: 'Add an overspeed brake or hot-valve trip (Suite 21), or raise the gear ratio limit.' },
      { test: 'Parking state is non-damaging', status: parkSafe ? 'pass' : 'warn', detail: `Park stress ${f3(sigPark)} MPa; A_s at park stress ${f3(AsPark)} °C vs maximum ambient ${p.TambMax} °C (accidental actuation if exceeded).`, fix: 'Relax the bias preload for storage, store below A_s, or add a mechanical lock.' },
      { test: 'Re-preload energy has a defined source', status: preloadOK ? 'pass' : 'fail', detail: `Needed ${f3(Epre)} J; available ${Number.isFinite(Esrc) ? f3(Esrc) + ' J' : 'external (manual/motor work, reported as auxiliary input)'}.`, fix: 'Retain preload at shutdown, enlarge the spring reserve, or capture flywheel energy with a pretensioner before it coasts down.' },
      { test: 'Restart from the parked state', status: restartOK ? 'pass' : 'fail', detail: `Self-start ${selfStartStatic ? 'possible' : 'not possible'}; parking ${p.parkMode}.`, fix: 'See the self-start and re-preload verdicts.' },
      { test: 'Start-up measurements', status: 'info', detail: 'Circuit lags, static friction and blocked force are estimates.', fix: 'Log a cold start (loop temperatures, breakaway torque, speed) and import it for calibration (Suite 19).' },
    );
    out.headline = !Number.isFinite(tReady) ? `The hot circuit never reaches the ${f3(Tready)} °C needed to start the cells — the engine cannot start.` : `From a cold start the engine ${selfStart ? `breaks away at ${f3(A1.tBreak)} s and reaches ${f3(wSS * 60 / TAU)} rpm after ${f3(tStart)} s` : 'does not break away'}; self-start threshold ${Number.isFinite(Tthr) ? f3(Tthr) + ' °C' : 'above ' + f3(levels[levels.length - 1]) + ' °C'}, stall load ${f3(stallLoad)} N·m, safe stop ${f3(safeStop)} s, restart ${restartOK ? 'possible' : 'NOT possible'}.`;
    out.headlineKind = selfStart && restartOK && overspeedOK ? 'ok' : selfStart ? 'warn' : 'fail';
    // ---- charts ----
    const vl = (x, label, color) => Number.isFinite(x) ? [{ type: 'vline', x, label, color }] : [];
    const marks = [...vl(tReady, 'heat start cells', '#f59e0b'), ...vl(A1?.tBreak, 'breakaway', '#22c55e'), ...vl(A1?.tSeq, 'sequencing', '#a855f7'), ...vl(tSteady, 'steady', '#38bdf8'), ...vl(tSD, 'shutdown', '#ef4444'), ...vl(tStop, 'stopped', '#64748b')];
    const tPre = linspace(0, Math.max(tReady || 0, 1), 30);
    if (Hs) {
      out.charts.push({ type: 'line', wide: true, title: 'Start-up, steady running and shutdown', x: { label: 'Time from pump start', unit: 's' }, y: { label: 'Shaft speed', unit: 'rpm' }, series: [{ name: 'ω', x: [...tPre, ...Hs.t], y: [...tPre.map(() => 0), ...Hs.omega.map(w => w * 60 / TAU)] }], annotations: [...marks, { type: 'hline', y: p.rpm, label: 'design speed' }], explain: 'Speed from the moment the circulation pumps start: the shaft waits while the hot circuit warms, breaks away once the start cells overcome static friction and load, accelerates while the remaining cells join the schedule, runs steadily, and decelerates to rest after the hot valves are isolated.' });
      const tT = linspace(0, tEnd, 120);
      out.charts.push({ type: 'line', title: 'Circuit and cell temperatures', x: { label: 'Time', unit: 's' }, y: { label: 'Temperature', unit: '°C' }, series: [{ name: 'Hot circuit', x: tT, y: tT.map(t => t < tSD ? Thot(t) : Thot(tSD)) }, { name: 'Cold circuit', x: tT, y: tT.map(Tcold) }, { name: 'Ribbon (after isolation)', x: tT.filter(t => t >= lastHotEnd), y: tT.filter(t => t >= lastHotEnd).map(t => p.Tc + (Tpk - p.Tc) * Math.exp(-(t - lastHotEnd) / tauCool)) }], annotations: [{ type: 'hline', y: AfH, label: 'A_f(σ_H)' }, { type: 'hline', y: Tsafe, label: 'safe park' }, ...vl(tSD, 'shutdown', '#ef4444')], explain: 'First-order warm-up of the hot loop and pull-down of the cold loop from ambient; after shutdown the hot loop is isolated and the cold loop removes residual heat until the ribbons are back below the stress-adjusted martensite finish.' });
      const kD = Math.max(1, Math.floor(Hs.t.length / 700)), dd = (a) => a.filter((_, k) => k % kD === 0);
      out.charts.push({ type: 'line', title: 'Torque balance during the transient', x: { label: 'Time', unit: 's' }, y: { label: 'Torque', unit: 'N·m' }, series: [{ name: 'Drive Σ τᵢ', x: dd(Hs.t), y: dd(Hs.tq) }, { name: 'Load', x: dd(Hs.t), y: dd(Hs.tl), dash: true }, { name: 'Friction & drag', x: dd(Hs.t), y: dd(Hs.tf), dash: true }, { name: 'Cells engaged', x: dd(Hs.t), y: dd(Hs.engaged) }], annotations: [{ type: 'hline', y: tauS, label: 'static friction' }, ...marks.slice(1)], explain: 'Instantaneous drive torque of the engaged cells against load and friction. Before breakaway the drive must exceed the static-friction line; the shaft accelerates while drive exceeds load + friction on average.' });
    }
    out.charts.push({ type: 'heatmap', wide: true, title: 'Stall envelope: steady speed vs source temperature and constant load', x: { label: 'Hot-source temperature', unit: '°C', values: levels }, y: { label: 'Constant load torque', unit: 'N·m', values: loadsE }, z: Zenv, cmap: 'viridis', isolines: 5, zlabel: 'rpm', explain: `Steady shaft speed for each source temperature and constant load (0 = cannot break away or stalls). The boundary between zero and positive speed is the self-start envelope; it moves to higher loads as the source gets hotter and the cells transform more completely.` });
    out.charts.push({ type: 'line', title: 'Start torque vs source temperature', x: { label: 'Hot-source temperature', unit: '°C' }, y: { label: 'Torque', unit: 'N·m' }, series: [{ name: `Static start torque (${nS} cells)`, x: levels, y: stT, mode: 'markers' }, { name: 'Running torque at 10 % design speed (all cells)', x: levels, y: tabs.map(t => qsAt(t, 0.1 * omegaD)) }], annotations: [{ type: 'hline', y: need, label: 'static friction + load at rest' }, { type: 'vline', x: p.Th, label: 'design source' }, ...(Number.isFinite(Tthr) ? [{ type: 'vline', x: Tthr, label: 'self-start threshold', color: '#ef4444' }] : [])], explain: 'Breakaway torque available from the start cells as a function of source temperature; the crossing with the static resistance line is the self-start threshold.' });
    out.charts.push({ type: 'bar', title: 'Re-preload energy and its source', categories: ['Needed for restart', 'Flywheel KE at shutdown', 'Recoverable via pretensioner', 'Spring reserve'], series: [{ name: 'Energy [J]', values: [Epre, KEsd, KEsd * p.pretensionEff, p.springReserve] }], explain: 'Restart must not assume free preloading. The bars compare the work needed to re-extend the ribbons and re-tension the bias springs with the energy each source can supply.' });
    // ---- tables ----
    out.tables.push({ title: 'Operating thresholds and events', cols: ['Item', 'Value', 'Unit'], rows: [
      ['Start temperature (A_s(σ_H) + margin)', f4(Tready), '°C'], ['Hot-circuit ready time', f4(tReady), 's'], ['Breakaway time', f4(A1?.tBreak), 's'], ['Sequencing start', f4(A1?.tSeq), 's'], ['Load clutched in', f4(A1?.tClutch), 's'], ['Steady speed reached', f4(tSteady), 's'], ['Shutdown command', f4(tSD), 's'], ['Shaft stopped', f4(tStop), 's'], ['Ribbons safe (≤ ' + f3(Tsafe) + ' °C)', f4(tCellSafe), 's'],
      ['Self-start threshold', f4(Tthr), '°C'], ['Stall load (self-start)', f4(stallLoad), 'N·m'], ['Free-running speed', f4(wFree * 60 / TAU), 'rpm'], ['Cell cool-down time constant', f4(tauCool), 's'], ['Flywheel KE at shutdown', f4(KEsd), 'J'], ['Re-preload energy', f4(Epre), 'J'],
    ], explain: 'Event times measured from the start of the circulation pumps.' });
    out.tables.push({ title: 'Drive tables by source temperature', cols: ['T_source [°C]', 'Cell W_out [J]', 'Blocked force [N]', 'Start torque [N·m]', 'Running torque at design speed [N·m]'], rows: tabs.map((t, j) => [f4(t.T), f4(t.W), f4(t.Fblk), f4(stT[j]), f4(qsAt(t, omegaD))]), explain: 'Transient-cell solutions used to interpolate the drive during warm-up and to map the stall envelope.' });
    // ---- explanation & recommendations ----
    out.explain.push(
      { title: 'Start-up sequence', text: `Pumps start at t = 0. The hot loop (τ_h = ${p.tauHot} s) reaches ${f3(Tready)} °C after ${f3(tReady)} s; ${nS} start cells are then heated together. ${selfStart ? `Their contraction builds torque until it exceeds static friction plus the load at rest and the shaft breaks away at ${f3(A1.tBreak)} s; at ${p.seqRpm} rpm the remaining cells join the phased schedule and the engine settles at ${f3(wSS * 60 / TAU)} rpm.` : 'Their torque never exceeds static friction plus the load, so the shaft stays at rest.'}` },
      { title: 'Shutdown and parking', text: `At ${f3(tSD)} s the hot valves are isolated: cells finish their current stroke, the cold loop removes ${f3(Qres / 1000)} kJ of residual heat and the shaft decelerates against load and friction. Parking ${p.parkMode === 'retained' ? 'keeps the bias preload so the next start needs no preload work, at the cost of sustained stress in the cold ribbons' : `relaxes the bias to ${p.sigmaRelax} MPa; the next start first needs ${f3(Epre)} J to re-extend the ribbons and re-tension the springs, supplied by the ${p.preloadSource}`}.` },
    );
    out.recs.push(
      { level: selfStart ? 'good' : 'critical', text: selfStart ? `Self-start margin ${f3(startTorque - need)} N·m with ${nS} start cells.` : `Increase start cells to ${Math.ceil(need / Math.max(design.Fblk * R * eta, 1e-12))} or clutch the load in after run-up.`, basis: `Start torque ${f3(startTorque)} N·m, static friction ${f3(tauS)} N·m.` },
      { level: Number.isFinite(Tthr) && p.Th - Tthr < 5 ? 'warn' : 'info', text: `The engine cannot start below ${f3(Tthr)} °C source temperature; at ${p.Th} °C the margin is ${f3(p.Th - Tthr)} K.`, basis: 'Start torque vs source temperature.' },
      { level: overspeedOK ? 'info' : 'critical', text: `Load rejection drives the shaft to ${f3(wFree * 60 / TAU)} rpm (limit ${p.rpmLimit} rpm). ${overspeedOK ? 'The carriage speed limit makes the engine self-limiting.' : 'Fit an overspeed trip that closes the hot valves.'}`, basis: 'Quasi-steady free-running speed.' },
      { level: p.parkMode === 'relaxed' && !preloadOK ? 'critical' : 'info', text: p.parkMode === 'relaxed' ? `Relaxed parking needs ${f3(Epre)} J to restart; the flywheel holds ${f3(KEsd)} J at shutdown (${f3(KEsd * p.pretensionEff)} J recoverable).` : `Retained preload keeps the ribbons at ${f3(sigPark)} MPa while parked; A_s at that stress is ${f3(AsPark)} °C vs ${p.TambMax} °C maximum ambient.`, basis: 'Shutdown & restart energy accounting.' },
      { level: 'econ', text: `Warm-up takes ${f3(tReady)} s with pumps running before any output; for frequent short runs the circulation energy during warm-up and the residual heat (${f3(Qres / 1000)} kJ per stop) are costs that favour continuous operation or a hot-standby loop.`, basis: `τ_h = ${p.tauHot} s.` },
      { level: 'sustain', text: `Recover the residual heat at shutdown (${f3(Qres / 1000)} kJ) into the regenerator store (Suite 09) instead of rejecting it to the sink, and capture coast-down kinetic energy (${f3(KEsd)} J) for re-preloading.`, basis: 'Shutdown energy accounting.' },
    );
    // ---- animation ----
    if (Hs) {
      const tA = [...tPre, ...Hs.t], wA = [...tPre.map(() => 0), ...Hs.omega], thA = [...tPre.map(() => 0), ...Hs.theta], tqA = [...tPre.map(() => 0), ...Hs.tq], engA = [...tPre.map(() => 0), ...Hs.engaged];
      const tEndA = Math.min(tA[tA.length - 1], Number.isFinite(tStop) ? tStop + 5 : tEnd), phaseName = (t) => t < tReady ? 'Warm-up: hot loop heating' : (!Number.isFinite(A1.tBreak) || t < A1.tBreak) ? 'Start cells heated — building torque' : t < (A1.tSeq ?? Infinity) ? 'Breakaway' : (!Number.isFinite(tSteady) || t < tSteady) ? 'Accelerating — phase sequencing' : t < tSD ? 'Steady running' : (!Number.isFinite(tStop) || t < tStop) ? 'Shutdown — hot isolated, decelerating' : 'Parked';
      const actAt = (i, t) => { const o = { xf: 0, fc: 0, vf: 0 }; drive(i, t, o); return o; };
      out.views.push({ label: 'Start-up animation', icon: '🚦', render: async (el) => {
        const { anim2d, at, lerp, seriesPanel, theme, bar, label, fs } = await import('../core/anim2d.js');
        // replay the activation schedule recorded by the last simulation
        anim2d(el, { duration: tEndA, rate: tEndA / 20, label: 'Time from pump start', unit: 's', height: (W) => W < 640 ? 820 : 470, explain: 'Time-lapse of the start sequence: circuit temperatures, cells heated (red) and pushing (green arrows), shaft speed, and the operating phase banner from warm-up to parking.', draw: (g, t, W, Hh) => {
          const th = theme(), k = at(tA, t), w = lerp(wA, k), ang = lerp(thA, k), narrow = W < 640, z = fs(W);
          const act = range(N).map(i => actAt(i, t)), heat = act.map(o => o.fc > 0 || o.xf > 0 ? 1 : 0);
          const aw = narrow ? W : W * 0.42; label(g, phaseName(t), 12, 10, { baseline: 'top', size: z + 2, weight: 'bold', maxW: aw - 24 });
          const ah = narrow ? 300 : Hh - 110, r = rotorFit(aw, ah - 30);
          drawRotor(g, { cx: aw / 2, cy: 30 + (ah - 30 - 22) / 2, r, theta: ang, N, act: act.map(o => o.xf / Math.max(design.dr.xwMax, 1e-9)), tau: act.map(o => o.fc > 0 ? o.fc * R * eta : 0), tauMax: design.dr.Fload * R * eta, heat, label: `${fmt(w * 60 / TAU, 3)} rpm`, th });
          const by = ah + 8, bw = aw - 24;
          bar(g, { x: 12, y: by, w: bw, h: 18, value: t < tSD ? Thot(t) : Thot(tSD), max: p.Th + 10, label: 'Hot loop', unit: ' °C', color: '#ef4444' });
          bar(g, { x: 12, y: by + 24, w: bw, h: 18, value: Tcold(t), max: p.Th + 10, label: 'Cold loop', unit: ' °C', color: '#38bdf8' });
          bar(g, { x: 12, y: by + 48, w: bw, h: 18, value: lerp(engA, k), max: N, label: 'Cells pushing', unit: '', color: '#22c55e' });
          const px = narrow ? 10 : W * 0.45, pw = narrow ? W - 20 : W * 0.53, py = narrow ? by + 78 : 8, ph = (Hh - py - 16) / 2;
          seriesPanel(g, { x: px, y: py, w: pw, h: ph, T: tA, series: [{ name: 'speed', y: wA.map(v => v * 60 / TAU), color: th.accent }], t, title: 'Shaft speed', unit: 'rpm', hlines: [{ y: p.rpm, label: 'design', color: '#a855f7' }] });
          seriesPanel(g, { x: px, y: py + ph + 8, w: pw, h: ph, T: tA, series: [{ name: 'drive', y: tqA, color: '#22c55e' }], t, title: 'Drive torque', unit: 'N·m', hlines: [{ y: tauS, label: 'static friction', color: '#ef4444' }] });
        } });
      } });
    }
    out.outputs = { selfStart, startTorque_Nm: startTorque, tStart_s: tStart, stallLoad_Nm: stallLoad, safeStop_s: safeStop, restartOK, selfStartThreshold_C: Tthr, freeRunSpeed_rads: wFree, preloadEnergy_J: Epre, residualHeat_J: Qres };
    return out;
  },
};
