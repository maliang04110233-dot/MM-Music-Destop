/**
 * sourceHealth 单元测试（P2 源可用性探针）
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const sourceHealth = require(path.join(__dirname, '..', 'src', 'utils', 'sourceHealth'));

function reset() {
  sourceHealth._resetForTest();
}

test('recordResult: 记录成败并计算分数', () => {
  reset();
  assert.strictEqual(sourceHealth.getHealthScore('netease'), 1, '无数据默认乐观 1');

  sourceHealth.recordResult('netease', true);
  sourceHealth.recordResult('netease', true);
  sourceHealth.recordResult('netease', false);
  assert.strictEqual(sourceHealth.getHealthScore('netease'), 2 / 3);
  assert.strictEqual(sourceHealth.getSampleCount('netease'), 3);
});

test('recordResult: 滑动窗口只保留最近 WINDOW 次', () => {
  reset();
  const W = sourceHealth.WINDOW;
  // 先压满 W 个失败，再补 1 个成功：窗口滑走一个失败
  for (let i = 0; i < W; i++) sourceHealth.recordResult('qq', false);
  sourceHealth.recordResult('qq', true);
  assert.strictEqual(sourceHealth.getSampleCount('qq'), W);
  assert.strictEqual(sourceHealth.getHealthScore('qq'), 1 / W);
});

test('getHealthMap: 快照含样本数与分数', () => {
  reset();
  sourceHealth.recordResult('kugou', true);
  const m = sourceHealth.getHealthMap(['kugou', 'bilibili']);
  assert.strictEqual(m.kugou.score, 1);
  assert.strictEqual(m.kugou.samples, 1);
  // 无数据源：score=null 而非 1（UI 需区分"未知"与"全成"）
  assert.strictEqual(m.bilibili.score, null);
  assert.strictEqual(m.bilibili.samples, 0);
});

test('rankByHealth: 健康源排前，同分保持原序（稳定）', () => {
  reset();
  // netease 全败，qq 全成，kugou 无记录（默认乐观 1）
  for (let i = 0; i < 5; i++) sourceHealth.recordResult('netease', false);
  for (let i = 0; i < 5; i++) sourceHealth.recordResult('qq', true);
  const items = [
    { source: 'netease', name: 'a' },
    { source: 'kugou', name: 'b' },
    { source: 'qq', name: 'c' },
    { source: 'kugou', name: 'd' },
    { source: 'netease', name: 'e' },
  ];
  const ranked = sourceHealth.rankByHealth(items);
  // 分数降序：kugou(1.0 默认) 与 qq(1.0) 在前（原序 b<d），netease(0.0) 殿后。
  // 稳定排序只保证同分项相对顺序，不保证同分组连续——断言逐对非升即可。
  const scores = ranked.map(x => sourceHealth.getHealthScore(x.source));
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] >= scores[i], '健康度必须降序');
  }
  assert.strictEqual(ranked[ranked.length - 1].name, 'e');
  assert.strictEqual(ranked[ranked.length - 2].name, 'a');
  const kugouIdx = ranked.findIndex(x => x.name === 'b');
  const kugouIdx2 = ranked.findIndex(x => x.name === 'd');
  assert.ok(kugouIdx < kugouIdx2, '同源候选保持原有相对顺序');
});

test('rankByHealth: 空数组与单元素', () => {
  reset();
  assert.deepStrictEqual(sourceHealth.rankByHealth([]), []);
  const single = [{ source: 'netease', name: 'x' }];
  assert.deepStrictEqual(sourceHealth.rankByHealth(single), single);
});
