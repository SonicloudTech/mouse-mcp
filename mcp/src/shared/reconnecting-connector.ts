import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { InitializeResultSchema, type JSONRPCMessage, type JSONRPCRequest, type RequestId } from '@modelcontextprotocol/sdk/types.js';

/** Keep the host's stdio alive across backend loss. Only protocol initialization
 * is replayed; neither tool calls nor owner-scoped notifications are buffered. */
export class ReconnectingConnector {
  private remote?: Transport;
  private ended = false;
  private initialized = false;
  private ready = false;
  private initialize?: JSONRPCRequest;
  private negotiated?: { protocolVersion: string; capabilities: unknown };
  private pending = new Map<RequestId, JSONRPCRequest>();
  private serverRequests = new Map<RequestId, RequestId>();
  private reconnecting?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;
  private wakeRetry?: () => void;
  private handshake?: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
  private outputBytes = 0;
  private outputTimers = new Set<NodeJS.Timeout>();
  private lastError = 'shared_service_reconnecting';

  constructor(private readonly host: Transport, private readonly connect: () => Promise<Transport>,
    private readonly report: (message: string) => void = () => {}) {}

  async start(): Promise<void> {
    this.host.onmessage = message => this.fromHost(message);
    this.host.onclose = () => { void this.close(); };
    this.host.onerror = () => { void this.close(); };
    const remote = await this.connect();
    if (this.ended) { await remote.close(); return; }
    await this.attach(remote);
    if (this.ended || this.remote !== remote) return;
    this.ready = true;
    await this.host.start();
  }
  private async attach(remote: Transport): Promise<void> {
    this.remote = remote;
    remote.onmessage = message => { if (this.remote === remote && !this.ended) this.fromRemote(message); };
    remote.onclose = () => this.lost(remote);
    remote.onerror = () => this.lost(remote);
    await remote.start();
  }
  private sendHost(message: JSONRPCMessage): void {
    if (this.ended) return;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.outputBytes + bytes > 9 * 1024 * 1024) { void this.close(); return; }
    this.outputBytes += bytes;
    const timeout = setTimeout(() => { void this.close(); }, 10_000);
    this.outputTimers.add(timeout);
    void this.host.send(message).catch(() => this.close()).finally(() => {
      this.outputBytes -= bytes; clearTimeout(timeout); this.outputTimers.delete(timeout);
    });
  }
  private fail(request: JSONRPCRequest, reason: string): void {
    const detail = { error: reason, retryAutomatic: false, connectionReset: true,
      message: 'Check umouse_status after recovery. Do not replay previous input; old session/capture IDs are invalid.' };
    if (request.method === 'tools/call') this.sendHost({ jsonrpc: '2.0', id: request.id,
      result: { isError: true, content: [{ type: 'text', text: JSON.stringify(detail) }] } });
    else this.sendHost({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: reason, data: detail } });
  }
  private fromHost(message: JSONRPCMessage): void {
    if (this.ended) return;
    if ('method' in message && 'id' in message && message.method === 'ping') {
      this.sendHost({ jsonrpc: '2.0', id: message.id, result: {} }); return;
    }
    if (!this.ready || !this.remote) {
      if ('method' in message && 'id' in message) this.fail(message, this.lastError);
      return; // Never queue notifications, actions or replies from the old owner.
    }
    if (Buffer.byteLength(JSON.stringify(message)) > 1024 * 1024) {
      if ('method' in message && 'id' in message) this.fail(message, 'connector_request_limit');
      return;
    }
    if ('method' in message && 'id' in message) {
      if (this.pending.has(message.id)) { void this.close(); return; }
      if (this.pending.size >= 128) { this.fail(message, 'connector_pending_limit'); return; }
      if (message.method === 'initialize') {
        if (this.initialize) { this.fail(message, 'connector_already_initialized'); return; }
        this.initialize = message;
      }
      this.pending.set(message.id, message);
    } else if (!('method' in message)) {
      if (message.id === undefined || !this.serverRequests.has(message.id)) return;
      const originalId = this.serverRequests.get(message.id)!;
      this.serverRequests.delete(message.id);
      message = { ...message, id: originalId };
    }
    if ('method' in message && message.method === 'notifications/initialized' && this.negotiated) this.initialized = true;
    const remote = this.remote;
    void remote.send(message).catch(() => this.lost(remote));
  }
  private fromRemote(message: JSONRPCMessage): void {
    // Fixed tool catalog: reconnect restores ownership, not dynamic discovery.
    if ('method' in message && !('id' in message) && message.method === 'notifications/tools/list_changed') return;
    const handshake = this.handshake;
    if (!('method' in message) && handshake && handshake.id === message.id) {
      if ('result' in message) handshake.resolve(message.result);
      else handshake.reject(new Error('connector_initialize_failed'));
      return;
    }
    if (!this.ready) return;
    if (!('method' in message)) {
      if (message.id === undefined) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (request.method === 'initialize' && 'result' in message) {
        const parsed = InitializeResultSchema.safeParse(message.result);
        if (parsed.success) this.negotiated = { protocolVersion: parsed.data.protocolVersion, capabilities: parsed.data.capabilities };
      }
    } else if ('id' in message) {
      if (this.serverRequests.size >= 128) { this.lost(this.remote!); return; }
      const id = `umcp-server-${randomUUID()}`;
      this.serverRequests.set(id, message.id);
      message = { ...message, id };
    }
    this.sendHost(message);
  }
  private lost(remote: Transport): void {
    if (this.remote !== remote || this.ended) return;
    this.ready = false; this.remote = undefined;
    this.handshake?.reject(new Error('shared_service_disconnected'));
    this.serverRequests.clear();
    void remote.close().catch(() => {});
    for (const request of this.pending.values()) this.fail(request, 'shared_service_disconnected_result_unknown');
    this.pending.clear();
    if (!this.initialized || !this.initialize || !this.negotiated) { void this.close(); return; }
    this.lastError = 'shared_service_reconnecting';
    this.beginReconnect();
  }
  private beginReconnect(): void {
    if (!this.reconnecting) {
      this.report('backend_disconnected; keeping_stdio; pending_operations_not_replayed');
      this.reconnecting = this.reconnect().finally(() => {
        this.reconnecting = undefined;
        if (!this.ended && !this.ready && this.lastError !== 'connector_protocol_changed_restart_mcp') this.beginReconnect();
      });
    }
  }
  private async reconnect(): Promise<void> {
    for (let attempt = 0; !this.ended; attempt++) {
      await new Promise<void>(resolve => {
        this.wakeRetry = resolve;
        this.retryTimer = setTimeout(resolve, [500, 1000, 2000, 5000][Math.min(attempt, 3)]);
      });
      this.wakeRetry = undefined; this.retryTimer = undefined;
      if (this.ended) return;
      try {
        const remote = await this.connect();
        if (this.ended) { await remote.close(); return; }
        // Build the handshake before start(): it may receive buffered data.
        const id = `umcp-reinitialize-${randomUUID()}`;
        let timeout: NodeJS.Timeout | undefined;
        const response = new Promise<unknown>((resolve, reject) => {
          this.handshake = { id, resolve, reject };
          timeout = setTimeout(() => reject(new Error('connector_initialize_timeout')), 5000);
        });
        // Attach the rejection handler immediately, including start/send failures.
        const handshake = response.then(value => InitializeResultSchema.parse(value));
        void handshake.catch(() => {});
        try {
          await this.attach(remote);
          await remote.send({ ...this.initialize!, id });
          const info = await handshake;
          if (!isDeepStrictEqual(this.negotiated, { protocolVersion: info.protocolVersion, capabilities: info.capabilities }))
            throw new Error('connector_protocol_changed_restart_mcp');
          await remote.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          if (this.ended || this.remote !== remote) throw new Error('shared_service_disconnected');
          this.ready = true;
          this.report('backend_reconnected; new_owner; previous_operations_not_replayed');
          return;
        } finally { clearTimeout(timeout); this.handshake = undefined; }
      } catch (error) {
        const remote = this.remote; this.remote = undefined; this.ready = false;
        if (remote) await remote.close().catch(() => {});
        // Do not emit paths, credentials or backend exception details to stdout.
        if (error instanceof Error && error.message === 'connector_protocol_changed_restart_mcp') {
          this.lastError = error.message; this.report(error.message); return;
        }
      }
    }
  }
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true; this.ready = false;
    clearTimeout(this.retryTimer); this.wakeRetry?.();
    for (const timer of this.outputTimers) clearTimeout(timer);
    this.handshake?.reject(new Error('connector_closed'));
    const remote = this.remote; this.remote = undefined;
    this.pending.clear(); this.serverRequests.clear();
    await Promise.allSettled([remote?.close(), this.host.close()]);
  }
}
