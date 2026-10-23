// Run only on an isolated Windows x64 machine without a connected uMouse device.
// Exercises the real bundled stdio server and DLL, never a hardware input tool.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

assert.equal(process.platform, 'win32', 'The native smoke test requires Windows');
assert.equal(process.arch, 'x64', 'The native smoke test requires x64 Node.js');
assert.ok(process.argv[2], 'Usage: node smoke-mcpb.mjs EXTRACTED_BUNDLE');
const bundle = fs.realpathSync(process.argv[2]);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'umouse-mcpb-smoke-'));
const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(UMSDK_|UMOUSE_|TYPER_)/i.test(key)));
Object.assign(env, {
  UMSDK_DATA_DIR: scratch,
  UMSDK_ASR_PROVIDER: 'disabled',
  UMSDK_TAKEOVER: '0',
  UMSDK_SPEECH_AUTO: '0',
  UMSDK_INJECTION: '0',
  UMSDK_INJECT_KEYBOARD: '0',
  UMSDK_RAW_DIAG: '0',
  UMSDK_VOICE: '0',
  UMSDK_VOICE_UI: '0',
  UMSDK_VOICE_TYPER: '0',
  UMOUSE_SLEEP_RESET_ENABLED: '0',
});
const child = spawn(process.execPath, [path.join(bundle, manifest.server.entry_point)], {
  cwd: scratch, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
let invalidOutput;
let nextId = 1;
const pending = new Map();
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  try {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
    if (Object.hasOwn(message, 'id')) {
      assert.ok(pending.has(message.id), 'Unexpected response id');
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    } else {
      assert.equal(typeof message.method, 'string', 'Invalid JSON-RPC notification');
    }
  } catch (error) { invalidOutput ??= error; }
});
const exited = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Server exited early: ${code}/${signal}`));
    }
    pending.clear();
    resolve({ code, signal });
  });
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function callTool(name) {
  const response = await request('tools/call', { name, arguments: {} });
  assert.ok(!response.isError, `${name} returned a tool error`);
  const value = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  return value;
}
try {
  const initialized = await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'umouse-mcpb-smoke', version: '0.1.1' },
  });
  assert.equal(initialized.serverInfo.name, 'umouse-mcp');
  assert.equal(initialized.serverInfo.version, '0.1.0');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request('tools/list', {});
  for (const name of ['umouse_status', 'umouse_get_capabilities', 'umouse_list_devices']) {
    assert.ok(listed.tools.some(tool => tool.name === name), `Missing ${name}`);
  }
  const status = await callTool('umouse_status');
  assert.equal(status.sdkStarted, true, `Native SDK did not start: ${status.lastError ?? 'unknown'}`);
  assert.ok(status.sdkVersion, 'Missing native SDK version');
  assert.ok(!status.lastError, 'Native SDK reported an error');
  assert.equal(status.takeover.enabled, false);
  assert.equal(status.injection.enabled, false);
  assert.equal(status.voice.provider, 'disabled');
  assert.equal(status.config.speechAutoRecord, false);
  assert.equal(fs.realpathSync(status.config.libPath), fs.realpathSync(path.join(bundle, 'lib', 'uMouseSdk.dll')));
  assert.equal(fs.realpathSync(status.config.dataDir), fs.realpathSync(scratch));
  const { devices } = await callTool('umouse_list_devices');
  assert.deepEqual(devices, [], 'Smoke test must run without uMouse hardware');
  await callTool('umouse_get_capabilities');
  child.stdin.end();
  let shutdownTimer;
  const result = await Promise.race([
    exited,
    new Promise((_, reject) => { shutdownTimer = setTimeout(() => reject(new Error('SDK shutdown timed out')), 20000); }),
  ]).finally(() => clearTimeout(shutdownTimer));
  assert.deepEqual(result, { code: 0, signal: null });
  await new Promise(resolve => lines.closed ? resolve() : lines.once('close', resolve));
  if (invalidOutput) throw invalidOutput;
  console.log(JSON.stringify({ result: 'passed', packageVersion: manifest.version, runtimeVersion: initialized.serverInfo.version,
    sdkVersion: status.sdkVersion, toolCount: listed.tools.length, connectedDevices: devices.length,
    checks: ['initialize', 'tools/list', 'native DLL start', 'status', 'devices', 'capabilities', 'JSON-RPC-only stdout', 'EOF shutdown'],
    physicalHardwareTested: false }, null, 2));
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  if (child.exitCode === null) child.kill();
}
