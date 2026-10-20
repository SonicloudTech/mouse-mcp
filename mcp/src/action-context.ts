/** Contracts for the opt-in hardware input backend. No SDK or OS input is opened here. */
export type HardwarePoint = { x: number; y: number };
export type HardwareButton = 'left' | 'right' | 'middle';
export type HardwareAction =
  | { kind: 'move_to'; x: number; y: number }
  | { kind: 'click_at'; x: number; y: number; button?: HardwareButton; count?: number }
  | { kind: 'scroll'; amount: number; x?: number; y?: number }
  | { kind: 'drag-path'; points: HardwarePoint[]; button?: HardwareButton };

export interface HardwarePreflight {
  phase: 'start' | 'before-press' | 'step';
  point?: HardwarePoint;
}

export interface HardwareActionOptions {
  signal?: AbortSignal;
  /** performance.now() deadline, including queue time. The backend also caps the budget at 20s. */
  deadlineMono?: number;
  budgetMs?: number;
  deviceId?: string;
  tolPx?: number;
  /** Read-only target verification; throwing rejects further business input. */
  preflight?: (check: HardwarePreflight) => void | Promise<void>;
  /** Same device epoch must still be online. False/throw leaves release unconfirmed without writing. */
  canRelease?: () => boolean;
  /** Opt-in, bounded mouse-only sender diagnostics. Does not prove hardware execution. */
  traceFrames?: boolean;
}

export interface HardwareFrameTrace {
  index: number;
  utc: string;
  /** performance.now() offset from action admission, including queue time. */
  offsetMs: number;
  callMs: number;
  phase: 'business' | 'cleanup';
  buttons: number;
  dx: number;
  dy: number;
  wheel: number;
  outcome: 'written' | 'failed' | 'unknown';
  /** null means the sender threw; the write outcome is unknown. */
  written: boolean | null;
}

export interface HardwareActionResult {
  outcome: 'completed' | 'rejected' | 'aborted' | 'timed_out' | 'indeterminate';
  transport: { attempted: number; written: number; writeFailed: number };
  cleanup: 'not_needed' | 'release_written' | 'release_confirmed' | 'release_unconfirmed';
  /** Input feedback is separate from application effect. Legacy executors may omit it. */
  verification?: {
    schemaVersion: 1;
    source: 'windows-raw-input';
    /** False when the passive monitor cannot reliably report all observed edges. */
    feedbackReliable: boolean;
    buttonIntegrity: 'confirmed' | 'failed' | 'not_required' | 'unavailable';
    pressObserved: boolean;
    releaseObserved: boolean;
    releaseStateConfirmed: boolean;
    observedPresses: number;
    observedReleases: number;
  };
  /** Even confirmed button delivery does not prove the requested application effect. */
  effectConfirmed?: false;
  final?: HardwarePoint;
  residual?: { dx: number; dy: number };
  errorCode?: string;
  note?: string;
  timing: { queueMs: number; totalMs: number };
  /** At most 256 entries. Present only when explicitly enabled. */
  frameTrace?: HardwareFrameTrace[];
}

export class HardwareActionError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Cooperative cancellation cannot interrupt a blocking native call or retract a written HID frame. */
export class HardwareActionContext {
  readonly admittedAt = performance.now();
  readonly deadline: number;

  constructor(readonly options: HardwareActionOptions, private readonly interrupted: () => boolean) {
    const budget = options.budgetMs ?? 20000;
    if (!Number.isFinite(budget) || budget <= 0 || budget > 20000
      || (options.deadlineMono !== undefined && !Number.isFinite(options.deadlineMono))) {
      throw new HardwareActionError('invalid_budget');
    }
    this.deadline = Math.min(this.admittedAt + budget, options.deadlineMono ?? Infinity);
  }

  check(): void {
    if (this.options.signal?.aborted) throw new HardwareActionError('cancelled');
    if (this.interrupted()) throw new HardwareActionError('injection_suspended');
    if (performance.now() >= this.deadline) throw new HardwareActionError('deadline_exceeded');
  }

  async sleep(ms: number): Promise<void> {
    this.check();
    const end = Math.min(performance.now() + Math.max(0, ms), this.deadline);
    while (performance.now() < end) {
      await new Promise<void>((resolve, reject) => {
        const signal = this.options.signal;
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new HardwareActionError('cancelled')); };
        const timer = setTimeout(finish, Math.min(20, Math.max(0, end - performance.now())));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      this.check();
    }
    this.check();
  }

  async preflight(check: HardwarePreflight): Promise<void> {
    this.check();
    if (!this.options.preflight) return;
    // Observe late completion without awaiting it indefinitely. The callback must be read-only.
    // Successful synchronous reads resolve in a microtask, without adding a Windows timer tick.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const signal = this.options.signal;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', poll);
        if (error) reject(error); else resolve();
      };
      const poll = () => {
        try { this.check(); }
        catch (error) { finish(error); return; }
        timer = setTimeout(poll, Math.min(20, Math.max(0, this.deadline - performance.now())));
      };
      signal?.addEventListener('abort', poll, { once: true });
      poll();
      Promise.resolve().then(() => { this.check(); return this.options.preflight!(check); }).then(
        () => finish(),
        error => finish(error instanceof HardwareActionError ? error : new HardwareActionError('target_preflight_failed')),
      );
    });
    this.check();
  }
}

export function validateHardwareAction(action: HardwareAction, tol: number): void {
  const validPoint = (p: HardwarePoint) => Number.isInteger(p.x) && Number.isInteger(p.y)
    && Math.abs(p.x) <= 1000000 && Math.abs(p.y) <= 1000000;
  if (!Number.isInteger(tol) || tol < 1 || tol > 20 || !action) throw new HardwareActionError('invalid_action');
  if (action.kind === 'drag-path') {
    if (!Array.isArray(action.points) || action.points.length < 2 || action.points.length > 64
      || !action.points.every(p => p && validPoint(p))) throw new HardwareActionError('invalid_path');
  } else if (action.kind === 'scroll') {
    if (!Number.isInteger(action.amount) || Math.abs(action.amount) > 1270
      || ((action.x !== undefined || action.y !== undefined) && !validPoint(action as HardwarePoint))) {
      throw new HardwareActionError('invalid_scroll');
    }
  } else if (action.kind === 'move_to' || action.kind === 'click_at') {
    if (!validPoint(action)) throw new HardwareActionError('invalid_target');
  } else throw new HardwareActionError('unsupported_action');
  if ('button' in action && action.button !== undefined && !['left', 'right', 'middle'].includes(action.button)) {
    throw new HardwareActionError('invalid_button');
  }
  if (action.kind === 'click_at' && action.count !== undefined
    && (!Number.isInteger(action.count) || action.count < 1 || action.count > 5)) throw new HardwareActionError('invalid_count');
}
