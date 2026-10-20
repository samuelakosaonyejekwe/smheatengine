// Suite 16 — Structural integrity, creep, fatigue and failure of the SMA ribbons.
// Integrates the ACTUAL coupled stress/strain history (Suite 14, else Suite 05, else an internal cell solve) rather than
// nominal peak loading (master spec §26):
//   functional fatigue  N_f = N0·(ε0/ε_tr)^a·(σ0/σ)^b (library trend, sma.fatigueLife) at the free length and at the grips
//   structural fatigue  ASTM E1049 rainflow of the grip stress history, Basquin with Goodman/Gerber/SWT mean-stress
//                       correction, Coffin–Manson–Morrow strain-life with Neuber's notch rule, Palmgren–Miner damage
//   ratcheting          ε_res(N) = ε_sat(1 − e^(−N/N_s)) + ε̇_r·N against an allowable residual set
//   fracture mechanics  Paris da/dN = C(ΔK_eff)^m, ΔK = YΔσ√(πa), Walker R-correction, threshold and K_Ic
//   survival            two-parameter Weibull per ribbon; series and k-out-of-n redundancy across the cartridge
import { fmt, linspace, logspace, range, clamp, min, max } from '../core/num.js';
import { anim2d, seriesPanel, text, at, lerp } from '../core/anim2d.js';

const LOG10 = Math.log10;
// ASTM E1049-85 rainflow counting (three-point method) on a sequence of turning points. Returns [{range, mean, count}].
export function rainflow(series) {
  const rev = [];
  for (const v of series) {
    if (!Number.isFinite(v)) continue;
    if (!rev.length || v !== rev[rev.length - 1]) {
      if (rev.length >= 2 && (v - rev[rev.length - 1]) * (rev[rev.length - 1] - rev[rev.length - 2]) > 0) rev[rev.length - 1] = v; else rev.push(v);
    }
  }
  const st = [], cyc = [];
  for (const pt of rev) {
    st.push(pt);
    while (st.length >= 3) {
      const n = st.length, X = Math.abs(st[n - 1] - st[n - 2]), Y = Math.abs(st[n - 2] - st[n - 3]);
      if (X < Y) break;
      if (n === 3) { cyc.push({ range: Y, mean: (st[0] + st[1]) / 2, count: 0.5 }); st.shift(); }
      else { cyc.push({ range: Y, mean: (st[n - 2] + st[n - 3]) / 2, count: 1 }); st.splice(n - 3, 2); }
    }
  }
  for (let i = 0; i < st.length - 1; i++) cyc.push({ range: Math.abs(st[i + 1] - st[i]), mean: (st[i + 1] + st[i]) / 2, count: 0.5 });
  return cyc.filter(c => c.range > 0);
}
// periodic history: start at the absolute maximum and close the loop so that every cycle is a full cycle
const rainflowPeriodic = (s) => { const k = s.reduce((bi, v, i) => v > s[bi] ? i : bi, 0); const r = s.slice(k).concat(s.slice(0, k + 1)); return rainflow(r); };

