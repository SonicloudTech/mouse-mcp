import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiagnosticLog } from '../dist/shared/diagnostics.js';
import { execFileSync } from 'node:child_process';
test('diagnostic logs are opt-in, uniquely named and timestamped', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'umcp-timing-'));
  try {
    const disabled=new DiagnosticLog(); disabled.record('nothing'); disabled.close();
    assert.equal(fs.readdirSync(dir).length,0);
    const a=new DiagnosticLog(dir), b=new DiagnosticLog(dir);
    a.record('test', {traceId:'case-1'}); a.close(); a.close(); b.close();
    const files=fs.readdirSync(dir); assert.equal(files.length,2);
    const rows=files.flatMap(f=>fs.readFileSync(path.join(dir,f),'utf8').trim().split('\n').map(JSON.parse));
    assert.equal(rows.filter(x=>x.stage==='test').length,1);
    assert.ok(rows.every(x=>Number.isFinite(Date.parse(x.utc))&&Number.isFinite(x.monoMs)));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('native diagnostics drain before adapter unload; legacy SDK export remains optional', {skip:process.platform!=='win32'}, () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'umcp-native-timing-'));
 try {
  const bin=path.resolve('mcp/sdk-host/build/bin');
  const out=execFileSync(path.join(bin,'umcp-adapter-contract.exe'),['umouse-clean',bin,dir],{encoding:'utf8',timeout:10000,windowsHide:true,env:{...process.env,UMCP_TRACE_DIR:dir}});
  assert.match(out,/fake vendor only/);
  const files=fs.readdirSync(dir).filter(x=>x.endsWith('.jsonl'));assert.equal(files.length,1);
  const rows=fs.readFileSync(path.join(dir,files[0]),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.find(x=>x.stage==='sdk.start').usbTraceAvailable,false);
  assert.equal(rows.at(-1).stage,'trace.stop');assert.equal(rows.at(-1).dropped,0);
  assert.ok(rows.every(x=>x.qpc>0&&x.qpcFrequency>0&&x.utcMs>0));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('diagnostic failures and record limits never throw into input flow', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'umcp-timing-'));
  try {
    const log=new DiagnosticLog(dir); log.record('oversize',{value:'a'.repeat(17000)}); log.record('after'); log.close();
    const rows=fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0]),'utf8'); assert.match(rows,/trace.limit/);assert.doesNotMatch(rows,/oversize|after/);
    const circular={}; circular.self=circular;
    const other=new DiagnosticLog(dir);assert.doesNotThrow(()=>other.record('cycle',circular));assert.equal(other.failed,true);
    assert.throws(()=>new DiagnosticLog('relative'),/local_diagnostics/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('native log cap retains final loss count after writer drain', {skip:process.platform!=='win32'}, () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'umcp-timing-cap-'));
 try {
  execFileSync(path.resolve('mcp/sdk-host/build/bin/umcp-diagnostics-contract.exe'),[],{timeout:20000,windowsHide:true,env:{...process.env,UMCP_TRACE_DIR:dir}});
  const file=path.join(dir,fs.readdirSync(dir)[0]);assert.ok(fs.statSync(file).size<=32*1024*1024+1024);
  const final=JSON.parse(fs.readFileSync(file,'utf8').trim().split('\n').at(-1));
  assert.equal(final.stage,'trace.stop');assert.ok(final.dropped>0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
