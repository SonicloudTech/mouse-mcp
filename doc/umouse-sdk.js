// bindings/umouse-sdk.js —— uMouseSdk 的 koffi FFI 绑定（Node/Electron）
// 库路径优先级: 构造参数 > 环境变量 UMSDK_LIB_PATH > <electron>/lib/<平台库名>
//
// 本文件注释即完整接口参考（可不分发头文件）。覆盖全部 28 个导出接口。
//
// 【职责】打通 USB(2.4G 接收器)/BLE 两种传输，解析设备协议并输出：原始
//   按键事件（键+动作，无业务映射）、设备信息/DPI/会议等离散事件、PCM 音频
//   （16k/16bit/mono）。业务逻辑（哪个键做什么、音频如何识别）由宿主实现。
//
// 【典型调用序列】（main.js / cli-smoke.js 是完整范例）
//   const sdk = new UMouseSdk();
//   sdk.enableCrashReport(1);              // 可选（默认开）
//   sdk.setUsbConfig({...}) / setBleConfig({...})   // 可选：接入非默认设备
//   sdk.setWorkMode(UM_MODE.RAW);          // 可选：仅识别模式（见 RAW 三件套）
//   sdk.on('message', ...); sdk.on('audio', ...);   // 先挂事件再启动
//   sdk.start(1);                          // 注册回调 + um_sdk_init(debug)
//   ... sdk.setChannelPref(UM_CHAN.BLE);   // 运行中可切通道偏好
//   sdk.unregisterCallbacks(); sdk.stop(); // 退出（顺序契约见 unregisterCallbacks）
//
// 【返回值约定】命令/配置类接口（setUsbConfig/writeRaw/setDpi/meeting×4/
//   setChannelPref/setAudioOutputMode/setWorkMode/injectMouse/injectKeyboard）
//   返回 1=已设置/已下发，0=失败（未连接/参数非法/时机不对），不是错误码表；
//   各方法注释标明时机。
//
// 【device_id 语义】v0.3.0 多设备：device_id = 设备 SN（识别完成后上抛；
// 超时回退临时身份 usb-xxxx/ble-<mac>）。回调首参均为 device_id；命令类方法
// 可传可选 deviceId（多台在线必须指定；null/省略 = 唯一在线设备的兼容路径）。
// deviceCount/deviceId(i)/connectionMode(id) 枚举在线设备列表。
//
// 【会议独占】全局同一时刻只允许一台设备处于会议中：会议期间其它设备的
//   会议指令被 SDK 拦截（返回 0 + message 事件 {"type":"meetingBusy","owner":SN}）。
//
// 【固件反向控制注入（v0.4.22）】injectMouse/injectKeyboard 下发协议 03 F0/F1
//   十二字节动作帧：设备收到后在标准 HID 接口发出移动/按键报文，对操作系统
//   与物理操作无异（硬件级注入，仅在用户明确触发的动作里使用）。帧由 SDK
//   组装（含滚动序号 b12 循环分配 0x01~0xFF），宿主只传语义参数；参数越界
//   返回 0。按键/修饰键为状态型（置位=按下）：必须随后发全零帧释放；位移帧
//   失败/超时勿重发（重发位移叠加）。回执帧（0A 17 81 <len> <标志> <序号>
//   <状态>）经 'rawFrame' 事件对称透传，需要闭环的宿主按序号自行对账。
//
// 【线程契约】事件回调在 SDK 内部读线程触发：
//   - 请勿在回调内阻塞、勿调用 stop()（um_sdk_close）；
//   - 回调内可安全调用查询类接口（deviceCount/connectionMode 等）；
//   - audio/rawFrame 的 Buffer 已由蹦床从 koffi External 同步解码拷贝
//     （回调返回后原指针失效），监听器内可安全异步留存使用；
//   - um_* 接口本身线程安全，可从任意线程调用。
//
// 【message 事件 JSON 协议】统一结构 {"type":"...", ...}：
//   1) 按键  {"type":"keyEvent","key":"<key>","action":"<action>","index":<N>}
//      key: "speech"|"translation"|"m"|"ai"|"capture"
//      action: "down"|"up"|"hold"|"click"（speech/translation/ai: down/up，
//              ai 另有 click；m: down/hold/up；capture: click）
//      index: M 键专用（第几个 M 键，1 起），非 M 键为 0
//   2) 设备信息（随心跳/音频上报）
//      {"type":"deviceInfo","sn":"...","battery":50,"deviceType":"usb"}
//   3) DPI 变更（setDpi 的异步结果）
//      {"type":"dpiChanged","level":2}
//   4) 会议（meetingCreate/Destroy 的异步结果）
//      {"type":"meetingCreated"}
//      {"type":"meetingDestroyed","origin":"device-frame","reason":"destroy-frame"}
//        ↑ 设备销毁帧确认（唯一可当"设备已关麦"凭据的形态）；断连路径合成
//          {"type":"meetingDestroyed","origin":"transport-down",...} 是异常结束，
//          不是关麦确认。每段会议只上抛一次（重复销毁帧幂等跳过）。
//      {"type":"meetingCreateFailed","reason":"confirm-timeout"}
//        ↑ create 写入成功但 3s 无 created 帧：SDK 解除会议预约并上抛；只表示
//          建立未被确认，不表示设备已关麦，SDK 不代宿主补发 destroy。
//      {"type":"audioSegmentComplete","segment":<N>,"reason":"key-up|meeting-destroyed|meeting-stopped|meeting-stall|session-end"}
//        ↑ v0.4.23：本段已入队音频全部解码交付（含键抬起冲刷的编码尾块）；
//          segment 为设备内递增采集代次。流式识别在此边界后才 finish 输入。
//          v0.4.24：reason 带 -incomplete 表示音频丢失，不得作为完整录音交付。
//      {"type":"audioStreamIncomplete","reason":"dispatch-overflow"}
//          在派发队列丢失音频后、该设备下一幸存事件前到达；空 deviceId 表示
//          控制事件丢失，当前采集应失败关闭。关闭确认按尝试去重，不依赖 active。
//
// 事件（EventEmitter，回调在 SDK 内部线程触发，koffi 负责跨线程投递）:
//   'connected'    (connMode)   0=USB 1=BLE
//   'disconnected' (connMode)
//   'message'      (jsonStr)    见上方 JSON 协议
//   'audio'        (Buffer,len) 16k/16bit/mono PCM（setAudioOutputMode(RAW) 时为原始编码块）
//   'rawFrame'     (Buffer,len,conn,id) 原始帧（RAW/FULL 均透传；v0.4.0 起 FULL 对称上抛）
//
// 【RAW 模式接入新设备三件套】全部必须 start() 前调用（init 时快照注入）:
//   sdk.setWorkMode(UM_MODE.RAW)                      // init 前锁定
//   sdk.registerUsbBuildProbe(maxLen => Buffer|null)  // USB 握手查询指令
//   sdk.registerUsbValidateResp(buf => bool)          // 握手回应校验
//   （BLE 侧对应 registerBleMatchDevice((name, mac) => bool)；
//    RAW 下发命令用 writeRaw，音频解码自行处理或 setAudioOutputMode(RAW) 后
//    从 'audio' 事件取原始块）
'use strict';
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { EventEmitter } = require('events');

