// UI kit: DOM helpers, parameter panels, KPI cards, verdicts, tables, tabs, toasts, modals.
import { fmt } from './num.js';
import { PROVENANCE } from './state.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k]; if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function provChip(p) { const d = PROVENANCE[p] || PROVENANCE.estimated; return h('span', { class: `prov ${d.cls}`, title: d.tip }, d.label); }

export function toast(msg, kind = 'info', ms = 3500) {
  let box = $('#toasts'); if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg); box.append(t); setTimeout(() => t.classList.add('out'), ms); setTimeout(() => t.remove(), ms + 400); return t;
}
export function modal(title, body, actions = []) {
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'modal-wrap', onclick: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-foot' }, ...actions.map(a => h('button', { class: `btn ${a.primary ? 'primary' : ''}`, onclick: () => { if (a.onClick?.() !== false) close(); } }, a.label))) : null));
  document.body.append(wrap); return { close };
}

export function tabs(defs, { active = 0, onChange } = {}) {
  const bar = h('div', { class: 'tabs', role: 'tablist' }), body = h('div', { class: 'tab-body' });
  const btns = defs.map((d, i) => h('button', { class: 'tab', role: 'tab', onclick: () => sel(i) }, d.icon ? h('span', { class: 'ti' }, d.icon) : null, d.label));
  bar.append(...btns);
  const rendered = new Map();
  const sel = (i) => {
    btns.forEach((b, j) => b.classList.toggle('on', i === j)); body.innerHTML = '';
    if (!rendered.has(i)) { const pane = h('div', { class: 'tab-pane' }); rendered.set(i, pane); try { defs[i].render(pane); } catch (e) { pane.append(errorBox(e)); } }
    body.append(rendered.get(i)); onChange?.(i);
  };
  const root = h('div', { class: 'tabset' }, bar, body); sel(Math.min(active, defs.length - 1));
  return { root, select: sel };
}

export function errorBox(e) { console.error(e); return h('div', { class: 'callout fail' }, h('b', {}, 'Computation error: '), String(e?.message || e), h('div', { class: 'small muted' }, 'The software reports failures instead of fabricating results. Check the inputs or solver settings.')); }

export function kpiGrid(kpis) {
  return h('div', { class: 'kpis' }, ...kpis.map(k => {
    const st = k.status ? ` ${k.status}` : '';
    return h('div', { class: 'kpi' + st, tabindex: 0 },
      h('div', { class: 'kpi-label' }, k.label, k.prov ? provChip(k.prov) : null),
      h('div', { class: 'kpi-val' }, typeof k.value === 'number' ? fmt(k.value, k.sig || 4) : (k.value ?? '—'), k.unit ? h('span', { class: 'kpi-unit' }, ' ' + k.unit) : null),
      k.explain ? h('div', { class: 'kpi-explain' }, k.explain) : null);
  }));
}

export function verdicts(list) {
  if (!list?.length) return h('div');
  return h('div', { class: 'verdicts' }, ...list.map(v => h('div', { class: `verdict ${v.status || (v.pass ? 'pass' : 'fail')}` },
    h('span', { class: 'vd-icon' }, { pass: '✔', fail: '✖', warn: '!', info: 'i' }[v.status || (v.pass ? 'pass' : 'fail')]),
    h('div', {}, h('div', { class: 'vd-title' }, v.test), h('div', { class: 'vd-detail' }, v.detail || '')))));
}

export function table(cols, rows, { caption, compact, numeric = true } = {}) {
  const t = h('table', { class: 'tbl' + (compact ? ' compact' : '') });
  if (caption) t.append(h('caption', {}, caption));
  t.append(h('thead', {}, h('tr', {}, ...cols.map(c => h('th', {}, typeof c === 'string' ? c : c.label)))));
  const tb = h('tbody'); for (const r of rows) tb.append(h('tr', {}, ...r.map(c => h('td', { class: typeof c === 'number' ? 'num' : '' }, c instanceof Node ? c : (typeof c === 'number' && numeric ? fmt(c, 4) : c ?? '')))));
  t.append(tb); return h('div', { class: 'tbl-wrap' }, t);
}

