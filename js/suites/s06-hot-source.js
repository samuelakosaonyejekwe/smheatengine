// Suite 06 — Hot-source conditioning and thermal supply. Source → intermediate plate exchanger (ε-NTU with fouling)
// → lumped buffer tank → insulated supply line → SMA cells. Distinguishes the source temperature, the fluid
// temperature arriving at the cells and the ribbon (material) temperature actually reached in the cycle.
import { fluid, fluidOptions, hxRate, ductHTC, darcy, pumpPower, streamExergy, entropicMean, effectivenessNTU, carnot, KELVIN } from '../core/heat.js';
import { designWith, engineModel } from '../core/engine.js';
import { get as getMat } from '../core/materials.js';
import { forecast, nasaPowerClimatology, hourlyTable } from '../core/live.js';
import { brent, interp1, linspace, range, fmt, clamp, sum } from '../core/num.js';

const TYPES = [{ value: 'lab', label: 'Laboratory bath / electric heater' }, { value: 'waste', label: 'Industrial waste-heat stream (water / oil / flue-to-water)' }, { value: 'solar', label: 'Solar-thermal collector field' }, { value: 'geo', label: 'Geothermal / district heat' }];
const COLL = { fpc: { label: 'Glazed flat-plate collector', eta0: 0.78, a1: 3.7, a2: 0.012 }, etc: { label: 'Evacuated-tube collector', eta0: 0.65, a1: 1.2, a2: 0.005 } };
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pause = async (ctx) => { try { await ctx.yield?.(); } catch { /* headless run: no animation frame available */ } };
const timed = (p, ms) => { let to; return Promise.race([p, new Promise((_, rej) => { to = setTimeout(() => rej(new Error(`no response within ${(ms / 1000).toFixed(0)} s`)), ms); to?.unref?.(); })]).finally(() => clearTimeout(to)); };
// clear-day irradiance shape scaled to a daily insolation H [kWh/m²/day]; ambient diurnal swing between Tmin and Tmax
function syntheticDay(H, Tmin, Tmax, hours) {
  const shape = (hr) => Math.max(0, Math.sin(Math.PI * (((hr % 24) + 24) % 24 - 6) / 12)) ** 1.2;
  const integ = sum(range(240).map(k => shape(k / 10))) / 10; // h · (W/m² per unit peak)
  const Gpk = H * 1000 / integ;
  return range(hours + 1).map(h => ({ h, G: Gpk * shape(h), Ta: (Tmin + Tmax) / 2 - (Tmax - Tmin) / 2 * Math.cos(2 * Math.PI * (((h % 24) - 15 + 24) % 24) / 24 + Math.PI) }));
}

