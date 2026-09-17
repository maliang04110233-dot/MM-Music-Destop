/**
 * 单元测试：utils/libraryIndex.js
 *
 * 跑：npm test
 *
 * 这个模块此前零测试覆盖，而它正是「扫描本地库卡窗口」的根源：
 * 每首歌一次 fs.statSync，5000 首就是 5000 次同步磁盘调用。
 *
 * 因此本测试有两条主线：
 *   1. 行为正确性——增量扫描的增/改/删判定不能出错（错了会导致丢歌或重复）。
 *   2. 非阻塞性——扫描全程不得触碰任何同步 fs API。
 *      用 withSyncFsGuard 把 fs 上的 *Sync 方法换成计数器，跑完断言计数为 0。
 *      这是防止后来者无意中把 statSync 加回来的回归闸门。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const libraryIndex = require('../src/utils/libraryIndex');
const { incrementalScan, loadIndex, saveIndex, init } = libraryIndex;

// ── 测试辅助 ─────────────────────────────────────────────────

const SYNC_FS_APIS = [
  'statSync', 'lstatSync', 'existsSync', 'readFileSync', 'writeFileSync',
  'readdirSync', 'renameSync', 'unlinkSync', 'copyFileSync', 'mkdirSync',
];

/**
 * 在同步 fs API 上装计数器后执行 fn，返回 { result, syncCalls }
 * fs.statSync(...) 是运行时属性查找，因此替换 fs 模块上的属性即可拦截。
 */
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
    const result = await fn();
    return { result, syncCalls };
  } finally {
    for (const k of SYNC_FS_APIS) fs[k] = originals[k];
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'libindex-test-'));
}

/** 造一个受控的 scanDirectory 桩：返回预设文件列表，并把调用次数记在 counters 上 */
function makeScanStub(files, counters) {
  return async () => {
    counters.scan++;
    return files.slice();
  };
}

/** 造 readAudioMetadata 桩：按 filePath 返回元数据，并记录每个文件被解码的次数 */
function makeMetaStub(counters, overrides = {}) {
  return async (filePath) => {
    counters.meta[filePath] = (counters.meta[filePath] || 0) + 1;
    return {
      filePath,
      title: overrides[filePath]?.title || path.basename(filePath, path.extname(filePath)),
      artist: 'some-artist',
      mtime: overrides[filePath]?.mtime,
    };
  };
}

function newCounters() {
  return { scan: 0, meta: {} };
}

/** 建库里真实存在的文件（statOrNull 需要能 stat 到） */
function touchFiles(dir, names) {
  return names.map((n) => {
    const fp = path.join(dir, n);
    fs.writeFileSync(fp, 'fake-audio');
    return fp;
  });
}

// ── 索引读写 ─────────────────────────────────────────────────

test('libraryIndex: 无索引文件时 loadIndex 返回空结构', async () => {
  const userData = makeTempDir();
  init(userData);
  const idx = await loadIndex();
  assert.deepStrictEqual(idx.songs, []);
  assert.strictEqual(idx.dirPath, '');
  assert.strictEqual(idx.lastScan, 0);
  assert.deepStrictEqual(idx.fileMap, {});
  fs.rmSync(userData, { recursive: true, force: true });
});

test('libraryIndex: saveIndex → loadIndex 往返，并重建 fileMap', async () => {
  const userData = makeTempDir();
  init(userData);
  const songs = [
    { filePath: '/m/a.mp3', title: 'A' },
    { filePath: '/m/b.mp3', title: 'B' },
  ];
  await saveIndex({ dirPath: '/m', songs, lastScan: 12345 });

  const idx = await loadIndex();
  assert.strictEqual(idx.dirPath, '/m');
  assert.strictEqual(idx.lastScan, 12345);
  assert.strictEqual(idx.songs.length, 2);
  // fileMap 是运行时重建的，不入盘但读出后必须可用
  assert.strictEqual(idx.fileMap['/m/b.mp3'], 1);

  // 落盘的 JSON 里不应含 fileMap（它随 songs 变化，存了会膨胀）
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'library-index.json'), 'utf8'));
  assert.strictEqual(onDisk.fileMap, undefined);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('libraryIndex: 索引文件损坏时不抛错，退化为空索引', async () => {
  const userData = makeTempDir();
  init(userData);
  fs.writeFileSync(path.join(userData, 'library-index.json'), '{ 这不是 JSON');
  const idx = await loadIndex();
  assert.deepStrictEqual(idx.songs, []);
  fs.rmSync(userData, { recursive: true, force: true });
});

