import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { SocketTransport } from '../dist/shared/socket-transport.js';

test('connector transport: large response payload over 1 MiB survives while inbound request cap stays bounded',async t=>{
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const pending=once(server,'connection'),client=net.createConnection(server.address().port,'127.0.0.1'),[accepted]=await pending;
  const outgoing=new SocketTransport(accepted,()=>{}),incoming=new SocketTransport(client,()=>{},'',9*1024*1024);
  t.after(async()=>{await outgoing.close();await incoming.close();await new Promise(r=>server.close(r));});
  await outgoing.start();await incoming.start();
  const response=new Promise(r=>incoming.onmessage=r),data='A'.repeat(2*1024*1024);
  await outgoing.send({jsonrpc:'2.0',id:1,result:{content:[{type:'image',mimeType:'image/png',data}]}});
  assert.equal((await response).result.content[0].data.length,data.length);
  const rejected=new Promise(r=>outgoing.onerror=r);await incoming.send({jsonrpc:'2.0',id:2,method:'invalid',params:{data}});
  assert.match((await rejected).message,/invalid_connector_frame/);
});
