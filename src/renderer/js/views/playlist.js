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
import { openSongRowMenu } from '../songMenu.js';
import { moveInList, sortPlaylistPairs, nextPlSortMode, PL_SORT_MODES, sortPlaylists, nextPlCardSortMode, PL_CARD_MODES, filterPlaylists } from '../playlistSort.js';
import { normalizeCoverUrl, pickFirstSongCover } from '../playlistCover.js';
import { filterPlaylistSongs } from '../playlistFilter.js';

// ── 状态 ─────────────────────────────────────────────
let _currentPlaylistId = null;
let _currentDetailSongs = [];
let _plSongKw = ''; // 详情弹层会话级过滤词（切歌单/关闭即清）
let _plSortMode = ''; // 详情弹层会话级视图排序（''=默认序，排序中禁拖把手）
let _plCardSortMode = ''; // 歌单页卡片排序（会话级，收藏系统单恒置顶）
let _plCardKw = ''; // 歌单页卡片过滤词（会话级，先过滤后排序）
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

  const shown = sortPlaylists(filterPlaylists(playlists, _plCardKw), _plCardSortMode);
  if (!shown.length) {
    const kw = _plCardKw.trim();
    container.innerHTML = kw
      ? `<div class="empty-hint" style="grid-column:1/-1;text-align:center;padding:40px 0;">
        <div style="font-size:40px;margin-bottom:12px">🔍</div>
        <div>没有匹配「${esc(kw)}」的歌单</div>
        <div style="font-size:12px;margin-top:6px;color:var(--neon-dim);">按名称或描述搜索；清空搜索框看全部</div>
      </div>`
      : `<div class="empty-hint" style="grid-column:1/-1;text-align:center;padding:40px 0;">
        <div style="font-size:40px;margin-bottom:12px">🎼</div>
        <div>暂无歌单</div>
        <div style="font-size:12px;margin-top:6px;color:var(--neon-dim);">点击上方"新建歌单"创建你的第一个歌单</div>
      </div>`;
    return;
  }

  container.innerHTML = shown.map(pl => `
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
    _plSongKw = '';
    _plSortMode = '';
    _syncPlSortBtn();
    const filterInput = document.getElementById('playlistSongFilter');
    if (filterInput) filterInput.value = '';
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

  const pairs = sortPlaylistPairs(filterPlaylistSongs(songs, _plSongKw), _plSortMode);
  const reorderable = songs.length > 1 && !_plSortMode; // 排序时展示序≠存储序，禁用拖把手防误持久化
  if (!pairs.length) {
    list.innerHTML = `<div class="empty-hint" style="text-align:center;padding:30px 0;">没有匹配「${esc(_plSongKw.trim())}」的歌曲</div>`;
    return;
  }
  list.innerHTML = pairs.map(({ song, i: idx }) => `
    <div class="song-row" data-pidx="${idx}" ondblclick="playPlaylistSong(${idx})">
      ${reorderable ? '<span class="pl-drag-handle" draggable="true" title="按住拖动排序">⠿</span>' : ''}
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

// ── 行右键菜单（业务项在 ../songMenu.js 共享）──────────
function playlistRowContext(e) {
  const list = document.getElementById('playlistDetailSongs');
  const row = e.target && e.target.closest ? e.target.closest('.song-row') : null;
  if (!list || !row || !list.contains(row)) return;
  const idx = Number(row.getAttribute('data-pidx'));
  const song = _currentDetailSongs[idx];
  if (!song) return;
  openSongRowMenu(e, song, {
    play: () => playPlaylistSong(idx),
    download: () => downloadPlaylistSong(idx),
    downloadQuality: (q) => downloadPlaylistSong(idx, q),
    addToQueue: () => addPlaylistSongToQueue(idx),
    extra: [{
      icon: '✕', label: '从歌单移除', danger: true,
      onClick: () => removeSongFromPlaylist(String(song.id), String(song.source || '')),
    }],
  });
}
document.addEventListener('contextmenu', playlistRowContext);

// ── 拖拽排序（把手起拖 → 落到目标行占据该位置）──────────
// 复用现有 save-user-playlist 通道做全量 songs 覆盖，不新增 IPC。
let _plDragFrom = -1;

function _plRowUnder(e) {
  const list = document.getElementById('playlistDetailSongs');
  const row = e.target && e.target.closest ? e.target.closest('.song-row[data-pidx]') : null;
  if (!list || !row || !list.contains(row)) return null;
  const n = Number(row.getAttribute('data-pidx'));
  return Number.isFinite(n) ? { idx: n, row } : null;
}

function _plClearDragMarks() {
  document.querySelectorAll('.song-row.pl-dragging, .song-row.pl-drag-over')
    .forEach(el => el.classList.remove('pl-dragging', 'pl-drag-over'));
}

document.addEventListener('dragstart', (e) => {
  if (!(e.target && e.target.closest && e.target.closest('.pl-drag-handle'))) return;
  const hit = _plRowUnder(e);
  if (!hit) return;
  _plDragFrom = hit.idx;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(hit.idx)); // Firefox：不设数据不给拖
  }
  hit.row.classList.add('pl-dragging');
});

