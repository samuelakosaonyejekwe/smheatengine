// THERMA-X100 physics-driven 3-D dynamic simulations. Every motion, colour and flow in these scenes is read from solved
// time histories (sim3d-therma.js): transient ribbon cell, Suite 11 shaft integrator, Suite 15 start-up, the microchannel
// unit-cell FE transient and the compliant-transmission models. Registry: VIEWS3D[suiteId] = [{label, icon, render(el, ctx, res, p)}].
import { viewer } from './viz3d.js';
import { playback, hud, legend3d } from './sim3d.js';
import { cmap } from './chart.js';
import { h } from './ui.js';
import { fmt, clamp, range } from './num.js';
import { loft, box as cadBox } from './cad.js';
import { fluid as fluidProps } from './heat.js';
import { hydraulics } from './engine.js';
import * as S from './sim3d-therma.js';

const TAU = 2 * Math.PI, SVGNS = 'http://www.w3.org/2000/svg';
const f3 = (v) => fmt(v, 3), f4 = (v) => fmt(v, 4);
const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const lerpArr = (a, i, f) => a[i] + ((a[i + 1] ?? a[i]) - a[i]) * f;

// ---------------- physically based material library ----------------
const PBR = {
  niti: { color: 0xb48a5c, metalness: 0.82, roughness: 0.34, name: 'NiTi ribbon (satin, oxide-free)' },
  steel: { color: 0xd3d8de, metalness: 1, roughness: 0.18, name: 'Polished steel' },
  ss: { color: 0xa9b1bb, metalness: 0.92, roughness: 0.3, name: 'Brushed stainless 316L' },
  alu: { color: 0x6f86a8, metalness: 0.72, roughness: 0.36, name: 'Anodised aluminium' },
  dark: { color: 0x3a4250, metalness: 0.6, roughness: 0.42, name: 'Black-oxide steel' },
  peek: { color: 0xcdb98e, metalness: 0, roughness: 0.52, name: 'PEEK' },
  clear: { color: 0xa9c4e6, metalness: 0, roughness: 0.08, opacity: 0.2, clearcoat: 1, name: 'Polycarbonate housing (transparent)' },
  glass: { color: 0x8ea6c4, metalness: 0, roughness: 0.05, opacity: 0.1, clearcoat: 1, name: 'Casing (shown transparent)' },
  hot: { color: 0xc2410c, metalness: 0.55, roughness: 0.32, name: 'Hot manifold (anodised)' },
  cold: { color: 0x1d4ed8, metalness: 0.55, roughness: 0.32, name: 'Cold manifold (anodised)' },
  rubber: { color: 0x1f2328, metalness: 0, roughness: 0.8, name: 'Elastomer' },
};

// ---------------- stage: viewer + quality rig + overlays + lifecycle ----------------
async function stage(el, { height = 520, explain = '', mm = false } = {}) {
  el.innerHTML = '';
  const vbox = h('div'), ctrl = h('div', { class: 'sim-bar', style: 'border:1px solid var(--line);border-radius:10px;margin-top:6px' }), expl = h('p', { class: 'small muted', style: 'margin-top:8px;line-height:1.5' });
  const H = Math.min(height, Math.max(340, Math.round((el.clientWidth || 800) * 0.75)));
  el.append(vbox, ctrl, expl); ctrl.style.display = 'none';
  new MutationObserver(() => { ctrl.style.display = ctrl.childElementCount ? '' : 'none'; }).observe(ctrl, { childList: true });
  const V = await viewer(vbox, { grid: false, height: H });
  const T = V.THREE, R = V.renderer;
  R.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  R.shadowMap.enabled = true; R.shadowMap.type = T.PCFSoftShadowMap; R.toneMappingExposure = 1.0;
  // clipping planes of the viewer's Section tool (probe one viewer-made material)
  const probe = V.add(cadBox('probe', 1e-9, 1e-9, 1e-9)), clip = probe.material.clippingPlanes; V.root.remove(probe); V.objects.splice(V.objects.indexOf(probe), 1); probe.geometry.dispose(); probe.material.dispose();
  // studio environment (PMREM of an emissive-panel room) for physically based reflections
  const bgc = V.scene.background, dark = bgc && bgc.r + bgc.g + bgc.b < 1.2;
  { const sc = new T.Scene(), room = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial({ side: T.BackSide, color: dark ? 0x30343c : 0x8a9099 })); room.scale.setScalar(20); sc.add(room);
    const panel = (c, i, p, s) => { const m = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ color: new T.Color(c).multiplyScalar(i) })); m.position.set(...p); m.scale.set(s[0], s[1], 1); m.lookAt(0, 0, 0); sc.add(m); };
    panel(0xffffff, 5, [0, 0, 9.5], [12, 12]); panel(0xdfe8ff, 2.6, [9.5, -3, 3], [6, 8]); panel(0xffeedd, 2.4, [-9.5, 4, 2], [6, 8]); panel(0xffffff, 1.2, [0, 9.5, 3], [10, 4]); panel(0xffffff, 1.4, [0, -9.5, 2], [10, 4]);
    const pm = new T.PMREMGenerator(R), rt = pm.fromScene(sc, 0.04); V.scene.environment = rt.texture; pm.dispose(); sc.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); }
  // clean vertical background gradient
  { const cv = document.createElement('canvas'); cv.width = 4; cv.height = 256; const g = cv.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
    if (dark) { gr.addColorStop(0, '#1d2638'); gr.addColorStop(1, '#070a12'); } else { gr.addColorStop(0, '#fbfcfe'); gr.addColorStop(1, '#d5dde8'); }
    g.fillStyle = gr; g.fillRect(0, 0, 4, 256); const tx = new T.CanvasTexture(cv); tx.colorSpace = T.SRGBColorSpace; V.scene.background = tx; }
  let sun = null; V.scene.traverse(o => { if (o.isDirectionalLight && !sun) sun = o; if (o.isLight) o.intensity *= 0.62; });
  if (sun) { sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 4; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; V.scene.add(sun.target); }
  const disposables = [], extras = [];
  const S0 = { V, T, clip, vbox, ctrl, expl, dark, H, sun, disposables, mm };
  S0.mat = (key, over = {}) => { const b = { ...PBR[key], ...over }, op = b.opacity ?? 1; const m = new T.MeshPhysicalMaterial({ color: b.color, metalness: b.metalness, roughness: b.roughness, clearcoat: b.clearcoat || 0, clearcoatRoughness: 0.1, transparent: op < 1, opacity: op, depthWrite: op >= 1, side: T.DoubleSide, clippingPlanes: clip, envMapIntensity: 1, emissive: b.emissive ?? 0x000000 }); m.userData.label = b.name; return m; };
  S0.geom = (mesh, crease = 35) => creased(T, mesh, crease);
  // add an object that participates in the viewer tools (hover, x-ray, explode) under an arbitrary parent
  S0.add = (parent, geom, material, { name = '', group = '', center = [0, 0, 0], edges = false, shadow = true, edgeGeom = null } = {}) => {
    const o = new T.Mesh(geom, material); o.name = name; o.castShadow = shadow && material.opacity >= 1; o.receiveShadow = shadow;
    o.userData = { group, material: material.userData.label, baseOpacity: material.opacity, center, field: null };
    if (edges) { const eg = edgeGeom || new T.EdgesGeometry(geom, 28); const l = new T.LineSegments(eg, new T.LineBasicMaterial({ color: dark ? 0x0b0f17 : 0x1f2937, transparent: true, opacity: 0.38, clippingPlanes: clip })); l.raycast = () => { }; o.add(l); }
    parent.add(o); V.objects.push(o); return o;
  };
  // lay the model on a shadow-catching ground with a grid; adapt camera planes and shadow frustum to the model size
  S0.finish = (frame = V.root, zoom = 0.62) => {
    const bb = new T.Box3().setFromObject(frame), size = bb.getSize(new T.Vector3()), c = bb.getCenter(new T.Vector3()), L = Math.max(size.x, size.y, size.z) || 1;
    const z0 = bb.min.z - 0.02 * L;
    const ground = new T.Mesh(new T.PlaneGeometry(L * 6, L * 6), new T.ShadowMaterial({ opacity: dark ? 0.45 : 0.22 })); ground.position.set(c.x, c.y, z0); ground.receiveShadow = true; V.scene.add(ground); extras.push(ground);
    const grid = new T.GridHelper(L * 6, 36, dark ? 0x334155 : 0x94a3b8, dark ? 0x1e293b : 0xcbd5e1); grid.rotation.x = Math.PI / 2; grid.position.set(c.x, c.y, z0 - 1e-4 * L); grid.material.transparent = true; grid.material.opacity = 0.45; V.scene.add(grid); extras.push(grid);
    if (sun) { sun.position.set(c.x + 1.2 * L, c.y - 1.5 * L, c.z + 2.4 * L); sun.target.position.copy(c); const sc = sun.shadow.camera; sc.left = sc.bottom = -1.1 * L; sc.right = sc.top = 1.1 * L; sc.near = 0.05 * L; sc.far = 6 * L; sc.updateProjectionMatrix(); }
    V.camera.near = L / 400; V.camera.far = L * 60; V.camera.updateProjectionMatrix(); V.fit(); V.camera.position.lerp(V.controls.target, 1 - zoom); V.controls.update();
    S0.info = () => R.info.render;
    return { L, c, z0 };
  };
  S0.hud = hud(vbox); S0.labels = callouts(V, vbox);
  S0.legend = null; S0.setLegend = (o) => { vbox.querySelector('.sim-legend')?.remove(); S0.legend = legend3d(vbox, o); };
  S0.button = (txt, title, fn, on = false) => { const b = h('button', { class: 'icon-btn sm' + (on ? ' on' : ''), title }, txt); b.onclick = () => fn(b); ctrl.append(b); return b; };
  S0.group = (txt, opts, cur, fn) => { const span = h('span', { class: 'row', style: 'gap:4px;align-items:center' }, h('span', { class: 'small muted' }, txt)); const bs = opts.map(([v, l]) => { const b = h('button', { class: 'icon-btn sm' + (v === cur ? ' on' : '') }, l); b.onclick = () => { bs.forEach(x => x.classList.remove('on')); b.classList.add('on'); fn(v); }; return b; }); span.append(...bs); ctrl.append(span); return span; };
  S0.slider = (txt, { min, max, value, step = 1, fmtv = (v) => v, onInput }) => { const lab = h('span', { class: 'small mono' }), sl = h('input', { type: 'range', min, max, value, step, style: 'width:130px' }); const upd = () => { lab.textContent = fmtv(+sl.value); onInput(+sl.value); }; sl.oninput = upd; ctrl.append(h('span', { class: 'row', style: 'gap:6px;align-items:center' }, h('span', { class: 'small muted' }, txt), sl, lab)); upd(); return sl; };
  S0.explain = (html) => { expl.innerHTML = html; };
  S0.timeline = (o) => { S0.pb = playback(vbox, { autoplay: !reducedMotion(), ...o }); return S0.pb; };
  // lifecycle: release GPU resources and timers when the page is left
  const watch = setInterval(() => { if (!el.isConnected) S0.dispose(); }, 1000);
  S0.dispose = () => { clearInterval(watch); try { S0.pb?.dispose(); } catch { /* gone */ } for (const d of disposables) try { d(); } catch { /* gone */ }
    for (const o of extras) { V.scene.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    V.root.traverse(o => { o.geometry?.dispose?.(); const m = o.material; if (Array.isArray(m)) m.forEach(x => x.dispose()); else m?.dispose?.(); });
    V.scene.environment?.dispose(); V.scene.background?.dispose?.(); V.dispose(); };
  if (explain) S0.explain(explain);
  el.__sim3d = S0;
  return S0;
}
const loading = (el, msg) => { el.innerHTML = ''; const d = h('div', { class: 'callout info' }, msg); el.append(d); return d; };
const failBox = (el, msg) => { el.innerHTML = ''; el.append(h('div', { class: 'callout warn' }, msg)); };

// geometry with crease-angle normals: crisp machined edges, smooth curved surfaces
function creased(T, mesh, creaseDeg = 35) {
  const P = mesh.p, I = mesh.i, nT = I.length / 3, pos = new Float32Array(nT * 9), nor = new Float32Array(nT * 9), fn = new Float32Array(nT * 3), map = new Map(), keys = new Array(nT * 3);
  for (let t = 0; t < nT; t++) {
    const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; fn[3 * t] = nx / l; fn[3 * t + 1] = ny / l; fn[3 * t + 2] = nz / l;
    for (let k = 0; k < 3; k++) { const v = I[3 * t + k] * 3; pos.set([P[v], P[v + 1], P[v + 2]], 9 * t + 3 * k); const key = `${Math.round(P[v] * 1e8)},${Math.round(P[v + 1] * 1e8)},${Math.round(P[v + 2] * 1e8)}`; keys[3 * t + k] = key; let L = map.get(key); if (!L) map.set(key, L = []); L.push(t); }
  }
  const cs = Math.cos(creaseDeg * Math.PI / 180);
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) {
    let sx = 0, sy = 0, sz = 0; for (const u of map.get(keys[3 * t + k])) { const d = fn[3 * t] * fn[3 * u] + fn[3 * t + 1] * fn[3 * u + 1] + fn[3 * t + 2] * fn[3 * u + 2]; if (d >= cs) { sx += fn[3 * u]; sy += fn[3 * u + 1]; sz += fn[3 * u + 2]; } }
    const l = Math.hypot(sx, sy, sz) || 1; nor[9 * t + 3 * k] = sx / l; nor[9 * t + 3 * k + 1] = sy / l; nor[9 * t + 3 * k + 2] = sz / l;
  }
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('normal', new T.BufferAttribute(nor, 3)); g.computeBoundingSphere(); return g;
}
// light helix (display mesh of the bias spring; dimensions from the CAD parameters)
function helixMesh(name, { R, rw, n, L, sides = 8, perTurn = 16 }) {
  const N = Math.max(16, Math.round(n * perTurn)), a = L / (TAU * n), secs = [];
  for (let k = 0; k <= N; k++) {
    const th = TAU * n * k / N, c = [a * th, R * Math.cos(th), R * Math.sin(th)], t = [a, -R * Math.sin(th), R * Math.cos(th)], tl = Math.hypot(...t), Tt = t.map(v => v / tl), Nn = [0, -Math.cos(th), -Math.sin(th)];
    const B = [Tt[1] * Nn[2] - Tt[2] * Nn[1], Tt[2] * Nn[0] - Tt[0] * Nn[2], Tt[0] * Nn[1] - Tt[1] * Nn[0]];
    secs.push(range(sides).map(j => { const ph = TAU * j / sides, cp = Math.cos(ph), sp = Math.sin(ph); return [0, 1, 2].map(d => c[d] + rw * (cp * Nn[d] + sp * B[d])); }));
  }
  return loft(name, secs);
}
// sRGB colour-map sample → linear THREE colour
const setCol = (T, target, u, name = 'turbo') => { const c = cmap(clamp(u, 0, 1), name); target.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, T.SRGBColorSpace); return target; };
// soft round sprite for particles
function dotTexture(T) { const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 30); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); const t = new T.CanvasTexture(cv); return t; }
function pointCloud(S0, n, size) {
  const T = S0.T, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('color', new T.BufferAttribute(col, 3));
  const m = new T.PointsMaterial({ size, map: dotTexture(T), vertexColors: true, transparent: true, depthWrite: false, alphaTest: 0.05, sizeAttenuation: true, clippingPlanes: S0.clip });
  const p = new T.Points(g, m); p.frustumCulled = false; p.raycast = () => { }; S0.V.root.add(p); return { p, pos, col, g, flush() { g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; } };
}

