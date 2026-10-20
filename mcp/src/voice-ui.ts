/*
 * voice-ui.ts —— 录音浮窗子进程管理
 *
 * 与 umouse-voice-ui.exe（Rust/Win32，不抢焦点）以受限行协议通信：
 *   下行 U <TAB> session <TAB> state <TAB> mode <TAB> preview <TAB> elapsedMs
 *   上行 F <TAB> session（完成） / C <TAB> session（取消）
 * 预览文本中的 Tab/CR/LF 替换为空格（协议字段分隔符保护）。
 *
 * 生命周期：一个活动会话一个浮窗进程；会话终态即关（stdin EOF → 进程自退，
 * 不留后台）。exe 缺失/启动失败 → 本会话无浮窗（VAD/硬上限/工具入口仍在，
 * manual_only 模式必须至少一个完成入口可用的约束由调用方校验）。
 * UI 发来的 finish/cancel 只作用于其 sessionId 标记的会话——旧浮窗不能关闭
 * 下一次录音（旧消息按会话身份丢弃）。
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Writable, Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import fs from 'node:fs';

export interface VoiceUiSessionView {
  sessionId: string;
  state: string;
  destination: 'agent-reply' | 'cursor-dictation';
  preview: string;
  createdAt: number;
  change?: string;
}

export interface VoiceUiControllerOptions {
  exePath: string | null;
  /** 可选启动参数（测试以 node stub.js 冒充 exe） */
  exeArgs?: string[];
  onFinish(sessionId: string): void;
  onCancel(sessionId: string): void;
  onDiagnostic?(info: Record<string, unknown>): void;
}

const UI_STATE_MAP: Record<string, string> = {
  preparing: 'recording', opening: 'recording', 'ptt-capturing': 'recording', listening: 'recording',
  'stop-requested': 'finalizing', draining: 'finalizing', finalizing: 'finalizing',
  ready: 'done', delivered: 'done',
  'awaiting-key-up': 'busy',
  'delivery-unknown': 'error', failed: 'error', cancelled: 'done', 'no-speech': 'done', 'close-unconfirmed': 'finalizing',
};

export class VoiceUiController {
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private currentSession: string | null = null;
  /** 最近一个已达终态的会话：其迟到更新不再复活浮窗（单活动会话语义） */
  private retiredSession: string | null = null;
  private closed = false;
  readonly available: boolean;

  constructor(private readonly opts: VoiceUiControllerOptions) {
    this.available = !!opts.exePath && fs.existsSync(opts.exePath);
    if (!this.available) {
      opts.onDiagnostic?.({ component: 'voice-ui', note: `浮窗不可用（exe 未找到：${opts.exePath ?? '未配置'}）；会话仍有 VAD/上限/工具完成入口` });
    }
  }

  /** 协调器 update 事件入口（新会话 spawn；终态 close） */
  onSessionUpdate(view: VoiceUiSessionView): void {
    if (view.sessionId === this.retiredSession && view.change !== 'terminal') return; // 已退役会话的迟到更新
    if (view.change === 'preview' && this.currentSession === view.sessionId) {
      this.writeUpdate(view); // 同会话预览刷新：不重启进程
      return;
    }
    if (this.currentSession !== view.sessionId) {
      if (view.change === 'terminal') return; // 旧会话的迟到终态：忽略
      this.close();
      this.currentSession = view.sessionId;
      this.spawnWindow();
    }
    if (view.change === 'terminal') {
      this.writeUpdate(view);
      this.retiredSession = view.sessionId;
      this.close();
      return;
    }
    this.writeUpdate(view);
  }

  private spawnWindow(): void {
    if (!this.available || !this.opts.exePath || this.closed) return;
    try {
      const child = spawn(this.opts.exePath, this.opts.exeArgs ?? [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this.child = child;
      child.stdin.on('error', () => {}); // process can exit between write() and pipe delivery
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => this.onLine(line));
      child.on('exit', () => { if (this.child === child) this.child = null; });
      child.on('error', () => { if (this.child === child) this.child = null; });
    } catch {
      this.child = null;
    }
  }

  private onLine(line: string): void {
    const parts = line.split('\t');
    if (parts.length !== 2) return;
    const [op, session] = parts;
    // 只接受当前浮窗所属会话的指令（旧浮窗/迟到消息按身份丢弃）
    if (session !== this.currentSession) return;
    if (op === 'F') this.opts.onFinish(session);
    else if (op === 'C') this.opts.onCancel(session);
  }

  private writeUpdate(view: VoiceUiSessionView): void {
    const child = this.child;
    if (!child || child.killed) return;
    const preview = view.preview.replace(/[\t\r\n]+/g, ' ');
    const line = `U\t${view.sessionId}\t${UI_STATE_MAP[view.state] ?? 'recording'}\t${view.destination === 'cursor-dictation' ? 'ptt' : 'agent'}\t${preview}\t${Date.now() - view.createdAt}\n`;
    try { child.stdin.write(line); } catch { /* 进程退出竞态：忽略 */ }
  }

  /** 结束当前浮窗（stdin EOF → 进程自退） */
  close(): void {
    const child = this.child;
    this.currentSession = null;
    this.child = null;
    if (child) {
      try { child.stdin.end(); } catch { /* 已退出 */ }
      // 2s 内未自退则强杀（不留后台独立录音进程）
      const killer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 2000);
      child.on('exit', () => clearTimeout(killer));
    }
  }

  dispose(): void {
    this.closed = true;
    this.close();
  }
}
