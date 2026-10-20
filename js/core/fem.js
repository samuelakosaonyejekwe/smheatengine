// Finite-element library: classical laminate theory, wing beam (bending–torsion with bend–twist coupling),
// 2D frame elements with periodic homogenisation of lattices, plane-stress CST continuum, modal & buckling.
import { zeros, luSolve, eigGen, eigSym, SparseBuilder, pcg, csrMul, dot, range, matmul, transpose, invert, rng } from './num.js';

// ---------------- Classical laminate theory ----------------
// Material record units: E, E2, G12 GPa; strengths MPa. Returns lamina property set in Pa.
export function lamina(m) {
  const iso = !m.E2;
  const E1 = (m.E || 70) * 1e9, E2 = (iso ? m.E : m.E2) * 1e9, nu12 = m.nu ?? 0.3;
  const G12 = (iso ? m.E / (2 * (1 + nu12)) : (m.G12 ?? m.E2 / 2.6)) * 1e9;
  const sy = (m.sy ?? m.su ?? 100) * 1e6;
  return { E1, E2, nu12, G12, iso, Xt: (m.Xt ?? m.su ?? m.sy ?? 100) * 1e6, Xc: (m.Xc ?? m.Xt ?? m.sy ?? 100) * 1e6, Yt: (m.Yt ?? (iso ? m.sy : 40)) * 1e6, Yc: (m.Yc ?? (iso ? m.sy : 120)) * 1e6, S12: (m.S12 ?? (iso ? sy / Math.sqrt(3) / 1e6 : 70)) * 1e6, rho: m.rho };
}
export function plyQ(L) { const nu21 = L.nu12 * L.E2 / L.E1, d = 1 - L.nu12 * nu21; return [[L.E1 / d, L.nu12 * L.E2 / d, 0], [L.nu12 * L.E2 / d, L.E2 / d, 0], [0, 0, L.G12]]; }
export function Qbar(Q, thDeg) {
  const t = thDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), c2 = c * c, s2 = s * s, c4 = c2 * c2, s4 = s2 * s2;
  const [Q11, Q12, Q22, Q66] = [Q[0][0], Q[0][1], Q[1][1], Q[2][2]];
  const q11 = Q11 * c4 + 2 * (Q12 + 2 * Q66) * s2 * c2 + Q22 * s4, q22 = Q11 * s4 + 2 * (Q12 + 2 * Q66) * s2 * c2 + Q22 * c4;
  const q12 = (Q11 + Q22 - 4 * Q66) * s2 * c2 + Q12 * (s4 + c4), q66 = (Q11 + Q22 - 2 * Q12 - 2 * Q66) * s2 * c2 + Q66 * (s4 + c4);
  const q16 = (Q11 - Q12 - 2 * Q66) * s * c ** 3 + (Q12 - Q22 + 2 * Q66) * s ** 3 * c, q26 = (Q11 - Q12 - 2 * Q66) * s ** 3 * c + (Q12 - Q22 + 2 * Q66) * s * c ** 3;
  return [[q11, q12, q16], [q12, q22, q26], [q16, q26, q66]];
}
// plies: [{L (lamina), theta (deg), t (m)}] listed bottom → top
export function laminate(plies) {
  const h = plies.reduce((s, p) => s + p.t, 0); let z = -h / 2;
  const A = zeros(3, 3).map(r => Array.from(r)), B = zeros(3, 3).map(r => Array.from(r)), D = zeros(3, 3).map(r => Array.from(r)), zs = [];
  for (const p of plies) {
    const Qb = Qbar(plyQ(p.L), p.theta), z0 = z, z1 = z + p.t; zs.push([z0, z1]);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { A[i][j] += Qb[i][j] * (z1 - z0); B[i][j] += Qb[i][j] * (z1 * z1 - z0 * z0) / 2; D[i][j] += Qb[i][j] * (z1 ** 3 - z0 ** 3) / 3; }
    z = z1;
  }
  const a = invert(A).map(r => Array.from(r));
  const eng = { Ex: 1 / (a[0][0] * h), Ey: 1 / (a[1][1] * h), Gxy: 1 / (a[2][2] * h), nuxy: -a[0][1] / a[0][0], etaXS: a[0][2] / a[0][0] };
  return { plies, h, A, B, D, a, zs, ...eng, rhoA: plies.reduce((s, p) => s + p.t * (p.L.rho || 1500), 0) };
}
export function parseLayup(str, L, tPly) { return String(str).split(/[,/ ]+/).filter(Boolean).map(v => ({ L, theta: parseFloat(v), t: tPly })).filter(p => Number.isFinite(p.theta)); }
// Ply stresses (material axes) for mid-plane strains eps0=[ex,ey,gxy] and curvatures k
export function plyStresses(lam, eps0, kap = [0, 0, 0]) {
  return lam.plies.map((p, i) => {
    const zm = (lam.zs[i][0] + lam.zs[i][1]) / 2, e = [eps0[0] + zm * kap[0], eps0[1] + zm * kap[1], eps0[2] + zm * kap[2]];
    const t = p.theta * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const e1 = c * c * e[0] + s * s * e[1] + s * c * e[2], e2 = s * s * e[0] + c * c * e[1] - s * c * e[2], g12 = -2 * s * c * e[0] + 2 * s * c * e[1] + (c * c - s * s) * e[2];
    const Q = plyQ(p.L), s1 = Q[0][0] * e1 + Q[0][1] * e2, s2 = Q[0][1] * e1 + Q[1][1] * e2, t12 = Q[2][2] * g12;
    return { theta: p.theta, s1, s2, t12, ...failure(s1, s2, t12, p.L) };
  });
}
export function failure(s1, s2, t12, L) {
  const F1 = 1 / L.Xt - 1 / L.Xc, F2 = 1 / L.Yt - 1 / L.Yc, F11 = 1 / (L.Xt * L.Xc), F22 = 1 / (L.Yt * L.Yc), F66 = 1 / L.S12 ** 2, F12 = -0.5 * Math.sqrt(F11 * F22);
  const a = F11 * s1 * s1 + F22 * s2 * s2 + F66 * t12 * t12 + 2 * F12 * s1 * s2, b = F1 * s1 + F2 * s2;
  const R = a > 0 ? (-b + Math.sqrt(b * b + 4 * a)) / (2 * a) : (b > 0 ? 1 / b : Infinity); // strength ratio
  const X = s1 >= 0 ? L.Xt : L.Xc, Y = s2 >= 0 ? L.Yt : L.Yc;
  const tsaiHill = (s1 / X) ** 2 - s1 * s2 / X ** 2 + (s2 / Y) ** 2 + (t12 / L.S12) ** 2;
  const maxStress = Math.max(Math.abs(s1) / X, Math.abs(s2) / Y, Math.abs(t12) / L.S12);
  const hashinFT = s1 >= 0 ? (s1 / L.Xt) ** 2 + (t12 / L.S12) ** 2 : (s1 / L.Xc) ** 2, hashinMT = s2 >= 0 ? (s2 / L.Yt) ** 2 + (t12 / L.S12) ** 2 : (s2 / (2 * L.S12)) ** 2 + ((L.Yc / (2 * L.S12)) ** 2 - 1) * s2 / L.Yc + (t12 / L.S12) ** 2;
  return { tsaiWu: a + b, R, tsaiHill, maxStress, hashinFiber: hashinFT, hashinMatrix: hashinMT };
}

