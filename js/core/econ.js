// THERMA-X100 engineering economics & life-cycle screening for the regenerative multicell SMA heat engine.
// Every price below is a preliminary ESTIMATE with stated basis — never a supplier quotation (EIGDAS §3: the
// economics module must not invent quotations or treat estimated market prices as confirmed costs). Users replace
// them with quotations (provenance 'certified'/'user') in Suites 20 and 22.
//
// Exported API (SI masses kg, money USD, energy kWh unless stated):
//   PROCESS                         per-component process route, energy, labour, buy-to-fly, yield, purchase price
//   CART_SHARE, SYS_SHARE           mass-allocation factors of cartridge- and system-level parts (fallback mass model)
//   massBreakdown(design, {mat, s02, s01})            → {mass{key}, count{key}, mActive, mCart, mSys, basis}
//   processCost(mass, matRec, proc, {count, elecPrice, labourRate}) → {material, energy, labour, purchased, total, kWh, hours, yieldLoss}
//   bom(design, {materialOf, s02, s01, elecPrice, labourRate, grid, perf})       → {rows[], bop[], totals{}, masses}
//   balanceOfPlant(design, perf, {labourRate})        → purchased supply/sink/drive/control items (estimates)
//   npv(rate, flows), irr(flows), payback(flows), discountedPayback(rate, flows), realRate(nominal, inflation)
//   crf(rate, years) capital-recovery factor, annuity(pv, rate, years)
//   wright(T1, lr, n) unit cost of the n-th unit, wrightAvg(T1, lr, N) cumulative-average cost, learningCost(split, n)
//   heatCost({mode, Qhot_W, Qrej_W, hours, priceHeat, priceCool, captureElecFrac, elecPrice}) → {annual, heat, cool, capture, note}
//   ribbonReplacement({lifeCycles, freq, hours, ribbonCost, labourH, labourRate}) → {interval_yr, perYear, replacementsOverLife(life)}
//   lcoe({capex, rate, life, om, replacement, heat, Pnet_W, hours})              → {lcoe, energy_kWh, parts{}, crf}
//   cashFlows({capex, annualBenefit, annualCost, life, salvage}) → flows[]
//   lifecycleCO2({rows, bop, grid, Pnet_W, hours, life, motorEff, heatMode, heatCO2, Qhot_W, eolCredit}) → {embodied, process, bop, total, displacedYr, heatYr, netYr, payback_yr}
//   tri(a, c, b, u) triangular sample, mcTEA(fn, dists, {n, seed}) → {Y, p10, p50, p90, mean, std}
//   ALTERNATIVES                    literature-range screening data for ORC, TEG, Stirling (labelled, not quotations)
import { COMPONENTS, get as getMat } from './materials.js';
import { brent, rng, mean, std, percentile } from './num.js';

