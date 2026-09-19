// 搜索关键词高亮纯逻辑（highlight.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function fresh() {
  return import(`../src/renderer/js/highlight.js?ck=${Math.random()}`);
}

test('基础命中：位置切分并包 <mark>', async () => {
  const { markTerm } = await fresh();
  assert.equal(markTerm('平凡之路', '平凡'), '<mark>平凡</mark>之路');
  assert.equal(markTerm('Bohemian Rhapsody', 'bohemian'), '<mark>Bohemian</mark> Rhapsody');
});

test('多词：按空白分词各自命中', async () => {
  const { markTerm } = await fresh();
  assert.equal(
    markTerm('Hello World Hello', 'world hello'),
    '<mark>Hello</mark> <mark>World</mark> <mark>Hello</mark>'
  );
});

test('同词多次出现全部命中', async () => {
  const { markTerm } = await fresh();
  assert.equal(markTerm('aaa', 'a'), '<mark>a</mark><mark>a</mark><mark>a</mark>');
});

test('正则元字符按字面匹配不炸不误伤', async () => {
  const { markTerm } = await fresh();
  assert.equal(markTerm('A+B', '+'), 'A<mark>+</mark>B');
  assert.equal(markTerm('a(b)c', '('), 'a<mark>(</mark>b)c');
  assert.equal(markTerm('abc', '.*'), 'abc'); // .* 是字面两点一星，不匹配 abc
  assert.equal(markTerm('x.y', '.'), 'x<mark>.</mark>y');
});

test('XSS：文本与关键词均被转义，唯一活标签是 mark', async () => {
  const { markTerm } = await fresh();
  assert.equal(
    markTerm('<img src=x onerror=alert(1)>', 'img'),
    '&lt;<mark>img</mark> src=x onerror=alert(1)&gt;'
  );
  assert.equal(markTerm('safe', '<script>'), 'safe'); // 关键词里的标签也是字面量
});

test('空/脏输入兜底为纯转义文本', async () => {
  const { markTerm } = await fresh();
  assert.equal(markTerm('晴天', ''), '晴天');
  assert.equal(markTerm('晴天', '   '), '晴天');
  assert.equal(markTerm(null, '晴天'), '');
  assert.equal(markTerm('a & b', ''), 'a &amp; b');
});

test('escHtml 独立可用且与 esc 语义一致', async () => {
  const { escHtml } = await fresh();
  assert.equal(escHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});
