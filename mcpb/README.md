# uMouse MCPB for Windows x64 / Windows x64 安装包

MCPB **0.1.1** packages the existing **legacy 0.1.0** stdio server. The JavaScript runtime, native DLLs and production dependencies are preserved from the [v0.1.0 ZIP](https://github.com/SonicloudTech/mouse-mcp/releases/tag/v0.1.0). This package does not contain the shared-v2 native host or acceptance lab.

MCPB **0.1.1** 封装现有 **legacy 0.1.0** stdio 服务器。JavaScript 运行文件、原生 DLL 与生产依赖沿用 [v0.1.0 ZIP](https://github.com/SonicloudTech/mouse-mcp/releases/tag/v0.1.0)，不包含共享 v2 原生宿主或验收实验室。

## Install / 安装

1. Use Windows x64 with an **x64 Node.js runtime, version 22 or later**. Node.js itself is not included. The MCP client must support MCPB Node servers and provide a compatible Node runtime, or find your installed `node` on PATH.
2. Download `umouse-mcp-0.1.1-win-x64.mcpb` from the [v0.1.1 release](https://github.com/SonicloudTech/mouse-mcp/releases/tag/v0.1.1), then import it using your client's MCPB/extension installation flow.
3. Connect compatible uMouse hardware and firmware. An ordinary USB mouse is not sufficient. Close an unused legacy uMouse connection normally if it already owns the SDK; this package does not forcibly stop other clients.
4. Call `umouse_status`, `umouse_get_capabilities` and `umouse_list_devices`. Check `sdkStarted`, `lastError`, device availability and capabilities. SDK access and a successful transport write do not prove a physical mouse action; verify the visible result separately.

1. 使用 Windows x64 和 **22 或更高版本的 x64 Node.js**。包内不含 Node.js；MCP 客户端须支持 MCPB Node 服务器并提供兼容运行时，或能从 PATH 找到已安装的 `node`。
2. 从 [v0.1.1 发布页](https://github.com/SonicloudTech/mouse-mcp/releases/tag/v0.1.1)下载 `umouse-mcp-0.1.1-win-x64.mcpb`，通过客户端的 MCPB / 扩展安装功能导入。
3. 连接兼容的 uMouse 硬件与固件，普通 USB 鼠标不能直接替代。若旧版连接已占用 SDK，请正常关闭不再使用的连接；本包不会强制终止其他客户端。
4. 调用 `umouse_status`、`umouse_get_capabilities` 和 `umouse_list_devices`，检查 `sdkStarted`、`lastError`、设备与能力。SDK 可访问或传输写入成功不代表鼠标动作已生效，实际效果须另行观察确认。

## Settings and data / 配置与数据

| Setting / 配置 | Default / 默认值 | Meaning / 含义 |
|---|---|---|
| `data_dir` | Empty / 留空 | Uses `~/.umouse-mcp-mcpb` for recordings, logs and state. / 将录音、日志和状态存入 `~/.umouse-mcp-mcpb`。 |
| `asr_provider` | `disabled` | Speech recognition is off. Set `windows-speech` for the local Windows recognizer; install the desired Windows speech language first. / 默认关闭语音识别；设为 `windows-speech` 可启用本地 Windows 识别器，须先安装相应语音语言。 |

This MCPB exposes only `disabled` and `windows-speech`. It includes no cloud speech credentials and does not run the ZIP's client installer. Voice functionality can record audio to the data directory when requested or triggered by the device; enabling dictation can type recognized text into the focused window. Review your client's tool permissions before using hardware or voice actions. Uninstalling the extension may leave its separate data directory in place.

本 MCPB 仅提供 `disabled` 和 `windows-speech`，不包含云端语音凭据，也不运行 ZIP 中的客户端安装器。按请求或设备触发使用语音功能时，录音可能写入数据目录；启用听写后，识别文字可输入当前焦点窗口。使用硬件或语音动作前请检查客户端的工具权限。卸载扩展后，独立的数据目录可能仍会保留。

## Other clients and source / 其他客户端与源码

Clients without MCPB support can use the original ZIP and its installer. See the [English guide](https://github.com/SonicloudTech/mouse-mcp/blob/main/README.md), [中文指南](https://github.com/SonicloudTech/mouse-mcp/blob/main/README.zh-CN.md), [uMouse SDK](https://github.com/SonicloudTech/mouse-sdk), and [issues / 支持](https://github.com/SonicloudTech/mouse-mcp/issues). The source tree's shared-v2 implementation is a separate development path.

不支持 MCPB 的客户端可继续使用原 ZIP 与安装器，入口见上述中英文指南。源码目录中的共享 v2 实现属于另一条开发路径。

## Licenses / 许可

`LICENSE` covers the server and sample code under MIT. Native SDK binaries retain their separate distribution terms. Keep `THIRD_PARTY_LICENSES.txt`, `COPYING.LGPLv2.1`, `LICENSE.hidapi-bsd` and dependency license files with the bundle; do not interpret the code license as an MIT grant for every binary.

`LICENSE` 中的 MIT 许可覆盖服务器和示例代码；原生 SDK 二进制保留单独的分发条款。请保留 `THIRD_PARTY_LICENSES.txt`、`COPYING.LGPLv2.1`、`LICENSE.hidapi-bsd` 及依赖许可文件，代码许可不代表全部二进制均采用 MIT。
