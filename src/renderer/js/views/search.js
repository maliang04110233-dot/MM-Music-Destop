/**
 * MusicDL 搜索视图 - 单曲/专辑/歌手搜索 + 批量操作
 */

import { logger } from '../logger.js';

// ── DOM 缓存（避免重复查询）──────────────────────────
const _dom = {
  searchInput: null,
  songList: null,
  batchToolbar: null,
  pagination: null,
  searchHistory: null,
};

function _cacheDom() {
  _dom.searchInput = document.getElementById('searchInput');
  _dom.songList = document.getElementById('songList');
  _dom.batchToolbar = document.getElementById('batchToolbar');
  _dom.pagination = document.getElementById('pagination');
  _dom.searchHistory = document.getElementById('searchHistory');
}

// 检查 API 是否可用
function checkAPI() {
  if (!window.musicAPI || typeof window.musicAPI.searchMusic !== 'function') {
    logger.warn('[checkAPI] API不可用:', typeof window.musicAPI);
    return false;
  }
  return true;
}

// 清除加载状态
function clearLoading() {
  if (_dom.songList) _dom.songList.innerHTML = '';
  if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'none';
  if (_dom.pagination) _dom.pagination.style.display = 'none';
}

// 显示错误状态
function showLoadError(msg) {
  if (_dom.songList) {
    _dom.songList.innerHTML = `<div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-text">加载失败</div>
      <div class="empty-hint">${esc(msg || '')}</div>
    </div>`;
  }
  if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'none';
  if (_dom.pagination) _dom.pagination.style.display = 'none';
}

const MAX_HISTORY = 20;

// ── 搜索防抖 ──────────────────────────────────────────
let _searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 300;

function debounceSearch() {
  if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    _searchDebounceTimer = null;
    const keyword = _dom.searchInput?.value?.trim();
    if (keyword && keyword.length >= 2) {
      doSearch(1);
    }
    hideSearchSuggestions();
  }, SEARCH_DEBOUNCE_MS);
  // 显示搜索建议
  showSearchSuggestions();
}

// ── 搜索建议（基于最近播放 + 搜索历史）──────────────
function showSearchSuggestions() {
  const input = _dom.searchInput;
  if (!input) return;
  const kw = input.value.trim().toLowerCase();
  if (!kw || kw.length < 1) {
    hideSearchSuggestions();
    return;
  }

  // 从最近播放和搜索历史中筛选匹配项
  const recentlyPlayed = typeof getRecentlyPlayed === 'function' ? getRecentlyPlayed() : [];
  const suggestions = [];

  // 最近播放匹配
  for (const song of recentlyPlayed) {
    if (suggestions.length >= 5) break;
    const title = (song.title || '').toLowerCase();
    const artist = (song.artist || '').toLowerCase();
    if (title.includes(kw) || artist.includes(kw)) {
      suggestions.push({
        type: 'recent',
        title: song.title,
        artist: song.artist,
        icon: '🎵',
      });
    }
  }

  // 搜索历史匹配
  getSearchHistory().then(history => {
    for (const h of history) {
      if (suggestions.length >= 8) break;
      if (h.keyword && h.keyword.toLowerCase().includes(kw)) {
        const exists = suggestions.some(s => s.title === h.keyword);
        if (!exists) {
          suggestions.push({
            type: 'history',
            title: h.keyword,
            icon: '🕐',
          });
        }
      }
    }

    if (!suggestions.length) {
      hideSearchSuggestions();
      return;
    }

    // 渲染建议列表
    let container = document.getElementById('searchSuggestions');
    if (!container) {
      container = document.createElement('div');
      container.id = 'searchSuggestions';
      container.className = 'search-suggestions';
      input.parentElement.appendChild(container);
    }

    container.innerHTML = suggestions.map(s => `
      <div class="suggestion-item" onmousedown="selectSuggestion('${escAttr(s.title)}')">
        <span class="suggestion-icon">${s.icon}</span>
        <span class="suggestion-title">${esc(s.title)}</span>
        ${s.artist ? `<span class="suggestion-artist">${esc(s.artist)}</span>` : ''}
      </div>
    `).join('');
    container.style.display = 'block';
  });
}

function hideSearchSuggestions() {
  const container = document.getElementById('searchSuggestions');
  if (container) container.style.display = 'none';
}

function selectSuggestion(keyword) {
  const input = _dom.searchInput;
  if (input) {
    input.value = keyword;
    doSearch(1);
  }
  hideSearchSuggestions();
}

// ── 搜索视图清理（切换页面时调用）─────────────────────
function searchCleanup() {
  if (_searchDebounceTimer) {
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = null;
  }
  hideSearchSuggestions();
  hideSearchHistory();
}

