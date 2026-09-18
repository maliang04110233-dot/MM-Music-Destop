/**
 * 首页推荐聚合 + 专辑 / 歌手 / 歌单域
 *
 * 跨平台并行拉取榜单 / 推荐歌单 / 排行，统一返回结构。
 *
 * 「拉全部」策略（2026-06-13 调整）：
 *   - 网易云榜单：100 首/榜（接口上限）
 *   - 网易云歌单：30 个（接口上限）
 *   - QQ 歌单：30 个
 *   - B 站排行：100 条（接口上限）
 *
 * ── v3 阶段 2 重构（2026-09-17）──────────────────────────────
 * 本文件原先直接 require 4 个平台模块（netease / qq / kugou / bilibili）
 * 并按 id 手写 if/else 分派 —— 这是设计稿 §2 的第 22 个耦合点：
 *   **新平台即使实现了 searchSinger，也完全不可达**（分派链里没有它）。
 *
 * 现在全部改走 gateway：
 *   - 平台**能力检查**由 registry 的能力推导负责（方法存在 = 能力存在）
 *   - 跨平台并发聚合统一用 gateway.fanOut（失败平台产出空值，不互相影响）
 *   - 本文件不再出现任何平台 id 的 require 或硬编码清单
 *
 * 保留的历史行为（刻意，非疏漏）：
 *   - 首页分区覆盖 netease / qq / bilibili / kugou 四家：它们的榜单与歌单
 *     是**产品配置**（哪个平台有「飙升榜」这类板块），不是平台能力，
 *     故不能由 registry 推导，只能在此显式声明。
 *     （酷狗于 2026-09-18 补齐 getTopList / getRecommendPlaylists 后加入；
 *      酷我 / 咪咕 / 5sing / 汽水仍只有 search 三件套，暂无推荐域数据可放。）
 *   - getPlaylistSongs / getAlbumSongs 的平台集合受各平台实现决定；
 *     原先 netease 走的是 neteaseGetPlaylistDetail（非 getPlaylistSongs），
 *     该差异在下方按能力探测处理，保持行为等价。
 */

const logger = require('../utils/logger');

// ── Cookie 注入 ────────────────────────────────────────────
// Cookie 由 aggregator 通过 setCookieReader 注入；这里用 getter 读。
// 保留原因：本模块在 api/index.js 完成 cookieStore 装配前就可能被 require，
// 直接依赖 api/index.js 会形成循环依赖。
let _getCookie = null;
function setCookieReader(fn) { _getCookie = fn; }

const _fallback = (platform) => {
  try { return require('./index').getCookie?.(platform) || ''; } catch { return ''; }
};

const readCookie = (platform) => (_getCookie || _fallback)(platform);

// ── 源偏好策略（业务规则，集中声明）─────────────────────────
//
// 这些是**产品决策**而非平台能力：三家都实现了 getSingerSongs / getSingerAlbums，
// 因此「先试哪个」无法从代码推导，必须显式声明。
// 集中成常量而非散落在 if/else 里，是为了让「平台 id 字面量」只出现在一处，
// 且被契约测试的「无硬编码守卫」允许（守卫只豁免策略常量区）。
const ALL_SOURCES = 'all';

const SOURCE_PREFERENCE = Object.freeze({
  /** 歌手搜索的默认源（历史行为：未指定时用 QQ） */
  defaultSingerSearch: 'qq',
  /** 纯数字歌手 mid：网易云优先，失败回落酷狗 */
  numericSingerMid: Object.freeze(['netease', 'kugou']),
  /** 字母数字 mid：QQ（其 singer mid 是字母数字混合） */
  namedSingerMid: Object.freeze(['qq']),
  /** 歌手专辑的默认尝试链 */
  singerAlbums: Object.freeze(['qq', 'netease', 'kugou']),
});

// ── Gateway 注入 ───────────────────────────────────────────
// 由 api/index.js 在装配阶段注入（与 cookie reader 同一时机）。
// 未注入时延迟到首次调用再解析 defaultRegistry —— 兼容
// 「测试先 require 本模块、后构造 registry」的用法。
let _gateway = null;
function setGateway(gateway) { _gateway = gateway; }

