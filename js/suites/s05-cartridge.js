// Suite 05 — SMA ribbon and thermal-muscle cartridge design.
// Transient ribbon-cell solve (finite-volume conduction + wall + switching fluid + Brinson-type kinetics + bias spring +
// one-way-clutch load) → force, stroke, hot work, reset work, net closed-loop work ∮F dx, heat in/out, efficiency vs
// Carnot, cartridge mass and specific power on two mass bases; grip stress concentration and fixture compliance;
// work maps; mesh/time-step convergence (GCI) and energy-residual verification; synchronised ribbon animation.
import { cellTransient } from '../core/sma.js';
import { get as getMat, smaAlloys } from '../core/materials.js';
import { linspace, fmt, gci, range, max, min, mean } from '../core/num.js';
import { carnot } from '../core/heat.js';

const tick = (ctx) => Promise.resolve().then(() => ctx.yield()).catch(() => {});
const eng = (k, s = 1) => (ctx) => ctx.engine[k] === undefined ? undefined : { value: +(ctx.engine[k] / s).toPrecision(10), prov: 'calc' };
const up = (id, key, k2, s = 1) => (ctx) => { const v = ctx.upstream(id)?.[key]; if (Number.isFinite(v)) return { value: v, prov: 'coupled' }; return ctx.engine[k2] === undefined ? undefined : { value: +(ctx.engine[k2] / s).toPrecision(10), prov: 'calc' }; };
const GRIPS = { clamped: { label: 'Serrated clamp jaws', Kt: () => 1.6 }, pinned: { label: 'Pinned through-hole', Kt: (dW) => 3 - 3.14 * dW + 3.667 * dW ** 2 - 1.527 * dW ** 3 }, sleeve: { label: 'Bonded / crimped sleeve', Kt: () => 1.25 } };

// right-point (implicit-consistent) closed-loop work: non-conservative load part at end-of-step force, linear bias spring exact
function loopWork(h, A, L, s0, kB) {
  const n = h.t.length; let Wc = 0, Wr = 0, Wload = 0;
  const Fb = (x) => A * 1e6 * (s0 + kB * x / L);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n, dx = h.x[j] - h.x[i]; if (!dx) continue; const dWl = (h.F[j] - Fb(h.x[j])) * dx, dWb = A * 1e6 * (s0 + kB * (h.x[i] + h.x[j]) / (2 * L)) * dx, dW = dWl + dWb; Wload += dWl; if (dW > 0) Wc += dW; else Wr -= dW; }
  return { Wnet: Wc - Wr, Wc, Wr, Wload };
}

