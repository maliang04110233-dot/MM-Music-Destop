/**
 * secretStore 的「真实用户态」加固（2026-09 审计 P1）
 *
 * 旧实现把两种情形混为一谈，都走「明文透传」：
 *   A 不在 Electron 里（单测 / 脚本）—— 透传是对的，见 secretStore.test.js
 *   B 在 Electron 里但 safeStorage 不可用（DPAPI 被策略禁用 / 密钥环缺失）
 *     —— 透传意味着 cookie、WebDAV 密码、AI 计费 key 静默明文落盘。
 *
 * 本文件模拟 B（以及 B 恢复成可用时的自愈），钉住「拒绝写入」这条语义。
 * 需要拦截 Module._load 伪造 electron 的 API 面，故单独成文件
 * （每个测试文件独立进程，不会污染 secretStore.test.js 的纯 Node 环境）。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

/** 当前伪装的 electron 面；null 表示「不在 Electron 里」 */
let fakeElectron = null;

const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    if (fakeElectron === null) return originalLoad(request, parent, isMain);
    return fakeElectron;
  }
  return originalLoad(request, parent, isMain);
};

const SECRET_PATH = path.join(__dirname, '..', 'src', 'utils', 'secretStore');

/** 换一套 electron 伪装后重新加载模块 —— ready/unavailable 两态会被缓存，必须换实例 */
function loadSecret(electron) {
  fakeElectron = electron;
  delete require.cache[require.resolve(SECRET_PATH)];
  return require(SECRET_PATH);
}

const readySafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`CIPHER(${s})`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^CIPHER\(|\)$/g, ''),
};

test('安全存储不可用（Electron 内）⇒ encrypt 抛错，绝不返回明文', () => {
  const secret = loadSecret({ app: {}, safeStorage: { isEncryptionAvailable: () => false } });
  assert.strictEqual(secret.storageMode(), 'insecure');
  assert.strictEqual(secret.canEncrypt(), false);
  assert.throws(
    () => secret.encrypt('my-secret-cookie'),
    (e) => e.code === secret.ERR_SECRET_STORAGE_UNAVAILABLE,
    '不可用时必须抛 SecretStorageError，而不是把明文交给调用方',
  );
  assert.strictEqual(secret.tryEncrypt('my-secret-cookie'), null,
    'tryEncrypt 是「尽力而为」版本，返回 null 供调用方拒绝保存');
});

test('安全存储可用 ⇒ 正常加密；且不可用态不缓存（app ready 前误判可自愈）', () => {
  // 先在 insecure 态下探测一次
  const insecure = loadSecret({ app: {}, safeStorage: { isEncryptionAvailable: () => false } });
  assert.strictEqual(insecure.storageMode(), 'insecure');
  // 同一实例下把系统状态换成可用：insecure 不缓存，应立刻自愈
  fakeElectron = { app: {}, safeStorage: readySafeStorage };
  assert.strictEqual(insecure.storageMode(), 'ready',
    'insecure 态不得被缓存 —— 否则 app ready 前的误判会让用户永远存不进凭证');
  const enc = insecure.encrypt('my-secret-cookie');
  assert.match(enc, /^enc:v1:/);
  assert.strictEqual(insecure.decrypt(enc), 'my-secret-cookie', '加密后可原样解回');
});

test('加密过程本身失败（如密钥环异常）⇒ 同样抛错，不回退明文', () => {
  const secret = loadSecret({
    app: {},
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => { throw new Error('keyring exploded'); },
    },
  });
  assert.throws(
    () => secret.encrypt('another-secret'),
    (e) => e.code === secret.ERR_SECRET_STORAGE_UNAVAILABLE && /keyring exploded/.test(e.message),
  );
  assert.strictEqual(secret.tryEncrypt('another-secret'), null);
});

test('纯 Node 环境（require(electron) 无 API 面）仍保持明文透传的历史语义', () => {
  const secret = loadSecret(null);
  assert.strictEqual(secret.storageMode(), 'unavailable');
  assert.strictEqual(secret.canEncrypt(), false);
  assert.strictEqual(secret.encrypt('abc123'), 'abc123', '单测/脚本/备份导入依赖这条语义');
});

test('已带 enc:v1: 前缀的值在任何态下都不二次包装（备份回导入幂等）', () => {
  for (const electron of [
    null,
    { app: {}, safeStorage: { isEncryptionAvailable: () => false } },
    { app: {}, safeStorage: readySafeStorage },
  ]) {
    const secret = loadSecret(electron);
    assert.strictEqual(secret.encrypt('enc:v1:someBase64'), 'enc:v1:someBase64');
  }
});
