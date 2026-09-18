/**
 * MusicDL 渲染层 — 播放状态外发同步 + 播放队列恢复
 *
 * 自 app.js 的 init() 内闭包提出：原先这四个函数定义在 init() 内部，
 * 彼此闭包引用同批 init 局部变量。它们**只被 init 调用、彼此互调**，
 * 对外无其他调用方，故可整体外提；唯一共享状态 `_audio` 改为显式传入，
 * 不再依赖模块级可变变量（消除「谁先赋值」的隐式时序）。
 *
 * 依赖全局：api、getState、setState、fmtTime、showToast、
 *          updatePlayerCard、updatePlayModeButton（均由 preload / 兄弟模块挂 window）
 *
 * 拆分性质：**等价迁移，行为零改动**。守卫见 test/player-sync.test.js
 * 与 test/renderer-contract.test.js。
 */

// ── 播放状态同步到系统托盘 ──────────────────────────
export function syncToTray(audio) {
  if (typeof api.trayUpdatePlayState !== 'function') return;
  const song = getState('currentPlaying') || (getState('playQueue') || [])[getState('playIdx')] || null;
  const isPlaying = audio && !audio.paused;
  api.trayUpdatePlayState({
    isPlaying,
    title: song?.title || '',
    artist: song?.artist || '',
  });
}

// ── 播放状态同步到迷你播放器 ──────────────────────────
export function syncToMiniPlayer(audio) {
  if (typeof api.syncMiniPlayer !== 'function' || !audio) return;
  const song = getState('currentPlaying') || (getState('playQueue') || [])[getState('playIdx')] || null;
  const progress = audio.duration ? (audio.currentTime / audio.duration * 100) : 0;

  // 获取当前歌词行
  let currentLyric = '';
  const parsedLyrics = getState('parsedLyrics');
  if (parsedLyrics && parsedLyrics.length) {
    const idx = parsedLyrics.findIndex(l => l.t > audio.currentTime) - 1;
    if (idx >= 0 && idx < parsedLyrics.length) {
      currentLyric = parsedLyrics[idx].text || '';
    }
  }

  const timeNow = fmtTime(audio.currentTime);
  const timeTotal = fmtTime(audio.duration);
  const timeStr = `${timeNow} / ${timeTotal}`;

  api.syncMiniPlayer({
    title: song ? song.title : '未在播放',
    artist: song ? (song.artist || '未知艺术家') : '—',
    cover: song ? song.cover : '',
    playing: !audio.paused,
    progress,
    lyric: currentLyric,
    time: timeStr,
  });
}

// ── 播放状态同步到桌面歌词窗口 ────────────────────────
// 歌词整份只在换歌时推一次（避免每帧序列化整份 parsedLyrics），
// currentTime 每帧推；桌面窗口自行定位当前行+逐字高亮
let _dlLastLyricSongId = null;

export function syncToDesktopLyric(audio) {
  if (typeof api.syncDesktopLyric !== 'function' || !audio) return;
  const song = getState('currentPlaying') || (getState('playQueue') || [])[getState('playIdx')] || null;
  const payload = { currentTime: audio.currentTime };
  const songKey = song ? String(song.id) + ':' + String(song.source || '') : '';
  if (songKey !== _dlLastLyricSongId) {
    _dlLastLyricSongId = songKey;
    const parsed = getState('parsedLyrics') || [];
    // 只送渲染所需字段（wordTimes 用于逐字高亮）
    payload.lyrics = parsed.map(l => ({
      t: l.t, text: l.text, subText: l.subText || '',
      words: l.words || [], wordTimes: l.wordTimes || [],
    }));
    payload.title = song ? song.title : '';
  }
  api.syncDesktopLyric(payload);
}

/** 桌面歌词窗口要全量状态时清掉「上次推送的歌」，强制重推整份歌词 */
export function resetDesktopLyricSong() {
  _dlLastLyricSongId = null;
}

// ── 播放队列持久化 ─────────────────────────────────
let _queueRestored = false; // 防双重恢复

// 辅助函数：恢复 loopMode/isShuffled 后更新按钮视觉
export function applyRestoredPlayMode(loopMode, isShuffled) {
  if (typeof loopMode === 'number') {
    setState('loopMode', loopMode);
  }
  if (typeof isShuffled === 'boolean') {
    setState('isShuffled', isShuffled);
  }
  // 更新合并按钮的视觉
  if (typeof updatePlayModeButton === 'function') updatePlayModeButton();
}

export function restorePlayQueueFromSaved(saved) {
  if (_queueRestored || !saved || !saved.queue || !saved.queue.length) return;
  _queueRestored = true;
  setState('playQueue', saved.queue);
  if (typeof saved.playIdx === 'number' && saved.playIdx >= 0 && saved.playIdx < saved.queue.length) {
    setState('playIdx', saved.playIdx);
  }
  applyRestoredPlayMode(saved.loopMode, saved.isShuffled);
  // 在播放器卡片上显示第一首歌（不自动播放）
  const idx = (typeof saved.playIdx === 'number' && saved.playIdx >= 0 && saved.playIdx < saved.queue.length) ? saved.playIdx : 0;
  if (saved.queue[idx]) {
    if (typeof updatePlayerCard === 'function') updatePlayerCard(saved.queue[idx]);
  }
  showToast(`♻️ 恢复播放队列 ${saved.queue.length} 首`, 'info', 2000);
}
