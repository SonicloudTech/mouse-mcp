/*
 * capability-gate.ts —— 能力执行门控（v2 语音计划 ）
 *
 * 两层门控的执行层：每次实际调用/设备写入前强校验。工具展示层见 tool-capabilities.ts。
 * 统一错误码：capability_unknown / capability_unsupported / capability_disabled /
 * device_offline / device_generation_changed / sdk_not_ready。
 *
 * 规则：设备在线、SDK 有函数导出、命令写入成功都 ≠ 设备支持；缺少某能力
 * 不禁用其它能力（语音不依赖鼠标反控就绪）。管理配置可以禁用（disabled），
 * 但不能把 unknown 提升为 supported——提升只能来自 registry 的声明更新。
 */
import type { DeviceCapabilityRegistry, DeviceCapabilities } from './device-capabilities.js';

export type GateErrorCode =
  | 'capability_unknown'
  | 'capability_unsupported'
  | 'capability_disabled'
  | 'device_offline'
  | 'device_generation_changed'
  | 'sdk_not_ready';

export type GateDecision = { allowed: true } | { allowed: false; code: GateErrorCode; capability?: string; message: string };

/** 管理配置层：按能力全局禁用（与 env 进程开关对应；不含语音——语音按会话运行态判断） */
export interface GateConfig {
  disabled?: Record<string, string | true>; // capability → true|原因
}

export interface DeviceRuntimeState {
  online: boolean;
  generation: number;
}

export class CapabilityGate {
  constructor(
    private readonly registry: DeviceCapabilityRegistry,
    private readonly config: GateConfig = {},
    private readonly runtime: { isOnline(deviceId: string): boolean } = { isOnline: () => true },
  ) {}

  /** 执行前强校验。generationKnown：调用方持有的快照代次（G04 排队后撤销场景），缺省跳过代次比对。 */
  check(deviceId: string, capability: string, opts: { generationKnown?: number } = {}): GateDecision {
    const disabled = this.config.disabled?.[capability];
    if (disabled) {
      return {
        allowed: false, code: 'capability_disabled', capability,
        message: `能力 ${capability} 已被本服务配置禁用${disabled === true ? '' : `：${disabled}`}`,
      };
    }
    const entry = this.registry.supportOf(deviceId, capability);
    if (!entry || entry.support === 'unknown') {
      return {
        allowed: false, code: 'capability_unknown', capability,
        message: `设备 ${deviceId} 的 ${capability} 能力未知：硬件能力信息尚未提供，禁止执行。`
          + `需要以测试能力配置（UMSDK_TEST_CAPS）或硬件信息接口声明后开放。`,
      };
    }
    if (entry.support === 'unsupported') {
      return {
        allowed: false, code: 'capability_unsupported', capability,
        message: `设备 ${deviceId} 不支持 ${capability}（声明来源：${entry.source}）。`,
      };
    }
    if (!this.runtime.isOnline(deviceId)) {
      return { allowed: false, code: 'device_offline', capability, message: `设备 ${deviceId} 当前不在线。` };
    }
    if (opts.generationKnown !== undefined && opts.generationKnown !== this.registry.currentGeneration(deviceId)) {
      return {
        allowed: false, code: 'device_generation_changed', capability,
        message: `设备 ${deviceId} 连接代次已变化（排队/等待期间重连），本次调用作废；请重新确认设备后重试。`,
      };
    }
    return { allowed: true };
  }

  /** 设备能力全景（v1 umouse_get_capabilities / v2 umouse_list_devices 输出）。offline 设备保留快照。 */
  describe(deviceId: string, runtime: DeviceRuntimeState): DeviceCapabilities & { runtime: DeviceRuntimeState } {
    const snap = this.registry.get(deviceId) ?? {
      schemaVersion: 1 as const, deviceId, generation: 0, revision: 0, capabilities: {},
    };
    return { ...snap, runtime };
  }
}
