// Lightweight, dependency-free scientific charting (SVG + canvas) with hover readout and export.
import { fmt, min, max, linspace, clamp } from './num.js';

const PALETTE = ['#3b82f6', '#f97316', '#10b981', '#e11d48', '#8b5cf6', '#eab308', '#06b6d4', '#ec4899', '#84cc16', '#64748b'];
export const palette = (i) => PALETTE[i % PALETTE.length];
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };

// ---- colormaps ----
const VIRIDIS = [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]];
const TURBO = [[48, 18, 59], [70, 107, 227], [41, 187, 236], [49, 242, 153], [163, 253, 61], [237, 208, 58], [251, 128, 34], [208, 47, 5], [122, 4, 3]];
const COOLWARM = [[59, 76, 192], [124, 159, 249], [192, 212, 245], [242, 203, 183], [238, 132, 104], [180, 4, 38]];
const INFERNO = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
export const CMAPS = { viridis: VIRIDIS, turbo: TURBO, coolwarm: COOLWARM, inferno: INFERNO };
export function cmap(t, name = 'viridis') {
  const C = CMAPS[name] || VIRIDIS; t = clamp(Number.isFinite(t) ? t : 0, 0, 1) * (C.length - 1);
  const i = Math.min(C.length - 2, Math.floor(t)), f = t - i, a = C[i], b = C[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
export const cssColor = (rgb) => `rgb(${rgb.map(v => Math.round(v)).join(',')})`;

function niceTicks(lo, hi, n = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0)), err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
function logTicks(lo, hi) { const o = []; for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) o.push(10 ** e); return o; }

function css(name, fallback) { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; } }

// ---- public API ----
export function chart(container, spec) {
  container.classList.add('chart-box');
  container.innerHTML = '';
  const head = document.createElement('div'); head.className = 'chart-head';
  head.innerHTML = `<div class="chart-title">${spec.title || ''}</div><div class="chart-tools"><button class="icon-btn sm" data-a="png" title="Download PNG">PNG</button><button class="icon-btn sm" data-a="svg" title="Download SVG">SVG</button><button class="icon-btn sm" data-a="csv" title="Download data as CSV">CSV</button></div>`;
  container.appendChild(head);
  const holder = document.createElement('div'); holder.className = 'chart-svg'; container.appendChild(holder);
  if (spec.explain) { const ex = document.createElement('details'); ex.className = 'chart-explain'; ex.innerHTML = `<summary>What this shows</summary><p>${spec.explain}</p>`; container.appendChild(ex); }
  const hidden = new Set();
  const draw = () => {
    holder.innerHTML = '';
    const W = Math.max(280, holder.clientWidth || container.clientWidth || 600), H = spec.height || Math.round(Math.min(420, Math.max(220, W * 0.55)));
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': spec.title || 'chart', class: 'chart' }, holder);
    const fn = { line: drawXY, scatter: drawXY, area: drawXY, bar: drawBar, tornado: drawTornado, heatmap: drawHeat, contour: drawHeat, polar: drawPolar, stack: drawXY, gauge: drawGauge }[spec.type || 'line'] || drawXY;
    fn(svg, spec, W, H, hidden, holder, draw);
  };
  draw();
  let rt; const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(draw, 120); }); ro.observe(holder);
  head.querySelector('[data-a=png]').onclick = () => exportPNG(holder.querySelector('svg'), spec.title);
  head.querySelector('[data-a=svg]').onclick = () => download(new Blob([serialize(holder.querySelector('svg'))], { type: 'image/svg+xml' }), slug(spec.title) + '.svg');
  head.querySelector('[data-a=csv]').onclick = () => download(new Blob([toCSV(spec)], { type: 'text/csv' }), slug(spec.title) + '.csv');
  return { redraw: draw, destroy: () => ro.disconnect() };
}

