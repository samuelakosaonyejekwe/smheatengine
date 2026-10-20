// Suite 14 — Integrated thermal-fluid-structural co-simulation.
// Partitioned (staggered Gauss–Seidel) coupling of three solvers that exchange interface quantities every iteration:
//   fluid/channel solver  : cell heat demand → stream flow → duct heat-transfer coefficient (heat.ductHTC via engine.hydraulics)
//   SMA cell solver       : interface HTC, load stress and cycle period → transient thermomechanical cell (sma.cellTransient,
//                           internally monolithic: conduction, latent heat, kinetics and force balance solved every time step)
//   transmission / shaft  : cell work and engaged stroke → shaft power balance with the load characteristic → speed, load torque
//                           → ribbon load stress through the effective lever arm
// Relaxation: Aitken dynamic (vector form) or constant under-relaxation. Convergence is declared on the interface energy,
// force and displacement residuals together (master spec §26), not on the subsystem states alone.
import { fmt, linspace, range, clamp, gci, mean, max, min } from '../core/num.js';
import { anim2d, seriesPanel, text, theme, at, lerp } from '../core/anim2d.js';

const TWO_PI = 2 * Math.PI;
// cooperative yield to the UI; falls back to a macrotask where no animation frame exists (headless runs)
const pause = async (ctx) => { try { if (typeof requestAnimationFrame === 'function') await ctx.yield(); else await new Promise(r => setTimeout(r, 0)); } catch { /* yield is advisory */ } };
const IFACE = [['hH', 'Hot-side HTC h_hot'], ['hC', 'Cold-side HTC h_cold'], ['sL', 'Ribbon load stress σ_load'], ['f', 'Cycle frequency f']];

