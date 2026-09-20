/**
 * 下载文件命名模板
 *
 * 变量分两类：
 *   基础五项  {title} {artist} {album} {source} {id}
 *     —— 历史行为，缺值回退「未知」
 *   扩展变量  {quality} {bitrate} {year} {trackNo}(别名 {track}) {playlist} {date}
 *     —— 缺值时占位符连同相邻的空括号 / 一侧分隔符一起消掉，避免出现
 *        「周杰伦 - 晴天 []」或「周杰伦 -  - 晴天」这类噪音文件名
 *
 * 模板只产出扁平文件名：模板字面量里的 / 和 \ 会被换成下划线，
 * 防止模板逃逸到下载目录之外。需要按目录组织走「下载路径模板」功能
 * —— 那是下面的 renderPathSegments，两套模板共用本文件的同一张变量表。
 *
 * 示例：
 *   {artist} - {title}                → 周杰伦 - 晴天.mp3
 *   {artist} - {title} [{bitrate}]    → 周杰伦 - 晴天 [320k].mp3
 *   {trackNo}.{title}                 → 03.晴天.mp3（非歌单入队时为 晴天.mp3）
 *
 * 默认模板：{artist} - {title}
 */

const DEFAULT_TEMPLATE = '{artist} - {title}';

// 平台 quality 档位 → 用户可读的码率/格式名（与搜索页音质下拉文案保持一致）
const QUALITY_LABELS = { standard: '128k', hq: '320k', lossless: 'FLAC' };

// 文件名非法字符（Windows 保留字符）
const ILLEGAL_RE = /[<>:"\u002f\u005c|?*]/g;
// 值里可能带的控制字符（部分平台歌名带换行），Windows 文件名不允许
const CONTROL_RE = /[^\u0020-\u007E\u0080-\uFFFF]/g;

// 空值洞。所有清理规则都要求紧邻这个哨兵才生效，因此不会误伤歌名里的标点。
const HOLE = String.fromCharCode(2) + 'HOLE' + String.fromCharCode(2);
// 模板字面量里的路径分隔符（/ 或 \）先换成这个哨兵，再决定怎么收
const SEP = String.fromCharCode(3) + 'SEP' + String.fromCharCode(3);

// 占位符解析：变量名前后允许空格；别名在 ALIASES 收敛到规范名
const PLACEHOLDER_RE = /{\s*([a-zA-Z][a-zA-Z0-9]*)\s*}/g;
const ALIASES = { track: 'trackNo' };

// 供设置页生成「可用变量」提示，避免 UI 文案与实现各写一份
const TEMPLATE_VARS = [
  { key: 'title', desc: '歌曲标题' },
  { key: 'artist', desc: '艺术家' },
  { key: 'album', desc: '专辑名' },
  { key: 'source', desc: '平台来源' },
  { key: 'id', desc: '歌曲 ID' },
  { key: 'quality', desc: '音质档位 standard/hq/lossless' },
  { key: 'bitrate', desc: '码率 128k/320k/FLAC' },
  { key: 'trackNo', desc: '歌单序号（别名 {track}）' },
  { key: 'playlist', desc: '歌单名' },
  { key: 'year', desc: '发行年份' },
  { key: 'date', desc: '下载日期 YYYYMMDD' },
];

/**
 * 单个变量值：清洗 + 缺值回退
 * @param {*} v
 * @param {string} missingAs 缺值时填的东西（文件名用「未知」，目录段用空洞哨兵）
 */
function fieldValue(v, missingAs) {
  const s = (v == null || v === '') ? '' : String(v)
    .replace(CONTROL_RE, ' ').replace(ILLEGAL_RE, '_').trim();
  return s || missingAs;
}

/** 扩展变量：缺值回退空洞哨兵 */
function optional(v) {
  return fieldValue(v, HOLE);
}

/** 码率：优先 quality 档位名，其次平台直接给的 bitrate（bps 按十进制折算，与音乐软件标注一致） */
function bitrateField(song) {
  const label = QUALITY_LABELS[song.quality];
  if (label) return label;
  const raw = song.bitrate;
  if (raw == null || raw === '') return HOLE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return HOLE;
  const kbps = n > 1024 ? Math.round(n / 1000) : Math.round(n);
  return kbps + 'k';
}

/** 年份：接受年份数字或日期字符串，范围外一律当无值 */
function yearField(song) {
  for (const raw of [song.year, song.pubdate]) {
    if (raw == null || raw === '') continue;
    const y = parseInt(raw, 10);
    if (Number.isFinite(y) && y >= 1900 && y <= 2100) return String(y);
  }
  return HOLE;
}

/** 歌单序号：按歌单总数补零，保证按文件名排序也能排对 */
function trackNoField(song) {
  const n = parseInt(song.trackNo, 10);
  if (!Number.isFinite(n) || n < 1) return HOLE;
  const total = parseInt(song.trackTotal, 10);
  const width = (Number.isFinite(total) && total >= 1)
    ? Math.max(2, String(total).length)
    : 2;
  return String(n).padStart(width, '0');
}

/** 下载日期 YYYYMMDD */
function dateField(now) {
  const pad2 = (n) => String(n).padStart(2, '0');
  return '' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate());
}

