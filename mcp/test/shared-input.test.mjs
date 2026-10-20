import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SharedInput } from '../dist/shared/input-manager.js';
import { ResourceArbiter } from '../dist/shared/resource-arbiter.js';
import { InputInFlightFlag, autoRecoveryEvidence } from '../dist/shared/input-inflight.js';
const receipt = () => ({ outcome:'completed',transport:{attempted:2,written:2,writeFailed:0},cleanup:'release_confirmed',timing:{queueMs:0,totalMs:1},effectConfirmed:false,final:{x:10,y:20},residual:{dx:0,dy:0},
  verification:{schemaVersion:1,source:'windows-raw-input',feedbackReliable:true,buttonIntegrity:'confirmed',pressObserved:true,releaseObserved:true,releaseStateConfirmed:true,observedPresses:1,observedReleases:1} });
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shared-input-')), arbiter=new ResourceArbiter('epoch'), calls=[];
  const port={native:{epoch:'epoch',request:async (...args)=>{calls.push(args);return receipt();}},arbiter,dataDir:dir,enabled:true,devices:()=>[{id:'device',generation:1}],allowed:()=>true};
  const manager=new SharedInput(port);
  const control=manager.beginControl('a','fixture');
  const rawMouse=manager.runMouse.bind(manager),rawSequence=manager.runSequence.bind(manager);
  manager.runMouse=(owner,args,s)=>rawMouse(owner,{control_id:control.control_id,...args},s);
  manager.runSequence=(owner,args,s)=>rawSequence(owner,{control_id:control.control_id,...args},s);
  t.after(async()=>{await manager.stop();await fs.rm(dir,{recursive:true,force:true});});return{manager,port,arbiter,calls,dir,control,rawMouse,rawSequence};
}
const action={kind:'click',x:10,y:20};
const mouse=()=>({device_id:'device',client_request_id:'op',action});
const signal=()=>new AbortController().signal;
const sequence=()=>({pid:1,window_id:'1',device_id:'device',client_request_id:'op',frames:[{kind:'keyboard',keys:[4]}]});
// Raw sequences remain transport-only; no button-feedback verification is inferred from hardware.
const sequenceReceipt=()=>({outcome:'completed',transport:{attempted:2,written:2,writeFailed:0},cleanup:'release_written',timing:{queueMs:0,totalMs:1},effectConfirmed:false});

test('task control: ownership persists across calls and observation gaps; same connection cannot start another task',async t=>{
  const f=await fixture(t),token=f.control.control_id;
  assert.equal(f.manager.beginControl('a','fixture').control_id,token);
  await f.manager.runMouse('a',mouse(),signal());
  await new Promise(r=>setImmediate(r));
  assert.equal(f.arbiter.has('hardware-control'),true);assert.equal(f.arbiter.has('desktop'),false);
  assert.throws(()=>f.manager.beginControl('b','other'),/control_busy/);
  assert.throws(()=>f.manager.beginControl('a','other'),/control_busy/);
  assert.equal(f.manager.control.status('b').control_id,undefined);
  await assert.rejects(f.rawMouse('a',mouse(),signal()),/control_token_invalid/);
  await assert.rejects(f.rawMouse('b',{...mouse(),control_id:token},signal()),/control_busy/);
  // Voice dictation owns desktop only while delivering, never the task reservation.
  const voice=f.arbiter.acquire('dictation','desktop');f.arbiter.release(voice);
  await f.manager.endControl('a',token);
  await assert.rejects(f.manager.runMouse('a',mouse(),signal()),/control_required/);
  const next=f.manager.beginControl('b','next');assert.notEqual(next.control_id,token);
  await assert.rejects(f.rawMouse('b',{...mouse(),control_id:token},signal()),/control_token_invalid/);
  assert.equal((await f.rawMouse('b',{...mouse(),control_id:next.control_id},signal())).outcome,'completed');
});

