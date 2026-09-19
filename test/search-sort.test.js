/**
 * searchSort 单元测试：模式循环 + pairs 稳定排序（无时长恒末尾、组内保序）
 */
const test = require('node:test');
const assert = require('node:assert');

async function fresh() {
  return import(`../src/renderer/js/searchSort.js?ck=${Math.random()}`);
}

test('nextSortMode：四档循环且标签齐全', async () => {
  const { nextSortMode, sortLabel, SORT_MODES } = await fresh();
  let m = 'default';
  const seq = [];
  for (let i = 0; i < 5; i++) { m = nextSortMode(m); seq.push(m); }
  assert.deepStrictEqual(seq, ['duration-desc', 'duration-asc', 'source', 'default', 'duration-desc']);
  assert.strictEqual(nextSortMode('bogus'), 'default'); // 未知模式从默认序起步，不炸
  for (const mode of SORT_MODES) assert.ok(sortLabel(mode).includes('↕'), mode);
  assert.strictEqual(sortLabel('nope'), '↕ 默认序');
});

test('sortPairs：时长升/降排序，无时长的行两种方向都固定在末尾', async () => {
  const { sortPairs } = await fresh();
  const pairs = [
    [{ title: 'A', duration: 200 }, 0],
    [{ title: 'B' }, 1],
    [{ title: 'C', duration: 60 }, 2],
    [{ title: 'D', duration: 0 }, 3],
    [{ title: 'E', duration: 120 }, 4],
  ];
  assert.deepStrictEqual(sortPairs(pairs, 'duration-desc').map(p => p[1]), [0, 4, 2, 1, 3]);
  assert.deepStrictEqual(sortPairs(pairs, 'duration-asc').map(p => p[1]), [2, 4, 0, 1, 3]);
  assert.deepStrictEqual(sortPairs(pairs, 'default').map(p => p[1]), [0, 1, 2, 3, 4]);
});

test('sortPairs：按来源分组稳定（组内保持抓取原序）', async () => {
  const { sortPairs } = await fresh();
  const pairs = [
    [{ title: 'a', source: 'qq' }, 0],
    [{ title: 'b', source: 'netease' }, 1],
    [{ title: 'c', source: 'qq' }, 2],
    [{ title: 'd', source: 'kugou' }, 3],
  ];
  assert.deepStrictEqual(sortPairs(pairs, 'source').map(p => p[1]), [3, 1, 0, 2]);
});

test('sortPairs：畸形输入静默安全', async () => {
  const { sortPairs } = await fresh();
  assert.deepStrictEqual(sortPairs(undefined, 'source'), []);
  assert.deepStrictEqual(sortPairs(null, 'duration-desc'), []);
  assert.deepStrictEqual(sortPairs('not-an-array', 'source'), []);
  const weird = [[null, 0], [{ duration: 100 }, 1], undefined];
  assert.deepStrictEqual(sortPairs(weird, 'duration-desc').map(p => p && p[1]), [1, 0, undefined]);
});
