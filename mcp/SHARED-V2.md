# 本机共享 v2：安装与维护

本地开发版本，Windows x64、同一 Windows 用户和交互登录会话。硬件验收尚未完成。
旧 `mcp/dist/index.js` 入口保留；以下流程安装共享入口，不自动修改任何 Agent 配置。

## 构建与安装

依赖 Node.js 22、Windows PowerShell/CIM、本地 C++ 产物。源码构建还需要 VS 2022、CMake、公开 SDK 头文件；打包需要已构建的 voice UI。

```powershell
npm run build:sdk-host:test
npm run test:shared
npm run package:shared
```

打包结果位于 `release/umouse-shared-v2-<version>-<timestamp>`，每次创建新目录。四个适配器为独立 DLL；外部 SDK DLL 和清单独立校验。打包不启动 SDK。
TypeScript 直接编译到新包，开发目录 dist 中的孤儿文件不会被复制。包索引要求 `hardwareApiVersion=1`，哈希覆盖原生宿主、适配器、运行库、语音 UI 与脚本。校验提供文件一致性检查，不是软件签名或同用户攻击防护。
当前没有 screenTool.dll，screen 插件会明确不可用；其余已具备的插件可独立工作。包内附 SDK JS 绑定、运行库、voice UI、生产 Node 依赖和许可证，不包含 SDK 实现或内部 docs。

安装使用新的、专用的私有目录。以下为参数示例，请替换路径，不要对项目根目录或个人资料目录执行 init。

```powershell
node <bundle>/mcp/dist/shared/manage.js init C:/Users/me/.umouse-mcp-shared-v2 <absolute-bundle> agent_one
node <bundle>/mcp/dist/shared/manage.js config C:/Users/me/.umouse-mcp-shared-v2 agent_one
```

`init` 设置当前用户和 SYSTEM 的目录 ACL，生成随机客户端凭据、单独管理凭据、版本化插件清单和 service.json；不启动 SDK。
优先使用用户主目录下的专用目录。MSIX 客户端可能把 AppData/Local 写入重定向到包缓存，独立 WMI 进程无法按原别名找到它。安装器现在保存 `realpath` 解析后的包、状态、清单和客户端配置路径，启动器在跨进程前再次解析现存文件；不会通过放宽 ACL 或继承宿主 Job 来规避。请使用 init/config 输出的实际路径。旧版已创建的重定向配置不能仅凭重连宣称迁移成功，需先核对其数据和安全标记，再在维护窗口迁移。
`config` 输出通用 stdio 配置，密钥保留在私有客户端文件中，不打印。只将配置应用到原 umouse 条目。每个宿主用独立 client-id，通过同一安装目录配对。
不要为第二个宿主另建一份安装目录；重复安装不会产生第二个 SDK，但独立凭据不能互认。

stdio 入口自动启动共享监听。需要直接连接 Streamable HTTP 时，先运行 `manage start <state-dir>`，再连接 `http://127.0.0.1:47192/mcp`，使用所属客户端 JSON 中的 token 作为 Bearer。请通过宿主的密钥设置导入，不写入日志或命令行；不复用 admin.json 的密钥。

本地 WMI 将 C++ 启动器创建在宿主 Job 之外，再由启动器的 Job 管理共享进程树。WMI/PowerShell 被企业策略禁用时，明确报错，不悄悄退回到会被宿主关闭的后台进程。不注册登录自启，不提升权限。服务生命周期完全由客户端连接驱动：connector 连不上（管道 ENOENT）时经 WMI 拉起，客户端崩溃/退出后由下一次连接或工具调用重新拉起。
`start` 只启动监听；初始化完成的 MCP 连接才计 N。N≥1 时唯一 SDK 进程启动。N=0 走两段式空闲（同一条从归零起算的时间线）：持续 `UMSDK_IDLE_WORKER_MS`（默认 60s，设 0 恢复立即回收的旧语义）后回收 SDK worker——设备释放、DLL 卸载，监听继续；持续 `UMSDK_IDLE_EXIT_MS`（默认 5min，设 0 恢复常驻旧语义）后 daemon 自退，管道消失，下一个客户端 connector 自动重新拉起。两值均须为 0 或合法区间整数，且自退时长必须大于 worker 宽限。宽限窗口内的重连不打断 worker：客户端重启/会话切换不再触发 DLL 重载与设备重连。维护标记存在或维护态时不自退；自退前须 worker 已收净、无握手中的连接、无在途管理请求，否则按 15s 复查直至满足。空闲转换（arm/workerRetire/exit）记录到 daemon 诊断 trace。

