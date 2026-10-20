/*
 * sdk-bridge.ts —— 进程内唯一 UMouseSdk 实例的托管层
 *
 * 职责：
 *  - 按 BridgeConfig 完成 init-前配置序列并 start()（工作模式/USB/BLE/设备上限）
 *  - 把绑定 EventEmitter 的 5 类回调规整为带 seq 的事件入环形缓冲
 *  - 命令类调用的统一入口（未启动时返回可读错误）
 *  - 受控重启（reconfigure）与严格退出序列（unregister → drain → stop，
 *    防 koffi 跨线程投递与 um_sdk_close join 互锁，见绑定文件头注释）
 *  - 语音键自动录音会话（speech down→up 界定，产出 speechCaptured 事件）
 *
 * SDK 源码树（src/include/vendor/doc）零改动：绑定经 createRequire 原样加载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { BridgeConfig, UmBleConfig, UmUsbConfig } from './env.js';
import { EventBuffer, UmEvent } from './events.js';
import { DeviceRegistry } from './state.js';
import { AudioRecorder, RecordResult } from './audio.js';
import { InjectController } from './inject.js';
import { createCursorReader, CursorReader } from './cursor-pos.js';
import { takeoverState } from './takeover.js';
import { VoiceInbox } from './voice.js';
import { createTranscriber } from './transcriber.js';
import { SdkLease, type DeviceLease } from './sdk-lease.js';
import { SleepResetController } from './sleep-reset.js';
import { DeviceCapabilityRegistry } from './device-capabilities.js';
import { CapabilityGate } from './capability-gate.js';
import { VoiceCoordinator, DEFAULT_VOICE_CONFIG, type VoiceHostAdapter } from './voice-session.js';
import { createBatchAsrProviderFactory } from './asr-service.js';
import { createSinicloudStreamFactory } from './sinicloud-asr.js';
import { withSnapshotPreview } from './asr-service.js';
import { createVad } from './voice-vad.js';
import { VoiceUiController } from './voice-ui.js';
import { createRealTyper } from './voice-typer-binding.js';
import { createUnavailableTyper } from './voice-typer.js';
import type { TestCapabilityProfile } from './env.js';

const require = createRequire(import.meta.url);
// doc/umouse-sdk.js 是 CJS 且内部 require('koffi')——依赖必须装在仓库根 node_modules
const binding = require('../../doc/umouse-sdk.js') as {
  UMouseSdk: new (libPath?: string) => UMouseSdkBinding;
  UM_MODE: { FULL: 0; RAW: 1 };
  UM_CHAN: { AUTO: 0; USB: 1; BLE: 2 };
};
const { UM_MODE, UM_CHAN } = binding;

interface UMouseSdkBinding extends EventEmitter {
  version(): string;
  isStarted(): boolean;
  enableCrashReport(enable: number): void;
  setWorkMode(mode: number): number;
  setDeviceLimit(ruleId: string | null, max: number): number;
  setUsbConfigFor(ruleId: string | null, cfg: { vid: number; pid: number; iface: number; reportId: number }): number;
  setBleConfigFor(
    ruleId: string | null,
    cfg: { name?: string | null; macPrefix?: string | null; service?: string | null; characteristic?: string | null }
  ): number;
  setChannelPref(pref: number): number;
  setChannelPrefFor(deviceId: string | null, pref: number): number;
  setAudioSource(deviceId: string | null): number;
  audioSource(): string;
  writeRaw(buf: Buffer, deviceId?: string | null): number;
  setDpi(level: number, deviceId?: string | null): number;
  meetingCreate(deviceId?: string | null): number;
  meetingDestroy(deviceId?: string | null): number;
  meetingPause(deviceId?: string | null): number;
  meetingResume(deviceId?: string | null): number;
  injectMouse(buttons: number, dx: number, dy: number, wheel: number, deviceId?: string | null): number;
  injectKeyboard(modifiers: number, usageIds: number[], deviceId?: string | null): number;
  deviceCount(): number;
  deviceList(): { id: string; mode: string }[];
  start(debug?: number): void;
  stop(): void;
  unregisterCallbacks(): void;
}

export interface ReconfigureRequest {
  workMode?: 'FULL';
  deviceLimit?: number;
  usb?: UmUsbConfig | null;
  ble?: UmBleConfig | null;
  debug?: number;
  speechAutoRecord?: boolean;
}

const CHANNEL_NAMES = ['AUTO', 'USB', 'BLE'] as const;
type ChannelName = (typeof CHANNEL_NAMES)[number];

function chanToNum(pref: ChannelName): number {
  return UM_CHAN[pref];
}

export class SdkBridge extends EventEmitter {
  readonly events: EventBuffer;
  readonly devices = new DeviceRegistry();
  recorder: AudioRecorder;
  readonly inject: InjectController;
  readonly injectionEnabled: boolean;
  readonly cursorReader: CursorReader | null;
  readonly sleepReset: SleepResetController;
  /** v2：设备能力注册表与执行门控 */
  readonly capabilities = new DeviceCapabilityRegistry();
  readonly gate: CapabilityGate;
  /** v2：语音协调器（voiceEnabled=false 时为 null，旧链路保留） */
  readonly voiceCoord: VoiceCoordinator | null;
  readonly voiceUi: VoiceUiController | null;
  private readonly voiceTyper: ReturnType<typeof createRealTyper> | ReturnType<typeof createUnavailableTyper>;
  private voiceInbox: VoiceInbox | undefined;
  private readonly sdkLease: DeviceLease | null;
  waitingForSdk = false;

  private sdk: UMouseSdkBinding | null = null;
  private cfg: BridgeConfig;
  private booted = false; // 进程启动期已完成 chdir/PATH 处理
  private lastDeviceInfoSig = new Map<string, string>(); // deviceId → 最近入流的 deviceInfo 签名
  private lifecycle: Promise<unknown> = Promise.resolve();
  started = false;
  startedAt = 0;
  lastError: string | undefined;
  sdkVersion: string | undefined;
  private legacyMeetings = new Set<string>();
  private legacyCloseConfirmed = new Set<string>();
  private legacyDrained = new Set<string>();
  private inputHoldEpochs = new Map<string, number>();
  private voiceInputGuard?: () => void;

  setVoiceInputGuard(guard: () => void): void { this.voiceInputGuard = guard; }

  constructor(cfg: BridgeConfig, dependencies: { lease?: DeviceLease | null } = {}) {
    super();
    this.cfg = cfg;
    this.events = new EventBuffer(cfg.eventBuffer);
    this.sdkLease = dependencies.lease === undefined ? new SdkLease(undefined, () => {
      // Fence all new work synchronously; never rebind while a live SDK may remain.
      this.started = false; this.waitingForSdk = false; this.sleepReset.stop();
      this.lastError = 'SDK 占用锁异常，已停止准入并关闭 SDK；请检查后重启 MCP';
      void this.shutdown().catch(() => { this.lastError = 'SDK 占用锁异常且退出未确认，禁止继续操作'; });
    }) : dependencies.lease;
    // ---- v2 能力门控：测试配置声明 + 执行层 ----
    this.gate = new CapabilityGate(this.capabilities, { disabled: {
      ...(!cfg.injection ? { mouse_control: true as const, keyboard_control: true as const } : {}),
      ...(!cfg.keyboardInjection ? { keyboard_control: true as const } : {}),
    } }, { isOnline: (id) => this.started && this.safeDeviceList().some((d) => d.id === id) });
    // 批量 provider（windows-speech/whisper/http）附加本地快照预览（默认开）
    const voiceAsrFactory = cfg.asr
      ? (cfg.voicePreview
          ? withSnapshotPreview(createBatchAsrProviderFactory(createTranscriber(cfg.asr)), createTranscriber(cfg.asr))
          : createBatchAsrProviderFactory(createTranscriber(cfg.asr)))
      : cfg.asrProvider === 'sinicloud' && cfg.asrSinicloud
          ? createSinicloudStreamFactory({
              credentials: cfg.asrSinicloud.load,
              timeoutMs: cfg.asrSinicloud.timeoutMs,
              onDiagnostic: (info) => this.emitEvent(this.events.push('', 'warning', { component: 'sinicloud', ...info })),
            })
          : null;
    const voiceTyper = cfg.voiceEnabled && cfg.voiceTyper
      ? createRealTyper({
          ledgerDir: path.join(cfg.dataDir, 'voice-v2'),
          beforeInput: () => { if (!this.started) throw new Error('sdk_unavailable'); this.voiceInputGuard?.(); },
          onDiagnostic: (info) => this.emitEvent(this.events.push('', 'warning', { component: 'voice-typer', ...info })),
        })
      : null;
    this.voiceTyper = voiceTyper ?? createUnavailableTyper();
    this.voiceCoord = cfg.voiceEnabled ? new VoiceCoordinator(
      this.voiceHostAdapter(),
      voiceAsrFactory,
      this.voiceTyper,
      { ...DEFAULT_VOICE_CONFIG, maxDurationMs: cfg.voiceMaxMs,
        asrFinalWaitMs: Math.max(DEFAULT_VOICE_CONFIG.asrFinalWaitMs, (cfg.asr?.timeoutMs ?? 60_000) + 1000) },
      (type, payload, deviceId) => this.emitEvent(this.events.push(deviceId, type, payload)),
      createVad(cfg.voiceVad, { endSilenceMs: cfg.voiceEndSilenceMs, firstSpeechMs: cfg.voiceFirstSpeechMs }),
    ) : null;
    // 录音浮窗：协调器 update 事件驱动；按钮指令按会话身份回投 finish/cancel
    this.voiceUi = this.voiceCoord && cfg.voiceUi
      ? new VoiceUiController({
          exePath: cfg.voiceUiPath ?? null,
          onFinish: (sessionId) => { void this.voiceCoord?.voiceFinish(sessionId); },
          onCancel: (sessionId) => { void this.voiceCoord?.voiceCancel(sessionId); },
          onDiagnostic: (info) => this.emitEvent(this.events.push('', 'warning', { component: 'voice-ui', ...info })),
        })
      : null;
    if (this.voiceCoord && this.voiceUi) {
      this.voiceCoord.on('update', (session, change) => {
        this.voiceUi!.onSessionUpdate({
          sessionId: session.sessionId, state: session.state, destination: session.destination,
          preview: session.preview ?? '', createdAt: session.createdAt, change,
        });
      });
    }
    // 通配测试能力声明（"*" 作用于每台实际接入的设备；设备专有条目在接入时套用）
    this.wildcardTestCaps = cfg.voiceTestCaps['*'] ?? null;
    this.recorder = new AudioRecorder(
      path.join(cfg.dataDir, 'audio'),
      cfg.audioMaxSeconds,
      cfg.audioQuotaMb,
      (r) => this.emitAutoCaptured(r),
      (error) => this.emitEvent(this.events.push('', 'warning', { error }))
    );
    this.injectionEnabled = cfg.injection;
    this.cursorReader = createCursorReader();
    // 注入编排层：sender 闭包动态取当前 SDK 实例（reconfigure 重建后仍有效）；
    // Windows 下附带光标回读 → 闭环绝对定位（moveTo/clickAt）。
    // v2：帧写入共享能力校验——非零动作帧过 CapabilityGate；全零帧是
    // 本进程已持有通道的受限清理，不因能力撤销被阻止（必要释放不能被禁用规则
    // 卡死），换代/离线仍由注入层的 epoch 守卫拦截。
    const frameGate = (isCleanup: boolean, deviceId: string | undefined, capability: 'mouse_control' | 'keyboard_control'): boolean => {
      const id = this.resolveInjectDevice(deviceId);
      const heldEpoch = this.inputHoldEpochs.get(`${id}:${capability}`);
      if (isCleanup && heldEpoch !== undefined) {
        return this.started && this.safeDeviceList().some(d => d.id === id) && heldEpoch === this.devices.generationOf(id);
      }
      return this.gate.check(id, capability).allowed;
    };
    const send = (id: string | undefined, capability: string, held: boolean, write: () => number) => {
      const device = this.resolveInjectDevice(id), key = `${device}:${capability}`;
      if (held) this.inputHoldEpochs.set(key, this.devices.generationOf(device));
      const rc = write(); // retain uncertain hold if the native call throws
      if (rc === 1 && !held) this.inputHoldEpochs.delete(key);
      return rc;
    };
    this.inject = new InjectController(
      {
        mouse: (buttons, dx, dy, wheel, deviceId) =>
          frameGate(buttons === 0 && dx === 0 && dy === 0 && wheel === 0, deviceId, 'mouse_control')
            ? send(deviceId, 'mouse_control', buttons !== 0, () => this.requireStarted().injectMouse(buttons, dx, dy, wheel, deviceId ?? null))
            : 0,
        keyboard: (modifiers, usageIds, deviceId) =>
          frameGate(modifiers === 0 && usageIds.every((k) => k === 0), deviceId, 'keyboard_control')
            ? send(deviceId, 'keyboard_control', modifiers !== 0 || usageIds.some(k => k !== 0), () => this.requireStarted().injectKeyboard(modifiers, usageIds, deviceId ?? null))
            : 0,
      },
      { frameMs: cfg.injectFrameMs, clickMs: cfg.injectClickMs, keyboardEnabled: cfg.keyboardInjection, feedbackTimeoutMs: cfg.injectFeedbackMs },
      this.cursorReader ? () => this.cursorReader!.read() : undefined
    );
    this.sleepReset = new SleepResetController(
      (data, deviceId) => this.requireStarted().writeRaw(data, deviceId),
      {
        enabled: cfg.sleepResetEnabled,
        intervalMs: cfg.sleepResetIntervalMs,
        expectAck: cfg.sleepResetExpectAck,
        ackTimeoutMs: cfg.sleepResetAckTimeoutMs,
        onEvent: (id, payload) => this.emitEvent(this.events.push(id, 'sleepReset', payload)),
      }
    );
  }

  private readonly wildcardTestCaps: Record<string, 'supported' | 'unsupported' | 'unknown'> | null;

  /** 注入帧的目标设备解析（未指定时取唯一在线；多台/零台返回 '' 由门控拒绝） */
  private resolveInjectDevice(deviceId?: string): string {
    if (deviceId) return deviceId;
    const devices = this.safeDeviceList();
    return devices.length === 1 ? devices[0].id : '';
  }

  private async shutdownVoiceUi(): Promise<void> {
    try { this.voiceUi?.dispose(); } catch { /* 幂等 */ }
  }

  private async voiceTyperShutdown(): Promise<void> {
    const t = this.voiceTyper as { shutdown?: () => Promise<void> };
    try { await t.shutdown?.(); } catch { /* 幂等 */ }
  }

  /** VoiceCoordinator 的宿主适配（动态委托，reconfigure 后仍指向当前实例） */
  private voiceHostAdapter(): VoiceHostAdapter {
    return {
      meetingCreate: (id) => { try { return this.requireStarted().meetingCreate(id); } catch { return 0; } },
      meetingDestroy: (id) => { try { return this.requireStarted().meetingDestroy(id); } catch { return 0; } },
      setAudioSource: (id) => {
        try { const sdk = this.requireStarted(); return { ok: sdk.setAudioSource(id), source: sdk.audioSource() }; }
        catch { return { ok: 0, source: '' }; }
      },
      audioSource: () => this.safeAudioSource(),
      isOnline: (id) => this.safeDeviceList().some((d) => d.id === id),
      generationOf: (id) => this.devices.generationOf(id),
      defaultDevice: () => this.currentAudioDevice(),
      checkVoice: (id) => this.gate.check(id, 'voice'),
      isAudioBusy: () => this.recorder.status().recording || this.legacyMeetings.size > 0,
    };
  }

  /** 启动（可重复调用：reconfigure 内部复用）。失败不抛出，置 lastError 并返回 ok:false */
  async start(): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.serializeLifecycle(() => this.startCore());
  }

  get voice(): VoiceInbox {
    if (!this.voiceInbox) throw new Error('语音收件箱尚未打开：本进程正在等待 SDK 所有权或 SDK 启动失败');
    return this.voiceInbox;
  }

  private async startCore(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.started) return { ok: true };
    // 上次退出摘回调期间可能仍收到 connected；不得把旧会话登记带入新 SDK。
    this.sleepReset.stop();
    try {
      this.waitingForSdk = false;
      if (this.sdkLease && !await this.sdkLease.tryAcquire()) {
        this.waitingForSdk = this.sdkLease.status().state === 'busy';
        this.lastError = this.waitingForSdk ? 'SDK 已由其它 MCP 进程占用；当前连接保持可用并等待释放' : 'SDK 占用锁不可用';
        return { ok: false, error: this.lastError };
      }
      // Only the SDK owner may load/recover/prune the persistent inbox.
      this.voiceInbox ??= new VoiceInbox(path.join(this.cfg.dataDir, 'voice'), this.cfg.asr ? createTranscriber(this.cfg.asr) : null, {
        onEvent: (type, payload, id) => this.emitEvent(this.events.push(id, type, payload)),
      });
      this.prepareBoot();
      const sdk = this.sdk ?? new binding.UMouseSdk(this.cfg.libPath);
      sdk.removeAllListeners();
      this.sdk = sdk;
      this.sdkVersion = sdk.version();

      // ---- init 前（init 时锁定/快照） ----
      if (!sdk.setWorkMode(UM_MODE.FULL)) throw new Error('um_set_work_mode 未采纳');
      if (!sdk.setDeviceLimit(null, this.cfg.deviceLimit)) throw new Error('um_set_device_limit 未采纳');
      if (this.cfg.usb) {
        const r = sdk.setUsbConfigFor(null, {
          vid: this.cfg.usb.vid,
          pid: this.cfg.usb.pid,
          iface: this.cfg.usb.iface,
          reportId: this.cfg.usb.reportId,
        });
        if (!r) throw new Error('um_set_usb_config 未采纳（参数非法或 SDK 已启动）');
      }
      if (this.cfg.ble) {
        const r = sdk.setBleConfigFor(null, {
          name: this.cfg.ble.name ?? null,
          macPrefix: this.cfg.ble.macPrefix ?? null,
          service: this.cfg.ble.service ?? null,
          characteristic: this.cfg.ble.characteristic ?? null,
        });
        if (!r) throw new Error('um_set_ble_config 未采纳');
      }
      sdk.enableCrashReport(this.cfg.crashReport ? 1 : 0);

      // ---- 事件接线（回调线程内只做 O(1) 拷贝/入缓冲，绝无阻塞调用） ----
      sdk.on('connected', (id: string, mode: number) => {
        this.devices.onConnected(id, mode);
        // v2：换代重建能力快照（hardware-info 作废），套用通配/专属测试声明
        this.capabilities.onGenerationChange(id, this.devices.generationOf(id));
        this.applyTestCapsFor(id);
        this.sleepReset.onConnected(id, mode);
        this.emitEvent(this.events.push(id, 'connected', { connMode: mode === 1 ? 'BLE' : 'USB' }));
      });
      sdk.on('disconnected', (id: string, mode: number) => {
        this.legacyMeetings.delete(id);
        this.legacyCloseConfirmed.delete(id); this.legacyDrained.delete(id);
        this.voiceCoord?.onDeviceDisconnected(id);
        this.devices.onDisconnected(id);
        this.capabilities.onDeviceOffline(id);
        this.sleepReset.onDisconnected(id);
        this.lastDeviceInfoSig.delete(id);
        this.emitEvent(this.events.push(id, 'disconnected', { connMode: mode === 1 ? 'BLE' : 'USB' }));
      });
      sdk.on('message', (json: string, id: string) => {
        let obj: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(json);
          obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown> : { type: 'unparsed', raw: json };
        } catch {
          obj = { type: 'unparsed', raw: json };
        }
        const type = typeof obj.type === 'string' ? obj.type : 'unknown';
        if (this.legacyMeetings.has(id)) {
          if (type === 'meetingDestroyed' && obj.origin === 'device-frame') this.legacyCloseConfirmed.add(id);
          if (type === 'audioSegmentComplete' && (obj.reason === 'meeting-destroyed' || obj.reason === 'meeting-destroyed-incomplete')) this.legacyDrained.add(id);
          if (this.legacyCloseConfirmed.has(id) && this.legacyDrained.has(id)) {
            this.legacyMeetings.delete(id); this.legacyCloseConfirmed.delete(id); this.legacyDrained.delete(id);
          }
        }
        if (type === 'deviceInfo') {
          // 心跳去重：deviceInfo 随帧高频上报（音频流期间可达 ~14 条/s），
          // 仅在关键字段变化时入事件流（首条必入）；状态聚合不受影响
          this.devices.onDeviceInfo(id, obj as never);
          const sig = `${obj.battery}|${obj.deviceType}|${obj.status}`;
          if (this.lastDeviceInfoSig.get(id) !== sig) {
            this.lastDeviceInfoSig.set(id, sig);
            this.emitEvent(this.events.push(id, type, obj));
          }
          return;
        }
        // ---- v2 语音协调器路由（会议/段边界/语音键；失败静默——无会话时为噪声） ----
        if (this.voiceCoord) {
          switch (type) {
            case 'audioStreamIncomplete':
              this.voiceCoord.onStreamIncomplete(id);
              break;
            case 'meetingCreated':
              this.voiceCoord.onMeetingCreated(id);
              break;
            case 'meetingDestroyed':
              this.voiceCoord.onMeetingDestroyed(id, typeof obj.origin === 'string' ? obj.origin as 'device-frame' | 'transport-down' | 'legacy' : 'legacy');
              break;
            case 'meetingCreateFailed':
              this.voiceCoord.onMeetingCreateFailed(id, typeof obj.reason === 'string' ? obj.reason : 'unknown');
              break;
            case 'audioSegmentComplete':
              this.voiceCoord.onAudioSegmentComplete(id, typeof obj.segment === 'number' ? obj.segment : 0, typeof obj.reason === 'string' ? obj.reason : 'unknown');
              break;
            default:
              break;
          }
          if (type === 'keyEvent' && obj.key === 'speech' && (obj.action === 'down' || obj.action === 'up')) {
            // v2：物理语音键改道听写协调器（替换旧 speechAutoRecord→inbox 接线，
            // （不能并存两个自动监听器）。旧链路仅在 UMSDK_VOICE=0 时保留。
            this.voiceCoord.onSpeechKey(id, obj.action);
            this.emitEvent(this.events.push(id, type, obj));
            return;
          }
        }
        if (this.cfg.speechAutoRecord && !this.voiceCoord && type === 'keyEvent') {
          this.handleSpeechKey(obj, id);
        }
        this.emitEvent(this.events.push(id, type, obj));
      });
      sdk.on('audio', (pcm: Buffer, _len: number, id: string) => {
        this.voiceCoord?.onPcm(id, pcm);
        this.recorder.feed(pcm, id);
      });
      // rawFrame：FULL 设备全帧对称透传（v0.4.0）。默认不进事件流（帧量大防刷屏）；
      // UMSDK_RAWFRAME_EVENTS=1 时入流（hex 载荷），联调期用于观察注入回执帧
      // （0A 17 81 <len> <标志> <序号> <状态>）是否到达——固件侧取证通道
      sdk.on('rawFrame', (data: Buffer, _len: number, _conn: number, id: string) => {
        // 内部 A2 应答诊断不受公开 rawFrame 事件开关影响。
        this.sleepReset.onRawFrame(id, data, _conn);
        if (this.cfg.rawFrameEvents) {
          this.emitEvent(this.events.push(id, 'rawFrame', { hex: data.toString('hex'), len: data.length }));
        }
      });

      sdk.start(this.cfg.debug);
      this.started = true;
      this.inject.resume();
      this.startedAt = Date.now();
      this.lastError = undefined;
      // start 过程中已收到的 connected 已登记；补入 SDK 当前列表，避免遗漏早期连接。
      // 不伪造 DeviceRegistry connected 事件，SDK 列表与事件聚合仍各司其职。
      for (const device of this.safeDeviceList()) {
        this.devices.ensureConnected(device.id, device.mode === 'BLE' ? 1 : 0);
        this.capabilities.onGenerationChange(device.id, this.devices.generationOf(device.id));
        this.applyTestCapsFor(device.id);
        this.sleepReset.onConnected(device.id, device.mode === 'BLE' ? 1 : 0);
      }
      this.sleepReset.start();
      this.voice.start();
      return { ok: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.lastError = error;
      this.started = false;
      this.sleepReset.stop();
      this.teardownInstance();
      if (!this.sdk?.isStarted()) {
        await this.voiceInbox?.stop();
        this.voiceInbox = undefined;
        await this.sdkLease?.release();
      }
      return { ok: false, error };
    }
  }

  /** 受控重启：摘回调 → 消化在途投递 → stop → 新配置 → 完整 start 序列 */
  async reconfigure(req: ReconfigureRequest): Promise<{ ok: boolean; error?: string }> {
    return this.serializeLifecycle(() => this.reconfigureCore(req));
  }

  private async reconfigureCore(req: ReconfigureRequest): Promise<{ ok: boolean; error?: string }> {
    // v2：活动语音会话与重配互斥——重启会拆 SDK 与音频流，冲突返回 busy
    const active = this.voiceCoord?.current;
    if (active) {
      return { ok: false, error: `语音会话进行中（${active.sessionId}，state=${active.state}），须先 finish/cancel 后再重配` };
    }
    if (this.voiceCoord?.hasPendingClose() && this.safeDeviceList().length) return { ok: false, error: '设备关麦或语音键释放尚未确认；请断开全部设备后重配，再重连' };
    const next: BridgeConfig = { ...this.cfg };
    if (req.workMode) next.workMode = req.workMode;
    if (typeof req.deviceLimit === 'number') next.deviceLimit = Math.min(8, Math.max(1, req.deviceLimit));
    if (req.usb !== undefined) next.usb = req.usb ?? undefined;
    if (req.ble !== undefined) next.ble = req.ble ?? undefined;
    if (typeof req.debug === 'number') next.debug = Math.min(2, Math.max(0, req.debug));
    if (typeof req.speechAutoRecord === 'boolean') next.speechAutoRecord = req.speechAutoRecord;

    await this.shutdownCore('reconfigure', true);
    this.voiceCoord?.resetAfterSdkStopped();
    this.cfg = next;
    const r = await this.startCore();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  async shutdown(): Promise<void> {
    return this.serializeLifecycle(() => this.shutdownCore('shutdown'));
  }

  private serializeLifecycle<T>(action: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(action, action);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  private async shutdownCore(_why: string, keepLease = false): Promise<void> {
    // 必须在任何 await 之前停后台写入，退出/重配置期间只允许原有安全释放链路。
    this.sleepReset.stop();
    await this.inject.suspend();
    // v2：语音会话先收口（关麦/取消交付），再动录音与 SDK（优雅退出序）
    if (!keepLease) {
      await this.voiceCoord?.shutdown();
      await this.shutdownVoiceUi();
      await this.voiceTyperShutdown();
    } else this.voiceUi?.close(); // idle reconfigure keeps reusable ASR/typer/UI services
    try { this.recorder.stop('manual'); }
    catch (e) { this.emitEvent(this.events.push('', 'warning', { error: String(e) })); }
    await this.voiceInbox?.stop();
    this.waitingForSdk = false;
    this.started = false;
    this.startedAt = 0;
    this.devices.clear();
    this.legacyMeetings.clear();
    this.legacyCloseConfirmed.clear(); this.legacyDrained.clear();
    this.lastDeviceInfoSig.clear();
    if (!this.sdk || !this.sdk.isStarted()) {
      this.started = false;
      this.sleepReset.stop();
      this.inject.dispose();
      if (!keepLease) { this.voiceInbox = undefined; await this.sdkLease?.release(); }
      return;
    }
    // 注入保险：退出前把按住状态复位（全零帧）——协议无固件看门狗时的最后兜底
    // 严格退出契约：先摘 C 侧回调（库线程不再进 JS）→ 让事件循环消化在途投递 → close
    this.sdk.unregisterCallbacks();
    this.sdk.removeAllListeners();
    this.sleepReset.stop();
    await new Promise((r) => setTimeout(r, 120));
    try {
      this.sdk.stop();
    } catch {
      /* 幂等 */
    }
    if (this.sdk.isStarted()) throw new Error('SDK 未确认退出，保留占用锁');
    this.started = false;
    this.devices.clear();
    this.lastDeviceInfoSig.clear();
    if (!keepLease) { this.voiceInbox = undefined; await this.sdkLease?.release(); }
  }

  /** 进程一次性引导：数据目录、chdir（崩溃日志/内部日志落数据目录而非宿主 cwd）、DLL 依赖路径 */
  private prepareBoot(): void {
    if (this.booted) return;
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });
    if (process.cwd() !== this.cfg.dataDir) {
      try {
        process.chdir(this.cfg.dataDir);
      } catch {
        /* chdir 失败不阻断：仅崩溃日志落点受影响 */
      }
    }
    if (process.platform === 'win32') {
      const libDir = path.dirname(this.cfg.libPath);
      if (!process.env.PATH?.split(';').includes(libDir)) {
        process.env.PATH = `${libDir};${process.env.PATH ?? ''}`;
      }
    }
    this.booted = true;
  }

  private teardownInstance(): void {
    this.sleepReset.stop();
    if (this.sdk) {
      try {
        if (this.sdk.isStarted()) this.sdk.stop();
      } catch {
        /* 幂等 */
      }
      this.sdk.removeAllListeners();
    }
    this.started = false;
  }

  /** 套用测试能力声明（通配 "*" + 设备专属；来源标 test-profile） */
  private applyTestCapsFor(deviceId: string): void {
    const specific = this.cfg.voiceTestCaps[deviceId];
    if (specific) {
      try { this.capabilities.setTestProfile(deviceId, specific); } catch { /* 已注册能力校验失败则忽略 */ }
    } else if (this.wildcardTestCaps) {
      try { this.capabilities.setTestProfile(deviceId, this.wildcardTestCaps); } catch { /* 同上 */ }
    }
  }

  private handleSpeechKey(obj: Record<string, unknown>, deviceId: string): void {
    if (obj.key !== 'speech') return;
    if (obj.action === 'down') {
      const source = this.safeAudioSource();
      if (source && deviceId !== source) return;
      const id = deviceId || this.currentAudioDevice();
      if (id && this.gate.check(id, 'voice').allowed && !this.legacyMeetings.size) this.recorder.startAuto(id);
    } else if (obj.action === 'up') {
      const session = this.recorder.status();
      if (session.kind === 'auto' && session.deviceId === deviceId) this.recorder.stopSafely('key-up');
    }
  }

  /** 手动会话缺省设备：优先显式音频源，否则必须恰好一台在线设备。 */
  private currentAudioDevice(): string {
    const src = this.safeAudioSource();
    if (src) return src;
    const devices = this.safeDeviceList();
    return devices.length === 1 ? devices[0].id : '';
  }

  private emitAutoCaptured(r: RecordResult): void {
    const eventId = this.voice.capture(r);
    const evt = this.events.push(r.deviceId, 'speechCaptured', {
      eventId,
      path: r.path,
      durationMs: r.durationMs,
      bytes: r.bytes,
      autoStopped: r.reason === 'timeout',
    });
    this.emitEvent(evt);
  }

  /** 供 index.ts 转发 MCP 通知（payload 为刚入缓冲的事件对象） */
  private emitEvent(evt: UmEvent): void {
    this.emit('event', evt);
  }

  onEvent(cb: (evt: UmEvent) => void): void {
    this.on('event', cb);
  }

  // ---------------- 命令入口（未启动统一报错） ----------------

  private requireStarted(): UMouseSdkBinding {
    if (!this.started || !this.sdk) {
      throw new Error(`SDK 未运行${this.lastError ? `（上次启动失败：${this.lastError}）` : '，无法执行该命令'}`);
    }
    return this.sdk;
  }

  safeDeviceList(): { id: string; mode: string }[] {
    try {
      return this.started && this.sdk ? this.sdk.deviceList() : [];
    } catch {
      return [];
    }
  }

  safeAudioSource(): string {
    try {
      return this.started && this.sdk ? this.sdk.audioSource() : '';
    } catch {
      return '';
    }
  }

  status(): Record<string, unknown> {
    return {
      processId: process.pid,
      takeover: { ...takeoverState },
      sdkStarted: this.started,
      sdkVersion: this.sdkVersion,
      lastError: this.lastError,
      startedAt: this.startedAt || undefined,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      config: {
        libPath: this.cfg.libPath,
        workMode: this.cfg.workMode,
        deviceLimit: this.cfg.deviceLimit,
        usb: this.cfg.usb,
        ble: this.cfg.ble,
        debug: this.cfg.debug,
        speechAutoRecord: this.cfg.speechAutoRecord,
        dataDir: this.cfg.dataDir,
      },
      devices: this.devices.stats(),
      deviceList: this.devices.list(this.safeDeviceList()).map((d) => ({
        ...d,
        capabilities: {
          voice: this.capabilities.supportOf(d.id, 'voice') ?? undefined,
          mouse_control: this.capabilities.supportOf(d.id, 'mouse_control') ?? undefined,
          keyboard_control: this.capabilities.supportOf(d.id, 'keyboard_control') ?? undefined,
        },
      })),
      eventBuffer: this.events.stats(),
      sleepReset: this.sleepReset.status(),
      sdkOwnership: this.sdkLease?.status() ?? { supported: false, state: 'test-bypass' },
      legacyAudio: { meetings: [...this.legacyMeetings], recovery: this.legacyMeetings.size
        ? '使用 meeting_destroy 等待设备关麦与音频段边界；证据丢失时断开全部设备，再 reconfigure 重启 SDK，不用超时假定关麦。' : undefined },
      voice2: this.voiceCoord
        ? { ...this.voiceCoord.status(), enabled: true, maxDurationMs: this.cfg.voiceMaxMs }
        : { enabled: false, note: 'UMSDK_VOICE=0：物理语音键走旧自动录音→持久 inbox 链路' },
      voice: { ...(this.voiceInbox?.status() ?? { running: false, available: false }), provider: this.cfg.asr?.provider ?? 'disabled', language: this.cfg.asr?.language },
      injection: {
        enabled: this.injectionEnabled,
        keyboardEnabled: this.cfg.keyboardInjection,
        feedbackMs: this.cfg.injectFeedbackMs,
        confirmation: 'transport_write_only',
        rawFrameEvents: this.cfg.rawFrameEvents,
        stats: { ...this.inject.stats },
        state: this.inject.state(),
      },
      audio: { ...this.recorder.status(), maxSeconds: this.cfg.audioMaxSeconds, quotaMb: this.cfg.audioQuotaMb },
      audioSource: this.safeAudioSource(),
    };
  }

  listDevices(): unknown[] {
    return this.devices.list(this.safeDeviceList());
  }

  get rawFrameEventsEnabled(): boolean {
    return this.cfg.rawFrameEvents;
  }

  get keyboardInjectionEnabled(): boolean {
    return this.cfg.keyboardInjection;
  }

  get rawDiagEnabled(): boolean {
    return this.cfg.rawDiag;
  }

  setDpi(level: number, deviceId?: string): number {
    return this.requireStarted().setDpi(level, deviceId ?? null);
  }

  meeting(op: 'create' | 'destroy' | 'pause' | 'resume', deviceId?: string): number {
    // v2：会议操作与活动语音会话同一仲裁——冲突返回失败（异常），不绕过锁
    const active = this.voiceCoord?.current;
    if (active) {
      throw new Error(`语音会话进行中（${active.sessionId}，state=${active.state}），会议操作被仲裁拒绝；请经 umouse_voice_finish/cancel 收口`);
    }
    const sdk = this.requireStarted();
    const target = deviceId ?? this.currentAudioDevice();
    this.requireVoiceCapability(target);
    if (op === 'create' && this.voiceCoord?.hasPendingClose(target)) throw new Error('设备关麦尚未确认');
    switch (op) {
      case 'create': {
        if (this.recorder.status().recording) throw new Error('录音进行中');
        this.legacyMeetings.add(target);
        this.legacyCloseConfirmed.delete(target); this.legacyDrained.delete(target);
        return sdk.meetingCreate(target);
      }
      case 'destroy': return sdk.meetingDestroy(deviceId ?? null);
      case 'pause': return sdk.meetingPause(deviceId ?? null);
      case 'resume': return sdk.meetingResume(deviceId ?? null);
    }
  }

  setChannelPref(pref: ChannelName, deviceId?: string): number {
    const n = chanToNum(pref);
    const sdk = this.requireStarted();
    return deviceId ? sdk.setChannelPrefFor(deviceId, n) : sdk.setChannelPref(n);
  }

  setAudioSource(deviceId?: string): { ok: number; source: string } {
    // v2：活动语音会话持有音频源（会话收口时还原原值），外部改源被仲裁拒绝
    if (this.voiceCoord?.current) {
      throw new Error('语音会话进行中，音频源由会话管理；请先结束语音会话');
    }
    if (this.legacyMeetings.size || this.recorder.active) throw new Error('会议或录音进行中，不能切换音频源');
    const sdk = this.requireStarted();
    this.requireVoiceCapability(deviceId ?? this.currentAudioDevice());
    const ok = sdk.setAudioSource(deviceId ?? null);
    return { ok, source: sdk.audioSource() };
  }

  writeRaw(hex: string, deviceId?: string): { ok: number; bytes: number } {
    const buf = Buffer.from(hex, 'hex');
    if (buf.length === 0) throw new Error('hex 为空或格式非法');
    if (buf.length > 1024) throw new Error(`单次写入上限 1024 字节，当前 ${buf.length}`);
    // v2：raw 不是绕过能力门控的入口。普通模式不开放任意原始写入；
    // 诊断模式下已知鼠标/键盘帧（03 F0/F1）仍须过对应能力校验，未知命令拒绝。
    if (!this.cfg.rawDiag) {
      throw new Error('原始写入仅诊断模式开放（UMSDK_RAW_DIAG=1）；普通会话不提供任意 raw 写入');
    }
    const target = deviceId ?? this.resolveInjectDevice(undefined);
    if (buf.length >= 3 && buf[1] === 0x03 && (buf[2] === 0xF0 || buf[2] === 0xF1)) {
      const decision = this.gate.check(target, buf[2] === 0xF0 ? 'mouse_control' : 'keyboard_control');
      if (!decision.allowed) throw new Error(`raw 帧被能力门控拒绝：${decision.message}`);
    } else {
      throw new Error('诊断模式仅放行已知命令帧（03 F0 鼠标 / 03 F1 键盘）；未知命令拒绝');
    }
    const ok = this.requireStarted().writeRaw(buf, deviceId ?? null);
    return { ok, bytes: buf.length };
  }

  audioRecord(action: 'start' | 'stop' | 'status', deviceId?: string, maxSeconds?: number): unknown {
    if (action === 'status') return this.recorder.status();
    if (action === 'start') {
      // v2：手动录音与活动语音会话共用同一音频资源——冲突返回 busy
      const active = this.voiceCoord?.current;
      if (active) {
        throw new Error(`语音会话进行中（${active.sessionId}，state=${active.state}），手动录音被仲裁拒绝`);
      }
      this.requireStarted();
      const id = deviceId ?? this.currentAudioDevice();
      if (!id) throw new Error('无法确定录音设备：多台在线时须显式传 device_id');
      this.requireVoiceCapability(id);
      if (this.legacyMeetings.size || this.voiceCoord?.hasPendingClose(id)) throw new Error('会议或关麦清理正在占用麦克风');
      if (!this.safeDeviceList().some(d => d.id === id)) throw new Error('录音设备不在线');
      const r = this.recorder.startManual(id, maxSeconds);
      if (!r.ok) throw new Error(r.error);
      return { started: true, deviceId: id, maxSeconds: Math.min(600, Math.max(1, maxSeconds ?? this.cfg.audioMaxSeconds)) };
    }
    // stop：活动会话→收尾返回文件；无会话→不是错误，回带最近完成的录音（测试反馈：
    // 会话已被语音键松开/超时收尾时，agent 需要的是"文件在哪"而非"没有录音"）
    const r = this.recorder.stop('manual');
    if (r) return { stopped: true, file: r };
    return {
      stopped: false,
      file: this.recorder.last,
      note: this.recorder.last
        ? '会话已结束（语音键松开或超时自动收尾），file 为最近完成的录音'
        : '当前没有进行中的录音，也没有历史录音',
    };
  }

  private requireVoiceCapability(deviceId: string): void {
    const decision = this.gate.check(deviceId, 'voice');
    if (!decision.allowed) throw new Error(decision.message);
  }
}