// ── 增量扫描行为 ─────────────────────────────────────────────

test('libraryIndex: 首次扫描全部视为新增', async () => {
  const userData = makeTempDir();
  const libDir = makeTempDir();
  const files = touchFiles(libDir, ['a.mp3', 'b.mp3', 'c.mp3']);
  init(userData);

  const counters = newCounters();
  const r = await incrementalScan(
    libDir, makeScanStub(files, counters), makeMetaStub(counters), null
  );

  assert.strictEqual(r.songs.length, 3);
  assert.strictEqual(r.added, 3);
  assert.strictEqual(r.updated, 0);
  assert.strictEqual(r.removed, 0);
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(libDir, { recursive: true, force: true });
});

test('libraryIndex: 二次扫描无变化时不重新解码元数据（增量命中的核心收益）', async () => {
  const userData = makeTempDir();
  const libDir = makeTempDir();
  const files = touchFiles(libDir, ['a.mp3', 'b.mp3']);
  init(userData);

  const c1 = newCounters();
  await incrementalScan(libDir, makeScanStub(files, c1), makeMetaStub(c1), null);
  const round1Decodes = Object.values(c1.meta).reduce((a, b) => a + b, 0);
  assert.strictEqual(round1Decodes, 2, '首轮每个文件解码一次');

  const c2 = newCounters();
  const r2 = await incrementalScan(libDir, makeScanStub(files, c2), makeMetaStub(c2), null);
  const round2Decodes = Object.values(c2.meta).reduce((a, b) => a + b, 0);

  assert.strictEqual(r2.added, 0);
  assert.strictEqual(r2.updated, 0);
  assert.strictEqual(r2.songs.length, 2);
  assert.strictEqual(round2Decodes, 0, '无变化则一次都不能重新解码');
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(libDir, { recursive: true, force: true });
});

test('libraryIndex: 文件 mtime 变新时判定为已修改并重读', async () => {
  const userData = makeTempDir();
  const libDir = makeTempDir();
  const files = touchFiles(libDir, ['a.mp3', 'b.mp3']);
  init(userData);

  const c1 = newCounters();
  await incrementalScan(libDir, makeScanStub(files, c1), makeMetaStub(c1), null);

  // 把 a.mp3 的 mtime 推到未来，模拟「文件被重新下载/编辑过」
  const future = Date.now() + 60_000;
  fs.utimesSync(files[0], new Date(future), new Date(future));

  const c2 = newCounters();
  const r2 = await incrementalScan(libDir, makeScanStub(files, c2), makeMetaStub(c2), null);

  assert.strictEqual(r2.updated, 1, '只有 mtime 变新的那个文件该被重读');
  assert.strictEqual(r2.added, 0);
  assert.strictEqual(c2.meta[files[0]], 1, '被修改的文件重读一次');
  assert.strictEqual(c2.meta[files[1]], undefined, '未修改的文件不得重读');
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(libDir, { recursive: true, force: true });
});

test('libraryIndex: 文件消失时从索引中移除', async () => {
  const userData = makeTempDir();
  const libDir = makeTempDir();
  const files = touchFiles(libDir, ['a.mp3', 'b.mp3', 'c.mp3']);
  init(userData);

  const c1 = newCounters();
  await incrementalScan(libDir, makeScanStub(files, c1), makeMetaStub(c1), null);

  // b.mp3 被外部删除
  const remaining = [files[0], files[2]];
  fs.unlinkSync(files[1]);

  const c2 = newCounters();
  const r2 = await incrementalScan(libDir, makeScanStub(remaining, c2), makeMetaStub(c2), null);

  assert.strictEqual(r2.removed, 1);
  assert.strictEqual(r2.songs.length, 2);
  assert.ok(!r2.songs.some((s) => s.filePath === files[1]), '已删除的文件不得留在索引里');
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(libDir, { recursive: true, force: true });
});

