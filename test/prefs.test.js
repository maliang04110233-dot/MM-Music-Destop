/**
 * 单元测试：utils/prefs.js
 *
 * 跑：npm test
 *
 * 验证：set / get / 持久化 / 防抖写盘 / flush 立即写
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-test-'));
}

test('prefs: 简单 get/set 走内存缓存', () => {
  const dir = makeTempDir();
  const prefs = require('../src/utils/prefs');
  prefs.init(dir);
  prefs.set('saveDir', '/music/downloads');
  assert.strictEqual(prefs.get('saveDir'), '/music/downloads');
  // 不存在的 key
  assert.strictEqual(prefs.get('nope'), undefined);
  assert.strictEqual(prefs.get('nope', 'default'), 'default');
  prefs.destroy();  // 取消防抖写盘，避免删目录后 race
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prefs: 写盘后重新 init 能读回', async () => {
  const dir = makeTempDir();
  // 第一次：写
  const p1 = require('../src/utils/prefs');
  p1.init(dir);
  p1.set('saveDir', '/foo/bar');
  p1.set('localDirPath', '/music/library');
  p1.flush();  // 同步写盘
  p1.destroy();

  // 模拟重启：清模块缓存
  delete require.cache[require.resolve('../src/utils/prefs')];
  const p2 = require('../src/utils/prefs');
  p2.init(dir);
  assert.strictEqual(p2.get('saveDir'), '/foo/bar');
  assert.strictEqual(p2.get('localDirPath'), '/music/library');
  p2.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prefs: set 同一个 key 多次取最新', () => {
  const dir = makeTempDir();
  const prefs = require('../src/utils/prefs');
  prefs.init(dir);
  prefs.set('saveDir', '/v1');
  prefs.set('saveDir', '/v2');
  prefs.set('saveDir', '/v3');
  assert.strictEqual(prefs.get('saveDir'), '/v3');
  prefs.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prefs: 没 init 时 get 不抛错（返回 undefined）', () => {
  delete require.cache[require.resolve('../src/utils/prefs')];
  const prefs = require('../src/utils/prefs');
  // 不调 init，直接 get —— 应该静默返回 undefined
  assert.strictEqual(prefs.get('anything'), undefined);
});

test('prefs: 损坏文件 → 备份 .bak + 空对象起步，新写入可恢复', async () => {
  const dir = makeTempDir();
  // 模拟半写损坏
  fs.writeFileSync(path.join(dir, 'prefs.json'), '{"saveDir": "/foo', 'utf8');

  const p = require('../src/utils/prefs');
  p.init(dir);
  assert.strictEqual(p.get('saveDir'), undefined, '损坏后不残留旧值');
  assert.ok(fs.existsSync(path.join(dir, 'prefs.json.bak')), '损坏文件应备份 .bak');

  // 新写入覆盖损坏文件
  p.set('saveDir', '/new/path');
  p.flush();
  p.destroy();

  // 重启读回
  delete require.cache[require.resolve('../src/utils/prefs')];
  const p2 = require('../src/utils/prefs');
  p2.init(dir);
  assert.strictEqual(p2.get('saveDir'), '/new/path');
  p2.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});
