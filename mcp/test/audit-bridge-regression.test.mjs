// Integrated production bridge with FakeSdk. No HID/keyboard/mouse/mic I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/env.js';
import { createRealTyper } from '../dist/voice-typer-binding.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const req = createRequire(import.meta.url);
const binding = req('../../doc/umouse-sdk.js');
class FakeSdk extends EventEmitter {
  running = false; source = ''; sets = []; writes = []; creates = 0;
  version() { return 'fake-0.4.23'; } isStarted() { return this.running; }
  setWorkMode() { return 1; } setDeviceLimit() { return 1; }
  enableCrashReport() {} setUsbConfigFor() { return 1; } setBleConfigFor() { return 1; }
  start() { this.running = true; this.emit('connected', 'd', 0); }
  stop() { this.running = false; } unregisterCallbacks() {}
  deviceList() { return [{ id: 'd', mode: 'USB' }]; }
  audioSource() { return this.source; }
  setAudioSource(id) { this.sets.push(id); this.source = id ?? ''; return 1; }
  meetingCreate() { this.creates++; return 1; } meetingDestroy() { return 1; }
  meetingPause() { return 1; } meetingResume() { return 1; }
  writeRaw(buf, id) { this.writes.push(['raw', id, buf.toString('hex')]); return 1; }
  injectMouse(...args) { this.writes.push(['mouse', ...args]); return 1; }
  injectKeyboard(...args) { this.writes.push(['keyboard', ...args]); return 1; }
}
binding.UMouseSdk = FakeSdk;
const { SdkBridge } = await import('../dist/sdk-bridge.js');
const { createMcpServer } = await import('../dist/server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umouse-independent-audit-'));
  const cwd = process.cwd();
  const b = new SdkBridge(loadConfig({ UMSDK_DATA_DIR: dir, UMSDK_ASR_PROVIDER: 'disabled',
    UMSDK_VOICE_UI: '0', UMSDK_VOICE_TYPER: '0', UMOUSE_SLEEP_RESET_ENABLED: '0', ...extra }), { lease: null });
  const asrs = [];
  if (b.voiceCoord) b.voiceCoord.asrFactory = (callbacks, init) => {
    const item = { callbacks, init, complete(text = 'audit') {
      callbacks.segmentFinal(text, { sessionId: init.sessionId }); callbacks.terminal({ ok: true }, { sessionId: init.sessionId });
    } }; asrs.push(item);
    return { id: 'fake', supportsPreview: false, begin() {}, writePcm() {}, finishInput() {}, cancel() {} };
  };
  await b.start();
  t.after(async () => {
    const c = b.voiceCoord;
    if (c) {
      if (c.current) c.onDeviceDisconnected('d');
      c.clearTimers(); for (const timer of c.closeTimers.values()) clearTimeout(timer); c.closeTimers.clear();
    }
    await b.shutdown(); process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true });
  });
  const listen = async () => {
    const p = b.voiceCoord.voiceStart({ deviceId: 'd', endMode: 'manual_only' });
    b.voiceCoord.onMeetingCreated('d'); b.voiceCoord.onPcm('d', Buffer.alloc(320)); return p;
  };
  return { b, asrs, dir, listen };
}

test('audit V-P0-1 reconfigure requires offline hardware and a confirmed SDK stop before clearing isolation', async t => {
  const {b,listen}=await setup(t); const s=await listen(); await b.voiceCoord.voiceCancel(s.sessionId);
  assert.equal((await b.reconfigure({})).ok,false);
  b.sdk.deviceList=()=>[];
  const stop=b.sdk.stop.bind(b.sdk); b.sdk.stop=()=>{};
  await assert.rejects(b.reconfigure({}),/SDK 未确认退出/); assert.equal(b.voiceCoord.hasPendingClose(),true);
  b.sdk.stop=stop; assert.equal((await b.reconfigure({})).ok,true); assert.equal(b.voiceCoord.hasPendingClose(),false);
});

test('audit V-P1-3 coordinator final deadline accommodates the configured batch provider timeout', async t => {
  const {b}=await setup(t,{UMSDK_ASR_PROVIDER:'windows-speech',UMSDK_ASR_TIMEOUT_MS:'120000'});
  assert.equal(b.voiceCoord.config.asrFinalWaitMs,121000);
});

test('B01 Agent start must actually select the requested audio source', async t => {
  const { b, listen } = await setup(t); b.sdk.source = 'other-device'; await listen();
  assert.equal(b.sdk.source, 'd', 'coordinator audio source write must not be blocked by its own arbitration');
});

