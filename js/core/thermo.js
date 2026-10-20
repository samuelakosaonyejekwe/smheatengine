// Thermal-energy-conversion physics shared by suites 13–18: spectral optics (transfer-matrix method),
// solar & atmospheric spectra, radiative balances, finite-volume conduction, heat-pipe limits,
// shape-memory-alloy constitutive cycles, polymer actuators and bistable elastic cells.
import { logspace, trapz, clamp, brent, range, linspace, mean, SIGMA, KELVIN, SparseBuilder, pcg } from './num.js';
import { psat } from './physics.js';

// ---------------- complex arithmetic ----------------
export const C = (re, im = 0) => ({ re, im });
const add = (a, b) => C(a.re + b.re, a.im + b.im), sub = (a, b) => C(a.re - b.re, a.im - b.im);
const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
const abs2 = (a) => a.re * a.re + a.im * a.im;
const csqrt = (a) => { const r = Math.hypot(a.re, a.im), re = Math.sqrt((r + a.re) / 2), im = Math.sign(a.im || 1) * Math.sqrt(Math.max(0, (r - a.re) / 2)); return C(re, im); };
const cexp = (a) => { const e = Math.exp(a.re); return C(e * Math.cos(a.im), e * Math.sin(a.im)); };

// ---------------- dispersion models (wavelength in µm → complex refractive index n + ik) ----------------
// Drude metals (ħωp, ħγ in eV) and Lorentz-oscillator dielectrics (phonon resonances in wavenumber cm⁻¹).
const EV_UM = 1.23984;
const drude = (wp, g, einf = 1) => (lam) => { const w = EV_UM / lam; const eps = sub(C(einf), div(C(wp * wp), C(w * w, w * g))); return csqrt(eps); };
const lorentz = (einf, osc) => (lam) => { const nu = 1e4 / lam; let eps = C(einf); for (const [S, nu0, gam] of osc) eps = add(eps, div(C(S * nu0 * nu0), C(nu0 * nu0 - nu * nu, -nu * gam))); const n = csqrt(eps); return C(n.re, Math.abs(n.im)); };
export const OPTICAL = {
  Air: { label: 'Air / vacuum', n: () => C(1, 0) },
  Ag: { label: 'Silver (Drude)', n: drude(9.0, 0.021, 3.7) },
  Al: { label: 'Aluminium (Drude)', n: drude(14.8, 0.12, 1) },
  Cr: { label: 'Chromium (Drude, approx.)', n: drude(5.6, 0.95, 3) },
  Ti: { label: 'Titanium (Drude, approx.)', n: drude(7.3, 1.6, 2.5) },
  SiO2: { label: 'Silica SiO₂ (Lorentz, Si–O phonons)', n: lorentz(2.09, [[0.82, 1080, 70], [0.12, 800, 60], [0.65, 460, 40]]) },
  Si3N4: { label: 'Silicon nitride Si₃N₄ (Lorentz)', n: lorentz(4.0, [[2.2, 850, 120], [0.4, 480, 60]]) },
  Al2O3: { label: 'Alumina Al₂O₃ (Lorentz)', n: lorentz(3.1, [[2.6, 640, 60], [3.0, 440, 40]]) },
  TiO2: { label: 'Titania TiO₂ (Lorentz)', n: lorentz(5.8, [[80, 190, 30]]) },
  HfO2: { label: 'Hafnia HfO₂ (Lorentz)', n: lorentz(3.6, [[10, 330, 40]]) },
  PDMS: { label: 'PDMS polymer (Lorentz, C–Si/O bands)', n: lorentz(1.98, [[0.25, 1260, 30], [0.6, 1050, 90], [0.25, 800, 40]]) },
  Cr2O3: { label: 'Chromium oxide Cr₂O₃ (cermet matrix, approx.)', n: (lam) => { const b = lorentz(5.0, [[3, 600, 80]])(lam); return C(b.re, b.im + (lam < 2 ? 0.35 * (2 - lam) : 0)); } },
};
export const parseStack = (txt) => (txt || '').split(/[,;/]+/).map(s => s.trim()).filter(Boolean).map(s => { const [m, d] = s.split(':').map(x => x.trim()); return { mat: m, d: (+d || 0) * 1e-9 }; }).filter(l => OPTICAL[l.mat]);

