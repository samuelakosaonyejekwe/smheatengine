// Suite 03 — Materials library and alloy characterization.
// Library/datasheet browser, shape-memory alloy constitutive cards, property curves (phase diagram, simulated DSC,
// isothermal tensile loops), alloy screening for the project reservoirs, calibration of the card from imported DSC
// and tensile data (Levenberg–Marquardt), component material assignment and live element / price references.
import { MATERIALS, COMPONENTS, get as getMat, smaAlloys, families, indices } from '../core/materials.js';
import { linspace, fmt, trapz, polyfit, levenbergMarquardt, rng, argmax, clamp, min, max } from '../core/num.js';
import { phaseDiagram, dscSim, tensileTest, quasiStaticCycle, fatigueLife } from '../core/sma.js';
import { carnot } from '../core/heat.js';

const CARD_KEYS = ['Ms', 'Mf', 'As', 'Af', 'CM', 'CA', 'sigS', 'sigF', 'epsL', 'Lh', 'EA', 'EM', 'rho', 'cp', 'k'];
const CARD_UNITS = { Ms: '°C', Mf: '°C', As: '°C', Af: '°C', CM: 'MPa/K', CA: 'MPa/K', sigS: 'MPa', sigF: 'MPa', epsL: '–', Lh: 'J/kg', EA: 'GPa', EM: 'GPa', rho: 'kg/m³', cp: 'J/(kg·K)', k: 'W/(m·K)' };
const CARD_LABELS = { Ms: 'Martensite start M_s', Mf: 'Martensite finish M_f', As: 'Austenite start A_s', Af: 'Austenite finish A_f', CM: 'Stress coefficient C_M', CA: 'Stress coefficient C_A', sigS: 'Detwinning start σ_s', sigF: 'Detwinning finish σ_f', epsL: 'Max. recoverable strain ε_L', Lh: 'Latent heat L_h', EA: 'Austenite modulus E_A', EM: 'Martensite modulus E_M', rho: 'Density ρ', cp: 'Specific heat c_p', k: 'Conductivity k (austenite)' };
const TEMP_KEYS = ['Ms', 'Mf', 'As', 'Af'];
const USES = [...new Set(MATERIALS.flatMap(m => m.uses))].sort();
const tempUnc = (m) => Math.max(2, 0.2 * (m.unc || 10)); // K, library transformation-temperature band
const cardOf = (m) => Object.fromEntries(CARD_KEYS.map(k => [k, m[k]]));
const tick = (ctx) => Promise.resolve().then(() => ctx.yield()).catch(() => {});

// ---------- calibration kernels ----------
// cosine-kinetics transformation peak with unit area on [lo, hi] (matches the Brinson-type kinetics of the solver)
const peakShape = (T, lo, hi) => (T <= lo || T >= hi || hi <= lo) ? 0 : Math.PI / (2 * (hi - lo)) * Math.sin(Math.PI * (T - lo) / (hi - lo));
function fitPeak(T, q) {
  const idx = T.map((_, i) => i).sort((a, b) => T[a] - T[b]), x = idx.map(i => T[i]), y = idx.map(i => q[i]), n = x.length;
  const e = Math.max(3, Math.floor(n * 0.1)), xb = [...x.slice(0, e), ...x.slice(-e)], yb = [...y.slice(0, e), ...y.slice(-e)], bl = polyfit(xb, yb, 1);
  const r = y.map((v, i) => v - bl[0] - bl[1] * x[i]), ip = argmax(r.map(Math.abs)), Tp = x[ip], hm = Math.abs(r[ip]) / 2;
  let a = ip, b = ip; while (a > 0 && Math.abs(r[a]) > hm) a--; while (b < n - 1 && Math.abs(r[b]) > hm) b++;
  const w0 = Math.max(1.5 * (x[b] - x[a]), 3 * (x[1] - x[0]) || 1), A0 = trapz(r, x), Tm = 0.5 * (x[0] + x[n - 1]);
  const model = (T, p) => p[3] + p[4] * (T - Tm) + p[2] * peakShape(T, p[0], p[1]);
  const fit = levenbergMarquardt(model, x, y, [Tp - w0 / 2, Tp + w0 / 2, A0, bl[0] + bl[1] * Tm, bl[1]], { maxIt: 300 });
  return { lo: fit.p[0], hi: fit.p[1], A: fit.p[2], se: fit.se, rmse: fit.rmse, Tp, x, y, yfit: x.map(t => model(t, fit.p)), n };
}
// split a DSC record into heating and cooling runs by the sign of dT
function splitRuns(T, q) {
  const runs = []; let cur = null;
  for (let i = 1; i < T.length; i++) { const s = Math.sign(T[i] - T[i - 1]); if (!s) continue; if (!cur || cur.s !== s) { cur = { s, T: [T[i - 1]], q: [q[i - 1]] }; runs.push(cur); } cur.T.push(T[i]); cur.q.push(q[i]); }
  const longest = (s) => runs.filter(r => r.s === s && r.T.length >= 12).sort((a, b) => b.T.length - a.T.length)[0] || null;
  return { heat: longest(1), cool: longest(-1) };
}
export function calibrateDSC(T, q, { rate, mass }) {
  const { heat, cool } = splitRuns(T, q), out = {};
  if (heat) { const f = fitPeak(heat.T, heat.q); out.heat = f; out.As = f.lo; out.Af = f.hi; out.LhHeat = Math.abs(f.A) / 1000 / rate / mass; }
  if (cool) { const f = fitPeak(cool.T, cool.q); out.cool = f; out.Mf = f.lo; out.Ms = f.hi; out.LhCool = Math.abs(f.A) / 1000 / rate / mass; }
  const L = [out.LhHeat, out.LhCool].filter(Number.isFinite); out.Lh = L.length ? L.reduce((a, b) => a + b) / L.length : undefined;
  return out;
}
// trilinear (elastic → transformation/detwinning plateau → elastic) fit of the loading branch of an isothermal tensile test
export function calibrateTensile(eps, sig) {
  let e = eps.slice(), s = sig.slice(); const im = argmax(s); e = e.slice(0, im + 1); s = s.slice(0, im + 1);
  if (max(e) > 0.2) e = e.map(v => v / 100); // percent → fraction
  const n = e.length, smax = s[n - 1];
  let E0 = s[Math.min(3, n - 1)] / Math.max(1e-9, e[Math.min(3, n - 1)]), iy = n - 1;
  for (let i = 2; i < n; i++) if (e[i] > 0 && Math.abs(s[i] - E0 * e[i]) > 0.1 * s[i]) { iy = i; break; }
  if (iy >= 3) E0 = polyfit(e.slice(0, iy), s.slice(0, iy), 1)[1];
  const sp0 = s[Math.max(0, iy - 1)], et0 = clamp(max(e) - smax / E0, 1e-4, 0.12);
  const model = (x, p) => { const E = p[0] * 1e3, ep = p[1] / E, sp = p[1], et = p[3]; return x <= ep ? E * x : x <= ep + et ? sp + p[2] * (x - ep) : sp + p[2] * et + E * (x - ep - et); };
  const fit = levenbergMarquardt(model, e, s, [E0 / 1e3, sp0, Math.max(10, (smax - sp0) / Math.max(1e-3, et0) * 0.3), et0], { maxIt: 400, bounds: [[0.5, 400], [0, smax], [-1e3, 2e5], [0, 0.15]] });
  return { E: fit.p[0], sy: fit.p[1], H: fit.p[2], epsT: fit.p[3], se: fit.se, rmse: fit.rmse, e, s, sfit: e.map(x => model(x, fit.p)) };
}
const findCol = (header, re) => header.find(h => re.test(h));

