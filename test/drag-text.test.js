import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../src/renderer/js/dragText.js?tc=' + Math.random());

function dt(types, data = {}) {
  return { types, getData: (t) => data[t] ?? '' };
}

test('pickDroppedText：text/plain 拖拽取回文本', async () => {
  const m = await load();
  const r = m.pickDroppedText(dt(['text/plain'], { 'text/plain': '  https://music.163.com/#/song?id=1  ' }));
  assert.strictEqual(r, 'https://music.163.com/#/song?id=1');
});

test('pickDroppedText：text/plain 缺失时退 text，再退 URL', async () => {
  const m = await load();
  assert.strictEqual(m.pickDroppedText(dt(['text'], { text: 'abc' })), 'abc');
  assert.strictEqual(m.pickDroppedText(dt(['URL'], { URL: 'https://x.com/song' })), 'https://x.com/song');
});

test('pickDroppedText：Files 拖入不接管（即使同时带文本）', async () => {
  const m = await load();
  assert.strictEqual(m.pickDroppedText(dt(['Files', 'text/plain'], { 'text/plain': 'path' })), null);
});

test('pickDroppedText：空载荷/无类型/纯空白返回 null', async () => {
  const m = await load();
  assert.strictEqual(m.pickDroppedText(null), null);
  assert.strictEqual(m.pickDroppedText({}), null);
  assert.strictEqual(m.pickDroppedText(dt(['text/plain'], { 'text/plain': '   ' })), null);
  assert.strictEqual(m.pickDroppedText(dt(['application/x-moz-map'])), null);
});

test('pickDroppedText：超长文本钳到 500 字符', async () => {
  const m = await load();
  const long = 'x'.repeat(900);
  const r = m.pickDroppedText(dt(['text/plain'], { 'text/plain': long }));
  assert.strictEqual(r.length, 500);
});

test('isLrcFilename：.lrc/.txt 认（大小写不限），其余与空值不接管', async () => {
  const m = await load();
  assert.strictEqual(m.isLrcFilename('晴天.lrc'), true);
  assert.strictEqual(m.isLrcFilename('LYRICS.LRC'), true);
  assert.strictEqual(m.isLrcFilename('notes.txt'), true);
  assert.strictEqual(m.isLrcFilename('song.mp3'), false);
  assert.strictEqual(m.isLrcFilename('readme'), false);
  assert.strictEqual(m.isLrcFilename(null), false);
});

test('looksLikeLrc：≥3 行时间戳才算歌词，格式变体都认', async () => {
  const m = await load();
  assert.strictEqual(m.looksLikeLrc(
    '[00:01.00]第一行\n[00:02.30]第二行\n[00:03]第三行\n'
  ), true);
  assert.strictEqual(m.looksLikeLrc('[0:05.5]a\n[0:06.5]b'), false, '只有 2 行不算');
  assert.strictEqual(m.looksLikeLrc('[tag] 普通文本\n[id] 笔记\n[00:01.0] 唯一一行'), false);
  assert.strictEqual(m.looksLikeLrc(''), false);
  assert.strictEqual(m.looksLikeLrc(null), false);
});

test('MAX_LRC_BYTES 是 512KB 量级的合理上限', async () => {
  const m = await load();
  assert.strictEqual(m.MAX_LRC_BYTES, 512 * 1024);
});
