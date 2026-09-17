/**
 * 单元测试：utils/fsAsync.js 与 atomicFile 的异步变体
 *
 * 跑：npm test
 *
 * 背景：主进程是 Electron 的 UI 线程，fs.*Sync 会阻塞消息循环导致窗口卡死。
 * 本测试锁定 fsAsync 的语义——尤其「永不抛错」的 exists/sizeOf，
 * 以及 atomicFile 异步变体必须保持与同步版一致的原子写 + 损坏备份行为。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fsa = require('../src/utils/fsAsync');
const { atomicWriteJsonAsync, safeReadJsonAsync, atomicWriteJson, safeReadJson } = require('../src/utils/atomicFile');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsasync-test-'));
}

// ── exists：替代 existsSync，且永不抛错 ────────────────────────

test('fsAsync.exists: 存在为 true，不存在为 false', async () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'a.txt');
  fs.writeFileSync(fp, 'hi');
  assert.strictEqual(await fsa.exists(fp), true);
  assert.strictEqual(await fsa.exists(path.join(dir, 'nope.txt')), false);
  assert.strictEqual(await fsa.exists(dir), true, '目录也算存在');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fsAsync.exists: 非法入参返回 false 而非抛错', async () => {
  // 主进程 IPC 的 path 来自渲染层，必须容忍 null/undefined/超长路径
  assert.strictEqual(await fsa.exists(null), false);
  assert.strictEqual(await fsa.exists(undefined), false);
  assert.strictEqual(await fsa.exists(123), false);
  assert.strictEqual(await fsa.exists(''), false);
});

// ── statOrNull / sizeOf ──────────────────────────────────────

test('fsAsync.statOrNull: 命中返回 Stats，未命中返回 null', async () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'b.txt');
  fs.writeFileSync(fp, 'hello');
  const st = await fsa.statOrNull(fp);
  assert.ok(st && typeof st.size === 'number');
  assert.strictEqual(st.size, 5);
  assert.strictEqual(await fsa.statOrNull(path.join(dir, 'nope')), null);
  assert.strictEqual(await fsa.statOrNull(null), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fsAsync.sizeOf: 文件返回字节数，不存在返回 null', async () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'c.txt');
  fs.writeFileSync(fp, 'abcd');
  assert.strictEqual(await fsa.sizeOf(fp), 4);
  assert.strictEqual(await fsa.sizeOf(path.join(dir, 'nope')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── ensureDir / removeQuiet ──────────────────────────────────

test('fsAsync.ensureDir: 嵌套创建且幂等', async () => {
  const dir = makeTempDir();
  const nested = path.join(dir, 'x', 'y', 'z');
  await fsa.ensureDir(nested);
  assert.strictEqual(fs.existsSync(nested), true);
  // 再次调用不应抛 EEXIST
  await fsa.ensureDir(nested);
  assert.strictEqual(fs.existsSync(nested), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fsAsync.removeQuiet: 删除已存在文件，不存在时不抛错', async () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'd.txt');
  fs.writeFileSync(fp, 'x');
  await fsa.removeQuiet(fp);
  assert.strictEqual(fs.existsSync(fp), false);
  // 再来一次（此时文件已不存在）不应抛
  await fsa.removeQuiet(fp);
  assert.strictEqual(await fsa.removeQuiet(null), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── tryReadText / readJson / writeJson ───────────────────────

test('fsAsync.tryReadText: 读到内容，缺失返回 null', async () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'e.txt');
  fs.writeFileSync(fp, '中文内容', 'utf8');
  assert.strictEqual(await fsa.tryReadText(fp), '中文内容');
  assert.strictEqual(await fsa.tryReadText(path.join(dir, 'nope.txt')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fsAsync.writeJson/readJson: 往返一致', async () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'f.json');
  await fsa.writeJson(fp, { a: 1, b: ['中文', 2] });
  const back = await fsa.readJson(fp);
  assert.deepStrictEqual(back, { a: 1, b: ['中文', 2] });
  // 缺失/损坏返回 null 而非抛错
  assert.strictEqual(await fsa.readJson(path.join(dir, 'nope.json')), null);
  fs.writeFileSync(fp, '{ 坏 JSON');
  assert.strictEqual(await fsa.readJson(fp), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── atomicFile 异步变体：必须与同步版行为一致 ────────────────

test('atomicWriteJsonAsync: 写入成功且不留 .tmp 残留', async () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'g.json');
  await atomicWriteJsonAsync(fp, { k: 'v' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(fp, 'utf8')), { k: 'v' });
  assert.strictEqual(fs.existsSync(fp + '.tmp'), false, '临时文件必须已被 rename 消费');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomicWriteJsonAsync: 覆盖已有文件是原子替换', async () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'h.json');
  fs.writeFileSync(fp, JSON.stringify({ old: true }));
  await atomicWriteJsonAsync(fp, { fresh: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(fp, 'utf8')), { fresh: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('safeReadJsonAsync: 缺失为空、正常可读、损坏备份 .bak', async () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'i.json');

  // 缺失 → ok:true + empty:true（与同步版语义一致）
  const missing = await safeReadJsonAsync(fp);
  assert.strictEqual(missing.ok, true);
  assert.strictEqual(missing.empty, true);

  // 正常
  fs.writeFileSync(fp, JSON.stringify({ n: 1 }));
  const good = await safeReadJsonAsync(fp);
  assert.strictEqual(good.ok, true);
  assert.deepStrictEqual(good.data, { n: 1 });

  // 损坏 → ok:false 且备份 .bak，原文件保留
  fs.writeFileSync(fp, '{ 坏掉');
  const bad = await safeReadJsonAsync(fp);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(fs.existsSync(fp + '.bak'), true, '损坏文件必须先备份再返回');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomicFile 异步变体与同步变体语义对齐', async () => {
  const dir = makeTempDir();
  const syncFp = path.join(dir, 'sync.json');
  const asyncFp = path.join(dir, 'async.json');
  const payload = { 中文: '值', n: 42, arr: [1, 2] };

  atomicWriteJson(syncFp, payload);
  await atomicWriteJsonAsync(asyncFp, payload);
  assert.strictEqual(fs.readFileSync(syncFp, 'utf8'), fs.readFileSync(asyncFp, 'utf8'));

  const syncRead = safeReadJson(syncFp);
  const asyncRead = await safeReadJsonAsync(asyncFp);
  assert.deepStrictEqual(asyncRead.data, syncRead.data);
  fs.rmSync(dir, { recursive: true, force: true });
});
