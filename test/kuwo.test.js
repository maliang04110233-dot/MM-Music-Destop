/**
 * 单元测试：酷我平台（纯函数 + 适配器接线）
 *
 * 网络链路（搜索 / 取流 / 歌词接口）由 .preview/verify-kuwo.js 实测覆盖，
 * 这里只测无需网络、但回归代价高的部分：
 *   - id 规范化与封面 URL 拼装
 *   - lrclist → 标准 LRC（曾因缺方括号导致整段歌词被渲染层静默丢弃）
 *   - 适配器是否真的注册进了插件中心（曾出现"实现写了但从未 require"）
 */

const test = require('node:test');
const assert = require('node:assert');
const kuwo = require('../src/api/platforms/kuwo');
const api = require('../src/api/index.js');

const { normalizeId, coverUrl, lrcFromLines } = kuwo._internal;

// ── normalizeId ────────────────────────────────────────

test('normalizeId: 去掉 MUSIC_ 前缀，大小写无关', () => {
  assert.strictEqual(normalizeId('MUSIC_228908'), '228908');
  assert.strictEqual(normalizeId('music_123'), '123');
  assert.strictEqual(normalizeId('228908'), '228908');
});

test('normalizeId: 空值安全', () => {
  assert.strictEqual(normalizeId(null), '');
  assert.strictEqual(normalizeId(undefined), '');
  assert.strictEqual(normalizeId(''), '');
});

// ── coverUrl ───────────────────────────────────────────

test('coverUrl: 绝对 URL 直通', () => {
  assert.strictEqual(coverUrl({ hts_MVPIC: 'https://img4.kuwo.cn/a.jpg' }), 'https://img4.kuwo.cn/a.jpg');
});

test('coverUrl: 相对路径补全 host', () => {
  assert.strictEqual(
    coverUrl({ web_albumpic_short: 'albumcover/x/y/z.jpg' }),
    'https://img4.kuwo.cn/star/albumcover/x/y/z.jpg',
  );
});

test('coverUrl: 无图返回空串', () => {
  assert.strictEqual(coverUrl({}), '');
  assert.strictEqual(coverUrl({ hts_MVPIC: '' }), '');
});

// ── lrcFromLines（关键回归点）───────────────────────────

test('lrcFromLines: 输出标准 LRC，时间轴带方括号', () => {
  const out = lrcFromLines([
    { lineTimeStr: '00:28.95', lineLyric: '故事的小黄花' },
    { lineTimeStr: '00:32.10', lineLyric: '从出生那年就飘着' },
  ]);
  assert.strictEqual(out, '[00:28.95]故事的小黄花\n[00:32.10]从出生那年就飘着');
});

test('lrcFromLines: 每行都能被渲染层 parseLrc 的正则命中', () => {
  const out = lrcFromLines([
    { lineTimeStr: '00:28.95', lineLyric: '故事的小黄花' },
    { lineTimeStr: '01:02.00', lineLyric: 'second' },
  ]);
  const lines = out.split('\n');
  assert.strictEqual(lines.length, 2);
  for (const line of lines) {
    // 与 src/renderer/js/player.js parseLrc 的时间轴正则保持一致
    assert.match(line, /^\[(\d+):(\d+\.?\d*)\](.+)/);
  }
});

test('lrcFromLines: 剔除空时间/空文本行', () => {
  assert.strictEqual(
    lrcFromLines([
      { lineTimeStr: '', lineLyric: '无时间的行' },
      { lineTimeStr: '00:01.00', lineLyric: '   ' },
    ]),
    '',
  );
});

test('lrcFromLines: 非数组输入容错', () => {
  assert.strictEqual(lrcFromLines(null), '');
  assert.strictEqual(lrcFromLines(undefined), '');
  assert.strictEqual(lrcFromLines('not-an-array'), '');
});

test('lrcFromLines: 字段缺失不抛异常', () => {
  assert.strictEqual(lrcFromLines([{}, { lineTimeStr: '00:01.00' }]), '');
});

// ── 适配器接线 ─────────────────────────────────────────

test('插件中心已注册 kuwo，且三项能力齐备', () => {
  const p = api.registry.get('kuwo');
  assert.ok(p, 'kuwo 未注册到插件中心');
  assert.strictEqual(typeof p.search, 'function');
  assert.strictEqual(typeof p.getUrl, 'function');
  assert.strictEqual(typeof p.getLyrics, 'function');
});

test('酷我未声明不具备的专辑/歌手能力', () => {
  const p = api.registry.get('kuwo');
  // 酷我没有专辑/歌手接口：不应凭空声明，否则 UI 切到专辑页只会拿到静默空列表
  assert.strictEqual(p.searchAlbum, undefined);
  assert.strictEqual(p.searchSinger, undefined);
});

test('kuwo 已进入换源候选源列表', () => {
  const { CANDIDATE_SOURCES } = require('../src/utils/matchMusic');
  assert.ok(CANDIDATE_SOURCES.includes('kuwo'), 'kuwo 未加入 CANDIDATE_SOURCES');
});
