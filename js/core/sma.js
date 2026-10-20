// Shape-memory-alloy constitutive and cell-level solvers for THERMA-X100.
//
// Constitutive law (1-D, Brinson-type with detwinned/twinned split):
//   ε = σ/E(ξ) + εL·ξs + α(T − Tref),   1/E(ξ) = ξ/EM + (1 − ξ)/EA,   ξ = ξs + ξT
// Stress-dependent transformation temperatures (Clausius–Clapeyron): Ms(σ) = Ms + σ/CM, As(σ) = As + σ/CA, …
// Kinetics: cosine (Liang–Rogers / Brinson) or exponential (Tanaka) laws with memory of the segment start.
// Detwinning of twinned martensite under stress between the critical stresses σs and σf (cosine gate).
//
// Cell transient (cellTransient): a bundle of ribbons sandwiched between two heat-exchange walls.
// Half-thickness finite-volume conduction (implicit Euler) coupled to a lumped wall node and a switching
// hot/cold fluid; first law per cell  ρ cp ∂T/∂t = ∇·(k∇T) + ρ·Lh·∂ξ/∂t + σ·∂ε/∂t  (latent heat release on
// forward transformation, mechanical work extraction on contraction). Mechanics: uniform strain across the
// thickness, force balance Σσi·Ai = A·σext(ε) with a bias spring and a one-way-clutch output load.
import { clamp, linspace, thomas, range } from './num.js';
export const KELVIN = 273.15;

const cosKin = (x) => 0.5 * (1 - Math.cos(Math.PI * clamp(x, 0, 1)));

export class SMA {
  constructor(m, { kinetics = 'cosine', Tref = 20, epsLScale = 1 } = {}) {
    Object.assign(this, { EA: m.EA * 1e9, EM: m.EM * 1e9, Ms: m.Ms, Mf: m.Mf, As: m.As, Af: m.Af, CM: m.CM, CA: m.CA, epsL: m.epsL * epsLScale, Lh: m.Lh || 0, rho: m.rho, cp: m.cp, alpha: (m.alpha || 11) * 1e-6, k: m.k || 18, kM: m.kM || m.k || 10, sigS: m.sigS ?? 60, sigF: m.sigF ?? 120 });
    this.kinetics = kinetics; this.Tref = Tref; this.xi = 1; this.xis = 0; this.dir = 0; this.x0F = 1; this.x0R = 1;
  }
  clone() { const c = Object.create(SMA.prototype); Object.assign(c, this); return c; }
  E(xi = this.xi) { return 1 / (xi / this.EM + (1 - xi) / this.EA); }
  kAt(xi = this.xi) { return xi * this.kM + (1 - xi) * this.k; }
  temps(sMPa) { const s = Math.max(0, sMPa); return { Ms: this.Ms + s / this.CM, Mf: this.Mf + s / this.CM, As: this.As + s / this.CA, Af: this.Af + s / this.CA }; }
  gate(sMPa) { return cosKin((sMPa - this.sigS) / Math.max(1e-6, this.sigF - this.sigS)); }
  // advance phase state for temperature T (°C) and stress σ (MPa); returns ξ
  update(T, sMPa) {
    const t = this.temps(sMPa), xi = this.xi; let next = xi;
    const fwdPossible = T < t.Ms, revPossible = T > t.As;
    if (fwdPossible) {
      if (this.dir !== 1) this.x0F = xi;
      const x0 = this.x0F; let tgt;
      if (this.kinetics === 'exponential') tgt = 1 - (1 - x0) * Math.exp(-Math.log(100) * (t.Ms - T) / Math.max(1e-6, t.Ms - t.Mf));
      else tgt = T <= t.Mf ? 1 : (1 - x0) / 2 * Math.cos(Math.PI / (t.Ms - t.Mf) * (T - t.Mf)) + (1 + x0) / 2;
      if (tgt > xi + 1e-12) next = tgt;
    }
    if (next === xi && revPossible) {
      if (this.dir !== -1) this.x0R = xi;
      const x0 = this.x0R; let tgt;
      if (this.kinetics === 'exponential') tgt = x0 * Math.exp(-Math.log(100) * (T - t.As) / Math.max(1e-6, t.Af - t.As));
      else tgt = T >= t.Af ? 0 : x0 / 2 * (Math.cos(Math.PI / (t.Af - t.As) * (T - t.As)) + 1);
      if (tgt < xi - 1e-12) next = tgt;
    }
    next = clamp(next, 0, 1);
    if (next > xi) { this.dir = 1; const d = next - xi, g = this.gate(sMPa); this.xis += d * Math.max(g, sMPa >= this.sigF ? 1 : g); }
    else if (next < xi) { this.dir = -1; this.xis *= xi > 0 ? next / xi : 0; }
    this.xi = next;
    // detwinning of existing twinned martensite (irreversible on unloading)
    if (sMPa > this.sigS) this.xis = Math.max(this.xis, this.xi * this.gate(sMPa));
    this.xis = clamp(this.xis, 0, this.xi);
    return this.xi;
  }
  strain(sMPa, T) { return sMPa * 1e6 / this.E() + this.epsL * this.xis + this.alpha * (T - this.Tref); }
  // stress (MPa) for a given strain at the current phase state (elastic predictor)
  stressAt(eps, T) { return this.E() * (eps - this.epsL * this.xis - this.alpha * (T - this.Tref)) / 1e6; }
  // settle into a cold, fully martensitic, detwinned working state at stress σ (prepared, pre-extended ribbon)
  prepare(Tc, sMPa) { this.xi = 1; this.xis = 0; this.dir = 0; for (const T of linspace(Math.max(this.Af + 30, Tc), Tc, 80)) this.update(T, sMPa); this.xis = Math.max(this.xis, this.xi * this.gate(Math.max(sMPa, this.sigF))); return this; }
}

