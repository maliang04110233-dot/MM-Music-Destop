'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const tb = require('../src/main/taskbarProgress');

const item = (status, progress) => ({ taskId: Math.random().toString(36).slice(2), status, progress });

test('computeQueueStats：空队列 / 只有已完成 → ratio -1（清除进度）', () => {
  assert.strictEqual(tb.computeQueueStats([]).ratio, -1);
  assert.strictEqual(tb.computeQueueStats([item('done'), item('error')]).ratio, -1);
  assert.strictEqual(tb.computeQueueStats(null).tooltip, '音乐下载器');
});

test('computeQueueStats：ratio = (done + Σdownloading进度) / (pending+downloading+done)', () => {
  const list = [item('done'), item('done'), item('downloading', 50), item('pending'), item('pending')];
  const s = tb.computeQueueStats(list);
  assert.ok(Math.abs(s.ratio - (2 + 0.5) / 5) < 1e-9);
  assert.deepStrictEqual(
    { pending: s.pending, downloading: s.downloading, done: s.done, error: s.error },
    { pending: 2, downloading: 1, done: 2, error: 0 }
  );
});

test('computeQueueStats：进度越界钳制到 0..1', () => {
  const s = tb.computeQueueStats([item('downloading', 130), item('pending')]);
  assert.strictEqual(s.ratio, 1 / 2);
  const s2 = tb.computeQueueStats([item('downloading', -5), item('pending')]);
  assert.strictEqual(s2.ratio, 0);
});

test('computeQueueStats：progress 缺失按 0 计', () => {
  const s = tb.computeQueueStats([{ taskId: 'x', status: 'downloading' }, item('pending')]);
  assert.strictEqual(s.ratio, 0);
});

test('computeQueueStats：活跃时 tooltip 含各状态计数（含失败）', () => {
  const s = tb.computeQueueStats([item('downloading', 10), item('pending'), item('done'), item('error'), item('error')]);
  assert.match(s.tooltip, /下载中 1/);
  assert.match(s.tooltip, /排队 1/);
  assert.match(s.tooltip, /已完成 1/);
  assert.match(s.tooltip, /失败 2/);
});

test('computeQueueStats：null 项与未知状态不崩溃（不计入分母）', () => {
  const s = tb.computeQueueStats([null, item('weird'), item('pending')]);
  assert.strictEqual(s.pending, 1);
  assert.strictEqual(s.ratio, 0);
});

// ── apply / refresh 落地行为（假窗口、假托盘） ──────────────

function fakeWin() {
  const calls = [];
  return { calls, isDestroyed: () => false, setProgressBar: v => calls.push(v) };
}
function fakeTray() {
  const tips = [];
  return { tips, setToolTip: t => tips.push(t) };
}

test('apply：同值进度去抖，变化才下发；清除(-1)总是下发', () => {
  tb.init({ getWindows: () => [], getTray: () => null });
  tb._reset();
  const w = fakeWin(), tr = fakeTray();
  tb.init({ getWindows: () => [w], getTray: () => tr });
  const running = [item('downloading', 42), item('pending')];
  tb.apply(running);
  const firstCalls = w.calls.length;
  tb.apply(running); // 同值 → 去抖
  assert.strictEqual(w.calls.length, firstCalls);
  tb.apply([item('downloading', 80), item('pending')]);
  assert.strictEqual(w.calls.length, firstCalls + 1);
  assert.strictEqual(w.calls[w.calls.length - 1], 0.4);
  tb.apply([]); // 空闲 → 清除
  assert.strictEqual(w.calls[w.calls.length - 1], -1);
});

test('apply：tooltip 文案仅在变化时更新', () => {
  tb.init({ getWindows: () => [], getTray: () => null });
  tb._reset();
  const tr = fakeTray();
  tb.init({ getWindows: () => [], getTray: () => tr });
  const running = [item('downloading', 10), item('pending')];
  tb.apply(running);
  tb.apply([item('downloading', 90), item('pending')]); // 进度变了但文案相同
  assert.strictEqual(tr.tips.length, 1);
  tb.apply([]);
  assert.strictEqual(tr.tips.length, 2);
  assert.strictEqual(tr.tips[1], '音乐下载器');
});

test('apply：已销毁窗口 / 抛错的 setter 不影响其他窗口', () => {
  tb.init({ getWindows: () => [], getTray: () => null });
  tb._reset();
  const ok = fakeWin();
  const bad = { isDestroyed: () => false, setProgressBar: () => { throw new Error('boom'); } };
  const gone = { isDestroyed: () => true, setProgressBar: () => { throw new Error('never'); } };
  tb.init({ getWindows: () => [bad, gone, ok], getTray: () => { throw new Error('tray-gone'); } });
  tb.apply([item('downloading', 55), item('pending')]);
  assert.ok(ok.calls.length >= 1);
});

test('refresh：getQueue 抛错被吞，绝不外泄', () => {
  tb.init({ getWindows: () => [], getTray: () => null });
  tb._reset();
  tb.refresh(() => { throw new Error('ctx not ready'); }); // 不抛即通过
});

test('未 init 时 apply 也可安全调用（getter 默认空）', () => {
  const fresh = require('../src/main/taskbarProgress');
  fresh._reset();
  fresh.apply([item('downloading', 5), item('pending')]);
});
