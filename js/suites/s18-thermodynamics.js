// Suite 18 — Thermodynamic accounting, efficiency and exergy.
// Whole-engine first- and second-law books from the reference engine model (and measured heat-flow / shaft-power columns
// when imported). Gross → shaft → net power with every auxiliary itemised; efficiency against Carnot and Curzon–Ahlborn;
// exergy flows and Gouy–Stodola destruction by component from the synchronised cell histories (fluid film, wall→ribbon,
// transformation hysteresis/internal, fluid switching), the regenerator, pumping, valves, friction and control; entropy
// generation and an independent conservation residual. Measurement uncertainty (spec §34) is propagated by Monte Carlo to
// confidence intervals of net power and efficiency, and every “100×” statement is forced into a declaration table.
import { fmt, linspace, clamp, mean, min, max, percentile, histogram, cumtrapz } from '../core/num.js';
import { propagate } from '../core/analysis.js';
import { anim2d, seriesPanel, bar as barG, text } from '../core/anim2d.js';

const K = 273.15;
const pause = async (ctx) => { try { if (typeof requestAnimationFrame === 'function') await ctx.yield(); else await new Promise(r => setTimeout(r, 0)); } catch { /* advisory */ } };
// find a numeric column whose header matches one of the patterns
const findCol = (ds, pats) => { const h = ds.header || Object.keys(ds.columns || {}); const k = h.find(c => pats.some(p => p.test(c))); return k && Array.isArray(ds.columns?.[k]) ? ds.columns[k].map(Number).filter(Number.isFinite) : null; };

