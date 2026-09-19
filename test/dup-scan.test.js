'use strict';
// 内容级查重纯逻辑（src/utils/dupScan.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SLICE_BYTES, bucketBySize, slicePlan, groupByHash, dupGroupView, wastedBytes,
} = require('../src/utils/dupScan.js');

test('bucketBySize：只保留 ≥2 文件的桶，脏条目剔除', () => {
  const files = [
    { filePath: 'a.mp3', fileSize: 100 },
    { filePath: 'b.mp3', fileSize: 100 },
    { filePath: 'c.mp3', fileSize: 200 },
    { filePath: 'd.mp3', fileSize: 0 },
    { filePath: 'e.mp3' },
    null,
  ];
  const buckets = bucketBySize(files);
  assert.equal(buckets.length, 1);
  assert.deepEqual(buckets[0].map(f => f.filePath), ['a.mp3', 'b.mp3']);
  assert.deepEqual(bucketBySize(null), []);
  assert.deepEqual(bucketBySize([]), []);
});

test('slicePlan：小文件整读，大文件头尾各 window，互不重叠', () => {
  assert.deepEqual(slicePlan(0), []);
  assert.deepEqual(slicePlan(-5), []);
  assert.deepEqual(slicePlan(NaN), []);
  // 恰好 2*window → 整读一段（不产生重复读）
  assert.deepEqual(slicePlan(SLICE_BYTES * 2), [{ start: 0, end: SLICE_BYTES * 2 }]);
  const big = slicePlan(1000000);
  assert.equal(big.length, 2);
  assert.deepEqual(big[0], { start: 0, end: SLICE_BYTES });
  assert.deepEqual(big[1], { start: 1000000 - SLICE_BYTES, end: 1000000 });
  assert.ok(big[0].end <= big[1].start, '头尾切片不得重叠');
  // 自定义 window 形参
  assert.deepEqual(slicePlan(10, 4), [{ start: 0, end: 4 }, { start: 6, end: 10 }]);
});

test('groupByHash：(大小,hash) 相同才成组，按可释放体积降序', () => {
  const files = [
    { filePath: 'x1', fileSize: 500, hash: 'h1' },
    { filePath: 'x2', fileSize: 500, hash: 'h1' },
    { filePath: 'y1', fileSize: 900, hash: 'h2' },
    { filePath: 'y2', fileSize: 900, hash: 'h2' },
    { filePath: 'y3', fileSize: 900, hash: 'h2' },
    { filePath: 'z1', fileSize: 500, hash: 'h9' }, // 大小同哈希不同 → 不成组
    { filePath: 'w1', fileSize: 700, hash: 'h1' }, // 哈希同大小不同 → 不成组
    { filePath: 'bad', fileSize: 1 },              // 无 hash → 剔除
  ];
  const groups = groupByHash(files);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map(f => f.filePath), ['y1', 'y2', 'y3']); // 900*2 > 500*1
  assert.deepEqual(groups[1].map(f => f.filePath), ['x1', 'x2']);
  assert.deepEqual(groupByHash(null), []);
});

test('dupGroupView：路径字典序稳定排第一份为保留位，字段贴合查重弹层', () => {
  const files = [
    { filePath: 'D:\\Music\\zzz - 翻唱.mp3', fileSize: 123, hash: 'h' },
    { filePath: 'D:\\Music\\aaa - 原版.mp3', fileSize: 123, hash: 'h' },
  ];
  const view = dupGroupView(files);
  assert.equal(view.length, 2);
  assert.ok(view[0].title.startsWith('aaa'), '字典序小的排前作为保留位');
  assert.equal(view[0].fileSize, 123);
  assert.equal(view[0].ext, 'mp3');
  assert.ok(view[1].title.startsWith('zzz'));
  // 输入数组不被排序污染
  assert.equal(files[0].filePath.includes('zzz'), true);
});

test('wastedBytes：每组保留 1 份后其余体积之和', () => {
  const groups = [
    [{ fileSize: 100 }, { fileSize: 100 }, { fileSize: 100 }], // 200
    [{ fileSize: 50 }, { fileSize: 50 }],                       // 50
  ];
  assert.equal(wastedBytes(groups), 250);
  assert.equal(wastedBytes([]), 0);
  assert.equal(wastedBytes(null), 0);
});
