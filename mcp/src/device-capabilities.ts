/*
 * device-capabilities.ts —— 设备能力注册表（v2 语音计划 ）
 *
 * 职责：按 deviceId + 连接代次（generation）保存可扩展的能力快照；
 * 区分能力声明的来源（产品默认 / 测试配置 / 连接时硬件信息）；
 * 提供 applyDeviceCapabilities(deviceId, generation, snapshot) 内部更新接口，
 * 供后续硬件信息获取协议接入——不重写各消费方的判断逻辑。
 *
 * 硬约束：
 *  - voice 为产品默认 supported（来源标 product-default，不伪装实测）；
 *  - mouse_control / keyboard_control 默认 unknown——禁止执行，直到明确声明；
 *  - 管理配置可以禁用能力，但"配置允许"不能把 unknown 变成 supported
 *    （该规则由 CapabilityGate 落实，本表只记录声明事实）；
 *  - 换代（重连）后 hardware-info 声明作废（需重新交付）；test-profile 持续适用；
 *  - 未知能力字段可保留供诊断，但不因此动态生成工具（tool-capabilities 落实）。
 */
import { randomUUID } from 'node:crypto';

export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';
export type CapabilitySource = 'product-default' | 'test-profile' | 'hardware-info';

export interface CapabilityEntry {
  support: CapabilitySupport;
  source: CapabilitySource;
  updatedAt: number;
}

export interface DeviceCapabilities {
  schemaVersion: 1;
  deviceId: string;
  generation: number;
  revision: number;
  capabilities: Record<string, CapabilityEntry>;
}

/** 注册表声明的能力定义（扩展能力必须先注册，G07）；adapter/tooling 另行绑定 */
export interface CapabilityDefinition {
  id: string;
  description: string;
  /** 产品默认支持声明（默认 false：未声明的扩展能力为 unknown） */
  productDefault?: CapabilitySupport;
}

const CAP_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

const BUILTIN_DEFINITIONS: CapabilityDefinition[] = [
  { id: 'voice', description: '设备语音输入能力（PTT 听写与会议语音流程）', productDefault: 'supported' },
  { id: 'mouse_control', description: '硬件鼠标反控（移动/按键/滚轮，协议 0xF0）' },
  { id: 'keyboard_control', description: '硬件键盘反控（HID 键盘报文，协议 0xF1）' },
];

/** 来源权威序：hardware-info > test-profile > product-default（同能力后到的高权威可覆盖） */
const SOURCE_RANK: Record<CapabilitySource, number> = {
  'product-default': 0,
  'test-profile': 1,
  'hardware-info': 2,
};

export class DeviceCapabilityRegistry {
  private definitions = new Map<string, CapabilityDefinition>();
  private devices = new Map<string, DeviceCapabilities>();
  /** 测试能力配置（按设备；source=test-profile，跨代次持续适用） */
  private testProfiles = new Map<string, Record<string, CapabilitySupport>>();
  private changeListeners = new Set<() => void>();

  constructor() {
    for (const def of BUILTIN_DEFINITIONS) this.registerCapability(def);
  }

  /** 注册/更新能力定义。扩展能力（非内置三件）注册前不得出现在任何快照里。 */
  registerCapability(def: CapabilityDefinition): void {
    if (!CAP_ID_RE.test(def.id)) throw new Error(`能力 ID 非法: ${def.id}（小写字母开头，≤64 字符）`);
    if (typeof def.description !== 'string' || !def.description.trim()) throw new Error('能力描述不能为空');
    this.definitions.set(def.id, { ...def });
  }

  knownCapabilities(): CapabilityDefinition[] {
    return [...this.definitions.values()].map((d) => ({ ...d }));
  }

  /** 设置测试能力声明（按设备声明，不写成产品默认值）。空对象=清除。 */
  setTestProfile(deviceId: string, caps: Record<string, CapabilitySupport>): void {
    if (!deviceId) throw new Error('deviceId 不能为空');
    for (const [id, support] of Object.entries(caps)) {
      if (!this.definitions.has(id)) throw new Error(`测试配置引用未注册能力: ${id}`);
      if (!['supported', 'unsupported', 'unknown'].includes(support)) throw new Error(`能力取值非法: ${support}`);
    }
    if (Object.keys(caps).length === 0) this.testProfiles.delete(deviceId);
    else this.testProfiles.set(deviceId, { ...caps });
    // 非破坏性应用：首见设备先落产品默认，随后按来源权威规则覆盖——
    // 不清掉既有 hardware-info 声明（低权威写不进高权威，见 applySource）。
    const previous = this.devices.get(deviceId);
    const hardware = Object.fromEntries(Object.entries(previous?.capabilities ?? {})
      .filter(([, entry]) => entry.source === 'hardware-info').map(([key, entry]) => [key, entry.support]));
    this.rebuild(deviceId, previous?.generation, hardware);
  }

