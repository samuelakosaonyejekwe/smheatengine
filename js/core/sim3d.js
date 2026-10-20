// 3D dynamic-simulation engine: playback timeline (play/pause/scrub/speed/loop/record video),
// field-coloured meshes, particle systems advected by solved velocity fields, streamlines and HUD overlays.
// wind/flow particle systems advected by solved velocity fields, streamlines and field-coloured meshes.
// Every animation is driven by solved time histories passed in by the suites — never decorative.
import { viewer, loadThree } from './viz3d.js';
import { Mesh } from './cad.js';
import { cmap } from './chart.js';
import { h } from './ui.js';
import { fmt, clamp, interp1 } from './num.js';

// ---------------- playback controller ----------------
export function playback(container, { duration, onFrame, onReset, fps = 60, label = 'Simulation time', unit = 's', autoplay = true, rate = 1 }) {
  let t = 0, playing = autoplay, speed = rate, loop = true, raf = 0, last = performance.now(), recorder = null, chunks = [];
  const play = h('button', { class: 'icon-btn', title: 'Play / pause' }, playing ? '⏸' : '▶');
  const slider = h('input', { type: 'range', min: 0, max: 1000, value: 0, style: 'flex:1', 'aria-label': 'Timeline' });
  const tlab = h('span', { class: 'small mono', style: 'min-width:120px;text-align:right' }, '');
  const sp = h('select', { title: 'Playback speed' }, ...[...new Set([0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 60, speed])].sort((a, b) => a - b).map(v => h('option', { value: v, selected: v === speed }, fmt(v, 3) + '×')));
  const loopB = h('button', { class: 'icon-btn on', title: 'Loop' }, '⟲');
  const rec = h('button', { class: 'icon-btn', title: 'Record the animation as a video file (WebM)' }, '⏺ Rec');
  const rst = h('button', { class: 'icon-btn', title: 'Reset the simulation to t = 0' }, '⏮');
  const bar = h('div', { class: 'sim-bar' }, rst, play, slider, tlab, sp, loopB, rec);
  container.append(bar);
  const set = (tt) => { t = clamp(tt, 0, duration); slider.value = Math.round(t / duration * 1000); tlab.textContent = `${label} ${fmt(t, 4)} ${unit}`; onFrame(t); };
  rst.onclick = () => { playing = false; play.textContent = '▶'; onReset?.(); set(0); };
  play.onclick = () => { playing = !playing; play.textContent = playing ? '⏸' : '▶'; last = performance.now(); };
  slider.oninput = () => { set(+slider.value / 1000 * duration); };
  sp.onchange = () => { speed = +sp.value; };
  loopB.onclick = () => { loop = !loop; loopB.classList.toggle('on', loop); };
  rec.onclick = () => {
    const cv = container.querySelector('canvas'); if (!cv?.captureStream || !window.MediaRecorder) { rec.textContent = 'n/a'; return; }
    if (recorder) { recorder.stop(); return; }
    chunks = []; recorder = new MediaRecorder(cv.captureStream(30), { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })); a.download = 'therma-simulation.webm'; a.click(); recorder = null; rec.textContent = '⏺ Rec'; rec.classList.remove('on'); };
    recorder.start(); rec.textContent = '■ Stop'; rec.classList.add('on'); set(0); playing = true; play.textContent = '⏸';
  };
  const tick = (now) => { raf = requestAnimationFrame(tick); const dt = Math.min(0.1, (now - last) / 1000); last = now; if (!playing) return; let nt = t + dt * speed; if (nt > duration) { if (recorder) { recorder.stop(); } if (loop && !recorder) nt = 0; else { nt = duration; playing = false; play.textContent = '▶'; } } set(nt); };
  set(0); raf = requestAnimationFrame(tick);
  let autoPaused = false; // pause while off-screen (battery), resume automatically when visible again
  const io = new IntersectionObserver((e) => { if (!e[0].isIntersecting) { if (playing) { autoPaused = true; playing = false; play.textContent = '▶'; } } else if (autoPaused) { autoPaused = false; playing = true; last = performance.now(); play.textContent = '⏸'; } }); io.observe(container);
  return { set, get t() { return t; }, play: () => { playing = true; play.textContent = '⏸'; }, pause: () => { playing = false; play.textContent = '▶'; }, dispose: () => { cancelAnimationFrame(raf); io.disconnect(); } };
}
// sample a time history {t:[], ...series} at time tt
export const sampleAt = (T, Y, tt) => interp1(T, Y, tt);

