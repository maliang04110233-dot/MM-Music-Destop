import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PREFETCH_LEAD_SEC, PREFETCH_TTL_MS, PREFETCH_MAX,
  createPrefetchStore, isEntryFresh, nextPrefetchIdx, prefetchKeyOf, shouldPrefetchNow,
} from '../src/renderer/js/playPrefetch.js';

const PLAYER_JS = readFileSync(new URL('../src/renderer/js/player.js', import.meta.url), 'utf8');

test('预热键只给需要联网取流的歌', () => {
  assert.equal(prefetchKeyOf({ source: 'Netease', id: 123 }), 'netease:123');
  assert.equal(prefetchKeyOf({ source: '  qq  ', id: ' 9 ' }), 'qq:9');
  assert.equal(prefetchKeyOf({ source: 'local', id: 1 }), null, '本地源不预热');
  assert.equal(prefetchKeyOf({ source: 'drop', id: 1 }), null, '拖入即播行不预热');
  assert.equal(prefetchKeyOf({ source: 'netease', id: 1, filePath: 'D:/a.mp3' }), null, '有 filePath 就是本地文件');
  assert.equal(prefetchKeyOf({ source: 'netease' }), null, '缺 id 无法定位，不预热');
  assert.equal(prefetchKeyOf({ id: 1 }), null, '缺 source 不预热');
  assert.equal(prefetchKeyOf(null), null);
});

test('下一首下标：不可预测就不预热', () => {
  assert.equal(nextPrefetchIdx(3, 0, {}), 1);
  assert.equal(nextPrefetchIdx(3, 2, {}), null, '不循环放到头');
  assert.equal(nextPrefetchIdx(3, 2, { loopMode: 1 }), 0, '列表循环回队首');
  assert.equal(nextPrefetchIdx(3, 1, { loopMode: 2 }), null, '单曲循环下一首还是自己');
  assert.equal(nextPrefetchIdx(3, 1, { isShuffled: true }), null, '随机不可预测');
  assert.equal(nextPrefetchIdx(0, 0, {}), null);
  assert.equal(nextPrefetchIdx(3, -1, {}), null, '未选中任何歌');
  assert.equal(nextPrefetchIdx(3, 9, {}), null, '下标越界（队列刚被改短）');
  assert.equal(nextPrefetchIdx(3, 0, { loopMode: 'x' }), 1, '脏 loopMode 走顺序路径');
});

test('时机判定：进入lead窗口才预热', () => {
  assert.equal(shouldPrefetchNow({ currentTime: 100, duration: 200 }), false);
  assert.equal(shouldPrefetchNow({ currentTime: 185, duration: 200 }), true);
  assert.equal(shouldPrefetchNow({ currentTime: 199.5, duration: 200 }), true);
  assert.equal(shouldPrefetchNow({ currentTime: 205, duration: 200 }), false, '已过终点不再预热');
  assert.equal(shouldPrefetchNow({ currentTime: 3, duration: Infinity }), false, '直播流不预热');
  assert.equal(shouldPrefetchNow({ currentTime: 3, duration: 0 }), false);
  assert.equal(shouldPrefetchNow({ currentTime: NaN, duration: 200 }), false);
  assert.equal(shouldPrefetchNow({ currentTime: 190, duration: 200, cached: true }), false, '缓存已有货');
  assert.equal(shouldPrefetchNow({ currentTime: 190, duration: 200, fetching: true }), false, '请求在飞不重复发');
  assert.equal(PREFETCH_LEAD_SEC, 20);
});

test('缓存：容量封顶、取用即失效、过期不返回', () => {
  let t = 1000;
  const store = createPrefetchStore(() => t);
  assert.equal(store.take('a'), null, '空缓存');
  store.put('a', { fileUrl: 'u1', quality: '320k' });
  assert.equal(store.has('a'), true);
  assert.equal(store.peek('a').quality, '320k', 'peek 不消费');
  assert.equal(store.take('a').fileUrl, 'u1');
  assert.equal(store.has('a'), false, 'take 之后必须没了');
  t += PREFETCH_TTL_MS + 1;
  store.put('b', { fileUrl: 'u2' });
  t += PREFETCH_TTL_MS + 1;
  assert.equal(store.has('b'), false, '过 TTL 即视为无货（平台直链会过期）');
  assert.equal(store.take('b'), null);
});

test('缓存：脏条目拒收，超出上限按插入序淘汰', () => {
  const store = createPrefetchStore(() => 0);
  assert.equal(store.put('x', { fileUrl: '' }), null, '无 URL 不算预热成功');
  assert.equal(store.put('x', null), null);
  assert.equal(store.size(), 0);
  store.put('k1', { fileUrl: 'u1' });
  store.put('k2', { fileUrl: 'u2' });
  store.put('k3', { fileUrl: 'u3' });
  assert.equal(store.size(), PREFETCH_MAX);
  assert.equal(store.has('k1'), false, '最老的先淘汰');
  assert.equal(store.has('k3'), true);
  assert.equal(isEntryFresh({ fileUrl: 'u', ts: 0 }, PREFETCH_TTL_MS), true, '边界内算新鲜');
  assert.equal(isEntryFresh({ fileUrl: 'u', ts: 0 }, PREFETCH_TTL_MS + 1), false);
  assert.equal(isEntryFresh(null, 0), false);
});

test('接线钉：player.js 命中缓存时跳过取流，未命中照原路', () => {
  assert.ok(PLAYER_JS.includes("import { createPrefetchStore, prefetchKeyOf, nextPrefetchIdx, shouldPrefetchNow } from './playPrefetch.js';"));
  assert.equal((PLAYER_JS.match(/const _prefetch = createPrefetchStore\(\);/g) || []).length, 1, '缓存只应有一份');
  const hitBlock = [
    '  const pkey = prefetchKeyOf(song);',
    '  const hit = pkey ? _prefetch.take(pkey) : null;',
    '  if (hit) {',
  ].join('\n');
  assert.ok(PLAYER_JS.includes(hitBlock), 'playSongByIdx 开头先查预热缓存');
  assert.ok(PLAYER_JS.includes('await loadAndPlay(song, hit.fileUrl, true);'), '命中就直接用预热好的直链开播');
  assert.ok(PLAYER_JS.includes('  const quality = resolveQuality(song.source);\n  const reqId = ++_playRequestId;'), '未命中走原有取流链路');
  // 顺序钉：缓存分支必须在原取流之前，否则预热永不生效
  assert.ok(PLAYER_JS.indexOf(hitBlock) < PLAYER_JS.indexOf('  const quality = resolveQuality(song.source);'));
  // 命中分支要作废在飞的旧取流请求，否则快速连点会让上一首的结果后到并覆盖
  assert.ok(PLAYER_JS.includes('++_playRequestId; // 命中预取：作废仍在飞的旧取流'));
  assert.ok(PLAYER_JS.includes('_startPrefetch();'), '有预热入口');
  assert.ok(PLAYER_JS.includes("if (!shouldPrefetchNow({ currentTime: audio.currentTime, duration: audio.duration })) return;"), 'timeupdate 里按窗口触发');
  assert.equal((PLAYER_JS.match(/api\.getDownloadUrlSmart\(song, quality\)/g) || []).length, 2, '原路 + 预热路各一次');
});
