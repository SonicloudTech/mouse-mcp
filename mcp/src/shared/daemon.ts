import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mouseActionSchema } from '../hardware-contract.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ClientRegistry, type ClientContext } from './client-registry.js';
import { NativeClient, NativeError, type NativeOptions } from './native-client.js';
import { NativeRuntime } from './native-runtime.js';
import { InputInFlightFlag, stateDirFromManifest, autoRecoveryEvidence, archiveRunMarker, archiveEvidenceFile } from './input-inflight.js';
import { WorkerSupervisor, type WorkerHandle } from './worker-supervisor.js';
import { IdleLifecycle } from './idle-exit.js';
import { OperationRegistry } from './operation-registry.js';
import { SocketTransport } from './socket-transport.js';
import type { BridgeConfig } from '../env.js';
import { PIPE_PROTOCOL, keyId, isNonce, proof, validProof } from './pipe-auth.js';
import { OutputBudget } from './output-budget.js';
import { PeerCheckQueue } from './peer-check-queue.js';
import { guardHttpOutput } from './http-output.js';
import { inputSequenceSchema } from './input-sequence.js';
import { DiagnosticLog } from './diagnostics.js';

export interface Principal { id: string; tokenSha256: string; permissions: string[] }
export interface DaemonOptions {
  port: number; pipe: string; native: NativeOptions; bridge: BridgeConfig; principals: Principal[];
  configFile?: string;
  /** Explicit offline profile, only accepted with a native fake-only manifest. */
  testing?: boolean;
  /** Shortened only by isolated transport tests; production uses a fixed 60s absolute bound. */
  testHttpResponseTimeoutMs?: number;
}
interface Connection {
  ctx: ClientContext; server: McpServer; transport: Transport; replies: Set<http.ServerResponse>;
  discovery: { requests: number; pending: number; lastWaitMs?: number; timedOut?: boolean; lastTools?: string[] };
}
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const execIdentity = promisify(execFile);
export class SharedDaemon {
  readonly registry = new ClientRegistry();
  readonly supervisor: WorkerSupervisor;
  private runtime?: NativeRuntime;
  private operations = new OperationRegistry();
  private connections = new Map<string, Connection>();
  private httpSessions = new Map<string, Connection>();
  private inputTools = new Map<string, string[]>();
  private outputBudget=new OutputBudget();
  private httpReplies=new Map<string,http.ServerResponse>();
  private httpInFlight=new WeakMap<net.Socket,number>();
  private activeHttp=0;
  private sockets = new Set<net.Socket>();
  private rawSockets = new Set<net.Socket>();
  private httpServer: http.Server;
  private pipeServer: net.Server;
  private sweep?: NodeJS.Timeout;
  private stopping = false;
  private maintenance = false;
  private idle: IdleLifecycle;
  private inflight?: InputInFlightFlag;
  private peerChecks = new WeakMap<net.Socket, Promise<boolean>>();
  private peerCheckQueue = new PeerCheckQueue();
  private trace?: DiagnosticLog;