// Transfer-matrix method for an isotropic multilayer on a semi-infinite substrate.
// Returns R, T, A at wavelength lam (µm), incidence angle th0 (rad), polarisation 's'|'p'.
export function tmm(layers, substrate, lam, th0 = 0, pol = 's', n0 = C(1, 0)) {
  // characteristic-matrix (Macleod) form uses the N = n − ik convention, hence the conjugation
  const ns = [n0, ...layers.map(l => OPTICAL[l.mat].n(lam)), OPTICAL[substrate]?.n(lam) || C(1.5, 0)].map(n => C(n.re, -Math.abs(n.im)));
  const ds = [0, ...layers.map(l => l.d), 0];
  const sin0 = mul(n0, C(Math.sin(th0)));
  const cosT = ns.map(n => { const s = div(sin0, n); return csqrt(sub(C(1), mul(s, s))); });
  const eta = ns.map((n, i) => pol === 's' ? mul(n, cosT[i]) : div(n, cosT[i]));
  let M = [[C(1), C(0)], [C(0), C(1)]];
  for (let j = 1; j < ns.length - 1; j++) {
    const delta = mul(C(2 * Math.PI * ds[j] / (lam * 1e-6)), mul(ns[j], cosT[j]));
    const cd = C(Math.cos(delta.re) * Math.cosh(delta.im), -Math.sin(delta.re) * Math.sinh(delta.im)), sd = C(Math.sin(delta.re) * Math.cosh(delta.im), Math.cos(delta.re) * Math.sinh(delta.im));
    const Lm = [[cd, mul(C(0, 1), div(sd, eta[j]))], [mul(C(0, 1), mul(sd, eta[j])), cd]];
    M = [[add(mul(M[0][0], Lm[0][0]), mul(M[0][1], Lm[1][0])), add(mul(M[0][0], Lm[0][1]), mul(M[0][1], Lm[1][1]))], [add(mul(M[1][0], Lm[0][0]), mul(M[1][1], Lm[1][0])), add(mul(M[1][0], Lm[0][1]), mul(M[1][1], Lm[1][1]))]];
  }
  const es = eta[eta.length - 1], e0 = eta[0];
  const B = add(M[0][0], mul(M[0][1], es)), Cc = add(M[1][0], mul(M[1][1], es));
  const den = add(mul(e0, B), Cc), r = div(sub(mul(e0, B), Cc), den);
  const R = abs2(r), T = 4 * e0.re * es.re / abs2(den);
  const subsAbsorbing = (OPTICAL[substrate]?.n(lam) || C(1.5)).im > 1e-3;
  return { R, T: subsAbsorbing ? 0 : Math.max(0, T), A: Math.max(0, 1 - R - (subsAbsorbing ? 0 : Math.max(0, T))), Tsub: T };
}
// Hemispherical (unpolarised) absorptance by Gauss-type angular integration ε_h = 2∫A cosθ sinθ dθ
export function hemiAbsorptance(layers, substrate, lam, nAng = 9) {
  const th = linspace(0, Math.PI / 2 * 0.995, nAng); const f = th.map(t => 0.5 * (tmm(layers, substrate, lam, t, 's').A + tmm(layers, substrate, lam, t, 'p').A) * Math.cos(t) * Math.sin(t) * 2);
  return trapz(f, th);
}

