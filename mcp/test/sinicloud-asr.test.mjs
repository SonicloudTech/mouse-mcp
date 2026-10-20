/*
 * sinicloud-asr.test.mjs —— Sonicloud 流式识别 provider 单测
 * 全离线：fake WebSocket / fake fetch，不触网络、不触真实凭据。
 * 覆盖：token 签名/缓存/刷新、鉴权重连一次、协议帧映射（1000/0/End/1001/-2/
 * 40xx/50xx）、>80B 分帧与尾包补零、endQueued、取消、错误脱敏、凭据热换。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const CREDS = { appId: 'app-1', apiKey: 'key-1', apiSecret: 'secret-1', userId: 'u1', lanid: 0 };

class FakeSocket {
  constructor() {
    this.frames = [];
    this.closed = false;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
  }
  send(data) { if (this.closed) throw new Error('send after close'); this.frames.push(data); }
  close() { if (!this.closed) { this.closed = true; this.onclose?.(); } }
  open() { this.onopen?.(); }
  msg(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  serverClose() { if (!this.closed) { this.closed = true; this.onclose?.(); } }
  binaryFrames() { return this.frames.filter(f => typeof f !== 'string'); }
  textFrames() { return this.frames.filter(f => typeof f === 'string'); }
}

function makeFetch(steps) {
  const calls = [];
  let cursor = 0;
  const impl = async (url, init) => {
    const step = steps[Math.min(cursor, steps.length - 1)];
    cursor += 1;
    calls.push({ url, body: init ? JSON.parse(init.body) : null });
    if (step.throw) throw new Error('network down');
    if (step.httpError) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ code: step.code ?? 0, data: { token: step.token ?? `T${cursor}`, expire_time: step.expireTime } }) };
  };
  return { impl, calls };
}

function makeEvents() {
  const log = { previews: [], finals: [], warnings: [], terminal: null };
  return {
    log,
    events: {
      preview: (text, meta) => log.previews.push({ text, meta }),
      segmentFinal: (text, meta) => log.finals.push({ text, meta }),
      warning: (kind, detail, meta) => log.warnings.push({ kind, detail, meta }),
      terminal: (result, meta) => { log.terminal = { result, meta }; },
    },
  };
}

async function makeProvider({ creds = CREDS, credsLoader, fetchSteps = [{}], socketCount = 1, timeoutMs = 60_000, chunkBytes } = {}) {
  const { createSinicloudStreamFactory } = await import('../dist/sinicloud-asr.js');
  const fetcher = makeFetch(fetchSteps);
  const sockets = [];
  const urls = [];
  let nowMs = 1_700_000_000_000;
  const factory = createSinicloudStreamFactory({
    credentials: credsLoader ?? (() => creds),
    timeoutMs,
    fetchImpl: fetcher.impl,
    now: () => nowMs,
    ...(chunkBytes ? { chunkBytes } : {}),
    connect: url => { urls.push(url); const s = new FakeSocket(); sockets.push(s); return s; },
  });
  assert.notEqual(factory, null, '工厂可用');
  return { factory, fetcher, sockets, urls, get nowMs() { return nowMs; }, set nowMs(v) { nowMs = v; } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const settle = () => sleep(20); // 让 begin 的异步链（token→openSocket）走完

test('token 签名按平台规则 md5(appId+apiKey+timeStamp+apiSecret)，URL 带鉴权参数', async () => {
  const p = await makeProvider();
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  assert.equal(p.fetcher.calls.length, 1, 'getToken 一次');
  const body = p.fetcher.calls[0].body;
  const expectSign = createHash('md5').update(`${CREDS.appId}${CREDS.apiKey}${body.timeStamp}${CREDS.apiSecret}`).digest('hex');
  assert.equal(body.appId, CREDS.appId);
  assert.equal(body.sign, expectSign, '签名规则正确');
  assert.match(p.urls[0], /^wss?:\/\/[^/]+\/talentStreamAsr\?X-SC-Authorization=T1&X-SC-User-Id=u1&lanid=0$/);
  provider.cancel();
});

test('happy path：1000 后推音频、End==0→preview、End>0→segmentFinal、end 后关闭→ok', async () => {
  const p = await makeProvider({ chunkBytes: 3200 });
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  const s = p.sockets[0];
  s.open();
  s.msg({ errCode: '1000', sid: 'SID-1' });
  provider.writePcm(Buffer.alloc(3200, 1));
  provider.writePcm(Buffer.alloc(3200, 2));
  provider.writePcm(Buffer.alloc(40, 3));   // 尾包 <81B
  await settle();
  assert.equal(s.binaryFrames().length, 2, '就绪后立即发两个整片');
  s.msg({ errCode: '0', text: '你好', End: 0 });
  s.msg({ errCode: '0', text: '你好。', End: 1 });
  provider.finishInput();
  await settle();
  const bins = s.binaryFrames();
  assert.equal(bins.length, 3, 'finishInput 冲出尾包');
  assert.ok(bins.every(b => b.length > 80), '每个音频帧都 >80 字节');
  assert.equal(bins[2].length, 81, '40B 尾包补零到 81B');
  assert.deepEqual(s.textFrames(), ['end'], '结束帧为文本 "end"');
  assert.equal(log.previews.length, 1);
  assert.equal(log.previews[0].text, '你好');
  assert.equal(log.finals.length, 1);
  assert.equal(log.finals[0].text, '你好。');
  assert.equal(log.terminal, null, '关闭前无终态');
  s.serverClose();
  assert.deepEqual(log.terminal.result, { ok: true });
});

test('未就绪先 writePcm：1000 之后统一补发（顺序保持）', async () => {
  const p = await makeProvider();
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  provider.writePcm(Buffer.alloc(500, 7)); // 连接未确认：只累积
  const s = p.sockets[0];
  assert.equal(s.frames.length, 0, '1000 前不发音频');
  s.open();
  s.msg({ errCode: '1000' });
  await settle();
  assert.equal(s.binaryFrames().length, 1);
  assert.equal(s.binaryFrames()[0].length, 500);
  provider.cancel();
});

test('finishInput 早于 1000：就绪后先冲音频再 end', async () => {
  const p = await makeProvider();
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  provider.writePcm(Buffer.alloc(200, 9));
  provider.finishInput();
  const s = p.sockets[0];
  assert.equal(s.frames.length, 0);
  s.open();
  s.msg({ errCode: '1000' });
  await settle();
  assert.deepEqual(s.frames.map(f => (typeof f === 'string' ? f : f.length)), [200, 'end'],
    '就绪后冲 200B 音频并紧跟 end');
  s.serverClose();
  assert.deepEqual(log.terminal.result, { ok: true });
});

test('鉴权 4013（1000 前）：强制换 token 重连一次后成功', async () => {
  const p = await makeProvider({ fetchSteps: [{ token: 'TA' }, { token: 'TB' }], socketCount: 2 });
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  p.sockets[0].open();
  p.sockets[0].msg({ errCode: '4013', message: 'token invalid' });
  await settle();
  assert.equal(p.sockets.length, 2, '建立第二条连接');
  assert.equal(p.fetcher.calls.length, 2, 'token 重新获取');
  assert.match(p.urls[1], /X-SC-Authorization=TB/, '重连用新 token');
  assert.ok(p.sockets[0].closed, '死连接已关闭');
  p.sockets[1].open();
  p.sockets[1].msg({ errCode: '1000' });
  provider.finishInput();
  await settle();
  p.sockets[1].serverClose();
  assert.deepEqual(log.terminal.result, { ok: true });
});

test('鉴权失败两次：终态为固定错误码（不含凭据/响应体）', async () => {
  const p = await makeProvider({ fetchSteps: [{ token: 'TA' }, { token: 'TB' }], socketCount: 2 });
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  p.sockets[0].open(); p.sockets[0].msg({ errCode: '4013', message: 'bad' });
  await settle();
  p.sockets[1].open(); p.sockets[1].msg({ errCode: '4012', message: 'expired' });
  await settle();
  assert.equal(log.terminal.result.ok, false);
  assert.equal(log.terminal.result.error, 'sinicloud_auth_4012');
  assert.ok(/^sinicloud_/.test(log.terminal.result.error ?? ''), '错误码为固定前缀');
});

test('1001 低余额：告警但会话继续', async () => {
  const p = await makeProvider();
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  const s = p.sockets[0];
  s.open(); s.msg({ errCode: '1000' });
  s.msg({ errCode: '1001', message: 'low balance' });
  assert.equal(log.warnings.length, 1);
  assert.equal(log.warnings[0].kind, 'low_balance');
  provider.finishInput();
  await settle();
  s.serverClose();
  assert.deepEqual(log.terminal.result, { ok: true }, '低余额不断连');
});

test('-2 超出单次时长 / 4004 参数错 / 5001 运行错：固定错误码终态', async () => {
  for (const [code, expect] of [['-2', 'sinicloud_duration_limit'], ['4004', 'sinicloud_error_4004'], ['5001', 'sinicloud_error_5001']]) {
    const p = await makeProvider();
    const { log, events } = makeEvents();
    const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
    provider.begin({ sessionId: 's1', deviceId: 'd1' });
    await settle();
    p.sockets[0].open();
    p.sockets[0].msg({ errCode: '1000' });
    p.sockets[0].msg({ errCode: code, message: 'x' });
    assert.equal(log.terminal.result.ok, false);
    assert.equal(log.terminal.result.error, expect);
  }
});

test('end 后服务端不关闭：收尾超时兜底 ok（不悬挂）', async () => {
  const p = await makeProvider({ timeoutMs: 1000 });
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  const s = p.sockets[0];
  s.open(); s.msg({ errCode: '1000' });
  provider.finishInput();
  await sleep(1300); // timeoutMs=1000 → END_TIMEOUT=min(1000,15s)
  assert.deepEqual(log.terminal.result, { ok: true }, '超时兜底 FINISHED');
  assert.ok(s.closed, '本地关闭 socket');
});

test('errCode=10 收尾标记：立即 FINISHED（不等服务端关闭）', async () => {
  const p = await makeProvider();
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  const s = p.sockets[0];
  s.open(); s.msg({ errCode: '1000' });
  provider.writePcm(Buffer.alloc(3200, 5));
  provider.finishInput();
  await settle();
  assert.equal(log.terminal, null, 'end 后未终态（等收尾标记）');
  s.msg({ result: '', errCode: '10', Begin: '0', End: '1000' });
  assert.deepEqual(log.terminal.result, { ok: true }, '收到 10 立即 FINISHED');
  assert.ok(s.closed, '本地关闭 socket');
});

test('实测协议：errCode=3 累积中间结果→preview 递增；errCode=10 result 携带终稿→segmentFinal+ok', async () => {
  const p = await makeProvider({ chunkBytes: 3200 });
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  const s = p.sockets[0];
  s.open(); s.msg({ errCode: '1000' });
  provider.writePcm(Buffer.alloc(3200, 5));
  await settle();
  s.msg({ result: '你好', errCode: '3', Begin: 0, End: 1200 });
  s.msg({ result: '你好 ，这是优马鼠', errCode: '3', Begin: 0, End: 2600 });
  assert.equal(log.previews.length, 2, '累积中间结果逐帧 preview');
  assert.equal(log.previews[0].text, '你好');
  assert.equal(log.previews[1].text, '你好 ，这是优马鼠');
  assert.equal(log.previews[0].meta.revision, 1, 'revision 递增');
  assert.equal(log.previews[1].meta.revision, 2);
  provider.finishInput();
  await settle();
  s.msg({ result: '你好，这是优马鼠语音打字演示，识别文字将通过真实硬件键盘打出。', errCode: '10', Begin: '0', End: '7906', lanid: '' });
  assert.equal(log.finals.length, 1, '终稿经 segmentFinal 交付');
  assert.equal(log.finals[0].text, '你好，这是优马鼠语音打字演示，识别文字将通过真实硬件键盘打出。');
  assert.deepEqual(log.terminal.result, { ok: true });
});

test('连接期夭折（无错误码关闭）：换 token 重连一次，再失败则 connect_failed', async () => {
  const p = await makeProvider({ fetchSteps: [{ token: 'TA' }, { token: 'TB' }], socketCount: 2 });
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  p.sockets[0].open();
  p.sockets[0].serverClose(); // 未到 1000 就断
  await settle();
  assert.equal(p.sockets.length, 2, '重连一次');
  p.sockets[1].serverClose();
  await settle();
  assert.equal(log.terminal.result.error, 'sinicloud_connect_failed');
});

test('cancel：立即 cancelled 终态并关闭连接', async () => {
  const p = await makeProvider();
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  const s = p.sockets[0];
  s.open(); s.msg({ errCode: '1000' });
  provider.cancel();
  assert.deepEqual(log.terminal.result, { ok: false, cancelled: true });
  assert.ok(s.closed);
  provider.cancel(); // 幂等
  assert.equal(log.terminal.result.cancelled, true);
});

test('token 获取失败：网络/HTTP/业务码分别映射固定错误码', async () => {
  for (const [step, expect] of [
    [{ throw: true }, 'sinicloud_token_network'],
    [{ httpError: true }, 'sinicloud_token_http'],
    [{ code: 1002 }, 'sinicloud_token_1002'],
  ]) {
    const p = await makeProvider({ fetchSteps: [step] });
    const { log, events } = makeEvents();
    const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
    provider.begin({ sessionId: 's1', deviceId: 'd1' });
    await settle();
    assert.equal(log.terminal.result.ok, false);
    assert.equal(log.terminal.result.error, expect);
    assert.equal(p.sockets.length, 0, 'token 失败不建连接');
  }
});

test('凭据缺失/非法：固定错误码，不抛出', async () => {
  const p = await makeProvider({ creds: { appId: '', apiKey: 'k', apiSecret: 's' } });
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  assert.equal(log.terminal.result.error, 'sinicloud_credentials_missing');
});

test('token 缓存与临期刷新：同凭据复用，过期重取', async () => {
  const p = await makeProvider({ fetchSteps: [{ token: 'T1', expireTime: 0 }] }); // expire_time 非 epoch → 默认 2h-5min
  const mk = () => { const { log, events } = makeEvents(); return { log, events }; };
  let e = mk();
  let provider = p.factory(e.events, { sessionId: 'a', deviceId: 'd' });
  provider.begin({ sessionId: 'a', deviceId: 'd' });
  await settle();
  provider.cancel();
  e = mk();
  provider = p.factory(e.events, { sessionId: 'b', deviceId: 'd' });
  provider.begin({ sessionId: 'b', deviceId: 'd' });
  await settle();
  assert.equal(p.fetcher.calls.length, 1, '未过期：token 复用');
  provider.cancel();
  p.nowMs += 2 * 60 * 60_000; // 推进 2h：过期
  e = mk();
  provider = p.factory(e.events, { sessionId: 'c', deviceId: 'd' });
  provider.begin({ sessionId: 'c', deviceId: 'd' });
  await settle();
  assert.equal(p.fetcher.calls.length, 2, '过期后重新获取');
  provider.cancel();
});

test('凭据热换：换 key 后新会话用新 appId 取 token（换 key 不重启）', async () => {
  let creds = { ...CREDS };
  const p = await makeProvider({ credsLoader: () => creds, fetchSteps: [{ token: 'T1' }, { token: 'T2' }] });
  const a = makeEvents();
  let provider = p.factory(a.events, { sessionId: 'a', deviceId: 'd' });
  provider.begin({ sessionId: 'a', deviceId: 'd' });
  await settle();
  provider.cancel();
  creds = { ...CREDS, appId: 'app-2', apiKey: 'key-2', apiSecret: 'secret-2' };
  const b = makeEvents();
  provider = p.factory(b.events, { sessionId: 'b', deviceId: 'd' });
  provider.begin({ sessionId: 'b', deviceId: 'd' });
  await settle();
  assert.equal(p.fetcher.calls.length, 2, '凭据指纹变化 → 新 token 客户端');
  assert.equal(p.fetcher.calls[1].body.appId, 'app-2');
  provider.cancel();
});

test('错误与告警消息脱敏：不含凭据、token、URL', async () => {
  const p = await makeProvider({ fetchSteps: [{ httpError: true }] });
  const { log, events } = makeEvents();
  const provider = p.factory(events, { sessionId: 's1', deviceId: 'd1' });
  provider.begin({ sessionId: 's1', deviceId: 'd1' });
  await settle();
  const blob = JSON.stringify(log) + JSON.stringify(p.fetcher.calls.map(c => c.url));
  for (const secret of [CREDS.apiKey, CREDS.apiSecret]) {
    assert.ok(!blob.includes(secret), '凭据不泄漏到事件/错误');
  }
});
