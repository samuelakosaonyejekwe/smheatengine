// Suite 22 — Techno-economics, scalability and lifecycle (master spec Module 22, §39; EIGDAS Module 22).
// CAPEX/OPEX from the Suite 20 build packet (or econ.js BOM), levelized cost of mechanical energy, cash-flow metrics,
// sensitivity tornado, probabilistic TEA (P10/P50/P90), Wright learning-curve scale-up, cost per delivered watt, lifetime
// work per kg of SMA, life-cycle CO₂ and carbon payback with LIVE site context (inflation, lending rate, grid carbon, FX,
// nickel price) and offline fallbacks, and a literature-range screening comparison with ORC, TEG and Stirling converters.
// Confirmed costs (user quotations) are kept separate from estimates; quotations are never invented.
import * as E from '../core/econ.js';
import { engineModel } from '../core/engine.js';
import { fatigueLife } from '../core/sma.js';
import { get as getMat } from '../core/materials.js';
import { carnot } from '../core/heat.js';
import { logspace, histogram, fmt, range } from '../core/num.js';
import { anim2d, seriesPanel, text, theme, bar as aBar } from '../core/anim2d.js';

const withTimeout = (pr, ms) => new Promise((res) => { const t = setTimeout(() => res(null), ms); Promise.resolve(pr).then(v => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(null); }); });
const FALLBACK = { inflation: 3, lending: 8, grid: 450, nickel: 16000 }; // estimated reference values (offline)

