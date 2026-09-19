/**
 * 歌词编辑 —— 纯函数（node 可单测，零 DOM/window 依赖）
 *
 * 歌词编辑器（lyricEditor.js）的决策内核：文本规范化、覆写与网络歌词
 * 的优先级、以及在线覆写映射的不可变增删。覆写存 prefs（本机生效），
 * 本地歌曲则直接写 sidecar，不走覆写映射。
 */

const MAX_LYRIC_CHARS = 100 * 1024;

/** CRLF/CR → LF，并钳到长度上限（防手滑粘贴整本书） */
function normalizeLrcText(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').slice(0, MAX_LYRIC_CHARS);
}

/** 覆写优先（非空即覆盖网络歌词）；键缺失/空文本退回 fetched */
function pickLyricText(override, fetched) {
  const ov = String(override == null ? '' : override).trim();
  if (ov) return String(override);
  return String(fetched == null ? '' : fetched);
}

/**
 * 在线覆写映射的不可变增删：trim 后为空的文本视作清除该曲覆写。
 * @param {Object} map 现有映射（键=favKey）
 * @returns {Object} 新映射（不改入参）
 */
function overridePatch(map, key, text) {
  const next = { ...(map && typeof map === 'object' ? map : {}) };
  const k = String(key == null ? '' : key);
  if (!k) return next;
  const t = String(text == null ? '' : text).trim();
  if (t) next[k] = String(text);
  else delete next[k];
  return next;
}

/** 解析 prefs 里的 JSON 映射，坏数据退空表（覆写是增强项，绝不因它崩播放） */
function parseOverrideMap(raw) {
  if (!raw) return {};
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
    const out = {};
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'string' && v.trim()) out[k] = v;
    }
    return out;
  } catch (_e) { return {}; }
}

export { MAX_LYRIC_CHARS, normalizeLrcText, pickLyricText, overridePatch, parseOverrideMap };