// ---------------- HUD overlay ----------------
export function hud(container) { const el = h('div', { class: 'sim-hud' }); container.append(el); return { set: (rows) => { el.innerHTML = rows.map(([k, v, c]) => `<div><span>${k}</span><b${c ? ` style="color:${c}"` : ''}>${v}</b></div>`).join(''); } }; }

// ---------------- particle flow system ----------------
// vel(x,y,z,t) -> [u,v,w] m/s in world frame; particles advected (RK2) and recycled at the inflow
export function particles(V, { count = 3000, bounds = [[-20, 20], [-12, 12], [0, 8]], vel, colorRange = [0, 12], size = 0.06, cmapName = 'turbo' }) {
  const THREE = V.THREE, pos = new Float32Array(count * 3), col = new Float32Array(count * 3), age = new Float32Array(count);
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < count; i++) { pos[i * 3] = rnd(...bounds[0]); pos[i * 3 + 1] = rnd(...bounds[1]); pos[i * 3 + 2] = rnd(...bounds[2]); age[i] = Math.random() * 6; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ size, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false })); V.root.add(pts);
  let center = [0, 0];
  const step = (dt, t) => {
    for (let i = 0; i < count; i++) {
      const k = i * 3; let x = pos[k], y = pos[k + 1], z = pos[k + 2];
      const a = vel(x, y, z, t), xm = x + a[0] * dt / 2, ym = y + a[1] * dt / 2, zm = z + a[2] * dt / 2, b = vel(xm, ym, zm, t);
      x += b[0] * dt; y += b[1] * dt; z += b[2] * dt; age[i] += dt;
      const out = x < center[0] + bounds[0][0] || x > center[0] + bounds[0][1] || y < center[1] + bounds[1][0] || y > center[1] + bounds[1][1] || z < bounds[2][0] || z > bounds[2][1] || age[i] > 8;
      if (out) { // re-seed upstream (opposite to local velocity)
        const sp = Math.hypot(b[0], b[1]) || 1, ux = b[0] / sp, uy = b[1] / sp, R = Math.max(bounds[0][1], bounds[1][1]);
        x = center[0] - ux * R * 0.9 + (-uy) * rnd(-R, R) * 0.9; y = center[1] - uy * R * 0.9 + ux * rnd(-R, R) * 0.9; z = rnd(...bounds[2]); age[i] = 0;
      }
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      const s = Math.hypot(...b), c = cmap((s - colorRange[0]) / (colorRange[1] - colorRange[0]), cmapName); col[k] = c[0] / 255; col[k + 1] = c[1] / 255; col[k + 2] = c[2] / 255;
    }
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
  };
  return { pts, step, setCenter: (x, y) => { center = [x, y]; }, dispose: () => { V.root.remove(pts); g.dispose(); } };
}

// ---------------- streamlines ----------------
export function streamlines(V, seeds, vel, { steps = 200, ds = 0.05, colorRange = [0, 12], cmapName = 'turbo', t = 0 } = {}) {
  const THREE = V.THREE, group = new THREE.Group(); V.root.add(group);
  for (const s of seeds) {
    const P = [], C = []; let [x, y, z] = s;
    for (let i = 0; i < steps; i++) { const v = vel(x, y, z, t), sp = Math.hypot(...v); if (!sp || !Number.isFinite(sp)) break; P.push(x, y, z); const c = cmap((sp - colorRange[0]) / (colorRange[1] - colorRange[0]), cmapName); C.push(c[0] / 255, c[1] / 255, c[2] / 255); x += v[0] / sp * ds; y += v[1] / sp * ds; z += v[2] / sp * ds; }
    if (P.length < 6) continue;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    group.add(new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true })));
  }
  return group;
}

