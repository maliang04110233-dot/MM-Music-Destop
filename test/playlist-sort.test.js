/**
 * 歌单拖拽排序纯函数测试（增量61）
 * playlistSort.js 无 DOM / window 依赖，动态 import 加缓存戳避免污染。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import(`../src/renderer/js/playlistSort.js?ck=${Math.random()}`);

test('moveInList 向下移动：占据目标位置', async () => {
  const { moveInList } = await mod();
  const r = moveInList(['a', 'b', 'c', 'd'], 0, 2);
  assert.deepEqual(r, ['b', 'c', 'a', 'd']);
});

test('moveInList 向上移动', async () => {
  const { moveInList } = await mod();
  const r = moveInList(['a', 'b', 'c'], 2, 0);
  assert.deepEqual(r, ['c', 'a', 'b']);
});

test('moveInList 不修改原数组', async () => {
  const { moveInList } = await mod();
  const src = ['a', 'b', 'c'];
  moveInList(src, 0, 2);
  assert.deepEqual(src, ['a', 'b', 'c']);
});

test('moveInList 无效输入返回 null（同位/越界/短列表/非数组）', async () => {
  const { moveInList } = await mod();
  assert.equal(moveInList(['a', 'b'], 1, 1), null);
  assert.equal(moveInList(['a', 'b'], -1, 1), null);
  assert.equal(moveInList(['a', 'b'], 0, 2), null);
  assert.equal(moveInList(['a'], 0, 0), null);
  assert.equal(moveInList(null, 0, 1), null);
  assert.equal(moveInList('ab', 0, 1), null);
});