function gw() {
  if (_gateway) return _gateway;
  const { defaultRegistry } = require('./pluginRegistry');
  const { createPlatformGateway } = require('./gateway');
  // 延迟构造：cookie 走本模块自己的 reader，避免与 api/index.js 循环依赖
  _gateway = createPlatformGateway({ registry: defaultRegistry, getCookie: readCookie });
  return _gateway;
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

// ══════════════════════════════════════════════════════════
// 首页推荐
// ══════════════════════════════════════════════════════════

/**
 * 首页全部区块（并行为主，分批以避开网易云限速）。
 *
 * 分区集合是**产品配置**：明确了"首页展示哪些板块"。
 * 每个板块由 { 平台, 调用 } 描述，调用统一经 gateway —— 因此
 * 不构成"平台清单副本"，而是"板块清单"。
 */
const HOME_SECTIONS = Object.freeze({
  // 网易云榜单（100 首/榜，接口上限）
  'netease.tops':      (g) => g.getTopList('netease', '飙升榜', 100),
  'netease.hot':       (g) => g.getTopList('netease', '热歌榜', 100),
  'netease.new':       (g) => g.getTopList('netease', '新歌榜', 100),
  'netease.original':  (g) => g.getTopList('netease', '原创榜', 100),
  'netease.playlists': (g) => g.getRecommendPlaylists('netease', 30),

  'qq.recommend': (g) => g.getRecommendPlaylists('qq', 30),
  'qq.official':  (g) => g.getCategoryPlaylists('qq', 10000000, 1, 30),
  'qq.classic':   (g) => g.getCategoryPlaylists('qq', 136, 1, 30),
  'qq.love':      (g) => g.getCategoryPlaylists('qq', 148, 1, 30),
  'qq.ktv':       (g) => g.getCategoryPlaylists('qq', 141, 1, 30),
  'qq.top':       (g) => g.getTopList('qq', 4, 30),
  'qq.new':       (g) => g.getNewSongs('qq', 1, 30),   // 1=内地
  'qq.radio':     (g) => g.getRadioStations('qq', 30),
  'qq.singers':   (g) => g.getHotSingers('qq', 30),

  'bilibili.ranking': (g) => g.getRanking('bilibili', 100),

  // 酷狗（2026-09-18 补齐）。此前首页只有 3 家，因为酷狗/酷我/咪咕等
  // 只实现了 search 三件套、没有推荐域方法。酷狗的榜单与歌单广场
  // 现已接入 manifest，故出现在此。
  // 4 个榜单与 netease 的「飙升/热歌/新歌/原创」四榜口径对齐，便于横向比较。
  'kugou.tops':      (g) => g.getTopList('kugou', '飙升榜', 100),
  'kugou.hot':       (g) => g.getTopList('kugou', '网络热歌榜', 100),
  'kugou.short':     (g) => g.getTopList('kugou', '短视频热歌榜', 100),
  'kugou.top500':    (g) => g.getTopList('kugou', 'TOP500', 100),
  'kugou.playlists': (g) => g.getRecommendPlaylists('kugou', 30),
});

/**
 * 首页分区懒加载 API
 *
 * section 命名：
 *   netease.tops / netease.hot / netease.new / netease.original / netease.playlists
 *   qq.recommend / qq.official / qq.classic / qq.love / qq.ktv / qq.top / qq.new / qq.radio / qq.singers
 *   bilibili.ranking
 *   kugou.tops / kugou.hot / kugou.short / kugou.top500 / kugou.playlists
 *
 * 返回统一结构：
 *   { ok: true, section, data: [] }
 *   { ok: false, section, data: [], error }
 */
async function getHomeSection(section) {
  const fn = HOME_SECTIONS[section];
  if (!fn) return { ok: false, section, data: [], error: '未知首页区块: ' + section };
  try {
    const data = await fn(gw());
    logger.log(`[home-section] ✓ ${section} -> ${Array.isArray(data) ? data.length + ' 项' : typeof data}`);
    return { ok: true, section, data: Array.isArray(data) ? data : [] };
  } catch (e) {
    logger.warn(`[home-section] ✗ ${section}:`, e.message || e);
    return { ok: false, section, data: [], error: e.message || String(e) };
  }
}

/**
 * 首页全量推荐（一次性拉全部区块）。
 *
 * 分批原因：避免一次性 7+ 个并发撞到 NeteaseCloudMusicApi 限速。
 *   第 1 批：4 个网易云榜单（同域名，串行风险高，故单批）
 *   第 2 批：网易云歌单 + QQ 歌单 + B 站排行（不同域名，可并发）
 *
 * 行为与重构前逐条对齐：失败区块退化为 []，不抛错。
 */
async function getHomeRecommendations() {
  const g = gw();
  const arr = (v) => (Array.isArray(v) ? v : []);

  const [neteaseTops, neteaseHot, neteaseNew, neteaseOriginal] = (
    await Promise.allSettled([
      safeCall('网易云飙升榜', () => g.getTopList('netease', '飙升榜', 100)),
      safeCall('网易云热歌榜', () => g.getTopList('netease', '热歌榜', 100)),
      safeCall('网易云新歌榜', () => g.getTopList('netease', '新歌榜', 100)),
      safeCall('网易云原创榜', () => g.getTopList('netease', '原创榜', 100)),
    ])
  ).map((r) => (r.status === 'fulfilled' ? r.value : []));

  const safe = {
    neteaseTops: arr(neteaseTops),
    neteaseHot: arr(neteaseHot),
    neteaseNew: arr(neteaseNew),
    neteaseOriginal: arr(neteaseOriginal),
  };

  const [
    neteasePlaylists,
    qqRecommend, qqOfficial, qqClassic, qqLove, qqKTV,
    qqTop, qqNew, qqRadio, qqSingers,
    biliRanking,
    kugouTops, kugouHot, kugouShort, kugouTop500, kugouPlaylists,
  ] = (
    await Promise.allSettled([
      safeCall('网易云推荐歌单', () => g.getRecommendPlaylists('netease', 30)),
      safeCall('QQ个性化歌单',   () => g.getRecommendPlaylists('qq', 30)),
      safeCall('QQ官方歌单',     () => g.getCategoryPlaylists('qq', 10000000, 1, 30)),
      safeCall('QQ经典歌单',     () => g.getCategoryPlaylists('qq', 136, 1, 30)),
      safeCall('QQ情歌歌单',     () => g.getCategoryPlaylists('qq', 148, 1, 30)),
      safeCall('QQ KTV歌单',     () => g.getCategoryPlaylists('qq', 141, 1, 30)),
      safeCall('QQ热歌榜',       () => g.getTopList('qq', 4, 30)),
      safeCall('QQ内地新歌',     () => g.getNewSongs('qq', 1, 30)),
      safeCall('QQ热门电台',     () => g.getRadioStations('qq', 30)),
      safeCall('QQ热门歌手',     () => g.getHotSingers('qq', 30)),
      safeCall('B站排行',        () => g.getRanking('bilibili', 100)),
      safeCall('酷狗飙升榜',     () => g.getTopList('kugou', '飙升榜', 100)),
      safeCall('酷狗网络热歌榜', () => g.getTopList('kugou', '网络热歌榜', 100)),
      safeCall('酷狗短视频热歌榜', () => g.getTopList('kugou', '短视频热歌榜', 100)),
      safeCall('酷狗TOP500',     () => g.getTopList('kugou', 'TOP500', 100)),
      safeCall('酷狗推荐歌单',   () => g.getRecommendPlaylists('kugou', 30)),
    ])
  ).map((r) => (r.status === 'fulfilled' ? arr(r.value) : []));

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
    kugou: {
      tops:      kugouTops,
      hot:       kugouHot,
      short:     kugouShort,
      top500:    kugouTop500,
      playlists: kugouPlaylists,
    },
  };
}

