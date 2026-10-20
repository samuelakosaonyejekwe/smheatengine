// THERMA-X100 3-D simulation preparation (DOM-free): every quantity that moves or colours a 3-D scene in views3d.js is
// solved here from the shared models — transient ribbon cell (sma.cellTransient), shaft dynamics (Suite 11 integrator),
// start-up history (Suite 15), 2-D conjugate conduction of the microchannel unit cell (meshlab P1 FE) and the compliant
// transmission (pseudo-rigid-body bridge kinematics, fem.bistableBeam, fem.homogenize). When a suite has published the
// relevant outputs they are used (coupled); otherwise the models are re-solved at low resolution with the same inputs.
import { cellTransient, cellFromDesign, SMA } from './sma.js';
import { DEFAULT_ENGINE, designWith, hydraulics } from './engine.js';
import { fluid, ductHTC } from './heat.js';
import { get as getMat, componentMaterial } from './materials.js';
import { bistableBeam, homogenize } from './fem.js';
import * as ML from './meshlab.js';
import { clamp, range, linspace, mean, interp1 } from './num.js';

const TAU = 2 * Math.PI;
const tick = () => new Promise(r => setTimeout(r, 0));

// ---------------- small helpers ----------------
export const designOf = (ctx) => designWith(ctx?.engine || DEFAULT_ENGINE, ctx?.upstream?.('s01')?.design || {});
export const up = (ctx, id) => { try { return ctx?.upstream?.(id) || null; } catch { return null; } };
// suite parameters without the store: automatic generator (coupled/calc/library) → default; `over` wins
export function resolveDefaults(def, ctx, over = {}) {
  const out = {};
  for (const q of def?.params || []) {
    let v; if (q.auto) { try { const a = q.auto(ctx); if (a !== undefined && a !== null) v = typeof a === 'object' && 'value' in a ? a.value : a; } catch { /* fall back to default */ } }
    out[q.key] = v ?? q.default;
  }
  for (const [k, v] of Object.entries(over || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
}
// alloy card: library entry, refined by Suite 03 card when it describes the same alloy
export function alloyOf(ctx, id) {
  const lib = getMat(id) || getMat('niti-lt'), s03 = up(ctx, 's03');
  return s03?.alloyId === lib.id && s03.card ? { ...lib, ...s03.card } : lib;
}
// periodic sampler over a uniformly sampled cycle history (hist.t[0] = 0, step P/n)
export function periodic(hist, P) {
  const n = hist.t.length, dt = P / n;
  return (key, tau) => { const a = hist[key]; let q = ((tau % P) + P) % P / dt; const i = Math.floor(q) % n, f = q - Math.floor(q), j = (i + 1) % n; return a[i] + (a[j] - a[i]) * f; };
}
// non-periodic sampler on a monotone time base (binary search; clamps at the ends)
export function sampler(t, ...series) {
  const n = t.length;
  return (tt, out = {}) => {
    let lo = 0, hi = n - 1; if (tt <= t[0]) hi = 0; else if (tt >= t[n - 1]) lo = hi = n - 1; else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= tt) lo = m; else hi = m; } }
    const f = hi > lo ? (tt - t[lo]) / ((t[hi] - t[lo]) || 1) : 0; for (const [k, a] of series) out[k] = a[lo] + (a[hi] - a[lo]) * f; return out;
  };
}
export function phaseOffsets(ctx, N, prefer = 's12') {
  const o = up(ctx, 's12')?.offsets;
  if (prefer === 's12' && Array.isArray(o) && o.length === N) return { offsets: o.map(Number), src: 'Suite 12 optimised offsets (coupled)' };
  return { offsets: range(N).map(i => i / N), src: 'uniform offsets k/N' };
}

