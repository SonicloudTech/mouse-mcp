import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { RecordResult } from './audio.js';
import { TranscriptionError, type Transcriber } from './transcriber.js';

export interface VoiceMessage {
  eventId: string;
  source: 'physical-speech-button';
  deviceId: string;
  capturedAt: string;
  durationMs: number;
  bytes: number;
  status: 'queued' | 'transcribing' | 'ready' | 'empty' | 'failed';
  acknowledged: boolean;
  text?: string;
  provider?: string;
  language?: string;
  confidence?: number;
  errorCode?: string;
  completedAt?: string;
}

interface VoiceOptions {
  maxPending?: number;
  maxMessages?: number;
  maxAudioBytes?: number;
  onEvent?: (type: string, payload: Record<string, unknown>, deviceId: string) => void;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const terminal = (m: VoiceMessage) => !['queued', 'transcribing'].includes(m.status);
const errorCodes = new Set(['interrupted', 'text_too_large', 'aborted', 'timed_out', 'input_error', 'unavailable',
  'recognition_failed', 'http_error', 'invalid_response', 'response_too_large', 'provider_error', 'configuration']);

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error('Invalid voice inbox limit.');
  return result;
}

/** One durable inbox per SDK bridge. No microphone access, UI input, or host turn creation. */
export class VoiceInbox {
  private readonly file: string;
  private messages: VoiceMessage[] = [];
  private running = false;
  private worker: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private signal = new EventEmitter();
  private storageError = false;
  private rejected = 0;
  private readonly maxPending: number;
  private readonly maxMessages: number;
  private readonly maxAudioBytes: number;
  private readonly maxStorageBytes: number;