// ---------------- process routes (representative estimates; basis: generic job-shop practice) ----------------
// kWh: processing electricity per kg of finished part (beyond embodied material energy); setupH per batch;
// hPer per piece; btf buy-to-fly (raw material bought per kg finished); y process yield; buy: purchased price per piece.
export const PROCESS = {
  ribbon: { route: 'VIM/VAR melt → hot & cold rolling with inter-pass anneals → precision slitting → shape-setting 450–500 °C → constrained training cycles', kWh: 60, setupH: 3, hPer: 0.05, btf: 1.4, y: 0.85, life: 'fatigue' },
  grip: { route: 'CNC machining from Ti-6Al-4V bar, serrated/clamped faces, thermal-break inserts', kWh: 15, setupH: 1.5, hPer: 0.4, btf: 3, y: 0.97 },
  biasSpring: { route: 'Cold-rolled 17-7PH strip → forming → precipitation hardening (CH900)', kWh: 8, setupH: 1, hPer: 0.3, btf: 1.5, y: 0.97 },
  channelPlate: { route: 'Photochemical etching of microchannels → diffusion bonding of plate stack → helium/pressure leak test', kWh: 25, setupH: 3, hPer: 0.6, btf: 1.8, y: 0.9 },
  contactLayer: { route: 'Die-cut flexible graphite interface sheet', kWh: 2, setupH: 0.3, hPer: 0.05, btf: 1.3, y: 0.98 },
  separator: { route: 'CNC machined PEEK thermal separators', kWh: 8, setupH: 0.5, hPer: 0.25, btf: 2.5, y: 0.98 },
  housing: { route: 'CNC machining 6061-T6, anodise, datum inspection', kWh: 12, setupH: 2, hPer: 0.8, btf: 3.5, y: 0.97 },
  carriage: { route: 'CNC machining 7075-T6 rocker/carriage', kWh: 12, setupH: 1, hPer: 0.5, btf: 4, y: 0.97 },
  flexure: { route: 'Wire-EDM or laser cutting of β-Ti sheet, ageing; AM lattice option for metamaterial cores', kWh: 20, setupH: 1.5, hPer: 0.5, btf: 2.5, y: 0.92 },
  manifold: { route: 'Machined PPS-GF40 manifolds & rotary distributor (injection moulding at series volume)', kWh: 10, setupH: 4, hPer: 1.5, btf: 2, y: 0.95 },
  regenMatrix: { route: 'Woven 316L screen stacking & sintering in canister', kWh: 15, setupH: 2, hPer: 1, btf: 1.3, y: 0.95 },
  shaft: { route: 'Turning, H1025 ageing, journal grinding', kWh: 10, setupH: 1, hPer: 2, btf: 3, y: 0.98 },
  rotor: { route: 'CNC turning of 7075-T6 rotor/flywheel, dynamic balancing', kWh: 12, setupH: 1, hPer: 2.5, btf: 3, y: 0.98 },
  clutch: { route: 'Purchased sprag-type one-way clutch bearings', buy: 18, setupH: 0, hPer: 0.15, y: 1 },
  bearing: { route: 'Purchased sealed deep-groove bearings', buy: 12, setupH: 0, hPer: 0.1, y: 1 },
  seal: { route: 'Purchased moulded EPDM O-rings & valve seats', buy: 1.5, setupH: 0, hPer: 0.02, y: 1 },
  casing: { route: 'Plate machining & TIG welding, hydrostatic pressure test, guard mesh', kWh: 10, setupH: 3, hPer: 4, btf: 2, y: 0.97 },
  insulation: { route: 'Cut and wrapped aerogel blanket, jacketed', kWh: 1, setupH: 0.5, hPer: 1, btf: 1.2, y: 1 },
  hotFluid: { route: 'Fill, deaerate, inhibit (hot circuit)', kWh: 0, setupH: 0.2, hPer: 0.3, btf: 1.1, y: 1 },
  coldFluid: { route: 'Fill, deaerate, inhibit (cold circuit)', kWh: 0, setupH: 0.2, hPer: 0.3, btf: 1.1, y: 1 },
};
// Fallback mass model: share of (cartridge − active) and (system − cartridge) mass, used when Suite 02 has not run.
export const CART_SHARE = { grip: 0.2, biasSpring: 0.1, channelPlate: 0.35, contactLayer: 0.05, separator: 0.08, housing: 0.22 };
export const SYS_SHARE = { carriage: 0.06, flexure: 0.04, manifold: 0.1, regenMatrix: 0.08, shaft: 0.05, rotor: 0.12, clutch: 0.03, bearing: 0.02, seal: 0.02, casing: 0.3, insulation: 0.03, hotFluid: 0.075, coldFluid: 0.075 };

