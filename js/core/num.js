// THERMA-X100 numerical core: arrays, roots, ODEs, linear algebra, statistics, convergence.
// All quantities are SI unless stated otherwise.

export const G0 = 9.80665, R_AIR = 287.058, R_V = 461.495, SIGMA = 5.670374419e-8,
  KB = 1.380649e-23, H_PL = 6.62607015e-34, C_LIGHT = 299792458, KELVIN = 273.15;

// ---------- array helpers ----------
export const linspace = (a, b, n) => { const o = new Array(n); if (n === 1) { o[0] = a; return o; } for (let i = 0; i < n; i++) o[i] = a + (b - a) * i / (n - 1); return o; };
export const logspace = (a, b, n) => linspace(a, b, n).map(v => 10 ** v);
export const range = (a, b) => { const s = b === undefined ? 0 : a, n = Math.max(0, ((b === undefined ? a : b - a) | 0)), o = new Array(n); for (let i = 0; i < n; i++) o[i] = s + i; return o; };
export const sum = (a) => { let s = 0; for (const v of a) s += v; return s; };
export const mean = (a) => a.length ? sum(a) / a.length : NaN;
export const std = (a) => { const m = mean(a); return Math.sqrt(sum(a.map(v => (v - m) ** 2)) / Math.max(1, a.length - 1)); };
export const min = (a) => a.reduce((m, v) => v < m ? v : m, Infinity);
export const max = (a) => a.reduce((m, v) => v > m ? v : m, -Infinity);
export const argmin = (a) => a.reduce((bi, v, i) => v < a[bi] ? i : bi, 0);
export const argmax = (a) => a.reduce((bi, v, i) => v > a[bi] ? i : bi, 0);
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const deg = (r) => r * 180 / Math.PI;
export const rad = (d) => d * Math.PI / 180;
export const sq = (x) => x * x;
export const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function trapz(y, x) {
  let s = 0;
  for (let i = 1; i < y.length; i++) s += 0.5 * (y[i] + y[i - 1]) * (x ? (x[i] - x[i - 1]) : 1);
  return s;
}
export function cumtrapz(y, x) {
  const o = [0];
  for (let i = 1; i < y.length; i++) o.push(o[i - 1] + 0.5 * (y[i] + y[i - 1]) * (x ? (x[i] - x[i - 1]) : 1));
  return o;
}
export function interp1(xs, ys, x, extrap = 'clamp') {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]) return extrap === 'linear' && n > 1 ? ys[0] + (ys[1] - ys[0]) * (x - xs[0]) / (xs[1] - xs[0]) : ys[0];
  if (x >= xs[n - 1]) return extrap === 'linear' && n > 1 ? ys[n - 1] + (ys[n - 1] - ys[n - 2]) * (x - xs[n - 1]) / (xs[n - 1] - xs[n - 2]) : ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] > x) hi = m; else lo = m; }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}
export function bilinear(xs, ys, Z, x, y) { // Z[j][i] with y index j, x index i
  const i = clamp(xs.findIndex(v => v > x) - 1, 0, xs.length - 2), j = clamp(ys.findIndex(v => v > y) - 1, 0, ys.length - 2);
  const tx = clamp((x - xs[i]) / (xs[i + 1] - xs[i]), 0, 1), ty = clamp((y - ys[j]) / (ys[j + 1] - ys[j]), 0, 1);
  return (1 - tx) * (1 - ty) * Z[j][i] + tx * (1 - ty) * Z[j][i + 1] + (1 - tx) * ty * Z[j + 1][i] + tx * ty * Z[j + 1][i + 1];
}
export function movingAverage(a, w) {
  const o = new Array(a.length); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= w) s -= a[i - w]; o[i] = s / Math.min(i + 1, w); }
  return o;
}

