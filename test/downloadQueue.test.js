/**
 * 单元测试：main/downloadQueue.js —— 下载队列引擎
 *
 * 为什么值得测：这是**下载链路的状态机**（队列状态流转、并发调度、
 * 重试策略、持久化淘汰）。抽出来之前它埋在 main/index.js 里，
 * 依赖 electron 运行时，无法在 Node 单测中验证 —— 也就是「改错了只能靠人品」。
 *
 * 现在依赖全部注入，可用桩覆盖：
 *   - 并发上限与调度时机
 *   - 仅 403/404/410 重试、fatal 短路不耗配额
 *   - 换源结果回写 _altSource
 *   - done 淘汰上限、防抖持久化、退出落盘
 *   - 重启恢复的状态迁移（downloading→error、stale pending→error）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDownloadQueueEngine, sanitizeFilename } = require('../src/main/downloadQueue');

// ── 测试替身 ──────────────────────────────────────────────

/** 造一个临时 userData 目录 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mq-test-'));
}

/**
 * 构造引擎，默认注入「立即成功」的取流与下载依赖。
 *
 * 说明：history / fsa / downloader 通过**注入**替换（引擎支持这三个依赖注入），
 * 而不是 patch 模块单例 —— 后者对「模块顶层解构绑定」无效（踩过）。
 * 仅 prefs 仍用 patch（引擎按既有约定直接 require 它）。
 *
 * @param {Object} overrides
 */
function buildEngine(overrides = {}) {
  const dir = overrides.dir || tmpDir();
  const sent = [];
  const historyAdds = [];
  const downloaded = [];

  const prefs = require('../src/utils/prefs');
  const origPrefsGet = prefs.get;

  const prefsStore = { concurrency: 2, namingTemplate: '{artist} - {title}', ...(overrides.prefs || {}) };
  prefs.get = (k) => prefsStore[k];

  const engine = createDownloadQueueEngine({
    userDataDir: () => dir,
    safeSend: (ch, payload) => sent.push({ ch, payload }),
    getDownloadUrlSmart: overrides.getDownloadUrlSmart
      || (async () => ({ url: 'https://cdn/x.mp3', ext: 'mp3' })),
    getLyrics: overrides.getLyrics || (async () => ({ lrc: '' })),
    notifier: overrides.notifier || { notifyDownloadDone: () => {} },
    // 注入替身（避免真实网络/落盘）
    history: { add: (rec) => { historyAdds.push(rec); } },
    fsa: { statOrNull: overrides.statOrNull || (async () => ({ size: 1234 })) },
    downloader: {
      downloadFileWithRetry: overrides.downloadFileWithRetry
        || (async (url, savePath) => { downloaded.push({ url, savePath }); }),
      embedId3Tags: overrides.embedId3Tags || (async () => {}),
    },
  });

  const restore = () => { prefs.get = origPrefsGet; };

  return { engine, dir, sent, historyAdds, downloaded, prefsStore, restore };
}

/** 等一个条件成立（轮询），超时抛错 */
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ══════════════════════════════════════════════════════════
// 构造与校验
// ══════════════════════════════════════════════════════════

test('createDownloadQueueEngine: 缺必需依赖立即抛错', () => {
  assert.throws(() => createDownloadQueueEngine({}), /必须注入 userDataDir/);
  assert.throws(
    () => createDownloadQueueEngine({ userDataDir: () => '/x', safeSend: () => {} }),
    /必须注入 getDownloadUrlSmart/,
  );
  assert.throws(
    () => createDownloadQueueEngine({
      userDataDir: () => '/x', safeSend: () => {}, getDownloadUrlSmart: async () => ({}),
    }),
    /必须注入 getLyrics/,
  );
});

