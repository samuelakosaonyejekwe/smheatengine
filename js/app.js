// THERMA-X100 application shell: routing, navigation, site selection, installation, offline support, updates.
import { h, $, modal, toast } from './core/ui.js';
import { store } from './core/state.js';
import { SUITES, GROUPS } from './suites/index.js';
import { geocode, reverseGeocode, onStatus } from './core/live.js';

export const VERSION = '2026.10.20';
window.TX_VERSION = VERSION;
$('#ver').textContent = 'v' + VERSION;

// ---------- theme ----------
const savedTheme = (() => { try { return localStorage.getItem('tx.theme'); } catch { return null; } })();
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('#themeBtn').onclick = () => { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); const nx = cur === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = nx; try { localStorage.setItem('tx.theme', nx); } catch { /* ignore */ } };

// ---------- sidebar ----------
function drawSidebar() {
  const sb = $('#sidebar'); sb.innerHTML = '';
  sb.append(h('a', { href: '#/' }, h('span', { class: 'n' }, '⌂'), 'Engineering console'), h('a', { href: '#/feasibility' }, h('span', { class: 'n' }, '✓'), 'Feasibility gate & full chain'), h('a', { href: '#/register' }, h('span', { class: 'n' }, '⛁'), 'EIGDAS input register'), h('a', { href: '#/lab' }, h('span', { class: 'n' }, '⚗'), 'Experimental laboratory'));
  for (const g of GROUPS) {
    sb.append(h('div', { class: 'grp' }, g));
    for (const s of SUITES.filter(x => x.group === g)) { const o = store.outputMeta(s.id); sb.append(h('a', { href: `#/suite/${s.id}`, 'data-id': s.id }, h('span', { class: 'n' }, String(s.num).padStart(2, '0')), h('span', {}, s.icon + ' ' + s.short), h('span', { class: 'st ' + (o ? (o.stale ? 'stale' : 'ok') : ''), title: o ? (o.stale ? 'stale' : 'current') : 'not run' }))); }
  }
}
drawSidebar();
let sbTimer; store.subscribe((e) => { if (e.type === 'storage') toast(e.msg, e.level, 12000); if (['output', 'reset', 'engine', 'material', 'site'].includes(e.type)) { clearTimeout(sbTimer); sbTimer = setTimeout(drawSidebar, 200); } if (e.type === 'site' || e.type === 'reset') siteLabel(); });
$('#menuBtn').onclick = () => { $('#sidebar').classList.toggle('open'); $('#topnav').classList.toggle('open'); };

// ---------- router ----------
const PAGES = { '': 'home', feasibility: 'feasibility', scenarios: 'scenarios', portal: 'portal', datahub: 'datahub', register: 'register', library: 'library', lab: 'lab', project: 'project', help: 'help', install: 'install' };
let current = null;
async function route() {
  const hash = location.hash.replace(/^#\/?/, ''), [page, arg] = hash.split('/');
  const main = $('#main'); current?.dispose?.(); current = null;
  main.innerHTML = ''; window.scrollTo({ top: 0 });
  import('./core/viz3d.js').then(m => m.disposeDetached()).catch(() => { });
  $('#sidebar').classList.remove('open'); $('#topnav').classList.remove('open');
  document.querySelectorAll('.sidebar a, .topnav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#/' + hash || (hash === '' && a.getAttribute('href') === '#/')));
  try {
    if (page === 'suite' && arg) { const { renderSuite } = await import('./core/suite.js'); const s = SUITES.find(x => x.id === arg); document.title = s ? `${String(s.num).padStart(2, '0')} ${s.short} · THERMA-X100` : 'THERMA-X100'; current = await renderSuite(main, arg); }
    else { const name = PAGES[page] ?? 'home'; const mod = await import(`./pages/${name}.js`); document.title = (mod.title ? mod.title + ' · ' : '') + 'THERMA-X100'; current = await mod.render(main, arg); }
  } catch (e) { console.error(e); main.append(h('div', { class: 'callout fail' }, 'Could not open this page: ', String(e.message || e))); }
  main.focus({ preventScroll: true });
  updateArrows();
}
window.addEventListener('hashchange', route);
// back / forward arrows (track depth so the buttons can show availability)
let depth = +(sessionStorage.getItem('tx.depth') || 0), maxDepth = +(sessionStorage.getItem('tx.max') || 0);
const navState = () => history.state?.d ?? 0;
window.addEventListener('hashchange', () => { if (history.state?.d === undefined) { depth++; maxDepth = depth; history.replaceState({ d: depth }, ''); } else depth = history.state.d; sessionStorage.setItem('tx.depth', depth); sessionStorage.setItem('tx.max', maxDepth); updateArrows(); });
if (history.state?.d === undefined) history.replaceState({ d: depth }, '');
function updateArrows() { $('#navBack').disabled = navState() <= 0 && location.hash.replace(/^#\/?/, '') === ''; $('#navFwd').disabled = navState() >= maxDepth; }
$('#navBack').onclick = () => { if (navState() > 0) history.back(); else location.hash = '#/'; };
$('#navFwd').onclick = () => history.forward();
window.addEventListener('keydown', (e) => { if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); history.back(); } if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); history.forward(); } });