## 命令

统一形式：`node <bundle>/mcp/dist/shared/manage.js <command> <absolute-state-dir> [value] [flags]`。

| command | value / 行为 |
|---|---|
| init | `<absolute-bundle> [client-id]`，创建新安装；默认 client-id 为 agent |
| config | `<client-id>`，仅输出配置，不应用 |
| start / status | 启动监听 / 查看状态，不建立 MCP 会话，不触发 SDK |
| pair / rotate / revoke | `<client-id>`，配对 / 轮换 / 撤销；轮换保留原权限 |
| reload-clients | 凭据写入成功但在线刷新未确认时，显式重试准入刷新 |
| capabilities | `<absolute-profile.json>`，录入硬件能力，见下文 |
| stop | 进入维护并停止监听；保留维护标记 |
| resume | 解除安装维护；不清除输入未知/SDK 异常标记，不自动启动 |
| upgrade | `<absolute-new-bundle>`，验证完整包，切换版本清单与入口，保留原版本 |
| rollback | 校验原包后恢复上一份清单和环境；保留数据与交付账本 |
| bind-session | 同一用户重新登录后更新 Windows session；先停止旧实例 |
| recover | 必须带 `--hardware-reset-confirmed`，见恢复流程 |
| uninstall | 停后台并移除普通客户端准入，保留数据、凭据备份和维护标记；不删除宿主配置或用户数据 |

配对、轮换、撤销在线刷新：只有凭据或权限改变的 principal 的连接会注销，其他客户端和 SDK 保持。刷新未确认时命令报错并保留待刷新标记，必须用 reload-clients 重试，不能把报错当作撤销成功。
其他配置修改、升级和恢复采用维护窗口：有有效连接时默认拒绝；只有显式 `--disconnect` 才关闭现有连接。不会暗中逐个强杀宿主进程。单个宿主只是断开/移除自身入口时，其余客户端继续工作。
失败的维护事务留下 maintenance.json，防止半更新时自动启动。修正问题后重试原命令；若确认不继续该变更可用 resume。不要删除 SDK/input 安全标记来“解决启动失败”。

硬件能力文件示例：

```json
{"exact-device-id":{"mouse_control":"supported","keyboard_control":"unsupported"}}
```

只接受精确设备 ID；能力值为 supported/unsupported/unknown。默认语音存在、鼠标/键盘反控 unknown。键鼠工具固定展示给启用 `UMSDK_INJECTION` 且具备 `input.control` 权限的连接，纯语音设备的输入请求仍会在执行前拒绝。配置是管理者确认的能力或显式测试授权，不能冒充 SDK 自动检测或物理效果已通过。

### 当前工具与参数

完整授权连接最多提供 10 个工具：`umouse_status`、`umouse_list_devices`（含每台设备 mouse_control / keyboard_control 能力画像）、`umouse_input_status`、`umouse_control`、`umouse_mouse_action`、`umouse_input_sequence`、`umouse_voice_start/wait/finish/cancel/status`。权限分别为设备只读 `device.read`、硬件输入 `input.control`、语音 `voice`；总状态始终可见。

`umouse_input_status` 是只读读数传感器：光标物理坐标、**按键实时状态**（鼠标左右中/侧键与修饰键，GetAsyncKeyState 全键扫描，硬件注入与物理输入同样可见）、前台窗口 pid/windowId/矩形，以及输入保护与任务控制状态。闭环移动、效果复核、无卡键验证都用它；只报告、不据此拦截任何指令。

