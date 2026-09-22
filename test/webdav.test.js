/**
 * 单元测试：utils/webdav.js — 快照 GET/PUT 客户端
 *
 * 传输层通过 opts.transport 注入（默认实现走 node http/https），
 * 本文件全部用假 transport 验证请求构造与响应判读，不发真实网络。
 */

const test = require('node:test');
const assert = require('node:assert');

const { fetchSnapshot, pushSnapshot } = require('../src/utils/webdav');

function stubTransport(res) {
  const calls = [];
  const transport = async (reqOpts) => {
    calls.push(reqOpts);
    return res;
  };
  return { calls, transport };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('fetchSnapshot: 404 → exists:false（首次同步远端还没有文件）', async () => {
  const { calls, transport } = stubTransport({ status: 404, headers: {}, body: '' });
  const r = await fetchSnapshot(
    { url: 'https://nas.example/dav/musicdl.json', user: 'u', pass: 'p' },
    { transport },
  );
  assert.deepStrictEqual(r, { exists: false });
  assert.strictEqual(calls[0].method, 'GET');
  assert.strictEqual(calls[0].url, 'https://nas.example/dav/musicdl.json');
  assert.strictEqual(calls[0].headers.Authorization, `Basic ${b64('u:p')}`);
});

test('fetchSnapshot: 无凭证时不发 Authorization 头', async () => {
  const { calls, transport } = stubTransport({
    status: 200, headers: {}, body: JSON.stringify({ data: {} }),
  });
  await fetchSnapshot({ url: 'https://x.example/a.json' }, { transport });
  assert.strictEqual('Authorization' in calls[0].headers, false);
});

test('fetchSnapshot: 200 → 解析 JSON 并捕获 ETag', async () => {
  const body = { app: 'music-downloader', version: 2, data: { userPlaylists: [] } };
  const { transport } = stubTransport({
    status: 200, headers: { etag: '"abc123"' }, body: JSON.stringify(body),
  });
  const r = await fetchSnapshot({ url: 'https://x.example/a.json' }, { transport });
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.etag, '"abc123"');
  assert.deepStrictEqual(r.snapshot, body);
});

test('fetchSnapshot: 非 404 的失败状态 → 抛错并带 status；200 坏 JSON 也抛错', async () => {
  const bad = stubTransport({ status: 500, headers: {}, body: 'oops' });
  await assert.rejects(
    () => fetchSnapshot({ url: 'https://x/a.json' }, bad),
    (e) => e.status === 500,
  );
  const broken = stubTransport({ status: 200, headers: {}, body: '{"半截' });
  await assert.rejects(
    () => fetchSnapshot({ url: 'https://x/a.json' }, broken),
    /JSON|解析/,
  );
});

test('pushSnapshot: PUT JSON；有 etag 时带 If-Match（乐观锁），没有则不带', async () => {
  const withEtag = stubTransport({ status: 204, headers: {}, body: '' });
  const r = await pushSnapshot(
    { url: 'https://x/a.json', user: 'u', pass: 'p' },
    { hello: 1 },
    { etag: '"v1"', ...withEtag },
  );
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(withEtag.calls[0].method, 'PUT');
  assert.strictEqual(withEtag.calls[0].headers['Content-Type'], 'application/json');
  assert.strictEqual(withEtag.calls[0].headers['If-Match'], '"v1"');
  assert.strictEqual(withEtag.calls[0].body, JSON.stringify({ hello: 1 }));

  const noEtag = stubTransport({ status: 201, headers: {}, body: '' });
  await pushSnapshot({ url: 'https://x/a.json' }, { hello: 2 }, noEtag);
  assert.strictEqual('If-Match' in noEtag.calls[0].headers, false);
});

test('pushSnapshot: 412 → conflict:true（远端被别人写过，交由上层重拉重并）', async () => {
  const { transport } = stubTransport({ status: 412, headers: {}, body: '' });
  const r = await pushSnapshot(
    { url: 'https://x/a.json' }, { data: {} }, { etag: '"stale"', transport },
  );
  assert.deepStrictEqual(r, { ok: false, conflict: true });
});

test('pushSnapshot: 其它失败状态抛错', async () => {
  const { transport } = stubTransport({ status: 403, headers: {}, body: '' });
  await assert.rejects(
    () => pushSnapshot({ url: 'https://x/a.json' }, {}, { transport }),
    (e) => e.status === 403,
  );
});

