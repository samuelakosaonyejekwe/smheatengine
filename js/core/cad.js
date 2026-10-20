// Parametric CAD kernel (procedural B-rep-like surface patches tessellated to watertight triangle shells),
// airfoil parameterisations, dimensioned 2D drawings and neutral-format exporters.
import { linspace, rad, deg, range } from './num.js';

// ---------------- Airfoils ----------------
export function naca4(code = '0018', n = 81, closedTE = true) {
  const m = +code[0] / 100, p = +code[1] / 10, t = +code.slice(2) / 100;
  const beta = linspace(0, Math.PI, n), xs = beta.map(b => 0.5 * (1 - Math.cos(b)));
  const a4 = closedTE ? -0.1036 : -0.1015;
  const pt = (x) => {
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 + a4 * x ** 4);
    let yc = 0, dy = 0; if (m && p) { if (x < p) { yc = m / p ** 2 * (2 * p * x - x * x); dy = 2 * m / p ** 2 * (p - x); } else { yc = m / (1 - p) ** 2 * (1 - 2 * p + 2 * p * x - x * x); dy = 2 * m / (1 - p) ** 2 * (p - x); } }
    const th = Math.atan(dy); return { xu: x - yt * Math.sin(th), yu: yc + yt * Math.cos(th), xl: x + yt * Math.sin(th), yl: yc - yt * Math.cos(th), yc };
  };
  const P = xs.map(pt);
  const upper = P.map(q => [q.xu, q.yu]).reverse(), lower = P.map(q => [q.xl, q.yl]).slice(1);
  return { name: 'NACA ' + code, points: upper.concat(lower), camber: P.map((q, i) => [xs[i], q.yc]), t, m, p }; // TE(upper) → LE → TE(lower)
}
// Kulfan Class–Shape Transformation airfoil; Au, Al Bernstein weights
export function cst(Au = [0.17, 0.16, 0.15, 0.14], Al = [-0.17, -0.12, -0.1, -0.08], n = 81, dzTE = 0) {
  const bern = (k, N, x) => binom(N, k) * x ** k * (1 - x) ** (N - k);
  const S = (A, x) => A.reduce((s, a, k) => s + a * bern(k, A.length - 1, x), 0);
  const xs = linspace(0, Math.PI, n).map(b => 0.5 * (1 - Math.cos(b))), C = (x) => Math.sqrt(x) * (1 - x);
  const up = xs.map(x => [x, C(x) * S(Au, x) + x * dzTE / 2]).reverse(), lo = xs.map(x => [x, C(x) * S(Al, x) - x * dzTE / 2]).slice(1);
  return { name: 'CST', points: up.concat(lo) };
}
const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
export function airfoilStats(pts) {
  let area = 0, tmax = 0, xt = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const le = pts.reduce((bi, p, i) => p[0] < pts[bi][0] ? i : bi, 0), up = pts.slice(0, le + 1), lo = pts.slice(le);
  for (const x of linspace(0.01, 0.99, 99)) { const yu = interpPoly(up, x), yl = interpPoly(lo, x); if (yu - yl > tmax) { tmax = yu - yl; xt = x; } }
  return { area: Math.abs(area) / 2, tmax, xt };
}
function interpPoly(seg, x) { for (let i = 0; i < seg.length - 1; i++) { const a = seg[i], b = seg[i + 1]; if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); } return 0; }

