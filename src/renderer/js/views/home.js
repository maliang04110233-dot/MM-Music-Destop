/**
 * MusicDL 首页推荐视图
 */

import { logger } from '../logger.js';

let homeRecommendations = {
  netease: { tops: [], hot: [], newSongs: [], original: [], playlists: [] },
  qq: { recommend: [], official: [], classic: [], love: [], ktv: [], topList: [], newSongs: [], radios: [], hotSingers: [] },
  bilibili: { ranking: [] },
  _loaded: false,
  _loading: false,
};
try { setState('homeRecommendations', homeRecommendations); } catch(_e) { /* ignore */ }

// home.js 不直接 import api，通过 window.api 访问（由 app.js 在 init 前赋值）
function _getApi() { return window.api || (typeof api !== 'undefined' ? api : null); }

// ── DOM 缓存 ──────────────────────────────────────────
const _homeDom = {};
const HOME_ELEMENT_IDS = [
  'allTopsList', 'allBiliList', 'allPlaylistsGrid',
  'neteaseTopsList', 'neteaseHotList', 'neteaseNewList', 'neteaseOriginalList', 'neteasePlaylistGrid',
  'qqRecommendGrid', 'qqOfficialGrid', 'qqClassicGrid', 'qqLoveGrid', 'qqKTVGrid',
  'qqTopList', 'qqNewSongsList', 'qqRadiosGrid', 'qqHotSingersGrid', 'biliRankingList',
];

function _cacheHomeDom() {
  HOME_ELEMENT_IDS.forEach(id => {
    _homeDom[id] = document.getElementById(id);
  });
}

async function loadHomeRecommendations() {
  const _api = _getApi();
  if (!_api || typeof _api.getHomeSection !== 'function') {
    logger.warn('[Home] API not ready, fallback to legacy');
    return loadHomeRecommendationsLegacy();
  }

  // 允许强制刷新（F5 / 点击重试）
  if (homeRecommendations && homeRecommendations._loaded && !window._forceHomeRefresh) {
    return;
  }
  if (window._forceHomeRefresh) window._forceHomeRefresh = false;

  // 初始化已在模块顶部完成，这里只检查 _loaded 标志

  // 只加载默认 Tab（网易云）— QQ/B站 由 switchPlatTab 按需加载
  const neteaseSections = [
    ['netease.tops',      (data) => { homeRecommendations.netease.tops = data; renderRecommendList('neteaseTopsList', data); }],
    ['netease.hot',       (data) => { homeRecommendations.netease.hot = data; renderRecommendList('neteaseHotList', data); }],
    ['netease.new',       (data) => { homeRecommendations.netease.newSongs = data; renderRecommendList('neteaseNewList', data); }],
    ['netease.original',  (data) => { homeRecommendations.netease.original = data; renderRecommendList('neteaseOriginalList', data); }],
    ['netease.playlists', (data) => { homeRecommendations.netease.playlists = data; renderRecommendGrid('neteasePlaylistGrid', data, '网易云'); }],
  ];

  await Promise.allSettled(neteaseSections.map(([section, render]) => loadHomeSection(section, render)));

  // 所有分区加载完毕，触发全量渲染确保所有 UI 同步
  renderAllPlatforms();

  // 标记加载完成
  homeRecommendations._loaded = true;
}

const _qqSections = [
  ['qq.recommend',      (data) => { homeRecommendations.qq.recommend = data; renderRecommendGrid('qqRecommendGrid', data, 'QQ音乐'); }],
  ['qq.official',       (data) => { homeRecommendations.qq.official = data; renderRecommendGrid('qqOfficialGrid', data, 'QQ官方'); }],
  ['qq.classic',        (data) => { homeRecommendations.qq.classic = data; renderRecommendGrid('qqClassicGrid', data, '经典'); }],
  ['qq.love',           (data) => { homeRecommendations.qq.love = data; renderRecommendGrid('qqLoveGrid', data, '情歌'); }],
  ['qq.ktv',            (data) => { homeRecommendations.qq.ktv = data; renderRecommendGrid('qqKTVGrid', data, 'KTV'); }],
  ['qq.top',            (data) => { homeRecommendations.qq.topList = data; renderRecommendList('qqTopList', data); }],
  ['qq.new',            (data) => { homeRecommendations.qq.newSongs = data; renderRecommendList('qqNewSongsList', data); }],
  ['qq.radio',          (data) => { homeRecommendations.qq.radios = data; renderRecommendGrid('qqRadiosGrid', data, '电台'); }],
  ['qq.singers',        (data) => { homeRecommendations.qq.hotSingers = data; renderRecommendGrid('qqHotSingersGrid', data, '歌手'); }],
];
const _biliSections = [
  ['bilibili.ranking',  (data) => { homeRecommendations.bilibili.ranking = data; renderRecommendList('biliRankingList', data, true); }],
];