// ---------- roots & 1-D minimisation ----------
export function bisect(f, a, b, tol = 1e-10, maxIt = 200) {
  let fa = f(a), fb = f(b);
  if (fa * fb > 0) return { x: NaN, ok: false, it: 0 };
  let m = a;
  for (let i = 0; i < maxIt; i++) {
    m = 0.5 * (a + b); const fm = f(m);
    if (Math.abs(fm) < tol || (b - a) / 2 < tol) return { x: m, ok: true, it: i };
    if (fa * fm < 0) { b = m; fb = fm; } else { a = m; fa = fm; }
  }
  return { x: m, ok: true, it: maxIt };
}
export function brent(f, a, b, tol = 1e-12, maxIt = 200) {
  let fa = f(a), fb = f(b);
  if (fa * fb > 0) return { x: NaN, ok: false, it: 0 };
  if (Math.abs(fa) < Math.abs(fb)) { [a, b] = [b, a]; [fa, fb] = [fb, fa]; }
  let c = a, fc = fa, d = b - a, mflag = true;
  for (let it = 0; it < maxIt; it++) {
    if (Math.abs(fb) < tol || Math.abs(b - a) < tol) return { x: b, ok: true, it };
    let s;
    if (fa !== fc && fb !== fc) s = a * fb * fc / ((fa - fb) * (fa - fc)) + b * fa * fc / ((fb - fa) * (fb - fc)) + c * fa * fb / ((fc - fa) * (fc - fb));
    else s = b - fb * (b - a) / (fb - fa);
    const cond = (s < (3 * a + b) / 4 || s > b) && (s > (3 * a + b) / 4 || s < b);
    if (cond || (mflag && Math.abs(s - b) >= Math.abs(b - c) / 2) || (!mflag && Math.abs(s - b) >= Math.abs(c - d) / 2)) { s = (a + b) / 2; mflag = true; } else mflag = false;
    const fs = f(s); d = c; c = b; fc = fb;
    if (fa * fs < 0) { b = s; fb = fs; } else { a = s; fa = fs; }
    if (Math.abs(fa) < Math.abs(fb)) { [a, b] = [b, a]; [fa, fb] = [fb, fa]; }
  }
  return { x: b, ok: true, it: maxIt };
}
export function newton(f, x0, { df, tol = 1e-10, maxIt = 60, h = 1e-7, damp = 1 } = {}) {
  let x = x0;
  for (let i = 0; i < maxIt; i++) {
    const fx = f(x);
    const d = df ? df(x) : (f(x + h) - f(x - h)) / (2 * h);
    if (!d) return { x, ok: false, it: i };
    const dx = damp * fx / d; x -= dx;
    if (Math.abs(dx) < tol * (1 + Math.abs(x))) return { x, ok: true, it: i };
  }
  return { x, ok: false, it: maxIt };
}
export function goldenMin(f, a, b, tol = 1e-8) {
  const g = (Math.sqrt(5) - 1) / 2; let c = b - g * (b - a), d = a + g * (b - a);
  while (Math.abs(b - a) > tol) { if (f(c) < f(d)) b = d; else a = c; c = b - g * (b - a); d = a + g * (b - a); }
  return (a + b) / 2;
}
// Find bracket where f changes sign by scanning
export function scanRoots(f, a, b, n = 200) {
  const roots = []; let x0 = a, f0 = f(a);
  for (let i = 1; i <= n; i++) {
    const x1 = a + (b - a) * i / n, f1 = f(x1);
    if (f0 === 0) roots.push(x0); else if (f0 * f1 < 0) { const r = brent(f, x0, x1); if (r.ok) roots.push(r.x); }
    x0 = x1; f0 = f1;
  }
  return roots;
}

