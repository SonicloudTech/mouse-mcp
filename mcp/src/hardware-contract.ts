import { z } from 'zod';
import type { HardwareActionResult } from './action-context.js';
export class InputError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'InputError'; }
}
const int = z.number().int().min(-100000).max(100000);
export const windowIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/)
  .refine(value => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn, '窗口句柄超过u64范围');
const common = { x: int, y: int };
// positioning precision: standard stops inside 4px; high keeps correcting toward
// 1px with bounded micro frames and never fails where standard would pass.
const precision = z.enum(['standard', 'high']).default('standard');
export const hardwareRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), ...common, button: z.enum(['left', 'right', 'middle']).default('left'), count: z.number().int().min(1).max(3).default(1), precision }).strict(),
  z.object({ kind: z.literal('move'), ...common, precision }).strict(),
  z.object({ kind: z.literal('scroll'), ...common, direction: z.enum(['up', 'down']), amount: z.number().int().min(1).max(10), precision }).strict(),
  z.object({ kind: z.literal('drag'), ...common, toX: int, toY: int, button: z.enum(['left', 'right', 'middle']).default('left'), precision }).strict(),
]);
export type MouseHardwareRequest = z.infer<typeof hardwareRequestSchema>;
const receiptSchema = z.object({
  outcome: z.enum(['completed', 'rejected', 'aborted', 'timed_out', 'indeterminate']),
  transport: z.object({ attempted: z.number().int().nonnegative(), written: z.number().int().nonnegative(), writeFailed: z.number().int().nonnegative() }),
  cleanup: z.enum(['not_needed', 'release_written', 'release_confirmed', 'release_unconfirmed']),
  effectConfirmed: z.literal(false).optional(),
  verification: z.object({
    schemaVersion: z.literal(1),
    source: z.literal('windows-raw-input'),
    feedbackReliable: z.boolean(),
    buttonIntegrity: z.enum(['confirmed', 'failed', 'not_required', 'unavailable']),
    pressObserved: z.boolean(),
    releaseObserved: z.boolean(),
    releaseStateConfirmed: z.boolean(),
    observedPresses: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    observedReleases: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).passthrough().optional(),
  timing: z.object({ queueMs: z.number().finite().nonnegative(), totalMs: z.number().finite().nonnegative() }),
}).passthrough().refine(result => result.transport.attempted === result.transport.written + result.transport.writeFailed
  && (result.outcome !== 'completed' || (result.transport.writeFailed === 0 && result.cleanup !== 'release_unconfirmed')));
/** Validate before clearing the durable intent marker or returning a hardware input success. */
export function validateHardwareReceipt(value: unknown, action: MouseHardwareRequest, requireVerification = false): HardwareActionResult {
  const parsed = receiptSchema.safeParse(value);
  const invalid = (): never => { throw new InputError('invalid_receipt', '硬件执行返回无效或互相矛盾的确认结果'); };
  if (!parsed.success) return invalid();
  const result = parsed.data, verification = result.verification;
  if (requireVerification && (!verification || result.effectConfirmed !== false)) return invalid();
  // Older TypeScript executors remain transport-only. They cannot claim a confirmed release.
  if (!verification) {
    if (result.cleanup === 'release_confirmed') return invalid();
    return value as HardwareActionResult;
  }
  if (result.effectConfirmed !== false
    || verification.pressObserved !== (verification.observedPresses > 0)
    || verification.releaseObserved !== (verification.observedReleases > 0)) return invalid();
  // Zero reported edges do not prove that no edges occurred after a monitor failure.
  if (!verification.feedbackReliable && (result.outcome === 'completed' || verification.buttonIntegrity === 'confirmed'
    || result.cleanup === 'release_confirmed' || verification.releaseStateConfirmed)) return invalid();
  if (result.cleanup === 'release_confirmed' && (!verification.releaseObserved || !verification.releaseStateConfirmed)) return invalid();
  if (verification.releaseStateConfirmed && result.cleanup !== 'release_confirmed') return invalid();
  if (verification.buttonIntegrity === 'confirmed' && (!verification.pressObserved || !verification.releaseObserved
    || verification.observedPresses !== verification.observedReleases || !verification.releaseStateConfirmed
    || result.cleanup !== 'release_confirmed'
    || result.transport.written < verification.observedPresses + verification.observedReleases)) return invalid();
  // Movement batches tolerate observed interference edges: they are reported
  // telemetry (otherEdges/deviceHeldAfter), not a validity contradiction.
  if (verification.buttonIntegrity === 'not_required' && result.cleanup !== 'not_needed') return invalid();
  if (result.outcome === 'completed') {
    if (result.errorCode !== undefined) return invalid();
    const target = action.kind === 'drag' ? { x: action.toX, y: action.toY } : { x: action.x, y: action.y };
    const point = result.final as { x?: unknown; y?: unknown } | undefined;
    const residual = result.residual as { dx?: unknown; dy?: unknown } | undefined;
    if (!point || !residual || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)
      || !Number.isSafeInteger(residual.dx) || !Number.isSafeInteger(residual.dy)
      || residual.dx !== target.x - (point.x as number) || residual.dy !== target.y - (point.y as number)
      || Math.abs(residual.dx as number) > 4 || Math.abs(residual.dy as number) > 4) return invalid();
    if (action.kind === 'click' || action.kind === 'drag') {
      const expected = action.kind === 'click' ? (action.count ?? 1) : 1;
      if (verification.buttonIntegrity !== 'confirmed' || result.cleanup !== 'release_confirmed'
        || verification.observedPresses !== expected || verification.observedReleases !== expected) return invalid();
    } else if (verification.buttonIntegrity !== 'not_required' || result.cleanup !== 'not_needed') return invalid();
  }
  return value as HardwareActionResult;
}

export const mouseActionSchema = z.object({
  control_id: z.string().uuid().optional().describe('umouse_control begin 返回的任务控制令牌；执行输入时必须提供'),
  device_id: z.string().min(1).max(128),
  action: hardwareRequestSchema,
  pid: z.number().int().positive().max(0xffffffff).optional(),
  window_id: windowIdSchema.optional().describe('可选意图标注：随回执回显（windowContext.intent），不做窗口执法；真实落点见回执 topmost'),
  timeout_ms: z.number().int().min(100).max(20000).default(20000),
  client_request_id: z.string().min(1).max(128),
}).strict();
export function validateTarget(a: { pid?: number; window_id?: string }): void {
  if ((a.pid === undefined) !== (a.window_id === undefined)) throw new InputError('invalid_target', 'pid 和 window_id 必须同时提供或同时省略');
}
