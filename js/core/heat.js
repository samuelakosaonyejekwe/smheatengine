// Heat-transfer and thermal-fluid core for THERMA-X100: temperature-dependent fluid properties, internal-flow
// correlations (laminar rectangular ducts, developing flow, turbulent), friction factors, ε-NTU / LMTD heat
// exchangers, regenerators (ε-NTU and periodic finite-difference), transient slab conduction with Robin
// boundaries (Crank–Nicolson) and its analytic eigen-series for verification, contact conductance, wet-bulb
// and stream exergy. All quantities SI; temperatures in °C unless the name ends in K.
import { brent, thomas, linspace, clamp, range } from './num.js';
export const KELVIN = 273.15;

// ---------------- Fluid properties ----------------
const R_AIR = 287.05;
export const FLUIDS = {
  'fl-water': { name: 'Water', Tmin: 1, Tmax: 150, props(T) {
    const TK = T + KELVIN;
    const rho = 1000 * (1 - (T + 288.9414) * (T - 3.9863) ** 2 / (508929.2 * (T + 68.12963)));
    const cp = 4217.4 - 3.720283 * T + 0.1412855 * T ** 2 - 2.654387e-3 * T ** 3 + 2.093236e-5 * T ** 4;
    const k = -0.5752 + 6.397e-3 * TK - 8.151e-6 * TK ** 2;
    const mu = 2.414e-5 * 10 ** (247.8 / (TK - 140));
    return { rho, cp, k, mu };
  }, src: 'Kell density fit, polynomial cp, Ramires-type k(T), Vogel viscosity (±1–2 % vs IAPWS-95, 0–100 °C)' },
  'fl-eg50': { name: 'Ethylene glycol / water 50 %', Tmin: -35, Tmax: 120, props(T) { return { rho: 1085 - 0.6 * T, cp: 3200 + 3.0 * T, k: 0.368 + 0.0005 * T, mu: 3.9e-3 * Math.exp(-0.0267 * (T - 25)) }; }, src: 'Linear/exponential fits to ASHRAE secondary-coolant tables (±5 %)' },
  'fl-pg30': { name: 'Propylene glycol / water 30 %', Tmin: -12, Tmax: 110, props(T) { return { rho: 1036 - 0.45 * T, cp: 3740 + 2.5 * T, k: 0.43 + 0.0008 * T, mu: 2.5e-3 * Math.exp(-0.028 * (T - 25)) }; }, src: 'Fits to ASHRAE tables (±5 %)' },
  'fl-oil': { name: 'Synthetic heat-transfer oil', Tmin: -10, Tmax: 300, props(T) { return { rho: 885 - 0.65 * T, cp: 1850 + 3.4 * T, k: 0.135 - 7e-5 * T, mu: 2e-2 * Math.exp(-0.035 * (T - 25)) }; }, src: 'Representative supplier-datasheet fits (±8 %)' },
  'fl-air': { name: 'Air (1 atm)', Tmin: -50, Tmax: 500, props(T) { const TK = T + KELVIN; return { rho: 101325 / (R_AIR * TK), cp: 1007 + 0.0004 * (TK - 300) ** 2 * 0.1, k: 0.0241 * (TK / 273.15) ** 0.81, mu: 1.716e-5 * (TK / 273.15) ** 1.5 * (273.15 + 110.4) / (TK + 110.4) }; }, src: 'Ideal gas, Sutherland viscosity, power-law conductivity' },
};
export function fluid(id, T) {
  const f = FLUIDS[id] || FLUIDS['fl-water']; const Tc = clamp(T, f.Tmin, f.Tmax); const p = f.props(Tc);
  return { ...p, nu: p.mu / p.rho, Pr: p.mu * p.cp / p.k, alpha: p.k / (p.rho * p.cp), T: Tc, clamped: Tc !== T, name: f.name };
}
export const fluidOptions = Object.entries(FLUIDS).map(([value, f]) => ({ value, label: f.name }));

