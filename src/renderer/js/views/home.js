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
import { heartBtnHtml } from '../favorites.js';
import { resolveQuality } from '../quality.js';

// ── 分区注册表 ────────────────────────────────────────────
// 新增一个区块 = 这里加一行；DOM、锚点、懒加载、状态统计自动跟上
//
// 平台显示名不在此定义 —— 统一走 utils.js 的 platformName(p.plat)（单一来源）。
// 原先这里带 label + i18n 键（home.neteaseTab / home.qqTab / home.biliTab），
// 是平台名的第二份拷贝，且命名与 search.<id> 不统一，已移除。
const HOME_PLATFORMS = [
  {
    plat: 'netease',
    sections: [
      { sec: 'netease.tops',      title: '飙升榜',   i18n: 'home.subtab.tops',      kind: 'list' },
      { sec: 'netease.hot',       title: '热歌榜',   i18n: 'home.subtab.hot',       kind: 'list' },
      { sec: 'netease.new',       title: '新歌榜',   i18n: 'home.subtab.new',       kind: 'list' },
      { sec: 'netease.original',  title: '原创榜',   i18n: 'home.subtab.original',  kind: 'list' },
      { sec: 'netease.playlists', title: '推荐歌单', i18n: 'home.subtab.playlists', kind: 'grid' },
    ],
  },
  {
    plat: 'qq',
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
    plat: 'bilibili',
    sections: [
      { sec: 'bilibili.ranking', title: '音乐区热门排行', kind: 'list', showSource: true },
    ],
  },
  {
    // 酷狗（2026-09-18 补齐推荐域能力后加入）。
    // 榜单口径与 netease 对齐（飙升/热歌/短视频/TOP500），便于横向比较。
    // 注：酷狗的「网络热歌榜」「短视频热歌榜」与 netease「热歌榜」内容不同源，
    //     标题保留平台原榜名，不强行统一成「热歌榜」，避免误导。
    plat: 'kugou',
    sections: [
      { sec: 'kugou.tops',      title: '飙升榜',      kind: 'list' },
      { sec: 'kugou.hot',       title: '网络热歌榜',  kind: 'list' },
      { sec: 'kugou.short',     title: '短视频热歌榜', kind: 'list' },
      { sec: 'kugou.top500',    title: 'TOP500',      kind: 'list' },
      { sec: 'kugou.playlists', title: '推荐歌单',    kind: 'grid' },
    ],
  },
];

/**
 * 榜单默认只渲染前 N 行，超出走「查看完整榜单」弹窗。
 *
 * 从 20 降到 8 的依据（实测，非审美偏好）：
 *   改版前 netease 块高 1156px，其中 980px 是单一分区的前 20 行 ——
 *   整页滚动比 2.23（内容 3140px / 视口 1408px），第二个平台被推到
 *   1600px 以下，「打开首页就看到各平台内容」的设计意图没有兑现。
 *   收到 8 行后单块约 350px，三个平台可同屏出现。
 *   完整榜单不再原地展开，而是弹窗查看 —— 首页负责「发现」，
 *   完整列表不是首页该承担的信息量。
 */
const LIST_FOLD = 8;
/** 横向卡片流里歌单卡的列数上限（超过则靠横向滚动，不再挤压缩小） */
const GRID_LIMIT = 12;
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
/** 完整榜单弹窗的 Esc 监听器（关闭时必须移除，否则重复打开会累积） */
let _chartEscHandler = null;

// ── 小工具 ────────────────────────────────────────────────
function _getApi() { return window.api || (typeof api !== 'undefined' ? api : null); }

/**
 * 取 i18n 词条，缺失时回落中文（英文模式下不再丢词条）。
 *
 * params 用于 `{n}` 这类占位符插值（i18n.t 原生支持）。**回落串也要插值** ——
 * 否则语言包一旦缺词条，界面上会原样显示出 "{n}"，比没有翻译更糟。
 */
function _tr(key, fallback, params) {
  const fill = (s) => {
    if (!params) return s;
    return Object.keys(params).reduce(
      (acc, k) => acc.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]), s);
  };
  if (!key) return fill(fallback);
  try {
    const v = typeof window.t === 'function' ? window.t(key, params) : '';
    return v && v !== key ? v : fill(fallback);
  } catch (_e) { return fill(fallback); }
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

