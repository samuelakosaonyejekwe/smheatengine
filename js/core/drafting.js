// Engineering drafting engine for the THERMA-X100 dossier: ISO 5457 A3 sheets with border, zone references and an
// ISO 7200 title block; third-angle orthographic views (ISO 128 / ISO 5456-2) with hidden-line removal by depth-sorted
// face painting; isometric and exploded isometric pictorials with balloons (ISO 6433) and parts lists (ISO 7573);
// linear and diameter dimensions (ISO 129-1); hatched section details (ISO 128-50); DXF export of the views.
// Geometry: cad.js Mesh objects in metres. Sheet units: millimetres, y downwards (SVG).

export const SHEET = { W: 420, H: 297, left: 20, right: 10, top: 10, bottom: 10, tbW: 180, tbH: 56 };
export const SCALES = [[50, 1], [20, 1], [10, 1], [5, 1], [2, 1], [1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100]];
export const scaleLabel = (s) => (s >= 1 ? `${Math.round(s)}:1` : `1:${Math.round(1 / s)}`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f2 = (v) => (Math.round(v * 100) / 100).toString();
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// View directions (f = direction the viewer looks along). Third-angle: TOP above FRONT, RIGHT to the right of FRONT.
export const VIEWS = {
  front: { f: [0, 1, 0], up: [0, 0, 1], label: 'FRONT VIEW' },
  top: { f: [0, 0, -1], up: [0, 1, 0], label: 'TOP VIEW' },
  right: { f: [-1, 0, 0], up: [0, 0, 1], label: 'RIGHT SIDE VIEW' },
  iso: { f: norm([-1, 1, -1]), up: [0, 0, 1], label: 'ISOMETRIC VIEW' },
  isoRear: { f: norm([1, -1, -1]), up: [0, 0, 1], label: 'ISOMETRIC VIEW (REAR)' },
};
export function camera(view) { const v = typeof view === 'string' ? VIEWS[view] : view; const f = norm(v.f), r = norm(cross(f, v.up)), u = cross(r, f); return { f, r, u, label: v.label }; }

// ---------------- hidden-line rendering (depth-sorted faces + feature/silhouette edges) ----------------
// parts: [{mesh, color, offset:[dx,dy,dz] (explode), id}] → draw list in model metres (screen x right, y up)
export function renderView(parts, view, { shade = false, crease = 0.82, light = norm([0.4, -0.6, 0.7]) } = {}) {
  const cam = camera(view), tris = [], edges = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [pi, pt] of parts.entries()) {
    const m = pt.mesh, P = m.p, I = m.i, o = pt.offset || [0, 0, 0], nv = P.length / 3;
    const sx = new Float64Array(nv), sy = new Float64Array(nv), sd = new Float64Array(nv);
    for (let k = 0; k < nv; k++) { const p = [P[3 * k] + o[0], P[3 * k + 1] + o[1], P[3 * k + 2] + o[2]]; sx[k] = dot(p, cam.r); sy[k] = dot(p, cam.u); sd[k] = dot(p, cam.f); if (sx[k] < x0) x0 = sx[k]; if (sx[k] > x1) x1 = sx[k]; if (sy[k] < y0) y0 = sy[k]; if (sy[k] > y1) y1 = sy[k]; }
    const nt = I.length / 3, N = new Array(nt), front = new Uint8Array(nt), E = new Map();
    for (let t = 0; t < nt; t++) {
      const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
      const n = norm(cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]));
      N[t] = n; front[t] = dot(n, cam.f) < -1e-9 ? 1 : 0;
      for (let e = 0; e < 3; e++) { const va = I[3 * t + e], vb = I[3 * t + (e + 1) % 3], key = va < vb ? va * 1e7 + vb : vb * 1e7 + va, rec = E.get(key); if (rec) rec.push(t); else E.set(key, [va, vb, t]); }
    }
    const triEdges = new Map();
    for (const rec of E.values()) {
      const [va, vb, ta, tb] = rec, both = tb !== undefined;
      const feat = !both || front[ta] !== front[tb] || dot(N[ta], N[tb]) < crease;
      if (!feat) continue;
      const seg = [sx[va], sy[va], sx[vb], sy[vb]];
      for (const t of both ? [ta, tb] : [ta]) if (front[t]) { if (!triEdges.has(t)) triEdges.set(t, []); triEdges.get(t).push(seg); }
    }
    const base = hexRgb(pt.color || m.color || '#9aa4b2');
    for (let t = 0; t < nt; t++) {
      if (!front[t]) continue;
      const a = I[3 * t], b = I[3 * t + 1], c = I[3 * t + 2];
      let fill = '#ffffff';
      if (shade) { const lam = Math.max(0, dot(N[t], light)), k = 0.42 + 0.58 * lam; fill = `rgb(${Math.round(base[0] * k)},${Math.round(base[1] * k)},${Math.round(base[2] * k)})`; }
      tris.push({ d: (sd[a] + sd[b] + sd[c]) / 3, pts: [sx[a], sy[a], sx[b], sy[b], sx[c], sy[c]], fill, edges: triEdges.get(t) || [], part: pi });
    }
    for (const rec of E.values()) if (rec[3] !== undefined && front[rec[2]] !== front[rec[3]]) edges.push([sx[rec[0]], sy[rec[0]], sx[rec[1]], sy[rec[1]]]);
  }
  tris.sort((p, q) => q.d - p.d);
  return { tris, bbox: { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }, cam, silhouettes: edges };
}
function hexRgb(c) { if (c.startsWith('rgb')) return c.match(/\d+/g).slice(0, 3).map(Number); const h = c.replace('#', ''); const v = h.length === 3 ? h.split('').map(x => x + x).join('') : h; return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]; }

