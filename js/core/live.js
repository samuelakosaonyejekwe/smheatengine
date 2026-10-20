// Live global data connectors. Every request is made directly from the user's browser to the public
// data service (no intermediate server), cached in IndexedDB with timestamps, and labelled with its
// data kind (observation / forecast / reanalysis / climatology / literature / economic / calculated).

const DB = 'therma-live', STORE = 'cache';
let dbp = null;
function idb() {
  if (dbp) return dbp;
  dbp = new Promise((res) => { try { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); } });
  return dbp;
}
async function cget(k) { const db = await idb(); if (!db) return null; return new Promise(r => { try { const q = db.transaction(STORE).objectStore(STORE).get(k); q.onsuccess = () => r(q.result || null); q.onerror = () => r(null); } catch { r(null); } }); }
async function cset(k, v) { const db = await idb(); if (!db) return; try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(v, k); } catch { /* quota */ } }
export async function cacheKeys() { const db = await idb(); if (!db) return []; return new Promise(r => { const q = db.transaction(STORE).objectStore(STORE).getAllKeys(); q.onsuccess = () => r(q.result); q.onerror = () => r([]); }); }
export async function clearCache() { const db = await idb(); if (db) db.transaction(STORE, 'readwrite').objectStore(STORE).clear(); }

export const SOURCES = {
  'open-meteo-forecast': { name: 'Open-Meteo Forecast API (ECMWF, DWD ICON, NOAA GFS, Météo-France blends)', kind: 'forecast', ttl: 30, home: 'https://open-meteo.com/' },
  'open-meteo-archive': { name: 'Open-Meteo Historical API (ERA5 / ERA5-Land reanalysis, Copernicus)', kind: 'reanalysis', ttl: 1440, home: 'https://open-meteo.com/en/docs/historical-weather-api' },
  'open-meteo-geocoding': { name: 'Open-Meteo Geocoding (GeoNames)', kind: 'reference', ttl: 43200, home: 'https://open-meteo.com/en/docs/geocoding-api' },
  'open-meteo-elevation': { name: 'Open-Meteo Elevation (Copernicus DEM GLO-90)', kind: 'reference', ttl: 43200, home: 'https://open-meteo.com/en/docs/elevation-api' },
  'nasa-power': { name: 'NASA POWER (CERES / MERRA-2 solar & meteorology climatology)', kind: 'climatology', ttl: 10080, home: 'https://power.larc.nasa.gov/' },
  'nominatim': { name: 'OpenStreetMap Nominatim reverse geocoding', kind: 'reference', ttl: 43200, home: 'https://nominatim.org/' },
  'openalex': { name: 'OpenAlex scholarly works index (≈250 M papers, patents linked)', kind: 'literature', ttl: 1440, home: 'https://openalex.org/' },
  'crossref': { name: 'Crossref DOI metadata registry', kind: 'literature', ttl: 1440, home: 'https://www.crossref.org/' },
  'europepmc': { name: 'Europe PMC literature (incl. patents & preprints)', kind: 'literature', ttl: 1440, home: 'https://europepmc.org/' },
  'worldbank': { name: 'World Bank Open Data indicators', kind: 'economic', ttl: 10080, home: 'https://data.worldbank.org/' },
  'frankfurter': { name: 'Frankfurter FX (European Central Bank reference rates)', kind: 'economic', ttl: 360, home: 'https://frankfurter.dev/' },
  'ecb': { name: 'European Central Bank Data Portal', kind: 'economic', ttl: 720, home: 'https://data.ecb.europa.eu/' },
  'owid-carbon': { name: 'Our World in Data — electricity carbon intensity (Ember / Energy Institute)', kind: 'economic', ttl: 10080, home: 'https://ourworldindata.org/grapher/carbon-intensity-electricity' },
  'uk-carbon': { name: 'UK National Grid ESO Carbon Intensity API', kind: 'observation', ttl: 30, home: 'https://carbonintensity.org.uk/' },
  'dbnomics-imf': { name: 'IMF Primary Commodity Prices via DBnomics (nickel, copper, aluminium, natural gas, coal)', kind: 'economic', ttl: 1440, home: 'https://db.nomics.world/IMF/PCPS' },
  'pubchem': { name: 'PubChem (NIH) compound properties', kind: 'reference', ttl: 43200, home: 'https://pubchem.ncbi.nlm.nih.gov/' },
  'wikidata': { name: 'Wikidata structured knowledge base', kind: 'reference', ttl: 43200, home: 'https://www.wikidata.org/' },
};
export const status = {}; // sourceId -> {ok, t, ms, cached, error}
const listeners = new Set();
export const onStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// Core fetch with timeout, cache, offline fallback and provenance metadata
export async function fetchJSON(sourceId, url, { ttlMin, force = false, text = false, timeout = 15000 } = {}) {
  const src = SOURCES[sourceId] || { kind: 'reference', ttl: 60 }, ttl = (ttlMin ?? src.ttl) * 60000, key = url;
  const cached = await cget(key);
  if (!force && cached && Date.now() - cached.t < ttl) { mark(sourceId, { ok: true, cached: true, t: cached.t }); return wrap(cached.data, sourceId, url, cached.t, true); }
  const t0 = performance.now();
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('offline');
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), timeout);
    const r = await fetch(url, { signal: ctl.signal, headers: text ? {} : { Accept: 'application/json' } }); clearTimeout(to);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = text ? await r.text() : await r.json();
    const t = Date.now(); cset(key, { t, data }); remember(url, text); mark(sourceId, { ok: true, cached: false, t, ms: Math.round(performance.now() - t0) });
    return wrap(data, sourceId, url, t, false);
  } catch (e) {
    if (cached) { mark(sourceId, { ok: true, cached: true, t: cached.t, error: 'using cached copy: ' + e.message }); return wrap(cached.data, sourceId, url, cached.t, true, e.message); }
    mark(sourceId, { ok: false, error: e.message, t: Date.now() }); throw new Error(`${src.name || sourceId}: ${e.message}`);
  }
}
// Most-recently-used live requests, re-fetched by the service worker's periodic background sync so installed copies
// open with fresh data even after long offline periods (no developer machine or server involved).
let mru = null;
async function remember(url, text) {
  try { mru ||= (await cget('__refresh'))?.list || []; mru = [{ url, text }, ...mru.filter(e => e.url !== url)].slice(0, 30); cset('__refresh', { t: Date.now(), list: mru }); } catch { /* optional */ }
}
function wrap(data, sourceId, url, t, cached, warning) { return { data, meta: { source: sourceId, name: SOURCES[sourceId]?.name || sourceId, kind: SOURCES[sourceId]?.kind, url, fetched: new Date(t).toISOString(), ageMin: Math.round((Date.now() - t) / 60000), cached, warning } }; }
function mark(id, s) { status[id] = { ...status[id], ...s }; for (const fn of listeners) fn(id, status[id]); }

