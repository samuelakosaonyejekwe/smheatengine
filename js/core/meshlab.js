// meshlab — 2-D computational meshing and P1 finite-element heat conduction for THERMA-X100 cross-sections.
//
// API (SI units throughout; x across the ribbon width, y through the stack thickness, per unit depth along the ribbon)
//   REGION_NAMES                         ['ribbon', 'contact', 'wall'] — element region tags (index = mesh.region[e])
//   cartridgeSection(o)                  ribbon (thickness t) + optional contact layer (tc) + channel plate with rectangular
//                                        coolant channels (chW × chH at pitch, web = plate metal between channel and ribbon
//                                        face). o: {t, tc, contact, chW, chH, web, skin, pitch, nPitch, plate:'shared'|'dedicated',
//                                        half}. 'shared' plates serve the ribbons on both faces (unit cell ends on the plate
//                                        mid-plane), 'dedicated' plates have an outer skin. half=true models y ≥ 0 with a
//                                        symmetry plane at the ribbon mid-plane. Returns geo {W, ymin, ymax, layers[{region,y0,y1}],
//                                        holes[{x0,x1,y0,y1,side}], areas{ribbon,contact,wall,channel}, wetPerimeter, errors[]}.
//   slabSection({Lh, W})                 single ribbon half-slab (verification geometry).
//   Boundary tags on mesh.bnd: 'channel-top' / 'channel-bottom' (fluid–wall interface; a BC given for 'channel' applies to
//                                        both), 'outer' (plate outer face or plate mid-plane), 'sym' (ribbon mid-plane in half
//                                        models), 'side' (periodic symmetry planes between channels). Untagged → adiabatic.
//   sizeField(geo, s)                    target element size h(x,y) = min(hMax, hRibbon + (g−1)·d_ribbon, hChannel + (g−1)·d_channel)
//   defaultSizes(geo, {nRibbon, nChannel, growth, maxAspect}) → {hRibbon, hChannel, hMax, growth, maxAspect}
//   scaleSizes(s, f)                     systematic refinement: every target size (and the growth slope) divided by f
//   spacing1D(a, b, hAt, refine)         graded 1-D node distribution equidistributing ∫ds/h (refine multiplies the base count)
//   structuredMesh(geo, s)               tensor-product graded grid split into right triangles (alternating diagonals);
//                                        s.refine > 1 refines systematically (same grading map, cell counts × refine)
//   triangulate(X, Y)                    Bowyer–Watson Delaunay triangulation of a point set (adjacency walk + cavity flood fill)
//   delaunayMesh(geo, s)                 Bowyer–Watson Delaunay of graded boundary points + quadtree interior points, boundary
//                                        recovery by midpoint insertion (encroachment refinement), validity-preserving smoothing
//   buildMesh(geo, {type, ...s})         either mesher. Mesh: {kind, geo, nodes[[x,y]], tris[[a,b,c]] (CCW), region Uint8Array,
//                                        bnd{tag:[[a,b]]}, nNodes, nElems, info}
//   meshQuality(mesh)                    min/max angle, aspect ratio, equiangle skewness, scaled Jacobian, inverted count, adjacent-
//                                        element area ratio (growth), element count, representative h = √(A/N); per-element arrays
//   femModel(mesh)                       cached geometric FE data (areas, gradients, CSR pattern, boundary-edge matrices)
//   solveSteady(mesh, {props, bcs, source, solver})   props {region:{k,rho,cp}}, bcs {tag:{type:'robin',h,Tinf}|{type:'neumann',q}|
//                                        {type:'dirichlet',T}} ('*' = any tag; h, Tinf, q may be functions of t; dirichlet T may be
//                                        f(x,y)), source {region: W/m³}. Returns {T, stats, Q (W/m per tag), it, res}
//   solveTransient(mesh, {props, bcs, source, T0, dt, tEnd, theta, enthalpy, picard, stop, snapEvery})
//                                        θ-method (θ=1 implicit Euler, θ=½ Crank–Nicolson), lumped capacity; banded Cholesky on the
//                                        RCM-ordered matrix (factored once per boundary state) or num.pcg (Jacobi, warm start) for
//                                        large meshes; optional enthalpy {region:(T)=>H J/m³} for latent heat (secant capacity +
//                                        Picard, solved by CG preconditioned with the sensible-capacity factorisation).
//                                        Returns {t[], stats{region:{mean,min,max}}, Q[], gradMax[], snaps[{t,T}], T, Ein, dH,
//                                        residual, regionDH{}, iterations}
//   regionStats(mesh, T)                 lumped-area mean, min, max per region; maxGradient(mesh, T, region) max |∇T| (K/m)
//   patchTest(mesh)                      linear-field patch test (all boundaries Dirichlet, uniform k) → {maxErr}
//   verifySlab({Lh,k,rho,cp,h,Tinf,T0,tEnd,...})   2-D FE vs analytic plane-wall eigen-series (heat.slabAnalytic)
//   meshStudy(geo, {type, sizes, levels, ratio, base, functional, ref, Fs, pFormal}) ≥3 systematically refined levels,
//                                        Richardson extrapolation, observed order, GCI (num.gci, Roache/Celik), asymptotic-range check
//                                        (p agreement between coarse and fine triplets); an observed order outside (0.5, p_formal+1) or
//                                        oscillatory convergence falls back to the formal order with F_s = 3 (flag 'capped')
//   selectMesh(study, {gciTarget, maxAngle, maxAR, minAngle, maxElems}) cheapest level meeting all explicit criteria (inside the
//                                        asymptotic range, error estimate ≤ target, quality limits, no inverted element, budget)
//   toMSH(mesh) Gmsh MSH 2.2 ASCII · toVTK(mesh, {point, cell}) legacy VTK unstructured grid · toCSV(mesh) {nodes, elements, boundary}
//   sampleGrid(mesh, values, nx, ny)     interpolate a nodal field to a regular grid {xs, ys, z[j][i]} (NaN outside / in channels)
//   paintField(g, mesh, values, box)     draw a nodal field on a 2-D canvas context; meshSVG(mesh, opts) SVG wireframe by region
import { SparseBuilder, pcg, csrMul, gci as gciFn, range, clamp } from './num.js';
import { slabAnalytic } from './heat.js';
import { bandCholesky } from './fem.js';

export const REGION_NAMES = ['ribbon', 'contact', 'wall'];
const RID = Object.fromEntries(REGION_NAMES.map((r, i) => [r, i]));
const uniq = (a, tol) => { const s = a.slice().sort((x, y) => x - y), o = []; for (const v of s) if (!o.length || v - o[o.length - 1] > tol) o.push(v); return o; };
const val = (v, t) => (typeof v === 'function' ? v(t) : v);
const bcOf = (bcs, tag) => bcs[tag] ?? bcs[tag.split('-')[0]] ?? bcs['*'] ?? null;

// ---------------- Geometry ----------------
export function cartridgeSection(o = {}) {
  const t = o.t ?? 100e-6, tc = o.contact === false ? 0 : Math.max(0, o.tc ?? 25e-6), chW = o.chW ?? 1e-3, chH = o.chH ?? 0.8e-3;
  const web = o.web ?? 0.2e-3, skin = o.skin ?? web, nPitch = Math.max(1, Math.round(o.nPitch ?? 1)), pitch = o.pitch ?? chW * 1.6;
  const plate = o.plate === 'dedicated' ? 'dedicated' : 'shared', half = o.half !== false, errors = [];
  if (!(t > 0)) errors.push('Ribbon thickness must be positive.');
  if (!(chW > 0 && chH > 0)) errors.push('Channel width and height must be positive.');
  if (!(chW < pitch)) errors.push(`Channel width ${(chW * 1e3).toFixed(3)} mm ≥ channel pitch ${(pitch * 1e3).toFixed(3)} mm: no land is left between channels.`);
  if (!(web > 0)) errors.push('The web between channel and ribbon face must be positive.');
  if (plate === 'dedicated' && !(skin > 0)) errors.push('The outer skin of a dedicated plate must be positive.');
  const yR = t / 2, yC = yR + tc, ch0 = yC + web, ch1 = ch0 + chH, ymax = plate === 'shared' ? ch0 + chH / 2 : ch1 + skin, W = nPitch * pitch;
  const lay = [{ region: 'ribbon', y0: 0, y1: yR }]; if (tc > 0) lay.push({ region: 'contact', y0: yR, y1: yC }); lay.push({ region: 'wall', y0: yC, y1: ymax });
  const top = range(nPitch).map(k => ({ x0: (k + 0.5) * pitch - chW / 2, x1: (k + 0.5) * pitch + chW / 2, y0: ch0, y1: Math.min(ch1, ymax), side: 'top' }));
  let layers = half ? lay : [...lay.map(l => ({ region: l.region, y0: -l.y1, y1: -l.y0 })).reverse(), ...lay];
  layers = layers.reduce((acc, l) => { const p = acc[acc.length - 1]; if (p && p.region === l.region && Math.abs(p.y1 - l.y0) < 1e-15) p.y1 = l.y1; else acc.push({ ...l }); return acc; }, []);
  const holes = half ? top : [...top.map(hh => ({ ...hh, y0: -hh.y1, y1: -hh.y0, side: 'bottom' })), ...top];
  const s = half ? 1 : 2, Ach = holes.reduce((a, hh) => a + (hh.x1 - hh.x0) * (hh.y1 - hh.y0), 0);
  const geo = { kind: 'cartridge', W, ymin: half ? 0 : -ymax, ymax, layers, holes, half, t, tc, chW, chH, web, skin, pitch, nPitch, plate, errors, yRibbon: yR, yContact: yC };
  geo.areas = { ribbon: W * yR * s, contact: W * tc * s, wall: W * (ymax - yC) * s - Ach, channel: Ach };
  geo.wetPerimeter = holes.reduce((a, hh) => a + (hh.x1 - hh.x0) * ((hh.y0 > geo.ymin + 1e-15 ? 1 : 0) + (hh.y1 < ymax - 1e-15 ? 1 : 0)) + 2 * (hh.y1 - hh.y0), 0);
  return geo;
}
export function slabSection({ Lh, W }) {
  W ??= Lh * 0.6;
  return { kind: 'slab', W, ymin: 0, ymax: Lh, layers: [{ region: 'ribbon', y0: 0, y1: Lh }], holes: [], half: true, t: 2 * Lh, tc: 0, errors: [], yRibbon: Lh, yContact: Lh, areas: { ribbon: W * Lh, contact: 0, wall: 0, channel: 0 }, wetPerimeter: 0 };
}
const bandOf = (geo) => { const b = geo.layers.filter(l => l.region !== 'wall'); return b.length ? [Math.min(...b.map(l => l.y0)), Math.max(...b.map(l => l.y1))] : [0, 0]; };
const inHole = (geo, x, y) => geo.holes.some(hh => x > hh.x0 && x < hh.x1 && y > hh.y0 && y < hh.y1);
const regionAt = (geo, y) => { for (const l of geo.layers) if (y >= l.y0 && y <= l.y1) return RID[l.region]; return RID.wall; };