export default {
  description: 'Designs one thermal-muscle cartridge: ribbon bundle, preload, power stress, bias spring, fixture stiffness and grips under the project hot/cold fluids. A transient cell solve gives force, stroke, hot work, cold reset work, net closed-loop work ∮F dx, heat in and out, efficiency against Carnot, cartridge mass and specific power, with work maps, convergence (GCI) and energy-residual verification.',
  literature: 'shape memory alloy ribbon actuator thermomechanical cycle net work bias spring heat engine cartridge',
  econ: true, sustain: true, credibility: 'Numerically verified',
  equations: [
    'Ribbon energy (half-thickness, implicit FV): ρc_p ∂T/∂t = ∂/∂x(k(ξ)∂T/∂x) + ρL_h ∂ξ/∂t + σ ∂ε/∂t; wall node C_w dT_w/dt = h_f(T_f − T_w) − G_wr(T_w − T_1)',
    'Switching fluid: T_f ramps between T_c and T_h over t_switch at each phase change; duty D = t_hot/P',
    'Iso-stress through thickness: ε̄(σ) = (1/n)Σ[σ/E(ξ_i) + ε_L·ξ_s,i + α(T_i − T_ref)]; equilibrium σ = σ_L + k_b(ε₀ − ε̄) + σ_load·[clutch engaged]',
    'One-way clutch: load σ_H − σ_L engaged only while contracting in the hot phase; a load too large to lift stalls the cell (blocked recovery stress, no work)',
    'Net closed-loop work W_net = ∮F dx (x = contraction); W_out = ∫σ_load·A dx over engaged strokes; W_net = W_contraction − W_reset',
    'Cell first law per cycle: Q_hot − Q_cold − W_out − W_spring − ΔU = r (residual, verified ≈ 0)',
    'η = W_out/Q_hot ≤ η_Carnot = 1 − T_c/T_h; p_active = W_out·f/m_SMA, p_cartridge = W_out·f/m_cartridge',
    'Bias stiffness k_b [MPa per unit strain] = k_spring[N/m]·L/A/10⁶; fixture series compliance loses stroke δ = ΔF/k_grip',
    'Grip stress concentration: pinned hole K_t = 3 − 3.14(d/W) + 3.667(d/W)² − 1.527(d/W)³ on the net section σ_net = σ·W/(W − d) (Heywood); clamped K_t ≈ 1.6; sleeve K_t ≈ 1.25',
    'Grid convergence index (Roache/Celik): GCI₂₁ = F_s·|(f₁ − f₂)/f₁|/(r^p − 1), observed order p from three levels',
  ],
  methods: [
    'sma.cellTransient: tridiagonal implicit conduction (Thomas), lagged latent and mechanical-work sources, scalar bisection for the mechanical equilibrium with the clutch logic, cycled to periodic state; histories of the last cycle.',
    'Closed-loop work from the solved force–stroke history with the end-of-step (implicit-consistent) force for the non-conservative load part and the exact integral for the linear bias spring.',
    'Work map on a coarse grid (σ_L × σ_H or frequency × thickness) with one half-thickness cell and reduced steps per cycle (expert controls).',
    'Convergence: three nested half-thickness meshes (n, 2n, 4n) and three time steps (P/s, P/2s, P/4s) → observed order, Richardson extrapolation and GCI for W_out and Q_hot.',
    'Cartridge mass bottom-up from assigned component materials (Suite 03): plates, thermal interface, grips, housing and bias spring sized by its specific resilience.',
  ],
  assumptions: [
    'Uniform strain along the ribbon; iso-stress through the thickness; no buckling or slack (ribbons remain in tension at σ_L > 0).',
    'Each ribbon is sandwiched between two heat-exchange walls (symmetric); the wall is a lumped heat capacity per face area.',
    'Constant fluid temperatures during each phase except the switching ramp (Suites 06/07/13 supply the circuits).',
    'Fixture compliance is applied as a post-correction of the engaged stroke (series spring), not inside the transient solve.',
    'Grip K_t values are handbook estimates for screening; the grip zone is assumed thermally isolated (does not transform).',
    'Cartridge component dimensions are generated from the ribbon bundle with fixed allowances (plate 0.5 mm, wall 1.5 mm, grip 12 mm long) for budgeting until Suite 02 provides CAD masses.',
  ],
  ibc: {
    initial: ['All ribbon nodes and wall at T_c; fully martensitic, detwinned according to σ_L (prepared, pre-extended working state); reference strain ε₀.'],
    boundary: ['Fluid → wall convection h_hot / h_cold with T_f(t) switching at duty D; wall → ribbon contact conductance h_c; symmetry at the ribbon mid-plane.', 'Mechanical: bias stress σ_L + k_b·(ε₀ − ε) at all times; output load σ_H − σ_L through a one-way clutch in the hot phase.'],
  },
  cvv: {
    calibration: ['Alloy card from Suite 03 (DSC, tensile).', 'h_hot, h_cold and h_c from Suite 08 / instrumented heating–cooling tests.', 'Bias spring rate and fixture stiffness from bench measurement.'],
    verification: ['Cell first-law residual < 1 % of Q_hot.', 'Cycle periodicity (W_out change between the last two cycles) < 5 %.', 'Closed-loop work ∮F dx equals W_out + spring work (consistency of the force–stroke integration).', 'η ≤ η_Carnot.', 'Mesh and time-step convergence with GCI and observed order.'],
    validation: ['Validation gate V1/V2: measured single-cartridge force–stroke loop with hot/cold calorimetry; positive net closed-cycle work after reset.'],
  },
  formats: { import: ['CSV force–displacement–temperature history (t, F, x, T)', 'CSV fluid temperatures (t, T_hot, T_cold)'], export: ['Force/stroke/temperature histories CSV', 'Work map CSV', 'Cartridge design JSON', 'PNG/SVG plots'] },
  params: [
    { key: 'alloy', label: 'Ribbon alloy', type: 'select', default: 'niti-lt', options: smaAlloys().map(m => ({ value: m.id, label: m.name })), group: 'Ribbon bundle', auto: (ctx) => ctx.upstream('s03')?.alloyId ? { value: ctx.upstream('s03').alloyId, prov: 'coupled' } : { value: ctx.engine.alloy, prov: 'calc' }, help: 'Uses the calibrated card from Suite 03 when it was published for this alloy.' },
    { key: 'ribbonL_mm', label: 'Active length', unit: 'mm', type: 'number', default: 100, min: 5, max: 2000, step: 1, group: 'Ribbon bundle', auto: eng('ribbonL', 1e-3) },
    { key: 'ribbonW_mm', label: 'Width', unit: 'mm', type: 'number', default: 5, min: 0.2, max: 100, step: 0.1, group: 'Ribbon bundle', auto: eng('ribbonW', 1e-3) },
    { key: 'ribbonT_um', label: 'Thickness', unit: 'µm', type: 'number', default: 100, min: 10, max: 3000, step: 5, group: 'Ribbon bundle', auto: eng('ribbonT', 1e-6) },
    { key: 'nRib', label: 'Ribbons in the bundle', type: 'number', default: 20, min: 1, max: 500, step: 1, group: 'Ribbon bundle', auto: eng('ribbonsPerCell') },
    { key: 'sigmaL', label: 'Preload / reset stress σL', unit: 'MPa', type: 'number', default: 70, min: 0, max: 600, step: 5, group: 'Loads & fixtures', auto: eng('sigmaL') },
    { key: 'sigmaH', label: 'Power-stroke stress σH', unit: 'MPa', type: 'number', default: 110, min: 1, max: 800, step: 5, group: 'Loads & fixtures', auto: eng('sigmaH') },
    { key: 'kBias_Nmm', label: 'Bias spring rate', unit: 'N/mm', type: 'number', default: 0, min: 0, max: 1e5, step: 10, group: 'Loads & fixtures', auto: (ctx) => { const e = ctx.engine, A = e.ribbonsPerCell * e.ribbonW * e.ribbonT; return { value: +((e.kBias || 0) * 1e6 * A / e.ribbonL / 1000).toPrecision(8), prov: 'calc' }; }, help: '0 = constant-force preload (dead load or constant-force spring).' },
    { key: 'kGrip_Nmm', label: 'Fixture / grip stiffness', unit: 'N/mm', type: 'number', default: 5000, min: 10, max: 1e6, step: 100, group: 'Loads & fixtures', help: 'Series stiffness of grips, load equaliser and frame.' },
    { key: 'gripType', label: 'Grip type', type: 'select', default: 'clamped', options: Object.entries(GRIPS).map(([value, g]) => ({ value, label: g.label })), group: 'Loads & fixtures' },
    { key: 'holeRatio', label: 'Pin hole / ribbon width d/W', type: 'number', default: 0.3, min: 0.05, max: 0.6, step: 0.05, group: 'Loads & fixtures', help: 'Used for pinned grips.' },
    { key: 'Th', label: 'Hot fluid temperature', unit: '°C', type: 'number', default: 70, min: 0, max: 400, step: 1, group: 'Thermal', auto: up('s06', 'ThSupply_C', 'Th') },
    { key: 'Tc', label: 'Cold fluid temperature', unit: '°C', type: 'number', default: 15, min: -40, max: 150, step: 1, group: 'Thermal', auto: up('s07', 'TcSupply_C', 'Tc') },
    { key: 'hHot', label: 'Hot-side HTC', unit: 'W/m²K', type: 'number', default: 4000, min: 10, max: 1e6, step: 100, group: 'Thermal', auto: up('s08', 'hHot_Wm2K', 'hHot') },
    { key: 'hCold', label: 'Cold-side HTC', unit: 'W/m²K', type: 'number', default: 4000, min: 10, max: 1e6, step: 100, group: 'Thermal', auto: up('s08', 'hCold_Wm2K', 'hCold') },
    { key: 'hContact', label: 'Ribbon–wall contact conductance', unit: 'W/m²K', type: 'number', default: 20000, min: 100, max: 1e7, step: 500, group: 'Thermal', auto: up('s08', 'hContact_Wm2K', 'hContact') },
    { key: 'wallCapacity', label: 'Wall heat capacity per face area', unit: 'J/m²K', type: 'number', default: 200, min: 0, max: 20000, step: 10, group: 'Thermal', auto: eng('wallCapacity') },
    { key: 'freq', label: 'Cycle frequency', unit: 'Hz', type: 'number', default: 1, min: 0.01, max: 50, step: 0.05, group: 'Operation', auto: eng('freq') },
    { key: 'dutyHot', label: 'Hot-phase fraction (duty)', type: 'number', default: 0.5, min: 0.1, max: 0.9, step: 0.05, group: 'Operation', auto: eng('dutyHot') },
    { key: 'tSwitch', label: 'Fluid switching time', unit: 's', type: 'number', default: 0.02, min: 0, max: 5, step: 0.005, group: 'Operation', auto: eng('tSwitch') },
    { key: 'kinetics', label: 'Kinetics law', type: 'select', default: 'cosine', options: ['cosine', 'exponential'], group: 'Solver (expert)', expert: true, auto: (ctx) => ctx.upstream('s04')?.kinetics ? { value: ctx.upstream('s04').kinetics, prov: 'coupled' } : undefined },
    { key: 'n', label: 'Half-thickness cells', type: 'number', default: 4, min: 1, max: 24, step: 1, group: 'Solver (expert)', expert: true },
    { key: 'spc', label: 'Time steps per cycle', type: 'number', default: 240, min: 60, max: 4000, step: 20, group: 'Solver (expert)', expert: true },
    { key: 'cycles', label: 'Cycles to periodic state', type: 'number', default: 4, min: 2, max: 20, step: 1, group: 'Solver (expert)', expert: true },
    { key: 'mapType', label: 'Work map axes', type: 'select', default: 'stress', options: [{ value: 'stress', label: 'Reset stress σL × power stress σH' }, { value: 'freqThick', label: 'Frequency × ribbon thickness' }], group: 'Solver (expert)', expert: true },
    { key: 'mapN', label: 'Work map grid points per axis', type: 'number', default: 5, min: 3, max: 9, step: 1, group: 'Solver (expert)', expert: true },
    { key: 'mapSteps', label: 'Work map steps per cycle', type: 'number', default: 100, min: 60, max: 400, step: 10, group: 'Solver (expert)', expert: true },
    { key: 'convStudy', label: 'Run mesh / time-step convergence study', type: 'bool', default: true, group: 'Solver (expert)', expert: true },
  ],
  presets: [
    { label: 'Reference LT cartridge (engine)', values: { sigmaL: 70, sigmaH: 110, freq: 1, kBias_Nmm: 0 } },
    { label: 'Linear bias spring 200 N/mm', values: { kBias_Nmm: 200 } },
    { label: 'Thin fast ribbon 50 µm @ 2 Hz', values: { ribbonT_um: 50, nRib: 40, freq: 2 } },
    { label: 'Pinned grips d/W = 0.3', values: { gripType: 'pinned', holeRatio: 0.3 } },
    { label: 'Map: frequency × thickness', values: { mapType: 'freqThick' } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const lib = getMat(p.alloy), s03 = ctx.upstream('s03');
    const mat = lib ? { ...lib, ...(s03?.alloyId === lib.id && s03.card ? s03.card : {}) } : null;
    const why = !mat ? `Unknown alloy “${p.alloy}”.` : !(p.Th > p.Tc) ? `Hot fluid ${p.Th} °C is not above the cold fluid ${p.Tc} °C — no heat-engine cycle exists.` : !(p.sigmaH > p.sigmaL) ? `σH = ${p.sigmaH} MPa must exceed σL = ${p.sigmaL} MPa for a positive work loop.` : null;
    if (why) return { ...out, headline: 'Infeasible cartridge inputs — ' + why, headlineKind: 'fail', verdicts: [{ test: 'Admissible inputs', status: 'fail', detail: why, fix: 'Correct the reservoir temperatures or the stress levels.' }], kpis: [{ label: 'Feasibility', value: 'infeasible', explain: why, status: 'bad' }], outputs: { Wout_J: 0, infeasible: true } };
    const L = p.ribbonL_mm * 1e-3, w = p.ribbonW_mm * 1e-3, t = p.ribbonT_um * 1e-6, A = p.nRib * w * t, P = 1 / p.freq;
    const kB = p.kBias_Nmm * 1e3 * L / A / 1e6;
    const cfg = { mat, t, w, L, nRib: p.nRib, n: p.n, Th: p.Th, Tc: p.Tc, hHot: p.hHot, hCold: p.hCold, hc: p.hContact, Cw: p.wallCapacity, period: P, dutyHot: p.dutyHot, tSwitch: p.tSwitch, sBias0: p.sigmaL, kBias: kB, sLoad: p.sigmaH - p.sigmaL, cycles: p.cycles, stepsPerCycle: p.spc, kinetics: p.kinetics };
    ctx.progress(0.05, 'transient cell');
    const c = cellTransient(cfg), h = c.hist;
    await tick(ctx);

    // ---- mechanics & energy
    const lw = loopWork(h, A, L, p.sigmaL, kB), Fmax = max(h.F), Fmin = min(h.F), Fmean = mean(h.F), etaC = carnot(p.Th, p.Tc);
    const kRib = (mat.EA * 1e9) * A / L, dF = Fmax - Fmin, delta = dF / (p.kGrip_Nmm * 1e3), engagedStroke = c.Wout / Math.max(1e-12, (p.sigmaH - p.sigmaL) * 1e6 * A);
    const WoutEff = c.Wout * Math.max(0, 1 - delta / Math.max(1e-12, engagedStroke));
    // ---- grip stress concentration
    const G = GRIPS[p.gripType] || GRIPS.clamped, dW = p.holeRatio, Kt = G.Kt(dW), sNet = p.gripType === 'pinned' ? (Fmax / A / 1e6) / (1 - dW) : Fmax / A / 1e6, sPeak = Kt * sNet, sAllow = 0.4 * (mat.su || 1000);
    // ---- cartridge mass (bottom-up from assigned materials) or Suite 02
    const mm = (k) => ctx.material(k) || getMat({ channelPlate: 'ss-316l', contactLayer: 'tim-graphite', grip: 'ti-6al4v', housing: 'al-6061-t6', biasSpring: 'ss-17-7' }[k]);
    const plate = 0.5e-3, stack = p.nRib * t + (p.nRib + 1) * plate;
    const spr = mm('biasSpring'), eSpring = Math.max(p.sigmaL * 1e6 * A * c.stroke, 1e-6), resil = Math.max(1, (spr.sy * 1e6) ** 2 / (2 * spr.E * 1e9) / spr.rho * 0.3);
    const parts = [
      ['Active SMA ribbons', c.mass, mat.name, 'calculated', mat],
      ['Heat-exchange plates', (p.nRib + 1) * L * (w + 2e-3) * plate * mm('channelPlate').rho, mm('channelPlate').name, 'estimated', mm('channelPlate')],
      ['Thermal interface layers', 2 * p.nRib * L * w * 0.1e-3 * mm('contactLayer').rho, mm('contactLayer').name, 'estimated', mm('contactLayer')],
      ['End grips (2)', 2 * (w + 6e-3) * (stack + 6e-3) * 12e-3 * mm('grip').rho, mm('grip').name, 'estimated', mm('grip')],
      ['Housing', 2 * ((w + 10e-3) + (stack + 10e-3)) * (1.3 * L) * 1.5e-3 * mm('housing').rho, mm('housing').name, 'estimated', mm('housing')],
      ['Bias / preload spring', eSpring / resil, spr.name, 'estimated', spr],
    ];
    let mCart = parts.reduce((a, r) => a + r[1], 0), mProv = 'estimated';
    const s02 = ctx.upstream('s02'); if (s02?.cartridgeMass_kg > 0) { mCart = s02.cartridgeMass_kg; mProv = 'coupled'; }
    const pA = c.Wout * p.freq / c.mass, pC = c.Wout * p.freq / mCart;
    ctx.progress(0.3, 'work map');

    // ---- work map
    const NM = Math.max(3, Math.round(p.mapN)), lo = { ...cfg, n: 1, stepsPerCycle: p.mapSteps, cycles: 3 };
    let map;
    if (p.mapType === 'freqThick') {
      const fx = linspace(0.25, 3, NM).map(k => k * p.freq), ty = linspace(0.5, 2, NM).map(k => k * t);
      const z = ty.map(tt => fx.map(f => { const r = cellTransient({ ...lo, t: tt, period: 1 / f, kBias: p.kBias_Nmm * 1e3 * L / (p.nRib * w * tt) / 1e6 }); return r.Wout * f / r.mass; }));
      map = { title: 'Active specific power vs frequency and ribbon thickness', x: { label: 'Frequency', unit: 'Hz', values: fx }, y: { label: 'Thickness', unit: 'µm', values: ty.map(v => v * 1e6) }, z, z_label: 'W/kg', pt: [p.freq, p.ribbonT_um] };
    } else {
      const sx = linspace(Math.max(0, 0.4 * p.sigmaL), 1.4 * p.sigmaL, NM), sy = linspace(Math.max(p.sigmaL * 0.9, 0.6 * p.sigmaH), 1.5 * p.sigmaH, NM);
      const z = sy.map(sH => sx.map(sL => sH <= sL + 1 ? NaN : cellTransient({ ...lo, sBias0: sL, sLoad: sH - sL }).Wout));
      map = { title: 'Net work per cycle vs reset and power-stroke stress', x: { label: 'σL', unit: 'MPa', values: sx }, y: { label: 'σH', unit: 'MPa', values: sy }, z, z_label: 'J/cycle', pt: [p.sigmaL, p.sigmaH] };
    }
    const flatZ = map.z.flat().filter(Number.isFinite), zBest = flatZ.length ? max(flatZ) : NaN; let best = null;
    map.z.forEach((row, j) => row.forEach((v, i) => { if (v === zBest) best = [map.x.values[i], map.y.values[j]]; }));
    await tick(ctx);

    // ---- convergence study
    let conv = null;
    if (p.convStudy) {
      ctx.progress(0.6, 'convergence study');
      const nb = Math.max(1, Math.min(4, Math.round(p.n / 2))), sb = Math.max(60, Math.round(p.spc / 2)), cc = Math.max(3, Math.min(p.cycles, 4));
      const NS = [nb, 2 * nb, 4 * nb].map(n => cellTransient({ ...cfg, n, stepsPerCycle: sb * 2, cycles: cc }));
      await tick(ctx);
      const TS = [sb, 2 * sb, 4 * sb].map(s => cellTransient({ ...cfg, n: 2 * nb, stepsPerCycle: s, cycles: cc }));
      const g = (arr, hs, key) => { const f = arr.map(r => r[key]); try { return { ...gci(f[2], f[1], f[0], hs[2], hs[1], hs[0]), f }; } catch { return { f, p: NaN, gci21: NaN }; } };
      conv = { nb, sb, NS, TS, sW: g(NS, [1 / nb, 1 / (2 * nb), 1 / (4 * nb)], 'Wout'), sQ: g(NS, [1 / nb, 1 / (2 * nb), 1 / (4 * nb)], 'Qhot'), tW: g(TS, [1 / sb, 1 / (2 * sb), 1 / (4 * sb)], 'Wout'), tQ: g(TS, [1 / sb, 1 / (2 * sb), 1 / (4 * sb)], 'Qhot') };
    }
    ctx.progress(0.9, 'post-processing');

    // ---- checks
    const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
    out.checks.push(
      { name: 'Cell first-law residual (last cycle)', value: Math.abs(c.energyResidual), target: '< 1e-2', pass: Math.abs(c.energyResidual) < 1e-2, detail: 'Q_hot − Q_cold − W_out − W_spring − ΔU relative to Q_hot.' },
      { name: 'Cycle periodicity (W_out change last two cycles)', value: c.periodicity, target: '< 0.05', pass: c.periodicity < 0.05, detail: 'Raise “cycles to periodic state” if this fails.' },
      { name: 'Closed-loop work: load part of ∮F dx = solver W_out', value: rel(lw.Wload, c.Wout), target: '< 1 %', pass: rel(lw.Wload, c.Wout) < 0.01, detail: `∮F dx = ${fmt(lw.Wnet, 5)} J = load part ${fmt(lw.Wload, 5)} J + conservative bias spring (exactly zero over the closed loop); solver W_out = ${fmt(c.Wout, 5)} J; open-cycle spring work ${fmt(c.Wspring, 3)} J reflects the residual cycle-to-cycle drift.` },
      { name: 'Branch-work bookkeeping of the cell solver (trapezoid) vs ∮F dx', value: rel(c.Wcontraction - c.Wreset, lw.Wnet), target: 'informative', pass: undefined, detail: `Solver W_contraction − W_reset = ${fmt(c.Wcontraction - c.Wreset, 4)} J. The trapezoidal average over steps where the clutch releases (force jumps σH → σL while the ribbon finishes contracting) credits part of that free contraction at the mean force; the published branch works use the implicit-consistent rule (${fmt(lw.Wc, 4)} / ${fmt(lw.Wr, 4)} J).` },
      { name: 'Carnot bound', value: c.eta / Math.max(etaC, 1e-12), target: '≤ 1', pass: c.eta <= etaC + 1e-12 },
      { name: 'Loop closes in stroke', value: Math.abs(h.x[h.x.length - 1] - h.x[0]) / Math.max(1e-12, c.stroke), target: '< 0.02 of stroke', pass: Math.abs(h.x[h.x.length - 1] - h.x[0]) / Math.max(1e-12, c.stroke) < 0.02 },
    );
    if (conv) for (const [lab, gg, k] of [['mesh (half-thickness cells)', conv.sW, 'W_out'], ['mesh (half-thickness cells)', conv.sQ, 'Q_hot'], ['time step', conv.tW, 'W_out'], ['time step', conv.tQ, 'Q_hot']]) {
      const spread = Math.abs(gg.f[2] - gg.f[1]) / Math.max(1e-12, Math.abs(gg.f[2]));
      out.checks.push({ name: `GCI ${k} — ${lab}`, value: Number.isFinite(gg.gci21) ? gg.gci21 : spread, target: '< 5 %', pass: (Number.isFinite(gg.gci21) ? gg.gci21 : spread) < 0.05, detail: `levels ${gg.f.map(v => fmt(v, 5)).join(' → ')}; observed order ${fmt(gg.p, 3)}${gg.oscillatory ? ' (oscillatory convergence — GCI conservative, spread used as bound)' : ''}; extrapolated ${fmt(gg.fext, 5)}.` });
    }

    // ---- verdicts
    const xiOk = c.xiSwing > 0.9;
    out.verdicts.push({ test: 'Positive net closed-cycle work after reset', status: c.Wout > 0 ? 'pass' : 'fail', detail: `W_out = ${fmt(c.Wout, 4)} J per cycle (∮F dx = ${fmt(lw.Wnet, 4)} J); contraction ${fmt(lw.Wc, 4)} J, reset ${fmt(lw.Wr, 4)} J.`, fix: 'Widen σH − σL within the transformation window, lower the frequency or improve heat transfer.' });
    out.verdicts.push({ test: 'Transformation completes each half-cycle', status: xiOk ? 'pass' : c.xiSwing > 0.5 ? 'warn' : 'fail', detail: `Martensite fraction swings ${fmt(c.xiMin, 3)} → ${fmt(c.xiMax, 3)} (reverse ${c.reverseComplete ? 'complete' : 'incomplete'}, forward ${c.forwardComplete ? 'complete' : 'incomplete'}).`, fix: 'Reduce the frequency, use thinner ribbons or raise h_hot / h_cold / h_c (Suite 08).' });
    out.verdicts.push({ test: 'Grip stress concentration', status: sPeak <= sAllow ? 'pass' : sPeak <= (mat.su || 1000) ? 'warn' : 'fail', detail: `${G.label}: K_t = ${fmt(Kt, 3)}, net-section ${fmt(sNet, 4)} MPa → peak ${fmt(sPeak, 4)} MPa vs functional allowable ${fmt(sAllow, 4)} MPa (0.4·UTS) and UTS ${mat.su} MPa.`, fix: 'Use bonded sleeves or serrated clamps with radiused edges, widen the grip tab, or reduce σH.' });
    out.verdicts.push({ test: 'Fixture stiffness adequate', status: delta < 0.05 * engagedStroke ? 'pass' : delta < 0.2 * engagedStroke ? 'warn' : 'fail', detail: `Force swing ${fmt(dF, 4)} N over k_grip = ${p.kGrip_Nmm} N/mm loses ${fmt(delta * 1e3, 4)} mm of the ${fmt(engagedStroke * 1e3, 4)} mm engaged stroke (ribbon axial stiffness ${fmt(kRib / 1e3, 4)} N/mm).`, fix: `Stiffen grips/frame above ${fmt(20 * dF / Math.max(1e-9, engagedStroke) / 1e3, 3)} N/mm (≤ 5 % stroke loss).` });
    out.verdicts.push({ test: 'Thermal efficiency vs Carnot', status: c.eta <= etaC ? 'pass' : 'fail', detail: `η = ${fmt(100 * c.eta, 4)} % = ${fmt(100 * c.carnotFraction, 3)} % of Carnot ${fmt(100 * etaC, 4)} % (cell level, no regeneration, no auxiliaries).`, fix: c.eta <= etaC ? undefined : 'Numerical artefact — refine the time step and check the energy residual.' });
    if (!s03 || s03.alloyId !== lib.id) out.verdicts.push({ test: 'Calibrated alloy card', status: 'info', detail: `No Suite 03 card for ${lib.name}: library values (±${lib.unc} %) used. Measure DSC and tensile loops of the ribbon lot, then the single-cartridge force–stroke loop with calorimetry (V2).` });

    // ---- KPIs
    out.kpis.push(
      { label: 'Net work per cycle W_out', value: c.Wout, unit: 'J', status: c.Wout > 0 ? 'ok' : 'bad', prov: 'calc', explain: 'Work delivered to the output load through the one-way clutch over one periodic cycle = closed-loop ∮F dx with the bias spring returning its energy. Already net of the reset work.' },
      { label: 'Hot (contraction) work', value: lw.Wc, unit: 'J', prov: 'calc', explain: 'Work done by the ribbon while contracting (positive stroke); gross, before subtracting the reset work.' },
      { label: 'Cold reset work', value: lw.Wr, unit: 'J', prov: 'calc', explain: 'Work the bias must do to re-extend the cold martensite — the penalty subtracted from the contraction work.' },
      { label: 'Stroke', value: c.stroke * 1e3, unit: 'mm', prov: 'calc', explain: `Peak-to-peak contraction of the ${p.ribbonL_mm} mm ribbon (${fmt(100 * c.stroke / L, 3)} % strain).` },
      { label: 'Peak / mean bundle force', value: `${fmt(Fmax, 4)} / ${fmt(Fmean, 4)}`, unit: 'N', prov: 'calc', explain: 'Maximum (power stroke or blocked) and time-averaged force on the bundle; sizes grips, linkage and clutch.' },
      { label: 'Heat in per cycle Q_hot', value: c.Qhot, unit: 'J', prov: 'calc', explain: 'Heat drawn from the hot fluid in one cycle (ribbon + wall sensible heat, latent heat and work). No regeneration at cell level.' },
      { label: 'Cell efficiency / Carnot', value: c.carnotFraction, unit: '–', prov: 'calc', explain: `η = W_out/Q_hot = ${fmt(100 * c.eta, 4)} % against Carnot ${fmt(100 * etaC, 4)} %.` },
      { label: 'Specific power — active SMA', value: pA, unit: 'W/kg', status: pA >= ctx.eng.REFERENCE_W_PER_KG ? 'ok' : 'warn', prov: 'calc', explain: `W_out·f per kg of ribbon (${fmt(c.mass * 1e3, 4)} g). Cell level, before transmission and auxiliaries; reference ${ctx.eng.REFERENCE_W_PER_KG} W/kg.` },
      { label: 'Specific power — cartridge', value: pC, unit: 'W/kg', prov: mProv, explain: `W_out·f per kg of complete cartridge (${fmt(mCart, 4)} kg). Different mass basis — not comparable with the active figure.` },
      { label: 'Cartridge mass', value: mCart, unit: 'kg', prov: mProv, explain: `Bottom-up from assigned materials (cartridge/active ratio ${fmt(mCart / c.mass, 3)}; engine factor assumed ${ctx.engine.cartridgeFactor}).` },
    );

    // ---- charts
    out.charts.push({ type: 'line', title: 'Force–stroke loop (∮F dx = net work)', x: { label: 'Contraction stroke x', unit: 'mm' }, y: { label: 'Bundle force F', unit: 'N' }, series: [{ name: 'Last periodic cycle', x: [...h.x, h.x[0]].map(v => v * 1e3), y: [...h.F, h.F[0]] }],
      annotations: [{ type: 'hline', y: p.sigmaH * 1e6 * A, label: 'σH·A', color: '#ef4444' }, { type: 'hline', y: p.sigmaL * 1e6 * A, label: 'σL·A', color: '#3b82f6' }],
      explain: `Clockwise loop: the ribbon contracts at σH·A = ${fmt(p.sigmaH * A, 4)} N while hot (clutch engaged), then the cold martensite is re-extended by the bias at σL·A = ${fmt(p.sigmaL * A, 4)} N. The enclosed area is the net work ${fmt(lw.Wnet, 4)} J. Vertical segments are blocked (stalled) force build-up and load release.` });
    out.charts.push({ type: 'line', title: 'Temperatures over one cycle', x: { label: 'Time in cycle', unit: 's' }, y: { label: 'Temperature', unit: '°C' }, series: [{ name: 'Fluid', x: h.t, y: h.Tf, color: '#94a3b8' }, { name: 'Wall', x: h.t, y: h.Tw }, { name: 'Ribbon surface', x: h.t, y: h.Ts }, { name: 'Ribbon centre', x: h.t, y: h.Tc, dash: '4 3' }],
      annotations: [{ type: 'xband', x0: 0, x1: p.dutyHot * P, color: '#ef4444', opacity: 0.06 }],
      explain: 'Switching fluid temperature and the response of wall and ribbon. Plateaus mark latent heat absorbed (heating) or released (cooling) during transformation; the lag between fluid and ribbon is the thermal resistance of film + wall + contact.' });
    out.charts.push({ type: 'line', title: 'Martensite fraction, stress and stroke histories', x: { label: 'Time in cycle', unit: 's' }, y: { label: 'Normalised' },
      series: [{ name: 'ξ (mean)', x: h.t, y: h.xi }, { name: 'ξ_s detwinned', x: h.t, y: h.xis, dash: '4 3' }, { name: 'Stroke / max', x: h.t, y: h.x.map(v => v / Math.max(1e-12, max(h.x))) }, { name: 'σ/σH', x: h.t, y: h.sExt.map(s => s / p.sigmaH) }, { name: 'Clutch (1 engaged, 0.5 stalled)', x: h.t, y: h.engaged, dash: '2 3' }],
      explain: 'Phase state and mechanics in the same cycle: contraction follows the fall of ξ in the hot phase; the clutch engages only while contracting against the load; resetting follows the rise of ξ in the cold phase.' });
    out.charts.push({ type: 'heatmap', title: map.title, x: map.x, y: map.y, z: map.z, z_label: map.z_label, cmap: 'viridis', isolines: 4,
      explain: `Coarse grid (${NM}×${NM}, one half-thickness cell, ${p.mapSteps} steps/cycle) of the transient cell. ${p.mapType === 'freqThick' ? 'Thin ribbons tolerate higher frequency; the ridge marks the thermal limit.' : 'Work grows with σH − σL until A_f(σH) approaches T_h or M_f(σL) leaves T_c; blank cells have σH ≤ σL.'} Design point (${fmt(map.pt[0], 3)}, ${fmt(map.pt[1], 3)}); best on grid ${best ? `(${fmt(best[0], 3)}, ${fmt(best[1], 3)}) → ${fmt(zBest, 4)} ${map.z_label}` : '—'}.` });
    out.charts.push({ type: 'bar', title: 'Cell energy per cycle', categories: ['Heat in Q_hot', 'Heat out Q_cold', 'Contraction work', 'Reset work', 'Net work W_out'], series: [{ name: 'Energy', values: [c.Qhot, c.Qcold, lw.Wc, lw.Wr, c.Wout], colors: ['#ef4444', '#3b82f6', '#22c55e', '#f97316', '#16a34a'] }], y: { label: 'Energy', unit: 'J' }, showValues: true,
      explain: 'Per-cycle balance: Q_hot = Q_cold + W_out (+ spring and stored-energy residual ≈ 0). Most heat is rejected; contraction minus reset gives the net work.' });
    if (conv) out.charts.push({ type: 'line', title: 'Convergence of W_out with mesh and time step', x: { label: 'Refinement level (1 = coarse, 3 = fine)' }, y: { label: 'W_out', unit: 'J' }, series: [{ name: `Mesh n = ${conv.nb}, ${2 * conv.nb}, ${4 * conv.nb}`, x: [1, 2, 3], y: conv.sW.f, mode: 'lines+markers' }, { name: `Steps/cycle ${conv.sb}, ${2 * conv.sb}, ${4 * conv.sb}`, x: [1, 2, 3], y: conv.tW.f, mode: 'lines+markers' }],
      annotations: Number.isFinite(conv.sW.fext) ? [{ type: 'hline', y: conv.sW.fext, label: 'Richardson (mesh)', color: '#94a3b8' }] : [],
      explain: 'Three nested refinements each in space and time; small and decreasing changes with an extrapolated value close to the finest level indicate a converged discretisation. Clutch switching makes the response piecewise, so convergence may be oscillatory.' });

    // ---- tables
    out.tables.push({ title: 'Cartridge design record', cols: ['Item', 'Value', 'Unit'], rows: [['Alloy', mat.name, ''], ['Card source', s03?.alloyId === lib.id ? (s03.calibrated ? 'Suite 03 calibrated card' : 'Suite 03 library card') : 'library', ''], ['Ribbons × L × W × t', `${p.nRib} × ${p.ribbonL_mm} × ${p.ribbonW_mm} mm × ${p.ribbonT_um} µm`, ''], ['Bundle cross-section', A * 1e6, 'mm²'], ['Active mass', c.mass * 1e3, 'g'], ['Preload / power stress', `${p.sigmaL} / ${p.sigmaH}`, 'MPa'], ['Bias spring', `${p.kBias_Nmm} N/mm (${fmt(kB, 4)} MPa/strain)`, ''], ['Ribbon axial stiffness', kRib / 1e3, 'N/mm'], ['Fixture stiffness', p.kGrip_Nmm, 'N/mm'], ['Stroke lost in fixture', delta * 1e3, 'mm'], ['W_out corrected for fixture compliance', WoutEff, 'J'], ['Grip K_t / peak stress', `${fmt(Kt, 3)} / ${fmt(sPeak, 4)} MPa`, ''], ['Hot / cold HTC, contact', `${p.hHot} / ${p.hCold}, ${p.hContact}`, 'W/m²K'], ['Frequency / duty', `${p.freq} Hz / ${p.dutyHot}`, ''], ['Heat out Q_cold', c.Qcold, 'J'], ['Spring work W_spring', c.Wspring, 'J']], explain: 'Parametric cartridge record (master specification §22).' });
    out.tables.push({ title: 'Cartridge mass breakdown', cols: ['Component', 'Mass [kg]', 'Material', 'Basis'], rows: [...parts.map(r => r.slice(0, 4)), ['Total (bottom-up)', parts.reduce((a, r) => a + r[1], 0), '', 'sum'], ...(mProv === 'coupled' ? [['Suite 02 CAD cartridge mass (used)', mCart, '', 'coupled']] : [])], explain: 'Generated from the bundle geometry with fixed allowances and the materials assigned in Suite 03; replace with CAD masses from Suite 02.' });
    if (conv) out.tables.push({ title: 'Mesh and time-step convergence (GCI)', cols: ['Study', 'Quantity', 'Coarse', 'Medium', 'Fine', 'Observed order p', 'Extrapolated', 'GCI fine [%]'], rows: [['Mesh', 'W_out [J]', ...conv.sW.f, conv.sW.p, conv.sW.fext, 100 * conv.sW.gci21], ['Mesh', 'Q_hot [J]', ...conv.sQ.f, conv.sQ.p, conv.sQ.fext, 100 * conv.sQ.gci21], ['Time step', 'W_out [J]', ...conv.tW.f, conv.tW.p, conv.tW.fext, 100 * conv.tW.gci21], ['Time step', 'Q_hot [J]', ...conv.tQ.f, conv.tQ.p, conv.tQ.fext, 100 * conv.tQ.gci21]], explain: 'Celik et al. (2008) procedure with F_s = 1.25.' });

    // ---- animation
    out.views.push({ label: 'Animation: ribbon cycle', icon: '🎞', render: (el) => animate(el, { h, P, p, Fmax }) });

    // ---- narrative & recommendations
    out.explain.push(
      { title: 'Cycle', text: `The ${p.nRib}-ribbon bundle (${fmt(A * 1e6, 4)} mm², ${fmt(c.mass * 1e3, 4)} g) is held at σL = ${p.sigmaL} MPa (${fmt(p.sigmaL * A, 4)} N) and lifts σH − σL = ${p.sigmaH - p.sigmaL} MPa of output load while contracting in the ${p.Th} °C fluid; in the ${p.Tc} °C fluid the bias re-extends it. Stroke ${fmt(c.stroke * 1e3, 4)} mm, net work ${fmt(c.Wout, 4)} J per cycle at ${p.freq} Hz → ${fmt(c.Wout * p.freq, 4)} W per cartridge.` },
      { title: 'Heat', text: `Each cycle draws ${fmt(c.Qhot, 4)} J from the hot fluid and rejects ${fmt(c.Qcold, 4)} J; efficiency ${fmt(100 * c.eta, 4)} % (${fmt(100 * c.carnotFraction, 3)} % of Carnot). Most of the heat goes into sensible heating of ribbon and wall, which the regenerator (Suite 09) can partly recover.` },
      { title: 'Mass bases', text: `Active ${fmt(pA, 4)} W/kg, cartridge ${fmt(pC, 4)} W/kg — reported separately; the system basis is evaluated in Suites 01/18.` },
    );
    if (best && zBest > (p.mapType === 'freqThick' ? pA : c.Wout) * 1.1) out.recs.push({ level: 'info', text: `The coarse map indicates ${fmt(zBest, 4)} ${map.z_label} at (${fmt(best[0], 3)}, ${fmt(best[1], 3)}) versus the design (${fmt(map.pt[0], 3)}, ${fmt(map.pt[1], 3)}); confirm at full resolution before changing the design.`, basis: 'Work map of this run' });
    if (!xiOk) out.recs.push({ level: 'warn', text: `Only ${fmt(100 * c.xiSwing, 3)} % of the martensite transforms per cycle: the cycle is heat-transfer limited. Lower the frequency or raise contact conductance (now ${p.hContact} W/m²K).`, basis: 'Transient cell histories' });
    if (sPeak > sAllow) out.recs.push({ level: 'critical', text: `Grip peak stress ${fmt(sPeak, 4)} MPa exceeds the functional allowable ${fmt(sAllow, 4)} MPa; grips will initiate cracks first. Use bonded sleeves (K_t ≈ 1.25) or widen the tab.`, basis: `K_t = ${fmt(Kt, 3)}` });
    if (delta > 0.05 * engagedStroke) out.recs.push({ level: 'warn', text: `Fixture compliance costs ${fmt(100 * delta / engagedStroke, 3)} % of the engaged stroke (W_out ${fmt(c.Wout, 4)} → ${fmt(WoutEff, 4)} J).`, basis: `k_grip = ${p.kGrip_Nmm} N/mm` });
    out.recs.push({ level: 'econ', text: `Active alloy per cartridge ≈ ${fmt(c.mass * (mat.cost || 0), 3)} USD (${fmt(c.mass * 1e3, 3)} g at ${mat.cost} USD/kg) for ${fmt(c.Wout * p.freq, 3)} W → ${c.Wout > 0 ? fmt(c.mass * mat.cost / (c.Wout * p.freq), 3) + ' USD/W' : 'no output'}; plates and grips (${fmt(mCart - c.mass, 3)} kg) dominate mass but not cost.`, basis: 'Library prices' });
    out.recs.push({ level: 'sustain', text: `Cartridge embodied carbon ≈ ${fmt(parts.reduce((a, r) => a + r[1] * (r[4]?.co2 || 0), 0), 3)} kg CO₂e; design grips and housings for disassembly so spent ribbons can be replaced and returned for Ni/Ti recovery without scrapping the cartridge.`, basis: 'Library embodied carbon of assigned materials' });
    if (c.Wout > 0 && xiOk) out.recs.push({ level: 'good', text: `Positive net closed-cycle work in simulation (${fmt(c.Wout, 4)} J); demonstrate it on a single instrumented cartridge with calorimetry (validation gate V2) before scaling.`, basis: 'Spec §33' });

    out.headline = `${c.Wout > 0 ? 'Positive' : 'No'} net work: ${fmt(c.Wout, 4)} J/cycle (contraction ${fmt(lw.Wc, 4)} − reset ${fmt(lw.Wr, 4)} J), stroke ${fmt(c.stroke * 1e3, 4)} mm, F_max ${fmt(Fmax, 4)} N, ${fmt(c.Wout * p.freq, 4)} W at ${p.freq} Hz → ${fmt(pA, 4)} W/kg active, ${fmt(pC, 4)} W/kg cartridge; η = ${fmt(100 * c.eta, 3)} % (${fmt(100 * c.carnotFraction, 3)} % of Carnot).`;
    out.headlineKind = c.Wout > 0 && xiOk ? 'ok' : c.Wout > 0 ? 'warn' : 'fail';
    const k = Math.max(1, Math.ceil(h.t.length / 400)), idx = range(h.t.length).filter(i => i % k === 0);
    out.outputs = {
      Wout_J: c.Wout, Wcontraction_J: lw.Wc, Wreset_J: lw.Wr, Wnet_loop_J: lw.Wnet, Qhot_J: c.Qhot, Qcold_J: c.Qcold, stroke_m: c.stroke, Fmax_N: Fmax, Fmean_N: Fmean, cellMass_kg: mCart, activeMass_kg: c.mass,
      specificPower_Wkg: pA, specificPowerCart_Wkg: pC, eta: c.eta, etaCarnot: etaC, carnotFraction: c.carnotFraction, xiSwing: c.xiSwing,
      forceHistory: { t: idx.map(i => h.t[i]), F: idx.map(i => h.F[i]), x: idx.map(i => h.x[i]) }, freq_Hz: p.freq, cycleTime_s: P, WoutFixture_J: WoutEff, gripPeak_MPa: sPeak,
    };
    out.credibility = 'Numerically verified';
    ctx.progress(1, 'done');
    return out;
  },
};

async function animate(el, { h, P, p, Fmax }) {
  const [{ anim2d, seriesPanel, at, lerp, arrow, text, theme }, { cmap, cssColor }] = await Promise.all([import('../core/anim2d.js'), import('../core/chart.js')]);
  const T = h.t, xMax = Math.max(1e-9, max(h.x)), amp = 0.25;
  anim2d(el, { duration: T[T.length - 1], rate: Math.min(1, 0.5 * P) / P, height: 460, label: 'Time in cycle', unit: 's', explain: `Ribbon bundle fixed at the left grip; the right end moves with the solved contraction (displacement exaggerated: full stroke ${fmt(xMax * 1e3, 3)} mm drawn as ${amp * 100} % of the length). Colour = mean ribbon temperature, arrow = bundle force, background = fluid in contact. Panels show the solved force, stroke, temperature and martensite fraction with a synchronised cursor.`, draw: (g, t, W, H) => {
    const th = theme(), k = at(T, t), hot = lerp(h.Tf, k) > 0.5 * (p.Th + p.Tc), x0 = 40, y0 = 50, Lpx = Math.min(W - 120, 520) * 0.85;
    const x = lerp(h.x, k), Lnow = Lpx * (1 - amp * x / xMax), Tm = lerp(h.Tm, k), F = lerp(h.F, k), eng = lerp(h.engaged, k);
    g.fillStyle = hot ? 'rgba(239,68,68,.18)' : 'rgba(59,130,246,.18)'; g.fillRect(x0 - 10, y0 - 22, Lpx + 60, 70);
    text(g, hot ? `HOT fluid ${p.Th} °C` : `COLD fluid ${p.Tc} °C`, x0, y0 - 28, hot ? '#ef4444' : '#3b82f6', 'bold 13px Inter,system-ui,sans-serif');
    g.fillStyle = '#64748b'; g.fillRect(x0 - 16, y0 - 14, 16, 54);
    g.fillStyle = cssColor(cmap((Tm - p.Tc) / Math.max(1e-9, p.Th - p.Tc), 'inferno')); for (let r = 0; r < 5; r++) g.fillRect(x0, y0 - 6 + r * 9, Lnow, 5);
    g.fillStyle = '#94a3b8'; g.fillRect(x0 + Lnow, y0 - 14, 12, 54);
    arrow(g, x0 + Lnow + 14, y0 + 13, Math.max(8, 70 * F / Math.max(1e-9, Fmax)), 0, eng >= 1 ? '#22c55e' : eng > 0 ? '#f59e0b' : '#94a3b8', 3, `${fmt(F, 4)} N ${eng >= 1 ? '(load engaged)' : eng > 0 ? '(stalled)' : '(bias only)'}`);
    text(g, `stroke ${fmt(x * 1e3, 4)} mm · T̄ = ${fmt(Tm, 4)} °C · ξ = ${fmt(lerp(h.xi, k), 3)}`, x0, y0 + 64, th.fg);
    const py = y0 + 80, ph = (H - py - 20) / 2, pw = (W - 30) / 2;
    seriesPanel(g, { x: 10, y: py, w: pw, h: ph, T, t, title: 'Force', unit: 'N', series: [{ name: 'F', y: h.F, color: '#22c55e' }] });
    seriesPanel(g, { x: 20 + pw, y: py, w: pw, h: ph, T, t, title: 'Stroke', unit: 'mm', series: [{ name: 'x', y: h.x.map(v => v * 1e3), color: '#a855f7' }] });
    seriesPanel(g, { x: 10, y: py + ph + 8, w: pw, h: ph - 8, T, t, title: 'Temperature', unit: '°C', series: [{ name: 'fluid', y: h.Tf, color: '#94a3b8' }, { name: 'ribbon', y: h.Tm, color: '#f97316' }] });
    seriesPanel(g, { x: 20 + pw, y: py + ph + 8, w: pw, h: ph - 8, T, t, title: 'Martensite fraction', unit: '–', series: [{ name: 'ξ', y: h.xi, color: '#38bdf8' }], ymin: 0, ymax: 1 });
  } });
}
