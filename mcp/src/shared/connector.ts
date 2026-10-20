import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SocketTransport } from './socket-transport.js';
import { ReconnectingConnector } from './reconnecting-connector.js';
import { identity } from './daemon-main.js';
import { launchService } from './service-launch.js';
import { PIPE_PROTOCOL, tokenHash, keyId, isNonce, proof, validProof } from './pipe-auth.js';

export interface ConnectorConfig { schemaVersion: 1; pipe: string; token: string; serviceConfig: string }
// An older host-side connector must follow the atomically selected bundle after upgrade.
export function serviceEntry(service: { bundleRoot?: string }): string {
  if (service.bundleRoot !== undefined) {
    if (!path.isAbsolute(service.bundleRoot)) throw new Error('absolute_bundle_required');
    const entry = path.join(service.bundleRoot, 'mcp/dist/shared/daemon-main.js');
    if (!fs.statSync(entry).isFile()) throw new Error('service_entry_missing');
    return entry;
  }
  return fileURLToPath(new URL('./daemon-main.js', import.meta.url));
}
export async function connectSocket(config: ConnectorConfig): Promise<{ socket: net.Socket; initial: string }> {
  const hash = tokenHash(config.token), clientNonce = randomBytes(32).toString('hex');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.pipe); socket.setEncoding('utf8'); let buffer = '';
    let challenge: { serverNonce: string; daemonEpoch: string } | undefined;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('connector_handshake_timeout')); }, 5000);
    const fail = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.once('error', fail); socket.once('close', () => fail(new Error('connector_closed')));
    socket.once('connect', () => socket.write(JSON.stringify({ protocol: PIPE_PROTOCOL, keyId: keyId(hash), clientNonce }) + '\n'));
    const read = (part: string | Buffer) => {
      buffer += part.toString();
      if (Buffer.byteLength(buffer) > 4096) return fail(new Error('connector_handshake_limit'));
      try {
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const hello = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (hello.protocol !== PIPE_PROTOCOL || typeof hello.daemonEpoch !== 'string' || hello.daemonEpoch.length > 64) throw new Error('service_protocol_mismatch');
          if (!challenge) {
            if (!isNonce(hello.serverNonce) || !validProof(hello.proof, proof(hash, 'server', clientNonce, hello.serverNonce, hello.daemonEpoch))) throw new Error('service_authentication_failed');
            challenge = { serverNonce: hello.serverNonce, daemonEpoch: hello.daemonEpoch };
            socket.write(JSON.stringify({ protocol: PIPE_PROTOCOL, proof: proof(hash, 'client', clientNonce, challenge.serverNonce, challenge.daemonEpoch) }) + '\n');
          } else {
            if (hello.daemonEpoch !== challenge.daemonEpoch || !validProof(hello.proof, proof(hash, 'accepted', clientNonce, challenge.serverNonce, challenge.daemonEpoch))) throw new Error('service_authentication_failed');
            socket.pause(); clearTimeout(timer); socket.off('data', read); socket.off('error', fail); socket.removeAllListeners('close');
            resolve({ socket, initial: buffer }); return;
          }
        }
      } catch (e) { fail(e as Error); }
    }; socket.on('data', read);
  });
}
async function main(): Promise<void> {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw new Error('absolute_connector_config_required');
  const file = process.argv[2];
  let validatedService: string | undefined;
  const connect = async (): Promise<SocketTransport> => {
    // Reload only trusted private configuration; rotation/revocation/maintenance
    // must not be bypassed using cached credentials during reconnection.
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as ConnectorConfig;
    if (config.schemaVersion !== 1 || !config.pipe.startsWith('\\\\.\\pipe\\umouse-mcp-') || !path.isAbsolute(config.serviceConfig)) throw new Error('connector_config_invalid');
    if (fs.existsSync(path.join(path.dirname(config.serviceConfig), 'maintenance.json'))) throw new Error('installation_in_maintenance');
    if (fs.existsSync(config.serviceConfig)) {
      const raw = fs.readFileSync(config.serviceConfig, 'utf8');
      const service = JSON.parse(raw);
      if (raw !== validatedService) {
        const actual = identity(service.executable);
        if (service.sid !== actual.sid || service.windowsSessionId !== actual.windowsSessionId) throw new Error('windows_identity_mismatch');
        validatedService = raw;
      }
    } else if (!config.pipe.startsWith('\\\\.\\pipe\\umouse-mcp-test-')) throw new Error('service_config_missing');
    let connection;
    try { connection = await connectSocket(config); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const service = JSON.parse(fs.readFileSync(config.serviceConfig, 'utf8'));
      await launchService(service.executable, serviceEntry(service), config.serviceConfig);
      const deadline = performance.now() + 15_000;
      while (!connection && performance.now() < deadline) {
        await new Promise(r => setTimeout(r, 150));
        try { connection = await connectSocket(config); }
        catch (e) { if (!['ENOENT', 'ECONNREFUSED'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
      }
      if (!connection) throw new Error('service_start_timeout');
    }
    // Preserve the bounded response envelope; inbound tool requests remain 1 MiB at the daemon.
    const remote = new SocketTransport(connection.socket, () => {}, connection.initial, 9 * 1024 * 1024);
    const heartbeat = setInterval(() => {
      if (connection.socket.writable) connection.socket.write('{"_umcpHeartbeat":1}\n', (e?: Error | null) => { if (e) remote.onerror?.(e); });
    }, 10_000);
    const close = remote.close.bind(remote);
    remote.close = async () => { clearInterval(heartbeat); await close(); };
    return remote;
  };
  const stdio = new StdioServerTransport();
  const proxy = new ReconnectingConnector(stdio, connect, message => console.error(`[umouse-connector] ${message}`));
  const stop = () => { void proxy.close(); };
  process.stdin.once('end', stop); process.stdin.once('error', stop);
  process.stdout.once('error', stop);
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try { await proxy.start(); } catch (error) { await proxy.close(); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(e => { console.error(`[umouse-connector] ${e instanceof Error ? e.message : 'connection_failed'}`); process.exitCode = 1; });
}
