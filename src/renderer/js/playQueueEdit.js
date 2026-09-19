/**
 * 播放队列编辑 —— 纯函数（node 可单测，无 DOM 依赖）
 *
 * 队列此前只有「整队清空」与「拖拽排序」，缺单行移除与去重。
 * 两函数都同步换算 playIdx，保证改完后「正在播放」高亮仍跟对行；
 * 调用方 setState 后由既有订阅自动重渲染并持久化（app.js 的 playQueue 订阅）。
 */

/** 去重键：优先平台坐标，缺失退回曲名+歌手（大小写/空白归一） */
function pqSongKey(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.id != null && s.id !== '' && s.source) return `p|${s.source}|${s.id}`;
  const t = String(s.title || '').trim().toLowerCase();
  const a = String(s.artist || '').trim().toLowerCase();
  return t ? `m|${t}|${a}` : null;
}

/**
 * 移除一行。
 * @returns {{queue: Array, playIdx: number, removedCurrent: boolean}|null} 非法下标返回 null；
 *   removedCurrent=true 时 playIdx 指向补位进来的下一首（队空则 -1）
 */
function removeQueueItem(queue, playIdx, idx) {
  if (!Array.isArray(queue) || !queue.length) return null;
  if (!Number.isInteger(idx) || idx < 0 || idx >= queue.length) return null;
  const next = queue.slice();
  next.splice(idx, 1);
  let cur = Number.isInteger(playIdx) ? playIdx : -1;
  let removedCurrent = false;
  if (idx === cur) {
    removedCurrent = true;
    cur = next.length ? Math.min(idx, next.length - 1) : -1;
  } else if (idx < cur) {
    cur--;
  }
  return { queue: next, playIdx: cur, removedCurrent };
}

/**
 * 按 pqSongKey 去重，保留每首的首次出现。
 * @returns {{queue: Array, playIdx: number, removed: number}} 当前播放曲被并掉时
 *   playIdx 跟随留下的那份；队空则 -1
 */
function dedupeQueue(queue, playIdx) {
  if (!Array.isArray(queue)) return { queue: [], playIdx: -1, removed: 0 };
  const seen = new Map();
  const next = [];
  const currentSong = Number.isInteger(playIdx) && playIdx >= 0 ? queue[playIdx] : null;
  for (const s of queue) {
    const k = pqSongKey(s);
    if (k != null && seen.has(k)) continue;
    if (k != null) seen.set(k, next.length);
    next.push(s);
  }
  const removed = queue.length - next.length;
  if (!next.length) return { queue: next, playIdx: -1, removed };
  let cur = Number.isInteger(playIdx) ? playIdx : -1;
  if (currentSong) {
    const k = pqSongKey(currentSong);
    cur = k != null && seen.has(k) ? seen.get(k) : Math.min(cur, next.length - 1);
  }
  return { queue: next, playIdx: cur, removed };
}

export { pqSongKey, removeQueueItem, dedupeQueue };
