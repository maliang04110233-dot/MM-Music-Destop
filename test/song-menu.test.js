/**
 * 单元测试：renderer/songMenu.js —— 「下一首播放」队列插入逻辑
 *
 * playNextHere 会直接改写播放队列（splice + 双 setState），
 * 索引算错会把用户队列搞乱，且「已在下一首」「队列中移动」等分支
 * 都是肉眼难验证的细节，值得钉死。
 *
 * 渲染层模块在 node 里可导入的前提：先补 window 桩
 * （contextMenu.js 顶层 window.addEventListener、logger.js 顶层读 window.location）。
 */

const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import('../src/renderer/js/songMenu.js?tc=' + Math.random());
}

/** 用普通对象桩接管 getState/setState/showToast（模块内均为调用期全局查找） */
function installStateGlobals(store) {
  global.getState = (k) => store[k];
  global.setState = (k, v) => { store[k] = v; };
  global.showToast = () => {};
  return store;
}

const song = (id) => ({ id, source: 'netease', title: 'S' + id });

test('未在播放：回退到「立即播放」回调，不动队列', async () => {
  const { playNextHere } = await fresh();
  const q = [song(1), song(2)];
  const store = installStateGlobals({ playQueue: q, playIdx: -1 });
  let played = 0;
  playNextHere(song(9), () => { played++; });
  assert.strictEqual(played, 1);
  assert.strictEqual(store.playQueue.length, 2);
});

test('正在播放：插入到当前曲之后，playIdx 不变', async () => {
  const { playNextHere } = await fresh();
  const store = installStateGlobals({ playQueue: [song(1), song(2), song(3)], playIdx: 1 });
  playNextHere(song(9), () => {});
  assert.deepStrictEqual(store.playQueue.map(s => s.id), [1, 2, 9, 3]);
  assert.strictEqual(store.playIdx, 1);
});

test('目标已在下一首：提示且不重复插入', async () => {
  const { playNextHere } = await fresh();
  const s9 = song(9);
  const store = installStateGlobals({ playQueue: [song(1), song(2), s9], playIdx: 1 });
  playNextHere(s9, () => {});
  assert.strictEqual(store.playQueue.length, 3);
  assert.strictEqual(store.playQueue[2], s9);
});

test('目标已在队列靠前位置：移动而非重复插入，playIdx 前移补偿', async () => {
  const { playNextHere } = await fresh();
  const s9 = song(9);
  const store = installStateGlobals({ playQueue: [s9, song(2), song(3), song(4)], playIdx: 2 });
  playNextHere(s9, () => {});
  // 原队列移除 s9 后当前曲(3)索引 2→1，插到它后面
  assert.deepStrictEqual(store.playQueue.map(s => s.id), [2, 3, 9, 4]);
  assert.strictEqual(store.playIdx, 1);
  assert.strictEqual(store.playQueue.filter(s => s.id === 9).length, 1);
});

test('目标已在队列靠后位置：移到下一首，playIdx 不变', async () => {
  const { playNextHere } = await fresh();
  const s9 = song(9);
  const store = installStateGlobals({ playQueue: [song(1), song(2), song(3), s9], playIdx: 0 });
  playNextHere(s9, () => {});
  assert.deepStrictEqual(store.playQueue.map(s => s.id), [1, 9, 2, 3]);
  assert.strictEqual(store.playIdx, 0);
});