export default {
  description: 'Closes the energy and exergy books of the whole engine: gross, shaft and net power with every auxiliary itemised, heat input and rejection, efficiency against Carnot and Curzon–Ahlborn, exergy destroyed in each component (heat-transfer films, regenerator, transformation hysteresis, switching, pumping, valves, friction, control), entropy generation and conservation residuals — with measurement-uncertainty confidence intervals and a mandatory declaration table for any “100×” claim.',
  literature: 'exergy analysis entropy generation shape memory alloy heat engine efficiency Carnot fraction',
  econ: true, sustain: true,
  credibility: 'Analytical screening',
  equations: [
    'P_net = P_gross·η_tr − P_bearing − P_pump − P_valves − P_control;  P_gross = N·W_cycle·f',
    'η = P_net/Q_hot ≤ η_C = 1 − T_c/T_h;  η_CA = 1 − √(T_c/T_h) (Curzon–Ahlborn, endoreversible maximum-power efficiency)',
    'First law (engine): Q_hot − P_net − Q_rej,total = 0;  independent residual r = (Q_hot − P_gross − N f (Q_cold − ε_r Q_sens))/Q_hot',
    'Exergy of heat: X_Q = Q(1 − T₀/T);  balance X_in = P_net + Σ X_d,i + X_rej',
    'Gouy–Stodola: X_d = T₀·S_gen;  S_gen,total = Q_rej,total/T_c − Q_hot/T_h',
    'Film: S = ∮ q (1/T_w − 1/T_f) dt; wall→ribbon: ∮ q_r (1/T_r − 1/T_w) dt, q_r = q − C_w A dT_w/dt; ribbon internal: −∮ q_r/T_r dt; switching: S_res + ∮ q/T_f dt',
    'Hysteresis estimate (Clausius–Clapeyron): D = m L_h Δξ ΔT_hys/T_eq per cycle',
    'Regenerator (screening): X_d = T₀ Q_reg ΔT_pinch/(T̄² − ΔT_pinch²/4), ΔT_pinch = (1 − ε)(T_h − T_c)',
    'Measurement chain: Q_hot = ṁ c_p ΔT, P_shaft = τ ω, P_net = P_shaft − P_aux, p = P_net/m_active (Monte Carlo, Latin hypercube)',
  ],
  methods: [
    'Reference engine evaluation (engine.engineModel) with the coupled operating point from Suites 06/07/09/11/13/14 where available',
    'Cycle entropy integrals evaluated on the synchronised last-cycle histories (wall storage removed by the discrete derivative of the wall temperature)',
    'Thermal destruction allocated to heat-transfer terms after subtracting the regenerator and hysteresis terms; the allocation factor is reported',
    'Monte-Carlo (Latin hypercube) propagation of sensor uncertainties to 95 % confidence intervals; one-at-a-time variance shares',
    'Carnot-fraction map over (T_h, T_c) from low-resolution engine runs; infeasible points masked by the physical pre-screen',
    'Imported datasets: columns for heat input, shaft power (or torque × speed) and auxiliary power are recognised automatically and reconciled against the model',
  ],
  assumptions: [
    'Reservoirs at the hot and cold fluid supply temperatures; dead state T₀ = ambient',
    'All auxiliary and friction power is dissipated and rejected to the cold side',
    'Regenerator destruction uses a pinch-based screening estimate (Suite 09 resolves it)',
    'Measured columns are taken as time-averaged over whole cycles; drift and thermal-inventory changes are not corrected here (Suite 19)',
    'Library material values; no lot calibration',
  ],
  ibc: {
    initial: ['Cyclic steady state of the representative cell (periodicity reported)'],
    boundary: ['Hot reservoir T_h, cold reservoir T_c, ambient T₀; shaft measurement station after the transmission; auxiliaries at their electrical/mechanical input'],
  },
  cvv: {
    calibration: ['Heat-flow meters (ṁ, c_p, ΔT) and dynamometer (torque, speed) with traceable certificates', 'Auxiliary power meters'],
    verification: ['Exergy balance identity X_in = P_net + X_d + X_rej', 'Cell entropy identity: allocated terms sum to the reservoir entropy generation', 'η ≤ η_C everywhere', 'First-law residual of the cell solver'],
    validation: ['Independent metrology of Q_hot, Q_rej, shaft power and auxiliaries on the V2–V4 rigs with reconciled energy balance (closure within the combined uncertainty)'],
  },
  formats: { import: ['CSV with columns Q_hot [W], P_shaft [W] or torque [N·m] + rpm, P_aux [W], T_hot, T_cold'], export: ['Energy/exergy balance CSV', 'Claim declaration CSV', 'Charts PNG/SVG'] },
  params: [
    { key: 'Th', label: 'Hot reservoir (supply) temperature', unit: '°C', type: 'number', min: 10, max: 300, step: 0.5, default: 70, group: 'Reservoirs', auto: (c) => { const o = c.upstream('s06'); return o?.ThSupply_C !== undefined ? { value: +o.ThSupply_C.toFixed(2), prov: 'coupled' } : { value: c.engine.Th, prov: 'calc' }; } },
    { key: 'Tc', label: 'Cold reservoir (supply) temperature', unit: '°C', type: 'number', min: -30, max: 100, step: 0.5, default: 15, group: 'Reservoirs', auto: (c) => { const o = c.upstream('s07'); return o?.TcSupply_C !== undefined ? { value: +o.TcSupply_C.toFixed(2), prov: 'coupled' } : { value: c.engine.Tc, prov: 'calc' }; } },
    { key: 'T0', label: 'Dead-state (ambient) temperature', unit: '°C', type: 'number', min: -30, max: 50, step: 0.5, default: 20, group: 'Reservoirs', auto: (c) => { const o = c.upstream('s07'); return o?.ambient_C !== undefined ? { value: +o.ambient_C.toFixed(2), prov: 'coupled' } : { value: c.engine.T0, prov: 'calc' }; } },
    { key: 'freq', label: 'Cycle frequency', unit: 'Hz', type: 'number', min: 0.02, max: 20, step: 0.01, default: 1, group: 'Operating point', auto: (c) => { const o = c.upstream('s14'); return o?.freq_Hz ? { value: +o.freq_Hz.toFixed(4), prov: 'coupled' } : { value: c.engine.freq, prov: 'calc' }; } },
    { key: 'sigmaH', label: 'Effective power-stroke stress', unit: 'MPa', type: 'number', min: 1, max: 600, step: 0.5, default: 110, group: 'Operating point', auto: (c) => { const o = c.upstream('s14'); return o?.sigmaHeff_MPa ? { value: +o.sigmaHeff_MPa.toFixed(2), prov: 'coupled' } : { value: c.engine.sigmaH, prov: 'calc' }; } },
    { key: 'regenEff', label: 'Regenerator effectiveness', type: 'number', min: 0, max: 0.98, step: 0.01, default: 0.6, group: 'Operating point', auto: (c) => { const o = c.upstream('s09'); return o?.regenEff !== undefined ? { value: +o.regenEff.toFixed(3), prov: 'coupled' } : { value: c.engine.regenEff, prov: 'calc' }; } },
    { key: 'transEff', label: 'Transmission efficiency', type: 'number', min: 0.3, max: 1, step: 0.01, default: 0.9, group: 'Operating point', auto: (c) => { const o = c.upstream('s11'); return o?.transEff ? { value: +o.transEff.toFixed(3), prov: 'coupled' } : { value: c.engine.transEff, prov: 'calc' }; } },
    { key: 'usePump13', label: 'Use Suite 13 pump power when available', type: 'bool', default: true, group: 'Operating point' },
    { key: 'uT', label: 'Temperature sensor uncertainty (independent, 1σ)', unit: 'K', type: 'number', min: 0, max: 2, step: 0.01, default: 0.1, group: 'Measurement uncertainty (§34)' },
    { key: 'uMdot', label: 'Mass-flow meter uncertainty (1σ)', unit: '%', type: 'number', min: 0, max: 10, step: 0.1, default: 1, group: 'Measurement uncertainty (§34)' },
    { key: 'uCp', label: 'Heat-capacity uncertainty (1σ)', unit: '%', type: 'number', min: 0, max: 5, step: 0.1, default: 0.5, group: 'Measurement uncertainty (§34)' },
    { key: 'uTorque', label: 'Torque transducer uncertainty (1σ)', unit: '%', type: 'number', min: 0, max: 10, step: 0.05, default: 0.5, group: 'Measurement uncertainty (§34)' },
    { key: 'uSpeed', label: 'Speed sensor uncertainty (1σ)', unit: '%', type: 'number', min: 0, max: 5, step: 0.01, default: 0.1, group: 'Measurement uncertainty (§34)' },
    { key: 'uAux', label: 'Auxiliary power meter uncertainty (1σ)', unit: '%', type: 'number', min: 0, max: 10, step: 0.1, default: 2, group: 'Measurement uncertainty (§34)' },
    { key: 'uMass', label: 'Active-mass determination uncertainty (1σ)', unit: '%', type: 'number', min: 0, max: 10, step: 0.1, default: 0.5, group: 'Measurement uncertainty (§34)' },
    { key: 'testHours', label: 'Demonstrated continuous test duration', unit: 'h', type: 'number', min: 0, max: 10000, step: 1, default: 0, group: '100× claim declaration', help: '0 = no demonstration (simulation only).' },
    { key: 'nMC', label: 'Monte-Carlo samples', type: 'number', min: 200, max: 50000, step: 100, default: 4000, group: 'Numerics', expert: true },
    { key: 'nCell', label: 'Half-thickness cells', type: 'number', min: 1, max: 8, step: 1, default: 2, group: 'Numerics', expert: true },
    { key: 'spc', label: 'Steps per cycle', type: 'number', min: 60, max: 1200, step: 20, default: 200, group: 'Numerics', expert: true },
    { key: 'cycles', label: 'Cycles to periodic state', type: 'number', min: 2, max: 10, step: 1, default: 4, group: 'Numerics', expert: true },
    { key: 'mapN', label: 'Carnot-fraction map resolution (T_h points)', type: 'number', min: 3, max: 12, step: 1, default: 5, group: 'Numerics', expert: true },
  ],
  presets: [
    { label: 'Laboratory metrology (tight sensors)', values: { uT: 0.03, uMdot: 0.3, uCp: 0.2, uTorque: 0.1, uSpeed: 0.02, uAux: 0.5 } },
    { label: 'Field instrumentation (loose sensors)', values: { uT: 0.3, uMdot: 2.5, uCp: 1, uTorque: 1.5, uSpeed: 0.5, uAux: 5 } },
    { label: 'No regenerator (matched comparison, risk §40)', values: { regenEff: 0 } },
    { label: 'Ideal regenerator bound', values: { regenEff: 0.95 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const { eng, heat } = ctx;
    const d = eng.designWith(ctx.engine, { Th: p.Th, Tc: p.Tc, T0: p.T0, freq: p.freq, sigmaH: p.sigmaH, regenEff: p.regenEff, transEff: p.transEff });
    const s14 = ctx.upstream('s14'); if (s14?.hHot) { d.hHot = s14.hHot; if (s14.hCold) d.hCold = s14.hCold; }
    const mat = ctx.materials.get(d.alloy) || ctx.material('ribbon');
    const prog = (f, m) => { try { ctx.progress(f, m); } catch { /* headless */ } };
    const pre = eng.preScreen(d, mat);
    for (const v of pre.filter(v => v.status !== 'pass')) out.verdicts.push({ test: 'Pre-screen: ' + v.test, status: v.status, detail: v.detail, fix: v.fix });
    if (pre.some(v => v.status === 'fail')) {
      out.headline = 'Infeasible operating point — no thermodynamic cycle to account'; out.headlineKind = 'fail';
      out.kpis.push({ label: 'Pre-screen failures', value: pre.filter(v => v.status === 'fail').length, explain: 'Physical feasibility tests failed before solving (see verdicts for cause and fix).', status: 'bad' });
      out.outputs = { Pnet_W: 0, Pgross_W: 0, Paux_W: 0, Qhot_W: 0, eta: 0, etaC: heat.carnot(d.Th, d.Tc), carnotFraction: 0, exergyDestroyed_W: NaN, residual: NaN };
      return out;
    }
    prog(0.05, 'engine model');
    const E = eng.engineModel(d, { mat, n: p.nCell, stepsPerCycle: p.spc, cycles: p.cycles }), c = E.cell, H = c.hist, N = E.N, f = E.f;
    // ---- itemised power accounting (Suite 13 pump power replaces the model estimate when available)
    const s13 = ctx.upstream('s13'), pumpSrc = p.usePump13 && s13?.Ppump_W > 0 ? 'Suite 13 (coupled)' : 'engine model', Ppump = p.usePump13 && s13?.Ppump_W > 0 ? s13.Ppump_W : E.Ppump;
    const Pgross = E.Pgross, Ptrans = Pgross * (1 - d.transEff), Pbear = d.bearingLoss, Pshaft = Pgross - Ptrans - Pbear, Pvalves = E.Pvalves, Pctrl = d.controlPower;
    const Paux = Ppump + Pvalves + Pctrl, Pnet = Pshaft - Paux, Qhot = E.QhotTot, QrejAll = Qhot - Pnet;
    const ThK = d.Th + K, TcK = d.Tc + K, T0K = d.T0 + K, etaC = heat.carnot(d.Th, d.Tc), etaCA = heat.curzonAhlborn(d.Th, d.Tc);
    const eta = Qhot > 0 ? Pnet / Qhot : 0, cf = etaC > 0 ? eta / etaC : 0;
    // ---- independent first-law residual from the cell's own heat rejection
    const sens = E.sensible, QrejCell = N * f * (c.Qcold - d.regenEff * sens + (E.Qpurge || 0)), residual = (Qhot - Pgross - QrejCell) / Math.max(1e-12, Qhot);
    // ---- exergy & entropy (engine level)
    const XhotIn = Qhot * (1 - T0K / ThK), XcoldTerm = QrejAll * (T0K / TcK - 1); // > 0: cold exergy consumed; < 0: exergy rejected
    const Xin = XhotIn + Math.max(0, XcoldTerm), Xrej = Math.max(0, -XcoldTerm);
    const Sgen = QrejAll / TcK - Qhot / ThK, Xd = T0K * Sgen, exBal = Math.abs(Xin - Pnet - Xd - Xrej) / Math.max(1e-12, Xin);
    // ---- cell-cycle entropy integrals (per cell, per cycle)
    const P = 1 / f, dt = P / H.t.length, Cw = d.wallCapacity * c.faceArea, n = H.t.length;
    let Sfw = 0, Swr = 0, Sint = 0, Sstore = 0, SqTf = 0; const qRib = new Array(n);
    for (let i = 0; i < n; i++) {
      const Tf = H.Tf[i] + K, Tw = H.Tw[i] + K, Tr = H.Tm[i] + K, TwPrev = H.Tw[(i - 1 + n) % n] + K;
      const q = H.qIn[i], dTw = Tw - TwPrev, qr = q - Cw * dTw / dt; qRib[i] = qr;
      Sfw += q * (1 / Tw - 1 / Tf) * dt; Swr += qr * (1 / Tr - 1 / Tw) * dt; Sint += -qr / Tr * dt; Sstore += Cw * dTw / Tw; SqTf += q / Tf * dt;
    }
    const Sres = c.Qcold / TcK - c.Qhot / ThK, Smix = Sres + SqTf, cellSum = Sfw + Swr + Sint + Smix - Sstore, idCell = Math.abs(cellSum - Sres) / Math.max(1e-12, Math.abs(Sres));
    const Teq = 0.5 * (mat.As + mat.Ms) + K + 0.5 * (d.sigmaL / mat.CM + d.sigmaH / mat.CA), hyst = mat.hyst ?? (mat.Af - mat.Ms);
    const Dhyst = c.mass * (mat.Lh || 0) * c.xiSwing * hyst / Teq, XhystCC = N * f * T0K * Dhyst / Teq;
    // ---- engine-level allocation
    const Xmech = { 'Pumping (fluid friction)': Ppump, 'Valve actuation & throttling': Pvalves, 'Transmission & bearing friction': Ptrans + Pbear, 'Control & sensing': Pctrl };
    const XmechSum = Object.values(Xmech).reduce((a, b) => a + b, 0);
    const Qreg = N * f * d.regenEff * sens, dTp = (1 - d.regenEff) * (d.Th - d.Tc), Tbar = 0.5 * (ThK + TcK), Xreg = d.regenEff > 0 ? T0K * Qreg * dTp / (Tbar * Tbar - dTp * dTp / 4) : 0;
    const Xint = N * f * T0K * Math.max(0, Sint), Xth = Xd - XmechSum;
    const XhxRaw = N * f * T0K * (Sfw + Swr + Math.max(0, Smix) - Sstore), kappa = XhxRaw > 0 ? (Xth - Xreg - Xint) / XhxRaw : 0;
    const kap = clamp(kappa, 0, 10);
    const comps = [
      ['Fluid film (h, fluid → wall)', N * f * T0K * Sfw * kap], ['Wall → ribbon contact & conduction', N * f * T0K * (Swr - Sstore) * kap], ['Fluid switching / mixing', N * f * T0K * Math.max(0, Smix) * kap],
      ['Transformation hysteresis & ribbon internal', Xint], ['Regenerator (finite pinch)', Xreg], ...Object.entries(Xmech),
    ];
    const compSum = comps.reduce((a, q) => a + q[1], 0), unalloc = Xd - compSum;
    const exEff = Xin > 0 ? Pnet / Xin : 0;
    // ---- measured imports
    const meas = [];
    for (const ds of ctx.experiments || []) {
      if (!ds.columns) continue;
      const q = findCol(ds, [/q.?_?hot/i, /heat.?in/i, /q_?in/i]), ps = findCol(ds, [/p.?_?shaft/i, /shaft.?power/i]), tq = findCol(ds, [/torque/i, /^tau/i]), sp = findCol(ds, [/rpm/i]), om = findCol(ds, [/omega/i, /rad.?s/i]), pa = findCol(ds, [/p.?_?aux/i, /auxil/i]);
      const Pm = ps ? mean(ps) : tq && (sp || om) ? mean(tq) * (sp ? mean(sp) * 2 * Math.PI / 60 : mean(om)) : null;
      if (q || Pm !== null) meas.push({ name: ds.name, use: ds.use, Qhot: q ? mean(q) : null, Pshaft: Pm, Paux: pa ? mean(pa) : null });
    }
    const M = meas[0];
    // ---- measurement-uncertainty Monte Carlo (spec §34)
    prog(0.4, 'measurement uncertainty'); await pause(ctx);
    const QhotN = M?.Qhot ?? Qhot, PshN = M?.Pshaft ?? Pshaft, PauxN = M?.Paux ?? Paux, dTf = d.fluidDT, cpN = 1, mA = E.mActive;
    const omega = Math.max(1e-6, E.omega), tauN = PshN / omega;
    const dists = [{ type: 'normal', a: 1, b: p.uMdot / 100 }, { type: 'normal', a: 1, b: p.uCp / 100 }, { type: 'normal', a: dTf, b: Math.SQRT2 * p.uT }, { type: 'normal', a: 1, b: p.uTorque / 100 }, { type: 'normal', a: 1, b: p.uSpeed / 100 }, { type: 'normal', a: 1, b: p.uAux / 100 }, { type: 'normal', a: 1, b: p.uMass / 100 }, { type: 'normal', a: 0, b: p.uT }, { type: 'normal', a: 0, b: p.uT }];
    const chain = (z) => { const Qm = QhotN * z[0] * z[1] * cpN * z[2] / dTf, Pm = tauN * z[3] * omega * z[4] - PauxN * z[5], eC = heat.carnot(d.Th + z[7], d.Tc + z[8]); return { Q: Qm, P: Pm, eta: Qm > 0 ? Pm / Qm : 0, p: Pm / (mA * z[6]), cf: Qm > 0 && eC > 0 ? Pm / Qm / eC : 0 }; };
    const uP = propagate(z => chain(z).P, dists, { n: p.nMC, seed: 31 });
    const Ys = uP.X.map(chain), ci = (arr) => [percentile(arr, 0.025), percentile(arr, 0.975)];
    const ciP = ci(Ys.map(y => y.P)), ciEta = ci(Ys.map(y => y.eta)), ciSp = ci(Ys.map(y => y.p)), ciCf = ci(Ys.map(y => y.cf)), ciQ = ci(Ys.map(y => y.Q));
    const pPos = Ys.filter(y => y.P > 0).length / Ys.length;
    // one-at-a-time variance shares of net power and efficiency
    const UN = ['Mass flow ṁ', 'Heat capacity c_p', 'Fluid ΔT (2 sensors)', 'Torque', 'Speed', 'Auxiliary power', 'Active mass', 'T_h sensor', 'T_c sensor'];
    const nom = dists.map(q => q.a), share = (key) => { const v = dists.map((q, j) => { const lo = nom.slice(), hi = nom.slice(); lo[j] -= q.b; hi[j] += q.b; return ((chain(hi)[key] - chain(lo)[key]) / 2) ** 2; }); const s = v.reduce((a, b) => a + b, 0) || 1; return v.map(x => x / s); };
    const shP = share('P'), shE = share('eta');
    // ---- Carnot-fraction map over (T_h, T_c)
    prog(0.55, 'Carnot-fraction map'); await pause(ctx);
    const ThG = linspace(Math.max(d.Tc + 15, mat.Af + 5), Math.max(d.Th + 30, mat.Af + 40), Math.max(3, p.mapN)), TcG = linspace(d.Tc - 10, Math.min(d.Tc + 10, mat.Mf + d.sigmaL / mat.CM - 1), 4);
    const Zcf = [], Zp = [];
    for (const [j, tc] of TcG.entries()) { const rcf = [], rp = []; for (const th of ThG) { const dd = eng.designWith(d, { Th: th, Tc: tc }); if (eng.preScreen(dd, mat).some(v => v.status === 'fail')) { rcf.push(NaN); rp.push(NaN); continue; } const Em = eng.engineModel(dd, { mat, n: 1, stepsPerCycle: 100, cycles: 3 }); rcf.push(100 * Em.carnotFraction); rp.push(Em.Pnet); } Zcf.push(rcf); Zp.push(rp); prog(0.55 + 0.35 * (j + 1) / TcG.length, 'Carnot-fraction map'); await pause(ctx); }
    const mapMax = max(Zcf.flat().filter(Number.isFinite));

    // ---- KPIs
    const st = (ok, warn) => ok ? 'ok' : warn ? 'warn' : 'bad';
    out.kpis.push(
      { label: 'Net power P_net (model)', value: Pnet, unit: 'W', explain: `Shaft power minus every auxiliary (pumps ${fmt(Ppump, 3)} W, valves ${fmt(Pvalves, 3)} W, control ${fmt(Pctrl, 3)} W). ${M ? '' : `95 % interval of the planned measurement chain ${fmt(ciP[0], 3)} … ${fmt(ciP[1], 3)} W.`}`, status: st(Pnet > 0 && ciP[0] > 0, Pnet > 0), prov: 'calc' },
      ...(M ? [{ label: 'Net power P_net (measured)', value: PshN - PauxN, unit: 'W', explain: `From dataset “${M.name}”: shaft power ${fmt(PshN, 4)} W − auxiliaries ${fmt(PauxN, 4)} W; 95 % interval ${fmt(ciP[0], 3)} … ${fmt(ciP[1], 3)} W from the declared sensor uncertainties.`, status: st(ciP[0] > 0, PshN - PauxN > 0), prov: 'measured' }] : []),
      { label: 'Gross cell power P_gross', value: Pgross, unit: 'W', explain: 'N·W_cycle·f: closed-cycle work of all cells including the reset stroke, before transmission losses. Never to be quoted as net output.', prov: 'calc' },
      { label: 'Auxiliary power P_aux', value: Paux, unit: 'W', explain: `Pumps (${pumpSrc}) + valve actuation + control/sensing; ${fmt(100 * Paux / Math.max(1e-9, Pgross), 3)} % of gross power.`, status: st(Paux < 0.3 * Pgross, Paux < Pgross), prov: 'calc' },
      { label: 'Heat input Q_hot', value: Qhot, unit: 'W', explain: `External heat from the hot source after the regenerator credit (ε = ${fmt(d.regenEff, 3)} on the sensible part)${M?.Qhot ? `; measured ${fmt(M.Qhot, 4)} W` : ''}.`, prov: 'calc' },
      { label: 'Thermal efficiency η', value: 100 * eta, unit: '%', explain: `P_net/Q_hot. 95 % interval ${fmt(100 * ciEta[0], 3)} … ${fmt(100 * ciEta[1], 3)} %.`, status: st(eta > 0, false), prov: 'calc' },
      { label: 'Carnot efficiency η_C', value: 100 * etaC, unit: '%', explain: `Upper bound 1 − T_c/T_h with T_h = ${d.Th} °C, T_c = ${d.Tc} °C (absolute temperatures).`, prov: 'calc' },
      { label: 'Fraction of Carnot η/η_C', value: 100 * cf, unit: '%', explain: `Second-law quality of the conversion. The specification explores 50–70 %; Curzon–Ahlborn (maximum-power bound) is ${fmt(100 * etaCA / Math.max(1e-12, etaC), 3)} % of Carnot here.`, status: st(cf >= 0.5, cf >= 0.05), prov: 'calc' },
      { label: 'Exergy efficiency', value: 100 * exEff, unit: '%', explain: 'Net power divided by the exergy supplied (hot heat at T_h, plus cold exergy when the sink is below ambient).', prov: 'calc' },
      { label: 'Exergy destroyed', value: Xd, unit: 'W', explain: `T₀·S_gen = ${fmt(Xd, 4)} W (S_gen = ${fmt(Sgen, 4)} W/K). The largest item is “${comps.slice().sort((a, b) => b[1] - a[1])[0][0]}”.`, prov: 'calc' },
      { label: 'Energy conservation residual', value: residual, unit: '–', explain: 'Independent first-law closure: (Q_hot − P_gross − N f (Q_cold − ε Q_sens))/Q_hot from the cell solver’s own heat rejection.', status: st(Math.abs(residual) < 1e-3, Math.abs(residual) < 1e-2), prov: 'calc' },
      { label: 'Active-mass net specific power', value: E.pActive, unit: 'W/kg', explain: `P_net/m_active = ${fmt(Pnet, 4)} W / ${fmt(1000 * E.mActive, 4)} g; 95 % interval ${fmt(ciSp[0], 3)} … ${fmt(ciSp[1], 3)} W/kg. Cartridge basis ${fmt(E.pCart, 3)} W/kg, system basis ${fmt(E.pSys, 3)} W/kg (never mixed).`, status: st(E.pActive >= 36, E.pActive > 0), prov: 'calc' },
    );
    // ---- verdicts
    out.verdicts.push(
      { test: 'Net power positive after all auxiliaries', status: Pnet > 0 ? (ciP[0] > 0 ? 'pass' : 'warn') : 'fail', detail: `P_net = ${fmt(Pnet, 4)} W (95 % CI ${fmt(ciP[0], 3)} … ${fmt(ciP[1], 3)} W, P(P_net > 0) = ${fmt(100 * pPos, 3)} %).`, fix: Pnet > 0 ? 'Tighten the measurement chain or add margin so the lower bound is positive.' : 'Reduce auxiliaries (pump head, valve energy, control power) or raise gross power (frequency, stress differential).' },
      { test: 'Second law: η ≤ η_Carnot', status: eta <= etaC ? 'pass' : 'fail', detail: `η = ${fmt(100 * eta, 4)} %, η_C = ${fmt(100 * etaC, 4)} %.`, fix: eta <= etaC ? undefined : 'Numerical or accounting artefact (e.g. regenerator credit too large) — never report; refine the model.' },
      { test: 'Entropy generation non-negative', status: Sgen >= 0 ? 'pass' : 'fail', detail: `S_gen = ${fmt(Sgen, 4)} W/K.`, fix: Sgen >= 0 ? undefined : 'Accounting inconsistency: check reservoir temperatures and the regenerator credit.' },
      { test: 'Energy balance closes', status: Math.abs(residual) < 1e-3 ? 'pass' : Math.abs(residual) < 1e-2 ? 'warn' : 'fail', detail: `Residual ${fmt(residual, 3)} of Q_hot.`, fix: 'Increase steps per cycle or cycles to reach the periodic state.' },
      { test: 'Regeneration improves net efficiency (risk §40)', status: d.regenEff > 0 ? 'info' : 'info', detail: `Regenerator recovers ${fmt(Qreg, 4)} W (${fmt(100 * Qreg / Math.max(1e-9, Qhot + Qreg), 3)} % of the cell heat demand) at a screening destruction of ${fmt(Xreg, 3)} W; its pressure-drop pumping is part of P_pump.`, fix: 'Confirm with a matched configuration test (with/without regenerator, all fluid losses) — validation gate V4.' },
      { test: 'Fraction of Carnot within the explored 50–70 % band', status: cf >= 0.5 ? 'pass' : 'info', detail: `${fmt(100 * cf, 3)} % of Carnot. Sensible heating of wall and ribbon dominates the heat demand.`, fix: 'Reduce the wall heat capacity, raise regenerator effectiveness and lower the temperature lift needed by the alloy (low-hysteresis alloys).' },
      { test: 'Measured enthalpy flows and shaft power', status: M ? 'pass' : 'info', detail: M ? `Dataset “${M.name}”: Q_hot ${M.Qhot !== null ? fmt(M.Qhot, 4) + ' W' : '—'}, P_shaft ${M.Pshaft !== null ? fmt(M.Pshaft, 4) + ' W' : '—'}, P_aux ${M.Paux !== null ? fmt(M.Paux, 4) + ' W' : '—'}.` : 'No measured heat-flow or shaft-power columns imported; all values are simulated and the uncertainty intervals describe the planned measurement chain.', fix: M ? undefined : 'Import a CSV with Q_hot [W], P_shaft [W] (or torque + rpm) and P_aux [W] from calibrated instruments (spec §34).' },
    );
    // ---- checks
    const cellResid = Math.abs(c.energyResidual);
    out.checks.push(
      { name: 'Exergy balance X_in = P_net + X_d + X_rej', value: exBal, target: '< 1e-9', pass: exBal < 1e-9 },
      { name: 'Cell entropy identity (allocated terms = reservoir S_gen)', value: idCell, target: '< 2 %', pass: idCell < 0.02, detail: `Σ = ${fmt(cellSum, 4)} vs ${fmt(Sres, 4)} J/K per cycle; wall storage term ${fmt(Sstore, 3)} J/K.` },
      { name: 'Engine first-law residual', value: residual, target: '|r| < 1e-3', pass: Math.abs(residual) < 1e-3 },
      { name: 'Cell first-law residual', value: cellResid, target: '< 1e-3', pass: cellResid < 1e-3 },
      { name: 'η ≤ η_C', value: eta / Math.max(1e-12, etaC), target: '≤ 1', pass: eta <= etaC },
      { name: 'S_gen ≥ 0 and all component destructions ≥ 0', value: min(comps.map(q => q[1])), target: '≥ 0', pass: Sgen >= 0 && comps.every(q => q[1] >= -1e-9) },
      { name: 'Allocation factor for heat-exchange destruction κ', value: kappa, target: '0 < κ ≤ 1.2', pass: kappa > 0 && kappa <= 1.2, detail: 'Share of the cell-level heat-exchange entropy that remains after regeneration and hysteresis are booked; κ < 1 reflects the regenerator reducing the external heat that crosses finite temperature differences.' },
      { name: 'Hysteresis: cell internal vs Clausius–Clapeyron estimate', value: Xint / Math.max(1e-12, XhystCC), target: 'order 1 (0.2–5)', pass: Xint / Math.max(1e-12, XhystCC) > 0.2 && Xint / Math.max(1e-12, XhystCC) < 5, detail: `${fmt(Xint, 3)} W from the cycle integral vs ${fmt(XhystCC, 3)} W from L_h·ΔT_hys/T_eq.` },
      { name: 'Carnot-fraction map ≤ 100 %', value: mapMax, target: '≤ 100', pass: !(mapMax > 100) },
      { name: 'Monte-Carlo convergence (CI half-width / σ)', value: (ciP[1] - ciP[0]) / 2 / Math.max(1e-12, uP.std), target: '≈ 1.96', pass: Math.abs((ciP[1] - ciP[0]) / 2 / Math.max(1e-12, uP.std) - 1.96) < 0.25 },
    );
    // ---- charts
    out.charts.push({ type: 'bar', title: 'First-law power balance', categories: ['Q_hot', 'P_gross', 'Transmission loss', 'Bearing', 'Pumps', 'Valves', 'Control', 'P_net', 'Q_rej (total)'], series: [{ name: 'Power [W]', values: [Qhot, Pgross, Ptrans, Pbear, Ppump, Pvalves, Pctrl, Pnet, QrejAll] }], explain: 'Where the energy goes: heat in, gross cell work, each loss and auxiliary, the remaining net power and the heat rejected (all losses end as rejected heat). Gross cell work is shown separately and is never the net output.' });
    out.charts.push({ type: 'bar', title: 'Net-power waterfall (gross → net)', horizontal: true, categories: ['Gross cell work', '− transmission', '− bearing', '= shaft power', '− pumps', '− valves', '− control', '= NET'], series: [{ name: 'W', values: [Pgross, -Ptrans, -Pbear, Pshaft, -Ppump, -Pvalves, -Pctrl, Pnet] }], explain: 'Step-by-step deduction from gross cell work to net exported power at the shaft measurement station.' });
    out.charts.push({ type: 'bar', title: 'Grassmann exergy balance', horizontal: true, wide: true, categories: ['Exergy in: hot heat', 'Exergy in: cold sink', 'Net power out', ...comps.map(q => 'Destroyed: ' + q[0]), 'Destroyed: unallocated', 'Lost with rejected heat'], series: [{ name: 'Exergy [W]', values: [XhotIn, Math.max(0, XcoldTerm), Pnet, ...comps.map(q => q[1]), unalloc, Xrej] }], explain: `Exergy supplied (top two bars) equals net power plus destruction plus exergy lost with rejected heat. Gouy–Stodola destruction is allocated to each component; the heat-transfer items are scaled by κ = ${fmt(kappa, 3)} so that the books close.` });
    out.charts.push({ type: 'bar', title: 'Entropy generation by component', categories: comps.map(q => q[0]), series: [{ name: 'S_gen [mW/K]', values: comps.map(q => 1000 * q[1] / T0K) }], explain: 'Entropy generation rate of each irreversibility (X_d/T₀). Reducing the tallest bars raises the fraction of Carnot most.' });
    out.charts.push({ type: 'bar', title: 'Efficiency ladder', categories: ['η (net)', 'Exergy efficiency', 'Curzon–Ahlborn', 'Carnot'], series: [{ name: '%', values: [100 * eta, 100 * exEff, 100 * etaCA, 100 * etaC] }], explain: 'Actual net thermal efficiency against the endoreversible maximum-power bound and the Carnot bound for the same reservoirs.' });
    out.charts.push({ type: 'heatmap', title: 'Fraction of Carnot over source and sink temperature', x: { label: 'Hot reservoir T_h', unit: '°C', values: ThG }, y: { label: 'Cold reservoir T_c', unit: '°C', values: TcG }, z: Zcf, cmap: 'viridis', isolines: 4, z_label: '% of η_C', overlay: [{ pts: [[d.Th, d.Tc], [d.Th, d.Tc]], stroke: '#fff', width: 6 }], explain: 'Net efficiency as a percentage of Carnot from low-resolution engine runs at each reservoir pair (other design values fixed); blank cells fail the physical pre-screen (transformation cannot complete). Negative values mean auxiliaries exceed shaft power. The white dot is the operating point.' });
    out.charts.push({ type: 'heatmap', title: 'Net power over source and sink temperature', x: { label: 'Hot reservoir T_h', unit: '°C', values: ThG }, y: { label: 'Cold reservoir T_c', unit: '°C', values: TcG }, z: Zp, cmap: 'turbo', isolines: 4, z_label: 'W', explain: 'Net power of the same engine at each reservoir pair. A hotter source raises the recovery stress margin and the work per cycle; the gain is offset by more heat cycled per watt.' });
    const tt = H.t.map(t => 1000 * t), cumQ = cumtrapz(H.qIn.map(q => Math.max(0, q)), H.t), cumR = cumtrapz(H.qIn.map(q => Math.max(0, -q)), H.t), cumW = cumtrapz(H.Pmech, H.t);
    out.charts.push({ type: 'line', title: 'Cumulative heat and work over one cell cycle', x: { label: 'Time in cycle', unit: 'ms' }, y: { label: 'Energy per cell', unit: 'J' }, series: [{ name: 'Heat in (cumulative)', x: tt, y: cumQ }, { name: 'Heat out (cumulative)', x: tt, y: cumR }, { name: 'Work to load ×100', x: tt, y: cumW.map(w => 100 * w) }], explain: 'Running totals of heat taken in, heat rejected and work delivered (×100) in one cell cycle. The near-equality of heat in and out shows how little of the cycled heat becomes work — the sensible heating of wall and ribbon dominates.' });
    const hP = histogram(Ys.map(y => y.P), 24), hE = histogram(Ys.map(y => 100 * y.eta), 24);
    out.charts.push({ type: 'bar', title: 'Net power: measurement-uncertainty distribution', categories: hP.centers.map(v => fmt(v, 3)), series: [{ name: 'Samples', values: hP.counts }], explain: `Monte-Carlo distribution of the net power that the specified measurement chain would report (${p.nMC} samples). 95 % CI ${fmt(ciP[0], 3)} … ${fmt(ciP[1], 3)} W.` });
    out.charts.push({ type: 'bar', title: 'Efficiency: measurement-uncertainty distribution', categories: hE.centers.map(v => fmt(v, 3)), series: [{ name: 'Samples', values: hE.counts }], explain: `Distribution of η = P_net/Q_hot (%). 95 % CI ${fmt(100 * ciEta[0], 3)} … ${fmt(100 * ciEta[1], 3)} %. Small temperature differences across the heat-flow meter make ΔT the critical sensor.` });
    out.charts.push({ type: 'bar', title: 'Uncertainty budget (variance shares)', horizontal: true, categories: UN, series: [{ name: 'P_net', values: shP.map(v => 100 * v) }, { name: 'η', values: shE.map(v => 100 * v) }], explain: 'Share (%) of the variance of net power and efficiency contributed by each sensor (first-order). The largest bar is the instrument to upgrade first.' });
    // ---- tables
    out.tables.push({ title: 'Itemised power accounting', cols: ['Item', 'Power [W]', 'Share of Q_hot [%]', 'Source'], rows: [
      ['Heat input Q_hot', Qhot, 100, M?.Qhot ? 'measured' : 'engine model'], ['Regenerator recovered heat', Qreg, 100 * Qreg / Math.max(1e-9, Qhot), 'engine model'],
      ['Gross cell work P_gross', Pgross, 100 * Pgross / Qhot, 'cell transient'], ['Transmission loss', Ptrans, 100 * Ptrans / Qhot, `η_tr = ${d.transEff}`], ['Bearing loss', Pbear, 100 * Pbear / Qhot, 'design'],
      ['Shaft power', Pshaft, 100 * Pshaft / Qhot, M?.Pshaft ? 'measured' : 'calc'], ['Pumps (hot + cold)', Ppump, 100 * Ppump / Qhot, pumpSrc], ['Valve actuation', Pvalves, 100 * Pvalves / Qhot, '2·N·f·E_valve'], ['Control & sensing', Pctrl, 100 * Pctrl / Qhot, 'design'],
      ['NET POWER', Pnet, 100 * Pnet / Qhot, 'P_shaft − P_aux'], ['Heat rejected (incl. dissipation)', QrejAll, 100 * QrejAll / Qhot, 'Q_hot − P_net'],
    ], explain: 'Every term of the net-power definition with its provenance. Shares relative to the external heat input.' });
    out.tables.push({ title: 'Exergy destruction by component (Gouy–Stodola)', cols: ['Component', 'X_d [W]', 'S_gen [mW/K]', 'Share of X_d [%]', 'Basis'], rows: comps.map(q => [q[0], q[1], 1000 * q[1] / T0K, 100 * q[1] / Math.max(1e-12, Xd), /film|contact|switching/.test(q[0]) ? `cycle integral × N f T₀ × κ (${fmt(kappa, 3)})` : /hysteresis/.test(q[0]) ? 'cycle integral −∮q_r/T_r' : /Regenerator/.test(q[0]) ? 'pinch screening' : 'dissipated work']).concat([['Unallocated (closure)', unalloc, 1000 * unalloc / T0K, 100 * unalloc / Math.max(1e-12, Xd), 'X_d − Σ'], ['TOTAL', Xd, 1000 * Sgen, 100, 'T₀·(Q_rej/T_c − Q_hot/T_h)']]), explain: `Dead state T₀ = ${d.T0} °C. The Clausius–Clapeyron hysteresis estimate is ${fmt(XhystCC, 3)} W for comparison with the internal term.` });
    out.tables.push({ title: 'Measurement uncertainty (95 % confidence intervals)', cols: ['Quantity', 'Nominal', 'Lower', 'Upper', 'Relative half-width [%]'], rows: [
      ['Q_hot [W]', QhotN, ciQ[0], ciQ[1], 50 * (ciQ[1] - ciQ[0]) / Math.max(1e-12, Math.abs(QhotN))],
      ['P_net [W]', PshN - PauxN, ciP[0], ciP[1], 50 * (ciP[1] - ciP[0]) / Math.max(1e-12, Math.abs(PshN - PauxN))],
      ['η [%]', 100 * (PshN - PauxN) / QhotN, 100 * ciEta[0], 100 * ciEta[1], 50 * (ciEta[1] - ciEta[0]) / Math.max(1e-12, Math.abs((PshN - PauxN) / QhotN))],
      ['η/η_C [%]', 100 * (PshN - PauxN) / QhotN / etaC, 100 * ciCf[0], 100 * ciCf[1], ''],
      ['p_active [W/kg]', (PshN - PauxN) / mA, ciSp[0], ciSp[1], 50 * (ciSp[1] - ciSp[0]) / Math.max(1e-12, Math.abs((PshN - PauxN) / mA))],
    ], explain: `Sensor 1σ: T ±${p.uT} K, ṁ ±${p.uMdot} %, c_p ±${p.uCp} %, torque ±${p.uTorque} %, speed ±${p.uSpeed} %, P_aux ±${p.uAux} %, mass ±${p.uMass} %. Heat-meter ΔT = ${dTf} K. ${M ? 'Nominal values from the imported measurement.' : 'Nominal values are simulated (planned measurement chain).'}` });
    const ratio = E.pActive / eng.REFERENCE_W_PER_KG, ratioCI = ciSp.map(v => v / eng.REFERENCE_W_PER_KG);
    const claimOK = M && p.testHours > 0 && ratioCI[0] >= 100;
    out.tables.push({ title: '“100×” claim declaration (spec §34)', cols: ['Item', 'Declared value'], rows: [
      ['Claim', `Active-mass net specific power = ${fmt(ratio, 3)}× the 36 W/kg reference (95 % CI ${fmt(ratioCI[0], 3)} … ${fmt(ratioCI[1], 3)}×)`],
      ['Numerator', `P_net = ${fmt(Pnet, 4)} W at the shaft station after the transmission, minus pumps, valves and control (all auxiliaries)`],
      ['Denominator', `Active SMA mass ${fmt(1000 * E.mActive, 4)} g = ${N} cells × ${d.ribbonsPerCell} ribbons × ${d.ribbonL * 1000} × ${d.ribbonW * 1000} × ${d.ribbonT * 1e6} µm × ${mat.rho} kg/m³ (transforming length only)`],
      ['Other mass bases (not mixed)', `cartridge ${fmt(E.pCart, 4)} W/kg (${fmt(E.mCart, 3)} kg), complete system ${fmt(E.pSys, 4)} W/kg (${fmt(E.mSys, 3)} kg)`],
      ['Reference', `${eng.REFERENCE_W_PER_KG} W/kg published electrical output per active SMA mass — different definition (electrical vs shaft), conditions must be matched before a ratio is claimed`],
      ['Operating temperatures', `T_h = ${d.Th} °C, T_c = ${d.Tc} °C, T₀ = ${d.T0} °C (η_C = ${fmt(100 * etaC, 3)} %)`],
      ['Efficiency at the claimed point', `η = ${fmt(100 * eta, 3)} % (${fmt(100 * cf, 3)} % of Carnot)`],
      ['Duration', p.testHours > 0 ? `${p.testHours} h continuous` : 'none — simulation only'],
      ['Evidence class', M ? `measured (dataset “${M.name}”)` : 'simulated (no measurement)'],
      ['Uncertainty', `95 % CI from the declared sensor uncertainties (Monte Carlo, ${p.nMC} samples)`],
      ['Verdict', claimOK ? 'Claim supported by measurement within the stated uncertainty' : ratio >= 100 ? 'Model reaches 100× but cannot be claimed without measured, repeatable, uncertainty-bounded evidence' : `Not a 100× case: ${fmt(ratio, 3)}× (simulation)`],
    ], explain: 'Any statement of relative improvement must carry all of these declarations. Without measured net output, duration and uncertainty the ratio is a model forecast, not a claim.' });
    if (meas.length) out.tables.push({ title: 'Measured vs model reconciliation', cols: ['Dataset', 'Use', 'Q_hot meas. [W]', 'Q_hot model [W]', 'P_shaft meas. [W]', 'P_shaft model [W]', 'P_aux meas. [W]', 'P_net meas. [W]', 'η meas. [%]'], rows: meas.map(m => [m.name, m.use, m.Qhot ?? '—', Qhot, m.Pshaft ?? '—', Pshaft, m.Paux ?? '—', m.Pshaft !== null ? m.Pshaft - (m.Paux ?? Paux) : '—', m.Pshaft !== null && m.Qhot ? 100 * (m.Pshaft - (m.Paux ?? Paux)) / m.Qhot : '—']), explain: 'Cycle-averaged measured values against the model. Discrepancies beyond the combined uncertainty point to model-form error (calibrate in Suite 19).' });
    // ---- narrative
    out.explain.push(
      { title: 'Energy books', text: `${N} cells cycling at ${fmt(f, 3)} Hz take ${fmt(Qhot, 4)} W from the source (after recovering ${fmt(Qreg, 4)} W in the regenerator) and produce ${fmt(Pgross, 4)} W of gross cell work. After ${fmt(Ptrans + Pbear, 3)} W of transmission/bearing loss and ${fmt(Paux, 4)} W of auxiliaries, ${fmt(Pnet, 4)} W net remains: η = ${fmt(100 * eta, 3)} %, ${fmt(100 * cf, 3)} % of Carnot.` },
      { title: 'Where the exergy goes', text: `Of ${fmt(Xin, 4)} W of exergy supplied, ${fmt(Pnet, 4)} W leaves as net work and ${fmt(Xd, 4)} W is destroyed. Heat transfer across finite temperature differences (fluid film, wall contact, switching) dominates because the wall and ribbon are heated and cooled through the full source–sink span every cycle.` },
      { title: 'Measurement', text: `With the declared instruments the 95 % interval of net power is ${fmt(ciP[0], 3)} … ${fmt(ciP[1], 3)} W; the dominant contributor to efficiency uncertainty is ${UN[shE.indexOf(max(shE))]}.` },
    );
    // ---- recommendations
    const topX = comps.slice().sort((a, b) => b[1] - a[1])[0];
    out.recs.push({ level: Pnet > 0 ? 'info' : 'critical', text: `Largest exergy destruction: ${topX[0]} (${fmt(topX[1], 4)} W, ${fmt(100 * topX[1] / Math.max(1e-12, Xd), 3)} % of the total). ${/film|contact|switching/.test(topX[0]) ? `Lower the cycled thermal mass (wall capacity ${d.wallCapacity} J/m²K, ribbon thickness ${fmt(d.ribbonT * 1e6, 3)} µm) and raise regenerator effectiveness — these reduce the heat that crosses the large ΔT every cycle.` : 'Target this component first in Suites 09–13.'}`, basis: 'Gouy–Stodola allocation' });
    if (Paux > 0.3 * Pgross) out.recs.push({ level: 'warn', text: `Auxiliaries consume ${fmt(100 * Paux / Pgross, 3)} % of gross power; control/sensing alone is ${fmt(Pctrl, 3)} W. Low-power control and passive (cam/thermostatic) valve actuation would raise net output directly.`, basis: 'Itemised accounting' });
    out.recs.push({ level: 'info', text: `Upgrade the ${UN[shE.indexOf(max(shE))].toLowerCase()} measurement first: it carries ${fmt(100 * max(shE), 3)} % of the efficiency variance. With a ${dTf} K heat-meter ΔT, each 0.1 K of temperature uncertainty is ${fmt(100 * 0.1 * Math.SQRT2 / dTf, 3)} % of Q_hot.`, basis: 'Uncertainty budget (spec §34)' });
    out.recs.push({ level: 'econ', text: `Heat cost per unit of net work: ${fmt(Qhot / Math.max(1e-9, Pnet), 4)} W of heat per W of net power. Unless the heat is free waste heat, the fuel/heat cost dominates operating cost (Suite 22).`, basis: 'η = P_net/Q_hot' });
    out.recs.push({ level: 'sustain', text: `${fmt(QrejAll, 4)} W is rejected to the sink at ${d.Tc} °C. Pair the engine with genuine waste heat and a sink that is not actively chilled; an actively cooled sink would cost more exergy than the engine produces at ${fmt(100 * eta, 3)} % efficiency.`, basis: 'Exergy balance' });
    if (!M) out.recs.push({ level: 'warn', text: 'No measured enthalpy flows or shaft power are imported. Install calibrated heat-flow meters on hot and cold loops, a torque/speed dynamometer at the shaft station and power meters on every auxiliary; import the logs here.', basis: 'Master spec §34 and Module 18 evidence' });
    // ---- view
    out.views.push({ label: '2D animation: energy flows through the cycle', icon: '🎞', render: (el) => anim2d(el, { duration: H.t[H.t.length - 1], rate: Math.min(1, 0.5 * f), label: 'cycle time', unit: 's', height: 400, explain: 'Interface heat flow and mechanical power of one cell over its cycle with running energy totals; the bars on the right show the engine-level energy and exergy books.', draw(g, t, W, Hh) {
      const pw = W * 0.62, ph = (Hh - 20) / 2;
      seriesPanel(g, { x: 8, y: 6, w: pw, h: ph - 6, T: H.t, t, title: 'Heat flow into the cell', unit: 'W', series: [{ name: 'q', y: H.qIn, color: '#ef4444' }] });
      seriesPanel(g, { x: 8, y: 6 + ph, w: pw, h: ph - 6, T: H.t, t, title: 'Running totals per cell', unit: 'J', series: [{ name: 'heat in', y: cumQ, color: '#f97316' }, { name: 'heat out', y: cumR, color: '#38bdf8' }, { name: 'work ×100', y: cumW.map(w => 100 * w), color: '#22c55e' }] });
      const bx = pw + 24, bw = W - bx - 10, top = Qhot || 1; let y = 16;
      text(g, 'Engine books [W]', bx, y); y += 10;
      for (const [lab, v, col] of [['Q_hot', Qhot, '#f97316'], ['P_gross', Pgross, '#a855f7'], ['P_aux', Paux, '#eab308'], ['P_net', Pnet, '#22c55e'], ['X_in', Xin, '#38bdf8'], ['X_destroyed', Xd, '#ef4444']]) { barG(g, { x: bx, y, w: bw, h: 16, value: v, max: top, label: lab, color: col }); y += 24; }
    } }) });
    out.outputs = { Pnet_W: Pnet, Pgross_W: Pgross, Paux_W: Paux, Qhot_W: Qhot, eta, etaC, carnotFraction: cf, exergyDestroyed_W: Xd, residual, Pshaft_W: Pshaft, Qrej_W: QrejAll, etaCA, exergyEff: exEff, Sgen_WK: Sgen, pActive_Wkg: E.pActive, PnetCI95: ciP, etaCI95: ciEta, pActiveCI95: ciSp, destruction: Object.fromEntries(comps) };
    out.headline = `P_net ${fmt(Pnet, 4)} W ${M ? `model / ${fmt(PshN - PauxN, 4)} W measured` : ''} (95 % CI ${fmt(ciP[0], 3)}…${fmt(ciP[1], 3)}) from ${fmt(Qhot, 4)} W heat — η ${fmt(100 * eta, 3)} % = ${fmt(100 * cf, 3)} % of Carnot; ${fmt(Xd, 4)} W exergy destroyed`;
    out.headlineKind = Pnet > 0 && eta <= etaC ? (ciP[0] > 0 ? 'ok' : 'warn') : 'fail';
    out.credibility = M ? 'Calibrated' : 'Analytical screening';
    prog(1, 'done');
    return out;
  },
};
