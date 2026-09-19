/**
 * queuePlaylist 单元测试：队列转歌曲（保序/滤空/盖 addedAt/不改原对象）+ 默认名格式
 */
const test = require('node:test');
const assert = require('node:assert');

async function fresh() {
  return import(`../src/renderer/js/queuePlaylist.js?ck=${Math.random()}`);
}

test('queueToSongs：保序、滤掉空项、逐首盖 addedAt', async () => {
  const { queueToSongs } = await fresh();
  const q = [{ title: 'A', source: 'net' }, null, { title: 'B', source: 'kg' }, undefined];
  const got = queueToSongs(q, 12345);
  assert.deepEqual(got.map((s) => s.title), ['A', 'B']);
  assert.ok(got.every((s) => s.addedAt === 12345));
  assert.equal(got[0].source, 'net');
});

test('queueToSongs：浅拷贝不污染队列原对象；非数组入参返回空表', async () => {
  const { queueToSongs } = await fresh();
  const s = { title: 'A' };
  queueToSongs([s], 999);
  assert.equal(s.addedAt, undefined);
  assert.deepEqual(queueToSongs(null), []);
  assert.deepEqual(queueToSongs('x'), []);
});

test('defaultQueuePlaylistName：月/日/时/分补零，可注入 Date', async () => {
  const { defaultQueuePlaylistName } = await fresh();
  assert.equal(defaultQueuePlaylistName(new Date(2026, 8, 19, 9, 5)), '播放队列 · 09-19 09:05');
  assert.equal(defaultQueuePlaylistName(new Date(2026, 11, 1, 23, 59)), '播放队列 · 12-01 23:59');
});
