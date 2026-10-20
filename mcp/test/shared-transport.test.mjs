import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SharedDaemon } from '../dist/shared/daemon.js';
import { loadConfig } from '../dist/env.js';
import { connectSocket } from '../dist/shared/connector.js';
import { PIPE_PROTOCOL, tokenHash, keyId, proof } from '../dist/shared/pipe-auth.js';
import { SharedInput } from '../dist/shared/input-manager.js';
import { ResourceArbiter } from '../dist/shared/resource-arbiter.js';

const root = path.resolve('mcp/sdk-host/build/bin');
const executable = path.join(root, 'umouse-sdk-host.exe');
const enabled = process.platform === 'win32' && existsSync(executable);
const hash = b => createHash('sha256').update(b).digest('hex');
const content = response => JSON.parse(response.content[0].text);

async function fixture(t, input = false, options = {}, env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umcp-daemon-test-'));
  const manifest = path.join(dir, 'manifest.json');
  const dll = path.join(root, 'umcp_fake.dll');
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, profile: 'test', root, testNamespace: randomUUID(), plugins: [
    { id: 'fake', path: dll, sha256: hash(await readFile(dll)), required: true, config: {} },
  ] }));
  const a = randomBytes(32).toString('hex'), b = randomBytes(32).toString('hex');
  const daemon = new SharedDaemon({ ...options, port: 0, pipe: `\\\\.\\pipe\\umouse-mcp-test-${randomUUID()}`, testing: true,
    native: { executable, manifest, testing: true, shutdownMs: 500 },
    // 传输回归默认旧语义（N=0 立即回收 worker）；两段式空闲由专项用例经 env 覆盖
    bridge: loadConfig({ UMSDK_DATA_DIR: dir, UMSDK_INJECTION: input ? '1' : '0', UMSDK_IDLE_WORKER_MS: '0', UMSDK_IDLE_EXIT_MS: '0', ...env }),
    principals: [{ id: 'a', tokenSha256: hash(a), permissions: ['device.read', 'test', ...(input?['input.control']:[])] }, { id: 'b', tokenSha256: hash(b), permissions: ['device.read'] }] });
  await daemon.listen();
  t.after(async () => { await daemon.close(); await rm(dir, { recursive: true, force: true }); });
  return { daemon, a, b, dir, url: `http://127.0.0.1:${daemon.address.port}/mcp` };
}
async function httpClient(t, url, token) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'offline-http-test', version: '1' });
  await client.connect(transport);
  t.after(async () => { await transport.terminateSession().catch(() => {}); await client.close(); });
  return { client, transport };
}

