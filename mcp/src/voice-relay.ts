/** Host-side library only. Uses an existing MCP client and an explicitly bound host.
 * No SDK import, process launch, UI input, or polling daemon.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface VoiceRelayMcp {
  callTool(request: { name: string; arguments: Record<string, unknown> }, options?: { signal: AbortSignal }): Promise<unknown>;
}

export interface VoiceRelayHost {
  isBusy(threadId: string, signal: AbortSignal): Promise<boolean>;
  submit(input: { threadId: string; text: string; eventId: string }, signal: AbortSignal): Promise<{ turnId: string }>;
}

export interface VoiceRelayOptions {
  directory: string;
  threadId: string;
  mcp: VoiceRelayMcp;
  host: VoiceRelayHost;
  timeoutMs?: number;
}

type Delivery = {
  eventId: string;
  textSha256: string;
  state: 'pending' | 'accepted' | 'unknown';
  turnId?: string;
  acknowledged?: boolean;
};
type Ledger = { schemaVersion: 1; threadId: string; records: Delivery[] };
export type VoiceRelayResult = {
  accepted: number;
  acknowledged: number;
  deferred: number;
  unknown: number;
  ignored: number;
  ackFailed: number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
// 10,000 records can include 256-character UTF-8 turn IDs; use the same read/write budget.
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const queues = new Map<string, Promise<unknown>>();
const summary = (): VoiceRelayResult => ({ accepted: 0, acknowledged: 0, deferred: 0, unknown: 0, ignored: 0, ackFailed: 0 });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;

/** Throws sanitized errors: ports may include tokens, audio paths, or transcripts in errors. */
function decode(result: unknown): Record<string, unknown> {
  if (!object(result) || result.isError === true) throw new Error('voice_relay_mcp_error');
  if (object(result.structuredContent)) return result.structuredContent;
  if (!Array.isArray(result.content) || result.content.length !== 1) throw new Error('voice_relay_invalid_result');
  const item = result.content[0];
  if (!object(item) || item.type !== 'text' || typeof item.text !== 'string' || item.text.length > 8 * 1024 * 1024) {
    throw new Error('voice_relay_invalid_result');
  }
  try {
    const value: unknown = JSON.parse(item.text);
    if (object(value)) return value;
  } catch { /* sanitize malformed responses */ }
  throw new Error('voice_relay_invalid_result');
}

/** One ledger must have one owning host process. Calls/instances in that process are serialized. */
export class VoiceRelay {
  private readonly file: string;
  private readonly queueKey: string;
  private readonly threadId: string;
  private readonly mcp: VoiceRelayMcp;
  private readonly host: VoiceRelayHost;
  private readonly timeoutMs: number;

