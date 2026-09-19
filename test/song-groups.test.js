/**
 * songGroups.js 守护测试 — 跨平台同名分组纯逻辑
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function fresh() {
  return import(`../src/renderer/js/songGroups.js?ck=${Math.random()}`);
}

test('normKey：大小写/标点/空白归一，括号附注剥离后合并', async () => {
  const { normKey } = await fresh();
  assert.equal(normKey('Hello World', 'A-B'), normKey('helloworld!', 'ab'));
  assert.equal(normKey('平凡之路 (Live)', '朴树'), normKey('平凡之路', '朴树'));
  assert.notEqual(normKey('普通', '歌手A'), normKey('普通', '歌手B'));
  assert.equal(normKey(null, undefined), '|');
});

test('groupSameSongs：≥2 平台成组，同平台重复只留首条', async () => {
  const { groupSameSongs } = await fresh();
  const songs = [
    { id: 1, source: 'qq', title: '晴天', artist: '周杰伦', duration: 269000 },
    { id: 2, source: 'netease', title: '晴天', artist: '周杰伦', duration: 270000 },
    { id: 3, source: 'qq', title: '晴天', artist: '周杰伦', duration: 268000 }, // 同平台重复
    { id: 4, source: 'kugou', title: '夜曲', artist: '周杰伦', duration: 227000 },
  ];
  const groups = groupSameSongs(songs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, '晴天');
  assert.equal(groups[0].sources.size, 2);
  assert.deepEqual(groups[0].items.map(i => i.idx), [0, 1]); // 原始索引，非重复行
});

test('groupSameSongs：平台数降序，再按首次出现；无跨平台返回空', async () => {
  const { groupSameSongs } = await fresh();
  const songs = [
    { id: 'a', source: 'qq', title: '两源歌', artist: 'X' },
    { id: 'b', source: 'netease', title: '两源歌', artist: 'X' },
    { id: 'c', source: 'qq', title: '三源歌', artist: 'Y' },
    { id: 'd', source: 'kugou', title: '三源歌', artist: 'Y' },
    { id: 'e', source: 'bilibili', title: '三源歌', artist: 'Y' },
    { id: 'f', source: 'qq', title: '孤源歌', artist: 'Z' },
  ];
  const groups = groupSameSongs(songs);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].title, '三源歌');
  assert.equal(groups[1].title, '两源歌');
  assert.equal(groupSameSongs([]).length, 0);
  assert.equal(groupSameSongs(null).length, 0);
  // id 缺失/空标题不参与分组
  assert.equal(groupSameSongs([
    { source: 'qq', title: '', artist: '' },
    { id: 9, source: 'qq', title: '', artist: '' },
  ]).length, 0);
});
