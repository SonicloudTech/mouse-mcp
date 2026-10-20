/*
 * voice-session.test.mjs —— v2 VoiceCoordinator 会话编排
 * 纯合成：fake 宿主适配 + fake ASR provider（可控终态），不触设备/网络/DLL。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCoordinator, DEFAULT_VOICE_CONFIG } from '../dist/voice-session.js';

const FAST = {
  ...DEFAULT_VOICE_CONFIG,
  maxDurationMs: 60_000,
  pcmReadyWaitMs: 250,
  createConfirmWaitMs: 200,
  drainWaitMs: 200,
  closeConfirmWaitMs: 200,
  asrFinalWaitMs: 250,
  closeUnconfirmedIsolationMs: 150,
};

function fakeAsr() {
  const state = { begin: 0, bytes: 0, finishInput: 0, cancelled: 0, events: null, sessionId: null };
  const factory = (events, init) => ({
    id: 'fake',
    supportsPreview: true,
    begin() { state.begin += 1; state.sessionId = init.sessionId; state.events = events; },
    writePcm(chunk) { state.bytes += chunk.length; },
    finishInput() { state.finishInput += 1; },
    cancel() { state.cancelled += 1; events.terminal({ ok: false, cancelled: true }, { sessionId: init.sessionId }); },
  });
  /** 模拟引擎出字：分段 final + 终态 */
  const complete = (text) => {
    state.events?.segmentFinal?.(text, { sessionId: state.sessionId });
    state.events?.terminal({ ok: true }, { sessionId: state.sessionId });
  };
  return { factory, state, complete };
}

function fakeHost(devices = ['dev1']) {
  const h = {
    creates: [], destroys: [], sourceSets: [], source: '',
    online: new Set(devices),
    meetingsOk: true,
    meetingCreate(id) { h.creates.push(id); return h.meetingsOk ? 1 : 0; },
    meetingDestroy(id) { h.destroys.push(id); return 1; },
    setAudioSource(id) { h.sourceSets.push(id); h.source = id ?? ''; return { ok: 1, source: h.source }; },
    audioSource() { return h.source; },
    isOnline(id) { return h.online.has(id); },
    generationOf() { return 1; },
    defaultDevice() { return devices.length === 1 ? devices[0] : ''; },
    checkVoice() { return { allowed: true }; },
  };
  return h;
}

const typerStub = (outcome = 'unavailable') => ({
  available: outcome === 'submitted',
  id: 'stub',
  async deliver() { return outcome === 'submitted' ? { outcome: 'submitted' } : { outcome, error: 'stub' }; },
});

function makeCoord(host, asr, typerOutcome = 'unavailable', configOverride = {}) {
  const events = [];
  const coord = new VoiceCoordinator(host, asr.factory, typerStub(typerOutcome), { ...FAST, ...configOverride },
    (type, payload, deviceId) => events.push({ type, payload, deviceId }));
  return { coord, events };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startListening(coord, host, asr, { deviceId = 'dev1' } = {}) {
  const p = coord.voiceStart({ deviceId, endMode: 'manual_only' });
  const t = setTimeout(() => {
    host.online.has(deviceId) && coord.onMeetingCreated(deviceId);
    coord.onPcm(deviceId, Buffer.alloc(3200)); // 静音 PCM 也是就绪证据
  }, 20);
  const r = await p;
  clearTimeout(t);
  assert.equal(r.ok, true, `voiceStart 应就绪：${JSON.stringify(r)}`);
  return r;
}

test('S01 created 正常：就绪须同时有会议确认与 PCM；就绪前不可返回 listening', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr);
  const p = coord.voiceStart({ deviceId: 'dev1' });
  coord.onMeetingCreated('dev1');            // 只有 created，无 PCM
  await sleep(60);
  assert.equal(coord.current?.state, 'opening', '无 PCM 不进入 listening');
  coord.onPcm('dev1', Buffer.alloc(3200));
  const r = await p;
  assert.equal(r.state, 'listening');
  assert.equal(coord.current.meetingCreatedConfirmed, true);
  assert.equal(asr.state.begin, 1, 'ASR 会话已建立（边录边识别）');
  await coord.shutdown();
});

