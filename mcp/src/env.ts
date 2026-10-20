/*
 * env.ts —— MCP server 运行配置（环境变量，前缀 UMSDK_）
 *
 * 约定：
 *  - libPath 默认相对 mcp/dist 解析到仓库根的 lib/（Windows v0.4.20 包已就位）
 *  - workMode 仅支持 FULL（RAW 需要握手三件套，v1 不开放，解析期直接报错）
 *  - USB/BLE 识别标识：任一字段提供即整表覆盖默认规则（单匹配替换语义）
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTranscriber, type TranscriberConfig } from './transcriber.js';
import type { SinicloudCredentials } from './sinicloud-asr.js';

/** 测试能力声明（v2：按设备声明，不写成产品默认） */
export type TestCapabilityProfile = Record<string, Record<string, 'supported' | 'unsupported' | 'unknown'>>;

export interface UmUsbConfig {
  vid: number;
  pid: number;
  iface: number;
  reportId: number;
}

export interface UmBleConfig {
  name?: string;
  macPrefix?: string;
  service?: string;
  characteristic?: string;
}

export interface BridgeConfig {
  libPath: string;
  debug: number;
  crashReport: boolean;
  dataDir: string;
  /** Shared v2 safety evidence survives changing an installation directory. */
  sharedSafetyDir?: string;
  workMode: 'FULL';
  deviceLimit: number;
  usb?: UmUsbConfig;
  ble?: UmBleConfig;
  eventBuffer: number;
  audioMaxSeconds: number;
  audioQuotaMb: number;
  speechAutoRecord: boolean;
  asr: TranscriberConfig | null;
  /** v2 流式识别：Sonicloud 平台凭据（JSON 文件 + 环境变量覆盖，每会话热读可换 key；凭据不入仓库/日志） */
  asrSinicloud?: { load: () => SinicloudCredentials; configPath: string; timeoutMs: number };
  asrProvider: string;
  injection: boolean;
  keyboardInjection: boolean;
  injectFrameMs: number;
  injectClickMs: number;
  injectFeedbackMs: number;
  rawFrameEvents: boolean;
  takeover: boolean;
  sleepResetEnabled: boolean;
  sleepResetIntervalMs: number;
  sleepResetExpectAck: boolean;
  sleepResetAckTimeoutMs: number;
  /** v2 语音编排（物理键听写 + Agent 语音会话）；关闭则保留旧 speechAutoRecord→inbox 链路 */
  voiceEnabled: boolean;
  /** 单次语音采集硬上限（毫秒），默认 60s，上限 120s */
  voiceMaxMs: number;
  /** 测试能力声明：{ "<deviceId>|"*" : { "<capability>": "supported|unsupported|unknown" } } */
  voiceTestCaps: TestCapabilityProfile;
  /** 原始写入诊断模式（umouse_write_raw 展示与执行的开关） */
  rawDiag: boolean;
  /** v2 VAD：none=manual_only；energy=本地能量回退（Silero ONNX 待依赖打包） */
  voiceVad: 'none' | 'energy';
  voiceEndSilenceMs: number;
  voiceFirstSpeechMs: number;
  voicePreview: boolean;
  /** v2 录音浮窗：默认开启（exe 缺失时优雅降级） */
  voiceUi: boolean;
  voiceUiPath?: string;
  /** v2 软件文字输入（typer）：默认开（DLL 缺失优雅降级） */
  voiceTyper: boolean;
  /** v2 连接驱动空闲：N=0 持续该时长后回收 SDK worker（0=立即，旧语义） */
  idleWorkerMs: number;
  /** v2 连接驱动空闲：N=0 持续该时长后 daemon 自退（0=常驻，旧语义） */
  idleExitMs: number;
}

/** 解析数字：支持十进制与 0x 前缀十六进制（VID/PID 惯例） */
function parseNumber(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : undefined;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function configInteger(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const n = raw == null ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max || raw?.trim() === '') {
    throw new Error(`${name} 必须为 ${min}~${max} 的整数`);
  }
  return n;
}

/** 空闲时长：未设置用默认；显式 0 关闭该段（0 或 [min,max] 的整数） */
function configIdleMs(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (trimmed === '0') return 0;
  return configInteger(trimmed, fallback, min, max, name);
}