let _qqLoaded = false;
let _biliLoaded = false;

async function ensureQQLoaded() {  try {
    
    if (_qqLoaded) return;
    _qqLoaded = true;
    await Promise.allSettled(_qqSections.map(([section, render]) => loadHomeSection(section, render)));
    
  } catch (e) {
    logger.warn(`[ensureQQLoaded] error:`, e);
  }
}

async function ensureBiliLoaded() {
  try {
    if (_biliLoaded) return;
    _biliLoaded = true;
    await Promise.allSettled(_biliSections.map(([section, render]) => loadHomeSection(section, render)));
  } catch (e) {
    logger.warn(`[ensureBiliLoaded] error:`, e);
  }
}

async function loadHomeSection(section, render) {
  const _api = _getApi();
  if (!_api) {
    logger.error('[Home] loadHomeSection failed: api is null for', section);
    markHomeSectionError(section, 'API 未就绪');
    return;
  }
  try {
    const result = await Promise.race([
      _api.getHomeSection(section),
      new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时(10s)')), 10000)),
    ]);
    if (result?.ok) {
      logger.log(`[Home] ✓ ${section} -> ${(result.data || []).length} items`);
      render(result.data || []);
    } else {
      logger.warn(`[Home] ✗ ${section}:`, result?.error || '加载失败');
      markHomeSectionError(section, result?.error || '加载失败');
    }
  } catch (e) {
    logger.warn(`[Home] ✗ ${section} exception:`, e.message);
    markHomeSectionError(section, e.message || String(e));
  }
}

async function loadHomeRecommendationsLegacy() {
  const _api = _getApi();
  try {
    if (!_api || typeof _api.getHomeRecommendations !== 'function') {
      throw new Error('window.musicAPI 未加载（preload 失败）');
    }
    if (homeRecommendations && homeRecommendations._loaded) {
      return;
    }
    const data = await Promise.race([
      _api.getHomeRecommendations(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时(30s)')), 30000)),
    ]);
    // 安全合并，保证 netease/qq/bilibili 子结构始终存在
    homeRecommendations = {
      netease: { ...homeRecommendations.netease, ...(data?.netease || {}) },
      qq: { ...homeRecommendations.qq, ...(data?.qq || {}) },
      bilibili: { ...homeRecommendations.bilibili, ...(data?.bilibili || {}) },
      _loaded: true,
    };
    setState('homeRecommendations', homeRecommendations);
    renderAllPlatforms();
  } catch (e) {
    logger.error('[Home] 加载推荐内容失败:', e);
    showToast('推荐加载失败: ' + e.message + ' (开发者工具 → Console)', 'error');
    clearLoadingPlaceholders();
  }
}

// ── 渲染 ──────────────────────────────────────────────
function renderRecommendList(elId, songs, showSource = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!Array.isArray(songs) || !songs.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:12px;">暂无数据</div>';
    return;
  }
  state.setRecommend(elId, songs);
  el.innerHTML = songs.map((s, i) => `
    <div class="top-song-row">
      <span class="top-song-rank ${i < 3 ? 'top3' : ''}">${i + 1}</span>
      <div class="top-song-info">
        <div class="top-song-title">${esc(s.title)}</div>
        <div class="top-song-artist">${esc(s.artist)}${s.album ? ' · ' + (s.albumMid
          ? `<span class="album-link" onclick="event.stopPropagation();openAlbumView('${escAttr(s.albumMid)}','${escAttr(s.source)}','${escAttr(s.album)}')">${esc(s.album)}</span>`
          : esc(s.album)) : ''}</div>
      </div>
      ${showSource ? `<span class="source-badge badge-${escAttr(s.source)}">${srcLabel(s.source)}</span>` : ''}
      <button class="top-song-action" title="播放" onclick="event.stopPropagation();playRecommendById('${elId}', ${i})">▶</button>
      <button class="top-song-action" title="下载" onclick="event.stopPropagation();addRecommendDownload('${elId}', ${i})">⬇</button>
      <button class="top-song-action" title="添加到歌单" onclick="event.stopPropagation();quickAddRecommendToPlaylist('${elId}', ${i})">📋</button>
    </div>
  `).join('');
}

