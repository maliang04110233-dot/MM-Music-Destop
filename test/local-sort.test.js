/**
 * localSort 单元测试：五档循环 + 各模式排序行为（缺字段垫底、中文 locale 序、稳定）
 */
const test = require('node:test');
const assert = require('node:assert');

async function fresh() {
  return import(`../src/renderer/js/localSort.js?ck=${Math.random()}`);
}

test('nextLocalSortMode：五档循环，未知模式回默认', async () => {
  const { nextLocalSortMode, localSortLabel, LOCAL_SORT_MODES } = await fresh();
  let m = 'default';
  const seq = [];
  for (let i = 0; i < 6; i++) { m = nextLocalSortMode(m); seq.push(m); }
  assert.deepStrictEqual(seq, ['title', 'artist', 'duration-desc', 'size-desc', 'default', 'title']);
  assert.strictEqual(nextLocalSortMode('nope'), 'default');
  for (const mode of LOCAL_SORT_MODES) assert.ok(localSortLabel(mode).includes('↕'), mode);
});

test('sortLocalSongs：标题/歌手按中文 locale 升序，缺字段垫底且保序', async () => {
  const { sortLocalSongs } = await fresh();
  const songs = [
    { filePath: 'a', title: '白鸽', artist: '张三' },
    { filePath: 'b', title: '安河桥' },
    { filePath: 'c', artist: '李四' },
    { filePath: 'd', title: '安和桥', artist: '张三' },
    { filePath: 'e', title: '安河桥', artist: '王五' },
  ];
  const byTitle = sortLocalSongs(songs, 'title').map(s => s.filePath);
  // ICU zh 拼音序：同音"安和桥/安河桥"按字形排（d<b=e），"安"系 < "白"，无标题 c 垫底；同键稳定 b 先于 e
  assert.deepStrictEqual(byTitle, ['d', 'b', 'e', 'a', 'c']);
  const byArtist = sortLocalSongs(songs, 'artist').map(s => s.filePath);
  // 拼音升序：李四(c) < 王五(e) < 张三(a,d 同键稳定) < 无歌手 b 垫底
  assert.deepStrictEqual(byArtist, ['c', 'e', 'a', 'd', 'b']);
  assert.strictEqual(sortLocalSongs(songs, 'default').length, 5);
});

test('sortLocalSongs：时长/大小降序，0/缺字段/非数字一律垫底', async () => {
  const { sortLocalSongs } = await fresh();
  const songs = [
    { filePath: 'a', duration: 200, fileSize: 10 },
    { filePath: 'b', duration: null, fileSize: 0 },
    { filePath: 'c', duration: 60, fileSize: 999 },
    { filePath: 'd', fileSize: 'not-a-number' },
    { filePath: 'e', duration: 120 },
  ];
  assert.deepStrictEqual(sortLocalSongs(songs, 'duration-desc').map(s => s.filePath), ['a', 'e', 'c', 'b', 'd']);
  assert.deepStrictEqual(sortLocalSongs(songs, 'size-desc').map(s => s.filePath), ['c', 'a', 'b', 'd', 'e']);
});

test('sortLocalSongs：畸形输入静默安全，不改原数组', async () => {
  const { sortLocalSongs } = await fresh();
  assert.deepStrictEqual(sortLocalSongs(undefined, 'title'), []);
  assert.deepStrictEqual(sortLocalSongs('nope', 'size-desc'), []);
  const songs = [{ filePath: 'x', title: '乙' }, { filePath: 'y', title: '甲' }, null];
  const copy = songs.slice();
  const out = sortLocalSongs(songs, 'title');
  assert.deepStrictEqual(songs.map(s => s && s.filePath), copy.map(s => s && s.filePath)); // 原数组不动
  assert.deepStrictEqual(out.map(s => s && s.filePath), ['y', 'x', null]); // null 无 title 垫底
});
