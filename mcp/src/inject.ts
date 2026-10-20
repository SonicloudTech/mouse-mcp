/*
 * inject.ts —— 固件反向控制编排层（宿主业务逻辑）
 *
 * SDK 提供单帧原语（um_inject_mouse/um_inject_keyboard，v0.4.21）：12 字节
 * 动作帧由 SDK 组装、滚动序号内部循环分配、report_id 按通道前置。本层把
 * agent 语义翻译为帧序列：大位移拆帧（int8 步进）、点击的按下/抬起编排、
 * 按住状态跟踪（拖拽）、帧间节流、stuck-button 空闲复位兜底。
 *
 * 协议语义约束（sdk-bridge 注入注释的宿主责任）：
 *  - 位移帧失败/超时不重发（重发位移叠加）：连续失败即中止本批次并回报
 *  - 按键/修饰键状态型（置位=按下）：press 置位、release 清零；空闲 3s 与
 *    进程退出序列兜底发全零复位帧
 */

import { HardwareActionContext, HardwareActionError, validateHardwareAction } from './action-context.js';
import type { HardwareAction, HardwareActionOptions, HardwareActionResult, HardwareFrameTrace, HardwarePoint } from './action-context.js';
export type { HardwareAction, HardwareActionOptions, HardwareActionResult, HardwareFrameTrace } from './action-context.js';

/** 单帧发送原语（SdkBridge 动态委托，reconfigure 重建 SDK 实例后仍指向当前实例） */
export interface InjectSender {
  mouse(buttons: number, dx: number, dy: number, wheel: number, deviceId?: string): number;
  keyboard(modifiers: number, usageIds: number[], deviceId?: string): number;
}

/** 光标位置回读（闭环绝对定位观测端；null = 平台不支持） */
export type CursorReaderFn = () => { x: number; y: number } | null;

export interface InjectConfig {
  frameMs: number;   // 位移连帧间隔（60Hz 起步，真机联调校准）
  clickMs: number;   // 点击按下→抬起 / 键按下→释放间隔
  feedbackTimeoutMs?: number; // 单帧光标反馈等待上限，默认 5s（测试可缩短）
  keyboardEnabled?: boolean;  // 键盘注入（0xF1）开关；库层默认启用（向后兼容），
                             // MCP 层按配置传入——当前设备未验证 0xF1 指令有效，默认关闭
}

export type ButtonName = 'left' | 'right' | 'middle';

export const BUTTON_BIT: Record<ButtonName, number> = { left: 1, right: 2, middle: 4 };

/** 修饰键名 → HID modifier byte（bit0=LCtrl bit1=LShift bit2=LAlt bit3=LGUI） */
export const MODIFIER_BIT: Record<string, number> = {
  ctrl: 0x01, shift: 0x02, alt: 0x04, gui: 0x08,
  win: 0x08, cmd: 0x08, meta: 0x08,
};

const IDLE_RESET_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 大位移 → int8 步进序列：等比拆分，各分量 |v|≤127，序列和精确等于目标 */
export function splitMove(dx: number, dy: number): Array<{ dx: number; dy: number }> {
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new Error('dx/dy 必须为整数');
  if (dx === 0 && dy === 0) return [];
  const steps = Math.max(Math.ceil(Math.abs(dx) / 127), Math.ceil(Math.abs(dy) / 127));
  const out: Array<{ dx: number; dy: number }> = [];
  let prevX = 0;
  let prevY = 0;
  for (let i = 1; i <= steps; i++) {
    const tx = Math.round((dx * i) / steps);
    const ty = Math.round((dy * i) / steps);
    const sx = Math.max(-127, Math.min(127, tx - prevX));
    const sy = Math.max(-127, Math.min(127, ty - prevY));
    prevX += sx;
    prevY += sy;
    out.push({ dx: sx, dy: sy });
  }
  return out;
}

/** 标量（滚轮/大位移单轴）→ int8 分量序列，总和精确等于目标 */
export function splitScalar(v: number): number[] {
  if (!Number.isInteger(v)) throw new Error('数值必须为整数');
  if (v === 0) return [];
  const sign = v < 0 ? -1 : 1;
  const n = Math.ceil(Math.abs(v) / 127);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? v - sign * 127 * (n - 1) : sign * 127));
}

