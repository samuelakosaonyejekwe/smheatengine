// Generic suite page: input generation modes, coupling, execution, results, explanations, recommendations,
// verification, theory/IBC/CVV/format documentation, experiment import & calibration, exports.
import { h, $, tabs, kpiGrid, verdicts, table, recList, paramControl, section, callout, errorBox, toast, progressBar, nextFrame, provChip, modal } from './ui.js';
import { chart, download } from './chart.js';
import { store, hashObj, DEPENDS, CREDIBILITY } from './state.js';
import * as num from './num.js';
import * as physics from './physics.js';
import * as sma from './sma.js';
import * as heat from './heat.js';
import * as eng from './engine.js';
import * as analysis from './analysis.js';
import * as live from './live.js';
import * as materials from './materials.js';
import { parseFile, ACCEPT, autoMap } from './io.js';
import { zip } from './io.js';
import { contextRecs, verdictRecs, bestPractice, cachedSiteContext, getSiteContext, designRecs } from './advisor.js';
import { SUITES, suiteIndex } from '../suites/index.js';

const MODES = [
  { id: 'auto', label: 'Automatic', tip: 'Generate a reference study from library values, coupled upstream results and explicit engineering assumptions.' },
  { id: 'guided', label: 'Guided', tip: 'Context-specific engineering choices with explanations.' },
  { id: 'expert', label: 'Expert', tip: 'Expose the complete parameter set including numerical/solver settings.' },
  { id: 'import', label: 'Import experimental data', tip: 'Import measured data for calibration and validation against predictions.' },
];

export function makeCtx(def, onProgress) {
  return {
    store, num, physics, analysis, live, materials, sma, heat, eng, def,
    engine: eng.designWith(store.project.engine), site: store.project.site, env: store.project.env,
    upstream: (id) => store.output(id), upstreamMeta: (id) => store.outputMeta(id),
    material: (key) => materials.componentMaterial(store, key),
    progress: onProgress || (() => { }),
    experiments: store.project.experiments[def.id] || [],
    yield: nextFrame,
  };
}

// Resolve parameter values: user-locked > stored > automatic generator > default
export function resolveParams(def, ctx, regenerate = false) {
  const stored = store.params(def.id), prov = store.prov(def.id), locks = store.locks(def.id), out = {}, provOut = {};
  for (const p of def.params || []) {
    let v = stored[p.key], pv = prov[p.key];
    if (locks[p.key] && v !== undefined) { out[p.key] = v; provOut[p.key] = pv || 'user'; continue; }
    // values that came from an automatic/coupled generator are recomputed on every run so they follow upstream changes;
    // values the user typed (no auto flag) are kept until regeneration or reset
    const autoFlag = store.autoKeys(def.id)[p.key] || ['coupled', 'calc', 'live'].includes(pv);
    if ((regenerate || v === undefined || autoFlag) && p.auto) { try { const a = p.auto(ctx); if (a !== undefined && a !== null) { if (typeof a === 'object' && 'value' in a) { v = a.value; pv = a.prov || 'calc'; } else { v = a; pv = 'coupled'; } store.autoKeys(def.id)[p.key] = true; } } catch { /* fall back */ } }
    if (v === undefined || (regenerate && !p.auto && !locks[p.key])) { v = p.default; pv = p.prov || 'estimated'; }
    out[p.key] = v; provOut[p.key] = pv;
  }
  return { values: out, prov: provOut };
}

