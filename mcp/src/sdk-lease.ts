import net from 'node:net';
import os from 'node:os';
import { createHash } from 'node:crypto';

export interface DeviceLease {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
  status(): { supported: boolean; state: 'idle' | 'owned' | 'busy' | 'error' | 'unsupported'; error?: string };
}

/** Windows kernel-owned named pipe: process death releases the lease, no stale lock files.
 * Only arbitration, no device data or commands are carried over the pipe.
 * Other platforms preserve their existing startup behavior; cross-platform arbitration is unaccepted.
 */
export class SdkLease implements DeviceLease {
  private server: net.Server | undefined;
  private pending: Promise<boolean> | undefined;
  private state: ReturnType<DeviceLease['status']>['state'] = 'idle';
  private error: string | undefined;
  private readonly pipe: string | undefined;

  constructor(pipe?: string, private readonly onLost: () => void = () => {}) {
    const identity = createHash('sha256').update(os.homedir().toLowerCase()).digest('hex').slice(0, 24);
    this.pipe = pipe ?? (process.platform === 'win32' ? '\\\\.\\pipe\\umouse-sdk-' + identity : undefined);
    if (!this.pipe) this.state = 'unsupported';
  }

  tryAcquire(): Promise<boolean> {
    if (this.state === 'owned' || !this.pipe) return Promise.resolve(true);
    if (this.server) return Promise.resolve(false); // failed owner must retire SDK before rebinding
    if (this.pending) return this.pending;
    this.pending = new Promise<boolean>(resolve => {
      const server = net.createServer(socket => socket.destroy());
      const failed = (error: NodeJS.ErrnoException) => {
        this.state = error.code === 'EADDRINUSE' ? 'busy' : 'error';
        this.error = this.state === 'error' ? error.code ?? 'pipe_error' : undefined;
        server.close();
        resolve(false);
      };
      server.once('error', failed);
      server.listen({ path: this.pipe!, exclusive: true }, () => {
        server.off('error', failed);
        // Later errors must not silently permit another SDK owner.
        const lost = () => {
          if (this.server !== server || this.state === 'error') return;
          this.state = 'error'; this.error = 'pipe_runtime_error';
          this.onLost();
        };
        server.on('error', lost);
        server.on('close', lost);
        server.unref();
        this.server = server;
        this.state = 'owned';
        this.error = undefined;
        resolve(true);
      });
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async release(): Promise<void> {
    await this.pending;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    this.state = this.pipe ? 'idle' : 'unsupported';
    this.error = undefined;
  }

  status(): ReturnType<DeviceLease['status']> {
    return { supported: !!this.pipe, state: this.state, ...(this.error ? { error: this.error } : {}) };
  }
}
