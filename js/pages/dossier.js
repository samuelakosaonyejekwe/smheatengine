// Engineering & experimental dossier: auto-generated, always in step with the current inputs and supplied data.
import { h, section, callout, toast, progressBar, modal } from '../core/ui.js';
import { chart, download } from '../core/chart.js';
import { store } from '../core/state.js';
import { zip } from '../core/io.js';
export const title = 'Engineering dossier';

const DOC_CSS = `body{font:13px/1.5 Arial,Helvetica,sans-serif;color:#111;background:#fff;margin:0}main{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;border-bottom:2px solid #ea580c;padding-bottom:4px;margin:28px 0 10px;page-break-after:avoid}h3{font-size:15px;margin:16px 0 6px}
.dz-table{border-collapse:collapse;width:100%;margin:6px 0 12px;font-size:12px}.dz-table th,.dz-table td{border:1px solid #cbd5e1;padding:4px 6px;text-align:left;vertical-align:top}.dz-table th{background:#f1f5f9}
.dz-figure{margin:10px 0;border:1px solid #e2e8f0;padding:6px;page-break-inside:avoid}.dz-figure svg{width:100%;height:auto;display:block}.dz-cap{font-size:11.5px;color:#475569;margin-top:4px}
.dz-sheet{page-break-before:always;margin:10px 0}.dz-sheet svg{width:100%;height:auto;border:1px solid #94a3b8;background:#fff}.dz-sheet .cap{font-size:11px;color:#475569}
.dz-chart svg{width:100%;height:auto}.badge{padding:1px 6px;border-radius:8px;font-size:11px;border:1px solid #94a3b8}.badge.ok{background:#dcfce7}.badge.warn{background:#fef3c7}.badge.fail{background:#fee2e2}
.prov{font-size:11px;font-weight:600}.muted{color:#64748b}.cover{border:2px solid #111;padding:40px;margin-bottom:24px}.toc li{margin:2px 0}
@media print{main{padding:0}h2{page-break-before:auto}.dz-sheet{page-break-before:always}@page{size:A4;margin:12mm}}`;

let current = null;
export async function render(root, arg) {
  const head = h('div', { class: 'row gap wrap', style: 'justify-content:space-between;align-items:flex-end' },
    h('div', {}, h('div', { class: 'suite-group' }, 'Auto-generated engineering & experimental documentation'), h('h1', {}, 'THERMA-X100 dossier')));
  const status = h('div', { class: 'small muted' }), prog = progressBar();
  const btn = (label, fn, cls = 'btn') => h('button', { class: cls, onclick: fn }, label);
  const tools = h('div', { class: 'row gap wrap' },
    btn('↻ Regenerate now', () => build(), 'btn primary'), btn('▶ Run all suites and refresh', () => runAll()), btn('🖨 Print / save PDF', () => printDoc()), btn('⇩ HTML document', () => saveHTML()), btn('⇩ Full package (ZIP)', () => savePackage()));
  root.append(head, callout('info', h('b', {}, 'Always current. '), 'The dossier is rebuilt automatically from the current design, materials, suite inputs, laboratory records and every dataset you supply (Data portal, suite import modes, Laboratory). It contains the experimental set-up, materials, methodology, all test conditions, dimensioned part, sub-assembly and general-arrangement drawings in third-angle projection with isometric and exploded views, the principle of operation, analysis results and revision history. Model predictions are labelled as such and never presented as measurements.'), tools, prog, status);
  const layout = h('div', { class: 'dz-layout', style: 'display:grid;grid-template-columns:minmax(0,220px) minmax(0,1fr);gap:16px;margin-top:12px' });
  const toc = h('nav', { class: 'card dz-toc', style: 'position:sticky;top:70px;align-self:start;max-height:80vh;overflow:auto;padding:10px' }), body = h('div', { class: 'dz-body' });
  layout.append(toc, body); root.append(layout);
  if (matchMedia('(max-width: 860px)').matches) layout.style.gridTemplateColumns = '1fr';
  const off = store.subscribe((e) => { if (e.type === 'dossier' && document.body.contains(root)) { status.textContent = `Inputs changed (${e.trigger}) — regenerating…`; clearTimeout(rt); rt = setTimeout(() => build(), 600); } });
  let rt = null;
  await build();
  if (arg) setTimeout(() => document.getElementById(arg.startsWith('data-') ? 'ds-' + arg.slice(5) : 'dz-' + arg)?.scrollIntoView({ behavior: 'smooth' }), 200);
  return { dispose: () => { off(); clearTimeout(rt); } };

  async function build() {
    prog.set(0.05, 'collecting inputs'); status.textContent = 'Generating dossier…';
    const { buildDossier } = await import('../core/dossier.js');
    let n = 0;
    try { current = await buildDossier({ onStep: (m) => { prog.set(Math.min(0.95, 0.08 + (++n) * 0.035), m); status.textContent = 'Generating: ' + m; } }); }
    catch (e) { console.error(e); body.innerHTML = ''; body.append(callout('fail', 'Dossier generation failed: ' + e.message)); prog.set(0, 'error'); return; }
    body.innerHTML = ''; toc.innerHTML = '';
    toc.append(h('div', { class: 'small muted', style: 'margin-bottom:6px' }, `Revision ${current.rev} · ${new Date(current.generated).toLocaleString()}`));
    current.sections.forEach((s, i) => {
      toc.append(h('a', { href: `#/dossier/${s.id}`, onclick: (ev) => { ev.preventDefault(); document.getElementById('dz-' + s.id)?.scrollIntoView({ behavior: 'smooth' }); }, style: 'display:block;padding:3px 0' }, `${i + 1}. ${s.title}`));
      const sec = h('section', { class: 'card dz-sec', id: 'dz-' + s.id, style: 'margin-bottom:14px;overflow-x:auto' }, h('h2', { class: 'card-title' }, `${i + 1}. ${s.title}`), h('div', { class: 'dz-html', html: s.html }));
      body.append(sec);
    });
    for (const c of current.charts) { const el = body.querySelector(`[data-chart="${c.id}"]`); if (el) try { chart(el, c.spec); } catch { /* chart optional */ } }
    const host = body.querySelector('.dz-sheets');
    if (host) {
      host.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-top:10px';
      for (const sh of current.sheets) host.append(sheetCard(sh));
      toc.append(h('div', { class: 'small muted', style: 'margin-top:8px' }, 'Drawings'), ...current.sheets.map(sh => h('a', { href: '#', style: 'display:block;padding:2px 0;font-size:12px', onclick: (ev) => { ev.preventDefault(); openSheet(sh); } }, `${sh.id} ${sh.title.split('(')[0]}`)));
    }
    prog.set(1, 'done'); status.textContent = `Dossier ${current.rev} generated ${new Date(current.generated).toLocaleTimeString()} · inputs fingerprint ${current.sig.hash} · ${current.sheets.length} drawing sheets · ${current.sig.datasets} supplied dataset(s).`;
  }
}

