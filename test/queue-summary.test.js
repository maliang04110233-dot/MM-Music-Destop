/**
 * queueSummary.js 守护测试 — 队列总览条纯逻辑
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function fresh() {
  return import(`../src/renderer/js/queueSummary.js?ck=${Math.random()}`);
}

const BYTES = n => (n >= 1024 ? Math.round(n / 1024) + 'KB' : n + 'B');
const ETA = s => Math.round(s) + 's';

test('computeQueueSummary：按状态计数', async () => {
  const { computeQueueSummary } = await fresh();
  const items = [
    { taskId: 'a', status: 'downloading' },
    { taskId: 'b', status: 'pending' },
    { taskId: 'c', status: 'pending' },
    { taskId: 'd', status: 'done' },
    { taskId: 'e', status: 'error' },
  ];
  const sum = computeQueueSummary(items);
  assert.equal(sum.downloading, 1);
  assert.equal(sum.pending, 2);
  assert.equal(sum.done, 1);
  assert.equal(sum.error, 1);
  assert.equal(sum.speedBps, 0);
  assert.equal(sum.remainSec, null);
});

test('recordLive 聚合：速度求和、剩余取最慢、字节累计', async () => {
  const { computeQueueSummary, recordLive } = await fresh();
  recordLive({ id: 'a', speedBps: 500 * 1024, etaSec: 40, receivedBytes: 1000, totalBytes: 9000 });
  recordLive({ id: 'b2', speedBps: 300 * 1024, etaSec: 120, receivedBytes: 2000, totalBytes: 8000 });
  const items = [
    { taskId: 'a', status: 'downloading' },
    { taskId: 'b2', status: 'downloading' },
    { taskId: 'c', status: 'downloading' }, // 无实时事件 → 不贡献速度
  ];
  const sum = computeQueueSummary(items);
  assert.equal(sum.downloading, 3);
  assert.equal(sum.speedBps, 800 * 1024);
  assert.equal(sum.remainSec, 120);
  assert.equal(sum.receivedBytes, 3000);
  assert.equal(sum.totalBytes, 17000);
});

test('summaryText：文案片段与空队列返回空串', async () => {
  const { summaryText } = await fresh();
  const sum = { downloading: 2, pending: 3, done: 5, error: 1, speedBps: 1500, remainSec: 75 };
  const text = summaryText(sum, BYTES, ETA);
  assert.match(text, /⬇ 2 下载中/);
  assert.match(text, /3 排队/);
  assert.match(text, /总速 1KB\/s/);
  assert.match(text, /约剩 75s/);
  assert.match(text, /❌ 1 失败/);
  assert.equal(summaryText({ downloading: 0, pending: 0, error: 4 }, BYTES, ETA), '');
  assert.equal(summaryText(null, BYTES, ETA), '');
  // 只有排队：无速度/剩余段
  const only = summaryText({ downloading: 0, pending: 2, speedBps: 9999, remainSec: 50, error: 0 }, BYTES, ETA);
  assert.equal(only, '2 排队');
});

test('pruneLive：出队任务的实时进度被清理', async () => {
  const mod = await fresh();
  mod.recordLive({ id: 'gone', speedBps: 10 });
  mod.recordLive({ id: 'keep', speedBps: 10 });
  mod.pruneLive([{ taskId: 'keep', status: 'downloading' }]);
  const sum = mod.computeQueueSummary([
    { taskId: 'keep', status: 'downloading' },
    { taskId: 'gone', status: 'error' },
  ]);
  assert.equal(sum.speedBps, 10);
});

test('etaSec 非法/0 不参与 max，summaryLine 空队列有兜底文案', async () => {
  const mod = await fresh();
  mod.recordLive({ id: 'x', speedBps: 1, etaSec: null });
  mod.recordLive({ id: 'y', speedBps: 1, etaSec: 'abc' });
  const sum = mod.computeQueueSummary([
    { taskId: 'x', status: 'downloading' },
    { taskId: 'y', status: 'downloading' },
  ]);
  assert.equal(sum.remainSec, null);
  assert.match(mod.summaryLine([]), /没有进行中的任务/);
});
