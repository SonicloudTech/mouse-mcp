/* Offline WAV transcription by default. HTTP upload requires an explicit provider. */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecordResult } from './audio.js';

export interface TranscriberConfig {
  provider: 'windows-speech' | 'whisper-cpp' | 'http';
  language?: string;
  timeoutMs?: number;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  executable?: string;
  modelPath?: string;
  threads?: number;
  maxAudioBytes?: number;
  maxResponseBytes?: number;
}

export interface TranscriptResult {
  text: string;
  provider: string;
  language: string;
  confidence?: number;
}

export type Transcriber = (
  record: Pick<RecordResult, 'path' | 'durationMs' | 'bytes'>,
  signal?: AbortSignal,
) => Promise<TranscriptResult>;

/** Codes and messages never contain provider response bodies, paths, or credentials. */
export class TranscriptionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

const fail = (code: string, message: string) => new TranscriptionError(code, message);
const script = fileURLToPath(new URL('../scripts/transcribe-windows.ps1', import.meta.url));

function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw fail('configuration', `Invalid ${name}.`);
  return result;
}

async function readWav(file: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) throw fail('aborted', 'Transcription cancelled.');
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 44 || stat.size > limit) throw fail('input_error', 'WAV is empty, invalid, or too large.');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      if (signal.aborted) throw fail('aborted', 'Transcription cancelled.');
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw fail('input_error', 'WAV changed while being read.');
      offset += bytesRead;
    }
    if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE'
        || data.readUInt32LE(4) + 8 !== data.length) throw fail('input_error', 'Invalid WAV container.');
    let formatOk = false;
    let audioOk = false;
    for (let p = 12; p + 8 <= data.length;) {
      const size = data.readUInt32LE(p + 4);
      const end = p + 8 + size;
      if (end > data.length) throw fail('input_error', 'Truncated WAV chunk.');
      const id = data.toString('ascii', p, p + 4);
      if (id === 'fmt ') {
        formatOk = size >= 16 && data.readUInt16LE(p + 8) === 1 && data.readUInt16LE(p + 10) === 1
          && data.readUInt32LE(p + 12) === 16000 && data.readUInt32LE(p + 16) === 32000
          && data.readUInt16LE(p + 20) === 2 && data.readUInt16LE(p + 22) === 16;
      }
      if (id === 'data') audioOk = size > 0 && size % 2 === 0;
      p = end + (size % 2);
    }
    if (!formatOk || !audioOk) throw fail('input_error', 'Expected 16 kHz, 16-bit, mono PCM WAV.');
    return data;
  } catch (error) {
    if (error instanceof TranscriptionError) throw error;
    throw fail('input_error', 'Unable to read WAV.');
  } finally {
    await handle?.close();
  }
}

function parseResult(raw: string, provider: string, language: string): TranscriptResult {
  let result: unknown;
  try { result = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw fail('invalid_response', 'Transcription returned invalid JSON.'); }
  if (!result || typeof result !== 'object' || typeof (result as Record<string, unknown>).text !== 'string') {
    throw fail('invalid_response', 'Transcription response has no text field.');
  }
  const value = result as Record<string, unknown>;
  const output: TranscriptResult = { text: (value.text as string).trim(), provider, language };
  if (typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1) {
    output.confidence = value.confidence;
  }
  return output;
}

function windowsSpeech(file: string, language: string, maxBuffer: number, signal: AbortSignal): Promise<TranscriptResult> {
  if (process.platform !== 'win32') throw fail('unavailable', 'Windows speech recognition requires Windows.');
  if (signal.aborted) throw fail('aborted', 'Transcription cancelled.');
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    // No shell; the WAV path and language are data, never executable PowerShell text.
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      maxBuffer,
      signal,
      env: { ...process.env, UMOUSE_TRANSCRIBE_WAV: file, UMOUSE_TRANSCRIBE_LANGUAGE: language },
    }, (error, stdout) => {
      if (signal.aborted) return reject(fail('aborted', 'Transcription cancelled.'));
      if (error) return reject(fail('recognition_failed', 'Windows speech recognition failed; 请检查并安装对应语言的 Windows 语音识别组件，或显式配置其他 ASR 服务。未自动切换或上传到其他服务。'));
      try { resolve(parseResult(stdout, 'windows-speech', language)); }
      catch (e) { reject(e); }
    });
  });
}

