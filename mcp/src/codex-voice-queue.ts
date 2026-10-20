/** Optional Windows desktop adapter. Watches the existing MCP inbox read-only.
 * Uses the public Codex CLI queue command, never native app IPC, SDK or input APIs.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 14 * 1024 * 1024;
type Message = { eventId: string; capturedAt: string; status: string; acknowledged: boolean; text?: string };
type RecordEntry = { eventId: string; textSha256: string; state: 'unknown' | 'queued'; attemptedAt: string; queuedAt?: string; acknowledged?: boolean };
type Ledger = { schemaVersion: 1; threadId: string; inbox: string; enabledAt: string; baseline: string[]; records: RecordEntry[] };
export type QueueStatus = { running: boolean; processId: number; ownerPid: number; threadId: string; queued: number; unknown: number; acknowledged: number; lastError: string | null; updatedAt: string };
export type QueueOptions = {
  inbox: string; directory: string; threadId: string; codexPath: string; ownerPid: number;
  /** Explicit one-off acceptance of an existing, unread physical event. Never implicit replay. */
  includeEventId?: string;
  // Dependency injection is for unit tests; the deployed entrypoint does not expose it.
  enqueue?: (threadId: string, eventId: string) => Promise<void>;
  ownerAlive?: () => boolean;
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const canonical = (file: string) => fs.realpathSync(file).toLowerCase();
const validDate = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));

export function readVoiceSnapshot(file: string): Message[] {
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('inbox_too_large');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (saved.schemaVersion !== 1 || !Array.isArray(saved.messages) || saved.messages.length > 100) throw new Error('invalid_inbox');
  const ids = new Set<string>();
  for (const m of saved.messages) {
    if (!m || typeof m.eventId !== 'string' || !UUID.test(m.eventId) || ids.has(m.eventId)
      || m.source !== 'physical-speech-button' || !validDate(m.capturedAt) || typeof m.acknowledged !== 'boolean'
      || !['queued','transcribing','ready','failed','empty'].includes(m.status)
      || (m.status === 'ready' && (typeof m.text !== 'string' || !m.text.trim()))
      || (m.text !== undefined && (typeof m.text !== 'string' || m.text.length > 32000))) throw new Error('invalid_inbox');
    ids.add(m.eventId);
  }
  return saved.messages;
}

export function voiceNotice(eventId: string): string {
  if (!UUID.test(eventId)) throw new Error('invalid_event_id');
  return `[uMouse 物理语音事件 ${eventId}]\n用户已在本会话授权鼠标语音键触发主动对话。这是事件到达通知，不含转写文本。请先通过当前唯一 uMouse MCP 连接调用 umouse_voice_inbox，核对 eventId=${eventId}、source=physical-speech-button、status=ready。仅将该事件的 text 作为用户语音处理；若已 acknowledged 则不要重复执行。读取成功后调用 umouse_ack_voice 确认接收，再自然回应语音内容；原有审批与鼠标操作必须使用 MCP 的约束继续适用。不要要求用户再输入“已说完”。如果无法找到或确认此事件，说明失败并停止，不猜测内容。`;
}

/** Exit zero means queue command accepted, NOT that a turn started or completed. */
export function enqueueCodexVoice(codexPath: string, threadId: string, eventId: string): Promise<void> {
  if (typeof codexPath !== 'string' || !path.isAbsolute(codexPath) || typeof threadId !== 'string' || !UUID.test(threadId)) throw new Error('invalid_host_binding');
  return new Promise((resolve, reject) => {
    execFile(codexPath, ['queue', '--thread', threadId, '--message', voiceNotice(eventId)],
      { windowsHide: true, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' }, (error) => {
        // Even nonzero/timeout could have happened AFTER durable queue insertion.
        if (error) reject(new Error('queue_outcome_unknown')); else resolve();
      });
  });
}

function atomicJson(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    const text = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('ledger_too_large');
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* already renamed */ }
  }
}

export class CodexVoiceQueue {
  private readonly options: QueueOptions;
  private readonly ledgerFile: string;
  private readonly statusFile: string;
  private ledger!: Ledger;
  private lock?: net.Server;
  private watcher?: fs.FSWatcher;
  private debounce?: NodeJS.Timeout;
  private lifecycle?: NodeJS.Timeout;
  private work?: Promise<void>;
  private dirty = false;
  private running = false;
  private lastError: string | null = null;
  private signature = '';

