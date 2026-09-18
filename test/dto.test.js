/**
 * 单元测试：shared/dto.js —— 跨层数据契约
 *
 * 这里钉的是「形状」而非「业务」：
 *   - isSongLike 是各平台返回数据进入 UI 前的**过滤器**，放宽会让脏条目进列表；
 *   - normalizeSong / normalizeTrackResult 必须**幂等**，否则重复归一化会漂移；
 *   - normalizeTrackResult 对失败的规范决定了换源流程能否读到 code。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  REQUIRED_SONG_FIELDS,
  isSongLike,
  normalizeSong,
  isTrackSuccess,
  normalizeTrackResult,
} = require('../src/shared/dto');

// ── isSongLike ────────────────────────────────────────────

test('isSongLike: 必需字段齐全 ⇒ true', () => {
  assert.strictEqual(isSongLike({ id: '1', source: 'qq', title: 't' }), true);
});

test('isSongLike: REQUIRED_SONG_FIELDS 与实现一致（改字段须同步）', () => {
  assert.deepStrictEqual([...REQUIRED_SONG_FIELDS], ['id', 'source', 'title']);
});

test('isSongLike: 缺任一必需字段 ⇒ false', () => {
  assert.strictEqual(isSongLike({ source: 'qq', title: 't' }), false);
  assert.strictEqual(isSongLike({ id: '1', title: 't' }), false);
  assert.strictEqual(isSongLike({ id: '1', source: 'qq' }), false);
});

test('isSongLike: 空串视为缺失（平台常返回 id:"" 的占位）', () => {
  assert.strictEqual(isSongLike({ id: '', source: 'qq', title: 't' }), false);
  assert.strictEqual(isSongLike({ id: '1', source: '', title: 't' }), false);
  assert.strictEqual(isSongLike({ id: '1', source: 'qq', title: '' }), false);
});

test('isSongLike: id=0 视为有效（数字 0 是合法 id，不能因 falsy 被丢）', () => {
  assert.strictEqual(isSongLike({ id: 0, source: 'qq', title: 't' }), true);
});

test('isSongLike: 非对象一律 false', () => {
  for (const bad of [null, undefined, 0, '', 'x', [], true]) {
    assert.strictEqual(isSongLike(bad), false, `${JSON.stringify(bad)} 应 false`);
  }
});

// ── normalizeSong ─────────────────────────────────────────

test('normalizeSong: 补齐可选字段空值，不改已有值', () => {
  const s = normalizeSong({ id: '1', source: 'qq', title: 't' });
  assert.strictEqual(s.artist, '');
  assert.strictEqual(s.album, '');
  assert.strictEqual(s.cover, '');
  assert.strictEqual(s.duration, 0);
  assert.strictEqual(s.title, 't');
});

test('normalizeSong: id/source/title 归一为字符串', () => {
  const s = normalizeSong({ id: 12345, source: 'qq', title: 999 });
  assert.strictEqual(s.id, '12345');
  assert.strictEqual(s.title, '999');
});

test('normalizeSong: 幂等（归一两次 === 归一一次）', () => {
  const raw = { id: 1, source: 'qq', title: 't', artist: 'a', duration: 100, album: 'x' };
  assert.deepStrictEqual(normalizeSong(normalizeSong(raw)), normalizeSong(raw));
});

test('normalizeSong: 不修改入参（纯函数）', () => {
  const raw = { id: 1, source: 'qq', title: 't' };
  const snapshot = JSON.stringify(raw);
  normalizeSong(raw);
  assert.strictEqual(JSON.stringify(raw), snapshot);
});

test('normalizeSong: duration 非有限数 ⇒ 0（防 NaN 流入 UI）', () => {
  assert.strictEqual(normalizeSong({ id: '1', source: 'q', title: 't', duration: NaN }).duration, 0);
  assert.strictEqual(normalizeSong({ id: '1', source: 'q', title: 't', duration: 'abc' }).duration, 0);
  assert.strictEqual(normalizeSong({ id: '1', source: 'q', title: 't', duration: Infinity }).duration, 0);
});

test('normalizeSong: 保留未知字段（渲染层/队列的扩展不可丢）', () => {
  const s = normalizeSong({ id: '1', source: 'q', title: 't', taskId: 'abc', custom: 42 });
  assert.strictEqual(s.taskId, 'abc');
  assert.strictEqual(s.custom, 42);
});

test('normalizeSong: 非法输入不抛错，返回空壳', () => {
  assert.deepStrictEqual(
    { id: normalizeSong(null).id, source: normalizeSong(null).source },
    { id: '', source: '' },
  );
});

// ── isTrackSuccess ────────────────────────────────────────

test('isTrackSuccess: 有非空 url 字符串 ⇒ true', () => {
  assert.strictEqual(isTrackSuccess({ url: 'https://x' }), true);
});

test('isTrackSuccess: 无 url / 空 url / url 非字符串 ⇒ false', () => {
  assert.strictEqual(isTrackSuccess({}), false);
  assert.strictEqual(isTrackSuccess({ url: '' }), false);
  assert.strictEqual(isTrackSuccess({ url: null }), false);
  assert.strictEqual(isTrackSuccess({ url: 123 }), false);
  assert.strictEqual(isTrackSuccess(null), false);
});

// ── normalizeTrackResult ──────────────────────────────────

test('normalizeTrackResult: 成功时补 ext 缺省 mp3', () => {
  const r = normalizeTrackResult({ url: 'https://x' });
  assert.strictEqual(r.url, 'https://x');
  assert.strictEqual(r.ext, 'mp3');
});

test('normalizeTrackResult: 成功时保留平台附加字段（referer/size 等）', () => {
  const r = normalizeTrackResult({ url: 'https://x', referer: 'https://b.com', size: 100 });
  assert.strictEqual(r.referer, 'https://b.com');
  assert.strictEqual(r.size, 100);
});

test('normalizeTrackResult: 失败时规范为 { error, code, fatal }', () => {
  const r = normalizeTrackResult({});
  assert.strictEqual(typeof r.error, 'string');
  assert.strictEqual(r.code, 'INTERNAL_ERROR');
  assert.strictEqual(r.fatal, true);
});

test('normalizeTrackResult: 失败时保留原始 code（换源流程依赖它）', () => {
  const r = normalizeTrackResult({ error: 'x', code: 'VIP_REQUIRED', fatal: false });
  assert.strictEqual(r.code, 'VIP_REQUIRED');
  assert.strictEqual(r.fatal, false, 'fatal 应保留显式 false');
});

test('normalizeTrackResult: fatal 缺省为 true（失败默认不可重试，保守）', () => {
  assert.strictEqual(normalizeTrackResult({ error: 'x' }).fatal, true);
});

test('normalizeTrackResult: 幂等', () => {
  for (const raw of [{ url: 'https://x' }, { error: 'x', code: 'C' }, {}]) {
    assert.deepStrictEqual(normalizeTrackResult(normalizeTrackResult(raw)), normalizeTrackResult(raw));
  }
});

test('normalizeTrackResult: 非对象输入不抛错', () => {
  assert.ok(normalizeTrackResult(null));
  assert.ok(normalizeTrackResult(undefined));
});
