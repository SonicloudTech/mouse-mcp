import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { NativeClient } from '../dist/shared/native-client.js';

const root = path.resolve('mcp/sdk-host/build/bin');
const executable = path.join(root, 'umouse-sdk-host.exe');
const enabled = process.platform === 'win32' && existsSync(executable);
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umcp-native-test-'));
  const dll = path.join(root, options.dll ?? 'umcp_fake.dll');
  const spec = { id: 'fake', path: dll, sha256: createHash('sha256').update(await readFile(dll)).digest('hex'), required: true, config: {}, ...options.spec };
  const manifest = path.join(dir, 'bundle.json');
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, profile: 'test', root, testNamespace: options.namespace ?? randomUUID(), plugins: [spec] }));
  const client = new NativeClient({ executable, manifest, testing: true, startupMs: 2000, shutdownMs: 500, requestMs: 2000,
    ...(options.diagnostics?{diagnosticsDirectory:path.join(dir,'diagnostics')}:{}) });
  t.after(async () => { await client.stop(); await rm(dir, { recursive: true, force: true }); });
  return client;
}
const native = (name, fn) => test(name, { skip: !enabled }, fn);
native('native: rejected RPC retains timestamp and bounded code but no response payload',async t=>{
  const c=await fixture(t,{diagnostics:true});await c.start();
  await c.request('fake','echo',{secret:'private_response_text'});
  await assert.rejects(c.request('fake','no-such-method',{}),/fake_method_unknown/);await c.stop();
  const dir=c.options.diagnosticsDirectory;
  const text=(await Promise.all((await readdir(dir)).map(f=>readFile(path.join(dir,f),'utf8')))).join('');
  const rows=text.trim().split('\n').map(JSON.parse);const error=rows.find(r=>r.stage==='native.response.received'&&r.ok===false);
  assert.equal(error.errorCode,'fake_method_unknown');assert.ok(Number.isFinite(Date.parse(error.utc)));assert.ok(error.rpcId);
  assert.doesNotMatch(text,/private_response_text/);
});
native('native: handshake, Unicode roundtrip, logs cannot corrupt RPC, clean stop', async t => {
  const c = await fixture(t); const ready = await c.start();
  assert.equal(ready.sdkInitialized, false); assert.equal(ready.plugins[0].id, 'fake');
  assert.match(ready.sid, /^S-1-/);
  assert.deepEqual(await c.request('fake', 'echo', { message: '语音 🌟', n: 3 }), { message: '语音 🌟', n: 3 });
  assert.deepEqual(await c.request('fake', 'log', {}), { logged: true });
  const event = once(c, 'event');
  await c.request('fake', 'event', { text: 'private' });
  assert.equal((await event)[0].event.text, 'private');
  await assert.rejects(c.request('fake', 'no-such-method', {}), /fake_method_unknown/);
  const stopped = await c.stop(); assert.equal(stopped.clean, true); assert.equal(c.alive, false);
  assert.match(stopped.diagnostics, /native stdout/);
});
native('native: hash mismatch fails closed', async t => {
  const c = await fixture(t, { spec: { sha256: '0'.repeat(64) } });
  await assert.rejects(c.start(), /worker_start_failed/);
  assert.match((await c.stop()).diagnostics, /hash_mismatch/);
});
native('native: ABI mismatch fails closed', async t => {
  const c = await fixture(t, { dll: 'umcp_bad_abi.dll' });
  await assert.rejects(c.start(), /worker_start_failed/);
  assert.match((await c.stop()).diagnostics, /plugin_abi_mismatch/);
});
native('native: optional plugin failure is explicit and unavailable', async t => {
  const c = await fixture(t, { spec: { required: false, sha256: '0'.repeat(64) } });
  const r = await c.start(); assert.equal(r.plugins.length, 0); assert.equal(r.unavailable[0].id, 'fake');
  await assert.rejects(c.request('fake', 'echo', {}), /plugin_unavailable/);
});
native('native: second owner denied, lease reusable only after first exit', async t => {
  const namespace = randomUUID(); const first = await fixture(t, { namespace }); await first.start();
  const second = await fixture(t, { namespace }); await assert.rejects(second.start(), /worker_start_failed/);
  assert.match((await second.stop()).diagnostics, /owner_busy/);
  await first.stop(); const third = await fixture(t, { namespace }); await third.start();
});
native('native: cancelling a queued request does not cancel the active request', async t => {
  const c = await fixture(t); await c.start();
  const active = c.request('fake', 'delay', { ms: 150 });
  const abort = new AbortController();
  const queued = c.request('fake', 'delay', { ms: 1000 }, abort.signal);
  const rejected = assert.rejects(queued, /cancelled/); abort.abort(); await rejected;
  assert.equal((await active).cancelled, false);
  const start = performance.now(); await c.request('fake', 'echo', {});
  assert.ok(performance.now() - start < 500, 'cancelled queued request must not execute its delay');
});
native('native: running cancellation leaves next operation usable', async t => {
  const c = await fixture(t); await c.start(); const abort = new AbortController();
  const pending = c.request('fake', 'delay', { ms: 1000 }, abort.signal);
  const rejected = assert.rejects(pending, /cancelled/); setTimeout(() => abort.abort(), 40); await rejected;
  assert.equal((await c.request('fake', 'delay', { ms: 10 })).cancelled, false);
});
native('native: action cancellation waits for native terminal instead of releasing its owner early', async t => {
  const c = await fixture(t); await c.start(); const abort = new AbortController();
  const pending = c.request('fake', 'delay', { ms: 1000 }, abort.signal, { awaitTerminalOnCancel: true });
  await new Promise(r => setTimeout(r, 30)); abort.abort();
  assert.equal((await pending).cancelled, true);
  assert.equal((await c.request('fake', 'delay', { ms: 5 })).cancelled, false);
});
native('native: crash rejects pending call without replay', async t => {
  const c = await fixture(t); await c.start();
  await assert.rejects(c.request('fake', 'crash', {}), /worker_exited/);
  assert.equal((await c.stop()).exitCode, 86);
});
native('native: uncooperative plugin is force stopped within budget', async t => {
  const c = await fixture(t); await c.start();
  const pending = assert.rejects(c.request('fake', 'hang', {}), /worker_exited/);
  await new Promise(r => setTimeout(r, 100)); const started = performance.now();
  const result = await c.stop(); await pending;
  assert.equal(result.clean, false); assert.ok(performance.now() - started < 2000);
});
native('native: failed plugin stop cannot be reported as clean', async t => {
  const c = await fixture(t, { spec: { config: { failStop: true } } }); await c.start();
  const result = await c.stop(); assert.equal(result.clean, false); assert.equal(result.exitCode, 75);
});
native('native: parent crash kills a hung native host via its independent watchdog', async t => {
  const fixtureClient = await fixture(t);
  const parent = spawn(process.execPath, [path.resolve('mcp/test/fixtures/native-parent.mjs'), executable, fixtureClient.options.manifest], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (parent.exitCode === null) parent.kill(); });
  const line = await Promise.race([once(parent.stdout, 'data'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('parent fixture timeout')), 3000); timer.unref(); })]);
  const pid = JSON.parse(line[0].toString()).nativePid;
  assert.ok(pid > 0); parent.kill(); await once(parent, 'close');
  let alive = true;
  for (let i = 0; i < 60; i++) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(alive, false, 'native child must not outlive its authenticated parent');
});
native('native: TCP owner is read from Windows, not a client-supplied identity', async t => {
  const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const accepted = once(server, 'connection'); const client = net.createConnection(server.address().port, '127.0.0.1');
  const [socket] = await accepted;
  t.after(async () => { socket.destroy(); client.destroy(); await new Promise(r => server.close(r)); });
  const { stdout } = await promisify(execFile)(executable, ['--tcp-owner', String(socket.localPort), String(socket.remotePort)], { windowsHide: true });
  const peer = JSON.parse(stdout); assert.equal(peer.pid, process.pid); assert.match(peer.sid, /^S-1-/); assert.ok(Number.isInteger(peer.windowsSessionId));
});