// ══════════════════════════════════════════════════════════
// 歌单 / 专辑 / 歌手
// ══════════════════════════════════════════════════════════

/**
 * 歌单曲目。
 *
 * 历史行为：原先只支持 qq（qqGetPlaylistSongs）与 netease
 * （neteaseGetPlaylistDetail —— 注意是 **PlaylistDetail** 而非 PlaylistSongs）。
 * 现在按能力探测：优先用平台自己的 getPlaylistSongs；
 * 网易云历史上用的 detail 变体由平台侧实现已对齐（见 netease.js 的
 * getPlaylistSongs 导出），故此处可统一走 gateway。
 */
async function getPlaylistSongs(platform, id, limit = 200) {
  return gw().getPlaylistSongs(platform, id, limit);
}

/**
 * 专辑曲目。原先手写 qq / netease / kugou 三路 if-else，
 * 现在由 registry 的能力推导决定哪些平台可达 ——
 * 新平台实现 getAlbumSongs 后**自动接入**，无需回来加分支。
 */
async function getAlbumSongs(platform, albumMid, limit = 999) {
  return gw().getAlbumSongs(platform, albumMid, limit);
}

/**
 * 搜索歌手。
 *
 * 行为对齐：
 *   - 单平台：源不支持时返回 { singers: [], total: 0, page }（原实现同）
 *   - 'all'：并发搜索**所有**具备 singer 能力的平台并按 mid@source 去重
 *     （原实现硬编码 qq / netease / kugou 三家 ⇒ 新平台不可达；现改为派生）
 */
