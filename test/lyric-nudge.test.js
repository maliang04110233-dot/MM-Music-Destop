/**
 * lyricNudge.js 守护测试 — 歌词偏移快捷微调纯逻辑
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function fresh() {
  return import(`../src/renderer/js/lyricNudge.js?ck=${Math.random()}`);
}

test('clampOffsetSum：步进累加与上下限钳制', async () => {
  const { clampOffsetSum, OFFSET_MIN, OFFSET_MAX } = await fresh();
  assert.equal(clampOffsetSum(0, 500), 500);
  assert.equal(clampOffsetSum(500, -500), 0);
  assert.equal(clampOffsetSum(1800, 500), OFFSET_MAX); // 2300 → 钳到 2000
  assert.equal(clampOffsetSum(-1800, -500), OFFSET_MIN);
  assert.equal(clampOffsetSum(OFFSET_MAX, 500), OFFSET_MAX); // 已在顶仍停留
});

test('clampOffsetSum：非法输入按 0 处理', async () => {
  const { clampOffsetSum } = await fresh();
  assert.equal(clampOffsetSum(undefined, 500), 500);
  assert.equal(clampOffsetSum(NaN, NaN), 0);
  assert.equal(clampOffsetSum('300', '200'), 500); // 数字字符串可用
  assert.equal(clampOffsetSum('abc', 500), 500);
});

test('fmtSignedMs：正数带加号、负数原样、0 不带符号', async () => {
  const { fmtSignedMs } = await fresh();
  assert.equal(fmtSignedMs(500), '+500ms');
  assert.equal(fmtSignedMs(-1000), '-1000ms');
  assert.equal(fmtSignedMs(0), '0ms');
  assert.equal(fmtSignedMs(undefined), '0ms');
});

test('setOffset 超程钳制不抛错（无 DOM/无 api 环境）', async () => {
  const { setOffset } = await fresh();
  assert.equal(setOffset(9999), 2000);
  assert.equal(setOffset(-9999), -2000);
});