  constructor(options: QueueOptions) {
    if (process.platform !== 'win32') throw new Error('codex_voice_queue_windows_only');
    if (typeof options.threadId !== 'string' || !UUID.test(options.threadId) || !Number.isInteger(options.ownerPid) || options.ownerPid < 1
      || typeof options.inbox !== 'string' || !path.isAbsolute(options.inbox)
      || typeof options.directory !== 'string' || !path.isAbsolute(options.directory)
      || typeof options.codexPath !== 'string' || !path.isAbsolute(options.codexPath) || !fs.statSync(options.codexPath).isFile()
      || (options.includeEventId !== undefined && (typeof options.includeEventId !== 'string' || !UUID.test(options.includeEventId)))) throw new Error('invalid_queue_config');
    this.options = { ...options, inbox: canonical(options.inbox), directory: path.resolve(options.directory) };
    // Never place adapter files in the inbox itself or mutate its contents.
    fs.mkdirSync(this.options.directory, { recursive: true });
    this.ledgerFile = path.join(this.options.directory, 'queue-delivery.json');
    this.statusFile = path.join(this.options.directory, 'queue-status.json');
  }

  async start(): Promise<void> {
    if (this.running || this.lock) throw new Error('already_started');
    const lock = net.createServer(socket => socket.destroy());
    this.lock = lock;
    // Key is the canonical inbox, not the configurable output directory/thread.
    const pipe = `\\\\.\\pipe\\umouse-voice-queue-${digest(this.options.inbox).slice(0,32)}`;
    try {
      await new Promise<void>((resolve, reject) => {
        lock.once('error', reject); lock.listen(pipe, () => { lock.removeListener('error', reject); resolve(); });
      });
      if (!this.alive()) throw new Error('owner_not_running');
      // Watch before snapshot/baseline. The immediate full scan closes setup races.
      this.watcher = fs.watch(path.dirname(this.options.inbox), (_event, filename) => {
        if (filename === null || filename.toString().toLowerCase() === path.basename(this.options.inbox)) this.schedule();
      });
      this.watcher.on('error', () => { this.lastError = 'watch_failed'; void this.stop(); });
      lock.on('error', () => { this.lastError = 'lock_failed'; void this.stop(); });
      const messages = readVoiceSnapshot(this.options.inbox);
      this.ledger = this.load(messages);
      atomicJson(this.ledgerFile, this.ledger);
      this.running = true;
      // Liveness + cheap file metadata fallback for lost fs.watch events. No agent/MCP polling.
      this.lifecycle = setInterval(() => {
        if (!this.alive()) { this.lastError = 'owner_stopped'; void this.stop(); return; }
        try { if (this.fileSignature() !== this.signature) void this.scan(); }
        catch { this.lastError = 'inbox_unavailable'; void this.stop(); }
      }, 1000);
      await this.scan();
    } catch (error) { await this.stop(); throw error; }
  }