// ---------------- Sizing ----------------
export function sizeField(geo, s) {
  const g1 = Math.max(0, (s.growth ?? 1.3) - 1), band = bandOf(geo), hc = s.hChannel ?? s.hMax;
  return (x, y) => {
    const dR = y < band[0] ? band[0] - y : y > band[1] ? y - band[1] : 0; let h = Math.min(s.hMax, s.hRibbon + g1 * dR);
    for (const o of geo.holes) { const dx = x < o.x0 ? o.x0 - x : x > o.x1 ? x - o.x1 : 0, dy = y < o.y0 ? o.y0 - y : y > o.y1 ? y - o.y1 : 0; h = Math.min(h, hc + g1 * Math.hypot(dx, dy)); }
    return h;
  };
}
export function defaultSizes(geo, { nRibbon = 3, nChannel = 6, growth = 1.3, maxAspect = 8 } = {}) {
  const tr = geo.half ? geo.yRibbon : 2 * geo.yRibbon, hRibbon = tr / nRibbon;
  const hChannel = geo.holes.length ? Math.min(geo.chW, geo.chH) / nChannel : hRibbon * 4;
  return { hRibbon, hChannel, hMax: Math.max(hChannel * 2.5, hRibbon * 2), growth, maxAspect };
}
export const scaleSizes = (s, f) => ({ ...s, hRibbon: s.hRibbon / f, hChannel: s.hChannel / f, hMax: s.hMax / f, growth: 1 + ((s.growth ?? 1.3) - 1) / f });
// Graded 1-D distribution on [a,b] following a local size function (equidistribution of ∫ds/h)
// refine > 1 keeps the same grading map and multiplies the base cell count (geometrically similar, systematic refinement)
export function spacing1D(a, b, hAt, refine = 1, m = 160) {
  const L = b - a; if (!(L > 0)) return [a];
  const cum = new Float64Array(m + 1);
  for (let k = 0; k < m; k++) cum[k + 1] = cum[k] + (L / m) / Math.max(1e-30, hAt(a + (k + 0.5) * L / m));
  const N = cum[m], n = Math.max(1, Math.round(Math.ceil(N - 1e-6) * refine)), out = [a]; let k = 0;
  for (let j = 1; j < n; j++) { const tg = j * N / n; while (cum[k + 1] < tg) k++; const f = (tg - cum[k]) / ((cum[k + 1] - cum[k]) || 1); out.push(a + (k + f) * L / m); }
  out.push(b); return out;
}

// ---------------- Mesh finalisation ----------------
function tagEdge(geo, p, q, tol) {
  const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
  for (const hh of geo.holes) {
    const onH = (Math.abs(my - hh.y0) < tol || Math.abs(my - hh.y1) < tol) && mx > hh.x0 - tol && mx < hh.x1 + tol;
    const onV = (Math.abs(mx - hh.x0) < tol || Math.abs(mx - hh.x1) < tol) && my > hh.y0 - tol && my < hh.y1 + tol;
    if (onH || onV) return 'channel-' + hh.side;
  }
  if (Math.abs(my - geo.ymax) < tol) return 'outer';
  if (Math.abs(my - geo.ymin) < tol) return geo.half ? 'sym' : 'outer';
  if (Math.abs(mx) < tol || Math.abs(mx - geo.W) < tol) return 'side';
  return 'other';
}
function finalizeMesh(geo, nodes, tris, kind, info = {}) {
  const nN = nodes.length, region = new Uint8Array(tris.length), E = new Map(), tol = 1e-7 * Math.max(geo.W, geo.ymax - geo.ymin);
  tris.forEach((t, e) => {
    const [a, b, c] = t, A2 = (nodes[b][0] - nodes[a][0]) * (nodes[c][1] - nodes[a][1]) - (nodes[c][0] - nodes[a][0]) * (nodes[b][1] - nodes[a][1]);
    if (A2 < 0) { t[1] = c; t[2] = b; }
    region[e] = regionAt(geo, (nodes[a][1] + nodes[b][1] + nodes[c][1]) / 3);
    for (let k = 0; k < 3; k++) { const u = t[k], v = t[(k + 1) % 3], key = u < v ? u * nN + v : v * nN + u, r = E.get(key); if (r) r.n++; else E.set(key, { n: 1, a: u, b: v }); }
  });
  const bnd = {}; for (const r of E.values()) if (r.n === 1) (bnd[tagEdge(geo, nodes[r.a], nodes[r.b], tol)] ||= []).push([r.a, r.b]);
  return { kind, geo, nodes, tris, region, regionNames: REGION_NAMES, bnd, nNodes: nN, nElems: tris.length, nEdges: E.size, info };
}

// ---------------- Structured graded mesher ----------------
export function structuredMesh(geo, s) {
  const g1 = Math.max(0, (s.growth ?? 1.3) - 1), band = bandOf(geo), H = geo.ymax - geo.ymin, tol = 1e-9 * Math.max(geo.W, H);
  const hxMax = Math.min(s.hMax, (s.maxAspect ?? 8) * s.hRibbon);
  const hx = (x) => { let h = hxMax; for (const o of geo.holes) h = Math.min(h, s.hChannel + g1 * Math.min(Math.abs(x - o.x0), Math.abs(x - o.x1))); return h; };
  const hy = (y) => { const dR = y < band[0] ? band[0] - y : y > band[1] ? y - band[1] : 0; let h = Math.min(s.hMax, s.hRibbon + g1 * dR); for (const o of geo.holes) { const d = y < o.y0 ? o.y0 - y : y > o.y1 ? y - o.y1 : Math.min(y - o.y0, o.y1 - y); h = Math.min(h, s.hChannel + g1 * d); } return h; };
  const xb = uniq([0, geo.W, ...geo.holes.flatMap(o => [o.x0, o.x1])].filter(x => x >= -tol && x <= geo.W + tol), tol);
  const yb = uniq([geo.ymin, geo.ymax, ...geo.layers.flatMap(l => [l.y0, l.y1]), ...geo.holes.flatMap(o => [o.y0, o.y1])].filter(y => y >= geo.ymin - tol && y <= geo.ymax + tol), tol);
  const rf = s.refine ?? 1, join = (br, fn) => { const o = [br[0]]; for (let k = 0; k < br.length - 1; k++) o.push(...spacing1D(br[k], br[k + 1], fn, rf).slice(1)); return o; };
  const xs = join(xb, hx), ys = join(yb, hy), nx = xs.length, ny = ys.length, idx = new Int32Array(nx * ny).fill(-1), nodes = [], tris = [];
  const id = (i, j) => { const k = j * nx + i; if (idx[k] < 0) { idx[k] = nodes.length; nodes.push([xs[i], ys[j]]); } return idx[k]; };
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    if (inHole(geo, (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2)) continue;
    const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
    if ((i + j) % 2) tris.push([a, b, c], [a, c, d]); else tris.push([a, b, d], [b, c, d]);
  }
  return finalizeMesh(geo, nodes, tris, 'structured', { nx: nx - 1, ny: ny - 1, sizes: s });
}

