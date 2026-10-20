/*
 * tools.ts —— MCP 工具注册（表驱动，schema 与 description 即 agent 的使用手册）
 *
 * 返回约定：content[0].text 为 JSON 字符串；ok:false 时置 isError，agent 可自纠。
 * 所有 device_id 参数遵循 SDK 语义：单台在线可省略，多台必填（错误信息附在线列表）。
 *
 * v2两层门控：
 *  - 展示层：registerGatedTools + ToolVisibilityController——注入/raw 工具仅在
 *    在线设备能力声明为 supported 且软件就绪时向模型公开，随接入/拔出/能力
 *    变化动态增删（notifications/tools/list_changed）；
 *  - 执行层：gateGuard（可读错误）+ sdk-bridge 注入帧写入共享校验（硬闸）。
 *    客户端缓存旧工具列表时，执行层仍拒绝不再支持的调用。
 */
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SdkBridge } from './sdk-bridge.js';
import { computeVisibility, MOUSE_INJECTION_TOOLS, KEYBOARD_INJECTION_TOOLS, RAW_DIAGNOSTIC_TOOLS, type ToolCapability, type ToolSpec } from './tool-capabilities.js';

const EVENT_TYPES = [
  'connected', 'disconnected', 'keyEvent', 'deviceInfo', 'dpiChanged',
  'meetingCreated', 'meetingDestroyed（origin=device-frame 设备确认 / transport-down 异常结束）', 'meetingBusy', 'meetingCreateFailed',
  'audioSegmentComplete（本段音频已全部交付：segment 采集代次 + reason）',
  'queueOverflow', 'warning', 'lavalierMicStatus', 'lavalierMicBattery',
  'speechCaptured（server 生成：语音键自动录音完成，payload 含 WAV 路径）',
  'speechTranscribed（转写状态已落盘，payload 含 eventId/status；全文用 umouse_voice_inbox）',
  'sleepReset（120 秒重置睡眠计时，写入与 ACK 独立记录）',
  'voiceSession / voiceBusy / voiceUnavailable / voiceCloseUnconfirmed / voiceKeyHoldIsolation（v2 语音编排会话事件）',
];

/** rawFrame 透传事件按配置追加（联调期观察注入回执帧用） */
function eventTypes(bridge: SdkBridge): string[] {
  const raw = bridge.rawFrameEventsEnabled;
  return raw ? [...EVENT_TYPES, 'rawFrame（原始帧 hex，需 UMSDK_RAWFRAME_EVENTS=1）'] : EVENT_TYPES;
}

const DEVICE_ID_DOC =
  '目标设备 SN。单台在线可省略；多台在线必须显式指定（缺省时命令会被 SDK 拒绝）。' +
  '识别超时的临时身份（usb-xxxx / ble-<mac>）仅本次连接会话内稳定，不要持久化。';

const DPI_DOC =
  'DPI 档位的固件字节（协议 03 22 <level>，非索引非 DPI 数值）。主流固件映射：' +
  '800→21, 1200→32, 1600→42, 2400→63, 4000→4, 6000→5；其它固件族编码不同。' +
  '注意：固件对软件设置不回执——返回 1 仅代表字节已写入通道，生效与否以 dpiChanged 事件/光标速度旁证判断。';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(error: string, extra?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error, ...extra }) }], isError: true };
}

function onlineHint(bridge: SdkBridge): { devices: unknown[] } {
  return { devices: bridge.listDevices() };
}

/** SDK 命令返回值 1/0 → 结构化结果（0 时附在线设备帮助 agent 自纠） */
function cmdResult(label: string, ret: number, bridge: SdkBridge, extra?: Record<string, unknown>): ToolResult {
  if (ret === 1) return ok({ ok: true, ...extra });
  return fail(`${label} 未下发（未连接/参数非法/被拦截）`, { ...onlineHint(bridge), ...extra });
}

/** v2 执行层门控前置检查：返回 null=放行；否则返回 fail 结果（含错误码与在线列表） */
function gateGuard(bridge: SdkBridge, capability: 'mouse_control' | 'keyboard_control', deviceId?: string): ToolResult | null {
  const online = bridge.safeDeviceList();
  if (!deviceId && online.length !== 1) {
    return fail(online.length === 0 ? '没有在线设备' : '多台在线必须指定 device_id', onlineHint(bridge));
  }
  const target = deviceId ?? online[0].id;
  const decision = bridge.gate.check(target, capability);
  if (!decision.allowed) {
    return fail(decision.message, { code: decision.code, capability, deviceId: target, ...onlineHint(bridge) });
  }
  return null;
}