  constructor(private readonly dir: string, private readonly transcribe: Transcriber | null, private readonly options: VoiceOptions = {}) {
    this.file = path.join(dir, 'inbox.json');
    this.maxPending = limit(options.maxPending, 8, 100);
    this.maxMessages = limit(options.maxMessages, 100, 100);
    this.maxAudioBytes = limit(options.maxAudioBytes, 20 * 1024 * 1024, 32 * 1024 * 1024);
    // 32,000 UTF-16 code units plus bounded metadata per item; same budget on read/write.
    this.maxStorageBytes = this.maxMessages * (32000 * 4 + 8192);
    this.signal.setMaxListeners(0);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        if (fs.statSync(this.file).size > this.maxStorageBytes) throw new Error('oversized inbox');
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (saved.schemaVersion !== 1 || !Array.isArray(saved.messages) || saved.messages.length > this.maxMessages) throw new Error('invalid inbox');
        const ids = new Set<string>();
        for (const m of saved.messages) {
          if (!m || !ID.test(m.eventId) || ids.has(m.eventId) || m.source !== 'physical-speech-button'
            || typeof m.deviceId !== 'string' || m.deviceId.length > 1024
            || typeof m.capturedAt !== 'string' || m.capturedAt.length > 64 || !Number.isFinite(Date.parse(m.capturedAt))
            || !Number.isFinite(m.durationMs) || m.durationMs < 0 || !Number.isFinite(m.bytes) || m.bytes < 0
            || typeof m.acknowledged !== 'boolean'
            || !['queued', 'transcribing', 'ready', 'empty', 'failed'].includes(m.status)
            || (m.status === 'ready' && typeof m.text !== 'string')
            || (m.text !== undefined && (typeof m.text !== 'string' || m.text.length > 32000))
            || (m.provider !== undefined && (typeof m.provider !== 'string' || m.provider.length > 128))
            || (m.language !== undefined && (typeof m.language !== 'string' || m.language.length > 64))
            || (m.confidence !== undefined && (!Number.isFinite(m.confidence) || m.confidence < 0 || m.confidence > 1))
            || (m.errorCode !== undefined && !errorCodes.has(m.errorCode) && m.errorCode !== 'transcription_failed')
            || (m.completedAt !== undefined && (typeof m.completedAt !== 'string' || m.completedAt.length > 64
              || !Number.isFinite(Date.parse(m.completedAt))))) throw new Error('invalid inbox');
          ids.add(m.eventId);
          this.messages.push({ eventId: m.eventId, source: 'physical-speech-button', deviceId: m.deviceId,
            capturedAt: m.capturedAt, durationMs: m.durationMs, bytes: m.bytes, status: m.status,
            acknowledged: m.acknowledged, text: m.text, provider: m.provider, language: m.language,
            confidence: m.confidence, errorCode: m.errorCode, completedAt: m.completedAt });
        }
        // Never automatically repeat a possibly completed HTTP upload after a crash.
        for (const m of this.messages) {
          if (!terminal(m)) { m.status = 'failed'; m.errorCode = 'interrupted'; m.completedAt = new Date().toISOString(); }
        }
        this.persist();
      }
      // Only our UUID-named snapshots are transient; original recordings belong to AudioRecorder.
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.wav') && ID.test(name.slice(0, -4))) fs.unlinkSync(path.join(dir, name));
      }
    } catch { this.storageError = true; this.messages = []; }
  }

  start(): void { this.running = true; this.kick(); }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    const cancelled = this.messages.map(m => m.status === 'queued'
      ? { ...m, status: 'failed' as const, errorCode: 'interrupted', completedAt: new Date().toISOString() } : m);
    if (!this.storageError && this.tryPersist(cancelled)) {
      for (const m of this.messages) if (m.status === 'queued') this.removeAudio(m.eventId);
      this.messages = cancelled;
    }
    this.signal.emit('change');
    await this.worker;
  }

  capture(record: RecordResult): string | null {
    if (!this.transcribe) return null;
    if (!this.running || this.storageError) return this.reject('voice_unavailable');
    if (this.messages.filter(m => !terminal(m)).length >= this.maxPending) return this.reject('voice_queue_full');
    // Reclaim acknowledged entries only. Unread messages are never silently evicted.
    while (this.messages.length >= this.maxMessages) {
      const i = this.messages.findIndex(m => m.acknowledged && terminal(m));
      if (i < 0) return this.reject('voice_inbox_full');
      this.messages.splice(i, 1);
    }
    const eventId = randomUUID();
    try {
      const size = fs.statSync(record.path).size;
      if (size < 44 || size > this.maxAudioBytes) return this.reject('voice_audio_size');
      // Pin before AudioRecorder can prune a queued WAV on the next capture.
      fs.copyFileSync(record.path, this.audioPath(eventId), fs.constants.COPYFILE_EXCL);
      this.messages.push({ eventId, source: 'physical-speech-button', deviceId: record.deviceId,
        capturedAt: new Date().toISOString(), durationMs: record.durationMs, bytes: record.bytes,
        status: 'queued', acknowledged: false });
      this.persist();
    } catch {
      this.messages = this.messages.filter(m => m.eventId !== eventId);
      this.removeAudio(eventId);
      this.storageError = true;
      return this.reject('voice_storage_error');
    }
    this.signal.emit('change');
    // Leave the native event callback before starting external work.
    queueMicrotask(() => this.kick());
    return eventId;
  }

  list(includeAcknowledged = false, limit = 100): VoiceMessage[] {
    return structuredClone(this.messages.filter(m => includeAcknowledged || !m.acknowledged).slice(0, Math.max(1, Math.min(100, limit))));
  }

  acknowledge(eventId: string): boolean {
    const m = this.messages.find(m => m.eventId === eventId);
    if (!m || !terminal(m) || this.storageError) return false;
    if (m.acknowledged) return true;
    m.acknowledged = true;
    if (!this.tryPersist()) { m.acknowledged = false; return false; }
    this.signal.emit('change');
    return true;
  }

  async wait(timeoutMs: number): Promise<VoiceMessage[]> {
    const ready = () => this.list().filter(terminal);
    if (ready().length || !this.running || this.storageError) return ready();
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.signal.off('change', changed); resolve(ready()); };
      const changed = () => { if (ready().length || !this.running || this.storageError) finish(); };
      const timer = setTimeout(finish, Math.max(100, Math.min(25000, timeoutMs)));
      timer.unref();
      this.signal.on('change', changed);
      changed();
    });
  }

  status() {
    return { enabled: !!this.transcribe, running: this.running, storageError: this.storageError, rejected: this.rejected,
      total: this.messages.length, pending: this.messages.filter(m => !terminal(m)).length,
      unread: this.messages.filter(m => !m.acknowledged).length, maxPending: this.maxPending, maxMessages: this.maxMessages,
      delivery: 'pull-and-ack', automaticHostTurn: false };
  }

  private kick(): void {
    if (this.worker || !this.running || !this.transcribe || this.storageError) return;
    this.worker = this.drain().catch(() => {
      this.storageError = true;
      this.reject('voice_worker_error');
      this.signal.emit('change');
    }).finally(() => {
      this.worker = undefined;
      // A capture racing the final worker microtask must not remain stranded.
      if (this.messages.some(m => m.status === 'queued')) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.running && !this.storageError) {
      const m = this.messages.find(item => item.status === 'queued');
      if (!m) return;
      m.status = 'transcribing';
      if (!this.tryPersist()) return;
      const completed = { ...m };
      this.abort = new AbortController();
      try {
        const result = await this.transcribe!({ path: this.audioPath(m.eventId), bytes: m.bytes, durationMs: m.durationMs }, this.abort.signal);
        if (this.abort.signal.aborted) throw new TranscriptionError('interrupted', 'Interrupted');
        if (result.text.length > 32000) throw new TranscriptionError('text_too_large', 'Transcript too large');
        completed.text = result.text.trim(); completed.provider = result.provider; completed.language = result.language;
        completed.confidence = result.confidence;
        completed.status = completed.text ? 'ready' : 'empty';
      } catch (error) {
        completed.status = 'failed';
        completed.errorCode = this.abort.signal.aborted ? 'interrupted'
          : error instanceof TranscriptionError && errorCodes.has(error.code) ? error.code : 'transcription_failed';
      } finally { this.abort = undefined; }
      completed.completedAt = new Date().toISOString();
      const committed = this.messages.map(item => item.eventId === m.eventId ? completed : item);
      if (!this.tryPersist(committed)) return;
      this.messages = committed;
      this.removeAudio(m.eventId);
      this.signal.emit('change');
      this.emitEvent('speechTranscribed', { eventId: completed.eventId, status: completed.status, errorCode: completed.errorCode }, completed.deviceId);
    }
  }

  private audioPath(id: string): string { return path.join(this.dir, `${id}.wav`); }
  private removeAudio(id: string): void { try { fs.unlinkSync(this.audioPath(id)); } catch { /* next startup cleans orphan snapshots */ } }
  private persist(messages = this.messages): void {
    const temp = `${this.file}.tmp`;
    const serialized = JSON.stringify({ schemaVersion: 1, messages });
    if (Buffer.byteLength(serialized, 'utf8') > this.maxStorageBytes) throw new Error('oversized inbox');
    fs.writeFileSync(temp, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  private tryPersist(messages = this.messages): boolean {
    try { this.persist(messages); return true; }
    catch { this.storageError = true; this.reject('voice_storage_error'); this.signal.emit('change'); return false; }
  }
  private reject(code: string): null {
    this.rejected++;
    this.emitEvent('warning', { code, component: 'voice' }, '');
    return null;
  }
  private emitEvent(type: string, payload: Record<string, unknown>, deviceId: string): void {
    try { this.options.onEvent?.(type, payload, deviceId); }
    catch { /* An optional notification observer must not break durable delivery. */ }
  }
}
