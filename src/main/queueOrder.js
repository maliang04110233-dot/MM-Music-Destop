'use strict';

// 队列顺序调整（纯函数，不依赖 electron，便于单测）。
// 约束：只有 pending 可移动；downloading/done/error 位置不受影响。
// 就地修改 list，返回是否发生了变化。

function queueMove(list, taskId, action) {
  if (!Array.isArray(list)) return false;
  const idx = list.findIndex(s => s && s.taskId === taskId);
  if (idx === -1) return false;
  if (list[idx].status !== 'pending') return false;

  if (action === 'up') {
    let prev = idx - 1;
    while (prev >= 0 && list[prev].status !== 'pending') prev--;
    if (prev < 0) return false;
    _swap(list, idx, prev);
    return true;
  }

  if (action === 'down') {
    let next = idx + 1;
    while (next < list.length && list[next].status !== 'pending') next++;
    if (next >= list.length) return false;
    _swap(list, idx, next);
    return true;
  }

  if (action === 'top') {
    const firstPending = list.findIndex(s => s && s.status === 'pending');
    if (firstPending === -1 || firstPending === idx) return false;
    const [item] = list.splice(idx, 1);
    list.splice(firstPending, 0, item);
    return true;
  }

  return false;
}

function _swap(list, i, j) {
  const tmp = list[i];
  list[i] = list[j];
  list[j] = tmp;
}

module.exports = { queueMove };
