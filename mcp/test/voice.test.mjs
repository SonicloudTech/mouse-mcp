import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { VoiceInbox } from '../dist/voice.js';
import { TranscriptionError } from '../dist/transcriber.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umouse-voice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'inbox');
  const recording = (name = randomUUID()) => {
    const file = path.join(root, `${name}.wav`);
    fs.writeFileSync(file, Buffer.alloc(64, name.charCodeAt(0)));
    return { path: file, bytes: 20, durationMs: 10, deviceId: 'test-device', reason: 'key-up' };
  };
  return { root, dir, recording };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const transcript = (text) => ({ text, provider: 'fake', language: 'zh-CN' });

async function until(check, label = 'condition') {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) assert.fail(`Timed out waiting for ${label}`);
    await delay(5);
  }
}

test('captures are serial and snapshots survive deletion of original recordings', async (t) => {
  const { dir, recording } = setup(t);
  const first = deferred();
  let active = 0;
  let peak = 0;
  const paths = [];
  const inbox = new VoiceInbox(dir, async (r) => {
    peak = Math.max(peak, ++active);
    paths.push(r.path);
    if (paths.length === 1) await first.promise;
    const data = fs.readFileSync(r.path);
    active--;
    return transcript(String.fromCharCode(data[0]));
  });
  t.after(() => inbox.stop());
  inbox.start();
  const one = recording('a'); const two = recording('b');
  const ids = [inbox.capture(one), inbox.capture(two)];
  fs.unlinkSync(one.path); fs.unlinkSync(two.path);
  await until(() => paths.length === 1);
  assert.equal(inbox.status().pending, 2);
  first.resolve();
  await until(() => inbox.status().pending === 0);
  assert.equal(peak, 1);
  assert.deepEqual(inbox.list().map(m => [m.eventId, m.text]), [[ids[0], 'a'], [ids[1], 'b']]);
  for (const p of paths) assert.equal(fs.existsSync(p), false);
});

test('restart preserves unread text and marks unfinished messages interrupted without retranscribing', async (t) => {
  const { dir, recording } = setup(t);
  const original = new VoiceInbox(dir, async () => transcript('保留这句话'));
  original.start();
  const readyId = original.capture(recording());
  await until(() => original.status().pending === 0);
  await original.stop();
  const file = path.join(dir, 'inbox.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pendingId = randomUUID();
  saved.messages.push({ ...saved.messages[0], eventId: pendingId, status: 'transcribing', text: undefined, completedAt: undefined });
  fs.writeFileSync(file, JSON.stringify(saved));
  fs.writeFileSync(path.join(dir, `${pendingId}.wav`), 'orphan snapshot');
  let calls = 0;
  const restored = new VoiceInbox(dir, async () => { calls++; return transcript('must not replay'); });
  t.after(() => restored.stop());
  restored.start();
  const messages = await restored.wait(100);
  assert.equal(calls, 0);
  assert.equal(messages.find(m => m.eventId === readyId).text, '保留这句话');
  assert.equal(messages.find(m => m.eventId === pendingId).errorCode, 'interrupted');
  assert.equal(fs.existsSync(path.join(dir, `${pendingId}.wav`)), false);
  assert.equal(restored.acknowledge(readyId), true);
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.messages.find(m => m.eventId === readyId).acknowledged, true);
});

test('stop aborts active transcription and cancels queued entries without starting them', async (t) => {
  const { dir, recording } = setup(t);
  let calls = 0;
  let signal;
  const inbox = new VoiceInbox(dir, async (_, received) => {
    calls++; signal = received;
    return new Promise((resolve, reject) => received.addEventListener('abort', () => reject(new Error('private token')), { once: true }));
  });
  inbox.start();
  inbox.capture(recording()); inbox.capture(recording());
  await until(() => calls === 1);
  await inbox.stop();
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(inbox.status().pending, 0);
  assert.deepEqual(inbox.list().map(m => [m.status, m.errorCode]), [['failed', 'interrupted'], ['failed', 'interrupted']]);
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.wav')), false);
});

