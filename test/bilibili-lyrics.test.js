/**
 * B 站字幕转歌词：选轨优先级、字幕 → LRC 时间戳、manifest 能力注册。
 *
 * 为什么单测这两段：WBI 签名本身依赖实时接口（nav 的 wbi_img 每次不同），
 * 但「拿到字幕后怎么变成 LRC」是纯函数，必须锁死 —— 时间戳错一位，
 * 播放器里整首歌词就全对不上。
 */

const test = require('node:test');
const assert = require('node:assert');

const mod = require('../src/api/platforms/bilibili.js');
const { defaultRegistry, loadPlatformPlugins } = require('../src/api/pluginRegistry');

loadPlatformPlugins();
const reg = defaultRegistry;

// ── 字幕 → LRC ────────────────────────────────────────────────

test('bilibili: 字幕转 LRC 时间戳正确（含跨分钟进位）', () => {
  const lrc = mod.bilibiliSubtitleToLrc([
    { from: 0.18, to: 4.06, content: '起风了' },
    { from: 63.4, to: 65.0, content: '第二分钟' },
    { from: 300.009, to: 301, content: '五分钟' },
  ]);
  assert.strictEqual(
    lrc,
    '[00:00.18]起风了\n[01:03.40]第二分钟\n[05:00.01]五分钟',
  );
});

test('bilibili: 字幕内容压缩空白并去首尾空格，空行丢弃', () => {
  const lrc = mod.bilibiliSubtitleToLrc([
    { from: 1.0, to: 2, content: '   歌词   ' },
    { from: 2.0, to: 3, content: '多个   连续   空格' },
    { from: 3.0, to: 4, content: '   ' },
    { from: 4.0, to: 5, content: null },
  ]);
  assert.strictEqual(lrc, '[00:01.00]歌词\n[00:02.00]多个 连续 空格');
});

test('bilibili: 空字幕 / 异常输入一律返回空串', () => {
  assert.strictEqual(mod.bilibiliSubtitleToLrc(null), '');
  assert.strictEqual(mod.bilibiliSubtitleToLrc(undefined), '');
  assert.strictEqual(mod.bilibiliSubtitleToLrc([]), '');
  assert.strictEqual(mod.bilibiliSubtitleToLrc({ body: [] }), '');
  // 缺 from 字段按 0 秒处理，不能崩
  assert.strictEqual(mod.bilibiliSubtitleToLrc([{ content: 'x' }]), '[00:00.00]x');
});

// ── 选轨优先级 ────────────────────────────────────────────────

test('bilibili: 人工中文轨优先于 AI 生成与英文轨', () => {
  const list = [
    { lan: 'en-US', ai_type: 0, subtitle_url: 'en' },
    { lan: 'zh-CN', ai_type: 1, subtitle_url: 'zh-ai' },
    { lan: 'zh-Hans', ai_type: 0, subtitle_url: 'zh-manual' },
  ];
  assert.strictEqual(mod.bilibiliPickSubtitle(list).subtitle_url, 'zh-manual');

  // 没有人工轨时退到任意中文轨（AI 也比英文贴近）
  assert.strictEqual(
    mod.bilibiliPickSubtitle([list[0], list[1]]).subtitle_url, 'zh-ai',
  );
  // 全英文时退回第一条
  assert.strictEqual(
    mod.bilibiliPickSubtitle([{ lan: 'en-US', subtitle_url: 'en' }]).subtitle_url, 'en',
  );
  assert.strictEqual(mod.bilibiliPickSubtitle([]), null);
  assert.strictEqual(mod.bilibiliPickSubtitle(null), null);
});

// ── manifest 注册 ─────────────────────────────────────────────

test('bilibili: manifest 注册 getLyrics，registry 自动推导 lyrics 能力', () => {
  assert.strictEqual(typeof mod.getLyrics, 'function');
  const caps = reg.getCapabilities('bilibili');
  assert.strictEqual(caps.lyrics, true);
});
