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
 *
 * 异步约定（重要）：
 *   本模块全部导出函数都是 async。它跑在主进程（UI 线程），而 GC 会遍历
 *   整个缓存目录做 stat、getCacheSize 也要遍历全部文件——用同步 API 会在
 *   用户点开设置页时把窗口卡住。调用方必须 await（或显式 catch）。
 *   formatCacheSize 是纯计算，仍为同步。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const fsa = require('../utils/fsAsync');

const PLAY_CACHE = new Map();     // url -> { filePath, expireAt }
const _inflightPlays = new Map(); // url -> Promise：同 URL 并发去重，防双流写同一缓存文件
const PLAY_CACHE_TTL = 30 * 60 * 1000;
const PLAY_CACHE_MAX = 50;
const PLAY_CACHE_GC_INTERVAL = 10 * 60 * 1000;
let playCacheDir = null;          // 懒初始化

/**
 * 取（并确保存在）play_cache 目录
 * @param {string} userDataPath
 * @returns {Promise<string>}
 */
async function getPlayCacheDir(userDataPath) {
  if (!playCacheDir) {
    const dir = path.join(userDataPath, 'play_cache');
    // mkdir recursive 幂等：并发首调同时创建也不会报错
    await fsa.ensureDir(dir);
    playCacheDir = dir;
  }
  return playCacheDir;
}

/** 删除文件并吞掉错误（缓存清理属于尽力而为，失败不该影响播放） */
async function safeUnlink(p) {
  try {
    await fsa.removeQuiet(p);
  } catch (e) {
    logger.warn('删除文件失败:', p, e.message);
  }
}

/**
 * 数量超限淘汰的纯选择器：按 mtime 最旧优先，宽限期内（刚写入/正在播放）
 * 的项尽量不动；若必须删且全部在宽限内，则删最旧的（防缓存无限膨胀）。
 * @param {Array<{url: string, mtimeMs: number}>} entries
 * @param {number} now
 * @param {number} max
 * @param {number} graceMs
 * @returns {string[]} 要淘汰的 url 列表
 */
function pickEvictionCandidates(entries, now, max, graceMs) {
  if (!Array.isArray(entries) || entries.length <= max) return [];
  const toRemove = entries.length - max;
  const sorted = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const fresh = [];
  const out = [];
  for (const e of sorted) {
    if (out.length >= toRemove) break;
    if (now - e.mtimeMs < graceMs) { fresh.push(e); continue; }
    out.push(e.url);
  }
  for (const e of fresh) {
    if (out.length >= toRemove) break;
    out.push(e.url);
  }
  return out;
}

/**
 * 清理过期条目
 * @returns {Promise<void>}
 */
async function cleanupExpired() {
  const now = Date.now();
  // 修复 B20：只清理 mtime 早于 expireAt 至少 60s 的过期项，避免播放过程中误删
  for (const [url, info] of PLAY_CACHE.entries()) {
    if (info.expireAt <= now) {
      const stat = await fsa.statOrNull(info.filePath);
      if (!stat) {
        // 文件已不存在，直接从缓存移除
        PLAY_CACHE.delete(url);
      } else if (now - stat.mtimeMs >= 60 * 1000) {
        await safeUnlink(info.filePath);
        PLAY_CACHE.delete(url);
      }
    }
  }
  if (PLAY_CACHE.size > PLAY_CACHE_MAX) {
    const entries = [];
    for (const [url, info] of PLAY_CACHE) {
      const stat = await fsa.statOrNull(info.filePath);
      entries.push({ url, mtimeMs: stat ? stat.mtimeMs : 0 });
    }
    for (const url of pickEvictionCandidates(entries, now, PLAY_CACHE_MAX, 60 * 1000)) {
      const info = PLAY_CACHE.get(url);
      if (info) {
        await safeUnlink(info.filePath);
        PLAY_CACHE.delete(url);
      }
    }
  }
}

/**
 * 清理上次进程遗留的陈旧临时文件
 * @param {string} userDataPath
 * @returns {Promise<void>}
 */
async function cleanupStaleFiles(userDataPath) {
  const dir = await getPlayCacheDir(userDataPath);
  const now = Date.now();

  let entries;
  try {
    entries = await fsa.fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    logger.warn('扫描 play_cache 失败:', e.message);
    return;
  }

  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const fp = path.join(dir, ent.name);
    const stat = await fsa.statOrNull(fp);
    // 修复 B20：使用 mtimeMs > 2*TTL 才清理（保守策略，避开活跃会话）
    if (stat && now - stat.mtimeMs > 2 * PLAY_CACHE_TTL) await safeUnlink(fp);
  }
}

function makeKey(url) {
  return 'play_' + crypto.createHash('md5').update(url).digest('hex') + '.mp3';
}

