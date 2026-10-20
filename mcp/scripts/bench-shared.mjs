import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SharedDaemon } from '../dist/shared/daemon.js';
import { loadConfig } from '../dist/env.js';

const output = process.argv[2]; if (!output || !path.isAbsolute(output)) throw new Error('absolute output JSON path required');
const cycles = Number(process.argv[3] ?? 10000);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 10000) throw new Error('cycles range 1..10000');
const root = path.resolve('mcp/sdk-host/build/bin'), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'umcp-bench-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const token = randomBytes(32).toString('hex'), manifest = path.join(dir, 'manifest.json'), dll = path.join(root, 'umcp_fake.dll');
await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, profile: 'test', root, testNamespace: randomUUID(), plugins: [{ id: 'fake', path: dll, sha256: hash(await fs.readFile(dll)), required: true, config: {} }] }));
const daemon = new SharedDaemon({ port: 0, pipe: `\\\\.\\pipe\\umouse-mcp-test-${randomUUID()}`, testing: true,
  native: { executable: path.join(root, 'umouse-sdk-host.exe'), manifest, testing: true }, bridge: loadConfig({ UMSDK_DATA_DIR: dir }),
  principals: [{ id: 'bench', tokenSha256: hash(token), permissions: ['device.read', 'test'] }] });
const start = performance.now(); await daemon.listen(); const listenMs = performance.now() - start;
const url = `http://127.0.0.1:${daemon.address.port}/mcp`;
async function connectHttp() {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'isolated-benchmark', version: '1' }); await client.connect(transport); return { client, transport };
}
const firstAt = performance.now(), anchor = await connectHttp(); await daemon.supervisor.settled(); const firstWorkerMs = performance.now() - firstAt;
const report = { at: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, fakeOnly: true,
  servicePid: process.pid, workerPid: daemon.supervisor.worker.processId, listenMs, firstWorkerMs, sdkLoaded: false, samples: {}, cycles: 0 };
await fs.writeFile(output, JSON.stringify(report, null, 2));
const connectorFile = path.join(dir, 'connector.json');
await fs.writeFile(connectorFile, JSON.stringify({ schemaVersion: 1, pipe: daemon.address.pipe, token, serviceConfig: path.join(dir, 'unused.json') }));
const stdioTransport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp/dist/shared/connector.js'), connectorFile], stderr: 'pipe' });
const stdioClient = new Client({ name: 'isolated-stdio-benchmark', version: '1' });
const stdioAt = performance.now(); await stdioClient.connect(stdioTransport);
report.stdioConnectMs = performance.now() - stdioAt; report.pipeAuthenticationProtocol = 2;
try {
  const value = 'x'.repeat(1024), summaries = {};
  for (const [name, call] of Object.entries({
    nativePipe: () => daemon.supervisor.worker.request('fake', 'echo', { value }),
    streamableHttp: () => anchor.client.callTool({ name: 'umouse_test_echo', arguments: { value } }),
    stdioConnector: () => stdioClient.callTool({ name: 'umouse_test_echo', arguments: { value } }),
  })) {
    for (let i = 0; i < 20; i++) await call();
    const samples = []; for (let i = 0; i < 500; i++) { const at = performance.now(); await call(); samples.push(performance.now() - at); }
    report.samples[name] = samples; const sorted = [...samples].sort((a, b) => a - b);
    summaries[name] = { count: samples.length, payloadBytes: 1024, p50: sorted[249], p95: sorted[474], p99: sorted[494], max: sorted.at(-1) };
  }
  report.latencyMs = summaries; global.gc?.(); report.forcedGcAvailable = !!global.gc;
  report.memoryBeforeChurn = process.memoryUsage(); report.rssBeforeChurn = process.memoryUsage().rss;
  for (let i = 0; i < cycles; i++) {
    const c = await connectHttp(); await c.transport.terminateSession(); await c.client.close();
    if (daemon.registry.count !== 2) throw new Error('connection_count_leak');
    report.cycles++;
    if ((i + 1) % 1000 === 0) { await fs.writeFile(output, JSON.stringify(report, null, 2)); console.log(`offline logical connection cycles: ${i + 1}`); }
  }
  global.gc?.(); report.memoryAfterChurn = process.memoryUsage(); report.rssAfterChurn = process.memoryUsage().rss;
  report.workerUnchanged = report.workerPid === daemon.supervisor.worker.processId;
  await stdioClient.close(); await anchor.transport.terminateSession(); await anchor.client.close();
  const stopAt = performance.now(); await daemon.supervisor.settled(); report.lastDisconnectToStoppedMs = performance.now() - stopAt;
  report.zeroConnections = daemon.registry.count === 0; report.workerStopped = daemon.supervisor.state === 'stopped'; report.daemonStillListening = true;
  report.completed = true; await fs.writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, samples: undefined }));
} finally {
  await stdioClient.close().catch(() => {}); await anchor.transport.terminateSession().catch(() => {}); await anchor.client.close().catch(() => {});
  await daemon.close(); await fs.rm(dir, { recursive: true, force: true });
}
