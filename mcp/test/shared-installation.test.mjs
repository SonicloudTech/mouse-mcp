import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NativeClient } from '../dist/shared/native-client.js';
import { SharedDaemon } from '../dist/shared/daemon.js';
import { loadConfig } from '../dist/env.js';
import { identity } from '../dist/shared/daemon-main.js';
import { serviceEntry } from '../dist/shared/connector.js';
import { inside, verifyBundle, createInstallation, pairClient, revokeClient, upgradeInstallation, rollbackInstallation,
  setCapabilities, recoverInstallation, adminCall, stopForMaintenance, startService, withInstallLock, writeJson } from '../dist/shared/installation.js';

const run = promisify(execFile), bin = path.resolve('mcp/sdk-host/build/bin'), executable = path.join(bin,'umouse-sdk-host.exe');
const sha = b => createHash('sha256').update(b).digest('hex');
const json = p => JSON.parse(fs.readFileSync(p,'utf8'));
const pause = ms => new Promise(r=>setTimeout(r,ms));

// Installation deliberately shares safety evidence across installs for one
// Windows user. Offline tests must use a separate profile from that real user,
// including child CLIs; a live hardware quarantine must never affect fixtures.
const realProfile=process.env.USERPROFILE;
let isolatedProfile;
test.before(()=>{
  if(process.platform!=='win32')return;
  isolatedProfile=fs.mkdtempSync(path.join(os.tmpdir(),'umcp-install-profile-'));
  process.env.USERPROFILE=isolatedProfile;
  assert.equal(os.homedir(),isolatedProfile);
});
test.after(async()=>{
  if(!isolatedProfile)return;
  if(realProfile===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=realProfile;
  await fs.promises.rm(isolatedProfile,{recursive:true,force:true,maxRetries:20,retryDelay:50});
});

test('audit atomic JSON write removes failed temporary file and preserves destination',t=>{
  const dir=temporary(t),target=path.join(dir,'target');fs.mkdirSync(target);
  assert.throws(()=>writeJson(target,{secret:'test-only'}));assert.deepEqual(fs.readdirSync(dir),['target']);
});
const options = { windowsHide:true, timeout:10000 };
const cleanups=new WeakMap();
const cleanup=(t,fn)=>cleanups.get(t).push(fn);
function temporary(t, base = os.tmpdir()) {
  const dir=fs.mkdtempSync(path.join(base,'umcp-install-test-'));
  cleanups.set(t,[]);
  // Windows may release a terminated child's current-directory handle just after exit becomes observable.
  t.after(async()=>{
    let error;for(const fn of cleanups.get(t).reverse()){try{await fn();}catch(e){error??=e;}}
    await fs.promises.rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50});if(error)throw error;
  }); return dir;
}
function bundle(dir) {
  const root=path.join(dir,randomUUID());fs.mkdirSync(root);
  const files=['host.exe','mcp/dist/shared/daemon-main.js','mcp/dist/shared/connector.js','mcp/dist/shared/manage.js','mcp/scripts/start-shared.ps1',
    ...['umouse','asr','typer','screen'].map(x=>`${x}.dll`),'vendor.dll'];
  for(const file of files) { const p=path.join(root,file);fs.mkdirSync(path.dirname(p),{recursive:true});
    if(file==='host.exe')fs.copyFileSync(executable,p);else fs.writeFileSync(p,`offline fixture ${file}`); }
  const index={schemaVersion:1,profile:'shared-v2',hardwareApiVersion:1,executable:'host.exe',
    plugins:['umouse','asr','typer','screen'].map(id=>({id,adapter:`${id}.dll`,library:id==='umouse'?'vendor.dll':null,required:id==='umouse'})),
    files:files.map(file=>({path:file,sha256:sha(fs.readFileSync(path.join(root,file)))}))};
  writeJson(path.join(root,'bundle-index.json'),index); return verifyBundle(root);
}
const win = (name, f) => test(name,{skip:process.platform!=='win32',timeout:20000},f);
win('audit manifest history quota preserves current and rollback records',t=>{
  const dir=temporary(t),b=bundle(dir),state=path.join(dir,'private');createInstallation(state,b,'agent');
  const file=path.join(state,'service.json'),original=fs.readFileSync(file,'utf8'),versions=path.join(state,'versions');
  for(let i=1;i<128;i++)fs.writeFileSync(path.join(versions,`retained-${i}.json`),'{}');
  assert.throws(()=>upgradeInstallation(state,b),/manifest_history_limit/);
  assert.throws(()=>setCapabilities(state,{d:{mouse_control:'unsupported'}}),/manifest_history_limit/);
  assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(fs.readdirSync(versions).length,128);
});
win('installation: four plugin slots, exact hashes, Windows path aliases and traversal are rejected',t=>{
  const dir=temporary(t),b=bundle(dir),file=path.join(b.root,'bundle-index.json'),index=json(file);
  assert.equal(b.plugins.length,4);assert.equal(b.plugins.find(p=>p.id==='screen').required,false);
  for(const invalid of ['../escape','C:/escape','umouse.dll:stream','CON.txt','x.','a\\b'])assert.throws(()=>inside(b.root,invalid),/bundle_path/);
  writeJson(file,{...index,files:[...index.files,{...index.files[0],path:'HOST.exe'}]});assert.throws(()=>verifyBundle(b.root),/bundle_entry_invalid/);
  writeJson(file,{...index,plugins:index.plugins.slice(0,3)});assert.throws(()=>verifyBundle(b.root),/four_plugin_slots/);
  writeJson(file,index);fs.appendFileSync(path.join(b.root,'umouse.dll'),'changed');assert.throws(()=>verifyBundle(b.root),/bundle_hash_mismatch/);
});
win('installation: private setup, permission-preserving rotation, revocation, exact capabilities and atomic upgrade/rollback',async t=>{
  const dir=temporary(t),a=bundle(dir),b=bundle(dir),state=path.join(dir,'private');
  createInstallation(state,a,'agent');const file=path.join(state,'service.json');let cfg=json(file);
  const secondState=path.join(dir,'another-install');createInstallation(secondState,b,'agent');
  assert.equal(json(json(path.join(secondState,'service.json')).manifest).plugins[0].config.runtimeStateDir,json(cfg.manifest).plugins[0].config.runtimeStateDir);
  assert.equal(json(path.join(secondState,'service.json')).environment.UMSDK_SHARED_SAFETY_DIR,cfg.environment.UMSDK_SHARED_SAFETY_DIR);
  assert.equal(cfg.principals.length,2);assert.deepEqual(json(cfg.manifest).plugins[0].config.deviceCapabilities,{});
  assert.equal(json(cfg.manifest).plugins[0].config.allowHardwareInput,false);
  const {stdout:acl}=await run('icacls.exe',[state],options);assert.ok(acl.includes('(OI)(CI)(F)'));assert.ok(!acl.includes('(I)'));
  assert.throws(()=>pairClient(state,'AGENT'),/already_paired/);
  const credential=pairClient(state,'read_only',['device.read']),old=json(credential).token;
  pairClient(state,'read_only',undefined,true);cfg=json(file);assert.notEqual(json(credential).token,old);
  assert.deepEqual(cfg.principals.find(p=>p.id==='read_only').permissions,['device.read']);
  revokeClient(state,'read_only');assert.ok(!json(file).principals.some(p=>p.id==='read_only'));assert.ok(!fs.existsSync(credential));
  assert.throws(()=>pairClient(state,'../escape'),/client_id/);assert.throws(()=>pairClient(state,'con'),/client_id/);
  for(const profile of [{'*':{mouse_control:'supported'}},{d:{new_flag:'supported'}},{d:{mouse_control:true}}])assert.throws(()=>setCapabilities(state,profile),/capability_profile/);
  setCapabilities(state,{keyboard:{keyboard_control:'supported'}});
  assert.equal(json(json(file).manifest).plugins[0].config.allowHardwareInput,true,'keyboard-only native gate opens');
  upgradeInstallation(state,b);
  assert.equal(json(json(file).manifest).plugins[0].config.allowHardwareInput,true,'upgrade preserves keyboard-only native gate');
  rollbackInstallation(state);
  const caps={device:{mouse_control:'supported',keyboard_control:'unsupported'}};setCapabilities(state,caps);
  const original=json(file),principal=original.principals;
  upgradeInstallation(state,b);cfg=json(file);assert.equal(cfg.bundleRoot,b.root);assert.deepEqual(cfg.principals,principal);
  assert.deepEqual(json(cfg.manifest).plugins[0].config.deviceCapabilities,caps);assert.equal(serviceEntry(cfg),path.join(b.root,'mcp/dist/shared/daemon-main.js'));
  assert.ok(fs.existsSync(original.manifest));rollbackInstallation(state);cfg=json(file);assert.equal(cfg.bundleRoot,a.root);assert.equal(cfg.manifest,original.manifest);
  assert.throws(()=>recoverInstallation(state,false),/explicit_hardware_reset/);
  assert.ok(!fs.existsSync(path.join(state,'data/native-state/sdk-running.json')),'setup does not initialize SDK');
});
win('hardware-only upgrade: migrate legacy input grants without elevating read-only clients or changing credentials',t=>{
  const dir=temporary(t),old=bundle(dir),next=bundle(dir),state=path.join(dir,'private');
  createInstallation(state,old,'agent');pairClient(state,'read_only',['device.read']);
  pairClient(state,'incomplete',['device.read']);
  const file=path.join(state,'service.json'),cfg=json(file);
  cfg.principals.find(p=>p.id==='agent').permissions=['device.read','voice','cua.read','cua.input'];
  cfg.principals.find(p=>p.id==='read_only').permissions=['device.read','cua.read'];
  cfg.principals.find(p=>p.id==='incomplete').permissions=['device.read','cua.input'];
  Object.assign(cfg.environment,{UMSDK_CUA_ENABLED:'1',UMSDK_CUA_WORKER:'old-worker.exe',UMSDK_CUA_TRACE_FRAMES:'1',UMSDK_INJECT_KEYBOARD:'1'});
  writeJson(file,cfg);
  const token=json(path.join(state,'clients/agent.json')).token;
  upgradeInstallation(state,next);const updated=json(file);
  assert.deepEqual(updated.principals.find(p=>p.id==='agent').permissions,['device.read','voice','input.control']);
  for(const id of ['read_only','incomplete'])assert.deepEqual(updated.principals.find(p=>p.id===id).permissions,['device.read']);
  assert.equal(updated.environment.UMSDK_INJECT_KEYBOARD,'1');
  assert.equal(Object.keys(updated.environment).some(k=>k.startsWith('UMSDK_CUA_')),false);
  assert.equal(json(path.join(state,'clients/agent.json')).token,token);
  assert.equal(json(updated.manifest).plugins[0].config.runtimeStateDir,json(cfg.manifest).plugins[0].config.runtimeStateDir);
  const badIndex=path.join(next.root,'bundle-index.json');writeJson(badIndex,{...json(badIndex),hardwareApiVersion:undefined});
  assert.throws(()=>verifyBundle(next.root),/bundle_index_invalid/);
});

