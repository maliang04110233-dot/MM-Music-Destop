/**
 * 首页推荐聚合
 *
 * 跨平台并行拉取榜单 / 推荐歌单 / 排行，统一返回结构
 *
 * "拉全部"策略（2026-06-13 调整）：
 *   - 网易云榜单：100 首/榜（接口上限）
 *   - 网易云歌单：30 个（接口上限）
 *   - QQ 歌单：30 个
 *   - B 站排行：100 条（接口上限）
 */

const netease  = require('./platforms/netease');
const qq       = require('./platforms/qq');
const kugou    = require('./platforms/kugou');
const bilibili = require('./platforms/bilibili');
const logger = require('../utils/logger');

// Cookie 由 aggregator 通过 setCookieReader 注入；这里用 getter 读
// 引入 aggregator 是为了"如果 aggregator 还没调 setCookieReader，就 fallback 到它自己的 getCookie"
let _getCookie = null;
function setCookieReader(fn) { _getCookie = fn; }
const _fallback = (platform) => {
  try { return require('./index').getCookie?.(platform) || ''; } catch { return ''; }
};

async function getHomeRecommendations() {
  const biliCookie = (_getCookie || _fallback)('bilibili');

  // 分批拉取，避免一次性 7 个并发撞到 NeteaseCloudMusicApi 限速
  // 第 1 批：4 个网易云榜单（并发提升首页加载速度）
  // 第 2 批：网易云歌单 + QQ 歌单 + B 站排行（不同域名可并发）

  const [
    neteaseTops,
    neteaseHot,
    neteaseNew,
    neteaseOriginal,
  ] = await Promise.allSettled([
    safeCall('网易云飙升榜', () => netease.neteaseGetTopList('飙升榜', 100)),
    safeCall('网易云热歌榜', () => netease.neteaseGetTopList('热歌榜', 100)),
    safeCall('网易云新歌榜', () => netease.neteaseGetTopList('新歌榜', 100)),
    safeCall('网易云原创榜', () => netease.neteaseGetTopList('原创榜', 100)),
  ]).then((arr) => arr.map((r) => r.status === 'fulfilled' ? r.value : []));
  // 修复 B30：safeCall 失败时返回 {__error}，统一为 []
  const arr = (v) => Array.isArray(v) ? v : [];
  const safe = { neteaseTops: arr(neteaseTops), neteaseHot: arr(neteaseHot), neteaseNew: arr(neteaseNew), neteaseOriginal: arr(neteaseOriginal) };

  const [
    neteasePlaylists,
    qqRecommend, qqOfficial, qqClassic, qqLove, qqKTV,
    qqTop, qqNew, qqRadio, qqSingers,
    biliRanking,
  ] = await Promise.allSettled([
    safeCall('网易云推荐歌单',   () => netease.neteaseGetRecommendPlaylists(30)),
    safeCall('QQ个性化歌单',     () => qq.qqGetRecommendPlaylists(30)),
    safeCall('QQ官方歌单',       () => qq.qqGetCategoryPlaylists(10000000, 1, 30)),
    safeCall('QQ经典歌单',       () => qq.qqGetCategoryPlaylists(136,   1, 30)),
    safeCall('QQ情歌歌单',       () => qq.qqGetCategoryPlaylists(148,   1, 30)),
    safeCall('QQ KTV歌单',        () => qq.qqGetCategoryPlaylists(141,   1, 30)),
    safeCall('QQ热歌榜',         () => qq.qqGetTopList(4, 30)),
    safeCall('QQ内地新歌',       () => qq.qqGetNewSongs(1, 30)),
    safeCall('QQ热门电台',       () => qq.qqGetRadioStations(30)),
    safeCall('QQ热门歌手',       () => qq.qqGetHotSingers(30)),
    safeCall('B站排行',          () => bilibili.bilibiliGetRanking(100, biliCookie)),
  ]).then((arr) => arr.map((r) => r.status === 'fulfilled' ? (Array.isArray(r.value) ? r.value : []) : []));

  return {
    netease: {
      tops:      safe.neteaseTops,
      hot:       safe.neteaseHot,
      newSongs:  safe.neteaseNew,
      original:  safe.neteaseOriginal,
      playlists: neteasePlaylists,
    },
    qq: {
      recommend:   qqRecommend,
      official:    qqOfficial,
      classic:     qqClassic,
      love:        qqLove,
      ktv:         qqKTV,
      topList:     qqTop,
      newSongs:    qqNew,
      radios:      qqRadio,
      hotSingers:  qqSingers,
    },
    bilibili: {
      ranking: biliRanking,
    },
  };
}

