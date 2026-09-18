/**
 * MusicDL 首页
 *
 * 架构（重构后）：
 *   1. 分区注册表 HOME_PLATFORMS 是唯一数据源，驱动 DOM 生成、锚点导航、懒加载
 *   2. 三平台纵向堆叠成「聚合长页」——打开首页即能看到各平台内容，
 *      不再靠 tab 互斥切换；顶部锚点条平滑滚动定位
 *   3. 平台块进入视口才加载（IntersectionObserver），每块独立成功/失败/重试
 *   4. 单一状态源 homeState：window / global state 共享同一对象引用，
 *      永不整体替换（旧实现有模块变量 + state + window 三份副本，会漂移）
 *
 * 对外契约（不得改动）：
 *   window.loadHomeRecommendations()  —— app.js init / router 调用，幂等
 *   window.loadHomeStats()            —— app.js init 调用
 *   window.renderRecentlyPlayed()     —— app.js init / router 调用
 */

import { logger } from '../logger.js';

// ── 分区注册表 ────────────────────────────────────────────
// 新增一个区块 = 这里加一行；DOM、锚点、懒加载、状态统计自动跟上
//
// 平台显示名不在此定义 —— 统一走 utils.js 的 platformName(p.plat)（单一来源）。
// 原先这里带 label + i18n 键（home.neteaseTab / home.qqTab / home.biliTab），
// 是平台名的第二份拷贝，且命名与 search.<id> 不统一，已移除。
const HOME_PLATFORMS = [
  {
    plat: 'netease', dot: 'wy',
    sections: [
      { sec: 'netease.tops',      title: '飙升榜',   i18n: 'home.subtab.tops',      kind: 'list' },
      { sec: 'netease.hot',       title: '热歌榜',   i18n: 'home.subtab.hot',       kind: 'list' },
      { sec: 'netease.new',       title: '新歌榜',   i18n: 'home.subtab.new',       kind: 'list' },
      { sec: 'netease.original',  title: '原创榜',   i18n: 'home.subtab.original',  kind: 'list' },
      { sec: 'netease.playlists', title: '推荐歌单', i18n: 'home.subtab.playlists', kind: 'grid' },
    ],
  },
  {
    plat: 'qq', dot: 'qq',
    sections: [
      { sec: 'qq.recommend', title: '个性化推荐', kind: 'grid' },
      { sec: 'qq.official',  title: '官方歌单',   kind: 'grid' },
      { sec: 'qq.classic',   title: '经典歌单',   kind: 'grid' },
      { sec: 'qq.love',      title: '情歌歌单',   kind: 'grid' },
      { sec: 'qq.ktv',       title: 'KTV热歌',    kind: 'grid' },
      { sec: 'qq.top',       title: '热歌榜',     kind: 'list' },
      { sec: 'qq.new',       title: '内地新歌',   kind: 'list' },
      { sec: 'qq.radio',     title: '热门电台',   kind: 'grid' },
      { sec: 'qq.singers',   title: '热门歌手',   kind: 'grid' },
    ],
  },
  {
    plat: 'bilibili', dot: 'bi',
    sections: [
      { sec: 'bilibili.ranking', title: '音乐区热门排行', kind: 'list', showSource: true },
    ],
  },
];

/** 榜单默认只渲染前 N 行，超出给「展开全部」 */
const LIST_FOLD = 20;
/** 单分区请求超时（毫秒） */
const SECTION_TIMEOUT = 10000;

const HERO_TAGS = [
  { text: '周杰伦', hot: true },
  { text: '林俊杰', hot: true },
  { text: '五月天', hot: true },
  { text: 'Taylor Swift', hot: true },
  { text: '轻音乐' },
  { text: '钢琴曲' },
  { text: 'LoFi Hip Hop' },
  { text: 'OST 原声带' },
  { text: '粤语经典' },
  { text: '日语动漫' },
];

// ── 单一状态源 ────────────────────────────────────────────
// plat[plat] = { status, sections: { sec: data[] }, ok, fail }
const homeState = { plat: {}, _booted: false };
try { setState('homeRecommendations', homeState); } catch (_e) { /* ignore */ }
window.homeRecommendations = homeState;

let _shellRendered = false;
let _observer = null;
/** 已展开的榜单 sec 集合（切分区后保持展开状态） */
const _expanded = new Set();

// ── 小工具 ────────────────────────────────────────────────
function _getApi() { return window.api || (typeof api !== 'undefined' ? api : null); }

