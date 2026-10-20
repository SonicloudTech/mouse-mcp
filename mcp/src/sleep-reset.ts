/*
 * sleep-reset.ts —— 以设备为单位周期发送睡眠计时重置指令。
 *
 * 当前设备协议经用户确认：请求 0A 03 A2，不回包。默认不等待 ACK。
 * 其它明确支持应答的固件可显式启用等待；兼容应答前缀 0A 17 81 05 A2。
 * 请求不包含鼠标位移，也不声称可唤醒已经休眠的硬件。写入成功与收到
 * A2 应答分开计数；应答没有序号，只能记录在等待窗口内观察到，不能证明
 * 对某次写入的一一确认，更不能证明 OS 输入已经执行。
 */

export interface SleepResetTimer {
  unref?: () => unknown;
}

/** 可注入的时钟只用于离线测试；实际运行使用 Node 定时器。 */
export interface SleepResetScheduler {
  now(): number;
  setTimeout(callback: () => void, ms: number): SleepResetTimer;
  clearTimeout(timer: SleepResetTimer): void;
}

export interface SleepResetOptions {
  enabled?: boolean;
  intervalMs?: number;
  expectAck?: boolean;
  ackTimeoutMs?: number;
  onEvent?: (deviceId: string, payload: Record<string, unknown>) => void;
}

interface Counters {
  attempts: number;
  writesSucceeded: number;
  writesFailed: number;
  acknowledgements: number;
  acknowledgementsInWindow: number;
  acknowledgementsOutsideWindow: number;
  acknowledgementTimeouts: number;
}

interface DeviceEntry extends Counters {
  deviceId: string;
  connMode: number;
  connectedAt: number;
  awaitingAck: boolean;
  lastAttemptAt?: number;
  lastWriteAt?: number;
  lastAckAt?: number;
  lastError?: string;
  nextSendAt?: number;
  sendTimer?: SleepResetTimer;
  ackTimer?: SleepResetTimer;
}

const DEFAULT_SCHEDULER: SleepResetScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function counters(): Counters {
  return {
    attempts: 0, writesSucceeded: 0, writesFailed: 0,
    acknowledgements: 0, acknowledgementsInWindow: 0,
    acknowledgementsOutsideWindow: 0, acknowledgementTimeouts: 0,
  };
}

/**
 * 只接受完整协议头。历史 USB rawFrame 实测保留一个额外的 0A report ID
 * （controlled-calls.jsonl 中 0a0a178106f0...）；只在 USB connMode=0 时
 * 接受这个固定前缀。不在载荷内部搜索，以免音频/其他应答被误判。
 */
export function isSleepResetAck(data: Uint8Array, connMode = 0): boolean {
  const matches = (offset: number) => data.length >= offset + 5 &&
    data[offset] === 0x0a && data[offset + 1] === 0x17 &&
    data[offset + 2] === 0x81 && data[offset + 3] === 0x05 &&
    data[offset + 4] === 0xa2;
  return matches(0) || (connMode === 0 && data[0] === 0x0a && matches(1));
}

export class SleepResetController {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly expectAck: boolean;
  readonly ackTimeoutMs: number;
  private running = false;
  private readonly devices = new Map<string, DeviceEntry>();
  private readonly totals = counters();

