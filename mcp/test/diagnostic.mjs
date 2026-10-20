import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const entry = resolve(process.env.UMOUSE_MCP_ENTRY || 'mcp/dist/index.js');
const child = spawn(process.execPath, [entry], { cwd: process.env.TEMP || process.cwd(), env: { ...process.env, UMSDK_SPEECH_AUTO: '0', UMSDK_DATA_DIR: resolve('tmp/diagnostic-runtime') }, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '', id = 0;
const pending = new Map();
const exit = new Promise(r => child.on('exit', (code, signal) => r({code, signal})));
child.stderr.on('data', b => { stderr += b; });
child.stdout.setEncoding('utf8');
child.stdout.on('data', b => {
  stdout += b;
  let pos;
  while ((pos = stdout.indexOf('\n')) >= 0) {
    const line = stdout.slice(0, pos); stdout = stdout.slice(pos + 1);
    try { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); }
    catch { console.error('NON_JSON', line); process.exitCode = 1; }
  }
});
const rpc = (method, params = {}) => new Promise((res, rej) => {
  const key = ++id;
  const timer = setTimeout(() => { pending.delete(key); rej(new Error(`timeout: ${method}`)); }, 12000);
  pending.set(key, msg => { clearTimeout(timer); pending.delete(key); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); });
  child.stdin.write(JSON.stringify({jsonrpc:'2.0', id:key, method, params}) + '\n');
});
try {
  console.log('ENTRY', entry);
  console.log('INIT', JSON.stringify(await rpc('initialize', {protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'audit', version:'1'}})));
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list = await rpc('tools/list'); console.log('TOOLS', list.tools.length);
  assert.equal(list.tools.length, process.env.UMSDK_INJECTION==='0' ? 14 : process.platform==='win32' ? 23 : 21);
  for (const name of ['umouse_status','umouse_list_devices']) {
    const result=await rpc('tools/call', {name, arguments:{}});
    console.log(name,JSON.stringify(result));
    if(name==='umouse_status') assert.equal(JSON.parse(result.content[0].text).sdkStarted,process.env.AUDIT_EXPECT_SDK_FAILURE!=='1');
  }
  if(process.argv.includes('--restart')) {
    for(let i=0;i<12;i++) {
      const r=await rpc('tools/call',{name:'umouse_reconfigure',arguments:{device_limit:4,usb:null,ble:null}});
      assert.equal(JSON.parse(r.content[0].text).ok,true);
    }
    const r=await Promise.all([1,2].map(()=>rpc('tools/call',{name:'umouse_reconfigure',arguments:{}})));
    assert.ok(r.every(x=>!x.isError)); console.log('RESTART 12 sequential + 2 concurrent PASS');
  }
  child.stdin.end();
  let timer;
  const result = await Promise.race([exit, new Promise(r => { timer = setTimeout(() => r({timeout:true}), 5000); })]);
  clearTimeout(timer);
  console.log('EOF_EXIT', JSON.stringify(result));
  if(!result.timeout) assert.match(stderr,/SDK 退出序列完成/);
  if (result.timeout || result.code !== 0) { process.exitCode = 1; child.kill(); }
} catch(e) { console.error(e); process.exitCode=1; child.kill(); }
finally { console.error('STDERR', stderr); }
