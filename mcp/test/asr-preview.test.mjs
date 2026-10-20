/*
 * asr-preview.test.mjs —— 本地快照预览适配（调度语义）
 * fake transcriber（可控时延/结果），无真实识别引擎。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withSnapshotPreview } from '../dist/asr-service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTranscriber(delayMs = 30) {
  const calls = [];
  let resolveNext = null;
  const t = async (record) => {
    calls.push(record);
    if (resolveNext) { resolveNext(); resolveNext = null; }
    await sleep(delayMs);
    return { text: `预览#${calls.length}:${record.bytes}B`, provider: 'fake', language: 'zh-CN' };
  };
  return { t, calls, waitForCall: () => new Promise((r) => { resolveNext = r; }) };
}

function baseFactory() {
  const state = { begin: 0, pcm: 0, finish: 0, cancel: 0 };
  return {
    state,
    factory: (events, init) => ({
      id: 'base',
      supportsPreview: false,
      begin() { state.begin += 1; },
      writePcm(c) { state.pcm += c.length; },
      finishInput() { state.finish += 1; events.terminal({ ok: true }, { sessionId: init.sessionId }); },
      cancel() { state.cancel += 1; },
    }),
  };
}

test('预览调度：有界前缀整体替换、单任务在运行、终态后作废', async () => {
  const { t, calls } = makeTranscriber(40);
  const base = baseFactory();
  const events = [];
  const factory = withSnapshotPreview(base.factory, t, { intervalMs: 100 });
  const provider = factory({ preview: (text, meta) => events.push({ text, meta }), segmentFinal: () => {}, warning: () => {}, terminal: () => {} }, { sessionId: 's1', deviceId: 'd' });
  assert.equal(provider.supportsPreview, true, '预览能力由本层声明（本地快照识别）');
  provider.begin();
  provider.writePcm(Buffer.alloc(3200));
  provider.writePcm(Buffer.alloc(3200));
  await sleep(450); // 足够跑几拍（busy 跳过）
  assert.ok(calls.length >= 1 && calls.length <= 4, `快照任务串行（1~4 拍，实测 ${calls.length}）`);
  assert.ok(events.length >= 1, '至少一次预览');
  assert.ok(events.every((e) => e.text.includes(':6400B')), '预览为完整前缀（字节累计）');
  // 终态后迟到预览作废
  provider.finishInput();
  const before = events.length;
  await sleep(80);
  assert.equal(events.length, before, 'finishInput 后不再产生预览');
  assert.equal(base.state.finish, 1, '底层 provider 正常收尾');
});

test('取消：立即停调度，底层 cancel 恰好一次', async () => {
  const { t } = makeTranscriber(10);
  const base = baseFactory();
  let terminal = null;
  const factory = withSnapshotPreview(base.factory, t, { intervalMs: 20 });
  const provider = factory({ terminal: (r) => { terminal = r; } }, { sessionId: 's2', deviceId: 'd' });
  provider.begin();
  provider.writePcm(Buffer.alloc(3200));
  await sleep(30);
  provider.cancel();
  assert.equal(base.state.cancel, 1);
  assert.ok(terminal === null || terminal.cancelled === true, '取消终态语义');
  await sleep(60); // 无泄漏抛错即过
});
