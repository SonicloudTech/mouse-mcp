/*
 * asr-service.ts —— 统一流式识别 provider 与文本聚合（v2 语音计划 ）
 *
 * Provider 生命周期：begin(session) → writePcm(chunk) → finishInput() → 终态；
 * 另有 cancel()。事件经构造回调上抛：preview / segmentFinal / warning / terminal。
 *
 * 文本归一化规则（硬化为断言目标）：
 *  - intermediate 是当前轮次的覆盖文本（预览替换，不 append）；
 *  - 一次录音可有多个 segmentFinal；总预览 = 已定稿分段 + 当前可变分段；
 *  - final 不一定是整场结束——只有 finishInput 之后且 provider 终态到达，
 *    完整全文才冻结（Aggregator.final 冻结）；
 *  - 不按"相同文字"去重（用户可能重复同一句话）；
 *  - 不把累计全文反复提交 typer（typer 只在最终一次收全文——voice-typer 落实）。
 *
 * 本文件提供：
 *  - AsrService：每会话一个 provider 实例的工厂 + 事件分发（会话身份隔离）；
 *  - batch provider：复用既有 Transcriber（完整 WAV）做最终识别——无实时预览；
 *  - fake provider：确定性测试用（mcp/test 引 asr-fake.js）。
 * P2 在此接口上接 ASRTools 流式适配与本地 Whisper 预览 worker。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Transcriber } from './transcriber.js';

export interface AsrSessionInit {
  sessionId: string;
  deviceId: string;
  language?: string;
}

export interface AsrEvents {
  /** 实时预览（覆盖式全文 = 已定稿分段 + 当前可变分段） */
  preview?(text: string, meta: { sessionId: string; revision: number; kind?: 'segment' | 'snapshot' }): void;
  /** 一个分段的最终文本（可多次） */
  segmentFinal?(text: string, meta: { sessionId: string }): void;
  warning?(kind: string, detail: string, meta: { sessionId: string }): void;
  /** provider 终态（FINISHED/FAILED/CANCELLED 对应 ok:true/false/'cancelled'） */
  terminal(result: { ok: boolean; cancelled?: boolean; error?: string }, meta: { sessionId: string }): void;
}

export interface StreamingAsrProvider {
  readonly id: string;
  readonly supportsPreview: boolean;
  begin(session: AsrSessionInit): void;
  writePcm(chunk: Buffer): void;
  /** 音频输入已结束（audioSegmentComplete 边界后调用）；终态经 terminal 事件 */
  finishInput(): void;
  cancel(): void;
}

export type AsrProviderFactory = (events: AsrEvents, init: AsrSessionInit) => StreamingAsrProvider;

/** 文本聚合器：预览合并与最终全文冻结的唯一权威（防多轮 final 重叠/遗漏） */
export class TextAggregator {
  private segments: string[] = [];
  private current = '';
  private frozen: string | null = null;
  private revision = 0;

  onIntermediate(text: string): void {
    if (this.frozen !== null) return; // 终态后不再变动
    this.current = text ?? '';
    this.revision += 1;
  }

  onSegmentFinal(text: string): void {
    if (this.frozen !== null) return;
    this.segments.push(text ?? '');
    this.current = '';
    this.revision += 1;
  }

  preview(): string {
    return [...this.segments, this.current].filter((s) => s.length > 0).join('');
  }

  get currentRevision(): number {
    return this.revision;
  }

  /** 冻结最终全文（只在 finishInput 后、provider 终态时调用一次） */
  freeze(): string {
    if (this.frozen === null) {
      if (this.current) this.segments.push(this.current); // 无分段语义的引擎：可变段兜底定稿
      this.frozen = this.segments.join('');
    }
    return this.frozen;
  }
}

/**
 * 批量识别 provider（P1 可用）：采集期只累计 PCM（零识别），finishInput 后
 * 写临时 WAV 走既有 Transcriber（windows-speech/whisper-cpp/http），一次终态。
 * supportsPreview=false——能力如实呈现（完整 WAV 只够最终结果）。
 */
