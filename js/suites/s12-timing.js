// Suite 12 — Multicell phase timing and load scheduling.
// Hybrid state machine per cell (heating → power → isolation → cooling → reset → ready) derived from one periodic
// cell cycle at the operating shaft speed; N cells with phase offsets; constrained optimisation of offsets (ripple vs
// hot-supply peak and valve-switching latency) and of the spatial firing order (rotor/bearing radial load).
import { linspace, range, mean, std, clamp, nelderMead, fmt } from '../core/num.js';
import { diffEvolution } from '../core/analysis.js';
import { cellDrive, scaleDrive, ribbonStiffness, constantSpeedCell, designGear, effRadius, drawRotor, pause } from './s11-shaft.js';

const TAU = 2 * Math.PI, f3 = (v) => fmt(v, 3), f4 = (v) => fmt(v, 4);
const STATES = ['Heating', 'Power stroke', 'Isolation / switching', 'Cooling', 'Reset (re-extension)', 'Ready (cold, extended)'];

// periodic linear-interpolated sample of a profile y[M] at fractional index q
const samp = (y, q) => { const M = y.length; q = ((q % M) + M) % M; const i = Math.floor(q), f = q - i; return y[i] + (y[(i + 1) % M] - y[i]) * f; };
// array response for offsets φ (fractions of the period): Σ_i y(t + φ_i·P)
function arraySum(y, phi) { const M = y.length, out = new Float64Array(M); for (const ph of phi) { const q = (((ph * M) % M) + M) % M, i0 = Math.floor(q), f = q - i0, g = 1 - f; for (let k = 0; k < M; k++) { let a = k + i0; if (a >= M) a -= M; const b = a + 1 === M ? 0 : a + 1; out[k] += g * y[a] + f * y[b]; } } return out; }
function stats(T) { const n = T.length; let s = 0, mx = -Infinity, mn = Infinity; for (const v of T) { s += v; if (v > mx) mx = v; if (v < mn) mn = v; } const m = s / n; let v2 = 0; for (const v of T) v2 += (v - m) ** 2; return { mean: m, max: mx, min: mn, pp: m > 0 ? (mx - mn) / m : Infinity, rms: m > 0 ? Math.sqrt(v2 / n) / m : Infinity }; }
// hot-valve opening events (phase time 0 of each cell ⇒ reference time (1 − φ)·P) sorted on the period circle; penalty for
// openings closer than the switching latency (two opening transients on the shared hot loop at once)
function latencyPenalty(phi, latFrac) { if (latFrac <= 0 || phi.length < 2) return { pen: 0, minGap: 1 }; const ev = []; for (const p of phi) ev.push((((1 - p) % 1) + 1) % 1); ev.sort((a, b) => a - b); let pen = 0, minGap = 1; for (let i = 0; i < ev.length; i++) { const g = i === ev.length - 1 ? ev[0] + 1 - ev[i] : ev[i + 1] - ev[i]; minGap = Math.min(minGap, g); if (g < latFrac * (1 - 1e-6)) pen += (latFrac - g) / latFrac; } return { pen: pen / ev.length, minGap }; }

