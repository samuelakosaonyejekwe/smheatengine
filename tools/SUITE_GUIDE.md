# THERMA-X100 suite development guide (internal)

THERMA-X100 is an installable, offline-first engineering platform for a regenerative multicell shape-memory heat
engine. Source documents: the THERMA-X100 master project specification, the EIGDAS input-generation architecture and the
principle-of-operation description (kept with the project owner). Every suite implements one of the 22 modules of master spec §25 with the inputs/outputs,
models, verification and evidence listed there, plus the supply/generation register of the EIGDAS document.

## Module file contract
Each suite is an ES module `js/suites/sNN-name.js` exporting a default object. The registry (`js/suites/index.js`)
supplies `id, num, title, short, group, icon`; the module supplies the rest.

```js
export default {
  description,                 // 1–3 sentences, what the suite answers
  literature,                  // OpenAlex query string for live best practice (e.g. 'shape memory alloy fatigue actuator')
  econ?: true, sustain?: true, // turn on live economics / sustainability advice where relevant
  credibility,                 // default credibility label (see state.js CREDIBILITY)
  equations: [...],            // governing equations as readable unicode strings, each with its meaning
  methods: [...],              // numerical implementation actually used in run()
  assumptions: [...],          // assumptions & validity limits
  ibc: { initial: [...], boundary: [...] },
  cvv: { calibration: [...], verification: [...], validation: [...] },
  formats: { import: [...], export: [...] },
  params: [{ key, label, unit, type: 'number'|'range'|'select'|'bool'|'text', min, max, step, options, default,
             group, help, expert?, auto?: (ctx) => value | {value, prov} }],
  presets?: [{ label, values: {...} }],
  async run(p, ctx) { return results; },
};
```
`options` for select: array of strings or `{value,label}`. `prov` values: user, measured, certified, library,
imported, calc, generated, estimated, calibrated, hypothetical, unsupported, live, coupled (state.js PROVENANCE).
`auto` must return a value derived from upstream outputs (`ctx.upstream('s05')?.key`, prov `coupled`), from the
shared engine design (`ctx.engine.key`, prov `calc`), or from the materials library (prov `library`). Return
`undefined` to fall back to `default`. Mark solver/mesh/tolerance controls `expert: true`.

### ctx
`store, num, physics, analysis, live, materials, sma, heat, eng, def, engine (merged design, see engine.js
DEFAULT_ENGINE), site {lat,lon,name}, env, upstream(id), upstreamMeta(id), material(componentKey),
progress(frac,msg), experiments (imported datasets for this suite: [{name, header, columns{col:[]}, use}]), yield()`.
Long loops: `await ctx.yield()` every ~50 ms of work and `ctx.progress(f, 'msg')`.

### Results object (all optional, but a complete suite returns most of them)
`headline`, `headlineKind` ('ok'|'warn'|'fail'|'info'),
`kpis[{label,value,unit,explain,prov,status:'ok'|'warn'|'bad'}]` — EVERY kpi has a plain-language `explain`,
`verdicts[{test,status:'pass'|'fail'|'warn'|'info',detail,fix}]` — failures shown with cause and fix, never hidden,
`charts[chartSpec]` — EVERY chart has `explain` ("what this shows / how to read it"),
`tables[{title,cols,rows,explain}]`, `views[{label,icon,render(el,ctx)}]` (animations / 3-D),
`explain[string|{title,text}]` — narrative explanation of the run,
`recs[{level:'critical'|'warn'|'info'|'good'|'sustain'|'econ',text,basis}]` — engineering, economics and
sustainability recommendations derived from THIS run's numbers (cite the numbers),
`checks[{name,value,target,pass,detail}]` — verification (conservation, convergence, analytic limits, bounds),
`convergence{title,series}`, `exports[{label,action}]`, `outputs{...}` (coupling keys below), `credibility`.

### Chart specs (`js/core/chart.js`)
`line|scatter|area|stack` (`title, x:{label,unit,log?}, y:{label,unit,log?}, series[{name,x,y,dash,mode:'markers'|'lines',band}]`,
`annotations[{type:'hline'|'vline'|'band'|'xband'|'point', y|x|...,label,color}]`), `bar` (`categories, series[{name,values}], horizontal`),
`tornado` (`rows[{label,lo,hi}], base`), `heatmap` (`x:{label,values}, y:{label,values}, z[j][i], cmap, isolines, vectors, equal, zlabel`) for
contours/fields, `polar`, `gauge` (`value,max,unit,caption`). Add `wide: true` for full-width plots.
Animations: `js/core/anim2d.js` `anim2d(el, {duration, label, unit, height, draw(g, t, W, H), explain})` with helpers
`seriesPanel, bar, gauge, arrow, text, at, lerp, theme`. 3-D: `js/core/viz3d.js` `viewer(container, …)` + `js/core/cad.js` `Mesh`, `box`,
`cylinder`, `tube`, `torus`, `sphere`, exporters `toSTL/toOBJ/toPLY/toSTEP/toVTKPoly`, `engineeringDrawing`.
`download(blob, name)` from chart.js; `zip(files)` from io.js.