win('admin: hardware input grant can be reloaded and exposes no removed automation tools',async t=>{
  const f=await adminFixture(t),file=path.join(f.dir,'service.json');
  f.daemon.options.configFile=file;
  const principals=f.daemon.options.principals.map(p=>p.id==='agent'?{...p,permissions:['device.read','input.control']}:p);
  writeJson(file,{...json(file),principals});
  assert.equal((await adminCall(f.dir,'reload-clients')).clientsReloaded,true);
  const transport=new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${f.clientToken}`}}});
  const client=new Client({name:'hardware-grant-fixture',version:'1'});await client.connect(transport);cleanup(t,()=>client.close());
  const names=(await client.listTools()).tools.map(t=>t.name);
  assert.ok(names.includes('umouse_mouse_action'));assert.ok(names.includes('umouse_input_sequence'));
  assert.equal(names.some(n=>n.includes('cua')),false);
});
win('installation: upgrade and rollback cannot bypass native input quarantine with an older bundle',t=>{
  const dir=temporary(t),old=bundle(dir),root=bundle(dir).root,indexFile=path.join(root,'bundle-index.json');
  writeJson(indexFile,{...json(indexFile),nativeInputQuarantineVersion:1});const compatible=verifyBundle(root);
  const state=path.join(dir,'private');createInstallation(state,old,'agent');const configFile=path.join(state,'service.json');
  const config=json(configFile),manifest=json(config.manifest),native=path.join(dir,'isolated-native-state');fs.mkdirSync(native);
  manifest.plugins[0].config.runtimeStateDir=native;writeJson(config.manifest,manifest);
  upgradeInstallation(state,compatible);const before=fs.readFileSync(configFile,'utf8');
  const marker=path.join(native,'native-input-quarantine.json');fs.writeFileSync(marker,'retained evidence');
  assert.throws(()=>rollbackInstallation(state),/input_quarantine_requires_compatible_bundle/);
  assert.throws(()=>upgradeInstallation(state,old),/input_quarantine_requires_compatible_bundle/);
  assert.equal(fs.readFileSync(configFile,'utf8'),before);assert.equal(fs.readFileSync(marker,'utf8'),'retained evidence');
  upgradeInstallation(state,compatible);assert.equal(fs.readFileSync(marker,'utf8'),'retained evidence');
});

win('installation: exclusive maintenance lock rejects concurrent mutations and releases after failure',async t=>{
  const dir=temporary(t);await withInstallLock(dir,async()=>{
    await assert.rejects(withInstallLock(dir,async()=>assert.fail('must not enter')));
  });await assert.rejects(withInstallLock(dir,async()=>{throw new Error('injected');}),/injected/);
  assert.equal(await withInstallLock(dir,async()=>7),7);
});
win('installation: creating another installation cannot bypass native quarantine with an old bundle',t=>{
  const dir=temporary(t),old=bundle(dir),profile=path.join(dir,'test-profile');fs.mkdirSync(profile);
  const native=path.join(profile,'.umouse-mcp-shared-safety-v2','native-state');fs.mkdirSync(native,{recursive:true});
  const marker=path.join(native,'native-input-quarantine.json');fs.writeFileSync(marker,'retained evidence');
  const previous=process.env.USERPROFILE;process.env.USERPROFILE=profile;
  try {
    assert.equal(os.homedir(),profile,'fake Windows home remains isolated from production state');
    const rejected=path.join(dir,'old-install');
    assert.throws(()=>createInstallation(rejected,old,'agent'),/input_quarantine_requires_compatible_bundle/);
    assert.equal(fs.existsSync(rejected),false);
    createInstallation(path.join(dir,'compatible-install'),{...old,nativeInputQuarantineVersion:1},'agent');
    assert.equal(fs.readFileSync(marker,'utf8'),'retained evidence');
  } finally {if(previous===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=previous;}
});
win('installation CLI: invalid input does not stop service; failed transaction leaves a durable maintenance marker',async t=>{
  const dir=temporary(t),b=bundle(dir),state=path.join(dir,'private');createInstallation(state,b,'agent');
  // Never probe the production default port while its real listener is running.
  // Select an unused ephemeral loopback endpoint for this no-listener fixture.
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const serviceFile=path.join(state,'service.json');writeJson(serviceFile,{...json(serviceFile),port});
  const cli=path.resolve('mcp/dist/shared/manage.js'),marker=path.join(state,'maintenance.json');
  await assert.rejects(run(process.execPath,[cli,'recover',state],options),/explicit_hardware_reset/);assert.ok(!fs.existsSync(marker));
  const profile=path.join(dir,'bad-profile.json');writeJson(profile,{'*':{mouse_control:'supported'}});
  await assert.rejects(run(process.execPath,[cli,'capabilities',state,profile],options),/capability_profile/);assert.ok(!fs.existsSync(marker));
  // No listener: exercise mutation failure after admission has been closed.
  await assert.rejects(run(process.execPath,[cli,'rollback',state],options),/rollback_unavailable/);assert.ok(fs.existsSync(marker));
  const {stdout}=await run(process.execPath,[cli,'resume',state],options);assert.equal(JSON.parse(stdout).hardwareRecoveryPerformed,false);assert.ok(!fs.existsSync(marker));
  const output=JSON.parse((await run(process.execPath,[cli,'config',state,'agent'],options)).stdout);
  assert.equal(output.configApplied,false);assert.ok(!JSON.stringify(output).includes(json(path.join(state,'clients/agent.json')).token));
  const retained=path.join(state,'voice-evidence.txt');fs.writeFileSync(retained,'retain');
  const removed=JSON.parse((await run(process.execPath,[cli,'uninstall',state],options)).stdout);
  assert.equal(removed.hostConfigurationsModified,false);assert.equal(json(marker).command,'uninstalled');assert.equal(fs.readFileSync(retained,'utf8'),'retain');
  assert.ok(json(path.join(state,'service.json')).principals.every(p=>p.permissions.includes('admin')));
});

async function adminFixture(t) {
  const dir=temporary(t),token='a'.repeat(64),clientToken='b'.repeat(64),who=identity(executable),manifest=path.join(dir,'fake.json');
  writeJson(manifest,{schemaVersion:1,profile:'test',root:bin,testNamespace:randomUUID(),plugins:[{id:'fake',path:path.join(bin,'umcp_fake.dll'),sha256:sha(fs.readFileSync(path.join(bin,'umcp_fake.dll'))),required:true,config:{}}]});
  const daemon=new SharedDaemon({port:0,pipe:`\\\\.\\pipe\\umouse-mcp-test-${randomUUID()}`,testing:true,native:{executable,manifest,testing:true,shutdownMs:500},bridge:loadConfig({UMSDK_DATA_DIR:dir}),
    principals:[{id:'admin',tokenSha256:sha(token),permissions:['admin']},{id:'agent',tokenSha256:sha(clientToken),permissions:['device.read']}]});
  await daemon.listen();cleanup(t,()=>daemon.close());
  writeJson(path.join(dir,'service.json'),{...who,executable,port:daemon.address.port});writeJson(path.join(dir,'admin.json'),{token});
  return{dir,daemon,clientToken,url:`http://127.0.0.1:${daemon.address.port}`,token};
}
win('admin: live client revocation closes only that principal and preserves other owner and worker',async t=>{
  const f=await adminFixture(t),file=path.join(f.dir,'service.json'),otherToken='c'.repeat(64);
  f.daemon.options.configFile=file;f.daemon.options.principals.push({id:'other',tokenSha256:sha(otherToken),permissions:['device.read']});
  const connect=async token=>{const transport=new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
    const client=new Client({name:'revocation-test',version:'1'});await client.connect(transport);cleanup(t,()=>client.close());return client;};
  await connect(f.clientToken);const other=await connect(otherToken);await f.daemon.supervisor.settled();const pid=f.daemon.supervisor.status.pid;
  writeJson(file,{...json(file),principals:f.daemon.options.principals.filter(p=>p.id!=='agent')});
  const changed=await adminCall(f.dir,'reload-clients');assert.equal(changed.closedConnections,1);assert.equal(f.daemon.registry.count,1);
  assert.equal(JSON.parse((await other.callTool({name:'umouse_status',arguments:{}})).content[0].text).pid,pid);
  const denied=await fetch(`${f.url}/mcp`,{headers:{Authorization:`Bearer ${f.clientToken}`}});assert.equal(denied.status,401);
  assert.equal((await adminCall(f.dir,'reload-clients')).closedConnections,0);
});
win('admin: verified TCP owner, no SDK from status, no implicit disconnect, quiesce confirms exit',async t=>{
  const f=await adminFixture(t);assert.equal((await adminCall(f.dir,'status')).state,'stopped');assert.equal(f.daemon.registry.count,0);
  const file=path.join(f.dir,'service.json'),cfg=json(file);writeJson(file,{...cfg,windowsSessionId:cfg.windowsSessionId+1});
  await assert.rejects(adminCall(f.dir,'status'),/admin_peer_identity_mismatch/);writeJson(file,cfg);
  const transport=new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${f.clientToken}`}}});
  const client=new Client({name:'offline-admin-test',version:'1'});await client.connect(transport);cleanup(t,()=>client.close());
  await f.daemon.supervisor.settled();assert.equal(f.daemon.registry.count,1);
  const pid=f.daemon.supervisor.status.pid;assert.ok(pid);
  await assert.rejects(stopForMaintenance(f.dir,false),/admin_rejected:409/);assert.equal(f.daemon.registry.count,1);
  for(const body of [null,[],{operation:'quiesce',closeConnections:'true'}]){
    const r=await fetch(`${f.url}/admin`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`},body:JSON.stringify(body)});assert.equal(r.status,400);
  }
  await stopForMaintenance(f.dir,true);assert.equal(f.daemon.registry.count,0);assert.throws(()=>process.kill(pid,0));
});
win('admin: administrative secret cannot establish a counted MCP session',async t=>{
  const f=await adminFixture(t);const r=await fetch(`${f.url}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json','Accept':'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fixture',version:'1'}}})});
  assert.equal(r.status,503);assert.equal(f.daemon.registry.count,0);assert.equal(f.daemon.supervisor.state,'stopped');
});
win('recovery: compare both evidence hashes before archiving; busy native owner refuses recovery',async t=>{
  const dir=temporary(t),state=path.join(dir,'state');fs.mkdirSync(state);const sdk=path.join(state,'sdk-running.json'),input=path.join(dir,'input.json'),manifest=path.join(dir,'fake.json');
  fs.writeFileSync(sdk,'sdk evidence');fs.writeFileSync(input,'input evidence');
  writeJson(manifest,{schemaVersion:1,profile:'test',root:bin,testNamespace:randomUUID(),plugins:[{id:'fake',path:path.join(bin,'umcp_fake.dll'),sha256:sha(fs.readFileSync(path.join(bin,'umcp_fake.dll'))),required:true,config:{runtimeStateDir:state}}]});
  const args=['--recover-state',manifest,sha(fs.readFileSync(sdk)),input,sha(fs.readFileSync(input)),'--hardware-reset-confirmed'];
  const wrong=[...args];wrong[4]='0'.repeat(64);await assert.rejects(run(executable,wrong,options),/recovery_evidence_changed/);assert.ok(fs.existsSync(sdk)&&fs.existsSync(input));
  const owner=new NativeClient({executable,manifest,testing:true});await owner.start();
  try{await assert.rejects(run(executable,args,options),/owner_busy/);}finally{await owner.stop();}
  assert.ok(fs.existsSync(sdk));const result=JSON.parse((await run(executable,args,options)).stdout);
  assert.equal(result.sdkLoaded,false);assert.equal(result.physicalVerifiedBySoftware,false);assert.equal(result.archived.length,2);
  assert.ok(!fs.existsSync(sdk)&&!fs.existsSync(input));assert.equal(fs.readFileSync(result.archived[0],'utf8'),'sdk evidence');
});

win('recovery: native input quarantine requires its own unchanged hash; legacy recovery cannot discard it',async t=>{
  const dir=temporary(t),state=path.join(dir,'native');fs.mkdirSync(state);
  const sdk=path.join(state,'sdk-running.json'),input=path.join(dir,'input.json'),native=path.join(state,'native-input-quarantine.json'),manifest=path.join(dir,'fake.json');
  fs.writeFileSync(sdk,'sdk evidence');fs.writeFileSync(input,'shared input evidence');fs.writeFileSync(native,'native mouse evidence');
  writeJson(manifest,{schemaVersion:1,profile:'test',root:bin,testNamespace:randomUUID(),plugins:[{id:'fake',path:path.join(bin,'umcp_fake.dll'),sha256:sha(fs.readFileSync(path.join(bin,'umcp_fake.dll'))),required:true,config:{runtimeStateDir:state}}]});
  const base=['--recover-state',manifest,sha(fs.readFileSync(sdk)),input,sha(fs.readFileSync(input))];
  await assert.rejects(run(executable,[...base,'--hardware-reset-confirmed'],options),/native_input_recovery_evidence_required/);
  await assert.rejects(run(executable,[...base,'0'.repeat(64),'--hardware-reset-confirmed'],options),/recovery_evidence_changed/);
  for(const f of [sdk,input,native])assert.ok(fs.existsSync(f),'mismatched recovery preserves every marker');
  const result=JSON.parse((await run(executable,[...base,sha(fs.readFileSync(native)),'--hardware-reset-confirmed'],options)).stdout);
  assert.equal(result.sdkLoaded,false);assert.equal(result.archived.length,3);
  for(const f of [sdk,input,native])assert.ok(!fs.existsSync(f));
  assert.ok(result.archived.some(f=>fs.readFileSync(f,'utf8')==='native mouse evidence'));
});

win('recovery: in-flight evidence is required, rechecked and archived with all other markers',async t=>{
  const dir=temporary(t),state=path.join(dir,'native'),input=path.join(dir,'input-uncertain.json'),manifest=path.join(dir,'manifest.json');
  fs.mkdirSync(state);
  const sdk=path.join(state,'sdk-running.json'),native=path.join(state,'native-input-quarantine.json'),inflight=path.join(state,'input-in-flight.json');
  const markers=[sdk,input,native,inflight];
  for(const file of markers)fs.writeFileSync(file,`evidence:${path.basename(file)}`);
  writeJson(manifest,{schemaVersion:1,profile:'test',root:bin,testNamespace:randomUUID(),plugins:[{id:'fake',config:{runtimeStateDir:state}}]});
  const base=['--recover-state',manifest,sha(fs.readFileSync(sdk)),input,sha(fs.readFileSync(input)),sha(fs.readFileSync(native))];
  await assert.rejects(run(executable,[...base,'--hardware-reset-confirmed'],options),/input_inflight_recovery_evidence_required/);
  for(const expected of ['none','0'.repeat(64)]) {
    await assert.rejects(run(executable,[...base,expected,'--hardware-reset-confirmed'],options),/recovery_evidence_changed/);
    for(const file of markers)assert.ok(fs.existsSync(file),'validate all hashes before archiving any evidence');
  }
  const result=JSON.parse((await run(executable,[...base,sha(fs.readFileSync(inflight)),'--hardware-reset-confirmed'],options)).stdout);
  assert.equal(result.sdkLoaded,false);assert.equal(result.physicalVerifiedBySoftware,false);assert.equal(result.archived.length,4);
  for(const file of markers)assert.ok(!fs.existsSync(file));
  assert.ok(result.archived.some(file=>fs.readFileSync(file,'utf8')==='evidence:input-in-flight.json'));
});
win('recovery: management includes in-flight hash without loading SDK or discarding other evidence',t=>{
  const dir=temporary(t),state=path.join(dir,'native'),shared=path.join(dir,'shared-v2'),manifest=path.join(dir,'manifest.json');
  fs.mkdirSync(state);fs.mkdirSync(shared);
  const sdk=path.join(state,'sdk-running.json'),input=path.join(shared,'input-uncertain.json'),inflight=path.join(state,'input-in-flight.json');
  for(const file of [sdk,input,inflight])fs.writeFileSync(file,`evidence:${path.basename(file)}`);
  writeJson(manifest,{schemaVersion:1,profile:'test',root:bin,testNamespace:randomUUID(),plugins:[{id:'umouse',config:{runtimeStateDir:state}}]});
  writeJson(path.join(dir,'service.json'),{executable,manifest,environment:{UMSDK_SHARED_SAFETY_DIR:dir}});
  assert.throws(()=>recoverInstallation(dir,false),/explicit_hardware_reset/);
  for(const file of [sdk,input,inflight])assert.ok(fs.existsSync(file));
  const result=recoverInstallation(dir,true);
  assert.equal(result.sdkLoaded,false);assert.equal(result.archived.length,3);
  for(const file of [sdk,input,inflight])assert.ok(!fs.existsSync(file));
  assert.ok(result.archived.some(file=>fs.readFileSync(file,'utf8')==='evidence:input-in-flight.json'));
});

for(const kill of ['service','launcher']) win(`service Job: killing ${kill} removes all auxiliary descendants`,async t=>{
  const dir=temporary(t),script=path.join(dir,'service 中文 fixture.mjs'),config=path.join(dir,'configuration file.json'),output=path.join(dir,'pids.json');
  writeJson(config,{output});fs.writeFileSync(script,`import fs from 'node:fs';import {spawn} from 'node:child_process';
    const cfg=JSON.parse(fs.readFileSync(process.argv[2]));const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
    child.once('spawn',()=>fs.writeFileSync(cfg.output,JSON.stringify({service:process.pid,auxiliary:child.pid})));setInterval(()=>{},1000);`);
  const launcher=spawn(executable,['--service-run',process.execPath,script,config],{windowsHide:true,stdio:'ignore'});
  cleanup(t,()=>{if(launcher.exitCode===null)launcher.kill();});
  for(let i=0;i<100&&!fs.existsSync(output);i++)await pause(20);assert.ok(fs.existsSync(output));const pids=json(output);
  if(kill==='service')process.kill(pids.service);else launcher.kill();
  if(launcher.exitCode===null)await once(launcher,'close');
  for(const pid of Object.values(pids)){
    let alive=true;for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{alive=false;break;}await pause(20);}assert.equal(alive,false);
  }
});

win('service broker: shared listener survives the owning Agent Job, then its own Job cleans descendants',async t=>{
  const dir=temporary(t),script=path.join(dir,'listener 中文.mjs'),brokerScript=path.join(dir,'agent.mjs'),config=path.join(dir,'config.json');
  const output=path.join(dir,'listener.json'),brokerOutput=path.join(dir,'broker.json'),error=path.join(dir,'error.txt');
  writeJson(config,{output});fs.writeFileSync(script,`import fs from 'node:fs';import {execFileSync} from 'node:child_process';fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({pid:process.pid,identity:JSON.parse(execFileSync(${JSON.stringify(executable)},['--identity'],{windowsHide:true,encoding:'utf8'}))}));setInterval(()=>{},1000);`);
  fs.writeFileSync(brokerScript,`import fs from 'node:fs';import {launchService} from ${JSON.stringify(pathToFileURL(path.resolve('mcp/dist/shared/service-launch.js')).href)};
    try{const pid=await launchService(${JSON.stringify(executable)},${JSON.stringify(script)},${JSON.stringify(config)});fs.writeFileSync(${JSON.stringify(brokerOutput)},JSON.stringify({pid}));setInterval(()=>{},1000);}catch(e){fs.writeFileSync(${JSON.stringify(error)},String(e));}`);
  const parent=spawn(path.join(bin,'umcp-job-parent.exe'),[process.execPath,brokerScript,config],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let listenerPid,launcherPid;
  cleanup(t,async()=>{parent.stdin.end();if(parent.exitCode===null)parent.kill();if(launcherPid){try{process.kill(launcherPid);}catch{}}await pause(100);});
  const agentPid=Number((await once(parent.stdout,'data'))[0].toString());
  for(let i=0;i<400&&(!fs.existsSync(output)||!fs.existsSync(brokerOutput))&&!fs.existsSync(error);i++)await pause(25);
  if(fs.existsSync(error))assert.fail(fs.readFileSync(error,'utf8'));
  assert.ok(fs.existsSync(output)&&fs.existsSync(brokerOutput));listenerPid=json(output).pid;launcherPid=json(brokerOutput).pid;
  assert.deepEqual(json(output).identity,identity(executable));
  parent.stdin.end();await once(parent,'close');assert.throws(()=>process.kill(agentPid,0));
  assert.doesNotThrow(()=>process.kill(listenerPid,0));assert.doesNotThrow(()=>process.kill(launcherPid,0));
  process.kill(launcherPid);
  let stopped=false;for(let i=0;i<100;i++){try{process.kill(listenerPid,0);}catch{stopped=true;break;}await pause(25);}assert.equal(stopped,true);
});

for (const location of ['temp', 'local-app-data']) win(`management start: ${location} broker starts only the listener, repeated start reuses it; maintenance blocks startup`,async t=>{
  const base = location === 'local-app-data' ? process.env.LOCALAPPDATA : os.tmpdir();
  assert.ok(base && path.isAbsolute(base), 'Windows installation test requires an absolute state parent');
  const dir=temporary(t,base),state=path.join(dir,'private'),b=bundle(dir);
  const installed=createInstallation(state,b,'agent'),physicalState=fs.realpathSync.native(state);
  assert.equal(b.root,fs.realpathSync.native(b.root));
  assert.equal(installed.serviceConfig,path.join(physicalState,'service.json'));
  assert.equal(installed.connectorConfig,path.join(physicalState,'clients','agent.json'));
  assert.equal(json(installed.connectorConfig).serviceConfig,installed.serviceConfig);
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const cfgFile=path.join(state,'service.json'),cfg=json(cfgFile);writeJson(cfgFile,{...cfg,port});
  // A test-only administration listener; imports no MCP runtime or hardware.
  fs.writeFileSync(path.join(b.root,'mcp/dist/shared/daemon-main.js'),`const http=require('node:http');const fs=require('node:fs');const cfg=JSON.parse(fs.readFileSync(process.argv[2]));let maintenance=false;
    const server=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{const cmd=JSON.parse(body);let result;
      if(cmd.operation==='quiesce'){maintenance=true;result={quiesced:true,state:'stopped'};}
      else if(cmd.operation==='shutdown'){result={shuttingDown:true};res.once('finish',()=>server.close(()=>process.exit(0)));}
      else result={state:'stopped',effectiveConnections:0,pid:process.pid,maintenance};res.setHeader('Connection','close');res.end(JSON.stringify(result));});});server.listen(cfg.port,'127.0.0.1');`);
  cleanup(t,()=>stopForMaintenance(state,true));
  const first=await startService(state);assert.equal(first.state,'stopped');assert.equal(first.effectiveConnections,0);assert.equal(first.serviceStarted,true);
  const second=await startService(state);assert.equal(second.pid,first.pid);assert.equal(second.serviceStarted,false);
  await stopForMaintenance(state,true);writeJson(path.join(state,'maintenance.json'),{reason:'fixture'});
  await assert.rejects(startService(state),/installation_in_maintenance/);
});
