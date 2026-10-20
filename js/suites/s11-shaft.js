// Suite 11 — Shaft coupling and torque transmission.
// Reduced-order multibody drivetrain: each cell is a thermally driven, force-limited contraction source in series with
// its ribbon/carriage compliance; a one-way coupling (sprag clutch + rocker, cam follower or cable/pulley) transmits
// only pulling force; the common shaft obeys J dω/dt = Σ τ_i − τ_load − τ_friction (Newton–Euler, RK4).
// The cell-drive builder and the shaft integrator are exported for Suites 12 and 15.
import { linspace, range, mean, std, clamp, rk4, rk45, fmt, interp1 } from '../core/num.js';
import { get as getMat } from '../core/materials.js';
import { cellFromDesign } from '../core/sma.js';

const TAU = 2 * Math.PI;
// headless-safe cooperative yield (ctx.yield relies on requestAnimationFrame)
export const pause = (ctx) => (typeof requestAnimationFrame === 'function' && ctx?.yield ? ctx.yield() : Promise.resolve());
const f3 = (v) => fmt(v, 3), f4 = (v) => fmt(v, 4);

// ---------------- shared reduced-order cell drive ----------------
// From one periodic cell history build: free (thermally available) carriage contraction x_f(t), force capacity F_c(t)
// (load-carrying force above the bias, only from first engagement to the end of the hot phase), and dx_f/dt.
export function buildDrive({ P, F, x, eng, Fb, duty, spc, Wref = 0 }) {
  const dt = P / spc, nHot = clamp(Math.round(duty * spc), 2, spc - 2), Fav = new Float64Array(spc), xw = new Float64Array(spc);
  for (let i = 0; i < spc; i++) Fav[i] = Math.max(0, F[i] - Fb[i]);
  let on = -1, sF = 0, nF = 0;
  for (let i = 1; i < nHot; i++) { const dx = x[i] - x[i - 1]; xw[i] = xw[i - 1] + (eng[i] && dx > 0 ? dx : 0); if (eng[i]) { if (on < 0) on = i; sF += Fav[i]; nF++; } }
  const xwMax = xw[nHot - 1], x0 = x[nHot], xe = x[spc - 1]; let r = 1;
  for (let i = nHot; i < spc; i++) { r = Math.min(r, clamp((x[i] - xe) / ((x0 - xe) || 1e-12), 0, 1)); xw[i] = xwMax * (i === spc - 1 ? 0 : r); }
  // the transient solver advances a loaded ribbon in stall/slip bursts; a periodic moving average (≈ P/25) removes that
  // numerical staircase from the free-contraction profile while keeping it monotone in each phase and periodic
  { const wdt = Math.max(1, Math.round(spc / 50)), src = Float64Array.from(xw); for (let i = 0; i < spc; i++) { let a = 0; for (let k = -wdt; k <= wdt; k++) a += src[(i + k + spc) % spc]; xw[i] = a / (2 * wdt + 1); } }
  const Fload = Wref > 0 && xwMax > 0 ? Wref / xwMax : nF ? sF / nF : 0, Fc = new Float64Array(spc), vf = new Float64Array(spc);
  for (let i = 0; i < spc; i++) { Fc[i] = on >= 0 && i >= on && i < nHot ? Fload : 0; vf[i] = (xw[(i + 1) % spc] - xw[i]) / dt; }
  const tOn = on >= 0 ? on * dt : NaN, tWin = on >= 0 ? (nHot - on) * dt : 0;
  return { P, spc, dt, nHot, xf: xw, Fc, vf, Fload, xwMax, Wcell: Fload * xwMax, tOn, tWin, vMean: tWin > 0 ? xwMax / tWin : 0, vPeak: Math.max(...vf) };
}
// Scale a drive through a compliant transmission of displacement amplification A and efficiency η (F·d·η conserved)
export function scaleDrive(dr, A = 1, eta = 1) {
  const s = { ...dr, xf: dr.xf.map(v => v * A), vf: dr.vf.map(v => v * A), Fc: dr.Fc.map(v => v * eta / A) };
  s.Fload = dr.Fload * eta / A; s.xwMax = dr.xwMax * A; s.Wcell = s.Fload * s.xwMax; s.vMean = dr.vMean * A; s.vPeak = dr.vPeak * A; return s;
}
// Periodic lookup at phase time τ (s): writes {xf, fc, vf} into o
export function driveLookup(dr, tau, o) {
  const P = dr.P, n = dr.spc; let q = (tau % P + P) % P / dr.dt; const i = Math.floor(q) % n, f = q - Math.floor(q), j = (i + 1) % n;
  o.xf = dr.xf[i] + (dr.xf[j] - dr.xf[i]) * f; o.fc = dr.Fc[i] + (dr.Fc[j] - dr.Fc[i]) * f; o.vf = dr.vf[i]; return o; // v_f is the exact slope of the interpolated x_f; F_c ramps over one table step (valve switching is not instantaneous)
}
// Cell drive for a design: always runs the transient cell (thermal states, heat demand); mechanics from Suite 05's
// force history when published (coupled), otherwise from the transient itself (calc).
export function cellDrive(ctx, d, { spc = 200, n = 3, cycles = 3, over = {}, useUpstream = true } = {}) {
  const mat = getMat(d.alloy) || getMat('niti-lt');
  const cell = cellFromDesign(mat, d, { n, stepsPerCycle: spc, cycles, ...over });
  const P = 1 / d.freq, H = cell.hist, A = cell.area, duty = over.dutyHot ?? d.dutyHot;
  let drive = buildDrive({ P, F: H.F, x: H.x, eng: H.engaged.map(v => v > 0), Fb: H.eps.map(e => ((over.sBias0 ?? d.sigmaL) + d.kBias * (cell.eps0 - e)) * 1e6 * A), duty, spc, Wref: cell.Wout });
  let src = 'Transient ribbon-cell solver (sma.cellFromDesign)', prov = 'calc';
  const s05 = useUpstream ? ctx?.upstream?.('s05') : null, fh = s05?.forceHistory;
  if (fh?.t?.length > 20 && fh.F?.length === fh.t.length && fh.x?.length === fh.t.length) {
    const Pu = s05.cycleTime_s || (s05.freq_Hz ? 1 / s05.freq_Hz : P), t0 = fh.t[0], ts = fh.t.map(t => t - t0);
    const g = range(spc).map(i => i * Pu / spc), F = g.map(t => interp1(ts, fh.F, t)), x = g.map(t => interp1(ts, fh.x, t));
    const Fb0 = Math.min(...F), Fmax = Math.max(...F), eng = F.map(v => v - Fb0 > 0.05 * (Fmax - Fb0));
    let dr = buildDrive({ P: Pu, F, x, eng, Fb: F.map(() => Fb0), duty, spc });
    if (s05.Wout_J > 0 && dr.Wcell > 0) { const k = s05.Wout_J / dr.Wcell; dr = { ...dr, Fc: dr.Fc.map(v => v * k), Fload: dr.Fload * k, Wcell: s05.Wout_J }; }
    if (dr.Wcell > 0) { drive = dr; src = 'Suite 05 force–stroke history (resampled; work scaled to its W_out)'; prov = 'coupled'; }
  }
  return { cell, drive, src, prov, mat };
}
// Ribbon (series) stiffness seen at the carriage, austenite modulus
export const ribbonStiffness = (mat, d, cell) => mat.EA * 1e9 * cell.area / d.ribbonL;

