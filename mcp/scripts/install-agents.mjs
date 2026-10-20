/*
 * install-agents.mjs —— 一键把 umouse-mcp 接入各 agent 宿主
 *
 * 用法：
 *   node install-agents.mjs [target]        # 安装/更新（默认 zcode）
 *   node install-agents.mjs --remove [t]    # 卸载
 *
 * target：
 *   zcode         用户级 ZCode（~/.zcode/cli/config.json → mcp.servers）★默认
 *   zcode-project 当前项目 ZCode（<cwd>/.zcode/config.json → mcp.servers）
 *   agents        通用兼容（<cwd>/.agents/mcp.json → mcpServers）
 *   claude        Claude Desktop（%APPDATA%\Claude\claude_desktop_config.json → mcpServers）
 *   cursor        Cursor（~/.cursor/mcp.json → mcpServers）
 *   all           以上全部
 *
 * 特性：server 入口路径取自脚本自身位置（包放哪都行）；幂等 upsert；
 *       只动 "umouse" 一个键，其余配置原样保留。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 定位 server 入口：从脚本位置向上找 mcp/dist/index.js ----
function locateEntry() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'mcp', 'dist', 'index.js');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('未找到 mcp/dist/index.js（请先在工程根执行 npm run build，或确认包完整）');
}

const entry = locateEntry();

const TARGETS = {
  zcode: {
    desc: 'ZCode（用户级，所有工作区生效）',
    file: () => path.join(home(), '.zcode', 'cli', 'config.json'),
    keyPath: ['mcp', 'servers'],
  },
  'zcode-project': {
    desc: 'ZCode（项目级，随 <当前目录>/.zcode 共享给团队）',
    file: () => path.join(process.cwd(), '.zcode', 'config.json'),
    keyPath: ['mcp', 'servers'],
  },
  agents: {
    desc: '通用 .agents 兼容格式（当前目录）',
    file: () => path.join(process.cwd(), '.agents', 'mcp.json'),
    keyPath: ['mcpServers'],
  },
  claude: {
    desc: 'Claude Desktop',
    file: () =>
      path.join(process.env.APPDATA ?? path.join(home(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'),
    keyPath: ['mcpServers'],
  },
  cursor: {
    desc: 'Cursor（用户级）',
    file: () => path.join(home(), '.cursor', 'mcp.json'),
    keyPath: ['mcpServers'],
  },
};

function home() {
  return process.env.USERPROFILE ?? process.env.HOME ?? '.';
}

const SERVER_NAME = 'umouse';

function loadJson(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置根必须是 JSON 对象');
    return value;
  } catch (e) {
    throw new Error(`${file} 不是合法 JSON，为安全起见不改动（先修复该文件）：${e.message}`);
  }
}

function upsert(file, keyPath, value) {
  let root = loadJson(file);
  let node = root;
  for (const k of keyPath.slice(0, -1)) {
    if (node[k] === undefined) node[k] = {};
    if (!node[k] || typeof node[k] !== 'object' || Array.isArray(node[k])) throw new Error(`配置 ${k} 必须是对象，原文件未改动`);
    node = node[k];
  }
  const leaf = keyPath[keyPath.length - 1];
  if (node[leaf] === undefined) node[leaf] = {};
  if (!node[leaf] || typeof node[leaf] !== 'object' || Array.isArray(node[leaf])) throw new Error(`配置 ${leaf} 必须是对象，原文件未改动`);
  const existed = JSON.stringify(node[leaf][SERVER_NAME]) === JSON.stringify(value);
  if (existed) return true;
  node[leaf][SERVER_NAME] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(root, null, 2) + '\n');
  return existed;
}

function remove(file, keyPath) {
  if (!fs.existsSync(file)) return 'absent';
  const root = loadJson(file);
  let node = root;
  for (const k of keyPath) {
    if (typeof node !== 'object' || node[k] == null) return 'absent';
    node = node[k];
  }
  if (!(SERVER_NAME in node)) return 'absent';
  delete node[SERVER_NAME];
  fs.writeFileSync(file, JSON.stringify(root, null, 2) + '\n');
  return 'removed';
}

const args = process.argv.slice(2);
const removeMode = args[0] === '--remove';
const targetName = (removeMode ? args[1] : args[0]) ?? 'zcode';
const names = targetName === 'all' ? Object.keys(TARGETS) : [targetName];

if (!names.every((n) => TARGETS[n])) {
  console.error(`未知目标 "${targetName}"。可用：${Object.keys(TARGETS).join(' | ')} | all`);
  process.exit(1);
}

// ---- 包内默认 ASR 凭据：安装时种入数据目录（已存在则不覆盖）----
function seedDefaultCredentials() {
  const bundled = path.resolve(path.dirname(entry), '..', '..', 'sinicloud_asr.json');
  if (!fs.existsSync(bundled)) { console.log('[install] 包内未携带默认 ASR 凭据（跳过）'); return; }
  const dataDir = (process.env.UMSDK_DATA_DIR ?? '').trim() || path.join(home(), '.umouse-mcp');
  const target = path.join(dataDir, 'sinicloud_asr.json');
  if (fs.existsSync(target)) { console.log(`[install] ASR 凭据已存在，不覆盖：${target}`); return; }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(bundled, target);
  console.log(`[install] 已写入开放平台试用凭据：${target}`);
}
if (!removeMode) seedDefaultCredentials();

const serverEntry = { command: 'node', args: [entry] };

for (const name of names) {
  const t = TARGETS[name];
  const file = t.file();
  try {
    if (removeMode) {
      const r = remove(file, t.keyPath);
      console.error(`[${name}] ${r === 'removed' ? '已移除' : '本就未安装'} → ${file}`);
    } else {
      const existed = upsert(file, t.keyPath, serverEntry);
      console.error(`[${name}] ${existed ? '已是最新，无改动' : '已写入'} → ${file}`);
      console.error(`       ${SERVER_NAME}: node "${entry}"`);
    }
  } catch (e) {
    console.error(`[${name}] 失败：${e.message}`);
    process.exitCode = 1;
  }
}

if (!removeMode) {
  console.error(`
下一步：
  - ZCode：新开一个会话即自动连接（Settings → MCP 可查看状态）
  - Claude Desktop：完全退出应用后重启（托盘图标也要退）
  - Cursor：重启窗口后在下 Cursor 命令面板 → MCP 里可见
  - 验证：对 agent 说 "调用 umouse_status"，应返回 sdkVersion 0.4.22
  - 卸载：node install-agents.mjs --remove ${targetName}`);
}
