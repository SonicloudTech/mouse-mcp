// bindings/typer.js —— typer 模拟打字库的 koffi FFI 绑定
// 库路径优先级: 构造参数 > 环境变量 TYPER_LIB_PATH > <electron>/lib/<平台库名>
// 覆盖 typer 全部 19 个导出接口。本文件注释即完整接口参考。
//
// 【能力边界】Windows(Win32 SendInput) / macOS(AX) / Linux(X11、XWayland；
//   原生 Wayland 不支持注入——probe() 的 session_type=5 即此情形，所有注入
//   接口返回 -2(NOT_SUPPORTED)）。是否可注入先 probe() 探测（input_permitted）。
//
// 【典型调用序列】（语音键→识别→打字；voice-agent.js 是完整范例）
//   const typer = new Typer();
//   typer.probe();                          // 0. 能力探测（可省，init 会补）
//   typer.init();                           // 1. 创建上下文（拉起常驻打字线程）
//   typer.sessionBegin(TYPER_MODE.PER_CHAR);// 2. 录音开始：会话开（模式：逐字/整句）
//   typer.feedPartial('你好');               // 3. 中间结果（逐字模式实时打，自动去重）
//   typer.feedFinal('你好世界。');            // 4. 最终结果（打完清增量基准）
//   typer.sessionEnd();                     // 5. 录音结束：队列打空后回 IDLE
//   await typer.shutdown();                 // 6. 异步停线程，回调存活到 join 完成
//
// 【会话状态机】IDLE →(sessionBegin)ACTIVE →(sessionEnd)ENDING →(队列打空)IDLE。
//   feed 只在 ACTIVE/ENDING 接受（ENDING 期间迟到的 final 仍会打出）；
//   sessionAbort() 任意时刻可调：清空未打队列 + 恢复 IME + 回 IDLE。
//   无状态原语（typeText/backspace/…/paste）不需要会话，同步执行、任意线程。
//
// 【两种输出模式】
//   TYPER_MODE.PER_CHAR=0     逐字增量：中间结果实时打（退差异+打新增），
//                             有打字感，不动剪贴板；
//   TYPER_MODE.WHOLE_PHRASE=1 整句粘贴：跳过中间结果，只粘贴 final，
//                             快但会覆盖用户剪贴板（pasteText 同）。
//
// 【错误码】所有注入/会话接口返回 int，0=成功：
//   -1 INVALID_ARG   空参数/非法 UTF-8/count<0/未映射的 VK 键码
//   -2 NOT_SUPPORTED 当前会话类型不支持注入（如 Linux 原生 Wayland）
//   -3 NO_DISPLAY    Linux：DISPLAY 缺失 / XOpenDisplay 失败
//   -4 ACCESS_DENIED Win：目标为提权窗口被 UIPI 拒；mac：辅助功能授权未授予
//   -5 NO_TOOL       所需外部工具缺失（xdotool/xclip）且无回退
//   -6 WRONG_STATE   会话状态错（未 begin 就 feed / 已停止）
//   -7 TIMEOUT       内部子进程执行超时
//   -8 QUEUE_FULL    入队超过上限（默认 256，防调用方泄漏）
//   -9 CLIPBOARD     剪贴板打开/写入失败（被占用等）
//   -10 IO           子进程启动成功但执行失败（非 0 退出码）
//   错误转描述：strerror(rc)。
//
// 【日志】全局单例（与句柄无关）：setLogCallback(cb)，cb(level, msg)，
//   level 0=debug 1=info 2=warn 3=error。可在任意时刻调用，传 null 关闭。
//
// 【输入注入警告】backspace/enter/keyTap/keyPress/keyRelease/copy/paste 是
//   真实输入注入——会作用于用户当前焦点窗口（可能在别的应用里删字/回车/
//   按键），仅在用户明确触发的动作里调用；keyTap 的 vks 为 Windows VK 码
//   （如 [0x11,0x43]=Ctrl+C）。
//
// 【默认配置】init() 传完整 typer_config（v1.1.0 全字段映射），时序参数
//   全 0 = 库内默认（厂商实测验证值）；error_cb 桥接为 'error' 事件
//   （注入失败即停止自动输入）。如需自定义时序参数（如
//   xkb_bind_delay_ms 影响首字可靠性），在 typer_config_t 映射处扩展。
'use strict';
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { EventEmitter } = require('events');

const LIB_NAMES = {
  win32: 'typer.dll',
  linux: 'libtyper.so',
  darwin: 'libtyper.dylib',
};

const TYPER_MODE = { PER_CHAR: 0, WHOLE_PHRASE: 1 };