// ---------------- spectra ----------------
export const LAMBDA = logspace(Math.log10(0.28), Math.log10(40), 260); // µm
export const planckLam = (lam_um, T) => { const l = lam_um * 1e-6, c1 = 3.741771852e-16, c2 = 1.438776877e-2; return c1 / (l ** 5 * (Math.exp(c2 / (l * T)) - 1)) * 1e-6; }; // spectral emissive power πB, W/(m²·µm)
// AM1.5G-like terrestrial solar spectrum: 5778 K solar disc at 1 au, attenuated by Rayleigh scattering,
// ozone (< 0.32 µm, Chappuis band) and H2O/O2/CO2 bands; normalised to the requested total irradiance.
// This is a screening APPROXIMATION of ASTM G173, not the tabulated standard.
const BANDS = [[0.687, 0.006, 0.4], [0.762, 0.005, 0.8], [0.72, 0.012, 0.25], [0.82, 0.015, 0.25], [0.94, 0.03, 0.75], [1.13, 0.035, 0.75], [1.38, 0.06, 0.97], [1.87, 0.08, 0.98], [2.7, 0.15, 1.0], [4.3, 0.1, 1.0], [6.3, 0.6, 1.0]];
export function solarShape(lam) {
  const toa = planckLam(lam, 5778) * 2.165e-5; // (R_sun / 1 au)²
  const ray = Math.exp(-0.0088 * lam ** -4.05 * 1.5), oz = lam < 0.32 ? Math.exp(-(((0.32 - lam) / 0.012) ** 1.5) * 3) : lam > 0.5 && lam < 0.7 ? 0.97 : 1;
  let mol = 1; for (const [c, w, d] of BANDS) mol *= 1 - d * Math.exp(-0.5 * (((lam - c) / w) ** 2));
  return toa * ray * oz * mol * (lam > 3.0 ? 0.3 : 1);
}
const SOL_INT = trapz(LAMBDA.map(solarShape), LAMBDA);
export const solarSpectrum = (lam, G = 1000) => solarShape(lam) * G / SOL_INT; // W/(m²·µm)
// Atmospheric spectral transmittance shape: 8–13 µm main window (ozone dip 9.4–10 µm), 3.4–4.1 µm minor window
export function windowShape(lam) { if (lam >= 7.9 && lam <= 13.2) return (lam > 9.35 && lam < 10.0) ? 0.55 : 1 - 0.25 * Math.exp(-(((lam - 8) / 0.3) ** 2)) - 0.25 * Math.exp(-(((lam - 13) / 0.3) ** 2)); if (lam >= 3.4 && lam <= 4.15) return 0.6; if (lam >= 16 && lam <= 22) return 0.12; return 0; }
// Calibrate window transmittance so the hemispherical sky emissivity equals the broadband value (e.g. from Suite 05)
export function skySpectralEmissivity(TaK, epsBroad) {
  const Eb = LAMBDA.map(l => planckLam(l, TaK)), tot = trapz(Eb, LAMBDA), F = trapz(LAMBDA.map((l, i) => windowShape(l) * Eb[i]), LAMBDA) / tot;
  const tw = clamp((1 - epsBroad) / (F || 1e-9), 0, 0.98);
  return { tw, fn: (lam) => 1 - tw * windowShape(lam), windowFraction: F };
}
// Precipitable water (cm) from dew point (Leckner-type empirical relation)
export const precipitableWater = (TdC) => Math.exp(0.07 * TdC - 0.075);

