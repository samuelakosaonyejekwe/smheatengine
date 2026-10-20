// Suite 17 — Optimisation, inverse design and uncertainty.
// Physics-separable surrogate strategy: the transient cell response depends on (t, σ_L, σ_H, f, duty, channel height) but
// NOT on the cell count or the regenerator effectiveness, which enter the whole-engine accounting analytically
// (engine.js). Gaussian-process surrogates are therefore trained on per-cell cycle quantities from a Latin-hypercube
// design of low-resolution engine evaluations, validated on independent hold-out runs, and recombined exactly with the
// engine accounting. NSGA-II then searches the surrogate (inside its trust region) for Pareto sets; selected designs are
// re-run with the full model. Global sensitivity (Sobol, tornado) uses the surrogate; uncertainty propagation of material
// and thermal parameters uses the physics model itself at the selected design.
import { fmt, linspace, range, clamp, mean, std, min, max, lhs, rng, scaleSample, histogram, metrics, percentile, normCdf, nelderMead } from '../core/num.js';
import { sobol, tornado, nsga2, gpFit, hypervolume2, propagate } from '../core/analysis.js';
import { anim2d, seriesPanel, text } from '../core/anim2d.js';

const LOG10 = Math.log10;
const pause = async (ctx) => { try { if (typeof requestAnimationFrame === 'function') await ctx.yield(); else await new Promise(r => setTimeout(r, 0)); } catch { /* advisory */ } };

