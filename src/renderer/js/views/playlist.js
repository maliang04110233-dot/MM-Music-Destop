/**
 * MusicDL 用户歌单视图
 *
 * 2026-09-14 重建：原文件因批量编辑事故留下 6 处函数体未闭合（靠文件尾
 * 游离 `}` 凑配平），且所有函数未挂 window——HTML onclick 无法调用，
 * 页面容器（userPlaylistGrid 等）也不存在于 index.html，属"从未接通"
 * 的半成品。本版修复结构 + 桥接 + 配套 UI 容器，与后端 ipc/playlist.js
 * （5 个 handler，prefs 持久化）完整接通。
 */

import { errBrief } from '../errBrief.js';
import { askConfirm } from '../confirmDialog.js';
import { logger } from '../logger.js';
import { loadAndPlay } from '../player.js';
import { HEART_ON, heartBtnHtml } from '../favorites.js';
import { FAVORITES_PLAYLIST_ID, subscribe } from '../state.js';
import { resolveQuality } from '../quality.js';
import { buildFallbackNotice } from '../fallbackNotice.js';
import { dlBadgeHtml, dlEnsureHistoryLoaded, addDlChangeListener, dlStatusFor } from '../dlStatus.js';
import { openSongRowMenu } from '../songMenu.js';
import { moveInList, sortPlaylistPairs, nextPlSortMode, PL_SORT_MODES, sortPlaylists, nextPlCardSortMode, PL_CARD_MODES, filterPlaylists } from '../playlistSort.js';
import { normalizeCoverUrl, pickFirstSongCover } from '../playlistCover.js';
import { filterPlaylistSongs } from '../playlistFilter.js';
import { findCrossPlaylistDupes, dedupeScanText, planConsolidate } from '../plDedupeScan.js';
import { enrichExportSongs, buildPathMap } from '../playlistExport.js';
import { mergeSongLists } from '../playlistMerge.js';
import { indexOfPlaying, flashRow } from '../locatePlaying.js';
import { sanitizeFileBase } from '../artistGroups.js';
import { plSongKey, splitBySelection, keysOf } from '../plBulkRemove.js';
import { planSelEnqueue, enqueueSkipSuffix } from '../plSelBatch.js';
import { filterByDlMode, nextPlDlMode, plDlModeLabel } from '../plDlFilter.js';
import { dupPlaylistName, dupPlaylistPayload } from '../plDuplicate.js';
import { toTrackLines } from '../songListText.js';
import { copyText } from '../songShare.js';

// ── 状态 ─────────────────────────────────────────────
let _currentPlaylistId = null;
let _currentDetailSongs = [];
let _plSongKw = ''; // 详情弹层会话级过滤词（切歌单/关闭即清）
let _plSortMode = ''; // 详情弹层会话级视图排序（''=默认序，排序中禁拖把手）
let _plDlMode = 'all'; // 详情弹层下载状态过滤（增量103：all/undone/done，切歌单即复位）
let _plCardSortMode = ''; // 歌单页卡片排序（会话级，收藏系统单恒置顶）
let _plCardKw = ''; // 歌单页卡片过滤词（会话级，先过滤后排序）
// 取流用智能接口（本源失败自动换源）；请求序号做竞态守卫，快速连点只认最后一次
let _playlistPlayRequestId = 0;
// 增量99：详情弹层多选移除（会话级）。键是歌的身份（id:source），过滤/排序/重渲染不丢选中
let _plSelMode = false;
let _plSelKeys = new Set();

// ── 加载歌单列表 ──────────────────────────────────────
async function loadUserPlaylists() {
  try {
    const playlists = await api.getUserPlaylists();
    setState('userPlaylists', playlists || []);
    renderPlaylistList(playlists || []);
  } catch (e) {
    logger.error('加载歌单失败:', e);
    showToast('加载歌单失败: ' + errBrief(e), 'error');
  }
  // 回收站徽标跟着列表一起刷新（删除/撤销/恢复都经过这里；自身带 try/catch，不打扰主流程）
  refreshPlTrash();
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
    <div class="playlist-card" data-id="${escAttr(pl.id)}" tabindex="0" role="button" onclick="openPlaylistDetail('${escQ(pl.id)}')">
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
    _plDlMode = 'all';
    _syncPlSortBtn();
    _syncPlDlBtn();
    _resetPlSel();
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
  _resetPlSel();
}

// ── 渲染歌单歌曲列表 ──────────────────────────────────
// 视图管线唯一入口：关键词过滤 → 下载状态过滤 → 排序（渲染/全选/任何读视图序的地方都走它，
// 三处管线各自为政迟早漂出「全选选到隐形歌」这类 bug）
function _plVisiblePairs(songs) {
  const queue = getState('queueSnapshot') || [];
  const kwFiltered = filterPlaylistSongs(songs || [], _plSongKw);
  const dlFiltered = filterByDlMode(kwFiltered, _plDlMode, (s) => dlStatusFor(s, queue));
  return sortPlaylistPairs(dlFiltered, _plSortMode);
}