// ---------------- Unstructured Delaunay mesher ----------------
function constraintSegments(geo) {
  const { W, ymin, ymax, holes } = geo, tol = 1e-9 * Math.max(W, ymax - ymin), segs = [];
  const ys = uniq([ymin, ymax, ...geo.layers.flatMap(l => [l.y0, l.y1])], tol);
  const subtract = (iv, a, b) => iv.flatMap(([u, v]) => (b <= u || a >= v) ? [[u, v]] : [[u, Math.min(v, a)], [Math.max(u, b), v]].filter(([p, q]) => q - p > tol));
  for (const y of ys) {
    let iv = [[0, W]];
    for (const hh of holes) { const through = y > hh.y0 + tol && y < hh.y1 - tol, along = (Math.abs(y - ymax) < tol || Math.abs(y - ymin) < tol) && (Math.abs(y - hh.y1) < tol || Math.abs(y - hh.y0) < tol); if (through || along) iv = subtract(iv, hh.x0, hh.x1); }
    for (const [a, b] of iv) segs.push([a, y, b, y]);
  }
  for (const hh of holes) {
    if (hh.y0 > ymin + tol) segs.push([hh.x0, hh.y0, hh.x1, hh.y0]);
    if (hh.y1 < ymax - tol) segs.push([hh.x0, hh.y1, hh.x1, hh.y1]);
    for (const x of [hh.x0, hh.x1]) segs.push([x, hh.y0, x, hh.y1]);
  }
  const yAll = uniq([...ys, ...holes.flatMap(hh => [hh.y0, hh.y1])], tol);
  for (const x of [0, W]) for (let k = 0; k < yAll.length - 1; k++) segs.push([x, yAll[k], x, yAll[k + 1]]);
  return segs;
}
// Bowyer–Watson with triangle adjacency (walking point location, cavity search by flood fill); returns CCW triangles
export function triangulate(X, Y) {
  const n = X.length, PX = new Float64Array(n + 3), PY = new Float64Array(n + 3); PX.set(X); PY.set(Y);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < n; i++) { x0 = Math.min(x0, X[i]); x1 = Math.max(x1, X[i]); y0 = Math.min(y0, Y[i]); y1 = Math.max(y1, Y[i]); }
  const D = Math.max(x1 - x0, y1 - y0) || 1, cx0 = (x0 + x1) / 2, cy0 = (y0 + y1) / 2;
  PX[n] = cx0 - 60 * D; PY[n] = cy0 - 40 * D; PX[n + 1] = cx0 + 60 * D; PY[n + 1] = cy0 - 40 * D; PX[n + 2] = cx0; PY[n + 2] = cy0 + 60 * D;
  const V = [], NB = [], CX = [], CY = [], R2 = [], alive = [];
  const orient = (a, b, px, py) => (PX[b] - PX[a]) * (py - PY[a]) - (PY[b] - PY[a]) * (px - PX[a]);
  const add = (a, b, c) => {
    const t = alive.length; V.push(a, b, c); NB.push(-1, -1, -1);
    const ax = PX[a], ay = PY[a], bx = PX[b] - ax, by = PY[b] - ay, cx = PX[c] - ax, cy = PY[c] - ay, d = 2 * (bx * cy - by * cx) || 1e-300;
    const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy, ux = (cy * b2 - by * c2) / d, uy = (bx * c2 - cx * b2) / d;
    CX.push(ax + ux); CY.push(ay + uy); R2.push(ux * ux + uy * uy); alive.push(1); return t;
  };
  add(n, n + 1, n + 2);
  let last = 0, stamp = 0; const mark = [];
  const locate = (px, py) => {
    let t = last;
    for (let steps = 0; steps < 4 * alive.length + 16; steps++) {
      let moved = false;
      for (let k = 0; k < 3; k++) { const e = (k + steps) % 3, a = V[3 * t + e], b = V[3 * t + (e + 1) % 3]; if (orient(a, b, px, py) < 0) { const nb = NB[3 * t + e]; if (nb >= 0) { t = nb; moved = true; break; } } }
      if (!moved) return t;
    }
    for (let t2 = 0; t2 < alive.length; t2++) if (alive[t2] && orient(V[3 * t2], V[3 * t2 + 1], px, py) >= 0 && orient(V[3 * t2 + 1], V[3 * t2 + 2], px, py) >= 0 && orient(V[3 * t2 + 2], V[3 * t2], px, py) >= 0) return t2;
    return last;
  };
  for (let p = 0; p < n; p++) {
    const px = PX[p], py = PY[p], t0 = locate(px, py); stamp++;
    const bad = [t0]; mark[t0] = stamp;
    for (let q = 0; q < bad.length; q++) { const t = bad[q]; for (let e = 0; e < 3; e++) { const nb = NB[3 * t + e]; if (nb >= 0 && mark[nb] !== stamp && (px - CX[nb]) ** 2 + (py - CY[nb]) ** 2 < R2[nb] * (1 - 1e-12)) { mark[nb] = stamp; bad.push(nb); } } }
    const startMap = new Map(), endMap = new Map(), news = [];
    for (const t of bad) {
      alive[t] = 0;
      for (let e = 0; e < 3; e++) {
        const nb = NB[3 * t + e]; if (nb >= 0 && mark[nb] === stamp) continue;
        const a = V[3 * t + e], b = V[3 * t + (e + 1) % 3], nt = add(a, b, p); NB[3 * nt] = nb;
        if (nb >= 0) for (let k = 0; k < 3; k++) if (NB[3 * nb + k] === t) { NB[3 * nb + k] = nt; break; }
        startMap.set(a, nt); endMap.set(b, nt); news.push(nt);
      }
    }
    for (const nt of news) { const a = V[3 * nt], b = V[3 * nt + 1]; NB[3 * nt + 1] = startMap.get(b) ?? -1; NB[3 * nt + 2] = endMap.get(a) ?? -1; }
    last = news[0];
  }
  const out = []; for (let t = 0; t < alive.length; t++) if (alive[t] && V[3 * t] < n && V[3 * t + 1] < n && V[3 * t + 2] < n) out.push([V[3 * t], V[3 * t + 1], V[3 * t + 2]]);
  return out;
}
const zorder = (x, y) => { let z = 0; for (let b = 15; b >= 0; b--) z = z * 4 + (((x >> b) & 1) | (((y >> b) & 1) << 1)); return z; };
export function delaunayMesh(geo, s) {
  const hf = sizeField(geo, s), W = geo.W, H = geo.ymax - geo.ymin, Ls = Math.max(W, H), tol = 1e-9 * Ls, segs = constraintSegments(geo);
  const pts = [], keys = new Map(), fixed = [];
  const addPt = (x, y, fx = true) => { const k = Math.round(x / tol) + ',' + Math.round(y / tol); if (keys.has(k)) return keys.get(k); keys.set(k, pts.length); pts.push([x, y]); fixed.push(fx); return pts.length - 1; };
  let sub = [];
  for (const [ax, ay, bx, by] of segs) {
    const L = Math.hypot(bx - ax, by - ay), us = spacing1D(0, L, (u) => hf(ax + (bx - ax) * u / L, ay + (by - ay) * u / L));
    const ids = us.map(u => addPt(ax + (bx - ax) * u / L, ay + (by - ay) * u / L)); for (let k = 0; k < ids.length - 1; k++) sub.push([ids[k], ids[k + 1]]);
  }
  // interior points: quadtree leaves of size ≤ h, kept away from constraint lines (no encroachment of their diametral circles)
  const SG = Float64Array.from(segs.flatMap(([ax, ay, bx, by]) => [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)])), nS = segs.length;
  const segDist = (x, y) => { let d2 = Infinity; for (let k = 0; k < nS; k++) { const o = 4 * k, dx = Math.max(SG[o] - x, 0, x - SG[o + 2]), dy = Math.max(SG[o + 1] - y, 0, y - SG[o + 3]), q = dx * dx + dy * dy; if (q < d2) d2 = q; } return Math.sqrt(d2); };
  const S0 = Math.min(W, H), cand = [];
  const rec = (x0, y0, sz, d) => {
    if (x0 >= W || y0 >= geo.ymax) return;
    const cx = x0 + sz / 2, cy = y0 + sz / 2, hc = hf(Math.min(cx, W), Math.min(cy, geo.ymax));
    if (sz > 0.7 * hc && d < 18) { const s2 = sz / 2; rec(x0, y0, s2, d + 1); rec(x0 + s2, y0, s2, d + 1); rec(x0, y0 + s2, s2, d + 1); rec(x0 + s2, y0 + s2, s2, d + 1); return; }
    if (cx <= 0 || cx >= W || cy <= geo.ymin || cy >= geo.ymax) return;
    const jx = ((Math.sin(cx * 12.9898e4 + cy * 78.233e4) * 43758.5453) % 1) * 0.04 * sz, jy = ((Math.sin(cx * 39.3468e4 + cy * 11.135e4) * 24634.6345) % 1) * 0.04 * sz;
    const px = cx + jx, py = cy + jy;
    if (!inHole(geo, px, py)) cand.push([px, py, hc]);
  };
  for (let y0 = geo.ymin; y0 < geo.ymax - tol; y0 += S0) for (let x0 = 0; x0 < W - tol; x0 += S0) rec(x0, y0, S0, 0);
  // greedy Poisson-disk thinning (finest sizes first): accept a candidate if no accepted point lies within 0.85·h
  cand.sort((a, b) => a[2] - b[2]);
  const hMin = cand.length ? cand[0][2] : s.hRibbon, c1 = hMin * 0.85, c2 = 8 * c1, g1h = new Map(), g2h = new Map();
  const hk = (i, j) => (i + 4096) * 1048576 + (j + 4096);
  const put = (x, y) => { for (const [g, c] of [[g1h, c1], [g2h, c2]]) { const k = hk(Math.floor(x / c), Math.floor((y - geo.ymin) / c)), a = g.get(k); if (a) a.push(x, y); else g.set(k, [x, y]); } };
  const near = (x, y, r) => { const fine = r < 4 * c1, g = fine ? g1h : g2h, c = fine ? c1 : c2, i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((y - geo.ymin - r) / c), j1 = Math.floor((y - geo.ymin + r) / c), r2 = r * r; for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const a = g.get(hk(i, j)); if (a) for (let k = 0; k < a.length; k += 2) if ((a[k] - x) ** 2 + (a[k + 1] - y) ** 2 < r2) return true; } return false; };
  for (const p of pts) put(p[0], p[1]);
  let nInt = 0; for (const [x, y, hc] of cand) if (!near(x, y, 0.85 * hc) && segDist(x, y) >= 0.5 * hc) { put(x, y); addPt(x, y, false); nInt++; }
  // triangulate, recover every constraint sub-segment by midpoint insertion, then discard hole/outside triangles
  let tris = [], rounds = 0, missing = 0;
  for (; rounds < 10; rounds++) {
    const zk = pts.map(p => zorder(Math.floor(p[0] / Ls * 65535), Math.floor((p[1] - geo.ymin) / Ls * 65535))), order = range(pts.length).sort((a, b) => zk[a] - zk[b]);
    const X = Float64Array.from(order, i => pts[i][0] / Ls), Y = Float64Array.from(order, i => (pts[i][1] - geo.ymin) / Ls);
    tris = triangulate(X, Y).map(t => t.map(k => order[k]));
    const N = pts.length, ek = new Set(); for (const t of tris) for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3]; ek.add(a < b ? a * N + b : b * N + a); }
    const next = []; missing = 0;
    for (const [a, b] of sub) { if (ek.has(a < b ? a * N + b : b * N + a)) { next.push([a, b]); continue; } missing++; const m = addPt((pts[a][0] + pts[b][0]) / 2, (pts[a][1] + pts[b][1]) / 2); next.push([a, m], [m, b]); }
    sub = next; if (!missing) break;
  }
  tris = tris.filter(t => { const cx = (pts[t[0]][0] + pts[t[1]][0] + pts[t[2]][0]) / 3, cy = (pts[t[0]][1] + pts[t[1]][1] + pts[t[2]][1]) / 3; return cx > 0 && cx < W && cy > geo.ymin && cy < geo.ymax && !inHole(geo, cx, cy); });
  // validity-preserving Laplacian smoothing of free interior nodes (accepted only if the worst incident element improves)
  const nP = pts.length, PX = Float64Array.from(pts, p => p[0]), PY = Float64Array.from(pts, p => p[1]), inc = Array.from({ length: nP }, () => []), nbr = Array.from({ length: nP }, () => new Set());
  tris.forEach((t, e) => { for (let k = 0; k < 3; k++) { inc[t[k]].push(e); nbr[t[k]].add(t[(k + 1) % 3]); nbr[t[k]].add(t[(k + 2) % 3]); } });
  const NBR = nbr.map(st => Int32Array.from(st));
  const qual = (e) => { const t = tris[e], a = t[0], b = t[1], c = t[2], A2 = (PX[b] - PX[a]) * (PY[c] - PY[a]) - (PX[c] - PX[a]) * (PY[b] - PY[a]), l2 = (PX[b] - PX[a]) ** 2 + (PY[b] - PY[a]) ** 2 + (PX[c] - PX[b]) ** 2 + (PY[c] - PY[b]) ** 2 + (PX[a] - PX[c]) ** 2 + (PY[a] - PY[c]) ** 2; return 2 * Math.sqrt(3) * A2 / l2; };
  const sgnFix = tris.map(t => ((PX[t[1]] - PX[t[0]]) * (PY[t[2]] - PY[t[0]]) - (PX[t[2]] - PX[t[0]]) * (PY[t[1]] - PY[t[0]])) < 0); tris.forEach((t, e) => { if (sgnFix[e]) { const q = t[1]; t[1] = t[2]; t[2] = q; } });
  const worst = (v) => { let m = Infinity; for (const e of inc[v]) { const q = qual(e); if (q < m) m = q; } return m; };
  for (let it = 0; it < 4; it++) for (let v = 0; v < nP; v++) {
    if (fixed[v] || !inc[v].length) continue;
    let sx = 0, sy = 0; const L = NBR[v]; for (let k = 0; k < L.length; k++) { sx += PX[L[k]]; sy += PY[L[k]]; }
    const ox = PX[v], oy = PY[v], q0 = worst(v); PX[v] = sx / L.length; PY[v] = sy / L.length;
    if (worst(v) < Math.max(q0, 1e-6)) { PX[v] = ox; PY[v] = oy; }
  }
  for (let v = 0; v < nP; v++) pts[v] = [PX[v], PY[v]];
  // compact unused points
  const used = new Int32Array(pts.length).fill(-1), nodes = [];
  for (const t of tris) for (let k = 0; k < 3; k++) { if (used[t[k]] < 0) { used[t[k]] = nodes.length; nodes.push(pts[t[k]]); } t[k] = used[t[k]]; }
  return finalizeMesh(geo, nodes, tris, 'delaunay', { recoveryRounds: rounds, unrecovered: missing, interiorPoints: nInt, sizes: s });
}
export const buildMesh = (geo, o = {}) => (o.type === 'delaunay' ? delaunayMesh(geo, o) : structuredMesh(geo, o));

