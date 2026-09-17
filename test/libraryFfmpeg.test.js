/**
 * 单元测试：main/ipc/library.js 的 ffmpeg 探测
 *
 * 跑：npm test
 *
 * 背景：旧实现用 spawnSync 逐个探测 5 个候选路径、每个超时 5 秒。
 * 用户没装 ffmpeg 时，点一次「转码」会让主进程（UI 线程）最坏冻结 25 秒。
 * 本测试锁定两点：
 *   1. 结果被缓存——重复调用不得重新探测；
 *   2. 不得出现任何 child_process 同步调用。
 */

const test = require('node:test');
const assert = require('node:assert');

// library.js 顶层 require('electron') 只为注册 IPC，测试环境无 electron 二进制。
// 与 test/checkLocal.test.js 同一套 Module._load 拦截约定。
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle() { /* no-op in tests */ } },
      app: { getPath: () => process.cwd() },
    };
  }
  return originalLoad(request, parent, isMain);
};
const { findFfmpeg, _resetFfmpegCacheForTest } = require('../src/main/ipc/library');
Module._load = originalLoad;

test('findFfmpeg: 返回可用命令或 null，且结果被缓存（二次调用不再探测）', async () => {
  _resetFfmpegCacheForTest();

  const first = await findFfmpeg();
  assert.ok(
    first === null || typeof first === 'string',
    `应返回路径字符串或 null，实际: ${JSON.stringify(first)}`
  );

  const t0 = Date.now();
  const second = await findFfmpeg();
  const elapsed = Date.now() - t0;

  assert.strictEqual(second, first, '缓存命中后结果必须一致');
  assert.ok(elapsed < 20, `二次调用应命中缓存立即返回，实际耗时 ${elapsed}ms`);
});

test('findFfmpeg: 全程不调用 child_process 同步 API', async () => {
  _resetFfmpegCacheForTest();

  const cp = require('child_process');
  const syncNames = ['spawnSync', 'execSync', 'execFileSync'];
  const originals = {};
  const called = [];
  for (const n of syncNames) {
    originals[n] = cp[n];
    cp[n] = function guardedSync(...args) {
      called.push(n);
      return originals[n].apply(cp, args);
    };
  }
  try {
    await findFfmpeg();
  } finally {
    for (const n of syncNames) cp[n] = originals[n];
  }

  assert.deepStrictEqual(
    called, [],
    `ffmpeg 探测出现同步进程调用（会冻结 UI 线程）: ${called.join(', ')}`
  );
});

test('_resetFfmpegCacheForTest: 重置后可重新探测（模拟用户新装了 ffmpeg）', async () => {
  _resetFfmpegCacheForTest();
  const a = await findFfmpeg();
  _resetFfmpegCacheForTest();
  const b = await findFfmpeg();
  assert.strictEqual(a, b, '同一台机器上两次探测结果应一致');
});
