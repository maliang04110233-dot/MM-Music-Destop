/**
 * 单元测试：主进程未捕获拒绝归口
 *
 * 这是一个「必须可信」的闸门：如果 classifyRejection 永远返回 thirdParty=true，
 * 那么 e2e 里「本仓无未捕获拒绝」这条断言就永远为真 —— 变成一个摆设。
 * 所以这里不仅测分类，还测**分类器能真的抓到本仓来源**（反假绿）。
 */

const test = require('node:test');
const assert = require('node:assert');
const { classifyRejection, installRejectionGuard, TAG_OURS, TAG_THIRD_PARTY } = require('../src/utils/rejectionGuard');

function errAt(framePath, msg = 'boom') {
  const e = new Error(msg);
  e.stack = `${e.name}: ${msg}\n    at someFn (${framePath}:10:5)`;
  return e;
}

// ── classifyRejection ─────────────────────────────────────

test('classifyRejection: 栈帧在 node_modules 里 → 判为第三方', () => {
  const r = classifyRejection(errAt('C:\\proj\\node_modules\\qq-music-api\\routes\\songlist.js'));
  assert.strictEqual(r.thirdParty, true);
  assert.strictEqual(r.message, 'boom');
  assert.ok(r.firstFrame.includes('songlist.js'), '应带出首个栈帧用于溯源');
});

test('classifyRejection: 栈帧在本仓 → 判为非第三方（不能漏判，否则闸门假绿）', () => {
  const r = classifyRejection(errAt('C:\\proj\\src\\api\\platforms\\qq.js'));
  assert.strictEqual(r.thirdParty, false);
  assert.strictEqual(r.message, 'boom');
});

test('classifyRejection: 非 Error 的拒绝原因也能处理（Promise.reject("字符串")）', () => {
  assert.strictEqual(classifyRejection('字符串原因').message, '字符串原因');
  assert.strictEqual(classifyRejection('字符串原因').thirdParty, false);
  assert.strictEqual(classifyRejection(undefined).message, 'unknown');
  assert.strictEqual(classifyRejection(null).message, 'unknown');
  assert.strictEqual(classifyRejection(0).message, 'unknown');
});

test('classifyRejection: 无栈的信息被保留在 stack 字段（便于落日志）', () => {
  const r = classifyRejection('no stack');
  assert.strictEqual(r.stack, 'no stack');
  assert.strictEqual(r.firstFrame, '');
});

// ── installRejectionGuard ─────────────────────────────────

/** 假 process + 假 logger，捕获注册与输出 */
function fakeEnv() {
  const handlers = {};
  const out = { warn: [], error: [] };
  return {
    proc: { on: (ev, fn) => { handlers[ev] = fn; } },
    logger: { warn: (m) => out.warn.push(m), error: (m) => out.error.push(m) },
    handlers,
    out,
  };
}

test('installRejectionGuard: 注册到 unhandledRejection，不注册别的钩子', () => {
  const e = fakeEnv();
  assert.strictEqual(installRejectionGuard(e), true);
  assert.deepStrictEqual(Object.keys(e.handlers), ['unhandledRejection']);
  assert.strictEqual(typeof e.handlers.unhandledRejection, 'function');
});

test('installRejectionGuard: 第三方泄漏走 warn 且带 TAG 与首个栈帧', () => {
  const e = fakeEnv();
  installRejectionGuard(e);
  e.handlers.unhandledRejection(errAt('C:\\p\\node_modules\\qq-music-api\\routes\\new.js', 'Cannot read properties of undefined'));
  assert.strictEqual(e.out.error.length, 0);
  assert.strictEqual(e.out.warn.length, 1);
  assert.ok(e.out.warn[0].startsWith(TAG_THIRD_PARTY));
  assert.ok(e.out.warn[0].includes('Cannot read properties of undefined'));
  assert.ok(e.out.warn[0].includes('new.js'));
});

test('installRejectionGuard: 本仓漏网走 error 且带完整栈（不被上游噪音掩盖）', () => {
  const e = fakeEnv();
  installRejectionGuard(e);
  e.handlers.unhandledRejection(errAt('C:\\p\\src\\main\\ipc\\search.js', '本仓漏了 catch'));
  assert.strictEqual(e.out.warn.length, 0);
  assert.strictEqual(e.out.error.length, 1);
  assert.ok(e.out.error[0].startsWith(TAG_OURS));
  assert.ok(e.out.error[0].includes('search.js'), 'error 分支应保留完整栈');
});

test('installRejectionGuard: 处理器自身不抛异常（否则会引发二次 unhandledRejection 风暴）', () => {
  const e = fakeEnv();
  installRejectionGuard({ proc: e.proc, logger: { warn: () => { throw new Error('logger 坏了'); }, error: () => {} } });
  assert.doesNotThrow(() => e.handlers.unhandledRejection(errAt('C:\\p\\node_modules\\x.js')));
});

test('installRejectionGuard: proc 不可用时返回 false 而不是抛错', () => {
  assert.strictEqual(installRejectionGuard({ proc: null, logger: { warn() {}, error() {} } }), false);
  assert.strictEqual(installRejectionGuard({ proc: {}, logger: { warn() {}, error() {} } }), false);
});

test('TAG 字面量固定（e2e 闸门按它们判定，改动必须同步）', () => {
  assert.strictEqual(TAG_OURS, '[未捕获拒绝·本仓]');
  assert.strictEqual(TAG_THIRD_PARTY, '[未捕获拒绝·第三方]');
});
