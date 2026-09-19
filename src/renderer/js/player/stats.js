/**
 * MusicDL 播放器 — 最近播放 / 播放统计 / 听歌报告
 *
 * 自 player.js 拆出：纯数据统计与弹窗，不参与音频播放控制。
 * 依赖全局：api、showToast、esc（由 preload / utils.js 注入）
 */

// ── 播放 ─────────────────────────────────────────────
// 最近播放记录（内存缓存，最多 50 首）
const _recentlyPlayed = [];
const MAX_RECENT = 50;

export function addToRecentlyPlayed(song) {
  if (!song || !song.title) return;
  // 去重：移除已存在的同歌曲
  const idx = _recentlyPlayed.findIndex(s =>
    s.title === song.title && s.artist === song.artist && s.source === song.source
  );
  if (idx >= 0) _recentlyPlayed.splice(idx, 1);
  // 添加到最前面（id/filePath 必须保留：最近播放条目可点击重播，
  // 取流要 id+source、本地歌曲要 filePath —— 剥掉后整块点不动）
  _recentlyPlayed.unshift({
    id: song.id,
    title: song.title,
    artist: song.artist || '未知艺术家',
    album: song.album || '',
    source: song.source || '',
    filePath: song.filePath || '',
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

export function updatePlayStatsOnStart() {
  _currentPlayStartTime = Date.now();
}

export function updatePlayStatsOnStop() {
  if (_currentPlayStartTime) {
    const elapsed = Math.floor((Date.now() - _currentPlayStartTime) / 1000);
    _playStats.totalPlayTime += elapsed;
    _currentPlayStartTime = null;
    persistPlayStats();
  }
}

export function recordPlay(song) {
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

// ── 单曲循环时重置计时起点 ───────────────────────────
export function restartPlayTimer() {
  _currentPlayStartTime = Date.now();
}