export function registerTools(server: McpServer, bridge: SdkBridge): void {
  // ---------- 查询 ----------

  server.tool(
    'umouse_status',
    '查看 uMouse SDK 服务状态：SDK 版本、运行时长、配置摘要、在线设备数、事件缓冲水位、录音状态、旧进程接管记录。排查问题先调它。',
    {},
    async () => ok(bridge.status())
  );

  server.tool(
    'umouse_list_devices',
    '枚举当前在线的声云智能鼠标：[{id(SN), connMode(USB/BLE), battery(%), status(normal/meeting), lastSeen}]。',
    {},
    async () => ok({ devices: bridge.listDevices() })
  );

  server.tool(
    'umouse_get_events',
    `非阻塞拉取自上次游标以来的设备事件。返回 {events:[{seq,ts,deviceId,type,payload}], nextSince, buffer}。` +
      `务必把返回的 nextSince 作为下次调用的 since 续读（seq 严格递增，不重放）。可用 type：${eventTypes(bridge).join(' | ')}。` +
      `keyEvent payload={key: speech|translation|m|ai|capture|raw, action: down|up|hold|click, index(M 键序号)}；` +
      `speechCaptured payload={path(WAV), durationMs, bytes, autoStopped}。`,
    {
      since: z.number().int().min(0).default(0).describe('上次返回的 nextSince；首次传 0'),
      types: z.array(z.string()).optional().describe('按 type 过滤（如 ["keyEvent"]）'),
      limit: z.number().int().min(1).max(500).default(100).describe('本次最多返回条数'),
    },
    async ({ since, types, limit }) => {
      const events = bridge.events.since(since, types, limit);
      return ok({ events, nextSince: events.at(-1)?.seq ?? bridge.events.latestSeq, buffer: bridge.events.stats() });
    }
  );

  server.tool(
    'umouse_wait_events',
    `长轮询等待新设备事件：有匹配立即返回，超时返回空（timedOut:true）。等待用户物理操作的标准工具。` +
      `推荐范式：等用户语音输入 → types:["speechCaptured"]（用户按住语音键说话、松开后事件自带 WAV 路径 payload.path，直接取用，无需编排录音）；` +
      `等按键 → types:["keyEvent"]（payload={key: speech|translation|m|ai|capture|raw, action: down|up|hold|click, index}）。` +
      `可用 type：${eventTypes(bridge).join(' | ')}。` +
      `宿主超时提示：宿主对工具调用本身可能设有更短超时——单次 timeout_ms 建议不超过 25000，更久等待以返回的 nextSince 游标分轮续等。`,
    {
      since: z.number().int().min(0).default(0).describe('上次返回的 nextSince'),
      timeout_ms: z.number().int().min(100).max(30000).default(10000).describe('最长等待毫秒数（上限 30000）'),
      types: z.array(z.string()).optional().describe('按 type 过滤'),
    },
    async ({ since, timeout_ms, types }) => {
      const events = await bridge.events.wait(since, types, timeout_ms);
      return ok({
        events,
        nextSince: events.at(-1)?.seq ?? bridge.events.latestSeq,
        timedOut: events.length === 0,
        buffer: bridge.events.stats(),
      });
    }
  );

  // ---------- 持久化语音收件箱 ----------
  server.tool(
    'umouse_voice_inbox',
    '读取物理语音键产生的持久化转写消息。默认只读未确认消息，读取不删除。status=ready 的 text 是用户语音转写，可能有识别错误；' +
      'queued/transcribing 请等待，empty 不创建对话，failed 查看 errorCode。处理或向明确宿主成功交付后用 umouse_ack_voice。日志通知不保证唤醒新回合。',
    { include_acknowledged: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(100) },
    async ({ include_acknowledged, limit }) => ok({ messages: bridge.voice.list(include_acknowledged, limit), status: bridge.voice.status() })
  );
  server.tool(
    'umouse_wait_voice',
    '在当前活动对话内等待语音键转写完成，返回未确认的 ready/empty/failed 消息（最多 25 秒）。' +
      '已存在未确认结果会立即返回；处理后 ack 才不会重复读取。不能保证客户端在当前回合结束后自动唤醒。',
    { timeout_ms: z.number().int().min(100).max(25000).default(25000) },
    async ({ timeout_ms }) => {
      const messages = await bridge.voice.wait(timeout_ms);
      return ok({ messages, timedOut: messages.length === 0, status: bridge.voice.status() });
    }
  );
  server.tool(
    'umouse_ack_voice',
    '按 event_id 确认语音消息已经处理或已被目标宿主接受。幂等；未完成转写的消息不可确认。仅改变收件箱状态，不执行语音内容。',
    { event_id: z.string().uuid() },
    async ({ event_id }) => bridge.voice.acknowledge(event_id)
      ? ok({ ok: true, eventId: event_id }) : fail('消息不存在、尚未完成，或持久化不可用')
  );

  // ---------- 控制 ----------

  server.tool(
    'umouse_set_dpi',
    DPI_DOC,
    {
      level: z.number().int().min(0).max(255).describe('固件档位字节（见工具描述中的映射表）'),
      device_id: z.string().optional().describe(DEVICE_ID_DOC),
    },
    async ({ level, device_id }) => cmdResult('set_dpi', bridge.setDpi(level, device_id), bridge)
  );

  const meetingOp = (name: string, op: 'create' | 'destroy' | 'pause' | 'resume', desc: string) =>
    server.tool(
      name,
      `${desc}。会议全局独占：另一台设备会议中时本指令被拦截（返回 meetingBusy 事件的 owner）。` +
        '结果异步经 meetingCreated/meetingDestroyed 事件上报。',
      { device_id: z.string().optional().describe(DEVICE_ID_DOC) },
      async ({ device_id }) => cmdResult(name, bridge.meeting(op, device_id), bridge)
    );
  meetingOp('umouse_meeting_create', 'create', '开启会议模式（设备进入会议态，音频持续流入）');
  meetingOp('umouse_meeting_destroy', 'destroy', '结束会议模式（归属解除，其它设备方可开会）');
  meetingOp('umouse_meeting_pause', 'pause', '暂停会议（暂停期间豁免 SDK 断流裁决）');
  meetingOp('umouse_meeting_resume', 'resume', '恢复被暂停的会议');

  server.tool(
    'umouse_set_channel_pref',
    '设置通道偏好（运行时可切，切换瞬间断开当前通道重新探测）：AUTO=USB 优先静默转 BLE（默认）；' +
      'USB=仅 2.4G 接收器；BLE=仅蓝牙（接收器在位但鼠标切到蓝牙、USB 假在线时用它）。',
    {
      pref: z.enum(['AUTO', 'USB', 'BLE']),
      device_id: z.string().optional().describe('省略 = 作用于全部已连接设备'),
    },
    async ({ pref, device_id }) => cmdResult('set_channel_pref', bridge.setChannelPref(pref, device_id), bridge)
  );

  server.tool(
    'umouse_set_audio_source',
    '指定语音音频源设备（多台在线时语音识别会话应锁定单源）：设置后仅该设备音频被采集录音，' +
      '其它设备在 SDK 层静音。不传 device_id = 恢复默认先到先得策略。语音会话进行中被仲裁拒绝。',
    { device_id: z.string().optional().describe('目标设备 SN；省略/空 = 恢复默认策略') },
    async ({ device_id }) => {
      const r = bridge.setAudioSource(device_id);
      if (r.ok === 1) return ok({ ok: true, audioSource: r.source });
      return fail('set_audio_source 失败', onlineHint(bridge));
    }
  );

  // umouse_write_raw 已移至能力门控工具组（registerGatedTools）：普通会话不开放
  // 任意 raw 写入，诊断模式（UMSDK_RAW_DIAG=1）下已知帧仍过能力校验（G06）。

  // v2：注入工具族已移至 registerGatedTools（能力门控：mouse_control/keyboard_control
  // 声明为 supported 且软件就绪才公开展示；执行层另有 gateGuard + 帧写入共享校验硬闸）。
  // ---------- 音频 ----------

  server.tool(
    'umouse_audio_record',
    '设备录音（16kHz/16bit/mono，WAV 落盘返回路径，不进对话流）。' +
      '【推荐】语音键自动采集默认开启：让用户按住语音键说话、松开即可，等 speechCaptured 事件（umouse_wait_events，' +
      'payload 含 WAV 路径），无需本工具编排。本工具用于手动场景：action=start 开始（用于会议等持续音频），' +
      'action=stop 收尾（若会话已被语音键松开/超时自动收尾，返回 file=最近完成的录音而非错误），action=status 查看进行中会话。',
    {
      action: z.enum(['start', 'stop', 'status']),
      device_id: z.string().optional().describe(`录音绑定的设备 SN（多台在线必填）。${DEVICE_ID_DOC}`),
      max_seconds: z.number().int().min(1).max(600).optional().describe('本次录音上限秒数（默认取服务配置）'),
    },
    async ({ action, device_id, max_seconds }) => {
      try {
        return ok({ ok: true, action, result: bridge.audioRecord(action, device_id, max_seconds) });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e), onlineHint(bridge));
      }
    }
  );

  // ---------- 会话重配 ----------

  server.tool(
    'umouse_reconfigure',
    '修改须在 SDK 启动前锁定的配置并受控重启会话（工作模式/USB/BLE 识别标识/设备上限/语音键自动录音）。' +
      '注意：重启会断开所有在线设备（事件缓冲保留，设备重连后自动恢复）。一般保持环境变量配置不变，仅在接入非默认设备时使用。',
    {
      work_mode: z.literal('FULL').optional().describe('工作模式，v1 仅 FULL'),
      device_limit: z.number().int().min(1).max(8).optional().describe('同型号设备上限（默认 4）'),
      usb: z
        .object({
          vid: z.number().int().min(1).max(65535).describe('厂商 ID（0x 十进制或十六进制均可）'),
          pid: z.number().int().min(1).max(65535).describe('产品 ID'),
          iface: z.number().int().min(-1).max(2147483647).describe('数据接口号（无 0=默认语义，新设备务必显式填，-1 不限）'),
          report_id: z.number().int().min(0).max(255).default(0).describe('HID report ID（0=生产默认 0x0A）'),
        })
        .nullable()
        .optional()
        .describe('覆盖 2.4G 接收器识别标识；null = 恢复生产默认'),
      ble: z
        .object({
          name: z.string().optional(),
          mac_prefix: z.string().optional(),
          service: z.string().optional(),
          characteristic: z.string().optional(),
        })
        .nullable()
        .optional()
        .describe('覆盖蓝牙识别标识；null = 恢复生产默认'),
      debug: z.number().int().min(0).max(2).optional().describe('SDK 内部日志级别'),
      speech_auto_record: z.boolean().optional().describe('语音键自动录音开关（默认开启；关闭后改用 umouse_audio_record 手动模式）'),
    },
    async (req) => {
      try {
        const r = await bridge.reconfigure({
          workMode: req.work_mode,
          deviceLimit: req.device_limit,
          usb: req.usb == null ? req.usb : {
            vid: req.usb.vid,
            pid: req.usb.pid,
            iface: req.usb.iface,
            reportId: req.usb.report_id,
          },
          ble: req.ble == null ? req.ble : {
            name: req.ble.name,
            macPrefix: req.ble.mac_prefix,
            service: req.ble.service,
            characteristic: req.ble.characteristic,
          },
          debug: req.debug,
          speechAutoRecord: req.speech_auto_record,
        });
        if (!r.ok) return fail(`重启失败：${r.error}`, bridge.status());
        return ok({ ok: true, note: '会话已受控重启：所有设备已断开，等待重连（事件缓冲已保留）', status: bridge.status() });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ---------- v2 能力查询与 Agent 语音会话 ----------

  server.tool(
    'umouse_get_capabilities',
    '查询设备能力（voice / mouse_control / keyboard_control）与当前可执行状态：每台设备返回能力声明的 support、来源' +
      '（当前 product-default/test-profile；hardware-info 仅预留，尚无硬件上报接线）、连接代次与在线状态，以及因此被隐藏的工具和原因。' +
      '能力未声明（unknown）的操作会被执行层拒绝——注入工具只对声明 supported 的设备开放（可用 UMSDK_TEST_CAPS 声明测试能力）。',
    { device_id: z.string().optional().describe(`目标设备 SN；省略 = 全部已知设备。${DEVICE_ID_DOC}`) },
    async ({ device_id }) => {
      const known = bridge.devices.list(bridge.safeDeviceList());
      const targets = device_id ? known.filter((d) => d.id === device_id) : known;
      const onlineIds = new Set(bridge.safeDeviceList().map((d) => d.id));
      const devices = targets.map((d) => bridge.gate.describe(d.id, { online: onlineIds.has(d.id), generation: d.generation }));
      const visibility = computeVisibility(ALL_TOOL_SPECS, {
        online: bridge.safeDeviceList(),
        supportOf: (id, cap) => bridge.capabilities.supportOf(id, cap)?.support,
        software: {
          injectionEnabled: bridge.injectionEnabled,
          keyboardInjectionEnabled: bridge.keyboardInjectionEnabled,
          rawDiagEnabled: bridge.rawDiagEnabled,
        },
      });
      return ok({
        ok: true,
        devices,
        knownCapabilities: bridge.capabilities.knownCapabilities(),
        toolVisibility: { visible: [...visibility.visible].sort(), hidden: visibility.hidden },
        hint: 'mouse_control/keyboard_control 未声明时为 unknown：注入类工具隐藏且执行被拒；voice 为产品默认 supported。',
      });
    }
  );

  server.tool(
    'umouse_voice_start',
    '开启一次 Agent 语音问答会话：经设备麦克风采集（会议模式），就绪（会议确认+首段 PCM 到达）后返回 listening/sessionId。' +
      '随后用 umouse_voice_wait 等待最终文字（VAD 静音/完成按钮/上限结束）。同一时间仅一个会话；重复 client_request_id 幂等返回。' +
      '本工具只采集语音，最终文字作为工具结果返回——不向任何输入框打字。',
    {
      prompt: z.string().max(2000).optional().describe('给用户的提示语（记录与会话关联，不强制展示）'),
      device_id: z.string().optional().describe(DEVICE_ID_DOC),
      end_mode: z.enum(['vad_or_manual', 'manual_only']).default('vad_or_manual').describe('结束方式（vad_or_manual=VAD 静音或手动；manual_only=仅手动/上限）'),
      client_request_id: z.string().max(128).optional().describe('调用方请求幂等键：重复传入返回同一会话'),
    },
    async (req) => {
      if (!bridge.voiceCoord) return fail('v2 语音编排未启用（UMSDK_VOICE=0）');
      try {
        const r = await bridge.voiceCoord!.voiceStart({
          prompt: req.prompt, deviceId: req.device_id, endMode: req.end_mode, clientRequestId: req.client_request_id,
        });
        return r.ok ? ok(r) : fail(r.error, { code: r.code, detail: r.detail });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e), onlineHint(bridge));
      }
    }
  );

  server.tool(
    'umouse_voice_wait',
    '等待语音会话结果（有界等待，单次 ≤25s；更久以分轮续等）。pending 与终态明确区分；终态返回最终文字 text、' +
      '结束原因 stopReason、会议关麦确认与音频段边界事实。仅返回 agent-reply 会话的文字。',
    {
      session_id: z.string().uuid().describe('umouse_voice_start 返回的会话 ID'),
      wait_ms: z.number().int().min(100).max(25000).default(25000).describe('本次等待毫秒数'),
    },
    async ({ session_id, wait_ms }) => {
      if (!bridge.voiceCoord) return fail('v2 语音编排未启用（UMSDK_VOICE=0）');
      const r = await bridge.voiceCoord!.voiceWait(session_id, wait_ms);
      return r.ok === false ? fail(String(r.error), { sessionId: session_id }) : ok(r);
    }
  );

  server.tool(
    'umouse_voice_finish',
    '结束指定语音会话（对话内完成按钮/VAD 之外的手动入口；幂等：重复调用返回已有状态）。' +
      '收尾顺序：会议销毁→等待设备确认与音频段完成→识别终态→结果可取。',
    { session_id: z.string().uuid().describe('目标会话 ID') },
    async ({ session_id }) => {
      if (!bridge.voiceCoord) return fail('v2 语音编排未启用（UMSDK_VOICE=0）');
      const r = await bridge.voiceCoord!.voiceFinish(session_id);
      return r.ok === false ? fail(String(r.error), { sessionId: session_id }) : ok(r);
    }
  );

  server.tool(
    'umouse_voice_cancel',
    '取消指定语音会话：立即禁止结果投递并启动设备清理；不把"取消等待"冒充"设备已关麦"。已输入的字符不撤回。',
    { session_id: z.string().uuid().describe('目标会话 ID') },
    async ({ session_id }) => {
      if (!bridge.voiceCoord) return fail('v2 语音编排未启用（UMSDK_VOICE=0）');
      const r = await bridge.voiceCoord!.voiceCancel(session_id);
      return r.ok === false ? fail(String(r.error), { sessionId: session_id }) : ok(r);
    }
  );

  server.tool(
    'umouse_voice_status',
    '语音编排状态：ASR/typer 就绪、活动会话（状态机位置、目的、设备）、未确认关麦的隔离记录与最近会话摘要。' +
      '可选 session_id 返回单会话详情（含分段耗时）。默认不回传听写正文。',
    { session_id: z.string().uuid().optional().describe('省略 = 全局状态') },
    async ({ session_id }) => {
      if (!bridge.voiceCoord) {
        return ok({ ok: true, enabled: false, note: 'UMSDK_VOICE=0：物理语音键走旧自动录音→持久 inbox 链路（umouse_voice_inbox）' });
      }
      return ok(bridge.voiceCoord!.status(session_id));
    }
  );
}


