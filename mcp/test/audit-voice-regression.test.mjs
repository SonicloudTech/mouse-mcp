// Independent audit assertions: expected product behavior, not expected bugs.
// No real SDK, microphone, network, mouse, keyboard or typer input is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCoordinator, DEFAULT_VOICE_CONFIG } from '../dist/voice-session.js';
import { EnergyVad } from '../dist/voice-vad.js';
import { loadConfig } from '../dist/env.js';
import { DeviceCapabilityRegistry } from '../dist/device-capabilities.js';
import { CapabilityGate } from '../dist/capability-gate.js';
import { computeVisibility } from '../dist/tool-capabilities.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function fixture(t, options = {}) {
  const asrs = [], delivered = [], events = [];
  const host = {
    creates: 0, destroys: 0, source: '',
    meetingCreate() { this.creates++; return 1; },
    meetingDestroy() { this.destroys++; return 1; },
    setAudioSource(id) { this.source = id ?? ''; return { ok: 1, source: this.source }; },
    audioSource() { return this.source; },
    isOnline() { return true; }, generationOf() { return 1; },
    defaultDevice() { return 'd'; }, checkVoice() { return { allowed: true }; },
  };
  const factory = (callbacks, init) => {
    if (options.throwFactory) throw new Error('synthetic DLL load failure');
    const a = { bytes: 0, finish: 0, cancel: 0, callbacks, init };
    asrs.push(a);
    a.complete = (text = 'test') => {
      callbacks.segmentFinal?.(text, { sessionId: init.sessionId });
      callbacks.terminal({ ok: true }, { sessionId: init.sessionId });
    };
    return {
      id: 'fake', supportsPreview: true,
      begin() { if (options.failBegin) callbacks.terminal({ ok: false, error: 'engine config rejected' }, { sessionId: init.sessionId }); },
      writePcm(buf) { a.bytes += buf.length; }, finishInput() { a.finish++; },
      cancel() { a.cancel++; },
    };
  };
  const c = new VoiceCoordinator(host, factory, {
    available: true, id: 'fake-typer', async deliver(req) { delivered.push(req); return { outcome: 'submitted' }; },
  }, { ...DEFAULT_VOICE_CONFIG, createConfirmWaitMs: 100, pcmReadyWaitMs: 150,
    drainWaitMs: 100, closeConfirmWaitMs: 100, asrFinalWaitMs: 200,
    closeUnconfirmedIsolationMs: 100, ...options.config },
  (type, payload) => events.push({ type, payload }), options.vad ?? null);
  t.after(() => {
    c.provider?.cancel();
    c.clearTimers();
    for (const timer of c.closeTimers.values()) clearTimeout(timer);
    c.closeTimers.clear();
    // Test cleanup only: release pending open promises without touching a device.
    if (c.active) c.onDeviceDisconnected('d');
  });
  const listen = async (extra = {}) => {
    const p = c.voiceStart({ deviceId: 'd', endMode: 'manual_only', ...extra });
    c.onMeetingCreated('d'); c.onPcm('d', Buffer.alloc(320));
    return p;
  };
  const ptt = () => { c.onSpeechKey('d', 'down'); c.onPcm('d', Buffer.alloc(320)); return c.current.sessionId; };
  let segment = 0;
  const endPtt = () => { c.onSpeechKey('d', 'up'); c.onAudioSegmentComplete('d', ++segment, 'key-up'); };
  return { c, host, asrs, delivered, events, listen, ptt, endPtt };
}

test('A01 sinicloud is a valid startup provider, not a batch transcriber', () => {
  assert.doesNotThrow(() => loadConfig({ UMSDK_ASR_PROVIDER: 'sinicloud' }));
});

test('A02 key-up to segment-complete PCM tail must still reach ASR', t => {
  const { c, ptt, asrs } = fixture(t); ptt();
  c.onSpeechKey('d', 'up'); c.onPcm('d', Buffer.alloc(640));
  c.onAudioSegmentComplete('d', 1, 'key-up');
  assert.equal(asrs[0].bytes, 960, '320 body + 640 tail bytes');
});

