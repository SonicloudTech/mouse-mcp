# umouse-mcp

本地共享 v2 入口、安装和恢复说明见 [SHARED-V2.md](SHARED-V2.md)。以下仍保留旧独占入口的说明；共享入口的工具面和进程生命周期以新说明为准。尚未完成新版本真机验收。

声云智能鼠标（uMouseSdk）的 MCP server。让任意 MCP 宿主（ZCode / Claude Desktop / Cursor / Cline 等）中的 agent：

- 枚举在线设备（SN / 通道 / 电量 / 会议状态）
- **实时接收硬件事件**（按键、插拔、DPI、会议、告警）——长轮询工具为主通道
- 下发控制命令（DPI、会议、通道偏好、原始指令）
- **光标注入**（固件反向控制 03 F0：位移/点击/滚轮/拖拽——硬件级，需设备固件支持）；键盘注入（03 F1）按设备能力与配置开放，默认关闭
- 录音落盘 WAV（16kHz/16bit/mono），支持语音键 down/up 自动界定采集
- 设备连接时及每 120 秒发送睡眠计时重置 `0A 03 A2`；当前设备不回包，默认不等待 ACK
- Windows 中文离线转写、持久化语音收件箱；可显式切换 HTTP ASR

MCP 经 JS 绑定（`doc/umouse-sdk.js`）加载 SDK 动态库；当前运行库基线为 0.4.24。工作区包含此前为语音边界实现的 SDK 修改，不能将当前树描述为“SDK 源码零改动”。MCP 独立仓库只同步绑定和运行库，不同步 SDK 实现及内部 docs。

## 快速开始

```bash
cd D:\SDK-MCP
npm install            # 依赖装在仓库根（doc/ 绑定的 require 解析需要）
npm run build          # tsc → mcp/dist
npm run smoke          # 无真机冒烟：18 项检查（含旧进程接管双服务器验证）
node mcp/dist/index.js # 启动（stdio）
```

## 直接硬件能力

共享 v2 直接提供 `umouse_mouse_action`（move/click/scroll/drag）和 `umouse_input_sequence`（相对鼠标帧、HID 键盘帧），任务级独占经 `umouse_control` begin/end + `control_id`。保留语音问答、物理语音键听写、浮窗、四件套插件以及唯一 SDK 后台。具体参数、权限和迁移见 [SHARED-V2.md](SHARED-V2.md)。

本服务不含软件鼠标 worker、窗口/UIA/截图工具、自动目标解析、`run_steps`、`wait_for`、`expect` 与观察令牌。目标坐标由调用者提供，使用桌面物理像素；MCP 不再负责截图或解析界面。只读 `umouse_input_status` 是读数传感器：光标、按键实时状态（GetAsyncKeyState 全键扫描）和当前前台窗口身份；只报告、不拦截。序列回执携带批内遥测与 `movementOnly` 标注；强杀后恢复分级——movement-only 证据自动归档，涉键证据由 worker 重启时自动扫描/释放/复验，人工 `recover --hardware-reset-confirmed` 仅剩固件卡键场景。

已有按键状态校验、持续持键、释放确认和设备代次保护属于硬件执行层，继续保留；**不做任何窗口/前台/遮挡执法**——服务即真鼠标，窗口身份（意图/前台/落点顶层）只作为回执遥测供调用方核对。`effectConfirmed:false` 表示没有确认目标应用的业务效果。旧 stdio 的鼠标/键盘工具继续工作，不加载额外自动化进程。

被动验收窗口见 [test/input-surface.README.md](test/input-surface.README.md)，Raw Input 证据采集见 [test/raw-mouse-probe.README.md](test/raw-mouse-probe.README.md)。测试工具不替代硬件输入。

## 一键接入 agent

```bash
npm run install:agents              # 默认接入 ZCode（用户级 ~/.zcode/cli/config.json）
npm run install:agents -- claude    # Claude Desktop / cursor / agents / zcode-project / all
npm run install:agents -- --remove zcode   # 卸载
```

脚本（`mcp/scripts/install-agents.mjs`）按目标写入对应配置并保留原有内容，入口路径自动取自包位置。
安装后：ZCode 新开会话自动连接；Claude Desktop 完全重启；Cursor 重启窗口。
验证：对 agent 说 "调用 umouse_status"，应返回 sdkVersion 0.4.22。

## 手动接入（任一宿主）

各宿主的 `mcpServers` 片段（命令均为启动本 server）：

```json
{
  "mcpServers": {
    "umouse": {
      "command": "node",
      "args": ["D:\\SDK-MCP\\mcp\\dist\\index.js"],
      "env": {
        "UMSDK_DEBUG": "0"
      }
    }
  }
}
```