// Place a rendered view on the sheet: scale s (sheet mm per model mm) with the view's lower-left bbox corner at (x, y) sheet
export function placeView(rv, s, cx, cy) {
  const k = s * 1000, b = rv.bbox, ox = cx - (b.x0 + b.w / 2) * k, oy = cy + (b.y0 + b.h / 2) * k;
  return { X: (x) => ox + x * k, Y: (y) => oy - y * k, k, box: { x0: cx - b.w * k / 2, x1: cx + b.w * k / 2, y0: cy - b.h * k / 2, y1: cy + b.h * k / 2 } };
}
// SVG for a placed view (vector), or raster <image> when the face count is large
export function viewSVG(rv, T, { lw = 0.35, raster = 'auto', px = 7 } = {}) {
  const useRaster = raster === true || (raster === 'auto' && rv.tris.length > 4500 && typeof document !== 'undefined');
  if (useRaster) {
    const bx = T.box, W = Math.max(8, Math.ceil((bx.x1 - bx.x0 + 4) * px)), H = Math.max(8, Math.ceil((bx.y1 - bx.y0 + 4) * px));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    const X = (x) => (T.X(x) - bx.x0 + 2) * px, Y = (y) => (T.Y(y) - bx.y0 + 2) * px; g.lineJoin = 'round'; g.lineCap = 'round';
    for (const t of rv.tris) { const p = t.pts; g.beginPath(); g.moveTo(X(p[0]), Y(p[1])); g.lineTo(X(p[2]), Y(p[3])); g.lineTo(X(p[4]), Y(p[5])); g.closePath(); g.fillStyle = t.fill; g.strokeStyle = t.fill; g.lineWidth = 0.6; g.fill(); g.stroke(); if (t.edges.length) { g.strokeStyle = '#111'; g.lineWidth = lw * px; g.beginPath(); for (const e of t.edges) { g.moveTo(X(e[0]), Y(e[1])); g.lineTo(X(e[2]), Y(e[3])); } g.stroke(); } }
    return `<image x="${f2(bx.x0 - 2)}" y="${f2(bx.y0 - 2)}" width="${f2(W / px)}" height="${f2(H / px)}" href="${cv.toDataURL('image/png')}"/>`;
  }
  let s = '<g stroke-linejoin="round" stroke-linecap="round">';
  for (const t of rv.tris) {
    const p = t.pts; s += `<polygon points="${f2(T.X(p[0]))},${f2(T.Y(p[1]))} ${f2(T.X(p[2]))},${f2(T.Y(p[3]))} ${f2(T.X(p[4]))},${f2(T.Y(p[5]))}" fill="${t.fill}" stroke="${t.fill}" stroke-width="0.12"/>`;
    if (t.edges.length) s += `<path d="${t.edges.map(e => `M${f2(T.X(e[0]))} ${f2(T.Y(e[1]))}L${f2(T.X(e[2]))} ${f2(T.Y(e[3]))}`).join('')}" stroke="#111" stroke-width="${lw}" fill="none"/>`;
  }
  return s + '</g>';
}

