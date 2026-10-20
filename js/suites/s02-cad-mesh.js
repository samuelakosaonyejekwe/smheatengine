// Suite 02 — 2-D/3-D parametric CAD and computational meshing.
// Generates the SMA ribbon, ribbon bundle, thermal-muscle cartridge (grips, carriage, bias spring, microchannel plate
// stack, housing, ports) and the radial rotary multicell engine (N cartridges around a rotor, hot/cold manifolds, shaft,
// casing) as closed triangulated solids; computes volumes, masses, rotor inertia and clearance/interference margins;
// produces dimensioned drawings and neutral exports; meshes the cartridge cross-section (structured graded and Delaunay),
// runs a systematic mesh-sensitivity study with Richardson extrapolation and the grid-convergence index and selects the mesh
// by explicit criteria.
import { Mesh, box, cylinder, tube, torus, loft, toSTL, toOBJ, toPLY, toSTEP, conversionReport, engineeringDrawing } from '../core/cad.js';
import * as ML from '../core/meshlab.js';
import { get as getMat, componentMaterial, smaAlloys } from '../core/materials.js';
import { fmt, histogram, range, sum, clamp } from '../core/num.js';
import { download, cmap, cssColor } from '../core/chart.js';
import { zip, parseMSH, parseVTK, parseSTL } from '../core/io.js';
import { anim2d, seriesPanel, theme, label, para, fs as fontPx } from '../core/anim2d.js';

const yieldTo = (ctx) => (typeof requestAnimationFrame === 'function' ? ctx.yield() : Promise.resolve());
const designOf = (ctx) => ({ ...ctx.engine, ...(ctx.upstream('s01')?.design || {}) });
const fromDesign = (key, scale = 1, digits = 4) => (ctx) => {
  const up = ctx.upstream('s01')?.design?.[key];
  if (up !== undefined) return { value: +(up * scale).toPrecision(digits), prov: 'coupled' };
  const v = ctx.engine?.[key]; return v === undefined ? undefined : { value: +(v * scale).toPrecision(digits), prov: 'calc' };
};

// ---------- geometric helpers ----------
function merge(name, list, opts) { const m = new Mesh(name, opts); for (const q of list) { const off = m.p.length / 3; for (let k = 0; k < q.p.length; k++) m.p.push(q.p[k]); for (let k = 0; k < q.i.length; k++) m.i.push(q.i[k] + off); } return m; }
const boxAt = (name, lx, ly, lz, cx, cy, cz, opts) => box(name, lx, ly, lz, opts).translate(cx, cy, cz);
function helixSpring(name, { R, rw, n, L, x0 = 0, sides = 12, perTurn = 20, opts }) {
  const N = Math.max(12, Math.round(n * perTurn)), a = L / (2 * Math.PI * n), secs = [];
  for (let k = 0; k <= N; k++) {
    const th = 2 * Math.PI * n * k / N, c = [x0 + a * th, R * Math.cos(th), R * Math.sin(th)];
    const t = [a, -R * Math.sin(th), R * Math.cos(th)], tl = Math.hypot(...t), T = t.map(v => v / tl), Nn = [0, -Math.cos(th), -Math.sin(th)];
    const B = [T[1] * Nn[2] - T[2] * Nn[1], T[2] * Nn[0] - T[0] * Nn[2], T[0] * Nn[1] - T[1] * Nn[0]];
    secs.push(range(sides).map(j => { const ph = 2 * Math.PI * j / sides, cp = Math.cos(ph), sp = Math.sin(ph); return [0, 1, 2].map(d => c[d] + rw * (cp * Nn[d] + sp * B[d])); }));
  }
  return loft(name, secs, opts);
}
// Polar moment about the global z axis by divergence-theorem tetrahedra (unit density): ∫(x²+y²)dV
function inertiaZ(m) {
  const P = m.p; let J = 0;
  for (let k = 0; k < m.i.length; k += 3) {
    const a = m.i[k] * 3, b = m.i[k + 1] * 3, c = m.i[k + 2] * 3, xa = P[a], ya = P[a + 1], za = P[a + 2], xb = P[b], yb = P[b + 1], zb = P[b + 2], xc = P[c], yc = P[c + 1], zc = P[c + 2];
    const v = (xa * (yb * zc - zb * yc) - ya * (xb * zc - zb * xc) + za * (xb * yc - yb * xc)) / 6;
    J += v / 10 * (xa * xa + xb * xb + xc * xc + xa * xb + xa * xc + xb * xc + ya * ya + yb * yb + yc * yc + ya * yb + ya * yc + yb * yc);
  }
  return J;
}
const polyFactor = (n) => n * Math.sin(2 * Math.PI / n) / (2 * Math.PI); // inscribed n-gon area / circle area

// Parametric cartridge in local coordinates: x radial (ribbon length), y tangential (ribbon width), z axial (stack)
export function buildCartridge(g, tag = '') {
  const parts = [], C = g.colors, add = (m, comp, count = 1) => { m.component = comp; m.count = count; parts.push(m); return m; };
  const xR0 = g.carL + g.gripL, xR1 = xR0 + g.L, xEnd = xR1 + g.gripL, xF0 = -(g.springFree + g.wall);
  // ribbon bundle and plate stack
  const ribs = [], plates = []; let z = -g.stackH / 2;
  const plateAt = (zc) => plates.push(boxAt('plate', g.L - g.plateGap, g.plateW, g.tPlate, xR0 + g.plateGap + (g.L - g.plateGap) / 2, 0, zc));
  for (let k = 0; k < g.nRib; k++) {
    if (g.plate === 'dedicated' || k === 0) { plateAt(z + g.tPlate / 2); z += g.tPlate; }
    z += g.tc; ribs.push(boxAt('ribbon', g.L, g.w, g.t, (xR0 + xR1) / 2, 0, z + g.t / 2)); z += g.t + g.tc;
    plateAt(z + g.tPlate / 2); z += g.tPlate;
  }
  add(merge(`${tag}SMA ribbon bundle (${g.nRib} ribbons)`, ribs, { color: C.sma, group: 'Ribbon bundle' }), 'ribbon');
  add(merge(`${tag}Microchannel plate stack (${plates.length} plates)`, plates, { color: C.plate, group: 'Heat exchange' }), 'channelPlate');
  add(boxAt(`${tag}Moving grip`, g.gripL, g.Wc, g.Hc, g.carL + g.gripL / 2, 0, 0, { color: C.grip, group: 'Grips' }), 'grip');
  add(boxAt(`${tag}Fixed grip`, g.gripL, g.Wc, g.Hc, xR1 + g.gripL / 2, 0, 0, { color: C.grip, group: 'Grips' }), 'grip');
  add(boxAt(`${tag}Carriage`, g.carL, g.Wc * 0.9, g.Hc * 0.9, g.carL / 2, 0, 0, { color: C.carriage, group: 'Transmission' }), 'carriage');
  add(cylinder(`${tag}Push rod`, g.rodD / 2, g.rodL, 20, { color: C.carriage, group: 'Transmission' }).rotY(Math.PI / 2).translate(-g.rodL / 2, 0, 0), 'carriage');
  add(helixSpring(`${tag}Bias spring`, { R: g.springD / 2, rw: g.springWire / 2, n: g.springCoils, L: g.springFree, x0: xF0 + g.wall, opts: { color: C.spring, group: 'Bias spring' } }), 'biasSpring');
  const Lh = xEnd + g.wall - xF0, xc = (xEnd + g.wall + xF0) / 2;
  add(merge(`${tag}Housing sleeve`, [boxAt('t', Lh, g.Wout, g.wall, xc, 0, g.Hc / 2 + g.wall / 2), boxAt('b', Lh, g.Wout, g.wall, xc, 0, -g.Hc / 2 - g.wall / 2), boxAt('l', Lh, g.wall, g.Hc, xc, g.Wc / 2 + g.wall / 2, 0), boxAt('r', Lh, g.wall, g.Hc, xc, -g.Wc / 2 - g.wall / 2, 0)], { color: C.housing, group: 'Housing', opacity: 0.35 }), 'housing');
  add(tube(`${tag}Inner flange`, Math.min(g.Wc, g.Hc) / 2, g.rodD / 2 + 0.4e-3, g.wall, 32, { color: C.housing, group: 'Housing' }).rotY(Math.PI / 2).translate(xF0 + g.wall / 2, 0, 0), 'housing');
  add(boxAt(`${tag}End cap`, g.wall, g.Wc, g.Hc, xEnd + g.wall / 2, 0, 0, { color: C.housing, group: 'Housing' }), 'housing');
  const xP = xR0 + g.plateGap + (g.L - g.plateGap) / 2;
  add(cylinder(`${tag}Hot port`, g.portD / 2, g.portL, 20, { color: C.hot, group: 'Ports' }).translate(xP, 0, g.Hout / 2 + g.portL / 2), 'manifold');
  add(cylinder(`${tag}Cold port`, g.portD / 2, g.portL, 20, { color: C.cold, group: 'Ports' }).translate(xP, 0, -g.Hout / 2 - g.portL / 2), 'manifold');
  return { parts, xF0, xEnd: xEnd + g.wall, xP, xRod0: -g.rodL };
}

function sectionSVG(sec, g) {
  const s = 640 / (sec.W * 1.15), W = 700, Ht = (2 * sec.ymax) * s, H = Ht + 120, X = (x) => 40 + x * s, Y = (y) => 50 + (sec.ymax - y) * s;
  let o = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H.toFixed(0)}" width="100%" style="max-height:560px;background:#fff" font-family="Arial,Helvetica,sans-serif"><defs><marker id="dm" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,1L10,5L0,9z" fill="#1d4ed8"/></marker></defs>`;
  const rect = (x0, y0, x1, y1, fill, stroke = '#111') => { o += `<rect x="${X(x0).toFixed(2)}" y="${Y(y1).toFixed(2)}" width="${((x1 - x0) * s).toFixed(2)}" height="${((y1 - y0) * s).toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/>`; };
  const yR = sec.t / 2, yC = yR + sec.tc;
  rect(0, -sec.ymax, sec.W, sec.ymax, '#cbd5e1'); rect(0, -yC, sec.W, yC, '#94a3b8'); rect(0, -yR, sec.W, yR, '#c58b4b');
  for (const hh of sec.holes) { rect(hh.x0, hh.y0, hh.x1, hh.y1, '#bfdbfe', '#1d4ed8'); rect(hh.x0, -hh.y1, hh.x1, -hh.y0, '#bfdbfe', '#1d4ed8'); }
  const dim = (x1, y1, x2, y2, label, vertical) => { o += `<line x1="${X(x1)}" y1="${Y(y1)}" x2="${X(x2)}" y2="${Y(y2)}" stroke="#1d4ed8" stroke-width="0.7" marker-start="url(#dm)" marker-end="url(#dm)"/><text x="${(X(x1) + X(x2)) / 2 + (vertical ? 6 : 0)}" y="${(Y(y1) + Y(y2)) / 2 - (vertical ? -4 : 4)}" font-size="11" fill="#1d4ed8" text-anchor="${vertical ? 'start' : 'middle'}">${label}</text>`; };
  const h0 = sec.holes.find(hh => hh.side === 'top') || sec.holes[0];
  if (h0) { dim(h0.x0, sec.ymax + 0.12 * sec.ymax, h0.x1, sec.ymax + 0.12 * sec.ymax, `chW ${fmt(sec.chW * 1e3, 3)} mm`); dim(h0.x1 + 0.03 * sec.W, h0.y0, h0.x1 + 0.03 * sec.W, h0.y1, `chH ${fmt((h0.y1 - h0.y0) * 1e3, 3)} mm${sec.plate === 'shared' ? ' (half, shared plate)' : ''}`, true); dim(h0.x0 - 0.03 * sec.W, yC, h0.x0 - 0.03 * sec.W, h0.y0, `web ${fmt(sec.web * 1e3, 3)}`, true); }
  dim(0, -sec.ymax - 0.15 * sec.ymax, sec.pitch, -sec.ymax - 0.15 * sec.ymax, `pitch ${fmt(sec.pitch * 1e3, 4)} mm`);
  dim(sec.W + 0.02 * sec.W, -yR, sec.W + 0.02 * sec.W, yR, `t ${fmt(sec.t * 1e6, 3)} µm, contact ${fmt(sec.tc * 1e6, 3)} µm`, true);
  o += `<text x="40" y="22" font-size="13" font-weight="700">Section A–A: ribbon between ${sec.plate} microchannel plates (${g.nChPlate} channels across the ${fmt(g.w * 1e3, 3)} mm ribbon)</text><text x="40" y="${H - 12}" font-size="10" fill="#334155">Ribbon (bronze) · contact layer (grey) · plate (light grey) · coolant channel (blue). Dimensions in mm unless stated; unit cell repeats across the width.</text></svg>`;
  return o;
}

