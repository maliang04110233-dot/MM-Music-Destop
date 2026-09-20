/**
 * 下载历史排序：查询参数 sort → SQL ORDER BY 片段的白名单。
 *
 * 历史页是服务端分页（limit/offset），排序必须落在 SQL 里，否则只对当前页生效。
 * ORDER BY 不能参数化，因此这里用**字面量白名单**：调用方传什么都先查表，
 * 查不到一律回落默认序 —— 注入面由构造消除，不存在拼接用户输入的代码路径。
 */

const HISTORY_SORTS = {
  recent: 'seq DESC',
  oldest: 'seq ASC',
  title: 'title COLLATE NOCASE ASC, seq DESC',
  artist: 'artist COLLATE NOCASE ASC, seq DESC',
  size: "CAST(json_extract(data, '$.size') AS INTEGER) DESC, seq DESC",
};

const DEFAULT_SORT = 'recent';

/** 归一：只认白名单键，其余（含垃圾值/非字符串）回落默认。 */
function normalizeHistorySort(raw) {
  return (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(HISTORY_SORTS, raw))
    ? raw
    : DEFAULT_SORT;
}

/** 供 SQL 拼接使用：返回值永远是本模块内的字面量。 */
function resolveSortOrder(raw) {
  return HISTORY_SORTS[normalizeHistorySort(raw)];
}

module.exports = { HISTORY_SORTS, HISTORY_SORT_KEYS: Object.keys(HISTORY_SORTS), DEFAULT_SORT, normalizeHistorySort, resolveSortOrder };
