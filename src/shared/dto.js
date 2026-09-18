/**
 * 跨层数据契约（DTO）—— 歌曲 / 取流结果 / 换源信息
 *
 * 为什么需要本模块：
 *   重构前，「歌曲对象」在 8 个平台实现、搜索聚合、队列持久化、渲染层之间
 *   靠**约定**传递字段（title / artist / id / source / duration …），没有任何
 *   单点定义。后果是：
 *     - 平台各写各的字段名（songname vs name、interval vs duration），
 *       映射代码散落在每个平台文件里，漏一个字段就是「某平台列表缺专辑名」；
 *     - 队列持久化（queue.json）与渲染层各自假设字段存在，字段演进靠口口相传；
 *     - 取流结果（url/ext/referer/code/fatal）的形态没有契约，只能靠注释说明。
 *
 *   本模块把这些**跨层流动的形状**显式化：
 *     - 只做「形状归一化」与「校验」，不含任何平台知识、不做网络请求；
 *     - 平台特有的原始响应字段名（如 songname）由各平台适配器自行映射，
 *       本模块只定义映射**之后**的统一形状。
 *
 * 分层约束（重要）：
 *   - 本模块位于 shared/，**不得** require api/ 或平台实现（否则又成耦合点）；
 *   - 渲染层（renderer/js）不 require 本模块 —— 它只消费 IPC 传来的 JSON。
 *     本模块是**主进程侧**的形状契约。渲染层若要类型提示，应以注释引用此处。
 */

// ── 歌曲（Song / Track）──────────────────────────────────

/**
 * 歌曲的统一形状。
 *
 * 字段既有「必需」（平台适配器必须给）也有「可选」（按能力而定）。
 * 不引入 class / 构造器：现有大量代码以对象字面量流转，
 * 引入构造器会迫使全链路改造，违背渐进式重构原则。
 * 改为提供 `normalizeSong()` 做**幂等归一化**，任何时候都可安全调用。
 *
 * @typedef {Object} Song
 * @property {string} id           平台内唯一 id（必需）
 * @property {string} source       平台 id，如 'netease'（必需）
 * @property {string} title        曲名（必需）
 * @property {string} artist       歌手串，多歌手以 ' / ' 连接（必需，可为空串）
 * @property {number} [duration]   时长（毫秒）
 * @property {string} [album]      专辑名
 * @property {string} [albumMid]   专辑 mid（取封面用）
 * @property {string} [cover]      封面 URL
 * @property {string} [numId]      平台数字 id（部分接口需要）
 * @property {string} [quality]    期望音质
 * @property {string} [saveDir]    下载目录（下载场景）
 * @property {string} [taskId]     队列任务 id（队列场景）
 * @property {{source:string,id:string}} [_altSource] 上次换源成功的源（记忆，加速下次取流）
 */

/** 歌曲的必需字段 —— 缺任一则该条目无法用于取流 / 播放 */
const REQUIRED_SONG_FIELDS = Object.freeze(['id', 'source', 'title']);

/**
 * 判断一个对象是否具备「可用歌曲」的最小字段。
 * 用于过滤平台返回的脏数据（缺 id 的条目渲染出来也无法点击）。
 *
 * @param {*} song
 * @returns {boolean}
 */
function isSongLike(song) {
  if (!song || typeof song !== 'object') return false;
  for (const f of REQUIRED_SONG_FIELDS) {
    const v = song[f];
    if (v == null || v === '') return false;
  }
  return true;
}

/**
 * 幂等归一化歌曲对象：补齐可选字段的**空值形态**，避免下游到处写 `x || ''`。
 *
 * 只补空值、不改已有值 —— 保证「归一化两次 === 归一化一次」。
 * 不丢弃未知字段（渲染层可能有自己的扩展），只在其缺席时补默认。
 *
 * @param {Song} song
 * @returns {Song} 新对象（不修改入参）
 */
function normalizeSong(song) {
  const s = (song && typeof song === 'object') ? song : {};
  return {
    ...s,
    id: s.id == null ? '' : String(s.id),
    source: s.source == null ? '' : String(s.source),
    title: s.title == null ? '' : String(s.title),
    artist: s.artist == null ? '' : String(s.artist),
    duration: Number.isFinite(s.duration) ? s.duration : 0,
    album: s.album == null ? '' : String(s.album),
    cover: s.cover == null ? '' : String(s.cover),
  };
}

// ── 取流结果（TrackResult）────────────────────────────────

/**
 * 取流（获取播放/下载 URL）的统一结果形状。
 *
 * ⚠️ 这是**成功与失败共用的形状** —— 失败时通过 `error` + `code` 表达，
 *    而不是抛异常。原因：换源机制依赖读取失败结果的 `code` 判断
 *    「是否值得换源」，抛异常会破坏该流程（见 gateway.getUrl 的注释）。
 *
 * @typedef {Object} TrackResult
 * @property {string} [url]        可播放/可下载的直链（成功时必有）
 * @property {string} [ext]        音频扩展名（mp3 / m4a / flac …）
 * @property {string} [referer]    下载时需携带的 Referer（B 站等）
 * @property {number} [bitrate]    码率（如平台提供）
 * @property {number} [size]       文件大小（如平台提供）
 * @property {string} [error]      失败描述（用户可见文案）
 * @property {string} [code]       失败错误码（见 shared/errors ERROR_CODES）
 * @property {boolean} [fatal]     true = 重试无意义（VIP/版权/无流），下载器据此短路
 * @property {string} [source]     实际提供该流的平台（换源后 ≠ 请求源）
 * @property {Song}   [matchedSong] 换源命中的候选歌曲（换源成功时）
 * @property {string} [matchedFrom] 换源前请求的平台 id（换源成功时）
 * @property {boolean} [fromAltMemory] true = 由 _altSource 记忆直接命中
 */

/**
 * 取流是否成功（存在可用直链即成功）。
 * @param {TrackResult} r
 * @returns {boolean}
 */
function isTrackSuccess(r) {
  return !!(r && typeof r.url === 'string' && r.url);
}

/**
 * 归一化取流结果：成功保留直链相关字段；失败规范为 `{ error, code, fatal }`。
 * 幂等。用于在返回渲染层前统一形态，避免 UI 分支判断 undefined。
 *
 * @param {TrackResult} r
 * @returns {TrackResult}
 */
function normalizeTrackResult(r) {
  const x = (r && typeof r === 'object') ? r : {};
  if (isTrackSuccess(x)) {
    return {
      ...x,
      url: String(x.url),
      ext: x.ext ? String(x.ext) : 'mp3',
    };
  }
  return {
    ...x,
    error: x.error ? String(x.error) : '无法获取音频流',
    code: x.code ? String(x.code) : 'INTERNAL_ERROR',
    fatal: x.fatal === undefined ? true : !!x.fatal,
  };
}

module.exports = {
  REQUIRED_SONG_FIELDS,
  isSongLike,
  normalizeSong,
  isTrackSuccess,
  normalizeTrackResult,
};
