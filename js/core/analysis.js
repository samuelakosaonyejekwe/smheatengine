// Sensitivity, uncertainty, optimisation and reliability engines shared by every suite.
import { rng, lhs, halton, scaleSample, mean, range, sum, std, normInv, normCdf, norm, clamp } from './num.js';

// Local one-at-a-time sensitivity (normalised elasticities) and tornado data.
// fn(xObj) -> scalar; base: {k:v}; spec: [{key,label,lo,hi}]
export function tornado(fn, base, spec) {
  const y0 = fn(base);
  const rows = spec.map(s => {
    const lo = fn({ ...base, [s.key]: s.lo }), hi = fn({ ...base, [s.key]: s.hi });
    const h = (s.hi - s.lo) || 1, el = base[s.key] ? ((hi - lo) / h) * (base[s.key] / (y0 || 1)) : 0;
    return { key: s.key, label: s.label || s.key, lo, hi, swing: Math.abs(hi - lo), elasticity: el };
  }).sort((a, b) => b.swing - a.swing);
  return { base: y0, rows };
}

// Morris elementary effects screening (r trajectories, p levels)
export function morris(fn, bounds, { r = 20, levels = 4, seed = 3 } = {}) {
  const R = rng(seed), k = bounds.length, delta = levels / (2 * (levels - 1)); const EE = range(k).map(() => []);
  for (let t = 0; t < r; t++) {
    let x = range(k).map(() => Math.floor(R() * (levels / 2)) / (levels - 1));
    let y = fn(scaleSample(x, bounds));
    const order = range(k).sort(() => R() - 0.5);
    for (const j of order) {
      const xn = x.slice(); xn[j] = x[j] + delta <= 1 ? x[j] + delta : x[j] - delta;
      const yn = fn(scaleSample(xn, bounds));
      EE[j].push((yn - y) / (xn[j] - x[j]));
      x = xn; y = yn;
    }
  }
  return EE.map(e => ({ mu: mean(e), muStar: mean(e.map(Math.abs)), sigma: std(e) }));
}

// Variance-based Sobol indices (Saltelli sampling, Jansen estimators) on a quasi-random design
export function sobol(fn, bounds, { N = 512 } = {}) {
  const k = bounds.length, H = halton(N, 2 * k, 50);
  const A = H.map(r => scaleSample(r.slice(0, k), bounds)), B = H.map(r => scaleSample(r.slice(k), bounds));
  const fA = A.map(fn), fB = B.map(fn), all = fA.concat(fB), m = mean(all), V = mean(all.map(v => (v - m) ** 2)) || 1e-30;
  const S1 = [], ST = [];
  for (let j = 0; j < k; j++) {
    const fABj = A.map((a, i) => { const x = a.slice(); x[j] = B[i][j]; return fn(x); });
    S1.push(clamp(mean(range(N).map(i => fB[i] * (fABj[i] - fA[i]))) / V, -0.1, 1.1));
    ST.push(clamp(0.5 * mean(range(N).map(i => (fA[i] - fABj[i]) ** 2)) / V, 0, 1.2));
  }
  return { S1, ST, variance: V, mean: m, evaluations: N * (k + 2) };
}

// Monte Carlo / Latin hypercube uncertainty propagation. dists: [{type:'normal'|'uniform'|'lognormal'|'triangular', a, b, c}]
export function sampleDist(d, u) {
  switch (d.type) {
    case 'normal': return d.a + d.b * normInv(clamp(u, 1e-9, 1 - 1e-9));
    case 'lognormal': return Math.exp(Math.log(d.a) + d.b * normInv(clamp(u, 1e-9, 1 - 1e-9)));
    case 'triangular': { const { a, b, c } = d, F = (c - a) / (b - a); return u < F ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c)); }
    default: return d.a + u * (d.b - d.a);
  }
}
export function propagate(fn, dists, { n = 2000, seed = 11, method = 'lhs' } = {}) {
  const U = method === 'lhs' ? lhs(n, dists.length, rng(seed)) : (() => { const R = rng(seed + 1); return range(n).map(() => dists.map(() => R())); })();
  const X = U.map(u => u.map((v, j) => sampleDist(dists[j], v))), Y = X.map(fn);
  const s = Y.slice().sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { X, Y, mean: mean(Y), std: std(Y), p05: q(0.05), p50: q(0.5), p95: q(0.95) };
}

