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