function frame(svg, spec, W, H, xr, yr, opts = {}) {
  const fg = css('--fg', '#e5e7eb'), mute = css('--muted', '#94a3b8'), grid = css('--grid', 'rgba(148,163,184,.18)');
  const m = { l: 62, r: opts.y2 ? 60 : 18, t: 12, b: 44 }; const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const xlog = spec.x?.log, ylog = spec.y?.log;
  const sx = (v) => m.l + (xlog ? (Math.log10(v) - Math.log10(xr[0])) / (Math.log10(xr[1]) - Math.log10(xr[0])) : (v - xr[0]) / ((xr[1] - xr[0]) || 1)) * pw;
  const sy = (v) => m.t + ph - (ylog ? (Math.log10(v) - Math.log10(yr[0])) / (Math.log10(yr[1]) - Math.log10(yr[0])) : (v - yr[0]) / ((yr[1] - yr[0]) || 1)) * ph;
  const g = el('g', {}, svg);
  const xt = opts.xcats ? null : (xlog ? logTicks(xr[0], xr[1]) : niceTicks(xr[0], xr[1], Math.max(3, Math.floor(pw / 90))));
  const yt = ylog ? logTicks(yr[0], yr[1]) : niceTicks(yr[0], yr[1], Math.max(3, Math.floor(ph / 50)));
  for (const v of yt) { if (v < yr[0] - 1e-12 || v > yr[1] + 1e-12) continue; const y = sy(v); el('line', { x1: m.l, x2: m.l + pw, y1: y, y2: y, stroke: grid }, g); el('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end', fill: mute, 'font-size': 11 }, g).textContent = fmt(v, 3); }
  if (xt) for (const v of xt) { if (v < xr[0] - 1e-12 || v > xr[1] + 1e-12) continue; const x = sx(v); el('line', { x1: x, x2: x, y1: m.t, y2: m.t + ph, stroke: grid }, g); el('text', { x, y: m.t + ph + 16, 'text-anchor': 'middle', fill: mute, 'font-size': 11 }, g).textContent = fmt(v, 3); }
  el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'none', stroke: mute, 'stroke-opacity': .5 }, g);
  const xl = (spec.x?.label || '') + (spec.x?.unit ? ` [${spec.x.unit}]` : ''), yl = (spec.y?.label || '') + (spec.y?.unit ? ` [${spec.y.unit}]` : '');
  el('text', { x: m.l + pw / 2, y: H - 6, 'text-anchor': 'middle', fill: fg, 'font-size': 12 }, g).textContent = xl;
  el('text', { x: 14, y: m.t + ph / 2, 'text-anchor': 'middle', fill: fg, 'font-size': 12, transform: `rotate(-90 14 ${m.t + ph / 2})` }, g).textContent = yl;
  return { m, pw, ph, sx, sy, g };
}

function extent(vals, pad = 0.05, log = false) {
  const v = vals.filter(x => Number.isFinite(x) && (!log || x > 0)); if (!v.length) return [0, 1];
  let lo = min(v), hi = max(v); if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
  if (log) return [lo, hi];
  const d = (hi - lo) * pad; return [lo - d, hi + d];
}