async function readResponse(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > limit) {
    await response.body?.cancel();
    throw fail('response_too_large', 'Transcription response exceeds its size limit.');
  }
  if (!response.body) throw fail('invalid_response', 'Transcription returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw fail('aborted', 'Transcription cancelled.');
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw fail('response_too_large', 'Transcription response exceeds its size limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function whisperCpp(file: string, executable: string, modelPath: string, language: string,
  threads: number, maxBuffer: number, signal: AbortSignal): Promise<TranscriptResult> {
  if (signal.aborted) throw fail('aborted', 'Transcription cancelled.');
  try {
    for (const input of [executable, modelPath]) {
      if (!(await fs.stat(input)).isFile()) throw new Error();
    }
  } catch { throw fail('unavailable', 'Whisper executable or model file is unavailable.'); }
  return new Promise((resolve, reject) => {
    // Explicit local executable/model, no shell, no downloads, no microphone capture.
    // CLI -nt omits timestamps; -np sends only transcript text to stdout.
    execFile(executable, ['-m', modelPath, '-l', language.split('-')[0].toLowerCase(),
      '-ng', '-t', String(threads), '-nt', '-np', '-f', path.resolve(file)], {
      windowsHide: true, shell: false, encoding: 'utf8', maxBuffer, signal,
    }, (error, stdout) => {
      if (signal.aborted) return reject(fail('aborted', 'Transcription cancelled.'));
      if (error) return reject(fail('recognition_failed', 'Local Whisper recognition failed.'));
      resolve({ text: stdout.replace(/^\uFEFF/, '').trim(), provider: 'whisper-cpp', language });
    });
  });
}

export function createTranscriber(config: TranscriberConfig): Transcriber {
  if (!['windows-speech', 'whisper-cpp', 'http'].includes(config.provider)) throw fail('configuration', 'Unknown transcription provider.');
  const language = config.language ?? 'zh-CN';
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) throw fail('configuration', 'Invalid transcription language.');
  const timeoutMs = bounded(config.timeoutMs, 60000, 100, 300000, 'timeoutMs');
  const maxAudioBytes = bounded(config.maxAudioBytes, 20 * 1024 * 1024, 44, 32 * 1024 * 1024, 'maxAudioBytes');
  const maxResponseBytes = bounded(config.maxResponseBytes, 256 * 1024, 16, 1024 * 1024, 'maxResponseBytes');
  const executable = config.executable;
  const modelPath = config.modelPath;
  const threads = bounded(config.threads, 4, 1, 16, 'threads');
  if (config.provider === 'whisper-cpp' && (!executable || !modelPath ||
      !path.isAbsolute(executable) || !path.isAbsolute(modelPath) ||
      executable.includes('\0') || modelPath.includes('\0') ||
      (process.platform === 'win32' && path.extname(executable).toLowerCase() !== '.exe'))) {
    throw fail('configuration', 'Whisper requires absolute local executable and model paths (Windows: .exe).');
  }
  let endpoint: URL | undefined;
  if (config.provider === 'http') {
    try { endpoint = new URL(config.endpoint ?? ''); }
    catch { throw fail('configuration', 'An explicit transcription endpoint is required.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local)) || endpoint.username || endpoint.password || endpoint.hash) {
      throw fail('configuration', 'Transcription endpoint must use HTTPS or loopback HTTP without embedded credentials.');
    }
  }
  // Snapshot configuration so a caller cannot silently change the upload target later.
  const provider = config.provider;
  const model = config.model;
  const apiKey = config.apiKey;
  return async (record, externalSignal) => {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    timer.unref?.();
    try {
      const data = await readWav(record.path, maxAudioBytes, controller.signal);
      if (controller.signal.aborted) throw fail('aborted', 'Transcription cancelled.');
      if (provider === 'windows-speech') return await windowsSpeech(path.resolve(record.path), language, maxResponseBytes, controller.signal);
      if (provider === 'whisper-cpp') return await whisperCpp(record.path, executable!, modelPath!, language, threads, maxResponseBytes, controller.signal);
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(data)], { type: 'audio/wav' }), 'recording.wav');
      form.set('language', language);
      form.set('response_format', 'json');
      if (model) form.set('model', model);
      const response = await fetch(endpoint!, {
        method: 'POST', body: form, signal: controller.signal, redirect: 'error',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw fail('http_error', `Transcription service returned HTTP ${response.status}.`);
      }
      return parseResult(await readResponse(response, maxResponseBytes, controller.signal), provider, language);
    } catch (error) {
      if (timedOut) throw fail('timed_out', 'Transcription timed out.');
      if (controller.signal.aborted) throw fail('aborted', 'Transcription cancelled.');
      if (error instanceof TranscriptionError) throw error;
      throw fail('provider_error', 'Transcription provider request failed.');
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  };
}