// ---------------- dimensions, notes, symbols ----------------
const ARROW = 2.6, TXT = 3.2;
function arrowHead(x, y, ang) { const a1 = ang + 0.32, a2 = ang - 0.32; return `<path d="M${f2(x)} ${f2(y)}L${f2(x - ARROW * Math.cos(a1))} ${f2(y - ARROW * Math.sin(a1))}L${f2(x - ARROW * Math.cos(a2))} ${f2(y - ARROW * Math.sin(a2))}Z" fill="#111" stroke="none"/>`; }
// Linear dimension between sheet points a and b; dir 'h' (horizontal measure, line offset vertically) or 'v'
export function dimLinear(a, b, dir, off, text) {
  let s = '<g stroke="#111" stroke-width="0.18" fill="none">';
  if (dir === 'h') {
    const y = (off < 0 ? Math.min(a[1], b[1]) : Math.max(a[1], b[1])) + off, sg = Math.sign(off) || 1;
    s += `<path d="M${f2(a[0])} ${f2(a[1] + sg * 1)}V${f2(y + sg * 1.6)}M${f2(b[0])} ${f2(b[1] + sg * 1)}V${f2(y + sg * 1.6)}M${f2(a[0])} ${f2(y)}H${f2(b[0])}"/>`;
    const L = Math.abs(b[0] - a[0]), inside = L > 2 * ARROW + 1;
    s += arrowHead(Math.min(a[0], b[0]), y, inside ? Math.PI : 0) + arrowHead(Math.max(a[0], b[0]), y, inside ? 0 : Math.PI);
    const tw = String(text).length * TXT * 0.56 + 2, fits = L > tw;
    if (!inside) s += `<path d="M${f2(Math.max(a[0], b[0]))} ${f2(y)}H${f2(Math.max(a[0], b[0]) + ARROW + 2 + (fits ? 0 : tw))}M${f2(Math.min(a[0], b[0]))} ${f2(y)}H${f2(Math.min(a[0], b[0]) - ARROW - 2)}"/>`;
    s += `</g><text x="${f2(fits ? (a[0] + b[0]) / 2 : Math.max(a[0], b[0]) + ARROW + 2.5)}" y="${f2(y - 0.9)}" font-size="${TXT}" text-anchor="${fits ? 'middle' : 'start'}">${esc(text)}</text>`;
  } else {
    const x = (off < 0 ? Math.min(a[0], b[0]) : Math.max(a[0], b[0])) + off, sg = Math.sign(off) || 1;
    s += `<path d="M${f2(a[0] + sg * 1)} ${f2(a[1])}H${f2(x + sg * 1.6)}M${f2(b[0] + sg * 1)} ${f2(b[1])}H${f2(x + sg * 1.6)}M${f2(x)} ${f2(a[1])}V${f2(b[1])}"/>`;
    const L = Math.abs(b[1] - a[1]), inside = L > 2 * ARROW + 1;
    s += arrowHead(x, Math.min(a[1], b[1]), inside ? -Math.PI / 2 : Math.PI / 2) + arrowHead(x, Math.max(a[1], b[1]), inside ? Math.PI / 2 : -Math.PI / 2);
    const tw = String(text).length * TXT * 0.56 + 2, fits = L > tw, yb = Math.max(a[1], b[1]), yt = Math.min(a[1], b[1]);
    if (!inside) s += `<path d="M${f2(x)} ${f2(yt)}V${f2(yt - ARROW - 2 - (fits ? 0 : tw))}M${f2(x)} ${f2(yb)}V${f2(yb + ARROW + 2)}"/>`;
    const ty2 = fits ? (a[1] + b[1]) / 2 : yt - ARROW - 2.5;
    s += `</g><text x="${f2(x - 0.9)}" y="${f2(ty2)}" font-size="${TXT}" text-anchor="${fits ? 'middle' : 'start'}" transform="rotate(-90 ${f2(x - 0.9)} ${f2(ty2)})">${esc(text)}</text>`;
  }
  return s;
}
export const mm = (v_m, d = 2) => { const x = v_m * 1000; return Math.abs(x) >= 100 ? x.toFixed(Math.max(0, d - 2)) : Math.abs(x) >= 10 ? x.toFixed(Math.max(0, d - 1)) : x.toFixed(d); };
// Overall dimensions of a placed view (width below, height to the left)
export function overallDims(rv, T, { w = true, hgt = true } = {}) {
  const b = T.box; let s = '';
  if (w) s += dimLinear([b.x0, b.y1], [b.x1, b.y1], 'h', 7, mm(rv.bbox.w));
  if (hgt) s += dimLinear([b.x0, b.y0], [b.x0, b.y1], 'v', -7, mm(rv.bbox.h));
  return s;
}
export function leader(from, to, text, { anchor = 'start' } = {}) { const ang = Math.atan2(from[1] - to[1], from[0] - to[0]); return `<g stroke="#111" stroke-width="0.18" fill="none"><path d="M${f2(from[0])} ${f2(from[1])}L${f2(to[0])} ${f2(to[1])}H${f2(to[0] + (anchor === 'end' ? -6 : 6))}"/></g>${arrowHead(from[0], from[1], ang)}<text x="${f2(to[0] + (anchor === 'end' ? -7 : 7))}" y="${f2(to[1] + 1.1)}" font-size="${TXT}" text-anchor="${anchor}">${esc(text)}</text>`; }
export function centreMark(x, y, r) { return `<path d="M${f2(x - r - 2)} ${f2(y)}H${f2(x + r + 2)}M${f2(x)} ${f2(y - r - 2)}V${f2(y + r + 2)}" stroke="#111" stroke-width="0.13" stroke-dasharray="6 1.5 1 1.5" fill="none"/>`; }
export function viewLabel(T, text, sub) { const b = T.box; return `<text x="${f2((b.x0 + b.x1) / 2)}" y="${f2(b.y1 + 16)}" font-size="3.5" font-weight="700" text-anchor="middle">${esc(text)}</text>${sub ? `<text x="${f2((b.x0 + b.x1) / 2)}" y="${f2(b.y1 + 20.5)}" font-size="2.6" text-anchor="middle">${esc(sub)}</text>` : ''}`; }
// Balloon with leader to a target (sheet coords)
export function balloon(n, at, target) { return `<g stroke="#111" stroke-width="0.2"><line x1="${f2(at[0])}" y1="${f2(at[1])}" x2="${f2(target[0])}" y2="${f2(target[1])}"/><circle cx="${f2(target[0])}" cy="${f2(target[1])}" r="0.7" fill="#111"/><circle cx="${f2(at[0])}" cy="${f2(at[1])}" r="4" fill="#fff"/></g><text x="${f2(at[0])}" y="${f2(at[1] + 1.25)}" font-size="3.4" font-weight="700" text-anchor="middle">${n}</text>`; }
// Hatch pattern definition and hatched rectangles for section details
export const HATCH_DEFS = `<pattern id="hatch" patternUnits="userSpaceOnUse" width="1.6" height="1.6" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="1.6" stroke="#111" stroke-width="0.18"/></pattern><pattern id="hatch2" patternUnits="userSpaceOnUse" width="1.6" height="1.6" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="1.6" stroke="#111" stroke-width="0.18"/></pattern><pattern id="hatchX" patternUnits="userSpaceOnUse" width="1.2" height="1.2" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="1.2" stroke="#7c2d12" stroke-width="0.22"/></pattern>`;