// ---------- ODE integration ----------
export function rk4(f, t0, y0, t1, n) {
  const h = (t1 - t0) / n; let y = y0.slice(), t = t0; const T = [t], Y = [y.slice()];
  for (let i = 0; i < n; i++) {
    const k1 = f(t, y), k2 = f(t + h / 2, y.map((v, j) => v + h / 2 * k1[j])), k3 = f(t + h / 2, y.map((v, j) => v + h / 2 * k2[j])), k4 = f(t + h, y.map((v, j) => v + h * k3[j]));
    y = y.map((v, j) => v + h / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j])); t += h; T.push(t); Y.push(y.slice());
  }
  return { t: T, y: Y };
}
// Dormand–Prince 5(4) adaptive with optional event function (returns value whose zero-crossing stops integration)
export function rk45(f, t0, y0, t1, { rtol = 1e-6, atol = 1e-9, h0, hmax = Infinity, maxSteps = 200000, event, dense = 0 } = {}) {
  const a = [[], [1 / 5], [3 / 40, 9 / 40], [44 / 45, -56 / 15, 32 / 9], [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729], [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656], [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84]];
  const c = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
  const b5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
  const b4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];
  let t = t0, y = y0.slice(), h = h0 || (t1 - t0) / 100; const n = y.length;
  const T = [t], Y = [y.slice()]; let steps = 0, rejected = 0, ev0 = event ? event(t, y) : 0, stoppedBy = null;
  while (t < t1 && steps < maxSteps) {
    if (t + h > t1) h = t1 - t;
    const k = [];
    for (let s = 0; s < 7; s++) {
      const ys = y.slice();
      for (let j = 0; j < s; j++) { const aij = a[s][j]; if (aij) for (let i = 0; i < n; i++) ys[i] += h * aij * k[j][i]; }
      k.push(f(t + c[s] * h, ys));
    }
    const y5 = y.slice(), y4 = y.slice();
    for (let i = 0; i < n; i++) for (let s = 0; s < 7; s++) { y5[i] += h * b5[s] * k[s][i]; y4[i] += h * b4[s] * k[s][i]; }
    let err = 0;
    for (let i = 0; i < n; i++) { const sc = atol + rtol * Math.max(Math.abs(y[i]), Math.abs(y5[i])); err = Math.max(err, Math.abs(y5[i] - y4[i]) / sc); }
    if (err <= 1 || h < 1e-14) {
      t += h; y = y5; steps++;
      if (!dense || T.length === 0 || t - T[T.length - 1] >= dense || t >= t1) { T.push(t); Y.push(y.slice()); }
      if (event) { const ev = event(t, y); if (ev0 * ev < 0 || ev === 0) { stoppedBy = 'event'; break; } ev0 = ev; }
    } else rejected++;
    h = Math.min(hmax, h * Math.min(5, Math.max(0.2, 0.9 * Math.pow(err || 1e-10, -0.2))));
  }
  return { t: T, y: Y, steps, rejected, stoppedBy };
}

