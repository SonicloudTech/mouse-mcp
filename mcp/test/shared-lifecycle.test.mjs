import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeError } from '../dist/shared/native-client.js';
import { randomUUID } from 'node:crypto';
import { ClientRegistry } from '../dist/shared/client-registry.js';
import { WorkerSupervisor } from '../dist/shared/worker-supervisor.js';
import { OperationRegistry } from '../dist/shared/operation-registry.js';
import { ResourceArbiter } from '../dist/shared/resource-arbiter.js';
import { OutputBudget } from '../dist/shared/output-budget.js';
import { PeerCheckQueue } from '../dist/shared/peer-check-queue.js';
import { guardHttpOutput } from '../dist/shared/http-output.js';
import { IdleLifecycle } from '../dist/shared/idle-exit.js';
import { InputInFlightFlag, stateDirFromManifest, autoRecoveryEvidence, archiveRunMarker, archiveEvidenceFile } from '../dist/shared/input-inflight.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pause = ms => new Promise(r => setTimeout(r, ms));

test('audit SSE write budget is held until actual completion and a stalled write closes the owner',async()=>{
  class Response extends EventEmitter {
    callbacks=[];destroyed=false;
    write(chunk,encoding,callback){this.callbacks.push(callback);return false;}
    end(chunk,encoding,callback){this.callbacks.push(callback);return this;}
    destroy(){if(!this.destroyed){this.destroyed=true;this.emit('close');}}
  }
  const budget=new OutputBudget(1024),res=new Response();let closed=0,called=0;
  guardHttpOutput(res,budget,()=>closed++,35);
  res.write(Buffer.alloc(100),()=>called++);assert.equal(budget.bytes,100);
  res.callbacks.shift()();assert.equal(budget.bytes,0);assert.equal(called,1);
  res.write('SSE notification');assert.ok(budget.bytes>0);await pause(65);
  assert.equal(res.destroyed,true);assert.equal(closed,1);assert.equal(budget.bytes,0);
  res.callbacks.shift()();assert.equal(budget.bytes,0);
});

test('audit peer verification queues bursts beyond eight, bounds and expires queued work',async()=>{
  const q=new PeerCheckQueue(8,2,35);const done=[];
  const running=Array.from({length:8},()=>q.run(()=>new Promise(r=>done.push(r))));
  let entered=false;const ninth=q.run(async()=>{entered=true;return true;});
  assert.deepEqual(q.status,{running:8,queued:1});assert.equal(entered,false);
  done[0](true);assert.equal(await ninth,true);
  const pending=q.run(async()=>true);const pending2=q.run(async()=>true);
  // One slot is free after ninth; fill all slots before checking the wait limit.
  await Promise.all([pending,pending2]);
  const held=q.run(()=>new Promise(r=>done.push(r)));
  const expired=q.run(async()=>{throw Error('must not execute after expiry');});
  const expired2=q.run(async()=>false); assert.equal(await q.run(async()=>true),false);
  await pause(60);assert.equal(await expired,false);assert.equal(await expired2,false);
  done.forEach(r=>r(true)); await Promise.all([...running,held]);assert.deepEqual(q.status,{running:0,queued:0});
});

test('audit supervisor cleanup budget is configurable and slow confirmed cleanup remains healthy',async()=>{
  const log=[];const s=new WorkerSupervisor(()=>new Worker(log),{beforeStop:()=>pause(40)},[1],100);
  s.setCount(1);await s.settled();s.setCount(0);await s.settled();assert.equal(s.state,'stopped');assert.equal(s.status.cleanupTimeoutMs,100);await s.shutdown();
});
class Worker extends EventEmitter {
  epoch = randomUUID(); alive = false; heartbeatAgeMs = 0; processId = 1; clean = true;
  constructor(log, options = {}) { super(); this.log = log; this.options = options; }
  async start() { this.log.push('start'); this.alive = true; await pause(this.options.startMs ?? 0); return { plugins: [], unavailable: [] }; }
  async stop() { this.log.push('stopping'); await pause(this.options.stopMs ?? 0); this.alive = false; this.log.push('exit'); this.emit('exit'); return { clean: this.clean }; }
  crash() { this.alive = false; this.log.push('crash'); this.emit('exit'); }
  async request() { return {}; }
}