function renderPlaylistDetailSongs(songs) {
  const list = document.getElementById('playlistDetailSongs');
  if (!list) return;
  _currentDetailSongs = songs || [];
  _syncPlSelBtns(); // 计数/显隐跟渲染走，早退分支也不留脏按钮
  dlEnsureHistoryLoaded(); // 跨会话"已下载"懒回填，完成后经监听器重渲染徽标

  if (!songs || songs.length === 0) {
    list.innerHTML = '<div class="empty-hint" style="text-align:center;padding:30px 0;">歌单为空，去搜索页添加喜欢的歌曲吧</div>';
    return;
  }

  const pairs = _plVisiblePairs(songs);
  const reorderable = songs.length > 1 && !_plSortMode; // 排序时展示序≠存储序，禁用拖把手防误持久化
  if (!pairs.length) {
    const kwPart = _plSongKw.trim() ? `「${esc(_plSongKw.trim())}」` : '';
    const dlPart = _plDlMode !== 'all' ? (kwPart ? '且符合所选下载状态' : '所选下载状态') : '';
    list.innerHTML = `<div class="empty-hint" style="text-align:center;padding:30px 0;">没有匹配${kwPart}${dlPart}的歌曲</div>`;
    return;
  }
  list.innerHTML = pairs.map(({ song, i: idx }) => `
    <div class="song-row" data-pidx="${idx}" ondblclick="playPlaylistSong(${idx})">
      ${_plSelMode ? `<input type="checkbox" class="pl-sel-chk" ${_plSelKeys.has(plSongKey(song)) ? 'checked' : ''} onclick="event.stopPropagation()" onchange="togglePlSongSel(${idx})" title="勾选后可一键移出歌单" style="width:15px;height:15px;flex-shrink:0;cursor:pointer;margin-right:6px;">` : ''}
      ${reorderable ? '<span class="pl-drag-handle" draggable="true" title="按住拖动排序">⠿</span>' : ''}
      <span class="song-num" style="color:var(--neon-dim);font-size:12px;width:22px;text-align:right;flex-shrink:0;">${idx + 1}</span>
      <div class="song-info">
        <div class="song-title" title="${esc(song.title)}">${esc(song.title) || '未知'}</div>
        <div class="song-meta">${esc(song.artist) || '未知艺术家'}${song.album ? ' · ' + esc(song.album) : ''}</div>
      </div>
      ${dlBadgeHtml(song, getState('queueSnapshot') || [])}
      <span class="song-duration">${song.duration ? fmtDuration(song.duration) : '--:--'}</span>
      <div class="song-actions">
        ${heartBtnHtml(song, 'action-btn')}
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
    showToast('排序保存失败: ' + errBrief(err), 'error');
    renderPlaylistDetailSongs(pl.songs || []);
  }
}

// ── 播放歌单中的歌曲 ──────────────────────────────────
async function playPlaylistSong(idx) {
  await _playFrom(_currentDetailSongs, idx);
}

/** 从给定歌曲列表取流播放：整个 list 作为播放队列，从 idx 起连播 */
async function _playFrom(list, idx) {
  const songs = Array.isArray(list) ? list : [];
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
    const notice = buildFallbackNotice(result, song.source);
    if (notice) showToast(notice, 'info', 3000);
    if (result.matchedSong) {
      song._altSource = { source: result.matchedSong.source, id: String(result.matchedSong.id) };
    }
    const playSource = result.source || song.source;
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
      showToast('⚠️ 播放失败：' + errBrief(e), 'error', 4000);
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
          .catch(e => showToast('加入失败: ' + errBrief(e), 'error'));
      });
      return;
    }
    if (r && r.queued) showToast(`「${song.title}」已加入下载队列`, 'success');
    else showToast((r && r.error) || '加入下载队列失败', 'error');
  } catch (e) {
    showToast('加入下载队列失败: ' + errBrief(e), 'error');
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
  const { toEnqueue, skipped: inQueue } = planSelEnqueue(songs, getState('queueSnapshot') || []);
  let queued = 0, dlSkipped = 0;
  for (const song of toEnqueue) {
    try {
      // 批量场景：历史已下载且文件还在 → 静默跳过（同 downloadAlbum）
      const r = await api.addToQueue({ ...song, saveDir, quality: resolveQuality(song.source) });
      if (r && r.queued) queued++;
      else if (r && r.alreadyDownloaded) dlSkipped++;
    } catch (e) { logger.warn('歌单批量入队失败:', song.title, e.message); }
  }
  const msg = `歌单 ${queued} 首已加入下载队列${enqueueSkipSuffix(inQueue, dlSkipped)}`;
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
    showToast('移除失败: ' + errBrief(e), 'error');
  }
}

// ── 多选批量移除（增量99）───────────────────────────────
function _resetPlSel() {
  _plSelMode = false;
  _plSelKeys = new Set();
  _syncPlSelBtns();
}

function _syncPlSelBtns() {
  const modeBtn = document.getElementById('plSelModeBtn');
  const allBtn = document.getElementById('plSelAllBtn');
  const rmBtn = document.getElementById('plSelRemoveBtn');
  const dlBtn = document.getElementById('plSelDlBtn');
  const playBtn = document.getElementById('plSelPlayBtn');
  if (modeBtn) modeBtn.textContent = _plSelMode ? '⬚ 退出多选' : '☑ 多选';
  if (allBtn) allBtn.classList.toggle('hidden', !_plSelMode);
  if (rmBtn) {
    rmBtn.classList.toggle('hidden', !_plSelMode);
    rmBtn.textContent = `🗑 移除 ${_plSelKeys.size}`;
  }
  if (dlBtn) {
    dlBtn.classList.toggle('hidden', !_plSelMode);
    dlBtn.textContent = `⬇ 下载 ${_plSelKeys.size}`;
  }
  if (playBtn) {
    playBtn.classList.toggle('hidden', !_plSelMode);
    playBtn.textContent = `▶ 播放 ${_plSelKeys.size}`;
  }
}

function togglePlBulkMode() {
  _plSelMode = !_plSelMode;
  if (!_plSelMode) _plSelKeys = new Set();
  renderPlaylistDetailSongs(_currentDetailSongs);
}

function togglePlSongSel(idx) {
  const song = _currentDetailSongs[idx];
  if (!song) return;
  const k = plSongKey(song);
  if (_plSelKeys.has(k)) _plSelKeys.delete(k);
  else _plSelKeys.add(k);
  renderPlaylistDetailSongs(_currentDetailSongs);
}

/** 全选/取消全选「当前过滤视图」的歌（隐形歌不动） */
function plSelectAllVisible() {
  const pairs = _plVisiblePairs(_currentDetailSongs);
  const vis = keysOf(pairs.map(p => p.song));
  if (!vis.size) { showToast('当前视图没有歌曲', 'info'); return; }
  const allOn = [...vis].every(k => _plSelKeys.has(k));
  for (const k of vis) {
    if (allOn) _plSelKeys.delete(k);
    else _plSelKeys.add(k);
  }
  renderPlaylistDetailSongs(_currentDetailSongs);
}

async function removeCheckedFromPlaylist() {
  if (!_plSelKeys.size) { showToast('先勾选要移除的歌曲', 'warn'); return; }
  if (!_currentPlaylistId) return;
  const playlists = getState('userPlaylists') || [];
  const pl = playlists.find(p => p.id === _currentPlaylistId);
  if (!pl) return;
  const { keep, removed } = splitBySelection(pl.songs || [], _plSelKeys);
  if (!removed.length) { _plSelKeys = new Set(); _syncPlSelBtns(); return; }
  if (!await askConfirm(`确认把 ${removed.length} 首歌移出歌单「${pl.name}」？（不会删除已下载的文件）`)) return;
  try {
    const r = await api.saveUserPlaylist({
      id: pl.id, name: pl.name, desc: pl.desc || '', cover: pl.cover || '', songs: keep,
    });
    if (r && r.success && r.playlist) {
      const i = playlists.findIndex(p => p.id === pl.id);
      if (i >= 0) {
        playlists[i] = r.playlist;
        setState('userPlaylists', playlists);
      }
      _plSelKeys = new Set();
      renderPlaylistDetailSongs(r.playlist.songs || []);
      renderPlaylistList(playlists);
      showToast(`🗑 已移出 ${removed.length} 首`, 'success');
    } else {
      showToast((r && r.error) || '移除失败', 'error');
    }
  } catch (e) {
    logger.error('[removeCheckedFromPlaylist] 失败:', e);
    showToast('移除失败: ' + errBrief(e), 'error');
  }
}

// ── 多选批量动作（增量112）：下载已勾选 / 播放已勾选 ─────────
/** 按歌单存储序取出勾选的歌（与99移除同一条链：键集现算，隐形/已消失的自然跳过） */
function _plSelPicked() {
  return splitBySelection(_currentDetailSongs, _plSelKeys).removed;
}

async function plSelDownload() {
  const picked = _plSelPicked();
  if (!picked.length) { showToast('先勾选要下载的歌曲', 'warn'); return; }
  const saveDir = getState('saveDir');
  const { toEnqueue, skipped } = planSelEnqueue(picked, getState('queueSnapshot') || []);
  let queued = 0, dlSkipped = 0;
  for (const song of toEnqueue) {
    try {
      // 批量场景：历史已下载且文件还在 → 主进程静默跳过，这里只计数（同整单入队）
      const r = await api.addToQueue({ ...song, saveDir, quality: resolveQuality(song.source) });
      if (r && r.queued) queued++;
      else if (r && r.alreadyDownloaded) dlSkipped++;
    } catch (e) { logger.warn('歌单多选入队失败:', song.title, e.message); }
  }
  showToast(`⬇ 已加入 ${queued} 首${enqueueSkipSuffix(skipped, dlSkipped)}`,
    queued || dlSkipped ? 'success' : 'info', 3200);
}

async function plSelPlay() {
  const picked = _plSelPicked();
  if (!picked.length) { showToast('先勾选要播放的歌曲', 'warn'); return; }
  // 勾选的歌单独组成播放队列，从第一首起连播（整单 playQueue 被替换是刻意语义）
  await _playFrom(picked, 0);
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
    showToast('保存失败: ' + errBrief(e), 'error');
  }
}

// ── 编辑 / 删除歌单 ───────────────────────────────────
function editPlaylist(playlistId) {
  openPlaylistEditor(playlistId);
}

async function deletePlaylist(playlistId) {
  // 增量156（审计 F2）：删除必见影响 —— 确认框点名歌单与歌数，
  // 删后 5 秒撤销窗口（走 utils.showActionToast，回收站兜底见 main/ipc/playlist.js）
  const pl = (getState('userPlaylists') || []).find(p => p && p.id === playlistId);
  if (!pl) { showToast('歌单不存在或已刷新，请重试', 'warn'); return; }
  const n = Array.isArray(pl.songs) ? pl.songs.length : 0;
  if (!await askConfirm(`确认删除歌单「${pl.name}」？\n\n• 歌单里有 ${n} 首歌 —— 删的只是这份清单，歌曲文件与红心收藏都不受影响\n• 删除后 5 秒内可点「撤销」原样找回`)) return;
  try {
    const result = await api.deleteUserPlaylist(playlistId);
    if (result.success) {
      await loadUserPlaylists();
      showActionToast({
        text: `歌单「${pl.name}」已删除`,
        btnLabel: '撤销',
        ttl: 5000,
        onConfirm: () => undoDeletePlaylist(pl),
      });
    } else {
      showToast(result.error || '删除失败', 'error');
    }
  } catch (e) {
    showToast('删除失败: ' + errBrief(e), 'error');
  }
}

/** 撤销删除：攥着被删对象的完整副本走既有 save-user-playlist 原 id 保存，
 *  主进程"带 id 却不在列表 ⇒ 查回收站放回"分支承接（零新 IPC 通道） */
async function undoDeletePlaylist(pl) {
  try {
    const back = await api.saveUserPlaylist(pl);
    if (back && back.success) {
      await loadUserPlaylists();
      showToast(`✅ 已撤销，歌单「${pl.name}」已找回`, 'success');
    } else {
      showToast((back && back.error) || '撤销失败', 'error');
    }
  } catch (e) {
    showToast('撤销失败: ' + errBrief(e), 'error');
  }
}

// ── 回收站视图（增量157：F2 第三层兜底 —— 没赶上 5 秒撤销的歌单在这里找回）──
// 数据源仍是既有 get-user-playlists 频道（opts.trash=true 换视图），零新 IPC 通道；
// 恢复走 save-user-playlist 的"带 id 却不在列表 ⇒ 从回收站放回"分支，
// 彻底删除走 delete-user-playlist 的"再删一次回收站里的 id"分支。
let _plTrash = [];

async function refreshPlTrash() {
  try {
    _plTrash = (await api.getUserPlaylists({ trash: true })) || [];
  } catch (e) {
    // 徽标刷新失败不该惊动用户主流程，静默保持上一次状态
    logger.warn('回收站计数刷新失败:', e);
    return;
  }
  const btn = document.getElementById('plTrashBtn');
  if (btn) {
    btn.style.display = _plTrash.length ? '' : 'none';
    btn.textContent = `🗑 回收站 ${_plTrash.length}`;
  }
  const modal = document.getElementById('playlistTrashModal');
  if (modal && !modal.classList.contains('hidden')) renderPlTrashList();
}

/** 渲染弹窗内容：每行「歌单名 · N 首歌 · 剩余 X 天」+ 恢复 / 彻底删除 */
function renderPlTrashList() {
  const box = document.getElementById('playlistTrashList');
  if (!box) return;
  if (!_plTrash.length) {
    box.innerHTML = '<div class="empty" style="padding:24px 0;">回收站是空的</div>';
    return;
  }
  box.innerHTML = _plTrash.map(e => {
    const pl = e.playlist || {};
    const n = Array.isArray(pl.songs) ? pl.songs.length : 0;
    const when = new Date(e.deletedAt || 0);
    const dateStr = `${when.getMonth() + 1}月${when.getDate()}日`;
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid var(--line);">
      <div style="flex:1;min-width:0;">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;">${esc(pl.name || '未命名歌单')}</div>
        <div style="font-size:12px;color:var(--fg-3);">${n} 首歌 · ${dateStr}删除 · 剩余 ${e.daysLeft ?? '?'} 天</div>
      </div>
      <button class="btn-sm" onclick="restoreTrashedPlaylist('${escQ(pl.id)}')">↩️ 恢复</button>
      <button class="btn-sm" style="color:var(--c-danger);" onclick="purgeTrashedPlaylist('${escQ(pl.id)}')">彻底删除</button>
    </div>`;
  }).join('');
}

