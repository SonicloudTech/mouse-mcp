# umouse-voice-ui —— v2 语音录音浮窗（Rust/Win32，零外部依赖）

不抢焦点的录音状态浮窗。显示状态/计时/实时预览，提供
完成/取消按钮；不加载 uMouse SDK、不提供任何输入注入接口。

界面：深色圆角卡片、系统阴影、独立文字预览区、当前前台窗口所在
屏幕工作区的右下角（逻辑边距24px，避开任务栏）。默认480×224逻辑像素，
按所在屏幕DPI缩放。Windows11使用DWM圆角；旧系统在DWM不支持时使用圆角区域。
物理键听写仅显示取消；Agent问答显示“说完了”和取消，结束请求发出后不重复提交。
转写时禁用“说完了”，取消仍可用。窗口使用单调时钟计时、双缓冲绘制；
长预览按实际字体测量裁掉头部，保留末尾内容。没有将装饰动画伪装成实时音量。

## 构建与部署

```
cd mcp/voice-ui
cargo build --release     # MSVC 工具链；零 crate 依赖，离线可构建
cargo test --release --offline
# 仓库根目录下：原生UI只读测试，不打开SDK或麦克风、不模拟点击
node --test mcp/test/voice-ui-native.test.mjs mcp/test/voice-ui.test.mjs
```

产物 `target/release/umouse-voice-ui.exe`；MCP 侧经 `UMSDK_VOICE_UI_PATH`
可覆盖路径，缺省探测该构建产物位置；`npm run package` 自动复制进安装包
（缺 exe 时对应会话无浮窗，VAD/上限/工具完成入口仍在——能力如实降级）。

## 不抢焦点契约

- 窗口扩展样式 `WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW`；
- `WM_MOUSEACTIVATE` 返回 `MA_NOACTIVATE`：点击按钮不激活窗口、不夺前台焦点；
- 显示用 `SW_SHOWNOACTIVATE`，全程不调用 `SetForegroundWindow`。

依据：[Extended Window Styles](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles)、
[WM_MOUSEACTIVATE](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mouseactivate)。
当前桌面/多 DPI/辅助技术下的实际表现属 P5 人眼验收项。

## IPC（stdin/stdout，UTF-8 行协议，Tab 分隔；只在 stdin 打开期间存活）

```
MCP → UI : U <TAB> session <TAB> state <TAB> mode <TAB> preview <TAB> elapsedMs
           state ∈ recording|finalizing|done|error|busy；mode ∈ agent|ptt
UI  → MCP : F <TAB> session    （完成按钮）
           C <TAB> session     （取消按钮）
```

- MCP 侧发送前把预览文本中的 Tab/CR/LF 替换为空格（字段分隔保护）；
- 按钮指令带会话身份——旧浮窗/迟到消息不能关闭下一次录音；
- stdin 关闭（EOF）→ 进程自退；2 秒未退由 MCP 侧强杀（不留后台录音进程）；
- stdout 只有协议行（无调试输出污染）。
