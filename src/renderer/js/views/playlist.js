/**
 * MusicDL 用户歌单视图
 *
 * 2026-09-14 重建：原文件因批量编辑事故留下 6 处函数体未闭合（靠文件尾
 * 游离 `}` 凑配平），且所有函数未挂 window——HTML onclick 无法调用，
 * 页面容器（userPlaylistGrid 等）也不存在于 index.html，属"从未接通"
 * 的半成品。本版修复结构 + 桥接 + 配套 UI 容器，与后端 ipc/playlist.js
 * （5 个 handler，prefs 持久化）完整接通。
 */

import { logger } from '../logger.js';
import { loadAndPlay } from '../player.js';
import { HEART_ON } from '../favorites.js';
import { resolveQuality } from '../quality.js';
import { dlBadgeHtml, dlEnsureHistoryLoaded, addDlChangeListener } from '../dlStatus.js';

// ── 状态 ─────────────────────────────────────────────
let _currentPlaylistId = null;
let _currentDetailSongs = [];
// 取流用智能接口（本源失败自动换源）；请求序号做竞态守卫，快速连点只认最后一次
let _playlistPlayRequestId = 0;

// ── 加载歌单列表 ──────────────────────────────────────
async function loadUserPlaylists() {
  try {
    const playlists = await api.getUserPlaylists();
    setState('userPlaylists', playlists || []);
    renderPlaylistList(playlists || []);
  } catch (e) {
    logger.error('加载歌单失败:', e);
    showToast('加载歌单失败: ' + e.message, 'error');
  }
}

// ── 渲染歌单列表 ──────────────────────────────────────
function renderPlaylistList(playlists) {
  const container = document.getElementById('userPlaylistGrid');
  if (!container) return;

  if (!playlists || playlists.length === 0) {
    container.innerHTML = `
      <div class="empty-hint" style="grid-column:1/-1;text-align:center;padding:40px 0;">
        <div style="font-size:40px;margin-bottom:12px">🎼</div>
        <div>暂无歌单</div>
        <div style="font-size:12px;margin-top:6px;color:var(--neon-dim);">点击上方"新建歌单"创建你的第一个歌单</div>
      </div>`;
    return;
  }

  container.innerHTML = playlists.map(pl => `
    <div class="playlist-card" data-id="${escAttr(pl.id)}" onclick="openPlaylistDetail('${escQ(pl.id)}')">
      <div class="playlist-card-cover">
        ${pl.cover ? `<img src="${escAttr(pl.cover)}" alt="${esc(pl.name)}" onerror="this.style.display='none'">` : `<div class="playlist-card-placeholder">${pl.system ? HEART_ON : '📋'}</div>`}
        <div class="playlist-card-overlay">
          <span class="playlist-card-count">${pl.songs?.length || 0} 首</span>
        </div>
      </div>
      <div class="playlist-card-info">
        <div class="playlist-card-name" title="${esc(pl.name)}">${esc(pl.name)}</div>
        ${pl.desc ? `<div class="playlist-card-desc">${esc(pl.desc)}</div>` : ''}
      </div>
      <div class="playlist-card-actions" onclick="event.stopPropagation()">
        ${pl.system
          ? ''
          : `<button class="action-btn" onclick="editPlaylist('${escQ(pl.id)}')" title="编辑">✏️</button>
        <button class="action-btn" onclick="deletePlaylist('${escQ(pl.id)}')" title="删除">🗑️</button>`}
      </div>
    </div>
  `).join('');
}

// ── 打开歌单详情 ──────────────────────────────────────
async function openPlaylistDetail(playlistId) {
  try {
    _currentPlaylistId = playlistId;
    const playlists = getState('userPlaylists') || [];
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return;
    _currentDetailSongs = pl.songs || [];

    document.getElementById('playlistDetailTitle').textContent = pl.name;
    document.getElementById('playlistDetailDesc').textContent = pl.desc || '暂无描述';
    renderPlaylistDetailSongs(pl.songs || []);

    document.getElementById('playlistDetailModal').classList.remove('hidden');
  } catch (e) {
    logger.error('[openPlaylistDetail] error:', e);
  }
}

