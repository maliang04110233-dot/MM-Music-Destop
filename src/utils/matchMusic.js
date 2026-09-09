/**
 * 跨源同曲匹配（换源机制的核心）
 *
 * 借鉴 lx-music-desktop musicSdk/index.js findMusic 的规范化思路：
 *   - 歌名/歌手规范化：全角→半角、去标点空白后比较，规避（Live）(伴奏) 等后缀干扰
 *   - 多人歌手排序拼接："周杰伦/费玉清" 与 "费玉清/周杰伦" 视为相同
 *   - 时长 ±5s 容差 + 打分门槛，过滤同名翻唱/伴奏版误匹配
 * 工程防护（lx core/music/utils.ts getOtherSource 模式）：
 *   - in-flight Map：同一首歌并发只搜一次
 *   - LRU 结果缓存 + 失败结果 60s 防抖（避免反复失败反复打接口）
 *   - 总超时 15s
 *
 * 候选源：netease / qq / kugou。B 站默认不入候选——其"歌名"是视频标题，
 * 同曲匹配会把翻唱合集、DJ 版误当原曲（lx 同样排除了部分噪声源）。
 */

const logger = require('./logger');

// 候选源及其 VIP 标记字段（无 Cookie 时需过滤，否则拿到 30s 试听 URL 误判成功）
const CANDIDATE_SOURCES = ['netease', 'qq', 'kugou'];
const SEARCH_TIMEOUT_MS = 15000;
const NEGATIVE_TTL_MS = 60 * 1000; // 失败结果缓存时长
const CACHE_MAX = 200;             // LRU 上限

// ── B 站歌名拆歌手 ────────────────────────────────────
// B 站搜索结果的 artist 是 UP 主名，与音乐源的真实歌手永远对不上；
// 但其 title 普遍是「歌名 - 歌手」「歌手 - 歌名」格式。匹配前先拆出
// 真实歌名/歌手（带「-」分隔且两侧都像人名/歌名时才拆，避免误拆英文歌名）。
// 装饰标题先剥壳：去【装饰段】与分隔符，保留《歌名》- 歌手结构。
function _biliCoreTitle(title) {
  return String(title || '')
    .replace(/【[^】]*】/g, ' ')        // 【Hi-Res】【4K修复】 等装饰段（含其内部连字符）
    .replace(/[｜|]/g, ' ')            // 全半角竖线分隔符
    .replace(/\s+/g, ' ')
    .trim();
}

function splitBiliTitle(song) {
  if (song.source !== 'bilibili') return song;
  const core = _biliCoreTitle(song.title);
  if (!core) return song;
  const patched = { ...song, title: core };
  // 剥掉尾部的引号装饰段（‘故事的小黄花’ 等），再从「最后一个 -」拆歌手：
  // 另一侧不含书名号/装饰符，避免装饰连字符被误切（歌手侧超长如「晴天MV 2160P修复版」仍可拆）
  const QUOTE_CHARS = String.fromCharCode(0x2018, 0x2019, 0x201C, 0x201D, 0x27, 0x22); // ‘’“”'”
  const tailRe = new RegExp('[' + QUOTE_CHARS + '].*$');
  const tailStripped = core.replace(tailRe, '').trim().replace(/[-\u2013\u2014]\s*$/, '').trim();
  const m = tailStripped.match(new RegExp('^(.{1,40})\\s*[-\\u2013\\u2014]\\s*([^' + '《》【】『』·|｜' + QUOTE_CHARS + ']{1,40})$'));
  if (!m) {
    // 无「- 歌手」段：书名号《歌名》直接作为歌名
    const book = core.match(/《([^》]{1,40})》/);
    return book ? { ...patched, title: book[1] } : patched;
  }
  const [, leftRaw, right] = m;
  // 左侧剥掉引号装饰尾巴并保留书名号内歌名
  const leftBook = leftRaw.match(/《([^》]{1,40})》/);
  const left = leftBook ? leftBook[1] : leftRaw.replace(tailRe, '').trim();
  const artistNorm = normalizeName(song.artist);
  const leftHasArtist = artistNorm && normalizeName(leftRaw).includes(artistNorm);
  const rightHasArtist = artistNorm && normalizeName(right).includes(artistNorm);
  if (rightHasArtist && !leftHasArtist) {
    return { ...patched, title: left, artist: right.trim() }; // 歌名 - 歌手
  }
  if (leftHasArtist && !rightHasArtist) {
    return { ...patched, title: right.trim(), artist: left }; // 歌手 - 歌名
  }
  // artist 对不上任一侧：右侧像歌手（纯词、短、无三位以上数字）按「歌名 - 歌手」拆
  if (normalizeName(right) && !/\d{3,}/.test(right)) {
    return { ...patched, title: left, artist: right.trim() };
  }
  return patched;
}

