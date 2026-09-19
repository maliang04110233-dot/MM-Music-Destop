/**
 * MusicDL 下一首预取 — 判定与缓存（纯函数，无 DOM / 无 IPC）
 *
 * 背景：网络歌切歌要走「取流（getDownloadUrlSmart）+ 代理（proxyPlay）」两次串行网络往返，
 * 点下一首到出声中间有 1~3 秒空白。本模块负责「该给谁预热、什么时候预热、预热结果还算不算新」，
 * 真正的网络调用留在 player.js（那样这里才可以被 node:test 直接跑）。
 */

/** 剩余多少秒开始预热下一首（小于这个值预热已经来不及） */
export const PREFETCH_LEAD_SEC = 20;
/** 预热结果有效期：平台直链本身会过期，宁可过期后走正常取流也不能拿死链去播 */
export const PREFETCH_TTL_MS = 90 * 1000;
/** 缓存条数上限（只需覆盖「下一首」，多留一条给快速连点） */
export const PREFETCH_MAX = 2;

/**
 * 预热键：只有「需要联网取流」的歌才值得预热。
 * 本地歌曲（filePath / source:'local'）与拖入即播行（'drop'）走 file:///blob，预热无意义。
 */
export function prefetchKeyOf(song) {
  if (!song) return null;
  if (song.filePath) return null;
  const src = String(song.source || '').trim().toLowerCase();
  const id = song.id === null || song.id === undefined ? '' : String(song.id).trim();
  if (!src || !id) return null;
  if (src === 'local' || src === 'drop') return null;
  return `${src}:${id}`;
}

/**
 * 下一首要播的队列下标；不可预测时返回 null（宁可不预热，也不预热一首放不到的歌）。
 * 随机模式不可预测；单曲循环下一首还是自己（已在播，无需预热）；
 * 列表循环末尾回到 0；不循环放到头就没有下一首。
 */
export function nextPrefetchIdx(len, idx, opts = {}) {
  const n = Number.isFinite(len) ? Math.trunc(len) : 0;
  if (n <= 0) return null;
  const i = Number.isFinite(idx) ? Math.trunc(idx) : -1;
  if (i < 0 || i >= n) return null;
  if (opts.isShuffled) return null;
  const loop = Number(opts.loopMode);
  if (loop === 2) return null;
  if (i + 1 < n) return i + 1;
  return loop === 1 ? 0 : null;
}

/** 是否到了该预热的时机：本帧剩余时间进窗，且没有在飞请求、缓存也没有货 */
export function shouldPrefetchNow({ currentTime, duration, cached, fetching } = {}) {
  if (cached || fetching) return false;
  const cur = Number(currentTime);
  const dur = Number(duration);
  if (!Number.isFinite(cur) || cur < 0) return false;
  if (!Number.isFinite(dur) || dur <= 0) return false; // 直播流 duration=Infinity ⇒ 不预热
  const left = dur - cur;
  return left > 0 && left <= PREFETCH_LEAD_SEC;
}

export function isEntryFresh(entry, now = Date.now()) {
  if (!entry || !entry.fileUrl) return false;
  return now - Number(entry.ts) <= PREFETCH_TTL_MS;
}

/** 预热失败后的冷却时长：取流/代理失败通常是音源本身不可用，逐帧重试只会打风暴 */
export const PREFETCH_RETRY_MS = 60 * 1000;

/**
 * 该不该再试一次预热。fail 记录形如 { key, at }：
 * 只有「同一首歌」且「还在冷却期内」才拦住，换歌或冷却到期即放行。
 */
export function prefetchRetryAllowed(fail, key, now = Date.now()) {
  if (!fail || !key) return true;
  if (fail.key !== key) return true;
  return now - Number(fail.at) >= PREFETCH_RETRY_MS;
}

/** 预热缓存（可注入时钟，便于单测不靠 sleep） */
export function createPrefetchStore(nowFn = Date.now) {
  const map = new Map();
  return {
    put(key, entry) {
      if (!key || !entry || !entry.fileUrl) return null;
      const rec = { ...entry, ts: nowFn() };
      map.set(key, rec);
      while (map.size > PREFETCH_MAX) map.delete(map.keys().next().value);
      return rec;
    },
    /** 取用即失效：一条直链只用一次，避免第二次拿到已过期链接 */
    take(key, now = nowFn()) {
      const rec = map.get(key);
      if (rec) map.delete(key);
      return isEntryFresh(rec, now) ? rec : null;
    },
    peek(key, now = nowFn()) {
      const rec = map.get(key);
      return isEntryFresh(rec, now) ? rec : null;
    },
    has(key, now = nowFn()) {
      return this.peek(key, now) !== null;
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}