// ---------------- Internal flow ----------------
// Rectangular duct of width a (long side) and height b; aspect ratio α = short/long ≤ 1 (Shah & London 1978)
export function rectDuct(w, hgt) {
  const a = Math.min(w, hgt) / Math.max(w, hgt), A = w * hgt, P = 2 * (w + hgt), Dh = 4 * A / P;
  const fRe = 96 * (1 - 1.3553 * a + 1.9467 * a ** 2 - 1.7012 * a ** 3 + 0.9564 * a ** 4 - 0.2537 * a ** 5);
  const NuT = 7.541 * (1 - 2.610 * a + 4.970 * a ** 2 - 5.119 * a ** 3 + 2.702 * a ** 4 - 0.548 * a ** 5);
  const NuH = 8.235 * (1 - 2.0421 * a + 3.0853 * a ** 2 - 2.4765 * a ** 3 + 1.0578 * a ** 4 - 0.1861 * a ** 5);
  return { aspect: a, A, P, Dh, fRe, NuT, NuH };
}
// Darcy friction factor: laminar fRe/Re, turbulent Swamee–Jain explicit Colebrook, smooth blend in transition
export function darcy(Re, { fRe = 64, rough = 0, Dh = 1 } = {}) {
  if (Re <= 0) return 0;
  const lam = fRe / Re, turb = 0.25 / Math.log10(rough / Dh / 3.7 + 5.74 / Math.max(Re, 2300) ** 0.9) ** 2;
  if (Re < 2300) return lam; if (Re > 4000) return turb;
  const s = (Re - 2300) / 1700; return lam * (1 - s) + turb * s;
}
// Heat-transfer coefficient for duct flow with developing-flow correction (Hausen) and Gnielinski turbulent
export function ductHTC({ fluidId = 'fl-water', T = 40, w = 1e-3, hgt = 0.5e-3, L = 0.1, mdot, velocity, nChannels = 1, rough = 0, bc = 'T' }) {
  const fp = fluid(fluidId, T), d = rectDuct(w, hgt);
  const U = velocity ?? (mdot / nChannels) / (fp.rho * d.A);
  const Re = fp.rho * U * d.Dh / fp.mu, Gz = Re * fp.Pr * d.Dh / Math.max(L, 1e-9);
  const NuFd = bc === 'H' ? d.NuH : d.NuT;
  const NuLam = NuFd + 0.0668 * Gz / (1 + 0.04 * Gz ** (2 / 3));
  const f = darcy(Re, { fRe: d.fRe, rough, Dh: d.Dh });
  const fP = (0.79 * Math.log(Math.max(Re, 3000)) - 1.64) ** -2;
  const NuTurb = (fP / 8) * (Math.max(Re, 3000) - 1000) * fp.Pr / (1 + 12.7 * Math.sqrt(fP / 8) * (fp.Pr ** (2 / 3) - 1));
  let Nu = Re < 2300 ? NuLam : Re > 4000 ? NuTurb : NuLam + (NuTurb - NuLam) * (Re - 2300) / 1700;
  const h = Nu * fp.k / d.Dh, dp = f * (L / d.Dh) * 0.5 * fp.rho * U * U;
  const mdotTot = (mdot ?? fp.rho * U * d.A * nChannels);
  return { ...d, U, Re, Pr: fp.Pr, Gz, Nu, h, f, dp, mdot: mdotTot, Vdot: mdotTot / fp.rho, regime: Re < 2300 ? 'laminar' : Re > 4000 ? 'turbulent' : 'transitional', fp, entryLengthTh: 0.05 * Re * fp.Pr * d.Dh, entryLengthHy: 0.05 * Re * d.Dh };
}
export const pumpPower = (dp, Vdot, eta = 0.5) => dp * Vdot / Math.max(eta, 1e-3);

// ---------------- Heat exchangers ----------------
export function effectivenessNTU(NTU, Cr, arr = 'counter') {
  Cr = clamp(Cr, 0, 1); if (NTU <= 0) return 0;
  if (Cr < 1e-9) return 1 - Math.exp(-NTU);
  switch (arr) {
    case 'parallel': return (1 - Math.exp(-NTU * (1 + Cr))) / (1 + Cr);
    case 'cross': return 1 - Math.exp(NTU ** 0.22 / Cr * (Math.exp(-Cr * NTU ** 0.78) - 1));
    case 'shell': { const s = Math.sqrt(1 + Cr * Cr), e = Math.exp(-NTU * s); return 2 / (1 + Cr + s * (1 + e) / (1 - e)); }
    default: return Math.abs(1 - Cr) < 1e-9 ? NTU / (1 + NTU) : (1 - Math.exp(-NTU * (1 - Cr))) / (1 - Cr * Math.exp(-NTU * (1 - Cr)));
  }
}
export function ntuFromEffectiveness(eps, Cr, arr = 'counter') { if (eps <= 0) return 0; const emax = effectivenessNTU(200, Cr, arr); if (eps >= emax) return Infinity; return brent(n => effectivenessNTU(n, Cr, arr) - eps, 1e-9, 200).x; }
// Two-stream exchanger rating: returns outlet temperatures, duty, LMTD and exergy destruction
export function hxRate({ Thi, Tci, Ch, Cc, UA, arr = 'counter', T0 = 20 }) {
  const Cmin = Math.min(Ch, Cc), Cmax = Math.max(Ch, Cc), Cr = Cmin / Cmax, NTU = UA / Cmin;
  const eps = effectivenessNTU(NTU, Cr, arr), Q = eps * Cmin * (Thi - Tci);
  const Tho = Thi - Q / Ch, Tco = Tci + Q / Cc;
  const d1 = Thi - Tco, d2 = Tho - Tci, lmtd = Math.abs(d1 - d2) < 1e-9 ? d1 : (d1 - d2) / Math.log(d1 / d2);
  const T0K = T0 + KELVIN, Sgen = Ch * Math.log((Tho + KELVIN) / (Thi + KELVIN)) + Cc * Math.log((Tco + KELVIN) / (Tci + KELVIN));
  return { eps, NTU, Cr, Q, Tho, Tco, lmtd, Sgen, Xdest: T0K * Sgen, pinch: Math.min(d1, d2) };
}

