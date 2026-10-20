// 3D viewport wrapper (vendored WebGL library): CAD solids, field contours on surfaces, exploded / cut-away / x-ray views,
// synchronised animation and glTF export. the 3D library is loaded lazily so the console stays fast.
import { cmap } from './chart.js';

let THREE = null, OrbitControls = null;
export async function loadThree() {
  if (THREE) return THREE;
  THREE = await import('three'); ({ OrbitControls } = await import('../../vendor/OrbitControls.js'));
  return THREE;
}

// Registry of live viewers so WebGL contexts are released when their page is left (browsers cap active contexts ≈ 8–16).
const LIVE = new Set();
export function disposeDetached() { for (const v of [...LIVE]) if (!v.container.isConnected) { try { v.dispose(); } catch { /* already gone */ } LIVE.delete(v); } }
export const liveViewerCount = () => LIVE.size;

export async function viewer(container, { background, up = 'z', grid = true, height } = {}) {
  await loadThree();
  // keep well below the browser limit even inside a single page with many 3D tabs: release the oldest hidden viewer
  if (LIVE.size >= 6) { const hidden = [...LIVE].find(v => !v.container.isConnected || !v.container.offsetParent); if (hidden) { try { hidden.dispose(); } catch { /* ignore */ } LIVE.delete(hidden); } }
  container.classList.add('viewer'); container.innerHTML = '';
  const W = () => container.clientWidth || 600, H = () => height || Math.max(300, Math.min(620, Math.round(W() * 0.62)));
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.setSize(W(), H());
  renderer.localClippingEnabled = true; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  const dark = document.documentElement.dataset.theme !== 'light' && !(matchMedia('(prefers-color-scheme: light)').matches && document.documentElement.dataset.theme !== 'dark');
  const scene = new THREE.Scene(); scene.background = new THREE.Color(background || (dark ? 0x0d1323 : 0xeef2f7));
  if (up === 'z') THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
  const camera = new THREE.PerspectiveCamera(40, W() / H(), 0.01, 500); camera.up.set(0, 0, up === 'z' ? 1 : 0); if (up !== 'z') camera.up.set(0, 1, 0);
  camera.position.set(6, -7, 4.5);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.target.set(0, 0, 1.4);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(5, -6, 9); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xaaccff, 0.8); fill.position.set(-6, 5, 3); scene.add(fill);
  let gridObj = null;
  if (grid) { gridObj = new THREE.GridHelper(20, 40, dark ? 0x334155 : 0x94a3b8, dark ? 0x1e293b : 0xcbd5e1); if (up === 'z') gridObj.rotation.x = Math.PI / 2; scene.add(gridObj); }
  const root = new THREE.Group(); scene.add(root);
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 100);
  const state = { objects: [], exploded: 0, xray: false, section: false, animate: null, raf: 0, disposed: false };
  const label = document.createElement('div'); label.className = 'viewer-label'; container.appendChild(label);
  const toolbar = document.createElement('div'); toolbar.className = 'viewer-tools'; container.appendChild(toolbar);
  const tool = (txt, title, fn) => { const b = document.createElement('button'); b.className = 'icon-btn sm'; b.textContent = txt; b.title = title; b.onclick = fn; toolbar.appendChild(b); return b; };
  tool('⟲', 'Reset view', () => fit()); tool('Iso', 'Isometric view', () => viewDir(1, -1, 0.8)); tool('Top', 'Top view', () => viewDir(0, -0.001, 1)); tool('Side', 'Side view', () => viewDir(0, -1, 0.05)); tool('Front', 'Front view', () => viewDir(1, 0, 0.05));
  const bx = tool('Explode', 'Exploded assembly view', () => { state.exploded = state.exploded ? 0 : 1; applyExplode(); bx.classList.toggle('on', !!state.exploded); });
  const bxr = tool('X-ray', 'Transparent / cut-away view', () => { state.xray = !state.xray; for (const o of state.objects) { o.material.transparent = state.xray || o.userData.baseOpacity < 1; o.material.opacity = state.xray ? 0.28 : o.userData.baseOpacity; o.material.depthWrite = !state.xray; } bxr.classList.toggle('on', state.xray); });
  const bs = tool('Section', 'Section view (cut plane at y = 0)', () => { state.section = !state.section; clipPlane.constant = state.section ? 0 : 100; bs.classList.toggle('on', state.section); });
  tool('PNG', 'Save high-resolution image', () => snapshot(3));
  tool('4K', 'Save a 3840 × 2160 (4K UHD) image', () => snapshot4K());
  tool('GLB', 'Export glTF binary of the scene', () => exportGLB());
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  renderer.domElement.addEventListener('pointermove', (ev) => {
    const r = renderer.domElement.getBoundingClientRect(); mouse.x = ((ev.clientX - r.left) / r.width) * 2 - 1; mouse.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(mouse, camera); const hit = ray.intersectObjects(state.objects, false)[0];
    if (hit) { const o = hit.object, f = o.userData.field; let txt = `<b>${o.name}</b>${o.userData.group ? ' · ' + o.userData.group : ''}${o.userData.material ? '<br>' + o.userData.material : ''}`; if (f && hit.face) { const v = (f.values[hit.face.a] + f.values[hit.face.b] + f.values[hit.face.c]) / 3; txt += `<br>${f.name}: <b>${v.toPrecision(4)}</b> ${f.unit || ''}`; } label.innerHTML = txt; label.style.display = 'block'; } else label.style.display = 'none';
  });
  function viewDir(x, y, z) { const box = new THREE.Box3().setFromObject(state.frameObj || root), c = box.getCenter(new THREE.Vector3()), s = (box.getSize(new THREE.Vector3()).length() || 5) * 1.25; controls.target.copy(c); camera.position.set(c.x + x * s, c.y + y * s, c.z + z * s); controls.update(); }
  function fit() { viewDir(0.75, -1.05, 0.62); }
  function applyExplode() {
    const box = new THREE.Box3().setFromObject(root), c = box.getCenter(new THREE.Vector3());
    for (const o of state.objects) { const oc = o.userData.center; const d = new THREE.Vector3(oc[0] - c.x, oc[1] - c.y, oc[2] - c.z); o.position.copy(d.multiplyScalar(state.exploded * 0.6)); }
  }
  function add(mesh, { field, wireframe, opacity, metalness = 0.25, roughness = 0.55 } = {}) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3)); g.setIndex(new THREE.BufferAttribute(mesh.indices, 1)); g.computeVertexNormals();
    const op = opacity ?? mesh.opacity ?? 1;
    const mat = new THREE.MeshStandardMaterial({ color: field ? 0xffffff : new THREE.Color(mesh.color), metalness, roughness, side: THREE.DoubleSide, transparent: op < 1, opacity: op, depthWrite: op >= 1, clippingPlanes: [clipPlane], vertexColors: !!field, wireframe: !!wireframe, flatShading: false });
    if (field) setField(g, field);
    const o = new THREE.Mesh(g, mat); o.name = mesh.name; o.userData = { group: mesh.group, material: mesh.materialName, baseOpacity: op, field, center: mesh.centroid ? mesh.centroid() : [0, 0, 0], cartridge: mesh.cartridge };
    root.add(o); state.objects.push(o); return o;
  }
  function setField(g, field) { const n = g.attributes.position.count, col = new Float32Array(n * 3), lo = field.min ?? Math.min(...field.values), hi = field.max ?? Math.max(...field.values); for (let k = 0; k < n; k++) { const c = cmap((field.values[k] - lo) / ((hi - lo) || 1), field.cmap || 'turbo'); col[k * 3] = c[0] / 255; col[k * 3 + 1] = c[1] / 255; col[k * 3 + 2] = c[2] / 255; } g.setAttribute('color', new THREE.BufferAttribute(col, 3)); }
  function updateField(o, field) { o.userData.field = field; setField(o.geometry, field); o.geometry.attributes.color.needsUpdate = true; o.material.vertexColors = true; o.material.color.set(0xffffff); o.material.needsUpdate = true; }
  function updatePositions(o, positions) { o.geometry.attributes.position.array.set(positions); o.geometry.attributes.position.needsUpdate = true; o.geometry.computeVertexNormals(); }
  function clear() { for (const o of state.objects) { root.remove(o); o.geometry.dispose(); o.material.dispose(); } state.objects = []; for (const c of [...root.children]) root.remove(c); }
  function addLine(points, color = 0xffffff, width = 1) { const g = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p))); const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, linewidth: width })); root.add(l); return l; }
  function addArrow(origin, dir, len, color = 0xfacc15) { const a = new THREE.ArrowHelper(new THREE.Vector3(...dir).normalize(), new THREE.Vector3(...origin), len, color, len * 0.2, len * 0.1); root.add(a); return a; }
  function snapshot(scale = 2) { const w = renderer.domElement.width, hh = renderer.domElement.height; renderer.setSize(W() * scale, H() * scale, false); renderer.render(scene, camera); renderer.domElement.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'therma-3d.png'; a.click(); }); renderer.setSize(W(), H(), false); renderer.domElement.style.width = '100%'; void w; void hh; }
  function snapshot4K() { const pr = renderer.getPixelRatio(), asp = camera.aspect; renderer.setPixelRatio(1); renderer.setSize(3840, 2160, false); camera.aspect = 16 / 9; camera.updateProjectionMatrix(); renderer.render(scene, camera); renderer.domElement.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'therma-3d-4k.png'; a.click(); }); renderer.setPixelRatio(pr); renderer.setSize(W(), H(), false); renderer.domElement.style.width = '100%'; camera.aspect = asp; camera.updateProjectionMatrix(); }
  async function exportGLB() { const { GLTFExporter } = await import('../../vendor/GLTFExporter.js'); new GLTFExporter().parse(root, (res) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([res], { type: 'model/gltf-binary' })); a.download = 'therma-scene.glb'; a.click(); }, (e) => console.error(e), { binary: true }); }
  const ro = new ResizeObserver(() => { renderer.setSize(W(), H()); camera.aspect = W() / H(); camera.updateProjectionMatrix(); }); ro.observe(container);
  let last = performance.now();
  const loop = (t) => { if (state.disposed) return; state.raf = requestAnimationFrame(loop); const dt = (t - last) / 1000; last = t; if (state.animate) state.animate(dt, t / 1000); controls.update(); renderer.render(scene, camera); };
  // pause rendering when off-screen to save battery on phones
  const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) { if (!state.raf) { last = performance.now(); state.raf = requestAnimationFrame(loop); } } else { cancelAnimationFrame(state.raf); state.raf = 0; } }); io.observe(container);
  state.raf = requestAnimationFrame(loop);
  // static scenes (no simulation driving them) turn slowly so the model is never frozen; any user interaction stops it
  setTimeout(() => { if (!state.animate && !state.disposed && !state.userTouched) { controls.autoRotate = true; controls.autoRotateSpeed = 0.9; } }, 1200);
  renderer.domElement.addEventListener('pointerdown', () => { state.userTouched = true; controls.autoRotate = false; });
  const api = {
    setFrameObject(o) { state.frameObj = o; camera.far = 5000; camera.updateProjectionMatrix(); },
    THREE, scene, camera, controls, renderer, root, add, clear, fit, viewDir, updateField, updatePositions, addLine, addArrow, snapshot, exportGLB,
    set animate(fn) { state.animate = fn; }, get objects() { return state.objects; },
    dispose() { if (state.disposed) return; state.disposed = true; cancelAnimationFrame(state.raf); ro.disconnect(); io.disconnect(); clear(); renderer.dispose(); try { renderer.forceContextLoss(); } catch { /* ignore */ } LIVE.delete(api); },
  };
  api.container = container; LIVE.add(api);
  return api;
}
