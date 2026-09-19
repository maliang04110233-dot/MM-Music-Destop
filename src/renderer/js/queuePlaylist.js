/**
 * 播放队列 → 用户歌单的纯函数（增量76）。
 * 队列行本就是原始歌曲对象（url 只在取流后的 currentPlaying 上），
 * 这里只做三件事：滤空、盖 addedAt（歌单详情「添加时间」排序依赖它）、
 * 生成带时间的默认歌单名。无 DOM / api 依赖，node 可直接单测。
 */

export function queueToSongs(queue, now = Date.now()) {
  if (!Array.isArray(queue)) return [];
  return queue.filter(Boolean).map((s) => ({ ...s, addedAt: now }));
}

export function defaultQueuePlaylistName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `播放队列 · ${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}
