// Project state: typed parameters, provenance, coupled outputs, dependency invalidation, revisions, persistence.
import { DEFAULT_ENGINE } from './engine.js';

export const PROVENANCE = {
  user: { label: 'User-specified', cls: 'p-user', tip: 'Directly chosen by the operator' },
  measured: { label: 'Measured', cls: 'p-meas', tip: 'Supplied by calibrated laboratory instruments (imported test data)' },
  certified: { label: 'Certified', cls: 'p-cert', tip: 'Verified value from a manufacturer certificate, accredited laboratory or standard' },
  library: { label: 'Library', cls: 'p-lib', tip: 'Representative handbook / literature value from the materials library (not lot-certified)' },
  imported: { label: 'Imported', cls: 'p-imp', tip: 'Obtained from CAD models, datasets, engineering databases or external files' },
  calc: { label: 'Calculated', cls: 'p-calc', tip: 'Derived from governing equations and other inputs' },
  generated: { label: 'Generated design', cls: 'p-gen', tip: 'Produced by CAD, optimisation or inverse-design algorithms' },
  estimated: { label: 'Estimated', cls: 'p-est', tip: 'Engineering approximation with explicit uncertainty' },
  calibrated: { label: 'Calibrated', cls: 'p-cal', tip: 'Fitted to experimental measurements' },
  hypothetical: { label: 'Hypothetical', cls: 'p-hyp', tip: 'Investigational assumption requiring validation' },
  unsupported: { label: 'Unsupported', cls: 'p-uns', tip: 'Insufficient information; cannot be used for validated claims' },
  live: { label: 'Live data', cls: 'p-live', tip: 'Retrieved from a live global data service (see Data Hub for source & timestamp)' },
  coupled: { label: 'Coupled', cls: 'p-coup', tip: 'Received from an upstream suite result' },
};
export const CREDIBILITY = ['Conceptual', 'Analytical screening', 'Numerically verified', 'Calibrated', 'Component validated', 'Subsystem validated', 'Full-system validated', 'Environmentally validated'];

const KEY = 'therma.project.v1';
const listeners = new Set();
let saveTimer = null;

function freshProject() {
  return {
    id: 'TX-' + Date.now().toString(36).toUpperCase(), name: 'THERMA-X100 baseline study', author: '', objective: 'Establish whether a THERMA-X100 cartridge and phased engine deliver strictly positive net shaft work, at what specific power, efficiency, life and cost — and why or why not.',
    revision: 1, created: new Date().toISOString(), modified: new Date().toISOString(),
    engine: { ...DEFAULT_ENGINE },
    site: { lat: 6.5244, lon: 3.3792, name: 'Lagos, Nigeria', elevation: 41, roughness: 'farmland, few hedges' },
    env: null,             // last ambient / site snapshot (live data)
    imports: {},           // portal datasets routed to suites
    materials: {},         // component -> material id assignment
    params: {},            // suiteId -> {key: value}
    prov: {},              // suiteId -> {key: provenance}
    locks: {},             // suiteId -> {key: true}
    modes: {},             // suiteId -> 'auto'|'guided'|'expert'|'import'
    outputs: {},           // suiteId -> {t, hash, credibility, data:{...}}
    experiments: {},       // suiteId -> imported experimental datasets
    history: [],           // immutable revision summaries
    scenario: 'live',
  };
}

export const store = {
  project: load(),
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(evt) { for (const fn of listeners) { try { fn(evt, this.project); } catch (e) { console.error(e); } } },
  touch(evt = { type: 'change' }) { this.project.modified = new Date().toISOString(); schedule(); this.emit(evt); },
  get engine() { return this.project.engine; },
  setEngine(patch, source = 'user') { Object.assign(this.project.engine, patch); this.invalidateAll(`engine design (${source})`); this.touch({ type: 'engine' }); },
  setSite(patch) { Object.assign(this.project.site, patch); for (const id of ['s07', 's22']) this.invalidate(id, 'site changed'); this.touch({ type: 'site' }); },
  params(id) { return (this.project.params[id] ||= {}); },
  prov(id) { return (this.project.prov[id] ||= {}); },
  locks(id) { return (this.project.locks[id] ||= {}); },
  mode(id) { return this.project.modes[id] || 'auto'; },
  setMode(id, m) { this.project.modes[id] = m; this.touch({ type: 'mode', id }); },
  autoKeys(id) { return ((this.project.autoKeys ||= {})[id] ||= {}); },
  setParam(id, key, value, prov = 'user') { this.params(id)[key] = value; this.prov(id)[key] = prov; if (prov === 'user') delete this.autoKeys(id)[key]; this.invalidate(id, `${key} changed`); this.touch({ type: 'param', id, key }); },
  setMaterial(component, matId) { this.project.materials[component] = matId; this.invalidateAll(`material of ${component}`); this.touch({ type: 'material', component }); },
  material(component, fallback) { return this.project.materials[component] || fallback; },
  publish(id, data, { credibility = 'Analytical screening', hash = '', summary = null } = {}) {
    this.project.outputs[id] = { t: Date.now(), hash, credibility, data, stale: false, summary };
    for (const d of dependents(id)) this.invalidate(d, `upstream ${id} re-computed`, false);
    this.touch({ type: 'output', id });
  },
  output(id) { return this.project.outputs[id]?.data || null; },
  outputMeta(id) { return this.project.outputs[id] || null; },
  invalidate(id, reason = '', cascade = true) {
    const o = this.project.outputs[id]; if (o && !o.stale) { o.stale = true; o.staleReason = reason; }
    if (cascade) for (const d of dependents(id)) { const od = this.project.outputs[d]; if (od && !od.stale) { od.stale = true; od.staleReason = `upstream ${id}: ${reason}`; } }
  },
  invalidateAll(reason) { for (const id of Object.keys(this.project.outputs)) this.invalidate(id, reason, false); },
  setEnv(env) { this.project.env = env; this.invalidate('s07', 'ambient updated'); this.touch({ type: 'env' }); },
  snapshot(note = '') {
    const p = this.project; p.history.push({ revision: p.revision, t: new Date().toISOString(), note, suites: Object.keys(p.outputs).length, engine: { ...p.engine } });
    p.revision++; this.touch({ type: 'revision' });
  },
  reset() { this.project = freshProject(); this.touch({ type: 'reset' }); },
  replace(obj) { this.project = Object.assign(freshProject(), obj); this.touch({ type: 'reset' }); },
  export() { return JSON.parse(JSON.stringify(this.project)); },
};

