'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { queueMove } = require('../src/main/queueOrder');

const q = (...statuses) => statuses.map((s, i) => ({ taskId: `t${i}`, status: s }));
const ids = list => list.map(s => s.taskId).join(',');

test('up：与上一个 pending 交换位置', () => {
  const list = q('pending', 'pending', 'pending');
  assert.strictEqual(queueMove(list, 't2', 'up'), true);
  assert.strictEqual(ids(list), 't0,t2,t1');
});

test('up：跳过非 pending（只与最近的 pending 交换）', () => {
  const list = q('pending', 'done', 'pending');
  assert.strictEqual(queueMove(list, 't2', 'up'), true);
  assert.strictEqual(ids(list), 't2,t1,t0');
});

test('up：最前的 pending 无法再上移', () => {
  const list = q('downloading', 'pending', 'pending');
  assert.strictEqual(queueMove(list, 't1', 'up'), false);
  assert.strictEqual(ids(list), 't0,t1,t2');
});

test('down：与下一个 pending 交换位置', () => {
  const list = q('pending', 'pending', 'pending');
  assert.strictEqual(queueMove(list, 't0', 'down'), true);
  assert.strictEqual(ids(list), 't1,t0,t2');
});

test('down：最后的 pending 无法再下移', () => {
  const list = q('pending', 'pending', 'done');
  assert.strictEqual(queueMove(list, 't1', 'down'), false);
});

test('top：移动到首个 pending 位置，不扰动 downloading', () => {
  const list = q('done', 'downloading', 'pending', 'pending', 'pending');
  assert.strictEqual(queueMove(list, 't4', 'top'), true);
  assert.strictEqual(ids(list), 't0,t1,t4,t2,t3');
});

test('top：已是队首 pending 时返回 false', () => {
  const list = q('downloading', 'pending', 'pending');
  assert.strictEqual(queueMove(list, 't1', 'top'), false);
});

test('非 pending 状态一律不可移动', () => {
  for (const st of ['downloading', 'done', 'error']) {
    const list = q('pending', st, 'pending');
    assert.strictEqual(queueMove(list, 't1', 'up'), false, st + ' up');
    assert.strictEqual(queueMove(list, 't1', 'down'), false, st + ' down');
    assert.strictEqual(queueMove(list, 't1', 'top'), false, st + ' top');
  }
});

test('任务不存在 / 非法 action / 非法列表：安全返回 false', () => {
  const list = q('pending', 'pending');
  assert.strictEqual(queueMove(list, 'nope', 'up'), false);
  assert.strictEqual(queueMove(list, 't0', 'side'), false);
  assert.strictEqual(queueMove(list, 't0', undefined), false);
  assert.strictEqual(queueMove(null, 't0', 'up'), false);
  assert.strictEqual(queueMove([], 't0', 'top'), false);
});

test('空洞元素（null 项）不导致崩溃', () => {
  const list = [null, { taskId: 't1', status: 'pending' }, { taskId: 't2', status: 'pending' }];
  assert.strictEqual(queueMove(list, 't2', 'up'), true);
  assert.strictEqual(list[1].taskId, 't2');
});

test('只交换目标两项，其余元素引用不变', () => {
  const a = { taskId: 'a', status: 'pending', progress: 7 };
  const b = { taskId: 'b', status: 'pending', progress: 9 };
  const list = [a, b];
  assert.strictEqual(queueMove(list, 'b', 'up'), true);
  assert.strictEqual(list[0], b);
  assert.strictEqual(list[1], a);
  assert.strictEqual(a.progress, 7);
});
