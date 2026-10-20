// Real native processes with the dedicated fake plugin; never opens USB or loads vendor DLLs.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {SharedDaemon} from '../dist/shared/daemon.js';
import {loadConfig} from '../dist/env.js';
const output=process.argv[2],cycles=Number(process.argv[3]??10000);
if(!path.isAbsolute(output??'')||!Number.isInteger(cycles)||cycles<1||cycles>10000)throw new Error('absolute output and cycles 1..10000 required');
const bin=path.resolve('mcp/sdk-host/build/bin'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'umcp-process-cycles-')),manifest=path.join(dir,'fake.json');
const sha=b=>createHash('sha256').update(b).digest('hex'),token=randomUUID()+randomUUID(),dll=path.join(bin,'umcp_fake.dll');
await fs.writeFile(manifest,JSON.stringify({schemaVersion:1,profile:'test',testNamespace:randomUUID(),root:bin,plugins:[{id:'fake',path:dll,sha256:sha(await fs.readFile(dll)),required:true,config:{}}]}));
const daemon=new SharedDaemon({port:0,pipe:`\\\\.\\pipe\\umouse-mcp-test-${randomUUID()}`,testing:true,
  native:{executable:path.join(bin,'umouse-sdk-host.exe'),manifest,testing:true},bridge:loadConfig({UMSDK_DATA_DIR:dir}),
  principals:[{id:'bench',tokenSha256:sha(token),permissions:['device.read','test']}]});
const report={started:new Date().toISOString(),servicePid:process.pid,fakeOnly:true,realVendorLoaded:false,completed:false,cycles:0,requested:cycles,samples:[],resources:[]};
report.nativeHash=sha(await fs.readFile(path.join(bin,'umouse-sdk-host.exe')));
report.transitions=[];daemon.supervisor.on('state',s=>{report.transitions.push({at:performance.now(),...s});if(report.transitions.length>100)report.transitions.shift();});
const run=promisify(execFile);let client,transport;
async function resources(){global.gc?.();const {stdout}=await run('powershell.exe',['-NoProfile','-Command',`Get-Process -Id ${process.pid} | Select-Object Id,HandleCount,@{n='ThreadCount';e={$_.Threads.Count}},WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`],{windowsHide:true});return{cycle:report.cycles,memory:process.memoryUsage(),cpu:process.cpuUsage(),windows:JSON.parse(stdout)};}
try{
  await daemon.listen();report.resources.push(await resources());
  for(let i=0;i<cycles;i++){
    const at=performance.now();transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.address.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
    client=new Client({name:'fake-worker-cycle',version:'1'});await client.connect(transport);await daemon.supervisor.settled();
    if(daemon.registry.count!==1||daemon.supervisor.state!=='running')throw new Error('worker_not_running');
    const ready=performance.now(),pid=daemon.supervisor.worker.processId,epoch=daemon.supervisor.worker.epoch;
    const worker=daemon.supervisor.worker,originalStop=worker.stop.bind(worker);worker.stop=async()=>{const r=await originalStop();report.lastNativeStop=r;return r;};
    const echo=await client.callTool({name:'umouse_test_echo',arguments:{value:`cycle-${i}`}});if(JSON.parse(echo.content[0].text).value!==`cycle-${i}`)throw new Error('echo_mismatch');
    await transport.terminateSession();await client.close();await daemon.supervisor.settled();
    if(daemon.registry.count||daemon.supervisor.state!=='stopped')throw new Error('worker_not_stopped');
    try{process.kill(pid,0);throw new Error('worker_still_alive');}catch(e){if(e.code!=='ESRCH')throw e;}
    report.samples.push({pid,epoch,startMs:ready-at,stopMs:performance.now()-ready});report.cycles++;
    if(report.cycles%100===0||report.cycles===cycles){report.resources.push(await resources());await fs.writeFile(output,JSON.stringify(report));console.log(`actual fake worker starts/stops ${report.cycles}/${cycles}`);}
  }
  report.daemonStillListening=(await fetch(`http://127.0.0.1:${daemon.address.port}/mcp`)).status===401;
  report.completed=true;report.ended=new Date().toISOString();
}catch(e){report.error=String(e);report.failureStatus=daemon.supervisor.status;report.failureConnections=daemon.registry.count;throw e;}
finally{await client?.close().catch(()=>{});await daemon.close();await fs.writeFile(output,JSON.stringify(report));await fs.rm(dir,{recursive:true,force:true});}