export default {
  description: 'Searches the design space (ribbon thickness, reset and power-stroke stresses, frequency, duty, regenerator effectiveness, cell count, channel height) for the best trade-offs between net power, fraction of Carnot, active-mass specific power, fatigue life and cost, using a validated Gaussian-process surrogate of the transient engine model, NSGA-II Pareto fronts confirmed by the full model, Sobol sensitivity and Monte-Carlo propagation of material and thermal uncertainty — answering the decisive question: the greatest sustainable net work per kilogram when heating/cooling energy, cycle time and fatigue are all counted.',
  literature: 'multi-objective optimization surrogate model shape memory alloy heat engine design uncertainty quantification',
  econ: true, sustain: true,
  credibility: 'Analytical screening',
  equations: [
    'Engine accounting (exact, analytic in N and ε_regen): P_net = N·W·f·η_tr − P_bearing − N·p_pump − 2N·f·E_valve − P_control',
    'Q_hot = N·f·(Q_cell − ε_regen·Q_sensible), Q_sensible = Q_cell − m·L_h·Δξ − W;  η = P_net/Q_hot ≤ η_C',
    'Specific net power p = P_net/m_active, sustainable net work per cycle w = P_net/(m_active·f) [J/kg]',
    'Functional life N_f = N₀(ε₀/ε_tr)^a(σ₀/σ_H)^b; cost proxy C = m_SMA·c_SMA·k_fab + N·C_cell + C_regen(ε) + c_pump·P_pump',
    'Gaussian process: ŷ(x) = μ + k(x)ᵀ(K + σ_n²I)⁻¹(y − μ), squared-exponential kernel, marginal-likelihood length scales',
    'NSGA-II: non-dominated sorting, crowding distance, SBX crossover, polynomial mutation, constraint domination',
    'Sobol first-order S_i = V[E(Y|X_i)]/V(Y) and total S_Ti (Saltelli/Jansen estimators)',
    'Latin-hypercube Monte Carlo: P5/P50/P95 of P_net and P(P_net > 0)',
  ],
  methods: [
    'LHS training design of the six cell-level variables, evaluated with engine.engineModel at low resolution (n = 1, 100 steps/cycle, 3 cycles) after eng.preScreen rejection of infeasible points',
    'Surrogate inputs are physics features: thickness, σ_L, σ_H − σ_L, channel height and the logarithms of the heating and cooling completeness ratios z = t_phase/(τ·ln(ΔT/ΔT_approach)), which absorb frequency and duty',
    'Cell work and transformation strain: calibrated reduced-order mechanistic model (detwinning gate, partial recovery near A_s(σ_H), completeness ramps; 4 parameters fitted by Nelder–Mead) plus a GP on the discrepancy; heat input, Δξ and log pump power per cell: plain GPs',
    'Independent hold-out set (different LHS seed) for blind validation (R², RMSE) of the recombined net power',
    'Surrogate trust region: candidates whose predicted standard deviation of W exceeds a fraction of the training range are treated as infeasible',
    'Two NSGA-II studies: P_net vs η/η_C, and specific net power vs fatigue life; best sustainable design = maximum specific net power with P_net > 0 and life ≥ target',
    'Full-model confirmation of the selected designs at higher resolution (n = 2, 150 steps/cycle)',
    'Uncertainty: Latin-hypercube propagation through the physics model (latent heat, Clausius–Clapeyron slopes, transformation temperatures, recoverable strain, contact conductance, wall capacity, reservoir temperatures)',
  ],
  assumptions: [
    'Variable bounds reflect experimentally supported ranges for rolled NiTi-type ribbons and laminar microchannels; outside them the surrogate is not used (spec §28)',
    'Low-resolution training runs carry a discretisation and cycle-to-cycle scatter of a few per cent; the confirmation runs quantify it',
    'Cost proxy is a screening estimate (fabrication multiplier, per-cell hardware, regenerator and pump cost) — not a quotation; Suite 22 does the economics',
    'Fatigue uses the library functional-fatigue trend; Suite 16 refines the selected design with grip concentration and rainflow counting',
    'Material uncertainty bands are library ± values, not lot statistics',
  ],
  ibc: {
    initial: ['LHS design (seeded, reproducible); NSGA-II random initial population inside the bounds', 'Reference design = current project engine'],
    boundary: ['Variable bounds; feasibility from the physical pre-screen (transformation reachable, reset possible, σ_H > σ_L)', 'Surrogate trust region; fixed reservoirs T_h, T_c and alloy'],
  },
  cvv: {
    calibration: ['Surrogate trained only on physics-model runs (no measured data enters the surrogate)', 'Material parameter distributions from Suite 03 / Suite 19 calibration when available'],
    verification: ['Separable-accounting identity: recombined surrogate inputs reproduce engineModel exactly for a physics run', 'Hold-out R² and RMSE of the surrogate', 'Pareto designs confirmed by the full model', 'Front dominance: NSGA-II front hypervolume ≥ best of the training samples'],
    validation: ['Build and test the selected design and one Pareto neighbour (blind validation against the prediction made before testing)'],
  },
  formats: { import: ['CSV design-of-experiments results (variables + measured net power)'], export: ['Pareto front CSV', 'Sobol indices CSV', 'Uncertainty samples CSV'] },
  params: [
    { key: 'Th', label: 'Hot-source temperature (fixed)', unit: '°C', type: 'number', min: 20, max: 250, step: 1, default: 70, group: 'Fixed conditions', auto: (c) => { const o = c.upstream('s06'); return o?.ThSupply_C !== undefined ? { value: +o.ThSupply_C.toFixed(2), prov: 'coupled' } : { value: c.engine.Th, prov: 'calc' }; } },
    { key: 'Tc', label: 'Cold-sink temperature (fixed)', unit: '°C', type: 'number', min: -20, max: 80, step: 1, default: 15, group: 'Fixed conditions', auto: (c) => { const o = c.upstream('s07'); return o?.TcSupply_C !== undefined ? { value: +o.TcSupply_C.toFixed(2), prov: 'coupled' } : { value: c.engine.Tc, prov: 'calc' }; } },
    { key: 'lifeTarget', label: 'Minimum functional life', unit: 'cycles', type: 'number', min: 1e3, max: 1e9, step: 1e4, default: 1e6, group: 'Objectives & constraints', help: 'Designs below this life are not “sustainable”. Spec aspiration: up to 10⁸.' },
    { key: 'transEff', label: 'Transmission efficiency', type: 'number', min: 0.3, max: 1, step: 0.01, default: 0.9, group: 'Fixed conditions', auto: (c) => { const o = c.upstream('s11'); return o?.transEff ? { value: +o.transEff.toFixed(3), prov: 'coupled' } : { value: c.engine.transEff, prov: 'calc' }; } },
    { key: 'tMin', label: 'Ribbon thickness lower bound', unit: 'µm', type: 'number', min: 20, max: 200, step: 5, default: 50, group: 'Variable bounds', expert: true },
    { key: 'tMax', label: 'Ribbon thickness upper bound', unit: 'µm', type: 'number', min: 60, max: 600, step: 10, default: 250, group: 'Variable bounds', expert: true },
    { key: 'fMin', label: 'Frequency lower bound', unit: 'Hz', type: 'number', min: 0.05, max: 2, step: 0.05, default: 0.2, group: 'Variable bounds', expert: true },
    { key: 'fMax', label: 'Frequency upper bound', unit: 'Hz', type: 'number', min: 0.5, max: 20, step: 0.1, default: 3, group: 'Variable bounds', expert: true },
    { key: 'nMin', label: 'Cell count lower bound', type: 'number', min: 1, max: 50, step: 1, default: 6, group: 'Variable bounds', expert: true },
    { key: 'nMax', label: 'Cell count upper bound', type: 'number', min: 2, max: 400, step: 1, default: 48, group: 'Variable bounds', expert: true },
    { key: 'regenMax', label: 'Regenerator effectiveness upper bound', type: 'number', min: 0, max: 0.95, step: 0.01, default: 0.85, group: 'Variable bounds', expert: true },
    { key: 'nTrain', label: 'Surrogate training runs (LHS)', type: 'number', min: 12, max: 120, step: 1, default: 36, group: 'Numerics', expert: true },
    { key: 'nTest', label: 'Independent hold-out runs', type: 'number', min: 4, max: 60, step: 1, default: 12, group: 'Numerics', expert: true },
    { key: 'pop', label: 'NSGA-II population', type: 'number', min: 16, max: 200, step: 4, default: 40, group: 'Numerics', expert: true },
    { key: 'gens', label: 'NSGA-II generations', type: 'number', min: 5, max: 300, step: 5, default: 30, group: 'Numerics', expert: true },
    { key: 'sobolN', label: 'Sobol base sample size', type: 'number', min: 64, max: 4096, step: 64, default: 256, group: 'Numerics', expert: true },
    { key: 'nUQ', label: 'Uncertainty-propagation physics runs', type: 'number', min: 8, max: 400, step: 4, default: 20, group: 'Numerics', expert: true },
    { key: 'nConfirm', label: 'Full-model confirmations', type: 'number', min: 1, max: 12, step: 1, default: 5, group: 'Numerics', expert: true },
    { key: 'trust', label: 'Surrogate trust limit (σ_W / range of W)', type: 'number', min: 0.02, max: 1, step: 0.01, default: 0.15, group: 'Numerics', expert: true },
    { key: 'seed', label: 'Random seed', type: 'number', min: 1, max: 99999, step: 1, default: 17, group: 'Numerics', expert: true },
  ],
  presets: [
    { label: 'Quick screening (24 + 8 runs)', values: { nTrain: 24, nTest: 8, gens: 25, nUQ: 12 } },
    { label: 'Thorough (72 + 24 runs, slower)', values: { nTrain: 72, nTest: 24, gens: 80, pop: 60, nUQ: 60, sobolN: 512 } },
    { label: '10⁸-cycle durability target', values: { lifeTarget: 1e8 } },
    { label: 'Thin-foil, high-frequency envelope', values: { tMin: 30, tMax: 120, fMax: 8 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const { eng, sma } = ctx, base = eng.designWith(ctx.engine, { Th: p.Th, Tc: p.Tc, transEff: p.transEff }), mat = ctx.materials.get(base.alloy) || ctx.material('ribbon');
    const t0 = Date.now(), prog = (f, m) => { try { ctx.progress(f, m); } catch { /* headless */ } };
    // ---- design variables: [key, label, unit, lo, hi, display scale]
    // stress bounds from the physics: σ_L ≥ detwinning start σ_s; σ_H ≤ the stress at which A_s(σ_H) reaches the hot fluid (pre-screen fail limit)
    const su = mat.su || 1000, sLo = Math.max(5, mat.sigS ?? 40), sHmax = Math.min(0.4 * su, Math.max(sLo + 20, (base.Th - mat.As - 1) * mat.CA)), sHi = Math.max(sLo + 10, Math.min(1.5 * (mat.sigF ?? 100), sHmax - 10));
    const CELL = [['ribbonT', 'Ribbon thickness', 'µm', p.tMin * 1e-6, p.tMax * 1e-6, 1e6], ['sigmaL', 'Reset stress σ_L', 'MPa', sLo, sHi, 1], ['dSigma', 'Load stress σ_H − σ_L', 'MPa', 10, Math.max(20, sHmax - sLo), 1], ['freq', 'Frequency', 'Hz', p.fMin, p.fMax, 1], ['dutyHot', 'Hot-phase fraction', '–', 0.3, 0.7, 1], ['chH', 'Channel height', 'mm', 0.3e-3, 2e-3, 1e3]];
    const SYS = [['regenEff', 'Regenerator effectiveness', '–', 0, p.regenMax, 1], ['nCells', 'Cell count', '–', p.nMin, p.nMax, 1]];
    const DV = CELL.concat(SYS), kC = CELL.length, B = DV.map(v => [v[3], v[4]]);
    const toDesign = (x) => { const o = {}; DV.forEach((v, i) => { o[v[0]] = v[0] === 'nCells' ? Math.max(1, Math.round(x[i])) : x[i]; }); o.sigmaH = o.sigmaL + o.dSigma; delete o.dSigma; return eng.designWith(base, o); };
    const fromDesign = (d) => DV.map(v => v[0] === 'dSigma' ? d.sigmaH - d.sigmaL : d[v[0]]);
    // surrogate inputs: physics features of the cell variables. Frequency and duty enter through the heating and cooling
    // completeness ratios z = (phase time)/(time constant · ln of the temperature-approach ratio), which straighten the
    // sharp loss of work when the ribbon cannot reach A_f(σ_H) or M_f(σ_L) in the available phase time.
    const hEff = 1 / (1 / base.hHot + 1 / base.hContact);
    const feat = (x) => {
      const [t, sL, dS, f, duty, chH] = x, sH = sL + dS, tau = (mat.rho * mat.cp * t / 2 + base.wallCapacity) / hEff + mat.rho * mat.cp * (t / 2) ** 2 / (3 * (mat.k || 18));
      const AfH = mat.Af + sH / mat.CA, MfL = mat.Mf + sL / mat.CM, dT = Math.max(1, base.Th - base.Tc);
      const zh = (duty / f) / (tau * Math.log(dT / Math.max(0.5, base.Th - AfH))), zc = ((1 - duty) / f) / (tau * Math.log(dT / Math.max(0.5, MfL - base.Tc)));
      return { t, sL, dS, sH, zh, zc, u: [t / B[0][1], sL / B[1][1], dS / B[2][1], chH / B[5][1], Math.log(Math.max(1e-3, zh)), Math.log(Math.max(1e-3, zc))] };
    };
    const unit = (x) => feat(x).u;
    // reduced-order mechanistic estimate of the cell response (detwinning gate at σ_L, partial recovery when A_s(σ_H) nears
    // T_h, heating/cooling completeness); its parameters P = [z₀, Δz, scale, ΔT] are calibrated on the training runs and a
    // GP learns the remaining discrepancy (calibrated reduced-order model + GP discrepancy)
    const cosg = (v) => 0.5 * (1 - Math.cos(Math.PI * clamp(v, 0, 1)));
    const Vrib = (t) => base.ribbonsPerCell * base.ribbonW * t * base.ribbonL;
    const shape = (F, P) => { const [z0, dz, , dT] = P, s = (z) => clamp((z - z0) / Math.max(0.05, dz), 0, 1), AsH = mat.As + F.sH / mat.CA, AfH = mat.Af + F.sH / mat.CA; return mat.epsL * cosg((F.sL - (mat.sigS ?? 40)) / Math.max(1, (mat.sigF ?? 100) - (mat.sigS ?? 40))) * cosg((base.Th + dT - AsH) / Math.max(0.5, AfH - AsH)) * s(F.zh) * s(F.zc); };
    const MECH = { W: (F, P) => P[2] * F.dS * 1e6 * Vrib(F.t) * shape(F, P), eps: (F, P) => P[2] * shape(F, P) + (F.sH - F.sL) / (mat.EM * 1e3) };
    const feasible = (d) => { const ps = eng.preScreen(d, mat); return { fails: ps.filter(v => v.status === 'fail'), ok: !ps.some(v => v.status === 'fail') && d.sigmaH >= d.sigmaL + 10 }; };
    // ---- exact separable engine accounting from per-cell quantities g = {W, Q, dxi, pp, eps}
    const mCell = (d) => d.ribbonsPerCell * d.ribbonW * d.ribbonT * d.ribbonL * mat.rho;
    const assemble = (d, g) => {
      const N = d.nCells, f = d.freq, latent = mCell(d) * (mat.Lh || 0) * g.dxi, sens = Math.max(0, g.Q - latent - g.W);
      const QhotTot = N * f * (g.Q - d.regenEff * sens), Pgross = N * g.W * f, Pshaft = Pgross * d.transEff - d.bearingLoss;
      const Ppump = N * g.pp, Pvalves = 2 * N * f * d.valveEnergy, Paux = Ppump + Pvalves + d.controlPower, Pnet = Pshaft - Paux;
      const mActive = N * mCell(d), etaC = ctx.heat.carnot(d.Th, d.Tc), eta = QhotTot > 0 ? Pnet / QhotTot : 0;
      const life = sma.fatigueLife(mat, Math.max(1e-4, g.eps), d.sigmaH);
      const cost = mActive * (mat.cost || 500) * 4 + N * 60 + 150 * d.regenEff / Math.max(0.05, 1 - d.regenEff) + 0.8 * Ppump + 300;
      return { Pnet, Pgross, Paux, Ppump, QhotTot, eta, etaC, cf: etaC > 0 ? eta / etaC : 0, mActive, pActive: Pnet / mActive, wNet: Pnet / (mActive * f), life, cost, costPerW: Pnet > 0 ? cost / Pnet : Infinity };
    };
    const cellQuantities = (E, d) => ({ W: E.cell.Wout, Q: E.cell.Qhot, dxi: E.cell.xiSwing, pp: E.Ppump / E.N, eps: E.cell.stroke / d.ribbonL });
    const lowRes = { n: 1, stepsPerCycle: 100, cycles: 3 }, hiRes = { n: 2, stepsPerCycle: 150, cycles: 3 };
    // ---- baseline (current project design)
    prog(0.02, 'baseline'); const Ebase = eng.engineModel(base, { mat, ...lowRes }), gBase = cellQuantities(Ebase, base), Abase = assemble(base, gBase);
    // ---- training + hold-out sampling (LHS over the cell variables, system variables sampled too for validation)
    const sample = async (n, seed, f0, f1, tag) => {
      const U = lhs(n, DV.length, rng(seed)), rows = [];
      for (let i = 0; i < n; i++) {
        const x = scaleSample(U[i], B), d = toDesign(x), fz = feasible(d);
        if (!fz.ok) { rows.push({ x, d, feasible: false, cause: fz.fails.map(v => v.test).join('; ') || 'σ_H − σ_L < 10 MPa' }); continue; }
        const E = eng.engineModel(d, { mat, ...lowRes }); rows.push({ x, d, feasible: true, g: cellQuantities(E, d), E });
        if (i % 3 === 2) { prog(f0 + (f1 - f0) * (i + 1) / n, `${tag} ${i + 1}/${n}`); await pause(ctx); }
      }
      return rows;
    };
    const train = await sample(p.nTrain, p.seed, 0.04, 0.45, 'training run');
    const test = await sample(p.nTest, p.seed + 101, 0.45, 0.58, 'hold-out run');
    const TR = train.filter(r => r.feasible), TE = test.filter(r => r.feasible);
    if (TR.length < 6) {
      out.headline = 'Too few feasible training designs — the design space is mostly infeasible'; out.headlineKind = 'fail';
      out.kpis.push({ label: 'Feasible training designs', value: TR.length, unit: `of ${p.nTrain}`, explain: 'Training points that passed the physical pre-screen. At least 6 are needed to fit a surrogate.', status: 'bad' });
      out.verdicts.push({ test: 'Feasible design space', status: 'fail', detail: `Only ${TR.length} of ${p.nTrain} sampled designs passed the pre-screen (e.g. ${train.find(r => !r.feasible)?.cause || ''}).`, fix: 'Raise the hot-source temperature, lower the σ bounds or choose an alloy with lower A_f (Suite 03).' });
      out.outputs = { pareto: [], best: {}, sobol: {}, uncertainty: { Pnet: { p5: NaN, p50: NaN, p95: NaN } } };
      return out;
    }
    // ---- surrogates (per-cell quantities on the unit cube of the cell variables)
    prog(0.6, 'fitting surrogates'); await pause(ctx);
    const FT = TR.map(r => feat(r.x)), XU = FT.map(F => F.u), KEYS = ['W', 'Q', 'dxi', 'lpp', 'eps'];
    const val = (g, k) => k === 'lpp' ? LOG10(Math.max(1e-9, g.pp)) : g[k];
    const calib = {}, mechCal = {};
    for (const k of ['W', 'eps']) {
      const ys = TR.map(r => r.g[k]), sc = (max(ys) - min(ys)) || 1;
      calib[k] = nelderMead((P) => FT.reduce((s, F, i) => s + ((ys[i] - MECH[k](F, P)) / sc) ** 2, 0), [0.45, 1.2, 1, 0], { step: 0.3, maxIt: 500 }).x;
      mechCal[k] = (F) => MECH[k](F, calib[k]);
    }
    const mechR2 = metrics(FT.map(mechCal.W), TR.map(r => r.g.W)).r2;
    const GP = Object.fromEntries(KEYS.map(k => [k, gpFit(XU, TR.map((r, i) => val(r.g, k) - (mechCal[k] ? mechCal[k](FT[i]) : 0)), { noise: 5e-3 })]));
    const rangeW = (max(TR.map(r => r.g.W)) - min(TR.map(r => r.g.W))) || 1;
    const predictG = (x) => { const F = feat(x), u = F.u, w = GP.W.predict(u); return { g: { W: w.mean + mechCal.W(F), Q: GP.Q.predict(u).mean, dxi: clamp(GP.dxi.predict(u).mean, 0, 1), pp: 10 ** GP.lpp.predict(u).mean, eps: Math.max(1e-4, GP.eps.predict(u).mean + mechCal.eps(F)) }, sW: w.std }; };
    const surr = (x) => { const d = toDesign(x), pg = predictG(x); return { d, ...assemble(d, pg.g), sW: pg.sW }; };
    // ---- verification of the separable accounting and blind validation
    const idErr = Math.abs(assemble(base, gBase).Pnet - Ebase.Pnet) / Math.max(1e-9, Math.abs(Ebase.Pnet));
    const vPred = TE.map(r => surr(r.x)), vAct = TE.map(r => assemble(r.d, r.g));
    const mP = TE.length >= 3 ? metrics(vPred.map(v => v.Pnet), vAct.map(v => v.Pnet)) : null, mW = TE.length >= 3 ? metrics(TE.map(r => predictG(r.x).g.W), TE.map(r => r.g.W)) : null;
    const mQ = TE.length >= 3 ? metrics(TE.map(r => predictG(r.x).g.Q), TE.map(r => r.g.Q)) : null;
    // ---- NSGA-II on the surrogate
    const cons = (s, x) => { const fz = feasible(s.d); return [fz.ok ? 0 : 1 + fz.fails.length, s.sW / rangeW - p.trust]; };
    prog(0.64, 'NSGA-II: power vs efficiency'); await pause(ctx);
    const nsA = nsga2((x) => { const s = surr(x); return { f: [-s.Pnet, -s.cf], g: cons(s, x) }; }, B, { pop: p.pop, gens: p.gens, seed: p.seed });
    prog(0.7, 'NSGA-II: specific power vs life'); await pause(ctx);
    const nsB = nsga2((x) => { const s = surr(x); return { f: [-s.pActive, -LOG10(s.life)], g: cons(s, x).concat([-s.Pnet]) }; }, B, { pop: p.pop, gens: p.gens, seed: p.seed + 1 });
    const frontA = nsA.front.map(q => ({ x: q.x, s: surr(q.x) })).sort((a, b) => a.s.Pnet - b.s.Pnet);
    const frontB = nsB.front.map(q => ({ x: q.x, s: surr(q.x) })).sort((a, b) => a.s.pActive - b.s.pActive);
    // decisive question: max specific net power with P_net > 0 and life ≥ target
    const pool = frontB.concat(frontA).filter(q => q.s.Pnet > 0);
    const sus = pool.filter(q => q.s.life >= p.lifeTarget), bestCand = (sus.length ? sus : pool).reduce((a, b) => (!a || b.s.pActive > a.s.pActive) ? b : a, null);
    // ---- full-model confirmation
    prog(0.76, 'confirming designs with the full model'); await pause(ctx);
    const pickIdx = (arr, k) => arr.length ? [...new Set(linspace(0, arr.length - 1, Math.min(k, arr.length)).map(Math.round))].map(i => arr[i]) : [];
    const confirmSet = [];
    if (bestCand) confirmSet.push({ tag: 'Best sustainable', q: bestCand });
    for (const q of pickIdx(frontA, Math.max(0, Math.ceil((p.nConfirm - 1) / 2)))) confirmSet.push({ tag: 'Front A (P_net–η)', q });
    for (const q of pickIdx(frontB, Math.max(0, Math.floor((p.nConfirm - 1) / 2)))) confirmSet.push({ tag: 'Front B (p–life)', q });
    const confirmed = [];
    for (const c of confirmSet.slice(0, p.nConfirm)) { const d = toDesign(c.q.x), E = eng.engineModel(d, { mat, ...hiRes }), A = assemble(d, cellQuantities(E, d)); confirmed.push({ ...c, d, E, A }); await pause(ctx); }
    const bestC = confirmed.find(c => c.tag === 'Best sustainable');
    // ---- sensitivity (surrogate)
    prog(0.84, 'Sobol indices'); await pause(ctx);
    const fP = (x) => surr(x).Pnet, fL = (x) => LOG10(surr(x).life);
    const sob = sobol(fP, B, { N: p.sobolN }), sobL = sobol(fL, B, { N: Math.max(64, p.sobolN / 2) });
    const xRef = bestCand ? bestCand.x : fromDesign(base);
    const tor = tornado((o) => fP(DV.map(v => o[v[0]])), Object.fromEntries(DV.map((v, i) => [v[0], xRef[i]])), DV.map((v, i) => ({ key: v[0], label: v[1], lo: clamp(xRef[i] - 0.15 * (B[i][1] - B[i][0]), ...B[i]), hi: clamp(xRef[i] + 0.15 * (B[i][1] - B[i][0]), ...B[i]) })));
    // ---- uncertainty propagation through the physics model at the selected design
    prog(0.88, 'uncertainty propagation'); await pause(ctx);
    const dSel = bestC ? bestC.d : base, u = (mat.unc || 10) / 100;
    const dists = [{ type: 'normal', a: 1, b: u }, { type: 'normal', a: 1, b: u }, { type: 'normal', a: 0, b: 2 }, { type: 'normal', a: 1, b: 0.6 * u }, { type: 'lognormal', a: 1, b: 0.25 }, { type: 'normal', a: 1, b: 0.15 }, { type: 'normal', a: 0, b: 1 }, { type: 'normal', a: 0, b: 1 }];
    const UQN = ['Latent heat L_h', 'Clausius–Clapeyron slopes', 'Transformation temperatures (K shift)', 'Recoverable strain ε_L', 'Contact conductance', 'Wall heat capacity', 'Hot reservoir T (K)', 'Cold reservoir T (K)'];
    const uq = propagate((z) => {
      const m2 = { ...mat, Lh: mat.Lh * z[0], CA: mat.CA * z[1], CM: mat.CM * z[1], Ms: mat.Ms + z[2], Mf: mat.Mf + z[2], As: mat.As + z[2], Af: mat.Af + z[2], epsL: mat.epsL * z[3] };
      const d2 = eng.designWith(dSel, { hContact: dSel.hContact * z[4], wallCapacity: dSel.wallCapacity * z[5], Th: dSel.Th + z[6], Tc: dSel.Tc + z[7] });
      return eng.engineModel(d2, { mat: m2, ...lowRes }).Pnet;
    }, dists, { n: p.nUQ, seed: p.seed + 7 });
    const pPos = uq.Y.filter(y => y > 0).length / uq.Y.length, pPosN = normCdf(uq.mean / Math.max(1e-12, uq.std));
    const p5 = percentile(uq.Y, 0.05), p50 = percentile(uq.Y, 0.5), p95 = percentile(uq.Y, 0.95);
    // correlation-based importance of uncertain inputs
    const corr = UQN.map((_, j) => { const xs = uq.X.map(r => r[j]), mx = mean(xs), my = uq.mean, sx = std(xs) || 1, sy = std(uq.Y) || 1; return mean(xs.map((v, i) => (v - mx) * (uq.Y[i] - my))) / (sx * sy); });
    // hypervolume vs training samples (front A, minimisation with reference at the worst observed values)
    const trainA = TR.map(r => assemble(r.d, r.g)).map(a => [-a.Pnet, -a.cf]);
    const ref = [max(trainA.map(q => q[0]).concat(frontA.map(q => -q.s.Pnet))) + 1e-9, max(trainA.map(q => q[1]).concat(frontA.map(q => -q.s.cf))) + 1e-9];
    const hvFront = hypervolume2(frontA.map(q => [-q.s.Pnet, -q.s.cf]), ref), hvTrain = hypervolume2(trainA, ref);
    const elapsed = (Date.now() - t0) / 1000;

    // ---- KPIs
    const bA = bestC?.A, bS = bestCand?.s;
    const st = (ok, warn) => ok ? 'ok' : warn ? 'warn' : 'bad';
    out.kpis.push(
      { label: 'Best sustainable specific net power', value: bA ? bA.pActive : NaN, unit: 'W/kg', explain: `Highest net power per kg of active SMA among Pareto designs with P_net > 0 and functional life ≥ ${fmt(p.lifeTarget, 2)} cycles, confirmed with the full model (surrogate predicted ${bS ? fmt(bS.pActive, 4) : '—'}). Baseline design: ${fmt(Abase.pActive, 4)} W/kg.`, status: bA ? st(bA.pActive >= 36, bA.pActive > 0) : 'bad', prov: 'calc' },
      { label: 'Sustainable net work per kg per cycle', value: bA ? bA.wNet : NaN, unit: 'J/kg', explain: 'Net work per kilogram of active SMA per cycle after heating/cooling, pumping, valves, control and transmission losses: the decisive quantity of the specification.', prov: 'calc' },
      { label: 'Ratio to the 36 W/kg reference', value: bA ? bA.pActive / eng.REFERENCE_W_PER_KG : NaN, unit: '×', explain: 'Selected design’s active-mass net specific power relative to the published 36 W/kg reference (simulation only — not a demonstrated claim).', prov: 'calc' },
      { label: 'Net power of the selected design', value: bA ? bA.Pnet : NaN, unit: 'W', explain: `Whole-engine net power with ${bestC ? bestC.d.nCells : '—'} cells (full-model confirmation).`, status: bA ? st(bA.Pnet > 0, false) : 'bad', prov: 'calc' },
      { label: 'Selected design life', value: bA ? bA.life : NaN, unit: 'cycles', explain: 'Functional-fatigue life of the selected design at its transformation strain and power-stroke stress (library trend); refine in Suite 16.', status: bA ? st(bA.life >= p.lifeTarget, bA.life >= 0.1 * p.lifeTarget) : 'bad', prov: 'calc' },
      { label: 'Selected design η/η_Carnot', value: bA ? 100 * bA.cf : NaN, unit: '%', explain: 'Thermal efficiency of the selected design as a fraction of the Carnot limit (never above 100 %).', prov: 'calc' },
      { label: 'Surrogate hold-out R² (P_net)', value: mP ? mP.r2 : NaN, unit: '–', explain: `Blind validation of the recombined surrogate on ${TE.length} independent physics runs not used for training. Above ≈ 0.8 the surrogate ranks designs reliably.`, status: mP ? st(mP.r2 > 0.8, mP.r2 > 0.5) : 'warn', prov: 'calc' },
      { label: 'P(P_net > 0) under material/thermal uncertainty', value: 100 * pPos, unit: '%', explain: `Fraction of ${uq.Y.length} Latin-hypercube physics runs of the selected design with positive net power (normal approximation ${fmt(100 * pPosN, 3)} %).`, status: st(pPos > 0.95, pPos > 0.7), prov: 'calc' },
      { label: 'Net power P5 / P50 / P95', value: `${fmt(p5, 3)} / ${fmt(p50, 3)} / ${fmt(p95, 3)}`, unit: 'W', explain: 'Percentiles of the selected design’s net power when latent heat, transformation temperatures, slopes, recoverable strain, contact conductance, wall capacity and reservoir temperatures vary within their library uncertainty.', prov: 'calc' },
      { label: 'Pareto designs found', value: frontA.length + frontB.length, unit: '', explain: `Non-dominated, feasible designs on the two fronts (power–efficiency: ${frontA.length}, specific power–life: ${frontB.length}).`, prov: 'calc' },
      { label: 'Feasible training designs', value: TR.length, unit: `of ${p.nTrain}`, explain: 'LHS samples that passed the physical pre-screen and were evaluated by the physics model; the rest were rejected as infeasible before solving.', prov: 'calc' },
    );
    for (const k of out.kpis) if (typeof k.value === 'number' && !Number.isFinite(k.value)) { k.value = 'no positive-net design found'; k.unit = ''; k.status = 'bad'; }
    // ---- verdicts
    out.verdicts.push(
      { test: 'A sustainable design exists (P_net > 0 and life ≥ target)', status: sus.length && bA && bA.Pnet > 0 && bA.life >= p.lifeTarget ? 'pass' : pool.length ? 'warn' : 'fail', detail: sus.length ? `${sus.length} Pareto designs meet both; selected design confirmed at P_net ${bA ? fmt(bA.Pnet, 4) : '—'} W, life ${bA ? fmt(bA.life, 3) : '—'} cycles.` : pool.length ? `Positive net power is possible but no Pareto design reaches ${fmt(p.lifeTarget, 2)} cycles; the selected design maximises specific power regardless (life ${bA ? fmt(bA.life, 3) : '—'}).` : 'No design with positive net power was found within the bounds.', fix: sus.length ? undefined : 'Lower the life target only with evidence; otherwise reduce transformation strain (partial detwinning via lower σ_L), use a lower-fatigue alloy, or raise ΔT.' },
      { test: 'Surrogate validated on hold-out data', status: mP && mP.r2 > 0.8 ? 'pass' : mP && mP.r2 > 0.5 ? 'warn' : 'fail', detail: mP ? `R² = ${fmt(mP.r2, 3)}, RMSE = ${fmt(mP.rmse, 3)} W on ${TE.length} hold-out runs (W per cell R² ${fmt(mW.r2, 3)}, Q_hot R² ${fmt(mQ.r2, 3)}).` : 'Too few feasible hold-out points.', fix: 'Increase training runs (expert parameter) or narrow the variable bounds.' },
      { test: 'Surrogate optimum confirmed by the full model', status: bS && bA ? (Math.abs(bA.Pnet - bS.Pnet) <= Math.max(0.25 * Math.abs(bA.Pnet), 0.5) ? 'pass' : 'warn') : 'info', detail: bS && bA ? `Predicted ${fmt(bS.Pnet, 4)} W vs full model ${fmt(bA.Pnet, 4)} W (${fmt(100 * (bS.Pnet / Math.max(1e-9, bA.Pnet) - 1), 3)} %).` : 'No selected design.', fix: 'Add training points near the optimum (sequential infill) and re-run.' },
      { test: 'Carnot bound respected by all confirmed designs', status: confirmed.every(c => c.A.eta <= c.A.etaC) ? 'pass' : 'fail', detail: `max η/η_C = ${fmt(100 * max(confirmed.map(c => c.A.cf).concat([0])), 3)} %.`, fix: 'Numerical artefact: refine the time step of the confirmation run.' },
      { test: 'Robustness: P(P_net > 0) ≥ 95 %', status: pPos >= 0.95 ? 'pass' : pPos >= 0.7 ? 'warn' : 'fail', detail: `${fmt(100 * pPos, 3)} % of uncertain realisations deliver positive net power (P5 = ${fmt(p5, 3)} W).`, fix: 'Select a design further from the transformation-temperature margins (lower σ_H or higher T_h), or reduce material uncertainty by lot DSC/tensile calibration (Suite 03/19).' },
      { test: '100× aspiration (3600 W/kg active net)', status: bA && bA.pActive >= 3600 ? 'pass' : 'info', detail: bA ? `Best sustainable ${fmt(bA.pActive, 4)} W/kg = ${fmt(bA.pActive / 36, 3)}× reference within the explored bounds.` : 'No design.', fix: 'Higher frequency needs proportionally higher heat-transfer rates and pumping; widen bounds only with experimental support (thin foils, h > 10⁴ W/m²K).' },
    );
    // ---- checks
    out.checks.push(
      { name: 'Separable accounting reproduces engineModel (baseline)', value: idErr, target: '< 1e-9', pass: idErr < 1e-9 },
      { name: 'Surrogate hold-out R² (P_net)', value: mP ? mP.r2 : NaN, target: '> 0.8', pass: mP ? mP.r2 > 0.8 : undefined, detail: mP ? `RMSE ${fmt(mP.rmse, 3)} W, bias ${fmt(mP.bias, 3)} W` : 'insufficient hold-out points' },
      { name: 'NSGA-II front dominates the training set (hypervolume ratio)', value: hvTrain > 0 ? hvFront / hvTrain : NaN, target: '≥ 1', pass: hvTrain > 0 ? hvFront >= hvTrain * 0.999 : undefined, detail: 'Front A in (−P_net, −η/η_C) relative to the worst observed point.' },
      { name: 'All Pareto designs feasible', value: nsA.front.concat(nsB.front).filter(q => q.cv > 0).length, target: '0 violations', pass: nsA.front.concat(nsB.front).every(q => q.cv === 0) },
      { name: 'Confirmed designs respect η ≤ η_C', value: max(confirmed.map(c => c.A.cf).concat([0])), target: '≤ 1', pass: confirmed.every(c => c.A.cf <= 1) },
      { name: 'Run time', value: elapsed, target: '< 6 s (default settings)', pass: elapsed < 8, detail: `${TR.length + TE.length + confirmed.length + uq.Y.length + 1} physics evaluations` },
    );
    // ---- charts
    const allTrain = TR.map(r => assemble(r.d, r.g));
    out.charts.push({ type: 'scatter', title: 'Pareto front A: net power vs fraction of Carnot', wide: true, x: { label: 'Net power', unit: 'W' }, y: { label: 'η/η_Carnot', unit: '%' }, series: [
      { name: 'Training samples (physics)', x: allTrain.map(a => a.Pnet), y: allTrain.map(a => 100 * a.cf), color: '#64748b' },
      { name: 'Pareto front (surrogate)', x: frontA.map(q => q.s.Pnet), y: frontA.map(q => 100 * q.s.cf), mode: 'lines+markers' },
      { name: 'Confirmed (full model)', x: confirmed.map(c => c.A.Pnet), y: confirmed.map(c => 100 * c.A.cf), r: 6, color: '#facc15' },
      { name: 'Baseline design', x: [Abase.Pnet], y: [100 * Abase.cf], r: 7, color: '#ef4444' }],
      annotations: [{ type: 'vline', x: 0, label: 'net zero' }], explain: 'Each point is a design. The front is the best achievable efficiency for a given net power; moving right along it trades efficiency for power (more cells, higher frequency, more pumping). Yellow points are re-solved with the full model; grey are the training runs.' });
    out.charts.push({ type: 'scatter', title: 'Pareto front B: specific net power vs functional life', x: { label: 'Active-mass net specific power', unit: 'W/kg' }, y: { label: 'Functional life', unit: 'cycles', log: true }, series: [
      { name: 'Training samples', x: allTrain.map(a => a.pActive), y: allTrain.map(a => a.life), color: '#64748b' },
      { name: 'Pareto front (surrogate)', x: frontB.map(q => q.s.pActive), y: frontB.map(q => q.s.life), mode: 'lines+markers' },
      { name: 'Confirmed (full model)', x: confirmed.map(c => c.A.pActive), y: confirmed.map(c => c.A.life), r: 6, color: '#facc15' },
      { name: 'Baseline', x: [Abase.pActive], y: [Abase.life], r: 7, color: '#ef4444' }],
      annotations: [{ type: 'hline', y: p.lifeTarget, label: 'life target', color: '#22c55e' }, { type: 'vline', x: 36, label: '36 W/kg reference' }], explain: 'The decisive trade-off: more work per kilogram per second requires larger transformation strain, stress or frequency, which shortens fatigue life. Designs above the green line are sustainable; the rightmost of them answers the specification’s decisive question.' });
    if (mP) out.charts.push({ type: 'scatter', title: 'Blind validation: surrogate vs physics model (hold-out)', x: { label: 'Physics model P_net', unit: 'W' }, y: { label: 'Surrogate P_net', unit: 'W' }, series: [{ name: 'Hold-out designs', x: vAct.map(v => v.Pnet), y: vPred.map(v => v.Pnet) }, { name: 'y = x', x: [min(vAct.map(v => v.Pnet)), max(vAct.map(v => v.Pnet))], y: [min(vAct.map(v => v.Pnet)), max(vAct.map(v => v.Pnet))], mode: 'lines', dash: '5 4' }], explain: `Independent designs never seen in training. Points on the dashed line are predicted exactly; R² = ${fmt(mP.r2, 3)}. Scatter here bounds how far the Pareto fronts can be trusted before confirmation.` });
    out.charts.push({ type: 'bar', title: 'Sobol indices of net power (surrogate)', categories: DV.map(v => v[1]), series: [{ name: 'First-order S₁', values: sob.S1 }, { name: 'Total S_T', values: sob.ST }], explain: 'Share of the variance of net power across the design space explained by each variable alone (S₁) and including interactions (S_T). Variables with small S_T can be frozen; large S_T − S₁ indicates strong interactions.' });
    out.charts.push({ type: 'bar', title: 'Sobol indices of log life (surrogate)', categories: DV.map(v => v[1]), series: [{ name: 'S₁', values: sobL.S1 }, { name: 'S_T', values: sobL.ST }], explain: 'Which variables control fatigue life: stress and transformation strain (through σ_L detwinning and completeness of transformation).' });
    out.charts.push({ type: 'tornado', title: 'Tornado: net power around the selected design (±15 % of each range)', rows: tor.rows.map(r => ({ label: r.label, lo: r.lo, hi: r.hi })), base: tor.base, explain: 'Local one-at-a-time sensitivity of predicted net power. Blue = variable at the low side, orange = high side. Long bars are the levers that matter at this design; short bars are free to set for cost or life.' });
    const hU = histogram(uq.Y, Math.min(12, Math.max(5, Math.round(Math.sqrt(uq.Y.length)))));
    out.charts.push({ type: 'bar', title: 'Net power distribution under material and thermal uncertainty', categories: hU.centers.map(c => fmt(c, 3)), series: [{ name: 'Realisations', values: hU.counts }], explain: `Histogram of ${uq.Y.length} physics-model runs of the selected design (W). P5 = ${fmt(p5, 3)}, P50 = ${fmt(p50, 3)}, P95 = ${fmt(p95, 3)} W; P(P_net > 0) = ${fmt(100 * pPos, 3)} %.` });
    out.charts.push({ type: 'bar', title: 'Uncertainty importance (correlation with net power)', horizontal: true, categories: UQN, series: [{ name: 'Pearson r', values: corr }], explain: 'Correlation of each uncertain input with net power across the Monte-Carlo runs: the measurement that would most reduce the prediction uncertainty is the one with the largest |r|.' });
    // response-surface heatmap over the two most influential variables
    const order = range(DV.length).sort((a, b) => sob.ST[b] - sob.ST[a]), i1 = order[0], i2 = order[1], g1 = linspace(...B[i1], 25), g2 = linspace(...B[i2], 21);
    const Zs = g2.map(v2 => g1.map(v1 => { const x = xRef.slice(); x[i1] = v1; x[i2] = v2; const s = surr(x); return feasible(s.d).ok ? s.pActive : NaN; }));
    out.charts.push({ type: 'heatmap', title: `Specific net power over ${DV[i1][1]} × ${DV[i2][1]} (surrogate)`, x: { label: DV[i1][1], unit: DV[i1][2], values: g1.map(v => v * DV[i1][5]) }, y: { label: DV[i2][1], unit: DV[i2][2], values: g2.map(v => v * DV[i2][5]) }, z: Zs, cmap: 'turbo', isolines: 6, z_label: 'W/kg', overlay: [{ pts: [[xRef[i1] * DV[i1][5], xRef[i2] * DV[i2][5]], [xRef[i1] * DV[i1][5], xRef[i2] * DV[i2][5]]], stroke: '#fff', width: 6 }], explain: 'Surrogate response surface of active-mass net specific power over the two variables with the largest total Sobol index, others held at the selected design (white dot). Blank cells are infeasible by the physical pre-screen.' });
    out.charts.push({ type: 'line', title: 'NSGA-II progress (feasible non-dominated designs per generation)', x: { label: 'Generation' }, y: { label: 'Front size' }, series: [{ name: 'Front A', x: range(nsA.history.length).map(i => i + 1), y: nsA.history }, { name: 'Front B', x: range(nsB.history.length).map(i => i + 1), y: nsB.history }], explain: 'Number of feasible non-dominated designs in the population; a plateau at the population size indicates the front is fully populated and the search has converged in coverage.' });
    // ---- tables
    const dvCols = DV.map(v => `${v[1]} [${v[2]}]`), dvRow = (x) => DV.map((v, i) => v[0] === 'nCells' ? Math.round(x[i]) : x[i] * v[5]);
    out.tables.push({ title: 'Confirmed designs (full model) vs surrogate prediction', cols: ['Design', ...dvCols, 'P_net pred. [W]', 'P_net full [W]', 'p_active full [W/kg]', 'w_net [J/kg]', 'η/η_C [%]', 'Life [cycles]', 'Cost proxy [USD]', 'USD/W'], rows: confirmed.map(c => [c.tag, ...dvRow(c.q.x), c.q.s.Pnet, c.A.Pnet, c.A.pActive, c.A.wNet, 100 * c.A.cf, c.A.life, c.A.cost, Number.isFinite(c.A.costPerW) ? c.A.costPerW : '—']), explain: 'Selected designs re-solved with the full transient model (n = 2, 150 steps/cycle). The difference between prediction and full model is the surrogate plus resolution error.' });
    out.tables.push({ title: 'Pareto front A — net power vs efficiency (surrogate)', cols: [...dvCols, 'P_net [W]', 'η/η_C [%]', 'p_active [W/kg]', 'Life', 'Cost [USD]'], rows: frontA.slice(-15).map(q => [...dvRow(q.x), q.s.Pnet, 100 * q.s.cf, q.s.pActive, q.s.life, q.s.cost]), explain: 'Up to 15 highest-power non-dominated designs.' });
    out.tables.push({ title: 'Pareto front B — specific power vs life (surrogate)', cols: [...dvCols, 'p_active [W/kg]', 'Life', 'P_net [W]', 'η/η_C [%]', 'Cost [USD]'], rows: frontB.slice(-15).map(q => [...dvRow(q.x), q.s.pActive, q.s.life, q.s.Pnet, 100 * q.s.cf, q.s.cost]), explain: 'Up to 15 highest specific-power non-dominated designs.' });
    out.tables.push({ title: 'Blind validation table (hold-out physics runs)', cols: ['#', ...dvCols, 'P_net physics [W]', 'P_net surrogate [W]', 'Error [W]', 'W/cell physics [J]', 'W/cell surrogate [J]'], rows: TE.map((r, i) => [i + 1, ...dvRow(r.x), vAct[i].Pnet, vPred[i].Pnet, vPred[i].Pnet - vAct[i].Pnet, r.g.W, predictG(r.x).g.W]), explain: 'Independent designs (different LHS seed) evaluated by the physics model and predicted by the surrogate before comparison.' });
    out.tables.push({ title: 'Sensitivity indices', cols: ['Variable', 'Range', 'S₁ P_net', 'S_T P_net', 'S₁ log life', 'S_T log life'], rows: DV.map((v, i) => [v[1], `${fmt(v[3] * v[5], 3)}–${fmt(v[4] * v[5], 3)} ${v[2]}`, sob.S1[i], sob.ST[i], sobL.S1[i], sobL.ST[i]]), explain: `Saltelli/Jansen estimators on ${sob.evaluations} surrogate evaluations.` });
    if (bA) out.tables.push({ title: 'Decisive question — sustainable net work per kilogram (selected design, full model)', cols: ['Quantity', 'Value', 'Accounting'], rows: [
      ['Net power P_net', `${fmt(bA.Pnet, 4)} W`, 'shaft power − pumps − valves − control − bearing'],
      ['Active SMA mass', `${fmt(bA.mActive * 1000, 4)} g`, `${bestC.d.nCells} cells × ${bestC.d.ribbonsPerCell} ribbons`],
      ['Specific net power', `${fmt(bA.pActive, 4)} W/kg`, `${fmt(bA.pActive / 36, 3)}× the 36 W/kg reference`],
      ['Net work per kg per cycle', `${fmt(bA.wNet, 4)} J/kg`, `at f = ${fmt(bestC.d.freq, 3)} Hz (cycle time ${fmt(1 / bestC.d.freq, 3)} s)`],
      ['Heat drawn per watt of net power', `${fmt(bA.QhotTot / Math.max(1e-9, bA.Pnet), 4)} W/W`, `regenerator ε = ${fmt(bestC.d.regenEff, 3)}`],
      ['Efficiency', `${fmt(100 * bA.eta, 3)} % (${fmt(100 * bA.cf, 3)} % of Carnot)`, `η_C = ${fmt(100 * bA.etaC, 3)} %`],
      ['Functional life', `${fmt(bA.life, 3)} cycles (${fmt(bA.life / bestC.d.freq / 3600, 3)} h)`, `target ${fmt(p.lifeTarget, 2)} cycles`],
      ['P(P_net > 0) under uncertainty', `${fmt(100 * pPos, 3)} %`, `P5/P50/P95 = ${fmt(p5, 3)}/${fmt(p50, 3)}/${fmt(p95, 3)} W`],
    ], explain: 'All energy flows counted: heating and cooling of ribbon and wall (minus regenerator credit), cycle time through frequency, pumping and switching auxiliaries, and fatigue through the life constraint.' });
    // ---- narrative
    out.explain.push(
      { title: 'Strategy', text: `The reduced-order mechanistic work model alone explains R² = ${fmt(mechR2, 3)} of the training variance; the GP discrepancy term captures the rest. ${TR.length} feasible LHS designs (of ${p.nTrain}) were solved with the transient engine model; ${p.nTrain - TR.length} were rejected by the physical pre-screen before solving. Because the cell response does not depend on cell count or regenerator effectiveness, only six variables are learned by the Gaussian processes; the rest of the accounting is exact. Hold-out R² for net power is ${mP ? fmt(mP.r2, 3) : '—'}.` },
      { title: 'Answer to the decisive question', text: bA ? `Within the explored bounds, the greatest sustainable net output is ${fmt(bA.pActive, 4)} W/kg of active SMA (${fmt(bA.wNet, 4)} J/kg per cycle at ${fmt(bestC.d.freq, 3)} Hz), i.e. ${fmt(bA.pActive / 36, 3)}× the 36 W/kg reference, with life ${fmt(bA.life, 3)} cycles and ${fmt(100 * bA.cf, 3)} % of Carnot. It is a simulation result with library material data — not evidence of performance.` : 'No design with positive net power was found within the bounds.' },
      { title: 'What drives the result', text: `Net power is most sensitive to ${DV[order[0]][1]} and ${DV[order[1]][1]} (total Sobol ${fmt(sob.ST[order[0]], 2)} and ${fmt(sob.ST[order[1]], 2)}). Under material and thermal uncertainty the selected design keeps positive net power in ${fmt(100 * pPos, 3)} % of realisations; the most influential uncertain input is ${UQN[range(UQN.length).sort((a, b) => Math.abs(corr[b]) - Math.abs(corr[a]))[0]]}.` },
    );
    // ---- recommendations
    if (bA) out.recs.push({ level: bA.Pnet > 0 && bA.life >= p.lifeTarget ? 'good' : 'warn', text: `Carry the selected design to Suites 14 and 16 for coupled and fatigue verification: ${DV.map((v, i) => `${v[1]} ${fmt(dvRow(bestCand.x)[i], 3)} ${v[2]}`).join(', ')}.`, basis: 'Best sustainable Pareto design, full-model confirmed' });
    const topU = UQN[range(UQN.length).sort((a, b) => Math.abs(corr[b]) - Math.abs(corr[a]))[0]];
    out.recs.push({ level: 'info', text: `Measure ${topU.toLowerCase()} first: it correlates most strongly (r = ${fmt(corr[UQN.indexOf(topU)], 2)}) with net-power uncertainty at the selected design.`, basis: 'Monte-Carlo uncertainty importance' });
    if (mP && mP.r2 < 0.8) out.recs.push({ level: 'warn', text: `Surrogate hold-out R² is only ${fmt(mP.r2, 3)}; increase training runs or narrow bounds before trusting the fronts in detail.`, basis: 'Blind validation' });
    if (bA) out.recs.push({ level: 'econ', text: `Cost proxy of the selected design ≈ ${fmt(bA.cost, 4)} USD (${Number.isFinite(bA.costPerW) ? fmt(bA.costPerW, 3) + ' USD per net W' : 'no positive net power'}); SMA material is ${fmt(100 * bA.mActive * (mat.cost || 500) * 4 / bA.cost, 3)} % of it. Use Suite 22 for levelised cost and payback.`, basis: 'Screening cost proxy' });
    if (bA) out.recs.push({ level: 'sustain', text: `The selected design draws ${fmt(bA.QhotTot / Math.max(1e-9, bA.Pnet), 4)} W of heat per net watt; using waste heat (Suite 06) rather than purpose-generated heat is essential for a favourable footprint, and higher regenerator effectiveness (${fmt(bestC.d.regenEff, 3)} now) reduces it directly.`, basis: 'Selected design heat demand' });
    out.recs.push({ level: 'info', text: 'Validate blind: build the selected design and one Pareto neighbour, record the prediction before testing, and import the measured net power here and in Suite 19.', basis: 'Master spec Module 17 — blind validation' });
    // ---- view: best design cell history
    if (bestC?.E?.cell?.hist) { const Hh = bestC.E.cell.hist, Hb = Ebase.cell.hist; out.views.push({ label: '2D animation: selected vs baseline cell cycle', icon: '🎞', render: (el) => anim2d(el, { duration: 1, label: 'cycle fraction', unit: '', height: 380, explain: 'Selected design (left/top panels) and baseline design on a normalised cycle time: ribbon temperature, martensite fraction and mechanical power to the load.', draw(g, t, W, H) {
      const nT = (T) => T.map(v => v / T[T.length - 1]); const tA = nT(Hh.t), tB = nT(Hb.t), ph = (H - 20) / 3;
      seriesPanel(g, { x: 8, y: 6, w: W - 16, h: ph - 6, T: tA, t, title: 'Ribbon mean temperature — selected / baseline', unit: '°C', series: [{ name: 'selected', y: Hh.Tm, color: '#22c55e' }] });
      seriesPanel(g, { x: 8, y: 6 + ph, w: W - 16, h: ph - 6, T: tB, t, title: 'Baseline ribbon temperature', unit: '°C', series: [{ name: 'baseline', y: Hb.Tm, color: '#94a3b8' }] });
      seriesPanel(g, { x: 8, y: 6 + 2 * ph, w: W - 16, h: ph - 6, T: tA, t, title: 'Selected design: ξ and power to load', unit: '', series: [{ name: 'ξ', y: Hh.xi, color: '#38bdf8' }, { name: 'P_mech / max', y: Hh.Pmech.map(v => v / (max(Hh.Pmech) || 1)), color: '#f97316' }] });
      text(g, `selected ${fmt(bestC.d.freq, 3)} Hz, t = ${fmt(bestC.d.ribbonT * 1e6, 3)} µm  ·  baseline ${fmt(base.freq, 3)} Hz, t = ${fmt(base.ribbonT * 1e6, 3)} µm`, 14, H - 4);
    } }) }); }
    const paretoOut = frontA.map(q => ({ front: 'power-efficiency', ...Object.fromEntries(DV.map((v, i) => [v[0], v[0] === 'nCells' ? Math.round(q.x[i]) : q.x[i]])), sigmaH: q.s.d.sigmaH, Pnet: q.s.Pnet, carnotFraction: q.s.cf, pActive: q.s.pActive, life: q.s.life, cost: q.s.cost }))
      .concat(frontB.map(q => ({ front: 'specific power-life', ...Object.fromEntries(DV.map((v, i) => [v[0], v[0] === 'nCells' ? Math.round(q.x[i]) : q.x[i]])), sigmaH: q.s.d.sigmaH, Pnet: q.s.Pnet, carnotFraction: q.s.cf, pActive: q.s.pActive, life: q.s.life, cost: q.s.cost })));
    out.outputs = {
      pareto: paretoOut,
      best: bestC ? { ...Object.fromEntries(DV.map(v => [v[0], v[0] === 'dSigma' ? bestC.d.sigmaH - bestC.d.sigmaL : bestC.d[v[0]]])), sigmaH: bestC.d.sigmaH, Pnet: bA.Pnet, pActive: bA.pActive, wNet_Jkg: bA.wNet, carnotFraction: bA.cf, eta: bA.eta, life: bA.life, cost: bA.cost, meetsLife: bA.life >= p.lifeTarget } : {},
      sobol: { vars: DV.map(v => v[0]), S1: sob.S1, ST: sob.ST, S1life: sobL.S1, STlife: sobL.ST },
      uncertainty: { Pnet: { p5, p50, p95 }, pPositive: pPos, mean: uq.mean, std: uq.std },
      surrogateR2: mP ? mP.r2 : null,
    };
    out.headline = bA ? `Best sustainable design: ${fmt(bA.pActive, 4)} W/kg active (${fmt(bA.pActive / 36, 3)}× reference), P_net ${fmt(bA.Pnet, 4)} W, life ${fmt(bA.life, 3)} cycles, P(P_net>0) ${fmt(100 * pPos, 3)} %` : 'No positive-net design found within the bounds';
    out.headlineKind = bA && bA.Pnet > 0 && bA.life >= p.lifeTarget ? 'ok' : bA && bA.Pnet > 0 ? 'warn' : 'fail';
    out.credibility = 'Analytical screening';
    prog(1, 'done');
    return out;
  },
};