export async function renderSuite(root, id) {
  const meta = SUITES.find(s => s.id === id); if (!meta) { root.append(callout('fail', 'Unknown suite ' + id)); return; }
  root.append(h('div', { class: 'spinner-wrap' }, h('div', { class: 'spinner' }), 'Loading suite…'));
  let def; try { def = (await meta.load()).default; } catch (e) { root.innerHTML = ''; root.append(errorBox(e)); return; }
  root.innerHTML = '';
  def = { ...meta, ...def };
  const idx = suiteIndex(id), prev = SUITES[idx - 1], next = SUITES[idx + 1];
  const om = store.outputMeta(id);
  const header = h('div', { class: 'suite-head' },
    h('div', { class: 'suite-num' }, String(def.num).padStart(2, '0')),
    h('div', { class: 'suite-titles' }, h('div', { class: 'suite-group' }, def.group), h('h1', {}, def.title), h('p', { class: 'suite-desc' }, def.description || '')),
    h('div', { class: 'suite-badges' }, om ? h('span', { class: 'badge ' + (om.stale ? 'warn' : 'ok'), title: om.stale ? om.staleReason : 'Results are current' }, om.stale ? 'Stale — re-run' : 'Current') : h('span', { class: 'badge' }, 'Not yet run'), h('span', { class: 'badge cred', title: 'Model credibility classification' }, om?.credibility || def.credibility || 'Analytical screening')));
  const deps = (DEPENDS[id] || []).map(d => { const s = SUITES.find(x => x.id === d); const o = store.outputMeta(d); return h('a', { class: 'dep ' + (o ? (o.stale ? 'stale' : 'ok') : 'none'), href: `#/suite/${d}`, title: o ? (o.stale ? 'Upstream result stale' : 'Upstream result available — coupled') : 'Upstream not yet run — defaults used' }, `${String(s?.num).padStart(2, '0')} ${s?.short}`); });
  const coupling = deps.length ? h('div', { class: 'deps' }, h('span', { class: 'muted small' }, 'Coupled inputs from: '), ...deps) : null;
  root.append(header); if (coupling) root.append(coupling);

  const layout = h('div', { class: 'suite-layout' }); root.append(layout);
  const left = h('aside', { class: 'suite-inputs card' }), right = h('div', { class: 'suite-results' });
  layout.append(left, right);

  let mode = store.mode(id);
  const modeBar = h('div', { class: 'modes', role: 'radiogroup', 'aria-label': 'Input generation mode' }, ...MODES.map(m => h('button', { class: 'mode' + (m.id === mode ? ' on' : ''), title: m.tip, onclick: () => { mode = m.id; store.setMode(id, m.id); drawInputs(); [...modeBar.children].forEach((b, i) => b.classList.toggle('on', MODES[i].id === mode)); } }, m.label)));
  const paramsBox = h('div', { class: 'params' });
  const runBtn = h('button', { class: 'btn primary run', onclick: () => run(true) }, '▶ Run analysis');
  const regenBtn = h('button', { class: 'btn', title: 'Regenerate all unlocked inputs from coupled results and library values', onclick: () => { resolveAndStore(true); drawInputs(); run(); } }, '↻ Auto-generate inputs');
  const autoChk = h('input', { type: 'checkbox', checked: localStorage.getItem('tx.autorun') !== '0', onchange: (e) => localStorage.setItem('tx.autorun', e.target.checked ? '1' : '0') });
  const prog = progressBar();
  // Reset options: restore this suite to a clean state before (or instead of) running
  const resetKey = 'tx.resetBeforeRun.' + id;
  const resetChk = h('input', { type: 'checkbox', checked: localStorage.getItem(resetKey) === '1', onchange: (e) => localStorage.setItem(resetKey, e.target.checked ? '1' : '0') });
  const doReset = ({ inputs = true, locks = false, results = true, experiments = false } = {}) => {
    if (inputs) { const lk = locks ? {} : store.locks(id); const P = store.params(id), PV = store.prov(id); for (const k of Object.keys(P)) if (!lk[k]) { delete P[k]; delete PV[k]; } }
    if (locks) store.project.locks[id] = {};
    if (results) { delete store.project.outputs[id]; out.innerHTML = ''; out.append(h('div', { class: 'callout info' }, 'Suite reset — inputs regenerated from defaults and coupled upstream results. Press Run analysis.')); }
    if (experiments) delete store.project.experiments[id];
    store.touch({ type: 'reset-suite', id }); resolveAndStore(false); drawInputs(); prog.set(0);
  };
  const resetBtn = h('button', { class: 'btn', title: 'Reset this suite before running', onclick: () => {
    const o = { inputs: h('input', { type: 'checkbox', checked: true }), locks: h('input', { type: 'checkbox' }), results: h('input', { type: 'checkbox', checked: true }), experiments: h('input', { type: 'checkbox' }) };
    modal('Reset this suite', h('div', {}, h('p', { class: 'muted' }, 'Choose what to reset. Unlocked inputs return to their automatic values (defaults + coupled upstream results).'),
      ...[['inputs', 'Inputs → automatic defaults'], ['locks', 'Also clear locked values'], ['results', 'Clear computed results'], ['experiments', 'Remove imported experimental datasets for this suite']].map(([k, l]) => h('label', { class: 'row gap', style: 'margin:6px 0' }, o[k], l))),
      [{ label: 'Cancel' }, { label: 'Reset', onClick: () => doReset(Object.fromEntries(Object.entries(o).map(([k, e]) => [k, e.checked]))) }, { label: 'Reset & run', primary: true, onClick: () => { doReset(Object.fromEntries(Object.entries(o).map(([k, e]) => [k, e.checked]))); run(); } }]);
  } }, '⟲ Reset');
  left.append(h('h3', { class: 'card-title' }, 'Inputs'), modeBar, h('div', { class: 'row gap wrap' }, runBtn, resetBtn, regenBtn), h('label', { class: 'small muted autorun' }, autoChk, ' Re-run automatically when an input changes'), h('label', { class: 'small muted autorun' }, resetChk, ' Reset inputs to defaults before each run'), prog, paramsBox);

  let resolved = null; resolveAndStore(false);
  function resolveAndStore(regen) {
    const ctx = makeCtx(def); const r = resolveParams(def, ctx, regen);
    const P = store.params(id), PV = store.prov(id); for (const k in r.values) { P[k] = r.values[k]; PV[k] = r.prov[k]; }
    store.touch({ type: 'params', id }); resolved = r; return r;
  }
  let debounce;
  function drawInputs() {
    paramsBox.innerHTML = '';
    if (mode === 'import') { paramsBox.append(importPanel(def, () => run())); return; }
    if (mode === 'auto') paramsBox.append(callout('info', h('b', {}, 'Automatic mode. '), 'Inputs are generated from coupled upstream results, the materials registry and documented engineering assumptions. Switch to Guided or Expert to edit; lock any value to keep it during regeneration.'));
    const groups = {};
    for (const p of def.params || []) { if (mode !== 'expert' && p.expert) continue; (groups[p.group || 'General'] ||= []).push(p); }
    const locks = store.locks(id);
    for (const [g, list] of Object.entries(groups)) {
      const det = h('details', { class: 'pgroup', open: mode !== 'auto' || Object.keys(groups).indexOf(g) === 0 }, h('summary', {}, g));
      for (const p of list) {
        const ctl = paramControl(p, store.params(id)[p.key], store.prov(id)[p.key], !!locks[p.key], (v) => { store.setParam(id, p.key, v, 'user'); if (autoChk.checked) { clearTimeout(debounce); debounce = setTimeout(run, 250); } drawInputsSoon(); }, (lk) => { store.locks(id)[p.key] = lk; store.touch(); drawInputs(); });
        if (mode === 'auto') ctl.querySelectorAll('input,select').forEach(e => { e.disabled = true; });
        det.append(ctl);
      }
      paramsBox.append(det);
    }
    if (def.presets?.length && mode !== 'auto') paramsBox.append(h('div', { class: 'presets' }, h('div', { class: 'small muted' }, 'Scenario presets'), ...def.presets.map(ps => h('button', { class: 'chip', onclick: () => { for (const [k, v] of Object.entries(ps.values)) store.setParam(id, k, v, 'user'); drawInputs(); run(); } }, ps.label))));
  }
  let soon; const drawInputsSoon = () => { clearTimeout(soon); soon = setTimeout(() => { if (document.activeElement?.closest?.('.params')) return; drawInputs(); }, 900); };
  drawInputs();

  const out = h('div', { class: 'results-body' }); right.append(out);
  let lastRes = null, running = false;
  async function run(explicit = false) {
    if (running) return;
    // only an explicit Run press resets — automatic re-runs after an edit must keep the edited value
    if (explicit === true && resetChk.checked) doReset({ inputs: true, results: false });
    running = true; runBtn.disabled = true; prog.set(0.02, 'starting');
    const ctx = makeCtx(def, (f, msg) => prog.set(f, msg)); const p = { ...store.params(id) };
    out.innerHTML = ''; out.append(h('div', { class: 'spinner-wrap' }, h('div', { class: 'spinner' }), 'Solving governing equations…'));
    await nextFrame();
    const t0 = performance.now();
    try {
      const res = await def.run(p, ctx); res.elapsed = performance.now() - t0; lastRes = res;
      store.publish(id, res.outputs || {}, { credibility: res.credibility || def.credibility || 'Analytical screening', hash: hashObj(p) });
      header.querySelector('.suite-badges').innerHTML = ''; header.querySelector('.suite-badges').append(h('span', { class: 'badge ok' }, 'Current'), h('span', { class: 'badge cred' }, res.credibility || 'Analytical screening'));
      out.innerHTML = ''; renderResults(out, def, res, p, ctx);
      prog.set(1, 'done');
    } catch (e) { out.innerHTML = ''; out.append(errorBox(e)); prog.set(0, 'error'); }
    running = false; runBtn.disabled = false;
  }
  root.append(h('nav', { class: 'suite-nav' },
    prev ? h('a', { class: 'nav-arrow prev', href: `#/suite/${prev.id}` }, h('span', { class: 'arr' }, '◀'), h('span', {}, h('small', {}, 'Previous suite'), h('b', {}, `${String(prev.num).padStart(2, '0')} ${prev.short}`))) : h('span'),
    h('a', { class: 'nav-home', href: '#/' }, '⌂ Console'),
    next ? h('a', { class: 'nav-arrow next', href: `#/suite/${next.id}` }, h('span', {}, h('small', {}, 'Next suite'), h('b', {}, `${String(next.num).padStart(2, '0')} ${next.short}`)), h('span', { class: 'arr' }, '▶')) : h('span')));
  run();
  return { rerun: run, get results() { return lastRes; } };
}

