/**
 * 通用 HTTP 请求函数（带重试 + 指数退避）
 *
 * 设计要点：
 *   - 统一超时（默认 15s，可按场景覆盖）
 *   - 自动跟随重定向（最多 5 次）
 *   - GET / POST 都支持
 *   - 默认对 网络错误 / 5xx / 429 重试 2 次（指数退避 200ms → 600ms → 1800ms）
 *   - 4xx 客户端错误不重试（重试也白搭，3xx 已经在内部重定向处理）
 *
 * 不引入 axios/undici —— 项目里没有原生模块依赖，少装一个包就少一个供应链面。
 *
 * @typedef {Object} RequestOptions
 * @property {string} [method]   - 默认 GET
 * @property {Object} [headers]
 * @property {string|Buffer} [body]
 * @property {number} [timeout]  - 单次请求超时 ms，默认 15000
 * @property {number} [retries]  - 重试次数，默认 2
 * @property {number} [retryDelay] - 第一次重试延迟 ms，默认 200（之后 ×3 指数）
 */

const https = require('https');
const http = require('http');
const logger = require('../utils/logger');
const { USER_AGENT } = require('../utils/userAgent');

/** 网络层错误 / 超时 → 值得重试 */
function isRetriableError(err) {
  if (!err) return false;
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'EAI_AGAIN' || err.code === 'ECONNREFUSED') return true;
  if (err.message && /timeout|ECONNREFUSED|ECONNRESET|socket hang up|aborted/i.test(err.message)) return true;
  return false;
}

