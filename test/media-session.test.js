'use strict';

/**
 * mediaSession.js 纯映射函数单测
 *
 * 模块 import 了 logger.js（顶层引用 window），node 下先补最小 window 桩再动态导入。
 * initMediaSession 依赖 navigator.mediaSession，属运行时胶水，不在此覆盖。
 */

const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || { location: { hostname: 'localhost', protocol: 'file:' } };

async function fresh() {
  return import('../src/renderer/js/player/mediaSession.js?tc=' + Math.random());
}

test('buildMediaMetadata：字符串 artist/album 直映射，title 兜底「未知歌曲」', async () => {
  const m = await fresh();
  const meta = m.buildMediaMetadata({ title: '夜曲', artist: '周杰伦', album: '十一月的萧邦' });
  assert.strictEqual(meta.title, '夜曲');
  assert.strictEqual(meta.artist, '周杰伦');
  assert.strictEqual(meta.album, '十一月的萧邦');
  assert.strictEqual(m.buildMediaMetadata({}).title, '未知歌曲');
  assert.strictEqual(m.buildMediaMetadata({}).artist, '未知歌手');
  assert.strictEqual(m.buildMediaMetadata(null), null);
});

test('buildMediaMetadata：artist 数组形态拼「、」，对象形态取 name', async () => {
  const m = await fresh();
  const a = m.buildMediaMetadata({ title: 't', artist: [{ name: 'A' }, { name: 'B' }] });
  assert.strictEqual(a.artist, 'A、B');
  const b = m.buildMediaMetadata({ title: 't', artist: { name: 'C' } });
  assert.strictEqual(b.artist, 'C');
});

test('buildMediaMetadata：仅 http(s)/data 封面进 artwork，其余省略', async () => {
  const m = await fresh();
  assert.ok(m.buildMediaMetadata({ title: 't', cover: 'https://x/c.jpg?size=300' }).artwork[0].src.startsWith('https://'));
  assert.ok(m.buildMediaMetadata({ title: 't', cover: 'data:image/png;base64,xx' }).artwork);
  assert.strictEqual(m.buildMediaMetadata({ title: 't', cover: '' }).artwork, undefined);
  assert.strictEqual(m.buildMediaMetadata({ title: 't', cover: 'javascript:alert(1)' }).artwork, undefined);
  assert.strictEqual(m.buildMediaMetadata({ title: 't', cover: 123 }).artwork, undefined);
});

test('buildMediaMetadata：超长字段钳 200 字', async () => {
  const m = await fresh();
  const meta = m.buildMediaMetadata({ title: 'x'.repeat(500), artist: 'y'.repeat(500) });
  assert.strictEqual(meta.title.length, 200);
  assert.strictEqual(meta.artist.length, 200);
});

test('buildPositionState：正常值透传；未知时长 → Infinity；负 currentTime → 0', async () => {
  const m = await fresh();
  assert.deepStrictEqual(
    m.buildPositionState({ duration: 240, currentTime: 30, playbackRate: 1.5 }),
    { duration: 240, playbackRate: 1.5, position: 30 });
  assert.strictEqual(m.buildPositionState({ duration: NaN, currentTime: 5, playbackRate: 0 }).duration, Infinity);
  assert.strictEqual(m.buildPositionState({ duration: NaN, currentTime: 5, playbackRate: 0 }).playbackRate, 1);
  assert.strictEqual(m.buildPositionState({ duration: 100, currentTime: -3 }).position, 0);
  assert.strictEqual(m.buildPositionState(null), null);
});