export function parseModifiers(mods: Array<string | number>): number {
  let bits = 0;
  for (const m of mods ?? []) {
    if (typeof m === 'number') {
      if (!Number.isInteger(m) || m < 0 || m > 0xff) throw new Error(`修饰键数值越界: ${m}`);
      bits |= m;
      continue;
    }
    const bit = MODIFIER_BIT[String(m).toLowerCase()];
    if (typeof bit !== 'number') throw new Error(`未知修饰键: ${m}（可用 ctrl/shift/alt/gui）`);
    bits |= bit;
  }
  return bits & 0xff;
}

export interface InjectOpResult {
  frames: number;   // 本操作总帧数
  sent: number;     // 写入通道成功帧数
  failed: number;   // 写入失败帧数（位移批次失败即中止）
  aborted?: boolean;
  note?: string;
}

export interface MoveToResult {
  ok: boolean;
  iterations: number;
  frames: number;
  sent: number;
  failed: number;
  from: { x: number; y: number };
  final: { x: number; y: number };
  residual: { dx: number; dy: number };
  note?: string;
}

export class InjectController {
  readonly stats = { mouseSent: 0, mouseFailed: 0, keySent: 0, keyFailed: 0, idleResets: 0 };

  private heldButtons = 0;
  private heldDeviceId: string | undefined;
  private heldReleaseGuard: (() => boolean) | undefined;
  private keyStuck = false;            // tap 的释放帧失败 → 空闲/退出兜底补发
  private idleTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();  // 帧序列串行化（防 move/click 交错）
  private suspended = false;
  private hardwareActionActive = false;

  async suspend(): Promise<void> {
    this.suspended = true;
    await this.chain;
    this.releaseAllSync();
  }

  resume(): void { this.suspended = false; }

  /** Read-only queue barrier for a caller that already excludes new legacy input. */
  async waitUntilIdle(): Promise<void> { await this.chain; }

  constructor(
    private readonly sender: InjectSender,
    private readonly cfg: InjectConfig,
    private readonly readCursor?: CursorReaderFn
  ) {}

  /** 空闲复位状态快照（status 暴露用） */
  state(): Record<string, unknown> {
    return {
      heldButtons: this.heldButtons,
      heldDeviceId: this.heldDeviceId,
      keyStuck: this.keyStuck,
      frameMs: this.cfg.frameMs,
      clickMs: this.cfg.clickMs,
    };
  }