test('startup diagnostics retain native rejection code without changing fault or replay policy',async()=>{
  const s=new WorkerSupervisor(()=>new Worker([]),{ready:async()=>{throw new NativeError('previous_worker_exit_unclean');}},[]);
  s.setCount(1);await s.settled();
  assert.equal(s.state,'faulted');assert.equal(s.status.lastError,'worker_start_failed');
  assert.equal(s.status.lastStartFailure.code,'previous_worker_exit_unclean');assert.ok(Number.isFinite(Date.parse(s.status.lastStartFailure.utc)));
  s.setCount(0);s.setCount(1);await s.settled();assert.equal(s.state,'faulted');await s.shutdown();
});

test('startup diagnostics do not publish arbitrary exception messages or paths',async()=>{
  for(const error of [new Error('C:/private/token'),new NativeError('secret with spaces')]){
    const s=new WorkerSupervisor(()=>new Worker([]),{ready:async()=>{throw error;}},[]);
    s.setCount(1);await s.settled();assert.equal(s.status.lastStartFailure.code,'unclassified_error');
    assert.doesNotMatch(JSON.stringify(s.status),/private|secret/);await s.shutdown();
  }
});
test('registry: N counts completed initialization, close idempotent, owner identity cannot be forged', () => {
  let now = 0; const r = new ClientRegistry(() => now); const changes = []; r.on('change', n => changes.push(n));
  const a = r.open('a', 'stdio-heartbeat', ['voice']); const b = r.open('b', 'http-passive', []);
  assert.equal(r.count, 0); r.initialized(a); r.initialized(a); r.initialized(b); assert.equal(r.count, 2);
  assert.throws(() => r.assertActive({ ...a }), /connection_expired/);
  assert.throws(() => r.assertActive(b, 'voice'), /permission_denied/);
  assert.equal(r.close(a, 'eof'), true); assert.equal(r.close(a, 'eof'), false); assert.equal(r.count, 1);
  now = 900001; r.sweep(); assert.equal(r.count, 0); assert.deepEqual(changes, [1, 2, 1, 0]);
});
test('registry: initialization deadline cannot be extended by spam, passive lease cannot be revived after expiry', () => {
  let now = 0; const r = new ClientRegistry(() => now); const a = r.open('a', 'http-passive', []);
  now = 14000; r.touch(a); now = 15000; assert.throws(() => r.initialized(a), /connection_expired/);
  const b = r.open('b', 'http-passive', []); r.initialized(b); now += 900000;
  assert.throws(() => r.touch(b), /connection_expired/); assert.equal(r.count, 0);
});
test('registry: heartbeat expiry, bounded active lease, cleanup notified before N=0', () => {
  let now = 0; const r = new ClientRegistry(() => now); const events = [];
  const a = r.open('a', 'stdio-heartbeat', []); r.initialized(a); r.activeLease(a);
  r.on('closed', () => events.push('cleanup')); r.on('change', () => events.push('count'));
  now = 30000; r.sweep(); assert.equal(r.count, 1); now = 45000; r.sweep();
  assert.equal(r.count, 0); assert.deepEqual(events, ['cleanup', 'count']);
});
test('supervisor: N=0 never starts SDK, N=1/2 shares one worker, non-last exit keeps it', async () => {
  const log = []; const s = new WorkerSupervisor(() => new Worker(log));
  s.setCount(0); await s.settled(); assert.deepEqual(log, []);
  s.setCount(1); s.setCount(2); await s.settled(); assert.deepEqual(log, ['start']);
  s.setCount(1); await s.settled(); assert.equal(s.state, 'running');
  s.setCount(0); await s.settled(); assert.deepEqual(log, ['start', 'stopping', 'exit']); assert.equal(s.state, 'stopped');
});
test('supervisor: reconnect during stop cannot overlap SDK workers', async () => {
  const log = []; const s = new WorkerSupervisor(() => new Worker(log, { stopMs: 35 }));
  s.setCount(1); await s.settled(); s.setCount(0); await pause(5); s.setCount(1); await s.settled();
  assert.deepEqual(log, ['start', 'stopping', 'exit', 'start']); assert.equal(s.state, 'running'); await s.shutdown();
});
test('supervisor: disconnect during startup stops before runtime activation', async () => {
  const log = []; let activated = 0;
  const s = new WorkerSupervisor(() => new Worker(log, { startMs: 30 }), { ready: async () => { activated++; } });
  s.setCount(1); s.setCount(0); await s.settled(); assert.equal(activated, 0); assert.equal(s.state, 'stopped');
});
test('supervisor: zero then reconnect during startup retires cancelled epoch before a new one', async () => {
  const log = []; let activations = 0;
  const s = new WorkerSupervisor(() => new Worker(log, { startMs: 20 }), { ready: async () => { activations++; } });
  s.setCount(1); s.setCount(0); s.setCount(1); await s.settled();
  assert.deepEqual(log, ['start', 'stopping', 'exit', 'start']); assert.equal(activations, 1); await s.shutdown();
});
test('supervisor: crash backoff bounded; a dead worker does not end logical sessions', async () => {
  const log = []; const workers = [];
  const s = new WorkerSupervisor(() => { const w = new Worker(log); workers.push(w); return w; }, {}, [1, 1, 1]);
  s.setCount(2); await s.settled();
  for (let i = 0; i < 4; i++) { workers.at(-1).crash(); await pause(10); await s.settled(); }
  assert.equal(s.state, 'faulted'); assert.equal(s.status.effectiveConnections, 2); assert.equal(workers.length, 4); await s.shutdown();
});
test('supervisor: failed cleanup latches fault, reconnect cannot bypass it', async () => {
  const log = []; const s = new WorkerSupervisor(() => { const w = new Worker(log); w.clean = false; return w; });
  s.setCount(1); await s.settled(); s.setCount(0); await s.settled(); s.setCount(1); await s.settled();
  assert.equal(s.state, 'faulted'); assert.equal(log.filter(x => x === 'start').length, 1); await s.shutdown();
});
test('operations: request IDs cannot replay completed side effects or cross owner namespaces', async () => {
  const r = new OperationRegistry(); let calls = 0;
  const execute = () => Promise.resolve(++calls);
  assert.equal(await r.run('a', 'one', { value: 1 }, execute), 1);
  assert.equal(await r.run('a', 'one', { value: 1 }, execute), 1);
  assert.throws(() => r.run('a', 'one', { value: 2 }, execute), /request_id_conflict/);
  assert.equal(await r.run('b', 'one', { value: 1 }, execute), 2);
  assert.equal(calls, 2);
});
test('arbiter: forged, stale and other owner releases cannot free a live desktop reservation', () => {
  const r = new ResourceArbiter('epoch'); const first = r.acquire('a', 'desktop');
  assert.throws(() => r.acquire('b', 'desktop'), /resource_busy/);
  assert.equal(r.release({ ...first }), false); assert.equal(r.has('desktop'), true);
  assert.equal(r.release(first), true); const next = r.acquire('b', 'desktop');
  assert.equal(r.release(first), false); assert.equal(r.release(next), true);
});

