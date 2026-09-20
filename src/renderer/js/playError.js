/**
 * 播放失败的诊断文案 —— 纯函数（node 可单测，顶层不碰 window）
 *
 * audio 的 error 事件只告诉你「加载或解码失败」，不区分是网络音源失效还是
 * 本地文件被移走。此前一律播「音源播放出错」，用户自己清了下载目录时被支去
 * 查网络。这里只改说法不改行为：调用方照旧跳下一曲。
 */

/** MediaError.code：3=解码失败（文件在但解不开）；4=源不可用（file:// 找不到落这儿） */
const CODE_DECODE = 3;

function _name(song) {
  const s = song && typeof song === 'object' ? song : {};
  const title = String(s.title || '').trim();
  const artist = String(s.artist || '').trim();
  return title ? (artist ? `${title} - ${artist}` : title) : '未命名曲目';
}

/** 本地文件行只认 filePath：在线行有 http url，拖入行有 blob url，都不该套用「文件被移走」这套解释 */
function isLocalFileSong(song) {
  const s = song && typeof song === 'object' ? song : null;
  return !!s && typeof s.filePath === 'string' && s.filePath.trim() !== '';
}

function _isDropped(song) {
  const s = song && typeof song === 'object' ? song : {};
  return s.source === 'drop' || /^blob:/.test(String(s.url || ''));
}

/**
 * @param {object|null} song 正在播放的行（getState('currentPlaying')）
 * @param {number} [code]    audio.error.code
 * @returns {{text:string, kind:string, local:boolean}} local=true 表示锅在盘上，文案该多读几秒
 */
function describePlayError(song, code) {
  const name = _name(song);
  if (_isDropped(song)) {
    return { kind: 'warn', local: true, text: `⚠️ 拖入的临时曲目已失效：${name}，自动播放下一曲` };
  }
  if (isLocalFileSong(song)) {
    return code === CODE_DECODE
      ? { kind: 'warn', local: true, text: `📁 本地文件解不开（可能损坏或格式不支持）：${name}，自动播放下一曲` }
      : { kind: 'warn', local: true, text: `📁 本地文件读不到，可能已被移动、删除或改名：${name}，自动播放下一曲` };
  }
  return { kind: 'warn', local: false, text: '⚠️ 音源播放出错，自动播放下一曲' };
}

export { CODE_DECODE, isLocalFileSong, describePlayError };