// ---------- dense linear algebra ----------
export const zeros = (r, c) => Array.from({ length: r }, () => new Float64Array(c));
export const eye = (n) => { const A = zeros(n, n); for (let i = 0; i < n; i++) A[i][i] = 1; return A; };
export const matmul = (A, B) => { const r = A.length, c = B[0].length, k = B.length, C = zeros(r, c); for (let i = 0; i < r; i++) for (let p = 0; p < k; p++) { const a = A[i][p]; if (a) for (let j = 0; j < c; j++) C[i][j] += a * B[p][j]; } return C; };
export const matvec = (A, x) => A.map(row => { let s = 0; for (let j = 0; j < x.length; j++) s += row[j] * x[j]; return s; });
export const transpose = (A) => { const C = zeros(A[0].length, A.length); for (let i = 0; i < A.length; i++) for (let j = 0; j < A[0].length; j++) C[j][i] = A[i][j]; return C; };
export const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
export const norm = (a) => Math.sqrt(dot(a, a));
export function luSolve(Ain, bin) { // Gaussian elimination with partial pivoting
  const n = Ain.length, A = new Array(n), b = new Float64Array(bin); for (let i = 0; i < n; i++) A[i] = new Float64Array(Ain[i]);
  for (let k = 0; k < n; k++) {
    let p = k, mx = Math.abs(A[k][k]);
    for (let i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > mx) { mx = Math.abs(A[i][k]); p = i; }
    if (mx < 1e-300) throw new Error('Singular matrix (rigid-body mode or missing constraint)');
    if (p !== k) { [A[k], A[p]] = [A[p], A[k]]; [b[k], b[p]] = [b[p], b[k]]; }
    for (let i = k + 1; i < n; i++) { const f = A[i][k] / A[k][k]; if (!f) continue; for (let j = k; j < n; j++) A[i][j] -= f * A[k][j]; b[i] -= f * b[k]; }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
  return Array.from(x);
}
export function invert(A) { const n = A.length, I = eye(n), cols = []; for (let j = 0; j < n; j++) cols.push(luSolve(A, Array.from(I.map(r => r[j])))); return transpose(cols.map(c => Float64Array.from(c))); }
export function det(Ain) { const n = Ain.length, A = Ain.map(r => Float64Array.from(r)); let d = 1; for (let k = 0; k < n; k++) { let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > Math.abs(A[p][k])) p = i; if (!A[p][k]) return 0; if (p !== k) { [A[k], A[p]] = [A[p], A[k]]; d = -d; } d *= A[k][k]; for (let i = k + 1; i < n; i++) { const f = A[i][k] / A[k][k]; for (let j = k; j < n; j++) A[i][j] -= f * A[k][j]; } } return d; }
export function cholesky(A) { const n = A.length, L = zeros(n, n); for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) { let s = A[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]; if (i === j) { if (s <= 0) throw new Error('Matrix not positive definite'); L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j]; } return L; }
// Symmetric eigenproblem by cyclic Jacobi rotations; returns ascending eigenvalues and column eigenvectors
export function eigSym(Ain, { tol = 1e-12, maxSweeps = 100 } = {}) {
  const n = Ain.length, A = Ain.map(r => Float64Array.from(r)), V = eye(n);
  for (let sw = 0; sw < maxSweeps; sw++) {
    let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2;
    if (off < tol) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const idx = range(n).sort((i, j) => A[i][i] - A[j][j]);
  return { values: idx.map(i => A[i][i]), vectors: idx.map(i => V.map(r => r[i])) };
}
// Generalised symmetric eigenproblem K φ = λ M φ (M SPD) via Cholesky reduction
export function eigGen(K, M) {
  const L = cholesky(M), Li = invert(L), A = matmul(matmul(Li, K), transpose(Li));
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) { const v = 0.5 * (A[i][j] + A[j][i]); A[i][j] = A[j][i] = v; }
  const { values, vectors } = eigSym(A); const LiT = transpose(Li);
  return { values, vectors: vectors.map(v => matvec(LiT, v)) };
}
// Eigenvalues of a general real matrix via shifted QR on Hessenberg form (returns complex pairs {re, im})
export function eigGeneral(Ain, maxIt = 2000) {
  const n = Ain.length; const H = Ain.map(r => Array.from(r));
  for (let m = 1; m < n - 1; m++) { // Hessenberg reduction by Gaussian similarity
    let x = 0, i = m; for (let j = m; j < n; j++) if (Math.abs(H[j][m - 1]) > Math.abs(x)) { x = H[j][m - 1]; i = j; }
    if (i !== m) { [H[i], H[m]] = [H[m], H[i]]; for (let j = 0; j < n; j++) { const t = H[j][i]; H[j][i] = H[j][m]; H[j][m] = t; } }
    if (x) for (i = m + 1; i < n; i++) { let y = H[i][m - 1]; if (y) { y /= x; H[i][m - 1] = y; for (let j = m; j < n; j++) H[i][j] -= y * H[m][j]; for (let j = 0; j < n; j++) H[j][m] += y * H[j][i]; } }
  }
  for (let i = 2; i < n; i++) for (let j = 0; j < i - 1; j++) H[i][j] = 0;
  const wr = new Array(n).fill(0), wi = new Array(n).fill(0); let nn = n - 1, t = 0, its = 0;
  while (nn >= 0) {
    let l; for (l = nn; l >= 1; l--) { const s = Math.abs(H[l - 1][l - 1]) + Math.abs(H[l][l]); if (Math.abs(H[l][l - 1]) <= 1e-14 * (s || 1)) { H[l][l - 1] = 0; break; } }
    const x = H[nn][nn];
    if (l === nn) { wr[nn] = x + t; wi[nn] = 0; nn--; its = 0; continue; }
    const y = H[nn - 1][nn - 1], w = H[nn][nn - 1] * H[nn - 1][nn];
    if (l === nn - 1) {
      const p = 0.5 * (y - x), q = p * p + w, z = Math.sqrt(Math.abs(q));
      if (q >= 0) { const zz = p + (p >= 0 ? z : -z); wr[nn - 1] = wr[nn] = x + zz + t; if (zz) wr[nn] = x - w / zz + t; wi[nn - 1] = wi[nn] = 0; }
      else { wr[nn - 1] = wr[nn] = x + p + t; wi[nn - 1] = z; wi[nn] = -z; }
      nn -= 2; its = 0; continue;
    }
    if (++its > maxIt) break;
    let xx = x, yy = y, ww = w;
    if (its % 10 === 0) { t += xx; for (let i = 0; i <= nn; i++) H[i][i] -= xx; const s = Math.abs(H[nn][nn - 1]) + Math.abs(H[nn - 1][nn - 2]); xx = yy = 0.75 * s; ww = -0.4375 * s * s; }
    let m, p, q, r, z;
    for (m = nn - 2; m >= l; m--) {
      z = H[m][m]; r = xx - z; const s2 = yy - z; p = (r * s2 - ww) / H[m + 1][m] + H[m][m + 1]; q = H[m + 1][m + 1] - z - r - s2; r = H[m + 2][m + 1];
      const s = Math.abs(p) + Math.abs(q) + Math.abs(r); p /= s; q /= s; r /= s;
      if (m === l) break;
      const u = Math.abs(H[m][m - 1]) * (Math.abs(q) + Math.abs(r)), v = Math.abs(p) * (Math.abs(H[m - 1][m - 1]) + Math.abs(z) + Math.abs(H[m + 1][m + 1]));
      if (u <= 1e-14 * v) break;
    }
    for (let i = m + 2; i <= nn; i++) { H[i][i - 2] = 0; if (i !== m + 2) H[i][i - 3] = 0; }
    for (let k = m; k <= nn - 1; k++) {
      if (k !== m) { p = H[k][k - 1]; q = H[k + 1][k - 1]; r = k !== nn - 1 ? H[k + 2][k - 1] : 0; xx = Math.abs(p) + Math.abs(q) + Math.abs(r); if (xx) { p /= xx; q /= xx; r /= xx; } }
      const s = (p >= 0 ? 1 : -1) * Math.sqrt(p * p + q * q + r * r);
      if (s) {
        if (k === m) { if (l !== m) H[k][k - 1] = -H[k][k - 1]; } else H[k][k - 1] = -s * xx;
        p += s; xx = p / s; yy = q / s; z = r / s; q /= p; r /= p;
        for (let j = k; j <= nn; j++) { p = H[k][j] + q * H[k + 1][j]; if (k !== nn - 1) { p += r * H[k + 2][j]; H[k + 2][j] -= p * z; } H[k + 1][j] -= p * yy; H[k][j] -= p * xx; }
        const mmin = nn < k + 3 ? nn : k + 3;
        for (let i = l; i <= mmin; i++) { p = xx * H[i][k] + yy * H[i][k + 1]; if (k !== nn - 1) { p += z * H[i][k + 2]; H[i][k + 2] -= p * r; } H[i][k + 1] -= p * q; H[i][k] -= p; }
      }
    }
  }
  return wr.map((re, i) => ({ re, im: wi[i] }));
}

