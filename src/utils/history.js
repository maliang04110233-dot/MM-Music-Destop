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
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

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
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw.trim()) return [];
    const arr = JSON.parse(raw);
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
    fs.writeFileSync(fp, JSON.stringify(_cache, null, 2), 'utf8');
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
 * 清理
 */
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
  init, add, query, stats, flush, clear, destroy,
  MAX_ENTRIES,
};