function closePlaylistDetail() {
  document.getElementById('playlistDetailModal').classList.add('hidden');
  _currentPlaylistId = null;
  _currentDetailSongs = [];
}

// ── 渲染歌单歌曲列表 ──────────────────────────────────
function renderPlaylistDetailSongs(songs) {
  const list = document.getElementById('playlistDetailSongs');
  if (!list) return;
  _currentDetailSongs = songs || [];
  dlEnsureHistoryLoaded(); // 跨会话"已下载"懒回填，完成后经监听器重渲染徽标

  if (!songs || songs.length === 0) {
    list.innerHTML = '<div class="empty-hint" style="text-align:center;padding:30px 0;">歌单为空，去搜索页添加喜欢的歌曲吧</div>';
    return;
  }

  list.innerHTML = songs.map((song, idx) => `
    <div class="song-row" ondblclick="playPlaylistSong(${idx})">
      <span class="song-num" style="color:var(--neon-dim);font-size:12px;width:22px;text-align:right;flex-shrink:0;">${idx + 1}</span>
      <div class="song-info">
        <div class="song-title" title="${esc(song.title)}">${esc(song.title) || '未知'}</div>
        <div class="song-meta">${esc(song.artist) || '未知艺术家'}${song.album ? ' · ' + esc(song.album) : ''}</div>
      </div>
      ${dlBadgeHtml(song, getState('queueSnapshot') || [])}
      <span class="song-duration">${song.duration ? fmtDuration(song.duration) : '--:--'}</span>
      <div class="song-actions">
        <button class="action-btn" onclick="playPlaylistSong(${idx})" title="播放">▶</button>
        <button class="action-btn" onclick="downloadPlaylistSong(${idx})" title="加入下载队列">⬇</button>
        <button class="action-btn" onclick="addPlaylistSongToQueue(${idx})" title="加入播放队列">➕</button>
        <button class="action-btn" onclick="removeSongFromPlaylist('${escQ(String(song.id))}','${escQ(String(song.source || ''))}')" title="从歌单移除">✕</button>
      </div>
    </div>
  `).join('');
}

// ── 播放歌单中的歌曲 ──────────────────────────────────
async function playPlaylistSong(idx) {
  const songs = _currentDetailSongs;
  const song = songs[idx];
  if (!song) { showToast('未找到歌曲', 'warn'); return; }
  const quality = resolveQuality(song.source);
  showToast(`正在准备音源：${song.title}`, 'info');
  const reqId = ++_playlistPlayRequestId;
  try {
    const result = await api.getDownloadUrlSmart(song, quality);
    if (reqId !== _playlistPlayRequestId) return; // 已点别的歌，丢弃过期结果
    if (!result || !result.url) {
      if (result && result.code === 'VIP_REQUIRED') {
        showToast('⚠️ 该歌曲为 VIP 专享，请登录后重试', 'warn', 5000);
      } else {
        showToast('⚠️ 暂无法获取音源，请稍后重试', 'warn', 5000);
      }
      return;
    }
    if (result.matchedSong) {
      showToast(`🎵 本源不可用，已切换到${result.matchedSong.source}音源`, 'info', 3000);
      song._altSource = { source: result.matchedSong.source, id: String(result.matchedSong.id) };
    }
    const playSource = result.matchedSong?.source || song.source;
    const referer = playSource === 'bilibili' ? 'https://www.bilibili.com/'
                  : playSource === 'qq' ? 'https://y.qq.com/'
                  : playSource === 'netease' ? 'https://music.163.com/' : '';
    const proxied = await api.proxyPlay(result.url, referer);
    if (reqId !== _playlistPlayRequestId) return;
    if (!proxied || !proxied.fileUrl) {
      showToast('⚠️ 音源获取失败', 'error', 5000);
      return;
    }
    // 整个歌单作为播放队列，从点击的歌开始
    setState('playQueue', songs.slice());
    setState('playIdx', idx);
    // currentPlaying 驱动托盘/迷你播放器/播放器卡片，也是 audio error 守卫的前置条件
    setState('currentPlaying', song);
    await loadAndPlay(song, proxied.fileUrl, true);
    showToast('▶ 正在播放：' + song.title, 'success', 2500);
  } catch (e) {
    if (reqId === _playlistPlayRequestId) {
      logger.warn('播放失败:', e);
      showToast('⚠️ 播放失败：' + (e.message || e), 'error', 4000);
    }
  }
}

