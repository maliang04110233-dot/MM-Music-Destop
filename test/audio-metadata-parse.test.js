/**
 * 单元测试：本地曲库元数据解析（music-metadata 解析契约）
 *
 * 为什么需要它
 * ------------
 * `utils/localLibrary.js` 的 readAudioMetadata 是「本地播放无图无词」的主修复点，
 * 但它此前**零测试覆盖** —— 而它是唯一依赖 music-metadata 的地方。
 * 后果：升级 music-metadata（如 7.14.0 → 11.x，ESM-only + 大版本跳跃）时
 * 没有任何自动化手段能回答「解析还能用吗」，只能靠人手动开应用点一遍。
 *
 * 本文件用**纯代码合成**的 WAV 素材补齐这个缺口（不提交二进制 fixture，
 * 不依赖 ffmpeg，测试自带素材、可复现）：
 *   1. readAudioMetadata 必须真的走 music-metadata 分支（_source 判定），
 *      不能悄悄退化成文件名兜底 —— 否则「升级后解析全挂」会表现为
 *      「测试照样绿」，那才是真正的危险；
 *   2. durationMs 必须是**解码出的真实时长**（±容差），不能等于
 *      estimateDuration 的估算值 —— 两者口径不同，混起来就测不出解析失败；
 *   3. CommonJS 侧 `require('music-metadata')` 必须仍可用（ESM-only 包的
 *      入口契约），这是 11.x 升级最容易被忽略的破坏点。
 *
 * 素材构造
 * --------
 * WAV 是唯一能纯字节合成、且 music-metadata 一定认的格式：
 *   RIFF/WAVE + fmt (PCM) + data（440Hz 正弦，避免全静音被某些解析器短路）。
 * 同目录再放一个 cover.jpg，用于**短路在线封面拉取**（否则
 * readAudioMetadata 会因 source==='music-metadata' 而发起网络请求，
 * 让单测变成联网测试）。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { readAudioMetadata, clearMetaCache } = require('../src/utils/localLibrary');

const SAMPLE_RATE = 8000;
const CHANNELS = 1;
const BITS = 16;
const SECONDS = 0.5;

/** 合成一个可被真实解码的 WAV（PCM / 单声道 / 16bit / 440Hz 正弦） */
function makeWav({ sampleRate = SAMPLE_RATE, channels = CHANNELS, bitsPerSample = BITS, seconds = SECONDS } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.round(sampleRate * seconds);
  const dataLen = frameCount * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);                                        // audioFormat = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);    // byteRate
  buf.writeUInt16LE(channels * bytesPerSample, 32);                 // blockAlign
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);

  for (let i = 0; i < frameCount; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000);
    buf.writeInt16LE(s, 44 + i * 2);
  }
  return buf;
}

/** 最小合法 JPEG 头（FF D8 FF）—— 只为让 guessMime 认成 image/jpeg 并短路在线拉取 */
const MINIMAL_JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0xFF, 0xD9]);

/** 建一个临时曲库目录：sample.wav + cover.jpg（同目录封面） */
async function makeTempLibrary() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'musicdl-audio-'));
  const audioPath = path.join(dir, 'sample.wav');
  await fsp.writeFile(audioPath, makeWav());
  await fsp.writeFile(path.join(dir, 'cover.jpg'), MINIMAL_JPEG);
  return { dir, audioPath };
}

test('readAudioMetadata 走 music-metadata 分支并解出真实时长', async (t) => {
  const { dir, audioPath } = await makeTempLibrary();
  t.after(async () => { clearMetaCache(); await fsp.rm(dir, { recursive: true, force: true }); });

  const meta = await readAudioMetadata(audioPath);

  // 1) 必须真的是 music-metadata 解析出来的，不能退化成文件名/估算兜底
  assert.strictEqual(
    meta._source, 'music-metadata',
    `期望走 music-metadata 分支，实际 _source=${JSON.stringify(meta._source)}（解析失败会静默退兜底）`,
  );

  // 2) 真实解码时长，不是 estimateDuration 的估算
  const expectedMs = SECONDS * 1000;
  assert.ok(
    typeof meta.durationMs === 'number' && Math.abs(meta.durationMs - expectedMs) <= 60,
    `时长应为 ${expectedMs}ms 附近，实际 ${meta.durationMs}ms`,
  );

  // 3) 位率来自解码结果（8000Hz × 16bit × 1ch = 128000）
  assert.strictEqual(meta.bitrate, SAMPLE_RATE * BITS * CHANNELS);

  // 4) 同目录封面兜底生效（同时证明没有走在线拉取：_source 未被改成 'qq-online'）
  assert.match(String(meta.cover), /^data:image\/jpeg;base64,/);
  assert.strictEqual(meta._source, 'music-metadata', '同目录有封面时不应改判为在线封面来源');

  // 5) 无标签时文件名兜底仍要填上 title（下游 UI 依赖它非空）
  assert.strictEqual(meta.title, 'sample');
});

test('CommonJS 侧 require("music-metadata") 仍可用且导出 parseFile', () => {
  const mm = require('music-metadata');
  assert.strictEqual(
    typeof mm.parseFile, 'function',
    'music-metadata 主入口必须能在 CommonJS 里被 require 且暴露 parseFile（11.x 起为 ESM-only）',
  );
  assert.strictEqual(typeof mm.parseBuffer, 'function');
});

test('parseFile 接受 localLibrary 实际传入的选项组合（duration / skipCovers）', async (t) => {
  const { dir, audioPath } = await makeTempLibrary();
  t.after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  const mm = require('music-metadata');
  // 与 src/utils/localLibrary.js 第 109 行的调用形态保持一致 —— 选项被重命名/移除时这里先红
  const parsed = await mm.parseFile(audioPath, { duration: true, skipCovers: false });

  assert.ok(parsed && parsed.format, 'parseFile 必须返回 { common, format }');
  assert.strictEqual(parsed.format.container, 'WAVE');
  assert.strictEqual(parsed.format.numberOfChannels, CHANNELS);
  assert.strictEqual(parsed.format.sampleRate, SAMPLE_RATE);
  assert.ok(Math.abs(parsed.format.duration - SECONDS) <= 0.06, `duration=${parsed.format.duration}`);
});

test('素材自测：合成的 WAV 头符合 RIFF/WAVE 规范（防「素材坏了导致解析失败被当成解析器问题」）', () => {
  const wav = makeWav();
  assert.strictEqual(wav.length, 44 + Math.round(SAMPLE_RATE * SECONDS) * CHANNELS * (BITS / 8));
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(wav.toString('ascii', 12, 16), 'fmt ');
  assert.strictEqual(wav.toString('ascii', 36, 40), 'data');
  assert.strictEqual(wav.readUInt32LE(4), wav.length - 8, 'RIFF chunk size 必须等于文件长度 - 8');
  assert.strictEqual(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.strictEqual(wav.readUInt16LE(34), BITS);
  assert.ok(fs.existsSync(require.resolve('../src/utils/localLibrary')), 'localLibrary 可被解析');
});
