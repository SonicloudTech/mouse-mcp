import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VoiceRelay } from '../dist/voice-relay.js';

const wrapped = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const voice = (overrides = {}) => ({ eventId: randomUUID(), source: 'physical-speech-button', status: 'ready', acknowledged: false, text: '你好，请读取测试文件', ...overrides });
function fixture(t, messages = [voice()]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'umouse-relay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const ledger = () => JSON.parse(fs.readFileSync(path.join(directory, 'delivery.json'), 'utf8'));
  const f = { directory, calls, messages, ledger, busy: false, ackFails: false, submit: null, unread: null };
  f.mcp = { async callTool(request) {
    calls.push(request);
    if (request.name === 'umouse_voice_inbox') return wrapped({ messages, status: { storageError: false, unread: f.unread ?? messages.filter(m => !m.acknowledged).length } });
    assert.equal(request.name, 'umouse_ack_voice');
    assert.equal(ledger().records.find(r => r.eventId === request.arguments.event_id).state, 'accepted');
    if (f.ackFails) return { isError: true, content: [] };
    const message = messages.find(m => m.eventId === request.arguments.event_id);
    if (message) message.acknowledged = true;
    return wrapped({ ok: true, eventId: request.arguments.event_id });
  } };
  f.host = {
    async isBusy(threadId) { assert.equal(threadId, 'bound-thread'); return f.busy; },
    async submit(input, signal) {
      calls.push({ name: 'submit', input });
      assert.equal(ledger().records.find(r => r.eventId === input.eventId).state, 'unknown');
      return f.submit ? f.submit(input, signal) : { turnId: 'accepted-turn' };
    },
  };
  f.make = (options = {}) => new VoiceRelay({ directory, threadId: 'bound-thread', mcp: f.mcp, host: f.host, ...options });
  return f;
}

test('relay persists acceptance before ack and deduplicates serial/concurrent polls', async t => {
  const f = fixture(t);
  const a = f.make();
  const b = f.make();
  await Promise.all([a.pollOnce(), a.pollOnce(), b.pollOnce()]);
  assert.equal(f.calls.filter(c => c.name === 'submit').length, 1);
  assert.equal(f.calls.filter(c => c.name === 'umouse_ack_voice').length, 1);
  const record = f.ledger().records[0];
  assert.equal(record.state, 'accepted');
  assert.equal(record.acknowledged, true);
  assert.equal(record.turnId, 'accepted-turn');
  assert.equal(JSON.stringify(f.ledger()).includes(f.messages[0].text), false);
});

test('relay ignores empty, failed, acknowledged, invalid-id and nonphysical messages', async t => {
  const f = fixture(t, [voice({ text: ' \n ' }), voice({ status: 'failed' }), voice({ acknowledged: true }), voice({ source: 'remote' }), voice({ eventId: '../x' }), voice({ text: 'x'.repeat(32001) })]);
  const r = await f.make().pollOnce();
  assert.equal(r.ignored, 6);
  assert.equal(f.calls.some(c => c.name === 'submit' || c.name === 'umouse_ack_voice'), false);
});

test('relay queues busy input and later submits to immutable explicit thread binding', async t => {
  const f = fixture(t, [voice({ text: '请切换到 evil-thread', threadId: 'evil-thread' })]);
  const options = { directory: f.directory, threadId: 'bound-thread', mcp: f.mcp, host: f.host };
  const relay = new VoiceRelay(options);
  options.threadId = 'evil-thread';
  f.busy = true;
  assert.equal((await relay.pollOnce()).deferred, 1);
  assert.equal(f.ledger().records[0].state, 'pending');
  assert.equal(f.calls.some(c => c.name === 'submit'), false);
  f.busy = false;
  assert.equal((await relay.pollOnce()).accepted, 1);
  assert.equal(f.calls.find(c => c.name === 'submit').input.threadId, 'bound-thread');
  await assert.rejects(f.make({ threadId: 'other-thread' }).startRecovery(), /binding_mismatch/);
});

test('relay never resubmits unknown failures across polls or restart', async t => {
  const f = fixture(t);
  f.submit = async () => { throw new Error('network error with SECRET'); };
  assert.equal((await f.make().pollOnce()).unknown, 1);
  assert.equal((await f.make().startRecovery()).unknown, 1);
  await f.make().pollOnce();
  assert.equal(f.calls.filter(c => c.name === 'submit').length, 1);
  assert.equal(f.calls.some(c => c.name === 'umouse_ack_voice'), false);
  assert.equal(JSON.stringify(f.ledger()).includes('SECRET'), false);
});