export default {
  description: 'Closes the loop between the channel flow, the transient SMA cell and the shaft load: heat demand sets the coolant flow and heat-transfer coefficient, the shaft load sets the ribbon stress, the cell work sets the shaft speed — iterated with Aitken or constant relaxation until the interface energy, force and displacement residuals converge. Compares one-pass (loose) coupling with the converged solution and the Suite 01 reference model, and verifies conservation and time-step/cycle-count convergence.',
  literature: 'partitioned fluid structure thermal coupling Aitken relaxation shape memory alloy heat engine co-simulation',
  credibility: 'Numerically verified',
  equations: [
    'Fluid interface: ṁ_hot = N·f·Q_hot,cell/(c_p·ΔT_fluid), h_hot = Nu(Re, Pr, Gz)·k/D_h · min(2, A_wet/A_face) (rectangular duct, developing laminar / Gnielinski)',
    'Cell (monolithic per step): ρc_p ∂T/∂t = ∂/∂x(k ∂T/∂x) + ρL_h ∂ξ/∂t + σ ∂ε/∂t; Σσ_i A_i = A·σ_ext(ε) with one-way clutch',
    'Shaft balance (quasi-steady per cycle): N·W_out·f·η_tr = τ_load(ω)·ω + τ_bearing·ω,  ω = 2π f / n_cpr',
    'Load characteristic τ_load(ω) = τ_d·(ω/ω_d)^k  (k = 0 constant torque, 1 generator/viscous, 2 fan/pump)',
    'Force interface: σ_load = τ_load(ω)/(n_eng·A·R_eff·η_tr), n_eng = N·(engaged fraction of the cycle)',
    'Aitken relaxation: ω_k = −ω_{k−1}·r_{k−1}·(r_k − r_{k−1})/‖r_k − r_{k−1}‖²,  x_{k+1} = x_k + ω_k r_k',
    'Residuals: energy |Q_cell^k − Q_fluid^{k−1}|/Q, force |σ_applied − σ_demanded|/σ, displacement |Δx_e^k − Δx_e^{k−1}|/Δx_e, shaft |P_cell − P_load|/P_load',
    'Cycle first law (per cell): Q_hot − Q_cold − W_out − W_bias − ΔU = residual;  ∮σ dε·V = W_out + W_bias (consistent right-point rule)',
    'Grid convergence index (Roache/Celik): GCI = F_s·|f₂ − f₁|/f₁/(r^p − 1)',
  ],
  methods: [
    'Staggered Gauss–Seidel partitioned iteration: fluid → cell → transmission/shaft, interface vector x = (h_hot, h_cold, σ_load, f) normalised by its one-pass value',
    'Aitken Δ² dynamic relaxation (vector form, factor clamped to 0.05–1) or constant under-relaxation; optional side-by-side scheme comparison',
    'Bracketed bisection for the shaft operating speed on the stable (falling) branch of the power balance',
    'Coupling iterations run at the coupling resolution; the converged interface state is then re-solved at the fine resolution for the reported histories',
    'Time-step refinement study (three levels, ratio 2) with Roache GCI on the cycle work; cycle-count study from a long run (periodic steady state)',
    'Loose (one pass, design interface values), converged partitioned and Suite 01 reference (hydraulic fixed point only, design load) compared with the same engine accounting',
  ],
  assumptions: [
    'Quasi-steady interfaces per cycle: HTC, load stress and frequency are cycle-averaged exchange quantities; intra-cycle shaft speed ripple belongs to Suites 11/12',
    'Shaft power balance holds on average over a cycle; flywheel and inertia redistribute but do not create energy',
    'Bias (reset) stress σ_L is held by the bias element and is not altered by the shaft load',
    'The effective lever arm R_eff is fixed by the transmission geometry; when no upstream value exists it is sized so that the design load stress (σ_H − σ_L) is reached at the design point',
    'Fluid-side temperature rise per pass is held at the design value; flow follows the heat demand',
    'One representative cell is solved; cell-to-cell maldistribution is taken from Suite 13 when present',
  ],
  ibc: {
    initial: ['Cell starts cold (T = T_c), fully martensitic and detwinned at σ_L; cyclic steady state reached by repeated cycles', 'Interface vector starts from the design values (or coupled upstream values) — this is the loose/one-pass solution'],
    boundary: ['Hot/cold fluid inlet temperatures with switching ramp t_switch; heat flux at the wall follows from h·(T_f − T_w) (no flux and temperature prescribed together)', 'Load torque characteristic at the shaft; bias stress at the ribbon; one-way clutch kinematics'],
  },
  cvv: {
    calibration: ['Measured heating/cooling transients of a single cell (h_hot, h_cold, contact conductance)', 'Dynamometer load line τ(ω) of the actual brake or generator'],
    verification: ['Interface flux matching between the fluid and cell solvers', 'Cycle energy closure of the cell solver (first law) and ∮σdε = W_out + W_bias', 'Time-step GCI and cycle-count periodicity', 'Coupling converges to the same state with Aitken and constant relaxation'],
    validation: ['Instrumented multicell rig: synchronised fluid temperatures, force, stroke and shaft torque against common timestamps (validation gate V3)'],
  },
  formats: { import: ['CSV time histories (t, T, F, x, torque) for overlay'], export: ['Synchronised histories CSV', 'Residual history CSV', 'Charts PNG/SVG'] },
  params: [
    { key: 'scheme', label: 'Coupling relaxation scheme', type: 'select', options: [{ value: 'aitken', label: 'Aitken dynamic relaxation' }, { value: 'constant', label: 'Constant under-relaxation' }], default: 'aitken', group: 'Coupling', help: 'Aitken adapts the relaxation factor from the last two residuals; constant relaxation uses ω₀ throughout.' },
    { key: 'omega0', label: 'Initial / constant relaxation factor ω₀', type: 'number', min: 0.05, max: 1, step: 0.05, default: 0.5, group: 'Coupling', expert: true },
    { key: 'tol', label: 'Interface convergence tolerance', type: 'number', min: 1e-5, max: 0.05, step: 1e-4, default: 3e-3, group: 'Coupling', expert: true, help: 'All interface residuals (energy, force, displacement, shaft power) and the relative interface update must fall below this value.' },
    { key: 'maxIt', label: 'Maximum coupling iterations', type: 'number', min: 2, max: 40, step: 1, default: 12, group: 'Coupling', expert: true },
    { key: 'compare', label: 'Also run the other relaxation scheme for comparison', type: 'bool', default: true, group: 'Coupling', expert: true },
    { key: 'coupleFluid', label: 'Couple fluid ↔ cell (HTC from heat demand)', type: 'bool', default: true, group: 'Coupling' },
    { key: 'coupleShaft', label: 'Couple shaft ↔ cell (load stress and speed)', type: 'bool', default: true, group: 'Coupling' },
    { key: 'kLoad', label: 'Load characteristic exponent k (τ ∝ ω^k)', type: 'select', options: [{ value: 0, label: '0 — constant torque (brake)' }, { value: 1, label: '1 — generator / viscous' }, { value: 2, label: '2 — fan / pump' }], default: 1, group: 'Shaft load', help: 'With constant torque the shaft speed is not set by the load; the frequency is then held by the valve controller.' },
    { key: 'tauLoad', label: 'Design load torque τ_d (0 = match the one-pass design point)', unit: 'N·m', type: 'number', min: 0, max: 500, step: 0.05, default: 0, group: 'Shaft load', help: 'Torque at the shaft referred through this suite’s own effective lever arm. Suite 11 uses a different gear/rocker geometry, so its torque is not imported directly; its transmission efficiency is.' },
    { key: 'cpr', label: 'Cell cycles per shaft revolution', type: 'number', min: 0.1, max: 20, step: 0.1, default: 1, group: 'Shaft load', auto: (c) => ({ value: +(c.engine.freq / Math.max(1e-6, c.engine.rpm / 60)).toFixed(3), prov: 'calc' }) },
    { key: 'transEff', label: 'Transmission efficiency η_tr', type: 'number', min: 0.3, max: 1, step: 0.01, default: 0.9, group: 'Shaft load', auto: (c) => { const o = c.upstream('s11') || c.upstream('s10'); return o?.transEff ? { value: +o.transEff.toFixed(3), prov: 'coupled' } : { value: c.engine.transEff, prov: 'calc' }; } },
    { key: 'Th', label: 'Hot fluid temperature', unit: '°C', type: 'number', min: 20, max: 250, step: 1, default: 70, group: 'Operating point', auto: (c) => { const o = c.upstream('s06'); return o?.ThSupply_C !== undefined ? { value: +o.ThSupply_C.toFixed(2), prov: 'coupled' } : { value: c.engine.Th, prov: 'calc' }; } },
    { key: 'Tc', label: 'Cold fluid temperature', unit: '°C', type: 'number', min: -20, max: 80, step: 1, default: 15, group: 'Operating point', auto: (c) => { const o = c.upstream('s07'); return o?.TcSupply_C !== undefined ? { value: +o.TcSupply_C.toFixed(2), prov: 'coupled' } : { value: c.engine.Tc, prov: 'calc' }; } },
    { key: 'freq', label: 'Design cycle frequency', unit: 'Hz', type: 'number', min: 0.05, max: 20, step: 0.05, default: 1, group: 'Operating point', auto: (c) => ({ value: c.engine.freq, prov: 'calc' }) },
    { key: 'dutyHot', label: 'Hot-phase fraction', type: 'number', min: 0.1, max: 0.9, step: 0.01, default: 0.5, group: 'Operating point', auto: (c) => { const o = c.upstream('s12'); return o?.dutyHot ? { value: o.dutyHot, prov: 'coupled' } : { value: c.engine.dutyHot, prov: 'calc' }; } },
    { key: 'sigmaL', label: 'Bias (reset) stress σ_L', unit: 'MPa', type: 'number', min: 0, max: 400, step: 1, default: 70, group: 'Operating point', auto: (c) => ({ value: c.engine.sigmaL, prov: 'calc' }) },
    { key: 'sigmaH', label: 'Design power-stroke stress σ_H', unit: 'MPa', type: 'number', min: 1, max: 600, step: 1, default: 110, group: 'Operating point', auto: (c) => ({ value: c.engine.sigmaH, prov: 'calc' }) },
    { key: 'hHot0', label: 'Initial hot-side HTC', unit: 'W/m²K', type: 'number', min: 50, max: 1e5, step: 50, default: 4000, group: 'Operating point', auto: (c) => { const o = c.upstream('s08'); return o?.hHot_Wm2K ? { value: Math.round(o.hHot_Wm2K), prov: 'coupled' } : { value: c.engine.hHot, prov: 'calc' }; } },
    { key: 'hCold0', label: 'Initial cold-side HTC', unit: 'W/m²K', type: 'number', min: 50, max: 1e5, step: 50, default: 4000, group: 'Operating point', auto: (c) => { const o = c.upstream('s08'); return o?.hCold_Wm2K ? { value: Math.round(o.hCold_Wm2K), prov: 'coupled' } : { value: c.engine.hCold, prov: 'calc' }; } },
    { key: 'nC', label: 'Coupling resolution: half-thickness cells', type: 'number', min: 1, max: 8, step: 1, default: 2, group: 'Numerics', expert: true },
    { key: 'spcC', label: 'Coupling resolution: steps per cycle', type: 'number', min: 40, max: 800, step: 10, default: 120, group: 'Numerics', expert: true },
    { key: 'cycC', label: 'Coupling resolution: cycles (mean of cycles after the first)', type: 'number', min: 2, max: 10, step: 1, default: 4, group: 'Numerics', expert: true },
    { key: 'nF', label: 'Final solve: half-thickness cells', type: 'number', min: 1, max: 10, step: 1, default: 3, group: 'Numerics', expert: true },
    { key: 'spcF', label: 'Final solve: steps per cycle', type: 'number', min: 80, max: 1600, step: 20, default: 240, group: 'Numerics', expert: true },
    { key: 'cycF', label: 'Final solve: cycles', type: 'number', min: 2, max: 10, step: 1, default: 4, group: 'Numerics', expert: true },
    { key: 'studyCycles', label: 'Cycle-count study length', type: 'number', min: 4, max: 20, step: 1, default: 8, group: 'Numerics', expert: true },
  ],
  presets: [
    { label: 'Constant-torque brake (dynamometer test)', values: { kLoad: 0 } },
    { label: 'Generator load (default)', values: { kLoad: 1, scheme: 'aitken' } },
    { label: 'Fan / pump load', values: { kLoad: 2 } },
    { label: 'Robust slow coupling (constant ω = 0.3)', values: { scheme: 'constant', omega0: 0.3, maxIt: 30 } },
    { label: 'High-resolution verification', values: { nF: 5, spcF: 480, spcC: 200, nC: 3 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const { eng, sma } = ctx, mat = ctx.materials.get(ctx.engine.alloy) || ctx.material('ribbon');
    const d0 = eng.designWith(ctx.engine, { Th: p.Th, Tc: p.Tc, freq: p.freq, dutyHot: p.dutyHot, sigmaL: p.sigmaL, sigmaH: p.sigmaH, hHot: p.hHot0, hCold: p.hCold0, transEff: p.transEff });
    const N = d0.nCells, kL = +p.kLoad, cpr = Math.max(0.01, p.cpr), eta = clamp(p.transEff, 0.05, 1);
    // ---- feasibility pre-screen (spec §26): infeasible cases are reported, not silently solved
    const pre = eng.preScreen(d0, mat);
    for (const v of pre) out.verdicts.push({ test: 'Pre-screen: ' + v.test, status: v.status, detail: v.detail, fix: v.fix });
    if (pre.some(v => v.status === 'fail')) {
      out.headline = 'Infeasible operating point — coupled solve not attempted'; out.headlineKind = 'fail';
      out.kpis.push({ label: 'Pre-screen failures', value: pre.filter(v => v.status === 'fail').length, explain: 'Number of physical feasibility tests that failed before any expensive solve. Fix them (see verdicts) and rerun.', status: 'bad' });
      out.explain.push('The automatic pre-screen found that the cycle cannot close under these temperatures and stresses, so the coupled problem has no physical periodic solution. Each failed test lists the cause and the change that would make it feasible.');
      out.outputs = { converged: false, iterations: 0, Wout_J: 0, Qhot_J: 0, energyResidual: NaN, couplingResidual: NaN, hHot: p.hHot0, freq_Hz: p.freq };
      return out;
    }
    const A = d0.ribbonsPerCell * d0.ribbonW * d0.ribbonT, wet = d0.chPerCell * 2 * (d0.chW + d0.chH) * d0.ribbonL;
    const runCell = (x, n, spc, cycles) => sma.cellTransient({ mat, t: d0.ribbonT, w: d0.ribbonW, L: d0.ribbonL, nRib: d0.ribbonsPerCell, n, Th: d0.Th, Tc: d0.Tc, hHot: x.hH, hCold: x.hC, hc: d0.hContact, Cw: d0.wallCapacity, period: 1 / x.f, dutyHot: d0.dutyHot, tSwitch: d0.tSwitch, sBias0: d0.sigmaL, kBias: d0.kBias, sLoad: Math.max(0, x.sL), cycles, stepsPerCycle: spc });
    const engagedFrac = (c) => { const e = c.hist.engaged; let s = 0; for (const v of e) s += v === 1 ? 1 : 0; return s / Math.max(1, e.length); };
    // interface work/heat: mean over the cycles after warm-up (the discrete clutch and kinetics give a cycle-to-cycle scatter)
    const settled = (c) => c.cycles.slice(c.cycles.length > 2 ? 1 : 0);
    const Wavg = (c) => mean(settled(c).map(q => q.Wout)), Qavg = (c) => mean(settled(c).map(q => q.Qhot));
    const strokeEng = (c, sL) => sL > 0 ? Wavg(c) / (sL * 1e6 * A) : 0; // engaged (work-producing) stroke, m
    // fluid solver: heat demand → flow → HTC (same correlation path as the engine reference)
    const fluidSolve = (c, f) => { const hy = eng.hydraulics(d0, c, N, f), face = c.faceArea; return { hH: hy.hydH.h * Math.min(2, wet / face), hC: hy.hydC.h * Math.min(2, wet / face), QfluidHot: hy.mdotH * hy.fh.cp * d0.fluidDT / (N * f), hy }; };
    const ctxProgress = (f, m) => { try { ctx.progress(f, m); } catch { /* headless */ } };

    // ---- one-pass (loose) solve at the design interface values
    ctxProgress(0.03, 'one-pass solve');
    const x0 = { hH: p.hHot0, hC: p.hCold0, sL: Math.max(0, p.sigmaH - p.sigmaL), f: p.freq };
    const cLoose = runCell(x0, p.nC, p.spcC, p.cycC);
    const omegaD = TWO_PI * p.freq / cpr, eng0 = engagedFrac(cLoose), nEng = Math.max(1e-3, N * eng0);
    // solver reproducibility floor: standard error of the settled-cycle work (mechanical residuals cannot be resolved below it)
    const sw = settled(cLoose).map(q => q.Wout), noise = sw.length > 1 ? Math.sqrt(sw.reduce((s, v) => s + (v - mean(sw)) ** 2, 0) / (sw.length - 1)) / Math.max(1e-12, Math.abs(mean(sw))) / Math.sqrt(sw.length) : 0;
    const tolM = Math.max(p.tol, 2 * noise);
    const tauB = d0.bearingLoss / Math.max(1e-9, omegaD);
    const tauFromCell = Math.max(0, (N * Wavg(cLoose) * p.freq * eta - d0.bearingLoss) / omegaD);
    const tauD = p.tauLoad > 0 ? p.tauLoad : tauFromCell, tauProv = p.tauLoad > 0 ? 'coupled/user' : 'estimated (matched to the one-pass design point)';
    const Reff = x0.sL > 0 && eng0 > 0 ? tauD / (nEng * A * x0.sL * 1e6 * eta) : 0; // m (effective lever arm)
    const tauL = (w) => tauD * (w / omegaD) ** kL;
    // shaft: speed from the cycle-averaged power balance (stable branch), then load stress through the lever arm
    const shaftSolve = (c, x) => {
      const W = Wavg(c);
      let f = x.f;
      if (p.coupleShaft && kL > 0) {
        const g = (ff) => { const w = TWO_PI * ff / cpr; return N * W * ff * eta - tauB * w - tauL(w) * w; };
        const fLo = 0.02 * p.freq, fHi = 6 * p.freq, fs = linspace(fLo, fHi, 120), gs = fs.map(g);
        let iPk = 0; for (let i = 1; i < gs.length; i++) if (gs[i] > gs[iPk]) iPk = i;
        if (gs[iPk] <= 0) f = fLo; // power balance cannot be met: shaft stalls
        else { let a = fs[iPk], b = fHi; if (g(b) > 0) f = fHi; else { for (let k = 0; k < 60; k++) { const m = 0.5 * (a + b); if (g(m) > 0) a = m; else b = m; } f = 0.5 * (a + b); } }
      }
      const w = TWO_PI * f / cpr, sDem = p.coupleShaft && Reff > 0 ? tauL(w) / (nEng * A * Reff * eta) / 1e6 : x.sL;
      return { f, sL: sDem, omega: w, tau: tauL(w), Pload: tauL(w) * w, Pcell: N * W * f * eta - tauB * w };
    };
    // ---- partitioned iteration
    const norm0 = { hH: x0.hH, hC: x0.hC, sL: Math.max(1, x0.sL), f: x0.f };
    const toV = (x) => IFACE.map(([k]) => x[k] / norm0[k]), fromV = (v) => Object.fromEntries(IFACE.map(([k], i) => [k, v[i] * norm0[k]]));
    const bounds = { hH: [50, 2e5], hC: [50, 2e5], sL: [0, 6 * Math.max(10, x0.sL)], f: [0.02 * p.freq, 6 * p.freq] };
    const couple = async (scheme, budgetFrac) => {
      let x = { ...x0 }, c = cLoose, prevR = null, om = p.omega0, Qprev = Qavg(cLoose), xePrev = strokeEng(cLoose, x0.sL), converged = false, it = 0;
      const hist = [], states = [];
      for (it = 1; it <= p.maxIt; it++) {
        if (it > 1) c = runCell(x, p.nC, p.spcC, p.cycC);
        const fl = p.coupleFluid ? fluidSolve(c, x.f) : { hH: x.hH, hC: x.hC, QfluidHot: Qprev };
        const sh = shaftSolve(c, x);
        const xNew = { hH: fl.hH, hC: fl.hC, sL: sh.sL, f: sh.f };
        const r = toV(xNew).map((v, i) => v - toV(x)[i]);
        const xe = strokeEng(c, x.sL);
        const res = {
          it, energy: Math.abs(Qavg(c) - Qprev) / Math.max(1e-12, Math.abs(Qavg(c))),
          force: p.coupleShaft ? Math.abs(sh.sL - x.sL) / Math.max(1, Math.abs(sh.sL)) : 0,
          disp: xePrev > 0 ? Math.abs(xe - xePrev) / Math.max(1e-12, xePrev) : (xe > 0 ? 1 : 0),
          shaft: p.coupleShaft && kL > 0 ? Math.abs(sh.Pcell - sh.Pload) / Math.max(1e-9, Math.abs(sh.Pload)) : 0,
          updateH: Math.hypot(r[0], r[1]) / Math.SQRT2, updateM: Math.hypot(r[2], r[3]) / Math.SQRT2, omega: om,
        };
        res.update = Math.max(res.updateH, res.updateM);
        res.total = Math.max(res.energy, res.force, res.disp, res.update);
        res.norm = Math.max(res.energy / p.tol, res.updateH / p.tol, res.force / tolM, res.disp / tolM, res.updateM / tolM); // 1 = at tolerance
        hist.push(res); states.push({ ...x, Wout: Wavg(c), Qhot: Qavg(c), stroke: xe, tau: sh.tau, Pload: sh.Pload });
        Qprev = Qavg(c); xePrev = xe;
        if (res.norm < 1 && it > 1) { converged = true; break; }
        if (it === p.maxIt) break;
        if (scheme === 'aitken' && prevR) { const dr = r.map((v, i) => v - prevR[i]), den = dr.reduce((s, v) => s + v * v, 0); if (den > 1e-30) om = clamp(-om * prevR.reduce((s, v, i) => s + v * dr[i], 0) / den, 0.05, 1); }
        else if (scheme !== 'aitken') om = p.omega0;
        prevR = r;
        const v = toV(x).map((vi, i) => vi + om * r[i]); x = fromV(v);
        for (const [k] of IFACE) x[k] = clamp(x[k], ...bounds[k]);
        ctxProgress(budgetFrac[0] + (budgetFrac[1] - budgetFrac[0]) * it / p.maxIt, `${scheme} coupling iteration ${it}`); await pause(ctx);
      }
      return { x, c, hist, states, converged, iterations: Math.min(it, p.maxIt) };
    };
    const main = await couple(p.scheme, [0.05, 0.5]);
    const alt = p.compare ? await couple(p.scheme === 'aitken' ? 'constant' : 'aitken', [0.5, 0.7]) : null;
    const xs = main.x;
    // ---- fine solve at the converged interface state (reported histories)
    ctxProgress(0.72, 'fine-resolution solve of the converged state');
    const cF = runCell(xs, p.nF, p.spcF, p.cycF);
    const flF = fluidSolve(cF, xs.f), shF = shaftSolve(cF, xs);
    // ---- engine-level accounting: loose, converged, Suite 01 reference (same accounting path)
    const dLoose = eng.designWith(d0, { hHot: x0.hH, hCold: x0.hC, freq: x0.f, sigmaH: d0.sigmaL + x0.sL, rpm: 60 * x0.f / cpr });
    const dConv = eng.designWith(d0, { hHot: xs.hH, hCold: xs.hC, freq: xs.f, sigmaH: d0.sigmaL + xs.sL, rpm: 60 * xs.f / cpr });
    const cellAvg = (c) => ({ ...c, Wout: Wavg(c), Qhot: Qavg(c), Qcold: mean(settled(c).map(q => q.Qcold)) });
    const EL = eng.engineModel(dLoose, { mat, cell: cellAvg(cLoose) }), EC = eng.engineModel(dConv, { mat, cell: cellAvg(cF) });
    await pause(ctx); ctxProgress(0.78, 'reference model');
    const ER = eng.engineModel(eng.designWith(d0, { rpm: 60 * p.freq / cpr }), { mat, n: p.nC, stepsPerCycle: p.spcC, cycles: p.cycC });
    // ---- time-step convergence (GCI) and cycle-count study at the converged state
    ctxProgress(0.82, 'time-step refinement study');
    const levels = [Math.max(30, Math.round(p.spcC / 2)), p.spcC, 2 * p.spcC];
    const cLong = runCell(xs, p.nC, p.spcC, Math.max(p.studyCycles, p.cycC));
    const truncated = { ...cLong, cycles: cLong.cycles.slice(0, p.cycC), energyResidual: cLong.cycles[p.cycC - 1].residual / Math.max(1e-12, cLong.cycles[p.cycC - 1].Qhot) };
    const runsT = [runCell(xs, p.nC, levels[0], p.cycC), truncated, runCell(xs, p.nC, levels[2], p.cycC)];
    const Wl = runsT.map(Wavg), Ql = runsT.map(Qavg);
    const gW = gci(Wl[2], Wl[1], Wl[0], 1 / levels[2], 1 / levels[1], 1 / levels[0]);
    const gQ = gci(Ql[2], Ql[1], Ql[0], 1 / levels[2], 1 / levels[1], 1 / levels[0]);
    await pause(ctx); ctxProgress(0.9, 'cycle-count study');
    const cycW = cLong.cycles.map(c => c.Wout), cycQ = cLong.cycles.map(c => c.Qhot);
    const perio = cycW.slice(1).map((w, i) => Math.abs(w - cycW[i]) / Math.max(1e-12, Math.abs(w)));
    // ---- conservation report (fine solve)
    const H = cF.hist, V = cF.area * d0.ribbonL, Lc = cF.cycles[cF.cycles.length - 1];
    let loopW = 0; for (let i = 1; i < H.t.length; i++) loopW += -H.sExt[i] * 1e6 * (H.eps[i] - H.eps[i - 1]) * V;
    const loopClosure = Math.abs(loopW - (cF.Wout + cF.Wspring)) / Math.max(1e-12, Math.abs(cF.Wout));
    const trapGap = Math.abs((cF.Wcontraction - cF.Wreset) - (cF.Wout + cF.Wspring)) / Math.max(1e-12, Math.abs(cF.Wout));
    const dtF = (1 / xs.f) / p.spcF; let qInt = 0; for (const q of H.qIn) qInt += Math.abs(q) * dtF;
    const WF = Wavg(cF), QF = Qavg(cF), QfluidC = Qavg(main.c), fluxMatch = Math.abs(QfluidC - QF) / Math.max(1e-12, QF);
    const last = main.hist[main.hist.length - 1];
    const couplingResidual = last.total, normRes = last.norm, energyResidual = Math.abs(cF.energyResidual);
    const dLooseP = (EC.Pnet - EL.Pnet) / Math.max(1e-9, Math.abs(EC.Pnet));
    const etaOK = EC.eta <= EC.etaC + 1e-12;

    // ---- KPIs
    const st = (ok, warn) => ok ? 'ok' : warn ? 'warn' : 'bad';
    out.kpis.push(
      { label: 'Coupling converged', value: main.converged ? `yes (${main.iterations} it.)` : `no (${main.iterations} it.)`, explain: `Whether all interface residuals fell below their tolerances — energy and heat-transfer update ${p.tol}; force, displacement and load/speed update ${fmt(tolM, 3)} (the larger of the tolerance and twice the cell solver's cycle-to-cycle reproducibility ${fmt(noise, 3)}) — using ${p.scheme === 'aitken' ? 'Aitken dynamic' : 'constant'} relaxation.`, status: main.converged ? 'ok' : 'bad', prov: 'calc' },
      { label: 'Coupling residual', value: couplingResidual, unit: '–', explain: `Largest relative interface residual at the last iteration (energy, force, displacement or interface update); ${fmt(normRes, 3)} × its own tolerance. Below tolerance means the three solvers agree on what crosses their interfaces.`, status: st(normRes < 1, normRes < 10), prov: 'calc' },
      { label: 'Cell net work per cycle (coupled)', value: WF, unit: 'J', explain: 'Work delivered to the output load by one cell in one complete cycle at the converged state, after the reset stroke (closed-loop W = ∮F dx including reset sign).', prov: 'calc' },
      { label: 'Cell heat input per cycle', value: QF, unit: 'J', explain: 'Heat taken from the hot fluid by one cell during its hot phase (before regenerator credit). Most of it heats the ribbon and wall and is rejected again.', prov: 'calc' },
      { label: 'Converged cycle frequency', value: xs.f, unit: 'Hz', explain: kL > 0 && p.coupleShaft ? `Speed at which the shaft power balance closes with the k = ${kL} load line (design ${p.freq} Hz).` : 'Frequency held by the valve controller (constant-torque load does not set speed).', prov: 'calc' },
      { label: 'Converged hot-side HTC', value: xs.hH, unit: 'W/m²K', explain: 'Heat-transfer coefficient consistent with the flow needed to carry the cell heat demand at the design fluid temperature change (area-weighted to the ribbon face).', prov: 'calc' },
      { label: 'Converged ribbon load stress', value: xs.sL, unit: 'MPa', explain: `Stress the shaft load imposes on the ribbon while the clutch is engaged (design ${fmt(x0.sL, 3)} MPa). σ_H,eff = σ_L + σ_load = ${fmt(d0.sigmaL + xs.sL, 4)} MPa.`, prov: 'calc' },
      { label: 'Net engine power, coupled', value: EC.Pnet, unit: 'W', explain: 'Whole-engine net power with the converged interface state: N·W·f·η_tr − bearing − pumps − valves − control (Suite 01 accounting).', status: EC.Pnet > 0 ? 'ok' : 'bad', prov: 'calc' },
      { label: 'Loose-coupling error in P_net', value: 100 * dLooseP, unit: '%', explain: 'How far the one-pass (uncoupled) prediction is from the converged coupled one. Large values mean one-way data transfer between modules is not adequate for this design.', status: st(Math.abs(dLooseP) < 0.05, Math.abs(dLooseP) < 0.2), prov: 'calc' },
      { label: 'Cell energy residual', value: energyResidual, unit: '–', explain: 'First-law closure of the last cycle: (Q_hot − Q_cold − W_out − W_bias − ΔU)/Q_hot from the fine solve.', status: st(energyResidual < 1e-4, energyResidual < 1e-2), prov: 'calc' },
      { label: 'Time-step GCI on W_out', value: Number.isFinite(gW.gci21) ? 100 * gW.gci21 : NaN, unit: '%', explain: `Grid-convergence index of the cycle work over ${levels.join('/')} steps per cycle (observed order ${fmt(gW.p, 3)}). It bounds the discretisation uncertainty of the finest of the three runs.`, status: Number.isFinite(gW.gci21) ? st(gW.gci21 < 0.03, gW.gci21 < 0.1) : 'warn', prov: 'calc' },
    );
    if (!Number.isFinite(out.kpis[out.kpis.length - 1].value)) { out.kpis[out.kpis.length - 1].value = 'not defined (oscillatory/converged)'; out.kpis[out.kpis.length - 1].unit = ''; }

    // ---- verdicts
    out.verdicts.push(
      { test: 'Interface iteration converged (energy, force, displacement)', status: main.converged ? 'pass' : 'fail', detail: `${main.iterations} iterations, final residuals: energy ${fmt(last.energy, 3)}, force ${fmt(last.force, 3)}, displacement ${fmt(last.disp, 3)}, HTC update ${fmt(last.updateH, 3)}, load/speed update ${fmt(last.updateM, 3)} (tolerances ${p.tol} thermal, ${fmt(tolM, 3)} mechanical; cell reproducibility floor ${fmt(noise, 3)}).`, fix: main.converged ? undefined : 'Switch to constant relaxation with ω₀ ≈ 0.3, raise the iteration limit, or check for a stalled shaft (load torque larger than the cell can sustain).' },
      { test: 'Cell first-law closure', status: energyResidual < 1e-3 ? 'pass' : 'warn', detail: `Relative residual ${fmt(energyResidual, 3)} of Q_hot.`, fix: energyResidual < 1e-3 ? undefined : 'Increase steps per cycle or cycles to reach the periodic state.' },
      { test: 'Interface heat-flux matching (fluid ↔ cell)', status: fluxMatch < Math.max(p.tol, 1e-3) * 5 ? 'pass' : 'warn', detail: `Heat the coolant stream was sized for at the converged iterate ${fmt(QfluidC, 4)} J vs the fine-solve cell heat ${fmt(QF, 4)} J per cycle (mismatch ${fmt(100 * fluxMatch, 3)} %, resolution change only).`, fix: 'Refine the coupling resolution to match the final solve, or tighten the tolerance.' },
      { test: 'Carnot bound respected', status: etaOK ? 'pass' : 'fail', detail: `η = ${fmt(100 * EC.eta, 3)} % vs η_Carnot = ${fmt(100 * EC.etaC, 3)} %.`, fix: etaOK ? undefined : 'A numerical artefact: refine the time step and check the regenerator credit; never report this value.' },
      { test: 'Shaft operates (not stalled)', status: xs.f > 0.05 * p.freq && WF > 0 ? 'pass' : 'fail', detail: `Converged frequency ${fmt(xs.f, 3)} Hz, cell work ${fmt(WF, 3)} J.`, fix: 'Reduce the load torque (or lever arm), raise σ_H margin or improve heat transfer.' },
      { test: 'One-pass coupling adequate (|ΔP_net| < 5 %)', status: Math.abs(dLooseP) < 0.05 ? 'pass' : 'warn', detail: `Loose ${fmt(EL.Pnet, 4)} W vs converged ${fmt(EC.Pnet, 4)} W (${fmt(100 * dLooseP, 3)} %).`, fix: 'Use the converged co-simulation values downstream (published automatically) rather than one-pass estimates.' },
      { test: 'Mechanical work closure ∮σdε·V = W_out + W_bias', status: loopClosure < 1e-3 ? 'pass' : 'warn', detail: `Right-point loop integral ${fmt(loopW, 5)} J vs W_out + W_bias ${fmt(cF.Wout + cF.Wspring, 5)} J (relative ${fmt(loopClosure, 3)}). The trapezoidal contraction − reset split reported by the cell solver differs by ${fmt(100 * trapGap, 3)} % because it averages the stress across clutch switching steps.`, fix: loopClosure < 1e-3 ? undefined : 'Refine the time step near clutch engagement.' },
    );
    if (!main.converged && alt?.converged) out.verdicts.push({ test: 'Alternative relaxation scheme', status: 'info', detail: `The ${p.scheme === 'aitken' ? 'constant' : 'Aitken'} scheme converged in ${alt.iterations} iterations.`, fix: 'Select it as the coupling scheme.' });
    out.verdicts.push({ test: 'Measured synchronised histories', status: 'info', detail: (ctx.experiments || []).length ? `${ctx.experiments.length} dataset(s) imported — overlay them in the Experiment vs model tab.` : 'No measurements imported. Simulated histories only.', fix: 'Record fluid inlet/outlet temperatures, ribbon force, stroke and shaft torque on one time base (validation gate V3) and import them here.' });

    // ---- checks
    out.checks.push(
      { name: 'Coupling converged (all interface residuals < tol)', value: normRes, target: '< 1 (residual / tolerance)', pass: main.converged, detail: `Thermal tolerance ${p.tol}, mechanical ${fmt(tolM, 3)}.` },
      { name: 'Cell cycle energy residual |r|/Q_hot', value: energyResidual, target: '< 1e-3', pass: energyResidual < 1e-3 },
      { name: 'Loop work closure ∮σdε vs W_out + W_bias', value: loopClosure, target: '< 1e-3', pass: loopClosure < 1e-3 },
      { name: 'Interface flux matching (fine solve)', value: fluxMatch, target: '< 1 % (resolution change only)', pass: fluxMatch < 0.01 },
      { name: 'η ≤ η_Carnot', value: EC.eta, target: `≤ ${fmt(EC.etaC, 4)}`, pass: etaOK },
      { name: 'Periodicity of last cycle (long run)', value: perio[perio.length - 1], target: '< 5 %', pass: perio[perio.length - 1] < 0.05, detail: 'Cycle-to-cycle change of W_out at the end of the cycle-count study.' },
      { name: 'Phase fraction bounds 0 ≤ ξ ≤ 1', value: `${fmt(min(H.xi), 3)} … ${fmt(max(H.xi), 3)}`, target: '[0, 1]', pass: min(H.xi) >= -1e-9 && max(H.xi) <= 1 + 1e-9 },
      { name: 'Time-step GCI on W_out', value: gW.gci21, target: '< 5 %', pass: Number.isFinite(gW.gci21) ? gW.gci21 < 0.05 : undefined, detail: `p = ${fmt(gW.p, 3)}, asymptotic ratio ${fmt(gW.asymptoticRatio, 3)}${gW.oscillatory ? ' (oscillatory convergence: the clutch switching and cosine kinetics make W_out non-monotone in Δt — use the spread of the three levels as the uncertainty)' : ''}.` },
    );
    if (alt) { const dWs = Math.abs(Wavg(alt.c) - Wavg(main.c)) / Math.max(1e-12, Math.abs(Wavg(main.c))), lim = Math.max(0.02, 3 * noise); out.checks.push({ name: 'Both relaxation schemes reach the same state (W_out)', value: dWs, target: `< ${fmt(100 * lim, 2)} % (max of 2 % and 3× solver reproducibility)`, pass: !(main.converged && alt.converged) ? undefined : dWs < lim, detail: alt.converged && main.converged ? `${p.scheme === 'aitken' ? 'Constant' : 'Aitken'} scheme: ${alt.iterations} iterations.` : 'Not evaluated: one scheme did not converge.' }); }

    // ---- charts
    const it = main.hist.map(r => r.it), pos = (a) => a.map(v => Math.max(v, 1e-12));
    out.charts.push({ type: 'line', title: 'Coupling residual history', wide: true, x: { label: 'Iteration' }, y: { label: 'Normalised residual', log: true }, series: [
      { name: 'Energy (interface heat)', x: it, y: pos(main.hist.map(r => r.energy)) }, { name: 'Force (load stress)', x: it, y: pos(main.hist.map(r => r.force)) },
      { name: 'Displacement (engaged stroke)', x: it, y: pos(main.hist.map(r => r.disp)) }, { name: 'Interface update ‖Δx‖', x: it, y: pos(main.hist.map(r => r.update)) },
      ...(alt ? [{ name: `${p.scheme === 'aitken' ? 'Constant ω' : 'Aitken'} — max residual`, x: alt.hist.map(r => r.it), y: pos(alt.hist.map(r => r.total)), dash: '6 4' }] : []),
    ], annotations: [{ type: 'hline', y: p.tol, label: 'thermal tolerance', color: '#22c55e' }, ...(tolM > p.tol * 1.01 ? [{ type: 'hline', y: tolM, label: 'mechanical tolerance (solver floor)', color: '#eab308' }] : [])], explain: 'Each line is one interface residual after every fluid → cell → shaft pass (log scale). Convergence requires all of them to fall below the tolerance line together; the dashed line is the largest residual with the other relaxation scheme for comparison. A flat or rising curve signals a stiff coupling (e.g. a load near stall) that needs stronger under-relaxation.' });
    out.charts.push({ type: 'line', title: 'Interface quantities during the iteration (normalised to the one-pass values)', x: { label: 'Iteration' }, y: { label: 'x / x_one-pass' }, series: IFACE.map(([k, l]) => ({ name: l, x: it, y: main.states.map(s => s[k] / norm0[k]) })).concat([{ name: 'Relaxation factor ω', x: it, y: main.hist.map(r => r.omega), dash: '4 3' }]), explain: 'How the exchanged quantities move from their design (one-pass) values to the coupled solution. Heat-transfer coefficients follow the heat demand through the coolant flow; the load stress and frequency follow the shaft power balance. The dashed line is the relaxation factor applied to the update.' });
    const tt = H.t.map(t => t * 1000);
    out.charts.push({ type: 'line', title: 'Synchronised thermal histories (converged state, last cycle)', wide: true, x: { label: 'Time in cycle', unit: 'ms' }, y: { label: 'Temperature', unit: '°C' }, series: [
      { name: 'Fluid at wall', x: tt, y: H.Tf }, { name: 'Wall', x: tt, y: H.Tw }, { name: 'Ribbon surface', x: tt, y: H.Ts }, { name: 'Ribbon mean', x: tt, y: H.Tm }, { name: 'Ribbon centre', x: tt, y: H.Tc, dash: '4 3' }],
      annotations: [{ type: 'vline', x: 1000 * d0.dutyHot / xs.f, label: 'switch to cold' }, { type: 'hline', y: mat.Af + (d0.sigmaL + xs.sL) / mat.CA, label: 'A_f(σ_H)', color: '#f97316' }, { type: 'hline', y: mat.Mf + d0.sigmaL / mat.CM, label: 'M_f(σ_L)', color: '#38bdf8' }],
      explain: 'Fluid, wall and ribbon temperatures on the common time base of the converged cycle. The ribbon must pass A_f at the loaded stress during the hot phase and M_f at the bias stress during the cold phase for complete transformation; the lag between fluid and ribbon is the heat-transfer bottleneck.' });
    out.charts.push({ type: 'line', title: 'Synchronised phase fraction, strain and stress', x: { label: 'Time in cycle', unit: 'ms' }, y: { label: 'ξ, ξ_s [–]; ε [%]; σ/100 [MPa]' }, series: [
      { name: 'Martensite ξ', x: tt, y: H.xi }, { name: 'Detwinned ξ_s', x: tt, y: H.xis, dash: '4 3' }, { name: 'Strain ε [%]', x: tt, y: H.eps.map(e => 100 * e) }, { name: 'Stress σ/100 [MPa]', x: tt, y: H.sExt.map(s => s / 100) }],
      explain: 'Phase state, ribbon strain and external stress on the same timestamps. Contraction (falling strain) during the hot phase at the loaded stress is the power stroke; the cold phase re-extends the ribbon at the bias stress. Stress steps mark clutch engagement.' });
    out.charts.push({ type: 'line', title: 'Interface heat flow and mechanical power (one cell)', x: { label: 'Time in cycle', unit: 'ms' }, y: { label: 'Power', unit: 'W' }, series: [{ name: 'Heat flow fluid → wall', x: tt, y: H.qIn }, { name: 'Mechanical power to load ×100', x: tt, y: H.Pmech.map(v => 100 * v) }], explain: 'Instantaneous heat flow across the fluid–wall interface (positive = into the cell) and mechanical power to the load (scaled ×100 for visibility). The heat spike at each switch is the wall and ribbon thermal inertia; only a small fraction becomes work.' });
    const Vrib = cF.area * d0.ribbonL;
    out.charts.push({ type: 'line', title: 'Ribbon stress–strain loop (converged)', x: { label: 'Strain', unit: '%' }, y: { label: 'Stress', unit: 'MPa' }, series: [{ name: 'σ–ε path', x: H.eps.map(e => 100 * e), y: H.sExt }], explain: `Closed path in stress–strain space; the enclosed area times the ribbon volume (${fmt(Vrib * 1e6, 3)} cm³) is the net cycle work ${fmt(loopW, 4)} J. Horizontal segments are constant-stress transformation at the loaded and bias stresses.` });
    // thermal stack field: rows fluid / wall / surface / mean / centre
    const ds = Math.max(1, Math.floor(H.t.length / 120)), idx = range(Math.ceil(H.t.length / ds)).map(i => i * ds);
    const rows = [['fluid', H.Tf], ['wall', H.Tw], ['surface', H.Ts], ['mean', H.Tm], ['centre', H.Tc]];
    out.charts.push({ type: 'heatmap', title: 'Thermal stack field through the interface (time × layer)', x: { label: 'Time in cycle', unit: 'ms', values: idx.map(i => tt[i]) }, y: { label: 'Layer (0 fluid … 4 ribbon centre)', values: range(5) }, z: rows.map(r => idx.map(i => r[1][i])), cmap: 'inferno', z_label: '°C', explain: 'Temperature at each layer of the heat path (0 = fluid at the wall, 1 = wall, 2 = ribbon surface, 3 = ribbon mean, 4 = ribbon centre) over the cycle. Vertical colour gradients are the temperature drops that drive heat flow — and destroy exergy; the slower the colour change down the stack, the more the interface limits the frequency.' });
    out.charts.push({ type: 'bar', title: 'Cycle conservation report (one cell, fine solve)', categories: ['Q_hot', 'Q_cold', 'W_out', 'W_bias', 'ΔU', 'Residual ×1000'], series: [{ name: 'Energy per cycle [J]', values: [Lc.Qhot, Lc.Qcold, Lc.Wout, Lc.Wspring, Lc.dU, 1000 * Lc.residual] }], explain: 'First-law terms of the last cycle of the fine solve. Q_hot − Q_cold − W_out − W_bias − ΔU is the residual (shown ×1000). A periodic, conservative solution has ΔU ≈ 0 and a residual at round-off level.' });
    out.charts.push({ type: 'line', title: 'Time-step refinement of the cycle work (GCI)', x: { label: 'Time step Δt/period', log: true }, y: { label: 'W_out', unit: 'J' }, series: [{ name: 'W_out(Δt)', x: levels.map(s => 1 / s), y: Wl, mode: 'lines+markers' }, ...(Number.isFinite(gW.fext) ? [{ name: 'Richardson extrapolation', x: [1 / levels[2] / 2, 1 / levels[0]], y: [gW.fext, gW.fext], dash: '5 4' }] : [])], explain: `Cycle work at three time steps (ratio 2). The observed order is ${fmt(gW.p, 3)} and the fine-level GCI ${fmt(100 * gW.gci21, 3)} %. Non-monotone behaviour comes from discrete clutch switching and transformation onset, which are captured only to within one time step.` });
    out.charts.push({ type: 'line', title: 'Cycle-count convergence to the periodic state', x: { label: 'Cycle number' }, y: { label: 'Normalised to last cycle' }, series: [{ name: 'W_out', x: range(cycW.length).map(i => i + 1), y: cycW.map(w => w / cycW[cycW.length - 1]), mode: 'lines+markers' }, { name: 'Q_hot', x: range(cycQ.length).map(i => i + 1), y: cycQ.map(q => q / cycQ[cycQ.length - 1]), mode: 'lines+markers' }], explain: 'The cell starts cold and fully martensitic; the first cycle includes the warm-up of the wall and ribbon. Values approach 1 when the periodic steady state is reached — the number of cycles needed sets the minimum cycles for every other study.' });
    out.charts.push({ type: 'bar', title: 'Loose vs converged vs reference coupling', categories: ['P_net [W]', 'P_gross [W]', 'P_aux [W]', 'Q_hot [W]/100', 'η/η_C [%]'], series: [
      { name: 'One-pass (loose)', values: [EL.Pnet, EL.Pgross, EL.Paux, EL.QhotTot / 100, 100 * EL.carnotFraction] },
      { name: 'Converged partitioned', values: [EC.Pnet, EC.Pgross, EC.Paux, EC.QhotTot / 100, 100 * EC.carnotFraction] },
      { name: 'Suite 01 reference (hydraulic loop only)', values: [ER.Pnet, ER.Pgross, ER.Paux, ER.QhotTot / 100, 100 * ER.carnotFraction] }],
      explain: 'Engine-level results with three coupling depths: one-pass design interface values, the fully converged three-solver iteration, and the reference model that iterates only the hydraulic HTC at the design load. Differences quantify the error of treating the modules as one-way data transfers.' });

    // ---- tables
    out.tables.push({ title: 'Iteration log', cols: ['It.', 'h_hot [W/m²K]', 'h_cold [W/m²K]', 'σ_load [MPa]', 'f [Hz]', 'W_out [J]', 'Q_hot [J]', 'Engaged stroke [mm]', 'Load torque [N·m]', 'Energy res.', 'Force res.', 'Disp. res.', 'ω'], rows: main.states.map((s, i) => [i + 1, s.hH, s.hC, s.sL, s.f, s.Wout, s.Qhot, 1000 * s.stroke, s.tau, main.hist[i].energy, main.hist[i].force, main.hist[i].disp, main.hist[i].omega]), explain: 'Interface values applied in each iteration and the resulting residuals. The applied values are the relaxed ones; residuals compare them with what the receiving solver returned.' });
    out.tables.push({ title: 'Coupling-depth comparison', cols: ['Quantity', 'One-pass', 'Converged', 'Suite 01 reference', 'Converged vs one-pass'], rows: [
      ['h_hot [W/m²K]', x0.hH, xs.hH, ER.hHotUsed, `${fmt(100 * (xs.hH / x0.hH - 1), 3)} %`],
      ['h_cold [W/m²K]', x0.hC, xs.hC, ER.hColdUsed, `${fmt(100 * (xs.hC / x0.hC - 1), 3)} %`],
      ['σ_load [MPa]', x0.sL, xs.sL, x0.sL, `${fmt(100 * (xs.sL / Math.max(1e-9, x0.sL) - 1), 3)} %`],
      ['f [Hz]', x0.f, xs.f, p.freq, `${fmt(100 * (xs.f / x0.f - 1), 3)} %`],
      ['W_out per cell [J]', Wavg(cLoose), WF, Wavg(ER.cell), `${fmt(100 * (WF / Math.max(1e-12, Wavg(cLoose)) - 1), 3)} %`],
      ['P_net [W]', EL.Pnet, EC.Pnet, ER.Pnet, `${fmt(100 * dLooseP, 3)} %`],
      ['Active specific net power [W/kg]', EL.pActive, EC.pActive, ER.pActive, ''],
      ['Thermal efficiency [%]', 100 * EL.eta, 100 * EC.eta, 100 * ER.eta, ''],
      ['Pump power [W]', EL.Ppump, EC.Ppump, ER.Ppump, ''],
    ], explain: 'All three columns use the same engine accounting (Suite 01). The reference iterates only the hydraulics at the design load; the converged column also closes the shaft load and frequency loop.' });
    out.tables.push({ title: 'Conservation and interface report', cols: ['Check', 'Value', 'Comment'], rows: [
      ['Cell first-law residual (last cycle)', fmt(energyResidual, 3), 'relative to Q_hot'],
      ['Fluid stream heat (coupling resolution) ↔ cell heat (fine solve)', `${fmt(QfluidC, 5)} / ${fmt(QF, 5)} J`, `matching ${fmt(100 * fluxMatch, 3)} %`],
      ['Gross interface heat throughput ∫|q|dt', `${fmt(qInt, 5)} J`, 'heating plus cooling per cycle'],
      ['Shaft balance P_cell vs P_load', `${fmt(shF.Pcell, 4)} / ${fmt(shF.Pload, 4)} W`, kL > 0 ? 'cycle-averaged' : 'constant torque: speed held by controller'],
      ['∮σdε·V (right-point)', `${fmt(loopW, 5)} J`, `W_out + W_bias = ${fmt(cF.Wout + cF.Wspring, 5)} J`],
      ['Trapezoidal W_contraction − W_reset', `${fmt(cF.Wcontraction - cF.Wreset, 5)} J`, `differs by ${fmt(100 * trapGap, 3)} % (stress averaged across clutch switch)`],
      ['Periodicity (last two cycles of long run)', fmt(perio[perio.length - 1], 3), `${p.studyCycles} cycles`],
      ['Design load torque τ_d', `${fmt(tauD, 4)} N·m`, tauProv],
      ['Effective lever arm R_eff', `${fmt(1000 * Reff, 4)} mm`, `engaged fraction ${fmt(100 * eng0, 3)} % of the cycle`],
    ], explain: 'Independent checks that energy, force and displacement are exchanged consistently between the solvers.' });
    out.tables.push({ title: 'Time-step and cycle-count study', cols: ['Steps/cycle', 'W_out [J]', 'Q_hot [J]', 'Energy residual'], rows: levels.map((s, i) => [s, Wl[i], Ql[i], runsT[i].energyResidual]).concat([['GCI₂₁ (W / Q)', fmt(100 * gW.gci21, 3) + ' %', fmt(100 * gQ.gci21, 3) + ' %', `p = ${fmt(gW.p, 3)} / ${fmt(gQ.p, 3)}`]]), explain: 'Refinement ratio 2. The GCI estimates the numerical uncertainty band of the finest level; oscillatory convergence is flagged in the checks.' });

    // ---- explanation
    out.explain.push(
      { title: 'What was solved', text: `Three solvers were coupled in a staggered loop: the channel flow (coolant flow follows the cell heat demand, giving the heat-transfer coefficient), the transient SMA cell (${p.nC} half-thickness cells, ${p.spcC} steps per cycle while iterating; ${p.nF}/${p.spcF} for the final solve) and the shaft (power balance against a k = ${kL} load line, load stress through an effective lever arm of ${fmt(1000 * Reff, 3)} mm). ${main.converged ? `The interface converged in ${main.iterations} iterations` : `The interface did NOT converge within ${main.iterations} iterations`} with ${p.scheme === 'aitken' ? 'Aitken' : 'constant'} relaxation.` },
      { title: 'What changed through coupling', text: `The hot-side HTC moved from ${fmt(x0.hH, 4)} to ${fmt(xs.hH, 4)} W/m²K because the flow needed to carry ${fmt(QF, 4)} J per cell-cycle at ΔT_fluid = ${d0.fluidDT} K sets the channel Reynolds number. The ribbon load stress went from ${fmt(x0.sL, 3)} to ${fmt(xs.sL, 3)} MPa and the frequency from ${fmt(x0.f, 3)} to ${fmt(xs.f, 3)} Hz as the shaft balance closed. Net power changed by ${fmt(100 * dLooseP, 3)} % relative to the one-pass estimate.` },
      { title: 'Energy picture', text: `Each cell takes ${fmt(QF, 4)} J per cycle from the hot fluid and delivers ${fmt(WF, 4)} J of work (${fmt(100 * WF / Math.max(1e-12, QF), 3)} %); the rest heats and cools the ribbon and wall and is rejected. The regenerator credit and auxiliaries are applied at engine level: P_net = ${fmt(EC.Pnet, 4)} W for ${N} cells.` },
    );
    // ---- recommendations
    if (!main.converged) out.recs.push({ level: 'critical', text: `Coupled solution not converged (residual ${fmt(couplingResidual, 3)} > ${p.tol}). Do not use the published values for design decisions; use constant relaxation ω₀ ≈ 0.3 or reduce the load torque.`, basis: 'Coupling residual history' });
    if (Math.abs(dLooseP) > 0.05) out.recs.push({ level: 'warn', text: `One-pass coupling misstates net power by ${fmt(100 * dLooseP, 3)} %. Downstream suites (15, 16, 18) should consume the converged co-simulation outputs, which are now published.`, basis: 'Loose vs converged comparison' });
    else out.recs.push({ level: 'good', text: `Interface feedback changes net power by only ${fmt(100 * dLooseP, 3)} % at this operating point; one-pass estimates are adequate for screening sweeps (Suite 17) but the converged state should be used for fatigue (Suite 16).`, basis: 'Loose vs converged comparison' });
    const xiOK = cF.reverseComplete && cF.forwardComplete;
    out.recs.push({ level: xiOK ? 'info' : 'warn', text: xiOK ? `Transformation completes in both phases (ξ swing ${fmt(cF.xiSwing, 3)}); the cycle is heat-transfer-limited rather than transformation-limited — a higher frequency is possible if h and the coolant flow are raised together.` : `Transformation is incomplete (ξ ${fmt(cF.xiMin, 3)}–${fmt(cF.xiMax, 3)}): the converged HTC of ${fmt(xs.hH, 4)} W/m²K cannot drive the ribbon past A_f/M_f at ${fmt(xs.f, 3)} Hz. Lower the frequency, increase channel flow or thin the ribbon.`, basis: 'Synchronised histories' });
    out.recs.push({ level: 'econ', text: `Pumping costs ${fmt(EC.Ppump, 3)} W (${fmt(100 * EC.Ppump / Math.max(1e-9, EC.Pgross), 3)} % of gross power) at the converged flow; HTC gains beyond ${fmt(xs.hH, 4)} W/m²K must be bought with pump power that scales ~ ṁ³ — evaluate the trade in Suite 17 rather than by raising flow alone.`, basis: 'Converged hydraulics' });
    out.recs.push({ level: 'sustain', text: `Only ${fmt(100 * WF / Math.max(1e-12, QF), 3)} % of the cell heat becomes work; ${fmt(100 * (1 - WF / Math.max(1e-12, QF)), 3)} % is sensible/latent cycling heat. Reducing the wall heat capacity (${d0.wallCapacity} J/m²K) and improving regeneration lowers the heat source demand and its footprint more than any mechanical change.`, basis: 'Cell energy split' });
    out.recs.push({ level: 'info', text: 'Validate with an instrumented single-cell rig recording fluid temperatures, force, stroke and shaft torque on one clock; import the CSV here to overlay the synchronised histories.', basis: 'Master spec §30 (common timestamps), §33 gate V3' });

    // ---- animation view
    const series4 = { H, f: xs.f, d: d0, mat, sL: xs.sL };
    out.views.push({ label: '2D animation: synchronised cell, fluid and shaft', icon: '🎞', render: (el) => cosimView(el, series4) });
    out.convergence = { title: 'Coupling residual (max)', series: [{ name: 'max residual', x: it, y: main.hist.map(r => r.total) }] };
    const dsH = Math.max(1, Math.floor(H.t.length / 400)), pick = (a) => a.filter((_, i) => i % dsH === 0);
    out.outputs = {
      converged: main.converged, iterations: main.iterations, Wout_J: WF, Qhot_J: QF, energyResidual, couplingResidual, hHot: xs.hH, freq_Hz: xs.f,
      hCold: xs.hC, sLoad_MPa: xs.sL, sigmaHeff_MPa: d0.sigmaL + xs.sL, Pnet_W: EC.Pnet, Pgross_W: EC.Pgross, stroke_m: cF.stroke, xiSwing: cF.xiSwing,
      epsTr: (max(H.eps) - min(H.eps)), loosePnet_W: EL.Pnet,
      history: { t: pick(H.t), sExt: pick(H.sExt), eps: pick(H.eps), xi: pick(H.xi), Tm: pick(H.Tm), qIn: pick(H.qIn) },
    };
    out.headline = `${main.converged ? 'Converged' : 'NOT converged'} in ${main.iterations} iterations — W_out ${fmt(WF, 4)} J/cell, f ${fmt(xs.f, 3)} Hz, P_net ${fmt(EC.Pnet, 4)} W (one-pass ${fmt(EL.Pnet, 4)} W)`;
    out.headlineKind = main.converged && EC.Pnet > 0 ? 'ok' : main.converged ? 'warn' : 'fail';
    out.credibility = main.converged ? 'Numerically verified' : 'Analytical screening';
    ctxProgress(1, 'done');
    return out;
  },
};

// Animated synchronised view: ribbon (length ∝ strain, colour ∝ temperature), fluid state, and time-series panels
function cosimView(el, { H, f, d, mat, sL }) {
  const P = 1 / f, Tmin = Math.min(...H.Tf), Tmax = Math.max(...H.Tf);
  const col = (T) => { const u = clamp((T - Tmin) / ((Tmax - Tmin) || 1), 0, 1); return `rgb(${Math.round(40 + 215 * u)},${Math.round(90 + 40 * (1 - Math.abs(u - 0.5) * 2))},${Math.round(230 - 200 * u)})`; };
  anim2d(el, { duration: H.t[H.t.length - 1], rate: Math.min(1, 0.5 / P), label: 'cycle time', unit: 's', height: 460, explain: 'Left: the cell — channel fluid colour shows hot/cold switching, the ribbon colour its mean temperature and its length the strain; the arrow is the clutch force when engaged. Right: fluid/wall/ribbon temperatures, phase fraction and stress, and interface heat flow on the same time base.', draw(g, t, W, H2) {
    const th = theme(), k = at(H.t, t), Tf = lerp(H.Tf, k), Tm = lerp(H.Tm, k), eps = lerp(H.eps, k), xi = lerp(H.xi, k), s = lerp(H.sExt, k), eng = H.engaged[k.i];
    const x0 = 20, y0 = 40, w = Math.min(220, W * 0.3), hh = H2 - 80;
    g.fillStyle = col(Tf); g.globalAlpha = 0.35; g.fillRect(x0, y0, w, hh); g.globalAlpha = 1; g.strokeStyle = th.grid; g.strokeRect(x0, y0, w, hh);
    const epsMax = Math.max(...H.eps), Lfull = hh - 60, Lr = Lfull * (1 - (epsMax - eps) / Math.max(1e-6, epsMax) * 0.6);
    g.fillStyle = '#9ca3af'; g.fillRect(x0 + w / 2 - 30, y0 + 6, 60, 8);
    g.fillStyle = col(Tm); g.fillRect(x0 + w / 2 - 6, y0 + 14, 12, Lr);
    g.fillStyle = eng === 1 ? '#22c55e' : eng === 0.5 ? '#ef4444' : '#64748b'; g.fillRect(x0 + w / 2 - 20, y0 + 14 + Lr, 40, 10);
    text(g, `T_fluid ${Tf.toFixed(1)} °C`, x0 + 6, y0 - 22); text(g, `ξ ${xi.toFixed(2)}  ε ${(100 * eps).toFixed(2)} %  σ ${s.toFixed(0)} MPa`, x0 + 6, y0 - 8);
    text(g, eng === 1 ? 'clutch engaged — power stroke' : eng === 0.5 ? 'load blocked (stalled)' : 'freewheel / reset', x0 + 6, y0 + hh + 18, th.mute);
    const px = x0 + w + 24, pw = W - px - 12, ph = (H2 - 30) / 3;
    seriesPanel(g, { x: px, y: 8, w: pw, h: ph - 6, T: H.t, t, title: 'Temperatures', unit: '°C', series: [{ name: 'fluid', y: H.Tf, color: '#f97316' }, { name: 'wall', y: H.Tw, color: '#a855f7' }, { name: 'ribbon', y: H.Tm, color: '#38bdf8' }], hlines: [{ y: mat.Af + (d.sigmaL + sL) / mat.CA, label: 'Af(σH)', color: '#ef4444' }] });
    seriesPanel(g, { x: px, y: 8 + ph, w: pw, h: ph - 6, T: H.t, t, title: 'ξ and σ/200', unit: '–', series: [{ name: 'ξ', y: H.xi, color: '#22c55e' }, { name: 'σ/200', y: H.sExt.map(v => v / 200), color: '#eab308' }] });
    seriesPanel(g, { x: px, y: 8 + 2 * ph, w: pw, h: ph - 6, T: H.t, t, title: 'Interface heat flow', unit: 'W', series: [{ name: 'q fluid→wall', y: H.qIn, color: '#ef4444' }] });
  } });
}