// ---------- sparse (CSR) & iterative solvers ----------
export class SparseBuilder {
  constructor(n) { this.n = n; this.rows = Array.from({ length: n }, () => new Map()); }
  add(i, j, v) { const r = this.rows[i]; r.set(j, (r.get(j) || 0) + v); }
  set(i, j, v) { this.rows[i].set(j, v); }
  toCSR() {
    const n = this.n, ptr = new Int32Array(n + 1); let nnz = 0;
    for (let i = 0; i < n; i++) { nnz += this.rows[i].size; ptr[i + 1] = nnz; }
    const col = new Int32Array(nnz), val = new Float64Array(nnz);
    for (let i = 0, k = 0; i < n; i++) { const ent = [...this.rows[i].entries()].sort((a, b) => a[0] - b[0]); for (const [j, v] of ent) { col[k] = j; val[k++] = v; } }
    return { n, ptr, col, val, nnz };
  }
}
export function csrMul(A, x, y = new Float64Array(A.n)) { for (let i = 0; i < A.n; i++) { let s = 0; for (let k = A.ptr[i]; k < A.ptr[i + 1]; k++) s += A.val[k] * x[A.col[k]]; y[i] = s; } return y; }
export function csrDiag(A) { const d = new Float64Array(A.n); for (let i = 0; i < A.n; i++) for (let k = A.ptr[i]; k < A.ptr[i + 1]; k++) if (A.col[k] === i) d[i] = A.val[k]; return d; }
// Jacobi-preconditioned conjugate gradient (SPD systems)
export function pcg(A, b, { tol = 1e-10, maxIt = 5000, x0 } = {}) {
  const n = A.n, x = x0 ? Float64Array.from(x0) : new Float64Array(n), d = csrDiag(A), r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  csrMul(A, x, Ap); for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; z[i] = r[i] / (d[i] || 1); p[i] = z[i]; }
  let rz = dot(r, z); const bn = norm(b) || 1; const hist = [];
  for (let it = 0; it < maxIt; it++) {
    csrMul(A, p, Ap); const alpha = rz / dot(p, Ap);
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
    const res = norm(r) / bn; hist.push(res);
    if (res < tol) return { x, it, res, hist, ok: true };
    for (let i = 0; i < n; i++) z[i] = r[i] / (d[i] || 1);
    const rz1 = dot(r, z), beta = rz1 / rz; rz = rz1;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return { x, it: maxIt, res: hist[hist.length - 1], hist, ok: false };
}
export function bicgstab(A, b, { tol = 1e-10, maxIt = 5000 } = {}) {
  const n = A.n, x = new Float64Array(n), d = csrDiag(A), r = Float64Array.from(b), rh = Float64Array.from(b), p = new Float64Array(n), v = new Float64Array(n), s = new Float64Array(n), t = new Float64Array(n), ph = new Float64Array(n), sh = new Float64Array(n);
  let rho = 1, alpha = 1, w = 1; const bn = norm(b) || 1, hist = [];
  for (let it = 0; it < maxIt; it++) {
    const rho1 = dot(rh, r); const beta = (rho1 / rho) * (alpha / w); rho = rho1;
    for (let i = 0; i < n; i++) { p[i] = r[i] + beta * (p[i] - w * v[i]); ph[i] = p[i] / (d[i] || 1); }
    csrMul(A, ph, v); alpha = rho / dot(rh, v);
    for (let i = 0; i < n; i++) { s[i] = r[i] - alpha * v[i]; sh[i] = s[i] / (d[i] || 1); }
    csrMul(A, sh, t); w = dot(t, s) / dot(t, t);
    for (let i = 0; i < n; i++) { x[i] += alpha * ph[i] + w * sh[i]; r[i] = s[i] - w * t[i]; }
    const res = norm(r) / bn; hist.push(res);
    if (res < tol) return { x, it, res, hist, ok: true };
  }
  return { x, it: maxIt, res: hist[hist.length - 1], hist, ok: false };
}
// Banded/tridiagonal (Thomas) solver
export function thomas(a, b, c, d) { const n = d.length, cp = new Float64Array(n), dp = new Float64Array(n), x = new Float64Array(n); cp[0] = c[0] / b[0]; dp[0] = d[0] / b[0]; for (let i = 1; i < n; i++) { const m = b[i] - a[i] * cp[i - 1]; cp[i] = c[i] / m; dp[i] = (d[i] - a[i] * dp[i - 1]) / m; } x[n - 1] = dp[n - 1]; for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1]; return x; }

