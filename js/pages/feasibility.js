// Feasibility gate (master spec §26 automatic preprocessing, §33 validation ladder, §40 decision criteria):
// instant physical pre-screen, matched-condition reservoir scenarios and the complete 22-suite coupled chain.
import { h, section, callout, progressBar, table, toast, verdicts } from '../core/ui.js';
import { runChain } from '../core/pipeline.js';
import { store } from '../core/state.js';
import { SUITES } from '../suites/index.js';
import { fmt } from '../core/num.js';
import { chart } from '../core/chart.js';
import { preScreen, engineModel, designWith, REFERENCE_W_PER_KG } from '../core/engine.js';
export const title = 'Feasibility gate';

const CHAIN = ['s01', 's03', 's04', 's02', 's06', 's07', 's05', 's08', 's09', 's13', 's10', 's11', 's12', 's14', 's15', 's16', 's18', 's17', 's19', 's20', 's21', 's22'];
const SCEN = [
  ['LT-50', 'Low-grade 50 °C / 15 °C', { Th: 50, Tc: 15 }], ['LT-70', 'Reference 70 °C / 15 °C', { Th: 70, Tc: 15 }], ['LT-90', 'Upper LT 90 °C / 20 °C', { Th: 90, Tc: 20 }],
  ['LT-70-warm', 'Warm sink 70 °C / 30 °C', { Th: 70, Tc: 30 }], ['LT-70-noregen', 'Reference without regenerator', { Th: 70, Tc: 15, regenEff: 0 }], ['HT-190', 'HT 190 °C oil / 40 °C, NiTiHf', { Th: 190, Tc: 40, alloy: 'nitihf', sigmaL: 260, sigmaH: 360, hotFluid: 'fl-oil', freq: 0.5 }],
];
function resetChain() { for (const id of CHAIN) { const lk = store.locks(id), P = store.params(id), PV = store.prov(id); for (const k of Object.keys(P)) if (!lk[k]) { delete P[k]; delete PV[k]; } delete store.project.outputs[id]; } store.touch({ type: 'reset-chain' }); }