function drawXY(svg, spec, W, H, hidden, holder, redraw) {
  const series = (spec.series || []).map((s, i) => ({ ...s, color: s.color || palette(i), idx: i }));
  const vis = series.filter(s => !hidden.has(s.idx));
  const xs = vis.flatMap(s => s.x || []), ys = vis.flatMap(s => s.y || []).concat((spec.annotations || []).filter(a => a.type === 'hline').map(a => a.y));
  if (spec.type === 'stack') { const tot = (vis[0]?.x || []).map((_, i) => vis.reduce((a, s) => a + (s.y[i] || 0), 0)); ys.push(...tot, 0); }
  const xr = [spec.x?.min ?? extent(xs, 0, spec.x?.log)[0], spec.x?.max ?? extent(xs, 0, spec.x?.log)[1]];
  const yr = [spec.y?.min ?? extent(ys, 0.06, spec.y?.log)[0], spec.y?.max ?? extent(ys, 0.06, spec.y?.log)[1]];
  const F = frame(svg, spec, W, H, xr, yr); const { sx, sy, m, pw, ph } = F;
  const clipId = 'c' + Math.random().toString(36).slice(2); const defs = el('defs', {}, svg); const cp = el('clipPath', { id: clipId }, defs); el('rect', { x: m.l, y: m.t, width: pw, height: ph }, cp);
  const plot = el('g', { 'clip-path': `url(#${clipId})` }, svg);
  for (const a of spec.annotations || []) {
    if (a.type === 'band') el('rect', { x: m.l, width: pw, y: sy(a.y1), height: Math.abs(sy(a.y0) - sy(a.y1)), fill: a.color || '#22c55e', 'fill-opacity': a.opacity ?? 0.1 }, plot);
    if (a.type === 'xband') el('rect', { y: m.t, height: ph, x: sx(a.x0), width: Math.abs(sx(a.x1) - sx(a.x0)), fill: a.color || '#f59e0b', 'fill-opacity': a.opacity ?? 0.1 }, plot);
    if (a.type === 'hline') { const y = sy(a.y); el('line', { x1: m.l, x2: m.l + pw, y1: y, y2: y, stroke: a.color || '#ef4444', 'stroke-dasharray': '6 4', 'stroke-width': 1.5 }, plot); if (a.label) el('text', { x: m.l + pw - 4, y: y - 4, 'text-anchor': 'end', fill: a.color || '#ef4444', 'font-size': 11 }, plot).textContent = a.label; }
    if (a.type === 'vline') { const x = sx(a.x); el('line', { x1: x, x2: x, y1: m.t, y2: m.t + ph, stroke: a.color || '#a855f7', 'stroke-dasharray': '6 4', 'stroke-width': 1.5 }, plot); if (a.label) el('text', { x: x + 4, y: m.t + 12, fill: a.color || '#a855f7', 'font-size': 11 }, plot).textContent = a.label; }
    if (a.type === 'point') { el('circle', { cx: sx(a.x), cy: sy(a.y), r: 5, fill: a.color || '#facc15', stroke: '#000', 'stroke-width': .5 }, plot); if (a.label) el('text', { x: sx(a.x) + 7, y: sy(a.y) - 7, fill: a.color || '#facc15', 'font-size': 11 }, plot).textContent = a.label; }
  }
  let base = null;
  for (const s of vis) {
    if (!s.x || !s.y) continue;
    const pts = []; for (let i = 0; i < s.x.length; i++) { let yv = s.y[i]; if (spec.type === 'stack') yv = (base ? base[i] : 0) + (s.y[i] || 0); if (Number.isFinite(s.x[i]) && Number.isFinite(yv)) pts.push([sx(s.x[i]), sy(yv), i]); }
    if (s.band) { const up = s.band.hi.map((v, i) => [sx(s.x[i]), sy(v)]), lo = s.band.lo.map((v, i) => [sx(s.x[i]), sy(v)]).reverse(); el('path', { d: 'M' + up.concat(lo).map(p => p.join(',')).join('L') + 'Z', fill: s.color, 'fill-opacity': .15, stroke: 'none' }, plot); }
    const mode = s.mode || (spec.type === 'scatter' ? 'markers' : 'lines');
    if (mode.includes('lines') && pts.length > 1) {
      const d = 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L');
      if (s.area || spec.type === 'area' || spec.type === 'stack') {
        const bl = spec.type === 'stack' && base ? s.x.map((x, i) => [sx(x), sy(base[i])]).reverse() : [[pts[pts.length - 1][0], sy(Math.max(yr[0], 0))], [pts[0][0], sy(Math.max(yr[0], 0))]];
        el('path', { d: d + 'L' + bl.map(p => p.join(',')).join('L') + 'Z', fill: s.color, 'fill-opacity': spec.type === 'stack' ? .55 : .18 }, plot);
      }
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-dasharray': s.dash || null, 'stroke-linejoin': 'round' }, plot);
    }
    if (mode.includes('markers')) for (const p of pts) el('circle', { cx: p[0], cy: p[1], r: s.r || 3, fill: s.colors ? s.colors[p[2]] : s.color, 'fill-opacity': .85 }, plot);
    if (s.labels) for (const p of pts) if (s.labels[p[2]]) el('text', { x: p[0] + 5, y: p[1] - 5, 'font-size': 10, fill: css('--muted', '#94a3b8') }, plot).textContent = s.labels[p[2]];
    if (spec.type === 'stack') base = s.x.map((_, i) => (base ? base[i] : 0) + (s.y[i] || 0));
  }
  legend(svg, series, hidden, W, m, redraw);
  hover(svg, holder, vis, spec, F, xr);
}

function legend(svg, series, hidden, W, m, redraw) {
  if (series.length < 2) return;
  const fg = css('--fg', '#e5e7eb'); let x = m.l + 8, y = m.t + 14;
  const g = el('g', { class: 'legend' }, svg);
  for (const s of series) {
    const w = 18 + Math.min(160, (s.name || '').length * 6.5);
    if (x + w > W - m.r) { x = m.l + 8; y += 16; }
    const it = el('g', { style: 'cursor:pointer', opacity: hidden.has(s.idx) ? .35 : 1 }, g);
    el('rect', { x: x - 3, y: y - 10, width: w, height: 14, fill: css('--panel', '#0f172a'), 'fill-opacity': .7, rx: 3 }, it);
    el('rect', { x, y: y - 6, width: 10, height: 4, fill: s.color }, it);
    el('text', { x: x + 14, y, fill: fg, 'font-size': 11 }, it).textContent = s.name || '';
    it.addEventListener('click', () => { hidden.has(s.idx) ? hidden.delete(s.idx) : hidden.add(s.idx); redraw(); });
    x += w + 6;
  }
}