// ---------- optimisation & fitting ----------
export function nelderMead(f, x0, { step = 0.1, tol = 1e-8, maxIt = 2000 } = {}) {
  const n = x0.length; let S = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += (Math.abs(x[i]) > 1e-12 ? step * Math.abs(x[i]) : step); S.push(x); }
  let F = S.map(f), it = 0;
  for (; it < maxIt; it++) {
    const idx = range(n + 1).sort((a, b) => F[a] - F[b]); S = idx.map(i => S[i]); F = idx.map(i => F[i]);
    if (Math.abs(F[n] - F[0]) < tol * (1 + Math.abs(F[0]))) break;
    const xc = range(n).map(j => mean(S.slice(0, n).map(s => s[j])));
    const xr = xc.map((v, j) => v + (v - S[n][j])), fr = f(xr);
    if (fr < F[0]) { const xe = xc.map((v, j) => v + 2 * (v - S[n][j])), fe = f(xe); if (fe < fr) { S[n] = xe; F[n] = fe; } else { S[n] = xr; F[n] = fr; } }
    else if (fr < F[n - 1]) { S[n] = xr; F[n] = fr; }
    else { const xk = xc.map((v, j) => v + 0.5 * (S[n][j] - v)), fk = f(xk); if (fk < F[n]) { S[n] = xk; F[n] = fk; } else { for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); F[i] = f(S[i]); } } }
  }
  return { x: S[0], f: F[0], it };
}
// Levenberg–Marquardt nonlinear least squares; model(x, params) -> y. Returns params, covariance, residuals.
export function levenbergMarquardt(model, xs, ys, p0, { weights, maxIt = 200, tol = 1e-10, lambda0 = 1e-3, bounds } = {}) {
  let p = p0.slice(), lambda = lambda0; const m = xs.length, n = p.length, w = weights || new Array(m).fill(1);
  const resid = (pp) => xs.map((x, i) => (ys[i] - model(x, pp)) * Math.sqrt(w[i]));
  let r = resid(p), S = dot(r, r), it = 0;
  const jac = (pp) => { const J = zeros(m, n); for (let k = 0; k < n; k++) { const h = 1e-6 * (Math.abs(pp[k]) + 1e-6), q = pp.slice(); q[k] += h; const r2 = resid(q); for (let i = 0; i < m; i++) J[i][k] = -(r2[i] - r[i]) / h; } return J; };
  let J = jac(p);
  for (; it < maxIt; it++) {
    const JT = transpose(J), JTJ = matmul(JT, J), g = matvec(JT, r);
    const A = JTJ.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (v || 1e-12) : 0)));
    let dp; try { dp = luSolve(A, g); } catch { lambda *= 10; continue; }
    let pn = p.map((v, i) => v + dp[i]);
    if (bounds) pn = pn.map((v, i) => clamp(v, bounds[i][0], bounds[i][1]));
    const rn = resid(pn), Sn = dot(rn, rn);
    if (Sn < S) { const conv = Math.abs(S - Sn) < tol * (1 + S); p = pn; r = rn; S = Sn; lambda = Math.max(lambda / 10, 1e-12); J = jac(p); if (conv) break; }
    else lambda *= 10;
    if (lambda > 1e12) break;
  }
  const JT = transpose(J), dof = Math.max(1, m - n), s2 = S / dof; let cov = null;
  try { cov = invert(matmul(JT, J)).map(r => Array.from(r).map(v => v * s2)); } catch { cov = null; }
  const se = cov ? cov.map((r, i) => Math.sqrt(Math.abs(r[i]))) : p.map(() => NaN);
  const corr = cov ? cov.map((r, i) => r.map((v, j) => v / (se[i] * se[j] || 1))) : null;
  return { p, cov, se, corr, sse: S, rmse: Math.sqrt(S / m), it, residuals: xs.map((x, i) => ys[i] - model(x, p)) };
}
export function polyfit(x, y, deg) { const A = x.map(xi => range(deg + 1).map(k => xi ** k)); const AT = transpose(A.map(r => Float64Array.from(r))); return luSolve(matmul(AT, A.map(r => Float64Array.from(r))), matvec(AT, y)); }
export const polyval = (c, x) => c.reduce((s, ck, k) => s + ck * x ** k, 0);

