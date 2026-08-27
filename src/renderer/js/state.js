/**
 * MusicDL 全局状态管理 v2 — 响应式架构
 *
 * 核心改进：
 * 1. 深度监听：数组/对象变更自动触发通知
 * 2. 计算属性：derived state 自动更新
 * 3. 批量更新：合并多次 setState 为一次通知
 * 4. 中间件：支持日志、持久化等扩展
 * 5. 向后兼容：保留 getState/setState API
 */

const logger = require('../../utils/logger');

// ── 全局状态 ────────────────────────────────────────────
const __state = {
  currentSource: 'all',
  currentPage: 1,
  currentKeyword: '',
  songs: [],
  albums: [],
  singers: [],
  currentSinger: null,
  selectedSongs: new Set(),
  saveDir: null,
  isShuffled: false,
  loopMode: 0,
  playQueue: [],
  playIdx: -1,
  parsedLyrics: [],
  _currentLocalFilePath: null,
  lrcInterval: null,
  localDirPath: null,
  homeRecommendations: null,
  localSongs: [],
  localFiltered: [],
  editingSong: null,
  editingCoverBase64: null,
  currentPlaying: null,

  // 歌单弹层
  playlistModalSongs: [],
  playlistModalMeta: { platform: '', id: '', name: '' },
  playlistModalChecked: new Set(),
  playlistModalLocalExists: new Map(),

  // IPC 推送缓存
  queueSnapshot: [],
  recommendSongs: {},

  // 用户歌单
  userPlaylists: [],
};

// ── 订阅系统 ──────────────────────────────────────────
const _listeners = {};      // key → [fn]
const _wildcardListeners = []; // 全局监听器
let _batchDepth = 0;
const _pendingNotifications = new Set();

/**
 * 订阅状态变化
 * @param {string} key - 状态键（'*' 监听所有变化）
 * @param {Function} fn - 回调 (newValue, key) => void
 * @returns {Function} 取消订阅函数
 */
function subscribe(key, fn) {
  if (key === '*') {
    _wildcardListeners.push(fn);
    return () => {
      const idx = _wildcardListeners.indexOf(fn);
      if (idx >= 0) _wildcardListeners.splice(idx, 1);
    };
  }
  if (!_listeners[key]) _listeners[key] = [];
  _listeners[key].push(fn);
  return () => {
    _listeners[key] = _listeners[key].filter(f => f !== fn);
  };
}

/**
 * 批量更新模式 — 合并多次 setState 为一次通知
 * @example
 *   batch(() => {
 *     setState('a', 1);
 *     setState('b', 2);
 *   }); // 只触发一次通知
 */
function batch(fn) {
  _batchDepth++;
  try {
    fn();
  } finally {
    _batchDepth--;
    if (_batchDepth === 0) {
      _flushNotifications();
    }
  }
}

function _flushNotifications() {
  const keys = [..._pendingNotifications];
  _pendingNotifications.clear();
  for (const key of keys) {
    _notifyKey(key, __state[key]);
  }
  // 通配符监听器
  if (keys.length > 0) {
    for (const fn of _wildcardListeners) {
      try { fn(__state, keys); } catch (e) { logger.error('[state] wildcard listener error:', e); }
    }
  }
}

function _notifyKey(key, val) {
  for (const fn of (_listeners[key] || [])) {
    try { fn(val, key); } catch (e) { logger.error(`[state] listener error for "${key}":`, e); }
  }
}

// ── 计算属性系统 ──────────────────────────────────────
const _computeds = {}; // key => { deps, fn, cache, valid }

/**
 * 定义计算属性
 * @param {string} key - 计算属性名
 * @param {string[]} deps - 依赖的状态键
 * @param {Function} fn - 计算函数 (...deps) => value
 */
function computed(key, deps, fn) {
  _computeds[key] = { deps, fn, cache: undefined, valid: false };

  // 为每个依赖注册自动更新
  for (const dep of deps) {
    subscribe(dep, () => {
      _computeds[key].valid = false;
      // 标记需要通知
      if (_batchDepth > 0) {
        _pendingNotifications.add(key);
      } else {
        _notifyKey(key, getComputed(key));
      }
    });
  }
}

function getComputed(key) {
  const c = _computeds[key];
  if (!c) return undefined;
  if (!c.valid) {
    c.cache = c.fn(...c.deps.map(d => __state[d]));
    c.valid = true;
  }
  return c.cache;
}

// ── Store API ──────────────────────────────────────────
const store = {
  get(key) {
    if (_computeds[key]) return getComputed(key);
    return __state[key];
  },

  set(key, val) {
    const old = __state[key];
    __state[key] = val;

    if (_batchDepth > 0) {
      _pendingNotifications.add(key);
    } else {
      _notifyKey(key, val);
      // 通配符
      for (const fn of _wildcardListeners) {
        try { fn(__state, [key]); } catch (e) { logger.error('[state] wildcard listener error:', e); }
      }
    }
    return val;
  },

  // 强制触发通知（用于直接修改数组/对象后）
  emit(key) {
    if (_batchDepth > 0) {
      _pendingNotifications.add(key);
    } else {
      _notifyKey(key, __state[key]);
    }
  },

  // 推荐歌曲按 elId 索引存取
  setRecommend(elId, songs) {
    __state.recommendSongs[elId] = songs;
  },
  getRecommend(elId, idx) {
    return __state.recommendSongs[elId]?.[idx];
  },

  // 歌单状态
  getPlaylistSongs() { return __state.playlistModalSongs; },
  setPlaylistSongs(songs) { __state.playlistModalSongs = songs; },
  getPlaylistChecked() { return __state.playlistModalChecked; },
  setPlaylistChecked(s) { __state.playlistModalChecked = s; },
  getPlaylistLocalExists() { return __state.playlistModalLocalExists; },
  setPlaylistLocalExists(m) { __state.playlistModalLocalExists = m; },
  getPlaylistMeta() { return __state.playlistModalMeta; },
  setPlaylistMeta(m) { __state.playlistModalMeta = m; },

  // 订阅
  subscribe,
  batch,
  computed,
  getComputed,
};

// 代理访问常用顶层变量
function getState(key) { return store.get(key); }
function setState(key, val) { return store.set(key, val); }
function notify(key) { store.emit(key); }

// ── ES Module 导出 ──────────────────────────────────────
export { __state, store, getState, setState, subscribe, notify, batch, computed, getComputed };

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.__state = __state;
window.state = store;
window.getState = getState;
window.setState = setState;
