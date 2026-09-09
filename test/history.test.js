/**
 * 单元测试：utils/history.js
 *
 * 跑：npm test
 *
 * 覆盖：add/query/stats/dedupe/上限淘汰
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'history-test-'));
}

test('history: add + query', () => {
  const dir = makeTempDir();
  const history = require('../src/utils/history');
  history.init(dir);
  history.clear();
  history.add({
    id: '1', source: 'netease', title: '晴天', artist: '周杰伦',
    album: '叶惠美', status: 'done', finishedAt: 1000,
  });
  history.add({
    id: '2', source: 'qq', title: '浮夸', artist: '陈奕迅',
    album: 'U87', status: 'error', finishedAt: 2000,
  });
  const r = history.query();
  assert.strictEqual(r.total, 2);
  // unshift 顺序：最新在前
  assert.strictEqual(r.items[0].id, '2');
  assert.strictEqual(r.items[1].id, '1');
  history.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('history: 状态过滤', () => {
  const dir = makeTempDir();
  const history = require('../src/utils/history');
  history.init(dir);
  history.clear();
  history.add({ id: '1', source: 'netease', title: 'A', status: 'done', finishedAt: 1 });
  history.add({ id: '2', source: 'qq', title: 'B', status: 'error', finishedAt: 2 });
  history.add({ id: '3', source: 'bilibili', title: 'C', status: 'done', finishedAt: 3 });
  const done = history.query({ status: 'done' });
  assert.strictEqual(done.total, 2);
  const err = history.query({ status: 'error' });
  assert.strictEqual(err.total, 1);
  history.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('history: 同 id + source 去重（更新）', () => {
  const dir = makeTempDir();
  const history = require('../src/utils/history');
  history.init(dir);
  history.clear();
  history.add({ id: 'A', source: 'qq', title: '旧', status: 'error', finishedAt: 1 });
  history.add({ id: 'A', source: 'qq', title: '新', status: 'done', finishedAt: 2 });
  const r = history.query();
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.items[0].title, '新');
  assert.strictEqual(r.items[0].status, 'done');
  history.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('history: 关键词搜索', () => {
  const dir = makeTempDir();
  const history = require('../src/utils/history');
  history.init(dir);
  history.clear();
  history.add({ id: '1', source: 'qq', title: '浮夸', artist: '陈奕迅', status: 'done', finishedAt: 1 });
  history.add({ id: '2', source: 'qq', title: 'K歌之王', artist: '陈奕迅', status: 'done', finishedAt: 2 });
  history.add({ id: '3', source: 'qq', title: '晴天', artist: '周杰伦', status: 'done', finishedAt: 3 });
  const r1 = history.query({ keyword: '陈奕迅' });
  assert.strictEqual(r1.total, 2);
  const r2 = history.query({ keyword: '周' });
  assert.strictEqual(r2.total, 1);
  history.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('history: 统计', () => {
  const dir = makeTempDir();
  const history = require('../src/utils/history');
  history.init(dir);
  history.clear();
  history.add({ id: '1', source: 'qq', title: 'A', status: 'done', size: 1000, finishedAt: 1 });
  history.add({ id: '2', source: 'qq', title: 'B', status: 'error', size: 0, finishedAt: 2 });
  history.add({ id: '3', source: 'netease', title: 'C', status: 'done', size: 500, finishedAt: 3 });
  const s = history.stats();
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.done, 2);
  assert.strictEqual(s.error, 1);
  assert.strictEqual(s.totalSize, 1500);
  assert.strictEqual(s.bySource.qq.done, 1);
  assert.strictEqual(s.bySource.qq.error, 1);
  assert.strictEqual(s.bySource.netease.done, 1);
  history.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('history: 上限淘汰', () => {
  const dir = makeTempDir();
  const history = require('../src/utils/history');
  history.init(dir);
  history.clear();
  for (let i = 0; i < 6000; i++) {
    history.add({ id: String(i), source: 'qq', title: 'T' + i, status: 'done', finishedAt: i });
  }
  const r = history.query();
  assert.ok(r.total <= history.MAX_ENTRIES, '应不超过 MAX_ENTRIES');
  history.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('history: 损坏文件 → 备份 .bak + 空历史起步，新记录可写入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-corrupt-'));
  fs.writeFileSync(path.join(dir, 'history.json'), '[{"id":1,"title":"半写', 'utf8');

  const h = require('../src/utils/history');
  h.init(dir);
  assert.strictEqual(h.query().total, 0, '损坏后不残留旧数据');
  assert.ok(fs.existsSync(path.join(dir, 'history.json.bak')), '损坏文件应备份 .bak');

  h.add({ id: 'n1', source: 'qq', title: '晴天', status: 'done' });
  h.flush();
  h.destroy();

  // 重启读回
  delete require.cache[require.resolve('../src/utils/history')];
  const h2 = require('../src/utils/history');
  h2.init(dir);
  assert.strictEqual(h2.query().total, 1);
  assert.strictEqual(h2.query().items[0].title, '晴天');
  h2.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});