// Allocation-free kinetic kernel used by the transient solvers: st = {xi, xis, dir, x0F, x0R} is copied into out
export function kinStep(m, st, T, sMPa, out) {
  out.xi = st.xi; out.xis = st.xis; out.dir = st.dir; out.x0F = st.x0F; out.x0R = st.x0R;
  const sp = Math.max(0, sMPa), Ms = m.Ms + sp / m.CM, Mf = m.Mf + sp / m.CM, As = m.As + sp / m.CA, Af = m.Af + sp / m.CA, xi = st.xi; let next = xi;
  if (T < Ms) { if (out.dir !== 1) out.x0F = xi; const x0 = out.x0F; const tgt = m.kinetics === 'exponential' ? 1 - (1 - x0) * Math.exp(-4.60517 * (Ms - T) / Math.max(1e-6, Ms - Mf)) : (T <= Mf ? 1 : (1 - x0) / 2 * Math.cos(Math.PI / (Ms - Mf) * (T - Mf)) + (1 + x0) / 2); if (tgt > xi + 1e-12) next = tgt; }
  if (next === xi && T > As) { if (out.dir !== -1) out.x0R = xi; const x0 = out.x0R; const tgt = m.kinetics === 'exponential' ? x0 * Math.exp(-4.60517 * (T - As) / Math.max(1e-6, Af - As)) : (T >= Af ? 0 : x0 / 2 * (Math.cos(Math.PI / (Af - As) * (T - As)) + 1)); if (tgt < xi - 1e-12) next = tgt; }
  next = next < 0 ? 0 : next > 1 ? 1 : next;
  const g = sMPa <= m.sigS ? 0 : sMPa >= m.sigF ? 1 : 0.5 * (1 - Math.cos(Math.PI * (sMPa - m.sigS) / (m.sigF - m.sigS)));
  if (next > xi) { out.dir = 1; out.xis += (next - xi) * g; } else if (next < xi) { out.dir = -1; out.xis *= xi > 0 ? next / xi : 0; }
  out.xi = next; if (g > 0 && out.xis < next * g) out.xis = next * g; if (out.xis > next) out.xis = next; if (out.xis < 0) out.xis = 0;
  return out;
}
const strainOf = (m, st, sMPa, T) => sMPa * 1e6 * (st.xi / m.EM + (1 - st.xi) / m.EA) + m.epsL * st.xis + m.alpha * (T - m.Tref);

// Stress–temperature phase diagram lines (σ in MPa)
export function phaseDiagram(m, sMax = 400, n = 41) {
  const s = linspace(0, sMax, n);
  return { s, Ms: s.map(x => m.Ms + x / m.CM), Mf: s.map(x => m.Mf + x / m.CM), As: s.map(x => m.As + x / m.CA), Af: s.map(x => m.Af + x / m.CA), sigS: m.sigS, sigF: m.sigF };
}

