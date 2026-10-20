# umouse-mcp

[English](README.md) | **简体中文**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20x64-6f42c1.svg)](#)
[![asr](https://img.shields.io/badge/ASR-可插拔-6f42c1.svg)](#语音听写asr-provider-可插拔)
[![language](https://img.shields.io/badge/lang-C%2B%2B%20%7C%20TypeScript-007ec6.svg)](#)

让大模型握住一只**真实的鼠标**。umouse-mcp 是一个 Model Context Protocol（MCP）服务器：所有位移、按键、滚轮、拖拽都经 uMouse USB 设备以 HID 帧发出，由操作系统按物理鼠标完整处理——**不做任何软件注入**。

> 大模型 → MCP 宿主 → 共享守护进程（`:47192`）→ C++ 原生宿主 → USB HID `0xF0/0xF1` → uMouse 设备 → Windows 输入管线

## 效果演示

真实硬件鼠标驱动实验室页面（金色箭头为录屏叠加的系统光标）——页面上的计数、滚轮位置与命中反馈均由浏览器真实事件产生，非脚本伪造：

![uMouse 硬件鼠标能力演示](mcp/acceptance/demo/mouse-capabilities.gif)

### 语音打字：说出的话，实时打进任意窗口

按住设备语音键说话，松开后识别文字经真实键入链路打进**此刻的前台窗口**——不挑应用，光标在哪就打到哪里。以下两段均为实机录制（1080p）：

**Agent 客户端（终端）**——语音命令逐字打进终端并回车执行：

<video src="mcp/acceptance/demo/voice-typing-agent.mp4" controls muted width="720">mcp/acceptance/demo/voice-typing-agent.mp4</video>

**微信**——语音文字逐段打进输入框并发送：

<video src="mcp/acceptance/demo/voice-typing-wechat.mp4" controls muted width="720">mcp/acceptance/demo/voice-typing-wechat.mp4</video>

## 核心能力

- **硬件动作**：`umouse_mouse_action` —— move / click / scroll / drag，桌面物理像素坐标，支持多屏与负坐标，可选 `precision: standard | high`。
- **任务独占**：`umouse_control` begin → 动作 → end；同一时刻只有一个任务驾驶键鼠，断线自动收尾。
- **读数传感器**：`umouse_input_status` —— 光标坐标、全键实时状态、前台窗口身份；只读，不拦截。
- **语音听写**：麦克风采集 → VAD 分段 → 可插拔 ASR provider → 预览 / 终稿回执，独立链路，与键鼠反控互不抢占（见下文）。
- **共享 daemon**：单机单实例（端口 47192），ZCode / Codex / Claude 多宿主共用，空闲自动回收。

## 语音听写：ASR provider 可插拔

ASR 在这里不是绑死某家服务的黑盒，而是一个很小的接口约定——实现 `begin / writePcm / finishInput / cancel` 四个方法，回调 `preview / segmentFinal / warning / terminal`（terminal 恰好一次）四类事件，就是一个合法 provider；换识别服务只需换一个工厂函数，`mcp/src/sinicloud-asr.ts` 是完整参考实现。

| provider（`UMSDK_ASR_PROVIDER`） | 说明 |
|---|---|
| `sinicloud`（Windows 默认） | Sonicloud 开放平台流式识别：纯 TS、无 DLL 依赖；16k/16bit/mono PCM 实时推送，中间结果预览，低额预警不断流 |
| `windows-speech` | Windows 内置识别器，离线执行，音频不出本机 |
| `whisper-cpp` | 自部署 whisper-cli + ggml 模型（路径自配），CPU 离线转写 |
| `http` | 自定义转写端点：multipart WAV 进、`{"text"}` 出 |
| `disabled` | 关闭听写；provider 缺失时优雅降级为 `asr_unavailable` |

凭据只走配置通道，**每会话热读——换 key 不重启**：JSON 文件默认 `<数据目录>/sinicloud_asr.json`（字段 `appId / apiKey / apiSecret / userId / lanid / streamUrl / tokenUrl`）；环境变量 `UMSDK_ASR_APP_ID / UMSDK_ASR_API_KEY / UMSDK_ASR_API_SECRET / …` 覆盖文件值。凭据不硬编码、不打印、不入日志、不入仓库。发行包内置开放平台**试用凭据**，安装即用；正式使用请替换为自己的 key。完整 provider 矩阵见 `mcp/SHARED-V2.md`。

## 跨电脑的自适应定位

Windows 指针弹道（"提高指针精确度"）使"协议位移 → 像素"的增益随幅度变化。umouse-mcp 内置 11 档弹道增益曲线：首次使用某设备时按本机指针设置只读播种，运行中按帧在线学习并限幅 `[0.125, 10]`，闲置 60 秒向种子半衰——**换电脑、换设备免调参**，种子失配只多花 1–2 帧。设计与实测见 `mcp/sdk-host/POSITIONING.md`。

| 指标 | standard | high |
|---|---|---|
| 停止容差 | 残差 ≤ 4 px | 残差 ≤ 1 px |
| 实测（参考台架） | 中位 356 ms / 2 帧 | 最大 1 px，均值 0.67 px |
| 失败模式 | 相同；high 最坏退化为 ≤ 4 px best-effort，残差如实上报 | |

## 一键验收：真实网页实验室

32 项用例在真实浏览器页面闭环验证效果：左 / 右 / 中键计数、双击间隔、滚轮 `scrollTop`、拖拽直线度、1 px 靶心落点。

```bash
cd mcp/acceptance
UMCFG=<client.json> UMBUNDLE=<发布包> node run-matrix.mjs
# 输出 acceptance-report.json · 退出码 0 = 全部通过（参考结果 32/32）
```

## 快速开始

1. 自备 uMouse USB 设备（VID:PID `0ABC9:0CA89`），Windows x64 + Node.js 22。
2. 从 [Releases](../../releases) 下载自包含包 `umouse-mcp-os-win-x64-*.zip`，解压到任意目录。
3. 双击 `install-agents.cmd` 一键接入（默认 ZCode；支持 `claude` / `cursor` / `all`），或手动添加宿主配置：

```json
{
  "mcpServers": {
    "umouse": { "command": "node", "args": ["C:\\解压路径\\umouse-mcp-os-win-x64\\mcp\\dist\\index.js"] }
  }
}
```

4. 对 agent 说「调用 umouse_status」——返回 `sdkVersion` 即连接成功。

源码构建：`npm ci && npm run build && npm test`（Windows x64；原生 SDK 以 DLL + 公共头形式发布，见 `include/umouse_sdk.h`）。

## 安全模型

- 锁屏 / UAC / 安全桌面：按键动作被 `button_feedback_input_desktop_unavailable` 拒绝——这是安全属性，不是缺陷。
- `effectConfirmed` 恒为 `false`：传输成功 ≠ 应用生效，效果以验收实验室的页面证据为准。
- ASR 凭据只经本地配置文件与环境变量注入：不入仓库、不打印、不入日志；`recover` 必须人工携带 `--hardware-reset-confirmed`。

## 文档

| 文档 | 内容 |
|---|---|
| `mcp/SHARED-V2.md` | 共享 v2 安装、升级、维护与恢复手册 |
| `mcp/acceptance/MOUSE-CAPABILITY-TESTS.md` | 32 项能力用例目录（可直接照抄的 MCP 调用与判定标准） |
| `mcp/sdk-host/POSITIONING.md` | 弹道曲线定位：历史方案、算法设计、跨设备矩阵与实测 |
| `mcp/README.md` | MCP 工具完整参考 |

## 商务与支持

本仓库由 [SonicloudTech](https://github.com/SonicloudTech)（安徽声云智能科技有限公司 · Sonicloud）维护，聚焦 AI 输入硬件与语音开放平台。

- 官网：<https://sinicloud.com/>
- 语音开放平台：<https://open.sinicloud.com/> —— 默认 ASR provider 即出自该平台，注册即可获得试用额度
- 商务与技术合作：[xu_heng_yu@sinicloud.com](mailto:xu_heng_yu@sinicloud.com)（OEM / 渠道 / 定制固件 / 联合开发；来信请附目标平台、预期量级、设备型号与固件版本）

<img src="img/微信.png" alt="SoniCloud 商务微信二维码" width="200" style="max-width: 100%; height: auto;">

## Roadmap

- [x] 跨电脑自适应增益曲线（v0.4）
- [x] ASR provider 化：sinicloud 流式接入，凭据全程可配置
- [ ] 固件执行 1–2 count 微修正帧
- [ ] 滚轮 ACK 与滚动量闭环
- [ ] 绝对定位模式

## License

代码以 [MIT](LICENSE) 发布。原生 SDK 以闭源 DLL + 公共头（`include/umouse_sdk.h`）形式提供。
