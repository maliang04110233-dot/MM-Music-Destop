/**
 * 单元测试：utils/cloudSyncCore.js — WebDAV 一次同步的编排逻辑
 *
 * 依赖全部注入（fetchSnapshot/pushSnapshot/applyMerged/now），
 * 不发网络、不碰 electron，验证编排骨架与失败语义：
 *   拉取 → 合并 → 推回 → 推成功后才回写本地。
 */

const test = require('node:test');
const assert = require('node:assert');

const { syncOnce } = require('../src/utils/cloudSyncCore');

const baseLocal = () => ({
  userPlaylists: [{ id: 'a', name: '本地', updatedAt: 100, songs: [{ id: '1', source: 'qq', title: 'X' }] }],
  downloadTemplates: [],
  downloadHistory: [{ id: '1', source: 'qq', status: 'done', finishedAt: 10 }],
});

function deps(overrides = {}) {
  const calls = { fetch: 0, push: [], apply: [] };
  const d = {
    config: { url: 'https://nas/dav/musicdl.json', user: 'u', pass: 'p' },
    localData: baseLocal(),
    fetchSnapshot: async () => { calls.fetch++; return { exists: false }; },
    pushSnapshot: async (cfg, snapshot, opts) => { calls.push.push({ snapshot, opts }); return { ok: true }; },
    applyMerged: (merged) => { calls.apply.push(merged); },
    now: () => 1700000000000,
    ...overrides,
  };
  return { d, calls };
}

test('syncOnce: 远端为空 → 推本地快照（version/app/exportedAt 信封），回写本地', async () => {
  const { d, calls } = deps();
  const r = await syncOnce(d);
  assert.strictEqual(r.success, true);
  assert.strictEqual(calls.push.length, 1);
  const payload = calls.push[0].snapshot;
  assert.strictEqual(payload.app, 'music-downloader');
  assert.strictEqual(payload.version, 2);
  assert.strictEqual(payload.exportedAt, new Date(1700000000000).toISOString());
  assert.deepStrictEqual(payload.data.userPlaylists.map(p => p.id), ['a']);
  assert.strictEqual(calls.push[0].opts.etag, undefined, '远端不存在时无条件 PUT');
  assert.strictEqual(calls.apply.length, 1);
  assert.deepStrictEqual(r.summary, { playlists: 1, templates: 0, historyTotal: 1 });
});

test('syncOnce: 远端已有数据 → 双向并集，既回写本地也推回远端', async () => {
  const remote = {
    exists: true, etag: '"v7"',
    snapshot: {
      app: 'music-downloader', version: 2,
      data: {
        userPlaylists: [{ id: 'r', name: '远端歌单', updatedAt: 5, songs: [{ id: '9', source: 'netease', title: 'Z' }] }],
        downloadHistory: [{ id: '9', source: 'netease', status: 'done', finishedAt: 20 }],
      },
    },
  };
  const { d, calls } = deps({ fetchSnapshot: async () => remote });
  const r = await syncOnce(d);
  assert.strictEqual(r.success, true);
  assert.strictEqual(calls.push[0].opts.etag, '"v7"', 'PUT 带 If-Match 的 etag');
  const ids = calls.apply[0].userPlaylists.map(p => p.id).sort();
  assert.deepStrictEqual(ids, ['a', 'r']);
  assert.strictEqual(calls.apply[0].downloadHistory.length, 2);
  assert.deepStrictEqual(calls.push[0].snapshot.data.userPlaylists.map(p => p.id).sort(), ['a', 'r']);
  assert.deepStrictEqual(r.summary, { playlists: 2, templates: 0, historyTotal: 2 });
});

test('syncOnce: 远端文件来自其它应用 → 拒绝，不推不回写', async () => {
  const { d, calls } = deps({
    fetchSnapshot: async () => ({ exists: true, etag: null, snapshot: { app: 'other', data: {} } }),
  });
  const r = await syncOnce(d);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /不匹配/);
  assert.strictEqual(calls.push.length, 0);
  assert.strictEqual(calls.apply.length, 0);
});

test('syncOnce: 412 冲突 → 重拉重并再推（不再带 etag），最终回写含双方', async () => {
  const remote1 = {
    exists: true, etag: '"stale"',
    snapshot: { app: 'music-downloader', version: 2, data: { userPlaylists: [{ id: 'r1', updatedAt: 1, songs: [] }] } },
  };
  const remote2 = {
    exists: true, etag: '"newer"',
    snapshot: { app: 'music-downloader', version: 2, data: { userPlaylists: [{ id: 'r2', updatedAt: 1, songs: [] }] } },
  };
  let n = 0;
  const { d, calls } = deps({
    fetchSnapshot: async () => (n++ === 0 ? remote1 : remote2),
    pushSnapshot: async (cfg, snapshot, opts) => {
      calls.push.push({ snapshot, opts });
      return calls.push.length === 1 ? { ok: false, conflict: true } : { ok: true };
    },
  });
  const r = await syncOnce(d);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.conflictRetried, true);
  assert.strictEqual(calls.push[1].opts.etag, undefined, '重试为无条件 PUT');
  const ids = calls.apply[0].userPlaylists.map(p => p.id).sort();
  assert.deepStrictEqual(ids, ['a', 'r1', 'r2']);
});

test('syncOnce: 推送抛错（如 403）→ 失败返回，本地不回写', async () => {
  const err = new Error('WebDAV 写入失败（HTTP 403）');
  err.status = 403;
  const { d, calls } = deps({ pushSnapshot: async () => { throw err; } });
  const r = await syncOnce(d);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /403/);
  assert.strictEqual(calls.apply.length, 0);
});

test('syncOnce: 未配置 URL / 拉取抛错 → 明确失败信息', async () => {
  const noUrl = deps({ config: { url: '' } });
  assert.strictEqual((await syncOnce(noUrl.d)).success, false);

  const { d } = deps({ fetchSnapshot: async () => { throw new Error('连接超时'); } });
  const r = await syncOnce(d);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /连接超时/);
});

test('syncOnce: 远端 data 字段脏（非数组）不炸，按空合并', async () => {
  const { d, calls } = deps({
    fetchSnapshot: async () => ({
      exists: true, etag: null,
      snapshot: { app: 'music-downloader', data: { userPlaylists: 'junk', downloadHistory: null } },
    }),
  });
  const r = await syncOnce(d);
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(calls.apply[0].userPlaylists.map(p => p.id), ['a']);
});
