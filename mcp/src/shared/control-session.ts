import { randomUUID } from 'node:crypto';
import type { Reservation, ResourceArbiter } from './resource-arbiter.js';

/** A task owns hardware across calls. An action failure never revokes this ownership. */
export class ControlSession {
  private task?: { owner: string; taskId: string; id: string; startedAt: string; closing: boolean; lease: Reservation };
  constructor(private readonly arbiter: ResourceArbiter) {}
  begin(owner: string, taskId: string) {
    if (this.task) {
      if (this.task.owner !== owner || this.task.taskId !== taskId || this.task.closing) throw new Error('control_busy');
      return this.status(owner);
    }
    const lease = this.arbiter.acquire(owner, 'hardware-control');
    this.task = { owner, taskId, id: randomUUID(), startedAt: new Date().toISOString(), closing: false, lease };
    return this.status(owner);
  }
  status(owner: string) {
    const t = this.task, owned = t?.owner === owner;
    return { active: !!t, owned, closing: t?.closing ?? false, epoch: this.arbiter.epoch,
      task_id: owned ? t?.taskId : undefined, control_id: owned ? t?.id : undefined, startedAt: t?.startedAt };
  }
  require(owner: string, id: string | undefined): void {
    if (!this.task) throw new Error('control_required');
    if (this.task.owner !== owner) throw new Error('control_busy');
    if (!id || this.task.id !== id) throw new Error('control_token_invalid');
    if (this.task.closing) throw new Error('control_closing');
  }
  async release(owner: string, drain: () => Promise<void>): Promise<void> {
    const t = this.task;
    if (!t || t.owner !== owner) return;
    t.closing = true;
    await drain();
    if (this.task === t) { this.arbiter.release(t.lease); this.task = undefined; }
  }
  get owner(): string | undefined { return this.task?.owner; }
}
