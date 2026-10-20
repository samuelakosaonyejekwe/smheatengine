// Suite 20 — Manufacturing, metrology and assembly (master spec Module 20, §35, §36, §41; EIGDAS Module 20).
// Process routes per component (econ.js PROCESS), BOM with masses/costs/footprint, shape-setting process window for Af
// (representative trend, labelled), tolerance stack-ups (worst case, RSS, Monte Carlo) for the preload/stroke chain and the
// microchannel gap, Cp/Cpk, first-pass yield, spec §36 production workflow with inspection gates, inspection plan,
// nonconformance log (stored in the project), build hours and a Gantt-type schedule.
import { bom as econBom } from '../core/econ.js';
import { engineModel } from '../core/engine.js';
import { get as getMat } from '../core/materials.js';
import { rng, mean, std, histogram, linspace, fmt, percentile, normCdf } from '../core/num.js';
import { anim2d, bar as aBar, text, theme } from '../core/anim2d.js';

// Representative shape-setting trend for Ni-rich NiTi (Ni₄Ti₃ precipitation raises Af, peaking ≈ 400–450 °C; dissolution
// and recovery above ≈ 500 °C). Hypothetical surface for planning only — calibrate with DSC of heat-treated coupons.
const dAf = (T, tMin) => { const g = Math.exp(-(((T - 430) / 65) ** 2)), tau = 25 * Math.exp(-(T - 400) / 60), rec = T > 500 ? (T - 500) / 100 * 8 * (1 - Math.exp(-tMin / 30)) : 0; return 22 * g * (1 - Math.exp(-tMin / Math.max(2, tau))) - rec; };
const setDone = (T, tMin) => 1 - Math.exp(-tMin / Math.max(0.5, 60 * Math.exp(-(T - 400) / 40))); // shape-setting completeness (representative)

