// Suite 04 — Phase transformation and SMA microstructure.
// Martensite-fraction histories under prescribed temperature/stress programmes, ξ–T hysteresis at several stresses,
// Clausius–Clapeyron stress shift (recovered by fitting), through-thickness phase-front proxy ξ(x,t) from a transient
// conduction solve with latent heat, isobaric work loop, superelastic dissipation and kinetics-law comparison.
import { SMA, kinStep, quasiStaticCycle, tensileTest, phaseDiagram, cellTransient } from '../core/sma.js';
import { slab1D } from '../core/heat.js';
import { get as getMat } from '../core/materials.js';
import { linspace, fmt, levenbergMarquardt, range, clamp, max, min } from '../core/num.js';

const KELVIN = 273.15;
const CARD = [['Ms', 'M_s (zero stress)', '°C'], ['Mf', 'M_f (zero stress)', '°C'], ['As', 'A_s (zero stress)', '°C'], ['Af', 'A_f (zero stress)', '°C'], ['CM', 'Stress coefficient C_M', 'MPa/K'], ['CA', 'Stress coefficient C_A', 'MPa/K'], ['sigS', 'Detwinning start σ_s', 'MPa'], ['sigF', 'Detwinning finish σ_f', 'MPa'], ['epsL', 'Recoverable strain ε_L', '–'], ['Lh', 'Latent heat L_h', 'J/kg']];
const baseAlloy = (ctx) => getMat(ctx.upstream('s03')?.alloyId) || getMat(ctx.engine.alloy) || getMat('niti-lt');
const cardAuto = (k) => (ctx) => { const c = ctx.upstream('s03')?.card; if (c && Number.isFinite(c[k])) return { value: c[k], prov: 'coupled' }; const m = baseAlloy(ctx); return m && Number.isFinite(m[k]) ? { value: m[k], prov: 'library' } : undefined; };
const eng = (k, s = 1) => (ctx) => ctx.engine[k] === undefined ? undefined : { value: +(ctx.engine[k] / s).toPrecision(10), prov: 'calc' };
const tick = (ctx) => Promise.resolve().then(() => ctx.yield()).catch(() => {});
const down = (a, n = 400) => { const k = Math.max(1, Math.ceil(a.length / n)); return a.filter((_, i) => i % k === 0); };

// slow isothermal-step sweeps at constant stress → detected transformation start/finish temperatures
function detectTemps(m, s, dT = 0.05) {
  const x = new SMA(m, { kinetics: 'cosine' }), t = x.temps(s), lo = t.Mf - 10, hi = t.Af + 10; x.xi = 1; x.xis = 0; x.update(lo, s);
  let As, Af, Ms, Mf; const up = [], dn = [];
  for (let T = lo; T <= hi + 1e-9; T += dT) { const xi = x.update(T, s); up.push([T, xi]); if (As === undefined && xi < 1 - 1e-6) As = T; if (Af === undefined && xi <= 1e-6) Af = T; }
  for (let T = hi; T >= lo - 1e-9; T -= dT) { const xi = x.update(T, s); dn.push([T, xi]); if (Ms === undefined && xi > 1e-6) Ms = T; if (Mf === undefined && xi >= 1 - 1e-6) Mf = T; }
  return { As, Af, Ms, Mf, up, dn, closure: Math.abs(dn[dn.length - 1][1] - up[0][1]) };
}
// triangle or sine temperature programme at constant stress
function program(m, { Tmin, Tmax, rate, cycles, shape, s, kinetics }) {
  const half = (Tmax - Tmin) / rate, P = 2 * half, nStep = Math.max(200, Math.ceil(cycles * 2 * (Tmax - Tmin) / 0.2)), dt = cycles * P / nStep;
  const x = new SMA(m, { kinetics }).prepare(Tmin, s), o = { t: [], T: [], xi: [], xis: [], eps: [] };
  for (let i = 0; i <= nStep; i++) {
    const t = i * dt, ph = (t % P) / P, T = shape === 'sine' ? Tmin + (Tmax - Tmin) * 0.5 * (1 - Math.cos(2 * Math.PI * ph)) : Tmin + (Tmax - Tmin) * (ph < 0.5 ? 2 * ph : 2 - 2 * ph);
    x.update(T, s); o.t.push(t); o.T.push(T); o.xi.push(x.xi); o.xis.push(x.xis); o.eps.push(x.strain(s, T));
  }
  return { ...o, P, half };
}