const LIB_NAMES = {
  win32: 'uMouseSdk.dll',
  linux: 'libuMouseSdk.so',
  darwin: 'libuMouseSdk.dylib',
};

/* 连接方式（connected/disconnected 事件参数） */
const UM_CONN = { USB: 0, BLE: 1 };
/* 音频输出模式（setAudioOutputMode）：PCM=解码后 16k/16bit/mono（默认）；
 * RAW=原始编码累积块（每 256B 一块，解码由宿主处理） */
const UM_AUDIO = { PCM: 0, RAW: 1 };
/* 工作模式（setWorkMode，start 前生效）：FULL=完整协议解析（默认）；
 * RAW=仅识别，透传原始帧（'rawFrame' 事件），宿主自行解析协议 */
const UM_MODE = { FULL: 0, RAW: 1 };
/* 通道偏好（setChannelPref，start 后运行时可切）：AUTO=USB 优先静默转 BLE
 * （默认）；USB=仅 2.4G 接收器；BLE=仅蓝牙（接收器在位导致 USB 假在线时用） */
const UM_CHAN = { AUTO: 0, USB: 1, BLE: 2 };

/* 旧版 DLL 缺少 v0.4.22 注入导出时返回 null（方法调用时给可读错误） */
function tryFunc(lib, sig) {
  try { return lib.func(sig); } catch (e) { return null; }
}