/** 默认浮窗 exe 路径（构建产物位置；不存在由 VoiceUiController 优雅降级） */
function defaultVoiceUiPath(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const exe = process.platform === 'win32' ? 'umouse-voice-ui.exe' : 'umouse-voice-ui';
  const packaged = path.resolve(here, '..', 'voice-ui', exe);
  if (fs.existsSync(packaged)) return packaged;
  return path.resolve(here, '..', 'voice-ui', 'target', 'release', exe);
}

/** mcp/dist/env.js → 仓库根 lib/uMouseSdk.dll（Windows） */
function defaultLibPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const plat = process.platform as 'win32' | 'linux' | 'darwin';
  const names: Record<string, string> = {
    win32: 'uMouseSdk.dll',
    linux: 'libuMouseSdk.so',
    darwin: 'libuMouseSdk.dylib',
  };
  const sub: Record<string, string> = {
    win32: 'lib',
    linux: 'lib/linux-x64',
    darwin: 'lib/darwin-arm64',
  };
  const name = names[plat] ?? names.win32;
  return path.resolve(here, '..', '..', sub[plat] ?? 'lib', name);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const workMode = (env.UMSDK_WORK_MODE ?? 'FULL').trim().toUpperCase();
  if (workMode !== 'FULL') {
    throw new Error(
      `UMSDK_WORK_MODE=${workMode} 不受支持：v1 仅 FULL（RAW 需握手/SN 探测三件套，后续版本开放）`
    );
  }

  const usbAny =
    env.UMSDK_USB_VID != null || env.UMSDK_USB_PID != null ||
    env.UMSDK_USB_IFACE != null || env.UMSDK_USB_REPORT_ID != null;
  let usb: UmUsbConfig | undefined;
  if (usbAny) {
    const vid = configInteger(env.UMSDK_USB_VID, 0, 1, 65535, 'UMSDK_USB_VID');
    const pid = configInteger(env.UMSDK_USB_PID, 0, 1, 65535, 'UMSDK_USB_PID');
    if (!vid || !pid) {
      throw new Error('UMSDK_USB_VID/UMSDK_USB_PID 必须同时提供且非 0（0=保留默认只在整组覆盖时无意义）');
    }
    usb = {
      vid,
      pid,
      // iface 无"0=默认"语义：未提供时按生产默认 1，接入新设备务必显式设置（见头文件注释）
      iface: configInteger(env.UMSDK_USB_IFACE, 1, -1, 2147483647, 'UMSDK_USB_IFACE'),
      reportId: configInteger(env.UMSDK_USB_REPORT_ID, 0, 0, 255, 'UMSDK_USB_REPORT_ID'),
    };
  }

  const bleAny =
    (env.UMSDK_BLE_NAME ?? '') !== '' || (env.UMSDK_BLE_MAC_PREFIX ?? '') !== '' ||
    (env.UMSDK_BLE_SERVICE ?? '') !== '' || (env.UMSDK_BLE_CHARACTERISTIC ?? '') !== '';
  const ble: UmBleConfig | undefined = bleAny
    ? {
        name: env.UMSDK_BLE_NAME || undefined,
        macPrefix: env.UMSDK_BLE_MAC_PREFIX || undefined,
        service: env.UMSDK_BLE_SERVICE || undefined,
        characteristic: env.UMSDK_BLE_CHARACTERISTIC || undefined,
      }
    : undefined;

  const deviceLimit = Math.min(8, Math.max(1, parseNumber(env.UMSDK_DEVICE_LIMIT) ?? 4));
  const libPathEnv = (env.UMSDK_LIB_PATH ?? '').trim();
  const dataDir = (env.UMSDK_DATA_DIR ?? '').trim() ||
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.umouse-mcp');
  const sleepResetIntervalMs = configInteger(
    env.UMOUSE_SLEEP_RESET_INTERVAL_MS, 120_000, 1_000, 2_147_483_647, 'UMOUSE_SLEEP_RESET_INTERVAL_MS');
  const sleepResetAckTimeoutMs = configInteger(
    env.UMOUSE_SLEEP_RESET_ACK_TIMEOUT_MS, 5_000, 100, 60_000, 'UMOUSE_SLEEP_RESET_ACK_TIMEOUT_MS');
  const sleepResetExpectAck = parseBool(env.UMOUSE_SLEEP_RESET_EXPECT_ACK, false);
  if (sleepResetExpectAck && sleepResetAckTimeoutMs >= sleepResetIntervalMs) {
    throw new Error('UMOUSE_SLEEP_RESET_ACK_TIMEOUT_MS 必须小于 UMOUSE_SLEEP_RESET_INTERVAL_MS');
  }

  const asrProvider = (env.UMSDK_ASR_PROVIDER ?? (process.platform === 'win32' ? 'sinicloud' : 'disabled')).trim();
  if (!['disabled', 'windows-speech', 'whisper-cpp', 'http', 'sinicloud'].includes(asrProvider)) throw new Error('UMSDK_ASR_PROVIDER 必须为 disabled/windows-speech/whisper-cpp/http/sinicloud（开源版不含 AsrTools 闭源链路）');
  const asr: TranscriberConfig | null = asrProvider === 'disabled' || asrProvider === 'sinicloud' ? null : {
    provider: asrProvider as TranscriberConfig['provider'],
    language: env.UMSDK_ASR_LANGUAGE?.trim() || 'zh-CN',
    timeoutMs: configInteger(env.UMSDK_ASR_TIMEOUT_MS, 60000, 100, 300000, 'UMSDK_ASR_TIMEOUT_MS'),
    endpoint: env.UMSDK_ASR_ENDPOINT?.trim(),
    model: env.UMSDK_ASR_MODEL?.trim(),
    apiKey: env.UMSDK_ASR_API_KEY,
    executable: env.UMSDK_ASR_EXECUTABLE?.trim(),
    modelPath: env.UMSDK_ASR_MODEL_PATH?.trim(),
    threads: configInteger(env.UMSDK_ASR_THREADS, 4, 1, 16, 'UMSDK_ASR_THREADS'),
  };
  // Validate without opening a recognizer or sending a network request.
  if (asr) createTranscriber(asr);


  // Sonicloud 开放平台流式识别（mcp/src/sinicloud-asr.ts）：凭据 JSON 文件 +
  // 环境变量覆盖（环境变量优先）。文件可在运行期修改——provider 每次会话 begin
  // 重新 load()，换 key 不用重启。凭据不打印、不入日志。环境变量：
  //   UMSDK_ASR_APP_ID / UMSDK_ASR_API_KEY / UMSDK_ASR_API_SECRET /
  //   UMSDK_ASR_USER_ID / UMSDK_ASR_LANID / UMSDK_ASR_ENDPOINT(流式 ws) / UMSDK_ASR_TOKEN_URL
  const asrSinicloudPath = path.resolve((env.UMSDK_ASR_SINICLOUD_CONFIG ?? '').trim()
    || path.join(dataDir, 'sinicloud_asr.json'));
  const asrSinicloudTimeoutMs = configInteger(env.UMSDK_ASR_TIMEOUT_MS, 60000, 100, 300000, 'UMSDK_ASR_TIMEOUT_MS');
  const trimStr = (v: string | undefined) => (v ?? '').trim() || undefined;
  const loadSinicloud = (): SinicloudCredentials => {
    let file: Record<string, unknown> = {};
    if (fs.existsSync(asrSinicloudPath)) file = JSON.parse(fs.readFileSync(asrSinicloudPath, 'utf8')) as Record<string, unknown>;
    const fromFile = (key: string) => (typeof file[key] === 'string' ? (file[key] as string).trim() || undefined : undefined);
    const lanid = Number(trimStr(env.UMSDK_ASR_LANID) ?? file.lanid ?? 0);
    return {
      appId: trimStr(env.UMSDK_ASR_APP_ID) ?? fromFile('appId') ?? '',
      apiKey: trimStr(env.UMSDK_ASR_API_KEY) ?? fromFile('apiKey') ?? '',
      apiSecret: trimStr(env.UMSDK_ASR_API_SECRET) ?? fromFile('apiSecret') ?? '',
      userId: trimStr(env.UMSDK_ASR_USER_ID) ?? fromFile('userId') ?? 'umouse-mcp',
      lanid: Number.isInteger(lanid) && lanid >= 0 && lanid <= 255 ? lanid : 0,
      streamUrl: trimStr(env.UMSDK_ASR_ENDPOINT) ?? fromFile('streamUrl') ?? 'ws://openapi.sinicloud.com/talentStreamAsr',
      tokenUrl: trimStr(env.UMSDK_ASR_TOKEN_URL) ?? fromFile('tokenUrl') ?? 'https://openapi.sinicloud.com/api/auth/get_token',
    };
  };

  // 连接驱动空闲生命周期（两段式）：默认 N=0 持续 60s 回收 SDK worker、5min daemon
  // 自退（connector 会按需重新拉起）；任一设 0 恢复旧语义（立即回收 / 常驻）。
  // 自退必须晚于 worker 回收，否则退不掉（worker 存活时 daemon 不自退）。
  const idleWorkerMs = configIdleMs(env.UMSDK_IDLE_WORKER_MS, 60_000, 1_000, 3_600_000, 'UMSDK_IDLE_WORKER_MS');
  const idleExitMs = configIdleMs(env.UMSDK_IDLE_EXIT_MS, 300_000, 10_000, 86_400_000, 'UMSDK_IDLE_EXIT_MS');
  if (idleExitMs > 0 && idleWorkerMs > 0 && idleExitMs <= idleWorkerMs)
    throw new Error('UMSDK_IDLE_EXIT_MS 必须大于 UMSDK_IDLE_WORKER_MS（先回收 worker 再自退）');

  return {
    libPath: libPathEnv ? path.resolve(libPathEnv) : defaultLibPath(),
    debug: Math.min(2, Math.max(0, parseNumber(env.UMSDK_DEBUG) ?? 0)),
    crashReport: parseBool(env.UMSDK_CRASH_REPORT, true),
    dataDir: path.resolve(dataDir),
    ...(env.UMSDK_SHARED_SAFETY_DIR ? { sharedSafetyDir: path.resolve(env.UMSDK_SHARED_SAFETY_DIR) } : {}),
    workMode: 'FULL',
    deviceLimit,
    usb,
    ble,
    eventBuffer: Math.min(20000, Math.max(100, parseNumber(env.UMSDK_EVENT_BUFFER) ?? 2000)),
    audioMaxSeconds: Math.min(600, Math.max(1, parseNumber(env.UMSDK_AUDIO_MAX_SECONDS) ?? 60)),
    audioQuotaMb: Math.min(2048, Math.max(1, parseNumber(env.UMSDK_AUDIO_QUOTA_MB) ?? 200)),
    // 默认开启：与硬件原生范式对齐（按住语音键→自动采集→松开出 speechCaptured 事件含 WAV 路径），
    // agent 零编排；UMSDK_SPEECH_AUTO=0 关闭后可用 umouse_audio_record 手动模式
    speechAutoRecord: parseBool(env.UMSDK_SPEECH_AUTO, true),
    asr,
    asrSinicloud: asrProvider === 'sinicloud'
      ? { load: loadSinicloud, configPath: asrSinicloudPath, timeoutMs: asrSinicloudTimeoutMs }
      : undefined,
    asrProvider,
    // 固件反向控制注入（cursor/key 工具面）：默认开启（本 MCP 的交付能力，
    // 协议为厂商正式接口）；UMSDK_INJECTION=0 关闭整个工具面
    injection: parseBool(env.UMSDK_INJECTION, true),
    // 键盘注入（0xF1）默认关闭：当前设备未观察到该指令的键盘效果——真机确认
    // Win+R 等序列全部"写入成功"但操作系统无任何反应，开放只会让 agent 空转；
    // 固件支持后 UMSDK_INJECT_KEYBOARD=1 恢复
    keyboardInjection: parseBool(env.UMSDK_INJECT_KEYBOARD, false),
    // 位移连帧间隔：真机实测 16ms(60Hz) 下固件丢约半数帧，
    // 默认 40ms（~25Hz）仅为发送节流，不保证设备执行时延
    injectFrameMs: Math.min(200, Math.max(2, parseNumber(env.UMSDK_INJECT_FRAME_MS) ?? 40)),
    // 点击按下→抬起 / 键按下→释放间隔
    injectClickMs: Math.min(500, Math.max(10, parseNumber(env.UMSDK_INJECT_CLICK_MS) ?? 50)),
    // 闭环定位单帧光标反馈等待上限：设备静止数十秒后反馈可迟至秒级甚至丢帧
    // （直连链路探测实测），默认 5s，按现场节奏可调 1~60s
    injectFeedbackMs: Math.min(60000, Math.max(1000, parseNumber(env.UMSDK_INJECT_FEEDBACK_MS) ?? 5000)),
    // 原始帧入事件流（rawFrame 事件，hex 载荷）：默认关闭（帧量大防刷屏），
    // 联调期开启以观察注入回执帧（0A 17 81 ...）
    rawFrameEvents: parseBool(env.UMSDK_RAWFRAME_EVENTS, false),
    // 强制接管仅显式启用：宿主工具发现也会启动 server，默认杀旧进程会误杀活动连接。
    // 正常 Windows 启动由内核占用锁保护唯一 SDK，等待者不终止其它 MCP 连接。
    takeover: parseBool(env.UMSDK_TAKEOVER, false),
    // A2 仅重置设备睡眠计时，不保证唤醒已休眠设备；默认连接时及每 120 秒发送。
    // 当前设备 A2 不回包；仅明确支持 ACK 的其它固件可显式打开应答观察窗。
    sleepResetEnabled: parseBool(env.UMOUSE_SLEEP_RESET_ENABLED, true),
    sleepResetIntervalMs,
    sleepResetExpectAck,
    sleepResetAckTimeoutMs,
    // v2 语音编排默认开启（进程内初始化，不自动开麦）；
    // UMSDK_VOICE=0 退回旧物理键自动录音→持久 inbox 链路
    voiceEnabled: parseBool(env.UMSDK_VOICE, true),
    voiceMaxMs: Math.min(120_000, Math.max(5_000, parseNumber(env.UMSDK_VOICE_MAX_MS) ?? 60_000)),
    voiceTestCaps: parseTestCaps(env.UMSDK_DEVICE_CAPS ?? env.UMSDK_TEST_CAPS),
    // 原始写入：默认不向普通会话开放任意 raw 写入，诊断需显式开启
    rawDiag: parseBool(env.UMSDK_RAW_DIAG, false),
    // VAD：默认 energy（本地、无依赖；Silero 接入后可切）；UMSDK_VOICE_VAD=none 为 manual_only
    voiceVad: ((env.UMSDK_VOICE_VAD ?? '').trim() === 'none' ? 'none' : 'energy') as 'none' | 'energy',
    voiceEndSilenceMs: Math.min(10_000, Math.max(300, parseNumber(env.UMSDK_VOICE_END_MS) ?? 1200)),
    voiceFirstSpeechMs: Math.min(60_000, Math.max(2_000, parseNumber(env.UMSDK_VOICE_FIRST_SPEECH_MS) ?? 10_000)),
    // 本地快照预览：默认开（有 ASR provider 时才有意义，无则空转）
    voicePreview: parseBool(env.UMSDK_VOICE_PREVIEW, true),
    // 录音浮窗：默认开；路径缺省探测 mcp/voice-ui/target/release/umouse-voice-ui(.exe)
    voiceUi: parseBool(env.UMSDK_VOICE_UI, true),
    voiceTyper: parseBool(env.UMSDK_VOICE_TYPER, true),
    voiceUiPath: env.UMSDK_VOICE_UI_PATH?.trim() ? path.resolve(env.UMSDK_VOICE_UI_PATH.trim()) : defaultVoiceUiPath(),
    idleWorkerMs,
    idleExitMs,
  };
}