// Complete parametric geometry of the radial multicell engine from resolved suite parameters (shared with the dossier
// generator so drawings and analyses always use identical solids). Lengths SI.
export function buildEngineGeometry(p, { alloy, stroke05 } = {}) {
    const N = Math.max(3, Math.round(p.nCells)), nRib = Math.max(1, Math.round(p.nRib)), L = p.L_mm / 1e3, w = p.w_mm / 1e3, t = p.t_um / 1e6, chW = p.chW_mm / 1e3, chH = p.chH_mm / 1e3, web = p.web_mm / 1e3, skin = p.skin_mm / 1e3, tc = p.tc_um / 1e6;
    const nPlates = p.plate === 'dedicated' ? 2 * nRib : nRib + 1, nChPlate = Math.max(1, Math.round(p.chPerCell / (p.plate === 'dedicated' ? 2 * nRib : nRib + 1))), pitch = w / nChPlate;
    const tPlate = p.plate === 'dedicated' ? web + chH + skin : 2 * web + chH, stackH = nPlates * tPlate + nRib * (t + 2 * tc);
    const stroke = stroke05 ?? alloy.epsL * p.xiUse * L, strokeProv = stroke05 ? 'coupled' : 'calc';
    const travel = p.travel_mm / 1e3, clear = p.clear_mm / 1e3, wall = p.wall_mm / 1e3, plateW = w + 2 * p.plateEdge_mm / 1e3, Wc = plateW + 1e-3, Hc = stackH + 1e-3, Wout = Wc + 2 * wall, Hout = Hc + 2 * wall;
    const g = { L, w, t, tc, nRib, plate: p.plate, tPlate, plateW, stackH, gripL: p.gripL_mm / 1e3, carL: p.carL_mm / 1e3, wall, Wc, Hc, Wout, Hout, plateGap: travel + 0.5e-3, springD: p.springD_mm / 1e3, springWire: p.springWire_mm / 1e3, springCoils: p.springCoils, springFree: p.springFree_mm / 1e3, rodD: p.rodD_mm / 1e3, portD: Math.min(4e-3, 0.5 * Wout), portL: 6e-3, nChPlate,
      colors: { sma: '#c58b4b', plate: '#b8c0cc', grip: '#8b9bb4', carriage: '#64748b', spring: '#d4d4d8', housing: '#5a7fa8', hot: '#ef4444', cold: '#3b82f6' } };
    const rotorR = p.rotorR_mm / 1e3, sinA = Math.sin(Math.PI / N);
    const rTang = (Wout + clear) / (2 * sinA), rRot = rotorR + travel + 3 * clear;
    const rInner = p.rInner_mm > 0 ? p.rInner_mm / 1e3 : 1.1 * Math.max(rTang, rRot), rInnerProv = p.rInner_mm > 0 ? 'user' : 'generated';
    // local cartridge → global placement; flange inner face at rInner
    const proto = buildCartridge({ ...g, rodL: 1e-3 });
    const rodL = Math.max(1e-3, rInner - rotorR - clear) + (g.springFree + wall); g.rodL = rodL;
    const cartLen = proto.xEnd - proto.xF0, rOuter = rInner + cartLen, rPort = rInner + (proto.xP - proto.xF0), rM = p.manifoldD_mm / 2e3;
    const zM = Hout / 2 + g.portL + rM, Rcase = Math.max(rOuter, rPort + rM) + clear + 2e-3, tCase = 4e-3, Lcase = 2 * (zM + rM + clear), shaftL = Lcase + 2 * tCase + 0.06;
    const parts = [], cart0 = [];
    for (let k = 0; k < N; k++) {
      const c = buildCartridge(g, `C${String(k + 1).padStart(2, '0')} `), phi = 2 * Math.PI * k / N;
      for (const m of c.parts) { m.translate(rInner - c.xF0, 0, 0).rotZ(phi); m.cartridge = k; parts.push(m); if (k === 0) cart0.push(m); }
    }
    const rotor = cylinder('Rotor / flywheel disc', rotorR, p.rotorT_mm / 1e3, 72, { color: '#9aa4b2', group: 'Rotor' }); rotor.component = 'rotor'; rotor.count = 1;
    const shaft = cylinder('Output shaft', p.shaftD_mm / 2e3, shaftL, 36, { color: '#e5e7eb', group: 'Rotor' }); shaft.component = 'shaft'; shaft.count = 1;
    const mHot = torus('Hot manifold ring', rPort, rM, 72, 16, { color: '#ef4444', group: 'Manifolds' }).translate(0, 0, zM); mHot.component = 'manifold'; mHot.shellT = 1.5e-3;
    const mCold = torus('Cold manifold ring', rPort, rM, 72, 16, { color: '#3b82f6', group: 'Manifolds' }).translate(0, 0, -zM); mCold.component = 'manifold'; mCold.shellT = 1.5e-3;
    const casing = tube('Casing shell', Rcase + tCase, Rcase, Lcase, 96, { color: '#475569', group: 'Casing', opacity: 0.16 }); casing.component = 'casing';
    const endA = cylinder('Front end plate', Rcase + tCase, tCase, 96, { color: '#475569', group: 'Casing', opacity: 0.16 }).translate(0, 0, Lcase / 2 + tCase / 2); endA.component = 'casing';
    const endB = cylinder('Rear end plate', Rcase + tCase, tCase, 96, { color: '#475569', group: 'Casing', opacity: 0.16 }).translate(0, 0, -Lcase / 2 - tCase / 2); endB.component = 'casing';
    const engineParts = [rotor, shaft, mHot, mCold, casing, endA, endB];
    parts.push(...engineParts);
    return { N, nRib, L, w, t, chW, chH, web, skin, tc, nPlates, nChPlate, pitch, tPlate, stackH, stroke, strokeProv, travel, clear, wall, plateW, Wc, Hc, Wout, Hout, g, rotorR, sinA, rTang, rRot, rInner, rInnerProv, proto, rodL, cartLen, rOuter, rPort, rM, zM, Rcase, tCase, Lcase, shaftL, parts, cart0, rotor, shaft, mHot, mCold, casing, endA, endB, engineParts };
}

