/**
 * pathLite 行为测试 —— 与 node:path 交叉验证
 *
 * 背景：渲染层（nodeIntegration:false + contextIsolation）不能 import
 * node:path，批量重命名用 pathLite 的纯 JS 实现。这里拿真 node:path
 * 做对照，保证三个函数在本地库会遇到的路径形态上语义一致。
 */

const test = require('node:test');
const assert = require('node:assert');
const nodePath = require('node:path');
const { extname, dirname, join, basename } = require('../src/renderer/js/pathLite');

// 本地库扫描会遇到的路径形态（Windows 绝对路径为主 + POSIX）
const WIN_PATHS = [
  'C:\\Music\\周杰伦 - 晴天.mp3',
  'C:\\Music\\ FLAC 目录\\01. intro.flac',
  'D:\\a.mp3',            // 盘根文件
  'C:\\Music\\无扩展名',
  'C:\\a.b.c\\song.test.flac',
];
const POSIX_PATHS = [
  '/home/user/music/01 - track.mp3',
  '/a.mp3',
  'relative/dir/x.wav',
];

test('extname 与 node:path 等值（含无扩展名/多点文件名）', () => {
  for (const p of [...WIN_PATHS, ...POSIX_PATHS]) {
    assert.strictEqual(extname(p), nodePath.extname(p), `extname(${p})`);
  }
  assert.strictEqual(extname(''), '');
  assert.strictEqual(extname(null), '');
});

test('dirname 与 node:path 等值（含盘根/POSIX 根）', () => {
  for (const p of [...WIN_PATHS, ...POSIX_PATHS]) {
    assert.strictEqual(dirname(p), nodePath.dirname(p), `dirname(${p})`);
  }
});

test('join(dir, 新文件名)：Windows 路径与 node:path 等值，POSIX 路径保持正斜杠风格', () => {
  for (const p of WIN_PATHS) {
    const d = nodePath.dirname(p);
    assert.strictEqual(join(d, 'new.mp3'), nodePath.join(d, 'new.mp3'), `join(${d})`);
  }
  // node:path 在 Windows 宿主上对 '/' 输入也会输出 '\'（win32 语义），
  // pathLite 的契约是「跟随父目录分隔符风格」，POSIX 形态单独钉死
  assert.strictEqual(join('/home/user/music', 'new.mp3'), '/home/user/music/new.mp3');
  assert.strictEqual(join('/a', 'new.mp3'), '/a/new.mp3');
  assert.strictEqual(join('relative/dir', 'new.mp3'), 'relative/dir/new.mp3');
});

test('join 绝对段语义：新路径自带盘符/根时直接采用', () => {
  assert.strictEqual(join('C:\\Music', 'D:\\x.mp3'), 'D:\\x.mp3');
  assert.strictEqual(join('/music', '/x.mp3'), '/x.mp3');
});

test('basename 与 node:path 等值', () => {
  for (const p of [...WIN_PATHS, ...POSIX_PATHS]) {
    assert.strictEqual(basename(p), nodePath.basename(p), `basename(${p})`);
  }
});
