import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceCoordinator, DEFAULT_VOICE_CONFIG } from '../dist/voice-session.js';
import { nativeAsrFactory } from '../dist/shared/native-asr.js';
import { NativeRuntime } from '../dist/shared/native-runtime.js';
import { loadConfig } from '../dist/env.js';
const tick = () => new Promise(r => setImmediate(r));
function fixture(t) {
  let resolveSource; const log = []; let bytes = 0, delivered = 0;
  const c = new VoiceCoordinator({
    audioSource: () => '', setAudioSource: id => id ? new Promise(r => { resolveSource = r; }) : Promise.resolve({ ok: 1, source: '' }),
    meetingCreate: async () => { log.push('create'); return 1; }, meetingDestroy: async () => { log.push('destroy'); return 1; },
    isOnline: () => true, generationOf: () => 1, defaultDevice: () => 'd', checkVoice: () => ({ allowed: true }),
  }, (events, init) => ({ id: 'fake', supportsPreview: true, begin() { log.push('begin'); }, writePcm(b) { bytes += b.length; },
    finishInput() { events.segmentFinal('test', init); events.terminal({ ok: true }, init); }, cancel() {} }),
  { available: true, id: 'fake', async deliver() { delivered++; return { outcome: 'submitted' }; } }, DEFAULT_VOICE_CONFIG);
  t.after(() => c.shutdown());
  return { c, log, source: () => resolveSource({ ok: 1, source: 'd' }), bytes: () => bytes, delivered: () => delivered };
}
test('runtime voice health never reports readiness before native start completes', async t => {
  const c=new EventEmitter();c.epoch='readiness';let resolve;
  c.request=async()=>new Promise(r=>{resolve=r;});
  const runtime=new NativeRuntime(c,{plugins:[{id:'typer'}],unavailable:[]},loadConfig({UMSDK_VOICE_UI:'0',UMSDK_SLEEP_RESET_ENABLED:'0'}));
  t.after(()=>runtime.stop());
  assert.equal(runtime.voiceHealth.runtimeReady,false);assert.equal(runtime.voiceHealth.typer.available,false);
  const pending=runtime.start();assert.equal(runtime.voiceHealth.runtimeReady,false);
  resolve({version:'fake',devices:[]});await pending;
  assert.equal(runtime.voiceHealth.runtimeReady,true);assert.equal(runtime.voiceHealth.typer.available,true);
  await runtime.stop();assert.equal(runtime.voiceHealth.runtimeReady,false);
});

test('async voice: cancel while source RPC pending prevents late microphone create', async t => {
  const f = fixture(t); const pending = f.c.voiceStart({}); const id = f.c.current.sessionId;
  await f.c.voiceCancel(id); f.source(); assert.equal((await pending).ok, false); assert.deepEqual(f.log, []);
});
test('async voice: PTT release and PCM drain during source RPC are replayed in order once', async t => {
  const f = fixture(t); f.c.onSpeechKey('d', 'down');
  f.c.onPcm('d', Buffer.alloc(320)); f.c.onSpeechKey('d', 'up'); f.c.onAudioSegmentComplete('d', 1, 'key-up');
  assert.equal(f.delivered(), 0); f.source(); await tick();
  assert.equal(f.bytes(), 320); assert.equal(f.delivered(), 1); assert.equal(f.c.current, null);
});
test('async voice: PTT cancelled during source preparation never begins ASR or types', async t => {
  const f = fixture(t); f.c.onSpeechKey('d', 'down'); await f.c.voiceCancel(f.c.current.sessionId);
  f.c.onSpeechKey('d', 'up'); f.c.onAudioSegmentComplete('d', 1, 'key-up'); f.source(); await tick();
  assert.equal(f.delivered(), 0); assert.deepEqual(f.log, []); assert.equal(f.c.current, null);
});
test('native ASR: pending begin cancellation cannot create a new handle later', async () => {
  const c = new EventEmitter(); const calls = []; c.request = async (...args) => { calls.push(args); return { code: 0 }; };
  const factory = nativeAsrFactory(c, { list: [{ type: 'xunfei_cn' }] });
  const p = factory({ terminal() {} }, { sessionId: 's', deviceId: 'd' });
  p.begin(); p.cancel(); await tick(); assert.deepEqual(calls, []);
});
test('native ASR: bounded PCM queue, session filtering, verified preview capability only', async () => {
  const c = new EventEmitter(); const calls = []; c.request = async (...args) => { calls.push(args); return { code: 0 }; };
  const outcomes = [], previews = [];
  const factory = nativeAsrFactory(c, { list: [{ type: 'deepgram' }] });
  const p = factory({ terminal: r => outcomes.push(r), preview: s => previews.push(s) }, { sessionId: 's', deviceId: 'd' });
  assert.equal(p.supportsPreview, false); p.begin(); await tick();
  c.emit('event', { plugin: 'asr', event: { sessionId: 'other', type: 'state', state: 4 } }); assert.equal(outcomes.length, 0);
  c.emit('event', { plugin: 'asr', event: { sessionId: 's', type: 'preview', text: 'unverified' } }); assert.equal(previews.length, 0);
  p.writePcm(Buffer.alloc(2 * 1024 * 1024 + 1)); await tick(); assert.equal(outcomes[0].error, 'asr_backpressure');
  assert.ok(calls.some(x => x[1] === 'dispose'));
});