function datasheetRows(m) {
  const skip = new Set(['id', 'name', 'processes', 'uses', 'fatigue', 'basquin', 'src', 'note']);
  const rows = Object.entries(m).filter(([k, v]) => !skip.has(k) && (typeof v === 'number' || typeof v === 'string')).map(([k, v]) => [CARD_LABELS[k] || k, v, CARD_UNITS[k] || '']);
  if (m.fatigue && typeof m.fatigue === 'object') rows.push(['Functional-fatigue law', `N = ${fmt(m.fatigue.N0, 3)}·(${m.fatigue.eps0}/ε)^${m.fatigue.a}·(${m.fatigue.sig0}/σ)^${m.fatigue.b}`, '']);
  rows.push(['Processes', (m.processes || []).join(', '), ''], ['Uses', (m.uses || []).join(', '), ''], ['Source', m.src || '', ''], ['Note', m.note || '', '']);
  return rows;
}
async function showDatasheet(m) {
  const { h, table, modal } = await import('../core/ui.js');
  modal(`Datasheet — ${m.name}`, h('div', {}, h('p', { class: 'small muted' }, `Evidence class: ${m.evidence} · uncertainty ±${m.unc} % · library value, not lot-certified.`), table(['Property', 'Value', 'Unit'], datasheetRows(m))));
}

