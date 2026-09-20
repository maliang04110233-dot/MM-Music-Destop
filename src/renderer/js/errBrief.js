/**
 * 操作失败 toast 的错误人话层（纯函数）
 *
 * 已知错误族（网络/取消/磁盘/鉴权/JSON/文件系统）翻成一句中文定译，
 * 措辞与 diagnose.js 码表同族——同一概念同一词；未知错误不吞诊断线索：
 * 压成单行、超 80 字符截断。纯字符串转换，不产生任何副作用，
 * 原始报错由调用方在 logger.warn 里另行保留（人话层只活在用户可见处）。
 */

const NET_RE = /fetch failed|failed to fetch|enotfound|econnrefused|econnreset|etimedout|timed out|timeout|networkerror|net::err_/i;
const ABORT_RE = /abort/i;
const DISK_RE = /enospc|no space|空间不足/i;
const AUTH_RE = /401|403|unauthorized|forbidden|invalid.{0,12}(key|token)|API.?key/i;
const JSON_RE = /json/i;
const FS_RE = /enoent|eperm|eacces|no such file|permission denied/i;

const MAX_LEN = 80;

/** 从 Node 文件系统报错里抽被引号包住的落点路径："... open 'C:\Music\x.json'" */
function _quotedPath(text) {
  const m = /'([^']{1,260})'/.exec(text);
  return m ? m[1] : '';
}

/**
 * @param {unknown} e Error / 字符串 / 任意抛出物
 * @returns {string} 一行、可读、尽量中文的失败简述
 */
export function errBrief(e) {
  let text = '';
  if (typeof e === 'string') {
    text = e;
  } else if (e && typeof e.message === 'string') {
    text = e.message;
  } else if (e != null) {
    text = String(e);
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || text === '[object Object]') return '未知错误';

  if (NET_RE.test(text)) return '网络异常，请检查网络/代理后重试';
  if (ABORT_RE.test(text)) return '操作已取消';
  if (DISK_RE.test(text)) return '磁盘空间不足，请清理磁盘后重试';
  if (AUTH_RE.test(text)) return '鉴权失败，请检查设置中的 API Key / Cookie';
  // 文件族排在 JSON 判定之前：ENOENT 报错的落点路径常以 .json 结尾，
  // 先判 JSON 会把「写文件失败」误说成「接口数据无法解析」。
  if (FS_RE.test(text)) {
    const p = _quotedPath(text);
    return p ? `文件读写失败：${p}` : '文件读写失败：路径不存在或无权限';
  }
  if (JSON_RE.test(text)) return '返回数据无法解析（平台接口可能变更），请稍后重试';
  return text.length > MAX_LEN ? text.slice(0, MAX_LEN) + '…' : text;
}
