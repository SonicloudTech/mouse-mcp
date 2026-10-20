// uMouse 硬件鼠标能力实验室 — 全自动网页矩阵测试。
// 前置: MCP 客户端配置（manage.cmd config 输出的连接参数），硬件已连接，daemon 可达。
// 用法:
//   UMCFG=<安装目录>\clients\<id>.json UMBUNDLE=<发布包目录> node run-matrix.mjs [--keep]
// --keep 保留浏览器与服务进程便于人工查看。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8123', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const CFG = process.env.UMCFG, BUNDLE = process.env.UMBUNDLE;
const KEEP = process.argv.includes('--keep');
if (!CFG || !BUNDLE) { console.error('需要环境变量 UMCFG（MCP 客户端 json）与 UMBUNDLE（发布包目录）'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (path, opts) => { const r = await fetch(BASE + path, opts); return r.json(); };
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let evSeq = 0;
const newEvents = async () => { const { events, last } = await api(`/api/events?since=${evSeq}`); evSeq = last; return events; };

// ---- 1) 启动实验室服务与浏览器 -------------------------------------------------
// 端口已有实验室服务则复用（迭代调试便利）；残留的实验室 Edge 实例先清掉。
let server = null, externalServer = false;
try { const probe = await api('/api/targets'); if (probe && typeof probe === 'object') externalServer = true; } catch { /* not up */ }
if (!externalServer) {
  server = spawn(process.execPath, [join(HERE, 'lab-server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', () => {});
  server.stderr.on('data', d => console.error('[lab-server]', String(d).trim()));
}
try { execFileSync('powershell.exe', ['-NoProfile', '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*umouselab*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: 'ignore' }); } catch { /* best effort */ }
await sleep(600);
let up = false;
for (let i = 0; i < 30 && !up; i++) { try { await api('/api/targets'); up = true; } catch { await sleep(300); } }
if (!up) { console.error('lab server 未就绪'); process.exit(2); }
const msedge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!msedge) { console.error('未找到 Edge 浏览器'); process.exit(2); }
// 全新 profile：被强杀的旧 profile 会进入崩溃恢复态导致页面加载异常。
const profile = join(process.env.TEMP || '.', `umouselab-${Date.now()}`);
const edge = spawn(msedge, [`--app=${BASE}/`, '--window-position=60,150', '--window-size=700,880',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--no-proxy-server'], { stdio: 'ignore', detached: false });
let live;
for (let i = 0; i < 40 && !live?.zones?.length; i++) { try { live = (await api('/api/targets')).targets; } catch { live = null; } if (!live?.zones?.length) await sleep(500); }
if (!live?.zones?.length) { console.error('页面未上报目标坐标'); process.exit(2); }
const Z = Object.fromEntries(live.zones.map(z => [z.id, z]));
console.log(`lab 就绪 dpr=${live.calib.dpr} zones=${live.zones.map(z => z.id).join(',')}`);

// ---- 2) 连接 MCP 并执行矩阵 ------------------------------------------------------
const transport = new StdioClientTransport({ command: process.execPath, args: [`${BUNDLE}/mcp/dist/shared/connector.js`, CFG] });
const client = new Client({ name: 'mouse-capability-matrix', version: '1' });
client.onerror = () => {};
await client.connect(transport);
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(`${name}: ${r.content[0].text.slice(0, 300)}`); return JSON.parse(r.content[0].text); };
const waitRunning = async () => { for (let i = 0; i < 60; i++) { const s = await call('umouse_status', {}); if (s.state === 'running') return s; await sleep(500); } throw new Error('worker 未运行'); };
await waitRunning();
let devFound = null;
for (let i = 0; i < 30 && !devFound; i++) { const d = await call('umouse_list_devices', {}); if (d.length) devFound = d[0]; else await sleep(1000); }
const beg = await call('umouse_control', { operation: 'begin', task_id: 'mouse-capability-matrix' });
const ctl = beg.control_id, dev = devFound.id;

// 暖机：浏览器冷启动/锁屏恢复等输入桌面切换期间，动作会被安全拒绝
// （button_feedback_input_desktop_unavailable）。轮询一次良性移动直到就绪。
let warm = false;
for (let i = 0; i < 20 && !warm; i++) {
  try { const r = await call('umouse_mouse_action', { control_id: ctl, device_id: dev, client_request_id: `warm-${i}`, action: { kind: 'move', x: 300, y: 200 } }); warm = r.outcome === 'completed'; }
  catch { warm = false; }
  if (!warm) await sleep(1500);
}
if (!warm) { console.error('硬件反馈未就绪（输入桌面不可用：锁屏/UAC/启动切换期？）'); process.exit(2); }
console.log('hardware ready');

const rows = [];
let n = 0;
const act = async (group, name, action, verify) => {
  n++;
  let r = null, lastErr = null;
  // 输入桌面切换期（锁屏/UAC/浏览器冷启动）动作会被安全拒绝；耐心重试，
  // 其余错误快速重试一次。单项最终失败不终止整个套件。
  for (let attempt = 1; attempt <= 13 && !r; attempt++) {
    try { r = await call('umouse_mouse_action', { control_id: ctl, device_id: dev, client_request_id: `lab-${n}-a${attempt}`, action }); }
    catch (e) {
      lastErr = e;
      const msg = String(e.message);
      if (/button_feedback_input_desktop_unavailable/.test(msg)) { await sleep(2500); continue; } // 等待会话解锁
      if (/button_feedback_anomaly|button_feedback_device_ambiguous/.test(msg) && attempt < 3) { await sleep(1500); continue; }
      break;
    }
  }
  if (!r) {
    const row = { n, group, name, action: JSON.stringify(action), outcome: 'error', ms: 0, frames: 0, residual: '-', integrity: '-', cleanup: '-',
      pass: false, note: '执行失败: ' + (String(lastErr?.message).match(/"(?:errorCode|error)":"[a-z_]+"/)?.[0] ?? String(lastErr?.message ?? '').slice(0, 90)) };
    rows.push(row);
    return row;
  }
  const row = { n, group, name, action: JSON.stringify(action), outcome: r.outcome, ms: Math.round(r.timing.totalMs), frames: r.transport.attempted,
    residual: r.residual ? `${r.residual.dx},${r.residual.dy}` : '-', integrity: r.verification?.buttonIntegrity ?? '-', cleanup: r.cleanup };
  rows.push(row);
  await sleep(320);
  const ev = await newEvents();
  const verdict = verify ? verify(r, ev, row) : { pass: r.outcome === 'completed' };
  row.pass = !!verdict.pass; if (verdict.note) row.note = verdict.note;
  return row;
};

// 位移：真实悬停验证（enter 事件 = 光标真的到了页面该区域）
for (const id of ['zWheel', 'zLeft', 'zRight']) {
  await act('move', `hover-${id}`, { kind: 'move', x: Z[id].x, y: Z[id].y }, (r, ev) => {
    const hit = ev.some(e => e.type === 'enter' && e.zone === id.replace('z', '').replace('Wheel', 'wheel').replace('Left', 'left').replace('Right', 'right'));
    return { pass: r.outcome === 'completed' && hit, note: hit ? '页面收到 hover' : '未观测到 enter' };
  });
}
await act('move', 'far-desktop', { kind: 'move', x: 250, y: 900 });
await act('move', 'far-return', { kind: 'move', x: Z.zDouble.x, y: Z.zDouble.y });
await act('move', 'precision-high', { kind: 'move', x: Z.zBull.x, y: Z.zBull.y, precision: 'high' },
  (r) => ({ pass: r.outcome === 'completed' && Math.abs(r.residual.dx) <= 2 && Math.abs(r.residual.dy) <= 2, note: `resid ${r.residual.dx},${r.residual.dy}` }));

// 左/右/中键：页面计数验证
for (let i = 1; i <= 3; i++) await act('click-left', `left#${i}`, { kind: 'click', x: Z.zLeft.x, y: Z.zLeft.y },
  (r, ev) => { const k = ev.filter(e => e.type === 'click' && e.zone === 'left').length; return { pass: r.outcome === 'completed' && r.cleanup === 'release_confirmed' && k === 1, note: `页面 click x${k}` }; });
for (let i = 1; i <= 3; i++) await act('click-right', `right#${i}`, { kind: 'click', x: Z.zRight.x, y: Z.zRight.y, button: 'right' },
  (r, ev) => { const k = ev.filter(e => e.type === 'contextmenu').length; return { pass: r.outcome === 'completed' && k === 1, note: `页面 contextmenu x${k}` }; });
for (let i = 1; i <= 2; i++) await act('click-middle', `middle#${i}`, { kind: 'click', x: Z.zMiddle.x, y: Z.zMiddle.y, button: 'middle' },
  (r, ev) => { const k = ev.filter(e => e.type === 'auxclick').length; return { pass: r.outcome === 'completed' && k === 1, note: `页面 auxclick x${k}` }; });

// 双击：dblclick 事件 + 两次 click 间隔
for (let i = 1; i <= 2; i++) await act('click-double', `double#${i}`, { kind: 'click', x: Z.zDouble.x, y: Z.zDouble.y, count: 2 },
  (r, ev) => { const k = ev.filter(e => e.type === 'click' && e.zone === 'double'), d = ev.filter(e => e.type === 'dblclick').length;
    const itv = k.length === 2 ? (k[1].interval ?? "?") : "?";
    return { pass: r.outcome === 'completed' && k.length === 2 && d === 1, note: `clicks x${k.length} dbl x${d} interval ${itv}ms` }; });

// 滚轮：scrollTop 方向与幅度
const wheelState = async () => (await api('/api/state')).latest?.scrollTop ?? 0;
for (const [name, dir, amt] of [['down3-a', 'down', 3], ['down3-b', 'down', 3], ['up2', 'up', 2], ['down1', 'down', 1], ['up1', 'up', 1]]) {
  const before = await wheelState();
  await act('scroll', name, { kind: 'scroll', x: Z.zWheel.x, y: Z.zWheel.y, direction: dir, amount: amt });
  await sleep(250);
  const after = await wheelState(); const d = after - before;
  const row = rows[rows.length - 1];
  row.pass = row.outcome === 'completed' && d !== 0 && (dir === 'down' ? d > 0 : d < 0);
  row.note = `scrollTop ${before}→${after} (Δ${d})`;
}

// 拖拽：页面路径起点/终点/直线度（CSS 像素，按 dpr 换算预期位移）
const dpr = live.calib.dpr || 1;
const dragCase = async (name, dxPx, dyPx, precision) => {
  const x0 = Z.zDrag.x - 150, y0 = Z.zDrag.y, x1 = x0 + dxPx, y1 = y0 + dyPx;
  const before = ((await api('/api/state')).latest?.drags ?? []).length;
  await act('drag', name, precision ? { kind: 'drag', x: x0, y: y0, toX: x1, toY: y1, precision } : { kind: 'drag', x: x0, y: y0, toX: x1, toY: y1 });
  // 等待页面上报本次 dragEnd（mouseup 事件异步到达）。
  let dr = null;
  for (let i = 0; i < 8 && !dr; i++) {
    const st = (await api('/api/state')).latest;
    const all = st?.drags ?? [];
    if (all.length > before) dr = all.at(-1);
    else await sleep(150);
  }
  if (!dr) { rows[rows.length - 1].pass = false; rows[rows.length - 1].note = '页面无 dragEnd'; return; }
  const edx = Math.round((dr.end.x - dr.start.x) - dxPx / dpr), edy = Math.round((dr.end.y - dr.start.y) - dyPx / dpr);
  rows[rows.length - 1].pass = rows[rows.length - 1].outcome === 'completed' && Math.abs(edx) <= 6 && Math.abs(edy) <= 6 && dr.maxDev <= 3;
  rows[rows.length - 1].note = `位移偏差(${edx},${edy})css 采样${dr.samples} 直线度${dr.maxDev}px`;
};
await dragCase('drag-h', 220, 0);
await dragCase('drag-diag', 180, 40);
await dragCase('drag-high', 260, 0, 'high');

// 精度靶：precision:high 点击，页面报告落点与靶心距离
for (let i = 1; i <= 3; i++) {
  await act('precision', `bullseye#${i}`, { kind: 'click', x: Z.zBull.x, y: Z.zBull.y, precision: 'high' });
  const st = (await api('/api/state')).latest;
  const hit = st?.precision?.at(-1);
  rows[rows.length - 1].pass = rows[rows.length - 1].outcome === 'completed' && hit && hit.dist <= 2.5;
  rows[rows.length - 1].note = hit ? `落点偏差 ${hit.dist}px (${hit.dx},${hit.dy}) ${hit.ring}` : '无命中记录';
}

// 组合
await act('combo', 'move+click', { kind: 'move', x: 400, y: 200 });
await act('combo', 'combo-click', { kind: 'click', x: Z.zLeft.x, y: Z.zLeft.y },
  (r, ev) => { const k = ev.filter(e => e.type === 'click' && e.zone === 'left').length; return { pass: r.outcome === 'completed' && k === 1, note: `click x${k}` }; });
await act('combo', 'combo-dbl', { kind: 'click', x: Z.zDouble.x, y: Z.zDouble.y, count: 2 },
  (r, ev) => ({ pass: r.outcome === 'completed' && ev.some(e => e.type === 'dblclick'), note: 'dblclick 送达' }));
const wsBefore = await wheelState();
await act('combo', 'combo-drag', { kind: 'drag', x: Z.zDrag.x - 120, y: Z.zDrag.y, toX: Z.zDrag.x + 100, toY: Z.zDrag.y });
await act('combo', 'combo-scroll', { kind: 'scroll', x: Z.zWheel.x, y: Z.zWheel.y, direction: 'down', amount: 2 });
await sleep(250);
{ const st = (await api('/api/state')).latest; const row = rows[rows.length - 1];
  const now = st?.scrollTop ?? -1;
  row.pass = row.outcome === 'completed' && now > wsBefore && now >= 0; row.note = `scrollTop ${wsBefore}→${now}${now < 0 ? '（页面状态丢失）' : ''}`; }

// ---- 3) 收尾与报告 --------------------------------------------------------------
const finish = async code => {
  const pass = rows.filter(r => r.pass).length;
  const report = { at: new Date().toISOString(), total: rows.length, pass, fail: rows.length - pass, dpr, rows };
  try { writeFileSync(join(HERE, 'acceptance-report.json'), JSON.stringify(report, null, 1)); } catch { /* best effort */ }
  console.log(`TOTAL ${rows.length}  PASS ${pass}  FAIL ${rows.length - pass}`);
  for (const r of rows) console.log(`#${String(r.n).padStart(2)} [${r.group}] ${r.name.padEnd(16)} ${(r.outcome === 'completed' ? 'ok ' : '!' + r.outcome).padEnd(12)} ${String(r.ms).padStart(4)}ms ${r.frames}f resid(${r.residual}) ${r.pass ? 'PASS' : '**FAIL**'} | ${r.note ?? ''}`);
  if (!KEEP) {
    try { execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    if (server) server.kill();
  }
  process.exit(code ?? (pass === rows.length ? 0 : 1));
};
try {
  await call('umouse_control', { operation: 'end', control_id: ctl });
  await client.close();
} catch { /* still print the report */ }
await finish();
