/**
 * 平台网关（Platform Gateway）— 平台能力的唯一调用出口
 *
 * 架构定位（见 docs/REFACTOR_PLAN_2026-09-17.md 阶段 1）：
 *   registry  = 平台**事实**的唯一来源（有哪些平台、有什么能力、域名、策略）
 *   gateway   = 平台**调用**的唯一出口（怎么调、能力不具备时怎么退化、错误怎么统一）
 *
 * 为什么需要本模块：
 *   在 gateway 出现之前，「调用平台」这件事散落在各消费方：
 *   - recommendations.js 直接 require 4 个平台模块 + 按 id 写 if/else 分派；
 *   - onlineCover.js 直接 require qq / kugou；
 *   - api/index.js 自己实现了一遍 registry.get(id).method() 的调用样板。
 *   结果是「加了新平台但没接进某个分派」这类**静默失效**，
 *   以及每个消费方各自处理"能力是否存在""平台报错怎么办"。
 *
 * 本模块把这三件事收敛到一处：
 *   1. 能力检查 —— 平台不存在 / 未实现该方法时，返回**可预期的空结果**而非抛错；
 *   2. 调用样板 —— 统一注入 cookie、统一 safeRun、统一日志前缀；
 *   3. 错误收敛 —— 平台异常不向上抛，转为空结果并由调用方决定如何呈现。
 *
 * 设计约束（重要）：
 *   - 本模块**只依赖 registry 的公开接口**，不 require 任何 platforms/* 文件，
 *     也不持有平台 id 清单（那会让"平台清单"重新长出第二份）。
 *   - 返回空结果的形态必须与既有消费方期望一致（见各方法注释），
 *     否则会改变上层 UI 行为 —— 这是零回归的硬要求。
 *   - 不在此处做换源 / 重试 / 健康度：那些是业务策略，属于
 *     api/index.js（getDownloadUrlSmart）与后续的 resolveTrackService。
 */

const logger = require('../utils/logger');

/**
 * 空返回值约定：与既有消费方历史行为逐条对齐。
 * ⚠️ 改这些值等于改上层 UI 行为，务必同时确认所有调用方。
 */
const EMPTY = Object.freeze({
  list: () => [],
  albumResult: () => ({ albums: [], total: 0 }),
  singerResult: (page = 1) => ({ singers: [], total: 0, page }),
});

/**
 * 创建一个网关实例。
 *
 * 依赖注入而非直接 require defaultRegistry —— 让测试可以传入
 * 只注册了桩平台的独立 registry，无需加载真实平台与网络。
 *
 * @param {Object} deps
 * @param {import('./pluginRegistry').PluginRegistry} deps.registry 平台注册中心
 * @param {(platformId: string) => string} [deps.getCookie] 读取平台 Cookie
 * @returns {Object} gateway
 */