// ---------------- HTML callouts with leader lines (greedy vertical de-overlap) ----------------
function callouts(V, box) {
  const lay = h('div', { style: 'position:absolute;left:0;top:0;right:0;pointer-events:none;overflow:hidden' }), svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;overflow:visible'); lay.append(svg); box.append(lay);
  const items = []; let on = true; const v3 = new V.THREE.Vector3();
  const api = {
    add(text, pos, color = '#94a3b8') { const d = h('div', { style: `position:absolute;font:600 11px Inter,system-ui,sans-serif;padding:2px 7px;border-radius:6px;white-space:nowrap;background:color-mix(in srgb,var(--bg2,#0f172a) 86%,transparent);border:1px solid ${color};color:var(--fg,#e5e7eb)` }, text); const ln = document.createElementNS(SVGNS, 'line'); ln.setAttribute('stroke', color); ln.setAttribute('stroke-width', '1'); const dot = document.createElementNS(SVGNS, 'circle'); dot.setAttribute('r', '2.5'); dot.setAttribute('fill', color); svg.append(ln, dot); lay.append(d); items.push({ d, ln, dot, pos }); return d; },
    set visible(v) { on = v; lay.style.display = v ? '' : 'none'; }, get visible() { return on; },
    update() {
      if (!on || !items.length) return; const cv = V.renderer.domElement, W = cv.clientWidth, H = cv.clientHeight; lay.style.height = H + 'px';
      const vis = [];
      for (const it of items) { it.pos(v3); v3.project(V.camera); const ok = v3.z < 1 && Math.abs(v3.x) < 1.05 && Math.abs(v3.y) < 1.05; it.d.style.display = ok ? '' : 'none'; it.ln.style.display = it.dot.style.display = ok ? '' : 'none'; if (ok) { it.sx = (v3.x + 1) / 2 * W; it.sy = (1 - v3.y) / 2 * H; vis.push(it); } }
      const br = box.getBoundingClientRect(), hr = box.querySelector('.sim-hud')?.getBoundingClientRect(), lr = box.querySelector('.sim-legend')?.getBoundingClientRect();
      const hudB = hr && hr.width ? hr.bottom - br.top : 0, legT = lr && lr.width ? lr.top - br.top : H;
      for (const side of [0, 1]) {
        const S2 = vis.filter(it => (it.sx > W / 2 ? 1 : 0) === side).sort((a, b) => a.sy - b.sy); let yb = side ? Math.max(6, hudB + 6) : 40;
        for (const it of S2) { const hgt = it.d.offsetHeight || 18, wd = it.d.offsetWidth || 80; let y = Math.max(it.sy - 34, yb); y = Math.min(y, (side ? legT : H) - hgt - 4); yb = y + hgt + 4; const x = side ? Math.min(W - wd - 6, it.sx + 26) : Math.max(6, it.sx - 26 - wd); it.d.style.left = x + 'px'; it.d.style.top = y + 'px'; const lx = side ? x : x + wd, ly = y + hgt / 2; it.ln.setAttribute('x1', it.sx); it.ln.setAttribute('y1', it.sy); it.ln.setAttribute('x2', lx); it.ln.setAttribute('y2', ly); it.dot.setAttribute('cx', it.sx); it.dot.setAttribute('cy', it.sy); }
      }
    },
  };
  return api;
}
// keep a continuously increasing display angle when the timeline loops (θ(t) is periodic only in ω)
function loopAngle(span) { let last = 0, acc = 0; return (t, th) => { if (t < last - 0.5 * span.duration) acc += span.dTheta; else if (t > last + 0.5 * span.duration) acc -= span.dTheta; last = t; return th + acc; }; }
// simulation-time step between two timeline frames (0 on scrubs and loop jumps)
function stepper(duration) { let last = null; return (t) => { const d = last === null ? 0 : t - last; last = t; return d > 0 && d < 0.25 * duration ? d : 0; }; }

// =====================================================================================================================
// Shared cartridge display model (local frame: x along the ribbons, y width, z through the stack; same solids as Suite 02)
// =====================================================================================================================
function cartridgeKit(S0, cart, g) {
  const T = S0.T, byName = (re) => cart.parts.find(m => re.test(m.name));
  const xR0 = g.carL + g.gripL, xR1 = xR0 + g.L, sprL = g.springFree;
  const G = {};
  const mk = (re, shift = 0, crease = 35) => { const m = byName(re); if (!m) return null; const c = m.centroid(); if (shift) m.translate(shift, 0, 0); return { geom: S0.geom(m, crease), name: m.name.replace(/^C\d+\s/, ''), group: m.group, center: [c[0], c[1], c[2]] }; };
  G.ribbon = mk(/ribbon bundle/i, -xR1); G.plates = mk(/plate stack/i); G.mgrip = mk(/moving grip/i); G.fgrip = mk(/fixed grip/i); G.carriage = mk(/^(C\d+\s)?carriage/i); G.rod = mk(/push rod/i, 0, 40);
  G.housing = mk(/housing sleeve/i); G.flange = mk(/inner flange/i, 0, 40); G.cap = mk(/end cap/i); G.hotPort = mk(/hot port/i, 0, 40); G.coldPort = mk(/cold port/i, 0, 40);
  const sp = helixMesh('Bias spring', { R: g.springD / 2, rw: g.springWire / 2, n: g.springCoils, L: sprL }); G.spring = { geom: S0.geom(sp, 50), name: 'Bias spring', group: 'Bias spring', center: [-sprL / 2, 0, 0] };
  const clutchR = Math.max(g.rodD * 0.9, 1.2e-3); G.clutch = { geom: new T.TorusGeometry(clutchR, clutchR * 0.32, 12, 28).rotateY(Math.PI / 2), name: 'One-way clutch state', group: 'Transmission', center: [-g.rodL, 0, 0] };
  for (const k of ['mgrip', 'fgrip', 'carriage', 'housing', 'cap', 'plates']) if (G[k]) G[k].edges = new T.EdgesGeometry(G[k].geom, 28);
  return { G, xR0, xR1, sprL, g };
}
// instantiate one cartridge under `parent`; returns its animated handles
function cartridgeInstance(S0, kit, parent, { mats, offset = 0, idx = 0, plateField = false }) {
  const T = S0.T, { G, xR1, sprL, g } = kit, add = (o, part, mat, pp = parent, edges = false) => part && S0.add(pp, part.geom, mat, { name: part.name, group: part.group, center: [part.center[0] + offset, part.center[1], part.center[2]], edges, edgeGeom: part.edges });
  const ribMat = mats.niti.clone(), plateMat = plateField ? mats.ss.clone() : mats.ss, clutchMat = mats.clutch.clone(); ribMat.userData.label = mats.niti.userData.label; plateMat.userData.label = mats.ss.userData.label; clutchMat.userData.label = 'Clutch indicator (green engaged · red stalled · grey freewheel)';
  const ribPivot = new T.Group(); ribPivot.position.x = xR1; parent.add(ribPivot); add(0, G.ribbon, ribMat, ribPivot);
  add(0, G.plates, plateMat, parent, true); add(0, G.fgrip, mats.alu, parent, true); add(0, G.housing, mats.clear); add(0, G.flange, mats.peek); add(0, G.cap, mats.alu, parent, true); add(0, G.hotPort, mats.hot); add(0, G.coldPort, mats.cold);
  const mover = new T.Group(); parent.add(mover); add(0, G.mgrip, mats.alu, mover, true); add(0, G.carriage, mats.dark, mover, true); add(0, G.rod, mats.steel, mover);
  const clutch = S0.add(mover, G.clutch.geom, clutchMat, { name: G.clutch.name, group: 'Transmission', center: G.clutch.center }); clutch.position.x = -g.rodL;
  const sprPivot = new T.Group(); sprPivot.position.x = -sprL; parent.add(sprPivot); add(0, G.spring, mats.steel, sprPivot);
  return {
    ribMat, plateMat, clutchMat, mover, ribPivot, sprPivot,
    set(xDisp, L) { const x = clamp(xDisp, -0.45 * L, 0.45 * L); mover.position.x = x; ribPivot.scale.x = (L - x) / L; sprPivot.scale.x = Math.max(0.2, (sprL + x) / sprL); },
    clutchState(e) { const c = e >= 0.99 ? 0x22c55e : e > 0.2 ? 0xef4444 : 0x64748b; clutchMat.color.setHex(c); clutchMat.emissive.setHex(c); clutchMat.emissiveIntensity = e > 0.2 ? 0.8 : 0.05; },
    idx,
  };
}
// plate stack look: wall-temperature colour in temperature mode, translucent steel in ξ mode so the ribbons show through
function plateLook(T, m, mode, Tw, lo, hi) {
  if (mode === 'T') { setCol(T, m.color, (Tw - lo) / ((hi - lo) || 1)); m.metalness = 0.5; m.roughness = 0.4; if (m.opacity !== 1) { m.opacity = 1; m.transparent = false; m.depthWrite = true; m.userData.baseOpacity = 1; } }
  else { m.color.setHex(0xa9b1bb); m.metalness = 0.9; m.roughness = 0.3; if (m.opacity !== 0.3) { m.opacity = 0.3; m.transparent = true; m.depthWrite = false; } }
}
const baseMats = (S0) => ({ niti: S0.mat('niti'), ss: S0.mat('ss'), alu: S0.mat('alu'), dark: S0.mat('dark'), steel: S0.mat('steel'), peek: S0.mat('peek'), clear: S0.mat('clear'), hot: S0.mat('hot'), cold: S0.mat('cold'), glass: S0.mat('glass'), clutch: S0.mat('dark', { emissive: 0x000000 }) });

