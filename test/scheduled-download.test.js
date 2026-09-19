/**
 * scheduledDownload 单元测试：parseScheduleAt/dueItems/sortJobs/fmtJobTime 纯函数
 */
const test = require('node:test');
const assert = require('node:assert');

// 模块及其依赖（batchImport/logger）顶层用 window 桥接
global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import(`../src/renderer/js/scheduledDownload.js?sd=${Math.random()}`);
}

test('parseScheduleAt：未来 30 天内合法，过去/超远/垃圾输入返回 null', async () => {
  const { parseScheduleAt } = await fresh();
  const now = new Date('2026-09-19T12:00:00').getTime();
  const ok = parseScheduleAt('2026-09-19T23:30', now);
  assert.strictEqual(ok, new Date('2026-09-19T23:30:00').getTime());
  assert.strictEqual(parseScheduleAt('2026-09-19T11:59', now), null); // 过去
  assert.strictEqual(parseScheduleAt('2026-09-19T12:00', now), null); // 恰好等于 now 也不收
  assert.strictEqual(parseScheduleAt('2026-10-20T00:00', now), null); // 超 30 天
  assert.strictEqual(parseScheduleAt('', now), null);
  assert.strictEqual(parseScheduleAt('昨天下午', now), null);
  assert.strictEqual(parseScheduleAt(null, now), null);
});

test('dueItems：at<=now 即到期（含错过补跑），脏条目静默忽略', async () => {
  const { dueItems } = await fresh();
  const jobs = [
    { id: 'a', at: 100, lines: ['x'] },
    { id: 'b', at: 250, lines: ['y'] },
    { id: 'c' },
    null,
    { id: 'd', at: 'oops', lines: [] },
  ];
  assert.deepStrictEqual(dueItems(jobs, 200).map(j => j.id), ['a']);
  assert.deepStrictEqual(dueItems(jobs, 1000).map(j => j.id), ['a', 'b']); // 过期未跑的都在
  assert.deepStrictEqual(dueItems(null, 1000), []);
});

test('sortJobs：按时间升序且不改原数组', async () => {
  const { sortJobs } = await fresh();
  const jobs = [{ id: 'b', at: 200 }, { id: 'a', at: 100 }, { id: 'c', at: 150 }];
  assert.deepStrictEqual(sortJobs(jobs).map(j => j.id), ['a', 'c', 'b']);
  assert.strictEqual(jobs[0].id, 'b');
});

test('fmtJobTime：MM-DD HH:mm 本地时间补零', async () => {
  const { fmtJobTime } = await fresh();
  const at = new Date(2026, 8, 9, 7, 5).getTime(); // 2026-09-09 07:05 本地
  assert.strictEqual(fmtJobTime(at), '09-09 07:05');
});

test('多个到期任务按时间先后顺序补跑（跨重启错过场景）', async () => {
  const { dueItems, sortJobs } = await fresh();
  const jobs = [
    { id: 'late', at: 300, lines: [] },
    { id: 'earliest', at: 100, lines: [] },
    { id: 'future', at: 900, lines: [] },
    { id: 'mid', at: 200, lines: [] },
  ];
  const order = sortJobs(dueItems(jobs, 500)).map(j => j.id);
  assert.deepStrictEqual(order, ['earliest', 'mid', 'late']);
});
