/**
 * 音乐 API 聚合层（v2 — 插件架构）
 *
 * 架构说明：
 *   - 平台模块通过适配器注册到 PluginRegistry
 *   - 所有路由函数（searchMusic / getDownloadUrl / getLyrics 等）统一走插件系统
 *   - 老式导出（qqSearch / neteaseGetUrl 等）保留向后兼容
 *   - 新平台只需在 platforms/ 加一个文件 + 在 _ADAPTERS 注册适配器
 */

const { defaultRegistry } = require('./pluginRegistry');
const recommendations = require('./recommendations');
const logger = require('../utils/logger');
const { normalizeQQCookie, detectQQCookieType, extractQQUin, extractQQMusickey } = require('../utils/cookie');

// ── 直接 require 平台模块（向后兼容 + 适配器桥接）──────────
const netease = require('./platforms/netease');
const qq = require('./platforms/qq');
const bilibili = require('./platforms/bilibili');
const kugou = require('./platforms/kugou');

// ── 平台适配器定义 ────────────────────────────────────────
// 每个适配器把老式函数名映射到标准化插件接口
const _ADAPTERS = [
  {
    id: 'netease', name: '网易云音乐', icon: '🎵',
    search: (keyword, page, cookie) => netease.neteaseSearch(keyword, page, cookie),
    getUrl: (id, quality, cookie) => netease.neteaseGetUrl(id, quality, cookie),
    getLyrics: (id) => netease.neteaseGetLyrics(id),
    verifyCookie: (cookie) => netease.neteaseVerifyCookie(cookie),
    searchAlbum: (keyword, page) => netease.neteaseSearchAlbum(keyword, page),
    getAlbumSongs: (albumId, page) => netease.neteaseGetAlbumSongs(albumId, page),
    searchSinger: (keyword, page) => netease.neteaseSearchSinger(keyword, page),
    getSingerSongs: (mid, page) => netease.neteaseGetSingerSongs(mid, page),
    getSingerAlbums: (mid, page) => netease.neteaseGetSingerAlbums(mid, page),
  },
  {
    id: 'qq', name: 'QQ音乐', icon: '🎶',
    search: (keyword, page, cookie) => qq.qqSearch(keyword, page, cookie),
    getUrl: (id, quality, cookie) => qq.qqGetUrl(id, quality, cookie),
    getLyrics: (id) => qq.qqGetLyrics(id),
    verifyCookie: (cookie) => qq.qqVerifyCookie(cookie),
    searchAlbum: (keyword, page) => qq.qqSearchAlbum(keyword, page),
    getAlbumSongs: (albumId, page) => qq.qqGetAlbumSongs(albumId, page),
    searchSinger: (keyword, page) => qq.qqSearchSinger(keyword, page),
    getSingerSongs: (mid, page) => qq.qqGetSingerSongs(mid, page),
    getSingerAlbums: (mid, page) => qq.qqGetSingerAlbums(mid, page),
  },
  {
    id: 'bilibili', name: 'B站', icon: '📺',
    search: (keyword, page, cookie) => bilibili.bilibiliSearch(keyword, page, cookie),
    getUrl: (id, quality, cookie) => bilibili.bilibiliGetUrl(id, quality, cookie),
    verifyCookie: (cookie) => bilibili.bilibiliVerifyCookie(cookie),
  },
  {
    id: 'kugou', name: '酷狗音乐', icon: '🎸',
    search: (keyword, page, cookie) => kugou.kugouSearch(keyword, page),
    getUrl: (id, quality) => kugou.kugouGetUrl(id, quality),
    getLyrics: (id) => kugou.kugouGetLyrics(id),
    searchAlbum: (keyword, page) => kugou.kugouSearchAlbum(keyword, page),
    getAlbumSongs: (albumId, page) => kugou.kugouGetAlbumSongs(albumId, page),
    searchSinger: (keyword, page) => kugou.kugouSearchSinger(keyword, page),
    getSingerSongs: (mid, page) => kugou.kugouGetSingerSongs(mid, page),
    getSingerAlbums: (mid, page) => kugou.kugouGetSingerAlbums(mid, page),
  },
];

// ── 注册插件 ──────────────────────────────────────────────
const _registry = defaultRegistry;
for (const adapter of _ADAPTERS) {
  _registry.register(adapter);
}
logger.log(`[API] 插件注册完成，共 ${_registry.size} 个平台: ${_registry.getIds().join(', ')}`);

