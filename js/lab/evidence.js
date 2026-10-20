// Workspace 12 — reproducibility, evidence & reporting: validation ladder V0–V6 evaluated from measured datasets only, run
// records with software version and input/data hashes, reproduction of virtual runs, printable report and evidence ZIP.
import { h, table, callout, toast, provChip } from '../core/ui.js';
import { store } from '../core/state.js';
import { zip } from '../core/io.js';
import { download } from '../core/chart.js';
import { ladderStatus, reportHTML, datasetCSV, runVirtual, addSensorNoise, getRecord, removeRecord, stableHash, labOf, calStatus, logEvent } from '../core/lab.js';
import { lab, card, btn, note, row, dsBadges, version, dl } from './common.js';

export async function render(el) {
  const L = lab();
  const ladBox = h('div'); el.append(card('Validation ladder (specification §33)', note('Each gate is evaluated from datasets with provenance “measured” only. Virtual, simulated-instrument and hybrid model columns never earn credit, whatever they predict. “Partial” means evidence exists but the pass criterion is not yet demonstrated.'), ladBox));
  function drawLad() {
    ladBox.innerHTML = ''; const st = ladderStatus(labOf(store));
    ladBox.append(h('div', { class: 'ladder' }, ...st.map(g => h('span', { class: g.status === 'pass' ? 'on' : '', title: g.detail }, `${g.gate} · ${g.status}`))),
      table(['Gate', 'Hardware / evidence', 'Pass criterion', 'Status', 'Evidence / what is needed'], st.map(g => [g.gate, g.title, g.pass, h('span', { class: `badge ${g.status === 'pass' ? 'ok' : g.status === 'partial' ? 'warn' : ''}` }, g.status), g.detail])));
    const first = st.find(g => g.status !== 'pass'); if (first) ladBox.append(callout('info', h('b', {}, `Next gate: ${first.gate}. `), first.detail));
  }
  drawLad();
  // run records & reproduction
  const runBox = h('div'); el.append(card('Run records', note('Every saved dataset gets a run record: software version, protocol id/version/hash, specimen, instruments with their calibration status at the time, an inputs hash and a data hash. Virtual runs can be re-executed from their stored inputs and must reproduce the same data hash.'), runBox));
  function drawRuns() {
    runBox.innerHTML = ''; if (!L.runs.length) { runBox.append(note('No run records yet.')); return; }
    runBox.append(table(['Run', 'Dataset', 'Kind', 'Provenance', 'Protocol', 'Software', 'Inputs hash', 'Data hash', 'Instruments', ''], L.runs.slice().reverse().map(r => [r.id, r.datasetId || '—', r.kind || '—', r.provenance ? provChip(r.provenance) : '—', r.protocolId ? `${r.protocolId} v${r.protocolVersion}` : '—', r.software?.version || '—', r.inputsHash, r.dataHash || '—', (r.instrumentCal || []).map(i => `${i.id}:${i.status}`).join(', ') || '—',
      r.kind === 'virtual' ? btn('↻ Reproduce', () => reproduce(r), 'sm') : ''])));
  }
  function reproduce(r) {
    const ds = getRecord(store, 'datasets', r.datasetId); if (!ds?.meta?.inputs) return toast('Dataset or stored inputs missing.', 'fail');
    const { test, design, alloy, fidelity } = ds.meta.inputs; // design already carries the protocol conditions (incl. recordCycles)
    let again; try { again = runVirtual({ test, candidate: alloy, conditions: design }, { design, fidelity }); } catch (e) { return toast('Re-run failed: ' + e.message, 'fail'); }
    if (ds.meta.noise) { const { seed, note: _n, ...sd } = ds.meta.noise; addSensorNoise(again, sd, seed); }
    report();
    function report() { const same = again.meta.dataHash === ds.meta.dataHash, inSame = again.meta.inputsHash === ds.meta.inputsHash; logEvent(store, 'reproduce', `${ds.id}: inputs ${inSame ? 'match' : 'differ'}, data ${same ? 'identical' : 'differ'}`); toast(same ? `Reproduced ${ds.id}: identical data hash ${ds.meta.dataHash}` : `Re-run of ${ds.id} differs (inputs ${inSame ? 'match' : 'differ'}; model or software version changed since ${ds.meta.version || 'the original run'})`, same ? 'ok' : 'warn', 9000); }
  }
  drawRuns();
  // dataset register
  const dsBox = h('div'); el.append(card('Dataset register', dsBox));
  function drawDs() {
    dsBox.innerHTML = ''; if (!L.datasets.length) { dsBox.append(note('No datasets.')); return; }
    dsBox.append(table(['ID', 'Name', 'Kind / provenance', 'Rows', 'Created', 'Data hash', 'Integrity', ''], L.datasets.map(d => { const ok = !d.meta?.dataHash || stableHash(d.columns) === d.meta.dataHash; return [d.id, d.name, dsBadges(d), d.nRows, new Date(d.created).toLocaleString(), d.meta?.dataHash || '—', h('span', { class: `badge ${ok ? 'ok' : 'fail'}` }, ok ? 'unchanged' : 'MODIFIED'), h('div', { class: 'row gap' }, btn('CSV', () => dl(datasetCSV(d), `${d.id}.csv`, 'text/csv'), 'sm'), btn('✕', () => { if (confirm(`Delete ${d.id}${d.provenance === 'measured' ? ' — a MEASURED dataset (original record)' : ''}?`)) { removeRecord(store, 'datasets', d.id); drawDs(); drawLad(); } }, 'sm'))]; })),
      note('Integrity re-hashes the stored columns: “MODIFIED” means the data changed after recording (or were trimmed by storage limits) and should not be used as evidence.'));
  }
  drawDs();
  // report & evidence package
  el.append(card('Report & evidence package', note('The printable report lists the ladder, hypotheses, protocols with hashes, specimens, instruments with calibration status, datasets with provenance and hashes, run records and calibrated parameters. The evidence ZIP adds every dataset as CSV, the protocols and records as JSON and a manifest of hashes.'),
    row(btn('🖨 Print / save as PDF', () => printReport(), 'primary'), btn('⇩ Report (HTML)', () => dl(reportHTML(store, { version: version() }), 'therma-lab-report.html', 'text/html')), btn('🗜 Evidence ZIP', () => evidenceZip())),
    h('h4', {}, 'Event log (latest 150)'), L.events.length ? table(['Time', 'Type', 'Message'], L.events.slice(-150).reverse().map(e => [new Date(e.t).toLocaleString(), e.type, e.msg])) : note('No events.')));
  function printReport() {
    const html = reportHTML(store, { version: version() }), fr = h('iframe', { style: 'position:fixed;right:0;bottom:0;width:0;height:0;border:0', title: 'report' }); document.body.append(fr);
    const doc = fr.contentDocument; doc.open(); doc.write(html); doc.close();
    setTimeout(() => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch { const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); w.print(); } } setTimeout(() => fr.remove(), 4000); }, 300);
  }
  async function evidenceZip() {
    const files = [], manifest = { project: store.project.id, name: store.project.name, software: version(), t: new Date().toISOString(), files: [] };
    const add = (name, data) => { files.push({ name, data }); manifest.files.push({ name, hash: stableHash(data) }); };
    add('report.html', reportHTML(store, { version: version() }));
    for (const d of L.datasets) add(`datasets/${d.id}.csv`, datasetCSV(d));
    for (const p of L.protocols) add(`protocols/${p.id}-v${p.version}.json`, JSON.stringify(p, null, 2));
    add('records/hypotheses.json', JSON.stringify(L.hypotheses, null, 2)); add('records/specimens.json', JSON.stringify(L.specimens, null, 2));
    add('records/instruments.json', JSON.stringify(L.instruments.map(i => ({ ...i, calStatus: calStatus(i) })), null, 2)); add('records/runs.json', JSON.stringify(L.runs, null, 2));
    add('records/schedules.json', JSON.stringify(L.schedules, null, 2)); add('records/calibrated.json', JSON.stringify(L.calibrated, null, 2)); add('records/events.json', JSON.stringify(L.events, null, 2));
    add('records/ladder.json', JSON.stringify(ladderStatus(L), null, 2));
    files.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
    download(await zip(files), `therma-evidence-${store.project.id}.zip`); toast(`Evidence package: ${files.length} files`, 'ok');
  }
}
