/**
 * 用户偏好持久化
 *
 * 存储内容（JSON 文件 userData/prefs.json）：
 *   - saveDir:       下载目录（用户在设置里改过的）
 *   - localDirPath:  本地音乐库目录
 *
 * 与 cookieStore 的区别：
 *   - cookieStore 存的是"登录态"，敏感，不应备份
 *   - prefs 存的是"用户偏好"，可备份，丢失不影响功能
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

let _userDataPath = null;
let _cache = null;        // 内存缓存，避免每次都读盘
let _writeTimer = null;   // 防抖写入

function init(userDataPath) {
  _userDataPath = userDataPath;
  _cache = null;
  _writeTimer = null;
}

function _getFilePath() {
  if (!_userDataPath) return null;
  return path.join(_userDataPath, 'prefs.json');
}

function _load() {
  if (_cache !== null) return _cache;
  try {
    const fp = _getFilePath();
    if (!fp || !fs.existsSync(fp)) { _cache = {}; return _cache; }
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw.trim()) { _cache = {}; return _cache; }
    const parsed = JSON.parse(raw);
    _cache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    logger.warn('prefs: 加载失败，使用空对象:', e.message);
    _cache = {};
  }
  return _cache;
}

function get(key, defaultValue) {
  const data = _load();
  return data[key] !== undefined ? data[key] : defaultValue;
}

function set(key, value) {
  _load();  // 确保 _cache 已初始化
  if (value === undefined || value === null) {
    delete _cache[key];
  } else {
    _cache[key] = value;
  }
  // 防抖 300ms 写盘（避免短时间内多次改）
  if (_writeTimer) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    const fp = _getFilePath();
    if (!fp) return;
    const data = JSON.stringify(_cache, null, 2);
    fs.promises.writeFile(fp, data, 'utf8').catch(e => {
      logger.warn('prefs: 写入失败:', e.message);
    });
  }, 300);
}

function flush() {
  // 立即同步写盘（退出时调用）
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  try {
    const fp = _getFilePath();
    if (!fp) return;
    fs.writeFileSync(fp, JSON.stringify(_cache || {}, null, 2), 'utf8');
  } catch (e) {
    logger.warn('prefs: flush 失败:', e.message);
  }
}

/**
 * 释放资源（测试清理用）
 * 取消挂起的防抖写盘，避免在目录删除后还触发
 */
function destroy() {
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  _cache = null;
  _userDataPath = null;
}

module.exports = { init, get, set, getAll: _load, flush, destroy };