test('非 http(s) 协议的 URL 一律拒绝（凭证只走 http 层）', async () => {
  const { calls, transport } = stubTransport({ status: 200, headers: {}, body: '{}' });
  await assert.rejects(
    () => fetchSnapshot({ url: 'file:///C:/secret.json' }, { transport }),
    /http/,
  );
  await assert.rejects(
    () => fetchSnapshot({ url: '' }, { transport }),
    /URL/,
  );
  assert.strictEqual(calls.length, 0, '拒绝时不应发出任何请求');
});

// ══════════════════════════════════════════════════════════
// 2026-09 审计 P1 加固（两条：明文凭据门禁 + 响应体上限）
// ══════════════════════════════════════════════════════════

const { MAX_RESPONSE_BYTES, ERR_INSECURE_CREDENTIALS, ERR_RESPONSE_TOO_LARGE } = require('../src/utils/webdav');

test('明文凭据门禁：非本机 http + 有用户名 ⇒ 拒绝发送，且零请求', async () => {
  const { calls, transport } = stubTransport({ status: 200, headers: {}, body: '{}' });
  await assert.rejects(
    () => fetchSnapshot({ url: 'http://nas.example/dav/a.json', user: 'u', pass: 'p' }, { transport }),
    (e) => e.code === ERR_INSECURE_CREDENTIALS,
  );
  await assert.rejects(
    () => pushSnapshot({ url: 'http://nas.example/dav/a.json', user: 'u' }, {}, { transport }),
    (e) => e.code === ERR_INSECURE_CREDENTIALS,
  );
  assert.strictEqual(calls.length, 0, '密码不能以可嗅探形式出网');
});

test('明文凭据门禁：显式授权后放行（设置页勾选「允许不安全连接」）', async () => {
  const { calls, transport } = stubTransport({ status: 200, headers: {}, body: '{}' });
  await fetchSnapshot(
    { url: 'http://nas.example/dav/a.json', user: 'u', pass: 'p', allowInsecure: true },
    { transport },
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].headers.Authorization, `Basic ${b64('u:p')}`);
});

test('明文凭据门禁：本机回环 http 不受限（凭据不出本机），https 更不受限', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const { calls, transport } = stubTransport({ status: 200, headers: {}, body: '{}' });
    await fetchSnapshot({ url: `http://${host}:8080/dav/a.json`, user: 'u', pass: 'p' }, { transport });
    assert.strictEqual(calls.length, 1, `${host} 是回环地址，应放行`);
  }
  const https = stubTransport({ status: 200, headers: {}, body: '{}' });
  await fetchSnapshot({ url: 'https://nas.example/a.json', user: 'u', pass: 'p' }, https);
  assert.strictEqual(https.calls.length, 1);
});

test('明文凭据门禁：http 但无用户名 ⇒ 不拦截（没有凭据可泄漏）', async () => {
  const { calls, transport } = stubTransport({ status: 200, headers: {}, body: '{}' });
  await fetchSnapshot({ url: 'http://nas.example/dav/a.json' }, { transport });
  assert.strictEqual(calls.length, 1);
});

test('响应体上限：注入 transport 返回超大体 ⇒ 拒绝解析（别让上限只活在默认实现里）', async () => {
  const huge = 'x'.repeat(MAX_RESPONSE_BYTES + 1);
  const { transport } = stubTransport({ status: 200, headers: {}, body: huge });
  await assert.rejects(
    () => fetchSnapshot({ url: 'https://x/a.json' }, { transport }),
    (e) => e.code === ERR_RESPONSE_TOO_LARGE,
  );
});

test('响应体上限：默认 transport 在声明长度超限时不收字节（含边收边数兜底）', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    // 客户端超限会 destroy 连接，写侧必然报错 —— 吞掉，别让服务端异常掀翻测试
    res.on('error', () => {});
    if (req.url === '/declared') {
      res.writeHead(200, { 'content-length': String(MAX_RESPONSE_BYTES + 1024) });
      res.end('x'.repeat(1024));
      return;
    }
    // 不声明 content-length，靠边收边数兜底
    res.writeHead(200);
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let i = 0; i < 20 && !res.destroyed; i++) res.write(chunk);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => fetchSnapshot({ url: `http://127.0.0.1:${port}/declared` }),
      (e) => e.code === ERR_RESPONSE_TOO_LARGE,
    );
    await assert.rejects(
      () => fetchSnapshot({ url: `http://127.0.0.1:${port}/stream` }),
      (e) => e.code === ERR_RESPONSE_TOO_LARGE,
    );
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
