/*
 * voice-bridge.test.mjs —— v2 桥接层集成（互斥语义；FakeSdk 无硬件）
 * 覆盖：物理键改道协调器（旧监听器不并存）、会议/录音/改源/重配仲裁、
 * 帧级注入能力硬闸、raw 诊断门控、换代能力重建。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { loadConfig } from '../dist/env.js';
const require = createRequire(import.meta.url);
const binding = require('../../doc/umouse-sdk.js');
class FakeSdk extends EventEmitter {
  running = false;
  devices = [{ id: 'dev1', mode: 'USB' }];
  source = '';
  writes = [];
  version() { return 'mock'; } isStarted() { return this.running; }
  setWorkMode() { return 1; } setDeviceLimit() { return 1; }
  setUsbConfigFor() { return 1; } setBleConfigFor() { return 1; }
  enableCrashReport() {} start() { this.running = true; }
  stop() { this.running = false; } unregisterCallbacks() {}
  deviceList() { return this.devices; }
  audioSource() { return this.source; }
  setAudioSource(id) { this.source = id ?? ''; return 1; }
  meetingCreate() { return 1; } meetingDestroy() { return 1; }
  meetingPause() { return 1; } meetingResume() { return 1; }
  injectMouse(buttons, dx, dy, wheel, id) { this.writes.push(['mouse', buttons, dx, dy, wheel, id]); return 1; }
  injectKeyboard(modifiers, keys, id) { this.writes.push(['kb', modifiers, keys, id]); return 1; }
  writeRaw(buf, id) { this.writes.push(['raw', buf.toString('hex'), id]); return 1; }
}
binding.UMouseSdk = FakeSdk;
const { SdkBridge } = await import('../dist/sdk-bridge.js');

function makeBridge(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umouse-voice-bridge-'));
  const cfg = { UMSDK_DATA_DIR: dir, UMSDK_ASR_PROVIDER: 'disabled', ...extra };
  if (cfg.UMSDK_ASR_PROVIDER === undefined) delete cfg.UMSDK_ASR_PROVIDER;
  const bridge = new SdkBridge(loadConfig(cfg), { lease: null });
  const cwd = process.cwd();
  return { bridge, dir, cleanup: async () => {
    await bridge.shutdown();
    process.chdir(cwd);
    // 批量识别的 PowerShell 子进程可能仍持有 dataDir 为 cwd——重试等它退出
    for (const delay of [0, 300, 900]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* EBUSY 重试 */ }
      await new Promise((r) => setTimeout(r, delay));
    }
  } };
}
const msg = (type, extra = {}) => JSON.stringify({ type, ...extra });

test('S07 物理语音键改道协调器：不与旧自动录音并存', async () => {
  const { bridge, cleanup } = makeBridge({ UMSDK_ASR_PROVIDER: 'windows-speech' });
  try {
    await bridge.start();
    const sdk = bridge.sdk;
    sdk.emit('connected', 'dev1', 0);
    sdk.emit('message', msg('keyEvent', { key: 'speech', action: 'down' }), 'dev1');
    const active = bridge.voiceCoord?.current;
    assert.ok(active, 'v2 开启时按键进入协调器');
    assert.equal(active.destination, 'cursor-dictation');
    assert.equal(bridge.recorder.active, false, '旧自动录音监听器不再启动');
    sdk.emit('message', msg('keyEvent', { key: 'speech', action: 'up' }), 'dev1');
    sdk.emit('message', msg('audioSegmentComplete', { segment: 1, reason: 'key-up' }), 'dev1');
    await new Promise((r) => setTimeout(r, 30));
    const s = bridge.voiceCoord?.session(active.sessionId);
    assert.ok(['finalizing', 'ready', 'no-speech'].includes(s.state), `收尾进入识别阶段：${s.state}`);
    // windows-speech 可用（win32 默认）：会话已建立
    assert.equal(bridge.voiceCoord?.asrAvailable, true);
  } finally { await cleanup(); }
});

test('S07 会议/录音/改源在活动语音会话中被仲裁拒绝', async () => {
  const { bridge, cleanup } = makeBridge({ UMSDK_ASR_PROVIDER: 'windows-speech' });
  try {
    await bridge.start();
    const sdk = bridge.sdk;
    sdk.emit('connected', 'dev1', 0);
    // 借 agent 会话占住音频资源（无 ASR 也能进入 opening 占位后失败——改用 PTT 占位）
    sdk.emit('message', msg('keyEvent', { key: 'speech', action: 'down' }), 'dev1');
    assert.ok(bridge.voiceCoord?.current);
    assert.throws(() => bridge.meeting('create', 'dev1'), /仲裁拒绝/);
    assert.throws(() => bridge.setAudioSource(undefined), /音频源由会话管理/);
    assert.throws(() => bridge.audioRecord('start', 'dev1'), /仲裁拒绝/);
    const r = await bridge.reconfigure({ deviceLimit: 2 });
    assert.equal(r.ok, false, '重配被仲裁拒绝');
    sdk.emit('message', msg('keyEvent', { key: 'speech', action: 'up' }), 'dev1');
    sdk.emit('message', msg('audioSegmentComplete', { segment: 1, reason: 'key-up' }), 'dev1');
    await new Promise((res) => setTimeout(res, 30));
  } finally { await cleanup(); }
});

