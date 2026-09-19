/**
 * index.html 静态守护：id 全局唯一 + 本地批量进度元素命名回归钉
 *
 * 背景（2026-09-19 修复的真 bug）：搜索页与本地页曾共用
 * batchProgressWrap/batchProgressLabel 双 id，getElementById 永远命中
 * 隐藏的搜索页元素，导致本地库批量补封面/歌词/转码进度条整体不可见。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

test('index.html 所有 id="..." 全局唯一', () => {
  const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.ok(ids.length > 50, `应解析出大量 id，实际 ${ids.length}`);
  const seen = new Map();
  for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
  const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepStrictEqual(dups, [], `存在重复 id: ${dups.join(', ')}`);
});

test('本地批量进度三件套使用 localBatch* 前缀（防止回退成与搜索页冲突的旧 id）', () => {
  for (const id of ['localBatchProgressWrap', 'localBatchProgressLabel', 'localBatchProgressBar', 'probeProgressWrap']) {
    assert.ok(HTML.includes(`id="${id}"`), `index.html 应包含 id=${id}`);
  }
  assert.ok(!/id="batchProgress(Wrap|Label|Bar)"/.test(HTML.split('id="localPage"')[1] || ''),
    '本地页区域不得再出现无前缀的 batchProgress* id');
});
