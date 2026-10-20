// Release notes shown in the update / "What's new" pop-up. Newest first; `id` must increase.
export const CHANGELOG = [
  { id: 2, date: '2026-10-21', title: 'Release 1.1 — Dossier, 3-D simulations and clearer animations', items: [
    'New Engineering dossier: generated automatically for every change of inputs and every dataset you supply — experimental set-up, materials, methodology, all test conditions, principle of operation, analysis results and revision history.',
    'Professional drawing sheets (ISO A3, third-angle): general arrangement, cartridge sub-assembly, exploded isometric views with balloons and parts lists, and a dimensioned detail drawing for every part; SVG, PNG (300 dpi), DXF, HTML/PDF and ZIP export.',
    'High-quality 3-D dynamic simulations driven by the solved models: the running engine, the cartridge cycle, microchannel heat transfer, shaft and phased cells, start-up and the compliant mechanism.',
    'Cleaner animated views: no overlapping labels, and steady results shown as static diagrams without needless play controls.',
    'Update notifications: this pop-up now appears whenever a new version is ready.',
  ] },
  { id: 1, date: '2026-10-20', title: 'Release 1.0 — THERMA-X100 research platform', items: [
    'Twenty-two coupled engineering suites, from engine architecture and parametric CAD/meshing through SMA transformation, cartridge mechanics, hot/cold thermal circuits, microchannels, regeneration, metamaterial transmission, shaft dynamics, phase timing, hydraulics, co-simulation, start-up, fatigue, optimisation, exergy, digital twin, manufacturing, safety and techno-economics.',
    'Every suite offers Automatic, Guided, Expert and Experimental-import input modes with provenance on every value, explained results, verification checks and recommendations.',
    'Live global data fetched directly by your device: weather and climatology, literature and patents, World Bank indicators, exchange rates, grid carbon intensity and IMF commodity prices.',
    'Installable on computers, phones and tablets; works offline and in airplane mode.',
  ] },
];
export const LATEST = CHANGELOG[0].id;