`umouse_mouse_action` 一次执行一个完整硬件鼠标动作，`action.kind` 为 `move/click/scroll/drag`。坐标 `x/y` 是桌面物理像素；click 的 `count=1..3`，`button=left/right/middle`；scroll 的 `direction=up/down,amount=1..10`；drag 从 `x/y` 到 `toX/toY`；可选 `precision:"standard"|"high"`（默认 standard）。无需截图、UIA、capture_id 或 worker。按键校验、连续持键和释放确认仍由 C++ 完成。

闭环定位按**增益曲线**工作（协议位移→像素的比值随命令幅度变化，即 Windows 指针弹道；详见 `sdk-host/POSITIONING.md`）：11 个幅度桶按设备在线学习，首次使用某设备时按本机指针设置（只读查询）播种——EPP 关为平坦曲线、EPP 开为实测弹道形状×灵敏度档位乘数，因此**跨电脑、跨设备均自适应**，种子失配只多花 1-2 帧不会不收敛；学习限幅 0.125~10.0，闲置 60s 向种子半衰。落点容差：standard 残差 ≤4px 即停；high 档继续向 1px 修正（小帧增益 <1 使 3 counts ≈ 2px），带预测闸门与停滞守卫，**绝不比 standard 更差**（失败模式相同，最坏退化为 best-effort ≤4px，残差如实上报）。一/两 count 微修正帧固件不执行也不上报，最小修正量 3 counts；小帧反馈等待上限 300ms，超限按 `position_below_device_resolution` 快速失败而非耗尽反馈预算。

```json
{"device_id":"<真实 SN>","client_request_id":"<唯一逻辑请求ID>","action":{"kind":"move","x":960,"y":540,"precision":"high"},"timeout_ms":20000}
```

硬件鼠标能力的完整验收套件（真实网页实验室 + 面向大模型的用例目录 + 全自动矩阵脚本）随包发布在 `mcp/acceptance/`，入口为其 `README.md`；接入方应先跑通该套件再开展业务自动化。

`umouse_input_sequence` 直接提供相对鼠标和键盘序列。参数为精确 `device_id`、`client_request_id`、`frames` 及可选 `pid/window_id`。每帧 `kind=mouse/keyboard`，`delay_ms=20..100`（默认30）；鼠标 `buttons=0..7`、`dx/dy/wheel=-127..127`，键盘 `modifiers=0..255`、`keys=4..231` 且最多6个不重复。最多128帧，总预算最多20秒；帧间延时之和须小于预算。全部参数预检后执行，末尾发送释放。按下不能跨调用保持。仅键盘设备也能使用；须 `UMSDK_INJECT_KEYBOARD=1` 且设备声明 `keyboard_control=supported`。回执携带 `telemetry`（批前/批后按键态、USB 绑定成功时的 Raw Input 按放边沿计数——只报告、不拦截）与 `movementOnly` 标注：纯移动批次（全部帧 buttons=0 且无键盘键位）回执带 `movementNote`，其持久证据归类为可自动清除，不参与按键隔离。

两个输入工具均可同时指定 `pid` 和十进制字符串 `window_id`；只给一个会拒绝。**二者仅为回执意图标注，不做任何窗口执法**——服务像一只真鼠标：坐标可在整个桌面坐标系自由移动（含多屏与负坐标），可以点任务栏、桌面或任何窗口，不要求目标在前台、不检查遮挡、不因窗口变化中断。焦点、Z 序与命中由操作系统决定；回执的 `windowContext` 报告意图标注、执行时前台与落点顶层窗口（`topmostAtPress`/`topmostAtFinal`），供调用方核对是否点中了预期目标。`umouse_input_status` 随时可读光标、按键实时状态与前台身份；该查询不枚举窗口、不截图、不读取 UIA。设备代次变化仍然立即停止（那是鼠标的同一性，不是窗口警务）。

工具目录按权限固定展示，不等待设备启动，不随离线状态隐藏；执行仍受设备能力、输入总开关、设备代次、桌面租约及未知输入保护约束——**不含任何窗口/前台/遮挡限制**（服务即真鼠标，窗口身份只进回执）。`tools.listChanged=false`。移除旧工具后需要宿主重新获取目录，旧请求不翻译为新动作、不自动重放。

