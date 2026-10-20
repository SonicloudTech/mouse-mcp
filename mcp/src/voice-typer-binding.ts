/*
 * voice-typer-binding.ts —— typer.dll 真实交付端口 + 焦点快照 + 交付账本（v2）
 *
 * Windows 首版语义：
 *  - 一次 typer.typeText(finalText)：Unicode 键盘输入，不动剪贴板，不逐字队列；
 *  - 提交前取"此刻"前台焦点快照（HWND/pid/窗口标题——只读检查，不读正文，
 *    不切换窗口）；换行规范为空格、控制字符拒绝、长度上限；
 *  - 返回 submitted 仅表示系统输入 API 接受——可见落字由实机验收；
 *  - 失败/中断区分 未尝试/可能部分输入/未知；不自动重放、不自动退格；
 *  - 交付账本（voice-v2 目录）：submitted 只记 hash+长度；未交付/未知保留
 *    正文供用户处理，配额滚动（200 条 / 2MB），启动不重放。
 *
 * 真实注入测试仅在用户明确要求时进行——本模块的自动化测试全部走 fake 绑定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { normalizeForTyping, containsControlCharacters, TYPING_TEXT_LIMIT } from './voice-typer.js';
import type { VoiceTyperPort } from './voice-session.js';
import { protectNewPrivateFile } from './private-file.js';

interface TyperLike {
  version(): string;
  probe(): Record<string, unknown>;
  init(): boolean;
  typeText(utf8: string): number;
  strerror(rc: number): string;
  shutdown(): Promise<void>;
}

export interface FocusSnapshot {
  hwnd: number;
  pid: number;
  title: string;
  at: number;
}

export interface TyperLedgerEntry {
  kind: 'deliver';
  sessionId: string;
  at: string;
  outcome: 'attempting' | 'submitted' | 'failed' | 'unknown';
  rc?: number;
  error?: string;
  textLength: number;
  textSha256: string;
  /** 仅未成功交付时保留正文（供用户明确处理）；成功交付不存明文 */
  text?: string;
  focus?: FocusSnapshot;
}

const LEDGER_MAX_ENTRIES = 200;
const LEDGER_MAX_BYTES = 2 * 1024 * 1024;
let focusFunctions: { foreground: () => unknown; processId: (hwnd: number, out: Buffer) => unknown;
  title: (hwnd: number, out: Buffer, length: number) => number } | undefined;

/** 前台焦点快照（只读；不读取控件正文，不切换窗口） */
export function snapshotFocus(): FocusSnapshot | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    if (!focusFunctions) {
      const require = createRequire(import.meta.url);
      const koffi = require('koffi') as typeof import('koffi');
      const user32 = koffi.load('user32.dll');
      focusFunctions = { foreground: user32.func('intptr_t GetForegroundWindow()'),
        processId: user32.func('uint32_t GetWindowThreadProcessId(intptr_t, void *)'),
        title: user32.func('int GetWindowTextW(intptr_t, uint16_t *, int)') };
    }
    const hwnd = Number(focusFunctions.foreground());
    if (!hwnd) return undefined;
    const pidPtr = Buffer.alloc(4);
    focusFunctions.processId(hwnd, pidPtr);
    const pid = pidPtr.readUInt32LE(0);
    const buf = Buffer.alloc(512);
    const n = focusFunctions.title(hwnd, buf, 256);
    let title = '';
    if (n > 0) {
      title = buf.subarray(0, Math.min(n, 255) * 2).toString('utf16le');
    }
    return { hwnd, pid, title, at: Date.now() };
  } catch {
    return undefined;
  }
}

/** 交付账本：JSONL 追加 + 配额滚动（保留最新 N 条 / 字节数内） */
export class DeliveryLedger {
  private file: string;

  constructor(dir: string) {
    this.file = path.join(dir, 'deliveries.jsonl');
  }

  has(sessionId: string): boolean { return this.read().some(entry => entry.sessionId === sessionId); }

  private read(): TyperLedgerEntry[] {
    try { return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as TyperLedgerEntry); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }

  record(entry: TyperLedgerEntry): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let entries = this.read().filter(old => old.sessionId !== entry.sessionId);
    entries.push(entry);
    entries = entries.slice(-LEDGER_MAX_ENTRIES);
    let body = entries.map(value => JSON.stringify(value) + '\n').join('');
    while (Buffer.byteLength(body) > LEDGER_MAX_BYTES && entries.length > 1) {
      entries.shift(); body = entries.map(value => JSON.stringify(value) + '\n').join('');
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { protectNewPrivateFile(temporary); fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
    } finally { try { fs.unlinkSync(temporary); } catch { /* renamed or unwritten */ } }
  }
}

export interface RealTyperOptions {
  ledgerDir: string;
  /** Reject before any ledger/input attempt when another input flow owns the desktop. */
  beforeInput?: () => void;
  /** 测试注入 fake 绑定（不触真实输入） */
  bindingOverride?: { Typer: new () => TyperLike };
  onDiagnostic?: (info: Record<string, unknown>) => void;
}

interface TyperBindingModule {
  Typer: new () => TyperLike;
}

function defaultTyperLibPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const plat = process.platform as 'win32' | 'linux' | 'darwin';
  const names: Record<string, string> = { win32: 'typer.dll', linux: 'libtyper.so', darwin: 'libtyper.dylib' };
  return path.resolve(here, '..', '..', 'lib', names[plat] ?? names.win32);
}

let cachedModule: TyperBindingModule | null | undefined;

function loadTyperBinding(): TyperBindingModule | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    if (!fs.existsSync(defaultTyperLibPath())) {
      cachedModule = null;
      return cachedModule;
    }
    const require = createRequire(import.meta.url);
    cachedModule = require('../../doc/typer.js') as TyperBindingModule;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

