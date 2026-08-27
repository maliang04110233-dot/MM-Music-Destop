/**
 * 在线播放临时文件缓存
 *
 * 用于 proxy-play IPC：把跨域音频流先下载到 userData/play_cache/，
 * 再用 file:// 协议喂给 audio 元素（绕过 CORS）
 *
 * 设计要点：
 *   - LRU 上限 50 个
 *   - TTL 30 分钟（陈旧文件定期 GC）
 *   - 文件名用 md5(URL) 避免 slice(60) 碰撞
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

const PLAY_CACHE = new Map();     // url -> { filePath, expireAt }
const PLAY_CACHE_TTL = 30 * 60 * 1000;
const PLAY_CACHE_MAX = 50;
const PLAY_CACHE_GC_INTERVAL = 10 * 60 * 1000;
let playCacheDir = null;          // 懒初始化

function getPlayCacheDir(userDataPath) {
  if (!playCacheDir) {
    playCacheDir = path.join(userDataPath, 'play_cache');
    if (!fs.existsSync(playCacheDir)) fs.mkdirSync(playCacheDir, { recursive: true });
  }
  return playCacheDir;
}

function safeUnlink(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); }
  catch (e) { logger.warn('删除文件失败:', p, e.message); }
}

function cleanupExpired() {
  const now = Date.now();
  // 修复 B20：只清理 mtime 早于 expireAt 至少 60s 的过期项，避免播放过程中误删
  for (const [url, info] of PLAY_CACHE.entries()) {
    if (info.expireAt <= now) {
      try {
        const stat = fs.statSync(info.filePath);
        if (now - stat.mtimeMs >= 60 * 1000) {
          safeUnlink(info.filePath);
          PLAY_CACHE.delete(url);
        }
      } catch {
        // 文件已不存在，直接从缓存移除
        PLAY_CACHE.delete(url);
      }
    }
  }
  if (PLAY_CACHE.size > PLAY_CACHE_MAX) {
    const toRemove = PLAY_CACHE.size - PLAY_CACHE_MAX;
    let removed = 0;
    for (const [url, info] of PLAY_CACHE) {
      if (removed >= toRemove) break;
      safeUnlink(info.filePath);
      PLAY_CACHE.delete(url);
      removed++;
    }
  }
}

function cleanupStaleFiles(userDataPath) {
  const dir = getPlayCacheDir(userDataPath);
  const now = Date.now();
  try {
    const files = fs.readdirSync(dir);
    for (const fn of files) {
      const fp = path.join(dir, fn);
      try {
        const stat = fs.statSync(fp);
        // 修复 B20：使用 mtimeMs > 2*TTL 才清理（保守策略，避开活跃会话）
        if (now - stat.mtimeMs > 2 * PLAY_CACHE_TTL) safeUnlink(fp);
      } catch (_e) { /* 文件可能已被删除 */ }
    }
  } catch (e) {
    logger.warn('扫描 play_cache 失败:', e.message);
  }
}

function makeKey(url) {
  return 'play_' + crypto.createHash('md5').update(url).digest('hex') + '.mp3';
}

/**
 * HTTP GET → 写入文件（带 30s 超时和重定向）
 * 修复 B22：跨域重定向时，根据新 URL 的 host 是否仍属 referer 同站决定保留 referer
 */
function proxyDownloadOnce(targetUrl, referer, filePath, maxRedirects = 5) {
  return new Promise((resolve) => {
    if (maxRedirects <= 0) return resolve({ error: 'too many redirects' });
    const lib = targetUrl.startsWith('https') ? require('https') : require('http');
    const req = lib.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'Referer': referer || '',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, targetUrl).toString();
        // 修复 B22：跨域重定向时清空 referer（同站则保留）
        let nextReferer = referer;
        try {
          const nextHost = new URL(next).host;
          const refHost = referer ? new URL(referer).host : '';
          if (refHost && nextHost !== refHost) nextReferer = '';
        } catch (_e) { /* URL 解析失败保持原 referer */ }
        return resolve(proxyDownloadOnce(next, nextReferer, filePath, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        return resolve({ error: 'HTTP ' + res.statusCode });
      }
      const file = fs.createWriteStream(filePath);
      res.pipe(file);
      res.on('error', (e) => { file.destroy(); safeUnlink(filePath); resolve({ error: e.message }); });
      file.on('finish', () => file.close(() => resolve({ ok: true })));
      file.on('error', (e) => { safeUnlink(filePath); resolve({ error: e.message }); });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

/**
 * 公开 API：下载一个 URL 到 play_cache，返回 file:// 协议 URL
 * @param {string} url
 * @param {string} referer
 * @param {string} userDataPath - app.getPath('userData')
 * @returns {Promise<{fileUrl?:string, error?:string, cached?:boolean}>}
 */
async function proxyPlay(url, referer, userDataPath) {
  if (!url) return { error: 'no url' };

  const dir = getPlayCacheDir(userDataPath);

  const cached = PLAY_CACHE.get(url);
  if (cached && cached.expireAt > Date.now() && fs.existsSync(cached.filePath)) {
    return { fileUrl: 'file://' + cached.filePath.replace(/\\/g, '/'), cached: true };
  }
  if (cached) { safeUnlink(cached.filePath); PLAY_CACHE.delete(url); }

  const filePath = path.join(dir, makeKey(url));
  const result = await proxyDownloadOnce(url, referer, filePath);
  if (result.error) return { error: result.error };
  PLAY_CACHE.set(url, { filePath, expireAt: Date.now() + PLAY_CACHE_TTL });

  if (PLAY_CACHE.size > PLAY_CACHE_MAX) cleanupExpired();

  return { fileUrl: 'file://' + filePath.replace(/\\/g, '/') };
}

/**
 * 计算缓存大小（字节）
 */
function getCacheSize(userDataPath) {
  const dir = getPlayCacheDir(userDataPath);
  let total = 0;
  try {
    const files = fs.readdirSync(dir);
    for (const fn of files) {
      try { total += fs.statSync(path.join(dir, fn)).size; } catch (_e) { /* 跳过不可读文件 */ }
    }
  } catch (_e) { /* 目录不存在 */ }
  return total;
}

/**
 * 清空所有缓存
 */
function clearAllCache(userDataPath) {
  const dir = getPlayCacheDir(userDataPath);
  try {
    const files = fs.readdirSync(dir);
    for (const fn of files) safeUnlink(path.join(dir, fn));
  } catch (_e) { /* 目录可能不存在 */ }
  PLAY_CACHE.clear();
}

function formatCacheSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let s = bytes, u = 0;
  while (s >= 1024 && u < units.length - 1) { s /= 1024; u++; }
  return s.toFixed(1) + ' ' + units[u];
}

module.exports = {
  proxyPlay,
  cleanupExpired,
  cleanupStaleFiles,
  getCacheSize,
  clearAllCache,
  formatCacheSize,
  PLAY_CACHE_TTL,
  PLAY_CACHE_GC_INTERVAL,
};
