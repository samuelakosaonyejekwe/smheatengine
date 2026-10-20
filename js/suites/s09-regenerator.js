// Suite 09 — Regenerator and thermal storage. Intermediate-loop matrix regenerator recovering the sensible heat of
// cooling cells to pre-heat cells about to be heated: periodic finite-difference matrix model (shared core), ε-NTU
// limits, pinch, matrix pressure drop and pumping penalty, carry-over, exergy destruction, matched with/without
// comparison through the shared engine model (spec §40: "regeneration may worsen total power"), storage media and
// PCM buffer sizing.
import { fluid, fluidOptions, regeneratorFD, effectivenessNTU, pumpPower, carnot, KELVIN } from '../core/heat.js';
import { designWith, engineModel } from '../core/engine.js';
import { get as getMat, forUse } from '../core/materials.js';
import { linspace, range, fmt, clamp, argmax } from '../core/num.js';

const pause = async (ctx) => { try { await ctx.yield?.(); } catch { /* headless run: no animation frame available */ } };
const MATRIX = forUse('regenMatrix');
// matrix geometry & transport: woven screens / foams (Gedeon & Wood 1996) or etched-foil parallel-plate stacks
function matrixModel(mat, { Afr, L, phi, dch, mdot, fl }) {
  const regen = mat.cls === 'regen', V = Afr * L, us = mdot / (fl.rho * Afr), up = us / phi;
  let dh, av, Nu, f, kind;
  if (regen) { dh = dch * phi / (1 - phi); av = 4 * (1 - phi) / dch; kind = 'screen/foam'; }
  else { const tP = dch * (1 - phi) / phi; dh = 2 * dch; av = 2 / (dch + tP); kind = 'foil stack'; }
  const Re = fl.rho * up * dh / fl.mu;
  if (regen) { Nu = (1 + 0.99 * (Re * fl.Pr) ** 0.66) * phi ** 1.79; f = 129 / Math.max(Re, 1e-6) + 2.91 * Math.max(Re, 1e-6) ** -0.103; }
  else { Nu = 7.54; f = (Re < 2300 ? 96 / Math.max(Re, 1e-6) : 0.316 * Re ** -0.25); }
  const h = Nu * fl.k / dh, hA = h * av * V, dp = f * (L / dh) * 0.5 * fl.rho * up * up;
  const rhoBulk = regen ? mat.rho : mat.rho * (1 - phi), mass = rhoBulk * V, Cs = mass * mat.cp, Cf = fl.rho * fl.cp * phi * V, kEff = regen ? mat.k : mat.k * (1 - phi);
  // reversing-flow bed with a liquid: the trapped fluid stores heat with the solid (local equilibrium at high NTU), so it
  // adds to the effective bed capacity instead of being carried into the other stream
  return { kind, V, us, up, dh, av, Re, Nu, f, h, hA, dp, mass, Cs, Cf, Cm: Cs + Cf, kEff, voidV: phi * V };
}
// one cycle replay of the shared FD scheme from a converged matrix state, recording the matrix field and outlet streams
function replay(Tm0, o, cols = 24) {
  const n = o.n, Tm = Float64Array.from(Tm0), cm = o.Cm / n, ha = o.hA / n, rec = { t: [], field: [], Tout: [], blow: [] };
  let t = 0, S = 0; const Q = { H: 0, C: 0 };
  const blow = (Tin, mcp, dir, tag) => {
    const a = 1 - Math.exp(-ha / mcp), sub = Math.max(o.steps, Math.ceil(2 * o.tb * mcp * a / cm)), dt = o.tb / sub, every = Math.max(1, Math.floor(sub / cols));
    for (let s = 0; s < sub; s++) {
      let Tf = Tin;
      for (let k = 0; k < n; k++) { const i = dir > 0 ? k : n - 1 - k, To = Tf + a * (Tm[i] - Tf), q = mcp * (Tf - To); Tm[i] = (cm * Tm[i] + dt * q) / cm; Tf = To; Q[tag] += q * dt; }
      S += mcp * dt * Math.log((Tf + KELVIN) / (Tin + KELVIN)); t += dt;
      if (s % every === 0 || s === sub - 1) { rec.t.push(t); rec.field.push(Array.from(Tm)); rec.Tout.push(Tf); rec.blow.push(tag); }
    }
  };
  blow(o.ThIn, o.mcpH, +1, 'H'); blow(o.TcIn, o.mcpC, -1, 'C');
  return { rec, Sgen: S, QH: Q.H, QC: Q.C, Tm: Array.from(Tm), period: t };
}