  /** Opt-in hardware input backend: one bounded action in the existing hardware queue, never a software fallback.
   * Effects remain unconfirmed by the transport. A failed action after any write is indeterminate.
   * The caller must block further business input until that uncertainty is explicitly resolved. */
  async runHardwareAction(action: HardwareAction, options: HardwareActionOptions = {}): Promise<HardwareActionResult> {
    const admittedAt = performance.now();
    const result: HardwareActionResult = {
      outcome: 'completed', transport: { attempted: 0, written: 0, writeFailed: 0 },
      cleanup: 'not_needed', timing: { queueMs: 0, totalMs: 0 },
    };
    const traceEnabled = options.traceFrames === true;
    if (traceEnabled) result.frameTrace = [];
    const traceSend = (phase: HardwareFrameTrace['phase'], buttons: number, dx: number, dy: number, wheel: number, send: () => number) => {
      let entry: HardwareFrameTrace | undefined;
      let before = 0;
      try {
        if (result.frameTrace && result.frameTrace.length < 256) {
          before = performance.now();
          entry = { index: result.frameTrace.length + 1, utc: new Date().toISOString(), offsetMs: before - admittedAt,
            callMs: 0, phase, buttons, dx, dy, wheel, outcome: 'unknown', written: null };
        }
      } catch { /* Diagnostics cannot prevent or retry the sender call. */ }
      try {
        const rc = send();
        if (entry) { entry.written = rc === 1; entry.outcome = rc === 1 ? 'written' : 'failed'; }
        return rc;
      } finally {
        // A thrown sender keeps outcome=unknown. Never replace its exception.
        if (entry) try { entry.callMs = performance.now() - before; result.frameTrace!.push(entry); } catch { /* diagnostic-only */ }
      }
    };
    let context: HardwareActionContext;
    let request: HardwareAction;
    const tol = options.tolPx ?? 3;
    const finishError = (error: unknown) => {
      const code = error instanceof HardwareActionError ? error.code : 'hardware_action_failed';
      result.errorCode = code;
      result.outcome = result.transport.written > 0 || code === 'write_outcome_unknown' || result.cleanup === 'release_unconfirmed'
        ? 'indeterminate' : code === 'cancelled' || code === 'injection_suspended' ? 'aborted'
        : code === 'deadline_exceeded' ? 'timed_out' : 'rejected';
      result.note = result.outcome === 'indeterminate'
        ? 'Written input may still execute. Do not automatically replay the action.' : code;
    };
    try {
      validateHardwareAction(action, tol);
      request = structuredClone(action);
      context = new HardwareActionContext({ ...options }, () => this.suspended);
      context.check();
    } catch (error) {
      finishError(error);
      result.timing.totalMs = performance.now() - admittedAt;
      return result;
    }
    try {
      await this.enqueue(async () => {
        result.timing.queueMs = performance.now() - admittedAt;
        context.check();
        if (this.heldButtons !== 0 || this.keyStuck) throw new HardwareActionError('buttons_already_held');
        this.dispose();
        this.hardwareActionActive = true;
        let releaseNeeded = false;
        const deviceId = context.options.deviceId;
        const write = (buttons: number, dx: number, dy: number, wheel: number) => {
          context.check();
          // Bound work even when all coordinates keep changing. Leave room for mandatory release.
          if (result.transport.attempted >= 255) throw new HardwareActionError('frame_budget_exceeded');
          result.transport.attempted++;
          let ok: boolean;
          try { ok = this.sendMouse(buttons, dx, dy, wheel, deviceId,
            traceEnabled ? send => traceSend('business', buttons, dx, dy, wheel, send) : undefined); }
          catch {
            this.stats.mouseFailed++;
            result.transport.writeFailed++;
            throw new HardwareActionError('write_outcome_unknown');
          }
          if (!ok) { result.transport.writeFailed++; throw new HardwareActionError('write_failed'); }
          result.transport.written++;
        };
        const release = () => {
          if (!releaseNeeded) return;
          releaseNeeded = false; // A failed cleanup is reported, never immediately repeated here.
          if (!this.canReleaseHeld()) {
            result.cleanup = 'release_unconfirmed';
            return;
          }
          result.transport.attempted++;
          let ok = false;
          try {
            // Already own the inject queue. Suspension/cancellation blocks business input but not this cleanup.
            const send = () => this.sender.mouse(0, 0, 0, 0, deviceId);
            ok = (traceEnabled ? traceSend('cleanup', 0, 0, 0, 0, send) : send()) === 1;
          } catch { /* disconnected or unknown native outcome */ }
          if (ok) {
            this.stats.mouseSent++;
            result.transport.written++;
            this.heldButtons = 0;
            this.heldDeviceId = deviceId;
            this.heldReleaseGuard = undefined;
            result.cleanup = 'release_written';
          } else {
            this.stats.mouseFailed++;
            result.transport.writeFailed++;
            result.cleanup = 'release_unconfirmed';
          }
        };
        const read = () => {
          context.check();
          const p = this.readCursor?.();
          if (!p) throw new HardwareActionError('cursor_unavailable');
          return p;
        };
        const position = async (target: HardwarePoint) => {
          let cur = read();
          for (let i = 0; i < 15; i++) {
            context.check();
            // A single segment can need many feedback iterations; target ownership must survive each write.
            await context.preflight({ phase: 'step', point: target });
            cur = read(); // Do not compute displacement from the sample taken before an asynchronous guard.
            result.final = cur;
            result.residual = { dx: target.x - cur.x, dy: target.y - cur.y };
            if (Math.abs(result.residual.dx) <= tol && Math.abs(result.residual.dy) <= tol) return;
            const ux = Math.max(-127, Math.min(127, Math.round(result.residual.dx * 0.9)));
            const uy = Math.max(-127, Math.min(127, Math.round(result.residual.dy * 0.9)));
            const before = cur;
            write(this.heldButtons, ux, uy, 0);
            const feedbackEnd = Math.min(context.deadline, performance.now() + (this.cfg.feedbackTimeoutMs ?? 5000));
            await context.sleep(Math.min(Math.max(this.cfg.frameMs, 30), Math.max(0, feedbackEnd - performance.now())));
            for (;;) {
              cur = read();
              result.final = cur;
              result.residual = { dx: target.x - cur.x, dy: target.y - cur.y };
              if (cur.x !== before.x || cur.y !== before.y) break;
              if (performance.now() >= feedbackEnd) throw new HardwareActionError('feedback_timeout');
              await context.sleep(Math.min(20, Math.max(0, feedbackEnd - performance.now())));
            }
          }
          if (Math.abs(target.x - cur.x) > tol || Math.abs(target.y - cur.y) > tol) {
            throw new HardwareActionError('position_not_converged');
          }
        };
        const press = (button: ButtonName) => {
          releaseNeeded = true;
          // Track a possibly written down even if the native sender subsequently throws.
          this.heldButtons = BUTTON_BIT[button];
          this.heldDeviceId = deviceId;
          this.heldReleaseGuard = context.options.canRelease;
          write(this.heldButtons, 0, 0, 0);
        };
        let actionError: unknown;
        try {
          const startPoint = request.kind === 'drag-path' ? request.points[0]
            : request.kind !== 'scroll' || request.x !== undefined ? { x: request.x!, y: request.y! } : undefined;
          await context.preflight({ phase: 'start', point: startPoint });
          if (startPoint) await position(startPoint);
          if (request.kind === 'click_at') {
            for (let i = 0; i < (request.count ?? 1); i++) {
              if (i > 0) await context.sleep(this.cfg.clickMs * 2);
              await context.preflight({ phase: 'before-press', point: startPoint });
              const cur = read();
              if (Math.abs(cur.x - request.x) > tol || Math.abs(cur.y - request.y) > tol) throw new HardwareActionError('pointer_changed');
              press(request.button ?? 'left');
              await context.sleep(this.cfg.clickMs);
              release();
              if (result.cleanup === 'release_unconfirmed') throw new HardwareActionError('release_unconfirmed');
            }
          } else if (request.kind === 'scroll') {
            await context.preflight({ phase: 'before-press', point: startPoint });
            if (startPoint) {
              const cur = read();
              if (Math.abs(cur.x - startPoint.x) > tol || Math.abs(cur.y - startPoint.y) > tol) throw new HardwareActionError('pointer_changed');
            }
            for (const amount of splitScalar(request.amount)) {
              await context.preflight({ phase: 'step', point: startPoint });
              write(0, 0, 0, amount);
              await context.sleep(this.cfg.frameMs);
            }
          } else if (request.kind === 'drag-path') {
            await context.preflight({ phase: 'before-press', point: startPoint });
            const cur = read();
            if (Math.abs(cur.x - startPoint!.x) > tol || Math.abs(cur.y - startPoint!.y) > tol) throw new HardwareActionError('pointer_changed');
            press(request.button ?? 'left');
            // The press is a separate device frame; pace the first movement too.
            // Cancellation/deadline still jump to the immediate finally release.
            await context.sleep(this.cfg.frameMs);
            for (const point of request.points.slice(1)) {
              await position(point);
            }
          }
          context.check();
        } catch (error) { actionError = error; }
        finally {
          release();
          this.hardwareActionActive = false;
          if ((this.heldButtons !== 0 || this.keyStuck) && this.canReleaseHeld()) this.armIdleReset(deviceId);
        }
        if (result.cleanup === 'release_unconfirmed') throw new HardwareActionError('release_unconfirmed');
        if (actionError !== undefined) throw actionError;
      });
    } catch (error) { finishError(error); }
    result.timing.totalMs = performance.now() - admittedAt;
    return result;
  }