// ---------------- Quality ----------------
export function meshQuality(mesh) {
  const { nodes, tris } = mesh, nE = tris.length, minA = new Float64Array(nE), maxA = new Float64Array(nE), ar = new Float64Array(nE), skew = new Float64Array(nE), sj = new Float64Array(nE), area = new Float64Array(nE);
  let inverted = 0, Atot = 0, hMin = Infinity, hMaxE = 0;
  for (let e = 0; e < nE; e++) {
    const P = tris[e].map(k => nodes[k]), L = [0, 1, 2].map(k => Math.hypot(P[(k + 1) % 3][0] - P[k][0], P[(k + 1) % 3][1] - P[k][1]));
    const A2 = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]); if (A2 <= 0) inverted++;
    const A = Math.abs(A2) / 2; area[e] = A; Atot += A;
    const ang = [0, 1, 2].map(k => { const a = L[k], b = L[(k + 2) % 3], c = L[(k + 1) % 3]; return Math.acos(clamp((a * a + b * b - c * c) / (2 * a * b), -1, 1)) * 180 / Math.PI; });
    minA[e] = Math.min(...ang); maxA[e] = Math.max(...ang);
    skew[e] = Math.max((maxA[e] - 60) / 120, (60 - minA[e]) / 60);
    const sp = (L[0] + L[1] + L[2]) / 2; ar[e] = Math.max(...L) / (2 * Math.sqrt(3) * (A / sp));
    sj[e] = Math.sign(A2) * Math.min(...[0, 1, 2].map(k => 2 * A / (L[k] * L[(k + 2) % 3]))) / (Math.sqrt(3) / 2);
    const he = Math.sqrt(2 * A); hMin = Math.min(hMin, he); hMaxE = Math.max(hMaxE, he);
  }
  // adjacent-element area ratio (growth) across interior edges
  const E = new Map(), nN = nodes.length; let maxRatio = 1, sumRatio = 0, nInt = 0;
  tris.forEach((t, e) => { for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3], key = a < b ? a * nN + b : b * nN + a; if (E.has(key)) { const o = E.get(key), r = Math.max(area[e], area[o]) / Math.max(1e-300, Math.min(area[e], area[o])); maxRatio = Math.max(maxRatio, r); sumRatio += r; nInt++; } else E.set(key, e); } });
  let mn = Infinity, mx = 0, sMin = 0, sAR = 0, sSk = 0, maxAR = 0, maxSk = 0, minSJ = Infinity;
  for (let e = 0; e < nE; e++) { mn = Math.min(mn, minA[e]); mx = Math.max(mx, maxA[e]); sMin += minA[e]; sAR += ar[e]; sSk += skew[e]; maxAR = Math.max(maxAR, ar[e]); maxSk = Math.max(maxSk, skew[e]); minSJ = Math.min(minSJ, sj[e]); }
  return { nElem: nE, nNode: nN, minAngle: mn, maxAngle: mx, meanMinAngle: sMin / nE, maxAR, meanAR: sAR / nE, maxSkew: maxSk, meanSkew: sSk / nE, minScaledJacobian: minSJ, inverted, maxAreaRatio: maxRatio, meanAreaRatio: nInt ? sumRatio / nInt : 1, area: Atot, hRep: Math.sqrt(Atot / nE), hMin, hMax: hMaxE, minAngles: minA, maxAngles: maxA, aspect: ar, skewness: skew };
}