/* 回调原型与配置结构体（与 uMouseSdk C ABI 一致）。模块级注册一次：
 * koffi.proto/struct 的类型名进程内全局，放构造器里会导致同进程第二次
 * new UMouseSdk() 抛 "Duplicate type name"（重启流程/多测试场景会踩）。 */
const ON_CONN_FN = koffi.proto('void um_on_conn(const char *device_id, int conn_mode)');
const ON_MSG_FN = koffi.proto('void um_on_msg(const char *device_id, const char *json)');
const ON_AUDIO_FN =
  koffi.proto('void um_on_audio(const char *device_id, const uint8_t *pcm, int len)');
const ON_RAW_FRAME_FN = koffi.proto(
  'void um_on_raw_frame(const char *device_id, const uint8_t *data, int len, int conn)');
const USB_BUILD_PROBE_FN = koffi.proto('int um_usb_build_probe(uint8_t *out, int max_len)');
const USB_VALIDATE_RESP_FN = koffi.proto('int um_usb_validate_resp(const uint8_t *buf, int len)');
const BLE_MATCH_FN = koffi.proto('int um_ble_match_device(const char *name, const char *address)');
const DEVICE_SN_PROBE_FN = koffi.proto(
  'int um_device_sn_probe(const char *rule_id, const uint8_t *data, int len, char *out_sn, int out_cap)');

const UM_USB_CONFIG = koffi.struct('um_usb_config', {
  vid: 'uint16_t',
  pid: 'uint16_t',
  iface: 'int32_t',
  report_id: 'uint8_t',
});
const UM_USB_MATCH = koffi.struct('um_usb_match', {
  vid: 'uint16_t',
  pid: 'uint16_t',
  iface: 'int32_t',
  report_id: 'uint8_t',
});
const UM_BLE_CONFIG = koffi.struct('um_ble_config', {
  name: 'const char *',
  mac_prefix: 'const char *',
  service: 'const char *',
  characteristic: 'const char *',
});

