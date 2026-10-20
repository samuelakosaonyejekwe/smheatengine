// Installation, offline use and self-hostable offline copy (redundancy independent of any single host).
import { h, section, table, toast, callout } from '../core/ui.js';
import { zip } from '../core/io.js';
import { download } from '../core/chart.js';
export const title = 'Install & offline';

// Mirrors of the same build. The app works from any of them; installed copies keep working if all are down.
export const MIRRORS = [
  { name: 'Primary host', url: 'https://samuelakosaonyejekwe.github.io/smheatengine/' },
];

export async function render(root) {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  root.append(h('h1', {}, 'Install THERMA-X100 on any device'));
  root.append(callout(standalone ? 'ok' : 'info', standalone ? 'You are running the installed app. It works offline, including in airplane mode.' : 'Install once and the full software runs offline on computers, phones and tablets — all solvers run on your device.'));
  const btn = h('button', { class: 'btn primary', onclick: async () => { const { installPrompt } = await import('../app.js'); const d = installPrompt(); if (d) { d.prompt(); } else toast('Use your browser menu: “Install app” or “Add to Home Screen” (steps below).', 'info', 6000); } }, '⤓ Install now');
  root.append(section('One-tap install', btn));
  root.append(section('Step-by-step by platform', table(['Device', 'Browser', 'Steps'], [
    ['Phone / tablet', 'Any current browser with app install', 'Tap ⤓ Install app (or the browser menu ⋮ → Install app / Add to Home screen).'],
    ['Phone / tablet without an install button', 'Built-in browser', 'Tap the Share button → Add to Home Screen → Add. Open it from the home screen once while online to cache everything.'],
    ['Desktop / laptop', 'Any current browser with app install', 'Click ⤓ Install app or the install icon in the address bar.'],
    ['Desktop / laptop', 'Browsers with “Add to Dock”', 'File → Add to Dock.'],
    ['Any', 'Browsers without app install', 'Use as a website (works offline after first visit), or download the offline copy below.'],
  ])));
  root.append(section('Offline & airplane mode', h('ul', {}, h('li', {}, 'Every engineering solver, CAD generator, materials library and your project data live on the device.'), h('li', {}, 'Live weather, climatology, literature and economic data are cached on the device; the last good copies are used offline and labelled with their age.'), h('li', {}, 'Installed browsers that support periodic background sync refresh the site forecast automatically while the device is online.'))));
  const prog = h('div', { class: 'small muted' });
  root.append(section('Self-hostable offline copy (redundancy)', h('p', {}, 'Download the complete application as a ZIP. Serve the folder with any static web server or upload it to any static host — it has no server-side dependency, so the software remains available even if every public host is unavailable.'), h('button', { class: 'btn', onclick: async () => { try { prog.textContent = 'Collecting files…'; const list = await (await fetch('files.json', { cache: 'no-cache' })).json(); const files = []; let k = 0; for (const f of list.files) { const r = await fetch(f); if (r.ok) files.push({ name: 'therma/' + f, data: new Uint8Array(await r.arrayBuffer()) }); prog.textContent = `Packing ${++k}/${list.files.length}`; } for (const extra of ['sw.js', 'files.json', '.nojekyll']) { try { const r = await fetch(extra); if (r.ok) files.push({ name: 'therma/' + extra, data: new Uint8Array(await r.arrayBuffer()) }); } catch { /* optional */ } } download(await zip(files), `therma-offline-${list.version}.zip`); prog.textContent = `Done: ${files.length} files.`; } catch (e) { prog.textContent = 'Could not build the offline copy: ' + e.message; } } }, '⇩ Download offline copy (ZIP)'), prog));
  root.append(section('Mirrors', table(['Host', 'Address'], MIRRORS.map(m => [m.name, h('a', { href: m.url, target: '_blank', rel: 'noopener' }, m.url)]))));
}
