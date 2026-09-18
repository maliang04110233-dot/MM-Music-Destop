/**
 * MusicDL 插件系统 — 平台注册中心（v3 · 单一事实来源）
 *
 * 架构：
 *   1. PluginRegistry   平台注册中心
 *   2. PlatformManifest 平台自描述契约（一个文件 = 一个平台）
 *   3. 自动发现         扫描 platforms/ 目录，校验 manifest 后注册
 *
 * v3 的核心变更：
 *   - 平台文件导出**自描述 manifest**，本模块是平台事实的唯一来源
 *   - 所有下游清单（探针 / 换源候选 / CORS 白名单 / 链接识别 / 聚合条数 / UI）
 *     一律由此**派生**，不再在各处手写副本
 *   - validate() 对不合格 manifest **抛错**（v2 是静默跳过 ⇒ 漏配不报错）
 *
 * 新平台 = 在 platforms/ 新建 1 个文件，无需改动任何其它文件。
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// ── 能力推导表 ────────────────────────────────────────
// capabilities 不写进 manifest，由实现方法是否存在推导 ——
// 避免"声明了 album:true 却没实现 searchAlbum"这类两处不一致。
const CAPABILITY_METHODS = Object.freeze({
  album: 'searchAlbum',
  albumSongs: 'getAlbumSongs',
  singer: 'searchSinger',
  singerSongs: 'getSingerSongs',
  singerAlbums: 'getSingerAlbums',
  lyrics: 'getLyrics',
  lyricsByTitle: 'getLyricsByTitle',
  linkDetail: 'getSongDetail',
  cookie: 'verifyCookie',
  playlistDetail: 'getPlaylistDetail',
  // 歌单 / 推荐域（v3 阶段 1 收尾：由方法存在性推导，
  // 使 gateway 与首页板块可以按能力发现平台，而非硬编码平台清单）
  playlistSongs: 'getPlaylistSongs',
  topList: 'getTopList',
  recommendPlaylists: 'getRecommendPlaylists',
  categoryPlaylists: 'getCategoryPlaylists',
  newSongs: 'getNewSongs',
  radioStations: 'getRadioStations',
  hotSingers: 'getHotSingers',
  ranking: 'getRanking',
});

// ── 策略字段默认值 ────────────────────────────────────
// 策略（能否换源 / 是否探针 / 顺序 / 聚合条数）是**业务规则**，
// 代码里没有可推导依据，必须由 manifest 显式声明。
const POLICY_DEFAULTS = Object.freeze({
  fallbackSource: false, // 参与跨源换源候选
  probeable: false,      // 参与可用性探针
  order: 100,            // 展示与聚合顺序（小者在前）
  aggregateLimit: 5,     // 'all' 聚合搜索时最多取几条
});

const PLATFORMS_DIR = path.join(__dirname, 'platforms');

// ── 标准化插件接口 ──────────────────────────────────────

/**
 * 平台 manifest 契约
 * @typedef {Object} PlatformManifest
 * @property {string} id
 * @property {string} name
 * @property {string} [nameEn]
 * @property {string} [icon]
 * @property {{bg:string,fg:string,border:string}} [badge]
 * @property {{origins:string[], originSuffixes?:string[]}} hosts
 * @property {Array<{type:string, re:RegExp}>} [linkPatterns]
 * @property {Object} policies
 * @property {Function} search
 * @property {Function} getUrl
 */

/**
 * 校验平台 manifest。不合格立即抛错 —— 静默跳过是 v2 最大的隐患来源。
 * @param {PlatformManifest} plugin
 * @param {string} [source] 出错时用于定位（通常传文件名）
 */
