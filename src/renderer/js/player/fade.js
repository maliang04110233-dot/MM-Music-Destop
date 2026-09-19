/**
 * MusicDL 播放器 — 播放淡入（音量 0 → 目标 渐进）
 *
 * 只在「新曲起播 / 暂停后恢复」淡入；缓冲恢复不淡（缓冲只发 waiting，
 * 不发 pause，故用 pause 标记区分）。目标音量取淡入瞬间的 audio.volume
 * （= 用户滑条值），不与音量控制争抢持久状态。
 * 纯函数导出供 node 直测；本文件不得 import 任何带顶层 window 的模块。
 */

// 档位（ms）：关 → 0.5s → 1s → 2s 循环
export const FADE_STEPS = [0, 500, 1000, 2000];

export function fadeStageLabel(ms) {
  return +ms ? (+ms / 1000) + 's' : '关';
}

/** 循环切档：未知值按「关」起 */
export function nextFadeMs(cur) {
  let idx = FADE_STEPS.indexOf(+cur);
  if (idx < 0) idx = 0;
  return FADE_STEPS[(idx + 1) % FADE_STEPS.length];
}

/** 线性斜坡 0→target；越界钳制，dur<=0 直接到位 */
export function fadeVolumeAt(target, startTs, now, durMs) {
  const t = +target || 0;
  if (!(durMs > 0)) return t;
  const p = (now - startTs) / durMs;
  if (p <= 0) return 0;
  if (p >= 1) return t;
  return +(t * p).toFixed(4);
}

/** 是否该淡入：pause 后恢复、或新曲刚起播（currentTime 极小） */
export function shouldFadeIn(wasPaused, currentTime) {
  return !!wasPaused || (!currentTime) || currentTime < 1;
}

// ── DOM 接线（浏览器环境才挂）──────────────────────────
let _fadeMs = 0;
let _raf = 0;

function _setBadge() {
  const el = document.getElementById('fadeInVal');
  if (el) el.textContent = fadeStageLabel(_fadeMs);
}

function _cancelRaf() {
  if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
}

function _startFadeIn(audio) {
  if (!_fadeMs) return;
  _cancelRaf();
  const target = audio.muted ? 0 : audio.volume;
  if (target <= 0.02) return; // 已很小：多半是淡入中途误触，跳过防抖到错误目标
  const t0 = performance.now();
  audio.volume = 0;
  const step = (now) => {
    const v = fadeVolumeAt(target, t0, now, _fadeMs);
    audio.volume = v;
    _raf = v < target ? requestAnimationFrame(step) : 0;
  };
  _raf = requestAnimationFrame(step);
}

function _wire() {
  const audio = document.getElementById('audioPlayer');
  if (!audio) return;
  let wasPaused = true; // 首播前视作暂停态 → 起播淡入
  audio.addEventListener('pause', () => { wasPaused = true; _cancelRaf(); });
  audio.addEventListener('playing', () => {
    if (shouldFadeIn(wasPaused, audio.currentTime)) _startFadeIn(audio);
    wasPaused = false;
  });
  api.getPref('fadeInMs').then(v => { _fadeMs = +v || 0; _setBadge(); }).catch(() => {});
}

/** 更多菜单/命令面板入口：循环档位并持久化 */
export function cycleFadeIn() {
  _fadeMs = nextFadeMs(_fadeMs);
  _setBadge();
  try { api.setPref('fadeInMs', _fadeMs); } catch (_e) { /* 持久化失败不挡本次 */ }
  showToast('淡入：' + fadeStageLabel(_fadeMs), 'info', 1800);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wire, { once: true });
  } else {
    setTimeout(_wire, 0);
  }
  window.cycleFadeIn = cycleFadeIn;
}