// ---------------- generic field-coloured mesh from a Mesh + per-vertex value function ----------------
export function fieldMesh(V, mesh, valueFn, { cmapName = 'turbo', range, opacity = 1 } = {}) {
  const THREE = V.THREE, g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3)); g.setIndex(new THREE.BufferAttribute(mesh.indices, 1)); g.computeVertexNormals();
  const n = g.attributes.position.count, col = new Float32Array(n * 3); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const o = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.1, transparent: opacity < 1, opacity })); o.name = mesh.name; V.root.add(o);
  const update = (fn = valueFn, rg = range) => { const P = g.attributes.position.array; const vals = new Float32Array(n); for (let k = 0; k < n; k++) vals[k] = fn(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], k); const lo = rg?.[0] ?? Math.min(...vals), hi = rg?.[1] ?? Math.max(...vals); for (let k = 0; k < n; k++) { const c = cmap((vals[k] - lo) / ((hi - lo) || 1), cmapName); col[k * 3] = c[0] / 255; col[k * 3 + 1] = c[1] / 255; col[k * 3 + 2] = c[2] / 255; } g.attributes.color.needsUpdate = true; return { lo, hi }; };
  update(); return { o, update, mesh };
}
// colour legend overlay for 3D scenes
export function legend3d(container, { title, lo, hi, unit = '', cmapName = 'turbo' }) {
  const stops = Array.from({ length: 11 }, (_, i) => { const c = cmap(i / 10, cmapName); return `rgb(${c.map(Math.round).join(',')}) ${i * 10}%`; }).join(',');
  const el = h('div', { class: 'sim-legend' }, h('div', { class: 'small' }, title), h('div', { style: `height:10px;border-radius:4px;background:linear-gradient(90deg,${stops})` }), h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: 'small' }, fmt(lo, 3) + unit), h('span', { class: 'small' }, fmt(hi, 3) + unit)));
  container.append(el); return { set: (l, hh) => { el.lastChild.firstChild.textContent = fmt(l, 3) + unit; el.lastChild.lastChild.textContent = fmt(hh, 3) + unit; } };
}
export { Mesh };

// Displacement magnifier: slider + label "×N (true-scale peak = …)". auto = suggested factor so the solved
// peak displacement becomes clearly visible; returns { get value } and calls onChange(N).
export function magnifier(container, { auto = 1, truePeak = 0, unit = '', max = 500, onChange } = {}) {
  let N = Math.max(1, Math.min(max, Math.round(auto)));
  const lab = h('span', { class: 'small mono' }), sl = h('input', { type: 'range', min: 0, max: Math.log10(max), step: 0.01, value: Math.log10(N), style: 'width:140px', title: 'Displacement magnification' });
  const upd = () => { lab.textContent = `×${N} (true-scale peak = ${fmt(truePeak, 3)}${unit})`; onChange?.(N); };
  sl.oninput = () => { N = Math.max(1, Math.round(10 ** +sl.value)); upd(); };
  container.append(h('div', { class: 'sim-bar', style: 'border-top:0' }, h('span', { class: 'small' }, 'Magnification'), sl, lab)); upd();
  return { get value() { return N; } };
}
// Slow turntable rotation for scenes whose solved state is static (keeps the view alive; geometry unchanged).
export function turntable(V, rate = 0.15) { let a = 0; V.animate = (dt) => { a += dt * rate; V.root.rotation.z = a; }; }
// Flow tracers: small spheres travelling along a polyline at a speed ∝ solved flow magnitude.
export function tracers(V, pts, { n = 8, color = 0xf97316, size = 0.025 } = {}) {
  const THREE = V.THREE, P = pts.map(p => new THREE.Vector3(...p)), seg = [], tot = P.slice(1).reduce((s, p, i) => { const l = p.distanceTo(P[i]); seg.push(l); return s + l; }, 0);
  const balls = Array.from({ length: n }, () => { const m = new THREE.Mesh(new THREE.SphereGeometry(size, 10, 8), new THREE.MeshBasicMaterial({ color })); V.root.add(m); return m; });
  let s0 = 0;
  return { step(dt, speed) { s0 = (s0 + dt * speed) % 1; balls.forEach((b, k) => { let d = ((s0 + k / n) % 1) * tot, i = 0; while (i < seg.length - 1 && d > seg[i]) { d -= seg[i]; i++; } b.position.copy(P[i]).lerp(P[i + 1], Math.min(1, d / (seg[i] || 1))); b.visible = speed > 1e-6; }); } };
}