// ---------------- P1 finite elements ----------------
const FEM_CACHE = new WeakMap();
export function femModel(mesh) {
  if (FEM_CACHE.has(mesh)) return FEM_CACHE.get(mesh);
  const { nodes, tris, bnd, region } = mesh, nN = nodes.length, nE = tris.length, nR = REGION_NAMES.length;
  const area = new Float64Array(nE), G = new Float64Array(nE * 6), nodeArea = new Float64Array(nR * nN), regionArea = new Float64Array(nR), sb = new SparseBuilder(nN);
  for (let e = 0; e < nE; e++) {
    const [a, b, c] = tris[e], [x1, y1] = nodes[a], [x2, y2] = nodes[b], [x3, y3] = nodes[c], A2 = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1), A = A2 / 2;
    area[e] = A; G.set([y2 - y3, y3 - y1, y1 - y2, x3 - x2, x1 - x3, x2 - x1], 6 * e);
    for (const u of tris[e]) { nodeArea[region[e] * nN + u] += A / 3; for (const v of tris[e]) sb.add(u, v, 0); }
    regionArea[region[e]] += A;
  }
  for (const list of Object.values(bnd)) for (const [a, b] of list) { sb.add(a, a, 0); sb.add(a, b, 0); sb.add(b, a, 0); sb.add(b, b, 0); }
  const csr = sb.toCSR();
  const find = (i, j) => { let lo = csr.ptr[i], hi = csr.ptr[i + 1] - 1; while (lo <= hi) { const m = (lo + hi) >> 1, c = csr.col[m]; if (c === j) return m; if (c < j) lo = m + 1; else hi = m - 1; } return -1; };
  const ePos = new Int32Array(nE * 9); for (let e = 0; e < nE; e++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) ePos[9 * e + 3 * i + j] = find(tris[e][i], tris[e][j]);
  const diagPos = Int32Array.from(range(nN), i => find(i, i)), edges = {};
  for (const [tag, list] of Object.entries(bnd)) {
    const R = new Float64Array(csr.nnz), load = new Float64Array(nN), len = new Float64Array(list.length);
    list.forEach(([a, b], k) => { const L = Math.hypot(nodes[b][0] - nodes[a][0], nodes[b][1] - nodes[a][1]); len[k] = L; R[find(a, a)] += L / 3; R[find(b, b)] += L / 3; R[find(a, b)] += L / 6; R[find(b, a)] += L / 6; load[a] += L / 2; load[b] += L / 2; });
    edges[tag] = { list, R, load, len, nodes: [...new Set(list.flat())], length: len.reduce((s, v) => s + v, 0) };
  }
  const F = { nN, nE, nR, area, G, nodeArea, regionArea, csr, ePos, diagPos, edges };
  FEM_CACHE.set(mesh, F); return F;
}
function stiffness(F, mesh, kR) {
  const v = new Float64Array(F.csr.nnz), { G, area, ePos } = F;
  for (let e = 0; e < F.nE; e++) {
    const s = kR[mesh.region[e]] / (4 * area[e]), o = 6 * e;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) v[ePos[9 * e + 3 * i + j]] += s * (G[o + i] * G[o + j] + G[o + 3 + i] * G[o + 3 + j]);
  }
  return v;
}
const propArr = (props, key, def) => REGION_NAMES.map(r => props?.[r]?.[key] ?? props?.wall?.[key] ?? def);
export function regionStats(mesh, T, F = femModel(mesh)) {
  const out = {};
  for (let r = 0; r < F.nR; r++) { if (!(F.regionArea[r] > 0)) continue; let s = 0, mn = Infinity, mx = -Infinity; const o = r * F.nN; for (let i = 0; i < F.nN; i++) { const w = F.nodeArea[o + i]; if (w > 0) { s += w * T[i]; if (T[i] < mn) mn = T[i]; if (T[i] > mx) mx = T[i]; } } out[REGION_NAMES[r]] = { mean: s / F.regionArea[r], min: mn, max: mx, area: F.regionArea[r] }; }
  return out;
}
// Maximum gradient magnitude |∇T| (K/m) over elements of one region
export function maxGradient(mesh, T, regionName = 'ribbon', F = femModel(mesh)) {
  const r = RID[regionName]; let g = 0;
  for (let e = 0; e < F.nE; e++) { if (mesh.region[e] !== r) continue; const [a, b, c] = mesh.tris[e], o = 6 * e, gx = (F.G[o] * T[a] + F.G[o + 1] * T[b] + F.G[o + 2] * T[c]) / (2 * F.area[e]), gy = (F.G[o + 3] * T[a] + F.G[o + 4] * T[b] + F.G[o + 5] * T[c]) / (2 * F.area[e]); g = Math.max(g, Math.hypot(gx, gy)); }
  return g;
}
// Assemble boundary operator contributions at time t into (val, f); returns Dirichlet node list
function boundaryOps(F, mesh, bcs, t, val0, f) {
  const dir = new Map(), robin = [];
  for (const [tag, ed] of Object.entries(F.edges)) {
    const bc = bcOf(bcs, tag); if (!bc) continue;
    if (bc.type === 'robin') { const h = val(bc.h, t), Ti = val(bc.Tinf, t); if (!(h > 0)) continue; for (let k = 0; k < val0.length; k++) if (ed.R[k]) val0[k] += h * ed.R[k]; for (const i of ed.nodes) f[i] += h * Ti * ed.load[i]; robin.push({ tag, ed, h, Ti }); }
    else if (bc.type === 'neumann') { const q = val(bc.q, t); for (const i of ed.nodes) f[i] += q * ed.load[i]; robin.push({ tag, ed, h: 0, Ti: 0, q }); }
    else if (bc.type === 'dirichlet') for (const i of ed.nodes) dir.set(i, typeof bc.T === 'function' && bc.T.length >= 2 ? bc.T(mesh.nodes[i][0], mesh.nodes[i][1]) : val(bc.T, t));
  }
  return { dir, robin };
}
// Reverse Cuthill–McKee ordering (cached per FE model) and a banded-Cholesky direct solver on the permuted matrix
function rcm(F) {
  if (F.rcm) return F.rcm;
  const n = F.nN, { ptr, col } = F.csr, deg = Int32Array.from(range(n), i => ptr[i + 1] - ptr[i]), seen = new Uint8Array(n), order = [];
  while (order.length < n) {
    let s0 = -1; for (let i = 0; i < n; i++) if (!seen[i] && (s0 < 0 || deg[i] < deg[s0])) s0 = i;
    seen[s0] = 1; order.push(s0);
    for (let q = order.length - 1; q < order.length; q++) { const v = order[q], nb = []; for (let k = ptr[v]; k < ptr[v + 1]; k++) { const j = col[k]; if (!seen[j]) { seen[j] = 1; nb.push(j); } } nb.sort((a, b) => deg[a] - deg[b]); for (const j of nb) order.push(j); }
  }
  order.reverse();
  const perm = Int32Array.from(order), inv = new Int32Array(n); perm.forEach((o, i) => { inv[o] = i; });
  const p2 = new Int32Array(n + 1), c2 = new Int32Array(F.csr.nnz), map = new Int32Array(F.csr.nnz); let bw = 0, k2 = 0;
  for (let i = 0; i < n; i++) { const o = perm[i]; for (let k = ptr[o]; k < ptr[o + 1]; k++) { c2[k2] = inv[col[k]]; map[k2++] = k; bw = Math.max(bw, Math.abs(inv[col[k]] - i)); } p2[i + 1] = k2; }
  return (F.rcm = { perm, inv, ptr: p2, col: c2, map, bw });
}
function directSolver(F, val) {
  const P = rcm(F), n = F.nN, v2 = new Float64Array(P.map.length); for (let k = 0; k < v2.length; k++) v2[k] = val[P.map[k]];
  const fac = bandCholesky({ n, ptr: P.ptr, col: P.col, val: v2 });
  return { solve(b) { const bp = new Float64Array(n); for (let i = 0; i < n; i++) bp[i] = b[P.perm[i]]; const y = fac.solve(bp), x = new Float64Array(n); for (let i = 0; i < n; i++) x[P.perm[i]] = y[i]; return x; }, bandwidth: fac.bandwidth };
}
const directCost = (F) => F.nN * rcm(F).bw ** 2;
// Conjugate gradients preconditioned by a fixed factorisation M (used for enthalpy steps: A = A_base + positive diagonal)
function pcgFactor(A, b, M, x0, tol = 1e-10, maxIt = 200) {
  const n = A.n, x = Float64Array.from(x0), r = new Float64Array(n), Ap = new Float64Array(n); csrMul(A, x, Ap);
  let bn = 0; for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; bn += b[i] * b[i]; } bn = Math.sqrt(bn) || 1;
  let z = M.solve(r), p = Float64Array.from(z), rz = 0; for (let i = 0; i < n; i++) rz += r[i] * z[i];
  for (let it = 0; it < maxIt; it++) {
    let rn = 0; for (let i = 0; i < n; i++) rn += r[i] * r[i]; if (Math.sqrt(rn) / bn < tol) return { x, it, res: Math.sqrt(rn) / bn };
    csrMul(A, p, Ap); let pAp = 0; for (let i = 0; i < n; i++) pAp += p[i] * Ap[i]; const al = rz / pAp;
    for (let i = 0; i < n; i++) { x[i] += al * p[i]; r[i] -= al * Ap[i]; }
    z = M.solve(r); let rz1 = 0; for (let i = 0; i < n; i++) rz1 += r[i] * z[i]; const be = rz1 / rz; rz = rz1;
    for (let i = 0; i < n; i++) p[i] = z[i] + be * p[i];
  }
  let rn = 0; for (let i = 0; i < n; i++) rn += r[i] * r[i]; return { x, it: maxIt, res: Math.sqrt(rn) / bn };
}
// Symmetric elimination of Dirichlet rows/columns (keeps the operator SPD for PCG)
function applyDirichlet(A, b, dir) {
  if (!dir.size) return;
  const n = A.n, fx = new Uint8Array(n), Tv = new Float64Array(n); for (const [i, v] of dir) { fx[i] = 1; Tv[i] = v; }
  for (let i = 0; i < n; i++) for (let k = A.ptr[i]; k < A.ptr[i + 1]; k++) { const j = A.col[k]; if (fx[i]) A.val[k] = i === j ? 1 : 0; else if (fx[j]) { b[i] -= A.val[k] * Tv[j]; A.val[k] = 0; } }
  for (const [i, v] of dir) b[i] = v;
}
const tagFlux = (rb, T) => { let Q = 0; for (const { ed, h, Ti, q } of rb) for (let k = 0; k < ed.list.length; k++) { const [a, b] = ed.list[k]; Q += q !== undefined ? q * ed.len[k] : h * ed.len[k] * (Ti - (T[a] + T[b]) / 2); } return Q; };
function sourceVec(F, mesh, source, nN) {
  const f = new Float64Array(nN); let tot = 0;
  for (let e = 0; e < F.nE; e++) { const q = source?.[REGION_NAMES[mesh.region[e]]]; if (!q) continue; for (const v of mesh.tris[e]) f[v] += q * F.area[e] / 3; tot += q * F.area[e]; }
  return { f, tot };
}
export function solveSteady(mesh, { props, bcs = {}, source = {}, tol = 1e-11, maxIt, solver = 'auto' } = {}) {
  const F = femModel(mesh), nN = F.nN, A = { n: nN, ptr: F.csr.ptr, col: F.csr.col, val: stiffness(F, mesh, propArr(props, 'k', 1)) };
  const { f: b, tot: Qsrc } = sourceVec(F, mesh, source, nN), { dir, robin } = boundaryOps(F, mesh, bcs, 0, A.val, b);
  if (!dir.size && !robin.some(r => r.h > 0)) throw new Error('Steady conduction needs at least one Dirichlet or convective (Robin) boundary.');
  applyDirichlet(A, b, dir);
  const r = (solver === 'direct' || (solver !== 'pcg' && directCost(F) < 1e8)) ? { x: directSolver(F, A.val).solve(b), it: 1, res: 0, ok: true, direct: true } : pcg(A, b, { tol, maxIt: maxIt ?? Math.max(2000, 20 * nN) });
  const Q = {}; for (const rb of robin) Q[rb.tag] = tagFlux([rb], r.x);
  return { T: r.x, it: r.it, res: r.res, ok: r.ok, solver: r.direct ? 'banded Cholesky (RCM)' : 'Jacobi-PCG', stats: regionStats(mesh, r.x, F), Q, Qsource: Qsrc };
}
export function solveTransient(mesh, o) {
  const { props, bcs = {}, source = {}, theta = 1, enthalpy = null, picard = 2, tol = 1e-9, stop = null, snapEvery = 0, maxSnaps = 80, solver = 'auto' } = o;
  const F = femModel(mesh), nN = F.nN, nnz = F.csr.nnz, dt = o.dt, steps = o.steps ?? Math.max(1, Math.round(o.tEnd / dt));
  const K = stiffness(F, mesh, propArr(props, 'k', 1)), rcR = REGION_NAMES.map((r) => (props?.[r]?.rho ?? props?.wall?.rho ?? 1) * (props?.[r]?.cp ?? props?.wall?.cp ?? 1));
  const Hn = (r, T) => (enthalpy?.[REGION_NAMES[r]] ? enthalpy[REGION_NAMES[r]](T) : rcR[r] * T);
  const nodeH = (i, T) => { let s = 0; for (let r = 0; r < F.nR; r++) { const w = F.nodeArea[r * nN + i]; if (w > 0) s += w * Hn(r, T); } return s; };
  const nodeC = (i, T) => { let s = 0; for (let r = 0; r < F.nR; r++) { const w = F.nodeArea[r * nN + i]; if (w > 0) s += w * rcR[r]; } return s; };
  let T = typeof o.T0 === 'number' ? new Float64Array(nN).fill(o.T0) : Float64Array.from(o.T0);
  const T0 = Float64Array.from(T), C = new Float64Array(nN), Keff = new Float64Array(nnz), Aval = new Float64Array(nnz), rhs = new Float64Array(nN), w = new Float64Array(nN), Tth = new Float64Array(nN), dPrev = new Float64Array(nN);
  const { f: fs, tot: Qsrc } = sourceVec(F, mesh, source, nN), Amat = { n: nN, ptr: F.csr.ptr, col: F.csr.col, val: Aval }, Kmat = { n: nN, ptr: F.csr.ptr, col: F.csr.col, val: Keff };
  const names = Object.keys(regionStats(mesh, T, F)), hist = { t: [0], Q: [0], gradMax: [maxGradient(mesh, T, 'ribbon', F)], stats: Object.fromEntries(names.map(n => [n, { mean: [], min: [], max: [] }])) };
  const record = (Tv) => { const st = regionStats(mesh, Tv, F); for (const n of names) { hist.stats[n].mean.push(st[n].mean); hist.stats[n].min.push(st[n].min); hist.stats[n].max.push(st[n].max); } return st; };
  record(T); const snaps = snapEvery ? [{ t: 0, T: Float64Array.from(T) }] : [];
  let Ein = 0, its = 0, s = 0, maxRes = 0, fac = null, facSig = '';
  const useDirect = solver === 'direct' || (solver !== 'pcg' && directCost(F) < 1e8), Cbase = Float64Array.from({ length: nN }, (_, i) => nodeC(i)), Abase = new Float64Array(nnz), Bmat = { n: nN, ptr: F.csr.ptr, col: F.csr.col, val: Abase };
  const secant = (i, a, b) => { const d = b - a; if (!enthalpy || Math.abs(d) < 1e-7) { if (!enthalpy) return nodeC(i); const e = 1e-4; return (nodeH(i, a + e) - nodeH(i, a - e)) / (2 * e); } return (nodeH(i, b) - nodeH(i, a)) / d; };
  for (s = 1; s <= steps; s++) {
    const t1 = s * dt, tE = (s - 1 + theta) * dt;
    Keff.set(K); const f = Float64Array.from(fs), { dir, robin } = boundaryOps(F, mesh, bcs, tE, Keff, f);
    for (let i = 0; i < nN; i++) C[i] = secant(i, T[i], T[i] + dPrev[i]);
    csrMul(Kmat, T, w); let Tn = T;
    for (let it = 0; it < (enthalpy ? Math.max(1, picard) : 1); it++) {
      for (let k = 0; k < nnz; k++) Aval[k] = theta * Keff[k];
      for (let i = 0; i < nN; i++) { Aval[F.diagPos[i]] += C[i] / dt; rhs[i] = C[i] / dt * T[i] - (1 - theta) * w[i] + f[i]; }
      applyDirichlet(Amat, rhs, dir);
      if (useDirect) {
        const sig = robin.map(r => r.h).join(',') + '|' + [...dir.keys()].join(',');
        if (!fac || sig !== facSig) { // factor θK + C_sensible/Δt once per boundary-condition state
          for (let k = 0; k < nnz; k++) Abase[k] = theta * Keff[k]; for (let i = 0; i < nN; i++) Abase[F.diagPos[i]] += Cbase[i] / dt;
          applyDirichlet(Bmat, new Float64Array(nN), dir); fac = directSolver(F, Abase); facSig = sig;
        }
        if (enthalpy) { const r = pcgFactor(Amat, rhs, fac, Tn, Math.min(tol, 1e-10)); its += r.it + 1; maxRes = Math.max(maxRes, r.res); Tn = r.x; } else { Tn = fac.solve(rhs); its++; }
      }
      else { const r = pcg(Amat, rhs, { tol, maxIt: Math.max(1000, 10 * nN), x0: Tn }); its += r.it; maxRes = Math.max(maxRes, r.res); Tn = r.x; }
      if (enthalpy && it < picard - 1) for (let i = 0; i < nN; i++) C[i] = secant(i, T[i], Tn[i]);
    }
    for (let i = 0; i < nN; i++) Tth[i] = theta * Tn[i] + (1 - theta) * T[i];
    let Qb = tagFlux(robin, Tth) + Qsrc;
    if (dir.size) { csrMul(Kmat, Tth, w); for (const [i] of dir) Qb += C[i] * (Tn[i] - T[i]) / dt + w[i] - f[i]; }
    Ein += Qb * dt;
    for (let i = 0; i < nN; i++) dPrev[i] = Tn[i] - T[i];
    T = Float64Array.from(Tn);
    hist.t.push(t1); hist.Q.push(Qb); hist.gradMax.push(maxGradient(mesh, T, 'ribbon', F)); const st = record(T);
    if (snapEvery && (s % snapEvery === 0) && snaps.length < maxSnaps) snaps.push({ t: t1, T: Float64Array.from(T) });
    if (stop && stop({ t: t1, stats: st, T, step: s, Q: Qb })) break;
  }
  if (snapEvery && snaps[snaps.length - 1].t < hist.t[hist.t.length - 1]) snaps.push({ t: hist.t[hist.t.length - 1], T: Float64Array.from(T) });
  let dH = 0; const regionDH = {};
  for (let r = 0; r < F.nR; r++) { let s2 = 0; for (let i = 0; i < nN; i++) { const wgt = F.nodeArea[r * nN + i]; if (wgt > 0) s2 += wgt * (Hn(r, T[i]) - Hn(r, T0[i])); } if (F.regionArea[r] > 0) regionDH[REGION_NAMES[r]] = s2; dH += s2; }
  return { ...hist, snaps, T, Ein, dH, residual: Math.abs(Ein - dH) / Math.max(1e-30, Math.abs(Ein)), regionDH, iterations: its, solver: useDirect ? (enthalpy ? 'CG preconditioned by banded Cholesky (RCM)' : 'banded Cholesky (RCM)') : 'Jacobi-PCG', steps: Math.min(s, steps), dt, theta, maxLinearResidual: maxRes };
}

