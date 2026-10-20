import test from 'node:test';
import assert from 'node:assert/strict';
import { SleepResetController, isSleepResetAck } from '../dist/sleep-reset.js';

class FakeScheduler {
  time = 1_000;
  pending = new Set();
  now = () => this.time;
  setTimeout = (callback, ms) => {
    const handle = { at: this.time + ms, callback, unreferenced: false,
      unref() { this.unreferenced = true; } };
    this.pending.add(handle);
    return handle;
  };
  clearTimeout = (handle) => { this.pending.delete(handle); };
  advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.pending].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.pending.delete(next);
      this.time = next.at;
      next.callback();
    }
    this.time = end;
  }
}

function fixture(options = {}, sender) {
  const clock = new FakeScheduler();
  const writes = [], events = [];
  const controller = new SleepResetController((data, id) => {
    writes.push({ hex: data.toString('hex'), id, at: clock.now() });
    return sender ? sender(data, id) : 1;
  }, { onEvent: (id, payload) => events.push({ id, ...payload }), ...options }, clock);
  return { clock, writes, events, controller };
}
const ack = Buffer.from('0a178105a2', 'hex');

test('A2: default no-reply protocol never waits or times out, and still observes optional replies', () => {
  const { clock, writes, events, controller } = fixture();
  controller.start(); controller.onConnected('mouse-1'); clock.advance(0);
  assert.equal(controller.status().acknowledgementExpected,false);
  assert.equal(controller.status().devices[0].awaitingAck,false);
  assert.equal(clock.pending.size,1,'only the next periodic send timer is armed');
  clock.advance(720_000);
  assert.equal(writes.length,7);
  assert.equal(controller.status().acknowledgementTimeouts,0);
  assert.equal(events.some(e=>e.phase==='ackTimeout'),false);
  assert.equal(controller.onRawFrame('mouse-1',ack),true);
  assert.equal(controller.status().acknowledgementsOutsideWindow,1);
  assert.equal(clock.pending.size,1);
  assert.doesNotThrow(()=>fixture({intervalMs:1000}),'inactive ACK window does not constrain periodic interval');
});

test('A2: send asynchronously on connection, then every 120 seconds with unref timers', () => {
  const { clock, writes, controller } = fixture();
  controller.start();
  controller.onConnected('mouse-1');
  assert.equal(writes.length, 0, 'SDK callback must not write reentrantly');
  assert.ok([...clock.pending].every(t => t.unreferenced));
  clock.advance(0);
  assert.deepEqual(writes, [{ hex: '0a03a2', id: 'mouse-1', at: 1000 }]);
  controller.onConnected('mouse-1');
  clock.advance(119_999);
  assert.equal(writes.length, 1, 'ACK timeout must not trigger immediate retry');
  clock.advance(1);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].at - writes[0].at, 120_000);
  assert.ok([...clock.pending].every(t => t.unreferenced));
});

test('A2: connections before start are scheduled only after start; start is idempotent', () => {
  const { clock, writes, controller } = fixture();
  controller.onConnected('mouse-1');
  clock.advance(500_000);
  assert.equal(writes.length, 0);
  controller.start();
  controller.start();
  assert.equal(writes.length, 0);
  clock.advance(0);
  assert.equal(writes.length, 1);
});

test('A2: exact ACK protocol, short/wrong/F0/embedded frames rejected; USB prefix only', () => {
  assert.equal(isSleepResetAck(ack), true);
  assert.equal(isSleepResetAck(Buffer.from('0a0a178105a2000000', 'hex'), 0), true);
  assert.equal(isSleepResetAck(ack, 1), true);
  assert.equal(isSleepResetAck(Buffer.from('0a0a178105a2', 'hex'), 1), false);
  for (const hex of ['', '0a178105', '0a0a178105', '0a178106a2', '0a178105f0',
    '0a0a178106f001', '99178105a2', '000a178105a2', '0a0a0a178105a2', '0a178005a2']) {
    assert.equal(isSleepResetAck(Buffer.from(hex, 'hex')), false, hex);
  }
});

test('A2: transport success is not ACK; late/duplicate ACK is unsequenced observation', () => {
  const { clock, controller, writes } = fixture({expectAck:true});
  controller.start(); controller.onConnected('mouse-1'); clock.advance(0);
  let state = controller.status();
  assert.equal(state.writesSucceeded, 1);
  assert.equal(state.acknowledgements, 0);
  assert.equal(state.devices[0].awaitingAck, true);
  assert.equal(controller.onRawFrame('unknown', ack), false);
  assert.equal(controller.onRawFrame('mouse-1', Buffer.from('0a178106f001', 'hex')), false);
  clock.advance(123);
  assert.equal(controller.onRawFrame('mouse-1', ack), true);
  assert.equal(controller.onRawFrame('mouse-1', ack), true);
  clock.advance(5_000);
  state = controller.status();
  assert.equal(state.acknowledgementsInWindow, 1);
  assert.equal(state.acknowledgementsOutsideWindow, 1);
  assert.equal(state.acknowledgementTimeouts, 0);
  assert.equal(state.devices[0].awaitingAck, false);
  assert.equal(state.acknowledgementCorrelation, 'unsequenced');
  assert.equal(writes.length, 1);
});

