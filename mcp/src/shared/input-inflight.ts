/**
 * input-inflight.ts —— worker 强杀后的分级自动恢复
 *
 * 旧语义：sdk-running.json 残留（worker 非正常退出）一律锁存 faulted，必须
 * 人工 manage recover --hardware-reset-confirmed（含硬件重置确认）。经用户确认
 * 改为"重启进程即恢复、尽量避免人工介入"，同时不假报硬件已清理：
 *
 * 证据分级（对每个残留文件单独判定）：
 *   - movement-only（批次内从未出现 buttons≠0 / 键盘键位）：光标读数即真相，
 *     最坏影响 hover 效果，可观察可自愈 → 随运行标记一起自动归档；
 *   - 按键嫌疑（in-flight 未到终态，或不确定记录涉及按键）：不直接放行，
 *     worker 重启后执行 input.cleanup（全键扫描 → 至多一次零按钮/零键位
 *     释放帧 → 复验），全部抬起才归档证据；仍按下则维持故障与人工门槛；
 *   - 无法解析的文件：保守视为按键嫌疑，同上走扫描验证。
 * 归档一律保留原始字节（.auto-recovered-* / .released-*），绝不删除证据。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

/** daemon 侧输入在途标志；终态不等于动作成功或物理释放。 */
export class InputInFlightFlag {
  constructor(readonly file: string) {}
  /** movementOnly：本批次从未携带按键位（buttons 恒 0、无键盘键位/修饰）。 */
  begin(movementOnly = false): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 2, pid: process.pid, at: new Date().toISOString(), movementOnly }) + '\n');
    fs.renameSync(tmp, this.file);
  }
  /** 仅在确认收到有效原生终态时清除；RPC 失联仍保留。 */
  end(terminal: boolean): void { if (terminal) fs.rmSync(this.file, { force: true }); }
  get present(): boolean { return fs.existsSync(this.file); }
}

/** 从版本化插件清单读取 umouse/fake 插件的 runtimeStateDir（运行标记所在目录）。 */
export function stateDirFromManifest(manifestFile: string): string {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { plugins?: Array<{ id?: string; config?: { runtimeStateDir?: unknown } }> };
  const dir = manifest.plugins?.find(p => p.id === 'umouse' || p.id === 'fake')?.config?.runtimeStateDir;
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('runtime_state_dir_required');
  return dir;
}

export interface AutoRecoveryEvidence {
  stateDir: string; runMarker: string;
  /** movement-only 证据与纯移动在途标志：随运行标记自动归档。 */
  autoClearable: string[];
  /** 按键嫌疑证据：须在 worker 重启后经 input.cleanup 验证/释放才可归档。 */
  verifyRequired: string[];
}

/** 判定 uncertain/quarantine 标记文件是否 movement-only（所有 scope 记录均声明且为真）。 */
function markerIsMovementOnly(file: string): boolean | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { scopes?: Record<string, { movementOnly?: unknown }> };
    const scopes = parsed?.scopes;
    if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes) || Object.keys(scopes).length === 0) return undefined;
    const records = Object.values(scopes);
    return records.every(r => !!r && typeof r === 'object' && r.movementOnly === true);
  } catch { return undefined; }
}

/** 判定在途标志是否 movement-only（schemaVersion 2 起携带）。 */
function inFlightIsMovementOnly(file: string): boolean | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { movementOnly?: unknown };
    return parsed?.movementOnly === true;
  } catch { return undefined; }
}

/** 评估自动恢复条件。uncertainBase = sharedSafetyDir ?? dataDir（与 daemon/input 一致）。 */
export function autoRecoveryEvidence(stateDir: string, uncertainBase?: string): AutoRecoveryEvidence {
  const base = uncertainBase ?? path.join(os.homedir(), '.umouse-mcp-shared-safety-v2');
  const inFlight = path.join(stateDir, 'input-in-flight.json');
  const uncertain = path.join(base, 'shared-v2', 'input-uncertain.json');
  const quarantine = path.join(stateDir, 'native-input-quarantine.json');
  const autoClearable: string[] = [], verifyRequired: string[] = [];
  const assess = (file: string, movementOnly: boolean | undefined): void => {
    if (!fs.existsSync(file)) return;
    (movementOnly === true ? autoClearable : verifyRequired).push(file);
  };
  assess(inFlight, inFlightIsMovementOnly(inFlight));
  assess(uncertain, markerIsMovementOnly(uncertain));
  assess(quarantine, markerIsMovementOnly(quarantine));
  return { stateDir, runMarker: path.join(stateDir, 'sdk-running.json'), autoClearable, verifyRequired };
}

/** 归档证据文件（保留字节，绝不删除）；文件不存在时静默跳过。 */
export function archiveEvidenceFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const archive = `${file}.auto-recovered-${process.pid}-${Date.now()}`;
  fs.renameSync(file, archive);
  return archive;
}

/** 归档残留运行标记（保留证据，绝不删除）；调用前须确认门控通过且标记存在。 */
export function archiveRunMarker(evidence: AutoRecoveryEvidence): string {
  const archive = `${evidence.runMarker}.auto-recovered-${process.pid}-${Date.now()}`;
  fs.renameSync(evidence.runMarker, archive);
  return archive;
}