function renderResults(out, def, res, p, ctx) {
  const allVerdicts = res.verdicts || [];
  if (allVerdicts.length) out.append(section('Feasibility & safety verdicts', verdicts(allVerdicts)));
  if (res.headline) out.append(callout(res.headlineKind || 'info', res.headline));
  for (const k of res.kpis || []) if (typeof k.value === 'number' && !Number.isFinite(k.value)) { k.value = Number.isNaN(k.value) ? 'not defined for these inputs' : (k.value > 0 ? 'unbounded (∞) — never reached' : '−∞'); k.unit = ''; k.status ||= 'warn'; }
  if (res.kpis?.length) out.append(section('Key results', kpiGrid(res.kpis), h('div', { class: 'small muted' }, `Solved in ${num.fmt(res.elapsed, 3)} ms · inputs hash ${hashObj(p)} · ${new Date().toLocaleString()}`)));
  const T = [];
  if (res.charts?.length) T.push({ label: 'Plots & contours', icon: '📈', render: (el) => { const g = h('div', { class: 'chart-grid' }); el.append(g); for (const c of res.charts) { const box = h('div', { class: 'chart-cell' + (c.wide ? ' wide' : '') }); g.append(box); chart(box, c); } } });
  for (const v of res.views || []) T.push({ label: v.label, icon: v.icon || '🧊', render: (el) => { const box = h('div', { class: 'view-box' }); el.append(box); Promise.resolve(v.render(box, ctx)).catch(e => box.append(errorBox(e))); } });
  if (res.tables?.length) T.push({ label: 'Tables', icon: '▦', render: (el) => { for (const t of res.tables) el.append(section(t.title, t.explain ? h('p', { class: 'muted small' }, t.explain) : null, table(t.cols, t.rows), h('button', { class: 'btn sm', onclick: () => download(new Blob([[t.cols.join(','), ...t.rows.map(r => r.map(c => typeof c === 'object' ? '' : c).join(','))].join('\n')], { type: 'text/csv' }), (t.title || 'table').replace(/\W+/g, '-') + '.csv') }, 'Download CSV'))); } });
  T.push({ label: 'Explanation', icon: '💬', render: (el) => el.append(explanation(def, res)) });
  T.push({ label: 'Recommendations', icon: '🧭', render: (el) => recsPane(el, def, res) });
  if (res.checks?.length || res.convergence) T.push({ label: 'Verification', icon: '✓', render: (el) => verificationPane(el, res) });
  T.push({ label: 'Theory & models', icon: '∑', render: (el) => theoryPane(el, def) });
  T.push({ label: 'IC / BC & CVV', icon: '⚙', render: (el) => ibcPane(el, def) });
  T.push({ label: 'Formats & export', icon: '⇩', render: (el) => exportPane(el, def, res, p) });
  if ((ctx.experiments || []).length) T.push({ label: 'Experiment vs model', icon: '⚖', render: (el) => experimentPane(el, def, res, ctx) });
  out.append(tabs(T).root);
}