// ---------------- surface spectral properties ----------------
// Band representation of a library coating: selective absorber (cut-off ≈ 2.5 µm) or radiator (window-enhanced)
export function surfaceSpectrum(mat, stack) {
  if (stack && stack.layers.length) return (lam) => (lam < 4 ? tmm(stack.layers, stack.substrate, lam, 0).A : hemiAbsorptance(stack.layers, stack.substrate, lam, 7));
  const o = mat?.optics || { aSolar: 0.9, eIR: 0.9, eWindow: 0.9 };
  const selective = o.aSolar > o.eIR + 0.2;
  if (selective) return (lam) => o.eIR + (o.aSolar - o.eIR) / (1 + Math.exp((lam - 2.4) / 0.18));
  return (lam) => lam < 2.5 ? o.aSolar : lam < 4 ? o.aSolar + (o.eIR - o.aSolar) * (lam - 2.5) / 1.5 : (windowShape(lam) > 0.5 ? o.eWindow : o.eIR);
}
// Pre-tabulate ε(λ) on the global grid (stack evaluation is costly)
export const tabulate = (fn) => LAMBDA.map(fn);
// Integrated radiative quantities for a surface ε(λ) table
export function radiativeTerms(epsTab, TsK, TaK, skyFn, G) {
  const emit = trapz(LAMBDA.map((l, i) => epsTab[i] * planckLam(l, TsK)), LAMBDA);
  const atm = trapz(LAMBDA.map((l, i) => epsTab[i] * skyFn(l) * planckLam(l, TaK)), LAMBDA);
  const solAbs = G > 0 ? trapz(LAMBDA.map((l, i) => epsTab[i] * solarSpectrum(l, G)), LAMBDA) : 0;
  return { emit, atm, solAbs };
}
export function solarWeighted(epsTab) { const s = LAMBDA.map(l => solarSpectrum(l, 1000)); return trapz(LAMBDA.map((l, i) => epsTab[i] * s[i]), LAMBDA) / trapz(s, LAMBDA); }
export function thermalWeighted(epsTab, TK) { const b = LAMBDA.map(l => planckLam(l, TK)); return trapz(LAMBDA.map((l, i) => epsTab[i] * b[i]), LAMBDA) / trapz(b, LAMBDA); }
export function windowWeighted(epsTab, TK) { const b = LAMBDA.map(l => planckLam(l, TK) * windowShape(l)); return trapz(LAMBDA.map((l, i) => epsTab[i] * b[i]), LAMBDA) / (trapz(b, LAMBDA) || 1); }
// Net useful heat into an absorber at Ts (W/m²): αG − (emission − absorbed sky) − h(Ts−Ta)
// Net cooling power of a radiator at Ts (W/m²): emission − absorbed sky − absorbed sun − h(Ta−Ts)
// Radiative terms are linearised around Ts on a coarse table for speed.
export function balanceCurves(epsTab, TaK, skyFn, G, h, Trange) {
  return Trange.map(T => { const r = radiativeTerms(epsTab, T, TaK, skyFn, G); return { T, absorber: r.solAbs - (r.emit - r.atm) - h * (T - TaK), radiator: (r.emit - r.atm) - r.solAbs - h * (TaK - T), ...r }; });
}
export const mcAdamsH = (U) => 5.7 + 3.8 * Math.max(0, U); // wind-forced convection coefficient W/(m²K)