// ---------------- Mesh primitives (all closed, outward normals) ----------------
export class Mesh {
  constructor(name, opts = {}) { this.name = name; this.p = []; this.i = []; Object.assign(this, { color: '#9aa4b2', group: 'misc', component: null, ...opts }); }
  v(x, y, z) { this.p.push(x, y, z); return this.p.length / 3 - 1; }
  t(a, b, c) { this.i.push(a, b, c); }
  q(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  get positions() { return Float32Array.from(this.p); } get indices() { return Uint32Array.from(this.i); }
  transform(fn) { for (let k = 0; k < this.p.length; k += 3) { const r = fn(this.p[k], this.p[k + 1], this.p[k + 2]); this.p[k] = r[0]; this.p[k + 1] = r[1]; this.p[k + 2] = r[2]; } return this; }
  translate(dx, dy, dz) { return this.transform((x, y, z) => [x + dx, y + dy, z + dz]); }
  rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return this.transform((x, y, z) => [c * x - s * y, s * x + c * y, z]); }
  rotX(a) { const c = Math.cos(a), s = Math.sin(a); return this.transform((x, y, z) => [x, c * y - s * z, s * y + c * z]); }
  rotY(a) { const c = Math.cos(a), s = Math.sin(a); return this.transform((x, y, z) => [c * x + s * z, y, -s * x + c * z]); }
  get triangleCount() { return this.i.length / 3; }
  bbox() { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (let k = 0; k < this.p.length; k += 3) for (let d = 0; d < 3; d++) { b[d] = Math.min(b[d], this.p[k + d]); b[d + 3] = Math.max(b[d + 3], this.p[k + d]); } return b; }
  volume() { let V = 0; const P = this.p; for (let k = 0; k < this.i.length; k += 3) { const a = this.i[k] * 3, b = this.i[k + 1] * 3, c = this.i[k + 2] * 3; V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6; } return V; }
  area() { let A = 0; const P = this.p; for (let k = 0; k < this.i.length; k += 3) { const a = this.i[k] * 3, b = this.i[k + 1] * 3, c = this.i[k + 2] * 3; const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]; A += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); } return A; }
  centroid() { let V = 0, cx = 0, cy = 0, cz = 0; const P = this.p; for (let k = 0; k < this.i.length; k += 3) { const a = this.i[k] * 3, b = this.i[k + 1] * 3, c = this.i[k + 2] * 3; const v = (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6; V += v; cx += v * (P[a] + P[b] + P[c]) / 4; cy += v * (P[a + 1] + P[b + 1] + P[c + 1]) / 4; cz += v * (P[a + 2] + P[b + 2] + P[c + 2]) / 4; } return V ? [cx / V, cy / V, cz / V] : [0, 0, 0]; }
  // Manifold check: every edge shared by exactly two triangles with opposite orientation
  checkManifold() { const E = new Map(); for (let k = 0; k < this.i.length; k += 3) for (let e = 0; e < 3; e++) { const a = this.i[k + e], b = this.i[k + (e + 1) % 3]; const key = a < b ? a + '_' + b : b + '_' + a; const s = E.get(key) || { n: 0, dir: 0 }; s.n++; s.dir += a < b ? 1 : -1; E.set(key, s); } let open = 0, nonman = 0, flipped = 0; for (const s of E.values()) { if (s.n === 1) open++; else if (s.n > 2) nonman++; else if (s.dir !== 0) flipped++; } return { edges: E.size, open, nonManifold: nonman, inconsistent: flipped, closed: open === 0 && nonman === 0, oriented: flipped === 0 }; }
}

