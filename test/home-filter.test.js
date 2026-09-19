// 首页榜单过滤纯逻辑（homeFilter.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function fresh() {
  return import(`../src/renderer/js/homeFilter.js?ck=${Math.random()}`);
}

const SONGS = () => [
  { title: '红尘客栈', artist: '周杰伦' },
  { title: 'Hello', artist: 'Adele' },
  { title: '稻香', artist: '周杰伦' },
  { title: 'hello 翻唱', artist: '某人' },
];

const CARDS = () => [
  { id: 1, name: '云音乐热歌榜' },
  { id: 2, name: '抖音热歌' },
  { id: 3, name: '周杰伦精选' },
];

test('无关键词：list 返回全量 pairs，i 为原始下标', async () => {
  const { filterHomeSection } = await fresh();
  const { pairs } = filterHomeSection('list', SONGS(), '');
  assert.equal(pairs.length, 4);
  assert.deepEqual(pairs.map(p => p.i), [0, 1, 2, 3]);
});

test('按标题匹配保留原始下标（点 A 播 A 的前提）', async () => {
  const { filterHomeSection } = await fresh();
  const { pairs } = filterHomeSection('list', SONGS(), '稻香');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].i, 2);
  assert.equal(pairs[0].s.title, '稻香');
});

test('按歌手匹配命中多行；大小写不敏感 + 首尾空白容错', async () => {
  const { filterHomeSection } = await fresh();
  assert.equal(filterHomeSection('list', SONGS(), '周杰伦').pairs.length, 2);
  assert.equal(filterHomeSection('list', SONGS(), '  HELLO ').pairs.length, 2);
});

test('无命中返回空 pairs（由调用方渲染空态）', async () => {
  const { filterHomeSection } = await fresh();
  assert.deepEqual(filterHomeSection('list', SONGS(), '不存在的歌').pairs, []);
});

test('grid 按歌单名过滤，返回 items 原对象', async () => {
  const { filterHomeSection } = await fresh();
  const { items } = filterHomeSection('grid', CARDS(), '周杰伦');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 3);
});

test('脏输入不炸：null/undefined data 归一为空', async () => {
  const { filterHomeSection } = await fresh();
  assert.deepEqual(filterHomeSection('list', null, 'x').pairs, []);
  assert.deepEqual(filterHomeSection('grid', undefined, '').items, []);
});
