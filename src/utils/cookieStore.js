/**
 * Cookie 持久化存储
 * 用 electron app.getPath('userData') 存 JSON 文件，不依赖 electron-store 额外依赖
 *
 * 设计要点（P2-A 2026-06-11 修复）：
 * - 内存缓存：首次 loadAll 后缓存 JSON 对象，后续 get() 不再读盘
 * - set() 同时更新缓存和磁盘（避免下次 get 拿到旧值）
 * - clear() 语义不变；saveAll() 兼容外部直接调用
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

let _userDataPath = null;
// 内存缓存：null = 未加载；Object = 已加载
let _cache = null;

function init(userDataPath) {
  _userDataPath = userDataPath;
  // userData 路径变更（理论上不会发生，但保证健壮性）→ 失效缓存
  _cache = null;
}

function getFilePath() {
  if (!_userDataPath) return null;
  return path.join(_userDataPath, 'cookies.json');
}

/**
 * 从磁盘加载一次（仅在 _cache === null 时执行）
 * 失败/缺失/解析错误一律返回空对象
 */
function _ensureLoaded() {
  if (_cache !== null) return;
  try {
    const fp = getFilePath();
    if (!fp || !fs.existsSync(fp)) {
      _cache = {};
      return;
    }
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw.trim()) {
      _cache = {};
      return;
    }
    const parsed = JSON.parse(raw);
    // 防御：必须是普通对象（攻击者/旧版本写入数组等异常结构）
    _cache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    logger.warn('[cookieStore] 加载失败，使用空对象:', e.message);
    _cache = {};
  }
}

/**
 * 获取全量 Cookie 对象（O(1)，命中内存缓存）
 */
function loadAll() {
  _ensureLoaded();
  // 返回浅拷贝防止外部 mutate 内部缓存
  return { ..._cache };
}

/**
 * 获取单个平台的 Cookie（O(1) 内存查找）
 */
function get(platform) {
  _ensureLoaded();
  return _cache[platform] || '';
}

/**
 * 保存单个平台的 Cookie
 * 空字符串视为删除（避免保存空 Cookie 占位）
 */
function set(platform, cookie) {
  _ensureLoaded();
  if (cookie) {
    _cache[platform] = cookie;
  } else {
    delete _cache[platform];
  }
  // 同步写盘
  try {
    const fp = getFilePath();
    if (!fp) return false;
    fs.writeFileSync(fp, JSON.stringify(_cache, null, 2), 'utf8');
    return true;
  } catch (e) {
    logger.warn('[cookieStore] 写入失败:', e.message);
    return false;
  }
}

function getAll() {
  return loadAll();
}

function clear(platform) {
  return set(platform, '');
}

/**
 * 强制从磁盘重载（用于测试/外部修改文件场景）
 */
function reload() {
  _cache = null;
}

module.exports = { init, get, set, getAll, clear, reload };