// ============================ 能力门控工具组（v2 展示层） ============================

const INJECT_NOTE =
  '返回 ok/sent 仅表示写入通道，不代表固件已执行；本服务未对固件 ACK 做成功确认。' +
  '硬件级注入：动作经设备标准 HID 接口发出，对操作系统与物理操作无异（会真实移动光标/点击界面），' +
  '仅在用户明确要求的动作里调用。位移单位≠像素：约 1 单位≈1px（100% 缩放显示器），随显示器缩放/Windows 指针速度与加速变化' +
  '（实测约 0.7~1.5px/单位），需要精确定位时小步移动并观察结果。' +
  '延迟提示：本机静止后部分注入秒级迟到或在观察窗内未生效，具体设备/USB 环节未定；操作前确认光标反馈，' +
  '失败后先等 10-20s 观察是否迟到生效再重试，不要立即重发位移（会叠加）。';

/** 全量工具规格（静态 + 门控）：能力查询呈现完整可见性用 */
const ALL_TOOL_SPECS: ToolSpec[] = [
  { name: 'umouse_status' }, { name: 'umouse_list_devices' }, { name: 'umouse_get_events' }, { name: 'umouse_wait_events' },
  { name: 'umouse_voice_inbox' }, { name: 'umouse_wait_voice' }, { name: 'umouse_ack_voice' },
  { name: 'umouse_get_capabilities' }, { name: 'umouse_voice_start' }, { name: 'umouse_voice_wait' },
  { name: 'umouse_voice_finish' }, { name: 'umouse_voice_cancel' }, { name: 'umouse_voice_status' },
  { name: 'umouse_set_dpi' }, { name: 'umouse_meeting_create' }, { name: 'umouse_meeting_destroy' },
  { name: 'umouse_meeting_pause' }, { name: 'umouse_meeting_resume' }, { name: 'umouse_set_channel_pref' },
  { name: 'umouse_set_audio_source' }, { name: 'umouse_audio_record' }, { name: 'umouse_reconfigure' },
  ...MOUSE_INJECTION_TOOLS.map((name) => ({ name, capability: 'mouse_control' as ToolCapability })),
  ...KEYBOARD_INJECTION_TOOLS.map((name) => ({ name, capability: 'keyboard_control' as ToolCapability })),
  ...RAW_DIAGNOSTIC_TOOLS.map((name) => ({ name, capability: 'raw-diagnostic' as ToolCapability })),
];

