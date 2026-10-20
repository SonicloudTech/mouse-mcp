import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { loadConfig } from '../dist/env.js';
const require=createRequire(import.meta.url);
const binding=require('../../doc/umouse-sdk.js');
let instances=0;
class FakeSdk extends EventEmitter {
  running=false; starts=0; stops=0; detached=0;
  rawWrites=[];
  devices=[{id:'a',mode:'USB'},{id:'b',mode:'USB'}];
  constructor(){super();instances++;}
  version(){return 'mock';} isStarted(){return this.running;}
  setWorkMode(){return 1;} setDeviceLimit(){return 1;}
  setUsbConfigFor(){return 1;} setBleConfigFor(){return 1;}
  enableCrashReport(){} start(){this.running=true;this.starts++;}
  stop(){this.running=false;this.stops++;} unregisterCallbacks(){this.detached++;}
  deviceList(){return this.devices;} audioSource(){return '';}
  injectMouse(){return 1;} injectKeyboard(){return 1;}
  writeRaw(data,id){this.rawWrites.push({hex:data.toString('hex'),id});return 1;}
}
binding.UMouseSdk=FakeSdk;
const {SdkBridge}=await import('../dist/sdk-bridge.js');
test('bridge lifecycle, ownership and callback reuse', async t => {
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'umouse-bridge-'));
  const bridge=new SdkBridge(loadConfig({UMSDK_DATA_DIR:dir,UMSDK_VOICE:'0',UMSDK_TEST_CAPS:'{"*":{"mouse_control":"supported","keyboard_control":"supported"}}'}),{lease:null});
  try {
    await bridge.start(); const sdk=bridge.sdk;
    await t.test('speech key binds the emitting device, not first device',()=>{
      sdk.emit('message',JSON.stringify({type:'keyEvent',key:'speech',action:'down'}),'b');
      assert.equal(bridge.recorder.status().deviceId,'b');
      sdk.emit('message',JSON.stringify({type:'keyEvent',key:'speech',action:'up'}),'a');
      assert.equal(bridge.recorder.active,true);
      sdk.emit('message',JSON.stringify({type:'keyEvent',key:'speech',action:'up'}),'b');
      assert.equal(bridge.recorder.active,false);
    });
    await t.test('manual recording is not stopped by speech key up',()=>{
      bridge.audioRecord('start','a');
      sdk.emit('message',JSON.stringify({type:'keyEvent',key:'speech',action:'up'}),'a');
      assert.equal(bridge.recorder.active,true); bridge.audioRecord('stop');
    });
    await t.test('multiple devices require explicit recording id',()=>{
      assert.throws(()=>bridge.audioRecord('start'));
      assert.throws(()=>bridge.audioRecord('start','missing'));
    });
    await t.test('non-object SDK JSON cannot crash callback',()=>{
      for(const value of ['null','[]','123','bad']) assert.doesNotThrow(()=>sdk.emit('message',value,'a'));
    });
    await t.test('concurrent restart is serialized and reuses callback registrations',async()=>{
      bridge.audioRecord('start','a'); sdk.emit('connected','a',0);
      const result=await Promise.all([bridge.reconfigure({deviceLimit:2}),bridge.reconfigure({deviceLimit:3})]);
      assert.ok(result.every(r=>r.ok)); assert.equal(instances,1);
      assert.equal(sdk.starts,3); assert.equal(sdk.stops,2); assert.equal(sdk.detached,2);
      assert.equal(bridge.recorder.active,false); assert.equal(bridge.devices.stats().tracked,2);
      assert.equal(bridge.status().config.deviceLimit,3);
    });
    await t.test('restart cancels queued injection before reopening SDK',async()=>{
      const moving=bridge.inject.move(10000,0,'a');
      const rejection=assert.rejects(moving,/暂停/);
      const restarting=bridge.reconfigure({});
      await Promise.all([rejection,restarting]);
      assert.equal(bridge.inject.state().heldButtons,0);
    });
    await bridge.shutdown();
    await t.test('stopped bridge rejects recording start',()=>assert.throws(()=>bridge.audioRecord('start','a'),/SDK 未运行/));
  } finally {await bridge.shutdown();process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
});

const flushTimers=()=>new Promise(resolve=>setTimeout(resolve,10));
async function withBridge(config, action) {
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'umouse-sleep-bridge-'));
  const bridge=new SdkBridge(loadConfig({UMSDK_DATA_DIR:dir,UMSDK_VOICE:'0',...config}),{lease:null});
  try { await action(bridge); }
  finally {await bridge.shutdown();process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
}

