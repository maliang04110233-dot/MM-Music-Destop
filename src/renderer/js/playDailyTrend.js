/**
 * 每日听歌时长趋势纯函数（增量113）—— node 可直测，全模块零 DOM
 *
 * 听歌统计原来只有累计总时长；这里给 playStats 加 daily 桶
 * （本地日 'YYYY-MM-DD' → 秒），停表时归集，持久化走既有
 * playStats prefs（零新 IPC）。分桶形态与下载趋势 historyTrend
 * 对齐（oldest → newest，最后一桶为 now 当天；柱高共用其 barPct，
 * 由消费方 stats.js 直接引入，本模块零依赖）。
 */

export const PLAY_TREND_DAYS = 14;

const DAY_MS = 86400000;

function _startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function _dateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 时间戳 → 本地日键 'YYYY-MM-DD' */
export function dayKey(ts) {
  return _dateKey(new Date(Number(ts) || Date.now()));
}

/**
 * daily × 时长 → 新映射（纯，不改入参）；<=0 或非数字只回浅拷贝。
 * 归集日记在 ts 当天。
 */
export function addDailySeconds(daily, ts, secs) {
  const src = (daily && typeof daily === 'object') ? daily : {};
  const out = { ...src };
  const s = Math.floor(Number(secs) || 0);
  if (s <= 0) return out;
  const k = dayKey(ts);
  out[k] = (Number(out[k]) || 0) + s;
  return out;
}

/**
 * daily → [{key,label,secs}]（oldest → newest，最后一桶为 now 当天）。
 * 窗口外/未来日/非正数一律不入账。
 */
export function bucketDailySeconds(daily, now, days = PLAY_TREND_DAYS) {
  const n = days > 0 ? days : PLAY_TREND_DAYS;
  const today = _startOfDay(Number(now) || Date.now());
  const buckets = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today - i * DAY_MS);
    buckets.push({ key: _dateKey(d), label: `${d.getMonth() + 1}/${d.getDate()}`, secs: 0 });
  }
  const src = (daily && typeof daily === 'object') ? daily : {};
  for (const [key, raw] of Object.entries(src)) {
    const secs = Math.floor(Number(raw) || 0);
    if (secs <= 0) continue;
    const b = buckets.find(x => x.key === key);
    if (b) b.secs += secs;
  }
  return buckets;
}
