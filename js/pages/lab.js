// Experimental Science & Discovery Laboratory: one environment to design, simulate, construct, instrument, conduct,
// analyse and reproduce THERMA-X100 experiments — virtual (model-executed), physical (instrumented hardware) and hybrid
// (measured channels driving the models). Twelve lazily loaded workspaces under #/lab/<workspace>; every dataset carries
// its kind and provenance, so a measurement is never confused with a prediction.
import { h, callout, errorBox, spinner } from '../core/ui.js';
import { HARDWARE_INTERLOCK_STATEMENT, ladderStatus } from '../core/lab.js';
import { WORKSPACES, STEPS, lab, session, teardownSession } from '../lab/common.js';
export const title = 'Experimental laboratory';

export async function render(root, arg) {
  const L = lab(), ws = WORKSPACES.find(w => w.id === arg);
  root.append(h('h1', {}, 'Experimental Science & Discovery Laboratory'),
    h('p', { class: 'muted', style: 'max-width:980px' }, 'Design, simulate, construct, instrument, conduct, analyse and reproduce THERMA-X100 experiments from one place. Virtual results are model predictions (provenance “hypothetical”); only streams from real, calibrated instruments are recorded as “measured”; calibrated parameters are fitted to measurements without replacing them.'));
  root.append(workflowStrip(ws), subNav(ws));
  const body = h('div', { style: 'margin-top:12px' }); root.append(body);
  let child = null;
  if (!ws) overview(body, L);
  else {
    const sp = spinner(`Opening ${ws.label}…`); body.append(sp);
    try {
      const mod = await import(`../lab/${ws.id}.js`); sp.remove();
      body.append(h('div', { class: 'suite-group', style: 'margin-bottom:4px' }, `Workspace ${ws.n} of 12 · ${ws.icon} ${ws.label}`), h('p', { class: 'small muted', style: 'margin:0 0 10px' }, ws.d));
      child = await mod.render(body, { go: (id) => { location.hash = `#/lab/${id}`; } });
    } catch (e) { sp.remove(); body.append(errorBox(e)); }
  }
  return {
    dispose() {
      try { child?.dispose?.(); } catch (e) { console.error(e); }
      // keep a live acquisition across workspace switches; leaving the laboratory commands the safe state and closes it
      setTimeout(() => { if (!/^#\/lab(\/|$)/.test(location.hash) && (session.source || session.acq)) teardownSession('operator left the laboratory'); }, 0);
    },
  };
}

function workflowStrip(ws) {
  const cur = ws?.step;
  return h('nav', { 'aria-label': 'Experiment workflow', style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0' },
    ...STEPS.flatMap(([id, label, target], i) => [i ? h('span', { class: 'muted', 'aria-hidden': 'true' }, '→') : null,
      h('a', { href: `#/lab/${target}`, class: 'chip', style: id === cur ? 'border-color:var(--accent);color:var(--fg);font-weight:600' : '' }, `${i + 1} · ${label}`)]).filter(Boolean));
}
function subNav(ws) {
  return h('div', { style: 'display:flex;gap:6px;overflow-x:auto;padding:4px 0 8px;-webkit-overflow-scrolling:touch', role: 'tablist' },
    h('a', { href: '#/lab', class: 'btn sm' + (!ws ? ' primary' : ''), role: 'tab' }, '⌂ Overview'),
    ...WORKSPACES.map(w => h('a', { href: `#/lab/${w.id}`, class: 'btn sm' + (ws?.id === w.id ? ' primary' : ''), role: 'tab', title: w.label, style: 'white-space:nowrap' }, `${w.icon} ${w.n}. ${w.short}`)));
}

function overview(el, L) {
  const types = [
    ['🖥 Virtual experiments', 'warn', 'A released or draft protocol is executed on the shared physical models (ribbon-cell transient, quasi-static work loop, tensile, DSC, whole-engine). Output uses exactly the same dataset schema as a laboratory run, so the analysis chain can be rehearsed before hardware exists — but every value is labelled hypothetical and never earns validation credit.', 'virtual'],
    ['⚗ Physical experiments', 'ok', 'Instrumented hardware (load cell, LVDT, thermocouples/RTDs, flow, pressure, torque, encoder) streams through Web Serial, WebUSB or Web Bluetooth with a configurable line protocol. Recordings are “measured” only when they come from a real connected source with registered instruments; commands require an armed operator, limits and independent hardware interlocks.', 'daq'],
    ['⇄ Hybrid experiments', 'cred', 'Measured channels drive the models (e.g. measured temperature and force replayed through the constitutive law to predict displacement), the twin is calibrated by Levenberg–Marquardt and tracked by a Kalman filter. Measured columns stay untouched; model columns are tagged as calculated.', 'twin'],
  ];
  el.append(h('div', { class: 'suite-grid' }, ...types.map(([t, cls, d, go]) => h('a', { class: 'suite-card', href: `#/lab/${go}` }, h('div', { class: 'top' }, h('span', { class: `badge ${cls}` }, t)), h('span', { class: 'd' }, d)))));
  const n = (c) => L[c].length, meas = L.datasets.filter(d => d.provenance === 'measured').length, lad = ladderStatus(L);
  el.append(h('section', { class: 'card', style: 'margin-top:14px' }, h('h3', { class: 'card-title' }, 'Laboratory status'),
    h('div', { class: 'kpis' }, ...[['Hypotheses', n('hypotheses')], ['Protocols (released)', `${n('protocols')} (${L.protocols.filter(p => p.status === 'released').length})`], ['Specimens', n('specimens')], ['Instruments', n('instruments')], ['Datasets (measured)', `${n('datasets')} (${meas})`], ['Run records', n('runs')]].map(([l, v]) => h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, l), h('div', { class: 'kpi-val' }, String(v))))),
    h('div', { class: 'small muted', style: 'margin-top:8px' }, 'Validation ladder (from measured datasets only):'),
    h('div', { class: 'ladder' }, ...lad.map(g => h('span', { class: g.status === 'pass' ? 'on' : '', title: `${g.title}: ${g.detail}` }, `${g.gate} ${g.status}`))),
    meas ? null : callout('info', 'No measured datasets yet: the specification’s first demonstrator (§41) is a single conservative cartridge — certified NiTi ribbon, adjustable preload, rigid load frame, separate hot and cold baths, calibrated force/displacement sensors and a calorimetric flow loop — tested across several reservoir conditions and cycle times to find where measured net work per cycle is strictly positive.')));
  el.append(h('div', { class: 'group-title' }, 'Workspaces'), h('div', { class: 'suite-grid' }, ...WORKSPACES.map(w => h('a', { class: 'suite-card', href: `#/lab/${w.id}` }, h('div', { class: 'top' }, h('span', { class: 'ic' }, w.icon), h('span', { class: 'no' }, `WORKSPACE ${String(w.n).padStart(2, '0')}`)), h('b', {}, w.label), h('span', { class: 'd' }, w.d)))));
  el.append(callout('warn', h('b', {}, 'Safety: '), HARDWARE_INTERLOCK_STATEMENT));
}
