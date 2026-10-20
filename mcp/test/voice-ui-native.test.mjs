// Real Win32 UI checks. No SDK, microphone, OS input, synthetic clicks or focus changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import koffi from 'koffi';
const exe=path.resolve('mcp/voice-ui/target/release/umouse-voice-ui.exe');
const enabled=process.platform==='win32'&&fs.existsSync(exe);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let user,api,enumType;
if(enabled){
 user=koffi.load('user32.dll');enumType=koffi.proto('int __stdcall VoiceUiEnum(uintptr_t hwnd, intptr_t data)');
 api={enumerate:user.func('EnumWindows','int',[koffi.pointer(enumType),'intptr_t']),owner:user.func('GetWindowThreadProcessId','uint32_t',['uintptr_t','void *']),
  className:user.func('int GetClassNameW(uintptr_t hwnd, void *name, int size)'),foreground:user.func('uintptr_t GetForegroundWindow()'),visible:user.func('int IsWindowVisible(uintptr_t hwnd)'),enabled:user.func('int IsWindowEnabled(uintptr_t hwnd)'),
  item:user.func('uintptr_t GetDlgItem(uintptr_t hwnd, int id)'),style:user.func('intptr_t GetWindowLongPtrW(uintptr_t hwnd, int index)'),
  rect:user.func('int GetWindowRect(uintptr_t hwnd, void *rect)'),monitor:user.func('uintptr_t MonitorFromWindow(uintptr_t hwnd, uint32_t flags)'),
  monitorInfo:user.func('int GetMonitorInfoW(uintptr_t monitor, void *info)'),dpi:user.func('uint32_t GetDpiForWindow(uintptr_t hwnd)')};
}
function pid(hwnd){const b=Buffer.alloc(4);api.owner(hwnd,b);return b.readUInt32LE();}
function find(child){let result=0;const cb=koffi.register(hwnd=>{if(pid(hwnd)===child.pid){const name=Buffer.alloc(512);const n=api.className(hwnd,name,256);if(name.subarray(0,n*2).toString('utf16le')==='umouse-voice-ui'){result=hwnd;return 0;}}return 1;},koffi.pointer(enumType));try{api.enumerate(cb,0);}finally{koffi.unregister(cb);}return result;}
async function until(check){for(let i=0;i<100;i++){const r=check();if(r)return r;await sleep(20);}assert.fail('UI condition timed out');}
async function fixture(t){
 const child=spawn(exe,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',stderr='';
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});
 t.after(async()=>{child.stdin.end();if(child.exitCode===null){const done=once(child,'close');const timer=setTimeout(()=>child.kill(),2500);await done;clearTimeout(timer);}assert.equal(child.exitCode,0,stderr);assert.equal(output,'','UI must not leak preview text or emit commands without a user action');});
 const hwnd=await until(()=>find(child));
 const checkFocus=()=>assert.notEqual(pid(api.foreground()),child.pid,'window must never become foreground');checkFocus();
 const update=async(mode,state='recording',preview='这是窗口显示测试，不采集音频')=>{child.stdin.write(`U\tui-test\t${state}\t${mode}\t${preview}\t1250\n`);await sleep(100);checkFocus();};
 return{child,hwnd,checkFocus,update,finish:()=>api.item(hwnd,1001),cancel:()=>api.item(hwnd,1002)};
}
test('native UI: PTT hides finish, preserves foreground, and sits at bottom right of work area',{skip:!enabled},async t=>{
 const f=await fixture(t);await f.update('ptt');await until(()=>api.enabled(f.cancel()));
 assert.equal(api.visible(f.finish()),0);assert.ok(api.visible(f.cancel()));
 const ex=Number(api.style(f.hwnd,-20))>>>0;assert.equal(ex&0x08000088,0x08000088);
 assert.equal((Number(api.style(f.hwnd,-16))>>>0)&0x00c00000,0,'no legacy title bar');
 const b=Buffer.alloc(16),info=Buffer.alloc(40);info.writeUInt32LE(40);api.rect(f.hwnd,b);api.monitorInfo(api.monitor(f.hwnd,2),info);
 const [left,top,right,bottom]=[0,4,8,12].map(i=>b.readInt32LE(i));const [wl,wt,wr,wb]=[20,24,28,32].map(i=>info.readInt32LE(i));
 assert.ok(Math.abs((wr-right)-Math.round(24*api.dpi(f.hwnd)/96))<=2,'right margin');assert.ok(left>=wl&&right<=wr&&top>=wt&&bottom<=wb);
 assert.ok(Math.abs((wb-bottom)-Math.round(24*api.dpi(f.hwnd)/96))<=2);
 for(let i=0;i<5;i++){await sleep(100);f.checkFocus();}
 t.diagnostic(JSON.stringify({pid:f.child.pid,rect:[left,top,right,bottom],work:[wl,wt,wr,wb],dpi:api.dpi(f.hwnd),foregroundPreserved:true}));
});
test('native UI: Agent finish disables while processing; PTT switching and empty preview stay responsive',{skip:!enabled},async t=>{
 const f=await fixture(t);await f.update('agent');await until(()=>api.visible(f.finish())&&api.enabled(f.finish()));
 await f.update('agent','finalizing','长段预览。'.repeat(100)+'最后一句仍需可见。');await until(()=>!api.enabled(f.finish()));assert.ok(api.enabled(f.cancel()));
 await f.update('ptt','recording','');await until(()=>!api.visible(f.finish()));assert.ok(api.enabled(f.cancel()));
});
test('native UI: oversized/invalid IPC resynchronizes and EOF exits without leaving a window',{skip:!enabled},async t=>{
 const f=await fixture(t);await f.update('ptt');f.child.stdin.write('x'.repeat(70000)+'\nU\tbad\tinvalid\tptt\ttest\t0\n');
 await f.update('agent');
 t.diagnostic(JSON.stringify({phase:'after-oversized',finishVisible:api.visible(f.finish()),finishEnabled:api.enabled(f.finish()),cancelEnabled:api.enabled(f.cancel()),exitCode:f.child.exitCode,queuedBytes:f.child.stdin.writableLength}));
 await until(()=>api.visible(f.finish())&&api.enabled(f.finish()));
});
