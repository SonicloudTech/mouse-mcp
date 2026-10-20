# Windows 鼠标 Raw Input 被动观察探针

本工具用于对齐 SDK/MCP 发送记录、Windows Raw Input 与验收窗口消息。它独立运行，不加载 SDK、不打开 HID 句柄、不发送任何输入、不激活窗口。默认仅采集鼠标；显式指定 `-KeyboardTargetPid <验收窗口PID>` 才注册键盘，且仅当前台属于该存活进程时记录键盘事件。目标进程退出即结束采样。

键盘记录为 `raw_keyboard`，包含 makeCode、flags、vkey、message、devicePath 和 foregroundPid。flags 位0表示 break（抬起），不是字符编码；重复 make 也可能是 Windows 自动重复，不能等同于设备重复发送。键盘记录仅供授权测试窗口诊断，不应指向普通聊天、密码或私人文档窗口。

## 运行

在仓库根目录执行。默认仅编译；显式 `-StartHidden` 启动一个不可见的 message-only window。

```powershell
& .\mcp\test\raw-mouse-probe.ps1 `
  -OutputDirectory 'D:\SDK-MCP\.diagnostics\hardware-hid-followup-20261013\raw' `
  -AutoCloseSeconds 1800 -StartHidden
Get-Content -LiteralPath 'D:\SDK-MCP\.diagnostics\hardware-hid-followup-20261013\raw\probe-state.json'
```

确认 `status=running`，并检查 `raw-events.jsonl` 的 `ready`、`mouse_device` 记录后，由当前唯一 MCP 连接执行测试。探针会到时退出，也可以提前创建 `stop.request` 文件正常退出并排空日志队列：

```powershell
New-Item -ItemType File -Path 'D:\SDK-MCP\.diagnostics\hardware-hid-followup-20261013\raw\stop.request'
```

每次运行须使用新目录；工具拒绝覆盖既有 `raw-events.jsonl`/`probe-state.json`。若启动失败，读取同目录的 `probe-fatal.txt`。不应强行终止进程，否则结尾状态与剩余队列可能没有写入。

## 数据及限制

- `raw_mouse` 是 Windows `WM_INPUT` 接收事件；字段来自 `RAWINPUTHEADER` 和 `RAWMOUSE`，不是 USB 总线原始报告。`devicePath` 标识具体鼠标 collection，可区分连接的其他鼠标。
- `utc`、`qpc`、`tickCount64` 在消息处理入口记录，`qpcFrequency` 在 `ready` 内。`messageTime` 是 `GetMessageTime()` 的 32 位系统消息毫秒时间戳，约 49.7 天回绕；不能把它视为设备/固件时钟。此处记录的时间也不能代替 USB 硬件采样时间。
- `buttonFlags` 是**变化标志**：1=左键 down、2=左键 up、4/8=右键、16/32=中键、64/128=X1、256/512=X2、1024/2048=滚轮/水平滚轮；0 表示本记录没有按钮变化，**不是按钮全释放**。
- `buttonData` 为无符号原值；有 wheel 标志时可使用 `wheelDataSigned`。`rawButtonsReserved` 是保留字段，不可用来推断按住状态。`dx`/`dy` 含义由 `mouseFlags` 决定：位 0=绝对坐标；未设位 0 时为相对运动，不能直接当桌面像素位移。
- `async_mouse_state_snapshot` 为读 `GetAsyncKeyState` 的鼠标高位状态（仅 VK 1/2/4/5/6）。状态变化时记录，另有 100ms 定时观察。该记录不是 Raw Input 事件或额外按键事件，也可能漏掉短于采样间隔的瞬态；不能单独据此证明 HID down/up。新版本以 `GetPhysicalCursorPos` 记录 `cursorX/Y`，并标注 `cursorSpace=physical-desktop-pixels`；旧版缺少此标记时使用的是 `GetCursorPos`，不得假定与 硬件工具物理像素坐标一致。
- 只注册 UsagePage=1 / Usage=2 和 `RIDEV_INPUTSINK | RIDEV_DEVNOTIFY` (0x2100)，不设置 `RIDEV_NOLEGACY`/`RIDEV_CAPTUREMOUSE`。不会改变验收窗口的正常 legacy 鼠标消息交付。
- 消息线程将对象放入容量 8192 的有界队列，后台线程负责 JSON 序列化与写盘，避免同步磁盘写入阻塞 `WM_INPUT`。`capture_stopped`/最终 `probe-state.json` 给出 `droppedRecords`；非零时不能宣称证据完整。旧版探针对应末条事件名为 `closed`。状态文件只在开始/结束写入，运行中计数请读取 JSONL。
- 状态文件先写同目录临时文件，再使用 `File.Replace`/`File.Move` 原子发布，避免读取到覆盖过程的截断内容。退出时最多等待后台 writer 5000ms；仅已结束且无 writer 错误时标记 `status=closed`，等待超时为 `writer_not_drained`，已结束但写盘失败为 `writer_failed`。`capture_stopped` 仅表示停止采样，不能代替最终 writer 状态。
- 捕获是 Windows 输入栈中的被动观察；Raw Input 到达并不能证明 USB 哪个环节造成延迟。判断 DLL→USB→接收器→固件各段仍需相应总线/固件时间记录。

## 参考

- [Microsoft RAWMOUSE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawmouse)
- [Microsoft RAWINPUTDEVICE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice)
- [Microsoft GetMessageTime](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getmessagetime)

构建依赖系统 .NET Framework 4 x64 C# 编译器；不用 NuGet、管理员权限或第三方驱动。
