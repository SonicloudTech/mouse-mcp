import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import fs from 'node:fs';
import { DiagnosticLog, diagnosticErrorCode } from './diagnostics.js';

export interface NativeOptions {
  executable: string;
  manifest: string;
  testing?: boolean;
  startupMs?: number;
  shutdownMs?: number;
  requestMs?: number;
  expectedIdentity?: { sid: string; windowsSessionId: number };
  workingDirectory?: string;
  diagnosticsDirectory?: string;
}
export interface NativeReady {
  kind: 'ready'; protocolVersion: 1; workerEpoch: string; pid: number;
  sid: string; windowsSessionId: number;
  plugins: Array<{ id: string; version: string; abi: number; capabilities: string[] }>;
  unavailable: Array<{ id: string; error: string }>;
  sdkInitialized: false;
}
export class NativeError extends Error {
  constructor(readonly code: string, readonly outcome: 'not_admitted' | 'unknown' = 'unknown') { super(code); }
}
type Pending = { resolve(value: unknown): void; reject(error: unknown): void; timer: NodeJS.Timeout; removeAbort(): void };
const MAX_FRAME = 9 * 1024 * 1024;

/** Private native-host RPC only. It neither imports Koffi nor loads any SDK DLL. */
export class NativeClient extends EventEmitter {
  readonly epoch = randomUUID();
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private ready?: NativeReady;
  private closing = false;
  private cleanStop = false;
  private exitCode: number | null | undefined;
  private closed?: Promise<void>;
  private diagnostics = '';
  private lastHeartbeatAt = performance.now();
  private startPromise?: Promise<NativeReady>;
  private stopPromise?: Promise<{ clean: boolean; exitCode: number | null; diagnostics: string }>;
  readonly trace: DiagnosticLog;