test('native ASR: FINISHED while PCM is pending cannot accept a merely queued finish', async () => {
  const c = new EventEmitter(); const calls = []; let appendResolve; const outcomes = [];
  c.request = async (_, op) => { calls.push(op); if (op === 'append') return new Promise(r => { appendResolve = r; }); return { code: 0 }; };
  const p = nativeAsrFactory(c, { list: [{ type: 'xunfei_cn' }] })({ terminal: r => outcomes.push(r) }, { sessionId: 's', deviceId: 'd' });
  p.begin(); await tick(); p.writePcm(Buffer.alloc(32)); p.finishInput(); await tick();
  c.emit('event', { plugin: 'asr', event: { sessionId: 's', type: 'state', state: 4 } });
  assert.equal(outcomes[0].error, 'asr_ended_before_input');
  appendResolve({ code: 0 }); await tick();
  assert.equal(calls.includes('finish'), false); assert.equal(calls.at(-1), 'dispose');
});

test('native ASR: synchronous FINISHED waits for stop return and rejects a failed stop', async () => {
  for (const code of [0, 1]) {
    const c = new EventEmitter(); let finishResolve; const outcomes = [], segments = [];
    c.request = async (_, op) => {
      if (op === 'finish') {
        for (const text of ['第一句。', '第二句。']) c.emit('event', { plugin: 'asr', event: { sessionId: 's', type: 'final', text } });
        c.emit('event', { plugin: 'asr', event: { sessionId: 's', type: 'state', state: 4 } });
        return new Promise(r => { finishResolve = r; });
      }
      return { code: 0 };
    };
    const p = nativeAsrFactory(c, { list: [{ type: 'xunfei_cn' }] })({ terminal: r => outcomes.push(r), segmentFinal: text => segments.push(text) }, { sessionId: 's', deviceId: 'd' });
    p.begin(); await tick(); p.finishInput(); await tick(); assert.equal(outcomes.length, 0);
    finishResolve({ code }); await tick(); assert.equal(outcomes.length, 1); assert.equal(outcomes[0].ok, code === 0);
    assert.deepEqual(segments, ['第一句。', '第二句。']);
  }
});
test('runtime: owner disconnect during preparation cancels before native meeting; other owner cannot read its session', async () => {
  const c = new EventEmitter(); c.epoch = 'test'; let sourceResolve; const calls = [];
  c.request = async (plugin, op, args) => {
    calls.push(op);
    if (op === 'start') return { version: 'fake', devices: [{ id: 'd', mode: 0 }] };
    if (op === 'audio.source' && args.deviceId) return new Promise(r => { sourceResolve = r; });
    return { source: '', sent: 1 };
  };
  const cfg = loadConfig({ UMSDK_VOICE_ENABLED: '1', UMSDK_VOICE_UI: '0', UMSDK_VOICE_TYPER: '0', UMSDK_ASR_PROVIDER: 'windows-speech', UMSDK_SLEEP_RESET_ENABLED: '0' });
  // The fake batch provider is never begun: cancellation wins before source readiness.
  const runtime = new NativeRuntime(c, { plugins: [], unavailable: [] }, cfg);
  await runtime.start(); const pending = runtime.voiceStart('a', {}); const id = runtime.voice.current?.sessionId;
  assert.ok(id); assert.throws(() => runtime.ownedSession('b', id), /session_not_found/);
  await runtime.releaseOwner('a'); sourceResolve({ source: 'd' }); assert.equal((await pending).ok, false);
  assert.equal(calls.includes('meeting.create'), false); await runtime.stop();
});

