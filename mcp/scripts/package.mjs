/*
 * package.mjs —— 自包含可分发包构建脚本
 *
 * 产物：release/umouse-mcp-win-x64/            （解压即用目录）
 *      release/umouse-mcp-win-x64-<ver>.zip    （交付压缩包）
 *
 * 目录镜像源码树的关键相对路径（零代码改动即可运行）：
 *   mcp/dist/index.js  ← 入口（ESM，作用域由 mcp/package.json 的 type:module 标记）
 *     ├ require('../../doc/umouse-sdk.js')  → <pkg>/doc/umouse-sdk.js（koffi 绑定）
 *     │    └ require('koffi')               → <pkg>/node_modules（依赖装在包根）
 *     └ 默认 lib 路径 ../../lib/uMouseSdk.dll → <pkg>/lib/（v0.4.20 运行时）
 *
 * 运行：npm run package（仓库根；自动先 tsc 构建）
 */
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (process.argv.length > 2) throw new Error('No package variant flags are supported');
const stagingName = 'umouse-mcp-os-win-x64';
const staging = path.join(root, 'release', stagingName);
const zipPath = path.join(root, 'release', `${stagingName}-${version}.zip`);
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('此打包脚本仅支持 Windows x64');
}

function log(msg) {
  console.error(`[package] ${msg}`);
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest, filter) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (filter && !filter(entry, s)) continue;
    if (entry.isDirectory()) copyDir(s, d, filter);
    else copyFile(s, d);
  }
}

// ---- 0. 构建 ----
log('编译 TypeScript …');

// ---- 1. 清理 staging ----
// 保留其它发布物和当前版本的可回退副本，绝不删除整个 release。
if (path.dirname(staging) !== path.join(root, 'release')) throw new Error('staging 路径越界');
if (fs.existsSync(staging)) fs.renameSync(staging, `${staging}.backup-${Date.now()}`);
fs.mkdirSync(staging, { recursive: true });

// ---- 2. 复制运行所需文件（镜像源码树相对路径） ----
log('复制编译产物 / 绑定 / 运行时 …');
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json'), '--outDir', path.join(staging, 'mcp/dist')], { cwd: root, stdio: 'inherit', windowsHide: true });
copyFile(path.join(root, 'mcp', 'package.json'), path.join(staging, 'mcp', 'package.json')); // {"type":"module"} 作用域
copyFile(path.join(root, 'mcp', 'README.md'), path.join(staging, 'mcp', 'README.md'));
copyFile(path.join(root, 'doc', 'umouse-sdk.js'), path.join(staging, 'doc', 'umouse-sdk.js')); // koffi 绑定（原样）
// v2 语音链路绑定（typer.dll 随下方 lib/ 来源复制进入包内——缺项只降级对应能力，不谎报 ready）
copyFile(path.join(root, 'doc', 'typer.js'), path.join(staging, 'doc', 'typer.js'));
// v2 录音浮窗（不抢焦点）：安装即用组件，缺失即中止打包
// UMOUSE_PKG_VOICEUI_DIR：exe 来源目录覆盖（开源仓不含构建产物；指向含 umouse-voice-ui.exe 的本地目录）
const voiceUiSource = process.env.UMOUSE_PKG_VOICEUI_DIR
  ? path.join(path.resolve(process.env.UMOUSE_PKG_VOICEUI_DIR), 'umouse-voice-ui.exe')
  : path.join(root, 'mcp', 'voice-ui', 'target', 'release', 'umouse-voice-ui.exe');
