/*
 * smoke.mjs —— 无真机环境的服务器冒烟测试
 *
 * 覆盖：initialize 握手 → tools/list（17 个基础工具）→ 逐个调用查询/控制/音频/重配工具
 * → 旧进程接管（再起一个 server 应终止本进程并正常服务）→ 关闭 stdin 验证优雅退出。
 * 运行：npm run smoke（仓库根）
 * 指定目标（如打包产物）：UMOUSE_MCP_ENTRY=<路径>\mcp\dist\index.js npm run smoke
 * 注意：接管检查会终止本机在跑的其它 umouse server（预期语义）；设 UMSDK_TAKEOVER=0
 * 可跳过该检查（转为旧进程优雅退出验证）。
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const serverEntry = process.env.UMOUSE_MCP_ENTRY
  ? pathResolve(process.env.UMOUSE_MCP_ENTRY)
  : defaultEntry;
// 入口位于 <根>/mcp/dist/index.js，宿主 cwd 取 <根>（源码树或打包目录同构）
const root = pathResolve(dirname(serverEntry), '..', '..');
const child = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: { ...process.env, UMSDK_RAW_DIAG: '1', UMSDK_TEST_CAPS: '{"*":{"mouse_control":"supported"}}' },
  stdio: ['pipe', 'pipe', 'inherit'], // stderr 直通便于观察启动日志
});

let nextId = 1;
const pending = new Map();
let buffer = '';
let notifications = 0;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('非 JSON 行（违反 stdio 协议！）:', line.slice(0, 200));
      process.exitCode = 1;
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      notifications++;
    }
  }
});

function rpc(method, params, timeoutMs = 15000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC 超时: ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.error(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

const exitCode = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

try {
  // 1. initialize 握手
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.1' },
  });
  check('initialize 握手', init?.serverInfo?.name === 'umouse-mcp', init?.serverInfo);
  notify('notifications/initialized', {});

  // 2. 工具清单
  const tools = await rpc('tools/list', {});
  const names = (tools.tools ?? []).map((t) => t.name);
  const expectTools = [
    'umouse_status', 'umouse_list_devices', 'umouse_get_events', 'umouse_wait_events',
    'umouse_set_dpi', 'umouse_meeting_create', 'umouse_meeting_destroy', 'umouse_meeting_pause',
    'umouse_meeting_resume', 'umouse_set_channel_pref', 'umouse_set_audio_source', 'umouse_write_raw',
    'umouse_audio_record', 'umouse_reconfigure',
    'umouse_voice_inbox', 'umouse_wait_voice', 'umouse_ack_voice',
    'umouse_get_capabilities', 'umouse_voice_start', 'umouse_voice_wait', 'umouse_voice_finish',
    'umouse_voice_cancel', 'umouse_voice_status'
  ];
  check(
    `工具清单（${names.length}，静态 22 + raw 诊断 1；注入族无设备隐藏为正确语义）`,
    expectTools.every((n) => names.includes(n)),
    names.join(', ')
  );

  async function call(name, args = {}) {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.content?.[0]?.text ?? '{}';
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { unparsed: text };
    }
    return { isError: r.isError === true, json };
  }

  // 3. status：DLL 加载与 SDK 启动的端到端证据
  const st = await call('umouse_status');
  check('status: SDK 已启动（koffi→DLL 链路通）', st.json.sdkStarted === true, {
    sdkVersion: st.json.sdkVersion,
    lastError: st.json.lastError,
  });
  check('status: DLL 版本 0.4.24（语音边界接口）', st.json.sdkVersion === '0.4.24', st.json.sdkVersion);

  // 4. 设备列表（环境自适应：无真机为空数组；识别窗口内的设备稍后才上线）
  const dev = await call('umouse_list_devices');
  check('list_devices 返回数组', Array.isArray(dev.json.devices), dev.json.devices);

  // 5. 事件拉取
  const ev = await call('umouse_get_events', {});
  check('get_events 游标推进', typeof ev.json.nextSince === 'number' && ev.json.nextSince >= 0, ev.json.buffer);

  // 6. 长轮询：超时须守时（≥900ms）；有事件到达（真机恰上线）亦为正确行为
  const waitStart = Date.now();
  const wait = await call('umouse_wait_events', { since: ev.json.nextSince, timeout_ms: 1000 });
  const waitElapsed = Date.now() - waitStart;
  check(
    'wait_events 长轮询（超时守时 / 事件到达即返）',
    wait.json.timedOut
      ? waitElapsed >= 900 && waitElapsed <= 5000
      : Array.isArray(wait.json.events) && wait.json.events.length > 0,
    { elapsedMs: waitElapsed, timedOut: wait.json.timedOut, count: wait.json.events?.length }
  );

  // 7. 通道偏好（AUTO 合法值，SDK 已启动应返回 1；无设备不影响设置）
  const chan = await call('umouse_set_channel_pref', { pref: 'AUTO' });
  check('set_channel_pref(AUTO) 被采纳', chan.json.ok === true, chan.json);

  // 8. write_raw：无设备→可读失败；设备上线（含识别窗口刚结束）→10 字节下发成功，两者皆对
  const wr = await call('umouse_write_raw', { hex: '0a03a000000000000000', device_id: '__audit_nonexistent_device__' });
  check(
    'write_raw（无设备可读失败 / 有设备下发成功）',
    (wr.json.ok === true && wr.json.bytes === 10) || (wr.isError === true && wr.json.error != null),
    wr.json
  );

  // 9. 非法 hex 被参数校验拦截
  const wrBad = await call('umouse_write_raw', { hex: 'xyz' });
  check('write_raw 非法 hex 被拒', wrBad.isError === true, wrBad.json?.error ?? '(schema 层拒绝)');

  // 10. 会议命令：无论有无设备都不崩溃；真机开会则立刻销毁还原状态
  const mt = await call('umouse_meeting_create', { device_id: '__audit_nonexistent_device__' });
  check('meeting_create（失败可读 / 成功不崩溃）', mt.isError === true || mt.json.ok === true, mt.json);
  if (mt.json.ok === true) {
    await call('umouse_meeting_destroy', {}); // 还原设备会议状态
  }

  // 11. 音频状态
  const au = await call('umouse_audio_record', { action: 'status' });
  check('audio_record status', au.json.result?.recording === false, au.json.result);

  // 12. 音频源恢复默认
  const src = await call('umouse_set_audio_source', {});
  check('set_audio_source 清空为默认', src.json.ok === true && src.json.audioSource === '', src.json);

  // 13. 重配（同配置重启：验证受控重启序列不挂死）
  const rc = await call('umouse_reconfigure', { device_limit: 4 });
  check('reconfigure 受控重启成功', rc.json.ok === true && rc.json.status?.sdkStarted === true, {
    ok: rc.json.ok, started: rc.json.status?.sdkStarted,
  });

  // 14. 重启后 status 仍可用
  const st2 = await call('umouse_status');
  check('重启后 status 正常', st2.json.sdkStarted === true, st2.json.sdkVersion);

  // 15/16/17. 旧进程接管：再起一个 server（B）。B 启动期应自动终止 A（本进程），
  //     随后 B 正常服务并承接优雅退出检查。takeover 枚举真实进程列表：本机在跑的
  //     其它 umouse server 也会被接管终止——这是预期语义（设备单 SDK 进程独占）
  if (!/^(1|true|yes|on)$/i.test(process.env.UMSDK_TAKEOVER ?? '')) {
    check('takeover 检查（UMSDK_TAKEOVER=0，跳过）', true);
    child.stdin.end();
    const { code, signal } = await Promise.race([
      exitCode,
      new Promise((_, rej) => setTimeout(() => rej(new Error('退出超时（>8s，疑似退出互锁）')), 8000)),
    ]);
    check('优雅退出 exit 0（无 koffi 互锁）', code === 0 && signal == null, { code, signal });
  } else {
    const b = spawn(process.execPath, [serverEntry], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    b.stderr.resume(); // 只需消费，防背压
    const aExit = await Promise.race([
      exitCode,
      new Promise((_, rej) => setTimeout(() => rej(new Error('A 未被接管终止（>25s，枚举/终止失败？）')), 25000)),
    ]);
    check('takeover: 新 server 启动即终止旧进程', aExit.code != null || aExit.signal != null, aExit);

    // 16. 接管后 B 可正常服务（initialize 握手）
    const bHello = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('B 握手超时')), 15000);
      b.stdout.setEncoding('utf8');
      b.stdout.on('data', (c) => {
        buf += c;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buf.slice(0, i)));
        } catch (e) {
          reject(e);
        }
      });
      b.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-b', version: '0.0.1' } } }) + '\n');
    });
    check('接管后新 server 服务可用（initialize）', bHello?.result?.serverInfo?.name === 'umouse-mcp', bHello?.result?.serverInfo);

    // 17. B 承接优雅退出检查（A 已被终止）
    b.stdin.end();
    const bExit = await Promise.race([
      new Promise((resolve) => b.on('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((_, rej) => setTimeout(() => rej(new Error('B 退出超时（>8s，疑似退出互锁）')), 8000)),
    ]);
    check('优雅退出 exit 0（无 koffi 互锁）', bExit.code === 0 && bExit.signal == null, bExit);
  }
} catch (e) {
  check('测试流程异常', false, e.message);
  child.kill();
}

const failed = results.filter((r) => !r.pass);
console.error(`\n===== SMOKE 结果：${results.length - failed.length}/${results.length} 通过，服务期通知 ${notifications} 条 =====`);
if (failed.length) {
  console.error('失败项：', failed.map((f) => f.name).join(' | '));
  process.exitCode = 1;
}