  /** 相对位移（像素≈1 单位，换算待真机标定）。大位移自动拆帧连发。 */
  async move(dx: number, dy: number, deviceId?: string): Promise<InjectOpResult> {
    return this.enqueue(async () => {
      const steps = splitMove(dx, dy);
      let sent = 0;
      for (const s of steps) {
        if (this.sendMouse(this.heldButtons, s.dx, s.dy, 0, deviceId)) {
          sent++;
        } else {
          // 位移帧失败不重发（叠加风险）：中止本批次，后续帧由下一次操作补偿
          return { frames: steps.length, sent, failed: steps.length - sent, aborted: true };
        }
        await sleep(this.cfg.frameMs);
      }
      return { frames: steps.length, sent, failed: 0 };
    });
  }

  /** 滚轮：amount 为格数（正=向上），|amount|>127 自动拆帧。 */
  async scroll(amount: number, deviceId?: string): Promise<InjectOpResult> {
    return this.enqueue(async () => {
      const chunks = splitScalar(amount);
      let sent = 0;
      for (const w of chunks) {
        if (this.sendMouse(this.heldButtons, 0, 0, w, deviceId)) sent++;
        else return { frames: chunks.length, sent, failed: chunks.length - sent, aborted: true };
        await sleep(this.cfg.frameMs);
      }
      return { frames: chunks.length, sent, failed: 0 };
    });
  }

