// Repair acceptance: synthetic events and fake input only, no SDK owner/HID/microphone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceCoordinator, DEFAULT_VOICE_CONFIG } from '../dist/voice-session.js';
import { createBatchAsrProviderFactory, withSnapshotPreview } from '../dist/asr-service.js';
import { DeviceCapabilityRegistry } from '../dist/device-capabilities.js';
import { createRealTyper, DeliveryLedger } from '../dist/voice-typer-binding.js';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, options = {}) {
  const providers = [], typed = [];
  const host = { source: '', creates: 0, destroys: 0, epoch: 1,
    setAudioSource(id) { if(options.sourceFailure) return {ok: 0, source: this.source}; this.source = id ?? ''; return {ok:1, source:this.source}; },
    audioSource() { return this.source; }, isOnline: () => true, generationOf() { return this.epoch; }, defaultDevice: () => 'd',
    checkVoice: () => ({allowed:true}), meetingCreate() { this.creates++; return 1; }, meetingDestroy() { this.destroys++; return 1; },
  };
  const factory = (events, init) => {
    const p = { bytes: 0, finishes: 0, cancels: 0, complete(text='text') {
      events.segmentFinal(text, init); events.terminal({ok:true}, init);
    }, fail() { events.terminal({ok:false, error:'network failed'}, init); } };
    providers.push(p);
    return { id:'fake', supportsPreview:true, begin() { if(options.beginThrow) throw new Error('begin failed'); },
      writePcm(b) { p.bytes += b.length; }, finishInput() { p.finishes++; if(options.syncFinal) p.complete(); },
      cancel() { p.cancels++; events.terminal({ok:false,cancelled:true}, init); } };
  };
  const c = new VoiceCoordinator(host, factory, {available:true,id:'fake',async deliver(r) {typed.push(r); return {outcome:'submitted'};}},
    {...DEFAULT_VOICE_CONFIG, drainWaitMs:35, closeConfirmWaitMs:35, asrFinalWaitMs:35,
      createConfirmWaitMs:40,pcmReadyWaitMs:40,closeUnconfirmedIsolationMs:10,...options.config});
  t.after(() => c.shutdown());
  const listen = async () => { const p=c.voiceStart({deviceId:'d',endMode:'manual_only'}); c.onMeetingCreated('d'); c.onPcm('d',Buffer.alloc(320)); return p; };
  const ptt = () => { c.onSpeechKey('d','down'); c.onPcm('d',Buffer.alloc(320)); return c.current.sessionId; };
  return {c,host,providers,typed,listen,ptt};
}

test('R01 cancelled Agent remains isolated beyond elapsed timeout; requires both ACK and boundary', async t => {
  const {c,listen,host}=fixture(t); const {sessionId}=await listen(); await c.voiceCancel(sessionId);
  await sleep(65);
  assert.equal((await c.voiceStart({deviceId:'d'})).code,'close_unconfirmed');
  c.onMeetingDestroyed('d','device-frame');
  assert.equal((await c.voiceStart({deviceId:'d'})).code,'close_unconfirmed');
  c.onAudioSegmentComplete('d',1,'meeting-destroyed');
  assert.equal((await listen()).ok,true); assert.equal(host.creates,2);
});

test('R02 boundary before ACK also keeps ownership until physical close', async t => {
  const {c,listen,providers}=fixture(t); const s=await listen(); await c.voiceFinish(s.sessionId);
  c.onAudioSegmentComplete('d',1,'meeting-destroyed'); providers[0].complete();
  assert.equal((await c.voiceStart({deviceId:'d'})).code,'close_unconfirmed');
  c.onMeetingDestroyed('d','legacy'); assert.equal(c.hasPendingClose('d'),true);
  c.onMeetingDestroyed('d','device-frame'); assert.equal(c.hasPendingClose('d'),false);
  assert.equal((await listen()).ok,true);
});

test('R03 cancel after key-up still waits for decode barrier, never types', async t => {
  const {c,ptt,providers,typed}=fixture(t); const id=ptt(); c.onSpeechKey('d','up');
  await c.voiceCancel(id); assert.equal(c.current.state,'awaiting-key-up');
  providers[0].complete(); c.onAudioSegmentComplete('d',1,'key-up'); await sleep(0);
  assert.equal(c.current,null); assert.equal(c.session(id).state,'cancelled'); assert.equal(typed.length,0);
});