test('S01 created 丢失：create 超时 → 失败 + 清理责任（destroy 探测），不错误归入下一次', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr);
  const r = await coord.voiceStart({ deviceId: 'dev1' }); // 不喂事件
  assert.equal(r.ok, false);
  assert.equal(r.code, 'opening_timeout');
  assert.equal(host.destroys.length, 1, '对自己尝试开启的会议请求 destroy');
  assert.equal(coord.current, null, '失败收口，不占位');
  // 迟到 created 不再开启新采集
  coord.onMeetingCreated('dev1');
  await sleep(30);
  assert.equal(coord.current, null);
  await coord.shutdown();
});

test('S01 meetingCreateFailed 事件路径：SDK 3s 无 created 确认 → failed', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr);
  const p = coord.voiceStart({ deviceId: 'dev1' });
  await sleep(10);
  coord.onMeetingCreateFailed('dev1', 'confirm-timeout');
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'meeting_create_failed');
  assert.equal(coord.session(r.sessionId ?? '') === undefined || coord.current === null, true);
  await coord.shutdown();
});

test('S02 destroyed 正常：device-frame 确认收尾；重复 destroyed 幂等不重复终结', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr);
  const start = await startListening(coord, host, asr);
  const waited = coord.voiceWait(start.sessionId, 50);
  coord.voiceFinish(start.sessionId);                       // stop-requested → destroy
  assert.equal(host.destroys.length, 1);
  coord.onMeetingDestroyed('dev1', 'device-frame');         // 设备确认
  coord.onAudioSegmentComplete('dev1', 1, 'meeting-destroyed'); // 段边界
  asr.complete('最终回答文本');
  const result = await waited;
  assert.equal(result.state, 'ready');
  assert.equal(result.text, '最终回答文本');
  assert.equal(result.meetingDestroyedConfirmed, true);
  assert.equal(result.audioSegmentDrained, true);
  assert.equal(asr.state.finishInput, 1, 'finishInput 只在段边界后调用一次');
  // 重复 destroyed 帧不再影响已收口会话
  coord.onMeetingDestroyed('dev1', 'device-frame');
  assert.equal(coord.current, null);
});

test('S02 transport-down：异常结束≠关麦确认；设备失联收尾 failed', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr);
  const start = await startListening(coord, host, asr);
  coord.onMeetingDestroyed('dev1', 'transport-down');
  const s = coord.session(start.sessionId);
  assert.equal(s.state, 'failed');
  assert.equal(s.stopReason, 'transport-stall');
  await coord.shutdown();
});

test('S03 PTT key-up 尾部边界：段完成事件之后才 finishInput；最终文本经 typer 交付', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr, 'submitted');
  coord.onSpeechKey('dev1', 'down');
  const s = coord.current;
  assert.equal(s.destination, 'cursor-dictation');
  assert.equal(s.meetingCreatedConfirmed, 'not-applicable');
  assert.equal(host.creates.length, 0, 'PTT 不额外发 meetingCreate');
  coord.onPcm('dev1', Buffer.alloc(6400));
  coord.onSpeechKey('dev1', 'up');
  assert.equal(asr.state.finishInput, 0, 'key-up 后未到段边界，不结束识别输入');
  coord.onAudioSegmentComplete('dev1', 1, 'key-up');
  asr.complete('你好世界');
  await sleep(30);
  const done = coord.session(s.sessionId);
  assert.equal(done.state, 'delivered');
  assert.equal(done.finalText, '你好世界');
  assert.equal(done.delivery, 'submitted');
  assert.equal(asr.state.finishInput, 1);
});

