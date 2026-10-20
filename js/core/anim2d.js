// 2D animated views (canvas) synchronised to the shared playback timeline. Suites pass solved histories and a
// draw(g, t, W, H) callback; helpers draw time-series panels with a sweeping cursor, bars, gauges and arrows.
import { playback } from './sim3d.js';
import { cmap } from './chart.js';
import { fmt, clamp } from './num.js';
import { h } from './ui.js';

const css = (n, f) => { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f; } catch { return f; } };
export const theme = () => ({ fg: css('--fg', '#e6ebf5'), mute: css('--muted', '#93a1b8'), grid: css('--grid', 'rgba(148,163,184,.18)'), bg: css('--panel', '#111a2e'), bg2: css('--panel2', '#16213a'), accent: css('--accent', '#38bdf8') });

export function anim2d(el, { duration, rate = 1, height = 420, label, unit, draw, explain }) {
  const wrap = h('div', { class: 'viewer', style: 'position:relative' }); el.append(wrap);
  const cv = h('canvas', { style: `width:100%;height:${height}px;display:block;background:${theme().bg}` }); wrap.append(cv);
  const g = cv.getContext('2d');
  let lastT = 0;
  const render = (t) => { const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth || 600, H = height; if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); } g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); g.fillStyle = theme().bg; g.fillRect(0, 0, W, H); g.font = '12px Inter,system-ui,sans-serif'; draw(g, t, W, H); lastT = t; };
  const pb = playback(wrap, { duration, rate, label, unit, onFrame: render });
  const ro = new ResizeObserver(() => render(lastT)); ro.observe(cv);
  if (explain) el.append(h('p', { class: 'small muted', style: 'margin:6px 2px' }, explain));
  return { pb, canvas: cv };
}

// index & interpolation helper for a monotone time array
export function at(T, t) { const n = T.length; let lo = 0, hi = n - 1; if (t <= T[0]) return { i: 0, f: 0 }; if (t >= T[n - 1]) return { i: n - 1, f: 0 }; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] > t) hi = m; else lo = m; } return { i: lo, f: (t - T[lo]) / ((T[lo + 1] - T[lo]) || 1) }; }
export const lerp = (A, k) => A[k.i] + ((A[k.i + 1] ?? A[k.i]) - A[k.i]) * k.f;

