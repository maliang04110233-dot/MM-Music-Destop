'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { nextSpeed, DEFAULT_WINDOW_MS } = require('../src/main/speedMeter');

const MB = 1024 * 1024;

test('首次采样只建立基线，速度为 0', () => {
  const r = nextSpeed(null, 1000, 5 * MB, 20 * MB);
  assert.strictEqual(r.speedBps, 0);
  assert.strictEqual(r.etaSec, null);
  assert.deepStrictEqual(r.state, { baseT: 1000, baseB: 5 * MB, speed: 0 });
});

test('窗口内复用上次速度，不重算', () => {
  const s = nextSpeed(null, 0, 0, 10 * MB).state;
  const r1 = nextSpeed(s, DEFAULT_WINDOW_MS, 3 * MB, 10 * MB);
  assert.ok(Math.abs(r1.speedBps - (3 * MB) / (DEFAULT_WINDOW_MS / 1000)) < 1);
  const r2 = nextSpeed(r1.state, DEFAULT_WINDOW_MS + 500, 4 * MB, 10 * MB);
  assert.strictEqual(r2.speedBps, r1.speedBps);
  assert.strictEqual(r2.state, r1.state); // 状态对象原样返回
});

test('窗口滚动后重算速度并滚动基线', () => {
  let { state } = nextSpeed(null, 0, 0, 10 * MB);
  ({ state } = nextSpeed(state, 2000, 2 * MB, 10 * MB)); // 1MB/s
  const r = nextSpeed(state, 4000, 5 * MB, 10 * MB);    // 窗口 2s，3MB → 1.5MB/s
  assert.ok(Math.abs(r.speedBps - 1.5 * MB) < 2);
  assert.strictEqual(r.state.baseT, 4000);
  assert.strictEqual(r.state.baseB, 5 * MB);
});

test('ETA = 剩余字节 / 速度（向上取整），下载完为 0', () => {
  const { state } = nextSpeed(null, 0, 0, 10 * MB);
  const r = nextSpeed(state, 2000, 2 * MB, 10 * MB); // 1MB/s，剩 8MB
  assert.strictEqual(r.etaSec, 8);
  const r2 = nextSpeed(r.state, 4000, 10 * MB, 10 * MB);
  assert.strictEqual(r2.etaSec, 0);
});

test('总大小未知（0/NaN）→ etaSec null，速度照常', () => {
  const { state } = nextSpeed(null, 0, 0, 0);
  const r = nextSpeed(state, 2000, 2 * MB, NaN);
  assert.ok(r.speedBps > 0);
  assert.strictEqual(r.etaSec, null);
});

test('字节回退（重试/重新计数）速度钳到 0，不为负', () => {
  const { state } = nextSpeed(null, 0, 5 * MB, 10 * MB);
  const r = nextSpeed(state, 2000, 1 * MB, 10 * MB);
  assert.strictEqual(r.speedBps, 0);
});

test('非法输入（NaN/负数/undefined nowMs）安全处理', () => {
  const r = nextSpeed(null, undefined, NaN, -3);
  assert.strictEqual(r.speedBps, 0);
  assert.strictEqual(r.etaSec, null);
  assert.strictEqual(r.state.baseB, 0);
});

test('停滞检测：窗口滚动但零新增 → 速度 0，ETA 未知', () => {
  const { state } = nextSpeed(null, 0, 3 * MB, 10 * MB);
  const r = nextSpeed(state, 2000, 3 * MB, 10 * MB);
  assert.strictEqual(r.speedBps, 0);
  assert.strictEqual(r.etaSec, null);
});
