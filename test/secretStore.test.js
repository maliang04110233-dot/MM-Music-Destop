/**
 * 单元测试：utils/secretStore.js —— 凭证本地加密封装
 *
 * 为什么值得测（2026-09 审计：README 承诺"加密存储"但零回归防护）：
 * 本模块的降级路径是刻意的（纯 Node / safeStorage 不可用 → 明文透传），
 * 一旦有人把透传"修"成抛错，或把迁移语义（无前缀值原样返回）改坏，
 * cookie/备份导入会静默炸。这些行为必须钉住。
 *
 * 说明：单测环境 require('electron') 拿不到 app/safeStorage，
 * 走的正是「不可用」分支 —— 这恰好是备份回导入/换机场景的真实形态。
 */

const test = require('node:test');
const assert = require('node:assert');

const secretStore = require('../src/utils/secretStore');

test('纯 Node 环境 canEncrypt 为 false（降级路径生效）', () => {
  assert.strictEqual(secretStore.canEncrypt(), false);
});

test('encrypt: 不可加密时明文透传，不抛错（README 承诺的降级行为）', () => {
  assert.strictEqual(secretStore.encrypt('abc123'), 'abc123');
});

test('encrypt: 空值/非字符串原样返回', () => {
  assert.strictEqual(secretStore.encrypt(''), '');
  assert.strictEqual(secretStore.encrypt(null), null);
  assert.strictEqual(secretStore.encrypt(undefined), undefined);
});

test('encrypt: 已带 enc:v1: 前缀的值不二次包装（备份回导入幂等）', () => {
  const wrapped = 'enc:v1:someBase64Ciphertext';
  assert.strictEqual(secretStore.encrypt(wrapped), wrapped);
});

test('decrypt: 无前缀的历史明文原样返回（下次写入即完成迁移）', () => {
  assert.strictEqual(secretStore.decrypt('legacy-plain-cookie'), 'legacy-plain-cookie');
  assert.strictEqual(secretStore.decrypt(''), '');
  assert.strictEqual(secretStore.decrypt(null), null);
});

test('decrypt: 有前缀但密钥不可用（换机/换用户）→ 空串按未配置处理', () => {
  assert.strictEqual(secretStore.decrypt('enc:v1:whateverBase64'), '');
});

test('decrypt: 前缀本身（空密文）也返回空串而不是前缀', () => {
  assert.strictEqual(secretStore.decrypt('enc:v1:'), '');
});