export async function render(root) {
  const d = designWith(store.project.engine);
  root.append(h('h1', {}, 'Feasibility gate & full coupled chain'), h('p', { class: 'muted', style: 'max-width:980px' }, 'Before any expensive analysis the software checks whether the case is physically possible: a real temperature difference, transformation temperatures reachable under the working stresses, a cold sink able to complete the reset, a reset stress able to re-extend the martensite and a heat source large enough for the target. Infeasible cases are reported as infeasible, never silently solved. The full chain then runs all 22 suites in dependency order with the current project, so every coupling is exercised.'));
  root.append(section('1 · Instant physical pre-screen (current engine design)', verdicts(preScreen(d))));
  const scenBox = h('div'); root.append(section('2 · Matched-condition reservoir scenarios (reference engine model)', h('p', { class: 'small muted' }, 'Same geometry, alloy (unless stated), loads and auxiliaries; only the reservoirs change — the only fair basis for comparison (spec §30, §34).'), scenBox));
  const prog = progressBar(), status = h('div', { class: 'small muted' }), results = h('div');
  const runBtn = h('button', { class: 'btn primary', onclick: () => go() }, '▶ Run all 22 suites');
  const resetChk = h('input', { type: 'checkbox', checked: false });
  root.append(section('3 · Complete coupled chain', h('div', { class: 'row gap wrap' }, runBtn, h('label', { class: 'small muted' }, resetChk, ' Reset unlocked chain inputs to automatic values first')), prog, status), results);

  setTimeout(() => {
    const rows = [], P = [], E = [], names = [];
    for (const [id, label, over] of SCEN) {
      const dd = designWith(store.project.engine, over); const flags = preScreen(dd); const fails = flags.filter(f => f.status === 'fail');
      let r = null; try { r = fails.length ? null : engineModel(dd, { n: 1, stepsPerCycle: 120, cycles: 3 }); } catch { r = null; }
      rows.push([id, label, fails.length ? h('span', { class: 'badge fail', title: fails.map(f => f.test).join('; ') }, 'infeasible') : r?.netPositive ? h('span', { class: 'badge ok' }, 'net positive') : h('span', { class: 'badge warn' }, 'net negative'), r ? fmt(r.Pgross, 3) : '—', r ? fmt(r.Paux, 3) : '—', r ? fmt(r.Pnet, 3) : '—', r ? fmt(r.pActive, 3) : '—', r ? fmt(r.eta * 100, 3) : '—', r ? fmt(r.carnotFraction * 100, 3) : '—', fails.map(f => f.test).join('; ') || '']);
      names.push(id); P.push(r ? r.Pnet : 0); E.push(r ? r.pActive : 0);
    }
    scenBox.append(table(['Scenario', 'Reservoirs', 'Status', 'Gross W', 'Aux W', 'Net W', 'Net W/kg (active)', 'η %', '% of Carnot', 'Infeasibility cause'], rows));
    const c = h('div'); scenBox.append(c);
    chart(c, { type: 'bar', title: 'Net specific power by scenario (active-SMA mass basis)', categories: names, series: [{ name: 'Net W/kg', values: E }], annotations: [{ type: 'hline', y: REFERENCE_W_PER_KG, label: 'published 36 W/kg reference' }], y: { label: 'W/kg' }, explain: 'Net shaft power after all auxiliaries divided by active SMA mass, for identical hardware under different reservoirs. Bars below zero mean pumping, valve and control loads exceed the converted work: the configuration consumes power. The line marks the published 36 W/kg reference (different system and test conditions; indicative only).' });
  }, 30);

  async function go() {
    runBtn.disabled = true; results.innerHTML = ''; if (resetChk.checked) resetChain();
    const t0 = performance.now();
    const out = await runChain(CHAIN, {}, { onStep: (id, f, msg) => { prog.set(f, `${id} ${msg}`); status.textContent = `${SUITES.find(s => s.id === id)?.title}: ${msg}`; } });
    const rows = []; let fails = 0, warns = 0;
    for (const id of CHAIN) {
      const s = SUITES.find(x => x.id === id), r = out[id];
      if (r?.error) { fails++; rows.push([h('a', { href: `#/suite/${id}` }, `${s.num} ${s.short}`), h('span', { class: 'badge fail' }, 'error'), '', '', r.error]); continue; }
      const v = r.res.verdicts || [], nf = v.filter(x => x.status === 'fail').length, nw = v.filter(x => x.status === 'warn').length, ck = (r.res.checks || []).filter(c => c.pass === false).length;
      fails += nf; warns += nw;
      rows.push([h('a', { href: `#/suite/${id}` }, `${String(s.num).padStart(2, '0')} ${s.short}`), h('span', { class: 'badge ' + (nf ? 'fail' : nw ? 'warn' : 'ok') }, nf ? `${nf} fail` : nw ? `${nw} warn` : 'pass'), `${(r.res.kpis || []).length} KPIs · ${(r.res.charts || []).length} plots`, ck ? `${ck} check(s) failed` : 'verified', String(r.res.headline || '').slice(0, 220)]);
    }
    const s18 = store.output('s18') || {}, s16 = store.output('s16') || {}, s22 = store.output('s22') || {};
    results.append(callout(fails ? 'warn' : 'ok', h('b', {}, `Chain completed in ${fmt((performance.now() - t0) / 1000, 3)} s. `), `${fails} failed and ${warns} warning verdicts across 22 suites. `, s18.Pnet_W !== undefined ? `Net shaft power ${fmt(s18.Pnet_W, 3)} W at ${fmt((s18.carnotFraction || 0) * 100, 3)} % of Carnot. ` : '', s16.life_cycles ? `Predicted median life ${fmt(s16.life_cycles, 3)} cycles. ` : '', s22.lcoe_USDkWh !== undefined ? `Levelized cost ${fmt(s22.lcoe_USDkWh, 3)} USD/kWh (mechanical).` : ''));
    results.append(section('Suite-by-suite outcome', table(['Suite', 'Verdicts', 'Outputs', 'Verification', 'Headline'], rows)));
    results.append(section('Decision gates (spec §33 / §40)', table(['Gate', 'Evidence required', 'Status in this software'], [
      ['V0 Material coupon & DSC', 'Measured phase temperatures, loops, uncertainty', (store.project.experiments.s03 || []).length ? 'data imported — see Suite 03' : 'library values only — measurement required'],
      ['V1 Single ribbon', 'Repeatable contraction and lower-work reset', store.output('s05')?.Wout_J > 0 ? 'predicted positive (simulation)' : 'not yet predicted positive'],
      ['V2 Single cartridge with calorimetry', 'Positive NET closed-cycle work after reset and parasitics', (store.project.experiments.s19 || []).length ? 'test data imported — see Suite 19' : 'no physical evidence yet'],
      ['V3 Six or more phased cartridges', 'Continuous shaft rotation, measured positive average power', 'requires dynamometer data (Suite 19)'],
      ['V4 Regenerator integration', 'Measured efficiency gain at matched boundaries', store.output('s09')?.netBenefit_W > 0 ? 'predicted beneficial (simulation)' : 'not predicted beneficial'],
      ['V5 Endurance & off-design', 'Durability and safe operation under fault matrix', 'see Suites 15, 16 and 21 (predictions)'],
      ['V6 Independent benchmark', 'Matched-condition improvement with confidence intervals', 'requires independent test'],
    ])));
    toast('Feasibility chain complete', 'ok'); runBtn.disabled = false;
  }
}