test('A03 cancel during finalizing must prevent pending typing', async t => {
  const { c, ptt, endPtt, asrs, delivered } = fixture(t);
  const id = ptt(); endPtt();
  await c.voiceCancel(id); asrs[0].complete('must not type'); await sleep(0);
  assert.equal(delivered.length, 0);
});

test('A04 cancelling held PTT must cancel provider resources', async t => {
  const { c, ptt, asrs } = fixture(t); const id = ptt();
  await c.voiceCancel(id);
  assert.equal(asrs[0].cancel, 1);
});

test('A05 disconnect must cancel provider resources', t => {
  const { c, ptt, asrs } = fixture(t); ptt(); c.onDeviceDisconnected('d');
  assert.equal(asrs[0].cancel, 1);
});

test('A06 shutdown while ASR is finalizing must prevent later typing', async t => {
  const { c, ptt, endPtt, asrs, delivered } = fixture(t); ptt(); endPtt();
  await c.shutdown(); asrs[0].complete('post-shutdown text'); await sleep(0);
  assert.equal(delivered.length, 0);
});

test('A07 synchronous ASR begin failure must not report listening', async t => {
  const { listen } = fixture(t, { failBegin: true });
  const r = await listen(); assert.equal(r.ok, false);
});

test('A08 ASR factory exception must release active session reservation', async t => {
  const { c } = fixture(t, { throwFactory: true });
  try { await c.voiceStart({ deviceId: 'd' }); } catch { /* actual failure is expected */ }
  assert.equal(c.current, null);
});

test('A09 PTT hard limit while key held must await key-up', t => {
  const { c, ptt } = fixture(t, { config: { maxDurationMs: 10 } }); ptt();
  assert.equal(c.current?.state, 'awaiting-key-up');
});

test('A10 meetingCreateFailed must isolate the unresolved microphone', async t => {
  const { c, host } = fixture(t);
  const p = c.voiceStart({ deviceId: 'd' }); c.onMeetingCreateFailed('d', 'confirm-timeout'); await p;
  const again = c.voiceStart({ deviceId: 'd' });
  const count = host.creates;
  if (c.current) c.onMeetingCreateFailed('d', 'test-cleanup');
  await again;
  assert.equal(count, 1, 'must reject a second create until physical close is confirmed');
});

test('A11 successful transcript cannot release ownership before close confirmation', async t => {
  const { c, listen, asrs, host } = fixture(t);
  const a = await listen(); await c.voiceFinish(a.sessionId);
  c.onAudioSegmentComplete('d', 1, 'meeting-destroyed'); asrs[0].complete();
  const again = c.voiceStart({ deviceId: 'd' }); const count = host.creates;
  if (c.current) c.onMeetingCreateFailed('d', 'test-cleanup'); await again;
  assert.equal(count, 1, 'close timer has not fired yet, but microphone is already unresolved');
});

test('A12 non-device destroyed event must not clear close isolation', async t => {
  const { c } = fixture(t);
  const p = c.voiceStart({ deviceId: 'd' }); await p; // no created/PCM => timeout isolation
  assert.equal(c.status().closeUnconfirmed.length, 1, 'test setup');
  c.onMeetingDestroyed('d', 'transport-down');
  assert.equal(c.status().closeUnconfirmed.length, 1);
});

test('A13 cancelled meeting with no device ACK must retain close isolation', async t => {
  const { c, listen } = fixture(t); const s = await listen();
  await c.voiceCancel(s.sessionId); await sleep(140);
  assert.equal(c.status().closeUnconfirmed.length, 1);
});

test('A14 stale segment serial must not complete a newer draining session', async t => {
  const { c, ptt, endPtt, asrs } = fixture(t);
  ptt(); endPtt(); asrs[0].complete(); await sleep(0);
  ptt(); c.onSpeechKey('d', 'up');
  c.onAudioSegmentComplete('d', 1, 'key-up'); // repeat previous segment, current should be 2
  assert.equal(asrs[1].finish, 0);
});

