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
