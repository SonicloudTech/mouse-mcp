import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { VoiceCoordinator, DEFAULT_VOICE_CONFIG, type VoiceSession } from '../voice-session.js';
import { DeviceRegistry } from '../state.js';
import { DeviceCapabilityRegistry } from '../device-capabilities.js';
import { CapabilityGate } from '../capability-gate.js';
import { createBatchAsrProviderFactory, withSnapshotPreview, type AsrProviderFactory } from '../asr-service.js';
import { createTranscriber } from '../transcriber.js';
import { DeliveryLedger } from '../voice-typer-binding.js';
import { containsControlCharacters, normalizeForTyping, TYPING_TEXT_LIMIT } from '../voice-typer.js';
import { createVad } from '../voice-vad.js';
import { VoiceUiController } from '../voice-ui.js';
import type { BridgeConfig } from '../env.js';
import type { NativeReady } from './native-client.js';
import type { WorkerHandle } from './worker-supervisor.js';
import { createSinicloudStreamFactory } from '../sinicloud-asr.js';
import { ResourceArbiter } from './resource-arbiter.js';
import { SharedInput } from './input-manager.js';
import type { InputInFlightFlag } from './input-inflight.js';

/** One high-level runtime per worker epoch; all four SDK libraries stay in the C++ child. */
export class NativeRuntime {
  readonly devices = new DeviceRegistry();
  readonly capabilities = new DeviceCapabilityRegistry();
  readonly gate = new CapabilityGate(this.capabilities, {}, { isOnline: id => this.online.has(id) && !this.closed });
  readonly voice: VoiceCoordinator;
  readonly input: SharedInput;
  private readonly ui?: VoiceUiController;
  private readonly asrConfigured: boolean;
  private readonly ledger: DeliveryLedger;
  private readonly arbiter: ResourceArbiter;
  private online = new Map<string, { id: string; mode: string }>();
  private nativeGenerations = new Map<string, number>();
  private source = '';
  private owners = new Map<string, string>();
  private startingOwner?: string;
  private revoked = new Set<string>();
  private closed = false;
  private started = false;
  private stopPromise?: Promise<void>;
  private resetTimer?: NodeJS.Timeout;
  private resetInFlight = false;
  private droppedEvents = 0;
  private readonly deliveries = new Set<AbortController>();
  sdkVersion?: string;