// Loft through a list of closed sections (each an array of [x,y,z]) with end caps
export function loft(name, sections, opts) {
  const m = new Mesh(name, opts), ns = sections.length, np = sections[0].length;
  const idx = sections.map(sec => sec.map(([x, y, z]) => m.v(x, y, z)));
  for (let s = 0; s < ns - 1; s++) for (let k = 0; k < np; k++) { const k1 = (k + 1) % np; m.q(idx[s][k], idx[s][k1], idx[s + 1][k1], idx[s + 1][k]); }
  const cap = (sec, rev) => { const c = sec.reduce((a, p) => [a[0] + p[0] / np, a[1] + p[1] / np, a[2] + p[2] / np], [0, 0, 0]); const ci = m.v(...c); const ids = rev ? idx[sec === sections[0] ? 0 : ns - 1] : idx[sec === sections[0] ? 0 : ns - 1]; for (let k = 0; k < np; k++) rev ? m.t(ci, ids[(k + 1) % np], ids[k]) : m.t(ci, ids[k], ids[(k + 1) % np]); };
  cap(sections[0], true); cap(sections[ns - 1], false);
  fixOrientation(m); return m;
}
// Ensure outward orientation using signed volume
export function fixOrientation(m) { if (m.volume() < 0) for (let k = 0; k < m.i.length; k += 3) { const t = m.i[k + 1]; m.i[k + 1] = m.i[k + 2]; m.i[k + 2] = t; } return m; }
export function box(name, lx, ly, lz, opts) { const s = (z) => [[-lx / 2, -ly / 2, z], [lx / 2, -ly / 2, z], [lx / 2, ly / 2, z], [-lx / 2, ly / 2, z]]; return loft(name, [s(-lz / 2), s(lz / 2)], opts); }
export function cylinder(name, r, len, n = 40, opts) { const s = (z) => range(n).map(k => [r * Math.cos(2 * Math.PI * k / n), r * Math.sin(2 * Math.PI * k / n), z]); return loft(name, [s(-len / 2), s(len / 2)], opts); }
export function tube(name, ro, ri, len, n = 48, opts) { // annulus extruded along z
  const m = new Mesh(name, opts); const ring = (r, z) => range(n).map(k => m.v(r * Math.cos(2 * Math.PI * k / n), r * Math.sin(2 * Math.PI * k / n), z));
  const o0 = ring(ro, -len / 2), o1 = ring(ro, len / 2), i0 = ring(ri, -len / 2), i1 = ring(ri, len / 2);
  for (let k = 0; k < n; k++) { const k1 = (k + 1) % n; m.q(o0[k], o0[k1], o1[k1], o1[k]); m.q(i0[k1], i0[k], i1[k], i1[k1]); m.q(o1[k], o1[k1], i1[k1], i1[k]); m.q(i0[k], i0[k1], o0[k1], o0[k]); }
  return fixOrientation(m);
}
export function torus(name, R, r, nu = 48, nv = 20, opts) {
  const m = new Mesh(name, opts), id = [];
  for (let i = 0; i < nu; i++) { id.push([]); const u = 2 * Math.PI * i / nu; for (let j = 0; j < nv; j++) { const v = 2 * Math.PI * j / nv; id[i].push(m.v((R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v))); } }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) m.q(id[i][j], id[(i + 1) % nu][j], id[(i + 1) % nu][(j + 1) % nv], id[i][(j + 1) % nv]);
  return fixOrientation(m);
}
export function sphere(name, r, nu = 32, nv = 16, opts) { const secs = []; for (let j = 1; j < nv; j++) { const ph = Math.PI * j / nv; secs.push(range(nu).map(i => [r * Math.sin(ph) * Math.cos(2 * Math.PI * i / nu), r * Math.sin(ph) * Math.sin(2 * Math.PI * i / nu), -r * Math.cos(ph)])); } return loft(name, secs, opts); }
// Superellipse closed section in the y–z plane at station x
const superEllipse = (x, a, b, cz, n = 2.5, np = 40) => range(np).map(k => { const t = 2 * Math.PI * k / np, c = Math.cos(t), s = Math.sin(t); return [x, a * Math.sign(c) * Math.abs(c) ** (2 / n), cz + b * Math.sign(s) * Math.abs(s) ** (2 / n)]; });

// Wing built from airfoil sections along its span (vertical, +z), with linear chord taper and twist (deg) distribution
export function wing(name, { airfoil = naca4('0018', 61), span = 3, rootChord = 1.6, tipChord = 0.9, twistTip = -4, sweepLE = 0, nSpan = 14, twistFn, cambDelta, opts, tipRound = true } = {}) {
  const sections = [];
  const sec = (eta, c, z, thick = 1) => { const tw = rad(twistFn ? twistFn(Math.min(1, eta)) : twistTip * Math.min(1, eta)), xle = Math.tan(rad(sweepLE)) * Math.min(z, span), cq = rootChord + (tipChord - rootChord) * Math.min(1, eta); return airfoil.points.map(([x, y]) => { const yy = (y + (cambDelta ? cambDelta(Math.min(1, eta), x) : 0)) * thick; const xc = (x - 0.25) * c, yc = yy * c; return [xle + 0.25 * cq + xc * Math.cos(tw) - yc * Math.sin(tw), xc * Math.sin(tw) + yc * Math.cos(tw), z]; }); };
  for (let s = 0; s <= nSpan; s++) { const eta = s / nSpan; sections.push(sec(eta, rootChord + (tipChord - rootChord) * eta, eta * span)); }
  // rounded (half-elliptic) tip cap: reduces tip-vortex strength and gives a clean finished look
  if (tipRound) for (const f of [0.35, 0.6, 0.8, 0.93]) { const k = Math.sqrt(1 - f * f); sections.push(sec(1, tipChord * (0.25 + 0.75 * k), span + f * 0.09 * tipChord, Math.max(0.15, k))); }
  // drop duplicated closing point if present
  return loft(name, sections, opts);
}

