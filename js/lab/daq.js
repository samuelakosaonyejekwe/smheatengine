// Workspace 5 — instrumentation & real-time data acquisition: instrument register with calibration certificates and
// uncertainty; Web Serial / WebUSB / Web Bluetooth connection with a configurable line protocol, or the built-in simulated
// instrument; live streaming; recording to datasets ('measured' only for real hardware streams).
import { h, table, callout, toast, kpiGrid } from '../core/ui.js';
import { store } from '../core/state.js';
import { INSTRUMENT_TYPES, newInstrument, calStatus, addRecord, updateRecord, removeRecord, hwSupport, LineParser, connectSerial, connectUSB, connectBluetooth, simulatedSource, Safety, Acquisition, limitsFromDesign, HARDWARE_INTERLOCK_STATEMENT, getRecord, logEvent } from '../core/lab.js';
import { lab, card, grid, field, numIn, txtIn, selIn, btn, note, row, calBadge, liveStrip, session, saveDataset, protocolSelect, specimenSelect, explainList } from './common.js';

const PRESET_CH = [{ name: 't_s', index: 0, unit: 's', scale: 1, offset: 0 }, { name: 'T_spec_C', index: 1, unit: '°C', scale: 1, offset: 0 }, { name: 'T_fluid_C', index: 2, unit: '°C', scale: 1, offset: 0 }, { name: 'F_N', index: 3, unit: 'N', scale: 1, offset: 0 }, { name: 'x_mm', index: 4, unit: 'mm', scale: 1, offset: 0 }];

