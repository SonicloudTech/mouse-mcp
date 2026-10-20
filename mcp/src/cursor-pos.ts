/*
 * cursor-pos.ts —— 光标位置回读（闭环绝对定位的观测端）
 *
 * koffi 惰性加载 user32：物理光标位置 / GetSystemMetrics(虚拟屏幕范围)。
 * 仅 Windows；其它平台导出 null（工具面按可用性注册，调用处给可读错误）。
 * 闭环用：虚拟桌面物理像素；每次同步读取范围时临时使用线程PMv2并恢复。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface CursorReader {
  /** 当前光标位置（虚拟屏幕像素）；读取失败返回 null */
  read(): { x: number; y: number } | null;
  /** 虚拟屏幕边界 {left, top, right, bottom}（含各屏） */
  bounds(): { left: number; top: number; right: number; bottom: number };
}

let cachedReader: CursorReader | undefined;

export function createCursorReader(): CursorReader | null {
  if (process.platform !== 'win32') return null;
  if (cachedReader) return cachedReader;
  try {
    // koffi 类型名进程内全局：模块级注册一次，防多实例撞名
    const koffi = require('koffi') as typeof import('koffi');
    const POINT = koffi.struct({ x: 'long', y: 'long' });
    const user32 = koffi.load('user32.dll');
    const GetCursorPos = user32.func('GetPhysicalCursorPos', 'bool', [koffi.pointer(POINT)]);
    const GetSystemMetrics = user32.func('int GetSystemMetrics(int)');
    const SetThreadDpiAwarenessContext = user32.func('intptr_t SetThreadDpiAwarenessContext(intptr_t)');
    cachedReader = {
      read() {
        let p: ReturnType<typeof koffi.alloc> | undefined;
        try {
          p = koffi.alloc(POINT, 1);
          koffi.encode(p, POINT, { x: 0, y: 0 });
          if (!GetCursorPos(p)) return null;
          const d = koffi.decode(p, POINT);
          return { x: d.x, y: d.y };
        } catch {
          return null;
        } finally {
          if (p) koffi.free(p);
        }
      },
      bounds() {
        const old = SetThreadDpiAwarenessContext(-4);
        if (!old) throw new Error('无法读取物理虚拟桌面范围：线程DPI上下文不可用');
        try {
          const left = GetSystemMetrics(76);    // SM_XVIRTUALSCREEN
          const top = GetSystemMetrics(77);     // SM_YVIRTUALSCREEN
          return {
            left,
            top,
            right: left + GetSystemMetrics(78) - 1,   // SM_CXVIRTUALSCREEN
            bottom: top + GetSystemMetrics(79) - 1,   // SM_CYVIRTUALSCREEN
          };
        } finally { SetThreadDpiAwarenessContext(old); }
      },
    };
    return cachedReader;
  } catch {
    return null;
  }
}