export default {
  description: 'Sizes the regenerator that moves sensible heat from cells being cooled to cells about to be heated: periodic finite-difference matrix model with its convergence and energy balance, ε-NTU limits, pinch, pressure drop and pumping penalty, and a matched comparison with and without regeneration through the shared engine model — answering whether regeneration actually improves net output. Compares matrix media and sizes a PCM buffer.',
  literature: 'regenerator effectiveness periodic flow matrix pressure drop shape memory alloy heat engine heat recovery elastocaloric regenerator',
  econ: true, sustain: true, credibility: 'Analytical screening',
  equations: [
    'Matrix: (M c)_m/n · dT_m,i/dt = ṁc_p·(T_f,i−1 − T_f,i); fluid across cell i: T_f,i = T_m,i + (T_f,i−1 − T_m,i)·e^(−hA/(n ṁc_p)) (quasi-steady fluid)',
    'Effectiveness ε = Q_blow/(C_min·t_b·(T_h,in − T_c,in)); energy balance Q_H + Q_C → 0 at cyclic steady state',
    'Balanced counterflow limit (C_r* → ∞): ε = NTU₀/(1 + NTU₀), NTU₀ = 1/C_min·[1/(hA)_H + 1/(hA)_C]⁻¹ = hA/(2C_min) for one matrix in both blows',
    'Finite matrix capacity (Kays & London): ε ≈ ε_cf(NTU₀, C_r)·[1 − 1/(9·C_r*^1.93)], C_r* = (Mc)_m/(C_min·t_b)',
    'Screens/foams (Gedeon & Wood 1996): Nu = (1 + 0.99(Re·Pr)^0.66)·φ^1.79, f = 129/Re + 2.91·Re^(−0.103), d_h = d_w·φ/(1 − φ), a_v = 4(1 − φ)/d_w; foil stacks: Nu = 7.54, f = 96/Re',
    'Δp = f·(L/d_h)·ρu_p²/2, u_p = ṁ/(ρA_fr φ); pumping P = (Δp_H + Δp_C + Δp_loop)·V̇/η',
    'Bed capacity (Mc)_m = m_s c_s + ρ_f c_f φV (liquid trapped in the voids moves with the thermal wave); dead-volume mixing χ = ρc_p V_dead/(C_min t_b); ε_eff = ε_FD·(1 − χ)·η_coupling',
    'Engine: Q_hot = N·f·(Q_hot,cell − ε_eff·Q_sensible,cell) (latent heat is never regenerated); recovered heat Q_rec = ε_eff·N·f·Q_sensible',
    'Entropy generation S_gen = Σ ṁc_p·Δt·ln(T_out/T_in) over both blows (matrix entropy periodic); X_dest = T₀·S_gen/τ + P_pump',
    'Matched source heat: P_net,matched = η·Q_source; net benefit = (η_with − η_without)·Q_hot,without',
    'PCM single-temperature store: ε_max = min(T_h − T_m − ΔT_p, T_m − T_c − ΔT_p)/(T_h − T_c) ≤ 0.5; buffer mass m = Q·t/(h_fus + c_p·ΔT)',
  ],
  methods: [
    'Shared periodic finite-difference regenerator core (heat.regeneratorFD) iterated to cyclic steady state; residual history reported',
    'One-cycle replay of the identical scheme from the converged state for the matrix temperature field, outlet histories and entropy generation (verified against the core ε)',
    'ε-NTU map (5 NTU₀ × 3 C_r*) with the FD model vs the counterflow and Kays–London analytic limits',
    'Length sweep (10 FD solutions) of ε, Δp, pumping and net benefit; media comparison at identical geometry',
    'Shared engine model with the same transient cell for both configurations (matched comparison, no double counting)',
  ],
  assumptions: [
    'Two identical matrix beds (or one rotary matrix) so both streams flow continuously; each bed blows hot then cold for t_b = 1/(2f)',
    'Regenerated stream capacity sized from the cells’ sensible heat per cycle × matching ratio; balanced blows',
    'Quasi-steady fluid in the FD core; with a liquid the void fluid capacity is comparable with the solid, so it is lumped into the bed capacity (local thermal equilibrium, valid because the bed NTU ≫ 1); switching dead volume outside the bed is a mixing loss χ',
    'Uniform flow over the frontal area; axial conduction checked through λ = k_eff A_fr/(L C_min) but not included in ε',
    'Coupling efficiency η_coupling (dead volume and cell-side flushing) is an estimate to be calibrated in the V4 regenerator integration test',
  ],
  ibc: {
    initial: ['Matrix uniform at (T_h + T_c)/2; iterated to cyclic steady state (initial state forgotten)'],
    boundary: ['Hot blow inlet T_h (fluid leaving cooling cells), cold blow inlet T_c (fluid leaving cells being heated), equal blow durations', 'Adiabatic matrix ends and casing'],
  },
  cvv: {
    calibration: ['Matrix Nu and f from single-blow transient and steady Δp tests', 'Coupling efficiency from calorimetric heat balance with and without the regenerator (V4)'],
    verification: ['FD energy balance Q_H + Q_C ≈ 0', 'ε → ε_cf(NTU₀) as matrix capacity → ∞', 'ε_FD ≤ ε_cf limit', 'Replay reproduces the core ε', 'No double counting: Q_hot,without − Q_hot,with = ε_eff·N·f·Q_sensible, P_gross unchanged', 'S_gen ≥ 0'],
    validation: ['Calorimetric heat balance and effectiveness verification (spec Module 09)', 'V4 gate: measured system net-efficiency improvement at matched boundary conditions'],
  },
  formats: { import: ['CSV single-blow outlet temperature history for matrix calibration', 'CSV Δp vs flow'], export: ['CSV of matrix field, sweeps and comparison', 'PNG/SVG charts', 'JSON coupling outputs'] },
  params: [
    { key: 'Th', label: 'Hot-blow inlet (hot fluid at the cells)', unit: '°C', type: 'number', min: 20, max: 200, step: 0.5, default: 70, group: 'Operating point', auto: (c) => { const t = c.upstream('s06')?.ThSupply_C; return Number.isFinite(t) ? { value: +t.toFixed(2), prov: 'coupled' } : { value: c.engine.Th, prov: 'calc' }; } },
    { key: 'Tc', label: 'Cold-blow inlet (coolant at the cells)', unit: '°C', type: 'number', min: -10, max: 80, step: 0.5, default: 15, group: 'Operating point', auto: (c) => { const t = c.upstream('s07')?.TcSupply_C; return Number.isFinite(t) ? { value: +t.toFixed(2), prov: 'coupled' } : { value: c.engine.Tc, prov: 'calc' }; } },
    { key: 'regenFluid', label: 'Regenerator loop fluid', type: 'select', options: fluidOptions.filter(o => o.value !== 'fl-air'), default: 'fl-water', group: 'Operating point', auto: (c) => ({ value: c.engine.hotFluid, prov: 'calc' }) },
    { key: 'match', label: 'Stream capacity matching (ṁc_p·t_b ÷ N·C_sens)', unit: '', type: 'number', min: 0.3, max: 3, step: 0.05, default: 1, group: 'Operating point', help: '1 = the loop carries exactly the cells’ sensible heat capacity per blow.' },
    { key: 'matrixMat', label: 'Matrix material', type: 'select', options: MATRIX.map(m => ({ value: m.id, label: m.name })), default: 'ss-mesh-regen', group: 'Matrix', auto: (c) => { const m = c.material('regenMatrix'); return m && MATRIX.some(x => x.id === m.id) ? { value: m.id, prov: 'library' } : undefined; } },
    { key: 'porosity', label: 'Porosity φ (0 = library value)', unit: '', type: 'number', min: 0, max: 0.95, step: 0.01, default: 0, group: 'Matrix' },
    { key: 'dch', label: 'Wire diameter / foil channel gap (0 = library value)', unit: 'm', type: 'number', min: 0, max: 0.002, step: 0.00001, default: 0, group: 'Matrix' },
    { key: 'Afr', label: 'Frontal area per bed', unit: 'm²', type: 'number', min: 1e-4, max: 1, step: 0.0005, default: 0.004, group: 'Matrix' },
    { key: 'Lr', label: 'Matrix length', unit: 'm', type: 'number', min: 0.005, max: 1, step: 0.005, default: 0.06, group: 'Matrix' },
    { key: 'deadVol', label: 'Switching dead volume per bed (plenum, ports)', unit: 'mL', type: 'number', min: 0, max: 5000, step: 0.5, default: 1, group: 'Matrix', help: 'Fluid outside the bed that is pushed into the wrong stream at each flow reversal (mixing loss).' },
    { key: 'dpLoop', label: 'Loop piping & valves Δp', unit: 'Pa', type: 'number', min: 0, max: 2e5, step: 500, default: 6000, group: 'Matrix' },
    { key: 'coupling', label: 'Cell-side coupling efficiency η_coupling', unit: '', type: 'number', min: 0.3, max: 1, step: 0.01, default: 0.85, group: 'Matrix', help: 'Fraction of stream-level regenerated heat that reaches ribbons and walls (dead volume, flushing). Estimated — calibrate in the V4 test.' },
    { key: 'pumpEta', label: 'Pump efficiency', unit: '', type: 'number', min: 0.1, max: 0.9, step: 0.01, default: 0.45, group: 'Matrix', auto: (c) => ({ value: c.engine.pumpEta, prov: 'calc' }) },
    { key: 'pcmMin', label: 'PCM buffer duration', unit: 'min', type: 'number', min: 1, max: 600, step: 1, default: 15, group: 'Thermal storage (PCM)' },
    { key: 'pcmPinch', label: 'PCM pinch ΔT', unit: 'K', type: 'number', min: 0.5, max: 10, step: 0.5, default: 2, group: 'Thermal storage (PCM)' },
    { key: 'heatPrice', label: 'Heat price', unit: 'USD/MWh_th', type: 'number', min: 0, max: 500, step: 1, default: 40, group: 'Economics & sustainability' },
    { key: 'elecPrice', label: 'Electricity price', unit: 'USD/kWh', type: 'number', min: 0, max: 1, step: 0.01, default: 0.15, group: 'Economics & sustainability' },
    { key: 'nFD', label: 'FD matrix cells', unit: '', type: 'number', min: 8, max: 120, step: 2, default: 24, group: 'Numerics', expert: true },
    { key: 'stepsFD', label: 'FD minimum sub-steps per blow', unit: '', type: 'number', min: 8, max: 200, step: 2, default: 30, group: 'Numerics', expert: true },
    { key: 'maxCycles', label: 'FD maximum cycles', unit: '', type: 'number', min: 50, max: 20000, step: 50, default: 2000, group: 'Numerics', expert: true },
    { key: 'tol', label: 'FD cyclic-convergence tolerance', unit: 'K', type: 'number', min: 1e-9, max: 1e-3, step: 1e-7, default: 1e-6, group: 'Numerics', expert: true },
    { key: 'engNodes', label: 'Engine model through-thickness nodes', unit: '', type: 'number', min: 1, max: 6, step: 1, default: 2, group: 'Numerics', expert: true },
    { key: 'engSteps', label: 'Engine model steps per cycle', unit: '', type: 'number', min: 80, max: 400, step: 10, default: 150, group: 'Numerics', expert: true },
  ],
  presets: [
    { label: 'Stainless screens (reference)', values: { matrixMat: 'ss-mesh-regen', Afr: 0.004, Lr: 0.06 } },
    { label: 'Copper foam, short bed', values: { matrixMat: 'cu-foam', Afr: 0.006, Lr: 0.04 } },
    { label: 'Etched copper foil stack', values: { matrixMat: 'cu-c110', porosity: 0.5, dch: 0.0002, Lr: 0.05 } },
    { label: 'Undersized bed (pumping-dominated)', values: { Afr: 0.0008, Lr: 0.15 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const kpi = (label, value, unit, explain, prov = 'calc', status) => out.kpis.push({ label, value, unit, explain, prov, status });
    const d = designWith(ctx.engine, { Th: p.Th, Tc: p.Tc });
    const mat = getMat(d.alloy) || getMat('niti-lt'), mm = getMat(p.matrixMat) || getMat('ss-mesh-regen');
    // ---- engine without regeneration (reference cell) ----
    ctx.progress(0.05, 'engine without regeneration');
    const E0 = engineModel(designWith(d, { regenEff: 0 }), { mat, n: p.engNodes, stepsPerCycle: p.engSteps, cycles: 3 }); await pause(ctx);
    const N = d.nCells, f = d.freq, dT = d.Th - d.Tc, sens = E0.sensible, Csens = sens / Math.max(dT, 1e-9);
    const tb = 0.5 / f, fl = fluid(p.regenFluid, (d.Th + d.Tc) / 2), mcp = p.match * N * Csens / tb, mdot = mcp / fl.cp;
    const phi = p.porosity > 0 ? p.porosity : (mm.porosity ?? 0.5), dch = p.dch > 0 ? p.dch : (mm.dWire ?? 200e-6);
    const geo = matrixModel(mm, { Afr: p.Afr, L: p.Lr, phi, dch, mdot, fl });
    const Crs = geo.Cm / (mcp * tb), NTU0 = geo.hA / (2 * mcp), lam = geo.kEff * p.Afr / (p.Lr * mcp);
    // ---- periodic FD regenerator (shared core) ----
    ctx.progress(0.15, 'periodic matrix solution');
    const fdOpt = { n: p.nFD, Cm: geo.Cm, hA: geo.hA, mcpH: mcp, mcpC: mcp, ThIn: d.Th, TcIn: d.Tc, tb, steps: p.stepsFD, maxCycles: p.maxCycles, tol: p.tol };
    const FD = regeneratorFD(fdOpt); await pause(ctx);
    const converged = FD.residuals[FD.residuals.length - 1] < p.tol;
    const RP = replay(FD.Tm, fdOpt);
    const epsRP = RP.QH / (mcp * tb * dT), epsCF = effectivenessNTU(NTU0, 1, 'counter'), epsKL = epsCF * (1 - 1 / (9 * Crs ** 1.93));
    const chiOf = () => fl.rho * fl.cp * p.deadVol * 1e-6 / (mcp * tb), chi = chiOf(), epsFD = clamp(FD.eps, 0, 1), epsEff = clamp(epsFD * (1 - chi) * p.coupling, 0, 0.99);
    // ---- matched engine with regeneration (same cell → no double counting) ----
    ctx.progress(0.35, 'engine with regeneration');
    const E1 = engineModel(designWith(d, { regenEff: epsEff }), { mat, cell: E0.cell });
    const Q0 = E0.QhotTot, Q1 = E1.QhotTot, Qrec = Q0 - Q1;
    const Vdot = mdot / fl.rho, Ppump = pumpPower(2 * geo.dp + p.dpLoop, Vdot, p.pumpEta);
    const Pnet0 = E0.Pnet, Pnet1 = E1.Pnet - Ppump, eta0 = Q0 > 0 ? Pnet0 / Q0 : 0, eta1 = Q1 > 0 ? Pnet1 / Q1 : 0;
    const netBenefit = (eta1 - eta0) * Q0;
    const mRegen = 2 * geo.mass + 2 * fl.rho * geo.voidV, pSys0 = Pnet0 / E0.mSys, pSys1 = Pnet1 / (E0.mSys + mRegen);
    // pinch & exergy from the replay
    const avg = (tag) => { let s = 0, k = 0; RP.rec.blow.forEach((b, i) => { if (b === tag) { s += RP.rec.Tout[i]; k++; } }); return s / Math.max(1, k); };
    const ToutH = avg('H'), ToutC = avg('C'), pinchHot = d.Th - ToutC, pinchCold = ToutH - d.Tc, pinch = Math.min(pinchHot, pinchCold);
    const T0K = d.T0 + KELVIN, XdestHT = T0K * RP.Sgen / RP.period, Xdest = XdestHT + Ppump;
    const XrecHeat = Qrec * (1 - T0K / (((d.Th + d.Tc) / 2) + KELVIN)); // exergy content of recovered heat at the mean regenerator temperature
    // ---- ε-NTU map: FD vs analytic limits (normalised blows: ṁc_p = 1 W/K, t_b = 1 s) ----
    ctx.progress(0.5, 'ε-NTU verification map');
    const NTUs = [1, 2, 4, 8, 16], CRs = [1, 3, 10], mapFD = CRs.map(cr => NTUs.map(nt => regeneratorFD({ n: 16, Cm: cr, hA: 2 * nt, mcpH: 1, mcpC: 1, ThIn: 1, TcIn: 0, tb: 1, steps: 16, maxCycles: 800, tol: 1e-7 }).eps));
    await pause(ctx);
    const limOpt = { Cm: 100, hA: 2 * 4, mcpH: 1, mcpC: 1, ThIn: 1, TcIn: 0, tb: 1, steps: 16, maxCycles: 8000, tol: 1e-10 }, lim16 = regeneratorFD({ ...limOpt, n: 16 }), limFD = regeneratorFD({ ...limOpt, n: 32 });
    // ---- length sweep ----
    ctx.progress(0.6, 'length sweep');
    const Ls = linspace(p.Lr * 0.2, p.Lr * 3, 10).map(v => +v.toFixed(4));
    const sweep = Ls.map(L => { const g = matrixModel(mm, { Afr: p.Afr, L, phi, dch, mdot, fl }); const r = regeneratorFD({ ...fdOpt, n: 16, steps: 16, Cm: g.Cm, hA: g.hA, maxCycles: 1500 }); const ee = clamp(r.eps * (1 - chi) * p.coupling, 0, 0.99); const q1 = Q0 - ee * N * f * sens, pp = pumpPower(2 * g.dp + p.dpLoop, Vdot, p.pumpEta); return { L, eps: r.eps, epsEff: ee, dp: g.dp, Pp: pp, net: ((E0.Pnet - pp) / q1 - eta0) * Q0, mass: 2 * g.mass }; });
    await pause(ctx);
    const best = sweep[argmax(sweep.map(s => s.net))];
    // ---- storage media at identical geometry ----
    const media = MATRIX.map(m => { const ph = m.porosity ?? 0.5, dc = m.dWire ?? 200e-6, g = matrixModel(m, { Afr: p.Afr, L: p.Lr, phi: ph, dch: dc, mdot, fl }); const r = regeneratorFD({ ...fdOpt, n: 16, steps: 16, Cm: g.Cm, hA: g.hA, maxCycles: 1500 }); const ee = clamp(r.eps * (1 - chi) * p.coupling, 0, 0.99); const pp = pumpPower(2 * g.dp + p.dpLoop, Vdot, p.pumpEta), q1 = Q0 - ee * N * f * sens; return { id: m.id, name: m.name, kind: g.kind, eps: r.eps, epsEff: ee, dp: g.dp, mass: 2 * g.mass, cost: 2 * g.mass * (m.cost || 0), co2: 2 * g.mass * (m.co2 || 0), net: ((E0.Pnet - pp) / q1 - eta0) * Q0, Crs: g.Cm / (mcp * tb) }; });
    // ---- PCM (paraffin) ----
    const pcm = getMat('pcm-paraffin'), Tmelt = pcm?.Tm ?? 58, hfus = pcm?.hfus ?? 2e5, cpP = pcm?.cp ?? 2100;
    const epsPCM = Math.max(0, Math.min(d.Th - Tmelt - p.pcmPinch, Tmelt - d.Tc - p.pcmPinch) / dT), TmeltOpt = (d.Th + d.Tc) / 2, epsPCMopt = Math.max(0, (dT / 2 - p.pcmPinch) / dT);
    const AfH = mat.Af + d.sigmaH / mat.CA, pcmDrives = Tmelt >= AfH + p.pcmPinch && Tmelt <= d.Th - p.pcmPinch;
    const mPCM = Q1 * p.pcmMin * 60 / (hfus + cpP * 10), VPCM = mPCM / (pcm?.rho || 820);
    // ---- verification ----
    out.checks.push({ name: 'FD energy balance (Q_H + Q_C)/Q_H', value: FD.balance, target: '|·| < 1e-4', pass: Math.abs(FD.balance) < 1e-4, detail: `Q_H = ${fmt(FD.QH, 5)} J, Q_C = ${fmt(FD.QC, 5)} J per blow` });
    out.checks.push({ name: 'Cyclic steady state reached', value: FD.residuals[FD.residuals.length - 1], target: `< ${p.tol} K after ≤ ${p.maxCycles} cycles`, pass: converged, detail: `${FD.cycles} cycles` });
    out.checks.push({ name: 'Replay reproduces the core effectiveness', value: Math.abs(epsRP - FD.eps), target: '< 1e-5', pass: Math.abs(epsRP - FD.eps) < 1e-5, detail: `replay ε = ${fmt(epsRP, 7)}, core ε = ${fmt(FD.eps, 7)}; periodic drift ${fmt(Math.max(...RP.Tm.map((v, i) => Math.abs(v - FD.Tm[i]))), 3)} K` });
    { const lim = effectivenessNTU(4, 1, 'counter') * (1 - 1 / (9 * 100 ** 1.93)), e1 = Math.abs(lim16.eps - lim), e2 = Math.abs(limFD.eps - lim), order = Math.log2(e1 / Math.max(e2, 1e-15));
      out.checks.push({ name: 'Limit ε → ε-NTU counterflow as matrix capacity → ∞ (NTU₀ = 4, C_r* = 100)', value: limFD.eps, target: `${fmt(lim, 6)} ± 0.2 %`, pass: e2 / lim < 2e-3, detail: `FD (32 cells) ${fmt(limFD.eps, 6)} after ${limFD.cycles} cycles; NTU₀ = hA/(2C_min) for one matrix serving both blows (Kays–London capacity correction ${fmt(1 / (9 * 100 ** 1.93), 2)})` });
      out.checks.push({ name: 'Spatial convergence of the FD effectiveness (16 → 32 cells)', value: order, target: 'observed order ≥ 1', pass: order >= 1, detail: `error ${fmt(e1, 3)} → ${fmt(e2, 3)}; the design run uses ${p.nFD} cells` }); }
    out.checks.push({ name: 'Finite matrix capacity cannot exceed the counterflow limit', value: FD.eps, target: `≤ ${fmt(effectivenessNTU(NTU0, 1, 'counter'), 5)}`, pass: FD.eps <= epsCF + 1e-3 });
    { const expect = epsEff * N * f * sens; out.checks.push({ name: 'No double counting: Q_hot,without − Q_hot,with = ε_eff·N·f·Q_sens', value: Math.abs(Qrec - expect) / Math.max(1, expect), target: '< 1e-9 (relative)', pass: Math.abs(Qrec - expect) / Math.max(1, expect) < 1e-9, detail: `${fmt(Qrec, 6)} W vs ${fmt(expect, 6)} W; latent heat ${fmt(E0.latent, 4)} J/cycle is excluded from regeneration` }); }
    out.checks.push({ name: 'Gross work unchanged by regeneration (same cell)', value: Math.abs(E1.Pgross - E0.Pgross), target: '0 W', pass: Math.abs(E1.Pgross - E0.Pgross) < 1e-12 });
    out.checks.push({ name: 'Second law: S_gen ≥ 0 over a cycle', value: RP.Sgen, target: '≥ 0 J/K', pass: RP.Sgen >= -1e-12, detail: `X_dest(heat transfer) = ${fmt(XdestHT, 4)} W` });
    out.checks.push({ name: 'Efficiency with regeneration ≤ Carnot', value: eta1, target: `≤ ${fmt(carnot(d.Th, d.Tc), 4)}`, pass: eta1 <= carnot(d.Th, d.Tc) + 1e-12 });
    // ---- KPIs ----
    const st = (ok, warn) => ok ? 'ok' : warn ? 'warn' : 'bad';
    kpi('Regenerator effectiveness (matrix, FD)', epsFD, '', `Periodic finite-difference solution: NTU₀ = ${fmt(NTU0, 3)}, C_r* = ${fmt(Crs, 3)} (matrix/stream capacity), ${FD.cycles} cycles to cyclic steady state. Analytic counterflow limit ${fmt(epsCF, 4)}, Kays–London ${fmt(epsKL, 4)}.`, 'calc', st(epsFD >= 0.8, epsFD >= 0.6));
    kpi('Effective cell-level effectiveness ε_eff', epsEff, '', `ε_FD × (1 − dead-volume mixing χ = ${fmt(chi, 3)}) × coupling ${p.coupling} — the value applied to the cells’ sensible heat in the engine model (published to Suite 06 and the engine design).`, 'calc', st(epsEff >= 0.6, epsEff >= 0.3));
    kpi('Heat recovered', Qrec, 'W', `Reduction in external heat input: ε_eff × N × f × sensible heat per cell (${fmt(sens, 4)} J/cycle). Latent heat (${fmt(E0.latent, 4)} J/cycle) is never recovered.`);
    kpi('Pinch (closest stream approach)', pinch, 'K', `min(hot-end approach T_h − T̄_c,out = ${fmt(pinchHot, 3)} K, cold-end approach T̄_h,out − T_c = ${fmt(pinchCold, 3)} K).`);
    kpi('Matrix pressure drop per blow', geo.dp, 'Pa', `${geo.kind} at Re = ${fmt(geo.Re, 3)}, pore velocity ${fmt(geo.up * 1000, 3)} mm/s; plus ${p.dpLoop} Pa loop piping.`, 'calc', st(geo.dp < 2e4, geo.dp < 1e5));
    kpi('Regenerator pumping penalty', Ppump, 'W', `(2Δp_matrix + Δp_loop)·V̇/η at ${fmt(mdot * 1000, 4)} g/s — added to the engine auxiliaries.`, 'calc', st(Ppump < 0.1 * Math.max(Pnet0, 1e-9), Ppump < Math.max(Pnet0, 0)));
    kpi('Net benefit at matched source heat', netBenefit, 'W', `(η_with − η_without) × Q_hot,without: how much more net power the same source heat buys with the regenerator (η ${fmt(100 * eta0, 4)} % → ${fmt(100 * eta1, 4)} %). Negative means regeneration worsens total power (spec §40).`, 'calc', st(netBenefit > 0));
    kpi('Exergy destroyed in the regenerator', Xdest, 'W', `Heat transfer across finite ΔT (${fmt(XdestHT, 4)} W) + pumping dissipation (${fmt(Ppump, 3)} W), dead state ${d.T0} °C.`);
    kpi('Regenerator mass (2 beds + fluid)', mRegen, 'kg', `${mm.name}; system specific net power ${fmt(pSys0, 4)} → ${fmt(pSys1, 4)} W/kg (system mass basis).`, 'library', st(pSys1 >= pSys0, true));
    // ---- verdicts ----
    const V = (test, status, detail, fix) => out.verdicts.push({ test, status, detail, fix });
    V('Regeneration improves whole-engine efficiency (matched comparison)', netBenefit > 0 ? 'pass' : 'fail', `Without: η = ${fmt(100 * eta0, 4)} %, Q_hot = ${fmt(Q0, 4)} W. With: η = ${fmt(100 * eta1, 4)} %, Q_hot = ${fmt(Q1, 4)} W, pump +${fmt(Ppump, 3)} W. Net benefit ${fmt(netBenefit, 4)} W at matched source heat.`, best.net > netBenefit ? `Change the matrix length to ≈ ${fmt(best.L * 1000, 3)} mm (sweep optimum, +${fmt(best.net - netBenefit, 3)} W) or enlarge the frontal area to cut Δp.` : 'Reduce Δp (larger frontal area, coarser matrix) or omit the regenerator.');
    V('Fixed engine: net power with regeneration', Pnet1 >= Pnet0 * 0.98 ? 'pass' : Pnet1 > 0 ? 'warn' : 'fail', `With the same cells, regeneration saves ${fmt(Qrec, 4)} W of heat but costs ${fmt(Ppump, 3)} W of pumping: P_net ${fmt(Pnet0, 4)} → ${fmt(Pnet1, 4)} W. It only pays when heat is scarce or costly.`, 'Minimise loop Δp; use variable-speed pumping.');
    V('Matrix capacity ratio C_r* ≥ 3', Crs >= 3 ? 'pass' : Crs >= 1 ? 'warn' : 'fail', `C_r* = ${fmt(Crs, 3)} (solid ${fmt(geo.Cs, 4)} + trapped liquid ${fmt(geo.Cf, 4)} J/K vs ${fmt(mcp * tb, 4)} J/K per blow): the bed temperature swings ${Crs < 3 ? 'strongly' : 'modestly'} during each blow (utilisation 1/C_r* = ${fmt(1 / Crs, 3)}).`, `Increase matrix mass (length/area) to C_r* ≥ 3, i.e. ≥ ${fmt(3 * mcp * tb / mm.cp, 3)} kg per bed.`);
    V('Axial conduction negligible (λ < 0.01)', lam < 0.01 ? 'pass' : lam < 0.05 ? 'warn' : 'fail', `λ = k_eff·A_fr/(L·C_min) = ${fmt(lam, 3)} (k_eff = ${fmt(geo.kEff, 3)} W/mK). Not included in the FD ε, so ε is optimistic by ≈ λ when λ is not small.`, 'Use a lower-conductivity matrix (screens/polymers) or a longer bed; avoid solid copper stacks.');
    V('Switching dead-volume mixing small (χ < 0.05)', chi < 0.05 ? 'pass' : chi < 0.15 ? 'warn' : 'fail', `${p.deadVol} mL of plenum/port fluid = ${fmt(chi * 100, 3)} % of the blow capacity is mixed into the wrong stream at each reversal. Bed void fluid (${fmt(geo.voidV * 1e6, 4)} mL) stays with the thermal wave and adds ${fmt(geo.Cf, 4)} J/K to the bed capacity (solid ${fmt(geo.Cs, 4)} J/K).`, 'Shorten plenums and integrate the reversing valve at the bed face.');
    V('Cyclic convergence of the FD model', converged ? 'pass' : 'warn', `Residual ${fmt(FD.residuals[FD.residuals.length - 1], 3)} K after ${FD.cycles} cycles.`, 'Increase the maximum cycle count (expert).');
    V('PCM buffer temperature compatibility', pcmDrives ? 'pass' : 'warn', `${pcm?.name || 'Paraffin'} melts at ${Tmelt} °C: ${pcmDrives ? 'between Af(σH) and T_h — can buffer the hot supply.' : `outside [Af(σH) + ΔT_p, T_h − ΔT_p] = [${fmt(AfH + p.pcmPinch, 3)}, ${fmt(d.Th - p.pcmPinch, 3)}] °C — it cannot drive the power stroke; as a regenerative store it recovers at most ε = ${fmt(epsPCM, 3)} (optimum melt ${fmt(TmeltOpt, 3)} °C gives ${fmt(epsPCMopt, 3)}).`}`, 'Choose a PCM melting above Af(σH) + pinch for hot-side buffering, or a cascade of PCMs for regeneration.');
    V('Missing measurements (requested)', 'info', 'No regenerator test data imported. Measure: single-blow outlet temperature response (Nu calibration), Δp vs flow of the matrix, and calorimetric engine heat input with and without the regenerator at matched boundary conditions (V4).', 'Import data to calibrate Nu, f and the coupling efficiency.');
    // ---- charts ----
    const nx = p.nFD, xs = range(nx).map(i => (i + 0.5) / nx * p.Lr * 1000);
    out.charts.push({ type: 'heatmap', title: 'Matrix temperature over position and time (one converged cycle)', x: { label: 'Position from hot end [mm]', values: xs }, y: { label: 'Time in cycle [s]', values: RP.rec.t }, z: RP.rec.field, zlabel: 'T_matrix [°C]', cmap: 'inferno', isolines: 7, explain: `Cyclic-steady matrix field: hot blow (first ${fmt(tb, 3)} s, flow from the hot end) charges the matrix; cold blow (reverse flow) discharges it. Isolines tilting across the bed show the thermal wave; a wave that reaches the far end means the bed is undersized (low C_r*).`, wide: true });
    out.charts.push({ type: 'line', title: 'Outlet stream temperatures over the cycle', x: { label: 'Time in cycle', unit: 's' }, y: { label: 'Temperature', unit: '°C' }, series: [{ name: 'Outlet (hot blow → leaves cold end)', x: RP.rec.t.filter((_, i) => RP.rec.blow[i] === 'H'), y: RP.rec.Tout.filter((_, i) => RP.rec.blow[i] === 'H') }, { name: 'Outlet (cold blow → leaves hot end)', x: RP.rec.t.filter((_, i) => RP.rec.blow[i] === 'C'), y: RP.rec.Tout.filter((_, i) => RP.rec.blow[i] === 'C') }], annotations: [{ type: 'hline', y: d.Th, label: 'T_h in' }, { type: 'hline', y: d.Tc, label: 'T_c in' }], explain: `The cold-blow outlet is the pre-heated stream delivered to cells about to heat; its average ${fmt(ToutC, 4)} °C vs T_h = ${d.Th} °C is the hot-end pinch. The hot-blow outlet (pre-cooled stream) averages ${fmt(ToutH, 4)} °C.` });
    out.charts.push({ type: 'line', title: 'ε vs NTU₀: FD model vs analytic limits', x: { label: 'NTU₀ = hA/(2C_min)', log: true }, y: { label: 'Effectiveness ε' }, series: [{ name: 'Counterflow limit (C_r* → ∞)', x: linspace(0.5, 20, 40), y: linspace(0.5, 20, 40).map(v => effectivenessNTU(v, 1, 'counter')), dash: true }, ...CRs.map((cr, k) => ({ name: `FD, C_r* = ${cr}`, x: NTUs, y: mapFD[k], mode: 'markers' })), ...CRs.map(cr => ({ name: `Kays–London, C_r* = ${cr}`, x: linspace(0.5, 20, 40), y: linspace(0.5, 20, 40).map(v => effectivenessNTU(v, 1, 'counter') * (1 - 1 / (9 * cr ** 1.93))) }))], annotations: [{ type: 'point', x: NTU0, y: epsFD, label: 'design' }], explain: 'Verification map: markers are the shared FD model, lines the analytic counterflow limit and the Kays–London finite-capacity correction. Agreement at high C_r* verifies the scheme; at low C_r* the matrix saturates and ε falls regardless of NTU — more surface cannot fix a matrix that is too light.' });
    out.charts.push({ type: 'line', title: 'Matrix length sweep: effectiveness, pumping and net benefit', x: { label: 'Matrix length', unit: 'mm' }, y: { label: 'W  (ε × 10 for scale)' }, series: [{ name: 'Net benefit at matched heat [W]', x: Ls.map(v => v * 1000), y: sweep.map(s => s.net) }, { name: 'Pumping [W]', x: Ls.map(v => v * 1000), y: sweep.map(s => s.Pp) }, { name: 'ε_eff × 10', x: Ls.map(v => v * 1000), y: sweep.map(s => 10 * s.epsEff), dash: true }], annotations: [{ type: 'vline', x: p.Lr * 1000, label: 'current' }, { type: 'vline', x: best.L * 1000, label: 'optimum' }, { type: 'hline', y: 0, label: 'break-even' }], explain: `Longer beds raise ε (more area, more capacity) but pressure drop and pumping rise linearly. The optimum (${fmt(best.L * 1000, 3)} mm, ${fmt(best.net, 4)} W) balances heat saved against pump work — the whole-engine criterion of the spec, not maximum heat recovery.` });
    out.charts.push({ type: 'bar', title: 'Storage / matrix media at identical geometry', categories: [...media.map(m => m.name.split(' (')[0].split(' —')[0]), 'Paraffin PCM (single T)'], series: [{ name: 'ε_eff', values: [...media.map(m => +m.epsEff.toFixed(4)), +(epsPCM * p.coupling).toFixed(4)] }, { name: 'Δp per blow [kPa]', values: [...media.map(m => +(m.dp / 1000).toFixed(3)), NaN] }, { name: 'Net benefit [W]', values: [...media.map(m => +m.net.toFixed(3)), NaN] }], explain: `Same frontal area and length for every medium. Dense metal matrices store more heat (high C_r*) but solid metal stacks conduct axially; foams have low Δp but little capacity. A single-melting-point PCM can recover at most ${fmt(epsPCMopt, 3)} of the sensible heat even at the optimum melt temperature — cascades are needed.`, wide: true });
    out.charts.push({ type: 'bar', title: 'Heat and power ledger: without vs with regenerator', categories: ['External heat Q_hot', 'Heat recovered', 'Gross work ×100', 'Pumping (regen) ×100', 'Net power ×100'], series: [{ name: 'Without', values: [Q0, 0, E0.Pgross * 100, 0, Pnet0 * 100].map(v => +v.toFixed(2)) }, { name: 'With', values: [Q1, Qrec, E1.Pgross * 100, Ppump * 100, Pnet1 * 100].map(v => +v.toFixed(2)) }], explain: 'Matched configurations using the same transient cell: regeneration only changes the external heat (and adds pumping); gross work is identical — so it raises efficiency, never the gross output. Powers are ×100 for visibility.' });
    out.convergence = { title: 'Regenerator cyclic-convergence history (max |ΔT_m| per cycle)', series: [{ name: 'Design matrix', x: FD.residuals.map((_, i) => i + 1), y: FD.residuals.map(v => Math.max(v, 1e-14)) }] };
    // ---- tables ----
    out.tables.push({ title: 'Regenerator design point', cols: ['Quantity', 'Value', 'Unit'], rows: [['Matrix', `${mm.name} (${geo.kind})`, ''], ['Porosity / d_w or gap', `${fmt(phi, 3)} / ${fmt(dch * 1e6, 4)}`, '– / µm'], ['Frontal area × length (per bed)', `${p.Afr} × ${p.Lr}`, 'm² × m'], ['Blow time t_b', fmt(tb, 4), 's'], ['Stream ṁ / ṁc_p', `${fmt(mdot, 4)} / ${fmt(mcp, 4)}`, 'kg/s / W/K'], ['Re / Nu / f', `${fmt(geo.Re, 4)} / ${fmt(geo.Nu, 4)} / ${fmt(geo.f, 4)}`, ''], ['h / hA', `${fmt(geo.h, 4)} / ${fmt(geo.hA, 4)}`, 'W/m²K / W/K'], ['NTU₀ / C_r* / λ / χ', `${fmt(NTU0, 4)} / ${fmt(Crs, 4)} / ${fmt(lam, 3)} / ${fmt(chi, 3)}`, ''], ['ε FD / counterflow / Kays–London', `${fmt(epsFD, 5)} / ${fmt(epsCF, 5)} / ${fmt(epsKL, 5)}`, ''], ['ε_eff (applied)', fmt(epsEff, 4), ''], ['Outlet means (hot blow / cold blow)', `${fmt(ToutH, 4)} / ${fmt(ToutC, 4)}`, '°C'], ['Δp per blow / loop', `${fmt(geo.dp, 4)} / ${p.dpLoop}`, 'Pa'], ['Pumping', fmt(Ppump, 4), 'W'], ['Mass (2 beds + fluid)', fmt(mRegen, 4), 'kg'], ['Material cost / CO₂', `${fmt(2 * geo.mass * (mm.cost || 0), 4)} USD / ${fmt(2 * geo.mass * (mm.co2 || 0), 4)} kg`, '']], explain: 'All matrix quantities at the design flow; library properties for the matrix (not lot-certified).' });
    out.tables.push({ title: 'Matched comparison (same cell, same boundary temperatures)', cols: ['Quantity', 'Without regenerator', 'With regenerator'], rows: [['ε_eff', 0, fmt(epsEff, 4)], ['External heat Q_hot [W]', fmt(Q0, 5), fmt(Q1, 5)], ['Gross power [W]', fmt(E0.Pgross, 5), fmt(E1.Pgross, 5)], ['Auxiliaries [W]', fmt(E0.Paux, 4), fmt(E0.Paux + Ppump, 4)], ['Net power [W]', fmt(Pnet0, 5), fmt(Pnet1, 5)], ['η_th [%]', fmt(100 * eta0, 4), fmt(100 * eta1, 4)], ['Carnot fraction', fmt(eta0 / carnot(d.Th, d.Tc), 4), fmt(eta1 / carnot(d.Th, d.Tc), 4)], ['System mass [kg]', fmt(E0.mSys, 4), fmt(E0.mSys + mRegen, 4)], ['System specific power [W/kg]', fmt(pSys0, 4), fmt(pSys1, 4)], ['Net at matched source heat [W]', fmt(Pnet0, 5), fmt(eta1 * Q0, 5)]], explain: 'Spec §40 requires matched configurations with all fluid/pressure losses: same transient cell, same reservoirs, regenerator pumping added to the auxiliaries and its mass to the system mass.' });
    out.tables.push({ title: 'Storage media comparison', cols: ['Medium', 'Type', 'C_r*', 'ε FD', 'ε_eff', 'Δp [Pa]', 'Mass [kg]', 'Cost [USD]', 'CO₂ [kg]', 'Net benefit [W]'], rows: [...media.map(m => [m.name, m.kind, fmt(m.Crs, 3), fmt(m.eps, 4), fmt(m.epsEff, 4), fmt(m.dp, 4), fmt(m.mass, 3), fmt(m.cost, 3), fmt(m.co2, 3), fmt(m.net, 3)]), [pcm?.name || 'Paraffin PCM', `latent, T_m = ${Tmelt} °C`, '—', fmt(epsPCM, 3), fmt(epsPCM * p.coupling, 3), '—', fmt(mPCM, 3) + ' (buffer)', fmt(mPCM * (pcm?.cost || 3), 3), fmt(mPCM * (pcm?.co2 || 1.8), 3), '—']], explain: `Matrices at identical geometry. PCM row: single-temperature regenerative limit and the mass for a ${p.pcmMin}-min buffer of the regenerated engine’s heat demand (${fmt(VPCM * 1000, 3)} L, latent + 10 K sensible).` });
    // ---- narrative & recommendations ----
    out.explain.push({ title: 'What was computed', text: `The cells’ sensible heat (${fmt(sens, 4)} J per cell per cycle, latent ${fmt(E0.latent, 4)} J excluded) sets the regenerator stream capacity ${fmt(mcp, 4)} W/K at ${fmt(f, 3)} Hz. The shared periodic FD model converged in ${FD.cycles} cycles to ε = ${fmt(epsFD, 4)}; after carry-over and cell-side coupling ε_eff = ${fmt(epsEff, 4)} is applied to the engine model.` });
    out.explain.push({ title: 'Does regeneration help?', text: `It recovers ${fmt(Qrec, 4)} W (${fmt(100 * Qrec / Q0, 3)} % of the external heat) and costs ${fmt(Ppump, 3)} W of pumping and ${fmt(mRegen, 3)} kg. At matched source heat the net benefit is ${fmt(netBenefit, 4)} W; with fixed cells the net power changes by ${fmt(Pnet1 - Pnet0, 3)} W. Regeneration raises efficiency, not gross work.` });
    const rec = (level, text, basis) => out.recs.push({ level, text, basis });
    if (netBenefit <= 0) rec('critical', `Regeneration worsens total power at matched source heat (${fmt(netBenefit, 4)} W): pumping ${fmt(Ppump, 3)} W outweighs the efficiency gain. ${best.net > 0 ? `A ${fmt(best.L * 1000, 3)} mm bed would give +${fmt(best.net, 3)} W.` : 'No length in the sweep pays back — enlarge the frontal area or omit the regenerator.'}`, 'Matched comparison and length sweep');
    else rec('good', `Regeneration adds ${fmt(netBenefit, 4)} W at matched source heat (η ${fmt(100 * eta0, 3)} → ${fmt(100 * eta1, 3)} %).${Math.abs(best.L - p.Lr) / p.Lr > 0.15 ? ` The sweep optimum is ${fmt(best.L * 1000, 3)} mm (+${fmt(best.net - netBenefit, 3)} W).` : ''}`, 'Matched comparison');
    if (Crs < 3) rec('warn', `Matrix capacity ratio C_r* = ${fmt(Crs, 3)} is low; the matrix saturates within a blow. Add mass (≥ ${fmt(3 * mcp * tb / mm.cp, 3)} kg per bed).`, 'Kays–London correction');
    if (lam >= 0.01) rec('warn', `Axial conduction λ = ${fmt(lam, 3)} will erode ε by ≈ ${fmt(100 * lam, 3)} points; use screens or polymer-bonded media.`, 'Axial conduction parameter');
    rec('info', `Hot-end pinch ${fmt(pinchHot, 3)} K: pre-heated fluid reaches cells at ${fmt(ToutC, 4)} °C; the external source must still supply the last ${fmt(pinchHot, 3)} K plus all latent heat.`, 'Replay outlet temperatures');
    const saveUSD = Qrec / 1e6 * p.heatPrice * 8760, pumpUSD = Ppump / 1000 * p.elecPrice * 8760;
    rec('econ', `Heat saved is worth ${fmt(saveUSD, 4)} USD/yr at ${p.heatPrice} USD/MWh; regenerator pumping costs ${fmt(pumpUSD, 4)} USD/yr at ${p.elecPrice} USD/kWh; matrix material ≈ ${fmt(2 * geo.mass * (mm.cost || 0), 4)} USD. ${saveUSD > pumpUSD ? `Simple material payback ≈ ${fmt(2 * geo.mass * (mm.cost || 0) / Math.max(1e-9, saveUSD - pumpUSD), 3)} yr (continuous operation).` : 'Pumping cost exceeds heat value — not economic at this heat price.'}`, 'Heat and electricity prices');
    rec('sustain', `Matrix embodied CO₂ ≈ ${fmt(2 * geo.mass * (mm.co2 || 0), 3)} kg (${mm.name}). ${media.filter(m => m.net > 0).sort((a, b) => a.co2 - b.co2)[0] ? `Lowest-carbon medium with positive benefit: ${media.filter(m => m.net > 0).sort((a, b) => a.co2 - b.co2)[0].name}.` : 'No medium gives a positive matched benefit at this geometry.'} Paraffin buffers are cheap (${fmt(mPCM, 3)} kg for ${p.pcmMin} min) but flammable — encapsulate.`, 'Media comparison');
    const anim = { RP, xs, tb, Th: d.Th, Tc: d.Tc };
    out.views.push({ label: '2D animation: matrix thermal wave', icon: '🎞', render: (el) => animMatrix(el, anim) });
    out.outputs = { regenEff: epsEff, Qrecovered_W: Qrec, pinch_K: pinch, dpRegen_Pa: 2 * geo.dp + p.dpLoop, Ppump_regen_W: Ppump, netBenefit_W: netBenefit };
    out.headline = `Regenerator ε = ${fmt(epsFD, 4)} (effective ${fmt(epsEff, 4)}) recovers ${fmt(Qrec, 4)} W; pumping ${fmt(Ppump, 3)} W; net benefit at matched source heat ${fmt(netBenefit, 4)} W — regeneration ${netBenefit > 0 ? 'improves' : 'WORSENS'} whole-engine performance.`;
    out.headlineKind = netBenefit > 0 ? (converged ? 'ok' : 'warn') : 'fail';
    out.credibility = 'Analytical screening';
    return out;
  },
};

async function animMatrix(el, A) {
  const [{ anim2d, seriesPanel, arrow, label, fs, at, theme }, { cmap }] = await Promise.all([import('../core/anim2d.js'), import('../core/chart.js')]);
  const R = A.RP.rec, T = R.t, P = A.RP.period, lo = A.Tc, hi = A.Th, col = (v) => `rgb(${cmap(clamp((v - lo) / (hi - lo), 0, 1), 'inferno').map(Math.round).join(',')})`;
  const prof = (k) => R.field[k];
  anim2d(el, { duration: P, rate: P / 8, label: 'Time in cycle', unit: 's', height: (W) => W < 640 ? 480 : 440, explain: 'Converged matrix temperature field replayed over one cycle: during the hot blow the thermal front advances from the hot end; during the cold blow it is pushed back. The lower panel shows the outlet stream temperatures on the same time axis.', draw(g, t, W, H) {
    const th = theme(), k = at(T, t), i = Math.min(T.length - 1, k.i + (k.f > 0.5 ? 1 : 0)), Tm = prof(i), hot = R.blow[i] === 'H', z = fs(W);
    const x0 = W < 640 ? 14 : 40, y0 = 26, w = W - 2 * x0, hh = W < 640 ? 50 : 66, n = Tm.length;
    for (let j = 0; j < n; j++) { g.fillStyle = col(Tm[j]); g.fillRect(x0 + j * w / n, y0, w / n + 1, hh); }
    g.strokeStyle = th.fg; g.strokeRect(x0, y0, w, hh);
    label(g, 'hot end', x0, y0 - 6, { size: z - 1, color: th.mute }); label(g, 'cold end', x0 + w, y0 - 6, { align: 'right', size: z - 1, color: th.mute });
    const ay = y0 + hh + 12;
    if (hot) arrow(g, x0 + 10, ay, w - 20, 0, '#ef4444', 3); else arrow(g, x0 + w - 10, ay, -(w - 20), 0, '#38bdf8', 3);
    label(g, hot ? 'hot blow →' : '← cold blow', x0 + w / 2, ay + 6, { align: 'center', baseline: 'top', size: z, weight: '600', color: hot ? '#ef4444' : '#38bdf8', bg: true, pad: 2 });
    const py = ay + 26, ph = (H - py - 12) / 2;
    g.strokeStyle = th.grid; g.fillStyle = th.bg2; g.fillRect(x0, py, w, ph - 4); g.strokeRect(x0, py, w, ph - 4);
    const yTxt = label(g, `matrix profile — ${fmt(Tm[0], 4)} °C (hot end) … ${fmt(Tm[n - 1], 4)} °C (cold end)`, x0 + 6, py + 4, { baseline: 'top', size: z, weight: '600', maxW: w - 12 }), pT = yTxt.y + yTxt.h + 6, pB = py + ph - 10;
    g.strokeStyle = th.grid; g.beginPath(); g.moveTo(x0, pT - 3); g.lineTo(x0 + w, pT - 3); g.stroke();
    g.strokeStyle = '#facc15'; g.lineWidth = 2; g.beginPath(); for (let j = 0; j < n; j++) { const px = x0 + (j + 0.5) * w / n, pyy = pB - (Tm[j] - lo) / (hi - lo) * (pB - pT); j ? g.lineTo(px, pyy) : g.moveTo(px, pyy); } g.stroke(); g.lineWidth = 1;
    seriesPanel(g, { x: x0, y: py + ph, w, h: ph, T, t, title: 'Outlet temperature', unit: '°C', series: [{ name: 'outlet', y: R.Tout, color: '#22c55e' }], hlines: [{ y: A.Th, label: 'T_h', color: '#ef4444' }, { y: A.Tc, label: 'T_c', color: '#3b82f6' }] });
  } });
}
