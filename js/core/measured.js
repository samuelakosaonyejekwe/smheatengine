// Measured converter efficiency from imported test data (Experiments A/B/C, Suites 15/17). Each cycle record gives heat input
// and net work (per cycle or as power) with the hot / cold temperatures; the fraction of Carnot η/(1 − T_c/T_h) is aggregated
// with its uncertainty, and the lower 95 % bound is what the latent-heat-store sizing may use (Suite 14, pcmstore basis 'measured').
// Calibration and validation datasets are kept separate (each import is tagged): calibration data set the parameter, validation
// data only judge it. The test-conditions column limits the scope — laboratory heat sources validate the converter, not
// atmospheric operation. Nothing here generates data: with no imported dataset the result is null.
import { KELVIN } from './num.js';

const COL = {
  qin: /^(q_?in|heat[_ ]?in|heat[_ ]?input)(_?j|_?w)?\b|heat input/i,
  wnet: /^(w_?net|net[_ ]?work|work[_ ]?net|shaft[_ ]?work|p_?shaft|shaft[_ ]?power|w_?out)/i,
  qout: /^(q_?out|heat[_ ]?out|heat[_ ]?rejected)/i,
  th: /^(t_?hot|t_?h|hot[_ ]?temp)/i,
  tc: /^(t_?cold|t_?c|cold[_ ]?temp)/i,
  rate: /^(cycle[_ ]?rate|f_?cycle|frequency|rate)/i,
  id: /^(test[_ ]?id|run|id)$/i,
  uq: /^(u_?q|u_?qin|unc_?q)/i, uw: /^(u_?w|u_?wnet|unc_?w)/i,
  cond: /^(conditions?|test[_ ]?conditions?|source)$/i,
};
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086];
const tCrit = (dof) => dof >= 1 ? (T95[dof - 1] ?? 1.96 + 2.4 / dof) : Infinity;
const OUTDOOR = /outdoor|atmospher|solar|sun|environment|field|sky|night/i;

// header → column name, by pattern (CSV/XLSX/JSON imports all arrive as { header, columns })
export function mapColumns(header = []) {
  const m = {}; for (const [k, re] of Object.entries(COL)) { const i = header.findIndex(h => re.test(String(h).trim())); if (i >= 0) m[k] = header[i]; } return m;
}

function records(datasets) {
  const recs = [];
  for (const d of datasets) {
    if (!d?.columns || !d.header) continue; const m = mapColumns(d.header); if (!m.qin || !m.wnet || !m.th || !m.tc) continue;
    const n = (d.columns[m.qin] || []).length;
    for (let i = 0; i < n; i++) {
      const Q = +d.columns[m.qin][i], W = +d.columns[m.wnet][i], Th = +d.columns[m.th][i], Tc = +d.columns[m.tc][i];
      if (![Q, W, Th, Tc].every(Number.isFinite) || Q <= 0 || Th <= Tc) continue;
      const eta = W / Q, carnot = 1 - (Tc + KELVIN) / (Th + KELVIN), frac = eta / carnot;
      const uQ = m.uq ? +d.columns[m.uq][i] : NaN, uW = m.uw ? +d.columns[m.uw][i] : NaN, uRel = Math.hypot(Number.isFinite(uQ) ? uQ / Q : 0, Number.isFinite(uW) && W ? uW / W : 0);
      const Qo = m.qout ? +d.columns[m.qout][i] : NaN, closure = Number.isFinite(Qo) ? Math.abs(Q - Qo - W) / Q : NaN;
      const cond = m.cond ? String(d.columns[m.cond][i] ?? '') : '';
      recs.push({ ds: d.name, use: d.use === 'calibration' ? 'calibration' : 'validation', id: m.id ? d.columns[m.id][i] : `${d.name}#${i + 1}`, Q, W, Th, Tc, eta, carnot, frac, uRel, closure, cond, outdoor: OUTDOOR.test(cond) });
    }
  }
  return recs;
}

function aggregate(recs) {
  if (!recs.length) return null;
  const n = recs.length, mean = recs.reduce((s, r) => s + r.frac, 0) / n, sd = n > 1 ? Math.sqrt(recs.reduce((s, r) => s + (r.frac - mean) ** 2, 0) / (n - 1)) : NaN;
  const uMeas = mean * Math.sqrt(recs.reduce((s, r) => s + r.uRel ** 2, 0) / n), seRand = Number.isFinite(sd) ? sd / Math.sqrt(n) : Infinity;
  const half = n > 1 ? tCrit(n - 1) * Math.hypot(seRand, uMeas) : Infinity, lo95 = Number.isFinite(half) ? Math.max(0, mean - half) : 0;
  const closures = recs.map(r => r.closure).filter(Number.isFinite), closed = closures.length === n && closures.every(c => c <= 0.05);
  const ids = new Set(recs.map(r => String(r.id).split('#')[0])), cv = Number.isFinite(sd) && mean > 0 ? sd / mean : Infinity, repeat = n >= 3 && cv <= 0.10;
  return { n, tests: ids.size, mean, sd, half, lo95, etaMean: recs.reduce((s, r) => s + r.eta, 0) / n, closed, repeat, cv, outdoor: recs.every(r => r.outdoor), anyOutdoor: recs.some(r => r.outdoor) };
}

