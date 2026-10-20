/** hardware hardware backend contract tests: mocks only, no DLL or device access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { InjectController } from '../dist/inject.js';

function rig({ feedback = true, send, config = {} } = {}) {
  const frames = [];
  const cursor = { x: 0, y: 0 };
  const inject = new InjectController({
    mouse(buttons, dx, dy, wheel, deviceId) {
      const frame = { buttons, dx, dy, wheel, deviceId };
      frames.push(frame);
      const rc = send?.(frame, frames.length) ?? 1;
      if (rc === 1 && feedback) { cursor.x += dx; cursor.y += dy; }
      return rc;
    },
    keyboard() { throw new Error('hardware mouse backend must not inject keyboard'); },
  }, { frameMs: 1, clickMs: 2, feedbackTimeoutMs: 40, keyboardEnabled: false, ...config }, () => ({ ...cursor }));
  return { frames, cursor, inject };
}

function counters(result) {
  assert.equal(result.transport.attempted, result.transport.written + result.transport.writeFailed);
}

test('invalid and already-cancelled requests never touch the sender', async () => {
  const { inject, frames } = rig();
  const invalid = await inject.runHardwareAction({ kind: 'drag-path', points: [] });
  assert.equal(invalid.outcome, 'rejected');
  const abort = new AbortController(); abort.abort();
  const cancelled = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 }, { signal: abort.signal });
  assert.equal(cancelled.outcome, 'aborted');
  const partialScroll = await inject.runHardwareAction({ kind: 'scroll', amount: 1, x: 2 });
  assert.equal(partialScroll.outcome, 'rejected');
  assert.deepEqual(frames, []);
});

test('click positions then verifies immediately before right-button double click', async () => {
  const { inject, frames } = rig();
  const checks = [];
  const result = await inject.runHardwareAction({ kind: 'click_at', x: 20, y: 10, button: 'right', count: 2 }, {
    tolPx: 1, preflight: check => { checks.push(check.phase); },
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(checks[0], 'start');
  assert.equal(checks.filter(phase => phase === 'before-press').length, 2);
  assert.ok(checks.includes('step'));
  assert.deepEqual(frames.filter(f => f.buttons !== 0).map(f => f.buttons), [2, 2]);
  assert.equal(result.cleanup, 'release_written');
  assert.equal(inject.state().heldButtons, 0);
  counters(result);
});

test('target rejection before down sends no click and never automatically repositions', async () => {
  const { inject, frames, cursor } = rig();
  const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 }, {
    preflight: ({ phase }) => { if (phase === 'before-press') cursor.x = 50; },
  });
  assert.equal(result.errorCode, 'pointer_changed');
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(frames, []);
});

test('scroll optional target is positioned and checked in the same action', async () => {
  const { inject, frames } = rig();
  const checks = [];
  const result = await inject.runHardwareAction({ kind: 'scroll', x: 30, y: 40, amount: 300 }, {
    preflight: c => checks.push(c.phase),
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(checks[0], 'start');
  assert.equal(checks.filter(phase => phase === 'before-press').length, 1);
  assert.ok(checks.includes('step'));
  assert.deepEqual(frames.filter(f => f.wheel).map(f => f.wheel), [127, 127, 46]);
  assert.ok(frames.every(f => f.buttons === 0));
  assert.equal(result.cleanup, 'not_needed');
  counters(result);
});

test('drag path holds a single lease and releases once after all absolute segments', async () => {
  const { inject, frames } = rig();
  const checks = [];
  const result = await inject.runHardwareAction({ kind: 'drag-path', points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }] }, {
    preflight: c => checks.push(c.phase),
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(checks[0], 'start');
  assert.equal(checks.filter(phase => phase === 'before-press').length, 1);
  assert.ok(checks.filter(phase => phase === 'step').length >= 2);
  assert.equal(frames[0].buttons, 1);
  assert.ok(frames.slice(0, -1).every(f => f.buttons === 1));
  assert.equal(frames.at(-1).buttons, 0);
  assert.equal(inject.state().heldButtons, 0);
  counters(result);
});

for (const kind of ['hardware', 'legacy']) test(`${kind} drag paces the first movement after its separate press frame`, async () => {
  const sentAt = [];
  const frameMs = 40;
  const { inject, frames } = rig({ config: { frameMs }, send: () => { sentAt.push(performance.now()); } });
  try {
    if (kind === 'hardware') {
      const result = await inject.runHardwareAction({ kind: 'drag-path', points: [{ x: 0, y: 0 }, { x: 40, y: 0 }] });
      assert.equal(result.outcome, 'completed');
      counters(result);
    } else {
      const result = await inject.drag('left', 40, 0);
      assert.equal(result.failed, 0);
    }
    const firstMove = frames.findIndex(frame => frame.dx || frame.dy);
    assert.equal(firstMove, 1);
    assert.ok(sentAt[firstMove] - sentAt[0] >= frameMs,
      `press-to-move ${sentAt[firstMove] - sentAt[0]}ms must respect ${frameMs}ms pacing`);
    assert.ok(frames.slice(0, -1).every(frame => frame.buttons === 1));
    assert.equal(frames.at(-1).buttons, 0);
    assert.equal(inject.state().heldButtons, 0);
  } finally { inject.dispose(); }
});

test('cancellation during the initial drag pacing releases without sending movement', async () => {
  const abort = new AbortController();
  let timer;
  const { inject, frames } = rig({ config: { frameMs: 200 }, send: (_frame, index) => {
    if (index === 1) timer = setTimeout(() => abort.abort(), 10);
  } });
  try {
    const result = await inject.runHardwareAction({ kind: 'drag-path', points: [{ x: 0, y: 0 }, { x: 40, y: 0 }] }, {
      signal: abort.signal,
    });
    assert.equal(result.errorCode, 'cancelled');
    assert.equal(result.outcome, 'indeterminate');
    assert.equal(result.cleanup, 'release_written');
    assert.deepEqual(frames.map(frame => [frame.buttons, frame.dx, frame.dy]), [[1, 0, 0], [0, 0, 0]]);
    assert.equal(inject.state().heldButtons, 0);
    counters(result);
  } finally { clearTimeout(timer); inject.dispose(); }
});

test('budget expiry during the initial drag pacing releases without sending movement', async () => {
  const { inject, frames } = rig({ config: { frameMs: 200 } });
  try {
    const result = await inject.runHardwareAction({ kind: 'drag-path', points: [{ x: 0, y: 0 }, { x: 40, y: 0 }] }, {
      budgetMs: 50,
    });
    assert.equal(result.errorCode, 'deadline_exceeded');
    assert.equal(result.outcome, 'indeterminate');
    assert.equal(result.cleanup, 'release_written');
    assert.deepEqual(frames.map(frame => [frame.buttons, frame.dx, frame.dy]), [[1, 0, 0], [0, 0, 0]]);
    assert.equal(inject.state().heldButtons, 0);
    counters(result);
  } finally { inject.dispose(); }
});

test('legacy suspension during the initial drag pacing releases without sending movement', async () => {
  let suspended;
  let timer;
  const { inject, frames } = rig({ config: { frameMs: 200 }, send: (_frame, index) => {
    if (index === 1) timer = setTimeout(() => { suspended = inject.suspend(); }, 10);
  } });
  try {
    await assert.rejects(inject.drag('left', 40, 0), /注入已暂停/);
    await suspended;
    assert.deepEqual(frames.map(frame => [frame.buttons, frame.dx, frame.dy]), [[1, 0, 0], [0, 0, 0]]);
    assert.equal(inject.state().heldButtons, 0);
  } finally { clearTimeout(timer); inject.dispose(); }
});

test('abort after down releases once without movement or repeated click', async () => {
  const controller = new AbortController();
  const { inject, frames } = rig({ send: f => { if (f.buttons) controller.abort(); return 1; } });
  const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0, count: 2 }, { signal: controller.signal });
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.errorCode, 'cancelled');
  assert.equal(result.cleanup, 'release_written');
  assert.deepEqual(frames.map(f => f.buttons), [1, 0]);
  assert.equal(inject.state().heldButtons, 0);
  counters(result);
});

test('unobserved written movement times out without sending a compensating frame', async () => {
  const { inject, frames } = rig({ feedback: false });
  const result = await inject.runHardwareAction({ kind: 'move_to', x: 50, y: 0 });
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.errorCode, 'feedback_timeout');
  assert.equal(frames.length, 1);
  assert.equal(result.transport.written, 1);
  assert.equal(result.residual.dx, 50);
  counters(result);
});

test('deadline during a pressed click releases without executing a second click', async () => {
  const { inject, frames } = rig({ config: { clickMs: 100 } });
  const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0, count: 2 }, { budgetMs: 20 });
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.errorCode, 'deadline_exceeded');
  assert.equal(result.cleanup, 'release_written');
  assert.deepEqual(frames.map(f => f.buttons), [1, 0]);
  counters(result);
});

test('changed target during drag checks stops at the segment boundary and releases', async () => {
  const { inject, frames } = rig();
  const result = await inject.runHardwareAction({ kind: 'drag-path', points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] }, {
    preflight: ({ phase, point }) => { if (phase === 'step' && point.x === 20) throw new Error('target gone'); },
  });
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.errorCode, 'target_preflight_failed');
  assert.equal(result.cleanup, 'release_written');
  assert.deepEqual(frames.map(f => f.buttons), [1, 0]);
  counters(result);
});

test('window changes after the first movement frame: no second business frame, one cleanup', async () => {
  let changed = false;
  const { inject, frames } = rig({ send: frame => { if (frame.dx || frame.dy) changed = true; return 1; } });
  const result = await inject.runHardwareAction({ kind: 'drag-path', points: [{ x: 0, y: 0 }, { x: 500, y: 0 }] }, {
    preflight: () => { if (changed) throw new Error('window changed'); },
  });
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.errorCode, 'target_preflight_failed');
  assert.equal(result.cleanup, 'release_written');
  assert.deepEqual(frames.map(frame => frame.buttons), [1, 1, 0]);
  assert.equal(frames.filter(frame => frame.dx || frame.dy).length, 1);
  counters(result);
});

test('reconnected same-id device never receives old cleanup or later explicit/exit release', async () => {
  let epoch = 1;
  const originalEpoch = epoch;
  const abort = new AbortController();
  const { inject, frames } = rig({ send: frame => {
    if (frame.buttons) { epoch = 2; abort.abort(); }
    return 1;
  } });
  const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 }, {
    deviceId: 'same-id', signal: abort.signal, canRelease: () => epoch === originalEpoch,
  });
  assert.equal(result.cleanup, 'release_unconfirmed');
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(inject.state().heldButtons, 1);
  assert.equal(frames.length, 1);
  const release = await inject.releaseAll('same-id');
  assert.equal(release.sent, 0);
  inject.releaseAllSync();
  assert.equal(frames.length, 1);
  assert.equal(inject.state().heldButtons, 1);
  counters(result);
  inject.dispose();
});

test('throwing epoch guard fails closed without sending cleanup', async () => {
  let pressed = false;
  const { inject, frames } = rig({ send: frame => { if (frame.buttons) pressed = true; return 1; } });
  const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 }, {
    canRelease: () => { if (pressed) throw new Error('device snapshot unavailable'); return true; },
  });
  assert.equal(result.cleanup, 'release_unconfirmed');
  assert.equal(frames.length, 1);
  assert.equal(inject.state().heldButtons, 1);
  inject.dispose();
});

test('idle fallback rechecks the old epoch if connection changes after a failed release', async () => {
  let sameEpoch = true;
  const { inject, frames } = rig({ send: frame => frame.buttons ? 1 : 0 });
  const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 }, { canRelease: () => sameEpoch });
  assert.equal(result.cleanup, 'release_unconfirmed');
  assert.equal(frames.length, 2);
  sameEpoch = false;
  await new Promise(resolve => setTimeout(resolve, 3050));
  await inject.waitUntilIdle();
  assert.equal(frames.length, 2);
  assert.equal(inject.stats.idleResets, 0);
  assert.equal(inject.state().heldButtons, 1);
  inject.dispose();
});

test('deadline includes time waiting behind legacy operations; expired request has no frames', async () => {
  const { inject, frames } = rig({ config: { clickMs: 40 } });
  const old = inject.click('left');
  const bounded = inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0, button: 'right' }, { budgetMs: 5 });
  await old;
  const result = await bounded;
  assert.equal(result.outcome, 'timed_out');
  assert.equal(result.transport.attempted, 0);
  assert.deepEqual(frames.map(f => f.buttons), [1, 0]);
  await inject.waitUntilIdle();
  inject.dispose();
});

test('old and new actions share one queue without interleaved button states', async () => {
  const { inject, frames } = rig({ config: { clickMs: 10 } });
  const hardware = inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0, button: 'middle' });
  const old = inject.click('left');
  await Promise.all([hardware, old]);
  assert.deepEqual(frames.map(f => f.buttons), [4, 0, 1, 0]);
  inject.dispose();
});

test('sender exception after down gets one cleanup and an unknown outcome', async () => {
  const { inject, frames } = rig({ send: f => { if (f.buttons) throw new Error('native error'); return 1; } });
  const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 });
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.errorCode, 'write_outcome_unknown');
  assert.equal(result.cleanup, 'release_written');
  assert.deepEqual(frames.map(f => f.buttons), [1, 0]);
  counters(result);
});

test('release write failure is not called completed and rejects a following hardware action', async () => {
  const { inject, frames } = rig({ send: f => f.buttons ? 1 : 0 });
  const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 });
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.cleanup, 'release_unconfirmed');
  assert.equal(frames.length, 2);
  const next = await inject.runHardwareAction({ kind: 'move_to', x: 20, y: 0 });
  assert.equal(next.errorCode, 'buttons_already_held');
  assert.equal(frames.length, 2);
  counters(result);
  inject.dispose();
});

test('suspension interrupts action feedback but still releases within its queue lease', async () => {
  let inject;
  let suspension;
  const setup = rig({ feedback: false, config: { feedbackTimeoutMs: 5000 }, send: f => {
    if (f.dx) setTimeout(() => { suspension = inject.suspend(); }, 1);
    return 1;
  } });
  inject = setup.inject;
  const result = await inject.runHardwareAction({ kind: 'drag-path', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
  await suspension;
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.errorCode, 'injection_suspended');
  assert.equal(result.cleanup, 'release_written');
  assert.deepEqual(setup.frames.map(f => f.buttons), [1, 1, 0]);
  assert.equal(inject.state().heldButtons, 0);
});

test('stalled read-only preflight respects action deadline and cannot start input later', async () => {
  const { inject, frames } = rig();
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 }, {
    budgetMs: 15, preflight: () => waiting,
  });
  assert.equal(result.outcome, 'timed_out');
  finish();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(frames, []);
});

test('active drag feedback over 3 seconds does not enqueue a competing idle release', async () => {
  const { inject, frames } = rig({ feedback: false, config: { feedbackTimeoutMs: 3050 } });
  const result = await inject.runHardwareAction({ kind: 'drag-path', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }, { budgetMs: 4000 });
  await inject.waitUntilIdle();
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.errorCode, 'feedback_timeout');
  assert.equal(inject.stats.idleResets, 0);
  assert.deepEqual(frames.map(f => f.buttons), [1, 1, 0]);
  assert.equal(inject.state().heldButtons, 0);
  counters(result);
});

test('frame diagnostics are absent unless explicitly enabled', async () => {
  const { inject, frames } = rig();
  for (const options of [{}, { traceFrames: false }]) {
    const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 }, options);
    assert.equal(result.outcome, 'completed');
    assert.equal(Object.hasOwn(result, 'frameTrace'), false);
  }
  assert.equal(frames.length, 4);
});

test('frame diagnostics preserve sender arguments and distinguish final drag cleanup', async () => {
  const { inject, frames } = rig({ send: () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
    return 1;
  } });
  const result = await inject.runHardwareAction({ kind: 'drag-path', points: [{ x: 0, y: 0 }, { x: 50, y: 20 }] }, { traceFrames: true });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.frameTrace.length, frames.length);
  assert.equal(result.frameTrace.length, result.transport.attempted);
  assert.ok(result.frameTrace.slice(0, -1).every(frame => frame.phase === 'business' && frame.buttons === 1));
  assert.equal(result.frameTrace.at(-1).phase, 'cleanup');
  assert.equal(result.frameTrace.at(-1).buttons, 0);
  for (const [index, frame] of result.frameTrace.entries()) {
    assert.equal(frame.index, index + 1);
    assert.ok(Number.isFinite(Date.parse(frame.utc)));
    assert.ok(frame.offsetMs >= 0 && frame.callMs >= 2);
    if (index) assert.ok(frame.offsetMs >= result.frameTrace[index - 1].offsetMs);
    assert.equal(frame.outcome, 'written');
    assert.equal(frame.written, true);
    for (const key of ['buttons', 'dx', 'dy', 'wheel']) assert.equal(frame[key], frames[index][key]);
  }
});

test('failed writes and thrown writes have different trace outcomes and each cleanup is recorded once', async () => {
  for (const throws of [false, true]) {
    const { inject, frames } = rig({ send: frame => {
      if (frame.buttons) { if (throws) throw new Error('unknown native write'); return 0; }
      return 1;
    } });
    const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 }, { traceFrames: true });
    assert.equal(result.errorCode, throws ? 'write_outcome_unknown' : 'write_failed');
    assert.equal(result.cleanup, 'release_written');
    assert.equal(frames.length, 2);
    assert.deepEqual(result.frameTrace.map(frame => frame.phase), ['business', 'cleanup']);
    assert.deepEqual(result.frameTrace.map(frame => frame.outcome), [throws ? 'unknown' : 'failed', 'written']);
    assert.deepEqual(result.frameTrace.map(frame => frame.written), [throws ? null : false, true]);
  }
});

test('failed or thrown final cleanup remains release_unconfirmed and is never retried by diagnostics', async () => {
  for (const throws of [false, true]) {
    const { inject, frames } = rig({ send: frame => {
      if (!frame.buttons) { if (throws) throw new Error('unknown release'); return 0; }
      return 1;
    } });
    try {
      const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 }, { traceFrames: true });
      assert.equal(result.cleanup, 'release_unconfirmed');
      assert.equal(result.outcome, 'indeterminate');
      assert.equal(frames.length, 2);
      assert.equal(result.frameTrace.length, 2);
      assert.equal(result.frameTrace[1].phase, 'cleanup');
      assert.equal(result.frameTrace[1].outcome, throws ? 'unknown' : 'failed');
      assert.equal(result.frameTrace[1].written, throws ? null : false);
    } finally { inject.dispose(); }
  }
});

test('trace bookkeeping failures cannot replace native errors or prevent finally cleanup', async () => {
  const originalToISOString = Date.prototype.toISOString;
  const { inject, frames } = rig({ send: frame => { if (frame.buttons) throw new Error('native error'); return 1; } });
  try {
    Date.prototype.toISOString = () => { throw new Error('diagnostic clock error'); };
    const result = await inject.runHardwareAction({ kind: 'click_at', x: 0, y: 0 }, { traceFrames: true });
    assert.equal(result.errorCode, 'write_outcome_unknown');
    assert.equal(result.cleanup, 'release_written');
    assert.deepEqual(frames.map(frame => frame.buttons), [1, 0]);
    assert.deepEqual(result.frameTrace, []);
  } finally { Date.prototype.toISOString = originalToISOString; }
});

test('frame diagnostics stay within the action frame budget including mandatory cleanup', async () => {
  const { inject, frames } = rig();
  const points = Array.from({ length: 64 }, (_, index) => ({ x: index % 2 ? 500 : 0, y: 0 }));
  const result = await inject.runHardwareAction({ kind: 'drag-path', points }, { traceFrames: true, budgetMs: 20000 });
  assert.equal(result.errorCode, 'frame_budget_exceeded');
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.cleanup, 'release_written');
  assert.equal(result.frameTrace.length, 256);
  assert.equal(frames.length, 256);
  assert.equal(result.transport.attempted, 256);
  assert.equal(result.frameTrace.at(-1).phase, 'cleanup');
  assert.equal(result.frameTrace.at(-1).buttons, 0);
});
