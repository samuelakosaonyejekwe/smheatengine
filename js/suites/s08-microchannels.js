// Suite 08 — Microchannels, contacts and transient heat transfer.
// Hot- and cold-side channel convection (laminar developing / transitional / turbulent duct correlations), the fully
// developed rectangular-duct velocity field (Poisson eigen-series), thermal contact (library conductance or Mikic plastic
// correlation), and 2-D transient conjugate conduction of the ribbon–contact–plate unit cell (P1 FE, enthalpy method for
// the transformation latent heat) with Robin boundaries switching from hot to cold fluid. Delivers heating/cooling times
// to Af(σH) and Mf(σL), the maximum cycle frequency, the thermal-resistance budget, Biot number, gradients, hot/cold
// imbalance, required flow and pumping power, with mesh and time-step independence (GCI) and analytic verification.
import * as ML from '../core/meshlab.js';
import { ductHTC, rectDuct, fluid, fluidOptions, slab1D, slabAnalytic, contactConductance, pumpPower } from '../core/heat.js';
import { SMA } from '../core/sma.js';
import { get as getMat, forUse, componentMaterial, smaAlloys } from '../core/materials.js';
import { fmt, clamp, linspace, gci as gciFn, max } from '../core/num.js';
import { cmap, cssColor, download } from '../core/chart.js';
import { anim2d, seriesPanel, bar, theme, label, fs as fontPx } from '../core/anim2d.js';

const yieldTo = (ctx) => (typeof requestAnimationFrame === 'function' ? ctx.yield() : Promise.resolve());
const designOf = (ctx) => ({ ...ctx.engine, ...(ctx.upstream('s01')?.design || {}) });
const fromDesign = (key, scale = 1, digits = 4) => (ctx) => {
  const up = ctx.upstream('s01')?.design?.[key];
  if (up !== undefined) return { value: typeof up === 'number' ? +(up * scale).toPrecision(digits) : up, prov: 'coupled' };
  const v = ctx.engine?.[key]; return v === undefined ? undefined : { value: typeof v === 'number' ? +(v * scale).toPrecision(digits) : v, prov: 'calc' };
};
const fromSection = (key, scale, digits = 4) => (ctx) => { const s = ctx.upstream('s02')?.section; return s?.[key] !== undefined ? { value: typeof s[key] === 'number' ? +(s[key] * scale).toPrecision(digits) : s[key], prov: 'coupled' } : undefined; };

// Fully developed laminar velocity in a rectangular duct |y| ≤ a, |z| ≤ b (Poisson equation, eigen-series; White,
// Viscous Fluid Flow). Returns u/ū on a grid and the exact fRe for verification against the Shah–London fit.
export function ductVelocity(wid, hgt, nx = 41, ny = 33, terms = 61) {
  const a = wid / 2, b = hgt / 2, coshRatio = (x, X) => Math.exp(Math.abs(x) - X) * (1 + Math.exp(-2 * Math.abs(x))) / (1 + Math.exp(-2 * X));
  let S5 = 0; for (let i = 1; i <= terms; i += 2) S5 += Math.tanh(i * Math.PI * b / (2 * a)) / i ** 5;
  const meanFactor = (a * a / 3) * (1 - 192 * a / (Math.PI ** 5 * b) * S5); // ū·μ/G
  const ys = linspace(-a, a, nx), zs = linspace(-b, b, ny);
  const z = zs.map(zz => ys.map(yy => { let s = 0; for (let i = 1; i <= terms; i += 2) s += (((i - 1) / 2) % 2 ? -1 : 1) * (1 - coshRatio(i * Math.PI * zz / (2 * a), i * Math.PI * b / (2 * a))) * Math.cos(i * Math.PI * yy / (2 * a)) / i ** 3; return 16 * a * a / Math.PI ** 3 * s / meanFactor; }));
  const Dh = 4 * wid * hgt / (2 * (wid + hgt));
  return { ys, zs, z, fRe: 2 * Dh * Dh / meanFactor, umaxOverMean: max(z.flat()) };
}

