import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const bin = path.resolve('mcp/sdk-host/build/bin');
test('native input quarantine: durable scoped evidence and explicit recovery', { skip: process.platform !== 'win32' }, async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'umcp-quarantine-contract-'));
  try {
    const { stdout } = await run(path.join(bin, 'umcp-input-quarantine-contract.exe'), [state], { windowsHide: true, timeout: 5000 });
    const result = JSON.parse(stdout);
    assert.equal(result.fakeOnly, true);
    assert.equal(result.sdkLoaded, false);
    assert.equal(result.inputInjection, false);
    assert.ok(result.checks >= 18);
  } finally { await rm(state, { recursive: true, force: true }); }
});
test('native raw button feedback: registration predicate only', { skip: process.platform !== 'win32' }, async () => {
  // The explicit --live-readonly mode is reserved for manual passive acceptance.
  const { stdout } = await run(path.join(bin, 'umcp-raw-feedback-contract.exe'), [], { windowsHide: true, timeout: 5000 });
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.fakeOnly, true);
  assert.equal(receipt.realRegistration, false);
  assert.equal(receipt.sdkLoaded, false);
  assert.equal(receipt.inputInjection, false);
  assert.equal(receipt.cases, 24);
});
for (const name of ['keyboard','mixed','cancel','disconnect','focus-before','focus-after','release-fails','write-throws','write-fails','invalid-tail','invalid-delay','unsupported-buttons','duplicate','cancel-before','deadline']) {
  test(`native input sequence: ${name}`, { skip: process.platform !== 'win32' }, async () => {
    const { stdout } = await run(path.join(bin, 'umcp-sequence-contract.exe'), [name], { windowsHide: true, timeout: 5000 });
    assert.match(stdout, /fake ports only/);
  });
}
for (const name of ['move','click','double','slow-double','delayed-second-down','drag','scroll','cancel-drag','deadline-drag','disconnect',
  'release-fails','release-no-up','release-repress','release-feedback-unhealthy','invalid-duration','occluded','target-change','no-feedback',
  'cancel-before','cancel-before-down','motion-tail','pulse-down-up','pulse-down-up-down','early-up-drag','feedback-unhealthy','feedback-anomaly',
  'baseline-held','baseline-external-held','feedback-missing','focus-while-waiting','press-no-feedback','stale-down','write-throws','write-fails',
  'final-late-down','final-feedback-loss','final-device-change','final-position-drift','click-opens-window','drag-focus-loss',
  'actual-press-occluded','device-change-during-release-snapshot','click-up-opens-window','double-second-occluded','move-unexpected-right',
  'move-feedback-throws','move-feedback-unhealthy','move-scaled','move-nonlinear','move-slow-long','drag-scaled','move-quantized',
  'gain-memory','tolerance-4','micro-stall','precision-high','precision-gate','precision-stall','seed-flat','seed-curve']) {
  test(`native full action: ${name}`, { skip: process.platform !== 'win32' }, async () => {
    const { stdout } = await run(path.join(bin, 'umcp-hardware-contract.exe'), [name], { windowsHide: true, timeout: 5000 });
    assert.equal(JSON.parse(stdout).fakeOnly, true);
  });
}
for (const name of ['umouse-clean', 'umouse-input-query', 'umouse-ptt', 'umouse-no-ack', 'umouse-wrong-boundary',
  'umouse-mouse-quarantine', 'umouse-keyboard-quarantine', 'umouse-corrupt-quarantine', 'umouse-quarantine-no-ack',
  'asr-stream', 'asr-config-failure', 'typer-cancel', 'typer-cancel-after-create', 'screen-clean', 'screen-missing-barrier']) {
  test(`native adapter contract: ${name}`, { skip: process.platform !== 'win32' }, async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'umcp-vendor-contract-'));
    try {
      const { stdout } = await run(path.join(bin, 'umcp-adapter-contract.exe'), [name, bin, state], { windowsHide: true, timeout: 10000 });
      assert.match(stdout, new RegExp(`PASS ${name}`));
      assert.match(stdout, /fake vendor only/);
    } finally { await rm(state, { recursive: true, force: true }); }
  });
}