// ---------------- Regenerator: periodic counter-flow finite-difference model ----------------
// Matrix of length L split into n cells; hot blow (left→right) then cold blow (right→left), each of duration tb.
// Fluid energy equation quasi-steady (negligible fluid capacity), matrix implicit in time. Iterated to cyclic steady state.
export function regeneratorFD({ n = 40, Cm = 2000, hA = 400, mcpH = 20, mcpC = 20, ThIn = 70, TcIn = 15, tb = 2, steps = 60, maxCycles = 400, tol = 1e-6 }) {
  const Tm = new Float64Array(n).fill((ThIn + TcIn) / 2), cm = Cm / n, ha = hA / n;
  let epsH = 0, epsC = 0, cyc = 0, QH = 0, QC = 0; const hist = [];
  const blow = (Tin, mcp, dir) => {
    let Qtot = 0, Tout = Tin; const Ntu = ha / mcp, a = 1 - Math.exp(-Ntu);
    const sub = Math.max(steps, Math.ceil(2 * tb * mcp * a / cm)), dt = tb / sub; // explicit matrix update stability
    for (let s = 0; s < sub; s++) {
      let Tf = Tin;
      for (let k = 0; k < n; k++) {
        const i = dir > 0 ? k : n - 1 - k;
        // exact exponential approach of fluid to matrix temperature across one cell, matrix updated implicitly
        const TfOut = Tf + a * (Tm[i] - Tf); const q = mcp * (Tf - TfOut);
        Tm[i] = (cm * Tm[i] + dt * q) / cm; Tf = TfOut; Qtot += q * dt;
      }
      Tout = Tf;
    }
    return { Tout, Q: Qtot };
  };
  let ToutH = 0, ToutC = 0;
  for (cyc = 0; cyc < maxCycles; cyc++) {
    const before = Float64Array.from(Tm);
    const hB = blow(ThIn, mcpH, +1), cB = blow(TcIn, mcpC, -1);
    ToutH = hB.Tout; ToutC = cB.Tout; QH = hB.Q; QC = cB.Q;
    let d = 0; for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(Tm[i] - before[i]));
    hist.push(d); if (d < tol) break;
  }
  const Cmin = Math.min(mcpH, mcpC);
  epsH = QH / (Cmin * tb * (ThIn - TcIn)); epsC = -QC / (Cmin * tb * (ThIn - TcIn));
  return { eps: (epsH + epsC) / 2, epsH, epsC, QH, QC, balance: (QH + QC) / Math.max(1e-12, Math.abs(QH)), cycles: cyc + 1, residuals: hist, Tm: Array.from(Tm), ToutH, ToutC, NTU0: hA / Cmin, Lambda: hA * tb / Cm };
}

