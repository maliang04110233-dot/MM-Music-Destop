/**
 * WebDAV 快照客户端 — 云同步的传输层
 *
 * 快照 = export-all-data 同构的 JSON 文件，URL 直接指向该文件
 * （如 https://nas/dav/musicdl.json），一次同步 = GET 拉取 + PUT 回写。
 *
 * 并发控制用乐观锁而非 WebDAV LOCK：PUT 带 GET 拿到的 If-Match ETag，
 * 412 表示远端已被其它设备写过 → 上层重拉重并再推一次；服务器不返回
 * ETag 时退化为无条件 PUT（最后写入者赢，与无锁行为一致）。
 *
 * transport 可注入（默认 node http/https），单测全部走假 transport。
 *
 * ── 2026-09 审计 P1 加固 ─────────────────────────────────
 *  1. 响应体上限：原先把响应整段 Buffer.concat 后才解析，恶意/异常服务
 *     只要持续吐字节就能吃光主进程内存（主进程即 UI 线程，等于整机卡死）。
 *  2. 明文凭据门禁：Basic Auth 走 http 时密码是 base64 明文（可被同网段
 *     嗅探）。现在默认拒绝在**非本机** http 上发送凭据，需用户在设置页
 *     显式勾选「允许不安全连接」才放行；本机回环地址不受限（不出本机）。
 */

const http = require('node:http');
const https = require('node:https');

const REQUEST_TIMEOUT_MS = 15000;

/**
 * 响应体上限（字节）。快照是歌单/模板/历史的 JSON，正常规模在百 KB 量级，
 * 16MB 已留两个数量级余量。超限即断流报错，不做「截断后照样解析」——
 * 半截 JSON 解析失败的错误信息会掩盖真正的病因（服务端在灌垃圾）。
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** 错误码：在非本机 http 上拒绝发送凭据（上层可据此提示用户去勾选授权） */
const ERR_INSECURE_CREDENTIALS = 'INSECURE_CREDENTIALS';
/** 错误码：响应体超过上限 */
const ERR_RESPONSE_TOO_LARGE = 'RESPONSE_TOO_LARGE';

/** 回环地址判定：这些地址上的 http 不出本机，凭据不经过网络 */
function _isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/**
 * 校验同步 URL。
 *
 * @param {string} url
 * @param {{credentials?: boolean, allowInsecure?: boolean}} [opts]
 *   credentials: 本次请求是否会携带 Authorization（有用户名即算）；
 *   allowInsecure: 用户在设置页显式授权「允许明文 http 发送凭据」。
 */
function _assertHttpUrl(url, opts = {}) {
  if (!url || typeof url !== 'string') {
    throw new Error('缺少同步 URL（需在设置中填写完整的 WebDAV 文件地址）');
  }
  let u;
  try {
    u = new URL(url);
  } catch (_e) {
    throw new Error(`同步 URL 不是合法地址: ${url.slice(0, 80)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`同步 URL 仅支持 http(s):// 协议: ${u.protocol}`);
  }
  if (opts.credentials && u.protocol === 'http:' && !_isLoopbackHost(u.hostname) && !opts.allowInsecure) {
    const err = new Error(
      '同步地址是明文 http，密码会以可被嗅探的形式经过网络。'
      + '请改用 https，或在设置中显式允许不安全连接',
    );
    err.code = ERR_INSECURE_CREDENTIALS;
    throw err;
  }
  return u;
}

/** 本次请求是否会带 Authorization：有用户名即会（见 _authHeaders） */
function _hasCredentials(cfg) {
  return !!(cfg && cfg.user);
}

function defaultTransport({ method, url, headers, body }) {
  const u = _assertHttpUrl(url);
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const finalHeaders = { ...headers };
    if (body != null && finalHeaders['Content-Length'] == null) {
      finalHeaders['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = mod.request(u, { method, headers: finalHeaders }, (res) => {
      // 声明长度就已超限 → 连字节都不收
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        res.destroy();
        const err = new Error(
          `WebDAV 响应过大（声明 ${declared} 字节，上限 ${MAX_RESPONSE_BYTES}）`,
        );
        err.code = ERR_RESPONSE_TOO_LARGE;
        reject(err);
        return;
      }
      const chunks = [];
      let total = 0;
      let aborted = false;
      res.on('data', (c) => {
        if (aborted) return;
        total += c.length;
        if (total > MAX_RESPONSE_BYTES) {
          // 未声明长度 / 声明长度说谎 → 边收边数，超限立刻断流
          aborted = true;
          res.destroy();
          const err = new Error(`WebDAV 响应超过上限 ${MAX_RESPONSE_BYTES} 字节，已中止`);
          err.code = ERR_RESPONSE_TOO_LARGE;
          reject(err);
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (aborted) return;
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', (e) => { if (!aborted) reject(e); });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('WebDAV 请求超时')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function _authHeaders(cfg) {
  const headers = { Accept: 'application/json' };
  if (cfg && cfg.user) {
    const raw = `${cfg.user}:${cfg.pass || ''}`;
    headers.Authorization = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  }
  return headers;
}

/**
 * 拉取远端快照
 * @returns {Promise<{exists:false} | {exists:true, etag:string|null, snapshot:Object}>}
 */
async function fetchSnapshot(cfg, opts = {}) {
  const transport = opts.transport || defaultTransport;
  _assertHttpUrl(cfg && cfg.url, {
    credentials: _hasCredentials(cfg),
    allowInsecure: !!(cfg && cfg.allowInsecure),
  });
  const res = await transport({
    method: 'GET', url: cfg.url, headers: _authHeaders(cfg),
  });
  if (res.status === 404) return { exists: false };
  if (res.status < 200 || res.status > 299) {
    const err = new Error(`WebDAV 读取失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  // 注入型 transport（单测）也要受同一上限约束，别让上限只活在默认实现里
  if (typeof res.body === 'string' && Buffer.byteLength(res.body, 'utf8') > MAX_RESPONSE_BYTES) {
    const err = new Error(`WebDAV 响应超过上限 ${MAX_RESPONSE_BYTES} 字节，已拒绝解析`);
    err.code = ERR_RESPONSE_TOO_LARGE;
    throw err;
  }
  let snapshot;
  try {
    snapshot = JSON.parse(res.body);
  } catch (_e) {
    throw new Error('远端快照 JSON 解析失败：文件可能不是本应用的备份');
  }
  return { exists: true, etag: res.headers.etag || null, snapshot };
}

/**
 * 回写远端快照
 * @returns {Promise<{ok:true} | {ok:false, conflict:true}>}
 */
async function pushSnapshot(cfg, snapshot, opts = {}) {
  const transport = opts.transport || defaultTransport;
  _assertHttpUrl(cfg && cfg.url, {
    credentials: _hasCredentials(cfg),
    allowInsecure: !!(cfg && cfg.allowInsecure),
  });
  const headers = { ..._authHeaders(cfg), 'Content-Type': 'application/json' };
  if (opts.etag) headers['If-Match'] = opts.etag;
  const res = await transport({
    method: 'PUT', url: cfg.url, headers, body: JSON.stringify(snapshot),
  });
  if (res.status >= 200 && res.status <= 299) return { ok: true };
  if (res.status === 412) return { ok: false, conflict: true };
  const err = new Error(`WebDAV 写入失败（HTTP ${res.status}）`);
  err.status = res.status;
  throw err;
}

module.exports = {
  fetchSnapshot,
  pushSnapshot,
  defaultTransport,
  MAX_RESPONSE_BYTES,
  ERR_INSECURE_CREDENTIALS,
  ERR_RESPONSE_TOO_LARGE,
};
