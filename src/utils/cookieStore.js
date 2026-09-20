/**
 * Cookie 持久化存储
 * 用 electron app.getPath('userData') 存 JSON 文件，不依赖 electron-store 额外依赖
 *
 * 设计要点（P2-A 2026-06-11 修复）：
 * - 内存缓存：首次 loadAll 后缓存 JSON 对象，后续 get() 不再读盘
 * - set() 同时更新缓存和磁盘（避免下次 get 拿到旧值）
 * - clear() 语义不变；saveAll() 兼容外部直接调用
 *
 * 关于同步 IO（有意保留的例外，勿当作遗漏）：
 *   本模块只在「首次加载」读一次 cookies.json、在 set 时写一次，文件很小，
 *   之后 get() 全程走内存缓存。改成异步会把 get() 变成 Promise，
 *   而 api 层各平台（netease/qq/kugou/kuwo）拼请求头时都要同步取 cookie，
 *   等于要求整个取流链路异步化——收益极小、回归面极大。故保留同步实现。
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const secret = require('./secretStore');

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
    // M4: 历史明文 cookie 首次加载即升级为加密形态并回写
    if (secret.canEncrypt()) {
      let upgraded = false;
      for (const k of Object.keys(_cache)) {
        const v = _cache[k];
        if (typeof v === 'string' && v && !v.startsWith(secret.PREFIX)) {
          _cache[k] = secret.encrypt(v);
          upgraded = true;
        }
      }
      if (upgraded) _persist();
    }
  } catch (e) {
    logger.warn('[cookieStore] 加载失败，使用空对象:', e.message);
    _cache = {};
  }
}

/** 同步写盘（内容已是加密形态）：tmp+rename 原子化，崩溃不留半截 JSON */
function _persist() {
  try {
    const fp = getFilePath();
    if (!fp) return false;
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return true;
  } catch (e) {
    logger.warn('[cookieStore] 写入失败:', e.message);
    return false;
  }
}

/**
 * 获取全量 Cookie 对象（O(1)，命中内存缓存）
 */
function loadAll() {
  _ensureLoaded();
  // 返回浅拷贝防止外部 mutate 内部缓存；密文在此解回明文给调用方
  const out = {};
  for (const k of Object.keys(_cache)) out[k] = secret.decrypt(_cache[k]) || '';
  return out;
}

/**
 * 获取单个平台的 Cookie（O(1) 内存查找）
 */
function get(platform) {
  _ensureLoaded();
  return secret.decrypt(_cache[platform] || '') || '';
}

/**
 * 保存单个平台的 Cookie
 * 空字符串视为删除（避免保存空 Cookie 占位）
 */
function set(platform, cookie) {
  _ensureLoaded();
  if (cookie) {
    _cache[platform] = secret.encrypt(cookie);
  } else {
    delete _cache[platform];
  }
  // 同步写盘（M4：落盘形态为 safeStorage 密文）
  return _persist();
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