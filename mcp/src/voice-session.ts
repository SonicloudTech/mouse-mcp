/*
 * voice-session.ts —— VoiceCoordinator：单会话仲裁与两条固定目的地（v2）
 *
 * 一份音频资源（设备麦克风），两种用途，destination 在会话创建时冻结：
 *  - agent-reply：umouse_voice_start 发起，经 meetingCreate/Destroy 控制，
 *    最终文字作为工具结果返回（不 typer 打字、不走旧主动唤醒队列）；
 *  - cursor-dictation：物理语音键 PTT，不额外发 meetingCreate，松键收尾，
 *    最终文字经 typer 输入"此刻"的前台焦点。
 *
 * 状态机：idle → preparing → opening / ptt-capturing → listening
 *   → stop-requested → draining → finalizing → ready → delivering → delivered
 * 异常：failed / cancelled / no-speech / close-unconfirmed（隔离期内禁止重开）
 *
 * 关键规则：
 *  - 单活动会话（采集→交付）；活动会话中按键只反馈忙碌；
 *  - VAD/按钮/key-up/取消并发时只有一次 finish 获胜（状态门 + stopReason 单次赋值）；
 *  - cancel 阻止尚未发生的交付，不撤回已输入字符；
 *  - 音频段完成边界（audioSegmentComplete）之后才 asr.finishInput()——
 *    不用固定 sleep 猜测尾部 PCM；
 *  - 只有 origin=device-frame 的 meetingDestroyed 是设备关麦确认；
 *    transport-down 是异常结束；未确认关闭进入 close-unconfirmed 隔离。
 */
import { EventEmitter } from 'node:events';
import { newSessionId } from './device-capabilities.js';
import type { VoiceVadPort } from './voice-vad.js';
import { TextAggregator, type AsrEvents, type AsrProviderFactory, type StreamingAsrProvider } from './asr-service.js';
import type { GateDecision } from './capability-gate.js';

export type VoiceState =
  | 'preparing' | 'opening' | 'ptt-capturing' | 'listening'
  | 'stop-requested' | 'draining' | 'finalizing' | 'ready' | 'delivering' | 'delivered'
  | 'failed' | 'cancelled' | 'no-speech' | 'close-unconfirmed' | 'awaiting-key-up' | 'delivery-unknown';

export type StopReason = 'vad' | 'done-button' | 'key-up' | 'cancel' | 'no-speech' | 'max-duration' | 'device-lost' | 'transport-stall';

export interface VoiceSession {
  sessionId: string;
  generation: number;                        // coordinator 内部代次：隔离迟到的旧回调/旧按钮
  source: 'agent-request' | 'physical-speech-button';
  destination: 'agent-reply' | 'cursor-dictation';
  deviceId: string;
  deviceGeneration: number;
  prompt?: string;
  endMode: 'vad_or_manual' | 'manual_only';
  state: VoiceState;
  stopReason?: StopReason;
  meetingCreatedConfirmed: boolean | 'not-applicable';
  meetingDestroyedConfirmed: boolean | 'not-applicable';
  audioSegmentDrained: boolean;
  cleanupRequired: boolean;
  delivery: 'none' | 'pending' | 'attempting' | 'submitted' | 'failed' | 'unknown';
  createdAt: number;
  updatedAt: number;
  pcmBytes: number;
  preview: string;
  finalText?: string;
  error?: string;
  timings: Record<string, number>;
}

/** 桥接层提供的宿主能力（sdk-bridge 实现；测试用 fake） */
export interface VoiceHostAdapter {
  meetingCreate(deviceId: string): number | Promise<number>;
  meetingDestroy(deviceId: string): number | Promise<number>;
  setAudioSource(deviceId: string | null): { ok: number; source: string } | Promise<{ ok: number; source: string }>;
  audioSource(): string;
  isOnline(deviceId: string): boolean;
  generationOf(deviceId: string): number;
  /** 单台在线时解析缺省设备；返回 '' 表示无法唯一确定 */
  defaultDevice(): string;
  checkVoice(deviceId: string): GateDecision;
  isAudioBusy?(): boolean;
}

/** typer 交付端口（P4 接真绑定；P1 为不可用实现） */
export interface VoiceTyperPort {
  readonly available: boolean;
  readonly id: string;
  deliver(req: { sessionId: string; text: string; deviceId: string }): Promise<
    | { outcome: 'submitted'; note?: string }
    | { outcome: 'failed'; error: string }
    | { outcome: 'unavailable'; error: string }>;
}

export interface VoiceCoordinatorConfig {
  maxDurationMs: number;
  pcmReadyWaitMs: number;
  createConfirmWaitMs: number;
  drainWaitMs: number;
  closeConfirmWaitMs: number;
  asrFinalWaitMs: number;
  /** @deprecated No elapsed timeout proves hardware closure. Kept for configuration compatibility. */
  closeUnconfirmedIsolationMs: number;
}

export const DEFAULT_VOICE_CONFIG: VoiceCoordinatorConfig = {
  maxDurationMs: 60_000,
  pcmReadyWaitMs: 8_000,
  createConfirmWaitMs: 5_000,
  drainWaitMs: 3_000,
  closeConfirmWaitMs: 3_000,
  asrFinalWaitMs: 30_000,
  closeUnconfirmedIsolationMs: 5_000,
};

interface TimerBag {
  maxDuration?: NodeJS.Timeout;
  pcmReady?: NodeJS.Timeout;
  createConfirm?: NodeJS.Timeout;
  drain?: NodeJS.Timeout;
  closeConfirm?: NodeJS.Timeout;
  asrFinal?: NodeJS.Timeout;
  keyRelease?: NodeJS.Timeout;
}

const CAPTURING_STATES: VoiceState[] = ['opening', 'ptt-capturing', 'listening'];
const PRE_STOP_STATES: VoiceState[] = [...CAPTURING_STATES, 'stop-requested'];
const TERMINAL_STATES: VoiceState[] = ['delivered', 'failed', 'cancelled', 'no-speech', 'delivery-unknown'];