// ---------------- single transient cell ----------------
// over: any cellTransient option; returns the periodic last-cycle history and the derived kinematics
export function solveCell(ctx, d = designOf(ctx), over = {}) {
  const mat = alloyOf(ctx, d.alloy);
  const cell = cellFromDesign(mat, d, { n: 3, stepsPerCycle: 160, cycles: 3, ...over });
  return wrapCell(cell, mat, over.period ?? 1 / d.freq, over.dutyHot ?? d.dutyHot, { Th: over.Th ?? d.Th, Tc: over.Tc ?? d.Tc, sigmaL: over.sBias0 ?? d.sigmaL, sigmaH: (over.sBias0 ?? d.sigmaL) + (over.sLoad ?? Math.max(0, d.sigmaH - d.sigmaL)) });
}
export function wrapCell(cell, mat, P, duty, info = {}) {
  const H = cell.hist, at = periodic(H, P);
  const xMax = Math.max(...H.x), xMin = Math.min(...H.x), Fmax = Math.max(...H.F), Fmin = Math.min(...H.F);
  const Tlo = Math.min(...H.Tf, ...H.Tm), Thi = Math.max(...H.Tf, ...H.Tm);
  const AfH = mat.Af + (info.sigmaH ?? 0) / mat.CA, MfL = mat.Mf + (info.sigmaL ?? 0) / mat.CM;
  return { cell, hist: H, mat, P, duty, at, xMax, xMin, Fmax, Fmin, Tlo, Thi, AfH, MfL, ...info };
}
// Suite 05: same configuration as its run (n and steps capped for interactive playback)
export function cellFromS05(ctx, p) {
  if (!p || p.ribbonL_mm === undefined) return solveCell(ctx);
  const mat = alloyOf(ctx, p.alloy), L = p.ribbonL_mm * 1e-3, w = p.ribbonW_mm * 1e-3, t = p.ribbonT_um * 1e-6, A = p.nRib * w * t, P = 1 / p.freq;
  const cfg = { mat, t, w, L, nRib: p.nRib, n: Math.min(p.n ?? 4, 4), Th: p.Th, Tc: p.Tc, hHot: p.hHot, hCold: p.hCold, hc: p.hContact, Cw: p.wallCapacity, period: P, dutyHot: p.dutyHot, tSwitch: p.tSwitch, sBias0: p.sigmaL, kBias: (p.kBias_Nmm || 0) * 1e3 * L / A / 1e6, sLoad: p.sigmaH - p.sigmaL, cycles: Math.min(p.cycles ?? 4, 4), stepsPerCycle: Math.min(p.spc ?? 240, 240), kinetics: p.kinetics || 'cosine' };
  return { ...wrapCell(cellTransient(cfg), mat, P, p.dutyHot, { Th: p.Th, Tc: p.Tc, sigmaL: p.sigmaL, sigmaH: p.sigmaH }), geom: { L, w, t, nRib: p.nRib }, kBias_Nmm: p.kBias_Nmm || 0 };
}
// Suite 14: converged co-simulation operating point (h, f, load) → full cell history
export function cellFromS14(ctx, res) {
  const o = res?.outputs || up(ctx, 's14') || {}, d = designOf(ctx);
  const over = {}; if (o.hHot > 0) over.hHot = o.hHot; if (o.hCold > 0) over.hCold = o.hCold; if (o.freq_Hz > 0) over.period = 1 / o.freq_Hz; if (o.sLoad_MPa >= 0 && o.sLoad_MPa !== undefined) over.sLoad = o.sLoad_MPa;
  const r = solveCell(ctx, d, { n: 4, stepsPerCycle: 200, ...over }); r.src = Object.keys(over).length ? 'converged co-simulation operating point (Suite 14)' : 'engine design (Suite 14 not run)'; return r;
}