// ---------------- Wing beam: DOFs per node [w, w', φ] with bend–twist coupling ----------------
// props(z) -> {EI, GJ, K (coupling, N·m²), m (kg/m), Ip (kg·m), xa (CG offset from elastic axis, m)}
export function beamModel(L, n, props) {
  const N = n + 1, ndof = 3 * N, K = zeros(ndof, ndof), M = zeros(ndof, ndof), le = L / n;
  for (let e = 0; e < n; e++) {
    const p = props((e + 0.5) * le), l = le, EI = p.EI, GJ = p.GJ, Kc = p.K || 0;
    const kb = [[12, 6 * l, -12, 6 * l], [6 * l, 4 * l * l, -6 * l, 2 * l * l], [-12, -6 * l, 12, -6 * l], [6 * l, 2 * l * l, -6 * l, 4 * l * l]].map(r => r.map(v => v * EI / l ** 3));
    const mb = [[156, 22 * l, 54, -13 * l], [22 * l, 4 * l * l, 13 * l, -3 * l * l], [54, 13 * l, 156, -22 * l], [-13 * l, -3 * l * l, -22 * l, 4 * l * l]].map(r => r.map(v => v * p.m * l / 420));
    const kt = [[GJ / l, -GJ / l], [-GJ / l, GJ / l]], mt = [[p.Ip * l / 3, p.Ip * l / 6], [p.Ip * l / 6, p.Ip * l / 3]];
    const bk = [0, -1, 0, 1], bp = [-1 / l, 1 / l]; // ∫κ dx shape integrals × φ' gradient
    const ib = [3 * e, 3 * e + 1, 3 * e + 3, 3 * e + 4], it = [3 * e + 2, 3 * e + 5];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { K[ib[i]][ib[j]] += kb[i][j]; M[ib[i]][ib[j]] += mb[i][j]; }
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { K[it[i]][it[j]] += kt[i][j]; M[it[i]][it[j]] += mt[i][j]; }
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) { const v = Kc * bk[i] * bp[j]; K[ib[i]][it[j]] += v; K[it[j]][ib[i]] += v; }
    // static unbalance (CG offset xa from elastic axis): consistent coupling ∫ m·xa·N_w N_φ dx (4-point Gauss)
    if (p.xa) { const gp = [-0.861136311594053, -0.339981043584856, 0.339981043584856, 0.861136311594053], gw = [0.347854845137454, 0.652145154862546, 0.652145154862546, 0.347854845137454];
      for (let g = 0; g < 4; g++) { const xi = (gp[g] + 1) / 2, wq = gw[g] / 2 * l, Nw = [1 - 3 * xi * xi + 2 * xi ** 3, l * (xi - 2 * xi * xi + xi ** 3), 3 * xi * xi - 2 * xi ** 3, l * (-xi * xi + xi ** 3)], Np = [1 - xi, xi];
        for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) { const v = p.m * p.xa * Nw[i] * Np[j] * wq; M[ib[i]][it[j]] += v; M[it[j]][ib[i]] += v; } } }
  }
  const free = range(ndof).filter(d => d >= 3); // clamped root: w = w' = φ = 0
  const red = (A) => free.map(i => free.map(j => A[i][j]));
  return { L, n, N, ndof, K, M, free, Kr: red(K), Mr: red(M), z: range(N).map(i => i * le), le };
}
export function beamStatic(model, F) { // F full-size load vector (forces on w, moments on w', torques on φ)
  const x = luSolve(model.Kr, model.free.map(d => F[d])), u = new Array(model.ndof).fill(0); model.free.forEach((d, k) => u[d] = x[k]);
  return { u, w: range(model.N).map(i => u[3 * i]), slope: range(model.N).map(i => u[3 * i + 1]), phi: range(model.N).map(i => u[3 * i + 2]) };
}
export function beamModes(model, nModes = 4) {
  const { values, vectors } = eigGen(model.Kr, model.Mr);
  return values.slice(0, nModes).map((lam, k) => { const full = new Array(model.ndof).fill(0); model.free.forEach((d, j) => full[d] = vectors[k][j]); const w = range(model.N).map(i => full[3 * i]), phi = range(model.N).map(i => full[3 * i + 2]); const wn = Math.max(...w.map(Math.abs)), pn = Math.max(...phi.map(Math.abs)) * 0.5; void wn; void pn;
    // classify by modal kinetic-energy split (bending w/θ DOFs vs torsion φ DOFs) — unit-consistent
    let Eb = 0, Et = 0; if (model.M) { for (let a = 0; a < model.ndof; a++) { if (!full[a]) continue; const ta = a % 3 === 2; for (let b = 0; b < model.ndof; b++) { if (!full[b] || (b % 3 === 2) !== ta) continue; const e = full[a] * model.M[a][b] * full[b]; if (ta) Et += e; else Eb += e; } } } else { Eb = Math.max(...w.map(Math.abs)); Et = Math.max(...phi.map(Math.abs)) * 0.5; }
    return { omega: Math.sqrt(Math.max(lam, 0)), f: Math.sqrt(Math.max(lam, 0)) / (2 * Math.PI), vec: vectors[k], full, w, phi, type: Eb >= Et ? 'bending' : 'torsion', bendingFraction: Eb / ((Eb + Et) || 1) }; });
}
// Internal bending moment & torque along the beam from the displacement solution (element mid values)
export function beamResultants(model, u, props) {
  const out = [];
  for (let e = 0; e < model.n; e++) {
    const l = model.le, p = props((e + 0.5) * l), w1 = u[3 * e], t1 = u[3 * e + 1], w2 = u[3 * e + 3], t2 = u[3 * e + 4], f1 = u[3 * e + 2], f2 = u[3 * e + 5];
    const kap = (t2 - t1) / l, dphi = (f2 - f1) / l; void w1; void w2;
    out.push({ z: (e + 0.5) * l, kappa: kap, dphi, M: p.EI * kap + (p.K || 0) * dphi, T: (p.K || 0) * kap + p.GJ * dphi });
  }
  return out;
}