/** 取 i18n 词条，缺失时回落中文（英文模式下不再丢词条） */
function _tr(key, fallback) {
  if (!key) return fallback;
  try {
    const v = typeof window.t === 'function' ? window.t(key) : '';
    return v && v !== key ? v : fallback;
  } catch (_e) { return fallback; }
}

/** 区块 DOM id：netease.tops → sec-netease-tops（点号不能进 CSS 选择器） */
function _domId(sec) { return 'sec-' + sec.replace(/\./g, '-'); }
function _platOf(sec) { return sec.split('.')[0]; }
function _blockId(plat) { return 'blk-' + plat; }
function _findMeta(sec) {
  for (const p of HOME_PLATFORMS) {
    const s = p.sections.find(x => x.sec === sec);
    if (s) return s;
  }
  return null;
}
function _getSection(sec) {
  const st = homeState.plat[_platOf(sec)];
  return (st && st.sections[sec]) || [];
}

/**
 * 取（或建）平台状态槽。
 * 每次重新从 homeState 读取，避免 reloadPlatform 换掉状态对象后，
 * 尚在飞行中的 fetchSection 把计数写进已废弃的旧对象。
 */
function _platState(plat) {
  const cur = homeState.plat[plat];
  if (cur) return cur;
  const fresh = { status: 'idle', sections: {}, ok: 0, fail: 0 };
  homeState.plat[plat] = fresh;
  return fresh;
}

/** 骨架屏由 JS 生成，避免在 HTML 里重复几十段同样标记 */
function _skeletonHtml(kind) {
  if (kind === 'grid') return '<div class="skel-card"></div>'.repeat(6);
  return ('<div class="skel-row"><div class="skel-avatar"></div>'
    + '<div class="skel-lines"><div class="skel-line w60"></div>'
    + '<div class="skel-line w40"></div></div></div>').repeat(5);
}

// ── 骨架构建 ──────────────────────────────────────────────
function renderHeroTags() {
  const el = document.getElementById('homeHeroTags');
  if (!el) return;
  el.innerHTML = HERO_TAGS.map(g =>
    `<span class="hot-tag${g.hot ? ' trending' : ''}" onclick="quickSearch('${escAttr(g.text)}')">${esc(g.text)}</span>`
  ).join('');
}

function renderHomeShell() {
  const wrap = document.getElementById('homeBlocks');
  if (!wrap) return;

  wrap.innerHTML = HOME_PLATFORMS.map(p => {
    const label = platformName(p.plat);
    return `
    <section class="plat-block" id="${_blockId(p.plat)}" data-plat="${p.plat}">
      <div class="plat-block-head">
        <span class="plat-dot ${p.dot}"></span>
        <span class="plat-block-name">${esc(label)}</span>
        <span class="plat-block-state" data-state>待加载</span>
      </div>
      <div class="plat-chips">
        ${p.sections.map((s, i) => `<button class="plat-chip${i === 0 ? ' active' : ''}" data-sec="${escAttr(s.sec)}" onclick="showHomeSection('${escAttr(p.plat)}','${escAttr(s.sec)}',this)">${esc(_tr(s.i18n, s.title))}</button>`).join('')}
      </div>
      ${p.sections.map((s, i) => `<div class="home-sec home-sec--${s.kind}" id="${_domId(s.sec)}" data-sec="${escAttr(s.sec)}"${i === 0 ? '' : ' hidden'}>${_skeletonHtml(s.kind)}</div>`).join('')}
    </section>`;
  }).join('');

  const anchors = document.getElementById('homeAnchors');
  if (anchors) {
    anchors.innerHTML = HOME_PLATFORMS.map(p =>
      `<button class="anchor-chip" data-anchor="${_blockId(p.plat)}" onclick="scrollToHomeBlock('${_blockId(p.plat)}',this)"><span class="plat-dot ${p.dot}"></span>${esc(platformName(p.plat))}</button>`
    ).join('');
  }

  _shellRendered = true;
}

// ── 锚点导航 / 分区切换 ───────────────────────────────────
function scrollToHomeBlock(blockId, btn) {
  const el = document.getElementById(blockId);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  _setActiveAnchor(blockId);
  if (btn) btn.blur();
}

function _setActiveAnchor(blockId) {
  const bar = document.getElementById('homeAnchors');
  if (!bar) return;
  bar.querySelectorAll('.anchor-chip').forEach(c =>
    c.classList.toggle('active', c.dataset.anchor === blockId));
}