if (!fs.existsSync(voiceUiSource)) {
  throw new Error(`浮窗 exe 缺失：${voiceUiSource}（开源仓打包须设 UMOUSE_PKG_VOICEUI_DIR 指向本地构建目录）`);
}
copyFile(voiceUiSource, path.join(staging, 'mcp', 'voice-ui', 'umouse-voice-ui.exe'));
copyFile(path.join(root, 'mcp', 'voice-ui', 'README.md'), path.join(staging, 'mcp', 'voice-ui', 'README.md'));
copyFile(                                                                            // 一键接入脚本（入口路径自适应包位置）
  path.join(root, 'mcp', 'scripts', 'install-agents.mjs'),
  path.join(staging, 'mcp', 'scripts', 'install-agents.mjs')
);
copyFile(path.join(root, 'mcp', 'scripts', 'transcribe-windows.ps1'), path.join(staging, 'mcp', 'scripts', 'transcribe-windows.ps1'));
// 可选宿主接入文档：仓库根 docs/ 存在此文件时才附带（本地文档，不入开源包）。
const hostIntegrationDoc = path.join(root, 'docs', 'audit-2026-10-12', 'sleep-voice', 'HOST-INTEGRATION.md');
if (fs.existsSync(hostIntegrationDoc)) {
  copyFile(hostIntegrationDoc, path.join(staging, 'docs', 'VOICE-HOST-INTEGRATION.md'));
}
// 运行时：dll + import 库；头文件目录对运行无用，不带
// UMOUSE_PKG_LIB_DIR：lib 来源覆盖（开源仓不含二进制；指向含 uMouseSdk.dll/typer.dll 的本地目录）
// 开源版剔除内嵌凭据的讯飞闭源 ASR 动态库与导入库（识别默认走 sinicloud 开放平台）
const libSource = process.env.UMOUSE_PKG_LIB_DIR ? path.resolve(process.env.UMOUSE_PKG_LIB_DIR) : path.join(root, 'lib');
if (!fs.existsSync(path.join(libSource, 'uMouseSdk.dll'))) {
  throw new Error(`lib 来源缺少 uMouseSdk.dll：${libSource}（开源仓打包须设 UMOUSE_PKG_LIB_DIR 指向本地 lib 目录）`);
}
copyDir(libSource, path.join(staging, 'lib'), (entry) => entry.name !== 'include' && entry.name !== 'AsrTools.dll' && entry.name !== 'uMouseSdk.lib');
// 许可合规三件套：开源仓根不带协议全文，随产物 zip 分发；从 UMOUSE_PKG_LICENSE_DIR 取，缺失即中止
const licSource = process.env.UMOUSE_PKG_LICENSE_DIR ? path.resolve(process.env.UMOUSE_PKG_LICENSE_DIR) : root;
for (const f of ['COPYING.LGPLv2.1', 'LICENSE.hidapi-bsd', 'THIRD_PARTY_LICENSES.txt']) {
  if (!fs.existsSync(path.join(licSource, f))) {
    throw new Error(`许可文件缺失：${path.join(licSource, f)}（开源仓不带协议全文，设 UMOUSE_PKG_LICENSE_DIR 指向含许可三件套的目录）`);
  }
  copyFile(path.join(licSource, f), path.join(staging, f));
}
// 开放平台试用凭据：随包分发（install-agents 首次安装时种入数据目录；正式使用可自行替换）
const asrCredSource = process.env.UMOUSE_PKG_ASR_CRED ? path.resolve(process.env.UMOUSE_PKG_ASR_CRED) : '';
if (!asrCredSource || !fs.existsSync(asrCredSource)) {
  throw new Error(`ASR 凭据来源缺失：${asrCredSource || '（未设 UMOUSE_PKG_ASR_CRED）'}（产物须携带开放平台试用凭据 sinicloud_asr.json）`);
}
copyFile(asrCredSource, path.join(staging, 'sinicloud_asr.json'));
// 独立仓库将二进制依赖的许可全文集中放在 licenses/。
if (fs.existsSync(path.join(root, 'licenses'))) {
  copyDir(path.join(root, 'licenses'), path.join(staging, 'licenses'));
}

