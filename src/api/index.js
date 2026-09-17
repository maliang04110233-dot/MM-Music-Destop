/**
 * 音乐 API 聚合层（v3 — 插件架构）
 *
 * 架构说明：
 *   - **平台 manifest 是唯一事实来源**：pluginRegistry 自动发现 platforms/ 目录，
 *     探针 / 换源候选 / CORS 白名单 / 链接识别 / 聚合条数 / 渲染层下拉
 *     全部由 registry 派生，本文件不再持有任何平台清单
 *   - 所有路由函数（searchMusic / getDownloadUrl / getLyrics 等）统一走插件系统
 *   - 新平台 = 在 platforms/ 新建 1 个文件，本文件无需改动
 *
 * 阶段 3 已移除：8 个原始平台模块再导出 + qqSearch/qqGetUrl/qqVerifyCookie 兼容别名。
 *   依据是全仓调用方普查（src/ test/ scripts/ .preview/ 零命中）。
 *   要取平台实现请用 registry.get(id) / registry.getCapabilities(id)，
 *   不要再从本模块 import 平台模块 —— 那会让"平台清单"重新长出第二份。
 */

const { defaultRegistry, loadPlatformPlugins } = require('./pluginRegistry');
const { createPlatformGateway } = require('./gateway');
const recommendations = require('./recommendations');
const logger = require('../utils/logger');
const { normalizeQQCookie, detectQQCookieType, extractQQUin, extractQQMusickey } = require('../utils/cookie');
const sourceHealth = require('../utils/sourceHealth');

// ── 注册平台插件（v3：registry 自动发现 platforms/ 目录）──────
// 平台顺序与各派生清单（探针 / 换源候选 / CORS 白名单 / 链接模式 /
// 聚合条数）全部由各平台 manifest 声明并派生，不再在此手写适配器。
// 新平台 = 在 platforms/ 新建 1 个文件。
const _registry = defaultRegistry;
loadPlatformPlugins(_registry);
logger.log(`[API] 平台加载完成，共 ${_registry.size} 个: ${_registry.getIds().join(', ')}`);

// ── Cookie 存储 ───────────────────────────────────────────
let cookieStore = null;

// ── 平台网关（v3 阶段 2：平台调用的唯一出口）─────────────────
// 所有对平台的调用都应经 gateway，而不是 registry.get(id).method()。
// gateway 负责：能力检查、cookie 注入、统一 safeRun、空值退化约定。
const gateway = createPlatformGateway({
  registry: _registry,
  getCookie: (platform) => getCookie(platform),
});
// 推荐域同样注入 gateway，消灭它原先的平台直连 + 手写分派
recommendations.setGateway(gateway);

function setCookieStore(store) {
  cookieStore = store;
  if (store) {
    const qqCookie = store.get('qq');
    if (qqCookie) _pushQQCookieToLib(qqCookie);
  }
  recommendations.setCookieReader(getCookie);
}
function getCookie(platform) {
  if (!cookieStore) return '';
  return cookieStore.get(platform) || '';
}

// ─── QQ 音乐 Cookie 全局状态管理 ──────────────────────────
function _pushQQCookieToLib(cookie) {
  const qqMusic = require('qq-music-api');
  if (cookie) {
    qqMusic.setCookie(normalizeQQCookie(cookie));
  } else {
    qqMusic.setCookie('');
  }
}
function updateCookie(platform, cookie) {
  if (platform !== 'qq') return;
  _pushQQCookieToLib(cookie || '');
}

// ─── 搜索聚合（插件架构版）─────────────────────────────────
async function searchMusic(keyword, source, page = 1) {
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return { songs: [], source: source || 'all', error: '搜索关键词不能为空' };
  }
  const errors = [];

  // 单平台搜索
  if (source !== 'all') {
    if (!_registry.has(source)) return { songs: [], source, error: `未知平台: ${source}` };
    try {
      const songs = await gateway.search(source, keyword, page);
      return { songs, source, error: null };
    } catch (e) {
      return { songs: [], source, error: `${source}: ${e.message || e}` };
    }
  }

  // all: 并行搜索所有平台，按 manifest 的 policies.aggregateLimit 截断
  const allPlugins = _registry.getAll();
  const results = await gateway.fanOut(allPlugins.map(p => p.id), async (id) => {
    try {
      return await gateway.search(id, keyword, 1);
    } catch (e) {
      errors.push(`${id}: ${e.message || e}`);
      return [];
    }
  });
  // 聚合条数由 manifest 的 policies.aggregateLimit 显式声明。
  // 原先是按数组下标硬编码 10/10/5 —— 在中间插入新平台会静默改变
  // 后面所有平台的聚合条数，且没有任何测试盯着。
  const songs = results.flatMap((r, i) => {
    if (!r.ok) return [];
    return r.value.slice(0, allPlugins[i]._policies.aggregateLimit);
  });
  return { songs, source: 'all', error: errors.length ? errors.join(' / ') : null };
}

