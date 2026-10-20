# 鼠标能力用例目录（MOUSE-CAPABILITY-TESTS）

面向通过 MCP 接入的大模型/自动化客户端。每条用例给出：调用 JSON（`umouse_mouse_action` 的
`action` 字段）、回执判定、效果验证（网页实验室的页面事件）。控制纪律见 README §三。
通用判定：`outcome=="completed"`；`verification.feedbackReliable==true`；按键动作
`buttonIntegrity=="confirmed"` 且 `cleanup=="release_confirmed"`。

## MC-MOVE 位移

| ID | 用例 | action | 判定 | 页面验证 |
|---|---|---|---|---|
| MC-MOVE-01 | 中距移动 | `{"kind":"move","x":X,"y":Y}`（200~600px 外） | completed，`abs(residual.dx/dy)≤4` | 目标若为实验室区域，页面收到 `enter` 事件 |
| MC-MOVE-02 | 近距移动 | 同上（30~80px） | ≤2 帧 | 同上 |
| MC-MOVE-03 | 远距移动 | 同上（>800px） | ≤8 帧，耗时 <1.5s | — |
| MC-MOVE-04 | 高精度移动 | `{"kind":"move","x":X,"y":Y,"precision":"high"}` | `abs(residual)≤2`（典型 ≤1） | 靶心区 `click` 的 `dist≤2.5px` |

## MC-CLICK 按键

| ID | 用例 | action | 判定 | 页面验证 |
|---|---|---|---|---|
| MC-CLICK-L-01..03 | 左键单击 ×3 | `{"kind":"click","x":X,"y":Y}` | completed，2 帧 | `click` 事件 ×1，落点误差 ≤6px |
| MC-CLICK-R-01..03 | 右键单击 ×3 | 同上 `button:"right"` | completed | `contextmenu` 事件 ×1（页面已接管不弹菜单） |
| MC-CLICK-M-01..02 | 中键单击 ×2 | 同上 `button:"middle"` | completed | `auxclick`(button==1) ×1 |
| MC-CLICK-D-01..02 | 双击 | 同上 `count:2` | completed；native 侧两次按压间隔 < `GetDoubleClickTime()` | `dblclick` ×1 + `click` ×2，间隔 <500ms |

## MC-WHEEL 滚轮

| ID | 用例 | action | 判定 | 页面验证 |
|---|---|---|---|---|
| MC-WHEEL-D3-01..03 | 下滚 3 格 | `{"kind":"scroll","x":X,"y":Y,"direction":"down","amount":3}` | completed | 滚动区 `scrollTop` 增加（Δ≥1） |
| MC-WHEEL-U2-01..02 | 上滚 2 格 | `direction:"up",amount:2` | completed | `scrollTop` 减少 |
| MC-WHEEL-D1/U1 | 单格 | `amount:1` | completed | `scrollTop` 同向变化；线性关系 Δ=3 行/格 |

## MC-DRAG 拖拽

| ID | 用例 | action | 判定 | 页面验证 |
|---|---|---|---|---|
| MC-DRAG-H | 水平拖拽 | `{"kind":"drag","x":X0,"y":Y,"toX":X1,"toY":Y}` | completed，`release_confirmed` | `dragEnd`：起点/终点误差 ≤6px，路径直线度 ≤3px |
| MC-DRAG-DIAG | 斜向拖拽 | 同上（dx,dy 同非零） | 同上 | 同上 |
| MC-DRAG-HIGH | 高精度拖拽 | 同上 + `precision:"high"` | 同上，残差 ≤2 | 同上 |

## MC-PREC 落点精度

| ID | 用例 | action | 判定 | 页面验证 |
|---|---|---|---|---|
| MC-PREC-01..03 | 靶心点击 ×3 | `{"kind":"click","x":BULLX,"y":BULLY,"precision":"high"}` | completed | 页面回报落点与靶心距离 `dist≤2.5px` |

## MC-COMBO 组合

| ID | 用例 | 序列 | 判定 |
|---|---|---|---|
| MC-COMBO-01 | 移动后点击 | MOVE → CLICK | 两步各自 completed，页面 click 事件 ×1 |
| MC-COMBO-02 | 双击后滚轮 | CLICK(count:2) → SCROLL | dblclick ×1 + scrollTop 变化 |
| MC-COMBO-03 | 拖拽后滚轮 | DRAG → SCROLL | dragEnd + scrollTop 变化 |

## 常见错误码速查

| errorCode | 含义 | 处置 |
|---|---|---|
| `button_feedback_input_desktop_unavailable` | 输入桌面非当前线程桌面（锁屏/UAC/切换瞬态） | 解锁后重试；套件会自动等待 |
| `button_target_already_held` | 目标按键物理上已被按住 | 检查是否有其他按压未释放 |
| `position_below_device_resolution` | 微修正帧固件不执行（残差在设备量子内） | 属设备极限，换 `precision` 或接受残差 |
| `double_click_timing_exceeded` | 两次按压间隔超过系统双击时间 | 检查系统双击速度设置 |
| `device_generation_changed` | 设备重连/换代 | 重新 `umouse_list_devices` 后再试 |
| `control_busy` / `device_id_required` | 未取得/复用控制权 | 先 `umouse_control begin`，带 `control_id` |
