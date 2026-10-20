// Core regression tests against published reference values. Run: node tools/tests.mjs
import * as N from '../js/core/num.js';
import * as H from '../js/core/heat.js';
import * as SMA from '../js/core/sma.js';
import * as E from '../js/core/engine.js';
import { get as getMat, MATERIALS } from '../js/core/materials.js';
import * as A from '../js/core/analysis.js';
import { box, cylinder, toSTL, toSTEP } from '../js/core/cad.js';
import { parseDelimited, parseSTL, zip } from '../js/core/io.js';

let pass = 0, fail = 0; const out = [];
const t = (name, got, want, tol, rel = true) => { const ok = Number.isFinite(got) && Math.abs(got - want) <= (rel ? tol * Math.abs(want || 1) : tol); ok ? pass++ : fail++; if (!ok) out.push(`FAIL ${name}: got ${got}, want ${want} ±${tol}${rel ? ' (rel)' : ''}`); };
const ok = (name, cond, info = '') => { cond ? pass++ : fail++; if (!cond) out.push(`FAIL ${name} ${info}`); };

// numerics
t('brent root cos', N.brent(Math.cos, 1, 2).x, Math.PI / 2, 1e-10);
const ode = N.rk45((tt, y) => [-y[0]], 0, [1], 5, { rtol: 1e-9, atol: 1e-12 }); t('rk45 exp(-5)', ode.y[ode.y.length - 1][0], Math.exp(-5), 1e-6);
const eg = N.eigSym([[2, 1], [1, 2]]); t('eigSym λ1', eg.values[0], 1, 1e-10); t('eigSym λ2', eg.values[1], 3, 1e-10);
const egg = N.eigGeneral([[0, 1], [-4, 0]]); t('eigGeneral |imag| = 2', Math.abs(egg[0].im), 2, 1e-8);
t('luSolve', N.luSolve([[4, 1], [2, 3]], [1, 2])[1], 0.6, 1e-12);
const sb = new N.SparseBuilder(3); [[0, 0, 4], [0, 1, 1], [1, 0, 1], [1, 1, 3], [1, 2, 1], [2, 1, 1], [2, 2, 2]].forEach(([i, j, v]) => sb.add(i, j, v)); const cg = N.pcg(sb.toCSR(), [1, 2, 3]); const ref = N.luSolve([[4, 1, 0], [1, 3, 1], [0, 1, 2]], [1, 2, 3]); t('pcg vs direct', cg.x[2], ref[2], 1e-8);
t('trapz x² 0..1', N.trapz(N.linspace(0, 1, 2001).map(x => x * x), N.linspace(0, 1, 2001)), 1 / 3, 1e-6);
const lm = N.levenbergMarquardt((x, p) => p[0] * Math.exp(-p[1] * x), N.linspace(0, 4, 40), N.linspace(0, 4, 40).map(x => 3 * Math.exp(-0.7 * x)), [1, 1]); t('LM fit a', lm.p[0], 3, 1e-6); t('LM fit k', lm.p[1], 0.7, 1e-6);
// GCI (Celik et al. 2008 worked example: φ1 = 6.063, φ2 = 5.972, φ3 = 5.863, r21 = 1.5, r32 = 1.333) → p = 1.53, GCI21 = 2.17 %
const g = N.gci(6.063, 5.972, 5.863, 1, 1.5, 2.0); t('GCI observed order (Celik 1.53)', g.p, 1.53, 0.02); t('GCI fine % (Celik 2.17)', g.gci21 * 100, 2.17, 0.02); t('GCI extrapolated (Celik 6.1685)', g.fext, 6.1685, 1e-4);
ok('range(a,b)', JSON.stringify(N.range(2, 5)) === '[2,3,4]'); ok('range(n)', JSON.stringify(N.range(3)) === '[0,1,2]');
t('normInv(0.975)', N.normInv(0.975), 1.95996, 1e-4); t('normCdf(1.96)', N.normCdf(1.96), 0.975, 1e-3);
// sensitivity (Ishigami: S1 ≈ 0.314, 0.442, 0; ST3 ≈ 0.244)
const ish = (x) => Math.sin(x[0]) + 7 * Math.sin(x[1]) ** 2 + 0.1 * x[2] ** 4 * Math.sin(x[0]);
const so = A.sobol(ish, [[-Math.PI, Math.PI], [-Math.PI, Math.PI], [-Math.PI, Math.PI]], { N: 4096 }); t('Sobol S1 x1', so.S1[0], 0.314, 0.06, false); t('Sobol S1 x2', so.S1[1], 0.442, 0.06, false); t('Sobol ST x3', so.ST[2], 0.244, 0.06, false);
const fr = A.form((x) => 10 - x[0] - x[1], [{ mu: 2, sigma: 1 }, { mu: 3, sigma: 1 }]); t('FORM β linear', fr.beta, 5 / Math.SQRT2, 1e-4);
// geometry & exporters
const bx = box('b', 1, 2, 3); t('box volume', bx.volume(), 6, 1e-9); ok('box closed & oriented', bx.checkManifold().closed && bx.checkManifold().oriented);
const cy = cylinder('c', 0.5, 2, 256); t('cylinder volume', cy.volume(), Math.PI * 0.25 * 2, 2e-3);
const stl = new Uint8Array(await toSTL([bx]).arrayBuffer()); const back = parseSTL(stl.buffer); ok('STL round-trip triangles', back.triangles === bx.triangleCount, `${back.triangles} vs ${bx.triangleCount}`);
const step = toSTEP([bx]); ok('STEP header & closed shell', step.startsWith('ISO-10303-21;') && step.includes('CLOSED_SHELL') && step.trim().endsWith('END-ISO-10303-21;'));
const { to3MF, toIGES } = await import('../js/core/export2.js');
const igs = (await toIGES([bx]).text()).trim().split('\n'); ok('IGES fixed 80-column records', igs.every(l => l.length === 80) && igs[igs.length - 1].includes('T      1'));
const m3 = new Uint8Array(await (await to3MF([bx])).arrayBuffer()); ok('3MF package is a ZIP', m3[0] === 0x50 && m3[1] === 0x4b);
// importers
const tb = parseDelimited('time,temperature [°C],wind\n1,20,3\n2,21,4\n'); ok('CSV parse', tb.nRows === 2 && tb.units['temperature [°C]'] === '°C');
const tb2 = parseDelimited('a;b\n1,5;2\n'); ok('semicolon CSV', tb2.header.length === 2);
const z = await zip([{ name: 'a.txt', data: 'hello' }]); ok('zip has end-of-central-directory', new Uint8Array(await z.arrayBuffer()).slice(-22)[0] === 0x50);