  constructor(readonly options: DaemonOptions) {
    if (!!options.testing !== (options.native.testing === true)) throw new Error('test_profile_mismatch');
    if (options.testHttpResponseTimeoutMs !== undefined && (!options.testing || !Number.isInteger(options.testHttpResponseTimeoutMs) || options.testHttpResponseTimeoutMs < 1)) throw new Error('invalid_test_http_timeout');
    if (!options.testing && !options.native.expectedIdentity) throw new Error('windows_identity_required');
    if (!Number.isInteger(options.port) || options.port < (options.testing ? 0 : 1024) || options.port > 65535) throw new Error('invalid_port');
    if (!options.pipe.startsWith('\\\\.\\pipe\\umouse-mcp-')) throw new Error('invalid_pipe_name');
    const ids = new Set(); const hashes = new Set();
    for (const p of options.principals) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(p.id) || !/^[0-9a-f]{64}$/.test(p.tokenSha256) || ids.has(p.id) || hashes.has(keyId(p.tokenSha256))) throw new Error('invalid_principal');
      ids.add(p.id); hashes.add(keyId(p.tokenSha256));
    }
    this.supervisor = new WorkerSupervisor(() => new NativeClient(options.native), {
      ready: async (client, info) => {
        if (options.testing) return;
        const stateDir = stateDirFromManifest(options.native.manifest);
        this.inflight = new InputInFlightFlag(path.join(stateDir, 'input-in-flight.json'));
        this.runtime = new NativeRuntime(client, info, options.bridge, (owner, metadata) => {
          const conn = this.connections.get(owner);
          if (conn) void conn.server.sendLoggingMessage({ level: 'info', logger: 'umouse-voice', data: metadata }).catch(() => {});
        }, () => {}, this.inflight);
        try {
          await this.runtime.start();
        } catch (error) {
          // 分级自动恢复：worker 曾被强杀（sdk-running.json 残留）时，movement-only
          // 证据（纯移动批次，光标读数即真相）随运行标记一起归档后重试；按键
          // 嫌疑证据不在启动阶段拦截，重启后交由 verifyRecoveredInput 验证。
          if (!(error instanceof NativeError) || error.code !== 'previous_worker_exit_unclean') throw error;
          const evidence = autoRecoveryEvidence(stateDir, options.bridge.sharedSafetyDir ?? options.bridge.dataDir);
          if (!fs.existsSync(evidence.runMarker)) throw error;
          const archived = archiveRunMarker(evidence);
          const clearedAuto = evidence.autoClearable.map(archiveEvidenceFile).filter((x): x is string => !!x);
          // 归档的同时清掉本 runtime 启动时预加载的内存诊断，避免状态误报。
          if (clearedAuto.length) this.runtime.input.acknowledgeRecovered();
          this.trace?.record('worker.autoRecover', { archived, clearedAuto, verifyRequired: evidence.verifyRequired, stateDir: evidence.stateDir });
          await this.runtime.start();
        }
        await this.verifyRecoveredInput(client, stateDir);
      },
      beforeStop: async () => { await this.runtime?.stop(); this.runtime = undefined; },
      lost: () => { const old = this.runtime; this.runtime = undefined; this.backgroundCleanup(old?.stop()); },
    });
    // 连接驱动空闲（两段式）：N=0 持续 idleWorkerMs 回收 worker，持续 idleExitMs 自退。
    // 常规 N=0 不再立即停 SDK——宽限内的客户端重连（重启/会话切换）不打断设备连接。
    this.idle = new IdleLifecycle({ workerGraceMs: options.bridge.idleWorkerMs, exitMs: options.bridge.idleExitMs }, {
      retireWorker: () => {
        if (this.maintenance || this.stopping) return;
        // 启动即空闲（无人连入）时没有可回收的东西；不触发收尾调用与 workerRetire 记录。
        if (!this.runtime && !this.supervisor.status.pid) return;
        this.trace?.record('idle.workerRetire', { connections: this.registry.count });
        this.backgroundCleanup(this.runtime?.stop());
        this.supervisor.setCount(0);
      },
      // 自退兜底：维护态、握手未完成的连接、在途 admin 请求、worker 进程仍存活时不退。
      readyToExit: () => !this.maintenance && !this.stopping && this.registry.size === 0 && this.activeHttp === 0 && !this.supervisor.status.pid,
      exit: () => {
        this.trace?.record('idle.exit', { connections: this.registry.count, epoch: this.registry.epoch });
        console.error('[umouse-shared] idle exit: no MCP connections left; connectors relaunch on demand');
        void this.close().then(() => process.exit(0), () => process.exit(0));
      },
      onTransition: stage => this.trace?.record(stage),
    });
    this.registry.on('change', n => {
      if (n > 0) this.supervisor.setCount(n);
      if (!this.maintenance && !this.stopping) this.idle.update(n);
    });
    this.registry.on('closed', (ctx: ClientContext) => {
      this.backgroundCleanup(this.runtime?.releaseOwner(ctx.connectionId));
      this.operations.close(ctx.connectionId);
      this.inputTools.delete(ctx.connectionId);
      const c = this.connections.get(ctx.connectionId); this.connections.delete(ctx.connectionId);
      if (c) {
        for (const [id, entry] of this.httpSessions) if (entry === c) this.httpSessions.delete(id);
        for (const reply of c.replies) if (!reply.writableFinished) reply.destroy();
        void c.server.close().catch(() => {});
      }
    });
    this.httpServer = http.createServer((req, res) => { void this.handleHttp(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
    this.httpServer.requestTimeout = 35_000; this.httpServer.headersTimeout = 10_000; this.httpServer.maxHeadersCount = 64;
    this.httpServer.on('connection', s => { this.rawSockets.add(s); if (this.rawSockets.size > 128) s.destroy(); s.once('close', () => this.rawSockets.delete(s)); });
    this.pipeServer = net.createServer(s => this.acceptConnector(s));
  }
  get address(): { port: number; pipe: string } { return { port: (this.httpServer.address() as net.AddressInfo).port, pipe: this.options.pipe }; }
  private backgroundCleanup(pending?: Promise<void>): void {
    void pending?.catch(() => { this.maintenance = true; this.idle.cancel(); this.registry.closeAll(); this.supervisor.setCount(0); });
  }
  /**
   * 按键嫌疑证据的启动验证：全键扫描 → 至多一次零按钮/零键位释放帧 → 复验。
   * 全部抬起才归档证据（.auto-recovered-*，保留字节）；仍按下（人为按住或固件
   * 卡键）不拦截 worker——新动作本就有新鲜基线守卫，物理释放后下一次成功动作
   * 或重扫即自愈，人工 recover 仅保留给真正的固件卡键场景。
   */
  private async verifyRecoveredInput(client: { request: (plugin: string, operation: string, args: object) => Promise<unknown> }, stateDir: string): Promise<void> {
    const evidence = autoRecoveryEvidence(stateDir, this.options.bridge.sharedSafetyDir ?? this.options.bridge.dataDir);
    if (!evidence.verifyRequired.length) return;
    const cleanup = await client.request('umouse', 'input.cleanup', {}).catch(() => undefined) as { allReleased?: boolean; sentMouse?: boolean; sentKeyboard?: boolean } | undefined;
    if (!cleanup || cleanup.allReleased !== true) {
      this.trace?.record('worker.recoverVerify', { verifyRequired: evidence.verifyRequired, allReleased: cleanup?.allReleased, note: 'buttons observed down; per-action baselines remain the guard' });
      return;
    }
    const cleared = evidence.verifyRequired.map(archiveEvidenceFile).filter((x): x is string => !!x);
    this.runtime?.input.acknowledgeRecovered();
    this.trace?.record('worker.recoverVerify', { cleared, sentMouse: cleanup.sentMouse, sentKeyboard: cleanup.sentKeyboard, allReleased: true });
  }
  private authenticate(token: string): Principal | undefined {
    if (token.length < 32 || token.length > 256) return;
    const hash = createHash('sha256').update(token).digest();
    return this.options.principals.find(p => timingSafeEqual(hash, Buffer.from(p.tokenSha256, 'hex')));
  }
  private active(c: ClientContext, permission?: string): void { this.registry.assertActive(c, permission); }
  private createConnection(p: Principal, mode: ClientContext['mode'], transport: Transport): Connection {
    if (this.stopping || this.maintenance) throw new Error('service_stopping');
    if (!this.options.principals.includes(p) || p.permissions.includes('admin')) throw new Error('principal_not_admitted');
    const ctx = this.registry.open(p.id, mode, p.permissions);
    const server = new McpServer({ name: 'umouse-mcp', version: '0.2.0-shared' }, { capabilities: { logging: {} }, instructions:
      'uMouse 共享硬件服务——一只真实的硬件鼠标加诚实的读数。先调用 umouse_status 和 umouse_list_devices 确认设备与能力。' +
      '任务开始调用 umouse_control begin；输入携带 control_id，任务结束调用 end。单次动作失败不封禁本任务。' +
      '鼠标像真鼠标一样在桌面坐标系（含多屏与负坐标）自由移动：点哪里、目标对不对由你依据回执判断（落点顶层窗口、执行时前台、按键边沿、释放状态都在回执里），服务不做窗口/前台/遮挡限制。' +
      '绝对坐标动作（move/click/scroll/drag，count 可 1..3）用 umouse_mouse_action，内部闭环移动并校验按键与释放；相对帧和键盘 HID 用 umouse_input_sequence。' +
      'umouse_input_status 只读返回光标、按键实时状态与前台窗口身份；本服务不提供截图、UIA、窗口控制或自动定位。' +
      'pid/window_id 仅是回执意图标注，不是限制。全部输入走硬件 SDK；同一逻辑请求重试须保持 client_request_id 和参数；未知效果不重放，须先核实实际状态。' +
      '语音问答用 voice_start/wait/finish/cancel，会话只属于当前连接；物理语音键用于听写，不自动回车。连接断开不重放操作。'  });
    // This deployment uses a fixed per-principal tool catalog. Hardware readiness
    // gates execution, never tool discovery; hosts may cache the first list.
    server.sendToolListChanged = () => {};
    const conn: Connection = { ctx, server, transport, replies: new Set(), discovery: {requests:0,pending:0} }; this.connections.set(ctx.connectionId, conn);
    // Install before transport.start processes buffered initialize/initialized/list messages.
    // Discovery never waits for SDK startup or device capability resolution.
    const startTransport=transport.start.bind(transport);
    transport.start=async()=>{
      this.trace ??= new DiagnosticLog(this.options.native.diagnosticsDirectory);
      const receive=transport.onmessage;
      transport.onmessage=(message,extra)=>{
        if ('method' in message && message.method==='tools/call' && 'id' in message) {
          const p=message.params as {name?:unknown;arguments?:{client_request_id?:unknown}} | undefined;
          this.trace?.record('mcp.call.received',{connectionId:ctx.connectionId,mcpId:message.id,tool:p?.name,traceId:p?.arguments?.client_request_id});
        }
        if (!('method' in message) || message.method!=='tools/list' || !('id' in message)) {receive?.(message,extra);return;}
        const reject=(reason:string)=>transport.send({jsonrpc:'2.0',id:message.id,error:{code:-32001,message:reason}}).catch(()=>{this.registry.close(ctx,'discovery_write_failed');});
        conn.discovery.requests++;
        // The MCP SDK dispatches notifications in a microtask. A single socket
        // chunk may contain initialized followed by tools/list; check admission
        // in that same message order instead of overtaking the notification.
        // A list before initialized still rejects; this does not wait for SDK startup.
        queueMicrotask(()=>{
          try {
            this.active(ctx);
            Object.assign(conn.discovery,{lastWaitMs:0,timedOut:false});
            receive?.(message,extra);
          } catch(e) {void reject(e instanceof Error?e.message:'connection_expired');}
        });
      };
      await startTransport();
    };
    const originalSend=transport.send.bind(transport);
    transport.send=async(message,sendOptions)=>{
      if ('id' in message && !('method' in message)) this.trace?.record('mcp.response.send',{connectionId:ctx.connectionId,mcpId:message.id});
      if ('result' in message && message.result && typeof message.result==='object' && 'tools' in message.result && Array.isArray(message.result.tools))
        conn.discovery.lastTools=message.result.tools.map(t=>t && typeof t==='object' && 'name' in t ? String(t.name) : '').filter(Boolean);
      const size=Buffer.byteLength(JSON.stringify(message));
      let release:()=>void;
      try { if(size>9*1024*1024)throw new Error('response_size_limit');release=this.outputBudget.reserve(size); }
      catch(e){this.registry.close(ctx,'output_backpressure');throw e;}
      const response='id' in message&&!('method' in message)?this.httpReplies.get(`${ctx.connectionId}:${JSON.stringify(message.id)}`):undefined;
      if(response&&!response.writableFinished&&!response.destroyed){response.once('finish',release);response.once('close',release);}
      try{await originalSend(message,sendOptions);}catch(e){release();throw e;}
      finally{if(!response||response.writableFinished||response.destroyed)release();}
    };
    server.server.oninitialized = () => { try { this.registry.initialized(ctx); } catch { void server.close(); } };
    server.server.onclose = () => this.registry.close(ctx, 'transport_closed');
    const tool = (name: string, description: string, schema: z.ZodRawShape, permission: string | undefined, action: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown> | unknown) => {
      server.tool(name, description, schema, async (args, extra) => {
        try { this.active(ctx, permission); const value = await action(args, extra.signal); this.active(ctx); return result(value); }
        catch (e) { return { ...result({ ok: false, error: e instanceof Error ? e.message : 'operation_failed' }), isError: true }; }
      });
    };
    tool('umouse_status', '服务与设备总状态：state/worker 是 SDK 就绪情况；control 是当前任务独占权；inputUncertain/Scopes 是历史未知结果，仅作诊断，不封禁后续新指令；inputCapabilitiesReady/availableInputTools 是可用输入路径；voice 是独立语音健康。', {}, undefined, () => ({ daemonEpoch: this.registry.epoch, servicePid: process.pid, connectionId: ctx.connectionId,
      liveness: ctx.mode, ...this.supervisor.status, sdkVersion: this.runtime?.sdkVersion,
      hardwareInput: this.options.bridge.injection ? 'native_hardware_capability_gated' : 'disabled', inputUncertain: this.runtime?.input.hasUncertainty
        ?? fs.existsSync(path.join(this.options.bridge.sharedSafetyDir ?? this.options.bridge.dataDir, 'shared-v2', 'input-uncertain.json')),
      inputUncertainScopes: this.runtime?.input.uncertainScopes ?? null,
      inputPolicy: 'task-exclusive-no-fault-latch', control: this.runtime?.input.control.status(ctx.connectionId) ?? null,
      voice: this.runtime?.voiceHealth ?? { enabled: this.options.bridge.voiceEnabled, runtimeReady: false, reason: `sdk_${this.supervisor.state}` },
      availableInputTools: this.inputTools.get(ctx.connectionId) ?? [],
      inputCapabilitiesReady: {mouse:!!this.runtime?.input.canInput,sequence:!!this.runtime?.input.canSequence},
      toolDiscovery: {mode:'static',...conn.discovery} }));
    tool('umouse_list_devices', '列出在线 uMouse 设备（USB/BLE）、连接模式与硬件能力画像：每台设备的 mouse_control / keyboard_control 支持度，硬件输入工具的可用性以此门控。只读，不发送输入。', {}, 'device.read', () => this.runtime?.listDevices() ?? []);
    if (p.permissions.includes('device.read')) tool('umouse_input_status',
      '只读读数传感器：当前光标物理坐标、按键实时状态（鼠标左右中/侧键与修饰键，GetAsyncKeyState 全键扫描）和前台窗口 pid/windowId/矩形，以及输入保护与任务控制状态。闭环移动、效果复核、无卡键验证都用它；只报告、不拦截。不枚举窗口、不读取 UIA、不截图、不发送输入。', {}, 'device.read', async () => {
        const runtime = this.requireRuntime();
        return { ...await runtime.client.request<object>('umouse', 'input.status', {}), blockedScopes: runtime.input.blockedScopes,
          uncertainScopes: runtime.input.uncertainScopes, control: runtime.input.control.status(ctx.connectionId) };
      });
    if (this.options.bridge.injection && p.permissions.includes('input.control')) {
      tool('umouse_control', '整个任务持续独占键鼠反控（同一物理鼠标同一时间只由一个任务驾驶）。开始任务调用 begin 并传 task_id（任务唯一标识），保存返回的 control_id；每次鼠标或键盘输入都必须带该令牌。观察、思考及动作失败期间不释放。明确结束调用 end；断线自动收尾并释放。其他连接或任务不能抢占；语音采集独立。status 只读。',
        { operation: z.enum(['begin', 'status', 'end']), task_id: z.string().min(1).max(128).optional(), control_id: z.string().uuid().optional() },
        'input.control', async args => {
          this.registry.activeLease(ctx);
          const input = this.requireRuntime().input;
          if (args.operation === 'status') return input.control.status(ctx.connectionId);
          if (args.operation === 'begin') {
            if (!args.task_id || args.control_id) throw new Error('task_id_required_without_control_id');
            return input.beginControl(ctx.connectionId, String(args.task_id));
          }
          if (!args.control_id || args.task_id) throw new Error('control_id_required_without_task_id');
          return input.endControl(ctx.connectionId, String(args.control_id));
        });
      const registerInput = (name: string, description: string, schema: z.ZodRawShape, mouse: boolean) => {
        server.tool(name, description, schema, async (args, extra) => {
          try {
            this.active(ctx, 'input.control'); this.registry.activeLease(ctx);
            const value = await this.operations.run(ctx.connectionId, `${name}:${args.client_request_id}`, args, async () => {
              this.active(ctx, 'input.control'); const runtime = this.requireRuntime();
              if (!(mouse ? runtime.input.canInput : runtime.input.canSequence)) throw new Error('capability_unavailable');
              return mouse ? runtime.input.runMouse(ctx.connectionId, args, extra.signal) : runtime.input.runSequence(ctx.connectionId, args, extra.signal);
            });
            this.active(ctx);
            return { ...result(value), ...(value && typeof value === 'object' && 'outcome' in value && value.outcome !== 'completed' ? { isError: true } : {}) };
          } catch (e) { return { ...result({ ok: false, error: e instanceof Error ? e.message : 'input_failed', retryAutomatic: false }), isError: true }; }
        });
      };
      registerInput('umouse_mouse_action',
        '先用 umouse_control begin 取得任务独占权，每次传 control_id。直接执行一个硬件鼠标动作：action.kind=move/click/scroll/drag；x/y 是桌面物理像素坐标（多屏含负坐标），不是截图坐标。' +
        'click 支持 button=left/right/middle、count=1..3；scroll 使用 direction=up/down、amount=1..10；drag 由 x/y 拖到 toX/toY。' +
        'device_id 为设备 SN。pid/window_id 仅作回执意图标注，不做窗口限制——像真鼠标一样想点哪点哪。回执 windowContext 报告落点顶层窗口与执行时前台，供你核对。最长20秒。' +
        '原生宿主检查光标、持续持键和释放，不代表应用业务成功（effectConfirmed=false）。未知效果禁止自动重放；同一请求重试保持 client_request_id 与参数。',
        mouseActionSchema.shape, true);
      registerInput('umouse_input_sequence',
        '先用 umouse_control begin 取得任务独占权，每次传 control_id。直接发送有界硬件键鼠帧序列：相对鼠标移动、按钮、滚轮或 HID 键盘按键组合；全部输入经 SDK 0xF0/0xF1。' +
        'device_id 为 SN；frames 每项 kind=mouse/keyboard。mouse:buttons=0..7,dx/dy/wheel=-127..127；keyboard:keys=4..231且最多6个、modifiers=0..255。' +
        'delay_ms 默认30，范围20..100；最多128帧，结束自动发送释放。pid/window_id 同时可选，省略时执行开始锁定前台窗口。' +
        '每帧检查设备代次；返回仅为写入结果，effectConfirmed=false，释放写入不等于物理释放确认。需要按键反馈校验的常规鼠标动作优先用 umouse_mouse_action。' +
        '未知效果不自动重放；重试保持 client_request_id 与参数。同一任务可用新的请求显式发送 mouse buttons=0 或 keyboard keys=[],modifiers=0 释放残留；释放写入后仍需核对实际状态。', inputSequenceSchema.shape, false);
      this.inputTools.set(ctx.connectionId, ['umouse_control', 'umouse_mouse_action', 'umouse_input_sequence']);
    }
    if (p.permissions.includes('voice')) {
      tool('umouse_voice_start', '开启一次 Agent 语音会话：麦克风采集→ASR→识别文字以工具结果返回（不直接打字）。返回 session_id，随后用 umouse_voice_wait 等待、umouse_voice_finish 结束收尾、umouse_voice_cancel 丢弃。同一时刻仅一个会话且只属于当前连接；物理语音键听写是独立链路，不经此工具。',
        { prompt: z.string().max(2000).optional().describe('会话用途备注（可选）'), device_id: z.string().max(256).optional().describe('设备 SN（单在线设备可省略）'), end_mode: z.enum(['vad_or_manual', 'manual_only']).optional().describe('结束方式：vad_or_manual=静音自动结束；manual_only=仅手动 finish'), client_request_id: z.string().min(1).max(128).describe('幂等键：同一逻辑请求重试必须复用同一值') }, 'voice', (args, signal) => {
        const runtime = this.requireRuntime();
        return this.operations.run(ctx.connectionId, String(args.client_request_id), args, async () => {
          this.active(ctx, 'voice'); if (signal.aborted) throw new Error('cancelled');
          this.registry.activeLease(ctx);
          const abort = () => { this.backgroundCleanup(runtime.releaseVoiceOwner(ctx.connectionId)); };
          signal.addEventListener('abort', abort, { once: true });
          try { return await runtime.voiceStart(ctx.connectionId, { prompt: args.prompt as string | undefined, deviceId: args.device_id as string | undefined,
            endMode: args.end_mode as 'vad_or_manual' | 'manual_only' | undefined, clientRequestId: String(args.client_request_id) }); }
          finally { signal.removeEventListener('abort', abort); }
        });
      });
      const voiceDescriptions: Record<string, string> = {
        wait: '阻塞等待语音会话推进（新识别文字、状态变化或终结），最多 wait_ms 毫秒；返回含最新识别文字的会话快照。',
        finish: '结束语音会话并收尾：触发最终识别与资源清理，返回终态与完整文字。',
        cancel: '取消语音会话并丢弃未落定内容；已进入打字交付的文字不可撤回。',
        status: '查询语音会话当前快照（状态、时长、已识别文字），不阻塞。',
      };
      for (const op of ['wait', 'finish', 'cancel', 'status'] as const) tool(`umouse_voice_${op}`, voiceDescriptions[op],
        { session_id: z.string().max(128).describe('umouse_voice_start 返回的会话 ID'), ...(op === 'wait' ? { wait_ms: z.number().int().min(100).max(25000).optional().describe('最长阻塞毫秒数，默认 25000') } : {}) }, 'voice', async args => {
        const r = this.requireRuntime(); const id = String(args.session_id); r.ownedSession(ctx.connectionId, id); this.registry.activeLease(ctx);
        if (op === 'wait') return r.voice.voiceWait(id, Number(args.wait_ms ?? 25000));
        if (op === 'finish') return r.voice.voiceFinish(id);
        if (op === 'cancel') return r.voice.voiceCancel(id);
        return r.voice.status(id);
      });
    }
    if (this.options.testing) tool('umouse_test_echo', '测试回显（test profile 专用）。', { value: z.string().max(10000) }, 'test', args => this.supervisor.worker.request('fake', 'echo', args));
    // McpServer's first tool registration sets listChanged=true. Override it
    // through the public API after registration and before transport.connect.
    server.server.registerCapabilities({tools:{listChanged:false}});
    return conn;
  }
  private requireRuntime(): NativeRuntime { void this.supervisor.worker; if (!this.runtime) throw new Error('runtime_unavailable'); return this.runtime; }
  private async body(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const part of req) { const b = Buffer.from(part); size += b.length; if (size > 1024 * 1024) throw new Error('body_limit'); chunks.push(b); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Bound outstanding bodies/responses, including HTTP pipelining on a slow socket.
    const inflight=this.httpInFlight.get(req.socket)??0;
    if(inflight>=8||this.activeHttp>=(req.url==='/admin'?64:60)){req.socket.destroy();return;}
    this.httpInFlight.set(req.socket,inflight+1);this.activeHttp++;
    let owner: ClientContext | undefined;
    guardHttpOutput(res, this.outputBudget, () => { if (owner) this.registry.close(owner, 'http_write_stalled'); });
    // requestTimeout only covers request bodies, not stalled outbound responses.
    // Absolute bound also catches a trickle reader that avoids idle timeouts.
    // GET is the optional long-lived notification stream, governed by the
    // logical session lease; it is not a finite tool response.
    const deadline = req.method === 'GET' ? undefined : setTimeout(() => {
      res.destroy();
      if (owner) this.registry.close(owner, 'http_response_timeout');
    }, this.options.testHttpResponseTimeoutMs ?? 60_000);
    deadline?.unref();
    let finished=false;
    const done=()=>{if(finished)return;finished=true;clearTimeout(deadline);this.activeHttp--;this.httpInFlight.set(req.socket,(this.httpInFlight.get(req.socket)??1)-1);};
    res.once('finish',done);res.once('close',done);
    const reject = (code: number) => { res.writeHead(code); res.end(); };
    const port = this.address.port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return reject(403);
    if (req.headers.origin !== undefined) return reject(403); // Native Agent clients only; no browser origin has been paired.
    if (req.url !== '/mcp' && req.url !== '/admin') return reject(404);
    const authorization = req.headers.authorization ?? '';
    const p = authorization.startsWith('Bearer ') ? this.authenticate(authorization.slice(7)) : undefined;
    if (!p) return reject(401);
    if (!this.options.testing && !await this.verifyPeer(req.socket)) return reject(403);
    if (res.destroyed) return;
    if (req.url === '/admin') {
      if (!p.permissions.includes('admin') || req.method !== 'POST') return reject(403);
      let command: Record<string, unknown>;
      try {
        const body = await this.body(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(400);
        command = body as Record<string, unknown>;
        if (command.closeConnections !== undefined && typeof command.closeConnections !== 'boolean') return reject(400);
      } catch { return reject(400); }
      let value: unknown;
        if (command.operation === 'status') value = { ...this.supervisor.status, maintenance: this.maintenance, pid: process.pid, idleArmed: this.idle.active };
      else if (command.operation === 'quiesce') {
        if (this.registry.count && command.closeConnections !== true) return reject(409);
        // 维护路径不走空闲宽限：取消时间线并显式立即收尾（旧 N=0 语义）。
        this.maintenance = true; this.idle.cancel();
        this.registry.closeAll(); this.backgroundCleanup(this.runtime?.stop()); this.supervisor.setCount(0);
        await this.supervisor.settled();
        if (this.supervisor.status.pid) return reject(409);
        value = { quiesced: true, ...this.supervisor.status };
      } else if (command.operation === 'shutdown') {
        if (!this.maintenance || this.registry.count || this.supervisor.status.pid) return reject(409);
        value = { shuttingDown: true }; res.once('finish', () => { void this.close(); });
      } else if (command.operation === 'resume') {
        this.maintenance = false; this.idle.update(this.registry.count); value = { resumed: true };
      } else if (command.operation === 'reload-clients') {
        if (!this.options.configFile) return reject(400);
        const cfg=JSON.parse(fs.readFileSync(this.options.configFile,'utf8')) as {principals:Principal[]};
        if (!Array.isArray(cfg.principals)||cfg.principals.length>128) return reject(400);
        const ids=new Set(), hashes=new Set();
        for(const next of cfg.principals) {
          if(!/^[a-zA-Z0-9_-]{1,64}$/.test(next.id)||!/^[0-9a-f]{64}$/.test(next.tokenSha256)||ids.has(next.id)||hashes.has(keyId(next.tokenSha256))
            ||!Array.isArray(next.permissions)||!next.permissions.length||next.permissions.some(p=>!['admin','device.read','voice','input.control',...(this.options.testing?['test']:[])].includes(p)))return reject(400);
          ids.add(next.id);hashes.add(keyId(next.tokenSha256));
        }
        const admins=(list:Principal[])=>list.filter(p=>p.permissions.includes('admin'));
        if(JSON.stringify(admins(cfg.principals))!==JSON.stringify(admins(this.options.principals)))return reject(400);
        const old=this.options.principals; this.options.principals=cfg.principals;let closed=0;
        for(const {ctx} of this.connections.values()) {
          const before=old.find(p=>p.id===ctx.principalId),after=cfg.principals.find(p=>p.id===ctx.principalId);
          if(!after||before?.tokenSha256!==after.tokenSha256||JSON.stringify(before?.permissions)!==JSON.stringify(after.permissions)){
            this.registry.close(ctx,'credential_changed');closed++;
          }
        }
        value={clientsReloaded:true,closedConnections:closed,effectiveConnections:this.registry.count};
      } else return reject(400);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); return;
    }
    const id = req.headers['mcp-session-id'];
    if (id !== undefined && typeof id !== 'string') return reject(400);
    let conn = id ? this.httpSessions.get(id) : undefined;
    if (id && (!conn || conn.ctx.principalId !== p.id)) return reject(404);
    let parsed: unknown;
    if (req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) return reject(415);
      try { parsed = await this.body(req); } catch { return reject(400); }
    }
    if (res.destroyed) return;
    if (!conn) {
      if (req.method !== 'POST' || !isInitializeRequest(parsed)) return reject(400);
      let entry: Connection;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true,
        onsessioninitialized: sessionId => { this.httpSessions.set(sessionId, entry); } });
      try { entry = this.createConnection(p, 'http-passive', transport); await entry.server.connect(transport); conn = entry; }
      catch { return reject(503); }
    }
    owner = conn.ctx;
    // The MCP transport closes itself BEFORE writing the successful DELETE reply.
    // Its acknowledgement remains protected by the response deadline, not owner teardown.
    if (req.method !== 'DELETE') conn.replies.add(res);
    const clearReply = () => conn!.replies.delete(res);
    res.once('finish', clearReply); res.once('close', clearReply);
    const transport = conn.transport as StreamableHTTPServerTransport;
    if(parsed&&typeof parsed==='object'&&'id' in parsed) {
      const key=`${conn.ctx.connectionId}:${JSON.stringify(parsed.id)}`;
      if(this.httpReplies.has(key))return reject(409);
      this.httpReplies.set(key,res);const remove=()=>{if(this.httpReplies.get(key)===res)this.httpReplies.delete(key);};
      res.once('finish',remove);res.once('close',remove);
    }
    // Only validated protocol messages renew the lease. GET/SSE alone does not.
    const previous = transport.onmessage;
    // Set once; the wrapper validates the connection before dispatching a parsed MCP message.
    if (!(conn as Connection & { wrapped?: boolean }).wrapped) {
      transport.onmessage = (message, extra) => { try { this.registry.touch(conn!.ctx); previous?.(message, extra); } catch { void conn!.server.close(); } };
      (conn as Connection & { wrapped?: boolean }).wrapped = true;
    }
    try {
      if (id) this.registry.assertConnected(conn.ctx);
      await transport.handleRequest(req, res, parsed);
      if (req.method === 'DELETE' && res.statusCode >= 200 && res.statusCode < 300) this.registry.close(conn.ctx, 'http_delete');
    } catch { if (!res.headersSent) reject(404); }
  }
  private verifyPeer(socket: net.Socket): Promise<boolean> {
    let pending = this.peerChecks.get(socket); if (pending) return pending;
    if (!socket.remotePort || !socket.localPort) return Promise.resolve(false);
    pending = this.peerCheckQueue.run(async () => {
      if (socket.destroyed) return false;
      return execIdentity(this.options.native.executable, ['--tcp-owner', String(socket.localPort), String(socket.remotePort)],
      { windowsHide: true, timeout: 2000, maxBuffer: 4096 }).then(({ stdout }) => {
        const actual = JSON.parse(stdout); const expected = this.options.native.expectedIdentity!;
        return actual.sid === expected.sid && actual.windowsSessionId === expected.windowsSessionId;
      }).catch(() => false);
    });
    this.peerChecks.set(socket, pending); return pending;
  }
  private acceptConnector(socket: net.Socket): void {
    if (this.sockets.size >= 64 || this.stopping) { socket.destroy(); return; }
    this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); let buffer = '';
    let challenge: { principal: Principal; clientNonce: string; serverNonce: string } | undefined;
    const timeout = setTimeout(() => socket.destroy(), 5000);
    socket.once('close', () => clearTimeout(timeout));
    const auth = (part: string | Buffer) => {
      buffer += part.toString(); if (Buffer.byteLength(buffer) > 4096) { socket.destroy(); return; }
      const end = buffer.indexOf('\n'); if (end < 0) return;
      try {
        const hello = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (hello.protocol !== PIPE_PROTOCOL) throw new Error('unauthorized');
        if (!challenge) {
          const principal = this.options.principals.find(p => keyId(p.tokenSha256) === hello.keyId);
          if (!principal || !isNonce(hello.clientNonce) || buffer.length) throw new Error('unauthorized');
          challenge = { principal, clientNonce: hello.clientNonce, serverNonce: randomBytes(32).toString('hex') };
          socket.write(JSON.stringify({ protocol: PIPE_PROTOCOL, daemonEpoch: this.registry.epoch, serverNonce: challenge.serverNonce,
            proof: proof(principal.tokenSha256, 'server', challenge.clientNonce, challenge.serverNonce, this.registry.epoch) }) + '\n');
          return;
        }
        const { principal, clientNonce, serverNonce } = challenge;
        if (!validProof(hello.proof, proof(principal.tokenSha256, 'client', clientNonce, serverNonce, this.registry.epoch))) throw new Error('unauthorized');
        socket.pause(); socket.off('data', auth); clearTimeout(timeout);
        let conn: Connection;
        const transport = new SocketTransport(socket, () => this.registry.touch(conn.ctx), buffer);
        conn = this.createConnection(principal, 'stdio-heartbeat', transport);
        socket.write(JSON.stringify({ protocol: PIPE_PROTOCOL, daemonEpoch: this.registry.epoch,
          proof: proof(principal.tokenSha256, 'accepted', clientNonce, serverNonce, this.registry.epoch) }) + '\n');
        void conn.server.connect(transport).catch(() => { this.registry.close(conn.ctx, 'connect_failed'); socket.destroy(); });
      } catch { socket.destroy(); }
    };
    socket.on('data', auth);
  }
  async listen(): Promise<void> {
    // Exclusive local endpoint is held for the full service lifetime, including N=0.
    await new Promise<void>((resolve, reject) => { this.pipeServer.once('error', reject); this.pipeServer.listen(this.options.pipe, () => { this.pipeServer.off('error', reject); resolve(); }); });
    try { await new Promise<void>((resolve, reject) => { this.httpServer.once('error', reject); this.httpServer.listen(this.options.port, '127.0.0.1', () => { this.httpServer.off('error', reject); resolve(); }); }); }
    catch (e) { this.pipeServer.close(); throw e; }
    this.pipeServer.on('error', () => { void this.close(); }); this.httpServer.on('error', () => { void this.close(); });
    this.sweep = setInterval(() => { this.registry.sweep(); this.supervisor.checkHeartbeat(); }, 1000);
    // Trace from the first listening moment so idle exits are logged even without any connection.
    this.trace ??= new DiagnosticLog(this.options.native.diagnosticsDirectory);
    // A daemon nobody connects to also counts as idle (connector died right after relaunch).
    this.idle.update(this.registry.count);
  }
  async close(): Promise<void> {
    if (this.stopping) return; this.stopping = true; if (this.sweep) clearInterval(this.sweep);
    this.idle.cancel();
    this.registry.closeAll(); await this.supervisor.shutdown();
    for (const s of this.sockets) s.destroy(); for (const s of this.rawSockets) s.destroy();
    await Promise.all([new Promise<void>(r => this.httpServer.close(() => r())), new Promise<void>(r => this.pipeServer.close(() => r()))]);
    this.trace?.record('daemon.close'); this.trace?.close();
  }
}
