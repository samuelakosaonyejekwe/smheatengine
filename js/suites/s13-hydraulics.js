// Suite 13 — Hydraulic distribution, valves and fluid auxiliaries. 1-D hydraulic networks of the hot and cold circuits
// (pump → external loop → supply header → active cells (ports + microchannels) → return header) solved by a nodal
// Newton method at every phase instant of the rotary distributor; per-channel distribution inside a cell by the same
// solver; pump/system curve intersection; switching latency, purge mixing, seal leakage and pumping vs net power.
import { fluid, fluidOptions, rectDuct, darcy } from '../core/heat.js';
import { designWith, engineModel } from '../core/engine.js';
import { luSolve, linspace, range, fmt, clamp, brent } from '../core/num.js';

const pause = async (ctx) => { try { await ctx.yield?.(); } catch { /* headless run: no animation frame available */ } };
// element law: s = p_a − p_b + G0 = lin·q + quad·q|q|  →  q(s) and conductance g = dq/ds
const qOf = (e, s) => (e.quad < 1e-30 ? s / e.lin : Math.sign(s) * (-e.lin + Math.sqrt(e.lin * e.lin + 4 * e.quad * Math.abs(s))) / (2 * e.quad));
// Nodal Newton solver with line search; `update(q)` refreshes flow-dependent coefficients (turbulent friction) — Picard–Newton
export function solveNetwork({ n, fixed, elems, inj = {}, qref = 1e-4, tol = 1e-10, maxIt = 80, update }) {
  const free = range(n).filter(i => !fixed.has(i)), id = new Map(free.map((v, k) => [v, k])), m = free.length;
  const p = new Float64Array(n); for (const [k, v] of fixed) p[k] = v;
  const q = new Float64Array(elems.length), hist = [];
  const evalAll = (P) => { const R = new Float64Array(n); for (let k = 0; k < n; k++) R[k] = inj[k] || 0; elems.forEach((e, j) => { const v = qOf(e, P[e.a] - P[e.b] + (e.G0 || 0)); q[j] = v; R[e.a] -= v; R[e.b] += v; }); let r = 0; for (const k of free) r = Math.max(r, Math.abs(R[k])); return { R, r }; };
  let { R, r } = evalAll(p), it = 0, scale = Math.max(qref, 1e-12);
  for (; it < maxIt; it++) {
    if (update) { update(q); ({ R, r } = evalAll(p)); }
    hist.push(r / scale); if (r / scale < tol && it > 0) break;
    const J = range(m).map(() => new Float64Array(m)), rhs = new Array(m).fill(0);
    elems.forEach((e, j) => { const g = 1 / (e.lin + 2 * e.quad * Math.abs(q[j]) + 1e-3 * (e.lin + 2 * e.quad * scale)); const ia = id.get(e.a), ib = id.get(e.b); if (ia !== undefined) { J[ia][ia] -= g; if (ib !== undefined) J[ia][ib] += g; } if (ib !== undefined) { J[ib][ib] -= g; if (ia !== undefined) J[ib][ia] += g; } });
    free.forEach((k, i) => { rhs[i] = -R[k]; });
    const dx = luSolve(J, rhs); let lam = 1, P2 = Float64Array.from(p), E2;
    for (let ls = 0; ls < 12; ls++) { for (let i = 0; i < m; i++) P2[free[i]] = p[free[i]] + lam * dx[i]; E2 = evalAll(P2); if (E2.r < r || ls === 11) break; lam /= 2; }
    p.set(P2); R = E2.R; r = E2.r;
  }
  evalAll(p);
  return { p: Array.from(p), q: Array.from(q), iterations: it, residual: r / scale, hist, converged: r / scale < tol * 10 };
}