function explanation(def, res) {
  const box = h('div', { class: 'explain' });
  box.append(h('p', {}, h('b', {}, 'How to read these results. '), `Suite ${def.num} (${def.title}) solved the models listed under “Theory & models” for the inputs shown on the left; every input carries a provenance tag and every number below is traceable to that set.`));
  for (const e of res.explain || []) box.append(typeof e === 'string' ? h('p', {}, e) : h('div', {}, h('h4', {}, e.title), h('p', {}, e.text)));
  if (res.kpis?.length) box.append(h('h4', {}, 'Each output explained'), h('dl', { class: 'expl-list' }, ...res.kpis.flatMap(k => [h('dt', {}, k.label, k.unit ? ` [${k.unit}]` : '', ' = ', typeof k.value === 'number' ? num.fmt(k.value, 4) : String(k.value ?? '—')), h('dd', {}, k.explain || 'Direct output of the governing model.')])));
  if (res.charts?.length) box.append(h('h4', {}, 'Each plot explained'), h('dl', { class: 'expl-list' }, ...res.charts.flatMap(c => [h('dt', {}, c.title), h('dd', {}, c.explain || '')])));
  box.append(callout('info', h('b', {}, 'Credibility: '), (res.credibility || 'Analytical screening') + '. ', 'A simulated result is not a physical validation. Use the “Import experimental data” mode and Suite 19 to calibrate and validate against independent measurements.'));
  return box;
}