export function massBreakdown(d, { mat = getMat(d.alloy), s02 = null, s01 = null } = {}) {
  const N = d.nCells, nR = N * d.ribbonsPerCell;
  let mActive = nR * d.ribbonL * d.ribbonW * d.ribbonT * (mat?.rho || 6450), basis = 'engine design × library density (calc)';
  let mCart = mActive * d.cartridgeFactor, mSys = mActive * d.systemFactor;
  if (s02?.ribbonMass_kg > 0) { mActive = s02.ribbonMass_kg; basis = 'Suite 02 CAD masses (coupled)'; mCart = s02.cartridgeMass_kg > mActive ? s02.cartridgeMass_kg : mActive * d.cartridgeFactor; mSys = s02.engineMass_kg > mCart ? s02.engineMass_kg : mActive * d.systemFactor; }
  else if (s01?.mActive_kg > 0) { mActive = s01.mActive_kg; mCart = s01.mCart_kg || mCart; mSys = s01.mSys_kg || mSys; basis = 'Suite 01 mass budget (coupled)'; }
  mCart = Math.max(mCart, mActive); mSys = Math.max(mSys, mCart);
  const mass = { ribbon: mActive };
  for (const [k, f] of Object.entries(CART_SHARE)) mass[k] = (mCart - mActive) * f;
  for (const [k, f] of Object.entries(SYS_SHARE)) mass[k] = (mSys - mCart) * f;
  const count = { ribbon: nR, grip: 2 * N, biasSpring: N, channelPlate: 2 * N, contactLayer: 2 * N, separator: N + 1, housing: N, carriage: N, flexure: N, manifold: 2, regenMatrix: 1, shaft: 1, rotor: 1, clutch: N, bearing: 2, seal: 4 * N + 4, casing: 1, insulation: 1, hotFluid: 1, coldFluid: 1 };
  return { mass, count, mActive, mCart, mSys, basis };
}

export function processCost(mass, m, proc, { count = 1, elecPrice = 0.15, labourRate = 45 } = {}) {
  const hours = (proc.setupH || 0) + (proc.hPer || 0) * count, labour = hours * labourRate;
  if (proc.buy !== undefined) { const purchased = proc.buy * count; return { material: 0, energy: 0, labour, purchased, total: purchased + labour, kWh: 0, hours, yieldLoss: 0 }; }
  const material = mass * (proc.btf || 1) * (m?.cost ?? 5), kWh = mass * (proc.kWh || 0), energy = kWh * elecPrice, y = proc.y || 1;
  const base = material + energy + labour, total = base / y;
  return { material, energy, labour, purchased: 0, total, kWh: kWh / y, hours: hours / y, yieldLoss: total - base };
}

// Balance of plant: complete supply/sink infrastructure, fluid power, drive and control (spec §39). Estimates only.
export function balanceOfPlant(d, perf = {}, { labourRate = 45 } = {}) {
  const Q = Math.max(perf.Qhot_W ?? 0, 1), Qr = Math.max(perf.Qrej_W ?? Q, 1), Pp = Math.max(perf.Ppump_W ?? 1, 0.1), P = Math.max(d.targetPower || 50, 1);
  const lmtd = Math.max(3, (d.fluidDT || 10)), U = 1000, Ah = Q / (U * lmtd), Ac = Qr / (U * lmtd);
  const it = (key, name, cost, basis, hours = 0.5, co2 = 0) => ({ key, name, cost: cost + hours * labourRate, hours, basis, co2, prov: 'estimated' });
  return [
    it('hxHot', `Source heat exchanger (≈ ${Ah.toFixed(2)} m², U ${U} W/m²K)`, 150 + 300 * Ah, 'Brazed-plate HX class: ≈ 150 USD + 300 USD/m² (estimate)', 1, 20 + 60 * Ah),
    it('hxCold', `Sink heat exchanger / cooler (≈ ${Ac.toFixed(2)} m²)`, 150 + 300 * Ac, 'Brazed-plate HX / fan cooler class (estimate)', 1, 20 + 60 * Ac),
    it('pumps', `Circulation pumps ×2 (≈ ${Pp.toFixed(1)} W hydraulic total)`, 2 * (110 + 3 * Pp), 'Small wet-rotor circulator class: ≈ 110 USD + 3 USD/W each (estimate)', 1, 2 * 8),
    it('valves', `Phase valves / rotary distributor (${2 * d.nCells} ports)`, 60 + 25 * 2 * d.nCells, '≈ 25 USD per switched port + distributor body (estimate)', 0.2 * d.nCells, 0.4 * 2 * d.nCells),
    it('gearbox', `Output gearbox / coupling (≈ ${P.toFixed(0)} W rated)`, 80 + 1.2 * P, 'Small planetary/belt reducer class (estimate)', 1, 5 + 0.05 * P),
    it('sensors', 'Process sensors (T, p, flow, speed) & wiring', 260, 'Industrial sensor kit class (estimate)', 3, 6),
    it('control', 'Controller, watchdog, safety relays, emergency stop', 320, 'PLC/microcontroller + safety relay class (estimate)', 4, 10),
    it('frame', 'Frame, guards, fasteners, pipework', 120, 'Fabricated frame & fittings (estimate)', 3, 15),
  ];
}