// ── 搜索类型状态 ─────────────────────────────────────
let _searchType = 'song'; // 'song' | 'album' | 'singer'

// ── 批量选择模式 ─────────────────────────────────────
let _searchBatchMode = false;

function enterSearchBatchMode() {
  _searchBatchMode = true;
  const btn = document.getElementById('searchSelectBtn');
  if (btn) btn.classList.add('active');
  const songList = document.getElementById('songList');
  if (songList) songList.classList.add('batch-mode');
  setState('selectedSongs', new Set());
  updateBatchInfo();
  // 显示批量工具栏（如果有搜索结果）
  const songs = getState('songs');
  if (songs && songs.length > 0 && _dom.batchToolbar) {
    _dom.batchToolbar.style.display = 'flex';
  }
}

function exitSearchBatchMode() {
  _searchBatchMode = false;
  const btn = document.getElementById('searchSelectBtn');
  if (btn) btn.classList.remove('active');
  const songList = document.getElementById('songList');
  if (songList) songList.classList.remove('batch-mode');
  setState('selectedSongs', new Set());
  if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'none';
  // 隐藏进度条
  const progressWrap = document.getElementById('batchProgressWrap');
  if (progressWrap) progressWrap.style.display = 'none';
  // 重新渲染以清除 checkbox 选中状态
  const songs = getState('songs');
  if (songs && songs.length > 0) renderSongList(songs);
}

// ── 搜索历史（持久化到主进程 prefs.json，修复 B8）─────────────────────
let _searchHistoryCache = null;  // 内存缓存，首次 await 加载

async function getSearchHistory() {
  if (_searchHistoryCache !== null) return _searchHistoryCache;
  try {
    const result = await api.getSearchHistory();
    _searchHistoryCache = Array.isArray(result) ? result : [];
  } catch {
    _searchHistoryCache = [];
  }
  return _searchHistoryCache;
}

function addSearchHistory(keyword) {
  getSearchHistory().then(history => {
    const filtered = history.filter(h => h.keyword !== keyword);
    filtered.unshift({ keyword, time: Date.now() });
    if (filtered.length > MAX_HISTORY) filtered.length = MAX_HISTORY;
    _searchHistoryCache = filtered;
    api.setSearchHistory(filtered).catch(() => {});
  });
}

function removeSearchHistory(keyword) {
  getSearchHistory().then(history => {
    const filtered = history.filter(h => h.keyword !== keyword);
    _searchHistoryCache = filtered;
    api.setSearchHistory(filtered).catch(() => {});
    showSearchHistory();
  });
}

function clearSearchHistory() {
  _searchHistoryCache = [];
  api.setSearchHistory([]).catch(() => {});
  if (_dom.searchHistory) _dom.searchHistory.style.display = 'none';
  showToast('搜索历史已清除', 'info');
}

function showSearchHistory() {
  getSearchHistory().then(history => {
    const el = _dom.searchHistory;
    if (!el) return;
    if (!history.length) { el.style.display = 'none'; return; }

    const kw = _dom.searchInput?.value?.trim()?.toLowerCase() || '';
    const filtered = kw
      ? history.filter(h => h.keyword.toLowerCase().includes(kw))
      : history;
    if (!filtered.length) { el.style.display = 'none'; return; }

    el.innerHTML = `
      <div class="search-history-header">
        <span>搜索历史</span>
        <button class="history-clear-btn" onclick="event.stopPropagation();clearSearchHistory()">清空</button>
      </div>
      ${filtered.map(h => `
      <div class="search-history-item">
        <span class="history-icon">🕐</span>
        <span class="history-kw" onmousedown="event.preventDefault();searchInput.value='${esc(h.keyword)}';doSearch(1);hideSearchHistory()">${esc(h.keyword)}</span>
        <span class="history-meta">
          <span class="history-time">${fmtHistoryTime(h.time)}</span>
          <button class="history-del-btn" onclick="event.stopPropagation();removeSearchHistory('${escQ(h.keyword)}')" title="删除">✕</button>
        </span>
      </div>
    `).join('')}`;
    el.style.display = 'block';
  }).catch(e => logger.warn('[showSearchHistory] 加载搜索历史失败:', e.message));
}

function hideSearchHistory() {
  setTimeout(() => {
    if (_dom.searchHistory) _dom.searchHistory.style.display = 'none';
  }, 200);
}

// fmtHistoryTime 已由 utils.js 全局导出

// ── 搜索类型切换 ─────────────────────────────────────
function switchSearchType(type, btn) {
  _searchType = type;
  document.querySelectorAll('.search-type-tabs .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  if (_dom.searchInput?.value?.trim()) doSearch(1);
}

// ── 统一搜索入口 ─────────────────────────────────────
// ── 搜索结果 LRU 缓存 ─────────────────────────────────
const _searchCache = new Map();
const SEARCH_CACHE_MAX = 20;
const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

function _searchCacheKey(type, page, keyword, source) {
  return `${type}:${source || ''}:${keyword}:${page}`;
}

function _searchCacheGet(key) {
  const entry = _searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SEARCH_CACHE_TTL) {
    _searchCache.delete(key);
    return null;
  }
  return entry.data;
}