// =====================================================================================================================
// 1. Whole radial engine running (Suite 02 / home)
// =====================================================================================================================
function buildEngineScene(S0, E) {
  const T = S0.T, V = S0.V, geo = E.geo, N = geo.N, mats = baseMats(S0);
  const cart = E.S02.buildCartridge(geo.g), kit = cartridgeKit(S0, cart, geo.g), off = geo.rInner - cart.xF0;
  const carts = range(N).map(k => { const grp = new T.Group(); grp.rotation.z = TAU * k / N; V.root.add(grp); const inner = new T.Group(); inner.position.x = off; grp.add(inner); return cartridgeInstance(S0, kit, inner, { mats, offset: off, idx: k, plateField: true }); });
  // rotor + shaft (rotating), with lugs and bolt circle so rotation is visible
  const rot = new T.Group(); V.root.add(rot);
  const { cylinder, box } = { cylinder: null, box: null };
  void cylinder; void box;
  const rotorT = E.pg.rotorT_mm / 1e3, rR = geo.rotorR, shaftR = E.pg.shaftD_mm / 2e3;
  S0.add(rot, new T.CylinderGeometry(rR, rR, rotorT, 96, 1).rotateX(Math.PI / 2), mats.steel, { name: 'Rotor / flywheel disc', group: 'Rotor', edges: true, edgeGeom: new T.EdgesGeometry(new T.CylinderGeometry(rR, rR, rotorT, 96, 1).rotateX(Math.PI / 2), 30) });
  S0.add(rot, new T.CylinderGeometry(shaftR, shaftR, geo.shaftL, 48, 1).rotateX(Math.PI / 2), mats.steel, { name: 'Output shaft', group: 'Rotor' });
  const lugGeo = new T.BoxGeometry(rR * 0.22, rR * 0.12, rotorT * 1.25), boltGeo = new T.CylinderGeometry(rR * 0.045, rR * 0.045, rotorT * 1.12, 20).rotateX(Math.PI / 2);
  for (let k = 0; k < N; k++) { const a = TAU * k / N, l = S0.add(rot, lugGeo, mats.dark, { name: `Rocker lug ${k + 1}`, group: 'Rotor', edges: true, center: [Math.cos(a) * rR, Math.sin(a) * rR, 0] }); l.position.set(Math.cos(a) * (rR + rR * 0.08), Math.sin(a) * (rR + rR * 0.08), 0); l.rotation.z = a; }
  for (let k = 0; k < 6; k++) { const a = TAU * k / 6, b = S0.add(rot, boltGeo, mats.dark, { name: 'Hub bolt', group: 'Rotor' }); b.position.set(Math.cos(a) * rR * 0.55, Math.sin(a) * rR * 0.55, 0); }
  // manifolds and casing (static)
  const torusG = (r, z) => new T.TorusGeometry(r, geo.rM, 20, 120).translate(0, 0, z);
  S0.add(V.root, torusG(geo.rPort, geo.zM), mats.hot, { name: 'Hot manifold ring', group: 'Manifolds', center: [0, 0, geo.zM] });
  S0.add(V.root, torusG(geo.rPort, -geo.zM), mats.cold, { name: 'Cold manifold ring', group: 'Manifolds', center: [0, 0, -geo.zM] });
  const cas = S0.add(V.root, new T.CylinderGeometry(geo.Rcase + geo.tCase, geo.Rcase + geo.tCase, geo.Lcase, 128, 1, true).rotateX(Math.PI / 2), mats.glass, { name: 'Casing shell', group: 'Casing', shadow: false }); cas.renderOrder = 2;
  for (const s of [1, -1]) { const e = S0.add(V.root, new T.CylinderGeometry(geo.Rcase + geo.tCase, geo.Rcase + geo.tCase, geo.tCase, 128, 1).rotateX(Math.PI / 2), mats.glass, { name: s > 0 ? 'Front end plate' : 'Rear end plate', group: 'Casing', shadow: false, center: [0, 0, s * geo.Lcase / 2] }); e.position.z = s * (geo.Lcase / 2 + geo.tCase / 2); e.renderOrder = 2; }
  // manifold fluid tracers
  const fluid = (hot) => {
    const n = 220, pc = pointCloud(S0, n, geo.rM * 0.7), z0 = hot ? geo.zM : -geo.zM, zEnd = (hot ? 1 : -1) * geo.Hout / 2, inlet = hot ? 0 : Math.PI;
    const st = range(n).map(() => ({ a: Math.random() * TAU, port: false, z: z0, tgt: -1, r: (Math.random() - 0.5) * geo.rM * 1.2, s: (Math.random() - 0.5) * geo.rM * 1.2 }));
    const vRing = hot ? E.flow.vRingH : E.flow.vRingC, vPort = hot ? E.flow.vPortH : E.flow.vPortC;
    const angK = (k) => TAU * k / N, dAng = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
    return {
      pc, step(dt, active, colour) {
        const P = pc.pos, C = pc.col, act = range(N).filter(k => active[k]);
        for (let i = 0; i < n; i++) {
          const q = st[i];
          if (q.port) { q.z += (hot ? -1 : 1) * vPort * dt; if ((hot && q.z < zEnd) || (!hot && q.z > zEnd) || !active[q.tgt]) { q.port = false; q.a = inlet + (Math.random() - 0.5) * 0.3; q.z = z0; q.tgt = -1; } }
          else if (act.length && dt > 0) {
            if (q.tgt < 0 || !active[q.tgt]) { let best = -1, bd = 9; for (const k of act) { const d = Math.abs(dAng(q.a, angK(k))) + Math.random() * 0.6; if (d < bd) { bd = d; best = k; } } q.tgt = best; }
            const d = dAng(q.a, angK(q.tgt)), stp = vRing / geo.rPort * dt; if (Math.abs(d) <= stp) { q.a = angK(q.tgt); q.port = true; q.z = z0; } else q.a += Math.sign(d) * stp;
          }
          const rr = geo.rPort + (q.port ? 0 : q.r), ca = Math.cos(q.a), sa = Math.sin(q.a);
          P[3 * i] = rr * ca - (q.port ? q.s * 0.25 * sa : 0); P[3 * i + 1] = rr * sa + (q.port ? q.s * 0.25 * ca : 0); P[3 * i + 2] = q.port ? q.z : z0 + q.s;
          C[3 * i] = colour.r; C[3 * i + 1] = colour.g; C[3 * i + 2] = colour.b;
        }
        pc.flush();
      },
    };
  };
  return { carts, rot, kit, fluidH: fluid(true), fluidC: fluid(false), geo };
}

async function engineView(el, ctx, res, p) {
  loading(el, 'Solving the engine: transient ribbon cell → shaft dynamics from rest to periodic running → manifold flows…');
  let E; try { E = await S.solveEngine(ctx, { p02: p && p.nCells !== undefined && p.L_mm !== undefined ? p : null }); } catch (e) { failBox(el, 'Engine simulation could not be solved: ' + (e?.message || e)); return; }
  const sh = E.shaft, c = E.cell, W = sh.win, N = E.N, P = sh.P, L = E.geo.L, d = E.d;
  const S0 = await stage(el, { height: 560 }), T = S0.T, sc = buildEngineScene(S0, E);
  const fr = S0.finish();
  let mode = 'T', mag = Math.max(1, Math.round(clamp(0.15 * L / Math.max(c.xMax, 1e-9), 1, 20)));
  const Tlo = Math.min(d.Tc, c.Tlo), Thi = Math.max(d.Th, c.Thi);
  const legend = () => S0.setLegend(mode === 'T' ? { title: 'Temperature (ribbons · plate stack = wall)', lo: Tlo, hi: Thi, unit: ' °C', cmapName: 'turbo' } : { title: 'Martensite fraction ξ', lo: 0, hi: 1, unit: '', cmapName: 'viridis' });
  legend();
  S0.group('Colour', [['T', 'Temperature'], ['xi', 'Martensite ξ']], mode, (v) => { mode = v; legend(); S0.pb.set(S0.pb.t); });
  S0.slider('Stroke magnification', { min: 1, max: 40, value: mag, fmtv: (v) => `×${v} (true peak stroke ${f3(c.xMax * 1e3)} mm)`, onInput: (v) => { mag = v; if (S0.pb) S0.pb.set(S0.pb.t); } });
  S0.button('Labels', 'Show / hide callouts', (b) => { S0.labels.visible = !S0.labels.visible; b.classList.toggle('on', S0.labels.visible); }, true);
  const g = E.geo, lab = S0.labels, v3 = (x, y, z) => (o) => o.set(x, y, z);
  lab.add('Hot manifold ring — supply ' + f3(d.Th) + ' °C', v3(g.rPort * Math.cos(0.4), g.rPort * Math.sin(0.4), g.zM + g.rM), '#ef4444');
  lab.add('Cold manifold ring — supply ' + f3(d.Tc) + ' °C', v3(g.rPort * Math.cos(3.6), g.rPort * Math.sin(3.6), -g.zM - g.rM), '#3b82f6');
  lab.add('Rotor & output shaft', v3(0, 0, g.shaftL / 2), '#e5e7eb');
  lab.add('Cartridge C01 (ribbon bundle)', (o) => o.set(g.rInner + (sc.kit.xR0 + sc.kit.xR1) / 2 - g.proto.xF0, 0, g.Hout / 2), '#c58b4b');
  lab.add('Bias spring & carriage', (o) => o.set(g.rInner - g.proto.xF0 - sc.kit.sprL / 2, 0, -g.Hout / 2), '#94a3b8');
  const tw = W.t, dur = tw[tw.length - 1], dTheta = W.theta[W.theta.length - 1] - W.theta[0] + (W.theta[1] - W.theta[0]), ang = loopAngle({ duration: dur, dTheta });
  const shs = S.sampler(tw, ['om', W.omega], ['th', W.theta], ['tq', W.tq], ['tl', W.tl], ['en', W.engaged]), o = {}, step = stepper(dur), col = new T.Color(), hotCol = new T.Color(), coldCol = new T.Color();
  setCol(T, hotCol, (d.Th - Tlo) / (Thi - Tlo)); setCol(T, coldCol, (d.Tc - Tlo) / (Thi - Tlo));
  const active = { H: new Array(N).fill(false), C: new Array(N).fill(false) };
  const onFrame = (t) => {
    shs(t, o); const dt = step(t);
    sc.rot.rotation.z = ang(t, o.th);
    for (let k = 0; k < N; k++) {
      const tau = t + E.offsets[k] * P, inst = sc.carts[k], x = c.at('x', tau), Tm = c.at('Tm', tau), xi = c.at('xi', tau), en = c.at('engaged', tau);
      inst.set(mag * (x - c.xMin), L); inst.clutchState(en);
      setCol(T, inst.ribMat.color, mode === 'T' ? (Tm - Tlo) / (Thi - Tlo) : xi, mode === 'T' ? 'turbo' : 'viridis');
      plateLook(T, inst.plateMat, mode, c.at('Tw', tau), Tlo, Thi);
      const ph = ((tau % P) + P) % P; active.H[k] = ph < c.duty * P; active.C[k] = !active.H[k];
    }
    sc.fluidH.step(dt, active.H, mode === 'T' ? hotCol : col.setRGB(0.9, 0.25, 0.15)); sc.fluidC.step(dt, active.C, mode === 'T' ? coldCol : col.setRGB(0.15, 0.4, 0.95));
    const k0 = 0, tau0 = t + E.offsets[k0] * P;
    S0.hud.set([['t', f4(t) + ' s'], ['Shaft speed', f3(o.om * 60 / TAU) + ' rpm'], ['Drive torque Στ', f3(o.tq) + ' N·m'], ['Load power', f3(o.tl * o.om) + ' W'], ['Cells engaged', `${Math.round(o.en)} / ${N}`], ['C01 ribbon T', f3(c.at('Tm', tau0)) + ' °C'], ['C01 ξ', f3(c.at('xi', tau0))], ['C01 stroke (true)', f3((c.at('x', tau0) - c.xMin) * 1e3) + ' mm'], ['C01 force', f3(c.at('F', tau0)) + ' N'], ['C01 phase', ((tau0 % P) + P) % P < c.duty * P ? 'HOT' : 'COLD', ((tau0 % P) + P) % P < c.duty * P ? '#ef4444' : '#3b82f6']]);
  };
  S0.V.animate = () => lab.update();
  S0.timeline({ duration: dur, onFrame, label: 'Engine time', unit: 's', rate: 1 });
  S0.explain(`<b>What drives this scene.</b> Geometry: the Suite 02 parametric solids (${N} cartridges at r = ${f3(g.rInner * 1e3)} mm, ${E.pg.nRib} ribbons × ${f3(g.L * 1e3)} mm each; spring shown as a light display mesh with the CAD coil diameter, wire and pitch). `
    + `Each cartridge replays the <i>solved</i> periodic history of the transient ribbon cell (sma.cellTransient: conduction, wall, switching fluid, kinetics, bias, one-way clutch) shifted by its phase offset (${E.offSrc}); ribbon colour is its mean temperature or martensite fraction ξ, the carriage/push rod/moving grip translate by the solved stroke x(t) (×${mag} display magnification, true peak ${f3(c.xMax * 1e3)} mm), the bias spring follows the carriage and the ring on the push rod shows the clutch state. `
    + `The rotor angle is integrated by the Suite 11 shaft model (J dω/dt = Στᵢ − τ_load − τ_friction, matched quadratic load) from rest to periodic running (${sh.cyclesToSteady} cycles${sh.converged ? ', converged' : ', cycle cap reached'}); the window shown is ${f3(dur)} s of steady running at ${f3(sh.omegaMean * 60 / TAU)} rpm with torque ripple ${f3(sh.ripple * 100)} %. `
    + `Manifold tracers move at the solved mean velocities (ring ${f3(E.flow.vRingH)} m/s hot, ${f3(E.flow.vRingC)} m/s cold; ports ${f3(E.flow.vPortH)} m/s) from the flow that limits the fluid ΔT to ${d.fluidDT} K, and drop only into cartridges that are currently in their hot (red) or cold (blue) phase. Supply points are at φ = 0 (hot) and φ = 180° (cold). Casing and housings are drawn transparent; use X-ray, Section and Explode from the toolbar, PNG/4K for stills and ⏺ Rec for video.`);
  void fr;
}