export async function render(el) {
  const d = store.project.engine, sup = hwSupport();
  el.append(card('Hardware support in this browser', h('div', { class: 'row gap wrap' }, ...[['Web Serial', sup.serial], ['WebUSB', sup.usb], ['Web Bluetooth', sup.bluetooth], ['Secure context', sup.secure]].map(([n, ok]) => h('span', { class: `badge ${ok ? 'ok' : 'warn'}` }, `${n}: ${ok ? 'available' : 'unavailable'}`))),
    sup.notes.length ? explainList(sup.notes) : note('All hardware interfaces are available. Connection always requires an explicit user gesture and device selection by the browser.'),
    callout('warn', h('b', {}, 'Mandatory: '), HARDWARE_INTERLOCK_STATEMENT)));
  // ---------------- instrument register
  const instBox = h('div'), typeSel = selIn(Object.entries(INSTRUMENT_TYPES).map(([k, t]) => [k, t.label]), 'loadcell');
  el.append(card('Instrument register & calibration', note('Each instrument carries its channel, standard uncertainty (absolute u and relative u_rel, combined in quadrature), certificate number and due date. Type-class defaults are estimates until a certificate value is entered. Expired calibrations are flagged and are reported in every run record.'), row(field('Instrument type', typeSel), btn('＋ Add instrument', () => { addRecord(store, 'instruments', newInstrument(typeSel.value)); drawInst(); }, 'primary'), btn('＋ Add first-demonstrator set', () => { for (const k of ['loadcell', 'lvdt', 'thermocouple', 'thermocouple', 'rtd', 'rtd', 'flowmeter', 'pressure', 'daq']) addRecord(store, 'instruments', newInstrument(k)); drawInst(); })), instBox));
  function drawInst() {
    instBox.innerHTML = ''; const I = lab().instruments; if (!I.length) { instBox.append(note('No instruments registered.')); return; }
    const inp = (i, k, type = 'text') => { const e = h('input', { type, value: i[k] ?? '', class: 'search', style: 'max-width:130px' }); e.onchange = () => { updateRecord(store, 'instruments', i.id, { [k]: type === 'number' ? +e.value : e.value, ...(k === 'u' || k === 'uRel' ? { uBasis: 'certificate / operator entry' } : {}) }); drawInst(); }; return e; };
    instBox.append(table(['ID', 'Instrument', 'Channel', 'Unit', 'u', 'u_rel', 'Serial', 'Certificate', 'Cal. date', 'Due', 'Status', ''], I.map(i => [i.id, i.name, inp(i, 'channel'), i.unit, inp(i, 'u', 'number'), inp(i, 'uRel', 'number'), inp(i, 'serial'), inp(i, 'cert'), inp(i, 'calDate', 'date'), inp(i, 'calDue', 'date'), calBadge(i), btn('✕', () => { removeRecord(store, 'instruments', i.id); drawInst(); }, 'sm')])));
    const bad = I.filter(i => calStatus(i).status !== 'valid'); if (bad.length) instBox.append(callout('warn', `${bad.length} instrument(s) without a valid certificate: data recorded with them cannot support validated claims until calibration is documented.`));
  }
  drawInst();
  // ---------------- connection
  const kind = selIn([['simulated', 'Simulated instrument (software testing)'], ['serial', 'Web Serial (USB-serial / RS-232 DAQ)'], ['usb', 'WebUSB (vendor bulk endpoint)'], ['bluetooth', 'Web Bluetooth (GATT notifications)']], session.source?.kind || 'simulated');
  const mode = selIn([['csv', 'CSV (columns by index)'], ['kv', 'key=value pairs'], ['regex', 'Regular expression'], ['json', 'JSON per line']], 'csv'), delim = txtIn(',', ''), regex = txtIn('', 'e.g. T:(?<T>[-\\d.]+) F:(?<F>[-\\d.]+)');
  const baud = numIn(115200, { step: 1 }), vid = txtIn('', 'vendorId hex (optional)'), svc = txtIn('', 'service UUID or 16-bit hex'), chr = txtIn('', 'notify characteristic'), wchr = txtIn('', 'write characteristic (optional)');
  const chRows = PRESET_CH.map(c => ({ ...c })), chBox = h('div');
  const drawCh = () => { chBox.innerHTML = ''; chBox.append(table(['Channel name', 'Index / key / group', 'Unit', 'Scale', 'Offset', ''], chRows.map((c, i) => { const mk = (k, w = 90) => { const e = h('input', { value: c[k] ?? '', class: 'search', style: `max-width:${w}px` }); e.onchange = () => { c[k] = ['scale', 'offset'].includes(k) ? +e.value : k === 'index' && /^\d+$/.test(e.value) ? +e.value : e.value; }; return e; }; return [mk('name', 120), mk('index'), mk('unit', 60), mk('scale', 80), mk('offset', 80), btn('✕', () => { chRows.splice(i, 1); drawCh(); }, 'sm')]; })), btn('＋ channel', () => { chRows.push({ name: 'ch' + chRows.length, index: chRows.length, unit: '', scale: 1, offset: 0 }); drawCh(); }, 'sm')); };
  drawCh();
  const status = h('div'), live = h('div'), kp = h('div');
  el.append(card('Connection & channel mapping', note('Name channels with a unit suffix (T_…_C, F_N, x_mm, dp_Pa, speed_rpm) so units, interlock limits and analysis mapping are recognised automatically. Scale and offset convert raw readings (e.g. volts) into engineering units: value = raw × scale + offset. A channel named t_s supplies the device timestamp; otherwise the browser clock is used.'),
    grid(field('Source', kind), field('Line format', mode), field('Delimiter (or “ws”)', delim), field('Regex', regex), field('Baud rate (serial)', baud), field('USB vendor filter', vid), field('BLE service', svc), field('BLE notify characteristic', chr), field('BLE write characteristic', wchr)), chBox,
    row(btn('🔌 Connect', () => connect(), 'primary'), btn('⏏ Disconnect', () => disconnect())), status));
  const prot = protocolSelect(''), spec = specimenSelect(''), name = txtIn(`Recording ${new Date().toLocaleString()}`);
  el.append(card('Live stream & recording', grid(field('Protocol', prot), field('Specimen', spec), field('Dataset name', name)),
    row(btn('● Start recording', () => startRec(), 'primary'), btn('■ Stop', () => { session.acq?.stop('operator'); upd(); }), btn('💾 Save recording as dataset', () => saveRec()), btn('⌫ Clear buffer', () => { session.acq?.clear(); strip.request(); })), kp, live));
  const strip = liveStrip(live, { height: 260, span: 20 });
  strip.bind(() => { const a = session.acq; if (!a) return { t: [], channels: {} }; const ch = {}; for (const [k, v] of Object.entries(a.data.channels)) if (k !== 't_s') ch[k] = v; return { t: a.data.t, channels: ch }; });
  const listener = () => { strip.request(); };
  const upd = () => {
    const s = session.source, a = session.acq, sf = session.safety; status.innerHTML = ''; kp.innerHTML = '';
    status.append(s ? callout(s.real ? 'ok' : 'warn', h('b', {}, s.real ? 'Connected to real hardware: ' : 'Simulated instrument: '), s.label, s.real ? ' — recordings are provenance “measured”.' : ' — recordings are provenance “hypothetical” (synthetic).') : note('Not connected.'));
    kp.append(kpiGrid([{ label: 'Samples', value: a?.n ?? 0, explain: 'Samples received in this recording.' }, { label: 'Recording', value: a?.running ? 'yes' : 'no', explain: a?.stopReason ? `Last stop: ${a.stopReason}` : 'Interlocks monitor every sample while recording.', status: a?.running ? 'ok' : undefined }, { label: 'Interlock state', value: sf?.state || '—', explain: 'Monitoring trips on limit violations even when disarmed; commands need an armed system (workspace 6).', status: sf?.state === 'tripped' || sf?.state === 'estop' ? 'bad' : 'ok' }]));
  };
  const ensureSafety = () => { if (!session.safety) session.safety = new Safety({ limits: limitsFromDesign(d), onTrip: (r) => { toast('Interlock trip: ' + r, 'fail', 9000); logEvent(store, 'trip', r); session.emit({ type: 'trip', reason: r }); upd(); } }); session.safety.source = session.source; };
  async function connect() {
    if (session.source) { toast('Already connected — disconnect first.', 'warn'); return; }
    const parser = new LineParser({ mode: mode.value, delimiter: delim.value || ',', regex: regex.value, channels: chRows.map(c => ({ name: c.name, unit: c.unit, scale: c.scale, offset: c.offset, ...(mode.value === 'csv' ? { index: +c.index } : mode.value === 'regex' ? { group: c.index } : { key: c.index }) })), timeChannel: chRows.some(c => c.name === 't_s') ? 't_s' : '' });
    try {
      if (kind.value === 'simulated') session.source = simulatedSource({ design: d, rateHz: 20 });
      else if (kind.value === 'serial') session.source = await connectSerial({ baudRate: +baud.value || 115200, parser });
      else if (kind.value === 'usb') session.source = await connectUSB({ filters: vid.value ? [{ vendorId: parseInt(vid.value, 16) }] : [], parser });
      else session.source = await connectBluetooth({ service: svc.value.trim(), characteristic: chr.value.trim(), writeCharacteristic: wchr.value.trim() || null, parser });
      ensureSafety(); session.acq = new Acquisition({ source: session.source, safety: session.safety }); session.acq.listeners.add(listener);
      logEvent(store, 'connect', session.source.label); toast('Connected: ' + session.source.label, session.source.real ? 'ok' : 'info'); session.emit({ type: 'connect' });
    } catch (e) { toast('Connection failed: ' + e.message, 'fail', 8000); }
    upd();
  }
  async function disconnect() { const { teardownSession } = await import('./common.js'); await teardownSession('operator disconnect'); upd(); }
  function startRec() { if (!session.acq) { toast('Connect a source first.', 'warn'); return; } if (session.safety && ['tripped', 'estop'].includes(session.safety.state)) { toast('Interlock tripped: reset it in workspace 6 before recording.', 'fail'); return; } session.acq.listeners.add(listener); session.acq.start(); upd(); }
  function saveRec() {
    const a = session.acq; if (!a || !a.data.t.length) { toast('Nothing recorded.', 'warn'); return; }
    const p = prot.value ? getRecord(store, 'protocols', prot.value) : null, sp = spec.value ? getRecord(store, 'specimens', spec.value) : null;
    const inst = lab().instruments.filter(i => chRows.some(c => c.name === i.channel) || ['daq'].includes(i.type));
    const ds = a.toDataset(name.value || 'Recording', { protocolId: p?.id, specimenId: sp?.id, instruments: inst, version: window.TX_VERSION || '' });
    if (ds.provenance === 'measured' && !inst.some(i => calStatus(i).status === 'valid')) ds.meta.calibrationWarning = 'No instrument with a valid certificate is mapped to these channels.';
    saveDataset(ds, { protocol: p, specimen: sp, instruments: inst });
  }
  const unsub = (() => { const fn = () => upd(); session.listeners.add(fn); return () => session.listeners.delete(fn); })();
  if (session.acq) session.acq.listeners.add(listener);
  const tick = setInterval(upd, 1000); upd();
  return { dispose() { clearInterval(tick); unsub(); session.acq?.listeners.delete(listener); strip.destroy(); } };
}
