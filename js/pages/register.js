// EIGDAS engineering-input register: every input of every suite with its value, unit, provenance (measured, certified,
// library, imported, calculated, generated, estimated, user …), lock state and automatic source; the dependency
// network between suites; and the list of evidence that must still be obtained experimentally (spec EIGDAS §6–7).
import { h, section, table, callout, provChip } from '../core/ui.js';
import { store, DEPENDS, PROVENANCE } from '../core/state.js';
import { SUITES } from '../suites/index.js';
import { makeCtx, resolveParams } from '../core/suite.js';
import { chart, download } from '../core/chart.js';
import { fmt } from '../core/num.js';
export const title = 'EIGDAS input register';

export async function render(root) {
  root.append(h('h1', {}, 'Engineering input register (EIGDAS)'), h('p', { class: 'muted', style: 'max-width:980px' }, 'The user supplies the engineering intention; databases, instruments, physical models, numerical solvers and preceding suites supply or generate the engineering data. This register shows, for every input of all 22 suites, where its value comes from and how reliable it is — so a theoretical calculation, a calibrated prediction and a measured value are never confused.'));
  const graphBox = h('div'); root.append(section('Suite dependency network (who supplies whom)', graphBox));
  graphBox.append(depGraph());
  const status = h('p', { class: 'small muted' }, 'Generating the automatic inputs of all 22 suites…'); root.append(status);
  const rows = [], counts = {}, need = [];
  for (const meta of SUITES) {
    let def; try { def = { ...meta, ...(await meta.load()).default }; } catch (e) { rows.push([`${meta.num}`, meta.short, '—', '', '', h('span', { class: 'badge fail' }, 'module unavailable'), '', e.message]); continue; }
    const ctx = makeCtx(def); let r; try { r = resolveParams(def, ctx, false); } catch { r = { values: {}, prov: {} }; }
    const locks = store.locks(def.id);
    for (const p of def.params || []) {
      const v = store.params(def.id)[p.key] ?? r.values[p.key], pv = store.prov(def.id)[p.key] || r.prov[p.key] || 'estimated';
      counts[pv] = (counts[pv] || 0) + 1;
      if (['estimated', 'hypothetical', 'unsupported'].includes(pv) && !p.expert) need.push([`${String(def.num).padStart(2, '0')} ${def.short}`, p.label, p.unit || '', provChip(pv)]);
      rows.push([String(def.num).padStart(2, '0'), def.short, p.group || 'General', p.label, typeof v === 'number' ? fmt(v, 5) : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v ?? ''), p.unit || '', provChip(pv), locks[p.key] ? '🔒' : (p.auto ? 'auto' : '')]);
    }
  }
  status.remove();
  const tot = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const pc = h('div'); root.append(section('Provenance of all inputs', h('p', { class: 'small muted' }, `${tot} inputs across ${SUITES.length} suites.`), pc));
  const keys = Object.keys(PROVENANCE).filter(k => counts[k]);
  chart(pc, { type: 'bar', title: 'Inputs by provenance class', categories: keys.map(k => PROVENANCE[k].label), series: [{ name: 'inputs', values: keys.map(k => counts[k]) }], y: { label: 'number of inputs' }, explain: 'How much of the current model rests on measured or certified evidence versus library, calculated, coupled or estimated values. Validated performance claims require the estimated and hypothetical classes to be replaced by measurements (import them in the Data portal or the suite’s import mode).' });
  root.append(section('Evidence still required before validated claims', need.length ? table(['Suite', 'Input', 'Unit', 'Current class'], need) : callout('ok', 'No user-facing inputs are currently estimated or hypothetical.')));
  root.append(section('Complete register', h('button', { class: 'btn sm', onclick: () => download(new Blob([['suite,name,group,input,value,unit,provenance,lock', ...rows.map(r => r.map(c => typeof c === 'object' ? (c.textContent || '') : String(c)).map(c => /[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(','))].join('\n')], { type: 'text/csv' }), 'therma-input-register.csv') }, 'Download register (CSV)'), table(['#', 'Suite', 'Group', 'Input', 'Value', 'Unit', 'Provenance', 'Lock / auto'], rows)));
  root.append(section('Provenance classes', table(['Class', 'Meaning'], Object.values(PROVENANCE).map(p => [h('span', { class: 'prov ' + p.cls }, p.label), p.tip]))));
}

function depGraph() {
  const n = SUITES.length, W = 900, H = 520, cx = W / 2, cy = H / 2, R = 220;
  const pos = Object.fromEntries(SUITES.map((s, i) => { const a = -Math.PI / 2 + 2 * Math.PI * i / n; return [s.id, [cx + R * 1.6 * Math.cos(a), cy + R * Math.sin(a)]]; }));
  let edges = '', nodes = '';
  for (const [to, froms] of Object.entries(DEPENDS)) for (const f of froms) { const [x1, y1] = pos[f], [x2, y2] = pos[to]; edges += `<path d="M${x1},${y1} Q${cx},${cy} ${x2},${y2}" fill="none" stroke="currentColor" stroke-opacity=".18" stroke-width="1.2" marker-end="url(#da)"/>`; }
  for (const s of SUITES) { const [x, y] = pos[s.id], o = store.outputMeta(s.id), c = o ? (o.stale ? '#f59e0b' : '#22c55e') : '#94a3b8'; nodes += `<a href="#/suite/${s.id}"><circle cx="${x}" cy="${y}" r="17" fill="${c}" fill-opacity=".2" stroke="${c}" stroke-width="2"/><text x="${x}" y="${y + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">${String(s.num).padStart(2, '0')}</text><text x="${x}" y="${y + (y > cy ? 32 : -24)}" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity=".75">${s.short}</text></a>`; }
  return h('div', { html: `<svg class="reg-graph" viewBox="0 0 ${W} ${H}" style="color:var(--fg)"><defs><marker id="da" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="currentColor" fill-opacity=".4"/></marker></defs>${edges}${nodes}</svg><p class="small muted">Green: current result · amber: stale (an upstream input changed) · grey: not yet run. Curves run from supplier to consumer.</p>` });
}