// ── 添加歌单歌曲到播放队列 ─────────────────────────────
function addPlaylistSongToQueue(idx) {
  const song = _currentDetailSongs[idx];
  if (!song) return;
  const q = (getState('playQueue') || []).slice();
  q.push(song);
  setState('playQueue', q);
  showToast('✅ 已加入播放队列', 'success');
}

// ── 下载：单曲入队 / 整单入队（语义与搜索页 addDownload 一致）──
async function downloadPlaylistSong(idx) {
  const song = _currentDetailSongs[idx];
  if (!song) return;
  const existing = (getState('queueSnapshot') || []).find(q =>
    q.id === song.id && q.source === song.source && q.status !== 'done');
  if (existing) { showToast(`「${song.title}」已在队列中`, 'warn', 2500); return; }
  const saveDir = getState('saveDir');
  const quality = resolveQuality(song.source);
  try {
    const r = await api.addToQueue({ ...song, saveDir, quality });
    if (r && r.duplicated) { showToast(`「${song.title}」已在下载队列中`, 'warn', 2500); return; }
    if (r && r.alreadyDownloaded) {
      showRedownloadToast(song.title, r.finishedAt, () => {
        api.addToQueue({ ...song, saveDir, quality, forceRedownload: true })
          .then(() => showToast(`「${song.title}」已加入下载队列`, 'success'))
          .catch(e => showToast('加入失败: ' + (e.message || e), 'error'));
      });
      return;
    }
    if (r && r.queued) showToast(`「${song.title}」已加入下载队列`, 'success');
    else showToast((r && r.error) || '加入下载队列失败', 'error');
  } catch (e) {
    showToast('加入下载队列失败: ' + (e.message || e), 'error');
  }
}

async function downloadAllPlaylist() {
  const songs = _currentDetailSongs.slice();
  if (!songs.length) { showToast('歌单为空', 'warn'); return; }
  const saveDir = getState('saveDir');
  let queued = 0, inQueue = 0, dlSkipped = 0;
  for (const song of songs) {
    const existing = (getState('queueSnapshot') || []).find(q =>
      q.id === song.id && q.source === song.source && q.status !== 'done');
    if (existing) { inQueue++; continue; }
    try {
      // 批量场景：历史已下载且文件还在 → 静默跳过（同 downloadAlbum）
      const r = await api.addToQueue({ ...song, saveDir, quality: resolveQuality(song.source) });
      if (r && r.queued) queued++;
      else if (r && r.alreadyDownloaded) dlSkipped++;
    } catch (e) { logger.warn('歌单批量入队失败:', song.title, e.message); }
  }
  let msg = `歌单 ${queued} 首已加入下载队列`;
  const skippedParts = [];
  if (inQueue) skippedParts.push(`${inQueue} 首已在队列`);
  if (dlSkipped) skippedParts.push(`${dlSkipped} 首已下载过`);
  if (skippedParts.length) msg += `（跳过 ${skippedParts.join('，')}）`;
  showToast(msg, queued || dlSkipped ? 'success' : 'info');
}