// ---------- random & sampling ----------
export function rng(seed = 12345) { let a = seed >>> 0; const u = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; let spare = null; u.normal = (m = 0, s = 1) => { if (spare !== null) { const v = spare; spare = null; return m + s * v; } let x, y, r; do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (!r || r >= 1); const f = Math.sqrt(-2 * Math.log(r) / r); spare = y * f; return m + s * x * f; }; u.int = (n) => Math.floor(u() * n); return u; }
export function lhs(n, d, R = rng(7)) { const out = Array.from({ length: n }, () => new Array(d)); for (let j = 0; j < d; j++) { const perm = range(n); for (let i = n - 1; i > 0; i--) { const k = R.int(i + 1); [perm[i], perm[k]] = [perm[k], perm[i]]; } for (let i = 0; i < n; i++) out[i][j] = (perm[i] + R()) / n; } return out; }
const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71];
export function halton(n, d, skip = 20) { const o = []; for (let i = skip; i < n + skip; i++) { const row = []; for (let j = 0; j < d; j++) { let f = 1, r = 0, k = i + 1; const b = PRIMES[j % PRIMES.length]; while (k > 0) { f /= b; r += f * (k % b); k = Math.floor(k / b); } row.push(r); } o.push(row); } return o; }
export const scaleSample = (u, bounds) => u.map((v, j) => bounds[j][0] + v * (bounds[j][1] - bounds[j][0]));
export function normInv(p) { // Acklam rational approximation of the standard normal quantile
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239], b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1], c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425; let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= 1 - pl) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
export function normCdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2), p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; }

