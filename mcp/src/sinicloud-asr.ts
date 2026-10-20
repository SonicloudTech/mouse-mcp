/*
 * sinicloud-asr.ts —— Sonicloud 开放平台实时流式识别 provider（v2 同位替代 AsrTools 链路）
 *
 * 协议（平台文档 accesstoken + webapi/stream-asr）：
 *   1) POST {tokenUrl} JSON {appId, apiKey, timeStamp(秒), sign}；
 *      sign = md5(appId + apiKey + timeStamp + apiSecret)。响应 {code:0, data:{token}}，
 *      token 有效期 2 小时——进程内缓存、临期强制刷新，凭据指纹变化自动换客户端。
 *   2) WebSocket {streamUrl}?X-SC-Authorization=token&X-SC-User-Id=userId&lanid=...
 *      （平台实测：鉴权头名作查询参数拼接）；连接确认帧 errCode=1000（含 sid）
 *      之后才允许推音频；二进制 PCM 16k/16bit/mono，每包必须 >80 字节，
 *      按 ~100ms/包（3200B）节奏发送；输入结束发文本帧 "end"。
 *   3) 服务端文本帧 errCode：识别文字一律在 result 字段。1000 连接确认（含 sid）；
 *      1/2/3 进行中的累积中间结果（result 为至今全文，随语音推进增长，作 preview）；
 *      0 结果帧（End>0 完整句 / End==0 中间，兼容保留）；10 收尾帧——result 携带
 *      最终全文（静音时为空），随后服务端关闭连接，据此立即判 FINISHED；
 *      1001 低余额（仅告警，连接不断）；-1 检测不到音频、-2 超出单次识别时长
 *      （均会断开）；4000-4006 参数错、4010-4016 鉴权错、5000-5002 运行错
 *      （按文档时机断开）。鉴权错出现在 1000 之前时，用强制刷新的 token 重连
 *      一次，仍失败才判 FAILED。
 *      实测注：errCode 与 Begin/End 可能以字符串返回，一律
 *      Number() 归一化后再比较。
 *
 * 凭据纪律：appId/apiKey/apiSecret 只经 credentials()（配置文件/环境变量，见
 * env.ts）运行时注入——每次会话 begin 重新读取，换 key 不重启；凭据与 token
 * 不入日志、不进错误消息、不随事件转发（错误一律映射为固定码）。
 */
import { createHash } from 'node:crypto';
import type { AsrEvents, AsrProviderFactory, AsrSessionInit, StreamingAsrProvider } from './asr-service.js';

export interface SinicloudCredentials {
  appId: string;
  apiKey: string;
  apiSecret: string;
  userId?: string;
  lanid?: number;
  streamUrl?: string;
  tokenUrl?: string;
}

/** 测试注入面：真实实现用 Node 22 全局 WebSocket 与全局 fetch */
export interface SinicloudSocket {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: () => void;
  onerror?: () => void;
}

export interface SinicloudStreamOptions {
  /** 每次会话调用一次（支持运行期换 key） */
  credentials: () => SinicloudCredentials;
  /** 连接建立与收尾等待预算（默认/上限见 createSinicloudStreamFactory） */
  timeoutMs?: number;
  onDiagnostic?: (info: Record<string, unknown>) => void;
  connect?: (url: string) => SinicloudSocket;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 发送分片目标大小（字节）；最后不足 80B 的尾包补零 */
  chunkBytes?: number;
}

const MIN_FRAME_BYTES = 81;          // 协议：每包必须 >80 字节（按 ≥81 实现，尾包补零）
const DEFAULT_CHUNK_BYTES = 3200;    // 协议建议 ~100ms/包（16k16bit 单声道）
const TOKEN_MARGIN_MS = 5 * 60_000;  // token 临期提前 5 分钟刷新
const TOKEN_DEFAULT_TTL_MS = 2 * 60 * 60_000; // 文档：有效期 2 小时
const CONNECT_TIMEOUT_MS = 15_000;
const END_TIMEOUT_MS = 15_000;

/** md5(appId + apiKey + timeStamp + apiSecret) —— 平台签名规则 */
function tokenSign(appId: string, apiKey: string, timeStampSec: number, apiSecret: string): string {
  return createHash('md5').update(`${appId}${apiKey}${timeStampSec}${apiSecret}`).digest('hex');
}

