import type { ServerResponse } from 'node:http';
import type { OutputBudget } from './output-budget.js';

/** Account actual outgoing chunks, including long-lived SSE notifications.
 * A fixed deadline per unflushed write cannot be extended by a trickle reader.
 */
export function guardHttpOutput(res: ServerResponse, budget: OutputBudget, onFailure: () => void, timeoutMs = 10_000): void {
  const pending = new Set<() => void>();
  res.once('close', () => { for (const release of pending) release(); });
  for (const method of ['write', 'end'] as const) {
    const original = res[method].bind(res) as (...args: any[]) => any;
    (res[method] as (...args: any[]) => any) = (...args: any[]) => {
      const chunk = args[0];
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return original(...args);
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof args[1] === 'string' ? args[1] as BufferEncoding : 'utf8') : chunk.byteLength;
      let releaseBytes: () => void;
      try { releaseBytes = budget.reserve(bytes); }
      catch (error) { res.destroy(); onFailure(); throw error; }
      const timer = setTimeout(() => { res.destroy(); onFailure(); }, timeoutMs); timer.unref();
      const release = () => { clearTimeout(timer); pending.delete(release); releaseBytes(); };
      pending.add(release);
      const callback = typeof args[1] === 'function' ? args[1] : typeof args[2] === 'function' ? args[2] : undefined;
      const encoding = typeof args[1] === 'string' ? args[1] : undefined;
      try { return original(chunk, encoding, (...values: unknown[]) => { release(); callback?.(...values); }); }
      catch (error) { release(); throw error; }
    };
  }
}