test('task control: terminal failed action preserves ownership and permits fresh explicit input',async t=>{
  const f=await fixture(t);let calls=0;
  f.port.native.request=async()=>{++calls;return {...receipt(),outcome:'indeterminate'};};
  const failed=await f.manager.runMouse('a',mouse(),signal());
  assert.equal(failed.outcome,'indeterminate');assert.equal(failed.retryAutomatic,false);
  assert.equal(f.manager.blocked,false);assert.equal(f.manager.hasUncertainty,true);assert.equal(calls,1);
  assert.throws(()=>f.manager.beginControl('b','next'),/control_busy/);
  f.port.native.request=async()=>{++calls;return receipt();};
  assert.equal((await f.manager.runMouse('a',{...mouse(),client_request_id:'new-explicit'},signal())).outcome,'completed');
  assert.equal(calls,2);assert.equal(f.manager.control.status('a').control_id,f.control.control_id);
  assert.ok((await fs.readdir(path.join(f.dir,'shared-v2'))).some(x=>x.includes('.history-')));
});

test('task control: end rejects new calls and retains ownership until cancellation is terminal',async t=>{
  const f=await fixture(t);let settle,aborted;
  f.port.native.request=async(_,__,___,s)=>{aborted=s;return new Promise(r=>settle=r);};
  const p=f.manager.runMouse('a',mouse(),signal());await new Promise(r=>setImmediate(r));
  await assert.rejects(f.manager.runMouse('a',mouse(),signal()),/resource_busy/);
  const end=f.manager.endControl('a',f.control.control_id);
  assert.equal(aborted.aborted,true);assert.equal(f.arbiter.has('hardware-control'),true);
  assert.throws(()=>f.manager.beginControl('b','new'),/control_busy/);
  await assert.rejects(f.manager.runMouse('a',mouse(),signal()),/control_closing/);
  settle({...receipt(),outcome:'indeterminate'});await p;await end;
  assert.equal(f.arbiter.has('hardware-control'),false);assert.equal(f.arbiter.has('desktop'),false);
  assert.ok(f.manager.beginControl('b','new').control_id);
});

