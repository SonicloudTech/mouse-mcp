import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SharedDaemon } from '../dist/shared/daemon.js';
import { loadConfig } from '../dist/env.js';
import { ReconnectingConnector } from '../dist/shared/reconnecting-connector.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const value = r => JSON.parse(r.content[0].text);
async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error('condition_timeout'); await wait(25); }
}
// Real MCP stdio/pipe/daemon; the worker is an in-process lifecycle substitute.
// Never initialize a vendor DLL or share the installed hardware endpoint.
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umcp-reconnect-'));
  const token = randomUUID() + randomUUID(), pipe = `\\\\.\\pipe\\umouse-mcp-test-${randomUUID()}`;
  const options = { port: 0, pipe, testing: true, native: { testing: true },
    bridge: loadConfig({ UMSDK_DATA_DIR: dir }),
    principals: [{ id: 'reconnect', tokenSha256: createHash('sha256').update(token).digest('hex'), permissions: ['device.read', 'test'] }] };
  let workerStarts = 0, workerStops = 0;
  const daemons = [];
  const start = async (principals = options.principals) => {
    const d = new SharedDaemon({ ...options, principals });
    // Avoid NativeClient: transport regression has no hardware operations.
    d.supervisor.setCount = count => { if (count) workerStarts++; else workerStops++; };
    await d.listen(); daemons.push(d); return d;
  };
  const daemon = await start();
  const config = path.join(dir, 'connector.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, pipe, token, serviceConfig: path.join(dir, 'absent.json') }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp/dist/shared/connector.js'), config], stderr: 'pipe' });
  const client = new Client({ name: 'reconnect-regression', version: '1' });
  let stderr = ''; transport.stderr?.on('data', part => { stderr += part.toString(); });
  client.onerror = () => {};
  t.after(async () => { await client.close(); for (const d of daemons) await d.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  // connect() sends initialized; wait until the remote has consumed it before
  // tests close the owner or assert that its worker start was counted.
  await until(() => daemon.registry.count === 1);
  const status = () => client.callTool({ name: 'umouse_status', arguments: {} });
  return { dir, daemon, start, transport, client, status, config, token, options, stderr: () => stderr, workerStarts: () => workerStarts, workerStops: () => workerStops };
}

test('connector: upstream loss retains stdio, reinitializes a new owner and never replays an in-flight call', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), before = value(await f.status()), pid = f.transport.pid;
  const old = [...f.daemon.connections.values()][0];
  let calls = 0;
  old.server.tool('test_no_replay', {}, async () => { calls++; await wait(150); f.daemon.registry.close(old.ctx, 'test_disconnect'); return { content: [{ type: 'text', text: 'old result' }] }; });
  const interrupted = await f.client.callTool({ name: 'test_no_replay', arguments: {} });
  assert.equal(interrupted.isError, true);
  assert.equal(value(interrupted).retryAutomatic, false);
  await until(() => f.daemon.registry.count === 1 && [...f.daemon.connections.values()][0].ctx.connectionId !== before.connectionId);
  const after = value(await f.status());
  assert.notEqual(after.connectionId, before.connectionId);
  assert.equal(f.transport.pid, pid);
  assert.equal(calls, 1);
  // 默认两段式空闲：重连发生在宽限窗口内，worker 跨越 N=0 抖动存活（不重启、不回收）。
  assert.equal(f.workerStops(), 0);
  assert.equal(f.workerStarts(), 2);
  await f.client.close();
  await until(() => f.daemon.registry.count === 0);
  await wait(800);
  assert.equal(f.daemon.registry.count, 0);
});

test('connector: backend restart and repeated disconnects keep host PID; offline calls fail without buffering', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), pid = f.transport.pid, before = value(await f.status());
  await f.daemon.close(); await wait(100);
  const offline = await f.client.callTool({ name: 'umouse_voice_start', arguments: { client_request_id: 'never-replay' } });
  assert.equal(offline.isError, true); assert.equal(value(offline).retryAutomatic, false);
  await f.client.ping(); // The host pipe is alive even while no backend listens.
  const next = await f.start();
  await until(() => next.registry.count === 1);
  const resumed = value(await f.status()); assert.notEqual(resumed.daemonEpoch, before.daemonEpoch);
  for (let i = 0; i < 3; i++) {
    const old = [...next.connections.values()][0].ctx;
    next.registry.close(old, 'repeat');
    await until(() => next.registry.count === 1 && [...next.connections.values()][0].ctx !== old);
    assert.equal((await f.status()).isError, undefined);
  }
  assert.equal(f.transport.pid, pid);
});

test('connector: maintenance blocks admission until removed, then same stdio recovers', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), marker = path.join(f.dir, 'maintenance.json');
  await writeFile(marker, '{}'); f.daemon.registry.closeAll();
  await wait(1800);
  assert.equal(f.daemon.registry.count, 0); assert.equal(f.workerStarts(), 1);
  assert.equal((await f.status()).isError, true);
  await rm(marker);
  await until(() => f.daemon.registry.count === 1);
  assert.equal((await f.status()).isError, undefined);
});

