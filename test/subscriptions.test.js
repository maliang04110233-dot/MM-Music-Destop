/**
 * 单元测试：订阅更新引擎（无需网络部分）
 *
 * 覆盖回归代价最高的纯逻辑：
 *   - key 格式与校验（平台能力探测，防「订阅了拿不到数据的平台」）
 *   - diffSongs：首次播种静默、新增判定、**并集语义**（平台抽风返回空
 *     列表不得让老歌复活成「新增」——这是 gateway 静默吞错的直接后果）
 *   - prefs 存储往返与 patch 白名单
 * 网络拉取与自动下载入队由真实运行覆盖（_autoEnqueue 依赖 getCtx，
 * 测试进程未初始化 context，本就不该被调到）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const prefs = require('../src/utils/prefs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-sub-'));
prefs.init(tmpDir);

const subs = require('../src/main/subscriptions');
const { buildKey, validateAdd, diffSongs, makeEntry } = subs._internal;

test.after(() => {
  prefs.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── key / 校验 ─────────────────────────────────────────

test('buildKey：type:platform:targetId 三段式', () => {
  assert.strictEqual(buildKey('playlist', 'netease', '123'), 'playlist:netease:123');
});

test('validateAdd：拒绝未知类型 / 未知平台 / 缺参', () => {
  assert.strictEqual(validateAdd('album', 'netease', '1'), '不支持的订阅类型');
  assert.ok(validateAdd('playlist', 'nope', '1'));
  assert.strictEqual(validateAdd('playlist', 'netease', ''), '参数不完整');
});

test('validateAdd：平台能力不足时明确报错（而非订阅后静默空列表）', () => {
  const api = require('../src/api');
  const pl = api.registry.get('kuwo');
  if (pl && typeof pl.getPlaylistSongs !== 'function') {
    assert.strictEqual(validateAdd('playlist', 'kuwo', '1'), 'kuwo 暂不支持歌单订阅');
  }
  // 网易云两种能力齐备，必须放行
  assert.strictEqual(validateAdd('playlist', 'netease', '1'), null);
  assert.strictEqual(validateAdd('singer', 'netease', '1'), null);
});

// ── diffSongs（核心回归点）──────────────────────────────

test('diffSongs：首次检查静默播种，不产生新增', () => {
  const r = diffSongs([{ id: 1 }, { id: 2 }], null);
  assert.deepStrictEqual(r.fresh, []);
  assert.strictEqual(r.seeded, true);
  assert.deepStrictEqual(r.seenIds, ['1', '2']);
});

test('diffSongs：只报上次快照里没有的 id', () => {
  const r = diffSongs([{ id: 1 }, { id: 2 }, { id: 3 }], ['1']);
  assert.deepStrictEqual(r.fresh.map(s => s.id), [2, 3]);
  assert.strictEqual(r.seeded, false);
});

test('diffSongs：本次为空（接口抽风）不得清空快照、不得让老歌变新增', () => {
  const r = diffSongs([], ['1', '2']);
  assert.deepStrictEqual(r.fresh, []);
  assert.deepStrictEqual(r.seenIds, ['1', '2']);
});

test('diffSongs：同批重复 id 只算一次新增', () => {
  const r = diffSongs([{ id: 7 }, { id: '7' }], []);
  assert.strictEqual(r.fresh.length, 1);
  assert.deepStrictEqual(r.seenIds, ['7']);
});

test('diffSongs：脏条目（缺 id）被剔除', () => {
  const r = diffSongs([{ id: null }, {}, { id: '' }, { id: 5 }], []);
  assert.deepStrictEqual(r.fresh.map(s => s.id), [5]);
});

test('diffSongs：新增列表按 cap 截断（防 prefs.json 膨胀）', () => {
  const songs = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));
  const r = diffSongs(songs, [], 5);
  assert.strictEqual(r.fresh.length, 5);
  assert.strictEqual(r.seenIds.length, 20);
});

// ── 存储往返 ───────────────────────────────────────────

test('add/list/remove/update/markSeen 全链路（prefs 存储）', () => {
  const r = subs.add('playlist', 'netease', '954812', '云音乐热歌榜');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.entry.key, 'playlist:netease:954812');
  assert.strictEqual(r.entry.lastSeenIds, null);

  // 幂等：重复订阅返回 duplicated 而不是两份记录
  const again = subs.add('playlist', 'netease', '954812', '云音乐热歌榜');
  assert.strictEqual(again.success, true);
  assert.strictEqual(again.duplicated, true);
  assert.strictEqual(subs.list().length, 1);

  // patch 白名单：只认 autoDownload，其他键不得写入
  const u = subs.update('playlist:netease:954812', { autoDownload: true, targetId: 'evil', newSongs: [{ id: 'x' }] });
  assert.strictEqual(u.success, true);
  assert.strictEqual(u.entry.autoDownload, true);
  assert.strictEqual(u.entry.targetId, '954812');
  assert.deepStrictEqual(u.entry.newSongs, []);

  assert.strictEqual(subs.remove('playlist:netease:954812').success, true);
  assert.deepStrictEqual(subs.list(), []);
  assert.strictEqual(subs.remove('playlist:netease:954812').success, false);
});

test('add：非法参数直接拒绝且不落盘', () => {
  assert.strictEqual(subs.add('album', 'netease', '1', '').success, false);
  assert.strictEqual(subs.add('playlist', 'nope', '1', '').success, false);
  assert.deepStrictEqual(subs.list(), []);
});

test('unreadCount：未读新歌求和', () => {
  const e = makeEntry('playlist', 'netease', '1', 'x');
  e.newSongs = [{ id: 'a' }, { id: 'b' }];
  prefs.set('subscriptions', [e]);
  assert.strictEqual(subs.unreadCount(), 2);
  assert.strictEqual(subs.list()[0].newCount, 2);
  assert.strictEqual(subs.markSeen('playlist:netease:1').success, true);
  assert.strictEqual(subs.unreadCount(), 0);
  prefs.set('subscriptions', []);
});

test('_isDue：从未检查必到期；间隔从 prefs 小时数换算', () => {
  const { _isDue, _intervalMs } = subs._internal;
  prefs.set('subscriptionCheckIntervalHours', 6);
  assert.strictEqual(_intervalMs(), 6 * 3600 * 1000);
  assert.strictEqual(_isDue({ lastCheckedAt: null }, Date.now()), true);
  assert.strictEqual(_isDue({ lastCheckedAt: Date.now() - 7 * 3600 * 1000 }, Date.now()), true);
  assert.strictEqual(_isDue({ lastCheckedAt: Date.now() - 1000 }, Date.now()), false);
  // 非法值回退默认 6 小时
  prefs.set('subscriptionCheckIntervalHours', 'abc');
  assert.strictEqual(_intervalMs(), 6 * 3600 * 1000);
  prefs.set('subscriptionCheckIntervalHours', null);
});
