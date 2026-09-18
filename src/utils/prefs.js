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
 *
 * 关于同步 IO（有意保留的例外，勿当作遗漏）：
 *   prefs 极小且全程内存缓存，只有首次加载读一次盘。关键在于 flush()——
 *   它要在进程退出路径上「立即写完」，此时事件循环可能已不再推进，
 *   await 永远等不到回调。所以这里必须同步。其余主进程 IO 请走 utils/fsAsync。
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const secret = require('./secretStore');
const { atomicWriteJson, safeReadJson } = require('./atomicFile');

// M4: 这些键是凭证级数据（AI 服务计费 key），落盘必须走 safeStorage 加密；
// get 时透明解回明文，解密不可用（换机导入的备份）按未配置处理
const SECRET_KEYS = new Set(['aiMusicApiKey']);

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
    const res = safeReadJson(fp);
    if (!res.ok) {
      // 损坏文件已备份为 prefs.json.bak，此处走空对象等下次写入覆盖
      logger.warn('prefs: 文件损坏，已备份为 .bak，使用空对象');
      _cache = {};
      return _cache;
    }
    if (res.empty) { _cache = {}; return _cache; }
    const parsed = res.data;
    _cache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    logger.warn('prefs: 加载失败，使用空对象:', e.message);
    _cache = {};
  }
  return _cache;
}

function get(key, defaultValue) {
  const data = _load();
  const v = data[key] !== undefined ? data[key] : defaultValue;
  if (SECRET_KEYS.has(key) && typeof v === 'string') return secret.decrypt(v) || '';
  return v;
}

function set(key, value) {
  _load();  // 确保 _cache 已初始化
  if (value === undefined || value === null) {
    delete _cache[key];
  } else {
    _cache[key] = SECRET_KEYS.has(key) && typeof value === 'string' ? secret.encrypt(value) : value;
  }
  // 防抖 300ms 写盘（避免短时间内多次改）
  if (_writeTimer) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    try {
      const fp = _getFilePath();
      if (!fp) return;
      atomicWriteJson(fp, _cache || {});
    } catch (e) {
      logger.warn('prefs: 写入失败:', e.message);
    }
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
    atomicWriteJson(fp, _cache || {});
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