// ---------------- shaft integrator (Newton–Euler, RK4 with frozen carriage states per step) ----------------
// opts: N, drive(i, t, o) → {xf, fc, vf}, R(θ) effective radius (m/rad), eta, ks, cs, J, tauC, cVisc, tauS, tauDrag, load(ω,t),
// t0, t1, h, omega0, record (decimation), recCellsFrom (time after which per-cell torques are stored), stop(t, y, stuck) → true ends early
export function simulateShaft(o) {
  const N = o.N, J = o.J, eta = o.eta, ks = o.ks, cs = o.cs ?? 0, wEps = o.wEps ?? 1e-3, R = o.R, tmp = { xf: 0, fc: 0, vf: 0 };
  // state y = [θ, ω, W_in, W_load, W_friction, W_gear, x_c,1 … x_c,N]. A cell whose one-way coupling is engaged at the start of
  // a step (δ = x_f − x_c > 0, or δ = 0 with the ribbon outrunning the shaft) moves its carriage with the shaft (dx_c/dt = R·ω,
  // δ evaluated exactly from the interpolated x_f); a slack cell is glued to its ribbon end and re-synchronised exactly after the step
  let stuck = (o.omega0 ?? 0) <= 0;
  const eng = new Uint8Array(N);
  const cellF = (i, t, y, w, r) => { o.drive(i, t, tmp); const dl = tmp.xf - y[6 + i]; return eng[i] && tmp.fc > 0 && dl > 0 ? clamp(ks * dl + cs * (tmp.vf - r * w), 0, tmp.fc) : 0; };
  const classify = (t, y) => { const r = R(y[0]), w = stuck ? 0 : y[1]; for (let i = 0; i < N; i++) { o.drive(i, t, tmp); const dl = tmp.xf - y[6 + i]; eng[i] = tmp.fc > 0 && (dl > 1e-12 || tmp.vf > r * w) ? 1 : 0; } };
  const fric = (w, idle) => o.tauC * Math.tanh(w / wEps) + o.cVisc * w + idle * o.tauDrag * Math.tanh(w / wEps);
  const dy = new Array(6 + N).fill(0);
  const eval_ = (t, y) => {
    const w = stuck ? 0 : y[1], r = R(y[0]); let tq = 0, idle = 0;
    for (let i = 0; i < N; i++) { o.drive(i, t, tmp); const dl = tmp.xf - y[6 + i], e = eng[i] && tmp.fc > 0 && dl > 0; const F = e ? clamp(ks * dl + cs * (tmp.vf - r * w), 0, tmp.fc) : 0; if (F > 0) tq += F * r * eta; else idle++; dy[6 + i] = eng[i] ? r * w : 0; }
    return { tq, idle, w };
  };
  const f = (t, y) => {
    const d = eval_(t, y), out = dy.slice();
    if (stuck) { out[0] = out[1] = out[2] = out[3] = out[4] = out[5] = 0; return out; }
    const w = y[1], tl = o.load(w, t), tf = fric(w, d.idle);
    let a = (d.tq - tl - tf) / J; if (w <= 0 && a < 0) a = 0;
    out[0] = w; out[1] = a; out[2] = d.tq * w; out[3] = tl * w; out[4] = tf * w; out[5] = d.tq * w * (1 - eta) / Math.max(eta, 1e-9); return out;
  };
  // stability/accuracy guard: resolve the stiffest ribbon–rotor mode (all cells engaged) with ≥ 18 steps per period
  const wMode = Math.sqrt(N * ks * (1.7 * R(0)) ** 2 / J), hMax = wMode > 0 ? 0.35 / wMode : o.h;
  const n = Math.ceil((o.t1 - o.t0) / Math.min(o.h, hMax)), h = (o.t1 - o.t0) / n, rec = Math.max(1, Math.round((o.record ?? 1) * o.h / h));
  let y = [o.theta0 ?? 0, o.omega0 ?? 0, 0, 0, 0, 0, ...range(N).map(i => { o.drive(i, o.t0, tmp); return o.xc0 ? o.xc0[i] : tmp.xf; })], t = o.t0;
  const H = { t: [], omega: [], theta: [], tq: [], tl: [], tf: [], cellT: [], cellTau: [], engaged: [] }, KE0 = 0.5 * J * y[1] ** 2;
  const store = (t, y) => {
    const d = eval_(t, y), w = y[1]; H.t.push(t); H.omega.push(w); H.theta.push(y[0]); H.tq.push(d.tq); H.tl.push(o.load(w, t)); H.tf.push(stuck ? 0 : fric(w, d.idle)); H.engaged.push(N - d.idle);
    if (o.recCellsFrom !== undefined && t >= o.recCellsFrom) { const r = R(y[0]); H.cellT.push(t); H.cellTau.push(range(N).map(i => cellF(i, t, y, w, r) * r * eta)); }
  };
  classify(t, y); store(t, y);
  for (let k = 0; k < n; k++) {
    if (stuck) { const was = stuck; stuck = false; const d = eval_(t, [y[0], 0, ...y.slice(2)]); stuck = was; if (d.tq - o.load(0, t) > o.tauS) stuck = false; }
    classify(t, y); const y1 = rk4(f, t, y, t + h, 1).y[1]; t += h;
    if (y1[1] < 0) y1[1] = 0; // anti-reverse backstop
    if (!stuck && y1[1] === 0) { stuck = true; const d = eval_(t, y1); stuck = false; if (d.tq - o.load(0, t) <= o.tauS) stuck = true; }
    for (let i = 0; i < N; i++) { o.drive(i, t, tmp); if (!eng[i] || tmp.fc <= 0 || y1[6 + i] > tmp.xf) y1[6 + i] = tmp.xf; } // slack / no capacity ⇒ carriage at the ribbon end; never ahead of it
    classify(t, y1);
    y = y1; if (o.onStep) o.onStep(t, y);
    const halt = o.stop ? o.stop(t, y, stuck) : false;
    if ((k + 1) % rec === 0 || k === n - 1 || halt) store(t, y);
    if (halt) break;
  }
  const KE1 = 0.5 * J * y[1] ** 2;
  return { H, Win: y[2], Wload: y[3], Wfric: y[4], Wgear: y[5], KE0, KE1, theta: y[0], omega: y[1], xc: y.slice(6), steps: n, h };
}
// Steady single-cell torque profile and mean at constant shaft speed ω (two periods, second recorded)
export function constantSpeedCell(dr, { omega, R, eta, ks, cs = 0, steps = 0 }) {
  const n = steps || dr.spc, P = dr.P, h = P / n, o = { xf: 0, fc: 0, vf: 0 }, tau = new Float64Array(n), F = new Float64Array(n);
  driveLookup(dr, 0, o); let xc = o.xf;
  for (let c = 0; c < 2; c++) for (let k = 0; k < n; k++) {
    const t = k * h; driveLookup(dr, t, o);
    const Fk = o.fc > 0 ? clamp(ks * (o.xf - xc) + cs * (o.vf - R * omega), 0, o.fc) : 0;
    if (c === 1) { F[k] = Fk; tau[k] = Fk * R * eta; }
    driveLookup(dr, t + h, o); xc = o.fc > 0 ? Math.min(xc + R * omega * h, o.xf) : o.xf;
  }
  let s = 0; for (let k = 0; k < n; k++) s += tau[k]; return { tau, F, mean: s / n, t: range(n).map(k => k * h) };
}
// Effective radius (carriage metres per shaft radian) for a gear ratio G (shaft speed / rocker speed)
export const effRadius = (rArm_mm, G) => rArm_mm / 1000 / Math.max(G, 1e-6);
// Design-speed gear ratio: mean power-stroke carriage speed equals R·ω_design
export const designGear = (dr, rArm_mm, omegaD) => clamp(rArm_mm / 1000 * omegaD / Math.max(dr.vMean, 1e-9), 0.2, 500);

// ---------------- shared rotor drawing (Suites 11, 12, 15 animations) ----------------
export function drawRotor(g, { cx, cy, r, theta, N, act = [], tau = [], tauMax = 1, heat = [], label, th }) {
  g.save(); g.strokeStyle = th.grid; g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.stroke();
  g.fillStyle = th.bg2; g.beginPath(); g.arc(cx, cy, r * 0.32, 0, TAU); g.fill(); g.stroke();
  g.strokeStyle = th.accent; g.lineWidth = 3; for (let k = 0; k < 3; k++) { const a = theta + k * TAU / 3; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95); g.stroke(); }
  for (let i = 0; i < N; i++) {
    const a = i * TAU / N - Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a), r0 = r * 1.12, r1 = r * 1.12 + r * 0.55 * (1 - 0.35 * clamp(act[i] ?? 0, 0, 1));
    const hc = clamp(heat[i] ?? 0, 0, 1); g.strokeStyle = `rgb(${Math.round(60 + 195 * hc)},${Math.round(130 - 60 * hc)},${Math.round(240 - 200 * hc)})`; g.lineWidth = 6;
    g.beginPath(); g.moveTo(cx + ca * r0, cy + sa * r0); g.lineTo(cx + ca * r1, cy + sa * r1); g.stroke();
    const tq = tau[i] ?? 0; if (tq > 1e-9) { const L = 8 + 40 * clamp(tq / (tauMax || 1), 0, 1.5), px = cx + ca * r, py = cy + sa * r; g.lineWidth = 2.5; g.strokeStyle = g.fillStyle = '#22c55e'; g.beginPath(); g.moveTo(px, py); const ex = px - sa * L, ey = py + ca * L; g.lineTo(ex, ey); g.stroke(); const ang = Math.atan2(ey - py, ex - px); g.beginPath(); g.moveTo(ex, ey); g.lineTo(ex - 8 * Math.cos(ang - 0.4), ey - 8 * Math.sin(ang - 0.4)); g.lineTo(ex - 8 * Math.cos(ang + 0.4), ey - 8 * Math.sin(ang + 0.4)); g.closePath(); g.fill(); }
    g.fillStyle = th.mute; g.font = '10px Inter,system-ui,sans-serif'; g.fillText(String(i + 1), cx + ca * (r1 + 10) - 4, cy + sa * (r1 + 10) + 4);
  }
  if (label) { g.fillStyle = th.fg; g.font = '12px Inter,system-ui,sans-serif'; g.fillText(label, cx - r, cy + r * 1.95); }
  g.restore();
}