function _searchCacheSet(key, data) {
  if (_searchCache.size >= SEARCH_CACHE_MAX) {
    // 删除最旧的
    const oldest = _searchCache.keys().next().value;
    _searchCache.delete(oldest);
  }
  _searchCache.set(key, { data, ts: Date.now() });
}

async function doSearchByType(type, page, keyword, source) {
  const cacheKey = _searchCacheKey(type, page, keyword, source);
  const cached = _searchCacheGet(cacheKey);
  if (cached) {
    const stateKey = { song: 'songs', album: 'albums', singer: 'singers' };
    const renderMap = { song: renderSongList, album: renderAlbumList, singer: renderSingerList };
    const paginationMap = { song: renderPagination, album: renderAlbumPagination, singer: renderSingerPagination };
    setState(stateKey[type], cached.items);
    renderMap[type](cached.items);
    if (paginationMap[type]) paginationMap[type](page, cached.items.length, cached.total);
    if (type === 'song' && cached.items.length > 0 && _searchBatchMode) {
      if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'flex';
      updateBatchInfo();
    }
    return cached.items;
  }

  const apiMap = {
    song: () => api.searchMusic(keyword, source, page),
    album: () => api.searchAlbum(keyword, source || 'qq', page),
    singer: () => api.searchSinger(keyword, source || 'qq', page),
  };
  const stateKey = { song: 'songs', album: 'albums', singer: 'singers' };
  const renderMap = { song: renderSongList, album: renderAlbumList, singer: renderSingerList };
  const paginationMap = { song: renderPagination, album: renderAlbumPagination, singer: renderSingerPagination };

  try {
    const result = await apiMap[type]();
    const items = (result && result[type === 'song' ? 'songs' : type + 's']) || [];
    // 存入缓存
    if (!result?.error) {
      _searchCacheSet(cacheKey, { items, total: result?.total || 0 });
    }
    setState(stateKey[type], items);
    if (result && result.error) showToast('搜索出错：' + result.error, 'warn', 3500);
    renderMap[type](items);
    if (paginationMap[type]) {
      paginationMap[type](page, items.length, result.total);
    }
    if (type === 'song' && items.length > 0 && _searchBatchMode) {
      if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'flex';
      updateBatchInfo();
    }
    return items;
  } catch (e) {
    clearLoading();
    showLoadError(e.message);
    return [];
  }
}

// ── 主搜索入口 ───────────────────────────────────────
// ── 粘贴链接智能识别 ─────────────────────────────────
// doSearch 先走这里：输入是平台链接时直接拉歌/开歌单弹窗，置 _linkHandled
// 让 doSearch 跳过常规搜索流程
let _linkHandled = false;

async function handleLinkInput(text) {
  let r;
  try {
    r = await api.getSongByLink(text);
  } catch (e) {
    logger.warn('[linkInput] 识别请求失败:', e);
    return; // 网络失败按普通关键词继续搜索
  }
  if (!r || !r.matched) {
    // 平台短链无法本地解析：给出明确指引，同样回退普通搜索
    if (r && r.shortLink) {
      showToast('检测到短链，请先在浏览器打开后复制完整链接', 'info', 4000);
    }
    return;
  }

  _linkHandled = true;

  // 单曲：直接渲染进搜索结果列表（复用现有单曲卡片，播放/下载/加队列全可用）
  if (r.song) {
    addSearchHistory(r.song.title + ' - ' + r.song.artist);
    setState('currentKeyword', r.song.title);
    setState('songs', [r.song]);
    setState('selectedSongs', new Set());
    if (_dom.songList) _dom.songList.innerHTML = '';
    if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'none';
    if (_dom.pagination) _dom.pagination.style.display = 'none';
    renderSongList([r.song]);
    showToast(`🔗 已识别 ${srcLabel(r.song.source)}链接：${r.song.title}`, 'success', 3000);
    return;
  }

  // 专辑/歌单链接：解析出 { type, id }，复用歌单弹窗展示曲目
  const link = r.link || {};
  if (link.type === 'album' || link.type === 'playlist') {
    // 歌单链接 → openPlaylistModal 内部走 getPlaylistSongs（歌单接口）
    // 专辑链接 → 同弹窗但走 getAlbumSongs（专辑接口；两者的后端 API 不同）
    if (link.type === 'playlist' && link.platform === 'netease') {
      openPlaylistModal('netease', link.id, '网易云歌单');
    } else if (link.type === 'album') {
      openAlbumSongsModal(link.platform, link.id);
    } else {
      showToast('暂不支持该平台的歌单链接', 'warn', 3000);
      _linkHandled = false; // 回退普通搜索
    }
    return;
  }

  // matched 但既无 song 又非专辑/歌单（拉详情失败）
  if (r.error) {
    showToast('链接识别：' + r.error, 'error', 4000);
  }
  _linkHandled = false; // 回退普通搜索，用户至少还能搜歌名
}

