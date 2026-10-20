/*
 * state.ts —— 在线设备状态聚合
 *
 * 权威在线列表来自 SDK 查询（deviceList）；此处聚合 deviceInfo 事件携带的
 * 电量/设备类型/会议状态等富信息，供 umouse_list_devices 输出。
 * 断开设备保留最近快照（connected=false），便于 agent 解释"刚掉线的谁"。
 */

export interface DeviceState {
  id: string;
  connMode: 'USB' | 'BLE' | '?';
  connected: boolean;
  /** 连接代次（每次 connected 递增）：能力快照与语音会话的换代隔离键 */
  generation: number;
  battery?: number;
  deviceType?: string;
  status?: string;
  lastSeen: number;
  firstSeen: number;
}

interface DeviceInfoPayload {
  type: 'deviceInfo';
  sn?: string;
  battery?: number;
  deviceType?: string;
  status?: string;
}

export class DeviceRegistry {
  private map = new Map<string, DeviceState>();
  private generations = new Map<string, number>();

  onConnected(id: string, connMode: number): void {
    const now = Date.now();
    const prev = this.map.get(id);
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    this.map.set(id, {
      id,
      connMode: connMode === 1 ? 'BLE' : connMode === 0 ? 'USB' : '?',
      connected: true,
      generation,
      battery: prev?.battery,
      deviceType: prev?.deviceType,
      status: prev?.status,
      lastSeen: now,
      firstSeen: prev?.firstSeen ?? now,
    });
  }

  /** 设备连接代次（从未见过返回 0） */
  ensureConnected(id: string, mode: number): void {
    if (!this.map.get(id)?.connected) this.onConnected(id, mode);
  }

  generationOf(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  onDisconnected(id: string): void {
    const s = this.map.get(id);
    if (s) {
      s.connected = false;
      s.lastSeen = Date.now();
      s.status = 'normal';
    }
  }

  onDeviceInfo(id: string, payload: DeviceInfoPayload): void {
    if (!id) return; // 全局事件无设备归属
    if (!this.map.has(id)) this.onConnected(id, -1);
    const now = Date.now();
    const s =
      this.map.get(id) ??
      ({ id, connMode: '?', connected: true, generation: 1, lastSeen: now, firstSeen: now } as DeviceState);
    if (typeof payload.battery === 'number') s.battery = payload.battery;
    if (typeof payload.deviceType === 'string') s.deviceType = payload.deviceType;
    if (typeof payload.status === 'string') s.status = payload.status;
    s.lastSeen = now;
    this.map.set(id, s);
  }

  /** 合并 SDK 权威列表与富信息（SDK 在线优先，顺序按接入序） */
  list(live: { id: string; mode: string }[]): DeviceState[] {
    const out: DeviceState[] = [];
    for (const d of live) {
      const s = this.map.get(d.id);
      out.push({
        id: d.id,
        connMode: (d.mode === 'USB' || d.mode === 'BLE' ? d.mode : '?') as DeviceState['connMode'],
        connected: true,
        generation: s?.generation ?? 1,
        battery: s?.battery,
        deviceType: s?.deviceType,
        status: s?.status,
        lastSeen: s?.lastSeen ?? Date.now(),
        firstSeen: s?.firstSeen ?? Date.now(),
      });
    }
    return out;
  }

  stats(): { tracked: number; online: number } {
    let online = 0;
    for (const s of this.map.values()) if (s.connected) online++;
    return { tracked: this.map.size, online };
  }

  clear(): void {
    // Retain generations across SDK reconfigure: reusing an old generation would
    // let delayed callbacks/held-input cleanup act on a replacement device.
    this.map.clear();
  }
}