/** UMSDK_TEST_CAPS='{"*|<deviceId>":{"mouse_control":"supported"}}'；非法直接抛配置错误 */
function parseTestCaps(raw: string | undefined): TestCapabilityProfile {
  const text = (raw ?? '').trim();
  if (!text) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('UMSDK_TEST_CAPS 必须是 JSON 对象'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('UMSDK_TEST_CAPS 必须是 JSON 对象');
  const out: TestCapabilityProfile = {};
  for (const [device, caps] of Object.entries(parsed as Record<string, unknown>)) {
    if (!device || typeof caps !== 'object' || caps === null || Array.isArray(caps)) {
      throw new Error(`UMSDK_TEST_CAPS[${device}] 必须是能力→取值对象`);
    }
    const entry: Record<string, 'supported' | 'unsupported' | 'unknown'> = {};
    for (const [cap, support] of Object.entries(caps as Record<string, unknown>)) {
      if (typeof support !== 'string' || !['supported', 'unsupported', 'unknown'].includes(support)) {
        throw new Error(`UMSDK_TEST_CAPS[${device}][${cap}] 取值必须为 supported/unsupported/unknown`);
      }
      entry[cap] = support as 'supported' | 'unsupported' | 'unknown';
    }
    out[device] = entry;
  }
  return out;
}