// ---------------- conduction (cell-centred finite volume, anisotropic) ----------------
// grid: {nx, ny, dx, dy, kx[], ky[], rc[] (ρc_p)}, bc: {left,right,bottom,top}: each either {type:'T',T}, {type:'q',q (into domain, W/m²)},
// {type:'h',h,Tinf} or {type:'mixed', fn:(i or j)=>bcObj}. Internal contact resistances by face masks.
export function conduction2D(grid, bc, { T0 = 293, tEnd = 0, steady = true, tol = 1e-6, maxIt = 40000, rcx = null, record = 0 } = {}) {
  const { nx, ny, dx, dy, kx, ky, rc } = grid, N = nx * ny, id = (i, j) => j * nx + i;
  const Gx = new Float64Array(N), Gy = new Float64Array(N); // conductance to east / north neighbour (W/K per unit depth)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = id(i, j); if (i < nx - 1) { const R = dx / 2 / kx[k] + dx / 2 / kx[k + 1] + (rcx ? rcx(i, j, 'x') : 0); Gx[k] = dy / R; } if (j < ny - 1) { const R = dy / 2 / ky[k] + dy / 2 / ky[k + nx] + (rcx ? rcx(i, j, 'y') : 0); Gy[k] = dx / R; } }
  const bcAt = (side, s) => { const b = bc[side]; return b?.type === 'mixed' ? b.fn(s) : b; };
  const boundary = (k, i, j) => { // returns [Gsum, source] boundary contributions
    let G = 0, S = 0; const add_ = (b, len, d, kk) => { if (!b) return; if (b.type === 'T') { const g = len / (d / 2 / kk); G += g; S += g * b.T; } else if (b.type === 'q') S += b.q * len; else if (b.type === 'h') { const g = len / (1 / b.h + d / 2 / kk); G += g; S += g * b.Tinf; } };
    if (i === 0) add_(bcAt('left', j), dy, dx, kx[k]); if (i === nx - 1) add_(bcAt('right', j), dy, dx, kx[k]);
    if (j === 0) add_(bcAt('bottom', i), dx, dy, ky[k]); if (j === ny - 1) add_(bcAt('top', i), dx, dy, ky[k]);
    return [G, S];
  };
  const BG = new Float64Array(N), BS = new Float64Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = id(i, j); const [g, s] = boundary(k, i, j); BG[k] = g; BS[k] = s; }
  const T = new Float64Array(N).fill(T0); const hist = [], snaps = [];
  const neighSum = (k, i, j, TT) => { let a = BG[k], b = BS[k]; if (i > 0) { a += Gx[k - 1]; b += Gx[k - 1] * TT[k - 1]; } if (i < nx - 1) { a += Gx[k]; b += Gx[k] * TT[k + 1]; } if (j > 0) { a += Gy[k - nx]; b += Gy[k - nx] * TT[k - nx]; } if (j < ny - 1) { a += Gy[k]; b += Gy[k] * TT[k + nx]; } return [a, b]; };
  if (tEnd > 0) { // explicit transient (stable step)
    let gmax = 0; for (let k = 0; k < N; k++) { const i = k % nx, j = (k / nx) | 0; const [a] = neighSum(k, i, j, T); gmax = Math.max(gmax, a / (rc[k] * dx * dy)); }
    const dt = 0.45 / gmax, nSteps = Math.ceil(tEnd / dt), h_ = tEnd / nSteps, Tn = new Float64Array(N), every = Math.max(1, Math.floor(nSteps / 200));
    for (let s = 0; s < nSteps; s++) { for (let k = 0; k < N; k++) { const i = k % nx, j = (k / nx) | 0; const [a, b] = neighSum(k, i, j, T); Tn[k] = T[k] + h_ * (b - a * T[k]) / (rc[k] * dx * dy); } T.set(Tn); if (s % every === 0) hist.push({ t: (s + 1) * h_, Tmean: mean(T), Tmax: Math.max(...T), Tmin: Math.min(...T) }); if (record && s % Math.max(1, Math.floor(nSteps / record)) === 0) snaps.push(Float64Array.from(T)); }
    return { T, hist, dt: h_, steps: nSteps, snaps, Gx, Gy };
  }
  // steady: assemble the symmetric positive-definite FV system and solve with preconditioned CG
  if (!grid.sor) {
    const A = new SparseBuilder(N), b = new Float64Array(N);
    for (let k = 0; k < N; k++) { const i = k % nx, j = (k / nx) | 0; let d = BG[k]; b[k] = BS[k]; const nb = []; if (i > 0) nb.push([k - 1, Gx[k - 1]]); if (i < nx - 1) nb.push([k + 1, Gx[k]]); if (j > 0) nb.push([k - nx, Gy[k - nx]]); if (j < ny - 1) nb.push([k + nx, Gy[k]]); for (const [m, g] of nb) { d += g; A.add(k, m, -g); } A.add(k, k, d || 1e-12); }
    const sol = pcg(A.toCSR(), b, { tol: 1e-13, maxIt: 20000, x0: new Float64Array(N).fill(T0) });
    T.set(sol.x);
    let res = 0; for (let k = 0; k < N; k++) { const i = k % nx, j = (k / nx) | 0; const [a, bb] = neighSum(k, i, j, T); if (a) res = Math.max(res, Math.abs(bb / a - T[k])); }
    return { T, hist: sol.hist, iterations: sol.it, residual: res, Gx, Gy, BG, BS, solver: 'PCG' };
  }
  // SOR Gauss–Seidel (option)
  const w = 1.85; let res = 1, it = 0;
  for (; it < maxIt && res > tol; it++) { res = 0; for (let k = 0; k < N; k++) { const i = k % nx, j = (k / nx) | 0; const [a, b] = neighSum(k, i, j, T); if (!a) continue; const Tn = b / a, d = Tn - T[k]; T[k] += w * d; res = Math.max(res, Math.abs(d)); } if (it % 20 === 0) hist.push(res); }
  return { T, hist, iterations: it, residual: res, Gx, Gy, BG, BS };
}