test('operations: large or unserializable results retain bounded non-replaying tombstones', async () => {
  const r=new OperationRegistry();let n=0;
  const huge='x'.repeat(1024*1024);assert.equal(await r.run('a','large',{},async()=>{n++;return huge;}),huge);
  assert.equal((await r.run('a','large',{},async()=>{n++;})).alreadyExecuted,true);
  const cycle={};cycle.self=cycle;await r.run('a','cycle',{},async()=>{n++;return cycle;});
  assert.equal((await r.run('a','cycle',{},async()=>{n++;})).alreadyExecuted,true);assert.equal(n,2);
});

test('registry: 10000 initialize/close cycles leave no logical sessions or input owners', () => {
  const registry=new ClientRegistry(),arbiter=new ResourceArbiter('epoch');let starts=0,stops=0;
  registry.on('change',n=>{if(n===1)starts++;if(n===0)stops++;});
  for(let i=0;i<10000;i++) { const c=registry.open('fixture','stdio-heartbeat',['voice']);registry.initialized(c);const lease=arbiter.acquire(c.connectionId,'desktop');assert.equal(arbiter.release(lease),true);registry.close(c,'test'); }
  assert.equal(registry.count,0);assert.equal(arbiter.has('desktop'),false);assert.equal(starts,10000);assert.equal(stops,10000);
});