export function bom(d, { materialOf, s02, s01, elecPrice = 0.15, labourRate = 45, grid = 450, perf = {}, ribbonMat } = {}) {
  const mb = massBreakdown(d, { mat: ribbonMat || getMat(d.alloy), s02, s01 });
  const rows = Object.keys(COMPONENTS).map((key) => {
    const c = COMPONENTS[key], m = key === 'ribbon' ? (ribbonMat || getMat(d.alloy)) : (materialOf?.(key) || getMat(c.def)), proc = PROCESS[key] || { kWh: 5, setupH: 1, hPer: 0.2, btf: 2, y: 0.95, route: '—' };
    const mass = mb.mass[key] || 0, count = mb.count[key] || 1, pc = processCost(mass, m, proc, { count, elecPrice, labourRate });
    const co2Mat = mass * (proc.btf || 1) * (m?.co2 ?? 5), co2Proc = pc.kWh * grid / 1000, energyMJ = mass * (proc.btf || 1) * (m?.energy ?? 80);
    return { key, name: c.name, material: m?.name || c.def, matId: m?.id || c.def, mass, count, route: proc.route, purchased: proc.buy !== undefined, ...pc, co2Mat, co2Proc, co2: co2Mat + co2Proc + (proc.buy !== undefined ? count * 0.5 : 0), energyMJ, recyclable: m?.recyclable ?? 0.5, unc: m?.unc ?? 20, priceProv: 'estimated' };
  });
  const bop = balanceOfPlant(d, perf, { labourRate });
  const sum = (a, k) => a.reduce((s, r) => s + (r[k] || 0), 0);
  const totals = { mass: sum(rows, 'mass'), material: sum(rows, 'material'), energy: sum(rows, 'energy'), labour: sum(rows, 'labour'), purchased: sum(rows, 'purchased'), yieldLoss: sum(rows, 'yieldLoss'), engine: sum(rows, 'total'), bop: sum(bop, 'cost'), hours: sum(rows, 'hours') + sum(bop, 'hours'), kWh: sum(rows, 'kWh'), co2: sum(rows, 'co2') + sum(bop, 'co2'), co2Engine: sum(rows, 'co2') };
  totals.unit = totals.engine + totals.bop;
  return { rows, bop, totals, masses: mb };
}