document.addEventListener('dragover', (e) => {
  if (_plDragFrom < 0) return;
  const hit = _plRowUnder(e);
  if (!hit || hit.idx === _plDragFrom) return;
  e.preventDefault();
  document.querySelectorAll('.song-row.pl-drag-over')
    .forEach(el => el.classList.remove('pl-drag-over'));
  hit.row.classList.add('pl-drag-over');
});

document.addEventListener('drop', (e) => {
  const from = _plDragFrom;
  _plDragFrom = -1;
  _plClearDragMarks();
  if (from < 0) return;
  const hit = _plRowUnder(e);
  if (!hit || hit.idx === from) return;
  e.preventDefault();
  persistPlaylistOrder(from, hit.idx);
});

document.addEventListener('dragend', () => {
  _plDragFrom = -1;
  _plClearDragMarks();
});

async function persistPlaylistOrder(from, to) {
  if (!_currentPlaylistId) return;
  const next = moveInList(_currentDetailSongs, from, to);
  if (!next) return;
  const playlists = getState('userPlaylists') || [];
  const pl = playlists.find(p => p.id === _currentPlaylistId);
  if (!pl) return;
  renderPlaylistDetailSongs(next); // 先落视觉，失败再回滚
  try {
    const r = await api.saveUserPlaylist({ id: pl.id, name: pl.name, songs: next });
    if (!r || !r.success) throw new Error((r && r.error) || '保存失败');
    pl.songs = next;
    setState('userPlaylists', playlists);
    renderPlaylistList(playlists);
  } catch (err) {
    showToast('排序保存失败: ' + (err.message || err), 'error');
    renderPlaylistDetailSongs(pl.songs || []);
  }
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
    song._playedQuality = quality;
    if (result.matchedSong) {
      showToast(`🎵 本源不可用，已切换到${result.matchedSong.source}音源`, 'info', 3000);
      song._altSource = { source: result.matchedSong.source, id: String(result.matchedSong.id) };
    }
    const playSource = result.matchedSong?.source || song.source;
    const referer = playReferer(playSource, result);
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
async function downloadPlaylistSong(idx, qualityOverride) {
  const song = _currentDetailSongs[idx];
  if (!song) return;
  const existing = (getState('queueSnapshot') || []).find(q =>
    q.id === song.id && q.source === song.source && q.status !== 'done');
  if (existing) { showToast(`「${song.title}」已在队列中`, 'warn', 2500); return; }
  const saveDir = getState('saveDir');
  const quality = qualityOverride || resolveQuality(song.source);
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

/** 「▶ 播放全部」：整单进播放队列从第一首起连播（复用 playPlaylistSong 全语义） */
async function playAllPlaylist() {
  if (!_currentDetailSongs.length) { showToast('歌单为空', 'warn'); return; }
  await playPlaylistSong(0);
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
  const coverInput = document.getElementById('playlistEditorCover');
  const pickBtn = document.getElementById('playlistCoverPick');
  if (!modal || !nameInput) return;

  if (playlistId) {
    const playlists = getState('userPlaylists') || [];
    const pl = playlists.find(p => p.id === playlistId);
    if (pl) {
      titleEl.textContent = '✏️ 编辑歌单';
      nameInput.value = pl.name;
      descInput.value = pl.desc || '';
      if (coverInput) coverInput.value = pl.cover || '';
      // 「用首曲封面」只在歌内可能有封面的已有歌单里可用
      if (pickBtn) pickBtn.style.display = (pl.songs || []).length ? '' : 'none';
      modal.dataset.editId = playlistId;
    }
  } else {
    titleEl.textContent = '📋 新建歌单';
    nameInput.value = '';
    descInput.value = '';
    if (coverInput) coverInput.value = '';
    if (pickBtn) pickBtn.style.display = 'none';
    delete modal.dataset.editId;
  }

  modal.classList.remove('hidden');
  nameInput.focus();
}

/** 一键把歌单里第一张歌曲封面填进封面输入框 */
function useFirstSongCover() {
  const modal = document.getElementById('playlistEditorModal');
  const coverInput = document.getElementById('playlistEditorCover');
  const pl = (getState('userPlaylists') || []).find(p => p.id === modal.dataset.editId);
  const c = pickFirstSongCover(pl && pl.songs);
  if (!c) { showToast('歌内没有可用的封面链接', 'warn'); return; }
  coverInput.value = c;
}

function closePlaylistEditor() {
  document.getElementById('playlistEditorModal').classList.add('hidden');
}

async function savePlaylist() {
  const modal = document.getElementById('playlistEditorModal');
  const nameInput = document.getElementById('playlistEditorName');
  const descInput = document.getElementById('playlistEditorDesc');
  const coverInput = document.getElementById('playlistEditorCover');
  if (!modal || !nameInput) return;

  const name = nameInput.value.trim();
  if (!name) {
    showToast('请输入歌单名称', 'warn');
    nameInput.focus();
    return;
  }

  // 封面留空=清除（''），非法协议直接拦下（normalizeCoverUrl 非 http(s) → null）
  const cover = coverInput ? normalizeCoverUrl(coverInput.value) : '';
  if (cover === null) {
    showToast('封面链接需以 http:// 或 https:// 开头', 'warn');
    if (coverInput) coverInput.focus();
    return;
  }

  const editId = modal.dataset.editId;
  const playlists = getState('userPlaylists') || [];
  const pl = editId ? playlists.find(p => p.id === editId) : undefined;

  const payload = {
    ...(editId ? { id: editId } : {}),
    name,
    desc: descInput.value.trim(),
    cover,
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

// ── 快速添加到歌单（搜索结果右键/批量工具条调用；单曲或数组皆可）──
async function quickAddToPlaylist(songOrList) {
  try {
    const list = Array.isArray(songOrList) ? songOrList.filter(Boolean) : [songOrList];
    if (!list.length) return;
    const playlists = getState('userPlaylists') || [];
    if (playlists.length === 0) {
      showToast('请先创建一个歌单', 'warn');
      openPlaylistEditor(null);
      return;
    }
    if (playlists.length === 1) {
      if (list.length === 1) await addToPlaylistAndNotify(playlists[0].id, list[0]);
      else await _addListToPlaylist(playlists[0].id, list);
      return;
    }
    showPlaylistSelectModal(list, playlists);
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
    const raw = JSON.parse(songStr);
    const list = Array.isArray(raw) ? raw : [raw];
    if (!list.length) return;
    if (list.length === 1) await addToPlaylistAndNotify(playlistId, list[0]);
    else await _addListToPlaylist(playlistId, list);
    closePlaylistSelectModal();
  } catch (e) {
    logger.error('[addToSelectedPlaylist] error:', e);
  }
}

/** 批量逐条加歌（引擎端自带 id+source 去重=skipped）；一次汇总 toast */
async function _addListToPlaylist(playlistId, list) {
  let added = 0, skipped = 0, failed = 0, lastPl = null;
  for (const song of list) {
    try {
      const r = await api.addToUserPlaylist(playlistId, song);
      if (r && r.success) {
        if (r.skipped) skipped++;
        else { added++; if (r.playlist) lastPl = r.playlist; }
      } else failed++;
    } catch (_e) { failed++; }
  }
  if (lastPl) {
    const playlists = getState('userPlaylists') || [];
    const idx = playlists.findIndex(p => p.id === playlistId);
    if (idx >= 0) {
      playlists[idx] = lastPl;
      setState('userPlaylists', playlists);
      renderPlaylistList(playlists);
      if (_currentPlaylistId === playlistId) renderPlaylistDetailSongs(lastPl.songs || []);
    }
  }
  const parts = [];
  if (added) parts.push(`已加入 ${added} 首`);
  if (skipped) parts.push(`跳过已在歌单 ${skipped} 首`);
  if (failed) parts.push(`失败 ${failed} 首`);
  showToast(parts.length ? parts.join('，') : '没有歌曲被加入', added ? 'success' : 'warn');
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
          // 该歌单详情弹层开着：外部入口（右键加歌等）也即时可见
          if (_currentPlaylistId === playlistId) renderPlaylistDetailSongs(result.playlist.songs || []);
        }
      }
    }
  } catch (e) {
    showToast('添加失败: ' + e.message, 'error');
  }
}