// ---------------- Atmosphere ----------------
const HOURLY = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'surface_pressure', 'pressure_msl', 'cloud_cover', 'cloud_cover_low', 'precipitation', 'rain', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'wind_speed_80m', 'wind_speed_120m', 'shortwave_radiation', 'direct_normal_irradiance', 'diffuse_radiation', 'terrestrial_radiation', 'soil_temperature_0cm', 'soil_temperature_6cm', 'is_day', 'visibility'];
export async function forecast(lat, lon, { pastDays = 2, days = 7, force } = {}) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=${HOURLY.join(',')}&current=temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,shortwave_radiation,precipitation,is_day&wind_speed_unit=ms&timezone=auto&past_days=${pastDays}&forecast_days=${days}`;
  return fetchJSON('open-meteo-forecast', url, { force });
}
export async function archive(lat, lon, start, end) {
  const vars = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'surface_pressure', 'cloud_cover', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'shortwave_radiation', 'direct_normal_irradiance', 'diffuse_radiation', 'soil_temperature_0_to_7cm'];
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=${start}&end_date=${end}&hourly=${vars.join(',')}&wind_speed_unit=ms&timezone=auto`;
  return fetchJSON('open-meteo-archive', url);
}
export async function geocode(name) { return fetchJSON('open-meteo-geocoding', `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=en&format=json`); }
export async function elevation(lat, lon) { return fetchJSON('open-meteo-elevation', `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`); }
export async function reverseGeocode(lat, lon) { return fetchJSON('nominatim', `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&accept-language=en`); }
export async function nasaPowerClimatology(lat, lon) {
  const p = 'ALLSKY_SFC_SW_DWN,CLRSKY_SFC_SW_DWN,ALLSKY_SFC_LW_DWN,T2M,T2M_MAX,T2M_MIN,WS10M,WS50M,RH2M,PS,CLOUD_AMT,PRECTOTCORR';
  return fetchJSON('nasa-power', `https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=${p}&community=RE&longitude=${lon.toFixed(3)}&latitude=${lat.toFixed(3)}&format=JSON`, { timeout: 30000 });
}

// Convert Open-Meteo hourly block to column object with SI units
export function hourlyTable(om) {
  const h = om.hourly || {}; const n = (h.time || []).length;
  return { n, time: h.time || [], ...Object.fromEntries(Object.keys(h).filter(k => k !== 'time').map(k => [k, h[k].map(v => v ?? NaN)])), surface_pressure_Pa: (h.surface_pressure || []).map(v => v * 100), utcOffset: om.utc_offset_seconds || 0, elevation: om.elevation };
}