// ---------- site picker ----------
function siteLabel() { const s = store.project.site; $('#siteName').textContent = s.name || `${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}`; }
siteLabel();
$('#siteBtn').onclick = () => openSitePicker();
export function openSitePicker() {
  const s = store.project.site, results = h('div', { class: 'site-results' });
  const lat = h('input', { type: 'number', step: 'any', value: s.lat, class: 'search', style: 'max-width:160px' }), lon = h('input', { type: 'number', step: 'any', value: s.lon, class: 'search', style: 'max-width:160px' });
  const q = h('input', { type: 'search', class: 'search', placeholder: 'Search any city, town or place worldwide…', onkeydown: (e) => { if (e.key === 'Enter') search(); } });
  const choose = (o) => { store.setSite({ lat: +o.lat, lon: +o.lon, name: o.name, elevation: o.elevation ?? null }); toast(`Site set to ${o.name}`, 'ok'); m.close(); if (/s0[67]|s22|datahub/.test(location.hash)) route(); };
  async function search() { results.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div>Searching…</div>'; try { const r = await geocode(q.value); results.innerHTML = ''; for (const g of r.data.results || []) results.append(h('button', { class: 'chip', onclick: () => choose({ lat: g.latitude, lon: g.longitude, name: `${g.name}, ${g.admin1 ? g.admin1 + ', ' : ''}${g.country}`, elevation: g.elevation }) }, `${g.name} · ${g.admin1 || ''} ${g.country_code || ''} (${g.latitude.toFixed(2)}, ${g.longitude.toFixed(2)})`)); if (!results.children.length) results.textContent = 'No matches.'; } catch (e) { results.textContent = 'Search unavailable: ' + e.message; } }
  const gps = () => { if (!navigator.geolocation) return toast('Geolocation unsupported on this device', 'fail'); navigator.geolocation.getCurrentPosition(async (pos) => { let name = `GPS ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`; try { const r = await reverseGeocode(pos.coords.latitude, pos.coords.longitude); name = r.data.display_name?.split(',').slice(0, 3).join(',') || name; } catch { /* keep coordinate name */ } choose({ lat: pos.coords.latitude, lon: pos.coords.longitude, name, elevation: pos.coords.altitude }); }, (err) => toast('Location denied: ' + err.message, 'fail'), { enableHighAccuracy: true, timeout: 15000 }); };
  const m = modal('Project site — any location on Earth', h('div', {}, h('p', { class: 'muted' }, 'The installation site drives live ambient and wet-bulb temperature (cold sink), solar and climatology (solar-thermal source), grid carbon, inflation, interest rates and currency for every suite.'), h('div', { class: 'row gap wrap' }, q, h('button', { class: 'btn primary', onclick: search }, 'Search'), h('button', { class: 'btn', onclick: gps }, '◎ Use my location')), results, h('h4', {}, 'Or enter WGS84 coordinates'), h('div', { class: 'row gap wrap' }, h('label', {}, 'Lat ', lat), h('label', {}, 'Lon ', lon), h('button', { class: 'btn', onclick: () => choose({ lat: +lat.value, lon: +lon.value, name: `${(+lat.value).toFixed(4)}, ${(+lon.value).toFixed(4)}` }) }, 'Use coordinates'))));
  setTimeout(() => q.focus(), 50);
}

// ---------- connectivity ----------
const net = () => { const on = navigator.onLine; $('#netState').classList.toggle('off', !on); $('#netState').title = on ? 'Online — live data enabled' : 'Offline — cached data and full local computation available'; };
window.addEventListener('online', () => { net(); toast('Back online — live data refreshing', 'ok'); }); window.addEventListener('offline', () => { net(); toast('Offline: all solvers keep working with cached data', 'info'); }); net();
onStatus((id, s) => { if (!s.ok) $('#netState').title = `Last data error (${id}): ${s.error}`; });

// ---------- install (PWA) ----------
let deferred = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('Installed — THERMA-X100 now runs offline from your home screen', 'ok', 6000); });
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (!standalone) $('#installBtn').hidden = false;
$('#installBtn').onclick = async () => { if (deferred) { deferred.prompt(); const r = await deferred.userChoice; deferred = null; if (r.outcome === 'accepted') $('#installBtn').hidden = true; } else location.hash = '#/install'; };
export const installPrompt = () => deferred;

