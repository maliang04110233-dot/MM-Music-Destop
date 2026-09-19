/**
 * m3u / m3u8 歌单文本解析 —— 纯函数，node 可单测（无 window 依赖）
 *
 * 用途：把外部播放器导出的歌单文件（#EXTINF:秒,歌手 - 歌名 + 路径行）或纯文本
 * 行列表，归一成「歌手 - 歌名」行数组，喂给 nameBatch 的逐行搜索匹配管道。
 * 取舍：搜索只需要歌名/歌手，路径行只用于 desc 缺失（"-"）时兜底取文件名。
 */

const AUDIO_EXT_RE = /\.(flac|mp3|m4a|wav|ogg|ape|wma|aac)$/i;

/** 取路径最后一段并去音频扩展名（Windows 反斜杠与 posix 斜杠都认） */
function _basename(line) {
  const m = String(line).split(/[\\/]/);
  const last = m[m.length - 1].trim();
  return last.replace(AUDIO_EXT_RE, '');
}

/**
 * 解析 m3u 文本 → 最多 maxLines 条「歌手 - 歌名」行。
 * 规则：
 *  - #EXTINF 的描述（逗号后段）优先作曲名；描述为空或 "-" 时用后继路径行的文件名
 *  - 其他 # 开头的指令行（#EXTM3U/#EXTVLCOPT…）忽略，不产曲名
 *  - 无 #EXTINF 的普通行 = 直接曲名/路径，取文件名形态
 *  - 连续两条 #EXTINF（缺路径行的坏文件）不互相吞：前一条先落袋
 */
export function parseM3u(text, maxLines = 30) {
  const out = [];
  let pending = null; // 最近一条 #EXTINF 的描述，等待路径行确认
  const push = (name) => {
    const clean = String(name == null ? '' : name).trim();
    if (clean && out.length < maxLines) out.push(clean);
  };
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('#EXTINF')) {
      if (pending != null && pending !== '-') push(pending); // 坏文件：前一条先落袋
      const comma = line.indexOf(',');
      pending = comma >= 0 ? line.slice(comma + 1).trim() : '';
      continue;
    }
    if (line.startsWith('#')) {
      continue; // #EXTM3U / #EXT-X-* / #EXTVLCOPT：不携带曲名，pending 留给真路径行
    }
    push(pending && pending !== '-' ? pending : _basename(line));
    pending = null;
  }
  if (pending != null && pending !== '-') push(pending);
  return out;
}
