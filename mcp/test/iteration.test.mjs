import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../dist/env.js';
import {registerTools,registerGatedTools} from '../dist/tools.js';
import {InjectController} from '../dist/inject.js';
import {DeviceCapabilityRegistry} from '../dist/device-capabilities.js';
test('iteration config: keyboard gate and feedback bounds',()=>{
  const defaults=loadConfig({});
  assert.equal(defaults.keyboardInjection,false);
  assert.equal(defaults.injectFeedbackMs,5000);
  assert.equal(loadConfig({UMSDK_INJECT_KEYBOARD:'1'}).keyboardInjection,true);
  for(const [value,expected] of [['2',1000],['3000',3000],['60001',60000],['invalid',5000]]) {
    assert.equal(loadConfig({UMSDK_INJECT_FEEDBACK_MS:value}).injectFeedbackMs,expected);
  }
});
test('iteration tools: keyboard hidden by default, explicit opt-in works',()=>{
  for(const enabled of [false,true]) {
    const names=[];
    registerTools({tool:(name)=>names.push(name)},{injectionEnabled:true,keyboardInjectionEnabled:enabled});
    assert.equal(names.length,22,'静态工具面（查询/会议/语音/capabilities）');
    assert.equal(names.includes('umouse_key_tap'),false,'注入工具移入门控组');
    // v2：注入工具经能力门控组注册——keyboard_control 声明 + 软件开关共同决定
    const registry=new DeviceCapabilityRegistry();
    registry.setTestProfile('dev',{mouse_control:'supported',keyboard_control:enabled?'supported':'unknown'});
    const gated=[];
    const server={tool:(n)=>{gated.push(n);return{remove:()=>{}}},sendToolListChanged:()=>{}};
    registerGatedTools(server,{safeDeviceList:()=>[{id:'dev',mode:'USB'}],capabilities:registry,
      injectionEnabled:true,keyboardInjectionEnabled:enabled,rawDiagEnabled:false});
    assert.equal(gated.includes('umouse_key_tap'),enabled);
    assert.equal(gated.includes('umouse_cursor_move'),true,'mouse_control 声明后鼠标工具可见');
    assert.equal(gated.includes('umouse_write_raw'),false,'raw 诊断默认隐藏');
  }
});
test('iteration controller: disabled keyboard sends no key or reset frame',async()=>{
  const frames=[];
  const c=new InjectController({mouse:(...a)=>{frames.push(['mouse',...a]);return 1;},
    keyboard:(...a)=>{frames.push(['keyboard',...a]);return 1;}},
    {frameMs:1,clickMs:1,keyboardEnabled:false});
  try {
    await assert.rejects(c.keyTap(['ctrl'],[4]),/禁用/);
    assert.equal(frames.length,0);
    // v2 受限清理：未持有任何通道时不发零帧（不再向设备塞复位帧）
    assert.deepEqual(await c.releaseAll(),{frames:0,sent:0,failed:0,note:'no-held-channels'});
    assert.equal(frames.length,0);
    assert.equal(c.state().heldButtons,0);
  } finally {c.dispose();}
});
