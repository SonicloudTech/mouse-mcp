import { z } from 'zod';
import { windowIdSchema } from '../hardware-contract.js';

const delay_ms = z.number().int().min(20).max(100).default(30);
const axis = z.number().int().min(-127).max(127).default(0);
export const inputSequenceSchema = z.object({
  control_id: z.string().uuid().optional().describe('umouse_control begin 返回的任务控制令牌；执行输入时必须提供'),
  pid: z.number().int().positive().max(0xffffffff).optional(), window_id: windowIdSchema.optional().describe('可选意图标注，不做窗口执法'),
  device_id: z.string().min(1).max(128).describe('设备序列号 SN（须与在线设备精确匹配；不是帧序号）'),
  frames: z.array(z.discriminatedUnion('kind', [
    // SDK 0.4.24 exposes only left/right/middle bits. Reject unsupported tail frames before any input.
    z.object({ kind: z.literal('mouse'), buttons: z.number().int().min(0).max(7).default(0), dx: axis, dy: axis, wheel: axis, delay_ms }).strict(),
    z.object({ kind: z.literal('keyboard'), modifiers: z.number().int().min(0).max(255).default(0),
      keys: z.array(z.number().int().min(4).max(231)).max(6).default([]).refine(keys => new Set(keys).size === keys.length), delay_ms }).strict(),
  ])).min(1).max(128),
  timeout_ms: z.number().int().min(100).max(20000).default(20000),
  client_request_id: z.string().min(1).max(128),
}).strict();
export const sequenceReceiptSchema = z.object({
  outcome: z.enum(['completed', 'rejected', 'aborted', 'timed_out', 'indeterminate']),
  transport: z.object({ attempted: z.number().int().nonnegative(), written: z.number().int().nonnegative(), writeFailed: z.number().int().nonnegative() }),
  cleanup: z.enum(['not_needed', 'release_written', 'release_unconfirmed']),
  effectConfirmed: z.literal(false),
}).passthrough().refine(r => r.transport.attempted === r.transport.written + r.transport.writeFailed
  && (r.outcome !== 'completed' || (r.transport.writeFailed === 0 && r.cleanup !== 'release_unconfirmed')));
