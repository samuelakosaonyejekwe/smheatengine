// Additional geometry exporters: 3MF (additive manufacturing) and IGES 5.3 (faceted wireframe).
// Both take the closed triangle meshes produced by cad.js ({ name, p: flat xyz, i: triangle indices }).
import { zip } from './io.js';

const esc = (s) => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// 3MF core specification: one <object> per part, units in metres, packaged as an OPC ZIP.
export async function to3MF(parts, title = 'THERMA-X100') {
  let objs = '', items = '';
  parts.forEach((m, k) => {
    const id = k + 1; let v = '', t = '';
    for (let j = 0; j < m.p.length; j += 3) v += `<vertex x="${m.p[j].toFixed(6)}" y="${m.p[j + 1].toFixed(6)}" z="${m.p[j + 2].toFixed(6)}"/>`;
    for (let j = 0; j < m.i.length; j += 3) t += `<triangle v1="${m.i[j]}" v2="${m.i[j + 1]}" v3="${m.i[j + 2]}"/>`;
    objs += `<object id="${id}" name="${esc(m.name)}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
    items += `<item objectid="${id}"/>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="meter" xml:lang="en-GB" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">${esc(title)}</metadata><resources>${objs}</resources><build>${items}</build></model>`;
  const types = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  return zip([{ name: '[Content_Types].xml', data: types }, { name: '_rels/.rels', data: rels }, { name: '3D/3dmodel.model', data: model }]);
}

// IGES 5.3 fixed-format file. Every triangle is written as a closed copious-data polyline (entity 106, form 12),
// i.e. a faceted wireframe of each solid; units metres. Exact B-rep surfaces are not represented.
export function toIGES(parts, title = 'THERMA-X100') {
  const rec = (txt, sec, n) => txt.padEnd(72).slice(0, 72) + sec + String(n).padStart(7);
  const S = [rec(`${title} faceted geometry (IGES 5.3, entity 106 form 12, metres)`, 'S', 1)];
  const now = new Date(), stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 13).replace(/^(\d{8})(\d{4}).*/, '$1.$2') + '00';
  const hs = (s) => `${s.length}H${s}`;
  const gTxt = ['1H,', '1H;', hs(title), hs('therma.igs'), hs(title), hs('5.3'), '32', '38', '6', '308', '15', hs(title), '1.0', '6', hs('M'), '1', '0.01', hs(stamp), '1E-6', '100.0', hs(''), hs(''), '11', '0', hs(stamp)].join(',') + ';';
  const G = []; for (let k = 0; k < gTxt.length; k += 72) G.push(rec(gTxt.slice(k, k + 72), 'G', G.length + 1));
  const D = [], P = [];
  const f8 = (v) => String(v).padStart(8);
  for (const m of parts) for (let j = 0; j < m.i.length; j += 3) {
    const pts = [m.i[j], m.i[j + 1], m.i[j + 2], m.i[j]].map(q => [m.p[3 * q], m.p[3 * q + 1], m.p[3 * q + 2]]);
    const de = D.length + 1, txt = `106,2,4,${pts.map(p => p.map(c => c.toExponential(6)).join(',')).join(',')};`;
    const lines = []; let cur = '';
    for (const tok of txt.split(/(?<=,)/)) { if ((cur + tok).length > 64) { lines.push(cur); cur = ''; } cur += tok; }
    if (cur) lines.push(cur);
    const p0 = P.length + 1;
    for (const ln of lines) P.push(ln.padEnd(64) + String(de).padStart(8) + 'P' + String(P.length + 1).padStart(7));
    D.push(f8(106) + f8(p0) + f8(0) + f8(0) + f8(0) + f8(0) + f8(0) + f8(0) + '00000000' + 'D' + String(de).padStart(7));
    D.push(f8(106) + f8(0) + f8(0) + f8(lines.length) + f8(12) + f8('') + f8('') + f8('') + f8(0) + 'D' + String(de + 1).padStart(7));
  }
  const T = rec(`S${String(S.length).padStart(7)}G${String(G.length).padStart(7)}D${String(D.length).padStart(7)}P${String(P.length).padStart(7)}`, 'T', 1);
  return new Blob([[...S, ...G, ...D, ...P, T].join('\n') + '\n'], { type: 'model/iges' });
}

// Formats named in the specification that this browser build does not write, with the honest reason and the nearest
// supported alternative. Shown in the Suite 02 export manager so no format is implied that does not exist.
export const UNSUPPORTED_FORMATS = [
  { fmt: 'STEP AP242 (exact B-rep with PMI)', why: 'needs an exact-geometry CAD kernel', alt: 'STEP AP214 (faceted B-rep), IGES 5.3 (faceted)' },
  { fmt: 'HDF5 / NetCDF', why: 'binary scientific containers need native libraries', alt: 'CSV + JSON field exports, VTK' },
  { fmt: 'CGNS', why: 'binary mesh container', alt: '.msh 2.2, VTK, .su2, polyMesh' },
  { fmt: 'XDMF', why: 'needs an HDF5 heavy-data store', alt: 'VTK legacy files' },
  { fmt: 'TIFF / EXR images', why: 'no high-dynamic-range encoder in the browser', alt: 'PNG (incl. 4K 3840 × 2160), SVG' },
  { fmt: 'MP4 video', why: 'browser recorders produce WebM', alt: 'WebM (VP8/VP9) from the 3D timeline recorder' },
  { fmt: 'DOCX', why: 'office document writer not bundled', alt: 'print-to-PDF reports, HTML dossier, CSV tables' },
  { fmt: 'Parquet', why: 'columnar binary writer not bundled', alt: 'CSV / JSON tables, XLSX via the spreadsheet library' },
];
