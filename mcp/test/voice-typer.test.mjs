/*
 * voice-typer.test.mjs —— typer 交付语义（fake 绑定等价物）
 * 全部走 bindingOverride fake——不触真实键盘输入（真实注入仅在用户明确要求时）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRealTyper } from '../dist/voice-typer-binding.js';

function fakeTyperBinding({ rc = 0, throwOnType = false } = {}) {
  const calls = [];
  class FakeTyper {
    version() { return '1.1.2-fake'; }
    probe() { return { session_type: 1, text_typing: 1, increment_typing: 1, whole_phrase_paste: 1, ime_guard: 0, input_permitted: 1 }; }
    init() { return true; }
    typeText(text) {
      calls.push(text);
      if (throwOnType) throw new Error('boom');
      return rc;
    }
    strerror(code) { return `fake-rc-${code}`; }
    async shutdown() { calls.push('__shutdown__'); }
  }
  return { binding: { Typer: FakeTyper }, calls };
}

const withLedger = () => fs.mkdtempSync(path.join(os.tmpdir(), 'umouse-typer-ledger-'));

test('T01 一次 typeText：换行规范为空格、不回车；submitted 仅表示 API 接受', async () => {
  const dir = withLedger();
  const { binding, calls } = fakeTyperBinding();
  const typer = createRealTyper({ ledgerDir: dir, bindingOverride: binding });
  assert.equal(typer.available, true);
  try {
    const r = await typer.deliver({ sessionId: 's1', text: '第一行\n第二行', deviceId: 'd' });
    assert.equal(r.outcome, 'submitted');
    assert.match(r.note ?? '', /API 已接受/);
    assert.deepEqual(calls, ['第一行 第二行'], '换行→空格，单次提交，无 Enter');
    // 账本：成功不留明文
    const entries = readLedger(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, 'submitted');
    assert.equal(entries[0].text, undefined);
    assert.equal(entries[0].textLength, 7);
    assert.ok(entries[0].textSha256.length === 64);
    assert.ok(entries[0].focus, '焦点快照记录');
  } finally {
    await typer.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T03 控制字符拒绝（未尝试，无帧）；超长拒绝；空文本拒绝', async () => {
  const dir = withLedger();
  const { binding, calls } = fakeTyperBinding();
  const typer = createRealTyper({ ledgerDir: dir, bindingOverride: binding });
  try {
    const ctrl = await typer.deliver({ sessionId: 's', text: 'a\x03b', deviceId: 'd' });
    assert.equal(ctrl.outcome, 'failed');
    assert.match(ctrl.error, /控制字符/);
    const long = await typer.deliver({ sessionId: 's', text: 'x'.repeat(4001), deviceId: 'd' });
    assert.equal(long.outcome, 'failed');
    const empty = await typer.deliver({ sessionId: 's', text: '   ', deviceId: 'd' });
    assert.equal(empty.outcome, 'failed');
    assert.deepEqual(calls, [], '全部在提交前拒绝——无任何输入');
  } finally {
    await typer.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T03 rc 映射：-4=failed（权限拒绝）；其它 rc=unknown；异常=unknown；失败保留正文', async () => {
  for (const scenario of [{ rc: -4 }, { rc: -7 }, { throwOnType: true }]) {
    const dir = withLedger();
    const { binding } = fakeTyperBinding(scenario);
    const typer = createRealTyper({ ledgerDir: dir, bindingOverride: binding });
    try {
      const r = await typer.deliver({ sessionId: 's', text: '保留我', deviceId: 'd' });
      assert.notEqual(r.outcome, 'submitted');
      if (scenario.rc === -4) assert.equal(r.outcome, 'failed');
      else assert.equal(r.outcome, 'unknown');
      const entries = readLedger(dir);
      assert.equal(entries[0].text, '保留我', '未成功交付保留正文供用户处理');
    } finally {
      await typer.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('能力不足/库缺失：available=false，交付 unavailable 不崩溃', async () => {
  const dir = withLedger();
  // 能力不足（input_permitted=0）
  class Denied {
    version() { return '1.1.2'; }
    probe() { return { text_typing: 1, input_permitted: 0 }; }
    init() { return true; }
    typeText() { return 0; }
    strerror() { return ''; }
    async shutdown() {}
  }
  const denied = createRealTyper({ ledgerDir: dir, bindingOverride: { Typer: Denied } });
  assert.equal(denied.available, false);
  const r = await denied.deliver({ sessionId: 's', text: 'x', deviceId: 'd' });
  assert.equal(r.outcome, 'unavailable');
  // 库缺失（无 override 且路径不存在——用不存在目录的 ledger 隔离）
  const missing = createRealTyper({ ledgerDir: dir });
  // lib/typer.dll 在位时 missing 为真实端口——只断言不抛
  assert.ok(typeof missing.available === 'boolean');
  await denied.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T04 账本配额滚动：超过 200 条时保留最新', async () => {
  const dir = withLedger();
  const { binding } = fakeTyperBinding();
  const typer = createRealTyper({ ledgerDir: dir, bindingOverride: binding });
  try {
    for (let i = 0; i < 205; i++) {
      await typer.deliver({ sessionId: `s-${i}`, text: `t${i}`, deviceId: 'd' });
    }
    const entries = readLedger(dir);
    assert.ok(entries.length <= 200, `条数受配额约束（实测 ${entries.length}）`);
    assert.ok(entries.some((e) => e.sessionId === 's-204'), '最新记录保留');
    assert.ok(!entries.some((e) => e.sessionId === 's-0'), '最旧记录滚动淘汰');
  } finally {
    await typer.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真实 typer.dll 探测（不注入）：probe 可读、能力字段完整', async () => {
  const lib = path.resolve('lib/typer.dll');
  if (!fs.existsSync(lib)) {
    assert.ok(true, 'lib/typer.dll 不在位——跳过（部署后必测）');
    return;
  }
  const req = createRequire(import.meta.url);
  const { Typer } = req('../../doc/typer.js');
  const t = new Typer();
  assert.match(t.version(), /^1\.1\./, `版本 1.1.x（实测 ${t.version()}）`);
  const caps = t.probe();
  assert.equal(caps.session_type >= 0, true);
  assert.ok('text_typing' in caps && 'input_permitted' in caps, '能力字段完整');
  await t.shutdown();
});

function readLedger(dir) {
  const file = path.join(dir, 'deliveries.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

import { createRequire } from 'node:module';