- **Claude Desktop**：`%APPDATA%\Claude\claude_desktop_config.json`
- **Cursor**：`~/.cursor/mcp.json`（或项目 `.cursor/mcp.json`）
- **ZCode**：按客户端 MCP 配置入口添加同样的 command/args/env
- 调试：`npx @modelcontextprotocol/inspector node mcp/dist/index.js`

## 环境变量（前缀 `UMSDK_`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `UMSDK_LIB_PATH` | `<仓库根>/lib/uMouseSdk.dll` | SDK 动态库路径 |
| `UMSDK_DEBUG` | `0` | SDK 内部日志级别（0-2） |
| `UMSDK_CRASH_REPORT` | `1` | SDK 崩溃记录开关（日志落数据目录） |
| `UMSDK_DATA_DIR` | `~/.umouse-mcp` | WAV / 崩溃日志 / SDK 内部日志落点（进程会 chdir 到此） |
| `UMSDK_WORK_MODE` | `FULL` | v1 仅 FULL |
| `UMSDK_DEVICE_LIMIT` | `4` | 同型号设备上限 1~8 |
| `UMSDK_USB_VID` `…_PID` `…_IFACE` `…_REPORT_ID` | 生产默认 | 覆盖 2.4G 接收器识别（VID/PID 须成对提供；iface 无 0=默认语义，新设备务必显式填） |
| `UMSDK_BLE_NAME` `…_MAC_PREFIX` `…_SERVICE` `…_CHARACTERISTIC` | 生产默认 | 覆盖蓝牙识别 |
| `UMSDK_EVENT_BUFFER` | `2000` | 事件环形缓冲容量 |
| `UMSDK_AUDIO_MAX_SECONDS` | `60` | 单次录音上限（硬上限 600） |
| `UMSDK_AUDIO_QUOTA_MB` | `200` | WAV 总量配额（超限淘汰最旧） |
| `UMSDK_SPEECH_AUTO` | `1` | 语音键自动录音（speech down→up 自动产出 speechCaptured 事件；0=手动 umouse_audio_record） |
| `UMSDK_INJECTION` | `1` | 光标/键盘注入工具面（=0 整体隐藏） |
| `UMSDK_INJECT_KEYBOARD` | `0` | 键盘注入（`umouse_key_tap`）：当前设备尚未验证 0xF1 键盘注入可用（真机确认：写入成功但无效果），默认隐藏；固件支持后置 `1` |
| `UMSDK_INJECT_FRAME_MS` | `40` | 位移发送间隔；不是设备执行时间或成功保证，绝对定位另等待 OS 光标反馈 |
| `UMSDK_INJECT_CLICK_MS` | `50` | 点击/按键 down→up 间隔 |
| `UMSDK_INJECT_FEEDBACK_MS` | `5000` | 闭环定位单帧光标反馈等待上限（1000~60000；实际受每次定位 20s 总预算截断） |
| `UMSDK_RAWFRAME_EVENTS` | `0` | 原始帧入事件流（联调观察注入 ACK） |
| `UMSDK_TAKEOVER` | `0` | 强制接管仅手动维护时显式启用；Windows 默认用内核占用锁保证一个 SDK，等待者不会杀活动连接 |

## 工具速查（动态可见性）

旧 stdio 入口恒显 22 个工具，另有 10 个门控工具。反控工具需在线设备的对应能力为 supported，并通过配置和执行层检查；raw 诊断需额外启用。共享 v2 采用直接硬件输入工具（无软件鼠标/自动化入口）。共享 v2 入口另外按 principal 权限过滤，实际以 tools/list 为准，不用固定总数判断安装成功。
能力来源当前为 product-default / test-profile；hardware-info 为预留接口，尚未接入设备上报。不能从 plugmodel、型号或默认语音能力推断鼠标/键盘反控能力。