“序列”指一次连续执行多帧；协议帧序列号只用于核对应答，SN 是设备序列号。写入、ACK、Windows 输入反馈、目标应用效果是不同证据层级。

`umouse_status.availableInputTools` 只表示当前连接已注册的输入入口；`inputCapabilitiesReady` 表示当前runtime的鼠标/序列能力是否就绪，不证明目标设备、窗口、资源或安全状态已满足本次执行条件。`toolDiscovery.mode=static`、`lastWaitMs=0`，`lastTools` 和 `requests` 记录宿主实际获取工具列表的情况。SDK状态变化无需刷新列表，但升级工具定义或修改权限后仍须宿主重新加载MCP。旧动态版本升级为静态版本时，协商能力发生变化，旧connector会保守要求重建连接；不能承诺已缓存的旧会话热更新。

执行前确认目标位置和前台应用；需要绑定明确窗口时先读取 `umouse_input_status`。每帧校验窗口、设备代次；鼠标还检查当前光标属于目标窗口。共享桌面仲裁、幂等请求、断线取消和清理屏障由鼠标、键盘和语音打字共用。末尾和失败时只向原设备代次释放；不自动重试未知效果。`effectConfirmed:false` 始终提醒：传输成功不等于按钮/滚轮/落字生效，必须结合目标窗口事件验收。该入口没有任意raw写入或软件输入替代。

### 语音识别 provider（UMSDK_ASR_PROVIDER）

| 取值 | 说明 |
|---|---|
| `sinicloud` | Sonicloud 开放平台流式（纯 TS，无 DLL 依赖）：凭据文件+环境变量运行时注入，**每会话热读，换 key 不重启**；开源版 Windows 默认 |
| `disabled` / `windows-speech` / `whisper-cpp` / `http` | 旧批处理与开关选项 |

`sinicloud` 配置：JSON 文件默认 `<数据目录>/sinicloud_asr.json`（路径可用 `UMSDK_ASR_SINICLOUD_CONFIG` 指定），字段 `appId / apiKey / apiSecret / userId / lanid / streamUrl / tokenUrl`；环境变量 `UMSDK_ASR_APP_ID / UMSDK_ASR_API_KEY / UMSDK_ASR_API_SECRET / UMSDK_ASR_USER_ID / UMSDK_ASR_LANID / UMSDK_ASR_ENDPOINT(流式) / UMSDK_ASR_TOKEN_URL` 覆盖文件值。凭据只经该通道注入：不打印、不入日志、不入仓库；token（md5 签名换发，2 小时有效）进程内缓存并临期刷新，鉴权失败自动换 token 重连一次。协议实测：连接 URL 以**头名作查询参数**拼接（`X-SC-Authorization / X-SC-User-Id / lanid`）；`errCode=1000` 确认后按 ≥81B、~100ms 推 16k/16bit/mono PCM；结束发文本帧 `"end"`；识别文字一律在 `result` 字段——`errCode=1/2/3` 为累积中间结果（作 preview），`errCode=10` 收尾帧携带**最终全文**（静音时为空）后服务端关闭连接，据此取终稿并判 FINISHED；`errCode` 与 `Begin/End` 可能为字符串，一律 Number() 归一化。所有错误映射为 `sinicloud_*` 固定码，不携带凭据、token、URL 或响应体。

## 升级和四件套替换

先制作完整新 bundle，确保 adapter ABI、vendor exports、依赖 DLL 与哈希相符。`upgrade` 会停止旧后台并确认 SDK 退出，然后原子切换 service.json 指向新 bundle 和版本化插件清单；不覆盖仍加载的 DLL。旧宿主 connector 会读取新 bundleRoot，再启动正确的 daemon。
SDK ABI 未变化时可仅更换 vendor DLL；ABI 变化时替换对应适配器并做契约测试，其他三个适配器无需改动。旧包保留供 rollback 使用。不要给已经制成的 bundle 原地换 DLL 或手工改 hash 后宣称完成校验。
版本化 manifest 最多保留 128 份；达到上限时拒绝新的升级/能力配置，不自动删除证据。维护停机后可归档未被 service.json 的 manifest 和 previous.manifest 引用的历史文件；保留当前、上一版本及硬件恢复标记。失败的 JSON 写入会清理未完成的临时文件。