  constructor(readonly client: WorkerHandle, readonly info: NativeReady, private readonly config: BridgeConfig,
    private readonly notify: (owner: string, metadata: Record<string, unknown>) => void = () => {},
    private readonly capabilitiesChanged: () => void = () => {}, inflight?: InputInFlightFlag,
    /** 测试注入缝：显式覆盖 ASR provider 工厂。undefined=按配置装配（生产行为不变）；
     * 开源版剔除 AsrTools 接线后，shared-voice 类假 worker 编排测试经此注入离线工厂。 */
    asrFactoryOverride?: AsrProviderFactory | null) {
    this.ledger = new DeliveryLedger(path.join(config.dataDir, 'shared-v2', 'delivery'));
    this.arbiter = new ResourceArbiter(client.epoch);
    this.input = new SharedInput({ native: client, arbiter: this.arbiter, dataDir: config.sharedSafetyDir ?? config.dataDir,
      enabled: config.injection, inflight,
      devices: () => [...this.online.keys()].map(id => ({ id, generation: this.nativeGenerations.get(id) ?? 0 })),
      allowed: (id, capability = 'mouse_control') => config.injection && (capability !== 'keyboard_control' || config.keyboardInjection) && this.gate.check(id, capability).allowed });
    let asr = config.asr ? (config.voicePreview
      ? withSnapshotPreview(createBatchAsrProviderFactory(createTranscriber(config.asr)), createTranscriber(config.asr))
      : createBatchAsrProviderFactory(createTranscriber(config.asr))) : null;
    if (config.asrProvider === 'sinicloud' && config.asrSinicloud) {
      // Sonicloud 平台流式识别：凭据每会话热读（文件+环境变量），失败降级为
      // asr_unavailable（工厂 null），不影响其它能力。
      asr = createSinicloudStreamFactory({
        credentials: config.asrSinicloud.load,
        timeoutMs: config.asrSinicloud.timeoutMs,
        onDiagnostic: info => this.notify('sinicloud-asr', info),
      });
    }
    if (asrFactoryOverride !== undefined) asr = asrFactoryOverride;
    this.asrConfigured = asr !== null;
    const rpc = async (method: string, args: object) => client.request<{ sent: number }>('umouse', method, args);
    this.voice = new VoiceCoordinator({
      meetingCreate: async id => (await rpc('meeting.create', { deviceId: id })).sent,
      meetingDestroy: async id => (await rpc('meeting.destroy', { deviceId: id })).sent,
      setAudioSource: async id => {
        const result = await client.request<{ source: string }>('umouse', 'audio.source', { deviceId: id ?? '' });
        this.source = result.source; return { ok: 1, source: this.source };
      },
      audioSource: () => this.source,
      isOnline: id => this.online.has(id) && !this.closed,
      generationOf: id => this.devices.generationOf(id),
      defaultDevice: () => this.online.size === 1 ? this.online.keys().next().value! : '',
      checkVoice: id => this.gate.check(id, 'voice'),
    }, asr, {
      available: config.voiceTyper && info.plugins.some(p => p.id === 'typer'), id: 'native-typer',
      deliver: async req => {
        // A historical hardware-control fault belongs to that control module.
        // Dictation still respects its own delivery guards and the active desktop
        // lease, without inheriting hardware input's persistent uncertainty latch.
        if (this.closed || !config.voiceTyper || !info.plugins.some(p => p.id === 'typer')) return { outcome: 'unavailable', error: 'typer_unavailable' };
        const text = normalizeForTyping(req.text);
        if (!text.trim() || text.length > TYPING_TEXT_LIMIT || containsControlCharacters(text)) return { outcome: 'failed', error: 'invalid_typing_text' };
        let lease;
        try { lease = this.arbiter.acquire('physical-dictation', 'desktop'); } catch { return { outcome: 'unavailable', error: 'desktop_busy' }; }
        const entry = { kind: 'deliver' as const, sessionId: req.sessionId, at: new Date().toISOString(), textLength: text.length,
          textSha256: createHash('sha256').update(text).digest('hex') };
        const abort = new AbortController(); this.deliveries.add(abort);
        try {
          if (this.ledger.has(req.sessionId)) return { outcome: 'failed', error: 'delivery_already_attempted' };
          this.ledger.record({ ...entry, outcome: 'attempting', text });
          if (this.closed) return { outcome: 'unavailable', error: 'runtime_closed' };
          const r = await client.request<{ submitted: boolean }>('typer', 'text', { text, deliveryAuthorized: true, operationId: req.sessionId }, abort.signal);
          this.ledger.record({ ...entry, outcome: r.submitted ? 'submitted' : 'unknown', ...(r.submitted ? {} : { text }) });
          return r.submitted ? { outcome: 'submitted' } : { outcome: 'failed', error: 'delivery_unknown' };
        } catch {
          try { this.ledger.record({ ...entry, outcome: 'unknown', text }); } catch { /* Never retry input after a journal failure. */ }
          return { outcome: 'failed', error: 'delivery_unknown' };
        } finally { this.arbiter.release(lease); this.deliveries.delete(abort); }
      },
    }, { ...DEFAULT_VOICE_CONFIG, maxDurationMs: config.voiceMaxMs,
      asrFinalWaitMs: Math.max(DEFAULT_VOICE_CONFIG.asrFinalWaitMs, (config.asr?.timeoutMs ?? 60_000) + 1000) }, () => {},
    createVad(config.voiceVad, { endSilenceMs: config.voiceEndSilenceMs, firstSpeechMs: config.voiceFirstSpeechMs }));
    if (config.voiceUi) this.ui = new VoiceUiController({ exePath: config.voiceUiPath ?? null,
      onFinish: id => { void this.voice.voiceFinish(id); }, onCancel: id => { void this.voice.voiceCancel(id); } });
    this.voice.on('update', (s: VoiceSession, change: string) => {
      if (s.destination === 'agent-reply' && this.startingOwner && !this.owners.has(s.sessionId)) this.owners.set(s.sessionId, this.startingOwner);
      const owner = this.owners.get(s.sessionId);
      if (owner && !this.revoked.has(owner)) this.notify(owner, { sessionId: s.sessionId, state: s.state, change });
      this.ui?.onSessionUpdate({ ...s, change });
      // Coordinator retains at most 100 histories; avoid a long-lived owner index leak.
      for (const id of this.owners.keys()) if (!this.voice.session(id)) this.owners.delete(id);
    });
    client.on('event', this.onEvent); client.on('heartbeat', this.onHeartbeat);
  }
  /** Configuration/readiness metadata only; never expose another owner's session or speech. */
  get voiceHealth() {
    const ready = this.started && !this.closed;
    return { enabled: this.config.voiceEnabled, runtimeReady: ready,
      asrAvailable: ready && this.asrConfigured,
      typer: { available: ready && this.config.voiceTyper && this.info.plugins.some(p => p.id === 'typer'), blockedByHardwareInput: false as const },
      ui: { enabled: this.config.voiceUi, available: ready && !!this.ui?.available } };
  }
  async start(): Promise<void> {
    const r = await this.client.request<{ version: string; devices: Array<{ id: string; mode: number; generation?: number }>; inputQuarantine?: unknown }>('umouse', 'start', {
      deviceLimit: this.config.deviceLimit, debug: this.config.debug, ...(this.config.usb ? { usb: this.config.usb } : {}), ...(this.config.ble ? { ble: this.config.ble } : {}),
    });
    this.sdkVersion = r.version;
    if (this.closed) return;
    this.input.applyNativeQuarantine(r.inputQuarantine);
    for (const d of r.devices) if (!this.online.has(d.id)) this.connected(d.id, d.mode, d.generation ?? 0);
    this.started = true;
    if (this.config.sleepResetEnabled) {
      this.resetTimer = setInterval(() => { if (this.closed || this.resetInFlight) return;
        this.resetInFlight = true;
        void Promise.all([...this.online.keys()].map(deviceId => this.client.request('umouse', 'sleep.reset', { deviceId }).catch(() => {})))
          .finally(() => { this.resetInFlight = false; });
      }, this.config.sleepResetIntervalMs); this.resetTimer.unref();
    }
  }
  private connected(id: string, mode: number, generation = 0): void {
    this.nativeGenerations.set(id, generation);
    this.devices.onConnected(id, mode); this.online.set(id, { id, mode: mode === 0 ? 'USB' : mode === 1 ? 'BLE' : '?' });
    this.capabilities.onGenerationChange(id, this.devices.generationOf(id));
    const caps = this.config.voiceTestCaps[id] ?? this.config.voiceTestCaps['*']; if (caps) this.capabilities.setTestProfile(id, caps);
    this.capabilitiesChanged();
  }
  private onHeartbeat = (frame: { droppedEvents?: number }): void => {
    if ((frame.droppedEvents ?? 0) > this.droppedEvents) { this.droppedEvents = frame.droppedEvents!; this.voice.onStreamIncomplete(''); }
  };
  private onEvent = (frame: { plugin?: string; event?: Record<string, unknown>; binaryHex?: string }): void => {
    if (this.closed || frame.plugin !== 'umouse' || !frame.event) return;
    const e = frame.event; const id = typeof e.deviceId === 'string' ? e.deviceId : '';
    if (e.type === 'connected') this.connected(id, Number(e.mode), Number(e.generation ?? 0));
    else if (e.type === 'streamIncomplete' || e.type === 'protocolWarning') this.voice.onStreamIncomplete(id);
    else if (e.type === 'disconnected') { this.nativeGenerations.delete(id); this.online.delete(id); this.devices.onDisconnected(id); this.voice.onDeviceDisconnected(id); this.capabilitiesChanged(); }
    else if (e.type === 'audio' && frame.binaryHex && /^[0-9a-f]+$/.test(frame.binaryHex) && frame.binaryHex.length % 4 === 0) this.voice.onPcm(id, Buffer.from(frame.binaryHex, 'hex'));
    else if (e.type === 'message' && e.message && typeof e.message === 'object') {
      const m = e.message as Record<string, unknown>;
      if (m.type === 'keyEvent' && m.key === 'speech' && (m.action === 'down' || m.action === 'up') && this.config.voiceEnabled) this.voice.onSpeechKey(id, m.action);
      else if (m.type === 'meetingCreated') this.voice.onMeetingCreated(id);
      else if (m.type === 'meetingCreateFailed') this.voice.onMeetingCreateFailed(id, String(m.reason));
      else if (m.type === 'meetingDestroyed') this.voice.onMeetingDestroyed(id, m.origin === 'device-frame' ? 'device-frame' : m.origin === 'transport-down' ? 'transport-down' : 'legacy');
      else if (m.type === 'audioSegmentComplete') this.voice.onAudioSegmentComplete(id, Number(m.segment), String(m.reason));
      else if (m.type === 'queueOverflow') this.voice.onStreamIncomplete(id);
    }
  };
  listDevices(): unknown[] { return this.devices.list([...this.online.values()]).map(d => ({ ...d, capabilities: this.capabilities.get(d.id) })); }
  async voiceStart(owner: string, req: Parameters<VoiceCoordinator['voiceStart']>[0]): Promise<unknown> {
    if (this.closed || this.revoked.has(owner)) throw new Error('connection_expired');
    if (!this.config.voiceEnabled) throw new Error('voice_disabled');
    if (this.voice.current) return { ok: false, code: 'resource_busy' };
    this.startingOwner = owner;
    try {
      const pending = this.voice.voiceStart({ ...req, clientRequestId: req.clientRequestId ? `${owner}:${req.clientRequestId}` : undefined });
      // Reserve ownership before the first asynchronous source switch resolves.
      // A disconnect in preparing must be able to cancel before meeting.create.
      const session = this.voice.current as VoiceSession | null; // voiceStart synchronously changed the coordinator before its first await.
      if (session?.destination === 'agent-reply') this.owners.set(session.sessionId, owner);
      return await pending;
    }
    finally { if (this.startingOwner === owner) this.startingOwner = undefined; this.revoked.delete(owner); }
  }
  ownedSession(owner: string, id: string): void {
    if (this.revoked.has(owner) || this.owners.get(id) !== owner) throw new Error('session_not_found');
  }
  async releaseOwner(owner: string): Promise<void> {
    const cleanup = await Promise.allSettled([this.input.release(owner), this.releaseVoiceOwner(owner)]);
    const failure = cleanup.find(r => r.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
  }
  async releaseVoiceOwner(owner: string): Promise<void> {
    if (this.startingOwner === owner) this.revoked.add(owner);
    const s = this.voice.current;
    const cleanup = await Promise.allSettled([s && this.owners.get(s.sessionId) === owner ? this.voice.voiceCancel(s.sessionId) : Promise.resolve()]);
    for (const [id, value] of this.owners) if (value === owner) this.owners.delete(id);
    const failure = cleanup.find(r => r.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
  }
  stop(): Promise<void> { return this.stopPromise ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    if (this.closed) return; this.closed = true; if (this.resetTimer) clearInterval(this.resetTimer);
    for (const abort of this.deliveries) abort.abort();
    const cleanup = await Promise.allSettled([this.input.stop(), this.voice.shutdown()]);
    this.ui?.dispose(); this.client.off('event', this.onEvent); this.client.off('heartbeat', this.onHeartbeat);
    this.online.clear(); this.owners.clear(); this.revoked.clear();
    const failure = cleanup.find(r => r.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
  }
}
