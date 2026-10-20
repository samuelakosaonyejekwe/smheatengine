// 2D animated views (canvas) synchronised to the shared playback timeline. Suites pass solved histories and a
// draw(g, t, W, H) callback; helpers draw time-series panels with a sweeping cursor, bars, gauges and arrows.
// Text helpers measure every string, shrink it to a minimum size and then ellipsis-truncate it so labels stay inside
// their boxes and inside the canvas at any width (phone ~360 px to desktop). Views whose solved data do not change
// over the timeline are drawn once (static2d / anim2d staticWhen) instead of being replayed behind a pointless timeline.
import { playback } from './sim3d.js';
import { cmap } from './chart.js';
import { fmt, clamp } from './num.js';
import { h } from './ui.js';

const css = (n, f) => { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f; } catch { return f; } };
export const theme = () => ({ fg: css('--fg', '#e6ebf5'), mute: css('--muted', '#93a1b8'), grid: css('--grid', 'rgba(148,163,184,.18)'), bg: css('--panel', '#111a2e'), bg2: css('--panel2', '#16213a'), accent: css('--accent', '#38bdf8') });

// ---------------- canvas set-up ----------------
const FAMILY = 'Inter,system-ui,sans-serif';
export const font = (px, weight = '') => `${weight ? weight + ' ' : ''}${Math.round(px * 10) / 10}px ${FAMILY}`;
// base font size for a canvas of css width W (smaller on phones)
export const fs = (W, base = 12) => (W < 420 ? Math.max(9, base - 2) : W < 640 ? Math.max(9, base - 1) : base);
// canvas css size as recorded by anim2d/static2d (falls back to the element size)
export const canvasSize = (g) => ({ W: g.__W || g.canvas?.clientWidth || 600, H: g.__H || g.canvas?.clientHeight || 400 });

function mount(el, { height, explain }) {
  const wrap = h('div', { class: 'viewer', style: 'position:relative' }); el.append(wrap);
  const hOf = (W) => Math.round(typeof height === 'function' ? height(W) : height);
  const cv = h('canvas', { style: `width:100%;height:${hOf(el.clientWidth || 600)}px;display:block;background:${theme().bg}` }); wrap.append(cv);
  const g = cv.getContext('2d');
  const prep = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth || el.clientWidth || 600, H = hOf(W);
    if (cv.style.height !== H + 'px') cv.style.height = H + 'px';
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); g.fillStyle = theme().bg; g.fillRect(0, 0, W, H);
    g.font = font(fs(W)); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.lineWidth = 1; g.setLineDash([]); g.__W = W; g.__H = H;
    return { W, H };
  };
  return { wrap, cv, g, prep, note: () => { if (explain) el.append(h('p', { class: 'small muted', style: 'margin:6px 2px' }, explain)); } };
}

// Static drawing (no playback bar): draw(g, W, H) is called once and again on every resize.
export function static2d(el, { height = 420, draw, explain }) {
  const m = mount(el, { height, explain });
  const render = () => { const { W, H } = m.prep(); draw(m.g, W, H); };
  render(); const ro = new ResizeObserver(() => render()); ro.observe(m.cv); m.note();
  return { pb: null, canvas: m.cv, static: true };
}

// Animated drawing on the playback timeline. `staticWhen` (boolean or () => boolean) turns the view into a static
// drawing at time `staticT` (default: end of the timeline) when the solved data do not change meaningfully.
// `height` may be a number or a function of the canvas css width.
export function anim2d(el, { duration, rate = 1, height = 420, label, unit, draw, explain, staticWhen, staticT }) {
  if (typeof staticWhen === 'function' ? staticWhen() : staticWhen) return static2d(el, { height, explain, draw: (g, W, H) => draw(g, staticT ?? duration, W, H) });
  const m = mount(el, { height, explain });
  let lastT = 0;
  const render = (t) => { const { W, H } = m.prep(); draw(m.g, t, W, H); lastT = t; };
  const pb = playback(m.wrap, { duration, rate, label, unit, onFrame: render });
  const ro = new ResizeObserver(() => render(lastT)); ro.observe(m.cv);
  m.note();
  return { pb, canvas: m.cv };
}