// ---------------- shaft dynamics (Suite 11 integrator) ----------------
// p: Suite 11 parameters (resolved) or partial; offsets: phase fractions. Runs from rest to periodic steady state and records
// a steady window with per-cell torques.
export async function solveShaft(ctx, { p = {}, offsets = null, maxCycles = 40, window = 3, record = true } = {}) {
  const S = await import('../suites/s11-shaft.js');
  const def = S.default, pp = resolveDefaults(def, ctx, p);
  const d = designOf(ctx), N = Math.max(1, Math.round(pp.nCells || d.nCells)), omegaD = (pp.rpm || d.rpm) * TAU / 60;
  const { cell, drive: dr0, mat } = S.cellDrive(ctx, d, { spc: 160 });
  const A = pp.amplification || 1, dr = S.scaleDrive(dr0, A, pp.metaEff ?? 0.98);
  let ks = S.ribbonStiffness(mat, d, cell) / (A * A); if (pp.coupling === 'cable') ks = 1 / (1 / ks + 1 / (pp.kCable * 1e3));
  const etaCam = pp.coupling === 'cam' ? clamp(1 - 2 * pp.mu * Math.tan(pp.pressureAngle * Math.PI / 180), 0.3, 1) : 1;
  const eta = pp.etaGear * pp.etaClutch * etaCam, J = pp.J + pp.Jfly, cs = 2 * pp.zeta * Math.sqrt(ks * pp.mCarriage);
  let G = pp.gearMode === 'manual' ? pp.gear : S.designGear(dr, pp.rArm, omegaD), R0 = S.effRadius(pp.rArm, G);
  const fricMean = (w) => pp.tauC + pp.cVisc * w;
  const charAt = (R) => { const ws = linspace(0, 3 * dr.vMean / R, 41), tq = ws.map(w => N * S.constantSpeedCell(dr, { omega: w, R, eta, ks, cs }).mean), tn = tq.map((v, k) => v - (k ? fricMean(ws[k]) + N * pp.tauDrag * 0.5 : 0)); let kS = 0; for (let k = 1; k < ws.length; k++) if (tn[k] * ws[k] > tn[kS] * ws[kS]) kS = k; return { wStar: ws[kS], tStar: Math.max(0, tn[kS]) }; };
  let ch = charAt(R0);
  if (pp.gearMode !== 'manual' && ch.wStar > 0) { G = clamp(G * omegaD / ch.wStar, 0.2, 500); R0 = S.effRadius(pp.rArm, G); ch = charAt(R0); }
  const shape = (w) => pp.loadType === 'constant' ? 1 : pp.loadType === 'linear' ? w / omegaD : (w / omegaD) ** 2;
  const loadRef = pp.loadMode === 'manual' ? pp.loadTorque : (pp.loadType === 'constant' ? ch.tStar : ch.tStar / Math.max(shape(ch.wStar), 1e-9)) * 0.98;
  const load = (w) => loadRef * shape(Math.max(0, w));
  const offs = offsets && offsets.length === N ? offsets : range(N).map(i => i / N), P = dr.P;
  const Rf = pp.coupling === 'cam' ? (th) => R0 * (1 + pp.camAmp * Math.sin(pp.camLobes * th)) : () => R0;
  const base = { N, drive: (i, t, o) => S.driveLookup(dr, t + offs[i] * P, o), R: Rf, eta, ks, cs, J, tauC: pp.tauC, cVisc: pp.cVisc, tauS: pp.tauC * pp.staticFactor, tauDrag: pp.tauDrag, load };
  const spc = Math.min(pp.spc || 160, 160), Hr = { t: [], omega: [], theta: [], tq: [], engaged: [] }, cm = [];
  let st = { omega: 0, theta: 0, xc: null }, nCyc = 0, converged = false;
  while (nCyc < maxCycles) {
    const s = S.simulateShaft({ ...base, t0: nCyc * P, t1: (nCyc + 5) * P, h: P / spc, omega0: st.omega, theta0: st.theta, xc0: st.xc, record: 2 });
    for (const k of Object.keys(Hr)) Hr[k].push(...s.H[k].slice(nCyc ? 1 : 0));
    for (let c = 0; c < 5; c++) { let a = 0, m = 0; for (let k = 0; k < s.H.t.length; k++) { const tt = s.H.t[k] - nCyc * P; if (tt >= c * P && tt < (c + 1) * P) { a += s.H.omega[k]; m++; } } cm.push(m ? a / m : 0); }
    st = { omega: s.omega, theta: s.theta, xc: s.xc }; nCyc += 5;
    const L = cm.length; if (nCyc >= 10 && L >= 6 && Math.abs(mean(cm.slice(L - 3)) - mean(cm.slice(L - 6, L - 3))) <= 0.005 * Math.max(Math.abs(mean(cm.slice(L - 3))), 1e-6)) { converged = true; break; }
    await tick();
  }
  const t0 = nCyc * P, win = record ? S.simulateShaft({ ...base, t0, t1: t0 + window * P, h: P / spc, omega0: st.omega, theta0: st.theta, xc0: st.xc, record: 1, recCellsFrom: t0 }) : null;
  const W = win ? win.H : null;
  const tq = W ? W.tq : [], tqMean = W ? mean(tq) : 0, ripple = tqMean > 0 ? (Math.max(...tq) - Math.min(...tq)) / tqMean : NaN;
  return { N, P, offsets: offs, dr, dr0, cell, mat, d, pp, R0, G, eta, ks, J, loadRef, load, fromRest: Hr, converged, cyclesToSteady: nCyc,
    win: W && { t: W.t.map(v => v - t0), omega: W.omega, theta: W.theta.map(v => v - W.theta[0]), tq: W.tq, tl: W.tl, tf: W.tf, engaged: W.engaged, cellTau: W.cellTau },
    omegaMean: W ? mean(W.omega) : st.omega, tqMean, ripple, Pshaft: W ? mean(W.tl.map((v, k) => v * W.omega[k])) : 0,
    wrap: wrapCell(cell, mat, P, d.dutyHot, { Th: d.Th, Tc: d.Tc, sigmaL: d.sigmaL, sigmaH: d.sigmaH }) };
}

