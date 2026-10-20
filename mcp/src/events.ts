/*
 * events.ts —— 设备事件环形缓冲 + since 游标拉取 + 条件等待（长轮询）
 *
 * 事件对象：{seq, ts, deviceId, type, payload}
 *  - seq 进程内严格递增（即使缓冲淘汰旧事件也不回退），agent 以返回的 nextSince 续读
 *  - dropped = 因容量淘汰的条数（对应 SDK queueOverflow 之外的 MCP 层泄压计数）
 *  - wait()：已有匹配立即返回；否则挂起直到有匹配或超时。MCP 事件通路的主通道。
 */

export interface UmEvent {
  seq: number;
  ts: number;
  deviceId: string;
  type: string;
  payload?: unknown;
}

interface Waiter {
  since: number;
  types?: string[];
  resolve: (events: UmEvent[]) => void;
  timer: NodeJS.Timeout;
}

export class EventBuffer {
  private buf: UmEvent[] = [];
  private nextSeq = 1;
  private droppedCount = 0;
  private waiters = new Set<Waiter>();

  constructor(private readonly capacity: number) {}

  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  get size(): number {
    return this.buf.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  push(deviceId: string, type: string, payload?: unknown): UmEvent {
    // Bound retained event memory even for oversized/unserializable vendor diagnostics.
    try {
      const encoded = JSON.stringify(payload);
      const bytes = encoded === undefined ? 0 : Buffer.byteLength(encoded);
      if (bytes > 64 * 1024) payload = { truncated: true, originalBytes: bytes, reason: 'event_payload_limit' };
    } catch { payload = { truncated: true, reason: 'event_payload_not_serializable' }; }
    const evt: UmEvent = { seq: this.nextSeq++, ts: Date.now(), deviceId, type, payload };
    this.buf.push(evt);
    if (this.buf.length > this.capacity) {
      this.buf.shift();
      this.droppedCount++;
    }
    this.wake(evt);
    return evt;
  }

  private matches(evt: UmEvent, since: number, types?: string[]): boolean {
    return evt.seq > since && (!types || types.length === 0 || types.includes(evt.type));
  }

  since(since: number, types?: string[], limit = 100): UmEvent[] {
    const out: UmEvent[] = [];
    for (const evt of this.buf) {
      if (evt.seq <= since) continue;
      if (types && types.length > 0 && !types.includes(evt.type)) continue;
      out.push(evt);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 长轮询：立即有匹配则同步返回，否则等待至超时（返回空数组） */
  wait(since: number, types: string[] | undefined, timeoutMs: number): Promise<UmEvent[]> {
    const ready = this.since(since, types);
    if (ready.length > 0) return Promise.resolve(ready);
    if (timeoutMs <= 0) return Promise.resolve([]);

    return new Promise<UmEvent[]>((resolve) => {
      const waiter: Waiter = {
        since,
        types,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve([]);
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  private wake(evt: UmEvent): void {
    for (const waiter of this.waiters) {
      if (this.matches(evt, waiter.since, waiter.types)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        // 已缓冲的全部匹配一并交付（seq 连续性由调用方以 nextSince 保证）
        waiter.resolve(this.since(waiter.since, waiter.types));
      }
    }
  }

  stats(): { capacity: number; size: number; dropped: number; latestSeq: number } {
    return { capacity: this.capacity, size: this.buf.length, dropped: this.droppedCount, latestSeq: this.latestSeq };
  }
}