/**
 * 创建真实 typer 交付端口。DLL 缺失/探测失败/权限拒绝 → available=false
 * （交付保留结果，会话进入 ready 而非崩溃）。
 */
export function createRealTyper(options: RealTyperOptions): VoiceTyperPort & { shutdown(): Promise<void>; capsText?: string } {
  const ledger = new DeliveryLedger(options.ledgerDir);
  const binding = options.bindingOverride ?? loadTyperBinding();
  if (!binding) {
    options.onDiagnostic?.({ component: 'voice-typer', note: `typer 库不可用（${defaultTyperLibPath()} 缺失）——听写交付保留结果待处理` });
    return {
      available: false, id: 'unavailable',
      async deliver() { return { outcome: 'unavailable', error: 'typer 库未加载' }; },
      async shutdown() {},
    };
  }
  let typer: TyperLike | null = null;
  let capsText: string | undefined;
  try {
    typer = new binding.Typer();
    const caps = typer.probe();
    capsText = JSON.stringify(caps);
    const permitted = caps.input_permitted === 1 || caps.input_permitted === true;
    const textTyping = caps.text_typing === 1 || caps.text_typing === true;
    if (!permitted || !textTyping) {
      options.onDiagnostic?.({ component: 'voice-typer', note: `typer 能力不足（text_typing=${String(textTyping)} permitted=${String(permitted)}）——不注入` });
      const denied = typer; void Promise.resolve().then(() => denied.shutdown()).catch(() => {});
      typer = null;
    } else if (!typer.init()) {
      options.onDiagnostic?.({ component: 'voice-typer', note: 'typer init 失败（打字线程未建立）' });
      const failed = typer; void Promise.resolve().then(() => failed.shutdown()).catch(() => {});
      typer = null;
    }
  } catch (error) {
    options.onDiagnostic?.({ component: 'voice-typer', note: `typer 探测异常：${error instanceof Error ? error.message : String(error)}` });
    if (typer) { const failed = typer; void Promise.resolve().then(() => failed.shutdown()).catch(() => {}); }
    typer = null;
  }
  if (!typer) {
    return {
      available: false, id: 'unavailable', capsText,
      async deliver() { return { outcome: 'unavailable', error: 'typer 不可用' }; },
      async shutdown() {},
    };
  }
  const live = typer;
  let closed = false;
  return {
    get available() { return !closed; },
    id: `typer:${live.version()}`,
    async deliver(req) {
      if (closed) return { outcome: 'unavailable', error: 'typer 已关闭' };
      try { options.beforeInput?.(); }
      catch { return { outcome: 'unavailable', error: '桌面输入忙碌或存在未知效果；保留文本，不自动重试' }; }
      // 1) 文本检查）：换行先规范为空格（合法），其余控制字符拒绝；长度上限
      const text = normalizeForTyping(req.text);
      if (containsControlCharacters(text)) {
        return { outcome: 'failed', error: '识别文本包含控制字符，拒绝输入（防快捷键注入面）' };
      }
      if (text.length > TYPING_TEXT_LIMIT) {
        return { outcome: 'failed', error: `文本超长（${text.length} > ${TYPING_TEXT_LIMIT}）` };
      }
      if (!text.trim()) return { outcome: 'failed', error: '无可输入内容' };
      // 2) 此刻焦点快照（只读；不为寻找目标切窗口）
      const focus = snapshotFocus();
      try {
        if (ledger.has(req.sessionId)) return { outcome: 'failed', error: '本会话已有交付尝试，禁止自动重放' };
        ledger.record({ kind: 'deliver', sessionId: req.sessionId, at: new Date().toISOString(),
          outcome: 'attempting', textLength: text.length, textSha256: sha(text), text, focus });
      } catch { return { outcome: 'failed', error: '交付账本不可持久化，未发送输入' }; }
      // 3) 原子执行：一次 typeText（不队列、不重试）
      let rc: number;
      try {
        rc = live.typeText(text);
      } catch (error) {
        const entry: TyperLedgerEntry = { kind: 'deliver', sessionId: req.sessionId, at: new Date().toISOString(), outcome: 'unknown', error: error instanceof Error ? error.message : String(error), textLength: text.length, textSha256: sha(text), text, focus };
        try { ledger.record(entry); } catch { /* durable attempting remains, never replay */ }
        return { outcome: 'unknown', error: entry.error ?? '输入异常' };
      }
      const outcome: TyperLedgerEntry['outcome'] = rc === 0 ? 'submitted' : rc === -4 ? 'failed' : 'unknown';
      const entry: TyperLedgerEntry = {
        kind: 'deliver', sessionId: req.sessionId, at: new Date().toISOString(), outcome, rc,
        error: rc === 0 ? undefined : `rc=${rc} ${live.strerror(rc)}`,
        textLength: text.length, textSha256: sha(text),
        text: rc === 0 ? undefined : text, // 成功不留明文；失败/未知保留供用户处理
        focus,
      };
      try { ledger.record(entry); }
      catch { return { outcome: 'unknown', error: '输入已尝试，但交付结果未能持久化，禁止重试' }; }
      if (rc === 0) {
        return { outcome: 'submitted', note: '系统输入 API 已接受；可见落字属实机验收范围' };
      }
      return { outcome, error: entry.error ?? '输入失败' };
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      try { await live.shutdown(); } catch { /* 幂等 */ }
    },
    get capsText() { return capsText; },
  } as VoiceTyperPort & { shutdown(): Promise<void>; capsText?: string };
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 一次性会话 id（账本/诊断复用） */
export function newDeliveryId(): string {
  return randomUUID();
}