  /**
   * 内部更新接口：后续"连接时获取的硬件信息"协议在此接入。
   * generation 必须与当前代次一致（G04：旧代次投递拒绝）。
   */
  applyDeviceCapabilities(deviceId: string, generation: number, snapshot: Record<string, CapabilitySupport>): void {
    const current = this.devices.get(deviceId);
    if (current && current.generation !== generation) {
      throw new Error(`能力快照代次失配：当前 ${current.generation}，投递 ${generation}`);
    }
    for (const [id, support] of Object.entries(snapshot)) {
      if (!this.definitions.has(id)) throw new Error(`硬件信息引用未注册能力: ${id}`);
      if (!['supported', 'unsupported', 'unknown'].includes(support)) throw new Error(`能力取值非法: ${support}`);
    }
    this.applySource(deviceId, generation, 'hardware-info', snapshot);
  }

  /** 设备连接换代：hardware-info 声明作废（重新交付前），产品默认与测试配置重建。 */
  onGenerationChange(deviceId: string, generation: number): void {
    const prev = this.devices.get(deviceId);
    if (prev && prev.generation >= generation) return; // 代次单调
    this.rebuild(deviceId, generation);
  }

  /** 设备离线：保留最后快照供诊断（connected:false 由调用方呈现），不清理声明。 */
  onDeviceOffline(deviceId: string): void {
    /* 保留快照；换代时统一重建 */
  }

  get(deviceId: string): DeviceCapabilities | undefined {
    const snap = this.devices.get(deviceId);
    return snap ? structuredClone(snap) : undefined;
  }

  supportOf(deviceId: string, capability: string): CapabilityEntry | undefined {
    const snap = this.devices.get(deviceId);
    return snap?.capabilities[capability];
  }

  currentGeneration(deviceId: string): number {
    return this.devices.get(deviceId)?.generation ?? 0;
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private rebuild(deviceId: string, generation?: number, hardware: Record<string, CapabilitySupport> = {}): void {
    const prev = this.devices.get(deviceId);
    // setTestProfile（无显式代次）保持当前代次；onGenerationChange 传入新代次
    const gen = generation ?? prev?.generation ?? 1;
    const capabilities: Record<string, CapabilityEntry> = {};
    const updatedAt = Date.now();
    for (const def of this.definitions.values()) {
      capabilities[def.id] = { support: def.productDefault ?? 'unknown', source: 'product-default', updatedAt };
    }
    // 测试配置覆盖
    const profile = this.testProfiles.get(deviceId);
    for (const [id, support] of Object.entries(profile ?? {})) capabilities[id] = { support, source: 'test-profile', updatedAt };
    for (const [id, support] of Object.entries(hardware)) capabilities[id] = { support, source: 'hardware-info', updatedAt };
    this.devices.set(deviceId, { schemaVersion: 1, deviceId, generation: gen, revision: (prev?.revision ?? 0) + 1, capabilities });
    for (const listener of this.changeListeners) { try { listener(); } catch { /* observer only */ } }
  }

  private applySource(deviceId: string, generation: number, source: CapabilitySource, caps: Record<string, CapabilitySupport>): void {
    let snap = this.devices.get(deviceId);
    if (!snap || snap.generation !== generation) {
      snap = { schemaVersion: 1, deviceId, generation, revision: 0, capabilities: {} };
      this.devices.set(deviceId, snap);
    }
    let changed = false;
    for (const [id, support] of Object.entries(caps)) {
      const existing = snap.capabilities[id];
      // 高权威来源可更新低权威声明；同权威可更新（新声明覆盖旧声明）
      if (existing && SOURCE_RANK[existing.source] > SOURCE_RANK[source]) continue;
      if (existing && existing.support === support && existing.source === source) continue;
      snap.capabilities[id] = { support, source, updatedAt: Date.now() };
      changed = true;
    }
    if (changed) {
      snap.revision += 1;
      for (const cb of this.changeListeners) {
        try { cb(); } catch { /* 监听器异常不阻断 */ }
      }
    }
  }
}

/** 生成一次性会话 id（语音会话与交付账本共用格式） */
export function newSessionId(): string {
  return randomUUID();
}