// ---------- THERMA-X100 physics cores ----------
// fluid properties (IAPWS-95 reference: water at 20 °C ρ 998.2, cp 4184, k 0.598, μ 1.002e-3)
const w20 = H.fluid('fl-water', 20); t('water ρ(20 °C)', w20.rho, 998.2, 2e-3); t('water cp(20 °C)', w20.cp, 4184, 5e-3); t('water k(20 °C)', w20.k, 0.598, 1e-2); t('water μ(20 °C)', w20.mu, 1.002e-3, 2e-2);
// Shah & London square duct: fRe = 56.91, Nu_T = 2.98
const sq = H.rectDuct(1e-3, 1e-3); t('square duct fRe', sq.fRe, 56.91, 2e-3); t('square duct NuT', sq.NuT, 2.98, 1e-2);
// ε-NTU limits
t('ε counterflow Cr=1 NTU=1', H.effectivenessNTU(1, 1), 0.5, 1e-9); t('ε Cr=0', H.effectivenessNTU(2, 0), 1 - Math.exp(-2), 1e-12); t('NTU inverse', H.effectivenessNTU(H.ntuFromEffectiveness(0.7, 0.5), 0.5), 0.7, 1e-8);
// transient slab vs analytic eigen-series
for (const tt of [0.001, 0.005]) { const fd = H.slab1D({ Lh: 5e-5, n: 41, k: 18, rho: 6450, cp: 490, h: 20000, Tinf: 70, T0: 15, tEnd: tt, dt: tt / 400 }); t(`slab CN vs analytic t=${tt}`, fd.Tc.at(-1), H.slabAnalytic({ Lh: 5e-5, k: 18, rho: 6450, cp: 490, h: 20000, Tinf: 70, T0: 15, t: tt }), 1e-4); }
// regenerator energy balance
const rg = H.regeneratorFD({ maxCycles: 200 }); ok('regenerator energy balance < 1e-3', Math.abs(rg.balance) < 1e-3, rg.balance); ok('regenerator ε ≤ ε-NTU bound', rg.eps <= H.effectivenessNTU(rg.NTU0, 1) + 1e-9, rg.eps);
t('wet bulb 20 °C/50 % (Stull)', H.wetBulb(20, 50), 13.7, 0.1, false);
// SMA constitutive: zero-stress transformation, Clausius–Clapeyron shift, isobaric work loop
const nit = getMat('niti-lt'), m0 = new SMA.SMA(nit); m0.xi = 1; m0.xis = 0;
m0.update(nit.As - 0.5, 0); ok('no reverse transformation below As', m0.xi === 1); m0.update(nit.Af + 0.5, 0); ok('complete reverse transformation above Af', m0.xi === 0);
t('As shift with stress = σ/CA', new SMA.SMA(nit).temps(150).As - nit.As, 150 / nit.CA, 1e-12);
const qs = SMA.quasiStaticCycle(nit, { Th: 70, Tc: 15, sH: 110, sL: 70 }); ok('isobaric loop: positive net work', qs.w_J_kg > 0, qs.w_J_kg); ok('isobaric loop closes', qs.closure < 1e-9, qs.closure);
const cell = SMA.cellTransient({ mat: nit, t: 100e-6, w: 5e-3, L: 0.1, nRib: 10, n: 3, Th: 70, Tc: 15, hHot: 4000, hCold: 4000, hc: 20000, Cw: 200, period: 2, dutyHot: 0.5, tSwitch: 0.02, sBias0: 70, kBias: 0, sLoad: 40, cycles: 4, stepsPerCycle: 200 });
ok('cell transient: first-law residual < 1e-6', Math.abs(cell.energyResidual) < 1e-6, cell.energyResidual); ok('cell transient: η < η_Carnot', cell.eta < cell.etaCarnot, cell.eta); ok('cell transient: positive net work', cell.Wout > 0, cell.Wout);
// engine model & pre-screen rules (spec §2)
const em = E.engineModel(E.DEFAULT_ENGINE, { n: 1, stepsPerCycle: 120, cycles: 3 }); ok('engine: net ≤ gross', em.Pnet < em.Pgross); ok('engine: η ≤ Carnot', em.eta <= em.etaC); ok('engine: three mass bases ordered', em.mActive < em.mCart && em.mCart < em.mSys);
ok('pre-screen rejects ambient-only operation', E.preScreen({ ...E.DEFAULT_ENGINE, Th: 25, Tc: 25 }).some(f => f.status === 'fail'));
ok('pre-screen rejects As(σH) above the hot source', E.preScreen({ ...E.DEFAULT_ENGINE, sigmaH: 300 }).some(f => f.status === 'fail'));
ok('materials: every record has a source and uncertainty', MATERIALS.every(m => m.src && Number.isFinite(m.unc)));

console.log(out.join('\n')); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
