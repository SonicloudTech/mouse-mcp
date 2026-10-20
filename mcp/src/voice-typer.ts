/*
 * voice-typer.ts —— 语音听写的文本交付端口
 *
 * Windows 首版推荐一次 typer.typeText(finalText)：Unicode 键盘输入，
 * 不动剪贴板、不逐字队列。返回成功只记 submitted（系统输入 API 接受），
 * 可见落字由实机验收——不声称已验证。
 *
 * 交付规则（由 VoiceCoordinator.deliver + 本端口共同落实）：
 *  - 取"此刻"前台焦点（不在提交前寻找/切换窗口）；
 *  - 文本上限与控制字符检查；换行规范为可见分隔空格，不调 Enter；
 *  - 原子写入 delivery=attempting 后立即一次 typeText；
 *  - 失败/中断区分 未尝试/可能部分输入/未知；不自动重放、不自动退格。
 *
 * P1 提供不可用实现（available=false，交付保留结果）；P4 接真 typer 绑定。
 */
import type { VoiceTyperPort } from './voice-session.js';

/** 控制字符（C0 + DEL）检测：识别文本里不允许出现（防快捷键注入面） */
export function containsControlCharacters(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** 交付前文本规范化：换行/回车 → 空格（不调用 Enter） */
export function normalizeForTyping(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

export const TYPING_TEXT_LIMIT = 4000;

export function createUnavailableTyper(reason = 'typer 绑定未加载（P4 接入）'): VoiceTyperPort {
  return {
    available: false,
    id: 'unavailable',
    async deliver() {
      return { outcome: 'unavailable', error: reason };
    },
  };
}