test('empty text and safe failure codes are terminal, with no provider exception leakage', async (t) => {
  const { dir, recording } = setup(t);
  const actions = [() => transcript('  '), () => { throw new Error('Bearer secret-token'); },
    () => { throw new TranscriptionError('timed_out', 'private audio text'); },
    () => { throw new TranscriptionError('secret-token-in-code', 'private'); }];
  const inbox = new VoiceInbox(dir, async () => actions.shift()());
  t.after(() => inbox.stop());
  inbox.start();
  for (let i = 0; i < 4; i++) inbox.capture(recording());
  await until(() => inbox.status().pending === 0);
  assert.deepEqual(inbox.list().map(m => [m.status, m.errorCode]), [
    ['empty', undefined], ['failed', 'transcription_failed'], ['failed', 'timed_out'], ['failed', 'transcription_failed'],
  ]);
  const saved = fs.readFileSync(path.join(dir, 'inbox.json'), 'utf8');
  assert.ok(!saved.includes('secret-token') && !saved.includes('private'));
});

test('queue and inbox limits reject unread eviction; acknowledged entries can be reclaimed', async (t) => {
  const { dir, recording } = setup(t);
  const gate = deferred();
  const warnings = [];
  const inbox = new VoiceInbox(dir, async () => { await gate.promise; return transcript('message'); },
    { maxPending: 1, maxMessages: 1, onEvent: (type, payload) => { if (type === 'warning') warnings.push(payload.code); } });
  t.after(() => inbox.stop());
  inbox.start();
  const id = inbox.capture(recording());
  assert.equal(inbox.capture(recording()), null);
  assert.equal(inbox.acknowledge(id), false);
  gate.resolve();
  await until(() => inbox.status().pending === 0);
  assert.equal(inbox.capture(recording()), null);
  assert.deepEqual(warnings, ['voice_queue_full', 'voice_inbox_full']);
  assert.equal(inbox.acknowledge(id), true);
  const next = inbox.capture(recording());
  assert.ok(next && next !== id);
  await until(() => inbox.status().pending === 0);
  assert.deepEqual(inbox.list(true).map(m => m.eventId), [next]);
});

test('corrupt storage remains unchanged and is never offered as a deliverable inbox', async (t) => {
  const { dir, recording } = setup(t);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'inbox.json');
  const corrupt = '{"schemaVersion":1,"messages":[{"status":"ready","text":"untrusted"}]}';
  fs.writeFileSync(file, corrupt);
  const inbox = new VoiceInbox(dir, async () => transcript('unused'));
  inbox.start();
  assert.equal(inbox.status().storageError, true);
  assert.deepEqual(inbox.list(), []);
  assert.equal(inbox.capture(recording()), null);
  await inbox.stop();
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
});

test('wait wakes when persisted text arrives and acknowledgement hides it', async (t) => {
  const { dir, recording } = setup(t);
  const gate = deferred();
  const inbox = new VoiceInbox(dir, async () => { await gate.promise; return transcript('到达'); });
  t.after(() => inbox.stop());
  inbox.start();
  const pending = inbox.wait(2000);
  const id = inbox.capture(recording());
  gate.resolve();
  const messages = await pending;
  assert.equal(messages[0].text, '到达');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'inbox.json'), 'utf8'));
  assert.equal(saved.messages[0].text, messages[0].text);
  assert.equal(inbox.acknowledge(id), true);
  assert.deepEqual(inbox.list(), []);
  assert.equal(inbox.acknowledge(id), true);
});

test('failed terminal persistence never exposes a ready result or notification', async (t) => {
  const { dir, recording } = setup(t);
  const gate = deferred();
  const events = [];
  const inbox = new VoiceInbox(dir, async () => { await gate.promise; return transcript('must remain undelivered'); },
    { onEvent: (type) => events.push(type) });
  t.after(() => inbox.stop());
  inbox.start();
  const id = inbox.capture(recording());
  await until(() => inbox.list()[0].status === 'transcribing');
  const file = path.join(dir, 'inbox.json');
  const before = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(`${file}.tmp`);
  const waiting = inbox.wait(2000);
  gate.resolve();
  assert.deepEqual(await waiting, []);
  assert.equal(inbox.status().storageError, true);
  assert.equal(inbox.list()[0].status, 'transcribing');
  assert.equal(inbox.list()[0].text, undefined);
  assert.equal(inbox.acknowledge(id), false);
  assert.equal(events.includes('speechTranscribed'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(dir, `${id}.wav`)), true);
});