// ---------------- heat pipes (water working fluid) ----------------
export function waterProps(TC) { const T = TC + KELVIN; return { sigma: 0.0757 - 0.000167 * TC, muL: 2.414e-5 * 10 ** (247.8 / (T - 140)), rhoL: 1000 - 0.0178 * Math.abs(TC - 4) ** 1.7, hfg: 2.501e6 - 2370 * TC, Pv: psat(TC), rhoV: psat(TC) / (461.5 * T), muV: 8.0e-6 + 4e-8 * TC, T }; }
export function heatPipeLimits({ TC = 30, dOuter = 0.008, wall = 0.0005, wick = 0.0007, L = 0.3, Le = 0.08, Lc = 0.08, tilt = 0, rPore = 50e-6, perm = 8e-11, kWick = 40, rNuc = 2e-6 } = {}) {
  const w = waterProps(TC), ri = dOuter / 2 - wall, rv = ri - wick, Av = Math.PI * rv * rv, Aw = Math.PI * (ri * ri - rv * rv), Leff = L - (Le + Lc) / 2;
  const dPcap = 2 * w.sigma / rPore, dPg = w.rhoL * 9.81 * L * Math.sin(tilt * Math.PI / 180);
  const cap = Math.max(0, (dPcap - dPg) * w.rhoL * perm * Aw * w.hfg / (w.muL * Leff));
  const sonic = 0.474 * Av * w.hfg * Math.sqrt(w.rhoV * w.Pv);
  const entr = Av * w.hfg * Math.sqrt(w.sigma * w.rhoV / (2 * rPore));
  const visc = Av * rv * rv * w.hfg * w.rhoV * w.Pv / (16 * w.muV * Leff);
  const boil = Math.max(0, 2 * Math.PI * Le * kWick * w.T / (w.hfg * w.rhoV * Math.log(ri / rv)) * (2 * w.sigma / rNuc - dPcap));
  const lim = { capillary: cap, sonic, entrainment: entr, viscous: visc, boiling: boil };
  const governing = Object.entries(lim).sort((a, b) => a[1] - b[1])[0];
  return { ...lim, Qmax: governing[1], governing: governing[0], frozen: TC < 1, props: w };
}