class UMouseSdk extends EventEmitter {
  constructor(libPath) {
    super();
    const name = LIB_NAMES[process.platform];
    if (!name) throw new Error(`unsupported platform: ${process.platform}`);
    const libFile = libPath || process.env.UMSDK_LIB_PATH ||
      path.join(__dirname, '..', 'lib', name);
    if (!fs.existsSync(libFile)) {
      throw new Error(`uMouseSdk library not found: ${libFile}（先运行 npm run copy-dlls）`);
    }
    this._lib = koffi.load(libFile);

    /* API 函数（25 个导出全覆盖） */
    this._um_version = this._lib.func('const char *um_sdk_version()');
    this._um_init = this._lib.func('void um_sdk_init(int debug)');
    this._um_close = this._lib.func('void um_sdk_close()');
    this._um_enable_crash_report = this._lib.func('void um_enable_crash_report(int enable)');
    this._um_set_audio_output_mode = this._lib.func('int um_set_audio_output_mode(int mode)');
    this._um_set_work_mode = this._lib.func('int um_set_work_mode(int mode)');
    this._um_set_usb_config = this._lib.func(
      'int um_set_usb_config(const char *device_id, um_usb_config *cfg)');
    this._um_set_ble_config = this._lib.func(
      'int um_set_ble_config(const char *device_id, um_ble_config *cfg)');
    this._um_set_channel_pref = this._lib.func('int um_set_channel_pref(int pref)');
    this._um_set_channel_pref_for =
      this._lib.func('int um_set_channel_pref_for(const char *device_id, int pref)');
    this._um_set_audio_source =
      this._lib.func('int um_set_audio_source(const char *device_id)');
    this._um_get_audio_source = this._lib.func('const char *um_get_audio_source()');
    this._um_set_work_mode_for =
      this._lib.func('int um_set_work_mode_for(const char *rule_id, int mode)');
    this._um_set_device_limit =
      this._lib.func('int um_set_device_limit(const char *rule_id, int max_devices)');
    this._um_register_device_sn_probe =
      this._lib.func('void um_register_device_sn_probe(const char *rule_id, um_device_sn_probe *cb)');
    this._um_usb_add_match =
      this._lib.func('int um_usb_add_match(const char *rule_id, um_usb_match *m)');
    this._um_register_connected =
      this._lib.func('void um_register_connected(um_on_conn *cb)');
    this._um_register_disconnected =
      this._lib.func('void um_register_disconnected(um_on_conn *cb)');
    this._um_register_message = this._lib.func('void um_register_message(um_on_msg *cb)');
    this._um_register_audio = this._lib.func('void um_register_audio(um_on_audio *cb)');
    this._um_register_raw_frame = this._lib.func('void um_register_raw_frame(um_on_raw_frame *cb)');
    this._um_register_usb_build_probe =
      this._lib.func('void um_register_usb_build_probe(um_usb_build_probe *cb)');
    this._um_register_usb_validate_resp =
      this._lib.func('void um_register_usb_validate_resp(um_usb_validate_resp *cb)');
    this._um_register_ble_match_device =
      this._lib.func('void um_register_ble_match_device(um_ble_match_device *cb)');
    this._um_get_device_count = this._lib.func('int um_get_device_count()');
    this._um_get_device_id = this._lib.func('const char *um_get_device_id(int index)');
    this._um_get_connection_mode =
      this._lib.func('int um_get_connection_mode(const char *device_id)');
    this._um_write_raw =
      this._lib.func('int um_write_raw(const char *device_id, const uint8_t *data, int len)');
    this._um_set_dpi = this._lib.func('int um_set_dpi(const char *device_id, int level)');
    this._um_meeting_create = this._lib.func('int um_meeting_create(const char *device_id)');
    this._um_meeting_destroy = this._lib.func('int um_meeting_destroy(const char *device_id)');
    this._um_meeting_pause = this._lib.func('int um_meeting_pause(const char *device_id)');
    this._um_meeting_resume = this._lib.func('int um_meeting_resume(const char *device_id)');
    // v0.4.22 注入导出：旧版 DLL 无此符号时置 null（调用时抛可读错误），不阻断加载
    this._um_inject_mouse = tryFunc(this._lib,
      'int um_inject_mouse(const char *device_id, int buttons, int dx, int dy, int wheel)');
    this._um_inject_keyboard = tryFunc(this._lib,
      'int um_inject_keyboard(const char *device_id, int modifiers, const uint8_t *usage_ids, int count)');

    /* 事件类回调（koffi 注册一次保存引用防 GC；运行期可反复换 JS 处理器）。
     * 蹦床透传 device_id（SN）：connected/disconnected 首参，message/audio 尾参。 */
    this._cbs = {
      conn: koffi.register((id, mode) => this.emit('connected', id, mode),
        koffi.pointer(ON_CONN_FN)),
      disconn: koffi.register((id, mode) => this.emit('disconnected', id, mode),
        koffi.pointer(ON_CONN_FN)),
      msg: koffi.register((id, json) => this.emit('message', json, id),
        koffi.pointer(ON_MSG_FN)),
      audio: koffi.register((id, pcm, len) => {
        // koffi 回调指针参数是不透明 External（非 Buffer 视图，subarray/Buffer.from
        // 均抛错）：同步解码为 number[] 再拷贝成 Buffer——回调返回后原指针即失效，
        // 必须在蹦床内完成拷贝（2026-08-20 修复 PCM 0 字节/电平条失效的根因）
        if (pcm && len > 0)
          this.emit('audio', Buffer.from(koffi.decode(pcm, 'uint8_t', len)), len, id);
      }, koffi.pointer(ON_AUDIO_FN)),
      rawFrame: koffi.register((id, data, len, conn) => {
        // 同上：External 解码拷贝（仅 RAW 模式触发）；device_id 作尾参透传
        if (data && len > 0)
          this.emit('rawFrame', Buffer.from(koffi.decode(data, 'uint8_t', len)), len, conn, id);
      }, koffi.pointer(ON_RAW_FRAME_FN)),
    };

    /* 握手/匹配/SN 提取类回调：C 侧只在 um_sdk_init 时快照注入一次，所以蹦床必须
     * 在 start() 前就注册好，JS 处理器通过下方 register* 方法随时替换。 */
    this._usbBuildProbeFn = null;
    this._usbValidateRespFn = null;
    this._bleMatchFn = null;
    this._snProbeFns = {};   // ruleId → 解析器（sn_probe 回调带 rule_id，按规则分发）
    this._probeCbs = {
      buildProbe: koffi.register((out, maxLen) => {
        const fn = this._usbBuildProbeFn;
        if (!fn) return 0; // 未设置 → SDK 用默认查询指令
        let data = null;
        try { data = fn(maxLen); } catch (e) {
          this.emit('log', 3, `usb_build_probe 回调异常: ${e.message}`);
          return 0;
        }
        if (!data || data.length === 0) return 0;
        const n = Math.min(data.length, maxLen);
        try {
          // out 是 koffi 的不透明 External（无 .buffer/.subarray）：经 koffi.array
          // 数组形态整块写出（2026-08-20 修复 RAW 自定义握手静默退化的根因）
          koffi.encode(out, koffi.array('uint8_t', n), Array.from(data.subarray(0, n)));
        } catch (e) {
          this.emit('log', 3, `usb_build_probe 写出失败: ${e.message}`);
          return 0;
        }
        return n;
      }, koffi.pointer(USB_BUILD_PROBE_FN)),
      validateResp: koffi.register((buf, len) => {
        const fn = this._usbValidateRespFn;
        if (!fn) return 0;
        try { return fn(Buffer.from(koffi.decode(buf, 'uint8_t', len)), len) ? 1 : 0; }
        catch (e) { this.emit('log', 3, `usb_validate_resp 回调异常: ${e.message}`); return 0; }
      }, koffi.pointer(USB_VALIDATE_RESP_FN)),
      bleMatch: koffi.register((name, address) => {
        const fn = this._bleMatchFn;
        if (!fn) return 0;
        try { return fn(name, address) ? 1 : 0; }
        catch (e) { this.emit('log', 3, `ble_match_device 回调异常: ${e.message}`); return 0; }
      }, koffi.pointer(BLE_MATCH_FN)),
      snProbe: koffi.register((ruleId, data, len, out, outCap) => {
        // RAW 规则的 SN 提取（识别窗口内逐帧喂入；rule_id 区分协议）
        const fn = this._snProbeFns[ruleId || ''];
        if (!fn) return 0;
        let sn = null;
        try { sn = fn(Buffer.from(koffi.decode(data, 'uint8_t', len)), len); }
        catch (e) { this.emit('log', 3, `device_sn_probe 回调异常: ${e.message}`); return 0; }
        if (!sn || !sn.length) return 0;
        const n = Math.min(sn.length, outCap - 1);
        if (n <= 0) return 0;
        try {
          // out 是不透明 External：整块写出含结尾 \0（与 buildProbe 的 out 写法同构）
          koffi.encode(out, koffi.array('int8_t', n + 1),
                       Array.from(Buffer.from(sn.substr(0, n) + '\0', 'latin1')));
        } catch (e) { this.emit('log', 3, `device_sn_probe 写出失败: ${e.message}`); return 0; }
        return 1;
      }, koffi.pointer(DEVICE_SN_PROBE_FN)),
    };
    this._started = false;
  }

