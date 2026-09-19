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