/**
 * HTTP GET → 写入文件（带 30s 超时和重定向）
 * 修复 B22：跨域重定向时，根据新 URL 的 host 是否仍属 referer 同站决定保留 referer
 * SSRF 修复：每一跳（含重定向目标）都经 urlGuard 校验（协议/userinfo/DNS 全记录
 * 内网 IP 判定），并用 pinned lookup 把连接固定到已校验的 IP（防 DNS rebinding：
 * 校验时解析 A 记录、连接时再解析出内网地址的攻击面闭合）
 */
async function proxyDownloadOnce(targetUrl, referer, filePath, maxRedirects = 5) {
  // playCache 位于 src/main/，urlGuard 位于 src/utils/ —— 编译后同样保持
  // dist/main -> dist/utils 的相对关系（'./urlGuard' 会 Module not found）
  const { assertPublicHttpUrl, makePinnedLookup } = require('../utils/urlGuard');
  const check = await assertPublicHttpUrl(targetUrl);
  if (!check.ok) return { error: `URL 校验失败: ${check.reason}` };
  const u = check.url;
  const lib = u.protocol === 'https:' ? require('https') : require('http');

  return new Promise((resolve) => {
    if (maxRedirects <= 0) return resolve({ error: 'too many redirects' });
    const req = lib.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'Host': u.host, // 连接走校验过的 IP，Host 头保持域名
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'Referer': referer || '',
      },
      lookup: makePinnedLookup(check.ips), // 固定连接 IP，闭合 rebinding
      servername: u.hostname,             // TLS SNI 用域名
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
        // Minor: 不消费的响应体会挂住 socket，drain 掉再返回
        res.resume();
        return resolve({ error: 'HTTP ' + res.statusCode });
      }
      // Minor: 播放缓存加体积上限（200MB），防止恶意/异常超长响应撑爆磁盘
      const MAX_BYTES = 200 * 1024 * 1024;
      const clen = parseInt(res.headers['content-length'] || '0', 10);
      if (clen > MAX_BYTES) {
        res.resume();
        return resolve({ error: '文件过大' });
      }
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
      const file = fs.createWriteStream(filePath);
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_BYTES) {
          res.destroy();
          file.destroy();
          safeUnlink(filePath);
          finish({ error: '下载超出大小上限' });
        }
      });
      res.pipe(file);
      // safeUnlink 内部吞错，此处无需 await
      res.on('error', (e) => { file.destroy(); safeUnlink(filePath); finish({ error: e.message }); });
      file.on('finish', () => file.close(() => finish({ ok: true })));
      file.on('error', (e) => { safeUnlink(filePath); finish({ error: e.message }); });
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

  const dir = await getPlayCacheDir(userDataPath);

  const cached = PLAY_CACHE.get(url);
  if (cached && cached.expireAt > Date.now() && await fsa.exists(cached.filePath)) {
    return { fileUrl: 'file://' + cached.filePath.replace(/\\/g, '/'), cached: true };
  }
  if (cached) { await safeUnlink(cached.filePath); PLAY_CACHE.delete(url); }

  const inflight = _inflightPlays.get(url);
  if (inflight) return inflight;

  const download = (async () => {
    const filePath = path.join(dir, makeKey(url));
    const result = await proxyDownloadOnce(url, referer, filePath);
    if (result.error) return { error: result.error };
    PLAY_CACHE.set(url, { filePath, expireAt: Date.now() + PLAY_CACHE_TTL });

    if (PLAY_CACHE.size > PLAY_CACHE_MAX) await cleanupExpired();

    return { fileUrl: 'file://' + filePath.replace(/\\/g, '/') };
  })();
  _inflightPlays.set(url, download);
  try {
    return await download;
  } finally {
    _inflightPlays.delete(url);
  }
}

/**
 * 计算缓存大小（字节）
 * @param {string} userDataPath
 * @returns {Promise<number>}
 */
async function getCacheSize(userDataPath) {
  const dir = await getPlayCacheDir(userDataPath);

  let entries;
  try {
    entries = await fsa.fsp.readdir(dir, { withFileTypes: true });
  } catch (_e) {
    return 0; // 目录不存在
  }

  let total = 0;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const stat = await fsa.statOrNull(path.join(dir, ent.name));
    if (stat) total += stat.size;
  }
  return total;
}

/**
 * 清空所有缓存
 * @param {string} userDataPath
 * @returns {Promise<void>}
 */
async function clearAllCache(userDataPath) {
  const dir = await getPlayCacheDir(userDataPath);

  let entries;
  try {
    entries = await fsa.fsp.readdir(dir, { withFileTypes: true });
  } catch (_e) {
    entries = []; // 目录可能不存在
  }
  for (const ent of entries) {
    if (ent.isFile()) await safeUnlink(path.join(dir, ent.name));
  }
  PLAY_CACHE.clear();
}

/** 纯计算，同步即可 */
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
  pickEvictionCandidates,
  PLAY_CACHE_TTL,
  PLAY_CACHE_GC_INTERVAL,
};
