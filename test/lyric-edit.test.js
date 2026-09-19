import { test } from 'node:test';
import assert from 'node:assert/strict';

const src = `../src/renderer/js/lyricEdit.js?ck=${Math.random()}`;
const {
  MAX_LYRIC_CHARS, normalizeLrcText, pickLyricText, overridePatch, parseOverrideMap, lrcToPlain,
} = await import(src);

test('normalizeLrcText：CRLF/CR 归一为 LF，剥 BOM，null 退空串', () => {
  assert.equal(normalizeLrcText('[00:01.00]a\r\n[00:02.00]b\r'), '[00:01.00]a\n[00:02.00]b\n');
  assert.equal(normalizeLrcText('\uFEFF[00:01.00]x'), '[00:01.00]x');
  assert.equal(normalizeLrcText(null), '');
});

test('normalizeLrcText：超长钳到 MAX_LYRIC_CHARS', () => {
  assert.equal(normalizeLrcText('x'.repeat(MAX_LYRIC_CHARS + 100)).length, MAX_LYRIC_CHARS);
});

test('pickLyricText：非空覆写优先，空/纯空白覆写退回网络歌词', () => {
  assert.equal(pickLyricText('[00:01.00]改过的', '[00:01.00]原词'), '[00:01.00]改过的');
  assert.equal(pickLyricText('   ', '[00:01.00]原词'), '[00:01.00]原词');
  assert.equal(pickLyricText(null, undefined), '');
});

test('overridePatch：设置/清除/不可变性/脏输入', () => {
  const base = { '1:netease': 'old' };
  const set = overridePatch(base, '2:qq', ' new ');
  assert.equal(set['2:qq'], ' new ');
  assert.deepEqual(Object.keys(base), ['1:netease'], '入参不被修改');
  const del = overridePatch(base, '1:netease', '   ');
  assert.deepEqual(del, {});
  assert.deepEqual(overridePatch(base, '', 'x'), { '1:netease': 'old' }, '空键不变');
  assert.deepEqual(overridePatch(null, 'k', 'v'), { k: 'v' }, 'null 映射可生长');
});

test('parseOverrideMap：合法 JSON 过滤非字符串/空值，坏数据退空表', () => {
  assert.deepEqual(
    parseOverrideMap(JSON.stringify({ a: 'lrc', b: ' ', c: 42, d: null })),
    { a: 'lrc' },
  );
  assert.deepEqual(parseOverrideMap('{坏JSON'), {});
  assert.deepEqual(parseOverrideMap('[1,2]'), {});
  assert.deepEqual(parseOverrideMap(null), {});
  assert.deepEqual(parseOverrideMap('"str"'), {});
});

test('lrcToPlain：剥行首全部标签（多时间戳/元信息/偏移），留正文丢空行', () => {
  const lrc = [
    '[ar:周杰伦]', '[ti:晴天]', '',
    '[00:12.30][01:12.30]故事的小黄花',
    '[00:16.00] ',
    '[00:20.00]从出生那年就飘着',
    '普通一行没有标签',
  ].join('\n');
  assert.equal(lrcToPlain(lrc), '故事的小黄花\n从出生那年就飘着\n普通一行没有标签');
  assert.equal(lrcToPlain(''), '');
  assert.equal(lrcToPlain(null), '');
});