// ---------------- discounted cash flow ----------------
export const npv = (rate, flows) => flows.reduce((s, f, t) => s + f / (1 + rate) ** t, 0);
export function irr(flows) { const f = (r) => npv(r, flows); for (const [a, b] of [[-0.95, -0.5], [-0.5, 0], [0, 0.5], [0.5, 3], [3, 20]]) { const fa = f(a), fb = f(b); if (Number.isFinite(fa) && Number.isFinite(fb) && fa * fb <= 0) { const r = brent(f, a, b, 1e-10); if (Number.isFinite(r.x)) return r.x; } } return NaN; }
export function payback(flows) { let c = 0; for (let t = 0; t < flows.length; t++) { const p = c; c += flows[t]; if (c >= 0 && t > 0 && p < 0) return t - 1 + (-p) / (flows[t] || 1); } return Infinity; }
export const discountedPayback = (rate, flows) => payback(flows.map((f, t) => f / (1 + rate) ** t));
export const realRate = (nominal, inflation) => (1 + nominal) / (1 + inflation) - 1;
export const crf = (r, n) => (Math.abs(r) < 1e-9 ? 1 / n : r * (1 + r) ** n / ((1 + r) ** n - 1));
export const annuity = (pv, r, n) => pv * crf(r, n);
export function cashFlows({ capex, annualBenefit, annualCost = 0, life, salvage = 0, replacements = [] }) {
  const f = [-capex]; for (let t = 1; t <= life; t++) f.push(annualBenefit - annualCost + (t === life ? salvage : 0) - replacements.filter(r => r.year === t).reduce((s, r) => s + r.cost, 0)); return f;
}

// ---------------- learning curves (Wright: cost falls by (1 − lr) per doubling) ----------------
export const wright = (T1, lr, n) => T1 * n ** (Math.log(lr) / Math.LN2);
export function wrightAvg(T1, lr, N) { const b = Math.log(lr) / Math.LN2; if (N <= 2000) { let s = 0; for (let n = 1; n <= N; n++) s += n ** b; return T1 * s / N; } return T1 * ((N + 0.5) ** (b + 1) - 0.5 ** (b + 1)) / ((b + 1) * N); }
// split: [{cost, lr}] e.g. material (lr 0.95), processing+labour (lr 0.85), purchased (lr 0.97)
export const learningCost = (split, n) => split.reduce((s, c) => s + wright(c.cost, c.lr, n), 0);

// ---------------- heat & cooling cost (spec §39: free waste heat vs heat requiring capture/pumping/cooling) ----------------
export const HEAT_MODES = [
  { value: 'free', label: 'Free waste heat at the source (only the capture hardware is costed)' },
  { value: 'captured', label: 'Waste heat requiring capture, pumping & cooling (electricity for capture loop + cooling)' },
  { value: 'purchased', label: 'Purchased / fuel-fired heat (heat price × heat input)' },
];
export function heatCost({ mode = 'free', Qhot_W, Qrej_W, hours, priceHeat = 0.04, priceCool = 0.002, captureElecFrac = 0.01, elecPrice = 0.15 }) {
  const Qh = Qhot_W * hours / 1000, Qr = (Qrej_W ?? Qhot_W) * hours / 1000;
  const heat = mode === 'purchased' ? Qh * priceHeat : 0, capture = mode === 'captured' ? Qh * captureElecFrac * elecPrice : 0, cool = mode === 'free' ? 0 : Qr * priceCool;
  return { annual: heat + capture + cool, heat, capture, cool, Qh_kWh: Qh, Qr_kWh: Qr, note: mode === 'free' ? 'Heat free at the source; sink assumed ambient & free (only hardware costed).' : mode === 'captured' ? 'Waste heat with capture-loop electricity and paid cooling.' : 'Heat purchased per kWh_th; cooling paid.' };
}

// ---------------- ribbon replacement driven by fatigue life ----------------
export function ribbonReplacement({ lifeCycles, freq, hours, ribbonCost, labourH = 4, labourRate = 45 }) {
  const cyclesYr = Math.max(1e-9, freq * 3600 * hours), interval = lifeCycles / cyclesYr, cost = ribbonCost + labourH * labourRate;
  return { interval_yr: interval, cyclesYr, cost, perYear: cost / Math.max(interval, 1e-9), replacementsOverLife: (life) => Math.max(0, Math.ceil(life / Math.max(interval, 1e-9) - 1e-9) - 1) };
}

