import type { AsrProviderFactory } from '../asr-service.js';
import type { WorkerHandle } from './worker-supervisor.js';

/** Bounded ordered PCM RPC. Neither credentials nor raw audio are MCP tool results. */
export function nativeAsrFactory(client: WorkerHandle, engines: unknown): AsrProviderFactory {
  const config = engines as { default?: string; list?: Array<{ id?: string; type?: string }> };
  if (!Array.isArray(config?.list) || !config.list.length) throw new Error('asr_engine_config_invalid');
  const engine = config.list.find(e => e.id === config.default) ?? config.list[0];
  const preview = ['xunfei_cn', 'xunfei_global'].includes(engine.type ?? '');
  let recycling: Promise<void> = Promise.resolve(), recycleFailed = false;
  return (events, init) => {
    let terminal = false, began = false, nativeBegan = false, pendingBytes = 0, finishing = false;
    let finishSent = false, finishAccepted = false, sawFinished = false;
    let tail: Promise<void> = recycling;
    const meta = { sessionId: init.sessionId };
    const finish = (result: { ok: boolean; cancelled?: boolean; error?: string }) => {
      if (terminal) return; terminal = true; client.off('event', onEvent);
      // Disposing after every terminal prevents a second session entering the previous ASR handle.
      recycling = tail.catch(() => {}).then(async () => { if (nativeBegan) await client.request('asr', 'dispose', meta); }).catch(() => { recycleFailed = true; });
      events.terminal(result, meta);
    };
    const enqueue = (method: string, args: object, bytes = 0) => {
      if (terminal) return;
      if (pendingBytes + bytes > 2 * 1024 * 1024) { finish({ ok: false, error: 'asr_backpressure' }); return; }
      pendingBytes += bytes;
      tail = tail.then(async () => {
        if (terminal) return;
        if (recycleFailed) throw new Error('asr_recycle_failed');
        if (method === 'begin') nativeBegan = true;
        if (method === 'finish') finishSent = true;
        const result = await client.request<{ code: number }>('asr', method, { ...meta, ...args });
        if (result.code !== 0) throw new Error('asr_native_rejected');
        if (method === 'finish') { finishAccepted = true; if (sawFinished) finish({ ok: true }); }
      }).catch(() => finish({ ok: false, error: 'asr_native_failed' })).finally(() => { pendingBytes -= bytes; });
    };
    const onEvent = (frame: { plugin?: string; event?: Record<string, unknown> }) => {
      const e = frame.event;
      if (terminal || frame.plugin !== 'asr' || e?.sessionId !== init.sessionId) return;
      if (e.type === 'preview' && preview && typeof e.text === 'string') events.preview?.(e.text, { ...meta, revision: 0 });
      if (e.type === 'final' && typeof e.text === 'string') events.segmentFinal?.(e.text, meta);
      if (e.type === 'warning') events.warning?.(`native_${e.kind}`, 'ASR warning', meta);
      if (e.type === 'warning' && e.kind === 2) finish({ ok: false, error: 'asr_audio_dropped' });
      if (e.type === 'state' && e.state === 4) {
        // finishInput only queues a request. Every PCM append must complete and
        // native stop must accept it before a successful terminal can deliver text.
        if (!finishSent) finish({ ok: false, error: 'asr_ended_before_input' });
        else { sawFinished = true; if (finishAccepted) finish({ ok: true }); }
      }
      if (e.type === 'state' && e.state === 5) finish({ ok: false, error: 'asr_failed' });
      if (e.type === 'state' && e.state === 6) finish({ ok: false, cancelled: true });
    };
    client.on('event', onEvent);
    return {
      id: 'native-asr-tools', supportsPreview: preview,
      begin() { if (began) return; began = true; enqueue('begin', { engines, params: { func: 'input', lang: 'zh_cn' } }); },
      writePcm(chunk) { if (finishing) return; enqueue('append', { pcmHex: chunk.toString('hex') }, chunk.length); },
      finishInput() { if (finishing) return; finishing = true; enqueue('finish', {}); },
      cancel() { finish({ ok: false, cancelled: true }); },
    };
  };
}