## Shared physics cores (use them — do not duplicate)
- `engine.js`: `DEFAULT_ENGINE`, `designWith(base, over)`, `preScreen(design)` (pre-run feasibility flags),
  `engineModel(design, {mat, cell, n, stepsPerCycle, cycles})` → `{cell, Pgross, Pshaft, Ppump, Pvalves, Paux, Pnet,
  QhotTot, QrejTot, eta, etaC, carnotFraction, exergyIn, exergyEff, mActive, mCart, mSys, pActive, pCart, pSys,
  refRatio, cellsForTarget, mdotH, mdotC, hydH, hydC, hHotUsed, hColdUsed, torqueMean, omega, netPositive, meetsTarget}`,
  `hydraulics(d, cell, N, f)`, `REFERENCE_W_PER_KG` (36), `STRETCH_W_PER_KG`, `MILESTONES`.
- `sma.js`: `SMA` class (Brinson-type, `update(T,σ)`, `strain`, `temps(σ)`, `E()`, `prepare(Tc,σ)`), `kinStep`,
  `phaseDiagram(mat,sMax)`, `quasiStaticCycle(mat,{Th,Tc,sH,sL,kinetics})`, `tensileTest(mat,{T,sMax})`,
  `dscSim(mat,{rate,mass})` (model output, label as simulated — never as measurement), `fatigueLife(mat, eps, sigma)`,
  `cellTransient({...})` (ribbon cell: FV conduction + wall + switching fluid + kinetics + bias + one-way clutch; returns
  `hist{t,Tf,Tw,Ts,Tc,Tm,xi,xis,eps,sExt,F,x,engaged,Pmech,qIn}`, `Wout, Wcontraction, Wreset, Qhot, Qcold, stroke, Pout,
  specificWork, specificPower, eta, etaCarnot, carnotFraction, xiSwing, energyResidual, periodicity, cycles[]`),
  `cellFromDesign(mat, design, over)`. Typical cost 50–300 ms per call; keep sweeps ≤ ~30 calls (use `n:1–3`, `stepsPerCycle:120–200`).
- `heat.js`: `fluid(id,T)` (fl-water, fl-eg50, fl-pg30, fl-oil, fl-air), `fluidOptions`, `rectDuct`, `darcy`, `ductHTC({...})`,
  `pumpPower`, `effectivenessNTU`, `ntuFromEffectiveness`, `hxRate`, `regeneratorFD`, `slab1D`, `slabAnalytic`,
  `ribbonTimescales`, `contactConductance`, `seriesR`, `finEfficiency`, `wetBulb`, `streamExergy`, `carnot`,
  `curzonAhlborn`, `entropicMean`, `KELVIN`.
- `materials.js`: `MATERIALS`, `get(id)`, `smaAlloys()`, `forUse(use)`, `COMPONENTS`, `componentMaterial(store,key)`, `indices`.
  SMA fields: Ms Mf As Af CM CA sigS sigF epsL Lh EA EM k kM cp rho alpha su fatigue{N0,eps0,a,sig0,b} cost co2 unc evidence src.
- `num.js`: linspace, range, trapz, cumtrapz, interp1, brent(f,a,b).x, newton, rk4, rk45, luSolve, eigSym, SparseBuilder/pcg,
  thomas, nelderMead, levenbergMarquardt(model, xs, ys, p0) → {p, cov?…}, polyfit, rng, lhs, halton, normInv, percentile,
  histogram, metrics, gci(f1,f2,f3,h1,h2,h3) → {p, fext, gci21, gci32, asymptoticRatio, inAsymptoticRange}, fmt.
- `analysis.js`: tornado, morris, sobol, propagate (Monte-Carlo/LHS), diffEvolution, nsga2, hypervolume2, form, monteCarloPf, gpFit, sweep.
- `fem.js`: beamModel/beamStatic/beamModes, frameK, planeStress (CST), structuredMesh, meshQuality, bistableBeam, homogenize.
- `meshlab.js` (owned by the CAD/meshing builder): 2-D mesh generation (structured & Delaunay) for ribbon/wall/channel
  cross-sections, quality metrics, P1 FEM conduction (steady & transient, Robin BCs), mesh-sensitivity study with GCI and
  automatic mesh selection, exporters (Gmsh MSH 2.2, VTK, CSV). API documented at the top of that file.

