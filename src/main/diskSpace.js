/**
 * 磁盘容量守护 —— 下载前的空间预检（纯函数，无 IO，便于单测）
 *
 * 场景：无损 FLAC 一首可达几十 MB，磁盘写满时下载器会留下一堆
 * 半截 .tmp 且报错信息是底层的 ENOSPC，用户难定位。这里在下载
 * 真正开始前用 statfs 余量对照「该音质的保守估算」，不足则让任务
 * 以明确文案失败（清理磁盘后可点 🔄 重试）。
 */

'use strict';

const MB = 1024 * 1024;

// 单首曲目的保守体积估算（按常见 4-6 分钟歌 + 冗余）
const ESTIMATE_BY_QUALITY = {
  standard: 10 * MB,   // 128k
  hq: 25 * MB,         // 320k
  lossless: 100 * MB,  // FLAC / 更高
};
const DEFAULT_ESTIMATE = 25 * MB;
// 判定阈值 = 估算 + 余量（文件系统元数据、并发任务写同盘等）
const SAFETY_MARGIN = 20 * MB;

function estimateSongBytes(quality) {
  return ESTIMATE_BY_QUALITY[quality] || DEFAULT_ESTIMATE;
}

/** statfs 结果 → 当前用户可用字节（BigInt 安全转数字；异常入参给 0） */
function availFromStatfs(st) {
  if (!st) return 0;
  const bsize = Number(st.bsize);
  const bavail = Number(st.bavail != null ? st.bavail : st.bfree);
  if (!Number.isFinite(bsize) || !Number.isFinite(bavail) || bsize <= 0) return 0;
  return Math.max(0, Math.floor(bsize * bavail));
}

/**
 * 空间是否够下一首 quality 的曲子。
 * @returns {{ok:true, availBytes:number}|{ok:false, availBytes:number, neededBytes:number}}
 */
function diskVerdict(availBytes, quality) {
  const avail = Number.isFinite(availBytes) ? Math.max(0, availBytes) : 0;
  const needed = estimateSongBytes(quality) + SAFETY_MARGIN;
  if (avail >= needed) return { ok: true, availBytes: avail };
  return { ok: false, availBytes: avail, neededBytes: needed };
}

function formatMB(bytes) {
  return (Math.max(0, Number(bytes) || 0) / MB).toFixed(0) + ' MB';
}

/** 生成给用户看的失败原因（ok 时返回 null） */
const QUALITY_LABEL = { standard: '标准', hq: '高品质', lossless: '无损' };
function diskShortageMessage(verdict, quality) {
  if (!verdict || verdict.ok) return null;
  const label = QUALITY_LABEL[quality] || quality || '高品质';
  return `磁盘空间不足：目标盘仅剩约 ${formatMB(verdict.availBytes)}，`
    + `下载「${label}」音质约需 ${formatMB(verdict.neededBytes)}，请清理后点重试`;
}

module.exports = {
  estimateSongBytes,
  availFromStatfs,
  diskVerdict,
  formatMB,
  diskShortageMessage,
};