test('G06/G01 帧级硬闸：mouse_control 未声明时注入帧被拒（写入路径共享校验）', async () => {
  const { bridge, cleanup } = makeBridge();
  try {
    await bridge.start();
    const sdk = bridge.sdk;
    sdk.emit('connected', 'dev1', 0);
    // 未声明 mouse_control：帧写入返回 0（SDK 层面被拦截）
    const denied = await bridge.inject.move(100, 0, 'dev1');
    assert.ok(denied.failed > 0, '帧写入被拒（failed>0）');
    assert.equal(sdk.writes.length, 0, '无任何帧到达设备');
    // 全零清理帧不受能力限制（本进程无持有状态时也不会发——InjectController 语义）
    // 声明能力后放行
    bridge.capabilities.setTestProfile('dev1', { mouse_control: 'supported' });
    const r = await bridge.inject.move(100, 0, 'dev1');
    assert.equal(r.failed, 0);
    assert.ok(sdk.writes.some((w) => w[0] === 'mouse'), '帧已写入');
  } finally { await cleanup(); }
});

test('G06 raw 门控：默认拒绝；诊断模式下已知帧过能力校验、未知命令拒绝', async () => {
  const { bridge, cleanup } = makeBridge({ UMSDK_RAW_DIAG: '1' });
  try {
    await bridge.start();
    const sdk = bridge.sdk;
    sdk.emit('connected', 'dev1', 0);
    // mouse_control 未声明 → 03 F0 帧被能力拒绝
    assert.throws(() => bridge.writeRaw('0a03f0000000000000000000', 'dev1'), /能力门控|unknown|未知/);
    bridge.capabilities.setTestProfile('dev1', { mouse_control: 'supported' });
    const ok1 = bridge.writeRaw('0a03f0000000000000000000', 'dev1');
    assert.equal(ok1.ok, 1);
    // 未知命令拒绝
    assert.throws(() => bridge.writeRaw('0a03a000000000000000', 'dev1'), /未知命令/);
  } finally { await cleanup(); }
  const { bridge: b2, cleanup: c2 } = makeBridge();
  try {
    await b2.start();
    b2.sdk.emit('connected', 'dev1', 0);
    b2.capabilities.setTestProfile('dev1', { mouse_control: 'supported' });
    assert.throws(() => b2.writeRaw('0a03f0000000000000000000', 'dev1'), /诊断模式/, '非诊断模式一律拒绝');
  } finally { await c2(); }
});

test('G04 换代能力重建：重连后 hardware/test 声明按规则处理', async () => {
  const { bridge, cleanup } = makeBridge({ UMSDK_TEST_CAPS: '{"*":{"mouse_control":"supported"}}' });
  try {
    await bridge.start();
    const sdk = bridge.sdk;
    sdk.emit('connected', 'dev1', 0);
    assert.equal(bridge.capabilities.supportOf('dev1', 'mouse_control')?.support, 'supported', '通配测试声明套用');
    // 模拟硬件信息到达（同代次）
    bridge.capabilities.applyDeviceCapabilities('dev1', bridge.devices.generationOf('dev1'), { mouse_control: 'unsupported' });
    assert.equal(bridge.capabilities.supportOf('dev1', 'mouse_control')?.support, 'unsupported', 'hardware-info 覆盖测试声明');
    // 重连换代 → 回到通配测试声明（hardware-info 作废）
    sdk.emit('disconnected', 'dev1', 0);
    sdk.emit('connected', 'dev1', 0);
    assert.equal(bridge.capabilities.supportOf('dev1', 'mouse_control')?.support, 'supported');
    assert.equal(bridge.devices.generationOf('dev1'), 3, 'startup list then two connected events advance the epoch');
  } finally { await cleanup(); }
});

test('R01 旧 inbox 不接收 v2 事件流：PTT 会话不产生 speechCaptured/持久消息', async () => {
  const { bridge, cleanup } = makeBridge({ UMSDK_ASR_PROVIDER: 'windows-speech' });
  try {
    await bridge.start();
    const sdk = bridge.sdk;
    sdk.emit('connected', 'dev1', 0);
    sdk.emit('message', msg('keyEvent', { key: 'speech', action: 'down' }), 'dev1');
    sdk.emit('audio', Buffer.alloc(3200), 3200, 'dev1');
    sdk.emit('message', msg('keyEvent', { key: 'speech', action: 'up' }), 'dev1');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bridge.voice.list(true).length, 0, '旧 inbox 无新消息');
    assert.equal(bridge.recorder.last, null, '不产 WAV（听写走 PCM 流）');
    const types = bridge.events.since(0, undefined, 500).map((e) => e.type);
    assert.ok(types.includes('voiceSession'), 'v2 会话事件入流');
    assert.ok(!types.includes('speechCaptured'), '不再投递旧自动录音事件');
  } finally { await cleanup(); }
});
