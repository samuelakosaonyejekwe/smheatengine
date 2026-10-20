// Workspace 6 — experiment control & execution with safety interlocks: limits, operator arming with the mandatory
// hardware-interlock confirmation, stale-data watchdog, step sequencer, event log and an always-available emergency stop.
// Without connected hardware the sequencer runs against the simulated instrument only.
import { h, table, callout, toast } from '../core/ui.js';
import { store } from '../core/state.js';
import { Safety, Acquisition, Sequencer, simulatedSource, limitsFromDesign, validateLimits, HARDWARE_INTERLOCK_STATEMENT, getRecord, logEvent } from '../core/lab.js';
import { card, grid, field, numIn, txtIn, btn, note, row, liveStrip, session, protocolSelect, saveDataset } from './common.js';

const LIM = [['Tmax', 'Max temperature', '°C'], ['Tmin', 'Min temperature', '°C'], ['Fmax', 'Max |force|', 'N'], ['xMax', 'Max |extension|', 'mm'], ['pMax', 'Max pressure', 'Pa'], ['speedMax', 'Max speed', 'rpm'], ['staleMs', 'Stale-data timeout', 'ms']];

export async function render(el) {
  const d = store.project.engine;
  if (!session.safety) session.safety = new Safety({ limits: limitsFromDesign(d) });
  const sf = session.safety;
  sf.onTrip = (r) => { toast('INTERLOCK TRIP: ' + r, 'fail', 10000); logEvent(store, 'trip', r); session.seq?.abort(r); session.emit({ type: 'trip' }); upd(); };
  sf.onState = () => upd();
  el.append(callout('fail', h('b', {}, 'Independent hardware interlocks are mandatory. '), HARDWARE_INTERLOCK_STATEMENT, ' The software interlocks below stop acquisition and command a safe state, but they depend on the computer, browser and link working.'));
  const big = h('div', { style: 'display:flex;flex-wrap:wrap;gap:12px;align-items:center' });
  const estop = h('button', { class: 'btn', style: 'background:#b91c1c;color:#fff;font-weight:800;font-size:18px;padding:16px 26px;border-radius:50px;border:3px solid #7f1d1d', onclick: () => { sf.estop(); session.seq?.abort('emergency stop'); session.acq?.stop('emergency stop'); logEvent(store, 'estop', 'emergency stop pressed'); upd(); } }, '⏹ EMERGENCY STOP');
  el.append(card('State', big, note('States: disarmed (monitoring only, no commands) → armed (commands within limits) → tripped / e-stop (safe state commanded; reset by an identified operator before re-arming).')));
  // source
  const srcBox = h('div'); el.append(card('Source', srcBox));
  // limits
  const lim = {}; for (const [k] of LIM) lim[k] = numIn(sf.limits[k]);
  el.append(card('Interlock limits', note('Defaults derive from the design: reservoirs + 15 K, 1.6 × power-stroke force, 1.5 × transformation stroke. Every sample of every channel is checked (channels are matched by name: T…, F…, x…, dp/p…, speed/rpm); setpoint commands outside the limits are refused.'),
    grid(...LIM.map(([k, l, u]) => field(`${l} (${u})`, lim[k]))), row(btn('Apply limits', () => { try { sf.setLimits(Object.fromEntries(LIM.map(([k]) => [k, +lim[k].value]))); toast('Limits applied', 'ok'); } catch (e) { toast(e.message, 'fail'); } upd(); }), btn('Reset to design-derived', () => { const L0 = limitsFromDesign(d); for (const [k] of LIM) lim[k].value = L0[k]; }))));
  // arming
  const op = txtIn(sf.operator || '', 'operator name'), ack = h('input', { type: 'checkbox' });
  el.append(card('Arm / disarm', grid(field('Operator', op)), h('label', { style: 'display:flex;gap:8px;align-items:flex-start;margin:8px 0' }, ack, h('span', {}, 'I confirm that independent hardware interlocks (over-temperature cut-out, pressure relief, force/extension limit switches, overspeed trip and a hard-wired emergency stop) are fitted and were function-tested today, and that the limits above are correct for this specimen.')),
    row(btn('ARM', () => { try { const L = Object.fromEntries(LIM.map(([k]) => [k, +lim[k].value])); const bad = validateLimits(L); if (bad.length) throw new Error(bad.join('; ')); sf.arm({ operator: op.value, acknowledged: ack.checked, limits: L }); logEvent(store, 'arm', `armed by ${op.value}`); } catch (e) { toast(e.message, 'fail', 7000); } upd(); }, 'primary'), btn('Disarm', () => { sf.disarm('operator'); upd(); }), btn('Reset interlock', () => { try { sf.reset(op.value); logEvent(store, 'reset', `interlock reset by ${op.value}`); } catch (e) { toast(e.message, 'fail'); } upd(); }))));
  // sequencer
  const prot = protocolSelect('', false), scale = numIn(0.02, { step: 0.01 }), seqBox = h('div');
  el.append(card('Step sequencer', note('Runs the protocol steps in order. “set” steps send SET <channel> <value> only while armed and within limits; “hold/record” steps wait (time-compressed for the simulated instrument); any trip, e-stop or refused command aborts the sequence and leaves the safe state.'), grid(field('Protocol', prot), field('Time scale (simulated instrument)', scale, '1 = real time')), row(btn('▶ Run sequence', () => runSeq(), 'primary'), btn('■ Abort', () => session.seq?.abort('operator'))), seqBox));
  // faults (simulated only)
  const fBox = h('div'); el.append(card('Interlock test (simulated instrument only)', note('Inject faults into the simulated instrument to prove that the interlocks trip, acquisition stops and the safe state is commanded. Not available for real hardware.'), fBox));
  const live = h('div'), logBox = h('div'); el.append(card('Live channels', live), card('Event log', logBox));
  const strip = liveStrip(live, { height: 220, span: 15 });
  strip.bind(() => { const a = session.acq; if (!a) return { t: [], channels: {} }; const ch = {}; for (const [k, v] of Object.entries(a.data.channels)) if (k !== 't_s') ch[k] = v; return { t: a.data.t, channels: ch }; });
  const lis = () => strip.request();
  const ensureSim = () => { if (session.source) return; session.source = simulatedSource({ design: d, rateHz: 20 }); sf.source = session.source; session.acq = new Acquisition({ source: session.source, safety: sf }); session.acq.listeners.add(lis); logEvent(store, 'connect', session.source.label); upd(); };
  function upd() {
    const s = session.source, col = { disarmed: '#475569', armed: '#15803d', tripped: '#b45309', estop: '#b91c1c' }[sf.state];
    big.innerHTML = ''; big.append(h('div', { style: `padding:12px 20px;border-radius:12px;background:${col};color:#fff;font-weight:800;font-size:20px;letter-spacing:.05em` }, sf.state.toUpperCase()), h('div', { class: 'small' }, sf.operator ? `Operator: ${sf.operator}` : 'No operator', h('br'), `Source: ${s ? s.label : 'none'}`, h('br'), `Acquisition: ${session.acq?.running ? 'running' : 'stopped'}`), estop);
    srcBox.innerHTML = '';
    if (!s) srcBox.append(callout('warn', 'No source connected. Real hardware is connected in workspace 5; here only the simulated instrument can be attached, so sequences are rehearsed safely.'), row(btn('Attach simulated instrument', () => ensureSim(), 'primary')));
    else srcBox.append(callout(s.real ? 'ok' : 'warn', s.real ? `Real hardware: ${s.label}. Commands will move physical equipment once armed.` : `${s.label}. Commands act on the model only.`), row(btn(session.acq?.running ? 'Acquisition running' : '● Start acquisition / monitoring', () => { if (['tripped', 'estop'].includes(sf.state)) return toast('Reset the interlock first.', 'fail'); session.acq?.listeners.add(lis); session.acq?.start(); upd(); }), btn('💾 Save buffer as dataset', () => { if (!session.acq?.data.t.length) return toast('Nothing recorded.', 'warn'); saveDataset(session.acq.toDataset(`Control-session record ${new Date().toLocaleString()}`, { protocolId: prot.value || null, version: window.TX_VERSION || '' }), { protocol: prot.value ? getRecord(store, 'protocols', prot.value) : null }); })));
    fBox.innerHTML = '';
    if (s && !s.real) fBox.append(row(...[['Over-temperature', 'FAULT overtemp'], ['Over-force', 'FAULT overforce'], ['Stale data (link loss)', 'FAULT stale'], ['Clear fault / resume', 'RESUME']].map(([l, c]) => btn(l, async () => { if (!session.acq?.running && c !== 'RESUME') { session.acq.start(); } await s.write(c); if (c === 'RESUME') await s.write('FAULT none'); logEvent(store, 'fault-injection', c); upd(); }))));
    else fBox.append(note(s ? 'Fault injection is disabled for real hardware.' : 'Attach the simulated instrument first.'));
    logBox.innerHTML = ''; const ev = [...sf.log.map(e => [e.t, 'safety', e.type, e.msg]), ...(session.seqLog || []).map(e => [e.t, 'sequence', e.type, e.msg])].sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, 80);
    logBox.append(ev.length ? table(['Time', 'Source', 'Type', 'Message'], ev.map(e => [new Date(e[0]).toLocaleTimeString(), e[1], e[2], e[3]])) : note('No events yet.'));
  }
  async function runSeq() {
    const p = getRecord(store, 'protocols', prot.value); if (!p) return toast('Choose a protocol (workspace 1).', 'warn');
    if (!session.source) ensureSim();
    if (sf.state !== 'armed') return toast('Arm the system first (operator, confirmation, limits).', 'fail');
    if (session.source.real && !confirm(`Run protocol ${p.id} on REAL hardware (${session.source.label})? Independent hardware interlocks must be active.`)) return;
    if (!session.acq.running) session.acq.start();
    session.seqLog ||= []; const lg = (type, msg) => { session.seqLog.push({ t: new Date().toISOString(), type, msg }); upd(); };
    session.seq = new Sequencer({ steps: p.steps, safety: sf, acq: session.acq, timeScale: session.source.real ? 1 : Math.max(0.001, +scale.value || 0.02), onEvent: (e) => { if (e.type === 'step') { lg('step', `${e.i + 1}/${p.steps.length}: ${e.step.label}`); drawSteps(p, e.i); } else lg(e.type, e.why || e.msg || ''); } });
    logEvent(store, 'sequence', `protocol ${p.id} started by ${sf.operator} on ${session.source.label}`);
    const r = await session.seq.run(); logEvent(store, 'sequence', `protocol ${p.id} ${r}`); toast(`Sequence ${r}`, r === 'done' ? 'ok' : 'warn'); drawSteps(p, -1);
  }
  function drawSteps(p, cur) { seqBox.innerHTML = ''; seqBox.append(table(['#', 'Op', 'Setpoint', 'Duration', 'Instruction'], p.steps.map((s, i) => [i === cur ? h('b', {}, `▶ ${i + 1}`) : i + 1, s.op, s.channel ? `${s.channel} = ${s.value}` : '', s.duration_s ? `${s.duration_s} s` : '', s.label]))); }
  prot.onchange = () => { const p = getRecord(store, 'protocols', prot.value); if (p) drawSteps(p, -1); }; prot.onchange();
  const unsub = (() => { const fn = () => upd(); session.listeners.add(fn); return () => session.listeners.delete(fn); })();
  if (session.acq) session.acq.listeners.add(lis);
  const tick = setInterval(upd, 1500); upd();
  return { dispose() { clearInterval(tick); unsub(); session.acq?.listeners.delete(lis); strip.destroy(); sf.onState = null; } };
}
