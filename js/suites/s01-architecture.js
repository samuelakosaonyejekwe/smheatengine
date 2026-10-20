// Suite 01 — Engine architecture and system requirement management.
// Owns the shared engine design: inputs default to the project engine (provenance “calculated”); values the user edits
// here are written back to the project engine after the run (only those keys, once — no feedback loop).
import { linspace, range, fmt, clamp } from '../core/num.js';
import { smaAlloys, get as getMat } from '../core/materials.js';
import { fluidOptions, carnot, curzonAhlborn, ribbonTimescales, KELVIN } from '../core/heat.js';

const APPS = [{ value: 'lab', label: 'Laboratory demonstrator' }, { value: 'industrial', label: 'Industrial waste heat' }, { value: 'research', label: 'Materials research rig' }, { value: 'remote', label: 'Remote mechanical drive' }];
// engine-backed inputs: [param key, engine key, scale (param × scale = engine value)]
const ENG = [['application', 'application', 1], ['variant', 'variant', 1], ['architecture', 'architecture', 1], ['Th', 'Th', 1], ['Tc', 'Tc', 1], ['T0', 'T0', 1], ['targetPower', 'targetPower', 1],
  ['alloy', 'alloy', 1], ['nCells', 'nCells', 1], ['ribbonsPerCell', 'ribbonsPerCell', 1], ['ribbonL_mm', 'ribbonL', 1e-3], ['ribbonW_mm', 'ribbonW', 1e-3], ['ribbonT_um', 'ribbonT', 1e-6],
  ['sigmaL', 'sigmaL', 1], ['sigmaH', 'sigmaH', 1], ['freq', 'freq', 1], ['dutyHot', 'dutyHot', 1], ['regenEff', 'regenEff', 1], ['hotFluid', 'hotFluid', 1], ['coldFluid', 'coldFluid', 1],
  ['transEff', 'transEff', 1], ['controlPower', 'controlPower', 1], ['cartridgeFactor', 'cartridgeFactor', 1], ['systemFactor', 'systemFactor', 1], ['rpm', 'rpm', 1]];
// cooperative yield to the UI; harmless no-op where no animation frame exists (headless runs)
const tick = (ctx) => Promise.resolve().then(() => ctx.yield()).catch(() => {});
const ENGMAP = Object.fromEntries(ENG.map(([k, e, s]) => [k, [e, s]]));
const eAuto = (k) => (ctx) => { const [e, s] = ENGMAP[k]; const v = ctx.engine[e]; return v === undefined ? undefined : { value: typeof v === 'number' && s !== 1 ? +(v / s).toPrecision(10) : v, prov: 'calc' }; };
const P = (key, label, unit, type, def, group, help, extra = {}) => ({ key, label, unit, type, default: def, group, help, ...(ENGMAP[key] ? { auto: eAuto(key) } : {}), ...extra });
const MASS_SPLIT_CART = [['Ribbon end grips & load equalisers', 0.25, 'grip'], ['Heat-exchange plates & thermal interface', 0.45, 'channelPlate'], ['Cartridge housing & sensors', 0.2, 'housing'], ['Bias / preload spring', 0.1, 'biasSpring']];
const MASS_SPLIT_SYS = [['Hot/cold manifolds & distributor', 0.3, 'manifold'], ['Rotor, shaft, clutches & bearings', 0.25, 'rotor'], ['Casing & containment', 0.25, 'casing'], ['Regenerator & fluid inventory', 0.12, 'regenMatrix'], ['Insulation, controls & instruments', 0.08, 'insulation']];
// Architecture B (compliant core) screening modifiers — hypothetical until Architecture A evidence exists
const ARCH_B = { transEffAdd: 0.03, bearingScale: 0.6, systemScale: 0.8, cartScale: 0.9 };