  constructor(
    private readonly write: (data: Buffer, deviceId: string) => number,
    private readonly options: SleepResetOptions = {},
    private readonly scheduler: SleepResetScheduler = DEFAULT_SCHEDULER,
  ) {
    this.enabled = options.enabled ?? true;
    this.intervalMs = options.intervalMs ?? 120_000;
    this.expectAck = options.expectAck ?? false;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 5_000;
    for (const [name, value] of [['intervalMs', this.intervalMs], ['ackTimeoutMs', this.ackTimeoutMs]] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new RangeError(`${name} 必须是有效的正整数定时毫秒数`);
      }
    }
    if (this.expectAck && this.ackTimeoutMs >= this.intervalMs) {
      throw new RangeError('ackTimeoutMs 必须小于 intervalMs，避免等待窗口重叠');
    }
  }

  /** start/connect 都不直接调用 SDK：通过下一轮定时器离开 SDK 回调栈。 */
  start(): void {
    if (this.running || !this.enabled) return;
    this.running = true;
    for (const device of this.devices.values()) this.schedule(device, 0);
  }

  stop(): void {
    this.running = false;
    for (const device of this.devices.values()) this.clearTimers(device);
    this.devices.clear();
  }

  onConnected(deviceId: string, connMode = 0): void {
    if (!this.enabled || !deviceId) return;
    // SDK 可能重复报告同一连接；不得据此增加发送频率。
    const known = this.devices.get(deviceId);
    if (known) {
      known.connMode = connMode;
      return;
    }
    const device: DeviceEntry = {
      ...counters(), deviceId, connMode, connectedAt: this.scheduler.now(), awaitingAck: false,
    };
    this.devices.set(deviceId, device);
    if (this.running) this.schedule(device, 0);
  }

  onDisconnected(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    this.clearTimers(device);
    this.devices.delete(deviceId);
  }

  /** 与原始帧是否公开入 MCP 事件流无关，bridge 应始终调用此方法。 */
  onRawFrame(deviceId: string, data: Uint8Array, connMode?: number): boolean {
    const device = this.devices.get(deviceId);
    if (!this.running || !device || !isSleepResetAck(data, connMode ?? device.connMode)) return false;
    const inWindow = device.awaitingAck;
    this.increment(device, 'acknowledgements');
    this.increment(device, inWindow ? 'acknowledgementsInWindow' : 'acknowledgementsOutsideWindow');
    device.lastAckAt = this.scheduler.now();
    device.awaitingAck = false;
    if (device.ackTimer) this.scheduler.clearTimeout(device.ackTimer);
    device.ackTimer = undefined;
    this.emit(device, { phase: 'ack', inWindow, correlation: 'unsequenced', receivedAt: device.lastAckAt });
    return true;
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      acknowledgementExpected: this.expectAck,
      ackTimeoutMs: this.ackTimeoutMs,
      requestHex: '0a03a2',
      acknowledgementPrefixHex: '0a178105a2',
      acknowledgementCorrelation: 'unsequenced' as const,
      ...this.totals,
      devices: [...this.devices.values()].map(({ sendTimer: _send, ackTimer: _ack, ...state }) => ({ ...state })),
    };
  }

  private active(device: DeviceEntry): boolean {
    return this.running && this.devices.get(device.deviceId) === device;
  }

  private schedule(device: DeviceEntry, delayMs: number): void {
    if (!this.active(device)) return;
    device.nextSendAt = this.scheduler.now() + delayMs;
    device.sendTimer = this.scheduler.setTimeout(() => {
      device.sendTimer = undefined;
      device.nextSendAt = undefined;
      if (this.active(device)) this.send(device);
    }, delayMs);
    device.sendTimer.unref?.();
  }

  private send(device: DeviceEntry): void {
    device.lastAttemptAt = this.scheduler.now();
    this.increment(device, 'attempts');
    // 仅显式支持应答的固件等待 ACK；当前无应答协议不得产生伪超时。
    // 提前设置，兼容绑定在同步 FFI 返回前分发的应答。
    device.awaitingAck = this.expectAck;
    try {
      // writeRaw 包含 report ID；Windows hid_write 按输出报告长度补零。
      // 使用独立 Buffer，避免 sender 意外修改后污染下一次指令。
      const ok = this.write(Buffer.from([0x0a, 0x03, 0xa2]), device.deviceId);
      if (ok !== 1) throw new Error('SDK writeRaw 返回失败');
      this.increment(device, 'writesSucceeded');
      device.lastWriteAt = this.scheduler.now();
      device.lastError = undefined;
      if (this.active(device) && device.awaitingAck) {
        device.ackTimer = this.scheduler.setTimeout(() => {
          device.ackTimer = undefined;
          if (!this.active(device) || !device.awaitingAck) return;
          device.awaitingAck = false;
          this.increment(device, 'acknowledgementTimeouts');
          this.emit(device, { phase: 'ackTimeout', timeoutMs: this.ackTimeoutMs, execution: 'unknown' });
        }, this.ackTimeoutMs);
        device.ackTimer.unref?.();
      }
      this.emit(device, { phase: 'write', ok: true, writtenAt: device.lastWriteAt, execution: 'unconfirmed' });
    } catch (error) {
      device.awaitingAck = false;
      this.increment(device, 'writesFailed');
      device.lastError = error instanceof Error ? error.message : String(error);
      this.emit(device, { phase: 'write', ok: false, error: device.lastError });
    }
    // ACK 超时/写入失败均按原周期继续，无即时重试，绝不补发鼠标动作。
    this.schedule(device, this.intervalMs);
  }

  private increment(device: DeviceEntry, field: keyof Counters): void {
    device[field]++;
    this.totals[field]++;
  }

  private clearTimers(device: DeviceEntry): void {
    if (device.sendTimer) this.scheduler.clearTimeout(device.sendTimer);
    if (device.ackTimer) this.scheduler.clearTimeout(device.ackTimer);
    device.sendTimer = undefined;
    device.ackTimer = undefined;
    device.nextSendAt = undefined;
    device.awaitingAck = false;
  }

  private emit(device: DeviceEntry, payload: Record<string, unknown>): void {
    // 诊断消费者异常不改变设备写入结果，也不终止后台定时任务。
    try { this.options.onEvent?.(device.deviceId, payload); } catch { /* observer only */ }
  }
}