function validate(plugin, source) {
  const where = source || (plugin && plugin.id) || '未知平台';

  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`[PluginRegistry] ${where}: 平台模块必须导出一个对象`);
  }
  for (const field of ['id', 'name']) {
    if (typeof plugin[field] !== 'string' || !plugin[field].trim()) {
      throw new Error(`[PluginRegistry] ${where}: manifest 缺少 ${field}`);
    }
  }
  for (const field of ['search', 'getUrl']) {
    if (typeof plugin[field] !== 'function') {
      throw new Error(`[PluginRegistry] ${where}: 缺少必需实现方法 ${field}()`);
    }
  }
  if (!plugin.hosts || !Array.isArray(plugin.hosts.origins)) {
    throw new Error(`[PluginRegistry] ${where}: 缺少 hosts.origins（CORS 白名单由此派生）`);
  }
  // Minor: origins/suffixes 会进 CORS 响应头判定，manifest 写错（带路径、
  // userinfo、通配）不应静默生效——只允许 scheme+裸主机名
  for (const o of plugin.hosts.origins) {
    if (typeof o !== 'string' || !/^https?:\/\/[a-z0-9.-]+$/i.test(o) || o.includes('@')) {
      throw new Error(`[PluginRegistry] ${where}: hosts.origins 含非法项（须为 http(s)://裸主机名）: ${String(o).slice(0, 60)}`);
    }
  }
  if (plugin.hosts.originSuffixes) {
    if (!Array.isArray(plugin.hosts.originSuffixes)) {
      throw new Error(`[PluginRegistry] ${where}: hosts.originSuffixes 必须是数组`);
    }
    for (const s of plugin.hosts.originSuffixes) {
      if (typeof s !== 'string' || !/^\.[a-z0-9.-]+$/i.test(s) || s.includes('@')) {
        throw new Error(`[PluginRegistry] ${where}: hosts.originSuffixes 含非法项（须为 .域名片段）: ${String(s).slice(0, 60)}`);
      }
    }
  }
  if (!plugin.policies || typeof plugin.policies.order !== 'number') {
    throw new Error(
      `[PluginRegistry] ${where}: 缺少 policies.order（数字，决定聚合权重与 UI 顺序；`
      + '不要依赖目录扫描顺序）',
    );
  }
  return true;
}

/**
 * 把推导出的能力与规范化策略挂到插件上。
 * 用 defineProperty + enumerable:false，避免污染 Object.keys(plugin)。
 * @param {PlatformManifest} plugin
 */
function decorate(plugin) {
  const caps = {};
  for (const [key, method] of Object.entries(CAPABILITY_METHODS)) {
    caps[key] = typeof plugin[method] === 'function';
  }
  Object.defineProperty(plugin, '_caps', {
    value: Object.freeze(caps), enumerable: false, configurable: true, writable: false,
  });
  Object.defineProperty(plugin, '_policies', {
    value: Object.freeze({ ...POLICY_DEFAULTS, ...(plugin.policies || {}) }),
    enumerable: false, configurable: true, writable: false,
  });
  return plugin;
}

// ── 插件注册中心 ──────────────────────────────────────

class PluginRegistry {
  constructor() {
    this._plugins = new Map(); // id → plugin
    this._loadOrder = [];     // 加载顺序
  }

  /**
   * 注册插件
   * @param {PlatformManifest} plugin
   */
  register(plugin) {
    validate(plugin);
    if (this._plugins.has(plugin.id)) {
      logger.warn(`[PluginRegistry] Plugin "${plugin.id}" already registered, overwriting`);
    }
    this._plugins.set(plugin.id, decorate(plugin));
    this._loadOrder.push(plugin.id);
    logger.log(`[PluginRegistry] Registered plugin: ${plugin.id} (${plugin.name})`);
  }

  /**
   * 获取插件
   * @param {string} id
   * @returns {PlatformManifest|undefined}
   */
  get(id) {
    return this._plugins.get(id);
  }

  /**
   * 获取所有已注册的插件
   * @returns {PlatformManifest[]}
   */
  getAll() {
    return this._loadOrder.map(id => this._plugins.get(id)).filter(Boolean);
  }

  /**
   * 获取所有插件 ID
   * @returns {string[]}
   */
  getIds() {
    return [...this._loadOrder];
  }

  /**
   * 获取插件数量
   * @returns {number}
   */
  get size() {
    return this._plugins.size;
  }

  /**
   * 检查插件是否已注册
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this._plugins.has(id);
  }

  /**
   * 获取插件的搜索方法（带错误处理）
   * @param {string} id
   * @returns {Function|null}
   */
  getSearchFn(id) {
    const plugin = this._plugins.get(id);
    return plugin?.search || null;
  }

  /**
   * 获取插件的 URL 获取方法（带错误处理）
   * @param {string} id
   * @returns {Function|null}
   */
  getGetUrlFn(id) {
    const plugin = this._plugins.get(id);
    return plugin?.getUrl || null;
  }

  // ── 派生查询（v3：下游清单的唯一出口）──────────────────

  /**
   * 由方法存在性推导出的能力表
   * @param {string} id
   * @returns {Object|undefined}
   */
  getCapabilities(id) {
    return this._plugins.get(id)?._caps;
  }