export default {
  description: 'Schedules N cells around the common shaft: builds each cell’s hybrid state history (heating, power stroke, isolation, cooling, reset), sums phase-shifted torque contributions, and optimises phase offsets and firing order to minimise torque ripple subject to the hot-supply peak and valve-switching latency. Shows explicitly that phasing smooths torque but leaves mean torque — and therefore mean energy — unchanged.',
  literature: 'multicell shape memory alloy heat engine phase scheduling torque ripple firing order optimisation',
  econ: true, sustain: true, credibility: 'Analytical screening',
  equations: [
    'Array torque: τ(t) = Σᵢ τ₁(t + φᵢ·P),  φᵢ ∈ [0, 1) phase offsets of N identical cells',
    'Mean invariance: (1/P)∫₀ᴾ τ₁(t + φP) dt = τ̄₁ for every φ  ⇒  τ̄ = N·τ̄₁ independent of the schedule',
    'Ripple: r_pp = (τ_max − τ_min)/τ̄,  r_rms = √(⟨(τ − τ̄)²⟩)/τ̄',
    'Hot-supply demand: Q̇_hot(t) = Σᵢ q̇₁(t + φᵢP);  constraint max Q̇_hot ≤ k_peak·mean Q̇_hot',
    'Valve latency: every gap between successive hot-valve openings ≥ t_latency (one opening transient on the hot loop at a time)',
    'Radial bearing load: F_r(t) = |Σₖ F(t + φ_{π(k)}P)·ê_t(ψₖ)|, ψₖ = 2πk/N; firing order π minimises max F_r',
    'Flywheel sizing: ΔE = max∫(τ − τ̄)ω dt − min∫(τ − τ̄)ω dt,  J ≥ ΔE/(C_s ω²)',
    'Optimisation: min_φ r_pp + w_q·max(0, Q̇_peak/(k_peak Q̇_mean) − 1) + w_l·latency penalty',
  ],
  methods: [
    'Single-cell periodic cycle from the transient ribbon-cell solver (Suite 05 force history when published) converted to shaft torque at constant operating speed with the Suite 11 one-way-coupling model',
    'Hybrid state classification per time step from hot/cold phase, transmitted torque, valve-switching interval and free-contraction motion',
    'Periodic linear interpolation for fractional phase shifts (exact mean preservation)',
    'Differential evolution (analysis.diffEvolution) over N − 1 offsets followed by Nelder–Mead polishing (num.nelderMead)',
    'Pairwise-swap local search over spatial firing order for minimum peak radial bearing load',
  ],
  assumptions: [
    'Identical cells; constant shaft speed over a cycle (flywheel-smoothed — Suite 11 reports the actual speed ripple)',
    'Cell thermodynamics unaffected by neighbours (no thermal cross-talk; separators per spec §5)',
    'Hot-supply demand per cell from the transient wall heat flux during its hot phase; pumps sized on the peak (Suite 13)',
    'Valve timing is clock-driven; switching latency is the minimum spacing between hot-valve openings on the shared hot loop',
  ],
  ibc: {
    initial: ['Cell states at t = 0 given by the offsets (cell 1 at phase 0)', 'Steady periodic cell cycle (cold, pre-extended ribbons at the start of each hot phase)'],
    boundary: ['Constant shaft speed from Suite 11', 'Hot/cold fluid supply temperatures from the engine design', 'Valve switching latency from Suite 13 (or the design switching time)'],
  },
  cvv: {
    calibration: ['Measured single-cell torque history on the instrumented rocker', 'Valve opening/closing times from the synchroniser'],
    verification: ['Mean torque invariant to offsets (to interpolation tolerance)', 'Uniform N-cell ripple → 0 as N → ∞ for a smooth single-cell profile', 'Sum of state durations = period for each cell', 'Optimised objective ≤ uniform objective'],
    validation: ['Synchroniser timing tests and array load sweeps on the multicell rig (spec Module 12)'],
  },
  formats: { import: ['CSV single-cell torque history (t, τ)', 'CSV valve timing logs', 'JSON firing schedule'], export: ['CSV phase schedule (cell, offset, firing position)', 'CSV state map', 'PNG/SVG plots', 'JSON schedule for the controller'] },
  params: [
    { key: 'nCells', label: 'Number of cells', type: 'number', min: 1, max: 96, step: 1, default: 12, group: 'Array', auto: (c) => ({ value: c.engine.nCells, prov: 'calc' }) },
    { key: 'dutyHot', label: 'Hot-phase fraction of the cycle', type: 'range', min: 0.2, max: 0.8, step: 0.01, default: 0.5, group: 'Array', auto: (c) => ({ value: c.engine.dutyHot, prov: 'calc' }) },
    { key: 'omega', label: 'Operating shaft speed', unit: 'rad/s', type: 'number', min: 0.05, max: 300, step: 0.01, default: 6.283, group: 'Shaft', auto: (c) => { const o = c.upstream('s11'); return o?.omega_rads > 0 ? { value: +o.omega_rads.toFixed(4), prov: 'coupled' } : { value: +(c.engine.rpm * TAU / 60).toFixed(4), prov: 'calc' }; } },
    { key: 'Reff', label: 'Effective coupling radius R = r_arm/G', unit: 'mm', type: 'number', min: 0, max: 200, step: 0.001, default: 0, group: 'Shaft', auto: (c) => { const o = c.upstream('s11'); return o?.effRadius_m > 0 ? { value: +(o.effRadius_m * 1000).toPrecision(5), prov: 'coupled' } : undefined; }, help: '0 = derive from the design speed as in Suite 11 (rocker 20 mm).' },
    { key: 'etaCoupling', label: 'Coupling efficiency (clutch × gears)', type: 'range', min: 0.5, max: 1, step: 0.005, default: 0.95, group: 'Shaft' },
    { key: 'amplification', label: 'Metamaterial amplification A', type: 'number', min: 0.2, max: 20, step: 0.01, default: 1, group: 'Shaft', auto: (c) => { const o = c.upstream('s10'); return o?.amplification > 0 ? { value: +o.amplification.toFixed(3), prov: 'coupled' } : undefined; } },
    { key: 'metaEff', label: 'Metamaterial efficiency', type: 'range', min: 0.3, max: 1, step: 0.005, default: 0.98, group: 'Shaft', auto: (c) => { const o = c.upstream('s10'); return o?.transEff > 0 ? { value: +o.transEff.toFixed(4), prov: 'coupled' } : undefined; } },
    { key: 'latency', label: 'Valve switching latency', unit: 's', type: 'number', min: 0, max: 1, step: 0.001, default: 0.02, group: 'Constraints', auto: (c) => { const o = c.upstream('s13'); return o?.valveLatency_s >= 0 ? { value: o.valveLatency_s, prov: 'coupled' } : { value: c.engine.tSwitch, prov: 'calc' }; } },
    { key: 'heatPeak', label: 'Allowed hot-supply peak / mean', type: 'number', min: 1, max: 5, step: 0.05, default: 1.5, group: 'Constraints', help: 'Peak instantaneous hot-fluid heat demand allowed relative to the mean (pump/boiler sizing).' },
    { key: 'rippleTarget', label: 'Target torque ripple (peak-to-peak / mean)', type: 'number', min: 0.01, max: 3, step: 0.01, default: 0.3, group: 'Constraints' },
    { key: 'speedFluct', label: 'Allowed speed fluctuation C_s (flywheel sizing)', type: 'number', min: 0.001, max: 0.2, step: 0.001, default: 0.02, group: 'Constraints' },
    { key: 'optOrder', label: 'Optimise spatial firing order (bearing load)', type: 'bool', default: true, group: 'Optimiser' },
    { key: 'wHeat', label: 'Weight of hot-peak violation', type: 'number', min: 0, max: 100, step: 0.5, default: 4, group: 'Optimiser', expert: true },
    { key: 'wLat', label: 'Weight of latency violation', type: 'number', min: 0, max: 100, step: 0.5, default: 2, group: 'Optimiser', expert: true },
    { key: 'pop', label: 'Differential-evolution population', type: 'number', min: 8, max: 200, step: 2, default: 24, group: 'Optimiser', expert: true },
    { key: 'gens', label: 'Differential-evolution generations', type: 'number', min: 5, max: 500, step: 5, default: 60, group: 'Optimiser', expert: true },
    { key: 'seed', label: 'Random seed', type: 'number', min: 1, max: 99999, step: 1, default: 12, group: 'Optimiser', expert: true },
    { key: 'cellSpc', label: 'Time samples per cycle', type: 'number', min: 80, max: 600, step: 20, default: 200, group: 'Optimiser', expert: true },
  ],
  presets: [
    { label: 'Six-cell demonstrator', values: { nCells: 6 } },
    { label: 'Tight hot-supply peak (1.1×)', values: { heatPeak: 1.1 } },
    { label: 'Slow valves (50 ms)', values: { latency: 0.05 } },
    { label: 'Large array (24 cells)', values: { nCells: 24 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const N = Math.max(1, Math.round(p.nCells)), duty = p.dutyHot, d = { ...ctx.engine, dutyHot: duty };
    ctx.progress(0.05, 'Single-cell cycle');
    const { cell, drive: dr0, src, prov, mat } = cellDrive(ctx, d, { spc: p.cellSpc });
    await pause(ctx);
    const A = p.amplification || 1, dr = scaleDrive(dr0, A, p.metaEff), M = dr.spc, P = dr.P, dt = P / M;
    const ks = ribbonStiffness(mat, d, cell) / (A * A), omega = p.omega;
    const R = p.Reff > 0 ? p.Reff / 1000 : effRadius(20, designGear(dr, 20, omega));
    const one = constantSpeedCell(dr, { omega, R, eta: p.etaCoupling, ks, cs: 2 * 0.15 * Math.sqrt(ks * 0.05) });
    const tau1 = one.tau, F1 = one.F, tMax1 = Math.max(...tau1);
    // ---- hybrid state machine of one cell ----
    const H = cell.hist, nHot = dr.nHot, latS = Math.max(p.latency, d.tSwitch || 0), thr = 0.02 * tMax1;
    let firstP = -1, lastP = -1; for (let k = 0; k < M; k++) if (tau1[k] > thr) { if (firstP < 0) firstP = k; lastP = k; }
    const state = new Int8Array(M);
    for (let k = 0; k < M; k++) {
      const hot = k < nHot, tc = (k - nHot) * dt;
      if (hot) state[k] = tau1[k] > thr ? 1 : (firstP < 0 || k < firstP ? 0 : 2);
      else if (tc < latS) state[k] = 2;
      else { const dx = dr.xf[(k + 1) % M] - dr.xf[k]; state[k] = dr.xf[k] >= dr.xwMax * 0.999 && dx >= -1e-12 ? 3 : dr.xf[k] > 0.01 * dr.xwMax ? 4 : 5; }
    }
    const dur = range(6).map(s => state.reduce((a, v) => a + (v === s ? dt : 0), 0));
    const qHot = Float64Array.from(range(M), k => k < nHot ? Math.max(0, H.qIn[k]) : 0), qMean1 = qHot.reduce((a, b) => a + b, 0) / M;
    // ---- evaluation of a schedule ----
    const latFrac = p.latency / P;
    const dec2 = M >= 160 ? 2 : 1, tauC = tau1.filter((_, k) => k % dec2 === 0), qC = qHot.filter((_, k) => k % dec2 === 0), F1C = F1.filter((_, k) => k % dec2 === 0), MC = tauC.length;
    const evalFast = (phi) => { const s = stats(arraySum(tauC, phi)), q = stats(arraySum(qC, phi)); return { s, qPeakRatio: q.mean > 0 ? q.max / q.mean : 1, lat: latencyPenalty(phi, latFrac) }; };
    const evalPhi = (phi) => { const T = arraySum(tau1, phi), Q = arraySum(qHot, phi), s = stats(T), qs = stats(Q), lat = latencyPenalty(phi, latFrac); return { T, Q, s, qPeakRatio: qs.mean > 0 ? qs.max / qs.mean : 1, lat }; };
    const objective = (e) => e.s.pp + p.wHeat * Math.max(0, e.qPeakRatio / p.heatPeak - 1) + p.wLat * e.lat.pen;
    const uniform = range(N).map(i => i / N), simult = range(N).map(() => 0);
    const eU = evalPhi(uniform), eS = evalPhi(simult);
    ctx.progress(0.2, 'Optimising phase offsets');
    let phiOpt = uniform, eO = eU, hist = [], nEval = 0;
    if (N > 1) {
      // offsets parameterised as deviations from the uniform pattern: φᵢ = i/N + δᵢ, |δᵢ| ≤ 0.6/N (cell 1 fixed at 0)
      const span = 0.6 / N, toPhi = (x) => [0, ...x.map((v, j) => ((((j + 1) / N + v) % 1) + 1) % 1)];
      const fx = (x) => { nEval++; return objective(evalFast(toPhi(x))); };
      const de = diffEvolution(fx, range(N - 1).map(() => [-span, span]), { pop: Math.max(p.pop, N), gens: p.gens, seed: p.seed });
      hist = de.history;
      const nm = nelderMead(fx, de.x, { step: 0.05, maxIt: 600, tol: 1e-10 }), nm0 = nelderMead(fx, range(N - 1).map(() => 0), { step: 0.05, maxIt: 800, tol: 1e-10 });
      const bestX = [[de.x, de.f], [nm.x, nm.f], [nm0.x, nm0.f]].sort((a, b) => a[1] - b[1])[0][0], cand = toPhi(bestX), eC = evalPhi(cand);
      if (objective(eC) <= objective(eU)) { phiOpt = cand; eO = eC; } // never return a schedule worse than uniform
      hist.push(Math.min(objective(eO), ...(hist.length ? [hist[hist.length - 1]] : [])));
    }
    await pause(ctx);
    ctx.progress(0.6, 'Firing order');
    // ---- spatial firing order (positions around the rotor) ----
    const byOffset = range(N).sort((a, b) => phiOpt[a] - phiOpt[b]); // cell indices in firing sequence
    const psi = range(N).map(k => TAU * k / N);
    const radialLoad = (pos) => { let mx = 0, s4 = 0; for (let k = 0; k < MC; k++) { let fx = 0, fy = 0; for (let i = 0; i < N; i++) { const F = samp(F1C, k + phiOpt[i] * MC), a = psi[pos[i]]; fx += -F * Math.sin(a); fy += F * Math.cos(a); } const fr = Math.hypot(fx, fy); mx = Math.max(mx, fr); s4 += fr ** 4; } return { peak: mx, soft: (s4 / MC) ** 0.25 }; }; // soft-max (4-norm) objective, peak reported
    const posSeq = new Array(N); byOffset.forEach((ci, r) => { posSeq[ci] = r; }); // sequential: r-th firing cell at position r
    let pos = posSeq.slice(), Fr0 = radialLoad(posSeq).peak, cur = radialLoad(pos).soft, swaps = 0;
    if (p.optOrder && N > 2) for (let pass = 0; pass < 6; pass++) { let improved = false; for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) { [pos[a], pos[b]] = [pos[b], pos[a]]; const v = radialLoad(pos).soft; if (v < cur * (1 - 1e-9)) { cur = v; improved = true; swaps++; } else[pos[a], pos[b]] = [pos[b], pos[a]]; } if (!improved) break; }
    let Fr = radialLoad(pos).peak; if (Fr > Fr0) { pos = posSeq.slice(); Fr = Fr0; }
    const firingOrder = byOffset.map(ci => pos[ci] + 1); // rotor positions (1-based) in firing sequence
    // ---- flywheel, power-stroke counts, invariance ----
    const flyJ = (T, m) => { let c = 0, hi = 0, lo = 0; for (let k = 0; k < M; k++) { c += (T[k] - m) * omega * dt; hi = Math.max(hi, c); lo = Math.min(lo, c); } const dE = hi - lo; return { dE, J: dE / (p.speedFluct * omega * omega) }; };
    const fU = flyJ(eU.T, eU.s.mean), fO = flyJ(eO.T, eO.s.mean), fS = flyJ(eS.T, eS.s.mean);
    const powerCount = (phi) => Float64Array.from(range(M), k => phi.reduce((a, ph) => a + (samp(tau1, k + ph * M) > thr ? 1 : 0), 0));
    const pcO = powerCount(phiOpt), pcU = powerCount(uniform), hotCount = Float64Array.from(range(M), k => phiOpt.reduce((a, ph) => a + ((((k / M + ph) % 1) + 1) % 1 < duty ? 1 : 0), 0));
    const invErr = Math.max(Math.abs(eO.s.mean - eU.s.mean), Math.abs(eS.s.mean - eU.s.mean)) / Math.max(eU.s.mean, 1e-12), tauBar1 = tau1.reduce((a, b) => a + b, 0) / M;
    const Pmean = eO.s.mean * omega, Qmean = N * qMean1;
    // ripple vs N (uniform)
    const Ns = range(Math.max(24, 2 * N)).map(i => i + 1), ripN = Ns.map(n => stats(arraySum(tau1, range(n).map(i => i / n))).pp);
    // ---- checks ----
    const durSum = dur.reduce((a, b) => a + b, 0);
    out.checks.push(
      { name: 'Mean torque invariant to phase offsets (optimised, uniform, simultaneous)', value: invErr, target: '< 1e-3', pass: invErr < 1e-3, detail: `τ̄ = ${f4(eU.s.mean)} N·m uniform, ${f4(eO.s.mean)} optimised, ${f4(eS.s.mean)} simultaneous; N·τ̄₁ = ${f4(N * tauBar1)} N·m.` },
      { name: 'Array mean equals N × single-cell mean', value: Math.abs(eU.s.mean - N * tauBar1) / Math.max(N * tauBar1, 1e-12), target: '< 1e-9', pass: Math.abs(eU.s.mean - N * tauBar1) <= 1e-9 * Math.max(N * tauBar1, 1e-12) + 1e-12 },
      { name: 'State durations sum to the period', value: Math.abs(durSum - P) / P, target: '< 1e-9', pass: Math.abs(durSum - P) / P < 1e-9 },
      { name: 'Optimised objective ≤ uniform objective', value: objective(eO) - objective(eU), target: '≤ 0', pass: objective(eO) <= objective(eU) + 1e-12 },
      { name: 'Uniform ripple decreases with cell count (N → 2N)', value: ripN[Math.min(2 * N, ripN.length) - 1] - ripN[N - 1], target: '≤ 0', pass: ripN[Math.min(2 * N, ripN.length) - 1] <= ripN[N - 1] + 1e-9 },
      { name: 'Hot-supply energy invariant to phasing', value: Math.abs(stats(eO.Q).mean - stats(eU.Q).mean) / Math.max(stats(eU.Q).mean, 1e-12), target: '< 1e-3', pass: Math.abs(stats(eO.Q).mean - stats(eU.Q).mean) <= 1e-3 * Math.max(stats(eU.Q).mean, 1e-12) },
    );
    // ---- KPIs ----
    const minPower = Math.min(...pcO);
    out.kpis.push(
      { label: 'Mean shaft drive torque', value: eO.s.mean, unit: 'N·m', explain: `N·τ̄₁ = ${N} × ${f3(tauBar1)} N·m at ${f3(omega * 60 / TAU)} rpm. Identical for every schedule — phasing redistributes torque in time only.`, prov: 'calc' },
      { label: 'Torque ripple, optimised (peak-to-peak / mean)', value: eO.s.pp * 100, unit: '%', explain: `Uniform offsets give ${f3(eU.s.pp * 100)} %, all cells together ${f3(eS.s.pp * 100)} %. Lower ripple means smaller flywheel, gearbox and clutch loads.`, prov: 'calc', status: eO.s.pp <= p.rippleTarget ? 'ok' : 'warn' },
      { label: 'RMS torque ripple, optimised', value: eO.s.rms * 100, unit: '%', explain: `Standard deviation of torque over the mean (uniform ${f3(eU.s.rms * 100)} %).`, prov: 'calc' },
      { label: 'Minimum cells in power stroke', value: minPower, unit: '', explain: `Fewest cells pushing the shaft at any instant (mean ${f3(mean(Array.from(pcO)))}). At least one at all times gives continuous drive torque.`, prov: 'calc', status: minPower >= 1 ? 'ok' : 'warn' },
      { label: 'Hot-supply peak / mean, optimised', value: eO.qPeakRatio, unit: '–', explain: `Peak simultaneous hot-fluid heat demand relative to the mean ${f3(Qmean)} W (uniform ${f3(eU.qPeakRatio)}, simultaneous ${f3(eS.qPeakRatio)}). The pump and hot loop must deliver the peak.`, prov: 'calc', status: eO.qPeakRatio <= p.heatPeak ? 'ok' : 'warn' },
      { label: 'Flywheel inertia for C_s, optimised', value: fO.J, unit: 'kg·m²', explain: `Inertia needed to keep speed fluctuation within ${f3(p.speedFluct * 100)} % (uniform ${f3(fU.J)}, simultaneous ${f3(fS.J)} kg·m²). Energy fluctuation ΔE = ${f3(fO.dE)} J per cycle.`, prov: 'calc' },
      { label: 'Peak radial bearing load from cell forces', value: Fr, unit: 'N', explain: `Vector sum of the tangential pulls of all cells at their rotor positions with the optimised firing order (sequential order ${f3(Fr0)} N).`, prov: 'calc' },
      { label: 'Minimum gap between hot-valve openings', value: eO.lat.minGap * P * 1000, unit: 'ms', explain: `Shortest time between two hot-valve openings in the schedule vs switching latency ${f3(p.latency * 1000)} ms.`, prov: 'calc', status: eO.lat.minGap * P >= p.latency - 1e-9 ? 'ok' : 'warn' },
    );
    // ---- verdicts ----
    out.verdicts.push(
      { test: 'Torque ripple within target', status: eO.s.pp <= p.rippleTarget ? 'pass' : 'warn', detail: `${f3(eO.s.pp * 100)} % vs target ${f3(p.rippleTarget * 100)} %.`, fix: `Add cells (uniform ripple with ${N + 2} cells: ${f3(ripN[Math.min(N + 1, ripN.length - 1)] * 100)} %), lengthen the power window (higher duty) or add flywheel inertia (${f3(fO.J)} kg·m² for ${f3(p.speedFluct * 100)} % speed fluctuation).` },
      { test: 'Hot-supply peak within limit', status: eO.qPeakRatio <= p.heatPeak + 1e-6 ? 'pass' : 'warn', detail: `Peak/mean ${f3(eO.qPeakRatio)} vs allowed ${f3(p.heatPeak)}.`, fix: 'Relax the limit, add hot-side buffer storage (Suite 09) or accept more torque ripple.' },
      { test: 'Valve-switching latency respected', status: eO.lat.pen === 0 ? 'pass' : 'warn', detail: `Minimum opening gap ${f3(eO.lat.minGap * P * 1000)} ms vs latency ${f3(p.latency * 1000)} ms (uniform offsets: ${f3(eU.lat.minGap * P * 1000)} ms).`, fix: 'Faster valves (Suite 13), fewer cells per distributor, or group cells on separate valve banks.' },
      { test: 'Continuous drive torque (≥ 1 cell always in power stroke)', status: minPower >= 1 ? 'pass' : 'warn', detail: `Minimum ${minPower} cell(s) in power stroke; power window ${f3(dur[1] / P * 100)} % of the cycle.`, fix: `Use at least ${Math.ceil(P / Math.max(dur[1], 1e-9))} cells or lengthen the power stroke.` },
      { test: 'Phasing creates no energy', status: invErr < 1e-3 ? 'pass' : 'fail', detail: `Mean torque differs by ${fmt(invErr * 100, 3)} % between schedules.`, fix: 'Refine the time sampling (expert “Time samples per cycle”).' },
      { test: 'Single-cell torque history evidence', status: 'info', detail: `Source: ${src}.`, fix: 'Import a measured single-cell torque history (CSV t, τ) from the instrumented rocker for calibration.' },
    );
    out.headline = `${N} cells, optimised offsets: torque ripple ${f3(eO.s.pp * 100)} % (uniform ${f3(eU.s.pp * 100)} %, simultaneous ${f3(eS.s.pp * 100)} %) at the same mean torque ${f3(eO.s.mean)} N·m; hot-supply peak ${f3(eO.qPeakRatio)}× mean.`;
    out.headlineKind = eO.s.pp <= p.rippleTarget && eO.qPeakRatio <= p.heatPeak + 1e-6 ? 'ok' : 'warn';
    // ---- charts ----
    const tg = range(M).map(k => k * dt), decK = Math.max(1, Math.floor(M / 160)), tc = tg.filter((_, k) => k % decK === 0);
    const cellRow = (y, ph) => tc.map((_, j) => samp(y, j * decK + ph * M));
    const stateF = Float64Array.from(state);
    out.charts.push({ type: 'heatmap', wide: true, title: 'Cell state map over one cycle (optimised schedule)', x: { label: 'Time in cycle', unit: 's', values: tc }, y: { label: 'Cell (firing sequence)', values: range(N).map(i => i + 1) }, z: byOffset.map(ci => tc.map((_, j) => stateF[Math.floor((((j * decK + phiOpt[ci] * M) % M) + M) % M)])), cmap: 'turbo', zmin: 0, zmax: 5, zlabel: '0 heat · 1 power · 2 isolate · 3 cool · 4 reset · 5 ready', explain: `Gantt-like map: each row is a cell (sorted by firing time), colour is its state — 0 heating, 1 power stroke, 2 isolation/valve switching, 3 cooling, 4 reset (re-extension), 5 ready. Durations: ${STATES.map((s, i) => `${s} ${f3(dur[i] * 1000)} ms`).join(', ')}.` });
    out.charts.push({ type: 'heatmap', title: 'Torque contribution per cell (optimised schedule)', x: { label: 'Time in cycle', unit: 's', values: tc }, y: { label: 'Cell (firing sequence)', values: range(N).map(i => i + 1) }, z: byOffset.map(ci => cellRow(tau1, phiOpt[ci])), cmap: 'inferno', zlabel: 'N·m', explain: 'Shaft torque each cell contributes through its one-way coupling at the operating speed; staggered bands overlap so the sum stays more even.' });
    out.charts.push({ type: 'line', wide: true, title: 'Total shaft torque: simultaneous vs uniform vs optimised', x: { label: 'Time in cycle', unit: 's' }, y: { label: 'Drive torque', unit: 'N·m' }, series: [{ name: 'All cells in phase', x: tg, y: Array.from(eS.T), dash: true }, { name: 'Uniform offsets', x: tg, y: Array.from(eU.T) }, { name: 'Optimised offsets', x: tg, y: Array.from(eO.T) }], annotations: [{ type: 'hline', y: eO.s.mean, label: `mean ${f3(eO.s.mean)} N·m (all schedules)` }], explain: 'Same cells, same mean: the three curves enclose the same area per cycle. Phasing only spreads the pushes in time, cutting the peaks the gearbox and flywheel must handle.' });
    out.charts.push({ type: 'line', title: 'Hot-supply heat demand and cells in power stroke', x: { label: 'Time in cycle', unit: 's' }, y: { label: 'Heat demand [kW] / cells [–]' }, series: [{ name: 'Hot demand, optimised (kW)', x: tg, y: Array.from(eO.Q).map(v => v / 1000) }, { name: 'Hot demand, simultaneous (kW)', x: tg, y: Array.from(eS.Q).map(v => v / 1000), dash: true }, { name: 'Cells in power stroke', x: tg, y: Array.from(pcO) }, { name: 'Hot valves open', x: tg, y: Array.from(hotCount), dash: true }], annotations: [{ type: 'hline', y: p.heatPeak * Qmean / 1000, label: 'allowed hot peak' }], explain: 'Instantaneous hot-fluid heat demand (sum of the wall heat fluxes of all hot cells) with the allowed peak, plus the number of cells pushing and the number of hot valves open.' });
    out.charts.push({ type: 'line', title: 'Torque ripple vs number of cells (uniform offsets)', x: { label: 'Cells N' }, y: { label: 'Ripple (peak-to-peak / mean)', unit: '%' }, series: [{ name: 'Uniform phasing', x: Ns, y: ripN.map(v => v * 100), mode: 'markers' }], annotations: [{ type: 'hline', y: p.rippleTarget * 100, label: 'target' }, { type: 'vline', x: N, label: 'design N' }], explain: 'Ripple falls as more evenly staggered cells share the cycle; dips occur where the power window is an integer multiple of P/N.' });
    out.charts.push({ type: 'bar', title: 'Schedule comparison', categories: ['Ripple p-p [%]', 'Ripple RMS [%]', 'Hot peak/mean ×100', 'Flywheel J ×100 [kg·m²]'], series: [{ name: 'Simultaneous', values: [eS.s.pp * 100, eS.s.rms * 100, eS.qPeakRatio * 100, fS.J * 100] }, { name: 'Uniform', values: [eU.s.pp * 100, eU.s.rms * 100, eU.qPeakRatio * 100, fU.J * 100] }, { name: 'Optimised', values: [eO.s.pp * 100, eO.s.rms * 100, eO.qPeakRatio * 100, fO.J * 100] }], explain: 'Side-by-side metrics of the three schedules (mean torque is identical and therefore not shown).' });
    if (hist.length) out.convergence = { title: 'Offset optimisation (best objective per generation)', series: [{ name: 'objective', x: range(hist.length), y: hist.map(v => Math.max(v, 1e-6)) }] };
    // ---- tables ----
    out.tables.push({ title: 'Firing schedule', cols: ['Firing #', 'Cell', 'Offset [fraction of P]', 'Offset [ms]', 'Rotor position', 'Hot valve opens [ms]', 'Hot valve closes [ms]'], rows: byOffset.map((ci, r) => [r + 1, ci + 1, f4(phiOpt[ci]), f4(phiOpt[ci] * P * 1000), pos[ci] + 1, f4(((1 - phiOpt[ci]) % 1) * P * 1000), f4(((1 - phiOpt[ci] + duty) % 1) * P * 1000)]), explain: 'Cell i is at phase time t + φᵢP, so its hot valve opens at (1 − φᵢ)P within the reference cycle. Rotor position is the slot (1…N) the cell occupies around the shaft.' });
    out.tables.push({ title: 'Single-cell hybrid state machine', cols: ['State', 'Duration [ms]', 'Fraction of cycle'], rows: STATES.map((s, i) => [s, f4(dur[i] * 1000), f3(dur[i] / P)]), explain: `Derived from the transient cell at ${f3(omega * 60 / TAU)} rpm (source: ${src}).` });
    // ---- explanation & recommendations ----
    out.explain.push(
      { title: 'Why the mean does not change', text: `Shifting a periodic torque history in time does not change its average. Each cell delivers ${f3(tauBar1)} N·m on average at ${f3(omega * 60 / TAU)} rpm, so ${N} cells deliver ${f3(N * tauBar1)} N·m (${f3(Pmean)} W) whatever the offsets. The schedule only decides when the pushes occur, which sets torque ripple, flywheel size, bearing load and hot-supply peaks.` },
      { title: 'What was optimised', text: `Differential evolution and Nelder–Mead searched ${N - 1} offsets (${nEval} schedule evaluations) for minimum ripple while keeping the hot-supply peak ≤ ${p.heatPeak}× mean and every valve-switching gap ≥ ${f3(p.latency * 1000)} ms. A swap search then reassigned rotor positions so simultaneously pushing cells pull on opposite sides of the shaft (${swaps} improving swaps; peak radial load ${f3(Fr0)} → ${f3(Fr)} N).` },
    );
    const maxDev = Math.max(...phiOpt.map((v, i) => Math.min(Math.abs(v - uniform[i]), 1 - Math.abs(v - uniform[i]))));
    out.explain.push({ title: 'Optimised vs uniform', text: maxDev < 1e-3 ? `For identical cells the uniform pattern (k/N) is already the ripple optimum; the constrained search returned it (largest deviation ${fmt(maxDev * P * 1000, 3)} ms) because no other schedule lowered ripple without breaking the hot-supply or latency limits${eU.qPeakRatio > p.heatPeak || eU.lat.pen > 0 ? ' — note the uniform schedule itself violates a limit, so the limit or the cell count must change' : ''}.` : `The optimised offsets deviate from uniform by up to ${f3(maxDev * P * 1000)} ms to satisfy the hot-supply peak (${f3(eO.qPeakRatio)}× vs ${p.heatPeak}×) and valve-latency limits, at a ripple of ${f3(eO.s.pp * 100)} % (uniform ${f3(eU.s.pp * 100)} %).` });
    out.recs.push(
      { level: eO.s.pp <= p.rippleTarget ? 'good' : 'warn', text: `Use the optimised offsets: ripple ${f3(eO.s.pp * 100)} % vs ${f3(eU.s.pp * 100)} % uniform; flywheel ${f3(fO.J)} kg·m² instead of ${f3(fS.J)} kg·m² for in-phase firing.`, basis: `C_s = ${p.speedFluct}, ω = ${f3(omega)} rad/s.` },
      { level: eO.qPeakRatio <= p.heatPeak ? 'info' : 'warn', text: `Size the hot loop for ${f3(eO.qPeakRatio * Qmean / 1000)} kW peak (mean ${f3(Qmean / 1000)} kW). In-phase firing would demand ${f3(eS.qPeakRatio * Qmean / 1000)} kW.`, basis: 'Hot-supply demand chart.' },
      { level: 'info', text: `Firing order around the rotor: ${firingOrder.join('–')} (positions in firing sequence).`, basis: `Peak radial bearing load ${f3(Fr)} N.` },
      { level: 'econ', text: `Smoother torque lets the flywheel shrink by ${f3(Math.max(0, fS.J - fO.J))} kg·m² relative to in-phase firing and lowers peak hot-pump capacity by ${f3(Math.max(0, (eS.qPeakRatio - eO.qPeakRatio) * Qmean / 1000))} kW — both are hardware cost reductions obtained purely by control timing.`, basis: 'Schedule comparison.' },
      { level: 'sustain', text: `A flatter hot-supply demand (${f3(eO.qPeakRatio)}× mean) lets a waste-heat or solar source with limited instantaneous capacity run the engine without a peaking heater, avoiding auxiliary fuel use.`, basis: `Mean hot demand ${f3(Qmean)} W.` },
    );
    // ---- animation ----
    const Ttot = Array.from(eO.T), tgA = tg;
    out.views.push({ label: 'Phased array animation', icon: '⏱', render: async (el) => {
      const { anim2d, at, lerp, seriesPanel, theme } = await import('../core/anim2d.js');
      const cols = ['#f59e0b', '#22c55e', '#a855f7', '#38bdf8', '#64748b', '#1e293b'];
      anim2d(el, { duration: 2 * P, label: 'Time', unit: 's', height: 460, explain: 'Rotor with cells in their firing positions: colour = heated (red) or cold (blue), green arrows = torque of cells in their power stroke. Lower panel: Gantt strip of every cell state with a sweeping cursor; right: total torque.', draw: (g, t, W, Hh) => {
        const th = theme(), tt = t % P, kk = Math.floor(tt / dt) % M, ang = omega * t;
        const st = range(N).map(i => state[Math.floor((((kk + phiOpt[i] * M) % M) + M) % M)]);
        const tq = range(N).map(i => samp(tau1, kk + phiOpt[i] * M));
        const slot = range(N).map(r => byOffset.find(ci => pos[ci] === r));
        drawRotor(g, { cx: W * 0.22, cy: Hh * 0.32, r: Math.min(W * 0.11, Hh * 0.15), theta: ang, N, act: slot.map(ci => tq[ci] / (tMax1 || 1)), tau: slot.map(ci => tq[ci]), tauMax: tMax1, heat: slot.map(ci => st[ci] <= 1 || (st[ci] === 2 && ((kk + phiOpt[ci] * M) % M) < nHot) ? 1 : 0), label: '', th });
        const gx = 10, gy = Hh * 0.62, gw = W - 20, gh = Hh * 0.36, rh = gh / N;
        for (let r = 0; r < N; r++) { const ci = byOffset[r]; for (let j = 0; j < 160; j++) { const k = Math.floor(j / 160 * M), s = state[Math.floor((((k + phiOpt[ci] * M) % M) + M) % M)]; g.fillStyle = cols[s]; g.fillRect(gx + j / 160 * gw, gy + r * rh, gw / 160 + 0.5, rh - 1); } }
        g.strokeStyle = th.fg; g.beginPath(); g.moveTo(gx + tt / P * gw, gy); g.lineTo(gx + tt / P * gw, gy + gh); g.stroke();
        g.font = '10px Inter,system-ui,sans-serif'; STATES.forEach((s, i) => { g.fillStyle = cols[i]; g.fillRect(W * 0.45 + (i % 3) * W * 0.18, Hh * 0.52 + Math.floor(i / 3) * 13, 10, 8); g.fillStyle = th.fg; g.fillText(s, W * 0.45 + (i % 3) * W * 0.18 + 14, Hh * 0.52 + Math.floor(i / 3) * 13 + 8); });
        seriesPanel(g, { x: W * 0.45, y: 8, w: W * 0.53, h: Hh * 0.42, T: tgA, series: [{ name: 'Σ τ optimised', y: Ttot, color: '#22c55e' }], t: tt, title: 'Total drive torque', unit: 'N·m', hlines: [{ y: eO.s.mean, label: 'mean', color: '#ef4444' }] });
        void at; void lerp;
      } });
    } });
    out.outputs = { nCells: N, offsets: phiOpt.map(v => +v.toFixed(5)), torqueRipple: eO.s.pp, meanTorque_Nm: eO.s.mean, firingOrder, dutyHot: duty, torqueRippleUniform: eU.s.pp, hotPeakRatio: eO.qPeakRatio, flywheelJ_kgm2: fO.J, cellsInPowerMin: minPower };
    return out;
  },
};
