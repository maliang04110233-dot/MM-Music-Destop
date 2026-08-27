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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
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

module.exports = request;
