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
 */

const http = require('node:http');
const https = require('node:https');

const REQUEST_TIMEOUT_MS = 15000;

function _assertHttpUrl(url) {
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
  return u;
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
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
  _assertHttpUrl(cfg && cfg.url);
  const res = await transport({
    method: 'GET', url: cfg.url, headers: _authHeaders(cfg),
  });
  if (res.status === 404) return { exists: false };
  if (res.status < 200 || res.status > 299) {
    const err = new Error(`WebDAV 读取失败（HTTP ${res.status}）`);
    err.status = res.status;
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
  _assertHttpUrl(cfg && cfg.url);
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

module.exports = { fetchSnapshot, pushSnapshot, defaultTransport };