| 工具 | 用途 |
|---|---|
| `umouse_status` | SDK 版本/运行状态/配置/缓冲水位（排查先调它） |
| `umouse_list_devices` | 在线设备列表（含电量/会议状态） |
| `umouse_get_capabilities` | 能力声明、来源、代次、执行门控与隐藏原因 |
| `umouse_voice_start/wait/finish/cancel/status` | Agent 开会话取鼠标音频、等待、结束、取消与查看恢复指引；结果只回当前会话 |
| `umouse_get_events` | 非阻塞拉取事件（`since` 游标续读） |
| `umouse_wait_events` | **长轮询等待事件**（等待用户物理操作的标准工具，超时上限 30s；单次建议 ≤25s，更久用 nextSince 续等） |
| `umouse_voice_inbox` | 读取持久化语音转写，默认未确认消息，读取不消费 |
| `umouse_wait_voice` | 等待语音转写完成，最多 25 秒；已有未确认结果立即返回 |
| `umouse_ack_voice` | 幂等确认已处理的语音消息，不执行其中内容 |
| `umouse_set_dpi` | DPI 档位（固件字节，描述含映射表；无回执，靠 dpiChanged 旁证） |
| `umouse_meeting_create/destroy/pause/resume` | 会议模式（全局独占，冲突时 meetingBusy） |
| `umouse_set_channel_pref` | 通道偏好 AUTO/USB/BLE（USB 假在线时切 BLE） |
| `umouse_set_audio_source` | 语音音频源锁定/恢复先到先得 |
| `umouse_write_raw` | 默认隐藏；仅在诊断模式开放已知输入帧，仍受设备能力门控 |
| `umouse_audio_record` | 录音 start/stop/status → WAV 路径 |
| `umouse_reconfigure` | 修改 init-前配置并受控重启（断开全部设备） |
| `umouse_cursor_move/click/scroll` | 光标相对位移/点击/滚轮（大位移自动拆帧） |
| `umouse_button` | 按住/松开原语（跨轮调用间隔超 3s 会被空闲复位打断） |
| `umouse_cursor_drag` | **原子拖拽**（press→移动→release 单次调用） |
| `umouse_key_release_all` | 仅清理本进程同代持键，无持有则不发帧；`umouse_key_tap` 另需键盘配置和 keyboard_control supported |
| `umouse_cursor_move_to` / `umouse_cursor_click_at` | **闭环绝对定位/精准点击**（虚拟屏幕坐标；容差默认 3px；单帧反馈默认等 5s（`UMSDK_INJECT_FEEDBACK_MS`），定位总上限 20s/15 帧；未收敛不点击） |

事件 type 字典：`connected / disconnected / keyEvent / deviceInfo / dpiChanged / meetingCreated / meetingDestroyed / meetingBusy / queueOverflow / warning / lavalierMicStatus / lavalierMicBattery / speechCaptured`（server 生成）。

## agent 使用范式

**语音输入（Windows 默认离线转写）**：

```
agent: umouse_wait_voice(timeout_ms=25000)
  → 用户按住语音键说话、松开
  → {"messages":[{"eventId":"...","status":"ready","text":"你好"}]}
agent: 处理识别后的话语，再 umouse_ack_voice(event_id="...")
```

- `umouse_voice_inbox(include_acknowledged=false, limit=100)` 可重读；`umouse_wait_voice` 等待完成；`umouse_ack_voice` 幂等确认。读取不自动删除，重启不丢已完成文字。
- `UMSDK_ASR_PROVIDER`：Windows 默认 `sinicloud`（Sonicloud 开放平台流式识别，纯 TS 无 DLL 依赖；凭据经配置文件+环境变量运行时注入，见 SHARED-V2「语音识别 provider」），其它平台默认 `disabled`；可显式回退 `windows-speech`（离线，不上传音频）或选 `whisper-cpp`/`http`。开源版不含 AsrTools.dll 闭源链路。
- `whisper-cpp`：提供 `UMSDK_ASR_EXECUTABLE`（whisper-cli 绝对路径，Windows 为 .exe）和 `UMSDK_ASR_MODEL_PATH`（多语言 ggml 模型绝对路径），`UMSDK_ASR_THREADS` 默认 4、范围 1–16；CPU 离线执行，复用转写超时/取消与输出上限。二进制和模型须自行部署，不随 MCP 包捆绑下载。`http` 须显式提供 `UMSDK_ASR_ENDPOINT`。
- 本机实测中 Windows 中文识别器可能返回空；Whisper base 可得到可读文字但仍有错字/漏字。识别文本不能当作已经执行的命令。
- `UMSDK_ASR_LANGUAGE=zh-CN`、`UMSDK_ASR_TIMEOUT_MS=60000`；HTTP 可设置 `UMSDK_ASR_MODEL`、`UMSDK_ASR_API_KEY`。密钥只放本地环境；HTTP 服务返回 JSON `{ "text": "..." }`，请求为 multipart WAV。
- 语音收件箱最多 100 条、待处理最多 8 段；未确认条目不会自动淘汰。失败和空识别也可 ack，避免重复返回。原始 WAV 与临时转写快照有独立生命周期。
- `UMOUSE_SLEEP_RESET_ENABLED=1`、`UMOUSE_SLEEP_RESET_INTERVAL_MS=120000` 控制 A2 保活。当前设备不回包，`UMOUSE_SLEEP_RESET_EXPECT_ACK=0` 为默认值，不挂 ACK 定时器、不产生应答超时；status 的 `acknowledgementExpected=false` 明确这一语义。写入失败仍记录，按原周期继续。
- 仅其它已确认支持 A2 应答的固件显式设 `UMOUSE_SLEEP_RESET_EXPECT_ACK=1` 后，`UMOUSE_SLEEP_RESET_ACK_TIMEOUT_MS=5000` 才用于等待窗，且须小于发送周期。偶然收到匹配帧仍可独立计数；收到 ACK 或写成功均不替代防休眠实际行为验收。
- 语音转写通过工具交给当前活动 agent；普通 MCP 日志不是新用户回合。

