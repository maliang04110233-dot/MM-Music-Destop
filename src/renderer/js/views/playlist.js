/**
 * MusicDL 用户歌单视图
 */

const logger = require('../../utils/logger');

// ── 状态 ─────────────────────────────────────────────
let _currentPlaylistId = null;

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
      <div class="empty-tip" style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text-muted);">
        <div style="font-size:40px;margin-bottom:12px">📋</div>
        <div>暂无歌单</div>
        <div style="font-size:12px;margin-top:6px">点击上方"新建歌单"创建你的第一个歌单</div>
      </div>`;
    return;
  }

  container.innerHTML = playlists.map(pl => `
    <div class="playlist-card" data-id="${escAttr(pl.id)}" onclick="openPlaylistDetail('${escAttr(pl.id)}')">
      <div class="playlist-card-cover">
        ${pl.cover ? `<img src="${escAttr(pl.cover)}" alt="${esc(pl.name)}" onerror="this.style.display='none'">` : '<div class="playlist-card-placeholder">📋</div>'}
        <div class="playlist-card-overlay">
          <span class="playlist-card-count">${pl.songs?.length || 0} 首</span>
        </div>
      </div>
      <div class="playlist-card-info">
        <div class="playlist-card-name" title="${esc(pl.name)}">${esc(pl.name)}</div>
        ${pl.desc ? `<div class="playlist-card-desc">${esc(pl.desc)}</div>` : ''}
      </div>
      <div class="playlist-card-actions" onclick="event.stopPropagation()">
        <button class="btn-icon" onclick="editPlaylist('${escAttr(pl.id)}')" title="编辑">✏️</button>
        <button class="btn-icon" onclick="deletePlaylist('${escAttr(pl.id)}')" title="删除">🗑️</button>
      </div>
    </div>
  `).join('');
}

// ── 打开歌单详情 ──────────────────────────────────────
async function openPlaylistDetail(playlistId) {  try {
    
    _currentPlaylistId = playlistId;
    const playlists = getState('userPlaylists') || [];
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return;
    
    document.getElementById('playlistDetailTitle').textContent = pl.name;
    document.getElementById('playlistDetailDesc').textContent = pl.desc || '暂无描述';
    renderPlaylistDetailSongs(pl.songs || []);
    
    document.getElementById('playlistDetailModal').classList.remove('hidden');
    
  } catch (e) {
    logger.error(`[openPlaylistDetail] error:`, e);
  }

function closePlaylistDetail() {
  document.getElementById('playlistDetailModal').classList.add('hidden');
  _currentPlaylistId = null;
}

// ── 渲染歌单歌曲列表 ──────────────────────────────────
function renderPlaylistDetailSongs(songs) {
  const list = document.getElementById('playlistDetailSongs');
  if (!list) return;

  if (!songs || songs.length === 0) {
    list.innerHTML = '<div class="empty-tip" style="text-align:center;padding:30px;color:var(--text-muted);">歌单为空</div>';
    return;
  }

  list.innerHTML = songs.map((song, idx) => `
    <div class="song-row" data-idx="${idx}">
      <div class="song-num">${idx + 1}</div>
      <div class="song-info">
        <div class="song-title" title="${esc(song.title)}">${esc(song.title) || '未知'}</div>
        <div class="song-sub">${esc(song.artist) || '未知艺术家'} · ${esc(song.album) || '未知专辑'}</div>
      </div>
      <div class="song-duration">${song.duration ? formatDuration(song.duration) : '--:--'}</div>
      <div class="song-actions">
        <button class="btn-icon" onclick="playPlaylistSong(${idx})" title="播放">▶️</button>
        <button class="btn-icon" onclick="addPlaylistSongToQueue(${idx})" title="加入队列">➕</button>
        <button class="btn-icon" onclick="removeSongFromPlaylist('${escAttr(song.id)}')" title="从歌单移除">❌</button>
      </div>
    </div>
  `).join('');
}

// ── 播放歌单中的歌曲 ──────────────────────────────────
function playPlaylistSong(idx) {
  const playlists = getState('userPlaylists') || [];
  const pl = playlists.find(p => p.id === _currentPlaylistId);
  if (!pl || !pl.songs) return;

  setState('playQueue', pl.songs);
  setState('playIdx', idx);
  playCurrent();
}

// ── 添加歌单歌曲到播放队列 ─────────────────────────────
function addPlaylistSongToQueue(idx) {
  const playlists = getState('userPlaylists') || [];
  const pl = playlists.find(p => p.id === _currentPlaylistId);
  if (!pl || !pl.songs) return;

  const song = pl.songs[idx];
  addToQueueAndPlay(song);
}

// ── 从歌单移除歌曲 ─────────────────────────────────────
async function removeSongFromPlaylist(songId) {
  if (!_currentPlaylistId) return;
  try {
    const result = await api.removeFromUserPlaylist(_currentPlaylistId, songId);
    if (result.success) {
      // 更新本地状态
      const playlists = getState('userPlaylists') || [];
      const pl = playlists.find(p => p.id === _currentPlaylistId);
      if (pl) {
        pl.songs = pl.songs.filter(s => s.id !== songId);
        renderPlaylistDetailSongs(pl.songs);
        renderPlaylistList(playlists);
      }
    }
  } catch (e) {
    showToast('移除失败: ' + e.message, 'error');
  }
}

// ── 新建 / 编辑歌单 ────────────────────────────────────
async function openPlaylistEditor(playlistId) {  try {
    
    const modal = document.getElementById('playlistEditorModal');
    const titleEl = document.getElementById('playlistEditorTitle');
    const nameInput = document.getElementById('playlistEditorName');
    const descInput = document.getElementById('playlistEditorDesc');
    
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
    
  } catch (e) {
    logger.error(`[openPlaylistEditor] error:`, e);
  }

function closePlaylistEditor() {
  document.getElementById('playlistEditorModal').classList.add('hidden');
}

async function savePlaylist() {
  const modal = document.getElementById('playlistEditorModal');
  const nameInput = document.getElementById('playlistEditorName');
  const descInput = document.getElementById('playlistEditorDesc');

  const name = nameInput.value.trim();
  if (!name) {
    showToast('请输入歌单名称', 'warn');
    nameInput.focus();
    return;
  }

  const editId = modal.dataset.editId;
  const playlists = getState('userPlaylists') || [];
  let pl;

  if (editId) {
    pl = playlists.find(p => p.id === editId);
  }

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

// ── 编辑歌单 ───────────────────────────────────────────
async function editPlaylist(playlistId) {  try {
    
    await openPlaylistEditor(playlistId);
    
  } catch (e) {
    logger.error(`[editPlaylist] error:`, e);
  }

// ── 删除歌单 ───────────────────────────────────────────
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

// ── 快速添加到歌单（右键菜单等场景）────────────────────
async function quickAddToPlaylist(song) {  try {
    
    const playlists = getState('userPlaylists') || [];
    if (playlists.length === 0) {
    showToast('请先创建一个歌单', 'warn');
    openPlaylistEditor(null);
    return;
    }
    
    // 如果只有一个歌单，直接添加；否则弹出选择
    if (playlists.length === 1) {
    await addToPlaylistAndNotify(playlists[0].id, song);
    return;
    }
    
    // 显示歌单选择弹层
    showPlaylistSelectModal(song, playlists);
    
  } catch (e) {
    logger.error(`[quickAddToPlaylist] error:`, e);
  }

async function showPlaylistSelectModal(song, playlists) {  try {
    
    const modal = document.getElementById('playlistSelectModal');
    const list = document.getElementById('playlistSelectList');
    
    list.innerHTML = playlists.map(pl => `
    <div class="playlist-select-item" onclick="addToSelectedPlaylist('${escAttr(pl.id)}')">
    <span class="playlist-select-icon">📋</span>
    <span class="playlist-select-name">${esc(pl.name)}</span>
    <span class="playlist-select-count">${pl.songs?.length || 0} 首</span>
    </div>
    `).join('');
    
    // 存储当前待添加的歌曲
    modal.dataset.song = JSON.stringify(song);
    modal.classList.remove('hidden');
    
  } catch (e) {
    logger.error(`[showPlaylistSelectModal] error:`, e);
  }

function closePlaylistSelectModal() {
  document.getElementById('playlistSelectModal').classList.add('hidden');
}

async function addToSelectedPlaylist(playlistId) {  try {
    
    const modal = document.getElementById('playlistSelectModal');
    const songStr = modal.dataset.song;
    if (!songStr) return;
    
    const song = JSON.parse(songStr);
    await addToPlaylistAndNotify(playlistId, song);
    closePlaylistSelectModal();
    
  } catch (e) {
    logger.error(`[addToSelectedPlaylist] error:`, e);
  }

async function addToPlaylistAndNotify(playlistId, song) {
  try {
    const result = await api.addToUserPlaylist(playlistId, song);
    if (result.success) {
      if (result.skipped) {
        showToast('⚠️ 歌曲已在歌单中', 'warn');
      } else {
        showToast('✅ 已添加到歌单', 'success');
        // 更新本地状态
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

// ── 工具函数 ───────────────────────────────────────────
function formatDuration(ms) {
  if (!ms) return '--:--';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ── 初始化 ────────────────────────────────────────────
function initPlaylistView() {
  loadUserPlaylists();
}
}
}
}
}
}
}