interface GatedSpec extends ToolSpec {
  register(server: McpServer, bridge: SdkBridge): RegisteredTool;
}

const GATED_SPECS: GatedSpec[] = [
  {
    name: 'umouse_cursor_move', capability: 'mouse_control',
    register: (server, bridge) => server.tool(
      'umouse_cursor_move',
      `相对移动光标：dx/dy 为相对位移（正=右/下，像素≈1 单位）。大位移自动拆帧连发（单帧 int8 上限 ±127）。` +
        `拖拽使用单次 umouse_cursor_drag，避免分轮调用被空闲复位打断。${INJECT_NOTE}`,
      {
        dx: z.number().int().min(-100000).max(100000).describe('X 轴相对位移（正=右）'),
        dy: z.number().int().min(-100000).max(100000).describe('Y 轴相对位移（正=下）'),
        device_id: z.string().optional().describe(DEVICE_ID_DOC),
      },
      async ({ dx, dy, device_id }) => {
        const gate = gateGuard(bridge, 'mouse_control', device_id);
        if (gate) return gate;
        try {
          const r = await bridge.inject.move(dx, dy, device_id);
          return r.failed > 0
            ? fail('位移批次中止：连续写入失败（位移帧不重发，防止叠加）', { ...r, ...onlineHint(bridge) })
            : ok({ ok: true, ...r });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e), onlineHint(bridge));
        }
      }
    ),
  },
  {
    name: 'umouse_cursor_click', capability: 'mouse_control',
    register: (server, bridge) => server.tool(
      'umouse_cursor_click',
      `点击鼠标按键：按下→抬起。count 为连击次数（双击传 2，上限 5）。拖拽使用单次 umouse_cursor_drag。${INJECT_NOTE}`,
      {
        button: z.enum(['left', 'right', 'middle']).describe('左/右/中键'),
        count: z.number().int().min(1).max(5).default(1).describe('连击次数（双击=2）'),
        device_id: z.string().optional().describe(DEVICE_ID_DOC),
      },
      async ({ button, count, device_id }) => {
        const gate = gateGuard(bridge, 'mouse_control', device_id);
        if (gate) return gate;
        try {
          const r = await bridge.inject.click(button, count, device_id);
          return r.failed > 0 ? fail('点击序列存在未确认帧', { ...r, ...onlineHint(bridge) }) : ok({ ok: true, ...r });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e), onlineHint(bridge));
        }
      }
    ),
  },
  {
    name: 'umouse_cursor_scroll', capability: 'mouse_control',
    register: (server, bridge) => server.tool(
      'umouse_cursor_scroll',
      `滚动滚轮：amount 为格数（正=向上，负=向下），|amount|>127 自动拆帧。${INJECT_NOTE}`,
      {
        amount: z.number().int().min(-10000).max(10000).describe('滚轮格数（正=向上）'),
        device_id: z.string().optional().describe(DEVICE_ID_DOC),
      },
      async ({ amount, device_id }) => {
        const gate = gateGuard(bridge, 'mouse_control', device_id);
        if (gate) return gate;
        try {
          const r = await bridge.inject.scroll(amount, device_id);
          return r.failed > 0 ? fail('滚轮批次中止：连续写入失败', { ...r, ...onlineHint(bridge) }) : ok({ ok: true, ...r });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e), onlineHint(bridge));
        }
      }
    ),
  },
  {
    name: 'umouse_button', capability: 'mouse_control',
    register: (server, bridge) => server.tool(
      'umouse_button',
      `按住/松开鼠标按键（拖拽与长按的原语）：action=press 按住 → umouse_cursor_move 移动 → action=release 松开。` +
        `状态型协议：press 后务必 release（服务端空闲 3s 也会自动发复位帧兜底）。` +
        `注意：press/move/release 分多轮调用的间隔若超过 3s 会被空闲复位打断——拖拽请改用单次调用的 umouse_cursor_drag。${INJECT_NOTE}`,
      {
        action: z.enum(['press', 'release']),
        button: z.enum(['left', 'right', 'middle']),
        device_id: z.string().optional().describe(DEVICE_ID_DOC),
      },
      async ({ action, button, device_id }) => {
        const gate = gateGuard(bridge, 'mouse_control', device_id);
        if (gate) return gate;
        try {
          const r = await bridge.inject.button(action, button, device_id);
          return r.failed > 0 ? fail('按键状态帧未写入', { ...r, ...onlineHint(bridge) }) : ok({ ok: true, ...r });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e), onlineHint(bridge));
        }
      }
    ),
  },
  {
    name: 'umouse_cursor_drag', capability: 'mouse_control',
    register: (server, bridge) => server.tool(
      'umouse_cursor_drag',
      `原子拖拽：单次调用内完成 按住\`button\`（默认左键）→ 移动 dx/dy → 松开。不受 agent 分轮延迟影响` +
        `（分轮 press/move/release 超过 3s 会被空闲复位打断）。${INJECT_NOTE}`,
      {
        dx: z.number().int().min(-100000).max(100000).describe('X 轴相对位移（正=右）'),
        dy: z.number().int().min(-100000).max(100000).describe('Y 轴相对位移（正=下）'),
        button: z.enum(['left', 'right', 'middle']).default('left').describe('拖拽按住的按键'),
        device_id: z.string().optional().describe(DEVICE_ID_DOC),
      },
      async ({ dx, dy, button, device_id }) => {
        const gate = gateGuard(bridge, 'mouse_control', device_id);
        if (gate) return gate;
        try {
          const r = await bridge.inject.drag(button, dx, dy, device_id);
          return r.failed > 0 ? fail('拖拽序列存在未确认帧', { ...r, ...onlineHint(bridge) }) : ok({ ok: true, ...r });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e), onlineHint(bridge));
        }
      }
    ),
  },
  {
    name: 'umouse_key_tap', capability: 'keyboard_control',
    register: (server, bridge) => server.tool(
      'umouse_key_tap',
      `键盘组合键点按（固件反向控制 0xF1，标准 HID 报文）：mods 为修饰键，keys 为 HID Usage ID 数组（≤6 个）。` +
        `常用 Usage ID（hex）：0x04~0x1D=a~z（字母序号 = ASCII-93）、0x1E~0x27=1~0、0x28=Enter、0x29=Esc、0x2A=Backspace、` +
        `0x2C=Space、0x4F~0x52=方向键 右/左/下/上；符号键与完整表见 HID Usage Tables Keyboard/Keypad Page。` +
        `自动按下→抬起。打长文本不建议逐键调用（中文/文本输入请走语音识别链路）。${INJECT_NOTE}`,
      {
        mods: z.array(z.union([z.string(), z.number().int()])).default([]).describe('修饰键：ctrl/shift/alt/gui（win/cmd）'),
        keys: z.array(z.number().int().min(0).max(255)).max(6).describe('HID Usage ID 数组（如 [4]=a）'),
        device_id: z.string().optional().describe(DEVICE_ID_DOC),
      },
      async ({ mods, keys, device_id }) => {
        if (!bridge.keyboardInjectionEnabled) return fail('键盘注入未启用（UMSDK_INJECT_KEYBOARD=1）');
        const gate = gateGuard(bridge, 'keyboard_control', device_id);
        if (gate) return gate;
        try {
          const r = await bridge.inject.keyTap(mods, keys, device_id);
          return r.failed > 0 ? fail('键序列存在未确认帧', { ...r, ...onlineHint(bridge) }) : ok({ ok: true, ...r });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e), onlineHint(bridge));
        }
      }
    ),
  },
  {
    name: 'umouse_cursor_move_to', capability: 'mouse_control',
    register: (server, bridge) => server.tool(
      'umouse_cursor_move_to',
      `闭环绝对定位：把光标移动到虚拟屏幕坐标 (x,y)（即截图像素坐标，主屏左上角为 0,0）。` +
        `内部单帧发送后等待光标位置变化再修正（每帧反馈默认最多等 5s（UMSDK_INJECT_FEEDBACK_MS 可调），总定位最多 20s、15 帧），降低设备延迟导致的误判和过冲。` +
        `返回 {ok, iterations, final:{x,y}, residual:{dx,dy}}；无反馈即停止，不重发；超时帧仍可能迟到——先等 10-20s 观察再决定重试。测试期间不要手动移动鼠标。${INJECT_NOTE}`,
      {
        x: z.number().int().describe('目标 X（虚拟屏幕像素，截图坐标）'),
        y: z.number().int().describe('目标 Y（虚拟屏幕像素，截图坐标）'),
        tol_px: z.number().int().min(1).max(20).default(3).describe('收敛容差（像素，默认 3）'),
        device_id: z.string().optional().describe(DEVICE_ID_DOC),
      },
      async ({ x, y, tol_px, device_id }) => {
        const gate = gateGuard(bridge, 'mouse_control', device_id);
        if (gate) return gate;
        try {
          const r = await bridge.inject.moveTo(x, y, { tolPx: tol_px, deviceId: device_id });
          return r.ok ? ok(r) : fail('未收敛到目标', { ...r, ...onlineHint(bridge) });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e), onlineHint(bridge));
        }
      }
    ),
  },
  {
    name: 'umouse_cursor_click_at', capability: 'mouse_control',
    register: (server, bridge) => server.tool(
      'umouse_cursor_click_at',
      `精准点击：闭环定位到 (x,y) 后点击；定位未收敛不点击。序列在服务内串行，但不能阻止外部鼠标输入或设备延迟。` +
        `配合截图坐标直击目标（图标/按钮中心）。count 为连击次数（双击=2）。${INJECT_NOTE}`,
      {
        x: z.number().int().describe('目标 X（虚拟屏幕像素，截图坐标）'),
        y: z.number().int().describe('目标 Y（虚拟屏幕像素，截图坐标）'),
        button: z.enum(['left', 'right', 'middle']).default('left'),
        count: z.number().int().min(1).max(5).default(1).describe('连击次数（双击=2）'),
        tol_px: z.number().int().min(1).max(20).default(3).describe('定位收敛容差（像素，默认 3）'),
        device_id: z.string().optional().describe(DEVICE_ID_DOC),
      },
      async ({ x, y, button, count, tol_px, device_id }) => {
        const gate = gateGuard(bridge, 'mouse_control', device_id);
        if (gate) return gate;
        try {
          const r = await bridge.inject.clickAt(x, y, button, count, { tolPx: tol_px, deviceId: device_id });
          return r.ok
            ? ok(r)
            : fail(r.click ? '点击帧写入失败，请检查按键释放状态' : '未收敛到目标，未执行点击', { ...r, ...onlineHint(bridge) });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e), onlineHint(bridge));
        }
      }
    ),
  },
  {
    name: 'umouse_key_release_all', capability: 'mouse_control',
    // Cleanup intentionally bypasses gateGuard: InjectController sends only a
    // same-generation release for an input held by this process; otherwise zero frames.
    register: (server, bridge) => server.tool(
      'umouse_key_release_all',
      `受限清理：仅释放本进程此前按下的按键/修饰键通道（未持有任何通道时为无帧幂等操作，不会向仅语音设备发零帧）。` +
        `正常无需调用（点按类工具自动释放、空闲 3s 兜底）；异常恢复/中止组合操作时使用。`,
      { device_id: z.string().optional().describe(DEVICE_ID_DOC) },
      async ({ device_id }) => {
        try {
          const r = await bridge.inject.releaseAll(device_id);
          return r.failed > 0 ? fail('复位帧写入失败，按键释放尚未确认', { ...r }) : ok({ ok: true, ...r });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e), onlineHint(bridge));
        }
      }
    ),
  },
  {
    name: 'umouse_write_raw', capability: 'raw-diagnostic',
    register: (server, bridge) => server.tool(
      'umouse_write_raw',
      '【诊断模式专用】向设备活动通道写原始字节（字节直接进固件）。仅 UMSDK_RAW_DIAG=1 时可见与可用；' +
        '已知命令帧（03 F0 鼠标 / 03 F1 键盘）仍须目标设备声明对应能力，未知命令拒绝——raw 不是绕过能力门控的入口。' +
        'hex 为偶数长度的十六进制字符串，单次上限 1024 字节。',
      {
        hex: z.string().regex(/^[0-9a-fA-F]+$/, 'hex 必须为非空偶数长度十六进制串').describe('如 "0a03f0.."'),
        device_id: z.string().optional().describe(DEVICE_ID_DOC),
      },
      async ({ hex, device_id }) => {
        if (hex.length % 2 !== 0) return fail('hex 长度必须为偶数');
        try {
          const r = bridge.writeRaw(hex, device_id);
          if (r.ok === 1) return ok({ ok: true, bytes: r.bytes });
          return fail('write_raw 未写入（未连接）', onlineHint(bridge));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      }
    ),
  },
];