// ── 详情过滤框（藏行不重排，行索引恒为原始下标）────────
function onPlaylistSongFilterInput(v) {
  _plSongKw = String(v || '');
  if (_currentPlaylistId) renderPlaylistDetailSongs(_currentDetailSongs);
}

// ── 详情视图排序（只排展示 pairs，不动存储顺序；排序中拖把手隐藏）──
function _syncPlSortBtn() {
  const btn = document.getElementById('playlistSortBtn');
  if (!btn) return;
  const m = PL_SORT_MODES.find((x) => x.key === _plSortMode);
  btn.textContent = m ? m.label : '↕ 默认序';
}

function cyclePlaylistSort() {
  _plSortMode = nextPlSortMode(_plSortMode);
  _syncPlSortBtn();
  if (_currentPlaylistId) renderPlaylistDetailSongs(_currentDetailSongs);
}

// ── 歌单页卡片排序循环（收藏系统单恒置顶，不参与排）────
function cyclePlCardSort() {
  _plCardSortMode = nextPlCardSortMode(_plCardSortMode);
  const btn = document.getElementById('playlistCardSortBtn');
  if (btn) {
    const m = PL_CARD_MODES.find((x) => x.key === _plCardSortMode);
    btn.textContent = m ? m.label : '↕ 默认';
  }
  renderPlaylistList(getState('userPlaylists') || []);
}