// ---------------- 2D frame element (u, v, θ per node) ----------------
export function frameK(E, A, I, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy), c = dx / L, s = dy / L;
  const a = E * A / L, b = 12 * E * I / L ** 3, cc = 6 * E * I / L ** 2, d = 4 * E * I / L, e = 2 * E * I / L;
  const kl = [[a, 0, 0, -a, 0, 0], [0, b, cc, 0, -b, cc], [0, cc, d, 0, -cc, e], [-a, 0, 0, a, 0, 0], [0, -b, -cc, 0, b, -cc], [0, cc, e, 0, -cc, d]];
  const T = [[c, s, 0, 0, 0, 0], [-s, c, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0], [0, 0, 0, c, s, 0], [0, 0, 0, -s, c, 0], [0, 0, 0, 0, 0, 1]];
  const Kg = matmul(matmul(transpose(T), kl), T).map(r => Array.from(r));
  return { K: Kg, L, c, s, T };
}
// Periodic homogenisation of a 2D strut lattice. cell = {nodes:[[x,y]], struts:[{i,j,shift:[n1,n2]}], a1:[x,y], a2:[x,y]}
// Displacement = macroscopic affine field ε·x + periodic fluctuation; Hill–Mandel energy equivalence gives C.
export function homogenize(cell, Es, t, depth = 1) {
  const nn = cell.nodes.length, nd = 3 * nn, A = t * depth, I = depth * t ** 3 / 12;
  const els = cell.struts.map(s => { const p1 = cell.nodes[s.i], sh = s.shift || [0, 0], p2 = [cell.nodes[s.j][0] + sh[0] * cell.a1[0] + sh[1] * cell.a2[0], cell.nodes[s.j][1] + sh[0] * cell.a1[1] + sh[1] * cell.a2[1]]; const tf = s.tf || 1; return { ...s, p1, p2, tt: t * tf, ...frameK(Es, A * tf, I * tf ** 3, p1[0], p1[1], p2[0], p2[1]) }; });
  const area = Math.abs(cell.a1[0] * cell.a2[1] - cell.a1[1] * cell.a2[0]);
  const Kf = zeros(nd, nd).map(r => Array.from(r));
  for (const e of els) { const map = [3 * e.i, 3 * e.i + 1, 3 * e.i + 2, 3 * e.j, 3 * e.j + 1, 3 * e.j + 2]; for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) Kf[map[a]][map[b]] += e.K[a][b]; }
  const free = range(nd).filter(d => d > 1); // fix fluctuation translation of node 0
  for (const d of free) Kf[d][d] += 1e-12 * (Kf[d][d] || 1);
  const solveCase = (eps) => { // eps = [exx, eyy, gxy] engineering
    const E = [[eps[0], eps[2] / 2], [eps[2] / 2, eps[1]]];
    const aff = (p) => [E[0][0] * p[0] + E[0][1] * p[1], E[1][0] * p[0] + E[1][1] * p[1]];
    const F = new Array(nd).fill(0);
    for (const e of els) { const u1 = aff(e.p1), u2 = aff(e.p2), da = [u1[0], u1[1], 0, u2[0], u2[1], 0], map = [3 * e.i, 3 * e.i + 1, 3 * e.i + 2, 3 * e.j, 3 * e.j + 1, 3 * e.j + 2]; for (let a = 0; a < 6; a++) { let s = 0; for (let b = 0; b < 6; b++) s += e.K[a][b] * da[b]; F[map[a]] -= s; } }
    const x = luSolve(free.map(i => free.map(j => Kf[i][j])), free.map(d => F[d])), uf = new Array(nd).fill(0); free.forEach((d, k) => uf[d] = x[k]);
    let U = 0; const forces = [];
    for (const e of els) {
      const u1 = aff(e.p1), u2 = aff(e.p2), d = [u1[0] + uf[3 * e.i], u1[1] + uf[3 * e.i + 1], uf[3 * e.i + 2], u2[0] + uf[3 * e.j], u2[1] + uf[3 * e.j + 1], uf[3 * e.j + 2]];
      let ue = 0; const f = new Array(6).fill(0); for (let a = 0; a < 6; a++) { for (let b = 0; b < 6; b++) f[a] += e.K[a][b] * d[b]; ue += 0.5 * d[a] * f[a]; }
      U += ue; const fl = e.T.map(r => r.reduce((s, v, k) => s + v * f[k], 0)); // local end forces
      const Mmax = Math.max(Math.abs(fl[2]), Math.abs(fl[5])), axial = -fl[0];
      forces.push({ axial, Mmax, sigmaMax: Math.abs(axial) / (depth * e.tt) + Mmax * (e.tt / 2) / (depth * e.tt ** 3 / 12), U: ue, d, energyFrac: 0 });
    }
    return { U, uf, forces };
  };
  const c1 = solveCase([1e-3, 0, 0]), c2 = solveCase([0, 1e-3, 0]), c3 = solveCase([0, 0, 1e-3]), c12 = solveCase([1e-3, 1e-3, 0]), c13 = solveCase([1e-3, 0, 1e-3]), c23 = solveCase([0, 1e-3, 1e-3]);
  const s = 1e-6, C11 = 2 * c1.U / (area * depth) / s, C22 = 2 * c2.U / (area * depth) / s, C66 = 2 * c3.U / (area * depth) / s;
  const C12 = (2 * c12.U / (area * depth) / s - C11 - C22) / 2, C16 = (2 * c13.U / (area * depth) / s - C11 - C66) / 2, C26 = (2 * c23.U / (area * depth) / s - C22 - C66) / 2;
  const C = [[C11, C12, C16], [C12, C22, C26], [C16, C26, C66]];
  let S; try { S = invert(C).map(r => Array.from(r)); } catch { S = [[Infinity, 0, 0], [0, Infinity, 0], [0, 0, Infinity]]; }
  const relDensity = els.reduce((a, e) => a + e.L * e.tt, 0) / area;
  const ev = eigSym(C).values;
  const energyAt = (eps) => solveCase(eps.map(v => v * 1e-3)).U / (area * depth) / 1e-6; // J/m³ per unit strain² scale
  return { C, S, energyAt, Ex: 1 / S[0][0], Ey: 1 / S[1][1], Gxy: 1 / S[2][2], nuxy: -S[0][1] / S[0][0], nuyx: -S[0][1] / S[1][1], relDensity, area, els, caseX: c1, caseY: c2, caseS: c3, eigC: ev, positiveDefinite: ev.every(v => v > -1e-6 * Math.abs(ev[ev.length - 1])) };
}