// Quasi-static isobaric (two-stress) cycle: load σL→σH cold, heat at σH, unload at Th, cool at σL
export function quasiStaticCycle(mat, { Th, Tc, sH, sL, n = 80, cycles = 3, kinetics = 'cosine' } = {}) {
  const m = new SMA(mat, { kinetics }).prepare(Tc, sL);
  const path = []; const rec = (s, T) => { m.update(T, s); path.push({ s, T, xi: m.xi, xis: m.xis, e: m.strain(s, T) }); };
  let start = 0;
  for (let c = 0; c < cycles; c++) {
    if (c === cycles - 1) start = path.length;
    for (const s of linspace(sL, sH, n / 4)) rec(s, Tc);
    for (const T of linspace(Tc, Th, n / 4)) rec(sH, T);
    for (const s of linspace(sH, sL, n / 4)) rec(s, Th);
    for (const T of linspace(Th, Tc, n / 4)) rec(sL, T);
  }
  const P = path.slice(start);
  let w = 0, wC = 0, wR = 0;
  for (let i = 1; i < P.length; i++) { const dW = -0.5 * (P[i].s + P[i - 1].s) * 1e6 * (P[i].e - P[i - 1].e); w += dW; if (dW > 0) wC += dW; else wR -= dW; }
  const q = n / 4, dXiHeat = Math.max(0, P[q - 1].xi - P[3 * q - 1].xi);
  const wJkg = w / mat.rho, qIn = mat.cp * Math.max(0, Th - Tc) + (mat.Lh || 0) * dXiHeat + Math.max(0, wJkg);
  return { path: P, w_J_m3: w, w_J_kg: wJkg, wContraction_J_kg: wC / mat.rho, wReset_J_kg: wR / mat.rho, qIn_J_kg: qIn, eta: qIn > 0 ? wJkg / qIn : 0, etaCarnot: Th > Tc ? 1 - (Tc + KELVIN) / (Th + KELVIN) : 0, dXiHeat, stroke: Math.max(...P.map(p => p.e)) - Math.min(...P.map(p => p.e)), closure: Math.abs(P[P.length - 1].e - P[0].e), temps: { H: m.temps(sH), L: m.temps(sL) } };
}

// Stress-controlled isothermal tensile loading/unloading at temperature T (detwinning or superelastic loop)
export function tensileTest(mat, { T, sMax = 500, n = 120, kinetics = 'cosine', startPhase = 'auto' } = {}) {
  const m = new SMA(mat, { kinetics });
  if (startPhase === 'martensite' || (startPhase === 'auto' && T < mat.As)) { m.xi = 1; m.xis = 0; } else { m.xi = 0; m.xis = 0; }
  for (const TT of linspace(T + (m.xi ? -1 : 1), T, 5)) m.update(TT, 0);
  const up = linspace(0, sMax, n), down = linspace(sMax, 0, n), out = [];
  for (const s of [...up, ...down]) { m.update(T, s); out.push({ s, e: m.strain(s, T) - m.alpha * (T - m.Tref), xi: m.xi, xis: m.xis }); }
  let w = 0; for (let i = 1; i < out.length; i++) w += 0.5 * (out[i].s + out[i - 1].s) * 1e6 * (out[i].e - out[i - 1].e);
  return { path: out, dissipated_J_m3: w, residual: out[out.length - 1].e };
}

// Simulated DSC thermogram (model output, NOT a measurement): heat flow ∝ Lh·dξ/dT·rate at zero stress
export function dscSim(mat, { rate = 10 / 60, Tlo, Thi, n = 400, kinetics = 'cosine', mass = 0.02 } = {}) {
  Tlo ??= mat.Mf - 25; Thi ??= mat.Af + 25;
  const m = new SMA(mat, { kinetics }); m.xi = 1; m.xis = 0;
  const heat = [], cool = []; let prev = m.xi;
  for (const T of linspace(Tlo, Thi, n)) { m.update(T, 0); const dxi = m.xi - prev; prev = m.xi; heat.push({ T, q: -dxi / ((Thi - Tlo) / (n - 1)) * mat.Lh * rate * mass * 1000, xi: m.xi }); }
  for (const T of linspace(Thi, Tlo, n)) { m.update(T, 0); const dxi = m.xi - prev; prev = m.xi; cool.push({ T, q: -dxi / ((Thi - Tlo) / (n - 1)) * mat.Lh * rate * mass * 1000, xi: m.xi }); }
  const peak = (arr) => arr.reduce((a, b) => Math.abs(b.q) > Math.abs(a.q) ? b : a);
  return { heat, cool, Ap: peak(heat).T, Mp: peak(cool).T, hysteresis: peak(heat).T - peak(cool).T, unit: 'mW (mass ' + mass * 1000 + ' g, ' + (rate * 60) + ' K/min)' };
}