/**
 * 专辑链接 → 歌单弹窗（走 getAlbumSongs；与 openPlaylistModal 的区别只在拉曲目的接口）
 */
async function openAlbumSongsModal(platform, albumId) {
  const nameMap = { netease: '网易云专辑', qq: 'QQ音乐专辑', kugou: '酷狗专辑', bilibili: 'B站合集' };
  document.getElementById('playlistModalTitle').textContent = '📀 ' + (nameMap[platform] || '专辑');
  document.getElementById('playlistModal').classList.remove('hidden');
  const body = document.getElementById('playlistModalBody');
  body.innerHTML = '<div class="loading"><div class="spinner"></div> 加载中...</div>';
  state.setPlaylistSongs([]);
  state.setPlaylistChecked(new Set());
  try {
    const songs = await api.getAlbumSongs(platform, albumId, 200);
    if (!songs.length) {
      body.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:16px;text-align:center;">专辑暂无歌曲（链接可能已失效）</div>';
      return;
    }
    state.setPlaylistSongs(songs);
    state.setPlaylistChecked(new Set(songs.map((_, i) => i)));
    state.setPlaylistLocalExists(new Map());
    renderPlaylistModal(songs);
  } catch (e) {
    body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:16px;text-align:center;">加载失败: ' + esc(e.message || e) + '</div>';
  }
}

function doSearch(page = 1) {
  const keyword = _dom.searchInput?.value?.trim();
  if (!keyword) { showToast('请输入搜索关键词', 'error'); return; }

  if (!checkAPI()) {
    clearLoading();
    showLoadError('音乐API未加载，请刷新重试');
    showToast('音乐API未加载，请刷新重试', 'error', 3000);
    return;
  }

  // 粘贴链接智能识别：输入是平台链接（含分享文案）→ 直接拉歌，不走关键词搜索
  handleLinkInput(keyword);
  if (_linkHandled) { _linkHandled = false; return; }

  addSearchHistory(keyword);
  setState('currentKeyword', keyword);
  setState('currentPage', page);
  setState('selectedSongs', new Set());
  // 新搜索时退出批量选择模式
  if (_searchBatchMode) exitSearchBatchMode();
  hideSearchHistory();

  if (_dom.songList) {
    _dom.songList.innerHTML = '<div class="loading"><div class="spinner"></div> 搜索中...</div>';
  }
  if (_dom.batchToolbar) _dom.batchToolbar.style.display = 'none';
  if (_dom.pagination) _dom.pagination.style.display = 'none';

  doSearchByType(_searchType, page, keyword, getState('currentSource'));
}

// ── 歌手渲染 ─────────────────────────────────────────
function renderSingerList(list) {
  const el = document.getElementById('songList');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🔍</div>
      <div class="empty-text">未找到相关歌手</div>
      <div class="empty-hint">换个关键词试试</div>
    </div>`;
    return;
  }
  el.innerHTML = list.map(s => `
    <div class="singer-row" ondblclick="openSingerDetail('${escQ(s.mid)}', '${escQ(s.name)}', '${escQ(s.source)}')">
      ${s.avatar
        ? `<img class="singer-avatar" src="${escAttr(s.avatar)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="singer-avatar-ph" ${s.avatar ? 'style="display:none"' : ''}>🎤</div>
      <div class="singer-info">
        <div class="singer-name">${esc(s.name)}</div>
        <div class="singer-meta">歌曲 ${s.songCount || 0} · 专辑 ${s.albumCount || 0} · MV ${s.mvCount || 0}</div>
      </div>
      <div class="singer-actions">
        <button class="action-btn" title="查看详情" onclick="openSingerDetail('${escQ(s.mid)}', '${escQ(s.name)}', '${escQ(s.source)}')">📋</button>
      </div>
    </div>
  `).join('');
}

function renderSingerPagination(page, count, total) {
  const pg = document.getElementById('pagination');
  const hasMore = count >= 20 || page * 20 < total;
  pg.style.display = 'flex';
  pg.innerHTML = `
    <button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="doSearch(${page - 1})">上一页</button>
    <button class="page-btn active">第 ${page} 页</button>
    <button class="page-btn" ${!hasMore ? 'disabled' : ''} onclick="doSearch(${page + 1})">下一页</button>
  `;
}

