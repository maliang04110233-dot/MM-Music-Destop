/**
* MusicDL 播放器 — 霓虹科技风格
* 圆形封面盘 + 环形进度条
* 
* ES Module — export 供其他模块 import，同时保留 window 全局供 HTML onclick
 */

import { logger } from './logger.js';

const audio = document.getElementById('audioPlayer');
const RING_CIRCUMFERENCE = 552.9; // 2 * PI * 88

// ── 状态 ─────────────────────────────────────────────
let audioCtx = null;

// ── 歌词设置（同步缓存，避免 timeupdate 热路径异步） ────
let _lyricFontSize = 18;
let _lyricOffset = 0;

function _loadLyricSettings() {
  api.getPref('lyricFontSize').then(v => { _lyricFontSize = v != null ? +v : 18; });
  api.getPref('lyricOffset').then(v => { _lyricOffset = v != null ? +v : 0; });
}
// 页面加载时读取一次
setTimeout(_loadLyricSettings, 0);

function applyLyricFontSize(size) {
  _lyricFontSize = +size || 18;
  const lyricsArea = document.getElementById('lyricsArea');
  if (lyricsArea) lyricsArea.style.fontSize = _lyricFontSize + 'px';
}

function applyLyricOffset(ms) {
  _lyricOffset = +ms || 0;
}
window.applyLyricFontSize = applyLyricFontSize;
window.applyLyricOffset = applyLyricOffset;

// ── EQ 5 段均衡器 ────────────────────────────────────
const EQ_BANDS = [
   { freq: 60,   label: '60Hz',   type: 'lowshelf' },
   { freq: 230,  label: '230Hz',  type: 'peaking' },
   { freq: 910,  label: '910Hz',  type: 'peaking' },
   { freq: 3600, label: '3.6kHz', type: 'peaking' },
   { freq: 14000,label: '14kHz',  type: 'highshelf' },
];
const eqFilters = []; // BiquadFilterNode[]
let eqBypassed = false; // EQ bypass state

// ── EQ 预设曲线 ───────────────────────────────────────
// 每条预设是 EQ_BANDS 对应索引的增益值 [60Hz, 230Hz, 910Hz, 3.6kHz, 14kHz] (dB)
const EQ_PRESETS = {
  flat:    [ 0,  0,  0,  0,  0],
  pop:     [ 2,  3,  1,  2,  3],
  rock:    [ 4,  2, -1,  1,  3],
  classic: [ 1,  1,  2,  2,  1],
  vocal:   [-1,  2,  4,  3,  0],
  dance:   [ 4,  1,  0,  0,  3],
  jazz:    [ 2,  3,  2,  1,  3],
  bass:    [ 6,  3, -1, -1,  0],
};
let currentEqPreset = 'flat';

// ── 应用 EQ 预设 ──────────────────────────────────────
export function applyEqPreset(name) {
  const gains = EQ_PRESETS[name];
  if (!gains) return;
  currentEqPreset = name;
  eqBypassed = false;
  EQ_BANDS.forEach((_, i) => {
    if (eqFilters[i]) {
      eqFilters[i].gain.value = gains[i];
    }
  });
  // 更新 UI 滑块
  const sliders = document.querySelectorAll('#eqPanel input[type=range]');
  const labels = document.querySelectorAll('#eqPanel [id^=eq_val_]');
  [...sliders].forEach((sl, i) => {
    if (gains[i] !== undefined) {
      sl.value = gains[i];
      if (labels[i]) labels[i].textContent = gains[i] + 'dB';
    }
  });
  // 更新预设按钮高亮
  document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('eq-preset-active'));
  document.querySelectorAll(`[data-eq-preset="${name}"]`).forEach(b => b.classList.add('eq-preset-active'));
  saveEqPresetSetting(name);
}
export function toggleEqBypass() {
  eqBypassed = !eqBypassed;
  const bypass = eqBypassed;
  EQ_BANDS.forEach((_, i) => {
    if (eqFilters[i]) {
      // bypass 时全部增益设为 0，恢复时还原为当前预设
      eqFilters[i].gain.value = bypass ? 0 : (EQ_PRESETS[currentEqPreset]?.[i] ?? 0);
    }
  });
  // 更新 UI
  const btn = document.getElementById('eqBypassBtn');
  if (btn) {
    btn.textContent = bypass ? '🔇 EQ关闭' : '🎚️ EQ开启';
    btn.classList.toggle('eq-bypassed', bypass);
  }
  // bypass 时不改滑块显示，只改按钮状态
  saveEqPresetSetting(currentEqPreset);
}

// ── 预设持久化 ────────────────────────────────────────
async function saveEqPresetSetting(name) {
  try {
    await api.setPref('eqPreset', name);
    await api.setPref('eqBypass', eqBypassed);
  } catch (e) { /* silent */ }
}

async function restoreEqPresetSetting() {
  try {
    const name = await api.getPref('eqPreset') || 'flat';
    const bypass = await api.getPref('eqBypass');
    if (name && EQ_PRESETS[name]) {
      currentEqPreset = name;
      eqBypassed = bypass === true;
      const gains = eqBypassed ? EQ_BANDS.map(() => 0) : EQ_PRESETS[name];
      EQ_BANDS.forEach((_, i) => {
        if (eqFilters[i]) eqFilters[i].gain.value = gains[i];
      });
    }
  } catch (e) { /* silent */ }
}

// ── EQ 设置持久化 ─────────────────────────────────────
function getEqGains() {
   return eqFilters.map(f => f.gain.value);
}

export function setEqBand(index, gain) {
   if (eqFilters[index]) {
     eqFilters[index].gain.value = gain;
   }
}

export function resetEq() {
   eqFilters.forEach(f => { f.gain.value = 0; });
   // 更新 UI
   EQ_BANDS.forEach((_, i) => {
     const slider = document.getElementById('eq_' + i);
     const label = document.getElementById('eq_val_' + i);
     if (slider) slider.value = 0;
     if (label) label.textContent = '0dB';
   });
   saveEqSettings();
}

export async function saveEqSettings() {
   try {
     const gains = getEqGains();
     await api.setPref('eqGains', gains);
   } catch (_e) { /* EQ 保存失败使用默认 */ }
}

