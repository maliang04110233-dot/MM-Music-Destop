/**
 * playlistExport 单元测试：路径索引构建 + 导出视图回填（本地>页链接>空）
 */
const test = require('node:test');
const assert = require('node:assert');

async function fresh() {
  const ck = Math.random();
  return {
    mod: await import(`../src/renderer/js/playlistExport.js?ck=${ck}`),
    share: await import(`../src/renderer/js/songShare.js?ck=${ck}`),
  };
}

test('buildPathMap：滤掉无键/无路径项，同键首条胜出', async () => {
  const { mod } = await fresh();
  const items = [
    { source: 'netease', id: '1', filePath: 'D:/a.mp3' },
    { source: 'netease', id: '1', filePath: 'D:/old.mp3' },
    { source: 'netease', id: '2' },
    { source: null, id: '3', filePath: 'x' },
    null,
  ];
  assert.deepEqual(mod.buildPathMap(items), { 'netease:1': 'D:/a.mp3' });
  assert.deepEqual(mod.buildPathMap(undefined), {});
});

test('enrichExportSongs：下载歌给 filePath，在线歌给平台页链接，未知平台留裸对象', async () => {
  const { mod, share } = await fresh();
  const map = { 'qq:9': 'C:/music/ song.mp3' };
  const songs = [
    { title: 'A', source: 'qq', id: '9' },
    { title: 'B', source: 'netease', id: '77' },
    { title: 'C', source: 'migu', id: '5' },
    null,
  ];
  const got = mod.enrichExportSongs(songs, map);
  assert.equal(got.length, 3);
  assert.equal(got[0].filePath, 'C:/music/ song.mp3');
  assert.equal(got[0].url, undefined);
  assert.equal(got[1].url, share.songPageUrl({ source: 'netease', id: '77' }));
  assert.equal(got[1].filePath, undefined);
  assert.equal(got[2].url, undefined);
  assert.equal(got[2].filePath, undefined);
});

test('enrichExportSongs：不改原对象；非数组/空 pathMap 均安全', async () => {
  const { mod } = await fresh();
  const s = { title: 'A', source: 'qq', id: '9' };
  const got = mod.enrichExportSongs([s], null);
  assert.equal(s.filePath, undefined);
  assert.equal(s.url, undefined);
  assert.equal(got[0].title, 'A');
  assert.deepEqual(mod.enrichExportSongs('x', {}), []);
});
