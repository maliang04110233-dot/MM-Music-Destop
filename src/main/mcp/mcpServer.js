/**
 * MCP HTTP 传输层（P1）—— Streamable HTTP 最小实现
 *
 * 安全边界（全部在测试里钉死）：
 *   - 只绑 127.0.0.1：工具面能触发下载/改库，绝不暴露到局域网；
 *   - Bearer token：timingSafe 比较，防本地恶意页面时序猜解；
 *   - Origin 白名单只放行回环主机：浏览器里任意网站打本地端口（DNS
 *     rebinding 之外的一般跨站 POST）直接被这一刀挡掉；
 *   - 请求体上限 1 MiB：桌面进程不能因一个坏客户端 OOM。
 *
 * 协议分发在 mcpCore.js，本文件只管 HTTP 壳；transport 与 core 分开，
 * 单测用假 handleMessage 即可隔离鉴权/限流路径。
 */

'use strict';

const http = require('http');
const crypto = require('crypto');

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;
const LOCAL_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * @param {Object} deps
 * @param {string} deps.token Bearer 令牌
 * @param {(msg:Object)=>Promise<Object|null>} deps.handleMessage 单条 JSON-RPC 分发
 * @returns {{start:(port:number)=>Promise<{port:number}>, stop:()=>Promise<void>, listening:boolean}}
 */
function createMcpServer({ token, handleMessage }) {
  let server = null;
  let boundPort = 0;

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 超限：耗尽流再回 413，避免客户端收到 ECONNRESET 以外的困惑行为
        req.on('error', () => {});
        req.resume();
        const err = new Error('PAYLOAD_TOO_LARGE');
        err.code = 'EBODYTOOLARGE';
        throw err;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== MCP_PATH) return json(res, 404, { error: 'not found' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { error: 'method not allowed' });
    }

    const authz = req.headers['authorization'] || '';
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (!m || !token || !safeEqual(m[1], token)) {
      return json(res, 401, { error: 'unauthorized' });
    }

    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN_RE.test(origin)) {
      return json(res, 403, { error: 'forbidden origin' });
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      if (e.code === 'EBODYTOOLARGE') return json(res, 413, { error: 'payload too large' });
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_e) {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    try {
      if (Array.isArray(msg)) {
        const responses = (await Promise.all(msg.map(handleMessage))).filter(r => r !== null);
        if (!responses.length) { res.writeHead(202); return res.end(); }
        return json(res, 200, responses);
      }
      const r = await handleMessage(msg);
      if (r === null) { res.writeHead(202); return res.end(); }
      return json(res, 200, r);
    } catch (e) {
      return json(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message || 'internal error' } });
    }
  }

  return {
    start(port) {
      if (server) return Promise.resolve({ port: boundPort });
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          route(req, res).catch(e => {
            try { json(res, 500, { error: String(e && e.message || e) }); } catch (_e) { /* 已应答 */ }
          });
        });
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
          boundPort = server.address().port;
          resolve({ port: boundPort });
        });
      });
    },
    stop() {
      if (!server) return Promise.resolve();
      const s = server;
      server = null;
      boundPort = 0;
      return new Promise((resolve) => {
        if (s.closeAllConnections) s.closeAllConnections(); // keep-alive 连接不等自然超时
        s.close(() => resolve());
      });
    },
    get listening() { return !!server; },
    get port() { return boundPort; },
  };
}

module.exports = { createMcpServer, MCP_PATH, MAX_BODY_BYTES, LOCAL_ORIGIN_RE };
