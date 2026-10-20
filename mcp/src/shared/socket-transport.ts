import type { Socket } from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Private stdio connector transport. Authentication must finish before constructing it. */
export class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffer = '';
  private closed = false;
  constructor(private readonly socket: Socket, private readonly onInbound: () => void, private readonly initial = '',
    private readonly maxInboundBytes = 1024 * 1024) {}
  async start(): Promise<void> {
    this.socket.setEncoding('utf8');
    this.socket.on('data', this.data);
    this.socket.once('close', () => { this.closed = true; this.onclose?.(); });
    this.socket.on('error', e => this.onerror?.(e));
    if (this.initial) queueMicrotask(() => this.data(this.initial));
    this.socket.resume();
  }
  private data = (chunk: string | Buffer): void => {
    if (this.closed) return;
    this.buffer += chunk.toString();
    let end;
    try {
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (Buffer.byteLength(line) > this.maxInboundBytes) throw new Error('frame_limit');
        const raw: unknown = JSON.parse(line);
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 1 && '_umcpHeartbeat' in raw) {
          this.onInbound(); continue;
        }
        const message = JSONRPCMessageSchema.parse(raw); this.onInbound(); this.onmessage?.(message);
      }
      if (Buffer.byteLength(this.buffer) > this.maxInboundBytes) throw new Error('frame_limit');
    } catch { this.onerror?.(new Error('invalid_connector_frame')); void this.close(); }
  };
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.socket.writable) throw new Error('transport_closed');
    const line = JSON.stringify(message) + '\n';
    if (this.socket.writableLength + Buffer.byteLength(line) > 9 * 1024 * 1024) { void this.close(); throw new Error('transport_backpressure'); }
    await new Promise<void>((resolve, reject) => this.socket.write(line, e => e ? reject(e) : resolve()));
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.socket.destroy(); }
}