class TokenClient {
  private token?: string;
  private expiresAt = 0;
  private inflight?: Promise<string>;

  constructor(private readonly creds: SinicloudCredentials, private readonly fetchImpl: typeof fetch,
    private readonly now: () => number) {}

  /** force=true：忽略缓存强制换新（鉴权 401x 重连前使用） */
  get(force = false): Promise<string> {
    if (!force && this.token && this.now() < this.expiresAt) return Promise.resolve(this.token);
    if (!force && this.inflight) return this.inflight;
    this.inflight = this.fetchToken().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const timeStamp = Math.floor(this.now() / 1000);
    const sign = tokenSign(this.creds.appId, this.creds.apiKey, timeStamp, this.creds.apiSecret);
    let response: Response;
    try {
      response = await this.fetchImpl(this.creds.tokenUrl ?? 'https://openapi.sinicloud.com/api/auth/get_token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: this.creds.appId, apiKey: this.creds.apiKey, timeStamp, sign }),
      });
    } catch {
      throw new Error('sinicloud_token_network'); // 网络异常：不携带响应体/凭据
    }
    if (!response.ok) throw new Error('sinicloud_token_http');
    let payload: { code?: unknown; data?: { token?: unknown; expire_time?: unknown } };
    try { payload = await response.json() as typeof payload; } catch { throw new Error('sinicloud_token_http'); }
    const code = Number(payload.code);
    if (code !== 0) throw new Error(`sinicloud_token_${Number.isSafeInteger(code) ? code : 'unknown'}`);
    const token = payload.data?.token;
    if (typeof token !== 'string' || token.length === 0) throw new Error('sinicloud_token_http');
    this.token = token;
    // expire_time 语义防御：形如 epoch 秒才采用，否则按文档默认 2h
    const expire = Number(payload.data?.expire_time);
    this.expiresAt = Number.isSafeInteger(expire) && expire > 1_600_000_000
      ? expire * 1000 - TOKEN_MARGIN_MS
      : this.now() + TOKEN_DEFAULT_TTL_MS - TOKEN_MARGIN_MS;
    return token;
  }
}

/**
 * 创建流式 provider 工厂。运行时无全局 WebSocket（Node <22 且未注入 connect）时
 * 返回 null——语音编排降级为 asr_unavailable，不阻塞其它能力；凭据缺失不在
 * 工厂层拒绝（运行期可再配置），留到会话 begin 时以固定错误码终结。
 */
