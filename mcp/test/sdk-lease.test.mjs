import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SdkLease } from '../dist/sdk-lease.js';
import { loadConfig } from '../dist/env.js';

const pipe=()=> '\\\\.\\pipe\\umouse-test-' + randomUUID();

test('runtime lease error fences ownership once and refuses rebind before explicit release', {skip:process.platform!=='win32'}, async()=>{
  let losses=0;const a=new SdkLease(pipe(),()=>losses++);
  try { assert.equal(await a.tryAcquire(),true);a.server.emit('error',new Error('simulated runtime failure'));
    a.server.emit('error',new Error('duplicate'));assert.equal(losses,1);assert.equal(a.status().state,'error');
    assert.equal(await a.tryAcquire(),false);
    await a.release();assert.equal(await a.tryAcquire(),true);
  }finally{await a.release();}
});
test('force takeover is disabled unless explicitly selected',()=>{
  assert.equal(loadConfig({}).takeover,false);
  assert.equal(loadConfig({UMSDK_TAKEOVER:'1'}).takeover,true);
});

test('Windows SDK lease has one owner and safely transfers after release', {skip:process.platform!=='win32'},async()=>{
  const name=pipe(),a=new SdkLease(name),b=new SdkLease(name);
  try {
    assert.deepEqual(await Promise.all([a.tryAcquire(),a.tryAcquire()]),[true,true]);
    assert.equal(await b.tryAcquire(),false); assert.equal(b.status().state,'busy');
    assert.equal(a.status().state,'owned');
    await b.release(); // a loser releasing must not release another process's pipe
    assert.equal(await b.tryAcquire(),false);
    await a.release(); assert.equal(await b.tryAcquire(),true);
    assert.equal(await a.tryAcquire(),false);
  } finally {await a.release();await b.release();}
});

test('Windows kernel releases lease when its isolated test process exits', {skip:process.platform!=='win32'},async()=>{
  const name=pipe(),moduleUrl=new URL('../dist/sdk-lease.js',import.meta.url).href;
  const script=`import {SdkLease} from ${JSON.stringify(moduleUrl)}; const l=new SdkLease(process.argv[1]); const ok=await l.tryAcquire(); process.send({ok}); setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,name],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  const lease=new SdkLease(name);
  try {
    const [message]=await once(child,'message',{signal:AbortSignal.timeout(5000)});
    assert.equal(message.ok,true); assert.equal(await lease.tryAcquire(),false);
    const exited=once(child,'exit'); child.kill(); await exited;
    assert.equal(await lease.tryAcquire(),true);
  } finally {if(child.exitCode===null && child.signalCode===null)child.kill();await lease.release();}
});
