// Input portal parsers and export writers (ZIP, CSV, JSON, mesh/CAD text formats are in cad.js / mesh.js).
import { download } from './chart.js';

export const IMPORT_FORMATS = [
  { ext: ['csv', 'tsv', 'txt', 'dat', 'prn'], label: 'Delimited text / tabular (CSV, TSV, whitespace)', kind: 'table' },
  { ext: ['json', 'geojson'], label: 'JSON / GeoJSON (incl. THERMA-X100 project files)', kind: 'json' },
  { ext: ['xlsx', 'xls', 'xlsm', 'ods'], label: 'Spreadsheets (.xlsx, .xls, .xlsm, .ods)', kind: 'sheet' },
  { ext: ['xml', 'kml', 'gpx'], label: 'XML family (KML/GPX routes, XML datasets)', kind: 'xml' },
  { ext: ['stl'], label: 'STL surface mesh (ASCII or binary)', kind: 'stl' },
  { ext: ['obj'], label: 'Wavefront OBJ polygon mesh', kind: 'obj' },
  { ext: ['msh'], label: '.msh v2.2 ASCII mesh', kind: 'msh' },
  { ext: ['vtk'], label: 'Legacy VTK ASCII (unstructured / polydata)', kind: 'vtk' },
];
export const ACCEPT = IMPORT_FORMATS.flatMap(f => f.ext.map(e => '.' + e)).join(',');

export async function parseFile(file) {
  const ext = file.name.split('.').pop().toLowerCase(); const fmt = IMPORT_FORMATS.find(f => f.ext.includes(ext));
  if (!fmt) throw new Error(`Unsupported format ".${ext}". Supported: ${IMPORT_FORMATS.map(f => f.ext.join('/')).join(', ')}`);
  switch (fmt.kind) {
    case 'table': { const txt = await file.text(); if (ext === 'dat' && looksLikeAirfoil(txt)) return { kind: 'airfoil', name: file.name, ...parseAirfoil(txt) }; return { kind: 'table', name: file.name, ...parseDelimited(txt) }; }
    case 'json': { const j = JSON.parse(await file.text()); if (j?.type === 'FeatureCollection' || j?.type === 'Feature') return { kind: 'geojson', name: file.name, data: j, points: geojsonPoints(j) }; if ((j?.engine || j?.vehicle) && j?.outputs) return { kind: 'project', name: file.name, data: j }; return { kind: 'json', name: file.name, data: j, ...(Array.isArray(j) && typeof j[0] === 'object' ? tableFromObjects(j) : {}) }; }
    case 'sheet': { const XLSX = await loadXLSX(); const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' }); const sheets = wb.SheetNames.map(n => ({ name: n, ...tableFromRows(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true })) })); return { kind: 'table', name: file.name, ...sheets[0], sheets }; }
    case 'xml': { const doc = new DOMParser().parseFromString(await file.text(), 'application/xml'); if (doc.querySelector('parsererror')) throw new Error('Malformed XML'); const pts = [...doc.querySelectorAll('trkpt, rtept, wpt')].map(p => ({ lat: +p.getAttribute('lat'), lon: +p.getAttribute('lon'), ele: +(p.querySelector('ele')?.textContent || 0) })); const kml = [...doc.getElementsByTagName('coordinates')].flatMap(c => c.textContent.trim().split(/\s+/).map(t => { const [lon, lat, ele] = t.split(',').map(Number); return { lat, lon, ele: ele || 0 }; })); return { kind: 'route', name: file.name, points: pts.length ? pts : kml, doc }; }
    case 'stl': return { kind: 'mesh', name: file.name, ...parseSTL(await file.arrayBuffer()) };
    case 'obj': return { kind: 'mesh', name: file.name, ...parseOBJ(await file.text()) };
    case 'msh': return { kind: 'mesh', name: file.name, ...parseMSH(await file.text()) };
    case 'vtk': return { kind: 'mesh', name: file.name, ...parseVTK(await file.text()) };
  }
}

let xlsxP = null;
export function loadXLSX() { if (window.XLSX) return Promise.resolve(window.XLSX); xlsxP ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = new URL('../../vendor/xlsx.full.min.js', import.meta.url).href; s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('Spreadsheet reader unavailable')); document.head.append(s); }); return xlsxP; }