/* 错误码（含义见文件头【错误码】） */
const TYPER_ERR = {
  OK: 0, INVALID_ARG: -1, NOT_SUPPORTED: -2, NO_DISPLAY: -3,
  ACCESS_DENIED: -4, NO_TOOL: -5, WRONG_STATE: -6, TIMEOUT: -7,
  QUEUE_FULL: -8, CLIPBOARD: -9, IO: -10,
};

/* 能力探测结果字段（probe() 返回对象；koffi 结构体映射）：
 *   session_type      0 未知/1 Win32/2 macOS/3 X11/4 XWayland/5 原生 Wayland(不支持注入)
 *   text_typing       1=能注入文本
 *   increment_typing  1=支持增量修正（退格+新打，PER_CHAR 模式依赖）
 *   whole_phrase_paste 1=整句粘贴模式可用
 *   ime_guard         1=IME 守卫可用（仅 Linux + fcitx*-remote 存在）
 *   input_permitted   0=系统权限不允许注入（-4 ACCESS_DENIED 的预检形态）
 *   has_xdotool/has_xclip/has_fcitx_remote  Linux 外部工具探测（0/1）
 *   ime_tool_path     探测到的 *-remote 绝对路径（诊断用，可为空串） */

const typer_log_cb = koffi.proto('void typer_log_cb(void *user, int level, const char *msg)');
/* v1.1.0 注入失败回调：失败时从库内部
 * 打字线程触发；本绑定转成 'error'(code, message) 事件 */
const typer_error_cb = koffi.proto('void typer_error_cb(void *user, int code)');

/* typer_config 全字段映射（v1.1.0；布局必须与 include/typer.h 严格一致）。
 * 尾部 error_cb/error_user 为 v1.1.0 追加；旧 DLL 使用 NULL 默认配置，
 * 不传此结构体，也收不到 error 事件。 */
const typer_config_t = koffi.struct('typer_config_t', {
  size: 'size_t',
  drained_cb: 'void *',          // 本绑定未桥接 drained（保持原状）
  drained_user: 'void *',
  xkb_bind_delay_ms: 'int',
  xkb_char_interval_ms: 'int',
  xdotool_char_delay_ms: 'int',
  xclip_settle_ms: 'int',
  paste_settle_ms: 'int',
  ime_settle_ms: 'int',
  proc_timeout_ms: 'int',
  queue_limit: 'int',
  error_cb: koffi.pointer(typer_error_cb),
  error_user: 'void *',
});

const typer_caps_t = koffi.struct('typer_caps_t', {
  size: 'size_t',
  session_type: 'int',
  text_typing: 'int',
  increment_typing: 'int',
  whole_phrase_paste: 'int',
  ime_guard: 'int',
  input_permitted: 'int',
  has_xdotool: 'int',
  has_xclip: 'int',
  has_fcitx_remote: 'int',
  ime_tool_path: 'char[260]',
});

class Typer extends EventEmitter {
  constructor(libPath) {
    super();
    const name = LIB_NAMES[process.platform];
    if (!name) throw new Error(`unsupported platform: ${process.platform}`);
    const libFile = libPath || process.env.TYPER_LIB_PATH ||
      path.join(__dirname, '..', 'lib', name);
    if (!fs.existsSync(libFile)) {
      throw new Error(`typer library not found: ${libFile}（先运行 npm run copy-dlls）`);
    }
    this._lib = koffi.load(libFile);
    const f = this._lib;
    this._version = f.func('const char *typer_version()');
    this._strerror = f.func('const char *typer_strerror(int result)');
    this._probe = f.func('int typer_probe(typer_caps_t *out)');
    this._create = f.func('void *typer_create(const void *cfg)'); // cfg=NULL 全默认
    this._destroy = f.func('void typer_destroy(void *ctx)');
    this._type_text = f.func('int typer_type_text(void *ctx, const char *utf8)');
    this._backspace = f.func('int typer_backspace(void *ctx, int count)');
    this._enter = f.func('int typer_enter(void *ctx, int count)');
    this._key_tap = f.func('int typer_key_tap(void *ctx, const uint16_t *vks, int n)');
    this._key_press = f.func('int typer_key_press(void *ctx, const uint16_t *vks, int n)');
    this._key_release = f.func('int typer_key_release(void *ctx, const uint16_t *vks, int n)');
    this._copy = f.func('int typer_copy(void *ctx)');
    this._paste = f.func('int typer_paste(void *ctx)');
    this._paste_text = f.func('int typer_paste_text(void *ctx, const char *utf8)');
    this._session_begin = f.func('int typer_session_begin(void *ctx, int mode)');
    this._feed_partial = f.func('int typer_feed_partial(void *ctx, const char *utf8)');
    this._feed_final = f.func('int typer_feed_final(void *ctx, const char *utf8)');
    this._session_end = f.func('int typer_session_end(void *ctx)');
    this._session_abort = f.func('int typer_session_abort(void *ctx)');
    this._set_log_cb = f.func(
      'void typer_set_log_callback(typer_log_cb *cb, void *user)');
    this._logCb = null;
    this._retiredLogCbs = [];
    this._errorCb = null;
    this._shutdownPromise = null;
    this.ctx = null;
    this.caps = null;
  }

