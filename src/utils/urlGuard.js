/**
 * SSRF 防护工具
 *
 * 用于主进程所有「渲染层提供 URL → 主进程发起请求」的通道（proxy-play、
 * downloadFile 等）。原实现（download.js 里 hostname 正则黑名单）只匹配
 * 字面量，可被十进制 IP（2130706433）、十六进制（0x7f.0.0.1）、八进制
 * （0177.0.0.1）、IPv4-mapped IPv6（[::ffff:127.0.0.1]）及 DNS rebinding
 * 绕过。
 *
 * 本模块策略：
 *   1. 只允许 http/https 协议，拒绝携带 userinfo 的 URL
 *   2. DNS 解析 hostname 的全部 A/AAAA 记录，逐个判定是否内网 IP
 *   3. 解析得到的 IP 列表回传给调用方，用 https.request 的
 *      { lookup } 定制项把连接固定到已校验的 IP（防 rebinding：
 *      校验的和连接的必须是同一批 IP）
 *
 * Node 内置 net.isIP / dns 均不依赖 electron，可直接单测。
 */

const dns = require('dns');
const net = require('net');
const { URL } = require('url');

/** IPv4 私有/保留网段（CIDR）+ 回环/链路本地/组播等 */
const BLOCKED_V4_CIDRS = [
  '0.0.0.0/8',        // "本网络"
  '10.0.0.0/8',       // RFC1918
  '100.64.0.0/10',    // CGNAT
  '127.0.0.0/8',      // loopback
  '169.254.0.0/16',   // link-local
  '172.16.0.0/12',    // RFC1918
  '192.0.0.0/24',     // IETF protocol assignments
  '192.0.2.0/24',     // TEST-NET-1
  '192.88.99.0/24',   // 6to4 relay anycast (deprecated)
  '192.168.0.0/16',   // RFC1918
  '198.18.0.0/15',    // benchmark
  '198.51.100.0/24',  // TEST-NET-2
  '203.0.113.0/24',   // TEST-NET-3
  '224.0.0.0/4',      // multicast
  '240.0.0.0/4',      // reserved (含 255.255.255.255 broadcast)
];

function ipToLong(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function cidrToRange(cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const baseLong = ipToLong(base);
  if (baseLong === null) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { start: (baseLong & mask) >>> 0, end: ((baseLong & mask) >>> 0) + (2 ** (32 - bits)) - 1 };
}

const BLOCKED_V4_RANGES = BLOCKED_V4_CIDRS
  .map(cidrToRange)
  .filter(Boolean);

function isPrivateIPv4(ip) {
  const long = ipToLong(ip);
  if (long === null) return true; // 解析不了的一律按内网处理
  return BLOCKED_V4_RANGES.some(r => long >= r.start && long <= r.end);
}

function isPrivateIPv6(ip) {
  const norm = ip.toLowerCase();
  // 展开形式：::1 loopback / :: unspecified / fe80:: link-local / fc00::/7 ULA
  if (norm === '::' || norm === '::1') return true;
  if (norm.startsWith('fe80:') || norm.startsWith('fe9') || norm.startsWith('fea') || norm.startsWith('feb')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(norm)) return true; // ULA fc00::/7
  if (norm.startsWith('ff')) return true;           // multicast
  // IPv4-mapped，两种写法：
  //   点分形式 ::ffff:127.0.0.1
  //   十六进制段形式 ::ffff:7f00:1（Node URL 会把点分规范化成这种）
  const v4mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPrivateIPv4(v4mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(norm)) {
    const segs = norm.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const high = parseInt(segs[1], 16);
    const low = parseInt(segs[2], 16);
    const v4 = `${high >> 8}.${high & 0xFF}.${low >> 8}.${low & 0xFF}`;
    return isPrivateIPv4(v4);
  }
  // IPv6 过渡态：64:ff9b::/96（NAT64 会把内网 v4 映射进来，保守拒绝）
  if (norm.startsWith('64:ff9b:')) return true;
  return false;
}

/**
 * 归一化主机名为可判定的形式（处理十进制/十六进制/八进制 IP 编码）。
 * Node 的 URL 已把 2130706433 / 0x7f.0.0.1 / 0177.0.0.1 保留在 hostname 里，
 * dns.lookup 反而会解析它们——所以必须在这里先归一化。
 * 注意：URL.hostname 对 IPv6 字面量返回时已去掉方括号（如
 * [::ffff:127.0.0.1] → "::ffff:127.0.0.1"），因此不能只靠方括号识别
 * IPv6，含冒号的裸主机名也是 IPv6。
 */
function normalizeHost(hostname) {
  const h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) return h.slice(1, -1); // 显式 IPv6 字面量
  if (h.includes(':')) return h;                                   // 裸 IPv6（URL 已去括号）
  // 纯十进制整数 → IPv4
  if (/^\d{1,10}$/.test(h)) {
    const long = Number(h);
    if (long <= 0xFFFFFFFF) {
      return `${(long >>> 24) & 0xFF}.${(long >>> 16) & 0xFF}.${(long >>> 8) & 0xFF}.${long & 0xFF}`;
    }
  }
  // 点分四段，每段可能是 十进制/十六进制(0x)/八进制(0开头) → 逐段归一化
  if (h.includes('.')) {
    const parts = h.split('.');
    if (parts.length === 4 && parts.every(p => /^(0x[0-9a-f]+|0[0-7]*|\d{1,3})$/.test(p))) {
      const nums = parts.map(p => {
        if (p.startsWith('0x')) return parseInt(p, 16);
        if (p.startsWith('0') && p.length > 1) return parseInt(p, 8);
        return parseInt(p, 10);
      });
      if (nums.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return nums.join('.');
    }
  }
  return h;
}

/**
 * 校验单个主机名（已归一化）：字面量 IP 直接判定；域名走 DNS。
 * 返回 { ok, ips, reason }。ips 为解析到的全部 IP（供连接时固定）。
 */
async function resolveHostSafe(hostname) {
  const host = normalizeHost(hostname);

  const ver = net.isIP(host);
  if (ver === 4) {
    if (isPrivateIPv4(host)) return { ok: false, reason: `内网 IPv4 被拒绝: ${host}` };
    return { ok: true, ips: [host] };
  }
  if (ver === 6) {
    if (isPrivateIPv6(host)) return { ok: false, reason: `内网 IPv6 被拒绝: ${host}` };
    return { ok: true, ips: [host] };
  }

  // 域名：解析全部 A/AAAA 再逐个判定
  let ips;
  try {
    const records = await dns.promises.lookup(host, { all: true });
    ips = records.map(r => r.address);
  } catch (e) {
    return { ok: false, reason: `DNS 解析失败: ${host} (${e.code || e.message})` };
  }
  if (!ips.length) return { ok: false, reason: `域名无解析记录: ${host}` };

  for (const ip of ips) {
    const v = net.isIP(ip);
    const bad = v === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
    if (bad) return { ok: false, reason: `域名 ${host} 解析到内网地址 ${ip}，已拒绝` };
  }
  return { ok: true, ips };
}

/**
 * 校验完整 URL 字符串。
 * 返回 { ok, url: URL 对象, ips, reason }。
 */
async function assertPublicHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_e) {
    return { ok: false, reason: 'URL 格式无效' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `不允许的协议: ${u.protocol}` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: '不允许携带 userinfo 的 URL' };
  }
  const hostCheck = await resolveHostSafe(u.hostname);
  if (!hostCheck.ok) return { ok: false, reason: hostCheck.reason };
  return { ok: true, url: u, ips: hostCheck.ips };
}