// =====================================================================================================================
// 2. Single cartridge (Suite 05) — also used by Suite 14 at its converged operating point
// =====================================================================================================================
async function cartridgeView(el, ctx, c, { title = 'Cartridge', srcNote = '' } = {}) {
  const E02 = await import('../suites/s02-cad-mesh.js'), d = S.designOf(ctx);
  const geom = c.geom || { L: d.ribbonL, w: d.ribbonW, t: d.ribbonT, nRib: d.ribbonsPerCell };
  const pg = S.resolveDefaults(E02.default, ctx, { L_mm: geom.L * 1e3, w_mm: geom.w * 1e3, t_um: geom.t * 1e6, nRib: geom.nRib, travel_mm: Math.max(1, 1.3 * c.xMax * 1e3) });
  const geo = E02.buildEngineGeometry(pg, { alloy: c.mat, stroke05: c.xMax });
  const cart = E02.buildCartridge(geo.g);
  const S0 = await stage(el, { height: 540 }), T = S0.T, mats = baseMats(S0), kit = cartridgeKit(S0, cart, geo.g);
  const inst = cartridgeInstance(S0, kit, S0.V.root, { mats, plateField: true });
  const g = geo.g, L = geo.L, H = c.hist, P = c.P;
  // force arrow on the push rod (pull toward the ribbons), and channel flow tracers in the plate stack
  const arrow = new T.ArrowHelper(new T.Vector3(1, 0, 0), new T.Vector3(-g.rodL - 0.012, 0, 0), 0.02, 0xfacc15, 0.006, 0.004); inst.mover.add(arrow);
  const d2 = S.designOf(ctx), fl = fluidProps(d2.hotFluid, c.Th ?? d2.Th), nCh = d2.chPerCell, mdot = hydraulics(d2, c.cell, d2.nCells, 1 / P).mdotH / d2.nCells / Math.max(c.duty, 0.05), u = mdot / (fl.rho * nCh * d2.chW * d2.chH);
  const nPl = g.plate === 'dedicated' ? 2 * g.nRib : g.nRib + 1, nP = Math.min(480, nPl * 14), pc = pointCloud(S0, nP, Math.min(g.tPlate, 1.2e-3) * 0.9), xr0 = kit.xR0 + g.plateGap, xr1 = kit.xR1;
  const zPl = []; { let z = -g.stackH / 2; for (let k = 0; k < g.nRib; k++) { if (g.plate === 'dedicated' || k === 0) { zPl.push(z + g.tPlate / 2); z += g.tPlate; } z += g.tc + g.t + g.tc; zPl.push(z + g.tPlate / 2); z += g.tPlate; } }
  const pst = range(nP).map(i => ({ x: xr0 + Math.random() * (xr1 - xr0), y: (Math.random() - 0.5) * g.w, z: zPl[i % zPl.length] }));
  const fr = S0.finish(); void fr;
  let mode = 'T', mag = Math.max(1, Math.round(clamp(0.15 * L / Math.max(c.xMax, 1e-9), 1, 20)));
  const Tlo = Math.min(c.Tlo, c.Tc ?? c.Tlo), Thi = Math.max(c.Thi, c.Th ?? c.Thi);
  const legend = () => S0.setLegend(mode === 'T' ? { title: 'Temperature (ribbons, plates, fluid)', lo: Tlo, hi: Thi, unit: ' °C' } : { title: 'Ribbon martensite fraction ξ (plates translucent)', lo: 0, hi: 1, cmapName: 'viridis' });
  legend();
  S0.group('Ribbon colour', [['T', 'Temperature'], ['xi', 'Martensite ξ']], mode, (v) => { mode = v; legend(); S0.pb.set(S0.pb.t); });
  S0.slider('Stroke magnification', { min: 1, max: 40, value: mag, fmtv: (v) => `×${v} (true peak ${f3(c.xMax * 1e3)} mm)`, onInput: (v) => { mag = v; if (S0.pb) S0.pb.set(S0.pb.t); } });
  S0.button('Labels', 'Show / hide callouts', (b) => { S0.labels.visible = !S0.labels.visible; b.classList.toggle('on', S0.labels.visible); }, true);
  const lab = S0.labels;
  lab.add(`SMA ribbon bundle (${geom.nRib} × ${f3(geom.t * 1e6)} µm)`, (o) => o.set((kit.xR0 + kit.xR1) / 2 + inst.mover.position.x / 2, g.w / 2, g.stackH / 2), '#c58b4b');
  lab.add('Microchannel plates (wall T)', (o) => o.set(kit.xR1 - 0.15 * L, -g.plateW / 2, 0), '#94a3b8');
  lab.add('Carriage & moving grip', (o) => o.set(g.carL / 2 + inst.mover.position.x, 0, g.Hc / 2), '#64748b');
  lab.add('Bias spring', (o) => o.set(-kit.sprL / 2, 0, g.springD / 2), '#d4d4d8');
  lab.add('One-way clutch (state)', (o) => o.set(-g.rodL + inst.mover.position.x, 0, -g.rodD), '#22c55e');
  lab.add('Fixed grip', (o) => o.set(kit.xR1 + g.gripL / 2, 0, -g.Hc / 2), '#8b9bb4');
  const dur = 2 * P, step = stepper(dur), cF = new T.Color(), At = c.cell.area || 1;
  const onFrame = (t) => {
    const dt = step(t), x = c.at('x', t) - c.xMin, Tm = c.at('Tm', t), Tw = c.at('Tw', t), Tf = c.at('Tf', t), xi = c.at('xi', t), F = c.at('F', t), en = c.at('engaged', t), ph = ((t % P) + P) % P, hot = ph < c.duty * P;
    inst.set(mag * x, L); inst.clutchState(en);
    setCol(T, inst.ribMat.color, mode === 'T' ? (Tm - Tlo) / (Thi - Tlo) : xi, mode === 'T' ? 'turbo' : 'viridis');
    plateLook(T, inst.plateMat, mode, Tw, Tlo, Thi);
    const fl2 = clamp(F / Math.max(c.Fmax, 1e-9), 0, 1), al = 0.006 + 0.05 * fl2; arrow.setLength(al, Math.min(0.006, al * 0.35), 0.004); arrow.position.x = -g.rodL - 0.004 - al;
    setCol(T, cF, (Tf - Tlo) / (Thi - Tlo));
    for (let i = 0; i < nP; i++) { const q = pst[i]; q.x += u * dt; if (q.x > xr1) q.x = xr0 + (q.x - xr1) % (xr1 - xr0); pc.pos[3 * i] = q.x; pc.pos[3 * i + 1] = q.y; pc.pos[3 * i + 2] = q.z; pc.col[3 * i] = cF.r; pc.col[3 * i + 1] = cF.g; pc.col[3 * i + 2] = cF.b; }
    pc.flush();
    S0.hud.set([['t', f4(t) + ' s'], ['Phase', hot ? 'HOT (power stroke)' : 'COLD (reset)', hot ? '#ef4444' : '#3b82f6'], ['Fluid T', f3(Tf) + ' °C'], ['Wall T', f3(Tw) + ' °C'], ['Ribbon mean T', f3(Tm) + ' °C'], ['Martensite ξ', f3(xi)], ['Stroke x (true)', f3(x * 1e3) + ' mm'], ['Force F', f3(F) + ' N'], ['Stress σ', f3(F / At / 1e6) + ' MPa'], ['Clutch', en >= 0.99 ? 'engaged' : en > 0.2 ? 'stalled (blocked)' : 'freewheel', en >= 0.99 ? '#22c55e' : en > 0.2 ? '#ef4444' : '#94a3b8'], ['Output power', f3(c.at('Pmech', t)) + ' W']]);
  };
  S0.V.animate = () => lab.update();
  S0.timeline({ duration: dur, onFrame, label: title + ' time', unit: 's', rate: Math.min(1, 1 / Math.max(P, 1e-6)) });
  S0.explain(`<b>What drives this scene.</b> ${srcNote} The solids are the Suite 02 cartridge built from this cartridge's ribbon geometry. Every frame samples the solved periodic last cycle of the transient ribbon cell (sma.cellTransient; ${c.cell.hist.t.length} steps per ${f3(P)} s cycle, energy residual ${f3(Math.abs(c.cell.energyResidual) * 100)} %): plates are coloured by the wall-node temperature T_w(t), ribbons by their mean temperature or ξ(t), tracers in the plate stack by the switching fluid temperature T_f(t) and move at the mean channel velocity ${f3(u)} m/s of the hot-phase flow. `
    + `The moving grip, carriage and push rod translate by the solved stroke x(t) multiplied by the <b>display magnification</b> shown on the slider (true peak ${f3(c.xMax * 1e3)} mm on a ${f3(L * 1e3)} mm ribbon); the ribbon bundle shortens by the same amount about the fixed grip and the bias spring follows the carriage. The yellow arrow is the ribbon force F(t) (peak ${f3(c.Fmax)} N); the ring on the push rod shows the one-way clutch: green while it transmits the power stroke, red if the load blocks the stroke, grey while it freewheels during the reset.`);
}

// =====================================================================================================================
// 3. Microchannel plate (Suite 08): extruded unit-cell FE field + duct-profile fluid tracers
// =====================================================================================================================
async function microchannelView(el, ctx, res, p) {
  loading(el, 'Solving the unit-cell conduction transient (heating then cooling, enthalpy latent heat) on a coarse FE mesh…');
  let M; try { M = await S.solveMicrochannel(ctx, res, p || {}); } catch (e) { failBox(el, 'Microchannel field could not be solved: ' + (e?.message || e)); return; }
  if (M.error) { failBox(el, 'Infeasible microchannel geometry: ' + M.error); return; }
  const S0 = await stage(el, { height: 520 }), T = S0.T, mesh = M.mesh, sec = M.sec, k = 1e3; // scene in millimetres
  const nRep = 3, ym = sec.ymax, Lseg = Math.max(4 * M.pitch, 2 * nRep * M.pitch) * k, Wd = nRep * M.pitch, copies = [];
  for (let r = 0; r < nRep; r++) for (const [a, b] of [[1, 0], [-1, 0], [-1, 2 * ym], [1, 2 * ym]]) copies.push({ dx: r * M.pitch, sy: a, oy: b });
  // build the extruded field mesh (front and back faces + all tagged boundaries swept along the channel)
  const nn = mesh.nodes.length, pos = [], idx = [], nodeOf = [], regOf = [];
  const vtx = (cp, i, z) => { const [x, y] = mesh.nodes[i]; pos.push(z - Lseg / 2, (x + cp.dx - Wd / 2) * k, (cp.sy * y + cp.oy - ym) * k); nodeOf.push(i); return pos.length / 3 - 1; };
  const ribNode = new Uint8Array(nn); mesh.tris.forEach((tr, e) => { if (mesh.region[e] === 0) tr.forEach(i => { ribNode[i] = 1; }); });
  for (const cp of copies) {
    const extOuter = (cp.sy < 0 && cp.oy === 0) || (cp.sy > 0 && cp.oy > 0), flip = cp.sy < 0, f0 = new Map(), f1 = new Map(); for (let i = 0; i < nn; i++) { f0.set(i, vtx(cp, i, 0)); f1.set(i, vtx(cp, i, Lseg)); }
    for (const [a, b, c] of mesh.tris) { if (flip) { idx.push(f0.get(a), f0.get(b), f0.get(c), f1.get(a), f1.get(c), f1.get(b)); } else { idx.push(f0.get(a), f0.get(c), f0.get(b), f1.get(a), f1.get(b), f1.get(c)); } }
    for (const [tag, edges] of Object.entries(mesh.bnd)) { if (tag === 'sym' || (tag === 'outer' && !extOuter)) continue; for (const [a, b] of edges) { const q = [f0.get(a), f0.get(b), f1.get(b), f1.get(a)]; idx.push(q[0], q[1], q[2], q[0], q[2], q[3]); } }
  }
  void regOf;
  const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
  const nV = pos.length / 3, colA = new Float32Array(nV * 3); geo.setAttribute('color', new T.BufferAttribute(colA, 3));
  const fmat = new T.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.75, side: T.DoubleSide, clippingPlanes: S0.clip, envMapIntensity: 0.35 }); // matte so the field colours read true fmat.userData.label = `Temperature field: ${M.alloyName} ribbon · contact layer · ${M.plateName} plate`;
  const obj = S0.add(S0.V.root, geo, fmat, { name: 'Ribbon–contact–plate unit cells (FE field, extruded)', group: 'Unit cell' });
  obj.userData.field = { name: 'T', unit: '°C', values: new Float32Array(nV) };
  // channels and tracers (complete channels only: shared-plate halves are joined across the plate mid-plane)
  const rects = []; for (const cp of copies) for (const hh of sec.holes) { const y0 = cp.sy > 0 ? cp.oy + hh.y0 : cp.oy - hh.y1, y1 = cp.sy > 0 ? cp.oy + hh.y1 : cp.oy - hh.y0; rects.push({ x0: hh.x0 + cp.dx, x1: hh.x1 + cp.dx, y0, y1 }); }
  const merged = []; for (const r of rects) { const m2 = merged.find(q => Math.abs(q.x0 - r.x0) < 1e-12 && (Math.abs(q.y1 - r.y0) < 1e-12 || Math.abs(q.y0 - r.y1) < 1e-12)); if (m2) { m2.y0 = Math.min(m2.y0, r.y0); m2.y1 = Math.max(m2.y1, r.y1); } else merged.push({ ...r }); }
  const chans = merged.filter(r => r.y1 - r.y0 > 0.95 * M.chH && r.y0 > -ym - 1e-12 && r.y1 < 3 * ym + 1e-12);
  const nPer = 70, nP = Math.max(1, chans.length) * nPer, pc = pointCloud(S0, nP, Math.min(M.chW, M.chH) * k * 0.13);
  const D = M.duct, uAt = (yy, zz) => { const i = clamp(Math.round((yy + M.chW / 2) / M.chW * (D.ys.length - 1)), 0, D.ys.length - 1), j = clamp(Math.round((zz + M.chH / 2) / M.chH * (D.zs.length - 1)), 0, D.zs.length - 1); return Math.max(0, D.z[j][i]); };
  const pst = range(nP).map(i => { const ch = chans[Math.floor(i / nPer)] || chans[0]; const yy = (Math.random() - 0.5) * M.chW * 0.96, zz = (Math.random() - 0.5) * M.chH * 0.96; return { ch, yy, zz, z: Math.random() * Lseg, f: uAt(yy, zz) }; });
  S0.finish(S0.V.root, 0.95); S0.V.viewDir(-1.1, -0.75, 0.55); S0.V.camera.position.lerp(S0.V.controls.target, 0.3); S0.V.controls.update();
  const secBtn = [...S0.vbox.querySelectorAll('.viewer-tools button')].find(b => b.textContent === 'Section');
  S0.button('Cut-away', 'Cut the stack at mid-width (through a channel row) to see the channel interiors and tracers', (b) => { secBtn?.click(); b.classList.toggle('on', secBtn?.classList.contains('on')); });
  const Tlo = M.Tc, Thi = M.Th; S0.setLegend({ title: 'Temperature (solid field and fluid)', lo: Tlo, hi: Thi, unit: ' °C' });
  const lab = S0.labels;
  lab.add(`SMA ribbon (${f3(sec.t * 1e6)} µm)`, (o) => o.set(-Lseg / 2, -Wd / 2 * k, 0), '#c58b4b');
  if (chans[0]) lab.add('Coolant channel (duct velocity profile)', (o) => o.set(Lseg / 2, ((chans[0].x0 + chans[0].x1) / 2 - Wd / 2) * k, ((chans[0].y0 + chans[0].y1) / 2 - ym) * k), '#38bdf8');
  lab.add(`${M.plateName} plate`, (o) => o.set(0, Wd / 2 * k, ym * 0.9 * k), '#94a3b8');
  S0.button('Labels', 'Show / hide callouts', (b) => { S0.labels.visible = !S0.labels.visible; b.classList.toggle('on', S0.labels.visible); }, true);
  const snaps = M.snaps, tS = snaps.map(s => s.t), dur = M.tEnd, step = stepper(dur), Tn = new Float64Array(nn), col = new T.Color(), stat = S.sampler(M.tStat, ['rm', M.ribMean], ['rn', M.ribMin], ['rx', M.ribMax], ['wm', M.wallMean]), so = {};
  const Pw = 2 * (M.chW + M.chH);
  const onFrame = (t) => {
    const dt = step(t); let j = 0; while (j < tS.length - 2 && tS[j + 1] < t) j++; const f = clamp((t - tS[j]) / ((tS[j + 1] - tS[j]) || 1), 0, 1), A = snaps[j].T, B = snaps[j + 1]?.T || A;
    for (let i = 0; i < nn; i++) Tn[i] = A[i] + (B[i] - A[i]) * f;
    const vals = obj.userData.field.values; for (let v = 0; v < nV; v++) { const Tv = Tn[nodeOf[v]]; vals[v] = Tv; setCol(T, col, (Tv - Tlo) / (Thi - Tlo)); colA[3 * v] = col.r; colA[3 * v + 1] = col.g; colA[3 * v + 2] = col.b; }
    geo.attributes.color.needsUpdate = true;
    stat(t, so); const hot = t < M.tHot, Tin = hot ? M.Th : M.Tc, uM = hot ? M.uH : M.uC, fp = hot ? M.fH : M.fC, mdc = (hot ? M.mdotH : M.mdotC) / M.nCh, Lntu = mdc * fp.cp / ((hot ? M.hHotW : M.hColdW) * Pw);
    for (let i = 0; i < nP; i++) { const q = pst[i]; q.z += uM * q.f * dt * k; if (q.z > Lseg) q.z -= Lseg; const zAbs = M.L / 2 + q.z / k, Tf = so.wm + (Tin - so.wm) * Math.exp(-zAbs / Lntu); setCol(T, col, (Tf - Tlo) / (Thi - Tlo)); pc.pos[3 * i] = q.z - Lseg / 2; pc.pos[3 * i + 1] = ((q.ch.x0 + q.ch.x1) / 2 + q.yy - Wd / 2) * k; pc.pos[3 * i + 2] = ((q.ch.y0 + q.ch.y1) / 2 + q.zz - ym) * k; pc.col[3 * i] = col.r; pc.col[3 * i + 1] = col.g; pc.col[3 * i + 2] = col.b; }
    pc.flush();
    S0.hud.set([['t', f4(t) + ' s'], ['Phase', hot ? 'HEATING (hot fluid)' : 'COOLING (cold fluid)', hot ? '#ef4444' : '#3b82f6'], ['Ribbon mean / min / max', `${f3(so.rm)} / ${f3(so.rn)} / ${f3(so.rx)} °C`], ['Plate mean', f3(so.wm) + ' °C'], ['Af(σH) reached', so.rn >= M.AfH ? 'yes' : 'no', so.rn >= M.AfH ? '#22c55e' : undefined], ['Mf(σL) reached', !hot && so.rx <= M.MfL ? 'yes' : 'no', !hot && so.rx <= M.MfL ? '#22c55e' : undefined], ['Mean velocity ū', f3(uM) + ' m/s'], ['Re', f3(hot ? M.ReH : M.ReC)], ['Film h (wall)', f3(hot ? M.hHotW : M.hColdW) + ' W/m²K']]);
  };
  S0.V.animate = () => lab.update();
  S0.timeline({ duration: dur, onFrame, label: 'Time after valve switch', unit: 's', rate: clamp(+(dur / 12).toPrecision(1), 0.01, 1) });
  S0.explain(`<b>What drives this scene.</b> The ribbon–contact–plate unit cell (${M.mesh.nElems} P1 elements, half-cell with symmetry, mirrored and repeated ${nRep}× across the width and across the plate mid-plane to show complete channels) is solved by the meshlab transient conduction model with the transformation latent heat as an enthalpy term: heating with hot fluid (h = ${f3(M.hHotW)} W/m²K on the channel walls) for ${f3(M.tHot)} s, then cooling (h = ${f3(M.hColdW)} W/m²K) for ${f3(M.tCold)} s (${M.src}; energy residual ${f3(M.residual * 100)} %). Surface colours are the nodal temperatures interpolated between solver snapshots; the field is a 2-D cross-section solution swept along a ${f3(Lseg)} mm segment at mid-channel, at true scale. The near end face shows the solved cross-section field; press Cut-away (or Section) to cut the stack at mid-width through a channel row and watch the tracers inside the channels. `
    + `Fluid tracers follow the fully developed rectangular-duct velocity profile u(y,z)/ū (Suite 08 eigen-series) at the solved mean velocity (${f3(M.uH)} m/s hot, ${f3(M.uC)} m/s cold; Re ${f3(M.ReH)}), and are coloured by the local bulk fluid temperature from the constant-wall-temperature NTU relation T_f = T_w + (T_in − T_w)·exp(−z·hP/(ṁc_p)). The default playback is slowed so the millisecond-scale transient is readable.`);
}

