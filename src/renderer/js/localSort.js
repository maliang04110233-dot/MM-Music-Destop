/**
 * 本地曲库排序纯逻辑：默认（扫描原序）→ 标题 → 歌手 → 时长↓ → 大小↓ 循环。
 * 与 searchSort 不同：这里排的是对象数组本身（localFiltered 即渲染源），
 * 中文用 localeCompare('zh') 使拼音序可读。缺字段行一律垫底。
 * 无 DOM / api 依赖，node 可直接单测。
 */

const LOCAL_SORT_MODES = ['default', 'title', 'artist', 'duration-desc', 'size-desc'];

const LABELS = {
  default: '↕ 默认序',
  title: '↕ 标题',
  artist: '↕ 歌手',
  'duration-desc': '↕ 时长 ↓',
  'size-desc': '↕ 大小 ↓',
};

function nextLocalSortMode(mode) {
  const i = LOCAL_SORT_MODES.indexOf(mode);
  return LOCAL_SORT_MODES[(i + 1 + LOCAL_SORT_MODES.length) % LOCAL_SORT_MODES.length];
}

function localSortLabel(mode) {
  return LABELS[mode] || LABELS.default;
}

function _num(v) { return typeof v === 'number' && v > 0 ? v : null; }
function _str(v) { return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null; }

/** 稳定排序，比较器对缺字段返回 null 表示「垫底」。 */
function sortLocalSongs(songs, mode) {
  const arr = Array.isArray(songs) ? songs : [];
  if (!mode || mode === 'default') return arr;
  const keyed = [];
  const noKey = [];
  for (const s of arr) {
    let key = null;
    if (mode === 'title') key = _str(s && s.title);
    else if (mode === 'artist') key = _str(s && s.artist);
    else if (mode === 'duration-desc') key = _num(s && s.duration);
    else if (mode === 'size-desc') key = _num(s && s.fileSize);
    (key === null ? noKey : keyed).push({ s, key });
  }
  const cmp = (a, b) => (typeof a.key === 'string'
    ? String(a.key).localeCompare(String(b.key), 'zh')
    : b.key - a.key);
  keyed.sort(cmp);
  return keyed.map(x => x.s).concat(noKey.map(x => x.s));
}

export { LOCAL_SORT_MODES, nextLocalSortMode, localSortLabel, sortLocalSongs };