// ─── 专辑搜索（插件架构版）─────────────────────────────────
async function searchAlbum(keyword, source = 'qq', page = 1) {
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return { albums: [], total: 0 };
  }

  if (source !== 'all') {
    return await gateway.searchAlbum(source, keyword, page);
  }

  // all: 并行搜索所有支持专辑的平台（能力由 registry 推导）
  const ids = gateway.platformsWith('album');
  const results = await gateway.fanOut(ids, (id) => gateway.searchAlbum(id, keyword, page));
  const allAlbums = [];
  const seen = new Set();
  for (const r of results) {
    if (!r.ok || !r.value || !Array.isArray(r.value.albums)) continue;
    for (const a of r.value.albums) {
      if (a.mid && seen.has(a.mid)) continue;
      if (a.mid) seen.add(a.mid);
      allAlbums.push(a);
    }
  }
  allAlbums.sort((a, b) => {
    if (!a.publishTime && !b.publishTime) return 0;
    if (!a.publishTime) return 1;
    if (!b.publishTime) return -1;
    return b.publishTime.localeCompare(a.publishTime);
  });
  return { albums: allAlbums, total: allAlbums.length, page };
}

// ─── 下载 URL 聚合（插件架构版）────────────────────────────
async function getDownloadUrl(id, source, quality) {
  return gateway.getUrl(source, id, quality);
}

// ── 智能取流（换源机制）───────────────────────────────────
// 本源失败时，跨源找同曲候选逐个尝试（借鉴 lx-music-desktop 换源播放）。
// 只对"换平台有救"的错误触发：VIP/需登录/版权/无音频流/CDN 失效；
// 网络类错误（超时/断网）不触发——整体网络问题换源同样失败，只白费请求。

const { ERROR_CODES } = require('../shared/errors');
const { findMatchedCandidates } = require('../utils/matchMusic');

// 触发换源的错误码（含 bilibili 自定义的 BILI_URL_ERROR 中登录类失败由 LOGIN_REQUIRED 表达）
const FALLBACK_CODES = new Set([
  ERROR_CODES.VIP_REQUIRED,
  ERROR_CODES.LOGIN_REQUIRED,
  ERROR_CODES.AUTH_EXPIRED,
  ERROR_CODES.COOKIE_INVALID,
  ERROR_CODES.COPYRIGHT_RESTRICTED,
  ERROR_CODES.UNAVAILABLE,
  ERROR_CODES.NO_AUDIO_STREAM,
  ERROR_CODES.CDN_EMPTY,
]);

function shouldFallbackToOtherSource(result) {
  if (!result || result.url) return false;
  if (result.code && FALLBACK_CODES.has(result.code)) return true;
  // 无 code 的失败（如 HTTP 403/404/410 CDN 签名过期）也换源重试
  if (/HTTP\s*(403|404|410)/i.test(String(result.error || ''))) return true;
  // 未知数据源（B 站 id 传错等）不换——歌本身可能不存在
  return false;
}

/**
 * 智能取流：本源 → 失败且可换源 → 跨源匹配候选逐个试
 * @param {object} song 完整歌曲对象（非裸 id）：{ id, source, title, artist, duration, _altSource? }
 * @param {string} quality
 * @returns {Promise<{url,ext,...}|{error,...}>}
 *   成功时若发生换源，附带 { source, matchedSong, matchedFrom }；
 *   全部失败返回本源原始错误（UI 文案不变）。
 */
async function getDownloadUrlSmart(song, quality) {
  if (!song || !song.id || !song.source) {
    return { error: '参数无效：缺少歌曲 id/source', code: 'INVALID_ARGS' };
  }

  // 1. _altSource 记忆：上次换源成功的源先试（lx toggleMusicInfo 模式）
  const alt = song._altSource;
  if (alt && alt.source && alt.id && alt.source !== song.source) {
    try {
      const r = await getDownloadUrl(alt.id, alt.source, quality);
      sourceHealth.recordResult(alt.source, !!(r && r.url));
      if (r && r.url) return { ...r, source: alt.source, matchedFrom: song.source, fromAltMemory: true };
    } catch (_e) {
      sourceHealth.recordResult(alt.source, false);
      /* 记忆失效则走正常流程 */
    }
  }

  // 2. 本源（健康度极低且有可用候选时延后——见下方步骤 2b）
  const result = await getDownloadUrl(song.id, song.source, quality);
  if (result && result.url) {
    sourceHealth.recordResult(song.source, true);
    return result;
  }
  sourceHealth.recordResult(song.source, false);

  // 3. 失败且可换源 → 跨源候选逐个尝试
  if (!shouldFallbackToOtherSource(result)) return result;

  const deps = {
    searchFn: (platformId, keyword) => gateway.search(platformId, keyword, 1),
    hasCookie: (platformId) => !!getCookie(platformId),
  };
  let candidates = [];
  try {
    candidates = await findMatchedCandidates(deps, song);
  } catch (e) {
    logger.warn('[getDownloadUrlSmart] 跨源匹配失败:', e && e.message);
  }

  // 源可用性自动降级：候选按健康度重排（好源先试）。稳定排序保住匹配分序。
  if (candidates.length > 1) {
    candidates = sourceHealth.rankByHealth(candidates);
  }

  for (const cand of candidates) {
    const r = await getDownloadUrl(cand.id, cand.source, quality);
    sourceHealth.recordResult(cand.source, !!(r && r.url));
    if (r && r.url) {
      logger.log(`[getDownloadUrlSmart] 换源成功: "${song.title}" ${song.source} → ${cand.source}`);
      return { ...r, source: cand.source, matchedSong: cand, matchedFrom: song.source };
    }
  }

  // 4. 全失败：返回本源原始错误
  return result;
}