function hover(svg, holder, vis, spec, F, xr) {
  const { m, pw, ph, sx, sy } = F; const tip = document.createElement('div'); tip.className = 'chart-tip'; holder.appendChild(tip);
  const line = el('line', { y1: m.t, y2: m.t + ph, stroke: css('--muted', '#94a3b8'), 'stroke-dasharray': '3 3', visibility: 'hidden' }, svg);
  const xlog = spec.x?.log;
  const move = (ev) => {
    const r = svg.getBoundingClientRect(), scale = (svg.viewBox.baseVal.width || r.width) / r.width, px = (ev.clientX - r.left) * scale;
    if (px < m.l || px > m.l + pw) { tip.style.display = 'none'; line.setAttribute('visibility', 'hidden'); return; }
    const t = (px - m.l) / pw, xv = xlog ? 10 ** (Math.log10(xr[0]) + t * (Math.log10(xr[1]) - Math.log10(xr[0]))) : xr[0] + t * (xr[1] - xr[0]);
    const rows = [];
    for (const s of vis) { if (!s.x?.length) continue; let bi = 0, bd = Infinity; for (let i = 0; i < s.x.length; i++) { const d = Math.abs(s.x[i] - xv); if (d < bd) { bd = d; bi = i; } } rows.push(`<span style="color:${s.color}">●</span> ${s.name || 'y'}: <b>${fmt(s.y[bi], 4)}</b>${spec.y?.unit ? ' ' + spec.y.unit : ''} <i>@ ${fmt(s.x[bi], 4)}</i>`); }
    line.setAttribute('x1', px); line.setAttribute('x2', px); line.setAttribute('visibility', 'visible');
    tip.innerHTML = `<div>${spec.x?.label || 'x'} ≈ ${fmt(xv, 4)}${spec.x?.unit ? ' ' + spec.x.unit : ''}</div>` + rows.join('<br>');
    tip.style.display = 'block'; const hx = ev.clientX - holder.getBoundingClientRect().left; tip.style.left = Math.min(holder.clientWidth - 230, hx + 12) + 'px'; tip.style.top = '8px';
  };
  svg.addEventListener('pointermove', move); svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; line.setAttribute('visibility', 'hidden'); });
}

