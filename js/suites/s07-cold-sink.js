// Suite 07 — Cold sink and heat rejection. Rates five sink technologies against the engine's rejected heat, finds the
// achievable coolant supply temperature at the cells, the minimum ribbon temperature actually reached in the cold phase
// versus Mf(σL) (reset completion), the sink auxiliary power and its effect on net output, the hour-by-hour variation
// with live weather, and the water consumption of evaporative options.
import { fluid, fluidOptions, effectivenessNTU, wetBulb, pumpPower, darcy, carnot, KELVIN } from '../core/heat.js';
import { designWith, engineModel } from '../core/engine.js';
import { get as getMat } from '../core/materials.js';
import { forecast, nasaPowerClimatology, hourlyTable } from '../core/live.js';
import { brent, interp1, linspace, range, fmt, clamp } from '../core/num.js';

const TYPES = [{ value: 'chiller', label: 'Laboratory chiller / refrigerated bath' }, { value: 'cw', label: 'Circulating cooling water (utility)' }, { value: 'tower', label: 'Wet cooling tower (with isolation exchanger)' }, { value: 'dry', label: 'Dry air cooler (finned coil + fans)' }, { value: 'ground', label: 'Ground / river water' }];
const P_ATM = 101325, G = 9.80665, HFG = 2.43e6;
const pause = async (ctx) => { try { await ctx.yield?.(); } catch { /* headless run: no animation frame available */ } };
const timed = (p, ms) => { let to; return Promise.race([p, new Promise((_, rej) => { to = setTimeout(() => rej(new Error(`no response within ${(ms / 1000).toFixed(0)} s`)), ms); to?.unref?.(); })]).finally(() => clearTimeout(to)); };
// moist-air psychrometrics (Magnus–Tetens saturation, ideal-gas mixture), SI: h in J/kg dry air
const psat = (T) => 610.94 * Math.exp(17.625 * T / (T + 243.04));
const wOf = (pv, p = P_ATM) => 0.622 * pv / Math.max(1, p - pv);
const hAir = (T, w) => 1006 * T + w * (2.501e6 + 1860 * T);
const hSat = (T, p) => hAir(T, wOf(psat(T), p));
const TfromHsat = (h, p) => brent(T => hSat(T, p) - h, -40, 99).x;
// Braun–Klein–Mitchell counterflow cooling-tower effectiveness (air-side, enthalpy-driven), valid for m* ≠ 1 and m* = 1
const epsTower = (NTU, m) => (Math.abs(1 - m) < 1e-9 ? NTU / (1 + NTU) : (1 - Math.exp(-NTU * (1 - m))) / (1 - m * Math.exp(-NTU * (1 - m))));