/**
 * 包一层 try/catch，让任意接口失败只影响自己，不影响其它接口
 * 修复 B30：失败时返回 { __error: msg } 让上层能区分"没数据"和"接口失败"
 */
async function safeCall(label, fn) {
  try {
    const result = await fn();
    logger.log(`[recommendations] ✓ ${label} -> ${Array.isArray(result) ? result.length + ' 项' : typeof result}`);
    return result;
  } catch (e) {
    logger.warn(`[recommendations] ✗ ${label} 失败:`, e.message || e);
    return { __error: e.message || String(e) };
  }
}

async function getPlaylistSongs(platform, id, limit = 200) {
  if (platform === 'qq') return await qq.qqGetPlaylistSongs(id, limit);
  if (platform === 'netease') {
    try {
      return await netease.neteaseGetPlaylistDetail(id, limit);
    } catch (e) {
      logger.warn('网易云歌单获取失败:', e.message);
    }
  }
  return [];
}

/**
 * 首页分区懒加载 API
 *
 * section 命名：
 *   netease.tops / netease.hot / netease.new / netease.original / netease.playlists
 *   qq.recommend / qq.official / qq.classic / qq.love / qq.ktv / qq.top / qq.new / qq.radio / qq.singers
 *   bilibili.ranking
 *
 * 返回统一结构：
 *   { ok: true, section, data: [] }
 *   { ok: false, section, data: [], error }
 */
async function getHomeSection(section) {
  const biliCookie = (_getCookie || _fallback)('bilibili');
  const map = {
    'netease.tops':      () => netease.neteaseGetTopList('飙升榜', 100),
    'netease.hot':       () => netease.neteaseGetTopList('热歌榜', 100),
    'netease.new':       () => netease.neteaseGetTopList('新歌榜', 100),
    'netease.original':  () => netease.neteaseGetTopList('原创榜', 100),
    'netease.playlists': () => netease.neteaseGetRecommendPlaylists(30),

    'qq.recommend': () => qq.qqGetRecommendPlaylists(30),
    'qq.official':  () => qq.qqGetCategoryPlaylists(10000000, 1, 30),
    'qq.classic':   () => qq.qqGetCategoryPlaylists(136,   1, 30),
    'qq.love':      () => qq.qqGetCategoryPlaylists(148,   1, 30),
    'qq.ktv':       () => qq.qqGetCategoryPlaylists(141,   1, 30),
    'qq.top':       () => qq.qqGetTopList(4, 30),
    'qq.new':       () => qq.qqGetNewSongs(1, 30),     // 1=内地
    'qq.radio':     () => qq.qqGetRadioStations(30),
    'qq.singers':   () => qq.qqGetHotSingers(30),

    'bilibili.ranking': () => bilibili.bilibiliGetRanking(100, biliCookie),
  };

  const fn = map[section];
  if (!fn) return { ok: false, section, data: [], error: '未知首页区块: ' + section };
  try {
    const data = await fn();
    logger.log(`[home-section] ✓ ${section} -> ${Array.isArray(data) ? data.length + ' 项' : typeof data}`);
    return { ok: true, section, data };
  } catch (e) {
    logger.warn(`[home-section] ✗ ${section}:`, e.message || e);
    return { ok: false, section, data: [], error: e.message || String(e) };
  }
}

