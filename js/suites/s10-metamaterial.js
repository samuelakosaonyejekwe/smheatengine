// Suite 10 — Mechanical metamaterial and compliant transmission.
// Three unit-cell families between the SMA cartridge and the shaft coupling:
//   • compliant bridge (rhombus) displacement amplifier — co-rotational nonlinear frame FE with displacement control,
//   • pre-shaped bistable snap-through beam — Rayleigh–Ritz continuation through the unstable branch (fem.bistableBeam),
//   • re-entrant (auxetic) lattice — periodic homogenisation (fem.homogenize) used as a two-port displacement transformer.
// The work identity F_in·d_in = F_out·d_out/η is evaluated from the solved fields: amplification trades force for stroke.
import { linspace, range, mean, std, clamp, fmt, luSolve, cholesky, trapz, percentile, histogram } from '../core/num.js';
import { frameK, bistableBeam, homogenize } from '../core/fem.js';
import { forUse, get as getMat } from '../core/materials.js';
import { propagate } from '../core/analysis.js';
import { cellDrive, pause } from './s11-shaft.js';

const f3 = (v) => fmt(v, 3), f4 = (v) => fmt(v, 4), DEG = Math.PI / 180;
const TYPES = [{ value: 'amplifier', label: 'Compliant bridge displacement amplifier (flexure hinges)' }, { value: 'bistable', label: 'Bistable snap-through beam (pre-shaped, clamped–clamped)' }, { value: 'auxetic', label: 'Re-entrant auxetic lattice (displacement transformer)' }];

// ---------------- co-rotational 2-D beam (Crisfield): internal force, tangent, strain energy ----------------
function corotState(X, els, u, wantK = true) {
  const nd = X.length * 3, f = new Float64Array(nd), K = wantK ? Array.from({ length: nd }, () => new Float64Array(nd)) : null, st = []; let U = 0;
  for (const e of els) {
    const { i, j } = e, x1 = X[i][0] + u[3 * i], y1 = X[i][1] + u[3 * i + 1], x2 = X[j][0] + u[3 * j], y2 = X[j][1] + u[3 * j + 1];
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy), c = dx / L, s = dy / L;
    let db = Math.atan2(dy, dx) - e.b0; db = Math.atan2(Math.sin(db), Math.cos(db));
    const t1 = u[3 * i + 2] - db, t2 = u[3 * j + 2] - db, ul = L - e.L0, ka = e.E * e.A / e.L0, kb = e.E * e.I / e.L0;
    const N = ka * ul, M1 = kb * (4 * t1 + 2 * t2), M2 = kb * (2 * t1 + 4 * t2);
    const r = [-c, -s, 0, c, s, 0], b1 = [-s / L, c / L, 1, s / L, -c / L, 0], b2 = [-s / L, c / L, 0, s / L, -c / L, 1], z = [s, -c, 0, -s, c, 0], map = [3 * i, 3 * i + 1, 3 * i + 2, 3 * j, 3 * j + 1, 3 * j + 2];
    for (let a = 0; a < 6; a++) f[map[a]] += N * r[a] + M1 * b1[a] + M2 * b2[a];
    if (K) for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) K[map[a]][map[b]] += ka * r[a] * r[b] + kb * (4 * b1[a] * b1[b] + 2 * b1[a] * b2[b] + 2 * b2[a] * b1[b] + 4 * b2[a] * b2[b]) + N / L * z[a] * z[b] + (M1 + M2) / (L * L) * (r[a] * z[b] + z[a] * r[b]);
    U += 0.5 * ka * ul * ul + 0.5 * (t1 * M1 + t2 * M2);
    const sig = Math.abs(N) / e.A + Math.max(Math.abs(M1), Math.abs(M2)) * e.t / 2 / e.I;
    st.push({ N, M1, M2, L, db, sig, sigSigned: N / e.A + (Math.abs(M1) > Math.abs(M2) ? M1 : M2) * e.t / 2 / e.I });
  }
  return { f, K, st, U };
}
// Newton solve with prescribed dofs (dict dof → value), springs [{a, b, k}] (b = −1 for ground), external loads
function corotSolve(X, els, u0, presc, springs, { tol = 1e-9, maxIt = 40 } = {}) {
  const nd = X.length * 3, u = Float64Array.from(u0), pd = Object.keys(presc).map(Number), isP = new Uint8Array(nd); pd.forEach(d => { isP[d] = 1; u[d] = presc[d]; });
  const free = range(nd).filter(d => !isP[d]); let it = 0, res = Infinity, S;
  for (; it < maxIt; it++) {
    S = corotState(X, els, u);
    const R = Float64Array.from(S.f);
    for (const sp of springs) { const du = u[sp.a] - (sp.b >= 0 ? u[sp.b] : 0); R[sp.a] += sp.k * du; S.K[sp.a][sp.a] += sp.k; if (sp.b >= 0) { R[sp.b] -= sp.k * du; S.K[sp.b][sp.b] += sp.k; S.K[sp.a][sp.b] -= sp.k; S.K[sp.b][sp.a] -= sp.k; } }
    const Rf = free.map(d => -R[d]); res = Math.sqrt(Rf.reduce((a, v) => a + v * v, 0));
    const scale = Math.max(1e-6, Math.max(...pd.map(d => Math.abs(R[d])), 1e-6));
    if (res < tol * scale && it > 0) break;
    const du = luSolve(free.map(a => free.map(b => S.K[a][b])), Rf); free.forEach((d, k) => { u[d] += du[k]; });
  }
  S = corotState(X, els, u, false); const R = Float64Array.from(S.f);
  for (const sp of springs) { const du = u[sp.a] - (sp.b >= 0 ? u[sp.b] : 0); R[sp.a] += sp.k * du; if (sp.b >= 0) R[sp.b] -= sp.k * du; }
  return { u, R, st: S.st, U: S.U, it, res };
}
// Bridge (rhombus) amplifier geometry: input nodes (±a, 0), apexes (0, ±c); each arm = hinge | rigid arm | hinge.
// Pinned variant: arms are stiff throughout and connect to the junctions through zero-length pins (duplicated end nodes tied
// by stiff translational springs, free relative rotation).
function bridgeModel(g, E) {
  const a = g.L * Math.cos(g.alpha), c = g.L * Math.sin(g.alpha), X = [[-a, 0], [a, 0], [0, c], [0, -c]], els = [], pins = [];
  const Ah = g.pinned ? g.b * g.ta : g.b * g.th, Ih = g.pinned ? g.b * g.ta ** 3 / 12 : g.b * g.th ** 3 / 12, nh = g.pinned ? 1 : g.nh, Aa = g.b * g.ta, Ia = g.b * g.ta ** 3 / 12;
  const kPin = 1e3 * E * Aa / g.L, arms = [[0, 2], [1, 2], [0, 3], [1, 3]];
  const endNode = (j) => { if (!g.pinned) return j; const id = X.length; X.push([X[j][0], X[j][1]]); pins.push({ a: 3 * id, b: 3 * j, k: kPin }, { a: 3 * id + 1, b: 3 * j + 1, k: kPin }); return id; };
  arms.forEach(([p0, q0], armIdx) => {
    const P = X[p0], Q = X[q0], Lr = g.L, pts = [0], kinds = [], p = endNode(p0), q = endNode(q0);
    for (let k = 1; k <= nh; k++) { pts.push(g.lh * k / nh); kinds.push('h1'); }
    for (let k = 1; k <= g.na; k++) { pts.push(g.lh + (Lr - 2 * g.lh) * k / g.na); kinds.push('arm'); }
    for (let k = 1; k <= nh; k++) { pts.push(Lr - g.lh + g.lh * k / nh); kinds.push('h2'); }
    let prev = p;
    for (let k = 1; k < pts.length; k++) {
      let id; if (k === pts.length - 1) id = q; else { const sFr = pts[k] / Lr; id = X.length; X.push([P[0] + (Q[0] - P[0]) * sFr, P[1] + (Q[1] - P[1]) * sFr]); }
      const hinge = kinds[k - 1] !== 'arm', A = hinge ? Ah : Aa, I = hinge ? Ih : Ia, t = hinge && !g.pinned ? g.th : g.ta;
      const L0 = Math.hypot(X[id][0] - X[prev][0], X[id][1] - X[prev][1]), b0 = Math.atan2(X[id][1] - X[prev][1], X[id][0] - X[prev][0]);
      els.push({ i: prev, j: id, E, A, I, t, L0, b0, kind: kinds[k - 1], arm: armIdx }); prev = id;
    }
  });
  // junction rotations of a pinned frame are restrained only by a negligible rotational spring (keeps K regular)
  if (g.pinned) for (const j of [0, 1, 2, 3]) pins.push({ a: 3 * j + 2, b: -1, k: 1e-9 * E * Ia / g.L });
  return { X, els, a, c, inL: 0, inR: 1, top: 2, bot: 3, pinned: g.pinned, pins };
}
// displacement-controlled stroke of the bridge from d0 to d1 with output load spring kL
function bridgeStroke(M, kL, d0, d1, nInc) {
  const nd = M.X.length * 3, springs = [...M.pins, ...(kL > 0 ? [{ a: 3 * M.top + 1, b: 3 * M.bot + 1, k: kL }] : [])];
  let u = new Float64Array(nd); const rows = [], ds = linspace(0, d1, nInc + 1); let maxIt = 0;
  for (const d of ds) {
    const presc = { [3 * M.inL]: d / 2, [3 * M.inL + 1]: 0, [3 * M.inR]: -d / 2, [3 * M.inR + 1]: 0 };
    const r = corotSolve(M.X, M.els, u, presc, springs); u = r.u; maxIt = Math.max(maxIt, r.it);
    const Fin = (r.R[3 * M.inL] - r.R[3 * M.inR]) / 2, dout = u[3 * M.top + 1] - u[3 * M.bot + 1];
    let hs = 0, he = 0; r.st.forEach((s, k) => { if (s.sig > hs && !(M.pinned && M.els[k].kind !== 'arm')) { hs = s.sig; he = k; } }); // pinned joints carry no bending: stress from the arms
    rows.push({ d, Fin, dout, Fout: kL * dout, U: r.U, Us: 0.5 * kL * dout * dout, hot: hs, hotEl: he, sigSigned: r.st[he].sigSigned, st: r.st, u: Float64Array.from(u) });
  }
  const sel = rows.filter(r => r.d >= d0 - 1e-15);
  return { rows, sel, maxIt };
}
// linear small-displacement frame model (fem.frameK) of the same geometry: amplification and input stiffness
function bridgeLinear(M, kL) {
  const nd = M.X.length * 3, K = Array.from({ length: nd }, () => new Float64Array(nd));
  for (const e of M.els) { const k = frameK(e.E, e.A, e.I, M.X[e.i][0], M.X[e.i][1], M.X[e.j][0], M.X[e.j][1]).K, map = [3 * e.i, 3 * e.i + 1, 3 * e.i + 2, 3 * e.j, 3 * e.j + 1, 3 * e.j + 2]; for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) K[map[a]][map[b]] += k[a][b]; }
  const t = 3 * M.top + 1, bt = 3 * M.bot + 1; if (kL > 0) { K[t][t] += kL; K[bt][bt] += kL; K[t][bt] -= kL; K[bt][t] -= kL; }
  for (const sp of M.pins) { K[sp.a][sp.a] += sp.k; if (sp.b >= 0) { K[sp.b][sp.b] += sp.k; K[sp.a][sp.b] -= sp.k; K[sp.b][sp.a] -= sp.k; } }
  const d = 1e-6, presc = { [3 * M.inL]: d / 2, [3 * M.inL + 1]: 0, [3 * M.inR]: -d / 2, [3 * M.inR + 1]: 0 }, free = range(nd).filter(q => presc[q] === undefined);
  const rhs = free.map(a => -Object.entries(presc).reduce((s, [q, v]) => s + K[a][+q] * v, 0)), x = luSolve(free.map(a => free.map(b => K[a][b])), rhs);
  const u = new Float64Array(nd); free.forEach((q, k) => { u[q] = x[k]; }); for (const [q, v] of Object.entries(presc)) u[+q] = v;
  const Rq = (q) => K[q].reduce((s, v, k) => s + v * u[k], 0), Fin = (Rq(3 * M.inL) - Rq(3 * M.inR)) / 2;
  return { K, A: (u[t] - u[bt]) / d, kIn: Fin / d, u };
}
// linearised buckling multiplier of the force-controlled input pair (K₀ + λK_G singular), by bisection on Cholesky
function bridgeBuckling(M, kL) {
  const L = bridgeLinear(M, kL), nd = M.X.length * 3, Fref = Math.abs(L.kIn * 1e-6) || 1, scale = 1 / Fref, u = L.u.map(v => v * scale);
  const S = corotState(M.X, M.els, u, false), KG = Array.from({ length: nd }, () => new Float64Array(nd));
  M.els.forEach((e, k) => { const s = S.st[k], c = Math.cos(e.b0), sn = Math.sin(e.b0), z = [sn, -c, 0, -sn, c, 0], map = [3 * e.i, 3 * e.i + 1, 3 * e.i + 2, 3 * e.j, 3 * e.j + 1, 3 * e.j + 2]; for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) KG[map[a]][map[b]] += s.N / e.L0 * z[a] * z[b]; });
  const fixed = new Set([3 * M.inL + 1, 3 * M.inR + 1, 3 * M.inR]), free = range(nd).filter(q => !fixed.has(q));
  const pd = (lam) => { try { cholesky(free.map(a => free.map(b => L.K[a][b] + lam * KG[a][b]))); return true; } catch { return false; } };
  let lo = 0, hi = 1; while (pd(hi) && hi < 1e7) { lo = hi; hi *= 4; } if (hi >= 1e7) return { Pcr: Infinity };
  for (let k = 0; k < 40; k++) { const m = 0.5 * (lo + hi); if (pd(m)) lo = m; else hi = m; }
  return { Pcr: lo }; // input force (N) at which the unit-force stress state destabilises the frame
}
// re-entrant honeycomb unit cell (vertical struts h, oblique struts l at angle θ, negative = re-entrant)
const reentrantCell = (l, hr, th) => { const h = hr * l; return { nodes: [[0, 0], [0, h]], struts: [{ i: 0, j: 1 }, { i: 1, j: 0, shift: [0, 1] }, { i: 1, j: 0, shift: [-1, 1] }], a1: [2 * l * Math.cos(th), 0], a2: [l * Math.cos(th), h + l * Math.sin(th)] }; };
// bistable beam mode shapes (consistent with fem.bistableBeam): w(x) = Σ aⱼ φⱼ(x)
const bistShape = (a, L, x) => { const k = 2 * Math.PI / L; return a[0] * (1 - Math.cos(k * x)) + a[1] * (1 - Math.cos(2 * k * x)) + a[2] * (1 - Math.cos(3 * k * x)) + a[3] * (Math.sin(k * x) - 0.5 * Math.sin(2 * k * x)); };
// force-controlled loading/unloading envelope of a snap-through curve → dissipated energy per cycle
function snapLoop(d, F) {
  const n = d.length; let iTop = 0; for (let i = 1; i < n && F[i] > 0; i++) if (F[i] > F[iTop]) iTop = i;
  let iJ = n - 1; for (let i = iTop + 1; i < n; i++) if (F[i] >= F[iTop] && F.slice(iTop + 1, i).some(v => v < F[iTop])) { iJ = i; break; }
  let iMin = 0; for (let i = 1; i < n; i++) if (F[i] < F[iMin]) iMin = i;
  let iJr = 0; for (let i = iMin - 1; i >= 0; i--) if (F[i] <= F[iMin]) { iJr = i; break; }
  const FL = F.map((v, i) => i > iTop && i < iJ ? Math.max(v, F[iTop]) : v), FU = F.map((v, i) => i < iMin && i > iJr ? Math.min(v, F[iMin]) : v);
  return { FL, FU, W: trapz(FL.map((v, i) => v - FU[i]), d), Win: trapz(FL.map(v => Math.max(v, 0)), d), iTop, iJ, iMin, iJr };
}

