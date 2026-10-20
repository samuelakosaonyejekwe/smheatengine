// Headless execution of suites in dependency order (used by the feasibility tests, scenarios and batch runs).
import { store, summarize, hashObj } from './state.js';
import { SUITES } from '../suites/index.js';
import { makeCtx, resolveParams } from './suite.js';

const cache = new Map();
export async function loadSuite(id) { if (cache.has(id)) return cache.get(id); const meta = SUITES.find(s => s.id === id); const def = { ...meta, ...(await meta.load()).default }; cache.set(id, def); return def; }

// Run one suite with its resolved (coupled) parameters plus optional overrides; publishes outputs.
export async function runSuite(id, overrides = {}, { persist = false, onProgress } = {}) {
  const def = await loadSuite(id); const ctx = makeCtx(def, onProgress);
  const { values } = resolveParams(def, ctx, false); const p = { ...values, ...overrides };
  if (persist) for (const [k, v] of Object.entries(overrides)) store.setParam(id, k, v, 'user');
  const t0 = performance.now(); const res = await def.run(p, ctx); res.elapsed = performance.now() - t0;
  for (const k of res.kpis || []) if (typeof k.value === 'number' && !Number.isFinite(k.value)) { k.value = Number.isNaN(k.value) ? 'not defined for these inputs' : (k.value > 0 ? 'unbounded (∞) — never reached' : '−∞'); k.unit = ''; k.status ||= 'warn'; } // same readable form as the suite page
  store.publish(id, res.outputs || {}, { credibility: res.credibility || 'Analytical screening', hash: hashObj(p), summary: summarize(res) });
  return { def, res, p };
}

// Run a chain; failures are captured per suite so the rest of the chain can continue with defaults.
export async function runChain(ids, overridesById = {}, { onStep } = {}) {
  const out = {};
  for (const [k, id] of ids.entries()) {
    onStep?.(id, k / ids.length, 'running');
    try { out[id] = await runSuite(id, overridesById[id] || {}); onStep?.(id, (k + 1) / ids.length, 'done'); }
    catch (e) { out[id] = { error: e.message || String(e) }; onStep?.(id, (k + 1) / ids.length, 'error: ' + e.message); }
    await new Promise(r => setTimeout(r, 0));
  }
  return out;
}
export const FEASIBILITY_CHAIN = ['s01', 's03', 's04', 's02', 's06', 's07', 's05', 's08', 's09', 's13', 's10', 's11', 's12', 's14', 's15', 's16', 's18', 's17', 's19', 's20', 's21', 's22'];
