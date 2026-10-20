/*
 * voice-vad.ts —— 本地端点检测
 *
 * 首选方案为本地 Silero ONNX（专用 worker、固定模型版本/SHA、离线打包）；
 * 该依赖（onnxruntime-node + 模型）尚未进入本项目依赖清单——在此之前提供
 * 能量（RMS）回退实现作为本地默认，**能力如实标注**（id=energy，非 Silero），
 * Silero 接入后经同一端口替换（begin/writePcm/reset 语义不变）。
 *
 * 参数语义（调参起点，未经真机标定）：
 *  - 首次说话等待 firstSpeechMs：超时未起声 → 'no-speech-timeout'（由协调器
 *    裁决，本模块只报事件）；未起声前不启动句尾计时；
 *  - 有效起声 onsetMs：降低瞬时噪声误触（不据此裁剪音频——前滚缓冲由
 *    协调器持有的 PCM 流承担，回退实现不缓存音频）；
 *  - 结束静音 endSilenceMs：说话后的停顿 → 'speech-end'；
 *  - PTT 模式不接入本模块（松键结束，不因 VAD 截断）。
 */
export interface VadConfig {
  firstSpeechMs: number;   // 默认 10_000
  onsetMs: number;         // 默认 200（有效起声累计）
  endSilenceMs: number;    // 默认 1_200
  /** RMS 阈值（int16 满量程比例，0~1）；仅能量回退实现使用 */
  energyThreshold: number; // 默认 0.02
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  firstSpeechMs: 10_000,
  onsetMs: 200,
  endSilenceMs: 1_200,
  energyThreshold: 0.02,
};

export type VadEvent = 'speech-start' | 'speech-end' | 'no-speech-timeout';

export interface VoiceVadPort {
  readonly id: string;
  /** 处理一帧 PCM（16k/16bit/mono）；返回事件或 null */
  writePcm(pcm: Buffer, now?: number): VadEvent | null;
  reset(): void;
}

/** 能量回退 VAD：RMS 起声/静音检测（本地、离线、无模型依赖；非 Silero） */
export class EnergyVad implements VoiceVadPort {
  readonly id = 'energy';
  private spoke = false;
  private onsetAccumMs = 0;
  private silenceMs = 0;
  private startedAt = 0;

  constructor(private readonly config: VadConfig = DEFAULT_VAD_CONFIG) {}

  reset(): void {
    this.spoke = false;
    this.onsetAccumMs = 0;
    this.silenceMs = 0;
    this.startedAt = 0;
  }

  writePcm(pcm: Buffer, now = Date.now()): VadEvent | null {
    if (this.startedAt === 0) {
      this.startedAt = now;
    }
    const durationMs = (pcm.length / 2 / 16000) * 1000;
    const loud = this.isSpeech(pcm);
    if (!this.spoke) {
      // 起声累计：连续响帧累计过 onsetMs 才算说话（瞬时噪声不误触）
      this.onsetAccumMs = loud ? this.onsetAccumMs + durationMs : Math.max(0, this.onsetAccumMs - durationMs);
      if (this.onsetAccumMs >= this.config.onsetMs) {
        this.spoke = true;
        this.silenceMs = 0;
        return 'speech-start';
      }
      if (now - this.startedAt >= this.config.firstSpeechMs) {
        return 'no-speech-timeout';
      }
      return null;
    }
    // Only decoded silent PCM counts; a transport gap is not acoustic silence.
    this.silenceMs = loud ? 0 : this.silenceMs + durationMs;
    if (this.silenceMs >= this.config.endSilenceMs) {
      this.spoke = false;
      this.onsetAccumMs = 0;
      this.silenceMs = 0;
      return 'speech-end';
    }
    return null;
  }

  private isSpeech(pcm: Buffer): boolean {
    let sum = 0;
    const samples = Math.floor(pcm.length / 2);
    if (samples === 0) return false;
    for (let i = 0; i < samples; i++) {
      const v = pcm.readInt16LE(i * 2);
      sum += v * v;
    }
    const rms = Math.sqrt(sum / samples) / 32768;
    return rms >= this.config.energyThreshold;
  }
}

export type VadMode = 'none' | 'energy';

/** 按配置构建 VAD（none → null：manual_only，仅手动/上限结束） */
export function createVad(mode: VadMode, overrides: Partial<VadConfig> = {}): VoiceVadPort | null {
  if (mode === 'none') return null;
  return new EnergyVad({ ...DEFAULT_VAD_CONFIG, ...overrides });
}