test('shared MCP task: same-principal connections cannot steal ownership; explicit failure permits next command', {skip:!enabled},async t=>{
  const f=await fixture(t,true),a=await httpClient(t,f.url,f.a),other=await httpClient(t,f.url,f.a),read=await httpClient(t,f.url,f.b);
  await f.daemon.supervisor.settled();let calls=0;
  const input=new SharedInput({dataDir:f.dir,enabled:true,arbiter:new ResourceArbiter('task-test'),
    devices:()=>[{id:'fake',generation:1}],allowed:()=>true,native:{epoch:'task-test',request:async()=>{
      ++calls;return {outcome:calls===1?'indeterminate':'completed',transport:{attempted:1,written:1,writeFailed:0},cleanup:'not_needed',effectConfirmed:false};
    }}});
  f.daemon.runtime={input,stop:()=>input.stop(),releaseOwner:owner=>input.release(owner)};
  const call=async(c,name,args)=>content(await c.callTool({name,arguments:args}));
  const begin=await call(a.client,'umouse_control',{operation:'begin',task_id:'draw'});
  assert.ok(begin.control_id);assert.equal(begin.owned,true);
  assert.equal((await call(other.client,'umouse_control',{operation:'begin',task_id:'other'})).error,'control_busy');
  assert.equal((await call(a.client,'umouse_control',{operation:'begin',task_id:'other'})).error,'control_busy');
  assert.equal((await read.client.callTool({name:'umouse_control',arguments:{operation:'begin',task_id:'forbidden'}})).isError,true);
  const args={device_id:'fake',control_id:begin.control_id,frames:[{kind:'mouse',dx:1}],client_request_id:'first'};
  const failed=await call(a.client,'umouse_input_sequence',args);assert.equal(failed.outcome,'indeterminate');assert.equal(calls,1);
  assert.equal((await call(a.client,'umouse_input_sequence',args)).outcome,'indeterminate');assert.equal(calls,1,'failed request is not replayed');
  assert.equal((await call(a.client,'umouse_input_sequence',{...args,client_request_id:'next'})).outcome,'completed');assert.equal(calls,2);
  assert.equal((await call(other.client,'umouse_control',{operation:'status'})).control_id,undefined);
  await a.transport.terminateSession();await new Promise(r=>setImmediate(r));
  const next=await call(other.client,'umouse_control',{operation:'begin',task_id:'next'});assert.ok(next.control_id);assert.notEqual(next.control_id,begin.control_id);
  assert.equal((await call(other.client,'umouse_input_sequence',{...args,client_request_id:'stale'})).error,'control_token_invalid');
  await call(other.client,'umouse_control',{operation:'end',control_id:next.control_id});assert.equal(input.control.status('').active,false);
});

test('status retains persisted input uncertainty when SDK runtime is absent', {skip:!enabled},async t=>{
  const f=await fixture(t,true);await f.daemon.supervisor.shutdown();
  const marker=path.join(f.dir,'shared-v2','input-uncertain.json');await mkdir(path.dirname(marker),{recursive:true});
  await writeFile(marker,JSON.stringify({schemaVersion:1,reason:'input_uncertain'}));
  const a=await httpClient(t,f.url,f.a);
  const status=content(await a.client.callTool({name:'umouse_status',arguments:{}}));
  assert.equal(status.inputUncertain,true);assert.deepEqual(status.availableInputTools,['umouse_control','umouse_mouse_action','umouse_input_sequence']);assert.ok(existsSync(marker));
  assert.deepEqual(status.voice,{enabled:true,runtimeReady:false,reason:'sdk_stopped'});
  assert.equal(status.inputUncertainScopes,null,'without a runtime the scoped native health is unknown');
  await rm(marker);assert.equal(content(await a.client.callTool({name:'umouse_status',arguments:{}})).inputUncertain,false);
});