// time-series panel with sweeping cursor; series [{name, y[], color}]
export function seriesPanel(g, { x, y, w, h: hh, T, series, t, title, unit, ymin, ymax, hlines = [] }) {
  const th = theme(); g.save(); g.strokeStyle = th.grid; g.fillStyle = th.bg2; g.fillRect(x, y, w, hh); g.strokeRect(x, y, w, hh);
  const all = series.flatMap(s => s.y).filter(Number.isFinite).concat(hlines.map(l => l.y)); let lo = ymin ?? Math.min(...all), hi = ymax ?? Math.max(...all); if (!(hi > lo)) { hi = lo + 1; }
  const pad = (hi - lo) * 0.08; lo -= ymin === undefined ? pad : 0; hi += ymax === undefined ? pad : 0;
  const t0 = T[0], t1 = T[T.length - 1], X = (tt) => x + 4 + (tt - t0) / ((t1 - t0) || 1) * (w - 8), Y = (v) => y + hh - 14 - (v - lo) / (hi - lo) * (hh - 28);
  for (const l of hlines) { g.strokeStyle = l.color || '#ef4444'; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(x, Y(l.y)); g.lineTo(x + w, Y(l.y)); g.stroke(); g.setLineDash([]); if (l.label) { g.fillStyle = l.color || '#ef4444'; g.fillText(l.label, x + w - g.measureText(l.label).width - 4, Y(l.y) - 3); } }
  const step = Math.max(1, Math.floor(T.length / 600));
  for (const s of series) { g.strokeStyle = s.color; g.lineWidth = 1.6; g.beginPath(); let first = true; for (let i = 0; i < T.length; i += step) { const v = s.y[i]; if (!Number.isFinite(v)) { first = true; continue; } const px = X(T[i]), py = Y(v); first ? g.moveTo(px, py) : g.lineTo(px, py); first = false; } g.stroke(); }
  const k = at(T, t); g.strokeStyle = th.fg; g.lineWidth = 1; g.beginPath(); g.moveTo(X(t), y); g.lineTo(X(t), y + hh); g.stroke();
  let ly = y + 14; g.fillStyle = th.fg; g.fillText(title + (unit ? ` [${unit}]` : ''), x + 6, ly);
  for (const s of series) { const v = lerp(s.y, k); ly += 14; g.fillStyle = s.color; g.fillRect(x + 6, ly - 8, 10, 3); g.fillStyle = th.fg; g.fillText(`${s.name}: ${fmt(v, 4)}`, x + 20, ly); if (Number.isFinite(v)) { g.fillStyle = s.color; g.beginPath(); g.arc(X(t), Y(v), 3.5, 0, 7); g.fill(); } }
  g.fillStyle = th.mute; g.fillText(fmt(hi, 3), x + w - 46, y + 12); g.fillText(fmt(lo, 3), x + w - 46, y + hh - 4);
  g.restore();
}
// horizontal bar with value
export function bar(g, { x, y, w, h: hh = 14, value, max, label, color = '#38bdf8', unit = '' }) { const th = theme(); g.fillStyle = th.bg2; g.fillRect(x, y, w, hh); g.fillStyle = color; g.fillRect(x, y, clamp(value / (max || 1), 0, 1) * w, hh); g.strokeStyle = th.grid; g.strokeRect(x, y, w, hh); g.fillStyle = th.fg; g.fillText(`${label}: ${fmt(value, 4)}${unit}`, x + 4, y + hh - 3); }
// semicircular gauge
export function gauge(g, { cx, cy, r, value, min = 0, max, label, unit = '', cmapName = 'inferno' }) { const th = theme(), f = clamp((value - min) / ((max - min) || 1), 0, 1); g.lineWidth = r * 0.22; g.strokeStyle = th.bg2; g.beginPath(); g.arc(cx, cy, r, Math.PI, 2 * Math.PI); g.stroke(); const c = cmap(f, cmapName); g.strokeStyle = `rgb(${c.map(Math.round).join(',')})`; g.beginPath(); g.arc(cx, cy, r, Math.PI, Math.PI + Math.PI * f); g.stroke(); g.lineWidth = 1; g.fillStyle = th.fg; g.textAlign = 'center'; g.font = 'bold 15px Inter,system-ui,sans-serif'; g.fillText(fmt(value, 4) + unit, cx, cy - 4); g.font = '11px Inter,system-ui,sans-serif'; g.fillStyle = th.mute; g.fillText(label, cx, cy + 14); g.textAlign = 'left'; g.font = '12px Inter,system-ui,sans-serif'; }
// arrow from (x,y) along (dx,dy) pixels
export function arrow(g, x, y, dx, dy, color = '#22c55e', wdt = 2.5, lab) { const L = Math.hypot(dx, dy); if (L < 1) return; g.strokeStyle = color; g.fillStyle = color; g.lineWidth = wdt; g.beginPath(); g.moveTo(x, y); g.lineTo(x + dx, y + dy); g.stroke(); const a = Math.atan2(dy, dx), s = Math.min(10, L * 0.4); g.beginPath(); g.moveTo(x + dx, y + dy); g.lineTo(x + dx - s * Math.cos(a - 0.4), y + dy - s * Math.sin(a - 0.4)); g.lineTo(x + dx - s * Math.cos(a + 0.4), y + dy - s * Math.sin(a + 0.4)); g.closePath(); g.fill(); g.lineWidth = 1; if (lab) { g.font = '11px Inter,system-ui,sans-serif'; g.fillText(lab, x + dx + 4, y + dy - 4); g.font = '12px Inter,system-ui,sans-serif'; } }
export function text(g, s, x, y, color, font) { g.save(); if (font) g.font = font; g.fillStyle = color || theme().fg; g.fillText(s, x, y); g.restore(); }
// small top-view vehicle icon (body + wing chords) at px,py with heading psi (rad, screen frame, 0 = +x)
export function carIcon(g, px, py, psi, scale = 1, wingAngle = 0, color = '#e5e7eb') { g.save(); g.translate(px, py); g.rotate(psi); g.scale(scale, scale); g.fillStyle = color; g.beginPath(); g.ellipse(0, 0, 21, 8, 0, 0, 7); g.fill(); g.fillStyle = '#111827'; g.fillRect(12, -10, 6, 3); g.fillRect(12, 7, 6, 3); g.fillRect(-16, -1.5, 6, 3); g.strokeStyle = '#38bdf8'; g.lineWidth = 3; for (const wx of [-6, 8]) { g.save(); g.translate(wx, 0); g.rotate(wingAngle); g.beginPath(); g.moveTo(-6, 0); g.lineTo(6, 0); g.stroke(); g.restore(); } g.restore(); }
