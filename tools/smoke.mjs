// Headless smoke run of one or more suites with automatic inputs: node tools/smoke.mjs [s01 s05 …]
// Prints headline, KPIs, verdicts and verification checks; exits non-zero on exceptions or NaN KPIs.
globalThis.localStorage ??= { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
globalThis.sessionStorage ??= globalThis.localStorage;
const { runSuite } = await import('../js/core/pipeline.js');
const { SUITES } = await import('../js/suites/index.js');
const ids = process.argv.slice(2).length ? process.argv.slice(2) : SUITES.map(s => s.id);
let bad = 0;
for (const id of ids) {
  const t0 = Date.now();
  try {
    const { res } = await runSuite(id);
    const nanK = (res.kpis || []).filter(k => typeof k.value === 'number' && !Number.isFinite(k.value));
    console.log(`\n=== ${id} (${Date.now() - t0} ms) ${res.headline ? '— ' + String(res.headline).slice(0, 160) : ''}`);
    for (const k of res.kpis || []) console.log(`  KPI ${k.label}: ${typeof k.value === 'number' ? +k.value.toPrecision(4) : k.value} ${k.unit || ''}${k.explain ? '' : '  [NO EXPLAIN]'}`);
    for (const v of res.verdicts || []) console.log(`  ${String(v.status).toUpperCase().padEnd(4)} ${v.test}`);
    for (const c of res.checks || []) console.log(`  CHECK ${c.pass === undefined ? 'info' : c.pass ? 'pass' : 'FAIL'} ${c.name}: ${typeof c.value === 'number' ? +c.value.toPrecision(4) : c.value ?? ''}`);
    const noExplain = (res.charts || []).filter(c => !c.explain).length; if (noExplain) console.log(`  [${noExplain} charts without explain]`);
    console.log(`  charts ${(res.charts || []).length} · tables ${(res.tables || []).length} · recs ${(res.recs || []).length} · views ${(res.views || []).length} · outputs ${Object.keys(res.outputs || {}).join(', ')}`);
    if (nanK.length) { bad++; console.log('  NaN KPIs: ' + nanK.map(k => k.label).join(', ')); }
  } catch (e) { bad++; console.log(`\n=== ${id} THREW: ${e.stack || e}`); }
}
process.exit(bad ? 1 : 0);