// ---------------- 2D animated canvas driven by the playback timeline ----------------
// onFrame(t, g): g.clear(); const P = g.panel(x, y, w, h, { xr, yr, xlabel, ylabel, title }); P.line(xs, ys, color) …
function anim2dPanel(container, { height = 380, duration, rate = 1, label = 'Time', unit = 's', onFrame }) {
  const css = (n, f) => { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f; } catch { return f; } };
  const box = h('div', { class: 'viewer', style: 'position:relative' }); container.append(box);
  const cv = h('canvas', { style: `width:100%;height:${height}px;display:block;background:${css('--panel', '#111a2e')}` }); box.append(cv);
  const ctx = cv.getContext('2d'); let W = 0, H = height;
  const size = () => { const dpr = Math.min(2, window.devicePixelRatio || 1); W = cv.clientWidth || 600; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  size(); const ro = new ResizeObserver(size); ro.observe(cv);
  const fg = css('--fg', '#e5e7eb'), mute = css('--muted', '#94a3b8'), grid = css('--grid', 'rgba(148,163,184,.2)');
  const g = {
    ctx, get W() { return W; }, get H() { return H; }, fg, mute,
    clear() { ctx.fillStyle = css('--panel', '#111a2e'); ctx.fillRect(0, 0, W, H); },
    text(s, x, y, { color = fg, size = 12, align = 'left', bold = false } = {}) { ctx.fillStyle = color; ctx.font = `${bold ? 700 : 400} ${size}px Inter, system-ui, sans-serif`; ctx.textAlign = align; ctx.fillText(s, x, y); },
    panel(x, y, w, hh, { xr, yr, xlabel = '', ylabel = '', title = '' }) {
      const m = { l: 46, r: 8, t: title ? 20 : 8, b: 30 }, px = x + m.l, py = y + m.t, pw = w - m.l - m.r, ph = hh - m.t - m.b;
      const sx = (v) => px + (v - xr[0]) / ((xr[1] - xr[0]) || 1) * pw, sy = (v) => py + ph - (v - yr[0]) / ((yr[1] - yr[0]) || 1) * ph;
      ctx.strokeStyle = grid; ctx.lineWidth = 1; for (let k = 0; k <= 4; k++) { const yy = py + ph * k / 4; ctx.beginPath(); ctx.moveTo(px, yy); ctx.lineTo(px + pw, yy); ctx.stroke(); g.text(fmt(yr[1] - (yr[1] - yr[0]) * k / 4, 3), px - 4, yy + 4, { color: mute, size: 10, align: 'right' }); }
      for (let k = 0; k <= 4; k++) g.text(fmt(xr[0] + (xr[1] - xr[0]) * k / 4, 3), px + pw * k / 4, py + ph + 13, { color: mute, size: 10, align: 'center' });
      ctx.strokeStyle = mute; ctx.strokeRect(px, py, pw, ph);
      if (title) g.text(title, x + 4, y + 13, { bold: true, size: 12 });
      g.text(xlabel, px + pw / 2, py + ph + 26, { color: fg, size: 11, align: 'center' });
      ctx.save(); ctx.translate(x + 11, py + ph / 2); ctx.rotate(-Math.PI / 2); g.text(ylabel, 0, 0, { color: fg, size: 11, align: 'center' }); ctx.restore();
      const P = {
        sx, sy, px, py, pw, ph,
        line(xs, ys, color = '#38bdf8', width = 2, dash) { ctx.save(); ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.beginPath(); let first = true; for (let i = 0; i < xs.length; i++) { if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) { first = true; continue; } const X = sx(xs[i]), Y = sy(ys[i]); if (first) { ctx.moveTo(X, Y); first = false; } else ctx.lineTo(X, Y); } ctx.stroke(); ctx.restore(); },
        point(x0, y0, color = '#facc15', r = 5) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sx(x0), sy(y0), r, 0, 2 * Math.PI); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 0.6; ctx.stroke(); },
        vline(x0, color = '#a855f7') { ctx.strokeStyle = color; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(sx(x0), py); ctx.lineTo(sx(x0), py + ph); ctx.stroke(); ctx.setLineDash([]); },
        hline(y0, color = '#ef4444') { ctx.strokeStyle = color; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(px, sy(y0)); ctx.lineTo(px + pw, sy(y0)); ctx.stroke(); ctx.setLineDash([]); },
        bar(x0, w0, y0, y1, color) { ctx.fillStyle = color; const a = sx(x0 - w0 / 2), b = sx(x0 + w0 / 2); ctx.fillRect(a, Math.min(sy(y0), sy(y1)), b - a, Math.abs(sy(y1) - sy(y0))); },
        area(xs, ys, color) { ctx.save(); ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip(); ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(sx(xs[0]), sy(Math.max(yr[0], 0))); xs.forEach((x1, i) => ctx.lineTo(sx(x1), sy(ys[i]))); ctx.lineTo(sx(xs[xs.length - 1]), sy(Math.max(yr[0], 0))); ctx.closePath(); ctx.fill(); ctx.restore(); },
      };
      return P;
    },
    gauge(x, y, w, frac, labelTxt, color = '#22c55e') { ctx.fillStyle = grid; ctx.fillRect(x, y, w, 12); ctx.fillStyle = color; ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), 12); ctx.strokeStyle = mute; ctx.strokeRect(x, y, w, 12); g.text(labelTxt, x, y - 4, { size: 11 }); },
  };
  const pb = playback(box, { duration, rate, label, unit, onFrame: (t) => { if (!W) size(); onFrame(t, g); } });
  return { box, g, pb, dispose: () => { ro.disconnect(); pb.dispose(); } };
}

