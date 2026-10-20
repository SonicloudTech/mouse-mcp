import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Only bounded protocol codes may enter diagnostic status; never exception text. */
export function diagnosticErrorCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : 'unclassified_error';
}

/** Opt-in timing metadata only; never log voice, credentials or arbitrary tool arguments. */
export class DiagnosticLog {
  private fd?: number;
  private bytes = 0;
  private sequence = 0;
  failed = false;
  constructor(directory?: string) {
    if (!directory) return;
    if (!path.isAbsolute(directory) || directory.startsWith('\\\\')) throw new Error('local_diagnostics_directory_required');
    fs.mkdirSync(directory, { recursive: true });
    this.fd = fs.openSync(path.join(directory, `daemon-${process.pid}-${randomUUID()}.jsonl`), 'wx');
    this.record('trace.start', { clock: 'UTC + process monotonic milliseconds', maxBytes: 32 * 1024 * 1024 });
  }
  record(stage: string, fields: Record<string, unknown> = {}): void {
    if (this.fd === undefined || this.failed) return;
    try {
      const line = JSON.stringify({ ...fields, stage, utc: new Date().toISOString(), monoMs: performance.now(), pid: process.pid, sequence: ++this.sequence }) + '\n';
      if (Buffer.byteLength(line) > 16384 || this.bytes + Buffer.byteLength(line) > 32 * 1024 * 1024) {
        fs.writeSync(this.fd, JSON.stringify({stage:'trace.limit',utc:new Date().toISOString(),pid:process.pid})+'\n');
        this.close(); return;
      }
      this.bytes += fs.writeSync(this.fd, line);
    } catch { this.failed = true; this.close(); }
  }
  close(): void { const fd=this.fd; this.fd=undefined; if(fd!==undefined)try {fs.closeSync(fd);}catch {this.failed=true;} }
}
