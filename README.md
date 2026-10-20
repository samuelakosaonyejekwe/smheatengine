# THERMA-X100

**Regenerative, high-performance shape-memory thermal engine — integrated engineering and experimental research platform**

THERMA-X100 is an installable, offline-capable web application for designing, simulating, testing and assessing a
regenerative multicell shape-memory-alloy (SMA) heat engine: heat → crystalline phase transformation → contraction →
force → shaft torque → cooling and reset → repetition. It contains 22 coupled engineering suites, an Experimental
Science & Discovery Laboratory, a central input-generation and data-acquisition system (EIGDAS), a materials library
and live connections to public global data services.

**Live app:** https://samuelakosaonyejekwe.github.io/smheatengine/

## The 22 suites
| # | Suite | # | Suite |
|---|---|---|---|
| 01 | Engine architecture & system requirements | 12 | Multicell phase timing & load scheduling |
| 02 | 2-D/3-D parametric CAD & computational meshing | 13 | Hydraulic distribution, valves & fluid auxiliaries |
| 03 | Materials library & alloy characterization | 14 | Integrated thermal-fluid-structural co-simulation |
| 04 | Phase transformation & SMA microstructure | 15 | Start-up, shutdown & off-design dynamics |
| 05 | SMA ribbon & thermal-muscle cartridge | 16 | Structural integrity, creep, fatigue & failure |
| 06 | Hot-source conditioning & thermal supply | 17 | Optimisation, inverse design & uncertainty |
| 07 | Cold sink & heat rejection | 18 | Thermodynamic accounting, efficiency & exergy |
| 08 | Microchannels, contacts & transient heat transfer | 19 | Experimental management, calibration & digital twin |
| 09 | Regenerator & thermal storage | 20 | Manufacturing, metrology & assembly |
| 10 | Mechanical metamaterial & compliant transmission | 21 | Safety, reliability & operational control |
| 11 | Shaft coupling & torque transmission | 22 | Techno-economics, scalability & lifecycle |

Every suite offers **Automatic, Guided, Expert and Experimental-import** input modes, provenance on every value
(measured, certified, library, imported, calculated, generated, estimated, coupled, live …), governing equations,
initial and boundary conditions, calibration / verification / validation plans, plots and contours with explanations,
verdicts that show failures with their causes and fixes, numerical verification checks, and engineering, economic
and sustainability recommendations grounded in the computed numbers.

## Physics cores
- **SMA constitutive model** — Brinson-type law with stress-dependent transformation temperatures (Clausius–Clapeyron),
  cosine or exponential kinetics, detwinning, latent heat; ribbon-cell transient with finite-volume conduction, wall
  capacity, switching hot/cold fluid, bias spring and one-way clutch; first-law residual ≈ 1e-11 per cycle.
- **Thermal-fluid core** — temperature-dependent fluid properties, Shah & London laminar duct correlations, developing
  and turbulent flow, ε-NTU / LMTD, periodic regenerator model, Crank–Nicolson slab conduction verified against the
  analytic eigen-series, contact conductance, wet-bulb and stream exergy.
- **Whole-engine model** — net power = gross work × frequency × transmission efficiency − pumping − valves − control;
  efficiency bounded by Carnot; specific power on active-SMA, cartridge and system mass bases kept separate.
- **Meshing & FEM** — 2-D structured and Delaunay meshing, quality metrics, P1 conduction FEM, mesh-sensitivity studies
  with Richardson extrapolation and GCI, automatic mesh selection; exports MSH, VTK, CSV.
- Numerical library: ODE solvers, sparse PCG, Levenberg–Marquardt, Sobol/Morris sensitivity, NSGA-II, Gaussian
  processes, Monte-Carlo and FORM reliability.

## Live global data (fetched by each user's device — no server)
Open-Meteo forecast / ERA5 reanalysis / geocoding / elevation, NASA POWER climatology, OpenStreetMap Nominatim,
OpenAlex, Crossref and Europe PMC (literature and patents), World Bank indicators, Frankfurter (ECB reference rates),
Our World in Data electricity carbon intensity, UK grid carbon, IMF primary-commodity prices via DBnomics (nickel,
copper, aluminium, gas), PubChem and Wikidata. Responses are timestamped, cached on the device and re-used offline;
installed copies refresh recently used data in the background where the browser supports periodic sync.

## Installation, offline use and redundancy
- Open the live app and press **⤓ Install app** (or the browser's *Install app* / *Share → Add to Home Screen*). Works on
  Windows, macOS, Linux, ChromeOS, Android and iOS/iPadOS. After the first visit everything runs offline, including in
  airplane mode.
- The application is a static, server-less build. Installed copies keep working when every host is unavailable.
- The *Install* page offers a self-hostable **offline copy (ZIP)** of the whole application.
- Ready-made mirror configurations for other static hosts are included (`netlify.toml`, `vercel.json`, `_headers`,
  `.gitlab-ci.yml`).

## Local development
```
node tools/build.mjs      # regenerate the service-worker precache manifest
node tools/tests.mjs      # physics and numerics regression tests
node tools/smoke.mjs      # headless run of all 22 suites with automatic inputs
# serve the folder with any static file server and open it in a browser
```
No other build step or dependency is required. Vendored 3-D and spreadsheet libraries are in `vendor/` with their licences.

## Scientific rules
The engine needs a hot source and a colder sink; Carnot efficiency is an upper bound; reset work, losses and every
auxiliary load are subtracted from net output; phasing, gearing, flywheels and metamaterials never create energy; mass
bases are never mixed; simulated values are never presented as measurements; infeasible cases are reported, not solved.
Predictions from this software are not physical validation — see the validation ladder V0–V6 in the Laboratory.
