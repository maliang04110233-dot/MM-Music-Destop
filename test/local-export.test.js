/**
 * 单元测试：src/renderer/js/localExport.js（buildExportSongs 纯函数）
 */

const test = require('node:test');
const assert = require('node:assert');

async function load() {
  return import(`../src/renderer/js/localExport.js?ck=${Math.random()}`);
}

test('buildExportSongs：无勾选集合导出全部视图行', async () => {
  const { buildExportSongs } = await load();
  const songs = [
    { filePath: 'C:\\m\\a.mp3', title: 'A', artist: 'X', durationMs: 240000 },
    { filePath: 'C:\\m\\b.flac', title: 'B', artist: 'Y', durationMs: 180500 },
  ];
  const r = buildExportSongs(songs, null);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0], { title: 'A', artist: 'X', filePath: 'C:\\m\\a.mp3', duration: 240000 });
});

test('buildExportSongs：勾选非空只导出勾选，保持视图顺序', async () => {
  const { buildExportSongs } = await load();
  const songs = [
    { filePath: 'a', title: 'A', artist: '', durationMs: 1000 },
    { filePath: 'b', title: 'B', artist: '', durationMs: 2000 },
    { filePath: 'c', title: 'C', artist: '', durationMs: 3000 },
  ];
  const r = buildExportSongs(songs, new Set(['c', 'a']));
  assert.deepStrictEqual(r.map(x => x.filePath), ['a', 'c'], '按视图顺序而非勾选顺序');
});

test('buildExportSongs：勾选集合为空集退化为全量（不误导出 0 首）', async () => {
  const { buildExportSongs } = await load();
  const songs = [{ filePath: 'a', title: 'A', artist: 'X', durationMs: 0 }];
  assert.strictEqual(buildExportSongs(songs, new Set()).length, 1);
});

test('buildExportSongs：缺 filePath 的行剔除，脏输入不炸', async () => {
  const { buildExportSongs } = await load();
  const songs = [
    { filePath: '', title: 'Ghost', artist: 'X' },
    null,
    { title: 'NoPath' },
    { filePath: 'ok', title: null, artist: undefined },
  ];
  const r = buildExportSongs(songs, null);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0], { title: '', artist: '', filePath: 'ok', duration: 0 });
  assert.deepStrictEqual(buildExportSongs(undefined, null), []);
  assert.deepStrictEqual(buildExportSongs('not-array', null), []);
});

test('buildExportSongs：duration 恒为毫秒语义（durationMs 直传，不再 ÷1000）', async () => {
  const { buildExportSongs } = await load();
  const r = buildExportSongs([{ filePath: 'a', title: 'A', artist: 'X', durationMs: 240123 }], null);
  assert.strictEqual(r[0].duration, 240123);
});