// ── 更新播放器卡片信息（不播放） ─────────────────────
export function updatePlayerCard(song) {
  if (!song) {
    document.getElementById('playerTitle').textContent = '未在播放';
    document.getElementById('playerArtist').textContent = '—';
    document.getElementById('playerDiscImg').style.display = 'none';
    document.getElementById('playerDiscPh').style.display = 'flex';
    _updateSrcBadge(null);
    return;
  }
  document.getElementById('playerTitle').textContent = song.title || '未知歌曲';
  document.getElementById('playerArtist').textContent = song.artist || '未知艺术家';
  _updateSrcBadge(song);
  const discPh = document.getElementById('playerDiscPh');
  const discImg = document.getElementById('playerDiscImg');
  if (song.cover && song.cover !== discImg.src) {
    discImg.src = song.cover;
    discImg.style.display = 'block';
    discPh.style.display = 'none';
  } else if (!song.cover) {
    discImg.style.display = 'none';
    discPh.style.display = 'flex';
  }
  // 不修改进度条、频谱等播放状态
}

const SOURCE_NAMES = { netease: '网易云', qq: 'QQ音乐', kugou: '酷狗', bilibili: 'B站' };
/** 换源徽标：实际取流源(song._altSource.source)与原源不同时显示，
    让"换源成功"从一次性 toast 变为持续可见状态 */
function _updateSrcBadge(song) {
  const badge = document.getElementById('playerSrcBadge');
  if (!badge) return;
  const alt = song && song._altSource;
  if (alt && alt.source && alt.source !== song.source) {
    badge.textContent = `↻ ${SOURCE_NAMES[alt.source] || alt.source}源`;
    badge.title = `原源 ${SOURCE_NAMES[song.source] || song.source} 不可用，已自动切换`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// ── 播放 ─────────────────────────────────────────────
// 最近播放记录（内存缓存，最多 50 首）
const _recentlyPlayed = [];
const MAX_RECENT = 50;

function addToRecentlyPlayed(song) {
  if (!song || !song.title) return;
  // 去重：移除已存在的同歌曲
  const idx = _recentlyPlayed.findIndex(s =>
    s.title === song.title && s.artist === song.artist && s.source === song.source
  );
  if (idx >= 0) _recentlyPlayed.splice(idx, 1);
  // 添加到最前面
  _recentlyPlayed.unshift({
    title: song.title,
    artist: song.artist || '未知艺术家',
    source: song.source || '',
    cover: song.cover || '',
    duration: song.duration || 0,
    playedAt: Date.now(),
  });
  // 限制数量
  if (_recentlyPlayed.length > MAX_RECENT) _recentlyPlayed.length = MAX_RECENT;
  // 持久化
  persistRecentlyPlayed();
}

export function getRecentlyPlayed() {
  return _recentlyPlayed;
}

async function persistRecentlyPlayed() {
  try {
    await api.setPref('recentlyPlayed', JSON.stringify(_recentlyPlayed));
  } catch (_e) { /* 静默 */ }
}

export async function loadRecentlyPlayed() {
  try {
    const raw = await api.getPref('recentlyPlayed');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        _recentlyPlayed.length = 0;
        _recentlyPlayed.push(...arr.slice(0, MAX_RECENT));
      }
    }
  } catch (_e) { /* 静默 */ }
}

export function clearRecentlyPlayed() {
  _recentlyPlayed.length = 0;
  persistRecentlyPlayed();
  showToast('最近播放已清空', 'info');
}

// ══════════════════════════════════════════════════════════
// 播放统计
// ══════════════════════════════════════════════════════════

const _playStats = {
  totalPlayTime: 0,      // 总播放时长（秒）
  totalSongs: 0,         // 播放过多少首不同歌曲
  playCount: {},         // { 'title|||artist': count }
  lastPlayed: null,      // 最后播放的歌曲
  sessionStart: Date.now(),
};

// 追踪当前播放开始时间
let _currentPlayStartTime = null;

function updatePlayStatsOnStart() {
  _currentPlayStartTime = Date.now();
}

function updatePlayStatsOnStop() {
  if (_currentPlayStartTime) {
    const elapsed = Math.floor((Date.now() - _currentPlayStartTime) / 1000);
    _playStats.totalPlayTime += elapsed;
    _currentPlayStartTime = null;
    persistPlayStats();
  }
}

function recordPlay(song) {
  if (!song || !song.title) return;
  const key = `${song.title}|||${song.artist || ''}`;
  _playStats.playCount[key] = (_playStats.playCount[key] || 0) + 1;
  _playStats.lastPlayed = { title: song.title, artist: song.artist, time: Date.now() };
  // 统计不同歌曲数
  _playStats.totalSongs = Object.keys(_playStats.playCount).length;
  persistPlayStats();
}

export function getPlayStats() {
  // 更新当前播放时长
  if (_currentPlayStartTime) {
    const elapsed = Math.floor((Date.now() - _currentPlayStartTime) / 1000);
    return { ..._playStats, totalPlayTime: _playStats.totalPlayTime + elapsed };
  }
  return _playStats;
}