/** 手动滚动时同步锚点高亮（否则高亮会一直停在最后点击的那个平台） */
function _syncActiveAnchor() {
  const root = document.getElementById('homePage');
  if (!root) return;
  const threshold = root.getBoundingClientRect().top + 64;
  let current = _blockId(HOME_PLATFORMS[0].plat);
  for (const p of HOME_PLATFORMS) {
    const el = document.getElementById(_blockId(p.plat));
    if (el && el.getBoundingClientRect().top <= threshold) current = _blockId(p.plat);
  }
  _setActiveAnchor(current);
}

function _bindAnchorSpy() {
  const root = document.getElementById('homePage');
  if (!root) return;
  let raf = 0;
  root.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; _syncActiveAnchor(); });
  }, { passive: true });
  _syncActiveAnchor();
}

/** 平台内切换分区：显式比对 data-sec，不再用 id.includes(type) 的子串匹配 */
function showHomeSection(plat, sec, btn) {
  const block = document.getElementById(_blockId(plat));
  if (!block) return;
  block.querySelectorAll('.plat-chip').forEach(c => c.classList.toggle('active', c.dataset.sec === sec));
  block.querySelectorAll('.home-sec').forEach(el => { el.hidden = el.dataset.sec !== sec; });
  if (btn) btn.blur();
}

// ── 懒加载 ────────────────────────────────────────────────
function observeBlocks() {
  if (_observer) { _observer.disconnect(); _observer = null; }

  // 无 IntersectionObserver（老运行时）：降级为一次性全量加载
  if (typeof IntersectionObserver !== 'function') {
    HOME_PLATFORMS.forEach(p => loadPlatform(p.plat));
    return;
  }

  const root = document.getElementById('homePage');
  _observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      _observer.unobserve(en.target);
      loadPlatform(en.target.dataset.plat);
    }
  }, { root: root || null, rootMargin: '240px 0px' });

  document.querySelectorAll('.plat-block').forEach(el => _observer.observe(el));
}