function openPlaylistTrash() {
  const modal = document.getElementById('playlistTrashModal');
  if (!modal) return;
  renderPlTrashList();
  modal.classList.remove('hidden');
  refreshPlTrash();
}

function closePlaylistTrash() {
  document.getElementById('playlistTrashModal').classList.add('hidden');
}

async function restoreTrashedPlaylist(playlistId) {
  const e = _plTrash.find(t => t.playlist && t.playlist.id === playlistId);
  if (!e) { showToast('该歌单已不在回收站，请刷新重试', 'warn'); return; }
  try {
    const r = await api.saveUserPlaylist(e.playlist);
    if (r && r.success) {
      await loadUserPlaylists();
      showToast(`✅ 歌单「${e.playlist.name}」已恢复`, 'success');
    } else {
      showToast((r && r.error) || '恢复失败', 'error');
    }
  } catch (err) {
    showToast('恢复失败: ' + errBrief(err), 'error');
  }
}

async function purgeTrashedPlaylist(playlistId) {
  // 增量157：彻底删除是真正不可逆的一层，确认框照 F2 纪律点名歌单与歌数
  const e = _plTrash.find(t => t.playlist && t.playlist.id === playlistId);
  if (!e) { showToast('该歌单已不在回收站，请刷新重试', 'warn'); return; }
  const pl = e.playlist;
  const n = Array.isArray(pl.songs) ? pl.songs.length : 0;
  if (!await askConfirm(`彻底删除歌单「${pl.name}」？\n\n• 歌单里有 ${n} 首歌，彻底删除后无法再找回（仍在 30 天期限内的其他歌单不受影响）\n• 歌曲文件与红心收藏不受影响`)) return;
  try {
    const r = await api.deleteUserPlaylist(playlistId);
    if (r && r.success) {
      await refreshPlTrash();
      showToast(`歌单「${pl.name}」已彻底删除`, 'success');
    } else {
      showToast((r && r.error) || '删除失败', 'error');
    }
  } catch (err) {
    showToast('删除失败: ' + errBrief(err), 'error');
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
      <div class="playlist-select-item" tabindex="0" role="button" onclick="addToSelectedPlaylist('${escQ(pl.id)}')">
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
    showToast('添加失败: ' + errBrief(e), 'error');
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

// ── 详情下载状态过滤循环（增量103：plDlFilter.js 纯函数的接线层）──
// 判定复用 dlStatusFor（与行内徽标同一来源），'done' 之外都算未下载
function _syncPlDlBtn() {
  const btn = document.getElementById('plDlFilterBtn');
  if (btn) btn.textContent = plDlModeLabel(_plDlMode);
}

function cyclePlDlFilter() {
  _plDlMode = nextPlDlMode(_plDlMode);
  _syncPlDlBtn();
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
  div.setAttribute('data-modal', '');
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
      box.innerHTML = `<div class="empty-hint" style="text-align:center;padding:20px;">搜索失败：${esc(errBrief(e))}</div>`;
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
    showToast('添加失败: ' + errBrief(e), 'error');
  }
}

// ── 导出当前打开歌单为 m3u（playlistExport 纯函数的接线层）──────
// 存储序全量导出（过滤/排序只是视图）；下载歌回填本地路径，在线歌回填平台页链接
let _plExportBusy = false;

async function exportCurrentPlaylistM3u() {
  const songs = _currentDetailSongs || [];
  if (!songs.length) { showToast('当前歌单没有歌曲可导出', 'warn', 2500); return; }
  if (_plExportBusy) return;
  _plExportBusy = true;
  try {
    const titleEl = document.getElementById('playlistDetailTitle');
    const name = (titleEl && titleEl.textContent.trim()) || '歌单';
    let pathMap = {};
    try {
      const h = await api.queryHistory({ status: 'done', limit: 100000 });
      pathMap = buildPathMap((h && h.items) || []);
    } catch (_e) { /* 历史不可用时退化为全页链接导出 */ }
    const r = await api.exportPlaylist({
      songs: enrichExportSongs(songs, pathMap),
      format: 'm3u',
      name: 'MusicDL-' + sanitizeFileBase(name),
    });
    if (r && r.canceled) return;
    if (r && r.success) showToast(`⤴ 已导出 ${songs.length} 首：${r.path}`, 'success', 3500);
    else showToast((r && r.error) || '导出失败', 'error');
  } catch (e) {
    showToast('导出失败: ' + errBrief(e), 'error');
  } finally {
    _plExportBusy = false;
  }
}

// ── 合并其他歌单进本歌单（playlistMerge 纯函数的接线层）──────
let _plMergeEl = null;
let _plMerging = false;

function _ensurePlMergeModal() {
  if (_plMergeEl && document.body.contains(_plMergeEl)) return _plMergeEl;
  const div = document.createElement('div');
  div.id = 'plMergeModal';
  div.className = 'playlist-modal-overlay hidden';
  div.setAttribute('data-modal', '');
  // 静态模板不含用户数据；歌单行经 esc/escQ 逐条渲染
  div.innerHTML = `
    <div class="playlist-modal" style="min-width:420px;max-width:560px;max-height:70vh;display:flex;flex-direction:column;">
      <div class="playlist-modal-header">
        <span class="playlist-modal-title">📥 合并其他歌单进本歌单</span>
        <button class="playlist-modal-close" onclick="closePlaylistMergePicker()">✕</button>
      </div>
      <div id="plMergeList" class="playlist-modal-body" style="flex:1;min-height:0;overflow-y:auto;padding:8px 16px 16px;"></div>
    </div>`;
  div.addEventListener('click', (e) => { if (e.target === div) closePlaylistMergePicker(); });
  document.body.appendChild(div);
  _plMergeEl = div;
  return div;
}

async function openPlaylistMergePicker() {
  if (!_currentPlaylistId) { showToast('请先打开一个歌单', 'warn'); return; }
  const m = _ensurePlMergeModal();
  m.classList.remove('hidden');
  const box = document.getElementById('plMergeList');
  box.innerHTML = '<div class="empty-hint" style="text-align:center;padding:20px;">加载中…</div>';
  try {
    const all = (await api.getUserPlaylists()) || [];
    const others = all.filter(p => p && p.id && p.id !== _currentPlaylistId);
    if (!others.length) {
      box.innerHTML = '<div class="empty-hint" style="text-align:center;padding:20px;">没有其他歌单可合并</div>';
      return;
    }
    box.innerHTML = others.map(p => `
      <div class="song-row">
        <div class="song-info">
          <div class="song-title">${esc(p.name) || '未命名'}</div>
          <div class="song-meta">${(p.songs || []).length} 首${p.desc ? ' · ' + esc(p.desc) : ''}</div>
        </div>
        <div class="song-actions">
          <button class="action-btn" onclick="mergePlaylistIntoCurrent('${escQ(p.id)}')" title="把该歌单的歌合入当前打开的歌单（重复歌自动跳过）">📥 合入</button>
        </div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty-hint" style="text-align:center;padding:20px;">加载失败：${esc(errBrief(e))}</div>`;
  }
}

function closePlaylistMergePicker() {
  if (_plMergeEl) _plMergeEl.classList.add('hidden');
}

async function mergePlaylistIntoCurrent(srcId) {
  if (!_currentPlaylistId || _plMerging) return;
  if (srcId === _currentPlaylistId) { showToast('不能合并到自己', 'warn'); return; }
  _plMerging = true;
  try {
    // 实时重拉两侧：卡片列表 state 可能已被其他入口改脏
    const all = (await api.getUserPlaylists()) || [];
    const target = all.find(p => p && p.id === _currentPlaylistId);
    const src = all.find(p => p && p.id === srcId);
    if (!target || !src) { showToast('歌单已不存在，请刷新重试', 'warn'); return; }
    const merged = mergeSongLists(target.songs || [], src.songs || []);
    if (!merged.added) {
      showToast(`「${src.name}」没有新歌可合入（重复 ${merged.dup} 首）`, 'info');
      return;
    }
    const r = await api.saveUserPlaylist({ id: target.id, name: target.name, songs: merged.songs });
    if (!r || !r.success) { showToast('合并失败：' + ((r && r.error) || '未知错误'), 'error'); return; }
    renderPlaylistDetailSongs((r.playlist && r.playlist.songs) || merged.songs);
    loadUserPlaylists(); // 卡片曲数/排序随合并后数据刷新
    closePlaylistMergePicker();
    showToast(`📥 已把「${src.name}」的 ${merged.added} 首合入本歌单（跳过重复 ${merged.dup} 首）`, 'success', 3500);
  } catch (e) {
    showToast('合并失败: ' + errBrief(e), 'error');
  } finally {
    _plMerging = false;
  }
}

// 🧹 清理本歌单内重复歌：复用合入键（平台:id，无键退 标题|歌手），保留首次出现
let _plDedupeBusy = false;

async function dedupeCurrentPlaylist() {
  if (!_currentPlaylistId || _plDedupeBusy) return;
  _plDedupeBusy = true;
  try {
    const all = (await api.getUserPlaylists()) || [];
    const pl = all.find(p => p && p.id === _currentPlaylistId);
    if (!pl) { showToast('歌单已不存在，请刷新重试', 'warn'); return; }
    const before = (pl.songs || []).length;
    const merged = mergeSongLists(pl.songs || [], []);
    const removed = before - merged.songs.length;
    if (!removed) { showToast('本歌单没有重复歌曲', 'info'); return; }
    const r = await api.saveUserPlaylist({ id: pl.id, name: pl.name, songs: merged.songs });
    if (!r || !r.success) { showToast('清理失败：' + ((r && r.error) || '未知错误'), 'error'); return; }
    renderPlaylistDetailSongs((r.playlist && r.playlist.songs) || merged.songs);
    loadUserPlaylists(); // 卡片曲数同步
    showToast(`🧹 已移除 ${removed} 首重复歌曲，保留 ${merged.songs.length} 首`, 'success', 3000);
  } catch (e) {
    showToast('清理失败: ' + errBrief(e), 'error');
  } finally {
    _plDedupeBusy = false;
  }
}

// 📋 另存副本：实时重拉整单原样复制（在线曲目 source+id 全带走），撞名递增让位；
// 无 id 的 save-user-playlist 即新建，零新通道
let _plDupBusy = false;

async function duplicateCurrentPlaylist() {
  if (!_currentPlaylistId || _plDupBusy) return;
  _plDupBusy = true;
  try {
    const all = (await api.getUserPlaylists()) || [];
    const pl = all.find(p => p && p.id === _currentPlaylistId);
    if (!pl) { showToast('歌单已不存在，请刷新重试', 'warn'); return; }
    const newName = dupPlaylistName(pl.name, all.map(p => p && p.name).filter(Boolean));
    const r = await api.saveUserPlaylist(dupPlaylistPayload(pl, newName));
    if (!r || !r.success) { showToast('复制失败：' + ((r && r.error) || '未知错误'), 'error'); return; }
    loadUserPlaylists(); // 卡片列表随新副本刷新
    showToast(`📋 已另存副本「${newName}」（${(pl.songs || []).length} 首）`, 'success', 3000);
  } catch (e) {
    showToast('复制失败: ' + errBrief(e), 'error');
  } finally {
    _plDupBusy = false;
  }
}

// 📋 复制曲单：当前过滤视图整成一行一首纯文本（歌名 - 歌手）进剪贴板，
// 发群聊直接贴清单；增量58 是行级分享文案（带链接），这里是清单级，零新通道
async function copyPlaylistListText() {
  const lines = toTrackLines(_plVisiblePairs(_currentDetailSongs).map(p => p.song));
  if (!lines.length) { showToast('当前视图没有可复制的歌曲', 'info'); return; }
  const ok = await copyText(lines.join('\n'));
  showToast(ok ? `📋 已复制 ${lines.length} 首歌名清单` : '复制失败：剪贴板被占用或无权限', ok ? 'success' : 'error', 2500);
}

// ── 🧮 跨歌单重复检测（增量117）：纯函数扫描 + 报告弹层 + 复制，零新通道 ──
let _dedupeGroups = [];

function showDedupeModal(groups) {
  _dedupeGroups = groups;
  const old = document.getElementById('dedupeScanModal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'dedupeScanModal';
  overlay.className = 'playlist-modal-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.innerHTML = `
    <div class="playlist-modal" style="max-width:540px;">
      <div class="playlist-modal-header">
        <span class="playlist-modal-title">🧮 跨歌单重复 · ${groups.length} 首</span>
        <button class="playlist-modal-close" onclick="closeDedupeScanModal()">✕</button>
      </div>
      <div class="playlist-modal-body" style="max-height:60vh;overflow-y:auto;">
        ${groups.map((g, i) => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid rgba(255,255,255,0.06);">
            <div style="min-width:0;">
              <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(g.title)}${g.artist ? ` <span style="opacity:0.6;font-weight:400;font-size:12px;">${esc(g.artist)}</span>` : ''}</div>
              <div style="font-size:12px;color:var(--neon-dim);">${g.where.map(w => esc(w)).join('、')}</div>
            </div>
            <span style="flex:none;font-size:12px;color:var(--neon-dim);">×${g.where.length}</span>
            <button class="tab" style="flex:none;" title="保留在首见歌单，从其余歌单移出这一首（不删文件）" onclick="consolidateDup(${i})">🧲 收拢</button>
          </div>`).join('')}
        <div style="margin-top:12px;">
          <button class="btn-primary" onclick="copyDedupeScanReport()">📋 复制报告</button>
        </div>
      </div>
    </div>`;
  overlay.onclick = (e) => { if (e.target === overlay) closeDedupeScanModal(); };
  document.body.appendChild(overlay);
}

function scanCrossPlaylistDupes() {
  const pls = (getState('userPlaylists') || []).filter(p => p && Array.isArray(p.songs));
  if (pls.length < 2) { showToast('至少要有两个歌单才谈得上「跨单重复」', 'info'); return; }
  const groups = findCrossPlaylistDupes(pls);
  if (!groups.length) { showToast(`🧮 ${pls.length} 个歌单互不重复，很干净`, 'success', 2500); return; }
  showDedupeModal(groups);
}

function closeDedupeScanModal() {
  const m = document.getElementById('dedupeScanModal');
  if (m) m.remove();
}

async function copyDedupeScanReport() {
  const body = dedupeScanText(_dedupeGroups);
  if (!body) { showToast('没有可复制的内容', 'info'); return; }
  const ok = await copyText(`🧮 MusicDL 跨歌单重复报告（${_dedupeGroups.length} 首）\n${body}`);
  showToast(ok ? '📋 重复报告已复制' : '复制失败：剪贴板被占用或无权限', ok ? 'success' : 'error', 2500);
}

/** 🧲 收拢一组重复（增量118）：留首见单、其余整单更新，写完重扫刷新弹层 */
async function consolidateDup(i) {
  const g = _dedupeGroups[i];
  if (!g || !g.key) { showToast('该行缺身份键，收拢不了，重新扫描试试', 'warn'); return; }
  const plan = planConsolidate(getState('userPlaylists') || [], g.key);
  if (!plan) { showToast('这些歌单里该歌已变化，重新扫描看看', 'info'); closeDedupeScanModal(); return; }
  if (!await askConfirm(`「${g.title}」保留在「${plan.keepPlName}」，从其他 ${plan.updates.length} 个歌单移出 ${plan.removed} 份？（不删文件）`)) return;
  try {
    let done = 0;
    for (const u of plan.updates) {
      const r = await api.saveUserPlaylist(u);
      if (r && r.success) done++;
    }
    if (!done) { showToast('收拢失败：一个歌单都没写成', 'error'); return; }
    if (typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();
    showToast(`🧲 「${g.title}」已收拢到「${plan.keepPlName}」（移出 ${plan.removed} 份）`, 'success', 3000);
    const rest = findCrossPlaylistDupes((getState('userPlaylists') || []).filter(p => p && Array.isArray(p.songs)));
    if (rest.length) showDedupeModal(rest); else closeDedupeScanModal();
  } catch (e) {
    logger.error('[consolidateDup] 失败:', e);
    showToast('收拢失败: ' + errBrief(e), 'error');
  }
}

// ── 初始化 ────────────────────────────────────────────
// 收藏状态变化 → 收藏夹详情即时同步（行内 ♥ 取消收藏后该行立刻消失）。
// router 每次进歌单页都会调 initPlaylistView，故用一次性绑定防重复订阅。
let _plFavSyncBound = false;
function _bindFavDetailSync() {
  if (_plFavSyncBound) return;
  _plFavSyncBound = true;
  subscribe('userPlaylists', (pls) => {
    if (_currentPlaylistId !== FAVORITES_PLAYLIST_ID) return;
    const modal = document.getElementById('playlistDetailModal');
    if (!modal || modal.classList.contains('hidden')) return;
    const pl = (pls || []).find(p => p && p.id === FAVORITES_PLAYLIST_ID);
    if (pl) renderPlaylistDetailSongs(pl.songs || []);
  });
}

function initPlaylistView() {
  _bindFavDetailSync();
  loadUserPlaylists();
}

// 🎯 定位正在播放的歌：行选择器 data-pidx 存的是存储序下标，排序视图也能命中
function locatePlayingInDetail() {
  if (!_currentPlaylistId) { showToast('先打开一个歌单', 'info'); return; }
  const cur = typeof getState === 'function' ? getState('currentPlaying') : null;
  const idx = indexOfPlaying(_currentDetailSongs, cur);
  if (idx < 0) { showToast('正在播放的歌不在本歌单', 'info'); return; }
  let row = document.querySelector(`#playlistDetailSongs .song-row[data-pidx="${idx}"]`);
  if (!row && _plSongKw) { // 被关键词过滤藏了：清过滤重渲染后再找
    _plSongKw = '';
    renderPlaylistDetailSongs(_currentDetailSongs);
    row = document.querySelector(`#playlistDetailSongs .song-row[data-pidx="${idx}"]`);
  }
  if (!row) { showToast('该行当前不在可见列表（检查排序/过滤）', 'info'); return; }
  flashRow(row);
}

// ── window 桥接（HTML onclick / 跨模块调用）────────────
window.loadUserPlaylists = loadUserPlaylists;
window.openPlaylistDetail = openPlaylistDetail;
window.closePlaylistDetail = closePlaylistDetail;
window.playPlaylistSong = playPlaylistSong;
window.addPlaylistSongToQueue = addPlaylistSongToQueue;
window.downloadPlaylistSong = downloadPlaylistSong;
window.downloadAllPlaylist = downloadAllPlaylist;
window.exportCurrentPlaylistM3u = exportCurrentPlaylistM3u;
window.openPlaylistMergePicker = openPlaylistMergePicker;
window.closePlaylistMergePicker = closePlaylistMergePicker;
window.mergePlaylistIntoCurrent = mergePlaylistIntoCurrent;
window.dedupeCurrentPlaylist = dedupeCurrentPlaylist;
window.copyPlaylistListText = copyPlaylistListText;
window.locatePlayingInDetail = locatePlayingInDetail;
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
// 增量157：回收站视图（弹窗行内按钮经 onclick 全局调用）
window.refreshPlTrash = refreshPlTrash;
window.openPlaylistTrash = openPlaylistTrash;
window.closePlaylistTrash = closePlaylistTrash;
window.restoreTrashedPlaylist = restoreTrashedPlaylist;
window.purgeTrashedPlaylist = purgeTrashedPlaylist;
window.quickAddToPlaylist = quickAddToPlaylist;
window.closePlaylistSelectModal = closePlaylistSelectModal;
window.addToSelectedPlaylist = addToSelectedPlaylist;
window.initPlaylistView = initPlaylistView;
window.togglePlBulkMode = togglePlBulkMode;
window.togglePlSongSel = togglePlSongSel;
window.plSelectAllVisible = plSelectAllVisible;
window.removeCheckedFromPlaylist = removeCheckedFromPlaylist;
window.plSelDownload = plSelDownload;
window.plSelPlay = plSelPlay;
window.cyclePlDlFilter = cyclePlDlFilter;
window.duplicateCurrentPlaylist = duplicateCurrentPlaylist;
window.scanCrossPlaylistDupes = scanCrossPlaylistDupes;
window.closeDedupeScanModal = closeDedupeScanModal;
window.copyDedupeScanReport = copyDedupeScanReport;
window.consolidateDup = consolidateDup;