// ── 专辑渲染 ─────────────────────────────────────────
function renderAlbumList(list) {
  const el = document.getElementById('songList');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🔍</div>
      <div class="empty-text">未找到相关专辑</div>
      <div class="empty-hint">换个关键词试试</div>
    </div>`;
    return;
  }
  el.innerHTML = list.map(a => `
    <div class="album-row" ondblclick="openAlbumDetail('${escQ(a.mid)}', '${escQ(a.source)}')">
      ${a.cover
        ? `<img class="album-cover" src="${escAttr(a.cover)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="album-cover-ph" ${a.cover ? 'style="display:none"' : ''}>💿</div>
      <div class="album-info">
        <div class="album-title">${esc(a.title)}</div>
        <div class="album-meta">${esc(a.artist)}${a.songCount ? ' · ' + a.songCount + ' 首' : ''}${a.publishTime ? ' · ' + a.publishTime : ''}</div>
      </div>
      <div class="album-actions">
        <button class="action-btn" title="查看详情" onclick="openAlbumDetail('${escQ(a.mid)}', '${escQ(a.source)}')">📋</button>
        <button class="action-btn" title="下载整张专辑" onclick="downloadAlbum('${escQ(a.mid)}', '${escQ(a.source)}')">⬇</button>
      </div>
    </div>
  `).join('');
}

function renderAlbumPagination(page, count, total) {
  const pg = document.getElementById('pagination');
  const hasMore = count >= 20 || page * 20 < total;
  pg.style.display = 'flex';
  pg.innerHTML = `
    <button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="doSearch(${page - 1})">上一页</button>
    <button class="page-btn active">第 ${page} 页</button>
    <button class="page-btn" ${!hasMore ? 'disabled' : ''} onclick="doSearch(${page + 1})">下一页</button>
  `;
}

// ── 专辑翻页（复用 doSearch）──────────────────────────
// pagination onclick 已统一用 doSearch(x)

// ── 打开专辑详情 ─────────────────────────────────────
async function openAlbumDetail(albumMid, source) {
  const el = document.getElementById('songList');
  el.innerHTML = '<div class="loading"><div class="spinner"></div> 加载专辑中...</div>';
  try {
    const songs = await api.getAlbumSongs(source || 'qq', albumMid, 999);
    setState('songs', songs);
    _searchType = 'song';
    renderSongList(songs);
    document.getElementById('pagination').style.display = 'none';
    document.getElementById('batchToolbar').style.display = (songs.length && _searchBatchMode) ? 'flex' : 'none';
    showToast(`专辑共 ${songs.length} 首`, 'info', 2000);
  } catch (e) {
    clearLoading();
    showLoadError(e.message);
  }
}

async function downloadAlbum(albumMid, source) {
  try {
    const songs = await api.getAlbumSongs(source || 'qq', albumMid, 999);
    if (!songs.length) { showToast('专辑无歌曲', 'warn'); return; }
    const quality = document.getElementById('qualitySelect').value;
    const saveDir = getState('saveDir');
    let queued = 0, dlSkipped = 0;
    for (const s of songs) {
      const existing = (state.get('queueSnapshot') || []).find(q =>
        q.id === s.id && q.source === s.source && q.status !== 'done');
      if (existing) continue;
      // 批量场景：历史已下载且文件还在 → 静默跳过（add-to-queue 返回 alreadyDownloaded）
      const r = await api.addToQueue({ ...s, saveDir, quality });
      if (r && r.queued) queued++;
      else if (r && r.alreadyDownloaded) dlSkipped++;
    }
    let msg = `专辑 ${queued} 首已加入下载队列`;
    if (dlSkipped) msg += `，跳过 ${dlSkipped} 首已下载过`;
    showToast(msg, 'success');
  } catch (e) {
    showToast('下载专辑失败: ' + (e.message || e), 'error');
  }
}

// ── 歌手详情 ─────────────────────────────────────────
let _singerDetailTab = 'songs'; // 'songs' | 'albums'

async function openSingerDetail(singerMid, singerName, source) {
  const el = document.getElementById('songList');
  el.innerHTML = `
    <div class="singer-detail-header">
      <button class="back-btn" onclick="backToSearch()">← 返回</button>
      <span class="singer-detail-name">${esc(singerName)}</span>
    </div>
    <div class="singer-detail-tabs">
      <button class="tab ${_singerDetailTab === 'songs' ? 'active' : ''}" onclick="switchSingerTab('songs', this)">热门歌曲</button>
      <button class="tab ${_singerDetailTab === 'albums' ? 'active' : ''}" onclick="switchSingerTab('albums', this)">全部专辑</button>
    </div>
    <div id="singerDetailContent"><div class="loading"><div class="spinner"></div> 加载中...</div></div>
  `;
  state.set('currentSinger', { mid: singerMid, source: source || 'qq' });
  try {
    await loadSingerDetail(singerMid, _singerDetailTab);
  } catch (e) {
    clearLoading();
    showLoadError(e.message);
  }
}