export function getMostPlayed(limit = 10) {
  const entries = Object.entries(_playStats.playCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  return entries.map(([key, count]) => {
    const [title, artist] = key.split('|||');
    return { title, artist, count };
  });
}

function formatPlayTime(seconds) {
  if (!seconds) return '0分钟';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}小时${m}分钟`;
  return `${m}分钟`;
}

async function persistPlayStats() {
  try {
    await api.setPref('playStats', JSON.stringify(_playStats));
  } catch (_e) { /* 静默 */ }
}

export async function loadPlayStats() {
  try {
    const raw = await api.getPref('playStats');
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        Object.assign(_playStats, data);
      }
    }
  } catch (_e) { /* 静默 */ }
}

export function resetPlayStats() {
  _playStats.totalPlayTime = 0;
  _playStats.totalSongs = 0;
  _playStats.playCount = {};
  _playStats.lastPlayed = null;
  _currentPlayStartTime = null;
  persistPlayStats();
  showToast('播放统计已重置', 'info');
}

// ══════════════════════════════════════════════════════════
// 听歌报告
// ══════════════════════════════════════════════════════════

export function generatePlayReport() {
  const stats = getPlayStats();
  const mostPlayed = getMostPlayed(5);

  // 最爱歌手
  const artistCounts = {};
  for (const [key, count] of Object.entries(stats.playCount)) {
    const artist = key.split('|||')[1] || '未知';
    artistCounts[artist] = (artistCounts[artist] || 0) + count;
  }
  const topArtists = Object.entries(artistCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const html = `
    <div class="report-grid">
      <div class="report-card">
        <div class="report-icon">⏱️</div>
        <div class="report-value">${formatPlayTime(stats.totalPlayTime)}</div>
        <div class="report-label">总播放时长</div>
      </div>
      <div class="report-card">
        <div class="report-icon">🎵</div>
        <div class="report-value">${stats.totalSongs}</div>
        <div class="report-label">播放歌曲数</div>
      </div>
      <div class="report-card">
        <div class="report-icon">🎤</div>
        <div class="report-value">${Object.keys(artistCounts).length}</div>
        <div class="report-label">收听歌手数</div>
      </div>
    </div>

    ${mostPlayed.length ? `
    <div class="report-section">
      <div class="report-section-title">🏆 最爱歌曲 TOP 5</div>
      <div class="report-list">
        ${mostPlayed.map((s, i) => `
          <div class="report-item">
            <span class="report-rank">${i + 1}</span>
            <span class="report-name">${esc(s.title)}</span>
            <span class="report-count">${s.count} 次</span>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    ${topArtists.length ? `
    <div class="report-section">
      <div class="report-section-title">🎤 最爱歌手 TOP 3</div>
      <div class="report-list">
        ${topArtists.map(([artist, count], i) => `
          <div class="report-item">
            <span class="report-rank">${i + 1}</span>
            <span class="report-name">${esc(artist)}</span>
            <span class="report-count">${count} 次</span>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    ${stats.lastPlayed ? `
    <div class="report-section">
      <div class="report-section-title">📀 最后播放</div>
      <div class="report-last">
        ${esc(stats.lastPlayed.title)} - ${esc(stats.lastPlayed.artist || '')}
      </div>
    </div>
    ` : ''}
  `;

  showReportModal(html);
}

function showReportModal(html) {
  let overlay = document.getElementById('reportModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'reportModal';
  overlay.className = 'stats-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="stats-panel report-panel">
      <div class="stats-header">
        <span>📊 听歌报告</span>
        <button onclick="document.getElementById('reportModal').remove()">✕</button>
      </div>
      <div class="stats-body">${html}</div>
    </div>
  `;
  document.body.appendChild(overlay);
}

// ── 播放进度记忆 ─────────────────────────────────────
const _playProgressKey = (song) => song.filePath || `${song.source}:${song.id}`;

async function savePlayProgress(song, time) {
  try {
    const enabled = await api.getPref('playProgressMemory');
    if (enabled === false) return;
    const key = _playProgressKey(song);
    const progressMap = await api.getPref('playProgressMap') || {};
    progressMap[key] = { time, savedAt: Date.now() };
    // 只保留最近 200 首的进度
    const entries = Object.entries(progressMap);
    if (entries.length > 200) {
      entries.sort((a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0));
      const trimmed = Object.fromEntries(entries.slice(-200));
      await api.setPref('playProgressMap', trimmed);
    } else {
      await api.setPref('playProgressMap', progressMap);
    }
  } catch (_e) { /* ignore */ }
}

async function restorePlayProgress(song) {
  try {
    const enabled = await api.getPref('playProgressMemory');
    if (enabled === false) return 0;
    const key = _playProgressKey(song);
    const progressMap = await api.getPref('playProgressMap') || {};
    const entry = progressMap[key];
    if (entry && entry.time > 3) return entry.time; // 忽略前 3 秒
    return 0;
  } catch (_e) { return 0; }
}

export async function loadAndPlay(song, prefetchedUrl, isNetworkSong = false) {
  if (!song) return;

  // 记录到最近播放
  addToRecentlyPlayed(song);
  updatePlayStatsOnStart();
  recordPlay(song);

  const localUrl = prefetchedUrl || (song.filePath ? 'file://' + song.filePath : null);

  // ── 本地歌曲分支（仅当明确是本地歌曲或没有预获取URL时）─────────
  if (!isNetworkSong && localUrl && localUrl.startsWith('file://')) {
    // 封面：优先用缓存，缺失时搜在线封面
    if (!song.cover) {
      try {
        const online = await api.fetchOnlineCover(song.title || '', song.artist || '');
        if (online && online.coverBase64) {
          const ok = await api.updateId3Cover(song.filePath, online.coverBase64);
          if (ok && ok.success) {
            song.cover = online.coverBase64;
            const localSongs = getState('localSongs');
            const i2 = localSongs.findIndex(x => x.filePath === song.filePath);
            if (i2 >= 0) localSongs[i2].cover = online.coverBase64;
          }
        }
      } catch (_e) { /* ignore */ }
    }

    const discPh = document.getElementById('playerDiscPh');
    const discImg = document.getElementById('playerDiscImg');
    if (discImg && discPh) {
      if (song.cover) {
        discImg.src = song.cover;
        discImg.style.display = 'block';
        discPh.style.display = 'none';
      } else {
        discImg.style.display = 'none';
        discPh.style.display = 'flex';
      }
    }
    const titleEl = document.getElementById('playerTitle');
    const artistEl = document.getElementById('playerArtist');
    if (titleEl) titleEl.textContent = song.title || '未知歌曲';
    if (artistEl) artistEl.textContent = song.artist || '未知艺术家';
    updateRingProgress(0);

    audio.src = localUrl;
    // 恢复播放进度
    const savedTime = await restorePlayProgress(song);
    if (savedTime > 0) {
      audio.addEventListener('loadedmetadata', () => {
        if (audio.duration > savedTime) {
          audio.currentTime = savedTime;
          showToast(`📍 从 ${Math.floor(savedTime/60)}:${String(Math.floor(savedTime%60)).padStart(2,'0')} 继续播放`, 'info', 2000);
        }
      }, { once: true });
    }
    audio.play().catch(() => {
      showToast('⚠️ 自动播放被拦截，请点击播放按钮', 'warn', 3000);
    });

    // 加载歌词
    const lyricsArea = document.getElementById('lyricsArea');
    if (lyricsArea) {
      setState('parsedLyrics', []);
      lyricsArea.style.display = 'none';
      lyricsArea.classList.remove('static-mode');
    }
    try {
      const r = await api.readLocalLrc(song.filePath);
      if (r && r.lrc && r.lrc.trim()) {
        window.parseLrc(r.lrc);
        if (r.source === 'embedded') {
          showToast('使用嵌入歌词', 'info', 1500);
        }
      } else {
        showNoLyrics();
      }
    } catch (_e) {
      showNoLyrics();
    }
    return;
  }

  // ── 网络歌曲分支 ─────────────────────────────────────
  setState('_currentLocalFilePath', null);
  const titleEl = document.getElementById('playerTitle');
  const artistEl = document.getElementById('playerArtist');
  if (titleEl) titleEl.textContent = song.title || '未知歌曲';
  if (artistEl) artistEl.textContent = song.artist || '未知艺术家';

  const discPh2 = document.getElementById('playerDiscPh');
  const discImg2 = document.getElementById('playerDiscImg');
  if (discImg2 && discPh2) {
    if (song.cover) {
      discImg2.src = song.cover;
      discImg2.style.display = 'block';
      discPh2.style.display = 'none';
    } else {
      discImg2.style.display = 'none';
      discPh2.style.display = 'flex';
    }
  }

  updateRingProgress(0);

  // 如果有预获取的 URL（来自 proxyPlay），则播放音频
  if (localUrl) {
    audio.src = localUrl;
    // 恢复播放进度
    const savedTime2 = await restorePlayProgress(song);
    if (savedTime2 > 0) {
      audio.addEventListener('loadedmetadata', () => {
        if (audio.duration > savedTime2) {
          audio.currentTime = savedTime2;
          showToast(`📍 从 ${Math.floor(savedTime2/60)}:${String(Math.floor(savedTime2%60)).padStart(2,'0')} 继续播放`, 'info', 2000);
        }
      }, { once: true });
    }
    audio.play().catch(() => {
      showToast('⚠️ 自动播放被拦截，请点击播放按钮', 'warn', 3000);
    });
  }

  // 尝试获取歌词
  try {
    const r = await api.getLyrics(song.id, song.source, song.title, song.artist);
    if (r && r.lrc) parseLrc(r.lrc);
  } catch (_e) { /* ignore */ }
}

// ── 切歌 ─────────────────────────────────────────────
export async function nextSong() {
  const playQueue = getState('playQueue');
  if (!playQueue || !playQueue.length) return;
  const isShuffled = getState('isShuffled');
  const loopMode = getState('loopMode');
  let playIdx = getState('playIdx');

  if (isShuffled) {
    playIdx = Math.floor(Math.random() * playQueue.length);
  } else if (loopMode === 1) {
    playIdx = (playIdx + 1) % playQueue.length;
  } else {
    // 不循环模式：到末尾则停止
    if (playIdx >= playQueue.length - 1) {
      updatePlayStatsOnStop();
      audio.pause();
      audio.currentTime = 0;
      return;
    }
    playIdx = playIdx + 1;
  }

  const song = playQueue[playIdx];
  setState('playIdx', playIdx);
  await playSongByIdx(playIdx, song);
}

export async function prevSong() {
  const playQueue = getState('playQueue');
  if (!playQueue || !playQueue.length) return;
  const isShuffled = getState('isShuffled');
  let playIdx = getState('playIdx');

  if (isShuffled) {
    playIdx = Math.floor(Math.random() * playQueue.length);
  } else {
    playIdx = Math.max(0, playIdx - 1);
  }

  const song = playQueue[playIdx];
  setState('playIdx', playIdx);
  await playSongByIdx(playIdx, song);
}

// 通用播放函数：根据索引播放队列中的歌曲
// 取流用智能接口（本源失败自动换源）；快速切歌用请求序号做竞态守卫，
// 旧请求返回时歌已切走则丢弃（借鉴 lx-music-desktop gettingUrlId 模式）
let _playRequestId = 0;

async function playSongByIdx(idx, song) {
  if (!song) return;
  const quality = document.getElementById('qualitySelect')?.value || 'standard';
  const reqId = ++_playRequestId;
  try {
    const result = await api.getDownloadUrlSmart(song, quality);
    if (reqId !== _playRequestId) return; // 已切到别的歌，丢弃过期结果
    if (!result || !result.url) {
      showToast('⚠️ 暂无法获取音源', 'warn', 3000);
      return;
    }
    if (result.matchedSong) {
      showToast(`🎵 本源不可用，已切换到${result.matchedSong.source}音源`, 'info', 3000);
      song._altSource = { source: result.matchedSong.source, id: String(result.matchedSong.id) };
      updatePlayerCard(song); // 换源徽标立即显示（不等下一次切歌）
    }
    const referer = (result.matchedSong?.source || song.source) === 'bilibili' ? 'https://www.bilibili.com/'
                  : (result.matchedSong?.source || song.source) === 'qq' ? 'https://y.qq.com/'
                  : (result.matchedSong?.source || song.source) === 'netease' ? 'https://music.163.com/' : '';
    const proxied = await api.proxyPlay(result.url, referer);
    if (reqId !== _playRequestId) return;
    if (!proxied || !proxied.fileUrl) {
      showToast('⚠️ 音源获取失败', 'error', 3000);
      return;
    }
    setState('currentPlaying', song);
    await loadAndPlay(song, proxied.fileUrl, true);
  } catch (e) {
    if (reqId === _playRequestId) logger.error('切歌失败:', e);
  }
}

// ── 播放控制 ─────────────────────────────────────────
export function togglePlay() {
  // 无音频源但有队列时：从当前 playIdx 开始播放
  if (audio.paused && (!audio.src || audio.src === '')) {
    const playQueue = getState('playQueue');
    if (Array.isArray(playQueue) && playQueue.length) {
      const playIdx = getState('playIdx');
      const song = playIdx >= 0 && playIdx < playQueue.length ? playQueue[playIdx] : playQueue[0];
      if (song) {
        setState('playIdx', playQueue.indexOf(song));
        loadAndPlay(song);
        return;
      }
    }
  }
  if (audio.paused) {
    audio.play().then(() => {}).catch(() => {});
  } else {
    // 暂停时保存播放进度
    const curSong = getState('currentPlaying');
    if (curSong && audio.currentTime > 0) { savePlayProgress(curSong, audio.currentTime); }
    updatePlayStatsOnStop();
    audio.pause();
  }
}

export function toggleShuffle() {
  const v = !getState('isShuffled');
  setState('isShuffled', v);
  updatePlayModeButton();
  showToast(v ? '随机播放 开' : '随机播放 关', 'info');
}

export function toggleLoop() {
  const v = (getState('loopMode') + 1) % 3;
  setState('loopMode', v);
  updatePlayModeButton();
  const labels = ['不循环', '列表循环', '单曲循环'];
  showToast(labels[v], 'info');
}

// ── 播放模式 ──────────────────────────────────────────
const PLAY_MODES = [
  { shuffle: false, loop: 0, label: '顺序播放' },
  { shuffle: true,  loop: 0, label: '随机播放' },
  { shuffle: false, loop: 1, label: '列表循环' },
  { shuffle: false, loop: 2, label: '单曲循环' },
];

// ── 播放模式按钮（合并随机+循环）─────────────────────
export function cyclePlayMode() {
  const isShuffled = getState('isShuffled');
  const loopMode = getState('loopMode');

  // 找到当前模式
  let currentIdx = 0;
  if (isShuffled && loopMode === 0) currentIdx = 1;
  else if (!isShuffled && loopMode === 1) currentIdx = 2;
  else if (!isShuffled && loopMode === 2) currentIdx = 3;

  // 切换到下一个模式
  const nextIdx = (currentIdx + 1) % PLAY_MODES.length;
  const next = PLAY_MODES[nextIdx];

  setState('isShuffled', next.shuffle);
  setState('loopMode', next.loop);
  updatePlayModeButton();
  showToast(next.label, 'info');
}

export function updatePlayModeButton() {
  const btn = document.getElementById('btnPlayMode');
  const icon = document.getElementById('btnPlayModeIcon');
  if (!btn || !icon) return;

  const isShuffled = getState('isShuffled');
  const loopMode = getState('loopMode');
  const isActive = isShuffled || loopMode > 0;

  // 更新图标和样式
  if (isActive) {
    btn.style.color = 'var(--neon-purple)';
    btn.style.filter = 'drop-shadow(0 0 6px rgba(167,139,250,0.8))';
  } else {
    btn.style.color = '';
    btn.style.filter = '';
  }

  // 更新 SVG 图标
  if (isShuffled && loopMode === 0) {
    // 随机播放
    icon.innerHTML = '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>';
  } else if (!isShuffled && loopMode === 1) {
    // 列表循环
    icon.innerHTML = '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>';
  } else if (!isShuffled && loopMode === 2) {
    // 单曲循环
    icon.innerHTML = '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="13" text-anchor="middle" font-size="7" fill="currentColor" stroke="none">1</text>';
  } else {
    // 顺序播放
    icon.innerHTML = '<circle cx="12" cy="12" r="10"/>';
  }

  // tooltip / aria-label 随模式更新：纯图标很难分辨四种模式，悬停提示+读屏器
  // 需要告知当前模式和点击后切换到什么
  const modeNames = { shuffle: '随机播放', list: '列表循环', one: '单曲循环', order: '顺序播放' };
  const nextNames = { shuffle: '列表循环', list: '单曲循环', one: '顺序播放', order: '随机播放' };
  let cur = modeNames.order, next = nextNames.order;
  if (isShuffled && loopMode === 0) { cur = modeNames.shuffle; next = nextNames.shuffle; }
  else if (!isShuffled && loopMode === 1) { cur = modeNames.list; next = nextNames.list; }
  else if (!isShuffled && loopMode === 2) { cur = modeNames.one; next = nextNames.one; }
  btn.title = `${cur}（点击切换：${next}）`;
  btn.setAttribute('aria-label', `播放模式：${cur}，点击切换到${next}`);
}

// ── 封面动画控制 ─────────────────────────────────────
let _coverAnimation = 'rotate'; // 'rotate' | 'pulse' | 'none'

export function setCoverAnimation(style) {
  _coverAnimation = style;
  const disc = document.getElementById('playerDiscInner');
  if (!disc) return;
  disc.className = 'player-disc-inner animation-' + style;
}

export function cycleCoverAnimation() {
  const styles = ['rotate', 'pulse', 'none'];
  const idx = styles.indexOf(_coverAnimation);
  const next = styles[(idx + 1) % styles.length];
  setCoverAnimation(next);
  const labels = { rotate: '旋转', pulse: '脉动', none: '静态' };
  showToast('封面动画：' + labels[next], 'info');
}

// ── 应用关闭时释放 AudioContext ────────────────────
window.addEventListener('beforeunload', () => {
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
});

// ── 音量控制 ──────────────────────────────────────────
export function setVolume(value) {
  const vol = Math.max(0, Math.min(100, parseInt(value) || 0));
  audio.volume = vol / 100;
  const slider = document.getElementById('volumeSlider');
  const label = document.getElementById('volumeValue');
  const btn = document.getElementById('volumeBtn');
  if (slider) slider.value = vol;
  if (label) label.textContent = vol + '%';
  if (typeof _persistVolume === 'function') _persistVolume();
  // 更新图标
  if (btn) {
    if (vol === 0) {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
    } else if (vol < 50) {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>';
    } else {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
    }
  }
}

export function toggleMute() {
  if (audio.volume > 0) {
    audio._prevVolume = audio.volume;
    setVolume(0);
  } else {
    setVolume(Math.round((audio._prevVolume || 0.8) * 100));
  }
}

// 初始化音量：恢复上次记住的音量（prefs.playerVolume），无记录则 80%。
// 注意恢复逻辑须等 window.api 就绪——player.js 被 app.js import 时 api getter
// 可能尚未挂上（模块体先于 app.js 执行），故挂 DOMContentLoaded 而非模块加载时执行
audio.volume = 0.8;
(function scheduleVolumeRestore() {
  const restore = () => {
    if (typeof window.api !== 'undefined' && typeof window.api.getPref === 'function') {
      window.api.getPref('playerVolume')
        .then(v => { if (typeof v === 'number' && !isNaN(v)) setVolume(Math.round(Math.min(1, Math.max(0, v)) * 100)); })
        .catch(() => {});
    }
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(restore, 0);
  } else {
    document.addEventListener('DOMContentLoaded', restore, { once: true });
  }
})();
// 音量记忆：变更后防抖写 prefs（拖动滑条时 setVolume 高频触发，不能每步都写盘）
let _volPersistTimer = null;
function _persistVolume() {
  if (_volPersistTimer) clearTimeout(_volPersistTimer);
  _volPersistTimer = setTimeout(() => {
    _volPersistTimer = null;
    try { if (typeof api !== 'undefined' && typeof api.setPref === 'function') api.setPref('playerVolume', audio.volume); } catch (_e) { /* 持久化失败不影响音量本身 */ }
  }, 600);
}

// ── 音量弹层交互升级：拖动锁定 + 滚轮调节 ─────────────
// 旧交互仅 hover：拖动滑条到一半移出弹层直接断（opacity:0 + pointer-events:none
// 立即生效），且除拖滑条外无快速调节手段。
// 改为：滑条按下/聚焦期间弹层锁定显示（.pinned），松手 800ms 后自动收回；
// 滚轮在音量按钮或弹层上直接 ±5%。
function _initVolumeUX() {
  const wrap = document.getElementById('pcVolume');
  const slider = document.getElementById('volumeSlider');
  if (!wrap || !slider) return;
  let releaseTimer = null;
  const pin = () => { wrap.classList.add('pinned'); if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; } };
  const scheduleRelease = () => {
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => { wrap.classList.remove('pinned'); releaseTimer = null; }, 800);
  };
  slider.addEventListener('pointerdown', pin);
  slider.addEventListener('focus', pin);
  slider.addEventListener('pointerup', scheduleRelease);
  slider.addEventListener('blur', scheduleRelease);
  // 拖动结束后指针通常已移出弹层，靠 pinned 保持收尾视觉一致
  slider.addEventListener('change', scheduleRelease);
  // 滚轮调节：在音量控件任意位置滚动直接加减，不必打开弹层
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cur = Math.round(audio.volume * 100);
    const next = Math.max(0, Math.min(100, cur + (e.deltaY < 0 ? 5 : -5)));
    if (next !== cur) setVolume(next);
  }, { passive: false });
}
window.addEventListener('beforeunload', () => {
  if (_volPersistTimer) { clearTimeout(_volPersistTimer); _volPersistTimer = null; }
  try { if (typeof api !== 'undefined' && typeof api.setPref === 'function') api.setPref('playerVolume', audio.volume); } catch (_e) { /* 同上：尽力写盘 */ }
});