function renderRecommendGrid(elId, playlists, sourceLabel) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!Array.isArray(playlists) || !playlists.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:12px;grid-column:1/-1;">暂无数据</div>';
    return;
  }
  el.innerHTML = playlists.map(p => `
    <div class="playlist-card" onclick="openPlaylistModal('${escAttr(p.source)}', '${escAttr(p.id)}', '${escAttr(p.name)}')">
      <div class="playlist-cover-wrap">
        ${p.cover
          ? `<img class="playlist-cover" src="${escAttr(p.cover)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ''}
        <div class="playlist-cover-ph" ${p.cover ? 'style="display:none"' : ''}>📀</div>
        ${p.playCount ? `<span class="playlist-playcount">${formatPlayCount(p.playCount)}</span>` : ''}
      </div>
      <div class="playlist-name" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="playlist-source">${sourceLabel}</div>
    </div>
  `).join('');
}

function renderAllPlatforms() {
  const r = homeRecommendations;
  if (!r) return;
  renderRecommendList('allTopsList', r.netease?.tops || []);
  renderRecommendList('allBiliList', r.bilibili?.ranking || [], true);
  renderRecommendGrid('allPlaylistsGrid', [
    ...(r.netease?.playlists || []).map(p => ({ ...p, sourceLabel: '网易云' })),
    ...(r.qq?.recommend || []).map(p => ({ ...p, sourceLabel: 'QQ音乐' })),
  ], '');
  renderRecommendList('neteaseTopsList', r.netease?.tops || []);
  renderRecommendList('neteaseHotList', r.netease?.hot || []);
  renderRecommendList('neteaseNewList', r.netease?.newSongs || []);
  renderRecommendList('neteaseOriginalList', r.netease?.original || []);
  renderRecommendGrid('neteasePlaylistGrid', r.netease?.playlists || [], '网易云');
  renderRecommendGrid('qqRecommendGrid',  r.qq?.recommend  || [], 'QQ音乐');
  renderRecommendGrid('qqOfficialGrid',   r.qq?.official   || [], 'QQ官方');
  renderRecommendGrid('qqClassicGrid',    r.qq?.classic    || [], '经典');
  renderRecommendGrid('qqLoveGrid',       r.qq?.love       || [], '情歌');
  renderRecommendGrid('qqKTVGrid',        r.qq?.ktv        || [], 'KTV');
  renderRecommendList('qqTopList',        r.qq?.topList    || []);
  renderRecommendList('qqNewSongsList',   r.qq?.newSongs   || []);
  renderRecommendGrid('qqRadiosGrid',     r.qq?.radios     || [], '电台');
  renderRecommendGrid('qqHotSingersGrid', r.qq?.hotSingers || [], '歌手');
  renderRecommendList('biliRankingList', r.bilibili?.ranking || [], true);
}

function updateAllPlaylistsGrid() {
  const r = homeRecommendations;
  if (!r) return;
  renderRecommendGrid('allPlaylistsGrid', [
    ...(r.netease?.playlists || []).map(p => ({ ...p, sourceLabel: '网易云' })),
    ...(r.qq?.recommend || []).map(p => ({ ...p, sourceLabel: 'QQ音乐' })),
  ], '');
}

function markHomeSectionError(section, msg) {
  const idMap = {
    'netease.tops': 'neteaseTopsList', 'netease.hot': 'neteaseHotList',
    'netease.new': 'neteaseNewList', 'netease.original': 'neteaseOriginalList',
    'netease.playlists': 'neteasePlaylistGrid',
    'qq.recommend': 'qqRecommendGrid', 'qq.official': 'qqOfficialGrid',
    'qq.classic': 'qqClassicGrid', 'qq.love': 'qqLoveGrid', 'qq.ktv': 'qqKTVGrid',
    'qq.top': 'qqTopList', 'qq.new': 'qqNewSongsList', 'qq.radio': 'qqRadiosGrid',
    'qq.singers': 'qqHotSingersGrid', 'bilibili.ranking': 'biliRankingList',
  };
  const id = idMap[section];
  const el = id && document.getElementById(id);
  if (el) {
    el.innerHTML = `<div class="rec-error" onclick="window._forceHomeRefresh=true;loadHomeRecommendations()" style="color:var(--text-muted);font-size:12px;padding:14px;text-align:center;cursor:pointer;border:1px dashed var(--border);border-radius:8px;">⚠️ ${esc(msg)}，点击重试</div>`;
  }
}

function clearLoadingPlaceholders() {
  const ids = ['allTopsList', 'allBiliList', 'allPlaylistsGrid',
    'neteaseTopsList', 'neteaseHotList', 'neteaseNewList', 'neteaseOriginalList', 'neteasePlaylistGrid',
    'qqRecommendGrid', 'qqOfficialGrid', 'qqClassicGrid', 'qqLoveGrid', 'qqKTVGrid',
    'qqTopList', 'qqNewSongsList', 'qqRadiosGrid', 'qqHotSingersGrid', 'biliRankingList'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && (el.querySelector('.loading') || el.querySelector('.skel-row') || el.querySelector('.skel-card'))) {
      el.innerHTML = `<div class="rec-error" onclick="window._forceHomeRefresh=true;loadHomeRecommendations()" style="color:var(--text-muted);font-size:12px;padding:14px;text-align:center;cursor:pointer;border:1px dashed var(--border);border-radius:8px;">⚠️ 加载失败，点击重试</div>`;
    }
  }
}

// ── 推荐歌曲交互 ──────────────────────────────────────
async function playRecommendById(elId, idx) {
  try {
    const song = state.getRecommend(elId, idx);
    if (song) await playRecommendSong(song);
  } catch (e) {
    logger.warn(`[playRecommendById] error:`, e);
  }
}

async function playRecommendSong(song) {
  if (!song) return;
  const quality = document.getElementById('qualitySelect')?.value || 'standard';
  showToast(`正在准备音源：${song.title}`, 'info');
  try {
    const result = await api.getDownloadUrlSmart(song, quality);
    if (!result || !result.url) {
      if (result && result.code === 'VIP_REQUIRED') {
        showToast('⚠️ 该歌曲为 VIP 专享，请在「设置」中填入已登录的 Cookie 后重试', 'warn', 5000);
      } else {
        showToast('⚠️ 暂无法获取音源，请稍后重试或下载后收听', 'warn', 5000);
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
    if (!proxied || !proxied.fileUrl) {
      showToast('⚠️ 音源下载失败：' + (proxied?.error || '未知错误'), 'error', 5000);
      return;
    }
    const songs = [song];
    setState('songs', songs);
    setState('playQueue', songs);
    setState('playIdx', 0);
    setState('currentPlaying', song);
    await loadAndPlay(song, proxied.fileUrl, true);
    // loadAndPlay 内部已调用 audio.play()，无需重复调用
    showToast('▶ 正在播放：' + song.title, 'success', 2500);
  } catch (e) {
    logger.warn('播放推荐歌曲失败:', e);
    showToast('⚠️ 播放失败：' + (e.message || e), 'error', 4000);
  }
}

async function addRecommendDownload(elId, idx) {
  const song = state.getRecommend(elId, idx);
  if (!song) return;
  const existing = (state.get('queueSnapshot') || []).find(q => q.id === song.id && q.source === song.source && q.status !== 'done');
  if (existing) {
    showToast(`「${song.title}」已在队列中`, 'warn', 2500);
    return;
  }
  try {
    const quality = document.getElementById('qualitySelect')?.value || 'standard';
    const saveDir = getState('saveDir');
    const r = await api.addToQueue({ ...song, saveDir, quality });
    if (r && r.duplicated) {
      showToast(`「${song.title}」已在下载队列中`, 'warn', 2500);
      return;
    }
    if (r && r.alreadyDownloaded) {
      showRedownloadToast(song.title, r.finishedAt, () => {
        api.addToQueue({ ...song, saveDir, quality, forceRedownload: true })
          .then(() => showToast(`「${song.title}」已加入下载队列`, 'success'))
          .catch(e => showToast('加入下载失败：' + (e.message || e), 'error', 4000));
      });
      return;
    }
    showToast(`「${song.title}」已加入下载队列`, 'success');
  } catch (e) {
    showToast('加入下载失败：' + (e.message || e), 'error', 4000);
  }
}

async function quickAddRecommendToPlaylist(elId, idx) {
  try {
    const song = state.getRecommend(elId, idx);
    if (!song) return;
    const playlists = getState('userPlaylists') || [];
    if (playlists.length === 0) {
      await loadUserPlaylists();
    }
    if (typeof quickAddToPlaylist === 'function') {
      quickAddToPlaylist(song);
    }
  } catch (e) {
    logger.warn(`[quickAddRecommendToPlaylist] error:`, e);
  }
}

// ── 首页 UI ───────────────────────────────────────────
function switchPlatTab(tab, btn) {
  document.querySelectorAll('.platform-tabs .plat-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  const panelMap = {
    netease: 'platNeteasePanel',
    qq: 'platQQPanel',
    bilibili: 'platBiliPanel',
  };
  const targetId = panelMap[tab];
  ['platNeteasePanel', 'platQQPanel', 'platBiliPanel'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const isActive = id === targetId;
    el.classList.toggle('hidden', !isActive);
    el.style.display = isActive ? 'flex' : 'none';
  });

  if (tab === 'qq') ensureQQLoaded();
  else if (tab === 'bilibili') ensureBiliLoaded();
  else if (tab === 'netease') {
    // 网易云默认已加载，确保数据已渲染
    if (homeRecommendations && homeRecommendations.netease?.tops?.length) {
      renderRecommendList('neteaseTopsList', homeRecommendations.netease.tops);
    }
  }
}

function switchNeteaseSub(type, btn) {
  document.querySelectorAll('#neteaseSubTabs .rec-subtab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const typeLower = type.toLowerCase();
  ['neteaseTopsPanel', 'neteaseHotPanel', 'neteaseNewPanel', 'neteaseOriginalPanel', 'neteasePlaylistPanel'].forEach(id => {
    document.getElementById(id).style.display = id.toLowerCase().includes(typeLower) ? 'block' : 'none';
  });
}

// QQ 面板子 tab：九个分区收纳为一行切换（原平铺 9 屏太长）
function switchQQSub(key, btn) {
  document.querySelectorAll('#qqSubTabs .rec-subtab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('#platQQPanel [id^="qqSec-"]').forEach(el => {
    el.style.display = el.id === 'qqSec-' + key ? 'block' : 'none';
  });
}

function quickSearch(keyword) {
  document.getElementById('searchInput').value = keyword;
  const searchNav = document.querySelector('.nav-item[data-tab="search"]');
  if (searchNav) switchTab('search', searchNav);
  doSearch(1);
}

// 首页快捷搜索条：空关键词直接跳搜索页，不触发空检索
function homeHeroSearch(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) { quickSearch(''); return; }
  quickSearch(kw);
}

// ── 统计概览卡片 ──────────────────────────────────────
// 本地曲库数 / 已下载数 / 累计收听时长 / 最常播放
async function loadHomeStats() {
  try {
    const _api = _getApi();
    if (!_api) return;
    // 并行拉三块数据，各自容错（缺哪块哪块留 —）
    const [lib, hist, stats] = await Promise.allSettled([
      _api.loadLibraryIndex ? _api.loadLibraryIndex() : Promise.resolve(null),
      _api.getHistoryStats ? _api.getHistoryStats() : Promise.resolve(null),
      Promise.resolve(typeof getPlayStats === 'function' ? getPlayStats() : null),
    ]);

    // loadLibraryIndex 返回 { songs, dirPath, lastScan }
    const libSongs = lib.status === 'fulfilled' && lib.value
      ? (Array.isArray(lib.value) ? lib.value : (lib.value.songs || []))
      : [];
    const elLib = document.getElementById('statLibCount');
    if (elLib) elLib.textContent = String(libSongs.length);

    const doneCount = hist.status === 'fulfilled' && hist.value ? hist.value.done : null;
    const elDone = document.getElementById('statDoneCount');
    if (elDone) elDone.textContent = doneCount == null ? '—' : String(doneCount);

    const elTime = document.getElementById('statPlayTime');
    if (elTime) {
      const totalSec = stats ? (stats.totalPlayTime || 0) : 0;
      elTime.textContent = totalSec >= 3600
        ? (totalSec / 3600).toFixed(1) + ' 小时'
        : Math.round(totalSec / 60) + ' 分钟';
    }

    const elMost = document.getElementById('statMostPlayed');
    if (elMost) {
      let most = null;
      if (stats && stats.playCount) {
        const entries = Object.entries(stats.playCount).sort((a, b) => b[1] - a[1]);
        if (entries.length) most = entries[0];
      }
      if (most) {
        const [title] = most[0].split('|||');
        elMost.textContent = title.slice(0, 12);
        elMost.title = `${title}（${most[1]} 次）`;
      } else {
        elMost.textContent = '—';
      }
    }
  } catch (e) {
    logger.warn('[loadHomeStats] error:', e);
  }
}

// ── 最近播放渲染 ──────────────────────────────────────
function renderRecentlyPlayed() {
  const section = document.getElementById('recentlyPlayedSection');
  const list = document.getElementById('recentlyPlayedList');
  if (!section || !list) return;

  const recent = typeof getRecentlyPlayed === 'function' ? getRecentlyPlayed() : [];
  if (!recent.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  // 标题行加「播放全部」：整单最近播放进队列从第一首播
  const titleEl = section.querySelector('.hot-section-title');
  if (titleEl && !titleEl.querySelector('.section-playall-btn')) {
    const btn = document.createElement('button');
    btn.className = 'section-playall-btn';
    btn.textContent = '▶ 播放全部';
    btn.onclick = () => playAllRecent();
    titleEl.appendChild(btn);
  }
  list.innerHTML = recent.slice(0, 10).map((s, i) => `
    <div class="recent-item" onclick="playRecentSong(${i})" title="${esc(s.title)} - ${esc(s.artist)}">
      <div class="recent-cover">
        ${s.cover
          ? `<img src="${escAttr(s.cover)}" alt="" onerror="this.parentElement.innerHTML='🎵'">`
          : '🎵'}
        <div class="recent-play-overlay">▶</div>
      </div>
      <div class="recent-info">
        <div class="recent-title">${esc(s.title)}</div>
        <div class="recent-artist">${esc(s.artist)}</div>
      </div>
      <span class="recent-time">${fmtHistoryTime(s.playedAt)}</span>
    </div>
  `).join('');
}

// fmtHistoryTime 已由 utils.js 全局导出

async function playRecentSong(idx) {
  try {
    const recent = typeof getRecentlyPlayed === 'function' ? getRecentlyPlayed() : [];
    const song = recent[idx];
    if (!song) return;
    // audio error / 25s 加载超时守卫依赖 currentPlaying 真值，缺失会静默卡死
    setState('currentPlaying', song);
    await loadAndPlay(song);
  } catch (e) {
    logger.warn(`[playRecentSong] error:`, e);
  }
}

// 最近播放整单入队（从第一首开始顺序播放）
async function playAllRecent() {
  try {
    const recent = typeof getRecentlyPlayed === 'function' ? getRecentlyPlayed() : [];
    if (!recent.length) return;
    const songs = [...recent].reverse().slice(0, 50); // 最近播放是新的在前，队列按旧→新排
    setState('songs', songs);
    setState('playQueue', songs);
    setState('playIdx', 0);
    setState('currentPlaying', songs[0]);
    await loadAndPlay(songs[0]);
    showToast(`▶ 正在播放最近播放（共 ${songs.length} 首）`, 'success', 2500);
  } catch (e) {
    logger.warn('[playAllRecent] error:', e);
    showToast('播放失败：' + (e.message || e), 'error', 3000);
  }
}

// ── ES Module 导出 ──────────────────────────────────────
export {
  homeRecommendations,
  loadHomeRecommendations,
  renderRecommendList,
  renderRecommendGrid,
  renderAllPlatforms,
  playRecommendById,
  playRecommendSong,
  addRecommendDownload,
  switchPlatTab,
  switchNeteaseSub,
  switchQQSub,
  quickSearch,
  homeHeroSearch,
  loadHomeStats,
  playAllRecent,
  markHomeSectionError,
  clearLoadingPlaceholders,
  updateAllPlaylistsGrid,
  renderRecentlyPlayed,
  playRecentSong,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.homeRecommendations = homeRecommendations;
window.loadHomeRecommendations = loadHomeRecommendations;
window.renderRecommendList = renderRecommendList;
window.renderRecommendGrid = renderRecommendGrid;
window.renderAllPlatforms = renderAllPlatforms;
window.playRecommendById = playRecommendById;
window.playRecommendSong = playRecommendSong;
window.addRecommendDownload = addRecommendDownload;
window.switchPlatTab = switchPlatTab;
window.switchNeteaseSub = switchNeteaseSub;
window.switchQQSub = switchQQSub;
window.quickSearch = quickSearch;
window.homeHeroSearch = homeHeroSearch;
window.loadHomeStats = loadHomeStats;
window.playAllRecent = playAllRecent;
window.markHomeSectionError = markHomeSectionError;
window.clearLoadingPlaceholders = clearLoadingPlaceholders;
window.updateAllPlaylistsGrid = updateAllPlaylistsGrid;
window.renderRecentlyPlayed = renderRecentlyPlayed;
window.playRecentSong = playRecentSong;
// 推荐卡片"📋 添加到歌单"按钮（模板 onclick）
window.quickAddRecommendToPlaylist = quickAddRecommendToPlaylist;

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheHomeDom();