// level: 'component' (Suite 15 cartridge) or 'subsystem' (Suite 17 hub) — mapped to the specification credibility classes
export function measuredEfficiency(datasets = [], level = 'component') {
  const all = records(datasets); if (!all.length) return null;
  const cal = aggregate(all.filter(r => r.use === 'calibration')), val = aggregate(all.filter(r => r.use === 'validation'));
  const param = cal || val; // calibration data set the parameter; validation data are used for it only when no calibration set exists
  const independent = !!(cal && val), agree = independent ? Math.abs(val.mean - cal.mean) <= Math.hypot(val.half, cal.half) : false;
  const validated = independent && val.closed && val.repeat && agree;
  const scopeOutdoor = validated && level === 'subsystem' && val.outdoor;
  const credibility = validated ? (scopeOutdoor ? 'Environmentally validated' : level === 'subsystem' ? 'Subsystem validated' : 'Component validated') : 'Calibrated';
  const scope = scopeOutdoor ? 'converter and atmospheric heat supply (outdoor data)' : 'converter only (laboratory heat source — atmospheric operation not validated)';
  return { ...param, cal, val, independent, agree, validated, credibility, scope, outdoorScope: scopeOutdoor };
}

// Hub (Suite 17) data are the system-level measurement; the single-cartridge result (Suite 15) is used only without them
export function measuredBasis(project) {
  const m = project?.measured || {}, hub = m.s17, cart = m.s15, use = hub || cart;
  return use ? { ...use, source: hub ? 'Suite 17 hub (Experiments B/C)' : 'Suite 15 cartridge (Experiment A)' } : null;
}

// Suite-side block: KPI, verdict and project provenance for the imported cycle records of one suite (Experiment A in Suite 15,
// B/C in Suite 17). The model's own efficiency is shown next to it; the store sizing reads project.measured (Suite 14).
export function measuredBlock(out, ctx, suiteId, label, modelEta, thresholdFrac) {
  const level = suiteId === 's17' ? 'subsystem' : 'component';
  const M = measuredEfficiency(ctx.experiments || [], level); const P = ctx.store?.project;
  if (P) { P.measured ||= {}; if (M) P.measured[suiteId] = { n: M.n, tests: M.tests, mean: M.mean, sd: M.sd, lo95: M.lo95, half: M.half, etaMean: M.etaMean, validated: M.validated, credibility: M.credibility, scope: M.scope, outdoorScope: M.outdoorScope, calN: M.cal?.n ?? 0, valN: M.val?.n ?? 0, t: new Date().toISOString() }; else delete P.measured[suiteId]; }
  if (!M) { out.kpis.push({ label: `Measured converter efficiency (${label})`, value: 'no test data imported', unit: '', explain: 'Import cycle records (template docs/templates/converter_cycles_template.csv: test_id, Q_in_J, W_net_J, T_hot_C, T_cold_C, cycle_rate_Hz, optional Q_out_J, u_Q_J, u_W_J, conditions) through “Import experimental data”, tagging each dataset as calibration or validation. The latent-heat-store sizing then uses the lower 95 % bound of the calibrated fraction of Carnot instead of the built-device literature value.', prov: 'n/a' }); return null; }
  const thr = Number.isFinite(thresholdFrac) ? ` vs the ${(thresholdFrac * 100).toFixed(1)} % of Carnot that makes the 1 h store viable inside the mass cap` : '';
  const sets = `calibration ${M.cal ? `${M.cal.n} records` : 'none'}, validation ${M.val ? `${M.val.n} records` : 'none'}`;
  out.kpis.push({ label: `Measured converter efficiency (${label})`, value: `${(M.mean * 100).toFixed(2)} ± ${(M.half * 100).toFixed(2)} % of Carnot (lower 95 % ${(M.lo95 * 100).toFixed(2)} %)`, unit: '', explain: `Parameter from ${M.cal ? 'the calibration' : 'the only (untagged-as-calibration)'} data (${sets}): η = ${(M.etaMean * 100).toFixed(2)} % mean${Number.isFinite(modelEta) ? `, model ${(modelEta * 100).toFixed(2)} %` : ''}${thr}. Credibility ${M.credibility}: separate validation set ${M.independent ? 'yes' : 'no'}${M.val ? `, energy balance closed ≤ 5 % ${M.val.closed ? 'yes' : 'no'}, repeatability CV ≤ 10 % over ≥ 3 records ${M.val.repeat ? 'yes' : 'no'}` : ''}${M.independent ? `, validation agrees with calibration ${M.agree ? 'yes' : 'no'}` : ''}. Scope: ${M.scope}.`, prov: 'experimental', status: M.validated ? 'ok' : 'warn' });
  out.verdicts.push({ test: `Measured converter efficiency (${label})`, status: M.validated ? 'pass' : 'warn', detail: `${(M.mean * 100).toFixed(2)} ± ${(M.half * 100).toFixed(2)} % of Carnot (lower 95 % ${(M.lo95 * 100).toFixed(2)} %; ${sets}). ${M.credibility}; scope: ${M.scope}.` });
  if (M.validated) out.credibility = M.credibility;
  return M;
}
