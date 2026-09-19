/**
 * 酷狗 KRC 逐字歌词解码（pure codec，零网络）
 *
 * KRC 是酷狗官方歌词的封装格式，携带**逐字时间戳**（桌面歌词/卡拉OK 的数据基础）。
 * 封装链（实测钉验，样本见 test/fixtures/platforms/kugou.qingtian.krc.txt）：
 *   base64 → 跳过 4 字节魔数（"krc1"）→ 16 字节定长 key 循环 XOR → zlib inflate → 私有标记文本。
 * XOR 方案源自 lx-music-desktop 的 decodeKrc（同格式互操作常量，非安全用途）。
 *
 * 标记语法：
 *   [ti:..] [ar:..] [al:..]        元信息
 *   [startMs,durMs]<o,d,x>字<o,d,x>字…   行 + 词数组（o 为相对行起的偏移 ms）
 *   个别文件带 [id:$..] 头与 [language:base64] 翻译块，此处跳过翻译块。
 *
 * 分层约束：本模块只做格式解码，不 require 平台/网络模块，渲染层不直接依赖。
 */

const zlib = require('zlib');

/** KRC XOR 密钥（格式互操作常量，不是安全密钥） */
const XOR_KEY = Buffer.from([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47,
  0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69,
]);

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function decodeEntities(text) {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/**
 * 解码 KRC content（download 接口 content 字段的 base64 文本）为标记文本。
 * @param {string} contentBase64
 * @returns {string} 标记文本；空输入 ⇒ 空串
 * @throws {Error} 非法 base64 或非 deflate 流（调用方决定降级策略）
 */
function decryptKrc(contentBase64) {
  if (!contentBase64) return '';
  const buf = Buffer.from(contentBase64, 'base64').subarray(4);
  for (let i = 0; i < buf.length; i++) buf[i] ^= XOR_KEY[i % XOR_KEY.length];
  try {
    return zlib.inflateSync(buf).toString('utf8');
  } catch (e) {
    throw new Error(`[krcCodec] KRC 解压失败: ${e.message}`);
  }
}

/**
 * 解析 KRC 标记文本为结构化数据。
 * @param {string} xml
 * @returns {{ meta: Object, lines: Array<{startMs:number,durMs:number,words:Array<{text:string,startMs:number,durMs:number}>}> }}
 */
function parseKrcXml(xml) {
  const meta = {};
  const lines = [];
  if (!xml) return { meta, lines };

  const text = String(xml).replace(/\r/g, '')
    .replace(/^.*\[id:\$\w+\]\n/, '')
    .replace(/\[language:[\w=+/]+\]\n/, '');

  for (const rawLine of text.split('\n')) {
    const lineMatch = rawLine.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lineMatch) {
      const m = rawLine.match(/^\[(ti|ar|al|by):([^\]]*)\]$/);
      if (m) meta[m[1]] = decodeEntities(m[2]);
      continue;
    }
    const startMs = Number(lineMatch[1]);
    const words = [];
    const wordRe = /<(\d+),(\d+),(\d+)>([^<]*)/g;
    let wm;
    while ((wm = wordRe.exec(lineMatch[3])) !== null) {
      if (!wm[4]) continue;
      words.push({
        text: decodeEntities(wm[4]),
        startMs: startMs + Number(wm[1]),
        durMs: Number(wm[2]),
      });
    }
    if (words.length) lines.push({ startMs, durMs: Number(lineMatch[2]), words });
  }
  return { meta, lines };
}

/** 毫秒 → [mm:ss.SSS] */
function formatLrcTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const m = String(Math.floor(total / 60000)).padStart(2, '0');
  const s = String(Math.floor(total / 1000) % 60).padStart(2, '0');
  const sss = String(total % 1000).padStart(3, '0');
  return `[${m}:${s}.${sss}]`;
}

/**
 * 降级合成普通 LRC（下游 .lrc 落盘与现有逐行 UI 直接可用）。
 * @param {Object|string} parsedOrXml parseKrcXml 结果或 KRC 标记文本
 * @returns {string}
 */
function krcToLrc(parsedOrXml) {
  const parsed = typeof parsedOrXml === 'string' ? parseKrcXml(parsedOrXml) : parsedOrXml;
  if (!parsed || !Array.isArray(parsed.lines)) return '';
  return parsed.lines
    .map(l => `${formatLrcTime(l.startMs)}${l.words.map(w => w.text).join('')}`)
    .join('\n');
}

/**
 * 一步解码：content(base64) → { xml, parsed, lrc }。
 * @param {string} contentBase64
 */
function decodeKrc(contentBase64) {
  if (!contentBase64) return { xml: '', parsed: { meta: {}, lines: [] }, lrc: '' };
  const xml = decryptKrc(contentBase64);
  const parsed = parseKrcXml(xml);
  return { xml, parsed, lrc: krcToLrc(parsed) };
}

module.exports = { decryptKrc, parseKrcXml, krcToLrc, decodeKrc };