## 整个任务独占控制

调用顺序：`umouse_control {operation:"begin",task_id:"本任务唯一标识"}` → 保存 `control_id` → 每次 `umouse_mouse_action` / `umouse_input_sequence` 都携带此令牌 → 明确结束时调用 `umouse_control {operation:"end",control_id:...}`。`status` 只读；同连接同 task_id 重复 begin 返回原令牌；不同连接或不同 task_id 拒绝，不排队、不抢占。

独占权跨越动作、观察、模型思考间隔，不按动作完成或失败自动释放，也不设置额外任务空闲 TTL。仅在明确 end、有效连接关闭或运行时退出时收尾。end/断线先阻止新动作、取消正在执行的动作、等待原生终态，再释放。旧令牌不能跨重连或 worker 代次使用；原请求仍保持至多执行一次，禁止换 request_id 自动重放失败动作。宿主若长期保持连接却未报告任务结束，控制权会保留，Agent 必须明确 end。

两层互斥分开：`hardware-control` 锁住整个任务的远程键鼠使用权；`desktop` 只覆盖单次实际执行，与语音打字交付互斥。语音采集、预览、ASR 保持独立；语音取消不释放键鼠任务。空闲思考阶段允许用户主动语音打字，不视为其他 Agent 的反控任务。

**普通动作失败不再封禁同一任务或整项功能。** `inputUncertain` / `inputUncertainScopes` 和原生 `inputQuarantine` 保留历史诊断（原生增加 `enforced:false`），`blockedScopes` 为 false。新显式动作前归档旧标记为 `.history-*`，成功只更新本次所涉范围，不抹掉原始失败证据。当前设备、前台窗口、按钮基线、持续持键、释放和回执校验仍然执行；失败不会改为 completed。

如果实际按钮仍按住，常规动作可因当前基线拒绝；同一任务可以显式发送零按钮/零按键帧，再检查状态。序列的 release_written 仍只是写入，不是物理释放证明。新的常规鼠标动作只有在被动反馈基线连续稳定后，才清掉该设备过期的内存持键义务。本版不自动重放移动、点击或拖拽。

## 进程异常恢复（区别于普通动作失败）

以下维护机制仅用于 SDK 进程退出不净、关麦未排空、RPC 失联等进程生命周期异常；普通输入失败在原生已返回终态时不要求 recover 或硬件复位。

1. 用 status 读取状态。SDK 崩溃、关麦未排空、输入效果未知都不能由工具写入成功推导为硬件已停止。
2. 关闭原连接；必要时执行 `stop --disconnect`。保留日志、sdk-running.json、input-uncertain.json 和 delivery 账本。
3. 人工复位硬件，确认旧操作不再到达、无按住残留。然后执行 `recover --hardware-reset-confirmed`。
4. 恢复助手取得同用户 SDK 与旧版兼容锁，重新核对 SDK、共享输入、原生输入隔离及输入在途标记的 SHA-256。任一标记变化则在移动任何文件前拒绝；成功时保存 `.recovered-<pid>` 证据，不初始化 SDK、不发释放帧。原生隔离和在途标记分别为 `native-state/native-input-quarantine.json`、`native-state/input-in-flight.json`。存在新标记时，遗漏相应哈希的旧恢复命令会拒绝。带在途标记的恢复必须使用支持四标记核验的新宿主；不能手工删除该标记代替硬件复位。
5. 通过原连接重新初始化，先观察/检查状态，再开始新的操作。旧 request/session 不跨重连重用，不自动重放未知输入或落字。

