import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTranscriber, TranscriptionError } from '../dist/transcriber.js';

function wav() {
  const data = Buffer.alloc(44 + 3200);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(3200, 40);
  return data;
}

async function fixture(t, data = wav()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'umouse-asr-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "语音 literal $() ' ;.wav");
  await fs.writeFile(file, data);
  return { path: file, bytes: data.length - 44, durationMs: 100 };
}

async function localServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/transcribe`;
}

const hasCode = (code) => (error) => error instanceof TranscriptionError && error.code === code;

test('Whisper requires explicit absolute paths and bounded threads, without launching during validation', () => {
  const valid={provider:'whisper-cpp',executable:process.execPath,modelPath:path.resolve('nonexistent-model.bin')};
  assert.doesNotThrow(()=>createTranscriber(valid));
  for(const changes of [{executable:undefined},{modelPath:undefined},{executable:'relative.exe'},
    {modelPath:'relative.bin'},{threads:0},{threads:17},{modelPath:valid.modelPath+'\0bad'}]) {
    assert.throws(()=>createTranscriber({...valid,...changes}),hasCode('configuration'));
  }
  if(process.platform==='win32') assert.throws(()=>createTranscriber({...valid,executable:'C:\\tool.cmd'}),hasCode('configuration'));
});

test('Whisper missing model and failed local executable are sanitized; config is snapshotted', async t => {
  const record=await fixture(t);
  const missing={provider:'whisper-cpp',executable:process.execPath,modelPath:record.path+'.missing'};
  await assert.rejects(createTranscriber(missing)(record),hasCode('unavailable'));
  // Node rejects whisper CLI flags; no SDK or user audio is opened by the child.
  const config={...missing,modelPath:record.path};
  const transcribe=createTranscriber(config);
  config.executable='changed'; config.modelPath='changed';
  await assert.rejects(transcribe(record),error=>hasCode('recognition_failed')(error) && !error.message.includes(record.path));
  const controller=new AbortController(); controller.abort();
  await assert.rejects(transcribe(record,controller.signal),hasCode('aborted'));
});

test('configuration requires explicit HTTP provider and a safe endpoint', () => {
  assert.throws(() => createTranscriber({ provider: 'unknown' }), hasCode('configuration'));
  for (const endpoint of ['', 'http://example.com/upload', 'file:///x', 'https://user:secret@example.com/', 'https://example.com/#secret']) {
    assert.throws(() => createTranscriber({ provider: 'http', endpoint }), hasCode('configuration'));
  }
  assert.doesNotThrow(() => createTranscriber({ provider: 'windows-speech', endpoint: 'http://ignored.invalid' }));
  assert.doesNotThrow(() => createTranscriber({ provider: 'http', endpoint: 'https://example.com/asr' }));
  assert.throws(() => createTranscriber({ provider: 'windows-speech', timeoutMs: NaN }), hasCode('configuration'));
  assert.throws(() => createTranscriber({ provider: 'windows-speech', language: 'zh-CN;bad' }), hasCode('configuration'));
});

test('HTTP multipart uploads only validated WAV and snapshots configuration', async (t) => {
  const record = await fixture(t);
  let received;
  const endpoint = await localServer(t, async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    received = { headers: req.headers, body: Buffer.concat(parts).toString('utf8'), url: req.url };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: '  打开画图  ', confidence: 0.9 }));
  });
  const config = { provider: 'http', endpoint, model: 'test-model', apiKey: 'test-key', language: 'zh-CN' };
  const transcribe = createTranscriber(config);
  config.endpoint = 'https://must-not-upload.invalid';
  const result = await transcribe(record);
  assert.deepEqual(result, { text: '打开画图', provider: 'http', language: 'zh-CN', confidence: 0.9 });
  assert.equal(received.headers.authorization, 'Bearer test-key');
  assert.match(received.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(received.body, /filename="recording.wav"/);
  assert.match(received.body, /test-model/);
  assert.match(received.body, /zh-CN/);
  assert.ok(!received.body.includes(path.basename(record.path)), 'private local path must not be uploaded');
});

test('invalid/truncated/stereo WAV and oversized files are rejected before upload', async (t) => {
  let requests = 0;
  const endpoint = await localServer(t, (req, res) => { requests++; res.end('{"text":"bad"}'); });
  const invalid = wav(); invalid.writeUInt16LE(2, 22);
  const malformed = wav(); malformed.writeUInt32LE(999999, 16);
  for (const data of [Buffer.from('not audio'), invalid, malformed, wav().subarray(0, 100)]) {
    const record = await fixture(t, data);
    await assert.rejects(createTranscriber({ provider: 'http', endpoint })(record), hasCode('input_error'));
  }
  const record = await fixture(t);
  await assert.rejects(createTranscriber({ provider: 'http', endpoint, maxAudioBytes: 100 })(record), hasCode('input_error'));
  assert.equal(requests, 0);
});

test('redirects are never followed and provider errors do not expose secrets', async (t) => {
  const record = await fixture(t);
  let redirected = 0;
  const target = await localServer(t, (req, res) => { redirected++; res.end('{"text":"bad"}'); });
  const redirect = await localServer(t, (req, res) => { res.writeHead(307, { location: target }); res.end(); });
  await assert.rejects(createTranscriber({ provider: 'http', endpoint: redirect, apiKey: 'secret-token' })(record), (error) => {
    assert.equal(error.code, 'provider_error');
    assert.ok(!error.message.includes('secret-token') && !error.message.includes(redirect));
    return true;
  });
  assert.equal(redirected, 0);
  const failure = await localServer(t, (req, res) => { res.writeHead(401); res.end('secret-provider-body'); });
  await assert.rejects(createTranscriber({ provider: 'http', endpoint: failure })(record), (error) => {
    assert.equal(error.code, 'http_error');
    assert.equal(error.message, 'Transcription service returned HTTP 401.');
    return true;
  });
});

test('response body is bounded for declared and chunked sizes', async (t) => {
  const record = await fixture(t);
  for (const declared of [false, true]) {
    const endpoint = await localServer(t, (req, res) => {
      if (declared) res.setHeader('content-length', 200);
      res.write('x'.repeat(100)); res.end('y'.repeat(100));
    });
    await assert.rejects(createTranscriber({ provider: 'http', endpoint, maxResponseBytes: 32 })(record), hasCode('response_too_large'));
  }
});

test('malformed JSON and missing text produce safe errors; empty text is valid', async (t) => {
  const record = await fixture(t);
  for (const response of ['secret-invalid-json', '{"wrong":"field"}']) {
    const endpoint = await localServer(t, (req, res) => res.end(response));
    await assert.rejects(createTranscriber({ provider: 'http', endpoint })(record), hasCode('invalid_response'));
  }
  const endpoint = await localServer(t, (req, res) => res.end('{"text":"","confidence":9}'));
  assert.deepEqual(await createTranscriber({ provider: 'http', endpoint })(record), { text: '', provider: 'http', language: 'zh-CN' });
});

test('timeout and cancellation abort in-flight HTTP without leaking provider data', async (t) => {
  const record = await fixture(t);
  const endpoint = await localServer(t, (req, res) => { res.writeHead(200); res.write('{"text":"'); });
  const start = Date.now();
  await assert.rejects(createTranscriber({ provider: 'http', endpoint, timeoutMs: 100 })(record), hasCode('timed_out'));
  assert.ok(Date.now() - start < 2000);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(createTranscriber({ provider: 'http', endpoint })(record, aborted.signal), hasCode('aborted'));
  const active = new AbortController();
  const pending = createTranscriber({ provider: 'http', endpoint })(record, active.signal);
  setTimeout(() => active.abort(), 50);
  await assert.rejects(pending, hasCode('aborted'));
});

test('Windows offline worker fails safely for an unavailable language', { skip: process.platform !== 'win32' }, async (t) => {
  const record = await fixture(t);
  await assert.rejects(createTranscriber({ provider: 'windows-speech', language: 'zz-ZZ', timeoutMs: 10000 })(record), hasCode('recognition_failed'));
});

test('Windows worker timeout terminates recognition child', { skip: process.platform !== 'win32' }, async (t) => {
  const record = await fixture(t);
  const start = Date.now();
  await assert.rejects(createTranscriber({ provider: 'windows-speech', timeoutMs: 100 })(record), hasCode('timed_out'));
  assert.ok(Date.now() - start < 3000);
});
