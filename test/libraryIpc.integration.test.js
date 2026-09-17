/**
 * 集成测试：main/ipc/library.js 的 IPC handler（真实文件系统）
 *
 * 跑：npm test
 *
 * 与单测的分工：libraryIndex / localLibrary 的单测用桩隔离了依赖，
 * 本测试则把「注册好的 IPC handler + 真实临时目录 + 真实 fs」串起来跑，
 * 验证本轮 IO 异步化之后端到端仍然可用——异步化最容易踩的坑是
 * 「忘了 await」，那类错误单测发现不了，必须跑真实调用链。
 *
 * 同时装同步 fs 守卫：扫描本地库期间不得出现任何 *Sync 调用。
 * 这是本轮改动的核心验收点（主进程 = UI 线程，同步 IO 会冻结窗口）。
 *
 * 注意：造的文件用 .flac 后缀。node-id3 仅对 .mp3 生效，而它内部用
 * readFileSync——若用 .mp3 会让守卫把第三方库的同步读误判为本模块的回归。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 环境搭建 ─────────────────────────────────────────────────

const handlers = new Map();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-userdata-'));
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-music-'));
const trashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-trash-'));

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: {
        getPath: (name) => (name === 'userData' ? userDataDir : musicDir),
      },
      shell: {
        // 真实删除不可逆，测试里改为移到临时回收目录
        trashItem: async (p) => {
          fs.renameSync(p, path.join(trashDir, path.basename(p)));
        },
        showItemInFolder() { /* no-op */ },
      },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true }),
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const libraryIndex = require('../src/utils/libraryIndex');
const prefs = require('../src/utils/prefs');
const ipcLibrary = require('../src/main/ipc/library');
const playCache = require('../src/main/playCache');

ipcLibrary.register();
// 注意：不要还原 Module._load。library.js 在 handler 内部会惰性
// require('electron')（如 delete-file 里的 shell.trashItem），
// 还原后拿到的是真实 electron 模块（纯 node 下只是二进制路径字符串），
// 会在调用时报 "Cannot read properties of undefined"。
// 整个用例期间保持桩生效，才等于真实的 Electron 运行环境。

// 注入 userData，避免 handler 内部再 require('electron')
libraryIndex.init(userDataDir);
prefs.init(userDataDir);

const invoke = (channel) => {
  const fn = handlers.get(channel);
  assert.ok(fn, `IPC handler 未注册: ${channel}`);
  return fn;
};

// ── 同步 fs 守卫 ─────────────────────────────────────────────

const SYNC_FS_APIS = [
  'statSync', 'lstatSync', 'existsSync', 'readFileSync', 'writeFileSync',
  'readdirSync', 'renameSync', 'unlinkSync', 'copyFileSync', 'mkdirSync',
];

async function withSyncFsGuard(fn) {
  const syncCalls = [];
  const originals = {};
  for (const k of SYNC_FS_APIS) {
    originals[k] = fs[k];
    fs[k] = function guardedSync(...args) {
      // Node 自身的 CommonJS 加载器读源码文件是运行时固有行为（首次 require
      // 一个模块图时必然发生），不是应用代码的同步 IO，不计入。
      // 其余任何 *Sync 调用都说明主进程 UI 线程上出现了同步磁盘操作。
      const stack = new Error().stack || '';
      if (!stack.includes('node:internal/modules')) {
        syncCalls.push(k);
      }
      return originals[k].apply(fs, args);
    };
  }
  try {
    return { result: await fn(), syncCalls };
  } finally {
    for (const k of SYNC_FS_APIS) fs[k] = originals[k];
  }
}

// ── 造一个本地音乐库 ─────────────────────────────────────────

const libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-lib-'));
const LIB_FILES = ['晴天.flac', '七里香.flac', '夜曲.flac'];
for (const n of LIB_FILES) fs.writeFileSync(path.join(libDir, n), 'fake-flac');

// 让 library.js 的路径沙箱认这个目录
prefs.set('localDirPath', libDir);

// ── 守卫有效性自检 ───────────────────────────────────────────

test('同步 fs 守卫本身有效（防止守卫失效导致假绿）', async () => {
  const { syncCalls } = await withSyncFsGuard(async () => {
    fs.existsSync(__filename); // 故意制造一次应用层同步调用
  });
  assert.deepStrictEqual(
    syncCalls, ['existsSync'],
    '守卫必须能捕获应用层同步调用，否则上面的用例都是假通过'
  );
});

// ── 扫描本地库 ───────────────────────────────────────────────

test('scan-local-library: 返回全部音频，且全程无同步 fs 调用', async () => {
  const { result, syncCalls } = await withSyncFsGuard(() =>
    invoke('scan-local-library')({}, libDir)
  );

  assert.strictEqual(result.error, undefined, `扫描报错: ${result.error}`);
  assert.strictEqual(result.count, LIB_FILES.length);
  assert.strictEqual(result.songs.length, LIB_FILES.length);
  assert.ok(result.songs.every((s) => s.filePath), '每首歌都要有 filePath');

  assert.deepStrictEqual(
    syncCalls, [],
    `扫描期间出现同步 fs 调用（会冻结主进程 UI 线程）: ${syncCalls.join(', ')}`
  );
});

test('scan-local-library: 二次扫描走增量，结果稳定', async () => {
  const r = await invoke('scan-local-library')({}, libDir);
  assert.strictEqual(r.incremental, true);
  assert.strictEqual(r.count, LIB_FILES.length);
});

test('scan-local-library: 目录不存在时返回错误而非抛异常', async () => {
  const missing = path.join(libDir, 'no-such-subdir');
  const r = await invoke('scan-local-library')({}, missing);
  assert.strictEqual(r.error, '目录不存在');
  assert.deepStrictEqual(r.songs, []);
});

