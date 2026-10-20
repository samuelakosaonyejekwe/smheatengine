// Suite 19 — Experimental management, calibration and digital twin (master spec Module 19, §31, §33, §34; EIGDAS Module 19).
// Test-campaign register, instrument register with uncertainty classes, import of time-series (synchronisation, unit
// validation, missing-data flags), Levenberg–Marquardt calibration of the ribbon-cell transient against temperature, force
// and stroke, covariance-based confidence intervals, hold-out validation, Kalman-filter state estimation of the cell
// temperature (digital-twin update) and model-discrepancy statistics. Without imported data a SYNTHETIC dataset is
// generated from the model plus noise (provenance 'hypothetical') purely to exercise the software workflow.
import { cellTransient } from '../core/sma.js';
import { get as getMat } from '../core/materials.js';
import { levenbergMarquardt, nelderMead, goldenMin, invert, matmul, transpose, halton, metrics, mean, std, rng, range, interp1, histogram, fmt, max, min, clamp } from '../core/num.js';
import { anim2d, seriesPanel, text, theme } from '../core/anim2d.js';

const RES = { log: 0.03, K: 0.5 }; // numerical-resolution tolerance of the calibration (from synthetic recovery tests)
const OFF = 1e4; // parameter offset: the solver's relative finite-difference step becomes 0.01·scale in physical units (≈ 0.05 in log₁₀ k, 0.5 K in ΔT),
// wide enough to average the step-like response of the discretised switching/kinetics
const PARS = [
  { key: 'fitH', name: 'Fluid-side HTC multiplier', sym: 'k_h', scale: 5, span: 0.35, lo: -1, hi: 0.7, log: true, unit: '×' },
  { key: 'fitHc', name: 'Contact-conductance multiplier', sym: 'k_c', scale: 5, span: 0.45, lo: -1.3, hi: 1, log: true, unit: '×' },
  { key: 'fitShift', name: 'Transformation-temperature shift ΔT_tr (CA/CM lines)', sym: 'ΔT', scale: 50, span: 6, lo: -15, hi: 15, log: false, unit: 'K' },
  { key: 'fitLh', name: 'Latent-heat multiplier', sym: 'k_L', scale: 5, span: 0.2, lo: -0.5, hi: 0.5, log: true, unit: '×' },
];
// Representative instrument classes (EIGDAS Module 19 instrument table). Uncertainties are typical class values — NOT certificates.
const INSTRUMENTS = [
  ['DSC', 'Differential scanning calorimeter', 'Transformation heat flow & temperatures (Ms, Mf, As, Af, Lh)', '−90…550 °C', '±0.5 K, ±2 % enthalpy', 'V0'],
  ['LC', 'Load cell (strain-gauge, 2 kN)', 'Ribbon pulling force', '0–2 kN', '±0.1 % FS (±2 N)', 'force'],
  ['LVDT', 'Extensometer / LVDT', 'Contraction & reset displacement', '±10 mm', '±10 µm', 'stroke'],
  ['TC', 'Thermocouples type T / RTD Pt100', 'Ribbon, hot-fluid and cold-fluid temperatures', '−50…200 °C', 'TC ±0.5 K; RTD class A ±0.15 K', 'temperature'],
  ['FM', 'Flow meters (Coriolis / turbine)', 'Hot & cold mass flow', '0–10 L/min', '±0.5 % reading', 'flow'],
  ['PT', 'Pressure transducers (differential)', 'Fluid pressure drop', '0–2 bar', '±0.25 % FS', 'dp'],
  ['TQ', 'Torque transducer (rotary)', 'Shaft torque', '0–5 N·m', '±0.2 % FS', 'torque'],
  ['ENC', 'Rotary encoder (incremental)', 'Shaft angle & speed', '0–3000 rpm', '±0.05 % speed', 'speed'],
  ['PM', 'Power meter', 'Electrical consumption of pumps/valves/controls', '0–500 W', '±0.5 % reading', 'aux power'],
  ['DIC', 'High-speed camera / digital image correlation', 'Strain localisation, motion tracking', '±10 % strain', '±0.02 % strain', 'field'],
];
const UNC = { torque: 0.002 * 5 / 1.5, speed: 0.0005, flow: 0.005, cp: 0.003, tc: 0.5, rtd: 0.15, aux: 0.005 };