test('R04 held-key cancellation requires release AND segment, ignores old ASR', async t => {
  const {c,ptt,providers,typed}=fixture(t); const id=ptt(); await c.voiceCancel(id);
  c.onSpeechKey('d','up'); providers[0].complete('late');
  assert.equal(c.current.state,'awaiting-key-up');
  c.onAudioSegmentComplete('d',1,'key-up'); assert.equal(c.current,null); assert.equal(typed.length,0);
});

test('R05 no segment boundary fails closed, without calling finishInput', async t => {
  const {c,ptt,providers,typed}=fixture(t); const id=ptt(); c.onSpeechKey('d','up');
  await sleep(70); assert.equal(c.session(id).state,'failed'); assert.equal(providers[0].finishes,0); assert.equal(typed.length,0);
});

test('R06 ASR final timeout must not type partial preview', async t => {
  const {c,ptt,typed,providers}=fixture(t); const id=ptt(); c.onSpeechKey('d','up');
  c.onAudioSegmentComplete('d',1,'key-up'); await sleep(70); providers[0].complete('late');
  assert.equal(c.session(id).state,'failed'); assert.equal(typed.length,0);
});

test('R07 synchronous final cleans ASR timer and delivers once', async t => {
  const {c,ptt,typed}=fixture(t,{syncFinal:true}); const id=ptt(); c.onSpeechKey('d','up');
  c.onAudioSegmentComplete('d',1,'key-up'); await sleep(65);
  assert.equal(c.session(id).state,'delivered'); assert.equal(typed.length,1); assert.deepEqual(c.timers,{});
});

for (const reason of ['key-up-incomplete','queue-overflow-incomplete']) test(`R08 ${reason} stops incomplete input`, async t => {
  const {c,ptt,typed,providers}=fixture(t); const id=ptt(); c.onSpeechKey('d','up');
  c.onAudioSegmentComplete('d',1,reason); providers[0].complete();
  assert.equal(c.session(id).state,'failed'); assert.equal(typed.length,0);
});

test('R09 source selection failure creates no meeting and releases reservation', async t => {
  const {c,host}=fixture(t,{sourceFailure:true}); const r=await c.voiceStart({deviceId:'d'});
  assert.equal(r.ok,false); assert.equal(host.creates,0); assert.equal(c.current,null);
});

test('R10 begin exception cancels allocated provider, no device command', async t => {
  const {c,host,providers}=fixture(t,{beginThrow:true}); const r=await c.voiceStart({deviceId:'d'});
  assert.equal(r.ok,false); assert.equal(providers[0].cancels,1); assert.equal(host.creates,0); assert.equal(c.current,null);
});

test('R11 early ASR network failure closes microphone and wakes waiters', async t => {
  const {c,listen,providers,host}=fixture(t); const s=await listen(); const waiting=c.voiceWait(s.sessionId,25000);
  providers[0].fail(); const result=await waiting;
  assert.equal(result.state,'failed'); assert.equal(host.destroys,1); assert.equal(c.hasPendingClose('d'),true); assert.equal(c.waiters.size,0);
});

test('R12 shutdown fences callbacks and further start calls', async t => {
  const {c,ptt,providers,typed}=fixture(t); ptt(); c.onSpeechKey('d','up'); c.onAudioSegmentComplete('d',1,'key-up');
  await c.shutdown(); providers[0].complete(); c.onSpeechKey('d','down');
  assert.equal(c.current,null); assert.equal(typed.length,0); assert.equal((await c.voiceStart({})).code,'shutdown');
});

test('R13 successful completed wait clears its long timeout and listener', async t => {
  const {c,listen,providers}=fixture(t); const s=await listen(); const waiting=c.voiceWait(s.sessionId,25000);
  await c.voiceFinish(s.sessionId); c.onMeetingDestroyed('d','device-frame'); c.onAudioSegmentComplete('d',1,'meeting-destroyed'); providers[0].complete();
  assert.equal((await waiting).text,'text'); assert.equal(c.waiters.size,0);
});

test('R14 batch cancellation aborts in-flight transcriber and suppresses late text', async () => {
  let signal, complete; const results=[];
  const p=createBatchAsrProviderFactory((_file,s)=> {signal=s;return new Promise(r=>complete=r);})({terminal:r=>results.push(r)}, {sessionId:'s',deviceId:'d'});
  p.begin({sessionId:'s',deviceId:'d'});p.writePcm(Buffer.alloc(320));p.finishInput();p.cancel();
  assert.equal(signal.aborted,true);complete({text:'late'});await sleep(0);assert.equal(results.filter(r=>r.ok).length,0);
});