export default {
  description: 'Builds the THERMA-X100 ribbon, ribbon bundle, cartridge and radial multicell engine parametrically from the engine design as closed solids; reports volumes, part masses, rotor inertia and clearance/interference margins; produces dimensioned drawings and neutral CAD/mesh exports; meshes the ribbon–contact–microchannel-plate cross-section with graded structured and Delaunay meshers and selects the mesh from a 4-level grid-convergence study.',
  literature: 'grid convergence index mesh sensitivity conjugate heat transfer microchannel finite element mesh quality',
  sustain: true, econ: true,
  credibility: 'Numerically verified',
  equations: [
    'Divergence theorem for closed triangulated shells: V = Σ (a·(b×c))/6, centroid and polar moment J_z = ρ Σ V_tet/10·Σ_{i≤j}(x_i x_j + y_i y_j)',
    'Part mass m = ρ·V (channel voids subtracted from plates); cartridge and engine dry mass are sums over parts and counts',
    'Ribbon stroke s = ε_L·ξ_use·L; bias-spring helix length ℓ = √((2πRn)² + L_free²)',
    'Tangential cartridge clearance at the inner radius: corner distance |A − R(2π/N)·B| of adjacent radial cartridges',
    'Transient conduction ρc_p ∂T/∂t = ∇·(k∇T) per region (ribbon, contact layer with k = h_c·t_c, plate) with −k∂T/∂n = h(T − T_f) on channel walls',
    'P1 Galerkin weak form Σ_e [k∫∇N_i·∇N_j dA] T_j + h∮N_iN_j ds T_j + ρc_p M_L dT/dt = h T_f ∮N_i ds',
    'Mesh quality: min/max angle, aspect ratio L_max/(2√3 r_in), equiangle skewness, scaled Jacobian, adjacent-area ratio, h = √(A/N)',
    'Richardson extrapolation f_ext = (r^p f₁ − f₂)/(r^p − 1); observed order p from three grids (Celik et al. 2008 fixed point); GCI = F_s |ε|/(r^p − 1), F_s = 1.25',
  ],
  methods: [
    'Procedural B-rep-like solids from the cad.js kernel (boxes, cylinders, tubes, tori, lofted helix) tessellated into closed oriented shells; edge-manifold check per part',
    'Graded tensor-product mesher (equidistributed 1-D spacing following h = min(h_max, h_ribbon + (g−1)d_ribbon, h_channel + (g−1)d_channel)) split into right triangles with alternating diagonals',
    'Unstructured Bowyer–Watson Delaunay mesher: graded boundary points on every interface, quadtree + Poisson-disk interior points, boundary recovery by midpoint insertion, validity-preserving smoothing',
    'Lumped-capacity implicit-Euler P1 conduction with Jacobi-preconditioned conjugate gradients (num.pcg, warm start)',
    'Mesh study: systematic refinement of every target size by r per level (4 levels), functional at a fixed time with a fixed time step, Richardson/GCI on the three finest levels and on the three coarsest for consistency of p',
    'Automatic mesh selection: cheapest level with estimated discretisation error ≤ target, max angle ≤ limit, aspect ratio ≤ limit, no inverted element, element budget',
  ],
  assumptions: [
    'Radial engine with stationary cartridges pushing a central rotor through one-way clutches; only rotor and shaft contribute to the rotating inertia (reciprocating carriages and rods excluded)',
    'Microchannel plates are modelled as solid plates for 3-D display; channel voids are subtracted analytically for mass and coolant inventory',
    'Contact layer represented as a thin region of thickness t_c with k = h_c·t_c (same thermal resistance as the interface conductance)',
    'Cross-section meshing uses the periodic unit cell (one channel pitch, half thickness with symmetry); shared plates end on the plate mid-plane (adiabatic symmetry)',
    'Mesh-sensitivity functional uses constant properties without latent heat (latent heat is included in Suite 08); time step is fixed across levels so that the spatial error is isolated',
    'Faceted solids: curved surfaces are polygonal (inscribed), volumes of round parts are slightly under-estimated (quantified in the checks)',
  ],
  ibc: {
    initial: ['Reference geometry from the engine design (Suite 01 when run, otherwise the project engine record)', 'Cross-section at the cold-sink temperature T_c (uniform) at t = 0'],
    boundary: ['Channel walls: convective (Robin) h_film to the hot-fluid temperature T_h', 'Ribbon mid-plane, unit-cell sides and plate mid-plane: symmetry (adiabatic)', 'CAD: dimensional constraints (ribbon, channel, plate, spring, clearance) and the minimum clearance rule'],
  },
  cvv: {
    calibration: ['Measured part dimensions and masses after manufacture (Suite 20 metrology) replace the parametric values'],
    verification: ['Closed, consistently oriented shells; positive volumes', 'Mesh volume vs closed-form volumes (boxes exact, faceted cylinders/tori against the inscribed-polygon formula)', 'Rotor inertia by mesh integration vs ½mR²', 'FE patch test (linear field reproduced exactly)', '2-D FE plane-wall transient vs analytic eigen-series', 'Meshed region areas vs analytic cross-section areas', 'GCI, observed order and asymptotic range'],
    validation: ['Coordinate-measuring-machine inspection and weighing of manufactured parts', 'Instrumented thermal step tests on a cartridge section (Suite 08 / 19)'],
  },
  formats: { import: ['STL / OBJ geometry (Data portal) for comparison', 'MSH 2.2 / VTK meshes (Import mode)'], export: ['STEP AP214 faceted B-rep', 'STL (binary)', 'OBJ', 'PLY', 'DXF & SVG engineering drawing', 'SVG dimensioned section', 'Gmsh MSH 2.2 (physical groups for regions and boundaries)', 'Legacy VTK unstructured grid with temperature and region data', 'CSV nodes / elements / boundary edges', 'ZIP bundle'] },
  params: [
    { key: 'nCells', label: 'Cartridges (cells) around the rotor', type: 'number', min: 3, max: 60, step: 1, default: 12, group: 'Engine layout', auto: fromDesign('nCells') },
    { key: 'nRib', label: 'Ribbons per cartridge', type: 'number', min: 1, max: 200, step: 1, default: 20, group: 'Ribbon & bundle', auto: fromDesign('ribbonsPerCell') },
    { key: 'L_mm', label: 'Ribbon active length', unit: 'mm', type: 'number', min: 10, max: 1000, step: 1, default: 100, group: 'Ribbon & bundle', auto: fromDesign('ribbonL', 1e3) },
    { key: 'w_mm', label: 'Ribbon width', unit: 'mm', type: 'number', min: 0.5, max: 100, step: 0.1, default: 5, group: 'Ribbon & bundle', auto: fromDesign('ribbonW', 1e3) },
    { key: 't_um', label: 'Ribbon thickness', unit: 'µm', type: 'number', min: 10, max: 2000, step: 5, default: 100, group: 'Ribbon & bundle', auto: fromDesign('ribbonT', 1e6) },
    { key: 'alloy', label: 'Ribbon alloy', type: 'select', options: smaAlloys().map(m => ({ value: m.id, label: m.name })), default: 'niti-lt', group: 'Ribbon & bundle', auto: (c) => (c.upstream('s03')?.alloyId ? { value: c.upstream('s03').alloyId, prov: 'coupled' } : { value: designOf(c).alloy, prov: 'calc' }) },
    { key: 'xiUse', label: 'Realised transformation fraction (stroke)', type: 'range', min: 0.3, max: 1, step: 0.05, default: 0.85, group: 'Ribbon & bundle', help: 'Fraction of the recoverable strain ε_L actually cycled; Suite 05 stroke overrides it when available.' },
    { key: 'chW_mm', label: 'Channel width', unit: 'mm', type: 'number', min: 0.05, max: 10, step: 0.05, default: 1, group: 'Microchannel plates', auto: fromDesign('chW', 1e3) },
    { key: 'chH_mm', label: 'Channel height', unit: 'mm', type: 'number', min: 0.05, max: 10, step: 0.05, default: 0.8, group: 'Microchannel plates', auto: fromDesign('chH', 1e3) },
    { key: 'chPerCell', label: 'Channels per cell (target)', type: 'number', min: 1, max: 2000, step: 1, default: 60, group: 'Microchannel plates', auto: fromDesign('chPerCell') },
    { key: 'plate', label: 'Plate arrangement', type: 'select', default: 'shared', options: [{ value: 'shared', label: 'Shared plates (P–R–P–R–…–P)' }, { value: 'dedicated', label: 'Dedicated plate pair per ribbon' }], group: 'Microchannel plates' },
    { key: 'web_mm', label: 'Web (channel to ribbon face)', unit: 'mm', type: 'number', min: 0.02, max: 3, step: 0.01, default: 0.2, group: 'Microchannel plates' },
    { key: 'skin_mm', label: 'Outer skin (dedicated plates)', unit: 'mm', type: 'number', min: 0.02, max: 3, step: 0.01, default: 0.2, group: 'Microchannel plates' },
    { key: 'tc_um', label: 'Contact (interface) layer thickness', unit: 'µm', type: 'number', min: 0, max: 500, step: 5, default: 25, group: 'Microchannel plates' },
    { key: 'hContact', label: 'Interface conductance h_c', unit: 'W/m²K', type: 'number', min: 100, max: 1e6, step: 100, default: 20000, group: 'Microchannel plates', auto: (c) => (c.upstream('s08')?.hContact_Wm2K ? { value: Math.round(c.upstream('s08').hContact_Wm2K), prov: 'coupled' } : fromDesign('hContact')(c)) },
    { key: 'plateEdge_mm', label: 'Plate sealing edge (each side)', unit: 'mm', type: 'number', min: 0, max: 10, step: 0.1, default: 1, group: 'Microchannel plates' },
    { key: 'gripL_mm', label: 'Grip length', unit: 'mm', type: 'number', min: 2, max: 50, step: 1, default: 10, group: 'Cartridge' },
    { key: 'carL_mm', label: 'Carriage length', unit: 'mm', type: 'number', min: 2, max: 60, step: 1, default: 12, group: 'Cartridge' },
    { key: 'wall_mm', label: 'Housing wall', unit: 'mm', type: 'number', min: 0.5, max: 10, step: 0.1, default: 1.5, group: 'Cartridge' },
    { key: 'travel_mm', label: 'Carriage travel allowance', unit: 'mm', type: 'number', min: 0.5, max: 50, step: 0.1, default: 5, group: 'Cartridge', help: 'Default: 1.3 × ribbon stroke.', auto: (c) => { const st = c.upstream('s05')?.stroke_m; if (st) return { value: +(st * 1.3e3).toFixed(2), prov: 'coupled' }; const d = designOf(c), m = getMat(d.alloy); return m ? { value: +(1.3 * 0.85 * m.epsL * d.ribbonL * 1e3).toFixed(2), prov: 'calc' } : undefined; } },
    { key: 'springD_mm', label: 'Bias spring mean coil diameter', unit: 'mm', type: 'number', min: 1, max: 40, step: 0.1, default: 5, group: 'Cartridge' },
    { key: 'springWire_mm', label: 'Spring wire diameter', unit: 'mm', type: 'number', min: 0.1, max: 6, step: 0.05, default: 0.8, group: 'Cartridge' },
    { key: 'springCoils', label: 'Spring active coils', type: 'number', min: 2, max: 40, step: 1, default: 8, group: 'Cartridge' },
    { key: 'springFree_mm', label: 'Spring free length', unit: 'mm', type: 'number', min: 3, max: 120, step: 0.5, default: 18, group: 'Cartridge' },
    { key: 'rodD_mm', label: 'Push-rod diameter', unit: 'mm', type: 'number', min: 1, max: 20, step: 0.5, default: 3, group: 'Cartridge' },
    { key: 'clear_mm', label: 'Minimum clearance rule', unit: 'mm', type: 'number', min: 0.1, max: 20, step: 0.1, default: 2, group: 'Engine layout' },
    { key: 'rotorR_mm', label: 'Rotor radius', unit: 'mm', type: 'number', min: 10, max: 600, step: 1, default: 40, group: 'Engine layout' },
    { key: 'rotorT_mm', label: 'Rotor thickness', unit: 'mm', type: 'number', min: 2, max: 100, step: 1, default: 12, group: 'Engine layout' },
    { key: 'shaftD_mm', label: 'Shaft diameter', unit: 'mm', type: 'number', min: 4, max: 120, step: 1, default: 16, group: 'Engine layout' },
    { key: 'rInner_mm', label: 'Cartridge inner radius (0 = automatic)', unit: 'mm', type: 'number', min: 0, max: 1000, step: 1, default: 0, group: 'Engine layout', help: '0 places the cartridges at the smallest radius meeting the tangential and rotor clearance rules (+10 %).' },
    { key: 'manifoldD_mm', label: 'Manifold tube diameter', unit: 'mm', type: 'number', min: 3, max: 80, step: 1, default: 14, group: 'Engine layout' },
    { key: 'Th', label: 'Hot-fluid temperature (mesh study)', unit: '°C', type: 'number', min: 20, max: 300, step: 1, default: 70, group: 'Meshing', auto: (c) => (c.upstream('s06')?.ThSupply_C !== undefined ? { value: +c.upstream('s06').ThSupply_C.toFixed(1), prov: 'coupled' } : fromDesign('Th')(c)) },
    { key: 'Tc', label: 'Initial / cold temperature (mesh study)', unit: '°C', type: 'number', min: -30, max: 150, step: 1, default: 15, group: 'Meshing', auto: (c) => (c.upstream('s07')?.TcSupply_C !== undefined ? { value: +c.upstream('s07').TcSupply_C.toFixed(1), prov: 'coupled' } : fromDesign('Tc')(c)) },
    { key: 'hFilm', label: 'Channel-wall film coefficient', unit: 'W/m²K', type: 'number', min: 50, max: 2e5, step: 50, default: 6000, group: 'Meshing', auto: (c) => (c.upstream('s08')?.hHotWall_Wm2K ? { value: Math.round(c.upstream('s08').hHotWall_Wm2K), prov: 'coupled' } : undefined) },
    { key: 'mesher', label: 'Mesher for the sensitivity study', type: 'select', default: 'structured', options: [{ value: 'structured', label: 'Structured graded (right triangles)' }, { value: 'delaunay', label: 'Unstructured Delaunay' }], group: 'Meshing' },
    { key: 'functional', label: 'Sensitivity functional', type: 'select', default: 'theta', options: [{ value: 'theta', label: 'Ribbon mean temperature rise θ̄ at t*' }, { value: 'heat', label: 'Heat absorbed by the section up to t*' }, { value: 'grad', label: 'Maximum ribbon temperature gradient at t*' }], group: 'Meshing' },
    { key: 'nRibbon', label: 'Base cells through the half ribbon', type: 'number', min: 1, max: 20, step: 1, default: 2, group: 'Meshing', expert: true },
    { key: 'nChannel', label: 'Base cells across the channel short side', type: 'number', min: 2, max: 40, step: 1, default: 4, group: 'Meshing', expert: true },
    { key: 'growth', label: 'Size growth ratio g', type: 'number', min: 1.05, max: 2, step: 0.05, default: 1.3, group: 'Meshing', expert: true },
    { key: 'maxAspect', label: 'Structured max cell aspect (sizing)', type: 'number', min: 1, max: 40, step: 1, default: 8, group: 'Meshing', expert: true },
    { key: 'levels', label: 'Refinement levels', type: 'number', min: 3, max: 5, step: 1, default: 4, group: 'Mesh sensitivity', expert: true },
    { key: 'ratio', label: 'Refinement ratio r (per level, in h)', type: 'select', default: 1.4142, options: [{ value: 1.4142, label: '√2' }, { value: 1.5, label: '1.5' }, { value: 2, label: '2' }], group: 'Mesh sensitivity', expert: true },
    { key: 'tStar', label: 't* / τ (functional time)', type: 'number', min: 0.1, max: 3, step: 0.05, default: 0.5, group: 'Mesh sensitivity', expert: true, help: 'τ = section heat capacity / (h_film × wetted perimeter).' },
    { key: 'steps', label: 'Time steps to t*', type: 'number', min: 10, max: 400, step: 5, default: 40, group: 'Mesh sensitivity', expert: true },
    { key: 'gciTarget', label: 'Acceptance: estimated discretisation error', unit: '%', type: 'number', min: 0.01, max: 10, step: 0.01, default: 0.05, group: 'Mesh sensitivity' },
    { key: 'maxAngle', label: 'Acceptance: max element angle', unit: '°', type: 'number', min: 90, max: 170, step: 1, default: 130, group: 'Mesh sensitivity', expert: true },
    { key: 'maxAR', label: 'Acceptance: max aspect ratio', type: 'number', min: 1.5, max: 100, step: 0.5, default: 15, group: 'Mesh sensitivity', expert: true },
    { key: 'maxElems', label: 'Acceptance: element budget', type: 'number', min: 100, max: 200000, step: 100, default: 20000, group: 'Mesh sensitivity', expert: true },
    { key: 'dwgNo', label: 'Drawing number', type: 'text', default: 'TX100-CART-001', group: 'Drawing', expert: true },
  ],
  presets: [
    { label: 'Reference LT (12 cells × 20 ribbons)', values: { nCells: 12, nRib: 20, L_mm: 100, w_mm: 5, t_um: 100, plate: 'shared' } },
    { label: 'Thin foil, fine channels', values: { t_um: 50, chW_mm: 0.5, chH_mm: 0.4, web_mm: 0.15, chPerCell: 120 } },
    { label: 'Dedicated plates (separate circuits)', values: { plate: 'dedicated', web_mm: 0.2, skin_mm: 0.3 } },
    { label: '24-cell large rotor', values: { nCells: 24, rotorR_mm: 80 } },
    { label: 'Delaunay mesh study', values: { mesher: 'delaunay', ratio: 1.4142, levels: 4 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [], exports: [], outputs: {} };
    const K = (label, value, unit, explain, prov = 'calc', status) => out.kpis.push({ label, value, unit, explain, prov, status });
    const V = (test, status, detail, fix) => out.verdicts.push({ test, status, detail, fix });
    const CK = (name, value, target, pass, detail) => out.checks.push({ name, value, target, pass, detail });
    const design = designOf(ctx), alloy = getMat(p.alloy) || getMat(design.alloy) || getMat('niti-lt');
    const mat = (key) => componentMaterial(ctx.store, key);
    const M = { channelPlate: mat('channelPlate'), contactLayer: mat('contactLayer'), grip: mat('grip'), carriage: mat('carriage'), biasSpring: mat('biasSpring'), housing: mat('housing'), rotor: mat('rotor'), shaft: mat('shaft'), manifold: mat('manifold'), casing: mat('casing'), ribbon: alloy };
    // ---------- parametric dimensions (SI) ----------
    const { N, nRib, L, w, t, chW, chH, web, skin, tc, nPlates, nChPlate, pitch, tPlate, stackH, stroke, strokeProv, travel, clear, wall, plateW, Wc, Hc, Wout, Hout, g, rotorR, sinA, rTang, rRot, rInner, rInnerProv, proto, rodL, cartLen, rOuter, rPort, rM, zM, Rcase, tCase, Lcase, shaftL, parts, cart0, rotor, shaft, mHot, mCold, casing, endA, endB, engineParts } = buildEngineGeometry(p, { alloy, stroke05: ctx.upstream('s05')?.stroke_m });
    ctx.progress(0.1, 'mass properties');
    // ---------- mass properties ----------
    const chVoidPerPlate = nChPlate * chW * chH * (L - g.plateGap);
    const massOf = (m) => {
      const mt = M[m.component] || M.housing, V = m.volume();
      if (m.shellT) return { V, Vsolid: m.area() * m.shellT, mass: m.area() * m.shellT * mt.rho, mt };
      if (m.component === 'channelPlate') { const Vs = V - nPlates * chVoidPerPlate; return { V, Vsolid: Vs, mass: Vs * mt.rho, mt }; }
      return { V, Vsolid: V, mass: V * mt.rho, mt };
    };
    const rows = []; let mCart = 0, mEngine = 0, allClosed = true, allOriented = true, negVol = 0;
    const perComp = {};
    for (const m of parts) {
      const mp = massOf(m), man = m.checkManifold(); m.materialName = mp.mt.name;
      allClosed &&= man.closed; allOriented &&= man.oriented; if (mp.V <= 0) negVol++;
      mEngine += mp.mass; if (m.cartridge === 0) mCart += mp.mass;
      const key = m.component; (perComp[key] ||= { mass: 0, cost: 0, co2: 0, mt: mp.mt }); perComp[key].mass += mp.mass; perComp[key].cost += mp.mass * (mp.mt.cost || 0); perComp[key].co2 += mp.mass * (mp.mt.co2 || 0);
      if (m.cartridge === undefined || m.cartridge === 0) rows.push([m.name.replace(/^C01 /, ''), key, mp.mt.name, m.cartridge === 0 ? N : 1, mp.V * 1e6, mp.Vsolid * 1e6, mp.mass * 1e3, m.triangleCount, man.closed && man.oriented ? '✔' : '✖']);
    }
    // contact layers are too thin to display; their mass is added analytically
    const mContact = N * nRib * 2 * tc * L * w * (M.contactLayer.rho || 1100); mEngine += mContact; mCart += mContact / N;
    (perComp.contactLayer ||= { mass: 0, cost: 0, co2: 0, mt: M.contactLayer }); perComp.contactLayer.mass += mContact; perComp.contactLayer.cost += mContact * (M.contactLayer.cost || 0); perComp.contactLayer.co2 += mContact * (M.contactLayer.co2 || 0);
    rows.push(['Contact layers (analytic, not displayed)', 'contactLayer', M.contactLayer.name, N, 2 * nRib * tc * L * w * 1e6, 2 * nRib * tc * L * w * 1e6, mContact / N * 1e3, 0, '—']);
    const ribVol = N * nRib * L * w * t, ribMass = ribVol * alloy.rho, ribbonPart = cart0.find(m => m.component === 'ribbon');
    const fluidVol = N * nPlates * chVoidPerPlate + 2 * 2 * Math.PI ** 2 * rPort * (rM - 1.5e-3) ** 2;
    const Jrotor = inertiaZ(rotor) * M.rotor.rho, Jshaft = inertiaZ(shaft) * M.shaft.rho, J = Jrotor + Jshaft;
    const mRot = rotor.volume() * M.rotor.rho, JrotAnalytic = 0.5 * (Math.PI * rotorR ** 2 * p.rotorT_mm / 1e3 * M.rotor.rho) * rotorR ** 2;
    const tris = sum(parts.map(m => m.triangleCount));
    const cost = sum(Object.values(perComp).map(c => c.cost)), co2 = sum(Object.values(perComp).map(c => c.co2));
    // ---------- CAD verification ----------
    CK('All solids closed (2-manifold)', `${parts.filter(m => m.checkManifold().closed).length}/${parts.length}`, 'all', allClosed, 'every edge shared by exactly two triangles');
    CK('Consistent outward orientation', allOriented ? 'yes' : 'no', 'all edges opposite-oriented', allOriented);
    CK('Positive enclosed volumes', `${parts.length - negVol}/${parts.length}`, 'all > 0', negVol === 0);
    const ribErr = Math.abs(ribbonPart.volume() - nRib * L * w * t) / (nRib * L * w * t);
    CK('Ribbon bundle volume vs n·L·w·t (exact boxes)', ribErr, '< 1e-9', ribErr < 1e-9, `${fmt(ribbonPart.volume() * 1e9, 6)} mm³ vs ${fmt(nRib * L * w * t * 1e9, 6)} mm³`);
    const VrotPoly = Math.PI * rotorR ** 2 * polyFactor(72) * p.rotorT_mm / 1e3, rotErr = Math.abs(rotor.volume() - VrotPoly) / VrotPoly, facet = 1 - polyFactor(72);
    CK('Rotor volume vs inscribed 72-gon prism', rotErr, '< 1e-9', rotErr < 1e-9, `faceting under-estimates the true cylinder by ${(facet * 100).toFixed(3)} %`);
    const VtorPoly = 2 * Math.PI * rPort * Math.PI * rM ** 2, torErr = Math.abs(mHot.volume() - VtorPoly) / VtorPoly;
    CK('Manifold torus volume vs Pappus 2π²Rr²', torErr, '< 3 % (72×16 facets)', torErr < 0.03);
    const springPart = cart0.find(m => m.component === 'biasSpring'), ell = Math.hypot(2 * Math.PI * g.springD / 2 * g.springCoils, g.springFree), Vsp = Math.PI * (g.springWire / 2) ** 2 * polyFactor(12) * ell, spErr = Math.abs(springPart.volume() - Vsp) / Vsp;
    CK('Bias-spring helix volume vs A_wire·ℓ (12-gon wire)', spErr, '< 3 % (end caps, helix curvature)', spErr < 0.03);
    CK('Rotor inertia: mesh integration vs ½mR²', Math.abs(Jrotor - JrotAnalytic) / JrotAnalytic, '< 1 % (faceting)', Math.abs(Jrotor - JrotAnalytic) / JrotAnalytic < 0.01, `J_mesh = ${fmt(Jrotor, 4)} kg·m², ½mR² = ${fmt(JrotAnalytic, 4)} kg·m²`);
    await yieldTo(ctx);
    // ---------- clearance / interference ----------
    const A = [rInner, Wout / 2], al = 2 * Math.PI / N, Bc = [rInner * Math.cos(al) + Wout / 2 * Math.sin(al), rInner * Math.sin(al) - Wout / 2 * Math.cos(al)], gapT = Math.hypot(A[0] - Bc[0], A[1] - Bc[1]) * Math.sign(Math.atan2(Bc[1], Bc[0]) - Math.atan2(A[1], A[0]) || 1);
    const solidL = (g.springCoils + 1) * g.springWire, coilOD = g.springD + g.springWire, cavMin = Math.min(Wc, Hc);
    const land = pitch - chW, gapRot = rInner - rotorR;
    const cl = [
      { item: 'Tangential gap between adjacent cartridges (inner corners)', value: gapT, need: clear, unit: 'mm', fix: `Increase the inner radius above ${fmt(rTang * 1e3, 4)} mm, reduce cartridge width (${fmt(Wout * 1e3, 4)} mm) or use fewer cells.` },
      { item: 'Radial gap rotor rim → cartridge flange (rod/clutch stroke room)', value: gapRot, need: travel + clear, unit: 'mm', fix: 'Reduce the rotor radius or move the cartridges outward.' },
      { item: 'Carriage travel allowance − ribbon stroke', value: travel - stroke, need: 0.1 * stroke, unit: 'mm', fix: `Raise the travel allowance to ≥ ${fmt(stroke * 1.2e3, 3)} mm.` },
      { item: 'Plate-to-moving-grip gap − stroke (no collision on contraction)', value: g.plateGap - stroke, need: 0, unit: 'mm', fix: 'Shorten the plates at the moving end or limit the stroke.' },
      { item: 'Spring free length − solid length', value: g.springFree - solidL, need: travel, unit: 'mm', fix: 'Use more free length, fewer coils or thinner wire.' },
      { item: 'Housing cavity − spring coil outer diameter', value: cavMin - coilOD, need: 0.3e-3, unit: 'mm', fix: `Reduce the coil diameter below ${fmt((cavMin - 0.3e-3) * 1e3, 3)} mm.` },
      { item: 'Channel land width (pitch − channel width)', value: land, need: 0.15e-3, unit: 'mm', fix: 'Fewer, narrower channels per plate, or a wider ribbon.' },
      { item: 'Web between channel and ribbon face', value: web, need: 0.1e-3, unit: 'mm', fix: 'Thicker web (manufacturing and pressure-containment minimum ≈ 0.1 mm).' },
      { item: 'Casing inner radius − outer cartridge end', value: Rcase - rOuter, need: clear, unit: 'mm', fix: 'Enlarge the casing.' },
      { item: 'Shaft diameter < rotor diameter', value: rotorR - p.shaftD_mm / 2e3, need: 5e-3, unit: 'mm', fix: 'Increase the rotor radius.' },
    ].map(c => ({ ...c, margin: c.value - c.need, pass: c.value - c.need >= -1e-12 }));
    const minMargin = Math.min(...cl.map(c => c.margin)), worst = cl.reduce((a, b) => (b.margin < a.margin ? b : a));
    for (const c of cl) if (!c.pass) V(`Interference: ${c.item}`, 'fail', `${fmt(c.value * 1e3, 4)} mm available vs ${fmt(c.need * 1e3, 4)} mm required.`, c.fix);
    V('Clearance & interference report', cl.every(c => c.pass) ? 'pass' : 'fail', `${cl.filter(c => c.pass).length}/${cl.length} rules satisfied; smallest margin ${fmt(minMargin * 1e3, 3)} mm (${worst.item}).`, cl.every(c => c.pass) ? undefined : worst.fix);
    const chAch = nChPlate * nPlates;
    V('Channel count realised vs target', Math.abs(chAch - p.chPerCell) / p.chPerCell <= 0.1 ? 'pass' : 'warn', `${nChPlate} channels per plate × ${nPlates} plates = ${chAch} channels per cell (target ${p.chPerCell}).`, 'Adjust the channel count so it divides evenly across the plates, or change the ribbon width.');
    // ---------- cross-section meshing & sensitivity study ----------
    ctx.progress(0.25, 'cross-section meshing');
    const sec = ML.cartridgeSection({ t, tc, chW, chH, web, skin, pitch, nPitch: 1, plate: p.plate, half: true, contact: tc > 0 });
    for (const e of sec.errors) V('Cross-section geometry', 'fail', e, 'Correct the channel/plate dimensions.');
    const kRib = 0.5 * (alloy.k + (alloy.kM ?? alloy.k)), cm = M.contactLayer, pm = M.channelPlate;
    const props = { ribbon: { k: kRib, rho: alloy.rho, cp: alloy.cp }, contact: { k: Math.max(1e-3, p.hContact * tc), rho: cm.rho, cp: cm.cp }, wall: { k: pm.k, rho: pm.rho, cp: pm.cp } };
    const Csec = sec.areas.ribbon * alloy.rho * alloy.cp + sec.areas.contact * cm.rho * cm.cp + sec.areas.wall * pm.rho * pm.cp, tau = Csec / (p.hFilm * sec.wetPerimeter), tStar = p.tStar * tau, dt = tStar / p.steps;
    const capRatio = sec.areas.wall * pm.rho * pm.cp / (sec.areas.ribbon * alloy.rho * alloy.cp);
    const Th = p.Th, Tc = p.Tc, bcs = { channel: { type: 'robin', h: p.hFilm, Tinf: Th } };
    const sizes = ML.defaultSizes(sec, { nRibbon: p.nRibbon, nChannel: p.nChannel, growth: p.growth, maxAspect: p.maxAspect });
    const runs = new Map();
    const functional = (mesh) => {
      const r = ML.solveTransient(mesh, { props, bcs, T0: Tc, dt, steps: p.steps, theta: 1 }); runs.set(mesh, r);
      return p.functional === 'heat' ? r.Ein : p.functional === 'grad' ? r.gradMax[r.gradMax.length - 1] : (r.stats.ribbon.mean[r.stats.ribbon.mean.length - 1] - Tc) / (Th - Tc);
    };
    const fUnit = p.functional === 'heat' ? 'J/m' : p.functional === 'grad' ? 'K/m' : '–', fName = { theta: 'θ̄ ribbon mean temperature rise', heat: 'heat absorbed per unit depth', grad: 'max ribbon |∇T|' }[p.functional];
    const study = ML.meshStudy(sec, { type: p.mesher, sizes, levels: Math.round(p.levels), ratio: +p.ratio, functional, onLevel: (k, n) => ctx.progress(0.25 + 0.4 * (k + 1) / n, `mesh level ${k + 1}/${n}`) });
    const sel = ML.selectMesh(study, { gciTarget: p.gciTarget / 100, maxAngle: p.maxAngle, maxAR: p.maxAR, maxElems: p.maxElems });
    const chosen = sel.level, mesh = chosen.mesh, Q = chosen.quality, G = study.gci;
    await yieldTo(ctx);
    // alternative mesher at the selected nominal size (mesher-independence and quality comparison)
    ctx.progress(0.7, 'mesher comparison');
    const altType = p.mesher === 'delaunay' ? 'structured' : 'delaunay', altMesh = ML.buildMesh(sec, { type: altType, ...ML.scaleSizes(sizes, Math.min(chosen.f, (+p.ratio) ** 1)) }), altQ = ML.meshQuality(altMesh), altVal = functional(altMesh);
    // full heating transient on the selected mesh (contour + animation)
    ctx.progress(0.8, 'heating transient on the selected mesh');
    const tEnd = 3 * tau, heat = ML.solveTransient(mesh, { props, bcs, T0: Tc, dt: tEnd / 90, steps: 90, theta: 1, snapEvery: 2 });
    const snapMid = heat.snaps.reduce((a, b) => (Math.abs(b.t - tStar) < Math.abs(a.t - tStar) ? b : a));
    // ---------- numerical verification ----------
    const patch = ML.patchTest(mesh), slab = ML.verifySlab({ Lh: t / 2, k: kRib, rho: alloy.rho, cp: alloy.cp, h: 1 / (1 / p.hFilm + 1 / Math.max(p.hContact, 1)), Tinf: Th, T0: Tc, tEnd: 0.2 * tau, steps: 100 });
    const regA = ML.regionStats(mesh, new Float64Array(mesh.nNodes).fill(1)), areaErr = Math.max(...['ribbon', 'contact', 'wall'].filter(r => sec.areas[r] > 0).map(r => Math.abs(regA[r].area - sec.areas[r]) / sec.areas[r]));
    CK('Meshed region areas vs analytic section areas', areaErr, '< 1e-9', areaErr < 1e-9, 'ribbon, contact and plate areas (channel voids excluded)');
    CK('FE patch test (linear field reproduced)', patch.maxErr, '< 1e-8', patch.maxErr < 1e-8, `selected ${mesh.kind} mesh, ${mesh.nNodes} nodes`);
    CK('2-D FE plane wall vs analytic eigen-series (centre)', slab.errC, '< 0.5 % of ΔT', slab.errC < 0.005, `T_FE ${fmt(slab.Tc, 5)} °C vs ${fmt(slab.TcAnalytic, 5)} °C (Bi ${fmt(slab.Bi, 3)}, Fo ${fmt(slab.Fo, 3)})`);
    CK('Transient energy balance (selected mesh)', heat.residual, '< 1e-4', heat.residual < 1e-4, `∫Q dt = ${fmt(heat.Ein, 5)} J/m vs ΔH = ${fmt(heat.dH, 5)} J/m`);
    const mshBack = parseMSH(ML.toMSH(mesh)), vtkBack = parseVTK(ML.toVTK(mesh, { point: { T_C: heat.T } }));
    CK('MSH 2.2 export → re-import (nodes, triangles)', `${mshBack.nodes}/${mshBack.triangles}`, `${mesh.nNodes}/${mesh.nElems}`, mshBack.nodes === mesh.nNodes && mshBack.triangles === mesh.nElems);
    CK('VTK export → re-import (nodes, triangles)', `${vtkBack.nodes}/${vtkBack.triangles}`, `${mesh.nNodes}/${mesh.nElems}`, vtkBack.nodes === mesh.nNodes && vtkBack.triangles === mesh.nElems);
    const stlBack = parseSTL(await toSTL(cart0, 'cartridge').arrayBuffer()), Pb = stlBack.positions; let Vb = 0;
    for (let k = 0; k < Pb.length; k += 9) Vb += (Pb[k] * (Pb[k + 4] * Pb[k + 8] - Pb[k + 5] * Pb[k + 7]) - Pb[k + 1] * (Pb[k + 3] * Pb[k + 8] - Pb[k + 5] * Pb[k + 6]) + Pb[k + 2] * (Pb[k + 3] * Pb[k + 7] - Pb[k + 4] * Pb[k + 6])) / 6;
    const V0 = sum(cart0.map(m => m.volume())), triC = sum(cart0.map(m => m.triangleCount));
    CK('STL export → re-import (one cartridge)', Math.abs(Vb - V0) / V0, `triangles ${triC}, volume deviation < 1e-4 (float32)`, stlBack.triangles === triC && Math.abs(Vb - V0) / V0 < 1e-4, `${stlBack.triangles} triangles read back`);
    CK('No inverted elements (all levels)', sum(study.levels.map(l => l.quality.inverted)), '0', study.levels.every(l => l.quality.inverted === 0));
    CK('Delaunay boundary recovery', (p.mesher === 'delaunay' ? mesh : altMesh).info.unrecovered ?? 0, '0 missing constraint edges', ((p.mesher === 'delaunay' ? mesh : altMesh).info.unrecovered ?? 0) === 0);
    if (G && G.capped) {
      CK('Observed order of accuracy p (finest triplet)', G.pObs, 'P1 conduction: ≈ 1–2.5', undefined, `${G.oscillatory ? 'Oscillatory' : 'Non-asymptotic'} convergence: the level-to-level changes (${fmt(G.ea21 * 100, 3)} %) are at the noise of the ${p.mesher} refinement sequence, so p is not meaningful. GCI evaluated conservatively with the formal order p = 2 and F_s = 3 (Roache).`);
      CK('GCI fine grid (conservative, formal order)', G.gci21 * 100, `< ${p.gciTarget} %`, G.gci21 * 100 < p.gciTarget);
    } else if (G && !G.exact) {
      CK('Observed order of accuracy p (finest triplet)', G.p, 'P1 conduction: ≈ 1–2.5', G.p > 0.8 && G.p < 3, G.oscillatory ? 'oscillatory convergence' : 'monotone convergence');
      CK('GCI fine grid', G.gci21 * 100, `< ${p.gciTarget} %`, G.gci21 * 100 < p.gciTarget, `GCI₃₂ ${fmt(G.gci32 * 100, 3)} %`);
      CK('Asymptotic-range ratio GCI₃₂/(r^p·GCI₂₁)', G.asymptoticRatio, '≈ 1 (± 10 %)', G.inAsymptoticRange);
      CK('Observed order consistent between coarse and fine triplets', `${fmt(study.gciCoarse?.p, 3)} vs ${fmt(G.p, 3)}`, '|Δp|/p < 35 %', study.pConsistent === false ? undefined : study.pConsistent ?? undefined, study.pConsistent === false ? `The coarsest level is pre-asymptotic; it is excluded from mesh selection (asymptotic range starts at L${study.asymptoticFrom + 1}).` : 'all levels in the asymptotic range');
      CK('Selected level inside the asymptotic range', `L${chosen.level}`, `≥ L${study.asymptoticFrom + 1}`, sel.index >= study.asymptoticFrom);
    } else CK('Grid convergence', 'functional identical on all levels', 'mesh-independent', true);
    CK('Selected mesh meets every acceptance criterion', sel.ok ? 'yes' : 'no', 'error, angle, aspect, validity, budget', sel.ok, sel.reason);
    // ---------- KPIs ----------
    K('Ribbon volume (engine)', ribVol * 1e6, 'cm³', `${N} cartridges × ${nRib} ribbons × ${fmt(L * 1e3, 4)} × ${fmt(w * 1e3, 3)} mm × ${fmt(t * 1e6, 3)} µm; exact box volumes.`, 'generated');
    K('Active SMA mass', ribMass, 'kg', `Ribbon volume × ρ = ${alloy.rho} kg/m³ (${alloy.name}). This is the active-material mass basis for specific power.`, 'calc');
    K('Cartridge mass (dry)', mCart, 'kg', `Sum of one cartridge's solids (bundle, plates minus channel voids, grips, carriage, rod, spring, housing, ports, contact layers) with library densities. Ratio to its active mass: ${fmt(mCart / (ribMass / N), 3)} (engine record assumes ${design.cartridgeFactor}).`, 'calc');
    K('Engine dry mass', mEngine, 'kg', `All ${parts.length} solids plus contact layers, without coolant (coolant inventory ≈ ${fmt(fluidVol * 1e6, 3)} cm³ ≈ ${fmt(fluidVol * 1000, 3)} kg water). Ratio to active mass ${fmt(mEngine / ribMass, 3)} (engine record assumes ${design.systemFactor}).`, 'calc');
    K('Rotor + shaft inertia', J, 'kg·m²', `Polar moment about the shaft by exact tetrahedral integration of the faceted rotor (${fmt(Jrotor, 4)}) and shaft (${fmt(Jshaft, 4)}); used for start-up dynamics (Suites 11, 15).`, 'calc');
    K('Envelope Ø × L', `${fmt(2 * (Rcase + tCase) * 1e3, 4)} × ${fmt((Lcase + 2 * tCase) * 1e3, 4)}`, 'mm', 'Casing outer diameter and axial length (shaft extensions excluded).', 'generated');
    K('Smallest clearance margin', minMargin * 1e3, 'mm', `Margin above the required value of the most critical clearance rule: ${worst.item}.`, 'calc', minMargin >= 0 ? 'ok' : 'bad');
    K('Ribbon stroke', stroke * 1e3, 'mm', `ε_L·ξ_use·L = ${alloy.epsL} × ${p.xiUse} × ${fmt(L * 1e3, 4)} mm${strokeProv === 'coupled' ? ' (Suite 05 result)' : ''}; carriage travel allowance ${fmt(travel * 1e3, 3)} mm.`, strokeProv);
    K('Plate/ribbon heat-capacity ratio', capRatio, '–', `Sensible heat capacity of the plate metal in the unit cell divided by that of the ribbon. Every cycle heats and cools this inert mass: values ≫ 1 mean most supplied heat never reaches the SMA.`, 'calc', capRatio > 3 ? 'warn' : 'ok');
    K('Selected mesh', `L${chosen.level}: ${chosen.nElem} elements`, '', `${mesh.kind} mesh, ${chosen.nNode} nodes, h = ${fmt(chosen.h * 1e6, 3)} µm. ${sel.reason}`, 'generated', sel.ok ? 'ok' : 'warn');
    K('GCI (fine grid)', G && !G.exact ? G.gci21 * 100 : 0, '%', G?.capped ? `Conservative grid-convergence index of the ${fName} between the two finest levels (formal order 2, F_s = 3) because the observed order ${fmt(G.pObs, 3)} is outside the theoretical range; finest value ${fmt(study.fext, 5)} ${fUnit}.` : `Grid-convergence index of the ${fName} between the two finest levels (F_s = 1.25); observed order p = ${fmt(G?.p, 3)}, extrapolated value ${fmt(study.fext, 5)} ${fUnit}.`, 'calc', G && G.gci21 * 100 < p.gciTarget ? 'ok' : 'warn');
    K('Min / max element angle (selected)', `${fmt(Q.minAngle, 3)}° / ${fmt(Q.maxAngle, 3)}°`, '', `Max angle controls P1 interpolation error (Babuška–Aziz condition); anisotropic right triangles aligned with the through-thickness gradient are acceptable for conduction. Max aspect ratio ${fmt(Q.maxAR, 3)}, max adjacent area ratio ${fmt(Q.maxAreaRatio, 3)}.`, 'calc', Q.maxAngle <= p.maxAngle ? 'ok' : 'warn');
    K('CAD triangles', tris, '', `${parts.length} closed solids in the assembly.`, 'generated');
    // ---------- verdicts ----------
    V('Watertight CAD', allClosed && allOriented && !negVol ? 'pass' : 'fail', `${parts.length} solids checked for closed, oriented 2-manifold shells with positive volume.`, 'Rebuild the offending part; check zero-thickness dimensions.');
    V('Stroke fits carriage travel', travel >= stroke * 1.1 ? 'pass' : travel >= stroke ? 'warn' : 'fail', `Stroke ${fmt(stroke * 1e3, 3)} mm vs travel ${fmt(travel * 1e3, 3)} mm.`, `Set travel ≥ ${fmt(stroke * 1.2e3, 3)} mm.`);
    V('Cartridge mass factor vs engine record', Math.abs(mCart / (ribMass / N) - design.cartridgeFactor) / design.cartridgeFactor < 0.3 ? 'pass' : 'warn', `CAD cartridge/active ratio ${fmt(mCart / (ribMass / N), 3)} vs assumed ${design.cartridgeFactor}; system ratio ${fmt(mEngine / ribMass, 3)} vs ${design.systemFactor}.`, `Update the engine record (cartridgeFactor ≈ ${fmt(mCart / (ribMass / N), 2)}, systemFactor ≈ ${fmt(mEngine / ribMass, 2)}) so cartridge/system specific power use CAD masses.`);
    V('Mesh selected by explicit criteria', sel.ok ? 'pass' : 'warn', sel.reason, 'Add a refinement level, refine the base sizes or relax the error target.');
    V('Grid convergence in the asymptotic range', G?.exact || G?.inAsymptoticRange ? 'pass' : G?.capped ? 'info' : 'warn', G ? (G.capped ? `Observed order ${fmt(G.pObs, 3)}${G.oscillatory ? ' (oscillatory)' : ''} is outside the theoretical range — changes between levels are below the refinement noise; conservative GCI ${fmt(G.gci21 * 100, 3)} % used.` : `GCI₃₂/(r^p·GCI₂₁) = ${fmt(G.asymptoticRatio, 4)}, p = ${fmt(G.p, 3)}${G.oscillatory ? ' (oscillatory)' : ''}; p from the coarse triplet ${fmt(study.gciCoarse?.p, 3)}.`) : 'fewer than three levels', 'Use more levels or a smaller refinement ratio; ensure the coarsest level resolves the ribbon and channel corners.');
    V('Measured geometry and mass', 'info', 'No CMM or weighing data imported — masses use library densities and nominal dimensions.', 'Import measured part masses/dimensions (Suite 20 or Import mode) to calibrate the mass budget.');
    // ---------- charts ----------
    const compNames = { ribbon: 'SMA ribbons', channelPlate: 'Channel plates', contactLayer: 'Contact layers', grip: 'Grips', carriage: 'Carriages & rods', biasSpring: 'Bias springs', housing: 'Housings', manifold: 'Manifolds & ports', rotor: 'Rotor', shaft: 'Shaft', casing: 'Casing' };
    const comps = Object.keys(perComp).sort((a, b) => perComp[b].mass - perComp[a].mass);
    out.charts.push({ type: 'bar', title: 'Engine dry-mass breakdown by component', categories: comps.map(c => compNames[c] || c), series: [{ name: 'Mass [kg]', values: comps.map(c => perComp[c].mass) }], horizontal: true, y: { label: 'Mass', unit: 'kg' }, explain: `Mass of each component family over the whole engine (library densities × CAD volumes). The active SMA is ${fmt(ribMass / mEngine * 100, 3)} % of the dry mass; the largest contributor (${compNames[comps[0]]}) is where mass reduction pays most for system specific power.` });
    out.charts.push({ type: 'bar', title: 'Clearance & interference margins', categories: cl.map(c => c.item.replace(/\s*\(.*\)/, '')), series: [{ name: 'Available [mm]', values: cl.map(c => c.value * 1e3) }, { name: 'Required [mm]', values: cl.map(c => c.need * 1e3) }], horizontal: true, explain: 'Each design rule compares the available dimension with the required minimum. A required bar longer than the available bar is an interference or rule violation (listed in the verdicts with a fix).' });
    const angBins = 18, hSel = histogram(Array.from(Q.minAngles), angBins, 0, 60), hAlt = histogram(Array.from(altQ.minAngles), angBins, 0, 60);
    out.charts.push({ type: 'bar', title: 'Mesh quality — element minimum-angle distribution', categories: hSel.centers.map(c => fmt(c, 3) + '°'), series: [{ name: `${mesh.kind} (selected, ${mesh.nElems} el.)`, values: hSel.counts.map(v => v / mesh.nElems * 100) }, { name: `${altMesh.kind} (${altMesh.nElems} el.)`, values: hAlt.counts.map(v => v / altMesh.nElems * 100) }], y: { label: 'Elements', unit: '%' }, explain: `Share of elements by their smallest angle. The Delaunay mesh is near-isotropic (most elements 30–60°); the structured mesh uses deliberately stretched right triangles in the thin ribbon and contact layers (min ${fmt(Q.minAngle, 3)}°, max angle 90°), which is acceptable for diffusion because the error is governed by the maximum angle.` });
    const hs = study.levels.map(l => l.h * 1e6), fs = study.levels.map(l => l.value);
    const ann = [{ type: 'hline', y: study.fext, label: `Richardson f_ext = ${fmt(study.fext, 5)}`, color: '#22c55e' }];
    if (G && !G.exact) ann.push({ type: 'band', y0: fs[fs.length - 1] * (1 - G.gci21), y1: fs[fs.length - 1] * (1 + G.gci21), color: '#22c55e', opacity: 0.12 });
    out.charts.push({ type: 'line', title: `Mesh sensitivity — ${fName}`, x: { label: 'Representative cell size h', unit: 'µm', log: true }, y: { label: fName, unit: fUnit }, series: [{ name: `${p.mesher} levels`, x: hs, y: fs, mode: 'lines+markers', labels: study.levels.map(l => 'L' + l.level) }, { name: `${altType} (comparison)`, x: [altQ.hRep * 1e6], y: [altVal], mode: 'markers' }], annotations: ann, explain: `Functional at t* = ${fmt(tStar * 1e3, 4)} ms (fixed time step) on four systematically refined meshes. Monotone approach to the extrapolated value (green line) indicates asymptotic convergence; the shaded band is ± GCI of the finest level. The single point is the other mesher at a comparable size — its distance to the extrapolated value measures mesher dependence.` });
    out.charts.push({ type: 'line', title: 'Cost of refinement', x: { label: 'Elements', log: true }, y: { label: 'Estimated discretisation error', unit: '%', log: true }, series: [{ name: 'error estimate F_s|f−f_ext|/|f_ext|', x: study.levels.map(l => l.nElem), y: study.levels.map(l => Math.max(1e-6, l.errEst * 100)), mode: 'lines+markers', labels: study.levels.map(l => `L${l.level} ${l.ms} ms`) }], annotations: [{ type: 'hline', y: p.gciTarget, label: `target ${p.gciTarget} %`, color: '#f59e0b' }], explain: 'Error estimate against element count (log–log). The slope is −p/2 in 2-D; the selected mesh is the cheapest point below the target line that also meets the quality criteria.' });
    const smp = ML.sampleGrid(mesh, snapMid.T, 160, Math.max(30, Math.round(160 * (sec.ymax - sec.ymin) / sec.W)));
    out.charts.push({ type: 'heatmap', wide: true, title: `Temperature field at t = ${fmt(snapMid.t * 1e3, 4)} ms (heating, selected mesh)`, x: { label: 'x across ribbon width', unit: 'mm', values: smp.xs.map(v => v * 1e3) }, y: { label: 'y from ribbon mid-plane', unit: 'mm', values: smp.ys.map(v => v * 1e3) }, z: smp.z, z_label: '°C', cmap: 'inferno', isolines: 8, equal: true, explain: `Half unit cell: ribbon (bottom ${fmt(t / 2 * 1e6, 3)} µm), contact layer, plate with the coolant channel (blank). Hot fluid at ${Th} °C enters through the channel walls; heat spreads through the web into the ribbon. Isotherms bunching in the contact layer show the interface resistance; lateral variation along the ribbon reveals how far the land between channels shadows the ribbon.` });
    out.charts.push({ type: 'line', title: 'Heating transient on the selected mesh', x: { label: 'Time', unit: 's' }, y: { label: 'Temperature', unit: '°C' }, series: [{ name: 'ribbon mean', x: heat.t, y: heat.stats.ribbon.mean }, { name: 'ribbon min', x: heat.t, y: heat.stats.ribbon.min, dash: '4 3' }, { name: 'ribbon max', x: heat.t, y: heat.stats.ribbon.max, dash: '4 3' }, { name: 'plate mean', x: heat.t, y: heat.stats.wall.mean }], annotations: [{ type: 'vline', x: tStar, label: 't*' }, { type: 'hline', y: Th, label: 'hot fluid' }], explain: `Region temperatures during a step to the hot fluid (constant properties, no latent heat — Suite 08 adds transformation enthalpy). τ = ${fmt(tau * 1e3, 4)} ms; the plate lags the ribbon only slightly because both are fed through the same film resistance, so the plate's heat capacity directly slows the ribbon.` });
    // ---------- tables ----------
    out.tables.push({ title: 'Parts, materials and mass properties (one cartridge + engine-level parts)', cols: ['Part', 'Component', 'Material', 'Count', 'Shell volume [cm³]', 'Solid volume [cm³]', 'Mass each [g]', 'Triangles', 'Closed & oriented'], rows: rows.map(r => [r[0], r[1], r[2], r[3], fmt(r[4], 4), fmt(r[5], 4), fmt(r[6], 4), r[7], r[8]]), explain: 'Solid volume subtracts the channel voids from plates; manifolds are thin-walled (shell area × 1.5 mm). Cartridge parts are listed once with their count.' });
    out.tables.push({ title: 'Clearance and interference report', cols: ['Rule', 'Available [mm]', 'Required [mm]', 'Margin [mm]', 'Status', 'Fix if violated'], rows: cl.map(c => [c.item, fmt(c.value * 1e3, 4), fmt(c.need * 1e3, 4), fmt(c.margin * 1e3, 4), c.pass ? 'pass' : 'FAIL', c.pass ? '' : c.fix]), explain: `Layout: ${N} cartridges at inner radius ${fmt(rInner * 1e3, 4)} mm (${rInnerProv}); cartridge ${fmt(Wout * 1e3, 4)} (tangential) × ${fmt(Hout * 1e3, 4)} (axial) × ${fmt(cartLen * 1e3, 4)} mm (radial).` });
    out.tables.push({ title: 'Mesh-sensitivity levels', cols: ['Level', 'Elements', 'Nodes', 'h [µm]', `Functional [${fUnit}]`, 'Error est. [%]', 'Min angle [°]', 'Max angle [°]', 'Max AR', 'Max area ratio', 'Time [ms]', 'Meets criteria'], rows: study.levels.map((l, i) => [l.level, l.nElem, l.nNode, fmt(l.h * 1e6, 4), fmt(l.value, 7), fmt(l.errEst * 100, 3), fmt(l.quality.minAngle, 3), fmt(l.quality.maxAngle, 4), fmt(l.quality.maxAR, 3), fmt(l.quality.maxAreaRatio, 3), l.ms, sel.rows[i].ok ? '✔' : '✖ ' + Object.entries(sel.rows[i].checks).filter(([, v]) => !v).map(([k]) => k).join(', ')]), explain: `Refinement ratio r = ${fmt(+p.ratio, 4)} in every target size. Error estimate = F_s|f − f_ext|/|f_ext|.` });
    out.tables.push({ title: 'Grid-convergence index (Celik et al. 2008 procedure)', cols: ['Quantity', 'Fine triplet (L' + (study.levels.length - 2) + '–L' + study.levels.length + ')', 'Coarse triplet'], rows: [['Observed order p', fmt(G?.p, 4), fmt(study.gciCoarse?.p, 4)], ['Extrapolated value', fmt(G?.fext, 7), fmt(study.gciCoarse?.fext, 7)], ['GCI₂₁ [%]', fmt((G?.gci21 ?? 0) * 100, 4), fmt((study.gciCoarse?.gci21 ?? 0) * 100, 4)], ['GCI₃₂ [%]', fmt((G?.gci32 ?? 0) * 100, 4), fmt((study.gciCoarse?.gci32 ?? 0) * 100, 4)], ['Asymptotic ratio', fmt(G?.asymptoticRatio, 4), fmt(study.gciCoarse?.asymptoticRatio, 4)], ['Oscillatory', G?.oscillatory ? 'yes' : 'no', study.gciCoarse?.oscillatory ? 'yes' : 'no']], explain: 'Agreement of p between the two triplets confirms the asymptotic range.' });
    out.tables.push({ title: 'Mesher comparison at comparable size', cols: ['Mesher', 'Elements', 'Nodes', 'h [µm]', 'Min angle [°]', 'Max angle [°]', 'Mean skewness', 'Max AR', `Functional [${fUnit}]`, 'Deviation from f_ext [%]'], rows: [[mesh.kind + ' (selected)', mesh.nElems, mesh.nNodes, fmt(Q.hRep * 1e6, 4), fmt(Q.minAngle, 3), fmt(Q.maxAngle, 4), fmt(Q.meanSkew, 3), fmt(Q.maxAR, 3), fmt(chosen.value, 7), fmt(Math.abs(chosen.value - study.fext) / Math.abs(study.fext) * 100, 3)], [altMesh.kind, altMesh.nElems, altMesh.nNodes, fmt(altQ.hRep * 1e6, 4), fmt(altQ.minAngle, 3), fmt(altQ.maxAngle, 4), fmt(altQ.meanSkew, 3), fmt(altQ.maxAR, 3), fmt(altVal, 7), fmt(Math.abs(altVal - study.fext) / Math.abs(study.fext) * 100, 3)]], explain: 'The Delaunay mesh needs many more elements to resolve the thin ribbon isotropically; the graded structured mesh reaches the same accuracy far more cheaply for this layered geometry.' });
    const conv = ['STL', 'STEP', 'OBJ', 'PLY'].map(f => conversionReport(f, cart0));
    out.tables.push({ title: 'Export conversion report (one cartridge)', cols: ['Format', 'Parts', 'Triangles', 'All closed', 'All oriented', 'Preserved', 'Lost'], rows: conv.map(c => [c.format, c.parts, c.triangles, c.allClosed ? 'yes' : 'no', c.allOriented ? 'yes' : 'no', c.preserved.join('; '), c.lost.join('; ')]), explain: 'What each neutral format keeps. The native parametric definition is the suite inputs (project JSON).' });
    // ---------- explanation ----------
    out.explain.push({ title: 'What was generated', text: `${N} radial cartridges, each a stack of ${nRib} ribbons (${fmt(L * 1e3, 4)} × ${fmt(w * 1e3, 3)} mm × ${fmt(t * 1e6, 3)} µm) between ${nPlates} ${p.plate} microchannel plates (${nChPlate} channels of ${fmt(chW * 1e3, 3)} × ${fmt(chH * 1e3, 3)} mm at ${fmt(pitch * 1e3, 4)} mm pitch per plate), with grips, carriage, push rod, bias spring, housing and hot/cold ports, placed at ${fmt(rInner * 1e3, 4)} mm around a ${fmt(rotorR * 1e3, 3)} mm rotor inside a ${fmt(2 * (Rcase + tCase) * 1e3, 4)} mm casing with two manifold rings.` });
    out.explain.push({ title: 'Mass and inertia', text: `Active SMA ${fmt(ribMass, 4)} kg; one cartridge ${fmt(mCart, 4)} kg (×${fmt(mCart / (ribMass / N), 3)} its ribbons); engine dry mass ${fmt(mEngine, 4)} kg (×${fmt(mEngine / ribMass, 3)}). Rotating inertia ${fmt(J, 4)} kg·m². Specific power must be reported on each of these bases separately.` });
    out.explain.push({ title: 'Cross-section meshing', text: `The unit cell is ${fmt(sec.W * 1e3, 4)} mm wide and ${fmt(sec.ymax * 1e3, 4)} mm tall (half thickness). ${sel.reason} The study isolates spatial error by fixing the time step (${fmt(dt * 1e3, 4)} ms) on all levels.` });
    out.explain.push({ title: 'Thermal-mass finding', text: `Per unit cell the plate holds ${fmt(capRatio, 3)}× the sensible heat capacity of the ribbon. In the heating run the plate absorbed ${fmt(heat.regionDH.wall / heat.regionDH.ribbon, 3)}× the ribbon's energy. Any heat stored in the plates each cycle must be regenerated (Suite 09) or it is lost to the cold sink.` });
    // ---------- recommendations ----------
    if (capRatio > 2) out.recs.push({ level: 'warn', text: `The plate metal stores ${fmt(capRatio, 3)}× the ribbon's sensible heat per cycle. Thinner webs, fewer/larger channels, a lower-ρc_p plate (e.g. polymer-composite frame with thin metal skin) or more ribbons per plate would cut parasitic heat; regenerating the plate heat is essential otherwise.`, basis: `unit-cell areas: ribbon ${fmt(sec.areas.ribbon * 1e6, 4)} mm², plate ${fmt(sec.areas.wall * 1e6, 4)} mm²; ρc_p ribbon ${fmt(alloy.rho * alloy.cp / 1e6, 3)}, plate ${fmt(pm.rho * pm.cp / 1e6, 3)} MJ/m³K` });
    if (!cl.every(c => c.pass)) out.recs.push({ level: 'critical', text: `Resolve ${cl.filter(c => !c.pass).length} clearance violation(s) before manufacturing: ${cl.filter(c => !c.pass).map(c => c.item).join('; ')}.`, basis: 'clearance report' });
    else out.recs.push({ level: 'good', text: `All ${cl.length} layout rules satisfied; smallest margin ${fmt(minMargin * 1e3, 3)} mm on “${worst.item}”. Re-check after any change of ribbon length (stroke) or cell count.`, basis: 'clearance report' });
    out.recs.push({ level: 'info', text: `Use the level-${chosen.level} ${mesh.kind} mesh (${chosen.nElem} elements, h ≈ ${fmt(chosen.h * 1e6, 3)} µm) for Suite 08 transient studies; its estimated discretisation error is ${fmt(chosen.errEst * 100, 3)} %.`, basis: `GCI ${fmt((G?.gci21 ?? 0) * 100, 3)} %, p = ${fmt(G?.p, 3)}` });
    if (Math.abs(mCart / (ribMass / N) - design.cartridgeFactor) / design.cartridgeFactor > 0.3) out.recs.push({ level: 'warn', text: `The engine record assumes cartridge mass = ${design.cartridgeFactor}× active mass but the CAD gives ${fmt(mCart / (ribMass / N), 3)}×. Update cartridgeFactor so cartridge-basis specific power in Suites 01/18 is not mis-stated.`, basis: `CAD cartridge ${fmt(mCart * 1e3, 4)} g, ribbons ${fmt(ribMass / N * 1e3, 4)} g` });
    out.recs.push({ level: 'econ', text: `Raw-material cost ≈ ${fmt(cost, 4)} USD for the engine (SMA ${fmt(perComp.ribbon.cost, 4)} USD = ${fmt(perComp.ribbon.cost / cost * 100, 3)} %). ${perComp.ribbon.cost / cost > 0.5 ? 'The SMA dominates: thinner ribbons with faster cycling buy more power per dollar than more ribbons.' : 'Structural/heat-exchange parts dominate: simplify plates and housings (extrusions, stamped plates) before reducing SMA.'}`, basis: 'library cost per kg × CAD mass (excludes machining and assembly — Suite 20/22)' });
    const topCo2 = Object.entries(perComp).sort((a, b) => b[1].co2 - a[1].co2)[0];
    out.recs.push({ level: 'sustain', text: `Embodied CO₂e of the materials ≈ ${fmt(co2, 4)} kg (largest: ${compNames[topCo2[0]] || topCo2[0]}, ${fmt(topCo2[1].co2, 4)} kg). Design the cartridges for disassembly so the NiTi (≈ ${fmt(perComp.ribbon.co2, 3)} kg CO₂e) can be recovered and re-melted.`, basis: 'library cradle-to-gate factors × CAD masses' });
    // ---------- views ----------
    out.views.push({ label: '3-D engine assembly', icon: '🧊', render: async (el) => {
      const { viewer } = await import('../core/viz3d.js'); const v = await viewer(el, { grid: false, height: 520 }); for (const m of parts) v.add(m); v.fit();
      el.append(Object.assign(document.createElement('p'), { className: 'small muted', textContent: `${parts.length} closed solids, ${tris} triangles. Use Explode for an exploded view, Section to cut at y = 0, X-ray to see the ribbon stacks inside the housings. Red/blue rings are the hot/cold manifolds.` }));
    } });
    out.views.push({ label: 'Cartridge (exploded)', icon: '🧵', render: async (el) => {
      const { viewer } = await import('../core/viz3d.js'); const v = await viewer(el, { grid: false, height: 460 }); const c = buildCartridge(g); for (const m of c.parts) v.add(m); v.fit();
      el.append(Object.assign(document.createElement('p'), { className: 'small muted', textContent: 'Single cartridge in local coordinates (x radial along the ribbons, y across the width, z through the stack). Press Explode to separate grips, carriage, spring, plates and housing.' }));
    } });
    let dwgCache = null; const drawing = () => (dwgCache ||= engineeringDrawing(buildCartridge(g).parts, { title: 'THERMA-X100 thermal-muscle cartridge', dwgNo: p.dwgNo, scale: 'NTS', material: `${alloy.name}; plates ${pm.name}`, dims: [] }));
    out.views.push({ label: 'Drawings', icon: '📐', render: (el) => { const d = drawing(); el.innerHTML = `<div style="background:#fff;border-radius:8px;overflow:auto">${d.svg}</div><div style="margin-top:12px">${sectionSVG(sec, g)}</div>`; } });
    out.views.push({ label: 'Mesh', icon: '🕸', render: (el) => { el.innerHTML = `<p class="small muted">Selected ${mesh.kind} mesh (half unit cell, symmetry at the bottom = ribbon mid-plane; channel walls in blue).</p>${ML.meshSVG(mesh)}<p class="small muted" style="margin-top:10px">${altMesh.kind} mesh at a comparable nominal size.</p>${ML.meshSVG(altMesh)}`; } });
    out.views.push({ label: 'Heating animation', icon: '🎞', render: (el) => anim2d(el, { duration: heat.t[heat.t.length - 1], label: 'Time', unit: 's', height: (W) => W < 640 ? 760 : 440, explain: 'Temperature field of the unit cell (mirrored about the ribbon mid-plane) after the channels switch to hot fluid, with the region temperatures on the right.', draw(gx, tt, W, H) {
      const th = theme(), sn = heat.snaps.reduce((a, b) => (Math.abs(b.t - tt) < Math.abs(a.t - tt) ? b : a)), col = (u) => cssColor(cmap(u, 'inferno')), narrow = W < 640, z = fontPx(W);
      const fw = narrow ? W - 20 : W * 0.55, yT = para(gx, `t = ${fmt(sn.t * 1e3, 4)} ms · ribbon centre (bronze band) between plates · channels blank`, 12, 8 + z, fw, { size: z, maxLines: 2 });
      const fy = yT + 2, fh = narrow ? 300 : H - fy - 44;
      ML.paintField(gx, mesh, sn.T, { x: 10, y: fy, w: fw, h: fh, lo: Tc, hi: Th, color: col, mirror: true });
      const cbW = Math.min(200, fw - 20), cy = fy + fh + 8; for (let k = 0; k <= 50; k++) { gx.fillStyle = col(k / 50); gx.fillRect(14 + k * cbW / 51, cy, cbW / 51 + 0.5, 10); }
      label(gx, `${Tc} °C`, 14, cy + 13, { baseline: 'top', size: z - 1, color: th.mute }); label(gx, `${Th} °C`, 14 + cbW, cy + 13, { align: 'right', baseline: 'top', size: z - 1, color: th.mute });
      const px = narrow ? 10 : W * 0.58, py = narrow ? cy + 34 : 12;
      seriesPanel(gx, { x: px, y: py, w: narrow ? W - 20 : W * 0.4, h: H - py - 12, T: heat.t, t: tt, title: 'Region temperatures', unit: '°C', series: [{ name: 'ribbon mean', y: heat.stats.ribbon.mean, color: '#f59e0b' }, { name: 'plate mean', y: heat.stats.wall.mean, color: '#94a3b8' }, { name: 'ribbon min', y: heat.stats.ribbon.min, color: '#ef4444' }], hlines: [{ y: Th, label: 'hot fluid', color: '#ef4444' }] });
    } }) });
    // ---------- exports ----------
    const T_node = heat.T, sel3 = cart0;
    out.exports.push(
      { label: 'Engine STL', action: () => download(toSTL(parts, 'engine'), 'therma-engine.stl') },
      { label: 'Engine STEP (faceted)', action: () => download(new Blob([toSTEP(parts, 'THERMAX100_ENGINE')], { type: 'application/step' }), 'therma-engine.step') },
      { label: 'Engine OBJ', action: () => download(new Blob([toOBJ(parts)], { type: 'text/plain' }), 'therma-engine.obj') },
      { label: 'Cartridge PLY', action: () => download(new Blob([toPLY(sel3)], { type: 'text/plain' }), 'therma-cartridge.ply') },
      { label: 'Cartridge drawing DXF', action: () => download(new Blob([drawing().dxf], { type: 'application/dxf' }), 'therma-cartridge.dxf') },
      { label: 'Cartridge drawing SVG', action: () => download(new Blob([drawing().svg], { type: 'image/svg+xml' }), 'therma-cartridge.svg') },
      { label: 'Section drawing SVG', action: () => download(new Blob([sectionSVG(sec, g)], { type: 'image/svg+xml' }), 'therma-section.svg') },
      { label: 'Mesh MSH 2.2', action: () => download(new Blob([ML.toMSH(mesh)], { type: 'text/plain' }), 'therma-section.msh') },
      { label: 'Mesh VTK (+T)', action: () => download(new Blob([ML.toVTK(mesh, { point: { T_C: T_node } })], { type: 'text/plain' }), 'therma-section.vtk') },
      { label: 'Mesh CSV (zip)', action: async () => { const c = ML.toCSV(mesh, { point: { T_C: T_node } }); download(await zip([{ name: 'nodes.csv', data: c.nodes }, { name: 'elements.csv', data: c.elements }, { name: 'boundary.csv', data: c.boundary }]), 'therma-section-csv.zip'); } },
      { label: 'All CAD + mesh (zip)', action: async () => { const c = ML.toCSV(mesh); download(await zip([{ name: 'engine.stl', data: new Uint8Array(await toSTL(parts).arrayBuffer()) }, { name: 'engine.step', data: toSTEP(parts) }, { name: 'cartridge.obj', data: toOBJ(sel3) }, { name: 'cartridge.dxf', data: drawing().dxf }, { name: 'cartridge.svg', data: drawing().svg }, { name: 'section.svg', data: sectionSVG(sec, g) }, { name: 'section.msh', data: ML.toMSH(mesh) }, { name: 'section.vtk', data: ML.toVTK(mesh, { point: { T_C: T_node } }) }, { name: 'nodes.csv', data: c.nodes }, { name: 'elements.csv', data: c.elements }]), 'therma-cad-mesh.zip'); } },
    );
    // ---------- outputs & headline ----------
    out.outputs = {
      ribbonVolume_m3: ribVol, ribbonMass_kg: ribMass, cartridgeMass_kg: mCart, rotorInertia_kgm2: J, engineMass_kg: mEngine,
      envelope: { D: 2 * (Rcase + tCase), L: Lcase + 2 * tCase }, mesh: { nodes: mesh.nNodes, elements: mesh.nElems, minQuality: Q.minScaledJacobian, minAngle: Q.minAngle, maxAngle: Q.maxAngle, hRep: Q.hRep, kind: mesh.kind },
      gci: G?.gci21 ?? 0, selectedLevel: chosen.level, observedOrder: G?.p ?? null, meshRefine: chosen.f, meshSizes: sizes, mesher: mesh.kind,
      section: { pitch, web, tc, skin, chW, chH, plate: p.plate, nChPlate, nPlates, tPlate, plateGap: g.plateGap }, stroke_m: stroke, heatCapacityRatio: capRatio,
      coolantVolume_m3: fluidVol, materialCost_USD: cost, co2_kg: co2, rInner_m: rInner, cartridgeFactor: mCart / (ribMass / N), systemFactor: mEngine / ribMass,
    };
    const ok = allClosed && cl.every(c => c.pass);
    out.headline = `${N}-cartridge engine: ${fmt(mEngine, 3)} kg dry (${fmt(ribMass, 3)} kg SMA), Ø${fmt(2 * (Rcase + tCase) * 1e3, 3)} mm, J = ${fmt(J, 3)} kg·m²; ${ok ? 'watertight, all clearances met' : 'layout violations found'}; mesh L${chosen.level} (${chosen.nElem} el.) GCI ${fmt((G?.gci21 ?? 0) * 100, 2)} %.`;
    out.headlineKind = ok && sel.ok ? 'ok' : 'warn';
    out.credibility = 'Numerically verified';
    return out;
  },
};