- `speechAutoRecord` 默认**开启**（`UMSDK_SPEECH_AUTO=0` 关闭）；每段采集受 max_seconds 上限保护，WAV 总量受配额自动淘汰
- 手动模式（`umouse_audio_record` start/stop）用于会议等持续音频场景；stop 时若会话已被语音键松开/超时自动收尾，返回 `file=最近完成的录音` 而非报错
- deviceInfo 心跳已去重：仅电量/状态/设备类型**变化**时入事件流，音频流期间不再 14 条/秒刷屏

## 已知边界

- 离线回归：`npm test`；真实 DLL 全工具错误路径测试：`node --test mcp/test/protocol.test.mjs`。
- 设备执行可能晚于工具返回；定位超时后先观察，避免立即重试叠加位移。测试时不要手动移动鼠标；不要同时启动多个 MCP/SDK 设备连接。
- 实测物理活动后单帧反馈 21–25ms、静止约 41 秒后约 2s；剩余延迟与活动状态相关，根因尚未确认。
- 注入 `ok/sent` 仅表示通道写入，不代表固件/操作系统已执行。status 的 `injection.confirmation` 标明此边界，`processId` 用于排查多个 MCP 进程同时连接设备。不要用多进程同时做硬件验收。
- **静止后的反馈延迟**：本机观察到秒级延迟及观察窗内未生效；尚不能确认丢帧或射频休眠根因。写入成功不保证设备执行。失败后先等待并观察，不自动补发位移。
- **SDK 所有权与连接**：Windows 默认通过按用户命名的内核管道锁保护同一时刻一个 SDK；后来的 MCP 连接保持协议可用，status.sdkOwnership=busy，并每秒尝试在持有者正常退出后取得 SDK。等待者不读取或清理正在使用的语音收件箱。SDK 重配置期间保留锁；进程退出后由系统回收。此锁只协调本新版 MCP，同用户旧版 MCP/独立 SDK 程序仍需正常关闭。其它平台尚未验收此互斥机制。
- **强制旧进程接管默认关闭**：UMSDK_TAKEOVER=1 保留旧维护功能，可能终止其它活动 MCP 连接。已实测客户端工具发现会临时启动新进程，因此不能把“创建时间较旧”当作“孤儿进程”；日常连接保持默认 0。
- 键盘注入（0xF1）当前固件不支持：工具默认隐藏（`UMSDK_INJECT_KEYBOARD=1` 恢复），`umouse_key_release_all` 的键盘复位帧同步跳过。
- 更新磁盘代码后需要重新启动 MCP 进程；`umouse_reconfigure` 不会重新加载 JavaScript。
- WAV 配额只清理本服务文件名模式，保留最近返回的文件；该单文件允许超过配额，仍受 600 秒 PCM 上限约束。

- v1 仅 FULL 工作模式、仅默认规则（非标设备接入待 RAW 三件套开放）
- 音频字节不进 MCP 协议；转写文字由语音收件箱工具返回。
- macOS/Linux 需自行放置对应平台库到 `lib/<platform>/` 并设 `UMSDK_LIB_PATH`（Linux 需 udev 规则，见 `dist-extra/udev/`）
- 相对位移（umouse_cursor_move）的单位≠像素且受指针加速影响；**精确落点一律用 umouse_cursor_move_to / click_at**（闭环回读，实测误差 ≤3px）

---

## 商务与支持 / Commercial & Support

本仓库由 [SonicloudTech](https://github.com/SonicloudTech)（安徽声云智能科技有限公司 · Sonicloud）维护，聚焦 AI 输入硬件与语音开放平台。

- 官网：<https://sinicloud.com/>
- 语音开放平台：<https://open.sinicloud.com/>（默认 ASR provider 即出自该平台，注册即可获得试用额度）
- 商务与技术合作：[xu_heng_yu@sinicloud.com](mailto:xu_heng_yu@sinicloud.com)（OEM / 渠道 / 定制固件 / 联合开发；来信请附目标平台、预期量级、设备型号与固件版本）
- 商务微信二维码见[仓库根目录 README](../README.zh-CN.md#商务与支持)