function drawBar(svg, spec, W, H, hidden, holder, redraw) {
  const cats = spec.categories || [], series = (spec.series || []).map((s, i) => ({ ...s, color: s.color || palette(i), idx: i }));
  const vals = series.flatMap(s => s.values), lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const horiz = spec.horizontal;
  const m = { l: horiz ? Math.min(200, 12 + Math.max(...cats.map(c => String(c).length)) * 6.5) : 62, r: 18, t: 12, b: horiz ? 40 : 70 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b, fg = css('--fg', '#e5e7eb'), mute = css('--muted', '#94a3b8'), grid = css('--grid', 'rgba(148,163,184,.18)');
  const span = (hi - lo) || 1, pad = span * 0.08, a = lo < 0 ? lo - pad : 0, b = hi + pad;
  const sv = (v) => horiz ? m.l + (v - a) / (b - a) * pw : m.t + ph - (v - a) / (b - a) * ph;
  for (const t of niceTicks(a, b, 5)) { const p = sv(t); horiz ? el('line', { x1: p, x2: p, y1: m.t, y2: m.t + ph, stroke: grid }, svg) : el('line', { x1: m.l, x2: m.l + pw, y1: p, y2: p, stroke: grid }, svg); const tx = el('text', horiz ? { x: p, y: m.t + ph + 14, 'text-anchor': 'middle', fill: mute, 'font-size': 11 } : { x: m.l - 6, y: p + 4, 'text-anchor': 'end', fill: mute, 'font-size': 11 }, svg); tx.textContent = fmt(t, 3); }
  const band = (horiz ? ph : pw) / Math.max(1, cats.length), bw = band * 0.8 / Math.max(1, series.length);
  cats.forEach((c, ci) => {
    series.forEach((s, si) => {
      const v = s.values[ci]; if (!Number.isFinite(v)) return; const p0 = sv(0), p1 = sv(v); const off = (horiz ? m.t : m.l) + ci * band + band * 0.1 + si * bw;
      const color = s.colors ? s.colors[ci] : s.color;
      const r = horiz ? el('rect', { x: Math.min(p0, p1), y: off, width: Math.abs(p1 - p0), height: bw, fill: color, rx: 2 }, svg) : el('rect', { x: off, y: Math.min(p0, p1), width: bw, height: Math.abs(p1 - p0), fill: color, rx: 2 }, svg);
      const t = el('title', {}, r); t.textContent = `${c} — ${s.name || ''}: ${fmt(v, 4)} ${spec.y?.unit || ''}`;
      if (spec.showValues) el('text', horiz ? { x: Math.max(p0, p1) + 4, y: off + bw / 2 + 4, fill: fg, 'font-size': 10 } : { x: off + bw / 2, y: Math.min(p0, p1) - 3, 'text-anchor': 'middle', fill: fg, 'font-size': 10 }, svg).textContent = fmt(v, 3);
    });
    const lbl = horiz ? el('text', { x: m.l - 6, y: m.t + ci * band + band / 2 + 4, 'text-anchor': 'end', fill: fg, 'font-size': 11 }, svg) : el('text', { x: m.l + ci * band + band / 2, y: m.t + ph + 14, 'text-anchor': 'end', fill: fg, 'font-size': 11, transform: `rotate(-35 ${m.l + ci * band + band / 2} ${m.t + ph + 14})` }, svg);
    lbl.textContent = String(c).length > 28 ? String(c).slice(0, 27) + '…' : c;
  });
  el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'none', stroke: mute, 'stroke-opacity': .5 }, svg);
  const yl = (spec.y?.label || '') + (spec.y?.unit ? ` [${spec.y.unit}]` : '');
  if (horiz) el('text', { x: m.l + pw / 2, y: H - 4, 'text-anchor': 'middle', fill: fg, 'font-size': 12 }, svg).textContent = yl;
  else el('text', { x: 14, y: m.t + ph / 2, 'text-anchor': 'middle', fill: fg, 'font-size': 12, transform: `rotate(-90 14 ${m.t + ph / 2})` }, svg).textContent = yl;
  legend(svg, series, hidden, W, m, redraw);
}

