import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBuffer } from '../dist/events.js';
import { registerTools } from '../dist/tools.js';
import { loadConfig } from '../dist/env.js';
import { AudioRecorder } from '../dist/audio.js';
import { DeviceRegistry } from '../dist/state.js';
import { InjectController, parseModifiers } from '../dist/inject.js';
import { createCursorReader } from '../dist/cursor-pos.js';

test('audit event retention bounds one oversized payload and rejects circular values',()=>{
  const b=new EventBuffer(4); const large=b.push('d','warning',{raw:'x'.repeat(100000)});
  assert.equal(large.payload.truncated,true);assert.ok(JSON.stringify(b.since(0)).length<1024);
  const circular={};circular.self=circular;assert.equal(b.push('d','warning',circular).payload.reason,'event_payload_not_serializable');
});

function toolMap(bridge) {
  const map = new Map();
  registerTools({tool(name, desc, schema, handler) { map.set(name, {schema, handler}); }}, bridge);
  return map;
}
const decode = r => JSON.parse(r.content[0].text);
test('modifier parser rejects inherited property names and noninteger bits',()=>{
  for(const value of ['constructor','toString','__proto__',NaN,1.5]) assert.throws(()=>parseModifiers([value]));
});
test('event pagination never skips buffered matches', async () => {
  const events = new EventBuffer(300);
  for (let i=0;i<150;i++) events.push('a', 'keyEvent');
  const map=toolMap({events});
  const first=decode(await map.get('umouse_get_events').handler({since:0,limit:100}));
  const second=decode(await map.get('umouse_get_events').handler({since:first.nextSince,limit:100}));
  assert.equal(first.events.length+second.events.length,150);
});
test('wait pagination never skips buffered matches', async () => {
  const events = new EventBuffer(300);
  for (let i=0;i<150;i++) events.push('a','keyEvent');
  const map=toolMap({events});
  const first=decode(await map.get('umouse_wait_events').handler({since:0,timeout_ms:100}));
  assert.equal(first.nextSince,100);
});
test('reconfigure preserves explicit null reset', async () => {
  let actual;
  const map=toolMap({reconfigure:async r => {actual=r;return {ok:true};},status:()=>({})});
  await map.get('umouse_reconfigure').handler({usb:null,ble:null});
  assert.equal(actual.usb,null); assert.equal(actual.ble,null);
});
test('relative data directory is anchored before chdir', () => {
  assert.equal(loadConfig({UMSDK_DATA_DIR:'relative-audit'}).dataDir,path.resolve('relative-audit'));
});

test('removed automation flags cannot restore runtime or tool configuration', () => {
  const config=loadConfig({UMSDK_CUA_ENABLED:'1',UMSDK_CUA_WORKER:'missing',UMSDK_CUA_TRACE_FRAMES:'1'});
  assert.equal(Object.keys(config).some(k=>k.toLowerCase().includes('cua')),false);
});
test('USB numeric ABI fields reject wrapping and fractional values', () => {
  for (const vid of ['65536','-1','1.5','NaN']) assert.throws(()=>loadConfig({UMSDK_USB_VID:vid,UMSDK_USB_PID:'1'}));
});
test('device list does not resurrect absent SDK devices', () => {
  const registry=new DeviceRegistry(); registry.onConnected('old',0);
  assert.deepEqual(registry.list([]),[]);
});
test('WAV quota never removes unrelated audio files', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'umouse-audit-'));
  try {
    const other=path.join(dir,'personal.wav'); fs.writeFileSync(other,Buffer.alloc(2048));
    fs.utimesSync(other,new Date(0),new Date(0));
    const recorder=new AudioRecorder(dir,1,0.001,()=>{});
    recorder.startManual('a'); recorder.feed(Buffer.alloc(32),'a'); recorder.stop('manual');
    assert.ok(fs.existsSync(other));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
for (const op of ['drag','clickAt','click']) test(`${op} releases button 1 instead of repeating down`, async () => {
  const frames=[];
  const c=new InjectController({mouse:(...args)=>{frames.push(args);return 1;},keyboard:()=>1},{frameMs:1,clickMs:1},()=>({x:0,y:0}));
  try {
    if(op==='drag') await c.drag('left',10,0,'a');
    else if(op==='clickAt') await c.clickAt(0,0,'left',1,{deviceId:'a'});
    else await c.click('left',1,'a');
    assert.equal(frames.at(-1)[0],0);
    assert.equal(c.state().heldButtons,0);
  } finally {c.dispose();}
});
for (const op of ['drag','clickAt']) test(`${op} failed release remains tracked for shutdown`, async () => {
  let n=0; const frames=[];
  const c=new InjectController({mouse:(...args)=>{frames.push(args);return ++n===2?0:1;},keyboard:()=>1},{frameMs:1,clickMs:1},()=>({x:0,y:0}));
  try {
    if(op==='drag') await c.drag('left',0,0,'a');
    else await c.clickAt(0,0,'left',1,{deviceId:'a'});
    assert.equal(c.state().heldButtons,1);
    c.releaseAllSync(); assert.equal(frames.length,3); assert.equal(frames[2][0],0);
  } finally {c.dispose();}
});
test('cursor readers can be constructed repeatedly', {skip:process.platform!=='win32'}, () => {
  assert.ok(createCursorReader()); assert.ok(createCursorReader());
});

test('held state cannot migrate between devices',async()=>{
  const frames=[];
  const c=new InjectController({mouse:(...args)=>{frames.push(args);return 1;},keyboard:()=>1},{frameMs:1,clickMs:1});
  try {
    await c.button('press','left','a');
    await assert.rejects(c.move(1,0,'b'),/原设备/);
    assert.equal(frames.length,1); c.releaseAllSync();assert.equal(frames.at(-1)[4],'a');
  }finally{c.dispose();}
});
test('recording timer IO failure is reported and PCM is byte bounded',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'umouse-audio-'));const errors=[];
  try{
    const r=new AudioRecorder(dir,1,1,()=>{},e=>errors.push(e));
    r.startManual('a');r.feed(Buffer.alloc(64000),'a');
    assert.equal(r.last.bytes,32000);assert.equal(r.active,false);
    r.startManual('a');r.feed(Buffer.alloc(32),'a');
    fs.rmSync(dir,{recursive:true,force:true});
    assert.doesNotThrow(()=>r.stopSafely('timeout'));assert.equal(errors.length,1);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('iteration limit does not silently double requested pixel tolerance',async()=>{
  let x=0;
  const c=new InjectController({mouse:()=>1,keyboard:()=>1},{frameMs:1,clickMs:1},()=>({x:x++,y:0}));
  const r=await c.moveTo(20,0,{tolPx:3});
  assert.equal(r.residual.dx,5);assert.equal(r.ok,false);c.dispose();
});