for(const reason of ['response-deadline','owner-expiry']) test(`audit S-P1-1 ${reason} reclaims a non-reading HTTP owner without closing healthy owner`,{skip:!enabled},async t=>{
  const f=await fixture(t,false,{testHttpResponseTimeoutMs:1500});
  const a=await httpClient(t,f.url,f.a),b=await httpClient(t,f.url,f.b);await f.daemon.supervisor.settled();
  const owner=[...f.daemon.connections.values()].find(c=>c.ctx.principalId==='a');
  const diagnostic={called:false,sent:0,status:0,reservations:[],keys:[]};
  const reserve=f.daemon.outputBudget.reserve.bind(f.daemon.outputBudget);f.daemon.outputBudget.reserve=n=>{diagnostic.reservations.push(n);return reserve(n);};
  owner.server.tool('audit_large',{},async()=>{diagnostic.called=true;return{content:[{type:'text',text:'x'.repeat(8*1024*1024)}]};});
  const send=owner.transport.send.bind(owner.transport);owner.transport.send=(m,o)=>{if(m.id===91){diagnostic.sent=Buffer.byteLength(JSON.stringify(m));diagnostic.keys=[...f.daemon.httpReplies.keys()];}return send(m,o);};
  // Windows can buffer the whole 8 MiB reply even with client.pause(). Inject
  // a stalled write completion on this test socket to deterministically model
  // a full kernel send buffer; the real HTTP/MCP timeout and teardown still run.
  f.daemon.httpServer.on('request',(req,res)=>{if(req.headers['x-audit-stall']==='1'){
    res.write=()=>false;res.end=()=>res;
    res.on('close',()=>{diagnostic.status=res.statusCode;});
  }});
  const socket=net.connect(f.daemon.address.port,'127.0.0.1');socket.on('error',()=>{});t.after(()=>socket.destroy());
  await once(socket,'connect');socket.pause();
  const body=JSON.stringify({jsonrpc:'2.0',id:91,method:'tools/call',params:{name:'audit_large',arguments:{}}});
  socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${f.daemon.address.port}\r\nAuthorization: Bearer ${f.a}\r\nMcp-Session-Id: ${a.transport.sessionId}\r\nContent-Type: application/json\r\nX-Audit-Stall: 1\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  const until=async predicate=>{const end=Date.now()+4000;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(predicate(),JSON.stringify({...diagnostic,bytes:f.daemon.outputBudget.bytes,replies:f.daemon.httpReplies.size,owners:f.daemon.registry.count}));};
  await until(()=>f.daemon.outputBudget.bytes>1024*1024);
  if(reason==='owner-expiry') f.daemon.registry.close(owner.ctx,'test_expiry');
  await until(()=>f.daemon.outputBudget.bytes===0&&f.daemon.httpReplies.size===0&&f.daemon.registry.count===1);
  assert.equal(f.daemon.activeHttp,1); // healthy owner's long-lived GET notification stream
  assert.equal(content(await b.client.callTool({name:'umouse_status',arguments:{}})).state,'running');
});
test('shared HTTP: authenticated logical sessions share one native fake worker; zero clients keeps daemon listening', { skip: !enabled }, async t => {
  const f = await fixture(t); assert.equal(f.daemon.registry.count, 0); assert.equal(f.daemon.supervisor.state, 'stopped');
  const a = await httpClient(t, f.url, f.a); const b = await httpClient(t, f.url, f.b);
  await f.daemon.supervisor.settled(); assert.equal(f.daemon.registry.count, 2);
  const sa = content(await a.client.callTool({ name: 'umouse_status', arguments: {} }));
  const sb = content(await b.client.callTool({ name: 'umouse_status', arguments: {} }));
  assert.equal(sa.pid, sb.pid); assert.notEqual(sa.connectionId, sb.connectionId); assert.equal(sa.state, 'running');
  assert.deepEqual(content(await a.client.callTool({ name: 'umouse_test_echo', arguments: { value: '跨进程 🌟' } })), { value: '跨进程 🌟' });
  const denied = await b.client.callTool({ name: 'umouse_test_echo', arguments: { value: 'denied' } }); assert.equal(denied.isError, true);
  await a.transport.terminateSession(); await a.client.close(); assert.equal(f.daemon.registry.count, 1);
  assert.equal(content(await b.client.callTool({ name: 'umouse_status', arguments: {} })).pid, sb.pid);
  await b.transport.terminateSession(); await b.client.close(); await f.daemon.supervisor.settled();
  assert.equal(f.daemon.registry.count, 0); assert.equal(f.daemon.supervisor.state, 'stopped');
  const response = await fetch(f.url); assert.equal(response.status, 401);
});
test('shared idle: grace keeps the worker across an N=0 flap, then retires it while the daemon keeps listening', { skip: !enabled }, async t => {
  const f = await fixture(t, false, {}, { UMSDK_IDLE_WORKER_MS: '1500', UMSDK_IDLE_EXIT_MS: '0' });
  const a = await httpClient(t, f.url, f.a);
  await f.daemon.supervisor.settled(); assert.equal(f.daemon.supervisor.state, 'running');
  const pid = content(await a.client.callTool({ name: 'umouse_status', arguments: {} })).pid;
  await a.transport.terminateSession(); await a.client.close();
  await new Promise(r => setTimeout(r, 400));
  assert.equal(f.daemon.registry.count, 0);
  assert.equal(f.daemon.supervisor.state, 'running');               // 宽限窗口内：worker 不因抖动重启
  const b = await httpClient(t, f.url, f.b);
  await f.daemon.supervisor.settled();
  assert.equal(content(await b.client.callTool({ name: 'umouse_status', arguments: {} })).pid, pid);  // 同一 worker 存活
  await b.transport.terminateSession(); await b.client.close();
  await new Promise(r => setTimeout(r, 2200));
  await f.daemon.supervisor.settled();
  assert.equal(f.daemon.supervisor.state, 'stopped');               // 宽限耗尽：worker 回收
  const response = await fetch(f.url); assert.equal(response.status, 401);  // daemon（exitMs=0）仍监听
});
test('shared HTTP: bad token, Origin, Host and stolen session cannot reach another owner', { skip: !enabled }, async t => {
  const f = await fixture(t); const a = await httpClient(t, f.url, f.a);
  const auth = { Authorization: `Bearer ${f.a}` };
  assert.equal((await fetch(f.url, { headers: { Authorization: 'Bearer ' + 'x'.repeat(64) } })).status, 401);
  assert.equal((await fetch(f.url, { headers: { ...auth, Origin: 'https://evil.example' } })).status, 403);
  // Fetch may normalize Host; use the raw HTTP API to actually send a hostile Host.
  const hostileHost = await new Promise((resolve, reject) => {
    http.get(f.url, { headers: { ...auth, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostileHost, 403);
  assert.equal((await fetch(f.url, { method: 'DELETE', headers: { Authorization: `Bearer ${f.b}`, 'Mcp-Session-Id': a.transport.sessionId } })).status, 404);
  assert.equal(f.daemon.registry.count, 1);
});
test('shared mixed transports: stdio connector and HTTP use one worker; connector EOF releases only its owner', { skip: !enabled }, async t => {
  const f = await fixture(t); const h = await httpClient(t, f.url, f.a);
  const cfg = path.join(f.dir, 'connector.json');
  await writeFile(cfg, JSON.stringify({ schemaVersion: 1, pipe: f.daemon.address.pipe, token: f.b, serviceConfig: path.join(f.dir, 'unused.json') }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp/dist/shared/connector.js'), cfg], stderr: 'pipe' });
  const client = new Client({ name: 'offline-stdio-test', version: '1' }); t.after(() => client.close());
  await client.connect(transport); await f.daemon.supervisor.settled();
  const first = content(await client.callTool({ name: 'umouse_status', arguments: {} }));
  const second = content(await h.client.callTool({ name: 'umouse_status', arguments: {} }));
  assert.equal(first.pid, second.pid); assert.equal(f.daemon.registry.count, 2);
  assert.equal(first.liveness, 'stdio-heartbeat');
  await client.close();
  for (let i = 0; i < 40 && f.daemon.registry.count !== 1; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(f.daemon.registry.count, 1); assert.equal(f.daemon.supervisor.state, 'running');
});

test('shared connector recovery: one stdio survives native fake worker stop/start with a new owner', { skip: !enabled }, async t => {
  const f = await fixture(t), cfg = path.join(f.dir, 'recovery-connector.json');
  await writeFile(cfg, JSON.stringify({ schemaVersion: 1, pipe: f.daemon.address.pipe, token: f.a, serviceConfig: path.join(f.dir, 'unused.json') }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp/dist/shared/connector.js'), cfg], stderr: 'pipe' });
  const client = new Client({ name: 'offline-native-reconnect', version: '1' }); t.after(() => client.close());
  await client.connect(transport); await f.daemon.supervisor.settled();
  const before = content(await client.callTool({ name: 'umouse_status', arguments: {} })), connectorPid = transport.pid;
  const old = [...f.daemon.connections.values()][0].ctx;
  f.daemon.registry.close(old, 'test_transport_reset');
  await f.daemon.supervisor.settled();
  assert.equal(f.daemon.supervisor.state, 'stopped');
  assert.equal(f.daemon.supervisor.status.lastStop.clean, true);
  for (let i=0;i<100 && f.daemon.registry.count!==1;i++) await new Promise(r=>setTimeout(r,50));
  assert.equal(f.daemon.registry.count,1); await f.daemon.supervisor.settled();
  const after = content(await client.callTool({ name: 'umouse_status', arguments: {} }));
  assert.equal(transport.pid,connectorPid); assert.notEqual(after.connectionId,before.connectionId);
  assert.notEqual(after.workerEpoch,before.workerEpoch); assert.equal(after.state,'running');
  assert.deepEqual(content(await client.callTool({name:'umouse_test_echo',arguments:{value:'new-call-only'}})),{value:'new-call-only'});
});

test('shared pipe: a squatted endpoint cannot receive bearer token or full secret hash', { skip: !enabled }, async () => {
  const pipe = `\\\\.\\pipe\\umouse-mcp-test-${randomUUID()}`, token = randomBytes(32).toString('hex');
  const observed = [];
  const impostor = net.createServer(socket => {
    socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.once('data', data => {
      observed.push(data);
      socket.write(JSON.stringify({ protocol: PIPE_PROTOCOL, daemonEpoch: randomUUID(), serverNonce: randomBytes(32).toString('hex'), proof: '0'.repeat(64) }) + '\n');
    });
  });
  await new Promise(r => impostor.listen(pipe, r));
  try {
    await assert.rejects(connectSocket({ schemaVersion: 1, pipe, token, serviceConfig: 'unused' }), /service_authentication_failed/);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].includes(token), false); assert.equal(observed[0].includes(tokenHash(token)), false);
    assert.equal('token' in JSON.parse(observed[0]), false);
  } finally { await new Promise(r => impostor.close(r)); }
});

test('shared pipe: captured client proof cannot be replayed on a new challenge', { skip: !enabled }, async t => {
  const f = await fixture(t); const hash = tokenHash(f.a), nonce = randomBytes(32).toString('hex'); let capturedProof, previousNonce;
  for (const replay of [false, true]) {
    const socket = net.createConnection(f.daemon.address.pipe); socket.setEncoding('utf8');
    socket.on('error', () => {}); await once(socket, 'connect');
    const challengeReceived = once(socket, 'data');
    socket.write(JSON.stringify({ protocol: PIPE_PROTOCOL, keyId: keyId(hash), clientNonce: nonce }) + '\n');
    const challenge = JSON.parse((await challengeReceived)[0]);
    if (replay) assert.notEqual(challenge.serverNonce, previousNonce);
    else { previousNonce = challenge.serverNonce; capturedProof = proof(hash, 'client', nonce, challenge.serverNonce, challenge.daemonEpoch); }
    const response = once(socket, replay ? 'close' : 'data');
    socket.write(JSON.stringify({ protocol: PIPE_PROTOCOL, proof: capturedProof }) + '\n');
    await response; socket.destroy();
  }
  assert.equal(f.daemon.registry.count, 0); assert.equal(f.daemon.supervisor.state, 'stopped');
});

test('shared MCP hardware: permission, owner isolation and at-most-once direct action', {skip:!enabled}, async t=>{
  const f=await fixture(t,true),a=await httpClient(t,f.url,f.a),b=await httpClient(t,f.url,f.b);await f.daemon.supervisor.settled();
  const calls=[],released=[];
  const input={blocked:false,canInput:true,control:{status:()=>({active:false})},runMouse:async(owner,args)=>{calls.push({owner,args});return {outcome:'completed',effectConfirmed:false};}};
  f.daemon.runtime={input,stop:async()=>{},releaseOwner:async owner=>released.push(owner)};
  const names=async client=>(await client.listTools()).tools.map(x=>x.name);
  assert.ok((await names(a.client)).includes('umouse_mouse_action'));assert.ok(!(await names(b.client)).includes('umouse_mouse_action'));
  assert.equal((await names(a.client)).some(n=>n.includes('cua')),false);
  const ownerA=content(await a.client.callTool({name:'umouse_status',arguments:{}})).connectionId;
  const args={device_id:'exact',action:{kind:'click',x:1,y:1},client_request_id:'same',timeout_ms:1000};
  assert.equal(content(await a.client.callTool({name:'umouse_mouse_action',arguments:args})).effectConfirmed,false);
  await a.client.callTool({name:'umouse_mouse_action',arguments:args});assert.equal(calls.length,1);assert.equal(calls[0].owner,ownerA);
  assert.equal(content(await a.client.callTool({name:'umouse_mouse_action',arguments:{...args,pid:2,window_id:'2'}})).error,'request_id_conflict');
  assert.equal((await b.client.callTool({name:'umouse_mouse_action',arguments:args})).isError,true);
  input.canInput=false;assert.ok((await names(a.client)).includes('umouse_mouse_action'));
  assert.equal(content(await a.client.callTool({name:'umouse_mouse_action',arguments:{...args,client_request_id:'revoked'}})).error,'capability_unavailable');
  assert.equal(calls.length,1);await a.transport.terminateSession();assert.deepEqual(released,[ownerA]);
});

test('shared MCP input sequence: static visibility, permission, idempotency and execution revocation', {skip:!enabled}, async t=>{
  const f=await fixture(t,true),a=await httpClient(t,f.url,f.a),b=await httpClient(t,f.url,f.b);await f.daemon.supervisor.settled();
  const calls=[];const input={canInput:false,canSequence:true,runSequence:async(owner,args)=>{calls.push({owner,args});return {outcome:'completed',effectConfirmed:false};}};
  f.daemon.runtime={input,stop:async()=>{},releaseOwner:async()=>{}};
  const names=async c=>(await c.listTools()).tools.map(x=>x.name);
  assert.ok((await names(a.client)).includes('umouse_input_sequence'));assert.ok((await names(a.client)).includes('umouse_mouse_action'));
  assert.ok(!(await names(b.client)).includes('umouse_input_sequence'));
  const args={pid:1,window_id:'2',device_id:'exact',client_request_id:'input1',frames:[{kind:'keyboard',keys:[4]}]};
  await a.client.callTool({name:'umouse_input_sequence',arguments:args});await a.client.callTool({name:'umouse_input_sequence',arguments:args});assert.equal(calls.length,1);
  assert.equal(content(await a.client.callTool({name:'umouse_input_sequence',arguments:{...args,pid:2}})).error,'request_id_conflict');
  assert.equal((await b.client.callTool({name:'umouse_input_sequence',arguments:args})).isError,true);
  assert.equal((await a.client.callTool({name:'umouse_input_sequence',arguments:{...args,client_request_id:'bad',frames:[{kind:'keyboard',keys:[1]}]}})).isError,true);
  input.runSequence=async()=>({outcome:'rejected',effectConfirmed:false});
  assert.equal((await a.client.callTool({name:'umouse_input_sequence',arguments:{...args,client_request_id:'focus'}})).isError,true);
  input.canSequence=false;assert.ok((await names(a.client)).includes('umouse_input_sequence'));
  assert.equal((await a.client.callTool({name:'umouse_input_sequence',arguments:{...args,client_request_id:'revoked'}})).isError,true);
  assert.equal(calls.length,1);
});

for (const kind of ['http', 'stdio']) test(`static discovery ${kind}: cold first list exposes input without waiting for SDK or hardware`, {skip:!enabled}, async t=>{
  const f=await fixture(t,true);
  f.daemon.options.bridge.voiceTestCaps={device:{mouse_control:'supported',keyboard_control:'supported'}};
  f.daemon.options.bridge.keyboardInjection=true;
  let client;
  if(kind==='http') client=(await httpClient(t,f.url,f.a)).client;
  else {
    const cfg=path.join(f.dir,'discovery-connector.json');await writeFile(cfg,JSON.stringify({schemaVersion:1,pipe:f.daemon.address.pipe,token:f.a,serviceConfig:path.join(f.dir,'absent.json')}));
    const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('mcp/dist/shared/connector.js'),cfg],stderr:'pipe'});
    client=new Client({name:'discovery-fixture',version:'1'});await client.connect(transport);t.after(()=>client.close());
  }
  // Never create a runtime: this used to wait eight seconds and hide both tools.
  const names=(await client.listTools()).tools.map(x=>x.name);
  assert.ok(names.includes('umouse_input_sequence'),'first discovery must not cache a voice-only list');
  assert.ok(names.includes('umouse_mouse_action'));
  assert.equal(client.getServerCapabilities().tools.listChanged,false);
  const s=content(await client.callTool({name:'umouse_status',arguments:{}}));
  assert.deepEqual(s.availableInputTools,['umouse_control','umouse_mouse_action','umouse_input_sequence']);
  assert.ok(s.toolDiscovery.lastTools.includes('umouse_input_sequence'));assert.equal(s.toolDiscovery.timedOut,false);
  assert.equal(s.toolDiscovery.mode,'static');assert.equal(s.toolDiscovery.lastWaitMs,0);
  assert.deepEqual(s.inputCapabilitiesReady,{mouse:false,sequence:false});
  await f.daemon.supervisor.settled();
  for(const [name,args] of [
    ['umouse_input_sequence',{pid:1,window_id:'2',device_id:'exact',client_request_id:'cold-key',frames:[{kind:'keyboard',keys:[36]}]}],
    ['umouse_mouse_action',{device_id:'exact',client_request_id:'cold-mouse',action:{kind:'click',x:1,y:1}}],
  ]) {
    const r=await client.callTool({name,arguments:args});assert.equal(r.isError,true);assert.equal(content(r).error,'runtime_unavailable');
  }
});

for (const order of ['initialized-then-list', 'list-then-initialized', 'invalid-initialized-then-list']) {
  test(`static discovery batched delivery: ${order} respects protocol message order`, {skip:!enabled}, async t=>{
    const f=await fixture(t,true);await f.daemon.supervisor.shutdown();
    // Deterministically model SocketTransport receiving multiple frames in one
    // chunk. No timers, real SDK process or packet-boundary assumptions.
    const replies=new Map(),pending=new Map();
    const transport={async start(){},async close(){transport.onclose?.();},async send(message){
      if('id' in message&&!('method' in message)){replies.set(message.id,message);pending.get(message.id)?.(message);pending.delete(message.id);}
    }};
    const response=id=>replies.has(id)?Promise.resolve(replies.get(id)):new Promise(resolve=>pending.set(id,resolve));
    const conn=f.daemon.createConnection(f.daemon.options.principals[0],'stdio-heartbeat',transport);
    await conn.server.connect(transport);
    transport.onmessage({jsonrpc:'2.0',id:701,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'batched-discovery-fake',version:'1'}}});
    await response(701);assert.equal(f.daemon.registry.count,0);
    const initialized={jsonrpc:'2.0',method:'notifications/initialized'};
    const list={jsonrpc:'2.0',id:702,method:'tools/list'};
    if(order==='list-then-initialized'){transport.onmessage(list);transport.onmessage(initialized);}
    else {transport.onmessage(order==='invalid-initialized-then-list'?{...initialized,params:42}:initialized);transport.onmessage(list);}
    const first=await response(702);
    if(order==='initialized-then-list') {
      assert.equal(first.error,undefined,'valid initialized notification must precede the next coalesced discovery check');
      assert.ok(first.result.tools.some(tool=>tool.name==='umouse_input_sequence'));
      assert.equal(f.daemon.registry.count,1);
    } else {
      assert.equal(first.error.message,'connection_not_initialized','later or invalid initialized must not authorize an earlier list');
      if(order==='invalid-initialized-then-list'){assert.equal(f.daemon.registry.count,0);transport.onmessage(initialized);}
      transport.onmessage({...list,id:703});
      const retried=await response(703);assert.equal(retried.error,undefined,'rejected pre-initialization discovery must not poison the valid owner');
      assert.ok(retried.result.tools.some(tool=>tool.name==='umouse_mouse_action'));
    }
    assert.equal(f.daemon.supervisor.state,'stopped','discovery must not require a running SDK');
    await conn.server.close();
  });
}

test('static discovery: undeclared hardware keeps descriptors; read-only principals do not gain input', {skip:!enabled}, async t=>{
  const f=await fixture(t,true),a=await httpClient(t,f.url,f.a),b=await httpClient(t,f.url,f.b);
  await a.client.listTools();const s=content(await a.client.callTool({name:'umouse_status',arguments:{}}));
  assert.equal(s.toolDiscovery.timedOut,false);assert.equal(s.toolDiscovery.lastWaitMs,0);assert.deepEqual(s.availableInputTools,['umouse_control','umouse_mouse_action','umouse_input_sequence']);
  f.daemon.options.bridge.voiceTestCaps={d:{mouse_control:'supported'}};
  assert.ok(!(await b.client.listTools()).tools.some(x=>x.name==='umouse_input_sequence'));
  assert.equal(content(await b.client.callTool({name:'umouse_status',arguments:{}})).toolDiscovery.lastWaitMs,0);
});
test('static discovery: SDK state and capabilities do not mutate list or emit refresh notifications', {skip:!enabled}, async t=>{
  const f=await fixture(t,true);f.daemon.options.bridge.voiceTestCaps={d:{mouse_control:'supported'}};
  const a=await httpClient(t,f.url,f.a);await f.daemon.supervisor.settled();
  const before=await a.client.listTools();
  const s=content(await a.client.callTool({name:'umouse_status',arguments:{}}));assert.equal(s.toolDiscovery.pending,0);
  const owner=[...f.daemon.connections.values()].find(x=>x.ctx.connectionId===s.connectionId);
  const notifications=[];const send=owner.transport.send.bind(owner.transport);
  owner.transport.send=(m,o)=>{if(m.method==='notifications/tools/list_changed')notifications.push(m);return send(m,o);};
  owner.server.sendToolListChanged();
  const input={canInput:false,canSequence:false,control:{status:()=>({active:false})}};f.daemon.runtime={input,stop:async()=>{},releaseOwner:async()=>{}};
  for(const ready of [true,false,true]) {
    input.canInput=ready;input.canSequence=ready;
    assert.deepEqual(await a.client.listTools(),before);
    assert.deepEqual(content(await a.client.callTool({name:'umouse_status',arguments:{}})).inputCapabilitiesReady,{mouse:ready,sequence:ready});
  }
  f.daemon.runtime=undefined;assert.deepEqual(await a.client.listTools(),before);
  assert.deepEqual(notifications,[]);
});
test('static discovery: stopped worker does not hide input; disabled hardware input still has no input tools', {skip:!enabled}, async t=>{
  const f=await fixture(t,true);f.daemon.options.bridge.voiceTestCaps={d:{mouse_control:'supported'}};
  await f.daemon.supervisor.shutdown();
  const a=await httpClient(t,f.url,f.a);const names=(await a.client.listTools()).tools.map(x=>x.name);
  assert.ok(names.includes('umouse_input_sequence'));assert.ok(names.includes('umouse_mouse_action'));
  const s=content(await a.client.callTool({name:'umouse_status',arguments:{}}));assert.equal(s.toolDiscovery.timedOut,false);assert.equal(s.toolDiscovery.lastWaitMs,0);
  const disabled=await fixture(t,false),b=await httpClient(t,disabled.url,disabled.a);
  assert.ok(!(await b.client.listTools()).tools.some(x=>x.name==='umouse_input_sequence'||x.name==='umouse_mouse_action'));
});