// ---------------- shape-memory alloy 1-D constitutive model ----------------
// Liang–Rogers cosine kinetics with Brinson-type stress-dependent transformation temperatures
// (Clausius–Clapeyron slopes CM, CA in MPa/K) and Reuss-averaged modulus; ξ = martensite volume fraction.
export class SMA {
  constructor(m) { Object.assign(this, { EA: m.EA * 1e9, EM: m.EM * 1e9, Ms: m.Ms, Mf: m.Mf, As: m.As, Af: m.Af, CM: m.CM, CA: m.CA, epsL: m.epsL, Lh: m.Lh, rho: m.rho, cp: m.cp, alpha: (m.alpha || 11) * 1e-6, k: m.k || 18 }); this.xi = 1; this.xs = 1; this.dir = 0; }
  E(xi = this.xi) { return 1 / (xi / this.EM + (1 - xi) / this.EA); }
  temps(sMPa) { const s = Math.max(0, sMPa); return { Ms: this.Ms + s / this.CM, Mf: this.Mf + s / this.CM, As: this.As + s / this.CA, Af: this.Af + s / this.CA }; }
  // advance ξ for new (T °C, σ MPa); rate-independent with memory of segment start ξs
  update(T, sMPa) {
    const t = this.temps(sMPa); let xi = this.xi;
    let fwd = xi; if (T <= t.Mf) fwd = 1; else if (T < t.Ms) { if (this.dir !== 1) this.xsF = xi; const x0 = this.xsF ?? xi; fwd = Math.max(xi, (1 - x0) / 2 * Math.cos(Math.PI / (t.Ms - t.Mf) * (T - t.Mf)) + (1 + x0) / 2); }
    let rev = xi; if (T >= t.Af) rev = 0; else if (T > t.As) { if (this.dir !== -1) this.xsR = xi; const x0 = this.xsR ?? xi; rev = Math.min(xi, x0 / 2 * (Math.cos(Math.PI / (t.Af - t.As) * (T - t.As)) + 1)); }
    if (fwd > xi + 1e-12) { this.xi = clamp(fwd, 0, 1); this.dir = 1; } else if (rev < xi - 1e-12) { this.xi = clamp(rev, 0, 1); this.dir = -1; }
    return this.xi;
  }
  strain(sMPa, T, T0 = 20) { return sMPa * 1e6 / this.E() + this.epsL * this.xi + this.alpha * (T - T0); }
}
// Isobaric-pair heat-engine cycle (load σH while heating, σL while cooling), the canonical SMA actuator cycle.
// Returns the (σ, ε, T, ξ) path, net specific work, heat input, efficiency and transformation diagnostics.
export function smaCycle(mat, { Th, Tc, sH, sL, nSeg = 80, cycles = 3 } = {}) {
  const m = new SMA(mat); m.xi = 1; m.dir = 0;
  // settle at cold low-stress state
  for (const T of linspace(Math.max(Th, Tc) + 5, Tc, 60)) m.update(T, sL);
  const path = []; const rec = (s, T) => { m.update(T, s); path.push({ s, T, xi: m.xi, e: m.strain(s, T) }); };
  let start = 0;
  for (let c = 0; c < cycles; c++) {
    if (c === cycles - 1) start = path.length;
    for (const s of linspace(sL, sH, nSeg / 4)) rec(s, Tc);          // 1 load at cold
    for (const T of linspace(Tc, Th, nSeg / 4)) rec(sH, T);          // 2 heat under high stress → recovery stroke
    for (const s of linspace(sH, sL, nSeg / 4)) rec(s, Th);          // 3 unload at hot
    for (const T of linspace(Th, Tc, nSeg / 4)) rec(sL, T);          // 4 cool under low stress → reset stroke
  }
  const P = path.slice(start);
  let w = 0; for (let i = 1; i < P.length; i++) w += -0.5 * (P[i].s + P[i - 1].s) * 1e6 * (P[i].e - P[i - 1].e); // J/m³ output (contraction under load)
  // closure error between end of last cycle and start (repeatability)
  const closure = Math.abs(P[P.length - 1].e - P[0].e);
  // reverse transformation over heating + hot unloading, forward over cooling + cold loading
  const q = Math.floor(P.length / 4), dXiHeat = Math.max(0, P[q - 1].xi - P[3 * q - 1].xi), dXiCool = Math.max(0, P[P.length - 1].xi - P[3 * q - 1].xi);
  const wJkg = w / mat.rho, qIn = mat.cp * Math.max(0, Th - Tc) + mat.Lh * Math.max(0, dXiHeat) + Math.max(0, wJkg); // J/kg heat supplied on heating leg
  const etaC = 1 - (Tc + KELVIN) / (Th + KELVIN);
  return { path: P, w_J_m3: w, w_J_kg: wJkg, qIn_J_kg: qIn, eta: qIn > 0 ? wJkg / qIn : 0, etaCarnot: Math.max(0, etaC), dXiHeat, dXiCool, closure, temps: { H: m.temps(sH), L: m.temps(sL) }, strokeStrain: Math.max(...P.map(p => p.e)) - Math.min(...P.map(p => p.e)) };
}
// Lumped thermal response of a lamella of thickness t (contact on one face) with interface conductance hc.
export function lamellaTiming(mat, { t, hc, Th, Tc, Ttarget_h, Ttarget_c, latentDxi = 0, dT_tr = 15 }) {
  const alpha = mat.k / (mat.rho * mat.cp), Bi = hc * t / mat.k, cpEff = mat.cp + (mat.Lh || 0) * latentDxi / Math.max(3, dT_tr);
  const tau = mat.rho * cpEff * t / hc * (1 + Bi / 3); // Biot correction for internal conduction
  const tDiff = t * t / alpha;
  const tH = (Ttarget_h >= Th) ? Infinity : tau * Math.log(Math.max(1e-9, (Th - Tc) / (Th - Ttarget_h)));
  const tC = (Ttarget_c <= Tc) ? Infinity : tau * Math.log(Math.max(1e-9, (Th - Tc) / (Ttarget_c - Tc)));
  return { tau, tDiff, Bi, tHeat: Math.max(0, tH), tCool: Math.max(0, tC) };
}
// Empirical functional/structural fatigue estimate for NiTi actuators (order-of-magnitude, literature trend):
// N ≈ 1e5 · (3 % / ε_tr)^3 · (200 MPa / σ_H)^2, capped by the alloy's structural endurance
export const smaFatigue = (epsTr, sH) => clamp(1e5 * (0.03 / Math.max(1e-4, epsTr)) ** 3 * (200 / Math.max(1, sH)) ** 2, 1e2, 1e9);

