/**
 * urlGuard SSRF 防护测试
 *
 * 覆盖：
 *   - 协议白名单（http/https 之外全拒）
 *   - userinfo 拒绝
 *   - 字面量内网 IPv4/IPv6（RFC1918/loopback/link-local/ULA/multicast/TEST-NET）
 *   - IP 编码绕过：十进制(2130706433)、十六进制(0x7f.0.0.1)、八进制(0177.0.0.1)、IPv4-mapped(::ffff:127.0.0.1)
 *   - 公网字面量 IP 放行
 *   - 公网域名放行（DNS 解析，无网络环境下跳过）
 */

const test = require('node:test');
const assert = require('node:assert');
const { _internal, assertPublicHttpUrl, resolveHostSafe } = require('../src/utils/urlGuard');

const { normalizeHost, isPrivateIPv4, isPrivateIPv6 } = _internal;

// ── normalizeHost：IP 编码归一化 ────────────────────────
test('normalizeHost: 十进制 IP 2130706433 → 127.0.0.1', () => {
  assert.strictEqual(normalizeHost('2130706433'), '127.0.0.1');
});

test('normalizeHost: 十六进制 IP 0x7f.0.0.1 → 127.0.0.1', () => {
  assert.strictEqual(normalizeHost('0x7f.0.0.1'), '127.0.0.1');
});

test('normalizeHost: 八进制 IP 0177.0.0.1 → 127.0.0.1', () => {
  assert.strictEqual(normalizeHost('0177.0.0.1'), '127.0.0.1');
});

test('normalizeHost: 混合编码 0x7f.1 → 不归一（非法段数），原样返回', () => {
  // 0x7f.1 只有 2 段，不是点分四段，按域名处理（后续 DNS 解析会失败/拒绝）
  assert.strictEqual(normalizeHost('0x7f.1'), '0x7f.1');
});

test('normalizeHost: IPv6 字面量去方括号', () => {
  assert.strictEqual(normalizeHost('[::1]'), '::1');
  assert.strictEqual(normalizeHost('[::ffff:127.0.0.1]'), '::ffff:127.0.0.1');
});

// ── isPrivateIPv4 ───────────────────────────────────────
test('isPrivateIPv4: RFC1918 三段 + loopback + link-local 全判定内网', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1', '127.0.0.1', '169.254.1.1', '0.0.0.0', '255.255.255.255']) {
    assert.strictEqual(isPrivateIPv4(ip), true, `${ip} 应判定为内网`);
  }
});

test('isPrivateIPv4: 172.32.x 和 172.15.x 不是内网（边界外）', () => {
  assert.strictEqual(isPrivateIPv4('172.32.0.1'), false);
  assert.strictEqual(isPrivateIPv4('172.15.0.1'), false);
});

test('isPrivateIPv4: 公网 IP 放行', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '203.107.1.1']) {
    assert.strictEqual(isPrivateIPv4(ip), false, `${ip} 应判定为公网`);
  }
});

// ── isPrivateIPv6 ───────────────────────────────────────
test('isPrivateIPv6: loopback/link-local/ULA/multicast/IPv4-mapped 全判定内网', () => {
  assert.strictEqual(isPrivateIPv6('::1'), true);
  assert.strictEqual(isPrivateIPv6('::'), true);
  assert.strictEqual(isPrivateIPv6('fe80::1'), true);
  assert.strictEqual(isPrivateIPv6('fc00::1'), true);
  assert.strictEqual(isPrivateIPv6('fd12:3456::1'), true);
  assert.strictEqual(isPrivateIPv6('ff02::1'), true);
  assert.strictEqual(isPrivateIPv6('::ffff:127.0.0.1'), true);
  assert.strictEqual(isPrivateIPv6('::ffff:192.168.1.1'), true);
});

test('isPrivateIPv6: 公网 IPv6 放行', () => {
  assert.strictEqual(isPrivateIPv6('2606:4700:4700::1111'), false);
  assert.strictEqual(isPrivateIPv6('2001:4860:4860::8888'), false);
});

// ── resolveHostSafe（字面量 IP 路径，无 DNS 依赖）───────
test('resolveHostSafe: 字面量内网 IP 拒绝（含编码形式）', async () => {
  for (const h of ['127.0.0.1', '10.0.0.5', '192.168.0.1', '172.20.1.1', '[::1]', '::ffff:10.0.0.1']) {
    const r = await resolveHostSafe(h);
    assert.strictEqual(r.ok, false, `${h} 应被拒绝`);
  }
});

test('resolveHostSafe: 编码 IP 经归一化后拒绝（十进制/十六进制/八进制）', async () => {
  // Node URL 会把这些保留在 hostname；urlGuard 先归一化再判定
  for (const h of ['2130706433', '0x7f.0.0.1', '0177.0.0.1']) {
    const r = await resolveHostSafe(h);
    assert.strictEqual(r.ok, false, `${h}（编码的 127.0.0.1）应被拒绝`);
  }
});

test('resolveHostSafe: 公网字面量 IP 放行并返回 IP 列表', async () => {
  const r = await resolveHostSafe('8.8.8.8');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ips, ['8.8.8.8']);
});

// ── assertPublicHttpUrl ────────────────────────────────
test('assertPublicHttpUrl: 拒绝非 http(s) 协议', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/html,x', 'gopher://127.0.0.1:6379/_INFO']) {
    const r = await assertPublicHttpUrl(url);
    assert.strictEqual(r.ok, false, `${url} 应被拒绝`);
  }
});

test('assertPublicHttpUrl: 拒绝携带 userinfo 的 URL', async () => {
  const r = await assertPublicHttpUrl('http://user:pass@8.8.8.8/');
  assert.strictEqual(r.ok, false);
});

test('assertPublicHttpUrl: 拒绝编码内网 IP 的 http URL', async () => {
  for (const url of [
    'http://127.0.0.1:8500/admin',
    'http://2130706433:8500/admin',
    'http://0x7f.0.0.1/x',
    'http://0177.0.0.1/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://169.254.169.254/latest/meta-data/',  // 云元数据端点
    'http://192.168.1.1/router',
  ]) {
    const r = await assertPublicHttpUrl(url);
    assert.strictEqual(r.ok, false, `${url} 应被拒绝`);
  }
});

test('assertPublicHttpUrl: 公网 URL 放行', async () => {
  const r = await assertPublicHttpUrl('https://music.163.com/song/media/outer/url?id=1.mp3');
  assert.strictEqual(r.ok, true);
  assert.ok(r.url instanceof URL);
  assert.ok(Array.isArray(r.ips) && r.ips.length > 0);
});

// ── DNS 路径（依赖网络；离线环境跳过）─────────────────
test('resolveHostSafe: localhost 解析到内网 → 拒绝', { skip: false }, async () => {
  const r = await resolveHostSafe('localhost');
  // 即使 DNS 把 localhost 解析为 ::1/127.0.0.1，也必须拒绝
  assert.strictEqual(r.ok, false);
});

// ── makePinnedLookup ───────────────────────────────────
test('makePinnedLookup: 返回固定的已校验 IP（防 rebinding）', async () => {
  const { makePinnedLookup } = require('../src/utils/urlGuard');
  const lookup = makePinnedLookup(['8.8.8.8']);
  await new Promise((resolve) => {
    lookup('example.com', { all: false }, (err, address, family) => {
      assert.strictEqual(err, null);
      assert.strictEqual(address, '8.8.8.8'); // 无论此刻 DNS 解析出什么，连接都用校验过的 IP
      assert.strictEqual(family, 4);
      resolve();
    });
  });
});
