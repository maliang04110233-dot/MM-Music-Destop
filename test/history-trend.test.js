/**
 * 单元测试：historyTrend.js —— 下载趋势的按天分桶 / 汇总 / 柱高
 *
 * 全部为纯函数；用固定的本地时间构造样例，避免依赖运行机时时区。
 */

const test = require('node:test');
const assert = require('node:assert');

async function fresh() {
  return import(`../src/renderer/js/historyTrend.js?ck=${Math.random()}`);
}

const NOW = new Date(2026, 8, 19, 12, 0, 0).getTime(); // 本地 2026-09-19 中午
const day = (d, h = 9) => new Date(2026, 8, d, h).getTime();
const done = (t, size = 1) => ({ status: 'done', finishedAt: t, size });

test('bucketHistoryByDay: 窗口内按天计数，窗口外/未来/非 done/无效时间被剔除', async () => {
  const { bucketHistoryByDay } = await fresh();
  const items = [
    done(day(19), 10),                                    // 今天
    done(day(18), 5), done(day(18, 23), 5),               // 昨天两条（深夜也算昨天）
    done(day(6), 1),                                      // 13 天前 → 窗口最老一桶
    done(day(5), 1),                                      // 14 天前 → 出窗
    done(day(20), 1),                                     // 未来 → 剔除
    { status: 'error', finishedAt: day(18), size: 9 },    // 非 done
    { status: 'done', finishedAt: 0, size: 9 },           // 无效时间戳
    null,
  ];
  const buckets = bucketHistoryByDay(items, NOW, 14);
  assert.equal(buckets.length, 14);
  assert.equal(buckets[13].label, '9/19');
  assert.equal(buckets[13].count, 1);
  assert.equal(buckets[13].bytes, 10);
  assert.equal(buckets[12].count, 2);
  assert.equal(buckets[12].bytes, 10);
  assert.equal(buckets[0].label, '9/6');
  assert.equal(buckets[0].count, 1);
  assert.equal(buckets.reduce((a, b) => a + b.count, 0), 4);
});

test('trendSummary: 总量 / 活跃天数 / 峰值日', async () => {
  const { bucketHistoryByDay, trendSummary } = await fresh();
  const buckets = bucketHistoryByDay(
    [done(day(19)), done(day(18)), done(day(18)), done(day(6), 40)], NOW, 14);
  const s = trendSummary(buckets);
  assert.equal(s.count, 4);
  assert.equal(s.bytes, 43);
  assert.equal(s.activeDays, 3);
  assert.equal(s.peakLabel, '9/18');
  assert.equal(s.peakCount, 2);
  const empty = trendSummary(bucketHistoryByDay([], NOW, 3));
  assert.equal(empty.count, 0);
  assert.equal(empty.peakLabel, null);
});

test('barPct: 满格 100、非零柱最低 8、零柱与非法 max 返回 0', async () => {
  const { barPct } = await fresh();
  assert.equal(barPct(10, 10), 100);
  assert.equal(barPct(2, 10), 20);
  assert.equal(barPct(1, 100), 8);
  assert.equal(barPct(0, 10), 0);
  assert.equal(barPct(5, 0), 0);
  assert.equal(barPct(5, null), 0);
});

test('bucketHistoryByDay: 空输入与非法 days 兜底', async () => {
  const { bucketHistoryByDay, TREND_DAYS } = await fresh();
  assert.equal(bucketHistoryByDay(null, NOW, 3).length, 3);
  assert.equal(bucketHistoryByDay(undefined, NOW).length, TREND_DAYS);
  const b = bucketHistoryByDay([], NOW, 0); // days<=0 → 回退 14
  assert.equal(b.length, TREND_DAYS);
  assert.ok(b.every((x) => x.count === 0 && x.bytes === 0));
  assert.match(b[b.length - 1].key, /^2026-09-19$/);
});