test('A15 VAD state must reset between Agent requests', async t => {
  const vad = new EnergyVad({ firstSpeechMs: 100000, onsetMs: 10, endSilenceMs: 50, energyThreshold: 0.02 });
  const { c, listen, asrs } = fixture(t, { vad });
  const a = await listen({ endMode: 'vad_or_manual' });
  const loud = Buffer.alloc(640); for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(10000, i);
  c.onPcm('d', loud); // first session spoke, manual stop before silence
  await c.voiceFinish(a.sessionId); c.onMeetingDestroyed('d', 'device-frame');
  c.onAudioSegmentComplete('d', 1, 'meeting-destroyed'); asrs[0].complete();
  await listen({ endMode: 'vad_or_manual' }); c.onPcm('d', Buffer.alloc(1600));
  assert.equal(c.current?.state, 'listening', 'second request has not spoken yet');
});

test('A16 streaming preview must preserve already committed segments', t => {
  const { c, ptt, asrs } = fixture(t); ptt();
  asrs[0].callbacks.segmentFinal('first.', { sessionId: asrs[0].init.sessionId });
  asrs[0].callbacks.preview('second', { sessionId: asrs[0].init.sessionId, revision: 1 });
  assert.equal(c.current.preview, 'first.second');
});

test('A17 clearing a test capability profile must revoke its current grant', () => {
  const registry = new DeviceCapabilityRegistry(); registry.onGenerationChange('d', 1);
  registry.setTestProfile('d', { mouse_control: 'supported' }); registry.setTestProfile('d', {});
  const gate = new CapabilityGate(registry);
  assert.equal(gate.check('d', 'mouse_control').allowed, false);
});

test('A18 keyboard-only device must retain emergency release tool', () => {
  const v = computeVisibility([{ name: 'umouse_key_release_all', capability: 'mouse_control' }], {
    online: [{ id: 'd' }], supportOf: (_, c) => c === 'keyboard_control' ? 'supported' : 'unsupported',
    software: { injectionEnabled: true, keyboardInjectionEnabled: true, rawDiagEnabled: false },
  });
  assert.equal(v.visible.has('umouse_key_release_all'), true);
});

test('A19 session lookup must not retain more than bounded history', async t => {
  const { c, ptt, endPtt, asrs } = fixture(t);
  for (let i = 0; i < 105; i++) { ptt(); endPtt(); asrs.at(-1).complete(); await sleep(0); assert.equal(c.history.at(-1).state, 'delivered'); }
  assert.equal(c.history.length, 100, 'test setup');
  assert.ok(c.byId.size <= 100, `byId retained ${c.byId.size} transcripts`);
});

test('A20 timed-out voiceWait must remove its waiter', async t => {
  const { c, listen } = fixture(t); const {sessionId: id} = await listen();
  await c.voiceWait(id, 100);
  assert.equal(c.waiters.get(id)?.size ?? 0, 0);
});

test('A21 PTT manual finish while key is held must await physical key-up', async t => {
  const { c, ptt } = fixture(t); const id = ptt(); await c.voiceFinish(id);
  assert.equal(c.current?.state, 'awaiting-key-up');
});

test('A22 device generation change without disconnect must reject late audio', t => {
  const { c, ptt, host, asrs } = fixture(t); ptt(); host.generationOf = () => 2;
  c.onPcm('d', Buffer.alloc(640));
  assert.equal(asrs[0].bytes, 320);
});

test('A23 Agent wait must not return cursor-dictation text', async t => {
  const { c, ptt, endPtt, asrs } = fixture(t); const id = ptt(); endPtt();
  asrs[0].complete('private target application text'); await sleep(0);
  const result = await c.voiceWait(id, 100);
  assert.equal(result.text, undefined);
});

test('A24 default voice status must redact dictation text and previews', async t => {
  const { c, ptt, endPtt, asrs } = fixture(t); ptt(); endPtt();
  asrs[0].complete('private target application text'); await sleep(0);
  assert.equal(JSON.stringify(c.status()).includes('private target application text'), false);
});

test('A25 opening deadline must be disarmed after listening is ready', async t => {
  const { c, listen } = fixture(t, { config: { createConfirmWaitMs: 20, pcmReadyWaitMs: 20 } });
  const r = await listen(); assert.equal(r.state, 'listening');
  await sleep(70);
  assert.equal(c.session(r.sessionId).state, 'listening', 'successful opening must not fail later on its old readiness timer');
});