// ---------------- whole engine (geometry + shaft + cells + manifold flow) ----------------
export async function solveEngine(ctx, { p02 = null, offsets = null, shaft = true } = {}) {
  const S02 = await import('../suites/s02-cad-mesh.js'), d = designOf(ctx);
  const pg = p02 && p02.nCells !== undefined ? p02 : resolveDefaults(S02.default, ctx);
  const alloy = alloyOf(ctx, pg.alloy || d.alloy), N = Math.max(3, Math.round(pg.nCells));
  const geo = S02.buildEngineGeometry(pg, { alloy, stroke05: up(ctx, 's05')?.stroke_m });
  const ph = offsets ? { offsets, src: 'given' } : phaseOffsets(ctx, N);
  const sh = shaft ? await solveShaft(ctx, { p: { nCells: N }, offsets: ph.offsets }) : null;
  const c = sh ? sh.wrap : solveCell(ctx, d), hy = hydraulics(d, c.cell, N, 1 / c.P), fh = fluid(d.hotFluid, d.Th), fc = fluid(d.coldFluid, d.Tc);
  const Aman = Math.PI * geo.rM ** 2, Aport = Math.PI * (geo.g.portD / 2) ** 2;
  const flow = { mdotH: hy.mdotH, mdotC: hy.mdotC, vRingH: hy.mdotH / (fh.rho * Aman) / 2, vRingC: hy.mdotC / (fc.rho * Aman) / 2, vPortH: hy.mdotH / N / Math.max(d.dutyHot, 0.05) / (fh.rho * Aport), vPortC: hy.mdotC / N / Math.max(1 - d.dutyHot, 0.05) / (fc.rho * Aport) };
  return { geo, pg, d, alloy, N, offsets: ph.offsets, offSrc: ph.src, shaft: sh, cell: c, flow, S02 };
}

