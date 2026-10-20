// Whole-engine reference model for THERMA-X100 — the single source of truth for net power accounting used by the
// architecture, scheduling, thermodynamics, optimisation, economics and feasibility pages.
//   P_net = N·W_out·f·η_tr − P_bearing − P_pump,hot − P_pump,cold − P_valves − P_control
//   Q_hot = N·f·(Q_hot,cell − ε_regen·Q_sensible,cell)          η_th = P_net/Q_hot ≤ η_Carnot = 1 − T_c/T_h
// Specific power is reported on three mass bases (active SMA, cartridge, complete system) — never mixed.
import { cellTransient } from './sma.js';
import { ductHTC, pumpPower, fluid, carnot, KELVIN } from './heat.js';
import { get as getMat } from './materials.js';

export const REFERENCE_W_PER_KG = 36; // published 2019 active-material specific power cited by the source project
export const STRETCH_W_PER_KG = 3600;
export const MILESTONES = [[36, 'Published reference'], [100, 'First multicell prototype'], [250, 'Advanced prototype'], [500, 'High-performance demonstrator'], [1000, 'Aggressive stretch'], [3600, 'Original 100× aspiration']];

export const DEFAULT_ENGINE = {
  baseline: 1, name: 'THERMA-X100-LT laboratory reference', variant: 'LT', architecture: 'A', application: 'lab',
  Th: 70, Tc: 15, T0: 20, targetPower: 50,
  alloy: 'niti-lt', nCells: 12, ribbonsPerCell: 20, ribbonL: 0.1, ribbonW: 0.005, ribbonT: 100e-6,
  sigmaL: 70, sigmaH: 110, kBias: 0, freq: 1, dutyHot: 0.5, tSwitch: 0.02,
  hHot: 4000, hCold: 4000, hContact: 20000, wallCapacity: 200,
  regenEff: 0.6, hotFluid: 'fl-water', coldFluid: 'fl-water', fluidDT: 10, pumpEta: 0.45, coupleHydraulics: true,
  chW: 1.0e-3, chH: 0.8e-3, chPerCell: 60, purgeFraction: 0.05, valveEnergy: 0.02, controlPower: 2, transEff: 0.9, bearingLoss: 0.5,
  cartridgeFactor: 20, systemFactor: 50, rpm: 60,
};
export const ENGINE_FIELDS = [
  ['Th', 'Hot-source fluid temperature', '°C'], ['Tc', 'Cold-sink fluid temperature', '°C'], ['T0', 'Dead-state (ambient) temperature', '°C'], ['targetPower', 'Target net shaft power', 'W'],
  ['alloy', 'Active alloy', ''], ['nCells', 'Number of cells', ''], ['ribbonsPerCell', 'Ribbons per cell', ''], ['ribbonL', 'Ribbon active length', 'm'], ['ribbonW', 'Ribbon width', 'm'], ['ribbonT', 'Ribbon thickness', 'm'],
  ['sigmaL', 'Cold reset (bias) stress', 'MPa'], ['sigmaH', 'Hot power-stroke stress', 'MPa'], ['freq', 'Cycle frequency', 'Hz'], ['dutyHot', 'Hot-phase fraction', ''], ['regenEff', 'Regenerator effectiveness', ''],
];