async function recsPane(el, def, res) {
  const base = [...verdictRecs(res.verdicts), ...(res.recs || []), ...designRecs(def)];
  const listBox = h('div'); el.append(section('Engineering recommendations (from this analysis)', listBox)); listBox.append(recList(base));
  const ctxBox = h('div', {}, h('p', { class: 'muted small' }, 'Fetching live sustainability & economic context for the project site…')); el.append(section('Live sustainability & economics context', ctxBox));
  const litBox = h('div', {}, h('p', { class: 'muted small' }, 'Querying the global literature index for the latest best practice…')); el.append(section('Fresh best practice & prior art (live literature)', litBox));
  getSiteContext().then(c => { ctxBox.innerHTML = ''; const r = contextRecs(def, res, c); ctxBox.append(r.length ? recList(r) : h('p', { class: 'muted' }, 'No context-specific items (site context unavailable or not applicable).')); if (c.errors?.length) ctxBox.append(h('div', { class: 'small muted' }, 'Partial data: ' + c.errors.slice(0, 3).join('; '))); }).catch(e => { ctxBox.innerHTML = ''; ctxBox.append(callout('warn', 'Live context unavailable (offline?). ' + e.message)); });
  bestPractice(def, 6).then(r => { litBox.innerHTML = ''; if (!r.items.length) { litBox.append(h('p', { class: 'muted' }, r.error ? 'Literature service unavailable: ' + r.error : 'No items.')); return; } litBox.append(h('ul', { class: 'lit' }, ...r.items.map(it => h('li', {}, h('a', { href: it.url, target: '_blank', rel: 'noopener' }, it.title), h('span', { class: 'muted small' }, ` — ${it.authors || ''} ${it.venue ? '· ' + it.venue : ''} · ${it.year} · cited ${it.cites ?? 0}×${it.oa ? ' · open access' : ''}`)))), h('div', { class: 'small muted' }, `Source: ${r.meta?.name} · retrieved ${r.meta?.fetched?.slice(0, 16).replace('T', ' ')} UTC${r.meta?.cached ? ' (cached)' : ''}. Literature supports, but cannot by itself establish, novelty or validity.`)); });
  void cachedSiteContext;
}