export default {
  description: 'Rates the cold sink against the heat the engine actually rejects: chillers, cooling water, wet towers (approach to the live wet-bulb), dry coolers and ground/river water. It reports the coolant temperature reaching the cells, the lowest ribbon temperature reached in the cold phase against Mf(σL) — flagging when the sink cannot complete the reset — the sink auxiliary power and its effect on net output, hourly variation from the forecast and evaporative water use.',
  literature: 'cooling tower effectiveness model dry cooler fan power heat rejection low temperature heat engine water consumption',
  econ: true, sustain: true, credibility: 'Analytical screening',
  equations: [
    'Rejected heat Q_rej = Q_hot − P_gross (shared engine model, per supply temperature)',
    'Loop: T_ret = T_sup + Q_rej/(ṁc_p); intermediate exchanger Q = ε·C_min·(T_ret − T_sink), ε = ε(NTU, C_r)',
    'Wet tower (Braun et al. 1989): Q = ε_a·ṁ_a·[h_sat(T_w,in) − h_a,in], ε_a = [1 − e^(−NTU(1−m*))]/[1 − m*·e^(−NTU(1−m*))], m* = ṁ_a·c_s/(ṁ_w c_pw), c_s = dh_sat/dT, NTU = c·(ṁ_w/ṁ_a)^(−n)',
    'Wet-bulb temperature (Stull 2011) from live T and RH; approach = T_w,out − T_wb ≥ 0',
    'Evaporation ṁ_evap = ṁ_a·(w_out − w_in) with saturated exhaust air; blow-down = ṁ_evap/(COC − 1); drift = f_d·ṁ_w',
    'Dry cooler: Q = ε_cross(NTU, C_r)·C_min·(T_ret − T_a); fan power P = V̇_a·Δp_a/η_fan',
    'Chiller: COP = η_II·T_ev/(T_cond − T_ev), T_cond = T_a + ΔT_cond; capacity Q_cap(T_ev, T_a) with linear derating',
    'Pump power P = (Δp + ρgΔz)·V̇/η; supply-line gain T_sup = T_a + (T_dev − T_a)·exp(−U′L/(ṁc_p))',
    'Reset criterion: minimum thickness-averaged ribbon temperature ≤ Mf(σL) = Mf + σL/C_M and ξ_max ≥ 0.95 (transient cell model)',
    'Net effect: P_net,plant = P_net(T_sup) − P_sink',
  ],
  methods: [
    'Shared engine model at 4 coolant temperatures (T_req − 4 … T_req + 10 °C) → Q_rej(T), P_net(T), min ribbon T, ξ_max; one exact run at the achieved T_sup verifies the interpolation',
    'Sink equilibrium solved with Brent’s method on the warm-water temperature (tower) or in closed form (ε-NTU devices)',
    'Live hourly ambient temperature/RH (48 h from local midnight) with a timeout; fallback to NASA POWER monthly climatology, then to an offline design day; provenance attached to every derived quantity',
    'Hour-by-hour evaluation of every sink state, net power and water use; 13 × 13 parameter maps of supply temperature',
    'Side-by-side comparison of all five sink technologies at identical ambient and load',
  ],
  assumptions: [
    'Lewis number unity in the tower (Merkel/Braun); exhaust air saturated; tower NTU correlation constants c, n are representative of film fill — use the manufacturer’s curve when available',
    'Dry-cooler UA fixed at the design air flow (finned coil, crossflow, both fluids unmixed)',
    'Chiller second-law efficiency constant (η_II ≈ 0.45); capacity derating −1.2 %/K above 35 °C ambient and +3 %/K of evaporator temperature',
    'Engine rejected heat depends only on coolant supply temperature (fixed loop flow from the engine ΔT design)',
    'Ground/river temperature from the annual-mean air temperature (climatology) when live; user value otherwise',
  ],
  ibc: {
    initial: ['Steady periodic engine operation at each coolant temperature (cell model after 3 cycles)'],
    boundary: ['Ambient dry-bulb, RH and pressure (live forecast / climatology / design day)', 'Sink temperatures: chiller set-point, utility water, ground/river water', 'Engine cold-loop flow from the shared engine hydraulics (ΔT design)'],
  },
  cvv: {
    calibration: ['Tower NTU constants (c, n) from a vendor rating or a measured approach at two water/air ratios', 'Dry-cooler UA from a measured duty at known air flow', 'Chiller COP map from the data sheet'],
    verification: ['Stull wet-bulb benchmark (20 °C, 50 % RH → 13.7 °C)', 'Tower energy closure: water-side = air-side enthalpy rise', 'Second law: tower water ≥ wet bulb, dry cooler ≥ dry bulb', 'Engine interpolation vs exact run at the achieved temperature', 'η ≤ η_Carnot'],
    validation: ['Measured heat rejection (ṁ, ΔT) and auxiliary consumption (fan/pump/compressor power) — spec Module 07 evidence'],
  },
  formats: { import: ['CSV weather station (time, T, RH, p)', 'Tower/dry-cooler rating sheets'], export: ['CSV of hourly results and maps', 'PNG/SVG charts', 'JSON coupling outputs'] },
  params: [
    { key: 'sinkType', label: 'Heat-sink type', type: 'select', options: TYPES, default: 'chiller', group: 'Sink', auto: (c) => { const a = String(c.engine.application || ''); return /lab/i.test(a) ? { value: 'chiller', prov: 'calc' } : /indus|waste|process/i.test(a) ? { value: 'tower', prov: 'calc' } : /solar|remote|field/i.test(a) ? { value: 'dry', prov: 'calc' } : undefined; } },
    { key: 'TcReq', label: 'Required coolant supply temperature at the cells', unit: '°C', type: 'number', min: -10, max: 60, step: 0.5, default: 15, group: 'Sink', auto: (c) => ({ value: c.engine.Tc, prov: 'calc' }) },
    { key: 'coldFluid', label: 'Engine cold-circuit fluid', type: 'select', options: fluidOptions.filter(o => o.value !== 'fl-air'), default: 'fl-water', group: 'Sink', auto: (c) => ({ value: c.engine.coldFluid, prov: 'calc' }) },
    { key: 'Th', label: 'Hot fluid temperature at the cells', unit: '°C', type: 'number', min: 20, max: 200, step: 0.5, default: 70, group: 'Sink', help: 'Taken from Suite 06 (fluid arrival temperature) when available.', auto: (c) => { const t = c.upstream('s06')?.ThSupply_C; return Number.isFinite(t) ? { value: +t.toFixed(2), prov: 'coupled' } : { value: c.engine.Th, prov: 'calc' }; } },
    { key: 'auxFixed', label: 'Sink controls & instrumentation', unit: 'W', type: 'number', min: 0, max: 500, step: 1, default: 5, group: 'Sink' },
    { key: 'Tset', label: 'Chiller set-point (evaporator leaving)', unit: '°C', type: 'number', min: -10, max: 40, step: 0.5, default: 12, group: 'Chiller', auto: (c) => ({ value: c.engine.Tc - 3, prov: 'calc' }) },
    { key: 'chillerCap', label: 'Chiller rated capacity (35 °C ambient)', unit: 'W', type: 'number', min: 100, max: 1e6, step: 100, default: 5000, group: 'Chiller' },
    { key: 'etaII', label: 'Chiller second-law efficiency', unit: '', type: 'number', min: 0.1, max: 0.7, step: 0.01, default: 0.45, group: 'Chiller' },
    { key: 'dTcond', label: 'Condenser approach to ambient', unit: 'K', type: 'number', min: 3, max: 25, step: 0.5, default: 12, group: 'Chiller' },
    { key: 'Tcw', label: 'Utility cooling-water supply temperature', unit: '°C', type: 'number', min: 2, max: 40, step: 0.5, default: 20, group: 'Cooling water / ground' },
    { key: 'mdotSink', label: 'Sink-side water flow (utility, river or borehole loop)', unit: 'kg/s', type: 'number', min: 0.01, max: 50, step: 0.01, default: 0.3, group: 'Cooling water / ground' },
    { key: 'UAiso', label: 'Isolation exchanger UA (utility, tower, ground)', unit: 'W/K', type: 'number', min: 10, max: 1e5, step: 10, default: 2500, group: 'Cooling water / ground' },
    { key: 'dpSink', label: 'Sink-side loop pressure drop', unit: 'Pa', type: 'number', min: 0, max: 5e5, step: 1000, default: 40000, group: 'Cooling water / ground' },
    { key: 'Tground', label: 'Ground / river water temperature (offline value)', unit: '°C', type: 'number', min: 0, max: 35, step: 0.5, default: 18, group: 'Cooling water / ground', help: 'Replaced by the site annual-mean air temperature from climatology when live data are available.' },
    { key: 'lift', label: 'Static lift (river intake / tower basin)', unit: 'm', type: 'number', min: 0, max: 100, step: 0.5, default: 3, group: 'Cooling water / ground' },
    { key: 'LG', label: 'Tower water/air mass ratio L/G', unit: '', type: 'number', min: 0.3, max: 3, step: 0.05, default: 1.0, group: 'Wet cooling tower' },
    { key: 'towerFlow', label: 'Tower water flow', unit: 'kg/s', type: 'number', min: 0.01, max: 50, step: 0.01, default: 0.2, group: 'Wet cooling tower' },
    { key: 'towerC', label: 'Fill NTU constant c', unit: '', type: 'number', min: 0.3, max: 4, step: 0.05, default: 1.3, group: 'Wet cooling tower', expert: true },
    { key: 'towerN', label: 'Fill NTU exponent n', unit: '', type: 'number', min: 0.3, max: 1, step: 0.05, default: 0.6, group: 'Wet cooling tower', expert: true },
    { key: 'coc', label: 'Cycles of concentration', unit: '', type: 'number', min: 1.5, max: 10, step: 0.5, default: 4, group: 'Wet cooling tower' },
    { key: 'drift', label: 'Drift loss fraction', unit: '', type: 'number', min: 0, max: 0.005, step: 0.0001, default: 0.0002, group: 'Wet cooling tower' },
    { key: 'dpFanTower', label: 'Tower air-side pressure drop', unit: 'Pa', type: 'number', min: 20, max: 500, step: 5, default: 150, group: 'Wet cooling tower' },
    { key: 'UAdry', label: 'Dry-cooler UA (at design air flow)', unit: 'W/K', type: 'number', min: 10, max: 1e5, step: 10, default: 900, group: 'Dry air cooler' },
    { key: 'airFlow', label: 'Dry-cooler air flow', unit: 'm³/s', type: 'number', min: 0.05, max: 50, step: 0.05, default: 0.8, group: 'Dry air cooler' },
    { key: 'dpFanDry', label: 'Dry-cooler air-side pressure drop', unit: 'Pa', type: 'number', min: 10, max: 400, step: 5, default: 90, group: 'Dry air cooler' },
    { key: 'fanEta', label: 'Fan + motor efficiency', unit: '', type: 'number', min: 0.1, max: 0.8, step: 0.01, default: 0.5, group: 'Dry air cooler' },
    { key: 'weatherSrc', label: 'Ambient data', type: 'select', options: [{ value: 'forecast', label: 'Live hourly forecast at the project site' }, { value: 'climatology', label: 'Live monthly climatology (NASA POWER)' }, { value: 'design', label: 'Offline design day' }], default: 'forecast', group: 'Ambient', help: 'Falls back forecast → climatology → design day when offline.' },
    { key: 'TaDesign', label: 'Design-day maximum dry-bulb (offline)', unit: '°C', type: 'number', min: -20, max: 50, step: 0.5, default: 32, group: 'Ambient' },
    { key: 'RHDesign', label: 'Design-day mean relative humidity (offline)', unit: '%', type: 'number', min: 5, max: 100, step: 1, default: 60, group: 'Ambient' },
    { key: 'designHour', label: 'Design point', type: 'select', options: [{ value: 'worst', label: 'Worst hour of the horizon (hottest sink)' }, { value: 'now', label: 'Current hour' }], default: 'worst', group: 'Ambient' },
    { key: 'liveTimeout', label: 'Live-data timeout', unit: 's', type: 'number', min: 1, max: 30, step: 1, default: 6, group: 'Ambient', expert: true },
    { key: 'pipeL', label: 'Coolant line length (one way)', unit: 'm', type: 'number', min: 0.2, max: 500, step: 0.1, default: 6, group: 'Coolant line' },
    { key: 'pipeD', label: 'Coolant line inner diameter', unit: 'm', type: 'number', min: 0.004, max: 0.3, step: 0.001, default: 0.02, group: 'Coolant line' },
    { key: 'pipeUL', label: 'Line heat-gain coefficient U′', unit: 'W/(m·K)', type: 'number', min: 0, max: 5, step: 0.01, default: 0.25, group: 'Coolant line' },
    { key: 'elecPrice', label: 'Electricity price', unit: 'USD/kWh', type: 'number', min: 0, max: 1, step: 0.01, default: 0.15, group: 'Economics & sustainability' },
    { key: 'waterPrice', label: 'Make-up water price', unit: 'USD/m³', type: 'number', min: 0, max: 20, step: 0.1, default: 2, group: 'Economics & sustainability' },
    { key: 'gridCO2', label: 'Grid carbon intensity', unit: 'kg/kWh', type: 'number', min: 0, max: 1.2, step: 0.01, default: 0.45, group: 'Economics & sustainability' },
    { key: 'engNodes', label: 'Engine model through-thickness nodes', unit: '', type: 'number', min: 1, max: 6, step: 1, default: 2, group: 'Numerics', expert: true },
    { key: 'engSteps', label: 'Engine model steps per cycle', unit: '', type: 'number', min: 80, max: 400, step: 10, default: 150, group: 'Numerics', expert: true },
    { key: 'mapN', label: 'Parameter-map resolution', unit: '', type: 'number', min: 5, max: 25, step: 1, default: 13, group: 'Numerics', expert: true },
  ],
  presets: [
    { label: 'Laboratory chiller 12 °C', values: { sinkType: 'chiller', Tset: 12, chillerCap: 5000 } },
    { label: 'Wet tower, humid tropics', values: { sinkType: 'tower', LG: 1.0, towerFlow: 0.25, weatherSrc: 'forecast' } },
    { label: 'Dry cooler, glycol loop', values: { sinkType: 'dry', coldFluid: 'fl-eg50', UAdry: 1200, airFlow: 1.2 } },
    { label: 'River water 18 °C', values: { sinkType: 'ground', Tground: 18, mdotSink: 0.4, lift: 5 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [] };
    const kpi = (label, value, unit, explain, prov = 'calc', status) => out.kpis.push({ label, value, unit, explain, prov, status });
    const d = designWith(ctx.engine, { Tc: p.TcReq, Th: p.Th, coldFluid: p.coldFluid });
    const mat = getMat(d.alloy) || getMat('niti-lt');
    const MfL = mat.Mf + d.sigmaL / mat.CM, MsL = mat.Ms + d.sigmaL / mat.CM;
    // ---- engine rejection vs coolant temperature ----
    ctx.progress(0.05, 'engine rejection vs coolant temperature');
    const cellRun = (Tc) => { const E = engineModel(designWith(d, { Tc }), { mat, n: p.engNodes, stepsPerCycle: p.engSteps, cycles: 3 }); return { Tc, Q: E.QrejTot, P: E.Pnet, Tmin: Math.min(...E.cell.hist.Tm), xiMax: E.cell.xiMax, E }; };
    const TcMax = d.Th - 8, uniq = (a) => [...new Set(a.map(t => +clamp(t, -20, TcMax).toFixed(3)))].sort((x, y) => x - y);
    let Tgrid = uniq([p.TcReq, p.TcReq + 10]), runs = []; for (const Tc of Tgrid) { runs.push(cellRun(Tc)); await pause(ctx); }
    const cT = (T) => clamp(T, Tgrid[0] - 3, Tgrid[Tgrid.length - 1]);
    const QR = (T) => Math.max(0, interp1(Tgrid, runs.map(r => r.Q), cT(T), 'linear')), PN = (T) => interp1(Tgrid, runs.map(r => r.P), cT(T), 'linear');
    const TMIN = (T) => Math.max(T, interp1(Tgrid, runs.map(r => r.Tmin), cT(T), 'linear')), XIMAX = (T) => clamp(interp1(Tgrid, runs.map(r => r.xiMax), cT(T), 'linear'), 0, 1);
    const Edes = runs[1].E, mdotC = Edes.mdotC, fpC = fluid(d.coldFluid, d.Tc + d.fluidDT / 2), Cc = mdotC * fpC.cp;
    // ---- ambient: live forecast → climatology → design day ----
    ctx.progress(0.3, 'ambient data');
    const site = ctx.site || { lat: 0, lon: 0 }, ms = 1000 * p.liveTimeout, Hh = 48;
    const settle = (pr) => pr.then(r => ({ r }), e => ({ e })); // concurrent requests: worst-case wait is one timeout
    const fP = p.weatherSrc === 'forecast' ? settle(timed(forecast(site.lat, site.lon), ms)) : null, cP = p.weatherSrc !== 'design' || p.sinkType === 'ground' ? settle(timed(nasaPowerClimatology(site.lat, site.lon), ms)) : null;
    let wx = null, wxProv = 'hypothetical', wxNote = '', pAtm = P_ATM, TgroundUse = p.Tground, groundProv = 'user';
    if (p.weatherSrc === 'forecast') {
      try {
        const fr = await fP; if (fr.e) throw fr.e; const r = fr.r, T = hourlyTable(r.data);
        let i0 = T.time.findIndex((t, i) => i >= 24 && /T00:00$/.test(t) && Date.parse(t + 'Z') - T.utcOffset * 1000 > Date.now() - 86400e3); if (i0 < 0) i0 = 0;
        const nowMs = Date.now() + T.utcOffset * 1000;
        const pts = range(Hh).map(h => ({ h, time: T.time[i0 + h], Ta: T.temperature_2m[i0 + h], RH: T.relative_humidity_2m[i0 + h], p: T.surface_pressure_Pa[i0 + h], soil: T.soil_temperature_6cm?.[i0 + h] })).filter(x => Number.isFinite(x.Ta) && Number.isFinite(x.RH));
        if (pts.length > 0.8 * Hh) { wx = pts; wxProv = 'live'; wx.nowIdx = clamp(pts.findIndex(x => Date.parse(x.time + 'Z') >= nowMs - 3600e3), 0, pts.length - 1); wxNote = `${r.meta.name}: hourly forecast from ${pts[0].time} (local), fetched ${r.meta.fetched.slice(0, 16).replace('T', ' ')} UTC${r.meta.cached ? ` (cached ${r.meta.ageMin} min)` : ''}. Forecast-model fields, not station observations.`; }
      } catch (e) { wxNote = `Live forecast unavailable (${e.message}); `; }
    }
    if ((!wx && p.weatherSrc !== 'design') || p.sinkType === 'ground') {
      try {
        const cr = await cP; if (cr.e) throw cr.e; const r = cr.r, P = r.data.properties.parameter;
        if (Number.isFinite(P.T2M?.ANN) && P.T2M.ANN > -900) { TgroundUse = P.T2M.ANN; groundProv = 'live'; }
        if (!wx && p.weatherSrc !== 'design') {
          const m = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][new Date().getMonth()], tmx = P.T2M_MAX[m], tmn = P.T2M_MIN[m], rh = P.RH2M[m];
          if ([tmx, tmn, rh].every(v => Number.isFinite(v) && v > -900)) { wx = diurnal(tmx, tmn, rh, Hh); wxProv = 'live'; wxNote += `${r.meta.name}: ${m} mean daily range ${fmt(tmn, 3)}–${fmt(tmx, 3)} °C, RH ${fmt(rh, 3)} % shaped as a diurnal cycle (climatological mean, not a forecast).`; }
        }
      } catch (e) { if (!wx && p.weatherSrc !== 'design') wxNote += `climatology unavailable (${e.message}); `; }
    }
    if (!wx) { wx = diurnal(p.TaDesign, p.TaDesign - 9, p.RHDesign, Hh); wxNote += `Offline design day ${fmt(p.TaDesign - 9, 3)}–${fmt(p.TaDesign, 3)} °C, RH ≈ ${p.RHDesign} % (hypothetical).`; }
    wx.forEach(r => { r.Twb = wetBulb(r.Ta, clamp(r.RH, 5, 99)); r.p = Number.isFinite(r.p) && r.p > 5e4 ? r.p : P_ATM; });
    // ---- sink device models: return { Tdev (coolant leaving the sink toward the cells), Psink, water [kg/s], info } ----
    const fpW = fluid('fl-water', 25);
    const isoTret = (Tsink, mS, Q) => { const Ch = Cc, Cs = mS * fpW.cp, Cmin = Math.min(Ch, Cs), e = effectivenessNTU(p.UAiso / Cmin, Cmin / Math.max(Ch, Cs), 'counter'); return { Tret: Tsink + Q / (e * Cmin), eps: e }; };
    const sink = (type, Q, env) => {
      const Ta = env.Ta, RH = clamp(env.RH, 5, 99), pa = env.p || P_ATM, auxBase = p.auxFixed;
      if (type === 'chiller') {
        const cap = (Tev) => p.chillerCap * (1 + 0.03 * (Tev - p.Tset)) * (1 - 0.012 * Math.max(0, Ta - 35));
        let Tdev = p.Tset, sat = false; if (Q > cap(p.Tset)) { sat = true; Tdev = p.Tset + (Q / cap(p.Tset) - 1) / 0.03; }
        const Tev = Tdev - 4 + KELVIN, Tcd = Ta + p.dTcond + KELVIN, COP = Tcd > Tev ? p.etaII * Tev / (Tcd - Tev) : 20;
        const Pp = pumpPower(25000, mdotC / fpC.rho, d.pumpEta);
        return { Tdev, Psink: Q / Math.min(COP, 20) + Pp + auxBase, water: 0, info: { COP, saturated: sat, capacity: cap(Tdev), Tev: Tev - KELVIN, Tcond: Tcd - KELVIN, pump: Pp } };
      }
      if (type === 'cw' || type === 'ground') {
        const Ts = type === 'cw' ? p.Tcw : TgroundUse, { Tret, eps } = isoTret(Ts, p.mdotSink, Q);
        const Pp = pumpPower(p.dpSink + (type === 'ground' ? fpW.rho * G * p.lift : 0), p.mdotSink / fpW.rho, d.pumpEta);
        return { Tdev: Tret - Q / Cc, Psink: Pp + auxBase, water: 0, info: { eps, Tsink: Ts, sinkOut: Ts + Q / (p.mdotSink * fpW.cp), pump: Pp } };
      }
      if (type === 'tower') {
        const mw = p.towerFlow, ma = mw / p.LG, wIn = wOf(RH / 100 * psat(Ta), pa), hIn = hAir(Ta, wIn), Twb = wetBulb(Ta, RH);
        const NTU = p.towerC * (mw / ma) ** (-p.towerN);
        const qTower = (Twi) => { const Two = Twi - Q / (mw * fpW.cp), cs = (hSat(Twi, pa) - hSat(Math.max(Two, Twb - 5), pa)) / Math.max(1e-6, Twi - Math.max(Two, Twb - 5)), m = ma * cs / (mw * fpW.cp); return epsTower(NTU, m) * ma * (hSat(Twi, pa) - hIn); };
        const hiT = Math.min(Twb + 45, 95), f = (Twi) => qTower(Twi) - Q; // single physical root on the rising branch (below boiling)
        const Twi = f(Twb + 1e-3) >= 0 ? Twb + 1e-3 + Q / (mw * fpW.cp) : f(hiT) < 0 ? NaN : brent(f, Twb + 1e-3, hiT).x;
        const Two = Twi - Q / (mw * fpW.cp), { Tret, eps } = isoTret(Two, mw, Q);
        const hOut = hIn + Q / ma, TaOut = TfromHsat(hOut, pa), wOut = wOf(psat(TaOut), pa), evap = Math.max(0, ma * (wOut - wIn));
        const blow = evap / Math.max(0.5, p.coc - 1), dr = p.drift * mw, rhoA = pa / (287.05 * (Ta + KELVIN));
        const Pfan = ma / rhoA * p.dpFanTower / p.fanEta, Pp = pumpPower(p.dpSink + fpW.rho * G * p.lift, mw / fpW.rho, d.pumpEta);
        return { Tdev: Tret - Q / Cc, Psink: Pfan + Pp + auxBase, water: evap + blow + dr, info: { Twb, Twi, Two, approach: Two - Twb, range: Twi - Two, NTU, epsIso: eps, evap, blow, drift: dr, Pfan, pump: Pp, ma, hIn, hOut, wIn, wOut, TaOut } };
      }
      // dry cooler (coolant flows directly through the coil)
      const rhoA = pa / (287.05 * (Ta + KELVIN)), Ca = p.airFlow * rhoA * 1006, Cmin = Math.min(Ca, Cc), Cr = Cmin / Math.max(Ca, Cc), e = effectivenessNTU(p.UAdry / Cmin, Cr, 'cross');
      const Tret = Ta + Q / (e * Cmin), Pfan = p.airFlow * p.dpFanDry / p.fanEta;
      return { Tdev: Tret - Q / Cc, Psink: Pfan + auxBase, water: 0, info: { eps: e, Tret, airOut: Ta + Q / Ca, Pfan } };
    };
    const decay = Math.exp(-p.pipeUL * p.pipeL / Math.max(Cc, 1e-9)), toCells = (Tdev, Ta) => Ta + (Tdev - Ta) * decay;
    // self-consistent operating point: Q_rej depends on the coolant temperature reaching the cells
    const operate = (type, env) => { let Tsup = p.TcReq, s = null; for (let it = 0; it < 30; it++) { s = sink(type, QR(Tsup), env); const Tn = toCells(s.Tdev, env.Ta); if (!Number.isFinite(Tn)) return { ...s, Tsup: NaN, Q: QR(Tsup), ok: false }; if (Math.abs(Tn - Tsup) < 1e-4) { Tsup = Tn; break; } Tsup = 0.5 * Tsup + 0.5 * Tn; } return { ...s, Tsup, Q: QR(Tsup), ok: true }; };
    // ---- design point and hourly variation ----
    ctx.progress(0.45, 'design point & hourly variation');
    let hourly = wx.map(env => ({ env, r: operate(p.sinkType, env) }));
    // adaptive refinement: re-evaluate the engine on a grid spanning every coolant temperature reached (this sink over the
    // horizon and all sink types at the hottest hour), so no result relies on extrapolation of the coarse response
    { const hot = wx.reduce((b, r) => (r.Ta > b.Ta ? r : b), wx[0]), reach = hourly.map(h => h.r.Tsup).concat(TYPES.map(t => operate(t.value, hot).Tsup)).filter(Number.isFinite);
      const lo = Math.min(p.TcReq, ...reach) - 1, hi = Math.max(p.TcReq, ...reach) + 1, nG = clamp(Math.ceil((hi - lo) / 4) + 1, 3, 7);
      const want = uniq(linspace(lo, hi, nG)), have = new Map(Tgrid.map((t, i) => [t, runs[i]]));
      for (const t of want) if (!have.has(t)) { have.set(t, cellRun(t)); await pause(ctx); }
      Tgrid = uniq([...have.keys()]); runs = Tgrid.map(t => have.get(t));
      hourly = wx.map(env => ({ env, r: operate(p.sinkType, env) })); }
    const di = p.designHour === 'now' ? (wx.nowIdx ?? 12) : hourly.reduce((b, h, i) => (h.r.Tsup > hourly[b].r.Tsup || !Number.isFinite(h.r.Tsup) ? i : b), 0);
    const envD = wx[di], D = hourly[di].r;
    const TcSupply = D.Tsup, Qrej = D.Q;
    const Eex = Number.isFinite(TcSupply) ? cellRun(TcSupply) : null; await pause(ctx);
    const TminRibbon = Eex ? Eex.Tmin : NaN, xiMaxEx = Eex ? Eex.xiMax : 0, resetOK = Eex ? xiMaxEx >= 0.95 : false;
    const PnetEng = Eex ? Eex.P : NaN, Psink = D.Psink, PnetPlant = PnetEng - Psink;
    const interpErr = Eex ? { dT: Math.abs(TMIN(TcSupply) - TminRibbon), Ti: TMIN(TcSupply), Qi: QR(TcSupply) } : null;
    if (Eex && !Tgrid.some(t => Math.abs(t - TcSupply) < 0.05)) { const m = new Map(Tgrid.map((t, i) => [t, runs[i]])); m.set(+TcSupply.toFixed(3), Eex); Tgrid = uniq([...m.keys()]); runs = Tgrid.map(t => m.get(t)); hourly = wx.map(env => ({ env, r: operate(p.sinkType, env) })); }
    const hourlyRows = hourly.map(({ env, r }) => ({ h: env.h, Ta: env.Ta, RH: env.RH, Twb: env.Twb, Tsup: r.Tsup, Tmin: Number.isFinite(r.Tsup) ? TMIN(r.Tsup) : NaN, xi: Number.isFinite(r.Tsup) ? XIMAX(r.Tsup) : 0, Pnet: Number.isFinite(r.Tsup) ? PN(r.Tsup) - r.Psink : NaN, Psink: r.Psink, water: r.water }));
    const hoursReset = hourlyRows.filter(r => r.xi >= 0.95).length, hoursPos = hourlyRows.filter(r => r.Pnet > 0).length;
    const waterDay = hourlyRows.reduce((s, r) => s + r.water * 3600, 0) / (Hh / 24) / 1000; // m³/day
    const EnetDay = hourlyRows.reduce((s, r) => s + Math.max(0, r.Pnet), 0) / (Hh / 24) / 1000; // kWh/day
    // ---- comparison of sink technologies at identical ambient and load ----
    const comp = TYPES.map(t => { const r = operate(t.value, envD); return { type: t.value, label: t.label, Tsup: r.Tsup, Psink: r.Psink, water: r.water, Pnet: Number.isFinite(r.Tsup) ? PN(r.Tsup) - r.Psink : NaN }; });
    // ---- map ----
    ctx.progress(0.7, 'parameter map'); const nM = p.mapN; let map;
    if (p.sinkType === 'tower') { const Ts = linspace(5, 45, nM), RHs = linspace(10, 95, nM); map = { x: { label: 'Ambient dry-bulb [°C]', values: Ts }, y: { label: 'Relative humidity [%]', values: RHs }, z: RHs.map(rh => Ts.map(t => operate('tower', { Ta: t, RH: rh, p: envD.p }).Tsup)), what: 'ambient temperature and humidity — the wet bulb, not the dry bulb, sets the tower limit' }; }
    else if (p.sinkType === 'dry' || p.sinkType === 'chiller') { const Ts = linspace(0, 45, nM), F = linspace(0.3, 3, nM); const key = p.sinkType === 'dry' ? 'airFlow' : 'chillerCap', base = p[key]; map = { x: { label: 'Ambient dry-bulb [°C]', values: Ts }, y: { label: p.sinkType === 'dry' ? 'Air flow [m³/s]' : 'Chiller capacity [W]', values: F.map(f => f * base) }, z: F.map(f => { p[key] = f * base; const row = Ts.map(t => operate(p.sinkType, { Ta: t, RH: envD.RH, p: envD.p }).Tsup); p[key] = base; return row; }), what: p.sinkType === 'dry' ? 'ambient temperature and air flow (fan power rises with flow)' : 'ambient temperature and chiller size' }; }
    else { const key = p.sinkType === 'cw' ? 'Tcw' : 'Tground', Ts = linspace(2, 35, nM), F = linspace(0.2, 3, nM), b1 = p.Tcw, b2 = TgroundUse, bm = p.mdotSink; map = { x: { label: (p.sinkType === 'cw' ? 'Utility water' : 'Ground/river water') + ' temperature [°C]', values: Ts }, y: { label: 'Sink-side flow [kg/s]', values: F.map(f => f * bm) }, z: F.map(f => { p.mdotSink = f * bm; const row = Ts.map(t => { if (key === 'Tcw') p.Tcw = t; else TgroundUse = t; return operate(p.sinkType, envD).Tsup; }); p.Tcw = b1; TgroundUse = b2; p.mdotSink = bm; return row; }), what: 'sink water temperature and flow' }; }
    // ---- verification ----
    { const v = wetBulb(20, 50); out.checks.push({ name: 'Stull wet-bulb benchmark (20 °C, 50 % RH)', value: v, target: '13.7 ± 0.3 °C', pass: Math.abs(v - 13.7) < 0.3 }); }
    out.checks.push({ name: 'Wet bulb ≤ dry bulb at the design hour', value: envD.Twb, target: `≤ ${fmt(envD.Ta, 4)} °C`, pass: envD.Twb <= envD.Ta + 1e-9 });
    if (p.sinkType === 'tower' && D.info) {
      const I = D.info, wSide = p.towerFlow * fpW.cp * I.range, aSide = I.ma * (I.hOut - I.hIn);
      out.checks.push({ name: 'Tower energy closure (water side = air-side enthalpy rise)', value: Math.abs(wSide - aSide) / Math.max(1, Qrej), target: '< 1e-6', pass: Math.abs(wSide - aSide) / Math.max(1, Qrej) < 1e-6, detail: `water ${fmt(wSide, 5)} W, air ${fmt(aSide, 5)} W` });
      out.checks.push({ name: 'Second law: tower cold water ≥ wet bulb (approach ≥ 0)', value: I.approach, target: '≥ 0 K', pass: I.approach >= -1e-6 });
    }
    if (p.sinkType === 'dry') out.checks.push({ name: 'Second law: dry-cooler outlet ≥ ambient dry bulb', value: D.Tdev - envD.Ta, target: '≥ 0 K', pass: D.Tdev >= envD.Ta - 1e-9 });
    if (interpErr) out.checks.push({ name: 'Interpolated engine response vs exact run at the achieved temperature', value: interpErr.dT, target: '< 1 K (min ribbon T; piecewise-linear across the Mf kink)', pass: interpErr.dT < 1, detail: `interpolated ${fmt(interpErr.Ti, 4)} °C vs exact ${fmt(TminRibbon, 4)} °C; Q_rej ${fmt(interpErr.Qi, 4)} vs ${fmt(Eex.Q, 4)} W. The exact run is then added to the response grid used for the hourly analysis.` });
    if (Eex) out.checks.push({ name: 'Engine efficiency ≤ Carnot (fluid temperatures)', value: Eex.E.eta, target: `≤ ${fmt(carnot(d.Th, TcSupply), 4)}`, pass: Eex.E.eta <= carnot(d.Th, TcSupply) + 1e-9 });
    out.checks.push({ name: 'Self-consistent operating point converged', value: Number.isFinite(TcSupply) ? 'yes' : 'no', target: 'yes', pass: Number.isFinite(TcSupply), detail: 'Fixed-point iteration on T_sup ↔ Q_rej(T_sup), tolerance 1e-4 K' });
    out.checks.push({ name: 'Coolant properties within validity range', value: fpC.clamped ? 'clamped' : 'in range', target: 'in range', pass: !fpC.clamped });
    // ---- KPIs ----
    const st = (ok, warn) => ok ? 'ok' : warn ? 'warn' : 'bad', label = TYPES.find(t => t.value === p.sinkType)?.label;
    kpi('Rejected heat', Qrej, 'W', `Heat the engine must reject at the achieved coolant temperature (Q_hot − gross work, shared engine model) at the design hour ${envD.time || `h ${envD.h}`}.`);
    kpi('Coolant supply temperature at the cells', TcSupply, '°C', `What the ${label.toLowerCase()} can actually deliver to the SMA channels at this load and ambient, after exchanger approach and line heat gain. Required: ${p.TcReq} °C.`, wxProv === 'live' && ['tower', 'dry', 'chiller'].includes(p.sinkType) ? 'live' : 'calc', st(TcSupply <= p.TcReq + 0.25, TcSupply < MfL));
    kpi('Minimum ribbon temperature (cold phase)', TminRibbon, '°C', `Lowest thickness-averaged ribbon temperature in the cold phase from the transient cell at the achieved coolant temperature. Must reach Mf(σL) = ${fmt(MfL, 4)} °C for complete forward transformation (ξ_max = ${fmt(xiMaxEx, 3)}).`, 'calc', st(resetOK && TminRibbon <= MfL + 0.5, resetOK));
    kpi('Sink auxiliary power', Psink, 'W', `Fans, pumps${p.sinkType === 'chiller' ? ', compressor' : ''} and controls of the sink only (engine loop pumping is in the engine model).`, 'calc', st(Psink < 0.25 * Math.max(PnetEng, 0), Psink < Math.max(PnetEng, 0)));
    kpi('Net power after sink auxiliaries', PnetPlant, 'W', `Engine P_net at the achieved coolant temperature (${fmt(PnetEng, 4)} W) minus sink auxiliaries.`, 'calc', st(PnetPlant > 0));
    kpi('Ambient dry bulb / wet bulb (design hour)', `${fmt(envD.Ta, 3)} / ${fmt(envD.Twb, 3)}`, '°C', `${wxProv === 'live' ? 'Live' : 'Hypothetical'} ambient at the design hour; wet bulb from Stull (2011). ${wxNote}`, wxProv);
    kpi('Hours with complete reset', hoursReset, `h of ${Hh}`, 'Hours over the horizon in which the coolant temperature lets the ribbon complete the forward (reset) transformation (ξ_max ≥ 0.95).', wxProv, st(hoursReset === Hh, hoursReset > Hh / 2));
    if (p.sinkType === 'tower') kpi('Evaporative water consumption', waterDay, 'm³/day', `Evaporation + blow-down (COC ${p.coc}) + drift; ${EnetDay > 0 ? fmt(waterDay * 1000 / EnetDay, 3) + ' L per kWh of net output' : 'no net output'}.`, wxProv, st(waterDay * 1000 / Math.max(EnetDay, 1e-9) < 50, true));
    else kpi('Water consumption', 0, 'm³/day', 'Closed-circuit sink — no evaporative make-up (utility/river water is returned, warmer).');
    // ---- verdicts ----
    const V = (test, status, detail, fix) => out.verdicts.push({ test, status, detail, fix });
    V('Sink completes the reset (forward transformation)', !Eex ? 'fail' : resetOK && TminRibbon <= MfL + 0.5 ? 'pass' : resetOK ? 'warn' : 'fail', `Coolant at cells ${fmt(TcSupply, 4)} °C → ribbon minimum ${fmt(TminRibbon, 4)} °C vs Mf(σL = ${d.sigmaL} MPa) = ${fmt(MfL, 4)} °C (Ms(σL) = ${fmt(MsL, 4)} °C); cell model ξ_max = ${fmt(xiMaxEx, 3)}.`, `Lower the coolant temperature by ≥ ${fmt(Math.max(1, TminRibbon - MfL + 1), 2)} K (${p.sinkType === 'tower' ? 'larger fill / lower L/G' : p.sinkType === 'dry' ? 'more coil area or air flow, or switch to evaporative/chiller' : p.sinkType === 'chiller' ? 'lower set-point / larger chiller' : 'more sink flow or exchanger area'}), reduce σL, lengthen the cold phase, or choose an alloy with higher Mf.`);
    V('Coolant supply meets the engine requirement', TcSupply <= p.TcReq + 0.25 ? 'pass' : TcSupply < MfL ? 'warn' : 'fail', `${fmt(TcSupply, 4)} °C achieved vs ${p.TcReq} °C required at ${fmt(envD.Ta, 3)} °C ambient.`, 'See the sink comparison chart for technologies that reach the requirement at this ambient.');
    if (p.sinkType === 'chiller') V('Chiller capacity', D.info.saturated ? 'fail' : 'pass', `Load ${fmt(Qrej, 4)} W vs capacity ${fmt(D.info.capacity, 4)} W at ${fmt(envD.Ta, 3)} °C ambient (COP ${fmt(D.info.COP, 3)}).`, 'Select a larger chiller or reduce rejected heat (Suite 09 regeneration lowers Q_hot and hence Q_rej).');
    if (p.sinkType === 'tower') V('Tower approach to wet bulb', D.info.approach >= 3 ? 'pass' : D.info.approach >= 1.5 ? 'warn' : 'fail', `Approach ${fmt(D.info.approach, 3)} K (wet bulb ${fmt(D.info.Twb, 3)} °C, range ${fmt(D.info.range, 3)} K, NTU ${fmt(D.info.NTU, 3)}). Approaches below ≈ 3 K need disproportionately large fill.`, 'Raise L/G toward 1.2–1.5 or reduce the tower flow; accept a warmer coolant.');
    V('Sink auxiliaries vs engine output', Psink < 0.25 * Math.max(PnetEng, 0) ? 'pass' : Psink < Math.max(PnetEng, 0) ? 'warn' : 'fail', `P_sink = ${fmt(Psink, 4)} W vs engine P_net = ${fmt(PnetEng, 4)} W → plant net ${fmt(PnetPlant, 4)} W.`, p.sinkType === 'chiller' ? 'A chiller is a laboratory convenience: its compressor power alone exceeds the engine output. Use free cooling (tower, river, dry cooler) for any net-power claim.' : 'Reduce fan/pump power (lower Δp, variable-speed drives) or share the sink with other loads.');
    V('Ambient data provenance', wxProv === 'live' ? 'pass' : 'warn', wxNote, 'Connect to the internet or import station data for site-specific sink conditions.');
    V('Missing measurements (requested)', 'info', 'No sink measurements imported. Measure: coolant ṁ and ΔT across the sink (heat rejection), fan/pump/compressor electrical power, tower basin temperature vs wet bulb, and make-up water flow.', 'Import data (Import mode) to calibrate the tower constants c, n or the dry-cooler UA.');
    // ---- charts ----
    const hx = hourlyRows.map(r => r.h);
    out.charts.push({ type: 'line', title: 'Hourly sink temperatures vs reset requirement', x: { label: 'Hour from local midnight', unit: 'h' }, y: { label: 'Temperature', unit: '°C' }, series: [{ name: 'Ambient dry bulb', x: hx, y: hourlyRows.map(r => r.Ta), dash: true }, { name: 'Wet bulb', x: hx, y: hourlyRows.map(r => r.Twb), dash: true }, { name: 'Coolant at cells', x: hx, y: hourlyRows.map(r => r.Tsup) }, { name: 'Minimum ribbon T', x: hx, y: hourlyRows.map(r => r.Tmin) }], annotations: [{ type: 'hline', y: MfL, label: 'Mf(σL)', color: '#ef4444' }, { type: 'hline', y: p.TcReq, label: 'T_c required' }, { type: 'vline', x: envD.h, label: 'design hour' }], explain: `Over ${Hh} h (${wxProv === 'live' ? 'live data' : 'hypothetical design day'}), the coolant temperature reaching the cells follows the ${p.sinkType === 'tower' ? 'wet bulb' : p.sinkType === 'dry' ? 'dry bulb' : 'sink temperature'}. Wherever the ribbon minimum rises above the red Mf(σL) line, the cold phase cannot complete the reset and the next power stroke loses work.`, wide: true });
    out.charts.push({ type: 'line', title: 'Hourly net power and sink auxiliaries', x: { label: 'Hour from local midnight', unit: 'h' }, y: { label: 'Power', unit: 'W' }, series: [{ name: 'Plant net (engine − sink)', x: hx, y: hourlyRows.map(r => r.Pnet) }, { name: 'Sink auxiliaries', x: hx, y: hourlyRows.map(r => r.Psink) }], annotations: [{ type: 'hline', y: 0, label: 'break-even' }], explain: 'Engine net power at each hour’s coolant temperature minus the sink’s own fans, pumps and compressor. Negative values mean the sink costs more power than the engine makes.' });
    const lad = [['Ambient dry bulb', envD.Ta], ['Wet bulb', envD.Twb], ...(p.sinkType === 'tower' ? [['Tower cold water', D.info.Two]] : p.sinkType === 'chiller' ? [['Chiller set-point', p.Tset]] : p.sinkType === 'dry' ? [] : [['Sink water', D.info.Tsink]]), ['Coolant leaving sink', D.Tdev], ['Coolant at cells', TcSupply], ['Engine return', TcSupply + Qrej / Cc], ['Min ribbon (material)', TminRibbon], ['Mf(σL) requirement', MfL]];
    out.charts.push({ type: 'bar', title: 'Cold-side temperature ladder (design hour)', categories: lad.map(l => l[0]), series: [{ name: '°C', values: lad.map(l => +(+l[1]).toFixed(2)) }], explain: 'Distinct temperatures from the ultimate sink to the material: each step is a driving difference (tower approach, exchanger approach, line gain, ribbon cooling lag). The material bar must be at or below the Mf(σL) bar.' });
    out.charts.push({ type: 'heatmap', title: `Coolant supply temperature map — ${map.what.split(' (')[0].split(' —')[0]}`, x: map.x, y: map.y, z: map.z, zlabel: 'T at cells [°C]', cmap: 'coolwarm', isolines: 6, explain: `Achievable coolant temperature at the cells versus ${map.what}, with the engine’s temperature-dependent rejection. Compare the isolines with Mf(σL) = ${fmt(MfL, 3)} °C to find where the sink still completes the reset.` });
    out.charts.push({ type: 'bar', title: 'Sink technologies at the same ambient and load', categories: comp.map(c => c.label.split(' (')[0]), series: [{ name: 'Coolant at cells [°C]', values: comp.map(c => +c.Tsup.toFixed(2)) }, { name: 'Sink power [W]', values: comp.map(c => +c.Psink.toFixed(2)) }, { name: 'Plant net [W]', values: comp.map(c => +(+c.Pnet).toFixed(2)) }], explain: `All five technologies evaluated at ${fmt(envD.Ta, 3)} °C / ${fmt(envD.RH, 3)} % RH with their current parameters. Lower coolant temperature helps reset and work, but chiller compressor power or fan power can erase the net gain.`, wide: true });
    const Hc = Eex?.E.cell.hist;
    if (Hc) out.charts.push({ type: 'line', title: 'Ribbon temperatures over one cycle (achieved coolant)', x: { label: 'Time in cycle', unit: 's' }, y: { label: 'Temperature', unit: '°C' }, series: [{ name: 'Fluid', x: Hc.t, y: Hc.Tf, dash: true }, { name: 'Ribbon surface', x: Hc.t, y: Hc.Ts }, { name: 'Ribbon mean', x: Hc.t, y: Hc.Tm }], annotations: [{ type: 'hline', y: MfL, label: 'Mf(σL)', color: '#3b82f6' }, { type: 'hline', y: mat.Af + d.sigmaH / mat.CA, label: 'Af(σH)', color: '#ef4444' }], explain: 'Transient cell solution at the achieved coolant temperature: the fluid switches hot/cold, the ribbon lags. During the cold phase the ribbon mean must drop below Mf(σL) (blue) before the next hot phase.' });
    // ---- tables ----
    const I = D.info || {};
    out.tables.push({ title: 'Design-hour operating point', cols: ['Quantity', 'Value', 'Unit'], rows: [['Sink', label, ''], ...(p.sinkType === 'ground' ? [['Ground/river water temperature', fmt(TgroundUse, 4), `°C (${groundProv === 'live' ? 'site annual-mean air temperature, NASA POWER climatology' : 'user value'})`]] : []), ['Design hour', envD.time || `h ${envD.h}`, ''], ['Ambient / RH / wet bulb', `${fmt(envD.Ta, 4)} / ${fmt(envD.RH, 3)} / ${fmt(envD.Twb, 4)}`, '°C / % / °C'], ['Rejected heat', fmt(Qrej, 4), 'W'], ['Engine cold-loop flow', fmt(mdotC, 4), 'kg/s'], ['Coolant leaving sink', fmt(D.Tdev, 4), '°C'], ['Coolant at cells', fmt(TcSupply, 4), '°C'], ['Min ribbon T / Mf(σL)', `${fmt(TminRibbon, 4)} / ${fmt(MfL, 4)}`, '°C'], ['ξ_max (reset completeness)', fmt(xiMaxEx, 3), ''], ['Sink power', fmt(Psink, 4), 'W'], ['Engine P_net / plant net', `${fmt(PnetEng, 4)} / ${fmt(PnetPlant, 4)}`, 'W'], ...Object.entries(I).filter(([, v]) => typeof v === 'number').map(([k, v]) => [`detail: ${k}`, fmt(v, 4), ''])], explain: 'Self-consistent sink/engine operating point at the design hour. “detail” rows are the internal states of the selected sink model.' });
    out.tables.push({ title: 'Hourly results', cols: ['h', 'T_a °C', 'RH %', 'T_wb °C', 'T_cells °C', 'T_ribbon,min °C', 'ξ_max', 'P_sink W', 'P_net,plant W', 'water L/h'], rows: hourlyRows.map(r => [r.h, fmt(r.Ta, 3), fmt(r.RH, 3), fmt(r.Twb, 3), fmt(r.Tsup, 4), fmt(r.Tmin, 4), fmt(r.xi, 3), fmt(r.Psink, 3), fmt(r.Pnet, 3), fmt(r.water * 3600, 3)]), explain: 'Hour-by-hour sink states from the ambient series; ribbon temperature and power from the interpolated engine response.' });
    // ---- narrative & recommendations ----
    out.explain.push({ title: 'What was computed', text: `The engine’s rejected heat and its sensitivity to coolant temperature come from the shared transient cell model (${fmt(Qrej, 4)} W at ${fmt(TcSupply, 4)} °C). The ${label.toLowerCase()} was solved self-consistently with that load for each of ${Hh} hours of ${wxProv === 'live' ? 'live' : 'design-day'} weather.` });
    out.explain.push({ title: 'Sink vs fluid vs material temperature', text: `Ultimate sink ${p.sinkType === 'tower' ? `wet bulb ${fmt(envD.Twb, 4)} °C` : p.sinkType === 'dry' ? `dry bulb ${fmt(envD.Ta, 4)} °C` : p.sinkType === 'chiller' ? `set-point ${p.Tset} °C` : `water ${fmt(I.Tsink, 4)} °C`} → coolant at the cells ${fmt(TcSupply, 4)} °C → ribbon minimum ${fmt(TminRibbon, 4)} °C. The reset depends on the last of these against Mf(σL) = ${fmt(MfL, 4)} °C.` });
    const rec = (level, text, basis) => out.recs.push({ level, text, basis });
    if (!resetOK) rec('critical', `The sink cannot complete the reset: ribbon minimum ${fmt(TminRibbon, 4)} °C vs Mf(σL) ${fmt(MfL, 4)} °C. ${comp.filter(c => c.Tsup < TcSupply - 2).map(c => c.label.split(' (')[0]).join(', ') || 'No listed sink'} reaches a lower coolant temperature at this ambient.`, 'Reset criterion and sink comparison');
    else if (hoursReset < Hh) rec('warn', `Reset completes in ${hoursReset} of ${Hh} hours; the warmest hours fail. Size the sink for the worst hour or schedule reduced load then.`, 'Hourly reset analysis');
    else rec('good', `Reset completes in every hour of the horizon (ribbon minimum ${fmt(TminRibbon, 4)} °C at the design hour).`, 'Hourly reset analysis');
    if (PnetPlant <= 0) rec('critical', `Sink auxiliaries (${fmt(Psink, 4)} W) exceed the engine net power (${fmt(PnetEng, 4)} W). ${(() => { const b = comp.filter(c => Number.isFinite(c.Pnet)).sort((a, b) => b.Pnet - a.Pnet)[0]; return b ? `Best option at this ambient: ${b.label} (plant net ${fmt(b.Pnet, 4)} W).` : ''; })()}`, 'Sink comparison');
    const best = comp.filter(c => Number.isFinite(c.Pnet)).sort((a, b) => b.Pnet - a.Pnet)[0];
    if (best && best.type !== p.sinkType && best.Pnet > PnetPlant + 0.1) rec('info', `${best.label} would give ${fmt(best.Pnet - PnetPlant, 3)} W more plant net power than the current sink at this ambient.`, 'Sink comparison');
    rec('econ', `Sink electricity ${fmt(Psink * 24 / 1000, 3)} kWh/day costs ${fmt(Psink * 24 / 1000 * p.elecPrice, 3)} USD/day${p.sinkType === 'tower' ? ` plus ${fmt(waterDay * p.waterPrice, 3)} USD/day of make-up water` : ''}, against ${fmt(EnetDay, 3)} kWh/day of plant net output.`, 'Hourly integration');
    if (p.sinkType === 'tower') rec('sustain', `Evaporative cooling consumes ${fmt(waterDay, 3)} m³/day (${EnetDay > 0 ? fmt(waterDay * 1000 / EnetDay, 3) + ' L/kWh' : 'with no net output'}); raising cycles of concentration from ${p.coc} to 6 would cut blow-down by ${fmt(100 * (1 - (p.coc - 1) / 5), 3)} %. In water-stressed sites prefer a dry or hybrid cooler.`, 'Water consumption');
    else rec('sustain', `No evaporative water use; sink electricity ≈ ${fmt(Psink * 24 / 1000 * p.gridCO2, 3)} kg CO₂/day at ${p.gridCO2} kg/kWh${p.sinkType === 'ground' ? '; check the permitted river/ground temperature rise (' + fmt(Qrej / (p.mdotSink * fpW.cp), 3) + ' K at the current flow)' : ''}.`, 'Auxiliary power');
    const anim = { H: Hc, MfL, AfH: mat.Af + d.sigmaH / mat.CA, hourly: hourlyRows, Tsup: TcSupply };
    if (Hc) out.views.push({ label: '2D animation: cold phase and reset', icon: '🎞', render: (el) => animReset(el, anim) });
    out.outputs = { Qrej_W: Qrej, TcSupply_C: TcSupply, TminRibbon_C: TminRibbon, Psink_W: Psink, ambient_C: envD.Ta, wetBulb_C: envD.Twb, sinkType: p.sinkType };
    out.headline = `${label}: coolant reaches the cells at ${fmt(TcSupply, 4)} °C (ambient ${fmt(envD.Ta, 3)} °C, wet bulb ${fmt(envD.Twb, 3)} °C); ribbon minimum ${fmt(TminRibbon, 4)} °C vs Mf(σL) ${fmt(MfL, 4)} °C — reset ${resetOK ? 'complete' : 'INCOMPLETE'}; sink power ${fmt(Psink, 4)} W, plant net ${fmt(PnetPlant, 4)} W.`;
    out.headlineKind = !resetOK || PnetPlant <= 0 ? 'fail' : TcSupply > p.TcReq + 0.25 || hoursReset < Hh ? 'warn' : 'ok';
    out.credibility = 'Analytical screening';
    return out;
  },
};

