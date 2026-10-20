// Live global data hub: every connected source, its freshness, latency, cache state and the suites it feeds.
import { h, section, table, toast, callout } from '../core/ui.js';
import * as live from '../core/live.js';
import { store } from '../core/state.js';
import { fmt } from '../core/num.js';
export const title = 'Live data hub';

const FEEDS = {
  'open-meteo-forecast': 'S07 cold-sink ambient & wet-bulb (cooling towers, dry coolers), S06 solar-thermal irradiance', 'open-meteo-archive': 'S07 seasonal sink variation, S19 test-day ambient records',
  'open-meteo-geocoding': 'Site search (any location worldwide)', 'open-meteo-elevation': 'Site elevation (air density for air coolers)',
  'nasa-power': 'S06 solar-thermal source climatology, S07 seasonal ambient', 'nominatim': 'Site naming & country (economic context)',
  'openalex': 'Recommendations in every suite (latest best practice), prior art', 'crossref': 'Citation metadata for evidence packages', 'europepmc': 'Patent & literature prior-art search (novelty checks)',
  'worldbank': 'S22 inflation, lending rates, renewables share; advisor economics', 'frankfurter': 'S22 currency conversion (ECB reference rates)', 'ecb': 'S22 euro-area reference data',
  'owid-carbon': 'S22 & advisor: grid carbon intensity for manufacturing and displaced electricity', 'uk-carbon': 'Real-time grid carbon (UK sites)', 'dbnomics-imf': 'S03/S22 nickel, copper, aluminium prices; S06 natural-gas heat price', 'pubchem': 'S03 element / compound reference data', 'wikidata': 'S03 reference knowledge',
};

export async function render(root) {
  const s = store.project.site;
  root.append(h('h1', {}, 'Live global data hub'), h('p', { class: 'muted', style: 'max-width:980px' }, 'All connections are made directly from your device to the public global services below — no intermediate server, so the data stay fresh even when the developer’s computer is off and the software keeps working if any single host is unavailable. Responses are timestamped, labelled by data kind and cached on your device for offline use; when a service is unreachable the last good copy is used and flagged.'));
  root.append(callout('info', `Project site: ${s.name} (${fmt(s.lat, 6)}°, ${fmt(s.lon, 6)}°). Change it with 📍 in the top bar.`));
  const tbl = h('div'); root.append(section('Connected sources', tbl));
  const draw = () => { tbl.innerHTML = ''; tbl.append(table(['Source', 'Data kind', 'Feeds', 'Status', 'Last fetch', 'Latency', 'Cache TTL'], Object.entries(live.SOURCES).map(([id, src]) => { const st = live.status[id]; return [h('a', { href: src.home, target: '_blank', rel: 'noopener' }, src.name), src.kind, FEEDS[id] || '', h('span', { class: 'badge ' + (!st ? '' : st.ok ? (st.cached ? 'warn' : 'ok') : 'fail'), title: st?.error || '' }, !st ? 'idle' : st.ok ? (st.cached ? 'cached' : 'live') : 'error'), st?.t ? new Date(st.t).toLocaleString() : '—', st?.ms ? st.ms + ' ms' : '—', src.ttl >= 1440 ? fmt(src.ttl / 1440, 3) + ' d' : src.ttl + ' min']; }))); };
  draw(); const off = live.onStatus(draw);
  const log = h('div', { class: 'small' });
  root.append(section('Refresh & test', h('div', { class: 'row gap wrap' }, h('button', { class: 'btn primary', onclick: async () => { log.innerHTML = ''; const jobs = [['Forecast', () => live.forecast(s.lat, s.lon, { force: true })], ['Climatology', () => live.nasaPowerClimatology(s.lat, s.lon)], ['Elevation', () => live.elevation(s.lat, s.lon)], ['Reverse geocode', () => live.reverseGeocode(s.lat, s.lon)], ['Site economics & carbon', () => live.siteContext(s.lat, s.lon)], ['Literature', () => live.literature('shape memory alloy heat engine', { perPage: 3 })], ['FX rates', () => live.fxRates('USD')], ['Commodity prices', () => live.commodityPrices()]]; for (const [n, f] of jobs) { const t0 = performance.now(); try { await f(); log.append(h('div', {}, `✔ ${n} — ${Math.round(performance.now() - t0)} ms`)); } catch (e) { log.append(h('div', { style: 'color:var(--bad)' }, `✖ ${n} — ${e.message}`)); } } toast('Refresh complete', 'ok'); } }, '↻ Refresh all for this site'), h('button', { class: 'btn', onclick: async () => { await live.clearCache(); toast('Device data cache cleared', 'ok'); } }, 'Clear device cache')), log));
  const keys = await live.cacheKeys(); root.append(section('Device cache', h('p', {}, `${keys.length} cached responses available offline.`)));
  root.append(section('Data-kind labels used throughout the software', table(['Kind', 'Meaning'], [['observation', 'Measured by instruments (station, user-imported logs)'], ['forecast', 'Numerical-weather-prediction output, including recent analysis hours'], ['reanalysis', 'Model reconstruction of past weather assimilating observations (ERA5)'], ['climatology', 'Long-term averages from satellite and reanalysis records'], ['calculated', 'Derived inside the software from governing equations (e.g. sky temperature)'], ['literature', 'Peer-reviewed or indexed scholarly records — support, not proof'], ['economic', 'Official statistical indicators and reference rates']])));
  return { dispose: off };
}