// ── 环形进度 ─────────────────────────────────────────
function updateRingProgress(fraction) {
  const ring = document.getElementById('ringFill');
  if (!ring) return;
  const offset = RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, fraction)));
  ring.style.strokeDashoffset = offset;
}

// ── 进度条 ───────────────────────────────────────────
let _lastProgressSave = 0;
export function updateProgress() {
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  const fraction = audio.duration ? audio.currentTime / audio.duration : 0;
  const fill = document.getElementById('playerProgressFill');
  if (fill) fill.style.width = pct + '%';
  const thumb = document.getElementById('playerProgressThumb');
  if (thumb) thumb.style.left = 'calc(' + pct + '% - 5px)';
  const bar = document.getElementById('playerProgressBar');
  if (bar) bar.setAttribute('aria-valuenow', Math.round(pct));
  const now = document.getElementById('timeNow');
  if (now) now.textContent = fmtTime(audio.currentTime);
  const total = document.getElementById('timeTotal');
  if (total) total.textContent = fmtTime(audio.duration);
  updateRingProgress(fraction);
  updateLyric(audio.currentTime);
  // 每 30 秒自动保存播放进度
  const t = Date.now();
  if (t - _lastProgressSave > 30000 && audio.currentTime > 5) {
    _lastProgressSave = t;
    const curSong = getState('currentPlaying');
    if (curSong) savePlayProgress(curSong, audio.currentTime);
  }
}