// ---------------- sheet frame and title block (ISO 5457 / ISO 7200) ----------------
export function sheet({ title, dwgNo, rev = 'A', scale = '', sheetNo = 1, sheets = 1, material = '', mass = '', qty = '', project = 'THERMA-X100', author = '', status = 'PRELIMINARY — RESEARCH USE', date = new Date().toISOString().slice(0, 10), tol = 'ISO 2768-mK', finish = 'Ra 1.6 unless stated', notes = [] }, body) {
  const { W, H, left, right, top, bottom, tbW, tbH } = SHEET, x0 = left, y0 = top, x1 = W - right, y1 = H - bottom, tx = x1 - tbW, ty = y1 - tbH;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" font-family="Arial, Helvetica, sans-serif" class="dwg-sheet"><defs>${HATCH_DEFS}</defs><rect width="${W}" height="${H}" fill="#fff"/>`;
  s += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="#111" stroke-width="0.7"/>`;
  // zone references (8 × 6) and centring marks
  const zx = (x1 - x0) / 8, zy = (y1 - y0) / 6; s += '<g font-size="2.5" fill="#555" text-anchor="middle">';
  for (let i = 0; i < 8; i++) { const cx = x0 + zx * (i + 0.5); s += `<text x="${f2(cx)}" y="${f2(y0 - 2.2)}">${i + 1}</text><text x="${f2(cx)}" y="${f2(y1 + 4.4)}">${i + 1}</text>`; if (i) s += `<path d="M${f2(x0 + zx * i)} ${y0 - 4}V${y0}M${f2(x0 + zx * i)} ${y1}V${y1 + 4}" stroke="#555" stroke-width="0.2"/>`; }
  for (let j = 0; j < 6; j++) { const cy = y0 + zy * (j + 0.5), L = 'ABCDEF'[j]; s += `<text x="${f2(x0 - 3)}" y="${f2(cy + 1)}">${L}</text><text x="${f2(x1 + 3)}" y="${f2(cy + 1)}">${L}</text>`; if (j) s += `<path d="M${x0 - 4} ${f2(y0 + zy * j)}H${x0}M${x1} ${f2(y0 + zy * j)}H${x1 + 4}" stroke="#555" stroke-width="0.2"/>`; }
  s += `</g><path d="M${W / 2} 0V${y0}M${W / 2} ${y1}V${H}M0 ${H / 2}H${x0}M${x1} ${H / 2}H${W}" stroke="#111" stroke-width="0.7"/>`;
  s += body;
  // general notes block (above title block)
  if (notes.length) { const lines = notes.flatMap((n, i) => wrapText(`${i + 1}. ${n}`, 128)), nh = 5 + lines.length * 3.9; s += `<g font-size="2.7"><text x="${tx}" y="${f2(ty - nh + 1)}" font-weight="700" font-size="3">NOTES</text>${lines.map((l, i) => `<text x="${tx}" y="${f2(ty - nh + 5.5 + i * 3.9)}">${esc(l)}</text>`).join('')}</g>`; }
  // title block
  const R = (x, y, w, h) => `<rect x="${f2(x)}" y="${f2(y)}" width="${f2(w)}" height="${f2(h)}" fill="none" stroke="#111" stroke-width="0.35"/>`;
  const fit = (v, w, size) => { const t = String(v ?? ''), max = Math.max(4, Math.floor((w - 2.4) / (size * 0.52))); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
  const T = (x, y, label, val, size = 3, bold = false, w = 180) => `<text x="${f2(x + 1.2)}" y="${f2(y + 3)}" font-size="1.9" fill="#555">${esc(label)}</text><text x="${f2(x + 1.2)}" y="${f2(y + 7.6)}" font-size="${size}"${bold ? ' font-weight="700"' : ''}>${esc(fit(val, w, size))}</text>`;
  s += `<rect x="${tx}" y="${ty}" width="${tbW}" height="${tbH}" fill="#fff" stroke="#111" stroke-width="0.7"/>`;
  s += R(tx, ty, 110, 18) + T(tx, ty, 'TITLE', title, title.length > 46 ? 2.6 : 3.4, true, 110) + `<text x="${f2(tx + 1.2)}" y="${f2(ty + 14.6)}" font-size="2.6">${esc(project)}</text>`;
  s += R(tx + 110, ty, 70, 18) + T(tx + 110, ty, 'DRAWING No.', dwgNo, 3.6, true, 70) + `<text x="${f2(tx + 111.2)}" y="${f2(ty + 15)}" font-size="2.4">REV ${esc(rev)} · SHEET ${sheetNo} OF ${sheets}</text>`;
  const row = (y, cells) => { let x = tx, out = ''; for (const [w, l, v] of cells) { out += R(x, y, w, 9.5) + T(x, y - 0.4, l, v, 2.6, false, w); x += w; } return out; };
  s += row(ty + 18, [[45, 'MATERIAL', material], [30, 'MASS', mass], [20, 'QTY', qty], [25, 'SCALE', scale], [60, 'STATUS', status]]);
  s += row(ty + 27.5, [[45, 'GENERAL TOLERANCES', tol], [50, 'SURFACE FINISH', finish], [25, 'UNITS', 'mm'], [60, 'DIMENSIONS', 'From the parametric model of this dossier revision']]);
  s += row(ty + 37, [[45, 'DRAWN', author || 'Dossier generator'], [30, 'DATE', date], [35, 'CHECKED', '—'], [35, 'APPROVED', '—'], [35, 'PROJECTION', 'Third angle']]);
  // third-angle projection symbol (ISO 128-30)
  const px = tx + 160, py = ty + 47.7; s += `<g stroke="#111" stroke-width="0.3" fill="none" transform="translate(${px - 14},${py})"><path d="M0 1.2L8 0V6L0 4.8Z"/><circle cx="14.5" cy="3" r="3"/><circle cx="14.5" cy="3" r="1.3"/><path d="M-1.5 3H20" stroke-dasharray="3 0.8 0.5 0.8" stroke-width="0.15"/></g>`;
  s += `<text x="${f2(tx + 1.2)}" y="${f2(ty + 51)}" font-size="2.1" fill="#444">Do not scale drawing · Generated from the THERMA-X100 parametric model · Predictions are not validated test evidence</text>`;
  return s + '</svg>';
}

export function wrapText(t, max) { const out = []; let line = ''; for (const w of String(t).split(' ')) { if ((line + ' ' + w).trim().length > max) { out.push(line); line = '   ' + w; } else line = line ? line + ' ' + w : w; } if (line) out.push(line); return out; }
export const notesHeight = (notes = []) => notes.length ? 7 + notes.flatMap((n, i) => wrapText(`${i + 1}. ${n}`, 128)).length * 3.9 : 0;
// Centre lines of a round feature with axis a ('x'|'y'|'z') in a placed orthographic view
export function centreLines(rv, T, axis) {
  const f = rv.cam.f, ax = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis]; if (!ax) return '';
  const b = T.box, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, st = 'stroke="#111" stroke-width="0.15" stroke-dasharray="7 1.5 1.2 1.5" fill="none"';
  if (Math.abs(dot(f, ax)) > 0.9) return `<path d="M${f2(b.x0 - 3)} ${f2(cy)}H${f2(b.x1 + 3)}M${f2(cx)} ${f2(b.y0 - 3)}V${f2(b.y1 + 3)}" ${st}/>`;
  const sx = dot(ax, rv.cam.r); return Math.abs(sx) > 0.9 ? `<path d="M${f2(b.x0 - 4)} ${f2(cy)}H${f2(b.x1 + 4)}" ${st}/>` : `<path d="M${f2(cx)} ${f2(b.y0 - 4)}V${f2(b.y1 + 4)}" ${st}/>`;
}

// Pictorial (isometric / exploded) views are scaled to fill their region and labelled as pictorial
export const fitScale = (w, hgt, W, H) => 0.96 * Math.min(W / (w * 1000), H / (hgt * 1000));
export const pictorialLabel = (s) => `PICTORIAL ≈ ${s >= 1 ? fmtR(s) + ':1' : '1:' + fmtR(1 / s)}`;
const fmtR = (v) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10).toString();
// Choose the largest standard scale so that a set of view sizes (model metres) fits the region (sheet mm)
export function pickScale(fits) { for (const [a, b] of SCALES) { const s = a / b; if (fits.every(([w, hgt, W, H]) => w * 1000 * s <= W && hgt * 1000 * s <= H)) return s; } return 1 / 200; }

// ---------------- standard sheet layouts ----------------
// Part / sub-assembly detail sheet: FRONT, TOP, RIGHT (third angle) + ISOMETRIC + optional detail SVG + key-dimension table
export function partSheet({ parts, meta, keyDims = [], detail = null, isoShade = true, dims = true, orthoParts = null, round = null }) {
  const op = orthoParts || parts, fr = renderView(op, 'front'), tp = renderView(op, 'top'), rt = renderView(op, 'right'), iso = renderView(parts, 'iso', { shade: isoShade });
  const { left, top } = SHEET, gap = 26, AW = 230, AH = 200, ax = left + 14, ay = top + 12;
  const s = pickScale([[fr.bbox.w + rt.bbox.w, fr.bbox.h + tp.bbox.h, AW - gap, AH - gap]]);
  const k = s * 1000, fw = fr.bbox.w * k, fh = fr.bbox.h * k, th = tp.bbox.h * k, rw = rt.bbox.w * k;
  const usedW = fw + gap + rw, usedH = th + gap + fh, ox = ax + (AW - usedW) / 2, oy = ay + (AH - usedH) / 2;
  const Tf = placeView(fr, s, ox + fw / 2, oy + th + gap + fh / 2), Tt = placeView(tp, s, ox + fw / 2, oy + th / 2), Tr = placeView(rt, s, ox + fw + gap + rw / 2, oy + th + gap + fh / 2);
  let body = viewSVG(fr, Tf) + viewSVG(tp, Tt) + viewSVG(rt, Tr);
  if (dims) {
    const dia = (rv) => round && Math.abs(dot(rv.cam.f, { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[round])) > 0.9;
    const od = (rv, T, o) => { let x = overallDims(rv, T, o); if (dia(rv)) x = x.replace(/>(\d[\d.]*)<\/text>/g, '>Ø$1</text>'); return x; };
    body += od(fr, Tf) + od(tp, Tt, { w: false }) + od(rt, Tr, { hgt: false });
  }
  if (round) body += centreLines(fr, Tf, round) + centreLines(tp, Tt, round) + centreLines(rt, Tr, round);
  body += viewLabel(Tf, VIEWS.front.label) + `<text x="${f2((Tt.box.x0 + Tt.box.x1) / 2)}" y="${f2(Tt.box.y0 - 3)}" font-size="3.5" font-weight="700" text-anchor="middle">${VIEWS.top.label}</text>` + viewLabel(Tr, VIEWS.right.label);
  // isometric (own scale) in the upper-right region
  const IW = 150, IH = 92, ix = 258, iy = top + 6, si = fitScale(iso.bbox.w, iso.bbox.h, IW - 8, IH - 14), Ti = placeView(iso, si, ix + IW / 2, iy + IH / 2 - 3);
  body += viewSVG(iso, Ti, { lw: 0.25 }) + `<text x="${f2(ix + IW / 2)}" y="${f2(iy + IH)}" font-size="3.2" font-weight="700" text-anchor="middle">ISOMETRIC VIEW · ${pictorialLabel(si)}</text>`;
  // detail (section) and key dimensions table
  let y = iy + IH + 5;
  if (detail) { body += `<g transform="translate(${ix},${y})">${detail.svg}</g>`; y += detail.h + 4; }
  if (keyDims.length) {
    const rowsH = Math.min(keyDims.length, Math.floor((SHEET.H - SHEET.bottom - SHEET.tbH - notesHeight(meta.notes) - 6 - y - 7) / 4.3));
    if (rowsH > 0) { body += `<g font-size="2.7"><rect x="${ix}" y="${f2(y)}" width="${IW}" height="${f2(6 + rowsH * 4.3)}" fill="none" stroke="#111" stroke-width="0.3"/><text x="${ix + 2}" y="${f2(y + 4.3)}" font-weight="700" font-size="3">KEY DIMENSIONS & DATA</text>${keyDims.slice(0, rowsH).map(([l, v], i) => `<text x="${ix + 2}" y="${f2(y + 9.3 + i * 4.3)}">${esc(l)}</text><text x="${ix + IW - 2}" y="${f2(y + 9.3 + i * 4.3)}" text-anchor="end" font-weight="700">${esc(v)}</text>`).join('')}</g>`; }
  }
  return { svg: sheet({ ...meta, scale: scaleLabel(s) }, body), scale: s, views: { fr, tp, rt } };
}

// Exploded isometric assembly sheet with balloons and parts list
export function explodedSheet({ items, meta, explode, shade = true, title2 = 'EXPLODED ISOMETRIC VIEW' }) {
  // items: [{n, parts:[{mesh,color,offset}], desc, partNo, material, qty, mass}]
  const all = items.flatMap(it => it.parts.map(p => ({ ...p, item: it.n })));
  const rv = renderView(all, 'iso', { shade });
  // free regions: left of the parts list (full height) or above it (full width); pick the larger scale
  const txL = SHEET.W - SHEET.right - SHEET.tbW, rowH0 = 4.6, listTop = SHEET.H - SHEET.bottom - SHEET.tbH - 2 - (items.length + 1) * rowH0 - 8;
  const regA = { x: SHEET.left + 4, y: SHEET.top + 8, w: txL - SHEET.left - 10, h: SHEET.H - SHEET.bottom - SHEET.top - 26 }, regB = { x: SHEET.left + 4, y: SHEET.top + 8, w: SHEET.W - SHEET.right - SHEET.left - 10, h: listTop - SHEET.top - 20 };
  const sA = fitScale(rv.bbox.w, rv.bbox.h, regA.w - 44, regA.h - 40), sB = regB.h > 60 ? fitScale(rv.bbox.w, rv.bbox.h, regB.w - 50, regB.h - 40) : 0, reg = sB > sA ? regB : regA, s = Math.max(sA, sB);
  const AW = reg.w, AH = reg.h, ax = reg.x, ay = reg.y, T = placeView(rv, s, ax + AW / 2, ay + AH / 2);
  let body = viewSVG(rv, T, { lw: 0.22 }) + `<text x="${f2(ax + AW / 2)}" y="${f2(ay + AH + 6)}" font-size="3.5" font-weight="700" text-anchor="middle">${title2} · ${pictorialLabel(s)}</text>`;
  // explosion trace lines (chain thin) from assembled to exploded centroid
  const cam = rv.cam, proj = (p) => [T.X(dot(p, cam.r)), T.Y(dot(p, cam.u))];
  const cents = items.map(it => { let cx = 0, cy = 0, cz = 0, n = 0, ox = 0, oy = 0, oz = 0; for (const p of it.parts) { const P = p.mesh.p; for (let k = 0; k < P.length; k += 3 * Math.max(1, Math.floor(P.length / 300))) { cx += P[k]; cy += P[k + 1]; cz += P[k + 2]; n++; } const o = p.offset || [0, 0, 0]; ox += o[0]; oy += o[1]; oz += o[2]; } const m = it.parts.length || 1; const c = [cx / n, cy / n, cz / n]; return { c, e: [c[0] + ox / m, c[1] + oy / m, c[2] + oz / m] }; });
  if (explode) for (const c of cents) { const a = proj(c.c), b = proj(c.e); if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 3) body += `<path d="M${f2(a[0])} ${f2(a[1])}L${f2(b[0])} ${f2(b[1])}" stroke="#2563eb" stroke-width="0.15" stroke-dasharray="5 1.2 1 1.2" fill="none"/>`; }
  // balloons placed on a ring around the view, ordered by angle to avoid crossing leaders
  const cx = (T.box.x0 + T.box.x1) / 2, cy = (T.box.y0 + T.box.y1) / 2, Rx = Math.min(AW / 2 - 6, (T.box.x1 - T.box.x0) / 2 + 14), Ry = Math.min(AH / 2 - 6, (T.box.y1 - T.box.y0) / 2 + 12);
  const tg = items.map((it, i) => {
    const pc = proj(cents[i].e); let ang = Math.atan2(pc[1] - cy, pc[0] - cx); if (Math.hypot(pc[0] - cx, pc[1] - cy) < 4) ang = -Math.PI / 2 + i * 2 * Math.PI / items.length;
    const ux = Math.cos(ang), uy = Math.sin(ang); let best = pc, bv = -Infinity;
    const src = it.parts.length > 3 ? it.parts.slice(0, 1) : it.parts;
    for (const pt of src) { const P = pt.mesh.p, o = pt.offset || [0, 0, 0], st = 3 * Math.max(1, Math.floor(P.length / 3 / 400)); for (let k = 0; k < P.length; k += st) { const q = proj([P[k] + o[0], P[k + 1] + o[1], P[k + 2] + o[2]]), v = (q[0] - cx) * ux + (q[1] - cy) * uy - 0.15 * Math.abs((q[0] - cx) * uy - (q[1] - cy) * ux); if (v > bv) { bv = v; best = q; } } }
    // pull the target slightly inward so the dot sits on the part, not on its outline
    best = [best[0] - ux * 1.2, best[1] - uy * 1.2];
    return { it, p: best, ang };
  }).sort((a, b) => a.ang - b.ang);
  const nb = tg.length, used = [];
  tg.forEach((b, i) => { let ang = b.ang; for (const u of used) if (Math.abs(Math.atan2(Math.sin(ang - u), Math.cos(ang - u))) < 2 * Math.PI / Math.max(nb, 10) * 0.8) ang = u + 2 * Math.PI / Math.max(nb, 10) * 0.8; used.push(ang); body += balloon(b.it.n, [cx + Rx * Math.cos(ang), cy + Ry * Math.sin(ang)], b.p); });
  // parts list (ISO 7573) above the title block, rows upwards
  const tx = SHEET.W - SHEET.right - SHEET.tbW, rowH = 4.6, maxRows = Math.floor((SHEET.H - SHEET.bottom - SHEET.tbH - SHEET.top - 14) / rowH) - 1;
  const rows = items.slice(0, maxRows), yb = SHEET.H - SHEET.bottom - SHEET.tbH - 2;
  const cols = [[0, 9, 'ITEM'], [9, 26, 'PART No.'], [35, 70, 'DESCRIPTION'], [105, 38, 'MATERIAL'], [143, 13, 'QTY'], [156, 24, 'MASS kg']];
  body += '<g font-size="2.45">';
  rows.forEach((it, i) => { const y = yb - (i + 1) * rowH; body += `<rect x="${tx}" y="${f2(y)}" width="${SHEET.tbW}" height="${rowH}" fill="#fff" stroke="#111" stroke-width="0.2"/>`; const vals = [it.n, it.partNo, it.desc, it.material, it.qty, it.mass]; cols.forEach(([x, w], c) => { const t = String(vals[c] ?? ''); const max = Math.floor(w / 1.32); body += `<text x="${f2(tx + x + 1)}" y="${f2(y + 3.3)}">${esc(t.length > max ? t.slice(0, max - 1) + '…' : t)}</text>`; if (c) body += `<line x1="${f2(tx + x)}" y1="${f2(y)}" x2="${f2(tx + x)}" y2="${f2(y + rowH)}" stroke="#111" stroke-width="0.2"/>`; }); });
  const yh = yb - (rows.length + 1) * rowH; body += `<rect x="${tx}" y="${f2(yh)}" width="${SHEET.tbW}" height="${rowH}" fill="#e5e7eb" stroke="#111" stroke-width="0.3"/>` + cols.map(([x, w, l]) => `<text x="${f2(tx + x + 1)}" y="${f2(yh + 3.3)}" font-weight="700">${l}</text>`).join('') + `<text x="${tx}" y="${f2(yh - 2)}" font-size="3" font-weight="700">PARTS LIST</text></g>`;
  return { svg: sheet({ ...meta, scale: 'Pictorial (NTS)' }, body), scale: s };
}

// General-arrangement sheet: FRONT, TOP, RIGHT + shaded ISO for a large assembly (raster faces, vector dims)
export function gaSheet({ parts, meta, notes = [] }) { return partSheet({ parts, meta: { ...meta, notes }, isoShade: true }); }

// DXF (R12 ASCII) of the three orthographic views' visible edges, laid out third-angle in model millimetres
export function viewsDXF(views, title = 'THERMA-X100') {
  const L = []; const line = (x1, y1, x2, y2, layer) => L.push(`0\nLINE\n8\n${layer}\n10\n${x1.toFixed(3)}\n20\n${y1.toFixed(3)}\n11\n${x2.toFixed(3)}\n21\n${y2.toFixed(3)}`);
  const { fr, tp, rt } = views, g = 20, dxF = 0, dyT = (fr.bbox.y1 - tp.bbox.y0) * 1000 + g, dxR = (fr.bbox.x1 - rt.bbox.x0) * 1000 + g;
  const emit = (rv, dx, dy, layer) => { for (const t of rv.tris) for (const e of t.edges) line(e[0] * 1000 + dx, e[1] * 1000 + dy, e[2] * 1000 + dx, e[3] * 1000 + dy, layer); };
  emit(fr, dxF, 0, 'FRONT'); emit(tp, 0, dyT, 'TOP'); emit(rt, dxR, 0, 'RIGHT');
  L.push(`0\nTEXT\n8\nTEXT\n10\n0\n20\n${(-30).toFixed(1)}\n40\n6\n1\n${title}`);
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${L.join('\n')}\n0\nENDSEC\n0\nEOF\n`;
}