// ---------------- thermoresponsive polymer actuators ----------------
export function polymerCycle(mat, { Th, Tc, sLoad, fractionReached = 1 }) {
  // free actuation strain from (dε/dT)ΔT, reduced linearly towards the blocked stress (load line of a thermal muscle)
  const free = (mat.strainPerK || 0.001) * Math.max(0, Th - Tc) * fractionReached, sB = mat.stressMax || 10;
  const s = Math.min(sLoad, sB), strain = free * Math.max(0, 1 - s / sB), w = s * 1e6 * strain; // J/m³
  const wJkg = w / mat.rho, qIn = mat.cp * Math.max(0, Th - Tc) * fractionReached + wJkg;
  return { w_J_m3: w, w_J_kg: wJkg, qIn_J_kg: qIn, eta: qIn ? wJkg / qIn : 0, strokeStrain: strain, sUsed: s };
}

// ---------------- bistable elastic cell (von Mises truss + parallel spring) ----------------
export function bistableCell({ E, A, b, hRise, ksRatio, sy, I }) {
  const L0 = Math.hypot(b, hRise), EA = E * A, kStar = EA * hRise * hRise / L0 ** 3, ks = ksRatio * kStar;
  const U = (u) => { const L = Math.hypot(b, hRise - u); return EA / L0 * (L - L0) ** 2 + 0.5 * ks * u * u; };
  const F = (u) => { const L = Math.hypot(b, hRise - u); return -2 * EA / L0 * (L - L0) * (hRise - u) / L + ks * u; };
  const strainAt = (u) => (Math.hypot(b, hRise - u) - L0) / L0;
  const us = linspace(0, 2.4 * hRise, 481), Us = us.map(U), Fs = us.map(F);
  const minima = [], maxima = []; for (let i = 1; i < us.length - 1; i++) { if (Us[i] < Us[i - 1] && Us[i] <= Us[i + 1]) minima.push(i); if (Us[i] > Us[i - 1] && Us[i] >= Us[i + 1]) maxima.push(i); }
  const bistable = minima.length >= 1 && maxima.length >= 1 && us[minima[minima.length - 1]] > us[maxima[0]];
  const i2 = bistable ? minima[minima.length - 1] : us.length - 1, iB = maxima[0] ?? Math.floor(us.length / 2);
  const Estore = Us[i2] - Us[0], barrierCharge = Us[iB] - Us[0], barrierRelease = Us[iB] - Us[i2];
  const maxStrain = Math.max(...us.slice(0, i2 + 1).map(u => Math.abs(strainAt(u)))), Ncomp = EA * maxStrain;
  const Pcr = I ? Math.PI ** 2 * E * I / L0 ** 2 : Infinity;
  const Fmax = Math.max(...Fs.slice(0, iB + 1)), Fmin = Math.min(...Fs.slice(iB, i2 + 1));
  return { L0, EA, kStar, ks, us, Us, Fs, bistable, u2: us[i2], uBarrier: us[iB], Estore, barrierCharge, barrierRelease, maxStrain, Ncomp, Pcr, Fmax, Fmin, strainOK: maxStrain * E <= sy * 1e6 };
}
export { brent, range };
