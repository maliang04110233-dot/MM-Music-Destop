/**
 * 用户歌单拖拽排序 — 纯函数（node 直测，无 DOM 依赖）
 *
 * 语义与播放队列拖拽（playQueueSort.applyPqDragMove）一致：
 * 落到目标行 = 占据该位置；这里只需返回新顺序，无播放下标换算。
 */

export function moveInList(list, from, to) {
  if (!Array.isArray(list) || list.length < 2) return null;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return null;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// ── 视图级排序（不改存储顺序，只排展示 pairs；与增量34 搜索排序同型）──

export const PL_SORT_MODES = [
  { key: '', label: '↕ 默认序' },
  { key: 'title', label: '↕ 标题' },
  { key: 'artist', label: '↕ 歌手' },
  { key: 'added', label: '↕ 添加时间' },
];

export function nextPlSortMode(cur) {
  let idx = PL_SORT_MODES.findIndex((m) => m.key === cur);
  if (idx < 0) idx = 0; // 坏值视作默认序再前进
  return PL_SORT_MODES[(idx + 1) % PL_SORT_MODES.length].key;
}

function _cmpText(a, b) {
  const ta = String(a || '').trim();
  const tb = String(b || '').trim();
  if (!ta && !tb) return 0;
  if (!ta) return 1; // 缺字段垫底
  if (!tb) return -1;
  return ta.localeCompare(tb, 'zh');
}

/**
 * @param {Array<{song: Object, i: number}>} pairs filterPlaylistSongs 的产物（i=存储下标）
 * @param {string} mode ''/title/artist/added
 * @returns {Array} 新数组；同键按原顺序（i 升序）稳定
 */
export function sortPlaylistPairs(pairs, mode) {
  if (!Array.isArray(pairs)) return [];
  if (!mode || mode === 'added') {
    // 默认序与添加时间均按存储下标方向排（added 缺 addedAt 垫底）
    const out = pairs.slice();
    if (mode === 'added') {
      out.sort((a, b) => {
        const av = +((a && a.song && a.song.addedAt) || 0);
        const bv = +((b && b.song && b.song.addedAt) || 0);
        const am = a && a.song && a.song.addedAt ? av : Infinity;
        const bm = b && b.song && b.song.addedAt ? bv : Infinity;
        return am !== bm ? am - bm : a.i - b.i;
      });
    }
    return out;
  }
  const out = pairs.slice();
  out.sort((a, b) => {
    const sa = (a && a.song) || {};
    const sb = (b && b.song) || {};
    const r = mode === 'title' ? _cmpText(sa.title, sb.title)
      : mode === 'artist' ? _cmpText(sa.artist, sb.artist) : 0;
    return r || a.i - b.i;
  });
  return out;
}