// Module-isolation regressions use an in-memory native client only. They never
// load vendor DLLs, open a real microphone, call a cloud ASR, or send OS input.
async function isolatedRuntime(t, { marker = false, typer = true, typerPlugin = true, nativeQuarantine } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-isolation-fake-'));
  const safetyFile = path.join(directory, 'shared-v2', 'input-uncertain.json');
  if (marker) {
    fs.mkdirSync(path.dirname(safetyFile), { recursive: true });
    fs.writeFileSync(safetyFile, JSON.stringify({ owner: 'old-connection', reason: 'native_input_uncertain', epoch: 'old-worker' }));
  }
  const engines = path.join(directory, 'fake-asr-engines.json');
  fs.writeFileSync(engines, JSON.stringify({ list: [{ type: 'xunfei_cn' }] }));
  const client = new EventEmitter(); client.epoch = 'fake-worker';
  const calls = [], updates = [];
  const fixture = { client, calls, updates, directory, safetyFile, finalText: '离线语音模块测试', sequenceResult: {outcome:'completed',transport:{attempted:1,written:1,writeFailed:0},cleanup:'not_needed',effectConfirmed:false}, segment: 0 };
  client.request = async (plugin, operation, args, signal) => {
    calls.push({ plugin, operation, args, signal });
    if (plugin === 'umouse' && operation === 'start') return { version: 'fake-only', devices: [{ id: 'fake-mouse', mode: 0, generation: 1 }], inputQuarantine: nativeQuarantine };
    if (plugin === 'umouse' && operation === 'audio.source') return { source: args.deviceId };
    if (plugin === 'umouse' && operation === 'input.sequence') return fixture.sequenceResult;
    if (plugin === 'umouse' && operation === 'meeting.create') {
      setImmediate(() => { fixture.message({ type: 'meetingCreated' }); fixture.pcm(); });
      return { sent: 1 };
    }
    if (plugin === 'umouse' && operation === 'meeting.destroy') {
      fixture.message({ type: 'meetingDestroyed', origin: 'device-frame' });
      fixture.message({ type: 'audioSegmentComplete', segment: ++fixture.segment, reason: 'meeting-destroyed' });
      return { sent: 1 };
    }
    if (plugin === 'asr' && operation === 'finish') {
      client.emit('event', { plugin: 'asr', event: { type: 'final', sessionId: args.sessionId, text: fixture.finalText } });
      client.emit('event', { plugin: 'asr', event: { type: 'state', sessionId: args.sessionId, state: 4 } });
    }
    if (plugin === 'typer' && operation === 'text') return { submitted: true };
    return { code: 0 };
  };
  const cfg = loadConfig({ UMSDK_DATA_DIR: directory, UMSDK_SHARED_SAFETY_DIR: directory,
    UMSDK_VOICE: '1', UMSDK_VOICE_UI: '0', UMSDK_VOICE_TYPER: typer ? '1' : '0',
    UMSDK_ASR_PROVIDER: 'sinicloud', UMSDK_SLEEP_RESET_ENABLED: '0',
    UMSDK_INJECTION: '1', UMSDK_DEVICE_CAPS: JSON.stringify({ 'fake-mouse': { mouse_control: 'supported' } }) });
  fixture.runtime = new NativeRuntime(client, { plugins: [{ id: 'asr' }, ...(typerPlugin ? [{ id: 'typer' }] : [])], unavailable: [] }, cfg, () => {}, () => {}, undefined, nativeAsrFactory(client, { list: [{ type: 'xunfei_cn' }] }));
  fixture.runtime.voice.on('update', (session, change) => updates.push({ sessionId: session.sessionId, state: session.state, preview: session.preview, change }));
  fixture.message = message => client.emit('event', { plugin: 'umouse', event: { type: 'message', deviceId: 'fake-mouse', message } });
  fixture.key = action => fixture.message({ type: 'keyEvent', key: 'speech', action });
  fixture.pcm = () => client.emit('event', { plugin: 'umouse', event: { type: 'audio', deviceId: 'fake-mouse' }, binaryHex: '0000010002000300' });
  fixture.typings = () => calls.filter(c => c.plugin === 'typer' && c.operation === 'text');
  fixture.sequence = () => fixture.runtime.input.runSequence('fake-input-owner', {
    control_id: fixture.control.control_id, pid: 1, window_id: '1', device_id: 'fake-mouse', client_request_id: 'fake-sequence', frames: [{ kind: 'mouse', dx: 1 }],
  }, new AbortController().signal);
  fixture.dictate = async () => {
    fixture.key('down'); await tick();
    const session = fixture.runtime.voice.current; assert.ok(session, 'physical key must open a session');
    fixture.pcm();
    client.emit('event', { plugin: 'asr', event: { type: 'preview', sessionId: session.sessionId, text: '离线预览' } });
    assert.equal(fixture.runtime.voice.session(session.sessionId).preview, '离线预览');
    fixture.key('up'); fixture.message({ type: 'audioSegmentComplete', segment: ++fixture.segment, reason: 'key-up' });
    await tick(); await tick();
    return fixture.runtime.voice.session(session.sessionId);
  };
  t.after(async () => { await fixture.runtime.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await fixture.runtime.start();
  fixture.control=fixture.runtime.input.beginControl('fake-input-owner','voice-isolation');
  return fixture;
}
const uncertainSequence = () => ({ outcome: 'indeterminate', transport: { attempted: 1, written: 1, writeFailed: 0 }, cleanup: 'release_unconfirmed', effectConfirmed: false });

test('voice-only cleanup cannot end a hardware control task',async t=>{
  const f=await isolatedRuntime(t);
  await f.runtime.voiceStart('fake-input-owner',{endMode:'manual_only'});
  await f.runtime.releaseVoiceOwner('fake-input-owner');
  assert.equal(f.runtime.input.control.status('fake-input-owner').control_id,f.control.control_id);
  assert.equal(f.runtime.voice.current,null);
  await f.runtime.releaseOwner('fake-input-owner');assert.equal(f.runtime.input.control.status('fake-input-owner').active,false);
});

test('fake runtime isolation: persisted hardware uncertainty does not block PTT preview or typing and is not cleared', async t => {
  const f = await isolatedRuntime(t, { marker: true }), before = fs.readFileSync(f.safetyFile, 'utf8');
  assert.equal(f.runtime.input.hasUncertainty, true);
  const session = await f.dictate();
  assert.equal(session.state, 'delivered'); assert.equal(session.pcmBytes, 8);
  assert.ok(f.updates.some(u => u.state === 'ptt-capturing'));
  assert.equal(f.typings().length, 1); assert.equal(f.typings()[0].args.deliveryAuthorized, true);
  assert.equal(f.typings()[0].args.operationId, session.sessionId);
  assert.equal(f.typings()[0].args.text, f.finalText);
  assert.equal(fs.readFileSync(f.safetyFile, 'utf8'), before);
  await f.sequence();
  assert.equal(f.calls.filter(c => c.operation === 'input.sequence').length, 1);
  // A late ASR terminal or duplicated release cannot replay submitted text.
  f.key('up'); f.message({ type: 'audioSegmentComplete', segment: 1, reason: 'key-up' });
  f.client.emit('event', { plugin: 'asr', event: { type: 'state', sessionId: session.sessionId, state: 4 } });
  await tick(); assert.equal(f.typings().length, 1);
  const ledger = fs.readFileSync(path.join(f.directory, 'shared-v2', 'delivery', 'deliveries.jsonl'), 'utf8');
  assert.equal(JSON.parse(ledger.trim()).outcome, 'submitted'); assert.equal(ledger.includes(f.finalText), false);
});

test('fake runtime isolation: current hardware unknown result releases the per-action lease but retains task ownership and diagnosis', async t => {
  const f = await isolatedRuntime(t); f.sequenceResult = uncertainSequence();
  assert.equal((await f.sequence()).outcome, 'indeterminate'); assert.equal(f.runtime.input.hasUncertainty, true);
  const before = fs.readFileSync(f.safetyFile, 'utf8');
  assert.equal((await f.dictate()).state, 'delivered'); assert.equal(f.typings().length, 1);
  assert.equal(fs.readFileSync(f.safetyFile, 'utf8'), before);
  assert.equal(f.calls.filter(c => c.operation === 'input.sequence').length, 1, 'no automatic replay');
  await f.sequence();
  assert.equal(f.calls.filter(c => c.operation === 'input.sequence').length, 2, 'fresh explicit input is permitted');
  assert.equal(f.runtime.input.control.status('fake-input-owner').active,true);
});

test('fake runtime isolation: native-only mouse quarantine is reflected before input and still permits physical dictation', async t => {
  const f = await isolatedRuntime(t, { nativeQuarantine: { mouse: true, keyboard: false, persistenceHealthy: true } });
  assert.equal(fs.existsSync(f.safetyFile), false);
  assert.equal(f.runtime.input.hasUncertainty, true); assert.deepEqual(f.runtime.input.uncertainScopes, { mouse: true, keyboard: false });
  await f.sequence();
  assert.equal(f.calls.filter(c => c.operation === 'input.sequence').length, 1);
  assert.equal((await f.dictate()).state, 'delivered'); assert.equal(f.typings().length, 1);
});

test('fake runtime isolation: active desktop operation still arbitrates typing, with no later automatic retry', async t => {
  const f = await isolatedRuntime(t); let finishSequence;
  f.sequenceResult = new Promise(resolve => { finishSequence = resolve; });
  const sequence = f.sequence(); await tick();
  try {
    const blocked = await f.dictate();
    assert.equal(blocked.state, 'ready'); assert.match(blocked.error, /desktop_busy/); assert.equal(f.typings().length, 0);
  } finally { finishSequence(uncertainSequence()); await sequence; }
  await tick();
  assert.equal(f.typings().length, 0, 'releasing desktop must not replay a rejected dictation');
  assert.equal((await f.dictate()).state, 'delivered'); assert.equal(f.typings().length, 1);
});

test('fake runtime isolation: independent typer switch, missing plugin, text validation and shutdown still gate delivery', async t => {
  for (const options of [{ typer: false }, { typerPlugin: false }, { invalidText: true }]) {
    await t.test(JSON.stringify(options), async t => {
      const f = await isolatedRuntime(t, { marker: true, ...options });
      if (options.invalidText) f.finalText = 'invalid\u0001text';
      const session = await f.dictate();
      assert.notEqual(session.state, 'delivered'); assert.equal(f.typings().length, 0);
      await f.runtime.stop(); f.key('down'); await tick();
      assert.equal(f.runtime.voice.current, null); assert.equal(f.typings().length, 0);
    });
  }
});

test('fake runtime isolation: agent microphone opens with a hardware marker; health exposes capabilities without session content', async t => {
  const f = await isolatedRuntime(t, { marker: true });
  const started = await f.runtime.voiceStart('agent-owner', { prompt: 'private-prompt', endMode: 'manual_only' });
  assert.equal(started.ok, true); assert.equal(started.state, 'listening');
  assert.deepEqual(f.runtime.voiceHealth, { enabled: true, runtimeReady: true, asrAvailable: true,
    typer: { available: true, blockedByHardwareInput: false }, ui: { enabled: false, available: false } });
  assert.equal(JSON.stringify(f.runtime.voiceHealth).includes(started.sessionId), false);
  assert.equal(JSON.stringify(f.runtime.voiceHealth).includes('private-prompt'), false);
  await f.runtime.releaseOwner('agent-owner'); assert.equal(f.typings().length, 0);
  await f.runtime.stop(); assert.equal(f.runtime.voiceHealth.asrAvailable, false);
  assert.equal(f.runtime.voiceHealth.typer.available, false);
});
