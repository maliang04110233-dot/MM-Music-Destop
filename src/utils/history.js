/**
 * 下载历史持久化
 *
 * 存储路径：userData/history.json
 * 数据结构：[{ id, source, title, artist, album, savePath, ext, quality,
 *             size, duration, status: 'done'|'error', error?, finishedAt }]
 *
 * 设计要点：
 *   - 防抖写盘（避免每完成一首就 IO）
 *   - 上限 5000 条，超出时按时间淘汰最旧
 *   - 内存缓存（不每次都读盘）
 *
 * 关于同步 IO（有意保留的例外，勿当作遗漏）：
 *   磁盘访问只有两处——init 时加载一次、防抖到点后原子写一次（2s 窗口合并）。
 *   add() 走内存 + 防抖，不直接落盘。异步化需要把 add/flush 全部改成 Promise
 *   并改动主进程下载流程，收益有限；真正的 IO 频次已由防抖控制。
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { atomicWriteJson, safeReadJson } = require('./atomicFile');

const MAX_ENTRIES = 5000;
const WRITE_DEBOUNCE_MS = 2000;

let _userDataPath = null;
let _cache = null;          // 内存里的历史数组
let _writeTimer = null;

function init(userDataPath) {
  _userDataPath = userDataPath;
  _cache = _load();
}

function _getFilePath() {
  if (!_userDataPath) return null;
  return path.join(_userDataPath, 'history.json');
}

function _load() {
  try {
    const fp = _getFilePath();
    if (!fp || !fs.existsSync(fp)) return [];
    const res = safeReadJson(fp);
    if (!res.ok) {
      // 损坏文件已备份为 history.json.bak，等下次写入覆盖
      logger.warn('[history] 文件损坏，已备份为 .bak，从空历史开始');
      return [];
    }
    if (res.empty) return [];
    const arr = res.data;
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch (e) {
    logger.warn('[history] 加载失败:', e.message);
    return [];
  }
}

function _scheduleWrite() {
  if (_writeTimer) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(_flushNow, WRITE_DEBOUNCE_MS);
}

function _flushNow() {
  _writeTimer = null;
  try {
    const fp = _getFilePath();
    if (!fp) return;
    atomicWriteJson(fp, _cache);
  } catch (e) {
    logger.warn('[history] 写入失败:', e.message);
  }
}

function flush() {
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  _flushNow();
}

/**
 * 添加一条历史记录
 * @param {Object} entry - 历史记录对象
 */
function add(entry) {
  if (!_cache) _cache = _load();
  // 防止重复：同 id 出现就更新
  const existingIdx = _cache.findIndex(e => e.id === entry.id && e.source === entry.source);
  if (existingIdx >= 0) {
    _cache[existingIdx] = { ..._cache[existingIdx], ...entry };
  } else {
    _cache.unshift(entry);
  }
  // 上限淘汰
  if (_cache.length > MAX_ENTRIES) {
    _cache.length = MAX_ENTRIES;
  }
  _scheduleWrite();
}

/**
 * 查询某首歌是否已成功下载过（跨会话去重用，参考 streamrip 的去重数据库）
 *
 * 判定条件：status === 'done' 且 savePath 指向的文件仍存在于磁盘。
 * 文件已被用户删除/移动的历史记录不算重复——用户重下大概率是故意的（找回文件）。
 *
 * @param {string} id    歌曲 id（内部统一转 String 比较，避免数字/字符串类型不一致漏判）
 * @param {string} source 平台源
 * @returns {Object|null} 命中的历史条目，未命中返回 null
 */
function findDownloaded(id, source) {
  if (!_cache) _cache = _load();
  if (id == null || id === '' || !source) return null;
  const sid = String(id);
  return _cache.find(e =>
    e && e.status === 'done' &&
    e.source === source &&
    String(e.id) === sid &&
    e.savePath && fs.existsSync(e.savePath)
  ) || null;
}

/**
 * 查询历史
 * @param {Object} opts - { limit, offset, source, status, keyword }
 */
function query(opts = {}) {
  if (!_cache) _cache = _load();
  const { limit = 50, offset = 0, source, status, keyword } = opts;
  let arr = _cache;
  if (source) arr = arr.filter(e => e.source === source);
  if (status) arr = arr.filter(e => e.status === status);
  if (keyword) {
    const kw = keyword.toLowerCase();
    arr = arr.filter(e =>
      (e.title || '').toLowerCase().includes(kw) ||
      (e.artist || '').toLowerCase().includes(kw) ||
      (e.album || '').toLowerCase().includes(kw)
    );
  }
  const total = arr.length;
  const items = arr.slice(offset, offset + limit);
  return { items, total };
}

/**
 * 统计
 */
function stats() {
  if (!_cache) _cache = _load();
  const total = _cache.length;
  const done = _cache.filter(e => e.status === 'done').length;
  const error = _cache.filter(e => e.status === 'error').length;
  const totalSize = _cache
    .filter(e => e.status === 'done')
    .reduce((s, e) => s + (e.size || 0), 0);
  const bySource = {};
  for (const e of _cache) {
    if (!bySource[e.source]) bySource[e.source] = { done: 0, error: 0 };
    bySource[e.source][e.status] = (bySource[e.source][e.status] || 0) + 1;
  }
  return { total, done, error, totalSize, bySource };
}

/**
 * 导入历史（备份恢复用）：合并去重后落盘
 * @param {Array} entries - 备份文件里的历史数组
 * @returns {number} 实际导入条数
 */
function importEntries(entries) {
  if (!_cache) _cache = _load();
  if (!Array.isArray(entries)) return 0;
  const valid = entries.filter(e => e && typeof e === 'object' && (e.id || e.title));
  let added = 0;
  for (const e of valid) {
    const idx = _cache.findIndex(c => c.id === e.id && c.source === e.source);
    if (idx >= 0) {
      _cache[idx] = { ..._cache[idx], ...e };
    } else {
      _cache.push(e);
      added++;
    }
  }
  if (_cache.length > MAX_ENTRIES) _cache.length = MAX_ENTRIES;
  _scheduleWrite();
  return added;
}

function clear() {
  _cache = [];
  _scheduleWrite();
}

function destroy() {
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  _cache = null;
  _userDataPath = null;
}

module.exports = {
  init, add, query, stats, flush, clear, destroy, importEntries, findDownloaded,
  MAX_ENTRIES,
};