// diurnal series: minimum at 05:00, maximum at 15:00; RH anti-correlated with temperature around its mean
function diurnal(Tmax, Tmin, RH, n) {
  return range(n).map(h => { const ph = Math.cos(2 * Math.PI * ((h % 24) - 15) / 24), Ta = (Tmax + Tmin) / 2 + (Tmax - Tmin) / 2 * ph; return { h, Ta, RH: clamp(RH - 15 * ph, 8, 98), p: P_ATM }; });
}

async function animReset(el, A) {
  const [{ anim2d, seriesPanel, gauge, label, fs, at, lerp, theme }] = await Promise.all([import('../core/anim2d.js')]);
  const Hc = A.H, P = Hc.t[Hc.t.length - 1] || 1;
  anim2d(el, { duration: P, rate: P / 6, label: 'Time in cycle', unit: 's', height: (W) => W < 640 ? 520 : 440, explain: 'Solved transient cell at the achieved coolant temperature: the fluid switches between hot and cold; the ribbon temperature lags and the martensite fraction ξ must return to 1 during the cold phase (reset). Red dashed: Af(σH); blue dashed: Mf(σL).', draw(g, t, W, H) {
    const th = theme(), k = at(Hc.t, t), Tm = lerp(Hc.Tm, k), xi = lerp(Hc.xi, k), Tf = lerp(Hc.Tf, k), z = fs(W), gr = 32, rEdge = W - 2 * gr - 34;
    const cold = Tf < (A.MfL + A.AfH) / 2, bw = Math.min(180, rEdge - 16); g.fillStyle = cold ? '#1d4ed8' : '#b91c1c'; g.fillRect(16, 12, bw, 26); label(g, cold ? 'COLD phase (reset)' : 'HOT phase (stroke)', 16 + bw / 2, 25, { align: 'center', baseline: 'middle', maxW: bw - 12, size: z, weight: '600', color: '#fff' });
    const rx = 16, rw = rEdge - 16, ry = 48, rh = 24; g.fillStyle = th.bg2; g.fillRect(rx, ry, rw, rh); g.fillStyle = `rgba(59,130,246,${0.25 + 0.7 * xi})`; g.fillRect(rx, ry, rw * (0.96 + 0.04 * xi), rh); label(g, `ribbon: ξ = ${fmt(xi, 3)} martensite, ${fmt(Tm, 4)} °C`, rx + 6, ry + rh / 2, { baseline: 'middle', maxW: rw - 12, size: z, color: th.fg });
    gauge(g, { cx: W - gr - 18, cy: 56, r: gr, value: Tm, min: Math.min(...Hc.Tm) - 1, max: Math.max(...Hc.Tm) + 1, label: 'ribbon T', unit: '°C', cmapName: 'inferno' });
    const ph = (H - 108) / 2;
    seriesPanel(g, { x: 10, y: 92, w: W - 20, h: ph, T: Hc.t, t, title: 'Temperatures', unit: '°C', series: [{ name: 'fluid', y: Hc.Tf, color: '#94a3b8' }, { name: 'surface', y: Hc.Ts, color: '#f97316' }, { name: 'mean', y: Hc.Tm, color: '#facc15' }], hlines: [{ y: A.MfL, label: 'Mf(σL)', color: '#3b82f6' }, { y: A.AfH, label: 'Af(σH)', color: '#ef4444' }] });
    seriesPanel(g, { x: 10, y: 100 + ph, w: W - 20, h: ph, T: Hc.t, t, title: 'Martensite fraction', unit: '', ymin: 0, ymax: 1, series: [{ name: 'ξ', y: Hc.xi, color: '#38bdf8' }] });
  } });
}
