// 按歌名批量导入的纯逻辑：行解析 + 候选评分（nameBatch.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function fresh() {
  return import(`../src/renderer/js/views/nameBatch.js?ck=${Math.random()}`);
}

test('parseTrackLine：序号前缀 + 格式后缀 + 歌手-歌名', async () => {
  const { parseTrackLine } = await fresh();
  const r = parseTrackLine('01. 朴树 - 平凡之路.flac');
  assert.equal(r.artist, '朴树');
  assert.equal(r.title, '平凡之路');
});

test('parseTrackLine：多种分隔符与全角破折号', async () => {
  const { parseTrackLine } = await fresh();
  assert.deepEqual(
    ['陈奕迅 - 十年', '陈奕迅 – 十年', '陈奕迅 — 十年', '陈奕迅 － 十年'].map(parseTrackLine),
    [0, 1, 2, 3].map(() => ({ artist: '陈奕迅', title: '十年', raw: '' })).map((x, i) => {
      const src = ['陈奕迅 - 十年', '陈奕迅 – 十年', '陈奕迅 — 十年', '陈奕迅 － 十年'][i];
      return { artist: x.artist, title: x.title, raw: src };
    })
  );
});

test('parseTrackLine：无分隔符整行按歌名', async () => {
  const { parseTrackLine } = await fresh();
  const r = parseTrackLine('  晴天  ');
  assert.equal(r.artist, '');
  assert.equal(r.title, '晴天');
});

test('parseTrackLine：歌名自带连字符时只切第一段为歌手', async () => {
  const { parseTrackLine } = await fresh();
  const r = parseTrackLine('Jack - J - 滚吧');
  assert.equal(r.artist, 'Jack');
  assert.equal(r.title, 'J - 滚吧');
});

test('pickBestMatch：标题+歌手全对得 3 分', async () => {
  const { pickBestMatch } = await fresh();
  const cands = [
    { id: 1, title: '平凡之路 (Live)', artist: '其他人' },
    { id: 2, title: '平凡之路', artist: '朴树' },
  ];
  assert.deepEqual(pickBestMatch(cands, '平凡之路', '朴树'), { idx: 1, score: 3 });
});

test('pickBestMatch：标题对歌手不对得 1 分；无歌手要求时标题对即 3 分', async () => {
  const { pickBestMatch } = await fresh();
  const cands = [{ id: 1, title: '平凡之路', artist: '翻唱者' }];
  assert.deepEqual(pickBestMatch(cands, '平凡之路', '朴树'), { idx: 0, score: 1 });
  assert.deepEqual(pickBestMatch(cands, '平凡之路', ''), { idx: 0, score: 3 });
});

test('pickBestMatch：标题包含关系得 1 分，并列取靠前候选', async () => {
  const { pickBestMatch } = await fresh();
  const cands = [
    { id: 1, title: 'Hello', artist: 'Adele' },
    { id: 2, title: 'Hello Hello', artist: 'B' },
  ];
  assert.deepEqual(pickBestMatch(cands, 'Hello', 'Adele X'), { idx: 0, score: 1 });
});

test('pickBestMatch：空候选/脏候选兜底为 {idx:0, score:0}', async () => {
  const { pickBestMatch } = await fresh();
  assert.deepEqual(pickBestMatch([], '晴天', '周杰伦'), { idx: 0, score: 0 });
  assert.deepEqual(pickBestMatch(null, '晴天', ''), { idx: 0, score: 0 });
  assert.deepEqual(pickBestMatch([{ title: '缺id' }, null], '晴天', ''), { idx: 0, score: 0 });
});

test('normKey 联动：括号附注与标点不参与匹配', async () => {
  const { pickBestMatch } = await fresh();
  const cands = [{ id: 9, title: '《平凡之路》(Live版)', artist: '朴树' }];
  assert.deepEqual(pickBestMatch(cands, '平凡之路', '朴树'), { idx: 0, score: 3 });
});