  version() { return this._version(); }
  strerror(rc) { return this._strerror(rc); }

  /** 注册库内部日志回调（队列/IME 守卫等，异步线程触发）；cb(level, msg) */
  setLogCallback(cb) {
    if (this._logCb) {
      // native 可能已经取得旧回调快照；线程退出前保持 trampoline 存活。
      this._retiredLogCbs.push(this._logCb);
      this._logCb = null;
    }
    if (cb) {
      this._logCb = koffi.register((user, level, msg) => cb(level, msg),
        koffi.pointer(typer_log_cb));
    }
    this._set_log_cb(this._logCb, null);
  }

  /** 能力探测（无需 ctx，可在 init 前调用；结果进程内缓存）。返回 caps
   *  对象（字段见文件头【能力探测结果字段】）。失败抛异常。 */
  probe() {
    // koffi 2.16：koffi.alloc(type, count) 分配；encode 初始化；decode 读回
    const ptr = koffi.alloc(typer_caps_t, 1);
    try {
      koffi.encode(ptr, typer_caps_t, {
        size: koffi.sizeof(typer_caps_t),
        session_type: 0, text_typing: 0, increment_typing: 0, whole_phrase_paste: 0,
        ime_guard: 0, input_permitted: 0, has_xdotool: 0, has_xclip: 0,
        has_fcitx_remote: 0, ime_tool_path: '',
      });
      const rc = this._probe(ptr);
      if (rc !== 0) throw new Error(`typer_probe: ${rc} ${this.strerror(rc)}`);
      this.caps = koffi.decode(ptr, typer_caps_t);
      return this.caps;
    } finally { koffi.free(ptr); }
  }

  capsText() {
    const c = this.caps;
    if (!c) return '未探测';
    const sess = { 1: 'Win32', 2: 'macOS', 3: 'X11', 4: 'XWayland', 5: 'Wayland(不支持)' };
    return `会话=${sess[c.session_type] || '?'} 逐字=${c.text_typing} ` +
           `整句粘贴=${c.whole_phrase_paste} 权限=${c.input_permitted ? '允许' : '拒绝'}`;
  }

  /** 创建上下文（拉起常驻打字线程；返回 true 成功）。线程常驻不随会话
   *  退出——多次会话复用，杜绝"第二次会话撞线程退出时序窗口"。
   *  v1.1.0：传完整 config 桥接 error 回调——注入失败时库闩错误，
   *  本绑定转成 'error'(code, message) 事件
   *  （库内部打字线程触发，处理函数勿再调用 typer_* 接口）。 */
  init() {
    if (this._shutdownPromise) throw new Error('typer shutdown is still in progress');
    if (this.ctx) return true;
    if (!this.caps) this.probe();
    const ver = /^(\d+)\.(\d+)/.exec(this.version());
    const hasErrorCallback = ver && (Number(ver[1]) > 1 ||
      (Number(ver[1]) === 1 && Number(ver[2]) >= 1));
    // 1.0.x 严格检查 sizeof，不接受新版尾部。NULL 在所有版本表示默认配置。
    if (!hasErrorCallback) {
      this.ctx = this._create(null);
      return !!this.ctx;
    }
    this._errorCb = koffi.register(
      (user, code) => { if (!this._shutdownPromise) this.emit('error', code, this.strerror(code)); },
      koffi.pointer(typer_error_cb));
    let cfg = null;
    try {
      cfg = koffi.alloc(typer_config_t, 1);
      koffi.encode(cfg, typer_config_t, {
        size: koffi.sizeof(typer_config_t),
        drained_cb: null, drained_user: null,
        xkb_bind_delay_ms: 0, xkb_char_interval_ms: 0, xdotool_char_delay_ms: 0,
        xclip_settle_ms: 0, paste_settle_ms: 0, ime_settle_ms: 0,
        proc_timeout_ms: 0, queue_limit: 0,   // 0 = 库内默认（厂商实测验证值）
        error_cb: this._errorCb, error_user: null,
      });
      this.ctx = this._create(cfg);
      return !!this.ctx;
    } finally {
      if (cfg) koffi.free(cfg);
      if (!this.ctx && this._errorCb) {
        koffi.unregister(this._errorCb);
        this._errorCb = null;
      }
    }
  }