test('scan-local-library: 非法路径被沙箱拒绝', async () => {
  const r = await invoke('scan-local-library')({}, 'file:///etc/passwd');
  assert.strictEqual(r.error, '非法路径');
  assert.deepStrictEqual(r.songs, []);
});

// ── 索引读取 ─────────────────────────────────────────────────

test('load-library-index: 读回上一轮扫描结果，且无同步 fs 调用', async () => {
  const { result, syncCalls } = await withSyncFsGuard(() => invoke('load-library-index')({}));
  assert.strictEqual(result.songs.length, LIB_FILES.length);
  assert.strictEqual(result.dirPath, libDir);
  assert.ok(result.lastScan > 0, 'lastScan 应被写入');
  assert.deepStrictEqual(syncCalls, [], `load-library-index 含同步调用: ${syncCalls.join(', ')}`);
});

// ── 歌词 sidecar 读写 ────────────────────────────────────────

test('write-local-lrc → read-local-lrc: 往返一致，带 BOM 且能解码', async () => {
  const audio = path.join(libDir, '晴天.flac');
  const lrc = '[00:01.00]故事的小黄花\n[00:05.00]从出生那年就飘着';

  const w = await invoke('write-local-lrc')({}, audio, lrc);
  assert.strictEqual(w.success, true, `写入失败: ${w.error}`);

  const lrcPath = path.join(libDir, '晴天.lrc');
  assert.strictEqual(fs.existsSync(lrcPath), true, '应在音频同目录生成 .lrc');
  const buf = fs.readFileSync(lrcPath);
  assert.deepStrictEqual([...buf.slice(0, 3)], [0xEF, 0xBB, 0xBF], '必须写 UTF-8 BOM');

  const r = await invoke('read-local-lrc')({}, audio);
  assert.strictEqual(r.source, 'sidecar');
  assert.strictEqual(r.lrc, lrc);
});

test('read-local-lrc: 非音频扩展名直接返回空', async () => {
  const r = await invoke('read-local-lrc')({}, path.join(libDir, 'note.txt'));
  assert.strictEqual(r.lrc, '');
  assert.strictEqual(r.source, '');
});

test('read-local-lrc: 沙箱外路径被拒绝', async () => {
  const outside = path.join(os.tmpdir(), 'outside.mp3');
  const r = await invoke('read-local-lrc')({}, outside);
  assert.strictEqual(r.error, '路径不可访问');
});

// ── 重命名 / 删除 ────────────────────────────────────────────

test('rename-file: 正常重命名，且无同步 fs 调用', async () => {
  const src = path.join(libDir, '夜曲.flac');
  const dst = path.join(libDir, '夜曲-重命名.flac');

  const { result, syncCalls } = await withSyncFsGuard(() =>
    invoke('rename-file')({}, src, dst)
  );
  assert.strictEqual(result.success, true, `重命名失败: ${result.error}`);
  assert.strictEqual(fs.existsSync(dst), true);
  assert.strictEqual(fs.existsSync(src), false);
  assert.deepStrictEqual(syncCalls, [], `rename-file 含同步调用: ${syncCalls.join(', ')}`);

  // 复原，避免影响后续用例
  await invoke('rename-file')({}, dst, src);
});

test('rename-file: 目标已存在时拒绝覆盖', async () => {
  const a = path.join(libDir, '晴天.flac');
  const b = path.join(libDir, '七里香.flac');
  const r = await invoke('rename-file')({}, a, b);
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, '目标文件已存在');
  // 两个文件都必须还在（不允许静默覆盖）
  assert.strictEqual(fs.existsSync(a), true);
  assert.strictEqual(fs.existsSync(b), true);
});

test('rename-file: 源文件不存在时返回错误', async () => {
  const r = await invoke('rename-file')({}, path.join(libDir, 'ghost.flac'), path.join(libDir, 'x.flac'));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, '源文件不存在');
});

test('delete-file: 移入回收站后原路径消失', async () => {
  const tmp = path.join(libDir, '待删除.flac');
  fs.writeFileSync(tmp, 'fake-flac');

  const r = await invoke('delete-file')({}, tmp);
  assert.strictEqual(r.success, true, `删除失败: ${r.error}`);
  assert.strictEqual(fs.existsSync(tmp), false);
  assert.strictEqual(fs.existsSync(path.join(trashDir, '待删除.flac')), true);
});

test('delete-file: 文件不存在时返回错误而非抛异常', async () => {
  const r = await invoke('delete-file')({}, path.join(libDir, 'ghost2.flac'));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, '文件不存在');
});

// ── playCache 异步化后的公开 API ─────────────────────────────

test('playCache: getCacheSize / clearAllCache 均返回 Promise 且可用', async () => {
  const size = await playCache.getCacheSize(userDataDir);
  assert.strictEqual(typeof size, 'number');
  assert.ok(size >= 0);

  await playCache.clearAllCache(userDataDir);
  assert.strictEqual(await playCache.getCacheSize(userDataDir), 0, '清空后大小应为 0');

  // formatCacheSize 是纯计算，仍是同步函数
  assert.strictEqual(playCache.formatCacheSize(0), '0 B');
  assert.strictEqual(playCache.formatCacheSize(2048), '2.0 KB');
});

test('playCache: cleanupStaleFiles / cleanupExpired 可安全空跑', async () => {
  await playCache.cleanupStaleFiles(userDataDir);
  await playCache.cleanupExpired();
  assert.ok(true, '空缓存下不应抛错');
});

// ── 收尾 ─────────────────────────────────────────────────────

test('清理测试残留', () => {
  prefs.destroy(); // 取消防抖写盘定时器，避免删除目录后 race
  for (const d of [libDir, userDataDir, musicDir, trashDir]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  assert.ok(true);
});