// ── 平台状态徽标 ──────────────────────────────────────────
function _setBlockState(plat, text, onRetry) {
  const el = document.querySelector(`#${_blockId(plat)} [data-state]`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', typeof onRetry === 'function');
  el.onclick = typeof onRetry === 'function' ? onRetry : null;
}

function _refreshPlatformState(plat) {
  const def = HOME_PLATFORMS.find(p => p.plat === plat);
  const st = homeState.plat[plat];
  if (!def || !st) return;

  const total = def.sections.length;
  const settled = st.ok + st.fail;

  if (st.ok) {
    _setBlockState(plat, `${st.ok}/${total} 个分区`);
  } else if (settled >= total) {
    _setBlockState(plat, '加载失败，点击重试', () => reloadPlatform(plat));
  } else {
    _setBlockState(plat, `加载中 ${settled}/${total}`);
  }
}

// ── 数据加载 ──────────────────────────────────────────────
async function loadPlatform(plat) {
  const st = _platState(plat);
  if (st.status === 'loading' || st.status === 'done') return;

  const def = HOME_PLATFORMS.find(p => p.plat === plat);
  if (!def) return;

  st.status = 'loading';
  _refreshPlatformState(plat);

  await Promise.allSettled(def.sections.map(s => fetchSection(s)));

  st.status = st.ok ? 'done' : 'error';
  _refreshPlatformState(plat);
}

async function reloadPlatform(plat) {
  const def = HOME_PLATFORMS.find(p => p.plat === plat);
  if (!def) return;
  homeState.plat[plat] = { status: 'idle', sections: {}, ok: 0, fail: 0 };
  def.sections.forEach(s => {
    const el = document.getElementById(_domId(s.sec));
    if (el) el.innerHTML = _skeletonHtml(s.kind);
  });
  _refreshPlatformState(plat);
  await loadPlatform(plat);
}

async function fetchSection(meta) {
  const plat = _platOf(meta.sec);
  const st = _platState(plat);
  const el = document.getElementById(_domId(meta.sec));
  const _api = _getApi();

  if (!_api || typeof _api.getHomeSection !== 'function') {
    if (el) el.innerHTML = '<div class="home-sec-msg">接口未就绪</div>';
    st.fail++;
    _refreshPlatformState(plat);
    return false;
  }

  // 超时计时器必须在 finally 清掉，否则每次加载都会遗留一堆 10s 定时器
  let timer = null;
  try {
    const result = await Promise.race([
      _api.getHomeSection(meta.sec),
      new Promise((_res, rej) => {
        timer = setTimeout(() => rej(new Error('请求超时(10s)')), SECTION_TIMEOUT);
      }),
    ]);

    if (result && result.ok) {
      const data = Array.isArray(result.data) ? result.data : [];
      st.sections[meta.sec] = data;
      st.ok++;
      renderSection(meta, data);
      logger.log(`[Home] ✓ ${meta.sec} -> ${data.length} items`);
      _refreshPlatformState(plat);
      return true;
    }

    logger.warn(`[Home] ✗ ${meta.sec}:`, (result && result.error) || '加载失败');
    renderSectionError(meta, (result && result.error) || '加载失败');
    st.fail++;
    _refreshPlatformState(plat);
    return false;
  } catch (e) {
    logger.warn(`[Home] ✗ ${meta.sec} exception:`, e.message);
    renderSectionError(meta, e.message || String(e));
    st.fail++;
    _refreshPlatformState(plat);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 首页入口（app.js init / router switchTab('home') 调用）
 * 幂等：重复调用不重复加载。window._forceHomeRefresh = true 可强制重载全部平台。
 */
async function loadHomeRecommendations() {
  const force = !!window._forceHomeRefresh;
  window._forceHomeRefresh = false;

  if (!_shellRendered) {
    renderHeroTags();
    renderHomeShell();
    observeBlocks();
    _bindAnchorSpy();
  }

  if (homeState._booted && !force) return;
  homeState._booted = true;

  if (force) {
    HOME_PLATFORMS.forEach(p => reloadPlatform(p.plat));
  }
}

// ── 渲染 ──────────────────────────────────────────────────
function renderSection(meta, data) {
  const el = document.getElementById(_domId(meta.sec));
  if (!el) return;

  if (!Array.isArray(data) || !data.length) {
    el.innerHTML = '<div class="home-sec-msg">暂无数据</div>';
    return;
  }

  el.innerHTML = meta.kind === 'grid'
    ? data.map(playlistCardHtml).join('')
    : listHtml(meta, data);
}

function renderSectionError(meta, msg) {
  const el = document.getElementById(_domId(meta.sec));
  if (!el) return;
  el.innerHTML = `<div class="home-sec-msg is-error" onclick="reloadHomePlatform('${escAttr(_platOf(meta.sec))}')">⚠️ ${esc(msg)}，点击重试</div>`;
}

function playlistCardHtml(p) {
  return `
    <div class="playlist-card" onclick="openPlaylistModal('${escAttr(p.source)}', '${escAttr(p.id)}', '${escAttr(p.name)}')">
      <div class="playlist-cover-wrap">
        ${p.cover
          ? `<img class="playlist-cover" src="${escAttr(p.cover)}" alt="" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ''}
        <div class="playlist-cover-ph" ${p.cover ? 'style="display:none"' : ''}>📀</div>
        ${p.playCount ? `<span class="playlist-playcount">${formatPlayCount(p.playCount)}</span>` : ''}
        <div class="playlist-hover-play">▶ 浏览歌单</div>
      </div>
      <div class="playlist-name" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="playlist-source">${esc(srcLabel(p.source))}</div>
    </div>`;
}

function listHtml(meta, songs) {
  const expanded = _expanded.has(meta.sec);
  const fold = songs.length > LIST_FOLD && !expanded;
  const shown = fold ? songs.slice(0, LIST_FOLD) : songs;

  const foldBtn = songs.length > LIST_FOLD
    ? `<div class="list-fold-btn" onclick="toggleHomeListFold('${escAttr(meta.sec)}')">${expanded ? '收起 ▴' : `展开全部 ${songs.length} 首 ▾`}</div>`
    : '';

  return songRowsHtml(meta, shown) + foldBtn;
}

function songRowsHtml(meta, songs) {
  return songs.map((s, i) => `
    <div class="top-song-row" onclick="playRecommendById('${escAttr(meta.sec)}',${i})">
      <span class="top-song-rank ${i < 3 ? 'top3' : ''}">${i + 1}</span>
      <div class="top-song-info">
        <div class="top-song-title">${esc(s.title)}</div>
        <div class="top-song-artist">${esc(s.artist)}${s.album ? ' · ' + (s.albumMid
          ? `<span class="album-link" onclick="event.stopPropagation();openAlbumView('${escAttr(s.albumMid)}','${escAttr(s.source)}','${escAttr(s.album)}')">${esc(s.album)}</span>`
          : esc(s.album)) : ''}</div>
      </div>
      ${meta.showSource ? `<span class="source-badge badge-${escAttr(s.source)}">${esc(srcLabel(s.source))}</span>` : ''}
      <button class="top-song-action" title="播放" onclick="event.stopPropagation();playRecommendById('${escAttr(meta.sec)}',${i})">▶</button>
      <button class="top-song-action" title="下载" onclick="event.stopPropagation();addRecommendDownload('${escAttr(meta.sec)}',${i})">⬇</button>
      <button class="top-song-action" title="添加到歌单" onclick="event.stopPropagation();quickAddRecommendToPlaylist('${escAttr(meta.sec)}',${i})">📋</button>
    </div>
  `).join('');
}

/** 展开/收起榜单（用 homeState 里的全集重渲染，序号保持连续） */
function toggleHomeListFold(sec) {
  if (_expanded.has(sec)) _expanded.delete(sec);
  else _expanded.add(sec);
  const meta = _findMeta(sec);
  if (meta) renderSection(meta, _getSection(sec));
}

// ── 推荐歌曲交互 ──────────────────────────────────────────
async function playRecommendById(sec, idx) {
  try {
    const song = _getSection(sec)[idx];
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
    showToast('▶ 正在播放：' + song.title, 'success', 2500);
  } catch (e) {
    logger.warn('播放推荐歌曲失败:', e);
    showToast('⚠️ 播放失败：' + (e.message || e), 'error', 4000);
  }
}

async function addRecommendDownload(sec, idx) {
  const song = _getSection(sec)[idx];
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

async function quickAddRecommendToPlaylist(sec, idx) {
  try {
    const song = _getSection(sec)[idx];
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

// ── 搜索入口 ──────────────────────────────────────────────
function quickSearch(keyword) {
  const input = document.getElementById('searchInput');
  if (input) input.value = keyword;
  const searchNav = document.querySelector('.nav-item[data-tab="search"]');
  if (searchNav) switchTab('search', searchNav);
  doSearch(1);
}

/** 首页快捷搜索条：空关键词直接跳搜索页，不触发空检索 */
function homeHeroSearch(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) { quickSearch(''); return; }
  quickSearch(kw);
}

// ── 统计概览卡片 ──────────────────────────────────────────
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
      const totalSec = stats.status === 'fulfilled' && stats.value ? (stats.value.totalPlayTime || 0) : 0;
      elTime.textContent = totalSec >= 3600
        ? (totalSec / 3600).toFixed(1) + ' 小时'
        : Math.round(totalSec / 60) + ' 分钟';
    }

    const elMost = document.getElementById('statMostPlayed');
    if (elMost) {
      let most = null;
      const pv = stats.status === 'fulfilled' && stats.value ? stats.value : null;
      if (pv && pv.playCount) {
        const entries = Object.entries(pv.playCount).sort((a, b) => b[1] - a[1]);
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

// ── 最近播放 ──────────────────────────────────────────────
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
          ? `<img src="${escAttr(s.cover)}" alt="" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.parentElement.innerHTML='🎵'">`
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

// ── ES Module 导出 ────────────────────────────────────────
export {
  HOME_PLATFORMS,
  homeState,
  loadHomeRecommendations,
  reloadPlatform,
  renderSection,
  renderHomeShell,
  scrollToHomeBlock,
  showHomeSection,
  toggleHomeListFold,
  observeBlocks,
  playRecommendById,
  playRecommendSong,
  addRecommendDownload,
  quickAddRecommendToPlaylist,
  quickSearch,
  homeHeroSearch,
  loadHomeStats,
  playAllRecent,
  playRecentSong,
  renderRecentlyPlayed,
};

// ── 全局桥接（HTML onclick 兼容） ─────────────────────────
window.loadHomeRecommendations = loadHomeRecommendations;
window.reloadHomePlatform = reloadPlatform;
window.scrollToHomeBlock = scrollToHomeBlock;
window.showHomeSection = showHomeSection;
window.toggleHomeListFold = toggleHomeListFold;
window.playRecommendById = playRecommendById;
window.playRecommendSong = playRecommendSong;
window.addRecommendDownload = addRecommendDownload;
window.quickAddRecommendToPlaylist = quickAddRecommendToPlaylist;
window.quickSearch = quickSearch;
window.homeHeroSearch = homeHeroSearch;
window.loadHomeStats = loadHomeStats;
window.playAllRecent = playAllRecent;
window.playRecentSong = playRecentSong;
window.renderRecentlyPlayed = renderRecentlyPlayed;

// ── 兼容旧调用名（外部自动化/CDP 可能仍在用） ──────────────
window.switchPlatTab = (plat) => scrollToHomeBlock(_blockId(plat));