export class VoiceCoordinator extends EventEmitter {
  private active: VoiceSession | null = null;
  private readonly history: VoiceSession[] = [];
  private readonly byId = new Map<string, VoiceSession>();
  private readonly requestIndex = new Map<string, string>(); // client_request_id → sessionId
  private aggregator: TextAggregator | null = null;
  private provider: StreamingAsrProvider | null = null;
  private timers: TimerBag = {};
  /** 关麦确认计时器独立记账：会话终态后仍需观察迟到 destroyed（close-unconfirmed） */
  private closeTimers = new Map<string, NodeJS.Timeout>();
  private prevAudioSource: string | null = null;
  /** Hardware evidence, never an elapsed-time authorization to reopen. */
  private pendingClose = new Map<string, { sessionId: string; generation: number; confirmed: boolean; drained: boolean }>();
  private segmentSerial = new Map<string, { generation: number; serial: number }>();
  private keyHeld = new Set<string>();
  private pendingDrain = new Map<string, { sessionId: string; generation: number }>();
  private closed = false;
  private disposing = false;
  private waiters = new Map<string, Set<() => void>>();
  private generation = 0;
  private preparingPtt: { session: VoiceSession; pcm: Buffer[]; bytes: number; released: boolean; segment?: { serial: number; reason: string } } | null = null;

  constructor(
    private readonly host: VoiceHostAdapter,
    private readonly asrFactory: AsrProviderFactory | null,
    private readonly typer: VoiceTyperPort,
    private readonly config: VoiceCoordinatorConfig = DEFAULT_VOICE_CONFIG,
    private readonly onEvent: (type: string, payload: Record<string, unknown>, deviceId: string) => void = () => {},
    /** v2 本地 VAD（null=manual_only）；仅 agent 会话的 vad_or_manual 模式接入 */
    private readonly vad: VoiceVadPort | null = null,
  ) {
    super();
  }

  get asrAvailable(): boolean {
    return this.asrFactory !== null;
  }

  hasPendingClose(deviceId?: string): boolean {
    return deviceId ? this.pendingClose.has(deviceId) || this.pendingDrain.has(deviceId) || this.keyHeld.has(deviceId)
      : this.pendingClose.size > 0 || this.pendingDrain.size > 0 || this.keyHeld.size > 0;
  }

  /** Bridge may call only AFTER SDK callbacks are detached, drained and stop is confirmed. */
  resetAfterSdkStopped(): void {
    if (this.active) throw new Error('voice_session_active');
    for (const timer of this.closeTimers.values()) clearTimeout(timer);
    this.closeTimers.clear(); this.pendingClose.clear(); this.pendingDrain.clear();
    this.keyHeld.clear(); this.segmentSerial.clear();
  }

  get current(): VoiceSession | null {
    return this.active ? { ...this.active } : null;
  }

  session(sessionId: string): VoiceSession | undefined {
    const s = this.byId.get(sessionId);
    return s ? { ...s } : undefined;
  }

  status(sessionId?: string): Record<string, unknown> {
    if (sessionId) {
      const s = this.byId.get(sessionId);
      if (!s) return { ok: false, error: 'session_not_found', sessionId };
      return { ok: true, session: this.metadata(s) };
    }
    return {
      ok: true,
      asrAvailable: this.asrAvailable,
      typer: { available: this.typer.available, id: this.typer.id },
      active: this.active ? this.metadata(this.active) : null,
      closeUnconfirmed: [...this.pendingClose.entries()].map(([deviceId, p]) => ({ deviceId, ...p, expiresAutomatically: false })),
      drainUnconfirmed: [...this.pendingDrain.entries()].map(([deviceId, pending]) => ({ deviceId, ...pending })),
      recovery: this.hasPendingClose() ? {
        automaticExpiry: false,
        hint: '等待同代关麦确认和音频段边界；PTT 需松键及段边界。证据丢失时断开全部设备，待活动会话结束后用 umouse_reconfigure 重启 SDK，再重连设备。共享服务须在所有连接退出、SDK 停止后重连；未确认退出须走本地维护恢复。',
      } : undefined,
      recent: this.history.slice(-10).map((s) => this.metadata(s)),
    };
  }

  // ---------------- Agent 语音问答 ----------------

  async voiceStart(req: {
    prompt?: string;
    deviceId?: string;
    endMode?: 'vad_or_manual' | 'manual_only';
    clientRequestId?: string;
  }): Promise<{ ok: true; sessionId: string; state: VoiceState } | { ok: false; error: string; code: string; detail?: unknown }> {
    if (this.closed) return { ok: false, code: 'shutdown', error: '语音服务已关闭' };
    if (req.clientRequestId) {
      const known = this.requestIndex.get(req.clientRequestId);
      if (known) {
        const s = this.byId.get(known);
        if (s && !TERMINAL_STATES.includes(s.state)) {
          return { ok: true, sessionId: s.sessionId, state: s.state }; // 重复 request_id 幂等返回
        }
      }
    }
    if (this.host.isAudioBusy?.()) return { ok: false, code: 'busy', error: '旧录音或会议正在占用麦克风' };
    if (this.active) {
      return { ok: false, code: 'busy', error: '已有语音会话进行中', detail: { sessionId: this.active.sessionId, state: this.active.state, destination: this.active.destination } };
    }
    if (!this.asrFactory) {
      return { ok: false, code: 'asr_unavailable', error: '识别服务不可用（ASR provider 未配置）' };
    }
    const deviceId = req.deviceId || this.host.defaultDevice();
    if (!deviceId) {
      return { ok: false, code: 'device_unresolved', error: '无法确定语音设备：多台在线时须显式传 device_id' };
    }
    const gate = this.host.checkVoice(deviceId);
    if (!gate.allowed) return { ok: false, code: gate.code, error: gate.message };
    const isolation = this.pendingClose.get(deviceId);
    if (isolation || this.pendingDrain.has(deviceId) || this.keyHeld.has(deviceId)) {
      return { ok: false, code: 'close_unconfirmed', error: '设备关麦或语音键释放尚未确认，禁止重开' };
    }

    const session = this.openSession('agent-request', 'agent-reply', deviceId, req.prompt, req.endMode ?? 'vad_or_manual');
    if (req.clientRequestId) this.requestIndex.set(req.clientRequestId, session.sessionId);
    try {
      this.prevAudioSource = this.host.audioSource();
      const switched = this.host.setAudioSource(deviceId);
      const source = switched instanceof Promise ? await switched : switched;
      if (!this.owns(session) || this.closed) return { ok: false, code: 'session_terminated', error: '语音准备已取消' };
      if (source.ok !== 1) throw new Error('音频源切换失败');
      this.attachAsr(session);
    } catch (error) {
      this.failSession(session, error instanceof Error ? error.message : String(error));
    }
    if (!this.owns(session)) return { ok: false, code: 'asr_unavailable', error: session.error ?? '语音准备失败' };

    session.state = 'opening';
    this.touch(session);
    this.emitUpdate(session, 'opening');
    let writeOk = false;
    // Mark ownership before the call: callbacks may be synchronous in adapters.
    session.timings.createSent = Date.now();
    try {
      const written = this.host.meetingCreate(deviceId);
      writeOk = (written instanceof Promise ? await written : written) === 1;
    } catch { /* uncertain write */ }
    if (!this.owns(session) || this.closed) { this.requestClose(session); return { ok: false, code: 'session_terminated', error: '语音会话已取消' }; }
    if (!writeOk) {
      this.requestClose(session);
      this.restoreAudioSource();
      this.prevAudioSource = null;
      this.disposeProvider();
      session.state = 'failed';
      session.error = 'meeting_create 未下发（未连接/被拦截）';
      this.finishRecord(session);
      return { ok: false, code: 'meeting_create_failed', error: session.error };
    }
    this.armCreateConfirm(session);

    const ready = await this.waitOpening(session);
    if (!ready.ok) {
      return { ok: false, code: ready.code, error: ready.error, detail: ready.detail };
    }
    if (!this.owns(session) || this.closed || session.state !== 'opening') {
      return { ok: false, code: 'session_terminated', error: session.error ?? '语音会话已终止' };
    }
    session.state = 'listening';
    this.touch(session);
    session.timings.listeningAt = Date.now();
    this.armMaxDuration(session);
    this.emitUpdate(session, 'listening');
    if (req.clientRequestId) this.requestIndex.set(req.clientRequestId, session.sessionId);
    return { ok: true, sessionId: session.sessionId, state: session.state };
  }