export function createBatchAsrProviderFactory(transcriber: Transcriber, opts: { maxBytes?: number } = {}): AsrProviderFactory {
  const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
  return (events, init) => {
    let chunks: Buffer[] = [];
    let bytes = 0;
    let finishing = false;
    let cancelled = false;
    const abort = new AbortController();
    return {
      id: 'batch-wav',
      supportsPreview: false,
      begin() { chunks = []; bytes = 0; finishing = false; cancelled = false; },
      writePcm(chunk) {
        if (finishing || cancelled) return;
        const take = chunk.subarray(0, Math.max(0, maxBytes - bytes));
        if (take.length > 0) { chunks.push(Buffer.from(take)); bytes += take.length; }
        if (bytes >= maxBytes) events.warning?.('asr_audio_limit', '音频达到批量识别上限，超出部分忽略', { sessionId: init.sessionId });
      },
      finishInput() {
        if (finishing || cancelled) return;
        finishing = true;
        const pcm = Buffer.concat(chunks);
        chunks = [];
        if (pcm.length === 0) {
          events.terminal({ ok: true }, { sessionId: init.sessionId });
          return;
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umouse-asr-'));
        const file = path.join(dir, 'input.wav');
        try {
          writeWav16kMono(file, pcm);
          transcriber({ path: file, durationMs: Math.round(pcm.length / 32), bytes: pcm.length }, abort.signal)
            .then((result) => {
              if (cancelled) return;
              const text = result.text.trim();
              if (text) events.segmentFinal?.(text, { sessionId: init.sessionId });
              events.terminal({ ok: true }, { sessionId: init.sessionId });
            })
            .catch((error: unknown) => {
              if (cancelled) return;
              events.terminal({ ok: false, error: error instanceof Error ? error.message : String(error) }, { sessionId: init.sessionId });
            })
            .finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响 */ } });
        } catch (error) {
          events.terminal({ ok: false, error: error instanceof Error ? error.message : String(error) }, { sessionId: init.sessionId });
        }
      },
      cancel() {
        if (cancelled) return;
        cancelled = true;
        abort.abort();
        chunks = [];
        events.terminal({ ok: false, cancelled: true }, { sessionId: init.sessionId });
      },
    };
  };
}

/** 16kHz/16bit/mono PCM WAV 落盘（与 AudioRecorder 同格式） */
export function writeWav16kMono(file: string, pcm: Buffer): void {
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + pcm.length, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(pcm.length, 40);
  pcm.copy(buf, 44);
  fs.writeFileSync(file, buf);
}

export interface SnapshotPreviewOptions {
  /** 预览调度间隔（毫秒），默认 1500；须 ≥500 */
  intervalMs?: number;
  /** 预览快照最大字节（录制硬上限约束内存），默认 8MB */
  maxSnapshotBytes?: number;
}

/**
 * 本地免费预览适配：给"最终结果型"provider 附加有界前缀快照预览。
 * - 采集期每 intervalMs 取"开始至当前"的完整前缀快照 → 临时 WAV → 既有
 *   Transcriber 出整体替换式预览（不做增量拼接）；
 * - 单会话最多一个预览任务在运行（busy 时跳过本拍）；只保留最新快照；
 * - 终态（含取消）后一切迟到的预览结果作废——预览 revision 不覆盖终态；
 * - 预览带 sessionId/revision（audioStart 恒 0：完整前缀）。
 * 返回增强后的工厂；底层 provider 的 supportsPreview 由本层置 true（预览来自
 * 本地快照，不冒充引擎实时流——preview 事件即"本地快照识别"）。
 */
export function withSnapshotPreview(
  factory: AsrProviderFactory,
  transcriber: Transcriber,
  opts: SnapshotPreviewOptions = {},
): AsrProviderFactory {
  const intervalMs = Math.max(100, opts.intervalMs ?? 1500);
  const maxBytes = opts.maxSnapshotBytes ?? 8 * 1024 * 1024;
  return (events, init) => {
    let chunks: Buffer[] = [];
    let bytes = 0;
    let running = false;
    let stopped = false;
    let revision = 0;
    let lastSnapshotBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    const abort = new AbortController();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umouse-preview-'));
    let base: StreamingAsrProvider;
    try { base = factory(events, init); }
    catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }

    const runSnapshot = () => {
      if (running || stopped || bytes === 0 || bytes === lastSnapshotBytes) return;
      running = true;
      lastSnapshotBytes = bytes;
      revision += 1;
      const snapRevision = revision;
      const file = path.join(dir, `preview-${snapRevision}.wav`);
      try {
        writeWav16kMono(file, Buffer.concat(chunks, bytes));
        transcriber({ path: file, durationMs: Math.round(bytes / 32), bytes }, abort.signal)
          .then((result) => {
            if (stopped || snapRevision !== revision) return; // 终态/更新快照已到：作废
            events.preview?.(result.text, { sessionId: init.sessionId, revision: snapRevision, kind: 'snapshot' });
          })
          .catch(() => { /* 预览失败静默：降级为无预览，最终识别不受影响 */ })
          .finally(() => {
            running = false;
            try { fs.unlinkSync(file); } catch { /* 清理失败忽略 */ }
            if (stopped) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* pending reader closed */ } }
          });
      } catch {
        running = false;
      }
    };

    timer = setInterval(() => runSnapshot(), intervalMs);
    timer.unref();

    return {
      id: `${base.id}+snapshot-preview`,
      supportsPreview: true,
      begin(session) { base.begin(session); },
      writePcm(chunk: Buffer) {
        const take = chunk.subarray(0, Math.max(0, maxBytes - bytes));
        if (take.length > 0) { chunks.push(Buffer.from(take)); bytes += take.length; }
        base.writePcm(chunk);
      },
      finishInput() {
        if (!stopped) {
          stopped = true;
          abort.abort();
          chunks = []; bytes = 0;
          if (timer) clearInterval(timer);
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
        }
        base.finishInput();
      },
      cancel() {
        if (!stopped) {
          stopped = true;
          abort.abort();
          chunks = []; bytes = 0;
          if (timer) clearInterval(timer);
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
        }
        base.cancel();
      },
    };
  };
}
