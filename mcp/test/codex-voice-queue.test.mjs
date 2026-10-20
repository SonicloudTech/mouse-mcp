import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexVoiceQueue, readVoiceSnapshot, voiceNotice } from '../dist/codex-voice-queue.js';

const message = (extra={}) => ({eventId:randomUUID(), source:'physical-speech-button', capturedAt:new Date().toISOString(), status:'ready', acknowledged:false, text:'鼠标语音测试', ...extra});
function fixture(t, initial=[]) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'umouse-queue-'));
  const inbox=path.join(dir,'inbox.json');
  const state=path.join(dir,'state');
  const save=messages=>fs.writeFileSync(inbox,JSON.stringify({schemaVersion:1,messages}));
  save(initial);
  const calls=[]; const queues=[];
  const f={dir,inbox,state,save,calls,alive:true,enqueue:null};
  f.ledger=()=>JSON.parse(fs.readFileSync(path.join(state,'queue-delivery.json'),'utf8'));
  f.make=(extra={})=>{
    const q=new CodexVoiceQueue({inbox,directory:state,threadId:'00000000-0000-4000-8000-000000000001',codexPath:process.execPath,ownerPid:process.pid,
      ownerAlive:()=>f.alive,enqueue:async(thread,id)=>{calls.push({thread,id}); assert.equal(f.ledger().records.find(r=>r.eventId===id).state,'unknown'); if(f.enqueue) await f.enqueue();},...extra});
    queues.push(q); return q;
  };
  t.after(async()=>{ for(const q of queues) await q.stop(); fs.rmSync(dir,{recursive:true,force:true}); });
  return f;
}
const win={skip:process.platform!=='win32'};
test('queue notice contains only validated event ID, no transcript or retargetable destination',()=>{
  const id=randomUUID(); const text=voiceNotice(id); assert.ok(text.includes(id)); assert.ok(text.includes('umouse_voice_inbox')); assert.ok(text.includes('umouse_ack_voice'));
  assert.throws(()=>voiceNotice('--thread evil'),/invalid/);
});
test('snapshot rejects duplicates, malformed states, sources, missing text, invalid dates and oversize text',t=>{
  const f=fixture(t); const a=message();
  for(const list of [[a,a],[message({source:'remote'})],[message({status:'bogus'})],[message({text:undefined})],[message({capturedAt:'bad'})],[message({text:'x'.repeat(32001)})]]) {
    f.save(list); assert.throws(()=>readVoiceSnapshot(f.inbox));
  }
});
test('baseline prevents old ready and old in-flight events from replay; fresh event enqueues once',win,async t=>{
  const old=message(), inflight=message({status:'transcribing',text:undefined}); const f=fixture(t,[old,inflight]); const q=f.make(); await q.start();
  assert.equal(f.calls.length,0); const fresh=message(); f.save([old,{...inflight,status:'ready',text:'late'},fresh]);
  await Promise.all([q.scan(),q.scan()]); assert.deepEqual(f.calls.map(c=>c.id),[fresh.eventId]); assert.equal(q.status().queued,1);
  assert.equal(fs.readFileSync(path.join(f.state,'queue-delivery.json'),'utf8').includes(fresh.text),false);
});
test('explicit existing event can be submitted for acceptance; no implicit backlog',win,async t=>{
  const old=message({capturedAt:'2020-01-01T00:00:00Z'});const f=fixture(t,[old]);const q=f.make({includeEventId:old.eventId});await q.start();
  assert.equal(f.calls.length,1);assert.equal(f.ledger().records[0].state,'queued');
});
test('queue timeout remains unknown and is not repeated across rescan or restart',win,async t=>{
  const f=fixture(t);f.enqueue=async()=>{throw new Error('timeout after insertion');};const q=f.make();await q.start();
  f.save([message()]);await q.scan();await q.scan();assert.equal(f.calls.length,1);assert.equal(q.status().unknown,1);await q.stop();
  const restarted=f.make();await restarted.start();assert.equal(f.calls.length,1);assert.equal(restarted.status().unknown,1);
});
test('one canonical inbox lock prevents second consumer even with a different ledger and thread',win,async t=>{
  const f=fixture(t); const a=f.make();await a.start();const b=f.make({directory:path.join(f.dir,'other'),threadId:randomUUID()});
  await assert.rejects(b.start(),/EADDRINUSE/);await a.stop();await b.start();assert.equal(b.status().running,true);
});
test('restart binding cannot change target conversation',win,async t=>{
  const f=fixture(t);const a=f.make();await a.start();await a.stop();await assert.rejects(f.make({threadId:randomUUID()}).start(),/binding/);
});
test('native directory watch catches atomic rename and deduplicates repeated changes',win,async t=>{
  const f=fixture(t);const q=f.make();await q.start();const m=message();const tmp=path.join(f.dir,'atomic.tmp');
  fs.writeFileSync(tmp,JSON.stringify({schemaVersion:1,messages:[m]}));fs.renameSync(tmp,f.inbox);
  const deadline=Date.now()+3000;while(!f.calls.length&&Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
  assert.equal(f.calls.length,1);f.save([m]);await q.scan();assert.equal(f.calls.length,1);
});
test('change during pending enqueue is drained without losing second event',win,async t=>{
  const f=fixture(t);const q=f.make();await q.start();let release; f.enqueue=()=>new Promise(resolve=>{release=resolve;});
  const a=message(), b=message();f.save([a]);const pending=q.scan();while(!release) await new Promise(r=>setTimeout(r,1));
  f.save([a,b]);void q.scan();f.enqueue=null;release();await pending;assert.deepEqual(f.calls.map(c=>c.id),[a.eventId,b.eventId]);
});
test('adapter only observes ack and never writes the source inbox',win,async t=>{
  const f=fixture(t);const q=f.make();await q.start();const m=message();f.save([m]);const before=fs.readFileSync(f.inbox);await q.scan();
  assert.deepEqual(fs.readFileSync(f.inbox),before);assert.equal(q.status().acknowledged,0);f.save([{...m,acknowledged:true}]);await q.scan();assert.equal(q.status().acknowledged,1);
});
test('corrupt ledger fails closed and corrupt snapshot disarms running adapter',win,async t=>{
  const f=fixture(t);const q=f.make();await q.start();fs.writeFileSync(f.inbox,'bad');await q.scan();assert.equal(q.status().running,false);assert.equal(f.calls.length,0);await q.stop();
  f.save([]);fs.writeFileSync(path.join(f.state,'queue-delivery.json'),'bad');await assert.rejects(f.make().start());
});
test('dead owner and stopped adapter cannot send new input',win,async t=>{
  const f=fixture(t);f.alive=false;await assert.rejects(f.make().start(),/owner_not_running/);f.alive=true;
  const q=f.make();await q.start();f.alive=false;f.save([message()]);await q.scan();assert.equal(f.calls.length,0);await q.stop();
  f.alive=true;await q.scan();assert.equal(f.calls.length,0);
});
test('clock rollback old capture and nonterminal / acknowledged events are ignored',win,async t=>{
  const f=fixture(t);const q=f.make();await q.start();f.save([message({capturedAt:'2020-01-01T00:00:00Z'}),message({status:'failed'}),message({acknowledged:true}),message({status:'transcribing',text:undefined})]);
  await q.scan();assert.equal(f.calls.length,0);
});
test('file metadata fallback recovers a lost watcher notification without periodic enqueue',win,async t=>{
  const f=fixture(t);const q=f.make();await q.start();q.watcher.close();const m=message();f.save([m]);
  const deadline=Date.now()+3000;while(!f.calls.length&&Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
  assert.equal(f.calls.length,1);await new Promise(r=>setTimeout(r,1100));assert.equal(f.calls.length,1);
});
test('malformed runtime config does not coerce arrays into thread IDs',win,t=>{
  const f=fixture(t);assert.throws(()=>f.make({threadId:['00000000-0000-4000-8000-000000000001']}),/invalid_queue_config/);
});
test('snapshot failure releases consumer lock without caller stop',win,async t=>{
  const f=fixture(t);const a=f.make();await a.start();fs.writeFileSync(f.inbox,'corrupt');await a.scan();
  await new Promise(r=>setTimeout(r,20));f.save([]);const b=f.make();await b.start();assert.equal(b.status().running,true);
});
