/** Bounded FIFO for short Windows TCP identity probes; never queues hardware work. */
export class PeerCheckQueue {
  private running = 0;
  private waiting: Array<{ start(): void; expire(): void }> = [];
  constructor(private readonly concurrency = 8, private readonly capacity = 32, private readonly waitMs = 2500) {}
  get status() { return { running: this.running, queued: this.waiting.length }; }
  run(check: () => Promise<boolean>): Promise<boolean> {
    if (this.running < this.concurrency) return this.execute(check);
    if (this.waiting.length >= this.capacity) return Promise.resolve(false);
    return new Promise(resolve => {
      const entry = {
        start: () => { clearTimeout(timer); void this.execute(check).then(resolve); },
        expire: () => { const i = this.waiting.indexOf(entry); if (i >= 0) this.waiting.splice(i, 1); resolve(false); },
      };
      const timer = setTimeout(entry.expire, this.waitMs);
      timer.unref(); this.waiting.push(entry);
    });
  }
  private async execute(check: () => Promise<boolean>): Promise<boolean> {
    this.running++;
    try { return await check(); } catch { return false; }
    finally { this.running--; this.waiting.shift()?.start(); }
  }
}