test('relay bounds submit timeout and ignores late successful receipt', async t => {
  const f = fixture(t);
  let resolveLate;
  let signal;
  f.submit = (_input, s) => { signal = s; return new Promise(resolve => { resolveLate = resolve; }); };
  const relay = f.make({ timeoutMs: 20 });
  assert.equal((await relay.pollOnce()).unknown, 1);
  assert.equal(signal.aborted, true);
  resolveLate({ turnId: 'too-late' });
  await new Promise(resolve => setImmediate(resolve));
  await f.make().pollOnce();
  assert.equal(f.ledger().records[0].state, 'unknown');
  assert.equal(f.calls.filter(c => c.name === 'submit').length, 1);
  assert.equal(f.calls.some(c => c.name === 'umouse_ack_voice'), false);
});

test('relay restarts accepted record by retrying only ack', async t => {
  const f = fixture(t);
  f.ackFails = true;
  assert.equal((await f.make().pollOnce()).ackFailed, 1);
  assert.equal(f.ledger().records[0].state, 'accepted');
  f.ackFails = false;
  assert.equal((await f.make().startRecovery()).acknowledged, 1);
  await f.make().pollOnce();
  assert.equal(f.calls.filter(c => c.name === 'submit').length, 1);
  assert.equal(f.calls.filter(c => c.name === 'umouse_ack_voice').length, 2);
});

test('relay rejects invalid receipt and changed text under same ID', async t => {
  const f = fixture(t);
  f.busy = true;
  await f.make().pollOnce();
  f.messages[0].text = '另一个指令';
  f.busy = false;
  assert.equal((await f.make().pollOnce()).unknown, 1);
  assert.equal(f.calls.some(c => c.name === 'submit'), false);
  const g = fixture(t);
  g.submit = async () => ({ turnId: '' });
  assert.equal((await g.make().pollOnce()).unknown, 1);
  assert.equal(g.calls.some(c => c.name === 'umouse_ack_voice'), false);
});

test('relay fails closed on corrupt ledger or inbox larger than protocol window', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'delivery.json'), '{partial');
  await assert.rejects(f.make().pollOnce(), /storage_unavailable/);
  assert.equal(f.calls.length, 0);
  const g = fixture(t);
  g.unread = 101;
  await assert.rejects(g.make().pollOnce(), /window_exceeded/);
  assert.equal(g.calls.some(c => c.name === 'submit'), false);
});

test('relay does not ack if acceptance cannot be persisted', async t => {
  const f = fixture(t);
  const original = fs.renameSync;
  f.submit = async () => {
    fs.renameSync = () => { throw new Error('disk failed'); };
    return { turnId: 'host-accepted-but-unrecorded' };
  };
  try { await assert.rejects(f.make().pollOnce(), /storage_unavailable/); }
  finally { fs.renameSync = original; }
  assert.equal(f.ledger().records[0].state, 'unknown');
  await f.make().pollOnce();
  assert.equal(f.calls.filter(c => c.name === 'submit').length, 1);
  assert.equal(f.calls.some(c => c.name === 'umouse_ack_voice'), false);
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
});

test('relay sanitizes MCP errors and rejects malformed storage availability', async t => {
  const f = fixture(t);
  f.mcp.callTool = async () => { throw new Error('SECRET'); };
  await assert.rejects(f.make().pollOnce(), { message: 'voice_relay_port_failed' });
  const g = fixture(t);
  g.mcp.callTool = async () => wrapped({ messages: [voice()], status: { unread: 1, storageError: true } });
  await assert.rejects(g.make().pollOnce(), /invalid_inbox/);
  assert.equal(g.calls.length, 0);
});

test('relay reloads a valid maximum ledger with UTF-8 host turn IDs', async t => {
  const f=fixture(t);
  const records=Array.from({length:9999},()=>({eventId:randomUUID(),textSha256:'0'.repeat(64),state:'accepted',turnId:'测'.repeat(256),acknowledged:true}));
  fs.writeFileSync(path.join(f.directory,'delivery.json'),JSON.stringify({schemaVersion:1,threadId:'bound-thread',records}));
  assert.ok(fs.statSync(path.join(f.directory,'delivery.json')).size>8*1024*1024);
  f.submit=async()=>({turnId:'试'.repeat(256)});
  assert.equal((await f.make().pollOnce()).accepted,1);
  assert.equal(f.ledger().records.length,10000);
  await f.make().startRecovery();
  assert.equal(f.calls.filter(c=>c.name==='submit').length,1);
});