/**
 * 工具可见性控制器：按在线设备能力/软件开关增删门控工具，并广播
 * notifications/tools/list_changed。客户端缓存旧列表时，执行层仍拒绝。
 */
export class ToolVisibilityController {
  private registered = new Map<string, RegisteredTool>();

  constructor(private readonly server: McpServer, private readonly bridge: SdkBridge) {}

  private inputs() {
    return {
      online: this.bridge.safeDeviceList(),
      supportOf: (id: string, cap: string) => this.bridge.capabilities.supportOf(id, cap)?.support,
      software: {
        injectionEnabled: this.bridge.injectionEnabled,
        keyboardInjectionEnabled: this.bridge.keyboardInjectionEnabled,
        rawDiagEnabled: this.bridge.rawDiagEnabled,
      },
    };
  }

  /** 重算并应用；返回是否有变化（变化已广播 list_changed） */
  sync(): boolean {
    const { visible } = computeVisibility(GATED_SPECS, this.inputs());
    let changed = false;
    for (const [name, tool] of this.registered) {
      if (!visible.has(name)) {
        tool.remove();
        this.registered.delete(name);
        changed = true;
      }
    }
    for (const spec of GATED_SPECS) {
      if (visible.has(spec.name) && !this.registered.has(spec.name)) {
        try {
          this.registered.set(spec.name, spec.register(this.server, this.bridge));
          changed = true;
        } catch {
          // 注册失败（重名等）：保持未注册，下一轮 sync 重试
        }
      }
    }
    if (changed) {
      void Promise.resolve(this.server.sendToolListChanged()).catch(() => {});
    }
    return changed;
  }

  get hidden(): Record<string, string> {
    return computeVisibility(GATED_SPECS, this.inputs()).hidden;
  }
}

/** 注册能力门控工具组并返回可见性控制器（server.ts 负责在设备/能力变化时 sync） */
export function registerGatedTools(server: McpServer, bridge: SdkBridge): ToolVisibilityController {
  const controller = new ToolVisibilityController(server, bridge);
  controller.sync();
  return controller;
}