export function createSinicloudStreamFactory(options: SinicloudStreamOptions): AsrProviderFactory | null {
  const globalWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  const connect = options.connect
    ?? (typeof globalWs === 'function'
      ? (url: string) => new (globalWs as new (url: string) => SinicloudSocket)(url)
      : undefined);
  if (!connect) {
    options.onDiagnostic?.({ component: 'sinicloud', error: 'runtime_no_websocket' });
    return null;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 60_000, 300_000));
  const chunkBytes = Math.max(MIN_FRAME_BYTES, options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  let cached: { fingerprint: string; client: TokenClient } | null = null;

  return (events: AsrEvents, init: AsrSessionInit): StreamingAsrProvider => {
    let began = false;
    let terminal = false;
    let ready = false;          // 收到 errCode=1000
    let previewRevision = 0;    // 中间结果（累积全文）递增序号
    let endSent = false;
    let endQueued = false;      // 1000 未到就 finishInput：就绪后补发
    let authRetried = false;
    let socket: SinicloudSocket | null = null;
    let acc = Buffer.alloc(0);  // 待发 PCM 累积（保证每包 ≥80B、按 chunkBytes 分片）
    let connectTimer: NodeJS.Timeout | undefined;
    let endTimer: NodeJS.Timeout | undefined;
    let flushTimer: NodeJS.Timeout | undefined;

    const finish = (result: { ok: boolean; cancelled?: boolean; error?: string }) => {
      if (terminal) return;
      terminal = true;
      clearTimer(connectTimer); clearTimer(endTimer); clearTimer(flushTimer);
      const s = socket; socket = null;
      try { s?.close(1000, 'umouse-asr-done'); } catch { /* 已关闭 */ }
      events.terminal(result, { sessionId: init.sessionId });
    };
    const clearTimer = (t?: NodeJS.Timeout) => { if (t) clearTimeout(t); };
    const fail = (error: string) => finish({ ok: false, error });

    const clientFor = (creds: SinicloudCredentials): TokenClient => {
      const fingerprint = createHash('sha256').update(`${creds.appId}\n${creds.apiKey}\n${creds.apiSecret}`).digest('hex').slice(0, 16);
      if (!cached || cached.fingerprint !== fingerprint) cached = { fingerprint, client: new TokenClient(creds, fetchImpl, now) };
      return cached.client;
    };

    const sendAudio = (): void => {
      if (!socket || terminal) return;
      while (acc.length >= chunkBytes) {
        socket.send(acc.subarray(0, chunkBytes));
        acc = acc.subarray(chunkBytes);
      }
    };
    const flushAudio = (): void => {
      if (!socket || terminal || acc.length === 0) return;
      if (acc.length < MIN_FRAME_BYTES) acc = Buffer.concat([acc, Buffer.alloc(MIN_FRAME_BYTES - acc.length)]); // 尾包补静音零
      socket.send(acc);
      acc = Buffer.alloc(0);
    };
    /** 就绪态即时冲发：任何 ≥81B 的积压立刻发（不等 100ms 节拍，降低起播延迟） */
    const flushReady = (): void => {
      if (!socket || terminal) return;
      if (acc.length >= MIN_FRAME_BYTES) { socket.send(acc); acc = Buffer.alloc(0); }
    };
    const sendEnd = (): void => {
      if (!socket || endSent || terminal) return;
      flushAudio();
      socket.send('end');
      endSent = true;
      endTimer = setTimeout(() => { if (!terminal) finish({ ok: true }); }, Math.min(timeoutMs, END_TIMEOUT_MS));
      (endTimer as NodeJS.Timeout).unref?.();
    };

    const wire = (s: SinicloudSocket): void => {
      s.onmessage = (event: { data: unknown }) => {
        if (terminal || socket !== s) return;
        if (typeof event.data !== 'string') return; // 平台只发 JSON 文本帧
        let frame: { errCode?: unknown; result?: unknown; text?: unknown; End?: unknown };
        try { frame = JSON.parse(event.data) as typeof frame; } catch { return; }
        const code = Number(frame.errCode);
        // 平台实测：识别文字在 result 字段（中间帧与收尾帧皆是）；兼容旧 text 字段
        const frameText = (): string => {
          if (typeof frame.result === 'string') return frame.result;
          if (typeof frame.text === 'string') return frame.text;
          if (frame.text && typeof frame.text === 'object' && typeof (frame.text as { text?: unknown }).text === 'string') return (frame.text as { text: string }).text;
          return '';
        };
        if (code === 1000) {
          if (!ready) {
            ready = true;
            clearTimer(connectTimer);
            flushTimer = setInterval(() => { // 就绪后 ~100ms 节奏补发
              flushReady();
            }, 100);
            (flushTimer as NodeJS.Timeout).unref?.();
            sendAudio();
            flushReady();
            if (endQueued) { endQueued = false; sendEnd(); }
          }
          return;
        }
        if (code === 1001) {
          events.warning?.('low_balance', '平台账户余额不足预警（连接未断开，请及时充值）', { sessionId: init.sessionId });
          return;
        }
        if (code === 0) {
          const text = frameText();
          if (Number(frame.End) > 0) events.segmentFinal?.(text, { sessionId: init.sessionId });
          else if (text) events.preview?.(text, { sessionId: init.sessionId, revision: ++previewRevision });
          return;
        }
        if (code === 1 || code === 2 || code === 3) {
          // 平台实测：中间结果为累积全文（result），随语音推进增长
          const text = frameText();
          if (text) events.preview?.(text, { sessionId: init.sessionId, revision: ++previewRevision });
          return;
        }
        if (code === 10) {
          // 平台实测：收尾帧 errCode=10 且 result 携带最终全文（静音时为空），
          // 服务端随后关闭连接——据此取出终稿并立即判 FINISHED，不等关闭/超时。
          const text = frameText();
          if (text) events.segmentFinal?.(text, { sessionId: init.sessionId });
          finish({ ok: true });
          return;
        }
        if (code === -1) { fail('sinicloud_no_audio'); return; }
        if (code === -2) { fail('sinicloud_duration_limit'); return; }
        if (code >= 4010 && code <= 4016) {
          if (!ready && !authRetried) { void reconnectWithFreshToken(s); return; }
          fail(`sinicloud_auth_${code}`);
          return;
        }
        if ((code >= 4000 && code <= 4006) || (code >= 5000 && code <= 5002)) {
          fail(`sinicloud_error_${code}`);
          return;
        }
        events.warning?.('sinicloud_unknown_code', `平台未知状态码 ${Number.isSafeInteger(code) ? code : 'unknown'}`, { sessionId: init.sessionId });
      };
      s.onclose = () => {
        if (terminal || socket !== s) return;
        clearTimer(connectTimer);
        if (endSent) { finish({ ok: true }); return; }        // "end" 后服务端收尾关闭
        if (!ready && !authRetried) { void reconnectWithFreshToken(s); return; } // 连接期夭折：换 token 一次
        if (ready) fail('sinicloud_stream_closed_early');
        else fail('sinicloud_connect_failed');
      };
      s.onerror = () => { /* 不在此判终态；等 onclose（其后必至） */
        if (!terminal && socket === s && !ready) options.onDiagnostic?.({ component: 'sinicloud', error: 'socket_error_before_ready' });
      };
    };

    const openSocket = (creds: SinicloudCredentials, token: string): void => {
      const streamUrl = creds.streamUrl ?? 'ws://openapi.sinicloud.com/talentStreamAsr';
      if (!/^wss?:\/\//.test(streamUrl)) { fail('sinicloud_stream_url_invalid'); return; }
      // 鉴权以「头名作查询参数」拼接（平台实测要求）：X-SC-Authorization=token、X-SC-User-Id
      const url = `${streamUrl}?X-SC-Authorization=${encodeURIComponent(token)}&X-SC-User-Id=${encodeURIComponent(creds.userId ?? 'umouse-mcp')}&lanid=${creds.lanid ?? 0}`;
      let s: SinicloudSocket;
      try { s = connect(url); } catch { fail('sinicloud_connect_failed'); return; }
      socket = s;
      wire(s);
      connectTimer = setTimeout(() => { if (!terminal && !ready) fail('sinicloud_connect_timeout'); },
        Math.min(timeoutMs, CONNECT_TIMEOUT_MS));
      (connectTimer as NodeJS.Timeout).unref?.();
    };

    const reconnectWithFreshToken = async (dead: SinicloudSocket): Promise<void> => {
      if (terminal || authRetried) return;
      authRetried = true;
      if (socket === dead) socket = null; // 先摘引用：dead.onclose 的守卫会因此直接返回
      try { dead.close(); } catch { /* 已关闭 */ }
      try {
        const creds = options.credentials();
        const token = await clientFor(creds).get(true);
        if (terminal) return;
        openSocket(creds, token);
      } catch {
        if (!terminal) fail('sinicloud_token_failed');
      }
    };

    const start = async (): Promise<void> => {
      let creds: SinicloudCredentials;
      try { creds = options.credentials(); } catch { fail('sinicloud_credentials_invalid'); return; }
      if (!creds.appId || !creds.apiKey || !creds.apiSecret) { fail('sinicloud_credentials_missing'); return; }
      let token: string;
      try { token = await clientFor(creds).get(); } catch (error) {
        fail(error instanceof Error && /^sinicloud_token_/.test(error.message) ? error.message : 'sinicloud_token_failed');
        return;
      }
      if (!terminal) openSocket(creds, token);
    };

    return {
      id: 'sinicloud:stream',
      supportsPreview: true, // 平台 End==0 未断句中间结果（如实呈现）
      begin() {
        if (began) return;
        began = true;
        void start();
      },
      writePcm(chunk: Buffer) {
        if (!began || terminal) return;
        acc = Buffer.concat([acc, chunk]);
        if (ready) sendAudio(); // 未就绪时只累积，1000 后统一补发
      },
      finishInput() {
        if (!began || terminal) return;
        clearTimer(flushTimer);
        if (ready) sendEnd();
        else endQueued = true; // 连接未确认：就绪后立即冲缓并 end
      },
      cancel() {
        if (terminal) return;
        finish({ ok: false, cancelled: true });
      },
    };
  };
}