test('bridge sleep reset: environment defaults, opt out and bounded timer validation',()=>{
  const config=loadConfig({});
  assert.equal(config.sleepResetEnabled,true);
  assert.equal(config.sleepResetIntervalMs,120_000);
  assert.equal(config.sleepResetAckTimeoutMs,5_000);
  assert.equal(config.sleepResetExpectAck,false);
  assert.equal(loadConfig({UMOUSE_SLEEP_RESET_EXPECT_ACK:'1'}).sleepResetExpectAck,true);
  assert.equal(loadConfig({UMOUSE_SLEEP_RESET_ENABLED:'0'}).sleepResetEnabled,false);
  const custom=loadConfig({UMOUSE_SLEEP_RESET_INTERVAL_MS:'10000',UMOUSE_SLEEP_RESET_ACK_TIMEOUT_MS:'500'});
  assert.equal(custom.sleepResetIntervalMs,10000);assert.equal(custom.sleepResetAckTimeoutMs,500);
  for(const value of ['0','1','-1','1.5','NaN','2147483648','']) {
    assert.throws(()=>loadConfig({UMOUSE_SLEEP_RESET_INTERVAL_MS:value}),/UMOUSE_SLEEP_RESET_INTERVAL_MS/);
  }
  for(const value of ['0','-1','NaN','1.5','60001','']) {
    assert.throws(()=>loadConfig({UMOUSE_SLEEP_RESET_ACK_TIMEOUT_MS:value}),/UMOUSE_SLEEP_RESET_ACK_TIMEOUT_MS/);
  }
  assert.doesNotThrow(()=>loadConfig({UMOUSE_SLEEP_RESET_INTERVAL_MS:'5000'}));
  assert.throws(()=>loadConfig({UMOUSE_SLEEP_RESET_INTERVAL_MS:'5000',UMOUSE_SLEEP_RESET_EXPECT_ACK:'1'}),/必须小于/);
});

test('bridge idle exit: two-stage defaults, zero restores legacy, exit must outlast worker grace',()=>{
  const defaults=loadConfig({});
  assert.equal(defaults.idleWorkerMs,60_000);
  assert.equal(defaults.idleExitMs,300_000);
  const legacy=loadConfig({UMSDK_IDLE_WORKER_MS:'0',UMSDK_IDLE_EXIT_MS:'0'});
  assert.equal(legacy.idleWorkerMs,0);assert.equal(legacy.idleExitMs,0);
  const custom=loadConfig({UMSDK_IDLE_WORKER_MS:'5000',UMSDK_IDLE_EXIT_MS:'600000'});
  assert.equal(custom.idleWorkerMs,5000);assert.equal(custom.idleExitMs,600000);
  for(const value of ['1','-1','1.5','NaN']) {
    assert.throws(()=>loadConfig({UMSDK_IDLE_WORKER_MS:value}),/UMSDK_IDLE_WORKER_MS/);
    assert.throws(()=>loadConfig({UMSDK_IDLE_EXIT_MS:value}),/UMSDK_IDLE_EXIT_MS/);
  }
  assert.equal(loadConfig({UMSDK_IDLE_WORKER_MS:'',UMSDK_IDLE_EXIT_MS:''}).idleWorkerMs,60_000);
  assert.throws(()=>loadConfig({UMSDK_IDLE_WORKER_MS:'2000',UMSDK_IDLE_EXIT_MS:'2000'}),/UMSDK_IDLE_EXIT_MS 必须/);
  assert.throws(()=>loadConfig({UMSDK_IDLE_EXIT_MS:'2000'}),/UMSDK_IDLE_EXIT_MS 必须为 10000/);
  assert.doesNotThrow(()=>loadConfig({UMSDK_IDLE_WORKER_MS:'0',UMSDK_IDLE_EXIT_MS:'20000'}));
});