export function seekAudio(e) {
  const bar = document.getElementById('playerProgressBar');
  if (!bar) return;
  const pct = _pointerToPct(bar, e);
  if (audio.duration) audio.currentTime = pct * audio.duration;
}

/** 指针事件 → 进度百分比（0~1，含边界钳制） */
function _pointerToPct(bar, e) {
  const rect = bar.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

/** 百分比 → 显示时间文本 */
function _fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

/**
 * 进度条拖动（scrubbing）：按住拖动实时预览进度，松手落定。
 * 替代旧版"只能点击"的交互——4px 命中区 + 无拖动是播放器最常见的可用性抱怨。
 * 悬停时显示时间预览气泡（progressHoverTime）。
 */
function _initProgressDrag() {
  const bar = document.getElementById('playerProgressBar');
  if (!bar) return;
  const fill = document.getElementById('playerProgressFill');
  const thumb = document.getElementById('playerProgressThumb');
  const hoverTime = document.getElementById('progressHoverTime');
  const ariaTarget = bar;

  // 悬停预览：指针在轨道上移动时显示对应时间气泡
  bar.addEventListener('pointermove', (e) => {
    if (!audio.duration || bar.classList.contains('dragging')) return;
    const pct = _pointerToPct(bar, e);
    if (hoverTime) {
      hoverTime.textContent = _fmtTime(pct * audio.duration);
      hoverTime.style.left = (pct * 100) + '%';
    }
  });

  // 拖动开始：按住即进入 scrubbing，实时移动填充和气泡
  bar.addEventListener('pointerdown', (e) => {
    if (!audio.duration) return;
    e.preventDefault();
    bar.classList.add('dragging');
    bar.setPointerCapture(e.pointerId);
    const preview = (pct) => {
      if (fill) fill.style.width = (pct * 100) + '%';
      if (thumb) thumb.style.left = 'calc(' + (pct * 100) + '% - 5px)';
      if (hoverTime) {
        hoverTime.textContent = _fmtTime(pct * audio.duration);
        hoverTime.style.left = (pct * 100) + '%';
      }
      if (ariaTarget) ariaTarget.setAttribute('aria-valuenow', Math.round(pct * 100));
    };
    preview(_pointerToPct(bar, e));
    const onMove = (ev) => preview(_pointerToPct(bar, ev));
    const onUp = (ev) => {
      bar.classList.remove('dragging');
      bar.removeEventListener('pointermove', onMove);
      try { bar.releasePointerCapture(ev.pointerId); } catch (_e) { /* 已释放 */ }
      const pct = _pointerToPct(bar, ev);
      if (audio.duration) audio.currentTime = pct * audio.duration;
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp, { once: true });
    bar.addEventListener('pointercancel', () => {
      bar.classList.remove('dragging');
      bar.removeEventListener('pointermove', onMove);
    }, { once: true });
  });

  // 键盘可达：←/→ 微调 5 秒
  bar.tabIndex = 0;
  bar.addEventListener('keydown', (e) => {
    if (!audio.duration) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? 30 : 5;
      audio.currentTime = Math.max(0, Math.min(audio.duration,
        audio.currentTime + (e.key === 'ArrowLeft' ? -step : step)));
    }
  });
}