// ---------------- Plane-stress CST continuum ----------------
export function structuredMesh(x0, x1, ybot, ytop, nx, ny) {
  const nodes = [], tris = [];
  for (let i = 0; i <= nx; i++) { const x = x0 + (x1 - x0) * i / nx, yb = ybot(x), yt = ytop(x); for (let j = 0; j <= ny; j++) nodes.push([x, yb + (yt - yb) * j / ny]); }
  const id = (i, j) => i * (ny + 1) + j;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) { const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1); if ((i + j) % 2) { tris.push([a, b, c], [a, c, d]); } else { tris.push([a, b, d], [b, c, d]); } }
  return { nodes, tris, nx, ny, id };
}
export function meshQuality(nodes, tris) {
  let minAng = 180, maxAR = 1, minJ = Infinity, sumSkew = 0, maxSkew = 0;
  for (const t of tris) {
    const P = t.map(k => nodes[k]), L = [0, 1, 2].map(k => Math.hypot(P[(k + 1) % 3][0] - P[k][0], P[(k + 1) % 3][1] - P[k][1]));
    const area = 0.5 * ((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]));
    const angs = [0, 1, 2].map(k => { const a = L[k], b = L[(k + 2) % 3], c = L[(k + 1) % 3]; return Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - c * c) / (2 * a * b)))) * 180 / Math.PI; });
    const mn = Math.min(...angs), mx = Math.max(...angs); minAng = Math.min(minAng, mn);
    const skew = Math.max((mx - 60) / 120, (60 - mn) / 60); sumSkew += skew; maxSkew = Math.max(maxSkew, skew);
    const sp = (L[0] + L[1] + L[2]) / 2, rin = area / sp; maxAR = Math.max(maxAR, Math.max(...L) / (2 * Math.sqrt(3) * rin));
    const sj = Math.min(...[0, 1, 2].map(k => 2 * area / (L[k] * L[(k + 2) % 3]))) / (Math.sqrt(3) / 2); minJ = Math.min(minJ, sj);
  }
  return { minAngle: minAng, maxSkew, meanSkew: sumSkew / tris.length, maxAR, minScaledJacobian: minJ, inverted: minJ <= 0 };
}
export function cstB(P) {
  const [x1, y1] = P[0], [x2, y2] = P[1], [x3, y3] = P[2], A = 0.5 * ((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1));
  const b = [y2 - y3, y3 - y1, y1 - y2], c = [x3 - x2, x1 - x3, x2 - x1];
  const B = [[b[0], 0, b[1], 0, b[2], 0], [0, c[0], 0, c[1], 0, c[2]], [c[0], b[0], c[1], b[1], c[2], b[2]]].map(r => r.map(v => v / (2 * A)));
  return { B, A };
}
export function planeStressD(E, nu) { const f = E / (1 - nu * nu); return [[f, f * nu, 0], [f * nu, f, 0], [0, 0, f * (1 - nu) / 2]]; }
// Solve K u = F with fixed DOFs (dict dof->value) and springs (dict dof->k). Returns u and element stresses.
export function planeStress(mesh, { E, nu, t, rho = 0, fixed = {}, springs = {}, loads = {}, gravity = 0 }) {
  const nN = mesh.nodes.length, n = 2 * nN, D = planeStressD(E, nu), sb = new SparseBuilder(n), F = new Float64Array(n), els = [];
  const Mdiag = new Float64Array(n);
  for (const tri of mesh.tris) {
    const P = tri.map(k => mesh.nodes[k]), { B, A } = cstB(P), map = [2 * tri[0], 2 * tri[0] + 1, 2 * tri[1], 2 * tri[1] + 1, 2 * tri[2], 2 * tri[2] + 1];
    const DB = D.map(r => [0, 1, 2, 3, 4, 5].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) sb.add(map[a], map[b], t * A * (B[0][a] * DB[0][b] + B[1][a] * DB[1][b] + B[2][a] * DB[2][b]));
    const me = rho * t * A / 3; for (const k of tri) { Mdiag[2 * k] += me; Mdiag[2 * k + 1] += me; F[2 * k + 1] -= me * gravity; }
    els.push({ tri, B, A, map });
  }
  for (const [d, v] of Object.entries(loads)) F[+d] += v;
  for (const [d, k] of Object.entries(springs)) sb.add(+d, +d, k);
  const isFixed = new Uint8Array(n); for (const d of Object.keys(fixed)) isFixed[+d] = 1;
  const freeIdx = new Int32Array(n).fill(-1), freeList = []; for (let d = 0; d < n; d++) if (!isFixed[d]) { freeIdx[d] = freeList.length; freeList.push(d); }
  const full = sb.toCSR(), rb = new SparseBuilder(freeList.length), Fr = new Float64Array(freeList.length);
  for (let i = 0; i < n; i++) { if (isFixed[i]) continue; const ri = freeIdx[i]; Fr[ri] += F[i]; for (let k = full.ptr[i]; k < full.ptr[i + 1]; k++) { const j = full.col[k]; if (isFixed[j]) Fr[ri] -= full.val[k] * (fixed[j] || 0); else rb.add(ri, freeIdx[j], full.val[k]); } }
  const Kr = rb.toCSR(), sol = pcg(Kr, Fr, { tol: 1e-10, maxIt: 20000 });
  const u = new Float64Array(n); for (let d = 0; d < n; d++) u[d] = isFixed[d] ? (fixed[d] || 0) : sol.x[freeIdx[d]];
  const res = els.map(e => { const ue = e.map.map(d => u[d]); const eps = e.B.map(r => r.reduce((s, v, k) => s + v * ue[k], 0)); const sig = D.map(r => r[0] * eps[0] + r[1] * eps[1] + r[2] * eps[2]); return { eps, sig, vm: Math.sqrt(sig[0] ** 2 - sig[0] * sig[1] + sig[1] ** 2 + 3 * sig[2] ** 2) }; });
  // energy & equilibrium checks
  const Ku = csrMul(full, u), work = dot(Array.from(F), Array.from(u)), Ustrain = 0.5 * dot(Array.from(Ku), Array.from(u));
  let sumF = [0, 0], sumR = [0, 0]; for (let d = 0; d < n; d++) { const r = Ku[d] - F[d]; if (isFixed[d] || springs[d] !== undefined) sumR[d % 2] += r; sumF[d % 2] += F[d]; }
  return { u, els: res, Kfull: full, Kr, freeList, freeIdx, isFixed, Mdiag, F, solver: sol, work, Ustrain, sumF, sumR };
}
// Lowest modes of a constrained CSR system (K_r, lumped M) by subspace iteration with Rayleigh–Ritz
export function lowestModes(Kr, Mr, nModes = 3, iters = 25, solver = null) {
  const n = Kr.n, p = Math.min(n, nModes + 4), R = rng(3); const fac = solver || (() => { try { return bandCholesky(Kr); } catch { return null; } })();
  let X = range(p).map(() => Float64Array.from({ length: n }, () => R() - 0.5)), vals = [];
  for (let it = 0; it < iters; it++) {
    const Y = X.map(x => { const rhs = Float64Array.from(x, (v, i) => v * Mr[i]); return fac ? fac.solve(rhs) : pcg(Kr, rhs, { tol: 1e-9, maxIt: 8000 }).x; });
    const KY = Y.map(y => csrMul(Kr, y)), Kp = Y.map((yi) => KY.map(kyj => dot(yi, kyj))), Mp = Y.map(yi => Y.map(yj => { let s = 0; for (let k = 0; k < n; k++) s += yi[k] * Mr[k] * yj[k]; return s; }));
    for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) { Kp[i][j] = Kp[j][i] = 0.5 * (Kp[i][j] + Kp[j][i]); Mp[i][j] = Mp[j][i] = 0.5 * (Mp[i][j] + Mp[j][i]); }
    let eg; try { eg = eigGen(Kp, Mp); } catch { break; }
    X = eg.vectors.map(v => { const x = new Float64Array(n); for (let k = 0; k < p; k++) for (let i = 0; i < n; i++) x[i] += v[k] * Y[k][i]; return x; });
    vals = eg.values;
  }
  return vals.slice(0, nModes).map((lam, k) => ({ omega: Math.sqrt(Math.max(lam, 0)), f: Math.sqrt(Math.max(lam, 0)) / (2 * Math.PI), vec: X[k] }));
}
// ---------------- Bistable pre-shaped (cosine) clamped–clamped curved beam ----------------
// Rayleigh–Ritz with 3 symmetric + 1 antisymmetric clamped modes, bending + mid-plane stretching energy,
// displacement control at mid-span (continuation in travel d). Units SI. Returns F–d, U–d and key metrics.
export function bistableBeam({ L, h, t, b, E, allowAsym = true, nq = 240, nSteps = 160, dMaxFactor = 2.3 }) {
  const I = b * t ** 3 / 12, A = b * t, k = 2 * Math.PI / L, xs = range(nq + 1).map(i => L * i / nq), wq = xs.map((_, i) => (i === 0 || i === nq ? 0.5 : 1) * L / nq);
  const d1 = [(x) => k * Math.sin(k * x), (x) => 2 * k * Math.sin(2 * k * x), (x) => 3 * k * Math.sin(3 * k * x), (x) => k * (Math.cos(k * x) - Math.cos(2 * k * x))];
  const d2 = [(x) => k * k * Math.cos(k * x), (x) => 4 * k * k * Math.cos(2 * k * x), (x) => 9 * k * k * Math.cos(3 * k * x), (x) => k * k * (-Math.sin(k * x) + 2 * Math.sin(2 * k * x))];
  const P1 = d1.map(f => xs.map(f)), P2 = d2.map(f => xs.map(f));
  const Bm = range(4).map(i => range(4).map(j => xs.reduce((s2, _, q) => s2 + P2[i][q] * P2[j][q] * wq[q], 0))), Cm = range(4).map(i => range(4).map(j => xs.reduce((s2, _, q) => s2 + P1[i][q] * P1[j][q] * wq[q], 0)));
  const a0 = [h / 2, 0, 0, 0], mv = (M2, v) => M2.map(r => r.reduce((s2, x, j) => s2 + x * v[j], 0)), dt = (u, v) => u.reduce((s2, x, i) => s2 + x * v[i], 0);
  const st0 = 0.5 * dt(a0, mv(Cm, a0));
  const evalA = (a) => { const da = a.map((v, i) => v - a0[i]), Bda = mv(Bm, da), Ca = mv(Cm, a), st = 0.5 * dt(a, Ca) - st0; const Ub = 0.5 * E * I * dt(da, Bda), Us = 0.5 * E * A / L * st * st; const g = Bda.map((v, i) => E * I * v + E * A / L * st * Ca[i]); const H = range(4).map(i => range(4).map(j => E * I * Bm[i][j] + E * A / L * (Ca[i] * Ca[j] + st * Cm[i][j]))); return { U: Ub + Us, Ub, Us, g, H, strainAx: st / L }; };
  const nv = allowAsym ? 3 : 2, T = [[0, -1, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]].map(r => r.slice(0, nv));
  const toA = (y, d) => { const a = [(h - d) / 2, 0, 0, 0]; for (let i = 0; i < 4; i++) for (let j = 0; j < nv; j++) a[i] += T[i][j] * y[j]; return a; };
  let y = new Array(nv).fill(0); if (allowAsym) y[2] = 1e-3 * h;
  const ds = range(nSteps + 1).map(i => dMaxFactor * h * i / nSteps), Us = [], F = [], Ys = [], curv = [], Ub = [], Usx = [];
  for (const d of ds) {
    if (allowAsym && Math.abs(y[2]) < 1e-4 * h) y[2] = 1e-3 * h; // imperfection seed reveals the asymmetric (lower-energy) branch
    for (let it = 0; it < 80; it++) {
      const ev = evalA(toA(y, d)), gy = range(nv).map(j => range(4).reduce((s2, i) => s2 + T[i][j] * ev.g[i], 0));
      const Hy = range(nv).map(p => range(nv).map(q => range(4).reduce((s2, i) => s2 + T[i][p] * range(4).reduce((s3, j) => s3 + ev.H[i][j] * T[j][q], 0), 0)));
      const mn = Math.min(...eigSym(Hy).values), sc = Math.abs(Hy[0][0]) || 1; if (mn <= 1e-8 * sc) for (let p = 0; p < nv; p++) Hy[p][p] += -mn + 1e-6 * sc;
      const dy = luSolve(Hy, gy); let step = 1, ok = false;
      while (step > 1e-8) { const yt = y.map((v, i) => v - step * dy[i]); if (evalA(toA(yt, d)).U <= ev.U + 1e-15 * Math.abs(ev.U)) { y = yt; ok = true; break; } step /= 2; }
      if (!ok || Math.sqrt(dt(dy, dy)) * step < 1e-12 * h) break;
    }
    const a = toA(y, d), ev = evalA(a); Us.push(ev.U); Ub.push(ev.Ub); Usx.push(ev.Us); F.push(-0.5 * ev.g[0]); Ys.push(a.slice());
    let cm = 0; for (let q = 0; q <= nq; q++) { let c2 = 0; for (let j = 0; j < 4; j++) c2 += (a[j] - a0[j]) * P2[j][q]; cm = Math.max(cm, Math.abs(c2)); } curv.push(cm);
  }
  const iNeg = F.findIndex((v, i) => i > 0 && v < 0), lim = iNeg > 0 ? iNeg : F.length; let iTop = 0; for (let i = 0; i < lim; i++) if (F[i] > F[iTop]) iTop = i;
  let i2 = -1; if (iNeg > 0) for (let i = iNeg; i < F.length - 1; i++) if (F[i] < 0 && F[i + 1] >= 0) { i2 = i + 1; break; }
  const Fmin = iNeg > 0 ? Math.min(...F.slice(iNeg, i2 > 0 ? i2 : F.length)) : Math.min(...F.slice(1)); let iMax = 0; for (let i = 0; i < (i2 > 0 ? i2 : Us.length); i++) if (Us[i] > Us[iMax]) iMax = i;
  return { d: ds, F, U: Us, Ub, Us: Usx, coeffs: Ys, maxCurvature: curv, Ftop: F[iTop], dTop: ds[iTop], Fmin, bistable: i2 > 0 && Fmin < 0, d2: i2 > 0 ? ds[i2] : NaN, Ustored: i2 > 0 ? Us[i2] : NaN, Ubarrier: Us[iMax], dBarrier: ds[iMax], I, A, Q: h / t, maxStrain: Math.max(...curv.slice(0, i2 > 0 ? i2 + 1 : curv.length)) * t / 2, modesUsed: allowAsym ? 4 : 3 };
}
// Banded Cholesky factorisation of an SPD CSR matrix (structured meshes have small bandwidth) — direct, robust to ill-conditioning
export function bandCholesky(A) {
  const n = A.n; let bw = 0; for (let i = 0; i < n; i++) for (let k = A.ptr[i]; k < A.ptr[i + 1]; k++) bw = Math.max(bw, Math.abs(A.col[k] - i));
  const w = bw + 1, L = new Float64Array(n * w); // L[i*w + (i-j)] for j in [i-bw, i]
  for (let i = 0; i < n; i++) for (let k = A.ptr[i]; k < A.ptr[i + 1]; k++) { const j = A.col[k]; if (j <= i) L[i * w + (i - j)] = A.val[k]; }
  for (let j = 0; j < n; j++) {
    let d = L[j * w]; for (let k = Math.max(0, j - bw); k < j; k++) { const v = L[j * w + (j - k)]; d -= v * v; }
    if (d <= 0) throw new Error('Stiffness matrix not positive definite (mechanism or missing support)'); d = Math.sqrt(d); L[j * w] = d;
    for (let i = j + 1; i <= Math.min(n - 1, j + bw); i++) { let s2 = L[i * w + (i - j)]; for (let k = Math.max(0, i - bw); k < j; k++) s2 -= L[i * w + (i - k)] * L[j * w + (j - k)]; L[i * w + (i - j)] = s2 / d; }
  }
  const solve = (b) => { const y = Float64Array.from(b); for (let i = 0; i < n; i++) { let s2 = y[i]; for (let k = Math.max(0, i - bw); k < i; k++) s2 -= L[i * w + (i - k)] * y[k]; y[i] = s2 / L[i * w]; } for (let i = n - 1; i >= 0; i--) { let s2 = y[i]; for (let k = i + 1; k <= Math.min(n - 1, i + bw); k++) s2 -= L[k * w + (k - i)] * y[k]; y[i] = s2 / L[i * w]; } return y; };
  return { solve, bandwidth: bw };
}
export { invert, matmul, transpose };