test('bridge sleep reset: initial SDK list, separate ACK without raw event exposure, disconnect',async()=>{
  await withBridge({},async bridge=>{
    assert.deepEqual(await bridge.start(),{ok:true});
    const sdk=bridge.sdk;
    assert.equal(sdk.rawWrites.length,0,'no write inside SDK start/connected callback');
    assert.equal(bridge.devices.stats().tracked,2,'SDK startup list seeds capability epochs without publishing fake connected events');
    await flushTimers();
    assert.deepEqual(sdk.rawWrites,[{hex:'0a03a2',id:'a'},{hex:'0a03a2',id:'b'}]);
    assert.equal(bridge.status().sleepReset.writesSucceeded,2);
    assert.equal(bridge.status().sleepReset.acknowledgementExpected,false);
    assert.ok(bridge.status().sleepReset.devices.every(d=>!d.awaitingAck));
    assert.equal(bridge.status().sleepReset.acknowledgements,0);
    const response=Buffer.from('0a0a178105a2','hex');
    sdk.emit('rawFrame',response,response.length,0,'a');
    assert.equal(bridge.status().sleepReset.acknowledgements,1);
    assert.equal(bridge.events.since(0,['rawFrame']).length,0);
    assert.ok(bridge.events.since(0,['sleepReset']).some(e=>e.payload.phase==='ack'));
    sdk.emit('disconnected','b',0);
    assert.deepEqual(bridge.status().sleepReset.devices.map(d=>d.deviceId),['a']);
    sdk.emit('connected','a',0);await flushTimers();
    assert.equal(sdk.rawWrites.length,2,'duplicate connection does not reset timer');
    await bridge.shutdown();
    assert.equal(bridge.status().sleepReset.running,false);
    assert.deepEqual(bridge.status().sleepReset.devices,[]);
  });
});

test('bridge sleep reset: explicit ACK firmware option reaches controller',async()=>{
  await withBridge({UMOUSE_SLEEP_RESET_EXPECT_ACK:'1'},async bridge=>{
    await bridge.start(); await flushTimers();
    assert.equal(bridge.status().sleepReset.acknowledgementExpected,true);
    assert.ok(bridge.status().sleepReset.devices.every(d=>d.awaitingAck));
  });
});

test('bridge sleep reset: connection inside SDK start is deferred and failed start clears it',async()=>{
  await withBridge({},async bridge=>{
    const sdk=new FakeSdk();bridge.sdk=sdk;sdk.devices=[];
    sdk.start=()=>{sdk.emit('connected','early',0);throw new Error('mock start failed');};
    const failed=await bridge.start();
    assert.equal(failed.ok,false);assert.match(failed.error,/mock start failed/);
    await flushTimers();
    assert.equal(sdk.rawWrites.length,0);
    assert.deepEqual(bridge.status().sleepReset.devices,[]);
    sdk.start=()=>{
      sdk.running=true;sdk.emit('connected','fresh',0);
      assert.equal(sdk.rawWrites.length,0,'callback cannot write before SDK.start returns');
    };
    assert.deepEqual(await bridge.start(),{ok:true});
    await flushTimers();
    assert.deepEqual(sdk.rawWrites,[{hex:'0a03a2',id:'fresh'}]);
  });
});

test('bridge sleep reset: shutdown stops before suspension await and clears late connections',async()=>{
  await withBridge({},async bridge=>{
    await bridge.start();await flushTimers();
    const sdk=bridge.sdk,before=sdk.rawWrites.length;
    const suspend=bridge.inject.suspend.bind(bridge.inject);
    bridge.inject.suspend=async()=>{
      assert.equal(bridge.sleepReset.status().running,false);
      sdk.emit('connected','late-during-shutdown',0);
      await flushTimers();
      assert.equal(sdk.rawWrites.length,before);
      return suspend();
    };
    await bridge.shutdown();
    bridge.inject.suspend=suspend;
    assert.deepEqual(bridge.status().sleepReset.devices,[]);
    await bridge.start();await flushTimers();
    assert.equal(sdk.rawWrites.some(w=>w.id==='late-during-shutdown'),false);
    assert.equal(sdk.rawWrites.length,before+2);
  });
});

test('bridge sleep reset: disabled configuration creates no raw writes',async()=>{
  await withBridge({UMOUSE_SLEEP_RESET_ENABLED:'0'},async bridge=>{
    await bridge.start();bridge.sdk.emit('connected','a',0);await flushTimers();
    assert.equal(bridge.sdk.rawWrites.length,0);
    assert.equal(bridge.status().sleepReset.enabled,false);
    assert.equal(bridge.status().sleepReset.running,false);
  });
});

