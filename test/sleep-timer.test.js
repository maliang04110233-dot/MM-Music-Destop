/**
 * sleepTimer 单元测试：createSleepTimer 纯工厂（假时钟直驱）
 */
const test = require('node:test');
const assert = require('node:assert');

// contextMenu.js 顶层用了 window.addEventListener；logger.js 用 window.location
global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import(`../src/renderer/js/sleepTimer.js?st=${Math.random()}`);
}

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeoutFn(cb, ms) { const id = ++seq; pending.set(id, { cb, at: now + ms }); return id; },
    clearTimeoutFn(id) { pending.delete(id); },
    nowFn() { return now; },
    advance(ms) {
      now += ms;
      for (const [id, job] of [...pending]) {
        if (job.at <= now) { pending.delete(id); job.cb(); }
      }
    },
    pendingCount: () => pending.size,
  };
}

test('arm 后到点触发一次 onFire，触发后 active 归 false', async () => {
  const { createSleepTimer } = await fresh();
  const t = fakeTimers();
  let fired = 0;
  const st = createSleepTimer({ ...t, onFire: () => fired++ });
  st.arm(30);
  assert.strictEqual(st.active(), true);
  t.advance(29 * 60000);
  assert.strictEqual(fired, 0, '未到点不触发');
  t.advance(60000);
  assert.strictEqual(fired, 1);
  assert.strictEqual(st.active(), false);
  t.advance(60000);
  assert.strictEqual(fired, 1, '只触发一次');
});

test('重复 arm 取代旧定时：只有最后一次会触发', async () => {
  const { createSleepTimer } = await fresh();
  const t = fakeTimers();
  const log = [];
  const st = createSleepTimer({ ...t, onFire: () => log.push('fire') });
  st.arm(15);
  st.arm(45);
  t.advance(15 * 60000);
  assert.deepStrictEqual(log, [], '第一次到点应已被取代');
  t.advance(30 * 60000);
  assert.deepStrictEqual(log, ['fire']);
});

test('cancel 后到点不再触发，pending 清空', async () => {
  const { createSleepTimer } = await fresh();
  const t = fakeTimers();
  let fired = 0;
  const st = createSleepTimer({ ...t, onFire: () => fired++ });
  st.arm(60);
  st.cancel();
  assert.strictEqual(st.active(), false);
  assert.strictEqual(t.pendingCount(), 0, '旧定时器句柄应被清掉');
  t.advance(120 * 60000);
  assert.strictEqual(fired, 0);
});

test('remainingMin 向上取整且至少 1，未武装为 0', async () => {
  const { createSleepTimer } = await fresh();
  const t = fakeTimers();
  const st = createSleepTimer({ ...t, onFire: () => {} });
  assert.strictEqual(st.remainingMin(), 0);
  st.arm(30);
  assert.strictEqual(st.remainingMin(), 30);
  t.advance(60000);
  assert.strictEqual(st.remainingMin(), 29);
  t.advance(29 * 60000 - 1); // 还剩 1ms
  assert.strictEqual(st.remainingMin(), 1, '残余不足 1 分钟也显示 1，不能显示 0');
});

test('onFire 抛异常被吞，不影响后续再次 arm', async () => {
  const { createSleepTimer } = await fresh();
  const t = fakeTimers();
  let n = 0;
  const st = createSleepTimer({
    ...t,
    onFire: () => { n++; if (n === 1) throw new Error('boom'); },
  });
  st.arm(10);
  t.advance(10 * 60000); // 不该炸出来
  assert.strictEqual(n, 1);
  st.arm(10);
  t.advance(10 * 60000);
  assert.strictEqual(n, 2, '异常后工厂仍可正常使用');
});

test('arm(0) / 负数 / NaN 不武装', async () => {
  const { createSleepTimer } = await fresh();
  const t = fakeTimers();
  let fired = 0;
  const st = createSleepTimer({ ...t, onFire: () => fired++ });
  st.arm(0);
  st.arm(-5);
  st.arm(NaN);
  assert.strictEqual(st.active(), false);
  assert.strictEqual(t.pendingCount(), 0);
  t.advance(999 * 60000);
  assert.strictEqual(fired, 0);
});