// Differential evolution (rand/1/bin) for bounded single-objective minimisation with penalty constraints
export function diffEvolution(fn, bounds, { pop = 30, gens = 120, F = 0.7, CR = 0.9, seed = 5 } = {}) {
  const R = rng(seed), k = bounds.length; let P = range(pop).map(() => scaleSample(range(k).map(() => R()), bounds)), Fv = P.map(fn);
  const hist = [];
  for (let g = 0; g < gens; g++) {
    for (let i = 0; i < pop; i++) {
      let a, b, c; do { a = R.int(pop); } while (a === i); do { b = R.int(pop); } while (b === i || b === a); do { c = R.int(pop); } while (c === i || c === a || c === b);
      const jr = R.int(k); const tr = P[i].map((v, j) => (R() < CR || j === jr) ? clamp(P[a][j] + F * (P[b][j] - P[c][j]), bounds[j][0], bounds[j][1]) : v);
      const ft = fn(tr); if (ft <= Fv[i]) { P[i] = tr; Fv[i] = ft; }
    }
    hist.push(Math.min(...Fv));
  }
  const bi = Fv.indexOf(Math.min(...Fv));
  return { x: P[bi], f: Fv[bi], history: hist, population: P, values: Fv };
}

// NSGA-II multi-objective optimisation. fn(x) -> {f:[...minimise], g:[...<=0 feasible]}
export function nsga2(fn, bounds, { pop = 60, gens = 60, seed = 9, pc = 0.9, etaC = 15, etaM = 20 } = {}) {
  const R = rng(seed), k = bounds.length, pm = 1 / k;
  const evalInd = (x) => { const r = fn(x); const cv = (r.g || []).reduce((s, v) => s + Math.max(0, v), 0); return { x, f: r.f, cv, extra: r.extra }; };
  const dominates = (a, b) => { if (a.cv !== b.cv) return a.cv < b.cv; let better = false; for (let i = 0; i < a.f.length; i++) { if (a.f[i] > b.f[i]) return false; if (a.f[i] < b.f[i]) better = true; } return better; };
  const sortFronts = (P) => { const S = P.map(() => []), n = P.map(() => 0), fronts = [[]]; P.forEach((p, i) => { P.forEach((q, j) => { if (i === j) return; if (dominates(p, q)) S[i].push(j); else if (dominates(q, p)) n[i]++; }); if (n[i] === 0) { p.rank = 0; fronts[0].push(i); } }); let f = 0; while (fronts[f].length) { const nxt = []; for (const i of fronts[f]) for (const j of S[i]) if (--n[j] === 0) { P[j].rank = f + 1; nxt.push(j); } f++; fronts.push(nxt); } fronts.pop(); return fronts; };
  const crowd = (P, idx) => { idx.forEach(i => P[i].cd = 0); const m = P[idx[0]].f.length; for (let o = 0; o < m; o++) { const s = idx.slice().sort((a, b) => P[a].f[o] - P[b].f[o]); P[s[0]].cd = P[s[s.length - 1]].cd = Infinity; const span = (P[s[s.length - 1]].f[o] - P[s[0]].f[o]) || 1; for (let i = 1; i < s.length - 1; i++) P[s[i]].cd += (P[s[i + 1]].f[o] - P[s[i - 1]].f[o]) / span; } };
  const tour = (P) => { const a = P[R.int(P.length)], b = P[R.int(P.length)]; return (a.rank < b.rank || (a.rank === b.rank && a.cd > b.cd)) ? a : b; };
  const sbx = (x1, x2) => { const c1 = x1.slice(), c2 = x2.slice(); if (R() > pc) return [c1, c2]; for (let j = 0; j < k; j++) { if (R() > 0.5) continue; const u = R(), beta = u <= 0.5 ? (2 * u) ** (1 / (etaC + 1)) : (1 / (2 * (1 - u))) ** (1 / (etaC + 1)); c1[j] = clamp(0.5 * ((1 + beta) * x1[j] + (1 - beta) * x2[j]), ...bounds[j]); c2[j] = clamp(0.5 * ((1 - beta) * x1[j] + (1 + beta) * x2[j]), ...bounds[j]); } return [c1, c2]; };
  const mut = (x) => x.map((v, j) => { if (R() > pm) return v; const u = R(), d = u < 0.5 ? (2 * u) ** (1 / (etaM + 1)) - 1 : 1 - (2 * (1 - u)) ** (1 / (etaM + 1)); return clamp(v + d * (bounds[j][1] - bounds[j][0]), ...bounds[j]); });
  let P = range(pop).map(() => evalInd(scaleSample(range(k).map(() => R()), bounds)));
  sortFronts(P).forEach(fr => crowd(P, fr));
  const hv = [];
  for (let g = 0; g < gens; g++) {
    const Q = []; while (Q.length < pop) { const [a, b] = sbx(tour(P).x, tour(P).x); Q.push(evalInd(mut(a))); if (Q.length < pop) Q.push(evalInd(mut(b))); }
    const U = P.concat(Q), fronts = sortFronts(U), next = [];
    for (const fr of fronts) { crowd(U, fr); if (next.length + fr.length <= pop) fr.forEach(i => next.push(U[i])); else { fr.sort((a, b) => U[b].cd - U[a].cd).slice(0, pop - next.length).forEach(i => next.push(U[i])); break; } }
    P = next; hv.push(P.filter(p => p.rank === 0 && p.cv === 0).length);
  }
  sortFronts(P);
  return { population: P, front: P.filter(p => p.rank === 0 && p.cv === 0), history: hv };
}