export default {
  description: 'Designs the compliant mechanical metamaterial between each SMA cartridge and its shaft coupling: a flexure-hinged displacement amplifier, a bistable snap-through element or a re-entrant auxetic lattice. Solves nonlinear load–displacement (with continuation through snap-through), effective stiffness, amplification and the work identity, transmission efficiency, stored elastic energy, buckling/snap load, flexure peak stress and fatigue hot spot, the effect on cartridge load matching, and manufacturing-variation Monte Carlo.',
  literature: 'compliant mechanism displacement amplifier flexure hinge bistable mechanical metamaterial auxetic lattice fatigue',
  econ: true, sustain: true, credibility: 'Analytical screening',
  equations: [
    'Work identity (quasi-static, lossless): F_in·d_in = F_out·d_out;  with losses W_out = η·W_in ⇒ F_out = η·F_in/A where A = d_out/d_in. Amplification trades force for stroke — it is never a work gain',
    'Co-rotational beam: u_l = L − L₀, θ₁,₂ = φ₁,₂ − (β − β₀);  N = EA·u_l/L₀,  M₁ = (EI/L₀)(4θ₁ + 2θ₂),  M₂ = (EI/L₀)(2θ₁ + 4θ₂)',
    'Tangent: K_t = BᵀDB + (N/L)zzᵀ + ((M₁+M₂)/L²)(rzᵀ + zrᵀ),  r = [−c, −s, 0, c, s, 0],  z = [s, −c, 0, −s, c, 0]',
    'Ideal rigid-link rhombus: A₀ = cot α (small stroke);  finite stroke A = 2[√(L² − (a − d/2)²) − c]/d',
    'Linearised buckling: det(K₀ + λK_G(N_unit)) = 0 ⇒ P_cr = λ_cr·F_unit',
    'Bistable beam: Π(a) = ½EI∫(w″ − w₀″)² + (EA/2L)(½∫(w′² − w₀′²))² − F·d, displacement-controlled continuation through F < 0 (fem.bistableBeam)',
    'Homogenised lattice: σ = C·ε (Hill–Mandel energy equivalence); two-port coupling k² = C₁₂²/(C₁₁C₂₂); best matched efficiency η_max = k²/(1 + √(1 − k²))²',
    'Flexure stress σ = |N|/A + |M|·t/(2I);  Goodman n = 1/(σ_a/S_e + σ_m/σ_u);  Basquin N_f = ½·(σ_ar/σ_f′)^{1/b},  σ_ar = σ_a/(1 − σ_m/σ_u)',
    'Losses per cycle: hysteretic W_d = π·η_d·ΔU_flex; pin friction W_μ = Σ 2μ|N_pin| r_pin |Δφ|; snap-through (force control) W_s = ∮(F_load − F_unload) dd',
  ],
  methods: [
    'Co-rotational nonlinear frame FE (Newton–Raphson, displacement control of the input closure, 40 increments) for the bridge amplifier; geometry meshed with refined hinge segments',
    'Linear frame FE (fem.frameK) for verification of the small-stroke amplification and stiffness, and for the Monte-Carlo and design-map sweeps',
    'Linearised buckling by bisection on the positive-definiteness (num.cholesky) of K₀ + λK_G',
    'fem.bistableBeam Rayleigh–Ritz continuation (3 symmetric + 1 antisymmetric clamped modes) for snap-through; force-controlled hysteresis envelope for snap losses',
    'fem.homogenize periodic frame homogenisation of the re-entrant cell; two-port analysis for a loaded output',
    'Latin-hypercube Monte Carlo of hinge/strut thickness, angle and modulus (analysis.propagate)',
  ],
  assumptions: [
    'Linear-elastic constituent (Ti, steel or SMA flexure in its elastic range); plane frame, out-of-plane depth b; shear deformation neglected (slender hinges)',
    'Quasi-static stroke (cycle frequency ≪ first natural frequency of the mechanism); inertia of the mechanism neglected',
    'Stored elastic energy returns on reset (assisting the bias spring) when recovery is credited; only hysteretic and friction losses are lost',
    'Lattice: periodic cells far from the boundaries; post-buckling of struts not modelled (buckling is reported as a limit)',
    'Manufacturing variation independent and normally distributed',
  ],
  ibc: {
    initial: ['Stress-free as-manufactured geometry; prestress applied as an initial input closure d_pre', 'Bistable beam in its as-fabricated stable state'],
    boundary: ['Input closure (cartridge contraction) prescribed symmetrically at the two input blocks; vertical motion of the input blocks restrained', 'Output load as a linear spring between the apexes (or homogenised face load)', 'Clamped–clamped bistable beam, mid-span displacement control'],
  },
  cvv: {
    calibration: ['Coupon bending tests of hinge stiffness (EI) and loss factor', 'Measured force–displacement of the printed/machined unit cell'],
    verification: ['FE energy balance W_in = W_out + ΔU', 'Co-rotational initial tangent vs linear frame FE', 'Bistable ∫F dd = ΔU', 'Homogenised stiffness positive definite and symmetric', 'Work out ≤ work in'],
    validation: ['Coupon/assembly stiffness and cycling experiments with digital image correlation of the hinge strains (spec Module 10)'],
  },
  formats: { import: ['CSV force–displacement curves (d, F)', 'JSON unit-cell parameters', 'STEP/STL unit-cell geometry via Suite 02'], export: ['CSV load–displacement and energy tables', 'CSV Monte-Carlo samples', 'PNG/SVG plots', 'JSON coupling outputs'] },
  params: [
    { key: 'cellType', label: 'Unit-cell type', type: 'select', options: TYPES, default: 'amplifier', group: 'Unit cell' },
    { key: 'mat', label: 'Flexure material', type: 'select', options: forUse('flexure').map(m => ({ value: m.id, label: m.name })), default: 'ti-beta21s', group: 'Unit cell', auto: (c) => { const m = c.material('flexure'); return m ? { value: m.id, prov: 'library' } : undefined; } },
    { key: 'lossFactor', label: 'Material loss factor η_d', type: 'number', min: 0, max: 0.2, step: 0.0005, default: 0.002, group: 'Unit cell', auto: (c) => { const m = c.material('flexure'); return m ? { value: m.family === 'SMA' ? 0.05 : 0.002, prov: 'estimated' } : undefined; } },
    { key: 'Fin', label: 'Cartridge force available at the input', unit: 'N', type: 'number', min: 1, max: 1e5, step: 1, default: 400, group: 'Cartridge interface', auto: (c) => { const e = c.engine; return { value: +(Math.max(0, e.sigmaH - e.sigmaL) * e.ribbonsPerCell * e.ribbonW * e.ribbonT * 1e6).toPrecision(4), prov: 'calc' }; }, help: '(σ_H − σ_L)·A_ribbon: the load-carrying force above the bias.' },
    { key: 'stroke', label: 'Cartridge working stroke (0 = from cell cycle)', unit: 'mm', type: 'number', min: 0, max: 50, step: 0.01, default: 0, group: 'Cartridge interface', auto: (c) => { const o = c.upstream('s05'); return o?.stroke_m > 0 ? { value: +(o.stroke_m * 1000).toPrecision(4), prov: 'coupled' } : undefined; } },
    { key: 'dPre', label: 'Prestress (initial input closure)', unit: 'mm', type: 'number', min: 0, max: 10, step: 0.01, default: 0.2, group: 'Cartridge interface' },
    { key: 'loadMode', label: 'Output load', type: 'select', options: [{ value: 'match', label: 'Matched: cartridge force fully used at full stroke' }, { value: 'manual', label: 'Manual output stiffness' }], default: 'match', group: 'Cartridge interface' },
    { key: 'kLoad', label: 'Output load stiffness (manual)', unit: 'kN/m', type: 'number', min: 0, max: 1e5, step: 0.1, default: 20, group: 'Cartridge interface' },
    { key: 'creditRecovery', label: 'Credit stored elastic energy returned on reset', type: 'bool', default: true, group: 'Cartridge interface', help: 'True: flexure energy assists the bias spring (spring preload reduced accordingly); false: it is treated as lost.' },
    { key: 'armL', label: 'Amplifier arm length L', unit: 'mm', type: 'number', min: 5, max: 200, step: 0.5, default: 40, group: 'Amplifier geometry' },
    { key: 'alpha', label: 'Arm inclination α', unit: '°', type: 'number', min: 2, max: 45, step: 0.5, default: 18, group: 'Amplifier geometry' },
    { key: 'hingeT', label: 'Hinge thickness', unit: 'mm', type: 'number', min: 0.05, max: 3, step: 0.01, default: 0.4, group: 'Amplifier geometry' },
    { key: 'hingeL', label: 'Hinge length', unit: 'mm', type: 'number', min: 0.5, max: 30, step: 0.1, default: 7, group: 'Amplifier geometry' },
    { key: 'armT', label: 'Arm thickness', unit: 'mm', type: 'number', min: 0.5, max: 20, step: 0.1, default: 3, group: 'Amplifier geometry' },
    { key: 'depth', label: 'Out-of-plane depth b', unit: 'mm', type: 'number', min: 1, max: 100, step: 0.5, default: 14, group: 'Amplifier geometry' },
    { key: 'hingeType', label: 'Joint type', type: 'select', options: [{ value: 'flexure', label: 'Monolithic flexure hinges' }, { value: 'pinned', label: 'Pin joints (with friction)' }], default: 'flexure', group: 'Amplifier geometry' },
    { key: 'mu', label: 'Pin / guide friction coefficient', type: 'number', min: 0, max: 0.6, step: 0.01, default: 0.15, group: 'Amplifier geometry' },
    { key: 'pinR', label: 'Pin radius', unit: 'mm', type: 'number', min: 0.2, max: 10, step: 0.1, default: 1.5, group: 'Amplifier geometry' },
    { key: 'bL', label: 'Bistable beam span', unit: 'mm', type: 'number', min: 5, max: 200, step: 0.5, default: 40, group: 'Bistable geometry' },
    { key: 'bN', label: 'Beams in parallel', type: 'number', min: 1, max: 200, step: 1, default: 10, group: 'Bistable geometry' },
    { key: 'bH', label: 'Bistable beam rise', unit: 'mm', type: 'number', min: 0.1, max: 20, step: 0.05, default: 1.2, group: 'Bistable geometry' },
    { key: 'bT', label: 'Bistable beam thickness', unit: 'mm', type: 'number', min: 0.05, max: 5, step: 0.01, default: 0.25, group: 'Bistable geometry' },
    { key: 'bB', label: 'Bistable beam width', unit: 'mm', type: 'number', min: 1, max: 100, step: 0.5, default: 8, group: 'Bistable geometry' },
    { key: 'lStrut', label: 'Lattice oblique strut length l', unit: 'mm', type: 'number', min: 0.5, max: 50, step: 0.1, default: 8, group: 'Lattice geometry' },
    { key: 'hRatio', label: 'Vertical / oblique strut ratio h/l', type: 'number', min: 0.8, max: 4, step: 0.05, default: 2, group: 'Lattice geometry' },
    { key: 'theta', label: 'Strut angle θ (negative = re-entrant)', unit: '°', type: 'number', min: -60, max: 45, step: 1, default: -30, group: 'Lattice geometry' },
    { key: 'tStrut', label: 'Strut thickness', unit: 'mm', type: 'number', min: 0.05, max: 5, step: 0.01, default: 0.2, group: 'Lattice geometry' },
    { key: 'nx', label: 'Cells along the input direction', type: 'number', min: 1, max: 80, step: 1, default: 14, group: 'Lattice geometry' },
    { key: 'ny', label: 'Cells along the output direction', type: 'number', min: 1, max: 80, step: 1, default: 8, group: 'Lattice geometry' },
    { key: 'sdThick', label: 'Thickness tolerance (1σ)', unit: 'µm', type: 'number', min: 0, max: 200, step: 1, default: 10, group: 'Manufacturing variation' },
    { key: 'sdAngle', label: 'Angle / rise tolerance (1σ)', unit: '° or % rise', type: 'number', min: 0, max: 5, step: 0.05, default: 0.3, group: 'Manufacturing variation' },
    { key: 'sdE', label: 'Modulus scatter (1σ)', unit: '%', type: 'number', min: 0, max: 20, step: 0.5, default: 3, group: 'Manufacturing variation' },
    { key: 'lifeTarget', label: 'Design life', unit: 'cycles', type: 'number', min: 1e3, max: 1e11, step: 1e6, default: 1e8, group: 'Fatigue' },
    { key: 'surfFactor', label: 'Surface / size factor on endurance', type: 'range', min: 0.3, max: 1, step: 0.01, default: 0.8, group: 'Fatigue', expert: true },
    { key: 'nInc', label: 'Load increments (nonlinear FE)', type: 'number', min: 10, max: 200, step: 5, default: 40, group: 'Solver', expert: true },
    { key: 'nHingeEl', label: 'Elements per hinge', type: 'number', min: 1, max: 8, step: 1, default: 2, group: 'Solver', expert: true },
    { key: 'nArmEl', label: 'Elements per rigid arm', type: 'number', min: 1, max: 12, step: 1, default: 2, group: 'Solver', expert: true },
    { key: 'nMC', label: 'Monte-Carlo samples', type: 'number', min: 20, max: 2000, step: 10, default: 200, group: 'Solver', expert: true },
  ],
  presets: [
    { label: 'Bridge amplifier (β-Ti flexures, α = 18°)', values: { cellType: 'amplifier', alpha: 18 } },
    { label: 'High-ratio amplifier (α = 10°)', values: { cellType: 'amplifier', alpha: 10, hingeT: 0.3 } },
    { label: 'Pinned linkage (friction)', values: { cellType: 'amplifier', hingeType: 'pinned' } },
    { label: 'Bistable snap-through buffer', values: { cellType: 'bistable' } },
    { label: 'Re-entrant auxetic transformer (large, slender lattice)', values: { cellType: 'auxetic', tStrut: 0.12, lStrut: 10, nx: 24, ny: 10 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const mat = getMat(p.mat) || getMat('ti-beta21s'), E = mat.E * 1e9, sy = mat.sy ?? mat.su, su = mat.su ?? sy;
    const Se = (typeof mat.fatigue === 'number' ? mat.fatigue : 0.4 * su) * p.surfFactor, bq = mat.basquin || { sf: 1.5 * su, b: -0.09 };
    const lifeOf = (sa, sm) => { if (sa <= 0) return Infinity; const sar = sa / Math.max(1e-6, 1 - sm / su); if (sm >= su) return 0; return 0.5 * (sar / bq.sf) ** (1 / bq.b); };
    // ---- cartridge interface ----
    ctx.progress(0.05, 'Cartridge force–stroke');
    const { cell, drive, src: dsrc, prov: dprov } = cellDrive(ctx, ctx.engine, { spc: 160 });
    const dIn = p.stroke > 0 ? p.stroke / 1000 : drive.xwMax, Fin = p.Fin, dPre = p.dPre / 1000, Arib = cell.area;
    const strokeProv = p.stroke > 0 ? 'user/coupled' : `cell cycle (${dprov})`;
    await pause(ctx);
    // ---- 1. bridge amplifier (always solved: it is also the reference for the comparison) ----
    ctx.progress(0.15, 'Nonlinear FE of the amplifier');
    const geo = (o = {}) => ({ L: p.armL / 1000, alpha: p.alpha * DEG, th: p.hingeT / 1000, lh: p.hingeL / 1000, ta: p.armT / 1000, b: p.depth / 1000, nh: p.nHingeEl, na: p.nArmEl, pinned: p.hingeType === 'pinned', ...o });
    const BM = bridgeModel(geo(), E), lin0 = bridgeLinear(BM, 0);
    let kL = p.loadMode === 'manual' ? p.kLoad * 1e3 : Math.max(1, (Fin / Math.max(dIn + dPre, 1e-9) - lin0.kIn) / Math.max(lin0.A ** 2, 1e-9));
    const freeRun = bridgeStroke(BM, 0, dPre, dPre + dIn, Math.max(10, Math.round(p.nInc / 2))), Ffree = freeRun.rows[freeRun.rows.length - 1].Fin;
    if (p.loadMode !== 'manual') for (let it = 0; it < 4; it++) { // secant correction on a coarse stroke: required input force at full stroke = cartridge force
      const need = bridgeStroke(BM, kL, dPre, dPre + dIn, 20).rows.slice(-1)[0].Fin - Ffree, avail = Fin - Ffree;
      if (need <= 0 || avail <= 0 || Math.abs(need - avail) / avail < 0.005) break; kL *= clamp(avail / need, 0.5, 2);
    }
    const ampRun = bridgeStroke(BM, kL, dPre, dPre + dIn, p.nInc);
    const linL = bridgeLinear(BM, kL), A0 = 1 / Math.tan(p.alpha * DEG);
    const r0 = ampRun.sel[0], r1 = ampRun.sel[ampRun.sel.length - 1];
    const WinA = trapz(ampRun.sel.map(r => r.Fin), ampRun.sel.map(r => r.d)), WoutA = r1.Us - r0.Us, dUA = r1.U - r0.U, ampA = (r1.dout - r0.dout) / dIn;
    const energyErr = Math.abs(WinA - WoutA - dUA) / Math.max(Math.abs(WinA), 1e-12);
    const kEffA = (freeRun.sel[freeRun.sel.length - 1].Fin - freeRun.sel[0].Fin) / dIn;
    // pin friction: arm chord rotation across the stroke at the 8 joints (2 per arm)
    const armRot = (row) => range(4).map(a => { const e = BM.els.find(el => el.arm === a && el.kind === 'arm'); return row.st[BM.els.indexOf(e)].db; });
    const armN = (row) => range(4).map(a => { const e = BM.els.find(el => el.arm === a && el.kind === 'arm'); return Math.abs(row.st[BM.els.indexOf(e)].N); });
    const dPhi = armRot(r1).map((v, k) => Math.abs(v - armRot(r0)[k])), Npin = armN(r1).map((v, k) => 0.5 * (v + armN(r0)[k]));
    const WpinA = p.hingeType === 'pinned' ? dPhi.reduce((s, ph, k) => s + 2 * 2 * p.mu * Npin[k] * (p.pinR / 1000) * ph, 0) : 0;
    const WdampA = Math.PI * p.lossFactor * Math.abs(dUA);
    const WlossA = WdampA + WpinA;
    const hotA = Math.max(...ampRun.sel.map(r => r.hot)) / 1e6, hotEl = BM.els[r1.hotEl], hotLoc = hotEl.kind === 'arm' ? 'rigid arm' : hotEl.kind === 'h1' ? 'hinge at the input block' : 'hinge at the output apex';
    const smaxA = r1.hot / 1e6, sminA = (() => { const st0 = r0.st[r1.hotEl]; return Math.abs(st0.sig) / 1e6; })();
    const buck = bridgeBuckling(BM, kL), FinMax = Math.max(...ampRun.sel.map(r => Math.abs(r.Fin)));
    const amp = { name: 'Bridge amplifier', A: ampA, Win: WinA, Wout: WoutA, dU: dUA, Wloss: WlossA, kEff: kEffA, hot: hotA, smax: smaxA, smin: sminA, Pcr: buck.Pcr, Fpeak: FinMax, dOut: r1.dout - r0.dout, Fout: r1.Fout };
    await pause(ctx);
    // ---- 2. bistable snap-through beam ----
    ctx.progress(0.35, 'Bistable continuation');
    const BB0 = bistableBeam({ L: p.bL / 1000, h: p.bH / 1000, t: p.bT / 1000, b: p.bB / 1000, E, nSteps: 100, nq: 120 }), nB = Math.max(1, Math.round(p.bN));
    const BB = { ...BB0, F: BB0.F.map(v => v * nB), U: BB0.U.map(v => v * nB), Ub: BB0.Ub.map(v => v * nB), Us: BB0.Us.map(v => v * nB), Ftop: BB0.Ftop * nB, Fmin: BB0.Fmin * nB, Ustored: BB0.Ustored * nB, Ubarrier: BB0.Ubarrier * nB }; // nB identical beams in parallel
    const sl = snapLoop(BB.d, BB.F), Umax = Math.max(...BB.U.slice(0, sl.iJ + 1)), Uend = BB.Ustored;
    const bendStress = BB.maxStrain * E / 1e6, axialStress = 0; // mid-plane stretching strain is small next to bending at the clamps (reported in U_s)
    const bist = { name: 'Bistable beam', A: 1, Win: sl.Win, Wout: sl.Win - sl.W, dU: Uend, Wloss: sl.W + Math.PI * p.lossFactor * Umax, kEff: BB.F[1] / BB.d[1], hot: bendStress + axialStress, smax: bendStress, smin: 0, Pcr: BB.Ftop, Fpeak: BB.Ftop, dOut: BB.d2, Fout: BB.Ftop };
    const UbalErr = Math.abs(trapz(BB.F, BB.d) - (BB.U[BB.U.length - 1] - BB.U[0])) / Math.max(Math.abs(BB.U[BB.U.length - 1] - BB.U[0]), 1e-12);
    // ---- 3. auxetic lattice ----
    ctx.progress(0.45, 'Lattice homogenisation');
    const latt = (l, hr, th, t, Em) => homogenize(reentrantCell(l, hr, th), Em, t, p.depth / 1000);
    const LH = latt(p.lStrut / 1000, p.hRatio, p.theta * DEG, p.tStrut / 1000, E), cellA = reentrantCell(p.lStrut / 1000, p.hRatio, p.theta * DEG);
    const Lx = p.nx * cellA.a1[0], Ly = p.ny * cellA.a2[1], bD = p.depth / 1000, C = LH.C;
    const k2 = C[0][1] ** 2 / (C[0][0] * C[1][1]), etaMax = k2 / (1 + Math.sqrt(Math.max(0, 1 - k2))) ** 2;
    const auxTwoPort = (kOut) => { // compression ε_x by the cartridge, output spring on the y faces
      const ex = -dIn / Lx, kp = kOut * Ly / (Lx * bD), ey = -C[0][1] * ex / (C[1][1] + kp), sx = C[0][0] * ex + C[0][1] * ey;
      const FinX = Math.abs(sx) * Ly * bD, dOut = Math.abs(ey) * Ly, Win = 0.5 * FinX * dIn, Wout = 0.5 * kOut * dOut * dOut;
      return { ex, ey, FinX, dOut, Win, Wout, kIn: FinX / dIn };
    };
    const kMatchAux = C[1][1] * Math.sqrt(Math.max(0, 1 - k2)) * Lx * bD / Ly; // optimum load for maximum stroke efficiency
    const auxL = auxTwoPort(p.loadMode === 'manual' ? p.kLoad * 1e3 : kMatchAux), aux0 = auxTwoPort(0);
    const strutHot = (ex, ey) => Math.max(...LH.caseX.forces.map((f, k) => f.sigmaMax * Math.abs(ex) / 1e-3 + LH.caseY.forces[k].sigmaMax * Math.abs(ey) / 1e-3)) / 1e6;
    const It = bD * (p.tStrut / 1000) ** 3 / 12, Pe = Math.PI ** 2 * E * It / (0.5 * p.lStrut / 1000) ** 2;
    const axMax = Math.max(1e-30, ...LH.caseX.forces.map((f, k) => Math.abs(f.axial * auxL.ex / 1e-3 + LH.caseY.forces[k].axial * auxL.ey / 1e-3)));
    const auxDu = auxL.Win - auxL.Wout;
    const auxR = { name: 'Auxetic lattice', A: auxL.dOut / dIn, Win: auxL.Win, Wout: auxL.Wout, dU: auxDu, Wloss: Math.PI * p.lossFactor * auxL.Win, kEff: aux0.kIn, hot: strutHot(auxL.ex, auxL.ey), smax: strutHot(auxL.ex, auxL.ey), smin: 0, Pcr: auxL.FinX * Pe / axMax, Fpeak: auxL.FinX, dOut: auxL.dOut, Fout: auxL.dOut * (p.loadMode === 'manual' ? p.kLoad * 1e3 : kMatchAux) };
    // ---- selected type, efficiencies, fatigue ----
    const R = { amplifier: amp, bistable: bist, auxetic: auxR }, sel = R[p.cellType] || amp, all = [amp, bist, auxR];
    const effOf = (r) => p.creditRecovery ? r.Wout / Math.max(r.Wout + r.Wloss, 1e-15) : r.Wout / Math.max(r.Win, 1e-15);
    all.forEach(r => { r.eta = clamp(effOf(r), 0, 1); r.strokeRatio = r.Win > 0 ? r.Wout / r.Win : 0; });
    const sa = Math.abs(sel.smax - sel.smin) / 2, sm = (sel.smax + sel.smin) / 2, goodman = 1 / (sa / Se + sm / su), life = lifeOf(sa, sm), yieldSF = sy / Math.max(sel.hot, 1e-9);
    const matchFrac = sel === amp ? (freeRun.sel[freeRun.sel.length - 1].Fin) / Fin : sel === auxR ? aux0.FinX / Fin : BB.Ftop / Fin;
    const dSig = (sel === amp ? freeRun.sel[freeRun.sel.length - 1].Fin : sel === auxR ? 0 : BB.Ftop) / Arib / 1e6, dAf = dSig / (getMat(ctx.engine.alloy)?.CA || 7);
    // usable stroke: the cartridge can drive the loaded amplifier only while the required input force ≤ capacity
    const usable = sel === amp ? (() => { const r = ampRun.sel.find(q => q.Fin > Fin * 1.0001); return r ? (r.d - dPre) / dIn : 1; })() : 1;
    // ---- Monte Carlo (selected type) ----
    ctx.progress(0.55, 'Manufacturing-variation Monte Carlo');
    const nMC = Math.round(p.nMC * (p.cellType === 'bistable' ? 0.15 : 1)), mcA = [], mcS = [], mcP = [];
    const sdT = p.sdThick / 1000, sdAng = p.sdAngle, sdE = p.sdE / 100;
    let mcFn;
    if (p.cellType === 'amplifier') {
      const BMc = bridgeModel(geo({ nh: 1, na: 1 }), E), lin1 = bridgeLinear(BMc, kL), sigLin = (() => { const S = corotState(BMc.X, BMc.els, lin1.u.map(v => v * dIn / 1e-6), false); return Math.max(...S.st.map(s => s.sig)) / 1e6; })(), calib = sel.hot / Math.max(sigLin, 1e-9);
      mcFn = ([th, al, ef]) => { const M = bridgeModel(geo({ th: Math.max(0.2 * p.hingeT / 1000, th), alpha: al * DEG, nh: 1, na: 1 }), E * ef), Ll = bridgeLinear(M, kL), S = corotState(M.X, M.els, Ll.u.map(v => v * dIn / 1e-6), false); mcA.push(Ll.A); mcS.push(Math.max(...S.st.map(s => s.sig)) / 1e6 * calib); return Ll.A; };
      propagate(mcFn, [{ type: 'normal', a: p.hingeT / 1000, b: sdT }, { type: 'normal', a: p.alpha, b: sdAng }, { type: 'normal', a: 1, b: sdE }], { n: nMC, seed: 10 });
    } else if (p.cellType === 'bistable') {
      mcFn = ([tt, hh, ef]) => { const b = bistableBeam({ L: p.bL / 1000, h: Math.max(1e-6, hh), t: Math.max(1e-6, tt), b: p.bB / 1000, E: E * ef, nSteps: 40, nq: 48 }); mcA.push(b.bistable ? 1 : 0); mcS.push(b.maxStrain * E * ef / 1e6); mcP.push(b.Ftop * nB); return b.Ftop * nB; };
      propagate(mcFn, [{ type: 'normal', a: p.bT / 1000, b: sdT }, { type: 'normal', a: p.bH / 1000, b: p.bH / 1000 * sdAng / 100 }, { type: 'normal', a: 1, b: sdE }], { n: nMC, seed: 10 });
    } else {
      mcFn = ([tt, th, ef]) => { const H = latt(p.lStrut / 1000, p.hRatio, th * DEG, Math.max(1e-6, tt), E * ef), c = reentrantCell(p.lStrut / 1000, p.hRatio, th * DEG), lx = p.nx * c.a1[0], ly = p.ny * c.a2[1]; const a = Math.abs(H.nuxy) * ly / lx; mcA.push(a); mcS.push(0); return a; };
      propagate(mcFn, [{ type: 'normal', a: p.tStrut / 1000, b: sdT }, { type: 'normal', a: p.theta, b: sdAng }, { type: 'normal', a: 1, b: sdE }], { n: nMC, seed: 10 });
    }
    await pause(ctx);
    const mcMain = p.cellType === 'bistable' ? mcP : mcA, mcMean = mean(mcMain), mcSd = std(mcMain), h1 = mean(mcMain.slice(0, mcMain.length >> 1)), h2 = mean(mcMain.slice(mcMain.length >> 1));
    const mcStressP99 = mcS.length && mcS.some(v => v > 0) ? percentile(mcS, 0.99) : sel.hot;
    // ---- design maps ----
    ctx.progress(0.75, 'Design maps');
    let mapChart;
    if (p.cellType === 'amplifier') {
      const al = linspace(Math.max(3, p.alpha * 0.4), Math.min(40, p.alpha * 2.2), 12), ths = linspace(p.hingeT * 0.5, p.hingeT * 2, 9);
      const BMc = bridgeModel(geo({ nh: 1, na: 1 }), E), lin1 = bridgeLinear(BMc, kL), S1 = corotState(BMc.X, BMc.els, lin1.u.map(v => v * dIn / 1e-6), false), calib = sel.hot / Math.max(1e-9, Math.max(...S1.st.map(s => s.sig)) / 1e6);
      const Z = ths.map(th => al.map(a => { const M = bridgeModel(geo({ th: th / 1000, alpha: a * DEG, nh: 1, na: 1 }), E), Ll = bridgeLinear(M, kL), S = corotState(M.X, M.els, Ll.u.map(v => v * dIn / 1e-6), false), s = Math.max(...S.st.map(q => q.sig)) / 1e6 * calib; return 1 / (s / 2 / Se + s / 2 / su); }));
      mapChart = { type: 'heatmap', title: 'Fatigue safety factor (Goodman) vs arm angle and hinge thickness', x: { label: 'Arm inclination α', unit: '°', values: al }, y: { label: 'Hinge thickness', unit: 'mm', values: ths }, z: Z, cmap: 'viridis', isolines: 5, zlabel: 'n_Goodman', explain: 'Linear-FE hinge stress at the working stroke, calibrated to the nonlinear solution at the design point, converted to a Goodman safety factor for a 0 → max stress cycle. Thin hinges and moderate angles keep stress low; steep angles reduce amplification, shallow angles concentrate rotation in the hinges.' };
    } else if (p.cellType === 'bistable') {
      const hs = linspace(p.bH * 0.4, p.bH * 2, 6), ts = linspace(p.bT * 0.5, p.bT * 1.8, 5);
      const Z = ts.map(t => hs.map(hh => { const b = bistableBeam({ L: p.bL / 1000, h: hh / 1000, t: t / 1000, b: p.bB / 1000, E, nSteps: 40, nq: 48 }); return b.bistable ? b.Ftop * nB : 0; }));
      mapChart = { type: 'heatmap', title: 'Snap-through load vs rise and thickness (0 = not bistable)', x: { label: 'Rise h', unit: 'mm', values: hs }, y: { label: 'Thickness t', unit: 'mm', values: ts }, z: Z, cmap: 'viridis', isolines: 5, zlabel: 'N', explain: 'Peak snap-through force of the clamped–clamped pre-shaped beams in parallel (reduced-resolution continuation). The beam is bistable only above a rise/thickness ratio of about 2.3; the snap load scales with E·b·t³·h/L³.' };
    } else {
      const ths = linspace(-50, 30, 11), hrs = linspace(1, 3.5, 8);
      const Z = hrs.map(hr => ths.map(th => { try { const H = latt(p.lStrut / 1000, hr, th * DEG, p.tStrut / 1000, E); return H.nuxy; } catch { return NaN; } }));
      mapChart = { type: 'heatmap', title: 'Homogenised Poisson ratio ν_xy vs strut angle and h/l', x: { label: 'Strut angle θ', unit: '°', values: ths }, y: { label: 'h/l', values: hrs }, z: Z, cmap: 'coolwarm', isolines: 6, zlabel: 'ν_xy', explain: 'Negative ν_xy (re-entrant, θ < 0) converts input compression into lateral contraction; |ν_xy|·L_y/L_x is the displacement ratio of the block. Large |ν| comes with low stiffness — the two-port efficiency limit k² = C₁₂²/(C₁₁C₂₂) caps the transferable work.' };
    }
    // ---- checks ----
    const fdK = (() => { // finite-difference check of the co-rotational tangent at a deformed state
      const u = ampRun.rows[Math.floor(ampRun.rows.length / 2)].u, S = corotState(BM.X, BM.els, u), q = 3 * (BM.els.find(e => e.kind === 'arm').j) + 1, hfd = 1e-9, up = Float64Array.from(u); up[q] += hfd; const Sp = corotState(BM.X, BM.els, up, false);
      return Math.max(...range(u.length).map(a => Math.abs((Sp.f[a] - S.f[a]) / hfd - S.K[a][q]))) / Math.max(...range(u.length).map(a => Math.abs(S.K[a][q])));
    })();
    const linVsCorot = Math.abs(ampRun.rows[1].dout / ampRun.rows[1].d - linL.A) / Math.abs(linL.A);
    out.checks.push(
      { name: 'Amplifier FE energy balance (W_in = W_out + ΔU)', value: energyErr, target: '< 1 %', pass: energyErr < 0.01, detail: `W_in ${f4(WinA)} J, W_out ${f4(WoutA)} J, ΔU ${f4(dUA)} J (${p.nInc} increments, max ${ampRun.maxIt} Newton iterations).` },
      { name: 'Co-rotational tangent vs finite difference of internal force', value: fdK, target: '< 1e-4', pass: fdK < 1e-4 },
      { name: 'Nonlinear first increment vs linear frame FE (fem.frameK)', value: linVsCorot, target: '< 2 %', pass: linVsCorot < 0.02, detail: `Linear A = ${f4(linL.A)}, first nonlinear increment ${f4(ampRun.rows[1].dout / ampRun.rows[1].d)}; rigid-link cot α = ${f4(A0)}.` },
      { name: 'Bistable: ∫F dd = ΔU along the continuation', value: UbalErr, target: '< 1 %', pass: UbalErr < 0.01 },
      { name: 'Lattice stiffness positive definite and symmetric', value: LH.positiveDefinite ? 'yes' : 'no', pass: LH.positiveDefinite, detail: `E_x = ${f3(LH.Ex / 1e6)} MPa, E_y = ${f3(LH.Ey / 1e6)} MPa, ν_xy = ${f3(LH.nuxy)}, relative density ${f3(LH.relDensity)}.` },
      { name: 'No work gain: W_out ≤ W_in for every cell type', value: Math.max(...all.map(r => r.Wout / Math.max(r.Win, 1e-15))), target: '≤ 1', pass: all.every(r => r.Wout <= r.Win * (1 + 1e-9)) },
      { name: 'Monte-Carlo mean stable (first vs second half, within 3 standard errors)', value: Math.abs(h1 - h2) / Math.max(mcSd * Math.sqrt(4 / mcMain.length), 1e-12), target: '< 3', pass: Math.abs(h1 - h2) <= 3 * mcSd * Math.sqrt(4 / mcMain.length) + 1e-12, detail: `${mcMain.length} samples; half means ${f4(h1)} / ${f4(h2)}, CoV ${f3(mcSd / Math.max(Math.abs(mcMean), 1e-12) * 100)} %.` },
    );
    // ---- KPIs ----
    const idealWork = Fin * dIn;
    out.kpis.push(
      { label: 'Displacement amplification d_out/d_in', value: sel.A, unit: '–', explain: sel === amp ? `Secant ratio over the working stroke from the nonlinear solution; small-stroke linear value ${f3(linL.A)} and rigid-link cot α = ${f3(A0)}. Geometry stiffening and hinge compliance reduce it.` : sel === bist ? 'A bistable element transmits displacement one-to-one; its role is force shaping and energy buffering.' : `|ν_xy|·L_y/L_x of the ${p.nx} × ${p.ny} lattice block under the output load.`, prov: 'calc' },
      { label: 'Transmission efficiency η', value: sel.eta * 100, unit: '%', explain: `${p.creditRecovery ? 'W_out/(W_out + W_loss): stored elastic energy is returned on reset, only hysteresis, friction and snap losses are lost.' : 'W_out/W_in over the stroke: stored elastic energy is counted as lost.'} Stroke transfer ratio W_out/W_in = ${f3(sel.strokeRatio * 100)} %.`, prov: 'calc', status: sel.eta > 0.9 ? 'ok' : sel.eta > 0.7 ? 'warn' : 'bad' },
      { label: 'Work identity: F_in·d_in vs F_out·d_out/η', value: `${f3(sel.Win)} J = ${f3(sel.Wout)}/${f3(sel.strokeRatio)} J`, unit: '', explain: `Mean input force × input stroke equals output work divided by the stroke ratio. The output moves ${f3(sel.A)}× further with about ${f3(sel.strokeRatio / Math.max(sel.A, 1e-9))}× the mean force — amplification is not work gain.`, prov: 'calc' },
      { label: 'Effective input stiffness (unloaded mechanism)', value: sel.kEff / 1000, unit: 'kN/m', explain: 'Stiffness the cartridge sees from the mechanism alone; it consumes part of the SMA force as stored elastic energy.', prov: 'calc' },
      { label: 'Stored elastic energy per stroke', value: sel.dU, unit: 'J', explain: sel === bist ? 'Energy held in the second stable state (released on snap-back).' : 'Strain energy taken up by the flexures/struts over the stroke; returned on reset if credited.', prov: 'calc' },
      { label: 'Energy lost per cycle', value: sel.Wloss, unit: 'J', explain: 'Material hysteresis (π·η_d·ΔU), pin friction and force-controlled snap-through losses per full cycle.', prov: 'calc' },
      { label: sel === bist ? 'Snap-through load' : 'Buckling load (input force)', value: sel.Pcr, unit: 'N', explain: sel === bist ? `Peak force of the force–displacement curve; beyond it the beam snaps to the second state (d₂ = ${f3(BB.d2 * 1000)} mm).` : sel === amp ? `Linearised buckling of the compressed arms/hinges (bisection on det(K₀ + λK_G)); peak working input force ${f3(sel.Fpeak)} N.` : `Euler buckling (fixed–fixed) of the most compressed strut converted to block input force; working force ${f3(sel.Fpeak)} N.`, prov: 'calc', status: sel === bist ? 'ok' : sel.Pcr > 1.5 * sel.Fpeak ? 'ok' : sel.Pcr > sel.Fpeak ? 'warn' : 'bad' },
      { label: 'Peak flexure stress (hot spot)', value: sel.hot, unit: 'MPa', explain: `${sel === amp ? hotLoc : sel === bist ? 'mid-span / clamp bending' : 'most loaded strut joint'}; yield ${sy} MPa (safety ${f3(yieldSF)}); Monte-Carlo 99th percentile ${f3(mcStressP99)} MPa.`, prov: 'calc', status: yieldSF > 1.5 ? 'ok' : yieldSF > 1 ? 'warn' : 'bad' },
      { label: 'Fatigue: Goodman safety / Basquin life', value: `${f3(goodman)} / ${Number.isFinite(life) ? fmt(life, 3) : '∞'}`, unit: '– / cycles', explain: `σ_a = ${f3(sa)} MPa, σ_m = ${f3(sm)} MPa, S_e = ${f3(Se)} MPa (×${p.surfFactor} surface), Basquin σ_f′ = ${bq.sf} MPa, b = ${bq.b}. Design life ${fmt(p.lifeTarget, 3)} cycles.`, prov: mat.basquin ? 'library' : 'estimated', status: goodman >= 1.5 && life >= p.lifeTarget ? 'ok' : goodman >= 1 ? 'warn' : 'bad' },
      { label: 'Cartridge force used by the mechanism itself', value: matchFrac * 100, unit: '%', explain: `Fraction of the ${f3(Fin)} N cartridge force spent deforming the unloaded mechanism at full stroke. It adds ${f3(dSig)} MPa to the ribbon stress, raising A_f by ≈ ${f3(dAf)} K (Clausius–Clapeyron).`, prov: 'calc', status: matchFrac < 0.15 ? 'ok' : matchFrac < 0.35 ? 'warn' : 'bad' },
    );
    // ---- verdicts ----
    out.verdicts.push(
      { test: 'Displacement amplification is not work gain', status: sel.Wout <= sel.Win ? 'pass' : 'fail', detail: `W_in ${f4(sel.Win)} J ≥ W_out ${f4(sel.Wout)} J.`, fix: 'A result with W_out > W_in indicates a modelling error; refine increments.' },
      { test: 'Flexure stress below yield with margin', status: yieldSF > 1.5 ? 'pass' : yieldSF > 1 ? 'warn' : 'fail', detail: `Peak ${f3(sel.hot)} MPa vs σ_y ${sy} MPa.`, fix: sel === amp ? 'Lengthen or thin the hinges, increase α, or reduce the stroke per stage.' : 'Reduce thickness or rise, or use a higher-strength alloy.' },
      { test: 'Fatigue life meets the design life', status: life >= p.lifeTarget && goodman >= 1 ? 'pass' : goodman >= 1 ? 'warn' : 'fail', detail: `Basquin life ${Number.isFinite(life) ? fmt(life, 3) : '∞'} cycles vs ${fmt(p.lifeTarget, 3)}; Goodman ${f3(goodman)}.`, fix: 'Lower hinge stress amplitude (thinner/longer hinges), shot-peen/polish (surface factor), or use β-Ti / 17-7PH.' },
      { test: sel === bist ? 'Element is bistable' : 'Buckling margin ≥ 1.5', status: sel === bist ? (BB.bistable ? 'pass' : 'warn') : sel.Pcr > 1.5 * sel.Fpeak ? 'pass' : sel.Pcr > sel.Fpeak ? 'warn' : 'fail', detail: sel === bist ? `Q = h/t = ${f3(p.bH / p.bT)}; second stable state ${BB.bistable ? `at ${f3(BB.d2 * 1000)} mm` : 'absent'}.` : `P_cr ${f3(sel.Pcr)} N vs working ${f3(sel.Fpeak)} N.`, fix: sel === bist ? 'Raise the rise/thickness ratio above ≈ 2.5.' : 'Thicken arms, shorten hinges or reduce the input force per stage.' },
      { test: 'Cartridge load matching', status: matchFrac < 0.15 && usable >= 0.99 ? 'pass' : matchFrac < 0.35 ? 'warn' : 'fail', detail: `Mechanism consumes ${f3(matchFrac * 100)} % of the cartridge force; usable stroke ${f3(usable * 100)} %.`, fix: 'Soften the mechanism (thinner hinges), reduce prestress, or increase the cartridge force (more ribbons, Suite 05).' },
      { test: 'Coupon evidence', status: 'info', detail: `Material data are ${mat.evidence || 'library'} values; force history from ${dsrc}.`, fix: 'Measure hinge coupon stiffness, loss factor and S–N data, and unit-cell force–displacement (import CSV d, F).' },
    );
    out.headline = `${sel.name}: amplification ${f3(sel.A)}, transmission efficiency ${f3(sel.eta * 100)} %, hot-spot stress ${f3(sel.hot)} MPa (Goodman ${f3(goodman)}), ${f3(sel.Wloss * 1000)} mJ lost per cycle — output work ${f3(sel.Wout)} J from ${f3(sel.Win)} J input, so the stroke gain is paid in force.`;
    out.headlineKind = sel.eta > 0.8 && goodman >= 1 && yieldSF > 1 ? 'ok' : goodman >= 1 ? 'warn' : 'fail';
    // ---- charts ----
    if (p.cellType === 'bistable') {
      out.charts.push({ type: 'line', title: 'Bistable beam: force–displacement with continuation through snap-through', x: { label: 'Mid-span displacement', unit: 'mm' }, y: { label: 'Force', unit: 'N' }, series: [{ name: 'Equilibrium path (displacement control)', x: BB.d.map(v => v * 1000), y: BB.F }, { name: 'Force-controlled loading', x: BB.d.map(v => v * 1000), y: sl.FL, dash: true }, { name: 'Force-controlled unloading', x: BB.d.map(v => v * 1000), y: sl.FU, dash: true }], annotations: [{ type: 'hline', y: 0 }, { type: 'point', x: BB.dTop * 1000, y: BB.Ftop, label: 'snap load' }], explain: 'Displacement control follows the full equilibrium path including the negative-stiffness branch (F < 0 means the beam pulls itself through). Under force control the beam jumps at the snap load; the area between the dashed loading and unloading paths is dissipated each cycle.' });
      out.charts.push({ type: 'line', title: 'Strain energy along the snap-through path', x: { label: 'Mid-span displacement', unit: 'mm' }, y: { label: 'Energy', unit: 'mJ' }, series: [{ name: 'Total U', x: BB.d.map(v => v * 1000), y: BB.U.map(v => v * 1000) }, { name: 'Bending', x: BB.d.map(v => v * 1000), y: BB.Ub.map(v => v * 1000), dash: true }, { name: 'Stretching', x: BB.d.map(v => v * 1000), y: BB.Us.map(v => v * 1000), dash: true }], explain: 'Energy barrier between the two stable states; the second minimum is the stored energy available for release.' });
    } else if (p.cellType === 'auxetic') {
      const ks = linspace(0, kMatchAux * 4, 40).map(k => ({ k, ...auxTwoPort(k) }));
      out.charts.push({ type: 'line', title: 'Lattice load–displacement (homogenised, linear until strut buckling)', x: { label: 'Input closure', unit: 'mm' }, y: { label: 'Input force', unit: 'N' }, series: [{ name: 'Loaded output', x: linspace(0, dIn * 1000, 20), y: linspace(0, auxL.FinX, 20) }, { name: 'Unloaded (mechanism only)', x: linspace(0, dIn * 1000, 20), y: linspace(0, aux0.FinX, 20), dash: true }], annotations: [{ type: 'hline', y: auxR.Pcr, label: 'strut buckling' }, { type: 'hline', y: Fin, label: 'cartridge force' }], explain: 'The homogenised block behaves linearly until the most compressed strut buckles (horizontal line); beyond that the response plateaus and the transformation ratio collapses.' });
      out.charts.push({ type: 'line', title: 'Two-port transfer vs output load stiffness', x: { label: 'Output load stiffness', unit: 'kN/m' }, y: { label: 'Stroke transfer W_out/W_in', unit: '%' }, series: [{ name: 'W_out/W_in', x: ks.map(q => q.k / 1000), y: ks.map(q => q.Win > 0 ? q.Wout / q.Win * 100 : 0) }], annotations: [{ type: 'hline', y: etaMax * 100, label: `limit k²-bound ${f3(etaMax * 100)} %` }, { type: 'vline', x: kMatchAux / 1000, label: 'matched' }], explain: 'A passive elastic transformer can pass at most η_max = k²/(1+√(1−k²))² of the input work to the output in one stroke; the rest is stored in the lattice (returned on unloading).' });
    } else {
      out.charts.push({ type: 'line', title: 'Amplifier load–displacement (nonlinear FE)', x: { label: 'Input closure', unit: 'mm' }, y: { label: 'Force', unit: 'N' }, series: [{ name: 'Input force, loaded', x: ampRun.rows.map(r => r.d * 1000), y: ampRun.rows.map(r => r.Fin) }, { name: 'Input force, mechanism only', x: freeRun.rows.map(r => r.d * 1000), y: freeRun.rows.map(r => r.Fin), dash: true }, { name: 'Output force', x: ampRun.rows.map(r => r.d * 1000), y: ampRun.rows.map(r => r.Fout) }], annotations: [{ type: 'hline', y: Fin, label: 'cartridge force' }, { type: 'vline', x: p.dPre, label: 'prestress' }], explain: 'Force the cartridge must supply versus its closure (solid) and the part spent on the mechanism itself (dashed). The output force is several times smaller than the input force because the output moves several times further.' });
      out.charts.push({ type: 'line', title: 'Output stroke and instantaneous amplification', x: { label: 'Input closure', unit: 'mm' }, y: { label: 'Output stroke [mm] / ratio [–]' }, series: [{ name: 'Output stroke (mm)', x: ampRun.rows.map(r => r.d * 1000), y: ampRun.rows.map(r => r.dout * 1000) }, { name: 'Tangent amplification', x: ampRun.rows.slice(1).map(r => r.d * 1000), y: ampRun.rows.slice(1).map((r, k) => (r.dout - ampRun.rows[k].dout) / Math.max(r.d - ampRun.rows[k].d, 1e-15)) }, { name: 'Rigid-link kinematics (mm)', x: ampRun.rows.map(r => r.d * 1000), y: ampRun.rows.map(r => 2 * (Math.sqrt(Math.max(0, (p.armL / 1000) ** 2 - (BM.a - r.d / 2) ** 2)) - BM.c) * 1000), dash: true }], explain: 'Amplification falls as the arms steepen with stroke (geometric nonlinearity) and is further reduced by hinge compliance; the dashed curve is ideal rigid links with perfect pins.' });
      const armPts = (row, sc, arm) => { const es = BM.els.filter(e => e.arm === arm), pts = [es[0].i, ...es.map(e => e.j)]; return { x: pts.map(n => (BM.X[n][0] + sc * row.u[3 * n]) * 1000), y: pts.map(n => (BM.X[n][1] + sc * row.u[3 * n + 1]) * 1000) }; };
      out.charts.push({ type: 'line', title: 'Undeformed and deformed amplifier (true scale)', x: { label: 'x', unit: 'mm' }, y: { label: 'y', unit: 'mm' }, series: [0, 1, 2, 3].flatMap(arm => [{ name: arm ? `undeformed ${arm + 1}` : 'undeformed', ...armPts(ampRun.rows[0], 0, arm), dash: true }, { name: arm ? `full stroke ${arm + 1}` : 'full stroke', ...armPts(r1, 1, arm) }]), explain: `Bridge geometry (four arms) before and at full input closure; the hot spot is the ${hotLoc}.` });
    }
    out.charts.push(mapChart);
    out.charts.push({ type: 'bar', title: 'Work identity and energy partition per stroke (all cell types)', categories: all.map(r => r.name), series: [{ name: 'Input work W_in [mJ]', values: all.map(r => r.Win * 1000) }, { name: 'Output work W_out [mJ]', values: all.map(r => r.Wout * 1000) }, { name: 'Stored / returned [mJ]', values: all.map(r => Math.max(0, r.Win - r.Wout - r.Wloss) * 1000) }, { name: 'Lost per cycle [mJ]', values: all.map(r => r.Wloss * 1000) }], explain: 'For each unit-cell type the input work splits into output work, elastic energy stored and returned on reset, and losses. Output work never exceeds input work, whatever the amplification.' });
    const hg = histogram(mcMain, 18);
    out.charts.push({ type: 'bar', title: `Manufacturing variation: ${p.cellType === 'bistable' ? 'snap load' : 'amplification'} distribution`, categories: hg.centers.map(c => f3(c)), series: [{ name: 'samples', values: hg.counts }], explain: `${mcMain.length} Latin-hypercube samples of thickness (σ ${p.sdThick} µm), ${p.cellType === 'bistable' ? 'rise' : 'angle'} (σ ${p.sdAngle}) and modulus (σ ${p.sdE} %). Mean ${f3(mcMean)}, coefficient of variation ${f3(mcSd / Math.max(Math.abs(mcMean), 1e-12) * 100)} %.` });
    const smP = linspace(0, su, 20);
    out.charts.push({ type: 'line', title: 'Goodman diagram at the hot spot', x: { label: 'Mean stress σ_m', unit: 'MPa' }, y: { label: 'Stress amplitude σ_a', unit: 'MPa' }, series: [{ name: 'Goodman line', x: smP, y: smP.map(s => Se * (1 - s / su)) }, { name: 'Yield line', x: smP, y: smP.map(s => Math.max(0, sy - s)), dash: true }, { name: 'Operating point', x: [sm], y: [sa], mode: 'markers' }, ...(mcS.some(v => v > 0) ? [{ name: 'Monte-Carlo samples', x: mcS.map(s => s / 2), y: mcS.map(s => s / 2), mode: 'markers' }] : [])], explain: 'The working cycle at the hot spot (0 → peak, prestress shifts the mean) must lie below the Goodman line for infinite life; samples show manufacturing scatter.' });
    // ---- tables ----
    out.tables.push({ title: 'Unit-cell comparison at the same cartridge stroke', cols: ['Type', 'Amplification', 'W_in [mJ]', 'W_out [mJ]', 'Loss/cycle [mJ]', 'η [%]', 'k_in [kN/m]', 'Hot spot [MPa]', 'Buckling/snap [N]'], rows: all.map(r => [r.name, f3(r.A), f3(r.Win * 1000), f3(r.Wout * 1000), f3(r.Wloss * 1000), f3(r.eta * 100), f3(r.kEff / 1000), f3(r.hot), f3(r.Pcr)]), explain: `Cartridge stroke ${f3(dIn * 1000)} mm (${strokeProv}), force ${f3(Fin)} N, material ${mat.name}.` });
    if (p.cellType === 'amplifier') out.tables.push({ title: 'Amplifier increments', cols: ['d_in [mm]', 'F_in [N]', 'd_out [mm]', 'F_out [N]', 'U [mJ]', 'Peak σ [MPa]'], rows: ampRun.rows.filter((_, k) => k % Math.max(1, Math.round(p.nInc / 10)) === 0 || k === ampRun.rows.length - 1).map(r => [f4(r.d * 1000), f4(r.Fin), f4(r.dout * 1000), f4(r.Fout), f4(r.U * 1000), f4(r.hot / 1e6)]), explain: `Output load stiffness ${f3(kL / 1000)} kN/m (${p.loadMode}).` });
    // ---- explanation & recommendations ----
    out.explain.push(
      { title: 'What the metamaterial does — and does not do', text: `The ${sel.name.toLowerCase()} reshapes the cartridge’s ${f3(Fin)} N × ${f3(dIn * 1000)} mm stroke (ideal work ${f3(idealWork)} J) into ${f3(sel.dOut * 1000)} mm of output motion. Work in ${f3(sel.Win)} J becomes ${f3(sel.Wout)} J of output work, ${f3(Math.max(0, sel.Win - sel.Wout - sel.Wloss))} J of stored elastic energy that is returned during reset${p.creditRecovery ? ' (credited: the bias-spring preload can be reduced by this amount)' : ' (not credited)'}, and ${f3(sel.Wloss)} J lost per cycle.` },
      { title: 'Load matching', text: `The unloaded mechanism needs ${f3(matchFrac * Fin)} N at full stroke, i.e. ${f3(matchFrac * 100)} % of the cartridge force. That raises the ribbon stress by ${f3(dSig)} MPa and the stress-adjusted A_f by about ${f3(dAf)} K, so the hot source must be correspondingly hotter for complete recovery. The output load was ${p.loadMode === 'match' ? 'sized so the cartridge force is just fully used at full stroke' : 'set manually'}.` },
    );
    out.recs.push(
      { level: sel.eta > 0.9 ? 'good' : 'warn', text: `Transmission efficiency ${f3(sel.eta * 100)} % (${p.creditRecovery ? 'recovery credited' : 'no recovery credit'}); pass amplification ${f3(sel.A)} and η = ${f3(sel.eta)} to Suite 11, which converts them to shaft torque.`, basis: `W_out ${f3(sel.Wout)} J, losses ${f3(sel.Wloss)} J.` },
      { level: goodman >= 1.5 ? 'info' : 'warn', text: `Hot spot ${f3(sel.hot)} MPa at the ${sel === amp ? hotLoc : 'critical section'}: Goodman safety ${f3(goodman)}, Basquin life ${Number.isFinite(life) ? fmt(life, 3) : '∞'} cycles. ${goodman < 1.5 ? 'Thin and lengthen the hinges or polish the surface.' : 'Adequate for the design life.'}`, basis: `S_e ${f3(Se)} MPa, σ_u ${su} MPa.` },
      { level: matchFrac < 0.15 ? 'info' : 'warn', text: `The mechanism itself absorbs ${f3(matchFrac * 100)} % of the cartridge force; keep this below ~15 % so the SMA works near its favourable stress path.`, basis: `k_in = ${f3(sel.kEff / 1000)} kN/m.` },
      { level: 'info', text: `Manufacturing scatter gives ${p.cellType === 'bistable' ? 'snap load' : 'amplification'} CoV ${f3(mcSd / Math.max(Math.abs(mcMean), 1e-12) * 100)} %; specify hinge thickness to ±${f3(2 * p.sdThick)} µm (2σ) or tune each unit after assembly.`, basis: `${mcMain.length}-sample Monte Carlo.` },
      { level: 'econ', text: `Monolithic flexures avoid pins, bearings and lubrication; pinned joints would add ${f3(WpinA * 1000)} mJ of friction per cycle here. A wire-EDM β-Ti flexure costs little per part at this size and needs no maintenance over ${fmt(p.lifeTarget, 2)} cycles if the Goodman margin holds.`, basis: `Material cost ≈ ${mat.cost} USD/kg.` },
      { level: 'sustain', text: `${mat.name}: ${mat.co2} kg CO₂e/kg and recyclability ≈ ${f3((mat.recyclable ?? 0.5) * 100)} %. Monolithic flexures are single-material parts that recycle easily; avoid bonded multi-material hinges.`, basis: 'Materials library.' },
    );
    // ---- animation ----
    if (p.cellType === 'amplifier') {
      const rows = ampRun.rows, dmax = rows[rows.length - 1].d, smx = Math.max(...rows.map(r => r.hot));
      out.views.push({ label: 'Amplifier stroke animation', icon: '⬡', render: async (el) => {
        const { anim2d, seriesPanel, theme, label, fs } = await import('../core/anim2d.js'), { cmap } = await import('../core/chart.js');
        const T = rows.map(r => r.d / dmax), ext = Math.max(BM.a, BM.c * 2.5) * 1.25;
        anim2d(el, { duration: 2, label: 'Cycle', unit: '', height: (W) => W < 640 ? 640 : 420, explain: 'The bridge closes at the input blocks (cartridge contraction) and opens at the apexes (output). Element colour is the local peak stress; the panel shows input and output force along the stroke.', draw: (g, t, W, H) => {
          const th = theme(), ph = t <= 1 ? t : 2 - t, q = ph * (rows.length - 1), k = Math.min(rows.length - 2, Math.floor(q)), f = q - k, r = rows[k], rn = rows[k + 1];
          const narrow = W < 640, dH = narrow ? 280 : H, cx = narrow ? W / 2 : W * 0.3, cy = dH / 2 - 8, sc = (narrow ? Math.min(W * 0.42, dH * 0.4) : Math.min(W * 0.28, H * 0.45)) / ext;
          BM.els.forEach((e, n) => { const ui = (a) => r.u[a] + (rn.u[a] - r.u[a]) * f, x1 = BM.X[e.i][0] + ui(3 * e.i), y1 = BM.X[e.i][1] + ui(3 * e.i + 1), x2 = BM.X[e.j][0] + ui(3 * e.j), y2 = BM.X[e.j][1] + ui(3 * e.j + 1); const s = r.st[n].sig / (smx || 1), c = cmap(Math.min(1, s), 'inferno'); g.strokeStyle = `rgb(${c.map(Math.round).join(',')})`; g.lineWidth = e.kind === 'arm' ? 6 : 2.5; g.beginPath(); g.moveTo(cx + x1 * sc, cy - y1 * sc); g.lineTo(cx + x2 * sc, cy - y2 * sc); g.stroke(); });
          label(g, `input closure ${fmt((r.d + (rn.d - r.d) * f) * 1000, 3)} mm → output ${fmt((r.dout + (rn.dout - r.dout) * f) * 1000, 3)} mm`, 10, dH - 12, { size: fs(W), maxW: (narrow ? W : W * 0.58) - 20 });
          seriesPanel(g, { x: narrow ? 10 : W * 0.6, y: narrow ? dH : 10, w: narrow ? W - 20 : W * 0.38, h: narrow ? H - dH - 10 : H - 20, T, series: [{ name: 'F_in', y: rows.map(q2 => q2.Fin), color: '#ef4444' }, { name: 'F_out', y: rows.map(q2 => q2.Fout), color: '#22c55e' }], t: ph, title: 'Force along the stroke', unit: 'N' });
        } });
      } });
    } else if (p.cellType === 'bistable') {
      const n = BB.d.length;
      out.views.push({ label: 'Snap-through animation', icon: '⬡', render: async (el) => {
        const { anim2d, seriesPanel, theme } = await import('../core/anim2d.js');
        const T = BB.d.map(v => v / BB.d[n - 1]);
        anim2d(el, { duration: 2, label: 'Cycle', unit: '', height: (W) => W < 640 ? 600 : 400, explain: 'Displacement-controlled continuation: the pre-shaped beam is pushed through its unstable branch (red) to the second stable state and back. The panel shows force along the path; negative force means the beam would snap without load.', draw: (g, t, W, H) => {
          const th = theme(), ph = t <= 1 ? t : 2 - t, k = Math.min(n - 1, Math.round(ph * (n - 1))), a = BB.coeffs[k], L = p.bL / 1000, narrow = W < 640, dH = narrow ? 240 : H, sc = (narrow ? W * 0.85 : W * 0.5) / L, ys = dH * 0.25 / Math.max(p.bH / 1000, 1e-9), cx = narrow ? W * 0.07 : W * 0.05, cy = dH * 0.55;
          g.strokeStyle = BB.F[k] < 0 ? '#ef4444' : th.accent; g.lineWidth = 3; g.beginPath(); for (let i = 0; i <= 60; i++) { const x = L * i / 60, w = bistShape(a, L, x); const px = cx + x * sc, py = cy - w * ys; i ? g.lineTo(px, py) : g.moveTo(px, py); } g.stroke();
          g.fillStyle = th.mute; g.fillRect(cx - 6, cy - 30, 6, 60); g.fillRect(cx + L * sc, cy - 30, 6, 60);
          seriesPanel(g, { x: narrow ? 10 : W * 0.62, y: narrow ? dH : 10, w: narrow ? W - 20 : W * 0.36, h: narrow ? H - dH - 10 : H - 20, T, series: [{ name: 'F', y: BB.F, color: '#22c55e' }], t: ph, title: 'Snap-through force', unit: 'N', hlines: [{ y: 0, label: '', color: '#64748b' }] });
        } });
      } });
    } else {
      out.views.push({ label: 'Lattice deformation animation', icon: '⬡', render: async (el) => {
        const { anim2d, theme, label, fs } = await import('../core/anim2d.js');
        const c = cellA, segs = []; for (let i = 0; i < Math.min(p.nx, 6); i++) for (let j = 0; j < Math.min(p.ny, 5); j++) { const o = [i * c.a1[0] + j * c.a2[0], j * c.a2[1]]; for (const s of c.struts) { const sh = s.shift || [0, 0], p1 = c.nodes[s.i], p2 = c.nodes[s.j]; segs.push([[o[0] + p1[0], o[1] + p1[1]], [o[0] + p2[0] + sh[0] * c.a1[0] + sh[1] * c.a2[0], o[1] + p2[1] + sh[0] * c.a1[1] + sh[1] * c.a2[1]]]); } }
        const xs = segs.flat().map(q => q[0]), ys = segs.flat().map(q => q[1]), x0 = Math.min(...xs), y0 = Math.min(...ys), spanX = Math.max(...xs) - x0 || 1, spanY = Math.max(...ys) - y0 || 1;
        anim2d(el, { duration: 2, label: 'Cycle', unit: '', height: 400, explain: 'Affine (homogenised) deformation of the re-entrant lattice, exaggerated ×' + f3(0.15 / Math.max(Math.abs(auxL.ex), 1e-9)) + ': input compression along x produces lateral contraction along y (negative Poisson ratio).', draw: (g, t, W, H) => {
          const th = theme(), ph = t <= 1 ? t : 2 - t, amp2 = 0.15 / Math.max(Math.abs(auxL.ex), 1e-9), ex = auxL.ex * ph * amp2, ey = auxL.ey * ph * amp2, sc = Math.min((W - 40) / spanX, (H - 60) / spanY) * 0.92, ox = (W - spanX * sc) / 2, oy = H - 16 - (H - 44 - spanY * sc) / 2;
          g.strokeStyle = th.accent; g.lineWidth = 2; for (const [a, b] of segs) { g.beginPath(); g.moveTo(ox + (a[0] - x0) * (1 + ex) * sc, oy - (a[1] - y0) * (1 + ey) * sc); g.lineTo(ox + (b[0] - x0) * (1 + ex) * sc, oy - (b[1] - y0) * (1 + ey) * sc); g.stroke(); }
          label(g, `ν_xy = ${fmt(LH.nuxy, 3)}  ε_x = ${fmt(auxL.ex * ph, 3)}  ε_y = ${fmt(auxL.ey * ph, 3)}`, 10, 8, { baseline: 'top', size: fs(W), maxW: W - 20, bg: true });
        } });
      } });
    }
    out.outputs = { amplification: sel.A, transEff: sel.eta, kEff_Nm: sel.kEff, Wloss_J: sel.Wloss, bucklingLoad_N: sel.Pcr, hotspot_MPa: sel.hot, cellType: p.cellType, strokeTransfer: sel.strokeRatio, goodmanSF: goodman, fatigueLife_cycles: life, storedEnergy_J: sel.dU };
    return out;
  },
};
