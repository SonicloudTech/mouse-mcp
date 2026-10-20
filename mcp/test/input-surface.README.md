# 被动硬件输入真机验收窗口

这是 Windows WinForms 测试目标，不是输入驱动。源码没有 SDK、MCP 连接、网络访问、鼠标/键盘模拟、UIA Invoke 或前台切换 API；只记录操作系统实际交付给本窗口的事件。启动或操作由主验收流程统一执行。

## 构建与启动

只编译（默认不启动、不改变前台）：

```powershell
& .\mcp\test\input-surface.ps1 -OutputDirectory 'D:\SDK-MCP\.diagnostics\hardware-real-acceptance-001'
```

显式启动可见验收窗口：

```powershell
& .\mcp\test\input-surface.ps1 -OutputDirectory 'D:\SDK-MCP\.diagnostics\hardware-real-acceptance-001' -StartVisible -AutoCloseSeconds 1800
```

脚本返回进程 ID 和日志路径。重复运行需要新的证据目录；已有 `events.jsonl` 或 `state.json` 时程序拒绝覆盖证据。窗口默认 30 分钟自动关闭，允许设置 30–7200 秒；也可使用普通窗口关闭按钮退出，或由主流程按已记录的 PID 清理自身 fixture 进程。

## 验收证据

- `state.json`：当前 PID、十进制 HWND、窗口物理矩形、点击/滚轮/拖拽起止点的屏幕坐标、累计计数。清单启用 PerMonitorV2，固定客户端大小 960×680。`right/bottom` 是半开边界。
- `events.jsonl`：实际 down/up/click/double_click/wheel、抽样 move、drag_success/drag_miss 和 ready/closed 事件，带 UTC 时间、目标区、按键、客户端与屏幕坐标。
- 窗口内四个原生 Label 的 UIA accessible name 同步显示计数，便于人工对照和独立可访问性测试。三个 Panel 的名字是 `Click pad`、`Wheel pad`、`Drag pad`，可供人工定位。
- 移动每 8 个消息更新一次磁盘/UIA，以限制拖拽期间的记录开销；下一次 down/up/wheel 会把最新完整计数写入。原始 move 消息计数并非发送次数。

建议先读取 `state.json`，并用 `umouse_input_status` 核对前台窗口身份；所有输入都由当前唯一 MCP 执行。依次验证移动、单击、双击、右键、中键、上下滚动，以及从 `dragStart` 到 `dragEnd` 的左键拖拽。按成功的事件差值判定，不能只凭传输 `written` 计数通过。

WinForms 双击的典型事件是 `click` 一次加 `double_click` 一次，不是两个 `click`；测试应检查 double 计数、down/up 与原始事件，避免误把系统双击判成丢点击。鼠标抓取仅用于真实按住拖拽时接收真实释放消息，不生成任何输入。

## 已做检查与边界

源码由 Windows .NET Framework 4 x64 C# 编译器构建。构建成功只证明 fixture 可编译；新版直接硬件入口仍需由主验收流程记录前台身份、实际输入和窗口事件证据。本次 CUA 精简不启动该窗口、不产生实际输入。