// ── 名称规范化 ────────────────────────────────────────

function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    // 全角 ASCII 区 → 半角
    .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    // 只留字母数字（含 CJK），去掉 (Live)、【伴奏】、空格、标点
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function normalizeArtists(s) {
  return String(s || '')
    .split(/[/\\,&;、，；]\s*/)
    .map(normalizeName)
    .filter(Boolean)
    .sort()
    .join(',');
}

// 版本装饰词（规范化后形态）：歌名尾部的 live/dj/伴奏 等不算歌名差异
const VERSION_TAILS = [
  'live', 'djversion', 'dj', 'remix', 'cover', '伴奏', '纯音乐', '纯音乐版',
  'instrumental', 'accompaniment', 'mv', 'mv修复版', '4k修复版', '4k', 'hires',
  'flac', '修复版', '完整版', 'mv版', '版',
];
function stripVersionTail(n) {
  let out = n;
  for (const w of VERSION_TAILS) {
    const re = new RegExp(w + '$');
    while (re.test(out)) out = out.replace(re, '');
  }
  return out;
}

/**
 * 歌名比较：全等，或剥掉版本装饰词后全等（「晴天live」≡「晴天」）。
 * 剥完必须全等——不做子串包含，防「晴天」误配「晴天娃娃」。
 */
function titleHit(songTitle, candTitle) {
  const a = stripVersionTail(normalizeName(songTitle));
  const b = stripVersionTail(normalizeName(candTitle));
  return !!a && !!b && a === b;
}

/**
 * 匹配打分：
 *   3 = 歌名+歌手+时长(±5s) 全中（最强）
 *   2 = 歌名+歌手；或歌名+时长且歌手信息缺失（原歌无歌手字段）
 *   1 = 仅歌名+时长但歌手明确不同（翻唱/翻奏典型特征，不采纳）
 *   0 = 不匹配 / 仅歌名同
 * 门槛：>=2 采纳（仅歌名同、或同名同长但歌手不同的翻唱风险过高）
 */
function matchScore(song, cand) {
  const t = titleHit(song.title, cand.title);
  if (!t) return 0;
  const bothArtists = song.artist && cand.artist;
  const a = bothArtists
    && normalizeArtists(song.artist) === normalizeArtists(cand.artist);
  const d = song.duration && cand.duration
    && Math.abs(song.duration - cand.duration) <= 5000;
  if (a && d) return 3;
  if (a) return 2;
  // 歌手明确不同：同名同长也大概率是翻唱，只给 1 分
  if (bothArtists && !a) return 1;
  // 一侧无歌手信息：用时长兜底
  if (d) return 2;
  return 1;
}

// ── 候选过滤 ──────────────────────────────────────────

// 无 Cookie 时跳过 VIP/付费候选：netease fee 1=VIP 4=专辑收费；qq pay.payplay/paydownload=1 付费
function isPaidCandidate(cand) {
  if (cand.source === 'netease' && (cand.fee === 1 || cand.fee === 4)) return true;
  if (cand.source === 'qq' && cand.pay && (cand.pay.payplay === 1 || cand.pay.paydownload === 1)) return true;
  return false;
}

