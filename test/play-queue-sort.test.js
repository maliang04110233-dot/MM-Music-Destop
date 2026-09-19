/**
 * playQueueSort 单元测试：applyPqDragMove 移动语义与 playIdx 跟随
 */
const test = require('node:test');
const assert = require('node:assert');

// playQueueSort.js 顶层：logger 用 window.location；桥接挂 window；
// document 缺席时自动跳过 DOM 接线 —— node 下安全
global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import(`../src/renderer/js/playQueueSort.js?ps=${Math.random()}`);
}

test('向下移动：落点即该位置（from<to 时结果排到目标行原位）', async () => {
  const { applyPqDragMove } = await fresh();
  const q = ['a', 'b', 'c', 'd'];
  const r = applyPqDragMove(q, -1, 0, 2);
  assert.deepStrictEqual(r.queue, ['b', 'c', 'a', 'd']);
  assert.deepStrictEqual(q, ['a', 'b', 'c', 'd'], '不可原地突变入参');
});

test('向上移动：d 从末位挪到 1', async () => {
  const { applyPqDragMove } = await fresh();
  const r = applyPqDragMove(['a', 'b', 'c', 'd'], -1, 3, 1);
  assert.deepStrictEqual(r.queue, ['a', 'd', 'b', 'c']);
});

test('无效拖拽返回 null：同位/越界/空/单元素', async () => {
  const { applyPqDragMove } = await fresh();
  assert.strictEqual(applyPqDragMove(['a', 'b'], 0, 1, 1), null);
  assert.strictEqual(applyPqDragMove(['a', 'b'], 0, -1, 1), null);
  assert.strictEqual(applyPqDragMove(['a', 'b'], 0, 0, 5), null);
  assert.strictEqual(applyPqDragMove(['a'], 0, 0, 0), null);
  assert.strictEqual(applyPqDragMove(null, 0, 0, 1), null);
});

test('拖动当前播放行本身：高亮跟到 to', async () => {
  const { applyPqDragMove } = await fresh();
  const r = applyPqDragMove(['a', 'b', 'c', 'd'], 1, 1, 3);
  assert.deepStrictEqual(r.queue, ['a', 'c', 'd', 'b']);
  assert.strictEqual(r.playIdx, 3);
});

test('前面的非播放行挪到播放行之后：播放下标前移 1', async () => {
  const { applyPqDragMove } = await fresh();
  // 播放 b(1)，把 a(0) 拖到 c(2)
  const r = applyPqDragMove(['a', 'b', 'c', 'd'], 1, 0, 2);
  assert.deepStrictEqual(r.queue, ['b', 'c', 'a', 'd']);
  assert.strictEqual(r.playIdx, 0);
});

test('后面的行挪到播放行前面：播放下标后移 1', async () => {
  const { applyPqDragMove } = await fresh();
  // 播放 b(1)，把 c(2) 拖到 0
  const r = applyPqDragMove(['a', 'b', 'c', 'd'], 1, 2, 0);
  assert.deepStrictEqual(r.queue, ['c', 'a', 'b', 'd']);
  assert.strictEqual(r.playIdx, 2);
});

test('playIdx 恰好等于被拖到的原占位（to===旧idx 但非拖动行）时仍正确', async () => {
  const { applyPqDragMove } = await fresh();
  // 播放 d(3)，把 c(2) 拖到 3 —— to 是播放行原位
  const r = applyPqDragMove(['a', 'b', 'c', 'd'], 3, 2, 3);
  assert.deepStrictEqual(r.queue, ['a', 'b', 'd', 'c']);
  assert.strictEqual(r.playIdx, 2);
});
