/*
 * capabilities.test.mjs —— v2 能力注册表/门控
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceCapabilityRegistry } from '../dist/device-capabilities.js';
import { CapabilityGate } from '../dist/capability-gate.js';

function makeGate(online = ['dev1']) {
  const registry = new DeviceCapabilityRegistry();
  const gate = new CapabilityGate(registry, {}, { isOnline: (id) => online.includes(id) });
  return { registry, gate };
}

test('G01 无硬件能力信息：voice=product-default supported；mouse/keyboard unknown 禁止执行', () => {
  const { registry, gate } = makeGate();
  registry.onGenerationChange('dev1', 1);
  const snap = registry.get('dev1');
  assert.equal(snap.capabilities.voice.support, 'supported');
  assert.equal(snap.capabilities.voice.source, 'product-default', '不伪装为实测');
  assert.equal(snap.capabilities.mouse_control.support, 'unknown');
  assert.equal(snap.capabilities.keyboard_control.support, 'unknown');
  const mouse = gate.check('dev1', 'mouse_control');
  assert.equal(mouse.allowed, false);
  assert.equal(mouse.code, 'capability_unknown');
  const kb = gate.check('dev1', 'keyboard_control');
  assert.equal(kb.allowed, false);
  assert.equal(kb.code, 'capability_unknown');
  const voice = gate.check('dev1', 'voice');
  assert.equal(voice.allowed, true, '语音不依赖鼠标/键盘反控就绪');
});

test('G02 能力组合独立：voice+mouse 支持时 keyboard 仍可 unknown/拒绝', () => {
  const { registry, gate } = makeGate();
  registry.onGenerationChange('dev1', 1);
  registry.setTestProfile('dev1', { mouse_control: 'supported', keyboard_control: 'unsupported' });
  assert.equal(gate.check('dev1', 'mouse_control').allowed, true);
  const kb = gate.check('dev1', 'keyboard_control');
  assert.equal(kb.code, 'capability_unsupported');
  assert.equal(gate.check('dev1', 'voice').allowed, true);
});

test('G04 换代：hardware-info 声明作废回到默认；旧代次快照投递被拒绝', () => {
  const { registry, gate } = makeGate();
  registry.onGenerationChange('dev1', 1);
  registry.applyDeviceCapabilities('dev1', 1, { mouse_control: 'supported' });
  assert.equal(gate.check('dev1', 'mouse_control').allowed, true);
  registry.onGenerationChange('dev1', 2); // 重连
  assert.equal(registry.get('dev1').capabilities.mouse_control.support, 'unknown', 'hardware-info 不跨代存活');
  assert.equal(gate.check('dev1', 'mouse_control').allowed, false);
  assert.throws(() => registry.applyDeviceCapabilities('dev1', 1, { mouse_control: 'supported' }), /代次失配/);
  // 排队期间换代：generationKnown 比对失败
  registry.applyDeviceCapabilities('dev1', 2, { mouse_control: 'supported' });
  const stale = gate.check('dev1', 'mouse_control', { generationKnown: 1 });
  assert.equal(stale.code, 'device_generation_changed');
  assert.equal(gate.check('dev1', 'mouse_control', { generationKnown: 2 }).allowed, true);
});

test('G05/G06 执行拒绝码：disabled / offline / test-profile 来源', () => {
  const { registry } = makeGate();
  const gate = new CapabilityGate(registry, { disabled: { mouse_control: '管理员配置' } }, { isOnline: () => false });
  registry.onGenerationChange('dev1', 1);
  registry.setTestProfile('dev1', { mouse_control: 'supported' });
  assert.equal(gate.check('dev1', 'mouse_control').code, 'capability_disabled');
  const gate2 = new CapabilityGate(registry, {}, { isOnline: () => false });
  const offline = gate2.check('dev1', 'mouse_control');
  assert.equal(offline.code, 'device_offline', '支持≠在线：执行前分别校验');
  assert.equal(registry.get('dev1').capabilities.mouse_control.source, 'test-profile');
});

test('G07 扩展能力经注册表声明；未注册/未知字段不自动变能力', () => {
  const { registry, gate } = makeGate();
  registry.registerCapability({ id: 'future_gesture', description: '未来手势能力' });
  registry.onGenerationChange('dev1', 1);
  assert.equal(registry.get('dev1').capabilities.future_gesture.support, 'unknown');
  assert.equal(gate.check('dev1', 'future_gesture').code, 'capability_unknown');
  assert.throws(() => registry.setTestProfile('dev1', { not_registered: 'supported' }), /未注册能力/);
  assert.throws(() => registry.registerCapability({ id: 'Bad-ID', description: 'x' }), /能力 ID 非法/);
  // 声明后开放
  registry.setTestProfile('dev1', { future_gesture: 'supported' });
  assert.equal(gate.check('dev1', 'future_gesture').allowed, true);
});

test('hardware-info 权威高于 test-profile；同能力低权威不可覆盖高权威', () => {
  const { registry, gate } = makeGate();
  registry.onGenerationChange('dev1', 1);
  registry.setTestProfile('dev1', { mouse_control: 'supported' });
  registry.applyDeviceCapabilities('dev1', 1, { mouse_control: 'unsupported' });
  assert.equal(gate.check('dev1', 'mouse_control').code, 'capability_unsupported', '硬件否决测试声明');
  // test-profile 再写不可翻转 hardware-info
  registry.setTestProfile('dev1', { mouse_control: 'supported' });
  assert.equal(gate.check('dev1', 'mouse_control').code, 'capability_unsupported');
});

test('多设备能力不串用：B 的声明不授予 A（G03 执行按选定设备）', () => {
  const { registry, gate } = makeGate(['a', 'b']);
  registry.onGenerationChange('a', 1);
  registry.onGenerationChange('b', 1);
  registry.setTestProfile('b', { mouse_control: 'supported' });
  assert.equal(gate.check('a', 'mouse_control').code, 'capability_unknown');
  assert.equal(gate.check('b', 'mouse_control').allowed, true);
});