export default {
  description: 'Generates the manufacturing build packet for the configured engine: process routes, bill of materials with masses, costs and embodied CO₂, the shape-setting process window for the ribbon transformation temperature, tolerance stack-ups of the preload/stroke chain and microchannel gap with Cp/Cpk and first-pass yield, the spec §36 assembly sequence with inspection gates, an inspection plan, a nonconformance log and a build schedule.',
  literature: 'NiTi shape setting heat treatment transformation temperature manufacturing tolerance stack-up actuator assembly',
  econ: true, sustain: true,
  credibility: 'Analytical screening',
  equations: [
    'Component cost C = [m·b·c_mat + m·e_proc·p_el + (t_setup + n·t_piece)·r_lab] / y (b buy-to-fly, y process yield)',
    'Worst-case stack T_wc = Σ|s_i|·t_i; RSS stack T_rss = √Σ(s_i·t_i)²; Monte Carlo X = Σ s_i·X_i, X_i ~ N(μ_i, (t_i/(3·Cp_i))²)',
    'Preload stress error Δσ = E_t·ΔL/L (E_t tangent modulus of the extended ribbon); channel pressure drop ∝ 1/h³ ⇒ Δp/p ≈ −3·Δh/h',
    'Capability Cp = (USL − LSL)/(6σ), Cpk = min(USL − μ, μ − LSL)/(3σ); fraction out of spec = Φ(−3Cpk_L) + Φ(−3Cpk_U)',
    'First-pass yield FPY = Π_lines y_line × P(preload in spec)^N × P(gap in spec)^(2N)',
    'Shape-setting trend (representative): ΔA_f(T,t) = A·exp(−((T − T*)/w)²)·(1 − e^(−t/τ(T))) − recovery(T,t)',
    'Schedule: earliest start of step j = max over predecessors (finish); build hours = Σ labour hours of parts, balance of plant and assembly/test steps',
  ],
  methods: ['Bill of materials and process costing from js/core/econ.js (mass model from Suite 02 when available)', 'Seeded Monte Carlo (20 000 samples) for each stack; analytic Cp/Cpk', 'Grid evaluation of the shape-setting window (31 × 25)', 'Precedence-based schedule of the spec §36 workflow'],
  assumptions: [
    'All prices, rates and process times are preliminary estimates (provenance estimated), not supplier quotations',
    'The shape-setting surface is a representative literature-shaped trend (hypothetical) — real Af depends on composition, cold work and furnace practice',
    'Contributors to each stack are independent and normally distributed; process capability Cp applies to every contributor unless stated',
    'Mass split of non-active parts follows the cartridge/system factors of the engine design when Suite 02 has not run',
  ],
  ibc: { initial: ['Raw material from qualified lots (certificate required)', 'Fixtures and gauges calibrated'], boundary: ['Tolerances and spec limits as entered', 'Machine capability Cp per process', 'Labour and electricity rates'] },
  cvv: {
    calibration: ['Shape-setting window from DSC of coupons heat-treated at the corner points of the window', 'Process capability from first-article and repeatability studies'],
    verification: ['Monte Carlo stack σ equals RSS σ for linear stacks', 'Worst-case ≥ RSS', 'BOM totals equal the sum of component rows'],
    validation: ['First-article inspection reports', 'Repeatability (gauge R&R) study', 'Measured build hours and scrap'],
  },
  formats: { import: ['CSV/XLSX supplier quotations', 'CMM inspection reports (CSV)', 'STEP from Suite 02'], export: ['BOM CSV', 'Build packet JSON', 'Inspection plan CSV', 'NCR log CSV', 'Plots PNG/SVG'] },
  params: [
    { key: 'labourRate', label: 'Labour rate', unit: 'USD/h', type: 'number', min: 5, max: 200, step: 1, default: 45, group: 'Cost basis', help: 'Estimated loaded shop rate; replace with your quotation.' },
    { key: 'elecPrice', label: 'Electricity price', unit: 'USD/kWh', type: 'number', min: 0.01, max: 1, step: 0.01, default: 0.15, group: 'Cost basis' },
    { key: 'grid', label: 'Grid carbon intensity (manufacturing)', unit: 'gCO₂/kWh', type: 'number', min: 0, max: 1200, step: 10, default: 450, group: 'Cost basis', auto: (c) => { const g = c.upstream('s22')?.grid_gkWh; return g ? { value: Math.round(g), prov: 'coupled' } : undefined; } },
    { key: 'units', label: 'Engines in this build lot', type: 'number', min: 1, max: 1000, step: 1, default: 1, group: 'Cost basis', help: 'Set-up hours are shared across the lot.' },
    { key: 'Af0', label: 'Ribbon Af (as delivered / library)', unit: '°C', type: 'number', min: -20, max: 200, step: 1, default: 55, group: 'Process window', auto: (c) => { const a = c.upstream('s19')?.calibrated; if (a?.Af !== undefined && !a.synthetic) return { value: +a.Af.toFixed(1), prov: 'calibrated' }; const s = c.upstream('s03')?.card?.Af; if (s !== undefined) return { value: s, prov: 'coupled' }; const m = getMat(c.engine.alloy); return m ? { value: m.Af, prov: 'library' } : undefined; } },
    { key: 'setT', label: 'Shape-setting temperature', unit: '°C', type: 'range', min: 350, max: 600, step: 5, default: 475, group: 'Process window' },
    { key: 'setMin', label: 'Shape-setting time', unit: 'min', type: 'range', min: 2, max: 120, step: 1, default: 20, group: 'Process window' },
    { key: 'trainCycles', label: 'Training cycles per ribbon', type: 'number', min: 0, max: 2000, step: 10, default: 100, group: 'Process window', help: 'Constrained thermal cycles to stabilise the two-way response (functional-fatigue shakedown).' },
    { key: 'margin', label: 'Thermal margin to fluid temperatures', unit: 'K', type: 'number', min: 0, max: 20, step: 0.5, default: 2, group: 'Process window' },
    { key: 'tolRibbon', label: 'Ribbon cut length tolerance ±', unit: 'mm', type: 'number', min: 0.005, max: 1, step: 0.005, default: 0.05, group: 'Preload/stroke chain' },
    { key: 'tolGrip', label: 'Grip seating tolerance ± (each end)', unit: 'mm', type: 'number', min: 0.002, max: 0.5, step: 0.002, default: 0.02, group: 'Preload/stroke chain' },
    { key: 'tolHousing', label: 'Housing pin-spacing tolerance ±', unit: 'mm', type: 'number', min: 0.002, max: 0.5, step: 0.002, default: 0.02, group: 'Preload/stroke chain' },
    { key: 'tolCarriage', label: 'Carriage pocket tolerance ±', unit: 'mm', type: 'number', min: 0.002, max: 0.5, step: 0.002, default: 0.025, group: 'Preload/stroke chain' },
    { key: 'adjustable', label: 'Mechanically adjustable preload (spec §41)', type: 'bool', default: true, group: 'Preload/stroke chain', help: 'Preload set with a fine screw against a load cell; the residual error is the adjustment resolution plus the force-measurement uncertainty.' },
    { key: 'adjRes', label: 'Preload adjustment resolution ±', unit: 'mm', type: 'number', min: 0.001, max: 0.1, step: 0.001, default: 0.005, group: 'Preload/stroke chain' },
    { key: 'Et', label: 'Tangent modulus of extended ribbon at preload', unit: 'GPa', type: 'number', min: 1, max: 80, step: 1, default: 10, group: 'Preload/stroke chain', expert: true, help: 'Inside the detwinning plateau the tangent modulus is far below E_M; 10 GPa is an estimate — measure from the tensile curve (Suite 03/04).' },
    { key: 'preTol', label: 'Preload specification ±', unit: '% of σ_L', type: 'number', min: 1, max: 50, step: 1, default: 10, group: 'Preload/stroke chain' },
    { key: 'tolEtch', label: 'Channel etch depth tolerance ±', unit: 'mm', type: 'number', min: 0.002, max: 0.2, step: 0.002, default: 0.02, group: 'Channel gap' },
    { key: 'biasEtch', label: 'Etch depth mean offset', unit: 'mm', type: 'number', min: -0.1, max: 0.1, step: 0.002, default: 0.01, group: 'Channel gap', help: 'Systematic offset of the etch process (drives Cpk below Cp).' },
    { key: 'tolFlat', label: 'Plate flatness contribution ±', unit: 'mm', type: 'number', min: 0.002, max: 0.2, step: 0.002, default: 0.015, group: 'Channel gap' },
    { key: 'tolBond', label: 'Diffusion-bond line tolerance ±', unit: 'mm', type: 'number', min: 0.001, max: 0.1, step: 0.001, default: 0.01, group: 'Channel gap' },
    { key: 'gapTol', label: 'Channel-gap specification ±', unit: '% of h', type: 'number', min: 1, max: 40, step: 1, default: 10, group: 'Channel gap' },
    { key: 'Cp', label: 'Process capability Cp of each contributor', type: 'number', min: 0.5, max: 3, step: 0.05, default: 1.33, group: 'Capability', help: 'Tolerance = ±3·Cp·σ of the process.' },
    { key: 'nMC', label: 'Monte Carlo samples', type: 'number', min: 1000, max: 200000, step: 1000, default: 20000, group: 'Capability', expert: true },
    { key: 'seed', label: 'Random seed', type: 'number', min: 1, max: 99999, step: 1, default: 2020, group: 'Capability', expert: true },
  ],
  presets: [
    { label: 'Laboratory prototype (adjustable preload)', values: { adjustable: true, units: 1, Cp: 1.0 } },
    { label: 'Fixed-length production cartridge', values: { adjustable: false, units: 100, Cp: 1.33 } },
    { label: 'Precision process (Cp 1.67)', values: { Cp: 1.67, biasEtch: 0 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const d = ctx.engine, mat = getMat(d.alloy), N = d.nCells, s02 = ctx.upstream('s02'), s01 = ctx.upstream('s01'), s18 = ctx.upstream('s18');
    // performance for balance-of-plant sizing
    let perf, perfProv;
    if (s18?.Qhot_W) { perf = { Qhot_W: s18.Qhot_W, Qrej_W: s18.Qhot_W - (s18.Pgross_W || 0), Ppump_W: (s18.Paux_W || 0) * 0.5 }; perfProv = 'coupled (Suite 18)'; }
    else { const em = engineModel(d, { n: 2, stepsPerCycle: 120, cycles: 3 }); perf = { Qhot_W: em.QhotTot, Qrej_W: em.QrejTot, Ppump_W: em.Ppump }; perfProv = 'reduced engine model (calc)'; }
    const B = econBom(d, { materialOf: ctx.material, s02, s01, elecPrice: p.elecPrice, labourRate: p.labourRate, grid: p.grid, perf, ribbonMat: mat });
    // ribbon processing details: training energy & time
    const ribbonRow = B.rows.find(r => r.key === 'ribbon'), nRib = ribbonRow.count;
    const trainH = p.trainCycles * (1 / d.freq + 2) / 3600 * Math.ceil(nRib / 20); // batches of 20 ribbons in a training rig
    // ---------------- process window ----------------
    const Tset = linspace(350, 600, 31), tset = linspace(2, 120, 25);
    const AfRef = p.Af0 - dAf(475, 20); // as-rolled baseline so the reference treatment reproduces the library Af
    const AfOf = (T, tm) => AfRef + dAf(T, tm);
    const hyst = mat.Af - mat.Mf, AfMax = d.Th - p.margin - d.sigmaH / mat.CA, AfMin = d.Tc + p.margin + hyst - d.sigmaL / mat.CM;
    const Zaf = tset.map(tm => Tset.map(T => AfOf(T, tm)));
    const Zok = tset.map(tm => Tset.map(T => { const a = AfOf(T, tm), sd = setDone(T, tm); return Math.min(AfMax - a, a - AfMin, (sd - 0.95) * 100); }));
    const AfSel = AfOf(p.setT, p.setMin), sdSel = setDone(p.setT, p.setMin), inWindow = AfSel <= AfMax && AfSel >= AfMin && sdSel >= 0.95;
    const okCells = Zok.flat().filter(v => v >= 0).length;
    let best = null; tset.forEach((tm, j) => Tset.forEach((T, i) => { const z = Zok[j][i]; if (!best || z > best.z) best = { T, tm, z, Af: Zaf[j][i] }; }));
    // ---------------- tolerance stacks ----------------
    const R = rng(p.seed), nMC = Math.round(p.nMC), L = d.ribbonL * 1000; // mm
    const chain = p.adjustable
      ? [{ name: 'Preload adjustment resolution', tol: p.adjRes, s: 1, mu: 0 }, { name: 'Load-cell force error (as length)', tol: 0.01 * d.sigmaL / (p.Et * 1e3) * L, s: 1, mu: 0 }, { name: 'Grip re-seating after locking', tol: p.tolGrip / 2, s: 1, mu: 0 }]
      : [{ name: 'Ribbon cut length', tol: p.tolRibbon, s: -1, mu: 0 }, { name: 'Grip seat (end A)', tol: p.tolGrip, s: 1, mu: 0 }, { name: 'Grip seat (end B)', tol: p.tolGrip, s: 1, mu: 0 }, { name: 'Housing pin spacing', tol: p.tolHousing, s: 1, mu: 0 }, { name: 'Carriage pocket', tol: p.tolCarriage, s: 1, mu: 0 }];
    const gapC = [{ name: 'Etch depth', tol: p.tolEtch, s: 1, mu: p.biasEtch }, { name: 'Plate flatness', tol: p.tolFlat, s: -1, mu: 0 }, { name: 'Bond line', tol: p.tolBond, s: 1, mu: 0 }];
    const stack = (C, nominal, lim) => {
      const wc = C.reduce((a, c) => a + Math.abs(c.s) * c.tol, 0), rss = Math.sqrt(C.reduce((a, c) => a + (c.s * c.tol) ** 2, 0));
      const sdA = Math.sqrt(C.reduce((a, c) => a + (c.s * c.tol / (3 * p.Cp)) ** 2, 0)), muA = C.reduce((a, c) => a + c.s * c.mu, 0);
      const X = new Float64Array(nMC); for (let i = 0; i < nMC; i++) { let x = 0; for (const c of C) x += c.s * R.normal(c.mu, c.tol / (3 * p.Cp)); X[i] = x; }
      const arr = Array.from(X), mu = mean(arr), sd = std(arr), out = arr.filter(v => v > lim || v < -lim).length / nMC;
      const Cp = 2 * lim / (6 * sd), Cpk = Math.min(lim - mu, mu + lim) / (3 * sd), pOut = normCdf(-(lim - mu) / sd) + normCdf(-(lim + mu) / sd);
      const contrib = C.map(c => ({ name: c.name, v: (c.s * c.tol / (3 * p.Cp)) ** 2 / (sdA ** 2 || 1) }));
      return { wc, rss, sdA, muA, arr, mu, sd, out, Cp, Cpk, pOut, contrib, nominal, lim, p01: percentile(arr, 0.001), p99: percentile(arr, 0.999) };
    };
    const rssFixed = Math.sqrt(p.tolRibbon ** 2 + 2 * p.tolGrip ** 2 + p.tolHousing ** 2 + p.tolCarriage ** 2);
    const preLimMM = p.preTol / 100 * d.sigmaL / (p.Et * 1e3) * L; // ±mm equivalent of the preload spec
    const S1 = stack(chain, L, preLimMM), hNom = d.chH * 1000, S2 = stack(gapC, hNom, p.gapTol / 100 * hNom);
    const toMPa = (mm) => p.Et * 1e3 * mm / L;
    const yieldPre = 1 - S1.pOut, yieldGap = 1 - S2.pOut;
    const lineY = B.rows.reduce((a, r) => a * (r.purchased ? 1 : (PROC_Y(r))), 1);
    function PROC_Y(r) { return r.total > 0 ? Math.min(1, (r.total - r.yieldLoss) / r.total) : 1; }
    const FPY = lineY * yieldPre ** N * yieldGap ** (2 * N);
    const CpkMin = Math.min(S1.Cpk, S2.Cpk);
    const dpVar = 3 * S2.sd / hNom;
    // ---------------- assembly sequence (spec §36) & schedule ----------------
    const fabH = (keys) => B.rows.filter(r => keys.includes(r.key)).reduce((s, r) => s + r.hours, 0);
    const bopH = B.bop.reduce((s, r) => s + r.hours, 0);
    const steps = [
      { id: 1, name: 'Select qualified alloy lots (certificates, composition)', h: 4, pre: [], gate: 'G1 incoming inspection: certificate, lot ID, DSC sample retained' },
      { id: 2, name: 'Baseline DSC & fatigue coupons of the lot', h: 16, pre: [1], gate: `G2 Af after shape-setting within ${fmt(AfMin, 3)}…${fmt(AfMax, 3)} °C` },
      { id: 3, name: 'Define hot & cold operating points (design freeze)', h: 4, pre: [2], gate: 'G3 design review: Th, Tc, σL, σH frozen' },
      { id: 4, name: 'Fabricate coupons, instrumented cycles', h: 12, pre: [3], gate: 'G4 coupon net work > 0 (Suite 19 V1)' },
      { id: 5, name: 'Release ribbon/grip drawing', h: 6, pre: [4], gate: 'G5 drawing & GD&T review' },
      { id: 6, name: `Fabricate ribbons: cut, shape-set ${p.setT} °C/${p.setMin} min, train ${p.trainCycles} cycles (${nRib} ribbons)`, h: ribbonRow.hours + trainH, pre: [5], gate: 'G6 ribbon length, Af (DSC sample per batch), surface' },
      { id: 7, name: 'Fabricate cartridge parts (grips, springs, plates, housings, separators)', h: fabH(['grip', 'biasSpring', 'channelPlate', 'contactLayer', 'separator', 'housing']), pre: [5], gate: 'G7 first-article inspection (channel depth, flatness, datums)' },
      { id: 8, name: 'Fabricate drive & system parts (carriage, flexures, rotor, shaft, casing, manifolds, regenerator)', h: fabH(['carriage', 'flexure', 'manifold', 'regenMatrix', 'shaft', 'rotor', 'casing', 'insulation']), pre: [3], gate: 'G8 FAI, rotor balance grade, casing hydrostatic test' },
      { id: 9, name: 'Pressure-test fluid circuit (plates, manifolds)', h: 2 + 0.25 * N, pre: [7, 8], gate: 'G9 leak rate below limit at 1.5 × design pressure' },
      { id: 10, name: 'Assemble cartridges with measured preload', h: N * (1.5 + (p.adjustable ? 0.5 : 0.2)), pre: [6, 9], gate: `G10 preload within ±${p.preTol} % of σL (load cell)` },
      { id: 11, name: 'Dry mechanical test of each cartridge', h: N * 0.75, pre: [10], gate: 'G11 stroke and friction within limits' },
      { id: 12, name: 'Commission hot & cold flow', h: 6, pre: [11], gate: 'G12 flows, ΔT, pressure drops vs Suite 13' },
      { id: 13, name: 'Measure net cyclic work per cartridge', h: N * 1, pre: [12], gate: 'G13 measured net work > 0 after reset & parasitics (V2)' },
      { id: 14, name: 'Integrate phased array, shaft, clutches, balance of plant', h: 8 + 0.5 * N + bopH, pre: [13], gate: 'G14 phasing per Suite 12, guards & trips functional (Suite 21)' },
      { id: 15, name: 'Final inspection & traceability dossier', h: 4, pre: [14], gate: 'G15 dimensional, treatment history, NCRs closed, test records' },
    ];
    for (const s of steps) { s.start = s.pre.length ? Math.max(...s.pre.map(i => steps[i - 1].finish)) : 0; s.finish = s.start + s.h; }
    const makespan = Math.max(...steps.map(s => s.finish)), buildHours = steps.reduce((a, s) => a + s.h, 0);
    const assemblyH = steps.filter(s => [9, 10, 11, 12, 13, 14, 15].includes(s.id)).reduce((a, s) => a + s.h, 0);
    // unit cost incl. assembly & test labour; lot set-up sharing approximated on fabrication rows
    const setupSave = p.units > 1 ? B.rows.reduce((a, r) => a + (r.purchased ? 0 : 1) * (1 - 1 / p.units) * 0.25 * r.labour, 0) : 0;
    const unitCost = B.totals.unit + assemblyH * p.labourRate - setupSave;
    const partCount = B.rows.reduce((a, r) => a + (r.mass > 0 || r.purchased ? r.count : 0), 0) + B.bop.length;
    // ---------------- nonconformance log (project) ----------------
    const proj = ctx.store?.project; const ncrPred = [];
    if (S2.Cpk < 1.33) ncrPred.push({ item: 'Microchannel plates', char: 'Channel gap', issue: `Predicted Cpk ${fmt(S2.Cpk, 3)} < 1.33 (etch offset ${p.biasEtch} mm)`, action: 'Centre the etch process; 100 % depth inspection until Cpk ≥ 1.33' });
    if (S1.Cpk < 1.33) ncrPred.push({ item: 'Cartridge', char: 'Ribbon preload', issue: `Predicted Cpk ${fmt(S1.Cpk, 3)} < 1.33`, action: p.adjustable ? 'Improve adjustment resolution / load-cell accuracy' : 'Switch to adjustable preload (spec §41) or tighten length tolerances' });
    if (!inWindow) ncrPred.push({ item: 'Ribbon', char: 'Af after shape-setting', issue: `Predicted Af ${fmt(AfSel, 3)} °C outside ${fmt(AfMin, 3)}…${fmt(AfMax, 3)} °C or incomplete setting`, action: 'Move the treatment into the window; verify by DSC' });
    if (proj) { const log = (proj.ncr ||= []); for (const n of ncrPred) { const key = n.item + '|' + n.char; const ex = log.find(x => x.key === key && x.origin === 'predicted'); if (ex) Object.assign(ex, n, { t: new Date().toISOString() }); else log.push({ ...n, key, origin: 'predicted', status: 'open', id: 'NCR-' + String(log.length + 1).padStart(3, '0'), t: new Date().toISOString() }); } for (const x of log) if (x.origin === 'predicted' && !ncrPred.some(n => n.item + '|' + n.char === x.key) && x.status === 'open') x.status = 'closed (no longer predicted)'; }
    const ncrLog = proj?.ncr || ncrPred.map((n, i) => ({ ...n, id: 'NCR-' + (i + 1), origin: 'predicted', status: 'open', t: '' }));
    // ---------------- KPIs ----------------
    const prov = 'estimated';
    out.headline = `Build packet: ${partCount} parts, ≈ ${fmt(buildHours, 3)} labour-hours (${fmt(makespan, 3)} h critical path), unit cost ≈ ${fmt(unitCost, 3)} USD (estimate, not a quotation); preload Cpk ${fmt(S1.Cpk, 3)}, gap Cpk ${fmt(S2.Cpk, 3)}, first-pass yield ${fmt(FPY * 100, 3)} %.`;
    out.headlineKind = CpkMin >= 1.33 && inWindow ? 'ok' : 'warn';
    out.kpis.push({ label: 'Unit cost (prototype, estimate)', value: unitCost, unit: 'USD', prov, explain: `Engine parts ${fmt(B.totals.engine, 4)} + balance of plant ${fmt(B.totals.bop, 4)} + assembly/test labour ${fmt(assemblyH * p.labourRate, 4)} USD${setupSave ? ` − lot set-up sharing ${fmt(setupSave, 3)}` : ''}. Estimated from library prices and shop rates — replace with quotations.`, status: 'ok' });
    out.kpis.push({ label: 'Build labour hours', value: buildHours, unit: 'h', prov, explain: `Sum of the ${steps.length} workflow steps (fabrication from the process routes, ${fmt(trainH, 3)} h ribbon training, assembly, pressure and functional tests). Critical path ${fmt(makespan, 3)} h with parallel part fabrication.` });
    out.kpis.push({ label: 'Part count', value: partCount, unit: 'parts', prov: 'calc', explain: `Pieces in the BOM (${nRib} ribbons, ${2 * N} grips, ${2 * N} plates, ${4 * N + 4} seals …) plus ${B.bop.length} balance-of-plant items. Ribbons dominate the count — automate cutting and gripping.` });
    out.kpis.push({ label: 'Preload chain tolerance (RSS)', value: S1.rss, unit: 'mm', prov: 'calc', explain: `RSS of the ${p.adjustable ? 'adjustable-preload' : 'fixed-length'} chain (worst case ${fmt(S1.wc, 3)} mm). Converted with E_t = ${p.Et} GPa over L = ${fmt(L, 3)} mm this is ±${fmt(toMPa(S1.rss), 3)} MPa of preload vs a ±${fmt(p.preTol / 100 * d.sigmaL, 3)} MPa specification.`, status: S1.rss <= preLimMM ? 'ok' : 'warn' });
    out.kpis.push({ label: 'Preload Cpk', value: S1.Cpk, unit: '', prov: 'calc', explain: 'Capability of the preload against ±spec: ≥ 1.33 is capable; < 1 means routine out-of-spec cartridges.', status: S1.Cpk >= 1.33 ? 'ok' : S1.Cpk >= 1 ? 'warn' : 'bad' });
    out.kpis.push({ label: 'Channel-gap Cpk', value: S2.Cpk, unit: '', prov: 'calc', explain: `Capability of the microchannel height h = ${fmt(hNom, 3)} mm against ±${p.gapTol} %. Pressure drop scales with 1/h³, so the 3σ gap scatter (${fmt(dpVar * 100, 3)} % of h) gives ≈ ±${fmt(3 * dpVar * 100, 3)} % pressure-drop scatter between cells (maldistribution, Suite 13).`, status: S2.Cpk >= 1.33 ? 'ok' : S2.Cpk >= 1 ? 'warn' : 'bad' });
    out.kpis.push({ label: 'First-pass yield', value: FPY * 100, unit: '%', prov: 'estimated', explain: `Product of process-line yields (${fmt(lineY * 100, 3)} %), preload conformance^N (${fmt(yieldPre * 100, 4)} %) and gap conformance^2N (${fmt(yieldGap * 100, 4)} %) for N = ${N} cartridges.`, status: FPY > 0.7 ? 'ok' : 'warn' });
    out.kpis.push({ label: 'Ribbon Af after shape-setting (trend)', value: AfSel, unit: '°C', prov: 'hypothetical', explain: `Representative trend at ${p.setT} °C / ${p.setMin} min (setting completeness ${fmt(sdSel * 100, 3)} %). Window from the design: ${fmt(AfMin, 3)} ≤ Af ≤ ${fmt(AfMax, 3)} °C. Verify with DSC of a coupon from each furnace batch.`, status: inWindow ? 'ok' : 'warn' });
    out.kpis.push({ label: 'Embodied CO₂ (engine + plant)', value: B.totals.co2, unit: 'kg CO₂e', prov: 'estimated', explain: `Cradle-to-gate material footprint × buy-to-fly plus processing electricity at ${p.grid} gCO₂/kWh and balance-of-plant estimates. Engine parts ${fmt(B.totals.co2Engine, 3)} kg.` });
    // ---------------- verdicts ----------------
    out.verdicts.push({ test: 'Prices are estimates, not quotations', status: 'info', detail: 'All material, process and purchased-part prices are preliminary estimates (EIGDAS: never invent quotations).', fix: 'Obtain quotations for NiTi ribbon, etched/bonded plates, housings and the balance of plant; enter them as user/certified values.' });
    out.verdicts.push({ test: 'Shape-setting treatment inside the Af window', status: inWindow ? 'pass' : okCells ? 'warn' : 'fail', detail: `Af ≈ ${fmt(AfSel, 3)} °C (trend), completeness ${fmt(sdSel * 100, 3)} %; window ${fmt(AfMin, 3)}…${fmt(AfMax, 3)} °C from Th = ${d.Th} °C, Tc = ${d.Tc} °C, σH/CA and σL/CM shifts and a ${p.margin} K margin. ${okCells} of ${Tset.length * tset.length} window grid points are feasible.`, fix: okCells ? `Choose a treatment in the positive-margin region, e.g. ${best.T} °C / ${fmt(best.tm, 3)} min (trend Af ≈ ${fmt(best.Af, 3)} °C, margin ${fmt(best.z, 3)}), and confirm by DSC.` : 'No feasible treatment: widen the fluid temperature span, reduce stresses or choose another alloy (Suite 03).' });
    out.verdicts.push({ test: 'Preload capability Cpk ≥ 1.33', status: S1.Cpk >= 1.33 ? 'pass' : S1.Cpk >= 1 ? 'warn' : 'fail', detail: `Cpk = ${fmt(S1.Cpk, 3)}, Monte Carlo out-of-spec ${fmt(S1.out * 100, 3)} %. ${p.adjustable ? 'Adjustable preload' : 'Fixed-length build: a ±' + fmt(S1.rss, 3) + ' mm stack is ±' + fmt(toMPa(S1.rss), 3) + ' MPa'}.`, fix: p.adjustable ? 'Use a finer adjustment screw and a calibrated load cell.' : 'Adopt a mechanically adjustable preload (spec §41) or a match-cut ribbon length per cartridge.' });
    out.verdicts.push({ test: 'Channel-gap capability Cpk ≥ 1.33', status: S2.Cpk >= 1.33 ? 'pass' : S2.Cpk >= 1 ? 'warn' : 'fail', detail: `Cpk = ${fmt(S2.Cpk, 3)} (Cp ${fmt(S2.Cp, 3)}; mean offset ${fmt(S2.mu, 3)} mm). Out-of-spec ${fmt(S2.out * 100, 3)} %.`, fix: 'Centre the etch depth (remove the offset), control plate flatness by lapping, or widen the gap specification if the hydraulic balance tolerates it.' });
    out.verdicts.push({ test: 'Measured manufacturing evidence', status: 'info', detail: 'No first-article inspection, gauge R&R or measured build hours have been imported.', fix: 'Import CMM/FAI reports and the time sheet of the first build to replace the estimated capability and hours.' });
    // ---------------- checks ----------------
    const ck = (name, pass, value, target, detail) => out.checks.push({ name, pass, value, target, detail });
    ck('Monte Carlo σ ≈ analytic RSS σ (preload chain)', Math.abs(S1.sd / S1.sdA - 1) < 0.03, S1.sd / S1.sdA, '1 ± 0.03');
    ck('Monte Carlo σ ≈ analytic RSS σ (gap)', Math.abs(S2.sd / S2.sdA - 1) < 0.03, S2.sd / S2.sdA, '1 ± 0.03');
    ck('Worst case ≥ RSS', S1.wc >= S1.rss - 1e-12 && S2.wc >= S2.rss - 1e-12, S1.wc / S1.rss, '≥ 1');
    ck('BOM total equals sum of rows', Math.abs(B.rows.reduce((a, r) => a + r.total, 0) - B.totals.engine) < 1e-6, B.totals.engine, 'Σ rows');
    ck('BOM mass equals system mass basis', Math.abs(B.totals.mass - B.masses.mSys) / B.masses.mSys < 1e-6, B.totals.mass, fmt(B.masses.mSys, 4) + ' kg');
    ck('Schedule critical path ≤ total hours', makespan <= buildHours + 1e-9, makespan, '≤ ' + fmt(buildHours, 4));
    // ---------------- charts ----------------
    const rowsS = B.rows.slice().sort((a, b) => b.total - a.total);
    out.charts.push({ type: 'bar', horizontal: true, title: 'Engine part cost breakdown (estimate)', categories: rowsS.map(r => r.name), series: [{ name: 'Material', values: rowsS.map(r => r.material) }, { name: 'Processing energy', values: rowsS.map(r => r.energy) }, { name: 'Labour', values: rowsS.map(r => r.labour) }, { name: 'Purchased', values: rowsS.map(r => r.purchased) }, { name: 'Yield loss', values: rowsS.map(r => r.yieldLoss) }], wide: true, explain: 'Cost of each engine component split into material (× buy-to-fly), processing electricity, labour, purchased price and yield loss. Labour dominates a one-off prototype; material dominates only for the NiTi ribbon at volume.' });
    out.charts.push({ type: 'heatmap', title: 'Shape-setting process window: Af (representative trend)', x: { label: 'Shape-setting temperature', unit: '°C', values: Tset }, y: { label: 'Time', unit: 'min', values: tset }, z: Zaf, cmap: 'turbo', isolines: 8, zlabel: 'Af °C', explain: `HYPOTHETICAL representative trend (precipitation-hardening peak near 430 °C). Required window ${fmt(AfMin, 3)} ≤ Af ≤ ${fmt(AfMax, 3)} °C. Selected ${p.setT} °C / ${p.setMin} min → Af ≈ ${fmt(AfSel, 3)} °C. Calibrate the surface with DSC of coupons treated at the window corners.` });
    out.charts.push({ type: 'heatmap', title: 'Process-window feasibility margin', x: { label: 'Shape-setting temperature', unit: '°C', values: Tset }, y: { label: 'Time', unit: 'min', values: tset }, z: Zok.map(r => r.map(v => Math.max(-20, Math.min(20, v)))), cmap: 'coolwarm', isolines: 1, zlabel: 'margin', explain: 'Smallest margin among: Af below the hot limit, Af above the cold limit (both K) and shape-setting completeness above 95 %. Positive (warm colours) = feasible treatment; the isoline marks zero margin.' });
    const hist1 = histogram(S1.arr.map(toMPa), 40), hist2 = histogram(S2.arr, 40);
    out.charts.push({ type: 'area', title: `Preload error distribution (${p.adjustable ? 'adjustable' : 'fixed-length'} build, Monte Carlo)`, x: { label: 'Preload deviation', unit: 'MPa' }, y: { label: 'Count', unit: '' }, series: [{ name: 'Monte Carlo', x: hist1.centers, y: hist1.counts }], annotations: [{ type: 'vline', x: -p.preTol / 100 * d.sigmaL, label: 'LSL' }, { type: 'vline', x: p.preTol / 100 * d.sigmaL, label: 'USL' }], explain: `Distribution of the ribbon preload error from ${nMC} assemblies. Dashed lines: ±${p.preTol} % of σL. Worst case ±${fmt(toMPa(S1.wc), 3)} MPa, RSS ±${fmt(toMPa(S1.rss), 3)} MPa.` });
    out.charts.push({ type: 'area', title: 'Microchannel gap deviation (Monte Carlo)', x: { label: 'Gap deviation', unit: 'mm' }, y: { label: 'Count', unit: '' }, series: [{ name: 'Monte Carlo', x: hist2.centers, y: hist2.counts }], annotations: [{ type: 'vline', x: -S2.lim, label: 'LSL' }, { type: 'vline', x: S2.lim, label: 'USL' }], explain: `Gap error from etch depth (offset ${p.biasEtch} mm), flatness and bond line. The offset shifts the distribution and lowers Cpk (${fmt(S2.Cpk, 3)}) below Cp (${fmt(S2.Cp, 3)}).` });
    out.charts.push({ type: 'bar', title: 'Variance contribution to each stack', categories: [...S1.contrib.map(c => 'Preload: ' + c.name), ...S2.contrib.map(c => 'Gap: ' + c.name)], series: [{ name: 'Share of variance (%)', values: [...S1.contrib.map(c => c.v * 100), ...S2.contrib.map(c => c.v * 100)] }], explain: 'Which tolerance drives each stack. Tighten the largest contributor first — it gives the most capability per unit of manufacturing cost.' });
    out.charts.push({ type: 'scatter', title: 'Build schedule (spec §36 workflow, Gantt)', x: { label: 'Elapsed labour time', unit: 'h' }, y: { label: 'Step', unit: '#' }, wide: true, series: steps.map(s => ({ name: `${s.id}. ${s.name.slice(0, 38)}`, x: [s.start, s.finish], y: [s.id, s.id], mode: 'lines' })), explain: 'Each bar is one workflow step from alloy-lot qualification to the traceability dossier; part fabrication (steps 6–8) runs in parallel. Every step ends at an inspection gate (table).' });
    // ---------------- tables ----------------
    out.tables.push({ title: 'Bill of materials (masses, costs, footprint — estimates)', cols: ['Component', 'Material', 'Qty', 'Mass kg', 'Material USD', 'Labour h', 'Unit total USD', 'CO₂e kg', 'Route', 'Price provenance'], rows: B.rows.map(r => [r.name, r.material, r.count, fmt(r.mass, 3), fmt(r.material, 3), fmt(r.hours, 3), fmt(r.total, 4), fmt(r.co2, 3), r.route, r.purchased ? 'estimated catalogue-class price' : 'estimated']), explain: `Mass basis: ${B.masses.basis}. Totals: ${fmt(B.totals.mass, 4)} kg, ${fmt(B.totals.engine, 4)} USD, ${fmt(B.totals.co2Engine, 3)} kg CO₂e.` });
    out.tables.push({ title: 'Balance of plant (supply, sink, drive, control — spec §39)', cols: ['Item', 'Estimated cost USD', 'Labour h', 'Basis'], rows: B.bop.map(r => [r.name, fmt(r.cost, 4), fmt(r.hours, 3), r.basis]), explain: `Sized from heat input ${fmt(perf.Qhot_W, 4)} W and pump power ${fmt(perf.Ppump_W, 3)} W (${perfProv}).` });
    out.tables.push({ title: 'Assembly sequence with inspection gates (spec §36)', cols: ['#', 'Step', 'Hours', 'Start h', 'Finish h', 'Inspection gate'], rows: steps.map(s => [s.id, s.name, fmt(s.h, 3), fmt(s.start, 3), fmt(s.finish, 3), s.gate]), explain: 'Every production revision preserves dimensional inspection, treatment history, nonconformance and test traceability.' });
    out.tables.push({ title: 'Inspection plan', cols: ['Characteristic', 'Nominal / spec', 'Method / instrument', 'Sampling', 'Acceptance'], rows: [
      ['Ribbon thickness', `${fmt(d.ribbonT * 1e6, 3)} µm`, 'Micrometer / laser gauge', '3 points per ribbon', '±3 %'],
      ['Ribbon length (cut)', `${fmt(L, 4)} mm ± ${p.tolRibbon}`, 'Optical comparator', '100 %', p.adjustable ? 'informative (preload adjusted)' : 'within tolerance'],
      ['Af after shape-setting', `${fmt(AfMin, 3)}…${fmt(AfMax, 3)} °C`, 'DSC (ASTM F2004-type method)', '1 coupon per furnace batch', 'within window'],
      ['Channel depth', `${fmt(hNom, 3)} mm ± ${p.gapTol} %`, 'Profilometer / CMM', 'FAI 100 %, then 5 per plate', `Cpk ≥ 1.33 (now ${fmt(S2.Cpk, 3)})`],
      ['Plate flatness', `≤ ${p.tolFlat} mm`, 'Surface plate & indicator', 'Each plate', 'within tolerance'],
      ['Leak tightness', '1.5 × design pressure', 'Pressure decay / helium sniff', 'Each circuit', 'decay below limit'],
      ['Preload', `σL = ${d.sigmaL} MPa ± ${p.preTol} %`, 'Calibrated load cell', 'Each cartridge', `Cpk ≥ 1.33 (now ${fmt(S1.Cpk, 3)})`],
      ['Rotor balance', 'ISO 21940-11 grade G2.5 (target)', 'Balancing machine', 'Each rotor', 'residual unbalance within grade'],
      ['Stroke (dry test)', `${fmt(d.ribbonL * mat.epsL * 1000 * 0.6, 3)} mm (≈ 60 % of εL·L)`, 'LVDT', 'Each cartridge', '±10 %'],
    ], explain: 'Characteristics that control net work, hydraulic balance and safety, with the instrument and acceptance criterion for each.' });
    out.tables.push({ title: 'Nonconformance log (stored in the project)', cols: ['ID', 'Item', 'Characteristic', 'Issue', 'Action', 'Origin', 'Status'], rows: ncrLog.length ? ncrLog.map(n => [n.id, n.item, n.char, n.issue, n.action, n.origin, n.status]) : [['—', '—', '—', 'No nonconformance predicted or recorded', '—', '—', '—']], explain: 'Predicted entries are generated from this analysis (capability or window violations) and close automatically when no longer predicted; recorded entries come from inspections.' });
    out.tables.push({ title: 'Tolerance stack summary', cols: ['Stack', 'Worst case', 'RSS', 'MC σ', 'MC mean', 'Spec ±', 'Cp', 'Cpk', 'Out of spec'], rows: [['Preload chain (mm)', fmt(S1.wc, 3), fmt(S1.rss, 3), fmt(S1.sd, 3), fmt(S1.mu, 3), fmt(preLimMM, 3), fmt(S1.Cp, 3), fmt(S1.Cpk, 3), fmt(S1.out * 100, 3) + ' %'], ['Channel gap (mm)', fmt(S2.wc, 3), fmt(S2.rss, 3), fmt(S2.sd, 3), fmt(S2.mu, 3), fmt(S2.lim, 3), fmt(S2.Cp, 3), fmt(S2.Cpk, 3), fmt(S2.out * 100, 3) + ' %']], explain: 'Worst case adds tolerances linearly; RSS assumes independent centred contributors at the stated tolerance; Monte Carlo uses σ = t/(3·Cp) and the mean offsets.' });
    // ---------------- explain & recs ----------------
    out.explain.push({ title: 'Build packet', text: `The configured engine (${N} cells × ${d.ribbonsPerCell} ribbons of ${fmt(d.ribbonL * 1000, 3)} × ${fmt(d.ribbonW * 1000, 3)} × ${fmt(d.ribbonT * 1e6, 3)} µm) needs ${partCount} parts. Process routes follow ribbon VIM/VAR → rolling → slitting → shape-setting → training, etched and diffusion-bonded plates, CNC housings and EDM/laser flexures. Costs are estimates for a ${p.units}-unit lot.` });
    out.explain.push({ title: 'Why the preload chain matters', text: `Net work depends on the reset stress σL. A fixed-length build stacks ±${fmt(rssFixed, 3)} mm RSS of length error into the ribbon; with E_t ≈ ${p.Et} GPa that is ±${fmt(toMPa(rssFixed), 3)} MPa, ${fmt(toMPa(rssFixed) / d.sigmaL * 100, 3)} % of σL = ${d.sigmaL} MPa. The first demonstrator therefore uses a mechanically adjustable preload set against a load cell (spec §41).` });
    out.recs.push({ level: S2.Cpk < 1.33 ? 'warn' : 'good', text: S2.Cpk < 1.33 ? `Centre the channel etch: the ${p.biasEtch} mm offset drops gap Cpk to ${fmt(S2.Cpk, 3)} (Cp ${fmt(S2.Cp, 3)}), producing ≈ ±${fmt(3 * dpVar * 100, 3)} % pressure-drop scatter between cells.` : `Channel gap capable (Cpk ${fmt(S2.Cpk, 3)}).`, basis: 'Gap stack Monte Carlo' });
    out.recs.push({ level: S1.Cpk < 1.33 ? 'warn' : 'good', text: S1.Cpk < 1.33 ? `Preload not capable (Cpk ${fmt(S1.Cpk, 3)}): ${p.adjustable ? 'improve adjustment resolution below ' + fmt(p.adjRes / 2, 3) + ' mm' : 'switch to adjustable preload (spec §41)'}.` : `Preload capable (Cpk ${fmt(S1.Cpk, 3)}) with ${p.adjustable ? 'adjustable' : 'fixed'} build.`, basis: 'Preload stack' });
    out.recs.push({ level: inWindow ? 'info' : 'critical', text: inWindow ? `Treatment ${p.setT} °C / ${p.setMin} min is inside the representative window (Af ≈ ${fmt(AfSel, 3)} °C); confirm by DSC of a coupon per furnace batch.` : `Move the shape-setting treatment into the feasible window (Af ≈ ${fmt(AfSel, 3)} °C now vs ${fmt(AfMin, 3)}…${fmt(AfMax, 3)} °C).`, basis: 'Process window (hypothetical trend)' });
    const top = rowsS[0];
    out.recs.push({ level: 'econ', text: `Largest part cost: ${top.name} (${fmt(top.total, 4)} USD, ${fmt(top.labour / Math.max(top.total, 1e-9) * 100, 3)} % labour). Labour is ${fmt(B.totals.labour / B.totals.engine * 100, 3)} % of part cost — fixtures for ribbon cutting/gripping and a multi-ribbon training rig cut the ${fmt(ribbonRow.hours + trainH, 3)} h ribbon work.`, basis: 'BOM' });
    out.recs.push({ level: 'sustain', text: `Embodied footprint ≈ ${fmt(B.totals.co2, 3)} kg CO₂e; NiTi ribbon contributes ${fmt(ribbonRow.co2, 3)} kg for only ${fmt(ribbonRow.mass, 3)} kg. Recover ribbon off-cuts (buy-to-fly 1.4) for remelting and keep housings in recyclable 6061 aluminium.`, basis: 'Materials library co2 × buy-to-fly' });
    // ---------------- view ----------------
    out.views.push({ label: '2D animation: build progress', icon: '🎞', render: (el) => anim2d(el, { duration: makespan, label: 'Elapsed', unit: 'h', height: 26 + steps.length * 22, explain: 'Workflow steps fill as labour time elapses; colour turns green when the inspection gate is reached.', draw: (g, t, W) => { const th = theme(); text(g, `t = ${fmt(t, 3)} h of ${fmt(makespan, 3)} h critical path`, 10, 16, th.accent); steps.forEach((s, i) => { const f = Math.max(0, Math.min(1, (t - s.start) / (s.h || 1))); aBar(g, { x: 10, y: 24 + i * 22, w: W - 20, h: 16, value: f * 100, max: 100, label: `${s.id}. ${s.name.slice(0, 60)}`, color: f >= 1 ? '#22c55e' : '#38bdf8', unit: ' %' }); }); } }) });
    out.outputs = { partCount, buildHours, makespan_h: makespan, toleranceStack_mm: S1.rss, gapStack_mm: S2.rss, Cpk: CpkMin, CpkPreload: S1.Cpk, CpkGap: S2.Cpk, yield: FPY, unitCost_USD: unitCost, engineCost_USD: B.totals.engine, bopCost_USD: B.totals.bop, assemblyCost_USD: assemblyH * p.labourRate, co2_kg: B.totals.co2, mass_kg: B.totals.mass, ribbonCost_USD: ribbonRow.total, AfAfterSet_C: AfSel, priceProvenance: 'estimated' };
    return out;
  },
};