test('sanitizeFilename: 去掉路径分隔符与非法字符，限长 200', () => {
  assert.strictEqual(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.strictEqual(sanitizeFilename('x'.repeat(300)).length, 200);
});

// ══════════════════════════════════════════════════════════
// 调度与并发
// ══════════════════════════════════════════════════════════

test('processQueue: 单曲成功 ⇒ status=done，写历史与队列推送', async () => {
  const { engine, sent, historyAdds, restore } = buildEngine();
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');

    const s = engine.getQueue()[0];
    assert.strictEqual(s.status, 'done');
    assert.strictEqual(s.progress, 100);
    assert.ok(s.savePath, '应记录落盘路径');
    assert.strictEqual(historyAdds.length, 1);
    assert.strictEqual(historyAdds[0].status, 'done');
    assert.strictEqual(historyAdds[0].size, 1234);
    assert.ok(sent.some(e => e.ch === 'queue-updated'), '应推送 queue-updated');
  } finally { restore(); }
});

test('processQueue: 并发上限生效（concurrency=2 时同时最多 2 首）', async () => {
  let running = 0;
  let maxRunning = 0;
  const { engine, restore } = buildEngine({
    prefs: { concurrency: 2 },
    downloadFileWithRetry: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 40));
      running--;
    },
  });
  try {
    for (let i = 0; i < 5; i++) {
      engine.getQueue().push({ id: String(i), source: 'netease', title: `t${i}`, artist: 'a', taskId: `k${i}`, status: 'pending' });
    }
    await engine.processQueue();
    await waitFor(() => engine.getQueue().every(s => s.status === 'done'));
    assert.ok(maxRunning <= 2, `并发不应超过 2，实际峰值 ${maxRunning}`);
    assert.strictEqual(engine.getQueue().filter(s => s.status === 'done').length, 5);
  } finally { restore(); }
});

test('processQueue: concurrency 越界回落 3（0 / 99 / 非法值）', async () => {
  for (const bad of [0, 99, 'x', null]) {
    let maxRunning = 0;
    let running = 0;
    const { engine, restore } = buildEngine({
      prefs: { concurrency: bad },
      downloadFileWithRetry: async () => {
        running++; maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
      },
    });
    try {
      for (let i = 0; i < 6; i++) {
        engine.getQueue().push({ id: String(i), source: 'netease', title: `t${i}`, artist: 'a', taskId: `k${i}`, status: 'pending' });
      }
      await engine.processQueue();
      await waitFor(() => engine.getQueue().every(s => s.status === 'done'));
      assert.ok(maxRunning <= 3, `concurrency=${bad} 应回落 3，实际峰值 ${maxRunning}`);
    } finally { restore(); }
  }
});

test('processQueue: 重入保护（并发调用不会重复调度同一首）', async () => {
  let calls = 0;
  const { engine, restore } = buildEngine({
    downloadFileWithRetry: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
    },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    // 连续三次调用，应只有一次真正调度
    await Promise.all([engine.processQueue(), engine.processQueue(), engine.processQueue()]);
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(calls, 1, '同一任务不应被重复下载');
  } finally { restore(); }
});