// 详情弹窗打开期间队列/历史变化 → 防抖重渲染徽标
let _plDlTimer = null;
addDlChangeListener(() => {
  const modal = document.getElementById('playlistDetailModal');
  if (!modal || modal.classList.contains('hidden') || _plDlTimer) return;
  _plDlTimer = setTimeout(() => {
    _plDlTimer = null;
    if (_currentPlaylistId && _currentDetailSongs.length) renderPlaylistDetailSongs(_currentDetailSongs);
  }, 300);
});

// ── 从歌单移除歌曲 ─────────────────────────────────────
async function removeSongFromPlaylist(songId, source) {
  if (!_currentPlaylistId) return;
  try {
    const result = await api.removeFromUserPlaylist(_currentPlaylistId, String(songId), String(source || ''));
    if (result.success) {
      const playlists = getState('userPlaylists') || [];
      const pl = playlists.find(p => p.id === _currentPlaylistId);
      if (pl) {
        pl.songs = pl.songs.filter(s => !(
          String(s.id) === String(songId) &&
          String(s.source || '') === String(source || '')
        ));
        setState('userPlaylists', playlists);
        renderPlaylistDetailSongs(pl.songs);
        renderPlaylistList(playlists);
      }
    }
  } catch (e) {
    showToast('移除失败: ' + e.message, 'error');
  }
}

// ── 新建 / 编辑歌单 ────────────────────────────────────
function openPlaylistEditor(playlistId) {
  const modal = document.getElementById('playlistEditorModal');
  const titleEl = document.getElementById('playlistEditorTitle');
  const nameInput = document.getElementById('playlistEditorName');
  const descInput = document.getElementById('playlistEditorDesc');
  if (!modal || !nameInput) return;

  if (playlistId) {
    const playlists = getState('userPlaylists') || [];
    const pl = playlists.find(p => p.id === playlistId);
    if (pl) {
      titleEl.textContent = '✏️ 编辑歌单';
      nameInput.value = pl.name;
      descInput.value = pl.desc || '';
      modal.dataset.editId = playlistId;
    }
  } else {
    titleEl.textContent = '📋 新建歌单';
    nameInput.value = '';
    descInput.value = '';
    delete modal.dataset.editId;
  }

  modal.classList.remove('hidden');
  nameInput.focus();
}

function closePlaylistEditor() {
  document.getElementById('playlistEditorModal').classList.add('hidden');
}