// Dependency graph between suites (who consumes whose outputs) — follows the EIGDAS supply register and the
// cross-module interlocks of the master specification §26 (materials → cartridge → thermal → transmission → shaft →
// fatigue → economics, with iterative coupling closed in Suite 14).
export const DEPENDS = {
  s01: [], s02: ['s01'], s03: [], s04: ['s03'], s05: ['s02', 's03', 's04'],
  s06: ['s01'], s07: ['s01', 's06'], s08: ['s02', 's03', 's05', 's06', 's07'], s09: ['s06', 's07', 's08'],
  s10: ['s02', 's05'], s11: ['s02', 's05', 's10'], s12: ['s05', 's08', 's11', 's13'], s13: ['s02', 's06', 's07', 's08'],
  s14: ['s03', 's04', 's05', 's08', 's10', 's11', 's12', 's13'], s15: ['s05', 's11', 's12', 's13', 's14'],
  s16: ['s03', 's05', 's10', 's14'], s17: ['s03', 's05', 's16', 's18'], s18: ['s06', 's07', 's09', 's11', 's13', 's14'],
  s19: ['s05', 's18'], s20: ['s02', 's03', 's05'], s21: ['s06', 's13', 's15', 's16'], s22: ['s03', 's16', 's18', 's20'],
};
export function dependents(id) { return Object.keys(DEPENDS).filter(k => DEPENDS[k].includes(id)); }

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = Object.assign(freshProject(), JSON.parse(raw));
      p.engine = { ...DEFAULT_ENGINE, ...(p.engine || {}) };
      return p;
    }
  } catch { /* storage blocked */ }
  return freshProject();
}
function schedule() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const full = JSON.stringify(store.project, (k, v) => (k === 'geometry' && v?.positions) ? undefined : v);
    try { localStorage.setItem(KEY, full); store.storageWarning = null; return; } catch { /* quota exceeded or storage blocked */ }
    // fall back: keep configuration, results and provenance, drop bulky imported data columns (kept in memory this session)
    try {
      const slim = JSON.stringify(store.project, (k, v) => (k === 'geometry' && v?.positions) ? undefined : (k === 'columns' || k === 'rows' || k === 'points') && (Array.isArray(v) ? v.length > 200 : typeof v === 'object') ? undefined : v);
      localStorage.setItem(KEY, slim);
      if (store.storageWarning !== 'slim') { store.storageWarning = 'slim'; store.emit({ type: 'storage', level: 'warn', msg: 'Device storage is nearly full: the project was saved without the large imported datasets. Export the project (Project page) to keep them.' }); }
    } catch { if (store.storageWarning !== 'none') { store.storageWarning = 'none'; store.emit({ type: 'storage', level: 'fail', msg: 'This browser is not allowing the project to be saved (private mode or storage blocked). Export the project from the Project page before closing.' }); } }
  }, 400);
}

// Compact record of a run for reports and the dossier: headline, leading KPIs, verdict and check counts
export function summarize(res) {
  const v = res.verdicts || [], c = res.checks || [];
  return { headline: typeof res.headline === 'string' ? res.headline : '', headlineKind: res.headlineKind || '',
    kpis: (res.kpis || []).slice(0, 12).map(k => ({ label: k.label, value: typeof k.value === 'number' ? +k.value.toPrecision(5) : String(k.value ?? ''), unit: k.unit || '', prov: k.prov || '', status: k.status || '' })),
    verdicts: v.map(x => ({ test: x.test, status: x.status || (x.pass ? 'pass' : 'fail'), fix: x.fix || '' })).slice(0, 30),
    checks: { total: c.length, failed: c.filter(x => x.pass === false).length }, recs: (res.recs || []).slice(0, 8).map(r => ({ level: r.level, text: r.text })) };
}
// Simple stable hash for reproducibility records
export function hashObj(o) { const s = JSON.stringify(o, Object.keys(o || {}).sort()); let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); }