  version() { return this._um_version(); }
  isStarted() { return this._started; }

  /** 进程崩溃记录开关（默认开）。崩溃时在进程 cwd 写 umouse_crash-<时间戳>.log，
   * 保留最近 10 份，仅技术诊断信息（不含 token/SN）。可在任意时刻调用。 */
  enableCrashReport(enable) { this._um_enable_crash_report(enable ? 1 : 0); }

  /** 音频输出模式（init 后可随时切）：
   *  UM_AUDIO.PCM=解码后 16k/16bit/mono（默认）；UM_AUDIO.RAW=原始编码累积块
   *  （每 256B 一块，解码交给宿主的 'audio' 事件处理器）。返回 1=已设置。 */
  setAudioOutputMode(mode) { return this._um_set_audio_output_mode(mode); }

  /** 工作模式（必须 start() 前调用，init 时锁定）：
   *  UM_MODE.FULL=完整协议解析（默认，按键/音频/SN/DPI/会议全解析）；
   *  UM_MODE.RAW=仅识别，SDK 不做协议解析，原始帧走 'rawFrame' 事件，
   *  适用于硬件协议与默认不同的设备（配合 writeRaw 下发自定义协议）。
   *  返回 1=已设置，0=已启动后调用（不生效）。 */
  setWorkMode(mode) { return this._um_set_work_mode(mode); }

  /** 覆盖 2.4G USB 接收器识别标识（必须 start() 前调用）。
   *  cfg: { vid, pid, iface, reportId }——vid/pid/reportId 填 0 保留生产默认
   *  （0xABC9/0xCA89/0x0A）；iface 默认 1=生产默认数据接口号，注意它没有
   *  "0 保留默认"语义：接入新设备务必显式填写（新设备数据口多为 0 或 -1 不限）。
   *  返回 1=已采纳，0=未采纳（cfg 为空，或 SDK 已启动）。 */
  setUsbConfig(cfg) { return this.setUsbConfigFor(null, cfg); }