test('output budget: mixed connections cannot exceed one global cap or double release another response',()=>{
  const b=new OutputBudget(100),a=b.reserve(70),other=b.reserve(30);assert.equal(b.bytes,100);
  assert.throws(()=>b.reserve(1),/global_output_budget/);a();a();assert.equal(b.bytes,30);
  const next=b.reserve(70);assert.throws(()=>b.reserve(1));other();next();assert.equal(b.bytes,0);
});
test('supervisor: RPC timeout quarantines even a worker that subsequently exits cleanly', async () => {
  const log = []; let w; const s = new WorkerSupervisor(() => { w = new Worker(log); return w; });
  s.setCount(1); await s.settled(); w.emit('unresponsive'); await s.settled();
  assert.equal(s.state, 'faulted'); s.setCount(2); await s.settled(); assert.equal(log.filter(x => x === 'start').length, 1); await s.shutdown();
});

test('idle: grace absorbs reconnect, then retires worker and exits the daemon', async () => {
  const events = [];
  const idle = new IdleLifecycle({ workerGraceMs: 40, exitMs: 150, recheckMs: 10 }, {
    retireWorker: () => events.push('retire'),
    readyToExit: () => events.includes('retire'),
    exit: () => events.push('exit'),
  });
  idle.update(1); await pause(80); assert.deepEqual(events, []);   // connected: timeline never arms
  idle.update(0); await pause(15); assert.deepEqual(events, []);   // still inside the grace window
  idle.update(1); await pause(200); assert.deepEqual(events, []);  // reconnect cancelled the whole timeline
  idle.update(0);
  await pause(70); assert.deepEqual(events, ['retire']);           // grace elapsed → worker retired
  await pause(120); assert.deepEqual(events, ['retire', 'exit']);  // exit window elapsed → daemon exit
});

test('idle: exit rechecks until readyToExit passes', async () => {
  const events = []; let ready = false;
  const idle = new IdleLifecycle({ workerGraceMs: 20, exitMs: 60, recheckMs: 15 }, {
    retireWorker: () => events.push('retire'),
    readyToExit: () => ready,
    exit: () => events.push('exit'),
  });
  idle.update(0);
  await pause(90); assert.deepEqual(events, ['retire']);           // blocked: still waiting, no exit
  ready = true; await pause(50); assert.deepEqual(events, ['retire', 'exit']);
});

test('idle: zero grace keeps legacy immediate retire; exitMs=0 never exits', async () => {
  const events = [];
  const idle = new IdleLifecycle({ workerGraceMs: 0, exitMs: 0 }, {
    retireWorker: () => events.push('retire'),
    readyToExit: () => true,
    exit: () => events.push('exit'),
  });
  idle.update(0); await pause(30);
  assert.deepEqual(events, ['retire']);
});

test('idle: cancel stops the timeline; repeated update(0) never restarts an armed window', async () => {
  const events = [];
  const idle = new IdleLifecycle({ workerGraceMs: 40, exitMs: 300, recheckMs: 10 }, {
    retireWorker: () => events.push('retire'),
    readyToExit: () => true,
    exit: () => events.push('exit'),
  });
  idle.update(0); await pause(10); idle.cancel(); await pause(80);
  assert.deepEqual(events, []);                                    // cancelled: nothing fires
  idle.update(0); await pause(20); idle.update(0);                  // re-armed; a second 0 is a no-op
  await pause(40); assert.deepEqual(events, ['retire']);           // fired on the original schedule
  idle.cancel();
});

test('idle: configuration requires non-negative stages and exitMs beyond workerGraceMs', () => {
  const hooks = { retireWorker() {}, readyToExit: () => true, exit() {} };
  assert.throws(() => new IdleLifecycle({ workerGraceMs: -1, exitMs: 0 }, hooks), /invalid_idle_config/);
  assert.throws(() => new IdleLifecycle({ workerGraceMs: 100, exitMs: 100 }, hooks), /invalid_idle_config/);
  assert.doesNotThrow(() => new IdleLifecycle({ workerGraceMs: 0, exitMs: 10 }, hooks));
  assert.doesNotThrow(() => new IdleLifecycle({ workerGraceMs: 10, exitMs: 0 }, hooks));
});