// Functional-fatigue life (order-of-magnitude literature trend), structural Basquin cap
export function fatigueLife(mat, epsTr, sMPa) {
  const f = mat.fatigue || { N0: 1e5, eps0: 0.03, a: 3, sig0: 200, b: 2 };
  return clamp(f.N0 * (f.eps0 / Math.max(1e-5, epsTr)) ** f.a * (f.sig0 / Math.max(1, sMPa)) ** f.b, 10, 1e10);
}

// ---------------- Ribbon-cell transient ----------------
// opts (SI unless noted): mat, t (ribbon thickness m), w (width m), L (active length m), nRib, n (half-thickness cells),
// Th, Tc (fluid °C), hHot, hCold (fluid→wall W/m²K), hc (wall→ribbon contact W/m²K), Cw (wall capacity per face area J/m²K),
// period (s), dutyHot (–), tSwitch (s, fluid switching ramp), sBias0 (MPa at reference extended strain), kBias (MPa per unit
// strain of contraction), sLoad (MPa added by the output load, one-way clutch: engaged only while contracting in the hot phase;
// a load too large to lift stalls the cell — blocked recovery stress, no work),
// cycles, stepsPerCycle, kinetics, TfHot/TfCold optional functions of time.
export function cellTransient(o) {
  const mat = o.mat, n = Math.max(1, o.n ?? 6), cycles = o.cycles ?? 5, spc = o.stepsPerCycle ?? 360;
  const P = o.period, dt = P / spc, Lh = o.t / 2, dx = Lh / n, A = o.nRib * o.w * o.t, faceArea = 2 * o.nRib * o.w * o.L;
  const mass = A * o.L * mat.rho;
  const proto = new SMA(mat, { kinetics: o.kinetics || 'cosine', epsLScale: o.epsLScale ?? 1 });
  const nodes = range(n).map(() => { const m = proto.clone().prepare(o.Tc, o.sBias0); return { xi: m.xi, xis: m.xis, dir: m.dir, x0F: m.x0F, x0R: m.x0R }; });
  const trial = range(n).map(() => ({})), best = range(n).map(() => ({}));
  const kAt = (st) => st.xi * proto.kM + (1 - st.xi) * proto.k;
  const T = new Float64Array(n + 1).fill(o.Tc); // index 0 wall, 1..n ribbon cells (surface→centre)
  const eps0 = nodes.reduce((a, st) => a + strainOf(proto, st, o.sBias0, o.Tc), 0) / n;
  let eps = eps0, epsPrev = eps0, sPrev = o.sBias0;
  const lat = new Float64Array(n), work = new Float64Array(n);
  // Iso-stress (Reuss) through-thickness assumption: every cell carries the external stress; the ribbon strain is the
  // thickness-average node strain. ε̄(σ) is monotonic in σ, so each equilibrium is a robust scalar bisection.
  const strainAt = (sMPa, into = trial) => { let e = 0; for (let i = 0; i < n; i++) { kinStep(proto, nodes[i], T[i + 1], sMPa, into[i]); e += strainOf(proto, into[i], sMPa, T[i + 1]); } return e / n; };
  const bisect = (g, lo, hi) => { let flo = g(lo), fhi = g(hi), k = 0; while (flo * fhi > 0 && k++ < 30) { lo = Math.max(0, lo - 100 * k); hi += 100 * k; flo = g(lo); fhi = g(hi); } for (let it = 0; it < 60; it++) { const mid = 0.5 * (lo + hi), fm = g(mid); if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else hi = mid; if (hi - lo < 1e-4) break; } return 0.5 * (lo + hi); };
  const equilibrium = (load) => { const g = (s) => s - o.sBias0 - o.kBias * (eps0 - strainAt(s)) - load; const s0 = sPrev - (load ? 0 : o.sLoad); return bisect(g, Math.max(0, s0 - 30), s0 + load + 30); };
  const finish = (sig, extra) => { const e = strainAt(sig, best); return { s: sig, e, ...extra }; };
  const solveMech = (hotPhase) => {
    const s0 = equilibrium(0), e0 = strainAt(s0);
    if (!(hotPhase && o.sLoad > 0)) return finish(s0, { engaged: false, stalled: false });
    const s1 = equilibrium(o.sLoad), e1 = strainAt(s1);
    if (e1 <= eps + 1e-12) return finish(s1, { engaged: true, stalled: false });                 // contracting against the load: clutch engaged
    if (e0 < eps - 1e-12) {                                                                       // wants to contract but cannot lift the load: blocked
      const sb = o.sBias0 + o.kBias * (eps0 - eps), sig = bisect((s) => strainAt(s) - eps, sb, sb + o.sLoad);
      const r = finish(sig, { engaged: true, stalled: true }); r.e = eps; return r;
    }
    return finish(s0, { engaged: false, stalled: false });                                       // extending: clutch freewheels
  };
  const hist = { t: [], Tf: [], Tw: [], Ts: [], Tc: [], Tm: [], xi: [], xis: [], eps: [], sExt: [], F: [], x: [], engaged: [], Pmech: [], qIn: [] };
  const cyc = [];
  let Tf = o.Tc, tGlob = 0;
  for (let c = 0; c < cycles; c++) {
    const last = c === cycles - 1;
    let Wout = 0, Wcon = 0, Wres = 0, Qhot = 0, Qcold = 0, Wspring = 0, xiMin = 1, xiMax = 0, epsMin = Infinity, epsMax = -Infinity;
    const U0 = energyContent();
    for (let s = 0; s < spc; s++) {
      const tc = s * dt, hotPhase = tc < o.dutyHot * P;
      // fluid temperature with switching ramp (valve + displacement of residual fluid)
      const tIn = hotPhase ? tc : tc - o.dutyHot * P, ramp = clamp(tIn / Math.max(o.tSwitch || 1e-9, 1e-9), 0, 1);
      const Ttarget = hotPhase ? (o.TfHot ? o.TfHot(tGlob) : o.Th) : (o.TfCold ? o.TfCold(tGlob) : o.Tc), Tfrom = hotPhase ? (o.TfCold ? o.TfCold(tGlob) : o.Tc) : (o.TfHot ? o.TfHot(tGlob) : o.Th);
      Tf = Tfrom + (Ttarget - Tfrom) * ramp;
      const hf = hotPhase ? o.hHot : o.hCold;
      // --- thermal step (implicit), sources lagged: latent + mechanical work
      const a = new Array(n + 1).fill(0), b = new Array(n + 1).fill(0), cc = new Array(n + 1).fill(0), d = new Array(n + 1).fill(0);
      const kAvg = (i) => kAt(nodes[i]);
      const Gwr = 1 / (1 / Math.max(o.hc, 1e-9) + dx / 2 / kAvg(0));
      b[0] = o.Cw / dt + hf + Gwr; cc[0] = -Gwr; d[0] = o.Cw / dt * T[0] + hf * Tf;
      for (let i = 1; i <= n; i++) {
        const C = mat.rho * mat.cp * dx / dt, Gin = i === 1 ? Gwr : 1 / (dx / kAvg(i - 2) / 2 + dx / kAvg(i - 1) / 2), Gout = i === n ? 0 : 1 / (dx / kAvg(i - 1) / 2 + dx / kAvg(i) / 2);
        a[i] = -Gin; b[i] = C + Gin + Gout; cc[i] = i === n ? 0 : -Gout; d[i] = C * T[i] + (lat[i - 1] + work[i - 1]) * dx;
      }
      const Tn = thomas(a, b, cc, d); for (let i = 0; i <= n; i++) T[i] = Tn[i];
      const qf = hf * (Tf - T[0]); // W/m² from fluid into wall
      if (hotPhase) Qhot += qf * dt * faceArea; else Qcold -= qf * dt * faceArea;
      // --- mechanics with one-way clutch: engage the load only while contracting in the hot phase
      const r = solveMech(hotPhase), engaged = r.engaged, deps = r.e - eps;
      // commit node states, latent and work sources for the next step
      let xiSum = 0, xisSum = 0;
      for (let i = 0; i < n; i++) {
        const prevXi = nodes[i].xi; Object.assign(nodes[i], best[i]);
        const si = r.s;
        lat[i] = mat.rho * mat.Lh * (nodes[i].xi - prevXi) / dt; work[i] = si * 1e6 * deps / dt;
        xiSum += nodes[i].xi; xisSum += nodes[i].xis;
      }
      epsPrev = eps; eps = r.e;
      const sE = r.s, dW = -sE * 1e6 * deps * A * o.L; sPrev = sE; // J, + on contraction (end-of-step equilibrium stress, consistent with the clutch state)
      if (dW > 0) Wcon += dW; else Wres -= dW;
      if (engaged && !r.stalled) Wout += -o.sLoad * 1e6 * deps * A * o.L;
      Wspring += -(o.sBias0 + o.kBias * (eps0 - 0.5 * (eps + epsPrev))) * 1e6 * deps * A * o.L;
      xiMin = Math.min(xiMin, xiSum / n); xiMax = Math.max(xiMax, xiSum / n); epsMin = Math.min(epsMin, eps); epsMax = Math.max(epsMax, eps);
      if (last) {
        let Tm = 0; for (let i = 1; i <= n; i++) Tm += T[i]; Tm /= n;
        hist.t.push(tc); hist.Tf.push(Tf); hist.Tw.push(T[0]); hist.Ts.push(T[1]); hist.Tc.push(T[n]); hist.Tm.push(Tm); hist.xi.push(xiSum / n); hist.xis.push(xisSum / n); hist.eps.push(eps); hist.sExt.push(sE); hist.F.push(sE * 1e6 * A); hist.x.push((eps0 - eps) * o.L); hist.engaged.push(engaged ? (r.stalled ? 0.5 : 1) : 0); hist.Pmech.push(engaged && !r.stalled ? -o.sLoad * 1e6 * A * o.L * deps / dt : 0); hist.qIn.push(qf * faceArea);
      }
      tGlob += dt;
    }
    const dU = energyContent() - U0;
    cyc.push({ Wout, Wcon, Wres, Wspring, Qhot, Qcold, dU, residual: (Qhot - Qcold - Wout - Wspring - dU), xiMin, xiMax, stroke: (epsMax - epsMin) * o.L });
  }
  function energyContent() { let U = o.Cw * T[0] * faceArea; for (let i = 1; i <= n; i++) U += mat.rho * dx * (mat.cp * T[i] - (mat.Lh || 0) * nodes[i - 1].xi) * faceArea; return U; }
  const L = cyc[cyc.length - 1], prev = cyc[cyc.length - 2] || L;
  const f = 1 / P, etaC = o.Th > o.Tc ? 1 - (o.Tc + KELVIN) / (o.Th + KELVIN) : 0;
  return {
    hist, cycles: cyc, mass, area: A, faceArea, eps0,
    Wout: L.Wout, Wcontraction: L.Wcon, Wreset: L.Wres, Wspring: L.Wspring, Qhot: L.Qhot, Qcold: L.Qcold, stroke: L.stroke,
    Pout: L.Wout * f, specificWork: L.Wout / mass, specificPower: L.Wout * f / mass, eta: L.Qhot > 0 ? L.Wout / L.Qhot : 0, etaCarnot: etaC,
    carnotFraction: etaC > 0 && L.Qhot > 0 ? L.Wout / L.Qhot / etaC : 0, xiSwing: L.xiMax - L.xiMin, xiMin: L.xiMin, xiMax: L.xiMax,
    energyResidual: L.residual / Math.max(1e-12, L.Qhot), periodicity: Math.abs(L.Wout - prev.Wout) / Math.max(1e-12, Math.abs(L.Wout)),
    reverseComplete: L.xiMin < 0.05, forwardComplete: L.xiMax > 0.95,
  };
}

// Quick single-cell screening wrapper with defaults drawn from a design object (see engine.js DEFAULT_ENGINE)
export function cellFromDesign(mat, d, over = {}) {
  return cellTransient({ mat, t: d.ribbonT, w: d.ribbonW, L: d.ribbonL, nRib: d.ribbonsPerCell, n: 6, Th: d.Th, Tc: d.Tc, hHot: d.hHot, hCold: d.hCold, hc: d.hContact, Cw: d.wallCapacity, period: 1 / d.freq, dutyHot: d.dutyHot, tSwitch: d.tSwitch, sBias0: d.sigmaL, kBias: d.kBias, sLoad: Math.max(0, d.sigmaH - d.sigmaL), cycles: 4, stepsPerCycle: 300, ...over });
}