// ---------------- Suite 15 start-up history ----------------
const findChart = (res, re) => (res?.charts || []).find(c => re.test(c.title || ''));
function startupFromCharts(res) {
  const cw = findChart(res, /start-?up.*steady|steady running and shutdown/i), ct = findChart(res, /torque balance/i), cT = findChart(res, /circuit.*temperature/i);
  if (!cw?.series?.[0]?.x?.length) return null;
  const s = cw.series[0], t = s.x.map(Number), omega = s.y.map(v => v * TAU / 60), theta = [0];
  for (let k = 1; k < t.length; k++) theta.push(theta[k - 1] + 0.5 * (omega[k] + omega[k - 1]) * (t[k] - t[k - 1]));
  const ser = (c, re) => c?.series?.find(q => re.test(q.name || ''));
  const marks = {}; for (const a of cw.annotations || []) if (a.type === 'vline' && Number.isFinite(a.x)) marks[a.label] = a.x;
  const tq = ser(ct, /drive/i), eng = ser(ct, /engaged/i), Th = ser(cT, /hot circuit/i), Tc = ser(cT, /cold circuit/i);
  return { t, omega, theta, tq: tq ? { t: tq.x, y: tq.y } : null, engaged: eng ? { t: eng.x, y: eng.y } : null, Thot: Th ? { t: Th.x, y: Th.y } : null, Tcold: Tc ? { t: Tc.x, y: Tc.y } : null, marks, outputs: res.outputs || {} };
}
export async function solveStartup(ctx, res, p) {
  let r = startupFromCharts(res), src = 'Suite 15 solved start-up history';
  if (!r) {
    const def = (await import('../suites/s15-dynamics.js')).default, pp = resolveDefaults(def, ctx, { ...(p || {}), nLevels: 3, cellSpc: 80, spc: 50 });
    const q = { ...ctx, progress: () => { }, yield: tick };
    try { r = startupFromCharts(await def.run(pp, q)); src = 'Suite 15 model re-solved at low resolution'; } catch { r = null; }
    p = pp;
  }
  if (!r) return null;
  const d = designOf(ctx), N = Math.max(1, Math.round(p?.nCells || d.nCells));
  const cell = solveCell(ctx, { ...d, Th: p?.Th ?? d.Th, Tc: p?.Tc ?? d.Tc });
  return { ...r, src, N, cell, Th: p?.Th ?? d.Th, Tc: p?.Tc ?? d.Tc, T0: p?.T0 ?? d.T0, nStart: Math.max(1, Math.round(p?.nStart ?? Math.ceil(N / 4))), offsets: phaseOffsets(ctx, N).offsets };
}

