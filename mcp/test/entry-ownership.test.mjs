import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio discovery never kills active connection; waiter acquires SDK after owner exits', {skip:process.platform!=='win32',timeout:15000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'umouse-entry-'));
  const clients=[];
  const pipe='\\\\.\\pipe\\umouse-test-'+randomUUID();
  const connect=async()=>{
    const env={...process.env,UMOUSE_TEST_PIPE:pipe,UMSDK_DATA_DIR:dir,UMSDK_ASR_PROVIDER:'disabled'};
    delete env.UMSDK_TAKEOVER; // exercise the production default
    const transport=new StdioClientTransport({command:process.execPath,args:['--import',new URL('./fixtures/entry-fake-sdk.mjs',import.meta.url).href,fileURLToPath(new URL('../dist/index.js',import.meta.url))],env,stderr:'pipe'});
    const client=new Client({name:'isolated-entry-test',version:'1'});
    let diagnostics='';
    clients.push(client);
    const connecting=client.connect(transport);
    transport.stderr?.on('data',b=>diagnostics+=b);
    try {await connecting;} catch(error){throw new Error(String(error)+'\n'+diagnostics);}
    return {client,status:async()=>JSON.parse((await client.callTool({name:'umouse_status',arguments:{}})).content[0].text),diagnostics:()=>diagnostics};
  };
  try {
    const a=await connect(),aStatus=await a.status();
    assert.equal(aStatus.sdkVersion,'fake-entry-no-hardware');assert.equal(aStatus.sdkOwnership.state,'owned');
    const discovery=await connect();assert.equal((await discovery.client.listTools()).tools.length,22);
    assert.equal((await discovery.status()).sdkOwnership.state,'busy');
    await discovery.client.close();
    assert.equal((await a.status()).processId,aStatus.processId);assert.equal((await a.status()).sdkStarted,true);
    const b=await connect(),bStatus=await b.status();assert.equal(bStatus.sdkOwnership.state,'busy');
    await a.client.close();
    let transferred=false;
    for(let i=0;i<40;i++) {
      const status=await b.status();assert.equal(status.processId,bStatus.processId);
      if(status.sdkStarted){transferred=true;assert.equal(status.sdkOwnership.state,'owned');break;}
      await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(transferred,true,b.diagnostics());
    assert.doesNotMatch(a.diagnostics()+b.diagnostics()+discovery.diagnostics(),/已发送终止信号/);
  } finally {
    await Promise.allSettled(clients.map(c=>c.close()));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