export function parseDelimited(txt) {
  const lines = txt.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() && !/^\s*[#%]/.test(l));
  if (!lines.length) throw new Error('No data rows found');
  const delim = [',', '\t', ';', '|'].map(d => [d, lines.slice(0, 10).reduce((s, l) => s + (l.split(d).length - 1), 0)]).sort((a, b) => b[1] - a[1])[0];
  const split = delim[1] > 0 ? (l) => splitQuoted(l, delim[0]) : (l) => l.trim().split(/\s+/);
  const rows = lines.map(split);
  return tableFromRows(rows);
}
function splitQuoted(line, d) { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === d) { out.push(cur.trim()); cur = ''; } else cur += c; } out.push(cur.trim()); return out; }
export function tableFromRows(rows) {
  rows = rows.filter(r => r && r.length && r.some(c => c !== '' && c !== null && c !== undefined));
  const isNumRow = (r) => r.every(c => c === '' || c === null || Number.isFinite(+c));
  const header = isNumRow(rows[0]) ? rows[0].map((_, i) => `col${i + 1}`) : rows[0].map(String);
  const body = isNumRow(rows[0]) ? rows : rows.slice(1);
  const columns = {}; header.forEach((hname, j) => { const vals = body.map(r => r[j]); const num = vals.every(v => v === '' || v === null || v === undefined || Number.isFinite(+v)); columns[hname] = num ? vals.map(v => v === '' || v === null || v === undefined ? NaN : +v) : vals.map(v => v ?? ''); });
  return { header, columns, nRows: body.length, units: guessUnits(header) };
}
function tableFromObjects(arr) { const header = [...new Set(arr.flatMap(o => Object.keys(o)))]; return tableFromRows([header, ...arr.map(o => header.map(k => o[k]))]); }
function guessUnits(header) { const u = {}; for (const hname of header) { const m = String(hname).match(/[[(]([^\])]+)[\])]/); if (m) u[hname] = m[1]; } return u; }

// Map columns to physical quantities by name heuristics (user can override in the portal)
export const QUANTITY_HINTS = {
  time: /^(t|time|timestamp|date|datetime|s|sec)/i, temperature: /temp|t_?amb|t2m|°c|degc|t_?ribbon|t_?hot|t_?cold/i, heatflow: /heat.?flow|dsc|mw\b|q_?dot|w\/g/i, flow: /flow|mdot|l\/min|lpm|kg\/s/i,
  speed: /rpm|omega|rad\/s|speed/i, pressure: /press|dp|delta.?p|hpa|bar\b|pa\b/i, humidity: /rh|humid/i, irradiance: /ghi|irrad|solar|w\/m/i, force: /force|load|\bn\b|kn/i,
  displacement: /disp|stroke|extension|\bmm\b|\bx\b/i, strain: /strain|eps/i, stress: /stress|sigma|mpa/i, torque: /torque|n.?m/i, angle: /angle|theta|deg/i, power: /power|watt|\bw\b/i,
};
export function autoMap(header) { const m = {}; for (const [q, re] of Object.entries(QUANTITY_HINTS)) { const c = header.find(hname => re.test(hname)); if (c) m[q] = c; } return m; }