// ---------------- Verification helpers ----------------
export function patchTest(mesh) {
  const { W, ymin, ymax } = mesh.geo, H = ymax - ymin, ex = (x, y) => 1 + 2 * x / W + 3 * (y - ymin) / H;
  const r = solveSteady(mesh, { props: { ribbon: { k: 1 }, contact: { k: 1 }, wall: { k: 1 } }, bcs: { '*': { type: 'dirichlet', T: ex } }, tol: 1e-13 });
  let e = 0; mesh.nodes.forEach(([x, y], i) => { e = Math.max(e, Math.abs(r.T[i] - ex(x, y))); });
  return { maxErr: e / 6, iterations: r.it };
}
export function verifySlab({ Lh, k, rho, cp, h, Tinf, T0, tEnd, steps = 200, n = 10, type = 'structured', theta = 0.5 }) {
  const geo = slabSection({ Lh }), mesh = buildMesh(geo, { type, hRibbon: Lh / n, hChannel: Lh / n, hMax: Lh / n, growth: 1.2, maxAspect: 1.5 });
  const r = solveTransient(mesh, { props: { ribbon: { k, rho, cp } }, bcs: { outer: { type: 'robin', h, Tinf } }, T0, dt: tEnd / steps, steps, theta });
  const tol = Lh * 1e-6, avg = (yy) => { let s = 0, c = 0; mesh.nodes.forEach(([, y], i) => { if (Math.abs(y - yy) < tol) { s += r.T[i]; c++; } }); return s / c; };
  const Tc = avg(0), Ts = avg(Lh), Ac = slabAnalytic({ Lh, k, rho, cp, h, Tinf, T0, t: tEnd, x: 0 }), As = slabAnalytic({ Lh, k, rho, cp, h, Tinf, T0, t: tEnd, x: Lh }), span = Math.abs(Tinf - T0) || 1;
  return { Tc, Ts, TcAnalytic: Ac, TsAnalytic: As, errC: Math.abs(Tc - Ac) / span, errS: Math.abs(Ts - As) / span, nNodes: mesh.nNodes, residual: r.residual, Bi: h * Lh / k, Fo: k / (rho * cp) * tEnd / Lh / Lh };
}

