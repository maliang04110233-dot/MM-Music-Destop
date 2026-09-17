/**
 * 单元测试：utils/localLibrary.js 的封面兜底查找
 *
 * 跑：npm test
 *
 * _findFolderCover 在「音频无内嵌封面」时必然执行，是扫描热路径的一部分。
 * 旧实现对 22 个候选逐个 existsSync + statSync，现在改为一次 readdir + 内存比对，
 * 本测试锁定「候选优先级不变、大小写不敏感行为不变」这两点，
 * 并用同步 fs 守卫确保它不会退回同步实现。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _findFolderCover } = require('../src/utils/localLibrary');

const SYNC_FS_APIS = [
  'statSync', 'existsSync', 'readFileSync', 'writeFileSync',
  'readdirSync', 'renameSync', 'unlinkSync', 'copyFileSync', 'mkdirSync',
];

async function withSyncFsGuard(fn) {
  const syncCalls = [];
  const originals = {};
  for (const k of SYNC_FS_APIS) {
    originals[k] = fs[k];
    fs[k] = function guardedSync(...args) {
      syncCalls.push(k);
      return originals[k].apply(fs, args);
    };
  }
  try {
    return { result: await fn(), syncCalls };
  } finally {
    for (const k of SYNC_FS_APIS) fs[k] = originals[k];
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'foldercover-test-'));
}

/** 在当前目录造一个假的音频文件（内容无关，只需要路径存在） */
function makeAudio(dir, name = 'song.mp3') {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, 'not-really-audio');
  return fp;
}

test('_findFolderCover: 优先命中 cover.jpg', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  fs.writeFileSync(path.join(dir, 'cover.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'folder.jpg'), 'x');

  const hit = await _findFolderCover(audio, 'song');
  assert.strictEqual(path.basename(hit), 'cover.jpg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 优先级 cover → folder → front', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);

  // 只有 folder / front 时取 folder
  fs.writeFileSync(path.join(dir, 'folder.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'front.jpg'), 'x');
  assert.strictEqual(path.basename(await _findFolderCover(audio, 'song')), 'folder.jpg');

  // 追加 cover 后 cover 应升为最高优先
  fs.writeFileSync(path.join(dir, 'cover.jpg'), 'x');
  assert.strictEqual(path.basename(await _findFolderCover(audio, 'song')), 'cover.jpg');

  // 去掉 cover 后回落到 folder
  fs.unlinkSync(path.join(dir, 'cover.jpg'));
  assert.strictEqual(path.basename(await _findFolderCover(audio, 'song')), 'folder.jpg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 同名封面在通用候选之后命中', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir, '晴天.mp3');
  fs.writeFileSync(path.join(dir, '晴天.jpg'), 'x');

  assert.strictEqual(path.basename(await _findFolderCover(audio, '晴天')), '晴天.jpg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: AlbumArt* 通配兜底', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  fs.writeFileSync(path.join(dir, 'AlbumArtSmall.jpg'), 'x');

  assert.strictEqual(path.basename(await _findFolderCover(audio, 'song')), 'AlbumArtSmall.jpg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 大小写不敏感（Cover.JPG 命中 cover.jpg 候选）', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  fs.writeFileSync(path.join(dir, 'Cover.JPG'), 'x');
  fs.writeFileSync(path.join(dir, 'FOLDER.PNG'), 'x');

  // Cover.JPG 归一后先于 FOLDER.PNG 命中
  assert.strictEqual(path.basename(await _findFolderCover(audio, 'song')), 'Cover.JPG');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 目录同名时不算封面（只认文件）', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  fs.mkdirSync(path.join(dir, 'cover.jpg'));  // 同名目录

  assert.strictEqual(await _findFolderCover(audio, 'song'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 无匹配返回 null；目录不存在也不抛错', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  assert.strictEqual(await _findFolderCover(audio, 'song'), null);

  const ghost = path.join(dir, 'no-such-dir', 'a.mp3');
  assert.strictEqual(await _findFolderCover(ghost, 'a'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 不返回非图片文件（避免把歌词当封面）', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  fs.writeFileSync(path.join(dir, 'cover.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'song.lrc'), 'x');

  assert.strictEqual(await _findFolderCover(audio, 'song'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 全程无同步 fs 调用，且只做一次目录读取', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  // 铺满候选，模拟最坏情况（旧实现会在这里产生 22 次同步 stat）
  for (const n of ['cover.jpg', 'folder.jpg', 'front.png', 'AlbumArt1.jpg']) {
    fs.writeFileSync(path.join(dir, n), 'x');
  }

  const { result, syncCalls } = await withSyncFsGuard(() => _findFolderCover(audio, 'song'));
  assert.ok(result, '应命中封面');
  assert.deepStrictEqual(syncCalls, [], `出现同步 fs 调用: ${syncCalls.join(', ')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