  status(): QueueStatus {
    const records = this.ledger?.records ?? [];
    return { running: this.running, processId: process.pid, ownerPid: this.options.ownerPid, threadId: this.options.threadId,
      queued: records.filter(r => r.state === 'queued').length, unknown: records.filter(r => r.state === 'unknown').length,
      acknowledged: records.filter(r => r.acknowledged).length, lastError: this.lastError, updatedAt: new Date().toISOString() };
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.debounce); clearInterval(this.lifecycle); this.watcher?.close(); this.watcher = undefined;
    await this.work;
    if (this.ledger) { try { atomicJson(this.statusFile, this.status()); } catch { /* stopping */ } }
    const lock = this.lock; this.lock = undefined;
    if (lock?.listening) await new Promise<void>(resolve => lock.close(() => resolve()));
  }

  /** Full bounded read, also useful for deterministic tests; never starts a model for an empty inbox. */
  scan(): Promise<void> {
    this.dirty = true;
    if (!this.work) {
      this.work = this.drain().finally(() => {
        this.work = undefined;
        // A storage/watch failure also releases the consumer lock for library users.
        if (!this.running) void this.stop();
      });
    }
    return this.work;
  }

  private schedule(): void {
    this.dirty = true;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { if (this.running) void this.scan(); }, 25);
  }

  private async drain(): Promise<void> {
    while (this.running && this.dirty) {
      this.dirty = false;
      try {
        const signature = this.fileSignature(); // captured BEFORE read: cannot hide a concurrent replacement
        const messages = readVoiceSnapshot(this.options.inbox);
        for (const m of messages) {
          const existing = this.ledger.records.find(r => r.eventId === m.eventId);
          if (existing) {
            if (m.acknowledged && !existing.acknowledged) { existing.acknowledged = true; atomicJson(this.ledgerFile, this.ledger); }
            continue; // queued AND unknown are never automatically submitted twice
          }
          if (!this.running || !this.alive()) break;
          if (m.acknowledged || m.status !== 'ready' || !m.text?.trim() || this.ledger.baseline.includes(m.eventId)
            || (Date.parse(m.capturedAt) < Date.parse(this.ledger.enabledAt) && m.eventId !== this.options.includeEventId)) continue;
          if (this.ledger.records.length >= 10000) throw new Error('ledger_full');
          const entry: RecordEntry = { eventId: m.eventId, textSha256: digest(m.text), state: 'unknown', attemptedAt: new Date().toISOString() };
          this.ledger.records.push(entry);
          atomicJson(this.ledgerFile, this.ledger); // crash barrier before invoking CLI
          try {
            await (this.options.enqueue ?? ((thread, id) => enqueueCodexVoice(this.options.codexPath, thread, id)))(this.options.threadId, m.eventId);
          } catch { this.lastError = 'queue_outcome_unknown'; continue; }
          entry.state = 'queued'; entry.queuedAt = new Date().toISOString();
          atomicJson(this.ledgerFile, this.ledger);
        }
        this.signature = signature;
        atomicJson(this.statusFile, this.status());
      } catch {
        // Storage corruption or failed durable barrier: stop all future delivery.
        this.lastError = 'storage_or_snapshot_failed'; this.running = false;
        clearInterval(this.lifecycle); this.watcher?.close();
        try { atomicJson(this.statusFile, this.status()); } catch { /* fail closed */ }
      }
    }
  }

  private alive(): boolean {
    if (this.options.ownerAlive) return this.options.ownerAlive();
    try { process.kill(this.options.ownerPid, 0); return true; } catch { return false; }
  }

  private fileSignature(): string {
    const stat = fs.statSync(this.options.inbox, { bigint: true });
    return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
  }

  private load(messages: Message[]): Ledger {
    if (!fs.existsSync(this.ledgerFile)) {
      if (this.options.includeEventId && !messages.some(m => m.eventId === this.options.includeEventId && m.status === 'ready' && !m.acknowledged)) throw new Error('requested_event_unavailable');
      return { schemaVersion: 1, threadId: this.options.threadId, inbox: this.options.inbox, enabledAt: new Date().toISOString(),
        baseline: messages.filter(m => m.eventId !== this.options.includeEventId).map(m => m.eventId), records: [] };
    }
    if (fs.statSync(this.ledgerFile).size > MAX_BYTES) throw new Error('invalid_ledger');
    const value = JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8'));
    if (value.schemaVersion !== 1 || value.threadId !== this.options.threadId || value.inbox !== this.options.inbox
      || !validDate(value.enabledAt) || !Array.isArray(value.baseline) || value.baseline.length > 100
      || !value.baseline.every((id: unknown) => typeof id === 'string' && UUID.test(id))
      || new Set(value.baseline).size !== value.baseline.length || !Array.isArray(value.records) || value.records.length > 10000) throw new Error('invalid_ledger_binding');
    const ids = new Set<string>();
    for (const r of value.records) {
      if (!r || typeof r.eventId !== 'string' || !UUID.test(r.eventId) || ids.has(r.eventId) || value.baseline.includes(r.eventId)
        || typeof r.textSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.textSha256)
        || !['unknown','queued'].includes(r.state) || !validDate(r.attemptedAt)
        || (r.state === 'queued' ? !validDate(r.queuedAt) : r.queuedAt !== undefined)
        || (r.acknowledged !== undefined && typeof r.acknowledged !== 'boolean')) throw new Error('invalid_ledger');
      ids.add(r.eventId);
    }
    return value;
  }
}