export function onAudioEnded() {
  const loopMode = getState('loopMode');
  // 播放结束时清除进度记忆（已播完不需要恢复）
  const curSong = getState('currentPlaying');
  if (curSong) { try { savePlayProgress(curSong, 0); } catch (_e) { /* ignore */ } }
  if (loopMode === 2) {
    // 修复：单曲循环时也要记录播放时长，避免统计丢失
    updatePlayStatsOnStop();
    _currentPlayStartTime = Date.now(); // 重置计时起点
    audio.currentTime = 0;
    audio.play().then(() => {}).catch(() => {});
    return;
  }
  updatePlayStatsOnStop();
  nextSong();
}

// ── 歌词系统（逐字高亮）──────────────────────────────
export function parseLrc(lrc) {
  if (!lrc) { showNoLyrics(); return; }
  const parsedLyrics = [];
  let hasLangTags = false;

  // 第一遍：解析所有行，检测 [lang:xx] 标签
  const rawEntries = [];
  lrc.split('\n').forEach(line => {
    const langTagMatch = line.match(/^\[lang:(\w+)\]/);
    if (langTagMatch) {
      hasLangTags = true;
      // 提取 [lang:xx] 后面的时间戳和文本
      const rest = line.slice(langTagMatch[0].length);
      const m = rest.match(/\[(\d+):(\d+\.?\d*)\](.*)/);
      if (m) {
        rawEntries.push({
          lang: langTagMatch[1],
          t: parseInt(m[1]) * 60 + parseFloat(m[2]),
          text: m[3].trim()
        });
      }
    } else {
      const m = line.match(/\[(\d+):(\d+\.?\d*)\](.*)/);
      if (m) {
        rawEntries.push({
          lang: null,
          t: parseInt(m[1]) * 60 + parseFloat(m[2]),
          text: m[3].trim()
        });
      }
    }
  });

  if (hasLangTags) {
    // 双语模式：按时间戳分组，合并主语言和副语言
    const byTime = new Map(); // key = time, value = {main: text, sub: text}
    rawEntries.forEach(e => {
      const key = e.t.toFixed(3);
      if (!byTime.has(key)) {
        byTime.set(key, { t: e.t, text: '', subText: '' });
      }
      const entry = byTime.get(key);
      // 第一个出现的语言为主语言，第二个为副语言
      if (!entry.text) {
        entry.text = e.text;
      } else if (!entry.subText) {
        entry.subText = e.text;
      }
    });
    // 转为数组并排序
    for (const entry of byTime.values()) {
      parsedLyrics.push(entry);
    }
  } else {
    // 单语模式：保持原有行为
    rawEntries.forEach(e => {
      parsedLyrics.push({ t: e.t, text: e.text, subText: '' });
    });
  }

  parsedLyrics.sort((a, b) => a.t - b.t);

  const lyricsArea = document.getElementById('lyricsArea');
  if (!parsedLyrics.length) { showStaticLyrics(lrc); return; }

  // 为每行计算逐字时间戳（仅基于主语言文本）
  for (let i = 0; i < parsedLyrics.length; i++) {
    const cur = parsedLyrics[i];
    const next = parsedLyrics[i + 1];
    const lineDuration = next ? (next.t - cur.t) : 3; // 默认 3 秒
    // 按字符拆分（CJK 每字一个 span，英文按空格分词）
    cur.words = splitToWords(cur.text);
    const wordDuration = lineDuration / Math.max(cur.words.length, 1);
    cur.wordTimes = cur.words.map((_, j) => cur.t + j * wordDuration);
  }

  const hasBilingual = parsedLyrics.some(l => l.subText);

  if (lyricsArea) {
    // 手动隐藏时内容照常解析（恢复时立即可用），只是不显示
    lyricsArea.style.display = _lyricsHiddenByUser ? 'none' : 'block';
    lyricsArea.classList.remove('static-mode');
    lyricsArea.innerHTML = parsedLyrics.map((l, i) => {
    const wordSpans = l.words.map((w, j) =>
      `<span class="lyric-word" data-t="${l.wordTimes[j].toFixed(2)}">${esc(w)}</span>`
    ).join('');
    const subHtml = l.subText
      ? `<div class="lyric-sub-text">${esc(l.subText)}</div>`
      : '';
    return `<div class="lyric-line${hasBilingual ? ' bilingual' : ''}" id="lyric-${i}">${wordSpans || '&nbsp;'}${subHtml}</div>`;
  }).join('');
  // 应用歌词字体大小
  if (lyricsArea) lyricsArea.style.fontSize = _lyricFontSize + 'px';
  }
  setState('parsedLyrics', parsedLyrics);
  // 重置歌词 DOM 缓存
  _cachedLyricEls = null;
  _cachedLyricCount = 0;
  _prevLyricIdx = -1;
}