/** HTTP 5xx / 429 → 值得重试 */
function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/** 跟着 3xx 重定向（最多 5 次，防止无限递归） */
const MAX_REDIRECTS = 5;
function _followRedirects(url, options, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      return reject(new Error(`重定向次数超过上限 ${MAX_REDIRECTS}`));
    }
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (e) { return reject(new Error('invalid url: ' + url)); }
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...options.headers,
      },
      timeout: options.timeout || 15000,
    };

    const req = lib.request(reqOptions, (res) => {
      // 跟随重定向（递归时也走本函数，外层 retry 不重做这次内部重定向）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return _followRedirects(next, options, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (isRetriableStatus(res.statusCode)) {
          // 5xx / 429 → 伪装成错误让外层 retry 捕获
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          err.responseBody = data;
          return reject(err);
        }
        // 4xx / 3xx（已重定向完）/ 2xx → resolve，调用方按业务判断
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * 公开 API：带重试的请求
 *
 * @param {string} url
 * @param {RequestOptions} options
 * @returns {Promise<{status, data}|string|object>} 默认返回 {status, data} 对象
 *                                            （保持向后兼容，原代码按 JSON 解析结果取用）
 */
async function request(url, options = {}) {
  const maxRetries = options.retries ?? 2;
  const baseDelay  = options.retryDelay ?? 200;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await _followRedirects(url, options);
      // 向后兼容：原 request() 直接返回解析后的 JSON/字符串
      if (result && typeof result === 'object' && 'data' in result && 'status' in result) {
        return result.data;
      }
      return result;
    } catch (err) {
      lastErr = err;
      const isRetriable = isRetriableError(err) || isRetriableStatus(err.statusCode);
      if (!isRetriable || attempt === maxRetries) {
        throw err;
      }
      // 指数退避：200ms → 600ms → 1800ms
      const delay = baseDelay * Math.pow(3, attempt);
      const reason = err.statusCode ? `HTTP ${err.statusCode}` : err.message;
      logger.warn(`[request] ${url} 失败 (尝试 ${attempt + 1}/${maxRetries + 1})，${delay}ms 后重试: ${reason}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  // 不会到这里
  throw lastErr;
}

// ── 音频直链预检 ────────────────────────────────────────────
// 用途：平台给出直链后先探一次，坏链可及早触发换源（getDownloadUrlSmart），
// 而不是把坏链交给下载器/播放器才失败。
//
// 关键约束：绝不在内存里累积音频体。
//   - 先 HEAD；CDN 不支持 HEAD（403/405/501）时退化为 GET + Range: bytes=0-1
//   - 收到响应头立即 destroy()，最多只读 1 字节（服务器忽略 Range 返回整体也安全）
const MAX_PROBE_REDIRECTS = 5;

/** 从响应头取音频体积：优先 content-range 的总长（Range 请求），否则 content-length */
function _sizeFromHeaders(h) {
  const cr = h['content-range'];
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(String(cr));
    if (m) return parseInt(m[1], 10);
  }
  const cl = h['content-length'];
  return cl ? parseInt(cl, 10) : null;
}

/** 由 content-type 推断扩展名，缺失时回落到 URL 后缀，默认 mp3（酷我主路径即 mp3） */
function _extFromMeta(contentType, url) {
  const c = String(contentType || '').toLowerCase();
  if (/flac/.test(c)) return 'flac';
  if (/mp4|m4a|aac/.test(c)) return 'm4a';
  if (/ogg|opus/.test(c)) return 'ogg';
  if (/wav|wave/.test(c)) return 'wav';
  if (/mpeg|mp3/.test(c)) return 'mp3';
  const m = /\.(mp3|flac|m4a|aac|ogg|wav)(?:$|[?#])/i.exec(String(url));
  return m ? m[1].toLowerCase() : 'mp3';
}

/**
 * 单次探测（never reject，失败也 resolve 成 { ok:false } 形态给上层判断）
 * @returns {Promise<{status:number|null, contentType?:string, sizeBytes?:number|null, reason?:string}>}
 */
function _probeAudio(url, method, headers, timeout, redirectLeft) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); }
    catch { return resolve({ status: null, reason: 'invalid-url' }); }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout,
    }, (res) => {
      const status = res.statusCode || 0;

      // 直链常 302 到 CDN，跟到底（手动跟，避免 request() 的 body 累积）
      if (status >= 300 && status < 400 && res.headers.location && redirectLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(_probeAudio(next, method, headers, timeout, redirectLeft - 1));
      }

      const out = {
        status,
        contentType: res.headers['content-type'] || '',
        sizeBytes: _sizeFromHeaders(res.headers),
      };
      res.destroy(); // 只要头，不读 body
      resolve(out);
    });

    req.on('error', (e) => resolve({ status: null, reason: e.message || 'error' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: null, reason: 'timeout' }); });
    req.end();
  });
}

/**
 * 音频直链可用性预检
 *
 * @param {string} url
 * @param {{headers?: Object, timeout?: number}} [opts]
 * @returns {Promise<{ok:boolean, status?:number|null, contentType?:string, sizeBytes?:number|null, ext?:string, reason?:string}>}
 */
async function testAudioLink(url, opts = {}) {
  if (!url || typeof url !== 'string') return { ok: false, status: null, reason: 'empty-url' };

  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    ...(opts.headers || {}),
  };
  const timeout = opts.timeout || 8000;

  let r = await _probeAudio(url, 'HEAD', headers, timeout, MAX_PROBE_REDIRECTS);
  if (!r.status || r.status === 403 || r.status === 405 || r.status === 501) {
    r = await _probeAudio(url, 'GET', { ...headers, Range: 'bytes=0-1' }, timeout, MAX_PROBE_REDIRECTS);
  }

  const status = r.status;
  if (status !== 200 && status !== 206) {
    return { ok: false, status: status || null, reason: r.reason || `HTTP ${status}` };
  }

  const ct = String(r.contentType || '').toLowerCase();
  // 无版权曲常返回 text/plain 的 "refuse request!"（酷我 antiserver 即如此）
  if (/^text\//.test(ct)) {
    return { ok: false, status, contentType: ct, reason: 'not-audio' };
  }

  return {
    ok: true,
    status,
    contentType: ct,
    sizeBytes: r.sizeBytes,
    ext: _extFromMeta(ct, url),
  };
}

module.exports = request;
// 挂在 request 函数上（module.exports 保持函数本身，不破坏既有 `request(...)` 调用）
module.exports.testAudioLink = testAudioLink;