  /** 点击（按下→抬起）。count>1 为连击（双击传 2）。 */
  async click(button: ButtonName, count = 1, deviceId?: string): Promise<InjectOpResult> {
    return this.enqueue(async () => {
      const bit = BUTTON_BIT[button];
      if (!bit) throw new Error(`未知按键: ${button}`);
      const n = Math.max(1, Math.min(5, count));
      let frames = 0;
      let sent = 0;
      let failed = 0;
      for (let i = 0; i < n; i++) {
        if (i > 0) await sleep(this.cfg.clickMs * 2);
        const before = this.heldButtons;
        frames += 2;
        if (this.sendMouse(this.heldButtons | bit, 0, 0, 0, deviceId)) sent++;
        else { failed++; break; }   // down 失败：不发 up（未按下）
        await sleep(this.cfg.clickMs);
        if (this.sendMouse(before, 0, 0, 0, deviceId)) sent++;
        else { failed++; break; }   // up 失败：按键可能卡住 → 标记补发
        this.armIdleReset(deviceId);
      }
      const r: InjectOpResult = { frames, sent, failed };
      if (failed > 0) {
        this.armIdleReset(deviceId);
        r.note = '释放帧未确认写入，已安排空闲复位兜底';
      }
      return r;
    });
  }

  /** 按住/松开（拖拽：press → move… → release）。对已按下的按键幂等。 */
  async button(action: 'press' | 'release', button: ButtonName, deviceId?: string): Promise<InjectOpResult> {
    return this.enqueue(async () => {
      const bit = BUTTON_BIT[button];
      if (!bit) throw new Error(`未知按键: ${button}`);
      const next = action === 'press' ? this.heldButtons | bit : this.heldButtons & ~bit;
      if (next === this.heldButtons && !(action === 'press' && this.heldDeviceId !== deviceId)) {
        return { frames: 0, sent: 0, failed: 0, note: `按键已处于目标状态（${action}）` };
      }
      const ok = this.sendMouse(next, 0, 0, 0, deviceId);
      this.heldButtons = ok ? next : action === 'press' ? this.heldButtons | bit : this.heldButtons;
      if (ok && this.heldButtons === 0) this.disarmIdleReset();
      else this.armIdleReset(deviceId);
      return { frames: 1, sent: ok ? 1 : 0, failed: ok ? 0 : 1 };
    });
  }

  /** 原子拖拽：单次调用内完成 按下 → paced 移动 → 松开。
   *  agent 分轮调 press/move/release 会被空闲看门狗打断（实测：轮次间隔含
   *  推理耗时，超 3s 即自动释放），拖拽类操作必须经本原语一次发出。 */
  async drag(button: ButtonName, dx: number, dy: number, deviceId?: string): Promise<InjectOpResult> {
    return this.enqueue(async () => {
      const bit = BUTTON_BIT[button];
      if (!bit) throw new Error(`未知按键: ${button}`);
      const steps = splitMove(dx, dy);
      let frames = 1 + steps.length;          // press + 移动帧（release 结尾再计）
      let sent = 0;
      const down = this.heldButtons | bit;
      if (!this.sendMouse(down, 0, 0, 0, deviceId)) {
        return { frames, sent: 0, failed: frames, aborted: true, note: '按下帧未写入，未移动' };
      }
      sent++;
      let aborted = false;
      // Keep the initial press and first movement out of the same burst.
      // Recheck a monotonic deadline because host timers can wake slightly early.
      const firstMoveAt = performance.now() + this.cfg.frameMs;
      while (steps.length && !this.suspended && performance.now() < firstMoveAt) {
        await sleep(Math.min(20, Math.max(1, firstMoveAt - performance.now())));
      }
      for (const s of steps) {
        if (!this.sendMouse(down, s.dx, s.dy, 0, deviceId)) { aborted = true; break; }
        sent++;
        await sleep(this.cfg.frameMs);
      }
      // 无论中途成败都尝试抬起（up 未确认时交给空闲兜底补发）
      frames++;
      const upOk = this.sendMouse(this.heldButtons & ~bit, 0, 0, 0, deviceId);
      if (upOk) {
        sent++;
        this.heldButtons &= ~bit;
        if (this.heldButtons === 0 && !this.keyStuck) this.disarmIdleReset();
      } else {
        this.armIdleReset(deviceId);
      }
      const r: InjectOpResult = { frames, sent, failed: frames - sent, aborted };
      if (aborted) r.note = '移动批次存在失败帧（位移帧不重发），已抬起按键';
      else if (!upOk) r.note = '抬起帧未确认写入，已安排空闲复位兜底';
      return r;
    });
  }