  /** 停打字线程并释放：当前项打完、剩余队列丢弃，恢复 IME 后释放。
   *  返回 Promise，必须 await 完成后才退出进程/卸载 DLL。 */
  shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise;
    this.setLogCallback(null);
    const ctx = this.ctx;
    this.ctx = null; // 后续调用不再取得正在销毁的句柄
    this._shutdownPromise = new Promise((resolve, reject) => {
      // Koffi worker 执行 join，JS 事件循环仍可处理 native 在途回调。
      if (ctx) this._destroy.async(ctx, (err) => err ? reject(err) : resolve());
      else resolve();
    }).then(() => {
      for (const cb of this._retiredLogCbs) koffi.unregister(cb);
      this._retiredLogCbs = [];
      if (this._errorCb) koffi.unregister(this._errorCb);
      this._errorCb = null;
      this._shutdownPromise = null;
    });
    return this._shutdownPromise;
  }

  /* ---- 会话层（异步；ASR 流式输出场景；状态机见文件头）---- */

  /** 会话开始（录音开始时调）。Linux 含 IME 守卫 begin：fcitx 输入法激活时
   *  先关闭并等生效（阻塞约 80ms）+ 清上一会话残留。mode 会话内固定，下次
   *  begin 才可改。未 init 就调用返回错误。 */
  sessionBegin(mode = TYPER_MODE.PER_CHAR) { return this._session_begin(this.ctx, mode); }

  /** 中间结果：与上次入队完全相同则自动丢弃（ASR 稳定期重发去重）。
   *  仅 PER_CHAR 模式实际出字。 */
  feedPartial(utf8) { return this._feed_partial(this.ctx, utf8); }

  /** 最终结果：不去重；打完后清增量基准，下一句从头开始（不跨句退格）。
   *  一次录音出多个 final（每句一个）时每个都调它。 */
  feedFinal(utf8) { return this._feed_final(this.ctx, utf8); }

  /** 会话结束（录音结束时调）：只标记 ENDING；队列真正打空、IME 已恢复后
   *  库内部回调 drained（本绑定未桥接该回调）。 */
  sessionEnd() { return this._session_end(this.ctx); }

  /** 立即中止：清空未打队列 + 立即恢复 IME + 回 IDLE。出错/取消兜底。 */
  sessionAbort() { return this._session_abort(this.ctx); }

  /* ---- 无状态原语（同步注入真实输入，作用于当前焦点窗口）---- */

  /** 整段文本逐字注入当前焦点窗口（同步；Linux 有 xdotool 时走子进程，
   *  否则回退 Xkb）。不需要会话。 */
  typeText(utf8) { return this._type_text(this.ctx, utf8); }

  /** 退格删字符：count 次 Backspace（作用于焦点窗口，谨慎使用） */
  backspace(count = 1) { return this._backspace(this.ctx, count); }

  /** 回车：count 次 Enter */
  enter(count = 1) { return this._enter(this.ctx, count); }

  /** 组合键点按：vks 为 Windows VK 码数组（如 [0x11,0x43]=Ctrl+C），
   *  全按下 + 逆序抬起。任一键码无法映射则整体不发、返回 -1。 */
  keyTap(vks) { return this._keys(this._key_tap, vks); }

  /** 按下不抬（配合 keyRelease 实现"按住修饰键"用法） */
  keyPress(vks) { return this._keys(this._key_press, vks); }

  /** 抬起（与 keyPress 配对；顺序由调用方保证） */
  keyRelease(vks) { return this._keys(this._key_release, vks); }

  /** 触发复制快捷键（Win/Linux=Ctrl+C，mac=Cmd+C） */
  copy() { return this._copy(this.ctx); }

  /** 触发粘贴快捷键（Win/Linux=Ctrl+V，mac=Cmd+V）；带内容的整句粘贴用
   *  pasteText——设系统剪贴板 → 等生效 → 发粘贴键（会覆盖用户剪贴板） */
  paste() { return this._paste(this.ctx); }

  /** 整句粘贴：设剪贴板→等生效→发粘贴键。会覆盖用户剪贴板（文档化语义） */
  pasteText(utf8) { return this._paste_text(this.ctx, utf8); }

  /** VK 数组 → uint16 LE Buffer（keyTap/keyPress/keyRelease 共用） */
  _keys(fn, vks) {
    if (!Array.isArray(vks) || vks.length === 0) return -1; // TYPER_ERR.INVALID_ARG
    const buf = Buffer.allocUnsafe(vks.length * 2);
    for (let i = 0; i < vks.length; ++i) buf.writeUInt16LE(vks[i] & 0xffff, i * 2);
    return fn(this.ctx, buf, vks.length);
  }
}

module.exports = { Typer, TYPER_MODE, TYPER_ERR };