/**
 * 生成 https/http.request 可用的 lookup 定制项：
 * 连接阶段把 hostname 固定为已校验的 IP（选校验过的第一个），
 * SNI/Host 头仍用原域名。若连接时 DNS 又变卦（rebinding），
 * 因为 lookup 直接返回校验过的 IP，攻击面已闭合。
 *
 * 注意：仅用于「以 IP 直连、Host 头带域名」的场景。调用方需同时
 * 设置 headers.Host 并把 servername 设为原域名（TLS SNI）。
 */
function makePinnedLookup(ips) {
  // 只保留合法 IP，并让 IPv4 排在前面：Single 形态下优先连接 IPv4（部分网络
  // IPv6 不可达，首连会白白超时）；all 形态（Happy Eyeballs）下顺序即优先级。
  const entries = (ips || [])
    .map((ip) => ({ address: ip, family: net.isIP(ip) }))
    .filter((e) => e.family === 4 || e.family === 6)
    .sort((a, b) => (a.family === b.family ? 0 : a.family === 4 ? -1 : 1));

  /** 按 family 过滤；过滤后为空则退回全部（宁可多试也不能一个都不给） */
  function pickByFamily(list, family) {
    if (family !== 4 && family !== 6) return list;
    const filtered = list.filter((e) => e.family === family);
    return filtered.length ? filtered : list;
  }

  return function pinnedLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = options || {};

    if (!entries.length) {
      // 理论上不可达（assertPublicHttpUrl 已保证 ips 非空）；保守退回系统解析，
      // 由 dns.lookup 依据 opts.all 自行决定回调形态
      return dns.lookup(hostname, opts, callback);
    }

    // Node 20+ 的 net 在 autoSelectFamily（Happy Eyeballs，默认开启）路径下会用
    // { all: true } 调用 lookup，并期望回调形如 (err, [{ address, family }])；
    // 而旧路径（含 Node 18）期望 (err, address, family)。两种形态都必须支持——
    // 只支持单值会让 Node 24 把字符串当数组解析，抛 ERR_INVALID_IP_ADDRESS。
    if (opts.all) {
      return callback(null, pickByFamily(entries, opts.family).slice());
    }
    const picked = pickByFamily(entries, opts.family)[0];
    return callback(null, picked.address, picked.family);
  };
}

module.exports = {
  resolveHostSafe,
  assertPublicHttpUrl,
  makePinnedLookup,
  // 供单测使用
  _internal: { normalizeHost, isPrivateIPv4, isPrivateIPv6, ipToLong },
};
