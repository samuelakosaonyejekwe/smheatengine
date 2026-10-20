// Universal input-data portal: supply case data in common formats; each dataset is previewed, unit-checked, mapped to
// physical quantities, classified (DSC, tensile, force–stroke, sensor log, flow/pressure, dynamometer, cost) and routed
// to the suite(s) that consume it, with provenance "measured" or "imported". Everything stays on the device.
import { h, section, callout, table, toast } from '../core/ui.js';
import { parseFile, parseDelimited, ACCEPT, IMPORT_FORMATS, autoMap } from '../core/io.js';
import { store } from '../core/state.js';
import { SUITES } from '../suites/index.js';
import { fmt } from '../core/num.js';
export const title = 'Data portal';

// dataset classification → target suites
function classify(map, header) {
  const has = (k) => !!map[k], hdr = header.join(' ').toLowerCase();
  if (has('heatflow') && has('temperature')) return { type: 'DSC thermogram', targets: ['s03', 's04'] };
  if (has('stress') && has('strain')) return { type: 'Tensile / thermomechanical loop', targets: ['s03', 's04', 's05'] };
  if (has('force') && has('displacement')) return { type: 'Force–stroke actuator test', targets: ['s05', 's19'] };
  if (has('torque') && has('speed')) return { type: 'Dynamometer / shaft test', targets: ['s11', 's18', 's19'] };
  if (has('flow') && has('pressure')) return { type: 'Hydraulic flow / pressure test', targets: ['s13', 's08'] };
  if (has('flow') && has('temperature')) return { type: 'Calorimetric thermal test', targets: ['s18', 's19', 's08'] };
  if (/cost|price|usd|eur|quote/.test(hdr)) return { type: 'Cost / quotation data', targets: ['s22', 's20'] };
  if (/cycles|life|fracture|n_f/.test(hdr)) return { type: 'Fatigue / endurance data', targets: ['s16'] };
  if (has('temperature') && has('time')) return { type: 'Temperature log', targets: ['s19', 's08'] };
  return { type: 'Generic table', targets: ['s19'] };
}

