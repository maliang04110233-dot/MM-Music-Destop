'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// dlStatus.js 是 ESM 且只引用全局 api / window（均带守卫），node 下动态导入即可
async function fresh() {
  const m = await import('../src/renderer/js/dlStatus.js?tc=' + Math.random());
  m._resetDlStatus();
  return m;
}

const song = (source, id) => ({ source, id, title: 't' });

test('songDlKey：缺 source 或 id 返回 null', async () => {
  const m = await fresh();
  assert.strictEqual(m.songDlKey(song('netease', 123)), 'netease:123');
  assert.strictEqual(m.songDlKey({ id: 1 }), null);
  assert.strictEqual(m.songDlKey({ source: 'qq' }), null);
  assert.strictEqual(m.songDlKey(null), null);
});

test('dlStatusFor：downloading > queued > done，无状态 null', async () => {
  const m = await fresh();
  const a = song('netease', 1), b = song('netease', 2), c = song('qq', 3);
  const queue = [
    { ...a, status: 'downloading' }, { ...b, status: 'pending' }, { ...c, status: 'done' },
  ];
  m.dlObserveQueue(queue); // done 项进跨会话集合
  assert.strictEqual(m.dlStatusFor(a, queue), 'downloading');
  assert.strictEqual(m.dlStatusFor(b, queue), 'queued');
  assert.strictEqual(m.dlStatusFor(c, queue), 'done'); // queue 内 done
  assert.strictEqual(m.dlStatusFor(song('netease', 99), queue), null);
  assert.strictEqual(m.dlStatusFor(a, null), null);   // 无队列且历史未含
});

test('dlStatusFor：同曲多条队列项取更高优先级', async () => {
  const m = await fresh();
  const s = song('qq', 7);
  const queue = [{ ...s, status: 'pending' }, { ...s, status: 'downloading' }];
  assert.strictEqual(m.dlStatusFor(s, queue), 'downloading');
});

test('dlObserveQueue：吸收 done 进跨会话集合，队列清空后仍标 done', async () => {
  const m = await fresh();
  const s = song('netease', 42);
  m.dlObserveQueue([{ ...s, status: 'done' }]);
  assert.strictEqual(m.dlStatusFor(s, []), 'done');
  assert.strictEqual(m.dlStatusFor(s, undefined), 'done');
});

test('dlObserveQueue：容忍非数组/null 项', async () => {
  const m = await fresh();
  m.dlObserveQueue(null);
  m.dlObserveQueue([null, undefined, { status: 'done' }]);
});

test('setDlChangeListener：observe 与历史加载各触发一次；回调抛错不外泄', async () => {
  const m = await fresh();
  let hits = 0;
  m.setDlChangeListener(() => { throw new Error('listener boom'); });
  m.dlObserveQueue([]); // 抛错被吞即通过
  m.setDlChangeListener(() => { hits++; });
  m.dlObserveQueue([song('x', 1)]);
  assert.strictEqual(hits, 1);
});

test('dlEnsureHistoryLoaded：懒加载 done 历史进集合，重复调用不二次请求', async () => {
  const m = await fresh();
  let calls = 0;
  globalThis.api = {
    queryHistory: async (opts) => {
      calls++;
      assert.strictEqual(opts.status, 'done');
      return { items: [{ source: 'netease', id: 777, status: 'done' }], total: 1 };
    },
  };
  try {
    await m.dlEnsureHistoryLoaded();
    await m.dlEnsureHistoryLoaded();
    assert.strictEqual(calls, 1);
    assert.strictEqual(m.dlStatusFor(song('netease', 777), []), 'done');
  } finally {
    delete globalThis.api;
  }
});

test('dlEnsureHistoryLoaded：api 抛错后可重试', async () => {
  const m = await fresh();
  let fail = true;
  globalThis.api = {
    queryHistory: async () => {
      if (fail) throw new Error('ipc down');
      return { items: [{ source: 'qq', id: 1 }] };
    },
  };
  try {
    await m.dlEnsureHistoryLoaded();
    assert.strictEqual(m.dlStatusFor(song('qq', 1), []), null);
    fail = false;
    await m.dlEnsureHistoryLoaded();
    assert.strictEqual(m.dlStatusFor(song('qq', 1), []), 'done');
  } finally {
    delete globalThis.api;
  }
});

test('dlBadgeHtml：三态静态文案，无歌曲信息时为空串', async () => {
  const m = await fresh();
  assert.strictEqual(m.dlBadgeHtml({ source: 'a' }, []), '');
  const html = m.dlBadgeHtml(song('netease', 5), [{ ...song('netease', 5), status: 'downloading' }]);
  assert.match(html, /dl-badge-downloading/);
  assert.match(html, /下载中/);
});