// true when every array varies by less than `tol` (relative to its magnitude / range scale) after the first `skip`
// fraction of samples — i.e. a steady state replayed over time carries no information.
export function isSteady(arrays, { skip = 0.1, tol = 0.01 } = {}) {
  for (const A of arrays) {
    if (!A || !A.length) continue; const i0 = Math.floor(A.length * skip); let lo = Infinity, hi = -Infinity, mag = 0;
    for (let i = i0; i < A.length; i++) { const v = A[i]; if (!Number.isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; mag = Math.max(mag, Math.abs(v)); }
    if (hi > lo && (hi - lo) > tol * Math.max(mag, 1e-12)) return false;
  }
  return true;
}

// index & interpolation helper for a monotone time array
export function at(T, t) { const n = T.length; let lo = 0, hi = n - 1; if (t <= T[0]) return { i: 0, f: 0 }; if (t >= T[n - 1]) return { i: n - 1, f: 0 }; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] > t) hi = m; else lo = m; } return { i: lo, f: (t - T[lo]) / ((T[lo + 1] - T[lo]) || 1) }; }
export const lerp = (A, k) => A[k.i] + ((A[k.i + 1] ?? A[k.i]) - A[k.i]) * k.f;

// ---------------- text helpers ----------------
// largest font (size → minSize) at which s fits maxW, else ellipsis-truncated at minSize. Leaves g.font set.
export function fitText(g, s, maxW = Infinity, { size = 12, minSize = 9, weight = '' } = {}) {
  s = String(s ?? ''); maxW = Math.max(0, maxW);
  for (let z = size; z >= minSize - 1e-9; z -= 0.5) { g.font = font(z, weight); const w = g.measureText(s).width; if (w <= maxW) return { text: s, size: z, w }; }
  g.font = font(minSize, weight); const ell = '…';
  if (g.measureText(ell).width > maxW) return { text: '', size: minSize, w: 0 };
  let lo = 0, hi = s.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (g.measureText(s.slice(0, m).trimEnd() + ell).width <= maxW) lo = m; else hi = m - 1; }
  const t = s.slice(0, lo).trimEnd() + ell; return { text: t, size: minSize, w: g.measureText(t).width };
}
// measured box of a label without drawing it ({x,y,w,h} top-left, plus the fitted text)
export function measureLabel(g, s, x, y, o = {}) {
  const { W, H } = canvasSize(g), pad = o.bg ? (o.pad ?? 3) : 0, margin = o.margin ?? 2;
  const maxW = Math.min(o.maxW ?? Infinity, W - 2 * margin - 2 * pad);
  const size = o.size ?? fs(W), f = fitText(g, s, maxW, { size, minSize: o.minSize ?? Math.min(size, 8.5), weight: o.weight });
  const align = o.align || 'left', base = o.baseline || 'alphabetic', asc = f.size * 0.78, desc = f.size * 0.24;
  let left = align === 'center' ? x - f.w / 2 : align === 'right' ? x - f.w : x;
  let top = base === 'top' ? y : base === 'middle' ? y - (asc + desc) / 2 : base === 'bottom' ? y - asc - desc : y - asc;
  if (o.clamp !== false) { left = clamp(left, margin + pad, Math.max(margin + pad, W - margin - pad - f.w)); top = clamp(top, margin + pad, Math.max(margin + pad, H - margin - pad - asc - desc)); }
  return { x: left - pad, y: top - pad, w: f.w + 2 * pad, h: asc + desc + 2 * pad, tx: left, ty: top + asc, fit: f };
}
// draw a label: shrink → ellipsis to maxW, kept inside the canvas, optional translucent pill (bg: true | css colour)
export function label(g, s, x, y, o = {}) {
  const b = measureLabel(g, s, x, y, o); if (!b.fit.text) return b;
  g.save();
  if (o.bg) { const th = theme(); g.globalAlpha = o.bgAlpha ?? 0.82; g.fillStyle = o.bg === true ? th.bg : o.bg; rrect(g, b.x, b.y, b.w, b.h, Math.min(5, b.h / 2)); g.fill(); g.globalAlpha = 1; }
  g.font = font(b.fit.size, o.weight); g.fillStyle = o.color || theme().fg; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(b.fit.text, b.tx, b.ty);
  g.restore(); return b;
}
function rrect(g, x, y, w, hh, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
// word-wrap s into at most maxLines lines of width maxW (last line ellipsis-truncated)
export function wrapLines(g, s, maxW, { size = 12, weight = '', maxLines = 99 } = {}) {
  g.font = font(size, weight); const words = String(s ?? '').split(/\s+/).filter(Boolean), lines = []; let cur = '';
  for (let i = 0; i < words.length; i++) {
    const tr = cur ? cur + ' ' + words[i] : words[i];
    if (g.measureText(tr).width <= maxW || !cur) { cur = tr; continue; }
    lines.push(cur); cur = words[i];
    if (lines.length === maxLines - 1) { cur = words.slice(i).join(' '); break; }
  }
  if (cur) lines.push(cur);
  return lines.map((l, i) => (g.measureText(l).width > maxW || (i === maxLines - 1 && i < lines.length - 1)) ? fitText(g, l, maxW, { size, minSize: size, weight }).text : l);
}
// wrapped paragraph starting with its first baseline at y; returns the y below the last line
export function para(g, s, x, y, maxW, { size = 12, weight = '', lineH = size * 1.3, maxLines = 99, color, align = 'left' } = {}) {
  const lines = wrapLines(g, s, maxW, { size, weight, maxLines });
  g.save(); g.font = font(size, weight); g.fillStyle = color || theme().fg; g.textAlign = align; g.textBaseline = 'alphabetic';
  lines.forEach((l, i) => g.fillText(l, x, y + i * lineH)); g.restore();
  return y + lines.length * lineH;
}
// Collision-avoiding placement: items [{text, x, y, align, baseline:'middle', color, size, maxW, bg, weight}] with y the
// preferred position. Labels whose horizontal extents overlap are pushed apart vertically (gap px) and kept within
// [top, bottom] (default: the canvas). `avoid` = extra fixed boxes [{x,y,w,h}] (e.g. other text) to stay clear of.
export function placeLabels(g, items, { top, bottom, gap = 2, avoid = [], draw = true } = {}) {
  const { H } = canvasSize(g); top = top ?? 2; bottom = bottom ?? H - 2;
  const L = items.map((it, k) => ({ it, k, b: measureLabel(g, it.text, it.x, it.y, { baseline: 'middle', ...it }) }));
  L.sort((a, b) => a.b.y - b.b.y);
  const ov = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w;
  const placed = [...avoid.map(b => ({ b, fixed: true }))];
  for (const l of L) {
    l.b.y = clamp(l.b.y, top, Math.max(top, bottom - l.b.h));
    for (let pass = 0; pass < 40; pass++) {
      const hit = placed.find(p => ov(p.b, l.b) && l.b.y < p.b.y + p.b.h + gap && p.b.y < l.b.y + l.b.h + gap);
      if (!hit) break; l.b.y = hit.b.y + hit.b.h + gap;
    }
    placed.push(l);
  }
  // anything pushed past the bottom: shift the overlapping chain upwards
  const mov = placed.filter(p => !p.fixed).sort((a, b) => b.b.y - a.b.y), done = [];
  for (const l of mov) {
    let limit = bottom; for (const m of done) if (ov(m.b, l.b) && m.b.y + m.b.h > l.b.y - gap) limit = Math.min(limit, m.b.y - gap);
    if (l.b.y + l.b.h > limit) l.b.y = Math.max(top, limit - l.b.h); done.push(l);
  }
  const res = [];
  for (const l of L) {
    const b = l.b, it = l.it, pad = it.bg ? (it.pad ?? 3) : 0;
    if (draw) label(g, it.text, b.x + pad, b.y + pad, { ...it, baseline: 'top', align: 'left', clamp: false, maxW: b.w - 2 * pad + 0.5 });
    res[l.k] = { x: b.x, y: b.y, w: b.w, h: b.h };
  }
  return res;
}

// ---------------- panels & widgets ----------------
// time-series panel with sweeping cursor; series [{name, y[], color, dash}]. Header (title + legend with live values)
// is laid out in its own rows above the plot; y-range labels sit in a left gutter; reference lines (hlines) carry
// pill labels that avoid each other. Returns the plot mapping {X, Y, px, py, pw, ph, lo, hi}.
export function seriesPanel(g, { x, y, w, h: hh, T, series, t, title = '', unit, ymin, ymax, hlines = [], legend = true, digits = 4 }) {
  const th = theme(), { W } = canvasSize(g), base = Math.min(fs(W), w < 260 ? 10 : 12), sm = Math.max(8.5, base - 1.5);
  g.save(); g.strokeStyle = th.grid; g.fillStyle = th.bg2; g.fillRect(x, y, w, hh); g.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
  const all = series.flatMap(s => Array.from(s.y)).filter(Number.isFinite).concat(hlines.map(l => l.y).filter(Number.isFinite));
  let lo = ymin ?? (all.length ? Math.min(...all) : 0), hi = ymax ?? (all.length ? Math.max(...all) : 1); if (!(hi > lo)) { const c = lo; lo = c - Math.max(1e-9, Math.abs(c) * 0.01); hi = c + Math.max(1e-9, Math.abs(c) * 0.01); }
  const pad = (hi - lo) * 0.08; lo -= ymin === undefined ? pad : 0; hi += ymax === undefined ? pad : 0;
  // header layout: title token then legend tokens, flowing left→right and wrapping
  const lh = base + 4, innerW = w - 10, toks = [];
  const ttl = title + (unit ? ` [${unit}]` : '');
  if (ttl) { const f = fitText(g, ttl, innerW, { size: base, minSize: Math.max(8.5, base - 2), weight: '600' }); toks.push({ kind: 't', f, w: f.w + 12 }); }
  const vmax = series.map(s => { let m = 0; for (const v of s.y) if (Number.isFinite(v)) m = Math.max(m, Math.abs(v)); return m; });
  if (legend) series.forEach((s, i) => {
    g.font = font(sm); const n = s.y.length, st = Math.max(1, Math.floor(n / 60)); let wNum = g.measureText(fmt(-vmax[i] || -8.888, digits)).width;
    for (let j = 0; j < n; j += st) wNum = Math.max(wNum, g.measureText(fmt(s.y[j], digits)).width + 1);
    const wFull = g.measureText(`${s.name}: `).width + wNum + 20; toks.push({ kind: 's', s, w: Math.min(innerW, wFull) });
  });
  let cx = x + 5, row = 0; for (const tk of toks) { if (cx > x + 5 && cx + tk.w > x + 5 + innerW) { row++; cx = x + 5; } tk.cx = cx; tk.row = row; cx += tk.w; }
  const rows = toks.length ? row + 1 : 0, headH = rows ? rows * lh + 4 : 2;
  // gutter for the y-range labels
  g.font = font(sm); let dg = 3; while (dg < 8 && fmt(hi, dg) === fmt(lo, dg)) dg++; const sHi = fmt(hi, dg), sLo = fmt(lo, dg), gut = Math.max(g.measureText(sHi).width, g.measureText(sLo).width) + 8;
  const px = x + gut, pw = Math.max(10, w - gut - 6), py = y + headH + 4, ph = Math.max(12, hh - headH - 10);
  const t0 = T[0], t1 = T[T.length - 1], X = (tt) => px + (tt - t0) / ((t1 - t0) || 1) * pw, Y = (v) => py + ph - (v - lo) / (hi - lo) * ph;
  g.strokeStyle = th.grid; g.beginPath(); g.moveTo(x, py - 2); g.lineTo(x + w, py - 2); g.stroke();
  g.beginPath(); g.moveTo(px, py); g.lineTo(px, py + ph); g.stroke();
  label(g, sHi, px - 4, py, { align: 'right', baseline: 'top', size: sm, color: th.mute, clamp: false });
  label(g, sLo, px - 4, py + ph, { align: 'right', baseline: 'bottom', size: sm, color: th.mute, clamp: false });
  g.save(); g.beginPath(); g.rect(px, py - 1, pw, ph + 2); g.clip();
  for (const l of hlines) { if (!Number.isFinite(l.y)) continue; g.strokeStyle = l.color || '#ef4444'; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(px, Y(l.y)); g.lineTo(px + pw, Y(l.y)); g.stroke(); g.setLineDash([]); }
  const step = Math.max(1, Math.floor(T.length / 600));
  for (const s of series) { g.strokeStyle = s.color; g.lineWidth = 1.6; if (s.dash) g.setLineDash(s.dash); g.beginPath(); let first = true; for (let i = 0; i < T.length; i += step) { const v = s.y[i]; if (!Number.isFinite(v)) { first = true; continue; } const qx = X(T[i]), qy = Y(v); first ? g.moveTo(qx, qy) : g.lineTo(qx, qy); first = false; } g.stroke(); g.setLineDash([]); }
  const k = at(T, t), tc = clamp(t, t0, t1);
  g.strokeStyle = th.fg; g.lineWidth = 1; g.beginPath(); g.moveTo(X(tc), py); g.lineTo(X(tc), py + ph); g.stroke();
  for (const s of series) { const v = lerp(s.y, k); if (Number.isFinite(v)) { g.fillStyle = s.color; g.beginPath(); g.arc(X(tc), Y(v), 3.5, 0, 7); g.fill(); } }
  g.restore();
  // reference-line labels: pills at the right end of the plot, pushed apart
  const hl = hlines.filter(l => l.label && Number.isFinite(l.y));
  if (hl.length) {
    // candidate spots (right/left end, above/below the line); the first whose box does not cover a curve wins
    const hitsCurve = (b) => { const i0 = at(T, t0 + (b.x - px) / pw * (t1 - t0)).i, i1 = at(T, t0 + (b.x + b.w - px) / pw * (t1 - t0)).i + 1, st = Math.max(1, Math.floor((i1 - i0) / 40)); for (const s of series) for (let i = i0; i <= Math.min(T.length - 1, i1); i += st) { const v = Y(s.y[i]); if (v >= b.y - 1 && v <= b.y + b.h + 1) return true; } return false; };
    const items = hl.map(l => {
      const base0 = { text: l.label, color: l.color || '#ef4444', size: sm, maxW: pw * 0.45, bg: true, pad: 2, align: 'right' }, yl = Y(l.y), dy = sm * 0.85;
      const cands = [{ x: px + pw - 3, y: yl - dy }, { x: px + pw - 3, y: yl + dy }, { x: px + 3, y: yl - dy, align: 'left' }, { x: px + 3, y: yl + dy, align: 'left' }, { x: px + pw * 0.5, y: yl - dy, align: 'center' }, { x: px + pw * 0.5, y: yl + dy, align: 'center' }].map(c => ({ ...base0, ...c }));
      return cands.find(c => { const b = measureLabel(g, c.text, c.x, c.y, { ...c, baseline: 'middle' }); return b.y >= py && b.y + b.h <= py + ph && !hitsCurve(b); }) || cands[0];
    });
    placeLabels(g, items, { top: py, bottom: py + ph, gap: 1 });
  }
  // header text
  for (const tk of toks) {
    const ty = y + 4 + tk.row * lh + lh / 2;
    if (tk.kind === 't') { g.font = font(tk.f.size, '600'); g.fillStyle = th.fg; g.textBaseline = 'middle'; g.fillText(tk.f.text, tk.cx, ty); g.textBaseline = 'alphabetic'; continue; }
    const v = lerp(tk.s.y, k); g.fillStyle = tk.s.color; g.fillRect(tk.cx, ty - 1.5, 11, 3);
    const f = fitText(g, `${tk.s.name}: ${fmt(v, digits)}`, tk.w - 18, { size: sm, minSize: Math.max(8, sm - 1.5) });
    g.fillStyle = th.fg; g.textBaseline = 'middle'; g.fillText(f.text, tk.cx + 14, ty); g.textBaseline = 'alphabetic';
  }
  g.restore();
  return { X, Y, px, py, pw, ph, lo, hi };
}
// legend swatches flowing left→right and wrapping inside width w; items [{name, color, dash}]; returns the y below it
export function legendRow(g, items, x, y, w, { size, swatch = 10 } = {}) {
  const { W } = canvasSize(g), z = size ?? Math.max(8.5, fs(W) - 1), lh = z + 5; let cx = x, cy = y;
  g.save(); g.font = font(z);
  const colW = Math.min(w, Math.max(...items.map(it => g.measureText(it.name).width)) + swatch + 14);
  for (const it of items) {
    if (cx > x && cx + colW > x + w + 0.5) { cx = x; cy += lh; }
    g.fillStyle = it.color; if (it.dash) { g.strokeStyle = it.color; g.setLineDash(it.dash); g.beginPath(); g.moveTo(cx, cy + lh / 2); g.lineTo(cx + swatch, cy + lh / 2); g.stroke(); g.setLineDash([]); } else g.fillRect(cx, cy + lh / 2 - 4, swatch, 8);
    const f = fitText(g, it.name, colW - swatch - 10, { size: z, minSize: Math.max(8, z - 1.5) }); g.fillStyle = theme().fg; g.textBaseline = 'middle'; g.fillText(f.text, cx + swatch + 4, cy + lh / 2);
    cx += colW;
  }
  g.restore(); return cy + lh;
}
// horizontal bar with value; the label is kept inside the bar box (shrunk / truncated as needed)
export function bar(g, { x, y, w, h: hh = 14, value, max, label: lab, color = '#38bdf8', unit = '' }) {
  const th = theme(); g.save(); g.fillStyle = th.bg2; g.fillRect(x, y, w, hh); g.fillStyle = color; g.fillRect(x, y, clamp(value / (max || 1), 0, 1) * w, hh); g.strokeStyle = th.grid; g.strokeRect(x, y, w, hh);
  const f = fitText(g, `${lab}: ${fmt(value, 4)}${unit}`, w - 8, { size: Math.min(fs(canvasSize(g).W), hh - 2), minSize: Math.min(8.5, hh - 3) });
  g.fillStyle = th.fg; g.textBaseline = 'middle'; g.fillText(f.text, x + 4, y + hh / 2 + 0.5); g.restore();
}
// semicircular gauge; value and caption shrink to the gauge width
export function gauge(g, { cx, cy, r, value, min = 0, max, label: lab, unit = '', cmapName = 'inferno' }) {
  const th = theme(), f = clamp((value - min) / ((max - min) || 1), 0, 1); g.save(); g.lineWidth = r * 0.22; g.strokeStyle = th.bg2; g.beginPath(); g.arc(cx, cy, r, Math.PI, 2 * Math.PI); g.stroke();
  const c = cmap(f, cmapName); g.strokeStyle = `rgb(${c.map(Math.round).join(',')})`; g.beginPath(); g.arc(cx, cy, r, Math.PI, Math.PI + Math.PI * f); g.stroke(); g.lineWidth = 1;
  label(g, fmt(value, 4) + unit, cx, cy - 4, { align: 'center', size: Math.min(15, Math.max(10, r * 0.4)), minSize: 9, weight: 'bold', maxW: 1.6 * r });
  label(g, lab, cx, cy + 14, { align: 'center', size: 11, minSize: 8.5, color: th.mute, maxW: 2.4 * r });
  g.restore();
}
// arrow from (x,y) along (dx,dy) pixels; optional label beside the tip kept inside the canvas
export function arrow(g, x, y, dx, dy, color = '#22c55e', wdt = 2.5, lab) {
  const L = Math.hypot(dx, dy); if (L < 1) return; g.save(); g.strokeStyle = color; g.fillStyle = color; g.lineWidth = wdt; g.beginPath(); g.moveTo(x, y); g.lineTo(x + dx, y + dy); g.stroke();
  const a = Math.atan2(dy, dx), s = Math.min(10, L * 0.4); g.beginPath(); g.moveTo(x + dx, y + dy); g.lineTo(x + dx - s * Math.cos(a - 0.4), y + dy - s * Math.sin(a - 0.4)); g.lineTo(x + dx - s * Math.cos(a + 0.4), y + dy - s * Math.sin(a + 0.4)); g.closePath(); g.fill(); g.restore();
  if (lab) label(g, lab, x + dx + (dx >= 0 ? 4 : -4), y + dy - 4, { align: dx >= 0 ? 'left' : 'right', size: 11, color, bg: true, pad: 2 });
}
// plain text (kept inside the canvas; optional maxW)
export function text(g, s, x, y, color, fnt, maxW) {
  const m = /(\d+(?:\.\d+)?)px/.exec(fnt || ''), wt = /bold|[6-9]00/.exec(fnt || '')?.[0];
  return label(g, s, x, y, { color, size: m ? +m[1] : undefined, weight: wt, maxW });
}
// small top-view vehicle icon (body + wing chords) at px,py with heading psi (rad, screen frame, 0 = +x)
export function carIcon(g, px, py, psi, scale = 1, wingAngle = 0, color = '#e5e7eb') { g.save(); g.translate(px, py); g.rotate(psi); g.scale(scale, scale); g.fillStyle = color; g.beginPath(); g.ellipse(0, 0, 21, 8, 0, 0, 7); g.fill(); g.fillStyle = '#111827'; g.fillRect(12, -10, 6, 3); g.fillRect(12, 7, 6, 3); g.fillRect(-16, -1.5, 6, 3); g.strokeStyle = '#38bdf8'; g.lineWidth = 3; for (const wx of [-6, 8]) { g.save(); g.translate(wx, 0); g.rotate(wingAngle); g.beginPath(); g.moveTo(-6, 0); g.lineTo(6, 0); g.stroke(); g.restore(); } g.restore(); }