// ---------------- Literature, prior art & best-practice discovery ----------------
export async function literature(query, { perPage = 8, fromYear } = {}) {
  const yr = fromYear || (new Date().getFullYear() - 6);
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&filter=from_publication_date:${yr}-01-01&sort=relevance_score:desc&per-page=${perPage}&select=id,doi,title,publication_year,cited_by_count,primary_location,authorships,type,open_access`;
  const r = await fetchJSON('openalex', url);
  r.items = (r.data.results || []).map(w => ({ title: w.title, year: w.publication_year, cites: w.cited_by_count, doi: w.doi, url: w.doi || w.primary_location?.landing_page_url || w.id, venue: w.primary_location?.source?.display_name || '', authors: (w.authorships || []).slice(0, 3).map(a => a.author?.display_name).filter(Boolean).join(', '), type: w.type, oa: w.open_access?.is_oa }));
  return r;
}
export async function crossref(query, rows = 6) { const r = await fetchJSON('crossref', `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${rows}&sort=relevance&select=DOI,title,issued,container-title,is-referenced-by-count,type`); r.items = (r.data.message?.items || []).map(w => ({ title: (w.title || [''])[0], year: w.issued?.['date-parts']?.[0]?.[0], doi: 'https://doi.org/' + w.DOI, venue: (w['container-title'] || [''])[0], cites: w['is-referenced-by-count'], type: w.type })); return r; }
export async function patents(query, n = 6) { const r = await fetchJSON('europepmc', `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query + ' AND SRC:PAT')}&format=json&pageSize=${n}`); r.items = (r.data.resultList?.result || []).map(p => ({ title: p.title, year: p.pubYear, id: p.id, url: `https://europepmc.org/article/PAT/${p.id}`, authors: p.authorString })); return r; }

// ---------------- Economics & sustainability ----------------
export async function worldBank(iso2, indicator, n = 12) {
  const r = await fetchJSON('worldbank', `https://api.worldbank.org/v2/country/${iso2}/indicator/${indicator}?format=json&per_page=${n}&mrv=${n}`);
  const rows = (r.data?.[1] || []).filter(d => d.value !== null).map(d => ({ year: +d.date, value: d.value, country: d.country?.value }));
  r.series = rows.sort((a, b) => a.year - b.year); r.latest = rows.length ? rows[rows.length - 1] : null; return r;
}
export const WB = { inflation: 'FP.CPI.TOTL.ZG', lendingRate: 'FR.INR.LEND', realRate: 'FR.INR.RINR', gdpPc: 'NY.GDP.PCAP.CD', manufacturing: 'NV.IND.MANF.ZS', co2pc: 'EN.GHG.CO2.PC.CE.AR5', renewShare: 'EG.ELC.RNEW.ZS', elecAccess: 'EG.ELC.ACCS.ZS' };
export async function fxRates(base = 'USD') { return fetchJSON('frankfurter', `https://api.frankfurter.dev/v1/latest?base=${base}`); }
export async function gridCarbon(iso3) {
  const r = await fetchJSON('owid-carbon', 'https://ourworldindata.org/grapher/electricity-mix.csv?frequency=annual&metric=carbon_intensity&source=total&v=1&csvType=filtered&useColumnShortNames=true', { text: true });
  // CSV columns: entity, code, year, gCO2/kWh[, original year]; entity names may contain quoted commas
  const lines = r.data.trim().split(/\r?\n/);
  r.series = lines.slice(1).map(l => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, '').replace(/^"|"$/g, '')))
    .filter(c => c[1] === iso3).map(c => ({ year: +c[2], value: +c[3] })).filter(d => Number.isFinite(d.value)).sort((a, b) => a.year - b.year);
  r.latest = r.series[r.series.length - 1] || null; return r;
}
export async function ukCarbonNow() { return fetchJSON('uk-carbon', 'https://api.carbonintensity.org.uk/intensity'); }
// Monthly world commodity prices (USD; metals per metric tonne, gas per MMBtu) from the IMF PCPS dataset mirrored by DBnomics
export const COMMODITIES = { PNICK: 'Nickel (USD/t)', PCOPP: 'Copper (USD/t)', PALUM: 'Aluminium (USD/t)', PNGASEU: 'Natural gas, Europe (USD/MMBtu)', PNGASUS: 'Natural gas, US Henry Hub (USD/MMBtu)', PCOALAU: 'Coal, Australia (USD/t)', PIORECR: 'Iron ore (USD/t)' };
export async function commodityPrices(codes = Object.keys(COMMODITIES), n = 36) {
  const ids = codes.map(c => `IMF/PCPS/M.W00.${c}.USD`).join(',');
  const r = await fetchJSON('dbnomics-imf', `https://api.db.nomics.world/v22/series?series_ids=${ids}&observations=1&format=json`, { timeout: 20000 });
  r.series = {};
  for (const d of r.data?.series?.docs || []) { const code = d.series_code.split('.')[2]; const per = d.period || [], val = d.value || []; const pts = per.map((p, i) => ({ period: p, value: val[i] })).filter(x => Number.isFinite(x.value)).slice(-n); r.series[code] = { label: COMMODITIES[code] || code, points: pts, latest: pts[pts.length - 1] || null }; }
  return r;
}
export async function pubchemProps(name) { return fetchJSON('pubchem', `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(name)}/property/MolecularFormula,MolecularWeight,IUPACName/JSON`); }