test('task control: worker restart invalidates tokens; disconnected owner can no longer hold resource',async t=>{
  const f=await fixture(t);await f.manager.release('a');
  const restored=new SharedInput({...f.port,arbiter:new ResourceArbiter('next-epoch')});
  t.after(()=>restored.stop());
  const next=restored.beginControl('a','fixture');assert.notEqual(next.control_id,f.control.control_id);
  await assert.rejects(restored.runMouse('a',{...mouse(),control_id:f.control.control_id},signal()),/control_token_invalid/);
  await restored.release('a');assert.equal(restored.control.status('a').active,false);
});
test('shared sequence: keyboard-only permission and native generation; no mouse grant inferred',async t=>{
  const f=await fixture(t);f.port.allowed=(_,cap)=>cap==='keyboard_control';
  assert.equal(f.manager.canInput,false);assert.equal(f.manager.canSequence,true);
  f.port.native.request=async(...a)=>{f.calls.push(a);return sequenceReceipt();};
  const r=await f.manager.runSequence('a',sequence(),new AbortController().signal);
  assert.equal(r.effectConfirmed,false);assert.equal(f.calls[0][1],'input.sequence');assert.equal(f.calls[0][2].deviceGeneration,1);
  assert.equal(f.calls[0][2].frames[0].delayMs,30);assert.equal(f.calls[0][4].awaitTerminalOnCancel,true);
  await assert.rejects(f.manager.runSequence('a',{...sequence(),frames:[{kind:'mouse'}]},new AbortController().signal),/capability/);
});
test('shared sequence: invalid tail, short budget and wrong device reject entire batch',async t=>{
  const f=await fixture(t);
  for(const args of [{...sequence(),frames:[{kind:'keyboard',keys:[4]},{kind:'keyboard',keys:[1]}]},
    {...sequence(),device_id:'other'},{...sequence(),timeout_ms:100,frames:[{kind:'keyboard',delay_ms:100}]}])
    await assert.rejects(f.manager.runSequence('a',args,new AbortController().signal));
  assert.equal(f.calls.length,0);assert.equal(f.arbiter.has('desktop'),false);
});
test('shared sequence: SDK 0.4.24 unsupported button bits reject before any earlier keyboard frame',async t=>{
  const f=await fixture(t);
  f.port.native.request=async(...args)=>{f.calls.push(args);return sequenceReceipt();};
  for(const buttons of [8,16,31]) await assert.rejects(f.manager.runSequence('a',{
    ...sequence(),frames:[{kind:'keyboard',keys:[4]},{kind:'mouse',buttons}],
  },new AbortController().signal));
  assert.equal(f.calls.length,0);assert.equal(f.arbiter.has('desktop'),false);assert.equal(f.manager.hasUncertainty,false);
});
test('shared sequence: disconnect waits native terminal before releasing shared desktop',async t=>{
  const f=await fixture(t);let settle,signal;
  f.port.native.request=async(_,__,___,s)=>{signal=s;return new Promise(r=>settle=r);};
  const pending=f.manager.runSequence('a',sequence(),new AbortController().signal);await new Promise(r=>setImmediate(r));
  await assert.rejects(f.manager.runSequence('b',sequence(),new AbortController().signal),/control_busy/);
  assert.throws(()=>f.arbiter.acquire('dictation','desktop'),/resource_busy/);
  let released=false;const closing=f.manager.release('a').then(()=>released=true);
  await new Promise(r=>setImmediate(r));assert.equal(signal.aborted,true);assert.equal(released,false);assert.equal(f.arbiter.has('desktop'),true);
  settle({...sequenceReceipt(),outcome:'indeterminate'});await pending;await closing;
  assert.equal(f.manager.hasUncertainty,true);assert.equal(f.arbiter.has('desktop'),false);
});
test('shared sequence: malformed receipt preserves durable uncertain marker',async t=>{
  const f=await fixture(t);f.port.native.request=async()=>({effectConfirmed:true});
  await assert.rejects(f.manager.runSequence('a',sequence(),new AbortController().signal));assert.equal(f.manager.hasUncertainty,true);
  const restarted=new SharedInput(f.port);assert.equal(restarted.hasUncertainty,true);await restarted.stop();
});
test('shared sequence: no-write foreground rejection does not quarantine subsequent input',async t=>{
  const f=await fixture(t);f.port.native.request=async()=>({...sequenceReceipt(),outcome:'rejected',transport:{attempted:0,written:0,writeFailed:0},cleanup:'not_needed',errorCode:'target_not_foreground'});
  const r=await f.manager.runSequence('a',sequence(),new AbortController().signal);assert.equal(r.outcome,'rejected');assert.equal(f.manager.hasUncertainty,false);
});
test('shared sequence: stop cancels active input and prevents later admission',async t=>{
  const f=await fixture(t);let settle,signal;f.port.native.request=async(_,__,___,s)=>{signal=s;return new Promise(r=>settle=r);};
  const p=f.manager.runSequence('a',sequence(),new AbortController().signal);await new Promise(r=>setImmediate(r));
  const stopped=f.manager.stop();assert.equal(signal.aborted,true);settle(sequenceReceipt());await p;await stopped;
  await assert.rejects(f.manager.runSequence('a',sequence(),new AbortController().signal),/未启用/);
});
test('shared sequence: caller deadline includes native queue and retains lease until terminal',async t=>{
  const f=await fixture(t);let settle,signal;f.port.native.request=async(_,__,___,s)=>{signal=s;return new Promise(r=>settle=r);};
  const pending=f.manager.runSequence('a',{...sequence(),timeout_ms:100},new AbortController().signal);
  await new Promise(r=>setTimeout(r,140));assert.equal(signal.aborted,true);assert.equal(f.arbiter.has('desktop'),true);
  settle({...sequenceReceipt(),outcome:'indeterminate'});await pending;assert.equal(f.arbiter.has('desktop'),false);
});
test('hardware mouse: one native RPC per action with device generation and terminal barrier',async t=>{
  const f=await fixture(t);const value=await f.manager.runMouse('a',mouse(),signal());
  assert.equal(value.cleanup,'release_confirmed');assert.equal(f.calls.length,1);
  assert.equal(f.calls[0][1],'mouse.action');assert.equal(f.calls[0][2].deviceGeneration,1);
  assert.equal(f.calls[0][4].awaitTerminalOnCancel,true);assert.equal(f.arbiter.has('desktop'),false);
});
test('hardware mouse: cancel and owner disconnect retain desktop until native terminal',async t=>{
  const f=await fixture(t);let settle,aborted;
  f.port.native.request=async(_,__,___,s)=>{aborted=s;return new Promise(r=>settle=r);};
  const pending=f.manager.runMouse('a',mouse(),signal());await new Promise(r=>setImmediate(r));
  await assert.rejects(f.manager.runMouse('b',mouse(),signal()),/control_busy/);
  assert.throws(()=>f.arbiter.acquire('dictation','desktop'),/resource_busy/);
  let released=false;const ending=f.manager.release('a').then(()=>released=true);
  await new Promise(r=>setImmediate(r));assert.equal(aborted.aborted,true);assert.equal(released,false);
  settle({...receipt(),outcome:'indeterminate'});await pending;await ending;
  assert.equal(f.arbiter.has('desktop'),false);assert.equal(f.manager.uncertainScopes.mouse,true);
});
test('hardware mouse: validation rejects stale/unsupported targets and all automation fields before RPC',async t=>{
  const f=await fixture(t);
  for(const args of [{...mouse(),pid:1}, {...mouse(),window_id:'1'}, {...mouse(),device_id:'missing'},
    {...mouse(),action:{...action,element_token:'x'}}, {...mouse(),steps:[{click:{x:1,y:1}}]},
    {...mouse(),action:{...action,kind:'drag',toX:1,toY:2,durationMs:10}}])
    await assert.rejects(f.manager.runMouse('a',args,signal()));
  f.port.allowed=()=>false;await assert.rejects(f.manager.runMouse('a',mouse(),signal()),/capability/);
  assert.equal(f.calls.length,0);assert.equal(f.manager.hasUncertainty,false);
});
test('hardware mouse: generation changes before RPC cannot be sent to replacement',async t=>{
  const f=await fixture(t),pending=f.manager.runMouse('a',mouse(),signal());
  f.port.devices=()=>[{id:'device',generation:2}];await assert.rejects(pending,/device_changed/);
  assert.equal(f.calls.length,0);assert.equal(f.arbiter.has('desktop'),false);
});
test('hardware mouse: omitted target is resolved in native; explicit target is forwarded without snapshot',async t=>{
  const f=await fixture(t);await f.manager.runMouse('a',mouse(),signal());assert.equal(f.calls[0][2].window,undefined);
  await f.manager.runMouse('a',{...mouse(),pid:123,window_id:'456'},signal());
  assert.deepEqual(f.calls[1][2].window,{pid:123,windowId:'456'});
});
test('hardware input: failed durable intent prevents all native input',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.dir,'shared-v2'),'not-a-directory');
  await assert.rejects(f.manager.runMouse('a',mouse(),signal()));assert.equal(f.calls.length,0);assert.equal(f.arbiter.has('desktop'),false);
});
test('input-in-flight: rejected admission leaves no flag; admitted request persists until clean native terminal',async t=>{
  const f=await fixture(t),flag=new InputInFlightFlag(path.join(f.dir,'input-in-flight.json'));f.port.inflight=flag;
  await assert.rejects(f.manager.runMouse('a',{...mouse(),device_id:'missing'},signal()));assert.equal(flag.present,false);
  const lease=f.arbiter.acquire('dictation','desktop');
  await assert.rejects(f.manager.runMouse('a',mouse(),signal()),/resource_busy/);assert.equal(flag.present,false);f.arbiter.release(lease);
  f.port.native.request=async()=>{assert.equal(flag.present,true);return receipt();};
  await f.manager.runMouse('a',mouse(),signal());assert.equal(flag.present,false);
  f.port.native.request=async()=>({...receipt(),outcome:'indeterminate'});
  await f.manager.runMouse('a',mouse(),signal());assert.equal(flag.present,false);
});
test('movement-only: pure move batches annotate receipts and journal movementOnly; button batches do not',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'shared-v2','input-uncertain.json');
  f.port.native.request=async()=>({...sequenceReceipt(),outcome:'indeterminate'});
  const failed=await f.manager.runSequence('a',{...sequence(),frames:[{kind:'mouse',dx:5,dy:-5},{kind:'mouse',dx:1,wheel:1}]},signal());
  assert.equal(failed.movementOnly,true);assert.match(failed.movementNote,/movement-only/);
  const marker=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(marker.scopes.mouse.movementOnly,true);
  assert.ok(autoRecoveryEvidence(f.dir,f.dir).autoClearable.includes(file));   // 纯移动证据 → 自动清除
  const button=await f.manager.runSequence('a',{...sequence(),frames:[{kind:'mouse',buttons:1}]},signal());
  assert.equal(button.movementOnly,false);assert.equal(button.movementNote,undefined);
  assert.ok(autoRecoveryEvidence(f.dir,f.dir).verifyRequired.includes(file));  // 涉键证据 → cleanup 验证
  assert.equal((await f.manager.runSequence('a',sequence(),signal())).movementOnly,false);   // 键盘帧
  f.port.native.request=async()=>({outcome:'completed',transport:{attempted:2,written:2,writeFailed:0},cleanup:'not_needed',timing:{queueMs:0,totalMs:1},effectConfirmed:false,final:{x:3,y:4},residual:{dx:0,dy:0},
    verification:{schemaVersion:1,source:'windows-raw-input',feedbackReliable:true,buttonIntegrity:'not_required',pressObserved:false,releaseObserved:false,releaseStateConfirmed:false,observedPresses:0,observedReleases:0}});
  assert.equal((await f.manager.runMouse('a',{...mouse(),action:{kind:'move',x:3,y:4}},signal())).movementOnly,true);
  assert.equal((await f.manager.runMouse('a',{...mouse(),action:{kind:'scroll',x:3,y:4,direction:'down',amount:2}},signal())).movementOnly,true);
  f.port.native.request=async()=>receipt();
  assert.equal((await f.manager.runMouse('a',mouse(),signal())).movementOnly,false);          // click
});
test('recovery: acknowledgeRecovered archives evidence and clears diagnostics',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'shared-v2','input-uncertain.json');
  f.port.native.request=async()=>({...sequenceReceipt(),outcome:'indeterminate'});
  await f.manager.runSequence('a',{...sequence(),frames:[{kind:'mouse',buttons:1}]},signal());
  assert.equal(f.manager.hasUncertainty,true);
  f.manager.acknowledgeRecovered();
  assert.equal(f.manager.hasUncertainty,false);assert.deepEqual(f.manager.uncertainScopes,{mouse:false,keyboard:false});
  const entries=await fs.readdir(path.dirname(file));
  assert.equal(entries.includes('input-uncertain.json'),false);
  assert.ok(entries.some(x=>x.startsWith('input-uncertain.json.auto-recovered-')));           // 字节保留
});
for(const scope of ['mouse','keyboard']) test(`hardware isolation: ${scope} fault does not block other control or erase its marker`,async t=>{
  const f=await fixture(t);f.port.native.request=async()=>({...scope==='mouse'?receipt():sequenceReceipt(),outcome:'indeterminate'});
  if(scope==='mouse')await f.manager.runMouse('a',mouse(),signal());else await f.manager.runSequence('a',sequence(),signal());
  f.port.native.request=async()=>scope==='mouse'?sequenceReceipt():receipt();
  if(scope==='mouse')await f.manager.runSequence('a',sequence(),signal());else await f.manager.runMouse('a',mouse(),signal());
  assert.deepEqual(f.manager.uncertainScopes,{mouse:scope==='mouse',keyboard:scope==='keyboard'});
  const restored=new SharedInput(f.port);assert.deepEqual(restored.uncertainScopes,f.manager.uncertainScopes);await restored.stop();
  f.port.native.request=async()=>sequenceReceipt();
  assert.equal((await f.manager.runSequence('a',{...sequence(),frames:[{kind:'keyboard',keys:[4]},{kind:'mouse',dx:1}]},signal())).outcome,'completed');
});
test('hardware isolation: failures merge and attempted scope is persisted before RPC',async t=>{
  const f=await fixture(t);f.port.native.request=async()=>({...receipt(),outcome:'indeterminate'});
  await f.manager.runMouse('a',mouse(),signal());
  f.port.native.request=async()=>{const restored=new SharedInput(f.port);assert.deepEqual(restored.uncertainScopes,{mouse:true,keyboard:true});await restored.stop();return {...sequenceReceipt(),outcome:'indeterminate'};};
  await f.manager.runSequence('a',sequence(),signal());assert.deepEqual(f.manager.uncertainScopes,{mouse:true,keyboard:true});
});
test('hardware isolation: old and corrupt markers are evidence without blocking new explicit input',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'shared-v2','input-uncertain.json');await fs.mkdir(path.dirname(file),{recursive:true});
  await f.manager.release('a');
  for(const value of [{schemaVersion:1,owner:'old',reason:'unknown'},'{invalid',{schemaVersion:2,scopes:{}},{schemaVersion:2,scopes:{mouse:{owner:'old'}}}]) {
    await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));const restored=new SharedInput(f.port);
    assert.deepEqual(restored.uncertainScopes,{mouse:true,keyboard:true});
    const c=restored.beginControl('a','new');
    assert.equal((await restored.runMouse('a',{...mouse(),control_id:c.control_id},signal())).outcome,'completed');
    assert.equal(restored.blocked,false);await restored.stop();
  }
});
test('hardware isolation: native quarantine retains its own scope; invalid diagnostic remains uncertain without a fault latch',async t=>{
  const f=await fixture(t);f.manager.applyNativeQuarantine(undefined);assert.equal(f.manager.hasUncertainty,false);
  f.manager.applyNativeQuarantine({mouse:true,keyboard:false,persistenceHealthy:true});
  assert.equal((await f.manager.runMouse('a',mouse(),signal())).outcome,'completed');
  f.manager.applyNativeQuarantine({mouse:true,keyboard:false,persistenceHealthy:true});f.port.native.request=async()=>sequenceReceipt();
  await f.manager.runSequence('a',sequence(),signal());assert.deepEqual(f.manager.uncertainScopes,{mouse:true,keyboard:false});
  for(const value of [null,{}, {mouse:false,keyboard:false,persistenceHealthy:false}]) {f.manager.applyNativeQuarantine(value);assert.deepEqual(f.manager.uncertainScopes,{mouse:true,keyboard:true});}
});
for (const [label, mutate] of [
  ['legacy receipt without verification', r => { delete r.verification; r.cleanup='release_written'; }],
  ['missing application-effect boundary', r => { delete r.effectConfirmed; }],
  ['application effect claimed', r => { r.effectConfirmed=true; }],
  ['wrong feedback source', r => { r.verification.source='sdk-ack'; }],
  ['observed flags contradict counts', r => { r.verification.pressObserved=false; }],
  ['release confirmation absent', r => { r.verification.releaseStateConfirmed=false; }],
  ['failed receipt retains contradictory release confirmation', r => { r.outcome='indeterminate'; r.cleanup='release_unconfirmed'; r.verification.buttonIntegrity='failed'; }],
  ['transport release claimed as confirmed input', r => { r.cleanup='release_written'; }],
  ['additional press/release pair', r => { r.verification.observedPresses=2; r.verification.observedReleases=2; }],
  ['failed integrity called completed', r => { r.verification.buttonIntegrity='failed'; }],
  ['missing final cursor proof', r => { delete r.final; }],
  ['missing residual', r => { delete r.residual; }],
  ['final cursor outside tolerance', r => { r.final.x=15;r.residual.dx=-5; }],
  ['residual disagrees with final cursor', r => { r.final.x=11; }],
  ['nonfinite final cursor', r => { r.final.x=Infinity; }],
  ['missing feedback reliability', r => { delete r.verification.feedbackReliable; }],
  ['unreliable completed feedback', r => { r.verification.feedbackReliable=false; }],
  ['unreliable confirmed feedback', r => { r.outcome='indeterminate';r.verification.feedbackReliable=false; }],
  ['unreliable released-state claim', r => { r.outcome='indeterminate';r.verification.buttonIntegrity='failed';r.verification.feedbackReliable=false; }],
]) test(`shared hardware: ${label} rejects malformed success but does not revoke the task`,async t=>{
  const f=await fixture(t),bad=receipt();mutate(bad);
  f.port.native.request=async()=>bad;
  await assert.rejects(f.manager.runMouse('a',mouse(),signal()),error=>error.code==='invalid_receipt');
  assert.equal(f.manager.hasUncertainty,true);
  const marker=JSON.parse(await fs.readFile(path.join(f.dir,'shared-v2','input-uncertain.json'),'utf8'));
  assert.equal(marker.owner,'a');
  const restarted=new SharedInput(f.port);assert.equal(restarted.hasUncertainty,true);await restarted.stop();
});