// =====================================================================================================================
// 4. Shaft & phased cells (Suites 11, 12)
// =====================================================================================================================
async function shaftView(el, ctx, res, p, { suite = 's11' } = {}) {
  loading(el, 'Solving cell drive and shaft dynamics from rest to periodic running…');
  const N0 = Math.max(1, Math.round(p?.nCells || S.designOf(ctx).nCells));
  const offOpt = suite === 's12' && res?.outputs?.offsets?.length ? res.outputs.offsets.map(Number) : null;
  const pS11 = suite === 's11' && p ? p : { nCells: N0 };
  const offInit = suite === 's11' ? (p?.phasing === 's12' ? S.phaseOffsets(ctx, N0).offsets : range(N0).map(i => i / N0)) : (offOpt && offOpt.length === N0 ? offOpt : null);
  let R; try { R = await S.solveShaft(ctx, { p: pS11, offsets: offInit }); } catch (e) { failBox(el, 'Shaft simulation could not be solved: ' + (e?.message || e)); return; }
  const S0 = await stage(el, { height: 540 }), T = S0.T, V = S0.V, mats = baseMats(S0);
  const N = R.N, rArm = (R.pp.rArm || 20) / 1000, pitch = 0.016, zs = (k) => (k - (N - 1) / 2) * pitch, shaftL = N * pitch + 0.16, shaftR = 0.009;
  const Jfly = R.pp.Jfly || 0, tFly = 0.05, Rfly = Jfly > 0 ? Math.pow(2 * Jfly / (7850 * Math.PI * tFly), 0.25) : 0.06; // steel disc with the flywheel inertia
  const zFly = -N * pitch / 2 - 0.05;
  const rot = new T.Group(); V.root.add(rot);
  S0.add(rot, new T.CylinderGeometry(shaftR, shaftR, shaftL, 48).rotateX(Math.PI / 2), mats.steel, { name: 'Common shaft', group: 'Shaft' });
  const fly = S0.add(rot, new T.CylinderGeometry(Rfly, Rfly, tFly, 128).rotateX(Math.PI / 2), mats.steel, { name: `Flywheel (J = ${f3(Jfly)} kg·m², steel Ø${f3(2 * Rfly * 1e3)} mm)`, group: 'Shaft', edges: true, edgeGeom: new T.EdgesGeometry(new T.CylinderGeometry(Rfly, Rfly, tFly, 128).rotateX(Math.PI / 2), 30), center: [0, 0, zFly] }); fly.position.z = zFly;
  for (let s = 0; s < 5; s++) { const a = TAU * s / 5, w = S0.add(rot, new T.CylinderGeometry(Rfly * 0.09, Rfly * 0.09, tFly * 1.05, 24).rotateX(Math.PI / 2), mats.dark, { name: 'Flywheel lightening hole', group: 'Shaft' }); w.position.set(Math.cos(a) * Rfly * 0.6, Math.sin(a) * Rfly * 0.6, zFly); }
  const cells = range(N).map(k => {
    const phi = TAU * k / N, grp = new T.Group(); grp.position.z = zs(k); V.root.add(grp);
    const race = S0.add(rot, new T.CylinderGeometry(shaftR * 1.9, shaftR * 1.9, pitch * 0.55, 40).rotateX(Math.PI / 2), mats.dark, { name: `Sprag clutch ${k + 1} (inner race on shaft)`, group: 'Clutches', center: [0, 0, zs(k)] }); race.position.z = zs(k);
    const rocker = new T.Group(); rocker.rotation.z = phi; grp.add(rocker);
    const armG = new T.BoxGeometry(rArm, 0.006, pitch * 0.4).translate(rArm / 2, 0, 0);
    const arm = S0.add(rocker, armG, mats.alu, { name: `Rocker ${k + 1}`, group: 'Rockers', edges: true, center: [Math.cos(phi) * rArm / 2, Math.sin(phi) * rArm / 2, zs(k)] });
    const hub = S0.add(rocker, new T.TorusGeometry(shaftR * 2.3, shaftR * 0.45, 12, 36), mats.alu, { name: `Clutch outer race ${k + 1}`, group: 'Clutches' }); void arm; void hub;
    // push rod along the tangent from the rocker tip, cartridge body further out (coloured by the cell state)
    const tip = new T.Group(); tip.position.set(rArm, 0, 0); rocker.add(tip);
    const rodLen = 0.05, cartLen = 0.07;
    const rodG = new T.CylinderGeometry(0.0022, 0.0022, rodLen, 16).rotateZ(-Math.PI / 2).translate(0, 0, 0);
    const rodGrp = new T.Group(); grp.add(rodGrp);
    const rod = S0.add(rodGrp, rodG, mats.steel, { name: `Push rod ${k + 1}`, group: 'Cells' }); void rod;
    const cm = mats.niti.clone(); cm.userData.label = 'Cartridge (colour = ribbon state)';
    const cart = S0.add(grp, new T.BoxGeometry(cartLen, 0.016, pitch * 0.7), cm, { name: `Cartridge ${k + 1}`, group: 'Cells', edges: true });
    const arrow = new T.ArrowHelper(new T.Vector3(0, 1, 0), new T.Vector3(), 0.02, 0x22c55e, 0.008, 0.006); grp.add(arrow);
    return { phi, grp, rocker, tip, rodGrp, cart, cm, arrow };
  });
  // torque-ripple ring: instanced bars over one cycle at the rim of the flywheel
  const W = R.win, P = R.P, M = 96, ringR = Rfly * 1.18, tqMax = Math.max(...W.tq, 1e-9), barH = 0.06;
  const inst = new T.InstancedMesh(new T.BoxGeometry(TAU * ringR / M * 0.7, 0.006, 1).translate(0, 0, 0.5), new T.MeshPhysicalMaterial({ metalness: 0.2, roughness: 0.4, clippingPlanes: S0.clip }), M); inst.raycast = () => { };
  const tq1 = range(M).map(j => { const tt = j / M * P; let i = 0; while (i < W.t.length - 1 && W.t[i + 1] < tt) i++; return W.tq[i]; });
  const dummy = new T.Object3D(), cc = new T.Color();
  for (let j = 0; j < M; j++) { const a = TAU * j / M; dummy.position.set(Math.cos(a) * ringR, Math.sin(a) * ringR, zFly - tFly / 2); dummy.rotation.set(0, 0, a + Math.PI / 2); dummy.scale.set(1, 1, Math.max(1e-4, tq1[j] / tqMax * barH)); dummy.updateMatrix(); inst.setMatrixAt(j, dummy.matrix); inst.setColorAt(j, setCol(T, cc, tq1[j] / tqMax, 'viridis')); }
  inst.instanceColor.needsUpdate = true; V.root.add(inst);
  const meanRing = new T.Mesh(new T.TorusGeometry(ringR, 0.003, 10, 180), new T.MeshBasicMaterial({ color: 0xfacc15, clippingPlanes: S0.clip })); meanRing.position.z = zFly - tFly / 2 + R.tqMean / tqMax * barH; meanRing.raycast = () => { }; V.root.add(meanRing);
  const head = new T.Mesh(new T.SphereGeometry(0.009, 20, 14), new T.MeshBasicMaterial({ color: 0xffffff })); head.raycast = () => { }; V.root.add(head);
  S0.finish();
  const c = R.wrap, Tlo = Math.min(c.Tlo, c.Tc), Thi = Math.max(c.Thi, c.Th); let mode = 'T';
  const legend = () => S0.setLegend(mode === 'T' ? { title: 'Cartridge ribbon temperature', lo: Tlo, hi: Thi, unit: ' °C' } : { title: 'Cartridge martensite fraction ξ', lo: 0, hi: 1, cmapName: 'viridis' }); legend();
  S0.group('Cartridge colour', [['T', 'Temperature'], ['xi', 'Martensite ξ']], mode, (v) => { mode = v; legend(); S0.pb.set(S0.pb.t); });
  if (suite === 's12' && offOpt && offOpt.length === N) {
    let cur = 'opt';
    S0.group('Phase offsets', [['opt', 'Optimised (Suite 12)'], ['uni', 'Uniform k/N']], cur, async (v) => { if (v === cur) return; cur = v; S0.hud.set([['Re-solving', 'shaft dynamics…']]); const R2 = await S.solveShaft(ctx, { p: { nCells: N }, offsets: v === 'opt' ? offOpt : range(N).map(i => i / N) }); Object.assign(R, { offsets: R2.offsets, win: R2.win, tqMean: R2.tqMean, ripple: R2.ripple, omegaMean: R2.omegaMean }); rebuild(); });
  }
  const lab = S0.labels;
  lab.add('Flywheel', (o) => o.set(Rfly, 0, zFly), '#e5e7eb'); lab.add('Torque-ripple ring (one cycle, yellow = mean)', (o) => o.set(-ringR, 0, zFly - tFly / 2 + barH * 0.6), '#facc15'); lab.add('Rocker + sprag clutch, cell 1', (o) => o.set(rArm, 0, zs(0)), '#6f86a8');
  S0.button('Labels', 'Show / hide callouts', (b) => { S0.labels.visible = !S0.labels.visible; b.classList.toggle('on', S0.labels.visible); }, true);
  let shs, ang, dur, step, tauMaxCell;
  const xs = R.dr.xf, xfMax = Math.max(...xs, 1e-9), o = {};
  function rebuild() {
    const Wn = R.win; dur = Wn.t[Wn.t.length - 1]; step = stepper(dur);
    shs = S.sampler(Wn.t, ['om', Wn.omega], ['th', Wn.theta], ['tq', Wn.tq], ['tl', Wn.tl], ['en', Wn.engaged]);
    ang = loopAngle({ duration: dur, dTheta: Wn.theta[Wn.theta.length - 1] - Wn.theta[0] + (Wn.theta[1] - Wn.theta[0]) });
    tauMaxCell = Math.max(1e-9, ...Wn.cellTau.flat());
    const tqm = Math.max(...Wn.tq, 1e-9); for (let j = 0; j < M; j++) { const tt = j / M * P; let i = 0; while (i < Wn.t.length - 1 && Wn.t[i + 1] < tt) i++; const a = TAU * j / M; dummy.position.set(Math.cos(a) * ringR, Math.sin(a) * ringR, zFly - tFly / 2); dummy.rotation.set(0, 0, a + Math.PI / 2); dummy.scale.set(1, 1, Math.max(1e-4, Wn.tq[i] / tqm * barH)); dummy.updateMatrix(); inst.setMatrixAt(j, dummy.matrix); inst.setColorAt(j, setCol(T, cc, Wn.tq[i] / tqm, 'viridis')); }
    inst.instanceMatrix.needsUpdate = true; inst.instanceColor.needsUpdate = true; meanRing.position.z = zFly - tFly / 2 + R.tqMean / tqm * barH;
    S0.explain(explainTxt()); if (S0.pb) S0.pb.set(0);
  }
  const explainTxt = () => `<b>What drives this scene.</b> The shaft angle and speed are integrated by the Suite 11 drivetrain model (Newton–Euler, RK4; each cell a force-limited contraction source in series with its ribbon stiffness, transmitting only tension through a one-way sprag clutch) from rest to periodic running, then ${f3(dur)} s of steady operation are replayed (${f3(R.omegaMean * 60 / TAU)} rpm mean, torque ripple ${f3(R.ripple * 100)} %). `
    + `Each rocker turns by its solved free contraction x_f(t)/r_arm (r_arm = ${f3(rArm * 1e3)} mm, gear ratio ${f3(R.G)}); green arrows are the per-cell shaft torques τᵢ(t) recorded by the integrator (shown only while the clutch transmits); cartridges are coloured by the solved cell temperature or ξ at their phase (offsets: ${suite === 's12' ? 'Suite 12 schedule — switch to uniform to compare' : R.pp.phasing === 's12' ? 'Suite 12' : 'uniform k/N'}). `
    + `The flywheel is drawn as a steel disc whose diameter reproduces the added inertia J_fly = ${f3(Jfly)} kg·m² at ${tFly * 1e3} mm thickness. The bar ring plots the total drive torque over one cycle around the rim (bar height ∝ Στᵢ, yellow ring = mean ${f3(R.tqMean)} N·m); the white marker is the current instant. Phasing redistributes torque in time — it never creates energy.`;
  const onFrame = (t) => {
    shs(t, o); step(t); rot.rotation.z = ang(t, o.th);
    const Wn = R.win; let iw = 0; { let lo = 0, hi = Wn.t.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (Wn.t[m] <= t) lo = m; else hi = m; } iw = lo; }
    const ct = Wn.cellTau[Math.min(iw, Wn.cellTau.length - 1)] || [];
    for (let k = 0; k < N; k++) {
      const C = cells[k], tau = t + R.offsets[k] * P, q = (((tau % P) + P) % P) / P * R.dr.spc, i = Math.floor(q) % R.dr.spc, f = q - Math.floor(q), xf = xs[i] + (xs[(i + 1) % R.dr.spc] - xs[i]) * f;
      const psi = xf / rArm; C.rocker.rotation.z = C.phi + psi;
      const tipX = Math.cos(C.phi + psi) * rArm, tipY = Math.sin(C.phi + psi) * rArm, tx = -Math.sin(C.phi), ty = Math.cos(C.phi);
      C.rodGrp.position.set(tipX + tx * 0.025, tipY + ty * 0.025, 0); C.rodGrp.rotation.z = C.phi + Math.PI / 2;
      C.cart.position.set(Math.cos(C.phi) * rArm + tx * 0.09, Math.sin(C.phi) * rArm + ty * 0.09, 0); C.cart.rotation.z = C.phi + Math.PI / 2;
      const Tm = c.at('Tm', tau), xi = c.at('xi', tau); setCol(T, C.cm.color, mode === 'T' ? (Tm - Tlo) / (Thi - Tlo) : xi, mode === 'T' ? 'turbo' : 'viridis');
      const tk = ct[k] || 0; C.arrow.visible = tk > 1e-9; if (tk > 1e-9) { const l = 0.012 + 0.05 * tk / tauMaxCell; C.arrow.position.set(tipX, tipY, pitch * 0.3); C.arrow.setDirection(new T.Vector3(-Math.sin(C.phi + psi), Math.cos(C.phi + psi), 0)); C.arrow.setLength(l, Math.min(0.01, l * 0.35), 0.006); }
    }
    const a = TAU * ((t % P) / P); head.position.set(Math.cos(a) * ringR, Math.sin(a) * ringR, zFly - tFly / 2 + o.tq / Math.max(...Wn.tq, 1e-9) * barH + 0.004);
    S0.hud.set([['t', f4(t) + ' s'], ['Shaft speed', f3(o.om * 60 / TAU) + ' rpm'], ['Drive torque Στᵢ', f3(o.tq) + ' N·m'], ['Mean torque', f3(R.tqMean) + ' N·m'], ['Torque ripple', f3(R.ripple * 100) + ' %'], ['Cells transmitting', `${Math.round(o.en)} / ${N}`], ['Load torque', f3(o.tl) + ' N·m'], ['Shaft power', f3(o.tl * o.om) + ' W']]);
  };
  rebuild();
  S0.V.animate = () => lab.update();
  S0.timeline({ duration: dur, onFrame, label: 'Shaft time', unit: 's', rate: 1 });
}