// ---------------- Part colours by material family ----------------
export const PART_COLORS = { Composite: '#2b2f36', Metal: '#b8c0cc', SMA: '#c58b4b', Polymer: '#5a7fa8', Elastomer: '#1b1b1b', Coating: '#1e293b', Ceramic: '#d6d3d1', Thermal: '#a3a3a3', Core: '#e2c275', Friction: '#7c5c3c', 'Polymer actuator': '#a16207' };

// ---------------- Exporters ----------------
function merged(parts) { const out = []; for (const m of parts) { const P = m.p; for (let k = 0; k < m.i.length; k++) out.push(P[m.i[k] * 3], P[m.i[k] * 3 + 1], P[m.i[k] * 3 + 2]); } return Float32Array.from(out); }
export function toSTL(parts, name = 'therma') {
  const tri = merged(parts), n = tri.length / 9, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  const hdr = `THERMA-X100 ${name} units=m`.slice(0, 79); for (let i = 0; i < hdr.length; i++) dv.setUint8(i, hdr.charCodeAt(i));
  dv.setUint32(80, n, true);
  for (let t = 0; t < n; t++) { const o = 84 + t * 50, a = t * 9; const ux = tri[a + 3] - tri[a], uy = tri[a + 4] - tri[a + 1], uz = tri[a + 5] - tri[a + 2], vx = tri[a + 6] - tri[a], vy = tri[a + 7] - tri[a + 1], vz = tri[a + 8] - tri[a + 2]; let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true); for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, tri[a + k], true); }
  return new Blob([buf], { type: 'model/stl' });
}
export function toOBJ(parts) { let s = '# THERMA-X100 OBJ export (units: m)\n', off = 1; for (const m of parts) { s += `o ${m.name.replace(/\s+/g, '_')}\n`; for (let k = 0; k < m.p.length; k += 3) s += `v ${m.p[k].toFixed(6)} ${m.p[k + 1].toFixed(6)} ${m.p[k + 2].toFixed(6)}\n`; for (let k = 0; k < m.i.length; k += 3) s += `f ${m.i[k] + off} ${m.i[k + 1] + off} ${m.i[k + 2] + off}\n`; off += m.p.length / 3; } return s; }
export function toPLY(parts) { const V = [], F = []; let off = 0; for (const m of parts) { for (let k = 0; k < m.p.length; k += 3) V.push(`${m.p[k]} ${m.p[k + 1]} ${m.p[k + 2]}`); for (let k = 0; k < m.i.length; k += 3) F.push(`3 ${m.i[k] + off} ${m.i[k + 1] + off} ${m.i[k + 2] + off}`); off += m.p.length / 3; } return `ply\nformat ascii 1.0\ncomment THERMA-X100 units m\nelement vertex ${V.length}\nproperty float x\nproperty float y\nproperty float z\nelement face ${F.length}\nproperty list uchar int vertex_indices\nend_header\n${V.join('\n')}\n${F.join('\n')}\n`; }
export function toVTKPoly(parts, field) { const V = [], F = []; let off = 0; for (const m of parts) { for (let k = 0; k < m.p.length; k += 3) V.push(`${m.p[k]} ${m.p[k + 1]} ${m.p[k + 2]}`); for (let k = 0; k < m.i.length; k += 3) F.push(`3 ${m.i[k] + off} ${m.i[k + 1] + off} ${m.i[k + 2] + off}`); off += m.p.length / 3; } let s = `# vtk DataFile Version 3.0\nTHERMA-X100\nASCII\nDATASET POLYDATA\nPOINTS ${V.length} float\n${V.join('\n')}\nPOLYGONS ${F.length} ${F.length * 4}\n${F.join('\n')}\n`; if (field) s += `POINT_DATA ${V.length}\nSCALARS ${field.name} float 1\nLOOKUP_TABLE default\n${field.values.join('\n')}\n`; return s; }
// STEP AP214 faceted B-rep (closed shells). Exact NURBS surfaces are not preserved — reported in conversion report.
export function toSTEP(parts, name = 'THERMAX100') {
  let id = 0; const L = []; const e = (s) => { L.push(`#${++id}=${s};`); return id; };
  const now = new Date().toISOString().slice(0, 19);
  const ctx = e("(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#" + (id + 2) + ")) GLOBAL_UNIT_ASSIGNED_CONTEXT((#" + (id + 3) + ",#" + (id + 4) + ",#" + (id + 5) + ")) REPRESENTATION_CONTEXT('3D',''))");
  e("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#" + (id + 2) + ",'distance_accuracy_value','')");
  e("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.))"); e("(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))"); e("(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())");
  const appc = e("APPLICATION_CONTEXT('automotive design')"); e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appc})`);
  const solids = [];
  for (const m of parts) {
    const pts = []; for (let k = 0; k < m.p.length; k += 3) pts.push(e(`CARTESIAN_POINT('',(${m.p[k].toExponential(6)},${m.p[k + 1].toExponential(6)},${m.p[k + 2].toExponential(6)}))`));
    const faces = []; for (let k = 0; k < m.i.length; k += 3) { const loop = e(`POLY_LOOP('',(#${pts[m.i[k]]},#${pts[m.i[k + 1]]},#${pts[m.i[k + 2]]}))`); const bnd = e(`FACE_OUTER_BOUND('',#${loop},.T.)`); faces.push(e(`FACE('',(#${bnd}))`)); }
    const shell = e(`CLOSED_SHELL('${m.name.replace(/'/g, '')}',(${faces.map(f => '#' + f).join(',')}))`); solids.push(e(`FACETED_BREP('${m.name.replace(/'/g, '')}',#${shell})`));
  }
  const pc = e(`PRODUCT_CONTEXT('',#${appc},'mechanical')`), prod = e(`PRODUCT('${name}','${name}','THERMA-X100 generated assembly',(#${pc}))`);
  const pdf = e(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`), pdc = e(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appc},'design')`), pd = e(`PRODUCT_DEFINITION('design','',#${pdf},#${pdc})`), pds = e(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  const rep = e(`FACETED_BREP_SHAPE_REPRESENTATION('',(${solids.map(s => '#' + s).join(',')}),#${ctx})`); e(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('THERMA-X100 faceted B-rep export'),'2;1');\nFILE_NAME('${name}.step','${now}',(''),(''),'THERMA-X100','THERMA-X100','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n${L.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}
export function conversionReport(fmtName, parts) {
  const checks = parts.map(m => ({ name: m.name, tri: m.triangleCount, ...m.checkManifold(), volume: m.volume() }));
  const lost = { STL: ['part names', 'assembly structure', 'materials', 'exact curvature', 'units (header note only)'], OBJ: ['materials', 'exact curvature', 'units'], PLY: ['part names', 'materials', 'exact curvature'], STEP: ['exact NURBS curvature (faceted B-rep)', 'parametric feature tree (kept in native .therma.json)'], glTF: ['exact curvature', 'parametric feature tree'], DXF: ['3D surfaces (2D projection only)'], VTK: ['part names', 'materials'] }[fmtName] || [];
  return { format: fmtName, parts: checks.length, triangles: checks.reduce((s, c) => s + c.tri, 0), allClosed: checks.every(c => c.closed), allOriented: checks.every(c => c.oriented), checks, preserved: ['geometry (tessellated, 1 µm precision)', 'outward normals', 'SI metre units'], lost };
}

// ---------------- 2D engineering drawings (third-angle orthographic, SVG + DXF) ----------------
// Silhouette projection: draws all triangle edges whose adjacent faces flip visibility (feature/silhouette lines)
function projectEdges(parts, view) {
  const proj = { top: (x, y, z) => [x, y], side: (x, y, z) => [x, z], front: (x, y, z) => [y, z] }[view];
  const dir = { top: [0, 0, 1], side: [0, -1, 0], front: [1, 0, 0] }[view]; const segs = [];
  for (const m of parts) {
    const P = m.p, E = new Map(), fn = [];
    for (let k = 0; k < m.i.length; k += 3) { const a = m.i[k] * 3, b = m.i[k + 1] * 3, c = m.i[k + 2] * 3; const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]; const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(...n) || 1; fn.push(n.map(v => v / l)); }
    for (let k = 0; k < m.i.length; k += 3) for (let e2 = 0; e2 < 3; e2++) { const a = m.i[k + e2], b = m.i[k + (e2 + 1) % 3], key = a < b ? a + '_' + b : b + '_' + a; const f = k / 3; if (!E.has(key)) E.set(key, [a, b, f, -1]); else E.get(key)[3] = f; }
    for (const [a, b, f1, f2] of E.values()) {
      const n1 = fn[f1], n2 = f2 >= 0 ? fn[f2] : null; const d1 = n1[0] * dir[0] + n1[1] * dir[1] + n1[2] * dir[2], d2 = n2 ? n2[0] * dir[0] + n2[1] * dir[1] + n2[2] * dir[2] : -d1;
      const crease = n2 ? (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) < 0.82 : true;
      if (d1 * d2 <= 0 || crease) segs.push([...proj(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]), ...proj(P[b * 3], P[b * 3 + 1], P[b * 3 + 2])]);
    }
  }
  return segs;
}
export function engineeringDrawing(parts, { title = 'THERMA-X100 — General Arrangement', dwgNo = 'AXP-GA-001', rev = 'A', scale = '1:20', dims = [], material = '', author = '' } = {}) {
  const views = ['side', 'top', 'front'].map(v => ({ v, segs: projectEdges(parts, v) }));
  const bb = (segs) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const s of segs) { x0 = Math.min(x0, s[0], s[2]); x1 = Math.max(x1, s[0], s[2]); y0 = Math.min(y0, s[1], s[3]); y1 = Math.max(y1, s[1], s[3]); } return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }; };
  views.forEach(v => v.bb = bb(v.segs));
  const W = 1189, H = 841, margin = 20, tb = 60; // A0-proportioned sheet in mm units
  const sMax = Math.min((W - 3 * margin - 140) / (views[0].bb.w + views[2].bb.w), (H - 3 * margin - tb - 60) / (views[0].bb.h + views[1].bb.h));
  const k = sMax * 0.9;
  // third-angle: top view above side view, front view to the right of side view
  const place = { side: [margin + 40, H - tb - margin - 40], top: [margin + 40, H - tb - margin - 80 - views[0].bb.h * k], front: [margin + 120 + views[0].bb.w * k, H - tb - margin - 40] };
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Arial, Helvetica, sans-serif"><rect width="${W}" height="${H}" fill="#fff"/><rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="none" stroke="#000" stroke-width="1.4"/>`;
  const dxf = []; const dxfLine = (x1, y1, x2, y2, layer) => dxf.push(`0\nLINE\n8\n${layer}\n10\n${x1.toFixed(3)}\n20\n${y1.toFixed(3)}\n11\n${x2.toFixed(3)}\n21\n${y2.toFixed(3)}`);
  const dxfText = (x, y, ht, t, layer = 'TEXT') => dxf.push(`0\nTEXT\n8\n${layer}\n10\n${x.toFixed(3)}\n20\n${y.toFixed(3)}\n40\n${ht}\n1\n${t}`);
  const toSheet = {};
  for (const v of views) {
    const [ox, oy] = place[v.v], b = v.bb, X = (x) => ox + (x - b.x0) * k, Y = (y) => oy - (y - b.y0) * k; toSheet[v.v] = { X, Y, b };
    svg += `<g stroke="#111" stroke-width="0.5" fill="none">` + v.segs.map(s => `<line x1="${X(s[0]).toFixed(2)}" y1="${Y(s[1]).toFixed(2)}" x2="${X(s[2]).toFixed(2)}" y2="${Y(s[3]).toFixed(2)}"/>`).join('') + '</g>';
    for (const s of v.segs) dxfLine(s[0] * 1000, s[1] * 1000 + (v.v === 'top' ? 4000 : 0), s[2] * 1000, s[3] * 1000 + (v.v === 'top' ? 4000 : 0), v.v.toUpperCase());
    svg += `<text x="${X((b.x0 + b.x1) / 2)}" y="${Y(b.y0) + 26}" font-size="12" text-anchor="middle" font-weight="700">${v.v.toUpperCase()} VIEW</text>`;
    // overall dimensions
    const dim = (x1, y1, x2, y2, label, off, vertical) => { const ext = vertical ? `M${x1},${y1}h${off}M${x2},${y2}h${off}` : `M${x1},${y1}v${off}M${x2},${y2}v${off}`; const lx = vertical ? x1 + off * 0.8 : x1, ly = vertical ? y1 : y1 + off * 0.8, mx = vertical ? x2 + off * 0.8 : x2, my = vertical ? y2 : y2 + off * 0.8; svg += `<path d="${ext}" stroke="#2563eb" stroke-width="0.35"/><line x1="${lx}" y1="${ly}" x2="${mx}" y2="${my}" stroke="#2563eb" stroke-width="0.5" marker-start="url(#ar)" marker-end="url(#ar)"/><text x="${(lx + mx) / 2 + (vertical ? 4 : 0)}" y="${(ly + my) / 2 - 3}" font-size="10" fill="#1d4ed8" text-anchor="${vertical ? 'start' : 'middle'}">${label}</text>`; };
    dim(X(b.x0), Y(b.y0), X(b.x1), Y(b.y0), (b.w * 1000).toFixed(0), 16, false);
    dim(X(b.x1), Y(b.y1), X(b.x1), Y(b.y0), (b.h * 1000).toFixed(0), 16, true);
  }
  for (const d of dims) { const t = toSheet[d.view]; if (!t) continue; const x1 = t.X(d.a[0]), y1 = t.Y(d.a[1]), x2 = t.X(d.b[0]), y2 = t.Y(d.b[1]); svg += `<line x1="${x1}" y1="${y1 + (d.off || -12)}" x2="${x2}" y2="${y2 + (d.off || -12)}" stroke="#16a34a" stroke-width="0.5" marker-start="url(#ar)" marker-end="url(#ar)"/><text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 + (d.off || -12) - 3}" font-size="10" fill="#15803d" text-anchor="middle">${d.label}</text>`; }
  svg = svg.replace('<rect width', '<defs><marker id="ar" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,1L10,5L0,9z" fill="#2563eb"/></marker></defs><rect width');
  // title block (ISO 7200 fields)
  const tx = W - 10 - 520, ty = H - 10 - tb;
  svg += `<g font-size="10"><rect x="${tx}" y="${ty}" width="520" height="${tb}" fill="none" stroke="#000"/><line x1="${tx}" y1="${ty + 20}" x2="${tx + 520}" y2="${ty + 20}" stroke="#000"/><line x1="${tx + 300}" y1="${ty}" x2="${tx + 300}" y2="${ty + tb}" stroke="#000"/><line x1="${tx + 410}" y1="${ty}" x2="${tx + 410}" y2="${ty + tb}" stroke="#000"/>
  <text x="${tx + 6}" y="${ty + 14}" font-weight="700" font-size="12">${title}</text><text x="${tx + 306}" y="${ty + 14}">DWG No. ${dwgNo}</text><text x="${tx + 416}" y="${ty + 14}">REV ${rev}</text>
  <text x="${tx + 6}" y="${ty + 34}" font-size="9">Units mm · 3rd-angle · Tol. ISO 2768-mK</text><text x="${tx + 6}" y="${ty + 50}">Material: ${material || 'see BOM / materials register'}</text>
  <text x="${tx + 306}" y="${ty + 34}">Scale ${scale}</text><text x="${tx + 306}" y="${ty + 50}">Date ${new Date().toISOString().slice(0, 10)}</text><text x="${tx + 416}" y="${ty + 34}">Drawn: ${author || '—'}</text><text x="${tx + 416}" y="${ty + 50}">Sheet 1/1</text></g>`;
  // third-angle symbol
  svg += `<g transform="translate(${tx - 70},${ty + 18})" stroke="#000" fill="none" stroke-width="0.8"><circle cx="40" cy="12" r="10"/><circle cx="40" cy="12" r="4"/><path d="M0,4L22,0V24L0,20Z"/></g></svg>`;
  dxfText(0, -600, 120, title); dxfText(0, -800, 80, `DWG ${dwgNo} REV ${rev} units mm`);
  const dxfStr = `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${dxf.join('\n')}\n0\nENDSEC\n0\nEOF\n`;
  return { svg, dxf: dxfStr };
}
export function airfoilDAT(af) { return af.name + '\n' + af.points.map(p => ` ${p[0].toFixed(6)}  ${p[1].toFixed(6)}`).join('\n') + '\n'; }
export function airfoilDXF(af, chord = 1) { const L = []; for (let k = 0; k < af.points.length - 1; k++) { const a = af.points[k], b = af.points[k + 1]; L.push(`0\nLINE\n8\nAIRFOIL\n10\n${(a[0] * chord * 1000).toFixed(3)}\n20\n${(a[1] * chord * 1000).toFixed(3)}\n11\n${(b[0] * chord * 1000).toFixed(3)}\n21\n${(b[1] * chord * 1000).toFixed(3)}`); } return `0\nSECTION\n2\nENTITIES\n${L.join('\n')}\n0\nENDSEC\n0\nEOF\n`; }