export default {
  description: 'Conditions the heat supply for the SMA engine: rates the source → intermediate exchanger with fouling, the buffer tank and the insulated supply line, and integrates time-dependent source profiles (batch processes, live solar irradiance) against the engine demand. It reports the available heat at the required temperature and keeps three temperatures apart — source, fluid arriving at the cells, and the ribbon temperature actually reached.',
  literature: 'low-grade waste heat recovery plate heat exchanger fouling solar thermal collector storage tank shape memory alloy heat engine',
  econ: true, sustain: true, credibility: 'Analytical screening',
  equations: [
    'Exchanger duty Q = ε·C_min·(T_src,in − T_loop,in), ε = ε(NTU, C_r, arrangement), NTU = UA/C_min — source-to-loop intermediate exchanger',
    '1/U = 1/h_src + R_f,src + t_p/k_p + R_f,eng + 1/h_eng — overall coefficient with fouling resistances (TEMA-type R_f)',
    'Plate-channel h, Δp from laminar/transitional/turbulent duct correlations (Shah–London, Hausen, Gnielinski) × chevron enhancement factors',
    'Buffer tank: M·c_p·dT_t/dt = Q_src(t, T_t) − Q_eng(T_sup) − UA_tank·(T_t − T_a) — lumped, fully mixed',
    'Supply line: T_sup = T_a + (T_t − T_a)·exp(−U′L/(ṁc_p)) — insulated pipe temperature decay',
    'Solar collector: Q_col = A·[η₀·G − a₁(T_m − T_a) − a₂(T_m − T_a)²]⁺ (EN ISO 9806 quadratic efficiency)',
    'Stream exergy ψ = c_p[(T − T₀) − T₀ ln(T/T₀)]; exergy delivered with heat X = Q·(1 − T₀/T̄), T̄ = (T_sup − T_ret)/ln(T_sup/T_ret) (entropic mean)',
    'Radiation exergy (Petela): X_sun = A·G·[1 − 4/3·T₀/T_s + 1/3·(T₀/T_s)⁴], T_s = 5778 K',
    'Pipe Δp = (f·L/D + ΣK)·ρU²/2, f = 64/Re laminar, Swamee–Jain turbulent; pump P = Δp·V̇/η',
    'Engine heat demand Q_hot(T_sup) and net power P_net(T_sup) from the shared reference engine model at several supply temperatures (interpolated)',
  ],
  methods: [
    'Shared engine reference model evaluated at 4 supply temperatures (T_req − 6, T_req, T_req + 6, T_req + 14 °C) → Q_hot(T), P_net(T), ribbon peak temperature (interpolated)',
    'Steady design point: monotone energy balance Q_hx(T_t) = Q_hot(T_sup(T_t)) + losses solved with Brent’s method',
    'Exchanger rated with the shared ε-NTU core (hxRate) — entropy generation and pinch from the same call',
    'Time profile: explicit energy-conserving integration of the lumped tank ODE with hysteretic engine on/off control (run while P_net > 0, restart at T_sup ≥ T_req); repeated at Δt/2 for time-step independence',
    'Live irradiance/ambient: Open-Meteo hourly forecast (48 h from local midnight) or NASA POWER monthly climatology, with a timeout and an offline clear-day fallback; provenance shown',
    'Parameter maps: supply temperature over source temperature × source flow (or collector area × irradiance) — 13 × 13 steady solves',
  ],
  assumptions: [
    'Fully mixed buffer tank (no stratification) — conservative for supply temperature; stratified tanks deliver hotter top water',
    'Engine heat demand depends only on supply temperature (flow fixed by the engine design ΔT); start-up transients belong to Suite 15',
    'Chevron plate enhancement factors are representative (h × 2.2, f × 4); replace by supplier rating data when available',
    'Solar collector efficiency curve evaluated at tank temperature + 3 K mean plate temperature; incidence-angle modifier and thermal capacitance neglected',
    'Waste-heat batch schedule is a rectangular on/off pattern; source cannot be cooled below the stated minimum return temperature (acid dew point, reinjection or process limit)',
    'Properties from the shared fluid library (validity ranges flagged when clamped)',
  ],
  ibc: {
    initial: ['Tank temperature = required supply temperature for continuous sources; = ambient for solar (cold start at local midnight)', 'Engine off until the arrival temperature first reaches the required supply temperature'],
    boundary: ['Source inlet temperature and available flow (time-dependent per source type)', 'Solar: hourly global horizontal irradiance and ambient temperature (live / climatology / synthetic)', 'Engine return flow at the design ΔT; ambient dead state T₀ for exergy and losses'],
  },
  cvv: {
    calibration: ['Exchanger UA and fouling from a clean/fouled flow-calorimetry test (ṁ, T_in, T_out on both sides)', 'Tank UA from a cool-down test with no draw', 'Collector η₀, a₁, a₂ from an EN ISO 9806 certificate'],
    verification: ['Exchanger energy balance C_h·ΔT_h = C_c·ΔT_c', 'ε-NTU limit C_r → 0 equals 1 − e^(−NTU)', 'Tank ODE discrete energy conservation', 'Time-step independence (Δt vs Δt/2)', 'Second law: S_gen ≥ 0, arrival T ≤ source T'],
    validation: ['Flow calorimetry on the supply loop (spec Module 06 evidence)', 'Source transient response (step in source flow/temperature) against the tank model'],
  },
  formats: { import: ['CSV time series: time, T_source, ṁ_source, irradiance, ambient', 'Exchanger supplier rating sheet (UA, Δp vs flow)'], export: ['CSV of profiles and maps', 'PNG/SVG charts', 'JSON coupling outputs'] },
  params: [
    { key: 'sourceType', label: 'Heat-source type', type: 'select', options: TYPES, default: 'lab', group: 'Source', help: 'Determines the time profile and the meaning of “capacity”.', auto: (c) => { const a = String(c.engine.application || ''); const m = /solar/i.test(a) ? 'solar' : /geo|district/i.test(a) ? 'geo' : /waste|indus|process/i.test(a) ? 'waste' : /lab/i.test(a) ? 'lab' : undefined; return m ? { value: m, prov: 'calc' } : undefined; } },
    { key: 'TsrcIn', label: 'Source inlet temperature (bath set-point / stream / district supply)', unit: '°C', type: 'number', min: 20, max: 250, step: 1, default: 80, group: 'Source', help: 'Temperature of the external heat source before any exchanger. Not the temperature the ribbons see.', auto: (c) => ({ value: Math.round(c.engine.Th + 10), prov: 'estimated' }) },
    { key: 'Qcap', label: 'Source capacity (heater power / contracted heat)', unit: 'W', type: 'number', min: 50, max: 1e6, step: 50, default: 6000, group: 'Source', help: 'Upper limit on heat the source can supply irrespective of temperatures.', auto: (c) => { const q = c.upstream('s01')?.Qhot_W; return q > 0 ? { value: Math.round(1.6 * q), prov: 'coupled' } : undefined; } },
    { key: 'mdotSrc', label: 'Available source-side flow', unit: 'kg/s', type: 'number', min: 0.005, max: 50, step: 0.005, default: 0.25, group: 'Source' },
    { key: 'srcFluid', label: 'Source-side fluid', type: 'select', options: fluidOptions.filter(o => o.value !== 'fl-air'), default: 'fl-water', group: 'Source', help: 'Thermal oil for hot process streams; water for baths, district and geothermal brine (treated as water).' },
    { key: 'TsrcMin', label: 'Minimum source return temperature', unit: '°C', type: 'number', min: 0, max: 200, step: 1, default: 20, group: 'Source', help: 'Acid dew point (flue), reinjection limit (geothermal) or contractual return temperature (district).' },
    { key: 'dpLimitSrc', label: 'Allowable source-side pressure drop', unit: 'Pa', type: 'number', min: 1000, max: 1e6, step: 1000, default: 50000, group: 'Source' },
    { key: 'collector', label: 'Collector type', type: 'select', options: Object.entries(COLL).map(([value, c]) => ({ value, label: c.label })), default: 'fpc', group: 'Solar collector' },
    { key: 'Acoll', label: 'Collector aperture area', unit: 'm²', type: 'number', min: 0.5, max: 2000, step: 0.5, default: 12, group: 'Solar collector' },
    { key: 'profileSrc', label: 'Irradiance / ambient data', type: 'select', options: [{ value: 'forecast', label: 'Live hourly forecast at the project site' }, { value: 'climatology', label: 'Live monthly climatology (NASA POWER)' }, { value: 'synthetic', label: 'Offline clear-day design profile' }], default: 'forecast', group: 'Solar collector', help: 'Falls back automatically (forecast → climatology → synthetic) when offline.' },
    { key: 'liveTimeout', label: 'Live-data timeout', unit: 's', type: 'number', min: 1, max: 30, step: 1, default: 6, group: 'Solar collector', expert: true },
    { key: 'batchOn', label: 'Batch process: hours on per period', unit: 'h', type: 'number', min: 0.5, max: 24, step: 0.5, default: 8, group: 'Time profile' },
    { key: 'batchPeriod', label: 'Batch process period', unit: 'h', type: 'number', min: 1, max: 48, step: 0.5, default: 12, group: 'Time profile' },
    { key: 'horizon', label: 'Simulated horizon', unit: 'h', type: 'number', min: 6, max: 96, step: 6, default: 48, group: 'Time profile', expert: true },
    { key: 'dt', label: 'Tank ODE time step', unit: 's', type: 'number', min: 10, max: 600, step: 10, default: 120, group: 'Time profile', expert: true },
    { key: 'tankV', label: 'Buffer tank volume', unit: 'L', type: 'number', min: 1, max: 50000, step: 1, default: 150, group: 'Buffer & supply line' },
    { key: 'tankUA', label: 'Tank heat-loss coefficient UA', unit: 'W/K', type: 'number', min: 0, max: 100, step: 0.1, default: 2.5, group: 'Buffer & supply line' },
    { key: 'pipeL', label: 'Supply pipe length (one way)', unit: 'm', type: 'number', min: 0.2, max: 500, step: 0.1, default: 6, group: 'Buffer & supply line' },
    { key: 'pipeD', label: 'Supply pipe inner diameter', unit: 'm', type: 'number', min: 0.004, max: 0.3, step: 0.001, default: 0.02, group: 'Buffer & supply line' },
    { key: 'pipeK', label: 'Fittings & valves ΣK (per leg)', unit: '', type: 'number', min: 0, max: 100, step: 0.5, default: 8, group: 'Buffer & supply line' },
    { key: 'pipeUL', label: 'Insulated pipe loss per metre U′', unit: 'W/(m·K)', type: 'number', min: 0, max: 5, step: 0.01, default: 0.25, group: 'Buffer & supply line' },
    { key: 'hxArr', label: 'Exchanger flow arrangement', type: 'select', options: [{ value: 'counter', label: 'Counterflow' }, { value: 'cross', label: 'Crossflow (both unmixed)' }, { value: 'parallel', label: 'Parallel flow' }, { value: 'shell', label: 'Shell-and-tube 1–2' }], default: 'counter', group: 'Intermediate exchanger' },
    { key: 'nPlates', label: 'Number of plates', unit: '', type: 'number', min: 4, max: 400, step: 1, default: 24, group: 'Intermediate exchanger' },
    { key: 'plateW', label: 'Plate width', unit: 'm', type: 'number', min: 0.03, max: 1.5, step: 0.005, default: 0.12, group: 'Intermediate exchanger' },
    { key: 'plateL', label: 'Plate flow length', unit: 'm', type: 'number', min: 0.05, max: 3, step: 0.01, default: 0.4, group: 'Intermediate exchanger' },
    { key: 'gap', label: 'Channel gap', unit: 'm', type: 'number', min: 0.001, max: 0.01, step: 0.0005, default: 0.002, group: 'Intermediate exchanger' },
    { key: 'plateT', label: 'Plate thickness (316L)', unit: 'm', type: 'number', min: 0.0003, max: 0.003, step: 0.0001, default: 0.0005, group: 'Intermediate exchanger' },
    { key: 'foulSrc', label: 'Fouling resistance, source side', unit: 'm²K/W', type: 'number', min: 0, max: 0.002, step: 0.00001, default: 0.0002, group: 'Intermediate exchanger', help: 'TEMA guidance: treated water 1e-4…2e-4; river/process water 3e-4…6e-4; heavy oils 5e-4…1e-3.' },
    { key: 'foulEng', label: 'Fouling resistance, engine side', unit: 'm²K/W', type: 'number', min: 0, max: 0.002, step: 0.00001, default: 0.0001, group: 'Intermediate exchanger' },
    { key: 'enhH', label: 'Chevron heat-transfer enhancement', unit: '×', type: 'number', min: 1, max: 5, step: 0.1, default: 2.2, group: 'Intermediate exchanger', expert: true },
    { key: 'enhF', label: 'Chevron friction enhancement', unit: '×', type: 'number', min: 1, max: 12, step: 0.1, default: 4, group: 'Intermediate exchanger', expert: true },
    { key: 'UAuser', label: 'Override UA (0 = compute from geometry)', unit: 'W/K', type: 'number', min: 0, max: 1e6, step: 10, default: 0, group: 'Intermediate exchanger', expert: true },
    { key: 'ThReq', label: 'Required fluid supply temperature at the cells', unit: '°C', type: 'number', min: 20, max: 200, step: 0.5, default: 70, group: 'Engine demand', auto: (c) => ({ value: c.engine.Th, prov: 'calc' }) },
    { key: 'TsupMax', label: 'Supply over-temperature set-point (source throttled above)', unit: '°C', type: 'number', min: 20, max: 200, step: 0.5, default: 78, group: 'Engine demand', help: 'Thermostatic control: the source/collector loop is throttled when the tank exceeds this arrival temperature, protecting the alloy, seals and fluid.', auto: (c) => ({ value: c.engine.Th + 8, prov: 'calc' }) },
    { key: 'hotFluid', label: 'Engine hot-circuit fluid', type: 'select', options: fluidOptions.filter(o => o.value !== 'fl-air'), default: 'fl-water', group: 'Engine demand', auto: (c) => ({ value: c.engine.hotFluid, prov: 'calc' }) },
    { key: 'regenEff', label: 'Regenerator effectiveness used for demand', unit: '', type: 'number', min: 0, max: 0.98, step: 0.01, default: 0.6, group: 'Engine demand', auto: (c) => { const r = c.upstream('s09')?.regenEff; return Number.isFinite(r) ? { value: +r.toFixed(3), prov: 'coupled' } : { value: c.engine.regenEff, prov: 'calc' }; } },
    { key: 'T0', label: 'Ambient / dead-state temperature', unit: '°C', type: 'number', min: -30, max: 50, step: 0.5, default: 20, group: 'Engine demand', auto: (c) => ({ value: c.engine.T0, prov: 'calc' }) },
    { key: 'heatPrice', label: 'Heat price', unit: 'USD/MWh_th', type: 'number', min: 0, max: 500, step: 1, default: 40, group: 'Economics & sustainability', help: 'Electric heater ≈ grid tariff (100–250); district heat 40–90; geothermal 10–40; waste heat ≈ 0–10 (pumping only); solar ≈ annualised collector cost.' },
    { key: 'gridCO2', label: 'Grid carbon intensity (electric heating)', unit: 'kg/kWh', type: 'number', min: 0, max: 1.2, step: 0.01, default: 0.45, group: 'Economics & sustainability' },
    { key: 'engNodes', label: 'Engine model through-thickness nodes', unit: '', type: 'number', min: 1, max: 6, step: 1, default: 2, group: 'Numerics', expert: true },
    { key: 'engSteps', label: 'Engine model steps per cycle', unit: '', type: 'number', min: 80, max: 400, step: 10, default: 150, group: 'Numerics', expert: true },
    { key: 'mapN', label: 'Parameter-map resolution', unit: '', type: 'number', min: 5, max: 25, step: 1, default: 13, group: 'Numerics', expert: true },
  ],
  presets: [
    { label: 'Laboratory bath 80 °C, 6 kW', values: { sourceType: 'lab', TsrcIn: 80, Qcap: 6000, mdotSrc: 0.25, srcFluid: 'fl-water', heatPrice: 150 } },
    { label: 'Batch waste heat — thermal oil 140 °C', values: { sourceType: 'waste', TsrcIn: 140, Qcap: 30000, mdotSrc: 0.15, srcFluid: 'fl-oil', TsrcMin: 60, foulSrc: 0.0005, batchOn: 8, batchPeriod: 12, heatPrice: 5 } },
    { label: 'Solar flat-plate field 16 m²', values: { sourceType: 'solar', collector: 'fpc', Acoll: 16, tankV: 400, profileSrc: 'forecast', heatPrice: 25 } },
    { label: 'District heating 85 °C supply', values: { sourceType: 'geo', TsrcIn: 85, Qcap: 20000, mdotSrc: 0.3, TsrcMin: 45, heatPrice: 60 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const kpi = (label, value, unit, explain, prov = 'calc', status) => out.kpis.push({ label, value, unit, explain, prov, status });
    const type = p.sourceType, T0 = p.T0, isSolar = type === 'solar';
    const d = designWith(ctx.engine, { Th: p.ThReq, hotFluid: p.hotFluid, regenEff: p.regenEff, T0 });
    const mat = getMat(d.alloy) || getMat('niti-lt');
    const AfH = mat.Af + d.sigmaH / mat.CA, AsH = mat.As + d.sigmaH / mat.CA, AfL = mat.Af + d.sigmaL / mat.CA;
    ctx.progress(0.05, 'engine demand vs supply temperature');
    // ---- engine demand curve Q_hot(T_sup), P_net(T_sup), ribbon peak temperature (material) ----
    const fMax = 148; // engine model kept inside the liquid-water/property validity range
    const Tgrid = [p.ThReq - 6, p.ThReq, p.ThReq + 6, p.ThReq + 14].map(t => clamp(t, d.Tc + 3, fMax));
    const runs = [];
    for (const Th of Tgrid) { const E = engineModel(designWith(d, { Th }), { mat, n: p.engNodes, stepsPerCycle: p.engSteps, cycles: 3 }); runs.push({ Th, Q: E.QhotTot, P: E.Pnet, Tmax: Math.max(...E.cell.hist.Tm), Tsmax: Math.max(...E.cell.hist.Ts), xiMin: E.cell.xiMin, E }); await pause(ctx); }
    const Tlo = Tgrid[0] - 8, Thi = Tgrid[3], cT = (T) => clamp(T, Tlo, Thi); // no extrapolation beyond the evaluated range
    const Edes = runs[1].E, QD = (T) => Math.max(0, interp1(Tgrid, runs.map(r => r.Q), cT(T), 'linear')), PN = (T) => interp1(Tgrid, runs.map(r => r.P), cT(T), 'linear'), TMAT = (T) => Math.min(T, interp1(Tgrid, runs.map(r => r.Tmax), cT(T), 'linear')), XIMIN = (T) => clamp(interp1(Tgrid, runs.map(r => r.xiMin), cT(T), 'linear'), 0, 1);
    const QD0 = Edes.QhotTot, mdotE = Edes.mdotH, fpE = fluid(d.hotFluid, d.Th - d.fluidDT / 2), Cc = mdotE * fpE.cp;
    // ---- intermediate plate exchanger geometry → UA, Δp ----
    const fpS = fluid(p.srcFluid, p.TsrcIn - 10), nchS = Math.max(1, Math.floor((p.nPlates - 1) / 2)), nchE = Math.max(1, Math.ceil((p.nPlates - 1) / 2));
    const Ahx = Math.max(1, p.nPlates - 2) * p.plateW * p.plateL, kP = getMat('ss-316l')?.k ?? 16.3;
    const sideHX = (fid, T, m, nch) => { const r = ductHTC({ fluidId: fid, T, w: p.plateW, hgt: p.gap, L: p.plateL, mdot: Math.max(m, 1e-6), nChannels: nch }); return { ...r, h: r.h * p.enhH, dp: r.dp * p.enhF }; };
    const rateUA = (mS, plates = p.nPlates) => {
      const nS = Math.max(1, Math.floor((plates - 1) / 2)), nE = Math.max(1, Math.ceil((plates - 1) / 2)), A = Math.max(1, plates - 2) * p.plateW * p.plateL;
      const hs = ductHTC({ fluidId: p.srcFluid, T: p.TsrcIn - 10, w: p.plateW, hgt: p.gap, L: p.plateL, mdot: Math.max(mS, 1e-6), nChannels: nS }), he = ductHTC({ fluidId: d.hotFluid, T: d.Th, w: p.plateW, hgt: p.gap, L: p.plateL, mdot: mdotE, nChannels: nE });
      const U = 1 / (1 / (hs.h * p.enhH) + p.foulSrc + p.plateT / kP + p.foulEng + 1 / (he.h * p.enhH));
      return { U, A, UA: p.UAuser > 0 ? p.UAuser : U * A, dpS: hs.dp * p.enhF, dpE: he.dp * p.enhF, hs, he };
    };
    const hxS = sideHX(p.srcFluid, p.TsrcIn - 10, p.mdotSrc, nchS), hxE = sideHX(d.hotFluid, d.Th, mdotE, nchE);
    const Ucl = 1 / (1 / hxS.h + p.plateT / kP + 1 / hxE.h), Uf = 1 / (1 / hxS.h + p.foulSrc + p.plateT / kP + p.foulEng + 1 / hxE.h);
    const UA = p.UAuser > 0 ? p.UAuser : Uf * Ahx, UAclean = p.UAuser > 0 ? p.UAuser : Ucl * Ahx;
    // ---- supply line hydraulics and losses ----
    const Apipe = Math.PI * p.pipeD ** 2 / 4, Up = mdotE / (fpE.rho * Apipe), Rep = fpE.rho * Up * p.pipeD / fpE.mu, fp = darcy(Rep, { rough: 4.5e-5, Dh: p.pipeD });
    const dpPipe = 2 * (fp * p.pipeL / p.pipeD + p.pipeK) * 0.5 * fpE.rho * Up * Up, dpHot = hxE.dp + dpPipe;
    const decay = Math.exp(-p.pipeUL * p.pipeL / Math.max(Cc, 1e-9)), arrival = (Tt, Ta = T0) => Ta + (Tt - Ta) * decay;
    const PpumpLoop = pumpPower(dpHot, mdotE / fpE.rho, d.pumpEta), PpumpSrc = isSolar ? 0 : pumpPower(hxS.dp, p.mdotSrc / fpS.rho, d.pumpEta);
    // ---- source models ----
    const C = COLL[p.collector] || COLL.fpc;
    const qCol = (G, Tt, Ta) => { const dT = Tt + 3 - Ta; return Math.max(0, p.Acoll * (C.eta0 * G - C.a1 * dT - C.a2 * dT * Math.abs(dT))); };
    const Tstag = (G, Ta) => { const f = (x) => C.eta0 * G - C.a1 * x - C.a2 * x * x; return G > 0 ? Ta + brent(f, 0, 400).x : Ta; };
    const qHX = (Tt, Tsrc = p.TsrcIn, mS = p.mdotSrc, UAx = UA) => {
      if (mS <= 0 || Tsrc <= Tt) return { Q: 0, r: null };
      const r = hxRate({ Thi: Tsrc, Tci: Tt, Ch: mS * fpS.cp, Cc, UA: UAx, arr: p.hxArr, T0 });
      return { Q: Math.min(p.Qcap, r.Q, mS * fpS.cp * Math.max(0, Tsrc - p.TsrcMin)), r };
    };
    // ---- live / climatological / synthetic solar & ambient profile ----
    let prof = null, profProv = 'hypothetical', profNote = 'Offline clear-day design profile (6.0 kWh/m²/day, ambient 20–30 °C) — hypothetical, not site data.', liveMeta = null;
    const H = p.horizon;
    if (isSolar) {
      const site = ctx.site || { lat: 0, lon: 0 }, ms = 1000 * p.liveTimeout;
      // both requests start together so the worst-case wait is one timeout; a settled promise never throws unhandled
      const settle = (pr) => pr.then(r => ({ r }), e => ({ e }));
      const fP = p.profileSrc === 'forecast' ? settle(timed(forecast(site.lat, site.lon), ms)) : null, cP = p.profileSrc !== 'synthetic' ? settle(timed(nasaPowerClimatology(site.lat, site.lon), ms)) : null;
      if (p.profileSrc === 'forecast') {
        try {
          const fr = await fP; if (fr.e) throw fr.e; const r = fr.r, T = hourlyTable(r.data); liveMeta = r.meta;
          let i0 = T.time.findIndex((t, i) => i >= 24 && /T00:00$/.test(t) && Date.parse(t + 'Z') - T.utcOffset * 1000 > Date.now() - 86400e3);
          if (i0 < 0) i0 = 0;
          const pts = range(H + 1).map(h => ({ h, G: T.shortwave_radiation[i0 + h], Ta: T.temperature_2m[i0 + h], time: T.time[i0 + h] })).filter(x => Number.isFinite(x.G) && Number.isFinite(x.Ta));
          if (pts.length > H * 0.8) { prof = pts; profProv = 'live'; profNote = `${r.meta.name} — hourly forecast from ${pts[0].time} (local), fetched ${r.meta.fetched.slice(0, 16).replace('T', ' ')} UTC${r.meta.cached ? `, cached ${r.meta.ageMin} min` : ''}. Forecast-model fields, not measurements.`; }
        } catch (e) { profNote = `Live forecast unavailable (${e.message}); `; }
      }
      if (!prof && p.profileSrc !== 'synthetic') {
        try {
          const cr = await cP; if (cr.e) throw cr.e; const r = cr.r, P = r.data.properties.parameter, m = MONTHS[new Date().getMonth()];
          const Hd = P.ALLSKY_SFC_SW_DWN[m], Tmin = P.T2M_MIN[m], Tmax = P.T2M_MAX[m];
          if ([Hd, Tmin, Tmax].every(v => Number.isFinite(v) && v > -900)) { prof = syntheticDay(Hd, Tmin, Tmax, H); profProv = 'live'; liveMeta = r.meta; profNote = (p.profileSrc === 'forecast' ? profNote : '') + `${r.meta.name}: ${m} mean daily insolation ${fmt(Hd, 3)} kWh/m²/day, ambient ${fmt(Tmin, 3)}–${fmt(Tmax, 3)} °C shaped as a clear-sky day (climatological mean, not a forecast).`; }
        } catch (e) { profNote += `climatology unavailable (${e.message}); `; }
      }
      if (!prof) { prof = syntheticDay(6.0, 20, 30, H); if (p.profileSrc !== 'synthetic') profNote += 'using the offline clear-day design profile (6.0 kWh/m²/day, hypothetical).'; }
    }
    const profAt = (tH) => { if (!prof) return { G: 0, Ta: T0 }; const xs = prof.map(r => r.h); return { G: Math.max(0, interp1(xs, prof.map(r => r.G), tH)), Ta: interp1(xs, prof.map(r => r.Ta), tH) }; };
    const srcAt = (tH) => {
      if (type === 'waste') { const ph = ((tH % p.batchPeriod) + p.batchPeriod) % p.batchPeriod, ramp = clamp(Math.min(ph, p.batchOn - ph) / 0.25, 0, 1); return { Tsrc: p.TsrcIn, mS: p.mdotSrc * (ph < p.batchOn ? ramp : 0), Ta: T0 }; }
      if (isSolar) { const s = profAt(tH); return { Tsrc: Tstag(s.G, s.Ta), mS: 0, G: s.G, Ta: s.Ta }; }
      return { Tsrc: p.TsrcIn, mS: p.mdotSrc, Ta: T0 };
    };
    const TtMax = (Ta) => Ta + (p.TsupMax - Ta) / decay; // tank temperature giving the over-temperature set-point at the cells
    const qIn = (Tt, s, ctl = true) => (isSolar ? qCol(s.G, Tt, s.Ta) : qHX(Tt, s.Tsrc, s.mS).Q) * (ctl ? clamp(TtMax(s.Ta) - Tt, 0, 1) : 1); // 1-K proportional band
    // ---- steady design point ----
    ctx.progress(0.35, 'steady design point');
    const sDes = isSolar ? (() => { let k = 0; prof.forEach((r, i) => { if (r.G > prof[k].G) k = i; }); return { ...srcAt(prof[k].h), at: prof[k].h }; })() : srcAt(0.01);
    if (!isSolar && type === 'waste') sDes.mS = p.mdotSrc;
    const hxRaw = (Tt) => isSolar ? qCol(sDes.G, Tt, sDes.Ta) : qHX(Tt, sDes.Tsrc, sDes.mS).Q;
    const lossT = (Tt, Ta) => (p.tankUA + p.pipeUL * p.pipeL) * (Tt - Ta);
    const balance = (Tt, s = sDes, eng = true) => qIn(Tt, s, false) - (eng ? QD(arrival(Tt, s.Ta)) : 0) - lossT(Tt, s.Ta);
    const TsrcDes = sDes.Tsrc, lo = Math.min(sDes.Ta + 0.01, TsrcDes - 0.05), hiT = Math.max(lo + 0.02, TsrcDes - 1e-6);
    let engineCanRun = true, Ttank;
    if (balance(hiT) > 0) Ttank = hiT; else if (balance(lo) < 0) { engineCanRun = false; Ttank = balance(lo, sDes, false) > 0 ? brent(t => balance(t, sDes, false), lo, hiT).x : lo; }
    else Ttank = brent(t => balance(t), lo, hiT).x;
    const TtankFree = Ttank, throttled = Ttank > TtMax(sDes.Ta) - 1; if (throttled) Ttank = Math.min(Ttank, TtMax(sDes.Ta) - 0.5);
    const ThSupply = arrival(Ttank, sDes.Ta), TreqTank = sDes.Ta + (p.ThReq - sDes.Ta) / decay;
    const QDreq = QD(p.ThReq), QavailRaw = TreqTank < TsrcDes ? qIn(TreqTank, sDes, false) : 0, Qavail = Math.max(0, QavailRaw - lossT(TreqTank, sDes.Ta));
    const coverage = QDreq > 0 ? 100 * Qavail / QDreq : 0;
    const Qdel = engineCanRun ? QD(ThSupply) : 0, Tret = ThSupply - Qdel / Cc, need = Qdel + lossT(Ttank, sDes.Ta);
    let hxThrottle = 1; // fraction of source flow (or collector output) used when the thermostat throttles the source
    if (throttled && hxRaw(Ttank) > need) hxThrottle = isSolar ? need / hxRaw(Ttank) : brent(ph => qHX(Ttank, sDes.Tsrc, sDes.mS * ph).Q - need, 1e-6, 1).x;
    const hxDes = isSolar ? null : qHX(Ttank, sDes.Tsrc, sDes.mS * hxThrottle);
    const TsrcOut = hxDes?.r ? sDes.Tsrc - hxDes.Q / (sDes.mS * hxThrottle * fpS.cp) : NaN;
    const TmatPeak = engineCanRun ? TMAT(ThSupply) : NaN, xiMinDel = engineCanRun ? XIMIN(ThSupply) : 1, revOK = xiMinDel < 0.05, PnetDel = engineCanRun ? PN(ThSupply) : 0;
    const PnetPlant = PnetDel - (engineCanRun ? PpumpLoop + PpumpSrc : 0);
    // exergy bookkeeping
    const T0K = T0 + KELVIN, Tsun = 5778;
    const Xsrc = isSolar ? p.Acoll * sDes.G * (1 - 4 / 3 * T0K / Tsun + 1 / 3 * (T0K / Tsun) ** 4) : sDes.mS * streamExergy(fpS.cp, sDes.Tsrc, T0);
    const Xused = isSolar ? Xsrc * hxThrottle : (Number.isFinite(TsrcOut) ? sDes.mS * hxThrottle * (streamExergy(fpS.cp, sDes.Tsrc, T0) - streamExergy(fpS.cp, TsrcOut, T0)) : 0);
    const Tbar = Qdel > 0 ? entropicMean(ThSupply, Tret) : ThSupply + KELVIN, Xdel = Qdel * (1 - T0K / Tbar);
    const XdestHX = hxDes?.r ? hxDes.r.Xdest : 0, Tsrcbar = Number.isFinite(TsrcOut) ? entropicMean(sDes.Tsrc, TsrcOut) - KELVIN : NaN;
    // ---- time profile: lumped buffer tank with engine control ----
    ctx.progress(0.5, 'time-dependent source profile');
    const M = p.tankV / 1000 * fpE.rho, Mcp = M * fpE.cp;
    const simulate = (dt0) => {
      const n = Math.ceil(H * 3600 / dt0), dt = H * 3600 / n;
      let Tt = isSolar ? (prof[0]?.Ta ?? T0) : p.ThReq / decay + T0 * (1 - 1 / decay), on = false, Ein = 0, Eeng = 0, Eloss = 0, tOn = 0, tMeet = 0, Epos = 0, Tt0 = Tt;
      const rec = { t: [], Tt: [], Tsup: [], Tsrc: [], Qin: [], Qeng: [], Qcap: [], P: [], Tmat: [], G: [], Ta: [], on: [] }, every = Math.max(1, Math.round(600 / dt));
      for (let k = 0; k <= n; k++) {
        const tH = k * dt / 3600, s = srcAt(tH), Tsup = arrival(Tt, s.Ta);
        if (on && PN(Tsup) <= 0) on = false; else if (!on && Tsup >= p.ThReq) on = true;
        const Qi = qIn(Tt, s), Qe = on ? QD(Tsup) : 0, Ql = p.tankUA * (Tt - s.Ta) + (on ? p.pipeUL * p.pipeL * (Tt - s.Ta) : 0);
        if (k % every === 0) { rec.t.push(tH); rec.Tt.push(Tt); rec.Tsup.push(Tsup); rec.Tsrc.push(s.Tsrc); rec.Qin.push(Qi); rec.Qeng.push(Qe); rec.Qcap.push(isSolar ? qCol(s.G, T0 - 3, s.Ta) : (s.mS > 0 ? Math.min(p.Qcap, s.mS * fpS.cp * Math.max(0, s.Tsrc - p.TsrcMin)) : 0)); rec.P.push(on ? PN(Tsup) : 0); rec.Tmat.push(on ? TMAT(Tsup) : NaN); rec.G.push(s.G ?? NaN); rec.Ta.push(s.Ta); rec.on.push(on ? 1 : 0); }
        if (k === n) break;
        Ein += Qi * dt; Eeng += Qe * dt; Eloss += Ql * dt; if (on) { tOn += dt; Epos += PN(Tsup) * dt; if (Tsup >= p.ThReq - 0.25) tMeet += dt; }
        Tt += dt * (Qi - Qe - Ql) / Mcp;
      }
      return { rec, Tend: Tt, Tt0, Ein, Eeng, Eloss, hoursOn: tOn / 3600, hoursMeet: tMeet / 3600, Ewh: Epos / 3600 };
    };
    const tau = Mcp / Math.max(1, (isSolar ? p.Acoll * C.a1 : UA) + p.tankUA + 50), dtUse = Math.min(p.dt, Math.max(5, 0.2 * tau));
    const S1 = simulate(dtUse); await pause(ctx);
    const S2 = simulate(dtUse / 2);
    const Ebal = S1.Ein - S1.Eeng - S1.Eloss - Mcp * (S1.Tend - S1.Tt0), Escale = Math.max(1, S1.Ein, S1.Eeng);
    // ---- maps & sweeps ----
    ctx.progress(0.7, 'parameter maps');
    const nM = p.mapN; let mapSpec;
    if (isSolar) {
      const As = linspace(Math.max(0.5, p.Acoll * 0.25), p.Acoll * 2.5, nM), Gs = linspace(200, 1100, nM);
      const z = Gs.map(G => As.map(A => { const q = (Tt) => Math.max(0, A * (C.eta0 * G - C.a1 * (Tt + 3 - sDes.Ta) - C.a2 * (Tt + 3 - sDes.Ta) ** 2)); const f = (Tt) => q(Tt) - QD(arrival(Tt, sDes.Ta)) - lossT(Tt, sDes.Ta); const hi2 = Tstag(G, sDes.Ta); return f(sDes.Ta + 0.01) < 0 ? NaN : f(hi2 - 1e-6) > 0 ? arrival(hi2, sDes.Ta) : arrival(brent(f, sDes.Ta + 0.01, hi2 - 1e-6).x, sDes.Ta); }));
      mapSpec = { x: { label: 'Collector area [m²]', values: As }, y: { label: 'Irradiance G [W/m²]', values: Gs }, z, explain: `Steady arrival temperature at the cells with the engine drawing its demand, versus collector area and irradiance (ambient ${fmt(sDes.Ta, 3)} °C). Blank cells: the field cannot carry the engine at any temperature. The isolines show which area/irradiance combinations reach the required ${fmt(p.ThReq, 3)} °C and the Af(σH) = ${fmt(AfH, 3)} °C threshold.` };
    } else {
      const Ts = linspace(p.ThReq - 5, Math.max(p.ThReq + 40, p.TsrcIn + 10), nM), Ms = linspace(p.mdotSrc * 0.2, p.mdotSrc * 3, nM);
      const z = Ms.map(m => { const R = rateUA(m); return Ts.map(Ts_ => { const q = (Tt) => qHX(Tt, Ts_, m, R.UA).Q; const f = (Tt) => q(Tt) - QD(arrival(Tt, T0)) - lossT(Tt, T0); return f(T0 + 0.01) < 0 ? NaN : f(Ts_ - 1e-6) > 0 ? arrival(Ts_, T0) : arrival(brent(f, T0 + 0.01, Ts_ - 1e-6).x, T0); }); });
      mapSpec = { x: { label: 'Source inlet temperature [°C]', values: Ts }, y: { label: 'Source flow [kg/s]', values: Ms }, z, explain: `Steady fluid arrival temperature at the SMA cells with the engine drawing its demand, versus source temperature and source flow (exchanger re-rated at every flow). Blank cells: the source cannot carry the engine at any temperature. Read the isoline at ${fmt(p.ThReq, 3)} °C for the minimum source conditions; the material additionally needs Af(σH) = ${fmt(AfH, 3)} °C in the ribbon.` };
    }
    const plates = isSolar ? [] : range(12).map(i => Math.round(6 + i * (Math.max(60, p.nPlates * 2.5) - 6) / 11));
    const plateSweep = plates.map(np => { const R = rateUA(p.mdotSrc, np); const Q = TreqTank < p.TsrcIn ? Math.min(p.Qcap, hxRate({ Thi: p.TsrcIn, Tci: TreqTank, Ch: p.mdotSrc * fpS.cp, Cc, UA: R.UA, arr: p.hxArr, T0 }).Q, p.mdotSrc * fpS.cp * Math.max(0, p.TsrcIn - p.TsrcMin)) - lossT(TreqTank, T0) : 0; return { np, Q: Math.max(0, Q), dpE: R.dpE + dpPipe, dpS: R.dpS, UA: R.UA }; });
    const npNeeded = plateSweep.find(r => r.Q >= QDreq)?.np;
    // ---- verification ----
    if (hxDes?.r) {
      const r = hxDes.r, Ch = sDes.mS * hxThrottle * fpS.cp;
      out.checks.push({ name: 'Exchanger energy balance C_h·ΔT_h = C_c·ΔT_c', value: Math.abs(Ch * (sDes.Tsrc - r.Tho) - Cc * (r.Tco - Ttank)) / Math.max(1e-9, r.Q), target: '< 1e-9 (relative)', pass: Math.abs(Ch * (sDes.Tsrc - r.Tho) - Cc * (r.Tco - Ttank)) / Math.max(1e-9, r.Q) < 1e-9, detail: `Q = ${fmt(r.Q, 4)} W` });
      out.checks.push({ name: 'Second law in the exchanger (S_gen ≥ 0)', value: r.Sgen, target: '≥ 0 W/K', pass: r.Sgen >= -1e-12, detail: `Exergy destroyed ${fmt(r.Xdest, 4)} W` });
    }
    { const N = 2.3, e = effectivenessNTU(N, 1e-12, p.hxArr); out.checks.push({ name: 'ε-NTU limit C_r → 0 equals 1 − e^(−NTU)', value: e, target: fmt(1 - Math.exp(-N), 6), pass: Math.abs(e - (1 - Math.exp(-N))) < 1e-9, detail: `arrangement ${p.hxArr}, NTU = ${N}` }); }
    out.checks.push({ name: 'Buffer-tank discrete energy conservation', value: Ebal / Escale, target: '|residual| < 1e-9 of throughput', pass: Math.abs(Ebal / Escale) < 1e-9, detail: `∫Q_in = ${fmt(S1.Ein / 3.6e6, 4)} kWh, ∫Q_eng = ${fmt(S1.Eeng / 3.6e6, 4)} kWh, ∫losses = ${fmt(S1.Eloss / 3.6e6, 4)} kWh, ΔU = ${fmt(Mcp * (S1.Tend - S1.Tt0) / 3.6e6, 4)} kWh` });
    { const mT = (S) => S.rec.Tt.reduce((x, y) => x + y, 0) / S.rec.Tt.length, dT = Math.abs(mT(S1) - mT(S2)), dE = Math.abs(S1.Eeng - S2.Eeng) / Math.max(S1.Eeng, 3.6e4); out.checks.push({ name: 'Time-step independence (Δt vs Δt/2)', value: dT, target: '|Δ mean tank T| < 0.3 K and |Δ∫Q_eng| < 5 % (switching instants converge at first order)', pass: dT < 0.3 && dE < 0.05, detail: `Δt = ${fmt(dtUse, 3)} s; mean tank T ${fmt(mT(S1), 5)} vs ${fmt(mT(S2), 5)} °C; engine heat ${fmt(S1.Eeng / 3.6e6, 4)} vs ${fmt(S2.Eeng / 3.6e6, 4)} kWh; hours meeting demand ${fmt(S1.hoursMeet, 4)} vs ${fmt(S2.hoursMeet, 4)} h (on/off limit cycles shift switching instants, so instantaneous end values are not compared).` }); }
    out.checks.push({ name: 'Arrival temperature does not exceed source temperature', value: ThSupply, target: `≤ ${fmt(TsrcDes, 4)} °C`, pass: ThSupply <= TsrcDes + 1e-6 });
    out.checks.push({ name: 'Engine efficiency below Carnot at the delivered temperature', value: Qdel > 0 ? PnetDel / Qdel : 0, target: `≤ ${fmt(carnot(ThSupply, d.Tc), 4)}`, pass: !(Qdel > 0) || PnetDel / Qdel <= carnot(ThSupply, d.Tc) + 1e-9 });
    out.checks.push({ name: 'Fluid properties within validity range', value: [fpS, fpE].some(f => f.clamped) ? 'clamped' : 'in range', target: 'in range', pass: ![fpS, fpE].some(f => f.clamped), detail: `${fpS.name} at ${fmt(p.TsrcIn - 10, 3)} °C; ${fpE.name} at ${fmt(d.Th - d.fluidDT / 2, 3)} °C` });
    // ---- KPIs ----
    const st = (ok, warn) => ok ? 'ok' : warn ? 'warn' : 'bad';
    kpi('Available heat at the required supply temperature', Qavail, 'W', `Net heat the conditioned source can deliver while holding the cells’ supply at ${fmt(p.ThReq, 3)} °C (exchanger, capacity and minimum-return limits, minus tank and pipe losses).${isSolar ? ' Solar: at the peak-irradiance hour.' : ''}`, 'calc', st(coverage >= 100, coverage >= 80));
    kpi('Duty coverage', coverage, '%', `Available heat ÷ engine heat demand at the required temperature (${fmt(QDreq, 4)} W from the shared engine model, regenerator ε = ${fmt(p.regenEff, 3)}).`, 'calc', st(coverage >= 100, coverage >= 80));
    kpi('Source temperature', TsrcDes, '°C', isSolar ? 'Collector stagnation temperature at peak irradiance — the hottest the collector fluid could get with no draw.' : 'Temperature of the external source before the exchanger (bath set-point, process stream or district supply).', isSolar ? 'calc' : 'user');
    kpi('Fluid arrival temperature at the cells', ThSupply, '°C', 'Steady hot-fluid temperature reaching the SMA channels after exchanger approach, tank mixing and supply-line loss — this, not the source temperature, drives the ribbons.', 'calc', st(ThSupply >= p.ThReq - 0.25, ThSupply >= AsH));
    kpi('Peak ribbon (material) temperature', TmatPeak, '°C', `Thickness-averaged ribbon temperature reached during the hot phase at the delivered fluid temperature (transient cell model). The ribbon stress swings between σL and σH, so complete reverse transformation needs Af(σ) = ${fmt(AfL, 3)}–${fmt(AfH, 3)} °C; the cell model reports a residual martensite fraction ξ_min = ${fmt(xiMinDel, 3)}.`, 'calc', Number.isFinite(TmatPeak) ? st(revOK && TmatPeak >= AfH - 0.5, revOK) : 'bad');
    kpi('Exergy delivered to the engine', Xdel, 'W', `Q·(1 − T₀/T̄) with entropic mean T̄ = ${fmt(Tbar - KELVIN, 4)} °C of the supply/return stream — the maximum work obtainable from the delivered heat.`);
    if (isSolar) { const qc = qCol(sDes.G, Ttank, sDes.Ta); kpi('Collector efficiency at the design point', sDes.G > 0 ? qc / (p.Acoll * sDes.G) : 0, '', `Q_col/(A·G) at G = ${fmt(sDes.G, 4)} W/m², tank ${fmt(Ttank, 4)} °C, ambient ${fmt(sDes.Ta, 3)} °C (${C.label}: η₀ = ${C.eta0}, a₁ = ${C.a1}, a₂ = ${C.a2}).`, profProv); }
    else kpi('Exchanger effectiveness', hxDes?.r?.eps ?? 0, '', `ε at NTU = ${fmt(hxDes?.r?.NTU, 3)}, C_r = ${fmt(hxDes?.r?.Cr, 3)}, fouled UA = ${fmt(UA, 4)} W/K (clean ${fmt(UAclean, 4)} W/K)${hxThrottle < 1 ? `; source flow throttled to ${fmt(100 * hxThrottle, 3)} % by the supply thermostat` : ''}.`);
    kpi('Engine-loop pressure drop (exchanger + supply line)', dpHot, 'Pa', `Excludes the SMA microchannels (Suite 08/13). Exchanger ${fmt(hxE.dp, 4)} Pa + piping ${fmt(dpPipe, 4)} Pa at ${fmt(mdotE, 3)} kg/s.`);
    kpi('Hours meeting demand', S1.hoursMeet, `h of ${H}`, `Hours with the engine running at ≥ the required supply temperature over the ${H}-h ${isSolar ? 'solar' : type === 'waste' ? 'batch' : 'continuous'} profile (buffer ${p.tankV} L).`, isSolar ? profProv : 'calc', st(S1.hoursMeet >= 0.9 * H, S1.hoursMeet >= 0.3 * H));
    kpi('Net power at the delivered temperature (after conditioning pumps)', PnetPlant, 'W', `Engine P_net at T_sup = ${fmt(ThSupply, 4)} °C (${fmt(PnetDel, 4)} W) minus supply-loop and source-side pumping (${fmt(PpumpLoop + PpumpSrc, 3)} W).`, 'calc', st(PnetPlant > 0));
    // ---- verdicts ----
    const V = (test, status, detail, fix) => out.verdicts.push({ test, status, detail, fix });
    V('Ribbon temperature completes the reverse transformation', !Number.isFinite(TmatPeak) || !revOK ? 'fail' : TmatPeak >= AfH - 0.5 ? 'pass' : 'warn', `Source ${fmt(TsrcDes, 4)} °C → fluid at cells ${fmt(ThSupply, 4)} °C → ribbon peak ${fmt(TmatPeak, 4)} °C. Cell model: ξ_min = ${fmt(xiMinDel, 3)} (${revOK ? 'complete' : 'incomplete'}). Screening band Af(σL = ${d.sigmaL} MPa) = ${fmt(AfL, 4)} °C … Af(σH = ${d.sigmaH} MPa) = ${fmt(AfH, 4)} °C; ${revOK && TmatPeak < AfH - 0.5 ? 'the transformation completes only because it occurs before the load engages (stress near σL) — no margin if the load engages earlier.' : 'the three temperatures differ by exchanger approach, mixing/line loss and the finite heating time of the cell.'}`, `Raise the arrival temperature by ≥ ${fmt(Math.max(0, AfH + 2 - (TmatPeak || 0)), 2)} K (hotter source, more plates, larger buffer), lower σH, or select an alloy with lower Af (Suite 03).`);
    V('Duty coverage at the required supply temperature', coverage >= 100 ? 'pass' : coverage >= 80 ? 'warn' : 'fail', `${fmt(Qavail, 4)} W available vs ${fmt(QDreq, 4)} W demanded (${fmt(coverage, 3)} %).`, npNeeded ? `Increase the exchanger to ≈ ${npNeeded} plates (sweep below) or raise source flow/temperature.` : isSolar ? `Enlarge the collector field (map) or add buffer storage; at peak hour the field gives ${fmt(Qavail, 4)} W.` : 'Raise source temperature or flow; the exchanger alone cannot close the gap (capacity or minimum-return limit).');
    if (!isSolar) V('Source-side pressure drop within the allowable limit', hxS.dp <= p.dpLimitSrc ? 'pass' : 'fail', `Δp_source = ${fmt(hxS.dp, 4)} Pa vs limit ${fmt(p.dpLimitSrc, 4)} Pa at ${fmt(p.mdotSrc, 3)} kg/s (${nchS} channels).`, 'Add plates (more parallel channels), widen the gap or reduce chevron angle.');
    if (!isSolar) V('Source not cooled below its minimum return temperature', !Number.isFinite(TsrcOut) || TsrcOut >= p.TsrcMin - 1e-6 ? 'pass' : 'fail', `Source outlet ${fmt(TsrcOut, 4)} °C vs minimum ${p.TsrcMin} °C.`, 'Limit extraction or raise source flow.');
    if (isSolar) V('Collector stagnation protection', TsrcDes <= 100 ? 'pass' : 'warn', `Stagnation temperature ${fmt(TsrcDes, 4)} °C at peak irradiance${TsrcDes > 100 ? ' — the collector loop will boil if circulation stops' : ''}.`, 'Use a pressurised glycol loop with expansion vessel, or a drain-back system; keep the over-temperature set-point below the alloy and seal limits.');
    else V('Source fluid within its temperature limits', p.srcFluid === 'fl-water' ? (TsrcDes <= 100 ? 'pass' : 'warn') : TsrcDes <= 300 ? 'pass' : 'fail', `${fpS.name} at ${fmt(TsrcDes, 4)} °C${p.srcFluid === 'fl-water' && TsrcDes > 100 ? ' — above atmospheric boiling: pressurise the source loop' : ''}.`, 'Use thermal oil or pressurise above 100 °C.');
    if (throttled) V('Supply thermostat active', 'info', `Unthrottled the tank would settle at ${fmt(TtankFree, 4)} °C; the source is throttled to ${fmt(100 * hxThrottle, 3)} % so the cells receive ≤ ${p.TsupMax} °C.`, 'Raise the set-point only if the alloy, seals and fluid allow it — the engine model is evaluated up to T_req + 14 K.');
    V('Engine can operate at the steady supply point', engineCanRun && PnetDel > 0 ? 'pass' : 'fail', engineCanRun ? `P_net(T_sup) = ${fmt(PnetDel, 4)} W.` : 'Even with the return at ambient the source cannot meet the engine demand — the engine stalls and the loop floats.', 'Increase source capacity or reduce the number of active cells.');
    V('Time profile: hours at full supply temperature', S1.hoursMeet >= 0.9 * H ? 'pass' : S1.hoursMeet >= 0.3 * H ? 'warn' : 'fail', `${fmt(S1.hoursMeet, 3)} h of ${H} h meet the demand; engine running ${fmt(S1.hoursOn, 3)} h; ${fmt(S1.Ewh, 4)} Wh net produced.`, isSolar ? 'Add storage (tank volume) and collector area; consider PCM buffering (Suite 09).' : type === 'waste' ? `Size the buffer to bridge the ${fmt(p.batchPeriod - p.batchOn, 3)}-h off period (≈ ${fmt(QDreq * (p.batchPeriod - p.batchOn) * 3600 / (fpE.cp * 10) / 1000, 3)} m³ of water per 10 K swing).` : 'Check capacity and exchanger.');
    if (isSolar) V('Solar data provenance', profProv === 'live' ? 'pass' : 'warn', profNote, 'Connect to the internet or import measured irradiance (Data portal) for a site-specific profile.');
    V('Missing measurements (requested)', 'info', 'No flow-calorimetry or source-transient data imported for this suite. Measure: ṁ and T_in/T_out on both exchanger sides (clean and after fouling), tank cool-down curve, and the response to a step in source temperature.', 'Import calibration data (Import mode) to replace the library fouling factors and correlation enhancement factors.');
    // ---- charts ----
    const R = S1.rec;
    out.charts.push({ type: 'line', title: 'Heat flows over the source profile', x: { label: 'Time', unit: 'h' }, y: { label: 'Heat rate', unit: 'W' }, series: [{ name: isSolar ? 'Collector potential (at ambient)' : 'Source capacity available', x: R.t, y: R.Qcap, dash: true }, { name: 'Heat into buffer', x: R.t, y: R.Qin }, { name: 'Engine draw', x: R.t, y: R.Qeng }], annotations: [{ type: 'hline', y: QDreq, label: 'Demand at T_req' }], explain: `Time history of the source (dashed: what the ${isSolar ? 'collector could give at ambient temperature' : 'source could give if cooled to its minimum return'}), the heat actually transferred into the ${p.tankV}-L buffer, and the engine draw (zero while the controller holds the engine off). Gaps between the curves are stored or lost heat.`, wide: true });
    out.charts.push({ type: 'line', title: 'Source, fluid-arrival and ribbon temperatures', x: { label: 'Time', unit: 'h' }, y: { label: 'Temperature', unit: '°C' }, series: [{ name: isSolar ? 'Collector stagnation T' : 'Source inlet T', x: R.t, y: R.Tsrc, dash: true }, { name: 'Buffer tank T', x: R.t, y: R.Tt }, { name: 'Fluid arrival at cells', x: R.t, y: R.Tsup }, { name: 'Ribbon peak (material) T', x: R.t, y: R.Tmat }], annotations: [{ type: 'hline', y: p.ThReq, label: 'T_req' }, { type: 'hline', y: AfH, label: 'Af(σH)', color: '#ef4444' }], explain: 'Keeps the three temperatures apart: the source, the fluid arriving at the SMA, and the ribbon temperature actually reached (shown only while the engine runs). The ribbon peak must clear the red Af(σH) line for complete transformation; the arrival temperature must clear T_req for design output.', wide: true });
    const ladder = [['Source inlet', TsrcDes], ...(Number.isFinite(TsrcOut) ? [['Source outlet', TsrcOut]] : []), ['Tank / exchanger outlet', Ttank], ['Fluid arrival at cells', ThSupply], ['Engine return', Tret], ['Ribbon peak (material)', TmatPeak], ['Af(σH) requirement', AfH], ['Dead state T₀', T0]];
    out.charts.push({ type: 'bar', title: 'Temperature ladder at the steady design point', categories: ladder.map(l => l[0]), series: [{ name: 'Temperature [°C]', values: ladder.map(l => +(+l[1]).toFixed(2)) }], explain: 'Each bar is a distinct physical temperature along the supply chain. Differences are exchanger approach (source → tank), supply-line loss (tank → arrival) and the heating lag of the ribbons (arrival → material peak). Compare the material bar with the Af(σH) bar.' });
    out.charts.push({ type: 'heatmap', title: isSolar ? 'Arrival temperature map — collector area × irradiance' : 'Arrival temperature map — source temperature × source flow', ...mapSpec, zlabel: 'T_arrival [°C]', cmap: 'inferno', isolines: 6 });
    if (!isSolar) {
      out.charts.push({ type: 'line', title: 'Exchanger sizing: available heat vs plate count', x: { label: 'Number of plates' }, y: { label: 'Heat at T_req', unit: 'W' }, series: [{ name: 'Available heat (fouled)', x: plates, y: plateSweep.map(r => r.Q) }], annotations: [{ type: 'hline', y: QDreq, label: 'Engine demand' }, { type: 'vline', x: p.nPlates, label: 'current' }], explain: `Available heat at the required supply temperature as the plate pack grows (same plates, fouling ${p.foulSrc}/${p.foulEng} m²K/W). The curve saturates at the source capacity or minimum-return limit — beyond that more area does not help.${npNeeded ? ` ≈ ${npNeeded} plates meet the demand.` : ''}` });
      out.charts.push({ type: 'line', title: 'Exchanger sizing: pressure drop vs plate count', x: { label: 'Number of plates' }, y: { label: 'Pressure drop', unit: 'kPa', log: true }, series: [{ name: 'Engine loop (HX + line)', x: plates, y: plateSweep.map(r => r.dpE / 1000) }, { name: 'Source side', x: plates, y: plateSweep.map(r => r.dpS / 1000) }], annotations: [{ type: 'hline', y: p.dpLimitSrc / 1000, label: 'source limit' }], explain: 'More plates share the flow among more channels, cutting channel velocity and pressure drop roughly with the square of channel count in turbulent flow (linearly in laminar). The trade-off against heat duty sets the pack size.' });
    } else {
      out.charts.push({ type: 'line', title: `Irradiance and ambient (${profProv === 'live' ? 'live' : 'hypothetical'})`, x: { label: 'Time', unit: 'h' }, y: { label: 'G [W/m²] · T_a [°C ×10]' }, series: [{ name: 'Global horizontal irradiance G', x: R.t, y: R.G }, { name: 'Ambient T ×10', x: R.t, y: R.Ta.map(v => v * 10) }], explain: `${profNote} The collector yield depends on G and on the collector–ambient temperature difference (losses a₁, a₂).` });
    }
    const exBars = [['Source exergy (rate)', Xsrc], ['Exergy extracted from source', Xused], ['Destroyed in exchanger', XdestHX], ['Delivered to engine with heat', Xdel], ['Engine net power', Math.max(0, PnetDel)]];
    out.charts.push({ type: 'bar', title: 'Exergy cascade of the thermal supply', categories: exBars.map(b => b[0]), series: [{ name: 'W', values: exBars.map(b => +(+b[1]).toFixed(3)) }], explain: `Work-equivalent of each stage, dead state T₀ = ${T0} °C. Heat quantity is not heat quality: a ${fmt(TsrcDes, 3)} °C source carries only ${fmt(100 * (1 - T0K / (TsrcDes + KELVIN)), 3)} % exergy at best. The gap between “delivered” and “net power” is lost inside the engine (Suite 18).` });
    // ---- tables ----
    out.tables.push({ title: 'Steady design point', cols: ['Quantity', 'Value', 'Unit', 'Basis'], rows: [
      ['Source type', TYPES.find(t => t.value === type)?.label, '', 'user'], ['Source temperature', fmt(TsrcDes, 4), '°C', isSolar ? 'stagnation at peak G' : 'user'], ['Source outlet temperature', fmt(TsrcOut, 4), '°C', 'ε-NTU'], ['Source entropic-mean temperature', fmt(Tsrcbar, 4), '°C', 'T̄ = ΔT/ln(T_in/T_out)'],
      ['Tank temperature', fmt(Ttank, 4), '°C', 'steady balance'], ['Fluid arrival at cells', fmt(ThSupply, 4), '°C', 'line decay'], ['Engine return', fmt(Tret, 4), '°C', 'Q/(ṁc_p)'], ['Ribbon peak (material)', fmt(TmatPeak, 4), '°C', 'transient cell'], ['Af(σL) … Af(σH)', `${fmt(AfL, 4)} … ${fmt(AfH, 4)}`, '°C', 'library + Clausius–Clapeyron'], ['Residual martensite ξ_min at delivered T', fmt(xiMinDel, 3), '', 'transient cell'],
      ['Engine heat demand at T_req', fmt(QDreq, 4), 'W', 'engine model'], ['Heat delivered (steady)', fmt(Qdel, 4), 'W', 'balance'], ['Available heat at T_req', fmt(Qavail, 4), 'W', 'balance'], ['Engine hot-loop flow', fmt(mdotE, 4), 'kg/s', `ΔT = ${d.fluidDT} K`],
      ['Exergy delivered', fmt(Xdel, 4), 'W', 'entropic mean'], ['Exergy destroyed in exchanger', fmt(XdestHX, 4), 'W', 'T₀·S_gen'], ['Supply-loop pump power', fmt(PpumpLoop, 4), 'W', `η = ${d.pumpEta}`], ['Source-side pump power', fmt(PpumpSrc, 4), 'W', `η = ${d.pumpEta}`]],
      explain: 'All temperatures and flows at the steady operating point with the engine drawing its supply-temperature-dependent demand.' });
    if (!isSolar) out.tables.push({ title: 'Intermediate exchanger rating', cols: ['Item', 'Source side', 'Engine side'], rows: [['Channels', nchS, nchE], ['Re', fmt(hxS.Re, 4), fmt(hxE.Re, 4)], ['Regime', hxS.regime, hxE.regime], ['h (enhanced) [W/m²K]', fmt(hxS.h, 4), fmt(hxE.h, 4)], ['Fouling [m²K/W]', p.foulSrc, p.foulEng], ['Δp [Pa]', fmt(hxS.dp, 4), fmt(hxE.dp, 4)], ['U clean / fouled [W/m²K]', fmt(Ucl, 4), fmt(Uf, 4)], ['Area [m²]', fmt(Ahx, 4), ''], ['UA fouled [W/K]', fmt(UA, 4), ''], ['ε / NTU / C_r', `${fmt(hxDes?.r?.eps, 4)} / ${fmt(hxDes?.r?.NTU, 4)} / ${fmt(hxDes?.r?.Cr, 4)}`, ''], ['Pinch [K]', fmt(hxDes?.r?.pinch, 4), '']], explain: `Plate pack ${p.nPlates} × ${p.plateW} × ${p.plateL} m, gap ${p.gap * 1000} mm, ${p.hxArr}. Fouling reduces UA by ${fmt(100 * (1 - Uf / Ucl), 3)} %.` });
    out.tables.push({ title: `${H}-h profile summary`, cols: ['Quantity', 'Value'], rows: [['Energy into buffer', `${fmt(S1.Ein / 3.6e6, 4)} kWh`], ['Energy drawn by engine', `${fmt(S1.Eeng / 3.6e6, 4)} kWh`], ['Tank + line losses', `${fmt(S1.Eloss / 3.6e6, 4)} kWh`], ['Engine running', `${fmt(S1.hoursOn, 4)} h`], ['Meeting demand (T_sup ≥ T_req)', `${fmt(S1.hoursMeet, 4)} h`], ['Net mechanical energy', `${fmt(S1.Ewh, 4)} Wh`], ['Time step used', `${fmt(dtUse, 3)} s`], ['Profile data', isSolar ? profNote : 'schedule from inputs']], explain: 'Integrated results of the buffer-tank simulation with on/off engine control.' });
    // ---- narrative & recommendations ----
    out.explain.push({ title: 'What was computed', text: `The engine demand curve was evaluated with the shared transient cell model at four supply temperatures, giving ${fmt(QDreq, 4)} W of heat at ${fmt(p.ThReq, 3)} °C. The ${TYPES.find(t => t.value === type)?.label.toLowerCase()} feeds a ${p.tankV}-L buffer ${isSolar ? 'directly from the collector loop' : `through a ${p.nPlates}-plate exchanger (fouled UA ${fmt(UA, 4)} W/K)`}; the cells draw from the tank through ${p.pipeL} m of insulated line.` });
    out.explain.push({ title: 'Source vs fluid vs material temperature', text: `Source ${fmt(TsrcDes, 4)} °C → fluid arriving at the cells ${fmt(ThSupply, 4)} °C → ribbon peak ${fmt(TmatPeak, 4)} °C. The engine model and Carnot bound use the fluid temperature; transformation completeness depends on the material temperature against Af(σH) = ${fmt(AfH, 4)} °C. Treating the source temperature as the ribbon temperature would overstate performance.` });
    out.explain.push({ title: 'Time dependence', text: `Over ${H} h the engine ran ${fmt(S1.hoursOn, 3)} h and met full demand for ${fmt(S1.hoursMeet, 3)} h, producing ${fmt(S1.Ewh, 4)} Wh of net mechanical energy. Controller: stop when P_net(T_sup) ≤ 0, restart when T_sup ≥ T_req.` });
    const rec = (level, text, basis) => out.recs.push({ level, text, basis });
    if (coverage < 100) rec('critical', `Supply covers only ${fmt(coverage, 3)} % of the ${fmt(QDreq, 4)} W demand at ${fmt(p.ThReq, 3)} °C. ${npNeeded ? `Increase the plate pack from ${p.nPlates} to ≈ ${npNeeded} plates` : isSolar ? 'Enlarge the collector field' : 'Raise source flow or temperature (the exchanger is not the limit)'}.`, 'Duty coverage KPI and sizing sweep');
    else rec('good', `Supply covers ${fmt(coverage, 3)} % of demand with ${fmt(Qavail - QDreq, 4)} W margin at the required temperature.`, 'Duty coverage');
    if (Number.isFinite(TmatPeak) && TmatPeak < AfH) rec(revOK ? 'warn' : 'critical', `Ribbon peaks at ${fmt(TmatPeak, 4)} °C, ${fmt(AfH - TmatPeak, 3)} K below Af(σH). Either supply hotter fluid or reduce σH to ≤ ${fmt((TmatPeak - 1 - mat.Af) * mat.CA, 3)} MPa.`, 'Material vs Af(σH)');
    if (!isSolar && Uf < 0.8 * Ucl) rec('warn', `Fouling removes ${fmt(100 * (1 - Uf / Ucl), 3)} % of the exchanger UA. Specify cleanable gasketed plates, filtration on the source side, and schedule cleaning when ε drops 10 %.`, 'Clean vs fouled U');
    if (dpHot > 0.5 * (Edes.hydH?.dp || 1e9)) rec('info', `External supply loop Δp ${fmt(dpHot, 4)} Pa is comparable with the microchannel Δp ${fmt(Edes.hydH?.dp, 4)} Pa; enlarge the line diameter above ${p.pipeD * 1000} mm to cut pumping ${fmt(PpumpLoop, 3)} W.`, 'Hydraulics');
    const cKWh = Qdel > 0 && PnetDel > 0 ? p.heatPrice / 1000 * Qdel / PnetDel : Infinity;
    rec('econ', Number.isFinite(cKWh) ? `Heat cost alone is ${fmt(cKWh, 3)} USD per kWh of net mechanical output (heat ${p.heatPrice} USD/MWh_th ÷ η = ${fmt(100 * PnetDel / Qdel, 3)} %). At this efficiency only near-free heat (waste, solar already installed) is economic.` : 'No net output at the delivered temperature — the heat purchase has no return.', 'Heat price and engine efficiency');
    if (type === 'lab') rec('sustain', `An electric bath supplying ${fmt(Qdel, 4)} W emits ≈ ${fmt(Qdel / 1000 * p.gridCO2, 3)} kg CO₂/h at ${p.gridCO2} kg/kWh — ${PnetDel > 0 ? fmt(Qdel / PnetDel * p.gridCO2, 3) + ' kg CO₂ per kWh of engine output' : 'with no net output'}. Use the lab bath only for characterisation; field operation must use waste, solar or geothermal heat.`, 'Grid carbon intensity');
    else rec('sustain', `${type === 'waste' ? 'Recovered waste heat displaces no fuel' : type === 'solar' ? 'Solar heat is renewable' : 'Geothermal/district heat is low-carbon'}; residual impact is pumping (${fmt(PpumpLoop + PpumpSrc, 3)} W, ${PnetDel > 0 ? fmt(100 * (PpumpLoop + PpumpSrc) / PnetDel, 3) + ' % of engine output' : 'exceeds output'}) and exchanger/tank embodied material.`, 'Auxiliary power vs output');
    if (Xdel > 0 && PnetDel > 0) rec('info', `The engine converts ${fmt(100 * PnetDel / Xdel, 3)} % of the delivered exergy; the supply chain destroys ${fmt(XdestHX, 3)} W in the exchanger. Exergy, not heat, is the right figure for comparing sources.`, 'Exergy cascade');
    // ---- animation view ----
    const anim = { R, H, ThReq: p.ThReq, AfH, Qd: QDreq, isSolar };
    out.views.push({ label: '2D animation: source → buffer → cells', icon: '🎞', render: (el) => animSupply(el, anim) });
    out.outputs = { Qavail_W: Qavail, ThIn_C: TsrcDes, ThSupply_C: ThSupply, mdotHot_kgs: mdotE, dpHot_Pa: dpHot, exergy_W: Xdel, sourceType: type };
    const ok = coverage >= 100 && revOK && TmatPeak >= AfH - 0.5;
    out.headline = `${TYPES.find(t => t.value === type)?.label}: ${fmt(Qavail, 4)} W available at ${fmt(p.ThReq, 3)} °C (${fmt(coverage, 3)} % of demand); fluid reaches the cells at ${fmt(ThSupply, 4)} °C, ribbon peaks at ${fmt(TmatPeak, 4)} °C vs Af(σH) ${fmt(AfH, 4)} °C.`;
    out.headlineKind = ok ? 'ok' : coverage >= 80 ? 'warn' : 'fail';
    out.credibility = 'Analytical screening';
    return out;
  },
};

async function animSupply(el, A) {
  const [{ anim2d, seriesPanel, arrow, text, at, lerp, theme }, { cmap }] = await Promise.all([import('../core/anim2d.js'), import('../core/chart.js')]);
  const R = A.R, lo = Math.min(...R.Ta, ...R.Tt) - 2, hi = Math.max(...R.Tsrc.filter(Number.isFinite), ...R.Tt) + 2, col = (T) => `rgb(${cmap(clamp((T - lo) / (hi - lo), 0, 1), 'inferno').map(Math.round).join(',')})`;
  const qmax = Math.max(1, ...R.Qin, ...R.Qeng);
  anim2d(el, { duration: A.H, rate: A.H / 20, label: 'Profile time', unit: 'h', height: 440, explain: 'Solved buffer-tank history: block colours are temperatures (source, tank, fluid at cells), arrow widths are heat rates. Lower panels sweep the same time axis. The engine block greys out while the controller holds it off.', draw(g, t, W, H) {
    const th = theme(), k = at(R.t, t), Ts = lerp(R.Tsrc, k), Tt = lerp(R.Tt, k), Tsup = lerp(R.Tsup, k), Qi = lerp(R.Qin, k), Qe = lerp(R.Qeng, k), on = R.on[k.i];
    const y = 30, bh = 90, bw = Math.min(130, W / 6);
    g.fillStyle = col(Ts); g.fillRect(20, y, bw, bh); text(g, A.isSolar ? 'Collector' : 'Source', 26, y + 16, '#fff'); text(g, `${fmt(Ts, 3)} °C`, 26, y + 34, '#fff');
    const x2 = 20 + bw + 70; g.fillStyle = col(Tt); g.fillRect(x2, y, bw, bh); text(g, 'Buffer tank', x2 + 6, y + 16, '#fff'); text(g, `${fmt(Tt, 4)} °C`, x2 + 6, y + 34, '#fff');
    const x3 = x2 + bw + 70; g.fillStyle = on ? col(Tsup) : th.bg2; g.fillRect(x3, y, bw, bh); text(g, on ? 'SMA cells (running)' : 'SMA cells (off)', x3 + 6, y + 16, on ? '#fff' : th.mute); text(g, `arrival ${fmt(Tsup, 4)} °C`, x3 + 6, y + 34, on ? '#fff' : th.mute);
    arrow(g, 20 + bw + 4, y + bh / 2, 60, 0, '#f97316', 1 + 10 * Qi / qmax, `${fmt(Qi, 3)} W`);
    arrow(g, x2 + bw + 4, y + bh / 2, 60, 0, '#ef4444', 1 + 10 * Qe / qmax, `${fmt(Qe, 3)} W`);
    text(g, `T_req ${fmt(A.ThReq, 3)} °C · Af(σH) ${fmt(A.AfH, 3)} °C`, x3 + bw + 10, y + 16, th.mute);
    const py = y + bh + 30, ph = (H - py - 10) / 2 - 6;
    seriesPanel(g, { x: 10, y: py, w: W - 20, h: ph, T: R.t, t, title: 'Temperatures', unit: '°C', series: [{ name: 'source', y: R.Tsrc, color: '#f97316' }, { name: 'tank', y: R.Tt, color: '#facc15' }, { name: 'arrival', y: R.Tsup, color: '#ef4444' }], hlines: [{ y: A.ThReq, label: 'T_req', color: '#22c55e' }, { y: A.AfH, label: 'Af(σH)', color: '#ef4444' }] });
    seriesPanel(g, { x: 10, y: py + ph + 12, w: W - 20, h: ph, T: R.t, t, title: 'Heat rates', unit: 'W', series: [{ name: 'into buffer', y: R.Qin, color: '#f97316' }, { name: 'engine draw', y: R.Qeng, color: '#38bdf8' }], hlines: [{ y: A.Qd, label: 'demand', color: '#a855f7' }] });
  } });
}
