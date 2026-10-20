/*
 * tool-capabilities.ts —— 工具↔能力映射与展示层门控（v2）
 *
 * 两层门控的展示层：至少一台在线设备明确支持、SDK 实现可用且配置允许时，
 * 才向模型公开对应操作工具。查询/状态/能力/事件观察类工具恒可见。
 * 执行层强校验在 CapabilityGate + 各工具入口（tools.ts 落实）——客户端缓存
 * 旧工具列表时，执行层仍必须拒绝。
 *
 * 多设备：工具目录可呈现在线设备的能力并集，但每次操作仅按选定设备判断
 * （执行层落实，不把 A 的能力授予 B）。
 */

/** 工具可见性/执行所需的能力类别 */
export type ToolCapability = 'mouse_control' | 'keyboard_control' | 'voice' | 'raw-diagnostic';

export interface ToolSpec {
  name: string;
  /** undefined = 恒可见（查询/事件/会话类） */
  capability?: ToolCapability;
}

/** 鼠标注入家族（capability=mouse_control） */
export const MOUSE_INJECTION_TOOLS = [
  'umouse_cursor_move', 'umouse_cursor_click', 'umouse_cursor_scroll',
  'umouse_button', 'umouse_cursor_drag', 'umouse_cursor_move_to', 'umouse_cursor_click_at',
  'umouse_key_release_all',
] as const;

/** 键盘注入（capability=keyboard_control） */
export const KEYBOARD_INJECTION_TOOLS = ['umouse_key_tap'] as const;

/** 诊断原始写入（capability=raw-diagnostic：须 UMSDK_RAW_DIAG=1） */
export const RAW_DIAGNOSTIC_TOOLS = ['umouse_write_raw'] as const;

export interface VisibilityInputs {
  online: { id: string }[];
  supportOf(deviceId: string, capability: string): 'supported' | 'unsupported' | 'unknown' | undefined;
  /** SDK 实现/进程配置开关（与能力声明分层的软件就绪事实） */
  software: {
    injectionEnabled: boolean;
    keyboardInjectionEnabled: boolean;
    rawDiagEnabled: boolean;
  };
}

export interface VisibilityResult {
  visible: Set<string>;
  hidden: Record<string, string>; // name → 原因（诊断/呈现用）
}

export function computeVisibility(specs: ToolSpec[], input: VisibilityInputs): VisibilityResult {
  const mouseSupported = input.online.some((d) => input.supportOf(d.id, 'mouse_control') === 'supported');
  const keyboardSupported = input.online.some((d) => input.supportOf(d.id, 'keyboard_control') === 'supported');
  const voiceSupported = input.online.some((d) => input.supportOf(d.id, 'voice') === 'supported');
  const visible = new Set<string>();
  const hidden: Record<string, string> = {};
  for (const spec of specs) {
    if (spec.name === 'umouse_key_release_all') {
      if (input.software.injectionEnabled && (mouseSupported || (input.software.keyboardInjectionEnabled && keyboardSupported))) visible.add(spec.name);
      else hidden[spec.name] = '当前没有允许输入的鼠标或键盘能力';
      continue;
    }
    if (!spec.capability) { visible.add(spec.name); continue; }
    let ok = false;
    let reason = '';
    switch (spec.capability) {
      case 'mouse_control':
        ok = input.software.injectionEnabled && mouseSupported;
        reason = !input.software.injectionEnabled
          ? '注入工具面已由配置关闭（UMSDK_INJECTION=0）'
          : '当前没有在线设备的 mouse_control 能力被声明为 supported（未知即禁止执行；可用 UMSDK_TEST_CAPS 声明）';
        break;
      case 'keyboard_control':
        ok = input.software.injectionEnabled && input.software.keyboardInjectionEnabled && keyboardSupported;
        reason = !input.software.keyboardInjectionEnabled
          ? '键盘注入未启用（UMSDK_INJECT_KEYBOARD=1）'
          : '当前没有在线设备的 keyboard_control 能力被声明为 supported';
        break;
      case 'voice':
        // voice 产品默认 supported；无在线设备时工具保留（启动即可查询/说明），执行层拦截
        ok = true;
        if (!voiceSupported && input.online.length > 0) reason = '（提示）在线设备无 voice 声明';
        break;
      case 'raw-diagnostic':
        ok = input.software.rawDiagEnabled;
        reason = '原始写入仅诊断模式开放（UMSDK_RAW_DIAG=1）；普通会话不提供任意 raw 写入';
        break;
    }
    if (ok) visible.add(spec.name);
    else hidden[spec.name] = reason;
  }
  return { visible, hidden };
}