  /** 同 setUsbConfig，但注册到指定规则（v0.3.0 多设备：不同型号各一条规则；
   * 同型号多台共用一条规则）。ruleId=null/'' = 默认规则。 */
  setUsbConfigFor(ruleId, cfg) {
    if (!cfg) return 0;
    const ptr = koffi.alloc(UM_USB_CONFIG, 1);
    koffi.encode(ptr, UM_USB_CONFIG, {
      vid: cfg.vid | 0,
      pid: cfg.pid | 0,
      iface: cfg.iface == null ? 1 : (cfg.iface | 0),
      report_id: cfg.reportId | 0,
    });
    return this._um_set_usb_config(ruleId || null, ptr);
  }

  /** 覆盖蓝牙识别标识（必须 start() 前调用）。
   *  cfg: { name, macPrefix, service, characteristic }——null/undefined 保留
   *  生产默认（"uMouse" / "C0:88" / 默认 GATT UUID）。返回 1=已采纳。 */
  setBleConfig(cfg) {
    if (!cfg) return 0;
    const ptr = koffi.alloc(UM_BLE_CONFIG, 1);
    koffi.encode(ptr, UM_BLE_CONFIG, {
      name: cfg.name || null,
      mac_prefix: cfg.macPrefix || null,
      service: cfg.service || null,
      characteristic: cfg.characteristic || null,
    });
    return this._um_set_ble_config(null, ptr);
  }

  /** 同 setBleConfig，注册到指定规则。 */
  setBleConfigFor(ruleId, cfg) {
    if (!cfg) return 0;
    const ptr = koffi.alloc(UM_BLE_CONFIG, 1);
    koffi.encode(ptr, UM_BLE_CONFIG, {
      name: cfg.name || null,
      mac_prefix: cfg.macPrefix || null,
      service: cfg.service || null,
      characteristic: cfg.characteristic || null,
    });
    return this._um_set_ble_config(ruleId || null, ptr);
  }

  /** RAW 规则的 SN 提取回调（必须 start() 前调用；识别窗口内逐帧喂入，
   *  rule_id 区分协议）。fn(buf, len) 返回 SN 字符串（每台设备必须唯一，
   *  型号号勿返回），无识别返回 null。不注册则该规则 3s 后以临时身份上线。 */
  registerDeviceSnProbe(ruleId, fn) {
    const key = ruleId || '';
    if (fn) this._snProbeFns[key] = fn;
    else delete this._snProbeFns[key];
    this._um_register_device_sn_probe(key, fn ? this._probeCbs.snProbe : null);
  }

  /** 按规则设置工作模式（v0.3.0 多设备；默认规则默认 FULL，非默认规则默认 RAW；
   *  FULL 全局仅一条）。必须 start() 前调用。 */
  setWorkModeFor(ruleId, mode) { return this._um_set_work_mode_for(ruleId || null, mode); }

  /** 同型号多台上限（1~8，默认 4；FULL 规则恒为 1）。必须 start() 前调用。 */
  setDeviceLimit(ruleId, maxDevices) { return this._um_set_device_limit(ruleId || null, maxDevices); }

  /** 追加一条 VID/PID 匹配项（同族多型号：一个规则匹配多个 VID/PID）。
   *  m: { vid, pid, iface, reportId }——vid/pid 必填（无"0=默认"语义），
   *  iface/reportId 按字面生效。必须 start 前调用。返回 1=已追加。 */
  addUsbMatch(ruleId, m) {
    if (!m || !m.vid || !m.pid) return 0;
    const ptr = koffi.alloc(UM_USB_MATCH, 1);
    koffi.encode(ptr, UM_USB_MATCH, {
      vid: m.vid | 0,
      pid: m.pid | 0,
      iface: m.iface == null ? 1 : (m.iface | 0),
      report_id: m.reportId | 0,
    });
    return this._um_usb_add_match(ruleId || null, ptr);
  }

