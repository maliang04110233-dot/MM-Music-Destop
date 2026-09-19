/**
 * playCache proxyPlay 在途去重测试（第二轮审计 M3）
 *
 * 修复前：同一 URL 并发两次 proxyPlay → PLAY_CACHE 未命中（首个未下完）→
 * 两个 proxyDownloadOnce 以两个 WriteStream 同时写同一个缓存文件 → 内容写花。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const dns = require('node:dns');

const playCache = require('../src/main/playCache');

// ── 网络桩：http.get 单例 + dns lookup（urlGuard 校验用）────────
const reqLog = [];
let releaseFirst;
const firstGate = new Promise((r) => { releaseFirst = r; });

const origGet = http.get;
const origLookup = dns.promises.lookup;

function installStubs() {
  http.get = (opts, cb) => {
    reqLog.push(opts);
    const res = new (require('node:events').EventEmitter)();
    res.statusCode = 200;
    res.headers = { 'content-length': String(1024) };
    res.resume = () => {};
    res.pipe = (dest) => {
      process.nextTick(() => {
        dest.write(Buffer.alloc(1024, 0x11));
        dest.end();
      });
      return dest;
    };
    const req = new (require('node:events').EventEmitter)();
    req.setTimeout = () => {};
    req.destroy = () => {};
    process.nextTick(() => {
      cb(res);
      // 第一次请求挂住，直到测试放行——制造并发窗口
      if (reqLog.length === 1) firstGate.then(() => res.emit('end'));
      else res.emit('end');
    });
    return req;
  };
  dns.promises.lookup = async (host, opts) => {
    const addr = { address: '93.184.216.34', family: 4 };
    if (opts && opts.all) return [addr];
    return addr;
  };
}

function restoreStubs() {
  http.get = origGet;
  dns.promises.lookup = origLookup;
}

test('M3: 同一 URL 并发 proxyPlay 只发起一次下载（在途去重）', async () => {
  installStubs();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'playcache-test-'));
  const url = 'http://cdn.example/song.mp3';
  try {
    const [r1, r2] = await Promise.all([
      playCache.proxyPlay(url, '', userData),
      playCache.proxyPlay(url, '', userData),
    ]);
    assert.strictEqual(reqLog.length, 1,
      `同 URL 并发应只发起一次代理下载，实际 ${reqLog.length} 次（双写同一缓存文件）`);
    assert.ok(!r1.error && !r2.error, `两次调用都应成功: ${r1.error || r2.error}`);
    assert.strictEqual(r1.fileUrl, r2.fileUrl, '并发调用应拿到同一缓存文件');
  } finally {
    releaseFirst();
    restoreStubs();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