test('B02 bridge must forward terminal change to the UI lifecycle controller', async t => {
  const { b, listen, asrs } = await setup(t, { UMSDK_VOICE_UI: '1', UMSDK_VOICE_UI_PATH: 'D:/nonexistent-audit-ui.exe' });
  const views = []; b.voiceUi.onSessionUpdate = view => views.push(view); // no UI process
  const s = await listen(); await b.voiceCoord.voiceFinish(s.sessionId);
  b.voiceCoord.onMeetingDestroyed('d', 'device-frame'); b.voiceCoord.onAudioSegmentComplete('d', 1, 'meeting-destroyed');
  asrs[0].complete();
  assert.ok(views.some(view => view.change === 'terminal'), 'terminal event must close the floating process');
});

test('B03 reconfigure must invalidate previous hardware-info grants', async t => {
  const { b } = await setup(t);
  b.capabilities.applyDeviceCapabilities('d', 1, { mouse_control: 'supported' });
  assert.equal((await b.reconfigure({ debug: 1 })).ok, true);
  assert.equal(b.gate.check('d', 'mouse_control').allowed, false, 'fresh SDK connection has not supplied hardware-info');
});

test('B04 reconfigure must leave the voice UI reusable', async t => {
  const { b } = await setup(t, { UMSDK_VOICE_UI: '1', UMSDK_VOICE_UI_PATH: 'D:/nonexistent-audit-ui.exe' });
  await b.reconfigure({ debug: 1 });
  assert.equal(b.voiceUi.closed, false, 'disposed controller was retained across restart');
});

test('B05 an active legacy recorder must exclude new Agent voice capture', async t => {
  const { b, listen } = await setup(t); b.audioRecord('start', 'd');
  const r = await listen(); assert.equal(r.ok, false);
});

test('B06 legacy meeting ownership must exclude new PTT dictation', async t => {
  const { b } = await setup(t); b.meeting('create', 'd');
  b.sdk.emit('message', JSON.stringify({ type: 'meetingCreated' }), 'd');
  b.voiceCoord.onSpeechKey('d', 'down');
  assert.equal(b.voiceCoord.current, null);
});

test('B07 raw diagnostic mode must still honor disabled software input policy', async t => {
  const { b } = await setup(t, { UMSDK_RAW_DIAG: '1', UMSDK_INJECTION: '0', UMSDK_INJECT_KEYBOARD: '0',
    UMSDK_TEST_CAPS: '{"*":{"keyboard_control":"supported"}}' });
  let rejected = false;
  try { b.writeRaw('0a03f1000000000000000000', 'd'); } catch { rejected = true; }
  assert.equal(rejected, true, 'hardware supported must not override software disabled');
});

test('B08 legacy meeting create must honor voice unsupported capability', async t => {
  const { b } = await setup(t, { UMSDK_TEST_CAPS: '{"*":{"voice":"unsupported"}}' });
  let rejected = false; try { b.meeting('create', 'd'); } catch { rejected = true; }
  assert.equal(rejected, true);
});