  async voiceWait(sessionId: string, waitMs: number): Promise<Record<string, unknown>> {
    const s = this.byId.get(sessionId);
    if (!s) return { ok: false, error: 'session_not_found', sessionId };
    if (s.destination !== 'agent-reply') return { ok: false, error: 'destination_mismatch', sessionId };
    if (TERMINAL_STATES.includes(s.state) || s.state === 'ready') {
      return this.resultOf(s);
    }
    let fire!: () => void;
    let timeout: NodeJS.Timeout | undefined;
    const done = new Promise<void>((resolve) => {
      const set = this.waiters.get(sessionId) ?? new Set();
      fire = () => { set.delete(fire); resolve(); };
      set.add(fire);
      this.waiters.set(sessionId, set);
    });
    const timer = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), Math.max(100, Math.min(25_000, waitMs)));
    });
    const outcome = await Promise.race([done.then(() => 'done' as const), timer]);
    clearTimeout(timeout);
    const waiting = this.waiters.get(sessionId);
    waiting?.delete(fire);
    if (!waiting?.size) this.waiters.delete(sessionId);
    const after = this.byId.get(sessionId) ?? s;
    if (outcome === 'timeout' && !(TERMINAL_STATES.includes(after.state) || after.state === 'ready')) {
      return { ok: true, state: after.state, sessionId, pending: true, preview: after.preview, pcmBytes: after.pcmBytes };
    }
    return this.resultOf(after);
  }

  async voiceFinish(sessionId: string): Promise<Record<string, unknown>> {
    const s = this.byId.get(sessionId);
    if (!s) return { ok: false, error: 'session_not_found', sessionId };
    if (this.active !== s) {
      return { ok: true, sessionId, state: s.state, note: '会话已结束，返回现有状态' };
    }
    if (s.state === 'awaiting-key-up') {
      return { ok: false, code: 'awaiting_key_up', error: '用户仍按着语音键（PTT 隔离中），等待松开后收尾' };
    }
    if (!PRE_STOP_STATES.includes(s.state)) {
      return { ok: true, sessionId, state: s.state, note: '会话不在采集态，返回现有状态' };
    }
    this.beginStop(s, 'done-button');
    return { ok: true, sessionId, state: s.state, stopReason: s.stopReason };
  }

  async voiceCancel(sessionId: string): Promise<Record<string, unknown>> {
    const s = this.byId.get(sessionId);
    if (!s) return { ok: false, error: 'session_not_found', sessionId };
    if (this.active !== s || TERMINAL_STATES.includes(s.state)) {
      return { ok: true, sessionId, state: s.state, cancelled: true, note: '会话已终止' };
    }
    // PTT 仍按着键：进入隔离，等待松键（不声称已关麦——物理麦克风由按键控制）
    if (s.destination === 'cursor-dictation' && !s.audioSegmentDrained) {
      this.clearTimers();
      s.state = 'awaiting-key-up';
      s.stopReason = 'cancel';
      s.cleanupRequired = true;
      this.disposeProvider(); // 立即停止消费/保存/转写
      this.armKeyRelease(s);
      this.touch(s);
      this.emitUpdate(s, 'awaiting-key-up');
      this.onEvent('voiceKeyHoldIsolation', { sessionId: s.sessionId, hint: '请松开语音键' }, s.deviceId);
      return { ok: true, sessionId, state: s.state, note: '已停止消费音频并等待松键；未声称设备麦克风已关闭' };
    }
    s.stopReason = 'cancel';
    s.state = s.delivery === 'attempting' ? 'delivery-unknown' : 'cancelled';
    if (s.delivery === 'attempting') s.delivery = 'unknown';
    if (s.destination === 'agent-reply') this.requestClose(s);
    this.finishRecord(s);
    return { ok: true, sessionId, state: s.state, cancelled: true };
  }

  // ---------------- SDK 事件入口（sdk-bridge 调用） ----------------

  onMeetingCreated(deviceId: string): void {
    const s = this.active;
    if (!s || s.deviceId !== deviceId || s.destination !== 'agent-reply' || !this.validGeneration(s)) return;
    if (s.state !== 'opening') return; // 迟到 created：非 opening 不再吃（旧会话清理由 destroy 路径负责）
    s.meetingCreatedConfirmed = true;
    s.timings.createdConfirmed = Date.now();
    this.clearTimer('createConfirm');
    this.touch(s);
    this.maybeListening(s);
  }

  onMeetingCreateFailed(deviceId: string, reason: string): void {
    const s = this.active;
    if (!s || s.deviceId !== deviceId || s.state !== 'opening') return;
    this.clearTimer('createConfirm');
    // 会议建立未被设备确认：SDK 已解除预约。保留清理责任——best-effort destroy
    // 探测（迟到 created 时收尾），不把它当作设备已关麦。
    this.requestClose(s);
    this.restoreAudioSource();
    this.prevAudioSource = null;
    this.disposeProvider();
    s.state = 'failed';
    s.error = `会议建立未被设备确认（${reason}）`;
    s.cleanupRequired = this.pendingClose.has(deviceId);
    s.meetingCreatedConfirmed = false;
    this.clearTimers();
    const opener = (s as VoiceSession & { __openResolve?: (v: { ok: false; code: string; error: string }) => void }).__openResolve;
    if (opener) {
      delete (s as VoiceSession & { __openResolve?: unknown }).__openResolve;
      opener({ ok: false, code: 'meeting_create_failed', error: s.error });
    }
    this.finishRecord(s);
  }

  onMeetingDestroyed(deviceId: string, origin: 'device-frame' | 'transport-down' | 'legacy'): void {
    // 迟到 destroyed 清除 close-unconfirmed 隔离（任何持有者）
    const pending = this.pendingClose.get(deviceId);
    if (pending && origin === 'device-frame' && pending.generation === this.host.generationOf(deviceId)) {
      pending.confirmed = true;
      if (pending.drained) this.pendingClose.delete(deviceId);
      const previous = this.byId.get(pending.sessionId);
      if (previous) { previous.meetingDestroyedConfirmed = true; previous.cleanupRequired = !pending.drained; }
      const t = this.closeTimers.get(pending.sessionId);
      if (t) { clearTimeout(t); this.closeTimers.delete(pending.sessionId); }
      this.onEvent('voiceCloseConfirmedLate', { deviceId, sessionId: pending.sessionId, origin }, deviceId);
    }
    const s = this.active;
    if (!s || s.deviceId !== deviceId || s.destination !== 'agent-reply' || !this.validGeneration(s)) return;
    if (origin === 'device-frame') {
      if (s.timings.destroySent === undefined) {
        s.meetingDestroyedConfirmed = true;
        this.failSession(s, '设备会议意外结束');
        return;
      }
      s.meetingDestroyedConfirmed = true;
      s.cleanupRequired = this.pendingClose.has(deviceId);
      this.clearTimer('closeConfirm');
      this.touch(s);
      if (s.state === 'stop-requested') this.enterDraining(s);
    } else if (origin === 'transport-down' && PRE_STOP_STATES.includes(s.state)) {
      // 异常结束：不是关麦确认；按设备失联收尾
      this.deviceLost(s, 'transport-stall');
    }
  }

  onAudioSegmentComplete(deviceId: string, segment: number, reason: string): void {
    if (this.preparingPtt?.session.deviceId === deviceId) {
      this.preparingPtt.segment = { serial: segment, reason }; return;
    }
    if (!Number.isSafeInteger(segment) || segment <= 0) return;
    const generation = this.host.generationOf(deviceId);
    const prior = this.segmentSerial.get(deviceId);
    if (prior?.generation === generation && segment <= prior.serial) return;
    this.segmentSerial.set(deviceId, { generation, serial: segment });
    const drain = this.pendingDrain.get(deviceId);
    if (drain?.generation === generation && !this.keyHeld.has(deviceId) && (reason === 'key-up' || reason === 'key-up-incomplete')) {
      this.pendingDrain.delete(deviceId);
      const previous = this.byId.get(drain.sessionId);
      if (previous) previous.cleanupRequired = false;
    }
    const pending = this.pendingClose.get(deviceId);
    if (pending?.generation === generation && (reason === 'meeting-destroyed' || reason === 'meeting-destroyed-incomplete')) {
      pending.drained = true;
      const previous = this.byId.get(pending.sessionId);
      if (previous) { previous.audioSegmentDrained = reason === 'meeting-destroyed'; previous.cleanupRequired = !pending.confirmed; }
      if (pending.confirmed) this.pendingClose.delete(deviceId);
    }
    const s = this.active;
    if (!s || s.deviceId !== deviceId || !this.validGeneration(s)) return;
    const expected = s.destination === 'agent-reply' ? 'meeting-destroyed' : 'key-up';
    if (['stop-requested', 'draining', 'awaiting-key-up'].includes(s.state)
        && (s.destination === 'agent-reply' || !this.keyHeld.has(deviceId))
        && (reason === expected || reason === `${expected}-incomplete`)) s.timings.segmentComplete = Date.now();
    if (reason !== expected) {
      if (reason.endsWith('-incomplete') || reason === 'transport-down') this.failSession(s, '音频段不完整，停止交付');
      return;
    }
    if (s.destination === 'cursor-dictation' && this.keyHeld.has(deviceId)) return;
    if (!['stop-requested', 'draining', 'awaiting-key-up'].includes(s.state)) {
      if (CAPTURING_STATES.includes(s.state)) return; // 会议 stall 等异常段边界：采集继续，不结束会话
      return;
    }
    s.audioSegmentDrained = true;
    s.timings.segmentComplete = Date.now();
    this.clearTimer('drain');
    this.touch(s);
    if (s.state === 'awaiting-key-up') {
      this.clearTimer('keyRelease');
      s.cleanupRequired = false;
      if (s.stopReason === 'max-duration' && !s.error) {
        s.state = 'stop-requested'; this.enterFinalizing(s); return;
      }
      s.state = 'cancelled';
      this.finishRecord(s);
      return;
    }
    this.enterFinalizing(s);
  }

  onPcm(deviceId: string, chunk: Buffer): void {
    if (this.preparingPtt?.session.deviceId === deviceId) {
      const p = this.preparingPtt;
      if (p.bytes + chunk.length > 256_000) { this.preparingPtt = null; this.failSession(p.session, '语音准备期间音频超过上限'); return; }
      p.pcm.push(Buffer.from(chunk)); p.bytes += chunk.length; return;
    }
    const s = this.active;
    if (!s || s.deviceId !== deviceId || chunk.length === 0) return;
    if (!this.validGeneration(s)) return;
    if (![...CAPTURING_STATES, 'stop-requested', 'draining'].includes(s.state)) return;
    if (s.audioSegmentDrained || s.stopReason === 'cancel') return;
    s.pcmBytes += chunk.length;
    try { this.provider?.writePcm(chunk); } catch (error) { this.failSession(s, String(error)); return; }
    if (this.active !== s) return;
    this.feedVad(s, chunk);
    if (s.state === 'opening' && s.meetingCreatedConfirmed === true) {
      s.timings.firstPcm = s.timings.firstPcm ?? Date.now();
      this.maybeListening(s);
    } else if (s.state === 'opening') {
      s.timings.firstPcm = s.timings.firstPcm ?? Date.now(); // PCM 先于 created：静音 PCM 同为就绪证据
    }
    if (s.pcmBytes >= (this.config.maxDurationMs / 1000) * 32000) {
      this.beginStop(s, 'max-duration');
    }
  }

  onSpeechKey(deviceId: string, action: 'down' | 'up'): void {
    if (action === 'down') {
      if (this.closed) return;
      if (this.keyHeld.has(deviceId)) return; // duplicate down
      this.keyHeld.add(deviceId);
      if (this.host.isAudioBusy?.()) { this.onEvent('voiceBusy', { reason: 'legacy_audio_busy' }, deviceId); return; }
      if (this.active) {
        // Agent 会议占用期间按语音键只反馈忙碌；不另开听写
        this.onEvent('voiceBusy', {
          sessionId: this.active.sessionId, state: this.active.state,
          destination: this.active.destination, hint: this.active.destination === 'agent-reply' ? 'Agent 语音会话进行中' : '上一条语音正在处理',
        }, deviceId);
        return;
      }
      if (!this.asrFactory) {
        this.onEvent('voiceUnavailable', { reason: 'asr_unavailable', hint: '识别服务不可用，语音键听写未启用' }, deviceId);
        return;
      }
      const gate = this.host.checkVoice(deviceId);
      if (!gate.allowed) {
        this.onEvent('voiceUnavailable', { reason: gate.code, hint: gate.message }, deviceId);
        return;
      }
      const isolation = this.pendingClose.get(deviceId);
      if (isolation || this.pendingDrain.has(deviceId)) {
        this.onEvent('voiceBusy', { reason: 'close_unconfirmed', hint: '上一会话关麦未确认，隔离期内不接受新听写' }, deviceId);
        return;
      }
      const session = this.openSession('physical-speech-button', 'cursor-dictation', deviceId);
      session.state = 'ptt-capturing'; // 不发 meetingCreate：确认字段 not-applicable
      try {
        this.prevAudioSource = this.host.audioSource();
        const source = this.host.setAudioSource(deviceId);
        if (source instanceof Promise) {
          const preparing = { session, pcm: [] as Buffer[], bytes: 0, released: false, segment: undefined as { serial: number; reason: string } | undefined };
          this.preparingPtt = preparing;
          void source.then(result => {
            if (this.preparingPtt !== preparing || !this.owns(session) || this.closed) return;
            this.preparingPtt = null;
            if (result.ok !== 1) throw new Error('音频源切换失败');
            if (session.state === 'ptt-capturing') {
              this.attachAsr(session);
              if (!this.owns(session)) return;
              this.armMaxDuration(session); this.emitUpdate(session, 'ptt-capturing');
              for (const chunk of preparing.pcm) this.onPcm(deviceId, chunk);
            }
            if (preparing.released) this.onSpeechKey(deviceId, 'up');
            if (preparing.segment) this.onAudioSegmentComplete(deviceId, preparing.segment.serial, preparing.segment.reason);
          }).catch(error => {
            if (this.preparingPtt === preparing) this.preparingPtt = null;
            this.failSession(session, String(error));
            if (preparing.released) this.onSpeechKey(deviceId, 'up');
            if (preparing.segment) this.onAudioSegmentComplete(deviceId, preparing.segment.serial, preparing.segment.reason);
          });
          return;
        }
        if (source.ok !== 1) throw new Error('音频源切换失败');
        this.attachAsr(session);
      } catch (error) { this.failSession(session, String(error)); }
      if (!this.owns(session) || (session.state as VoiceState) === 'awaiting-key-up') return;
      this.armMaxDuration(session);
      this.emitUpdate(session, 'ptt-capturing');
      return;
    }
    // key up
    this.keyHeld.delete(deviceId);
    if (this.preparingPtt?.session.deviceId === deviceId) { this.preparingPtt.released = true; return; }
    const s = this.active;
    if (!s || s.deviceId !== deviceId) return;
    if (s.state === 'awaiting-key-up') {
      // Key release is not the decode barrier: retain ownership until its segment event.
      this.emitUpdate(s, 'key-up');
      return;
    }
    if (s.destination !== 'cursor-dictation' || !CAPTURING_STATES.includes(s.state)) return;
    this.beginStop(s, 'key-up');
  }

  onDeviceDisconnected(deviceId: string): void {
    this.keyHeld.delete(deviceId);
    const s = this.active;
    if (!s || s.deviceId !== deviceId) return;
    this.deviceLost(s, 'device-lost');
  }

  onStreamIncomplete(deviceId: string): void {
    const session = this.active;
    if (session && (!deviceId || session.deviceId === deviceId)) this.failSession(session, 'SDK 派发队列丢失音频或控制事件，禁止交付');
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.preparingPtt = null;
    // 唤醒全部等待者：进程退出/重配前 wait 不悬挂
    for (const set of this.waiters.values()) { for (const fire of set) fire(); }
    this.waiters.clear();
    for (const t of this.closeTimers.values()) clearTimeout(t);
    this.closeTimers.clear();
    const s = this.active;
    if (s) {
      s.stopReason = 'cancel';
      s.state = s.delivery === 'attempting' ? 'delivery-unknown' : 'cancelled';
      if (s.delivery === 'attempting') s.delivery = 'unknown';
      if (s.destination === 'agent-reply') this.requestClose(s);
      this.finishRecord(s);
    }
    this.clearTimers();
    this.disposeProvider();
    for (const timer of this.closeTimers.values()) clearTimeout(timer);
    this.closeTimers.clear();
  }

  // ---------------- 内部 ----------------

  private openSession(source: VoiceSession['source'], destination: VoiceSession['destination'], deviceId: string, prompt?: string, endMode: VoiceSession['endMode'] = 'manual_only'): VoiceSession {
    this.vad?.reset();
    this.generation += 1;
    const session: VoiceSession = {
      sessionId: newSessionId(),
      generation: this.generation,
      source, destination, deviceId,
      deviceGeneration: this.host.generationOf(deviceId),
      prompt,
      endMode,
      state: 'preparing',
      meetingCreatedConfirmed: destination === 'agent-reply' ? false : 'not-applicable',
      meetingDestroyedConfirmed: destination === 'agent-reply' ? false : 'not-applicable',
      audioSegmentDrained: false,
      cleanupRequired: false,
      delivery: 'none',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pcmBytes: 0,
      preview: '',
      timings: {},
    };
    this.active = session;
    this.byId.set(session.sessionId, session);
    return session;
  }

  private attachAsr(session: VoiceSession): void {
    this.aggregator = new TextAggregator();
    const aggregator = this.aggregator;
    const events: AsrEvents = {
      preview: (text, meta) => {
        if (!this.isCurrent(session, meta.sessionId)) return;
        if (meta.kind === 'snapshot') session.preview = text;
        else { aggregator.onIntermediate(text); session.preview = aggregator.preview(); }
        this.touch(session);
        this.emitUpdate(session, 'preview');
      },
      segmentFinal: (text, meta) => {
        if (!this.isCurrent(session, meta.sessionId)) return;
        aggregator.onSegmentFinal(text);
        session.preview = aggregator.preview();
        this.touch(session);
        this.emitUpdate(session, 'preview');
      },
      warning: (kind, detail, meta) => {
        if (!this.isCurrent(session, meta.sessionId)) return;
        this.onEvent('voiceAsrWarning', { sessionId: session.sessionId, kind, detail }, session.deviceId);
      },
      terminal: (result, meta) => {
        if (!this.isCurrent(session, meta.sessionId)) return;
        this.onAsrTerminal(session, result);
      },
    };
    const provider = this.asrFactory!(events, { sessionId: session.sessionId, deviceId: session.deviceId });
    if (this.active !== session) { provider.cancel(); return; }
    this.provider = provider;
    this.provider.begin({ sessionId: session.sessionId, deviceId: session.deviceId });
  }

  /** VAD 只对 agent 会话的 vad_or_manual 生效；PTT 不因 VAD 截断 */
  private feedVad(session: VoiceSession, chunk: Buffer): void {
    if (!this.vad) return;
    if (session.destination !== 'agent-reply' || session.endMode !== 'vad_or_manual') return;
    if (!CAPTURING_STATES.includes(session.state)) return; // 收尾中不裁剪；opening 的起声也记账
    const event = this.vad.writePcm(chunk);
    if (!event) return;
    if (event === 'speech-end') {
      this.beginStop(session, 'vad');
    } else if (event === 'no-speech-timeout') {
      // 未起声超时：结束本次输入（stopReason=no-speech），不误当失败
      this.beginStop(session, 'no-speech');
    }
  }

  private isCurrent(session: VoiceSession, sessionId: string): boolean {
    return !this.closed && !this.disposing && session.stopReason !== 'cancel' && session.state !== 'awaiting-key-up'
      && this.byId.get(sessionId) === session && this.active === session && this.validGeneration(session);
  }

  private owns(session: VoiceSession): boolean { return this.active === session; }

  private onAsrTerminal(session: VoiceSession, result: { ok: boolean; cancelled?: boolean; error?: string }): void {
    if (session.state !== 'finalizing') {
      this.failSession(session, result.error ?? '识别服务在音频输入结束前退出');
      return;
    }
    this.clearTimer('asrFinal');
    if (!result.ok) {
      session.state = 'failed';
      session.error = result.error ?? '识别失败';
      this.finishRecord(session);
      return;
    }
    const text = this.aggregator?.freeze() ?? '';
    if (!text.trim()) {
      session.state = 'no-speech';
      session.stopReason = session.stopReason ?? 'no-speech';
      this.finishRecord(session);
      return;
    }
    session.finalText = text;
    session.state = 'ready';
    session.timings.readyAt = Date.now();
    this.touch(session);
    this.emitUpdate(session, 'ready');
    if (session.destination === 'agent-reply') {
      this.finishRecord(session); // 工具等待者取结果；不打字不入旧队列
      return;
    }
    void this.deliver(session);
  }

  private async deliver(session: VoiceSession): Promise<void> {
    if (!this.isCurrent(session, session.sessionId)) return;
    session.state = 'delivering';
    session.delivery = 'attempting';
    this.touch(session);
    this.emitUpdate(session, 'delivering');
    const text = session.finalText!;
    try {
      const r = await this.typer.deliver({ sessionId: session.sessionId, text, deviceId: session.deviceId });
      if (!this.isCurrent(session, session.sessionId)) return;
      if (r.outcome === 'submitted') {
        session.delivery = 'submitted';
        session.state = 'delivered';
        session.timings.deliveredAt = Date.now();
      } else if (r.outcome === 'unavailable') {
        session.delivery = 'failed';
        session.state = 'ready'; // 保留结果供用户处理
        session.error = `输入不可用：${r.error}`;
      } else {
        session.delivery = 'unknown';
        session.state = 'delivery-unknown';
        session.error = r.error;
      }
    } catch (error) {
      if (this.active !== session) return;
      session.delivery = 'unknown';
      session.state = 'delivery-unknown';
      session.error = error instanceof Error ? error.message : String(error);
    }
    this.finishRecord(session);
  }

  private beginStop(session: VoiceSession, reason: StopReason, opts: { cancelled?: boolean } = {}): void {
    if (!CAPTURING_STATES.includes(session.state)) return; // 只有一次 finish 获胜（stop-requested 起为收尾态）
    this.clearTimer('maxDuration');
    session.stopReason = reason;
    if (session.destination === 'cursor-dictation' && this.keyHeld.has(session.deviceId)) {
      session.state = 'awaiting-key-up';
      session.cleanupRequired = true;
      this.clearTimers();
      if (reason !== 'max-duration') this.disposeProvider();
      this.armKeyRelease(session);
      this.emitUpdate(session, 'awaiting-key-up');
      this.onEvent('voiceKeyHoldIsolation', { sessionId: session.sessionId, hint: '请松开语音键' }, session.deviceId);
      return;
    }
    session.state = 'stop-requested';
    session.timings.stopRequested = Date.now();
    this.touch(session);
    this.emitUpdate(session, 'stop-requested');
    if (opts.cancelled) {
      // 取消：立即停止转写（结果不可消费），设备清理后台进行
      this.disposeProvider();
    }
    if (session.destination === 'agent-reply') {
      this.requestClose(session);
      void 0;
      this.armDrain(session);
    } else {
      this.armDrain(session);
    }
  }

  private enterDraining(session: VoiceSession): void {
    if (session.state !== 'stop-requested') return;
    session.state = 'draining';
    this.touch(session);
    this.emitUpdate(session, 'draining');
  }

  private enterFinalizing(session: VoiceSession): void {
    if (!['stop-requested', 'draining'].includes(session.state)) return;
    if (session.stopReason === 'cancel') {
      session.state = 'cancelled';
      this.finishRecord(session);
      return;
    }
    session.state = 'finalizing';
    session.timings.finalizingAt = Date.now();
    this.touch(session);
    this.emitUpdate(session, 'finalizing');
    this.armAsrFinal(session);
    try { this.provider?.finishInput(); } catch (error) { this.failSession(session, String(error)); }
  }

  private deviceLost(session: VoiceSession, reason: StopReason): void {
    if (session.destination === 'agent-reply') this.requestClose(session);
    this.clearTimers();
    this.restoreAudioSource();
    this.prevAudioSource = null;
    this.disposeProvider();
    session.stopReason = reason;
    session.state = 'failed';
    session.error = reason === 'device-lost' ? '设备断开，本次语音输入中止' : '传输异常结束，本次语音输入中止';
    session.cleanupRequired = session.destination === 'agent-reply';
    this.finishRecord(session);
  }

  private maybeListening(session: VoiceSession): void {
    if (session.state !== 'opening') return;
    if (session.meetingCreatedConfirmed === true && session.timings.firstPcm) {
      const waiter = (session as VoiceSession & { __openResolve?: (v: { ok: true } | { ok: false; code: string; error: string; detail?: unknown }) => void }).__openResolve;
      waiter?.({ ok: true });
    }
  }

  private waitOpening(session: VoiceSession): Promise<{ ok: true } | { ok: false; code: string; error: string; detail?: unknown }> {
    return new Promise((resolve) => {
      const s = session as VoiceSession & { __openResolve?: (v: { ok: true } | { ok: false; code: string; error: string; detail?: unknown }) => void };
      s.__openResolve = (v) => {
        delete s.__openResolve;
        this.clearTimer('pcmReady');
        this.clearTimer('createConfirm');
        resolve(v);
      };
      // 已就绪（事件先于等待到达）
      if (session.meetingCreatedConfirmed === true && session.timings.firstPcm) {
        s.__openResolve({ ok: true });
        return;
      }
      const deadline = this.config.createConfirmWaitMs + this.config.pcmReadyWaitMs;
      const t = setTimeout(() => {
        if (s.__openResolve) {
          // 超时：会议建立/音频未就绪——清理（destroy 探测 + 还原音频源）
          this.requestClose(session);
          this.restoreAudioSource();
          this.prevAudioSource = null;
          this.disposeProvider();
          session.state = 'failed';
          session.error = session.meetingCreatedConfirmed !== true
            ? `会议建立确认超时（${this.config.createConfirmWaitMs}ms）`
            : `音频未到达（created 后 ${this.config.pcmReadyWaitMs}ms）`;
          session.cleanupRequired = true;
          this.beginIsolation(session);
          const opener = s.__openResolve;
          if (opener) {
            delete s.__openResolve;
            opener({ ok: false, code: 'opening_timeout', error: session.error });
          }
          this.finishRecord(session);
        }
      }, deadline);
      // A public voiceStart is still awaiting this deadline; keep its timer referenced.
      this.timers.pcmReady = t;
    });
  }

  private armCreateConfirm(session: VoiceSession): void {
    const t = setTimeout(() => {
      // created 未到（SDK 3s 应上抛 meetingCreateFailed；此为兜底）
      if (this.active === session && session.state === 'opening' && session.meetingCreatedConfirmed !== true) {
        this.onMeetingCreateFailed(session.deviceId, 'confirm-timeout-fallback');
      }
    }, this.config.createConfirmWaitMs + 1000);
    t.unref();
    this.timers.createConfirm = t;
  }

  private armMaxDuration(session: VoiceSession): void {
    const t = setTimeout(() => {
      if (this.active === session && PRE_STOP_STATES.includes(session.state)) {
        this.beginStop(session, 'max-duration');
      }
    }, this.config.maxDurationMs);
    t.unref();
    this.timers.maxDuration = t;
  }

  private armDrain(session: VoiceSession): void {
    const t = setTimeout(() => {
      if (this.active !== session) return;
      if (session.state === 'stop-requested' || session.state === 'draining') {
        // 段完成边界未到：如实记录未冲刷确认，不假装完成（继续收尾，标注可能丢尾）
        session.audioSegmentDrained = false;
        this.onEvent('voiceDrainTimeout', { sessionId: session.sessionId, note: 'audioSegmentComplete 未在窗口内到达，尾部音频可能缺失' }, session.deviceId);
        this.failSession(session, 'audioSegmentComplete 超时，禁止交付不完整音频');
      }
    }, this.config.drainWaitMs);
    t.unref();
    this.timers.drain = t;
  }

  private armCloseConfirm(session: VoiceSession): void {
    const t = setTimeout(() => {
      if (this.byId.get(session.sessionId) !== session) return;
      this.closeTimers.delete(session.sessionId);
      if (session.meetingDestroyedConfirmed !== true) {
        session.meetingDestroyedConfirmed = false;
        session.cleanupRequired = true;
        this.beginIsolation(session);
        this.onEvent('voiceCloseUnconfirmed', { sessionId: session.sessionId, deviceId: session.deviceId }, session.deviceId);
      }
    }, this.config.closeConfirmWaitMs);
    t.unref();
    this.closeTimers.set(session.sessionId, t);
  }

  private armAsrFinal(session: VoiceSession): void {
    const t = setTimeout(() => {
      if (this.active === session && session.state === 'finalizing') {
        // No terminal evidence: fail closed rather than typing a partial hypothesis.
        this.onEvent('voiceAsrFinalTimeout', { sessionId: session.sessionId }, session.deviceId);
        this.onAsrTerminal(session, { ok: false, error: '识别终态超时' });
      }
    }, this.config.asrFinalWaitMs);
    t.unref();
    this.timers.asrFinal = t;
  }

  private beginIsolation(session: VoiceSession): void {
    if (session.meetingDestroyedConfirmed === true && (session.audioSegmentDrained || session.timings.segmentComplete !== undefined)) return;
    session.cleanupRequired = true;
    const stored = this.pendingClose.get(session.deviceId);
    const previous = stored?.generation === session.deviceGeneration ? stored : undefined;
    this.pendingClose.set(session.deviceId, { sessionId: session.sessionId, generation: session.deviceGeneration,
      confirmed: session.meetingDestroyedConfirmed === true || previous?.confirmed === true,
      drained: session.audioSegmentDrained || session.timings.segmentComplete !== undefined || previous?.drained === true });
  }

  private disposeProvider(): void {
    const provider = this.provider;
    this.provider = null;
    this.aggregator = null;
    this.disposing = true;
    try { provider?.cancel(); } catch { /* cancellation remains final */ }
    finally { this.disposing = false; }
    this.vad?.reset();
  }

  private validGeneration(session: VoiceSession): boolean {
    if (this.host.isOnline(session.deviceId) && this.host.generationOf(session.deviceId) === session.deviceGeneration) return true;
    if (this.active === session) this.deviceLost(session, 'device-lost');
    return false;
  }

  private requestClose(session: VoiceSession): void {
    if (session.destination !== 'agent-reply' || session.timings.createSent === undefined) return;
    this.beginIsolation(session);
    // A cleanup command must never be sent to a replacement device generation.
    if (!this.host.isOnline(session.deviceId) || this.host.generationOf(session.deviceId) !== session.deviceGeneration) return;
    if (session.meetingDestroyedConfirmed === true) return;
    if (session.timings.destroySent !== undefined) return;
    session.timings.destroySent = Date.now();
    this.armCloseConfirm(session);
    try { void Promise.resolve(this.host.meetingDestroy(session.deviceId)).catch(() => {}); } catch { /* retain cleanup responsibility */ }
  }

  private restoreAudioSource(): void {
    try { void Promise.resolve(this.host.setAudioSource(this.prevAudioSource || null)).catch(() => {
      this.onEvent('warning', { component: 'voice', code: 'audio_source_restore_failed' }, '');
    }); } catch { this.onEvent('warning', { component: 'voice', code: 'audio_source_restore_failed' }, ''); }
  }

  private failSession(session: VoiceSession, error: string): void {
    if (this.active !== session) return;
    session.error = error;
    this.requestClose(session);
    if (session.destination === 'cursor-dictation' && this.keyHeld.has(session.deviceId)) {
      session.stopReason = 'cancel';
      session.state = 'awaiting-key-up';
      session.cleanupRequired = true;
      this.clearTimers();
      this.disposeProvider();
      this.armKeyRelease(session);
      this.emitUpdate(session, 'awaiting-key-up');
      return;
    }
    if (session.destination === 'cursor-dictation' && !session.audioSegmentDrained && session.timings.segmentComplete === undefined) {
      session.cleanupRequired = true;
      this.pendingDrain.set(session.deviceId, { sessionId: session.sessionId, generation: session.deviceGeneration });
    }
    session.state = 'failed';
    this.finishRecord(session);
  }

  private metadata(session: VoiceSession): Record<string, unknown> {
    const { preview, finalText, prompt, error, ...metadata } = session;
    return { ...metadata, hasError: !!error };
  }

  private armKeyRelease(session: VoiceSession): void {
    this.clearTimer('keyRelease');
    session.timings.awaitingKeySince ??= Date.now();
    this.timers.keyRelease = setTimeout(() => {
      if (!this.owns(session) || session.state !== 'awaiting-key-up') return;
      session.cleanupRequired = true;
      this.pendingDrain.set(session.deviceId, { sessionId: session.sessionId, generation: session.deviceGeneration });
      session.state = 'failed'; session.stopReason = 'cancel';
      session.error = '语音键释放或音频段边界超时；已结束本会话，设备仍隔离，请松键或按 voice_status 恢复指引处理';
      this.finishRecord(session);
    }, Math.max(1, this.config.maxDurationMs - (Date.now() - session.timings.awaitingKeySince)));
    this.timers.keyRelease.unref();
  }

  private clearTimer(key: keyof TimerBag): void {
    const t = this.timers[key];
    if (t) clearTimeout(t);
    delete this.timers[key];
  }

  private clearTimers(): void {
    for (const key of Object.keys(this.timers) as Array<keyof TimerBag>) this.clearTimer(key);
  }

  private touch(session: VoiceSession): void {
    session.updatedAt = Date.now();
  }

  private emitUpdate(session: VoiceSession, change: string): void {
    this.onEvent('voiceSession', { sessionId: session.sessionId, state: session.state, change, destination: session.destination, source: session.source, deviceId: session.deviceId }, session.deviceId);
    this.emit('update', session, change);
  }

  private resultOf(s: VoiceSession): Record<string, unknown> {
    const base: Record<string, unknown> = {
      ok: true, sessionId: s.sessionId, state: s.state, stopReason: s.stopReason ?? null,
      destination: s.destination, pcmBytes: s.pcmBytes,
      meetingDestroyedConfirmed: s.meetingDestroyedConfirmed,
      audioSegmentDrained: s.audioSegmentDrained, delivery: s.delivery,
      timings: s.timings,
    };
    if (s.finalText !== undefined) base.text = s.finalText;
    if (s.error !== undefined) base.error = s.error;
    return base;
  }

  /** 终态收口：清资源、入历史、唤醒等待者（唯一出口） */
  private finishRecord(session: VoiceSession): void {
    if (this.history.includes(session)) return;
    if (this.preparingPtt?.session === session) this.preparingPtt = null;
    this.clearTimers();
    // opening 等待者兜底：任何异常终态（createFailed/设备失联/超时）都释放 voiceStart 的等待
    const holder = session as VoiceSession & { __openResolve?: (v: { ok: false; code: string; error: string }) => void };
    if (holder.__openResolve) {
      const resolve = holder.__openResolve;
      delete holder.__openResolve;
      resolve({ ok: false, code: 'session_terminated', error: session.error ?? `语音会话异常终止（state=${session.state}）` });
    }
    if (this.active === session) {
      this.active = null;
      if (this.prevAudioSource !== null) {
        this.restoreAudioSource();
        this.prevAudioSource = null;
      }
    }
    this.disposeProvider();
    this.touch(session);
    this.history.push(session);
    if (this.history.length > 100) {
      const retired = this.history.shift()!;
      this.byId.delete(retired.sessionId);
      for (const [key, id] of this.requestIndex) if (id === retired.sessionId) this.requestIndex.delete(key);
    }
    this.emitUpdate(session, 'terminal');
    const set = this.waiters.get(session.sessionId);
    if (set) {
      this.waiters.delete(session.sessionId);
      for (const fire of set) fire();
    }
  }
}
