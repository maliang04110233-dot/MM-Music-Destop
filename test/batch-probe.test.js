/**
 * batchProbe 单元测试：目标收集去重 / 顺序扫描 runner / 汇总与报告文案
 */
const test = require('node:test');
const assert = require('node:assert');

async function fresh() {
  return import(`../src/renderer/js/batchProbe.js?ck=${Math.random()}`);
}

test('collectProbeTargets：按 filePath 去重、跳过已缓存、忽略畸形条目', async () => {
  const { collectProbeTargets } = await fresh();
  const songs = [
    { filePath: 'a.mp3', title: 'A' },
    { filePath: 'a.mp3', title: 'A 重复' },
    { filePath: 'b.flac', title: 'B' },
    null,
    { title: '无路径' },
    { filePath: '', title: '空路径' },
    { filePath: 'c.flac', title: 'C' },
  ];
  const cached = new Set(['b.flac']);
  const { targets, cached: n } = collectProbeTargets(songs, cached);
  assert.deepStrictEqual(targets.map(s => s.filePath), ['a.mp3', 'c.flac']);
  assert.strictEqual(n, 1);
  const empty = collectProbeTargets(undefined, undefined);
  assert.deepStrictEqual(empty.targets, []);
  assert.strictEqual(empty.cached, 0);
});

test('runSequentialScan：顺序执行、异常收纳、进度回调、可取消', async () => {
  const { runSequentialScan } = await fresh();
  const order = [];
  const progress = [];
  const items = [1, 2, 3];
  const r1 = await runSequentialScan({
    items,
    worker: async (n) => { order.push(n); if (n === 2) throw new Error('boom'); return { ok: true, verdict: 'lossless' }; },
    onProgress: (done, total, res) => progress.push({ done, total, ok: res.ok }),
  });
  assert.deepStrictEqual(order, [1, 2, 3]); // 严格顺序
  assert.strictEqual(r1.cancelled, false);
  assert.strictEqual(r1.results.length, 3);
  assert.strictEqual(r1.results[1].ok, false); // 异常 → {ok:false}（实际是抛错被收纳：verdict 缺、error 有）
  assert.match(r1.results[1].error, /boom/);
  assert.deepStrictEqual(progress, [
    { done: 1, total: 3, ok: true },
    { done: 2, total: 3, ok: false },
    { done: 3, total: 3, ok: true },
  ]);

  let stops = 0;
  const r2 = await runSequentialScan({
    items: [10, 20, 30, 40],
    worker: async (n) => { stops = n; return { ok: true }; },
    isCancelled: () => stops >= 20, // 第 2 项跑完后，第 3 项前取消
  });
  assert.strictEqual(r2.cancelled, true);
  assert.strictEqual(r2.results.length, 2);
  assert.strictEqual(stops, 20);

  const r3 = await runSequentialScan({
    items: [1],
    worker: async () => ({ ok: true }),
    onProgress: () => { throw new Error('回调炸了'); },
  });
  assert.strictEqual(r3.results.length, 1); // 进度回调异常不中断扫描
});

test('summarizeProbe：四类计数，缺 ok 或非 true 全算失败', async () => {
  const { summarizeProbe } = await fresh();
  const s = summarizeProbe([
    { ok: true, verdict: 'lossless' },
    { ok: true, verdict: 'suspicious' },
    { ok: true, verdict: 'lossy' },
    { ok: true, verdict: 'unknown-verdict' },
    { ok: false, error: 'x' },
    { error: '无 ok 字段' },
    null,
  ]);
  assert.deepStrictEqual(s, { total: 7, lossless: 1, suspicious: 1, lossy: 1, failed: 4 });
  assert.deepStrictEqual(summarizeProbe([]), { total: 0, lossless: 0, suspicious: 0, lossy: 0, failed: 0 });
});

test('probeReportLine：三档必出、失败按需追加、取消带后缀', async () => {
  const { probeReportLine } = await fresh();
  const line = probeReportLine({ lossless: 3, suspicious: 1, lossy: 2, failed: 0 }, false);
  assert.strictEqual(line, '音质扫描：✅ 真无损 3 · ⚠️ 存疑 1 · ❌ 有损 2');
  const line2 = probeReportLine({ lossless: 0, suspicious: 0, lossy: 0, failed: 4 }, true);
  assert.ok(line2.includes('💥 失败 4') && line2.endsWith('（已取消，未扫完）'), line2);
});