// ---------- service worker (offline, background refresh) ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(async (reg) => {
    if (!reg) return;
    const offer = (w) => showUpdatePopup(() => w.postMessage('skipWaiting'));
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); }); });
    try { if ('periodicSync' in reg) { const st = await navigator.permissions.query({ name: 'periodic-background-sync' }); if (st.state === 'granted') await reg.periodicSync.register('tx-refresh', { minInterval: 6 * 3600e3 }); } } catch { /* optional capability */ }
    setInterval(() => reg.update().catch(() => { }), 3600e3);
  }).catch(e => console.warn('SW registration failed', e));
  let reloaded = false; navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}
// persistent storage so cached datasets survive storage pressure
navigator.storage?.persist?.().catch(() => { });

// ---------- update & what's-new pop-ups ----------
async function showUpdatePopup(apply) {
  if (document.querySelector('.update-pop')) return;
  const { CHANGELOG } = await import('./changelog.js').catch(() => ({ CHANGELOG: [] }));
  const latest = CHANGELOG[0];
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'modal-wrap update-wrap' }, h('div', { class: 'update-pop', role: 'dialog', 'aria-label': 'Update available' },
    h('div', { class: 'up-head' }, h('div', { class: 'up-icon' }, '⬆'), h('div', {}, h('div', { class: 'up-kicker' }, 'Update available'), h('h3', {}, 'A new version of THERMA-X100 is ready'))),
    h('div', { class: 'up-body' }, h('p', { class: 'muted' }, 'Your projects, results and imported data are kept. The update installs in about a second and works offline afterwards.'),
      latest ? h('div', {}, h('div', { class: 'up-sub' }, 'Highlights'), h('ul', { class: 'up-list' }, ...latest.items.slice(0, 4).map(i => h('li', {}, i)))) : null),
    h('div', { class: 'up-foot' }, h('button', { class: 'btn', onclick: close }, 'Later'), h('button', { class: 'btn primary', onclick: () => { close(); apply(); } }, 'Update now'))));
  document.body.append(wrap);
}
async function showWhatsNew() {
  try {
    const { CHANGELOG, LATEST } = await import('./changelog.js');
    const seen = +(localStorage.getItem('tx.seenRelease') || 0);
    let seen0 = seen; if (!seen0) { if (!localStorage.getItem('therma.project.v1')) { localStorage.setItem('tx.seenRelease', LATEST); return; } seen0 = LATEST - 1; } // first-ever visit: no pop-up; earlier visitors see the latest release
    if (seen0 >= LATEST) return;
    const items = CHANGELOG.filter(c => c.id > seen0);
    const close = () => { localStorage.setItem('tx.seenRelease', LATEST); wrap.remove(); };
    const wrap = h('div', { class: 'modal-wrap update-wrap', onclick: (e) => { if (e.target === wrap) close(); } }, h('div', { class: 'update-pop', role: 'dialog', 'aria-label': 'What is new' },
      h('div', { class: 'up-head' }, h('div', { class: 'up-icon ok' }, '✓'), h('div', {}, h('div', { class: 'up-kicker' }, 'Updated successfully'), h('h3', {}, 'What’s new in THERMA-X100'))),
      h('div', { class: 'up-body' }, ...items.map(c => h('div', { class: 'up-rel' }, h('div', { class: 'up-sub' }, `${c.title} · ${c.date}`), h('ul', { class: 'up-list' }, ...c.items.map(i => h('li', {}, i)))))),
      h('div', { class: 'up-foot' }, h('button', { class: 'btn primary', onclick: close }, 'Got it'))));
    document.body.append(wrap);
  } catch { /* changelog unavailable */ }
}
setTimeout(showWhatsNew, 1200);
window.txPreviewUpdate = () => showUpdatePopup(() => location.reload());
route();
void reverseGeocode;
