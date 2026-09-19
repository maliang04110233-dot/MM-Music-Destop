/**
 * 播放淡入纯函数测试（增量66）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import(`../src/renderer/js/player/fade.js?ck=${Math.random()}`);

test('nextFadeMs 循环档位 关→0.5→1→2→关', async () => {
  const { nextFadeMs, FADE_STEPS } = await mod();
  assert.deepEqual(FADE_STEPS, [0, 500, 1000, 2000]);
  assert.equal(nextFadeMs(0), 500);
  assert.equal(nextFadeMs(500), 1000);
  assert.equal(nextFadeMs(1000), 2000);
  assert.equal(nextFadeMs(2000), 0);
  assert.equal(nextFadeMs('bad'), 500); // 未知值从关起
});

test('fadeStageLabel 文案', async () => {
  const { fadeStageLabel } = await mod();
  assert.equal(fadeStageLabel(0), '关');
  assert.equal(fadeStageLabel(500), '0.5s');
  assert.equal(fadeStageLabel(2000), '2s');
});

test('fadeVolumeAt 线性斜坡与钳制', async () => {
  const { fadeVolumeAt } = await mod();
  assert.equal(fadeVolumeAt(0.8, 0, 0, 1000), 0);
  assert.equal(fadeVolumeAt(0.8, 0, 500, 1000), 0.4);
  assert.equal(fadeVolumeAt(0.8, 0, 1000, 1000), 0.8);
  assert.equal(fadeVolumeAt(0.8, 0, 9999, 1000), 0.8);
  assert.equal(fadeVolumeAt(0.8, 0, -5, 1000), 0);
  assert.equal(fadeVolumeAt(0.8, 0, 3, 0), 0.8); // dur<=0 直接到位
});

test('shouldFadeIn：暂停恢复/新曲淡入，缓冲恢复（非暂停+已播放）不淡', async () => {
  const { shouldFadeIn } = await mod();
  assert.equal(shouldFadeIn(true, 120), true);
  assert.equal(shouldFadeIn(false, 0), true);
  assert.equal(shouldFadeIn(false, 0.5), true);
  assert.equal(shouldFadeIn(false, 120), false);
});