## Coupling contract (outputs published by each suite)
| Suite | Output keys (SI unless stated) |
|---|---|
| s01 | design{...engine}, Pnet_W, Qhot_W, etaC, eta, mActive_kg, mCart_kg, mSys_kg, pActive_Wkg, cellsForTarget, architecture, massBudget{}, requirements[] |
| s02 | ribbonVolume_m3, ribbonMass_kg, cartridgeMass_kg, rotorInertia_kgm2, engineMass_kg, envelope{D,L}, mesh{nodes,elements,minQuality,hRep}, gci, selectedLevel |
| s03 | alloyId, card{Ms,Mf,As,Af,CM,CA,sigS,sigF,epsL,Lh,EA,EM,rho,cp,k}, uncertainty{}, applicability{Tmin,Tmax,sMax} |
| s04 | xiHistory, wLoop_J_kg, dissipated_J_m3, temps{H,L}, kinetics, stroke |
| s05 | Wout_J, Wcontraction_J, Wreset_J, Qhot_J, stroke_m, Fmax_N, Fmean_N, cellMass_kg, specificPower_Wkg, eta, forceHistory{t,F,x}, freq_Hz, cycleTime_s |
| s06 | Qavail_W, ThIn_C, ThSupply_C, mdotHot_kgs, dpHot_Pa, exergy_W, sourceType |
| s07 | Qrej_W, TcSupply_C, TminRibbon_C, Psink_W, ambient_C, wetBulb_C, sinkType |
| s08 | hHot_Wm2K, hCold_Wm2K, tHeat_s, tCool_s, maxFreq_Hz, Rth_m2KW, dTmax_K, hContact_Wm2K, Bi |
| s09 | regenEff, Qrecovered_W, pinch_K, dpRegen_Pa, Ppump_regen_W, netBenefit_W |
| s10 | amplification, transEff, kEff_Nm, Wloss_J, bucklingLoad_N, hotspot_MPa |
| s11 | transEff, torqueMean_Nm, torqueRipple, Pshaft_W, Ploss_W, J_kgm2, omega_rads, startTorque_Nm |
| s12 | nCells, offsets[], torqueRipple, meanTorque_Nm, firingOrder[], dutyHot |
| s13 | Ppump_W, dpTotal_Pa, maldistribution, valveLatency_s, leakage_W |
| s14 | converged, iterations, Wout_J, Qhot_J, energyResidual, couplingResidual, hHot, freq_Hz |
| s15 | selfStart, startTorque_Nm, tStart_s, stallLoad_Nm, safeStop_s, restartOK |
| s16 | life_cycles, life_P10, life_P90, damagePerCycle, inspectInterval_cycles, criticalLocation |
| s17 | pareto[], best{}, sobol{}, uncertainty{Pnet:{p5,p50,p95}} |
| s18 | Pnet_W, Pgross_W, Paux_W, Qhot_W, eta, etaC, carnotFraction, exergyDestroyed_W, residual |
| s19 | calibrated{...}, datasets, rmse, bias, confidence{} |
| s20 | partCount, buildHours, toleranceStack_mm, Cpk, yield, unitCost_USD |
| s21 | envelope{}, topRisks[], sil, mtbf_h, trips[] |
| s22 | capex_USD, opex_USDyr, lcoe_USDkWh, payback_yr, npv_USD, co2_kg, co2Payback_yr |
Downstream suites must work when an upstream output is absent (fall back to `ctx.engine`/library defaults with provenance
`estimated`) and label coupled values with provenance `coupled`.

## Scientific rules (binding — master spec §2, EIGDAS §6)
- Carnot is an upper bound; never report η > η_Carnot; flag and explain any such numerical artefact.
- Net = gross − reset − losses − all auxiliaries; never present positive-stroke gross work as net output.
- Phase timing, gearing, flywheels and metamaterials redistribute force/torque/energy; they never create energy.
- Never fabricate measurements: synthetic data must be labelled "simulated/synthetic"; library values are "library",
  not "certified". Missing measurements are requested explicitly (verdict 'info' with what to measure).
- Report active-material, cartridge and system specific power separately; never mix mass bases.
- Infeasible inputs are reported as infeasible with cause and fix, never silently solved.
- Every KPI, chart and table has an explanation; every run gives recommendations (engineering, economics,
  sustainability) grounded in the computed numbers.
- No commercial simulation-software names. Do not write TODO/placeholder text.

## Style & quality
- Match the dense style of the existing cores (2-space indent, single quotes, semicolons, concise helpers).
- Typical run must finish in < 2 s on a laptop (budget sweeps accordingly; expose resolution as expert params).
- Verify headless: `node tools/smoke.mjs sNN` runs a suite with automatic inputs and prints KPIs/verdicts/checks; it must not throw,
  produce NaN KPIs (unless intentionally reported), or fail its own verification checks without explanation.