  constructor(readonly options: NativeOptions) {
    super();
    if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.manifest)) throw new NativeError('absolute_native_paths_required', 'not_admitted');
    if (options.workingDirectory && !path.isAbsolute(options.workingDirectory)) throw new NativeError('absolute_working_directory_required', 'not_admitted');
    this.trace = new DiagnosticLog(options.diagnosticsDirectory);
  }
  get processId(): number | undefined { return this.child?.pid; }
  get alive(): boolean { return !!this.child && this.exitCode === undefined; }
  // The serial native executor may legitimately spend >5s inside a bounded call.
  // In-flight calls use requestMs; idle/unresponsive-after-cancel uses the 5s heartbeat budget.
  get heartbeatAgeMs(): number { return this.pending.size ? 0 : performance.now() - this.lastHeartbeatAt; }
  get status(): NativeReady | undefined { return this.ready; }

  start(): Promise<NativeReady> {
    if (this.startPromise) return this.startPromise;
    if (this.closing) return Promise.reject(new NativeError('worker_stopping', 'not_admitted'));
    this.startPromise = this.launch();
    return this.startPromise;
  }
  private launch(): Promise<NativeReady> {
    const args = ['--manifest', this.options.manifest, '--epoch', this.epoch, '--parent', String(process.pid)];
    if (this.options.testing) args.push('--test');
    if (this.options.workingDirectory) fs.mkdirSync(this.options.workingDirectory, { recursive: true });
    const child = spawn(this.options.executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: this.options.workingDirectory,
      env: {...process.env, UMCP_TRACE_DIR: this.options.diagnosticsDirectory ?? ''} });
    this.child = child;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let readyResolve: (ready: NativeReady) => void;
    let readyReject: (error: unknown) => void;
    const promise = new Promise<NativeReady>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const timeout = setTimeout(() => {
      readyReject(new NativeError('worker_start_timeout'));
      void this.stop().catch(() => {});
    }, this.options.startupMs ?? 15_000);
    const fatal = (code: string) => {
      readyReject(new NativeError(code));
      this.rejectPending(code);
      void this.stop().catch(() => {});
    };
    child.stderr.on('data', (b: Buffer) => {
      this.diagnostics = (this.diagnostics + b.toString('utf8')).slice(-16_384);
    });
    child.stdout.on('data', (b: Buffer) => {
      buffer += decoder.write(b);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_FRAME) { fatal('worker_output_limit'); return; }
        try {
          const frame: unknown = JSON.parse(line);
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error();
          const f = frame as Record<string, unknown>;
          if (f.workerEpoch !== this.epoch) { fatal('worker_epoch_mismatch'); return; }
          this.lastHeartbeatAt = performance.now();
          if (f.kind === 'ready') {
            if (this.ready || f.protocolVersion !== 1 || f.pid !== child.pid || !Array.isArray(f.plugins) || !Array.isArray(f.unavailable)) { fatal('worker_handshake_invalid'); return; }
            const identity = this.options.expectedIdentity;
            if (identity && (f.sid !== identity.sid || f.windowsSessionId !== identity.windowsSessionId)) { fatal('worker_identity_mismatch'); return; }
            this.ready = frame as NativeReady;
            clearTimeout(timeout); readyResolve(this.ready);
          } else if (f.kind === 'response') {
            const body = f.body as { ok?: unknown; result?: unknown; error?: unknown } | undefined;
            this.trace.record('native.response.received', {rpcId:f.id,ok:body?.ok===true,
              ...(body?.ok===true?{}:{errorCode:diagnosticErrorCode(body?.error)})});
            if (typeof f.id !== 'string') { fatal('worker_protocol_error'); return; }
            const p = this.pending.get(f.id);
            if (!p) continue; // Late terminal after cancellation/timeout cannot revive an operation.
            this.pending.delete(f.id); clearTimeout(p.timer); p.removeAbort();
            if (body?.ok === true) p.resolve(body.result);
            else p.reject(new NativeError(typeof body?.error === 'string' ? body.error : 'plugin_error'));
          } else if (f.kind === 'event') {
            this.emit('event', frame);
          } else if (f.kind === 'stopped') {
            this.cleanStop = f.clean === true;
          } else if (f.kind === 'heartbeat') this.emit('heartbeat', frame);
          else { fatal('worker_protocol_error'); return; }
        } catch { fatal('worker_protocol_error'); return; }
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME) fatal('worker_output_limit');
    });
    child.stdin.on('error', () => fatal('worker_input_closed'));
    child.once('error', () => { clearTimeout(timeout); readyReject(new NativeError('worker_spawn_failed', 'not_admitted')); });
    this.closed = new Promise(resolve => child.once('close', code => {
      clearTimeout(timeout); this.exitCode = code; this.ready = undefined;
      readyReject(new NativeError('worker_start_failed', 'not_admitted'));
      this.rejectPending('worker_exited');
      this.emit('exit', { code, clean: this.cleanStop, expected: this.closing });
      this.trace.record('native.exit',{code,clean:this.cleanStop}); this.trace.close();
      resolve();
    }));
    return promise;
  }
  private rejectPending(code: string): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.removeAbort(); p.reject(new NativeError(code)); }
    this.pending.clear();
  }
  private send(frame: Record<string, unknown>): void {
    if (!this.child?.stdin.writable || this.exitCode !== undefined) throw new NativeError('worker_unavailable', 'not_admitted');
    const bytes = JSON.stringify({ ...frame, workerEpoch: this.epoch }) + '\n';
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new NativeError('request_size_limit', 'not_admitted');
    if (this.child.stdin.writableLength + Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new NativeError('worker_backpressure', 'not_admitted');
    this.child.stdin.write(bytes);
  }
  request<T = unknown>(plugin: string, operation: string, args: unknown, signal?: AbortSignal, options: { awaitTerminalOnCancel?: boolean } = {}): Promise<T> {
    if (!this.ready || this.closing) return Promise.reject(new NativeError('worker_not_ready', 'not_admitted'));
    if (signal?.aborted) return Promise.reject(new NativeError('cancelled', 'not_admitted'));
    if (this.pending.size >= 32) return Promise.reject(new NativeError('request_limit', 'not_admitted'));
    const id = randomUUID();
    this.trace.record('native.request', {rpcId:id,plugin,operation,
      ...(args && typeof args==='object' && 'traceId' in args ? {traceId:(args as {traceId:unknown}).traceId} : {})});
    return new Promise<T>((resolve, reject) => {
      const cancel = (code: string) => {
        const p = this.pending.get(id); if (!p) return;
        this.pending.delete(id); clearTimeout(p.timer); p.removeAbort();
        try { this.send({ id: randomUUID(), method: 'cancel', targetId: id }); } catch { /* Supervisor retains cleanup responsibility. */ }
        if (code === 'request_timeout') this.emit('unresponsive');
        reject(new NativeError(code));
      };
      const onAbort = () => {
        if (!options.awaitTerminalOnCancel) return cancel('cancelled');
        // Native actions own their release barrier. Keep the RPC and its deadline
        // until that barrier returns; cancellation alone cannot release a desktop lease.
        try { this.send({ id: randomUUID(), method: 'cancel', targetId: id }); } catch { cancel('cancelled'); }
      };
      const timer = setTimeout(() => cancel('request_timeout'), this.options.requestMs ?? 25_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer, removeAbort: () => signal?.removeEventListener('abort', onAbort) });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { this.send({ id, method: 'plugin.call', plugin, operation, args }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); }
    });
  }
  stop(): Promise<{ clean: boolean; exitCode: number | null; diagnostics: string }> {
    return this.stopPromise ??= this.shutdown();
  }
  private async shutdown(): Promise<{ clean: boolean; exitCode: number | null; diagnostics: string }> {
    this.closing = true;
    if (!this.child) { this.trace.close(); return { clean: true, exitCode: 0, diagnostics: '' }; }
    if (this.exitCode === undefined) {
      try { this.send({ id: randomUUID(), method: 'shutdown' }); this.child.stdin.end(); } catch { /* exit observer still required */ }
      let forced = false;
      const timer = setTimeout(() => { forced = true; this.child?.kill(); }, this.options.shutdownMs ?? 10_000);
      let observationTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([this.closed, new Promise<never>((_, reject) => {
          observationTimer = setTimeout(() => reject(new NativeError('stop_blocked')), (this.options.shutdownMs ?? 10_000) + 5_000);
        })]);
      } finally { clearTimeout(timer); if (observationTimer) clearTimeout(observationTimer); }
      if (forced) this.cleanStop = false;
    }
    return { clean: this.cleanStop && this.exitCode === 0, exitCode: this.exitCode ?? null, diagnostics: this.diagnostics };
  }
}