export default {
  description: 'Solves the internal-variable shape-memory transformation law under prescribed temperature and stress histories: martensite-fraction histories, ξ–T hysteresis at several stresses, Clausius–Clapeyron stress shift, a through-thickness phase-front proxy ξ(x,t), force/stroke and isobaric work loop, superelastic dissipation and a comparison of cosine and exponential kinetics — with zero-stress, slope-recovery, elastic-limit and loop-closure verification.',
  literature: 'shape memory alloy martensite volume fraction kinetics Brinson model hysteresis Clausius-Clapeyron',
  credibility: 'Numerically verified',
  equations: [
    'Stress-shifted transformation temperatures: M_{s,f}(σ) = M_{s,f} + σ/C_M, A_{s,f}(σ) = A_{s,f} + σ/C_A (Clausius–Clapeyron, dσ/dT = −ρ·Δs/ε_L)',
    'Cosine kinetics (Liang–Rogers/Brinson): heating ξ = ξ₀/2·[cos(π(T − A_s(σ))/(A_f(σ) − A_s(σ))) + 1]; cooling ξ = (1 − ξ₀)/2·cos(π(T − M_f(σ))/(M_s(σ) − M_f(σ))) + (1 + ξ₀)/2',
    'Exponential kinetics (Tanaka): ξ = ξ₀·exp(−ln100·(T − A_s)/(A_f − A_s)) on heating; ξ = 1 − (1 − ξ₀)·exp(−ln100·(M_s − T)/(M_s − M_f)) on cooling',
    'Detwinning gate ξ_s ≥ ξ·½[1 − cos(π(σ − σ_s)/(σ_f − σ_s))]; strain ε = σ/E(ξ) + ε_L·ξ_s + α(T − T_ref), 1/E(ξ) = ξ/E_M + (1 − ξ)/E_A',
    'Through-thickness conduction with latent source: ρc_p ∂T/∂t = k ∂²T/∂x² + ρL_h ∂ξ/∂t, symmetry at the mid-plane, −k∂T/∂x = U(T − T_f) at the face, U = (1/h + 1/h_c)⁻¹',
    'Isobaric work density w = −∮σ dε / ρ; force F = σ·A_bundle; stroke Δx = Δε·L',
    'Superelastic dissipation per unit volume D = ∮σ dε (isothermal load–unload loop above A_f); thermal-hysteresis estimate D_th ≈ ρ·L_h·ΔT_hyst/T_eq',
  ],
  methods: [
    'Constitutive integration with the shared SMA class (sma.js) for temperature programmes (step ≤ 0.2 K), ξ–T loops and transformation-temperature detection (0.05 K isothermal steps).',
    'Clausius–Clapeyron slopes recovered by Levenberg–Marquardt straight-line fits T(σ) = T₀ + σ/C of the detected A_f(σ) and M_s(σ) at six stresses.',
    'Phase-front proxy: Crank–Nicolson slab conduction (heat.slab1D) over the ribbon half-thickness with the latent heat ρL_h·Δξ/Δt of each node evaluated by the shared kinetic kernel (sma.kinStep) as a lagged source; heating at σ_H from the cold state, then cooling at σ_L from the equilibrated hot state.',
    'Reference transient cell (sma.cellTransient) for mean ξ, surface and centre temperatures with wall capacity, contact and the one-way clutch load.',
    'Isobaric two-stress quasi-static cycle (sma.quasiStaticCycle) and isothermal tensile loops (sma.tensileTest).',
  ],
  assumptions: [
    'Phenomenological 1-D law; texture, R-phase, transformation-induced plasticity and functional fatigue are not modelled (texture enters only through ε_L).',
    'Rate-independent kinetics: the loading rate changes only the time scale of a programme, not the transformation temperatures (no self-heating in the programme runs; self-heating appears in the field and cell runs through the latent source).',
    'Phase-front proxy uses a constant (phase-averaged) conductivity and neglects the wall heat capacity; the cell transient includes both.',
    'The hysteresis offset shifts A_s, A_f up and M_s, M_f down by half the offset each (training/composition what-if).',
  ],
  ibc: {
    initial: ['Prepared state: fully martensitic, detwinned according to the applied stress, at the programme minimum temperature.', 'Field run: uniform cold temperature T_c, ξ = 1; cooling run starts from the equilibrated hot profile.', 'Elastic-limit test: fully austenitic at T > A_f(σ).'],
    boundary: ['Prescribed temperature programme T(t) (triangle or sine) at constant stress.', 'Field run: symmetric mid-plane, convective face to the switching fluid through fluid film and contact conductance.', 'Isobaric cycle: σ_L at T_c, σ_H at T_h.'],
  },
  cvv: {
    calibration: ['Card from Suite 03 (DSC: transformation temperatures, L_h; tensile: C_M, C_A, σ_s, σ_f, ε_L).'],
    verification: ['Zero-stress transformation temperatures reproduced within 0.1 K.', 'C_M and C_A recovered by fitting within 1 %.', 'Elastic-only limit: no transformation and exact elastic strain when the temperature stays in a single phase.', 'Loop closure of the thermal hysteresis loop and the isobaric work loop.', 'Field run: complete reverse transformation when T_h > A_f(σ_H) and complete forward transformation when T_c < M_f(σ_L).'],
    validation: ['DSC and in-situ strain–temperature measurements at constant stress (V0/V1); stress-dependent transformation response from isobaric thermal cycling of a ribbon.'],
  },
  formats: { import: ['CSV temperature–strain at constant stress (T, ε)', 'CSV ξ estimate from resistance or XRD (T, ξ)'], export: ['ξ(t), T(t), ε(t) histories CSV', 'ξ(x,t) field CSV', 'PNG/SVG plots'] },
  params: [
    ...CARD.map(([k, label, unit]) => ({ key: k, label, unit, type: 'number', default: getMat('niti-lt')[k], group: 'Alloy card (Suite 03)', auto: cardAuto(k), step: k === 'epsL' ? 0.001 : k === 'Lh' ? 500 : 0.5, min: k === 'epsL' ? 0.001 : k === 'Lh' ? 0 : k === 'CM' || k === 'CA' ? 0.5 : -100, max: k === 'epsL' ? 0.1 : k === 'Lh' ? 60000 : k === 'CM' || k === 'CA' ? 50 : 400 })),
    { key: 'hystShift', label: 'Hysteresis offset (what-if)', unit: 'K', type: 'number', default: 0, min: -30, max: 30, step: 1, group: 'Alloy card (Suite 03)', help: 'Adds ½ offset to A_s, A_f and subtracts ½ from M_s, M_f.' },
    { key: 'sigmaL', label: 'Reset stress σL', unit: 'MPa', type: 'number', default: 70, min: 0, max: 600, step: 5, group: 'Stress & temperature programme', auto: eng('sigmaL') },
    { key: 'sigmaH', label: 'Power-stroke stress σH', unit: 'MPa', type: 'number', default: 110, min: 0, max: 800, step: 5, group: 'Stress & temperature programme', auto: eng('sigmaH') },
    { key: 'Tmin', label: 'Programme / sink temperature', unit: '°C', type: 'number', default: 15, min: -60, max: 200, step: 1, group: 'Stress & temperature programme', auto: eng('Tc') },
    { key: 'Tmax', label: 'Programme / source temperature', unit: '°C', type: 'number', default: 70, min: -20, max: 400, step: 1, group: 'Stress & temperature programme', auto: eng('Th') },
    { key: 'shape', label: 'Temperature programme', type: 'select', default: 'triangle', options: [{ value: 'triangle', label: 'Triangle (constant rate)' }, { value: 'sine', label: 'Sinusoidal' }], group: 'Stress & temperature programme' },
    { key: 'rate', label: 'Heating/cooling rate', unit: 'K/s', type: 'number', default: 5, min: 0.01, max: 1000, step: 0.5, group: 'Stress & temperature programme', help: 'Sets the time scale of the programme (rate-independent kinetics).' },
    { key: 'progCycles', label: 'Programme cycles', type: 'number', default: 2, min: 1, max: 10, step: 1, group: 'Stress & temperature programme' },
    { key: 'kinetics', label: 'Kinetics law', type: 'select', default: 'cosine', options: [{ value: 'cosine', label: 'Cosine (Liang–Rogers / Brinson)' }, { value: 'exponential', label: 'Exponential (Tanaka)' }], group: 'Kinetics' },
    { key: 'ribbonT_um', label: 'Ribbon thickness', unit: 'µm', type: 'number', default: 100, min: 10, max: 3000, step: 10, group: 'Ribbon & heat exchange', auto: eng('ribbonT', 1e-6) },
    { key: 'ribbonL_mm', label: 'Ribbon active length', unit: 'mm', type: 'number', default: 100, min: 5, max: 2000, step: 1, group: 'Ribbon & heat exchange', auto: eng('ribbonL', 1e-3) },
    { key: 'ribbonW_mm', label: 'Ribbon width', unit: 'mm', type: 'number', default: 5, min: 0.1, max: 100, step: 0.1, group: 'Ribbon & heat exchange', auto: eng('ribbonW', 1e-3) },
    { key: 'nRib', label: 'Ribbons per cell', type: 'number', default: 20, min: 1, max: 500, step: 1, group: 'Ribbon & heat exchange', auto: eng('ribbonsPerCell') },
    { key: 'hHot', label: 'Hot fluid HTC', unit: 'W/m²K', type: 'number', default: 4000, min: 10, max: 1e6, step: 100, group: 'Ribbon & heat exchange', auto: (ctx) => ctx.upstream('s08')?.hHot_Wm2K ? { value: ctx.upstream('s08').hHot_Wm2K, prov: 'coupled' } : { value: ctx.engine.hHot, prov: 'calc' } },
    { key: 'hCold', label: 'Cold fluid HTC', unit: 'W/m²K', type: 'number', default: 4000, min: 10, max: 1e6, step: 100, group: 'Ribbon & heat exchange', auto: (ctx) => ctx.upstream('s08')?.hCold_Wm2K ? { value: ctx.upstream('s08').hCold_Wm2K, prov: 'coupled' } : { value: ctx.engine.hCold, prov: 'calc' } },
    { key: 'hContact', label: 'Contact conductance', unit: 'W/m²K', type: 'number', default: 20000, min: 100, max: 1e7, step: 500, group: 'Ribbon & heat exchange', auto: (ctx) => ctx.upstream('s08')?.hContact_Wm2K ? { value: ctx.upstream('s08').hContact_Wm2K, prov: 'coupled' } : { value: ctx.engine.hContact, prov: 'calc' } },
    { key: 'freq', label: 'Cycle frequency', unit: 'Hz', type: 'number', default: 1, min: 0.01, max: 50, step: 0.1, group: 'Ribbon & heat exchange', auto: eng('freq') },
    { key: 'dutyHot', label: 'Hot-phase fraction', type: 'number', default: 0.5, min: 0.1, max: 0.9, step: 0.05, group: 'Ribbon & heat exchange', auto: eng('dutyHot') },
    { key: 'nX', label: 'Field run: nodes over half-thickness', type: 'number', default: 21, min: 5, max: 81, step: 2, group: 'Solver (expert)', expert: true },
    { key: 'stepsHalf', label: 'Field run: time steps per half-cycle', type: 'number', default: 200, min: 40, max: 2000, step: 20, group: 'Solver (expert)', expert: true },
    { key: 'cellNodes', label: 'Cell run: half-thickness cells', type: 'number', default: 6, min: 1, max: 16, step: 1, group: 'Solver (expert)', expert: true },
    { key: 'cellSteps', label: 'Cell run: steps per cycle', type: 'number', default: 240, min: 60, max: 2000, step: 20, group: 'Solver (expert)', expert: true },
  ],
  presets: [
    { label: 'Card at zero hysteresis offset', values: { hystShift: 0 } },
    { label: 'Low-hysteresis what-if (−10 K)', values: { hystShift: -10 } },
    { label: 'Exponential kinetics', values: { kinetics: 'exponential' } },
    { label: 'Thick ribbon 500 µm (visible phase front)', values: { ribbonT_um: 500, freq: 0.2 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const base = baseAlloy(ctx), hs = p.hystShift / 2;
    const mat = { ...base, Ms: p.Ms - hs, Mf: p.Mf - hs, As: p.As + hs, Af: p.Af + hs, CM: p.CM, CA: p.CA, sigS: p.sigS, sigF: p.sigF, epsL: p.epsL, Lh: p.Lh };
    const bad = [];
    if (!(mat.Ms > mat.Mf)) bad.push('M_s must exceed M_f'); if (!(mat.Af > mat.As)) bad.push('A_f must exceed A_s'); if (!(mat.As >= mat.Mf)) bad.push('A_s should not lie below M_f'); if (!(mat.sigF > mat.sigS)) bad.push('σ_f must exceed σ_s'); if (!(p.Tmax > p.Tmin)) bad.push('programme maximum must exceed its minimum'); if (!(p.sigmaH > p.sigmaL)) bad.push('σH must exceed σL');
    if (bad.length) return { ...out, headline: 'Inconsistent transformation card or programme: ' + bad.join('; ') + '.', headlineKind: 'fail', verdicts: [{ test: 'Card and programme consistency', status: 'fail', detail: bad.join('; ') + '.', fix: 'Correct the card in Suite 03 or the programme limits.' }], kpis: [{ label: 'Consistency', value: 'failed', explain: bad.join('; '), status: 'bad' }], outputs: {} };
    const m = new SMA(mat, { kinetics: p.kinetics }), tH = m.temps(p.sigmaH), tL = m.temps(p.sigmaL);
    const A = p.nRib * p.ribbonW_mm * 1e-3 * p.ribbonT_um * 1e-6, L = p.ribbonL_mm * 1e-3;

    // ---- A. temperature programmes at σH, both kinetics laws
    const progArgs = { Tmin: p.Tmin, Tmax: p.Tmax, rate: p.rate, cycles: p.progCycles, shape: p.shape, s: p.sigmaH };
    const prog = program(mat, { ...progArgs, kinetics: p.kinetics }), progAlt = program(mat, { ...progArgs, kinetics: p.kinetics === 'cosine' ? 'exponential' : 'cosine' });
    // ---- B. ξ–T loops at several stresses (selected kinetics)
    const S = [0, p.sigmaL, p.sigmaH, 1.5 * p.sigmaH];
    const loops = S.map(s => { const t = m.temps(s), lo = Math.min(t.Mf, p.Tmin) - 10, hi = Math.max(t.Af, p.Tmax) + 10, x = new SMA(mat, { kinetics: p.kinetics }); x.xi = 1; x.xis = 0; x.update(lo, s); const T = [...linspace(lo, hi, 300), ...linspace(hi, lo, 300)], xi = T.map(TT => x.update(TT, s)); return { s, T, xi }; });
    // ---- C/D. verification: detected temperatures and Clausius–Clapeyron recovery
    const det0 = detectTemps(mat, 0), Sfit = linspace(0, Math.max(1.5 * p.sigmaH, 100), 6), dets = Sfit.map(s => detectTemps(mat, s));
    const lin = (x, q) => q[0] + x / q[1];
    const fA = levenbergMarquardt(lin, Sfit, dets.map(d => d.Af), [mat.Af, 10]), fM = levenbergMarquardt(lin, Sfit, dets.map(d => d.Ms), [mat.Ms, 10]);
    // ---- E. elastic-only limit (austenite, stress below the inducing stress)
    const Te0 = mat.Af + 5, se = Math.max(0, mat.CM * (Te0 - mat.Ms) - 20), xe = new SMA(mat, { kinetics: p.kinetics }); xe.xi = 0; xe.xis = 0;
    let maxXiE = 0, maxErrE = 0; for (const T of [...linspace(Te0, Te0 + 20, 50), ...linspace(Te0 + 20, Te0, 50)]) { xe.update(T, se); maxXiE = Math.max(maxXiE, xe.xi); maxErrE = Math.max(maxErrE, Math.abs(xe.strain(se, T) - (se * 1e6 / xe.EA + xe.alpha * (T - xe.Tref)))); }
    const Tm0 = mat.Mf - 25, xm = new SMA(mat, { kinetics: p.kinetics }).prepare(Tm0, 0); let maxDxiM = 0; const xi0m = xm.xi; for (const T of [...linspace(Tm0, Math.min(mat.As - 2, Tm0 + 20), 40), ...linspace(Math.min(mat.As - 2, Tm0 + 20), Tm0, 40)]) { xm.update(T, 0); maxDxiM = Math.max(maxDxiM, Math.abs(xm.xi - xi0m)); }
    await tick(ctx);

    // ---- G. isobaric work loop & H. dissipation
    const qsc = quasiStaticCycle(mat, { Th: p.Tmax, Tc: p.Tmin, sH: p.sigmaH, sL: p.sigmaL, kinetics: p.kinetics, n: 160 });
    const Tse = Math.max(mat.Af, p.Tmax) + 20, sup = tensileTest(mat, { T: Tse, sMax: Math.max(mat.CM * (Tse - mat.Ms) * 1.6, p.sigmaH * 2), n: 150, kinetics: p.kinetics });
    const hystW = 0.5 * (mat.As + mat.Af) - 0.5 * (mat.Ms + mat.Mf), Teq = 0.25 * (mat.Ms + mat.Mf + mat.As + mat.Af) + KELVIN, Dth = mat.rho * mat.Lh * hystW / Teq;

    // ---- I. phase-front proxy ξ(x,t) through the half-thickness
    const Lhalf = p.ribbonT_um * 1e-6 / 2, kAvg = 0.5 * ((mat.k || 18) + (mat.kM || mat.k || 10)), Pd = 1 / p.freq, tHeat = p.dutyHot * Pd, tCool = Pd - tHeat;
    const Uh = 1 / (1 / p.hHot + 1 / p.hContact), Uc = 1 / (1 / p.hCold + 1 / p.hContact), nX = Math.max(5, Math.round(p.nX)), K = { ...mat, kinetics: p.kinetics };
    const proto = new SMA(mat, { kinetics: p.kinetics }).prepare(p.Tmin, p.sigmaL), st = range(nX).map(() => ({ xi: proto.xi, xis: proto.xis, dir: proto.dir, x0F: proto.x0F, x0R: proto.x0R })), tmp = {};
    const field = { t: [], xi: [], T: [] }; let viol = 0; const tolK = p.kinetics === 'exponential' ? 0.0101 : 1e-9; // exponential law reaches 99 % at the finish temperature
    const runPhase = (Tinf, T0, U, s, tEnd, t0) => {
      const steps = Math.max(20, Math.round(p.stepsHalf)), dt = tEnd / steps; let lastS = -1, rowXi = null, rowT = null;
      const r = slab1D({ Lh: Lhalf, n: nX, k: kAvg, rho: mat.rho, cp: mat.cp, h: U, Tinf, T0, tEnd, dt, record: 10, src: (x, tt, T) => {
        const sIdx = Math.round(tt / dt), i = Math.round(x / (Lhalf / (nX - 1)));
        if (sIdx !== lastS) { if (rowXi) { field.t.push(t0 + lastS * dt); field.xi.push(rowXi); field.T.push(rowT); } rowXi = new Array(nX); rowT = new Array(nX); lastS = sIdx; }
        const prev = st[i].xi; kinStep(K, st[i], T, s, tmp); Object.assign(st[i], tmp); rowXi[i] = st[i].xi; rowT[i] = T;
        const tt2 = m.temps(s); if ((s === p.sigmaH && T >= tt2.Af && st[i].xi > tolK) || (s === p.sigmaL && T <= tt2.Mf && st[i].xi < 1 - tolK)) viol++;
        return mat.rho * mat.Lh * (st[i].xi - prev) / dt;
      } });
      if (rowXi) { field.t.push(t0 + lastS * dt); field.xi.push(rowXi); field.T.push(rowT); }
      return r;
    };
    const rH = runPhase(p.Tmax, p.Tmin, Uh, p.sigmaH, tHeat, 0);
    const Tmean = rH.profile.reduce((a, b) => a + b, 0) / rH.profile.length, spread = max(rH.profile) - min(rH.profile);
    const rC = runPhase(p.Tmin, Tmean, Uc, p.sigmaL, tCool, tHeat);
    const xiMeanF = field.xi.map(r => r.reduce((a, b) => a + b, 0) / nX), xiEndHeat = xiMeanF[Math.max(0, field.t.findIndex(t => t >= tHeat) - 1)], xiEndCool = xiMeanF[xiMeanF.length - 1];
    const tRev = (() => { const i = xiMeanF.findIndex((v, k) => field.t[k] < tHeat && v < 0.02); return i >= 0 ? field.t[i] : Infinity; })();
    const tFwd = (() => { const i = xiMeanF.findIndex((v, k) => field.t[k] >= tHeat && v > 0.98); return i >= 0 ? field.t[i] - tHeat : Infinity; })();
    await tick(ctx);

    // ---- reference transient cell run
    const cell = cellTransient({ mat, t: p.ribbonT_um * 1e-6, w: p.ribbonW_mm * 1e-3, L, nRib: p.nRib, n: p.cellNodes, Th: p.Tmax, Tc: p.Tmin, hHot: p.hHot, hCold: p.hCold, hc: p.hContact, Cw: ctx.engine.wallCapacity ?? 200, period: Pd, dutyHot: p.dutyHot, tSwitch: ctx.engine.tSwitch ?? 0.02, sBias0: p.sigmaL, kBias: 0, sLoad: p.sigmaH - p.sigmaL, cycles: 4, stepsPerCycle: p.cellSteps, kinetics: p.kinetics });

    // ---- checks
    const z = ['As', 'Af', 'Ms', 'Mf'].map(k => Math.abs(det0[k] - mat[k]));
    out.checks.push(
      { name: 'Zero-stress transformation temperatures reproduced', value: Math.max(...z), target: '≤ 0.1 K (detection step 0.05 K)', pass: Math.max(...z) <= 0.1, detail: ['As', 'Af', 'Ms', 'Mf'].map(k => `${k} ${fmt(det0[k], 4)} vs ${fmt(mat[k], 4)}`).join(', ') },
      { name: 'Clausius–Clapeyron C_A recovered by fitting', value: Math.abs(fA.p[1] / mat.CA - 1), target: '< 1 %', pass: Math.abs(fA.p[1] / mat.CA - 1) < 0.01, detail: `fitted ${fmt(fA.p[1], 5)} vs card ${mat.CA} MPa/K (A_f(σ) at ${Sfit.length} stresses)` },
      { name: 'Clausius–Clapeyron C_M recovered by fitting', value: Math.abs(fM.p[1] / mat.CM - 1), target: '< 1 %', pass: Math.abs(fM.p[1] / mat.CM - 1) < 0.01, detail: `fitted ${fmt(fM.p[1], 5)} vs card ${mat.CM} MPa/K (M_s(σ))` },
      { name: 'Elastic-only limit (austenite): no transformation', value: maxXiE, target: '= 0', pass: maxXiE === 0, detail: `T ∈ [${fmt(Te0, 3)}, ${fmt(Te0 + 20, 3)}] °C at σ = ${fmt(se, 3)} MPa (below the inducing stress)` },
      { name: 'Elastic-only limit: strain equals σ/E_A + α·ΔT', value: maxErrE, target: '< 1e-12', pass: maxErrE < 1e-12 },
      { name: 'Single-phase martensite: ξ unchanged below A_s', value: maxDxiM, target: '= 0', pass: maxDxiM === 0 },
      { name: 'Thermal hysteresis loop closure (σ = 0)', value: det0.closure, target: '< 1e-9', pass: det0.closure < 1e-9 },
      { name: 'Isobaric work-loop closure', value: qsc.closure, target: '< 1e-9', pass: qsc.closure < 1e-9 },
      { name: 'Field run: local phase state consistent with local temperature', value: viol, target: '0 nodes with T ≥ A_f(σH) and ξ > tol, or T ≤ M_f(σL) and ξ < 1 − tol', pass: viol === 0, detail: `tol = ${tolK} (${p.kinetics} kinetics).` },
      { name: 'Field run: mean ξ at end of hot phase (physics outcome)', value: xiEndHeat, target: 'informative', pass: undefined, detail: `Reverse transformation ${Number.isFinite(tRev) ? 'complete after ' + fmt(tRev * 1e3, 4) + ' ms' : 'not complete within the hot dwell'}; hot margin T_h − A_f(σH) = ${fmt(p.Tmax - tH.Af, 3)} K — with a small margin the face temperature approaches A_f(σH) only asymptotically.` },
      { name: 'Field run: mean ξ at end of cold phase (physics outcome)', value: xiEndCool, target: 'informative', pass: undefined, detail: `Forward transformation ${Number.isFinite(tFwd) ? 'complete after ' + fmt(tFwd * 1e3, 4) + ' ms' : 'not complete within the cold dwell'}; cold margin M_f(σL) − T_c = ${fmt(tL.Mf - p.Tmin, 3)} K.` },
      { name: 'Field run: hot profile equilibrated before cooling (uniform-start assumption)', value: spread, target: '< 0.5 K', pass: spread < 0.5, detail: 'The cooling half starts from the mean of the heated profile; a large spread means the hot dwell is too short for this thickness.' },
      { name: 'Cell transient energy residual', value: Math.abs(cell.energyResidual), target: '< 1e-2', pass: Math.abs(cell.energyResidual) < 1e-2 },
    );

    // ---- verdicts
    out.verdicts.push({ test: 'Complete reverse transformation at T_h under σH', status: p.Tmax >= tH.Af ? 'pass' : p.Tmax > tH.As ? 'warn' : 'fail', detail: `A_s(σH) = ${fmt(tH.As, 4)}, A_f(σH) = ${fmt(tH.Af, 4)} °C vs T_h = ${p.Tmax} °C.`, fix: `Reduce σH below ${fmt(mat.CA * (p.Tmax - 3 - mat.Af), 3)} MPa or raise T_h.` });
    out.verdicts.push({ test: 'Complete forward transformation at T_c under σL', status: p.Tmin <= tL.Mf ? 'pass' : p.Tmin < tL.Ms ? 'warn' : 'fail', detail: `M_s(σL) = ${fmt(tL.Ms, 4)}, M_f(σL) = ${fmt(tL.Mf, 4)} °C vs T_c = ${p.Tmin} °C.`, fix: 'Reduce σL or lower T_c.' });
    out.verdicts.push({ test: 'Reset stress detwins the cold martensite', status: p.sigmaL >= mat.sigF ? 'pass' : p.sigmaL >= mat.sigS ? 'warn' : 'fail', detail: `σL = ${p.sigmaL} MPa vs σ_s = ${mat.sigS}, σ_f = ${mat.sigF} MPa — the detwinned fraction at the end of cooling is ${fmt(qsc.path[qsc.path.length - 1].xis, 3)}.`, fix: `Raise σL toward ${mat.sigF} MPa, or train the ribbon for two-way memory.` });
    out.verdicts.push({ test: 'Transformation keeps pace with the cycle (cell transient)', status: cell.xiSwing > 0.9 ? 'pass' : cell.xiSwing > 0.5 ? 'warn' : 'fail', detail: `Mean martensite fraction swings ${fmt(cell.xiMin, 3)} → ${fmt(cell.xiMax, 3)} at ${p.freq} Hz; field run: reverse in ${Number.isFinite(tRev) ? fmt(tRev * 1e3, 4) + ' ms' : '— (incomplete)'} of a ${fmt(tHeat * 1e3, 4)} ms hot dwell, forward in ${Number.isFinite(tFwd) ? fmt(tFwd * 1e3, 4) + ' ms' : '— (incomplete)'} of ${fmt(tCool * 1e3, 4)} ms.`, fix: 'Lower the frequency, thin the ribbon or raise the contact/fluid conductance (Suite 08).' });

    // ---- KPIs
    out.kpis.push(
      { label: 'A_f at σH', value: tH.Af, unit: '°C', status: p.Tmax >= tH.Af ? 'ok' : 'bad', prov: 'calc', explain: `Austenite finish raised by σH/C_A = ${fmt(p.sigmaH / mat.CA, 3)} K; below T_h the ribbon contracts fully.` },
      { label: 'M_f at σL', value: tL.Mf, unit: '°C', status: p.Tmin <= tL.Mf ? 'ok' : 'bad', prov: 'calc', explain: `Martensite finish raised by σL/C_M = ${fmt(p.sigmaL / mat.CM, 3)} K; above T_c the ribbon resets fully.` },
      { label: 'Isobaric loop work density', value: qsc.w_J_kg, unit: 'J/kg', prov: 'calc', explain: 'Area of the quasi-static σ–ε loop between (σL, T_c) and (σH, T_h) per kg — the ideal net mechanical work per cycle.' },
      { label: 'Transformation stroke', value: 100 * qsc.stroke, unit: '%', prov: 'calc', explain: `Strain swing of the isobaric loop; ${fmt(qsc.stroke * L * 1e3, 4)} mm on a ${p.ribbonL_mm} mm ribbon.` },
      { label: 'Superelastic loop dissipation', value: sup.dissipated_J_m3 / 1e6, unit: 'MJ/m³', prov: 'calc', explain: `Area of the isothermal load–unload loop at ${fmt(Tse, 3)} °C — mechanical energy converted to heat per cycle in superelastic operation.` },
      { label: 'Thermal hysteresis width', value: hystW, unit: 'K', prov: 'calc', explain: `Mid-austenite minus mid-martensite temperature; dissipation estimate ρL_hΔT/T ≈ ${fmt(Dth / 1e6, 3)} MJ/m³ per full transformation cycle.` },
      { label: 'Fitted C_A (stress shift)', value: fA.p[1], unit: 'MPa/K', prov: 'calc', explain: 'Recovered from detected A_f(σ) at six stresses — verifies the implemented Clausius–Clapeyron shift.' },
      { label: 'Martensite swing in the transient cell', value: cell.xiSwing, unit: '–', status: cell.xiSwing > 0.9 ? 'ok' : cell.xiSwing > 0.5 ? 'warn' : 'bad', prov: 'calc', explain: 'max ξ − min ξ of the thickness-averaged martensite fraction over the last cycle; 1 = complete transformation each way.' },
    );

    // ---- charts
    const dp = (a) => down(a, 600);
    out.charts.push({ type: 'line', title: `Martensite fraction history at σH = ${p.sigmaH} MPa (${p.shape} programme, ${p.rate} K/s)`, x: { label: 'Time', unit: 's' }, y: { label: 'ξ (–) / normalised T' },
      series: [{ name: `ξ — ${p.kinetics}`, x: dp(prog.t), y: dp(prog.xi) }, { name: 'ξ_s detwinned', x: dp(prog.t), y: dp(prog.xis), dash: '4 3' }, { name: `ξ — ${p.kinetics === 'cosine' ? 'exponential' : 'cosine'}`, x: dp(progAlt.t), y: dp(progAlt.xi), dash: '2 3' }, { name: '(T − T_min)/(T_max − T_min)', x: dp(prog.t), y: dp(prog.T.map(T => (T - p.Tmin) / (p.Tmax - p.Tmin))), color: '#94a3b8' }],
      explain: 'Martensite volume fraction while the temperature follows the programme (grey, normalised). The fraction falls on heating once A_s(σ) is crossed and rises on cooling below M_s(σ); the delay between the two is the thermal hysteresis. The dashed line is the oriented (detwinned) part that produces strain.' });
    out.charts.push({ type: 'line', title: 'ξ–T hysteresis loops at several stresses', x: { label: 'Temperature', unit: '°C' }, y: { label: 'Martensite fraction ξ', min: -0.02, max: 1.02 },
      series: loops.map(l => ({ name: `σ = ${fmt(l.s, 3)} MPa`, x: l.T, y: l.xi })), annotations: [{ type: 'vline', x: p.Tmin, label: 'T_c', color: '#3b82f6' }, { type: 'vline', x: p.Tmax, label: 'T_h', color: '#ef4444' }],
      explain: 'Each loop: heat from fully martensitic, then cool back. Stress shifts the whole loop to higher temperature (Clausius–Clapeyron). For the engine, the σH loop must finish its reverse branch left of T_h and the σL loop its forward branch right of T_c.' });
    const pd = phaseDiagram(mat, Math.max(...Sfit), 41);
    out.charts.push({ type: 'line', title: 'Stress shift of transformation temperatures: model lines and recovered points', x: { label: 'Stress', unit: 'MPa' }, y: { label: 'Temperature', unit: '°C' },
      series: [{ name: 'M_s(σ)', x: pd.s, y: pd.Ms }, { name: 'M_f(σ)', x: pd.s, y: pd.Mf, dash: '4 3' }, { name: 'A_s(σ)', x: pd.s, y: pd.As }, { name: 'A_f(σ)', x: pd.s, y: pd.Af, dash: '4 3' }, { name: 'Detected A_f', x: Sfit, y: dets.map(d => d.Af), mode: 'markers', r: 5 }, { name: 'Detected M_s', x: Sfit, y: dets.map(d => d.Ms), mode: 'markers', r: 5 }],
      annotations: [{ type: 'hline', y: p.Tmax, label: 'T_h', color: '#ef4444' }, { type: 'hline', y: p.Tmin, label: 'T_c', color: '#3b82f6' }, { type: 'vline', x: p.sigmaH, label: 'σH' }, { type: 'vline', x: p.sigmaL, label: 'σL', color: '#22c55e' }],
      explain: `Lines: card relations. Markers: transformation temperatures detected from simulated slow isothermal sweeps; straight-line fits recover C_A = ${fmt(fA.p[1], 4)} and C_M = ${fmt(fM.p[1], 4)} MPa/K (card ${mat.CA} / ${mat.CM}).` });
    const depth = range(nX).map(i => (Lhalf - i * Lhalf / (nX - 1)) * 1e6), stride = Math.max(1, Math.ceil(field.t.length / 160)), cols = range(field.t.length).filter(i => i % stride === 0);
    out.charts.push({ type: 'heatmap', title: 'Phase-front proxy ξ(x, t) through the ribbon half-thickness', x: { label: 'Time', unit: 's', values: cols.map(i => field.t[i]) }, y: { label: 'Depth below face', unit: 'µm', values: depth.slice().reverse() }, z: depth.map((_, jj) => cols.map(i => field.xi[i][jj])).reverse(), cmap: 'coolwarm', z_label: 'ξ', isolines: 3, wide: true,
      explain: `Martensite fraction over depth (0 = heat-exchange face, ${fmt(Lhalf * 1e6, 3)} µm = mid-plane) and time: heating at σH for ${fmt(tHeat, 3)} s then cooling at σL. A tilted iso-ξ contour is a transformation front moving inward; nearly vertical contours mean the ribbon transforms uniformly (Biot number U·(t/2)/k = ${fmt(Uh * Lhalf / kAvg, 3)}). Latent heat slows the front: absorbed on heating, released on cooling.` });
    out.charts.push({ type: 'heatmap', title: 'Temperature field T(x, t) during the same cycle', x: { label: 'Time', unit: 's', values: cols.map(i => field.t[i]) }, y: { label: 'Depth below face', unit: 'µm', values: depth.slice().reverse() }, z: depth.map((_, jj) => cols.map(i => field.T[i][jj])).reverse(), cmap: 'inferno', z_label: '°C', wide: true,
      explain: 'Temperature over depth and time. Plateaus near the transformation temperatures are the latent-heat signature (the material absorbs heat at nearly constant temperature while transforming).' });
    const Fq = qsc.path.map(r => r.s * 1e6 * A), xq = qsc.path.map(r => (qsc.path[0].e - r.e) * L * 1e3);
    out.charts.push({ type: 'line', title: 'Isobaric work loop as force–stroke (cell bundle)', x: { label: 'Contraction stroke', unit: 'mm' }, y: { label: 'Bundle force', unit: 'N' }, series: [{ name: `${p.kinetics} kinetics`, x: xq, y: Fq }],
      explain: `Quasi-static cycle: load to σH cold, heat (contract under σH), unload at T_h, cool (extend under σL). The enclosed area = ${fmt(qsc.w_J_kg * mat.rho * A * L, 4)} J per cycle for the ${p.nRib}-ribbon bundle (A = ${fmt(A * 1e6, 4)} mm²); contraction work ${fmt(qsc.wContraction_J_kg * mat.rho * A * L, 4)} J, reset work ${fmt(qsc.wReset_J_kg * mat.rho * A * L, 4)} J.` });
    out.charts.push({ type: 'line', title: `Superelastic loop at ${fmt(Tse, 3)} °C (dissipated energy = loop area)`, x: { label: 'Strain', unit: '%' }, y: { label: 'Stress', unit: 'MPa' }, series: [{ name: 'Load–unload', x: sup.path.map(r => 100 * r.e), y: sup.path.map(r => r.s) }],
      explain: `Above A_f stress induces martensite at σ ≈ C_M(T − M_s) and it reverts on unloading at a lower stress; the loop area ${fmt(sup.dissipated_J_m3 / 1e6, 4)} MJ/m³ is dissipated each cycle.` });
    const heatIdx = (pr) => { const i1 = pr.t.findIndex(t => t >= pr.half); return range(Math.max(2, i1)); };
    out.charts.push({ type: 'line', title: 'Kinetics law comparison during heating at σH', x: { label: 'Temperature', unit: '°C' }, y: { label: 'Martensite fraction ξ' },
      series: [{ name: `${p.kinetics}`, x: heatIdx(prog).map(i => prog.T[i]), y: heatIdx(prog).map(i => prog.xi[i]) }, { name: `${p.kinetics === 'cosine' ? 'exponential' : 'cosine'}`, x: heatIdx(progAlt).map(i => progAlt.T[i]), y: heatIdx(progAlt).map(i => progAlt.xi[i]), dash: '6 4' }],
      annotations: [{ type: 'vline', x: tH.As, label: 'A_s(σH)' }, { type: 'vline', x: tH.Af, label: 'A_f(σH)' }],
      explain: 'Cosine kinetics transforms symmetrically and finishes exactly at A_f(σ); exponential kinetics starts faster and approaches completion asymptotically (99 % at A_f). The choice changes the predicted temperature needed for full contraction and must be calibrated against DSC/strain–temperature data.' });
    const ch = cell.hist;
    out.charts.push({ type: 'line', title: 'Transient cell: surface/centre temperature and mean ξ (last cycle)', x: { label: 'Time in cycle', unit: 's' }, y: { label: 'Temperature', unit: '°C' },
      series: [{ name: 'Fluid', x: ch.t, y: ch.Tf, color: '#94a3b8' }, { name: 'Ribbon surface', x: ch.t, y: ch.Ts }, { name: 'Ribbon centre', x: ch.t, y: ch.Tc, dash: '4 3' }, { name: 'ξ × (T_h − T_c) + T_c', x: ch.t, y: ch.xi.map(v => p.Tmin + v * (p.Tmax - p.Tmin)), color: '#a855f7' }],
      explain: 'Reference cell including wall heat capacity, contact conductance and the clutch load. The violet curve is the mean martensite fraction scaled onto the temperature axis.' });

    // ---- tables
    out.tables.push({ title: 'Transformation temperatures vs stress', cols: ['σ [MPa]', 'M_f', 'M_s', 'A_s', 'A_f', 'Detected A_f', 'Detected M_s'], rows: Sfit.map((s, i) => { const t = m.temps(s); return [s, t.Mf, t.Ms, t.As, t.Af, dets[i].Af, dets[i].Ms]; }), explain: 'Card values (°C) and those detected from simulated isothermal sweeps; their agreement verifies the implementation.' });
    out.tables.push({ title: 'Kinetics comparison (heating at σH)', cols: ['Law', 'T at ξ = 0.5 [°C]', 'T at ξ = 0.05 [°C]', 'ξ at A_f(σH)'], rows: [[p.kinetics, prog], [p.kinetics === 'cosine' ? 'exponential' : 'cosine', progAlt]].map(([n, pr]) => { const I = heatIdx(pr), Tx = (v) => { const k = I.find(i => pr.xi[i] <= v); return k === undefined ? '—' : pr.T[k]; }; const kA = I.find(i => pr.T[i] >= tH.Af); return [n, Tx(0.5), Tx(0.05), kA === undefined ? '—' : pr.xi[kA]]; }), explain: 'Temperatures needed to reach given transformation levels under each law.' });
    out.tables.push({ title: 'Energy quantities', cols: ['Quantity', 'Value', 'Unit'], rows: [['Isobaric net work', qsc.w_J_kg, 'J/kg'], ['Contraction work', qsc.wContraction_J_kg, 'J/kg'], ['Reset work', qsc.wReset_J_kg, 'J/kg'], ['Quasi-static heat input', qsc.qIn_J_kg, 'J/kg'], ['Quasi-static efficiency', 100 * qsc.eta, '%'], ['Carnot efficiency', 100 * qsc.etaCarnot, '%'], ['Superelastic dissipation', sup.dissipated_J_m3, 'J/m³'], ['Thermal-hysteresis dissipation estimate', Dth, 'J/m³'], ['Peak bundle force', max(Fq), 'N'], ['Stroke', qsc.stroke * L * 1e3, 'mm']], explain: 'Per-kg and per-volume energy measures from the quasi-static loops.' });

    // ---- animation
    out.views.push({ label: 'Animation: ξ during a heat/cool cycle', icon: '🎞', render: (el) => animate(el, { field, nX, Lhalf, tHeat, Pd, p, tH, tL, xiMeanF }) });

    // ---- narrative & recommendations
    out.explain.push(
      { title: 'Transformation window', text: `Under σH = ${p.sigmaH} MPa the reverse transformation runs from ${fmt(tH.As, 4)} to ${fmt(tH.Af, 4)} °C; under σL = ${p.sigmaL} MPa the forward transformation runs from ${fmt(tL.Ms, 4)} down to ${fmt(tL.Mf, 4)} °C. The reservoirs ${p.Tmin}/${p.Tmax} °C ${p.Tmax >= tH.Af && p.Tmin <= tL.Mf ? 'bracket both windows' : 'do not bracket both windows'}.` },
      { title: 'Through-thickness behaviour', text: `For a ${p.ribbonT_um} µm ribbon the Biot number is ${fmt(Uh * Lhalf / kAvg, 3)}; ${Uh * Lhalf / kAvg < 0.1 ? 'the ribbon transforms nearly uniformly — the face conductance, not internal conduction, sets the speed' : 'a distinct transformation front moves inward from the faces'}. Reverse transformation completed in ${Number.isFinite(tRev) ? fmt(tRev * 1e3, 4) + ' ms' : 'not within the hot dwell'}.` },
      { title: 'Energy', text: `The ideal isobaric loop yields ${fmt(qsc.w_J_kg, 4)} J/kg (${fmt(100 * qsc.stroke, 3)} % stroke); thermal hysteresis of ${fmt(hystW, 3)} K and the superelastic loop (${fmt(sup.dissipated_J_m3 / 1e6, 3)} MJ/m³) are dissipated as heat.` },
    );
    if (p.Tmax < tH.Af) out.recs.push({ level: 'critical', text: `T_h = ${p.Tmax} °C is below A_f(σH) = ${fmt(tH.Af, 4)} °C: the ribbon cannot fully contract. Reduce σH to ≤ ${fmt(mat.CA * (p.Tmax - 3 - mat.Af), 3)} MPa or raise T_h.`, basis: 'Clausius–Clapeyron shift of this card' });
    if (p.Tmin > tL.Mf) out.recs.push({ level: 'critical', text: `T_c = ${p.Tmin} °C is above M_f(σL) = ${fmt(tL.Mf, 4)} °C: incomplete reset. Reduce σL or lower T_c.`, basis: 'Clausius–Clapeyron shift of this card' });
    if (p.Tmax >= tH.Af && p.Tmax - tH.Af < 3) out.recs.push({ level: 'warn', text: `Hot margin is only ${fmt(p.Tmax - tH.Af, 3)} K: the face temperature approaches A_f(σH) asymptotically and the field run still holds ξ = ${fmt(xiEndHeat, 3)} at the end of the hot dwell. Aim for ≥ 3–5 K (σH ≤ ${fmt(mat.CA * (p.Tmax - 5 - mat.Af), 3)} MPa for 5 K).`, basis: 'Field run and Clausius–Clapeyron shift' });
    if (p.sigmaL < mat.sigF) out.recs.push({ level: 'warn', text: `σL = ${p.sigmaL} MPa is below the detwinning finish ${mat.sigF} MPa: part of the cold martensite stays twinned and does not contribute stroke (ξ_s at end of cooling ${fmt(qsc.path[qsc.path.length - 1].xis, 3)}).`, basis: 'Detwinning gate' });
    if (hystW > 15) out.recs.push({ level: 'info', text: `Hysteresis ${fmt(hystW, 3)} K: a −10 K what-if (preset) raises the margins by 5 K on each side; NiTiCu or compatible-lattice compositions achieve this experimentally.`, basis: 'Hysteresis offset sensitivity' });
    if (cell.xiSwing < 0.9) out.recs.push({ level: 'warn', text: `Only ${fmt(cell.xiSwing, 3)} of the martensite transforms per cycle at ${p.freq} Hz — the cycle is heat-transfer-limited; lower the frequency or improve the contact conductance.`, basis: 'Transient cell run' });
    out.recs.push({ level: 'econ', text: `Each kelvin of hysteresis removed raises the usable stress window by ≈ ${fmt(mat.CA, 3)} MPa; at ${fmt(qsc.w_J_kg, 3)} J/kg the work gain per MPa of window is the cheapest route to more watts per kilogram of costly alloy.`, basis: 'Clausius–Clapeyron slope and loop work' });
    out.recs.push({ level: 'sustain', text: `Dissipation of ≈ ${fmt(Dth / 1e6, 3)} MJ/m³ per cycle from thermal hysteresis is heat the source must re-supply; lower-hysteresis alloys reduce source heat demand and the associated emissions of fossil-backed heat.`, basis: 'Thermal-hysteresis dissipation estimate' });

    const okW = p.Tmax >= tH.Af && p.Tmin <= tL.Mf;
    out.headline = `${okW ? 'Complete' : 'Incomplete'} transformation window: A_f(σH) ${fmt(tH.Af, 4)} °C ${p.Tmax >= tH.Af ? '≤' : '>'} T_h ${p.Tmax} °C, M_f(σL) ${fmt(tL.Mf, 4)} °C ${p.Tmin <= tL.Mf ? '≥' : '<'} T_c ${p.Tmin} °C · isobaric loop ${fmt(qsc.w_J_kg, 4)} J/kg, stroke ${fmt(100 * qsc.stroke, 3)} % · cell ξ swing ${fmt(cell.xiSwing, 3)} · C_A, C_M recovered to ${fmt(100 * Math.max(Math.abs(fA.p[1] / mat.CA - 1), Math.abs(fM.p[1] / mat.CM - 1)), 2)} %.`;
    out.headlineKind = okW && cell.xiSwing > 0.9 ? 'ok' : okW ? 'warn' : 'fail';
    out.outputs = {
      xiHistory: { t: down(prog.t), T: down(prog.T), xi: down(prog.xi) }, wLoop_J_kg: qsc.w_J_kg, dissipated_J_m3: sup.dissipated_J_m3, dissipatedThermal_J_m3: Dth,
      temps: { H: tH, L: tL }, kinetics: p.kinetics, stroke: qsc.stroke, stroke_mm: qsc.stroke * L * 1e3, CA_fit: fA.p[1], CM_fit: fM.p[1], hysteresis_K: hystW, xiSwingCell: cell.xiSwing, tReverse_s: Number.isFinite(tRev) ? tRev : null,
    };
    out.credibility = 'Numerically verified';
    return out;
  },
};

async function animate(el, { field, nX, Lhalf, tHeat, Pd, p, tH, tL, xiMeanF }) {
  const [{ anim2d, seriesPanel, at, lerp, label, para, fs, theme }, { cmap, cssColor }] = await Promise.all([import('../core/anim2d.js'), import('../core/chart.js')]);
  const T = field.t, Ts = field.T.map(r => r[nX - 1]), Tcen = field.T.map(r => r[0]);
  anim2d(el, { duration: T[T.length - 1], rate: Math.min(1, 0.4 * Pd) / Pd, height: (W) => W < 640 ? 760 : 460, label: 'Cycle time', unit: 's', explain: 'Left: ribbon cross-section (both halves mirrored about the mid-plane) coloured by the solved martensite fraction (blue = martensite, red = austenite) with the fluid colour at the faces. Right: surface/centre temperature and mean ξ histories, and the operating point on the ξ–T loop at σH. All frames come from the solved field run.', draw: (g, t, W, H) => {
    const th = theme(), k = at(T, t), hot = t < tHeat, narrow = W < 640, z = fs(W), x0 = narrow ? 14 : 20, w = narrow ? W - 28 : Math.min(320, W * 0.38);
    const yHead = para(g, hot ? `HOT fluid ${p.Tmax} °C — heating at σH = ${p.sigmaH} MPa` : `COLD fluid ${p.Tmin} °C — cooling at σL = ${p.sigmaL} MPa`, x0, 18, w, { size: z + 1, weight: 'bold', color: hot ? '#ef4444' : '#3b82f6', maxLines: 2 });
    const y0 = yHead + 12, hh = narrow ? 170 : H - y0 - 64, bandH = hh / (2 * nX);
    g.fillStyle = hot ? 'rgba(239,68,68,.35)' : 'rgba(59,130,246,.35)'; g.fillRect(x0, y0 - 12, w, 10); g.fillRect(x0, y0 + hh + 2, w, 10);
    for (let j = 0; j < 2 * nX; j++) { const i = j < nX ? nX - 1 - j : j - nX, xi = lerp(field.xi.map(r => r[i]), k); g.fillStyle = cssColor(cmap(1 - xi, 'coolwarm')); g.fillRect(x0, y0 + j * bandH, w, bandH + 0.5); }
    g.strokeStyle = th.fg; g.strokeRect(x0, y0, w, hh); g.setLineDash([4, 4]); g.beginPath(); g.moveTo(x0, y0 + hh / 2); g.lineTo(x0 + w, y0 + hh / 2); g.stroke(); g.setLineDash([]);
    const yCap = para(g, `thickness ${fmt(2 * Lhalf * 1e6, 3)} µm (not to scale) · mean ξ = ${fmt(lerp(xiMeanF, k), 3)}`, x0, y0 + hh + 14 + z, w, { size: z - 1, color: th.mute, maxLines: 2 });
    const px = narrow ? 10 : x0 + w + 24, pw = narrow ? W - 20 : W - px - 12, top = narrow ? yCap + 4 : 10, ph = (H - top - 20) / 2;
    seriesPanel(g, { x: px, y: top, w: pw, h: ph, T, t, title: 'Temperature', unit: '°C', series: [{ name: 'surface', y: Ts, color: '#f97316' }, { name: 'mid-plane', y: Tcen, color: '#eab308' }], hlines: [{ y: tH.Af, label: 'A_f(σH)', color: '#ef4444' }, { y: tL.Mf, label: 'M_f(σL)', color: '#3b82f6' }] });
    seriesPanel(g, { x: px, y: top + ph + 10, w: pw, h: ph, T, t, title: 'Mean martensite fraction', unit: '–', series: [{ name: 'ξ', y: xiMeanF, color: '#a855f7' }], ymin: 0, ymax: 1 });
  } });
}