  /**
   * 参与跨源换源的源 id（策略声明，非推导）
   * @returns {string[]}
   */
  getFallbackSources() {
    return this.getIds().filter(id => this._plugins.get(id)?._policies.fallbackSource === true);
  }

  /**
   * 参与可用性探针的源 id
   * @returns {string[]}
   */
  getProbeSources() {
    return this.getIds().filter(id => this._plugins.get(id)?._policies.probeable === true);
  }

  /**
   * 汇总所有平台的链接识别模式，供 utils/linkParser 使用
   * ⚠️ extract 必须一并带出 —— parseMusicLink 靠它从匹配结果里取 id
   * @returns {Array<{platform:string, type:string, re:RegExp, extract:(m:RegExpMatchArray)=>string}>}
   */
  getLinkPatterns() {
    const out = [];
    for (const plugin of this.getAll()) {
      for (const lp of plugin.linkPatterns || []) {
        out.push({ platform: plugin.id, type: lp.type, re: lp.re, extract: lp.extract });
      }
    }
    return out;
  }

  /**
   * CORS 白名单（平台域名 + 动态 CDN 后缀）
   * ⚠️ 这是本工程唯一的安全边界，派生结果必须与历史枚举逐条相等。
   * @returns {{origins:Set<string>, suffixes:Set<string>}}
   */
  getAllowedOrigins() {
    const origins = new Set();
    const suffixes = new Set();
    for (const plugin of this.getAll()) {
      const hosts = plugin.hosts || {};
      for (const o of hosts.origins || []) origins.add(o);
      for (const s of hosts.originSuffixes || []) suffixes.add(s);
    }
    return { origins, suffixes };
  }

  /**
   * 序列化给渲染层（剔除函数，只留展示与能力）
   * @returns {Array<Object>}
   */
  toClientPayload() {
    return this.getAll().map(plugin => ({
      id: plugin.id,
      name: plugin.name,
      nameEn: plugin.nameEn || plugin.name,
      icon: plugin.icon || '',
      badge: plugin.badge || null,
      capabilities: plugin._caps,
      policies: plugin._policies,
    }));
  }

  /** 清空（仅供测试） */
  clear() {
    this._plugins.clear();
    this._loadOrder = [];
  }
}

// ── 插件加载器 ──────────────────────────────────────

let _loaded = false;

/**
 * 幂等加载 platforms/ 目录下的全部平台 manifest。
 *
 * 同步实现：CommonJS 模块顶层无法 await，且 readdirSync / require 本就是同步的。
 * 顺序显式取自 policies.order —— 它影响聚合权重与 UI 排序，
 * 不能依赖 readdir 的返回顺序（文件系统相关，不可移植）。
 *
 * @param {PluginRegistry} [registry]
 * @returns {PluginRegistry}
 */
function loadPlatformPlugins(registry = defaultRegistry) {
  if (_loaded) return registry;
  _loaded = true;

  let files;
  try {
    files = fs.readdirSync(PLATFORMS_DIR).filter(f => f.endsWith('.js') && f !== 'index.js');
  } catch (e) {
    throw new Error(`[PluginRegistry] 无法读取平台目录 ${PLATFORMS_DIR}: ${e.message}`);
  }

  const manifests = [];
  for (const file of files) {
    const mod = require(path.join(PLATFORMS_DIR, file));
    validate(mod, file);
    manifests.push(mod);
  }

  manifests.sort((a, b) => {
    const diff = a.policies.order - b.policies.order;
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  for (const manifest of manifests) registry.register(manifest);
  logger.log(`[PluginRegistry] 自动发现完成，共 ${registry.size} 个平台: ${registry.getIds().join(', ')}`);
  return registry;
}

/** 重置加载态（仅供测试：require 缓存仍在，重新加载拿到的是同一批对象） */
function _resetForTest() {
  _loaded = false;
  defaultRegistry.clear();
}

// ── 创建默认注册中心 ──────────────────────────────────────

const defaultRegistry = new PluginRegistry();

// ── 导出 ──────────────────────────────────────────────

module.exports = {
  PluginRegistry,
  loadPlatformPlugins,
  validate,
  CAPABILITY_METHODS,
  POLICY_DEFAULTS,
  PLATFORMS_DIR,
  defaultRegistry,
  _resetForTest,
};