// =====================================================================================================================
// 5. Start-up (Suite 15): cold engine warming, breakaway, acceleration, steady running, shutdown
// =====================================================================================================================
async function startupView(el, ctx, res, p) {
  loading(el, 'Loading the solved start-up → steady → shutdown history…');
  let U; try { U = await S.solveStartup(ctx, res, p); } catch (e) { failBox(el, 'Start-up history unavailable: ' + (e?.message || e)); return; }
  if (!U) { failBox(el, 'The start-up model did not produce a speed history (the hot circuit may never reach the start temperature — see the verdicts).'); return; }
  let E; try { E = await S.solveEngine(ctx, { shaft: false }); } catch (e) { failBox(el, 'Engine geometry unavailable: ' + (e?.message || e)); return; }
  const S0 = await stage(el, { height: 560 }), T = S0.T, sc = buildEngineScene(S0, E); S0.finish();
  const N = E.N, c = U.cell, P = c.P, L = E.geo.L, mk = U.marks, tReady = mk['heat start cells'] ?? 0, tSeq = mk.sequencing ?? Infinity, tSD = mk.shutdown ?? Infinity;
  const startSet = new Set(range(U.nStart).map(k => Math.round(k * N / U.nStart) % N)), offs = U.offsets.length === N ? U.offsets : range(N).map(i => i / N);
  const Th = U.Thot ? S.sampler(U.Thot.t, ['v', U.Thot.y]) : null, Tcd = U.Tcold ? S.sampler(U.Tcold.t, ['v', U.Tcold.y]) : null, ws = S.sampler(U.t, ['om', U.omega], ['th', U.theta]);
  const tqs = U.tq ? S.sampler(U.tq.t, ['v', U.tq.y]) : null, ens = U.engaged ? S.sampler(U.engaged.t, ['v', U.engaged.y]) : null, o = {}, oo = {};
  const Tlo = Math.min(U.Tc, U.T0), Thi = U.Th; S0.setLegend({ title: 'Temperature (ribbons · plate stack = wall)', lo: Tlo, hi: Thi, unit: ' °C' });
  const dur = U.t[U.t.length - 1], step = stepper(dur), mag = Math.max(1, Math.round(clamp(0.15 * L / Math.max(c.xMax, 1e-9), 1, 20)));
  const lab = S0.labels; lab.add('Hot manifold (warming circuit)', (q) => q.set(E.geo.rPort, 0, E.geo.zM + E.geo.rM), '#ef4444'); lab.add('Rotor — breakaway & acceleration', (q) => q.set(0, 0, E.geo.shaftL / 2), '#e5e7eb');
  S0.button('Labels', 'Show / hide callouts', (b) => { S0.labels.visible = !S0.labels.visible; b.classList.toggle('on', S0.labels.visible); }, true);
  const hotC = new T.Color(), coldC = new T.Color(), act = { H: new Array(N).fill(false), C: new Array(N).fill(false) };
  const stageName = (t) => t < tReady ? 'warming circuits' : t < (mk.breakaway ?? Infinity) ? 'start cells heating' : t < tSeq ? 'breakaway / accelerating' : t < (mk.steady ?? Infinity) ? 'phase sequencing, accelerating' : t < tSD ? 'steady running' : t < (mk.stopped ?? Infinity) ? 'shutdown: coasting' : 'parked';
  const onFrame = (t) => {
    ws(t, o); const dt = step(t), Thot = Th ? Th(t, oo).v : U.Th, Tcold = Tcd ? Tcd(t, oo).v : U.Tc;
    sc.rot.rotation.z = o.th;
    for (let k = 0; k < N; k++) {
      const on = t < tSD && ((t >= tReady && startSet.has(k)) || t >= tSeq), tau = t + offs[k] * P, inst = sc.carts[k];
      let Tr = Tcold, Tw = Tcold, x = 0, en = 0;
      if (on) { const s = clamp((Thot - Tcold) / Math.max(U.Th - U.Tc, 1e-9), 0, 1), sc2 = (Thot - Tcold) / Math.max(U.Th - U.Tc, 1e-9); Tr = Tcold + (c.at('Tm', tau) - U.Tc) * sc2; Tw = Tcold + (c.at('Tw', tau) - U.Tc) * sc2; x = (c.at('x', tau) - c.xMin) * s; en = c.at('engaged', tau); }
      inst.set(mag * x, L); inst.clutchState(en); setCol(T, inst.ribMat.color, (Tr - Tlo) / (Thi - Tlo)); plateLook(T, inst.plateMat, 'T', Tw, Tlo, Thi);
      const ph = ((tau % P) + P) % P; act.H[k] = on && ph < c.duty * P; act.C[k] = !act.H[k] && t >= tReady;
    }
    setCol(T, hotC, (Thot - Tlo) / (Thi - Tlo)); setCol(T, coldC, (Tcold - Tlo) / (Thi - Tlo));
    sc.fluidH.step(dt * (t < tSD ? 1 : 0), act.H, hotC); sc.fluidC.step(dt, act.C, coldC);
    S0.hud.set([['t', f3(t) + ' s'], ['Stage', stageName(t), '#facc15'], ['Hot circuit', f3(Thot) + ' °C'], ['Cold circuit', f3(Tcold) + ' °C'], ['Shaft speed', f3(o.om * 60 / TAU) + ' rpm'], ['Drive torque', tqs ? f3(tqs(t, oo).v) + ' N·m' : '—'], ['Cells engaged', ens ? `${Math.round(ens(t, oo).v)} / ${N}` : '—']]);
  };
  S0.V.animate = () => lab.update();
  S0.timeline({ duration: dur, onFrame, label: 'Time from pump start', unit: 's', rate: clamp(Math.round(dur / 30), 1, 16) });
  S0.explain(`<b>What drives this scene.</b> The rotor angle is the time integral of the shaft speed solved by the Suite 15 start-up model (${U.src}): first-order warm-up of the hot (and settling of the cold) circuit, heating of ${U.nStart} start cells once the hot loop exceeds A_s(σ_H) + margin (t = ${f3(tReady)} s), breakaway against static friction and load (t = ${f3(mk.breakaway ?? NaN)} s), full phase sequencing (t = ${f3(tSeq)} s), steady running and shutdown with coast-down (t = ${f3(tSD)} s). `
    + `Manifold tracers and ribbon colours follow the solved circuit temperatures; an active cartridge replays the design-point cell cycle (transient ribbon cell) rescaled to the instantaneous circuit temperatures, with its stroke reduced in proportion to the available temperature lift (an interpolation of the cell model between the drive-table levels, ×${mag} display magnification). Inactive cartridges sit at the cold-circuit temperature. The default playback runs faster than real time; slow it down to watch individual strokes.`);
}

