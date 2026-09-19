/**
 * 单元测试：utils/krcCodec.js —— 酷狗 KRC 逐字歌词解码
 *
 * 为什么值得测：KRC 是酷狗官方歌词的封装格式（逐字时间戳），解码链
 * （base64 → 跳 4 字节魔数 → 定长 XOR → zlib inflate → 私有标记语法）
 * 每一步都是位运算/正则级的细节，改错一处就是「歌词整段消失」或
 * 「逐字时间轴全偏」。用 2026-09-18 实测抓取的《晴天》真实样本钉行为，
 * 不造假数据 —— 假样本验不出真实魔数头与语言块的存在。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  decryptKrc,
  parseKrcXml,
  krcToLrc,
  decodeKrc,
} = require('../src/utils/krcCodec');

// 真实抓包样本（酷狗 lyrics.kugou.com/download?fmt=krc 的 content 字段）
const KRC_B64 = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'platforms', 'kugou.qingtian.krc.txt'), 'utf8',
).trim();

// ══════════════════════════════════════════════════════════
// decryptKrc：封装格式解码
// ══════════════════════════════════════════════════════════

test('decryptKrc: 真实《晴天》样本解出 KRC 文本（含元信息与逐字词标记）', () => {
  const xml = decryptKrc(KRC_B64);
  assert.ok(xml.includes('[ti:晴天]'));
  assert.ok(xml.includes('[ar:周杰伦]'));
  // 逐字标记：<偏移ms,时长ms,?>字
  assert.ok(/<0,450,\d+>词/.test(xml), '应含 <0,450,x>词 逐字标记');
});

test('decryptKrc: 空输入返回空串（歌词缺失是正常态，不得抛错）', () => {
  assert.strictEqual(decryptKrc(''), '');
});

test('decryptKrc: 非法 base64 / 解压失败 ⇒ 抛 Error 而非静默返回垃圾', () => {
  assert.throws(() => decryptKrc('!!!!not-base64!!!!'), Error);
  // 能 base64 解码但不是 deflate 流
  assert.throws(() => decryptKrc(Buffer.from('xxxxxxxx').toString('base64')), Error);
});

// ══════════════════════════════════════════════════════════
// parseKrcXml：私有标记 → 结构化逐字数据
// ══════════════════════════════════════════════════════════

const PARSED = parseKrcXml(decryptKrc(KRC_B64));

test('parseKrcXml: 元信息进 meta，不混入歌词行', () => {
  assert.strictEqual(PARSED.meta.ti, '晴天');
  assert.strictEqual(PARSED.meta.ar, '周杰伦');
  assert.strictEqual(PARSED.meta.al, '叶惠美');
  assert.ok(PARSED.lines.length > 10);
});

test('parseKrcXml: 行结构 = 起始/时长 + 词数组，词的绝对时间 = 行起始 + 偏移', () => {
  // 实测第二行：[2250,2250]<0,450,0>词<450,450,0>：<900,450,0>周<1350,450,0>杰<1800,450,0>伦
  const line = PARSED.lines.find(l => l.words.map(w => w.text).join('') === '词：周杰伦');
  assert.ok(line, '应存在「词：周杰伦」行');
  assert.strictEqual(line.startMs, 2250);
  assert.strictEqual(line.durMs, 2250);
  assert.deepStrictEqual(line.words.map(w => w.text), ['词', '：', '周', '杰', '伦']);
  assert.deepStrictEqual(line.words.map(w => w.startMs), [2250, 2700, 3150, 3600, 4050]);
  assert.deepStrictEqual(line.words.map(w => w.durMs), [450, 450, 450, 450, 450]);
});

test('parseKrcXml: 空/无行输入 ⇒ 合法空结构', () => {
  const p = parseKrcXml('');
  assert.deepStrictEqual(p.meta, {});
  assert.deepStrictEqual(p.lines, []);
});

// ══════════════════════════════════════════════════════════
// krcToLrc：降级合成普通 LRC（下游 .lrc 落盘 / 现有 UI 兼容）
// ══════════════════════════════════════════════════════════

test('krcToLrc: 行时间戳格式 [mm:ss.SSS]，文本为整行拼接', () => {
  const lrc = krcToLrc(PARSED);
  assert.ok(lrc.includes('[00:02.250]词：周杰伦'), lrc.slice(0, 200));
  assert.ok(lrc.includes('[00:04.500]曲：周杰伦'));
});

test('krcToLrc: 入参可为 parse 结果或 xml 文本，幂等安全', () => {
  const a = krcToLrc(PARSED);
  const b = krcToLrc(decryptKrc(KRC_B64));
  assert.strictEqual(a, b);
});

// ══════════════════════════════════════════════════════════
// decodeKrc：一步到位的便利入口
// ══════════════════════════════════════════════════════════

test('decodeKrc: 返回 { xml, parsed, lrc } 三件套（调用方各取所需）', () => {
  const r = decodeKrc(KRC_B64);
  assert.ok(r.xml.includes('[ti:晴天]'));
  assert.strictEqual(r.parsed.meta.ti, '晴天');
  assert.ok(r.lrc.includes('[00:02.250]'));
});

test('decodeKrc: 空输入 ⇒ 空三件套，不抛错', () => {
  const r = decodeKrc('');
  assert.strictEqual(r.xml, '');
  assert.deepStrictEqual(r.parsed, { meta: {}, lines: [] });
  assert.strictEqual(r.lrc, '');
});
