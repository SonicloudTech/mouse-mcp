/**
 * idle-exit.ts —— 连接驱动的空闲生命周期（两段式）
 *
 * N（已完成 MCP 握手的连接数）归零后按同一条时间线计时：
 *   1) 持续 workerGraceMs → retireWorker：停高层 runtime 并回收 SDK worker
 *      （设备释放、DLL 卸载）。workerGraceMs=0 表示立即回收（旧语义）。
 *      宽限期内的重连直接取消时间线，worker 存活，避免客户端重启造成
 *      DLL 重载与设备反复断连。
 *   2) 持续 exitMs → readyToExit 通过后 exit：daemon 自退（管道消失），
 *      下一个客户端 connector 以 ENOENT 自动重新拉起。exitMs=0 表示常驻
 *      （旧语义）。worker 尚在回收时先按 recheckMs 复查，不强行退出。
 *
 * 维护路径（quiesce/close）不走宽限：daemon 显式 cancel 后立即收尾。
 * readyToExit 必须由调用方兜底校验（维护态、未完成握手的连接、worker
 * 进程仍存活时一律不退）。
 */
export interface IdleConfig { workerGraceMs: number; exitMs: number; recheckMs?: number }

export class IdleLifecycle {
  private armed = false;
  private workerTimer?: NodeJS.Timeout;
  private exitTimer?: NodeJS.Timeout;
  private recheckTimer?: NodeJS.Timeout;
  private readonly recheckMs: number;
  constructor(private readonly config: IdleConfig,
    private readonly hooks: {
      retireWorker(): void;
      readyToExit(): boolean;
      exit(): void;
      onTransition?(stage: string): void;
    }) {
    const { workerGraceMs, exitMs } = config;
    if (!Number.isInteger(workerGraceMs) || workerGraceMs < 0 || !Number.isInteger(exitMs) || exitMs < 0
      || (exitMs > 0 && workerGraceMs > 0 && exitMs <= workerGraceMs)) throw new Error('invalid_idle_config');
    this.recheckMs = Math.max(1, config.recheckMs ?? 15_000);
  }
  get active(): boolean { return this.armed; }
  /** 连接数变化：n>0 取消全部计时；n=0 启动（不重置已在计时的）时间线。 */
  update(n: number): void {
    if (n > 0) { this.cancel(); return; }
    if (this.armed) return;
    this.armed = true;
    this.hooks.onTransition?.('idle.arm');
    this.workerTimer = workerGraceMsZero(this.config) ? undefined
      : setTimeout(() => { this.workerTimer = undefined; this.retire(); }, this.config.workerGraceMs);
    if (workerGraceMsZero(this.config)) this.retire();
    if (this.config.exitMs > 0) this.exitTimer = setTimeout(() => { this.exitTimer = undefined; this.tryExit(); }, this.config.exitMs);
  }
  private retire(): void {
    if (!this.armed) return;
    this.hooks.onTransition?.('idle.workerRetire');
    this.hooks.retireWorker();
  }
  private tryExit(): void {
    if (!this.armed) return;
    if (!this.hooks.readyToExit()) { this.recheckTimer = setTimeout(() => { this.recheckTimer = undefined; this.tryExit(); }, this.recheckMs); return; }
    this.armed = false; // exit is terminal; the daemon closes right after
    this.hooks.onTransition?.('idle.exit');
    this.hooks.exit();
  }
  /** 维护/停机路径：取消空闲时间线（worker 由调用方立即回收）。 */
  cancel(): void {
    this.armed = false;
    for (const timer of [this.workerTimer, this.exitTimer, this.recheckTimer]) if (timer) clearTimeout(timer);
    this.workerTimer = this.exitTimer = this.recheckTimer = undefined;
  }
}
function workerGraceMsZero(config: IdleConfig): boolean { return config.workerGraceMs === 0; }