function sheetCard(sh) {
  const thumb = h('div', { html: sh.svg, style: 'background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;cursor:zoom-in' });
  thumb.querySelector('svg')?.setAttribute('width', '100%'); thumb.querySelector('svg')?.removeAttribute('height');
  thumb.onclick = () => openSheet(sh);
  return h('div', { class: 'card', style: 'padding:8px' }, thumb, h('div', { class: 'small', style: 'margin-top:6px' }, h('b', {}, sh.id), ' — ', sh.title), h('div', { class: 'row gap wrap', style: 'margin-top:4px' }, h('button', { class: 'btn sm', onclick: () => openSheet(sh) }, '⤢ Open'), h('button', { class: 'btn sm', onclick: () => download(new Blob([sh.svg], { type: 'image/svg+xml' }), `${sh.id}.svg`) }, 'SVG'), h('button', { class: 'btn sm', onclick: () => sheetPNG(sh) }, 'PNG'), sh.dxf ? h('button', { class: 'btn sm', onclick: () => download(new Blob([sh.dxf], { type: 'application/dxf' }), `${sh.id}.dxf`) }, 'DXF') : null));
}
function openSheet(sh) {
  let z = 1; const wrap = h('div', { style: 'overflow:auto;max-height:78vh;background:#e5e7eb;border-radius:8px' }), inner = h('div', { html: sh.svg, style: 'transform-origin:0 0;background:#fff' });
  wrap.append(inner); const svg = inner.querySelector('svg'); svg.setAttribute('width', '100%'); svg.removeAttribute('height');
  const setZ = (v) => { z = Math.max(0.5, Math.min(6, v)); inner.style.width = `${z * 100}%`; };
  wrap.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZ(z * (e.deltaY < 0 ? 1.15 : 0.87)); } }, { passive: false });
  modal(`${sh.id} — ${sh.title}`, h('div', {}, h('div', { class: 'row gap wrap', style: 'margin-bottom:6px' }, h('button', { class: 'btn sm', onclick: () => setZ(z * 1.25) }, '＋ Zoom'), h('button', { class: 'btn sm', onclick: () => setZ(z / 1.25) }, '－'), h('button', { class: 'btn sm', onclick: () => setZ(1) }, 'Fit'), h('button', { class: 'btn sm', onclick: () => download(new Blob([sh.svg], { type: 'image/svg+xml' }), `${sh.id}.svg`) }, 'SVG'), h('button', { class: 'btn sm', onclick: () => sheetPNG(sh) }, 'PNG (300 dpi)'), sh.dxf ? h('button', { class: 'btn sm', onclick: () => download(new Blob([sh.dxf], { type: 'application/dxf' }), `${sh.id}.dxf`) }, 'DXF') : null, h('span', { class: 'small muted' }, 'Ctrl + wheel to zoom')), wrap));
}
async function sheetPNG(sh, dpi = 300) {
  const W = Math.round(420 / 25.4 * dpi), H = Math.round(297 / 25.4 * dpi), img = new Image();
  const url = URL.createObjectURL(new Blob([sh.svg.replace('width="420mm" height="297mm"', `width="${W}" height="${H}"`)], { type: 'image/svg+xml' }));
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(img, 0, 0, W, H); URL.revokeObjectURL(url);
  cv.toBlob(b => download(b, `${sh.id}.png`), 'image/png');
}
function docHTML() {
  if (!current) return '';
  const body = document.querySelector('.dz-body'); const secs = [...(body?.querySelectorAll('.dz-sec') || [])].map(s => { const c = s.cloneNode(true); c.querySelectorAll('.chart-tools, button, .chart-toolbar, .chart-actions').forEach(x => x.remove()); c.querySelector('.dz-sheets')?.remove(); return c.innerHTML; });
  const pr = store.project, sheets = current.sheets.map(sh => `<div class="dz-sheet">${sh.svg}<div class="cap">${sh.id} — ${sh.title}</div></div>`).join('');
  const toc = current.sections.map((s, i) => `<li>${i + 1}. ${s.title}</li>`).join('') + `<li>${current.sections.length + 1}. Drawing sheets (${current.sheets.length})</li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>THERMA-X100 dossier ${current.rev}</title><style>${DOC_CSS}</style></head><body><main><div class="cover"><h1>THERMA-X100</h1><div style="font-size:18px">Engineering &amp; experimental dossier</div><p>${pr.name} · project ${pr.id} · dossier revision ${current.rev}<br>Generated ${new Date(current.generated).toLocaleString()} · inputs fingerprint ${current.sig.hash}</p><p class="muted">Model predictions are not validated test evidence unless marked “measured”.</p></div><h2>Contents</h2><ol class="toc">${toc}</ol>${secs.map(s => `<section>${s}</section>`).join('')}<h2>${current.sections.length + 1}. Drawing sheets</h2>${sheets}</main></body></html>`;
}
function printDoc() { const html = docHTML(); if (!html) return; const w = window.open('', '_blank'); if (!w) { toast('Allow pop-ups to print, or download the HTML document', 'warn'); return; } w.document.open(); w.document.write(html); w.document.close(); setTimeout(() => { w.focus(); w.print(); }, 700); }
function saveHTML() { const html = docHTML(); if (html) download(new Blob([html], { type: 'text/html' }), `THERMA-X100-dossier-${current.rev}.html`); }
async function savePackage() {
  if (!current) return; const files = [{ name: 'dossier.html', data: docHTML() }];
  for (const sh of current.sheets) { files.push({ name: `drawings/${sh.id}.svg`, data: sh.svg }); if (sh.dxf) files.push({ name: `drawings/${sh.id}.dxf`, data: sh.dxf }); }
  if (current.bom) files.push({ name: 'bill_of_materials.csv', data: ['part_no,description,material,qty,unit_mass_kg,total_mass_kg', ...current.bom.map(b => [b.no, `"${b.name}"`, `"${b.material}"`, b.qty, b.mass.toFixed(6), (b.mass * b.qty).toFixed(6)].join(','))].join('\n') });
  files.push({ name: 'engine_design.json', data: JSON.stringify(store.project.engine, null, 2) }, { name: 'manifest.json', data: JSON.stringify({ document: 'THERMA-X100 dossier', revision: current.rev, generated: current.generated, inputs: current.sig, sheets: current.sheets.map(s => ({ id: s.id, title: s.title })) }, null, 2) });
  download(await zip(files), `THERMA-X100-dossier-${current.rev}.zip`); toast('Dossier package downloaded', 'ok');
}
async function runAll() {
  const { runChain, FEASIBILITY_CHAIN } = await import('../core/pipeline.js');
  toast('Running all 22 suites — the dossier refreshes when they finish', 'info', 5000);
  await runChain(FEASIBILITY_CHAIN, {}, { onStep: (id, f) => { const st = document.querySelector('.dz-body')?.previousElementSibling; void st; void f; void id; } });
  store.emit({ type: 'dossier', trigger: 'all suites re-run' });
}
void section;