`resume` 只处理安装维护；`recover` 才是上述人工硬件复位后的证据归档。不能从软件归档成功声称固件队列已清空。
`faulted`/`stop-blocked` 不会因 resume 自动恢复，也不提供绕过硬件隔离的在线清零。**分级自动恢复**：worker 因强杀等原因残留 `sdk-running.json` 时，daemon 对三份证据文件逐个分级——

- **movement-only**（在途标志 schema v2 声明 `movementOnly:true`，或 uncertain/quarantine 标记所有 scope 记录均声明 `movementOnly:true`）：该批次从未携带按键位，光标读数即真相，最坏触发 hover 效果——随运行标记一起自动归档（`.auto-recovered-*`，保留字节）；
- **按键嫌疑**（涉键批次未到终态、涉键不确定记录、旧格式或不可解析文件）：不拦启动，worker 起来后执行 `input.cleanup`——GetAsyncKeyState 全键扫描 → 至多一次零按钮/零键位释放帧 → 复验；全部抬起才归档证据并清除诊断（原生 journal 归档为 `.released-*`）。仍按下（人为按住或固件卡键）不拦 worker 运行：新动作本就有新鲜基线守卫，物理释放后下一次成功动作或重扫即自愈；
- 人工 `recover --hardware-reset-confirmed` 只剩真正的固件卡键场景（读数证实按键按下且释放帧无效）。

即"空闲强杀后重启进程即恢复；纯移动批次强杀同样直接恢复；涉键批次自动扫描/释放验证"，绝大多数情况无需硬件拔插。5 分钟内连续启动失败超过 3 次、心跳/请求超时或退出不净会锁存故障。高层清理预算为 25 秒；之后 native 正常停止预算 10 秒、额外观察上限 5 秒，管理请求等待 50 秒。
新托管安装共享当前用户目录下 `.umouse-mcp-shared-safety-v2` 中的 SDK/input 安全标记，换安装目录也会保留阻断；卸载不删除此目录。旧预览配置升级时保留其原安全路径，迁移旧预览数据需沿用原标记，不得直接用空目录替代恢复。

## 接入和验收边界

每个逻辑连接独占语音会话和请求 ID 命名空间；正在执行的硬件桌面输入与听写落字共用一份租约，防止同时争抢焦点。完整鼠标动作由 C++ 执行，取消仍等待原生终态和释放。

普通鼠标和键盘动作的失败证据按模块持久保存，不再作为输入准入锁。只有任务控制权可以阻止其他任务使用；实际执行仍受当前硬件能力、在线状态、窗口及按键反馈约束。详见上文任务控制协议。SDK 崩溃、挂起或关麦清理不全属于驱动生命周期异常，仍使用上节维护机制；本次不声称在 SDK 失效时仍能操作硬件。