export default {
  description: 'Computes capital and operating cost, levelized cost per mechanical kWh, NPV/IRR/payback, sensitivity and probabilistic cost ranges, learning-curve scale-up, cost per delivered watt, lifetime work per kg of SMA and life-cycle CO₂ with carbon payback for the configured engine — using live site economics where available — and screens it against ORC, thermoelectric and Stirling converters at the same heat input.',
  literature: 'techno-economic analysis low grade waste heat recovery levelized cost elastocaloric shape memory alloy heat engine life cycle assessment',
  econ: true, sustain: true,
  credibility: 'Analytical screening',
  equations: [
    'LCOE_mech = [CAPEX·CRF(r, n) + O&M + C_ribbon,yr + C_heat,yr] / E_mech,yr, CRF = r(1 + r)ⁿ/((1 + r)ⁿ − 1), E_mech = P_net·h·A',
    'Real discount rate r = (1 + i_nom)/(1 + π) − 1 (Fisher); NPV = Σ CF_t/(1 + r)ᵗ; IRR: NPV(IRR) = 0; payback: first t with Σ CF ≥ 0',
    'Ribbon replacement interval t_rep = N_f/(f·3600·h); annual cost = (C_ribbon + labour)/t_rep',
    'Heat cost (spec §39): free waste heat → 0; captured heat → Q_hot·h·φ_el·p_el + Q_rej·h·p_cool; purchased → Q_hot·h·p_heat + cooling',
    'Wright learning curve: C_n = C₁·n^(log₂ LR), applied separately to material, processing/labour and purchased shares',
    'Life-cycle CO₂: m_i·b_i·EF_i + E_proc·g + BOP − EoL credit + replacements; displaced = E_mech/η_motor·g; carbon payback = total/(displaced − heat emissions)',
    'Alternatives: ORC/Stirling P = Q·η_C·f_C; TEG η = η_C(√(1 + ZT) − 1)/(√(1 + ZT) + T_c/T_h)',
    'NiTi price adjustment: c_NiTi = c_lib + w_Ni·(p_Ni,live − p_Ni,ref)/1000',
  ],
  methods: ['Deterministic DCF on a yearly grid; tornado by one-at-a-time ±ranges', 'Probabilistic TEA: 4000 triangular samples (seeded)', 'Live context: World Bank (inflation, lending rate), OWID grid carbon, ECB FX, IMF nickel via DBnomics — each with timeout and offline fallback', 'Literature-range screening of alternative converters'],
  assumptions: [
    'All costs are preliminary estimates unless a quotation is entered (“confirmed”); estimates carry the stated uncertainty ranges',
    'Mechanical output is valued at the electricity a motor drive would draw (η_motor) at the stated electricity price',
    'Ribbon fatigue life sets the replacement interval; other parts last the project life with O&M as % of CAPEX',
    'Alternative-converter values are literature-range screening numbers, not quotations or validated comparisons',
  ],
  ibc: { initial: ['Year 0: full CAPEX', 'New ribbons at commissioning'], boundary: ['Constant real prices over the life', 'System boundary: engine + supply/sink hardware + controls; heat source excluded unless purchased'] },
  cvv: {
    calibration: ['Supplier quotations and manufacturing cost records (Suite 20)', 'Pilot operating hours, availability and maintenance logs'],
    verification: ['NPV(IRR) = 0', 'CRF(r→0) = 1/n', 'LCOE × E = annualised cost', 'Monte Carlo median within the deterministic range'],
    validation: ['Independent cost quotations', 'Pilot-operating data (spec Module 22 evidence)'],
  },
  formats: { import: ['CSV/XLSX quotations', 'Maintenance records'], export: ['Cash-flow CSV', 'TEA JSON', 'Plots PNG/SVG'] },
  params: [
    { key: 'useLive', label: 'Use live site economics (timeouts fall back offline)', type: 'bool', default: true, group: 'Live data' },
    { key: 'currency', label: 'Display currency', type: 'select', options: ['USD', 'EUR', 'GBP', 'NGN', 'INR', 'CNY', 'JPY', 'ZAR', 'BRL'], default: 'USD', group: 'Live data' },
    { key: 'hoursYr', label: 'Operating hours per year', unit: 'h', type: 'number', min: 100, max: 8760, step: 10, default: 6000, group: 'Operation' },
    { key: 'avail', label: 'Availability', type: 'range', min: 0.3, max: 1, step: 0.01, default: 0.9, group: 'Operation' },
    { key: 'life', label: 'Project life', unit: 'yr', type: 'number', min: 1, max: 40, step: 1, default: 15, group: 'Operation' },
    { key: 'nominal', label: 'Nominal discount rate (0 = live lending rate)', unit: '%', type: 'number', min: 0, max: 40, step: 0.1, default: 0, group: 'Finance' },
    { key: 'inflation', label: 'Inflation (blank/0 = live)', unit: '%', type: 'number', min: 0, max: 50, step: 0.1, default: 0, group: 'Finance' },
    { key: 'elecPrice', label: 'Electricity price (value of displaced motor drive)', unit: 'USD/kWh', type: 'number', min: 0.01, max: 1, step: 0.01, default: 0.15, group: 'Finance' },
    { key: 'motorEff', label: 'Motor efficiency of the displaced drive', type: 'range', min: 0.5, max: 0.98, step: 0.01, default: 0.9, group: 'Finance' },
    { key: 'omPct', label: 'O&M (excluding ribbons)', unit: '% CAPEX/yr', type: 'number', min: 0, max: 20, step: 0.5, default: 3, group: 'Finance' },
    { key: 'install', label: 'Installation & commissioning', unit: '% of unit cost', type: 'number', min: 0, max: 100, step: 1, default: 10, group: 'Finance' },
    { key: 'quoteCapex', label: 'Confirmed quotation for the complete unit (0 = none)', unit: 'USD', type: 'number', min: 0, max: 1e7, step: 1, default: 0, group: 'Finance', help: 'Enter only a real supplier quotation; it replaces the estimate and is labelled confirmed.' },
    { key: 'heatMode', label: 'Heat supply (spec §39)', type: 'select', options: E.HEAT_MODES, default: 'free', group: 'Heat & cooling' },
    { key: 'priceHeat', label: 'Heat price (purchased mode)', unit: 'USD/kWh_th', type: 'number', min: 0, max: 0.5, step: 0.005, default: 0.04, group: 'Heat & cooling' },
    { key: 'priceCool', label: 'Cooling cost', unit: 'USD/kWh rejected', type: 'number', min: 0, max: 0.1, step: 0.0005, default: 0.002, group: 'Heat & cooling' },
    { key: 'captureFrac', label: 'Capture-loop electricity', unit: '% of Q_hot', type: 'number', min: 0, max: 10, step: 0.1, default: 1, group: 'Heat & cooling' },
    { key: 'heatCO2', label: 'Emission factor of purchased heat', unit: 'kg CO₂/kWh_th', type: 'number', min: 0, max: 0.5, step: 0.01, default: 0.2, group: 'Heat & cooling' },
    { key: 'grid', label: 'Grid carbon intensity (0 = live)', unit: 'gCO₂/kWh', type: 'number', min: 0, max: 1200, step: 1, default: 0, group: 'Sustainability' },
    { key: 'eolCredit', label: 'End-of-life recycling credit', unit: 'fraction', type: 'range', min: 0, max: 1, step: 0.05, default: 0.3, group: 'Sustainability' },
    { key: 'lrMat', label: 'Learning rate — material', type: 'range', min: 0.7, max: 1, step: 0.01, default: 0.95, group: 'Scale-up' },
    { key: 'lrProc', label: 'Learning rate — processing & labour', type: 'range', min: 0.6, max: 1, step: 0.01, default: 0.82, group: 'Scale-up' },
    { key: 'lrBuy', label: 'Learning rate — purchased & plant', type: 'range', min: 0.7, max: 1, step: 0.01, default: 0.92, group: 'Scale-up' },
    { key: 'niShare', label: 'Ni mass fraction of NiTi', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, group: 'Scale-up', expert: true },
    { key: 'niRef', label: 'Reference nickel price embedded in library NiTi cost', unit: 'USD/t', type: 'number', min: 1000, max: 100000, step: 100, default: 16000, group: 'Scale-up', expert: true, help: 'Estimate; the live IMF price adjusts the NiTi raw-material share relative to this.' },
    { key: 'nMC', label: 'Probabilistic samples', type: 'number', min: 500, max: 50000, step: 500, default: 4000, group: 'Uncertainty', expert: true },
  ],
  presets: [
    { label: 'Free industrial waste heat, 6000 h/yr', values: { heatMode: 'free', hoursYr: 6000 } },
    { label: 'Captured low-grade heat with cooling', values: { heatMode: 'captured', hoursYr: 5000 } },
    { label: 'Purchased heat (gas-fired boiler)', values: { heatMode: 'purchased', priceHeat: 0.05, heatCO2: 0.2 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const d = ctx.engine, mat = getMat(d.alloy), N = d.nCells;
    // ---------------- live context (never blocks offline) ----------------
    const L = { src: {} };
    if (p.useLive && ctx.live) {
      ctx.progress?.(0.05, 'live site economics');
      const [sc, cp] = await Promise.all([
        ctx.live.siteContext ? withTimeout(ctx.live.siteContext(ctx.site?.lat ?? 0, ctx.site?.lon ?? 0), 7000) : null,
        ctx.live.commodityPrices ? withTimeout(ctx.live.commodityPrices(['PNICK'], 12), 7000) : null,
      ]);
      if (sc) { L.sc = sc; if (sc.inflation?.value !== undefined) L.src.inflation = `World Bank ${sc.inflation.year} (${sc.country || ''})`; if (sc.lendingRate?.value !== undefined) L.src.lending = `World Bank ${sc.lendingRate.year}`; if (sc.gridCarbon?.value) L.src.grid = `OWID/Ember ${sc.gridCarbon.year}`; if (sc.fx) L.src.fx = `ECB ${sc.fxDate || ''}`; }
      const ni = cp?.series?.PNICK?.latest; if (ni?.value) { L.nickel = ni.value; L.src.nickel = `IMF PCPS via DBnomics ${ni.period}${cp.meta?.cached ? ' (cached)' : ''}`; L.niSeries = cp.series.PNICK.points; }
    }
    const pick = (user, live, fb, key) => (user > 0 ? { v: user, prov: 'user' } : live !== undefined && live !== null && Number.isFinite(live) ? { v: live, prov: 'live', src: L.src[key] } : { v: fb, prov: 'estimated', src: 'offline fallback (estimate)' });
    const infl = pick(p.inflation, L.sc?.inflation?.value, FALLBACK.inflation, 'inflation'), lend = pick(p.nominal, L.sc?.lendingRate?.value, FALLBACK.lending, 'lending'), grid = pick(p.grid, L.sc?.gridCarbon?.value, FALLBACK.grid, 'grid');
    const nickel = L.nickel ? { v: L.nickel, prov: 'live', src: L.src.nickel } : { v: p.niRef, prov: 'estimated', src: 'reference (no live price)' };
    const rNom = lend.v / 100, inf = Math.min(0.5, Math.max(-0.05, infl.v / 100)), rReal = Math.max(0.005, E.realRate(rNom, inf));
    const fx = p.currency === 'USD' ? 1 : (L.sc?.fx?.[p.currency] ?? null), cur = fx ? p.currency : 'USD', X = fx || 1;
    const money = (v) => `${fmt(v * X, 4)} ${cur}`;
    // ---------------- performance & upstream ----------------
    const s18 = ctx.upstream('s18'), s20 = ctx.upstream('s20'), s16 = ctx.upstream('s16'), s21 = ctx.upstream('s21');
    let perf, perfProv, cell = null;
    if (s18?.Pnet_W !== undefined) { perf = { Pnet: s18.Pnet_W, Qhot: s18.Qhot_W, Qrej: s18.Qhot_W - s18.Pnet_W, Ppump: (s18.Paux_W || 0) * 0.5, Pgross: s18.Pgross_W }; perfProv = 'coupled'; }
    else { const em = engineModel(d, { n: 2, stepsPerCycle: 150, cycles: 3 }); cell = em.cell; perf = { Pnet: em.Pnet, Qhot: em.QhotTot, Qrej: em.QrejTot, Ppump: em.Ppump, Pgross: em.Pgross, mActive: em.mActive, Wcell: em.cell.Wout }; perfProv = 'calc'; }
    const niAdj = p.niShare * (nickel.v - p.niRef) / 1000; // USD/kg NiTi change
    const ribbonMat = { ...mat, cost: Math.max(1, mat.cost + niAdj) };
    const B = E.bom(d, { materialOf: ctx.material, s02: ctx.upstream('s02'), s01: ctx.upstream('s01'), grid: grid.v, perf: { Qhot_W: perf.Qhot, Qrej_W: perf.Qrej, Ppump_W: perf.Ppump }, ribbonMat });
    const mActive = B.masses.mActive, ribRow = B.rows.find(r => r.key === 'ribbon');
    const unitEst = s20?.unitCost_USD !== undefined ? s20.unitCost_USD + (ribRow.material - (ribRow.material / ribbonMat.cost * mat.cost)) : B.totals.unit + (20 + 4.5 * N) * 45; // + assembly & test labour (Suite 20 workflow estimate) when Suite 20 has not run
    const unitProv = s20?.unitCost_USD !== undefined ? 'coupled (Suite 20, estimate)' : 'estimated (econ.js BOM)';
    const confirmed = p.quoteCapex > 0;
    const capex = (confirmed ? p.quoteCapex : unitEst) * (1 + p.install / 100);
    // ribbon life & replacement
    const strain = cell ? cell.stroke / d.ribbonL : 0.03, lifeCyc = s16?.life_cycles ?? fatigueLife(mat, strain, d.sigmaH);
    const ribbonCost = s20?.ribbonCost_USD !== undefined ? s20.ribbonCost_USD + (ribRow.material / ribbonMat.cost) * niAdj : ribRow.total;
    const rep = E.ribbonReplacement({ lifeCycles: lifeCyc, freq: d.freq, hours: p.hoursYr * p.avail, ribbonCost, labourH: 2 + 0.5 * N, labourRate: 45 });
    const heat = E.heatCost({ mode: p.heatMode, Qhot_W: perf.Qhot, Qrej_W: perf.Qrej, hours: p.hoursYr * p.avail, priceHeat: p.priceHeat, priceCool: p.priceCool, captureElecFrac: p.captureFrac / 100, elecPrice: p.elecPrice });
    const om = capex * p.omPct / 100;
    const hrs = p.hoursYr * p.avail;
    const lc = E.lcoe({ capex, rate: rReal, life: p.life, om, replacement: rep, heat, Pnet_W: perf.Pnet, hours: hrs });
    const Eyr = lc.energy_kWh, value = Eyr / p.motorEff * p.elecPrice, opex = om + lc.parts.replacement + heat.annual;
    const flows = E.cashFlows({ capex, annualBenefit: value, annualCost: opex, life: p.life });
    const NPV = E.npv(rReal, flows), IRR = E.irr(flows), PB = E.payback(flows), DPB = E.discountedPayback(rReal, flows);
    const costPerW = perf.Pnet > 0 ? capex / perf.Pnet : Infinity;
    const lifeWork_MJkg = perf.Pnet > 0 ? perf.Pnet * hrs * 3600 * p.life / mActive / 1e6 : 0; // per kg installed
    const perSetWork_MJkg = perf.Pgross > 0 ? (perf.Pgross / (N * d.freq)) * lifeCyc / (mActive / N) / 1e6 : 0;
    // ---------------- CO2 ----------------
    const nRep = rep.replacementsOverLife(p.life), repCO2 = nRep * ribRow.co2, consumedWork_MJkg = lifeWork_MJkg / (1 + nRep); // per kg of SMA consumed incl. replacement sets
    const CO2 = E.lifecycleCO2({ rows: B.rows, bop: B.bop, grid: grid.v, Pnet_W: perf.Pnet, hours: hrs, life: p.life, motorEff: p.motorEff, heatMode: p.heatMode, heatCO2: p.heatCO2, Qhot_W: perf.Qhot, eolCredit: p.eolCredit, replacementsCO2: repCO2 });
    // ---------------- sensitivity ----------------
    const base = { capex, Pnet: perf.Pnet, hours: hrs, life: p.life, rate: rReal, om: p.omPct, lifeMult: 1, heatMult: 1 };
    const lcoeOf = (s) => { const c = s.capex, r2 = E.ribbonReplacement({ lifeCycles: lifeCyc * s.lifeMult, freq: d.freq, hours: s.hours, ribbonCost, labourH: 2 + 0.5 * N, labourRate: 45 }); const h2 = E.heatCost({ mode: p.heatMode, Qhot_W: perf.Qhot * s.Pnet / Math.max(perf.Pnet, 1e-9), Qrej_W: perf.Qrej, hours: s.hours, priceHeat: p.priceHeat * s.heatMult, priceCool: p.priceCool * s.heatMult, captureElecFrac: p.captureFrac / 100, elecPrice: p.elecPrice }); return E.lcoe({ capex: c, rate: s.rate, life: Math.max(1, Math.round(s.life)), om: c * s.om / 100, replacement: r2, heat: h2, Pnet_W: s.Pnet, hours: s.hours }).lcoe; };
    const spec = [
      { key: 'capex', label: 'CAPEX −30 % / +50 %', lo: capex * 0.7, hi: capex * 1.5 }, { key: 'Pnet', label: 'Net power −50 % / +50 %', lo: perf.Pnet * 0.5, hi: perf.Pnet * 1.5 },
      { key: 'hours', label: 'Operating hours ±30 %', lo: hrs * 0.7, hi: Math.min(8760, hrs * 1.3) }, { key: 'life', label: 'Project life 8 / 25 yr', lo: 8, hi: 25 },
      { key: 'rate', label: 'Real discount rate 2 % / 15 %', lo: 0.02, hi: 0.15 }, { key: 'om', label: 'O&M 1 % / 8 % CAPEX', lo: 1, hi: 8 },
      { key: 'lifeMult', label: 'Ribbon life ×0.3 / ×3', lo: 0.3, hi: 3 }, { key: 'heatMult', label: 'Heat & cooling price ×0 / ×2', lo: 0, hi: 2 },
    ];
    const torn = perf.Pnet > 0 ? ctx.analysis.tornado(lcoeOf, base, spec) : null;
    // ---------------- probabilistic TEA ----------------
    const dists = [{ key: 'kc', a: 0.8, c: 1, b: 1.6 }, { key: 'kp', a: 0.5, c: 1, b: 1.2 }, { key: 'kh', a: 0.7, c: 1, b: 1.1 }, { key: 'kl', a: 0.3, c: 1, b: 3 }, { key: 'ko', a: 0.5, c: 1, b: 2 }, { key: 'kr', a: 0.7, c: 1, b: 1.5 }, { key: 'ke', a: 0.7, c: 1, b: 1.5 }];
    const mc = E.mcTEA((s) => lcoeOf({ capex: capex * s.kc, Pnet: perf.Pnet * s.kp, hours: Math.min(8760, hrs * s.kh), life: p.life, rate: rReal * s.kr, om: p.omPct * s.ko, lifeMult: s.kl, heatMult: 1 }), dists, { n: Math.round(p.nMC), seed: 22 });
    const mcN = E.mcTEA((s) => { const c = capex * s.kc, P = perf.Pnet * s.kp, h = Math.min(8760, hrs * s.kh), r2 = E.ribbonReplacement({ lifeCycles: lifeCyc * s.kl, freq: d.freq, hours: h, ribbonCost, labourH: 2 + 0.5 * N, labourRate: 45 }); const ben = Math.max(0, P) * h / 1000 / p.motorEff * p.elecPrice * s.ke, cost = c * p.omPct * s.ko / 100 + Math.min(r2.perYear, r2.cost * 1e3) + heat.annual; return E.npv(rReal * s.kr, E.cashFlows({ capex: c, annualBenefit: ben, annualCost: cost, life: p.life })); }, dists, { n: Math.round(p.nMC), seed: 23 });
    // ---------------- learning curve scale-up ----------------
    const matShare = B.totals.material / Math.max(B.totals.unit, 1), buyShare = (B.totals.purchased + B.totals.bop) / Math.max(B.totals.unit, 1), procShare = Math.max(0, 1 - matShare - buyShare);
    const split = [{ cost: capex * matShare, lr: p.lrMat }, { cost: capex * procShare, lr: p.lrProc }, { cost: capex * buyShare, lr: p.lrBuy }];
    const nU = logspace(0, 4, 41), capU = nU.map(n => E.learningCost(split, n)), lcoeU = capU.map(c => lcoeOf({ ...base, capex: c }));
    const cap1e4 = E.learningCost(split, 1e4);
    // heatmap: LCOE vs net-power multiplier and production volume
    const pm = logspace(0, 2, 21), vol = logspace(0, 4, 17);
    const Zl = vol.map(n => pm.map(m => Math.log10(Math.min(1e9, Math.max(1e-4, lcoeOf({ ...base, capex: E.learningCost(split, n), Pnet: perf.Pnet * m }))))));
    // ---------------- alternatives ----------------
    const etaC = carnot(d.Th, d.Tc), Q = perf.Qhot, crfV = E.crf(rReal, p.life);
    const alt = E.ALTERNATIVES.map(a => {
      const eta = a.zt ? [E.tegEfficiency(d.Th, d.Tc, a.zt[0]), E.tegEfficiency(d.Th, d.Tc, a.zt[1])] : [etaC * a.fC[0], etaC * a.fC[1]];
      const P = eta.map(e => Q * e), cap = [P[0] * a.cost[0], P[1] * a.cost[1]];
      const lcoeA = [cap[0] * E.crf(rReal, a.life) / Math.max(1e-9, P[0] * hrs / 1000) + 0.03 * a.cost[0] / (hrs / 1000), cap[1] * E.crf(rReal, a.life) / Math.max(1e-9, P[1] * hrs / 1000) + 0.03 * a.cost[1] / (hrs / 1000)];
      return { ...a, eta, P, cap, lcoeA: [Math.min(...lcoeA), Math.max(...lcoeA)] };
    });
    // ---------------- KPIs ----------------
    const netPos = perf.Pnet > 0, lcoeV = lc.lcoe;
    out.headline = netPos
      ? `CAPEX ≈ ${money(capex)} (${confirmed ? 'confirmed quotation' : 'estimate'}), OPEX ≈ ${money(opex)}/yr, LCOE ≈ ${fmt(lcoeV * X, 3)} ${cur}/kWh_mech (P10–P90 ${fmt(mc.p10 * X, 3)}–${fmt(mc.p90 * X, 3)}); NPV ${money(NPV)}, payback ${Number.isFinite(PB) ? fmt(PB, 3) + ' yr' : 'not reached'}; embodied ${fmt(CO2.total, 3)} kg CO₂e, carbon payback ${Number.isFinite(CO2.payback_yr) ? fmt(CO2.payback_yr, 3) + ' yr' : 'never'}.`
      : `Net power ${fmt(perf.Pnet, 3)} W ≤ 0: no levelized cost exists — the engine consumes more auxiliary power than it delivers. CAPEX ≈ ${money(capex)} would buy no net work.`;
    out.headlineKind = netPos && NPV > 0 ? 'ok' : netPos ? 'warn' : 'fail';
    const st = (ok, warn) => (ok ? 'ok' : warn ? 'warn' : 'bad');
    out.kpis.push({ label: 'CAPEX (installed)', value: capex * X, unit: cur, prov: confirmed ? 'user' : 'estimated', explain: `${confirmed ? 'Confirmed quotation' : `Estimated unit cost (${unitProv})`} + ${p.install} % installation and commissioning. Includes source/sink heat exchangers, pumps, valves, gearbox and controls (spec §39).` });
    out.kpis.push({ label: 'OPEX', value: opex * X, unit: `${cur}/yr`, prov: 'estimated', explain: `O&M ${money(om)} + ribbon replacement ${money(lc.parts.replacement)} (every ${fmt(rep.interval_yr, 3)} yr) + heat/cooling ${money(heat.annual)} (${p.heatMode} heat).` });
    out.kpis.push({ label: 'Levelized cost of mechanical energy', value: netPos ? lcoeV * X : 'not defined (P_net ≤ 0)', unit: netPos ? `${cur}/kWh` : '', prov: 'calc', explain: `Annualised cost / mechanical energy (${fmt(Eyr, 3)} kWh/yr at ${fmt(perf.Pnet, 3)} W net, ${fmt(hrs, 4)} h). Compare with the cost of driving the same load from the grid: ${fmt(p.elecPrice / p.motorEff * X, 3)} ${cur}/kWh.`, status: netPos ? st(lcoeV < p.elecPrice / p.motorEff, lcoeV < 5 * p.elecPrice) : 'bad' });
    out.kpis.push({ label: 'Net present value', value: NPV * X, unit: cur, prov: 'calc', explain: `Real discount rate ${fmt(rReal * 100, 3)} % (nominal ${fmt(rNom * 100, 3)} % ${lend.prov}, inflation ${fmt(inf * 100, 3)} % ${infl.prov}); benefits valued as displaced motor electricity.`, status: NPV > 0 ? 'ok' : 'bad' });
    out.kpis.push({ label: 'Simple payback', value: Number.isFinite(PB) ? PB : 'not reached within life', unit: Number.isFinite(PB) ? 'yr' : '', prov: 'calc', explain: `Years until cumulative cash flow turns positive (discounted: ${Number.isFinite(DPB) ? fmt(DPB, 3) + ' yr' : 'not reached'}). IRR ${Number.isFinite(IRR) ? fmt(IRR * 100, 3) + ' %' : 'undefined (cash flows never turn positive)'}.`, status: Number.isFinite(PB) && PB < p.life ? 'ok' : 'bad' });
    out.kpis.push({ label: 'Cost per delivered watt', value: Number.isFinite(costPerW) ? costPerW * X : 'not defined (P_net ≤ 0)', unit: Number.isFinite(costPerW) ? `${cur}/W` : '', prov: 'calc', explain: `CAPEX / net shaft power (spec §39). After 10⁴ units of learning: ${fmt(cap1e4 / Math.max(perf.Pnet, 1e-9) * X, 3)} ${cur}/W. Small ORC/Stirling units: ≈ 3–15 USD/W (literature range).`, status: st(costPerW < 15, costPerW < 100) });
    out.kpis.push({ label: 'Lifecycle mechanical work per kg SMA consumed', value: consumedWork_MJkg, unit: 'MJ/kg', prov: 'calc', explain: `Net work over ${p.life} years divided by all ribbon mass used (installed ${fmt(mActive, 3)} kg plus ${nRep} replacement sets). Per installed kg: ${fmt(lifeWork_MJkg, 3)} MJ/kg; one ribbon set delivers ≈ ${fmt(perSetWork_MJkg, 3)} MJ/kg gross before replacement (${fmt(lifeCyc, 3)} cycles).`, status: nRep < p.life ? 'ok' : 'warn' });
    out.kpis.push({ label: 'Life-cycle CO₂ (embodied + replacements)', value: CO2.total, unit: 'kg CO₂e', prov: 'estimated', explain: `Materials ${fmt(CO2.embodied, 3)} + processing ${fmt(CO2.process, 3)} (grid ${fmt(grid.v, 3)} g/kWh, ${grid.prov}) + plant ${fmt(CO2.bop, 3)} + ${nRep} ribbon replacements ${fmt(repCO2, 3)} − recycling credit ${fmt(CO2.credit, 3)} kg.` });
    out.kpis.push({ label: 'Carbon payback', value: Number.isFinite(CO2.payback_yr) ? CO2.payback_yr : 'never (no net displacement)', unit: Number.isFinite(CO2.payback_yr) ? 'yr' : '', prov: 'calc', explain: `Embodied CO₂ / net displaced emissions (${fmt(CO2.displacedYr, 3)} kg/yr from motor electricity avoided${CO2.heatYr ? ` − ${fmt(CO2.heatYr, 3)} kg/yr from purchased heat` : ''}).`, status: Number.isFinite(CO2.payback_yr) && CO2.payback_yr < p.life ? 'ok' : 'bad' });
    out.kpis.push({ label: 'LCOE P50 (probabilistic)', value: Number.isFinite(mc.p50) ? mc.p50 * X : 'not defined', unit: Number.isFinite(mc.p50) ? `${cur}/kWh` : '', prov: 'calc', explain: `Median of ${Math.round(p.nMC)} triangular samples (CAPEX, net power, hours, ribbon life, O&M, rate); P10 ${fmt(mc.p10 * X, 3)}, P90 ${fmt(mc.p90 * X, 3)}. ${fmt((1 - mc.finiteFrac) * 100, 3)} % of samples had no net output.` });
    // ---------------- verdicts ----------------
    out.verdicts.push({ test: 'Costs are estimates unless quoted', status: confirmed ? 'pass' : 'info', detail: confirmed ? `CAPEX based on the entered quotation (${money(p.quoteCapex)}).` : 'No supplier quotation entered: every cost is a preliminary estimate with stated assumptions (EIGDAS: no invented quotations).', fix: 'Obtain quotations for NiTi ribbon, plates, housings and balance of plant; enter the complete-unit quotation to label CAPEX confirmed.' });
    out.verdicts.push({ test: 'Positive net output (LCOE defined)', status: netPos ? 'pass' : 'fail', detail: `P_net = ${fmt(perf.Pnet, 3)} W (${perfProv}).`, fix: 'Increase net power (Suites 05, 13, 18) before any economic claim.' });
    out.verdicts.push({ test: 'Economic viability (NPV > 0 over the life)', status: NPV > 0 ? 'pass' : 'fail', detail: `NPV ${money(NPV)}; benefit ${money(value)}/yr vs OPEX ${money(opex)}/yr and CAPEX ${money(capex)}.`, fix: `Needs ≈ ${fmt(Math.max(1, (capex * E.crf(rReal, p.life) + opex) / Math.max(value, 1e-9)), 3)}× the current annual benefit: raise net power per unit cost (specific power), scale volume (learning), extend ribbon life and run more hours.` });
    out.verdicts.push({ test: 'Carbon payback within project life', status: Number.isFinite(CO2.payback_yr) && CO2.payback_yr < p.life ? 'pass' : 'fail', detail: `Payback ${Number.isFinite(CO2.payback_yr) ? fmt(CO2.payback_yr, 3) + ' yr' : 'never'} vs life ${p.life} yr; lifetime net ${fmt(CO2.lifetimeNet, 3)} kg CO₂e.`, fix: 'Reduce embodied mass (system factor), extend ribbon life, and use free waste heat on a high-carbon grid.' });
    out.verdicts.push({ test: 'Live economic context', status: Object.keys(L.src).length ? 'pass' : 'info', detail: Object.keys(L.src).length ? Object.entries(L.src).map(([k, v]) => `${k}: ${v}`).join('; ') : 'Offline or live services unavailable — estimated fallbacks used (inflation 3 %, lending 8 %, grid 450 g/kWh, nickel reference).', fix: 'Connect to the internet to refresh, or enter site values manually.' });
    // ---------------- checks ----------------
    const ck = (name, pass, value, target, detail) => out.checks.push({ name, pass, value, target, detail });
    if (Number.isFinite(IRR)) ck('NPV at IRR ≈ 0', Math.abs(E.npv(IRR, flows)) < 1e-6 * capex, E.npv(IRR, flows), '0');
    ck('CRF(r → 0) = 1/n', Math.abs(E.crf(1e-12, p.life) - 1 / p.life) < 1e-9, E.crf(1e-12, p.life), fmt(1 / p.life, 6));
    if (netPos) ck('LCOE × energy = annualised cost', Math.abs(lc.lcoe * lc.energy_kWh - lc.annual) < 1e-6 * lc.annual, lc.lcoe * lc.energy_kWh, fmt(lc.annual, 6));
    if (netPos && Number.isFinite(mc.p50)) ck('Probabilistic median within tornado range', mc.p50 >= Math.min(...torn.rows.map(r => Math.min(r.lo, r.hi))) * 0.5 && mc.p50 <= Math.max(...torn.rows.map(r => Math.max(r.lo, r.hi))) * 2, mc.p50, 'within range', 'Sanity check that the sampled model and the deterministic model agree.');
    ck('Learning curve monotone non-increasing', capU.every((v, i) => i === 0 || v <= capU[i - 1] + 1e-9), capU[capU.length - 1], `≤ ${fmt(capU[0], 4)}`);
    ck('Thermodynamic bound of alternatives (η ≤ η_C)', alt.every(a => a.eta.every(e => e <= etaC + 1e-12)), Math.max(...alt.flatMap(a => a.eta)), `≤ ${fmt(etaC, 4)}`);
    // ---------------- charts ----------------
    const yrs = range(p.life + 1), cum = flows.reduce((a, f, i) => (a.push((a[i - 1] ?? 0) + f), a), []), cumD = flows.reduce((a, f, i) => (a.push((a[i - 1] ?? 0) + f / (1 + rReal) ** i), a), []);
    out.charts.push({ title: 'Cumulative cash flow', x: { label: 'Year', unit: '' }, y: { label: 'Cumulative cash', unit: cur }, series: [{ name: 'Undiscounted', x: yrs, y: cum.map(v => v * X) }, { name: `Discounted (r = ${fmt(rReal * 100, 3)} %)`, x: yrs, y: cumD.map(v => v * X), dash: true }], annotations: [{ type: 'hline', y: 0, label: 'Break-even', color: '#22c55e' }], explain: 'CAPEX in year 0, then yearly benefit (displaced motor electricity) minus OPEX. The curve crossing zero is the payback; a curve that stays negative means the project does not pay back.' });
    if (torn) out.charts.push({ type: 'tornado', title: 'LCOE sensitivity (one-at-a-time)', rows: torn.rows.map(r => ({ label: r.label, lo: r.lo * X, hi: r.hi * X })), base: torn.base * X, explain: `Each bar shows LCOE (${cur}/kWh) at the low and high value of one input with the others at base. Longest bars are the economic levers.` });
    if (netPos) { const hv = mc.Y.filter(Number.isFinite), hh = histogram(hv.map(v => Math.log10(Math.max(v, 1e-6))), 30); out.charts.push({ type: 'bar', title: 'Probabilistic LCOE (log₁₀ of USD/kWh)', categories: hh.centers.map(c => fmt(10 ** c, 2)), series: [{ name: 'Samples', values: hh.counts }], explain: `Distribution of LCOE from ${Math.round(p.nMC)} samples (x-axis labels in USD/kWh). P10 ${fmt(mc.p10, 3)}, P50 ${fmt(mc.p50, 3)}, P90 ${fmt(mc.p90, 3)} USD/kWh.` }); }
    out.charts.push({ title: 'Learning-curve scale-up (Wright)', x: { label: 'Cumulative units', unit: '', log: true }, y: { label: 'Unit cost / LCOE', unit: '', log: true }, series: [{ name: `Unit CAPEX (${cur})`, x: nU, y: capU.map(v => v * X) }, ...(netPos ? [{ name: `LCOE (${cur}/kWh)`, x: nU, y: lcoeU.map(v => v * X) }, { name: `Cost per W (${cur}/W)`, x: nU, y: capU.map(v => v / perf.Pnet * X) }] : [])], annotations: [{ type: 'hline', y: p.elecPrice / p.motorEff * X, label: 'Grid-driven motor cost /kWh' }], explain: `Learning rates ${p.lrMat} (material), ${p.lrProc} (processing & labour), ${p.lrBuy} (purchased & plant) applied to their CAPEX shares (${fmt(matShare * 100, 3)} / ${fmt(procShare * 100, 3)} / ${fmt(buyShare * 100, 3)} %). Unit 10 000 costs ${money(cap1e4)}.` });
    out.charts.push({ type: 'heatmap', title: 'log₁₀ LCOE vs net-power gain and production volume', x: { label: 'Net power multiplier (specific-power gain)', values: pm.map(v => +v.toFixed(2)) }, y: { label: 'Cumulative units', values: vol.map(v => Math.round(v)) }, z: Zl, cmap: 'viridis', isolines: 6, zlabel: 'log₁₀ USD/kWh', explain: `What it takes to compete: each cell is log₁₀ LCOE for a net-power gain (x) at a production volume (y). The grid-driven motor reference is log₁₀ ${fmt(Math.log10(p.elecPrice / p.motorEff), 3)}.` });
    const cyr = range(p.life + 1).map(t => -CO2.total + CO2.netYr * t);
    out.charts.push({ title: 'Cumulative net CO₂ balance', x: { label: 'Year', unit: '' }, y: { label: 'Net avoided CO₂', unit: 'kg' }, series: [{ name: 'Net avoided − embodied', x: range(p.life + 1), y: cyr }], annotations: [{ type: 'hline', y: 0, label: 'Carbon payback', color: '#22c55e' }], explain: `Starts at −${fmt(CO2.total, 3)} kg embodied (incl. replacements) and rises by ${fmt(CO2.netYr, 3)} kg/yr of displaced motor electricity at ${fmt(grid.v, 3)} gCO₂/kWh (${grid.prov}).` });
    const altCats = ['THERMA-X100 (this design)', ...alt.map(a => a.name)];
    out.charts.push({ type: 'bar', title: `Net power at matched heat input (${fmt(Q, 4)} W, ${d.Th}/${d.Tc} °C) — screening`, categories: altCats, series: [{ name: 'Low (W)', values: [perf.Pnet, ...alt.map(a => a.P[0])] }, { name: 'High (W)', values: [perf.Pnet, ...alt.map(a => a.P[1])] }], explain: `Literature-range screening values (not quotations or validated comparisons): ORC and Stirling as fractions of Carnot (η_C = ${fmt(etaC * 100, 3)} %), TEG from the ZT formula. THERMA-X100 from the engine model.` });
    out.charts.push({ type: 'bar', title: 'Exergy-normalised cost comparison (screening)', categories: altCats, series: [{ name: 'Cost per W low (USD/W)', values: [costPerW, ...alt.map(a => a.cost[0])] }, { name: 'Cost per W high (USD/W)', values: [costPerW, ...alt.map(a => a.cost[1])] }], explain: 'Installed cost per watt of net output; alternatives use literature ranges for small units. Values above ≈ 100 USD/W indicate a research prototype rather than a product.' });
    if (L.niSeries?.length) out.charts.push({ title: 'Live nickel price (IMF PCPS)', x: { label: 'Month index', unit: '' }, y: { label: 'Nickel', unit: 'USD/t' }, series: [{ name: 'Nickel', x: L.niSeries.map((_, i) => i), y: L.niSeries.map(v => v.value) }], annotations: [{ type: 'hline', y: p.niRef, label: 'Reference in library cost' }], explain: `Monthly nickel price (${L.src.nickel}). The NiTi raw-material share is adjusted by ${fmt(niAdj, 3)} USD/kg relative to the reference.` });
    // ---------------- tables ----------------
    out.tables.push({ title: 'Cost basis — confirmed vs estimated', cols: ['Item', 'Value', 'Provenance', 'Basis'], rows: [
      ['Unit cost (engine + plant + assembly)', money(confirmed ? p.quoteCapex : unitEst), confirmed ? 'confirmed (user quotation)' : 'estimated', confirmed ? 'Entered quotation' : unitProv],
      ['Installation & commissioning', money(capex - capex / (1 + p.install / 100)), 'estimated', `${p.install} % of unit cost`],
      ['NiTi ribbon material', `${fmt(ribbonMat.cost, 4)} USD/kg`, nickel.prov === 'live' ? 'library + live nickel adjustment' : 'library (estimated)', `Ni ${fmt(nickel.v, 5)} USD/t (${nickel.src})`],
      ['Ribbon set replacement', money(rep.cost), 'estimated', `Every ${fmt(rep.interval_yr, 3)} yr (${fmt(lifeCyc, 3)} cycles${s16 ? ', Suite 16' : ', fatigue law'})`],
      ['O&M', `${money(om)}/yr`, 'estimated', `${p.omPct} % of CAPEX`],
      ['Heat & cooling', `${money(heat.annual)}/yr`, 'estimated', heat.note],
      ['Discount rate (nominal)', `${fmt(rNom * 100, 3)} %`, lend.prov, lend.src || 'user'],
      ['Inflation', `${fmt(inf * 100, 3)} %`, infl.prov, infl.src || 'user'],
      ['Grid carbon intensity', `${fmt(grid.v, 4)} g/kWh`, grid.prov, grid.src || 'user'],
      ['Currency', cur, fx && cur !== 'USD' ? 'live' : 'USD base', fx && cur !== 'USD' ? L.src.fx : (p.currency !== 'USD' ? 'FX unavailable offline — shown in USD' : '')],
    ], explain: 'Every line states whether it is a confirmed quotation, a live value or an estimate. Estimates must not be presented as quotations.' });
    out.tables.push({ title: 'Cash flow', cols: ['Year', 'Cash flow', 'Discounted', 'Cumulative'], rows: yrs.map(t => [t, money(flows[t]), money(flows[t] / (1 + rReal) ** t), money(cum[t])]), explain: 'Real (inflation-adjusted) terms.' });
    out.tables.push({ title: 'Levelized cost build-up', cols: ['Component', `Annual (${cur})`, `Share`, `${cur}/kWh`], rows: Object.entries(lc.parts).map(([k, v]) => [k, fmt(v * X, 4), fmt(v / Math.max(lc.annual, 1e-12) * 100, 3) + ' %', netPos ? fmt(v / Math.max(Eyr, 1e-12) * X, 4) : '—']), explain: `CRF = ${fmt(lc.crf, 4)} at ${fmt(rReal * 100, 3)} % over ${p.life} yr.` });
    out.tables.push({ title: 'Alternative converters at matched heat input (literature-range screening)', cols: ['Converter', 'Efficiency range', 'Net power range W', 'Installed USD/W', 'LCOE range USD/kWh', 'Note'], rows: [['THERMA-X100 (model)', fmt(perf.Pnet / Math.max(Q, 1e-9) * 100, 3) + ' %', fmt(perf.Pnet, 3), fmt(costPerW, 3), netPos ? fmt(lcoeV, 3) : '—', 'This design, estimated cost'], ...alt.map(a => [a.name, `${fmt(a.eta[0] * 100, 3)}–${fmt(a.eta[1] * 100, 3)} %`, `${fmt(a.P[0], 3)}–${fmt(a.P[1], 3)}`, `${a.cost[0]}–${a.cost[1]}`, `${fmt(a.lcoeA[0], 3)}–${fmt(a.lcoeA[1], 3)}`, a.note])], explain: 'Screening only: ranges represent typical small-scale literature/market values and are not quotations or validated benchmarks (V6 requires matched-condition measurements).' });
    out.tables.push({ title: 'Probabilistic TEA inputs (triangular min / mode / max multipliers)', cols: ['Input', 'Min', 'Mode', 'Max'], rows: [['CAPEX', 0.8, 1, 1.6], ['Net power', 0.5, 1, 1.2], ['Operating hours', 0.7, 1, 1.1], ['Ribbon life', 0.3, 1, 3], ['O&M', 0.5, 1, 2], ['Discount rate', 0.7, 1, 1.5], ['Electricity value (NPV only)', 0.7, 1, 1.5]], explain: `NPV P10/P50/P90: ${money(mcN.p10)} / ${money(mcN.p50)} / ${money(mcN.p90)}.` });
    // ---------------- explain & recs ----------------
    out.explain.push({ title: 'System boundary and heat price', text: `The economics include the engine, source/sink heat exchangers, pumps, valves, gearbox, controls and installation (spec §39). Heat mode “${p.heatMode}”: ${heat.note} The heat source itself is outside the boundary unless purchased.` });
    out.explain.push({ title: 'Why the numbers look the way they do', text: `${fmt(perf.Pnet, 3)} W of net output at ${fmt(hrs, 4)} h/yr gives only ${fmt(Eyr, 3)} kWh/yr, worth ${money(value)}/yr as displaced motor electricity, against ${money(capex)} of CAPEX. Cost per delivered watt (${fmt(costPerW, 3)} USD/W) is the key scaling metric: at ${fmt(cap1e4 / Math.max(perf.Pnet, 1e-9), 3)} USD/W after 10⁴ units, the remaining gap must come from specific power (heatmap).` });
    out.explain.push({ title: 'Live context', text: Object.keys(L.src).length ? `Live values used: ${Object.entries(L.src).map(([k, v]) => `${k} (${v})`).join(', ')}.` : 'No live values were available — fallbacks are labelled “estimated”.' });
    const leverTop = torn?.rows?.[0];
    out.recs.push({ level: 'econ', text: netPos ? `LCOE ${fmt(lcoeV, 3)} USD/kWh vs ${fmt(p.elecPrice / p.motorEff, 3)} USD/kWh for a grid-driven motor: ${lcoeV > p.elecPrice / p.motorEff ? `≈ ${fmt(lcoeV / (p.elecPrice / p.motorEff), 3)}× too expensive. Largest lever: ${leverTop?.label} (swing ${fmt(leverTop?.swing, 3)} USD/kWh).` : 'competitive at this site.'}` : 'No net output: economics cannot be assessed until P_net > 0.', basis: 'LCOE & tornado' });
    out.recs.push({ level: 'econ', text: `Ribbon replacement every ${fmt(rep.interval_yr, 3)} yr costs ${money(lc.parts.replacement)}/yr (${fmt(lc.parts.replacement / Math.max(lc.annual, 1e-9) * 100, 3)} % of annual cost). Halving transformation strain multiplies life ≈ 8× (Suite 16).`, basis: 'Ribbon replacement model' });
    out.recs.push({ level: 'econ', text: `Scale-up: Wright learning brings unit CAPEX from ${money(capU[0])} to ${money(cap1e4)} at 10⁴ units; labour/processing is ${fmt(procShare * 100, 3)} % of cost, so automate ribbon handling and plate bonding first.`, basis: 'Learning curve' });
    out.recs.push({ level: 'sustain', text: Number.isFinite(CO2.payback_yr) ? `Carbon payback ${fmt(CO2.payback_yr, 3)} yr on a ${fmt(grid.v, 3)} g/kWh grid; ${CO2.payback_yr < p.life ? 'net beneficial over the life' : 'longer than the life — reduce embodied mass or deploy where grid carbon is high'}.` : 'No carbon payback: the engine does not displace enough electricity to repay its embodied CO₂.', basis: `Embodied ${fmt(CO2.total, 3)} kg CO₂e` });
    out.recs.push({ level: 'sustain', text: `NiTi is ${fmt(ribRow.co2Mat / Math.max(CO2.embodied, 1e-9) * 100, 3)} % of material CO₂ for ${fmt(mActive / B.totals.mass * 100, 3)} % of mass: specify recycled-content NiTi and take back used ribbons (${p.eolCredit * 100} % EoL credit assumed).`, basis: 'Materials library co2' });
    out.recs.push({ level: 'info', text: `Against literature ranges, a small ORC at this heat input would deliver ${fmt(alt[0].P[0], 3)}–${fmt(alt[0].P[1], 3)} W; THERMA-X100 must show ${fmt(alt[0].P[0] / Math.max(perf.Pnet, 1e-9), 3)}× more net power to match the low end — validate at matched conditions before any comparative claim (V6).`, basis: 'Screening comparison' });
    // ---------------- view ----------------
    out.views.push({ label: '2D animation: cash & carbon over the life', icon: '🎞', render: (el) => anim2d(el, { duration: p.life, label: 'Year', unit: '', height: 400, explain: 'Cumulative discounted cash and net CO₂ balance year by year.', draw: (g, t, W, H) => { const th = theme(); text(g, `Year ${fmt(t, 3)}`, 10, 16, th.accent, 'bold 12px', W - 20); const yy = yrs; const ph = (H - 24 - 30) / 2; seriesPanel(g, { x: 8, y: 24, w: W - 16, h: ph - 4, T: yy, series: [{ name: `cash (${cur})`, y: cumD.map(v => v * X), color: '#38bdf8' }], t, title: 'Cumulative discounted cash', unit: cur, hlines: [{ y: 0, label: 'break-even', color: '#22c55e' }] }); seriesPanel(g, { x: 8, y: 24 + ph, w: W - 16, h: ph - 4, T: yy, series: [{ name: 'net CO₂', y: cyr, color: '#22c55e' }], t, title: 'Net avoided CO₂', unit: 'kg', hlines: [{ y: 0, label: 'payback' }] }); aBar(g, { x: 8, y: H - 26, w: W - 16, h: 18, value: Math.min(t / Math.max(rep.interval_yr, 1e-9), 1e3) % 1 * 100, max: 100, label: 'ribbon set used', unit: ' %', color: '#f59e0b' }); } }) });
    out.outputs = { capex_USD: capex, opex_USDyr: opex, lcoe_USDkWh: netPos ? lcoeV : null, payback_yr: Number.isFinite(PB) ? PB : null, npv_USD: NPV, irr: Number.isFinite(IRR) ? IRR : null, co2_kg: CO2.total, co2Payback_yr: Number.isFinite(CO2.payback_yr) ? CO2.payback_yr : null, costPerW_USD: Number.isFinite(costPerW) ? costPerW : null, lcoeP10: mc.p10, lcoeP50: mc.p50, lcoeP90: mc.p90, grid_gkWh: grid.v, realRate: rReal, capexConfirmed: confirmed, lifeWork_MJkg, consumedWork_MJkg, ribbonReplacements: nRep, live: L.src };
    return out;
  },
};