// =====================================================================================================================
// 6. Compliant mechanism (Suite 10)
// =====================================================================================================================
async function mechanismView(el, ctx, res, p) {
  loading(el, 'Solving the cartridge stroke and the transmission load–displacement path…');
  let Mm; try { Mm = await S.solveMechanism(ctx, res, p || {}); } catch (e) { failBox(el, 'Mechanism could not be solved: ' + (e?.message || e)); return; }
  const S0 = await stage(el, { height: 500 }), T = S0.T, V = S0.V, mats = baseMats(S0), cell = Mm.cell, P = cell.P, dur = 2 * P, xs = Mm.xf, xm = Mm.xm;
  const xAt = (t) => { const n = xs.length, q = (((t % P) + P) % P) / P * n, i = Math.floor(q) % n, f = q - Math.floor(q); return (xs[i] + (xs[(i + 1) % n] - xs[i]) * f) / xm; };
  const col = new T.Color();
  if (Mm.type === 'amplifier') {
    const g = Mm.g, M = Mm.M, b = g.b, nSeg = 3 * 2 + 1, sMax = Math.max(1e6, Mm.M.state(Mm.dPre + Mm.dIn).sig);
    const seg = []; for (let a = 0; a < 4; a++) for (let s = 0; s < nSeg; s++) { const hinge = s !== 3, m = mats.alu.clone(); m.userData.label = 'β-Ti flexure (colour = bending stress)'; const o = S0.add(V.root, new T.BoxGeometry(1, b, 1), m, { name: `${['Upper-left', 'Upper-right', 'Lower-left', 'Lower-right'][a]} arm ${hinge ? 'flexure hinge' : 'rigid link'}`, group: 'Bridge amplifier', edges: !hinge }); seg.push({ o, m, a, s, hinge }); }
    const blk = (name) => S0.add(V.root, new T.BoxGeometry(0.008, b * 1.15, 0.016), mats.steel, { name, group: 'Blocks', edges: true });
    const inL = blk('Input block (cartridge side)'), inR = blk('Input block (fixed side)'), outT = blk('Output apex (to coupling)'), outB = blk('Output apex (ground)'); outT.scale.set(2, 1, 0.5); outB.scale.set(2, 1, 0.5);
    const spr = S0.add(V.root, new T.CylinderGeometry(0.0025, 0.0025, 1, 16).rotateX(Math.PI / 2), mats.steel, { name: `Output load spring k_L = ${f3(Mm.kL / 1e3)} kN/m`, group: 'Load' });
    const aIn = [new T.ArrowHelper(new T.Vector3(1, 0, 0), new T.Vector3(), 0.02, 0xef4444), new T.ArrowHelper(new T.Vector3(-1, 0, 0), new T.Vector3(), 0.02, 0xef4444)], aOut = new T.ArrowHelper(new T.Vector3(0, 0, 1), new T.Vector3(), 0.02, 0x22c55e); aIn.forEach(a => V.root.add(a)); V.root.add(aOut);
    const place = (o, p0, p1, thk) => { const dx = p1[0] - p0[0], dz = p1[1] - p0[1], l = Math.hypot(dx, dz); o.position.set((p0[0] + p1[0]) / 2, 0, (p0[1] + p1[1]) / 2); o.rotation.set(0, -Math.atan2(dz, dx), 0); o.scale.set(l, 1, thk); };
    const draw = (d) => {
      const st = M.state(d), ch = st.chain.pts, aN = st.aNow, cN = st.cNow;
      for (const q of seg) { const sx = q.a % 2 ? -1 : 1, sz = q.a >= 2 ? -1 : 1, p0 = ch[q.s], p1 = ch[q.s + 1], tr = (pt) => [sx * (pt[0] - aN), sz * pt[1]]; place(q.o, tr(p0), tr(p1), q.hinge ? g.th : g.ta); if (q.hinge) setCol(T, q.m.color, st.sig / sMax, 'inferno'); }
      inL.position.set(-aN - 0.004, 0, 0); inR.position.set(aN + 0.004, 0, 0); outT.position.set(0, 0, cN + 0.004); outB.position.set(0, 0, -cN - 0.004);
      spr.position.set(0.025 + aN * 0.0, 0, 0); spr.position.x = 0; spr.scale.set(1, 1, 2 * cN); spr.position.z = 0; spr.visible = true;
      return st;
    };
    draw(Mm.dPre); S0.finish(V.root, 0.95);
    S0.setLegend({ title: 'Hinge bending stress', lo: 0, hi: sMax / 1e6, unit: ' MPa', cmapName: 'inferno' });
    const lab = S0.labels; lab.add('Input block — cartridge pulls inward', (o) => o.set(-g.L * Math.cos(g.alpha), 0, 0), '#ef4444'); lab.add('Output apex — opens (amplified)', (o) => o.set(0, 0, g.L * Math.sin(g.alpha)), '#22c55e'); lab.add('Flexure hinge (highest stress)', (o) => o.set(-g.L * Math.cos(g.alpha) + g.lh * 0.5 * Math.cos(g.alpha), 0, g.lh * 0.5 * Math.sin(g.alpha)), '#f97316');
    S0.button('Labels', 'Show / hide callouts', (b2) => { S0.labels.visible = !S0.labels.visible; b2.classList.toggle('on', S0.labels.visible); }, true);
    const st0 = M.state(Mm.dPre), Fmax = Math.max(Mm.Fin, 1e-9);
    const onFrame = (t) => {
      const d = Mm.dPre + Mm.dIn * xAt(t), st = draw(d), Fin = Mm.FinAt(d), Fout = Mm.kL * st.dout;
      aIn[0].position.set(-st.aNow - 0.034, 0, 0); aIn[1].position.set(st.aNow + 0.034, 0, 0); const li = 0.006 + 0.022 * clamp(Fin / Fmax, 0, 1.2); aIn.forEach(a => a.setLength(li, li * 0.3, li * 0.2));
      const lo = 0.006 + 0.022 * clamp(Fout / Math.max(Mm.kL * M.state(Mm.dPre + Mm.dIn).dout, 1e-9), 0, 1.2); aOut.position.set(0, 0, st.cNow + 0.012); aOut.setLength(lo, lo * 0.3, lo * 0.2);
      S0.hud.set([['t', f4(t) + ' s'], ['Input closure d', f3(d * 1e3) + ' mm'], ['Output opening', f3((st.dout - st0.dout) * 1e3) + ' mm'], ['Amplification (model)', f3(Mm.A)], ['Amplification (Suite 10 FE)', Mm.published?.amplification ? f3(Mm.published.amplification) : '—'], ['Input force F_in', f3(Fin) + ' N'], ['Output force k_L·Δ', f3(Fout) + ' N'], ['Hinge stress', f3(st.sig / 1e6) + ' MPa'], ['Stored energy U', f3(st.U * 1e3) + ' mJ']]);
    };
    S0.V.animate = () => lab.update();
    S0.timeline({ duration: dur, onFrame, label: 'Cartridge cycle time', unit: 's', rate: 1 });
    S0.explain(`<b>What drives this scene.</b> The input closure follows the solved free contraction of the transient ribbon cell (peak ${f3(Mm.dIn * 1e3)} mm, plus ${f3(Mm.dPre * 1e3)} mm prestress), so the bridge deforms at the cartridge's own pace. The bridge (arm ${f3(g.L * 1e3)} mm at α = ${f3(g.alpha * 180 / Math.PI)}°, hinges ${f3(g.th * 1e3)} × ${f3(g.lh * 1e3)} mm, ${Mm.matName}) is solved here as a pseudo-rigid-body model: rigid links with two flexure hinges per arm whose bending follows the exact closure geometry; the input force is the derivative of the stored energy (8 hinges, EI/l_h each, plus the matched output spring k_L = ${f3(Mm.kL / 1e3)} kN/m that uses ${f3(Mm.Fin)} N at full stroke). `
      + `Colour is the hinge bending stress E·t·Δθ/(2l_h) (peak ${f3(sMax / 1e6)} MPa). Geometry is at true scale (no magnification). The suite's co-rotational nonlinear FE amplification is shown in the HUD for comparison; small differences come from arm and hinge axial compliance that the pseudo-rigid-body model neglects.`);
  } else if (Mm.type === 'bistable') {
    const BB = Mm.BB, Lb = Mm.pp.bL / 1000, bt = Mm.pp.bT / 1000, bw = Mm.pp.bB / 1000, nShow = Math.min(Mm.nB, 6), nx = 61, kk = TAU / Lb;
    const shape = (a, x) => a[0] * (1 - Math.cos(kk * x)) + a[1] * (1 - Math.cos(2 * kk * x)) + a[2] * (1 - Math.cos(3 * kk * x)) + a[3] * (Math.sin(kk * x) - 0.5 * Math.sin(2 * kk * x));
    const curv = (a, x) => a[0] * kk * kk * Math.cos(kk * x) + a[1] * 4 * kk * kk * Math.cos(2 * kk * x) + a[2] * 9 * kk * kk * Math.cos(3 * kk * x) + a[3] * kk * kk * (-Math.sin(kk * x) + 2 * Math.sin(2 * kk * x));
    const a0 = BB.coeffs[0], beams = [];
    for (let s = 0; s < nShow; s++) {
      const g = new T.BufferGeometry(), pos = new Float32Array(nx * 4 * 3), colr = new Float32Array(nx * 4 * 3), id = [];
      for (let i = 0; i < nx - 1; i++) for (let q = 0; q < 4; q++) { const a = i * 4 + q, b2 = i * 4 + (q + 1) % 4, c2 = (i + 1) * 4 + (q + 1) % 4, d2 = (i + 1) * 4 + q; id.push(a, b2, c2, a, c2, d2); }
      id.push(0, 2, 1, 0, 3, 2); const e = (nx - 1) * 4; id.push(e, e + 1, e + 2, e, e + 2, e + 3);
      g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('color', new T.BufferAttribute(colr, 3)); g.setIndex(id);
      const m = new T.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.5, roughness: 0.35, side: T.DoubleSide, clippingPlanes: S0.clip }); m.userData.label = `${Mm.matName} beam (colour = bending stress)`;
      const o = S0.add(V.root, g, m, { name: `Bistable beam ${s + 1} of ${Mm.nB}`, group: 'Bistable beams' }); beams.push({ g, pos, colr, y0: (s - (nShow - 1) / 2) * bw * 1.6 }); void o;
    }
    const clampG = new T.BoxGeometry(0.006, nShow * bw * 1.6 + bw, Mm.pp.bH / 1000 * 3 + 0.006);
    for (const s of [-1, 1]) { const c2 = S0.add(V.root, clampG, mats.steel, { name: 'Clamp', group: 'Frame', edges: true }); c2.position.set(s * (Lb / 2 + 0.003), 0, 0); }
    const pusher = S0.add(V.root, new T.BoxGeometry(0.004, nShow * bw * 1.6, 0.004), mats.dark, { name: 'Input pusher (cartridge)', group: 'Load', edges: true });
    const arrow = new T.ArrowHelper(new T.Vector3(0, 0, -1), new T.Vector3(), 0.01, 0xfacc15); V.root.add(arrow);
    const sMax = Math.max(1, ...BB.maxCurvature) * Mm.E * bt / 2; let zMag = 1;
    const drawB = (k, f) => { const A = BB.coeffs[k], B = BB.coeffs[Math.min(k + 1, BB.coeffs.length - 1)], a = A.map((v, i) => v + (B[i] - v) * f);
      for (const bm of beams) { for (let i = 0; i < nx; i++) { const x = Lb * i / (nx - 1), w = shape(a, x), sl = (shape(a, x + 1e-6 * Lb) - w) / (1e-6 * Lb), nl = Math.hypot(1, sl), nxv = -sl / nl, nzv = 1 / nl, sg = Math.abs(curv(a, x) - curv(a0, x)) * Mm.E * bt / 2; setCol(T, col, sg / sMax, 'inferno');
        const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]]; cs.forEach(([u, v], q) => { const j = (i * 4 + q) * 3; bm.pos[j] = x - Lb / 2 + nxv * v * bt / 2; bm.pos[j + 1] = bm.y0 + u * bw / 2; bm.pos[j + 2] = zMag * w + nzv * v * bt / 2; bm.colr[j] = col.r; bm.colr[j + 1] = col.g; bm.colr[j + 2] = col.b; }); }
        bm.g.attributes.position.needsUpdate = true; bm.g.attributes.color.needsUpdate = true; bm.g.computeVertexNormals(); bm.g.computeBoundingSphere(); }
      return a; };
    drawB(0, 0); S0.finish(V.root, 0.9);
    S0.setLegend({ title: 'Bending stress (clamps / mid-span)', lo: 0, hi: sMax / 1e6, unit: ' MPa', cmapName: 'inferno' });
    const lab = S0.labels; lab.add(`Pre-shaped beam (rise ${f3(Mm.pp.bH)} mm), ${Mm.nB} in parallel`, (o) => o.set(-Lb / 4, 0, Mm.pp.bH / 1000 * 0.5), '#f97316'); lab.add('Input pusher', (o) => o.set(0, 0, pusher.position.z + 0.003), '#facc15');
    S0.button('Labels', 'Show / hide callouts', (b2) => { S0.labels.visible = !S0.labels.visible; b2.classList.toggle('on', S0.labels.visible); }, true);
    const dmax = BB.d[BB.d.length - 1];
    S0.slider('Vertical exaggeration', { min: 1, max: 10, value: 1, fmtv: (v) => `×${v} (rise ${f3(Mm.pp.bH)} mm true)`, onInput: (v) => { zMag = v; if (S0.pb) S0.pb.set(S0.pb.t); } });
    const onFrame = (t) => {
      const dd = Mm.dEnd * xAt(t), q = clamp(dd / dmax, 0, 1) * (BB.d.length - 1), k = Math.min(BB.d.length - 2, Math.floor(q)), f = q - k, a = drawB(k, f), F = (BB.F[k] + (BB.F[k + 1] - BB.F[k]) * f) * Mm.nB, wMid = shape(a, Lb / 2);
      pusher.position.set(0, 0, zMag * wMid + bt / 2 + 0.002); arrow.position.set(0, 0, zMag * wMid + 0.004 + 0.02); const l = 0.004 + 0.016 * clamp(Math.abs(F) / Math.max(Mm.Fmax, 1e-9), 0, 1); arrow.setDirection(new T.Vector3(0, 0, F >= 0 ? -1 : 1)); arrow.setLength(l, l * 0.3, l * 0.2); arrow.setColor(F >= 0 ? 0xfacc15 : 0xef4444);
      const U = BB.U[k] + (BB.U[k + 1] - BB.U[k]) * f;
      S0.hud.set([['t', f4(t) + ' s'], ['Mid-span displacement', f3(dd * 1e3) + ' mm'], ['Force (all beams)', f3(F) + ' N', F < 0 ? '#ef4444' : undefined], ['Branch', F < 0 ? 'unstable (snap-through)' : 'stable', F < 0 ? '#ef4444' : '#22c55e'], ['Strain energy', f3(U * Mm.nB * 1e3) + ' mJ'], ['Snap force F_top', f3(BB.Ftop * Mm.nB) + ' N'], ['Second stable state', Number.isFinite(BB.d2) ? f3(BB.d2 * 1e3) + ' mm' : 'none (monostable)']]);
    };
    S0.V.animate = () => lab.update();
    S0.timeline({ duration: dur, onFrame, label: 'Cartridge cycle time', unit: 's', rate: 1 });
    S0.explain(`<b>What drives this scene.</b> The beam shape at every instant is the Rayleigh–Ritz equilibrium of fem.bistableBeam (four mode amplitudes from displacement-controlled continuation through the unstable branch; span ${f3(Mm.pp.bL)} mm, rise ${f3(Mm.pp.bH)} mm, thickness ${f3(Mm.pp.bT)} mm, ${Mm.matName}); the mid-span displacement follows the solved cartridge contraction so the beams are pushed to the second state and released once per cell cycle. Colour is the bending stress E·t/2·|Δκ|, the arrow the reaction force (red: negative stiffness branch where the beam would snap without restraint). ${nShow < Mm.nB ? `${nShow} of the ${Mm.nB} parallel beams are drawn; forces are for all.` : ''} Geometry is at true scale unless the vertical-exaggeration slider is raised (it multiplies only the transverse deflection).`);
  } else {
    const cg = Mm.cellGeo, nx = Math.min(Mm.nx, 16), ny = Math.min(Mm.ny, 10), P0 = [], seg = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) { const ox = i * cg.a1[0] + j * cg.a2[0], oy = j * cg.a2[1]; for (const s of cg.struts) { const A = cg.nodes[s.i], B = cg.nodes[s.j], sh = s.shift || [0, 0]; const bx = B[0] + sh[0] * cg.a1[0] + sh[1] * cg.a2[0], by = B[1] + sh[0] * cg.a1[1] + sh[1] * cg.a2[1]; seg.push([ox + A[0], oy + A[1], ox + bx, oy + by]); } }
    const x0 = -(nx * cg.a1[0]) / 2, y0 = -(ny * cg.a2[1]) / 2, pos = new Float32Array(seg.length * 6), lg = new T.BufferGeometry(); lg.setAttribute('position', new T.BufferAttribute(pos, 3));
    const lines = new T.LineSegments(lg, new T.LineBasicMaterial({ color: 0xcbd5e1, clippingPlanes: S0.clip })); V.root.add(lines); void P0;
    const plate = S0.add(V.root, new T.BoxGeometry(nx * cg.a1[0] * 1.05, 0.002, ny * cg.a2[1] * 1.05), S0.mat('peek', { opacity: 0.25 }), { name: `Auxetic lattice envelope (ν = ${f3(Mm.nu)})`, group: 'Lattice', shadow: false }); plate.position.y = -0.002;
    const draw = (ex, ey) => { seg.forEach((s, k) => { pos.set([(x0 + s[0]) * (1 + ex), 0, (y0 + s[1]) * (1 + ey), (x0 + s[2]) * (1 + ex), 0, (y0 + s[3]) * (1 + ey)], 6 * k); }); lg.attributes.position.needsUpdate = true; lg.computeBoundingSphere(); };
    const mag = Math.max(1, Math.round(0.08 / Math.max(Math.abs(Mm.strain(Mm.dIn).ex), 1e-9)));
    draw(0, 0); S0.finish(V.root, 0.9);
    const onFrame = (t) => { const s = Mm.strain(Mm.dIn * xAt(t)); draw(s.ex * mag, s.ey * mag); S0.hud.set([['t', f4(t) + ' s'], ['Input strain ε_x', f4(s.ex)], ['Output strain ε_y', f4(s.ey)], ['Effective ν', f3(Mm.nu)], ['Input force', f3(s.Fin) + ' N'], ['Output displacement', f3(s.dout * 1e3) + ' mm'], ['Display magnification', '×' + mag]]); };
    S0.timeline({ duration: dur, onFrame, label: 'Cartridge cycle time', unit: 's', rate: 1 });
    S0.explain(`<b>What drives this scene.</b> The re-entrant lattice deforms affinely with the homogenised strains of fem.homogenize (effective Poisson ratio ${f3(Mm.nu)}) for the solved cartridge stroke, against the matched output load; strains are magnified ×${mag} for visibility (labelled in the HUD). ${nx < Mm.nx || ny < Mm.ny ? `A ${nx} × ${ny} window of the ${Mm.nx} × ${Mm.ny} lattice is drawn.` : ''}`);
  }
}