export default {
  description: 'Solves the hot and cold distribution networks as 1-D nonlinear hydraulic networks at every phase instant of the rotary distributor: header friction, ports and microchannel branches give the flow maldistribution between cells and between channels; the pump curve meets the system curve; switching latency, purge mixing and seal leakage are quantified and pumping is compared with the engine net power.',
  literature: 'manifold flow maldistribution parallel microchannels header design pump system curve rotary valve leakage',
  econ: true, sustain: true, credibility: 'Analytical screening',
  equations: [
    'Element law Δp = R_lin·Q + K_quad·Q|Q| (laminar + inertial), nodal continuity Σ Q_in − Σ Q_out = 0',
    'Microchannel branch (M parallel ducts): R_lin = (f·Re)·μ·L/(2·D_h²·A·M) with (f·Re) from Shah & London for the aspect ratio; K = K_ch·ρ/(2(MA)²) + 2K_port·ρ/(2A_port²)',
    'Header segment: R_lin = 128μL/(πD⁴) (Hagen–Poiseuille) + inertial excess [f_SJ(Re) − 64/Re]⁺·(L/D)·ρ/(2A²), Swamee–Jain turbulent friction',
    'Pump curve H(Q) = H₀ − k_p·Q² (as an element with source pressure H₀); external loop K_ext = Δp_ext/Q_d²',
    'Pump efficiency η(Q) = η_BEP·[2(Q/Q_BEP) − (Q/Q_BEP)²]; power P = H(Q)·Q/η(Q)',
    'Maldistribution φ = (Q_max − Q_min)/Q̄ over active cells (and over channels within a cell)',
    'Switching latency t_lat = t_valve + V_dead/Q_cell; purge mixing heat Q_mix = 2·N·f·ρc_p·V_dead·(T_h − T_c)',
    'Seal leakage (parallel-gap Poiseuille) Q_l = L_s·h³·Δp/(12μ·w_s); thermal short-circuit Q = ρc_p·Q_l·(T_h − T_c)',
    'Net: P_net,plant = P_shaft − P_pump,network − P_valves − P_control',
  ],
  methods: [
    'Nodal Newton–Raphson on header pressures with analytic element conductances, backtracking line search and Picard update of turbulent friction (dense LU, ≤ 2N + 2 unknowns per circuit)',
    'Rotary-distributor schedule: N phase instants per cycle, active hot/cold cell sets from the phase offsets (Suite 12 if available) and duty',
    'Pump auto-selection through the design point with 33 % shut-off margin; system curve from a pressure-source sweep',
    'Channel-level network (2M nodes) inside one cell at the mean active cell flow',
    'Header-diameter sweep (U and Z layouts) and uniform-limit verification',
  ],
  assumptions: [
    'Incompressible, isothermal circuits at the mean hot/cold fluid temperature; no gravity head inside the engine',
    'Quasi-steady flow at each phase instant (valve transients shorter than the instant spacing; their energy is the valve switching energy)',
    'Fully developed laminar channel friction plus lumped entrance/exit K; header junction losses lumped into the port K',
    'Seal leakage across the rotary distributor lands only (static seals tight); leakage heat taken at the full hot–cold difference',
    'Purge loss conservative: the whole dead volume is at the opposite temperature at each switch',
  ],
  ibc: {
    initial: ['Zero header pressures; Newton iteration from the linearised (laminar) solution'],
    boundary: ['Pump suction at reservoir pressure (reference 0)', 'Return to reservoir at reference pressure; external loop loss lumped on the pump element', 'Active/closed branches from the distributor schedule at each instant'],
  },
  cvv: {
    calibration: ['Pump map (H, η vs Q) from the manufacturer or a test stand', 'Branch K and channel f·Re from manifold pressure/flow tests (spec Module 13 evidence)', 'Seal gap from a leakage test at known Δp'],
    verification: ['Node mass conservation (residual)', 'Pump flow = Σ branch flows', 'Uniform-distribution limit for vanishing header resistance', 'Shah–London f·Re = 56.91 for a square duct; laminar circular f = 64/Re', 'Pump Δp = circuit Δp at the operating point'],
    validation: ['Measured pump map and manifold pressure/flow distribution (per-cell flow meters or thermal tracers)'],
  },
  formats: { import: ['CSV pump curve (Q, H, η)', 'CSV measured per-cell flows'], export: ['CSV of flows per cell/instant/channel', 'PNG/SVG charts', 'JSON coupling outputs'] },
  params: [
    { key: 'layout', label: 'Header layout', type: 'select', options: [{ value: 'Z', label: 'Z-type (reverse return: inlet and outlet at opposite ends)' }, { value: 'U', label: 'U-type (inlet and outlet at the same end)' }], default: 'Z', group: 'Network' },
    { key: 'nCells', label: 'Number of cells', unit: '', type: 'number', min: 2, max: 60, step: 1, default: 12, group: 'Network', auto: (c) => { const n = c.upstream('s12')?.nCells; return n > 1 ? { value: n, prov: 'coupled' } : { value: c.engine.nCells, prov: 'calc' }; } },
    { key: 'dutyHot', label: 'Hot-phase fraction', unit: '', type: 'number', min: 0.1, max: 0.9, step: 0.01, default: 0.5, group: 'Network', auto: (c) => { const v = c.upstream('s12')?.dutyHot; return Number.isFinite(v) ? { value: v, prov: 'coupled' } : { value: c.engine.dutyHot, prov: 'calc' }; } },
    { key: 'headerD', label: 'Header inner diameter', unit: 'm', type: 'number', min: 0.003, max: 0.1, step: 0.0005, default: 0.012, group: 'Network' },
    { key: 'cellPitch', label: 'Header length between cells', unit: 'm', type: 'number', min: 0.005, max: 0.5, step: 0.001, default: 0.03, group: 'Network' },
    { key: 'portD', label: 'Distributor port diameter', unit: 'm', type: 'number', min: 0.001, max: 0.05, step: 0.0005, default: 0.006, group: 'Network' },
    { key: 'Kport', label: 'Port loss coefficient (each, in & out)', unit: '', type: 'number', min: 0, max: 20, step: 0.1, default: 1.5, group: 'Network' },
    { key: 'Kch', label: 'Channel entrance/exit loss K', unit: '', type: 'number', min: 0, max: 10, step: 0.1, default: 2, group: 'Network' },
    { key: 'chPerCell', label: 'Microchannels per cell', unit: '', type: 'number', min: 1, max: 400, step: 1, default: 60, group: 'Microchannels', auto: (c) => ({ value: c.engine.chPerCell, prov: 'calc' }) },
    { key: 'chW', label: 'Channel width', unit: 'm', type: 'number', min: 1e-4, max: 0.01, step: 1e-5, default: 1e-3, group: 'Microchannels', auto: (c) => ({ value: c.engine.chW, prov: 'calc' }) },
    { key: 'chH', label: 'Channel height', unit: 'm', type: 'number', min: 1e-4, max: 0.01, step: 1e-5, default: 8e-4, group: 'Microchannels', auto: (c) => ({ value: c.engine.chH, prov: 'calc' }) },
    { key: 'chL', label: 'Channel length', unit: 'm', type: 'number', min: 0.01, max: 1, step: 0.005, default: 0.1, group: 'Microchannels', auto: (c) => ({ value: c.engine.ribbonL, prov: 'calc' }) },
    { key: 'plenumW', label: 'Cell plenum width', unit: 'm', type: 'number', min: 5e-4, max: 0.05, step: 1e-4, default: 0.008, group: 'Microchannels' },
    { key: 'plenumH', label: 'Cell plenum height', unit: 'm', type: 'number', min: 2e-4, max: 0.02, step: 1e-4, default: 0.0025, group: 'Microchannels' },
    { key: 'Th', label: 'Hot fluid temperature', unit: '°C', type: 'number', min: 20, max: 200, step: 0.5, default: 70, group: 'Fluids', auto: (c) => { const t = c.upstream('s06')?.ThSupply_C; return Number.isFinite(t) ? { value: +t.toFixed(2), prov: 'coupled' } : { value: c.engine.Th, prov: 'calc' }; } },
    { key: 'Tc', label: 'Cold fluid temperature', unit: '°C', type: 'number', min: -10, max: 80, step: 0.5, default: 15, group: 'Fluids', auto: (c) => { const t = c.upstream('s07')?.TcSupply_C; return Number.isFinite(t) ? { value: +t.toFixed(2), prov: 'coupled' } : { value: c.engine.Tc, prov: 'calc' }; } },
    { key: 'hotFluid', label: 'Hot-circuit fluid', type: 'select', options: fluidOptions.filter(o => o.value !== 'fl-air'), default: 'fl-water', group: 'Fluids', auto: (c) => ({ value: c.engine.hotFluid, prov: 'calc' }) },
    { key: 'coldFluid', label: 'Cold-circuit fluid', type: 'select', options: fluidOptions.filter(o => o.value !== 'fl-air'), default: 'fl-water', group: 'Fluids', auto: (c) => ({ value: c.engine.coldFluid, prov: 'calc' }) },
    { key: 'dpExtHot', label: 'External hot-loop Δp at design flow (exchanger + piping)', unit: 'Pa', type: 'number', min: 0, max: 5e5, step: 100, default: 3000, group: 'Fluids', auto: (c) => { const v = c.upstream('s06')?.dpHot_Pa; return Number.isFinite(v) ? { value: Math.round(v), prov: 'coupled' } : undefined; } },
    { key: 'dpExtCold', label: 'External cold-loop Δp at design flow', unit: 'Pa', type: 'number', min: 0, max: 5e5, step: 100, default: 3000, group: 'Fluids' },
    { key: 'pumpMode', label: 'Pump selection', type: 'select', options: [{ value: 'auto', label: 'Auto-select through the design point (+33 % shut-off margin)' }, { value: 'user', label: 'User pump curve' }], default: 'auto', group: 'Pumps' },
    { key: 'H0', label: 'User pump shut-off pressure', unit: 'kPa', type: 'number', min: 1, max: 1000, step: 1, default: 30, group: 'Pumps' },
    { key: 'Qmax', label: 'User pump free-delivery flow', unit: 'L/min', type: 'number', min: 0.1, max: 2000, step: 0.1, default: 20, group: 'Pumps' },
    { key: 'pumpEta', label: 'Pump best-efficiency η', unit: '', type: 'number', min: 0.1, max: 0.9, step: 0.01, default: 0.45, group: 'Pumps', auto: (c) => ({ value: c.engine.pumpEta, prov: 'calc' }) },
    { key: 'tSwitch', label: 'Valve actuation time', unit: 's', type: 'number', min: 0, max: 1, step: 0.001, default: 0.02, group: 'Valves & seals', auto: (c) => ({ value: c.engine.tSwitch, prov: 'calc' }) },
    { key: 'valveEnergy', label: 'Valve switching energy', unit: 'J/switch', type: 'number', min: 0, max: 5, step: 0.001, default: 0.02, group: 'Valves & seals', auto: (c) => ({ value: c.engine.valveEnergy, prov: 'calc' }) },
    { key: 'routing', label: 'Purge routing efficiency (outlet-delayed switching)', unit: '', type: 'number', min: 0, max: 1, step: 0.01, default: 0.95, group: 'Valves & seals', help: 'Fraction of the displaced dead-volume fluid returned to its own header by delaying the outlet switch by the purge time. 0 = conservative (all mixed). Estimated — measure with outlet thermocouples.' },
    { key: 'sealGap', label: 'Distributor seal clearance', unit: 'µm', type: 'number', min: 0.5, max: 100, step: 0.5, default: 8, group: 'Valves & seals' },
    { key: 'sealLand', label: 'Seal land width', unit: 'mm', type: 'number', min: 0.5, max: 20, step: 0.1, default: 3, group: 'Valves & seals' },
    { key: 'sealLen', label: 'Seal perimeter per hot/cold interface', unit: 'm', type: 'number', min: 0.005, max: 2, step: 0.005, default: 0.08, group: 'Valves & seals' },
    { key: 'elecPrice', label: 'Electricity price', unit: 'USD/kWh', type: 'number', min: 0, max: 1, step: 0.01, default: 0.15, group: 'Economics & sustainability' },
    { key: 'gridCO2', label: 'Grid carbon intensity', unit: 'kg/kWh', type: 'number', min: 0, max: 1.2, step: 0.01, default: 0.45, group: 'Economics & sustainability' },
    { key: 'tol', label: 'Newton tolerance (relative to design flow)', unit: '', type: 'number', min: 1e-14, max: 1e-4, step: 1e-12, default: 1e-10, group: 'Numerics', expert: true },
    { key: 'engNodes', label: 'Engine model through-thickness nodes', unit: '', type: 'number', min: 1, max: 6, step: 1, default: 2, group: 'Numerics', expert: true },
    { key: 'engSteps', label: 'Engine model steps per cycle', unit: '', type: 'number', min: 80, max: 400, step: 10, default: 150, group: 'Numerics', expert: true },
  ],
  presets: [
    { label: 'Reference Z-manifold, 12 mm headers', values: { layout: 'Z', headerD: 0.012 } },
    { label: 'Compact U-manifold, 8 mm headers', values: { layout: 'U', headerD: 0.008 } },
    { label: 'Large headers (uniform limit)', values: { headerD: 0.03 } },
    { label: 'Worn distributor seals (25 µm)', values: { sealGap: 25 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const kpi = (label, value, unit, explain, prov = 'calc', status) => out.kpis.push({ label, value, unit, explain, prov, status });
    const N = Math.round(p.nCells), M = Math.round(p.chPerCell);
    const d = designWith(ctx.engine, { nCells: N, dutyHot: p.dutyHot, chPerCell: M, chW: p.chW, chH: p.chH, ribbonL: p.chL, Th: p.Th, Tc: p.Tc, hotFluid: p.hotFluid, coldFluid: p.coldFluid, pumpEta: p.pumpEta, tSwitch: p.tSwitch, valveEnergy: p.valveEnergy });
    ctx.progress(0.05, 'engine reference');
    const E = engineModel(d, { n: p.engNodes, stepsPerCycle: p.engSteps, cycles: 3 }); await pause(ctx);
    const mat0cp = (ctx.materials?.get?.(d.alloy)?.cp) ?? 490;
    const f = d.freq, duty = d.dutyHot, rd = rectDuct(p.chW, p.chH), Ach = p.chW * p.chH;
    // phase offsets (fraction of cycle) from Suite 12 if available
    const offs12 = ctx.upstream('s12')?.offsets, offs = Array.isArray(offs12) && offs12.length === N ? offs12.map(v => (Math.max(...offs12) > 1.5 ? v / 360 : v)) : range(N).map(i => i / N), offProv = Array.isArray(offs12) && offs12.length === N ? 'coupled' : 'calc';
    const K = N, inst = range(K).map(k => k / K);
    const active = (tau, hot) => range(N).filter(i => { const ph = ((tau + offs[i]) % 1 + 1) % 1; return hot ? ph < duty : ph >= duty; });
    // ---- circuit builder ----
    const circuit = (hot, { layout = p.layout, headerD = p.headerD } = {}) => {
      const fp = fluid(hot ? d.hotFluid : d.coldFluid, hot ? d.Th - d.fluidDT / 2 : d.Tc + d.fluidDT / 2), mdot = hot ? E.mdotH : E.mdotC;
      const share = hot ? duty : 1 - duty, Qcell = mdot / (N * Math.max(share, 0.05)) / fp.rho;
      const Ah = Math.PI * headerD ** 2 / 4, Ap = Math.PI * p.portD ** 2 / 4;
      const branch = { lin: rd.fRe * fp.mu * p.chL / (2 * rd.Dh ** 2 * Ach * M), quad: p.Kch * fp.rho / (2 * (M * Ach) ** 2) + 2 * p.Kport * fp.rho / (2 * Ap * Ap) };
      const hdrLin = 128 * fp.mu * p.cellPitch / (Math.PI * headerD ** 4);
      const hdrQuad = (q) => { const Re = 4 * fp.rho * Math.abs(q) / (Math.PI * headerD * fp.mu); return Re > 1 ? Math.max(0, darcy(Re, { rough: 1.5e-6, Dh: headerD }) - 64 / Re) * (p.cellPitch / headerD) * fp.rho / (2 * Ah * Ah) : 0; };
      return { fp, Qcell, branch, hdrLin, hdrQuad, layout, headerD, dpExt: hot ? p.dpExtHot : p.dpExtCold };
    };
    // nodes: 0 reservoir, 1..N supply header S_i, N+1..2N return header T_i
    const solveInstant = (C, act, pump) => {
      const S = (i) => 1 + i, T = (i) => 1 + N + i, R = 0, elems = [];
      const Qd = act.length * C.Qcell, extQ = C.dpExt / Math.max(Qd * Qd, 1e-30);
      if (pump.source !== undefined) elems.push({ a: R, b: S(0), lin: 1e-6 * C.branch.lin / N, quad: extQ, G0: pump.source, kind: 'pump' });
      else elems.push({ a: R, b: S(0), lin: 1e-6 * C.branch.lin / N, quad: pump.k + extQ, G0: pump.H0, kind: 'pump' });
      for (let i = 0; i < N - 1; i++) elems.push({ a: S(i), b: S(i + 1), lin: C.hdrLin, quad: 0, kind: 'hs', hdr: true });
      for (const i of act) elems.push({ a: S(i), b: T(i), lin: C.branch.lin, quad: C.branch.quad, kind: 'br', cell: i });
      if (C.layout === 'Z') { for (let i = 0; i < N - 1; i++) elems.push({ a: T(i), b: T(i + 1), lin: C.hdrLin, quad: 0, kind: 'hr', hdr: true }); elems.push({ a: T(N - 1), b: R, lin: 1e-9 * C.branch.lin, quad: 0, kind: 'out' }); }
      else { for (let i = N - 1; i > 0; i--) elems.push({ a: T(i), b: T(i - 1), lin: C.hdrLin, quad: 0, kind: 'hr', hdr: true }); elems.push({ a: T(0), b: R, lin: 1e-9 * C.branch.lin, quad: 0, kind: 'out' }); }
      const update = (q) => elems.forEach((e, j) => { if (e.hdr) e.quad = C.hdrQuad(q[j]); });
      const sol = solveNetwork({ n: 2 * N + 1, fixed: new Map([[R, 0]]), elems, qref: Qd, tol: p.tol, update });
      const flows = new Array(N).fill(NaN); elems.forEach((e, j) => { if (e.kind === 'br') flows[e.cell] = sol.q[j]; });
      const Qp = sol.q[0], qa = act.map(i => flows[i]), mean = qa.reduce((a, b) => a + b, 0) / Math.max(1, qa.length);
      return { sol, elems, flows, Qp, mal: qa.length ? (Math.max(...qa) - Math.min(...qa)) / mean : 0, pS: range(N).map(i => sol.p[S(i)]), pT: range(N).map(i => sol.p[T(i)]), dpPump: sol.p[S(0)] - sol.p[R], cont: Math.abs(Qp - qa.reduce((a, b) => a + b, 0)) / Math.max(Qp, 1e-30), Qd };
    };
    // ---- pump selection & solves over the rotary schedule ----
    ctx.progress(0.2, 'network solves over the distributor schedule');
    const circuitRun = (hot, opts = {}) => {
      const C = circuit(hot, opts), nAct = inst.map(t => active(t, hot).length), kd = nAct.indexOf(Math.max(...nAct)), actD = active(inst[kd], hot);
      const Qd = actD.length * C.Qcell;
      // system Δp at the design flow (pressure source so that Q = Q_d)
      const dpSys = brent(G => solveInstant(C, actD, { source: G }).Qp - Qd, 1, 1e7).x;
      let pump;
      if (p.pumpMode === 'user') { const H0 = p.H0 * 1000, Qm = p.Qmax / 60000; pump = { H0, k: H0 / (Qm * Qm), Qbep: 0.6 * Qm }; }
      else { const H0 = 1.33 * dpSys; pump = { H0, k: (H0 - dpSys) / (Qd * Qd), Qbep: Qd }; }
      const sols = inst.map(t => { const act = active(t, hot); return act.length ? { act, ...solveInstant(C, act, pump) } : { act, flows: new Array(N).fill(NaN), Qp: 0, mal: 0, dpPump: 0, pS: [], pT: [], cont: 0, sol: { iterations: 0, residual: 0, hist: [], converged: true } }; });
      const etaOf = (Q) => clamp(p.pumpEta * (2 * Q / pump.Qbep - (Q / pump.Qbep) ** 2), 0.05, p.pumpEta);
      const Hof = (Q) => pump.H0 - pump.k * Q * Q;
      const Ppump = sols.reduce((s, r) => s + (r.Qp > 0 ? Hof(r.Qp) * r.Qp / etaOf(r.Qp) : 0), 0) / sols.length;
      const avgFlow = range(N).map(i => { const v = sols.map(r => r.flows[i]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; });
      const malAvg = (() => { const v = avgFlow.filter(Number.isFinite), m = v.reduce((a, b) => a + b, 0) / v.length; return (Math.max(...v) - Math.min(...v)) / m; })();
      return { C, pump, dpSys, Qd, sols, Ppump, etaOf, Hof, avgFlow, malAvg, malMax: Math.max(...sols.map(r => r.mal)), kd, actD };
    };
    const HOT = circuitRun(true); await pause(ctx);
    const COLD = circuitRun(false); await pause(ctx);
    // alternative layout for comparison
    const ALT = circuitRun(true, { layout: p.layout === 'Z' ? 'U' : 'Z' }); await pause(ctx);
    // ---- system & pump curves (hot circuit, design instant) ----
    const sysDp = linspace(0.02, 2.6, 12).map(fg => fg * HOT.dpSys), sysQ = sysDp.map(G => solveInstant(HOT.C, HOT.actD, { source: G }).Qp);
    const opQ = HOT.sols[HOT.kd].Qp, opH = HOT.Hof(opQ);
    // ---- channel-level distribution inside the mean cell ----
    ctx.progress(0.55, 'channel-level distribution');
    const chNet = (C, Qcell, layout) => {
      const pitch = p.chW + 4e-4, pd = rectDuct(p.plenumW, p.plenumH), Apl = p.plenumW * p.plenumH, fp = C.fp;
      const plLin = pd.fRe * fp.mu * pitch / (2 * pd.Dh ** 2 * Apl), plQuad = (q) => { const Re = fp.rho * Math.abs(q) / Apl * pd.Dh / fp.mu; return Re > 1 ? Math.max(0, darcy(Re, { Dh: pd.Dh }) - pd.fRe / Re) * (pitch / pd.Dh) * fp.rho / (2 * Apl * Apl) : 0; };
      const P = (j) => j, Cn = (j) => M + j, elems = [];
      for (let j = 0; j < M - 1; j++) elems.push({ a: P(j), b: P(j + 1), lin: plLin, quad: 0, hdr: true });
      for (let j = 0; j < M; j++) elems.push({ a: P(j), b: Cn(j), lin: rd.fRe * fp.mu * p.chL / (2 * rd.Dh ** 2 * Ach), quad: p.Kch * fp.rho / (2 * Ach * Ach), ch: j });
      if (layout === 'Z') for (let j = 0; j < M - 1; j++) elems.push({ a: Cn(j), b: Cn(j + 1), lin: plLin, quad: 0, hdr: true });
      else for (let j = M - 1; j > 0; j--) elems.push({ a: Cn(j), b: Cn(j - 1), lin: plLin, quad: 0, hdr: true });
      const outN = layout === 'Z' ? Cn(M - 1) : Cn(0);
      const sol = solveNetwork({ n: 2 * M, fixed: new Map([[outN, 0]]), elems, inj: { [P(0)]: Qcell }, qref: Qcell, tol: p.tol, update: (q) => elems.forEach((e, k) => { if (e.hdr) e.quad = plQuad(q[k]); }) });
      const qc = []; elems.forEach((e, k) => { if (e.ch !== undefined) qc[e.ch] = sol.q[k]; });
      const mean = Qcell / M; return { frac: qc.map(v => v / mean), mal: (Math.max(...qc) - Math.min(...qc)) / mean, sol, dpCell: sol.p[P(0)] };
    };
    const CH = chNet(HOT.C, HOT.C.Qcell, p.layout);
    // ---- header-diameter sweep & uniform limit ----
    ctx.progress(0.7, 'header sweep');
    const Ds = linspace(0.004, 0.03, 8), sweep = ['Z', 'U'].map(lay => Ds.map(D => { const C = circuit(true, { layout: lay, headerD: D }), r = solveInstant(C, HOT.actD, { source: HOT.dpSys }); return r.mal; }));
    const U = solveInstant(circuit(true, { headerD: p.headerD * 100 }), HOT.actD, { source: HOT.dpSys });
    // ---- valves, purge, leakage ----
    const Vch = M * Ach * p.chL, Vpl = 2 * p.plenumW * p.plenumH * M * (p.chW + 4e-4), Vport = 2 * Math.PI * p.portD ** 2 / 4 * 0.01, Vdead = Vch + Vpl + Vport, Vlat = 0.5 * (Vch + Vpl + Vport); // ribbon mid-length sees new fluid after the inlet port, inlet plenum and half the channels
    const tPurgeH = Vlat / HOT.C.Qcell, tPurgeC = Vlat / COLD.C.Qcell, latency = p.tSwitch + Math.max(tPurgeH, tPurgeC);
    const phaseH = duty / f, latFrac = latency / Math.min(phaseH, (1 - duty) / f);
    const rhoCpMean = 0.5 * (HOT.C.fp.rho * HOT.C.fp.cp + COLD.C.fp.rho * COLD.C.fp.cp), dTHC = d.Th - d.Tc;
    const Qmix = 2 * N * f * rhoCpMean * Vdead * dTHC * (1 - p.routing), CfluidCell = rhoCpMean * Vch, CribCell = E.cell.mass * mat0cp, Pvalves = 2 * N * f * p.valveEnergy;
    const pHotSup = Math.max(...HOT.sols.map(r => r.dpPump || 0)), pColdSup = Math.max(...COLD.sols.map(r => r.dpPump || 0));
    const leakQ = (dp, mu) => p.sealLen * (p.sealGap * 1e-6) ** 3 * dp / (12 * mu * p.sealLand * 1e-3);
    const QlH = leakQ(pHotSup, HOT.C.fp.mu), QlC = leakQ(pColdSup, COLD.C.fp.mu), leakage = rhoCpMean * (QlH + QlC) * dTHC;
    const Ppump = HOT.Ppump + COLD.Ppump, dpTotal = HOT.sols[HOT.kd].dpPump, mal = Math.max(HOT.malMax, COLD.malMax);
    const PnetPlant = E.Pshaft - Ppump - Pvalves - E.Pcontrol;
    // ---- verification ----
    const allSols = [...HOT.sols, ...COLD.sols].filter(r => r.act.length);
    out.checks.push({ name: 'Newton convergence at every phase instant (hot & cold)', value: Math.max(...allSols.map(r => r.sol.residual)), target: `< ${p.tol * 10} (relative)`, pass: allSols.every(r => r.sol.converged), detail: `max ${Math.max(...allSols.map(r => r.sol.iterations))} iterations` });
    out.checks.push({ name: 'Mass conservation: pump flow = Σ branch flows', value: Math.max(...allSols.map(r => r.cont)), target: '< 1e-8 (relative)', pass: allSols.every(r => r.cont < 1e-8) });
    out.checks.push({ name: 'Uniform-distribution limit (header resistance → 0)', value: U.mal, target: '< 1e-3', pass: U.mal < 1e-3, detail: `header ×100 diameter: maldistribution ${fmt(U.mal, 3)} vs ${fmt(HOT.sols[HOT.kd].mal, 3)} at design` });
    { const sq = rectDuct(1e-3, 1e-3).fRe; out.checks.push({ name: 'Shah–London square-duct f·Re = 56.91', value: sq, target: '56.91 ± 0.1 %', pass: Math.abs(sq - 56.91) / 56.91 < 1e-3 }); }
    out.checks.push({ name: 'Laminar circular friction f = 64/Re (Re = 1000)', value: darcy(1000), target: '0.064', pass: Math.abs(darcy(1000) - 0.064) < 1e-12 });
    { const r = HOT.sols[HOT.kd], net = r.sol.p[1] - 0; out.checks.push({ name: 'Pump curve = circuit pressure rise at the operating point', value: Math.abs(HOT.Hof(r.Qp) - (net + HOT.C.dpExt / (r.Qd * r.Qd) * r.Qp * r.Qp)) / HOT.Hof(r.Qp), target: '< 1e-6 (relative)', pass: Math.abs(HOT.Hof(r.Qp) - (net + HOT.C.dpExt / (r.Qd * r.Qd) * r.Qp * r.Qp)) / HOT.Hof(r.Qp) < 1e-6 }); }
    out.checks.push({ name: 'Channel-level network converged', value: CH.sol.residual, target: `< ${p.tol * 10}`, pass: CH.sol.converged, detail: `${CH.sol.iterations} iterations, ${2 * M} nodes` });
    // ---- KPIs ----
    const st = (ok, warn) => ok ? 'ok' : warn ? 'warn' : 'bad';
    kpi('Pumping power (hot + cold networks)', Ppump, 'W', `Time-averaged hydraulic power over the distributor cycle ÷ pump efficiency at each operating point (hot ${fmt(HOT.Ppump, 4)} W, cold ${fmt(COLD.Ppump, 4)} W). Engine-model estimate: ${fmt(E.Ppump, 4)} W.`, 'calc', st(Ppump < 0.1 * Math.max(E.Pshaft, 1e-9), Ppump < E.Pshaft));
    kpi('Hot-circuit pump pressure rise', dpTotal, 'Pa', `Pump Δp at the design instant (headers, ports, channels and the ${fmt(HOT.C.dpExt, 4)} Pa external loop), operating flow ${fmt(opQ * 60000, 4)} L/min.`);
    kpi('Flow maldistribution between cells (worst instant)', mal, '', `(Q_max − Q_min)/Q̄ over the active cells, worst phase instant of either circuit (${p.layout}-layout, header Ø ${p.headerD * 1000} mm). Cycle-averaged: hot ${fmt(HOT.malAvg, 3)}, cold ${fmt(COLD.malAvg, 3)}.`, 'calc', st(mal < 0.1, mal < 0.25));
    kpi('Channel maldistribution within a cell', CH.mal, '', `Across the ${M} microchannels of one cell at the mean active-cell flow (plenum ${p.plenumW * 1000} × ${p.plenumH * 1000} mm).`, 'calc', st(CH.mal < 0.1, CH.mal < 0.25));
    kpi('Switching latency', latency, 's', `Valve actuation ${p.tSwitch} s + transport delay to the ribbon mid-length ${fmt(Math.max(tPurgeH, tPurgeC), 3)} s (${fmt(Vlat * 1e6, 3)} mL upstream; ${fmt(Vdead * 1e6, 3)} mL dead volume per cell) = ${fmt(100 * latFrac, 3)} % of the shorter phase.`, 'calc', st(latFrac < 0.1, latFrac < 0.25));
    kpi('Seal leakage (thermal short-circuit)', leakage, 'W', `Hot↔cold leakage across the distributor lands (gap ${p.sealGap} µm): ${fmt((QlH + QlC) * 6e7, 3)} mL/min carrying ${fmt(dTHC, 3)} K.`, 'calc', st(leakage < 0.01 * E.QhotTot, leakage < 0.05 * E.QhotTot));
    kpi('Purge mixing heat loss', Qmix, 'W', `Dead-volume fluid pushed into the wrong return at every switch, ${fmt(100 * (1 - p.routing), 3)} % of it after outlet-delayed routing (full hot–cold difference). The channel water alone holds ${fmt(CfluidCell, 3)} J/K per cell vs ${fmt(CribCell, 3)} J/K of ribbon — fluid inventory, not ribbon mass, dominates the switched heat.`, 'calc', st(Qmix < 0.05 * E.QhotTot, Qmix < 0.15 * E.QhotTot));
    kpi('Plant net power with network pumping', PnetPlant, 'W', `P_shaft ${fmt(E.Pshaft, 4)} − pumps ${fmt(Ppump, 4)} − valves ${fmt(Pvalves, 3)} − control ${E.Pcontrol} W (replaces the engine model’s ×1.5 pumping estimate).`, 'calc', st(PnetPlant > 0));
    // ---- verdicts ----
    const V = (test, status, detail, fix) => out.verdicts.push({ test, status, detail, fix });
    const Dok = Ds.find((D, i) => sweep[p.layout === 'Z' ? 0 : 1][i] < 0.1);
    V('Cell-to-cell flow maldistribution', mal < 0.1 ? 'pass' : mal < 0.25 ? 'warn' : 'fail', `Worst instantaneous spread ${fmt(100 * mal, 3)} %. The starved cell heats/cools slower: its fluid temperature change grows by ≈ ${fmt(100 * (1 / Math.max(1e-3, 1 - mal / 2) - 1), 3)} %.`, Dok ? `Increase the header diameter to ≥ ${fmt(Dok * 1000, 3)} mm (sweep), add branch restriction (smaller ports), or use the ${p.layout === 'Z' ? 'U' : 'Z'} layout if it is better in the sweep.` : 'Raise branch resistance relative to header resistance (orifices) or feed both header ends.');
    V('Channel distribution inside a cell', CH.mal < 0.1 ? 'pass' : CH.mal < 0.25 ? 'warn' : 'fail', `Spread ${fmt(100 * CH.mal, 3)} % over ${M} channels.`, 'Enlarge the cell plenum or taper it; the plenum Δp must be ≪ the channel Δp.');
    V('Switching latency vs phase duration', latFrac < 0.1 ? 'pass' : latFrac < 0.25 ? 'warn' : 'fail', `${fmt(latency * 1000, 4)} ms of ${fmt(Math.min(phaseH, (1 - duty) / f) * 1000, 4)} ms phase (${fmt(100 * latFrac, 3)} %) is lost to actuation and purge.`, 'Reduce plenum/port dead volume, increase cell flow, or lower the cycle frequency.');
    V('Purge mixing heat vs engine heat demand', Qmix < 0.05 * E.QhotTot ? 'pass' : Qmix < 0.15 * E.QhotTot ? 'warn' : 'fail', `${fmt(Qmix, 4)} W = ${fmt(100 * Qmix / E.QhotTot, 3)} % of Q_hot with ${fmt(100 * p.routing, 3)} % routing efficiency; the engine model does not include channel-fluid inventory, so this is an additional heat demand.`, 'Reduce channel and plenum volume (shallower channels, integrated valves at the cell), delay outlet switching by the purge time, or regenerate the purge (Suite 09).');
    V('Pumping vs engine output', Ppump < 0.1 * Math.max(E.Pshaft, 0) ? 'pass' : Ppump < E.Pshaft ? 'warn' : 'fail', `Pumping ${fmt(Ppump, 4)} W vs shaft power ${fmt(E.Pshaft, 4)} W → plant net ${fmt(PnetPlant, 4)} W.`, 'Lower Δp (larger headers/ports, fewer losses), raise fluid ΔT (less flow), use variable-speed pumps.');
    V('Seal leakage', leakage < 0.01 * E.QhotTot ? 'pass' : leakage < 0.05 * E.QhotTot ? 'warn' : 'fail', `${fmt(leakage, 4)} W thermal short-circuit (${fmt(100 * leakage / E.QhotTot, 3)} % of Q_hot); leakage scales with gap³ — ${p.sealGap} µm.`, 'Tighter lands, longer seal width, or pressure-balanced distributor.');
    V('Pump operating near best efficiency', Math.abs(opQ / HOT.pump.Qbep - 1) < 0.25 ? 'pass' : 'warn', `Q/Q_BEP = ${fmt(opQ / HOT.pump.Qbep, 3)}, η = ${fmt(HOT.etaOf(opQ), 3)}.`, 'Re-select the pump or trim the impeller / use speed control.');
    V('Missing measurements (requested)', 'info', 'No pump map or manifold test data imported. Measure: pump H–Q–power curve, per-cell flow (ultrasonic or thermal-tracer) at several distributor positions, header static pressures, distributor leakage at rated Δp and valve switching time.', 'Import data to calibrate port K, channel f·Re and seal gap.');
    // ---- charts ----
    const L = (v) => v * 60000;
    out.charts.push({ type: 'line', title: 'Pump curve vs system curve (hot circuit)', x: { label: 'Flow', unit: 'L/min' }, y: { label: 'Pressure', unit: 'kPa' }, series: [{ name: 'System curve', x: sysQ.map(L), y: sysDp.map(v => v / 1000) }, { name: 'Pump curve', x: linspace(0, 1.6 * HOT.Qd, 30).map(L), y: linspace(0, 1.6 * HOT.Qd, 30).map(Q => Math.max(0, HOT.Hof(Q)) / 1000) }, { name: 'Pump efficiency ×100 (kPa axis)', x: linspace(0.05, 1.6, 30).map(fq => L(fq * HOT.Qd)), y: linspace(0.05, 1.6, 30).map(fq => HOT.etaOf(fq * HOT.Qd) * 100 * (HOT.pump.H0 / 1000) / 100), dash: true }], annotations: [{ type: 'point', x: L(opQ), y: opH / 1000, label: 'operating point' }], explain: `The operating point is where the pump curve meets the circuit (system) curve: ${fmt(L(opQ), 4)} L/min at ${fmt(opH / 1000, 4)} kPa. ${p.pumpMode === 'auto' ? 'The pump was auto-selected through the design flow with a 33 % shut-off margin.' : 'User-specified pump curve.'} Dashed: efficiency (scaled).` });
    const cats = range(N).map(i => `C${i + 1}`);
    out.charts.push({ type: 'bar', title: 'Cycle-averaged flow per cell (active phases)', categories: cats, series: [{ name: `Hot, ${p.layout}`, values: HOT.avgFlow.map(v => +(L(v)).toFixed(4)) }, { name: 'Cold', values: COLD.avgFlow.map(v => +(L(v)).toFixed(4)) }, { name: `Hot, ${p.layout === 'Z' ? 'U' : 'Z'} (alternative)`, values: ALT.avgFlow.map(v => +(L(v)).toFixed(4)) }], explain: `Flow each cell receives while connected, averaged over the distributor cycle [L/min]. Cells far from the inlet receive less in a ${p.layout}-layout when header friction is comparable with branch resistance. Design: ${fmt(L(HOT.C.Qcell), 4)} L/min (hot).`, wide: true });
    out.charts.push({ type: 'heatmap', title: 'Hot-circuit flow per cell over the distributor cycle', x: { label: 'Cell', values: range(N).map(i => i + 1) }, y: { label: 'Phase instant (fraction of cycle)', values: inst }, z: HOT.sols.map(r => r.flows.map(v => (Number.isFinite(v) ? v / HOT.C.Qcell : NaN))), zlabel: 'Q / Q_design', cmap: 'turbo', explain: 'Each row is one distributor position; coloured cells are connected to the hot header (blank = in cold phase). Colour is flow relative to design — shows which cells starve and when.' });
    out.charts.push({ type: 'heatmap', title: 'Per-cell × per-channel flow field (hot circuit)', x: { label: 'Channel index', values: range(M).map(j => j + 1) }, y: { label: 'Cell', values: range(N).map(i => i + 1) }, z: range(N).map(i => CH.frac.map(fr => (Number.isFinite(HOT.avgFlow[i]) ? fr * HOT.avgFlow[i] / HOT.C.Qcell : NaN))), zlabel: 'Q_channel / design', cmap: 'viridis', isolines: 5, explain: `Product of the cell-level (header) and channel-level (plenum) distributions — the local coolant supply each ribbon segment sees. Channel spread ${fmt(100 * CH.mal, 3)} %, cell spread ${fmt(100 * HOT.malAvg, 3)} %.`, wide: true });
    const r0 = HOT.sols[HOT.kd];
    out.charts.push({ type: 'line', title: 'Header pressure profiles (hot, design instant)', x: { label: 'Cell position' }, y: { label: 'Gauge pressure', unit: 'kPa' }, series: [{ name: 'Supply header', x: range(N).map(i => i + 1), y: r0.pS.map(v => v / 1000) }, { name: 'Return header', x: range(N).map(i => i + 1), y: r0.pT.map(v => v / 1000) }], explain: 'The branch driving pressure at each cell is the vertical gap between the supply and return curves; where the gap narrows the cell starves. A Z-layout keeps the gap nearly parallel; a U-layout concentrates flow near the inlet end.' });
    out.charts.push({ type: 'line', title: 'Maldistribution vs header diameter', x: { label: 'Header diameter', unit: 'mm' }, y: { label: 'Maldistribution (Q_max − Q_min)/Q̄', log: true }, series: [{ name: 'Z-layout', x: Ds.map(v => v * 1000), y: sweep[0].map(v => Math.max(v, 1e-6)) }, { name: 'U-layout', x: Ds.map(v => v * 1000), y: sweep[1].map(v => Math.max(v, 1e-6)) }], annotations: [{ type: 'vline', x: p.headerD * 1000, label: 'current' }, { type: 'hline', y: 0.1, label: '10 %' }], explain: 'Header resistance scales ≈ D⁻⁴…D⁻⁵ while branch resistance is fixed, so maldistribution falls steeply with diameter. Use this to pick the smallest header meeting the 10 % target (less fluid inventory and dead volume).' });
    out.charts.push({ type: 'bar', title: 'Fluid-auxiliary power budget', categories: ['Hot pump', 'Cold pump', 'Valve switching', 'Control', 'Shaft power', 'Plant net'], series: [{ name: 'W', values: [HOT.Ppump, COLD.Ppump, Pvalves, E.Pcontrol, E.Pshaft, PnetPlant].map(v => +v.toFixed(4)) }], explain: 'Every auxiliary is charged against the shaft power (spec: net = gross − reset − losses − all auxiliaries). Purge and leakage are heat losses (raise Q_hot) and are reported separately as KPIs.' });
    // ---- tables ----
    out.tables.push({ title: 'Circuit summary', cols: ['Quantity', 'Hot circuit', 'Cold circuit'], rows: [['Fluid / mean T', `${HOT.C.fp.name} / ${fmt(d.Th - d.fluidDT / 2, 3)} °C`, `${COLD.C.fp.name} / ${fmt(d.Tc + d.fluidDT / 2, 3)} °C`], ['Design cell flow [L/min]', fmt(L(HOT.C.Qcell), 4), fmt(L(COLD.C.Qcell), 4)], ['Design circuit flow [L/min]', fmt(L(HOT.Qd), 4), fmt(L(COLD.Qd), 4)], ['System Δp at design [Pa]', fmt(HOT.dpSys, 4), fmt(COLD.dpSys, 4)], ['Pump H₀ [kPa] / k [Pa/(m³/s)²]', `${fmt(HOT.pump.H0 / 1000, 4)} / ${fmt(HOT.pump.k, 3)}`, `${fmt(COLD.pump.H0 / 1000, 4)} / ${fmt(COLD.pump.k, 3)}`], ['Mean pump power [W]', fmt(HOT.Ppump, 4), fmt(COLD.Ppump, 4)], ['Maldistribution worst / avg', `${fmt(HOT.malMax, 3)} / ${fmt(HOT.malAvg, 3)}`, `${fmt(COLD.malMax, 3)} / ${fmt(COLD.malAvg, 3)}`], ['Branch R_lin [Pa·s/m³] / K [Pa·s²/m⁶]', `${fmt(HOT.C.branch.lin, 4)} / ${fmt(HOT.C.branch.quad, 4)}`, `${fmt(COLD.C.branch.lin, 4)} / ${fmt(COLD.C.branch.quad, 4)}`], ['Purge time [ms]', fmt(tPurgeH * 1000, 4), fmt(tPurgeC * 1000, 4)], ['Seal leakage [mL/min]', fmt(QlH * 6e7, 3), fmt(QlC * 6e7, 3)]], explain: `Networks: ${N} cells, ${p.layout}-layout, header Ø ${p.headerD * 1000} mm, ports Ø ${p.portD * 1000} mm, ${M} channels ${p.chW * 1000}×${p.chH * 1000} mm × ${p.chL * 1000} mm. Phase offsets: ${offProv === 'coupled' ? 'Suite 12' : 'equal spacing'}.` });
    out.tables.push({ title: 'Per-instant hot-circuit solution', cols: ['Instant', 'Active cells', 'Q pump [L/min]', 'Δp pump [kPa]', 'Maldistribution', 'Newton its'], rows: HOT.sols.map((r, k) => [fmt(inst[k], 3), r.act.map(i => i + 1).join(' '), fmt(L(r.Qp), 4), fmt((r.dpPump || 0) / 1000, 4), fmt(r.mal, 3), r.sol.iterations]), explain: 'Each distributor position is a separate steady network solve.' });
    out.convergence = { title: 'Newton residual history (hot circuit, design instant; channel network)', series: [{ name: 'Header network', x: r0.sol.hist.map((_, i) => i + 1), y: r0.sol.hist.map(v => Math.max(v, 1e-16)) }, { name: 'Channel network', x: CH.sol.hist.map((_, i) => i + 1), y: CH.sol.hist.map(v => Math.max(v, 1e-16)) }] };
    // ---- narrative & recommendations ----
    out.explain.push({ title: 'What was computed', text: `Hot and cold distribution networks (${2 * N + 1} nodes each) were solved at ${K} distributor positions with a nodal Newton method. Engine flows come from the shared engine model (${fmt(E.mdotH, 4)} / ${fmt(E.mdotC, 4)} kg/s hot/cold, ΔT ${d.fluidDT} K). The channel network of one cell (${2 * M} nodes) gives the within-cell distribution.` });
    out.explain.push({ title: 'Where the pumping goes', text: `At the design instant the hot pump supplies ${fmt(opH / 1000, 4)} kPa: external loop ${fmt(HOT.C.dpExt / 1000, 3)} kPa, headers and branches the rest. Network pumping ${fmt(Ppump, 4)} W ${Ppump > E.Ppump ? 'exceeds' : 'is below'} the engine model’s lumped estimate (${fmt(E.Ppump, 4)} W).` });
    const rec = (level, text, basis) => out.recs.push({ level, text, basis });
    if (mal >= 0.1) rec(mal >= 0.25 ? 'critical' : 'warn', `Cell flows differ by ${fmt(100 * mal, 3)} %. ${Dok ? `A ${fmt(Dok * 1000, 3)} mm header brings it below 10 %.` : 'Add balancing orifices at each port.'} Starved cells limit the cycle frequency (Suite 08).`, 'Maldistribution sweep');
    else rec('good', `Cell flows within ${fmt(100 * mal, 3)} % — header sizing adequate.`, 'Network solution');
    if (ALT.malAvg < HOT.malAvg * 0.8) rec('info', `The ${p.layout === 'Z' ? 'U' : 'Z'}-layout reduces cycle-averaged maldistribution from ${fmt(HOT.malAvg, 3)} to ${fmt(ALT.malAvg, 3)}.`, 'Layout comparison');
    if (latFrac >= 0.1) rec('warn', `Switching consumes ${fmt(100 * latFrac, 3)} % of each phase; dead volume ${fmt(Vdead * 1e6, 3)} mL per cell (channels ${fmt(Vch * 1e6, 3)}, plenums ${fmt(Vpl * 1e6, 3)}, ports ${fmt(Vport * 1e6, 3)} mL) dominates.`, 'Latency');
    if (PnetPlant <= 0) rec('critical', `Network pumping (${fmt(Ppump, 4)} W) plus valves leaves no net output (${fmt(PnetPlant, 4)} W).`, 'Power budget');
    rec('econ', `Pumping costs ${fmt(Ppump * 8.76 * p.elecPrice, 4)} USD/yr at ${p.elecPrice} USD/kWh (continuous) — ${E.Pshaft > 0 ? fmt(100 * Ppump / E.Pshaft, 3) + ' % of shaft output' : 'with no shaft output'}.`, 'Pump power');
    rec('sustain', `Leakage and purge add ${fmt(leakage + Qmix, 4)} W of heat demand (${fmt(100 * (leakage + Qmix) / E.QhotTot, 3)} % of Q_hot); pumps emit ${fmt(Ppump * 24 / 1000 * p.gridCO2, 3)} kg CO₂/day if grid-powered. Smaller dead volume and tighter seals reduce both.`, 'Leakage & purge');
    const anim = { N, inst, offs, duty, hot: HOT.sols.map(r => r.flows.map(v => (Number.isFinite(v) ? v / HOT.C.Qcell : 0))), cold: COLD.sols.map(r => r.flows.map(v => (Number.isFinite(v) ? v / COLD.C.Qcell : 0))), Qh: HOT.sols.map(r => L(r.Qp)), Qc: COLD.sols.map(r => L(r.Qp)), dph: HOT.sols.map(r => (r.dpPump || 0) / 1000), period: 1 / f };
    out.views.push({ label: '2D animation: rotary distributor and cell flows', icon: '🎞', render: (el) => animDistributor(el, anim) });
    out.outputs = { Ppump_W: Ppump, dpTotal_Pa: dpTotal, maldistribution: mal, valveLatency_s: latency, leakage_W: leakage };
    out.headline = `${p.layout}-manifold, ${N} cells: pumping ${fmt(Ppump, 4)} W (hot Δp ${fmt(dpTotal / 1000, 4)} kPa), maldistribution ${fmt(100 * mal, 3)} % (channels ${fmt(100 * CH.mal, 3)} %), switching latency ${fmt(latency * 1000, 4)} ms, leakage ${fmt(leakage, 3)} W; plant net ${fmt(PnetPlant, 4)} W.`;
    out.headlineKind = PnetPlant <= 0 || mal >= 0.25 ? 'fail' : mal >= 0.1 || latFrac >= 0.1 ? 'warn' : 'ok';
    out.credibility = 'Analytical screening';
    return out;
  },
};

async function animDistributor(el, A) {
  const [{ anim2d, seriesPanel, text, theme }, { cmap }] = await Promise.all([import('../core/anim2d.js'), import('../core/chart.js')]);
  const T = A.inst.map(t => t * A.period);
  anim2d(el, { duration: A.period, rate: A.period / 6, label: 'Time in engine cycle', unit: 's', height: 420, explain: 'Solved distributor schedule: each wedge is a cell; red = connected to the hot header, blue = cold, brightness = solved flow relative to design. Lower panels: total pump flows and hot pump pressure at each distributor position (step-wise between solved instants).', draw(g, t, W, H) {
    const th = theme(), k = Math.min(A.inst.length - 1, Math.floor(t / A.period * A.inst.length)), cx = Math.min(W * 0.25, 170), cy = 130, R = 100;
    for (let i = 0; i < A.N; i++) {
      const a0 = 2 * Math.PI * (i / A.N) - Math.PI / 2, a1 = a0 + 2 * Math.PI / A.N, hot = A.hot[k][i] > 0, v = hot ? A.hot[k][i] : A.cold[k][i];
      const c = cmap(clamp(0.35 + 0.5 * (v - 0.8) / 0.4, 0, 1), hot ? 'inferno' : 'viridis');
      g.fillStyle = `rgb(${c.map(Math.round).join(',')})`; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a0, a1); g.closePath(); g.fill(); g.strokeStyle = th.bg; g.stroke();
      const am = (a0 + a1) / 2; text(g, `${i + 1}`, cx + (R + 10) * Math.cos(am) - 5, cy + (R + 10) * Math.sin(am) + 4, th.mute);
    }
    g.fillStyle = th.bg2; g.beginPath(); g.arc(cx, cy, R * 0.35, 0, 7); g.fill(); text(g, `pos ${k + 1}/${A.inst.length}`, cx - 26, cy + 4, th.fg);
    const x0 = cx + R + 40, w = W - x0 - 10, ph = (H - 30) / 2 - 6;
    seriesPanel(g, { x: x0, y: 10, w, h: ph, T, t, title: 'Pump flows', unit: 'L/min', series: [{ name: 'hot', y: A.Qh, color: '#ef4444' }, { name: 'cold', y: A.Qc, color: '#38bdf8' }] });
    seriesPanel(g, { x: x0, y: 20 + ph, w, h: ph, T, t, title: 'Hot pump Δp', unit: 'kPa', series: [{ name: 'Δp', y: A.dph, color: '#f59e0b' }] });
    text(g, 'red: hot header · blue/green: cold header · brighter = more flow', 10, H - 8, th.mute);
  } });
}