export async function render(root) {
  store.project.imports ||= {};
  root.append(h('h1', {}, 'Input data portal'), h('p', { class: 'muted', style: 'max-width:980px' }, 'Supply case data in any accepted format — laboratory measurements (DSC, tensile, force–stroke, temperatures, flows, pressures, torque, speed, power), supplier datasheets, cost quotations, CAD/mesh geometry, or a complete project file. Each dataset is previewed, its columns are recognised and unit-checked, and it is routed to the suites that use it for calibration (Suites 03, 05, 19) or validation. Measured data are kept separate from model predictions and are never altered.'));
  root.append(section('Accepted formats', table(['Format family', 'Extensions'], IMPORT_FORMATS.map(f => [f.label, f.ext.map(e => '.' + e).join('  ')])), h('p', { class: 'small muted' }, 'HDF5, Parquet and instrument-native binaries: export them to CSV/XLSX from the acquisition software (column names with units in brackets, e.g. "force [N]", are recognised).')));
  const drop = h('label', { class: 'drop' }, h('input', { type: 'file', accept: ACCEPT, multiple: true, onchange: (e) => handle([...e.target.files]) }), h('div', {}, h('div', { style: 'font-size:28px' }, '⇪'), 'Drop files here or tap to choose (multiple allowed)'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); }); drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle([...e.dataTransfer.files]); });
  const paste = h('textarea', { rows: 6, class: 'search', style: 'max-width:100%;width:100%;font-family:var(--mono)', placeholder: 'Or paste delimited data (first row = column names), e.g.\ntime [s],T_ribbon [°C],force [N],stroke [mm]' });
  const url = h('input', { type: 'url', class: 'search', placeholder: 'Or fetch a public CSV/JSON dataset by URL (must allow cross-origin access)' });
  const out = h('div');
  root.append(section('Upload, paste or fetch', drop, paste, h('div', { class: 'row gap wrap' }, h('button', { class: 'btn', onclick: () => { try { const r = parseDelimited(paste.value); show({ kind: 'table', name: 'pasted-data.csv', ...r }); } catch (e) { toast(e.message, 'fail'); } } }, 'Parse pasted data'), url, h('button', { class: 'btn', onclick: async () => { try { const r = await fetch(url.value); if (!r.ok) throw new Error('HTTP ' + r.status); const name = url.value.split('/').pop() || 'remote.csv'; const blob = await r.blob(); show(await parseFile(new File([blob], name))); } catch (e) { toast('Fetch failed: ' + e.message, 'fail', 6000); } } }, 'Fetch'))), out);
  current(root);

  async function handle(files) { for (const f of files) { try { show(await parseFile(f)); } catch (e) { out.prepend(callout('fail', `${f.name}: ${e.message}`)); } } }
  function show(r) {
    const card = section(`${r.name} — ${r.kind}`);
    if (r.kind === 'table' || (r.kind === 'json' && r.columns) || (r.kind === 'sheet' && r.columns)) {
      const map = autoMap(r.header), cls = classify(map, r.header);
      const nanCols = r.header.filter(c => r.columns[c].some(v => v === null || v === '' || Number.isNaN(v)));
      card.append(h('p', { class: 'small muted' }, `${r.nRows} rows × ${r.header.length} columns. Recognised as: `, h('b', {}, cls.type), `. Detected quantities: ${Object.entries(map).map(([q, c]) => `${q} ← “${c}”`).join(', ') || 'none (choose targets manually)'}. Units from headers: ${Object.entries(r.units || {}).map(([c, u]) => `${c} [${u}]`).join(', ') || 'none found — SI assumed'}.`));
      if (nanCols.length) card.append(callout('warn', `Missing or non-numeric values flagged in: ${nanCols.join(', ')}. They are kept as gaps (never interpolated silently).`));
      card.append(table(r.header, Array.from({ length: Math.min(12, r.nRows) }, (_, i) => r.header.map(c => r.columns[c][i]))));
      card.append(h('h4', {}, 'Route to suites'), attach(r, cls.targets, map));
    } else if (r.kind === 'mesh') {
      card.append(h('p', {}, `${r.format}: ${r.triangles} triangles${r.nodes ? ', ' + r.nodes + ' nodes' : ''}.`), h('button', { class: 'btn primary', onclick: () => { store.project.imports.geometry = { name: r.name, positions: r.positions, triangles: r.triangles, format: r.format }; store.invalidate('s02', 'geometry imported'); store.touch(); toast('Geometry available in Suite 02 (reference geometry, session)', 'ok'); } }, 'Use as reference geometry in Suite 02'));
    } else if (r.kind === 'project') {
      card.append(h('p', {}, `THERMA-X100 project “${r.data.name}” revision ${r.data.revision}.`), h('button', { class: 'btn primary', onclick: () => { store.replace(r.data); toast('Project loaded', 'ok'); location.hash = '#/project'; } }, 'Open this project (replaces current)'));
    } else if (r.sheets?.length) {
      card.append(h('p', {}, `Workbook with ${r.sheets.length} sheet(s): ${r.sheets.map(s => s.name).join(', ')}.`));
      for (const sh of r.sheets.filter(s => s.columns)) { const map = autoMap(sh.header), cls = classify(map, sh.header); card.append(h('h4', {}, `Sheet “${sh.name}” — ${cls.type}`), attach({ ...sh, name: `${r.name} / ${sh.name}`, kind: 'table' }, cls.targets, map)); }
    } else card.append(h('pre', { class: 'small', style: 'max-height:240px;overflow:auto' }, JSON.stringify(r.data ?? r, null, 2).slice(0, 4000)), attach(r, ['s19'], {}));
    out.prepend(card);
  }
  function attach(r, targets, map) {
    const boxes = SUITES.map(x => h('label', { class: 'chip' }, h('input', { type: 'checkbox', value: x.id, checked: targets.includes(x.id) }), ` ${String(x.num).padStart(2, '0')} ${x.short}`));
    const use = h('select', {}, h('option', {}, 'calibration'), h('option', {}, 'validation'));
    const prov = h('select', {}, h('option', { value: 'measured' }, 'measured (calibrated instruments)'), h('option', { value: 'certified' }, 'certified (supplier / accredited lab)'), h('option', { value: 'imported' }, 'imported (external dataset)'));
    return h('div', {}, h('div', { class: 'row gap wrap' }, ...boxes), h('div', { class: 'row gap wrap', style: 'margin-top:8px' }, h('label', { class: 'small' }, 'Use ', use), h('label', { class: 'small' }, 'Evidence class ', prov), h('button', { class: 'btn primary', onclick: () => { const ids = boxes.map(b => b.querySelector('input')).filter(i => i.checked).map(i => i.value); if (!ids.length) return toast('Choose at least one suite', 'fail'); for (const id of ids) { (store.project.experiments[id] ||= []).push({ name: r.name, kind: r.kind, use: use.value, prov: prov.value, t: new Date().toISOString(), columns: r.columns, header: r.header, nRows: r.nRows, map: r.header ? autoMap(r.header) : map }); store.invalidate(id, 'experimental data imported'); } store.touch(); toast(`Routed to ${ids.join(', ')} (${use.value}, ${prov.value})`, 'ok'); } }, 'Route dataset')));
  }
}
function current(root) {
  const im = store.project.imports || {}, ex = store.project.experiments || {};
  const rows = [];
  if (im.geometry) rows.push(['Reference geometry', im.geometry.name, (im.geometry.triangles ?? '') + ' triangles', 'Suite 02']);
  for (const [sid, list] of Object.entries(ex)) for (const d of list) rows.push([`Dataset (${d.use}, ${d.prov || 'imported'})`, d.name, (d.nRows ?? '') + ' rows', sid]);
  if (rows.length) root.append(section('Data currently loaded in this project', table(['Type', 'Name', 'Size', 'Used by'], rows)));
  void fmt;
}
