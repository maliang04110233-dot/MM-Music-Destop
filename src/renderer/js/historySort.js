/**
 * 下载历史排序的界面侧纯逻辑：循环档位与按钮文案。
 *
 * 档位 id 与 src/shared/historySort.js 的白名单键**必须一一对应**（渲染层是
 * ESM、主进程是 CJS，没法共用一个文件，故由 test/history-sort.test.js 逐键对账）。
 * 无 DOM / api 依赖，node 可直接单测。
 */

const SORT_MODES = ['recent', 'oldest', 'title', 'artist', 'size'];
const DEFAULT_SORT = 'recent';

const LABELS = {
  recent: '↕ 最新在前',
  oldest: '↕ 最早在前',
  title: '↕ 曲名 A→Z',
  artist: '↕ 歌手 A→Z',
  size: '↕ 文件更大',
};

function nextSortMode(mode) {
  const i = SORT_MODES.indexOf(mode);
  return SORT_MODES[(i + 1 + SORT_MODES.length) % SORT_MODES.length];
}

function sortLabel(mode) {
  return LABELS[mode] || LABELS[DEFAULT_SORT];
}

/** 只有非默认档才进查询参数，默认序不发多余键。 */
function normalizeSortParam(raw) {
  return SORT_MODES.includes(raw) && raw !== DEFAULT_SORT ? raw : '';
}

export { SORT_MODES, DEFAULT_SORT, nextSortMode, sortLabel, normalizeSortParam };