test('shared hardware: verified success clears durable intent but never asserts application success',async t=>{
  const f=await fixture(t);
  const result=await f.manager.runMouse('a',mouse(),signal());
  assert.equal(result.cleanup,'release_confirmed');assert.equal(result.effectConfirmed,false);assert.equal(f.manager.hasUncertainty,false);
  await assert.rejects(fs.stat(path.join(f.dir,'shared-v2','input-uncertain.json')),error=>error.code==='ENOENT');
});

test('shared hardware: attempted write with no known success still retains protection',async t=>{
  const f=await fixture(t);
  f.port.native.request=async()=>({...receipt(),outcome:'aborted',transport:{attempted:1,written:0,writeFailed:1},cleanup:'release_unconfirmed',
    verification:{...receipt().verification,feedbackReliable:false,buttonIntegrity:'unavailable',pressObserved:false,releaseObserved:false,releaseStateConfirmed:false,observedPresses:0,observedReleases:0}});
  const result=await f.manager.runMouse('a',mouse(),signal());assert.equal(result.transport.written,0);assert.equal(f.manager.hasUncertainty,true);
});

test('shared hardware: no-write refusal with unavailable monitor does not leave an intent marker',async t=>{
  const f=await fixture(t);
  f.port.native.request=async()=>({...receipt(),outcome:'rejected',transport:{attempted:0,written:0,writeFailed:0},cleanup:'not_needed',errorCode:'button_feedback_unavailable',
    verification:{...receipt().verification,feedbackReliable:false,buttonIntegrity:'unavailable',pressObserved:false,releaseObserved:false,releaseStateConfirmed:false,observedPresses:0,observedReleases:0}});
  const result=await f.manager.runMouse('a',mouse(),signal());assert.equal(result.outcome,'rejected');assert.equal(f.manager.hasUncertainty,false);
  await assert.rejects(fs.stat(path.join(f.dir,'shared-v2','input-uncertain.json')),error=>error.code==='ENOENT');
});

test('shared hardware: monitor failure after a write with no reported edges remains uncertain across restart',async t=>{
  const f=await fixture(t);
  f.port.native.request=async()=>({...receipt(),outcome:'indeterminate',cleanup:'not_needed',errorCode:'button_feedback_unavailable',
    transport:{attempted:1,written:1,writeFailed:0},verification:{...receipt().verification,feedbackReliable:false,buttonIntegrity:'failed',
      pressObserved:false,releaseObserved:false,releaseStateConfirmed:false,observedPresses:0,observedReleases:0}});
  const result=await f.manager.runMouse('a',{...mouse(),action:{...action,kind:'move'}},signal());
  assert.equal(result.outcome,'indeterminate');assert.equal(result.verification.feedbackReliable,false);assert.equal(result.verification.observedPresses,0);
  assert.equal(f.manager.hasUncertainty,true);
  const marker=JSON.parse(await fs.readFile(path.join(f.dir,'shared-v2','input-uncertain.json'),'utf8'));
  assert.equal(marker.reason,'native_input_uncertain','valid failure must not be mistaken for malformed RPC');
  const restarted=new SharedInput(f.port);assert.equal(restarted.hasUncertainty,true);await restarted.stop();
});