test('connector: rotated credentials are re-read; revocation never admits cached credentials', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const rotated = randomUUID() + randomUUID();
  f.daemon.options.principals = [{ ...f.options.principals[0], tokenSha256: createHash('sha256').update(rotated).digest('hex') }];
  f.daemon.registry.closeAll(); await wait(1800);
  assert.equal(f.daemon.registry.count, 0);
  await writeFile(f.config, JSON.stringify({ schemaVersion: 1, pipe: f.options.pipe, token: rotated, serviceConfig: path.join(f.dir, 'absent.json') }));
  await until(() => f.daemon.registry.count === 1);
  assert.equal((await f.status()).isError, undefined);
  f.daemon.options.principals = []; f.daemon.registry.closeAll(); await wait(1800);
  assert.equal(f.daemon.registry.count, 0);
  assert.equal((await f.status()).isError, true);
});

test('connector: host EOF during reconnect stops retries and does not resurrect an owner', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await f.daemon.close(); await wait(100);
  await f.client.close();
  const next = await f.start(); await wait(1800);
  assert.equal(next.registry.count, 0);
});

async function memoryFixture(t, nextBehavior) {
  const replies = [], backends = [];
  const host = { start: async () => {}, send: async m => { replies.push(m); }, close: async () => host.onclose?.() };
  const result = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fixture', version: '1' } };
  const connect = async () => {
    const n = backends.length;
    const remote = { messages: [], closed: false, start: async () => {}, close: async () => { remote.closed = true; },
      send: async message => {
        remote.messages.push(message);
        if (n && nextBehavior) nextBehavior(remote, message, result);
        else if (message.method === 'initialize') queueMicrotask(() => remote.onmessage?.({ jsonrpc: '2.0', id: message.id, result }));
      } };
    backends.push(remote); return remote;
  };
  const proxy = new ReconnectingConnector(host, connect); t.after(() => proxy.close());
  await proxy.start();
  host.onmessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: result.protocolVersion, capabilities: {}, clientInfo: { name: 'memory-test', version: '1' } } });
  await wait(0);
  host.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { host, proxy, replies, backends };
}

test('static connector: reconnect never emits or forwards tool list refresh; other messages still pass', async t => {
  const f=await memoryFixture(t);
  f.backends[0].onmessage({jsonrpc:'2.0',method:'notifications/tools/list_changed'});
  f.backends[0].onclose();
  await until(()=>f.backends.length===2&&f.backends[1].messages.some(m=>m.method==='notifications/initialized'));
  f.backends[1].onmessage({jsonrpc:'2.0',method:'notifications/tools/list_changed'});
  f.backends[1].onmessage({jsonrpc:'2.0',method:'notifications/message',params:{level:'info',data:'metadata'}});
  assert.equal(f.replies.some(m=>m.method==='notifications/tools/list_changed'),false);
  assert.equal(f.replies.at(-1).method,'notifications/message');
  f.host.onmessage({jsonrpc:'2.0',id:9,method:'tools/list'});
  assert.equal(f.backends[1].messages.at(-1).method,'tools/list');
});

test('connector: changed negotiated capabilities fail closed without initializing the new owner', async t => {
  const f = await memoryFixture(t, (remote, request, result) => {
    if (request.method === 'initialize') queueMicrotask(() => remote.onmessage({ jsonrpc: '2.0', id: request.id, result: { ...result, capabilities: { logging: {} } } }));
  });
  f.backends[0].onclose();
  await until(() => f.backends.length === 2 && f.backends[1].closed);
  f.host.onmessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(f.replies.at(-1).error.message, 'connector_protocol_changed_restart_mcp');
  assert.equal(f.backends[1].messages.some(m => m.method === 'notifications/initialized'), false);
  await wait(700); assert.equal(f.backends.length, 2);
});

test('connector: stale backend replies and stale host replies cannot enter the new owner', async t => {
  const f = await memoryFixture(t);
  const first = f.backends[0];
  first.onmessage({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage', params: {} });
  const oldRequest = f.replies.at(-1);
  f.host.onmessage({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'test' } });
  first.onclose();
  await until(() => f.backends.length === 2 && f.backends[1].messages.some(m => m.method === 'notifications/initialized'));
  const second = f.backends[1];
  second.onmessage({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage', params: {} });
  const newRequest = f.replies.at(-1);
  assert.notEqual(newRequest.id, oldRequest.id);
  f.host.onmessage({ jsonrpc: '2.0', id: oldRequest.id, result: { stale: true } });
  f.host.onmessage({ jsonrpc: '2.0', id: newRequest.id, result: { fresh: true } });
  assert.equal(second.messages.some(m => m.result?.stale), false);
  assert.equal(second.messages.find(m => m.result?.fresh).id, 7);
  const count = f.replies.length;
  first.onmessage({ jsonrpc: '2.0', id: 20, result: { stale: true } });
  assert.equal(f.replies.length, count);
});

test('connector: EOF while reinitialization is pending closes the candidate and never counts it', async t => {
  const f = await memoryFixture(t, () => {});
  f.backends[0].onclose();
  await until(() => f.backends.length === 2);
  await f.proxy.close();
  assert.equal(f.backends[1].closed, true);
  assert.equal(f.backends[1].messages.some(m => m.method === 'notifications/initialized'), false);
  await wait(700); assert.equal(f.backends.length, 2);
});

test('connector: pending request bound rejects excess work without forwarding it', async t => {
  const f = await memoryFixture(t);
  for (let i = 0; i < 129; i++) f.host.onmessage({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: 'blocked' } });
  assert.equal(f.backends[0].messages.filter(m => m.method === 'tools/call').length, 128);
  assert.equal(value(f.replies.at(-1).result).error, 'connector_pending_limit');
});