// ---------------- Transient slab conduction (thickness 2·Lh, symmetric Robin faces) ----------------
// Crank–Nicolson on half-thickness [0, Lh] with symmetry at x=0 and h(T∞ − T) at x=Lh. Optional latent source.
export function slab1D({ Lh, n = 21, k, rho, cp, h, Tinf, T0, tEnd, dt, src = null, record = 50 }) {
  const dx = Lh / (n - 1), alpha = k / (rho * cp), r = alpha * dt / dx / dx, steps = Math.ceil(tEnd / dt);
  let T = new Float64Array(n).fill(T0); const out = { t: [0], Tc: [T0], Ts: [T0], Tm: [T0] };
  const a = new Float64Array(n), b = new Float64Array(n), c = new Float64Array(n), d = new Float64Array(n);
  const Bi = h * dx / k, every = Math.max(1, Math.floor(steps / record));
  for (let s = 1; s <= steps; s++) {
    for (let i = 0; i < n; i++) {
      if (i === 0) { b[i] = 1 + r; c[i] = -r; d[i] = (1 - r) * T[0] + r * T[1]; }
      else if (i === n - 1) { a[i] = -r; b[i] = 1 + r + r * Bi; d[i] = r * T[n - 2] + (1 - r - r * Bi) * T[n - 1] + 2 * r * Bi * Tinf; }
      else { a[i] = -r / 2; b[i] = 1 + r; c[i] = -r / 2; d[i] = r / 2 * T[i - 1] + (1 - r) * T[i] + r / 2 * T[i + 1]; }
      if (src) d[i] += dt * src(i * dx, s * dt, T[i]) / (rho * cp);
    }
    T = Float64Array.from(thomas(Array.from(a), Array.from(b), Array.from(c), Array.from(d)));
    if (s % every === 0 || s === steps) { out.t.push(s * dt); out.Tc.push(T[0]); out.Ts.push(T[n - 1]); let m = 0; for (let i = 0; i < n; i++) m += T[i] * (i === 0 || i === n - 1 ? 0.5 : 1); out.Tm.push(m / (n - 1)); }
  }
  out.profile = Array.from(T); out.x = range(n).map(i => i * dx); out.Bi = h * Lh / k; out.Fo = alpha * tEnd / Lh / Lh;
  return out;
}
// Analytic plane-wall solution (first N eigenvalues of λ tan λ = Bi) — verification benchmark
export function slabAnalytic({ Lh, k, rho, cp, h, Tinf, T0, t, x = 0, N = 30 }) {
  const Bi = h * Lh / k, alpha = k / (rho * cp), Fo = alpha * t / Lh / Lh; let theta = 0;
  for (let i = 0; i < N; i++) {
    const lo = i * Math.PI + 1e-9, hi = i * Math.PI + Math.PI / 2 - 1e-9;
    const lam = brent(l => l * Math.tan(l) - Bi, lo, hi).x;
    const C = 4 * Math.sin(lam) / (2 * lam + Math.sin(2 * lam));
    theta += C * Math.exp(-lam * lam * Fo) * Math.cos(lam * x / Lh);
  }
  return Tinf + (T0 - Tinf) * theta;
}
// Lumped (Biot-corrected) time constant and diffusion scaling of a ribbon heated on both faces
export function ribbonTimescales({ t, k, rho, cp, h }) {
  const Lh = t / 2, Bi = h * Lh / k, alpha = k / (rho * cp);
  return { Bi, alpha, tDiff: Lh * Lh / alpha, tauLumped: rho * cp * Lh / h, tauBiot: rho * cp * Lh / h * (1 + Bi / 3), lumpedValid: Bi < 0.1 };
}

// ---------------- Contact & walls ----------------
// Plastic-contact conductance correlation (Mikic / Yovanovich): hc = 1.25·ks·(m/σ)·(P/Hc)^0.95
export const contactConductance = ({ ks, sigma = 1e-6, slope = 0.1, P, Hc = 1e9 }) => 1.25 * ks * (slope / sigma) * (P / Hc) ** 0.95;
// Series thermal resistance per unit area (m²K/W) of fluid film + wall + contact layer
export const seriesR = (layers) => layers.reduce((s, l) => s + (l.h ? 1 / l.h : l.t / l.k), 0);
export const finEfficiency = (m, L) => (m * L < 1e-9 ? 1 : Math.tanh(m * L) / (m * L));

// ---------------- Atmosphere / sink ----------------
// Stull (2011) wet-bulb temperature from dry-bulb °C and RH % (±0.3 K for 5–99 % RH, −20…50 °C)
export function wetBulb(T, RH) { return T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) + Math.atan(T + RH) - Math.atan(RH - 1.676331) + 0.00391838 * RH ** 1.5 * Math.atan(0.023101 * RH) - 4.686035; }

// ---------------- Thermodynamics of streams ----------------
// Specific flow exergy change of an incompressible stream between T and dead state T0 (°C): cp[(T−T0) − T0K ln(TK/T0K)]
export const streamExergy = (cp, T, T0) => cp * ((T - T0) - (T0 + KELVIN) * Math.log((T + KELVIN) / (T0 + KELVIN)));
export const carnot = (Th, Tc) => (Th > Tc ? 1 - (Tc + KELVIN) / (Th + KELVIN) : 0);
export const curzonAhlborn = (Th, Tc) => (Th > Tc ? 1 - Math.sqrt((Tc + KELVIN) / (Th + KELVIN)) : 0);
// Entropic mean temperature of a stream cooled from Tin to Tout (K) — exergy-correct "source temperature" of a finite-capacity source
export const entropicMean = (Tin, Tout) => { const a = Tin + KELVIN, b = Tout + KELVIN; return Math.abs(a - b) < 1e-9 ? a : (a - b) / Math.log(a / b); };

export { linspace };