`umouse_status.voice` 单独报告语音运行时就绪情况，`inputUncertainScopes` 是历史诊断，不能等同于功能被锁定。现有人工 recover 命令保留作进程故障维护，不能用于伪造硬件复位。升级保留旧证据；新版普通操作会先归档旧记录。原生隔离格式版本号继续保留以保护旧包回退兼容性。
stdio 每 10 秒保活，30 秒租约；活动请求最多延长到 45 秒。HTTP 使用 15 分钟被动租约，不能精确判断一个静默宿主是否退出。尚不实现 HTTP 双向主动探活模式。
stdio 初始化成功后，后台管道断开不会再主动关闭宿主 stdio。connector 按 0.5/1/2/5 秒退避尝试重新认证并完成 initialize/initialized，建立新的连接所有权；静态模式重连不再通知工具列表更新。只重放协议握手，不缓存或重放工具调用、取消通知、语音会话或输入操作。断线中的工具调用返回 `shared_service_disconnected_result_unknown` 和 `retryAutomatic:false`；离线期间的新调用立即失败。恢复后先查 umouse_status，旧语音 session 不得继续使用。
每次重新连接都会读取客户端凭据及维护标记；撤销不会使用缓存密钥绕过，维护期间不重新准入。协议版本或协商能力变化时返回 `connector_protocol_changed_restart_mcp`，要求宿主重建 MCP。宿主关闭 stdin、发送退出信号或 stdio 本身出错时退出，不自建第二个宿主连接。该机制不能复活被强制终止的 connector，也不改变 SDK/input 安全隔离。
Codex 26.1007.9446.0 的设置启用开关仅写入 enabled 并刷新设置缓存，本次没有重建已死亡的 stdio；不能把开关成功当作连接恢复。客户端具有专门的 MCP 重载入口时应使用该入口；OpenAI App Server 文档提供 `config/mcpServer/reload`，但 MCP 服务本身不能替宿主调用它。首次安装新 connector 仍需宿主加载新入口；无可用重载入口时保留这一宿主限制，不修改客户端程序或另开测试 MCP 绕过。
单个鼠标动作或键鼠序列最多20秒；请求体1 MiB、stdio 返回封装和队列9 MiB。大结果首次返回后只保留防重墓碑，重复请求可能返回 result_not_cached，不能换 ID 自动重做。
共享编码后响应预算为 64 MiB；HTTP 每 socket 最多 8 条在途请求、全局普通请求最多 60 条，另留 4 个管理名额。达到预算会拒绝/关闭受影响连接，不将这些配额声称为整个程序的 RSS 上限。
有限 HTTP 请求/响应最长 60 秒；单个实际输出块 10 秒仍未完成写入即关闭对应连接并回收预算。GET 通知流不使用普通响应的总时长上限，但受写入期限与逻辑连接租约约束；会话关闭会销毁未完成响应。预算同时涵盖协议结果预约和未刷出的网络块，因此可能比仅计算结果字节更早拒绝新输出。
Windows TCP 身份核验最多 8 个并发、32 个排队，排队最长 2.5 秒；超额拒绝，不无界拉起探测进程。其他配额：原始 TCP socket 128、管道连接 64、有效逻辑连接 32、native 在途请求 32；防重记录每连接 256、全局 2048。自动启动重试退避为 1/2/5 秒。
旧 stdio 语音隔离不会按时间自动解除；语音键释放/段边界超时会结束活动会话并保留设备隔离。全部设备离线后可 reconfigure，只有 SDK 完整停止才清除旧隔离。PTT 达时长上限先冻结采集，松键及完整段边界后仍可转写已采集内容；继续丢失边界则失败，不交付猜测文字。

离线 `test:shared` 包含原生动作虚拟端口、真实适配器/fake vendor、原生进程、双传输、管理和 Job 故障测试。没有 OS 鼠标模拟输入。新增 Windows 前台/光标查询契约仅做被动读取，SDK 使用 fixture DLL。
物理语音、真实反控、屏幕效果、目标应用落字，以及多宿主兼容性仍需真机验收。不能把假插件进程测试称为真实 SDK 初始化或硬件通过。
# 输入时序诊断（可选）

维护停止期间，在私有 `service.json` 设置本机绝对路径 `diagnosticsDirectory`，通过正常升级/重启服务加载。删除该字段可禁用。不要打印配置中的凭据。日志覆盖 MCP 收发、原生 RPC 收发及排队、SDK 调用和可选 SDK USB 边界；使用 `client_request_id` 关联鼠标动作/批量操作，USB 帧按命令和滚动序号关联。重复/缺失回执必须如实记录，不能猜测一一对应。

SDK 可选导出 `um_register_input_io_trace` 缺失时照常工作，但没有 USB 证据。原生生产线程只入有界队列（8192条、每条16KiB、每文件32MiB），磁盘由独立线程写；插件销毁前结束 writer。TypeScript 只同步写小型元数据（同样32MiB上限），不记录任意参数、凭据、音频或转写文本。F0/F1日志含测试键码；仅在授权诊断期启用。文件以进程和唯一后缀命名，不自动删除旧证据，持续诊断需人工管理磁盘空间。

UTC 用于阅读，跨原生进程可用 QPC 对齐；Node `monoMs` 只能在同一进程内相减。SDK读写边界不是USB总线包，Raw Input是Windows解析后的事件。宿主拿不到模型内部推理耗时；只能另行记录工具调用起止、外部调用间隔，内部推理时间须标为不可用。