function filterCandidates(songs, origSong, hasCookie) {
  const out = [];
  for (const cand of songs) {
    if (!cand || cand.id == null || cand.id === '' || !cand.source) continue;
    if (cand.source === origSong.source) continue; // 跳过原源
    if (CANDIDATE_SOURCES.includes(cand.source) === false) continue; // 只认音乐源
    if (matchScore(origSong, cand) < 2) continue;
    if (!hasCookie(cand.source) && isPaidCandidate(cand)) continue;
    out.push(cand);
  }
  // 分数降序，同分时长更近者优先
  const scoreOf = c => matchScore(origSong, c);
  const durGap = c => (origSong.duration && c.duration)
    ? Math.abs(origSong.duration - c.duration) : Infinity;
  out.sort((x, y) => (scoreOf(y) - scoreOf(x)) || (durGap(x) - durGap(y)));
  return out.slice(0, 5); // 每源最多试前 5 个
}

// ── 搜索与缓存 ────────────────────────────────────────

const _inflight = new Map();  // key → Promise（并发去重）
const _cache = new Map();     // key → { candidates, at, negative }
// Map 迭代序 = 插入序，删最旧即 LRU
function cachePut(key, val) {
  _cache.delete(key);
  _cache.set(key, val);
  if (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
}

/**
 * 跨源找同曲候选（不含取 URL）
 * @param {object} deps 注入避免循环依赖：{ searchFn(platformId, keyword), hasCookie(platformId) }
 *   searchFn 返回歌曲数组（plugin.search 形状）
 * @param {object} song { id, source, title, artist, duration }
 * @returns {Promise<Array>} 过滤排序后的候选（可能为空）
 */
async function findMatchedCandidates(deps, song) {
  if (!song || !song.title || !song.source) return [];

  // B 站：artist 是 UP 主，先从「歌名 - 歌手」title 拆出真实歌名/歌手
  const orig = splitBiliTitle(song);

  const key = `${song.source}:${song.id || ''}|${normalizeName(orig.title)}|${normalizeArtists(orig.artist)}`;

  // in-flight 去重
  if (_inflight.has(key)) return _inflight.get(key);

  const cached = _cache.get(key);
  if (cached) {
    const fresh = (Date.now() - cached.at) < (cached.negative ? NEGATIVE_TTL_MS : 10 * 60 * 1000);
    if (fresh) return cached.candidates;
    _cache.delete(key);
  }

  const p = (async () => {
    const keyword = orig.artist ? `${orig.title} ${orig.artist}` : orig.title;
    const withTimeout = (pr) => Promise.race([
      pr,
      new Promise(r => setTimeout(() => r([]), SEARCH_TIMEOUT_MS)),
    ]);

    const sources = CANDIDATE_SOURCES.filter(s => s !== song.source);
    const results = await Promise.allSettled(
      sources.map(src => withTimeout(
        Promise.resolve(deps.searchFn(src, keyword)).catch(e => {
          logger.warn(`[matchMusic] ${src} 搜索失败:`, e && e.message);
          return [];
        })
      ))
    );

    const flat = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []) || []);
    const candidates = filterCandidates(flat, orig, deps.hasCookie);
    cachePut(key, { candidates, at: Date.now(), negative: candidates.length === 0 });
    return candidates;
  })().finally(() => { _inflight.delete(key); });

  _inflight.set(key, p);
  return p;
}

// 测试辅助
function _resetForTest() {
  _inflight.clear();
  _cache.clear();
}

module.exports = {
  normalizeName,
  normalizeArtists,
  matchScore,
  isPaidCandidate,
  findMatchedCandidates,
  CANDIDATE_SOURCES,
  splitBiliTitle,
  _resetForTest,
};
