/**
 * 源可用性健康记录（P2 探针的被动部分）
 *
 * 滑动窗口记每源最近 WINDOW 次取流成败（内存态，会话级——重启即重新观察，
 * 不持久化：源的健康状况天然时效短，落盘只会误导下次会话）。
 *
 * 消费方：
 *   - api/index.js getDownloadUrlSmart：各环节取流后 recordResult，
 *     候选列表 rankByHealth 重排（好源先试）
 *   - IPC get-source-health / probe-sources：设置页展示
 *
 * 分数语义：1 = 全成（或无数据，乐观默认）；0 = 近 WINDOW 次全败。
 * 不做时间衰减：窗口本身就限制了旧样本的影响。
 */

const WINDOW = 20;
const _records = new Map(); // source → [bool]（尾部为最新）

function recordResult(source, ok) {
  if (!source) return;
  let arr = _records.get(source);
  if (!arr) { arr = []; _records.set(source, arr); }
  arr.push(!!ok);
  if (arr.length > WINDOW) arr.shift();
}

function getHealthScore(source) {
  const arr = _records.get(source);
  if (!arr || !arr.length) return 1; // 无数据视为健康：避免冷启动误杀
  const ok = arr.filter(Boolean).length;
  return ok / arr.length;
}

function getSampleCount(source) {
  const arr = _records.get(source);
  return arr ? arr.length : 0;
}

/**
 * 健康信息快照（IPC 用）
 * @param {string[]} sources 要报告的源列表
 */
function getHealthMap(sources) {
  const out = {};
  for (const s of sources || []) {
    const n = getSampleCount(s);
    out[s] = { score: n ? getHealthScore(s) : null, samples: n };
  }
  return out;
}

/**
 * 按源健康度降序稳定重排（同源内部保持原顺序——原序已是匹配分排序）
 * @param {Array} items 含 source 字段的对象（候选歌曲）
 */
function rankByHealth(items) {
  const scoreOf = it => getHealthScore(it.source);
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (scoreOf(b.it) - scoreOf(a.it)) || (a.i - b.i))
    .map(x => x.it);
}

// 测试辅助
function _resetForTest() {
  _records.clear();
}

module.exports = {
  WINDOW,
  recordResult,
  getHealthScore,
  getSampleCount,
  getHealthMap,
  rankByHealth,
  _resetForTest,
};