const COUPLINGS = [{ value: 'sprag', label: 'One-way sprag clutch + rocker (preferred laboratory option)' }, { value: 'cam', label: 'Cam follower (roller follower on a multi-lobe cam)' }, { value: 'cable', label: 'Cable / pulley with one-way hub' }];

export default {
  description: 'Converts the intermittent pulling force of every cell into common-shaft torque through a positively modelled one-way coupling, gearing, bearings and flywheel, and integrates the shaft equation of motion over many cycles to steady state. Reports torque per cell and in total, torque ripple, mean shaft power, the full mechanical-loss breakdown, transmission efficiency, the speed–load performance map, coast-down and starting torque — with an explicit energy balance.',
  literature: 'shape memory alloy heat engine one-way clutch torque transmission flywheel drivetrain dynamics',
  econ: true, sustain: true, credibility: 'Analytical screening',
  equations: [
    'Shaft (Newton–Euler): J dω/dt = Σᵢ τᵢ − τ_load(ω) − τ_friction(ω),   J = J_rotor + J_flywheel',
    'Cell force through the one-way coupling: Fᵢ = clip(k_s·(x_f,i(t) − x_c,i) + c_s·(v_f,i − R·ω), 0, F_c,i(t))  (tension only: the clutch overruns when the shaft outruns the carriage)',
    'Carriage kinematics while engaged: dx_c/dt = R·ω,  R = r_arm/G (sprag/cable),  R(θ) = R₀(1 + a·sin(n_lobe·θ)) (cam)',
    'Cell torque at the shaft: τᵢ = η_c·η_g·Fᵢ·R;  shaft power P = τ·ω (gearing trades torque for speed, never creates power)',
    'Friction: τ_f = τ_C·tanh(ω/ω_ε) + c_v·ω + n_idle·τ_drag·tanh(ω/ω_ε); breakaway when Σ τᵢ − τ_load(0) > τ_static',
    'Load: τ_L = τ_L0 (constant), τ_Ld·ω/ω_d (linear), τ_Ld·(ω/ω_d)² (pump/fan-like)',
    'Energy balance: ∫Στᵢω dt = ΔKE + ∫τ_L ω dt + ∫τ_f ω dt;   cell work into coupling = ∫Στᵢω dt / (η_c η_g)',
    'Metamaterial (Suite 10): x_out = A·x_in, F_out = η_m·F_in/A, k_out = k_in/A²  (displacement amplification is not work gain)',
    'Coast-down: J dω/dt = −τ_C − c_v ω  ⇒  ω(t) = (ω₀ + τ_C/c_v)e^{−c_v t/J} − τ_C/c_v,  t_stop = (J/c_v)·ln(1 + c_v ω₀/τ_C)',
  ],
  methods: [
    'Single-cell periodic force–stroke history from the transient ribbon-cell solver (sma.cellFromDesign) or Suite 05; force capacity and free carriage contraction extracted per time step',
    'Explicit RK4 (num.rk4) on (θ, ω, energy accumulators) with per-step frozen carriage states and post-step complementarity update of each carriage (operator splitting); stiction and anti-reverse backstop as hybrid events',
    'Integration from rest over many cycles until cycle-mean speed changes < 0.5 % over three cycles; steady metrics over the last cycles',
    'Quasi-steady constant-speed cycle averages for the torque–speed characteristic and the gear-ratio × speed performance map',
    'Time-step refinement (h, h/2, h/4) with observed order and GCI; coast-down verified against the closed-form solution (num.rk45)',
  ],
  assumptions: [
    'Rigid shaft and gears; ribbon/carriage compliance lumped as one series spring per cell (austenite modulus), damping by a modal ratio',
    'Cell force capacity and free contraction are taken from the periodic steady single-cell cycle (shaft load feedback on the ribbon thermodynamics is not re-solved here — Suite 14 closes that loop)',
    'Identical cells; phase offsets uniform unless Suite 12 has published optimised offsets',
    'One-way clutches modelled as ideal tension-only contacts with a constant overrunning drag; engagement lost motion neglected',
    'Cam coupling reduced to a lobe-modulated effective radius with guide-friction efficiency; cable modelled as an extra series spring',
  ],
  ibc: {
    initial: ['Shaft at rest (θ = 0, ω = 0), carriages at the free-contraction position of their phase, flywheel unloaded', 'Cell phase offsets from Suite 12 or uniform'],
    boundary: ['Periodic cell force capacity and free contraction (Suite 05 or transient cell)', 'Load torque–speed law at the output flange', 'Bearing friction (static, Coulomb, viscous) and clutch drag', 'Anti-reverse backstop on the shaft'],
  },
  cvv: {
    calibration: ['Bearing and freewheel drag torque from coast-down tests', 'Clutch engagement and series stiffness from static stall tests on an instrumented rocker', 'Load curve from the dynamometer controller'],
    verification: ['Closed energy balance of the shaft (work in = ΔKE + load + friction)', 'Time-step convergence (three levels, GCI)', 'Coast-down vs closed-form solution', 'Quasi-steady speed vs dynamic steady speed', 'Transmission efficiency ≤ 1 (no energy creation)'],
    validation: ['Instrumented drivetrain: in-line torque transducer, encoder speed, coast-down and stall tests (spec Module 11)'],
  },
  formats: { import: ['CSV torque/speed logs (t, τ, ω)', 'CSV dynamometer load curve', 'JSON drivetrain parameters'], export: ['CSV speed/torque histories', 'CSV performance map', 'PNG/SVG plots', 'JSON coupling outputs'] },
  params: [
    { key: 'coupling', label: 'Coupling type', type: 'select', options: COUPLINGS, default: 'sprag', group: 'Coupling', help: 'All options transmit tension only, so a resetting cell never drives the shaft backwards.' },
    { key: 'rArm', label: 'Rocker arm / pulley / base-circle radius', unit: 'mm', type: 'number', min: 2, max: 200, step: 1, default: 20, group: 'Coupling' },
    { key: 'gearMode', label: 'Gear ratio selection', type: 'select', options: [{ value: 'design', label: 'Match the design shaft speed (computed)' }, { value: 'manual', label: 'Manual' }], default: 'design', group: 'Coupling' },
    { key: 'gear', label: 'Gear ratio G (shaft / rocker speed), manual', type: 'number', min: 0.2, max: 500, step: 0.1, default: 12, group: 'Coupling' },
    { key: 'etaGear', label: 'Gear-train efficiency', type: 'range', min: 0.8, max: 1, step: 0.005, default: 0.97, group: 'Coupling' },
    { key: 'etaClutch', label: 'Clutch / roller / cable efficiency', type: 'range', min: 0.8, max: 1, step: 0.005, default: 0.98, group: 'Coupling' },
    { key: 'camAmp', label: 'Cam radius modulation a', type: 'range', min: 0, max: 0.6, step: 0.01, default: 0.25, group: 'Coupling', expert: true },
    { key: 'camLobes', label: 'Cam lobes', type: 'number', min: 1, max: 8, step: 1, default: 2, group: 'Coupling', expert: true },
    { key: 'pressureAngle', label: 'Cam pressure angle', unit: '°', type: 'number', min: 0, max: 40, step: 1, default: 20, group: 'Coupling', expert: true },
    { key: 'mu', label: 'Guide / follower friction coefficient', type: 'number', min: 0, max: 0.4, step: 0.01, default: 0.05, group: 'Coupling' },
    { key: 'kCable', label: 'Cable stiffness', unit: 'kN/m', type: 'number', min: 10, max: 20000, step: 10, default: 800, group: 'Coupling', expert: true },
    { key: 'amplification', label: 'Metamaterial displacement amplification A', type: 'number', min: 0.2, max: 20, step: 0.01, default: 1, group: 'Metamaterial', auto: (c) => { const o = c.upstream('s10'); return o?.amplification > 0 ? { value: +o.amplification.toFixed(3), prov: 'coupled' } : undefined; }, help: 'From Suite 10. A = 1 is a direct ribbon-to-rocker connection.' },
    { key: 'metaEff', label: 'Metamaterial transmission efficiency η_m', type: 'range', min: 0.3, max: 1, step: 0.005, default: 0.98, group: 'Metamaterial', auto: (c) => { const o = c.upstream('s10'); return o?.transEff > 0 ? { value: +o.transEff.toFixed(4), prov: 'coupled' } : undefined; } },
    { key: 'nCells', label: 'Number of cells on the shaft', type: 'number', min: 1, max: 96, step: 1, default: 12, group: 'Array', auto: (c) => ({ value: c.engine.nCells, prov: 'calc' }) },
    { key: 'phasing', label: 'Cell phase offsets', type: 'select', options: [{ value: 'uniform', label: 'Uniform (k/N of the period)' }, { value: 's12', label: 'Optimised offsets from Suite 12' }], default: 'uniform', group: 'Array', auto: (c) => { const o = c.upstream('s12'); return o?.offsets?.length ? { value: 's12', prov: 'coupled' } : undefined; } },
    { key: 'rpm', label: 'Design shaft speed', unit: 'rpm', type: 'number', min: 1, max: 3000, step: 1, default: 60, group: 'Shaft & load', auto: (c) => ({ value: c.engine.rpm, prov: 'calc' }) },
    { key: 'J', label: 'Rotor + shaft inertia', unit: 'kg·m²', type: 'number', min: 1e-4, max: 50, step: 0.001, default: 0.02, group: 'Shaft & load', auto: (c) => { const o = c.upstream('s02'); return o?.rotorInertia_kgm2 > 0 ? { value: +o.rotorInertia_kgm2.toPrecision(4), prov: 'coupled' } : undefined; } },
    { key: 'Jfly', label: 'Added flywheel inertia', unit: 'kg·m²', type: 'number', min: 0, max: 50, step: 0.01, default: 0.5, group: 'Shaft & load', help: 'Smooths speed; stores and returns energy, never creates it.' },
    { key: 'tauC', label: 'Bearing Coulomb friction torque', unit: 'N·m', type: 'number', min: 0, max: 5, step: 0.001, default: 0.08, group: 'Shaft & load', auto: (c) => ({ value: +(c.engine.bearingLoss / Math.max(1e-6, c.engine.rpm * TAU / 60)).toPrecision(3), prov: 'calc' }), help: 'Derived from the engine bearing loss at design speed.' },
    { key: 'cVisc', label: 'Viscous friction coefficient', unit: 'N·m·s/rad', type: 'number', min: 0, max: 1, step: 0.0005, default: 0.002, group: 'Shaft & load' },
    { key: 'staticFactor', label: 'Static / Coulomb friction ratio', type: 'number', min: 1, max: 4, step: 0.1, default: 1.5, group: 'Shaft & load' },
    { key: 'tauDrag', label: 'Overrunning-clutch drag (each)', unit: 'N·m', type: 'number', min: 0, max: 0.2, step: 0.001, default: 0.004, group: 'Shaft & load' },
    { key: 'loadType', label: 'Load torque–speed law', type: 'select', options: [{ value: 'quadratic', label: 'Quadratic (pump / fan)' }, { value: 'linear', label: 'Linear (generator into a resistor)' }, { value: 'constant', label: 'Constant (hoist / brake)' }], default: 'quadratic', group: 'Shaft & load' },
    { key: 'loadMode', label: 'Load sizing', type: 'select', options: [{ value: 'match', label: 'Matched to the maximum-power point (computed)' }, { value: 'manual', label: 'Manual torque at design speed' }], default: 'match', group: 'Shaft & load' },
    { key: 'loadTorque', label: 'Load torque at design speed (manual)', unit: 'N·m', type: 'number', min: 0, max: 500, step: 0.01, default: 1.5, group: 'Shaft & load' },
    { key: 'zeta', label: 'Ribbon/carriage damping ratio', type: 'number', min: 0, max: 1, step: 0.01, default: 0.15, group: 'Solver', expert: true },
    { key: 'mCarriage', label: 'Carriage + rocker moving mass (per cell)', unit: 'kg', type: 'number', min: 0.001, max: 5, step: 0.001, default: 0.05, group: 'Coupling', expert: true },
    { key: 'spc', label: 'Shaft time steps per cycle', type: 'number', min: 60, max: 2000, step: 20, default: 160, group: 'Solver', expert: true },
    { key: 'cellSpc', label: 'Cell-solver steps per cycle', type: 'number', min: 80, max: 600, step: 20, default: 200, group: 'Solver', expert: true },
    { key: 'minCycles', label: 'Minimum simulated cycles', type: 'number', min: 5, max: 200, step: 1, default: 15, group: 'Solver', expert: true },
    { key: 'maxCycles', label: 'Maximum simulated cycles', type: 'number', min: 10, max: 400, step: 5, default: 80, group: 'Solver', expert: true },
  ],
  presets: [
    { label: 'Laboratory sprag + flywheel (pump load)', values: { coupling: 'sprag', loadType: 'quadratic', Jfly: 0.5 } },
    { label: 'Cam follower, constant brake load', values: { coupling: 'cam', loadType: 'constant' } },
    { label: 'Cable drive, light flywheel', values: { coupling: 'cable', Jfly: 0.1 } },
    { label: 'Over-geared (G × 2)', values: { gearMode: 'manual', gear: 30 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const d = ctx.engine, N = Math.max(1, Math.round(p.nCells)), omegaD = p.rpm * TAU / 60;
    ctx.progress(0.05, 'Cell force–stroke history');
    const { cell, drive: dr0, src, prov, mat } = cellDrive(ctx, d, { spc: p.cellSpc });
    await pause(ctx);
    const A = p.amplification || 1, dr = scaleDrive(dr0, A, p.metaEff);
    const kRib = ribbonStiffness(mat, d, cell), kCable = p.kCable * 1e3;
    let ks = kRib / (A * A); if (p.coupling === 'cable') ks = 1 / (1 / ks + 1 / kCable);
    const etaCam = p.coupling === 'cam' ? clamp(1 - 2 * p.mu * Math.tan(p.pressureAngle * Math.PI / 180), 0.3, 1) : 1;
    const eta = p.etaGear * p.etaClutch * etaCam, Jtot = p.J + p.Jfly, cs = 2 * p.zeta * Math.sqrt(ks * p.mCarriage); // ribbon/carriage internal damping
    let G = p.gearMode === 'manual' ? p.gear : designGear(dr, p.rArm, omegaD), R0 = effRadius(p.rArm, G);
            const offsets = p.phasing === 's12' && ctx.upstream('s12')?.offsets?.length === N ? ctx.upstream('s12').offsets.map(Number) : range(N).map(i => i / N);
    const drv = (i, t, o) => driveLookup(dr, t + offsets[i] * dr.P, o);
    const P = dr.P, tauS = p.tauC * p.staticFactor;
    // ---- quasi-steady torque–speed characteristic (offset-independent mean) ----
    const qs = (omega, R = R0) => N * constantSpeedCell(dr, { omega, R, eta, ks, cs }).mean;
    const fricMean = (w) => p.tauC + p.cVisc * w;
    const charAt = (R) => { const ws = linspace(0, 3 * dr.vMean / R, 61), tq = ws.map(w => qs(w, R)), tnet = tq.map((v, k) => v - (k ? fricMean(ws[k]) + N * p.tauDrag * 0.5 : 0)); let kS = 0; for (let k = 1; k < ws.length; k++) if (tnet[k] * ws[k] > tnet[kS] * ws[kS]) kS = k; return { ws, tq, tnet, wStar: ws[kS], tStar: Math.max(0, tnet[kS]) }; };
    let ch = charAt(R0);
    if (p.gearMode !== 'manual' && ch.wStar > 0) { G = clamp(G * omegaD / ch.wStar, 0.2, 500); R0 = effRadius(p.rArm, G); ch = charAt(R0); } // one scaling correction puts the maximum-power speed at the design speed
    const { ws, tq, tnet, wStar, tStar } = ch;
    const Rf = p.coupling === 'cam' ? (th) => R0 * (1 + p.camAmp * Math.sin(p.camLobes * th)) : () => R0;
    const shape = (w) => p.loadType === 'constant' ? 1 : p.loadType === 'linear' ? w / omegaD : (w / omegaD) ** 2;
    const loadRef = p.loadMode === 'manual' ? p.loadTorque : (p.loadType === 'constant' ? tStar : tStar / Math.max(shape(wStar), 1e-9)) * 0.98;
    const load = (w) => loadRef * shape(Math.max(0, w));
    // quasi-steady equilibrium (first crossing of net drive and load)
    let wQS = NaN; for (let k = 1; k < ws.length; k++) { const a = tnet[k - 1] - load(ws[k - 1]), b = tnet[k] - load(ws[k]); if (a > 0 && b <= 0) { wQS = ws[k - 1] + (ws[k] - ws[k - 1]) * a / (a - b); break; } }
    ctx.progress(0.25, 'Shaft dynamics from rest');
    // ---- dynamic run from rest to steady state ----
    const base = { N, drive: drv, R: Rf, eta, ks, cs, J: Jtot, tauC: p.tauC, cVisc: p.cVisc, tauS, tauDrag: p.tauDrag, load };
    // integrate in chunks of 5 cycles from rest, continuing the state, until the cycle-mean speed is periodic
    const H = { t: [], omega: [], theta: [], tq: [], tl: [], tf: [], engaged: [] }, cm = [], sim = { Win: 0, Wload: 0, Wfric: 0, Wgear: 0, KE0: 0, KE1: 0, omega: 0, theta: 0, xc: null };
    let nCyc = 0, converged = false; const recK = Math.max(1, Math.round(p.spc / 120));
    while (nCyc < p.maxCycles) {
      const s = simulateShaft({ ...base, t0: nCyc * P, t1: (nCyc + 5) * P, h: P / p.spc, omega0: sim.omega, theta0: sim.theta, xc0: sim.xc, record: recK });
      for (const k of Object.keys(H)) H[k].push(...s.H[k].slice(nCyc ? 1 : 0));
      for (let c = 0; c < 5; c++) { let a = 0, m = 0; for (let k = 0; k < s.H.t.length; k++) { const tt = s.H.t[k] - nCyc * P; if (tt >= c * P && tt < (c + 1) * P) { a += s.H.omega[k]; m++; } } cm.push(m ? a / m : 0); }
      sim.Win += s.Win; sim.Wload += s.Wload; sim.Wfric += s.Wfric; sim.Wgear += s.Wgear; sim.KE1 = s.KE1; sim.omega = s.omega; sim.theta = s.theta; sim.xc = s.xc; nCyc += 5;
      const L = cm.length, b1 = L >= 6 ? mean(cm.slice(L - 3)) : 0, b0 = L >= 6 ? mean(cm.slice(L - 6, L - 3)) : 1; // drift of 3-cycle block means
      if (nCyc >= p.minCycles && L >= 6 && Math.abs(b1 - b0) <= 0.005 * Math.max(Math.abs(b1), 1e-6)) { converged = true; break; }
      await pause(ctx);
    }
    const tEnd = nCyc * P, last = H.t.map((t, k) => t >= tEnd - 2 * P ? k : -1).filter(k => k >= 0);
    const wMean = mean(last.map(k => H.omega[k])), wMax = Math.max(...last.map(k => H.omega[k])), wMin = Math.min(...last.map(k => H.omega[k]));
    const tqLast = last.map(k => H.tq[k]), tqMean = mean(tqLast), tqMax = Math.max(...tqLast), tqMin = Math.min(...tqLast);
    const ripple = tqMean > 0 ? (tqMax - tqMin) / tqMean : NaN, rippleRMS = tqMean > 0 ? std(tqLast) / tqMean : NaN, Cs = wMean > 0 ? (wMax - wMin) / wMean : 0;
    // steady-cycle power accounting from a dedicated periodic window (energy accumulators)
    const win = simulateShaft({ ...base, t0: tEnd, t1: tEnd + 2 * P, h: P / p.spc, omega0: sim.omega, theta0: sim.theta, xc0: sim.xc, record: 1, recCellsFrom: tEnd });
    const Tw = 2 * P, PinShaft = win.Win / Tw, Pload = win.Wload / Tw, Pfric = win.Wfric / Tw, Pgear = win.Wgear / Tw, dKEw = (win.KE1 - win.KE0) / Tw;
    const Pcell = N * dr0.Wcell / P, PintoMeta = N * dr0.Wcell / P, PcellOut = (win.Win + win.Wgear) / Tw; // ribbon work delivered into the coupling (after metamaterial)
    const Pmeta = PcellOut * (1 / Math.max(p.metaEff, 1e-9) - 1), Puncaptured = Math.max(0, PintoMeta - PcellOut - Pmeta);
    const PbearOnly = p.tauC * wMean + p.cVisc * wMean * wMean, Pdrag = Math.max(0, Pfric - PbearOnly);
    const transEff = Pcell > 0 ? Pload / Pcell : 0, transEffNoBearing = Pcell > 0 ? (Pload + PbearOnly) / Pcell : 0, mechEff = PcellOut > 0 ? Pload / PcellOut : 0;
    const Ploss = Pgear + Pfric + Pmeta;
    // start torque: shaft held at ω = 0, carriages blocked, worst and best phase over one cycle
    const stall = range(120).map(k => { const t = k * P / 120; let s = 0; const o = { xf: 0, fc: 0, vf: 0 }; for (let i = 0; i < N; i++) { drv(i, t, o); s += o.fc * Rf(0) * eta; } return s; });
    const startTorque = Math.min(...stall), startBest = Math.max(...stall), selfStart = startTorque - load(0) > tauS;
    ctx.progress(0.55, 'Verification: time-step refinement & coast-down');
    // ---- time-step convergence (h, h/2, h/4) on a fixed horizon ----
    const conv = [1, 2, 4].map(m => { const s = simulateShaft({ ...base, t0: tEnd, t1: tEnd + 3 * P, h: P / (p.spc * m / 2), omega0: sim.omega, theta0: sim.theta, xc0: sim.xc, record: 1e9 }); return { h: P / (p.spc * m / 2), w: s.omega, E: s.Win }; });
    const e21 = Math.abs(conv[2].w - conv[1].w), e32 = Math.abs(conv[1].w - conv[0].w), order = e21 > 0 && e32 > 0 ? Math.log(e32 / e21) / Math.log(2) : NaN, relConv = Math.abs(conv[2].E - conv[1].E) / Math.max(Math.abs(conv[2].E), 1e-9), relConvW = Math.abs(conv[2].w - conv[1].w) / Math.max(conv[2].w, 1e-9);
    // ---- coast-down (load disconnected, drive disengaged) vs closed form ----
    const w0 = wMean, c = Math.max(p.cVisc, 1e-9), tc = p.tauC, tStopAn = (Jtot / c) * Math.log(1 + c * w0 / Math.max(tc, 1e-12));
    const cd = rk45((t, y) => [y[0] > 0 ? (-tc - c * y[0]) / Jtot : 0], 0, [w0], tStopAn * 0.999, { rtol: 1e-8, atol: 1e-10, event: (t, y) => y[0] });
    const anW = (t) => (w0 + tc / c) * Math.exp(-c * t / Jtot) - tc / c;
    const cdErr = Math.max(...cd.t.map((t, k) => Math.abs(cd.y[k][0] - anW(t)))) / Math.max(w0, 1e-9);
    // coast-down with the load still connected (realistic stop)
    const cdL = rk45((t, y) => [y[0] > 0 ? (-tc - c * y[0] - load(y[0])) / Jtot : 0], 0, [w0], 10 * tStopAn + 10, { rtol: 1e-7, atol: 1e-9, event: (t, y) => y[0] - 1e-3 * Math.max(w0, 1e-6) });
    const tStopLoad = cdL.t[cdL.t.length - 1];
    ctx.progress(0.7, 'Performance map');
    // ---- performance map: gear ratio × speed → net shaft power ----
    const Gs = linspace(G * 0.35, G * 2.6, 14), wsMap = linspace(0, (dr.vPeak / effRadius(p.rArm, Gs[Gs.length - 1])) * 1.0, 32);
    const Zmap = Gs.map(Gk => { const R = effRadius(p.rArm, Gk); return wsMap.map(w => { const v = (qs(w, R) - (w > 0 ? fricMean(w) + N * p.tauDrag * 0.5 : 0)) * w; return Math.max(v, 0); }); });
    let best = { P: 0, G: G, w: 0 }; Zmap.forEach((row, j) => row.forEach((v, i) => { if (v > best.P) best = { P: v, G: Gs[j], w: wsMap[i] }; }));
    // ---- steady speed vs load sweep (constant load) on the chosen gear ----
    const loads = linspace(0, Math.max(...tnet) * 1.05, 16), wOfLoad = loads.map(L => { for (let k = 1; k < ws.length; k++) { const a = tnet[k - 1] - L, b = tnet[k] - L; if (a > 0 && b <= 0) return ws[k - 1] + (ws[k] - ws[k - 1]) * a / (a - b); } return 0; });
    // ---- energy balance & checks ----
    const balRes = Math.abs(sim.Win - (sim.KE1 - sim.KE0) - sim.Wload - sim.Wfric) / Math.max(sim.Win, 1e-12);
    const winRes = Math.abs(win.Win - (win.KE1 - win.KE0) - win.Wload - win.Wfric) / Math.max(win.Win, 1e-12);
    const tAt = (arr, w) => interp1(ws, arr, w), qsAgree = wMean > 0 ? Math.abs(tAt(tnet, wMean) - load(wMean)) / Math.max(tAt(tq, wMean), 1e-12) : NaN; // torque balance of the quasi-steady curve at the simulated speed
    out.checks.push(
      { name: 'Shaft energy balance, whole run (∫Στω = ΔKE + W_load + W_friction)', value: balRes, target: '< 1e-3', pass: balRes < 1e-3, detail: `Work in ${f4(sim.Win)} J, ΔKE ${f4(sim.KE1 - sim.KE0)} J, load ${f4(sim.Wload)} J, friction ${f4(sim.Wfric)} J.` },
      { name: 'Shaft energy balance, steady window', value: winRes, target: '< 1e-3', pass: winRes < 1e-3, detail: `Two steady cycles: ΔKE/T = ${f3(dKEw)} W (≈ 0 at periodic steady state).` },
      { name: 'Time-step convergence of cell work over 3 steady cycles (h/2 → h/4)', value: relConv, target: '< 2 % (first-order clutch events)', pass: relConv < 0.02, detail: `Final-speed change ${f3(relConvW * 100)} %; ω(h) = ${f4(conv[0].w)}, ω(h/2) = ${f4(conv[1].w)}, ω(h/4) = ${f4(conv[2].w)} rad/s; observed order ${f3(order)} (hybrid clutch events limit the formal order of RK4).` },
      { name: 'Coast-down: RK45 vs closed-form solution', value: cdErr, target: '< 1e-5 (relative)', pass: cdErr < 1e-5, detail: `Analytic stop time ${f3(tStopAn)} s (load disconnected).` },
      { name: 'Quasi-steady torque balance at the simulated steady speed', value: qsAgree, target: '< 8 % of drive torque', pass: Number.isFinite(qsAgree) && p.coupling !== 'cam' && Cs < 0.05 && converged ? qsAgree < 0.08 : undefined, detail: `${!converged ? 'Informative only: the run has not reached steady state. ' : ''}${p.coupling === 'cam' ? 'Informative only for the cam (the quasi-steady curve uses the mean cam radius). ' : ''}${Cs >= 0.05 ? `Informative only: the speed varies by ${f3(Cs * 100)} % within a cycle, so the constant-speed quasi-steady assumption does not hold. ` : ''}Quasi-steady equilibrium ${f4(wQS)} rad/s vs simulated cycle mean ${f4(wMean)} rad/s; residual (drive − friction − load) of the constant-speed curve at the simulated speed relative to the drive torque.` },
      { name: 'No energy creation: shaft power ≤ cell work supply', value: transEff, target: '≤ 1', pass: transEff <= 1 + 1e-9, detail: `P_load ${f3(Pload)} W vs cell gross ${f3(Pcell)} W.` },
      { name: 'Cycle-mean speed converged (drift of 3-cycle block means < 0.5 %)', value: converged ? 'yes' : 'no', pass: converged, detail: `${nCyc} cycles simulated; last cycle means ${cm.slice(-4).map(f3).join(', ')} rad/s.` },
    );
    // ---- KPIs ----
    out.kpis.push(
      { label: 'Steady shaft speed', value: wMean * 60 / TAU, unit: 'rpm', explain: `Cycle-mean shaft speed once the drive torque balances load and friction (${f3(wMean)} rad/s). It is set by the gear ratio G = ${f3(G)} and the carriage contraction speed; the design speed is ${p.rpm} rpm.`, prov: 'calc', status: wMean > 0 ? 'ok' : 'bad' },
      { label: 'Mean shaft power to load', value: Pload, unit: 'W', explain: 'Time-averaged τ_load·ω at steady state — the mechanical power actually delivered at the output flange, before pumps, valves and controls (net power is computed in Suite 18).', prov: 'calc', status: Pload > 0 ? 'ok' : 'bad' },
      { label: 'Transmission efficiency (cell → load)', value: transEff * 100, unit: '%', explain: `Delivered shaft power divided by the gross cell work supply N·W_cell·f = ${f3(Pcell)} W. Includes metamaterial, clutch/gear, bearing, drag losses and stroke not captured by the coupling.`, prov: 'calc', status: transEff > 0.7 ? 'ok' : transEff > 0.4 ? 'warn' : 'bad' },
      { label: 'Mean drive torque at shaft', value: tqMean, unit: 'N·m', explain: 'Cycle-mean of the summed cell torques after the coupling and gears.', prov: 'calc' },
      { label: 'Torque ripple (peak-to-peak / mean)', value: ripple * 100, unit: '%', explain: `Instantaneous drive torque swings between ${f3(tqMin)} and ${f3(tqMax)} N·m. Phase timing (Suite 12) reduces it; it does not change the mean.`, prov: 'calc', status: ripple < 0.5 ? 'ok' : ripple < 1.5 ? 'warn' : 'bad' },
      { label: 'Speed fluctuation coefficient', value: Cs * 100, unit: '%', explain: `(ω_max − ω_min)/ω_mean with total inertia ${f3(Jtot)} kg·m². A flywheel lowers it by storing and returning energy.`, prov: 'calc', status: Cs < 0.05 ? 'ok' : 'warn' },
      { label: 'Static start torque (worst phase)', value: startTorque, unit: 'N·m', explain: `Torque the cells develop with the shaft held still, at the least favourable moment of the cycle (best ${f3(startBest)} N·m). Must exceed static friction ${f3(tauS)} N·m plus the load at rest.`, prov: 'calc', status: selfStart ? 'ok' : 'warn' },
      { label: 'Mechanical losses', value: Ploss, unit: 'W', explain: `Gear/clutch ${f3(Pgear)} W + bearing & drag ${f3(Pfric)} W + metamaterial ${f3(Pmeta)} W; uncaptured stroke ${f3(Puncaptured)} W is listed separately because it is work the ribbons never delivered.`, prov: 'calc' },
      { label: 'Coast-down time (load disconnected)', value: tStopAn, unit: 's', explain: 'Closed-form stopping time from steady speed with bearing friction only — the standard drivetrain characterisation test.', prov: 'calc' },
    );
    // ---- verdicts ----
    out.verdicts.push(
      { test: 'Drive torque overcomes static friction and load at rest (self-start)', status: selfStart ? 'pass' : 'warn', detail: `Worst-phase start torque ${f3(startTorque)} N·m vs static friction ${f3(tauS)} N·m + load at rest ${f3(load(0))} N·m.`, fix: 'Start with selected cells heated (Suite 15), unload the shaft at start (clutch-in load), or reduce static friction.' },
      { test: 'Positive steady shaft power', status: Pload > 0 ? 'pass' : 'fail', detail: `P_load = ${f3(Pload)} W at ${f3(wMean * 60 / TAU)} rpm.`, fix: 'Reduce the load, lower the gear ratio, or increase cell force (Suite 05).' },
      { test: 'Maximum-power speed close to the design speed', status: Math.abs(wStar - omegaD) / omegaD < 0.3 ? 'pass' : 'warn', detail: `With G = ${f3(G)} the cell array delivers its maximum power at ${f3(wStar * 60 / TAU)} rpm (design ${p.rpm} rpm); map peak ${f3(best.P)} W.`, fix: `Use G ≈ ${f3(G * omegaD / Math.max(wStar, 1e-9))} (or select “Match the design shaft speed”).` },
      { test: 'Speed fluctuation acceptable (< 5 %)', status: Cs < 0.05 ? 'pass' : 'warn', detail: `C_s = ${f3(Cs * 100)} %.`, fix: `Raise flywheel inertia toward ${f3(Jtot * Cs / 0.04)} kg·m² or smooth torque by phasing (Suite 12).` },
      { test: 'Steady state reached', status: converged ? 'pass' : 'warn', detail: `${nCyc} cycles simulated.`, fix: 'Increase “Maximum simulated cycles” or reduce flywheel inertia for the study.' },
      { test: 'Transmission measurements', status: 'info', detail: 'All drivetrain losses here are library/estimated values.', fix: 'Measure freewheel drag, bearing coast-down and stall torque on the instrumented drivetrain and import them (Suite 19).' },
    );
    if (prov !== 'coupled') out.verdicts.push({ test: 'Cell force history source', status: 'info', detail: 'Suite 05 has not published a force history; the transient cell solver was run from the shared design.', fix: 'Run Suite 05 to couple the cartridge force–stroke history.' });
    out.headline = `${N} cells through a ${COUPLINGS.find(cc => cc.value === p.coupling).label.split(' (')[0].toLowerCase()} (G = ${f3(G)}) drive the shaft to ${f3(wMean * 60 / TAU)} rpm, delivering ${f3(Pload)} W to the load (transmission efficiency ${f3(transEff * 100)} %, torque ripple ${f3(ripple * 100)} %).`;
    out.headlineKind = Pload > 0 ? (selfStart ? 'ok' : 'warn') : 'fail';
    // ---- charts ----
    const dec = (arr, k = 1) => arr.filter((_, i) => i % k === 0), kD = Math.max(1, Math.floor(H.t.length / 900));
    const tCd = cdL.t.map(t => tEnd + 2 * P + t);
    out.charts.push({ type: 'line', wide: true, title: 'Shaft speed from rest to steady state, then coast-down with load', x: { label: 'Time', unit: 's' }, y: { label: 'Shaft speed', unit: 'rpm' }, series: [{ name: 'Simulated ω', x: dec(H.t, kD), y: dec(H.omega, kD).map(w => w * 60 / TAU) }, { name: 'Coast-down (load connected)', x: tCd, y: cdL.y.map(v => v[0] * 60 / TAU), dash: true }], annotations: [{ type: 'hline', y: p.rpm, label: 'design speed' }, ...(Number.isFinite(wQS) ? [{ type: 'hline', y: wQS * 60 / TAU, label: 'quasi-steady equilibrium', color: '#a855f7' }] : [])], explain: 'Speed rises from rest as cells start pushing, overshoots or settles once the cycle-mean drive torque equals load plus friction; the small saw-tooth is the per-stroke speed ripple. After the run the drive is cut and the shaft coasts to rest against load and friction (dashed).' });
    const lt = win.H.cellT, t0c = lt[0] ?? 0;
    if (lt.length) {
      const tS = lt.map(t => t - t0c), ks2 = Math.max(1, Math.floor(lt.length / 240)), cols = tS.filter((_, i) => i % ks2 === 0);
      out.charts.push({ type: 'heatmap', title: 'Torque contribution of each cell over two steady cycles', x: { label: 'Time in window', unit: 's', values: cols }, y: { label: 'Cell', values: range(N).map(i => i + 1) }, z: range(N).map(i => win.H.cellTau.filter((_, k) => k % ks2 === 0).map(v => v[i])), cmap: 'inferno', zlabel: 'N·m', explain: 'Each row is a cell; bright bands are its power strokes transmitted through the one-way coupling. Dark gaps are heating, cooling and reset — the clutch overruns so no cell pulls the shaft backwards.' });
      out.charts.push({ type: 'line', title: 'Steady instantaneous torque: total and three cells', x: { label: 'Time in window', unit: 's' }, y: { label: 'Torque', unit: 'N·m' }, series: [{ name: 'Σ cells (drive)', x: tS, y: win.H.cellTau.map(v => v.reduce((a, b) => a + b, 0)) }, ...[0, 1, 2].filter(i => i < N).map(i => ({ name: `cell ${i + 1}`, x: tS, y: win.H.cellTau.map(v => v[i]), dash: true }))], annotations: [{ type: 'hline', y: tqMean, label: 'mean' }], explain: 'Sum of all cell torques at the shaft (solid) with three individual contributions (dashed). Peak-to-peak / mean is the torque ripple KPI.' });
    }
    out.charts.push({ type: 'line', title: 'Torque–speed characteristic and load line', x: { label: 'Shaft speed', unit: 'rpm' }, y: { label: 'Torque', unit: 'N·m' }, series: [{ name: 'Cycle-mean drive torque', x: ws.map(w => w * 60 / TAU), y: tq }, { name: 'Drive − friction', x: ws.map(w => w * 60 / TAU), y: tnet }, { name: 'Load', x: ws.map(w => w * 60 / TAU), y: ws.map(load), dash: true }], annotations: [{ type: 'vline', x: wMean * 60 / TAU, label: 'simulated steady' }, { type: 'point', x: wStar * 60 / TAU, y: tStar, label: 'max power' }], explain: 'Quasi-steady cycle-mean torque the cells deliver at each constant shaft speed. It falls with speed because the carriages can only contract as fast as heat arrives; above the free-running speed the clutches overrun and torque vanishes. The operating point is where the load line crosses drive − friction.' });
    out.charts.push({ type: 'heatmap', wide: true, title: 'Performance map: net shaft power vs gear ratio and speed', x: { label: 'Shaft speed', unit: 'rpm', values: wsMap.map(w => w * 60 / TAU) }, y: { label: 'Gear ratio G', values: Gs }, z: Zmap, cmap: 'viridis', isolines: 6, zlabel: 'W', explain: `Each cell is the steady shaft power (drive − friction)·ω at that speed and gear ratio. Higher gearing raises speed but lowers torque by the same factor; the peak (${f3(best.P)} W at G ≈ ${f3(best.G)}) is a load-matching optimum, not extra power.` });
    out.charts.push({ type: 'bar', title: 'Where the cell work goes (steady)', categories: ['Cell gross supply', 'Uncaptured stroke', 'Metamaterial', 'Gears & clutch', 'Bearing friction', 'Clutch drag', 'Delivered to load'], series: [{ name: 'Power [W]', values: [Pcell, Puncaptured, Pmeta, Pgear, PbearOnly, Pdrag, Pload] }], explain: 'Cell gross supply = N·W_cell·f from the cartridge cycle. Each loss is subtracted in the order energy flows; the last bar is the shaft power reaching the load.' });
    out.charts.push({ type: 'line', title: 'Steady speed and shaft power vs constant load torque', x: { label: 'Load torque', unit: 'N·m' }, y: { label: 'Speed [rpm] / power [W]' }, series: [{ name: 'Steady speed (rpm)', x: loads, y: wOfLoad.map(w => w * 60 / TAU) }, { name: 'Shaft power (W)', x: loads, y: loads.map((L, k) => L * wOfLoad[k]) }], explain: 'Off-design behaviour with a constant-torque load: the engine slows as load rises until it stalls where the load exceeds the low-speed drive torque.' });
    out.charts.push({ type: 'line', title: 'Coast-down verification (load disconnected)', x: { label: 'Time', unit: 's' }, y: { label: 'Speed', unit: 'rad/s' }, series: [{ name: 'RK45', x: cd.t, y: cd.y.map(v => v[0]), mode: 'markers' }, { name: 'Closed form', x: linspace(0, tStopAn, 60), y: linspace(0, tStopAn, 60).map(anW) }], explain: 'Numerical coast-down against the exact solution for Coulomb + viscous bearing friction; measured coast-down curves calibrate τ_C and c_v.' });
    out.convergence = { title: 'Time-step refinement (final speed)', series: [{ name: '|Δω| between levels', x: [1, 2], y: [Math.max(e32, 1e-14), Math.max(e21, 1e-14)] }] };
    // ---- tables ----
    out.tables.push({ title: 'Steady operating point', cols: ['Quantity', 'Value', 'Unit'], rows: [
      ['Gear ratio G / effective radius R', `${f4(G)} / ${f4(R0 * 1000)}`, '– / mm per rad'], ['Total inertia J', f4(Jtot), 'kg·m²'], ['Steady speed', f4(wMean * 60 / TAU), 'rpm'], ['Mean drive torque', f4(tqMean), 'N·m'], ['Load torque at design speed', f4(loadRef), 'N·m'],
      ['Cell gross supply', f4(Pcell), 'W'], ['Delivered to load', f4(Pload), 'W'], ['Transmission efficiency (cell → load)', f4(transEff * 100), '%'], ['Efficiency excl. bearings (published)', f4(transEffNoBearing * 100), '%'], ['Coupling mechanical efficiency', f4(mechEff * 100), '%'],
      ['Mean cells engaged', f4(mean(last.map(k => H.engaged[k]))), '–'], ['Series carriage stiffness', f4(ks / 1e3), 'kN/m'], ['Force capacity per cell (after metamaterial)', f4(dr.Fload), 'N'], ['Free contraction per cell', f4(dr.xwMax * 1000), 'mm'], ['Drive source', src, ''],
    ], explain: 'Steady values over the last two simulated cycles.' });
    out.tables.push({ title: 'Energy balance (whole run from rest)', cols: ['Term', 'Energy [J]'], rows: [['Work by cells at shaft ∫Στω dt', f4(sim.Win)], ['Kinetic energy gained ΔKE', f4(sim.KE1 - sim.KE0)], ['Load work', f4(sim.Wload)], ['Friction & drag', f4(sim.Wfric)], ['Gear & clutch loss (cell side)', f4(sim.Wgear)], ['Residual (relative)', fmt(balRes, 3)]], explain: 'The flywheel only stores ΔKE; every joule delivered to the load came from the cells.' });
    out.tables.push({ title: 'Time-step study', cols: ['h [s]', 'Final ω [rad/s]', 'Cell work at shaft over 3 cycles [J]'], rows: conv.map(cc => [f4(cc.h), f4(cc.w), f4(cc.E)]), explain: 'Three steady cycles restarted from the same converged state at three step sizes; differences quantify the discretisation error.' });
    // ---- explanation & recommendations ----
    out.explain.push(
      { title: 'How force becomes torque', text: `Each cell contracts by up to ${f3(dr.xwMax * 1000)} mm while carrying ${f3(dr.Fload)} N (after the metamaterial stage A = ${f3(A)}, η_m = ${f3(p.metaEff)}). Through the rocker of ${p.rArm} mm and gear ratio ${f3(G)} this becomes ${f3(dr.Fload * R0 * eta)} N·m per pushing cell. The one-way coupling transmits tension only: when a cell cools and resets, its clutch overruns and it costs only drag torque.` },
      { title: 'Why speed settles where it does', text: `The cells are force-limited and contraction-rate-limited. At low speed every heated cell pushes at full force; as the shaft speeds up, the carriages can no longer keep up with R·ω and the clutches overrun. The cycle-mean torque therefore falls with speed, and the load line crosses it at ${f3(wMean * 60 / TAU)} rpm.` },
      { title: 'What the flywheel does', text: `With J = ${f3(Jtot)} kg·m² the speed varies by ${f3(Cs * 100)} % within a cycle. The energy balance shows the flywheel only stores ${f3(sim.KE1 - sim.KE0)} J of kinetic energy gained during spin-up; it creates none.` },
    );
    out.recs.push(
      { level: transEff > 0.7 ? 'good' : 'warn', text: `Transmission efficiency is ${f3(transEff * 100)} %. Largest loss: ${[['uncaptured stroke', Puncaptured], ['metamaterial', Pmeta], ['gears & clutch', Pgear], ['bearings', PbearOnly], ['clutch drag', Pdrag]].sort((a, b) => b[1] - a[1])[0][0]}.`, basis: `Loss breakdown ${f3(Puncaptured)}/${f3(Pmeta)}/${f3(Pgear)}/${f3(PbearOnly)}/${f3(Pdrag)} W.` },
      { level: Math.abs(wStar - omegaD) / omegaD < 0.3 ? 'info' : 'warn', text: `The power ridge of the map runs along R·ω ≈ mean carriage speed: any gear ratio delivers about ${f3(best.P)} W at its own matched speed, so choose G for the speed the load needs (G = ${f3(G * omegaD / Math.max(wStar, 1e-9))} for ${p.rpm} rpm), not for more power.`, basis: 'Gear × speed performance map.' },
      { level: Cs < 0.05 ? 'info' : 'warn', text: `Speed fluctuation ${f3(Cs * 100)} %. ${Cs < 0.05 ? 'Flywheel adequate.' : `Increase inertia to ≈ ${f3(Jtot * Cs / 0.04)} kg·m² or optimise phase offsets in Suite 12.`}`, basis: `Torque ripple ${f3(ripple * 100)} %.` },
      { level: selfStart ? 'good' : 'critical', text: selfStart ? `Self-start margin ${f3(startTorque - tauS - load(0))} N·m at the worst phase.` : 'The engine cannot break away at the worst phase; a start sequence with selected heated cells and an unloaded shaft is required (Suite 15).', basis: `Start torque ${f3(startTorque)} N·m vs static friction ${f3(tauS)} N·m.` },
      { level: 'econ', text: `Each 1 % of transmission efficiency is worth ${f3(Pcell / 100)} W of shaft output at this cell supply; low-drag sprag clutches and ceramic-hybrid bearings are usually cheaper than adding cartridges for the same gain.`, basis: `Cell gross supply ${f3(Pcell)} W.` },
      { level: 'sustain', text: `Mechanical losses of ${f3(Ploss)} W dissipate ${f3(Ploss * 8760 / 1000)} kWh per year of continuous operation as low-grade heat; recovering the cell supply that is not captured (${f3(Puncaptured)} W) by gear matching is the cheapest efficiency gain because it needs no extra heat or material.`, basis: 'Steady loss breakdown.' },
    );
    // ---- animation ----
    const aT = lt.map(t => t - t0c), aTau = win.H.cellTau, aW = win.H.t, aWv = win.H.omega, aTh = win.H.theta;
    const tauMx = dr.Fload * R0 * eta;
    if (aT.length > 2) out.views.push({ label: 'Rotor animation', icon: '⚙', render: async (el) => {
      const { anim2d, at, lerp, seriesPanel, theme } = await import('../core/anim2d.js');
      const tW = aW.map(t => t - t0c), tot = aTau.map(v => v.reduce((a, b) => a + b, 0));
      anim2d(el, { duration: aT[aT.length - 1], label: 'Steady window time', unit: 's', height: 440, explain: 'Rotor with cells arranged around it: red cells are heated, green arrows are the tangential torque each engaged cell applies through its one-way coupling; the right panels show shaft speed and total drive torque with a sweeping cursor.', draw: (g, t, W, Hh) => {
        const th = theme(), k = at(aT, t), kw = at(tW, t), ang = lerp(aTh, kw), ph = (t + t0c) / P;
        const heat = range(N).map(i => { const q = ((ph + offsets[i]) % 1 + 1) % 1; return q < d.dutyHot ? 1 : 0; });
        drawRotor(g, { cx: W * 0.27, cy: Hh * 0.45, r: Math.min(W * 0.14, Hh * 0.22), theta: ang, N, act: range(N).map(i => (aTau[k.i][i] || 0) / (tauMx || 1)), tau: aTau[k.i], tauMax: tauMx, heat, label: `ω = ${fmt(lerp(aWv, kw) * 60 / TAU, 4)} rpm`, th });
        seriesPanel(g, { x: W * 0.55, y: 10, w: W * 0.43, h: Hh / 2 - 15, T: tW, series: [{ name: 'speed', y: aWv.map(w => w * 60 / TAU), color: th.accent }], t, title: 'Shaft speed', unit: 'rpm' });
        seriesPanel(g, { x: W * 0.55, y: Hh / 2 + 5, w: W * 0.43, h: Hh / 2 - 15, T: aT, series: [{ name: 'Σ τ', y: tot, color: '#22c55e' }], t, title: 'Drive torque', unit: 'N·m', hlines: [{ y: loadRef * shape(wMean), label: 'load', color: '#ef4444' }] });
      } });
    } });
    out.outputs = { transEff: transEffNoBearing, torqueMean_Nm: tqMean, torqueRipple: ripple, Pshaft_W: Pload, Ploss_W: Ploss, J_kgm2: Jtot, omega_rads: wMean, startTorque_Nm: startTorque, gearRatio: G, effRadius_m: R0, loadTorque_Nm: loadRef, loadType: p.loadType, tauStatic_Nm: tauS, tauC_Nm: p.tauC };
    return out;
  },
};