test('A2: timeout is diagnostic only; late ACK does not erase timeout or resend', () => {
  const { clock, controller, writes, events } = fixture({expectAck:true});
  controller.start(); controller.onConnected('mouse-1'); clock.advance(5_000);
  assert.equal(controller.status().acknowledgementTimeouts, 1);
  assert.ok(events.some(e => e.phase === 'ackTimeout' && e.execution === 'unknown'));
  controller.onRawFrame('mouse-1', ack);
  assert.equal(controller.status().acknowledgementsOutsideWindow, 1);
  assert.equal(controller.status().acknowledgementTimeouts, 1);
  assert.equal(writes.length, 1);
});

test('A2: disconnected devices and stopped controllers never write queued work', () => {
  const { clock, controller, writes } = fixture();
  controller.start(); controller.onConnected('gone-before-send');
  controller.onDisconnected('gone-before-send'); clock.advance(0);
  assert.equal(writes.length, 0);
  controller.onConnected('mouse-1'); controller.onConnected('mouse-2'); clock.advance(0);
  assert.equal(writes.length, 2);
  controller.onDisconnected('mouse-1'); clock.advance(120_000);
  assert.equal(writes.filter(w => w.id === 'mouse-1').length, 1);
  assert.equal(writes.filter(w => w.id === 'mouse-2').length, 2);
  controller.stop();
  assert.equal(clock.pending.size, 0);
  clock.advance(1_000_000);
  assert.equal(writes.length, 3);
  assert.equal(controller.onRawFrame('mouse-2', ack), false);
  assert.deepEqual(controller.status().devices, []);
});

test('A2: reconnect cancels old timers and uses a new immediate schedule', () => {
  const { clock, controller, writes } = fixture();
  controller.start(); controller.onConnected('mouse-1'); clock.advance(0);
  clock.advance(1_000); controller.onDisconnected('mouse-1');
  controller.onConnected('mouse-1'); clock.advance(0);
  clock.advance(119_000);
  assert.equal(writes.length, 2, 'old timer must not fire');
  clock.advance(1_000);
  assert.equal(writes.length, 3);
  controller.stop(); controller.start(); clock.advance(0);
  assert.equal(writes.length, 3, 'restart does not revive stale connected entries');
});

test('A2: write failure/exception is recorded, with no ACK wait or high-frequency retry', () => {
  for (const sender of [() => 0, () => { throw new Error('device disconnected'); }]) {
    const { clock, controller, writes } = fixture({}, sender);
    controller.start(); controller.onConnected('mouse-1'); clock.advance(119_999);
    const state = controller.status();
    assert.equal(state.writesFailed, 1);
    assert.equal(state.writesSucceeded, 0);
    assert.equal(state.acknowledgementTimeouts, 0);
    assert.equal(state.devices[0].awaitingAck, false);
    assert.ok(state.devices[0].lastError);
    assert.equal(writes.length, 1);
    clock.advance(1); assert.equal(writes.length, 2);
  }
});

test('A2: disabled mode sends nothing; status snapshots do not expose mutable state', () => {
  const disabled = fixture({ enabled: false });
  disabled.controller.start(); disabled.controller.onConnected('mouse-1');
  disabled.clock.advance(500_000);
  assert.equal(disabled.writes.length, 0);
  assert.equal(disabled.controller.status().running, false);
  const { controller, clock } = fixture();
  controller.start(); controller.onConnected('mouse-1'); clock.advance(0);
  const snapshot = controller.status(); snapshot.devices[0].awaitingAck = true;
  assert.equal(controller.status().devices[0].awaitingAck, false);
});

test('A2: observer exceptions do not turn transport success into failure or stop scheduling', () => {
  const { controller, clock, writes } = fixture({ onEvent: () => { throw new Error('observer'); } });
  controller.start(); controller.onConnected('mouse-1'); clock.advance(120_000);
  assert.equal(writes.length, 2);
  assert.equal(controller.status().writesSucceeded, 2);
  assert.equal(controller.status().writesFailed, 0);
});

test('A2: callback-side stop cancels follow-up timers; early ACK is observed once', () => {
  let controller;
  const early = fixture({expectAck:true}, () => { controller.onRawFrame('mouse-1', ack); return 1; });
  controller = early.controller;
  controller.start(); controller.onConnected('mouse-1'); early.clock.advance(5_000);
  assert.equal(controller.status().acknowledgementsInWindow, 1);
  assert.equal(controller.status().acknowledgementTimeouts, 0);
  const stopped = fixture({ onEvent: () => stopped.controller.stop() });
  stopped.controller.start(); stopped.controller.onConnected('mouse-1'); stopped.clock.advance(500_000);
  assert.equal(stopped.writes.length, 1);
  assert.equal(stopped.clock.pending.size, 0);
});

test('A2: invalid timer configuration rejected instead of Node clamping to hot loop', () => {
  for (const intervalMs of [0, -1, NaN, Infinity, 2_147_483_648, 1.1]) {
    assert.throws(() => fixture({ intervalMs }), RangeError);
  }
  for (const ackTimeoutMs of [0, -1, NaN, Infinity, 120_000, 120_001]) {
    assert.throws(() => fixture({ ackTimeoutMs,expectAck:true }), RangeError);
  }
});
