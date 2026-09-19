/**
 * 歌单详情「下载状态过滤」—— 纯函数（node 可单测，无 DOM 依赖）
 *
 * 三态循环：全部 → 只看未下载 → 只看已下载。判定不自建，
 * 状态由调用方注入 statusOf(song)（接线层给 dlStatus.js 的 dlStatusFor），
 * 语义与行内徽标完全一致：'done' 才算已下载，queued/downloading/无状态都算未下载。
 */

const PL_DL_MODES = ['all', 'undone', 'done'];

/** 循环下一态；未知入参回 'all' */
function nextPlDlMode(mode) {
  const i = PL_DL_MODES.indexOf(mode);
  return PL_DL_MODES[((i < 0 ? 0 : i) + 1) % PL_DL_MODES.length];
}

/** 按钮文案（静态字面量，无注入面） */
function plDlModeLabel(mode) {
  if (mode === 'undone') return '⬇ 未下载';
  if (mode === 'done') return '⬇ 已下载';
  return '⬇ 全部状态';
}

/**
 * 按下载状态过滤视图条目。
 * @param items 视图条目（如 {song, i} 对），顺序不动
 * @param mode 'all'|'undone'|'done'；其余值原样返回
 * @param statusOf (songOrItem)=>状态串；'done' 之外全算未下载
 */
function filterByDlMode(items, mode, statusOf) {
  const arr = Array.isArray(items) ? items : [];
  if (mode !== 'undone' && mode !== 'done') return arr.slice();
  const wantDone = mode === 'done';
  const get = typeof statusOf === 'function' ? statusOf : (x) => x;
  return arr.filter((it) => {
    const st = get(it && it.song != null ? it.song : it);
    return wantDone ? st === 'done' : st !== 'done';
  });
}

export { PL_DL_MODES, nextPlDlMode, plDlModeLabel, filterByDlMode };