function drawTornado(svg, spec, W, H) {
  const rows = spec.rows || [], base = spec.base ?? 0, fg = css('--fg', '#e5e7eb'), mute = css('--muted', '#94a3b8');
  const m = { l: Math.min(220, 14 + Math.max(10, ...rows.map(r => r.label.length)) * 6.4), r: 24, t: 14, b: 40 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const all = rows.flatMap(r => [r.lo, r.hi]).concat(base), lo = min(all), hi = max(all), pad = (hi - lo) * .08 || 1;
  const sx = (v) => m.l + (v - (lo - pad)) / ((hi - lo) + 2 * pad) * pw; const bh = ph / Math.max(1, rows.length);
  rows.forEach((r, i) => {
    const y = m.t + i * bh + bh * .15, h = bh * .7;
    el('rect', { x: Math.min(sx(base), sx(r.lo)), y, width: Math.abs(sx(r.lo) - sx(base)), height: h, fill: '#3b82f6', rx: 2 }, svg);
    el('rect', { x: Math.min(sx(base), sx(r.hi)), y, width: Math.abs(sx(r.hi) - sx(base)), height: h, fill: '#f97316', rx: 2 }, svg);
    el('text', { x: m.l - 6, y: y + h / 2 + 4, 'text-anchor': 'end', fill: fg, 'font-size': 11 }, svg).textContent = r.label;
    el('text', { x: sx(Math.max(r.lo, r.hi)) + 4, y: y + h / 2 + 4, fill: mute, 'font-size': 10 }, svg).textContent = fmt(r.hi, 3) + ' / ' + fmt(r.lo, 3);
  });
  el('line', { x1: sx(base), x2: sx(base), y1: m.t, y2: m.t + ph, stroke: fg, 'stroke-width': 1.5 }, svg);
  for (const t of niceTicks(lo - pad, hi + pad, 5)) el('text', { x: sx(t), y: m.t + ph + 14, 'text-anchor': 'middle', fill: mute, 'font-size': 11 }, svg).textContent = fmt(t, 3);
  el('text', { x: m.l + pw / 2, y: H - 4, 'text-anchor': 'middle', fill: fg, 'font-size': 12 }, svg).textContent = (spec.x?.label || 'Response') + (spec.x?.unit ? ` [${spec.x.unit}]` : '') + '  — blue: low input, orange: high input';
}

// Heatmap / filled contour with optional isolines and vector glyphs. z[j][i]: j over y, i over x.
function drawHeat(svg, spec, W, H, hidden, holder) {
  const xs = spec.x.values, ys = spec.y.values, Z = spec.z, nx = xs.length, ny = ys.length;
  const flat = Z.flat().filter(Number.isFinite); const zlo = spec.zmin ?? min(flat), zhi = spec.zmax ?? max(flat);
  const aspect = spec.equal ? (max(ys) - min(ys)) / ((max(xs) - min(xs)) || 1) : null;
  const W2 = W, H2 = aspect ? Math.min(560, Math.max(180, (W - 140) * aspect + 56)) : H;
  svg.setAttribute('viewBox', `0 0 ${W2} ${H2}`); svg.setAttribute('height', H2);
  const F = frame(svg, { ...spec, x: { ...spec.x }, y: { ...spec.y } }, W2 - 50, H2, [min(xs), max(xs)], [min(ys), max(ys)]);
  const { m, pw, ph, sx, sy } = F;
  const cv = document.createElement('canvas'); cv.width = nx; cv.height = ny; const ctx = cv.getContext('2d'); const img = ctx.createImageData(nx, ny);
  const levels = spec.levels || 0; const name = spec.cmap || 'viridis';
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let t = (Z[j][i] - zlo) / ((zhi - zlo) || 1); if (levels) t = Math.floor(t * levels) / levels;
    const k = ((ny - 1 - j) * nx + i) * 4; const v = Z[j][i];
    if (!Number.isFinite(v) || (spec.mask && spec.mask[j][i])) { img.data[k + 3] = 0; continue; }
    const c = cmap(t, name); img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  el('image', { href: cv.toDataURL(), x: m.l, y: m.t, width: pw, height: ph, preserveAspectRatio: 'none', style: 'image-rendering:auto' }, svg);
  if (spec.isolines) {
    for (const lv of linspace(zlo, zhi, spec.isolines + 2).slice(1, -1)) for (const seg of marchingSquares(xs, ys, Z, lv)) el('line', { x1: sx(seg[0]), y1: sy(seg[1]), x2: sx(seg[2]), y2: sy(seg[3]), stroke: '#fff', 'stroke-opacity': .45, 'stroke-width': .8 }, svg);
  }
  if (spec.vectors) { const { u, v, stride = 4, scale = 1 } = spec.vectors; const vmax = max(u.flat().map((a, k) => Math.hypot(a, v.flat()[k]))) || 1; const L = Math.min(pw / nx, ph / ny) * stride * 0.9 * scale; for (let j = 0; j < ny; j += stride) for (let i = 0; i < nx; i += stride) { if (spec.mask && spec.mask[j][i]) continue; const a = u[j][i] / vmax, b = v[j][i] / vmax, x0 = sx(xs[i]), y0 = sy(ys[j]), x1 = x0 + a * L, y1 = y0 - b * L; el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: '#fff', 'stroke-width': 1, 'stroke-opacity': .8 }, svg); el('circle', { cx: x1, cy: y1, r: 1.2, fill: '#fff' }, svg); } }
  for (const p of spec.overlay || []) el('path', { d: 'M' + p.pts.map(q => sx(q[0]).toFixed(1) + ',' + sy(q[1]).toFixed(1)).join('L') + (p.closed ? 'Z' : ''), fill: p.fill || 'none', stroke: p.stroke || '#fff', 'stroke-width': p.width || 1.5 }, svg);
  // colorbar
  const cbx = W2 - 44, cbh = ph; const grad = el('linearGradient', { id: 'cb' + nx + ny, x1: 0, y1: 1, x2: 0, y2: 0 }, el('defs', {}, svg));
  for (let k = 0; k <= 10; k++) el('stop', { offset: k / 10, 'stop-color': cssColor(cmap(k / 10, name)) }, grad);
  el('rect', { x: cbx, y: m.t, width: 12, height: cbh, fill: `url(#cb${nx}${ny})`, stroke: css('--muted', '#94a3b8'), 'stroke-opacity': .5 }, svg);
  for (const t of niceTicks(zlo, zhi, 5)) { const y = m.t + cbh - (t - zlo) / ((zhi - zlo) || 1) * cbh; if (y < m.t - 1 || y > m.t + cbh + 1) continue; el('text', { x: cbx + 15, y: y + 4, fill: css('--muted', '#94a3b8'), 'font-size': 10 }, svg).textContent = fmt(t, 3); }
  if (spec.z_label) el('text', { x: cbx + 6, y: m.t - 2, 'text-anchor': 'middle', fill: css('--fg', '#e5e7eb'), 'font-size': 10 }, svg).textContent = spec.z_label;
  // hover probe
  const tip = document.createElement('div'); tip.className = 'chart-tip'; holder.appendChild(tip);
  svg.addEventListener('pointermove', (ev) => { const r = svg.getBoundingClientRect(), sc = W2 / r.width, px = (ev.clientX - r.left) * sc, py = (ev.clientY - r.top) * sc; if (px < m.l || px > m.l + pw || py < m.t || py > m.t + ph) { tip.style.display = 'none'; return; } const i = clamp(Math.round((px - m.l) / pw * (nx - 1)), 0, nx - 1), j = clamp(Math.round((1 - (py - m.t) / ph) * (ny - 1)), 0, ny - 1); tip.innerHTML = `${spec.x.label || 'x'} ${fmt(xs[i], 4)}, ${spec.y.label || 'y'} ${fmt(ys[j], 4)}<br><b>${fmt(Z[j][i], 4)}</b> ${spec.z_label || ''}`; tip.style.display = 'block'; tip.style.left = Math.min(holder.clientWidth - 200, ev.clientX - holder.getBoundingClientRect().left + 12) + 'px'; tip.style.top = '8px'; });
  svg.addEventListener('pointerleave', () => tip.style.display = 'none');
}