  constructor(options: VoiceRelayOptions) {
    if (!validId(options.threadId)) throw new Error('voice_relay_invalid_thread');
    this.threadId = options.threadId; // copy once; caller/ASR cannot mutate the binding
    this.mcp = options.mcp;
    this.host = options.host;
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) throw new Error('voice_relay_invalid_timeout');
    this.file = path.resolve(options.directory, 'delivery.json');
    this.queueKey = process.platform === 'win32' ? this.file.toLowerCase() : this.file;
  }

  /** Recover only accepted deliveries by retrying the idempotent inbox ack. Never submits. */
  startRecovery(): Promise<VoiceRelayResult> {
    return this.serial(async () => {
      const ledger = this.read();
      const result = summary();
      await this.recover(ledger, result);
      result.unknown = ledger.records.filter(r => r.state === 'unknown').length;
      return result;
    });
  }

  /** One bounded scan. Busy hosts queue pending messages; no implicit steering or new thread. */
  pollOnce(): Promise<VoiceRelayResult> {
    return this.serial(async () => {
      const ledger = this.read();
      const result = summary();
      await this.recover(ledger, result);
      const inbox = decode(await this.bounded(signal => this.mcp.callTool({
        name: 'umouse_voice_inbox', arguments: { include_acknowledged: false, limit: 100 },
      }, { signal })));
      if (!Array.isArray(inbox.messages) || inbox.messages.length > 100 || !object(inbox.status)
        || inbox.status.storageError !== false) throw new Error('voice_relay_invalid_inbox');
      // The current tool has no pagination. Refuse an undersized window, rather than starve
      // later messages behind retained failed/unknown entries in an expanded server inbox.
      if (typeof inbox.status.unread !== 'number' || inbox.status.unread > 100) throw new Error('voice_relay_inbox_window_exceeded');

      for (const message of inbox.messages) {
        if (!object(message) || typeof message.eventId !== 'string' || !uuid.test(message.eventId)
          || message.source !== 'physical-speech-button' || message.status !== 'ready'
          || message.acknowledged !== false || typeof message.text !== 'string'
          || !message.text.trim() || message.text.length > 32000) { result.ignored++; continue; }

        const hash = createHash('sha256').update(message.text).digest('hex');
        let delivery = ledger.records.find(r => r.eventId === message.eventId);
        if (!delivery) {
          if (ledger.records.length >= 10000) throw new Error('voice_relay_ledger_full');
          delivery = { eventId: message.eventId, textSha256: hash, state: 'pending' };
          ledger.records.push(delivery);
          this.write(ledger);
        }
        if (delivery.state === 'accepted' || delivery.state === 'unknown') continue;
        if (delivery.textSha256 !== hash) {
          delivery.state = 'unknown'; // a stable ID must not change the intended message
          this.write(ledger);
          continue;
        }

        let busy: boolean;
        try { busy = await this.bounded(signal => this.host.isBusy(this.threadId, signal)); }
        catch { result.deferred++; continue; }
        if (busy !== false) { result.deferred++; continue; }

        // Crash barrier: once submission might occur, any restart sees unknown, never pending.
        // Even a crash just before sending sacrifices availability to avoid duplicate actions.
        delivery.state = 'unknown';
        this.write(ledger);
        let receipt: { turnId: string };
        try {
          receipt = await this.bounded(signal => this.host.submit({
            threadId: this.threadId, text: message.text as string, eventId: delivery!.eventId,
          }, signal));
        } catch { continue; } // all failed/timeout submissions are unknown; never auto-resubmit
        if (!object(receipt) || !validId(receipt.turnId)) continue;

        delivery.state = 'accepted';
        delivery.turnId = receipt.turnId;
        this.write(ledger); // if this fails, disk retains unknown and ack is never attempted
        result.accepted++;
        await this.ack(ledger, delivery, result);
      }
      result.unknown = ledger.records.filter(r => r.state === 'unknown').length;
      return result;
    });
  }

  private async recover(ledger: Ledger, result: VoiceRelayResult): Promise<void> {
    for (const delivery of ledger.records) {
      if (delivery.state === 'accepted' && !delivery.acknowledged) await this.ack(ledger, delivery, result);
    }
  }

  private async ack(ledger: Ledger, delivery: Delivery, result: VoiceRelayResult): Promise<void> {
    try {
      const response = decode(await this.bounded(signal => this.mcp.callTool({
        name: 'umouse_ack_voice', arguments: { event_id: delivery.eventId },
      }, { signal })));
      if (response.ok !== true || response.eventId !== delivery.eventId) throw new Error('invalid_ack');
    } catch { result.ackFailed++; return; }
    delivery.acknowledged = true;
    this.write(ledger); // failure is safe: next recovery repeats only the idempotent ack
    result.acknowledged++;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.queueKey) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    const settled = current.then(() => {}, () => {});
    queues.set(this.queueKey, settled);
    void settled.then(() => { if (queues.get(this.queueKey) === settled) queues.delete(this.queueKey); });
    return current;
  }

  private async bounded<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => call(controller.signal)),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('voice_relay_timeout')); }, this.timeoutMs);
        }),
      ]);
    } catch { throw new Error('voice_relay_port_failed'); }
    finally { clearTimeout(timer); }
  }

  private read(): Ledger {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (!fs.existsSync(this.file)) return { schemaVersion: 1, threadId: this.threadId, records: [] };
      if (fs.statSync(this.file).size > MAX_LEDGER_BYTES) throw new Error('oversized');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.schemaVersion !== 1 || saved.threadId !== this.threadId || !Array.isArray(saved.records) || saved.records.length > 10000) throw new Error('invalid');
      const ids = new Set<string>();
      for (const record of saved.records) {
        if (!object(record) || typeof record.eventId !== 'string' || !uuid.test(record.eventId) || ids.has(record.eventId)
          || typeof record.textSha256 !== 'string' || !sha.test(record.textSha256)
          || !['pending', 'accepted', 'unknown'].includes(record.state as string)
          || (record.state === 'accepted' ? !validId(record.turnId) : record.turnId !== undefined)
          || (record.acknowledged !== undefined && (typeof record.acknowledged !== 'boolean' || record.state !== 'accepted'))) throw new Error('invalid');
        ids.add(record.eventId);
      }
      return saved as Ledger;
    } catch { throw new Error('voice_relay_storage_unavailable_or_binding_mismatch'); }
  }

  private write(ledger: Ledger): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      const json = JSON.stringify(ledger);
      if (Buffer.byteLength(json, 'utf8') > MAX_LEDGER_BYTES) throw new Error('oversized');
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, json);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.file);
    } catch { throw new Error('voice_relay_storage_unavailable'); }
    finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
      try { fs.unlinkSync(temporary); } catch { /* renamed or cleanup unavailable */ }
    }
  }
}
