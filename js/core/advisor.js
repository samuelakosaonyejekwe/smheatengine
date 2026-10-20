// Decision-support advisor: merges suite-generated recommendations with live economic/sustainability
// context (grid carbon intensity, inflation, lending rates, FX) and fresh literature for best practice.
import { store } from './state.js';
import { siteContext, literature } from './live.js';
import { fmt } from './num.js';

let ctxCache = null, ctxT = 0;
export async function getSiteContext(force = false) {
  const s = store.project.site;
  if (!force && ctxCache && Date.now() - ctxT < 3600e3 && ctxCache.lat === s.lat && ctxCache.lon === s.lon) return ctxCache;
  const c = await siteContext(s.lat, s.lon); c.lat = s.lat; c.lon = s.lon; ctxCache = c; ctxT = Date.now(); return c;
}
export const cachedSiteContext = () => ctxCache;

// Generic sustainability/economics recommendations attached to every suite, conditioned on live context
export function contextRecs(suiteMeta, results, ctx) {
  const recs = [];
  if (!ctx) return recs;
  if (ctx.gridCarbon?.value) {
    const g = ctx.gridCarbon.value;
    recs.push({ level: 'sustain', text: `Fabrication electricity in ${ctx.country || 'this location'} emits ≈ ${fmt(g, 3)} gCO₂/kWh (${ctx.gridCarbon.year}). ${g > 400 ? 'Alloy melting (VIM/VAR), shape-setting furnaces, diffusion bonding and the hot-source heaters carry a high carbon penalty here: prefer recycled-feedstock NiTi, certified renewable power for furnace steps, and genuine waste heat rather than fired or electric heat for the hot circuit.' : 'A relatively clean grid favours local manufacture of energy-intensive parts (alloy melting, shape-setting, metal additive manufacturing); electric pumps and controls also carry a low carbon penalty.'} Any electricity the engine displaces is worth ≈ ${fmt(g, 3)} gCO₂ per kWh of net shaft work.`, basis: 'Our World in Data / Ember electricity carbon intensity (live)' });
  }
  if (ctx.inflation?.value !== undefined && suiteMeta.econ) {
    const inf = ctx.inflation.value; recs.push({ level: 'econ', text: `Consumer-price inflation is ${fmt(inf, 3)} % (${ctx.inflation.year}). ${inf > 10 ? 'Lock material prices with forward contracts and shorten procurement cycles; evaluate costs in real (inflation-adjusted) terms.' : 'Use a real discount rate (nominal minus inflation) when comparing life-cycle costs.'}`, basis: 'World Bank FP.CPI.TOTL.ZG (live)' });
  }
  if (ctx.lendingRate?.value !== undefined && suiteMeta.econ) recs.push({ level: 'econ', text: `Commercial lending rate ≈ ${fmt(ctx.lendingRate.value, 3)} % (${ctx.lendingRate.year}); use it as the upper bound of the nominal discount rate for prototype financing.`, basis: 'World Bank FR.INR.LEND (live)' });
  if (ctx.renewShare?.value !== undefined && suiteMeta.sustain) recs.push({ level: 'sustain', text: `Renewables generate ${fmt(ctx.renewShare.value, 3)} % of electricity here (${ctx.renewShare.year}); include this in the life-cycle inventory of in-country manufacturing and maintenance.`, basis: 'World Bank EG.ELC.RNEW.ZS (live)' });
  return recs;
}

// Literature-backed "fresh best practice" pointers for a suite
export async function bestPractice(suiteMeta, n = 6) {
  if (!suiteMeta.literature) return { items: [], meta: null };
  try { const r = await literature(suiteMeta.literature, { perPage: n }); return { items: r.items, meta: r.meta }; } catch (e) { return { items: [], error: e.message }; }
}

// Universal guard-rail recommendations from verdicts (failures must be explained, never hidden)
export function verdictRecs(verdicts = []) {
  return verdicts.filter(v => (v.status || (v.pass ? 'pass' : 'fail')) === 'fail').map(v => ({ level: 'critical', text: `Failed: ${v.test}. ${v.fix || 'Revise the design variables that drive this check (see the sensitivity tab) before relying on this configuration.'}`, basis: v.detail }));
}

// Design-state recommendations shared across suites (never change the design by themselves)
export function designRecs(def) {
  const recs = [], s18 = store.output?.('s18'), s16 = store.output?.('s16');
  if (s18 && s18.Pnet_W !== undefined && s18.Pnet_W <= 0 && ['s01', 's05', 's08', 's09', 's13', 's17', 's22'].includes(def?.id)) recs.push({ level: 'warn', text: `The latest whole-engine accounting (Suite 18) gives net shaft power ${fmt(s18.Pnet_W, 3)} W: auxiliaries exceed converted work. Reduce pumping (wider channels, larger fluid ΔT), wall thermal mass and switching losses before scaling cell count.`, basis: 'Suite 18 net power accounting' });
  if (s16?.life_cycles && s16.life_cycles < 1e6 && ['s05', 's17', 's22'].includes(def?.id)) recs.push({ level: 'warn', text: `Predicted ribbon life ${fmt(s16.life_cycles, 3)} cycles (Suite 16) is short of continuous-duty needs: lower the transformation strain or stress differential, or select a low-fatigue alloy.`, basis: 'Suite 16 fatigue prediction' });
  return recs;
}