test('R15 snapshot finalization aborts preview; preview uses full-prefix metadata', async () => {
  let signal, resolve; const events=[];
  const factory=withSnapshotPreview(()=>({id:'base',supportsPreview:false,begin(){},writePcm(){},finishInput(){},cancel(){}}),
    (_file,s)=>{signal=s;return new Promise(r=>resolve=r);},{intervalMs:100});
  const p=factory({terminal(){},preview:(...r)=>events.push(r)},{sessionId:'s',deviceId:'d'});
  p.begin({});p.writePcm(Buffer.alloc(320));await sleep(130);p.finishInput();
  assert.equal(signal.aborted,true);resolve({text:'late'});await sleep(0);assert.equal(events.length,0);
});

test('R16 replacing test profile cannot transiently override hardware denial', () => {
  const r=new DeviceCapabilityRegistry();r.onGenerationChange('d',1);r.applyDeviceCapabilities('d',1,{mouse_control:'unsupported'});
  const observed=[];r.onChange(()=>observed.push(r.supportOf('d','mouse_control').support));
  r.setTestProfile('d',{mouse_control:'supported',keyboard_control:'supported'});r.setTestProfile('d',{});
  assert.ok(observed.every(x=>x==='unsupported'));assert.equal(r.supportOf('d','keyboard_control').support,'unknown');
});

function fakeTyper() { const calls=[]; return {calls,binding:{Typer:class {
  version(){return 'fake';}probe(){return {input_permitted:1,text_typing:1};}init(){return true;}
  typeText(text){calls.push(text);return 0;}strerror(){return '';}async shutdown(){}
}}}; }
test('R17 attempting ledger survives restart and prevents automatic replay', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-repair-ledger-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  new DeliveryLedger(dir).record({kind:'deliver',sessionId:'same',at:new Date().toISOString(),outcome:'attempting',textLength:1,textSha256:'hash',text:'x'});
  const f=fakeTyper();const typer=createRealTyper({ledgerDir:dir,bindingOverride:f.binding});t.after(()=>typer.shutdown());
  assert.notEqual((await typer.deliver({sessionId:'same',text:'x',deviceId:'d'})).outcome,'submitted');assert.equal(f.calls.length,0);
});
test('R18 ledger write failure sends no input', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-repair-ledger-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'blocked'),'file');const f=fakeTyper();const typer=createRealTyper({ledgerDir:path.join(dir,'blocked'),bindingOverride:f.binding});t.after(()=>typer.shutdown());
  assert.equal((await typer.deliver({sessionId:'s',text:'x',deviceId:'d'})).outcome,'failed');assert.equal(f.calls.length,0);
});
test('R19 shutdown typer refuses new delivery before native input', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-repair-ledger-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fakeTyper();const typer=createRealTyper({ledgerDir:dir,bindingOverride:f.binding});await typer.shutdown();
  assert.equal((await typer.deliver({sessionId:'s',text:'x',deviceId:'d'})).outcome,'unavailable');assert.equal(f.calls.length,0);
});
test('R21 dispatch overflow invalidates ASR before its delayed final', async t => {
  const {c,ptt,typed,providers}=fixture(t);const id=ptt();c.onSpeechKey('d','up');c.onAudioSegmentComplete('d',1,'key-up');
  c.onStreamIncomplete('d');providers[0].complete();assert.equal(c.session(id).state,'failed');assert.equal(typed.length,0);
});

test('R22 lost PTT barrier blocks reuse until its eventual matching boundary', async t => {
  const {c,ptt}=fixture(t);ptt();c.onSpeechKey('d','up');await sleep(70);
  assert.equal((await c.voiceStart({deviceId:'d'})).code,'close_unconfirmed');
  c.onAudioSegmentComplete('d',1,'key-up');assert.equal(c.hasPendingClose('d'),false);
});

test('R23 incomplete but observed key-up boundary fails that transcript without blocking the next', async t => {
  const {c,ptt}=fixture(t);const id=ptt();c.onSpeechKey('d','up');c.onAudioSegmentComplete('d',1,'key-up-incomplete');
  assert.equal(c.session(id).state,'failed');assert.equal(c.hasPendingClose('d'),false);assert.ok(ptt());
});

test('audit V-P1-2 lost key-up ends the active session but never fabricates microphone closure', async t => {
  const {c,ptt,providers,typed}=fixture(t,{config:{maxDurationMs:35}});
  const id=ptt(); await c.voiceCancel(id); await sleep(75);
  assert.equal(c.current,null); assert.equal(c.session(id).state,'failed');
  assert.equal(c.hasPendingClose('d'),true); providers[0].complete('late'); assert.equal(typed.length,0);
  assert.equal(c.status().recovery.automaticExpiry,false);
  c.onSpeechKey('d','up'); c.onAudioSegmentComplete('d',1,'key-up');
  assert.equal(c.hasPendingClose('d'),false);
});

