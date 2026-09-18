import test from 'node:test';
import assert from 'node:assert/strict';

const ds = import('../src/main/diskSpace.js');

test('estimateSongBytes：三档音质各有保守估算，未知音质回落高品质档', async () => {
  const { estimateSongBytes } = await ds;
  const MB = 1024 * 1024;
  assert.ok(estimateSongBytes('standard') < estimateSongBytes('hq'));
  assert.ok(estimateSongBytes('hq') < estimateSongBytes('lossless'));
  assert.equal(estimateSongBytes(undefined), 25 * MB);
  assert.equal(estimateSongBytes('nonsense'), 25 * MB);
});

test('availFromStatfs：bsize×bavail；bavail 缺失退 bfree；异常入参给 0', async () => {
  const { availFromStatfs } = await ds;
  assert.equal(availFromStatfs({ bsize: 4096, bavail: 1000, bfree: 9999 }), 4096000);
  assert.equal(availFromStatfs({ bsize: 4096, bfree: 500 }), 4096 * 500);
  assert.equal(availFromStatfs(null), 0);
  assert.equal(availFromStatfs({ bsize: 0, bavail: 10 }), 0);
  assert.equal(availFromStatfs({ bsize: NaN, bavail: 10 }), 0);
  assert.equal(availFromStatfs({ bsize: -1, bavail: 10 }), 0);
});

test('availFromStatfs：BigInt 字段（Windows 大容量盘）可换算', async () => {
  const { availFromStatfs } = await ds;
  const st = { bsize: BigInt(4096), bavail: BigInt(1 << 20) };
  assert.equal(availFromStatfs(st), 4096 * (1 << 20));
});

test('diskVerdict：够用 ok；不足返回 avail+needed（阈值=估算+20MB 余量）', async () => {
  const { diskVerdict, estimateSongBytes } = await ds;
  const MB = 1024 * 1024;
  const enough = diskVerdict(estimateSongBytes('lossless') + 50 * MB, 'lossless');
  assert.equal(enough.ok, true);
  const tight = diskVerdict(5 * MB, 'lossless');
  assert.equal(tight.ok, false);
  assert.equal(tight.availBytes, 5 * MB);
  assert.equal(tight.neededBytes, estimateSongBytes('lossless') + 20 * MB);
  // 负数钳 0 → 必然不足
  assert.equal(diskVerdict(-10, 'standard').ok, false);
});

test('diskShortageMessage：ok 返回 null；不足含剩余/约需/重试指引与人话音质名', async () => {
  const { diskShortageMessage } = await ds;
  assert.equal(diskShortageMessage({ ok: true, availBytes: 123 }, 'hq'), null);
  const msg = diskShortageMessage({ ok: false, availBytes: 3 * 1024 * 1024, neededBytes: 120 * 1024 * 1024 }, 'lossless');
  assert.match(msg, /磁盘空间不足/);
  assert.match(msg, /仅剩约 3 MB/);
  assert.match(msg, /约需 120 MB/);
  assert.match(msg, /无损/);
  assert.match(msg, /重试/);
  // 未知音质透传原文
  assert.match(diskShortageMessage({ ok: false, availBytes: 0, neededBytes: 1 }, 'weird'), /weird/);
});