// Hypervolume of a 2-objective front (minimisation) relative to a reference point
export function hypervolume2(front, ref) { const pts = front.filter(p => p[0] < ref[0] && p[1] < ref[1]).sort((a, b) => a[0] - b[0]); let hv = 0, prevY = ref[1]; for (const p of pts) { if (p[1] < prevY) { hv += (ref[0] - p[0]) * (prevY - p[1]); prevY = p[1]; } } return hv; }

// First-order reliability method (Hasofer–Lind / Rackwitz–Fiessler) for independent normal variables.
// g(x) <= 0 is failure. vars: [{mu, sigma}]
export function form(g, vars, { maxIt = 100, tol = 1e-6 } = {}) {
  const k = vars.length; let u = new Array(k).fill(0); const toX = (uu) => uu.map((v, i) => vars[i].mu + vars[i].sigma * v);
  let beta = 0;
  for (let it = 0; it < maxIt; it++) {
    const x = toX(u), g0 = g(x), grad = u.map((_, i) => { const h = 1e-6 * (Math.abs(u[i]) + 1), uu = u.slice(); uu[i] += h; return (g(toX(uu)) - g0) / h; });
    const gn = norm(grad) || 1e-30, un = grad.map(gi => ((grad.reduce((s, gj, j) => s + gj * u[j], 0) - g0) / (gn * gn)) * gi);
    const bn = norm(un); const conv = Math.abs(bn - beta) < tol; u = un; beta = bn; if (conv) break;
  }
  const g0 = g(vars.map(v => v.mu));
  const b = g0 >= 0 ? beta : -beta;
  return { beta: b, pf: normCdf(-b), designPoint: toX(u), alpha: u.map(v => v / (beta || 1)) };
}
export function monteCarloPf(g, vars, n = 20000, seed = 21) { const R = rng(seed); let f = 0; for (let i = 0; i < n; i++) if (g(vars.map(v => R.normal(v.mu, v.sigma))) <= 0) f++; const pf = f / n; return { pf, cov: pf ? Math.sqrt((1 - pf) / (n * pf)) : Infinity, n }; }

// Gaussian-process surrogate (squared-exponential kernel, fixed hyper-parameters chosen by marginal-likelihood grid)
export function gpFit(X, y, { noise = 1e-6 } = {}) {
  const n = X.length, d = X[0].length, ym = mean(y), ys = std(y) || 1, yn = y.map(v => (v - ym) / ys);
  const kern = (a, b, l) => Math.exp(-0.5 * a.reduce((s, ai, i) => s + ((ai - b[i]) / l[i]) ** 2, 0));
  let best = null;
  for (const lf of [0.1, 0.2, 0.35, 0.5, 0.8, 1.2]) {
    const l = range(d).map(i => lf * ((Math.max(...X.map(x => x[i])) - Math.min(...X.map(x => x[i]))) || 1));
    const K = X.map(a => X.map(b => kern(a, b, l))); K.forEach((r, i) => r[i] += noise + 1e-8);
    try {
      const L = choleskyArr(K), alpha = cholSolve(L, yn);
      const ll = -0.5 * yn.reduce((s, v, i) => s + v * alpha[i], 0) - sum(L.map((r, i) => Math.log(r[i])));
      if (!best || ll > best.ll) best = { ll, l, L, alpha };
    } catch { /* not PD at this length-scale */ }
  }
  const predict = (x) => { const ks = X.map(a => kern(a, x, best.l)); const mu = ks.reduce((s, v, i) => s + v * best.alpha[i], 0); const v = cholSolveL(best.L, ks); const var_ = Math.max(0, 1 - v.reduce((s, vi) => s + vi * vi, 0)); return { mean: ym + ys * mu, std: ys * Math.sqrt(var_) }; };
  return { predict, lengthScales: best.l, logLik: best.ll };
}
function choleskyArr(A) { const n = A.length, L = A.map(() => new Array(n).fill(0)); for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) { let s = A[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]; if (i === j) { if (s <= 0) throw new Error('not PD'); L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j]; } return L; }
function cholSolveL(L, b) { const n = L.length, y = new Array(n); for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; } return y; }
function cholSolve(L, b) { const y = cholSolveL(L, b), n = L.length, x = new Array(n); for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; } return x; }

// Parameter sweep helper: returns {x:[], y:[]} for one parameter
export function sweep(fn, base, key, lo, hi, n = 41) { const x = range(n).map(i => lo + (hi - lo) * i / (n - 1)); return { x, y: x.map(v => fn({ ...base, [key]: v })) }; }