  /** 通道偏好（start() 后运行时可切，切换会断开当前通道重新探测）：
   *  UM_CHAN.AUTO=USB 优先静默转 BLE（默认）；USB=仅 2.4G 接收器；
   *  BLE=仅蓝牙（接收器在位导致 USB 假在线时用它）。返回 1=已设置。 */
  setChannelPref(pref) { return this._um_set_channel_pref(pref); }

  /** 通道偏好（按设备，v0.3.0）：作用于指定 device_id 的在线设备。 */
  setChannelPrefFor(deviceId, pref) { return this._um_set_channel_pref_for(deviceId || null, pref); }

  /** 语音音频源（v0.3.0 多设备，任意时刻可设）：仅该设备的音频经 'audio'
   *  事件上抛，其它设备在 SDK 层过滤——语音识别会话同一时刻只应有一个音频源。
   *  deviceId=null/'' 恢复全部设备（默认）。不校验在线状态，设备上线后自动适用。
   *  返回 1=已设置。 */
  setAudioSource(deviceId) { return this._um_set_audio_source(deviceId || null); }
  /** 查询当前音频源（''=不过滤）。返回值在下次 setAudioSource 前有效。 */
  audioSource() { return this._um_get_audio_source() || ''; }

  /** USB 握手查询指令生成（仅 RAW 模式 + USB 通道生效；必须 start() 前调用，
   *  init 时快照注入）。fn(maxLen) 返回 Buffer（≤maxLen 字节，首字节通常为
   *  report_id），返回 null/空用 SDK 默认指令 {report_id,0x03,0xA0,0x00}。 */
  registerUsbBuildProbe(fn) {
    this._usbBuildProbeFn = fn || null;
    this._um_register_usb_build_probe(fn ? this._probeCbs.buildProbe : null);
  }

  /** USB 握手回应帧校验（仅 RAW 模式 + USB 通道；必须 start() 前调用）。
   *  fn(buf:Buffer, len) 返回 true=有效回应（设备在线）。不注册用默认校验。 */
  registerUsbValidateResp(fn) {
    this._usbValidateRespFn = fn || null;
    this._um_register_usb_validate_resp(fn ? this._probeCbs.validateResp : null);
  }

  /** BLE 目标设备识别（仅 RAW 模式 + BLE 通道；必须 start() 前调用）。
   *  fn(name, address) 返回 true=接管。不注册用默认匹配（名称精确/MAC 前缀）。 */
  registerBleMatchDevice(fn) {
    this._bleMatchFn = fn || null;
    this._um_register_ble_match_device(fn ? this._probeCbs.bleMatch : null);
  }

  /** 注册回调 + 启动 SDK（debug=1 开内部日志，cpp_modules.log 落在进程 cwd）。
   *  setWorkMode/setUsbConfig/setBleConfig 与三个 registerUsb、registerBleMatch
   *  必须在本调用之前完成（init 时锁定/快照）。 */
  start(debug = 1) {
    if (this._started) return;
    this._um_register_connected(this._cbs.conn);
    this._um_register_disconnected(this._cbs.disconn);
    this._um_register_message(this._cbs.msg);
    this._um_register_audio(this._cbs.audio);
    this._um_register_raw_frame(this._cbs.rawFrame);
    this._um_init(debug);
    this._started = true;
  }

  stop() {
    if (!this._started) return;
    this._um_close();
    this._started = false;
  }

  /** 摘除全部 C 侧回调（退出序列第一步）。
   * koffi 跨线程投递是"库线程阻塞等 JS 执行"：若退出瞬间有在途投递，而主线程
   * 又阻塞在 um_sdk_close 的 join 上即互锁（2026-08-18 实测）。正确顺序：
   * 先摘回调（库线程不再进入 JS）→ 让事件循环消化在途投递 → 再 stop()。 */
  unregisterCallbacks() {
    if (!this._started) return;
    this._um_register_connected(null);
    this._um_register_disconnected(null);
    this._um_register_message(null);
    this._um_register_audio(null);
    this._um_register_raw_frame(null);
  }

  deviceCount() { return this._um_get_device_count(); }
  deviceId(index) { return this._um_get_device_id(index) || ''; }
  connectionMode(deviceId) { return this._um_get_connection_mode(deviceId || null); }

