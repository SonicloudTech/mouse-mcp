/*
 * voice-vad.test.mjs —— 本地 VAD（起声/静音/时限语义，能量回退实现）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EnergyVad, createVad, DEFAULT_VAD_CONFIG } from '../dist/voice-vad.js';
import { VoiceCoordinator, DEFAULT_VOICE_CONFIG } from '../dist/voice-session.js';

/** 合成帧：loud=true 正弦波（幅度 ~0.5），否则近静音 */
function frame(ms, loud) {
  const samples = Math.round((ms / 1000) * 16000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = loud ? Math.round(16000 * Math.sin(i / 8)) : 40;
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

test('A01 能量 VAD：起声累计→speech-start；静音→speech-end；静音 PCM 不触发句尾', () => {
  const vad = new EnergyVad({ ...DEFAULT_VAD_CONFIG, onsetMs: 150, endSilenceMs: 1100, firstSpeechMs: 10_000 });
  // 静音 500ms：不触发
  assert.equal(vad.writePcm(frame(500, false)), null);
  // 响 200ms（累计≥150ms）：起声
  const events = [];
  for (let i = 0; i < 4; i++) events.push(vad.writePcm(frame(50, true)));
  assert.ok(events.includes('speech-start'), '有效起声');
  // 继续响 → 无新事件
  assert.equal(vad.writePcm(frame(200, true)), null);
  // 静音累计 <1100ms：不结束
  assert.equal(vad.writePcm(frame(500, false)), null);
  // 静音到 1200ms：句尾
  assert.equal(vad.writePcm(frame(700, false)), 'speech-end');
});

test('A01 未起声超时：firstSpeechMs 到期 → no-speech-timeout（静音不误触发句尾计时）', () => {
  const vad = new EnergyVad({ ...DEFAULT_VAD_CONFIG, onsetMs: 150, endSilenceMs: 500, firstSpeechMs: 1000 });
  let now = 0;
  let event = null;
  for (let i = 0; i < 30 && !event; i++) {
    now += 50;
    event = vad.writePcm(frame(50, false), now);
  }
  assert.equal(event, 'no-speech-timeout');
});

test('createVad：none → null（manual_only）', () => {
  assert.equal(createVad('none'), null);
  assert.ok(createVad('energy'));
});

test('协调器集成：VAD speech-end 结束 agent 会话（vad_or_manual）；PTT 不接入 VAD', async () => {
  const events = [];
  const fast = { ...DEFAULT_VOICE_CONFIG, maxDurationMs: 60_000, pcmReadyWaitMs: 250, createConfirmWaitMs: 200, drainWaitMs: 200, closeConfirmWaitMs: 200, asrFinalWaitMs: 250, closeUnconfirmedIsolationMs: 150 };
  const host = {
    creates: [], destroys: [], sourceSets: [], source: '',
    meetingCreate(id) { this.creates.push(id); return 1; },
    meetingDestroy(id) { this.destroys.push(id); return 1; },
    setAudioSource(id) { this.sourceSets.push(id); this.source = id ?? ''; return { ok: 1, source: this.source }; },
    audioSource() { return this.source; },
    isOnline: () => true, generationOf: () => 1, defaultDevice: () => 'dev1',
    checkVoice: () => ({ allowed: true }),
  };
  const asrState = { events: null, sessionId: null };
  const asrFactory = (evts, init) => ({
    id: 'fake', supportsPreview: false,
    begin() { asrState.sessionId = init.sessionId; asrState.events = evts; },
    writePcm() {}, finishInput() {},
    cancel() { evts.terminal({ ok: false, cancelled: true }, { sessionId: init.sessionId }); },
  });
  const vad = new EnergyVad({ ...DEFAULT_VAD_CONFIG, onsetMs: 150, endSilenceMs: 500, firstSpeechMs: 10_000 });
  const coord = new VoiceCoordinator(host, asrFactory, { available: false, id: 'stub', async deliver() { return { outcome: 'unavailable', error: 'stub' }; } }, fast,
    (type, payload) => events.push({ type, payload }), vad);
  // agent 会话：created + 响声 PCM
  const p = coord.voiceStart({ deviceId: 'dev1', endMode: 'vad_or_manual' });
  coord.onMeetingCreated('dev1');
  coord.onPcm('dev1', frame(300, true));   // 起声
  const r = await p;
  assert.equal(r.state, 'listening');
  coord.onPcm('dev1', frame(600, false));  // 静音 ≥500ms → VAD 句尾
  const s = coord.current;
  assert.equal(s.state, 'stop-requested', 'VAD speech-end 结束采集');
  assert.equal(s.stopReason, 'vad');
  coord.onMeetingDestroyed('dev1', 'device-frame');
  coord.onAudioSegmentComplete('dev1', 1, 'meeting-destroyed');
  asrState.events.terminal({ ok: true }, { sessionId: asrState.sessionId });
  await new Promise((res) => setTimeout(res, 20));
  // PTT：VAD 存在也不截断（松键结束）
  vad.reset();
  coord.onSpeechKey('dev1', 'down');
  coord.onPcm('dev1', frame(300, true));
  coord.onPcm('dev1', frame(800, false)); // 静音超阈值——PTT 不应被截断
  assert.equal(coord.current.state, 'ptt-capturing', 'PTT 不因 VAD 截断');
  coord.onSpeechKey('dev1', 'up');
  coord.onAudioSegmentComplete('dev1', 2, 'key-up');
  await new Promise((res) => setTimeout(res, 20));
});