async function getAlbumSongs(platform, albumMid, limit = 999) {
  if (platform === 'qq') {
    try { return await qq.qqGetAlbumSongs(albumMid, limit); } catch (e) { logger.warn('[getAlbumSongs] qq failed:', e.message); return []; }
  }
  if (platform === 'netease') {
    try { return await netease.neteaseGetAlbumSongs(albumMid, limit); } catch (e) { logger.warn('[getAlbumSongs] netease failed:', e.message); return []; }
  }
  if (platform === 'kugou') {
    try { return await kugou.kugouGetAlbumSongs(albumMid, limit); } catch (e) { logger.warn('[getAlbumSongs] kugou failed:', e.message); return []; }
  }
  return [];
}

async function searchSinger(keyword, source = 'qq', page = 1) {
  if (!keyword || typeof keyword !== 'string') return { singers: [], total: 0, page };
  try {
    if (source === 'qq') return await qq.qqSearchSinger(keyword, page);
    if (source === 'netease') return await netease.neteaseSearchSinger(keyword, page);
    if (source === 'kugou') return await kugou.kugouSearchSinger(keyword, page);
  } catch (e) {
    logger.warn(`[searchSinger] ${source} failed:`, e.message);
    return { singers: [], total: 0, page };
  }
  if (source === 'all') {
    const [qqRes, neteaseRes, kugouRes] = await Promise.allSettled([
      qq.qqSearchSinger(keyword, page),
      netease.neteaseSearchSinger(keyword, page),
      kugou.kugouSearchSinger(keyword, page),
    ]);
    const allSingers = [];
    const seen = new Set();
    [qqRes, neteaseRes, kugouRes].forEach(r => {
      if (r.status === 'fulfilled' && r.value && r.value.singers) {
        r.value.singers.forEach(s => {
          const key = s.mid + '@' + s.source;
          if (seen.has(key)) return;
          seen.add(key);
          allSingers.push(s);
        });
      }
    });
    return { singers: allSingers, total: allSingers.length, page };
  }
  return { singers: [], total: 0 };
}

async function getSingerSongs(singerMid, limit = 30) {
  if (/^\d+$/.test(singerMid)) {
    // 纯数字 ID：优先走网易云，失败回退酷狗
    try { return await netease.neteaseGetSingerSongs(singerMid, limit); } catch (_e) { /* fallback */ }
    try { return await kugou.kugouGetSingerSongs(singerMid, limit); } catch (_e) { /* fallback */ }
    return [];
  }
  return qq.qqGetSingerSongs(singerMid, limit);
}

async function getSingerAlbums(singerMid, source = 'qq', pageNo = 1, pageSize = 20) {
  if (source === 'netease') {
    try { return await netease.neteaseGetSingerAlbums(singerMid, pageNo, pageSize); } catch (_e) { /* fallback */ }
    return { albums: [], total: 0 };
  }
  if (source === 'kugou') {
    try { return await kugou.kugouGetSingerAlbums(singerMid, pageNo, pageSize); } catch (_e) { /* fallback */ }
    return { albums: [], total: 0 };
  }
  if (/^\d+$/.test(singerMid) && source === 'qq') {
    // 纯数字但 source=qq：实际是 QQ 歌手数字 mid，走 singer/album 路由
    return qq.qqGetSingerAlbums(singerMid, pageNo, pageSize);
  }
  if (source === 'qq' || !source) return qq.qqGetSingerAlbums(singerMid, pageNo, pageSize);
  return { albums: [], total: 0 };
}

module.exports = {
  getHomeRecommendations,
  getHomeSection,
  getPlaylistSongs,
  getAlbumSongs,
  searchSinger,
  getSingerSongs,
  getSingerAlbums,
  setCookieReader,
};