async function switchSingerTab(tab, btn) {
  try {
    _singerDetailTab = tab;
    document.querySelectorAll('.singer-detail-tabs .tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const singer = state.get('currentSinger');
    if (singer) await loadSingerDetail(singer.mid, tab);
  } catch (e) {
    logger.error(`[switchSingerTab] error:`, e);
  }
}

async function loadSingerDetail(singerMid, tab) {
  const el = document.getElementById('singerDetailContent');
  el.innerHTML = '<div class="loading"><div class="spinner"></div> 加载中...</div>';
  const singer = state.get('currentSinger');
  const source = singer ? singer.source : 'qq';
  try {
    if (tab === 'songs') {
      const songs = await api.getSingerSongs(singerMid, 50);
      setState('songs', songs);
      _searchType = 'song';
      renderSongList(songs);
      document.getElementById('batchToolbar').style.display = (songs.length && _searchBatchMode) ? 'flex' : 'none';
      updateBatchInfo();
    } else {
      const result = await api.getSingerAlbums(singerMid, source, 1, 99);
      const albums = (result && result.albums) || [];
      setState('albums', albums);
      renderAlbumList(albums);
      document.getElementById('batchToolbar').style.display = 'none';
    }
    // 把内容移入 songList
    const content = document.getElementById('singerDetailContent');
    document.getElementById('songList').innerHTML = content.innerHTML;
  } catch (e) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-text">加载失败</div>
      <div class="empty-hint">${e.message || ''}</div>
    </div>`;
  }
}

function backToSearch() {
  const kw = getState('currentKeyword');
  if (kw) {
    _searchType = 'singer';
    doSearch(1);
  } else {
    document.getElementById('songList').innerHTML = '';
  }
}

// ── 单曲渲染 ─────────────────────────────────────────
function renderSongList(list) {
  const el = document.getElementById('songList');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🔍</div>
      <div class="empty-text">未找到相关歌曲</div>
      <div class="empty-hint">换个关键词试试</div>
    </div>`;
    return;
  }
  // 批量模式下保持 batch-mode class
  if (_searchBatchMode) {
    el.classList.add('batch-mode');
  } else {
    el.classList.remove('batch-mode');
  }
  const selected = getState('selectedSongs') || new Set();
  el.innerHTML = list.map((s, i) => {
    const checked = selected.has(i) ? 'checked' : '';
    return `
    <div class="song-row" ondblclick="playSong(${i})">
      <input type="checkbox" class="song-checkbox" data-idx="${i}" ${checked}
        onchange="toggleSongSelect(${i}, this.checked)">
      ${s.cover
        ? `<img class="song-cover" src="${escAttr(s.cover)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="song-cover-ph" ${s.cover ? 'style="display:none"' : ''}>🎵</div>
      <div class="song-info">
        <div class="song-title">${esc(s.title)}</div>
        <div class="song-meta">${esc(s.artist)}${s.album ? ' · ' + (s.albumMid
          ? `<span class="album-link" onclick="openAlbumView('${escQ(s.albumMid)}','${escQ(s.source)}','${escQ(s.album)}')">${esc(s.album)}</span>`
          : esc(s.album)) : ''}</div>
      </div>
      <span class="song-duration">${fmtDuration(s.duration)}</span>
      <span class="source-badge badge-${s.source}">${srcLabel(s.source)}</span>
      <div class="song-actions">
        <button class="action-btn" title="试听" onclick="playSong(${i})">▶</button>
        <button class="action-btn download-btn" title="下载" onclick="addDownload(${i})">⬇</button>
      </div>
    </div>
  `}).join('');
}

function renderPagination(page, count) {
  const pg = document.getElementById('pagination');
  if (count < 10) { pg.style.display = 'none'; return; }
  const hasMore = count >= 20;
  pg.style.display = 'flex';
  pg.innerHTML = `
    <button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="doSearch(${page - 1})">上一页</button>
    <button class="page-btn active">第 ${page} 页</button>
    <button class="page-btn" ${!hasMore ? 'disabled' : ''} onclick="doSearch(${page + 1})">下一页</button>
  `;
}

// ── 批量选择 ─────────────────────────────────────────
function toggleSongSelect(idx, checked) {
  const selected = getState('selectedSongs') || new Set();
  if (checked) selected.add(idx);
  else selected.delete(idx);
  setState('selectedSongs', selected);
  updateBatchInfo();
}

function toggleSelectAllSongs(checked) {
  const songs = getState('songs');
  const selected = new Set();
  if (checked) { for (let i = 0; i < songs.length; i++) selected.add(i); }
  setState('selectedSongs', selected);
  document.querySelectorAll('.song-checkbox').forEach(cb => { cb.checked = checked; });
  updateBatchInfo();
}

function updateBatchInfo() {
  const selected = getState('selectedSongs') || new Set();
  document.getElementById('batchInfo').textContent = `已选 ${selected.size} 首`;
  const allCheck = document.getElementById('selectAllSongs');
  if (allCheck) {
    const songs = getState('songs');
    allCheck.checked = songs.length > 0 && selected.size === songs.length;
  }
}

// ── 批量操作 ─────────────────────────────────────────
async function batchDownload() {
  const selected = getState('selectedSongs') || new Set();
  const songs = getState('songs');
  if (!selected.size) { showToast('请先勾选要下载的歌曲', 'warn'); return; }

  const toAdd = Array.from(selected).map(i => songs[i]).filter(Boolean);
  const quality = document.getElementById('qualitySelect').value;
  const saveDir = getState('saveDir');
  let queued = 0, skipped = 0, dlSkipped = 0;
  const total = toAdd.length;

  // 显示进度条
  const progressWrap = document.getElementById('batchProgressWrap');
  const progressFill = document.getElementById('batchProgressFill');
  const progressText = document.getElementById('batchProgressText');
  const progressLabel = document.getElementById('batchProgressLabel');
  if (progressWrap) {
    progressWrap.style.display = 'flex';
    if (progressLabel) progressLabel.textContent = '正在加入下载队列...';
  }

  for (let i = 0; i < toAdd.length; i++) {
    const s = toAdd[i];
    const existing = (state.get('queueSnapshot') || []).find(q =>
      q.id === s.id && q.source === s.source && q.status !== 'done');
    if (existing) { skipped++; } else {
      try {
        // 批量场景：历史已下载且文件还在 → 主进程静默跳过，这里只计数
        const r = await api.addToQueue({ ...s, saveDir, quality });
        if (r && r.queued) queued++;
        else if (r && r.alreadyDownloaded) dlSkipped++;
      } catch (e) { logger.warn('加入队列失败:', s.title, e.message); }
    }
    // 更新进度
    const pct = Math.round(((i + 1) / total) * 100);
    if (progressFill) progressFill.style.width = pct + '%';
    if (progressText) progressText.textContent = `${i + 1}/${total}`;
  }

  // 完成后隐藏进度条
  if (progressWrap) {
    if (progressLabel) progressLabel.textContent = `完成！已加入 ${queued} 首`;
    setTimeout(() => { progressWrap.style.display = 'none'; }, 1500);
  }

  showToast(`已加入 ${queued} 首${skipped ? `（跳过 ${skipped} 首已在队列）` : ''}${dlSkipped ? `（跳过 ${dlSkipped} 首已下载过）` : ''}`, 'success');
  // 批量下载后退出选择模式
  exitSearchBatchMode();
}

function batchPlay() {
  const selected = getState('selectedSongs') || new Set();
  const songs = getState('songs');
  if (!selected.size) { showToast('请先勾选要播放的歌曲', 'warn'); return; }

  const indices = Array.from(selected).sort((a, b) => a - b);
  const playList = indices.map(i => songs[i]).filter(Boolean);
  if (!playList.length) return;

  setState('playQueue', playList);
  setState('playIdx', 0);
  playSong(0);
  showToast(`▶ 将播放 ${playList.length} 首歌曲`, 'info', 2000);
}

// ── 单曲下载 ─────────────────────────────────────────
async function addDownload(idx) {
  try {
    const songs = getState('songs');
    const s = songs[idx];
    if (!s) return;
    const existing = (state.get('queueSnapshot') || []).find(q =>
      q.id === s.id && q.source === s.source && q.status !== 'done');
    if (existing) { showToast(`「${s.title}」已在队列中`, 'warn', 2500); return; }
    const quality = document.getElementById('qualitySelect').value;
    const saveDir = getState('saveDir');
    const r = await api.addToQueue({ ...s, saveDir, quality });
    if (r && r.duplicated) { showToast(`「${s.title}」已在下载队列中`, 'warn', 2500); return; }
    if (r && r.alreadyDownloaded) {
      showRedownloadToast(s.title, r.finishedAt, () => {
        api.addToQueue({ ...s, saveDir, quality, forceRedownload: true })
          .then(() => showToast(`「${s.title}」已加入下载队列`, 'success'))
          .catch(e => showToast('加入失败: ' + e.message, 'error'));
      });
      return;
    }
    showToast(`「${s.title}」已加入下载队列`, 'success');
  } catch (e) {
    logger.warn(`[addDownload] error:`, e);
  }
}

// ── 播放 ─────────────────────────────────────────────
// 取流用智能接口（本源失败自动换源）；请求序号做竞态守卫，快速连点只认最后一次
let _searchPlayRequestId = 0;

async function playSong(idx) {
  const songs = getState('songs');
  const s = songs[idx];
  if (!s) { showToast('未找到歌曲', 'warn'); return; }
  const quality = document.getElementById('qualitySelect')?.value || 'standard';
  showToast(`正在准备音源：${s.title}`, 'info');
  const reqId = ++_searchPlayRequestId;
  try {
    const result = await api.getDownloadUrlSmart(s, quality);
    if (reqId !== _searchPlayRequestId) return; // 已点别的歌，丢弃过期结果
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
      s._altSource = { source: result.matchedSong.source, id: String(result.matchedSong.id) };
    }
    const playSource = result.matchedSong?.source || s.source;
    const referer = playSource === 'bilibili' ? 'https://www.bilibili.com/'
                  : playSource === 'qq' ? 'https://y.qq.com/'
                  : playSource === 'netease' ? 'https://music.163.com/' : '';
    const proxied = await api.proxyPlay(result.url, referer);
    if (reqId !== _searchPlayRequestId) return;
    if (!proxied || !proxied.fileUrl) {
      showToast('⚠️ 音源获取失败', 'error', 5000);
      return;
    }
    // 设置整个搜索结果为播放队列（不回写 songs：取流期间用户可能已切源重搜，
    // 回写会把过期列表污染新结果）
    setState('playQueue', songs);
    setState('playIdx', idx);
    // 与 player.js playSongByIdx 一致：currentPlaying 驱动托盘/迷你播放器/播放器卡片，
    // 也是 audio error 守卫与 25s 加载超时守卫的前置条件，缺失会导致取流失败后静默卡死
    setState('currentPlaying', s);
    await loadAndPlay(s, proxied.fileUrl, true);
    showToast('▶ 正在播放：' + s.title, 'success', 2500);
  } catch (e) {
    if (reqId === _searchPlayRequestId) {
      logger.warn('播放失败:', e);
      showToast('⚠️ 播放失败：' + (e.message || e), 'error', 4000);
    }
  }
}

// ── 来源切换 ─────────────────────────────────────────
function switchSource(src, btn) {
  setState('currentSource', src);
  // btn 缺省时按 data-source 找对应 tab，保证程序化调用（无事件对象）也能切换高亮
  const tab = btn || document.querySelector(`.search-source-tabs .tab[data-src="${src}"]`);
  document.querySelectorAll('.search-source-tabs .tab').forEach(t => t.classList.remove('active'));
  if (tab) tab.classList.add('active');
  if (getState('currentKeyword')) doSearch(1);
}

// ── 工具 ─────────────────────────────────────────────
// esc(), escQ(), srcLabel(), fmtDuration() 已由 utils.js 全局导出，此处不再重复定义

// ── 导出 ─────────────────────────────────────────────
window.doSearch = doSearch;
window.handleLinkInput = handleLinkInput;
window.openAlbumSongsModal = openAlbumSongsModal;
window.switchSearchType = switchSearchType;
window.renderSongList = renderSongList;
window.renderAlbumList = renderAlbumList;
// ── ES Module 导出 ──────────────────────────────────────
export {
  renderPagination,
  switchSource,
  addDownload,
  showSearchHistory,
  hideSearchHistory,
  clearSearchHistory,
  removeSearchHistory,
  toggleSongSelect,
  toggleSelectAllSongs,
  batchDownload,
  batchPlay,
  openAlbumDetail,
  downloadAlbum,
  playSong,
  openSingerDetail,
  switchSingerTab,
  backToSearch,
  debounceSearch,
  selectSuggestion,
  searchCleanup,
  enterSearchBatchMode,
  exitSearchBatchMode,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.renderPagination = renderPagination;
window.switchSource = switchSource;
window.addDownload = addDownload;
window.showSearchHistory = showSearchHistory;
window.hideSearchHistory = hideSearchHistory;
window.clearSearchHistory = clearSearchHistory;
window.removeSearchHistory = removeSearchHistory;
window.toggleSongSelect = toggleSongSelect;
window.toggleSelectAllSongs = toggleSelectAllSongs;
window.batchDownload = batchDownload;
window.batchPlay = batchPlay;
window.openAlbumDetail = openAlbumDetail;
window.downloadAlbum = downloadAlbum;
window.playSong = playSong;
window.openSingerDetail = openSingerDetail;
window.switchSingerTab = switchSingerTab;
window.backToSearch = backToSearch;
window.debounceSearch = debounceSearch;
window.selectSuggestion = selectSuggestion;
window.searchCleanup = searchCleanup;
window.enterSearchBatchMode = enterSearchBatchMode;
window.exitSearchBatchMode = exitSearchBatchMode;

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheDom();