// ---------------- 2-D animation canvas synced to the playback timeline ----------------
// draw(g, t, W, H) is called every frame with a cleared, DPR-scaled 2-D context; returns the playback controller.
function anim2dDraw(container, { duration, draw, height = 420, label = 'Animation time', unit = 's', rate = 1, autoplay = true }) {
  const wrap = h('div', { class: 'viewer anim2d' }), cv = h('canvas', { style: `width:100%;height:${height}px;display:block;background:var(--panel2)` });
  wrap.append(cv); container.append(wrap);
  const g = cv.getContext('2d'); let W = 0, H = 0;
  const size = () => { const r = cv.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1); W = r.width || 600; H = r.height || height; cv.width = Math.round(W * d); cv.height = Math.round(H * d); g.setTransform(d, 0, 0, d, 0, 0); };
  size(); const ro = new ResizeObserver(() => size()); ro.observe(cv);
  const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#e5e7eb', mute = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#94a3b8';
  const pb = playback(wrap, { duration, label, unit, rate, autoplay, onFrame: (t) => { g.clearRect(0, 0, W, H); g.save(); g.fillStyle = fg; g.strokeStyle = fg; g.font = '12px system-ui, sans-serif'; try { draw(g, t, W, H, { fg, mute }); } catch (e) { g.fillStyle = '#ef4444'; g.fillText('Animation error: ' + e.message, 10, 20); } g.restore(); } });
  return { ...pb, canvas: cv, dispose: () => { pb.dispose(); ro.disconnect(); } };
}
// simple axes helper for 2-D animated plots: returns mapping functions
export function axes2d(g, { x0, y0, w, h: hh, xr, yr, xl = '', yl = '', fg = '#e5e7eb', mute = '#94a3b8', grid = true }) {
  const X = (v) => x0 + (v - xr[0]) / ((xr[1] - xr[0]) || 1) * w, Y = (v) => y0 + hh - (v - yr[0]) / ((yr[1] - yr[0]) || 1) * hh;
  g.save(); g.strokeStyle = mute; g.globalAlpha = 0.5; g.strokeRect(x0, y0, w, hh); g.globalAlpha = 1; g.fillStyle = mute; g.font = '11px system-ui, sans-serif';
  const tick = (a, b) => { const span = b - a, st = 10 ** Math.floor(Math.log10(span / 4)); const m = span / st > 10 ? 5 : span / st > 4 ? 2 : 1; const s = st * m, o = []; for (let v = Math.ceil(a / s) * s; v <= b + 1e-9; v += s) o.push(+v.toPrecision(6)); return o; };
  for (const v of tick(...xr)) { const x = X(v); if (grid) { g.globalAlpha = 0.15; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y0 + hh); g.stroke(); g.globalAlpha = 1; } g.fillText(fmt(v, 3), x - 10, y0 + hh + 13); }
  for (const v of tick(...yr)) { const y = Y(v); if (grid) { g.globalAlpha = 0.15; g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + w, y); g.stroke(); g.globalAlpha = 1; } g.fillText(fmt(v, 3), x0 - 34, y + 4); }
  g.fillStyle = fg; g.fillText(xl, x0 + w / 2 - g.measureText(xl).width / 2, y0 + hh + 27); g.save(); g.translate(x0 - 44, y0 + hh / 2); g.rotate(-Math.PI / 2); g.fillText(yl, -g.measureText(yl).width / 2, 0); g.restore();
  g.restore(); return { X, Y };
}
export function polyline(g, pts, color, width = 2, dash) { if (pts.length < 2) return; g.save(); g.strokeStyle = color; g.lineWidth = width; if (dash) g.setLineDash(dash); g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.restore(); }
export const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;

// Single public entry point for 2-D animations: `onFrame(t, g)` uses the panel helper API; `draw(ctx, t, W, H)` gets a raw context.
export function anim2d(container, opts) { return opts.draw ? anim2dDraw(container, opts) : anim2dPanel(container, opts); }
