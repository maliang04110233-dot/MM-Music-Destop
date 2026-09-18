/**
 * clipboardWatch 单测 —— 纯本地检测逻辑（不依赖 Electron 运行时）
 *
 * 覆盖「复制即识别」的三条核心契约：
 *  1. 命中链接给出完整载荷（platform/type/id/raw），供识别条与 handleLinkInput 用；
 *  2. 同一段文本只提示一次（去重），不打扰；
 *  3. 短链与不可识别文本各有明确出口（不静默、不误报）。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { start, stop, _internal } = require('../src/main/clipboardWatch');
const { inspect, reset } = _internal;

test('clipboardWatch：模块可脱离 Electron 加载（start/stop 为函数）', () => {
  assert.equal(typeof start, 'function');
  assert.equal(typeof stop, 'function');
});

test('网易云单曲链接 → song 载荷', () => {
  reset();
  const r = inspect('https://music.163.com/song?id=2652820720&userid=1 分享的单曲');
  assert.ok(r, '应命中');
  assert.equal(r.kind, 'link');
  assert.equal(r.platform, 'netease');
  assert.equal(r.type, 'song');
  assert.equal(r.id, '2652820720');
  assert.ok(r.raw.includes('music.163.com'));
});

test('QQ音乐 songDetail 链接 → qq/song', () => {
  reset();
  const r = inspect('https://y.qq.com/n/ryqq/songDetail/004Z8Ihr0JIu5s');
  assert.ok(r);
  assert.equal(r.platform, 'qq');
  assert.equal(r.type, 'song');
  assert.equal(r.id, '004Z8Ihr0JIu5s');
});

test('网易云歌单链接 → playlist', () => {
  reset();
  const r = inspect('https://music.163.com/playlist?id=12345678');
  assert.ok(r);
  assert.equal(r.type, 'playlist');
  assert.equal(r.id, '12345678');
});

test('同一段文本只提示一次（去重），换文本后重新判定', () => {
  reset();
  const link = 'https://music.163.com/song?id=9999';
  assert.ok(inspect(link), '首次应命中');
  assert.strictEqual(inspect(link), null, '重复文本必须静默');
  assert.strictEqual(inspect('随便一段普通文本'), null, '普通文本返回 null 属正常路径');
  // 普通文本也被记为 lastText：再回到原链接不重复弹
  assert.strictEqual(inspect(link), null, 'lastText 已前进，旧链接不再打扰');
  assert.ok(inspect('https://music.163.com/song?id=1000'), '新链接正常命中');
});

test('空串 / 非字符串输入静默', () => {
  reset();
  assert.strictEqual(inspect(''), null);
  assert.strictEqual(inspect(null), null);
  assert.strictEqual(inspect(42), null);
});

test('超长文本（>500）按普通文本忽略，防误粘整篇文章刷屏', () => {
  reset();
  const long = 'https://music.163.com/song?id=1 ' + 'x'.repeat(600);
  assert.strictEqual(inspect(long), null);
});

test('163cn.tv 短链 → kind=short（提示需浏览器打开后复制完整链接）', () => {
  reset();
  const r = inspect('https://163cn.tv/abc123');
  assert.ok(r);
  assert.equal(r.kind, 'short');
  assert.equal(r.host, '163cn.tv');
});

test('普通关键词搜索文本不误报', () => {
  reset();
  assert.strictEqual(inspect('周杰伦 晴天'), null);
  assert.strictEqual(inspect('http://example.com/song?id=1'), null);
});

test('raw 始终不超过 500 字符', () => {
  reset();
  const link = 'https://music.163.com/song?id=2652820720 ' + 'y'.repeat(440);
  assert.ok(link.length > 480 && link.length <= 500);
  const r = inspect(link);
  assert.ok(r);
  assert.ok(r.raw.length <= 500, `raw 长度 ${r.raw.length} 应 ≤500`);
});

test('同一首歌换不同分享文案，也只提示一次（按链接内容去重）', () => {
  reset();
  assert.ok(inspect('https://music.163.com/song?id=8888'));
  assert.strictEqual(inspect('我在听这首歌 https://music.163.com/song?id=8888 太棒了'), null);
  assert.strictEqual(inspect('https://music.163.com/song?id=8888&x=1'), null);
});

test('start/stop 幂等，重复调用不炸', () => {
  stop();
  start();
  start();
  stop();
  stop();
});