export default {
  description: 'Fatigue and integrity of the SMA ribbons from the actual coupled stress–strain history: functional fatigue, rainflow-counted structural fatigue at the grips with mean-stress correction and Miner damage, residual-strain ratcheting, Paris-law crack growth from an initial flaw, creep screening, corrosion allowance and Weibull survival of the whole ribbon population — giving life distributions, damage maps and an inspection interval.',
  literature: 'NiTi shape memory alloy functional fatigue structural fatigue crack growth actuator ribbon life',
  credibility: 'Analytical screening',
  equations: [
    'Functional fatigue (library trend): N_f = N₀·(ε₀/ε_tr)^a·(σ₀/σ_max)^b',
    'Fatigue notch factor: K_f = 1 + q(K_t − 1); local stress σ_loc(x) = K_f(x)·σ_nom, K_t(x) = 1 + (K_t,grip − 1)·e^(−d/ℓ)·k_edge',
    'Rainflow (ASTM E1049-85): ranges Δσ_i, means σ_m,i, counts n_i per engine cycle',
    'Goodman σ_ar = σ_a/(1 − σ_m/σ_u); Gerber σ_ar = σ_a/(1 − (σ_m/σ_u)²); SWT σ_ar = √(σ_max σ_a)',
    'Basquin σ_ar = σ′_f (2N)^b;  Coffin–Manson–Morrow ε_a = (σ′_f − σ_m)/E·(2N)^b + ε′_f(2N)^c',
    'Neuber: σ_loc·ε_loc = (K_t S)²/E with cyclic Ramberg–Osgood ε = σ/E + (σ/K′)^(1/n′)',
    'Palmgren–Miner D = Σ n_i/N_i per cycle; life N = 1/D',
    'Ratcheting ε_res(N) = ε_sat(1 − e^(−N/N_s)) + ε̇_r·N; life when ε_res = ε_allow',
    'Paris da/dN = C·(ΔK_eff)^m, ΔK = YΔσ√(πa), ΔK_eff = ΔK/(1 − R)^(1−γ) (Walker); a_c = (1/π)(K_Ic/(Yσ_max))², capped at 0.8 t',
    'Weibull R(N) = exp(−(N/η)^β); P_q life = η(−ln(1 − q))^(1/β); series R_sys = R^n; k-out-of-n R_cell = Σ_{j≤m} C(n,j)F^jR^(n−j)',
    'Creep screen: homologous temperature T/T_m (creep negligible below ≈ 0.3–0.4)',
  ],
  methods: [
    'Stress/strain history taken from Suite 14 (coupled, converged) or Suite 05; otherwise a cell transient is solved here',
    'Periodic rainflow: the history is rotated to start at its maximum and closed, so every counted cycle is full',
    'Damage along the ribbon length and across its width evaluated on a 2-D grid (grip decay length ℓ, slit-edge factor)',
    'Crack growth integrated in log a with 400 steps; threshold and critical sizes reported even when no growth occurs',
    'Weibull scale set so that the deterministic model life is the median; system lives found by bisection in log N',
    'Rainflow verified against the ASTM E1049 example sequence',
  ],
  assumptions: [
    'Functional-fatigue constants are literature trends (order of magnitude) — not lot data; S–N and ε–N tests of the actual ribbon are required (spec §31, §40)',
    'Elastic stress concentration at the grips decays exponentially with distance (decay length ≈ ribbon width/4 by default)',
    'Structural fatigue parameters (σ′_f, b, ε′_f, c, K′, n′) are generic NiTi estimates; Basquin/Coffin–Manson are applied to the mechanical stress cycle only — transformation strain damage is in the functional law',
    'Crack growth uses long-crack Paris constants; small-crack anomalies near inclusions are not modelled',
    'Ribbons are statistically independent and identical (no common-cause failures); cells are in series for the engine',
    'Uniform corrosion of both faces; no pitting or hydrogen embrittlement',
  ],
  ibc: {
    initial: ['Virgin trained ribbon, zero damage, residual set zero, initial flaw a₀ at the grip edge', 'Cyclic steady stress–strain history of the converged cell'],
    boundary: ['Grip clamping with stress concentration K_t; bias and load stresses from Suite 14', 'Fluid environment (corrosion rate), hot-fluid temperature for creep and ageing'],
  },
  cvv: {
    calibration: ['Ribbon S–N and ε–N curves at the operating temperatures and stresses (functional and structural)', 'Residual strain vs cycles from extended thermal cycling', 'Fatigue-crack-growth tests (C, m, ΔK_th) on the ribbon gauge'],
    verification: ['Rainflow of the ASTM E1049 example', 'Miner sum of a constant-amplitude history equals 1/N', 'Weibull quantiles reproduce the median life', 'Paris integration vs closed form for constant Y'],
    validation: ['Full-cartridge endurance test to 10⁶–10⁸ cycles with periodic stroke, force and residual-set inspection (gate V5)'],
  },
  formats: { import: ['CSV stress–strain or force–displacement histories', 'CSV S–N / ε–N test data (cycles, amplitude)'], export: ['Rainflow matrix CSV', 'Life distribution CSV', 'Damage map PNG/SVG'] },
  params: [
    { key: 'source', label: 'Load history source', type: 'select', options: [{ value: 'auto', label: 'Automatic (Suite 14 → Suite 05 → internal solve)' }, { value: 'internal', label: 'Internal cell solve' }], default: 'auto', group: 'Load history' },
    { key: 'sigmaL', label: 'Bias stress σ_L', unit: 'MPa', type: 'number', min: 0, max: 400, step: 1, default: 70, group: 'Load history', auto: (c) => ({ value: c.engine.sigmaL, prov: 'calc' }) },
    { key: 'sigmaH', label: 'Effective power-stroke stress σ_H', unit: 'MPa', type: 'number', min: 1, max: 600, step: 1, default: 110, group: 'Load history', auto: (c) => { const o = c.upstream('s14'); return o?.sigmaHeff_MPa ? { value: +o.sigmaHeff_MPa.toFixed(2), prov: 'coupled' } : { value: c.engine.sigmaH, prov: 'calc' }; } },
    { key: 'freq', label: 'Cycle frequency', unit: 'Hz', type: 'number', min: 0.01, max: 20, step: 0.01, default: 1, group: 'Load history', auto: (c) => { const o = c.upstream('s14') || c.upstream('s05'); return o?.freq_Hz ? { value: +o.freq_Hz.toFixed(4), prov: 'coupled' } : { value: c.engine.freq, prov: 'calc' }; } },
    { key: 'Th', label: 'Hot fluid temperature (creep, ageing)', unit: '°C', type: 'number', min: 0, max: 400, step: 1, default: 70, group: 'Load history', auto: (c) => ({ value: c.engine.Th, prov: 'calc' }) },
    { key: 'Kt', label: 'Grip stress-concentration factor K_t', type: 'number', min: 1, max: 5, step: 0.05, default: 1.8, group: 'Geometry & grips', help: 'Clamped ribbon end with fillet/serrated jaw: 1.5–2.5. Bonded or pinned with optimised transition: 1.2–1.5.' },
    { key: 'qNotch', label: 'Notch sensitivity q', type: 'number', min: 0, max: 1, step: 0.05, default: 0.85, group: 'Geometry & grips' },
    { key: 'gripDecay', label: 'Stress-concentration decay length ℓ', unit: 'mm', type: 'number', min: 0.05, max: 20, step: 0.05, default: 1.25, group: 'Geometry & grips', auto: (c) => ({ value: +(c.engine.ribbonW * 1000 / 4).toFixed(3), prov: 'calc' }) },
    { key: 'edgeKt', label: 'Slit-edge factor (laser/EDM edge)', type: 'number', min: 1, max: 2, step: 0.01, default: 1.1, group: 'Geometry & grips' },
    { key: 'meanStress', label: 'Mean-stress correction', type: 'select', options: [{ value: 'goodman', label: 'Goodman' }, { value: 'gerber', label: 'Gerber' }, { value: 'swt', label: 'Smith–Watson–Topper' }], default: 'goodman', group: 'Structural fatigue' },
    { key: 'sfPrime', label: 'Fatigue strength coefficient σ′_f', unit: 'MPa', type: 'number', min: 100, max: 3000, step: 10, default: 1050, group: 'Structural fatigue', expert: true, auto: (c) => { const m = c.materials.get(c.engine.alloy); return m?.su ? { value: m.su, prov: 'library' } : undefined; } },
    { key: 'bExp', label: 'Basquin exponent b', type: 'number', min: -0.3, max: -0.03, step: 0.005, default: -0.09, group: 'Structural fatigue', expert: true },
    { key: 'efPrime', label: 'Fatigue ductility coefficient ε′_f', type: 'number', min: 0.01, max: 1, step: 0.01, default: 0.12, group: 'Structural fatigue', expert: true },
    { key: 'cExp', label: 'Coffin–Manson exponent c', type: 'number', min: -1, max: -0.3, step: 0.01, default: -0.55, group: 'Structural fatigue', expert: true },
    { key: 'Kc', label: 'Cyclic strength coefficient K′', unit: 'MPa', type: 'number', min: 200, max: 4000, step: 10, default: 1400, group: 'Structural fatigue', expert: true },
    { key: 'nc', label: 'Cyclic hardening exponent n′', type: 'number', min: 0.03, max: 0.4, step: 0.01, default: 0.12, group: 'Structural fatigue', expert: true },
    { key: 'a0', label: 'Initial flaw depth a₀ (grip edge)', unit: 'µm', type: 'number', min: 0.5, max: 200, step: 0.5, default: 15, group: 'Fracture mechanics', help: 'Typical NiTi inclusion / slit-edge defect 5–30 µm.' },
    { key: 'aDet', label: 'Detectable flaw depth', unit: 'µm', type: 'number', min: 1, max: 500, step: 1, default: 40, group: 'Fracture mechanics' },
    { key: 'parisC', label: 'Paris coefficient C', unit: 'm/cycle·(MPa√m)^−m', type: 'number', min: 1e-13, max: 1e-7, step: 1e-12, default: 1e-10, group: 'Fracture mechanics', expert: true },
    { key: 'parisM', label: 'Paris exponent m', type: 'number', min: 1.5, max: 6, step: 0.1, default: 3.2, group: 'Fracture mechanics', expert: true },
    { key: 'dKth', label: 'Threshold ΔK_th', unit: 'MPa√m', type: 'number', min: 0.2, max: 10, step: 0.1, default: 2.0, group: 'Fracture mechanics', expert: true },
    { key: 'KIc', label: 'Fracture toughness K_Ic', unit: 'MPa√m', type: 'number', min: 5, max: 120, step: 1, default: 35, group: 'Fracture mechanics', expert: true },
    { key: 'Ygeo', label: 'Geometry factor Y', type: 'number', min: 0.5, max: 2, step: 0.01, default: 1.12, group: 'Fracture mechanics', expert: true },
    { key: 'walker', label: 'Walker exponent γ', type: 'number', min: 0.2, max: 1, step: 0.05, default: 0.5, group: 'Fracture mechanics', expert: true },
    { key: 'epsSatScale', label: 'Ratchet saturation ε_sat as fraction of ε_tr', type: 'number', min: 0, max: 0.5, step: 0.01, default: 0.06, group: 'Ratcheting', expert: true },
    { key: 'Ns', label: 'Ratchet saturation constant N_s', unit: 'cycles', type: 'number', min: 1, max: 1e5, step: 10, default: 300, group: 'Ratcheting', expert: true },
    { key: 'ratchetRate', label: 'Long-term ratchet rate at σ_H = 200 MPa', unit: '1/cycle', type: 'number', min: 0, max: 1e-6, step: 1e-12, default: 1e-10, group: 'Ratcheting', expert: true },
    { key: 'epsAllow', label: 'Allowable residual set (stroke / grip clearance)', unit: '%', type: 'number', min: 0.05, max: 5, step: 0.05, default: 0.5, group: 'Ratcheting' },
    { key: 'beta', label: 'Weibull shape β', type: 'number', min: 0.5, max: 10, step: 0.1, default: 2.5, group: 'Reliability' },
    { key: 'lossFrac', label: 'Tolerated ribbon loss per cell', unit: '%', type: 'number', min: 0, max: 50, step: 1, default: 10, group: 'Reliability', help: 'Cell keeps working (with higher stress on the survivors) until more than this fraction of its ribbons has failed.' },
    { key: 'Rtarget', label: 'Inspection reliability target', type: 'number', min: 0.5, max: 0.9999, step: 0.01, default: 0.95, group: 'Reliability' },
    { key: 'lifeTarget', label: 'Service life target', unit: 'cycles', type: 'number', min: 1e3, max: 1e10, step: 1e5, default: 1e7, group: 'Reliability', help: 'Specification aspiration: up to 10⁸ complete cycles.' },
    { key: 'corrRate', label: 'Uniform corrosion rate per face', unit: 'µm/yr', type: 'number', min: 0, max: 50, step: 0.05, default: 0.1, group: 'Environment' },
    { key: 'dutyHours', label: 'Operating hours per year', unit: 'h/yr', type: 'number', min: 100, max: 8760, step: 10, default: 6000, group: 'Environment' },
    { key: 'nGrid', label: 'Damage-map grid (along length)', type: 'number', min: 21, max: 301, step: 10, default: 121, group: 'Numerics', expert: true },
  ],
  presets: [
    { label: 'Optimised bonded grips (K_t 1.3, polished edges)', values: { Kt: 1.3, edgeKt: 1.02, a0: 8 } },
    { label: 'Serrated clamp, as-cut edges (K_t 2.4)', values: { Kt: 2.4, edgeKt: 1.2, a0: 25 } },
    { label: '10⁸-cycle aspiration check', values: { lifeTarget: 1e8, Rtarget: 0.99 } },
    { label: 'Aggressive coolant (corrosion 2 µm/yr)', values: { corrRate: 2 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const d = ctx.eng.designWith(ctx.engine, { sigmaL: p.sigmaL, sigmaH: p.sigmaH, freq: p.freq, Th: p.Th });
    const mat = ctx.materials.get(d.alloy) || ctx.material('ribbon');
    const A = d.ribbonsPerCell * d.ribbonW * d.ribbonT, L = d.ribbonL, t = d.ribbonT, Wd = d.ribbonW;
    const EM = mat.EM * 1e3, EA = mat.EA * 1e3; // MPa
    // ---- load history (actual, not nominal)
    let H = null, srcLabel = '', prov = 'calc';
    const s14 = ctx.upstream('s14'), s05 = ctx.upstream('s05');
    if (p.source === 'auto' && s14?.history?.sExt?.length > 10) { H = { t: s14.history.t, s: s14.history.sExt, e: s14.history.eps, xi: s14.history.xi, T: s14.history.Tm }; srcLabel = 'Suite 14 converged co-simulation'; prov = 'coupled'; }
    else if (p.source === 'auto' && s05?.forceHistory?.F?.length > 10) { const fh = s05.forceHistory, x = fh.x, xM = max(x); H = { t: fh.t, s: fh.F.map(F => F / A / 1e6), e: x.map(v => (xM - v) / L), xi: null, T: null }; srcLabel = 'Suite 05 cartridge force–stroke history'; prov = 'coupled'; }
    let cell = null;
    if (!H) { cell = ctx.sma.cellFromDesign(mat, d, { n: 2, stepsPerCycle: 200, cycles: 3 }); H = { t: cell.hist.t, s: cell.hist.sExt, e: cell.hist.eps, xi: cell.hist.xi, T: cell.hist.Tm }; srcLabel = 'internal cell transient (no coupled history available)'; prov = 'calc'; }
    // an upstream history is mapped onto the requested stress levels when the user has changed σ_L/σ_H since that run
    const sMaxH = max(H.s), sMinH = min(H.s);
    let rescaled = false;
    if (prov === 'coupled' && sMaxH - sMinH > 1 && (Math.abs(sMinH - p.sigmaL) > 1 || Math.abs(sMaxH - p.sigmaH) > 1)) { H.s = H.s.map(v => p.sigmaL + (v - sMinH) * (p.sigmaH - p.sigmaL) / (sMaxH - sMinH)); rescaled = true; }
    const sMaxNom = max(H.s), sMinNom = min(H.s);
    const dEps = max(H.e) - min(H.e), epsTr = Math.max(1e-5, dEps - (sMaxNom - sMinNom) / EM - (mat.alpha || 11) * 1e-6 * Math.max(0, p.Th - d.Tc));
    const Kf = 1 + p.qNotch * (p.Kt - 1), KfEdge = 1 + p.qNotch * (p.Kt * p.edgeKt - 1);
    // ---- functional fatigue: free length vs grip
    const Nfun = (eps, s) => ctx.sma.fatigueLife(mat, eps, s);
    const NfFree = Nfun(epsTr, sMaxNom), NfGrip = Nfun(epsTr, KfEdge * sMaxNom);
    // ---- structural fatigue: rainflow of grip stress, Basquin + mean-stress, CMM + Neuber, Miner
    const sGrip = H.s.map(s => KfEdge * s), cyc = rainflowPeriodic(sGrip);
    const su = mat.su || 1000, sfp = p.sfPrime, b = p.bExp, c = p.cExp, Eeff = 0.5 * (EM + EA);
    const sAr = (sa, sm) => p.meanStress === 'gerber' ? sa / Math.max(1e-6, 1 - (sm / su) ** 2) : p.meanStress === 'swt' ? Math.sqrt(Math.max(0, (sm + sa) * sa)) : sa / Math.max(1e-6, 1 - sm / su);
    const Nbasq = (sa, sm) => { if (sm + sa >= su) return 1; const r = sAr(sa, sm); return r <= 0 ? 1e20 : Math.min(1e20, 0.5 * (r / sfp) ** (1 / b)); };
    // Neuber with cyclic Ramberg–Osgood (on nominal S = σ/K_f range, K_t applied as the elastic concentration)
    const roStrain = (sg) => sg / Eeff + (Math.max(0, sg) / p.Kc) ** (1 / p.nc);
    const neuber = (dS) => { const tgt = (dS) ** 2 / Eeff; let lo = 0, hi = dS * 2 + 1; for (let i = 0; i < 80; i++) { const m = 0.5 * (lo + hi), de = 2 * roStrain(m / 2); if (m * de > tgt) hi = m; else lo = m; } const ds = 0.5 * (lo + hi); return { ds, de: 2 * roStrain(ds / 2) }; };
    const Ncmm = (dEl, sm) => { const ea = dEl / 2, f = (N) => (sfp - sm) / Eeff * (2 * N) ** b + p.efPrime * (2 * N) ** c - ea; if (f(1e20) > 0) return 1e20; if (f(0.5) < 0) return 0.5; let lo = Math.log(0.5), hi = Math.log(1e20); for (let i = 0; i < 100; i++) { const m = 0.5 * (lo + hi); if (f(Math.exp(m)) > 0) lo = m; else hi = m; } return Math.exp(0.5 * (lo + hi)); };
    let Dbasq = 0, Dcmm = 0; const cycRows = [];
    for (const k of cyc) { const sa = k.range / 2, nb = Nbasq(sa, k.mean), nz = neuber(k.range), ncm = Ncmm(nz.de, k.mean); Dbasq += k.count / nb; Dcmm += k.count / ncm; cycRows.push([k.range, k.mean, k.count, sAr(sa, k.mean), nb, nz.de * 100, ncm]); }
    const Nstruct = 1 / Math.max(1e-30, Math.max(Dbasq, Dcmm));
    // ---- ratcheting
    const epsSat = p.epsSatScale * epsTr, rate = p.ratchetRate * (sMaxNom / 200) ** 2, eAllow = p.epsAllow / 100;
    const ratchet = (N) => epsSat * (1 - Math.exp(-N / p.Ns)) + rate * N;
    const Nratch = epsSat >= eAllow ? (() => { let lo = 0, hi = 50 * p.Ns; for (let i = 0; i < 80; i++) { const m = 0.5 * (lo + hi); if (ratchet(m) > eAllow) hi = m; else lo = m; } return Math.max(1, 0.5 * (lo + hi)); })() : (rate > 0 ? (eAllow - epsSat) / rate : Infinity);
    // ---- fracture mechanics at the grip edge
    const dSg = KfEdge * (sMaxNom - sMinNom), sMg = KfEdge * sMaxNom, R = sMinNom / Math.max(1e-9, sMaxNom);
    const walk = 1 / Math.max(0.05, (1 - clamp(R, -1, 0.95)) ** (1 - p.walker));
    const dK = (a) => p.Ygeo * dSg * Math.sqrt(Math.PI * a) * walk;
    const aC = Math.min(0.8 * t, (1 / Math.PI) * (p.KIc / (p.Ygeo * sMg)) ** 2), aTh = (1 / Math.PI) * (p.dKth / (p.Ygeo * dSg * walk)) ** 2, a0 = p.a0 * 1e-6, aDet = p.aDet * 1e-6;
    const grow = (aStart, aEnd) => { if (aStart >= aEnd) return { N: 0, path: [[aStart, 0]] }; if (dK(aStart) < p.dKth && dK(aEnd) < p.dKth) return { N: Infinity, path: [] }; let N = 0; const path = [[aStart, 0]]; const as = logspace(LOG10(aStart), LOG10(aEnd), 401); for (let i = 1; i < as.length; i++) { const am = Math.sqrt(as[i] * as[i - 1]), k = dK(am); if (k < p.dKth) { return { N: Infinity, path, arrestAt: am }; } N += (as[i] - as[i - 1]) / (p.parisC * k ** p.parisM); path.push([as[i], N]); } return { N, path }; };
    const crack = grow(a0, aC), crackDet = aDet < aC ? grow(Math.max(a0, aDet), aC) : { N: 0, path: [] };
    const Ncrack = crack.N;
    // ---- creep screen and corrosion allowance
    const Tmelt = mat.Tmelt ?? (/^cu/.test(mat.id) ? 1040 : /^fe/.test(mat.id) ? 1350 : 1310), homol = (p.Th + 273.15) / (Tmelt + 273.15);
    // ---- governing deterministic life (median)
    const modes = [['Functional fatigue at grip', NfGrip], ['Functional fatigue, free length', NfFree], ['Structural fatigue at grip (rainflow + Miner)', Nstruct], ['Residual-set ratcheting', Nratch], ['Crack growth a₀ → a_c', Ncrack]];
    const gov = modes.reduce((a, m2) => m2[1] < a[1] ? m2 : a);
    let lifeMed = gov[1];
    const finiteLife = Number.isFinite(lifeMed), immediate = lifeMed < 1;
    if (!finiteLife) lifeMed = 1e12;
    if (immediate) lifeMed = 1; // fails on first loading (e.g. initial flaw already beyond the critical size)
    const yrs = lifeMed / (p.freq * 3600 * p.dutyHours);
    // corrosion: thickness loss at end of life raises the nominal stress; re-evaluate the functional life
    const loss = 2 * p.corrRate * 1e-6 * yrs, tEnd = Math.max(1e-7, t - loss), sFac = t / tEnd, NfGripCorr = Nfun(epsTr, KfEdge * sMaxNom * sFac);
    const corrAllow = 2 * p.corrRate * 1e-6 * Math.min(yrs, 30);
    // ---- damage per cycle (Miner, all mechanisms that accumulate per cycle)
    const damagePerCycle = 1 / NfGrip + Dbasq + (Number.isFinite(Ncrack) && Ncrack > 0 ? 1 / Ncrack : 0);
    // ---- Weibull survival of the population
    const beta = p.beta, eta = lifeMed / Math.LN2 ** (1 / beta), nR = d.ribbonsPerCell, nC = d.nCells, nTot = nR * nC, m = Math.floor(p.lossFrac / 100 * nR);
    const Rrib = (N) => Math.exp(-((N / eta) ** beta));
    const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
    const Rcell = (N) => { const r = Rrib(N), F = 1 - r; let s = 0; for (let j = 0; j <= m; j++) s += binom(nR, j) * F ** j * r ** (nR - j); return Math.min(1, s); };
    const Rsys = (N) => Rcell(N) ** nC, Rseries = (N) => Rrib(N) ** nTot;
    const lifeAt = (fn, Rq) => { let lo = 0, hi = LOG10(eta) + 6; if (fn(10 ** hi) > Rq) return 10 ** hi; for (let i = 0; i < 100; i++) { const mm = 0.5 * (lo + hi); if (fn(10 ** mm) > Rq) lo = mm; else hi = mm; } return 10 ** (0.5 * (lo + hi)); };
    const P10 = eta * (-Math.log(0.9)) ** (1 / beta), P50 = eta * Math.LN2 ** (1 / beta), P90 = eta * (-Math.log(0.1)) ** (1 / beta);
    const sysFirst50 = lifeAt(Rseries, 0.5), sysRed50 = lifeAt(Rsys, 0.5), sysRedT = lifeAt(Rsys, p.Rtarget), sysRed10 = lifeAt(Rsys, 0.9);
    // ---- inspection interval
    const cand = [['Redundant-system reliability (R = ' + p.Rtarget + ') / 2', sysRedT / 2]];
    if (Number.isFinite(crackDet.N) && crackDet.N > 0) cand.push(['Damage tolerance: (N_c − N_det)/2', crackDet.N / 2]);
    if (Number.isFinite(Nratch)) cand.push(['Residual-set growth / 3', Nratch / 3]);
    const insp = cand.reduce((a, b2) => b2[1] < a[1] ? b2 : a);
    const inspectInterval = Math.max(1, insp[1]);
    // ---- damage map along length and across width
    const ell = p.gripDecay * 1e-3, nx = Math.max(21, Math.round(p.nGrid)), ny = 15;
    const xsG = linspace(0, L, nx), ysG = linspace(0, Wd, ny), edgeBand = Math.max(2 * t, 0.05 * Wd);
    const KtAt = (x, y) => { const dg = Math.min(x, L - x); const edge = (y < edgeBand || Wd - y < edgeBand) ? p.edgeKt : 1; return (1 + (p.Kt - 1) * Math.exp(-dg / ell)) * edge; };
    const dmgAt = (x, y) => { const kf = 1 + p.qNotch * (KtAt(x, y) - 1); return 1 / Nfun(epsTr, kf * sMaxNom); };
    const Z = ysG.map(y => xsG.map(x => LOG10(dmgAt(x, y))));
    const lineD = xsG.map(x => dmgAt(x, Wd / 2)), lineDe = xsG.map(x => dmgAt(x, 0));
    const iMax = lineDe.reduce((bi, v, i) => v > lineDe[bi] ? i : bi, 0);
    const criticalLocation = NfGrip < NfFree * 0.999 ? `grip edge (x = ${fmt(xsG[iMax] * 1000, 3)} mm from the clamp line, slit edge), K_f = ${fmt(KfEdge, 3)}` : 'free length (uniform)';

    // ---- KPIs
    const st = (ok, warn) => ok ? 'ok' : warn ? 'warn' : 'bad';
    out.kpis.push(
      { label: 'Median life (governing)', value: finiteLife ? lifeMed : 'no finite failure mode', unit: finiteLife ? 'cycles' : '', explain: `Smallest of the mechanism lives — governed by “${gov[0]}”. This is the deterministic model life taken as the median of the ribbon population.`, status: st(lifeMed >= p.lifeTarget, lifeMed >= 0.1 * p.lifeTarget), prov: 'calc' },
      { label: 'Life P10 (10 % of ribbons failed)', value: P10, unit: 'cycles', explain: `Weibull (β = ${beta}) life by which 10 % of individual ribbons are expected to have failed.`, status: st(P10 >= p.lifeTarget, P10 >= 0.1 * p.lifeTarget), prov: 'calc' },
      { label: 'Life P90 (90 % failed)', value: P90, unit: 'cycles', explain: 'Life by which 90 % of individual ribbons are expected to have failed — the upper end of the scatter band.', prov: 'calc' },
      { label: 'Damage per cycle (Miner)', value: damagePerCycle, unit: '1/cycle', explain: 'Fraction of life consumed per engine cycle at the critical location (functional + structural + crack growth contributions). Its inverse is the cumulative-damage life.', prov: 'calc' },
      { label: 'Recommended inspection interval', value: inspectInterval, unit: 'cycles', explain: `Governed by: ${insp[0]}. Equivalent to ${fmt(inspectInterval / p.freq / 3600, 3)} operating hours at ${fmt(p.freq, 3)} Hz.`, prov: 'calc' },
      { label: 'Critical location', value: criticalLocation, explain: 'Where damage accumulates fastest: the grip edge when the stress concentration controls, otherwise the uniformly loaded free length.', prov: 'calc' },
      { label: 'Engine life to first ribbon failure (median)', value: sysFirst50, unit: 'cycles', explain: `Weakest-link life of all ${nTot} ribbons in series: the first maintenance event, not a functional failure.`, prov: 'calc' },
      { label: 'Engine life with redundancy (median)', value: sysRed50, unit: 'cycles', explain: `Each cell keeps working until more than ${m} of its ${nR} ribbons have failed; the engine fails when any of its ${nC} cells fails.`, status: st(sysRed50 >= p.lifeTarget, sysRed50 >= 0.1 * p.lifeTarget), prov: 'calc' },
      { label: 'Median life in service time', value: yrs, unit: 'years', explain: `At ${fmt(p.freq, 3)} Hz and ${p.dutyHours} operating hours per year.`, prov: 'calc' },
      { label: 'Transformation strain amplitude', value: 100 * epsTr, unit: '%', explain: `Recoverable transformation strain swing from the ${srcLabel} history (total strain swing minus elastic and thermal parts). It is the main driver of functional fatigue.`, prov },
      { label: 'Homologous temperature', value: homol, unit: 'T/T_m', explain: 'Hot-fluid temperature as a fraction of the melting point (K). Creep is negligible below ≈ 0.3–0.4.', status: st(homol < 0.3, homol < 0.4), prov: 'calc' },
    );
    // ---- verdicts
    if (immediate) out.verdicts.push({ test: 'Static integrity on first loading', status: 'fail', detail: `The governing mechanism (${gov[0]}) predicts failure on the first cycle: initial flaw ${p.a0} µm vs critical depth ${fmt(aC * 1e6, 3)} µm at σ_max,grip = ${fmt(sMg, 4)} MPa.`, fix: 'Reduce the grip stress, specify a smaller maximum flaw (inspection/acceptance criterion) or increase thickness.' });
    out.verdicts.push(
      { test: `Median life ≥ service target (${fmt(p.lifeTarget, 3)} cycles)`, status: lifeMed >= p.lifeTarget ? 'pass' : 'fail', detail: `Governing mode “${gov[0]}”: ${fmt(lifeMed, 3)} cycles.`, fix: lifeMed >= p.lifeTarget ? undefined : `Reduce the transformation strain (target ≤ ${fmt(100 * epsTr * (lifeMed / p.lifeTarget) ** (1 / ((mat.fatigue?.a) || 3)), 3)} % at the same stress), lower σ_H, improve the grip (K_t → 1.3) or use a low-fatigue alloy (e.g. TiNiCu-based).` },
      { test: 'P10 life meets the target (90 % ribbon survival)', status: P10 >= p.lifeTarget ? 'pass' : 'warn', detail: `P10 = ${fmt(P10, 3)} cycles (β = ${beta}).`, fix: 'Narrow the scatter (inclusion-controlled melt, polished edges) or derate stress/strain.' },
      { test: 'Grip stress concentration does not dominate life', status: NfGrip > 0.5 * NfFree ? 'pass' : 'warn', detail: `Functional life at the grip ${fmt(NfGrip, 3)} vs free length ${fmt(NfFree, 3)} cycles (K_f,edge = ${fmt(KfEdge, 3)}).`, fix: 'Use a tapered/bonded grip, larger fillet or locally thicker (non-transforming) ends to bring K_t below 1.3.' },
      { test: 'Structural (elastic-stress) fatigue', status: Nstruct >= 10 * p.lifeTarget ? 'pass' : Nstruct >= p.lifeTarget ? 'warn' : 'fail', detail: `Rainflow + Miner: Basquin (${p.meanStress}) damage ${fmt(Dbasq, 3)}/cycle, Coffin–Manson–Morrow with Neuber ${fmt(Dcmm, 3)}/cycle → ${fmt(Nstruct, 3)} cycles.`, fix: 'Reduce the stress range at the grip or the mean stress (bias).' },
      { test: 'Fatigue-crack growth from the initial flaw', status: !Number.isFinite(Ncrack) ? 'pass' : Ncrack > p.lifeTarget ? 'pass' : 'fail', detail: Number.isFinite(Ncrack) ? `a₀ = ${p.a0} µm grows to a_c = ${fmt(aC * 1e6, 3)} µm in ${fmt(Ncrack, 3)} cycles (ΔK₀ = ${fmt(dK(a0), 3)} MPa√m).` : `ΔK at a₀ = ${p.a0} µm is ${fmt(dK(a0), 3)} MPa√m < ΔK_th = ${p.dKth} MPa√m: no long-crack growth. Threshold flaw ${fmt(aTh * 1e6, 3)} µm${aTh > 0.8 * t ? ' exceeds the usable thickness — flaw tolerant' : ''}.`, fix: Number.isFinite(Ncrack) ? 'Inspect for flaws above the detectable size, reduce Δσ at the grip, or improve inclusion cleanliness.' : undefined },
      { test: 'Residual set within allowance', status: Nratch >= p.lifeTarget ? 'pass' : 'warn', detail: `ε_sat = ${fmt(100 * epsSat, 3)} %, long-term rate ${fmt(rate, 3)}/cycle; allowance ${p.epsAllow} % reached at ${fmt(Nratch, 3)} cycles.`, fix: 'Train the ribbon (stabilisation cycles) before assembly and provide bias-spring take-up for residual set.' },
      { test: 'Creep negligible', status: homol < 0.3 ? 'pass' : homol < 0.4 ? 'warn' : 'fail', detail: `T/T_m = ${fmt(homol, 3)} at ${p.Th} °C.${p.Th > 200 ? ' NiTi ageing/precipitation also shifts transformation temperatures above ≈ 200–250 °C.' : ''}`, fix: 'Lower the source temperature or use a high-temperature alloy.' },
      { test: 'Corrosion allowance', status: NfGripCorr >= 0.8 * NfGrip ? 'pass' : 'warn', detail: `${p.corrRate} µm/yr per face over ${fmt(yrs, 3)} years removes ${fmt(loss * 1e6, 3)} µm (${fmt(100 * loss / t, 3)} % of thickness); grip functional life falls to ${fmt(NfGripCorr, 3)} cycles.`, fix: 'Specify a passivated (oxide) surface, inhibited coolant, or add thickness allowance.' },
      { test: '10⁸-cycle aspiration (spec §3)', status: lifeMed >= 1e8 ? 'pass' : 'info', detail: `Model median ${fmt(lifeMed, 3)} cycles. The aspiration requires measured S–N/ε–N data at the operating point with survival confidence.`, fix: lifeMed >= 1e8 ? undefined : 'Run the endurance test plan; consider low-fatigue compositions and strain below ≈ 1–2 %.' },
      { test: 'Measured fatigue data', status: 'info', detail: (ctx.experiments || []).length ? `${ctx.experiments.length} dataset(s) imported for comparison.` : 'No ribbon fatigue test data imported — all lives are model estimates with library constants.', fix: 'Measure functional fatigue (stroke vs cycles) and S–N at the operating stress and strain with ≥ 6 specimens per level; import CSV (cycles, amplitude, failed/runout).' },
    );
    // ---- checks (verification)
    const astm = rainflow([-2, 1, -3, 5, -1, 3, -4, 4, -2]), agg = {}; for (const k of astm) agg[k.range] = (agg[k.range] || 0) + k.count;
    const astmOK = agg[3] === 0.5 && agg[4] === 1.5 && agg[6] === 0.5 && agg[8] === 1 && agg[9] === 0.5;
    const caSa = 100, caSm = 0, caN = Nbasq(caSa, caSm), caD = rainflowPeriodic([0, 100, -100, 100, -100, 0]).reduce((s, k) => s + k.count / Nbasq(k.range / 2, k.mean), 0);
    const crN = (() => { const a1 = 10e-6, a2 = 100e-6, Kc = p.Ygeo * 100 * Math.sqrt(Math.PI), mm = p.parisM; const exact = (a2 ** (1 - mm / 2) - a1 ** (1 - mm / 2)) / ((1 - mm / 2) * p.parisC * Kc ** mm); let N = 0; const as = logspace(LOG10(a1), LOG10(a2), 401); for (let i = 1; i < as.length; i++) { const am = Math.sqrt(as[i] * as[i - 1]); N += (as[i] - as[i - 1]) / (p.parisC * (Kc * Math.sqrt(am)) ** mm); } return Math.abs(N - exact) / exact; })();
    out.checks.push(
      { name: 'Rainflow vs ASTM E1049 example (ranges 3,4,6,8,9 → 0.5,1.5,0.5,1,0.5)', value: JSON.stringify(agg), target: 'exact', pass: astmOK },
      { name: 'Miner sum of constant-amplitude history = 2/N (two full cycles)', value: caD * caN, target: '2', pass: Math.abs(caD * caN - 2) < 1e-6 },
      { name: 'Weibull P50 reproduces the model median', value: P50 / lifeMed, target: '1', pass: Math.abs(P50 / lifeMed - 1) < 1e-9 },
      { name: 'Paris integration vs closed form (Y const.)', value: crN, target: '< 1e-3', pass: crN < 1e-3 },
      { name: 'Rainflow counts close the history (Σ half-cycles even)', value: cyc.reduce((s, k) => s + k.count, 0), target: 'integer', pass: Math.abs(cyc.reduce((s, k) => s + k.count, 0) % 1) < 1e-9 },
      { name: 'Redundant system life ≥ first-failure life', value: sysRed50 / Math.max(1, sysFirst50), target: '≥ 1', pass: sysRed50 >= sysFirst50 * (1 - 1e-9) },
    );
    // ---- charts
    const tH = H.t.map(v => v * 1000);
    out.charts.push({ type: 'line', title: 'Stress history: nominal and at the critical grip edge', wide: true, x: { label: 'Time in cycle', unit: 'ms' }, y: { label: 'Stress', unit: 'MPa' }, series: [{ name: 'Nominal (free length)', x: tH, y: H.s }, { name: `Grip edge (K_f = ${fmt(KfEdge, 3)})`, x: tH, y: sGrip }], annotations: [{ type: 'hline', y: su, label: 'UTS', color: '#ef4444' }], explain: `Actual stress history of one cycle from the ${srcLabel}. The grip-edge curve is what the fatigue analysis counts; steps are clutch engagement and release.` });
    const bins = 10, rMax = Math.max(1e-9, max(cyc.map(k => k.range))), cnt = new Array(bins).fill(0); for (const k of cyc) cnt[Math.min(bins - 1, Math.floor(k.range / rMax * bins))] += k.count;
    out.charts.push({ type: 'bar', title: 'Rainflow histogram of the grip stress (per engine cycle)', categories: range(bins).map(i => `${fmt(i * rMax / bins, 3)}–${fmt((i + 1) * rMax / bins, 3)}`), series: [{ name: 'Cycles', values: cnt }], explain: 'Number of stress cycles per engine cycle by stress range (ASTM E1049 rainflow). One dominant cycle (bias ↔ load) plus small cycles from clutch transitions is typical; each bin contributes n_i/N_i to the Miner damage.' });
    const eAx = logspace(LOG10(0.002), LOG10(0.06), 50);
    out.charts.push({ type: 'line', title: 'Functional strain–life curves', x: { label: 'Transformation strain swing', unit: '%', log: true }, y: { label: 'Cycles to failure', log: true }, series: [{ name: `Free length σ = ${fmt(sMaxNom, 3)} MPa`, x: eAx.map(e => 100 * e), y: eAx.map(e => Nfun(e, sMaxNom)) }, { name: `Grip edge σ = ${fmt(KfEdge * sMaxNom, 3)} MPa`, x: eAx.map(e => 100 * e), y: eAx.map(e => Nfun(e, KfEdge * sMaxNom)) }], annotations: [{ type: 'vline', x: 100 * epsTr, label: 'operating ε_tr' }, { type: 'hline', y: p.lifeTarget, label: 'target', color: '#22c55e' }], explain: 'Functional-fatigue life (library trend) against transformation strain at the free-length and grip stresses. Halving the strain swing raises life by 2^a; the vertical line is the operating point.' });
    const eG = linspace(0.005, 0.05, 37), sG = linspace(40, Math.max(300, 1.5 * KfEdge * sMaxNom), 31);
    out.charts.push({ type: 'heatmap', title: 'Functional life map log₁₀N over transformation strain and peak stress', x: { label: 'Transformation strain swing', unit: '%', values: eG.map(e => 100 * e) }, y: { label: 'Peak stress', unit: 'MPa', values: sG }, z: sG.map(s => eG.map(e => LOG10(Nfun(e, s)))), cmap: 'viridis', isolines: 6, z_label: 'log₁₀ N', overlay: [{ pts: [[100 * epsTr, sMaxNom], [100 * epsTr, KfEdge * sMaxNom]], stroke: '#ef4444', width: 2.5 }], explain: `Colour is log₁₀ of the functional-fatigue life; isolines are equal-life contours. The red segment joins the free-length and grip operating points (${fmt(100 * epsTr, 3)} % strain). Moving down-left (less strain, lower stress) buys life at the cost of work per cycle.` });
    out.charts.push({ type: 'heatmap', title: 'Damage map on the ribbon (log₁₀ damage per cycle)', wide: true, x: { label: 'Position along ribbon', unit: 'mm', values: xsG.map(x => x * 1000) }, y: { label: 'Across width', unit: 'mm', values: ysG.map(y => y * 1000) }, z: Z, cmap: 'inferno', z_label: 'log₁₀ D', explain: `Damage per cycle over the ribbon plan. Stress concentration K_t = ${p.Kt} decays over ℓ = ${p.gripDecay} mm from each clamp line; slit edges carry an extra factor ${p.edgeKt}. The hot spots at the four grip corners are where cracks are expected first.` });
    out.charts.push({ type: 'line', title: 'Damage along the ribbon length', x: { label: 'Position', unit: 'mm' }, y: { label: 'Damage per cycle', log: true }, series: [{ name: 'Centre line', x: xsG.map(x => x * 1000), y: lineD }, { name: 'Slit edge', x: xsG.map(x => x * 1000), y: lineDe }], explain: 'Functional-fatigue damage per cycle along the centre line and along the slit edge. The ratio between the grip peak and the free-length plateau is the life penalty of the grip design.' });
    const Nax = logspace(0, Math.max(6, LOG10(Math.max(lifeMed, p.lifeTarget)) + 0.5), 80);
    out.charts.push({ type: 'line', title: 'Residual-set (ratcheting) accumulation', x: { label: 'Cycles', log: true }, y: { label: 'Residual strain', unit: '%' }, series: [{ name: 'ε_res(N)', x: Nax, y: Nax.map(N => 100 * ratchet(N)) }], annotations: [{ type: 'hline', y: p.epsAllow, label: 'allowance', color: '#ef4444' }], explain: 'Residual strain grows quickly during the first few hundred cycles (stabilisation) then slowly. Training before assembly removes the saturating part; the long-term rate must be absorbed by the bias take-up.' });
    const dsA = linspace(0.2 * dSg, 3 * dSg + 50, 40);
    out.charts.push({ type: 'line', title: 'Flaw-tolerance diagram at the grip', x: { label: 'Local stress range Δσ', unit: 'MPa' }, y: { label: 'Flaw depth', unit: 'µm', log: true }, series: [{ name: 'Threshold flaw (no growth below)', x: dsA, y: dsA.map(ds => 1e6 * (1 / Math.PI) * (p.dKth / (p.Ygeo * ds * walk)) ** 2) }, { name: 'Critical flaw at σ_max (capped 0.8 t)', x: dsA, y: dsA.map(ds => 1e6 * Math.min(0.8 * t, (1 / Math.PI) * (p.KIc / (p.Ygeo * sMg * Math.max(1, ds / dSg))) ** 2)) }], annotations: [{ type: 'vline', x: dSg, label: 'operating Δσ' }, { type: 'hline', y: p.a0, label: 'a₀', color: '#f59e0b' }, { type: 'hline', y: p.aDet, label: 'detectable', color: '#22c55e' }], explain: 'Flaws below the threshold curve do not grow; above the critical curve the ribbon fractures. Between them, Paris-law growth sets the remaining life. If a₀ lies below the threshold at the operating Δσ, crack growth does not limit life.' });
    if (crack.path.length > 2) out.charts.push({ type: 'line', title: 'Crack growth a(N) from the initial flaw', x: { label: 'Cycles', log: true }, y: { label: 'Crack depth', unit: 'µm', log: true }, series: [{ name: 'a(N)', x: crack.path.map(q => Math.max(1, q[1])), y: crack.path.map(q => q[0] * 1e6) }], annotations: [{ type: 'hline', y: aC * 1e6, label: 'critical', color: '#ef4444' }, { type: 'hline', y: p.aDet, label: 'detectable', color: '#22c55e' }], explain: 'Paris-law growth from a₀ to the critical depth. The interval between the detectable and critical depths sets the damage-tolerance inspection interval.' });
    const Nr = logspace(LOG10(Math.max(1, P10 / 1e3)), LOG10(P90 * 10), 80);
    out.charts.push({ type: 'line', title: 'Survival (Weibull) of ribbons, cells and the engine', x: { label: 'Cycles', log: true }, y: { label: 'Reliability R(N)' }, series: [{ name: 'Single ribbon', x: Nr, y: Nr.map(Rrib) }, { name: `Cell (tolerates ${m} of ${nR} failed)`, x: Nr, y: Nr.map(Rcell) }, { name: `Engine, ${nC} cells with redundancy`, x: Nr, y: Nr.map(Rsys) }, { name: `No failure among ${nTot} ribbons`, x: Nr, y: Nr.map(Rseries), dash: '5 4' }], annotations: [{ type: 'vline', x: p.lifeTarget, label: 'target' }, { type: 'hline', y: p.Rtarget, label: 'R target', color: '#22c55e' }], explain: 'Probability of survival versus cycles. With hundreds of ribbons, the first ribbon failure arrives far earlier than the median ribbon life — redundancy (tolerating a few broken ribbons per cell) recovers most of it.' });
    const sm = linspace(0, su, 30);
    out.charts.push({ type: 'line', title: 'Haigh mean-stress diagram with rainflow cycles', x: { label: 'Mean stress', unit: 'MPa' }, y: { label: 'Stress amplitude', unit: 'MPa' }, series: [{ name: `Goodman (N = ${fmt(p.lifeTarget, 2)})`, x: sm, y: sm.map(s => sfp * (2 * p.lifeTarget) ** b * (1 - s / su)) }, { name: 'Gerber', x: sm, y: sm.map(s => sfp * (2 * p.lifeTarget) ** b * (1 - (s / su) ** 2)), dash: '5 4' }, { name: 'Rainflow cycles (grip)', x: cyc.map(k => k.mean), y: cyc.map(k => k.range / 2), mode: 'markers' }], explain: 'Allowable amplitude at the target life against mean stress. Points below the lines are safe for structural (elastic) fatigue; the SMA operates at high mean stress (bias) and small amplitude, so structural fatigue rarely governs — functional fatigue does.' });
    out.charts.push({ type: 'bar', title: 'Life by failure mechanism', horizontal: true, categories: modes.map(q => q[0]), series: [{ name: 'log₁₀ cycles', values: modes.map(q => Number.isFinite(q[1]) ? LOG10(q[1]) : 12) }], explain: 'Each mechanism’s predicted life (log₁₀ cycles; 12 means no finite failure). The shortest bar governs the median life and the maintenance strategy.' });
    // ---- tables
    out.tables.push({ title: 'Failure-mechanism summary', cols: ['Mechanism', 'Life [cycles]', 'Life [years]', 'Governs?'], rows: modes.map(q => [q[0], Number.isFinite(q[1]) ? q[1] : 'no finite failure', Number.isFinite(q[1]) ? q[1] / (p.freq * 3600 * p.dutyHours) : '—', q === gov ? 'yes' : '']), explain: 'Lives of all mechanisms evaluated from the same load history. Years assume the stated operating hours per year.' });
    out.tables.push({ title: 'Rainflow cycles at the grip edge (one engine cycle)', cols: ['Range [MPa]', 'Mean [MPa]', 'Count', 'Equiv. amplitude [MPa]', 'Basquin N', 'Local strain range [%] (Neuber)', 'CMM N'], rows: cycRows.slice(0, 30), explain: `Rainflow-counted cycles with the ${p.meanStress} mean-stress correction; the Coffin–Manson–Morrow life uses the Neuber local strain range.` });
    out.tables.push({ title: 'Life distribution', cols: ['Population', 'P10 [cycles]', 'P50 [cycles]', 'P90 [cycles]'], rows: [
      ['Single ribbon', P10, P50, P90],
      [`Engine — first of ${nTot} ribbons fails`, lifeAt(Rseries, 0.9), sysFirst50, lifeAt(Rseries, 0.1)],
      [`Engine — redundancy ${m}/${nR} per cell`, sysRed10, sysRed50, lifeAt(Rsys, 0.1)],
    ], explain: `Weibull shape β = ${beta}; scale η = ${fmt(eta, 3)} cycles.` });
    out.tables.push({ title: 'Inspection-interval candidates', cols: ['Criterion', 'Interval [cycles]', 'Interval [h]'], rows: cand.map(q => [q[0], q[1], q[1] / p.freq / 3600]), explain: 'The smallest candidate is recommended. Inspect stroke, residual set, force at the bias stress and grip edges (dye penetrant/optical) at each interval.' });
    out.tables.push({ title: 'Inputs used', cols: ['Quantity', 'Value', 'Source'], rows: [['History source', srcLabel + (rescaled ? ' (stress levels mapped to the σ_L/σ_H inputs)' : ''), prov], ['Peak / min nominal stress [MPa]', `${fmt(sMaxNom, 4)} / ${fmt(sMinNom, 4)}`, prov], ['Transformation strain swing [%]', 100 * epsTr, prov], ['Alloy', mat.name, 'library'], ['Fatigue law', JSON.stringify(mat.fatigue || {}), 'library (literature trend)'], ['K_f grip / edge', `${fmt(Kf, 3)} / ${fmt(KfEdge, 3)}`, 'calc'], ['Ribbons', `${nC} cells × ${nR}`, 'calc']], explain: 'Provenance of every input to the life calculation.' });
    // ---- narrative
    out.explain.push(
      { title: 'Load history', text: `The ${srcLabel} gives a stress cycle between ${fmt(sMinNom, 4)} and ${fmt(sMaxNom, 4)} MPa with a ${fmt(100 * epsTr, 3)} % transformation-strain swing. At the grip edge the stress is amplified by K_f = ${fmt(KfEdge, 3)}.` },
      { title: 'Which mechanism limits life', text: `Functional fatigue at the grip gives ${fmt(NfGrip, 3)} cycles (free length ${fmt(NfFree, 3)}); elastic structural fatigue ${fmt(Nstruct, 3)}; ratcheting ${fmt(Nratch, 3)}; crack growth ${Number.isFinite(Ncrack) ? fmt(Ncrack, 3) : 'none (below threshold)'}. The governing mode is “${gov[0]}”.` },
      { title: 'Population effect', text: `With ${nTot} ribbons the first failure is expected after ${fmt(sysFirst50, 3)} cycles (median), versus ${fmt(P50, 3)} for one ribbon. Tolerating ${m} broken ribbons per cell lifts the engine median to ${fmt(sysRed50, 3)} cycles.` },
    );
    // ---- recommendations
    const aExp = mat.fatigue?.a || 3;
    if (lifeMed < p.lifeTarget) out.recs.push({ level: 'critical', text: `Median life ${fmt(lifeMed, 3)} cycles is ${fmt(p.lifeTarget / lifeMed, 3)}× short of the ${fmt(p.lifeTarget, 3)}-cycle target. Reducing the transformation strain from ${fmt(100 * epsTr, 3)} % to ${fmt(100 * epsTr * (lifeMed / p.lifeTarget) ** (1 / aExp), 3)} % would meet it (work per cycle falls roughly in proportion — re-optimise in Suite 17).`, basis: `Functional fatigue law exponent a = ${aExp}` });
    else out.recs.push({ level: 'good', text: `Median life ${fmt(lifeMed, 3)} cycles meets the ${fmt(p.lifeTarget, 3)}-cycle target; P10 = ${fmt(P10, 3)}.`, basis: 'Weibull life distribution' });
    if (NfGrip < 0.7 * NfFree) out.recs.push({ level: 'warn', text: `The grips cost ${fmt(100 * (1 - NfGrip / NfFree), 3)} % of the ribbon life (K_f,edge = ${fmt(KfEdge, 3)}). A bonded/tapered grip with K_t ≈ 1.3 and polished slit edges would recover most of it at no loss of work.`, basis: 'Damage map' });
    out.recs.push({ level: 'info', text: `Inspect every ${fmt(inspectInterval, 3)} cycles (${fmt(inspectInterval / p.freq / 3600, 3)} h): measure stroke at the bias stress, residual set, and examine the grip corners. Replace a cartridge when more than ${m} of ${nR} ribbons have failed.`, basis: insp[0] });
    out.recs.push({ level: 'econ', text: `Over ${p.dutyHours} h/yr the median engine life is ${fmt(sysRed50 / (p.freq * 3600 * p.dutyHours), 3)} years; ribbon replacement every ${fmt(lifeAt(Rsys, p.Rtarget) / (p.freq * 3600 * p.dutyHours), 3)} years at R = ${p.Rtarget} is the main maintenance cost driver for Suite 22.`, basis: 'Redundant-system Weibull life' });
    out.recs.push({ level: 'sustain', text: `Each cartridge replacement scraps ${fmt(nR * d.ribbonL * Wd * t * mat.rho * 1000, 3)} g of ${mat.name.split('(')[0].trim()} per cell (≈ ${fmt(mat.co2 || 0, 3)} kg CO₂e/kg embodied). Design grips for ribbon-only replacement and return failed ribbons for remelting (recyclable fraction ${fmt(100 * (mat.recyclable || 0), 2)} %).`, basis: 'Materials library' });
    out.recs.push({ level: 'warn', text: 'All lives use library-trend constants; before any durability claim, run functional-fatigue tests (stroke vs cycles) and S–N tests at the operating stress/strain/temperature, then calibrate N₀, a, b here.', basis: 'Master spec §31, §40 (fatigue may preclude high work density)' });
    out.views.push({ label: '2D animation: stress cycle and damage hot spots on the ribbon', icon: '🎞', render: (el) => anim2d(el, { duration: H.t[H.t.length - 1], rate: Math.min(1, 0.5 * p.freq), label: 'cycle time', unit: 's', height: 400, explain: 'Top: nominal and grip-edge stress over the cycle. Bottom: the ribbon in plan view, coloured by the instantaneous local stress (K_t field × nominal stress); clamp lines at both ends. The brightest corners are the damage hot spots of the damage map.', draw(g, tt, W2, H2) {
      seriesPanel(g, { x: 8, y: 6, w: W2 - 16, h: H2 * 0.45, T: H.t, t: tt, title: 'Stress', unit: 'MPa', series: [{ name: 'nominal', y: H.s, color: '#38bdf8' }, { name: 'grip edge', y: sGrip, color: '#ef4444' }] });
      const k = at(H.t, tt), sNow = lerp(H.s, k), x0 = 30, y0 = H2 * 0.55, w = W2 - 60, hh = Math.min(H2 * 0.3, w * Wd / L * 6), nxv = 120, nyv = 12, smax = KfEdge * sMaxNom * 1.05 || 1;
      for (let i = 0; i < nxv; i++) for (let j = 0; j < nyv; j++) { const x = (i + 0.5) / nxv * L, y = (j + 0.5) / nyv * Wd, sl = (1 + p.qNotch * (KtAt(x, y) - 1)) * sNow, c = clamp(sl / smax, 0, 1); g.fillStyle = `rgb(${Math.round(30 + 225 * c)},${Math.round(40 + 120 * c * (1 - c) * 4 * 0.5)},${Math.round(120 * (1 - c))})`; g.fillRect(x0 + i * w / nxv, y0 + j * hh / nyv, w / nxv + 0.5, hh / nyv + 0.5); }
      g.fillStyle = '#9ca3af'; g.fillRect(x0 - 12, y0 - 6, 12, hh + 12); g.fillRect(x0 + w, y0 - 6, 12, hh + 12);
      text(g, `σ_nominal ${fmt(sNow, 4)} MPa · peak at grip edge ${fmt(KfEdge * sNow, 4)} MPa · damage/cycle ${fmt(damagePerCycle, 3)}`, x0, y0 + hh + 24);
    } }) });
    out.outputs = { life_cycles: lifeMed, life_P10: P10, life_P90: P90, damagePerCycle, inspectInterval_cycles: inspectInterval, criticalLocation, life_years: yrs, systemLife_cycles: sysRed50, firstFailure_cycles: sysFirst50, governingMode: gov[0], epsTr };
    out.headline = `Median life ${fmt(lifeMed, 3)} cycles (${fmt(yrs, 3)} yr) — governed by ${gov[0].toLowerCase()}; P10 ${fmt(P10, 3)}, inspect every ${fmt(inspectInterval, 3)} cycles`;
    out.headlineKind = lifeMed >= p.lifeTarget ? 'ok' : lifeMed >= 0.1 * p.lifeTarget ? 'warn' : 'fail';
    out.credibility = 'Analytical screening';
    return out;
  },
};
