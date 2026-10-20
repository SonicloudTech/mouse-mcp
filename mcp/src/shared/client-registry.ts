import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export type Liveness = 'stdio-heartbeat' | 'http-passive';
export interface ClientContext {
  readonly connectionId: string;
  readonly principalId: string;
  readonly daemonEpoch: string;
  readonly mode: Liveness;
  readonly permissions: readonly string[];
}
interface Lease { context: ClientContext; initialized: boolean; expires: number; activeUntil: number }

/** Authenticated connections only. TCP/SSE sockets and initialize requests do not count as clients. */
export class ClientRegistry extends EventEmitter {
  readonly epoch = randomUUID();
  private entries = new Map<string, Lease>();
  constructor(private readonly now: () => number = () => performance.now(), private readonly limits = {
    initializeMs: 15_000, heartbeatMs: 30_000, passiveMs: 15 * 60_000, activeMs: 45_000, maxClients: 32,
  }) { super(); }
  get count(): number { return [...this.entries.values()].filter(e => e.initialized).length; }
  /** All admitted entries, including connections that have not completed initialization. */
  get size(): number { return this.entries.size; }
  open(principalId: string, mode: Liveness, permissions: readonly string[]): ClientContext {
    if (!principalId || this.entries.size >= this.limits.maxClients) throw new Error('connection_limit');
    const context = Object.freeze({ connectionId: randomUUID(), principalId, daemonEpoch: this.epoch, mode, permissions: Object.freeze([...permissions]) });
    this.entries.set(context.connectionId, { context, initialized: false, expires: this.now() + this.limits.initializeMs, activeUntil: 0 });
    return context;
  }
  private find(c: ClientContext): Lease {
    const e = this.entries.get(c.connectionId);
    if (!e || e.context !== c || c.daemonEpoch !== this.epoch) throw new Error('connection_expired');
    if (this.now() >= Math.max(e.expires, e.activeUntil)) { this.close(c, 'lease_expired'); throw new Error('connection_expired'); }
    return e;
  }
  initialized(c: ClientContext): void {
    const e = this.find(c); if (e.initialized) return;
    e.initialized = true; this.touch(c); this.emit('change', this.count);
  }
  touch(c: ClientContext): void {
    const e = this.find(c);
    if (e.initialized) e.expires = this.now() + (c.mode === 'stdio-heartbeat' ? this.limits.heartbeatMs : this.limits.passiveMs);
  }
  assertActive(c: ClientContext, permission?: string): void {
    const e = this.find(c);
    if (!e.initialized) throw new Error('connection_not_initialized');
    if (permission && !c.permissions.includes(permission)) throw new Error('permission_denied');
  }
  assertConnected(c: ClientContext): void { this.find(c); }
  activeLease(c: ClientContext): void {
    const e = this.find(c); this.assertActive(c); e.activeUntil = this.now() + this.limits.activeMs;
  }
  close(c: ClientContext, reason: string): boolean {
    const e = this.entries.get(c.connectionId); if (!e || e.context !== c) return false;
    this.entries.delete(c.connectionId);
    // Cleanup is notified before a possible last-client worker stop.
    this.emit('closed', c, reason);
    if (e.initialized) this.emit('change', this.count);
    return true;
  }
  sweep(): void {
    for (const e of this.entries.values()) if (this.now() >= Math.max(e.expires, e.activeUntil)) this.close(e.context, e.initialized ? 'lease_expired' : 'initialize_timeout');
  }
  closeAll(): void { for (const e of this.entries.values()) this.close(e.context, 'service_shutdown'); }
}
