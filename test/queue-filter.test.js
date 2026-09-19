// 队列过滤纯逻辑（queueFilter.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function fresh() {
  return import(`../src/renderer/js/queueFilter.js?ck=${Math.random()}`);
}

const Q = () => [
  { taskId: 1, title: '平凡之路', artist: '朴树', status: 'done' },
  { taskId: 2, title: 'Hello', artist: 'Adele', status: 'downloading' },
  { taskId: 3, title: 'Hello 翻唱版', artist: '某人', status: 'pending' },
  { taskId: 4, title: '滚吧', artist: '崔健', status: 'error' },
];

test('状态维度与原语义一致：active 含 downloading+pending', async () => {
  const { applyQueueFilter } = await fresh();
  assert.deepEqual(applyQueueFilter(Q(), 'active', '').map(s => s.taskId), [2, 3]);
  assert.deepEqual(applyQueueFilter(Q(), 'done', '').map(s => s.taskId), [1]);
  assert.deepEqual(applyQueueFilter(Q(), 'error', '').map(s => s.taskId), [4]);
  assert.equal(applyQueueFilter(Q(), 'all', '').length, 4);
});

test('关键词维度：歌名或歌手命中，不区分大小写', async () => {
  const { applyQueueFilter } = await fresh();
  assert.deepEqual(applyQueueFilter(Q(), 'all', 'hello').map(s => s.taskId), [2, 3]);
  assert.deepEqual(applyQueueFilter(Q(), 'all', '朴树').map(s => s.taskId), [1]);
});

test('AND 叠加：状态 × 关键词', async () => {
  const { applyQueueFilter } = await fresh();
  assert.deepEqual(applyQueueFilter(Q(), 'active', 'hello').map(s => s.taskId), [2, 3]);
  assert.deepEqual(applyQueueFilter(Q(), 'done', 'hello').map(s => s.taskId), []);
});

test('关键词 trim 与全空白等于不过滤', async () => {
  const { applyQueueFilter } = await fresh();
  assert.equal(applyQueueFilter(Q(), 'all', '  平凡  ').length, 1);
  assert.equal(applyQueueFilter(Q(), 'all', '   ').length, 4);
  assert.equal(applyQueueFilter(Q(), 'all', undefined).length, 4);
});

test('脏输入兜底：非数组/空行/缺字段不炸', async () => {
  const { applyQueueFilter } = await fresh();
  assert.deepEqual(applyQueueFilter(null, 'all', ''), []);
  assert.deepEqual(applyQueueFilter([null, { status: 'done' }], 'all', 'x'), []);
  assert.deepEqual(applyQueueFilter([{ taskId: 9, status: 'done' }], 'all', '').map(s => s.taskId), [9]);
});
