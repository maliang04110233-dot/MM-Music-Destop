/**
 * 单元测试：utils/linkParser.js
 *
 * 跑：npm test
 *
 * 覆盖：各平台 URL 形式 / 分享文案中嵌 URL / 短链检测 / 垃圾输入
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseMusicLink, detectShortLink } = require('../src/utils/linkParser');

// ── 网易云 ──
test('linkParser: 网易云标准歌曲链接 ?id=', () => {
  const r = parseMusicLink('https://music.163.com/song?id=2652820720&userid=1');
  assert.deepStrictEqual(r, { platform: 'netease', type: 'song', id: '2652820720' });
});

test('linkParser: 网易云旧版 hash 路由 /song/#/123', () => {
  const r = parseMusicLink('https://music.163.com/song/#/1474492340');
  assert.deepStrictEqual(r, { platform: 'netease', type: 'song', id: '1474492340' });
});

test('linkParser: 网易云专辑链接', () => {
  const r = parseMusicLink('https://music.163.com/album?id=34720827');
  assert.deepStrictEqual(r, { platform: 'netease', type: 'album', id: '34720827' });
});

test('linkParser: 网易云歌单链接', () => {
  const r = parseMusicLink('https://music.163.com/playlist?id=7114948061');
  assert.deepStrictEqual(r, { platform: 'netease', type: 'playlist', id: '7114948061' });
});

test('linkParser: 分享文案中嵌网易云链接', () => {
  const text = '分享周杰伦的单曲《晴天》: https://music.163.com/song?id=186016（来自@网易云音乐）';
  const r = parseMusicLink(text);
  assert.deepStrictEqual(r, { platform: 'netease', type: 'song', id: '186016' });
});

// ── QQ 音乐 ──
test('linkParser: QQ 新版单曲路由 songDetail', () => {
  const r = parseMusicLink('https://y.qq.com/n/ryqq/songDetail/004Z8Ihr0JIu5s');
  assert.deepStrictEqual(r, { platform: 'qq', type: 'song', id: '004Z8Ihr0JIu5s' });
});

test('linkParser: QQ 播放页 playsong.html?songmid=', () => {
  const r = parseMusicLink('https://i.y.qq.com/v8/playsong.html?songmid=004Z8Ihr0JIu5s&ADTAG=cbshare');
  assert.deepStrictEqual(r, { platform: 'qq', type: 'song', id: '004Z8Ihr0JIu5s' });
});

test('linkParser: QQ 专辑路由', () => {
  const r = parseMusicLink('https://y.qq.com/n/ryqq/albumDetail/002Neh8b0FxUIF');
  assert.deepStrictEqual(r, { platform: 'qq', type: 'album', id: '002Neh8b0FxUIF' });
});

// ── B站 ──
test('linkParser: B站视频 BV 号', () => {
  const r = parseMusicLink('https://www.bilibili.com/video/BV1BZbSzZEGT?p=1&share_medium=android');
  assert.deepStrictEqual(r, { platform: 'bilibili', type: 'song', id: 'BV1BZbSzZEGT' });
});

test('linkParser: B站音频 au 号', () => {
  const r = parseMusicLink('https://www.bilibili.com/audio/au9350864');
  assert.deepStrictEqual(r, { platform: 'bilibili', type: 'song', id: 'au9350864' });
});

test('linkParser: B站分享文案', () => {
  const text = '【周杰伦-晴天】 https://www.bilibili.com/video/BV1xx411c7mD 那年夏天...';
  const r = parseMusicLink(text);
  assert.deepStrictEqual(r, { platform: 'bilibili', type: 'song', id: 'BV1xx411c7mD' });
});

// ── 酷狗 ──
test('linkParser: 酷狗 mixsong', () => {
  const r = parseMusicLink('https://www.kugou.com/mixsong/12345678.html');
  assert.deepStrictEqual(r, { platform: 'kugou', type: 'song', id: '12345678' });
});

test('linkParser: 酷狗 song?hash=', () => {
  const r = parseMusicLink('https://www.kugou.com/song/abc.html?hash=6AC9CA9B8D9E0F1A2B3C4D5E6F7081920');
  assert.deepStrictEqual(r, { platform: 'kugou', type: 'song', id: '6AC9CA9B8D9E0F1A2B3C4D5E6F7081920' });
});

test('linkParser: 酷狗专辑', () => {
  const r = parseMusicLink('https://www.kugou.com/album/abc_def_123.html');
  assert.deepStrictEqual(r, { platform: 'kugou', type: 'album', id: 'abc_def_123' });
});

// ── 边界与垃圾输入 ──
test('linkParser: 普通关键词返回 null', () => {
  assert.strictEqual(parseMusicLink('周杰伦 晴天'), null);
  assert.strictEqual(parseMusicLink(''), null);
  assert.strictEqual(parseMusicLink(null), null);
  assert.strictEqual(parseMusicLink(undefined), null);
});

test('linkParser: 非音乐平台 URL 返回 null', () => {
  assert.strictEqual(parseMusicLink('https://www.baidu.com/song?id=123'), null);
  assert.strictEqual(parseMusicLink('https://example.com/video/BV12345678'), null);
});

test('linkParser: 超长文本按普通关键词处理', () => {
  const long = '分享 ' + 'x'.repeat(600) + ' https://music.163.com/song?id=186016';
  assert.strictEqual(parseMusicLink(long), null);
});

test('linkParser: id 位数不足的伪链接不命中', () => {
  // 3 位数字 id 太短，避免把普通文章数字误判成歌曲
  assert.strictEqual(parseMusicLink('https://music.163.com/song?id=123'), null);
});

// ── 短链检测 ──
test('linkParser: detectShortLink 命中平台短链', () => {
  assert.strictEqual(detectShortLink('https://163cn.tv/abc123 分享'), '163cn.tv');
  assert.strictEqual(detectShortLink('https://b23.tv/xyz'), 'b23.tv');
});

test('linkParser: detectShortLink 非短链返回 null', () => {
  assert.strictEqual(detectShortLink('https://music.163.com/song?id=186016'), null);
  assert.strictEqual(detectShortLink('普通文本'), null);
  assert.strictEqual(detectShortLink(''), null);
});