// ---------------- Suite 08 unit-cell transient (2-D P1 FE, enthalpy latent heat) ----------------
export async function solveMicrochannel(ctx, res, p = {}) {
  const S08 = await import('../suites/s08-microchannels.js'), pp = resolveDefaults(S08.default, ctx, p), o = res?.outputs || up(ctx, 's08') || {};
  const alloy = alloyOf(ctx, pp.alloy), pm = getMat(pp.plateMat) || getMat('ss-316l'), cm = getMat(pp.contactMat) || getMat('tim-graphite') || pm;
  const t = pp.t_um / 1e6, w = pp.w_mm / 1e3, L = pp.L_mm / 1e3, chW = pp.chW_mm / 1e3, chH = pp.chH_mm / 1e3, nRib = Math.max(1, Math.round(pp.nRib));
  const nPlates = pp.plate === 'dedicated' ? 2 * nRib : nRib + 1, nChPlate = Math.max(1, Math.round(pp.chPerCell / nPlates)), pitch = w / nChPlate, nCh = nChPlate * nPlates;
  const sec = ML.cartridgeSection({ t, tc: pp.tc_um / 1e6, chW, chH, web: pp.web_mm / 1e3, skin: pp.skin_mm / 1e3, pitch, plate: pp.plate, half: true });
  if (sec.errors.length) return { error: sec.errors.join(' ') };
  const mesh = ML.buildMesh(sec, { type: 'structured', ...ML.defaultSizes(sec, { nRibbon: 2, nChannel: 3, growth: 1.4, maxAspect: 8 }), refine: 1 });
  const kRib = pp.kRibbon > 0 ? pp.kRibbon : 0.5 * (alloy.k + (alloy.kM ?? alloy.k)), hc = o.hContact_Wm2K || cm.hc || pp.hcUser;
  const props = { ribbon: { k: kRib, rho: alloy.rho, cp: alloy.cp }, contact: { k: hc * sec.tc, rho: cm.rho, cp: cm.cp }, wall: { k: pm.k, rho: pm.rho, cp: pm.cp } };
  const sm = new SMA(alloy), AfH = sm.temps(pp.sigmaH).Af, AsH = sm.temps(pp.sigmaH).As, MsL = sm.temps(pp.sigmaL).Ms, MfL = sm.temps(pp.sigmaL).Mf, Th = pp.Th, Tc = pp.Tc;
  const fH = fluid(pp.hotFluid, Th - pp.fluidDT / 2), fC = fluid(pp.coldFluid, Tc + pp.fluidDT / 2);
  const rcR = alloy.rho * alloy.cp, Csec = sec.areas.ribbon * rcR + sec.areas.contact * cm.rho * cm.cp + sec.areas.wall * pm.rho * pm.cp, Elat = sec.areas.ribbon * alloy.rho * (alloy.Lh || 0);
  const unitCells = 2 * nChPlate * nRib, Ecell = unitCells * L * (Csec * (Th - Tc) + Elat);
  const mdotH = o.mdotHotCell_kgs || (pp.flowMode === 'user' ? pp.mdotUser : Ecell * pp.freq / (fH.cp * pp.fluidDT * Math.max(0.05, pp.dutyHot)));
  const mdotC = o.mdotColdCell_kgs || (pp.flowMode === 'user' ? pp.mdotUser : Ecell * pp.freq / (fC.cp * pp.fluidDT * Math.max(0.05, 1 - pp.dutyHot)));
  const hHotW = o.hHotWall_Wm2K || (pp.htcModel === 'user' ? pp.hHotUser : ductHTC({ fluidId: pp.hotFluid, T: Th - pp.fluidDT / 2, w: chW, hgt: chH, L, mdot: mdotH, nChannels: nCh, bc: pp.nuBC }).h);
  const hColdW = o.hColdWall_Wm2K || (pp.htcModel === 'user' ? pp.hColdUser : ductHTC({ fluidId: pp.coldFluid, T: Tc + pp.fluidDT / 2, w: chW, hgt: chH, L, mdot: mdotC, nChannels: nCh, bc: pp.nuBC }).h);
  const band = (T, a, b) => clamp((T - a) / Math.max(1e-6, b - a), 0, 1), cosK = (x) => 0.5 * (1 - Math.cos(Math.PI * x)), Lv = alloy.rho * (alloy.Lh || 0);
  const Hheat = (T) => rcR * T + Lv * cosK(band(T, AsH, AfH)), Hcool = (T) => rcR * T + Lv * (1 - cosK(band(MsL - T, 0, MsL - MfL)));
  const wet = sec.wetPerimeter, tauH = (Csec + Elat / Math.max(1, AfH - AsH)) / (hHotW * wet), tauC = (Csec + Elat / Math.max(1, MsL - MfL)) / (hColdW * wet);
  const tHot = o.tHeat_s > 0 ? 1.35 * o.tHeat_s : 4 * tauH, tCold = o.tCool_s > 0 ? 1.35 * o.tCool_s : 4 * tauC, steps = 48;
  const run = (hot, T0, tEnd) => ML.solveTransient(mesh, { props, bcs: { channel: { type: 'robin', h: hot ? hHotW : hColdW, Tinf: hot ? Th : Tc } }, enthalpy: { ribbon: hot ? Hheat : Hcool }, T0, dt: tEnd / steps, steps, snapEvery: 1, maxSnaps: steps + 2 });
  const H = run(true, Tc, tHot); await tick(); const C = run(false, H.T, tCold);
  const snaps = [...H.snaps.map(s => ({ t: s.t, T: s.T, hot: true })), ...C.snaps.slice(1).map(s => ({ t: s.t + tHot, T: s.T, hot: false }))];
  const stat = (k, r) => [...H.stats[k][r], ...C.stats[k][r].slice(1)], tS = [...H.t, ...C.t.slice(1).map(v => v + tHot)];
  const duct = S08.ductVelocity(chW, chH, 21, 17, 31), Ach = chW * chH;
  const uH = mdotH / nCh / (fH.rho * Ach), uC = mdotC / nCh / (fC.rho * Ach), Dh = 4 * Ach / (2 * (chW + chH));
  return { mesh, sec, snaps, tHot, tCold, tEnd: tHot + tCold, Th, Tc, AfH, MfL, hHotW, hColdW, mdotH, mdotC, nCh, uH, uC, ReH: fH.rho * uH * Dh / fH.mu, ReC: fC.rho * uC * Dh / fC.mu, fH, fC, duct, L, pitch, chW, chH,
    tStat: tS, ribMean: stat('ribbon', 'mean'), ribMin: stat('ribbon', 'min'), ribMax: stat('ribbon', 'max'), wallMean: stat('wall', 'mean'), src: o.tHeat_s ? 'Suite 08 heating/cooling times (coupled), field re-solved on a coarse unit-cell mesh' : 'unit-cell field re-solved on a coarse mesh', plateName: pm.name, alloyName: alloy.name, residual: Math.max(H.residual, C.residual) };
}