/** 卡片搜索：按名称/描述即时过滤（会话级，与排序叠加：先过滤后排序） */
function filterPlaylistCards() {
  const el = document.getElementById('playlistCardFilter');
  _plCardKw = el ? el.value : '';
  renderPlaylistList(getState('userPlaylists') || []);
}

// ── 歌单内快捷加歌（搜索→逐条添加，弹层不关可连加）────
let _plAddEl = null;
let _plAddSongs = [];
let _plAddReqId = 0;

function _ensurePlAddModal() {
  if (_plAddEl && document.body.contains(_plAddEl)) return _plAddEl;
  const div = document.createElement('div');
  div.id = 'plAddModal';
  div.className = 'playlist-modal-overlay hidden';
  // 静态模板 innerHTML：不含任何用户数据，数据行走 _renderPlAddList 逐条 esc
  div.innerHTML = `
    <div class="playlist-modal" style="min-width:420px;max-width:560px;max-height:70vh;display:flex;flex-direction:column;">
      <div class="playlist-modal-header">
        <span class="playlist-modal-title">➕ 添加歌曲到歌单</span>
        <button class="playlist-modal-close" onclick="closePlaylistAddSongs()">✕</button>
      </div>
      <div style="display:flex;gap:8px;padding:12px 16px 4px;">
        <input type="text" class="setting-input" id="plAddInput" placeholder="输入歌名/歌手，回车搜索" style="flex:1;" onkeydown="if(event.key==='Enter')doPlAddSearch()">
        <button class="btn-primary" style="flex-shrink:0;padding:6px 14px;" onclick="doPlAddSearch()">🔍 搜索</button>
      </div>
      <div id="plAddResults" class="playlist-modal-body" style="flex:1;min-height:0;overflow-y:auto;padding:8px 16px 16px;"></div>
    </div>`;
  div.addEventListener('click', (e) => { if (e.target === div) closePlaylistAddSongs(); });
  document.body.appendChild(div);
  _plAddEl = div;
  return div;
}

function openPlaylistAddSongs() {
  if (!_currentPlaylistId) { showToast('请先打开一个歌单', 'warn'); return; }
  const m = _ensurePlAddModal();
  m.classList.remove('hidden');
  const input = document.getElementById('plAddInput');
  input.value = getState('currentKeyword') || '';
  input.focus();
  input.select();
  document.getElementById('plAddResults').innerHTML =
    '<div class="empty-hint" style="text-align:center;padding:20px;">输入关键词搜索后可逐条添加</div>';
}

function closePlaylistAddSongs() {
  if (_plAddEl) _plAddEl.classList.add('hidden');
}