export function marchingSquares(xs, ys, Z, lv) {
  const segs = [], nx = xs.length, ny = ys.length; const it = (a, b, va, vb) => a + (b - a) * (lv - va) / ((vb - va) || 1e-30);
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const v0 = Z[j][i], v1 = Z[j][i + 1], v2 = Z[j + 1][i + 1], v3 = Z[j + 1][i]; if (![v0, v1, v2, v3].every(Number.isFinite)) continue;
    const c = (v0 > lv) | ((v1 > lv) << 1) | ((v2 > lv) << 2) | ((v3 > lv) << 3); if (c === 0 || c === 15) continue;
    const x0 = xs[i], x1 = xs[i + 1], y0 = ys[j], y1 = ys[j + 1];
    const e = [[it(x0, x1, v0, v1), y0], [x1, it(y0, y1, v1, v2)], [it(x0, x1, v3, v2), y1], [x0, it(y0, y1, v0, v3)]];
    const T = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 2], [0, 1]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 10: [[0, 3], [1, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]] }[c];
    for (const [a, b] of T) segs.push([e[a][0], e[a][1], e[b][0], e[b][1]]);
  }
  return segs;
}

// Polar / wind-rose: spec.sectors (deg centres), spec.bins [{name, values[]}] stacked radially
function drawPolar(svg, spec, W, H) {
  const cx = W / 2, cy = H / 2 + 6, R = Math.min(W, H) / 2 - 34, fg = css('--fg', '#e5e7eb'), mute = css('--muted', '#94a3b8');
  const sectors = spec.sectors, bins = spec.bins, tot = sectors.map((_, k) => bins.reduce((s, b) => s + b.values[k], 0)), rmax = max(tot) || 1;
  for (const f of [0.25, 0.5, 0.75, 1]) { el('circle', { cx, cy, r: R * f, fill: 'none', stroke: mute, 'stroke-opacity': .3 }, svg); el('text', { x: cx + 3, y: cy - R * f - 2, fill: mute, 'font-size': 10 }, svg).textContent = fmt(rmax * f, 2) + (spec.unit || ''); }
  ['N', 'E', 'S', 'W'].forEach((d, i) => { const a = i * Math.PI / 2; el('text', { x: cx + (R + 14) * Math.sin(a), y: cy - (R + 14) * Math.cos(a) + 4, 'text-anchor': 'middle', fill: fg, 'font-size': 12, 'font-weight': 600 }, svg).textContent = d; });
  const dw = 2 * Math.PI / sectors.length * 0.9;
  sectors.forEach((sdeg, k) => {
    let r0 = 0; const a = sdeg * Math.PI / 180;
    bins.forEach((b, bi) => {
      const r1 = r0 + b.values[k]; if (r1 > r0) {
        const p = (rr, aa) => [cx + R * rr / rmax * Math.sin(aa), cy - R * rr / rmax * Math.cos(aa)];
        const A = p(r0, a - dw / 2), B = p(r1, a - dw / 2), C = p(r1, a + dw / 2), D = p(r0, a + dw / 2);
        el('path', { d: `M${A}L${B}A${R * r1 / rmax},${R * r1 / rmax} 0 0 1 ${C}L${D}A${R * r0 / rmax},${R * r0 / rmax} 0 0 0 ${A}Z`, fill: b.color || palette(bi), 'fill-opacity': .85, stroke: css('--bg', '#0b1020'), 'stroke-width': .5 }, svg);
      }
      r0 = r1;
    });
  });
  let ly = 16; bins.forEach((b, bi) => { el('rect', { x: 8, y: ly - 9, width: 10, height: 10, fill: b.color || palette(bi) }, svg); el('text', { x: 22, y: ly, fill: fg, 'font-size': 11 }, svg).textContent = b.name; ly += 15; });
}

