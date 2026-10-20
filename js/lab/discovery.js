// Workspace 8 — material discovery & inverse experimental design: bounded search of alloy property space (A_f, thermal
// hysteresis, transformation strain, Clausius–Clapeyron slope) for the current reservoirs and stresses; predicted net work
// from the quasi-static loop, top candidates verified with the ribbon-cell transient; proposals saved as hypotheses.
import { h, table, callout, kpiGrid, recList, spinner, toast, provChip } from '../core/ui.js';
import { store } from '../core/state.js';
import { smaAlloys, get as getMat } from '../core/materials.js';
import { cellTransient } from '../core/sma.js';
import { discoverMaterials, synthAlloy, addRecord } from '../core/lab.js';
import { card, grid, field, numIn, selIn, btn, val, note, row, charts, f3 } from './common.js';

export async function render(el) {
  const d = store.project.engine, C = charts();
  const base = selIn(smaAlloys().map(m => [m.id, m.name]), d.alloy), Th = numIn(d.Th), Tc = numIn(d.Tc), sL = numIn(d.sigmaL), sH = numIn(d.sigmaH);
  const B = { Af: [numIn(d.Tc + 15), numIn(d.Th - 3)], hyst: [numIn(5), numIn(35)], epsL: [numIn(0.02, { step: 0.005 }), numIn(0.06, { step: 0.005 })], CA: [numIn(5), numIn(14)] };
  const n = numIn(150, { step: 10 }), obj = selIn([['work', 'Maximise net work per kg'], ['efficiency', 'Maximise material efficiency']], 'work');
  el.append(card('Search space (physically bounded)', note('Bounds default to what the reservoirs allow: A_f between T_c + 15 K and T_h − 3 K, thermal hysteresis 5–35 K (NiTiCu-like to binary NiTi), transformation strain 2–6 %, stress-rate 5–14 MPa/K. Candidates are synthesised from the base card (elastic, thermal and fatigue data kept) and every result is a model prediction.'),
    grid(field('Base alloy card', base), field('T_h (°C)', Th), field('T_c (°C)', Tc), field('σ_L reset (MPa)', sL), field('σ_H stroke (MPa)', sH), field('Samples', n), field('Objective', obj)),
    table(['Property', 'Lower', 'Upper', 'Unit'], [['A_f', ...B.Af, '°C'], ['Thermal hysteresis (A_s − M_f)', ...B.hyst, 'K'], ['Transformation strain ε_L', ...B.epsL, '-'], ['C_A = dσ/dT', ...B.CA, 'MPa/K']]),
    row(btn('🧭 Search', () => go(), 'primary'))));
  const out = h('div'); el.append(out);
  async function go() {
    out.innerHTML = ''; C.dispose(); out.append(spinner('Evaluating candidates…')); await new Promise(r => setTimeout(r, 30));
    const m0 = getMat(base.value), bounds = Object.fromEntries(Object.entries(B).map(([k, [a, b]]) => [k, [val(a), val(b)]]));
    let R; try { R = discoverMaterials({ base: m0, Th: val(Th), Tc: val(Tc), sigmaL: val(sL), sigmaH: val(sH), bounds, n: Math.min(600, val(n)), objective: obj.value }); } catch (e) { out.innerHTML = ''; out.append(callout('fail', e.message)); return; }
    out.innerHTML = '';
    const top = R.candidates.filter(c => c.feasible).slice(0, 10), baseRes = discoverMaterials({ base: m0, Th: val(Th), Tc: val(Tc), sigmaL: val(sL), sigmaH: val(sH), bounds: { Af: [m0.Af, m0.Af + 1e-6], hyst: [m0.As - m0.Mf, m0.As - m0.Mf + 1e-6], epsL: [m0.epsL, m0.epsL + 1e-9], CA: [m0.CA, m0.CA + 1e-9] }, n: 1 }).candidates[0];
    const c = card('Predicted candidates', callout('warn', h('b', {}, 'Predictions, not materials. '), 'These are property targets for hypothetical alloys; whether a composition and process route can reach them must be established by V0 characterisation (DSC + tensile) of real lots.'));
    c.append(kpiGrid([{ label: 'Feasible candidates', value: `${R.feasibleCount} / ${R.candidates.length}`, explain: 'Feasible: the hot source exceeds A_f(σ_H) and the cold sink is below M_f(σ_L), so both transformations complete.', prov: 'hypothetical' }, { label: 'Best predicted net work', value: top[0]?.w_J_kg, unit: 'J/kg', explain: 'Quasi-static loop work density of the best feasible candidate (upper bound; the transient cell reduces it).', prov: 'hypothetical' }, { label: `Base card (${m0.id})`, value: baseRes.w_J_kg, unit: 'J/kg', explain: `Same evaluation for the base alloy (${baseRes.feasible ? 'feasible' : 'not feasible'} at these conditions).`, prov: 'hypothetical' }, { label: 'Carnot limit', value: R.etaC * 100, unit: '%', explain: 'No candidate can exceed it.', prov: 'calc' }]));
    const cg = C.grid(); c.append(cg);
    const F = R.candidates.filter(x => x.feasible), I = R.candidates.filter(x => !x.feasible);
    C.add(cg, { type: 'scatter', title: 'Net work vs A_f', x: { label: 'A_f', unit: '°C' }, y: { label: 'net loop work', unit: 'J/kg' }, series: [{ name: 'feasible', x: F.map(x => x.Af), y: F.map(x => x.w_J_kg), mode: 'markers' }, { name: 'infeasible', x: I.map(x => x.Af), y: I.map(x => x.w_J_kg), mode: 'markers' }], explain: 'Each point is a hypothetical alloy. Too low an A_f wastes the stress window; too high and the hot source cannot finish the reverse transformation under σ_H (infeasible).' });
    C.add(cg, { type: 'scatter', title: 'Net work vs thermal hysteresis', x: { label: 'hysteresis', unit: 'K' }, y: { label: 'net loop work', unit: 'J/kg' }, series: [{ name: 'feasible', x: F.map(x => x.hyst), y: F.map(x => x.w_J_kg), mode: 'markers' }], explain: 'Lower hysteresis leaves more of the reservoir span for the stress shift (σ_H − σ_L)/C, which is what produces net work.' });
    C.add(cg, { type: 'scatter', title: 'Efficiency vs transformation strain', x: { label: 'ε_L', unit: '-' }, y: { label: 'material efficiency', unit: '%' }, series: [{ name: 'feasible', x: F.map(x => x.epsL), y: F.map(x => x.eta * 100), mode: 'markers' }], explain: 'Larger recoverable strain raises the loop area per unit latent heat absorbed.' });
    const verifyBox = h('div');
    c.append(h('h4', {}, 'Top feasible candidates'), table(['#', 'A_f °C', 'M_f °C', 'Hyst. K', 'ε_L', 'C_A MPa/K', 'Margins hot/cold K', 'Net J/kg', 'η %', '% Carnot', 'Nearest library alloy', 'Prov.', ''], top.map((x, i) => [i + 1, f3(x.Af), f3(x.Mf), f3(x.hyst), f3(x.epsL), f3(x.CA), `${f3(x.margins.hot)} / ${f3(x.margins.cold)}`, f3(x.w_J_kg), f3(x.eta * 100), f3(x.carnotFraction * 100), nearest(x), provChip('hypothetical'), btn('→ hypothesis', () => propose(x, m0), 'sm')])), row(btn('🔬 Verify top 3 with the ribbon-cell transient', () => verify(top.slice(0, 3), m0, verifyBox))), verifyBox);
    const recs = [];
    if (!R.feasibleCount) recs.push({ level: 'critical', text: 'No feasible candidate: the reservoir span is too small for the stress window. Widen T_h − T_c or reduce σ_H − σ_L.', basis: `T_h − T_c = ${val(Th) - val(Tc)} K` });
    if (top[0] && baseRes.w_J_kg > 0) recs.push({ level: 'info', text: `Best candidate predicts ${f3(top[0].w_J_kg / baseRes.w_J_kg)}× the base card's loop work; test the trend with existing NiTiCu / NiTi lots first before commissioning new compositions.`, basis: 'quasi-static model' });
    recs.push({ level: 'sustain', text: 'Prefer candidates reachable by heat-treatment or Cu substitution of binary NiTi over Hf/Pd-containing alloys (lower embodied CO₂ and cost).', basis: 'materials library cost and CO₂ data' });
    c.append(h('h4', {}, 'Recommendations'), recList(recs)); out.append(c);
  }
  function verify(list, m0, box) {
    box.innerHTML = ''; const rows = [];
    for (const x of list) { const m = synthAlloy(m0, x); try { const r = cellTransient({ mat: m, t: d.ribbonT, w: d.ribbonW, L: d.ribbonL, nRib: d.ribbonsPerCell, n: 3, Th: val(Th), Tc: val(Tc), hHot: d.hHot, hCold: d.hCold, hc: d.hContact, Cw: d.wallCapacity, period: 1 / d.freq, dutyHot: d.dutyHot, tSwitch: d.tSwitch, sBias0: val(sL), kBias: d.kBias, sLoad: Math.max(0, val(sH) - val(sL)), cycles: 3, stepsPerCycle: 160 }); rows.push([f3(x.Af), f3(x.hyst), f3(x.w_J_kg), f3(r.specificWork), f3(r.specificPower), f3(r.xiSwing), f3(r.eta * 100)]); } catch (e) { rows.push([f3(x.Af), f3(x.hyst), f3(x.w_J_kg), 'failed', e.message, '', '']); } }
    box.append(table(['A_f', 'Hyst.', 'Quasi-static J/kg', 'Transient net J/kg', 'Specific power W/kg', 'Δξ', 'η %'], rows), note(`Transient check at ${d.freq} Hz with the current cell geometry and heat-transfer coefficients: finite heating and cooling time usually remove a large part of the quasi-static loop work; candidates whose Δξ stays near 1 are the robust ones.`));
  }
  function propose(x, m0) {
    const hy = addRecord(store, 'hypotheses', { statement: `A ${m0.family || 'SMA'} ribbon with A_f ≈ ${f3(x.Af)} °C, thermal hysteresis ≈ ${f3(x.hyst)} K, ε_L ≈ ${f3(x.epsL * 100)} % and C_A ≈ ${f3(x.CA)} MPa/K delivers ≥ ${f3(x.w_J_kg * 0.5)} J/kg net loop work at ${val(Th)}/${val(Tc)} °C (half the quasi-static prediction).`, candidate: m0.id, metric: 'netWork', Th: val(Th), Tc: val(Tc), target: x, status: 'open', prov: 'hypothetical', name: `Property target A_f ${f3(x.Af)} °C / hyst ${f3(x.hyst)} K` });
    toast(`Hypothesis ${hy.id} created (prediction-based)`, 'ok');
  }
  return { dispose: () => C.dispose() };
}
function nearest(x) { let best = null; for (const m of smaAlloys()) { const dd = Math.hypot((m.Af - x.Af) / 20, ((m.As - m.Mf) - x.hyst) / 10, (m.epsL - x.epsL) / 0.02); if (!best || dd < best.d) best = { d: dd, id: m.id }; } return best ? `${best.id} (distance ${best.d.toFixed(2)})` : '—'; }
