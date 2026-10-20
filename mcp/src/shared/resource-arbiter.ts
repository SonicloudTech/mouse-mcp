import { randomUUID } from 'node:crypto';

export interface Reservation { readonly token: string; readonly owner: string; readonly resource: string; readonly epoch: string }
/** Fail-fast resource reservations. There is deliberately no input replay queue. */
export class ResourceArbiter {
  private held = new Map<string, Reservation>();
  constructor(readonly epoch: string) {}
  acquire(owner: string, resource: string): Reservation {
    if (this.held.has(resource)) throw new Error('resource_busy');
    const r = Object.freeze({ token: randomUUID(), owner, resource, epoch: this.epoch }); this.held.set(resource, r); return r;
  }
  release(r: Reservation): boolean {
    if (this.held.get(r.resource) !== r || r.epoch !== this.epoch) return false;
    return this.held.delete(r.resource);
  }
  has(resource: string): boolean { return this.held.has(resource); }
}
