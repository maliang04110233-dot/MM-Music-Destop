/**
 * 单元测试：api/request.js
 *
 * 用本地 http server 模拟，覆盖两部分：
 *   - request() 的重试与指数退避
 *   - testAudioLink() 的直链预检（HEAD 被拒退化 Range GET、302 跟随、
 *     拒绝文本识别、体积/扩展名解析、异常不抛）
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const request = require('../src/api/request');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

test('request: 成功响应直接返回解析后的 JSON', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 0, timeout: 5000 });
    assert.deepStrictEqual(result, { ok: true });
  } finally {
    server.close();
  }
});

test('request: 网络错误重试到成功（重试 2 次后通）', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    if (count < 3) {
      res.destroy();  // 模拟网络中断
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, attempts: count }));
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 3, retryDelay: 10, timeout: 5000 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.attempts, 3);
  } finally {
    server.close();
  }
});

test('request: 超过重试次数后抛出', async () => {
  const { server, port } = await startServer((req, res) => {
    res.destroy();
  });
  try {
    await assert.rejects(
      () => request(`http://127.0.0.1:${port}/`, { retries: 1, retryDelay: 10, timeout: 2000 }),
      /Error|ECONNRESET|aborted|socket/i
    );
  } finally {
    server.close();
  }
});

test('request: 5xx 触发重试', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    if (count < 2) {
      res.writeHead(503);  // 第一次 503
      res.end('upstream busy');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ recovered: true }));
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 2, retryDelay: 10, timeout: 5000 });
    assert.deepStrictEqual(result, { recovered: true });
  } finally {
    server.close();
  }
});

test('request: 4xx 客户端错误不重试（resolve 出 body 字符串，调用方按业务判断）', async () => {
  let count = 0;
  const { server, port } = await startServer((req, res) => {
    count++;
    res.writeHead(404);
    res.end('not found');
  });
  try {
    // 4xx 走 resolve，body 字符串透传
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 3, retryDelay: 10, timeout: 5000 });
    assert.strictEqual(result, 'not found');
    assert.strictEqual(count, 1, '4xx 不应触发重试');
  } finally {
    server.close();
  }
});

// ── testAudioLink：音频直链预检 ─────────────────────────
// 预检的价值在于「不把坏链交给下载器」：无版权曲常返回 200 + text/plain
// 的 "refuse request!"，只看状态码会误判成功。全部用本地 server 桩，无外网依赖。

test('testAudioLink: 音频响应判为可用，解析体积与扩展名', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '181521' });
    res.end(Buffer.alloc(64, 1));
  });
  try {
    const r = await request.testAudioLink(`http://127.0.0.1:${port}/song.mp3`);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.ext, 'mp3');
    assert.strictEqual(r.sizeBytes, 181521);
  } finally { server.close(); }
});

test('testAudioLink: 200 但返回 text/plain 的拒绝文本 → 判为不可用', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('refuse request!');
  });
  try {
    const r = await request.testAudioLink(`http://127.0.0.1:${port}/anti.s`);
    assert.strictEqual(r.ok, false, 'text 响应不应被判为可用音频');
    assert.strictEqual(r.reason, 'not-audio');
  } finally { server.close(); }
});

test('testAudioLink: HEAD 被拒时退化为 Range GET，并从 content-range 取总长', async () => {
  const seen = { head: 0, get: 0, range: '' };
  const { server, port } = await startServer((req, res) => {
    if (req.method === 'HEAD') {
      seen.head++;
      res.writeHead(403);
      res.end();
      return;
    }
    seen.get++;
    seen.range = req.headers.range || '';
    res.writeHead(206, {
      'Content-Type': 'audio/mpeg',
      'Content-Range': 'bytes 0-1/5242880',
      'Content-Length': '2',
    });
    res.end(Buffer.from([1, 2]));
  });
  try {
    const r = await request.testAudioLink(`http://127.0.0.1:${port}/a.mp3`);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 206);
    assert.strictEqual(seen.get, 1, 'HEAD 403 后应发起一次 GET');
    assert.strictEqual(seen.range, 'bytes=0-1', 'GET 必须带 Range 头（绝不整包拉取）');
    assert.strictEqual(r.sizeBytes, 5242880, '体积应取 content-range 的总长而非分片长度');
  } finally { server.close(); }
});

test('testAudioLink: 跟随 302 重定向到真实音频', async () => {
  let port = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/jump') {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/real.mp3` });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.alloc(16, 1));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  try {
    const r = await request.testAudioLink(`http://127.0.0.1:${port}/jump`);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 200);
  } finally { server.close(); }
});

test('testAudioLink: 4xx 判为不可用并带状态码', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(404);
    res.end('nope');
  });
  try {
    const r = await request.testAudioLink(`http://127.0.0.1:${port}/missing.mp3`);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 404);
  } finally { server.close(); }
});

test('testAudioLink: 非法 URL 与连接失败均不抛异常', async () => {
  const bad = await request.testAudioLink('not-a-url');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'invalid-url');

  // 端口无人监听 → 网络错误，应 resolve 成 ok:false 而不是 reject
  const dead = await request.testAudioLink('http://127.0.0.1:1/x.mp3', { timeout: 1500 });
  assert.strictEqual(dead.ok, false);

  const empty = await request.testAudioLink('');
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, 'empty-url');
});
