/**
 * atomicFile 单测：原子写 + 损坏备份读取
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteJson, safeReadJson } = require('../src/utils/atomicFile');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomictest-'));

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('atomicWriteJson: 写入后可读回，无 .tmp 残留', () => {
  const fp = path.join(tmpRoot, 'a.json');
  atomicWriteJson(fp, { x: 1 });
  assert.strictEqual(JSON.parse(fs.readFileSync(fp, 'utf8')).x, 1);
  assert.ok(!fs.existsSync(fp + '.tmp'), '不应残留 tmp 文件');
});

test('atomicWriteJson: 覆盖旧内容完整替换', () => {
  const fp = path.join(tmpRoot, 'b.json');
  atomicWriteJson(fp, { v: 1 });
  atomicWriteJson(fp, { v: 2, extra: true });
  const back = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.strictEqual(back.v, 2);
  assert.strictEqual(back.extra, true);
});

test('safeReadJson: 不存在返回 empty', () => {
  const r = safeReadJson(path.join(tmpRoot, 'missing.json'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.empty, true);
});

test('safeReadJson: 空白文件返回 empty', () => {
  const fp = path.join(tmpRoot, 'blank.json');
  fs.writeFileSync(fp, '   \n', 'utf8');
  const r = safeReadJson(fp);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.empty, true);
});

test('safeReadJson: 损坏 JSON 备份 .bak 并返回 ok=false', () => {
  const fp = path.join(tmpRoot, 'corrupt.json');
  fs.writeFileSync(fp, '{"half": ', 'utf8'); // 半写状态
  const r = safeReadJson(fp);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.empty, false);
  assert.ok(fs.existsSync(fp + '.bak'), '应生成 .bak 备份');
  assert.strictEqual(fs.readFileSync(fp + '.bak', 'utf8'), '{"half": ');
  // 原文件保持不动（等下次原子写覆盖）
  assert.strictEqual(fs.readFileSync(fp, 'utf8'), '{"half": ');
});

test('safeReadJson: 正常 JSON 返回数据', () => {
  const fp = path.join(tmpRoot, 'good.json');
  atomicWriteJson(fp, [1, 2, 3]);
  const r = safeReadJson(fp);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, [1, 2, 3]);
});

test('端到端：损坏 → 备份 → 原子写覆盖 → 可正常读取', () => {
  const fp = path.join(tmpRoot, 'e2e.json');
  fs.writeFileSync(fp, 'garbage{', 'utf8');
  let r = safeReadJson(fp);
  assert.strictEqual(r.ok, false);
  assert.ok(fs.existsSync(fp + '.bak'));
  // 模拟调用方行为：拿到 null 后走默认值，下次写入覆盖损坏文件
  atomicWriteJson(fp, { recovered: true });
  r = safeReadJson(fp);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, { recovered: true });
});
