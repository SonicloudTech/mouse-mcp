import { EventEmitter } from 'node:events';
import { NativeError, type NativeClient, type NativeReady } from './native-client.js';
import { diagnosticErrorCode } from './diagnostics.js';

export type WorkerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'backoff' | 'faulted' | 'stop-blocked';
export type WorkerHandle = Pick<NativeClient, 'epoch' | 'alive' | 'processId' | 'heartbeatAgeMs' | 'start' | 'stop' | 'on' | 'off' | 'request'>;

/** Exactly one owned worker. All start/stop transitions are serialized, including N=0 -> N=1 during stop. */
export class WorkerSupervisor extends EventEmitter {
  state: WorkerState = 'stopped';
  private desired = 0;
  private handle?: WorkerHandle;
  private pumping?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private failures: number[] = [];
  private retiring = false;
  private retirement?: Promise<boolean>;
  private lastError?: string;
  private lastStartFailure?: { code: string; utc: string };
  private closed = false;
  private quarantine = false;
  private stopRequested = false;
  private readiness?: NativeReady;
  private lastStop?: {clean:boolean;exitCode:number|null};
  constructor(private readonly factory: () => WorkerHandle, private readonly hooks: {
    ready?(client: WorkerHandle, info: NativeReady): Promise<void>;
    beforeStop?(client: WorkerHandle): Promise<void>;
    lost?(epoch: string): void;
  } = {}, private readonly retryMs = [1000, 2000, 5000], private readonly cleanupTimeoutMs = 25_000) {
    super();
    if (!Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 60_000) throw new Error('invalid_cleanup_timeout');
  }
  get worker(): WorkerHandle {
    if (this.state !== 'running' || !this.handle?.alive || this.desired < 1) throw new Error('worker_not_ready');
    return this.handle;
  }
  get status(): Record<string, unknown> {
    return { state: this.state, effectiveConnections: this.desired, workerEpoch: this.handle?.epoch, pid: this.handle?.processId,
      plugins: this.readiness?.plugins, unavailable: this.readiness?.unavailable, lastError: this.lastError, lastStartFailure:this.lastStartFailure, lastStop:this.lastStop,
      cleanupTimeoutMs: this.cleanupTimeoutMs, recovery: this.state === 'faulted' || this.state === 'stop-blocked'
        ? 'Stop all connections, confirm worker exit, then restart the daemon. Unconfirmed SDK/input markers require explicit local hardware-reset recovery; no automatic replay.' : undefined };
  }
  setCount(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid_connection_count');
    this.desired = this.closed ? 0 : count;
    if (!this.desired && this.handle) this.stopRequested = true;
    if (!this.desired && this.retry) { clearTimeout(this.retry); this.retry = undefined; this.state = 'stopped'; }
    this.kick();
  }
  private setState(state: WorkerState): void { this.state = state; this.emit('state', this.status); }
  private kick(): void {
    if (this.pumping) return;
    this.pumping = this.reconcile().catch(() => { this.lastError = 'supervisor_internal_error'; this.setState('faulted'); }).finally(() => {
      this.pumping = undefined;
      if (!this.retry && this.state !== 'faulted' && this.state !== 'stop-blocked'
        && ((this.desired > 0 && !this.handle) || (this.desired === 0 && !!this.handle))) this.kick();
    });
  }
  private retire(client: WorkerHandle): Promise<boolean> {
    return this.retirement ??= this.doRetire(client).finally(() => { this.retirement = undefined; });
  }
  private async doRetire(client: WorkerHandle): Promise<boolean> {
    this.retiring = true; this.setState('stopping');
    try {
      let cleanupOk = true, timer: NodeJS.Timeout | undefined;
      try { await Promise.race([Promise.resolve(this.hooks.beforeStop?.(client)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('runtime_cleanup_timeout')), this.cleanupTimeoutMs); })]); }
      catch { cleanupOk = false; this.lastError = 'runtime_cleanup_failed'; }
      finally { if (timer) clearTimeout(timer); }
      const result = await client.stop();
      this.lastStop={clean:result.clean,exitCode:result.exitCode};
      if (client.alive) throw new Error('stop_blocked');
      this.hooks.lost?.(client.epoch); this.handle = undefined; this.readiness = undefined;
      if (!result.clean || !cleanupOk || this.quarantine) { this.lastError ??= 'cleanup_unconfirmed'; this.setState('faulted'); return false; }
      this.setState('stopped'); return true;
    } catch { this.lastError = 'stop_blocked'; this.setState('stop-blocked'); return false; }
    finally { this.retiring = false; }
  }
  private failed(client: WorkerHandle, code: string): void {
    if (this.handle !== client || this.retiring) return;
    this.lastError = code; this.readiness = undefined;
    this.hooks.lost?.(client.epoch);
    // Never clear the handle before the exit observer proves it is dead.
    if (client.alive) { void this.retire(client); return; }
    this.handle = undefined;
    this.failures = this.failures.filter(time => performance.now() - time < 300_000);
    this.failures.push(performance.now());
    if (this.failures.length > this.retryMs.length) { this.setState('faulted'); return; }
    if (!this.desired || this.closed) { this.setState('stopped'); return; }
    this.setState('backoff');
    this.retry = setTimeout(() => { this.retry = undefined; this.setState('stopped'); this.kick(); }, this.retryMs[this.failures.length - 1]);
  }
  private async reconcile(): Promise<void> {
    if (this.state === 'faulted' || this.state === 'stop-blocked' || this.retry) return;
    if (!this.desired && this.handle) { await this.retire(this.handle); return; }
    if (!this.desired || this.handle) return;
    const client = this.factory(); this.handle = client; this.stopRequested = false; this.setState('starting');
    const exited = () => this.failed(client, 'worker_exited');
    client.on('exit', exited);
    client.on('unresponsive', () => {
      if (this.handle !== client || this.retiring) return;
      this.quarantine = true; this.lastError = 'worker_request_timeout'; void this.retire(client);
    });
    try {
      const ready = await client.start();
      if (this.handle !== client || !client.alive) return;
      if (!this.desired || this.stopRequested) { await this.retire(client); return; }
      await this.hooks.ready?.(client, ready);
      if (this.handle !== client || !client.alive) return;
      if (!this.desired || this.stopRequested) { await this.retire(client); return; }
      this.lastStartFailure = undefined;
      this.readiness = ready; this.setState('running');
      if (!this.desired) await this.retire(client);
    } catch (error) {
      if (this.handle !== client) return;
      this.lastStartFailure = { code: diagnosticErrorCode(error instanceof NativeError ? error.code : undefined), utc: new Date().toISOString() };
      // A ready-hook failure can leave native SDK state: cleanly retire before retry.
      if (client.alive) {
        const ok = await this.retire(client);
        if (ok && this.desired) { this.handle = client; this.failed(client, 'worker_start_failed'); }
      } else this.failed(client, 'worker_start_failed');
    }
  }
  checkHeartbeat(): void {
    const c = this.handle;
    if (this.state === 'running' && c && c.heartbeatAgeMs > 5000) {
      // A hung worker is uncertain; stop it and latch fault, never replay a call.
      this.lastError = 'worker_heartbeat_timeout';
      this.quarantine = true;
      void this.retire(c).then(() => { this.lastError = 'worker_heartbeat_timeout'; this.setState('faulted'); });
    }
  }
  async settled(): Promise<void> { while (this.pumping || this.retirement) await (this.pumping ?? this.retirement); }
  async shutdown(): Promise<void> {
    this.closed = true; this.desired = 0; if (this.retry) clearTimeout(this.retry); this.retry = undefined;
    await this.settled();
    if (this.handle) await this.retire(this.handle);
  }
}