export default {
  description: 'Defines and screens the whole THERMA-X100 engine: application, variant, reservoirs, envelope, target power and mass budget. Compares Architecture A (rotary multicell) with the gated Architecture B (compliant core) and cell-count / ribbon options, traces every requirement to a computed value, closes first- and second-law balances and reports specific power on three separate mass bases.',
  literature: 'shape memory alloy heat engine multicell architecture specific power low-grade heat',
  econ: true, sustain: true, credibility: 'Analytical screening',
  equations: [
    'P_net = N·W_out·f·η_tr − P_bearing − P_pump,hot − P_pump,cold − P_valves − P_control (net = gross − reset − losses − all auxiliaries)',
    'Q_hot = N·f·(Q_hot,cell − ε_regen·Q_sensible,cell + Q_purge); the latent part ρ·L_h·Δξ cannot be regenerated; Q_purge = φ·C_channel-fluid·(T_h − T_c) is the re-heat of displaced channel fluid at each switch',
    'First law: Q_hot = P_gross + Q_rej (cycle-averaged, steady periodic state)',
    'η_th = P_net/Q_hot ≤ η_Carnot = 1 − T_c/T_h (absolute temperatures); Curzon–Ahlborn η_CA = 1 − √(T_c/T_h) as finite-time reference',
    'Exergy of heat input Ẋ_Q = Q_hot·(1 − T_0/T_h); exergy efficiency ψ = P_net/Ẋ_Q; entropy generation Ṡ_gen = Q_rej/T_c − Q_hot/T_h ≥ 0',
    'Specific power on three separate bases: p_SMA = P_net/m_active, p_cart = P_net/m_cartridge, p_sys = P_net/m_system',
    'Cells for target: N* = ⌈(P_target + P_control + P_bearing)/(W_out·f·η_tr − (P_pump + P_valves)/N)⌉',
    'Dimensional analysis: Bi = U·(t/2)/k, t_diff = (t/2)²/α, Fo = α·t_heat/(t/2)², τ = ρ·c_p·(t/2)/U·(1 + Bi/3), Ste = c_p·ΔT/L_h',
    'Stress-shifted transformation window (Clausius–Clapeyron): A_f(σ_H) = A_f + σ_H/C_A ≤ T_h, M_f(σ_L) = M_f + σ_L/C_M ≥ T_c',
    'Functional fatigue trend N_f = N₀·(ε₀/ε_tr)^a·(σ₀/σ_H)^b versus required cycles N_req = years·hours·3600·f',
  ],
  methods: [
    'Pre-screen (engine.preScreen) of reservoir/alloy/stress compatibility before any solve.',
    'Reference evaluation engine.engineModel: one transient ribbon cell (finite-volume half-thickness conduction, Brinson-type kinetics, one-way clutch load) iterated once with the duct-flow heat-transfer coefficient, scaled to N cells with pump, valve, control and bearing auxiliaries.',
    'Cell-count sweep re-uses the solved cell (array scaling is linear in N, auxiliaries are re-evaluated per N); frequency sweep and architecture/ribbon candidates re-solve the cell at reduced resolution (expert controls).',
    'Architecture B evaluated on the same solved cell with hypothetical compliant-transmission modifiers (transmission efficiency +3 points, bearing loss ×0.6, system mass ×0.8, cartridge mass ×0.9) and flagged as gated.',
    'Independent energy arithmetic: P_net and Q_rej recomputed in this suite from the cell results and compared with the engine model.',
    'Envelope estimate: radial cartridge layout around a 60 mm hub; cartridges packed per ring by circumferential pitch; axial length from ring count plus manifolds and bearings (unless Suite 02 publishes an envelope).',
  ],
  assumptions: [
    'Cycle-averaged steady periodic operation; start-up, shutdown and off-design transients are handled in Suite 15.',
    'Cartridge and system masses follow the engine mass factors (or Suite 02 when available); the component split of those masses is an estimate for budgeting only.',
    'Architecture B modifiers are hypothetical screening values with no experimental support; Architecture B is gated on Architecture A evidence (master specification §6).',
    'Library alloy properties are representative, not lot-certified; transformation temperatures carry the library uncertainty.',
    'Auxiliary loads: pumps from duct-flow pressure drop ×1.5 for manifolds/valves, valve energy per switching event, fixed control power.',
    'Carnot and Curzon–Ahlborn bounds use the fluid supply temperatures as reservoir temperatures.',
  ],
  ibc: {
    initial: ['Ribbons cold, fully martensitic and pre-extended at the reset stress σ_L (prepared working state).', 'Wall and ribbon at the cold-fluid temperature; the cell is cycled until the last two cycles agree (periodic state).'],
    boundary: ['Hot and cold fluid supply temperatures T_h, T_c alternate with duty D and switching ramp t_switch.', 'Mechanical: constant reset (bias) stress σ_L plus output load (σ_H − σ_L) engaged by a one-way clutch only while contracting in the hot phase.', 'Dead state T_0 for exergy.'],
  },
  cvv: {
    calibration: ['Alloy transformation temperatures, latent heat and stress coefficients from DSC and tensile tests (Suite 03).', 'Fluid-side heat-transfer coefficient and contact conductance from instrumented heating/cooling tests (Suite 08).'],
    verification: ['Independent energy arithmetic of P_net and Q_rej against the engine model (relative difference < 1e-9).', 'Cell first-law residual |r| < 1 % of Q_hot and cycle periodicity.', 'η ≤ η_Carnot and Ṡ_gen ≥ 0.', 'Requirement trace: each requirement maps to a computed value and a verifying suite.'],
    validation: ['V2 single-cartridge calorimetry (positive net closed-cycle work).', 'V3 six or more phased cartridges with measured average shaft power on a calibrated dynamometer.'],
  },
  formats: { import: ['Project JSON (engine design)', 'CSV requirement list (id, requirement, target)'], export: ['Design JSON', 'Requirement matrix CSV', 'Mass & thermal budget CSV', 'PNG/SVG/CSV plots'] },
  params: [
    P('application', 'Application', '', 'select', 'lab', 'Mission & variant', 'Sets the requirement profile (instrumentation, auxiliary-power limits, minimum source temperature).', { options: APPS }),
    P('variant', 'Variant', '', 'select', 'LT', 'Mission & variant', 'LT: hot source ≈ 40–90 °C. HT: industrial streams above ≈ 90 °C with high-temperature alloys.', { options: [{ value: 'LT', label: 'THERMA-X100-LT (low temperature)' }, { value: 'HT', label: 'THERMA-X100-HT (high temperature)' }] }),
    P('architecture', 'Architecture', '', 'select', 'A', 'Mission & variant', 'A: instrumented rotary multicell engine (baseline). B: compliant reduced-motion core — gated on Architecture A evidence.', { options: [{ value: 'A', label: 'A — rotary multicell (baseline)' }, { value: 'B', label: 'B — compliant core (gated)' }] }),
    P('Th', 'Hot-source fluid temperature', '°C', 'number', 70, 'Reservoirs', 'Supply temperature of the hot fluid at the cartridge inlet.', { min: 20, max: 300, step: 1 }),
    P('Tc', 'Cold-sink fluid temperature', '°C', 'number', 15, 'Reservoirs', 'Supply temperature of the cold fluid.', { min: -20, max: 80, step: 1 }),
    P('T0', 'Dead-state (ambient) temperature', '°C', 'number', 20, 'Reservoirs', 'Reference for exergy.', { min: -30, max: 50, step: 1 }),
    P('targetPower', 'Target net shaft power', 'W', 'number', 50, 'Requirements', 'Net power after all auxiliaries at the shaft measurement station.', { min: 0.1, max: 100000, step: 1 }),
    P('massBudget', 'Active SMA mass budget', 'kg', 'number', 0.5, 'Requirements', 'Maximum active alloy mass (cost and supply limit).', { min: 0.001, max: 100, step: 0.01 }),
    P('sysMassLimit', 'Complete-engine mass limit', 'kg', 'number', 25, 'Requirements', 'Maximum installed engine mass.', { min: 0.1, max: 10000, step: 0.5 }),
    P('envD', 'Installation envelope — diameter', 'mm', 'number', 600, 'Requirements', 'Maximum outer diameter available.', { min: 50, max: 5000, step: 10 }),
    P('envL', 'Installation envelope — length', 'mm', 'number', 800, 'Requirements', 'Maximum axial length available.', { min: 50, max: 10000, step: 10 }),
    P('lifeYears', 'Design life', 'years', 'number', 2, 'Requirements', 'Lifecycle requirement for the active elements before replacement.', { min: 0.01, max: 40, step: 0.5 }),
    P('hoursYear', 'Operating hours per year', 'h/yr', 'number', 2000, 'Requirements', 'Duty for the lifecycle requirement.', { min: 1, max: 8760, step: 100 }),
    P('minCarnotFrac', 'Minimum fraction of Carnot (requirement)', '', 'number', 0.02, 'Requirements', 'Project acceptance level for thermal efficiency relative to Carnot (research goal 0.5–0.7 is aspirational).', { min: 0, max: 1, step: 0.01 }),
    P('alloy', 'Active alloy', '', 'select', 'niti-lt', 'Active cells', 'Library alloy (characterise in Suite 03).', { options: smaAlloys().map(m => ({ value: m.id, label: m.name })) }),
    P('nCells', 'Number of cells', '', 'number', 12, 'Active cells', 'Phased cartridges on the common shaft.', { min: 1, max: 500, step: 1 }),
    P('ribbonsPerCell', 'Ribbons per cell', '', 'number', 20, 'Active cells', 'Parallel ribbons in one cartridge bundle.', { min: 1, max: 500, step: 1 }),
    P('ribbonL_mm', 'Ribbon active length', 'mm', 'number', 100, 'Active cells', '', { min: 10, max: 1000, step: 1 }),
    P('ribbonW_mm', 'Ribbon width', 'mm', 'number', 5, 'Active cells', '', { min: 0.5, max: 50, step: 0.1 }),
    P('ribbonT_um', 'Ribbon thickness', 'µm', 'number', 100, 'Active cells', 'Thinner ribbons shorten the diffusion time ∝ t².', { min: 10, max: 2000, step: 5 }),
    P('sigmaL', 'Cold reset (bias) stress σL', 'MPa', 'number', 70, 'Operating point', '', { min: 0, max: 600, step: 1 }),
    P('sigmaH', 'Hot power-stroke stress σH', 'MPa', 'number', 110, 'Operating point', '', { min: 1, max: 800, step: 1 }),
    P('freq', 'Cycle frequency', 'Hz', 'number', 1, 'Operating point', '', { min: 0.01, max: 50, step: 0.05 }),
    P('dutyHot', 'Hot-phase fraction', '', 'number', 0.5, 'Operating point', '', { min: 0.1, max: 0.9, step: 0.05 }),
    P('regenEff', 'Regenerator effectiveness', '', 'number', 0.6, 'Thermal circuit', 'Fraction of sensible cell heat recovered (Suite 09).', { min: 0, max: 0.95, step: 0.05 }),
    P('hotFluid', 'Hot-circuit fluid', '', 'select', 'fl-water', 'Thermal circuit', '', { options: fluidOptions }),
    P('coldFluid', 'Cold-circuit fluid', '', 'select', 'fl-water', 'Thermal circuit', '', { options: fluidOptions }),
    P('transEff', 'Transmission efficiency', '', 'number', 0.9, 'Transmission & auxiliaries', 'Clutch/cam/linkage efficiency (Suites 10–11).', { min: 0.3, max: 1, step: 0.01 }),
    P('controlPower', 'Control & sensing power', 'W', 'number', 2, 'Transmission & auxiliaries', 'Counted against net output.', { min: 0, max: 500, step: 0.5 }),
    P('rpm', 'Shaft speed', 'rpm', 'number', 60, 'Transmission & auxiliaries', '', { min: 1, max: 6000, step: 1 }),
    P('cartridgeFactor', 'Cartridge-to-active mass factor', '', 'number', 6, 'Mass bases', 'Cartridge mass / active SMA mass (grips, plates, housing, spring).', { min: 1, max: 100, step: 0.5, expert: true }),
    P('systemFactor', 'System-to-active mass factor', '', 'number', 35, 'Mass bases', 'Complete engine mass / active SMA mass.', { min: 2, max: 1000, step: 1, expert: true }),
    P('nNodes', 'Cell solver: half-thickness nodes', '', 'number', 3, 'Solver (expert)', 'Finite-volume cells through the ribbon half-thickness for the reference cell.', { min: 1, max: 12, step: 1, expert: true }),
    P('spc', 'Cell solver: time steps per cycle', '', 'number', 160, 'Solver (expert)', '', { min: 60, max: 1000, step: 10, expert: true }),
    P('cycles', 'Cell solver: cycles to periodic state', '', 'number', 3, 'Solver (expert)', '', { min: 2, max: 10, step: 1, expert: true }),
    P('sweepRes', 'Sweep resolution (steps per cycle)', '', 'number', 100, 'Solver (expert)', 'Reduced resolution for frequency sweep and candidate comparison.', { min: 60, max: 400, step: 10, expert: true }),
  ],
  presets: [
    { label: 'Lab demonstrator (LT, 70/15 °C, 50 W)', values: { application: 'lab', variant: 'LT', architecture: 'A', Th: 70, Tc: 15, targetPower: 50, alloy: 'niti-lt', sigmaL: 70, sigmaH: 110, freq: 1 } },
    { label: 'Industrial waste heat (HT, 190/40 °C oil, 100 W)', values: { application: 'industrial', variant: 'HT', architecture: 'A', Th: 190, Tc: 40, T0: 25, targetPower: 100, alloy: 'nitihf', sigmaL: 260, sigmaH: 360, freq: 0.5, hotFluid: 'fl-oil', coldFluid: 'fl-water', massBudget: 3, sysMassLimit: 150, envD: 1500, envL: 2000 } },
    { label: 'Materials research rig (3 cells)', values: { application: 'research', variant: 'LT', architecture: 'A', nCells: 3, targetPower: 1, Th: 70, Tc: 15, controlPower: 0.5 } },
    { label: 'Remote drive (85/25 °C, 100 W)', values: { application: 'remote', variant: 'LT', architecture: 'A', Th: 85, Tc: 25, T0: 30, targetPower: 100, controlPower: 1, alloy: 'niti-lt', sigmaL: 60, sigmaH: 120 } },
    { label: 'Architecture B screening (gated)', values: { architecture: 'B' } },
  ],

  async run(p, ctx) {
    const { eng, sma, store } = ctx;
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    // ---- assemble the design from engine-backed inputs
    const over = {}; for (const [k, e, s] of ENG) if (p[k] !== undefined) over[e] = typeof p[k] === 'number' && s !== 1 ? +(p[k] * s).toPrecision(12) : p[k];
    const d = eng.designWith(ctx.engine, over), mat = getMat(d.alloy);
    const pre = eng.preScreen(d, mat);
    out.verdicts.push(...pre);
    if (!mat || d.Th <= d.Tc + 1 || d.sigmaH <= d.sigmaL) {
      const why = !mat ? `Unknown alloy “${d.alloy}”.` : d.Th <= d.Tc + 1 ? `Hot source ${d.Th} °C is not above the sink ${d.Tc} °C: no heat-engine cycle exists.` : `σH = ${d.sigmaH} MPa does not exceed σL = ${d.sigmaL} MPa: the enclosed work loop has zero or negative area.`;
      return { ...out, headline: 'Infeasible design — ' + why, headlineKind: 'fail', explain: [why + ' The engine model was not run because the result would be physically meaningless.'], kpis: [{ label: 'Feasibility', value: 'infeasible', explain: why, status: 'bad' }], outputs: { design: d, architecture: d.architecture, Pnet_W: 0, infeasible: true }, credibility: 'Conceptual' };
    }
    ctx.progress(0.05, 'reference cell');
    const solve = (dd, o = {}) => eng.engineModel(dd, { mat, n: p.nNodes, stepsPerCycle: p.spc, cycles: p.cycles, ...o });
    const A = solve({ ...d, architecture: 'A' }), c = A.cell;
    const dB = { ...d, architecture: 'B', transEff: Math.min(0.98, d.transEff + ARCH_B.transEffAdd), bearingLoss: d.bearingLoss * ARCH_B.bearingScale, systemFactor: d.systemFactor * ARCH_B.systemScale, cartridgeFactor: d.cartridgeFactor * ARCH_B.cartScale };
    const B = eng.engineModel(dB, { mat, cell: c });
    const M = d.architecture === 'B' ? B : A, dM = d.architecture === 'B' ? dB : d;
    await tick(ctx);

    // ---- mass bases (Suite 02 geometry when available)
    const s02 = ctx.upstream('s02');
    let mCart = M.mCart, mSys = M.mSys, massProv = 'calc';
    if (s02?.cartridgeMass_kg > 0) { mCart = s02.cartridgeMass_kg * d.nCells; massProv = 'coupled'; }
    if (s02?.engineMass_kg > 0) { mSys = s02.engineMass_kg; massProv = 'coupled'; }
    const pActive = M.Pnet / M.mActive, pCart = M.Pnet / mCart, pSys = M.Pnet / mSys;

    // ---- independent energy arithmetic
    const Pgross2 = d.nCells * c.Wout * d.freq, Pnet2 = Pgross2 * dM.transEff - dM.bearingLoss - (M.Ppump + M.Pvalves + d.controlPower);
    const lat2 = c.mass * (mat.Lh || 0) * c.xiSwing, sens2 = Math.max(0, c.Qhot - lat2 - c.Wout), Qhot2 = d.nCells * d.freq * (c.Qhot - d.regenEff * sens2 + (M.Qpurge || 0)), Qrej2 = Qhot2 - Pgross2;
    const ThK = d.Th + KELVIN, TcK = d.Tc + KELVIN, Sgen = M.QrejTot / TcK - M.QhotTot / ThK;
    const etaC = carnot(d.Th, d.Tc), etaCA = curzonAhlborn(d.Th, d.Tc);

    // ---- envelope estimate
    const plate = 0.8e-3, stack = d.ribbonsPerCell * (d.ribbonT + plate + d.chH) + 0.01, Lc = d.ribbonL * 1.5 + 0.03, wc = d.ribbonW + 0.02, rHub = 0.06;
    const perRing = Math.max(1, Math.floor(2 * Math.PI * rHub / (stack + 0.005))), rings = Math.ceil(d.nCells / perRing);
    let envD = 2 * (rHub + Lc) + 0.04, envL = rings * (wc + 0.01) + 0.1, envProv = 'estimated';
    if (s02?.envelope?.D > 0 && s02?.envelope?.L > 0) { envD = s02.envelope.D; envL = s02.envelope.L; envProv = 'coupled'; }

    // ---- lifecycle
    const epsTr = c.stroke / d.ribbonL, Nf = sma.fatigueLife(mat, Math.max(epsTr, 1e-5), d.sigmaH), Nreq = p.lifeYears * p.hoursYear * 3600 * d.freq;

    // ---- candidates (architecture & cell/ribbon options)
    ctx.progress(0.35, 'architecture candidates');
    const lo = { n: Math.min(2, p.nNodes), stepsPerCycle: p.sweepRes, cycles: 3 };
    const Nstar = Number.isFinite(A.cellsForTarget) ? clamp(A.cellsForTarget, 1, 2000) : null;
    const cand = [
      { name: `A — ${d.nCells} cells × ${d.ribbonsPerCell} ribbons (baseline)`, r: A, d },
      { name: `B — compliant core, ${d.nCells} cells (gated, hypothetical)`, r: B, d: dB },
    ];
    if (Nstar && Nstar !== d.nCells) cand.push({ name: `A — ${Nstar} cells (cells for target)`, r: eng.engineModel({ ...d, nCells: Nstar }, { mat, cell: c }), d: { ...d, nCells: Nstar } });
    const d2 = { ...d, ribbonsPerCell: d.ribbonsPerCell * 2 }; cand.push({ name: `A — ${d.nCells} cells × ${d2.ribbonsPerCell} ribbons`, r: eng.engineModel(d2, { mat, ...lo }), d: d2 });
    const d3 = { ...d, ribbonT: d.ribbonT / 2, ribbonsPerCell: d.ribbonsPerCell * 2, freq: d.freq * 2 }; cand.push({ name: `A — half-thickness ${fmt(d3.ribbonT * 1e6, 3)} µm ribbons at ${fmt(d3.freq, 3)} Hz`, r: eng.engineModel(d3, { mat, ...lo }), d: d3 });
    await tick(ctx);

    // ---- sweeps
    ctx.progress(0.55, 'frequency sweep');
    const Nmax = Math.max(2 * d.nCells, Nstar ? Math.min(Nstar * 1.3, 400) : 0, 6), Ns = [...new Set(linspace(1, Nmax, 30).map(Math.round))];
    const sweepN = Ns.map(N => { const r = eng.engineModel({ ...dM, nCells: N }, { mat, cell: c }); return { N, Pnet: r.Pnet, Pgross: r.Pgross, Paux: r.Paux }; });
    const fs = [0.25, 0.5, 1, 1.5, 2, 3].map(x => x * d.freq);
    const sweepF = []; for (const f of fs) { const r = eng.engineModel({ ...dM, freq: f }, { mat, ...lo }); sweepF.push({ f, pA: r.Pnet / r.mActive, pAg: r.Pgross / r.mActive, pC: r.Pnet / r.mCart, pS: r.Pnet / r.mSys, xi: r.cell.xiSwing }); await tick(ctx); }
    ctx.progress(0.85, 'requirements');

    // ---- dimensional analysis
    const Uh = 1 / (1 / M.hHotUsed + 1 / d.hContact), Uc = 1 / (1 / M.hColdUsed + 1 / d.hContact);
    const tsH = ribbonTimescales({ t: d.ribbonT, k: mat.k, rho: mat.rho, cp: mat.cp, h: Uh }), tsC = ribbonTimescales({ t: d.ribbonT, k: mat.kM || mat.k, rho: mat.rho, cp: mat.cp, h: Uc });
    const tHeat = d.dutyHot / d.freq, tCool = (1 - d.dutyHot) / d.freq, FoH = tsH.alpha * tHeat / (d.ribbonT / 2) ** 2;
    const Ste = mat.cp * (d.Th - d.Tc) / (mat.Lh || 1), dims = [
      ['Biot number (hot, ribbon half-thickness)', tsH.Bi, '–', tsH.Bi < 0.1 ? 'Lumped ribbon temperature valid' : 'Through-thickness gradients matter'],
      ['Diffusion time t_diff = (t/2)²/α', tsH.tDiff, 's', 'Intrinsic conduction scale of the ribbon'],
      ['Fourier number of the hot phase', FoH, '–', FoH > 1 ? 'Conduction is not limiting' : 'Conduction-limited heating'],
      ['Lumped time constant (hot, incl. contact)', tsH.tauBiot, 's', `${fmt(tsH.tauBiot / tHeat, 3)} of the hot dwell`],
      ['Lumped time constant (cold, incl. contact)', tsC.tauBiot, 's', `${fmt(tsC.tauBiot / tCool, 3)} of the cold dwell`],
      ['Stefan number c_p·ΔT/L_h', Ste, '–', Ste > 1 ? 'Sensible heat dominates: regeneration is valuable' : 'Latent heat dominates'],
      ['Hot-channel Reynolds number', M.hydH.Re, '–', M.hydH.regime],
      ['Cold-channel Reynolds number', M.hydC.Re, '–', M.hydC.regime],
      ['Thermal-to-cycle period ratio (τ_h + τ_c)·f', (tsH.tauBiot + tsC.tauBiot) * d.freq, '–', 'Must stay ≲ 0.3 for complete transformation'],
    ];

    // ---- requirement matrix
    const minTh = { lab: 40, industrial: 90, research: 30, remote: 50 }[d.application] ?? 40;
    const req = [];
    const R = (id, text, src, target, value, status, trace) => req.push({ id, text, src, target, value, status, trace });
    R('R01', 'Strictly positive net shaft power after all auxiliaries', 'Spec §1, §27', 'P_net > 0', `${fmt(M.Pnet, 4)} W`, M.Pnet > 0 ? 'pass' : 'fail', 'S01 → S14, S18');
    R('R02', 'Target net shaft power delivered', 'User requirement', `≥ ${fmt(d.targetPower, 4)} W`, `${fmt(M.Pnet, 4)} W (needs ${Nstar ?? '∞'} cells)`, M.Pnet >= d.targetPower ? 'pass' : 'fail', 'S01, S12, S18');
    R('R03', 'Thermal efficiency bounded by Carnot', 'Spec §2', `η ≤ ${fmt(etaC * 100, 4)} %`, `${fmt(M.eta * 100, 4)} %`, M.eta <= etaC + 1e-12 ? 'pass' : 'fail', 'S18');
    R('R04', 'Thermal efficiency ≥ minimum Carnot fraction', 'Project acceptance', `η/η_C ≥ ${fmt(p.minCarnotFrac, 3)}`, fmt(M.carnotFraction, 4), M.carnotFraction >= p.minCarnotFrac ? 'pass' : 'warn', 'S09, S18');
    const pf = (t) => pre.find(x => x.test.startsWith(t))?.status || 'info';
    R('R05', 'Hot fluid completes reverse transformation under σH', 'Spec §10', 'A_f(σH) ≤ T_h', `A_f(σH) = ${fmt(mat.Af + d.sigmaH / mat.CA, 4)} °C`, pf('Hot fluid'), 'S03, S04');
    R('R06', 'Cold sink completes forward transformation under σL', 'Spec §10', 'M_f(σL) ≥ T_c', `M_f(σL) = ${fmt(mat.Mf + d.sigmaL / mat.CM, 4)} °C`, pf('Cold sink'), 'S03, S04, S07');
    R('R07', 'Active SMA mass within budget', 'User requirement', `≤ ${fmt(p.massBudget, 4)} kg`, `${fmt(M.mActive, 4)} kg`, M.mActive <= p.massBudget ? 'pass' : 'fail', 'S02, S05');
    R('R08', 'Complete engine mass within limit', 'User requirement', `≤ ${fmt(p.sysMassLimit, 4)} kg`, `${fmt(mSys, 4)} kg (${massProv})`, mSys <= p.sysMassLimit ? 'pass' : 'fail', 'S02, S20');
    R('R09', 'Outer diameter within envelope', 'Installation', `≤ ${fmt(p.envD, 4)} mm`, `${fmt(envD * 1000, 4)} mm (${envProv})`, envD * 1000 <= p.envD ? 'pass' : 'fail', 'S02');
    R('R10', 'Axial length within envelope', 'Installation', `≤ ${fmt(p.envL, 4)} mm`, `${fmt(envL * 1000, 4)} mm (${envProv})`, envL * 1000 <= p.envL ? 'pass' : 'fail', 'S02');
    R('R11', 'Active specific net power ≥ published reference', 'Spec §3', `≥ ${eng.REFERENCE_W_PER_KG} W/kg`, `${fmt(pActive, 4)} W/kg`, pActive >= eng.REFERENCE_W_PER_KG ? 'pass' : 'warn', 'S05, S18');
    R('R12', 'Functional-fatigue life covers the lifecycle requirement', 'Lifecycle requirement', `≥ ${fmt(Nreq, 3)} cycles`, `${fmt(Nf, 3)} cycles`, Nf >= Nreq ? 'pass' : 'fail', 'S16');
    R('R13', 'Source temperature suits the variant', 'Spec §4', d.variant === 'LT' ? '40–90 °C' : '> 90 °C', `${d.Th} °C`, d.variant === 'LT' ? (d.Th >= 40 && d.Th <= 90 ? 'pass' : 'warn') : (d.Th > 90 ? 'pass' : 'warn'), 'S06');
    R('R14', 'Source temperature suits the application', 'Application profile', `≥ ${minTh} °C`, `${d.Th} °C`, d.Th >= minTh ? 'pass' : 'warn', 'S06');
    if (d.application === 'remote') R('R15', 'Remote drive: auxiliaries ≤ 20 % of gross shaft power', 'Spec §19', '≤ 20 %', `${fmt(100 * M.Paux / Math.max(1e-9, M.Pshaft), 3)} %`, M.Paux <= 0.2 * M.Pshaft ? 'pass' : 'fail', 'S13, S21');
    if (d.application === 'lab' || d.application === 'research') R('R15', 'Instrumented, replaceable cartridges (diagnostic clarity)', 'Spec §5', 'Force, stroke, T and flow sensing per cartridge', 'Design rule — verify in CAD/BOM', 'info', 'S02, S19');
    if (d.application === 'industrial') R('R15', 'Industrial: alloy rated for the source temperature', 'Spec §21', `T_max(alloy) ≥ ${d.Th} °C`, `${mat.Tmax} °C`, mat.Tmax >= d.Th ? 'pass' : 'fail', 'S03');
    R('R16', 'Architecture B gated on Architecture A evidence', 'Spec §6', 'A: V3 shaft power, V5 durability evidence', d.architecture === 'B' ? 'B selected without evidence' : 'A selected', d.architecture === 'B' ? 'warn' : 'pass', 'S19');
    R('R17', 'Second law: entropy generation non-negative', 'Spec §2', 'Ṡ_gen ≥ 0', `${fmt(Sgen, 4)} W/K`, Sgen >= -1e-9 ? 'pass' : 'fail', 'S18');

    // ---- verdicts (requirements failing become verdicts with fixes)
    if (d.architecture === 'B') out.verdicts.push({ test: 'Architecture B gate', status: 'warn', detail: 'Architecture B (compliant reduced-motion core) is a downstream investigation gated on sustained power, thermal stability and fatigue evidence from Architecture A. Its results here use hypothetical transmission and mass modifiers.', fix: 'Establish Architecture A evidence (validation gates V3 and V5) before releasing an Architecture B design.' });
    out.verdicts.push({ test: 'Net power positive after all auxiliaries', status: M.Pnet > 0 ? 'pass' : 'fail', detail: `P_net = ${fmt(M.Pnet, 4)} W = gross ${fmt(M.Pgross, 4)} W × η_tr ${d.transEff} − bearing ${fmt(dM.bearingLoss, 3)} W − pumps ${fmt(M.Ppump, 3)} W − valves ${fmt(M.Pvalves, 3)} W − control ${fmt(d.controlPower, 3)} W.`, fix: 'Raise per-cell net work (σH − σL, ribbon count), lower pump/valve power (Suite 13) or reduce the frequency to complete the transformation.' });
    out.verdicts.push({ test: 'Target power', status: M.Pnet >= d.targetPower ? 'pass' : (Nstar ? 'warn' : 'fail'), detail: `${fmt(M.Pnet, 4)} W delivered vs ${d.targetPower} W required. ${Nstar ? `${Nstar} cells of this design would meet it (${fmt(Nstar * c.mass, 3)} kg active SMA).` : 'Adding cells cannot meet it: each added cell costs more auxiliary power than it delivers.'}`, fix: Nstar ? `Increase to ${Nstar} cells or raise per-cell work.` : 'Fix the per-cell net balance first (stress window, frequency, pump losses).' });
    out.verdicts.push({ test: 'Envelope and mass limits', status: envD * 1000 <= p.envD && envL * 1000 <= p.envL && mSys <= p.sysMassLimit && M.mActive <= p.massBudget ? 'pass' : 'fail', detail: `D ≈ ${fmt(envD * 1000, 4)} / ${p.envD} mm, L ≈ ${fmt(envL * 1000, 4)} / ${p.envL} mm (${perRing} cartridges per ring, ${rings} rings; ${envProv}); system ${fmt(mSys, 4)} / ${p.sysMassLimit} kg; active ${fmt(M.mActive, 4)} / ${p.massBudget} kg.`, fix: 'Use shorter ribbons or more cartridges per ring (larger hub), relax the envelope, or reduce cell count by raising per-cell work.' });
    out.verdicts.push({ test: 'Lifecycle (functional fatigue)', status: Nf >= Nreq ? 'pass' : 'fail', detail: `Transformation strain ${fmt(epsTr * 100, 3)} % at σH = ${d.sigmaH} MPa gives ≈ ${fmt(Nf, 3)} cycles (literature trend) vs ${fmt(Nreq, 3)} required (${p.lifeYears} yr × ${p.hoursYear} h × ${d.freq} Hz).`, fix: 'Limit the stroke (cam stops), lower σH, plan cartridge replacement intervals, or select a low-fatigue alloy (Suite 16).' });
    out.verdicts.push({ test: 'Measured data required', status: 'info', detail: `Library alloy “${mat.name}” is evidence class “${mat.evidence}” (±${mat.unc} %). Required before a validated claim: DSC of the ribbon lot, isothermal tensile loops at ≥ 3 temperatures, contact conductance at operating pressure, and single-cartridge calorimetry (V2).` });

    // ---- KPIs
    const st = (ok, warn) => ok ? 'ok' : warn ? 'warn' : 'bad';
    out.kpis.push(
      { label: 'Net shaft power', value: M.Pnet, unit: 'W', status: st(M.Pnet >= d.targetPower, M.Pnet > 0), prov: 'calc', explain: 'Gross cell work × frequency × cells × transmission efficiency, minus bearing, pumping, valve and control power. This is the exported power — never the positive-stroke gross work.' },
      { label: 'Cells needed for target', value: Nstar ?? 'unreachable — per-cell net is negative', unit: Nstar ? 'cells' : '', status: Nstar ? (Nstar <= d.nCells ? 'ok' : 'warn') : 'bad', prov: 'calc', explain: 'Smallest number of identical cells whose net contribution covers the target plus fixed control and bearing loads.' },
      { label: 'Specific net power — active SMA basis', value: pActive, unit: 'W/kg', status: st(pActive >= eng.REFERENCE_W_PER_KG, pActive > 0), prov: 'calc', explain: `P_net per kilogram of active alloy; the published reference is ${eng.REFERENCE_W_PER_KG} W/kg (ratio ${fmt(pActive / eng.REFERENCE_W_PER_KG, 3)}×).` },
      { label: 'Specific net power — cartridge basis', value: pCart, unit: 'W/kg', prov: massProv, explain: 'P_net per kilogram of complete cartridges (ribbons, grips, plates, housings, springs). Not comparable with the active-basis figure.' },
      { label: 'Specific net power — system basis', value: pSys, unit: 'W/kg', prov: massProv, explain: 'P_net per kilogram of the complete engine (manifolds, rotor, casing, fluids, controls).' },
      { label: 'Thermal efficiency', value: M.eta * 100, unit: '%', status: st(M.carnotFraction >= p.minCarnotFrac, M.eta > 0), prov: 'calc', explain: `Net power over external heat input after regeneration. Carnot bound ${fmt(etaC * 100, 4)} %; fraction of Carnot ${fmt(M.carnotFraction, 3)}.` },
      { label: 'Heat input from the source', value: M.QhotTot, unit: 'W', prov: 'calc', explain: 'Cycle-averaged heat drawn from the hot fluid after the regenerator has recycled part of the sensible heat.' },
      { label: 'Complete engine mass', value: mSys, unit: 'kg', status: st(mSys <= p.sysMassLimit), prov: massProv, explain: 'System mass used for the system specific power and the mass requirement.' },
      { label: 'Requirements passed', value: `${req.filter(r => r.status === 'pass').length} / ${req.length}`, status: req.some(r => r.status === 'fail') ? 'bad' : req.some(r => r.status === 'warn') ? 'warn' : 'ok', explain: 'Count of requirement-matrix rows that pass; warnings and failures are listed with trace and fixes.' },
    );

    // ---- charts
    out.charts.push({ type: 'line', title: 'Net, gross and auxiliary power vs number of cells', x: { label: 'Number of cells N' }, y: { label: 'Power', unit: 'W' },
      series: [{ name: 'Net shaft power', x: sweepN.map(s => s.N), y: sweepN.map(s => s.Pnet) }, { name: 'Gross cell power', x: sweepN.map(s => s.N), y: sweepN.map(s => s.Pgross), dash: '6 4' }, { name: 'Auxiliaries', x: sweepN.map(s => s.N), y: sweepN.map(s => s.Paux), dash: '2 3' }],
      annotations: [{ type: 'hline', y: d.targetPower, label: 'Target' }, { type: 'vline', x: d.nCells, label: 'Design' }, ...(Nstar ? [{ type: 'vline', x: Nstar, label: 'N for target', color: '#22c55e' }] : [])],
      explain: 'The solved cell is replicated N times; pumps scale with total flow while control power is fixed, so net power starts negative for few cells and grows linearly. Where the net line crosses the target is the cell count required. Phasing cells smooths torque but does not change the cycle-averaged energy.' });
    out.charts.push({ type: 'line', title: 'Specific power vs cycle frequency (three mass bases)', x: { label: 'Frequency', unit: 'Hz' }, y: { label: 'Specific power', unit: 'W/kg' },
      series: [{ name: 'Active SMA — net', x: sweepF.map(s => s.f), y: sweepF.map(s => s.pA), mode: 'lines+markers' }, { name: 'Active SMA — gross', x: sweepF.map(s => s.f), y: sweepF.map(s => s.pAg), dash: '6 4' }, { name: 'Cartridge — net', x: sweepF.map(s => s.f), y: sweepF.map(s => s.pC) }, { name: 'System — net', x: sweepF.map(s => s.f), y: sweepF.map(s => s.pS) }],
      annotations: [{ type: 'hline', y: eng.REFERENCE_W_PER_KG, label: `Reference ${eng.REFERENCE_W_PER_KG} W/kg`, color: '#94a3b8' }, { type: 'vline', x: d.freq, label: 'Design' }],
      explain: `Each point re-solves the transient cell at reduced resolution (${p.sweepRes} steps/cycle). Specific power first rises with frequency (more cycles per second) and then collapses when the hot or cold dwell becomes shorter than the thermal time constant and the transformation no longer completes (martensite swing at the highest frequency: ${fmt(sweepF[sweepF.length - 1].xi, 3)}). The three mass bases are plotted separately and must never be mixed.` });
    const Ths = linspace(Math.max(d.Tc + 1, d.Tc + 2), Math.max(d.Th * 1.6, d.Tc + 120), 60);
    out.charts.push({ type: 'line', title: 'Carnot and finite-time bounds vs hot-source temperature', x: { label: 'Hot-source temperature', unit: '°C' }, y: { label: 'Efficiency', unit: '%' },
      series: [{ name: 'Carnot 1 − Tc/Th', x: Ths, y: Ths.map(T => 100 * carnot(T, d.Tc)) }, { name: 'Curzon–Ahlborn', x: Ths, y: Ths.map(T => 100 * curzonAhlborn(T, d.Tc)), dash: '6 4' }, { name: '50–70 % of Carnot (research goal)', x: Ths, y: Ths.map(T => 60 * carnot(T, d.Tc)), dash: '2 3', band: { lo: Ths.map(T => 50 * carnot(T, d.Tc)), hi: Ths.map(T => 70 * carnot(T, d.Tc)) } }],
      annotations: [{ type: 'point', x: d.Th, y: 100 * M.eta, label: `Design η = ${fmt(100 * M.eta, 3)} %` }, { type: 'point', x: d.Th, y: 100 * etaC, label: `Carnot ${fmt(100 * etaC, 3)} %`, color: '#ef4444' }, { type: 'vline', x: d.Th, label: 'T_h' }],
      explain: 'Upper bounds on thermal efficiency for the selected sink temperature. The yellow point is the computed net efficiency at the design source temperature; its distance below the Carnot curve is the room for improvement through regeneration, lower hysteresis and faster heat exchange. No design can lie above the Carnot curve.' });
    const lossTr = M.Pgross - M.Pshaft;
    out.charts.push({ type: 'bar', title: 'Thermal budget (cycle-averaged)', categories: ['Heat from source Q_hot', 'Sensible heat regenerated', 'Latent heat (not regenerable)', 'Gross cell work', 'Heat rejected to sink'], series: [{ name: 'Power', values: [M.QhotTot, d.regenEff * A.sensible * d.nCells * d.freq, A.latent * d.nCells * d.freq, M.Pgross, M.QrejTot], colors: ['#ef4444', '#f59e0b', '#a855f7', '#22c55e', '#3b82f6'] }], y: { label: 'Heat or work rate', unit: 'W' }, showValues: true,
      explain: 'First-law budget: heat drawn from the source equals gross mechanical work plus heat rejected. The regenerated sensible heat circulates internally and is not drawn from the source; the latent heat of the reverse transformation must always be supplied from the source.' });
    out.charts.push({ type: 'bar', title: 'Power cascade: gross cell work → net shaft output', categories: ['Gross cell work', 'Transmission & bearing loss', 'Hot + cold pumping', 'Valve switching', 'Control & sensing', 'Net shaft output'], series: [{ name: 'Power', values: [M.Pgross, -lossTr, -M.Ppump, -M.Pvalves, -d.controlPower, M.Pnet], colors: ['#22c55e', '#f97316', '#f97316', '#f97316', '#f97316', M.Pnet > 0 ? '#16a34a' : '#dc2626'] }], y: { label: 'Power', unit: 'W' }, showValues: true,
      explain: 'Waterfall of the mechanical power: every loss and auxiliary load is subtracted from the gross work produced by the cells to reach the net exported power. The gross bar is never reported as engine output.' });
    out.charts.push({ type: 'line', title: 'Staged specific-power milestones vs computed (log scale)', x: { label: 'Milestone stage' }, y: { label: 'Specific power', unit: 'W/kg', log: true },
      series: [{ name: 'Staged milestones (active SMA basis)', x: eng.MILESTONES.map((_, i) => i + 1), y: eng.MILESTONES.map(m => m[0]), mode: 'lines+markers', labels: eng.MILESTONES.map(m => `${m[0]} — ${m[1]}`) }],
      annotations: [{ type: 'hline', y: Math.max(1e-3, pActive), label: `Computed active net ${fmt(pActive, 3)} W/kg`, color: '#22c55e' }, { type: 'hline', y: Math.max(1e-3, pCart), label: `Cartridge basis ${fmt(pCart, 3)}`, color: '#f59e0b' }, { type: 'hline', y: Math.max(1e-3, pSys), label: `System basis ${fmt(pSys, 3)}`, color: '#ef4444' }],
      explain: 'Programme milestones are defined on the active-SMA mass basis only. The green line is the comparable computed figure; the cartridge and system lines are shown for transparency and must not be compared with the milestones. Milestones are research goals, not guarantees.' });
    const mB = [['Active SMA ribbons', M.mActive, 'ribbon'], ...MASS_SPLIT_CART.map(([n, f, k]) => [n, (mCart - M.mActive) * f, k]), ...MASS_SPLIT_SYS.map(([n, f, k]) => [n, (mSys - mCart) * f, k])];
    out.charts.push({ type: 'bar', title: 'Component mass budget', horizontal: true, categories: mB.map(r => r[0]), series: [{ name: 'Mass', values: mB.map(r => r[1]) }], y: { label: 'Mass', unit: 'kg' }, showValues: true,
      explain: `Active, cartridge and system masses (${massProv === 'coupled' ? 'from Suite 02 geometry' : 'from the engine mass factors'}); the split among components is an estimated budget allocation to be replaced by CAD masses from Suite 02.` });

    // ---- tables
    out.tables.push({ title: 'Requirement matrix with trace', cols: ['ID', 'Requirement', 'Source', 'Target', 'Computed', 'Status', 'Verified in'], rows: req.map(r => [r.id, r.text, r.src, r.target, r.value, r.status.toUpperCase(), r.trace]), explain: 'Each requirement is traced to its source and to the suite(s) that verify it. FAIL rows block release; WARN rows need evidence or a decision.' });
    out.tables.push({ title: 'Architecture and configuration candidates', cols: ['Candidate', 'Net power [W]', 'Gross [W]', 'Auxiliaries [W]', 'Active mass [kg]', 'p_active net [W/kg]', 'p_system net [W/kg]', 'η [%]', 'η/η_Carnot', 'Meets target'], rows: cand.map(k => [k.name, k.r.Pnet, k.r.Pgross, k.r.Paux, k.r.mActive, k.r.pActive, k.r.pSys, 100 * k.r.eta, k.r.carnotFraction, k.r.Pnet >= d.targetPower ? 'yes' : 'no']), explain: 'Candidates evaluated against identical reservoirs and loads. Re-solved candidates use the reduced sweep resolution; B uses hypothetical modifiers and is gated.' });
    out.tables.push({ title: 'Component mass & thermal budget', cols: ['Item', 'Mass [kg]', 'Assigned material', 'Basis'], rows: mB.map(([n, m, k]) => [n, m, ctx.material(k)?.name || '—', k === 'ribbon' ? 'calculated' : massProv === 'coupled' ? 'coupled total, estimated split' : 'estimated split']), explain: 'Mass budget per component group with the material assigned in Suite 03.' });
    out.tables.push({ title: 'Dimensional analysis', cols: ['Group', 'Value', 'Unit', 'Interpretation'], rows: dims, explain: 't_diff = L²/α is a diffusion scaling estimate, not a cycling-rate prediction; the transient cell solve is the reference.' });
    out.tables.push({ title: 'First- and second-law screening', cols: ['Quantity', 'Value', 'Unit'], rows: [['Carnot efficiency', 100 * etaC, '%'], ['Curzon–Ahlborn efficiency', 100 * etaCA, '%'], ['Net thermal efficiency', 100 * M.eta, '%'], ['Fraction of Carnot', M.carnotFraction, '–'], ['Exergy of heat input', M.exergyIn, 'W'], ['Exergy efficiency', 100 * M.exergyEff, '%'], ['Entropy generation', Sgen, 'W/K'], ['Minimum heat for target at Carnot', d.targetPower / Math.max(etaC, 1e-9), 'W'], ['Heat for target at this efficiency', M.eta > 0 ? d.targetPower / M.eta : Infinity, 'W'], ['Mean shaft torque', M.torqueMean, 'N·m']] , explain: 'Bounds use absolute reservoir temperatures; the second law requires non-negative entropy generation.' });

    // ---- checks
    const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
    out.checks.push(
      { name: 'Independent net-power arithmetic', value: rel(Pnet2, M.Pnet), target: '< 1e-9', pass: rel(Pnet2, M.Pnet) < 1e-9, detail: `Suite: ${fmt(Pnet2, 6)} W; engine model: ${fmt(M.Pnet, 6)} W.` },
      { name: 'Independent heat-input and rejection arithmetic', value: Math.max(rel(Qhot2, A.QhotTot), rel(Qrej2, A.QrejTot)), target: '< 1e-9', pass: Math.max(rel(Qhot2, A.QhotTot), rel(Qrej2, A.QrejTot)) < 1e-9, detail: 'Q_hot and Q_rej recomputed from cell heat, latent part and regenerator effectiveness.' },
      { name: 'Engine first law Q_hot = P_gross + Q_rej', value: rel(A.Pgross + A.QrejTot, A.QhotTot), target: '< 1e-9', pass: rel(A.Pgross + A.QrejTot, A.QhotTot) < 1e-9 },
      { name: 'Cell energy residual (last cycle)', value: Math.abs(c.energyResidual), target: '< 1e-2', pass: Math.abs(c.energyResidual) < 1e-2, detail: 'Q_hot − Q_cold − W_out − W_spring − ΔU over the last cycle, relative to Q_hot.' },
      { name: 'Cell cycle periodicity', value: c.periodicity, target: '< 0.1', pass: c.periodicity < 0.1, detail: 'Relative change of W_out between the last two cycles; raise “cycles to periodic state” if it fails.' },
      { name: 'Carnot bound respected', value: M.eta / Math.max(etaC, 1e-12), target: '≤ 1', pass: M.eta <= etaC + 1e-12 },
      { name: 'Entropy generation ≥ 0', value: Sgen, target: '≥ 0', pass: Sgen >= -1e-9 },
      { name: 'Requirement trace complete', value: req.filter(r => r.trace && r.src).length, target: `= ${req.length}`, pass: req.every(r => r.trace && r.src) },
    );

    // ---- narrative & recommendations
    const auxShare = M.Paux / Math.max(1e-9, M.Pshaft);
    out.explain.push(
      { title: 'What was solved', text: `A ${d.variant} engine (${APPS.find(a => a.value === d.application)?.label}) with ${d.nCells} cells of ${d.ribbonsPerCell} ribbons (${d.ribbonL * 1e3} × ${d.ribbonW * 1e3} mm × ${fmt(d.ribbonT * 1e6, 3)} µm, ${mat.name}) between ${d.Th} °C and ${d.Tc} °C at ${d.freq} Hz. One representative cell was solved transiently to its periodic state and scaled to the array with all auxiliaries.` },
      { title: 'Energy result', text: `Each cell delivers ${fmt(c.Wout, 4)} J of load work per cycle (contraction work ${fmt(c.Wcontraction, 4)} J minus reset ${fmt(c.Wreset, 4)} J governs it). The array produces ${fmt(M.Pgross, 4)} W gross and ${fmt(M.Pnet, 4)} W net after ${fmt(M.Paux, 3)} W of auxiliaries (${fmt(100 * auxShare, 3)} % of shaft power) from ${fmt(M.QhotTot, 4)} W of heat — ${fmt(100 * M.eta, 3)} % efficiency, ${fmt(100 * M.carnotFraction, 3)} % of Carnot.` },
      { title: 'Architecture decision', text: `Architecture A yields ${fmt(A.Pnet, 4)} W; the hypothetical B variant ${fmt(B.Pnet, 4)} W and ${fmt(B.pSys, 3)} W/kg on the system basis. B remains gated until A demonstrates sustained net power, thermal stability and fatigue performance.` },
      { title: 'Mass bases', text: `Active ${fmt(M.mActive, 4)} kg, cartridges ${fmt(mCart, 4)} kg, system ${fmt(mSys, 4)} kg → ${fmt(pActive, 4)} / ${fmt(pCart, 4)} / ${fmt(pSys, 4)} W/kg. Only the active basis is compared with the 36 W/kg reference and the staged milestones.` },
    );
    if (M.Pnet < d.targetPower) out.recs.push({ level: Nstar ? 'warn' : 'critical', text: Nstar ? `Scale to ${Nstar} cells (≈ ${fmt(Nstar * c.mass, 3)} kg active SMA) or raise per-cell net work to meet ${d.targetPower} W; at the current ${fmt(M.perCellNet, 3)} W per cell the array falls short.` : 'Per-cell net power is negative after its share of pumping and valve power: adding cells cannot reach the target. Widen the stress window or reduce pumping first.', basis: `P_net = ${fmt(M.Pnet, 4)} W vs target ${d.targetPower} W` });
    if (auxShare > 0.3) out.recs.push({ level: 'warn', text: `Auxiliaries consume ${fmt(100 * auxShare, 3)} % of shaft power; resize channels and manifolds (Suite 13) or use shaft-driven pumps.`, basis: `P_aux = ${fmt(M.Paux, 3)} W, P_shaft = ${fmt(M.Pshaft, 3)} W` });
    const best = sweepF.reduce((a, b) => b.pA > a.pA ? b : a);
    if (Math.abs(best.f - d.freq) / d.freq > 0.2) out.recs.push({ level: 'info', text: `Specific power peaks near ${fmt(best.f, 3)} Hz (${fmt(best.pA, 4)} W/kg active net) instead of the design ${d.freq} Hz; confirm with the full-resolution cell (Suite 05) and the heat-transfer suite (Suite 08).`, basis: 'Frequency sweep of this run' });
    if (tsH.tauBiot * d.freq > 0.15) out.recs.push({ level: 'info', text: `The hot-side time constant ${fmt(tsH.tauBiot * 1e3, 3)} ms is a large part of the ${fmt(tHeat * 1e3, 3)} ms hot dwell; thinner ribbons or higher contact conductance raise the attainable frequency.`, basis: 'Dimensional analysis table' });
    if (M.carnotFraction < 0.1) out.recs.push({ level: 'info', text: `Efficiency is ${fmt(100 * M.carnotFraction, 3)} % of Carnot; the Stefan number ${fmt(Ste, 3)} shows ${Ste > 1 ? 'sensible heating of ribbon and wall dominates — raise regenerator effectiveness and reduce wall heat capacity' : 'latent heat dominates — reduce hysteresis (NiTiCu) and the stress window losses'}.`, basis: `η = ${fmt(100 * M.eta, 3)} %, η_C = ${fmt(100 * etaC, 3)} %` });
    if (Nf < Nreq) out.recs.push({ level: 'critical', text: `Predicted functional life ${fmt(Nf, 3)} cycles is below the ${fmt(Nreq, 3)}-cycle lifecycle requirement: limit the stroke or σH, or schedule ${fmt(Math.ceil(Nreq / Nf), 3)} cartridge replacements over the design life.`, basis: 'Functional-fatigue trend (Suite 16 for detail)' });
    const alloyCost = M.mActive * (mat.cost || 0), co2 = M.mActive * (mat.co2 || 0);
    out.recs.push({ level: 'econ', text: `Active alloy ≈ ${fmt(alloyCost, 3)} USD (${fmt(M.mActive, 3)} kg × ${mat.cost} USD/kg), i.e. ${M.Pnet > 0 ? fmt(alloyCost / M.Pnet, 3) + ' USD per net watt' : 'no net watt delivered'}; ribbons are a consumable at the predicted life, so the replacement cost per operating hour is ≈ ${fmt(alloyCost / Math.max(1e-9, Nf / d.freq / 3600), 3)} USD/h.`, basis: 'Library price, Suite 22 for full techno-economics' });
    out.recs.push({ level: 'sustain', text: `Embodied carbon of the active alloy ≈ ${fmt(co2, 3)} kg CO₂e; ${M.Pnet > 0 ? `at ${fmt(M.Pnet, 3)} W net displacing grid electricity at 0.4 kg CO₂e/kWh it is repaid after ≈ ${fmt(co2 / (M.Pnet / 1000 * 0.4), 3)} operating hours (alloy only).` : 'with no net output there is no carbon payback.'} Recover NiTi at end of life (recyclable fraction ${mat.recyclable}).`, basis: 'Library embodied carbon, assumed grid factor 0.4 kg/kWh (Suite 22 uses live grid data)' });
    if (M.Pnet > 0 && pActive >= eng.REFERENCE_W_PER_KG) out.recs.push({ level: 'good', text: `The design exceeds the ${eng.REFERENCE_W_PER_KG} W/kg reference on the active basis (${fmt(pActive / eng.REFERENCE_W_PER_KG, 3)}×) in simulation; reproduce the reference conditions and definition before claiming a relative gain.`, basis: 'Spec §3 acceptance rule' });

    // ---- write user edits back to the project engine (only explicit edits in this suite, once)
    const provs = store.prov('s01'), patch = {};
    for (const [k, e, s] of ENG) if (provs[k] === 'user' && p[k] !== undefined) { const v = typeof p[k] === 'number' && s !== 1 ? +(p[k] * s).toPrecision(12) : p[k]; const cur = ctx.engine[e]; if (typeof v === 'number' ? Math.abs(v - cur) > 1e-12 * Math.max(1, Math.abs(cur)) : v !== cur) patch[e] = v; }
    if (Object.keys(patch).length) { store.setEngine(patch, 'Suite 01 architecture'); out.explain.push({ title: 'Project engine updated', text: `Edited values written to the shared engine design: ${Object.entries(patch).map(([k, v]) => `${k} = ${typeof v === 'number' ? fmt(v, 4) : v}`).join(', ')}. Downstream suites are marked stale.` }); }

    const ok = M.Pnet >= d.targetPower && !req.some(r => r.status === 'fail');
    out.headline = `${d.architecture === 'B' ? 'Architecture B (gated)' : 'Architecture A'}: ${fmt(M.Pnet, 4)} W net (${fmt(pActive, 4)} W/kg active, ${fmt(pSys, 3)} W/kg system) from ${fmt(M.QhotTot, 4)} W heat, η = ${fmt(100 * M.eta, 3)} % (${fmt(100 * M.carnotFraction, 3)} % of Carnot). ${M.Pnet >= d.targetPower ? 'Target met.' : Nstar ? `Target needs ${Nstar} cells.` : 'Target unreachable by adding cells.'} ${req.filter(r => r.status === 'fail').length} requirement(s) failing.`;
    out.headlineKind = ok ? 'ok' : M.Pnet > 0 ? 'warn' : 'fail';
    out.outputs = {
      design: { ...dM }, architecture: d.architecture, Pnet_W: M.Pnet, Qhot_W: M.QhotTot, etaC, eta: M.eta, mActive_kg: M.mActive, mCart_kg: mCart, mSys_kg: mSys, pActive_Wkg: pActive, pCart_Wkg: pCart, pSys_Wkg: pSys,
      cellsForTarget: Nstar ?? null, massBudget: { active: M.mActive, cartridge: mCart, system: mSys, items: Object.fromEntries(mB.map(([n, m]) => [n, m])) }, requirements: req, envelope: { D: envD, L: envL }, Pgross_W: M.Pgross, Paux_W: M.Paux,
    };
    out.credibility = 'Analytical screening';
    ctx.progress(1, 'done');
    return out;
  },
};
