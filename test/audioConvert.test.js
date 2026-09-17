/**
 * 单元测试：utils/audioConvert.js 转码核心
 *
 * 跑：npm test
 *
 * 覆盖了从 library.js 拆出来的全部纯逻辑，另加一条真实 ffmpeg 冒烟测试
 * （本机没有 ffmpeg 时自动跳过，不影响 CI）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FORMATS, BITRATES,
  normalizeFormat, formatExtension, isBitrate, defaultFormatFor,
  resolveOutputDir, resolveOutputPath, buildFfmpegArgs,
  _probeFfmpeg, findFfmpeg, _resetFfmpegCacheForTest,
  probeDuration, convertAudioFile,
} = require('../src/utils/audioConvert');

// ── 纯函数 ─────────────────────────────────────────────

test('normalizeFormat: 大小写/空白归一，m4a 归到 aac', () => {
  for (const [input, want] of [
    ['mp3', 'mp3'], ['MP3', 'mp3'], [' mp3 ', 'mp3'],
    ['flac', 'flac'], ['AAC', 'aac'], ['m4a', 'aac'], ['M4A', 'aac'],
    ['ogg', 'ogg'], ['wav', 'wav'], ['WAV', 'wav'],
  ]) {
    assert.strictEqual(normalizeFormat(input), want, `normalizeFormat(${JSON.stringify(input)})`);
  }
});

test('normalizeFormat: 未知格式返回 null', () => {
  for (const bad of [undefined, null, '', '   ', 'alac', 'ape', 'opus', 'mp3x']) {
    assert.strictEqual(normalizeFormat(bad), null, `normalizeFormat(${JSON.stringify(bad)})`);
  }
});

test('formatExtension: aac 输出走 m4a 容器，未知格式退回 mp3', () => {
  assert.strictEqual(formatExtension('mp3'), 'mp3');
  assert.strictEqual(formatExtension('flac'), 'flac');
  assert.strictEqual(formatExtension('aac'), 'm4a');
  assert.strictEqual(formatExtension('m4a'), 'm4a');
  assert.strictEqual(formatExtension('ogg'), 'ogg');
  assert.strictEqual(formatExtension('wav'), 'wav');
  assert.strictEqual(formatExtension('bogus'), 'mp3');
  assert.strictEqual(formatExtension(undefined), 'mp3');
});

test('isBitrate: 只认白名单', () => {
  for (const b of BITRATES) assert.ok(isBitrate(b), `应接受 ${b}`);
  for (const bad of [undefined, null, '', '256', '256 kbps', '999k', '1m']) {
    assert.ok(!isBitrate(bad), `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('defaultFormatFor: mp3 保持 mp3，其余一律压到 mp3', () => {
  assert.strictEqual(defaultFormatFor('flac'), 'mp3');
  assert.strictEqual(defaultFormatFor('.FLAC'), 'mp3');
  assert.strictEqual(defaultFormatFor('wav'), 'mp3');
  assert.strictEqual(defaultFormatFor('mp3'), 'mp3');
  assert.strictEqual(defaultFormatFor(undefined), 'mp3');
});

test('FORMATS 定义自洽：每个格式都有合法扩展名与编码器', () => {
  const keys = Object.keys(FORMATS);
  assert.deepStrictEqual(keys.sort(), ['aac', 'flac', 'mp3', 'ogg', 'wav']);
  for (const k of keys) {
    const def = FORMATS[k];
    assert.ok(def.ext && def.ext.length >= 2, `${k} 缺少扩展名`);
    assert.strictEqual(def.codec.length, 2, `${k} 编码器参数应为 2 个`);
    assert.ok(def.lossy === true || def.lossy === false, `${k} lossy 应为布尔`);
    // 无损格式必须是真正的无损编码器
    if (!def.lossy) assert.ok(!/libmp3lame|aac|libvorbis/.test(def.codec[1]), `${k} 不应是有损编码器`);
  }
});

// ── 输出目录与路径 ─────────────────────────────────────

test('resolveOutputDir: 未指定时退回源文件所在目录', () => {
  const input = 'C:\\Music\\Sub\\song.mp3';
  assert.strictEqual(resolveOutputDir(null, input), path.dirname(path.resolve(input)));
  assert.strictEqual(resolveOutputDir('', input), path.dirname(path.resolve(input)));
  assert.strictEqual(resolveOutputDir('D:\\Out', input), 'D:\\Out');
});

test('resolveOutputPath: 同名文件不覆盖，按 _1/_2 递增', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-conv-'));
  try {
    const input = path.join(dir, 'song.mp3');
    fs.writeFileSync(input, 'x');

    const aacOut = path.join(dir, 'song.m4a');
    assert.strictEqual(resolveOutputPath({ inputPath: input, outputDir: dir, format: 'aac' }), aacOut);

    // 第一份已被占用 → 追加 _1
    fs.writeFileSync(aacOut, 'existing');
    const out2 = resolveOutputPath({ inputPath: input, outputDir: dir, format: 'aac' });
    assert.strictEqual(out2, path.join(dir, 'song_1.m4a'));

    // 继续占用 → _2
    fs.writeFileSync(path.join(dir, 'song_1.m4a'), 'existing');
    const out3 = resolveOutputPath({ inputPath: input, outputDir: dir, format: 'aac' });
    assert.strictEqual(out3, path.join(dir, 'song_2.m4a'));

    // 没给输出目录 → 落在源文件同目录
    const sameDir = resolveOutputPath({ inputPath: input, format: 'mp3' });
    assert.ok(sameDir.startsWith(dir + path.sep), `应落在 ${dir} 下，实际 ${sameDir}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── ffmpeg 参数 ────────────────────────────────────────

test('buildFfmpegArgs: 有损格式带比特率，无损格式不带', () => {
  const mp3 = buildFfmpegArgs({
    inputPath: 'in.mp3', outputPath: 'out.mp3', format: 'mp3', bitrate: '192k',
  });
  assert.ok(mp3.includes('-nostdin'), '必须加 -nostdin 防交互');
  assert.deepStrictEqual(mp3.slice(1, 3), ['-i', 'in.mp3']);
  assert.deepStrictEqual(mp3.slice(-1), ['out.mp3']);
  const bIdx = mp3.indexOf('-b:a');
  assert.ok(bIdx > 0 && mp3[bIdx + 1] === '192k', `比特率应为 192k: ${mp3.join(' ')}`);

  const flac = buildFfmpegArgs({
    inputPath: 'in.flac', outputPath: 'out.mp3', format: 'flac', bitrate: '192k',
  });
  assert.ok(!flac.includes('-b:a'), `FLAC 是无损，不应下发比特率: ${flac.join(' ')}`);
  assert.deepStrictEqual(flac.slice(-1), ['out.mp3']);
});

test('buildFfmpegArgs: 非法比特率被丢弃，退回编码器默认值', () => {
  // 注意 undefined 不算非法——它会命中默认值 '320k'，是有意的
  for (const bad of ['1111k', '', '128kbps', null]) {
    const args = buildFfmpegArgs({
      inputPath: 'in', outputPath: 'out.mp3', format: 'mp3', bitrate: bad,
    });
    assert.ok(!args.includes('-b:a'), `非法比特率 ${JSON.stringify(bad)} 不应下发: ${args.join(' ')}`);
  }
});

test('buildFfmpegArgs: 未传比特率时命中默认 320k', () => {
  const args = buildFfmpegArgs({ inputPath: 'in', outputPath: 'out.mp3', format: 'mp3' });
  const i = args.indexOf('-b:a');
  assert.ok(i > 0 && args[i + 1] === '320k', `默认比特率应为 320k: ${args.join(' ')}`);
});

test('buildFfmpegArgs: 未知格式降级为 mp3 而非抛错', () => {
  const args = buildFfmpegArgs({
    inputPath: 'in', outputPath: 'out.mp3', format: 'ape', bitrate: '320k',
  });
  assert.ok(args.includes('libmp3lame'), `未知格式应退回 mp3 编码器: ${args.join(' ')}`);
});

test('buildFfmpegArgs: m4a 归一到 aac 编码器', () => {
  const args = buildFfmpegArgs({
    inputPath: 'in', outputPath: 'out.m4a', format: 'm4a', bitrate: '256k',
  });
  assert.deepStrictEqual(args.slice(args.indexOf('-codec:a')), ['-codec:a', 'aac', '-b:a', '256k', 'out.m4a']);
});

// ── ffmpeg 探测 ────────────────────────────────────────

test('_probeFfmpeg: 不存在的命令返回 false 且不抛错', async () => {
  _resetFfmpegCacheForTest();
  const bogus = path.join(os.tmpdir(), `musicdl-nope-${process.pid}.exe`);
  assert.strictEqual(await _probeFfmpeg(bogus), false);
});

test('findFfmpeg: 返回可用命令或 null，且结果被缓存', async () => {
  _resetFfmpegCacheForTest();

  const first = await findFfmpeg();
  assert.ok(
    first === null || typeof first === 'string',
    `应返回路径字符串或 null，实际: ${JSON.stringify(first)}`
  );

  const t0 = Date.now();
  const second = await findFfmpeg();
  const elapsed = Date.now() - t0;

  assert.strictEqual(second, first, '缓存命中后结果必须一致');
  assert.ok(elapsed < 20, `二次调用应命中缓存立即返回，实际耗时 ${elapsed}ms`);
});

test('findFfmpeg: 全程不调用 child_process 同步 API', async () => {
  _resetFfmpegCacheForTest();

  const cp = require('child_process');
  const syncNames = ['spawnSync', 'execSync', 'execFileSync'];
  const originals = {};
  const called = [];
  for (const n of syncNames) {
    originals[n] = cp[n];
    cp[n] = function guardedSync(...args) {
      called.push(n);
      return originals[n].apply(cp, args);
    };
  }
  try {
    await findFfmpeg();
  } finally {
    for (const n of syncNames) cp[n] = originals[n];
  }

  assert.deepStrictEqual(
    called, [],
    `ffmpeg 探测出现同步进程调用（会冻结 UI 线程）: ${called.join(', ')}`
  );
});

test('_resetFfmpegCacheForTest: 重置后可重新探测（模拟用户新装了 ffmpeg）', async () => {
  _resetFfmpegCacheForTest();
  const a = await findFfmpeg();
  _resetFfmpegCacheForTest();
  const b = await findFfmpeg();
  assert.strictEqual(a, b, '同一台机器上两次探测结果应一致');
});

// ── 真实 ffmpeg 冒烟（未安装时跳过）─────────────────────

const _ffmpeg = require('child_process').spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
const HAS_FFMPEG = _ffmpeg.status === 0;
const NO_FFMPEG = !HAS_FFMPEG ? '本机未找到 ffmpeg，跳过' : false;

test('convertAudioFile: 真实转码产出一个可读取的 mp3，并支持中止', { skip: NO_FFMPEG, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-smoke-'));
  let wav;
  try {
    // 用 lavfi 合成 1 秒正弦波，避免测试依赖任何音频资产
    wav = path.join(dir, 'tone.wav');
    const { spawnSync } = require('child_process');
    const mk = spawnSync('ffmpeg', [
      '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-codec:a', 'pcm_s16le', wav,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    assert.strictEqual(mk.status, 0, '合成测试音频失败: ' + mk.stderr.toString().slice(0, 200));
    assert.ok(fs.existsSync(wav) && fs.statSync(wav).size > 1000, '测试音频文件异常');

    const progresses = [];
    const result = await convertAudioFile({
      inputPath: wav,
      outputDir: dir,
      format: 'mp3',
      bitrate: '128k',
      onProgress: (p) => progresses.push(p),
      timeoutMs: 30000,
    });

    assert.strictEqual(result.success, true, `转码应成功，实际: ${JSON.stringify(result)}`);
    assert.ok(fs.existsSync(result.path), '输出文件不存在');
    assert.strictEqual(path.extname(result.path), '.mp3', '输出应为 .mp3');
    assert.ok(fs.statSync(result.path).size > 0, '输出文件为空');

    // 产物必须能被 ffmpeg 自己重新读出来（否则说明写坏了）
    const probe = await probeDuration('ffmpeg', result.path);
    assert.ok(probe > 0, `输出时长应可解析，实际 ${probe}`);

    // 进度回调：正常转码至少要有一次上报，且不超过 100
    assert.ok(progresses.length > 0, '应至少上报一次进度');
    assert.ok(progresses.every(p => p >= 0 && p <= 100), `进度应在 0-100 内: ${progresses}`);

    // 中止信号生效：编码一个长素材，首次 150ms 轮询即要求中止
    const longWav = path.join(dir, 'long.wav');
    const mkLong = spawnSync('ffmpeg', [
      '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=300',
      '-codec:a', 'pcm_s16le', longWav,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    assert.strictEqual(mkLong.status, 0, '合成长素材失败');

    const r2 = await convertAudioFile({
      inputPath: longWav,
      outputDir: dir,
      format: 'flac',
      shouldStop: () => true,
      timeoutMs: 30000,
    });
    assert.strictEqual(r2.canceled, true, `应返回 canceled，实际: ${JSON.stringify(r2)}`);
    assert.ok(!r2.success, `中止后不得 success: ${JSON.stringify(r2)}`);
  } finally {
    // 刚 kill 掉的 ffmpeg 可能还没完全释放文件句柄
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('convertAudioFile: 源文件不存在时干净报错', async () => {
  const result = await convertAudioFile({
    inputPath: path.join(os.tmpdir(), `musicdl-never-${process.pid}.mp3`),
    outputDir: os.tmpdir(),
    format: 'mp3',
  });
  assert.ok(result.error, '应返回 error');
  assert.ok(!result.success, '不应 success');
});