async function savePlaylist() {
  const modal = document.getElementById('playlistEditorModal');
  const nameInput = document.getElementById('playlistEditorName');
  const descInput = document.getElementById('playlistEditorDesc');
  if (!modal || !nameInput) return;

  const name = nameInput.value.trim();
  if (!name) {
    showToast('请输入歌单名称', 'warn');
    nameInput.focus();
    return;
  }

  const editId = modal.dataset.editId;
  const playlists = getState('userPlaylists') || [];
  const pl = editId ? playlists.find(p => p.id === editId) : undefined;

  const payload = {
    ...(editId ? { id: editId } : {}),
    name,
    desc: descInput.value.trim(),
    songs: pl ? pl.songs : [],
  };

  try {
    const result = await api.saveUserPlaylist(payload);
    if (result.success) {
      await loadUserPlaylists();
      closePlaylistEditor();
      showToast(editId ? '✅ 歌单已更新' : '✅ 歌单已创建', 'success');
    } else {
      showToast(result.error || '保存失败', 'error');
    }
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

// ── 编辑 / 删除歌单 ───────────────────────────────────
function editPlaylist(playlistId) {
  openPlaylistEditor(playlistId);
}

async function deletePlaylist(playlistId) {
  if (!confirm('确认删除该歌单？')) return;
  try {
    const result = await api.deleteUserPlaylist(playlistId);
    if (result.success) {
      await loadUserPlaylists();
      showToast('✅ 歌单已删除', 'success');
    } else {
      showToast(result.error || '删除失败', 'error');
    }
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  }
}

// ── 快速添加到歌单（搜索结果右键等场景调用）────────────
async function quickAddToPlaylist(song) {
  try {
    const playlists = getState('userPlaylists') || [];
    if (playlists.length === 0) {
      showToast('请先创建一个歌单', 'warn');
      openPlaylistEditor(null);
      return;
    }
    if (playlists.length === 1) {
      await addToPlaylistAndNotify(playlists[0].id, song);
      return;
    }
    showPlaylistSelectModal(song, playlists);
  } catch (e) {
    logger.error('[quickAddToPlaylist] error:', e);
  }
}

function showPlaylistSelectModal(song, playlists) {
  try {
    const modal = document.getElementById('playlistSelectModal');
    const list = document.getElementById('playlistSelectList');
    if (!modal || !list) return;

    list.innerHTML = playlists.map(pl => `
      <div class="playlist-select-item" onclick="addToSelectedPlaylist('${escQ(pl.id)}')">
        <span class="playlist-select-icon">🎼</span>
        <span class="playlist-select-name">${esc(pl.name)}</span>
        <span class="playlist-select-count" style="font-size:11px;color:var(--neon-dim);">${pl.songs?.length || 0} 首</span>
      </div>
    `).join('');

    modal.dataset.song = JSON.stringify(song);
    modal.classList.remove('hidden');
  } catch (e) {
    logger.error('[showPlaylistSelectModal] error:', e);
  }
}

function closePlaylistSelectModal() {
  document.getElementById('playlistSelectModal').classList.add('hidden');
}

async function addToSelectedPlaylist(playlistId) {
  try {
    const modal = document.getElementById('playlistSelectModal');
    const songStr = modal.dataset.song;
    if (!songStr) return;
    const song = JSON.parse(songStr);
    await addToPlaylistAndNotify(playlistId, song);
    closePlaylistSelectModal();
  } catch (e) {
    logger.error('[addToSelectedPlaylist] error:', e);
  }
}

async function addToPlaylistAndNotify(playlistId, song) {
  try {
    const result = await api.addToUserPlaylist(playlistId, song);
    if (result.success) {
      if (result.skipped) {
        showToast('⚠️ 歌曲已在歌单中', 'warn');
      } else {
        showToast('✅ 已添加到歌单', 'success');
        const playlists = getState('userPlaylists') || [];
        const idx = playlists.findIndex(p => p.id === playlistId);
        if (idx >= 0) {
          playlists[idx] = result.playlist;
          setState('userPlaylists', playlists);
        }
      }
    }
  } catch (e) {
    showToast('添加失败: ' + e.message, 'error');
  }
}

// ── 初始化 ────────────────────────────────────────────
function initPlaylistView() {
  loadUserPlaylists();
}

// ── window 桥接（HTML onclick / 跨模块调用）────────────
window.loadUserPlaylists = loadUserPlaylists;
window.openPlaylistDetail = openPlaylistDetail;
window.closePlaylistDetail = closePlaylistDetail;
window.playPlaylistSong = playPlaylistSong;
window.addPlaylistSongToQueue = addPlaylistSongToQueue;
window.downloadPlaylistSong = downloadPlaylistSong;
window.downloadAllPlaylist = downloadAllPlaylist;
window.removeSongFromPlaylist = removeSongFromPlaylist;
window.openPlaylistEditor = openPlaylistEditor;
window.closePlaylistEditor = closePlaylistEditor;
window.savePlaylist = savePlaylist;
window.editPlaylist = editPlaylist;
window.deletePlaylist = deletePlaylist;
window.quickAddToPlaylist = quickAddToPlaylist;
window.closePlaylistSelectModal = closePlaylistSelectModal;
window.addToSelectedPlaylist = addToSelectedPlaylist;
window.initPlaylistView = initPlaylistView;