export default {
  description: 'Interactive materials library with datasheets, shape-memory alloy constitutive cards, property curves (stress–temperature phase diagram, simulated DSC, isothermal tensile loops), alloy screening for the project reservoirs, and calibration of the alloy card from imported DSC and tensile data with uncertainty and an applicability interval.',
  literature: 'NiTi shape memory alloy DSC transformation temperatures calibration Clausius-Clapeyron latent heat',
  econ: true, sustain: true, credibility: 'Analytical screening',
  equations: [
    'Clausius–Clapeyron stress shift: M_s(σ) = M_s + σ/C_M, M_f(σ) = M_f + σ/C_M, A_s(σ) = A_s + σ/C_A, A_f(σ) = A_f + σ/C_A',
    '1-D Brinson-type law: ε = σ/E(ξ) + ε_L·ξ_s + α(T − T_ref), 1/E(ξ) = ξ/E_M + (1 − ξ)/E_A',
    'Cosine kinetics (heating): ξ = ξ₀/2·[cos(π(T − A_s)/(A_f − A_s)) + 1] ⇒ DSC peak q(T) ∝ (π/2Δ)·sin(π(T − A_s)/Δ), Δ = A_f − A_s',
    'Latent heat from a DSC run: L_h = ∫(q − q_baseline) dT / (β·m), β = heating rate',
    'Isothermal tensile loading: σ = E·ε (elastic), σ = σ_p + H·(ε − σ_p/E) on the plateau of length ε_t, then elastic again (trilinear)',
    'Isobaric two-stress work density w = −∮σ dε / ρ (quasi-static cycle between σ_L at T_c and σ_H at T_h)',
    'Screening feasibility: A_f(σ_H) ≤ T_h and M_f(σ_L) ≥ T_c; latent fraction L_h/(L_h + c_p·max(10, A_f − M_f))',
    'Material cost per watt: c_USD/kg / (w·f); embodied carbon per watt: c_CO₂/kg / (w·f)',
  ],
  methods: [
    'DSC calibration: runs split by the sign of dT; linear baseline from the first and last 10 % of each run; peak located by maximum |q − baseline| and half-maximum width; five-parameter Levenberg–Marquardt fit (onset, finish, area, baseline offset and slope) of the cosine-kinetics peak shape.',
    'Tensile calibration: loading branch to peak stress; initial modulus from the leading elastic points; four-parameter trilinear Levenberg–Marquardt fit (E, plateau onset σ_p, plateau slope H, transformation strain ε_t) with bounds.',
    'Standard errors from the Gauss–Newton covariance (s²·(JᵀJ)⁻¹); reported bands are ±2 standard errors (≈ 95 %).',
    'Self-test on synthetic data (simulated DSC of the library card plus seeded Gaussian noise) verifies that the calibration recovers known parameters; synthetic data are never presented as measurements.',
    'Screening uses the quasi-static isobaric cycle (sma.quasiStaticCycle) at the project reservoir temperatures and stresses for every library alloy.',
  ],
  assumptions: [
    'Library values are representative literature/handbook figures (“library”, not “certified”). Lot-specific values vary strongly with composition, cold work, heat treatment and training.',
    'Library transformation-temperature uncertainty is taken as ±max(2 K, 0.2 × library % uncertainty) K; other properties ±library %.',
    'Imported DSC heat flow is in mW for the stated sample mass and rate; stress in MPa; strain as fraction or percent (auto-detected).',
    'A tensile test below A_s calibrates E_M and σ_s; a test above A_f calibrates E_A and C_M from the stress-induced plateau (σ_p = C_M·(T − M_s)).',
    'The calibrated card is applicable only inside the temperature and stress range covered by the imported data; outside it the Clausius–Clapeyron extrapolation is flagged.',
  ],
  ibc: {
    initial: ['DSC: fully martensitic sample below M_f − 25 K at zero stress.', 'Tensile: martensite (T < A_s) or austenite (T > A_f) at zero stress before loading.', 'Isobaric cycle: prepared cold detwinned state at σ_L.'],
    boundary: ['DSC: prescribed linear temperature ramp β (heating then cooling), zero stress.', 'Tensile: stress-controlled monotonic load to σ_max then unload, isothermal.', 'Screening: hot state T_h at σ_H, cold state T_c at σ_L.'],
  },
  cvv: {
    calibration: ['DSC of the ribbon lot (ASTM F2004-type protocol): M_s, M_f, A_s, A_f, L_h, hysteresis.', 'Isothermal tensile loading/unloading at ≥ 3 temperatures and 2 rates: E_A, E_M, σ_s, σ_f, ε_L, C_M, C_A.', 'Thermal conductivity and specific heat (laser flash / DSC sapphire method).'],
    verification: ['Synthetic DSC recovery: |ΔT| < 1 K for M_s, M_f, A_s, A_f, |ΔL_h| < 3 %.', 'Synthetic tensile recovery: E within 3 % of E_M, σ_p between σ_s and σ_f.', 'Phase-diagram slopes reproduce 1/C_M and 1/C_A exactly.', 'Simulated DSC peaks lie inside their transformation intervals.'],
    validation: ['Independent cyclic thermal–force test of a ribbon (validation gate V1) compared with the calibrated card (Suites 04/05).'],
  },
  formats: { import: ['DSC CSV: temperature (°C), heat flow (mW) [heating and/or cooling runs]', 'Tensile CSV: strain (– or %), stress (MPa)', 'JSON material card'], export: ['Constitutive card JSON', 'Library CSV', 'Screening CSV', 'PNG/SVG/CSV plots'] },
  params: [
    { key: 'alloy', label: 'Alloy for the constitutive card', type: 'select', default: 'niti-lt', group: 'Alloy card', options: smaAlloys().map(m => ({ value: m.id, label: m.name })), auto: (ctx) => ({ value: ctx.engine.alloy, prov: 'calc' }), help: 'Defaults to the project alloy (Suite 01).' },
    { key: 'Th', label: 'Hot-source temperature', unit: '°C', type: 'number', default: 70, min: 0, max: 400, step: 1, group: 'Screening conditions', auto: (ctx) => ({ value: ctx.engine.Th, prov: 'calc' }) },
    { key: 'Tc', label: 'Cold-sink temperature', unit: '°C', type: 'number', default: 15, min: -40, max: 150, step: 1, group: 'Screening conditions', auto: (ctx) => ({ value: ctx.engine.Tc, prov: 'calc' }) },
    { key: 'sigmaH', label: 'Hot power-stroke stress σH', unit: 'MPa', type: 'number', default: 110, min: 0, max: 800, step: 5, group: 'Screening conditions', auto: (ctx) => ({ value: ctx.engine.sigmaH, prov: 'calc' }) },
    { key: 'sigmaL', label: 'Cold reset stress σL', unit: 'MPa', type: 'number', default: 70, min: 0, max: 600, step: 5, group: 'Screening conditions', auto: (ctx) => ({ value: ctx.engine.sigmaL, prov: 'calc' }) },
    { key: 'freq', label: 'Cycle frequency', unit: 'Hz', type: 'number', default: 1, min: 0.01, max: 50, step: 0.1, group: 'Screening conditions', auto: (ctx) => ({ value: ctx.engine.freq, prov: 'calc' }) },
    { key: 'libFamily', label: 'Library filter — family', type: 'select', default: 'all', group: 'Library view', options: ['all', ...families()] },
    { key: 'libUse', label: 'Library filter — use', type: 'select', default: 'all', group: 'Library view', options: ['all', ...USES] },
    { key: 'libSearch', label: 'Library search', type: 'text', default: '', group: 'Library view', help: 'Matches name, id, process or note.' },
    { key: 'dscRate', label: 'DSC heating/cooling rate', unit: 'K/min', type: 'number', default: 10, min: 0.5, max: 50, step: 0.5, group: 'Characterisation', help: 'Rate of the simulated DSC and of imported DSC runs.' },
    { key: 'dscMass', label: 'DSC sample mass', unit: 'mg', type: 'number', default: 20, min: 1, max: 200, step: 1, group: 'Characterisation' },
    { key: 'tensileSmax', label: 'Tensile test maximum stress', unit: 'MPa', type: 'number', default: 450, min: 50, max: 1200, step: 10, group: 'Characterisation' },
    { key: 'tensileT', label: 'Imported tensile-test temperature', unit: '°C', type: 'number', default: 20, min: -100, max: 300, step: 1, group: 'Characterisation', help: 'Below A_s: calibrates E_M and σ_s. Above A_f: calibrates E_A and C_M.' },
    { key: 'coverage', label: 'Uncertainty coverage factor k', type: 'number', default: 2, min: 1, max: 3, step: 0.5, group: 'Characterisation', expert: true },
    { key: 'noise', label: 'Self-test noise (fraction of DSC peak)', type: 'number', default: 0.02, min: 0, max: 0.2, step: 0.005, group: 'Verification (expert)', expert: true },
    { key: 'seed', label: 'Self-test random seed', type: 'number', default: 7, min: 1, max: 99999, step: 1, group: 'Verification (expert)', expert: true },
  ],
  presets: [
    { label: 'LT reservoirs 70/15 °C', values: { Th: 70, Tc: 15, sigmaH: 110, sigmaL: 70 } },
    { label: 'HT reservoirs 190/40 °C (NiTiHf)', values: { alloy: 'nitihf', Th: 190, Tc: 40, sigmaH: 360, sigmaL: 260, freq: 0.5 } },
    { label: 'Low-hysteresis NiTiCu', values: { alloy: 'niticu' } },
    { label: 'Brinson benchmark card', values: { alloy: 'niti-brinson' } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const lib = getMat(p.alloy);
    if (!lib || lib.family !== 'SMA') return { ...out, headline: `Unknown or non-SMA alloy “${p.alloy}”.`, headlineKind: 'fail', kpis: [{ label: 'Alloy', value: 'not found', explain: 'Select a shape-memory alloy from the library.', status: 'bad' }], outputs: {} };
    const rate = p.dscRate / 60, massDSC = p.dscMass * 1e-6, kc = p.coverage;

    // ---------- self-test of the calibration on synthetic data (simulated, seeded noise) ----------
    const R = rng(p.seed), sim = dscSim(lib, { rate, mass: massDSC, n: 400 });
    const qpk = Math.max(...sim.heat.map(r => Math.abs(r.q)), ...sim.cool.map(r => Math.abs(r.q)));
    const synT = [...sim.heat.map(r => r.T), ...sim.cool.map(r => r.T)], synQ = [...sim.heat.map(r => r.q), ...sim.cool.map(r => r.q)].map(q => q + R.normal(0, p.noise * qpk));
    const selfDSC = calibrateDSC(synT, synQ, { rate, mass: massDSC });
    const TmT = Math.min(lib.Mf - 10, lib.As - 15), tt = tensileTest(lib, { T: TmT, sMax: p.tensileSmax, n: 120, startPhase: 'martensite' });
    const selfTen = calibrateTensile(tt.path.map(r => r.e), tt.path.map(r => r.s + R.normal(0, 1)));
    await tick(ctx);

    // ---------- imported experimental data ----------
    const card = cardOf(lib), unc = Object.fromEntries(CARD_KEYS.map(k => [k, TEMP_KEYS.includes(k) ? tempUnc(lib) : Math.abs(card[k] || 0) * (lib.unc || 10) / 100]));
    const prov = Object.fromEntries(CARD_KEYS.map(k => [k, 'library']));
    const calib = { dsc: [], ten: [] }, Tdata = [], Sdata = [];
    for (const d of ctx.experiments || []) {
      if (!d.columns || !d.header) continue;
      const cT = findCol(d.header, /temp|^t(_?c)?$|°c|degc/i), cQ = findCol(d.header, /heat|flow|mw|dsc|^q$/i), cE = findCol(d.header, /strain|eps|ε/i), cS = findCol(d.header, /stress|sig|σ|mpa/i);
      if (cT && cQ) { const T = d.columns[cT].map(Number), q = d.columns[cQ].map(Number), ok = T.map((v, i) => Number.isFinite(v) && Number.isFinite(q[i])); const r = calibrateDSC(T.filter((_, i) => ok[i]), q.filter((_, i) => ok[i]), { rate, mass: massDSC }); calib.dsc.push({ name: d.name, use: d.use, r }); Tdata.push(...T.filter(Number.isFinite)); }
      else if (cE && cS) { const e = d.columns[cE].map(Number), s = d.columns[cS].map(Number), ok = e.map((v, i) => Number.isFinite(v) && Number.isFinite(s[i])); const r = calibrateTensile(e.filter((_, i) => ok[i]), s.filter((_, i) => ok[i])); calib.ten.push({ name: d.name, use: d.use, r }); Sdata.push(...s.filter(Number.isFinite)); }
    }
    const calDSC = calib.dsc.find(c => c.use !== 'validation') || null, calTen = calib.ten.find(c => c.use !== 'validation') || null;
    if (calDSC) {
      const r = calDSC.r;
      if (r.heat && Number.isFinite(r.As) && r.Af > r.As) { card.As = r.As; card.Af = r.Af; unc.As = kc * (r.heat.se[0] || 0); unc.Af = kc * (r.heat.se[1] || 0); prov.As = prov.Af = 'calibrated'; }
      if (r.cool && Number.isFinite(r.Mf) && r.Ms > r.Mf) { card.Mf = r.Mf; card.Ms = r.Ms; unc.Mf = kc * (r.cool.se[0] || 0); unc.Ms = kc * (r.cool.se[1] || 0); prov.Ms = prov.Mf = 'calibrated'; }
      if (Number.isFinite(r.Lh) && r.Lh > 0) { card.Lh = r.Lh; const f = r.heat || r.cool; unc.Lh = kc * r.Lh * Math.abs((f.se[2] || 0) / (f.A || 1)); prov.Lh = 'calibrated'; }
    }
    if (calTen) {
      const r = calTen.r;
      if (r.epsT > 0.005 && r.epsT < 0.12) { card.epsL = r.epsT; unc.epsL = kc * (r.se[3] || 0); prov.epsL = 'calibrated'; }
      if (!(r.E > 0 && Number.isFinite(r.sy))) { /* unusable fit: keep library values */ }
      else if (p.tensileT < card.As) { card.EM = r.E; unc.EM = kc * (r.se[0] || 0); card.sigS = r.sy; unc.sigS = kc * (r.se[1] || 0); prov.EM = prov.sigS = 'calibrated'; }
      else if (p.tensileT > card.Af) { card.EA = r.E; unc.EA = kc * (r.se[0] || 0); const dT = p.tensileT - card.Ms; if (dT > 1) { card.CM = r.sy / dT; unc.CM = kc * (r.se[1] || 0) / dT; prov.CM = 'calibrated'; } prov.EA = 'calibrated'; }
    }
    const calibrated = !!(calDSC || calTen), mat = { ...lib, ...card };

    // ---------- applicability interval ----------
    const sMaxLib = 0.4 * (lib.su || 1000);
    const applicability = calibrated ? { Tmin: Tdata.length ? min(Tdata) : Math.max(lib.Tmin, card.Mf - 30), Tmax: Tdata.length ? max(Tdata) : Math.min(lib.Tmax, card.Af + sMaxLib / card.CA + 30), sMax: Sdata.length ? max(Sdata) : sMaxLib, basis: 'range of imported data' }
      : { Tmin: Math.max(lib.Tmin, card.Mf - 30), Tmax: Math.min(lib.Tmax, card.Af + sMaxLib / card.CA + 30), sMax: sMaxLib, basis: 'library range: M_f − 30 K … A_f(σ_max) + 30 K, σ_max = 0.4·UTS' };
    const AfH = card.Af + p.sigmaH / card.CA, MfL = card.Mf + p.sigmaL / card.CM, AsH = card.As + p.sigmaH / card.CA, MsL = card.Ms + p.sigmaL / card.CM;
    const outside = p.Th > applicability.Tmax || p.Tc < applicability.Tmin || p.sigmaH > applicability.sMax;

    // ---------- property curves ----------
    const pd = phaseDiagram(mat, Math.max(p.sigmaH * 1.5, 200), 41);
    const dsc = dscSim(mat, { rate, mass: massDSC });
    const Ttens = [card.Mf - 10, 0.5 * (card.As + card.Af), card.Af + 10, card.Af + 30];
    const tens = Ttens.map(T => ({ T, r: tensileTest(mat, { T, sMax: p.tensileSmax, n: 100 }) }));
    const qsc = quasiStaticCycle(mat, { Th: p.Th, Tc: p.Tc, sH: p.sigmaH, sL: p.sigmaL, n: 80, cycles: 5 });
    await tick(ctx);

    // ---------- alloy screening for the project reservoirs ----------
    const etaC = carnot(p.Th, p.Tc);
    const screen = smaAlloys().map(m0 => {
      const m = m0.id === lib.id ? mat : m0, aH = m.Af + p.sigmaH / m.CA, sH = m.As + p.sigmaH / m.CA, fL = m.Mf + p.sigmaL / m.CM, sL = m.Ms + p.sigmaL / m.CM;
      const hot = p.Th >= aH ? 'pass' : p.Th > sH ? 'warn' : 'fail', cold = p.Tc <= fL ? 'pass' : p.Tc < sL ? 'warn' : 'fail', det = p.sigmaL >= (m.sigS ?? 0) ? 'pass' : 'warn', tmax = (m.Tmax ?? 999) >= p.Th ? 'pass' : 'fail';
      const all = [hot, cold, det, tmax], status = all.includes('fail') ? 'fail' : all.includes('warn') ? 'warn' : 'pass';
      const q = quasiStaticCycle(m, { Th: p.Th, Tc: p.Tc, sH: p.sigmaH, sL: p.sigmaL, n: 60, cycles: 4 }), w = Math.max(0, q.w_J_kg), P = w * p.freq;
      const life = fatigueLife(m, Math.max(1e-5, m.epsL * q.dXiHeat), p.sigmaH);
      return { m, aH, fL, hot, cold, status, w, eta: q.eta, cf: etaC > 0 ? q.eta / etaC : 0, latent: indices.latentFraction(m), usdW: P > 0 ? m.cost / P : Infinity, co2W: P > 0 ? m.co2 / P : Infinity, life, hyst: 0.5 * (m.As + m.Af) - 0.5 * (m.Ms + m.Mf) };
    });
    const order = { pass: 0, warn: 1, fail: 2 };
    screen.sort((a, b) => order[a.status] - order[b.status] || b.w - a.w);
    const rank = screen.findIndex(s => s.m.id === lib.id) + 1, me = screen[rank - 1];

    // ---------- verification checks ----------
    const dT = (a, b) => Math.abs(a - b);
    const sdOK = ['As', 'Af', 'Ms', 'Mf'].every(k => dT(selfDSC[k], lib[k]) < 1);
    out.checks.push(
      { name: 'Synthetic DSC recovers transformation temperatures', value: Math.max(...TEMP_KEYS.map(k => dT(selfDSC[k], lib[k]))), target: '< 1 K', pass: sdOK, detail: TEMP_KEYS.map(k => `${k}: ${fmt(selfDSC[k], 4)} vs ${lib[k]}`).join(', ') + ` (noise ${fmt(100 * p.noise, 3)} % of peak, simulated data).` },
      { name: 'Synthetic DSC recovers latent heat', value: Math.abs(selfDSC.Lh / lib.Lh - 1), target: '< 3 %', pass: Math.abs(selfDSC.Lh / lib.Lh - 1) < 0.03, detail: `${fmt(selfDSC.Lh, 4)} vs ${lib.Lh} J/kg` },
      { name: 'Synthetic tensile recovers martensite modulus', value: Math.abs(selfTen.E / lib.EM - 1), target: '< 3 %', pass: Math.abs(selfTen.E / lib.EM - 1) < 0.03, detail: `${fmt(selfTen.E, 4)} vs E_M = ${lib.EM} GPa at T = ${fmt(TmT, 3)} °C` },
      { name: 'Fitted plateau onset inside detwinning band', value: selfTen.sy, target: `${lib.sigS} … ${lib.sigF} MPa`, pass: selfTen.sy >= lib.sigS - 1 && selfTen.sy <= lib.sigF + 1, detail: 'The cosine detwinning gate makes the knee gradual; the fitted onset must fall between σ_s and σ_f.' },
      { name: 'Phase-diagram slopes reproduce 1/C_M and 1/C_A', value: Math.max(Math.abs((pd.Ms[40] - pd.Ms[0]) / pd.s[40] - 1 / mat.CM), Math.abs((pd.Af[40] - pd.Af[0]) / pd.s[40] - 1 / mat.CA)), target: '< 1e-12 K/MPa', pass: Math.abs((pd.Ms[40] - pd.Ms[0]) / pd.s[40] - 1 / mat.CM) < 1e-12 && Math.abs((pd.Af[40] - pd.Af[0]) / pd.s[40] - 1 / mat.CA) < 1e-12 },
      { name: 'Simulated DSC peaks inside transformation intervals', value: `A_p ${fmt(dsc.Ap, 4)}, M_p ${fmt(dsc.Mp, 4)} °C`, target: 'A_s ≤ A_p ≤ A_f, M_f ≤ M_p ≤ M_s', pass: dsc.Ap >= mat.As - 0.5 && dsc.Ap <= mat.Af + 0.5 && dsc.Mp >= mat.Mf - 0.5 && dsc.Mp <= mat.Ms + 0.5 },
      { name: 'Isobaric loop closure', value: qsc.closure, target: '< 1e-6', pass: qsc.closure < 1e-6, detail: 'Strain returns to its start after the last of five quasi-static cycles (shakedown of the first cycles excluded).' },
      { name: 'Card complete and finite', value: CARD_KEYS.filter(k => Number.isFinite(card[k])).length, target: `= ${CARD_KEYS.length}`, pass: CARD_KEYS.every(k => Number.isFinite(card[k])) },
    );
    for (const c of calib.dsc) out.checks.push({ name: `Imported DSC fit quality — ${c.name}`, value: Math.max(c.r.heat?.rmse || 0, c.r.cool?.rmse || 0), target: 'small vs peak', pass: undefined, detail: `${c.r.heat ? `heating A_s ${fmt(c.r.As, 4)}, A_f ${fmt(c.r.Af, 4)} °C` : 'no heating run'}; ${c.r.cool ? `cooling M_s ${fmt(c.r.Ms, 4)}, M_f ${fmt(c.r.Mf, 4)} °C` : 'no cooling run'}; L_h ${fmt(c.r.Lh, 4)} J/kg (${c.use}).` });
    for (const c of calib.ten) out.checks.push({ name: `Imported tensile fit quality — ${c.name}`, value: c.r.rmse, target: 'MPa', pass: undefined, detail: `E = ${fmt(c.r.E, 4)} GPa, plateau onset ${fmt(c.r.sy, 4)} MPa, H = ${fmt(c.r.H, 4)} MPa (${c.use}).` });

    // ---------- verdicts ----------
    out.verdicts.push({ test: 'Hot reservoir completes reverse transformation under σH', status: me.hot, detail: `A_f(σH = ${p.sigmaH} MPa) = ${fmt(AfH, 4)} ± ${fmt(unc.Af, 2)} °C vs T_h = ${p.Th} °C (A_s(σH) = ${fmt(AsH, 4)} °C).`, fix: `Lower σH below ${fmt((p.Th - 3 - card.Af) * card.CA, 3)} MPa, raise T_h, or choose an alloy with lower A_f (see ranking).` });
    out.verdicts.push({ test: 'Cold sink completes forward transformation under σL', status: me.cold, detail: `M_f(σL = ${p.sigmaL} MPa) = ${fmt(MfL, 4)} ± ${fmt(unc.Mf, 2)} °C vs T_c = ${p.Tc} °C (M_s(σL) = ${fmt(MsL, 4)} °C).`, fix: 'Lower T_c, reduce σL or choose an alloy with higher M_f.' });
    out.verdicts.push({ test: 'Operating point inside the applicability interval of the card', status: outside ? 'warn' : 'pass', detail: `Card valid for ${fmt(applicability.Tmin, 4)} … ${fmt(applicability.Tmax, 4)} °C and σ ≤ ${fmt(applicability.sMax, 4)} MPa (${applicability.basis}).`, fix: 'Extend the characterisation (DSC range, tensile stress) to cover the operating point before using the card for predictions there.' });
    out.verdicts.push({ test: 'Card evidence level', status: calibrated ? 'pass' : 'info', detail: calibrated ? `Calibrated from imported data (${[calDSC?.name, calTen?.name].filter(Boolean).join(', ')}); remaining values from the library.` : `Library card (${lib.evidence}, ±${lib.unc} %). Required measurements: DSC of the ribbon lot at ${p.dscRate} K/min (M_s, M_f, A_s, A_f, L_h); isothermal tensile loops below A_s and above A_f (E_M, σ_s, σ_f, E_A, C_M); conductivity and c_p.`, fix: calibrated ? undefined : 'Import DSC and tensile CSV files in “Import experimental data” mode.' });
    if (lib.evidence === 'hypothetical') out.verdicts.push({ test: 'Hypothetical material', status: 'warn', detail: `${lib.name} is a screening estimate with no engine-relevant data.`, fix: 'Use only for exploratory comparison until coupon data exist.' });

    // ---------- KPIs ----------
    out.kpis.push(
      { label: 'A_f at power-stroke stress', value: AfH, unit: '°C', status: me.hot === 'pass' ? 'ok' : me.hot === 'warn' ? 'warn' : 'bad', prov: prov.Af === 'calibrated' ? 'calibrated' : 'library', explain: `Austenite finish shifted by σH/C_A; must stay below the hot fluid (${p.Th} °C) for full contraction. Margin ${fmt(p.Th - AfH, 3)} K.` },
      { label: 'M_f at reset stress', value: MfL, unit: '°C', status: me.cold === 'pass' ? 'ok' : me.cold === 'warn' ? 'warn' : 'bad', prov: prov.Mf === 'calibrated' ? 'calibrated' : 'library', explain: `Martensite finish shifted by σL/C_M; must stay above the cold fluid (${p.Tc} °C) for full reset. Margin ${fmt(MfL - p.Tc, 3)} K.` },
      { label: 'Quasi-static net work density', value: qsc.w_J_kg, unit: 'J/kg', prov: 'calc', explain: 'Area of the ideal isobaric σ–ε loop per kg (no heat-transfer limits); the transient cartridge (Suite 05) delivers less.' },
      { label: 'Ideal cycle efficiency / Carnot', value: etaC > 0 ? qsc.eta / etaC : 0, unit: '–', prov: 'calc', explain: `Quasi-static efficiency ${fmt(100 * qsc.eta, 3)} % (latent + sensible heat without regeneration) relative to Carnot ${fmt(100 * etaC, 3)} %.` },
      { label: 'Thermal hysteresis', value: me.hyst, unit: 'K', prov: prov.As === 'calibrated' ? 'calibrated' : 'library', explain: 'Mid-austenite minus mid-martensite temperature; widens the temperature span needed per cycle and is dissipated as heat.' },
      { label: 'Material cost per watt (ideal)', value: me.usdW, unit: 'USD/W', prov: 'estimated', explain: 'Alloy price divided by quasi-static power per kg at the design frequency — a lower bound on active-material cost per watt.' },
      { label: 'Embodied carbon per watt (ideal)', value: me.co2W, unit: 'kg CO₂e/W', prov: 'library', explain: 'Cradle-to-gate alloy carbon per watt of ideal output.' },
      { label: 'Rank among library alloys', value: `${rank} of ${screen.length}`, status: me.status === 'pass' ? 'ok' : me.status === 'warn' ? 'warn' : 'bad', explain: 'Feasible alloys first, then by quasi-static work density at the project reservoirs and stresses.' },
      { label: 'Card status', value: calibrated ? 'calibrated' : 'library (uncalibrated)', status: calibrated ? 'ok' : 'warn', explain: 'Calibrated cards use imported DSC/tensile data for the fitted parameters; library cards are representative values only.' },
    );

    // ---------- charts ----------
    const Tax = linspace(Math.min(card.Mf, p.Tc) - 15, Math.max(AfH, p.Th) + 20, 80), sMaxPD = Math.max(p.sigmaH * 1.5, 200);
    const line = (T0, C, name, dash) => { const xs = Tax.filter(T => C * (T - T0) >= 0 && C * (T - T0) <= sMaxPD); const u = unc[name] ?? tempUnc(lib); return { name: `${name}(σ)`, x: xs, y: xs.map(T => C * (T - T0)), dash, band: { lo: xs.map(T => Math.max(0, C * (T - T0 - u))), hi: xs.map(T => C * (T - T0 + u)) } }; };
    out.charts.push({ type: 'line', title: `Stress–temperature phase diagram — ${lib.name}`, x: { label: 'Temperature', unit: '°C' }, y: { label: 'Stress', unit: 'MPa', min: 0, max: sMaxPD },
      series: [line(card.Mf, card.CM, 'Mf', '4 3'), line(card.Ms, card.CM, 'Ms'), line(card.As, card.CA, 'As'), line(card.Af, card.CA, 'Af', '4 3')],
      annotations: [{ type: 'vline', x: p.Th, label: 'T_h', color: '#ef4444' }, { type: 'vline', x: p.Tc, label: 'T_c', color: '#3b82f6' }, { type: 'point', x: p.Th, y: p.sigmaH, label: 'hot state (T_h, σH)', color: '#ef4444' }, { type: 'point', x: p.Tc, y: p.sigmaL, label: 'cold state (T_c, σL)', color: '#3b82f6' }, { type: 'band', y0: card.sigS, y1: card.sigF, color: '#a855f7', opacity: 0.08 }],
      explain: `Transformation lines shift to higher temperature with stress (slopes C_M = ${fmt(card.CM, 3)}, C_A = ${fmt(card.CA, 3)} MPa/K). Shaded bands are the ±${fmt(unc.Af, 2)} K card uncertainty; the violet band is the detwinning stress range. The hot state must lie right of A_f and the cold state left of M_f for complete transformation.` });
    const dscSeries = [{ name: 'Heating (simulated)', x: dsc.heat.map(r => r.T), y: dsc.heat.map(r => r.q), color: '#ef4444' }, { name: 'Cooling (simulated)', x: dsc.cool.map(r => r.T), y: dsc.cool.map(r => r.q), color: '#3b82f6' }];
    if (calDSC) { for (const [k, f] of [['heating', calDSC.r.heat], ['cooling', calDSC.r.cool]]) if (f) { dscSeries.push({ name: `Imported ${k} — ${calDSC.name}`, x: f.x, y: f.y, mode: 'markers', r: 2 }, { name: `Fitted ${k}`, x: f.x, y: f.yfit, dash: '4 3' }); } }
    out.charts.push({ type: 'line', title: `DSC thermogram — SIMULATED model output${calDSC ? ' with imported data' : ''}`, x: { label: 'Temperature', unit: '°C' }, y: { label: 'Heat flow', unit: 'mW' }, series: dscSeries,
      annotations: [{ type: 'vline', x: dsc.Ap, label: `A_p ${fmt(dsc.Ap, 3)}`, color: '#ef4444' }, { type: 'vline', x: dsc.Mp, label: `M_p ${fmt(dsc.Mp, 3)}`, color: '#3b82f6' }],
      explain: `Model-generated DSC trace (${dsc.unit}) from the card's kinetics — a simulation, not a measurement. Peak area divided by rate and mass gives L_h; peak separation ${fmt(dsc.hysteresis, 3)} K is the thermal hysteresis. ${calDSC ? 'Imported points and their fitted peaks are overlaid.' : 'Import a measured DSC run to calibrate the card.'}` });
    out.charts.push({ type: 'line', title: 'Isothermal tensile loops at several temperatures (model)', x: { label: 'Strain', unit: '%' }, y: { label: 'Stress', unit: 'MPa' },
      series: tens.map(({ T, r }) => ({ name: `T = ${fmt(T, 3)} °C`, x: r.path.map(q => 100 * q.e), y: r.path.map(q => q.s) })),
      explain: 'Below A_s the ribbon detwins at σ_s–σ_f and keeps the strain after unloading (recovered only on heating). Between A_s and A_f the response is partially superelastic. Above A_f stress induces martensite at σ = C_M·(T − M_s) and the strain recovers on unloading with a hysteresis loop whose area is dissipated energy.' });
    const feasCol = { pass: '#22c55e', warn: '#f59e0b', fail: '#ef4444' }, sc = screen.filter(s => Number.isFinite(s.usdW));
    out.charts.push({ type: 'scatter', title: 'Alloy screening at the project reservoirs: work density vs cost per watt', x: { label: 'Quasi-static net work density', unit: 'J/kg' }, y: { label: 'Material cost per watt', unit: 'USD/W', log: true },
      series: [{ name: 'Library alloys', x: sc.map(s => s.w), y: sc.map(s => s.usdW), colors: sc.map(s => feasCol[s.status]), labels: sc.map(s => s.m.id), r: 5 }],
      explain: `Each point is one library alloy cycled quasi-statically between ${p.Tc} °C/σL = ${p.sigmaL} MPa and ${p.Th} °C/σH = ${p.sigmaH} MPa at ${p.freq} Hz. Green: transformation completes on both sides; amber: partial; red: infeasible. Best candidates sit lower-right (high work, low cost per watt). Alloys producing no work are omitted.` });
    out.charts.push({ type: 'bar', title: 'Transformation margins at the operating stresses', categories: screen.map(s => s.m.id), series: [{ name: 'Hot margin T_h − A_f(σH)', values: screen.map(s => p.Th - s.aH), color: '#ef4444' }, { name: 'Cold margin M_f(σL) − T_c', values: screen.map(s => s.fL - p.Tc), color: '#3b82f6' }], y: { label: 'Margin', unit: 'K' },
      explain: 'Both margins must be positive (preferably > 3–5 K for uncertainty and kinetics) for complete transformation in each half-cycle. A negative hot margin means the ribbon never fully contracts; a negative cold margin means it never fully resets.' });
    const cmpKeys = ['Mf', 'Ms', 'As', 'Af'], sv = calibrated ? card : selfDSC;
    out.charts.push({ type: 'bar', title: calibrated ? 'Library vs calibrated transformation temperatures' : 'Library card vs recovered from synthetic DSC (self-test)', categories: cmpKeys, series: [{ name: 'Library', values: cmpKeys.map(k => lib[k]) }, { name: calibrated ? 'Calibrated' : 'Recovered (synthetic self-test)', values: cmpKeys.map(k => sv[k]) }], y: { label: 'Temperature', unit: '°C' }, showValues: true,
      explain: calibrated ? 'Shift of the fitted transformation temperatures relative to the library card; differences beyond the library band indicate lot-specific composition or heat treatment.' : 'With no imported data the calibration pipeline is exercised on a synthetic DSC trace generated from the library card plus noise; agreement verifies the fitting procedure, not the alloy.' });
    const tf = calTen ? calTen.r : selfTen;
    out.charts.push({ type: 'line', title: calTen ? `Tensile calibration — ${calTen.name}` : 'Tensile calibration self-test (synthetic, martensite)', x: { label: 'Strain', unit: '%' }, y: { label: 'Stress', unit: 'MPa' },
      series: [{ name: calTen ? 'Imported' : 'Synthetic (simulated + noise)', x: tf.e.map(v => 100 * v), y: tf.s, mode: 'markers', r: 2 }, { name: `Trilinear fit E = ${fmt(tf.E, 3)} GPa, σ_p = ${fmt(tf.sy, 3)} MPa, ε_t = ${fmt(100 * tf.epsT, 3)} %`, x: tf.e.map(v => 100 * v), y: tf.sfit }],
      explain: 'Levenberg–Marquardt trilinear fit of the loading branch: the initial slope is the elastic modulus, the first knee the onset of detwinning (below A_s) or of stress-induced martensite (above A_f), and the plateau length the transformation strain ε_t (estimate of ε_L).' });

    // ---------- tables ----------
    const libRows = MATERIALS.filter(m => (p.libFamily === 'all' || m.family === p.libFamily) && (p.libUse === 'all' || m.uses.includes(p.libUse)) && (!p.libSearch || JSON.stringify([m.id, m.name, m.processes, m.note]).toLowerCase().includes(String(p.libSearch).toLowerCase())));
    out.tables.push({ title: `Alloy constitutive card — ${lib.name}`, cols: ['Parameter', 'Value', '± (k = ' + kc + ')', 'Unit', 'Provenance'], rows: CARD_KEYS.map(k => [CARD_LABELS[k], card[k], unc[k], CARD_UNITS[k], prov[k]]), explain: `Card published to Suites 04/05. Library evidence class “${lib.evidence}”, source: ${lib.src}` });
    out.tables.push({ title: 'Alloy ranking for the project reservoirs', cols: ['#', 'Alloy', 'Status', 'A_f(σH) [°C]', 'M_f(σL) [°C]', 'w [J/kg]', 'η/η_C', 'Latent fraction', 'Hysteresis [K]', 'Life [cycles]', 'USD/W', 'kg CO₂e/W', 'Evidence'], rows: screen.map((s, i) => [i + 1, s.m.name, s.status.toUpperCase(), s.aH, s.fL, s.w, s.cf, s.latent, s.hyst, s.life, Number.isFinite(s.usdW) ? s.usdW : '—', Number.isFinite(s.co2W) ? s.co2W : '—', s.m.evidence]), explain: 'Quasi-static screening with identical reservoirs, stresses and frequency; life from the functional-fatigue trend at the transformed strain. Hypothetical/estimated alloys need coupon data before selection.' });
    out.tables.push({ title: `Materials library (${libRows.length} of ${MATERIALS.length} — filter: ${p.libFamily}/${p.libUse}${p.libSearch ? '/“' + p.libSearch + '”' : ''})`, cols: ['ID', 'Name', 'Family', 'ρ [kg/m³]', 'E [GPa]', 'k [W/m·K]', 'c_p [J/kg·K]', 'T_max [°C]', 'USD/kg', 'kg CO₂e/kg', '±%', 'Evidence'], rows: libRows.map(m => [m.id, m.name, m.family, m.rho, m.E ?? '—', m.k, m.cp, m.Tmax, m.cost, m.co2, m.unc, m.evidence]), explain: 'Representative library values (not lot-certified). Open the “Materials library” view for datasheets.' });
    out.tables.push({ title: 'Component material assignment', cols: ['Component', 'Assigned material', 'Owning suite', 'ρ', 'k', 'USD/kg'], rows: Object.entries(COMPONENTS).map(([k, c]) => { const m = ctx.material(k); return [c.name, m?.name || '—', c.suite, m?.rho ?? '—', m?.k ?? '—', m?.cost ?? '—']; }), explain: 'Change assignments in the “Component materials” view; changes invalidate all downstream results.' });
    out.tables.push({ title: 'Applicability interval and uncertainty', cols: ['Item', 'Value'], rows: [['T_min', `${fmt(applicability.Tmin, 4)} °C`], ['T_max', `${fmt(applicability.Tmax, 4)} °C`], ['σ_max', `${fmt(applicability.sMax, 4)} MPa`], ['Basis', applicability.basis], ['Temperature band (library)', `±${fmt(tempUnc(lib), 3)} K`], ['Property band (library)', `±${lib.unc} %`]], explain: 'Outside this interval the card is an extrapolation and predictions are flagged.' });

    // ---------- views ----------
    out.views.push({ label: 'Materials library', icon: '📚', render: (el) => libraryView(el, p) });
    out.views.push({ label: 'Component materials', icon: '🧩', render: (el, c) => componentView(el, c) });
    out.views.push({ label: 'Live element & price data', icon: '🌐', render: (el, c) => liveView(el, c, lib) });

    // ---------- narrative & recommendations ----------
    out.explain.push(
      { title: 'Card', text: `${lib.name}: M_f ${fmt(card.Mf, 4)}, M_s ${fmt(card.Ms, 4)}, A_s ${fmt(card.As, 4)}, A_f ${fmt(card.Af, 4)} °C; C_M ${fmt(card.CM, 3)}, C_A ${fmt(card.CA, 3)} MPa/K; ε_L ${card.epsL}; L_h ${fmt(card.Lh, 4)} J/kg. ${calibrated ? 'Fitted values replace the library values where imported data exist.' : 'All values are library values.'}` },
      { title: 'Fit for the project reservoirs', text: `Under σH = ${p.sigmaH} MPa the reverse transformation finishes at ${fmt(AfH, 4)} °C (hot fluid ${p.Th} °C); under σL = ${p.sigmaL} MPa the forward transformation finishes at ${fmt(MfL, 4)} °C (cold fluid ${p.Tc} °C). The ideal isobaric loop delivers ${fmt(qsc.w_J_kg, 4)} J/kg per cycle with ${fmt(100 * qsc.stroke, 3)} % strain stroke.` },
      { title: 'Simulated vs measured', text: 'DSC traces, tensile loops and phase diagrams on this page are model outputs of the card. Only imported datasets (Import mode) are measurements; they are labelled with their file names.' },
    );
    const bestAlt = screen.find(s => s.status === 'pass' && s.m.id !== lib.id);
    if (me.status !== 'pass') out.recs.push({ level: 'critical', text: `${lib.name} does not transform completely between ${p.Tc} and ${p.Th} °C at σL/σH = ${p.sigmaL}/${p.sigmaH} MPa (hot margin ${fmt(p.Th - AfH, 3)} K, cold margin ${fmt(MfL - p.Tc, 3)} K).${bestAlt ? ` ${bestAlt.m.name} is feasible with ${fmt(bestAlt.w, 3)} J/kg.` : ' No library alloy is fully feasible — adjust stresses or reservoir temperatures, or shift transformation temperatures by composition/heat treatment.'}`, basis: 'Clausius–Clapeyron shifted temperatures of this card' });
    else if (p.Th - AfH < 5 || MfL - p.Tc < 5) out.recs.push({ level: 'warn', text: `Transformation margins are thin (hot ${fmt(p.Th - AfH, 3)} K, cold ${fmt(MfL - p.Tc, 3)} K) compared with the ±${fmt(unc.Af, 2)} K card uncertainty; lot DSC is needed before committing the stress levels.`, basis: 'Margins vs card uncertainty' });
    if (!calibrated) out.recs.push({ level: 'info', text: `Order DSC (${p.dscRate} K/min, ${p.dscMass} mg) and isothermal tensile loops at ${fmt(card.Mf - 10, 3)}, ${fmt(0.5 * (card.As + card.Af), 3)} and ${fmt(card.Af + 20, 3)} °C on the ribbon lot to replace the ±${lib.unc} % library card.`, basis: 'Spec §31 calibration plan' });
    if (me.hyst > 15) out.recs.push({ level: 'info', text: `Hysteresis ${fmt(me.hyst, 3)} K consumes a large share of the ${p.Th - p.Tc} K reservoir span; a low-hysteresis NiTiCu grade (≈ 9 K) widens both margins.`, basis: 'Card hysteresis vs reservoir span' });
    const cheapest = screen.filter(s => s.status === 'pass' && Number.isFinite(s.usdW)).sort((a, b) => a.usdW - b.usdW)[0];
    if (cheapest) out.recs.push({ level: 'econ', text: `Lowest material cost per ideal watt among feasible alloys: ${cheapest.m.name} at ${fmt(cheapest.usdW, 3)} USD/W (selected alloy ${Number.isFinite(me.usdW) ? fmt(me.usdW, 3) + ' USD/W' : 'produces no work'}). Weigh against its evidence class “${cheapest.m.evidence}” and life ${fmt(cheapest.life, 3)} cycles.`, basis: 'Ranking table, library prices' });
    out.recs.push({ level: 'sustain', text: `${lib.name}: ${lib.co2} kg CO₂e/kg cradle-to-gate, recyclable fraction ${lib.recyclable}. ${Number.isFinite(me.co2W) ? `≈ ${fmt(me.co2W, 3)} kg CO₂e per ideal watt` : 'No work at these conditions'}; specify take-back of spent ribbons (Ni and Ti recovery) and prefer low-carbon Cu-based alloys only where their brittleness and ageing are acceptable.`, basis: 'Library embodied carbon' });

    const ok = me.status === 'pass';
    out.headline = `${lib.name}: ${ok ? 'transforms completely' : me.status === 'warn' ? 'transforms only partially' : 'does not transform'} between ${p.Tc} °C/σL ${p.sigmaL} MPa and ${p.Th} °C/σH ${p.sigmaH} MPa — A_f(σH) ${fmt(AfH, 3)} °C, M_f(σL) ${fmt(MfL, 3)} °C, ideal ${fmt(qsc.w_J_kg, 3)} J/kg; rank ${rank}/${screen.length}; card ${calibrated ? 'calibrated' : 'library (uncalibrated)'}.`;
    out.headlineKind = ok ? (calibrated ? 'ok' : 'info') : me.status === 'warn' ? 'warn' : 'fail';
    out.outputs = { alloyId: lib.id, card, uncertainty: unc, applicability, calibrated, cardProvenance: prov, ranking: screen.map(s => ({ id: s.m.id, status: s.status, w_J_kg: s.w })), wQS_J_kg: qsc.w_J_kg, temps: { AfH, MfL, AsH, MsL } };
    out.credibility = calibrated ? 'Calibrated' : 'Analytical screening';
    return out;
  },
};

// ---------- interactive views ----------
async function libraryView(el, p) {
  const { h, table } = await import('../core/ui.js');
  const fam = h('select', {}, ...['all', ...families()].map(f => h('option', { value: f, selected: f === p.libFamily }, f)));
  const use = h('select', {}, ...['all', ...USES].map(u => h('option', { value: u, selected: u === p.libUse }, u)));
  const q = h('input', { type: 'search', placeholder: 'Search name, id, process…', value: p.libSearch || '' });
  const box = h('div');
  const draw = () => {
    box.innerHTML = '';
    const rows = MATERIALS.filter(m => (fam.value === 'all' || m.family === fam.value) && (use.value === 'all' || m.uses.includes(use.value)) && (!q.value || JSON.stringify([m.id, m.name, m.processes, m.note]).toLowerCase().includes(q.value.toLowerCase())));
    box.append(h('div', { class: 'small muted' }, `${rows.length} materials. Click a name for its full datasheet.`), table(['Name', 'Family', 'ρ', 'E [GPa]', 'k', 'c_p', 'USD/kg', 'CO₂e/kg', '±%', 'Evidence'], rows.map(m => [h('a', { href: '#', onclick: (e) => { e.preventDefault(); showDatasheet(m); } }, m.name), m.family, m.rho, m.E ?? '—', m.k, m.cp, m.cost, m.co2, m.unc, m.evidence])));
    const smas = rows.filter(m => m.family === 'SMA');
    if (smas.length) box.append(h('h4', {}, 'Shape-memory alloy cards'), h('div', { class: 'row gap wrap' }, ...smas.map(m => h('div', { class: 'card', style: 'min-width:240px;flex:1' }, h('b', {}, m.name), h('div', { class: 'small' }, `M_s ${m.Ms} · M_f ${m.Mf} · A_s ${m.As} · A_f ${m.Af} °C`), h('div', { class: 'small' }, `C_M ${m.CM} · C_A ${m.CA} MPa/K · σ_s ${m.sigS} · σ_f ${m.sigF} MPa`), h('div', { class: 'small' }, `ε_L ${m.epsL} · L_h ${m.Lh} J/kg · E_A ${m.EA} · E_M ${m.EM} GPa`), h('div', { class: 'small' }, `k ${m.k} · c_p ${m.cp} · ρ ${m.rho}`), h('div', { class: 'small muted' }, `${m.cost} USD/kg · ${m.co2} kg CO₂e/kg · ±${m.unc} % · ${m.evidence}`), h('button', { class: 'btn sm', onclick: () => showDatasheet(m) }, 'Datasheet')))));
  };
  [fam, use].forEach(s => s.onchange = draw); q.oninput = draw;
  el.append(h('div', { class: 'row gap wrap' }, h('label', {}, 'Family ', fam), h('label', {}, 'Use ', use), q), box); draw();
}
async function componentView(el, ctx) {
  const { h, table, toast } = await import('../core/ui.js');
  const { forUse } = await import('../core/materials.js');
  const rows = Object.entries(COMPONENTS).map(([k, c]) => {
    const cur = ctx.store.material(k, c.def), opts = forUse(c.use);
    const sel = h('select', { onchange: (e) => { ctx.store.setMaterial(k, e.target.value); toast(`${c.name}: ${getMat(e.target.value)?.name} assigned — dependent results marked stale`, 'ok'); } }, ...opts.map(m => h('option', { value: m.id, selected: m.id === cur }, m.name)));
    return [c.name, sel, h('button', { class: 'btn sm', onclick: () => showDatasheet(getMat(sel.value)) }, 'Datasheet'), c.suite];
  });
  el.append(h('p', { class: 'small muted' }, 'Assign a library material to each engine component. Assignments are stored with the project and used by the CAD, mass, fatigue, cost and life-cycle suites.'), table(['Component', 'Material', '', 'Owning suite'], rows));
}
async function liveView(el, ctx, lib) {
  const { h, table, callout } = await import('../core/ui.js');
  const els = ['nickel', 'titanium', 'copper', 'hafnium'];
  const tb = h('div', {}, h('p', { class: 'small muted' }, 'Fetching PubChem element identifiers…')), pr = h('div', {}, h('p', { class: 'small muted' }, 'Fetching nickel and copper price history…'));
  el.append(h('h4', {}, 'Element identifiers (PubChem)'), tb, h('h4', {}, 'Alloying-metal price trend (IMF primary commodity prices)'), pr);
  if (!ctx.live?.pubchemProps) tb.replaceChildren(callout('warn', 'Live chemical reference service not available in this build.'));
  else Promise.allSettled(els.map(n => ctx.live.pubchemProps(n))).then(rs => {
    const rows = rs.map((r, i) => { if (r.status !== 'fulfilled') return [els[i], '—', '—', '—', 'unavailable: ' + String(r.reason?.message || r.reason).slice(0, 60)]; const pp = r.value.data?.PropertyTable?.Properties?.[0] || {}; return [els[i], pp.MolecularFormula || '—', pp.MolecularWeight || '—', pp.CID || '—', `${r.value.meta.name}${r.value.meta.cached ? ' (cached)' : ''} · ${r.value.meta.fetched.slice(0, 10)}`]; });
    tb.replaceChildren(table(['Element', 'Formula', 'Atomic weight [g/mol]', 'CID', 'Source'], rows), h('p', { class: 'small muted' }, 'Reference identifiers only; alloy properties come from the library card and imported tests.'));
  });
  if (!ctx.live?.commodityPrices) pr.replaceChildren(callout('warn', 'Commodity price service not available in this build.'));
  else ctx.live.commodityPrices(['PNICK', 'PCOPP'], 36).then(async r => {
    const { chart } = await import('../core/chart.js');
    const box = h('div'); pr.replaceChildren(box);
    const ser = Object.entries(r.series).filter(([, s]) => s.points.length).map(([, s]) => ({ name: s.label, x: s.points.map((_, i) => i - s.points.length + 1), y: s.points.map(q => q.value) }));
    if (!ser.length) { pr.replaceChildren(callout('info', 'No price observations returned.')); return; }
    chart(box, { type: 'line', title: 'Nickel and copper world price (last 36 months)', x: { label: 'Months before latest observation' }, y: { label: 'Price', unit: 'USD/t' }, series: ser, explain: `Monthly IMF primary commodity prices (${r.meta.name}, retrieved ${r.meta.fetched.slice(0, 10)}${r.meta.cached ? ', cached' : ''}). Nickel is ≈ 55 wt % of binary NiTi; ribbon price (${lib.cost} USD/kg library) is dominated by melting, rolling and training, not raw metal.` });
    const ni = r.series.PNICK?.latest; if (ni) pr.append(h('p', { class: 'small' }, `Latest nickel ${fmt(ni.value, 4)} USD/t (${ni.period}) → raw nickel content of NiTi ≈ ${fmt(ni.value / 1000 * 0.55, 3)} USD/kg of alloy vs ${lib.cost} USD/kg ribbon.`));
  }).catch(e => pr.replaceChildren(callout('warn', 'Price data unavailable (offline or service error): ' + e.message)));
}