// ---------------- Mesh sensitivity, GCI and selection ----------------
export function meshStudy(geo, { type = 'structured', sizes, levels = 4, ratio = Math.SQRT2, base = 1, functional, ref = 0, Fs = 1.25, pFormal = 2, onLevel } = {}) {
  const out = [];
  for (let k = 0; k < levels; k++) {
    const f = base * ratio ** k, t0 = Date.now(), mesh = buildMesh(geo, type === 'delaunay' ? { type, ...scaleSizes(sizes, f) } : { type, ...sizes, refine: f }), q = meshQuality(mesh);
    const value = functional(mesh); out.push({ level: k + 1, f, mesh, quality: q, nElem: q.nElem, nNode: q.nNode, h: q.hRep, value, ms: Date.now() - t0 });
    onLevel?.(k, levels);
  }
  const L = out.length, fin = (i) => out[L - 1 - i];
  // Observed order outside (0.5, p_formal + 1) or oscillatory convergence: Roache's conservative fallback — formal order,
  // F_s = 3, no extrapolation (the finest value is the best estimate)
  const triple = (a, b, c) => {
    const f1 = a.value - ref, f2 = b.value - ref, f3 = c.value - ref;
    if (Math.abs(f1 - f2) <= 1e-12 * Math.abs(f1) && Math.abs(f2 - f3) <= 1e-12 * Math.abs(f1)) return { p: NaN, fext: f1 + ref, gci21: 0, gci32: 0, asymptoticRatio: 1, inAsymptoticRange: true, exact: true, ea21: 0 };
    const g = gciFn(f1, f2, f3, a.h, b.h, c.h, Fs);
    if (!(g.p > 0.5 && g.p < pFormal + 1) || g.oscillatory || !Number.isFinite(g.fext)) {
      const r21 = b.h / a.h, r32 = c.h / b.h, ea21 = Math.abs((f1 - f2) / f1);
      return { ...g, pObs: g.p, p: pFormal, capped: true, fext: f1 + ref, gci21: 3 * ea21 / (r21 ** pFormal - 1), gci32: 3 * Math.abs((f2 - f3) / f2) / (r32 ** pFormal - 1), inAsymptoticRange: false };
    }
    return { ...g, fext: g.fext + ref };
  };
  const g = L >= 3 ? triple(fin(0), fin(1), fin(2)) : null, gC = L >= 4 ? triple(fin(1), fin(2), fin(3)) : null;
  const fext = g && Number.isFinite(g.fext) ? g.fext : fin(0).value;
  for (const l of out) l.errEst = g?.capped ? 3 * Math.abs(l.value - fext) / Math.max(1e-30, Math.abs(fext - ref)) + g.gci21 : Fs * Math.abs(l.value - fext) / Math.max(1e-30, Math.abs(fext - ref));
  const pConsistent = g && gC && Number.isFinite(g.p) && Number.isFinite(gC.p) ? Math.abs(g.p - gC.p) / Math.max(g.p, 1e-9) < 0.35 : null;
  // levels inside the asymptotic range: all when p agrees between the coarse and fine triplets, otherwise only the fine triplet
  const asymptoticFrom = g?.exact || g?.capped || pConsistent !== false ? 0 : Math.max(0, L - 3);
  return { levels: out, gci: g, gciCoarse: gC, fext, p: g?.p, pConsistent, asymptoticFrom, ref, Fs, type, ratio, base };
}
export function selectMesh(study, { gciTarget = 0.01, maxAngle = 135, minAngle = 0, maxAR = 30, maxElems = Infinity } = {}) {
  const rows = study.levels.map((l, i) => {
    const c = { asymptotic: i >= (study.asymptoticFrom ?? 0), error: l.errEst <= gciTarget, maxAngle: l.quality.maxAngle <= maxAngle, minAngle: l.quality.minAngle >= minAngle, aspect: l.quality.maxAR <= maxAR, valid: l.quality.inverted === 0, cost: l.nElem <= maxElems };
    return { level: l.level, nElem: l.nElem, h: l.h, value: l.value, errEst: l.errEst, checks: c, ok: Object.values(c).every(Boolean) };
  });
  const okRows = rows.filter(r => r.ok).sort((a, b) => a.nElem - b.nElem);
  const chosen = okRows[0] || rows[rows.length - 1], idx = rows.indexOf(chosen);
  const failed = Object.entries(chosen.checks).filter(([, v]) => !v).map(([k]) => k);
  return { rows, index: idx, level: study.levels[idx], ok: chosen.ok, reason: chosen.ok ? `Level ${chosen.level} is the cheapest mesh (${chosen.nElem} elements) meeting every criterion: ${study.gci?.capped ? 'conservative error (formal order, F_s = 3; asymptotic range not demonstrable)' : 'inside the asymptotic range'}, estimated discretisation error ${(chosen.errEst * 100).toFixed(3)} % ≤ ${(gciTarget * 100).toFixed(3)} %, max angle ≤ ${maxAngle}°, aspect ratio ≤ ${maxAR}, no inverted elements, ≤ ${maxElems} elements.` : `No level meets all criteria; the finest level is used and flagged (failed: ${failed.join(', ')}).`, criteria: { gciTarget, maxAngle, minAngle, maxAR, maxElems } };
}