// ---- 3. 生产依赖 ----
log('安装生产依赖（--omit=dev）…');
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(staging, 'package.json'),
  JSON.stringify(
    {
      name: 'umouse-mcp',
      version,
      private: true,
      description: 'Sonicloud uMouse SDK MCP server (self-contained, Windows x64)',
      dependencies: rootPkg.dependencies, // 只带运行依赖，devDependencies 不进包
    },
    null,
    2
  ) + '\n'
);
copyFile(path.join(root, 'package-lock.json'), path.join(staging, 'package-lock.json'));
execSync('npm ci --omit=dev --no-audit --no-fund --loglevel=error', {
  cwd: staging,
  stdio: 'inherit',
});

// win-x64 包裁剪：koffi 携带全平台预编译（约 26MB），仅保留 win32_x64（运行时按目录加载）
const koffiBuild = path.join(staging, 'node_modules', 'koffi', 'build', 'koffi');
if (fs.existsSync(koffiBuild)) {
  for (const plat of fs.readdirSync(koffiBuild)) {
    if (plat !== 'win32_x64') {
      fs.rmSync(path.join(koffiBuild, plat), { recursive: true, force: true });
    }
  }
  log('已裁剪 koffi 非 win32-x64 平台预编译');
}

// ---- 4. 启动器与说明 ----
fs.writeFileSync(
  path.join(staging, 'umouse-mcp.cmd'),
  [
    '@echo off',
    'rem Launch umouse-mcp server (stdio). MCP hosts can also use node + absolute path directly.',
    'node "%~dp0mcp\\dist\\index.js" %*',
  ].join('\r\n') + '\r\n'
);

fs.writeFileSync(
  path.join(staging, 'install-agents.cmd'),
  [
    '@echo off',
    'rem One-click MCP registration: zcode | zcode-project | agents | claude | cursor | all',
    'rem Default (no args) = zcode user scope. Remove with: install-agents.cmd --remove <target>',
    'node "%~dp0mcp\\scripts\\install-agents.mjs" %*',
    'pause',
  ].join('\r\n') + '\r\n'
);