test('S04 并发结束只有一次获胜：VAD/按钮/finish 同时到达', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr);
  const start = await startListening(coord, host, asr);
  await coord.voiceFinish(start.sessionId);   // 第一次获胜：done-button
  const s1 = coord.session(start.sessionId);
  assert.equal(s1.stopReason, 'done-button');
  await coord.voiceFinish(start.sessionId);   // 幂等：不重复收尾
  assert.equal(host.destroys.length, 1);
  coord.onMeetingDestroyed('dev1', 'device-frame');
  coord.onAudioSegmentComplete('dev1', 1, 'meeting-destroyed');
  asr.complete('文本');
  await sleep(30);
  assert.equal(coord.session(start.sessionId).state, 'ready');
  // 旧会话的迟到按钮/事件不影响新会话
  const start2 = await startListening(coord, host, asr);
  coord.onSpeechKey('dev1', 'up');            // 无 PTT 会话：仅事件
  assert.equal(coord.current?.state, 'listening', '旧按钮不影响新会话');
  await coord.shutdown();
});

test('S04 取消：阻止交付；取消等待≠设备已关麦', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr, 'submitted');
  const start = await startListening(coord, host, asr);
  await coord.voiceCancel(start.sessionId);
  const s = coord.session(start.sessionId);
  assert.ok(['cancelled', 'stop-requested'].includes(s.state));
  coord.onMeetingDestroyed('dev1', 'device-frame');
  coord.onAudioSegmentComplete('dev1', 1, 'meeting-destroyed');
  asr.complete('不应交付的文本');
  await sleep(30);
  const done = coord.session(start.sessionId);
  assert.equal(done.state, 'cancelled');
  assert.equal(done.finalText, undefined, '取消后无可消费结果');
});

test('S05 Agent 会议占用期间按物理语音键：只反馈忙碌，不另开听写', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord, events } = makeCoord(host, asr);
  const start = await startListening(coord, host, asr);
  coord.onSpeechKey('dev1', 'down');
  assert.equal(coord.current.sessionId, start.sessionId, '没有第二个会话');
  assert.equal(coord.current.destination, 'agent-reply');
  assert.ok(events.some((e) => e.type === 'voiceBusy'), '按键收到忙碌反馈');
  await coord.shutdown();
});

test('S06 PTT 按住时取消：进入 awaiting-key-up 隔离，不假报关麦；松键收口', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord, events } = makeCoord(host, asr);
  coord.onSpeechKey('dev1', 'down');
  const s = coord.current;
  coord.onPcm('dev1', Buffer.alloc(3200));
  await coord.voiceCancel(s.sessionId);
  assert.equal(coord.current.state, 'awaiting-key-up');
  assert.ok(events.some((e) => e.type === 'voiceKeyHoldIsolation'), '提示用户松键');
  // 隔离期间再按不开启新会话
  coord.onSpeechKey('dev1', 'down');
  assert.equal(coord.current.sessionId, s.sessionId);
  coord.onSpeechKey('dev1', 'up');
  assert.equal(coord.current.state, 'awaiting-key-up', 'must also await decode barrier');
  coord.onAudioSegmentComplete('dev1', 1, 'key-up');
  assert.equal(coord.session(s.sessionId).state, 'cancelled');
  assert.equal(coord.current, null);
});

test('S06 PTT 达到上限：自动收口（max-duration），按住期间不重复开会话', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr, 'submitted', { maxDurationMs: 60 });
  coord.onSpeechKey('dev1', 'down');
  const s = coord.current;
  coord.onPcm('dev1', Buffer.alloc(3200));
    // 100ms PCM already exceeds the configured 60ms; release before the bounded key-up watchdog.
  assert.equal(coord.current?.state, 'awaiting-key-up', '上限后等待物理松键');
  coord.onSpeechKey('dev1', 'up');
  coord.onAudioSegmentComplete('dev1', 1, 'key-up');
  asr.complete('上限内文本');
  await sleep(30);
    assert.equal(coord.session(s.sessionId).state, 'delivered', '到上限保留已采集音频，松键及完整边界后正常交付');
});