  /** 枚举当前在线设备（v0.3.0 多设备）：[{ id, mode }]，mode 为 'USB'/'BLE'。
   * id 即回调携带的 device_id（SN 或临时身份）。 */
  deviceList() {
    const out = [];
    const n = this._um_get_device_count();
    for (let i = 0; i < n; ++i) {
      const id = this._um_get_device_id(i);
      if (!id) break; // 竞态：列表在枚举中途变化，下一轮轮询会纠正
      const m = this._um_get_connection_mode(id);
      out.push({ id, mode: m === 1 ? 'BLE' : m === 0 ? 'USB' : '?' });
    }
    return out;
  }

  /** 向指定设备的活动通道写原始字节（FULL/RAW 模式均可用；RAW 模式下发自定义协议）。
   * deviceId 可选（多台在线必须指定；null=唯一在线设备）。
   * 注意：USB-HID 首字节通常需为 report_id（默认 0x0A），由调用方组装。
   * 返回 1=已写入，0=失败（未连接/参数空）。 */
  writeRaw(buf, deviceId) {
    if (!buf || !buf.length) return 0;
    return this._um_write_raw(deviceId || null, buf, buf.length);
  }

  /** 设置 DPI 档位。deviceId 可选（多台在线必须指定）。返回 1=已下发，0=失败；
   *  结果经 message 事件 dpiChanged 上报。 */
  setDpi(level, deviceId) { return this._um_set_dpi(deviceId || null, level); }

  /** 下发一帧鼠标动作（固件反向控制，协议 03 F0，v0.4.22）：设备在标准 HID
   *  接口发出移动/按键报文，对 OS 即物理操作。帧由 SDK 组装（滚动序号内部
   *  循环分配），回执经 'rawFrame' 事件透传。
   *  buttons：位图 bit0=左 bit1=右 bit2=中（状态型：置位=按下，须再发 0 释放）；
   *  dx/dy/wheel：int8 相对值（-127~127；正=右/下/向上），大位移由宿主拆帧
   *  多次调用。位移帧失败勿重发（会叠加）。
   *  deviceId 可选（多台在线必须指定）。返回 1=已写入通道，0=失败（未连接/参数越界）。 */
  injectMouse(buttons, dx, dy, wheel, deviceId) {
    if (!this._um_inject_mouse)
      throw new Error('当前 uMouseSdk.dll 不含 um_inject_mouse（需 v0.4.22+，请重新编译并更新 lib/）');
    return this._um_inject_mouse(deviceId || null, buttons, dx, dy, wheel);
  }

  /** 下发一帧键盘动作（协议 03 F1，标准 HID boot keyboard 报文，v0.4.22）。
   *  modifiers：修饰键位图（bit0=LCtrl bit1=LShift bit2=LAlt bit3=LGUI）；
   *  usageIds：普通按键 HID Usage ID 数组（≤6 个，如 0x04='a'；空/全零=释放全部）。
   *  按下后须再发全零帧释放（组合键/长按由宿主连发实现）。
   *  deviceId 可选。返回 1=已写入通道，0=失败（未连接/参数越界）。 */
  injectKeyboard(modifiers, usageIds, deviceId) {
    if (!this._um_inject_keyboard)
      throw new Error('当前 uMouseSdk.dll 不含 um_inject_keyboard（需 v0.4.22+，请重新编译并更新 lib/）');
    const ids = Array.isArray(usageIds) ? usageIds.slice(0, 6) : [];
    for (const v of ids) {
      if (!Number.isInteger(v) || v < 0 || v > 0xff) return 0;  // Usage ID 越界：按参数非法拒绝
    }
    const buf = Buffer.alloc(6, 0);
    ids.forEach((v, i) => buf.writeUInt8(v, i));
    return this._um_inject_keyboard(deviceId || null, modifiers & 0xff, buf, buf.length);
  }

  /** 会议模式四命令（结果经 message 事件 meetingCreated/meetingDestroyed 上报；
   * 会议期间其它设备的会议指令被 SDK 拦截，见文件头【会议独占】）。
   * deviceId 可选（多台在线必须指定）。返回 1=已下发，0=失败/被拦截。 */
  meetingCreate(deviceId) { return this._um_meeting_create(deviceId || null); }
  meetingDestroy(deviceId) { return this._um_meeting_destroy(deviceId || null); }
  meetingPause(deviceId) { return this._um_meeting_pause(deviceId || null); }
  meetingResume(deviceId) { return this._um_meeting_resume(deviceId || null); }
}

module.exports = { UMouseSdk, UM_CONN, UM_AUDIO, UM_MODE, UM_CHAN };
