/**
 * 搜索结果排序纯逻辑：默认（抓取原序）→ 时长降 → 时长升 → 按来源 循环。
 * 输入是 renderSongList 的 [song, originalIndex] pairs —— 排序只移动整对，
 * 行内 onclick 的原始索引与键盘 _visibleIdxMap 映射天然保持一致。
 * 本模块无 DOM / api 依赖，node 可直接单测。
 */

const SORT_MODES = ['default', 'duration-desc', 'duration-asc', 'source'];

const LABELS = {
  default: '↕ 默认序',
  'duration-desc': '↕ 时长 ↓',
  'duration-asc': '↕ 时长 ↑',
  source: '↕ 按来源',
};

function nextSortMode(mode) {
  const i = SORT_MODES.indexOf(mode);
  return SORT_MODES[(i + 1 + SORT_MODES.length) % SORT_MODES.length];
}

function sortLabel(mode) {
  return LABELS[mode] || LABELS.default;
}

function _dur(s) {
  return s && typeof s.duration === 'number' && s.duration > 0 ? s.duration : null;
}

/** 稳定排序；无时长的行在升降序中都固定在末尾。 */
function sortPairs(pairs, mode) {
  const arr = Array.isArray(pairs) ? pairs : [];
  if (!mode || mode === 'default') return arr;
  if (mode === 'duration-desc' || mode === 'duration-asc') {
    const dir = mode === 'duration-desc' ? -1 : 1;
    const withDur = [];
    const noDur = [];
    for (const p of arr) (p && _dur(p[0]) !== null ? withDur : noDur).push(p);
    withDur.sort((a, b) => dir * (_dur(a[0]) - _dur(b[0])));
    return withDur.concat(noDur);
  }
  if (mode === 'source') {
    return arr.slice().sort((a, b) =>
      String((a && a[0] && a[0].source) || '').localeCompare(String((b && b[0] && b[0].source) || '')));
  }
  return arr;
}

export { SORT_MODES, nextSortMode, sortLabel, sortPairs };
