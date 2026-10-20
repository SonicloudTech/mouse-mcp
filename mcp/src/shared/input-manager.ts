import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputError, mouseActionSchema, validateHardwareReceipt, validateTarget } from '../hardware-contract.js';
import type { InputInFlightFlag } from './input-inflight.js';
import { archiveEvidenceFile } from './input-inflight.js';
import type { WorkerHandle } from './worker-supervisor.js';
import type { ResourceArbiter } from './resource-arbiter.js';
import { inputSequenceSchema, sequenceReceiptSchema } from './input-sequence.js';
import { ControlSession } from './control-session.js';

export interface InputPort {
  native: WorkerHandle; arbiter: ResourceArbiter; dataDir: string; enabled: boolean; inflight?: InputInFlightFlag;
  devices(): Array<{ id: string; generation: number }>;
  allowed(id: string, capability?: 'mouse_control' | 'keyboard_control'): boolean;
}
type InputScope = 'mouse' | 'keyboard';
type Uncertainty = { owner: string; reason: string; epoch: string; at: string; movementOnly?: boolean };
type ScopedUncertainty = Partial<Record<InputScope, Uncertainty>>;
/** Direct hardware actions and sequences share one desktop lease, independent of voice faults. */
export class SharedInput {
  private closed = false;
  readonly control: ControlSession;
  private uncertain: ScopedUncertainty = {};
  private nativeQuarantine = { mouse: false, keyboard: false };
  private readonly marker: string;
  private sequences = new Map<string, { abort: AbortController; done: Promise<unknown> }>();
  constructor(private readonly port: InputPort) {
    this.control = new ControlSession(port.arbiter);
    this.marker = path.join(port.dataDir, 'shared-v2', 'input-uncertain.json');
    if (fs.existsSync(this.marker)) {
      // Legacy/corrupt markers retain unknown scope as diagnostic evidence.
      // They do not deny new explicit commands under a task reservation.
      const fallback = { owner: '', reason: 'previous_input_uncertain', epoch: '', at: new Date().toISOString() };
      this.uncertain = { mouse: { ...fallback }, keyboard: { ...fallback } };
      try {
        const saved = JSON.parse(fs.readFileSync(this.marker, 'utf8'));
        if (saved.schemaVersion === 2 && saved.scopes && typeof saved.scopes === 'object' && !Array.isArray(saved.scopes)) {
          const entries = Object.entries(saved.scopes);
          if (entries.length && entries.every(([scope, value]) => ['mouse', 'keyboard'].includes(scope)
            && value && typeof value === 'object' && !Array.isArray(value)
            && ['owner', 'reason', 'epoch', 'at'].every(key => typeof (value as Record<string, unknown>)[key] === 'string')
            && !!(value as Uncertainty).reason && Number.isFinite(Date.parse((value as Uncertainty).at)))) {
            this.uncertain = Object.fromEntries(entries.map(([scope, value]) => [scope, { ...(value as Uncertainty), owner: '' }]));
          }
        }
      } catch { /* Keep the unknown diagnostic scope; archive original bytes on next action. */ }
    }
  }
  get blocked(): boolean { return false; }
  get hasUncertainty(): boolean { const s = this.uncertainScopes; return s.mouse || s.keyboard; }
  get blockedScopes(): { mouse: boolean; keyboard: boolean } {
    return { mouse: false, keyboard: false };
  }
  get uncertainScopes(): { mouse: boolean; keyboard: boolean } {
    return { mouse: !!this.uncertain.mouse || this.nativeQuarantine.mouse, keyboard: !!this.uncertain.keyboard || this.nativeQuarantine.keyboard };
  }
  /** Native diagnostics are distinct from task admission and current physical state. */
  applyNativeQuarantine(value: unknown): void {
    if (value === undefined) return; // Older native hosts have no scoped quarantine contract.
    const q = value as { mouse?: unknown; keyboard?: unknown; persistenceHealthy?: unknown } | null;
    this.nativeQuarantine = q && typeof q.mouse === 'boolean' && typeof q.keyboard === 'boolean' && q.persistenceHealthy === true
      ? { mouse: q.mouse, keyboard: q.keyboard } : { mouse: true, keyboard: true };
  }
  beginControl(owner: string, taskId: string) {
    if (this.closed || !this.port.enabled) throw new InputError('input_disabled', '共享硬件输入未启用');
    return this.control.begin(owner, taskId);
  }
  async endControl(owner: string, id: string): Promise<unknown> {
    this.control.require(owner, id);
    await this.release(owner);
    return this.control.status(owner);
  }
  get canInput(): boolean { return !this.closed && this.port.enabled && this.port.devices().some(d => Number.isSafeInteger(d.generation) && d.generation > 0 && this.port.allowed(d.id)); }
  get canSequence(): boolean { return !this.closed && this.port.enabled && this.port.devices().some(d => d.generation > 0 && (this.port.allowed(d.id, 'mouse_control') || this.port.allowed(d.id, 'keyboard_control'))); }
  async runSequence(owner: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const a = inputSequenceSchema.parse(args); validateTarget(a);
    const scopes = [...new Set(a.frames.map(frame => frame.kind))];
    // Keyboard frames or any buttons!=0 mouse frame can leave held input behind.
    const movementOnly = a.frames.every(frame => frame.kind === 'mouse' && frame.buttons === 0);
    if (a.frames.reduce((n, f) => n + f.delay_ms, 0) >= a.timeout_ms) throw new Error('sequence_budget_too_small');
    return this.execute(owner, a.control_id, a.device_id, scopes, movementOnly, a.timeout_ms, signal, async (device, abort) =>
      sequenceReceiptSchema.parse(await this.port.native.request('umouse', 'input.sequence', {
        deviceId: device.id, deviceGeneration: device.generation, budgetMs: a.timeout_ms, traceId: a.client_request_id,
        ...(a.pid === undefined ? {} : { window: { pid: a.pid, windowId: a.window_id } }),
        frames: a.frames.map(({ delay_ms, ...f }) => ({ ...f, delayMs: delay_ms })),
      }, abort, { awaitTerminalOnCancel: true })));
  }
  async runMouse(owner: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const a = mouseActionSchema.parse(args); validateTarget(a);
    const movementOnly = a.action.kind === 'move' || a.action.kind === 'scroll';
    return this.execute(owner, a.control_id, a.device_id, ['mouse'], movementOnly, a.timeout_ms, signal, async (device, abort) =>
      validateHardwareReceipt(await this.port.native.request('umouse', 'mouse.action', {
        ...a.action, deviceId: device.id, deviceGeneration: device.generation, budgetMs: a.timeout_ms, traceId: a.client_request_id,
        ...(a.pid === undefined ? {} : { window: { pid: a.pid, windowId: a.window_id } }),
      }, abort, { awaitTerminalOnCancel: true }), a.action, true));
  }
  private async execute(owner: string, controlId: string | undefined, deviceId: string, scopes: InputScope[], movementOnly: boolean, timeoutMs: number, signal: AbortSignal,
    action: (device: { id: string; generation: number }, signal: AbortSignal) => Promise<{ outcome: string; cleanup: string; transport: { attempted: number; writeFailed: number } }>): Promise<unknown> {
    if (this.closed || !this.port.enabled) throw new InputError('input_disabled', '共享硬件输入未启用');
    this.control.require(owner, controlId);
    if (signal.aborted) throw new InputError('cancelled', '已取消');
    const device = this.port.devices().find(d => d.id === deviceId && Number.isSafeInteger(d.generation) && d.generation > 0);
    if (!device) throw new Error('device_offline');
    for (const scope of scopes) if (!this.port.allowed(device.id, scope === 'mouse' ? 'mouse_control' : 'keyboard_control')) throw new Error('capability_unavailable');
    const lease = this.port.arbiter.acquire(owner, 'desktop');
    const abort = new AbortController(), cancel = () => abort.abort();
    const timer = setTimeout(cancel, timeoutMs); timer.unref();
    signal.addEventListener('abort', cancel, { once: true });
    const done = Promise.resolve().then(async () => {
      if (abort.signal.aborted || this.closed) throw new Error('cancelled');
      this.control.require(owner, controlId);
      // Revalidate after the admission microtask, before intent is made durable.
      if (!this.port.devices().some(d => d.id === device.id && d.generation === device.generation)) throw new Error('device_changed');
      this.journal(owner, 'input_attempting', scopes, movementOnly);
      try {
        this.port.inflight?.begin(movementOnly);
        const r = await action(device, abort.signal);
        if (r.outcome === 'indeterminate' || r.cleanup === 'release_unconfirmed' || (r.outcome !== 'completed' && r.transport.attempted > 0)) this.block(owner, 'native_input_uncertain', scopes, movementOnly);
        else { for (const scope of scopes) { delete this.uncertain[scope]; this.nativeQuarantine[scope] = false; } this.writeJournal(this.uncertain); }
        // A terminal failure is not still in flight. Its diagnostic stays in the journal.
        this.port.inflight?.end(true);
        return { ...r, movementOnly, ...(movementOnly ? { movementNote: 'movement-only batch: no button or keyboard hold possible; cursor reading is authoritative' } : {}), retryAutomatic: false };
      } catch (e) { this.block(owner, 'native_input_rpc_unknown', scopes, movementOnly); throw e; }
    }).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', cancel); this.port.arbiter.release(lease); this.sequences.delete(owner); });
    this.sequences.set(owner, { abort, done });
    return done;
  }
  private journal(owner: string, reason: string, scopes: InputScope[], movementOnly: boolean): void {
    // Preserve previous (including legacy/corrupt) evidence before a new explicit action.
    if (fs.existsSync(this.marker)) fs.copyFileSync(this.marker, `${this.marker}.history-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
    const next = { ...this.uncertain };
    for (const scope of scopes) next[scope] = { owner, reason, epoch: this.port.native.epoch, at: new Date().toISOString(), movementOnly };
    this.writeJournal(next);
  }
  private writeJournal(scopes: ScopedUncertainty): void {
    const entries = Object.values(scopes);
    if (!entries.length) { fs.rmSync(this.marker, { force: true }); return; }
    fs.mkdirSync(path.dirname(this.marker), { recursive: true });
    const temporary = `${this.marker}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 2, ...entries[entries.length - 1], scopes })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.marker);
    } finally { try { fs.unlinkSync(temporary); } catch { /* Already renamed or never created. */ } }
  }
  private block(owner: string, reason: string, scopes: InputScope[], movementOnly: boolean): void {
    for (const scope of scopes) this.uncertain[scope] = { owner, reason, epoch: this.port.native.epoch, at: new Date().toISOString(), movementOnly };
    try { this.writeJournal(this.uncertain); }
    catch { for (const scope of scopes) this.uncertain[scope]!.reason = 'journal_write_failed'; }
  }
  /** 恢复专用：input.cleanup 证实全部按键抬起后归档诊断标记（保留字节）。 */
  acknowledgeRecovered(): void {
    archiveEvidenceFile(this.marker);
    this.uncertain = {};
    this.nativeQuarantine = { mouse: false, keyboard: false };
  }
  async release(owner: string): Promise<void> {
    await this.control.release(owner, async () => {
      const sequence = this.sequences.get(owner); sequence?.abort.abort();
      await sequence?.done.catch(() => {});
    });
  }
  async stop(): Promise<void> {
    this.closed = true;
    const sequences = [...this.sequences.values()]; for (const s of sequences) s.abort.abort();
    await Promise.all(sequences.map(s => s.done.catch(() => {})));
    if (this.control.owner) await this.release(this.control.owner);
  }
}