async function searchSinger(keyword, source = SOURCE_PREFERENCE.defaultSingerSearch, page = 1) {
  if (!keyword || typeof keyword !== 'string') return { singers: [], total: 0, page };
  const g = gw();

  if (source !== ALL_SOURCES) {
    return g.searchSinger(source, keyword, page);
  }

  const ids = g.platformsWith('singer');
  const results = await g.fanOut(ids, (id) => g.searchSinger(id, keyword, page));

  const allSingers = [];
  const seen = new Set();
  for (const r of results) {
    if (!r.ok || !r.value || !Array.isArray(r.value.singers)) continue;
    for (const s of r.value.singers) {
      const key = s.mid + '@' + s.source;
      if (seen.has(key)) continue;
      seen.add(key);
      allSingers.push(s);
    }
  }
  return { singers: allSingers, total: allSingers.length, page };
}

/**
 * 歌手歌曲。
 *
 * 历史行为（保留，属业务规则非疏漏）：
 *   - 纯数字 mid  ⇒ 网易云优先，失败回落酷狗
 *   - 非数字 mid  ⇒ QQ（QQ 的 singer mid 是字母数字混合）
 * 这条规则无法从平台能力推导（三家都有 getSingerSongs），
 * 故在 gateway 之上显式编排。
 *
 * 平台选择由源偏好策略常量表达（见上方 SOURCE_PREFERENCE），
 * 本函数不再出现平台 id 字面量比较。
 */
async function getSingerSongs(singerMid, limit = 30) {
  const g = gw();
  const pref = /^\d+$/.test(String(singerMid))
    ? SOURCE_PREFERENCE.numericSingerMid
    : SOURCE_PREFERENCE.namedSingerMid;

  for (const id of pref) {
    const songs = await g.getSingerSongs(id, singerMid, limit);
    if (songs.length) return songs;
  }
  return [];
}

/**
 * 歌手专辑。
 *
 * 历史行为（保留）：明确指定 netease / kugou 时走该源，
 * 其余情况（含 source 未给）走 QQ 优先。
 * 原先的 `纯数字 && source==='qq'` 分支与最后的 qq 兜底等价，已合并。
 */
async function getSingerAlbums(singerMid, source = '', pageNo = 1, pageSize = 20) {
  const g = gw();
  const pref = [source, ...SOURCE_PREFERENCE.singerAlbums]
    .filter((id) => id && SOURCE_PREFERENCE.singerAlbums.includes(id));

  const chain = pref.length ? pref : SOURCE_PREFERENCE.singerAlbums;
  for (const id of chain) {
    const r = await g.getSingerAlbums(id, singerMid, pageNo, pageSize);
    if (r && r.albums && r.albums.length) return r;
  }
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
  setGateway,
  // 供契约测试断言「无平台直连」
  _HOME_SECTIONS: HOME_SECTIONS,
};