function verificationPane(el, res) {
  if (res.checks?.length) el.append(section('Numerical verification & conservation checks', table(['Check', 'Value', 'Target / criterion', 'Status', 'Detail'], res.checks.map(c => [c.name, typeof c.value === 'number' ? num.fmt(c.value, 4) : (c.value ?? ''), c.target ?? '', h('span', { class: 'badge ' + (c.pass === undefined ? '' : c.pass ? 'ok' : 'fail') }, c.pass === undefined ? 'info' : c.pass ? 'pass' : 'fail'), c.detail || '']))));
  if (res.convergence) { const box = h('div'); el.append(section('Solver convergence history', box)); chart(box, { type: 'line', title: res.convergence.title || 'Residual history', x: { label: 'Iteration' }, y: { label: 'Residual', log: true }, series: res.convergence.series, explain: 'Residual norms per iteration. A monotone decrease to the tolerance indicates iterative convergence; stagnation or growth indicates an unconverged or unstable solution.' }); }
}
function theoryPane(el, def) {
  el.append(section('Governing equations, models & numerical methods', h('ul', { class: 'theory' }, ...(def.equations || []).map(e => h('li', {}, e)))));
  if (def.methods?.length) el.append(section('Numerical implementation in this suite', h('ul', { class: 'theory' }, ...def.methods.map(e => h('li', {}, e)))));
  if (def.assumptions?.length) el.append(section('Assumptions & validity limits', h('ul', { class: 'theory' }, ...def.assumptions.map(e => h('li', {}, e)))));
}
function ibcPane(el, def) {
  const L = (a) => h('ul', {}, ...(a || []).map(x => h('li', {}, x)));
  el.append(section('Initial conditions', L(def.ibc?.initial)), section('Boundary conditions', L(def.ibc?.boundary)));
  el.append(section('Calibration datasets & parameters', L(def.cvv?.calibration)), section('Verification benchmarks', L(def.cvv?.verification)), section('Validation (independent experiments)', L(def.cvv?.validation)));
}
function exportPane(el, def, res, p) {
  const kv = (res.kpis || []).map(k => [k.label, typeof k.value === 'number' ? k.value : String(k.value), k.unit || '']);
  el.append(section('Supported formats for this suite', h('div', { class: 'two' }, h('div', {}, h('h4', {}, 'Import'), h('ul', {}, ...(def.formats?.import || ['CSV', 'JSON', 'XLSX']).map(f => h('li', {}, f)))), h('div', {}, h('h4', {}, 'Export'), h('ul', {}, ...(def.formats?.export || ['CSV', 'JSON', 'PNG', 'SVG']).map(f => h('li', {}, f)))))));
  const btns = h('div', { class: 'row gap wrap' },
    h('button', { class: 'btn', onclick: () => download(new Blob([JSON.stringify({ suite: def.id, title: def.title, inputs: p, provenance: store.prov(def.id), results: { kpis: res.kpis, verdicts: res.verdicts, outputs: res.outputs, checks: res.checks } }, null, 2)], { type: 'application/json' }), `${def.id}-results.json`) }, 'Results (JSON)'),
    h('button', { class: 'btn', onclick: () => download(new Blob([['quantity,value,unit', ...kv.map(r => r.map(c => /[",]/.test(String(c)) ? `"${c}"` : c).join(','))].join('\n')], { type: 'text/csv' }), `${def.id}-kpis.csv`) }, 'Key results (CSV)'),
    h('button', { class: 'btn primary', onclick: () => evidencePackage(def, res, p) }, 'Research evidence package (ZIP)'),
    h('button', { class: 'btn', title: 'Opens the print dialog — choose “Save as PDF” for a PDF engineering report', onclick: () => window.print() }, 'Engineering report (print / PDF)'));
  el.append(section('Export', btns, ...(res.exports || []).map(x => h('button', { class: 'btn', onclick: x.action }, x.label))));
}
async function evidencePackage(def, res, p) {
  const proj = store.export(); const files = [];
  files.push({ name: 'README.txt', data: `THERMA-X100 research evidence package\nSuite ${def.num}: ${def.title}\nGenerated ${new Date().toISOString()}\nProject ${proj.id} revision ${proj.revision}\n\nContents: design specification, reproducibility record, numerical verification, physical predictions, sensitivity, failure analysis.\nSimulated predictions are not physical validation; see validation status.\n` });
  files.push({ name: 'design_specification.json', data: JSON.stringify({ engine: proj.engine, site: proj.site, materials: proj.materials, inputs: p }, null, 2) });
  files.push({ name: 'reproducibility_record.json', data: JSON.stringify({ software: 'THERMA-X100', version: window.TX_VERSION, suite: def.id, inputsHash: hashObj(p), provenance: store.prov(def.id), locks: store.locks(def.id), userAgent: navigator.userAgent, timestamp: new Date().toISOString() }, null, 2) });
  files.push({ name: 'numerical_verification.json', data: JSON.stringify(res.checks || [], null, 2) });
  files.push({ name: 'physical_predictions.json', data: JSON.stringify({ kpis: res.kpis, outputs: res.outputs }, null, 2) });
  files.push({ name: 'failure_analysis.json', data: JSON.stringify((res.verdicts || []).filter(v => (v.status || (v.pass ? 'pass' : 'fail')) !== 'pass'), null, 2) });
  files.push({ name: 'validation_status.txt', data: `Credibility: ${res.credibility || 'Analytical screening'}\nClassification ladder: ${CREDIBILITY.join(' > ')}\nExperimental datasets attached: ${(store.project.experiments[def.id] || []).length}\n` });
  for (const [i, c] of (res.charts || []).entries()) { const { toCSV } = await import('./chart.js'); files.push({ name: `plots/${String(i + 1).padStart(2, '0')}_${(c.title || 'plot').replace(/\W+/g, '_')}.csv`, data: toCSV(c) }); }
  download(await zip(files), `therma-${def.id}-evidence-r${proj.revision}.zip`); toast('Evidence package downloaded', 'ok');
}

function importPanel(def, rerun) {
  const box = h('div', { class: 'import' });
  box.append(callout('info', 'Import measured data (CSV, TSV, TXT/DAT, JSON, XLSX/XLS/ODS, XML/GPX/KML, STL, OBJ, MSH, VTK). Data are stored with the project, kept separate for calibration and validation, and overlaid on model predictions.'));
  const drop = h('label', { class: 'drop' }, h('input', { type: 'file', accept: ACCEPT, multiple: true, onchange: (e) => handle(e.target.files) }), h('div', {}, '⇪ Drop files here or tap to choose'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); }); drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files); });
  const list = h('div'); box.append(drop, list);
  const draw = () => { list.innerHTML = ''; const ex = store.project.experiments[def.id] || []; if (!ex.length) return; list.append(table(['Dataset', 'Rows', 'Use', ''], ex.map((d, i) => [d.name, d.nRows ?? '', h('select', { onchange: (e) => { d.use = e.target.value; store.touch(); } }, ...['calibration', 'validation'].map(u => h('option', { value: u, selected: d.use === u }, u))), h('button', { class: 'icon-btn sm', onclick: () => { ex.splice(i, 1); store.touch(); draw(); } }, '✕')]))); };
  async function handle(files) { for (const f of files) { try { const r = await parseFile(f); const ex = (store.project.experiments[def.id] ||= []); const rec = { name: f.name, kind: r.kind, use: 'validation', t: new Date().toISOString() }; if (r.columns) { rec.columns = r.columns; rec.header = r.header; rec.nRows = r.nRows; rec.map = autoMap(r.header); } else if (r.points) { rec.points = r.points; rec.nRows = r.points.length; } else rec.summary = { triangles: r.triangles, format: r.format }; ex.push(rec); store.touch(); toast(`Imported ${f.name} (${r.kind})`, 'ok'); } catch (e) { toast(`${f.name}: ${e.message}`, 'fail', 6000); } } draw(); rerun(); }
  draw(); return box;
}

function experimentPane(el, def, res, ctx) {
  for (const d of ctx.experiments) {
    if (!d.columns) { el.append(section(d.name, h('p', {}, `${d.kind} dataset: ${JSON.stringify(d.summary || {})}`))); continue; }
    const xs = d.header, sx = h('select', {}, ...xs.map(c => h('option', {}, c))), sy = h('select', {}, ...xs.map((c, i) => h('option', { selected: i === 1 }, c)));
    const series = (res.charts || []).flatMap((c, ci) => (c.series || []).map((s, si) => ({ label: `${c.title} — ${s.name || 'series'}`, s, ci, si }))); const sm = h('select', {}, ...series.map((s, i) => h('option', { value: i }, s.label)));
    const plot = h('div'), stats = h('div');
    const go = () => {
      const X = d.columns[sx.value], Y = d.columns[sy.value]; const m = series[+sm.value]; plot.innerHTML = ''; stats.innerHTML = '';
      const sr = [{ name: 'Measured — ' + d.name, x: X, y: Y, mode: 'markers', color: '#facc15' }]; if (m) sr.push({ name: 'Model — ' + m.s.name, x: m.s.x, y: m.s.y, color: '#3b82f6' });
      chart(plot, { type: 'line', title: 'Simulation / experiment overlay', x: { label: sx.value }, y: { label: sy.value }, series: sr, explain: 'Measured points versus the selected model prediction. Agreement must be judged against acceptance criteria chosen before testing and against measurement uncertainty.' });
      if (m) { const pred = X.map(x => num.interp1(m.s.x, m.s.y, x)); const mt = num.metrics(pred, Y); stats.append(table(['Metric', 'Value'], [['Samples', mt.n], ['Bias (model − measured)', mt.bias], ['RMSE', mt.rmse], ['MAE', mt.mae], ['Normalised RMSE', mt.nrmse], ['R²', mt.r2], ['Pearson r', mt.r], ['Bias 95 % CI', `${num.fmt(mt.biasCI[0])} … ${num.fmt(mt.biasCI[1])}`]])); const resid = X.map((x, i) => Y[i] - pred[i]); const rb = h('div'); stats.append(rb); chart(rb, { type: 'scatter', title: 'Residuals (measured − model)', x: { label: sx.value }, y: { label: 'Residual' }, series: [{ name: 'residual', x: X, y: resid }], annotations: [{ type: 'hline', y: 0, color: '#94a3b8' }], explain: 'Residual structure (trends rather than random scatter) reveals model-form error that calibration alone cannot remove.' }); }
    };
    [sx, sy, sm].forEach(s => s.onchange = go);
    el.append(section(`${d.name} (${d.use})`, h('div', { class: 'row gap wrap' }, h('label', {}, 'x ', sx), h('label', {}, 'y ', sy), h('label', {}, 'compare with ', sm)), plot, stats)); go();
  }
}
export { provChip };