function looksLikeAirfoil(txt) { const l = txt.trim().split(/\r?\n/); const nums = l.slice(1).filter(x => /^\s*-?\d*\.?\d+(e-?\d+)?\s+-?\d*\.?\d+(e-?\d+)?\s*$/i.test(x)); return nums.length > 10 && nums.length >= l.length - 3; }
export function parseAirfoil(txt) {
  const lines = txt.trim().split(/\r?\n/), name = lines[0].trim(); let pts = lines.slice(1).map(l => l.trim().split(/\s+/).map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
  if (pts.length && pts[0][0] > 1.5) { // Lednicer format: first row = point counts
    const nu = pts[0][0], up = pts.slice(1, 1 + nu), lo = pts.slice(1 + nu); pts = up.reverse().concat(lo.slice(1));
  }
  const xs = pts.map(p => p[0]), xmin = Math.min(...xs), xmax = Math.max(...xs), c = xmax - xmin || 1;
  return { name, points: pts.map(([x, y]) => [(x - xmin) / c, y / c]) };
}
function geojsonPoints(g) { const out = []; const walk = (c) => { if (typeof c[0] === 'number') out.push({ lon: c[0], lat: c[1], ele: c[2] || 0 }); else c.forEach(walk); }; (g.features || [g]).forEach(f => f.geometry && walk(f.geometry.coordinates)); return out; }

export function parseSTL(buf) {
  const dv = new DataView(buf), n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  if (84 + n * 50 === buf.byteLength) { const pos = new Float32Array(n * 9); for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true); return { positions: pos, triangles: n, format: 'STL binary' }; }
  const txt = new TextDecoder().decode(buf), v = [...txt.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap(m => [+m[1], +m[2], +m[3]]);
  return { positions: Float32Array.from(v), triangles: v.length / 9, format: 'STL ASCII' };
}
export function parseOBJ(txt) {
  const V = [], out = []; for (const line of txt.split(/\r?\n/)) { const p = line.trim().split(/\s+/); if (p[0] === 'v') V.push([+p[1], +p[2], +p[3]]); else if (p[0] === 'f') { const idx = p.slice(1).map(s => { const i = parseInt(s, 10); return i < 0 ? V.length + i : i - 1; }); for (let k = 1; k < idx.length - 1; k++) for (const j of [idx[0], idx[k], idx[k + 1]]) out.push(...V[j]); } }
  return { positions: Float32Array.from(out), triangles: out.length / 9, format: 'OBJ' };
}
export function parseMSH(txt) {
  const nodes = txt.match(/\$Nodes\s+(\d+)\s+([\s\S]*?)\$EndNodes/); const els = txt.match(/\$Elements\s+(\d+)\s+([\s\S]*?)\$EndElements/);
  if (!nodes || !els) throw new Error('Only .msh 2.2 ASCII meshes are supported');
  const P = {}; nodes[2].trim().split(/\r?\n/).forEach(l => { const a = l.trim().split(/\s+/).map(Number); P[a[0]] = [a[1], a[2], a[3]]; });
  const tris = []; els[2].trim().split(/\r?\n/).forEach(l => { const a = l.trim().split(/\s+/).map(Number); const type = a[1], nt = a[2], nd = a.slice(3 + nt); if (type === 2) tris.push(nd); if (type === 3) tris.push([nd[0], nd[1], nd[2]], [nd[0], nd[2], nd[3]]); });
  const pos = []; for (const t of tris) for (const id of t) pos.push(...P[id]); return { positions: Float32Array.from(pos), triangles: tris.length, nodes: Object.keys(P).length, format: '.msh 2.2' };
}
export function parseVTK(txt) {
  const pm = txt.match(/POINTS\s+(\d+)\s+\w+\s+([\s\S]*?)(?=POLYGONS|CELLS|$)/); if (!pm) throw new Error('No POINTS section');
  const nums = pm[2].trim().split(/\s+/).map(Number), P = []; for (let i = 0; i < +pm[1]; i++) P.push(nums.slice(i * 3, i * 3 + 3));
  const cm = txt.match(/(POLYGONS|CELLS)\s+(\d+)\s+\d+\s+([\s\S]*?)(?=CELL_TYPES|POINT_DATA|CELL_DATA|$)/); const pos = [];
  if (cm) { const a = cm[3].trim().split(/\s+/).map(Number); let i = 0; while (i < a.length) { const n = a[i]; const ids = a.slice(i + 1, i + 1 + n); for (let k = 1; k < n - 1; k++) for (const j of [ids[0], ids[k], ids[k + 1]]) pos.push(...P[j]); i += n + 1; } }
  return { positions: Float32Array.from(pos), triangles: pos.length / 9, nodes: P.length, format: 'VTK legacy' };
}

// ---------- ZIP (store method, CRC-32) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
export async function zip(files) { // files: [{name, data: string|Uint8Array|Blob}]
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data instanceof Blob ? new Uint8Array(await f.data.arrayBuffer()) : f.data;
    const name = enc.encode(f.name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name); offset += 30 + name.length + data.length;
  }
  const csize = central.reduce((s, a) => s + a.length, 0), end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

export function toCSVRows(header, rows) { const q = (s) => /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ''); return [header.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\n'); }
export const saveText = (txt, name, type = 'text/plain') => download(new Blob([txt], { type }), name);
export const saveJSON = (obj, name) => saveText(JSON.stringify(obj, null, 2), name, 'application/json');