// ---------------- Exporters ----------------
const TAG_ORDER = ['channel-top', 'channel-bottom', 'outer', 'sym', 'side', 'other'];
export function toMSH(mesh) {
  const tags = TAG_ORDER.filter(t => mesh.bnd[t]?.length), regs = REGION_NAMES.filter((r, i) => mesh.region.some(v => v === i));
  const phys = [...tags.map((t, i) => [1, i + 1, t]), ...regs.map((r, i) => [2, 100 + i + 1, r])];
  const L = ['$MeshFormat', '2.2 0 8', '$EndMeshFormat', '$PhysicalNames', String(phys.length), ...phys.map(([d, id, n]) => `${d} ${id} "${n}"`), '$EndPhysicalNames', '$Nodes', String(mesh.nNodes)];
  mesh.nodes.forEach(([x, y], i) => L.push(`${i + 1} ${x.toExponential(9)} ${y.toExponential(9)} 0`));
  const els = []; let id = 1;
  tags.forEach((t, i) => { for (const [a, b] of mesh.bnd[t]) els.push(`${id++} 1 2 ${i + 1} ${i + 1} ${a + 1} ${b + 1}`); });
  mesh.tris.forEach((t, e) => { const r = REGION_NAMES[mesh.region[e]], pid = 100 + regs.indexOf(r) + 1; els.push(`${id++} 2 2 ${pid} ${pid} ${t[0] + 1} ${t[1] + 1} ${t[2] + 1}`); });
  L.push('$EndNodes', '$Elements', String(els.length), ...els, '$EndElements');
  return L.join('\n') + '\n';
}
export function toVTK(mesh, { point = {}, cell = {} } = {}) {
  const n = mesh.nNodes, m = mesh.nElems, L = ['# vtk DataFile Version 3.0', 'THERMA-X100 meshlab cross-section (units m)', 'ASCII', 'DATASET UNSTRUCTURED_GRID', `POINTS ${n} double`];
  for (const [x, y] of mesh.nodes) L.push(`${x.toExponential(9)} ${y.toExponential(9)} 0`);
  L.push(`CELLS ${m} ${4 * m}`); for (const t of mesh.tris) L.push(`3 ${t[0]} ${t[1]} ${t[2]}`);
  L.push(`CELL_TYPES ${m}`); for (let e = 0; e < m; e++) L.push('5');
  L.push(`CELL_DATA ${m}`, 'SCALARS region int 1', 'LOOKUP_TABLE default', ...Array.from(mesh.region, String));
  for (const [k, v] of Object.entries(cell)) L.push(`SCALARS ${k.replace(/\W+/g, '_')} double 1`, 'LOOKUP_TABLE default', ...Array.from(v, x => (+x).toPrecision(8)));
  const pk = Object.entries(point); if (pk.length) { L.push(`POINT_DATA ${n}`); for (const [k, v] of pk) L.push(`SCALARS ${k.replace(/\W+/g, '_')} double 1`, 'LOOKUP_TABLE default', ...Array.from(v, x => (+x).toPrecision(8))); }
  return L.join('\n') + '\n';
}
export function toCSV(mesh, { point = {} } = {}) {
  const pk = Object.keys(point);
  const nodes = ['id,x_m,y_m' + pk.map(k => ',' + k).join(''), ...mesh.nodes.map(([x, y], i) => `${i + 1},${x.toExponential(9)},${y.toExponential(9)}` + pk.map(k => ',' + (+point[k][i]).toPrecision(8)).join(''))].join('\n') + '\n';
  const elements = ['id,n1,n2,n3,region', ...mesh.tris.map((t, e) => `${e + 1},${t[0] + 1},${t[1] + 1},${t[2] + 1},${REGION_NAMES[mesh.region[e]]}`)].join('\n') + '\n';
  const boundary = ['n1,n2,tag', ...Object.entries(mesh.bnd).flatMap(([tag, l]) => l.map(([a, b]) => `${a + 1},${b + 1},${tag}`))].join('\n') + '\n';
  return { nodes, elements, boundary };
}

// ---------------- Field sampling & drawing ----------------
export function sampleGrid(mesh, values, nx = 120, ny = 60, box) {
  const { nodes, tris } = mesh, g = mesh.geo, b = box || { x0: 0, x1: g.W, y0: g.ymin, y1: g.ymax };
  const xs = range(nx).map(i => b.x0 + (b.x1 - b.x0) * i / (nx - 1)), ys = range(ny).map(j => b.y0 + (b.y1 - b.y0) * j / (ny - 1));
  const NB = Math.max(4, Math.round(Math.sqrt(tris.length) / 2)), bx = (b.x1 - b.x0) / NB || 1, by = (b.y1 - b.y0) / NB || 1, buckets = Array.from({ length: NB * NB }, () => []);
  tris.forEach((t, e) => { const X = t.map(k => nodes[k][0]), Y = t.map(k => nodes[k][1]); const i0 = clamp(Math.floor((Math.min(...X) - b.x0) / bx), 0, NB - 1), i1 = clamp(Math.floor((Math.max(...X) - b.x0) / bx), 0, NB - 1), j0 = clamp(Math.floor((Math.min(...Y) - b.y0) / by), 0, NB - 1), j1 = clamp(Math.floor((Math.max(...Y) - b.y0) / by), 0, NB - 1); for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * NB + i].push(e); });
  const z = ys.map(y => xs.map(x => {
    const list = buckets[clamp(Math.floor((y - b.y0) / by), 0, NB - 1) * NB + clamp(Math.floor((x - b.x0) / bx), 0, NB - 1)];
    for (const e of list) { const [p, q, r] = tris[e].map(k => nodes[k]), d = (q[1] - r[1]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[1] - r[1]); const l1 = ((q[1] - r[1]) * (x - r[0]) + (r[0] - q[0]) * (y - r[1])) / d, l2 = ((r[1] - p[1]) * (x - r[0]) + (p[0] - r[0]) * (y - r[1])) / d, l3 = 1 - l1 - l2, eps = -1e-9; if (l1 >= eps && l2 >= eps && l3 >= eps) return l1 * values[tris[e][0]] + l2 * values[tris[e][1]] + l3 * values[tris[e][2]]; }
    return NaN;
  }));
  return { xs, ys, z };
}
export function paintField(g, mesh, values, { x = 0, y = 0, w, h, lo, hi, color, edges = false, mirror = false }) {
  const G = mesh.geo, H = (G.ymax - G.ymin) * (mirror ? 2 : 1), s = Math.min(w / G.W, h / H), ox = x + (w - G.W * s) / 2, oy = y + (h + H * s) / 2;
  lo ??= Math.min(...values); hi ??= Math.max(...values); const span = (hi - lo) || 1;
  const sx = (px) => ox + px * s, sy = (py) => oy - (py - (mirror ? -G.ymax : G.ymin)) * s;
  for (const sign of mirror ? [1, -1] : [1]) mesh.tris.forEach((t) => {
    const v = (values[t[0]] + values[t[1]] + values[t[2]]) / 3; g.fillStyle = color(clamp((v - lo) / span, 0, 1)); g.beginPath();
    t.forEach((k, j) => { const px = sx(mesh.nodes[k][0]), py = sy(sign * mesh.nodes[k][1]); j ? g.lineTo(px, py) : g.moveTo(px, py); }); g.closePath(); g.fill();
    if (edges) { g.strokeStyle = 'rgba(255,255,255,0.15)'; g.lineWidth = 0.5; g.stroke(); } else { g.strokeStyle = g.fillStyle; g.lineWidth = 0.6; g.stroke(); }
  });
  return { sx, sy, s, ox, oy, W: G.W * s, H: H * s };
}
export function meshSVG(mesh, { width = 820, colors = { ribbon: '#c58b4b', contact: '#7c9cbf', wall: '#7b8794' }, stroke = '#0f172a', mm = true } = {}) {
  const G = mesh.geo, H = G.ymax - G.ymin, s = (width - 20) / G.W, hh = H * s + 20, X = (x) => (10 + x * s).toFixed(2), Y = (y) => (10 + (G.ymax - y) * s).toFixed(2);
  const polys = mesh.tris.map((t, e) => `<polygon points="${t.map(k => X(mesh.nodes[k][0]) + ',' + Y(mesh.nodes[k][1])).join(' ')}" fill="${colors[REGION_NAMES[mesh.region[e]]]}" stroke="${stroke}" stroke-width="0.35"/>`).join('');
  const bl = Object.entries(mesh.bnd).filter(([t]) => t.startsWith('channel')).flatMap(([, l]) => l).map(([a, b]) => `<line x1="${X(mesh.nodes[a][0])}" y1="${Y(mesh.nodes[a][1])}" x2="${X(mesh.nodes[b][0])}" y2="${Y(mesh.nodes[b][1])}" stroke="#38bdf8" stroke-width="1.6"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${hh.toFixed(1)}" width="100%" style="max-height:640px">${polys}${bl}<text x="12" y="${(hh - 4).toFixed(1)}" font-size="11" fill="#94a3b8">${mesh.kind} mesh · ${mesh.nElems} elements · ${mesh.nNodes} nodes · width ${(G.W * (mm ? 1e3 : 1)).toFixed(3)} ${mm ? 'mm' : 'm'}</text></svg>`;
}