test('auto-recovery: movement-only evidence auto-clears; button-suspect evidence requires cleanup verification', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umcp-recover-'));
  const state = path.join(dir, 'native-state'), shared = path.join(dir, 'shared-v2');
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(shared, { recursive: true });
  const run = path.join(state, 'sdk-running.json');
  const inflight = path.join(state, 'input-in-flight.json');
  const uncertain = path.join(shared, 'input-uncertain.json');
  const quarantine = path.join(state, 'native-input-quarantine.json');
  const write = (f, v) => fs.writeFileSync(f, JSON.stringify(v));

  write(run, { schemaVersion: 1, pid: 7 });
  const evidence = autoRecoveryEvidence(state, dir);
  assert.deepEqual(evidence.autoClearable, []); assert.deepEqual(evidence.verifyRequired, []); assert.equal(evidence.runMarker, run);
  const archived = archiveRunMarker(evidence);
  assert.ok(fs.existsSync(archived)); assert.ok(!fs.existsSync(run));
  assert.ok(fs.readFileSync(archived, 'utf8').includes('"pid":7'));   // 归档保留证据，不删除

  // movement-only 记录（uncertain/quarantine 所有 scope 均声明，或 in-flight schema v2 声明）→ 自动清除
  write(uncertain, { schemaVersion: 2, scopes: { mouse: { owner: 'o', reason: 'input_attempting', epoch: 'e', at: '2026-10-17T00:00:00Z', movementOnly: true } } });
  write(quarantine, { schemaVersion: 1, scopes: { mouse: { reason: 'attempting', deviceId: 'd', movementOnly: true } } });
  write(inflight, { schemaVersion: 2, pid: 7, at: '2026-10-17T00:00:00Z', movementOnly: true });
  const auto = autoRecoveryEvidence(state, dir);
  assert.deepEqual(auto.autoClearable.sort(), [inflight, quarantine, uncertain].sort());
  assert.deepEqual(auto.verifyRequired, []);
  for (const file of auto.autoClearable) { const target = archiveEvidenceFile(file); assert.ok(target && fs.existsSync(target) && !fs.existsSync(file)); }

  // 按键嫌疑：涉及按键的记录、旧格式（无 movementOnly 字段）→ verifyRequired
  write(uncertain, { schemaVersion: 2, scopes: { mouse: { owner: 'o', reason: 'native_input_uncertain', epoch: 'e', at: '2026-10-17T00:00:00Z', movementOnly: false } } });
  write(quarantine, { schemaVersion: 1, scopes: { keyboard: { reason: 'attempting', deviceId: 'd' } } });
  write(inflight, { schemaVersion: 2, pid: 7, at: '2026-10-17T00:00:00Z', movementOnly: false });
  const verify = autoRecoveryEvidence(state, dir);
  assert.deepEqual(verify.autoClearable, []);
  assert.deepEqual(verify.verifyRequired.sort(), [inflight, quarantine, uncertain].sort());
  fs.rmSync(uncertain, { force: true }); fs.writeFileSync(uncertain, '{corrupt');
  const unreadable = autoRecoveryEvidence(state, dir);
  assert.ok(unreadable.verifyRequired.includes(uncertain));            // 不可解析 → 保守走验证
  for (const file of [inflight, quarantine, uncertain, run]) fs.rmSync(file, { force: true });
});

test('auto-recovery: in-flight flag carries movementOnly and clears only on a native terminal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umcp-inflight-'));
  const file = path.join(dir, 'input-in-flight.json');
  const flag = new InputInFlightFlag(file);
  const movementOnly = () => autoRecoveryEvidence(dir, dir).autoClearable.includes(file);
  assert.equal(flag.present, false);
  flag.begin(true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).movementOnly, true);
  assert.equal(movementOnly(), true);
  flag.end(false); assert.equal(flag.present, true);      // RPC 失联/无终态 → 保留
  flag.end(true); assert.equal(flag.present, false);      // 收到有效原生终态（含失败终态）→ 清除
  flag.begin(); assert.equal(movementOnly(), false);      // 默认按按键嫌疑处理
  flag.begin(); flag.begin(); assert.equal(flag.present, true);  // 重复 begin 幂等
  flag.end(true); assert.equal(flag.present, false);
});

test('auto-recovery: manifest resolves the umouse/fake runtime state directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umcp-manifest-'));
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify({ plugins: [
    { id: 'asr', config: {} }, { id: 'umouse', config: { runtimeStateDir: path.join(dir, 'native-state') } }] }));
  assert.equal(stateDirFromManifest(file), path.join(dir, 'native-state'));
  fs.writeFileSync(file, JSON.stringify({ plugins: [{ id: 'umouse', config: {} }] }));
  assert.throws(() => stateDirFromManifest(file), /runtime_state_dir_required/);
});
