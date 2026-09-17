/**
 * MusicDL 在线封面拉取工具
 *
 * 当本地音频文件没有嵌入封面时，根据歌名+歌手去在线平台搜索封面
 * 降级链：QQ → Kugou（QQ 搜索已修复数 _t 时间戳参数，无 cookie 也能返回结果）
 */

const https = require('https');
const http = require('http');
const logger = require('./logger');

/**
 * 下载图片到 Buffer（支持重定向）
 */
function downloadImageBuffer(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error('empty url'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        return downloadImageBuffer(next, timeout).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('下载超时')); });
  });
}

/**
 * 探测图片 MIME
 */
function detectImageMime(buf) {
  if (buf.length < 4) return 'image/jpeg';
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  // WebP: RIFF...WEBP
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  // GIF: GIF8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  return 'image/jpeg';  // 默认
}

/**
 * 通过 QQ 音乐搜索封面（异步）
 * @param {string} title - 歌曲名
 * @param {string} artist - 歌手（可选）
 * @returns {Promise<{coverBase64: string, mime: string, sourceUrl: string} | null>}
 */
async function fetchCoverFromQQ(title, artist = '') {
  if (!title) return null;
  const keyword = `${title} ${artist || ''}`.trim();

  // 延迟 require + 经 gateway 调用，避免循环依赖且不直连平台模块
  const { searchViaGateway } = require('../api/gatewayAccess');

  let songs;
  try {
    songs = await searchViaGateway('qq', keyword, 1);
  } catch (e) {
    logger.warn('[onlineCover] QQ 搜索失败:', e.message);
    return null;
  }
  if (!songs.length) return null;

  // 优先选一个匹配的（标题+歌手都匹配）
  let picked = songs[0];
  if (artist) {
    const m = songs.find(s => {
      const a = (s.artist || '').toLowerCase();
      return a.includes(artist.toLowerCase());
    });
    if (m) picked = m;
  }
  if (!picked.cover) return null;

  // 下载封面
  try {
    const buf = await downloadImageBuffer(picked.cover);
    const mime = detectImageMime(buf);
    return {
      coverBase64: `data:${mime};base64,${buf.toString('base64')}`,
      mime,
      size: buf.length,
      sourceUrl: picked.cover,
      source: 'qq-online',
    };
  } catch (e) {
    logger.warn('[onlineCover] QQ 封面下载失败:', e.message);
    return null;
  }
}

/**
 * 通过酷狗音乐搜索封面（异步）
 * 酷狗搜索不要求 cookie，封面 URL 可直接下载
 * @param {string} title - 歌曲名
 * @param {string} artist - 歌手（可选）
 * @returns {Promise<{coverBase64: string, mime: string, sourceUrl: string} | null>}
 */
async function fetchCoverFromKugou(title, artist = '') {
  if (!title) return null;
  const keyword = `${title} ${artist || ''}`.trim();

  const { searchViaGateway } = require('../api/gatewayAccess');

  let songs;
  try {
    songs = await searchViaGateway('kugou', keyword, 1);
  } catch (e) {
    logger.warn('[onlineCover] 酷狗搜索失败:', e.message);
    return null;
  }
  if (!songs || !songs.length) return null;

  // 优先选一个歌手匹配的
  let picked = songs[0];
  if (artist) {
    const m = songs.find(s => {
      const a = (s.artist || '').toLowerCase();
      return a.includes(artist.toLowerCase());
    });
    if (m) picked = m;
  }
  if (!picked.cover) return null;

  // 下载封面
  try {
    const buf = await downloadImageBuffer(picked.cover);
    const mime = detectImageMime(buf);
    return {
      coverBase64: `data:${mime};base64,${buf.toString('base64')}`,
      mime,
      size: buf.length,
      sourceUrl: picked.cover,
      source: 'kugou-online',
    };
  } catch (e) {
    logger.warn('[onlineCover] 酷狗封面下载失败:', e.message);
    return null;
  }
}

/**
 * 主入口：根据 title/artist 拉取在线封面
 * 多平台降级链：QQ → Kugou → null
 *   - QQ:    2026 年起需 _t 时间戳参数（已修复），无 cookie 也能返回结果
 *   - Kugou: 部分封面可能返回占位图，作为备用
 */
const _coverCache = new Map();
const COVER_CACHE_MAX = 1000;

function _coverCacheKey(title, artist) {
  return `${String(title || '').toLowerCase()} ${String(artist || '').toLowerCase()}`;
}

async function fetchOnlineCover(title, artist = '') {
  if (!title) return null;
  const cacheKey = _coverCacheKey(title, artist);
  if (_coverCache.has(cacheKey)) return _coverCache.get(cacheKey);

  let result = null;
  try {
    // 1) QQ 音乐（优先，封面字段 albummid 拿到的图更准确）
    const qqResult = await fetchCoverFromQQ(title, artist);
    if (qqResult) result = qqResult;
  } catch (e) {
    logger.warn(`[fetchOnlineCover] QQ error:`, e.message);
  }
  if (!result) {
    try {
      // 2) 酷狗（备用）
      const kugouResult = await fetchCoverFromKugou(title, artist);
      if (kugouResult) result = kugouResult;
    } catch (e) {
      logger.warn(`[fetchOnlineCover] Kugou error:`, e.message);
    }
  }

  if (_coverCache.size >= COVER_CACHE_MAX) _coverCache.clear();
  _coverCache.set(cacheKey, result);
  return result;
}

module.exports = {
  fetchOnlineCover,
  downloadImageBuffer,
  detectImageMime,
};