test('busy/close-unconfirmed：活动会话拒绝新 start；关麦未确认进入隔离', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr);
  const start = await startListening(coord, host, asr);
  const second = await coord.voiceStart({ deviceId: 'dev1' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'busy');
  // destroy 后 3s（FAST=200ms）无 device-frame 确认 → 隔离
  await coord.voiceFinish(start.sessionId);
  coord.onAudioSegmentComplete('dev1', 1, 'meeting-destroyed'); // 只有段边界，无 destroyed
  asr.complete('文本');
  await sleep(260); // closeConfirm 超时
  const st = coord.status();
  const s = coord.session(start.sessionId);
  assert.equal(s.meetingDestroyedConfirmed, false, '未确认关麦');
  assert.ok(Array.isArray(st.closeUnconfirmed) && st.closeUnconfirmed.length === 1, '隔离记录存在');
  const third = await coord.voiceStart({ deviceId: 'dev1' });
  assert.equal(third.ok, false);
  assert.equal(third.code, 'close_unconfirmed', '隔离期内禁止重开');
  await sleep(200); // 隔离期过
  coord.onMeetingDestroyed('dev1', 'device-frame'); // 迟到确认
  const fourth = await coord.voiceStart({ deviceId: 'dev1' });
  assert.equal(fourth.ok, false, ' isolation 过期后可重开——此断言只验证不再报 close_unconfirmed');
  assert.notEqual(fourth.code, 'close_unconfirmed');
  await coord.shutdown();
});

test('voiceWait pending/terminal 区分；client_request_id 幂等', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr);
  const p = coord.voiceStart({ deviceId: 'dev1', clientRequestId: 'req-1' });
  setTimeout(() => { coord.onMeetingCreated('dev1'); coord.onPcm('dev1', Buffer.alloc(3200)); }, 20);
  const r = await p;
  const pending = await coord.voiceWait(r.sessionId, 60);
  assert.equal(pending.pending, true);
  const again = await coord.voiceStart({ clientRequestId: 'req-1' });
  assert.equal(again.ok, true);
  assert.equal(again.sessionId, r.sessionId, '重复 request_id 返回同会话');
  assert.equal(host.creates.length, 1, '不重复开麦');
  await coord.shutdown();
});

test('no-speech：无音频内容 → no-speech 终态（不误报失败）', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr);
  const p = coord.voiceStart({ deviceId: 'dev1' });
  setTimeout(() => { coord.onMeetingCreated('dev1'); coord.onPcm('dev1', Buffer.alloc(3200)); }, 20);
  const r = await p;
  coord.onPcm('dev1', Buffer.alloc(3200));
  await coord.voiceFinish(r.sessionId);
  coord.onMeetingDestroyed('dev1', 'device-frame');
  coord.onAudioSegmentComplete('dev1', 1, 'meeting-destroyed');
  asr.complete('   '); // 空白文本
  await sleep(30);
  assert.equal(coord.session(r.sessionId).state, 'no-speech');
});

test('S07 旧会话的段完成/destroyed 不控制新会话（会话身份隔离）', async () => {
  const host = fakeHost();
  const asr = fakeAsr();
  const { coord } = makeCoord(host, asr);
  const a = await startListening(coord, host, asr);
  await coord.voiceCancel(a.sessionId);
  await sleep(220);
  assert.equal((await coord.voiceStart({ deviceId: 'dev1' })).code, 'close_unconfirmed');
  coord.onMeetingDestroyed('dev1', 'device-frame'); // physical evidence, not elapsed time
  coord.onAudioSegmentComplete('dev1', 1, 'meeting-destroyed');
  const b = await startListening(coord, host, asr);
  // 旧会话迟到的段完成（其 generation 更小）到达时不终结新会话：
  // onAudioSegmentComplete 对 stop-requested/draining 生效——新会话在 listening，应被忽略
  coord.onAudioSegmentComplete('dev1', 1, 'meeting-destroyed');
  assert.equal(coord.current?.state, 'listening', '迟到段边界不影响新会话采集');
  // 迟到 transport-down（旧会话残留）：会终结当前会话——属设备级事实，如实处理
  await coord.shutdown();
  assert.equal(coord.current, null);
});