// 源健康度快照（设置页探针展示用）
function getSourceHealthMap(sources) {
  return sourceHealth.getHealthMap(sources);
}

// 主动探针结果记入滑动窗口（与被动下载结果共用同一分数）
function recordProbeResult(source, ok) {
  sourceHealth.recordResult(source, !!ok);
}


// ── 歌词聚合（插件架构版）─────────────────────────────────
async function getLyrics(id, source, title, artist) {
  // 优先按来源获取
  const primary = await gateway.getLyrics(source, id);
  if (primary.lrc) return primary;

  // fallback 1：用 title/artist 去网易云搜（netease 是实现该兜底的首选源）
  if (title) {
    const results = await gateway.search('netease', `${title} ${artist}`, 1);
    if (results.length > 0) {
      const r = await gateway.getLyrics('netease', results[0].id);
      if (r.lrc) return r;
    }
  }

  // fallback 2：交给实现了 getLyricsByTitle 的平台按"歌名+歌手"兜底
  // （原先直连 kugou 的私有函数 ⇒ 绕过插件抽象，新平台无法参与这条 fallback）
  // 平台集合由 registry 的能力推导（capabilities.lyricsByTitle）决定。
  if (title) {
    for (const platformId of gateway.platformsWith('lyricsByTitle')) {
      const lrc = await gateway.getLyricsByTitle(platformId, title, artist);
      if (lrc) return { lrc };
    }
  }

  return { lrc: '' };
}

// ─── 粘贴链接智能识别（cobalt 式「贴链接即得歌」）──────────
const { parseMusicLink, detectShortLink } = require('../utils/linkParser');

/**
 * 解析用户输入：链接 → { matched, song?, album?, playlist?, shortLink? }
 *
 * 单曲链接拉详情；专辑/歌单链接返回 { type, id, title } 由渲染层
 * 走现有专辑/歌单曲目流程（getAlbumSongs / getPlaylistSongs）。
 * 平台短链（163cn.tv / b23.tv）无法本地解析，返回 shortLink 标记。
 */
async function getSongByLink(text) {
  const link = parseMusicLink(text);
  if (!link) {
    const short = detectShortLink(text);
    if (short) return { matched: false, shortLink: short };
    return { matched: false };
  }

  // 单曲：按平台拉详情
  if (link.type === 'song') {
    // 平台是否支持由 manifest 的 getSongDetail 方法存在性决定（capabilities.linkDetail）；
    // 原先这里是四路 if-else 硬编码，加平台必须回来加分支。
    const song = await gateway.getSongDetail(link.platform, link.id);
    if (!song) return { matched: true, link, error: '未能获取歌曲信息（链接可能已失效或需要登录）' };
    return { matched: true, link, song };
  }

  // 专辑/歌单：只解析出 { type, id }，渲染层复用现有曲目录入流程
  return { matched: true, link };
}

// ─── Cookie 验证聚合（插件架构版）──────────────────────────
async function verifyCookie(platform, cookie) {
  return gateway.verifyCookie(platform, cookie);
}

// ─── 首页推荐 / 歌单 ───────────────────────────────────
const getHomeRecommendations = recommendations.getHomeRecommendations;
const getHomeSection         = recommendations.getHomeSection;
const getPlaylistSongs       = recommendations.getPlaylistSongs;
const getAlbumSongs          = recommendations.getAlbumSongs;
const searchSinger           = recommendations.searchSinger;
const getSingerSongs         = recommendations.getSingerSongs;
const getSingerAlbums        = recommendations.getSingerAlbums;

module.exports = {
  // 路由（插件架构）
  searchMusic,
  searchAlbum,
  getDownloadUrl,
  getDownloadUrlSmart,
  getSourceHealthMap,
  recordProbeResult,
  getLyrics,
  verifyCookie,
  getSongByLink,
  parseMusicLink,
  detectShortLink,
  // Cookie
  setCookieStore,
  getCookie,
  updateCookie,
  // 推荐
  getHomeRecommendations,
  getHomeSection,
  getPlaylistSongs,
  getAlbumSongs,
  searchSinger,
  getSingerSongs,
  getSingerAlbums,
  // 转发 utils/cookie
  detectQQCookieType,
  normalizeQQCookie,
  extractQQUin,
  extractQQMusickey,
  // 插件注册中心（供外部检查）
  registry: _registry,
  // 平台网关（平台调用的推荐入口；registry 用于查询事实，gateway 用于调用）
  gateway,
  // 统一错误码
  AppError: require('../shared/errors').AppError,
};
