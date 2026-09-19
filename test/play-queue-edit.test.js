import { test } from 'node:test';
import assert from 'node:assert/strict';

const src = `../src/renderer/js/playQueueEdit.js?ck=${Math.random()}`;
const { pqSongKey, removeQueueItem, dedupeQueue } = await import(src);

const s = (id, source = 'netease', title = null) => ({ id, source, title: title || `歌${id}`, artist: 'A' });

test('pqSongKey：有 id+source 走平台坐标，缺失退回歌名+歌手归一', () => {
  assert.equal(pqSongKey(s('1')), 'p|netease|1');
  assert.equal(pqSongKey({ title: '  Quiet Night ', artist: 'DL' }), 'm|quiet night|dl');
  assert.equal(pqSongKey({ id: '', source: 'x', title: 'T', artist: '' }), 'm|t|');
  assert.equal(pqSongKey(null), null);
  assert.equal(pqSongKey({}), null);
});

test('removeQueueItem：移除前面行，playIdx 左移跟随', () => {
  const q = [s('1'), s('2'), s('3'), s('4')];
  const r = removeQueueItem(q, 2, 0);
  assert.deepEqual(r.queue.map(x => x.id), ['2', '3', '4']);
  assert.equal(r.playIdx, 1);
  assert.equal(r.removedCurrent, false);
});

test('removeQueueItem：移除正在播放行 → 补位下一首继续高亮', () => {
  const q = [s('1'), s('2'), s('3')];
  const r = removeQueueItem(q, 1, 1);
  assert.deepEqual(r.queue.map(x => x.id), ['1', '3']);
  assert.equal(r.playIdx, 1, '2 被删后 3 补到 1 位，高亮跟随');
  assert.equal(r.removedCurrent, true);
});

test('removeQueueItem：移除末行正在播放 → 高亮钳回新队尾；队空 playIdx=-1', () => {
  const r1 = removeQueueItem([s('1'), s('2')], 1, 1);
  assert.equal(r1.playIdx, 0);
  assert.equal(r1.removedCurrent, true);
  const r2 = removeQueueItem([s('1')], 0, 0);
  assert.deepEqual(r2.queue, []);
  assert.equal(r2.playIdx, -1);
});

test('removeQueueItem：非法输入全部拒绝', () => {
  assert.equal(removeQueueItem([], 0, 0), null);
  assert.equal(removeQueueItem([s('1')], 0, 5), null);
  assert.equal(removeQueueItem([s('1')], 0, -1), null);
  assert.equal(removeQueueItem([s('1')], 0, 1.5), null);
  assert.equal(removeQueueItem(null, 0, 0), null);
});

test('dedupeQueue：同曲留首现，playIdx 跟随留下的那份', () => {
  const q = [s('1'), s('2'), s('1', 'netease'), s('3'), s('2')];
  const r = dedupeQueue(q, 4);
  assert.deepEqual(r.queue.map(x => x.id), ['1', '2', '3']);
  assert.equal(r.removed, 2);
  assert.equal(r.playIdx, 1, '原 4 号（2 重复）跟到首现位置 1');
});

test('dedupeQueue：跨平台同 id 不算重；元数据键大小写/空白归一', () => {
  const q = [s('1', 'netease'), s('1', 'qq')];
  assert.equal(dedupeQueue(q, 0).removed, 0);
  const q2 = [{ title: 'A A', artist: 'X' }, { title: ' a a ', artist: 'x' }];
  assert.equal(dedupeQueue(q2, 1).removed, 1);
});

test('dedupeQueue：无重复时原样返回；空/脏输入安全', () => {
  const q = [s('1'), s('2')];
  const r = dedupeQueue(q, 0);
  assert.deepEqual(r.queue, q);
  assert.equal(r.removed, 0);
  assert.equal(r.playIdx, 0);
  assert.deepEqual(dedupeQueue(null, 0), { queue: [], playIdx: -1, removed: 0 });
  assert.deepEqual(dedupeQueue([], 0).playIdx, -1);
});

test('dedupeQueue：无键行（both 空 title 无 id）不误并', () => {
  const q = [{ artist: 'x' }, { artist: 'y' }];
  assert.equal(dedupeQueue(q, 0).removed, 0);
});