test('stop persistence failure does not expose non-durable cancellation', async (t) => {
  const { dir, recording } = setup(t);
  const inbox = new VoiceInbox(dir, async () => transcript('unused'));
  inbox.start();
  inbox.capture(recording());
  const file = path.join(dir, 'inbox.json');
  fs.mkdirSync(`${file}.tmp`);
  await inbox.stop();
  assert.equal(inbox.status().storageError, true);
  assert.equal(inbox.list()[0].status, 'queued');
  assert.deepEqual(await inbox.wait(100), []);
});

test('throwing event observers cannot reject the worker or native capture path', async (t) => {
  const { dir, recording } = setup(t);
  const inbox = new VoiceInbox(dir, async () => transcript('still durable'), { maxMessages: 1,
    onEvent: () => { throw new Error('observer failure'); } });
  inbox.start();
  inbox.capture(recording());
  await until(() => inbox.status().pending === 0);
  assert.equal(inbox.list()[0].text, 'still durable');
  assert.equal(inbox.capture(recording()), null);
  await inbox.stop();
  assert.equal(inbox.status().storageError, false);
});

test('captures around worker completion continue draining, including notification reentrancy', async (t) => {
  const { dir, recording } = setup(t);
  let count = 0;
  const inbox = new VoiceInbox(dir, async () => transcript(String(++count)), {
    onEvent: (type) => { if (type === 'speechTranscribed' && count < 5) inbox.capture(recording()); },
  });
  t.after(() => inbox.stop());
  inbox.start();
  inbox.capture(recording());
  await until(() => inbox.list().filter(m => m.status === 'ready').length === 5);
  await Promise.resolve();
  inbox.capture(recording());
  await until(() => inbox.list().filter(m => m.status === 'ready').length === 6);
  assert.equal(inbox.status().pending, 0);
});

test('invalid limits fail early instead of silently disabling bounds', (t) => {
  const { dir } = setup(t);
  for (const value of [NaN, 0, -1, Infinity, 1.5]) {
    assert.throws(() => new VoiceInbox(dir, null, { maxPending: value }), /Invalid voice inbox limit/);
    assert.throws(() => new VoiceInbox(dir, null, { maxMessages: value }), /Invalid voice inbox limit/);
    assert.throws(() => new VoiceInbox(dir, null, { maxAudioBytes: value }), /Invalid voice inbox limit/);
  }
  assert.throws(() => new VoiceInbox(dir, null, { maxMessages: 101 }), /Invalid voice inbox limit/);
});

test('100 maximum-length Chinese messages survive restart; unknown stored fields are discarded', async (t) => {
  const { dir } = setup(t);
  fs.mkdirSync(dir);
  const saved = { schemaVersion: 1, messages: Array.from({ length: 100 }, () => ({
    eventId: randomUUID(), source: 'physical-speech-button', deviceId: 'test-device', capturedAt: new Date().toISOString(),
    durationMs: 600000, bytes: 19200000, status: 'ready', acknowledged: false,
    text: '中'.repeat(32000), provider: 'fake', language: 'zh-CN', unexpectedSecret: 'do not preserve',
  })) };
  const file = path.join(dir, 'inbox.json');
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.ok(fs.statSync(file).size > 8 * 1024 * 1024, 'fixture exercises former 8 MiB rejection');
  const inbox = new VoiceInbox(dir, null);
  assert.equal(inbox.status().storageError, false);
  assert.equal(inbox.list().length, 100);
  assert.equal(inbox.list()[99].text.length, 32000);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('unexpectedSecret'));
  await inbox.stop();
});
