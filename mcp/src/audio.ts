/*
 * audio.ts —— 录音会话与 WAV 落盘
 *
 * 策略（计划 D3）：音频不进 MCP 协议。采集期间 PCM 块只累积在内存
 * （16kHz/16bit/mono → 32KB/s，默认上限 60s ≈ 2MB），stop 时一次性写 WAV，
 * 回调线程零文件 IO、天然保序。语音键 down/up 自动会话与手动会话互斥。
 * 磁盘配额：finalize 后按 mtime 淘汰最旧的 WAV 直到回到限额内。
 */
import fs from 'node:fs';
import path from 'node:path';

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const CHANNELS = 1;
const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS) / 1000; // 32

export interface RecordResult {
  path: string;
  durationMs: number;
  bytes: number;
  deviceId: string;
  reason: 'manual' | 'key-up' | 'timeout';
}

interface Session {
  kind: 'manual' | 'auto';
  deviceId: string;
  chunks: Buffer[];
  bytes: number;
  startedAt: number;
  timer: NodeJS.Timeout;
  byteLimit: number;
}

export class AudioRecorder {
  private session: Session | null = null;
  /** 最近一次完成的录音（无论 manual/key-up/timeout 收尾），stop 无会话时回带，避免误导 */
  last: RecordResult | null = null;
  private dir: string;
  private quotaBytes: number;

  constructor(
    dir: string,
    private readonly maxSeconds: number,
    quotaMb: number,
    private readonly onAutoFinalize: (r: RecordResult) => void,
    private readonly onError: (error: string) => void = (error) => console.error(`[umouse-mcp] ${error}`)
  ) {
    this.dir = dir;
    this.quotaBytes = quotaMb * 1024 * 1024;
    fs.mkdirSync(dir, { recursive: true });
  }

  get active(): boolean {
    return this.session != null;
  }

  status(): {
    recording: boolean;
    kind?: string;
    deviceId?: string;
    startedAt?: number;
    bytes?: number;
    durationMs?: number;
    last?: RecordResult | null;
  } {
    if (!this.session) {
      const base: { recording: false; last?: RecordResult | null } = { recording: false };
      if (this.last) base.last = this.last;
      return base;
    }
    const s = this.session;
    return {
      recording: true,
      kind: s.kind,
      deviceId: s.deviceId,
      startedAt: s.startedAt,
      bytes: s.bytes,
      durationMs: Math.round(s.bytes / BYTES_PER_MS),
    };
  }

  /** 手动开始（语音键自动会话进行中则拒绝，避免双写） */
  startManual(deviceId: string, maxSeconds?: number): { ok: true } | { ok: false; error: string } {
    if (this.session) {
      return { ok: false, error: `已有录音会话进行中（kind=${this.session.kind}，先 stop）` };
    }
    this.open('manual', deviceId, maxSeconds);
    return { ok: true };
  }

  /** 语音键 down 触发的自动会话（manual 进行中静默跳过） */
  startAuto(deviceId: string): void {
    if (this.session) return;
    this.open('auto', deviceId);
  }

  /** 语音键 up / 手动 stop / 超时 收尾 */
  stop(reason: RecordResult['reason']): RecordResult | null {
    const s = this.session;
    if (!s) return null;
    this.session = null;
    clearTimeout(s.timer);
    if (s.bytes === 0) return null; // 没采到数据不产文件
    const r = this.writeWav(s, reason);
    this.last = r;
    this.pruneQuota();
    if (s.kind === 'auto') this.onAutoFinalize(r);
    return r;
  }

  stopSafely(reason: RecordResult['reason']): void {
    try { this.stop(reason); }
    catch (e) { this.onError(`录音落盘失败：${e instanceof Error ? e.message : e}`); }
  }

  /** 音频回调入口：非录音态直接丢弃（koffi 蹦床的 decode 拷贝在绑定层已发生，此处零额外成本） */
  feed(pcm: Buffer, deviceId: string): void {
    const s = this.session;
    if (!s || pcm.length === 0) return;
    if (s.deviceId && deviceId && s.deviceId !== deviceId) return; // 防御：非绑定源
    const chunk = pcm.subarray(0, Math.max(0, s.byteLimit - s.bytes));
    s.chunks.push(chunk);
    s.bytes += chunk.length;
    if (s.bytes >= s.byteLimit) this.stopSafely('timeout');
  }

  private open(kind: Session['kind'], deviceId: string, maxSeconds?: number): void {
    const cap = Math.min(600, Math.max(1, maxSeconds ?? this.maxSeconds));
    const s: Session = {
      kind,
      deviceId,
      chunks: [],
      bytes: 0,
      byteLimit: Math.floor(cap * SAMPLE_RATE) * BYTES_PER_SAMPLE * CHANNELS,
      startedAt: Date.now(),
      timer: setTimeout(() => {
        // 超时自动收尾：手动会话也收（防忘记 stop 撑爆内存），reason 标 timeout
        this.stopSafely('timeout');
      }, cap * 1000),
    };
    s.timer.unref?.();
    this.session = s;
  }

  private writeWav(s: Session, reason: RecordResult['reason']): RecordResult {
    const stamp = new Date(s.startedAt);
    const p = (n: number) => String(n).padStart(2, '0');
    const name =
      `umouse-${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}` +
      `-${p(stamp.getHours())}${p(stamp.getMinutes())}${p(stamp.getSeconds())}` +
      `-${Math.random().toString(36).slice(2, 6)}.wav`;
    const file = path.join(this.dir, name);

    const dataLen = s.bytes;
    const buf = Buffer.alloc(44 + dataLen);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataLen, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16); // fmt chunk size
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(CHANNELS, 22);
    buf.writeUInt32LE(SAMPLE_RATE, 24);
    buf.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS, 28); // byteRate
    buf.writeUInt16LE(BYTES_PER_SAMPLE * CHANNELS, 32); // blockAlign
    buf.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34); // bits
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataLen, 40);
    let off = 44;
    for (const c of s.chunks) {
      c.copy(buf, off);
      off += c.length;
    }
    fs.writeFileSync(file, buf);
    return {
      path: file,
      durationMs: Math.round(dataLen / BYTES_PER_MS),
      bytes: dataLen,
      deviceId: s.deviceId,
      reason,
    };
  }

  /** 按配额淘汰最旧 WAV（含历史遗留文件） */
  private pruneQuota(): void {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => /^umouse-\d{8}-\d{6}-[a-z0-9]+\.wav$/.test(f))
        .map((f) => {
          const full = path.join(this.dir, f);
          return { full, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime);
      let total = files.reduce((acc, f) => acc + f.size, 0);
      for (const f of files) {
        if (total <= this.quotaBytes) break;
        if (f.full === this.last?.path) continue; // 返回的最新文件必须仍可读取；配额允许单文件超额
        fs.unlinkSync(f.full);
        total -= f.size;
      }
    } catch {
      /* 配额清理失败不影响主流程 */
    }
  }
}
