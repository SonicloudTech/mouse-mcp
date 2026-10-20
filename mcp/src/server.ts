/* MCP protocol construction, separated from SDK startup for hardware-free integration tests. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SdkBridge } from './sdk-bridge.js';
import { registerTools, registerGatedTools } from './tools.js';
import type { UmEvent } from './events.js';

const NOTIFY_TYPES = new Set([
  'keyEvent', 'warning', 'queueOverflow', 'meetingBusy',
  'speechCaptured', 'speechTranscribed', 'connected', 'disconnected',
  'voiceSession', 'voiceBusy', 'voiceUnavailable', 'voiceCloseUnconfirmed',
  'meetingCreateFailed', 'audioSegmentComplete',
]);

export function createMcpServer(bridge: SdkBridge): McpServer {
  const server = new McpServer(
    { name: 'umouse-mcp', version: '0.1.0' },
    {
      capabilities: { logging: {} },
      instructions: [
      '声云智能鼠标（uMouse）硬件接入服务。设备经 2.4G 接收器（USB）或蓝牙连接本机，',
      '本服务把设备能力暴露为工具：按键事件流、语音采集与转写、会议模式，以及按设备能力开放的硬件反控。',
      '',
      '【起步】先调 umouse_status（服务健康/配置）→ umouse_get_capabilities（设备与能力：voice / mouse_control /',
      'keyboard_control 的声明状态、来源与可执行原因）→ umouse_list_devices（无设备返回空数组：让用户插接收器/开鼠标电源，等 connected 事件）。',
      '若 status.sdkOwnership.state=busy，表示另一 MCP 进程持有 SDK，当前连接会等待释放；先等待或正常关闭不用的连接，不要启动更多 SDK 或强杀活动进程。',
      '',
      '【能力门控（重要）】mouse_control / keyboard_control 未被声明（unknown）时，注入类工具不出现在工具列表且调用被拒；',
      '当前能力来源为 product-default / test-profile；hardware-info 为预留接口，尚未接入硬件上报。以 umouse_get_capabilities 为准，不推测反控能力。',
      'voice 为产品默认支持：语音问答与听写不依赖鼠标/键盘反控就绪。',
      '',
      '【设备寻址】单台在线时 device_id 一律可省略；多台在线必须显式指定（缺省会收到含在线列表的错误，照列表重试即可）。',
      '',
      '【语音输入范式】①Agent 语音问答：umouse_voice_start（会议模式开麦，就绪返回 listening）→ umouse_voice_wait 等最终文字',
      '（VAD 静音/完成按钮/上限结束；结果作为工具返回值，不向任何输入框打字）→ 需要中止用 umouse_voice_cancel。',
      '同一时间仅一个语音会话；umouse_voice_status 可查状态机位置与未确认关麦隔离。',
      '②物理语音键（按住说话）：用户按住鼠标语音键说话、松开即完成——服务自动转写并经 typer 输入当时的前台焦点（P2+ 生效）；',
      '旧持久 inbox（umouse_voice_inbox）仅 UMSDK_VOICE=0 时使用。',
      '原始录音事件 speechCaptured（payload 含 WAV 路径）仍在事件流中；监听用户物理按键用 types=["keyEvent"]。',
      '',
      '【注入（按能力开放）】umouse_cursor_* / umouse_button / umouse_key_release_all 需要 mouse_control supported；',
      'umouse_key_tap 需要 keyboard_control supported。工具未列出即代表当前没有可用目标——先 umouse_get_capabilities 查原因。',
      '需要精确落点时用 umouse_cursor_move_to(x,y)/umouse_cursor_click_at(x,y)（闭环定位，坐标须与 OS 虚拟屏幕物理坐标一致；缩放截图须先换算）。',
      '普通注入返回成功仅表示通道写入；须用屏幕反馈确认实际生效。定位超时后先观察，已写入帧可能迟到，避免立即重试。',
      '',
      '【注入节奏】本机观察到静止后反馈变慢、部分帧在观察窗内未见效果；射频休眠是待验证假设，不能据此判定固件丢帧。',
      '操作前先确认光标反馈；小位移不能保证唤醒，操作失败先等 10-20s 观察是否迟到生效再重试，不要立即重发位移（会叠加）。',
      '注入为硬件级（与物理操作无异，会真实作用于用户屏幕）——仅在用户明确要求的动作里调用。',
      '',
      '【事件流】所有设备事件进环形缓冲：umouse_get_events(非阻塞)/umouse_wait_events(长轮询)，以返回的 nextSince 作下次 since 续读。',
      'keyEvent payload：{key: speech|translation|m|ai|capture|raw, action: down|up|hold|click, index(M 键序号)}。',
      ].join('\n'),
    }
  );
  registerTools(server, bridge);

  // v2 能力门控工具组：随设备接入/拔出与能力声明变化增删 + list_changed 通知。
  const visibility = registerGatedTools(server, bridge);
  const resync = () => { try { visibility.sync(); } catch { /* 工具列表同步失败不阻断事件流 */ } };
  const capListener = () => resync();
  const unsubscribe = bridge.capabilities.onChange(capListener);

  // 事件 → MCP 通知（尽力而为；异步发送失败静默）
  const forwardEvent = (evt: UmEvent) => {
    if (evt.type === 'connected' || evt.type === 'disconnected') resync();
    if (!NOTIFY_TYPES.has(evt.type)) return;
    void Promise.resolve(
      server.server.sendLoggingMessage({ level: 'info', logger: 'umouse', data: evt })
    ).catch(() => {});
  };
  bridge.onEvent(forwardEvent);
  server.server.onclose = () => {
    bridge.off('event', forwardEvent);
    unsubscribe();
  };

  return server;
}
