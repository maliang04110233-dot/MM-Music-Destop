/**
 * afterQueueDone 单元测试：isQueueFinished/hasActiveTasks 谓词 + createAfterQueueMachine 纯状态机
 */
const test = require('node:test');
const assert = require('node:assert');

// 模块顶层有 window 桥接赋值；logger.js 用 window.location
global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import(`../src/renderer/js/afterQueueDone.js?aqd=${Math.random()}`);
}

test('isQueueFinished：全终态才算完成，空队列/活跃/非数组都不算', async () => {
  const { isQueueFinished } = await fresh();
  assert.strictEqual(isQueueFinished([{ status: 'done' }, { status: 'error' }]), true);
  assert.strictEqual(isQueueFinished([{ status: 'done' }, { status: 'downloading' }]), false);
  assert.strictEqual(isQueueFinished([{ status: 'pending' }]), false);
  assert.strictEqual(isQueueFinished([]), false);
  assert.strictEqual(isQueueFinished(null), false);
  assert.strictEqual(isQueueFinished([{ status: 'weird' }]), false);
});

test('hasActiveTasks：只有 pending/downloading 算活跃', async () => {
  const { hasActiveTasks } = await fresh();
  assert.strictEqual(hasActiveTasks([{ status: 'downloading' }]), true);
  assert.strictEqual(hasActiveTasks([{ status: 'pending' }, { status: 'done' }]), true);
  assert.strictEqual(hasActiveTasks([{ status: 'done' }, { status: 'error' }]), false);
  assert.strictEqual(hasActiveTasks([]), false);
});

test('状态机：必须先见过活跃任务，启动恢复的全终态队列不误触', async () => {
  const { createAfterQueueMachine } = await fresh();
  const fires = [];
  const m = createAfterQueueMachine({ getAction: () => 'shutdown', onFire: a => fires.push(a) });
  m.observe([{ status: 'done' }, { status: 'error' }]); // 启动时持久化队列恢复
  assert.deepStrictEqual(fires, []);
  m.observe([{ status: 'downloading' }, { status: 'done' }]); // 用户新加任务
  m.observe([{ status: 'done' }, { status: 'done' }]);
  assert.deepStrictEqual(fires, ['shutdown']);
});

test('状态机：一次完成周期只触发一次，新活跃任务才重新武装', async () => {
  const { createAfterQueueMachine } = await fresh();
  let count = 0;
  const m = createAfterQueueMachine({ getAction: () => 'quit', onFire: () => { count++; } });
  m.observe([{ status: 'pending' }]);
  m.observe([{ status: 'done' }]);
  m.observe([{ status: 'done' }]); // 清空前多次推送全终态
  assert.strictEqual(count, 1);
  m.observe([{ status: 'downloading' }]); // 新周期
  m.observe([{ status: 'done' }]);
  assert.strictEqual(count, 2);
});

test('状态机：action 为 none/空 不触发；活跃中间态（混合）不触发', async () => {
  const { createAfterQueueMachine } = await fresh();
  let fired = 0;
  let action = 'none';
  const m = createAfterQueueMachine({ getAction: () => action, onFire: () => { fired++; } });
  m.observe([{ status: 'downloading' }]);
  m.observe([{ status: 'done' }]);
  assert.strictEqual(fired, 0);
  action = '';
  m.observe([{ status: 'pending' }]);
  m.observe([{ status: 'done' }]);
  assert.strictEqual(fired, 0);
});

test('状态机：onFire 抛异常被吞掉，机器仍可继续工作', async () => {
  const { createAfterQueueMachine } = await fresh();
  let attempts = 0;
  const m = createAfterQueueMachine({
    getAction: () => 'sleep',
    onFire: () => { attempts++; throw new Error('boom'); },
  });
  m.observe([{ status: 'downloading' }]);
  m.observe([{ status: 'done' }]);
  m.observe([{ status: 'pending' }]);
  m.observe([{ status: 'done' }]);
  assert.strictEqual(attempts, 2);
});

test('状态机：空数组/非法输入不打扰状态，reset 清除武装', async () => {
  const { createAfterQueueMachine } = await fresh();
  let fired = 0;
  const m = createAfterQueueMachine({ getAction: () => 'quit', onFire: () => { fired++; } });
  m.observe([{ status: 'downloading' }]);
  m.observe(null);
  m.observe('nope');
  m.reset();
  m.observe([{ status: 'done' }]);
  assert.strictEqual(fired, 0);
  m.observe([{ status: 'pending' }]);
  m.observe([{ status: 'done' }]);
  assert.strictEqual(fired, 1);
});
