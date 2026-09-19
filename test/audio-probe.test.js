/**
 * audioProbe 单元测试：ffprobePathFrom 推导 + analyzeProbe 判定（真实 ffprobe JSON 形状）
 */
const test = require('node:test');
const assert = require('node:assert');

const { ffprobePathFrom, analyzeProbe, probeAudioFile } = require('../src/utils/audioProbe');

test('ffprobePathFrom：PATH 裸名→裸名，全路径→同目录，怪名字→null', () => {
  assert.strictEqual(ffprobePathFrom('ffmpeg', 'win32'), 'ffprobe.exe');
  assert.strictEqual(ffprobePathFrom('ffmpeg', 'linux'), 'ffprobe');
  assert.strictEqual(ffprobePathFrom('C:\\ffmpeg\\bin\\ffmpeg.exe', 'win32'), 'C:\\ffmpeg\\bin\\ffprobe.exe');
  assert.strictEqual(ffprobePathFrom('/usr/bin/ffmpeg', 'linux'), '/usr/bin/ffprobe');
  assert.strictEqual(ffprobePathFrom('/opt/tools/ffmpeg-special', 'linux'), null); // 改过名不瞎猜
  assert.strictEqual(ffprobePathFrom(null, 'win32'), null);
  assert.strictEqual(ffprobePathFrom('', 'win32'), null);
});

function ffJson(streams, format) {
  const out = { streams };
  if (format) out.format = format;
  return out;
}

test('analyzeProbe：MP3 内核（哪怕装在 flac 文件名里）判 lossy', () => {
  const r = analyzeProbe(ffJson([
    { codec_type: 'audio', codec_name: 'mp3', bit_rate: '192000', sample_rate: '44100' },
  ]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.verdict, 'lossy');
  assert.strictEqual(r.codec, 'mp3');
  assert.strictEqual(r.bitrateKbps, 192);
  assert.strictEqual(r.sampleRate, 44100);
});

test('analyzeProbe：flac/pcm/alac 高码率判 lossless，低码率 flac 判 suspicious', () => {
  assert.strictEqual(analyzeProbe(ffJson([{ codec_type: 'audio', codec_name: 'flac', bit_rate: '921000' }])).verdict, 'lossless');
  assert.strictEqual(analyzeProbe(ffJson([{ codec_type: 'audio', codec_name: 'pcm_s16le', bit_rate: '1411000' }])).verdict, 'lossless');
  assert.strictEqual(analyzeProbe(ffJson([{ codec_type: 'audio', codec_name: 'alac', bit_rate: '800000' }])).verdict, 'lossless');
  assert.strictEqual(analyzeProbe(ffJson([{ codec_type: 'audio', codec_name: 'flac', bit_rate: '320000' }])).verdict, 'suspicious');
});

test('analyzeProbe：流上无 bit_rate 时回退 format.bit_rate；两者都缺记为码率未知', () => {
  const fromFormat = analyzeProbe(ffJson([{ codec_type: 'audio', codec_name: 'aac' }], { bit_rate: '256000' }));
  assert.strictEqual(fromFormat.bitrateKbps, 256);
  assert.strictEqual(fromFormat.verdict, 'lossy');
  const none = analyzeProbe(ffJson([{ codec_type: 'audio', codec_name: 'flac' }], {}));
  assert.strictEqual(none.bitrateKbps, null);
  assert.strictEqual(none.verdict, 'lossless'); // 码率未知时不误伤：无损编码即给无损
});

test('analyzeProbe：没有音频流/输入畸形返回 ok:false 而非抛错', () => {
  assert.strictEqual(analyzeProbe(ffJson([{ codec_type: 'video', codec_name: 'h264' }])).ok, false);
  assert.strictEqual(analyzeProbe({}).ok, false);
  assert.strictEqual(analyzeProbe(null).ok, false);
});

test('probeAudioFile：ffprobe 不存在时以 error 结构落地，不抛异常', async () => {
  const r = await probeAudioFile('C:\\Music\\a.flac', { ffprobePath: '__no_such_ffprobe_binary__', timeoutMs: 2000 });
  assert.ok(r && typeof r.error === 'string' && r.error.length > 0);
});
