// Workspace 7 — high-throughput scheduling: design-of-experiments campaigns (full / fractional factorial, Latin hypercube,
// D-optimal), a prioritised run queue across rigs and specimens, Gantt chart and rig utilisation.
import { h, table, callout, toast, kpiGrid, recList } from '../core/ui.js';
import { store } from '../core/state.js';
import { fullFactorial, fractionalFactorial, lhsDesign, dOptimal, scheduleRuns, addRecord, getRecord, TEST_TYPES, uid } from '../core/lab.js';
import { lab, card, grid, field, numIn, txtIn, selIn, btn, note, row, charts, protocolSelect, f3 } from './common.js';

const FACT = [['Th', 'Hot reservoir', '°C'], ['Tc', 'Cold reservoir', '°C'], ['sigmaH', 'Power-stroke stress', 'MPa'], ['sigmaL', 'Reset stress', 'MPa'], ['freq', 'Cycle frequency', 'Hz'], ['dutyHot', 'Hot-phase fraction', '-']];

export async function render(el) {
  const d = store.project.engine, C = charts(), L = lab();
  L.queue ||= [];
  // ---------------- DOE
  const use = {}, lo = {}, hi = {};
  const def = { Th: [55, 90], Tc: [10, 25], sigmaH: [90, 150], sigmaL: [50, 90], freq: [0.25, 2], dutyHot: [0.4, 0.6] };
  for (const [k] of FACT) { use[k] = h('input', { type: 'checkbox', checked: ['Th', 'Tc', 'sigmaH', 'freq'].includes(k) }); lo[k] = numIn(def[k][0]); hi[k] = numIn(def[k][1]); }
  const type = selIn([['ff', 'Full factorial (2 levels)'], ['ff3', 'Full factorial (3 levels)'], ['frac', 'Fractional factorial 2^(k−p)'], ['lhs', 'Latin hypercube'], ['dopt', 'D-optimal (interaction model)']], 'frac'), p = numIn(1, { step: 1 }), nRuns = numIn(12, { step: 1 }), prot = protocolSelect('', true), reps = numIn(1, { step: 1 }), dur = numIn(2, { step: 0.5 }), setup = numIn(0.5, { step: 0.25 }), pri = numIn(3, { step: 1 });
  const doeOut = h('div');
  el.append(card('Design of experiments → campaign', note('Choose the factors and their ranges; the design generator returns the run matrix in physical units. Fractional designs halve or quarter the runs at the cost of aliasing higher-order interactions (the resolution tells which effects stay separable). Generated runs inherit the chosen protocol and are queued with replicates.'),
    table(['Use', 'Factor', 'Low', 'High', 'Unit'], FACT.map(([k, l, u]) => [use[k], l, lo[k], hi[k], u])),
    grid(field('Design', type), field('Fraction p (fractional)', p), field('Runs (LHS / D-optimal)', nRuns), field('Protocol', prot), field('Replicates per point', reps), field('Run duration (h)', dur), field('Setup / changeover (h)', setup), field('Priority (1 high … 5 low)', pri)),
    row(btn('⚙ Generate design', () => gen(), 'primary')), doeOut));
  let design = null;
  function gen() {
    doeOut.innerHTML = ''; const fs = FACT.filter(([k]) => use[k].checked).map(([k, l]) => ({ key: k, label: l, lo: +lo[k].value, hi: +hi[k].value }));
    if (fs.length < 2) { doeOut.append(callout('warn', 'Select at least two factors.')); return; }
    try {
      design = type.value === 'ff' ? fullFactorial(fs) : type.value === 'ff3' ? fullFactorial(fs.map(f => ({ ...f, n: 3 }))) : type.value === 'frac' ? fractionalFactorial(fs, +p.value) : type.value === 'lhs' ? lhsDesign(fs, +nRuns.value, 7) : dOptimal(fs, Math.max(+nRuns.value, 1 + fs.length + fs.length * (fs.length - 1) / 2), { model: 'interaction' });
    } catch (e) { doeOut.append(callout('fail', e.message)); return; }
    const info = [`${design.kind}: ${design.runs} runs × ${+reps.value} replicate(s) = ${design.runs * +reps.value} runs.`];
    if (design.generators) info.push(`Generators ${design.generators.join(', ')}; defining words ${design.definingWords.join(', ')}; resolution ${design.resolution} — ${design.resolution >= 5 ? 'main effects and two-factor interactions are all estimable' : design.resolution === 4 ? 'main effects are clear, two-factor interactions are aliased with each other' : 'main effects are aliased with two-factor interactions; use for screening only'}.`);
    if (design.dEff) info.push(`D-efficiency ${f3(design.dEff)} for ${design.terms} model terms (1 = orthogonal two-level design).`);
    doeOut.append(callout('info', ...info.map(t => h('div', {}, t))), table(['Run', ...fs.map(f => f.label)], design.rows.map((r, i) => [i + 1, ...fs.map(f => f3(r[f.key]))])), row(btn('＋ Queue all runs', () => queue(fs), 'primary')));
  }
  function queue(fs) {
    const pr = prot.value ? getRecord(store, 'protocols', prot.value) : null, specs = L.specimens.filter(s => !['retired', 'failed', 'quarantined'].includes(s.status));
    let k = 0;
    for (const r of design.rows) for (let j = 0; j < +reps.value; j++) L.queue.push({ id: uid('JOB'), name: `${pr?.id || 'adhoc'} · ${fs.map(f => `${f.key}=${f3(r[f.key])}`).join(', ')}${+reps.value > 1 ? ` · rep ${j + 1}` : ''}`, test: pr?.test || 'cell-cycle', protocolId: pr?.id || null, conditions: r, specimen: specs.length ? specs[k++ % specs.length].id : '', duration: +dur.value, setup: +setup.value, priority: +pri.value, status: 'queued' });
    store.touch({ type: 'lab' }); toast(`${design.rows.length * +reps.value} runs queued`, 'ok'); drawQ();
  }
  // ---------------- rigs & queue
  const rigBox = h('div'), qBox = h('div'), gOut = h('div');
  el.append(card('Rigs', rigBox), card('Run queue', note('Priority list scheduling: highest priority (then longest) first, each run on the earliest available rig that can perform its test type, never two runs on the same specimen at once.'), qBox, row(btn('📅 Compute schedule', () => sched(), 'primary'), btn('＋ Add single run', () => { L.queue.push({ id: uid('JOB'), name: 'Manual run', test: 'cell-cycle', specimen: '', duration: 2, setup: 0.5, priority: 3, status: 'queued' }); drawQ(); }), btn('Clear queue', () => { if (confirm('Clear the whole queue?')) { L.queue.length = 0; store.touch({ type: 'lab' }); drawQ(); } })), gOut));
  function drawRigs() {
    rigBox.innerHTML = ''; const nm = txtIn('', 'rig name'), caps = txtIn('cell-cycle', 'test types, comma-separated');
    rigBox.append(table(['ID', 'Name', 'Capabilities', ''], L.rigs.map((r, i) => [r.id, r.name, (r.caps || []).join(', '), btn('✕', () => { L.rigs.splice(i, 1); store.touch({ type: 'lab' }); drawRigs(); }, 'sm')])), row(nm, caps, btn('＋ Rig', () => { L.rigs.push({ id: uid('RIG'), name: nm.value || 'Rig', caps: caps.value.split(',').map(s => s.trim()).filter(Boolean) }); store.touch({ type: 'lab' }); drawRigs(); })), note(`Known test types: ${Object.keys(TEST_TYPES).join(', ')}.`));
  }
  function drawQ() {
    qBox.innerHTML = ''; if (!L.queue.length) { qBox.append(note('Queue empty.')); return; }
    const ed = (j, k, w = 70) => { const e = h('input', { value: j[k] ?? '', class: 'search', style: `max-width:${w}px` }); e.onchange = () => { j[k] = ['duration', 'setup', 'priority'].includes(k) ? +e.value : e.value; store.touch({ type: 'lab' }); }; return e; };
    qBox.append(table(['Job', 'Name', 'Test', 'Specimen', 'Rig (optional)', 'Dur. h', 'Setup h', 'Priority', ''], L.queue.map((j, i) => [j.id, j.name, ed(j, 'test', 100), ed(j, 'specimen', 110), ed(j, 'rig', 80), ed(j, 'duration', 50), ed(j, 'setup', 50), ed(j, 'priority', 40), btn('✕', () => { L.queue.splice(i, 1); store.touch({ type: 'lab' }); drawQ(); }, 'sm')])));
  }
  function sched() {
    gOut.innerHTML = ''; C.dispose(); if (!L.queue.length) { gOut.append(note('Queue empty.')); return; }
    const S = scheduleRuns(L.queue, L.rigs);
    gOut.append(kpiGrid([{ label: 'Makespan', value: S.makespan, unit: 'h', explain: 'Time from the first start to the last finish with the current rigs.', prov: 'calc' }, { label: 'Scheduled runs', value: S.items.length, explain: 'Runs assigned to a rig.', prov: 'calc' }, { label: 'Unplaced', value: S.unplaced.length, explain: 'Runs with no capable rig — add a rig with that test capability.', status: S.unplaced.length ? 'bad' : 'ok', prov: 'calc' }, { label: 'Mean utilisation', value: Object.values(S.util).reduce((a, b) => a + b, 0) / Math.max(1, L.rigs.length) * 100, unit: '%', explain: 'Busy time over makespan averaged across rigs; low values mean one rig is the bottleneck.', prov: 'calc' }]));
    gOut.append(h('div', { html: gantt(S, L.rigs), style: 'overflow-x:auto;margin:10px 0' }));
    const cg = C.grid(); gOut.append(cg);
    C.add(cg, { type: 'bar', title: 'Rig utilisation', categories: L.rigs.map(r => r.id), series: [{ name: 'utilisation %', values: L.rigs.map(r => (S.util[r.id] || 0) * 100) }], y: { label: '%' }, explain: 'Fraction of the campaign each rig is busy (including setup). Add a second rig of the most-utilised type to shorten the campaign.' });
    const busiest = Object.entries(S.util).sort((a, b) => b[1] - a[1])[0];
    gOut.append(recList([...(S.unplaced.length ? [{ level: 'critical', text: `${S.unplaced.length} run(s) cannot be placed: ${[...new Set(S.unplaced.map(u => u.why))].join('; ')}.`, basis: 'rig capabilities' }] : []), { level: 'info', text: `Bottleneck: ${busiest?.[0]} at ${f3((busiest?.[1] || 0) * 100)} % utilisation. Randomise run order within each rig so drift is not confounded with a factor.`, basis: `makespan ${f3(S.makespan)} h` }, { level: 'econ', text: `Setup/changeover is ${f3(S.items.reduce((a, b) => a + (b.setup || 0), 0))} h of the campaign: group runs by bath temperature to reduce thermal settling time.`, basis: 'sum of setup times' }]),
      row(btn('💾 Save schedule', () => { addRecord(store, 'schedules', { name: `Schedule ${new Date().toLocaleString()}`, items: S.items, unplaced: S.unplaced, makespan: S.makespan, util: S.util }); }, 'primary')));
  }
  drawRigs(); drawQ();
  return { dispose: () => C.dispose() };
}
function gantt(S, rigs) {
  const W = 900, rowH = 30, left = 150, H = 40 + rigs.length * rowH, sc = (W - left - 20) / Math.max(1e-9, S.makespan), col = (p) => ['#dc2626', '#f97316', '#3b82f6', '#10b981', '#64748b'][Math.min(4, Math.max(0, (p || 3) - 1))];
  let g = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:560px;color:var(--fg)" xmlns="http://www.w3.org/2000/svg">`;
  for (let t = 0; t <= S.makespan + 1e-9; t += Math.max(1, Math.ceil(S.makespan / 12))) g += `<line x1="${left + t * sc}" y1="20" x2="${left + t * sc}" y2="${H}" stroke="currentColor" stroke-opacity=".15"/><text x="${left + t * sc}" y="14" font-size="10" text-anchor="middle" fill="currentColor">${t} h</text>`;
  rigs.forEach((r, i) => { const y = 24 + i * rowH; g += `<text x="6" y="${y + 18}" font-size="11" fill="currentColor">${r.id}</text>`; for (const it of S.items.filter(x => x.rig === r.id)) { const x = left + it.start * sc, w = Math.max(2, (it.end - it.start) * sc), sw = (it.setup || 0) * sc; g += `<rect x="${x}" y="${y}" width="${sw}" height="${rowH - 8}" fill="#94a3b8" fill-opacity=".5"/><rect x="${x + sw}" y="${y}" width="${Math.max(1, w - sw)}" height="${rowH - 8}" fill="${col(it.priority)}" fill-opacity=".8"><title>${it.name} (${it.start.toFixed(1)}–${it.end.toFixed(1)} h, specimen ${it.specimen || '—'})</title></rect>`; } });
  return g + `</svg><div class="small muted">Grey: setup / changeover. Colour: priority (red = 1 … grey = 5). Hover a bar for the run.</div>`;
}
