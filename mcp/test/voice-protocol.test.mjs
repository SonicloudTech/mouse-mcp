/* Real MCP initialize/tools/logging round trips over InMemoryTransport.
 * No SdkBridge construction, SDK binding, device input, microphone or ASR process.
 * VoiceInbox uses a synthetic WAV and a fake transcriber; this is not ASR accuracy evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../dist/server.js';
import { EventBuffer } from '../dist/events.js';
import { VoiceInbox } from '../dist/voice.js';
import { DeviceCapabilityRegistry } from '../dist/device-capabilities.js';
import { CapabilityGate } from '../dist/capability-gate.js';

const transcript='请把这段测试语音作为一条用户输入。';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

class ProtocolBridge extends EventEmitter {
  injectionEnabled=true;
  rawFrameEventsEnabled=false;
  rawDiagEnabled=false;
  voiceCoord=null;
  capabilities=new DeviceCapabilityRegistry();
  events=new EventBuffer(100);
  constructor(dir, transcribe, keyboardInjectionEnabled=false) {
    super();
    this.keyboardInjectionEnabled=keyboardInjectionEnabled;
    this.voice=new VoiceInbox(path.join(dir,'voice'),transcribe,{
      onEvent:(type,payload,deviceId)=>this.publish(type,payload,deviceId),
    });
  }
  publish(type,payload,deviceId='test-device') {
    const event=this.events.push(deviceId,type,payload);
    this.emit('event',event);
    return event;
  }
  onEvent(callback){this.on('event',callback);}
  status(){return {mock:true,voice:this.voice.status()};}
  listDevices(){return [{id:'test-device',connMode:'USB'}];}
  safeDeviceList(){return [{id:'test-device',mode:'USB'}];}
  devices={list:(live)=>live.map(d=>({id:d.id,connMode:d.mode,connected:true,generation:1,lastSeen:Date.now(),firstSeen:Date.now()}))};
  get gate(){return this._gate??=new CapabilityGate(this.capabilities);}
}

function syntheticWav(file) {
  const pcmBytes=3200,data=Buffer.alloc(44+pcmBytes);
  data.write('RIFF',0);data.writeUInt32LE(data.length-8,4);data.write('WAVE',8);
  data.write('fmt ',12);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);
  data.writeUInt16LE(1,22);data.writeUInt32LE(16000,24);data.writeUInt32LE(32000,28);
  data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(pcmBytes,40);
  fs.writeFileSync(file,data);
  return {path:file,deviceId:'test-device',durationMs:100,bytes:pcmBytes,reason:'key-up'};
}

function recordTransport(transport, direction, wire) {
  const send=transport.send.bind(transport);
  transport.send=async(message,options)=>{
    wire.push({direction,message:structuredClone(message)});
    return send(message,options);
  };
}

async function withProtocol(options, run) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'umouse-voice-protocol-'));
  const bridge=new ProtocolBridge(dir,options.transcribe??(async()=>({text:transcript,provider:'test',language:'zh-CN'})),options.keyboard??false);
  const record=syntheticWav(path.join(dir,'input.wav'));
  bridge.voice.start();
  const server=createMcpServer(bridge);
  const client=new Client({name:'umouse-offline-protocol-test',version:'1.0.0'},{capabilities:{}});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const wire=[],logs=[];
  recordTransport(clientTransport,'client',wire);recordTransport(serverTransport,'server',wire);
  client.setNotificationHandler(LoggingMessageNotificationSchema,notification=>{logs.push(notification.params);});
  const call=async(name,args={})=>{
    const result=await client.callTool({name,arguments:args});
    assert.equal(result.content[0].type,'text');
    return {result,value:JSON.parse(result.content[0].text)};
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run({bridge,server,client,record,wire,logs,call});
  } finally {
    await bridge.voice.stop();
    await client.close();await server.close();
    assert.equal(bridge.listenerCount('event'),0,'server close must detach its event forwarder');
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

test('voice protocol: initialize, instructions, logging capability and default/keyboard tool counts',async()=>{
  for(const keyboard of [false,true]) await withProtocol({keyboard},async({client,wire})=>{
    assert.equal(client.getServerVersion().name,'umouse-mcp');
    assert.deepEqual(client.getServerCapabilities().logging,{});
    assert.ok(client.getServerCapabilities().tools);
    assert.match(client.getInstructions(),/umouse_voice_start/);
    assert.match(client.getInstructions(),/umouse_voice_inbox/);
    assert.match(client.getInstructions(),/umouse_get_capabilities/);
    assert.match(client.getInstructions(),/通道写入/);
    assert.match(client.getInstructions(),/能力门控/);
    const {tools}=await client.listTools();
    assert.equal(tools.length,22,'静态面恒 22；注入工具由能力声明决定');
    assert.equal(tools.some(tool=>tool.name==='umouse_key_tap'),false,'G02/G08：软件开关不足以开放 keyboard_control——能力未声明(unknown)即隐藏');
    for(const name of ['umouse_voice_start','umouse_voice_wait','umouse_voice_finish','umouse_voice_cancel','umouse_voice_status','umouse_get_capabilities']) {
      assert.ok(tools.some(tool=>tool.name===name),name);
    }
    for(const name of ['umouse_voice_inbox','umouse_wait_voice','umouse_ack_voice']) {
      assert.ok(tools.some(tool=>tool.name===name),name);
    }
    assert.ok(wire.some(frame=>frame.direction==='client'&&frame.message.method==='initialize'));
    assert.ok(wire.some(frame=>frame.direction==='client'&&frame.message.method==='notifications/initialized'));
    assert.ok(wire.some(frame=>frame.direction==='client'&&frame.message.method==='tools/list'));
    assert.deepEqual(await client.setLoggingLevel('info'),{});
  });
});

test('voice protocol: logging honors requested level and transcript notification contains metadata only',async()=>{
  await withProtocol({},async({client,bridge,record,logs,wire,call})=>{
    await client.setLoggingLevel('warning');
    bridge.publish('keyEvent',{key:'speech',action:'down'});
    await tick();assert.equal(logs.length,0,'info notifications must respect warning threshold');
    await client.setLoggingLevel('info');
    bridge.publish('deviceInfo',{battery:100});
    await tick();assert.equal(logs.length,0,'non-notify event types remain in the pull stream only');
    const eventId=bridge.voice.capture(record);
    const {value}=await call('umouse_wait_voice',{timeout_ms:1000});
    assert.equal(value.messages[0].text,transcript);
    await tick();
    const notification=logs.find(log=>log.data.type==='speechTranscribed');
    assert.ok(notification);
    assert.equal(notification.level,'info');assert.equal(notification.logger,'umouse');
    assert.deepEqual(notification.data.payload,{eventId,status:'ready',errorCode:undefined});
    assert.equal(JSON.stringify(logs).includes(transcript),false);
    assert.equal('text' in notification.data.payload,false);
    const sent=wire.filter(frame=>frame.message.method==='notifications/message');
    assert.equal(sent.length,1);
    assert.equal(JSON.stringify(sent).includes(transcript),false);
    assert.equal(JSON.stringify(sent).includes(record.path),false);
  });
});

test('voice protocol: text is read without consumption, acknowledgement is idempotent and persists',async()=>{
  await withProtocol({},async({bridge,record,call,client})=>{
    const eventId=bridge.voice.capture(record);
    const ready=await call('umouse_wait_voice',{timeout_ms:1000});
    assert.equal(ready.value.timedOut,false);
    assert.equal(ready.value.messages[0].status,'ready');
    assert.equal(ready.value.messages[0].source,'physical-speech-button');
    for(let i=0;i<2;i++) {
      const inbox=await call('umouse_voice_inbox');
      assert.equal(inbox.value.messages.length,1);
      assert.equal(inbox.value.messages[0].eventId,eventId);
      assert.equal(inbox.value.messages[0].text,transcript);
    }
    for(let i=0;i<2;i++) {
      const ack=await call('umouse_ack_voice',{event_id:eventId});
      assert.deepEqual(ack.value,{ok:true,eventId});assert.notEqual(ack.result.isError,true);
    }
    assert.deepEqual((await call('umouse_voice_inbox')).value.messages,[]);
    const history=(await call('umouse_voice_inbox',{include_acknowledged:true})).value.messages;
    assert.equal(history.length,1);assert.equal(history[0].acknowledged,true);
    const unknown=await call('umouse_ack_voice',{event_id:'11111111-1111-4111-8111-111111111111'});
    assert.equal(unknown.result.isError,true);assert.equal(unknown.value.ok,false);
    const invalid=await client.callTool({name:'umouse_ack_voice',arguments:{event_id:'invalid-id'}});
    assert.equal(invalid.isError,true,'real protocol schema validation must reject malformed IDs');
    const saved=JSON.parse(fs.readFileSync(path.join(path.dirname(record.path),'voice','inbox.json'),'utf8'));
    assert.equal(saved.messages[0].eventId,eventId);assert.equal(saved.messages[0].acknowledged,true);
  });
});

test('voice protocol: wait remains pending while transcribing, then returns the committed result',async()=>{
  let resolveTranscript;
  const transcribe=(_record,signal)=>new Promise((resolve,reject)=>{
    resolveTranscript=resolve;
    signal.addEventListener('abort',()=>reject(new Error('test transcription cancelled')),{once:true});
  });
  await withProtocol({transcribe},async({bridge,record,call})=>{
    let finished=false;
    const waiting=call('umouse_wait_voice',{timeout_ms:1000}).then(result=>{finished=true;return result;});
    await tick();assert.equal(finished,false);
    const eventId=bridge.voice.capture(record);
    await tick();assert.equal(finished,false);
    const pending=(await call('umouse_voice_inbox')).value.messages[0];
    assert.equal(pending.status,'transcribing');assert.equal(pending.text,undefined);
    const premature=await call('umouse_ack_voice',{event_id:eventId});
    assert.equal(premature.result.isError,true);
    resolveTranscript({text:transcript,provider:'test',language:'zh-CN'});
    const ready=await waiting;
    assert.equal(ready.value.timedOut,false);
    assert.equal(ready.value.messages[0].eventId,eventId);
    assert.equal(ready.value.messages[0].text,transcript);
  });
});

test('voice protocol: bounded empty wait and invalid timeout schema',async()=>{
  await withProtocol({},async({call,client})=>{
    const empty=await call('umouse_wait_voice',{timeout_ms:100});
    assert.equal(empty.value.timedOut,true);assert.deepEqual(empty.value.messages,[]);
    for(const timeout_ms of [99,25001,1.5]) {
      const invalid=await client.callTool({name:'umouse_wait_voice',arguments:{timeout_ms}});
      assert.equal(invalid.isError,true);
    }
  });
});