test('processQueue: 空队列不抛错', async () => {
  const { engine, restore } = buildEngine();
  try {
    await engine.processQueue();
    assert.strictEqual(engine.getQueue().length, 0);
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 重试与 fatal 短路
// ══════════════════════════════════════════════════════════

test('重试：HTTP 403 重试一次后成功', async () => {
  let attempts = 0;
  const { engine, restore } = buildEngine({
    downloadFileWithRetry: async () => {
      attempts++;
      if (attempts === 1) throw new Error('HTTP 403 Forbidden');
    },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done', { timeout: 3000 });
    assert.strictEqual(attempts, 2, '应在 403 后重试一次');
    assert.strictEqual(engine.getQueue()[0].status, 'done');
  } finally { restore(); }
});

test('重试：非 403/404/410 错误不重试（直接失败）', async () => {
  let attempts = 0;
  const { engine, restore } = buildEngine({
    downloadFileWithRetry: async () => { attempts++; throw new Error('磁盘写入失败'); },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error');
    assert.strictEqual(attempts, 1, '不可重试错误只应尝试一次');
  } finally { restore(); }
});

test('fatal 短路：取流返回 fatal ⇒ 不消耗重试配额，直接 error', async () => {
  let urlCalls = 0;
  let dlCalls = 0;
  const { engine, sent, restore } = buildEngine({
    getDownloadUrlSmart: async () => {
      urlCalls++;
      return { error: '该歌曲需要 VIP 会员', code: 'VIP_REQUIRED', fatal: true };
    },
    downloadFileWithRetry: async () => { dlCalls++; },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error');
    assert.strictEqual(urlCalls, 1, 'fatal 应短路，不重试取流');
    assert.strictEqual(dlCalls, 0, 'fatal 不应尝试下载');
    assert.strictEqual(engine.getQueue()[0].errorCode, 'VIP_REQUIRED');
    const errEvt = sent.find(e => e.ch === 'download-error');
    assert.ok(errEvt, '应推送 download-error');
    assert.strictEqual(errEvt.payload.fatal, true, 'fatal 应透传给渲染层');
  } finally { restore(); }
});

test('非 fatal 取流失败（无重试特征）⇒ 不重试，直接 error', async () => {
  let urlCalls = 0;
  const { engine, restore } = buildEngine({
    getDownloadUrlSmart: async () => { urlCalls++; return { error: '临时失败' }; },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error', { timeout: 3000 });
    assert.strictEqual(urlCalls, 1, '无 403/404/410 特征时不应重试');
  } finally { restore(); }
});

test('取流失败但错误信息含 HTTP 410 ⇒ 重试到上限（CDN 签名过期可换源重取）', async () => {
  let urlCalls = 0;
  const { engine, restore } = buildEngine({
    getDownloadUrlSmart: async () => { urlCalls++; return { error: 'HTTP 410 Gone' }; },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'error', { timeout: 3000 });
    assert.strictEqual(urlCalls, 2, '410 应重试到上限（2 次）');
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 换源结果回写
// ══════════════════════════════════════════════════════════

test('换源：matchedSong 回写 _altSource（供下次直试）', async () => {
  const { engine, restore } = buildEngine({
    getDownloadUrlSmart: async () => ({
      url: 'https://cdn/y.mp3', ext: 'mp3',
      source: 'kugou', matchedSong: { id: 'k9', source: 'kugou' }, matchedFrom: 'netease',
    }),
  });
  try {
    const song = { id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' };
    engine.getQueue().push(song);
    await engine.processQueue();
    await waitFor(() => song.status === 'done');
    assert.deepStrictEqual(song._altSource, { source: 'kugou', id: 'k9' });
  } finally { restore(); }
});

test('换源：历史记录记实际取流源 + matchedFrom', async () => {
  const { engine, historyAdds, restore } = buildEngine({
    getDownloadUrlSmart: async () => ({
      url: 'https://cdn/y.mp3',
      source: 'kugou', matchedSong: { id: 'k9', source: 'kugou' }, matchedFrom: 'netease',
    }),
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(historyAdds[0].source, 'kugou', '应记实际取流源');
    assert.strictEqual(historyAdds[0].matchedFrom, 'netease');
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 持久化
// ══════════════════════════════════════════════════════════

test('persistQueue: 防抖合并写入（500ms 内多次调用只写一次）', async () => {
  const { engine, dir, restore } = buildEngine();
  try {
    engine.getQueue().push({ id: '1', source: 'q', title: 't', taskId: 'x', status: 'pending' });
    engine.persistQueue();
    engine.persistQueue();
    engine.persistQueue();
    await new Promise((r) => setTimeout(r, 700));
    const fp = path.join(dir, 'queue.json');
    assert.ok(fs.existsSync(fp), '应写入 queue.json');
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.strictEqual(data.length, 1);
  } finally { restore(); }
});

test('dispose: 防抖窗口内退出 ⇒ 立即落盘，不丢最后一次变更', async () => {
  const { engine, dir, restore } = buildEngine();
  try {
    engine.getQueue().push({ id: '1', source: 'q', title: 't', taskId: 'x', status: 'done' });
    engine.persistQueue();   // 进入防抖窗口
    engine.dispose();        // 立即退出
    const fp = path.join(dir, 'queue.json');
    assert.ok(fs.existsSync(fp), 'dispose 应把待写队列落盘');
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.strictEqual(data.length, 1, '不应丢失最后一次变更');
  } finally { restore(); }
});

test('loadPersistedQueue: 恢复任务并迁移状态', async () => {
  const dir = tmpDir();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify([
    { id: '1', status: 'downloading', title: 'a' },
    { id: '2', status: 'pending', title: 'b', addedAt: now },
    { id: '3', status: 'pending', title: 'c', addedAt: now - 25 * 60 * 60 * 1000 },
    { id: '4', status: 'done', title: 'd' },
    { id: '5', status: 'error', title: 'e' },
  ]));
  const { engine, restore } = buildEngine({ dir });
  try {
    await engine.loadPersistedQueue();
    const q = engine.getQueue();
    assert.strictEqual(q.length, 5);
    assert.strictEqual(q[0].status, 'error', 'downloading 异常关闭 → error');
    assert.strictEqual(q[1].status, 'pending', '新 pending 保留');
    assert.strictEqual(q[2].status, 'error', '超 24h pending → error');
    assert.strictEqual(q[3].status, 'done', 'done 保留');
    assert.strictEqual(q[4].status, 'error', 'error 保留');
  } finally { restore(); }
});

test('loadPersistedQueue: 文件损坏不抛错（从空队列恢复）', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'queue.json'), '{ 这不是合法 JSON');
  const { engine, restore } = buildEngine({ dir });
  try {
    await engine.loadPersistedQueue();
    assert.strictEqual(engine.getQueue().length, 0);
  } finally { restore(); }
});

test('loadPersistedQueue: 文件不存在不抛错', async () => {
  const { engine, restore } = buildEngine();
  try {
    await engine.loadPersistedQueue();
    assert.strictEqual(engine.getQueue().length, 0);
  } finally { restore(); }
});

test('淘汰：done 超过 200 时保留最新 200（最旧的被删）', async () => {
  const { engine, dir, restore } = buildEngine();
  try {
    const q = engine.getQueue();
    for (let i = 0; i < 205; i++) {
      q.push({ id: String(i), source: 'q', title: `t${i}`, taskId: `k${i}`, status: 'done' });
    }
    engine.persistQueue();
    await new Promise((r) => setTimeout(r, 700));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));
    assert.strictEqual(saved.length, 200, `应淘汰到 200，实际 ${saved.length}`);
    assert.strictEqual(saved[0].id, '5', '应淘汰最旧的 5 条');
    assert.strictEqual(saved[saved.length - 1].id, '204', '应保留最新');
  } finally { restore(); }
});

test('淘汰：不误删 pending/error 任务', async () => {
  const { engine, dir, restore } = buildEngine();
  try {
    const q = engine.getQueue();
    q.push({ id: 'p1', source: 'q', title: 'pending', taskId: 'p', status: 'pending' });
    for (let i = 0; i < 202; i++) {
      q.push({ id: String(i), source: 'q', title: `t${i}`, taskId: `k${i}`, status: 'done' });
    }
    q.push({ id: 'e1', source: 'q', title: 'error', taskId: 'e', status: 'error' });
    engine.persistQueue();
    await new Promise((r) => setTimeout(r, 700));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));
    assert.ok(saved.some(s => s.id === 'p1'), 'pending 不应被淘汰');
    assert.ok(saved.some(s => s.id === 'e1'), 'error 不应被淘汰');
    assert.strictEqual(saved.filter(s => s.status === 'done').length, 200);
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════
// 歌词与 ID3
// ══════════════════════════════════════════════════════════

test('歌词：换源成功时用匹配源的 id/source 取词（更准）', async () => {
  let seen = null;
  const { engine, restore } = buildEngine({
    getDownloadUrlSmart: async () => ({
      url: 'https://cdn/y.mp3',
      source: 'kugou', matchedSong: { id: 'k9', source: 'kugou' }, matchedFrom: 'netease',
    }),
    getLyrics: async (id, source) => { seen = { id, source }; return { lrc: '[00:01]hi' }; },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.deepStrictEqual(seen, { id: 'k9', source: 'kugou' });
  } finally { restore(); }
});

test('歌词：取词失败不影响下载成功', async () => {
  const { engine, restore } = buildEngine({
    getLyrics: async () => { throw new Error('歌词接口炸了'); },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(engine.getQueue()[0].status, 'done', '歌词失败不应让下载失败');
  } finally { restore(); }
});

test('保存目录：saveDir 为 null 时不崩溃（回落 prefs 或系统目录）', async () => {
  const { engine, restore } = buildEngine({ prefs: { saveDir: undefined } });
  try {
    engine.getQueue().push({
      id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x',
      status: 'pending', saveDir: null,
    });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done', { timeout: 3000 });
    assert.strictEqual(engine.getQueue()[0].status, 'done');
  } finally { restore(); }
});

test('通知：notifications=false 时不调用通知器', async () => {
  let notified = 0;
  const { engine, restore } = buildEngine({
    prefs: { notifications: false },
    notifier: { notifyDownloadDone: () => { notified++; } },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(notified, 0, '关闭通知时不应弹窗');
  } finally { restore(); }
});

test('通知：默认开启时调用通知器', async () => {
  let notified = 0;
  const { engine, restore } = buildEngine({
    notifier: { notifyDownloadDone: () => { notified++; } },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(notified, 1);
  } finally { restore(); }
});

// ── 暂停/继续调度 ────────────────────────────────────────

test('setPaused: 暂停时不调度新任务，恢复后立即调度并完成', async () => {
  const { engine, restore, downloaded } = buildEngine();
  try {
    engine.setPaused(true);
    assert.strictEqual(engine.isPaused(), true);
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(engine.getQueue()[0].status, 'pending', '暂停期间不应启动');
    assert.strictEqual(downloaded.length, 0);

    engine.setPaused(false);
    assert.strictEqual(engine.isPaused(), false);
    await waitFor(() => engine.getQueue()[0].status === 'done');
    assert.strictEqual(downloaded.length, 1);
  } finally { restore(); }
});

test('setPaused: 在途任务不被打断，照常完成', async () => {
  const { engine, restore } = buildEngine({
    downloadFileWithRetry: async () => { await new Promise((r) => setTimeout(r, 60)); },
  });
  try {
    engine.getQueue().push({ id: '1', source: 'netease', title: 't', artist: 'a', taskId: 'x', status: 'pending' });
    await engine.processQueue();
    await waitFor(() => engine.getQueue()[0].status === 'downloading');
    engine.setPaused(true);
    await waitFor(() => engine.getQueue()[0].status === 'done', { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 50)); // 等 finally 链收尾（activeDownloads--）
    assert.strictEqual(engine.getActiveCount(), 0);
  } finally { restore(); }
});

test('setPaused: 暂停期间入队的多个任务恢复后全部完成（含 100ms 重排定时器被打断）', async () => {
  const { engine, restore } = buildEngine({
    prefs: { concurrency: 1 },
    downloadFileWithRetry: async () => { await new Promise((r) => setTimeout(r, 10)); },
  });
  try {
    engine.setPaused(true);
    for (let i = 0; i < 3; i++) {
      engine.getQueue().push({ id: String(i), source: 'netease', title: `t${i}`, artist: 'a', taskId: `k${i}`, status: 'pending' });
    }
    await engine.processQueue();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(engine.getQueue().every(s => s.status === 'pending'));
    engine.setPaused(false);
    await waitFor(() => engine.getQueue().every(s => s.status === 'done'), { timeout: 3000 });
  } finally { restore(); }
});
