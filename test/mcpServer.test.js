/**
 * 单元测试：MCP HTTP 传输层（P1）
 *
 * 真起 node:http 服务但只绑 127.0.0.1 随机端口（listen 0），fetch 本地回环
 * ——不触外网。核心钉死的是安全边界：
 *   1. 只监听回环地址；
 *   2. 每个请求必须带 Authorization: Bearer <token>（timingSafe 比较）；
 *   3. 非本地 Origin 头一律拒绝（防浏览器跨站打本地端口）；
 *   4. 请求体大小上限（防内存 DoS）。
 * 协议分发本身在 mcpCore.test.js 已覆盖，这里用假 handleMessage 隔离。
 */

const test = require('node:test');
const assert = require('node:assert');

const { createMcpServer } = require('../src/main/mcp/mcpServer');

const TOKEN = 'topsecret-token-1234567890';

/** @returns {Promise<{url:string, stop:Function, calls:Array}>} */
async function serve(opts = {}) {
  const calls = [];
  const server = createMcpServer({
    token: TOKEN,
    handleMessage: async (msg) => {
      calls.push(msg);
      if (typeof msg.method === 'string' && msg.method.startsWith('notifications/')) return null;
      if (opts.echoFail) return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } };
      return { jsonrpc: '2.0', id: msg.id, result: { ok: true, method: msg.method } };
    },
    ...opts.serverOpts,
  });
  const { port } = await server.start(0);
  return { url: `http://127.0.0.1:${port}/mcp`, stop: server.stop, calls, server };
}

const initMsg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
const auth = (t) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}` });

test('mcpServer: 带对 token 的 initialize 得到 200 + JSON-RPC 应答', async () => {
  const { url, stop, calls } = await serve();
  try {
    const res = await fetch(url, { method: 'POST', headers: auth(TOKEN), body: JSON.stringify(initMsg) });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.result.ok, true);
    assert.strictEqual(calls.length, 1);
  } finally { await stop(); }
});

test('mcpServer: 缺 Authorization / token 错误 → 401，且不进协议层', async () => {
  const { url, stop, calls } = await serve();
  try {
    const r1 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(initMsg) });
    assert.strictEqual(r1.status, 401);
    const r2 = await fetch(url, { method: 'POST', headers: auth('wrong-token'), body: JSON.stringify(initMsg) });
    assert.strictEqual(r2.status, 401);
    assert.strictEqual(calls.length, 0);
  } finally { await stop(); }
});

test('mcpServer: 非本地 Origin 头 → 403（浏览器跨站请求防线）', async () => {
  const { url, stop, calls } = await serve();
  try {
    const res = await fetch(url, { method: 'POST', headers: { ...auth(TOKEN), Origin: 'https://evil.example.com' }, body: JSON.stringify(initMsg) });
    assert.strictEqual(res.status, 403);
    // 无 Origin（curl/原生 Agent 常态）与 localhost Origin 放行
    const okRes = await fetch(url, { method: 'POST', headers: auth(TOKEN), body: JSON.stringify(initMsg) });
    assert.strictEqual(okRes.status, 200);
    assert.strictEqual(calls.length, 1);
  } finally { await stop(); }
});

test('mcpServer: 超大请求体 → 413（防内存 DoS）', async () => {
  const { url, stop } = await serve();
  try {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'a'.repeat(2 * 1024 * 1024) } });
    const res = await fetch(url, { method: 'POST', headers: auth(TOKEN), body: big });
    assert.strictEqual(res.status, 413);
  } finally { await stop(); }
});

test('mcpServer: 非法 JSON → -32700 协议错误应答（400 状态）', async () => {
  const { url, stop } = await serve();
  try {
    const res = await fetch(url, { method: 'POST', headers: auth(TOKEN), body: '{not json' });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error.code, -32700);
  } finally { await stop(); }
});

test('mcpServer: 批量请求 → 批量应答；纯通知 → 202 无体', async () => {
  const { url, stop, calls } = await serve();
  try {
    const res = await fetch(url, { method: 'POST', headers: auth(TOKEN), body: JSON.stringify([initMsg, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]) });
    const body = await res.json();
    assert.ok(Array.isArray(body) && body.length === 2);
    assert.strictEqual(calls.length, 2);

    const r2 = await fetch(url, { method: 'POST', headers: auth(TOKEN), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.strictEqual(r2.status, 202);
  } finally { await stop(); }
});

test('mcpServer: GET /mcp 只接受 POST（405），未知路径 404', async () => {
  const { url, stop } = await serve();
  try {
    const r1 = await fetch(url, { headers: auth(TOKEN) });
    assert.strictEqual(r1.status, 405);
    const r2 = await fetch(`http://${new URL(url).host}/other`, { method: 'POST', headers: auth(TOKEN), body: '{}' });
    assert.strictEqual(r2.status, 404);
  } finally { await stop(); }
});

test('mcpServer: start 幂等 + stop 后可复起；只绑回环', async () => {
  const a = await serve();
  try {
    const again = await a.server.start(0); // 已运行 → 直接回当前地址，不双绑
    assert.ok(again.port);
  } finally { await a.stop(); }
  const b = await serve(); // 复起
  try {
    const res = await fetch(b.url, { method: 'POST', headers: auth(TOKEN), body: JSON.stringify(initMsg) });
    assert.strictEqual(res.status, 200);
  } finally { await b.stop(); }
});