/** 将歌词文本拆分为单词/字符数组（CJK 逐字，英文按空格） */
function splitToWords(text) {
  if (!text) return [];
  const words = [];
  let buf = '';
  for (const ch of text) {
    if (ch >= '\u4e00' && ch <= '\u9fff' || ch >= '\u3400' && ch <= '\u4dbf') {
      // CJK 字符：每个字单独
      if (buf) { words.push(buf); buf = ''; }
      words.push(ch);
    } else if (ch === ' ') {
      if (buf) { words.push(buf); buf = ''; }
      words.push(' ');
    } else {
      buf += ch;
    }
  }
  if (buf) words.push(buf);
  return words;
}

export function showStaticLyrics(text) {
  const lyricsArea = document.getElementById('lyricsArea');
  if (!text || !text.trim()) { showNoLyrics(); return; }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length || !lyricsArea) { showNoLyrics(); return; }
  lyricsArea.style.display = _lyricsHiddenByUser ? 'none' : 'block';
  lyricsArea.classList.add('static-mode');
  lyricsArea.innerHTML = lines.map(l => `<div class="lyric-line static">${esc(l)}</div>`).join('');
  lyricsArea.style.fontSize = _lyricFontSize + 'px';
  lyricsArea.scrollTop = 0;
  setState('parsedLyrics', []);
}

export function showNoLyrics() {
  const lyricsArea = document.getElementById('lyricsArea');
  if (!lyricsArea) return;
  // 用户手动隐藏歌词时保持隐藏（只切按钮态，不弹"暂无歌词"占位）
  if (_lyricsHiddenByUser) { lyricsArea.style.display = 'none'; return; }
  lyricsArea.style.display = 'flex';
  lyricsArea.classList.add('static-mode');
  lyricsArea.innerHTML = '<div class="lyric-line static" style="text-align:center;opacity:0.45">暂无歌词</div>';
  setState('parsedLyrics', []);
}

// ── 歌词区手动开关（用户控制"全有或全无"的弹出） ──────────
// 默认跟随后端自动行为（有词显示/无词占位/切歌清空）；
// 用户点按钮后进入手动模式：隐藏时任何歌词加载都不再弹出，
// 再点恢复自动。偏好持久化到 prefs.lyricsVisible。
let _lyricsHiddenByUser = false;
export function toggleLyricsArea() {
  _lyricsHiddenByUser = !_lyricsHiddenByUser;
  const lyricsArea = document.getElementById('lyricsArea');
  const btn = document.getElementById('btnLyricsToggle');
  if (lyricsArea) {
    lyricsArea.style.display = _lyricsHiddenByUser ? 'none' : '';
    // 恢复时若当前无词，重新展示占位（保持"暂无歌词"的语义可见）
    if (!_lyricsHiddenByUser && !(getState('parsedLyrics') || []).length) showNoLyrics();
  }
  if (btn) {
    btn.classList.toggle('active', !_lyricsHiddenByUser);
    btn.setAttribute('aria-pressed', String(!_lyricsHiddenByUser));
  }
  try { if (typeof api !== 'undefined' && api.setPref) api.setPref('lyricsVisible', !_lyricsHiddenByUser); } catch (_e) { /* 持久化失败不影响本次切换 */ }
}
window.toggleLyricsArea = toggleLyricsArea;