// ---------------- levelized cost of mechanical energy ----------------
export function lcoe({ capex, rate, life, om = 0, replacement = null, heat = null, Pnet_W, hours }) {
  const E = Math.max(0, Pnet_W) * hours / 1000, k = crf(rate, life);
  const parts = { capital: capex * k, om, replacement: replacement ? Math.min(replacement.perYear, replacement.cost * 1e3) : 0, heat: heat ? heat.annual : 0 };
  const annual = parts.capital + parts.om + parts.replacement + parts.heat;
  return { lcoe: E > 0 ? annual / E : Infinity, energy_kWh: E, annual, parts, crf: k };
}

// ---------------- life-cycle CO2 screening (cradle-to-gate + use phase, defined boundary) ----------------
export function lifecycleCO2({ rows, bop = [], grid = 450, Pnet_W, hours, life, motorEff = 0.9, heatMode = 'free', heatCO2 = 0.2, Qhot_W = 0, eolCredit = 0.3, replacementsCO2 = 0 }) {
  const embodied = rows.reduce((s, r) => s + (r.co2Mat || 0), 0), process = rows.reduce((s, r) => s + (r.co2Proc || 0), 0), bopCO2 = bop.reduce((s, r) => s + (r.co2 || 0), 0);
  const credit = eolCredit * rows.reduce((s, r) => s + (r.co2Mat || 0) * (r.recyclable ?? 0), 0);
  const total = embodied + process + bopCO2 + replacementsCO2 - credit;
  const displacedYr = Math.max(0, Pnet_W) * hours / 1000 / motorEff * grid / 1000; // electricity a motor drive would have drawn
  const heatYr = heatMode === 'purchased' ? Qhot_W * hours / 1000 * heatCO2 : 0;
  const netYr = displacedYr - heatYr;
  return { embodied, process, bop: bopCO2, credit, replacements: replacementsCO2, total, displacedYr, heatYr, netYr, payback_yr: netYr > 0 ? total / netYr : Infinity, lifetimeNet: netYr * life - total };
}

// ---------------- probabilistic TEA ----------------
export const tri = (a, c, b, u) => { const F = (c - a) / ((b - a) || 1); return u < F ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c)); };
// dists: [{key, a, c, b}] triangular (min, mode, max); fn(sampleObj) → scalar
export function mcTEA(fn, dists, { n = 2000, seed = 17 } = {}) {
  const R = rng(seed), Y = [], X = [];
  for (let i = 0; i < n; i++) { const s = {}; for (const d of dists) s[d.key] = tri(d.a, d.c, d.b, R()); const y = fn(s); X.push(s); Y.push(y); }
  const F = Y.filter(Number.isFinite);
  return { X, Y, finiteFrac: F.length / n, p10: F.length ? percentile(F, 0.1) : NaN, p50: F.length ? percentile(F, 0.5) : NaN, p90: F.length ? percentile(F, 0.9) : NaN, mean: F.length ? mean(F) : NaN, std: F.length > 1 ? std(F) : NaN };
}

// ---------------- alternative low-grade heat converters (literature-range screening; NOT quotations) ----------------
// fC: achieved fraction of Carnot at small scale and low source temperature; cost: installed USD per W of net output.
export const ALTERNATIVES = [
  { id: 'orc', name: 'Organic Rankine cycle (small, 1–50 kW)', fC: [0.25, 0.45], cost: [3, 10], life: 20, note: 'Small low-temperature ORC units; efficiency and specific cost worsen sharply below a few kW.' },
  { id: 'teg', name: 'Thermoelectric generator (ZT ≈ 0.8–1.2)', zt: [0.8, 1.2], cost: [5, 25], life: 20, note: 'Efficiency from the ideal TEG formula with the stated ZT range; heat-exchanger costs dominate at low ΔT.' },
  { id: 'stirling', name: 'Low-ΔT Stirling engine', fC: [0.1, 0.3], cost: [3, 15], life: 15, note: 'Low-temperature-differential Stirling prototypes and small commercial units.' },
];
export const tegEfficiency = (Th, Tc, ZT) => { const a = Th + 273.15, b = Tc + 273.15, eC = 1 - b / a, m = Math.sqrt(1 + ZT); return eC * (m - 1) / (m + b / a); };