/**
 * 变量表：文件名模板与目录路径模板共用这一份，两处各写一份必然漂移
 * @param {object} s 歌曲信息
 * @param {Date} now
 * @param {string} baseMissing 基础五项缺值时填的东西
 */
function buildFields(s, now, baseMissing) {
  const base = (v) => fieldValue(v, baseMissing);
  return {
    title: base(s.title),
    artist: base(s.artist),
    album: base(s.album),
    source: base(s.source),
    id: base(s.id),
    quality: optional(s.quality),
    bitrate: bitrateField(s),
    trackNo: trackNoField(s),
    playlist: optional(s.playlistName),
    year: yearField(s),
    date: dateField(now),
  };
}

/**
 * 根据模板生成文件名
 * @param {string} template - 模板字符串
 * @param {object} song - 歌曲信息（title/artist/album/source/id + quality/
 *                        bitrate/trackNo/trackTotal/playlistName/year/pubdate）
 * @param {string} ext - 文件扩展名（不含点）
 * @param {object} [opts] - { now: Date } 固定渲染时间，供测试用
 * @returns {string} 完整文件名（含扩展名，不含目录）
 */
function renderFileName(template, song, ext, opts) {
  const s = song || {};
  const now = (opts && opts.now instanceof Date) ? opts.now : new Date();

  const fields = buildFields(s, now, '未知');

  // 用函数替换：避免歌名里的 $& / $' 被当作替换模式解释；
  // 未识别的变量原样保留，方便用户看出拼错
  let result = (template || DEFAULT_TEMPLATE).replace(PLACEHOLDER_RE, (_, name) => {
    const key = ALIASES[name] || name;
    return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : '{' + name + '}';
  });

  // ① 模板字面量里的路径分隔符先换成哨兵（值已在上面被清洗，此时剩下的都是模板写的）
  result = result.replace(/[\u002f\u005c]+/g, SEP);
  // ② 洞两侧都有破折号时保留一个，否则连同破折号整段吃掉
  //
  // 注意：HOLE 里含 U+0002 控制字符，写成正则字面量会触发
  // eslint no-control-regex；故与 ③ 一致，用 new RegExp 由常量拼出来，
  // 既避免裸控制字符，也保证哨兵定义只有 HOLE 一个来源。
  result = result.replace(
    new RegExp(
      '([\\t ]*[\\u002D\\u2013\\u2014\\u00B7]+[\\t ]*)' + HOLE +
      '([\\t ]*[\\u002D\\u2013\\u2014\\u00B7]+[\\t ]*)',
      'g'
    ),
    (m, left, right) => (left.trim() && right.trim()) ? ' - ' : ''
  );
  // ③ 洞与路径分隔符相邻：两侧都丢（否则留下「- _」或结尾的 _）
  result = result.replace(new RegExp('(' + HOLE + '(SEP)+|(SEP)+HOLE)', 'g'), '');
  // ④ 抹掉剩下的洞、把分隔符哨兵变成下划线、合并多余空白、清掉变空的括号壳
  result = result.split(HOLE).join('')
    .split(SEP).join('_')
    .replace(/[\t ]{2,}/g, ' ')
    .replace(/(\[\s*\]|\(\s*\)|（\s*）|【\s*】)/g, '');

  // 清理可能残留的路径痕迹（.. 是穿越，首尾残留的分隔符没有意义）
  const base = result
    .replace(/[\u002e]{2,}/g, '_')
    .replace(/^[_\u002e\u002f\u005c\u002D\u2013\u2014\u00B7\s]+/, '')
    .replace(/[\s.\u002e\u002f\u005c_\u002D\u2013\u2014\u00B7]+$/, '')
    .trim();

  // 确保有扩展名
  return (base || '未知') + '.' + (ext || 'mp3').replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
}

