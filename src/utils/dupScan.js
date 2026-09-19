'use strict';
/**
 * 内容级查重纯逻辑（node 可单测，无 electron 依赖）
 *
 * 与 local-stats.js 的元数据查重互补：这里按文件字节找「完全相同的副本」——
 * 改名、换目录、标签被编辑过都能抓到；同名不同内容则不会误报。
 * 流程：bucketBySize 粗筛 → 调用方按 slicePlan 读头尾切片算 hash →
 * groupByHash 收拢 (大小,hash) 相同者 → dupGroupView 转成查重弹层的行形态。
 */

const path = require('path');

const SLICE_BYTES = 64 * 1024;

/** 按 fileSize 分桶，只保留 ≥2 个文件的桶（单文件桶不可能有字节级重复） */
function bucketBySize(files) {
  const map = new Map();
  for (const f of files || []) {
    if (!f || !f.filePath || !Number.isFinite(f.fileSize) || f.fileSize <= 0) continue;
    if (!map.has(f.fileSize)) map.set(f.fileSize, []);
    map.get(f.fileSize).push(f);
  }
  return [...map.values()].filter(b => b.length > 1);
}

/**
 * 读哪几段字节做哈希：小文件整读；大文件头+尾各 window。
 * 大小相同 + 头尾切片相同 → 认定重复（漏判尾部中段被改的极端场景，
 * 换来实现不必整读几十 MB 的无损文件）。
 */
function slicePlan(size, window = SLICE_BYTES) {
  if (!Number.isFinite(size) || size <= 0) return [];
  if (size <= window * 2) return [{ start: 0, end: size }];
  return [
    { start: 0, end: window },
    { start: size - window, end: size },
  ];
}

/** 把 (fileSize, hash) 都相同的文件收进同一组，按可释放体积降序 */
function groupByHash(files) {
  const map = new Map();
  for (const f of files || []) {
    if (!f || !f.hash) continue;
    const key = `${f.fileSize}:${f.hash}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  return [...map.values()]
    .filter(g => g.length > 1)
    .sort((a, b) => (b[0].fileSize * (b.length - 1)) - (a[0].fileSize * (a.length - 1)));
}

/**
 * 转成 local-stats.js dupModal 的行形态（title/artist/ext/fileSize），
 * 路径字典序排列 → 每组第一条（保留位）确定且跨次扫描稳定。
 */
function dupGroupView(files) {
  return [...files]
    .sort((a, b) => String(a.filePath).localeCompare(String(b.filePath), 'en'))
    .map(f => {
      const base = path.basename(f.filePath);
      return {
        filePath: f.filePath,
        fileSize: f.fileSize,
        title: base,
        artist: path.dirname(f.filePath),
        ext: path.extname(base).replace(/^\./, ''),
      };
    });
}

/** 每组保留 1 份后其余的体积总和 = 可释放空间 */
function wastedBytes(groups) {
  let sum = 0;
  for (const g of groups || []) {
    if (g.length > 1) sum += (g.length - 1) * (g[0].fileSize || 0);
  }
  return sum;
}

module.exports = { SLICE_BYTES, bucketBySize, slicePlan, groupByHash, dupGroupView, wastedBytes };