// 启动时恢复用户歌词显隐偏好（默认显示），并同步按钮初始态
(function restoreLyricsPref() {
  const restore = () => {
    const btn = document.getElementById('btnLyricsToggle');
    try {
      if (typeof window.api !== 'undefined' && window.api.getPref) {
        window.api.getPref('lyricsVisible').then(v => {
          if (v === false) {
            _lyricsHiddenByUser = false; toggleLyricsArea(); // 切一次 → 隐藏
          } else {
            // 默认/记忆为显示：按钮态设为"开"（歌词区本身由加载流程控制显隐）
            if (btn) { btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true'); }
          }
        }).catch(() => { if (btn) { btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true'); } });
      } else if (btn) {
        btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true');
      }
    } catch (_e) { /* ignore */ }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restore, { once: true });
  } else {
    setTimeout(restore, 0);
  }
})();

// 缓存歌词 DOM 元素，避免每次 timeupdate 重复查询
let _cachedLyricEls = null;
let _cachedLyricCount = 0;
let _prevLyricIdx = -1;

export function updateLyric(t) {
  const parsedLyrics = getState('parsedLyrics');
  if (!parsedLyrics || !parsedLyrics.length) return;
  // 应用歌词时间偏移（offset 单位 ms，t 单位 s）
  const adjustedT = t + _lyricOffset / 1000;
  let idx = parsedLyrics.findIndex(l => l.t > adjustedT) - 1;
  if (idx < 0) idx = 0;

  // 只在歌词行变化时更新 DOM
  if (idx === _prevLyricIdx) return;
  const prevIdx = _prevLyricIdx;
  _prevLyricIdx = idx;

  // 首次或歌词变化时缓存 DOM
  if (!_cachedLyricEls || _cachedLyricCount !== parsedLyrics.length) {
    _cachedLyricEls = document.querySelectorAll('.lyric-line');
    _cachedLyricCount = parsedLyrics.length;
  }
  const els = _cachedLyricEls;

  // 防御性检查：确保 DOM 元素存在
  if (!els || els.length === 0) return;

  // 只更新上一行和当前行，跳过不变的行
  if (prevIdx >= 0 && prevIdx < els.length && els[prevIdx]) {
    els[prevIdx].classList.remove('active');
    els[prevIdx].querySelectorAll('.lyric-word').forEach(w => w.classList.remove('word-active'));
  }
  if (idx >= 0 && idx < els.length && els[idx]) {
    const el = els[idx];
    el.classList.add('active');
    // 居中滚动：本 Chromium 下 CSS scroll-behavior:smooth 会让 scrollIntoView 立即滚
    // 却又静默丢帧（表现为 scrollTop 恒 0、当前行永远停在列表底部之外），故手动计算居中位置
    const la = document.getElementById('lyricsArea');
    if (la) {
      const target = el.offsetTop - (la.clientHeight - el.offsetHeight) / 2;
      la.scrollTop = Math.max(0, Math.min(target, la.scrollHeight - la.clientHeight));
    }
    // 逐字高亮
    const words = el.querySelectorAll('.lyric-word');
    words.forEach(w => {
      const wt = parseFloat(w.dataset.t);
      const nextLine = parsedLyrics[idx + 1];
      const lineEnd = nextLine ? nextLine.t : parsedLyrics[idx].t + 3;
      w.classList.toggle('word-active', adjustedT >= wt && adjustedT < lineEnd);
    });
  }
}

// esc() 和 fmtTime() 已由 utils.js 全局导出，此处不再重复定义

// ── ES Module 导出（其余函数已在定义处 export） ─────
// 已通过 export 前缀导出的函数：
//   applyEqPreset, toggleEqBypass, setEqBand, resetEq, saveEqSettings,
//   updatePlayerCard, getRecentlyPlayed, loadRecentlyPlayed, clearRecentlyPlayed,
//   getPlayStats, getMostPlayed, resetPlayStats, generatePlayReport, loadPlayStats,
//   loadAndPlay, nextSong, prevSong, togglePlay, toggleShuffle, toggleLoop,
//   cyclePlayMode, updatePlayModeButton, setCoverAnimation, cycleCoverAnimation,
//   setVolume, toggleMute, updateProgress, seekAudio, onAudioEnded,
//   parseLrc, showStaticLyrics, showNoLyrics, updateLyric

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
// 进度条拖动/悬停预览/键盘微调 + 音量拖动锁定/滚轮调节。
// module script 在 DOM 解析完后执行，但仍加 readyState 守卫以防未来加载位置变动。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { _initProgressDrag(); _initVolumeUX(); }, { once: true });
} else {
  _initProgressDrag();
  _initVolumeUX();
}
window.loadAndPlay = loadAndPlay;
window.togglePlay = togglePlay;
window.updateProgress = updateProgress;
window.seekAudio = seekAudio;
window.onAudioEnded = onAudioEnded;
window.nextSong = nextSong;
window.prevSong = prevSong;
window.toggleShuffle = toggleShuffle;
window.toggleLoop = toggleLoop;
window.cyclePlayMode = cyclePlayMode;
window.updatePlayModeButton = updatePlayModeButton;
window.parseLrc = parseLrc;
window.showStaticLyrics = showStaticLyrics;
window.showNoLyrics = showNoLyrics;
window.updateLyric = updateLyric;
window.setCoverAnimation = setCoverAnimation;
window.cycleCoverAnimation = cycleCoverAnimation;
window.updatePlayerCard = updatePlayerCard;
window.setEqBand = setEqBand;
window.resetEq = resetEq;
window.saveEqSettings = saveEqSettings;
window.applyEqPreset = applyEqPreset;
window.toggleEqBypass = toggleEqBypass;
window.restoreEqPresetSetting = restoreEqPresetSetting;
window.setVolume = setVolume;
window.toggleMute = toggleMute;
window.getRecentlyPlayed = getRecentlyPlayed;
window.clearRecentlyPlayed = clearRecentlyPlayed;
window.loadRecentlyPlayed = loadRecentlyPlayed;
window.getPlayStats = getPlayStats;
window.getMostPlayed = getMostPlayed;
window.resetPlayStats = resetPlayStats;
window.generatePlayReport = generatePlayReport;
window.loadPlayStats = loadPlayStats;