function createPlatformGateway({ registry, getCookie = () => '' } = {}) {
  if (!registry) {
    throw new Error('[gateway] 必须注入 registry');
  }

  /** 统一取 cookie，容错：getCookie 抛错不应让整个调用失败 */
  function cookieFor(platformId) {
    try {
      return getCookie(platformId) || '';
    } catch (_e) {
      return '';
    }
  }

  /**
   * 取平台实例；不存在时返回 null（不抛错）。
   * @param {string} platformId
   */
  function pluginOf(platformId) {
    if (!platformId || typeof platformId !== 'string') return null;
    return registry.get(platformId) || null;
  }

  /**
   * 平台是否具备某能力（由 registry 推导的 _caps 决定，非手写清单）。
   * @param {string} platformId
   * @param {string} capability
   */
  function supports(platformId, capability) {
    const caps = registry.getCapabilities(platformId);
    return !!(caps && caps[capability]);
  }

  /**
   * 统一调用包装：捕获异常、记日志、返回 fallback。
   *
   * 平台失败**不向上抛** —— 这是本工程既有约定（推荐/歌单/专辑都是
   * 「单点失败不影响其它平台」），gateway 把这个约定固定下来，
   * 避免每个消费方各写一遍 try/catch 且行为不一致。
   *
   * @param {string} label 日志前缀与错误定位
   * @param {Function} fn
   * @param {*} fallback 失败时的返回值
   */
  async function safeRun(label, fn, fallback) {
    try {
      return await fn();
    } catch (e) {
      logger.warn(`[gateway] ${label} 失败:`, (e && e.message) || e);
      return fallback;
    }
  }

  // ── 能力调用 ──────────────────────────────────────────────

  /**
   * 搜索单曲。
   * 返回：歌曲数组（失败 / 平台不存在 / 无能力 ⇒ []）
   */
  async function search(platformId, keyword, page = 1) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.search !== 'function') {
      logger.warn(`[gateway] search: 平台 ${platformId} 不存在或无 search 能力`);
      return EMPTY.list();
    }
    return safeRun(`${platformId}.search`, () => plugin.search(keyword, page, cookieFor(platformId)), EMPTY.list());
  }

  /**
   * 取下载 URL。
   * 返回：平台原始结果对象（含 url 或 error/code）。
   * ⚠️ 与 search 不同，此处**保留平台的原始错误对象** ——
   *    换源机制依赖 result.code 做「是否值得换源」判断，不能吞成空值。
   */
  async function getUrl(platformId, id, quality) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.getUrl !== 'function') {
      return { error: `未知数据源: ${platformId}`, code: 'UNKNOWN_SOURCE' };
    }
    // safeRun 的 fallback 形态与原 getDownloadUrl 的 catch 分支保持一致
    return safeRun(
      `${plugin.name} 获取下载URL`,
      () => plugin.getUrl(id, quality, cookieFor(platformId)),
      { error: `平台 ${platformId} 取流异常` },
    );
  }

  /**
   * 取歌词。返回 { lrc }。
   * 调用方（api/index.js getLyrics）负责 fallback 链，gateway 只做单次调用。
   */
  async function getLyrics(platformId, id) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.getLyrics !== 'function') return { lrc: '' };
    const lrc = await safeRun(`${platformId}.getLyrics`, () => plugin.getLyrics(id), '');
    return { lrc: typeof lrc === 'string' ? lrc : '' };
  }

  /**
   * 按「歌名 + 歌手」取歌词（部分平台实现的兜底能力）。
   * 返回：LRC 字符串，无能力 / 失败 ⇒ 空串
   */
  async function getLyricsByTitle(platformId, title, artist) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.getLyricsByTitle !== 'function') return '';
    const lrc = await safeRun(
      `${platformId}.getLyricsByTitle`,
      () => plugin.getLyricsByTitle(title, artist),
      '',
    );
    return typeof lrc === 'string' ? lrc : '';
  }

  /**
   * 取单曲详情（链接识别用）。无能力 / 失败 ⇒ null
   */
  async function getSongDetail(platformId, id) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.getSongDetail !== 'function') return null;
    return safeRun(`${platformId}.getSongDetail`, () => plugin.getSongDetail(id, cookieFor(platformId)), null);
  }

  /**
   * 验证平台 Cookie。返回 { valid:boolean, ... }。
   * 无能力 ⇒ { valid:false }（与 api/index.js 原行为一致）
   */
  async function verifyCookie(platformId, cookie) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.verifyCookie !== 'function') return { valid: false };
    return safeRun(`${platformId}.verifyCookie`, () => plugin.verifyCookie(cookie), {
      valid: false,
    });
  }

  // ── 专辑 / 歌手域（原 recommendations.js 的手写分派）────────

  /**
   * 搜索专辑。返回 { albums, total }。
   */
  async function searchAlbum(platformId, keyword, page = 1) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.searchAlbum !== 'function') return EMPTY.albumResult();
    const r = await safeRun(
      `${platformId}.searchAlbum`,
      () => plugin.searchAlbum(keyword, page),
      EMPTY.albumResult(),
    );
    return r && Array.isArray(r.albums) ? r : EMPTY.albumResult();
  }

  /**
   * 取专辑曲目。返回歌曲数组。
   */
  async function getAlbumSongs(platformId, albumMid, limit = 999) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.getAlbumSongs !== 'function') return EMPTY.list();
    const r = await safeRun(
      `${platformId}.getAlbumSongs`,
      () => plugin.getAlbumSongs(albumMid, limit),
      EMPTY.list(),
    );
    return Array.isArray(r) ? r : EMPTY.list();
  }

  /**
   * 搜索歌手。返回 { singers, total, page }。
   * 注意：total 由调用方按合并结果重算，此处只保证形态。
   */
  async function searchSinger(platformId, keyword, page = 1) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.searchSinger !== 'function') return EMPTY.singerResult(page);
    const r = await safeRun(
      `${platformId}.searchSinger`,
      () => plugin.searchSinger(keyword, page),
      EMPTY.singerResult(page),
    );
    if (!r || !Array.isArray(r.singers)) return EMPTY.singerResult(page);
    return { singers: r.singers, total: r.total, page: r.page || page };
  }

  /**
   * 取歌手歌曲。返回歌曲数组。
   */
  async function getSingerSongs(platformId, singerMid, limit = 30) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.getSingerSongs !== 'function') return EMPTY.list();
    const r = await safeRun(
      `${platformId}.getSingerSongs`,
      () => plugin.getSingerSongs(singerMid, limit),
      EMPTY.list(),
    );
    return Array.isArray(r) ? r : EMPTY.list();
  }

  /**
   * 取歌手专辑。返回 { albums, total }。
   */
  async function getSingerAlbums(platformId, singerMid, pageNo = 1, pageSize = 20) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.getSingerAlbums !== 'function') return EMPTY.albumResult();
    const r = await safeRun(
      `${platformId}.getSingerAlbums`,
      () => plugin.getSingerAlbums(singerMid, pageNo, pageSize),
      EMPTY.albumResult(),
    );
    return r && Array.isArray(r.albums) ? r : EMPTY.albumResult();
  }

  /**
   * 取歌单曲目。返回歌曲数组。
   */
  async function getPlaylistSongs(platformId, id, limit = 200) {
    const plugin = pluginOf(platformId);
    if (!plugin || typeof plugin.getPlaylistSongs !== 'function') return EMPTY.list();
    const r = await safeRun(
      `${platformId}.getPlaylistSongs`,
      () => plugin.getPlaylistSongs(id, limit),
      EMPTY.list(),
    );
    return Array.isArray(r) ? r : EMPTY.list();
  }

  // ── 首页推荐域 ────────────────────────────────────────────
  //
  // ⚠️ 这一组方法当前**尚未纳入 manifest 能力推导**：8 个平台里只有
  //    netease / qq / bilibili 实现了它们，且是以"老式具名导出"的形式
  //    （如 neteaseGetTopList）挂在平台模块上，没有映射到 manifest 的
  //    标准方法名（search / getUrl / getLyrics …）。
  //
  //    按 v3 的分层原则，「平台能做什么」应由 manifest 的方法存在性推导。
  //    本组是**过渡实现**：gateway 统一按名字调用 + 统一空值退化，
  //    先消灭消费方（recommendations.js）的平台直连与手写分派；
  //    待后续把这些方法正式纳入 manifest（阶段 1 收尾），
  //    只需把下面的字典改成从 registry 派生即可，消费方无需再改。
  //
  //    空值约定与历史行为一致：推荐类接口失败 / 平台无此能力 ⇒ []。

  /**
   * 推荐域方法名 → 平台模块上的实现名。
   * 键是 gateway 的稳定接口，值是该平台模块的老式导出名。
   */
  const RECOMMEND_METHODS = Object.freeze({
    netease: {
      getTopList: 'neteaseGetTopList',
      getRecommendPlaylists: 'neteaseGetRecommendPlaylists',
    },
    qq: {
      getRecommendPlaylists: 'qqGetRecommendPlaylists',
      getCategoryPlaylists: 'qqGetCategoryPlaylists',
      getTopList: 'qqGetTopList',
      getNewSongs: 'qqGetNewSongs',
      getRadioStations: 'qqGetRadioStations',
      getHotSingers: 'qqGetHotSingers',
    },
    bilibili: {
      getRanking: 'bilibiliGetRanking',
    },
  });

  /**
   * 调用推荐域方法。
   *
   * @param {string} platformId
   * @param {string} method    gateway 标准名（见 RECOMMEND_METHODS 的键）
   * @param {Array}  args      透传给平台实现的参数
   * @param {Object} [opts]
   * @param {boolean} [opts.withCookie=false] 是否把 cookie 作为**末位**参数注入
   *        （B 站排行历史上需要 cookie；网易云/QQ 的推荐接口不需要）
   * @returns {Promise<Array>} 失败 / 无能力 ⇒ []
   */
  async function recommendCall(platformId, method, args = [], opts = {}) {
    const plugin = pluginOf(platformId);
    const implName = RECOMMEND_METHODS[platformId] && RECOMMEND_METHODS[platformId][method];
    if (!plugin || !implName || typeof plugin[implName] !== 'function') {
      logger.warn(`[gateway] ${platformId}.${method}: 平台未实现该推荐能力`);
      return EMPTY.list();
    }
    const finalArgs = opts.withCookie ? [...args, cookieFor(platformId)] : args;
    const r = await safeRun(
      `${platformId}.${method}`,
      () => plugin[implName](...finalArgs),
      EMPTY.list(),
    );
    return Array.isArray(r) ? r : EMPTY.list();
  }

  /** 榜单。netease: (name, limit)；qq: (topId, limit) */
  function getTopList(platformId, a, b) {
    return recommendCall(platformId, 'getTopList', [a, b]);
  }

  /** 个性化推荐歌单。 */
  function getRecommendPlaylists(platformId, limit) {
    return recommendCall(platformId, 'getRecommendPlaylists', [limit]);
  }

  /** 分类歌单。 */
  function getCategoryPlaylists(platformId, categoryId, page, limit) {
    return recommendCall(platformId, 'getCategoryPlaylists', [categoryId, page, limit]);
  }

  /** 新歌。 */
  function getNewSongs(platformId, areaId, limit) {
    return recommendCall(platformId, 'getNewSongs', [areaId, limit]);
  }

  /** 电台。 */
  function getRadioStations(platformId, limit) {
    return recommendCall(platformId, 'getRadioStations', [limit]);
  }

  /** 热门歌手。 */
  function getHotSingers(platformId, limit) {
    return recommendCall(platformId, 'getHotSingers', [limit]);
  }

  /** 排行榜（B 站）。历史上需要 cookie，故末位注入。 */
  function getRanking(platformId, limit) {
    return recommendCall(platformId, 'getRanking', [limit], { withCookie: true });
  }

  // ── 跨平台批量 ────────────────────────────────────────────

  /**
   * 在多个平台上并发执行同一能力，按平台顺序返回结果。
   *
   * 用途：searchSinger('all') / 首页分区的跨平台聚合。
   * 语义与既有 Promise.allSettled 写法一致：**失败平台产出空结果，不影响其它平台**。
   *
   * @param {string[]} platformIds
   * @param {(platformId:string) => Promise<*>} fn
   * @returns {Promise<Array<{platform:string, ok:boolean, value:*}>>}
   */
  async function fanOut(platformIds, fn) {
    const ids = Array.isArray(platformIds) ? platformIds : [];
    const settled = await Promise.allSettled(ids.map((id) => fn(id)));
    return settled.map((r, i) => ({
      platform: ids[i],
      ok: r.status === 'fulfilled',
      value: r.status === 'fulfilled' ? r.value : null,
    }));
  }

  /**
   * 筛选出具备指定能力的平台 id。
   * 替代消费方手写的「支持 X 的平台」清单。
   */
  function platformsWith(capability) {
    return registry.getIds().filter((id) => supports(id, capability));
  }

  return Object.freeze({
    // 单平台能力调用
    search,
    getUrl,
    getLyrics,
    getLyricsByTitle,
    getSongDetail,
    verifyCookie,
    searchAlbum,
    getAlbumSongs,
    searchSinger,
    getSingerSongs,
    getSingerAlbums,
    getPlaylistSongs,
    // 首页推荐域
    getTopList,
    getRecommendPlaylists,
    getCategoryPlaylists,
    getNewSongs,
    getRadioStations,
    getHotSingers,
    getRanking,
    // 跨平台
    fanOut,
    // 查询
    supports,
    platformsWith,
  });
}

module.exports = { createPlatformGateway, EMPTY };