// 目录段边界：两种分隔符都算（模板可能是 Windows 写法也可能是 POSIX 写法）
const DIR_SEP_RE = /[\u002f\u005c]+/;
// Windows 目录名不许以点或空格收尾；「以点结尾」顺带把 '.' 与 '..' 变成空段
const TRAILING_JUNK_RE = /[. ]+$/;
const DIR_SEG_MAX = 100;

/**
 * 按目录模板渲染出「相对下载根目录」的层级
 *
 * 与文件名模板同一张变量表（buildFields），但对「没有值」的处置正好相反：
 * 文件名缺值补「未知」（总得有个名字），目录缺值整段丢掉 —— 一首没有专辑的
 * 歌不该凭空多出一层 未知/，拼错的变量名（{fo}）更不配生成一个叫 {fo} 的目录。
 *
 * 只负责“段”的干净，不负责“落在哪”：根目录与越界回落归 utils/downloadPath。
 *
 * @param {string} pattern 相对片段模板，如 '{artist}/{album}'
 * @param {object} song 歌曲信息（字段同 renderFileName）
 * @param {object} [opts] { now: Date } 固定渲染时间，供测试用
 * @returns {string[]} 可直接 path.join 的目录段（可能为空数组）
 */
function renderPathSegments(pattern, song, opts) {
  const raw = (pattern == null ? '' : String(pattern)).trim();
  if (!raw) return [];
  const now = (opts && opts.now instanceof Date) ? opts.now : new Date();
  const fields = buildFields(song || {}, now, HOLE);

  const out = [];
  for (const piece of raw.split(DIR_SEP_RE)) {
    let drop = false;
    const rendered = piece.replace(PLACEHOLDER_RE, (_, name) => {
      const key = ALIASES[name] || name;
      const v = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : HOLE;
      if (v === HOLE) drop = true; // 缺值或未知变量：整段作废
      return v;
    });
    if (drop) continue;
    const seg = rendered
      .replace(CONTROL_RE, ' ')
      .replace(ILLEGAL_RE, '_')
      .replace(TRAILING_JUNK_RE, '')
      .trim()
      .slice(0, DIR_SEG_MAX);
    if (seg) out.push(seg);
  }
  return out;
}

/**
 * 预览模板效果（固定样例，含扩展字段）
 * @param {string} template
 * @returns {string} 示例文件名
 */
function previewTemplate(template) {
  return renderFileName(template, {
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    source: 'netease',
    id: '12345',
    quality: 'hq',
    trackNo: '3',
    trackTotal: '12',
    playlistName: '周杰伦精选',
    year: '2003',
  }, 'mp3', { now: new Date('2026-01-15T12:00:00') });
}

/** 模板里写了但模板不支持的变量名（设置页用来提示） */
function unknownPlaceholders(template) {
  const known = new Set(TEMPLATE_VARS.map(v => v.key));
  const unknown = new Set();
  for (const m of String(template || '').matchAll(PLACEHOLDER_RE)) {
    if (!known.has(ALIASES[m[1]] || m[1])) unknown.add(m[1]);
  }
  return Array.from(unknown).sort();
}

module.exports = {
  renderFileName,
  renderPathSegments,
  previewTemplate,
  unknownPlaceholders,
  TEMPLATE_VARS,
  QUALITY_LABELS,
  DEFAULT_TEMPLATE,
};