export function recList(recs) {
  if (!recs?.length) return h('p', { class: 'muted' }, 'No recommendations generated yet — run the analysis.');
  return h('ul', { class: 'recs' }, ...recs.map(r => h('li', { class: `rec ${r.level || 'info'}` }, h('span', { class: 'rec-tag' }, { critical: 'Critical', warn: 'Improve', info: 'Consider', good: 'Good practice', sustain: 'Sustainability', econ: 'Economics' }[r.level] || 'Note'), h('span', {}, r.text), r.basis ? h('div', { class: 'rec-basis' }, 'Basis: ', r.basis) : null)));
}

// Parameter control. def: {key,label,unit,type:'number'|'range'|'select'|'bool'|'text',min,max,step,options,help,group}
export function paramControl(def, value, prov, locked, onChange, onLock) {
  const id = 'p_' + def.key + '_' + Math.random().toString(36).slice(2, 6);
  let input;
  if (def.type === 'select') {
    input = h('select', { id, onchange: (e) => onChange(isNum(def) ? +e.target.value : e.target.value) }, ...(def.options || []).map(o => { const v = typeof o === 'object' ? o.value : o, l = typeof o === 'object' ? o.label : o; return h('option', { value: v, selected: String(v) === String(value) }, l); }));
  } else if (def.type === 'bool') {
    input = h('input', { id, type: 'checkbox', checked: !!value, onchange: (e) => onChange(e.target.checked) });
  } else if (def.type === 'text') {
    input = h('input', { id, type: 'text', value: value ?? '', onchange: (e) => onChange(e.target.value) });
  } else {
    const num = h('input', { id, type: 'number', value, min: def.min, max: def.max, step: def.step || 'any', inputmode: 'decimal', onchange: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { rng.value = v; onChange(v); } } });
    const rng = h('input', { type: 'range', value, min: def.min, max: def.max, step: def.step || (def.max - def.min) / 200, 'aria-label': def.label, oninput: (e) => { num.value = e.target.value; }, onchange: (e) => onChange(parseFloat(e.target.value)) });
    input = h('div', { class: 'num-range' }, rng, num);
  }
  const lockBtn = h('button', { class: 'icon-btn sm lock' + (locked ? ' on' : ''), title: locked ? 'Locked: automatic generation will not change this value' : 'Lock this value against automatic regeneration', onclick: () => onLock(!locked) }, locked ? '🔒' : '🔓');
  return h('div', { class: 'param' + (def.expert ? ' expert' : '') },
    h('label', { for: id }, h('span', { class: 'pl' }, def.label), def.unit ? h('span', { class: 'pu' }, def.unit) : null, prov ? provChip(prov) : null, lockBtn),
    input, def.help ? h('div', { class: 'ph' }, def.help) : null);
}
const isNum = (def) => (def.options || []).every(o => typeof (typeof o === 'object' ? o.value : o) === 'number');

export function section(title, ...kids) { return h('section', { class: 'card' }, title ? h('h3', { class: 'card-title' }, title) : null, ...kids); }
export function callout(kind, ...kids) { return h('div', { class: `callout ${kind}` }, ...kids); }
export function spinner(msg = 'Computing…') { return h('div', { class: 'spinner-wrap' }, h('div', { class: 'spinner' }), h('span', {}, msg)); }
export function progressBar() { const bar = h('div', { class: 'prog' }, h('div', { class: 'prog-fill' })); bar.set = (f, msg) => { bar.firstChild.style.width = (100 * Math.max(0, Math.min(1, f))).toFixed(1) + '%'; bar.title = msg || ''; }; return bar; }
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const nextFrame = () => new Promise(r => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