const findCol = (cols, re) => Object.keys(cols).find(k => re.test(k));
function readImported(ex) {
  const cols = ex.columns || {}, flags = [];
  const tk = findCol(cols, /^(t|time|time_?s|time_?ms|timestamp|seconds)$/i) || findCol(cols, /time/i);
  const Tk = findCol(cols, /(ribbon|sma|t_?m\b|tm\b|t_?rib|specimen).*|^temp/i) || findCol(cols, /temp|^t_?[a-z]*\s*\(?°?c/i);
  const Fk = findCol(cols, /force|load|^f(_n|_kn)?$|^f\s*\(/i), Xk = findCol(cols, /disp|stroke|ext|lvdt|^x(_m|_mm)?$|^x\s*\(/i), Tfk = findCol(cols, /fluid|t_?f\b|bath/i);
  if (!tk) return { ok: false, flags: ['No time column found (expected “time”, “t”, “time_s” …).'] };
  let t = cols[tk].map(Number); if (/ms/i.test(tk)) { t = t.map(v => v / 1000); flags.push(`Time column “${tk}” converted ms → s.`); }
  const conv = (k, kind) => {
    if (!k) return null; let y = cols[k].map(v => (v === '' || v === null ? NaN : Number(v)));
    const f = y.filter(Number.isFinite), mu = f.length ? mean(f) : NaN;
    if (kind === 'T' && (/\bK\b|kelvin/i.test(k) || mu > 200)) { y = y.map(v => v - 273.15); flags.push(`“${k}” interpreted as kelvin → °C.`); }
    if (kind === 'F' && /kn/i.test(k)) { y = y.map(v => v * 1000); flags.push(`“${k}” converted kN → N.`); }
    if (kind === 'X' && (/mm/i.test(k) || (f.length && max(f.map(Math.abs)) > 0.5))) { y = y.map(v => v / 1000); flags.push(`“${k}” interpreted as mm → m.`); }
    if (kind === 'T' && f.some(v => v < -80 || v > 400)) flags.push(`“${k}” has values outside −80…400 °C — check units/sensor.`);
    if (kind === 'F' && f.some(v => Math.abs(v) > 1e5)) flags.push(`“${k}” exceeds 100 kN — check units.`);
    return y;
  };
  return { ok: true, flags, t, T: conv(Tk, 'T'), F: conv(Fk, 'F'), X: conv(Xk, 'X'), Tf: conv(Tfk, 'T'), keys: { t: tk, T: Tk, F: Fk, X: Xk, Tf: Tfk } };
}
// Phase-fold a channel onto the common model grid (bin average, circular interpolation of empty bins)
function foldToGrid(t, y, P, nb, t0 = 0) {
  const s = new Array(nb).fill(0), c = new Array(nb).fill(0); let miss = 0;
  for (let i = 0; i < t.length; i++) { const v = y[i]; if (!Number.isFinite(v) || !Number.isFinite(t[i])) { miss++; continue; } let ph = ((t[i] - t0) % P + P) % P; const k = Math.round(ph / P * nb) % nb; /* bin centred on the model sample time */ s[k] += v; c[k]++; }
  const out = s.map((v, k) => (c[k] ? v / c[k] : NaN)), have = range(nb).filter(k => c[k]);
  let empty = 0;
  for (let k = 0; k < nb; k++) if (!c[k]) {
    empty++; if (!have.length) { out[k] = 0; continue; }
    let a = k, b = k; do { a = (a - 1 + nb) % nb; } while (!c[a]); do { b = (b + 1) % nb; } while (!c[b]);
    const da = (k - a + nb) % nb, db = (b - k + nb) % nb; out[k] = (out[a] * db + out[b] * da) / ((da + db) || 1);
  }
  return { y: out, count: c, missing: miss / Math.max(1, t.length), emptyBins: empty };
}
// periodic linear interpolation of a one-cycle history sampled at t = 0…P−dt
const perInterp = (T, Y, ph, P) => { const n = T.length; if (ph <= T[n - 1]) return interp1(T, Y, ph); const f = (ph - T[n - 1]) / (P - T[n - 1] || 1); return Y[n - 1] + (Y[0] - Y[n - 1]) * f; };
const circShift = (a, k) => a.map((_, i) => a[((i + k) % a.length + a.length) % a.length]);
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return s / Math.sqrt(sa * sb || 1); };
const demean = (a) => { const m = mean(a); return a.map(v => v - m); };
const lag1 = (e) => { const m = mean(e); let n = 0, d = 0; for (let i = 0; i < e.length; i++) { d += (e[i] - m) ** 2; if (i) n += (e[i] - m) * (e[i - 1] - m); } return n / (d || 1); };
const dw = (e) => { let n = 0, d = 0; for (let i = 0; i < e.length; i++) { d += e[i] ** 2; if (i) n += (e[i] - e[i - 1]) ** 2; } return n / (d || 1); };

export default {
  description: 'Manages the test campaign (specimen, alloy lot, fixture, calibration certificates, protocol, timestamps) and the instrument register, imports and synchronises laboratory time-series, calibrates the ribbon-cell transient model (heat-transfer coefficients, contact conductance, transformation-temperature shift, latent heat) with confidence intervals, validates on hold-out data and runs a Kalman-filter digital twin of the cell temperature. Without imported data it demonstrates the workflow on a clearly labelled synthetic dataset.',
  literature: 'shape memory alloy actuator parameter identification digital twin Kalman filter calibration experiment',
  econ: false, sustain: false,
  credibility: 'Calibrated',
  equations: [
    'Calibration objective: min_θ χ²(θ) = Σ_c Σ_k [(y_c,k − ŷ_c,k(θ)) / σ_c,k]², channels c ∈ {T_ribbon, F, x}, σ_c,k = σ_instrument/√n_k after phase averaging',
    'Levenberg–Marquardt step: (JᵀJ + λ·diag(JᵀJ))·Δθ = Jᵀr; covariance Cov(θ) ≈ max(1, s²)·(JᵀJ)⁻¹ with J from a broad central secant (step = span/4), s² = χ²/(m − p); 95 % CI θ̂ ± 1.96·√Cov_ii; σ² = σ_instrument² + σ_numerical²',
    'Model ŷ(θ): ribbon-cell transient ρc_p∂T/∂t = ∇·(k∇T) + ρL_h∂ξ/∂t + σ∂ε/∂t with h_fluid·k_h, h_contact·k_c, M_s…A_f + ΔT_tr, L_h·k_L',
    'Digital twin (Kalman): T_k+1 = T̂_m(t_k+1) + a·(T_k − T̂_m(t_k)) + b_k·Δt + w_T, b_k+1 = b_k + w_b; T̂_m calibrated model, a = exp(−Δt/τ), τ = C·(1/h + 1/h_c), C = ρc_p t/2 + C_w',
    'Innovation ν = y − Hx̂⁻, S = HP⁻Hᵀ + R; normalised innovation squared NIS = ν²/S (consistent filter: E[NIS] ≈ 1)',
    'Discrepancy statistics: bias ē, RMSE, lag-1 autocorrelation ρ₁, Durbin–Watson d = Σ(e_k − e_k−1)²/Σe_k² (white residuals: d ≈ 2)',
    'Error budget (§34): u(P)/P = √(u_τ² + u_ω²), u(Q)/Q = √(u_ṁ² + u_cp² + (u_ΔT/ΔT)²), u(η)/η = √(u(P)²/P² + u(Q)²/Q²)',
  ],
  methods: [
    'Channel synchronisation: each channel phase-folded on the cycle period onto the model time grid (bins centred on model samples, circular interpolation of empty bins); global phase alignment by circular cross-correlation of the fluid-temperature (switching) channel with the model fluid temperature, or of the ribbon temperature with the prior model when no fluid channel exists',
    'Unit validation by header tokens and value ranges (K→°C, kN→N, mm→m, ms→s); missing samples and empty bins flagged',
    'Halton pre-search → num.levenbergMarquardt on σ-normalised stacked residuals → optional Nelder–Mead polish → broad central-secant Jacobian for the covariance; the cell transient is evaluated once per parameter vector (memoised) with reduced, documented resolution (expert controls)',
    'Hold-out validation at a different hot-source temperature and frequency (synthetic) or on a second imported dataset (marked “validation”); num.metrics',
    'Two-state (temperature + unmodelled-heat bias) linear Kalman filter: the calibrated model trajectory is the prediction, deviations from it relax with the lumped time constant τ',
    'First-order (RSS) propagation of instrument-class uncertainties to net power, heat input and efficiency',
  ],
  assumptions: [
    'Synthetic data are generated from the same model class plus Gaussian noise and therefore only verify the software (identifiability, CI coverage) — they are not evidence about hardware',
    'Instrument uncertainties are typical class values until certificates are attached in the register',
    'Imported cycles are assumed periodic (steady cyclic operation) at the stated period; transients are not folded correctly',
    'Lumped-capacitance Kalman model (ribbon + wall); spatial gradients across the ribbon are absorbed in the bias state',
  ],
  ibc: {
    initial: ['Cell starts cold, fully martensitic and pre-extended at σ_L (as in Suites 05/14)', 'Kalman state initialised from the first valid temperature sample, bias 0 W/m²', 'Calibration starts from library values (θ₀ = 0)'],
    boundary: ['Hot/cold fluid temperatures switched at the duty cycle with ramp t_switch', 'Bias stress σ_L and one-way-clutch load σ_H − σ_L', 'Measured fluid temperature replaces the nominal value when an imported fluid channel exists (reported)'],
  },
  cvv: {
    calibration: ['DSC lot data for transformation temperatures and Lh (V0)', 'Instrumented heating/cooling tests for HTC and contact conductance (§31)', 'Force/stroke loops at several stresses and periods'],
    verification: ['Synthetic recovery test: true parameters inside the 95 % CI', 'χ²/dof ≈ 1 when the model class is correct', 'Kalman NIS ≈ 1 and filter error below raw sensor noise', 'Phase-folding conserves the channel mean'],
    validation: ['Hold-out experiments at untrained operating points', 'Traceable instrument calibration certificates', 'Validation ladder V0–V6 (spec §33)'],
  },
  formats: { import: ['CSV / TSV / XLSX time series (time, ribbon temperature, force, displacement, fluid temperature)', 'HDF5 exported to CSV', 'Calibration certificate index (text)'], export: ['Calibrated parameter set JSON', 'Synchronised dataset CSV', 'Test-campaign register CSV', 'Plots PNG/SVG'] },
  params: [
    { key: 'specimenId', label: 'Specimen ID', type: 'text', default: 'TX-SPEC-001', group: 'Test-campaign register', help: 'Unique specimen/cartridge identifier stored with every dataset.' },
    { key: 'alloyLot', label: 'Alloy lot / heat number', type: 'text', default: '', group: 'Test-campaign register', help: 'Supplier lot or heat number. Empty = not yet supplied (requested).' },
    { key: 'fixture', label: 'Test fixture', type: 'text', default: 'Rigid lab frame, interchangeable clamp fixtures (spec §41)', group: 'Test-campaign register' },
    { key: 'calCert', label: 'Calibration certificate IDs (comma separated)', type: 'text', default: '', group: 'Test-campaign register', help: 'Certificate numbers for load cell, LVDT, thermometry, flow meters. Empty = requested.' },
    { key: 'protocol', label: 'Test protocol', type: 'select', options: ['Isobaric thermal cycling of one cartridge (spec §41)', 'Calorimetric cartridge cycle (V2)', 'DSC characterisation (V0)', 'Isothermal tensile loading/unloading (§31)'], default: 'Isobaric thermal cycling of one cartridge (spec §41)', group: 'Test-campaign register' },
    { key: 'dataSource', label: 'Dataset', type: 'select', options: [{ value: 'auto', label: 'Imported data if present, otherwise synthetic demonstration' }, { value: 'synthetic', label: 'Synthetic demonstration only (software test)' }], default: 'auto', group: 'Dataset' },
    { key: 'alloy', label: 'Alloy', type: 'select', options: ['niti-lt', 'niti-actuator', 'niti-brinson', 'niticu', 'nitihf', 'cualni', 'cuznal'], default: 'niti-lt', group: 'Operating point', auto: (c) => { const a = c.upstream('s03')?.alloyId; return a ? { value: a, prov: 'coupled' } : { value: c.engine.alloy, prov: 'calc' }; } },
    { key: 'Th', label: 'Hot-fluid temperature', unit: '°C', type: 'number', min: 20, max: 200, step: 1, default: 70, group: 'Operating point', auto: (c) => ({ value: c.engine.Th, prov: 'calc' }) },
    { key: 'Tc', label: 'Cold-fluid temperature', unit: '°C', type: 'number', min: -20, max: 60, step: 1, default: 15, group: 'Operating point', auto: (c) => ({ value: c.engine.Tc, prov: 'calc' }) },
    { key: 'freq', label: 'Cycle frequency', unit: 'Hz', type: 'number', min: 0.05, max: 10, step: 0.05, default: 1, group: 'Operating point', auto: (c) => { const f = c.upstream('s05')?.freq_Hz; return f ? { value: f, prov: 'coupled' } : { value: c.engine.freq, prov: 'calc' }; } },
    { key: 'hHot', label: 'Prior fluid→wall HTC (hot)', unit: 'W/m²K', type: 'number', min: 100, max: 50000, step: 100, default: 4000, group: 'Operating point', auto: (c) => { const h = c.upstream('s08')?.hHot_Wm2K; return h ? { value: Math.round(h), prov: 'coupled' } : { value: c.engine.hHot, prov: 'calc' }; } },
    { key: 'hCold', label: 'Prior fluid→wall HTC (cold)', unit: 'W/m²K', type: 'number', min: 100, max: 50000, step: 100, default: 4000, group: 'Operating point', auto: (c) => { const h = c.upstream('s08')?.hCold_Wm2K; return h ? { value: Math.round(h), prov: 'coupled' } : { value: c.engine.hCold, prov: 'calc' }; } },
    { key: 'hContact', label: 'Prior contact conductance', unit: 'W/m²K', type: 'number', min: 500, max: 200000, step: 500, default: 20000, group: 'Operating point', auto: (c) => { const h = c.upstream('s08')?.hContact_Wm2K; return h ? { value: Math.round(h), prov: 'coupled' } : { value: c.engine.hContact, prov: 'calc' }; } },
    { key: 'noiseT', label: 'Temperature uncertainty (1σ)', unit: 'K', type: 'number', min: 0.05, max: 3, step: 0.05, default: 0.5, group: 'Instrument uncertainty', help: 'Type-T thermocouple class ±0.5 K; RTD class A ±0.15 K.' },
    { key: 'noiseF', label: 'Force uncertainty (1σ)', unit: 'N', type: 'number', min: 0.5, max: 50, step: 0.5, default: 4, group: 'Instrument uncertainty' },
    { key: 'noiseX', label: 'Displacement uncertainty (1σ)', unit: 'µm', type: 'number', min: 1, max: 200, step: 1, default: 15, group: 'Instrument uncertainty' },
    { key: 'fitH', label: 'Calibrate fluid-side HTC multiplier', type: 'bool', default: true, group: 'Calibration' },
    { key: 'fitHc', label: 'Calibrate contact-conductance multiplier', type: 'bool', default: false, help: 'Fluid-side and contact resistances act in series; a single test at one flow rate cannot separate them (enable with a wall thermocouple or several flow rates).', group: 'Calibration' },
    { key: 'fitShift', label: 'Calibrate transformation-temperature shift', type: 'bool', default: true, group: 'Calibration' },
    { key: 'fitLh', label: 'Calibrate latent-heat multiplier', type: 'bool', default: false, group: 'Calibration' },
    { key: 'maxIt', label: 'Maximum solver iterations', type: 'number', min: 2, max: 40, step: 1, default: 8, group: 'Calibration', expert: true, help: 'Bounds the run time (≈ p + 1 model evaluations per iteration).' },
    { key: 'preSearch', label: 'Global pre-search candidates', type: 'number', min: 0, max: 60, step: 1, default: 8, group: 'Calibration', expert: true, help: 'Halton-sequence starting points evaluated before the local solver (the objective is non-smooth at the time-step scale).' },
    { key: 'polish', label: 'Derivative-free polish iterations', type: 'number', min: 0, max: 80, step: 1, default: 0, group: 'Calibration', expert: true, help: 'Nelder–Mead refinement after Levenberg–Marquardt; 0 disables it.' },
    { key: 'useNumSigma', label: 'Include model numerical jitter in the residual weights', type: 'bool', default: true, group: 'Calibration', expert: true, help: 'Adds the measured step-to-step jitter of the discretised model (±tiny-perturbation test) in quadrature to the instrument uncertainty.' },
    { key: 'nodes', label: 'Through-thickness cells (model)', type: 'number', min: 1, max: 8, step: 1, default: 2, group: 'Calibration', expert: true },
    { key: 'spc', label: 'Time steps per cycle (model)', type: 'number', min: 60, max: 400, step: 10, default: 160, group: 'Calibration', expert: true },
    { key: 'cycles', label: 'Cycles simulated to periodic state', type: 'number', min: 2, max: 8, step: 1, default: 3, group: 'Calibration', expert: true },
    { key: 'holdDTh', label: 'Hold-out: hot-source temperature offset', unit: 'K', type: 'number', min: -20, max: 30, step: 1, default: 8, group: 'Hold-out validation' },
    { key: 'holdFreq', label: 'Hold-out: frequency factor', type: 'number', min: 0.3, max: 2, step: 0.05, default: 0.75, group: 'Hold-out validation' },
    { key: 'qBias', label: 'Twin process noise (bias random walk)', unit: 'K²/s³', type: 'number', min: 0.01, max: 1000, step: 0.01, default: 20, group: 'Digital twin', expert: true },
    { key: 'qT', label: 'Twin process noise (temperature)', unit: 'K²/s', type: 'number', min: 0.001, max: 100, step: 0.001, default: 0.5, group: 'Digital twin', expert: true },
    { key: 'trueH', label: 'Synthetic truth: HTC multiplier', type: 'number', min: 0.2, max: 3, step: 0.05, default: 0.8, group: 'Synthetic demonstration', expert: true, prov: 'hypothetical' },
    { key: 'trueHc', label: 'Synthetic truth: contact multiplier', type: 'number', min: 0.1, max: 5, step: 0.05, default: 1, group: 'Synthetic demonstration', expert: true, prov: 'hypothetical' },
    { key: 'trueShift', label: 'Synthetic truth: ΔT_tr', unit: 'K', type: 'number', min: -10, max: 10, step: 0.5, default: 2.5, group: 'Synthetic demonstration', expert: true, prov: 'hypothetical' },
    { key: 'seed', label: 'Synthetic noise seed', type: 'number', min: 1, max: 99999, step: 1, default: 1931, group: 'Synthetic demonstration', expert: true },
  ],
  presets: [
    { label: 'Thermocouple rig (±0.5 K)', values: { noiseT: 0.5, noiseF: 4, noiseX: 15 } },
    { label: 'RTD + precision load cell', values: { noiseT: 0.15, noiseF: 1, noiseX: 5 } },
    { label: 'Thermal-only calibration (HTC + contact)', values: { fitH: true, fitHc: true, fitShift: false, fitLh: false } },
    { label: 'Material calibration (ΔT_tr + Lh)', values: { fitH: false, fitHc: false, fitShift: true, fitLh: true } },
  ],

  async run(p, ctx) {
    const T0 = Date.now();
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const d = ctx.engine, mat0 = getMat(p.alloy) || getMat(d.alloy), P = 1 / p.freq, nb = Math.round(p.spc);
    const active = PARS.filter(q => p[q.key]);
    if (!active.length) active.push(PARS[0]);
    let nEval = 0;
    const sim = (theta, cond = {}) => {
      nEval++;
      const th = {}; PARS.forEach(q => th[q.key] = 0); active.forEach((q, i) => th[q.key] = theta[i] ?? 0);
      const kH = 10 ** th.fitH, kC = 10 ** th.fitHc, s = th.fitShift, kL = 10 ** th.fitLh;
      const mat = { ...mat0, Ms: mat0.Ms + s, Mf: mat0.Mf + s, As: mat0.As + s, Af: mat0.Af + s, Lh: mat0.Lh * kL };
      const period = cond.period ?? P;
      return cellTransient({ mat, t: d.ribbonT, w: d.ribbonW, L: d.ribbonL, nRib: d.ribbonsPerCell, n: Math.round(p.nodes), Th: cond.Th ?? p.Th, Tc: p.Tc, hHot: p.hHot * kH, hCold: p.hCold * kH, hc: p.hContact * kC, Cw: d.wallCapacity, period, dutyHot: d.dutyHot, tSwitch: d.tSwitch, sBias0: d.sigmaL, kBias: d.kBias, sLoad: Math.max(0, d.sigmaH - d.sigmaL), cycles: Math.round(p.cycles), stepsPerCycle: nb });
    };
    const toTheta = (truth) => active.map(q => q.key === 'fitH' ? Math.log10(truth.h) : q.key === 'fitHc' ? Math.log10(truth.hc) : q.key === 'fitShift' ? truth.shift : 0);
    const sx = p.noiseX * 1e-6;
    // ---------------- dataset: imported or synthetic ----------------
    const imported = (ctx.experiments || []).filter(e => e && e.columns && Object.keys(e.columns).length);
    const useImport = p.dataSource !== 'synthetic' && imported.length > 0;
    let raw, rawHold = null, synthetic = !useImport, flags = [], datasets = [], truthTheta = null, holdLabel = '';
    const synth = (theta, cond, seedOff, phase) => {
      const c = sim(theta, cond), R = rng(p.seed + seedOff), per = cond.period ?? P, nCyc = 3, H = c.hist;
      const chan = (dtS, off, arr, sig, dropout) => { const t = [], y = []; for (let tt = off; tt < nCyc * per; tt += dtS) { const ph = ((tt + phase * per) % per), v = perInterp(H.t, arr, ph, per); t.push(tt); y.push(R() < dropout ? NaN : v + R.normal(0, sig)); } return { t, y }; };
      const xOff = 0.0123; // arbitrary LVDT zero
      return { cell: c, per, T: chan(per / 50, 0, H.Tm, p.noiseT, 0.02), F: chan(per / 200, 0, H.F, p.noiseF, 0.01), X: chan(per / 100, 0, H.x.map(v => v + xOff), sx, 0.01), Tf: chan(per / 50, 0, H.Tf, 0.2, 0) };
    };
    if (useImport) {
      const calEx = imported.find(e => e.use !== 'validation') || imported[0], valEx = imported.find(e => e !== calEx);
      const r = readImported(calEx); flags.push(...(r.flags || []));
      if (!r.ok || !r.T) { out.verdicts.push({ test: 'Imported dataset readable', status: 'fail', detail: (r.flags || []).join(' ') || 'No ribbon-temperature column found.', fix: 'Provide columns named time, T_ribbon (°C), force (N), displacement (mm or m); optionally T_fluid.' }); synthetic = true; }
      else {
        raw = { per: P, T: { t: r.t, y: r.T }, F: r.F ? { t: r.t, y: r.F } : null, X: r.X ? { t: r.t, y: r.X } : null, Tf: r.Tf ? { t: r.t, y: r.Tf } : null, name: calEx.name, keys: r.keys };
        datasets.push({ name: calEx.name || 'imported-1', prov: 'measured', role: 'calibration', n: r.t.length, channels: Object.entries(r.keys).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`) });
        if (valEx) { const v = readImported(valEx); if (v.ok && v.T) { rawHold = { per: P, T: { t: v.t, y: v.T }, F: v.F ? { t: v.t, y: v.F } : null, X: v.X ? { t: v.t, y: v.X } : null, name: valEx.name }; flags.push(...v.flags); datasets.push({ name: valEx.name || 'imported-2', prov: 'measured', role: 'hold-out', n: v.t.length, channels: Object.entries(v.keys).filter(([, x]) => x).map(([k, x]) => `${k}:${x}`) }); holdLabel = 'second imported dataset'; } }
      }
    }
    if (synthetic) {
      truthTheta = toTheta({ h: p.trueH, hc: p.trueHc, shift: p.trueShift });
      raw = synth(truthTheta, {}, 0, 0.13); raw.name = 'SYNTHETIC calibration set';
      rawHold = synth(truthTheta, { Th: p.Th + p.holdDTh, period: P / p.holdFreq }, 7, 0.13); rawHold.name = 'SYNTHETIC hold-out set';
      holdLabel = `synthetic hold-out at T_hot = ${p.Th + p.holdDTh} °C, f = ${fmt(p.freq * p.holdFreq, 3)} Hz`;
      datasets.push({ name: raw.name, prov: 'hypothetical', role: 'calibration', n: raw.T.t.length + raw.F.t.length + raw.X.t.length, channels: ['T_ribbon @50/cycle', 'F @200/cycle', 'x @100/cycle', 'T_fluid'] }, { name: rawHold.name, prov: 'hypothetical', role: 'hold-out', n: rawHold.T.t.length + rawHold.F.t.length + rawHold.X.t.length, channels: ['T_ribbon', 'F', 'x'] });
    }
    ctx.progress(0.1, 'synchronising channels');
    // ---------------- synchronisation on the model grid ----------------
    const prior = sim(active.map(() => 0)), tg = prior.hist.t;
    const fold = (R, per) => { const fT = foldToGrid(R.T.t, R.T.y, per, nb), fF = R.F ? foldToGrid(R.F.t, R.F.y, per, nb) : null, fX = R.X ? foldToGrid(R.X.t, R.X.y, per, nb) : null; return { fT, fF, fX }; };
    const G = fold(raw, P);
    // global phase alignment against the prior model temperature (circular cross-correlation)
    // phase reference: the fluid-temperature (valve switching) channel when recorded — independent of the unknown thermal lag;
    // otherwise the ribbon temperature against the prior model (biased by any lag error, flagged)
    const refFold = raw.Tf ? foldToGrid(raw.Tf.t, raw.Tf.y, P, nb) : null, refModel = raw.Tf ? prior.hist.Tf : prior.hist.Tm, refData = refFold ? refFold.y : G.fT.y;
    const alignBy = raw.Tf ? 'fluid-temperature (switching) channel' : 'ribbon temperature vs prior model (no fluid channel — lag-biased)';
    if (!raw.Tf) flags.push('No fluid-temperature channel: phase alignment uses the ribbon temperature and is biased by any heat-transfer lag error. Record the valve/fluid switching signal.');
    const xcorr = (ref, mod) => { const cs = range(nb).map(k => corr(circShift(ref, k), mod)); const k = cs.indexOf(Math.max(...cs)); const c0 = cs[(k - 1 + nb) % nb], c1 = cs[k], c2 = cs[(k + 1) % nb], den = c0 - 2 * c1 + c2; return { k, frac: k + (Math.abs(den) > 1e-12 ? clamp(0.5 * (c0 - c2) / den, -0.5, 0.5) : 0), c: c1 }; };
    const xc = xcorr(refData, refModel), bestK = xc.k;
    const align = (g) => g && { ...g, y: circShift(g.y, bestK), count: circShift(g.count, bestK) };
    const A = { T: align(G.fT), F: align(G.fF), X: align(G.fX) };
    // continuous refinement on the raw fluid samples (prescribed switching signal, independent of the unknown parameters)
    const refine = (R, cell, per, k0) => { if (!R) return k0 / nb * per; const S = range(Math.min(R.t.length, 1200)).map(i => Math.floor(i * R.t.length / Math.min(R.t.length, 1200))).filter(i => Number.isFinite(R.y[i])); const f = (sh) => S.reduce((a, i) => a + (R.y[i] - perInterp(cell.hist.t, cell.hist.Tf, ((R.t[i] - sh) % per + per) % per, per)) ** 2, 0); return goldenMin(f, (k0 - 1) / nb * per, (k0 + 1) / nb * per, 1e-7 * per); };
    const shiftS = refine(raw.Tf, prior, P, xc.frac), phaseOf = (t, per = P, sh = shiftS) => ((t - sh) % per + per) % per;
    const meanRaw = mean(raw.T.y.filter(Number.isFinite)), meanFold = mean(A.T.y);
    // ---------------- calibration on the raw (synchronised) samples ----------------
    // residuals are evaluated at every valid sample's aligned phase (no bin interpolation across steep switching fronts)
    const pick = (R, stride = 1) => { if (!R) return null; const t = [], y = []; for (let i = 0; i < R.t.length; i += stride) if (Number.isFinite(R.y[i]) && Number.isFinite(R.t[i])) { t.push(R.t[i]); y.push(R.y[i]); } return { t, y }; };
    const cap = (R) => Math.max(1, Math.ceil((R?.t.length || 0) / 1500));
    const mk = (id, R, sgm, get, dm) => { const S = pick(R, cap(R)); if (!S || S.t.length < 5) return null; const ph = S.t.map(t => phaseOf(t)); return { id, t: S.t, ph, meas: dm ? demean(S.y) : S.y, s: sgm, get, dm }; };
    const chans = [mk('T', raw.T, p.noiseT, (c) => c.hist.Tm, false), mk('F', raw.F, p.noiseF, (c) => c.hist.F, false), mk('x', raw.X, sx, (c) => c.hist.x, true)].filter(Boolean);
    const predOf = (c, ch, phs = ch.ph, per = P) => { const arr = ch.get(c), v = phs.map(ph => perInterp(c.hist.t, arr, ph, per)); return ch.dm ? demean(v) : v; };
    // numerical (discretisation) jitter of the model: response to a ±tiny parameter perturbation that should change the output
    // negligibly; the switching/clutch logic makes it step-like. Added in quadrature to the instrument σ (model-form term).
    const dl = active.map(q => (q.log ? 0.004 : 0.02)), cA = sim(dl), cB = sim(dl.map(v => -v));
    for (const ch of chans) { const a = predOf(cA, ch), b = predOf(cB, ch); ch.sInst = ch.s; ch.sNum = Math.sqrt(mean(a.map((v, i) => (v - b[i]) ** 2)) / 2); ch.s = Math.hypot(ch.sInst, p.useNumSigma ? ch.sNum : 0); }
    const ys = chans.flatMap(c => c.meas.map(v => v / c.s)), xs = range(ys.length);
    const memo = { key: null, vec: null }; let sims = 0;
    const vecOf = (theta) => { const key = theta.join(','); if (memo.key === key) return memo.vec; const c = sim(theta); sims++; memo.key = key; memo.vec = chans.flatMap(ch => predOf(c, ch).map(v => v / ch.s)); memo.cell = c; return memo.vec; };
    const toP = (th) => th.map((v, i) => OFF + v / active[i].scale), fromP = (pp) => pp.map((v, i) => (v - OFF) * active[i].scale);
    const model = (i, pp) => vecOf(fromP(pp))[i];
    const v0 = vecOf(active.map(() => 0)), chi0 = ys.reduce((s, y, i) => s + (y - v0[i]) ** 2, 0);
    ctx.progress(0.2, 'calibrating: global pre-search');
    // low-discrepancy pre-search (the objective is non-smooth at the time-step scale) → LM from the best candidate
    const chiOf = (th) => { const v = vecOf(th); return ys.reduce((s, y, i) => s + (y - v[i]) ** 2, 0); };
    let start = active.map(() => 0), chiStart = chi0; const pre = [];
    for (const u of halton(Math.round(p.preSearch), active.length)) { const th = u.map((v, i) => (2 * v - 1) * active[i].span); const c = chiOf(th); pre.push({ th, c }); if (c < chiStart) { chiStart = c; start = th; } }
    ctx.progress(0.4, 'calibrating (Levenberg–Marquardt)');
    const bnds = active.map(q => [OFF + q.lo / q.scale, OFF + q.hi / q.scale]);
    const lm1 = levenbergMarquardt(model, xs, ys, toP(start), { maxIt: Math.round(p.maxIt), bounds: bnds, tol: 1e-6 });
    // derivative-free polish in span-normalised coordinates, then a final LM pass for the Jacobian/covariance at the optimum
    ctx.progress(0.55, 'calibrating: polish & covariance');
    const zOf = (th) => th.map((v, i) => 10 + v / (0.1 * active[i].span)), thOf = (z) => z.map((v, i) => clamp((v - 10) * 0.1 * active[i].span, active[i].lo, active[i].hi));
    const nm = p.polish > 0 ? nelderMead((z) => chiOf(thOf(z)), zOf(fromP(lm1.p)), { step: 0.1, tol: 1e-7, maxIt: Math.round(p.polish) }) : null;
    const thPol = nm && nm.f < lm1.sse ? thOf(nm.x) : fromP(lm1.p);
    const lm = nm && nm.f < lm1.sse ? { ...lm1, p: toP(thPol), sse: nm.f, it: lm1.it + nm.it } : lm1;
    const theta = fromP(lm.p), dof = Math.max(1, ys.length - active.length), chi2 = lm.sse, chi2dof = chi2 / dof;
    // covariance from a broad central-secant Jacobian (step = span/4): captures the smooth trend, not the step-like jitter
    const Jc = ys.map(() => new Float64Array(active.length));
    active.forEach((q, k) => { const hk = q.span / 4, tp = theta.slice(), tm = theta.slice(); tp[k] += hk; tm[k] -= hk; const vp = vecOf(tp), vm = vecOf(tm); for (let i = 0; i < ys.length; i++) Jc[i][k] = (vp[i] - vm[i]) / (2 * hk); });
    let covT = null; try { covT = invert(matmul(transpose(Jc), Jc)).map(r => Array.from(r).map(v => v * Math.max(1, chi2dof))); } catch { covT = null; }
    // numerical-resolution term: the model jitter is treated as fully correlated within each channel (conservative) and mapped
    // through A = (JᵀJ)⁻¹Jᵀ: Cov_num = Σ_c u_c u_cᵀ, u_c = A·(σ_num,c/σ_c)·1_c
    if (covT && p.useNumSigma) { const JTJi = invert(matmul(transpose(Jc), Jc)); let o = 0; for (const ch of chans) { const n = ch.meas.length, g = new Array(active.length).fill(0); for (let i = 0; i < n; i++) for (let k = 0; k < active.length; k++) g[k] += Jc[o + i][k] * ch.sNum / ch.s; o += n; const u = active.map((_, k) => active.reduce((a, __, j) => a + JTJi[k][j] * g[j], 0)); for (let k = 0; k < active.length; k++) for (let j = 0; j < active.length; j++) covT[k][j] += u[k] * u[j]; } }
    const se = covT ? covT.map((r, i) => Math.sqrt(Math.abs(r[i]))) : lm.se.map((v, i) => v * active[i].scale);
    const corrM = covT ? covT.map((r, i) => r.map((v, j) => v / (se[i] * se[j] || 1))) : active.map((_, i) => active.map((__, j) => (i === j ? 1 : 0)));
    const cal = sim(theta);
    try { await ctx.yield?.(); } catch { /* headless: no animation frame */ }
    ctx.progress(0.7, 'hold-out validation & digital twin');
    // ---------------- hold-out validation ----------------
    const conf = {}, calibrated = {};
    active.forEach((q, i) => {
      const half = 1.96 * se[i] + (q.log ? RES.log : RES.K), lo = theta[i] - half, hi = theta[i] + half; // statistical + numerical-resolution band
      if (q.log) { calibrated[q.key.replace('fit', 'k')] = 10 ** theta[i]; conf[q.name] = [10 ** lo, 10 ** hi]; } else { calibrated.shift_K = theta[i]; conf[q.name] = [lo, hi]; }
    });
    const kH = calibrated.kH ?? 1, kC = calibrated.kHc ?? 1, shift = calibrated.shift_K ?? 0, kL = calibrated.kLh ?? 1;
    Object.assign(calibrated, { hHot_Wm2K: p.hHot * kH, hCold_Wm2K: p.hCold * kH, hContact_Wm2K: p.hContact * kC, Ms: mat0.Ms + shift, Mf: mat0.Mf + shift, As: mat0.As + shift, Af: mat0.Af + shift, Lh: mat0.Lh * kL, alloy: p.alloy, synthetic, basis: synthetic ? 'SYNTHETIC demonstration — software test only, not for design' : 'imported measurements', specimenId: p.specimenId });
    let hold = null;
    if (rawHold) {
      const perH = rawHold.per || P, condH = synthetic ? { Th: p.Th + p.holdDTh, period: perH } : {};
      const predC = sim(theta, condH), predP = sim(active.map(() => 0), condH);
      const fT = foldToGrid(rawHold.T.t, rawHold.T.y, perH, nb), refH = rawHold.Tf ? foldToGrid(rawHold.Tf.t, rawHold.Tf.y, perH, nb).y : fT.y;
      const xh = xcorr(refH, rawHold.Tf ? predC.hist.Tf : predC.hist.Tm), shH = refine(rawHold.Tf, predC, perH, xh.frac);
      const ev = (R, get, dm) => { const S = pick(R, cap(R)); if (!S || S.t.length < 5) return null; const ph = S.t.map(t => phaseOf(t, perH, shH)), ch = { get, dm }, meas = dm ? demean(S.y) : S.y; return { meas, c: predOf(predC, ch, ph, perH), p: predOf(predP, ch, ph, perH) }; };
      hold = { label: holdLabel, predC, predP, T: ev(rawHold.T, (c) => c.hist.Tm, false), F: ev(rawHold.F, (c) => c.hist.F, false), X: ev(rawHold.X, (c) => c.hist.x, true) };
      hold.mT = metrics(hold.T.c, hold.T.meas); hold.mTp = metrics(hold.T.p, hold.T.meas);
      if (hold.F) { hold.mF = metrics(hold.F.c, hold.F.meas); hold.mFp = metrics(hold.F.p, hold.F.meas); }
      if (hold.X) { hold.mX = metrics(hold.X.c, hold.X.meas); hold.mXp = metrics(hold.X.p, hold.X.meas); }
    }
    // ---------------- residuals & discrepancy (time-ordered raw samples) ----------------
    const disc = chans.map(ch => {
      const pr = predOf(cal, ch), e = ch.meas.map((v, k) => v - pr[k]), en = e.map(v => v / ch.s);
      const hot = e.filter((_, k) => ch.ph[k] < d.dutyHot * P), cold = e.filter((_, k) => ch.ph[k] >= d.dutyHot * P);
      const m = metrics(pr, ch.meas);
      return { id: ch.id, e, en, m, bias: mean(e), rmse: Math.sqrt(mean(e.map(v => v * v))), sd: std(e), rho1: lag1(e), dw: dw(e), hotBias: mean(hot), coldBias: mean(cold), ratio: Math.sqrt(mean(en.map(v => v * v))) };
    });
    const unitOf = { T: 'K', F: 'N', x: 'm' };
    // ---------------- Kalman digital twin on raw temperature samples ----------------
    const C = mat0.rho * mat0.cp * d.ribbonT / 2 + d.wallCapacity, tau = C * (1 / (p.hHot * kH) + 1 / (p.hContact * kC));
    const kfT = raw.T.t, kfY = raw.T.y, nK = kfT.length, tw = theme;
    const H = cal.hist;
    let x0 = kfY.find(Number.isFinite) ?? p.Tc, xb = 0, P11 = p.noiseT ** 2, P12 = 0, P22 = 1;
    const est = [], sd = [], nis = [], innov = [], Rv = p.noiseT ** 2;
    for (let k = 0; k < nK; k++) {
      if (k > 0) {
        const dt = Math.max(1e-6, kfT[k] - kfT[k - 1]), a = Math.exp(-dt / tau), ph0 = phaseOf(kfT[k - 1]), ph1 = phaseOf(kfT[k]);
        const m0 = perInterp(H.t, H.Tm, ph0, P), m1 = perInterp(H.t, H.Tm, ph1, P);
        x0 = m1 + a * (x0 - m0) + xb * dt; // deviation from the calibrated model relaxes with τ; bias b integrates unmodelled heat
        const n11 = a * a * P11 + 2 * a * dt * P12 + dt * dt * P22 + p.qT * dt, n12 = a * P12 + dt * P22, n22 = P22 + p.qBias * dt;
        P11 = n11; P12 = n12; P22 = n22;
      }
      const y = kfY[k];
      if (Number.isFinite(y)) { const nu = y - x0, S = P11 + Rv, K1 = P11 / S, K2 = P12 / S; x0 += K1 * nu; xb += K2 * nu; const p11 = (1 - K1) * P11, p12 = (1 - K1) * P12, p22 = P22 - K2 * P12; P11 = p11; P12 = p12; P22 = p22; nis.push(nu * nu / S); innov.push(nu); }
      est.push(x0); sd.push(Math.sqrt(Math.max(P11, 0)));
    }
    const nisMean = mean(nis);
    let kfErr = null, rawErr = null;
    if (synthetic) { const truthT = kfT.map(t => perInterp(raw.cell.hist.t, raw.cell.hist.Tm, ((t + 0.13 * P) % P + P) % P, P)); kfErr = Math.sqrt(mean(est.map((v, i) => (v - truthT[i]) ** 2))); rawErr = Math.sqrt(mean(kfY.map((v, i) => v - truthT[i]).filter(Number.isFinite).map(v => v * v))); }
    // ---------------- uncertainty budget (§34) ----------------
    const dTf = d.fluidDT || 10, uDT = Math.SQRT2 * p.noiseT;
    const budP = [['Torque transducer', UNC.torque], ['Rotary encoder', UNC.speed]], budQ = [['Flow meter', UNC.flow], ['Fluid c_p', UNC.cp], ['Fluid ΔT (2 sensors)', uDT / dTf]];
    const uP = Math.hypot(...budP.map(b => b[1])), uQ = Math.hypot(...budQ.map(b => b[1])), uEta = Math.hypot(uP, uQ);
    // ---------------- register (stored in the project) ----------------
    const proj = ctx.store?.project; const now = new Date().toISOString();
    const entry = { t: now, specimenId: p.specimenId, alloyLot: p.alloyLot || '(requested)', fixture: p.fixture, calCert: p.calCert || '(requested)', protocol: p.protocol, dataset: raw.name, provenance: synthetic ? 'hypothetical (synthetic)' : 'measured', Th: p.Th, Tc: p.Tc, freq: p.freq, chi2dof };
    if (proj) { const reg = (proj.testCampaign ||= []); const same = reg.findIndex(r => r.specimenId === entry.specimenId && r.dataset === entry.dataset && r.protocol === entry.protocol); if (same >= 0) reg[same] = entry; else reg.push(entry); if (reg.length > 50) reg.splice(0, reg.length - 50); }
    const register = proj?.testCampaign || [entry];
    // ---------------- KPIs ----------------
    const dT = disc.find(x => x.id === 'T'), dF = disc.find(x => x.id === 'F'), dX = disc.find(x => x.id === 'x');
    const prov = synthetic ? 'hypothetical' : 'calibrated';
    const chiOK = chi2dof > 0.5 && chi2dof < 2;
    out.headline = synthetic
      ? `SYNTHETIC DEMONSTRATION (software test, not evidence): calibration recovers k_h = ${fmt(kH, 3)}, k_c = ${fmt(kC, 3)}, ΔT_tr = ${fmt(shift, 3)} K with χ²/dof = ${fmt(chi2dof, 3)}; temperature RMSE ${fmt(dT.rmse, 3)} K. Import measured data to calibrate the real cartridge.`
      : `Calibrated on “${raw.name}”: k_h = ${fmt(kH, 3)}, k_c = ${fmt(kC, 3)}, ΔT_tr = ${fmt(shift, 3)} K; χ²/dof = ${fmt(chi2dof, 3)}, temperature RMSE ${fmt(dT.rmse, 3)} K${hold ? `, hold-out RMSE ${fmt(hold.mT.rmse, 3)} K` : ''}.`;
    out.headlineKind = synthetic ? 'info' : chiOK ? 'ok' : 'warn';
    out.kpis.push({ label: 'Temperature RMSE (calibration)', value: dT.rmse, unit: 'K', prov, explain: 'Root-mean-square difference between the phase-averaged ribbon temperature and the calibrated model. Compare with the sensor uncertainty: a value near the averaged sensor noise means the model explains the data.', status: dT.ratio < 2 ? 'ok' : 'warn' });
    if (dF) out.kpis.push({ label: 'Force RMSE (calibration)', value: dF.rmse, unit: 'N', prov, explain: 'RMS force mismatch over the cycle after calibration (load-cell channel).', status: dF.ratio < 2 ? 'ok' : 'warn' });
    if (dX) out.kpis.push({ label: 'Stroke RMSE (calibration)', value: dX.rmse * 1e6, unit: 'µm', prov, explain: 'RMS displacement mismatch (LVDT zero removed: both signals are compared about their mean).', status: dX.ratio < 2 ? 'ok' : 'warn' });
    out.kpis.push({ label: 'χ² per degree of freedom', value: chi2dof, unit: '', prov: 'calc', explain: 'Sum of squared, uncertainty-normalised residuals divided by the degrees of freedom. ≈ 1: residuals consistent with the stated instrument uncertainty; ≫ 1: model discrepancy or underestimated uncertainty; ≪ 1: uncertainty overstated.', status: chiOK ? 'ok' : 'warn' });
    active.forEach((q, i) => { const v = q.log ? 10 ** theta[i] : theta[i], ci = conf[q.name]; out.kpis.push({ label: q.name, value: v, unit: q.unit, prov, explain: `Calibrated value with 95 % confidence interval ${fmt(ci[0], 3)} … ${fmt(ci[1], 3)} ${q.unit} from the Jacobian covariance (library prior = ${q.log ? 1 : 0}).${synthetic ? ` Synthetic truth used to generate the data: ${q.key === 'fitH' ? p.trueH : q.key === 'fitHc' ? p.trueHc : q.key === 'fitShift' ? p.trueShift : 1}.` : ''}`, status: 'ok' }); });
    if (hold) out.kpis.push({ label: 'Hold-out temperature RMSE', value: hold.mT.rmse, unit: 'K', prov, explain: `Prediction error on data NOT used for calibration (${hold.label}); prior model gave ${fmt(hold.mTp.rmse, 3)} K. This is the honest measure of predictive skill.`, status: hold.mT.rmse <= hold.mTp.rmse * 1.05 ? 'ok' : 'warn' });
    out.kpis.push({ label: 'Twin consistency (mean NIS)', value: nisMean, unit: '', prov: 'calc', explain: 'Mean normalised innovation squared of the Kalman-filter digital twin; ≈ 1 means the filter’s predicted uncertainty matches the actual innovations.', status: nisMean > 0.3 && nisMean < 3 ? 'ok' : 'warn' });
    out.kpis.push({ label: 'Efficiency measurement uncertainty u(η)/η', value: uEta * 100, unit: '%', prov: 'estimated', explain: `Relative standard uncertainty of a measured efficiency from torque, speed, flow, c_p and fluid ΔT (${dTf} K) with the stated instrument classes (spec §34). Dominated by the fluid ΔT term (${fmt(uDT / dTf * 100, 3)} %).`, status: uEta < 0.1 ? 'ok' : 'warn' });
    out.kpis.push({ label: 'Model evaluations / run time', value: nEval, unit: `runs · ${Date.now() - T0} ms`, prov: 'calc', explain: `${sims} memoised cell-transient evaluations in the calibration (${lm.it} solver iterations) plus prior, hold-out and synthetic runs.` });
    // ---------------- verdicts ----------------
    if (synthetic) out.verdicts.push({ test: 'Evidence status of this run', status: 'info', detail: 'No imported measurements: every dataset shown is SYNTHETIC (model + noise, provenance hypothetical). It verifies the software workflow (synchronisation, identifiability, CI coverage, twin) and is never evidence about hardware.', fix: 'Import a cartridge test (time, ribbon temperature, force, displacement, fluid temperature) in Import mode; measure DSC (Ms, Mf, As, Af, Lh) of the alloy lot and instrumented heating/cooling of the ribbon (§31).' });
    out.verdicts.push({ test: 'Residuals consistent with instrument uncertainty (0.5 < χ²/dof < 2)', status: chiOK ? 'pass' : 'warn', detail: `χ²/dof = ${fmt(chi2dof, 3)} (initial ${fmt(chi0 / dof, 3)}).`, fix: chi2dof >= 2 ? 'Add the missing physics (e.g. calibrate L_h or the contact conductance), check sensor placement/lag, or revise the stated uncertainties to certificate values.' : 'Instrument uncertainty appears overstated; use certificate values.' });
    const iH = active.findIndex(q => q.key === 'fitH'), iC = active.findIndex(q => q.key === 'fitHc'), rhoHC = iH >= 0 && iC >= 0 ? corrM[iH][iC] : null;
    const maxRho = active.length > 1 ? Math.max(...corrM.flatMap((r, i) => r.filter((_, j) => j !== i).map(Math.abs))) : 0;
    const wide = active.filter((q, i) => (q.log ? se[i] > 0.15 : se[i] > 3));
    out.verdicts.push({ test: 'Parameters identifiable (narrow confidence intervals)', status: wide.length ? 'warn' : 'pass', detail: wide.length ? `Wide CI for: ${wide.map(q => q.name).join(', ')}. Largest parameter correlation |ρ| = ${fmt(maxRho, 3)}${rhoHC !== null ? `; fluid-side HTC and contact conductance (ρ = ${fmt(rhoHC, 3)}) act in series and one test cannot separate them` : ''}.` : 'All calibrated parameters have narrow 95 % intervals.', fix: 'Add a wall/contact thermocouple or vary the flow rate between tests so the two series resistances can be separated.' });
    if (hold) out.verdicts.push({ test: 'Hold-out prediction improves on the uncalibrated model', status: hold.mT.rmse <= hold.mTp.rmse * 1.05 ? 'pass' : 'warn', detail: `Hold-out T RMSE ${fmt(hold.mT.rmse, 3)} K vs prior ${fmt(hold.mTp.rmse, 3)} K${hold.mF ? `; force ${fmt(hold.mF.rmse, 3)} N vs ${fmt(hold.mFp.rmse, 3)} N` : ''}.`, fix: 'Calibration does not transfer to the new operating point — calibrate over several source temperatures and periods simultaneously.' });
    else out.verdicts.push({ test: 'Hold-out validation available', status: 'info', detail: 'Only one imported dataset — no independent validation.', fix: 'Import a second test at a different source temperature or period and mark it “validation”.' });
    out.verdicts.push({ test: 'Calibration certificates registered', status: p.calCert ? 'pass' : 'info', detail: p.calCert ? `Certificates: ${p.calCert}.` : 'No certificate IDs in the register — uncertainties are instrument-class values.', fix: 'Record load-cell, LVDT, thermometry and flow-meter certificate numbers and due dates.' });
    out.verdicts.push({ test: 'Alloy lot recorded', status: p.alloyLot ? 'pass' : 'info', detail: p.alloyLot ? `Lot ${p.alloyLot}.` : 'No alloy lot / heat number recorded; transformation temperatures are library values.', fix: 'Record the supplier lot and attach a DSC thermogram of a coupon from the same lot (V0).' });
    const missAll = [G.fT, G.fF, G.fX].filter(Boolean).map(g => g.missing), missMax = missAll.length ? Math.max(...missAll) : 0;
    out.verdicts.push({ test: 'Missing-data level below 5 %', status: missMax < 0.05 ? (missMax > 0 ? 'info' : 'pass') : 'warn', detail: `Largest channel missing fraction ${fmt(missMax * 100, 3)} % (blank/NaN samples flagged and excluded; empty phase bins interpolated for display only).`, fix: 'Check DAQ buffer overruns, sensor dropouts and cable connections; repeat the test if gaps coincide with the switching events.' });
    if (flags.length) out.verdicts.push({ test: 'Unit validation of imported channels', status: 'warn', detail: flags.join(' '), fix: 'Confirm the conversions or rename columns with explicit units.' });
    const ok = (name, pass, value, target, detail) => out.checks.push({ name, pass, value, target, detail });
    // ---------------- checks ----------------
    ok('Calibration reduced χ²', chi2 <= chi0 + 1e-9, chi2, `≤ ${fmt(chi0, 4)}`, 'Levenberg–Marquardt must not increase the objective.');
    ok('Phase folding conserves the temperature mean', Math.abs(meanFold - meanRaw) < 0.5 + 3 * p.noiseT / Math.sqrt(nb), meanFold - meanRaw, '|Δ| small', 'Mean of folded vs raw channel (K).');
    if (synthetic) active.forEach((q, i) => { const z = Math.abs(theta[i] - truthTheta[i]) / Math.max(se[i], 1e-9); ok(`Synthetic truth recovered: ${q.sym}`, z < 3 || Math.abs(theta[i] - truthTheta[i]) < (q.log ? RES.log : RES.K), Math.abs(theta[i] - truthTheta[i]), `< 3σ or < ${q.log ? RES.log + ' in log₁₀' : RES.K + ' K'}`, `Estimate ${fmt(theta[i], 4)} vs truth ${fmt(truthTheta[i], 4)} (${q.log ? 'log₁₀' : 'K'}), statistical σ = ${fmt(se[i], 3)} (${fmt(z, 3)} σ). The discretised switching/clutch logic makes the objective step-like, so recovery is limited by numerical resolution (tolerance ${q.log ? '±' + RES.log + ' log₁₀ ≈ ±' + fmt((10 ** RES.log - 1) * 100, 2) + ' %' : '±' + RES.K + ' K'}) rather than by noise.`); });
    if (synthetic) ok('Twin estimate error comparable to or below raw sensor error', kfErr < 1.5 * rawErr, kfErr, `< 1.5 × ${fmt(rawErr, 3)} K`, 'RMS error of the Kalman estimate vs synthetic truth compared with the raw noisy channel; the twin also bridges dropouts.');
    ok('Kalman filter consistent (0.3 < mean NIS < 3)', nisMean > 0.3 && nisMean < 3, nisMean, '≈ 1');
    ok('Calibrated model respects Carnot', cal.eta <= cal.etaCarnot + 1e-9, cal.eta, `≤ ${fmt(cal.etaCarnot, 4)}`);
    ok('Calibrated simulation energy residual < 3 %', Math.abs(cal.energyResidual) < 0.03, cal.energyResidual, '< 0.03', 'First-law closure of the last cycle.');
    ok('Run time within budget', Date.now() - T0 < 4000, Date.now() - T0, '< 4000 ms');
    // ---------------- charts ----------------
    const tP = tg.map(t => t / P);
    out.charts.push({ title: 'Ribbon temperature: data vs prior and calibrated model', x: { label: 'Cycle phase t/P', unit: '' }, y: { label: 'Temperature', unit: '°C' }, wide: true, series: [{ name: synthetic ? 'Synthetic data (phase-averaged)' : 'Measured (phase-averaged)', x: tP, y: A.T.y, mode: 'markers' }, { name: 'Prior (library)', x: tP, y: prior.hist.Tm, dash: true }, { name: 'Calibrated model', x: tP, y: cal.hist.Tm }, { name: 'Fluid temperature (model)', x: tP, y: cal.hist.Tf, dash: true }], explain: 'Markers: data folded onto one cycle and aligned in phase; dashed: model with library parameters; solid: calibrated model. A good calibration follows the heating and cooling slopes and the latent-heat shoulders.' });
    if (A.F) out.charts.push({ title: 'Force and stroke: data vs calibrated model', x: { label: 'Cycle phase t/P', unit: '' }, y: { label: 'Force', unit: 'N' }, series: [{ name: 'Force data', x: tP, y: A.F.y, mode: 'markers' }, { name: 'Force prior', x: tP, y: prior.hist.F, dash: true }, { name: 'Force calibrated', x: tP, y: cal.hist.F }], explain: 'Load-cell force over one cycle. The rise during the hot phase is the recovery stress against the clutch load; the timing of the rise identifies the transformation-temperature shift.' });
    if (A.X) out.charts.push({ title: 'Contraction displacement (zero removed)', x: { label: 'Cycle phase t/P', unit: '' }, y: { label: 'Displacement', unit: 'mm' }, series: [{ name: 'LVDT data', x: tP, y: demean(A.X.y).map(v => v * 1e3), mode: 'markers' }, { name: 'Prior', x: tP, y: demean(prior.hist.x).map(v => v * 1e3), dash: true }, { name: 'Calibrated', x: tP, y: demean(cal.hist.x).map(v => v * 1e3) }], explain: 'Stroke over one cycle about its mean (the LVDT zero is arbitrary). Amplitude reflects transformation completeness; phase reflects heat-transfer speed.' });
    const hEdges = histogram(dT.en, 16, -4, 4);
    out.charts.push({ type: 'bar', title: 'Normalised residual distribution (temperature)', categories: hEdges.centers.map(c => fmt(c, 2)), series: [{ name: 'Count', values: hEdges.counts }, { name: 'Ideal N(0,1)', values: hEdges.centers.map(c => dT.en.length * 0.5 * Math.exp(-c * c / 2) / Math.sqrt(2 * Math.PI)) }], explain: 'Residuals divided by their uncertainty. If the model is adequate and the uncertainty right, the histogram matches the standard normal; skew or extra width indicates model discrepancy.' });
    out.charts.push({ type: 'heatmap', title: 'Parameter correlation matrix', x: { label: 'Parameter', values: active.map((_, i) => i + 1) }, y: { label: 'Parameter', values: active.map((_, i) => i + 1) }, z: corrM, cmap: 'coolwarm', zlabel: 'ρ', zmin: -1, zmax: 1, explain: `Correlation of calibrated parameters from the covariance matrix (1 = ${active.map((q, i) => `${i + 1}: ${q.sym}`).join(', ')}). |ρ| near 1 means two parameters trade off and cannot be identified separately from this test.` });
    const step = Math.max(1, Math.floor(nK / 400)), ki = range(Math.ceil(nK / step)).map(i => i * step);
    out.charts.push({ title: 'Digital twin: Kalman estimate of cell temperature', x: { label: 'Time', unit: 's' }, y: { label: 'Temperature', unit: '°C' }, wide: true, series: [{ name: synthetic ? 'Synthetic sensor' : 'Sensor', x: ki.map(i => kfT[i]), y: ki.map(i => kfY[i]).map(v => Number.isFinite(v) ? v : null), mode: 'markers' }, { name: 'Twin estimate ±2σ', x: ki.map(i => kfT[i]), y: ki.map(i => est[i]), band: { lo: ki.map(i => est[i] - 2 * sd[i]), hi: ki.map(i => est[i] + 2 * sd[i]) } }], explain: 'The twin propagates a lumped cell model driven by the calibrated fluid temperature and phase change, and corrects it with each sensor reading. The band is the filter’s 95 % uncertainty; missing samples (dropouts) are bridged by prediction.' });
    if (hold) out.charts.push({ type: 'scatter', title: 'Hold-out parity: predicted vs observed temperature', x: { label: 'Observed', unit: '°C' }, y: { label: 'Predicted', unit: '°C' }, series: [{ name: 'Calibrated', x: hold.T.meas, y: hold.T.c, mode: 'markers' }, { name: 'Prior', x: hold.T.meas, y: hold.T.p, mode: 'markers' }, { name: 'Ideal y = x', x: [min(hold.T.meas), max(hold.T.meas)], y: [min(hold.T.meas), max(hold.T.meas)] }], explain: `Points on the diagonal are perfect predictions on data not used for fitting (${hold.label}). Calibrated points should cluster closer to the line than prior points.` });
    out.charts.push({ type: 'bar', horizontal: true, title: 'Measurement uncertainty budget (spec §34)', categories: [...budP.map(b => 'P: ' + b[0]), ...budQ.map(b => 'Q: ' + b[0]), 'η combined'], series: [{ name: 'Relative standard uncertainty (%)', values: [...budP.map(b => b[1] * 100), ...budQ.map(b => b[1] * 100), uEta * 100] }], explain: 'Contributions to the relative uncertainty of shaft power (torque × speed), heat input (ṁ·c_p·ΔT) and efficiency. The fluid ΔT term dominates at small temperature drops — use matched RTD pairs or a larger ΔT for calorimetry.' });
    // ---------------- tables ----------------
    out.tables.push({ title: 'Calibrated parameters with 95 % confidence intervals', cols: ['Parameter', 'Prior', 'Calibrated', '95 % CI', 'σ (scaled)', synthetic ? 'Synthetic truth' : 'Provenance'], rows: active.map((q, i) => [q.name, q.log ? '1' : '0', fmt(q.log ? 10 ** theta[i] : theta[i], 4) + ' ' + q.unit, `${fmt(conf[q.name][0], 3)} … ${fmt(conf[q.name][1], 3)}`, fmt(se[i], 3), synthetic ? String(q.key === 'fitH' ? p.trueH : q.key === 'fitHc' ? p.trueHc : q.key === 'fitShift' ? p.trueShift : 1) : 'calibrated']), explain: `Log-parameters are reported as multipliers on the prior. The 95 % interval is the linearised statistical interval 1.96·σ widened by the numerical-resolution band of the calibration (±${RES.log} in log₁₀, ±${RES.K} K), established by synthetic recovery tests: the discretised switching and clutch logic make the objective step-like at finer scales.` });
    out.tables.push({ title: 'Model-discrepancy statistics (calibration set)', cols: ['Channel', 'Bias', 'RMSE', 'σ residual', 'Hot-phase bias', 'Cold-phase bias', 'Lag-1 ρ', 'Durbin–Watson', 'RMSE/σ'], rows: disc.map(x => [x.id, fmt(x.bias, 3) + ' ' + unitOf[x.id], fmt(x.rmse, 3), fmt(x.sd, 3), fmt(x.hotBias, 3), fmt(x.coldBias, 3), fmt(x.rho1, 3), fmt(x.dw, 3), fmt(x.ratio, 3)]), explain: 'Structured residuals (lag-1 ρ ≫ 0, Durbin–Watson ≪ 2, different hot/cold bias) indicate systematic model discrepancy rather than sensor noise.' });
    if (hold) out.tables.push({ title: `Hold-out validation metrics (${hold.label})`, cols: ['Channel', 'Model', 'Bias', 'RMSE', 'NRMSE', 'R²'], rows: [['T', 'calibrated', ...[hold.mT.bias, hold.mT.rmse, hold.mT.nrmse, hold.mT.r2].map(v => fmt(v, 3))], ['T', 'prior', ...[hold.mTp.bias, hold.mTp.rmse, hold.mTp.nrmse, hold.mTp.r2].map(v => fmt(v, 3))], ...(hold.mF ? [['F', 'calibrated', ...[hold.mF.bias, hold.mF.rmse, hold.mF.nrmse, hold.mF.r2].map(v => fmt(v, 3))], ['F', 'prior', ...[hold.mFp.bias, hold.mFp.rmse, hold.mFp.nrmse, hold.mFp.r2].map(v => fmt(v, 3))]] : []), ...(hold.mX ? [['x', 'calibrated', ...[hold.mX.bias, hold.mX.rmse, hold.mX.nrmse, hold.mX.r2].map(v => fmt(v, 3))]] : [])], explain: 'Metrics from num.metrics on data excluded from calibration.' });
    const certs = (p.calCert || '').split(',').map(s => s.trim()).filter(Boolean);
    out.tables.push({ title: 'Instrument register (EIGDAS Module 19)', cols: ['Tag', 'Instrument', 'Quantity', 'Range', 'Typical uncertainty (class, not certificate)', 'Calibration certificate', 'Used in this run'], rows: INSTRUMENTS.map((r, i) => [r[0], r[1], r[2], r[3], r[4], certs[i] || 'requested', ['force', 'stroke', 'temperature'].includes(r[5]) ? (synthetic ? 'simulated channel' : 'yes') : 'no']), explain: 'Instrument classes required for a complete cartridge experiment. Uncertainties are representative class values until certificates are attached.' });
    out.tables.push({ title: 'Test-campaign register (stored in the project)', cols: ['Timestamp', 'Specimen', 'Alloy lot', 'Fixture', 'Certificates', 'Protocol', 'Dataset', 'Provenance', 'χ²/dof'], rows: register.slice(-12).map(r => [r.t.replace('T', ' ').slice(0, 19), r.specimenId, r.alloyLot, r.fixture, r.calCert, r.protocol, r.dataset, r.provenance, fmt(r.chi2dof, 3)]), explain: 'Every run records specimen, lot, fixture, certificates, protocol, dataset, provenance and timestamp so measured efficiency can always be distinguished from calculation or calibrated prediction.' });
    out.tables.push({ title: 'Channel synchronisation & data quality', cols: ['Channel', 'Samples', 'Missing', 'Empty bins', 'Phase alignment'], rows: [['Ribbon temperature', raw.T.t.length, fmt(G.fT.missing * 100, 3) + ' %', G.fT.emptyBins, fmt(shiftS * 1000, 3) + ' ms by ' + alignBy], ...(G.fF ? [['Force', raw.F.t.length, fmt(G.fF.missing * 100, 3) + ' %', G.fF.emptyBins, 'common']] : []), ...(G.fX ? [['Displacement', raw.X.t.length, fmt(G.fX.missing * 100, 3) + ' %', G.fX.emptyBins, 'common']] : [])], explain: `Channels sampled at different rates/offsets are folded onto ${nb} common phase bins; missing samples (NaN/blank) are flagged and excluded; empty bins are interpolated.` });
    const s03 = ctx.upstreamMeta?.('s03'), s03exp = (ctx.store?.project?.experiments?.s03 || []).length;
    const ladder = [
      ['V0', 'Material coupon & DSC characterisation', 'Measured phase temperatures, stress–strain loops, uncertainty-backed property model', s03exp ? 'imported data present (review)' : 'open — library values only'],
      ['V1', 'Single ribbon + force/displacement/temperature', 'Repeatable gross contraction and lower-work reset', synthetic ? 'open — synthetic demonstration only' : 'measured data imported — under review'],
      ['V2', 'Single cartridge with calorimetry', 'Positive NET closed-cycle work after reset and parasitics', 'open'],
      ['V3', '≥ 6 independently phased cartridges', 'Continuous shaft rotation, measured positive average power', 'open'],
      ['V4', 'Regenerator integration', 'Measured net-efficiency gain at matched boundary conditions', 'open'],
      ['V5', 'Endurance & off-design', 'Durability and safe operation under the fault matrix', 'open'],
      ['V6', 'Independent benchmark', 'Matched-condition improvement with confidence intervals', 'open'],
    ];
    out.tables.push({ title: 'Experimental validation ladder (spec §33)', cols: ['Gate', 'Hardware / evidence', 'Pass criterion', 'Status in this project'], rows: ladder, explain: `Status is derived from evidence actually present in the project${s03 ? ` (Suite 03 credibility: ${s03.credibility})` : ''}. No gate is passed by simulation or synthetic data.` });
    // ---------------- explanation & recommendations ----------------
    out.explain.push({ title: 'What this suite did', text: `${synthetic ? 'Because no measurements were imported, a SYNTHETIC dataset was generated by running the cell model with hypothetical “true” parameters and adding Gaussian sensor noise (σ_T = ' + p.noiseT + ' K, σ_F = ' + p.noiseF + ' N, σ_x = ' + p.noiseX + ' µm), separate sampling rates per channel, clock offsets, a phase offset and random dropouts. ' : `The imported dataset “${raw.name}” was read, unit-checked and `}The channels were folded onto one cycle (${nb} bins), aligned by cross-correlation (shift ${fmt(shiftS * 1000, 3)} ms) and used to calibrate ${active.length} model parameters by Levenberg–Marquardt (${lm.it} iterations, ${sims} model runs).` });
    out.explain.push({ title: 'How to read the confidence intervals', text: `The 95 % intervals are local (linearised) and assume the model structure is right. χ²/dof = ${fmt(chi2dof, 3)}${chiOK ? ' indicates residuals consistent with the stated noise' : ' signals discrepancy or wrong uncertainty'}. ${rhoHC !== null ? `The fluid-side and contact resistances act in series, so their estimates are correlated (ρ ≈ ${fmt(rhoHC, 2)}); only their series sum is well determined by a single test.` : `Largest parameter correlation |ρ| = ${fmt(maxRho, 2)}. The contact conductance is held at its prior because fluid-side and contact resistances act in series and cannot be separated by one test.`} The intervals include a numerical-resolution band (±${RES.log} log₁₀, ±${RES.K} K).` });
    out.explain.push({ title: 'Digital twin', text: `A two-state Kalman filter (temperature + unmodelled-heat bias) with τ = ${fmt(tau * 1000, 3)} ms runs on the raw temperature stream. Mean NIS ${fmt(nisMean, 3)}.${synthetic ? ` Against the synthetic truth, the twin error is ${fmt(kfErr, 3)} K vs ${fmt(rawErr, 3)} K for the raw sensor.` : ''} The twin updates state estimates without overwriting the original measurements (EIGDAS rule).` });
    out.explain.push({ title: 'Where the data come from', text: 'Open the Experimental Laboratory (#/lab) to design, instrument and run experiments; recorded datasets imported into this suite (Import mode) replace the synthetic demonstration automatically.' });
    if (synthetic) out.recs.push({ level: 'critical', text: 'All calibrated values in this run come from synthetic data and must not be used as calibrated design inputs. Import a measured single-cartridge test (spec §41) to obtain real parameters.', basis: 'Provenance hypothetical' });
    out.recs.push({ level: wide.length ? 'warn' : 'good', text: wide.length ? `Separate the fluid-side and contact resistances: add a wall thermocouple or run two flow rates; the largest parameter correlation is |ρ| = ${fmt(maxRho, 2)}.` : 'Calibrated parameters are well identified; extend to multiple source temperatures to test transferability.', basis: `CI widths σ = ${se.map(v => fmt(v, 2)).join(', ')}` });
    out.recs.push({ level: uEta > 0.05 ? 'warn' : 'info', text: `Calorimetric efficiency will carry ±${fmt(uEta * 100, 2)} % (1σ relative). The fluid ΔT of ${dTf} K with ${p.noiseT} K sensors contributes ${fmt(uDT / dTf * 100, 2)} %: use matched RTD pairs (±0.15 K) or a larger ΔT before claiming efficiency gains.`, basis: 'Spec §34 error budget' });
    if (hold) out.recs.push({ level: hold.mT.rmse < hold.mTp.rmse ? 'good' : 'warn', text: `Hold-out temperature RMSE ${fmt(hold.mT.rmse, 3)} K (prior ${fmt(hold.mTp.rmse, 3)} K): ${hold.mT.rmse < hold.mTp.rmse ? 'the calibration transfers to a new operating point.' : 'calibration does not transfer — calibrate on several conditions jointly.'}`, basis: hold.label });
    out.recs.push({ level: 'info', text: `Record the alloy lot${p.alloyLot ? '' : ' (missing)'} and calibration certificates${p.calCert ? '' : ' (missing)'}; run DSC on a coupon from the same lot to close validation gate V0 before using calibrated transformation temperatures (ΔT_tr = ${fmt(shift, 3)} K) in Suites 03–05.`, basis: 'Spec §31, §33' });
    out.recs.push({ level: 'info', text: 'Open the Experimental Laboratory (#/lab) to design, instrument and run the experiments that feed this calibration (protocols, data acquisition, interlocks, scheduling); then import the recorded datasets here.', basis: 'Experimental Laboratory page' });
    out.recs.push({ level: 'econ', text: `A full instrument set (load cell, LVDT, RTDs, flow meters, torque transducer, encoder, power meter) is needed for V2 calorimetry; budget certificate renewals annually. Synthetic runs cost nothing but provide no evidence.`, basis: 'Instrument register' });
    out.recs.push({ level: 'sustain', text: 'Reuse test coupons across DSC and tensile characterisation and log every specimen in the register so that NiTi (≈ 45 kg CO₂e/kg, library) is not wasted on untraceable tests.', basis: 'Materials library co2 field' });
    // ---------------- view ----------------
    out.views.push({ label: '2D animation: twin vs data', icon: '🎞', render: (el) => anim2d(el, { duration: kfT[nK - 1] || 3 * P, label: 'Time', unit: 's', height: 400, explain: synthetic ? 'SYNTHETIC demonstration data. Top: sensor samples and twin estimate; bottom: calibrated force over the folded cycle.' : 'Measured samples, twin estimate and calibrated model.', draw: (g, t, W, Hh) => { const th = tw(); text(g, synthetic ? 'SYNTHETIC DATA — software demonstration' : 'Measured data — digital twin', 10, 16, th.accent); seriesPanel(g, { x: 8, y: 24, w: W - 16, h: Hh / 2 - 28, T: kfT, series: [{ name: 'sensor', y: kfY, color: '#94a3b8' }, { name: 'twin', y: est, color: '#f97316' }], t, title: 'Ribbon temperature', unit: '°C' }); const Tf = kfT.map(tt => perInterp(H.t, H.F, phaseOf(tt), P)); seriesPanel(g, { x: 8, y: Hh / 2 + 4, w: W - 16, h: Hh / 2 - 12, T: kfT, series: [{ name: 'F calibrated', y: Tf, color: '#22c55e' }], t, title: 'Force', unit: 'N' }); } }) });
    out.outputs = { calibrated, datasets, rmse: { T_K: dT.rmse, F_N: dF?.rmse ?? null, x_m: dX?.rmse ?? null }, bias: { T_K: dT.bias, F_N: dF?.bias ?? null, x_m: dX?.bias ?? null }, confidence: conf, chi2dof, holdout: hold ? { T_rmse: hold.mT.rmse, F_rmse: hold.mF?.rmse ?? null } : null, synthetic, twin: { nis: nisMean, tau_s: tau } };
    out.credibility = synthetic ? 'Numerically verified' : 'Calibrated';
    return out;
  },
};