// ---------- statistics & validation metrics ----------
export function percentile(a, q) { const s = a.slice().sort((x, y) => x - y); const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }
export function histogram(a, bins = 20, lo = min(a), hi = max(a)) { const w = (hi - lo) / bins || 1, c = new Array(bins).fill(0); for (const v of a) c[clamp(Math.floor((v - lo) / w), 0, bins - 1)]++; return { edges: linspace(lo, hi, bins + 1), centers: range(bins).map(i => lo + (i + 0.5) * w), counts: c }; }
export function metrics(pred, meas, unc) {
  const n = Math.min(pred.length, meas.length); const e = range(n).map(i => pred[i] - meas[i]);
  const mm = mean(meas.slice(0, n)), sst = sum(meas.slice(0, n).map(v => (v - mm) ** 2)), sse = sum(e.map(v => v * v));
  const mp = mean(pred.slice(0, n)), cov = sum(range(n).map(i => (pred[i] - mp) * (meas[i] - mm)));
  const r = cov / Math.sqrt(sum(pred.slice(0, n).map(v => (v - mp) ** 2)) * sst || 1);
  const rng_ = (max(meas) - min(meas)) || 1, se = std(e) / Math.sqrt(n), t = n > 30 ? 1.96 : 2.1;
  const out = { n, bias: mean(e), rmse: Math.sqrt(sse / n), mae: mean(e.map(Math.abs)), nrmse: Math.sqrt(sse / n) / rng_, r2: 1 - sse / (sst || 1), r, biasCI: [mean(e) - t * se, mean(e) + t * se] };
  if (unc) out.uwd = mean(range(n).map(i => Math.abs(e[i]) / (unc[i] || 1)));
  return out;
}

// ---------- discretisation-error estimation (Roache GCI, Celik et al. 2008 procedure) ----------
// f1 fine, f2 medium, f3 coarse; h1<h2<h3 representative cell sizes.
export function gci(f1, f2, f3, h1, h2, h3, Fs = 1.25) {
  const r21 = h2 / h1, r32 = h3 / h2, e21 = f2 - f1, e32 = f3 - f2;
  const s = Math.sign(e32 / e21 || 1);
  let p = Math.abs(Math.log(Math.abs(e32 / e21)) / Math.log(r21)), q = 0;
  for (let i = 0; i < 100; i++) { q = Math.log((r21 ** p - s) / (r32 ** p - s)); const pn = Math.abs(Math.log(Math.abs(e32 / e21)) + q) / Math.log(r21); if (!Number.isFinite(pn)) break; if (Math.abs(pn - p) < 1e-10) { p = pn; break; } p = pn; }
  const fext = (r21 ** p * f1 - f2) / (r21 ** p - 1);
  const ea21 = Math.abs((f1 - f2) / f1), eext21 = Math.abs((fext - f1) / fext);
  const gci21 = Fs * ea21 / (r21 ** p - 1), gci32 = Fs * Math.abs((f2 - f3) / f2) / (r32 ** p - 1);
  const asym = gci32 / (r21 ** p * gci21);
  const oscill = e21 * e32 < 0;
  return { p, fext, ea21, eext21, gci21, gci32, asymptoticRatio: asym, inAsymptoticRange: Math.abs(asym - 1) < 0.1, oscillatory: oscill, r21, r32 };
}

// ---------- formatting ----------
export function fmt(v, sig = 4) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(Math.max(0, sig - 1)).replace('e+', 'e');
  const d = a === 0 ? 0 : Math.max(0, sig - 1 - Math.floor(Math.log10(a)));
  return v.toFixed(Math.min(d, 8)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