test('B09 actual tools/list must hide mouse input for voice-only device', async t => {
  const { b } = await setup(t);
  const server = createMcpServer(b);
  const client = new Client({ name: 'audit-in-memory', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(names.some(n=>n.startsWith('umouse_cursor_')), false);
});

test('B10 packaged default UI path must resolve to its shipped executable', async () => {
  const { loadConfig: packagedConfig } = await import('../../release/umouse-mcp-win-x64/mcp/dist/env.js');
  const cfg = packagedConfig({ UMSDK_ASR_PROVIDER: 'disabled' });
  assert.equal(fs.existsSync(cfg.voiceUiPath), true, cfg.voiceUiPath);
});

test('B13 sinicloud provider config still allows normal MCP startup and status', async t => {
  const {b}=await setup(t,{UMSDK_ASR_PROVIDER:'sinicloud'});
  assert.equal(b.started,true); assert.equal(b.cfg.asr,null);
});

test('B14 reconfigured bridge still supports two Agent captures and terminal UI updates', async t => {
  const {b,listen,asrs}=await setup(t,{UMSDK_VOICE_UI:'1',UMSDK_VOICE_UI_PATH:'D:/nonexistent-ui.exe'});
  const states=[];b.voiceUi.onSessionUpdate=view=>states.push(view);
  for(let i=0;i<2;i++) {
    if(i) assert.equal((await b.reconfigure({debug:1})).ok,true);
    const s=await listen(); assert.equal(s.ok,true);await b.voiceCoord.voiceFinish(s.sessionId);
    b.voiceCoord.onMeetingDestroyed('d','device-frame');b.voiceCoord.onAudioSegmentComplete('d',1,'meeting-destroyed');asrs[i].complete('answer');
    assert.equal((await b.voiceCoord.voiceWait(s.sessionId,100)).text,'answer');
  }
  assert.equal(states.filter(s=>s.change==='terminal').length,2);assert.equal(b.voiceUi.closed,false);
});

test('B15 legacy close ACK must wait for its own tail barrier before new Agent admission', async t => {
  const {b,listen}=await setup(t);b.meeting('create','d');b.meeting('destroy','d');
  b.sdk.emit('message',JSON.stringify({type:'meetingDestroyed',origin:'device-frame'}),'d');
  assert.equal((await listen()).ok,false);
  b.sdk.emit('message',JSON.stringify({type:'audioSegmentComplete',segment:1,reason:'meeting-destroyed'}),'d');
  assert.equal((await listen()).ok,true);
});

test('B16 same-generation held release remains allowed after hardware capability revocation', async t => {
  const {b}=await setup(t);b.capabilities.setTestProfile('d',{mouse_control:'supported'});
  await b.inject.button('press','left','d');b.capabilities.setTestProfile('d',{});
  const r=await b.inject.releaseAll('d');assert.equal(r.failed,0);assert.equal(b.sdk.writes.at(-1)[1],0);
});

test('B17 zero frame cannot use cleanup exemption across device generations', async t => {
  const {b}=await setup(t,{UMSDK_TEST_CAPS:'{"*":{"mouse_control":"supported"}}'});
  await b.inject.button('press','left','d');b.sdk.emit('connected','d',0);
  const previous=b.sdk.writes.length;const r=await b.inject.releaseAll('d');
  assert.ok(r.failed>0);assert.equal(b.sdk.writes.length,previous);
});

test('B18 unowned zero frame cannot bypass unsupported capability', async t => {
  const {b}=await setup(t);const previous=b.sdk.writes.length;
  assert.equal(b.inject.sender.mouse(0,0,0,0,'d'),0);assert.equal(b.sdk.writes.length,previous);
});

test('B19 queue loss event prevents pending PTT delivery through real bridge routing', async t => {
  const {b,asrs}=await setup(t);const c=b.voiceCoord;let delivered=0;c.typer={available:true,id:'fake',async deliver(){delivered++;return {outcome:'submitted'};}};
  b.sdk.emit('message',JSON.stringify({type:'keyEvent',key:'speech',action:'down'}),'d');const id=c.current.sessionId;
  b.sdk.emit('message',JSON.stringify({type:'keyEvent',key:'speech',action:'up'}),'d');
  b.sdk.emit('message',JSON.stringify({type:'audioStreamIncomplete',reason:'dispatch-overflow'}),'d');asrs[0].complete('late');
  assert.equal(c.session(id).state,'failed');assert.equal(delivered,0);
});

test('B11 typer must durably record attempting before any input attempt', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umouse-ledger-audit-')); let atType;
  class FakeTyper {
    probe() { return { text_typing: 1, input_permitted: 1 }; } init() { return true; } version() { return 'fake'; }
    typeText() { const f = path.join(dir, 'deliveries.jsonl'); atType = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; return 0; }
    strerror() { return ''; } async shutdown() {}
  }
  const typer = createRealTyper({ ledgerDir: dir, bindingOverride: { Typer: FakeTyper } });
  t.after(async () => { await typer.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  await typer.deliver({ sessionId: 'one', deviceId: 'd', text: 'fake only' });
  assert.match(atType, /attempting/);
});

test('B12 same dictation session must never be typed twice', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umouse-ledger-audit-')); let calls = 0;
  class FakeTyper {
    probe() { return { text_typing: 1, input_permitted: 1 }; } init() { return true; } version() { return 'fake'; }
    typeText() { calls++; return 0; } strerror() { return ''; } async shutdown() {}
  }
  const typer = createRealTyper({ ledgerDir: dir, bindingOverride: { Typer: FakeTyper } });
  t.after(async () => { await typer.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const r = { sessionId: 'one', deviceId: 'd', text: 'fake only' }; await typer.deliver(r); await typer.deliver(r);
  assert.equal(calls, 1);
});