fs.writeFileSync(
  path.join(staging, 'README.md'),
  `# umouse-mcp v${version}（Windows x64 自包含包）

解压即用，无需 npm install / 构建。要求：本机已装 Node.js ≥ 18（仅此一项）。


## 一键接入 agent（推荐）

双击 \`install-agents.cmd\`（默认接入 ZCode，用户级、所有工作区生效），或命令行指定目标：

\`\`\`bash
node mcp/scripts/install-agents.mjs zcode          # ZCode（默认）
node mcp/scripts/install-agents.mjs claude         # Claude Desktop
node mcp/scripts/install-agents.mjs cursor         # Cursor
node mcp/scripts/install-agents.mjs all            # 全部
node mcp/scripts/install-agents.mjs --remove zcode # 卸载
\`\`\`

安装后：ZCode 新开会话自动连接；Claude Desktop 完全重启；Cursor 重启窗口。
验证：对 agent 说 "调用 umouse_status"，应返回 sdkVersion 0.4.24。

## 手动接入（任一宿主）

宿主的 mcpServers 配置（args 路径按实际解压位置调整）：

\`\`\`json
{
  "mcpServers": {
    "umouse": {
      "command": "node",
      "args": ["C:\\\\解压路径\\\\umouse-mcp-win-x64\\\\mcp\\\\dist\\\\index.js"]
    }
  }
}
\`\`\`

命令行自检（应输出 stdio 等待日志后 Ctrl+C 退出）：

\`\`\`bash
node mcp/dist/index.js
\`\`\`

调试：\`npx @modelcontextprotocol/inspector node mcp/dist/index.js\`

## 给大模型的使用说明

模型侧无需额外文档：连接时 server 提供 instructions（总体说明），按设备能力动态开放的工具 description
即完整使用手册（参数 schema + 语义 + 注意事项）。典型能力与说法：

- **问状态/设备**："调用 umouse_status" / "列出在线鼠标"
- **Agent 语音问答**：umouse_voice_start 开启设备会议麦克风，就绪后提示用户说话；umouse_voice_wait 等待最终文字，umouse_voice_finish/cancel 控制结束。
- **语音键听写**：按住语音键、浮窗预览、松开后最终文字输入当前光标，不自动回车。旧 inbox 仅 UMSDK_VOICE=0 使用。
  Windows 默认 sinicloud（Sonicloud 开放平台流式识别，凭据配置见下方环境变量节）；也可选 windows-speech（本机离线）/ whisper-cpp / http。关麦未确认或音频不完整时不自动重试。
- **光标/键盘控制**（⚠️ 硬件级注入，真实作用于屏幕；需设备固件支持反向控制）：
  "光标向右移 200"、"双击左键"、"用 umouse_cursor_drag 拖拽"、"按 Ctrl+Enter"；
  精确落点用 "把光标移到 (960,300)" / "点击 (115,895)"（umouse_cursor_move_to / click_at，闭环定位实测误差 ≤3px）
- **设置**："把 DPI 设为 1600 档"（描述内含档位字节映射）

## 内容物

| 路径 | 内容 |
|---|---|
| \`install-agents.cmd\` | 一键接入 agent（默认 ZCode；参数见上） |
| \`umouse-mcp.cmd\` | 手动启动 server（stdio 自检用） |
| \`mcp/dist/\` | MCP server（编译产物，入口 index.js，按能力动态开放的 umouse_* 工具与 server instructions） |
| \`mcp/scripts/install-agents.mjs\` | 一键接入脚本本体 |
| \`mcp/scripts/transcribe-windows.ps1\` | 离线中文 WAV 识别，只读录音文件，不打开电脑麦克风 |
| \`mcp/voice-ui/umouse-voice-ui.exe\` | 录音浮窗（语音键按下时显示预览，不抢焦点） |
| \`sinicloud_asr.json\` | 开放平台 ASR 试用凭据（install-agents 首次安装时种入 ~/.umouse-mcp，可替换为自己的 key） |
${fs.existsSync(hostIntegrationDoc) ? '| `docs/VOICE-HOST-INTEGRATION.md` | 主动对话宿主适配库的接入设计、示例与边界 |' : ''}
| \`doc/umouse-sdk.js\` | uMouseSdk koffi 绑定（SDK 原样文件） |
| \`lib/\` | uMouseSdk.dll v0.4.24（含注入接口）+ FFmpeg(LGPL, 动态) + VC 运行库 |
| \`node_modules/\` | 生产依赖（@modelcontextprotocol/sdk、koffi、zod 及传递依赖） |
| 许可文件 | COPYING.LGPLv2.1 / LICENSE.hidapi-bsd / THIRD_PARTY_LICENSES.txt |

## 常用环境变量（前缀 UMSDK_）

- \`UMSDK_DATA_DIR\`（默认 \`~/.umouse-mcp\`）：WAV 录音/日志落点
- \`UMSDK_SPEECH_AUTO\`（默认 **1**）：语音键自动录音——按住说话松开即产出 speechCaptured 事件（含 WAV 路径）；设 0 后用 umouse_audio_record 手动模式
- UMOUSE_SLEEP_RESET_ENABLED（默认 1）：设备连接时及每 120 秒发送 0A 03 A2。当前设备不回包，UMOUSE_SLEEP_RESET_EXPECT_ACK 默认 0，不等待/不报 ACK 超时。
- UMOUSE_SLEEP_RESET_INTERVAL_MS（默认 120000）控制发送周期；仅其它明确支持应答的固件设 EXPECT_ACK=1 后，UMOUSE_SLEEP_RESET_ACK_TIMEOUT_MS（默认 5000）才启用，须小于发送周期。写入失败仍记录且不立即重发。
- UMSDK_ASR_PROVIDER：Windows 默认 sinicloud（Sonicloud 开放平台流式识别，纯 TS 无 DLL 依赖）；凭据经 <数据目录>/sinicloud_asr.json 注入，环境变量 UMSDK_ASR_APP_ID / UMSDK_ASR_API_KEY / UMSDK_ASR_API_SECRET（及 USER_ID / LANID / ENDPOINT / TOKEN_URL）覆盖文件值，每会话热读、换 key 不重启；凭据不入日志、不入仓库。其它系统默认 disabled；http 必须显式配置 UMSDK_ASR_ENDPOINT 才上传音频。
- 免费本地替代 whisper-cpp：配置 UMSDK_ASR_EXECUTABLE（whisper-cli 绝对路径）和 UMSDK_ASR_MODEL_PATH（多语言 ggml 模型绝对路径）。UMSDK_ASR_THREADS 默认 4；CPU 离线执行，不上传音频。Whisper 程序和模型不包含在本 ZIP 中，须另行部署；不要使用仅英语的 .en 模型识别中文。
- UMSDK_ASR_LANGUAGE（默认 zh-CN）、UMSDK_ASR_TIMEOUT_MS（默认 60000）；HTTP 可配置 UMSDK_ASR_MODEL、UMSDK_ASR_API_KEY（密钥仅放本地环境）。
- 转写收件箱位于数据目录 voice/inbox.json；最多 100 条记录、8 个待处理任务，未确认消息不自动淘汰，处理后须 ack。原始 WAV 按录音配额保留。
- \`UMSDK_INJECTION\`（默认 **1**）：光标/键盘注入工具面；设 0 整体隐藏
- \`UMSDK_INJECT_FRAME_MS\`（默认 40）/ \`UMSDK_INJECT_CLICK_MS\`（默认 50）：发送间隔，不代表设备执行时间；绝对定位单帧反馈最多等待 5s，总定位上限 20s/15 帧
- \`UMSDK_RAWFRAME_EVENTS\`（默认 0）：原始帧入事件流（联调观察注入 ACK 回执用）
- \`UMSDK_DEBUG\`（默认 0）：SDK 内部日志级别
- \`UMSDK_LIB_PATH\`：覆盖默认 DLL 路径（升级 SDK 时替换 lib/ 后无需改此项）

## 迭代配置与边界

- UMSDK_INJECT_KEYBOARD 默认 0；当前设备未验证键盘注入可用。
- UMSDK_INJECT_FEEDBACK_MS 默认 5000，范围 1000–60000；实际受定位 20s 总预算截断。
- UMSDK_TAKEOVER 默认 0：不会因工具发现进程启动而杀掉正在使用的连接。Windows 用内核管道锁保证一个 SDK，status.sdkOwnership=busy 的进程保持 MCP 可用并每秒等待；持有者退出后自动取得所有权。设 1 仅供明确的强制维护，会终止旧的活动连接。
- 返回 sent 只表示写入；静止后可能迟到，具体射频/接收器/USB 根因尚未确认。

## 快速验证清单

1. 宿主连接后问 agent："调用 umouse_status"——应返回 sdkVersion 0.4.24
2. 插入 2.4G 接收器 / 蓝牙配对后："列出在线设备"
3. "用 umouse_wait_voice 等我按住语音键说话"——松开后应返回 ready 和 text；默认 sinicloud 识别，须先配置开放平台凭据（sinicloud_asr.json，见环境变量节）。
4. （注入固件设备）"光标右移 100"——应看到屏幕光标真实移动
`
);

// ---- 5. 压缩 ----
log('压缩 zip …');
// 压缩 staging 目录本身（而非其内容 \*）：解压后得到单一顶层文件夹，不散装
const psQuote = value => `'${value.replace(/'/g, "''")}'`;
const compress = `$ProgressPreference = 'SilentlyContinue'; Compress-Archive -LiteralPath ${psQuote(staging)} -DestinationPath ${psQuote(zipPath)} -Force -ErrorAction Stop`;
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(compress, 'utf16le').toString('base64')], { stdio: 'inherit', windowsHide: true });

// ---- 6. 报告 ----
function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return total;
}
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
log(`完成：`);
log(`  目录 ${staging}（${mb(dirSize(staging))}）`);
log(`  压缩包 ${zipPath}（${mb(fs.statSync(zipPath).size)}）`);
log(`验证：UMOUSE_MCP_ENTRY=<上面目录>\\mcp\\dist\\index.js npm run smoke`);
