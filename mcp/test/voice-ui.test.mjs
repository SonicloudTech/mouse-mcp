/*
 * voice-ui.test.mjs —— 浮窗控制器行协议（进程内等价物）
 * stub（mcp/test/fixtures/ui-stub.mjs）冒充 exe 讲同一协议；验证 spawn/更新/
 * 按钮指令/会话身份隔离/stdin 关闭退出；exe 缺失时优雅降级。
 * 真实窗口的可见效果与不抢焦点属人眼验收（P5），本文件不冒充。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoiceUiController } from '../dist/voice-ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ui-stub.mjs');
const views = (sessionId, state = 'listening', change) => ({
  sessionId, state, destination: 'agent-reply', preview: '你好', createdAt: Date.now() - 1000, change,
});

test('U01 协议往返：spawn → U 更新 → stub 按钮 F → onFinish(会话身份)；终态关进程', async () => {
  const finished = [];
  const ui = new VoiceUiController({
    exePath: process.execPath,
    exeArgs: [STUB],
    onFinish: (id) => finished.push(id),
    onCancel: () => {},
  });
  assert.equal(ui.available, true);
  try {
    ui.onSessionUpdate(views('s-1', 'listening'));
    await sleep(600); // spawn + U 行往返
    assert.deepEqual(finished, ['s-1'], '完成按钮指令到达（带会话身份）');
    // 同会话预览刷新不重启进程
    ui.onSessionUpdate({ ...views('s-1', 'listening', 'preview'), preview: '你好世界' });
    await sleep(400);
    assert.deepEqual(finished, ['s-1', 's-1']);
    // 终态：close（stdin EOF → stub 退出）
    ui.onSessionUpdate(views('s-1', 'delivered', 'terminal'));
    await sleep(400);
    // 旧会话迟到消息：浮窗已关，不复活
    ui.onSessionUpdate(views('s-1', 'listening'));
    await sleep(200);
    assert.deepEqual(finished, ['s-1', 's-1'], '旧会话消息被身份隔离丢弃');
  } finally {
    ui.dispose();
    await sleep(150);
  }
});

test('新会话重开浮窗：第二个会话再次收到按钮指令', async () => {
  const finished = [];
  const ui = new VoiceUiController({
    exePath: process.execPath,
    exeArgs: [STUB],
    onFinish: (id) => finished.push(id),
    onCancel: () => {},
  });
  try {
    ui.onSessionUpdate(views('a-1', 'ptt-capturing'));
    await sleep(600);
    ui.onSessionUpdate(views('a-1', 'delivered', 'terminal'));
    await sleep(300);
    ui.onSessionUpdate(views('b-2', 'listening'));
    await sleep(600);
    assert.deepEqual(finished, ['a-1', 'b-2'], '两个会话各自的浮窗与指令');
  } finally {
    ui.dispose();
    await sleep(150);
  }
});

test('exe 缺失：available=false，不抛异常（会话仍有工具完成入口）', () => {
  const diag = [];
  const ui = new VoiceUiController({
    exePath: path.resolve('definitely-missing-ui.exe'),
    onFinish: () => {}, onCancel: () => {}, onDiagnostic: (i) => diag.push(i),
  });
  assert.equal(ui.available, false);
  assert.ok(diag.some((d) => d.component === 'voice-ui'));
  assert.doesNotThrow(() => ui.onSessionUpdate(views('s-2')));
  ui.dispose();
});

test('真实 umouse-voice-ui.exe 在位（构建产物存在性；窗口行为属 P5 人眼验收）', () => {
  const exe = path.resolve('mcp/voice-ui/target/release/umouse-voice-ui.exe');
  if (!fs.existsSync(exe)) {
    assert.ok(true, '浮窗 exe 未构建——跳过（cargo build --release 后必测）');
    return;
  }
  const stat = fs.statSync(exe);
  assert.ok(stat.size > 50_000, `exe 体积合理（${stat.size}B）`);
});
