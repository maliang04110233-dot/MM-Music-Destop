/**
 * 下载历史筛选 —— 纯函数（node 可单测，无 window 依赖）
 *
 * 主进程 history.query 早就支持 {source, status, keyword}，渲染层一直只接 keyword。
 * 这里把「页码 × 关键词 × 状态 × 来源」组合成查询 opts：任何维度变更须回第 0 页，
 * 空值一律不进 opts（避免 SQL 侧收到空串条件）。
 */

import { normalizeSortParam } from './historySort.js';

const HISTORY_STATUS_TABS = [
  { v: '', label: '全部' },
  { v: 'done', label: '成功' },
  { v: 'error', label: '失败' },
];

/** 归一筛选态：非法 status 丢弃、其余空值转 '' */
function normalizeHistoryFilter(f) {
  const src = f || {};
  const status = String(src.status || '');
  return {
    keyword: String(src.keyword || '').trim(),
    status: HISTORY_STATUS_TABS.some(t => t.v && t.v === status) ? status : '',
    source: String(src.source || '').trim(),
  };
}

/** 组合 queryHistory opts；页码由调用方在筛选变更后置 0 */
function buildHistoryQuery(src, page, pageSize) {
  const f = normalizeHistoryFilter(src);
  const opts = { limit: pageSize, offset: Math.max(0, page) * pageSize };
  if (f.keyword) opts.keyword = f.keyword;
  if (f.status) opts.status = f.status;
  if (f.source) opts.source = f.source;
  const sort = normalizeSortParam(src && src.sort);
  if (sort) opts.sort = sort;
  return opts;
}

/** 动态生成来源下拉的 option 清单（平台 manifest → [{v,label}]，含「全部来源」头） */
function sourceOptions(platforms) {
  const list = [{ v: '', label: '全部来源' }];
  for (const p of platforms || []) {
    if (p && p.id) list.push({ v: p.id, label: p.name || p.id });
  }
  return list;
}

/** addToQueue 返回值归类（批量重试计数用）：dup=已在队列 / had=已下载跳过 / fail=出错 */
function classifyRetryResult(r) {
  if (!r) return 'added';
  if (r.duplicated) return 'dup';
  if (r.alreadyDownloaded) return 'had';
  if (r.error) return 'fail';
  return 'added';
}

/** 重试汇总 → toast 文案 */
function retrySummary(tally) {
  const t = tally || {};
  return `🔁 重试完成：入队 ${t.added || 0}、已在队列 ${t.dup || 0}、已下载跳过 ${t.had || 0}、失败 ${t.fail || 0}`;
}

export { HISTORY_STATUS_TABS, normalizeHistoryFilter, buildHistoryQuery, sourceOptions, classifyRetryResult, retrySummary };