test('speech button to recording to transcription survives reconfigure; manual WAV does not upload', async()=>{
  let uploads=0;
  const server=http.createServer(async(req,res)=>{
    const chunks=[]; for await(const data of req) chunks.push(data);
    assert.match(Buffer.concat(chunks).toString('latin1'),/RIFF/);
    uploads++; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({text:'测试语音'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await withBridge({UMSDK_ASR_PROVIDER:'http',UMSDK_ASR_ENDPOINT:`http://127.0.0.1:${server.address().port}/asr`},async bridge=>{
      await bridge.start(); const sdk=bridge.sdk;
      const key=action=>sdk.emit('message',JSON.stringify({type:'keyEvent',key:'speech',action}),'b');
      key('down'); sdk.emit('audio',Buffer.alloc(3200),3200,'b'); key('up');
      const [message]=await bridge.voice.wait(5000);
      assert.equal(message.status,'ready'); assert.equal(message.text,'测试语音'); assert.equal(message.deviceId,'b');
      const event=bridge.events.since(0,['speechTranscribed'])[0];
      assert.equal(event.payload.eventId,message.eventId); assert.equal('text' in event.payload,false);
      await bridge.reconfigure({deviceLimit:3});
      assert.equal(bridge.voice.list()[0].eventId,message.eventId);
      assert.equal(bridge.voice.acknowledge(message.eventId),true);
      bridge.audioRecord('start','b'); sdk.emit('audio',Buffer.alloc(3200),3200,'b'); bridge.audioRecord('stop');
      await flushTimers(); assert.equal(uploads,1); assert.deepEqual(bridge.voice.list(),[]);
    });
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('ASR configuration requires explicit HTTP selection and never exposes credentials in status', async()=>{
  const cfg=loadConfig({UMSDK_ASR_ENDPOINT:'https://example.invalid/ignored'});
  assert.notEqual(cfg.asr?.provider,'http');
  assert.equal(loadConfig({UMSDK_ASR_PROVIDER:'disabled'}).asr,null);
  assert.throws(()=>loadConfig({UMSDK_ASR_PROVIDER:'http'}));
  assert.throws(()=>loadConfig({UMSDK_ASR_PROVIDER:'unknown'}));
  await withBridge({UMSDK_ASR_PROVIDER:'http',UMSDK_ASR_ENDPOINT:'https://example.invalid/asr?secret=hidden',UMSDK_ASR_API_KEY:'private-test-key'},async bridge=>{
    assert.doesNotMatch(JSON.stringify(bridge.status()),/private-test-key|secret=hidden/);
  });
});

test('busy SDK lease preserves live inbox and creates no SDK; later ownership reloads storage',async()=>{
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'umouse-lease-bridge-'));
  const inbox=path.join(dir,'voice','inbox.json');fs.mkdirSync(path.dirname(inbox));
  const original='{"schemaVersion":1,"messages":[]}'; fs.writeFileSync(inbox,original);
  let owner=false,releases=0;
  const lease={tryAcquire:async()=>owner,release:async()=>{releases++;},status:()=>({supported:true,state:owner?'owned':'busy'})};
  const bridge=new SdkBridge(loadConfig({UMSDK_DATA_DIR:dir}),{lease});
  const before=instances;
  try {
    assert.equal((await bridge.start()).ok,false);assert.equal(bridge.waitingForSdk,true);
    assert.equal(instances,before);assert.equal(fs.readFileSync(inbox,'utf8'),original);
    assert.equal(bridge.status().sdkOwnership.state,'busy');assert.throws(()=>bridge.voice,/所有权/);
    owner=true;assert.equal((await bridge.start()).ok,true);assert.equal(instances,before+1);
    assert.equal(bridge.waitingForSdk,false);
    await bridge.reconfigure({}); assert.equal(releases,0,'controlled restart must retain ownership');
    const firstInbox=bridge.voice;
    await bridge.shutdown();assert.equal(releases,1);assert.throws(()=>bridge.voice);
    await bridge.start();assert.notEqual(bridge.voice,firstInbox,'reacquisition reloads inbox changed by another owner');
  } finally {await bridge.shutdown();process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
});

test('concurrent bridge start and shutdown cannot release an SDK that is still running',async()=>{
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'umouse-lease-order-'));
  let releases=0;
  const lease={tryAcquire:async()=>true,release:async()=>{releases++;},status:()=>({supported:true,state:'owned'})};
  const bridge=new SdkBridge(loadConfig({UMSDK_DATA_DIR:dir}),{lease});
  const before=instances;
  try {
    await Promise.all([bridge.start(),bridge.start()]); assert.equal(instances,before+1);
    const stop=bridge.sdk.stop.bind(bridge.sdk); bridge.sdk.stop=()=>{throw new Error('native stop failed');};
    await assert.rejects(bridge.shutdown(),/保留占用锁/);assert.equal(releases,0);
    bridge.sdk.stop=stop;
    await bridge.shutdown();assert.equal(releases,1);
  } finally {await bridge.shutdown();process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
});