function drawGauge(svg, spec, W, H) {
  const cx = W / 2, cy = H * 0.72, R = Math.min(W / 2.3, H * 0.62), v = clamp(spec.value / (spec.max || 1), 0, 1.2), fg = css('--fg', '#e5e7eb');
  const arc = (a0, a1, r, color, w) => { const p = (a) => [cx + r * Math.cos(Math.PI * (1 - a)), cy - r * Math.sin(Math.PI * (1 - a))]; el('path', { d: `M${p(a0)}A${r},${r} 0 0 1 ${p(a1)}`, stroke: color, 'stroke-width': w, fill: 'none', 'stroke-linecap': 'round' }, svg); };
  arc(0, 1, R, css('--grid', 'rgba(148,163,184,.25)'), 18); arc(0, Math.min(1, v), R, v >= 1 ? '#22c55e' : v > 0.5 ? '#eab308' : '#ef4444', 18);
  el('text', { x: cx, y: cy - 8, 'text-anchor': 'middle', fill: fg, 'font-size': 28, 'font-weight': 700 }, svg).textContent = fmt(spec.value, 3) + (spec.unit || '');
  el('text', { x: cx, y: cy + 16, 'text-anchor': 'middle', fill: css('--muted', '#94a3b8'), 'font-size': 12 }, svg).textContent = spec.caption || '';
}

// ---- export helpers ----
export function serialize(svg) { const c = svg.cloneNode(true); c.setAttribute('xmlns', NS); c.setAttribute('style', `background:${css('--panel', '#0f172a')};font-family:Inter,system-ui,sans-serif`); return new XMLSerializer().serializeToString(c); }
export function exportPNG(svg, title, scale = 3) {
  const vb = svg.viewBox.baseVal, img = new Image(), url = URL.createObjectURL(new Blob([serialize(svg)], { type: 'image/svg+xml' }));
  img.onload = () => { const c = document.createElement('canvas'); c.width = vb.width * scale; c.height = vb.height * scale; const x = c.getContext('2d'); x.fillStyle = css('--panel', '#0f172a'); x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height); c.toBlob(b => download(b, slug(title) + '.png')); URL.revokeObjectURL(url); };
  img.src = url;
}
export function toCSV(spec) {
  if (spec.type === 'bar') return ['category,' + spec.series.map(s => q(s.name)).join(','), ...spec.categories.map((c, i) => q(c) + ',' + spec.series.map(s => s.values[i]).join(','))].join('\n');
  if (spec.type === 'tornado') return ['parameter,low,high', ...spec.rows.map(r => `${q(r.label)},${r.lo},${r.hi}`)].join('\n');
  if (spec.type === 'heatmap' || spec.type === 'contour') { const o = ['y\\x,' + spec.x.values.join(',')]; spec.y.values.forEach((y, j) => o.push(y + ',' + spec.z[j].join(','))); return o.join('\n'); }
  if (spec.type === 'polar') return ['sector,' + spec.bins.map(b => q(b.name)).join(','), ...spec.sectors.map((s, k) => s + ',' + spec.bins.map(b => b.values[k]).join(','))].join('\n');
  const o = []; for (const s of spec.series || []) { o.push(`# ${s.name || 'series'}`); o.push(`${q(spec.x?.label || 'x')},${q(spec.y?.label || 'y')}`); s.x.forEach((x, i) => o.push(`${x},${s.y[i]}`)); }
  return o.join('\n');
}
const q = (s) => /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? '');
export const slug = (s) => (s || 'therma').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'therma';
export function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