export const ISO2_3 = Object.fromEntries('AD AND AE ARE AF AFG AG ATG AL ALB AM ARM AO AGO AR ARG AT AUT AU AUS AZ AZE BA BIH BB BRB BD BGD BE BEL BF BFA BG BGR BH BHR BI BDI BJ BEN BN BRN BO BOL BR BRA BS BHS BT BTN BW BWA BY BLR BZ BLZ CA CAN CD COD CF CAF CG COG CH CHE CI CIV CL CHL CM CMR CN CHN CO COL CR CRI CU CUB CV CPV CY CYP CZ CZE DE DEU DJ DJI DK DNK DO DOM DZ DZA EC ECU EE EST EG EGY ER ERI ES ESP ET ETH FI FIN FJ FJI FR FRA GA GAB GB GBR GE GEO GH GHA GM GMB GN GIN GQ GNQ GR GRC GT GTM GW GNB GY GUY HN HND HR HRV HT HTI HU HUN ID IDN IE IRL IL ISR IN IND IQ IRQ IR IRN IS ISL IT ITA JM JAM JO JOR JP JPN KE KEN KG KGZ KH KHM KM COM KP PRK KR KOR KW KWT KZ KAZ LA LAO LB LBN LK LKA LR LBR LS LSO LT LTU LU LUX LV LVA LY LBY MA MAR MD MDA ME MNE MG MDG MK MKD ML MLI MM MMR MN MNG MR MRT MT MLT MU MUS MV MDV MW MWI MX MEX MY MYS MZ MOZ NA NAM NE NER NG NGA NI NIC NL NLD NO NOR NP NPL NZ NZL OM OMN PA PAN PE PER PG PNG PH PHL PK PAK PL POL PT PRT PY PRY QA QAT RO ROU RS SRB RU RUS RW RWA SA SAU SB SLB SC SYC SD SDN SE SWE SG SGP SI SVN SK SVK SL SLE SN SEN SO SOM SR SUR SS SSD SV SLV SY SYR SZ SWZ TD TCD TG TGO TH THA TJ TJK TM TKM TN TUN TR TUR TT TTO TW TWN TZ TZA UA UKR UG UGA US USA UY URY UZ UZB VE VEN VN VNM YE YEM ZA ZAF ZM ZMB ZW ZWE'.split(' ').reduce((a, v, i, arr) => (i % 2 === 0 && a.push([v, arr[i + 1]]), a), []));

// Site context bundle used by the advisor (country, economics, grid carbon) — resilient to partial failure
export async function siteContext(lat, lon) {
  const ctx = { errors: [] };
  try { const r = await reverseGeocode(lat, lon); ctx.place = r.data.display_name; ctx.iso2 = (r.data.address?.country_code || '').toUpperCase(); ctx.country = r.data.address?.country; } catch (e) { ctx.errors.push(e.message); }
  if (ctx.iso2) {
    const iso3 = ISO2_3[ctx.iso2];
    const jobs = [
      worldBank(ctx.iso2, WB.inflation).then(r => ctx.inflation = r.latest).catch(e => ctx.errors.push(e.message)),
      worldBank(ctx.iso2, WB.lendingRate).then(r => ctx.lendingRate = r.latest).catch(e => ctx.errors.push(e.message)),
      worldBank(ctx.iso2, WB.renewShare).then(r => ctx.renewShare = r.latest).catch(e => ctx.errors.push(e.message)),
      iso3 ? gridCarbon(iso3).then(r => ctx.gridCarbon = r.latest).catch(e => ctx.errors.push(e.message)) : null,
    ];
    await Promise.all(jobs);
  }
  try { const fx = await fxRates('USD'); ctx.fx = fx.data.rates; ctx.fxDate = fx.data.date; } catch (e) { ctx.errors.push(e.message); }
  return ctx;
}