test('libraryIndex: 切换扫描目录时不复用旧索引（避免跨目录串数据）', async () => {
  const userData = makeTempDir();
  const dirA = makeTempDir();
  const dirB = makeTempDir();
  const filesA = touchFiles(dirA, ['a1.mp3', 'a2.mp3']);
  const filesB = touchFiles(dirB, ['b1.mp3']);
  init(userData);

  const c1 = newCounters();
  await incrementalScan(dirA, makeScanStub(filesA, c1), makeMetaStub(c1), null);

  const c2 = newCounters();
  const r2 = await incrementalScan(dirB, makeScanStub(filesB, c2), makeMetaStub(c2), null);

  assert.strictEqual(r2.songs.length, 1, '换了目录就是全新扫描');
  assert.strictEqual(r2.added, 1);
  assert.ok(!r2.songs.some((s) => s.filePath.startsWith(dirA)), '不得混入旧目录的歌');
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test('libraryIndex: 元数据读取失败的文件被跳过而非中断整轮扫描', async () => {
  const userData = makeTempDir();
  const libDir = makeTempDir();
  const files = touchFiles(libDir, ['ok.mp3', 'bad.mp3']);
  init(userData);

  const counters = newCounters();
  const meta = async (fp) => {
    counters.meta[fp] = (counters.meta[fp] || 0) + 1;
    if (fp.includes('bad')) throw new Error('ID3 损坏');
    return { filePath: fp, title: 'OK' };
  };

  const r = await incrementalScan(libDir, makeScanStub(files, counters), meta, null);
  assert.strictEqual(r.songs.length, 1);
  assert.strictEqual(r.songs[0].filePath, files[0]);
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(libDir, { recursive: true, force: true });
});

// ── 非阻塞性：本轮改动的核心断言 ─────────────────────────────

test('libraryIndex: 扫描全程不调用任何同步 fs API（防 UI 线程冻结）', async () => {
  const userData = makeTempDir();
  const libDir = makeTempDir();
  const names = [];
  for (let i = 0; i < 60; i++) names.push(`t${i}.mp3`);
  const files = touchFiles(libDir, names);
  init(userData);

  const counters = newCounters();
  const { result, syncCalls } = await withSyncFsGuard(() =>
    incrementalScan(libDir, makeScanStub(files, counters), makeMetaStub(counters), null)
  );

  assert.strictEqual(result.songs.length, 60);
  assert.deepStrictEqual(
    syncCalls, [],
    `扫描期间出现同步 fs 调用（会阻塞主进程 UI 线程）: ${syncCalls.join(', ')}`
  );
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(libDir, { recursive: true, force: true });
});

test('libraryIndex: loadIndex/saveIndex 不调用同步 fs API', async () => {
  const userData = makeTempDir();
  init(userData);

  const { syncCalls: loadCalls } = await withSyncFsGuard(() => loadIndex());
  assert.deepStrictEqual(loadCalls, [], `loadIndex 含同步调用: ${loadCalls.join(', ')}`);

  const { syncCalls: saveCalls } = await withSyncFsGuard(() =>
    saveIndex({ dirPath: '/x', songs: [], lastScan: 1 })
  );
  assert.deepStrictEqual(saveCalls, [], `saveIndex 含同步调用: ${saveCalls.join(', ')}`);
  fs.rmSync(userData, { recursive: true, force: true });
});

// ── 进度回调 ─────────────────────────────────────────────────

test('libraryIndex: 大列表按批触发进度回调，且 current 单调不减到 total', async () => {
  const userData = makeTempDir();
  const libDir = makeTempDir();
  const names = [];
  for (let i = 0; i < 45; i++) names.push(`p${i}.mp3`);
  const files = touchFiles(libDir, names);
  init(userData);

  const counters = newCounters();
  const progress = [];
  await incrementalScan(
    libDir, makeScanStub(files, counters), makeMetaStub(counters),
    (p) => progress.push(p)
  );

  assert.ok(progress.length >= 2, '45 个文件（批大小 20）至少回调 2 次');
  assert.ok(progress.every((p) => p.phase === 'metadata'));
  assert.strictEqual(progress[progress.length - 1].total, 45);
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i].current >= progress[i - 1].current, 'current 不得回退');
  }
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(libDir, { recursive: true, force: true });
});