  /** 键盘组合键点按（按下 → 释放 全零帧）。keys 为 HID Usage ID（如 0x04='a'）。 */
  async keyTap(mods: Array<string | number>, keys: number[], deviceId?: string): Promise<InjectOpResult> {
    if (this.cfg.keyboardEnabled === false) {
      throw new Error('键盘注入已禁用：当前设备尚未验证 0xF1 键盘注入可用（写入成功但设备不执行）；固件支持后设 UMSDK_INJECT_KEYBOARD=1 开启');
    }
    return this.enqueue(async () => {
      const bits = parseModifiers(mods);
      const ids = (keys ?? []).slice(0, 6);
      for (const v of ids) {
        if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`Usage ID 非法: ${v}`);
      }
      const pressOk = this.sendKeyboard(bits, ids, deviceId);
      if (!pressOk) return { frames: 2, sent: 0, failed: 2 };
      await sleep(this.cfg.clickMs);
      const relOk = this.sendKeyboard(0, [], deviceId);
      if (!relOk) {
        this.keyStuck = true;      // 释放帧未确认：空闲/退出兜底补发全零帧
        this.armIdleReset(deviceId);
        return { frames: 2, sent: 1, failed: 1, note: '释放帧未确认写入，已安排兜底复位' };
      }
      return { frames: 2, sent: 2, failed: 0 };
    });
  }

  /** 全零复位帧（按键/修饰键全释放）。空闲兜底与退出序列调用；亦可 agent 显式调用。
   *  能确认原设备代际时发送鼠标/键盘全零帧；硬件输入遗留持键的代际未知则保留状态并拒绝误发。
   *  键盘注入禁用时跳过键盘帧（当前设备未验证 0xF1 有效）。 */
  async releaseAll(deviceId?: string): Promise<InjectOpResult> {
    return this.enqueue(async () => {
      if (!this.canReleaseHeld()) {
        return { frames: 1, sent: 0, failed: 1, note: 'Original device epoch is unavailable; release remains unconfirmed' };
      }
      const target = deviceId ?? this.heldDeviceId;
      // 受限清理：只释放本进程此前已按下的通道——无按键持有
      // （heldButtons==0 且无 keyStuck）时不向设备发任何零帧（仅语音设备也
      // 不会被塞鼠标/键盘复位帧），清空本地状态即幂等完成。
      const wantMouse = this.heldButtons !== 0;
      const wantKb = this.keyStuck && this.cfg.keyboardEnabled !== false;
      if (!wantMouse && !wantKb) {
        this.disarmIdleReset();
        return { frames: 0, sent: 0, failed: 0, note: 'no-held-channels' };
      }
      const frames = (wantMouse ? 1 : 0) + (wantKb ? 1 : 0);
      let sent = 0;
      if (wantMouse && this.sendMouse(0, 0, 0, 0, target)) {
        sent++;
        this.heldButtons = 0;
      }
      if (wantKb && this.sendKeyboard(0, [], target)) {
        sent++;
        this.keyStuck = false;
      }
      this.disarmIdleReset();
      if (this.heldButtons !== 0 || this.keyStuck) this.armIdleReset(target);
      return { frames, sent, failed: frames - sent };
    });
  }

  /** 退出序列用同步复位（bridge.shutdownCore 在摘回调前调用；失败仅计数） */
  releaseAllSync(): void {
    try {
      if (!this.canReleaseHeld()) { this.dispose(); return; }
      if (this.heldButtons !== 0) {
        if (this.sender.mouse(0, 0, 0, 0, this.heldDeviceId)) {
          this.heldButtons = 0;
          this.heldReleaseGuard = undefined;
        }
      }
      if (this.keyStuck) {
        if (this.sender.keyboard(0, [], this.heldDeviceId)) this.keyStuck = false;
      }
    } catch {
      /* SDK 已停：兜底尽力而为 */
    }
    this.dispose();
  }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ---------------- 闭环绝对定位 ----------------

  /** 闭环绝对定位：移动到 OS 虚拟屏幕物理坐标 (x,y)。
   *  小步逼近 + 光标回读修正；未收敛或无反馈时失败，已写入帧仍可能迟到。
   *  tolPx 为收敛容差（像素）；外部输入会干扰反馈。 */
  async moveTo(x: number, y: number, opts?: { tolPx?: number; deviceId?: string }): Promise<MoveToResult> {
    return this.enqueue(() => this.moveToInternal(x, y, opts?.tolPx ?? 3, opts?.deviceId));
  }

  /** 精准点击：闭环定位到 (x,y) 后点击，定位失败不点击。
   *  同一排队序列避免其他工具插入，但不能隔离物理鼠标输入。 */
  async clickAt(
    x: number,
    y: number,
    button: ButtonName,
    count = 1,
    opts?: { tolPx?: number; deviceId?: string }
  ): Promise<MoveToResult & { click?: InjectOpResult }> {
    return this.enqueue(async () => {
      const m = await this.moveToInternal(x, y, opts?.tolPx ?? 3, opts?.deviceId);
      if (!m.ok) return { ...m, note: `${m.note ?? '未收敛'}，未执行点击` };
      const bit = BUTTON_BIT[button];
      if (!bit) throw new Error(`未知按键: ${button}`);
      const n = Math.max(1, Math.min(5, count));
      let sent = 0;
      let failed = 0;
      for (let i = 0; i < n; i++) {
        if (i > 0) await sleep(this.cfg.clickMs * 2);
        const before = this.heldButtons;
        if (!this.sendMouse(this.heldButtons | bit, 0, 0, 0, opts?.deviceId)) { failed += 2; break; }
        sent++;
        await sleep(this.cfg.clickMs);
        if (!this.sendMouse(before, 0, 0, 0, opts?.deviceId)) { failed += 1; break; }
        sent++;
      }
      return { ...m, ok: m.ok && failed === 0, frames: m.frames + n * 2, sent: m.sent + sent, failed: m.failed + failed,
               click: { frames: n * 2, sent, failed } };
    });
  }

  /** 单帧小步 + OS 光标反馈。写入成功不等于设备已执行；等待期间不得重发位移。 */
  private async moveToInternal(
    tx: number, ty: number, tol: number, deviceId?: string
  ): Promise<MoveToResult> {
    const read = this.readCursor;
    if (!read) throw new Error('当前平台不支持光标位置回读（仅 Windows）');
    const p0 = read();
    if (!p0) throw new Error('光标位置读取失败');
    const K = 0.9;
    const MAX_ITER = 15;
    const deadline = performance.now() + 20000;
    const feedbackMs = this.cfg.feedbackTimeoutMs ?? 5000;
    let cur = p0;
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < MAX_ITER; i++) {
      const errX = tx - cur.x;
      const errY = ty - cur.y;
      if (Math.abs(errX) <= tol && Math.abs(errY) <= tol) {
        return { ok: true, iterations: i, frames: sent + failed, sent, failed,
                 from: p0, final: cur, residual: { dx: errX, dy: errY } };
      }
      if (performance.now() >= deadline) {
        return { ok: false, iterations: i, frames: sent + failed, sent, failed, from: p0, final: cur,
                 residual: { dx: errX, dy: errY }, note: '定位超过 20s 总时限，已停止发送' };
      }
      let ux = Math.round(errX * K);
      let uy = Math.round(errY * K);
      if (ux === 0 && uy === 0) {            // 误差小于系数步长：按符号 1 单位微调
        ux = Math.sign(errX);
        uy = Math.sign(errY);
      }
      ux = Math.max(-127, Math.min(127, ux));
      uy = Math.max(-127, Math.min(127, uy));
      if (!this.sendMouse(this.heldButtons, ux, uy, 0, deviceId)) {
        failed++;
        return { ok: false, iterations: i + 1, frames: sent + failed, sent, failed, from: p0,
                 final: cur, residual: { dx: errX, dy: errY }, note: '位移帧写入失败（未连接？）' };
      }
      sent++;
      const before = cur;
      const feedbackDeadline = Math.min(deadline, performance.now() + feedbackMs);
      // 保留最小帧间隔；此后仅回读，不在反馈缺失时重复发送。
      await sleep(Math.min(Math.max(this.cfg.frameMs, 30), Math.max(0, feedbackDeadline - performance.now())));
      for (;;) {
        this.checkTarget(deviceId); // 重启/退出可打断长反馈等待，不必等满 5s
        const p = read();
        if (!p) throw new Error('光标位置读取失败');
        cur = p;
        if (cur.x !== before.x || cur.y !== before.y) break;
        if (performance.now() >= feedbackDeadline) {
          return { ok: false, iterations: i + 1, frames: sent + failed, sent, failed, from: p0, final: cur,
                   residual: { dx: tx - cur.x, dy: ty - cur.y },
                   note: '等待光标反馈超时（屏幕边界、设备延迟或阻断），已停止发送；已写入帧仍可能延迟执行，请先观察再操作' };
        }
        await sleep(Math.min(20, Math.max(0, feedbackDeadline - performance.now())));
      }
    }
    const ok = Math.abs(tx - cur.x) <= tol && Math.abs(ty - cur.y) <= tol;
    return { ok, iterations: MAX_ITER, frames: sent + failed, sent, failed, from: p0,
             final: cur, residual: { dx: tx - cur.x, dy: ty - cur.y }, note: ok ? undefined : '达到迭代上限' };
  }

  // ---------------- 内部 ----------------

  /** 所有帧序列串行执行（防 move 连发与 click/press 交错破坏时序） */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => {
      if (this.suspended) throw new Error('SDK 正在重启或退出，注入已暂停');
      return fn();
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private sendMouse(buttons: number, dx: number, dy: number, wheel: number, deviceId?: string,
    observeSend?: (send: () => number) => number): boolean {
    this.checkTarget(deviceId);
    const send = () => this.sender.mouse(buttons, dx, dy, wheel, deviceId);
    const ok = (observeSend ? observeSend(send) : send()) === 1;
    if (ok) this.stats.mouseSent++;
    else this.stats.mouseFailed++;
    if (ok) {
      this.heldButtons = buttons;
      this.heldDeviceId = deviceId;
      if (buttons === 0) this.heldReleaseGuard = undefined;
    }
    // 活动续期：按住状态（本帧或存量）下持续有帧流动即刷新看门狗——只有真正的
    // 3s 静默才触发兜底复位（跨轮拖拽不再被误打断，stuck 风险仍被覆盖）
    if (ok && (this.heldButtons !== 0 || buttons !== 0)) this.armIdleReset(deviceId);
    return ok;
  }

  private sendKeyboard(modifiers: number, ids: number[], deviceId?: string): boolean {
    this.checkTarget(deviceId);
    const ok = this.sender.keyboard(modifiers, ids, deviceId) === 1;
    if (ok) this.stats.keySent++;
    else this.stats.keyFailed++;
    if (ok) {
      this.heldDeviceId = deviceId;
      this.keyStuck = modifiers !== 0 || ids.some(id => id !== 0);
      if (this.keyStuck) this.armIdleReset(deviceId);
    }
    return ok;
  }

  private checkTarget(deviceId?: string): void {
    if (this.suspended) throw new Error('SDK 正在重启或退出，注入已暂停');
    if (this.heldButtons !== 0 && !this.canReleaseHeld()) throw new Error('Original device epoch is unavailable; held input remains unconfirmed');
    if ((this.heldButtons !== 0 || this.keyStuck) && this.heldDeviceId !== deviceId) {
      throw new Error('有未释放的按键，请先释放原设备后再切换 device_id');
    }
  }

  /** stuck-button 兜底：状态未清零时空闲 3s 后自动发全零复位帧 */
  private armIdleReset(deviceId?: string): void {
    if (this.hardwareActionActive) return; // hardware input action owns its bounded finally cleanup, not a competing idle release.
    if (!this.canReleaseHeld()) return;
    if (deviceId) this.heldDeviceId = deviceId;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.heldButtons === 0 && !this.keyStuck) return;
      if (!this.canReleaseHeld()) return;
      this.stats.idleResets++;
      this.releaseAll().catch(() => undefined);
    }, IDLE_RESET_MS);
    this.idleTimer.unref?.();
  }

  private disarmIdleReset(): void {
    if (this.idleTimer && this.heldButtons === 0 && !this.keyStuck) this.dispose();
  }

  private canReleaseHeld(): boolean {
    try { return this.heldReleaseGuard?.() ?? true; }
    catch { return false; }
  }
}
