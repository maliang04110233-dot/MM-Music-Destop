/**
 * downloadFile 状态码与错误页防护测试
 *
 * 覆盖：
 *   - 200 正常下载：.tmp 落盘后原子 rename 到目标路径
 *   - 206 续传：带 resumeOffset 时 Range 头生效、追加写、最终文件 = 旧前缀 + 新剩余
 *   - 200 全量重发（服务器不支持 Range）：覆盖写，不会把旧前缀拼进新文件
 *   - 403/404：拒绝且清理 .tmp
 *   - 200 + text/html：识别为 CDN 错误页，拒绝（不把 HTML 当音频写库）
 *
 * 测试服务器用 node:http 起在本机回环地址；urlGuard 对回环地址放行
 * （127.0.0.1 是 SSRF 防护白名单之外——用 skipSsrfCheck 走测试豁免路径）。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadFile } = require('../src/utils/downloader');

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function tmpFile(name) {
  return path.join(os.tmpdir(), `dl-test-${process.pid}-${name}`);
}

// 所有请求走 SSRF 测试豁免（回环地址 + 测试专用路径）
const OPTS = { skipSsrfCheck: true };

test.afterEach?.(() => {}); // node:test 无 afterEach，清理在每个测试内完成

test('downloadFile: 200 正常下载 → 原子落盘', async () => {
  const payload = Buffer.alloc(64 * 1024, 0xCD);
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': payload.length });
    res.end(payload);
  });
  const savePath = tmpFile('ok.bin');
  try {
    const progressList = [];
    const result = await downloadFile(url + '/file.mp3', savePath, p => progressList.push(p), {}, 0, OPTS);
    assert.strictEqual(result, savePath);
    assert.ok(fs.existsSync(savePath));
    assert.strictEqual(fs.statSync(savePath).size, payload.length);
    assert.ok(!fs.existsSync(savePath + '.tmp'), '完成后 .tmp 应已被 rename 消除');
    assert.ok(progressList.includes(100), '进度应最终到 100');
  } finally {
    server.close();
    fs.rmSync(savePath, { force: true });
    fs.rmSync(savePath + '.tmp', { force: true });
  }
});

test('downloadFile: 206 续传 → 追加写，最终文件 = 旧前缀 + 剩余部分', async () => {
  const prefix = Buffer.alloc(16 * 1024, 0xAA); // 已下载的前缀（模拟中断前的 .tmp）
  const rest = Buffer.alloc(48 * 1024, 0xBB);   // 服务器本次返回的剩余部分
  const { server, url } = await startServer((req, res) => {
    const range = req.headers['range'];
    assert.ok(range, 'resumeOffset>0 时应发送 Range 头');
    assert.strictEqual(range, `bytes=${prefix.length}-`);
    res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Length': rest.length });
    res.end(rest);
  });
  const savePath = tmpFile('resume.bin');
  // 预置"中断残留"的 .tmp（正常流程由上一次失败下载留下）
  fs.writeFileSync(savePath + '.tmp', prefix);
  try {
    await downloadFile(url + '/file.mp3', savePath, () => {}, {}, 0, { ...OPTS, resumeOffset: prefix.length });
    assert.ok(fs.existsSync(savePath));
    const finalBuf = fs.readFileSync(savePath);
    assert.strictEqual(finalBuf.length, prefix.length + rest.length, '最终 = 前缀 + 剩余');
    // 校验内容拼接正确（前 16K 是 0xAA，后 48K 是 0xBB）
    assert.ok(finalBuf.subarray(0, prefix.length).equals(prefix));
    assert.ok(finalBuf.subarray(prefix.length).equals(rest));
  } finally {
    server.close();
    fs.rmSync(savePath, { force: true });
    fs.rmSync(savePath + '.tmp', { force: true });
  }
});

test('downloadFile: 带偏移但服务器回 200 全量重发 → 覆盖写不拼接', async () => {
  const full = Buffer.alloc(64 * 1024, 0xEE);
  const { server, url } = await startServer((req, res) => {
    // 模拟不支持 Range 的服务器：忽略 Range 头，200 全量回
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': full.length });
    res.end(full);
  });
  const savePath = tmpFile('resend.bin');
  fs.writeFileSync(savePath + '.tmp', Buffer.alloc(16 * 1024, 0xAA)); // 旧的残留前缀
  try {
    await downloadFile(url + '/file.mp3', savePath, () => {}, {}, 0, { ...OPTS, resumeOffset: 16 * 1024 });
    const finalBuf = fs.readFileSync(savePath);
    assert.strictEqual(finalBuf.length, full.length, '全量重发时不应叠加旧前缀');
    assert.ok(finalBuf.equals(full), '内容应为服务器全量数据');
  } finally {
    server.close();
    fs.rmSync(savePath, { force: true });
    fs.rmSync(savePath + '.tmp', { force: true });
  }
});

test('downloadFile: 403 → 拒绝且清理 .tmp', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
  });
  const savePath = tmpFile('403.bin');
  try {
    await assert.rejects(
      downloadFile(url + '/file.mp3', savePath, () => {}, {}, 0, OPTS),
      /HTTP 403/
    );
    assert.ok(!fs.existsSync(savePath), '失败时不应有目标文件');
    assert.ok(!fs.existsSync(savePath + '.tmp'), '失败时 .tmp 应被清理');
  } finally {
    server.close();
    fs.rmSync(savePath, { force: true });
    fs.rmSync(savePath + '.tmp', { force: true });
  }
});

test('downloadFile: 200 + text/html → 识别为 CDN 错误页并拒绝', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>CDN ERROR: url signature expired</body></html>');
  });
  const savePath = tmpFile('errpage.bin');
  try {
    await assert.rejects(
      downloadFile(url + '/file.mp3', savePath, () => {}, {}, 0, OPTS),
      /HTML/
    );
    assert.ok(!fs.existsSync(savePath), 'HTML 错误页不应被写为音频文件');
    assert.ok(!fs.existsSync(savePath + '.tmp'), '.tmp 应被清理');
  } finally {
    server.close();
    fs.rmSync(savePath, { force: true });
    fs.rmSync(savePath + '.tmp', { force: true });
  }
});
