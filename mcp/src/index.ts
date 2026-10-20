/*
 * index.ts —— umouse-mcp server 入口（stdio transport）
 *
 * 启动序列：解析 env → 引导数据目录/chdir → 起 SDK bridge（失败不退出，
 * status 工具可见 lastError）→ 注册工具 → 连 stdio transport。
 * 关键事件同时以 notifications/message 尽力广播（主通道仍是工具轮询）。
 * 退出：SIGINT/SIGTERM/stdin 关闭 → bridge 严格退出序列 → exit 0。
 *
 * 注意：本进程 stdout 是 JSON-RPC 通道，任何诊断信息只写 stderr。
 */
import { createMcpServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './env.js';
import { SdkBridge } from './sdk-bridge.js';
import { takeoverOldProcesses, takeoverState } from './takeover.js';

async function main(): Promise<void> {
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(`[umouse-mcp] 配置错误：${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  // Legacy force takeover is opt-in only. Normal startup arbitrates SDK ownership without killing peers.
  takeoverState.enabled = cfg.takeover;
  if (cfg.takeover) {
    const t = await takeoverOldProcesses();
    if (t.note) console.error("[umouse-mcp] " + t.note);
    if (t.found.length) {
      console.error(
        `[umouse-mcp] 接管：已发送终止信号的旧 server 进程 [${t.killed.join(', ')}]` +
          (t.survivors.length ? `（未确认退出：${t.survivors.join(', ')}）` : '') +
          '——设备为单 SDK 进程独占'
      );
    }
  }

  const bridge = new SdkBridge(cfg);
  const startResult = await bridge.start();
  if (startResult.ok) {
    console.error(`[umouse-mcp] SDK 已启动：v${bridge.sdkVersion}`);
  } else {
    // 不退出：server 继续服务，umouse_status 可见错误，便于宿主诊断
    console.error(`[umouse-mcp] SDK 启动失败：${startResult.error}`);
  }

  const server = createMcpServer(bridge);

  let shuttingDown = false;
  let retrying = false;
  const retryOwner = setInterval(() => {
    if (shuttingDown || retrying || !bridge.waitingForSdk) return;
    retrying = true;
    void bridge.start().then(result => {
      if (result.ok) console.error(`[umouse-mcp] SDK 所有权已取得：PID ${process.pid}`);
    }).catch(() => {}).finally(() => { retrying = false; });
  }, 1000);
  retryOwner.unref();
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(retryOwner);
    console.error(`[umouse-mcp] 收到 ${signal}，执行退出序列`);
    void bridge.shutdown().then(() => {
      console.error('[umouse-mcp] SDK 退出序列完成');
      process.exit(0);
    }, (e) => {
      console.error('[umouse-mcp] SDK 退出失败', e);
      process.exit(1);
    });
  };
  const transport = new StdioServerTransport();
  transport.onclose = () => shutdown('transport close');
  process.stdin.once('end', () => shutdown('stdin EOF'));
  process.stdin.once('error', () => shutdown('stdin error'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  await server.connect(transport);
  console.error(
    `[umouse-mcp] stdio transport 就绪（PID ${process.pid}），等待宿主请求` +
      (cfg.takeover ? '；旧进程自动接管已开启（UMSDK_TAKEOVER=0 禁用）' : '；旧进程自动接管已禁用')
  );
}

main().catch((e) => {
  console.error(`[umouse-mcp] 致命错误：${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
