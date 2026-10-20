import { createHash } from 'node:crypto';
/** Per-connection idempotency, bounded without evicting live/terminal side-effect tombstones. */
export class OperationRegistry {
  private owners = new Map<string, Map<string, { hash: string; result: Promise<unknown> }>>();
  run(owner: string, id: string, args: object, action: () => Promise<unknown>): Promise<unknown> {
    const hash = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    const entries = this.owners.get(owner) ?? new Map(); this.owners.set(owner, entries);
    const previous = entries.get(id);
    if (previous) { if (previous.hash !== hash) throw new Error('request_id_conflict'); return previous.result; }
    if (entries.size >= 256 || [...this.owners.values()].reduce((n, e) => n + e.size, 0) >= 2048) throw new Error('operation_quota');
    // Defer execution until the tombstone is installed, including synchronous callback paths.
    const result = Promise.resolve().then(action); const entry = { hash, result }; entries.set(id, entry);
    // Keep the side-effect tombstone while dropping large images from the cache.
    // The first caller still gets the full result; retries never execute again.
    void result.then(value => {
      let cacheable = false;
      try { cacheable = Buffer.byteLength(JSON.stringify(value) ?? 'null') <= 32768; } catch { /* Keep a tombstone for unserializable receipts too. */ }
      if (!cacheable) entry.result = Promise.resolve({ ok: false, error: 'result_not_cached', alreadyExecuted: true, retryAutomatic: false });
    }, () => {});
    return result;
  }
  close(owner: string): void { this.owners.delete(owner); }
}