export default {
  description: 'Predicts how fast the hot and cold fluids can heat the SMA ribbons past Af(σH) and cool them below Mf(σL) through microchannel plates and a thermal contact, from duct convection, contact conductance and a 2-D transient conjugate finite-element model of the ribbon–contact–plate unit cell with transformation latent heat; reports the maximum cycle frequency, the thermal-resistance budget, Biot number, gradients, hot/cold imbalance and the flow and pumping power required.',
  literature: 'microchannel heat transfer shape memory alloy actuator cooling thermal contact resistance transient conjugate',
  econ: true, sustain: true,
  credibility: 'Numerically verified',
  equations: [
    'Duct convection: Nu = Nu_fd(α) + 0.0668 Gz/(1 + 0.04 Gz^(2/3)) (laminar developing, Hausen form; Shah–London Nu_fd), Gnielinski for Re > 4000, linear blend 2300–4000; h = Nu·k_f/D_h',
    'Fully developed duct flow: μ∇²u = dp/dx on |y| ≤ a, |z| ≤ b, u = 0 on walls; eigen-series u = (16a²G/μπ³) Σ_odd (−1)^((i−1)/2)[1 − cosh(iπz/2a)/cosh(iπb/2a)] cos(iπy/2a)/i³',
    'Contact conductance: library h_c, or plastic Mikic correlation h_c = 1.25 k_s (m/σ)(P/H_c)^0.95 with k_s = 2k₁k₂/(k₁+k₂)',
    'Conjugate conduction ∂H/∂t = ∇·(k∇T), H(T) = ρc_pT + ρL_h·ξ(T) (enthalpy method; latent heat absorbed between As(σH) and Af(σH) on heating, released between Ms(σL) and Mf(σL) on cooling, cosine kinetics)',
    'Robin condition on channel walls −k∂T/∂n = h(T − T_f(t)); quasi-steady fluid energy balance at the evaluation station T_f = T_in ∓ φ·2Q′L/(ṁ_ch c_p)',
    'Transformation temperatures under stress (Clausius–Clapeyron): Af(σ) = Af + σ/C_A, Mf(σ) = Mf + σ/C_M',
    'Resistance budget per ribbon face area: R = 1/(h·A_wet/A_face) + t_web/k_wall + 1/h_c + (t/2)/(3k_SMA); Bi = (t/2)/(k_SMA·R_ext)',
    'f_max = 1/(t_heat + t_cool + 2·t_switch); required flow ṁ = E_cycle/(c_p ΔT_f · duty/f); pumping power P = Δp·V̇/η',
    'Richardson extrapolation and GCI for mesh (h) and time-step (Δt) independence',
  ],
  methods: [
    'heat.ductHTC on each side with the realised channel count; fluid properties at the mean fluid temperature',
    'Unit-cell geometry from Suite 02 (section, mesh sizes and selected refinement) or rebuilt from the engine record; graded structured P1 mesh (meshlab)',
    'Implicit-Euler conduction with lumped capacity; enthalpy secant capacity with two Picard passes per step; banded Cholesky (RCM) or Jacobi-PCG depending on size',
    'Heating run from the cold-equilibrium state until the coldest ribbon point exceeds Af(σH); cooling run from the end-of-heating field until the warmest ribbon point falls below Mf(σL); crossing times interpolated',
    'Steady 2-D solve with uniform ribbon heat generation for the conjugate (spreading + fin) resistance',
    'Verification: heat.slab1D (Crank–Nicolson) vs heat.slabAnalytic; meshlab 2-D slab vs analytic; patch test; discrete energy balance; duct eigen-series fRe vs Shah–London; mesh (3 levels, r = √2) and time-step (3 levels, r = 2) GCI',
  ],
  assumptions: [
    'Periodic unit cell across the ribbon width (one channel pitch) and symmetry about the ribbon mid-plane and the shared-plate mid-plane; no axial conduction along the ribbon',
    'Constant (phase-averaged) SMA conductivity; latent heat distributed with cosine kinetics over the stress-shifted transformation band; mechanical work source neglected in the thermal balance (< 5 % of latent heat)',
    'Uniform film coefficient around the channel perimeter (correlation for the duct); flow switching is instantaneous in the 2-D model, valve/purge time added to the cycle',
    'Start of heating from uniform T_c (conservative for heating; the periodic state starts warmer when cooling is truncated)',
    'Contact layer represented as a region of thickness t_c with k = h_c·t_c',
  ],
  ibc: {
    initial: ['Uniform temperature T_c, ribbon fully martensitic (heating run)', 'End-of-heating temperature field, ribbon austenitic (cooling run)'],
    boundary: ['Channel walls: Robin h_hot to T_f,hot(t) during heating, h_cold to T_f,cold(t) during cooling', 'Ribbon mid-plane, plate mid-plane and unit-cell sides: symmetry (adiabatic)', 'Duct velocity: no-slip on all four walls, uniform pressure gradient'],
  },
  cvv: {
    calibration: ['Fit h_c and the film coefficients to instrumented thermal step tests (thermocouple / IR ribbon temperature vs time) — Suite 19'],
    verification: ['FE slab vs analytic eigen-series', 'slab1D (CN) vs analytic', 'patch test', 'energy conservation of the transient', 'duct-series fRe vs Shah–London correlation', 'mesh and time-step GCI'],
    validation: ['Measured heating/cooling times and ribbon temperature histories at the design flow', 'Measured pressure drop vs flow of the plate stack'],
  },
  formats: { import: ['Thermal step test CSV (time, ribbon temperature, fluid temperatures) via Import mode'], export: ['Temperature field VTK / MSH / CSV', 'Temperature histories CSV', 'Results JSON'] },
  params: [
    { key: 'Th', label: 'Hot fluid supply temperature', unit: '°C', type: 'number', min: 10, max: 300, step: 0.5, default: 70, group: 'Thermal conditions', auto: (c) => (c.upstream('s06')?.ThSupply_C !== undefined ? { value: +c.upstream('s06').ThSupply_C.toFixed(2), prov: 'coupled' } : fromDesign('Th')(c)) },
    { key: 'Tc', label: 'Cold fluid supply temperature', unit: '°C', type: 'number', min: -30, max: 150, step: 0.5, default: 15, group: 'Thermal conditions', auto: (c) => (c.upstream('s07')?.TcSupply_C !== undefined ? { value: +c.upstream('s07').TcSupply_C.toFixed(2), prov: 'coupled' } : fromDesign('Tc')(c)) },
    { key: 'sigmaH', label: 'Hot power-stroke stress σH', unit: 'MPa', type: 'number', min: 0, max: 600, step: 5, default: 110, group: 'Thermal conditions', auto: fromDesign('sigmaH') },
    { key: 'sigmaL', label: 'Cold reset stress σL', unit: 'MPa', type: 'number', min: 0, max: 600, step: 5, default: 70, group: 'Thermal conditions', auto: fromDesign('sigmaL') },
    { key: 'station', label: 'Evaluation station along the channel', type: 'select', default: 'mid', options: [{ value: 'inlet', label: 'Inlet (fluid at supply temperature)' }, { value: 'mid', label: 'Mid-length' }, { value: 'outlet', label: 'Outlet (worst case)' }], group: 'Thermal conditions' },
    { key: 'alloy', label: 'Ribbon alloy', type: 'select', options: smaAlloys().map(m => ({ value: m.id, label: m.name })), default: 'niti-lt', group: 'Ribbon', auto: (c) => (c.upstream('s03')?.alloyId ? { value: c.upstream('s03').alloyId, prov: 'coupled' } : fromDesign('alloy')(c)) },
    { key: 't_um', label: 'Ribbon thickness', unit: 'µm', type: 'number', min: 10, max: 2000, step: 5, default: 100, group: 'Ribbon', auto: fromDesign('ribbonT', 1e6) },
    { key: 'w_mm', label: 'Ribbon width', unit: 'mm', type: 'number', min: 0.5, max: 100, step: 0.1, default: 5, group: 'Ribbon', auto: fromDesign('ribbonW', 1e3) },
    { key: 'L_mm', label: 'Ribbon / channel length', unit: 'mm', type: 'number', min: 10, max: 1000, step: 1, default: 100, group: 'Ribbon', auto: fromDesign('ribbonL', 1e3) },
    { key: 'nRib', label: 'Ribbons per cell', type: 'number', min: 1, max: 200, step: 1, default: 20, group: 'Ribbon', auto: fromDesign('ribbonsPerCell') },
    { key: 'kRibbon', label: 'Ribbon conductivity override (0 = library)', unit: 'W/mK', type: 'number', min: 0, max: 200, step: 0.5, default: 0, group: 'Ribbon', help: '0 uses the phase-averaged library value ½(k_A + k_M).' },
    { key: 'chW_mm', label: 'Channel width', unit: 'mm', type: 'number', min: 0.05, max: 10, step: 0.05, default: 1, group: 'Channels & plates', auto: fromDesign('chW', 1e3) },
    { key: 'chH_mm', label: 'Channel height', unit: 'mm', type: 'number', min: 0.05, max: 10, step: 0.05, default: 0.8, group: 'Channels & plates', auto: fromDesign('chH', 1e3) },
    { key: 'chPerCell', label: 'Channels per cell (target)', type: 'number', min: 1, max: 2000, step: 1, default: 60, group: 'Channels & plates', auto: fromDesign('chPerCell') },
    { key: 'plate', label: 'Plate arrangement', type: 'select', default: 'shared', options: [{ value: 'shared', label: 'Shared plates' }, { value: 'dedicated', label: 'Dedicated plates' }], group: 'Channels & plates', auto: fromSection('plate', 1) },
    { key: 'web_mm', label: 'Web (channel to ribbon face)', unit: 'mm', type: 'number', min: 0.02, max: 3, step: 0.01, default: 0.2, group: 'Channels & plates', auto: fromSection('web', 1e3) },
    { key: 'skin_mm', label: 'Outer skin (dedicated)', unit: 'mm', type: 'number', min: 0.02, max: 3, step: 0.01, default: 0.2, group: 'Channels & plates', auto: fromSection('skin', 1e3) },
    { key: 'plateMat', label: 'Plate material', type: 'select', default: 'ss-316l', options: forUse('channelPlate').map(m => ({ value: m.id, label: m.name })), group: 'Channels & plates', auto: (c) => ({ value: componentMaterial(c.store, 'channelPlate').id, prov: 'library' }) },
    { key: 'contactModel', label: 'Contact conductance model', type: 'select', default: 'material', options: [{ value: 'material', label: 'Interface material (library h_c)' }, { value: 'mikic', label: 'Metal–metal, Mikic plastic correlation' }, { value: 'user', label: 'User value' }], group: 'Contact' },
    { key: 'contactMat', label: 'Interface material', type: 'select', default: 'tim-graphite', options: forUse('contactLayer').map(m => ({ value: m.id, label: m.name })), group: 'Contact', auto: (c) => ({ value: componentMaterial(c.store, 'contactLayer').id, prov: 'library' }) },
    { key: 'tc_um', label: 'Contact layer thickness', unit: 'µm', type: 'number', min: 1, max: 500, step: 1, default: 25, group: 'Contact', auto: fromSection('tc', 1e6) },
    { key: 'P_MPa', label: 'Interface pressure (Mikic)', unit: 'MPa', type: 'number', min: 0.01, max: 100, step: 0.05, default: 1, group: 'Contact' },
    { key: 'rough_um', label: 'RMS roughness σ (Mikic)', unit: 'µm', type: 'number', min: 0.05, max: 20, step: 0.05, default: 0.8, group: 'Contact' },
    { key: 'slope', label: 'Mean asperity slope m (Mikic)', type: 'number', min: 0.01, max: 0.5, step: 0.01, default: 0.1, group: 'Contact' },
    { key: 'Hc_GPa', label: 'Micro-hardness of the softer surface', unit: 'GPa', type: 'number', min: 0.1, max: 10, step: 0.1, default: 2.5, group: 'Contact' },
    { key: 'hcUser', label: 'User contact conductance', unit: 'W/m²K', type: 'number', min: 100, max: 1e6, step: 100, default: 20000, group: 'Contact', auto: fromDesign('hContact') },
    { key: 'hotFluid', label: 'Hot fluid', type: 'select', default: 'fl-water', options: fluidOptions, group: 'Coolant & flow', auto: fromDesign('hotFluid') },
    { key: 'coldFluid', label: 'Cold fluid', type: 'select', default: 'fl-water', options: fluidOptions, group: 'Coolant & flow', auto: fromDesign('coldFluid') },
    { key: 'flowMode', label: 'Flow specification', type: 'select', default: 'demand', options: [{ value: 'demand', label: 'Sized from heat demand and fluid ΔT' }, { value: 'user', label: 'User mass flow per cell' }], group: 'Coolant & flow' },
    { key: 'fluidDT', label: 'Design fluid temperature change', unit: 'K', type: 'number', min: 0.5, max: 40, step: 0.5, default: 10, group: 'Coolant & flow', auto: fromDesign('fluidDT') },
    { key: 'mdotUser', label: 'User mass flow per cell (during its phase)', unit: 'kg/s', type: 'number', min: 1e-5, max: 5, step: 0.001, default: 0.02, group: 'Coolant & flow' },
    { key: 'freq', label: 'Engine cycle frequency (target)', unit: 'Hz', type: 'number', min: 0.01, max: 50, step: 0.05, default: 1, group: 'Coolant & flow', auto: (c) => (c.upstream('s05')?.freq_Hz ? { value: +c.upstream('s05').freq_Hz.toPrecision(4), prov: 'coupled' } : fromDesign('freq')(c)) },
    { key: 'dutyHot', label: 'Hot-phase fraction', type: 'range', min: 0.1, max: 0.9, step: 0.05, default: 0.5, group: 'Coolant & flow', auto: fromDesign('dutyHot') },
    { key: 'tSwitch', label: 'Valve switching / purge time', unit: 's', type: 'number', min: 0, max: 2, step: 0.005, default: 0.02, group: 'Coolant & flow', auto: fromDesign('tSwitch') },
    { key: 'pumpEta', label: 'Pump efficiency', type: 'range', min: 0.1, max: 0.9, step: 0.05, default: 0.45, group: 'Coolant & flow', auto: fromDesign('pumpEta') },
    { key: 'nCells', label: 'Cells in the engine', type: 'number', min: 1, max: 100, step: 1, default: 12, group: 'Coolant & flow', auto: fromDesign('nCells') },
    { key: 'htcModel', label: 'Film coefficient', type: 'select', default: 'correlation', options: [{ value: 'correlation', label: 'Duct correlation (developing laminar / turbulent)' }, { value: 'user', label: 'User values' }], group: 'Convection' },
    { key: 'nuBC', label: 'Thermal boundary condition for Nu', type: 'select', default: 'T', options: [{ value: 'T', label: 'Uniform wall temperature (Nu_T)' }, { value: 'H', label: 'Uniform heat flux (Nu_H)' }], group: 'Convection', expert: true },
    { key: 'hHotUser', label: 'User hot film coefficient (wall)', unit: 'W/m²K', type: 'number', min: 50, max: 2e5, step: 50, default: 8000, group: 'Convection' },
    { key: 'hColdUser', label: 'User cold film coefficient (wall)', unit: 'W/m²K', type: 'number', min: 50, max: 2e5, step: 50, default: 8000, group: 'Convection' },
    { key: 'refine', label: 'Mesh refinement factor (vs base sizes)', type: 'number', min: 0.5, max: 8, step: 0.25, default: 2, group: 'Solver', expert: true, auto: (c) => (c.upstream('s02')?.meshRefine ? { value: +c.upstream('s02').meshRefine.toFixed(3), prov: 'coupled' } : undefined) },
    { key: 'nRibbon', label: 'Base cells through the half ribbon', type: 'number', min: 1, max: 20, step: 1, default: 2, group: 'Solver', expert: true },
    { key: 'nChannel', label: 'Base cells across the channel short side', type: 'number', min: 2, max: 40, step: 1, default: 4, group: 'Solver', expert: true },
    { key: 'growth', label: 'Mesh growth ratio', type: 'number', min: 1.05, max: 2, step: 0.05, default: 1.3, group: 'Solver', expert: true },
    { key: 'steps', label: 'Time steps per phase', type: 'number', min: 40, max: 2000, step: 10, default: 160, group: 'Solver', expert: true },
    { key: 'theta', label: 'Time integration', type: 'select', default: 1, options: [{ value: 1, label: 'Implicit Euler (θ = 1)' }, { value: 0.5, label: 'Crank–Nicolson (θ = ½)' }], group: 'Solver', expert: true },
    { key: 'tMax', label: 'Maximum simulated time per phase', unit: 's', type: 'number', min: 0.05, max: 120, step: 0.05, default: 20, group: 'Solver', expert: true },
    { key: 'studies', label: 'Mesh & time-step independence studies', type: 'bool', default: true, group: 'Solver', expert: true },
  ],
  presets: [
    { label: 'Reference LT (water, graphite TIM)', values: { contactModel: 'material', contactMat: 'tim-graphite', plateMat: 'ss-316l', flowMode: 'demand' } },
    { label: 'Copper plates + liquid-metal interface', values: { plateMat: 'cu-c110', contactMat: 'tim-liquidmetal', contactModel: 'material' } },
    { label: 'Dry metal contact at 1 MPa (Mikic)', values: { contactModel: 'mikic', P_MPa: 1, rough_um: 0.8 } },
    { label: 'Double flow', values: { flowMode: 'user', mdotUser: 0.05 } },
    { label: 'Thin foil 50 µm', values: { t_um: 50 } },
  ],

  async run(p, ctx) {
    const out = { kpis: [], charts: [], tables: [], verdicts: [], recs: [], checks: [], explain: [], views: [], exports: [], outputs: {} };
    const K = (label, value, unit, explain, prov = 'calc', status) => out.kpis.push({ label, value, unit, explain, prov, status });
    const V = (test, status, detail, fix) => out.verdicts.push({ test, status, detail, fix });
    const CK = (name, value, target, pass, detail) => out.checks.push({ name, value, target, pass, detail });
    const design = designOf(ctx), alloy = getMat(p.alloy) || getMat(design.alloy) || getMat('niti-lt'), pm = getMat(p.plateMat) || componentMaterial(ctx.store, 'channelPlate'), cm = getMat(p.contactMat) || componentMaterial(ctx.store, 'contactLayer');
    const t = p.t_um / 1e6, w = p.w_mm / 1e3, L = p.L_mm / 1e3, chW = p.chW_mm / 1e3, chH = p.chH_mm / 1e3, web = p.web_mm / 1e3, skin = p.skin_mm / 1e3, tc = p.tc_um / 1e6, nRib = Math.max(1, Math.round(p.nRib));
    const nPlates = p.plate === 'dedicated' ? 2 * nRib : nRib + 1, nChPlate = Math.max(1, Math.round(p.chPerCell / nPlates)), pitch = w / nChPlate, nCh = nChPlate * nPlates;
    const kRib = p.kRibbon > 0 ? p.kRibbon : 0.5 * (alloy.k + (alloy.kM ?? alloy.k));
    const sm = new SMA(alloy), TH = sm.temps(p.sigmaH), TL = sm.temps(p.sigmaL), AsH = TH.As, AfH = TH.Af, MsL = TL.Ms, MfL = TL.Mf;
    const Th = p.Th, Tc = p.Tc, phi = { inlet: 0, mid: 0.5, outlet: 1 }[p.station] ?? 0.5;
    // ---------- contact conductance ----------
    const ks = 2 * kRib * pm.k / (kRib + pm.k);
    const hcMikic = contactConductance({ ks, sigma: p.rough_um * 1e-6, slope: p.slope, P: p.P_MPa * 1e6, Hc: p.Hc_GPa * 1e9 });
    const hc = p.contactModel === 'mikic' ? hcMikic : p.contactModel === 'user' ? p.hcUser : (cm.hc ?? p.hcUser), hcProv = p.contactModel === 'mikic' ? 'calc' : p.contactModel === 'user' ? 'user' : 'library';
    // ---------- geometry & properties ----------
    const sec = ML.cartridgeSection({ t, tc, chW, chH, web, skin, pitch, plate: p.plate, half: true });
    for (const e of sec.errors) V('Channel/plate geometry', 'fail', e, 'Correct the channel pitch, width or web thickness.');
    if (sec.errors.length) { out.headline = 'Infeasible microchannel geometry — see verdicts.'; out.headlineKind = 'fail'; return out; }
    const props = { ribbon: { k: kRib, rho: alloy.rho, cp: alloy.cp }, contact: { k: hc * tc, rho: cm.rho, cp: cm.cp }, wall: { k: pm.k, rho: pm.rho, cp: pm.cp } };
    const unitCells = 2 * nChPlate * nRib; // half-ribbon × pitch cells per cartridge (per unit length)
    // ---------- heat demand and flow ----------
    const rcR = alloy.rho * alloy.cp, Csec = sec.areas.ribbon * rcR + sec.areas.contact * cm.rho * cm.cp + sec.areas.wall * pm.rho * pm.cp; // J/(m·K) per unit cell
    const Elat = sec.areas.ribbon * alloy.rho * (alloy.Lh || 0);
    const EcycleCell = unitCells * L * (Csec * (Th - Tc) + Elat);
    const fluidT = (id, T) => fluid(id, T), fH = fluidT(p.hotFluid, Th - p.fluidDT / 2), fC = fluidT(p.coldFluid, Tc + p.fluidDT / 2);
    const mdotH = p.flowMode === 'user' ? p.mdotUser : EcycleCell * p.freq / (fH.cp * p.fluidDT * Math.max(0.05, p.dutyHot));
    const mdotC = p.flowMode === 'user' ? p.mdotUser : EcycleCell * p.freq / (fC.cp * p.fluidDT * Math.max(0.05, 1 - p.dutyHot));
    const dH = ductHTC({ fluidId: p.hotFluid, T: Th - p.fluidDT / 2, w: chW, hgt: chH, L, mdot: mdotH, nChannels: nCh, bc: p.nuBC });
    const dC = ductHTC({ fluidId: p.coldFluid, T: Tc + p.fluidDT / 2, w: chW, hgt: chH, L, mdot: mdotC, nChannels: nCh, bc: p.nuBC });
    const hHotW = p.htcModel === 'user' ? p.hHotUser : dH.h, hColdW = p.htcModel === 'user' ? p.hColdUser : dC.h, hProv = p.htcModel === 'user' ? 'user' : 'calc';
    const wetRatio = sec.wetPerimeter / pitch, hHotFace = hHotW * wetRatio, hColdFace = hColdW * wetRatio;
    const mdotCh = (m) => m / nCh, cpH = fH.cp, cpC = fC.cp;
    // ---------- resistance budget (per ribbon face area) ----------
    const Rb = (h) => ({ film: 1 / (h * wetRatio), wall: web / pm.k, contact: 1 / hc, ribbon: (t / 2) / (3 * kRib) });
    const RbH = Rb(hHotW), RbC = Rb(hColdW), sumR = (r) => r.film + r.wall + r.contact + r.ribbon;
    const Rext = RbH.film + RbH.wall + RbH.contact, Bi = (t / 2) / (kRib * Rext);
    // conjugate steady resistance: uniform ribbon generation, fluid at 0
    const sizes = ML.defaultSizes(sec, { nRibbon: p.nRibbon, nChannel: p.nChannel, growth: p.growth, maxAspect: 8 });
    const mesh = ML.buildMesh(sec, { type: 'structured', ...sizes, refine: p.refine }), Q = ML.meshQuality(mesh);
    const qv = 1e8, st = ML.solveSteady(mesh, { props, bcs: { channel: { type: 'robin', h: hHotW, Tinf: 0 } }, source: { ribbon: qv } }), R2D = st.stats.ribbon.mean / (qv * t / 2);
    CK('Steady conjugate energy balance (source = convected heat)', Math.abs(-st.Q['channel-top'] - st.Qsource) / st.Qsource, '< 1e-8', Math.abs(-st.Q['channel-top'] - st.Qsource) / st.Qsource < 1e-8);
    ctx.progress(0.15, 'heating transient');
    await yieldTo(ctx);
    // ---------- transient heating and cooling (enthalpy method) ----------
    const band = (T, a, b) => clamp((T - a) / Math.max(1e-6, b - a), 0, 1), cosK = (x) => 0.5 * (1 - Math.cos(Math.PI * x));
    const Lv = alloy.rho * (alloy.Lh || 0);
    const Hheat = (T) => rcR * T + Lv * cosK(band(T, AsH, AfH)), Hcool = (T) => rcR * T + Lv * (1 - cosK(band(MsL - T, 0, MsL - MfL)));
    const Uw = 1 / (1 / (hHotW * sec.wetPerimeter) + (sumR(RbH) - RbH.film) / pitch); // W/(m·K) per unit cell
    const tauH = (Csec + Elat / Math.max(1, AfH - AsH)) / Uw, tauC = (Csec + Elat / Math.max(1, MsL - MfL)) / (1 / (1 / (hColdW * sec.wetPerimeter) + (sumR(RbC) - RbC.film) / pitch));
    const horizon = (tau, gap) => Math.min(p.tMax, 2.5 * tau * (3 + Math.log((Th - Tc) / Math.max(0.05, gap))));
    const phase = (hot, T0, tau) => {
      const target = hot ? AfH : MfL, gap = hot ? Th - AfH : MfL - Tc, reachable = gap > 0;
      let Qlag = 0;
      const Tf = () => (hot ? clamp(Th - phi * 2 * Math.max(0, Qlag) * L / (mdotCh(mdotH) * cpH), Tc, Th) : clamp(Tc + phi * 2 * Math.max(0, -Qlag) * L / (mdotCh(mdotC) * cpC), Tc, Th));
      const opts = { props, bcs: { channel: { type: 'robin', h: hot ? hHotW : hColdW, Tinf: Tf } }, enthalpy: { ribbon: hot ? Hheat : Hcool }, theta: +p.theta, snapEvery: Math.max(1, Math.round(p.steps / 40)) };
      const crossed = (s) => (hot ? s.ribbon.min >= target : s.ribbon.max <= target);
      const tf = [];
      const stop = (s) => { Qlag = s.Q ?? Qlag; tf.push(Tf()); return reachable && crossed(s.stats); };
      let tEnd = horizon(tau, gap), r = ML.solveTransient(mesh, { ...opts, T0, dt: tEnd / p.steps, steps: p.steps, stop: (s) => stop(s) });
      let ext = 0;
      while (reachable && !crossed(lastStats(r)) && ext < 2 && r.t[r.t.length - 1] < p.tMax) { // extend from the end state with a 3× longer step
        ext++; const r2 = ML.solveTransient(mesh, { ...opts, T0: r.T, dt: 3 * r.dt, steps: p.steps, stop: (s) => stop(s) }); r = appendRun(r, r2);
      }
      const series = hot ? r.stats.ribbon.min : r.stats.ribbon.max, k = series.findIndex(v => (hot ? v >= target : v <= target));
      const tCross = k > 0 ? r.t[k - 1] + (r.t[k] - r.t[k - 1]) * (target - series[k - 1]) / ((series[k] - series[k - 1]) || 1) : k === 0 ? 0 : null;
      return { r, tCross, reachable, gap, tf: [hot ? Th : Tc, ...tf] };
    };
    const lastStats = (r) => Object.fromEntries(Object.entries(r.stats).map(([k2, v]) => [k2, { mean: v.mean[v.mean.length - 1], min: v.min[v.min.length - 1], max: v.max[v.max.length - 1] }]));
    const appendRun = (a, b) => {
      const t0 = a.t[a.t.length - 1], cat = (x, y) => x.concat(y.slice(1)), stats = {};
      for (const k2 of Object.keys(a.stats)) stats[k2] = { mean: cat(a.stats[k2].mean, b.stats[k2].mean), min: cat(a.stats[k2].min, b.stats[k2].min), max: cat(a.stats[k2].max, b.stats[k2].max) };
      const regionDH = {}; for (const k2 of Object.keys(a.regionDH)) regionDH[k2] = a.regionDH[k2] + b.regionDH[k2];
      return { ...b, t: cat(a.t, b.t.map(v => v + t0)), Q: cat(a.Q, b.Q), gradMax: cat(a.gradMax, b.gradMax), stats, snaps: a.snaps.concat(b.snaps.slice(1).map(s => ({ t: s.t + t0, T: s.T }))), Ein: a.Ein + b.Ein, dH: a.dH + b.dH, residual: Math.abs(a.Ein + b.Ein - a.dH - b.dH) / Math.max(1e-30, Math.abs(a.Ein + b.Ein)), regionDH, iterations: a.iterations + b.iterations, steps: a.steps + b.steps };
    };
    const H = phase(true, Tc, tauH);
    ctx.progress(0.4, 'cooling transient'); await yieldTo(ctx);
    const C = phase(false, H.r.T, tauC);
    const tHeat = H.tCross, tCool = C.tCross, fmax = tHeat != null && tCool != null ? 1 / (tHeat + tCool + 2 * p.tSwitch) : 0;
    const dTmax = Math.max(...H.r.stats.ribbon.max.map((v, i) => v - H.r.stats.ribbon.min[i]), ...C.r.stats.ribbon.max.map((v, i) => v - C.r.stats.ribbon.min[i]));
    const gMax = Math.max(...H.r.gradMax, ...C.r.gradMax);
    const dutyRec = tHeat != null && tCool != null ? (tHeat + p.tSwitch) / (tHeat + tCool + 2 * p.tSwitch) : null;
    const imbalance = tHeat != null && tCool != null ? (tHeat - tCool) / (tHeat + tCool) : null;
    const EinCell = H.r.Ein * unitCells * L, EoutCell = -C.r.Ein * unitCells * L, shareWall = H.r.regionDH.wall / H.r.Ein, shareRib = H.r.regionDH.ribbon / H.r.Ein, shareCon = (H.r.regionDH.contact ?? 0) / H.r.Ein;
    // demand-consistent flow (using the 2-D energy actually absorbed) and pumping power
    const mdotReqH = EinCell / (cpH * p.fluidDT * Math.max(1e-6, tHeat ?? H.r.t[H.r.t.length - 1])), mdotReqC = EoutCell / (cpC * p.fluidDT * Math.max(1e-6, tCool ?? C.r.t[C.r.t.length - 1]));
    const PpumpH = pumpPower(dH.dp * 1.5, mdotH / dH.fp.rho, p.pumpEta) * p.nCells * p.dutyHot, PpumpC = pumpPower(dC.dp * 1.5, mdotC / dC.fp.rho, p.pumpEta) * p.nCells * (1 - p.dutyHot);
    ctx.progress(0.55, 'verification'); await yieldTo(ctx);
    // ---------- verification ----------
    const Ue = 1 / Rext, tv = 0.3 * rcR * (t / 2) / Ue;
    const s1 = slab1D({ Lh: t / 2, n: 21, k: kRib, rho: alloy.rho, cp: alloy.cp, h: Ue, Tinf: Th, T0: Tc, tEnd: tv, dt: tv / 400 }), sa = slabAnalytic({ Lh: t / 2, k: kRib, rho: alloy.rho, cp: alloy.cp, h: Ue, Tinf: Th, T0: Tc, t: tv, x: 0 });
    const e1 = Math.abs(s1.Tc[s1.Tc.length - 1] - sa) / (Th - Tc);
    CK('heat.slab1D (Crank–Nicolson) vs analytic plane wall', e1, '< 0.2 % of ΔT', e1 < 0.002, `T_centre ${fmt(s1.Tc[s1.Tc.length - 1], 5)} vs ${fmt(sa, 5)} °C at Fo = ${fmt(s1.Fo, 3)}, Bi = ${fmt(s1.Bi, 3)}`);
    const vs = ML.verifySlab({ Lh: t / 2, k: kRib, rho: alloy.rho, cp: alloy.cp, h: Ue, Tinf: Th, T0: Tc, tEnd: tv, steps: 120 });
    CK('meshlab 2-D FE slab vs analytic plane wall', vs.errC, '< 0.2 % of ΔT', vs.errC < 0.002, `centre ${fmt(vs.Tc, 5)} vs ${fmt(vs.TcAnalytic, 5)} °C; surface error ${fmt(vs.errS * 100, 3)} %`);
    const pt = ML.patchTest(mesh); CK('Patch test on the unit-cell mesh', pt.maxErr, '< 1e-8', pt.maxErr < 1e-8);
    CK('Energy conservation — heating run', H.r.residual, '< 0.5 %', H.r.residual < 0.005, `∫Q dt ${fmt(H.r.Ein, 5)} J/m vs ΔH ${fmt(H.r.dH, 5)} J/m (enthalpy secant + Picard)`);
    CK('Energy conservation — cooling run', C.r.residual, '< 0.5 %', C.r.residual < 0.005, `∫Q dt ${fmt(C.r.Ein, 5)} J/m vs ΔH ${fmt(C.r.dH, 5)} J/m`);
    const dv = ductVelocity(chW, chH), rd = rectDuct(chW, chH), fReErr = Math.abs(dv.fRe - rd.fRe) / dv.fRe;
    CK('Duct eigen-series fRe vs Shah–London fit', fReErr, '< 0.5 %', fReErr < 0.005, `series ${fmt(dv.fRe, 5)} vs correlation ${fmt(rd.fRe, 5)} (aspect ${fmt(rd.aspect, 3)})`);
    const R1D = sumR(RbH), dR = Math.abs(R2D - R1D) / R1D;
    CK('Conjugate 2-D resistance vs 1-D budget', dR, 'info: spreading / fin effects', undefined, `R_2D ${fmt(R2D * 1e4, 4)} vs R_1D ${fmt(R1D * 1e4, 4)} ×10⁻⁴ m²K/W`);
    // mesh and time-step independence on the heating functional θ̄(t*)
    let study = null, tStudy = null;
    const tStar = 0.5 * (tHeat ?? H.r.t[H.r.t.length - 1]);
    const thetaAt = (m, steps) => { const r = ML.solveTransient(m, { props, bcs: { channel: { type: 'robin', h: hHotW, Tinf: Th } }, enthalpy: { ribbon: Hheat }, T0: Tc, dt: tStar / steps, steps, theta: 1 }); return (r.stats.ribbon.mean[r.stats.ribbon.mean.length - 1] - Tc) / (Th - Tc); };
    if (p.studies) {
      ctx.progress(0.65, 'mesh independence');
      study = ML.meshStudy(sec, { type: 'structured', sizes, levels: 3, ratio: Math.SQRT2, base: p.refine, functional: (m) => thetaAt(m, 30) });
      await yieldTo(ctx); ctx.progress(0.8, 'time-step independence');
      const nS = [20, 40, 80], vals = nS.map(n => thetaAt(mesh, n)), hs = nS.map(n => tStar / n);
      tStudy = { nS, vals, ...gciFn(vals[2], vals[1], vals[0], hs[2], hs[1], hs[0]) };
      if (!(tStudy.p > 0.3 && tStudy.p < 2.5) || tStudy.oscillatory || !Number.isFinite(tStudy.gci21)) { const ea = Math.abs((vals[2] - vals[1]) / vals[2]); Object.assign(tStudy, { pObs: tStudy.p, p: 1, capped: true, fext: vals[2], gci21: 3 * ea / (2 - 1) }); } // formal order of implicit Euler, F_s = 3
      const G = study.gci;
      if (G && !G.exact) CK('Mesh independence: GCI of θ̄(t*) (fine pair)', G.gci21 * 100, '< 1 %', G.gci21 < 0.01, `p = ${fmt(G.p, 3)}, extrapolated θ̄ = ${fmt(G.fext, 5)}; the production mesh (level 1) error ≈ ${fmt(study.levels[0].errEst * 100, 3)} %`);
      CK('Production mesh discretisation error (θ̄ at t*)', study.levels[0].errEst * 100, '< 2 %', study.levels[0].errEst < 0.02, `${mesh.nElems} elements`);
      CK('Time-step independence: GCI of θ̄(t*)', tStudy.gci21 * 100, '< 1 %', tStudy.gci21 < 0.01, `${tStudy.capped ? `observed order ${fmt(tStudy.pObs, 3)} outside the theoretical range — conservative GCI (formal order 1, F_s = 3)` : `observed temporal order p = ${fmt(tStudy.p, 3)} (implicit Euler ≈ 1)`}; ${p.steps} steps per phase in production`);
    }
    // ---------- KPIs ----------
    K('Hot-side film coefficient', hHotFace, 'W/m²K', `Referred to the ribbon face area (wall h = ${fmt(hHotW, 4)} W/m²K × A_wet/A_face = ${fmt(wetRatio, 3)}). ${dH.regime} flow, Re = ${fmt(dH.Re, 4)}, Nu = ${fmt(dH.Nu, 4)}, ṁ = ${fmt(mdotH * 1e3, 4)} g/s per cell.`, hProv);
    K('Cold-side film coefficient', hColdFace, 'W/m²K', `Face-referred (wall h = ${fmt(hColdW, 4)} W/m²K); ${dC.regime}, Re = ${fmt(dC.Re, 4)}, ṁ = ${fmt(mdotC * 1e3, 4)} g/s per cell.`, hProv);
    K('Contact conductance h_c', hc, 'W/m²K', `${p.contactModel === 'mikic' ? `Mikic plastic correlation at ${p.P_MPa} MPa, σ = ${p.rough_um} µm, m = ${p.slope}, H_c = ${p.Hc_GPa} GPa` : p.contactModel === 'user' ? 'User value' : `Library value for ${cm.name} (must be measured, pressure-dependent)`}; resistance ${fmt(1 / hc * 1e4, 4)} ×10⁻⁴ m²K/W.`, hcProv);
    K('Heating time to Af(σH)', tHeat ?? 'not reached', tHeat != null ? 's' : '', `Time for the coldest ribbon point to exceed Af(σH) = ${fmt(AfH, 4)} °C from uniform ${Tc} °C (2-D conjugate, latent heat included, fluid at the ${p.station} station).`, 'calc', tHeat == null ? 'bad' : 'ok');
    K('Cooling time to Mf(σL)', tCool ?? 'not reached', tCool != null ? 's' : '', `Time for the warmest ribbon point to fall below Mf(σL) = ${fmt(MfL, 4)} °C from the end-of-heating field.`, 'calc', tCool == null ? 'bad' : 'ok');
    K('Maximum cycle frequency', fmax, 'Hz', `1/(t_heat + t_cool + 2 × ${p.tSwitch} s switching). The engine target is ${p.freq} Hz.`, 'calc', fmax >= p.freq ? 'ok' : fmax > 0 ? 'warn' : 'bad');
    K('Thermal resistance fluid → ribbon (hot)', R2D, 'm²K/W', `Conjugate 2-D value per ribbon face area (includes spreading through the land and fin effect of the channel walls); 1-D series budget ${fmt(R1D, 4)} m²K/W.`, 'calc');
    K('Biot number (ribbon)', Bi, '–', `(t/2)/(k·R_ext); ${Bi < 0.1 ? 'below 0.1 → ribbon nearly isothermal through its thickness; the external resistances control the rate' : 'above 0.1 → internal conduction matters'}.`, 'calc', Bi < 0.1 ? 'ok' : 'warn');
    K('Max ribbon temperature non-uniformity', dTmax, 'K', `Largest (T_max − T_min) inside the ribbon during heating and cooling — drives non-uniform transformation and local strain concentration.`, 'calc', dTmax > 5 ? 'warn' : 'ok');
    K('Max ribbon temperature gradient', gMax / 1e3, 'K/mm', 'Peak |∇T| in the ribbon (element gradients).', 'calc');
    K('Hot/cold imbalance', imbalance ?? 'n/a', '–', `(t_heat − t_cool)/(t_heat + t_cool). Recommended hot-phase duty = ${dutyRec != null ? fmt(dutyRec, 3) : 'n/a'} (engine uses ${p.dutyHot}).`, 'calc');
    K('Heat absorbed per cell per cycle', EinCell, 'J', `From the 2-D heating run: ribbon ${fmt(shareRib * 100, 3)} % (sensible + latent), plates ${fmt(shareWall * 100, 3)} %, contact ${fmt(shareCon * 100, 3)} %.`, 'calc', shareWall > 0.6 ? 'warn' : 'ok');
    K('Required hot flow per cell', mdotReqH * 1e3, 'g/s', `Flow that keeps the hot-fluid drop to ${p.fluidDT} K while delivering the 2-D heat in t_heat; applied ${fmt(mdotH * 1e3, 4)} g/s.`, 'calc', mdotH >= 0.8 * mdotReqH ? 'ok' : 'warn');
    K('Pumping power (engine, hot + cold)', PpumpH + PpumpC, 'W', `Δp×1.5 (manifolds/valves) × V̇ / η_pump, duty-weighted over ${p.nCells} cells; channel Δp hot ${fmt(dH.dp, 4)} Pa, cold ${fmt(dC.dp, 4)} Pa.`, 'calc');
    // ---------- verdicts ----------
    V('Hot fluid can complete the reverse transformation', H.reachable ? (tHeat != null ? 'pass' : 'fail') : 'fail', H.reachable ? `T_hot ${Th} °C vs Af(σH) ${fmt(AfH, 4)} °C (margin ${fmt(Th - AfH, 3)} K); ${tHeat != null ? `reached in ${fmt(tHeat, 4)} s` : `not reached within ${fmt(H.r.t[H.r.t.length - 1], 4)} s`}.` : `Af(σH) = ${fmt(AfH, 4)} °C exceeds the hot fluid (${Th} °C): reverse transformation is incomplete — infeasible as specified.`, `Raise T_hot above ${fmt(AfH + 3, 3)} °C, lower σH below ${fmt(Math.max(0, (Th - 3 - alloy.Af) * alloy.CA), 3)} MPa or choose an alloy with lower Af.`);
    V('Cold fluid can complete the forward transformation', C.reachable ? (tCool != null ? 'pass' : 'fail') : 'fail', C.reachable ? `T_cold ${Tc} °C vs Mf(σL) ${fmt(MfL, 4)} °C (margin ${fmt(MfL - Tc, 3)} K); ${tCool != null ? `reached in ${fmt(tCool, 4)} s` : 'not reached within the horizon'}.` : `Mf(σL) = ${fmt(MfL, 4)} °C is below the cold fluid (${Tc} °C) — infeasible.`, 'Lower the sink temperature or the reset stress, or select an alloy with higher Mf.');
    V('Thermal rate supports the engine frequency', fmax >= p.freq ? 'pass' : fmax > 0 ? 'fail' : 'fail', `f_max = ${fmt(fmax, 4)} Hz vs target ${p.freq} Hz.`, `Reduce the dominant resistance (${['film', 'wall', 'contact', 'ribbon'].reduce((a, b) => (RbH[b] > RbH[a] ? b : a))}), thin the plates, increase flow or run at ≤ ${fmt(fmax, 3)} Hz.`);
    V('Margin between Th and Af(σH)', Th - AfH > 5 ? 'pass' : Th - AfH > 0 ? 'warn' : 'fail', `${fmt(Th - AfH, 3)} K. Small margins make the heating time grow logarithmically and very sensitive to fluid cooling along the channel (station ${p.station}).`, `Aim for ≥ 5 K: lower σH by ${fmt(Math.max(0, (5 - (Th - AfH)) * alloy.CA), 3)} MPa or raise T_hot.`);
    const dom = ['film', 'wall', 'contact', 'ribbon'].reduce((a, b) => (RbH[b] > RbH[a] ? b : a));
    V('Dominant thermal resistance', 'info', `Hot side: film ${fmt(RbH.film / sumR(RbH) * 100, 3)} %, wall ${fmt(RbH.wall / sumR(RbH) * 100, 3)} %, contact ${fmt(RbH.contact / sumR(RbH) * 100, 3)} %, ribbon ${fmt(RbH.ribbon / sumR(RbH) * 100, 3)} % → ${dom} dominates.`);
    V('Parasitic plate heat capacity', shareWall < 0.5 ? 'pass' : 'warn', `${fmt(shareWall * 100, 3)} % of the heat absorbed during heating goes into the plates (contact layers ${fmt(shareCon * 100, 3)} %).`, 'Thinner webs, lower-ρc_p plate material, or regenerate the plate heat (Suite 09).');
    V('Flow regime and pressure drop', dH.Re < 2300 && dC.Re < 2300 ? 'pass' : 'info', `Hot Re = ${fmt(dH.Re, 4)} (${dH.regime}), cold Re = ${fmt(dC.Re, 4)} (${dC.regime}); thermal entry length ${fmt(dH.entryLengthTh * 1e3, 4)} mm vs channel ${p.L_mm} mm.`);
    if (study) V('Mesh and time-step independence', study.levels[0].errEst < 0.02 && tStudy.gci21 < 0.01 ? 'pass' : 'warn', `Production-mesh error ≈ ${fmt(study.levels[0].errEst * 100, 3)} %, time-step GCI ${fmt(tStudy.gci21 * 100, 3)} %.`, 'Increase the refinement factor or the number of steps per phase.');
    V('Measured thermal step response', 'info', 'No instrumented heating/cooling test data imported; film coefficients and h_c are correlation/library values.', 'Run thermal step tests (ribbon thermocouple or IR, fluid inlet/outlet T, flow) and import them to calibrate h_c and h (Suite 19).');
    // ---------- charts ----------
    const tAll = H.r.t.concat(C.r.t.map(v => v + H.r.t[H.r.t.length - 1])), cat = (a, b) => a.concat(b);
    out.charts.push({ type: 'line', wide: true, title: 'Ribbon temperature through a heating and a cooling phase', x: { label: 'Time', unit: 's' }, y: { label: 'Temperature', unit: '°C' }, series: [{ name: 'ribbon mean', x: tAll, y: cat(H.r.stats.ribbon.mean, C.r.stats.ribbon.mean) }, { name: 'ribbon min', x: tAll, y: cat(H.r.stats.ribbon.min, C.r.stats.ribbon.min), dash: '4 3' }, { name: 'ribbon max', x: tAll, y: cat(H.r.stats.ribbon.max, C.r.stats.ribbon.max), dash: '4 3' }, { name: 'plate mean', x: tAll, y: cat(H.r.stats.wall.mean, C.r.stats.wall.mean) }, { name: `fluid (${p.station})`, x: tAll, y: cat(H.tf, C.tf), dash: '2 2' }], annotations: [{ type: 'hline', y: AfH, label: `Af(σH) ${fmt(AfH, 3)} °C`, color: '#ef4444' }, { type: 'hline', y: AsH, label: 'As(σH)', color: '#f97316' }, { type: 'hline', y: MfL, label: `Mf(σL) ${fmt(MfL, 3)} °C`, color: '#3b82f6' }, { type: 'hline', y: MsL, label: 'Ms(σL)', color: '#60a5fa' }, ...(tHeat != null ? [{ type: 'vline', x: tHeat, label: 't_heat' }] : []), ...(tCool != null ? [{ type: 'vline', x: H.r.t[H.r.t.length - 1] + tCool, label: 't_cool' }] : [])], explain: 'Mean, coldest and warmest ribbon temperatures and the plate mean. The plateau between As and Af (and between Ms and Mf on cooling) is the latent heat of transformation. Heating ends when the coldest ribbon point passes Af(σH); cooling ends when the warmest passes Mf(σL).' });
    const snapH = H.r.snaps.reduce((a, b) => (Math.abs(b.t - tStar) < Math.abs(a.t - tStar) ? b : a)), smp = ML.sampleGrid(mesh, snapH.T, 160, Math.max(30, Math.round(160 * sec.ymax / sec.W)));
    out.charts.push({ type: 'heatmap', wide: true, title: `Unit-cell temperature at t = ${fmt(snapH.t * 1e3, 4)} ms of heating`, x: { label: 'x across ribbon width', unit: 'mm', values: smp.xs.map(v => v * 1e3) }, y: { label: 'y from ribbon mid-plane', unit: 'mm', values: smp.ys.map(v => v * 1e3) }, z: smp.z, z_label: '°C', cmap: 'inferno', isolines: 10, equal: true, explain: `Conjugate temperature field half-way through heating: hot fluid in the channel (blank), heat flows through the web and the contact layer into the ribbon (bottom strip). Isotherm crowding in the contact layer quantifies the interface penalty; the lateral variation shows ribbon areas under the land heating later.` });
    const snapC = C.r.snaps.reduce((a, b) => (Math.abs(b.t - 0.5 * (tCool ?? C.r.t[C.r.t.length - 1])) < Math.abs(a.t - 0.5 * (tCool ?? C.r.t[C.r.t.length - 1])) ? b : a)), smc = ML.sampleGrid(mesh, snapC.T, 160, Math.max(30, Math.round(160 * sec.ymax / sec.W)));
    out.charts.push({ type: 'heatmap', title: `Unit-cell temperature at t = ${fmt(snapC.t * 1e3, 4)} ms of cooling`, x: { label: 'x', unit: 'mm', values: smc.xs.map(v => v * 1e3) }, y: { label: 'y', unit: 'mm', values: smc.ys.map(v => v * 1e3) }, z: smc.z, z_label: '°C', cmap: 'coolwarm', isolines: 10, equal: true, explain: 'Field half-way through cooling: the plate is drained first; the ribbon releases transformation heat between Ms and Mf, which holds it warm.' });
    out.charts.push({ type: 'heatmap', title: 'Fully developed channel velocity u/ū (eigen-series)', x: { label: 'channel width', unit: 'mm', values: dv.ys.map(v => v * 1e3) }, y: { label: 'channel height', unit: 'mm', values: dv.zs.map(v => v * 1e3) }, z: dv.z, z_label: 'u/ū', cmap: 'viridis', isolines: 8, equal: true, explain: `Laminar Poisson solution in the ${fmt(chW * 1e3, 3)} × ${fmt(chH * 1e3, 3)} mm duct; u_max/ū = ${fmt(dv.umaxOverMean, 4)}, fRe = ${fmt(dv.fRe, 4)}. Mean velocity hot side ${fmt(dH.U, 4)} m/s. Low-velocity corners have the weakest convection.` });
    const RcatsH = [RbH.film, RbH.wall, RbH.contact, RbH.ribbon], RcatsC = [RbC.film, RbC.wall, RbC.contact, RbC.ribbon];
    out.charts.push({ type: 'bar', title: 'Thermal-resistance budget per ribbon face area', categories: ['Fluid film', 'Plate web', 'Contact', 'Ribbon (half-thickness)'], series: [{ name: 'Hot side [×10⁻⁴ m²K/W]', values: RcatsH.map(v => v * 1e4) }, { name: 'Cold side [×10⁻⁴ m²K/W]', values: RcatsC.map(v => v * 1e4) }], explain: `Series resistances from fluid to the ribbon mean temperature. The largest bar is the lever for faster cycling. Conjugate 2-D total (hot) = ${fmt(R2D * 1e4, 4)} ×10⁻⁴ m²K/W vs 1-D sum ${fmt(R1D * 1e4, 4)}.` });
    out.charts.push({ type: 'line', title: 'Heat flow into the unit cell', x: { label: 'Time', unit: 's' }, y: { label: 'Heat flow per unit length', unit: 'W/m' }, series: [{ name: 'heating', x: H.r.t, y: H.r.Q }, { name: 'cooling', x: C.r.t.map(v => v + H.r.t[H.r.t.length - 1]), y: C.r.Q }], explain: 'Convective heat flow through the channel walls of one unit cell (positive = into the solid). The area under each curve is the cycle heat; the hump during heating marks the transformation absorbing latent heat.' });
    out.charts.push({ type: 'bar', title: 'Where the heating energy goes', categories: ['Ribbon (sensible + latent)', 'Contact layer', 'Plates'], series: [{ name: 'Share of heat absorbed [%]', values: [shareRib * 100, shareCon * 100, shareWall * 100] }], explain: 'Energy stored in each region during the heating phase (enthalpy change). Heat stored in the plates is cycled without doing work and must be regenerated or it is rejected to the sink.' });
    if (study) {
      out.charts.push({ type: 'line', title: 'Mesh independence of θ̄(t*)', x: { label: 'h', unit: 'µm', log: true }, y: { label: 'θ̄ ribbon mean rise', unit: '–' }, series: [{ name: 'levels (r = √2)', x: study.levels.map(l => l.h * 1e6), y: study.levels.map(l => l.value), mode: 'lines+markers', labels: study.levels.map(l => `${l.nElem} el.`) }], annotations: [{ type: 'hline', y: study.fext, label: 'Richardson', color: '#22c55e' }], explain: `Heating functional at t* = ${fmt(tStar, 4)} s with latent heat on three meshes (production mesh = coarsest). GCI ${fmt((study.gci?.gci21 ?? 0) * 100, 3)} %, p = ${fmt(study.gci?.p, 3)}.` });
      out.charts.push({ type: 'line', title: 'Time-step independence of θ̄(t*)', x: { label: 'Δt', unit: 'ms', log: true }, y: { label: 'θ̄ ribbon mean rise', unit: '–' }, series: [{ name: 'implicit Euler', x: tStudy.nS.map(n => tStar / n * 1e3), y: tStudy.vals, mode: 'lines+markers' }], annotations: [{ type: 'hline', y: tStudy.fext, label: 'Richardson', color: '#22c55e' }], explain: `Δt halved twice on the production mesh. Observed order ${fmt(tStudy.p, 3)}; GCI ${fmt(tStudy.gci21 * 100, 3)} %.` });
    }
    // flow trade-off: frequency vs pumping power (resistance-scaled from the 2-D result)
    const mults = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4], trade = mults.map(m => {
      const a = ductHTC({ fluidId: p.hotFluid, T: Th - p.fluidDT / 2, w: chW, hgt: chH, L, mdot: mdotH * m, nChannels: nCh, bc: p.nuBC }), b = ductHTC({ fluidId: p.coldFluid, T: Tc + p.fluidDT / 2, w: chW, hgt: chH, L, mdot: mdotC * m, nChannels: nCh, bc: p.nuBC });
      const sH = tHeat != null ? tHeat * sumR(Rb(p.htcModel === 'user' ? hHotW : a.h)) / sumR(RbH) : null, sC = tCool != null ? tCool * sumR(Rb(p.htcModel === 'user' ? hColdW : b.h)) / sumR(RbC) : null;
      return { m, f: sH != null && sC != null ? 1 / (sH + sC + 2 * p.tSwitch) : 0, P: pumpPower(a.dp * 1.5, mdotH * m / a.fp.rho, p.pumpEta) * p.nCells * p.dutyHot + pumpPower(b.dp * 1.5, mdotC * m / b.fp.rho, p.pumpEta) * p.nCells * (1 - p.dutyHot) };
    });
    out.charts.push({ type: 'line', title: 'Flow trade-off: cycle frequency vs pumping power', x: { label: 'Pumping power (engine)', unit: 'W', log: true }, y: { label: 'f_max', unit: 'Hz' }, series: [{ name: 'flow × 0.25 … 4', x: trade.map(r => r.P), y: trade.map(r => r.f), mode: 'lines+markers', labels: trade.map(r => '×' + r.m) }], annotations: [{ type: 'hline', y: p.freq, label: 'engine target', color: '#f59e0b' }], explain: 'Each point scales the flow; heating/cooling times scale with the total series resistance (film part from the duct correlation). Diminishing returns appear once the film is no longer the dominant resistance, while pumping power grows ∝ ṁ² (laminar) to ṁ^2.75 (turbulent).' });
    out.charts.push({ type: 'line', title: 'Peak ribbon temperature gradient', x: { label: 'Time', unit: 's' }, y: { label: '|∇T| max', unit: 'K/mm' }, series: [{ name: '|∇T|', x: tAll, y: cat(H.r.gradMax, C.r.gradMax).map(v => v / 1e3) }], explain: 'Largest in-ribbon gradient: through-thickness gradients are set by the Biot number; lateral gradients by the land shadowing between channels.' });
    // ---------- tables ----------
    const row = (n, a, b, u) => [n, typeof a === 'number' ? fmt(a, 4) : a, typeof b === 'number' ? fmt(b, 4) : b, u];
    out.tables.push({ title: 'Channel hydraulics and convection', cols: ['Quantity', 'Hot side', 'Cold side', 'Unit'], rows: [row('Fluid', fH.name, fC.name, ''), row('Mass flow per cell (during phase)', mdotH * 1e3, mdotC * 1e3, 'g/s'), row('Channels per cell (realised)', nCh, nCh, ''), row('Mean velocity', dH.U, dC.U, 'm/s'), row('Reynolds number', dH.Re, dC.Re, ''), row('Prandtl number', dH.Pr, dC.Pr, ''), row('Graetz number', dH.Gz, dC.Gz, ''), row('Regime', dH.regime, dC.regime, ''), row('Nusselt number', dH.Nu, dC.Nu, ''), row('Wall film coefficient', hHotW, hColdW, 'W/m²K'), row('Face-referred coefficient', hHotFace, hColdFace, 'W/m²K'), row('Channel Δp', dH.dp, dC.dp, 'Pa'), row('Thermal entry length', dH.entryLengthTh * 1e3, dC.entryLengthTh * 1e3, 'mm'), row('Required flow (2-D heat, ΔT_f)', mdotReqH * 1e3, mdotReqC * 1e3, 'g/s'), row('Pumping power (engine, duty-weighted)', PpumpH, PpumpC, 'W')], explain: 'Duct correlations at the mean fluid temperature with the realised channel count; Δp excludes manifolds (×1.5 applied for pumping).' });
    out.tables.push({ title: 'Thermal-resistance budget (per ribbon face area)', cols: ['Element', 'Hot [m²K/W]', 'Cold [m²K/W]', 'Hot share [%]'], rows: [['Fluid film', ...[RbH.film, RbC.film].map(v => fmt(v, 4)), fmt(RbH.film / sumR(RbH) * 100, 3)], ['Plate web', ...[RbH.wall, RbC.wall].map(v => fmt(v, 4)), fmt(RbH.wall / sumR(RbH) * 100, 3)], ['Contact', ...[RbH.contact, RbC.contact].map(v => fmt(v, 4)), fmt(RbH.contact / sumR(RbH) * 100, 3)], ['Ribbon (to mean)', ...[RbH.ribbon, RbC.ribbon].map(v => fmt(v, 4)), fmt(RbH.ribbon / sumR(RbH) * 100, 3)], ['Total 1-D', fmt(sumR(RbH), 4), fmt(sumR(RbC), 4), '100'], ['Conjugate 2-D (hot)', fmt(R2D, 4), '', '']], explain: 'The 2-D value accounts for heat spreading from the channel footprint through the land and the fin action of channel side walls.' });
    out.tables.push({ title: 'Transformation timing', cols: ['Quantity', 'Value', 'Unit'], rows: [['As(σH) / Af(σH)', `${fmt(AsH, 4)} / ${fmt(AfH, 4)}`, '°C'], ['Ms(σL) / Mf(σL)', `${fmt(MsL, 4)} / ${fmt(MfL, 4)}`, '°C'], ['Heating time', tHeat != null ? fmt(tHeat, 4) : 'not reached', 's'], ['Cooling time', tCool != null ? fmt(tCool, 4) : 'not reached', 's'], ['Switching (2×)', fmt(2 * p.tSwitch, 3), 's'], ['f_max', fmt(fmax, 4), 'Hz'], ['Recommended hot duty', dutyRec != null ? fmt(dutyRec, 3) : 'n/a', ''], ['Lumped time constant (hot, latent-weighted)', fmt(tauH, 4), 's'], ['Diffusion time (t/2)²/α', fmt((t / 2) ** 2 / (kRib / rcR), 4), 's'], ['Production mesh', `${mesh.nElems} el., ${mesh.nNodes} nodes, h ${fmt(Q.hRep * 1e6, 3)} µm`, ''], ['Solver', `${H.r.solver}, θ = ${p.theta}, Δt ${fmt(H.r.dt * 1e3, 4)} ms`, '']], explain: 'Transformation temperatures from the Clausius–Clapeyron shift of the library card at the operating stresses.' });
    if (study) out.tables.push({ title: 'Mesh and time-step independence', cols: ['Study', 'Level', 'Size', 'θ̄(t*)', 'Error est. [%]'], rows: [...study.levels.map(l => ['mesh', l.level, `${l.nElem} el., h ${fmt(l.h * 1e6, 3)} µm`, fmt(l.value, 6), fmt(l.errEst * 100, 3)]), ...tStudy.nS.map((n, i) => ['time step', i + 1, `${n} steps, Δt ${fmt(tStar / n * 1e3, 4)} ms`, fmt(tStudy.vals[i], 6), fmt(1.25 * Math.abs(tStudy.vals[i] - tStudy.fext) / Math.abs(tStudy.fext) * 100, 3)])], explain: 'Richardson extrapolation with F_s = 1.25.' });
    // ---------- explanation ----------
    out.explain.push({ title: 'What limits the cycle rate', text: `The ribbon (Bi = ${fmt(Bi, 3)}) is ${Bi < 0.1 ? 'thermally thin, so' : 'not thin;'} the rate is set by the series resistance fluid → web → contact (${dom} dominates) acting on the heat capacity of ribbon + plates + latent heat. Heating takes ${tHeat != null ? fmt(tHeat, 4) + ' s' : 'longer than the horizon'} and cooling ${tCool != null ? fmt(tCool, 4) + ' s' : 'longer than the horizon'}, so the cell can cycle at up to ${fmt(fmax, 4)} Hz including ${fmt(2 * p.tSwitch, 3)} s of valve switching.` });
    out.explain.push({ title: 'Why the plates matter', text: `${fmt(shareWall * 100, 3)} % of the heat absorbed during heating is stored in the plates (the plate/ribbon heat-capacity ratio of the unit cell is ${fmt(sec.areas.wall * pm.rho * pm.cp / (sec.areas.ribbon * rcR), 3)}). That heat slows the ribbon and is returned to the cold fluid every cycle.` });
    out.explain.push({ title: 'Coupled inputs', text: `Section from ${ctx.upstream('s02')?.section ? 'Suite 02 (coupled)' : 'the engine record'}; T_hot from ${ctx.upstream('s06') ? 'Suite 06' : 'the engine record'}; T_cold from ${ctx.upstream('s07') ? 'Suite 07' : 'the engine record'}; mesh refinement ${fmt(p.refine, 3)} ${ctx.upstream('s02')?.meshRefine ? '(Suite 02 selection)' : '(default)'}.` });
    // ---------- recommendations ----------
    const fixes = { film: `increase flow (×2 flow → f_max ≈ ${fmt(trade.find(r => r.m === 2).f, 3)} Hz at ${fmt(trade.find(r => r.m === 2).P, 3)} W pumping) or use narrower channels`, wall: `thin the web from ${p.web_mm} mm or use a higher-conductivity plate (copper alloy)`, contact: `raise the interface conductance (higher clamping pressure, liquid-metal or thinner TIM; ${fmt(hc, 4)} W/m²K now)`, ribbon: 'use thinner ribbons' };
    if (tHeat == null || tCool == null) out.recs.push({ level: 'critical', text: `The cycle cannot close: ${tHeat == null ? (H.reachable ? `heating did not reach Af(σH) = ${fmt(AfH, 4)} °C within ${fmt(H.r.t[H.r.t.length - 1], 3)} s` : `the hot fluid (${Th} °C) is below Af(σH) = ${fmt(AfH, 4)} °C`) : ''}${tHeat == null && tCool == null ? '; ' : ''}${tCool == null ? (C.reachable ? `cooling did not reach Mf(σL) = ${fmt(MfL, 4)} °C` : `the cold fluid (${Tc} °C) is above Mf(σL) = ${fmt(MfL, 4)} °C`) : ''}. Change the temperatures, stresses or alloy first — flow and contact improvements cannot fix a thermodynamically closed window.`, basis: 'Clausius–Clapeyron-shifted transformation temperatures vs fluid temperatures' });
    else out.recs.push({ level: fmax >= p.freq ? 'good' : 'critical', text: fmax >= p.freq ? `Thermal path supports ${fmt(fmax, 3)} Hz ≥ the ${p.freq} Hz target; the largest resistance is the ${dom} (${fmt(RbH[dom] / sumR(RbH) * 100, 3)} %) — to go faster, ${fixes[dom]}.` : `Thermal path limits the cell to ${fmt(fmax, 3)} Hz < ${p.freq} Hz target: ${fixes[dom]}; otherwise lower the engine frequency.`, basis: `t_heat ${fmt(tHeat, 4)} s, t_cool ${fmt(tCool, 4)} s, resistance budget` });
    if (Th - AfH < 5) out.recs.push({ level: 'warn', text: `Only ${fmt(Th - AfH, 3)} K between the hot fluid and Af(σH): the end of heating is a slow exponential tail. Reducing σH by 20 MPa lowers Af by ${fmt(20 / alloy.CA, 3)} K and shortens heating markedly (net work per cycle falls — check in Suite 05).`, basis: `Af(σH) = ${fmt(AfH, 4)} °C` });
    if (shareWall > 0.4) out.recs.push({ level: 'warn', text: `${fmt(shareWall * 100, 3)} % of the heating energy is stored in the plates. Halving the web or switching to a thin-walled polymer-composite plate with metal skin would raise the ribbon share and the thermal efficiency; regenerating it (Suite 09) recovers part of it.`, basis: 'region enthalpy changes of the 2-D heating run' });
    if (imbalance != null && Math.abs((dutyRec ?? 0.5) - p.dutyHot) > 0.05) out.recs.push({ level: 'info', text: `Set the hot-phase duty to ≈ ${fmt(dutyRec, 3)} (currently ${p.dutyHot}) to match t_heat/t_cool = ${fmt(tHeat / tCool, 3)}; phase timing in Suite 12 should use the same split.`, basis: 'heating and cooling times' });
    out.recs.push({ level: 'econ', text: `Pumping costs ${fmt(PpumpH + PpumpC, 3)} W for the engine (${fmt((PpumpH + PpumpC) / Math.max(1e-9, design.targetPower) * 100, 3)} % of the ${design.targetPower} W target). ${trade[trade.length - 1].f > fmax * 1.2 ? `Doubling flow raises f_max to ${fmt(trade.find(r => r.m === 2).f, 3)} Hz for ${fmt(trade.find(r => r.m === 2).P, 3)} W — worthwhile only while the extra shaft power exceeds the extra pumping.` : 'More flow buys little speed because the film is not the dominant resistance; invest in the contact/plate instead.'}`, basis: 'flow trade-off chart' });
    out.recs.push({ level: 'sustain', text: `${fH.name} on both circuits; ${p.hotFluid === 'fl-water' ? 'water has the best heat capacity and lowest embodied impact — keep it unless freeze protection is needed (glycol raises viscosity, Δp and pumping energy).' : 'consider water where freeze protection is not required: lower viscosity cuts pumping energy and the fluid is benign.'} Each kelvin of hot/cold fluid ΔT avoided through faster heat transfer lowers the exergy destroyed in the cell walls.`, basis: `μ_hot ${fmt(fH.mu * 1e3, 3)} mPa·s` });
    // ---------- animation ----------
    const snaps = H.r.snaps.concat(C.r.snaps.map(s => ({ t: s.t + H.r.t[H.r.t.length - 1], T: s.T, cold: true })));
    const xiOf = (T, cold) => (cold ? cosK(band(MsL - T, 0, MsL - MfL)) : 1 - cosK(band(T, AsH, AfH)));
    out.views.push({ label: 'Heating / cooling animation', icon: '🎞', render: (el) => anim2d(el, { duration: tAll[tAll.length - 1], label: 'Time', unit: 's', height: (W) => W < 640 ? 780 : 460, explain: 'Unit-cell temperature field (mirrored about the ribbon mid-plane) through the hot and cold phases, with the ribbon temperatures, fluid temperature and the transformed (martensite) fraction estimated from the mean ribbon temperature.', draw(g, tt, W, Hh) {
      const th = theme(), sn = snaps.reduce((a, b) => (Math.abs(b.t - tt) < Math.abs(a.t - tt) ? b : a)), col = (u) => cssColor(cmap(u, 'inferno')), narrow = W < 640, z = fontPx(W), fw = narrow ? W - 20 : W * 0.52;
      const hot = !sn.cold; label(g, `${hot ? 'HOT' : 'COLD'} fluid · t = ${fmt(sn.t, 4)} s`, 12, 10, { baseline: 'top', size: z + 1, weight: '600', maxW: fw, color: hot ? '#ef4444' : '#3b82f6' });
      const fy = 32, fh = narrow ? 300 : Hh - fy - 70;
      ML.paintField(g, mesh, sn.T, { x: 10, y: fy, w: fw, h: fh, lo: Tc, hi: Th, color: col, mirror: true });
      const cbW = Math.min(200, fw - 20), cy = fy + fh + 6; for (let k2 = 0; k2 <= 50; k2++) { g.fillStyle = col(k2 / 50); g.fillRect(14 + k2 * cbW / 51, cy, cbW / 51 + 0.5, 10); }
      label(g, `${Tc} °C`, 14, cy + 12, { baseline: 'top', size: z - 1, color: th.mute }); label(g, `${Th} °C`, 14 + cbW, cy + 12, { align: 'right', baseline: 'top', size: z - 1, color: th.mute });
      const iT = Math.min(tAll.length - 1, tAll.findIndex(v => v >= tt) < 0 ? tAll.length - 1 : tAll.findIndex(v => v >= tt)), Tm = cat(H.r.stats.ribbon.mean, C.r.stats.ribbon.mean)[iT];
      bar(g, { x: 14, y: cy + 30, w: fw - 8, h: 16, value: xiOf(Tm, iT >= H.r.t.length), max: 1, label: 'martensite fraction (from ribbon mean T)', color: '#c58b4b' });
      const py = narrow ? cy + 56 : 10;
      seriesPanel(g, { x: narrow ? 10 : W * 0.55, y: py, w: narrow ? W - 20 : W * 0.43, h: Hh - py - 10, T: tAll, t: tt, title: 'Temperatures', unit: '°C', series: [{ name: 'ribbon mean', y: cat(H.r.stats.ribbon.mean, C.r.stats.ribbon.mean), color: '#f59e0b' }, { name: 'plate mean', y: cat(H.r.stats.wall.mean, C.r.stats.wall.mean), color: '#94a3b8' }, { name: 'fluid', y: cat(H.tf, C.tf), color: '#38bdf8' }], hlines: [{ y: AfH, label: 'Af(σH)', color: '#ef4444' }, { y: MfL, label: 'Mf(σL)', color: '#3b82f6' }] });
    } }) });
    out.views.push({ label: 'Unit-cell mesh', icon: '🕸', render: (el) => { el.innerHTML = `<p class="small muted">Production mesh (structured, graded; channel walls in blue).</p>${ML.meshSVG(mesh)}`; } });
    out.exports.push(
      { label: 'Temperature histories CSV', action: () => download(new Blob([['t_s,phase,ribbon_mean_C,ribbon_min_C,ribbon_max_C,plate_mean_C,fluid_C,Q_W_per_m', ...tAll.map((tv, i) => { const hot = i < H.r.t.length, j = hot ? i : i - H.r.t.length, r = hot ? H.r : C.r; return [tv, hot ? 'hot' : 'cold', r.stats.ribbon.mean[j], r.stats.ribbon.min[j], r.stats.ribbon.max[j], r.stats.wall.mean[j], (hot ? H.tf : C.tf)[j], r.Q[j]].join(','); })].join('\n')], { type: 'text/csv' }), 'therma-s08-histories.csv') },
      { label: 'End-of-heating field VTK', action: () => download(new Blob([ML.toVTK(mesh, { point: { T_C: H.r.T } })], { type: 'text/plain' }), 'therma-s08-heated.vtk') },
      { label: 'Unit-cell mesh MSH 2.2', action: () => download(new Blob([ML.toMSH(mesh)], { type: 'text/plain' }), 'therma-s08-cell.msh') },
    );
    // ---------- outputs ----------
    out.outputs = {
      hHot_Wm2K: hHotFace, hCold_Wm2K: hColdFace, tHeat_s: tHeat, tCool_s: tCool, maxFreq_Hz: fmax, Rth_m2KW: R2D, dTmax_K: dTmax, hContact_Wm2K: hc, Bi,
      hHotWall_Wm2K: hHotW, hColdWall_Wm2K: hColdW, Rbudget: { hot: RbH, cold: RbC }, mdotHotCell_kgs: mdotH, mdotColdCell_kgs: mdotC, mdotRequiredHot_kgs: mdotReqH, Ppump_W: PpumpH + PpumpC,
      dpHot_Pa: dH.dp, dpCold_Pa: dC.dp, dutyRecommended: dutyRec, imbalance, plateEnergyShare: shareWall, EcellHeat_J: EinCell, gradMax_Kpm: gMax, AfH_C: AfH, MfL_C: MfL,
    };
    out.headline = tHeat != null && tCool != null ? `Heating ${fmt(tHeat, 3)} s + cooling ${fmt(tCool, 3)} s → f_max ${fmt(fmax, 3)} Hz (${fmax >= p.freq ? '≥' : '<'} ${p.freq} Hz target); h_hot ${fmt(hHotFace, 4)} W/m²K, h_c ${fmt(hc, 4)} W/m²K, Bi ${fmt(Bi, 2)}; ${dom} resistance dominates.` : `Transformation not completed: ${tHeat == null ? `heating cannot reach Af(σH) = ${fmt(AfH, 4)} °C` : ''}${tHeat == null && tCool == null ? ' and ' : ''}${tCool == null ? `cooling cannot reach Mf(σL) = ${fmt(MfL, 4)} °C` : ''} — see verdicts.`;
    out.headlineKind = tHeat != null && tCool != null ? (fmax >= p.freq ? 'ok' : 'warn') : 'fail';
    out.credibility = 'Numerically verified';
    return out;
  },
};