// Cheap physical pre-screen (spec §26): flags infeasible cases before any expensive solve
export function preScreen(d, mat = getMat(d.alloy)) {
  const out = [];
  const add = (test, status, detail, fix) => out.push({ test, status, detail, fix });
  if (!mat) { add('Alloy selected', 'fail', `Unknown alloy “${d.alloy}”.`, 'Choose an alloy from the materials library (Suite 03).'); return out; }
  const AfH = mat.Af + d.sigmaH / mat.CA, AsH = mat.As + d.sigmaH / mat.CA, MfL = mat.Mf + d.sigmaL / mat.CM, MsL = mat.Ms + d.sigmaL / mat.CM;
  add('Heat-engine exergy exists (T_hot > T_cold)', d.Th > d.Tc + 1 ? 'pass' : 'fail', `T_hot = ${d.Th} °C, T_cold = ${d.Tc} °C. Uniform ambient exposure cannot sustain cyclic output (spec §2).`, 'Provide a hotter source or a colder sink.');
  add('Hot fluid can complete reverse transformation under the power-stroke stress', d.Th >= AfH ? 'pass' : d.Th > AsH ? 'warn' : 'fail', `Af(σH = ${d.sigmaH} MPa) = ${AfH.toFixed(1)} °C vs hot fluid ${d.Th} °C (As(σH) = ${AsH.toFixed(1)} °C). Stress raises the transformation temperatures by 1/CA = ${(1 / mat.CA).toFixed(3)} K/MPa.`, `Lower σH below ${((d.Th - 3 - mat.Af) * mat.CA).toFixed(0)} MPa, choose an alloy with lower Af, or raise the source temperature.`);
  add('Cold sink can complete forward transformation under the reset stress', d.Tc <= MfL ? 'pass' : d.Tc < MsL ? 'warn' : 'fail', `Mf(σL = ${d.sigmaL} MPa) = ${MfL.toFixed(1)} °C vs cold fluid ${d.Tc} °C (Ms(σL) = ${MsL.toFixed(1)} °C).`, 'Lower the sink temperature, reduce the reset stress or select an alloy with higher Mf.');
  add('Reset stress is high enough to re-extend (detwin) the cold martensite', d.sigmaL >= (mat.sigS ?? 0) ? (d.sigmaL >= (mat.sigF ?? 0) ? 'pass' : 'warn') : 'fail', `σL = ${d.sigmaL} MPa vs detwinning start σs = ${mat.sigS} MPa and finish σf = ${mat.sigF} MPa. Below σs cooling forms twinned martensite and no reset stroke occurs.`, `Raise σL toward ${mat.sigF} MPa (more reset work) or train the ribbon to lower its detwinning stress.`);
  add('Positive stress differential (net work possible)', d.sigmaH > d.sigmaL ? 'pass' : 'fail', `σH − σL = ${(d.sigmaH - d.sigmaL).toFixed(0)} MPa; the enclosed σ–ε loop area is proportional to it.`, 'σH must exceed σL.');
  add('Stress within allowable for functional fatigue', d.sigmaH <= 0.4 * (mat.su || 1000) ? 'pass' : 'warn', `σH = ${d.sigmaH} MPa vs 40 % of UTS (${(0.4 * (mat.su || 1000)).toFixed(0)} MPa).`, 'Reduce σH or accept shorter life (Suite 16).');
  const etaC = carnot(d.Th, d.Tc);
  add('Target power is thermodynamically possible from the source', 'info', `Carnot limit ${(etaC * 100).toFixed(2)} %: delivering ${d.targetPower} W needs at least ${(d.targetPower / Math.max(etaC, 1e-9)).toFixed(0)} W of heat at 100 % of Carnot; at a realistic 2–10 % of Carnot, ${(d.targetPower / Math.max(etaC * 0.1, 1e-9) / 1000).toFixed(1)}–${(d.targetPower / Math.max(etaC * 0.02, 1e-9) / 1000).toFixed(1)} kW.`);
  return out;
}

