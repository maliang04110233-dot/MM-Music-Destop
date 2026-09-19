/**
 * 单元测试：diagnose.js —— 失败分类纯函数
 *
 * classifyFailure：码表优先 → 关键词兜底 → 未分类，三层永不落空；
 * heal 动作只能是 settings/retry/null，驱动弹层按钮的显隐。
 */

const test = require('node:test');
const assert = require('node:assert');

async function fresh() {
  return import(`../src/renderer/js/diagnose.js?ck=${Math.random()}`);
}

test('classifyFailure: 码表命中优先于文本关键词', async () => {
  const { classifyFailure } = await fresh();
  const d = classifyFailure('AUTH_EXPIRED', 'some timeout');
  assert.equal(d.code, 'AUTH_EXPIRED');
  assert.equal(d.heal, 'settings');
  assert.match(d.cause, /Cookie/);
});

test('classifyFailure: 全部码表码都有非空 cause/advice 且 heal 合法', async () => {
  const { classifyFailure } = await fresh();
  for (const code of ['VIP_REQUIRED', 'AUTH_EXPIRED', 'LOGIN_REQUIRED', 'COPYRIGHT_RESTRICTED',
    'UNAVAILABLE', 'CDN_EMPTY', 'NETWORK_TIMEOUT', 'NO_AUDIO_STREAM', 'UNKNOWN_PLATFORM']) {
    const d = classifyFailure(code, '');
    assert.ok(d.cause && d.advice, `${code} 缺文案`);
    assert.ok([null, 'settings', 'retry'].includes(d.heal), `${code} heal 非法: ${d.heal}`);
  }
});

test('classifyFailure: 未知码走文本关键词兜底', async () => {
  const { classifyFailure } = await fresh();
  assert.match(classifyFailure('SOMETHING', 'Error: ENOSPC no space left').cause, /磁盘/);
  assert.equal(classifyFailure('', 'ETIMEDOUT').heal, 'retry');
  assert.match(classifyFailure('', 'HTTP 403 Forbidden').cause, /鉴权/);
  assert.match(classifyFailure('', 'need VIP to download').cause, /VIP/);
});

test('classifyFailure: 全不命中归未分类且可重试，空输入不炸', async () => {
  const { classifyFailure } = await fresh();
  const d = classifyFailure(null, 'weird platform hiccup');
  assert.equal(d.code, 'UNKNOWN');
  assert.equal(d.heal, 'retry');
  const e = classifyFailure(undefined, undefined);
  assert.equal(e.code, 'UNKNOWN');
  assert.ok(e.cause && e.advice);
});
