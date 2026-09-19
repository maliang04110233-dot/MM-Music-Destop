import { test } from 'node:test';
import assert from 'node:assert/strict';

const src = `../src/renderer/js/songShare.js?ck=${Math.random()}`;
const { songPageUrl, songShareText, copyText } = await import(src);

test('songPageUrl：五平台各自构造正确链接', () => {
  assert.equal(songPageUrl({ source: 'netease', id: 2652820720 }), 'https://music.163.com/song?id=2652820720');
  assert.equal(songPageUrl({ source: 'qq', id: '004Z8Ihr0JIu5s' }), 'https://y.qq.com/n/ryqq/songDetail/004Z8Ihr0JIu5s');
  assert.equal(songPageUrl({ source: 'kugou', id: 'abc123' }), 'https://www.kugou.com/mixsong/abc123.html');
  assert.equal(songPageUrl({ source: 'kuwo', id: '5355752' }), 'https://www.kuwo.cn/play_detail/5355752');
  assert.equal(songPageUrl({ source: 'bilibili', id: 'BV1xx411c7mD' }), 'https://www.bilibili.com/video/BV1xx411c7mD');
});

test('songPageUrl：未知平台/缺 id/脏输入返回 null，不造假链接', () => {
  assert.equal(songPageUrl({ source: 'tidal', id: '1' }), null);
  assert.equal(songPageUrl({ source: 'netease', id: '' }), null);
  assert.equal(songPageUrl({ source: 'netease', id: null }), null);
  assert.equal(songPageUrl({ id: '1' }), null);
  assert.equal(songPageUrl(null), null);
});

test('songShareText：标题 - 歌手 + 换行链接；无歌手/无平台只有文本', () => {
  assert.equal(
    songShareText({ title: '晴天', artist: '周杰伦', source: 'netease', id: 186016 }),
    '晴天 - 周杰伦\nhttps://music.163.com/song?id=186016',
  );
  assert.equal(songShareText({ title: 'Solo', source: 'tidal', id: '9' }), 'Solo');
  assert.equal(songShareText({ title: ' 空格 ', artist: '  ' }), '空格');
});

test('songShareText：无标题即空串（不给空文案造假）', () => {
  assert.equal(songShareText({ artist: 'A', source: 'netease', id: 1 }), '');
  assert.equal(songShareText(null), '');
});

test('copyText：空文本直接 false；无 navigator/document 环境不炸', async () => {
  assert.equal(await copyText(''), false);
  assert.equal(await copyText(null), false);
});