// Full reference evaluation: one transient cell, then array scaling, auxiliaries and mass bases
export function engineModel(d, { mat = getMat(d.alloy), cell = null, n = 3, stepsPerCycle = 200, cycles = 4 } = {}) {
  const runCell = (hH, hC) => cellTransient({ mat, t: d.ribbonT, w: d.ribbonW, L: d.ribbonL, nRib: d.ribbonsPerCell, n, Th: d.Th, Tc: d.Tc, hHot: hH, hCold: hC, hc: d.hContact, Cw: d.wallCapacity, period: 1 / d.freq, dutyHot: d.dutyHot, tSwitch: d.tSwitch, sBias0: d.sigmaL, kBias: d.kBias, sLoad: Math.max(0, d.sigmaH - d.sigmaL), cycles, stepsPerCycle });
  const f = d.freq, N = d.nCells;
  // one fixed-point pass couples the fluid-side HTC to the flow the cell actually needs (area-weighted to the ribbon face)
  let hHot = d.hHot, hCold = d.hCold, c = cell || runCell(hHot, hCold), hydraulicIterations = 0;
  if (!cell && d.coupleHydraulics) for (let it = 0; it < 2; it++) {
    const hy = hydraulics(d, c, N, f), wet = d.chPerCell * 2 * (d.chW + d.chH) * d.ribbonL, face = c.faceArea;
    const hH = hy.hydH.h * Math.min(2, wet / face), hC = hy.hydC.h * Math.min(2, wet / face);
    if (Math.abs(hH - hHot) / hHot < 0.05 && Math.abs(hC - hCold) / hCold < 0.05) break;
    hHot = hH; hCold = hC; c = runCell(hHot, hCold); hydraulicIterations++;
  }
  // heat: latent part cannot be regenerated; the sensible part (ribbon + wall heating) can, up to ε_regen
  const latent = c.mass * (mat.Lh || 0) * c.xiSwing, sensible = Math.max(0, c.Qhot - latent - c.Wout);
  // channel fluid inventory: at each hot→cold / cold→hot switch the trapped fluid is displaced; the fraction not routed back
  // to its own circuit (purgeFraction) mixes and must be re-heated by the source (spec §15 thermal short circuits)
  const fhIn = fluid(d.hotFluid, d.Th), Cfluid = d.chPerCell * d.chW * d.chH * d.ribbonL * fhIn.rho * fhIn.cp;
  const Qpurge = d.purgeFraction * Cfluid * Math.max(0, d.Th - d.Tc);
  const QhotCell = c.Qhot - d.regenEff * sensible + Qpurge, QhotTot = N * f * QhotCell, QrejTot = QhotTot - N * f * c.Wout;
  const { mdotH, mdotC, hydH, hydC, fh, fc } = hydraulics(d, c, N, f);
  const Ppump = pumpPower(hydH.dp * 1.5, mdotH / fh.rho, d.pumpEta) + pumpPower(hydC.dp * 1.5, mdotC / fc.rho, d.pumpEta); // ×1.5 manifold & valve losses
  const Pvalves = 2 * N * f * d.valveEnergy, Pgross = N * c.Wout * f, Pshaft = Pgross * d.transEff - d.bearingLoss;
  const Paux = Ppump + Pvalves + d.controlPower, Pnet = Pshaft - Paux;
  const mActive = N * c.mass, mCart = mActive * d.cartridgeFactor, mSys = mActive * d.systemFactor;
  const etaC = carnot(d.Th, d.Tc), eta = QhotTot > 0 ? Pnet / QhotTot : 0;
  const T0K = d.T0 + KELVIN, exIn = QhotTot * (1 - T0K / (d.Th + KELVIN));
  const perCellNet = Pnet / N; // average net per cell
  const cellsForTarget = c.Wout * f * d.transEff - (Ppump + Pvalves) / N > 0 ? Math.ceil((d.targetPower + d.controlPower + d.bearingLoss) / (c.Wout * f * d.transEff - (Ppump + Pvalves) / N)) : Infinity;
  const omega = d.rpm * 2 * Math.PI / 60;
  return {
    cell: c, f, N, latent, sensible, Qpurge, Cfluid, QhotCell, QhotTot, QrejTot, mdotH, mdotC, hydH, hydC,
    Pgross, Pshaft, Ppump, Pvalves, Pcontrol: d.controlPower, Paux, Pnet, etaC, eta, carnotFraction: etaC > 0 ? eta / etaC : 0,
    exergyIn: exIn, exergyEff: exIn > 0 ? Pnet / exIn : 0,
    mActive, mCart, mSys, pActive: Pnet / mActive, pCart: Pnet / mCart, pSys: Pnet / mSys, pActiveGross: Pgross / mActive,
    refRatio: Pnet / mActive / REFERENCE_W_PER_KG, hHotUsed: hHot, hColdUsed: hCold, hydraulicIterations, perCellNet, cellsForTarget, torqueMean: omega > 0 ? Pshaft / omega : 0, omega,
    netPositive: Pnet > 0, meetsTarget: Pnet >= d.targetPower,
  };
}
// Hydraulics: flow sized to limit the fluid temperature change to fluidDT; channels of a cell carry the flow only
// during their own phase (duty-weighted instantaneous flow)
export function hydraulics(d, c, N, f) {
  const Tmh = d.Th - d.fluidDT / 2, Tmc = d.Tc + d.fluidDT / 2, fh = fluid(d.hotFluid, Tmh), fc = fluid(d.coldFluid, Tmc);
  const mdotH = Math.max(1e-6, N * f * c.Qhot / (fh.cp * d.fluidDT)), mdotC = Math.max(1e-6, N * f * c.Qcold / (fc.cp * d.fluidDT));
  const hydH = ductHTC({ fluidId: d.hotFluid, T: Tmh, w: d.chW, hgt: d.chH, L: d.ribbonL, mdot: mdotH / N / Math.max(d.dutyHot, 0.05), nChannels: d.chPerCell });
  const hydC = ductHTC({ fluidId: d.coldFluid, T: Tmc, w: d.chW, hgt: d.chH, L: d.ribbonL, mdot: mdotC / N / Math.max(1 - d.dutyHot, 0.05), nChannels: d.chPerCell });
  return { mdotH, mdotC, hydH, hydC, fh, fc };
}
// Merge the project engine with suite-level overrides (only defined keys)
export const designWith = (base, over = {}) => { const d = { ...DEFAULT_ENGINE, ...base }; for (const [k, v] of Object.entries(over)) if (v !== undefined && v !== null && v !== '') d[k] = v; return d; };