// ---------------- Suite 10 compliant transmission ----------------
// Bridge amplifier as a pseudo-rigid-body model: rigid arm + two flexure hinges per arm (bending stiffness EI/l_h),
// geometry closed exactly for a prescribed input closure; F_in = dU/dd with U = hinge strain energy + output-spring energy.
export function bridgePRB({ L, alpha, th, lh, ta, b, E, kL = 0, nSeg = 3 }) {
  const a0 = L * Math.cos(alpha), Ih = b * th ** 3 / 12, kh = E * Ih / lh, La = L - 2 * lh;
  const chain = (theta) => { // hinges bend linearly from α at the blocks to θ at the arm
    let x = 0, y = 0; const pts = [[0, 0]], ang = [];
    for (let k = 0; k < nSeg; k++) { const a = alpha + (theta - alpha) * (k + 0.5) / nSeg; x += lh / nSeg * Math.cos(a); y += lh / nSeg * Math.sin(a); pts.push([x, y]); ang.push(a); }
    x += La * Math.cos(theta); y += La * Math.sin(theta); pts.push([x, y]); ang.push(theta);
    for (let k = 0; k < nSeg; k++) { const a = theta + (alpha - theta) * (k + 0.5) / nSeg; x += lh / nSeg * Math.cos(a); y += lh / nSeg * Math.sin(a); pts.push([x, y]); ang.push(a); }
    return { pts, ang, x, y };
  };
  const c0 = chain(alpha).y;
  const state = (d) => { // input closure d (both blocks move d/2 inward)
    const target = a0 - d / 2; let lo = alpha, hi = Math.PI / 2 - 1e-4;
    for (let it = 0; it < 60; it++) { const m = 0.5 * (lo + hi); if (chain(m).x > target) lo = m; else hi = m; }
    const theta = 0.5 * (lo + hi), ch = chain(theta), dTh = theta - alpha, dout = 2 * (ch.y - c0);
    const U = 8 * 0.5 * kh * dTh * dTh + 0.5 * kL * dout * dout, sig = E * th * Math.abs(dTh) / (2 * lh);
    return { d, theta, dTh, dout, U, sig, chain: ch, aNow: target, cNow: ch.y };
  };
  return { state, a0, c0, kh, alpha };
}
export async function solveMechanism(ctx, res, p = {}) {
  const S10 = await import('../suites/s10-metamaterial.js'), pp = resolveDefaults(S10.default, ctx, p), o = res?.outputs || up(ctx, 's10') || {};
  const fm = getMat(pp.mat) || getMat('ti-beta21s') || { E: 100, name: 'flexure' }, E = (fm.E ?? fm.EA ?? 100) * 1e9;
  const sh = solveCell(ctx), xf = sh.hist.x.map(v => v - sh.xMin), xm = Math.max(1e-12, sh.xMax - sh.xMin);
  const dIn = pp.stroke > 0 ? pp.stroke / 1000 : xm, dPre = pp.dPre / 1000, type = pp.cellType || 'amplifier';
  const out = { type, pp, cell: sh, xf, xm, dIn, dPre, E, matName: fm.name, published: o };
  if (type === 'bistable') {
    const BB = bistableBeam({ L: pp.bL / 1000, h: pp.bH / 1000, t: pp.bT / 1000, b: pp.bB / 1000, E, nSteps: 80, nq: 80 }), nB = Math.max(1, Math.round(pp.bN));
    const dEnd = Number.isFinite(BB.d2) ? BB.d2 : BB.d[BB.d.length - 1];
    Object.assign(out, { BB, nB, dEnd, Fmax: Math.max(...BB.F.map(Math.abs)) * nB });
  } else if (type === 'auxetic') {
    const l = pp.lStrut / 1000, h = pp.hRatio * l, th = pp.theta * Math.PI / 180;
    const cell = { nodes: [[0, 0], [0, h]], struts: [{ i: 0, j: 1 }, { i: 1, j: 0, shift: [0, 1] }, { i: 1, j: 0, shift: [-1, 1] }], a1: [2 * l * Math.cos(th), 0], a2: [l * Math.cos(th), h + l * Math.sin(th)] };
    const LH = homogenize(cell, E, pp.tStrut / 1000, pp.depth / 1000), C = LH.C, Lx = pp.nx * cell.a1[0], Ly = pp.ny * cell.a2[1], bD = pp.depth / 1000;
    const k2 = C[0][1] ** 2 / (C[0][0] * C[1][1]), kOut = pp.loadMode === 'manual' ? pp.kLoad * 1e3 : C[1][1] * Math.sqrt(Math.max(0, 1 - k2)) * Lx * bD / Ly, kp = kOut * Ly / (Lx * bD);
    const strain = (dd) => { const ex = -dd / Lx, ey = -C[0][1] * ex / (C[1][1] + kp); return { ex, ey, Fin: Math.abs(C[0][0] * ex + C[0][1] * ey) * Ly * bD, dout: Math.abs(ey) * Ly }; };
    Object.assign(out, { cellGeo: cell, C, Lx, Ly, strain, nx: pp.nx, ny: pp.ny, nu: C[0][1] / C[1][1] });
  } else {
    const g = { L: pp.armL / 1000, alpha: pp.alpha * Math.PI / 180, th: pp.hingeT / 1000, lh: pp.hingeL / 1000, ta: pp.armT / 1000, b: pp.depth / 1000, E };
    const free = bridgePRB(g), dFull = dPre + dIn, FinAt = (M, d) => (M.state(d + 1e-7).U - M.state(Math.max(0, d - 1e-7)).U) / (d > 1e-7 ? 2e-7 : 1e-7 + d);
    let kL = pp.loadMode === 'manual' ? pp.kLoad * 1e3 : 0;
    if (pp.loadMode !== 'manual') { let lo = 0, hi = 1e9; for (let it = 0; it < 60; it++) { const m = Math.sqrt(Math.max(lo, 1) * hi); if (FinAt(bridgePRB({ ...g, kL: m }), dFull) > pp.Fin) hi = m; else lo = m; } kL = lo; }
    const M = bridgePRB({ ...g, kL }), sFull = M.state(dFull), s0 = M.state(dPre);
    Object.assign(out, { g, M, kL, Fin: pp.Fin, A: (sFull.dout - s0.dout) / Math.max(dIn, 1e-12), sigMax: sFull.sig, FinAt: (d) => FinAt(M, d), free });
  }
  return out;
}

// ---------------- laboratory virtual run → rig series ----------------
export function labSeries(run) {
  const ds = run?.dataset || run?.ds || run, C = ds?.columns || {};
  const col = (...names) => { for (const n of names) if (C[n]?.length) return Array.from(C[n], Number); return null; };
  const t = col('t_s', 't', 'time_s');
  if (!t) return null;
  const T = col('T_spec_C', 'T_ribbon_C', 'T_C'), Tf = col('T_fluid_C'), F = col('F_N'), xmm = col('x_mm'), xi = col('xi'), Tw = col('T_wall_C'), phase = col('phase'), q = col('q_in_W');
  return { t, T, Tf, F, x: xmm ? xmm.map(v => v / 1000) : (col('x_m') || null), xi, Tw, phase, q, name: ds.name || 'virtual run', prov: ds.provenance || ds.kind || 'hypothetical', summary: ds.meta?.summary || {} };
}

export { interp1, getMat, componentMaterial };