test('audit V-P2-4 max duration freezes audio, then delivers only after release and decode barrier', async t => {
  const {c,ptt,providers,typed}=fixture(t,{config:{maxDurationMs:500}}); const id=ptt();
  c.onPcm('d',Buffer.alloc(16_000)); assert.equal(c.current.state,'awaiting-key-up');
  const bytes=providers[0].bytes; c.onPcm('d',Buffer.alloc(320)); assert.equal(providers[0].bytes,bytes);
  assert.equal(providers[0].cancels,0); assert.equal(providers[0].finishes,0);
  c.onSpeechKey('d','up'); assert.equal(providers[0].finishes,0);
  c.onAudioSegmentComplete('d',1,'key-up'); assert.equal(providers[0].finishes,1);
  providers[0].complete('captured text'); await sleep(0);
  assert.equal(c.session(id).state,'delivered'); assert.equal(typed.length,1);
});

test('audit V-P0-1 SDK stop reset clears obsolete evidence; active reset is refused', async t => {
  const {c,listen}=fixture(t); const s=await listen();
  assert.throws(()=>c.resetAfterSdkStopped(),/voice_session_active/);
  await c.voiceCancel(s.sessionId); assert.equal(c.hasPendingClose(),true);
  c.resetAfterSdkStopped(); assert.equal(c.hasPendingClose(),false);
  assert.equal(c.status().recovery,undefined); assert.equal((await listen()).ok,true);
});

test('audit old device generation cleanup does not send destroy to replacement hardware', async t => {
  const {c,listen,host}=fixture(t); const s=await listen(); host.epoch++;
  await c.voiceCancel(s.sessionId); assert.equal(host.destroys,0); assert.equal(c.hasPendingClose(),true);
});

test('audit C-P2-1 desktop guard rejects dictation before ledger or input', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-audit-guard-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fakeTyper(); let blocked=true;
  const typer=createRealTyper({ledgerDir:dir,bindingOverride:f.binding,beforeInput(){if(blocked)throw Error('busy');}});t.after(()=>typer.shutdown());
  assert.equal((await typer.deliver({sessionId:'s',text:'text',deviceId:'d'})).outcome,'unavailable');
  assert.equal(f.calls.length,0); assert.equal(new DeliveryLedger(dir).has('s'),false);
  blocked=false; assert.equal((await typer.deliver({sessionId:'new-session',text:'text',deviceId:'d'})).outcome,'submitted');
});

test('audit ledger replacement requests owner-only file permissions for retained transcript',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-audit-mode-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const open=fs.openSync,modes=[];
  fs.openSync=(p,flags,mode)=>{if(String(p).includes('deliveries.jsonl.')&&flags==='wx')modes.push(mode);return open(p,flags,mode);};
  try{new DeliveryLedger(dir).record({kind:'deliver',sessionId:'s',at:'now',outcome:'attempting',textLength:4,textSha256:'hash',text:'test'});}
  finally{fs.openSync=open;}
  assert.deepEqual(modes,[0o600]);assert.equal(new DeliveryLedger(dir).has('s'),true);
  if(process.platform==='win32') {
    const script='$ErrorActionPreference="Stop"; $acl=[System.IO.File]::GetAccessControl($env:UMCP_AUDIT_ACL_FILE); $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value}); @{protected=$acl.AreAccessRulesProtected; rules=$rules; current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress';
    const acl=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,env:{...process.env,UMCP_AUDIT_ACL_FILE:path.join(dir,'deliveries.jsonl')}}));
    assert.equal(acl.protected,true);assert.deepEqual(acl.rules.sort(),[acl.current,'S-1-5-18'].sort());
  }
});

test('audit V-P2-2 stalled PCM does not repeatedly transcribe identical snapshots', async () => {
  let calls=0;
  const f=withSnapshotPreview(()=>({id:'fake',begin(){},writePcm(){},finishInput(){},cancel(){}}),async()=>{calls++;return{text:'preview'};},{intervalMs:100});
  const p=f({terminal(){}},{sessionId:'s',deviceId:'d'});
  try { p.begin({});p.writePcm(Buffer.alloc(320));await sleep(360);assert.equal(calls,1);
    p.writePcm(Buffer.alloc(320));await sleep(140);assert.equal(calls,2);
  } finally { p.cancel(); }
});
