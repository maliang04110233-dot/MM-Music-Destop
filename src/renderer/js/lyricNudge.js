/**
 * MusicDL 渲染层 — 歌词偏移快捷微调
 *
 * 设置页只有 ±2000ms 滑条，听歌时要来回切页拖滑条。这里给播放器
 * 「更多」菜单和命令面板提供 提前/延后 0.5s、归零 三个快捷动作：
 * 走 applyLyricOffset 同一状态源，写回 lyricOffset pref（重启保留），
 * 并同步设置页滑条与菜单徽标。纯函数导出供 node:test。
 */

export const OFFSET_MIN = -2000;
export const OFFSET_MAX = 2000;

/** 当前值 + 增量，钳到滑条同量程；非法输入按 0 处理 */
export function clampOffsetSum(cur, delta) {
  const c = Number(cur) || 0;
  const d = Number(delta) || 0;
  return Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, c + d));
}

export function fmtSignedMs(ms) {
  const v = Number(ms) || 0;
  return (v > 0 ? '+' : '') + v + 'ms';
}

function _win() {
  // typeof 裸标识符安全，但 `typeof window.x` 在 window 未声明时照样 ReferenceError
  return typeof window === 'undefined' ? null : window;
}

function _current() {
  const w = _win();
  return w && typeof w.getLyricOffset === 'function' ? w.getLyricOffset() : 0;
}

function _syncUi(ms) {
  const slider = document.getElementById('settingLyricOffset');
  if (slider) slider.value = ms;
  const sliderVal = document.getElementById('lyricOffsetValue');
  if (sliderVal) sliderVal.textContent = ms + 'ms';
  const badge = document.getElementById('lyricOffsetVal');
  if (badge) badge.textContent = ms ? fmtSignedMs(ms) : '';
}

/** 应用并持久化新偏移；返回最终值 */
export function setOffset(ms) {
  const next = clampOffsetSum(ms, 0);
  const w = _win();
  if (w && typeof w.applyLyricOffset === 'function') w.applyLyricOffset(next);
  try { if (typeof api !== 'undefined') api.setPref('lyricOffset', next); } catch (_e) { /* 尽力写盘 */ }
  if (typeof document !== 'undefined') _syncUi(next);
  return next;
}

export function nudge(deltaMs) {
  const next = setOffset(clampOffsetSum(_current(), deltaMs));
  if (typeof showToast === 'function') {
    showToast(`歌词偏移 ${fmtSignedMs(next)}（${next >= 0 ? '延后显示' : '提前显示'}）`, 'info', 1600);
  }
  return next;
}

export function resetOffset() {
  const cur = _current();
  if (cur === 0) {
    if (typeof showToast === 'function') showToast('歌词偏移本来就是 0', 'info', 1200);
    return 0;
  }
  const next = setOffset(0);
  if (typeof showToast === 'function') showToast('歌词偏移已归零', 'success', 1500);
  return next;
}

if (typeof document !== 'undefined') {
  window.nudgeLyricOffset = nudge;
  window.resetLyricOffset = resetOffset;
  // 启动时把已保存的偏移显示到菜单徽标（lyrics.js 的 pref 读取是 setTimeout(0)）
  setTimeout(() => {
    const badge = document.getElementById('lyricOffsetVal');
    if (badge) badge.textContent = _current() ? fmtSignedMs(_current()) : '';
  }, 300);
}
