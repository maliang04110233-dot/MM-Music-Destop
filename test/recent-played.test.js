/**
 * addToRecentlyPlayed 字段保留守卫（审计批② M10）
 *
 * 最近播放条目此前只保留 title/artist/source/cover/duration ——
 * id/album/filePath 被剥掉。后果：home/search 页点击最近播放条目时
 * getDownloadUrlSmart 缺 id 无法取流、本地歌曲缺 filePath 走不了本地
 * 分支，「最近播放」整块永远点不动。
 *
 * stats.js 无顶层 DOM 依赖（Node 24 语法探测可加载渲染层 ESM），
 * 这里做真行为测试而非静态断言。api 全局需打桩（persistRecentlyPlayed）。
 */

const test = require('node:test');
const assert = require('node:assert');

test('addToRecentlyPlayed: 保留 id/album/filePath，重放与本地播放才有据可依', async () => {
  globalThis.api = { setPref: async () => {}, getPref: async () => null };
  const { addToRecentlyPlayed, getRecentlyPlayed } =
    await import('../src/renderer/js/player/stats.js');

  addToRecentlyPlayed({
    id: '186016', source: 'netease', title: '测试歌', artist: '某人',
    album: '测试专辑', filePath: 'C:\\music\\测试歌.mp3',
    cover: 'data:image/png;base64,x', duration: 180,
  });
  const r = getRecentlyPlayed()[0];
  assert.strictEqual(r.id, '186016', '缺 id → getDownloadUrlSmart 取不了流');
  assert.strictEqual(r.album, '测试专辑');
  assert.strictEqual(r.filePath, 'C:\\music\\测试歌.mp3', '缺 filePath → 本地歌曲点不动');
  assert.strictEqual(r.source, 'netease');
  assert.strictEqual(r.title, '测试歌');
});

test('addToRecentlyPlayed: 去重仍按 title+artist+source，不因字段扩展而重复堆积', async () => {
  globalThis.api = { setPref: async () => {}, getPref: async () => null };
  const { addToRecentlyPlayed, getRecentlyPlayed } =
    await import('../src/renderer/js/player/stats.js');

  addToRecentlyPlayed({ id: '1', source: 'qq', title: 'T', artist: 'A' });
  addToRecentlyPlayed({ id: '2', source: 'qq', title: 'T', artist: 'A' });
  const hits = getRecentlyPlayed().filter(s => s.title === 'T' && s.artist === 'A');
  assert.strictEqual(hits.length, 1, '同一首只保留最新一条');
  assert.strictEqual(hits[0].id, '2', '保留的是最新一次播放');
});