// ── Cookie 存储 ───────────────────────────────────────────
let cookieStore = null;
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
  const safeRun = async (label, fn) => {
    try { return await fn(); }
    catch (e) { errors.push(`${label}: ${e.message || e}`); return []; }
  };

  // 单平台搜索
  if (source !== 'all') {
    const plugin = _registry.get(source);
    if (!plugin) return { songs: [], source, error: `未知平台: ${source}` };
    const songs = await safeRun(plugin.name, () => plugin.search(keyword, page, getCookie(source)));
    return { songs, source, error: errors[0] || null };
  }

  // all: 并行搜索所有平台
  const allPlugins = _registry.getAll();
  const results = await Promise.allSettled(
    allPlugins.map(p => safeRun(p.name, () => p.search(keyword, 1, getCookie(p.id))))
  );
  const songs = results.flatMap((r, i) => {
    if (r.status !== 'fulfilled') return [];
    const limit = i === 0 ? 10 : i === 1 ? 10 : 5;
    return r.value.slice(0, limit);
  });
  return { songs, source: 'all', error: errors.length ? errors.join(' / ') : null };
}

// ─── 专辑搜索（插件架构版）─────────────────────────────────
async function searchAlbum(keyword, source = 'qq', page = 1) {
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return { albums: [], total: 0 };
  }
  const safeRun = async (label, fn) => {
    try { return await fn(); }
    catch (e) { logger.warn(`[${label}] 专辑搜索失败:`, e.message || e); return { albums: [], total: 0 }; }
  };

  if (source !== 'all') {
    const plugin = _registry.get(source);
    if (!plugin || !plugin.searchAlbum) return { albums: [], total: 0 };
    return await safeRun(plugin.name, () => plugin.searchAlbum(keyword, page));
  }

  // all: 并行搜索所有支持专辑的平台
  const allPlugins = _registry.getAll().filter(p => p.searchAlbum);
  const results = await Promise.allSettled(
    allPlugins.map(p => safeRun(p.name, () => p.searchAlbum(keyword, page)))
  );
  const allAlbums = [];
  const seen = new Set();
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value && r.value.albums) {
      r.value.albums.forEach(a => {
        if (a.mid && seen.has(a.mid)) return;
        if (a.mid) seen.add(a.mid);
        allAlbums.push(a);
      });
    }
  });
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
  const safeRun = async (label, fn) => {
    try { return await fn(); }
    catch (e) {
      logger.warn(`${label}获取下载URL失败:`, e.message || e);
      return { error: e.message || e };
    }
  };

  const plugin = _registry.get(source);
  if (!plugin) return { error: '未知数据源: ' + source };
  return await safeRun(plugin.name, () => plugin.getUrl(id, quality, getCookie(source)));
}

// ── 歌词聚合（插件架构版）─────────────────────────────────
async function getLyrics(id, source, title, artist) {
  let lrc = '';

  // 优先按来源获取
  const plugin = _registry.get(source);
  if (plugin && plugin.getLyrics) {
    try { lrc = await plugin.getLyrics(id); } catch (e) { /* ignore */ }
  }

  // fallback 1：用 title/artist 去网易云搜
  if (!lrc && title) {
    const neteasePlugin = _registry.get('netease');
    if (neteasePlugin) {
      try {
        const results = await neteasePlugin.search(`${title} ${artist}`, 1, getCookie('netease'));
        if (results.length > 0) {
          lrc = await neteasePlugin.getLyrics(results[0].id);
        }
      } catch (e) { /* ignore */ }
    }
  }

  // fallback 2：用 title/artist 去酷狗搜
  if (!lrc && title) {
    try {
      lrc = await kugou.kugouGetLyricsByTitle(title, artist);
    } catch (e) { /* ignore */ }
  }

  return { lrc };
}

// ─── Cookie 验证聚合（插件架构版）──────────────────────────
async function verifyCookie(platform, cookie) {
  const plugin = _registry.get(platform);
  if (!plugin || !plugin.verifyCookie) return { valid: false };
  try {
    return await plugin.verifyCookie(cookie);
  } catch (e) {
    logger.warn(`[${platform}] Cookie 验证异常:`, e.message || e);
    return { valid: false, reason: '验证异常: ' + (e.message || e) };
  }
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
  getLyrics,
  verifyCookie,
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
  // 原始平台模块引用（向后兼容）
  netease,
  qq,
  bilibili,
  kugou,
  // 转发 utils/cookie
  detectQQCookieType,
  normalizeQQCookie,
  extractQQUin,
  extractQQMusickey,
  // 兼容老调用方
  qqSearch: qq.qqSearch,
  qqGetUrl: qq.qqGetUrl,
  qqVerifyCookie: qq.qqVerifyCookie,
  // 插件注册中心（供外部检查）
  registry: _registry,
  // 统一错误码
  AppError: require('../shared/errors').AppError,
};
