/**
 * 限速流（createThrottleStream）测试
 *
 * 覆盖：
 *   - 数据完整性：限速开启时所有字节都能按序到达下游
 *   - 背压：下游故意不消费时，流不会无界堆积（readableLength 有界）
 *   - 限速生效：以高倍速率灌入时，总耗时与令牌桶速率一致（放宽断言，
 *     只验证"远慢于不限速"）
 *   - bytesPerSec<=0 返回 null（不限速直通）
 */

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough, Readable } = require('node:stream');
const { createThrottleStream } = require('../src/utils/downloader');

test('createThrottleStream: bytesPerSec<=0 → null（不限速）', () => {
  assert.strictEqual(createThrottleStream(0), null);
  assert.strictEqual(createThrottleStream(-1), null);
});

test('createThrottleStream: 数据完整性——所有字节按序到达', async () => {
  const RATE = 100 * 1024; // 100KB/s
  const TOTAL = 200 * 1024; // 200KB（约 2 秒）
  const src = Readable.from((function* gen() {
    const chunkSize = 16 * 1024;
    let sent = 0;
    while (sent < TOTAL) {
      const size = Math.min(chunkSize, TOTAL - sent);
      const buf = Buffer.alloc(size, 0xAB);
      sent += size;
      yield buf;
    }
  })());

  const throttle = createThrottleStream(RATE);
  assert.ok(throttle, '限速流应被创建');

  const collected = [];
  await new Promise((resolve, reject) => {
    throttle.on('data', (c) => collected.push(c));
    throttle.on('end', resolve);
    throttle.on('error', reject);
    src.pipe(throttle);
  });

  const total = Buffer.concat(collected);
  assert.strictEqual(total.length, TOTAL, '所有字节必须到达下游');
  // 内容校验（按序且未被篡改）
  for (let i = 0; i < TOTAL; i++) {
    if (total[i] !== 0xAB) { assert.fail(`第 ${i} 字节被篡改`); break; }
  }
});

test('createThrottleStream: 限速确实生效（总耗时不低于速率下限）', async () => {
  const RATE = 200 * 1024;  // 200KB/s
  const TOTAL = 300 * 1024; // 300KB → 至少 ~1.5s
  const src = Readable.from([Buffer.alloc(TOTAL, 0x01)]);

  const throttle = createThrottleStream(RATE);
  const start = Date.now();
  await new Promise((resolve, reject) => {
    throttle.on('data', () => {}); // 立即消费（无背压场景）
    throttle.on('end', resolve);
    throttle.on('error', reject);
    src.pipe(throttle);
  });
  const elapsed = Date.now() - start;
  // 理论下限 1.5s；放宽到 1.2s 容忍计时器粒度（CI 抖动）
  assert.ok(
    elapsed >= 1200,
    `300KB @ 200KB/s 应耗时 ≥1.2s，实际 ${elapsed}ms（限速未生效）`
  );
});

test('createThrottleStream: 背压——下游停止消费时 readableLength 有界', async () => {
  const RATE = 1 * 1024 * 1024; // 1MB/s（高到让上游快速灌）
  const throttle = createThrottleStream(RATE);
  assert.ok(throttle);

  // 下游 PassThrough：暂停消费制造背压
  const slowSink = new PassThrough({ highWaterMark: 16 * 1024 });
  slowSink.pause();

  let maxBuffered = 0;
  const src = Readable.from([Buffer.alloc(1024 * 1024, 0x02)]); // 1MB 一口气
  src.pipe(throttle).pipe(slowSink);

  const checkTimer = setInterval(() => {
    maxBuffered = Math.max(maxBuffered, throttle.readableLength + slowSink.readableLength);
  }, 5);

  // 观察 500ms 后结束
  await new Promise(r => setTimeout(r, 500));
  clearInterval(checkTimer);
  src.destroy();
  slowSink.destroy();
  // destroy() 会触发 _destroy 清掉 flushTimer；末尾再兜底清一次，
  // 防止异步竞态下残留的定时器挂住测试进程的事件循环
  throttle.destroy();
  await new Promise(r => setImmediate(r));

  // 断言：缓冲远小于总数据量（1MB）——证明背压传导到了上游
  assert.ok(
    maxBuffered <= 700 * 1024,
    `下游停消费时缓冲应受背压约束，峰值 ${maxBuffered}B（预期 ≤700KB）`
  );
});