async function doPlAddSearch() {
  const kw = (document.getElementById('plAddInput').value || '').trim();
  const box = document.getElementById('plAddResults');
  if (!kw) { showToast('请输入搜索关键词', 'warn'); return; }
  const reqId = ++_plAddReqId;
  box.innerHTML = '<div class="empty-hint" style="text-align:center;padding:20px;">搜索中…</div>';
  try {
    const r = await api.searchMusic(kw, 'all', 1);
    if (reqId !== _plAddReqId) return; // 慢响应旧请求丢弃
    _plAddSongs = (r && r.songs) || [];
    if (!_plAddSongs.length) {
      box.innerHTML = `<div class="empty-hint" style="text-align:center;padding:20px;">${r && r.error ? '搜索出错：' + esc(r.error) : '没有搜索结果'}</div>`;
      return;
    }
    _renderPlAddList();
  } catch (e) {
    if (reqId === _plAddReqId) {
      box.innerHTML = `<div class="empty-hint" style="text-align:center;padding:20px;">搜索失败：${esc(e.message || e)}</div>`;
    }
  }
}

function _inCurrentPlaylist(song) {
  return _currentDetailSongs.some(s =>
    String(s.id) === String(song.id) && String(s.source || '') === String(song.source || ''));
}

function _renderPlAddList() {
  const box = document.getElementById('plAddResults');
  if (!box) return;
  box.innerHTML = _plAddSongs.map((s, i) => {
    const added = _inCurrentPlaylist(s);
    return `
    <div class="song-row">
      <div class="song-info">
        <div class="song-title" title="${esc(s.title)}">${esc(s.title) || '未知'}</div>
        <div class="song-meta">${esc(s.artist) || '未知'}${s.source ? ' · ' + esc(s.source) : ''}</div>
      </div>
      <span class="song-duration">${s.duration ? fmtDuration(s.duration) : '--:--'}</span>
      <div class="song-actions">
        <button class="action-btn" ${added ? 'disabled' : ''} onclick="plAddPick(${i})" title="${added ? '已在歌单中' : '添加到本歌单'}">${added ? '✓' : '➕'}</button>
      </div>
    </div>`;
  }).join('');
}

async function plAddPick(i) {
  const song = _plAddSongs[i];
  if (!song || !_currentPlaylistId) return;
  try {
    const r = await api.addToUserPlaylist(_currentPlaylistId, song);
    if (!r || !r.success) { showToast((r && r.error) || '添加失败', 'error'); return; }
    if (r.skipped) showToast('⚠️ 歌曲已在歌单中', 'warn');
    else {
      showToast('✅ 已添加：' + (song.title || ''), 'success');
      const playlists = getState('userPlaylists') || [];
      const idx = playlists.findIndex(p => p.id === _currentPlaylistId);
      if (idx >= 0 && r.playlist) {
        playlists[idx] = r.playlist;
        setState('userPlaylists', playlists);
        renderPlaylistDetailSongs(r.playlist.songs || []);
      }
    }
    _renderPlAddList(); // 该行刷成 ✓，可继续加下一首
  } catch (e) {
    showToast('添加失败: ' + (e.message || e), 'error');
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
window.playAllPlaylist = playAllPlaylist;
window.removeSongFromPlaylist = removeSongFromPlaylist;
window.openPlaylistEditor = openPlaylistEditor;
window.useFirstSongCover = useFirstSongCover;
window.onPlaylistSongFilterInput = onPlaylistSongFilterInput;
window.cyclePlaylistSort = cyclePlaylistSort;
window.cyclePlCardSort = cyclePlCardSort;
window.filterPlaylistCards = filterPlaylistCards;
window.openPlaylistAddSongs = openPlaylistAddSongs;
window.closePlaylistAddSongs = closePlaylistAddSongs;
window.doPlAddSearch = doPlAddSearch;
window.plAddPick = plAddPick;
window.closePlaylistEditor = closePlaylistEditor;
window.savePlaylist = savePlaylist;
window.editPlaylist = editPlaylist;
window.deletePlaylist = deletePlaylist;
window.quickAddToPlaylist = quickAddToPlaylist;
window.closePlaylistSelectModal = closePlaylistSelectModal;
window.addToSelectedPlaylist = addToSelectedPlaylist;
window.initPlaylistView = initPlaylistView;
