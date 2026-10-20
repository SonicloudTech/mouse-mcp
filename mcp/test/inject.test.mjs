/*
 * inject.test.mjs —— 固件反向控制编排层离线单测（无需设备/DLL）
 *
 * 覆盖：拆帧求和精确性（splitMove/splitScalar）、按键位图、修饰键解析、
 * InjectController 的点击/按住/释放编排（mock sender 记帧）、
 * 位移失败中止（不重发）、空闲复位兜底。
 * 运行：node mcp/test/inject.test.mjs
 */
import assert from 'node:assert/strict';
import {
  splitMove, splitScalar, parseModifiers, InjectController, BUTTON_BIT,
} from '../dist/inject.js';

let passed = 0;
const pending = [];
function t(name, fn) {
  const run = () => {
    try {
      const r = fn();
      if (r && typeof r.then === 'function') {
        return r.then(
          () => { passed++; console.log(`  ok ${name}`); },
          (e) => { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }
        );
      }
      passed++;
      console.log(`  ok ${name}`);
    } catch (e) {
      console.error(`  FAIL ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  };
  pending.push(Promise.resolve().then(run));
}

console.log('splitMove：序列和精确等于目标，各分量 |v|≤127');
for (const [dx, dy] of [
  [0, 0], [127, 0], [128, 0], [-128, 0], [127, 127], [128, 128],
  [-500, 300], [10000, -10000], [1, -1], [253, 1], [255, 0], [-9999, 3],
]) {
  t(`splitMove(${dx},${dy})`, () => {
    const steps = splitMove(dx, dy);
    if (dx === 0 && dy === 0) {
      assert.equal(steps.length, 0);
      return;
    }
    const sx = steps.reduce((a, s) => a + s.dx, 0);
    const sy = steps.reduce((a, s) => a + s.dy, 0);
    assert.equal(sx, dx, `dx 和 ${sx} ≠ ${dx}`);
    assert.equal(sy, dy, `dy 和 ${sy} ≠ ${dy}`);
    for (const s of steps) {
      assert.ok(Math.abs(s.dx) <= 127 && Math.abs(s.dy) <= 127, `分量越界 ${JSON.stringify(s)}`);
    }
    assert.ok(steps.length <= Math.max(Math.ceil(Math.abs(dx) / 127), Math.ceil(Math.abs(dy) / 127)) + 1, '帧数异常');
  });
}

console.log('splitScalar：总和精确、分量 ≤127');
for (const v of [1, 127, 128, -128, 255, 300, -1000]) {
  t(`splitScalar(${v})`, () => {
    const parts = splitScalar(v);
    assert.equal(parts.reduce((a, b) => a + b, 0), v);
    for (const p of parts) assert.ok(Math.abs(p) <= 127, `分量越界 ${p}`);
  });
}

t('BUTTON_BIT 位图：left=1 right=2 middle=4', () => {
  assert.equal(BUTTON_BIT.left, 1);
  assert.equal(BUTTON_BIT.right, 2);
  assert.equal(BUTTON_BIT.middle, 4);
});

t('parseModifiers：名称/数值/别名', () => {
  assert.equal(parseModifiers(['ctrl']), 0x01);
  assert.equal(parseModifiers(['ctrl', 'shift']), 0x03);
  assert.equal(parseModifiers(['alt', 'gui']), 0x0C);
  assert.equal(parseModifiers(['win']), 0x08);
  assert.equal(parseModifiers(['cmd', 'meta']), 0x08); // 别名按位或后仍 0x08
  assert.equal(parseModifiers([0x02]), 0x02);
  assert.throws(() => parseModifiers(['xxx']));
});

console.log('InjectController（mock sender）');

/** 记录帧的 mock：mode='ok' 全成功；'failMouse' 鼠标帧全失败；'failAt' 第 n 帧起失败 */
function mockSender(mode = 'ok') {
  const frames = { mouse: [], keyboard: [] };
  let n = 0;
  return {
    frames,
    mouse(buttons, dx, dy, wheel) {
      frames.mouse.push({ buttons, dx, dy, wheel });
      if (mode === 'failMouse') return 0;
      if (mode === 'failAt' && ++n >= 3) return 0;
      return 1;
    },
    keyboard(modifiers, usageIds) {
      frames.keyboard.push({ modifiers, usageIds: [...usageIds] });
      return mode === 'ok' ? 1 : 0;
    },
  };
}

const fast = { frameMs: 1, clickMs: 1 };

t('click：down/up 成对、连击帧数正确、无残留按住状态', async () => {
  const m = mockSender();
  const c = new InjectController(m, fast);
  const r = await c.click('left', 2);
  assert.equal(r.frames, 4);
  assert.equal(r.sent, 4);
  assert.equal(r.failed, 0);
  assert.deepEqual(
    m.frames.mouse.map((f) => f.buttons),
    [1, 0, 1, 0]
  );
  assert.equal(c.state().heldButtons, 0);
});

t('button press→release：位图置位/清零，拖拽中 move 帧携带按住位', async () => {
  const m = mockSender();
  const c = new InjectController(m, fast);
  await c.button('press', 'left');
  await c.move(200, 0);   // 拆 2 帧，均应带 buttons=1
  await c.button('release', 'left');
  const btns = m.frames.mouse.map((f) => f.buttons);
  assert.deepEqual(btns, [1, 1, 1, 0]);
});

t('keyTap：修饰键+Usage 按下，随后全零释放帧', async () => {
  const m = mockSender();
  const c = new InjectController(m, fast);
  const r = await c.keyTap(['ctrl', 'shift'], [0x06]);
  assert.equal(r.sent, 2);
  assert.deepEqual(m.frames.keyboard[0], { modifiers: 0x03, usageIds: [0x06] });
  assert.deepEqual(m.frames.keyboard[1], { modifiers: 0, usageIds: [] });
});

t('move 失败中止：不重发、回报 aborted（防位移叠加）', async () => {
  const m = mockSender('failMouse');
  const c = new InjectController(m, fast);
  const r = await c.move(500, 0);
  assert.equal(r.aborted, true);
  assert.equal(r.sent, 0);
  assert.equal(m.frames.mouse.length, 1);   // 首帧失败即止
});

t('部分失败：已发帧保留计数，批次中止', async () => {
  const m = mockSender('failAt');   // 第 3 次调用起失败
  const c = new InjectController(m, fast);
  const r = await c.move(600, 0);   // 拆 5 帧
  assert.equal(r.sent, 2);
  assert.equal(r.failed, 3);
  assert.equal(r.aborted, true);
});

t('releaseAll：受限清理——仅释放本进程已持有通道', async () => {
  const m = mockSender();
  const c = new InjectController(m, fast);
  await c.button('press', 'right');
  const r = await c.releaseAll();
  assert.equal(r.sent, 1);   // 仅鼠标零帧（按住存在）；键盘未持有不发——不能无条件向设备塞键盘零帧
  assert.equal(r.frames, 1);
  const last = m.frames.mouse[m.frames.mouse.length - 1];
  assert.equal(last.buttons, 0);
  assert.equal(c.state().heldButtons, 0);
});

t('scroll：正负拆帧方向正确', async () => {
  const m = mockSender();
  const c = new InjectController(m, fast);
  await c.scroll(300);
  await c.scroll(-5);
  const wheels = m.frames.mouse.map((f) => f.wheel);
  assert.deepEqual(wheels, [127, 127, 46, -5]);
});

t('序列化：并发 move 与 click 不交错（帧序列全局有序）', async () => {
  const m = mockSender();
  const c = new InjectController(m, fast);
  await Promise.all([c.move(300, 0), c.click('left', 1)]);
  // 若交错，mouse 帧序会出现 buttons=1 的点击帧插在位移帧（buttons=0）之间
  const seq = m.frames.mouse.map((f) => `${f.buttons}:${f.dx}`);
  const firstClick = seq.findIndex((s) => s.startsWith('1:'));
  const moveFramesAfter = seq.slice(firstClick + 1).filter((s) => s === '0:127' || s === '0:46');
  assert.equal(moveFramesAfter.length, 0, `点击后不应再有位移帧：${seq.join(' ')}`);
});

t('drag：原子拖拽 press→移动(带按住位)→release，无残留', async () => {
  const m = mockSender();
  const c = new InjectController(m, fast);
  const r = await c.drag('left', 200, 0);   // 拆 2 帧：press + 2×move + release = 4 帧
  assert.equal(r.frames, 4);
  assert.equal(r.sent, 4);
  assert.equal(r.failed, 0);
  const btns = m.frames.mouse.map((f) => f.buttons);
  assert.deepEqual(btns, [1, 1, 1, 0]);
  assert.equal(c.state().heldButtons, 0);
});

t('drag 移动失败：中止但仍抬起，note 提示', async () => {
  const m = mockSender('failAt');   // 第 3 次调用起失败（press+首帧 move 后）
  const c = new InjectController(m, fast);
  const r = await c.drag('left', 200, 0);
  assert.equal(r.aborted, true);
  assert.ok(r.frames >= r.sent + 1, '至少 press 成功 + release 尝试');
  assert.ok(r.note.includes('已抬起'), r.note);
});

t('drag 空位移：仅 press + release 两帧', async () => {
  const m = mockSender();
  const c = new InjectController(m, fast);
  const r = await c.drag('right', 0, 0);
  assert.equal(r.frames, 2);
  assert.deepEqual(m.frames.mouse.map((f) => f.buttons), [2, 0]);
});

t('活动续期：按住期间 move 刷新看门狗（释放前不触发兜底）', async () => {
  const m = mockSender();
  const c = new InjectController(m, { frameMs: 1, clickMs: 1 });
  await c.button('press', 'left');
  // 连续 move（间隔远小于 3s 看门狗）模拟长拖拽
  for (let i = 0; i < 5; i++) await c.move(50, 0);
  await c.button('release', 'left');
  const zeros = m.frames.mouse.filter((f) => f.buttons === 0 && f.dx === 0 && f.dy === 0).length;
  assert.equal(zeros, 1, '仅 release 一帧零帧（看门狗未中途插发全零帧）');
  assert.equal(c.stats.idleResets, 0);
  assert.equal(c.state().heldButtons, 0);
});

console.log('moveTo/clickAt（模拟光标模型）');

/** 模拟光标：unit→px 比例 amp（含指针加速），屏幕范围 [0,2000]x[0,1000] 贴边钳位 */
function simCursor(amp) {
  let cur = { x: 500, y: 500 };
  return {
    reader: () => ({ ...cur }),
    sender: {
      mouse(buttons, dx, dy) {
        cur = {
          x: Math.max(0, Math.min(2000, cur.x + Math.round(dx * amp))),
          y: Math.max(0, Math.min(1000, cur.y + Math.round(dy * amp))),
        };
        return 1;
      },
      keyboard() { return 1; },
    },
  };
}

t('moveTo 1:1 模型：收敛、残差≤容差、iterations 合理', async () => {
  const sim = simCursor(1.0);
  const c = new InjectController(sim.sender, { frameMs: 1, clickMs: 1 }, sim.reader);
  const r = await c.moveTo(300, 200);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.residual.dx) <= 3 && Math.abs(r.residual.dy) <= 3);
  assert.ok(r.iterations <= 6, `迭代过多: ${r.iterations}`);
});

t('moveTo 加速模型(1.16×)：仍收敛不振荡', async () => {
  const sim = simCursor(1.16);
  const c = new InjectController(sim.sender, { frameMs: 1, clickMs: 1 }, sim.reader);
  const r = await c.moveTo(1500, 800);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.residual.dx) <= 3 && Math.abs(r.residual.dy) <= 3);
});

t('moveTo 目标在屏外：停在边缘并说明（不假成功）', async () => {
  const sim = simCursor(1.0);
  const c = new InjectController(sim.sender, { frameMs: 1, clickMs: 1 }, sim.reader);
  const r = await c.moveTo(-50, 500);
  assert.equal(r.ok, false);
  assert.equal(r.final.x, 0);
  assert.ok(r.note.includes('反馈超时'), r.note);
});

t('moveTo 大距离（800px）：单帧≤127 拆步后收敛', async () => {
  const sim = simCursor(1.0);
  const c = new InjectController(sim.sender, { frameMs: 1, clickMs: 1 }, sim.reader);
  const r = await c.moveTo(1800, 900);
  assert.equal(r.ok, true);
  assert.ok(r.iterations <= 15);
});

t('clickAt：先定位后点击，落点处产生 down/up', async () => {
  const sim = simCursor(1.0);
  const c = new InjectController(sim.sender, { frameMs: 1, clickMs: 1 }, sim.reader);
  const r = await c.clickAt(400, 600, 'left', 1);
  assert.equal(r.ok, true);
  assert.ok(r.click && r.click.sent === 2);
  assert.equal(r.click.frames, 2);
});

t('clickAt 定位失败：不执行点击', async () => {
  const sim = simCursor(1.0);
  const c = new InjectController(sim.sender, { frameMs: 1, clickMs: 1 }, sim.reader);
  const r = await c.clickAt(-50, 500, 'left', 1);
  assert.equal(r.ok, false);
  assert.equal(r.click, undefined);
});

await Promise.all(pending);
console.log(`\n${passed} 项通过${process.exitCode ? '（存在失败）' : ''}`);