/**
 * 骨架屏由 JS 生成，避免在 HTML 里重复几十段同样标记。
 *
 * 行数取 LIST_FOLD（而非写死的 5）：骨架的作用是**占位** ——
 * 它和真实内容的高度差会表现为「数据到位的瞬间页面跳一下」。
 * 榜单折叠到 8 行后，这里也同步成 8 行，跳变才真正消失。
 * 封面尺寸同理，必须与 .top-song-cover 的 36px 一致。
 */
function _skeletonHtml(kind) {
  if (kind === 'grid') return '<div class="skel-card"></div>'.repeat(6);
  const row = '<div class="skel-row"><div class="skel-avatar"></div>'
    + '<div class="skel-lines"><div class="skel-line w60"></div>'
    + '<div class="skel-line w40"></div></div></div>';
  return row.repeat(LIST_FOLD);
}

// ── 骨架构建 ──────────────────────────────────────────────
function renderHeroTags() {
  const el = document.getElementById('homeHeroTags');
  if (!el) return;
  el.innerHTML = HERO_TAGS.map(g =>
    `<span class="hot-tag${g.hot ? ' trending' : ''}" onclick="quickSearch('${escQ(g.text)}')">${esc(g.text)}</span>`
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
        <span class="plat-dot" data-plat="${escAttr(p.plat)}"></span>
        <span class="plat-block-name">${esc(label)}</span>
        <span class="plat-block-state" data-state>待加载</span>
        <span class="plat-block-spacer"></span>
        <div class="plat-chips plat-chips--rail" role="tablist">
          ${p.sections.map((s, i) => `<button class="plat-chip${i === 0 ? ' active' : ''}" role="tab" aria-selected="${i === 0}" data-sec="${escAttr(s.sec)}" onclick="showHomeSection('${escQ(p.plat)}','${escQ(s.sec)}',this)">${esc(_tr(s.i18n, s.title))}</button>`).join('')}
        </div>
      </div>
      ${p.sections.map((s, i) => `<div class="home-sec home-sec--${s.kind}" id="${_domId(s.sec)}" data-sec="${escAttr(s.sec)}"${i === 0 ? '' : ' hidden'}>${_skeletonHtml(s.kind)}</div>`).join('')}
    </section>`;
  }).join('');

  const anchors = document.getElementById('homeAnchors');
  if (anchors) {
    anchors.innerHTML = HOME_PLATFORMS.map(p =>
      `<button class="anchor-chip" data-anchor="${_blockId(p.plat)}" onclick="scrollToHomeBlock('${_blockId(p.plat)}',this)"><span class="plat-dot" data-plat="${escAttr(p.plat)}"></span>${esc(platformName(p.plat))}</button>`
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
/**
 * 渲染一个分区的内容。
 *
 * grid 分区按 GRID_LIMIT 截断：网易云推荐歌单上游会给到 30+ 条，全渲染后
 * 网格要占 3 行以上（6 列 × 110px 卡），单块高度又会失控 —— 那正是这次
 * 改版要解决的问题。首页承担「发现」，超出部分交给「查看完整歌单」。
 */
function renderSection(meta, data) {
  const el = document.getElementById(_domId(meta.sec));
  if (!el) return;

  if (!Array.isArray(data) || !data.length) {
    el.innerHTML = '<div class="home-sec-msg">暂无数据</div>';
    return;
  }

  el.innerHTML = meta.kind === 'grid'
    ? data.slice(0, GRID_LIMIT).map(playlistCardHtml).join('')
    : listHtml(meta, data);
}

function renderSectionError(meta, msg) {
  const el = document.getElementById(_domId(meta.sec));
  if (!el) return;
  el.innerHTML = `<div class="home-sec-msg is-error" onclick="reloadHomePlatform('${escQ(_platOf(meta.sec))}')">⚠️ ${esc(msg)}，点击重试</div>`;
}

/**
 * 歌单卡。
 *
 * 无封面占位从 emoji 📀 换成内联 SVG（与榜单行同源 noCoverSvgHtml）：
 * 无 emoji 字体时 📀 会退化成一颗褐色实心圆，观感等同「图片加载失败」。
 *
 * 占位 SVG **常驻 DOM**、垫在 <img> 下层（.playlist-cover 是 absolute inset:0）：
 * 图片加载成功后自然把它盖住，因此不再需要原来那套
 * `onerror` 里操作 nextElementSibling.style.display 的隐式配对 ——
 * 那种写法一旦有人往中间插一个元素就会静默错位。
 */
function playlistCardHtml(p) {
  return `
    <div class="playlist-card" onclick="openPlaylistModal('${escQ(p.source)}', '${escQ(p.id)}', '${escQ(p.name)}')">
      <div class="playlist-cover-wrap">
        ${p.cover
          ? `<img class="playlist-cover" src="${escAttr(p.cover)}" alt="" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.remove()">`
          : ''}
        <div class="playlist-cover-ph">${noCoverSvgHtml()}</div>
        ${p.playCount ? `<span class="playlist-playcount">${formatPlayCount(p.playCount)}</span>` : ''}
        <div class="playlist-hover-play">▶ 浏览歌单</div>
      </div>
      <div class="playlist-name" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="playlist-source">${esc(srcLabel(p.source))}</div>
    </div>`;
}

function listHtml(meta, songs) {
  const shown = songs.slice(0, LIST_FOLD);
  const more = songs.length > LIST_FOLD
    ? `<button class="list-more-btn" onclick="openHomeChartModal('${escQ(meta.sec)}')">${esc(_tr('home.viewFullChart', `查看完整榜单（共 ${songs.length} 首）`, { n: songs.length }))} ▸</button>`
    : '';
  return songRowsHtml(meta, shown) + more;
}

/**
 * 榜单行。
 *
 * 改版前的问题（实测）：这一行**没有封面** —— 尽管后端每个 song 都带
 * cover 字段（netease 给的是 ?param=300y300 的 300px 图）。结果是
 * 772px 宽的行只有左侧 60px 左右有内容，右侧全空，视觉上是一列纯文字，
 * 既难扫读也浪费空间。
 *
 * 现在：封面 36px + 标题/歌手 + （可选）来源徽标 + 时长 + 常显操作按钮。
 * 「时长」是新加的 —— 榜单有 duration 字段却从未展示。
 */
function songRowsHtml(meta, songs) {
  return songs.map((s, i) => `
    <div class="top-song-row" onclick="playRecommendById('${escQ(meta.sec)}',${i})">
      <span class="top-song-rank ${i < 3 ? 'top3' : ''}">${i + 1}</span>
      ${coverThumbHtml(s.cover)}
      <div class="top-song-info">
        <div class="top-song-title">${esc(s.title)}</div>
        <div class="top-song-artist">${esc(s.artist)}${s.album ? ' · ' + (s.albumMid
          ? `<span class="album-link" onclick="event.stopPropagation();openAlbumView('${escQ(s.albumMid)}','${escQ(s.source)}','${escQ(s.album)}')">${esc(s.album)}</span>`
          : esc(s.album)) : ''}</div>
      </div>
      ${meta.showSource ? `<span class="source-badge badge-${badgeCls(s.source)}">${esc(srcLabel(s.source))}</span>` : ''}
      <span class="top-song-dur">${fmtDuration(s.duration)}</span>
      <div class="top-song-actions">
        <button class="top-song-action" title="播放" aria-label="播放 ${escAttr(s.title)}" onclick="event.stopPropagation();playRecommendById('${escQ(meta.sec)}',${i})">${svgIcon('play')}</button>
        <button class="top-song-action" title="下载" aria-label="下载 ${escAttr(s.title)}" onclick="event.stopPropagation();addRecommendDownload('${escQ(meta.sec)}',${i})">${svgIcon('down')}</button>
        <button class="top-song-action" title="添加到歌单" aria-label="添加到歌单" onclick="event.stopPropagation();quickAddRecommendToPlaylist('${escQ(meta.sec)}',${i})">${svgIcon('plus')}</button>
        ${heartBtnHtml(s, 'top-song-action')}
      </div>
    </div>
  `).join('');
}

/**
 * 36px 方形封面缩略图。
 *
 * onerror 换成一个**内联 SVG 音符轮廓**而不是 emoji：原先用 📀，
 * 在无 emoji 字体的环境（本机 Chromium 实测）会被渲染成一个黄褐色
 * 实心圆点，看起来像「加载失败」，而不像「没有封面」。
 * SVG 不依赖字体，颜色走 token，主题切换自动跟随。
 */
function coverThumbHtml(url, cls) {
  const c = cls || 'top-song-cover';
  return `<span class="${c}">${
    url
      ? `<img src="${escAttr(url)}" alt="" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.remove()">`
      : ''
  }${noCoverSvgHtml()}</span>`;
}

/** 无封面时的占位图形（内联 SVG，不依赖 emoji 字体） */
function noCoverSvgHtml() {
  return `<svg class="cover-ph-svg" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
  </svg>`;
}

/**
 * 行内操作图标（内联 SVG，统一 16px 网格 + 1.7 描边）。
 *
 * 换掉字符图标 ▶ ⬇ ＋ ♡ 的原因：这四个符号来自**四个不同的 Unicode 区块**
 * （几何图形 / 杂项符号 / 全角标点 / 其他符号），在 Segoe UI 下光学校正完全
 * 不一致 —— 实测放大后 ▶ 实心偏重、⬇ 细如发丝、＋ 偏轻，看起来像拼凑的。
 * 而 ⬇ 更麻烦：U+2B07 在部分字体下会走 emoji 呈现，被渲染成彩色方块。
 * 同一套 SVG 后，四个图标的笔画粗细、视觉重量、对齐都一致，
 * 且颜色继承 currentColor —— 主题切换与 hover 反色都不需要额外规则。
 */
const ROW_ICONS = {
  play:  '<path d="M6 4.5l12 7.5-12 7.5z" fill="currentColor"/>',
  down:  '<path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 20h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  plus:  '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.7c0 4.9-7 9.3-7 9.3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  heartOn: '<path d="M12 20s-7-4.4-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.7c0 4.9-7 9.3-7 9.3z" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
};

function svgIcon(name) {
  return `<svg class="row-icon" viewBox="0 0 24 24" aria-hidden="true">${ROW_ICONS[name] || ''}</svg>`;
}

/** 毫秒 → m:ss；缺失/非法返回空串（不显示「0:00」这种噪音） */
function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const total = Math.round(n / 1000);
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return mm + ':' + ss;
}

/**
 * 完整榜单弹窗。
 *
 * 为什么把「展开全部」从原地展开改成弹窗：
 *   原地展开会把该平台块撑到 20 行 ×49px ≈ 1 屏高，把后面的平台
 *   推出视口 —— 首页要回答的是「有什么值得听」，不是「全部有什么」。
 *   完整榜单是次级信息，用弹窗承载既不丢功能，也不破坏首页节奏。
 *
 * 列表本身仍复用 songRowsHtml，故行的交互（播放/下载/收藏）完全一致；
 * 区别只是 meta.sec 仍指向原分区，因此 playRecommendById 的索引语义不变。
 */
function openHomeChartModal(sec) {
  const meta = _findMeta(sec);
  const songs = _getSection(sec);
  if (!meta || !songs.length) return;

  closeHomeChartModal(); // 幂等：重复打开先清旧的

  const overlay = document.createElement('div');
  overlay.className = 'playlist-modal-overlay';
  overlay.id = 'homeChartModal';
  overlay.innerHTML = `
    <div class="playlist-modal home-chart-modal" role="dialog" aria-modal="true" aria-label="${escAttr(_tr(meta.i18n, meta.title))}">
      <div class="playlist-modal-header">
        <span class="playlist-modal-title">${esc(_tr(meta.i18n, meta.title))} · ${esc(platformName(_platOf(sec)))}</span>
        <span class="home-chart-count">${esc(_tr('home.trackCount', `${songs.length} 首`, { n: songs.length }))}</span>
        <button class="playlist-modal-close" aria-label="${escAttr(_tr('home.close', '关闭'))}" onclick="closeHomeChartModal()">✕</button>
      </div>
      <div class="playlist-modal-body" id="homeChartBody">${songRowsHtml(meta, songs)}</div>
    </div>`;

  // 点遮罩关闭（点内容区不关）—— 与既有 playlist-modal 行为一致
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeHomeChartModal(); });
  document.body.appendChild(overlay);

  // Esc 关闭。监听器挂在 document 上，故关闭时必须移除，否则每开一次
  // 就积一个监听器（连开 10 次 = 10 个 Esc 监听，且都引用同一个闭包）。
  _chartEscHandler = (e) => { if (e.key === 'Escape') closeHomeChartModal(); };
  document.addEventListener('keydown', _chartEscHandler);

  const closeBtn = overlay.querySelector('.playlist-modal-close');
  if (closeBtn) closeBtn.focus();
}

function closeHomeChartModal() {
  const el = document.getElementById('homeChartModal');
  if (el) el.remove();
  if (_chartEscHandler) {
    document.removeEventListener('keydown', _chartEscHandler);
    _chartEscHandler = null;
  }
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
  const quality = resolveQuality(song.source);
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
    const quality = resolveQuality(song.source);
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
  openHomeChartModal,
  closeHomeChartModal,
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
window.openHomeChartModal = openHomeChartModal;
window.closeHomeChartModal = closeHomeChartModal;
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
