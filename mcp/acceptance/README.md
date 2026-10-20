# uMouse 硬件鼠标能力验收套件（Mouse Capability Acceptance Lab）

本目录是一个**独立发布板块**：面向任何通过 MCP 接入 uMouse 硬件的大模型/自动化客户端，
提供一套完整、可复现、可验证的鼠标能力测试方法。包含三部分：

1. **网页实验室**（推荐）：`lab-server.mjs` + `lab-page.html` + `run-matrix.mjs` —— 在真实浏览器页面上
   自动执行全部鼠标能力并闭环验证效果；
2. **用例目录**：`MOUSE-CAPABILITY-TESTS.md` —— 每项能力的 MCP 调用、期望回执与判定标准（可直接照抄调用）；
3. **原生窗体备用验证器**：`uitest-form.ps1` + `scrollpos.ps1` —— 无浏览器环境下的 WinForms 验证靶。

---

## 效果演示

![uMouse 硬件鼠标能力演示](demo/mouse-capabilities.gif)

真实硬件鼠标驱动本实验室页面（金色箭头为录屏叠加的系统光标）：巡航移动 →
左键×3 → 右键×2 → 双击 → 滚轮下 16 格回 8 格 → 横向/斜线拖拽（直线度 0px / 2.9px）→
两次 1px 级靶心点击（均命中 BULLSEYE，落点距靶心 1.4px）。
页面上的计数、滚轮位置与命中反馈均由浏览器真实事件产生，非脚本伪造。

### 语音打字：说出的话，实时打进任意窗口

按住设备语音键说话，松开后识别文字经真实键入链路打进**此刻的前台窗口**——
不挑应用，光标在哪就打到哪里。以下两段均为实机录制（1080p，无剪辑）：

**Agent 客户端（终端）**——语音命令逐字上屏并回车执行：

<video src="demo/voice-typing-agent.mp4" controls muted width="720">demo/voice-typing-agent.mp4</video>

**微信**——语音消息逐段打进输入框并发送：

<video src="demo/voice-typing-wechat.mp4" controls muted width="720">demo/voice-typing-wechat.mp4</video>

> 视频若未内嵌播放（如 Gitee 镜像），请直接下载 `demo/voice-typing-*.mp4` 查看。
> 识别通道：Sonicloud 开放平台流式 ASR（凭据经配置文件注入，见 SHARED-V2「语音识别 provider」）。

## 一、前置条件

- Windows x64，Node.js 22，uMouse 共享 v2 发布包已完成 `manage.cmd init` + `capabilities` 配置
  （目标设备的 `mouse_control: supported`），硬件已连接；
- 取得 MCP 客户端配置（`manage.cmd config <状态目录> <client-id>` 输出中的 connector 参数）；
- **会话必须处于解锁状态**（见"环境约束"）。

## 二、一键全自动（网页实验室）

```bash
cd mcp/acceptance
UMCFG=<状态目录>/clients/<client-id>.json UMBUNDLE=<发布包目录> node run-matrix.mjs
# 可选: --keep 运行后保留浏览器窗口供人工查看
```

脚本会自动：启动本地事件服务 → 打开 Edge 应用窗口加载实验室页面（全新 profile、
固定位置）→ 通过 MCP 执行 32 项能力用例 → 逐项与页面真实事件（点击计数、双击间隔、
滚轮 scrollTop、拖拽路径、靶心落点距离）比对 → 输出 `acceptance-report.json` 与逐项表格，
退出码 0=全部通过。

判定口径（与回执一致）：动作 `outcome=completed`；位移残差 ≤4px（`precision:"high"` ≤2px）；
点击落点页面误差 ≤6px；拖拽起终点 ≤6px 且路径直线度 ≤3px；靶心落点 ≤2.5px；
双击需页面收到 dblclick 且两次 click 间隔 < 500ms。

## 三、给大模型的手动测试路径（不用脚本）

按 `MOUSE-CAPABILITY-TESTS.md` 的用例逐条调用 MCP 工具即可。核心纪律：

1. **先取控制权**：`umouse_control {operation:"begin",task_id:"..."}`，之后每个动作带 `control_id`；
2. **一次一个完整动作**：`umouse_mouse_action` 的 `action.kind` = move / click / scroll / drag，
   坐标是**桌面物理像素**；
3. **读回执判定**：`outcome`、`verification.buttonIntegrity`、`cleanup`、`residual`；
   `effectConfirmed` 恒为 false —— 输入送达 ≠ 应用效果，效果要靠本实验室的页面证据验证；
4. 结束时 `umouse_control {operation:"end"}`。

最小冒烟（3 次调用）：

```json
{"operation":"begin","task_id":"smoke"}
{"control_id":"<id>","device_id":"<SN>","client_request_id":"s1","action":{"kind":"move","x":960,"y":540}}
{"operation":"end","control_id":"<id>"}
```

## 四、环境约束（重要）

| 约束 | 表现 | 处置 |
|---|---|---|
| **锁屏 / UAC / 安全桌面** | 带按键的动作被 `button_feedback_input_desktop_unavailable` 拒绝；页面收不到输入；这是安全属性不是缺陷 | 解锁会话后重跑；脚本对每项自动等待重试（约 30 秒），并在暖机阶段给出明确报错 |
| 会话刚连接/浏览器冷启动 | 首个动作偶发同类瞬态 | 脚本已内置暖机与重试 |
| 多屏/显示缩放 | 页面自标定按单屏推导，dpr>1 或多屏需复核落点 | 靶心区会回报实际偏差，可据此校正 |
| WinForms Button | 不触发 DoubleClick 事件（框架行为） | 双击验证用 dblclick 区/文本区（页面上已如此） |

## 五、备用：原生 WinForms 验证器（无浏览器）

`uitest-form.ps1` 弹出带按钮/滚动文本框/拖拽区的窗口（事件写入 `uievents.log`，控件屏幕坐标写入
`uirects.json`）；`scrollpos.ps1` 读取文本框滚动位置。适用于最小依赖环境；验证方法与网页版一致
（本套件在参考台架上以该方式取得 43/43 通过的基线）。

## 六、文件清单

| 文件 | 作用 |
|---|---|
| `run-matrix.mjs` | 全自动矩阵（服务/浏览器生命周期、暖机、逐项验证、报告） |
| `lab-server.mjs` | 零依赖事件/目标/状态 HTTP 服务（默认端口 8123） |
| `lab-page.html` | 真实网页实验室：左/右/中键计数、双击、滚轮、拖拽画布、1px 精度靶心，全部事件上报 |
| `MOUSE-CAPABILITY-TESTS.md` | 用例目录（机器友好的能力→调用→判定映射） |
| `uitest-form.ps1` / `scrollpos.ps1` | 原生窗体备用验证器 |
| `acceptance-report.json` | 最近一次运行结果 |