// =====================================================================================================================
// 7. Laboratory rig for a virtual (or replayed) run: specimen ribbon, hot & cold baths, load cell, displacement transducer
// =====================================================================================================================
export async function labRig3D(el, run) {
  const L = S.labSeries(run);
  if (!L || !L.F || !L.x) { failBox(el, 'This run has no time, force and displacement channels to drive the rig (cell-cycle runs do).'); return null; }
  const S0 = await stage(el, { height: 500 }), T = S0.T, V = S0.V, mats = baseMats(S0);
  const sp = 0.1, wR = 0.005, tR = 0.0012; // display ribbon (true width; thickness enlarged ×12 for visibility, labelled)
  const frame = (x, y, z, sx, sy, sz, name, m = mats.dark) => { const o = S0.add(V.root, new T.BoxGeometry(sx, sy, sz), m, { name, group: 'Frame', edges: true, center: [x, y, z] }); o.position.set(x, y, z); return o; };
  frame(0, 0, -0.005, 0.32, 0.16, 0.01, 'Base plate'); frame(-0.12, 0, 0.12, 0.018, 0.018, 0.25, 'Column'); frame(0.12, 0, 0.12, 0.018, 0.018, 0.25, 'Column'); frame(0, 0, 0.25, 0.27, 0.03, 0.02, 'Crosshead');
  const lc = S0.add(V.root, new T.CylinderGeometry(0.014, 0.014, 0.022, 48).rotateX(Math.PI / 2), mats.alu, { name: 'Load cell', group: 'Instrumentation', edges: true }); lc.position.set(0, 0, 0.229);
  const ug = frame(0, 0, 0.205, 0.022, 0.012, 0.02, 'Upper grip', mats.alu);
  const rib = S0.add(V.root, new T.BoxGeometry(wR, tR, 1).translate(0, 0, -0.5), mats.niti.clone(), { name: 'Specimen ribbon (thickness drawn ×12)', group: 'Specimen' }); rib.position.set(0, 0, 0.195); rib.scale.z = sp;
  const lg = frame(0, 0, 0.195 - sp - 0.01, 0.022, 0.012, 0.02, 'Lower grip (to actuator / bias)', mats.alu);
  const lvdt = S0.add(V.root, new T.CylinderGeometry(0.004, 0.004, 0.05, 24).rotateX(Math.PI / 2), mats.steel, { name: 'Displacement transducer core', group: 'Instrumentation' });
  const cham = S0.add(V.root, new T.CylinderGeometry(0.03, 0.03, sp * 0.9, 64, 1, true).rotateX(Math.PI / 2), S0.mat('clear', { opacity: 0.18 }), { name: 'Fluid chamber (switching hot/cold)', group: 'Thermal', shadow: false }); cham.position.set(0, 0, 0.195 - sp / 2);
  const tankH = S0.add(V.root, new T.BoxGeometry(0.07, 0.07, 0.07), S0.mat('clear', { opacity: 0.3, color: 0xef4444 }), { name: 'Hot bath', group: 'Thermal' }); tankH.position.set(-0.24, 0, 0.035);
  const tankC = S0.add(V.root, new T.BoxGeometry(0.07, 0.07, 0.07), S0.mat('clear', { opacity: 0.3, color: 0x3b82f6 }), { name: 'Cold bath', group: 'Thermal' }); tankC.position.set(0.24, 0, 0.035);
  const pipe = (x0, x1, m, name) => { const o = S0.add(V.root, new T.CylinderGeometry(0.004, 0.004, Math.abs(x1 - x0), 20).rotateZ(Math.PI / 2), m, { name, group: 'Thermal' }); o.position.set((x0 + x1) / 2, 0, 0.145); return o; };
  pipe(-0.205, -0.03, mats.hot, 'Hot supply line'); pipe(0.03, 0.205, mats.cold, 'Cold supply line');
  const pcH = pointCloud(S0, 120, 0.004), pcC = pointCloud(S0, 120, 0.004), pr = range(120).map(() => Math.random());
  const arrow = new T.ArrowHelper(new T.Vector3(0, 0, 1), new T.Vector3(0, 0.02, 0.2), 0.03, 0xfacc15); V.root.add(arrow);
  S0.finish();
  const t = L.t, dur = t[t.length - 1] - t[0], t0 = t[0], ser = [['F', L.F], ['x', L.x]]; if (L.T) ser.push(['T', L.T]); if (L.Tf) ser.push(['Tf', L.Tf]); if (L.xi) ser.push(['xi', L.xi]); if (L.phase) ser.push(['ph', L.phase]);
  const smp = S.sampler(t, ...ser), o = {}, Fmax = Math.max(...L.F.map(Math.abs), 1e-9), xMin = Math.min(...L.x), xMax = Math.max(...L.x) - xMin, mag = Math.max(1, Math.round(0.012 / Math.max(xMax, 1e-9)));
  const Tl = Math.min(...(L.Tf || L.T || [0])), Thh = Math.max(...(L.Tf || L.T || [1])); S0.setLegend({ title: 'Specimen / fluid temperature', lo: Tl, hi: Thh, unit: ' °C' });
  const lab = S0.labels; lab.add('Load cell', (q) => q.set(0, 0, 0.229), '#94a3b8'); lab.add('Specimen ribbon', (q) => q.set(0, 0, 0.195 - sp / 2), '#c58b4b'); lab.add('Hot bath', (q) => q.set(-0.24, 0, 0.07), '#ef4444'); lab.add('Cold bath', (q) => q.set(0.24, 0, 0.07), '#3b82f6');
  const step = stepper(dur), col = new T.Color();
  const onFrame = (tt) => {
    const dt = step(tt); smp(t0 + tt, o); const xd = (o.x - xMin) * mag, Ls = sp - xd, hot = o.ph !== undefined ? o.ph > 0.5 : (o.Tf ?? 0) > (Tl + Thh) / 2;
    rib.scale.z = Ls; lg.position.z = 0.195 - Ls - 0.01; lvdt.position.set(0.02, 0, 0.195 - Ls - 0.035);
    if (o.T !== undefined) setCol(T, rib.material.color, (o.T - Tl) / ((Thh - Tl) || 1)); if (o.Tf !== undefined) { setCol(T, cham.material.color, (o.Tf - Tl) / ((Thh - Tl) || 1)); }
    const l = 0.01 + 0.04 * Math.abs(o.F) / Fmax; arrow.setLength(l, l * 0.3, l * 0.2);
    for (const [pc, isHot] of [[pcH, true], [pcC, false]]) { setCol(T, col, isHot ? 1 : 0); for (let i = 0; i < 120; i++) { if ((isHot && hot) || (!isHot && !hot)) pr[i] = (pr[i] + dt * 0.8) % 1; const s = pr[i], x = isHot ? -0.205 + s * 0.175 : 0.205 - s * 0.175; pc.pos.set([x, (Math.random() - 0.5) * 0.004, 0.145 + (Math.random() - 0.5) * 0.004], 3 * i); pc.col.set([col.r, col.g, col.b], 3 * i); } pc.p.visible = isHot === hot; pc.flush(); }
    S0.hud.set([['t', f3(tt) + ' s'], ['Valve', hot ? 'HOT' : 'COLD', hot ? '#ef4444' : '#3b82f6'], ['Load cell F', f3(o.F) + ' N'], ['Displacement x', f3((o.x - xMin) * 1e3) + ' mm'], ['Specimen T', o.T !== undefined ? f3(o.T) + ' °C' : '—'], ['Fluid T', o.Tf !== undefined ? f3(o.Tf) + ' °C' : '—'], ['Martensite ξ', o.xi !== undefined ? f3(o.xi) : '—'], ['Data', L.prov === 'measured' ? 'measured' : 'simulated (hypothetical)', L.prov === 'measured' ? '#22c55e' : '#facc15']]);
  };
  S0.V.animate = () => lab.update();
  S0.timeline({ duration: dur, onFrame, label: 'Run time', unit: 's', rate: 1 });
  S0.explain(`<b>What drives this scene.</b> Every value comes from the run's recorded channels (${L.name}; ${L.prov === 'measured' ? 'measured' : 'model output — simulated, not a measurement'}): the lower grip moves by the displacement channel (×${mag} display magnification), the specimen colour is the specimen temperature, the chamber colour the fluid temperature, the flow line that carries tracers is the one selected by the valve-phase channel, and the arrow at the load cell is scaled to the force channel (peak ${f3(Fmax)} N). The ribbon thickness is drawn ×12 so it remains visible; the rig frame is schematic.`);
  return S0;
}

// =====================================================================================================================
// Registry consumed by suite.js: VIEWS3D[id] → [{label, icon, render(el, ctx, res, p)}]
// =====================================================================================================================
const guard = (fn) => async (el, ctx, res, p) => { try { await fn(el, ctx, res, p); } catch (e) { console.error(e); failBox(el, '3-D simulation error: ' + (e?.message || e)); } };
export const VIEWS3D = {
  s01: [{ label: '3-D engine running', icon: '🧊', render: guard((el, ctx) => engineView(el, ctx, null, null)) }],
  s02: [{ label: '3-D engine running', icon: '🧊', render: guard(engineView) }],
  s05: [{ label: '3-D cartridge cycle', icon: '🧊', render: guard(async (el, ctx, res, p) => { loading(el, 'Solving the transient ribbon cell…'); const c = S.cellFromS05(ctx, p); await cartridgeView(el, ctx, c, { title: 'Cartridge', srcNote: p?.ribbonL_mm !== undefined ? 'Inputs: this suite\'s resolved parameters (same configuration as its run, resolution capped for playback).' : 'Inputs: engine design (Suite 05 parameters not available).' }); }) }],
  s08: [{ label: '3-D microchannel transient', icon: '🧊', render: guard(microchannelView) }],
  s10: [{ label: '3-D compliant mechanism', icon: '🧊', render: guard(mechanismView) }],
  s11: [{ label: '3-D shaft & clutches', icon: '🧊', render: guard((el, ctx, res, p) => shaftView(el, ctx, res, p, { suite: 's11' })) }],
  s12: [{ label: '3-D phased cells', icon: '🧊', render: guard((el, ctx, res, p) => shaftView(el, ctx, res, p, { suite: 's12' })) }],
  s14: [{ label: '3-D co-simulated cell', icon: '🧊', render: guard(async (el, ctx, res) => { loading(el, 'Solving the cell at the converged co-simulation operating point…'); const c = S.cellFromS14(ctx, res); await cartridgeView(el, ctx, c, { title: 'Co-simulated cell', srcNote: `Operating point: ${c.src}.` }); }) }],
  s15: [{ label: '3-D start-up', icon: '🧊', render: guard(startupView) }],
};
export { engineView, cartridgeView, microchannelView, shaftView, startupView, mechanismView };
