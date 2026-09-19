/**
 * commandPalette 单元测试：fuzzyScore 打分梯度 + rankCommands 排序/过滤
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import(`../src/renderer/js/commandPalette.js?ck=${Math.random()}`);
}

test('fuzzyScore：前缀 > 包含（越靠前越高） > ASCII 子序列 > 不匹配', async () => {
  const { fuzzyScore } = await fresh();
  assert.strictEqual(fuzzyScore('', '任意'), 0);
  assert.strictEqual(fuzzyScore('PLAY', 'Play 播放'), 200);
  assert.strictEqual(fuzzyScore('play', '播放 Play'), 117); // 包含但非前缀：120 - 位置
  const early = fuzzyScore('搜索', '前往 搜索曲库');
  const late = fuzzyScore('搜索', '清理缓存并搜索');
  assert.ok(early > late && late > 0, `包含位置越前应分越高: ${early} vs ${late}`);
  assert.strictEqual(fuzzyScore('pdw', '前往 下载 PlayDoW'), 20); // ASCII 子序列
  assert.strictEqual(fuzzyScore('下载', '播放队列'), -1);
  assert.strictEqual(fuzzyScore('xqz', '中文不做子序列'), -1); // 非 ASCII 不走子序列
});

test('rankCommands：空查询返回全量原序；有查询按分排序并截断', async () => {
  const { rankCommands } = await fresh();
  const cmds = [
    { id: 'a', label: '前往 下载' },
    { id: 'b', label: '播放 / 暂停', keywords: ['play'] },
    { id: 'c', label: '清理播放缓存', keywords: ['cache', '缓存'] },
  ];
  assert.deepStrictEqual(rankCommands('', cmds).map(c => c.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(rankCommands('缓存', cmds).map(c => c.id), ['c']);
  assert.deepStrictEqual(rankCommands('play', cmds).map(c => c.id), ['b']); // keywords 兜底（中文 label 不含 ASCII 'play'）
  assert.deepStrictEqual(rankCommands('zzzz', cmds), []);
  assert.deepStrictEqual(rankCommands(null, null), []);
});

test('rankCommands：畸形条目（无 label/null）静默忽略，不抛错', async () => {
  const { rankCommands } = await fresh();
  const cmds = [null, { id: 'x' }, { id: 'y', label: '睡眠定时' }];
  assert.deepStrictEqual(rankCommands('睡眠', cmds).map(c => c.id), ['y']);
});

test('内置 COMMANDS 清单：id 唯一且每条都有 label/icon/run', async () => {
  const { COMMANDS } = await fresh();
  assert.ok(COMMANDS.length >= 18, '命令数不应少于 18');
  const ids = new Set();
  for (const c of COMMANDS) {
    assert.ok(c.id && c.label && c.icon && typeof c.run === 'function', '命令字段不全: ' + JSON.stringify(c.id));
    assert.ok(!ids.has(c.id), '重复 id: ' + c.id);
    ids.add(c.id);
  }
});
