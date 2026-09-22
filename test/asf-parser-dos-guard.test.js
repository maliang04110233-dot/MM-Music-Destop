/**
 * 守卫测试：CVE-2026-32256 / CVE-2026-31808 —— 畸形 ASF(WMA) 不得让解析器死循环
 *
 * 为什么必须有这条守卫
 * --------------------
 * 这条守卫是**变异测试过**的，不是「写了就算」：
 *   - music-metadata 7.14.0：子进程 8s 未返回 → 守卫红（HANG，CVE 可复现）
 *   - music-metadata 11.15.0：子进程 ~0.3s 内以错误返回 → 守卫绿
 * 即「删掉修复/退回旧版本，这条测试必然失败」—— 否则它只是装饰。
 *
 * 可达性（为什么这不是「纸面上的 CVE」）
 * --------------------------------------
 *   src/utils/localLibrary.js 的 AUDIO_EXTS 含 `.wma`，而 `.wma` 被
 *   music-metadata 的 ParserFactory 路由到 ASF 解析器。因此用户音乐文件夹里
 *   放一个**畸形 .wma**，扫描时 readAudioMetadata → parseFile 就会永久挂死
 *   Electron 主进程 —— 应用假死，只能强杀。这正是本守卫要钉住的场景。
 *
 * 缺陷机理（摘自 GHSA-v6c2-xwv6-8xf7）
 * -----------------------------------
 *   ASF Header Object → ASF Header Extension Object 内的子对象 objectSize = 0
 *   ⇒ remaining = 0 - 24 = -24 → tokenizer.ignore(-24) 把读位置**倒退** 24 字节
 *   ⇒ extensionSize -= 0 永不减少 → while (extensionSize > 0) 死循环
 *   同族缺陷 CVE-2026-31808 在 file-type 的 ASF 探测路径（55 字节即可触发）。
 *
 * 为什么用子进程 + 超时
 * --------------------
 * 死循环会占满事件循环，在**同进程内**用 Promise.race 做超时是无效的
 * （定时器同样得不到调度）。必须另起进程、由父进程硬超时击杀，
 * 才可能观察到「它没返回」这个事实。
 *
 * 素材布局必须按 music-metadata 自己的 token 定义对齐，勿凭 ASF 规范猜：
 *   HeaderObjectToken.len = 24（GUID 16 + Size 8）
 *   TopLevelHeaderObjectToken 再追加 6（count 4 + reserved1 1 + reserved2 1）→ 30
 *   HeaderExtensionObject.len = 22（reserved1 16 + reserved2 2 + extensionDataSize 4）
 *   ⇒ Header Extension Object 头块 = 24 + 22 = 46 字节
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CHILD_TIMEOUT_MS = 10000;

/** GUID 字符串 → ASF 磁盘字节序（Data1/2/3 小端，Data4 原样） */
function guid(str) {
  const b = Buffer.from(str.replace(/-/g, ''), 'hex');
  return Buffer.from([
    b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6],
    b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15],
  ]);
}

const ASF_HEADER = guid('75B22630-668E-11CF-A6D9-00AA0062CE6C');
const ASF_HEADER_EXT = guid('5FBF03B5-A92E-11CF-8EE3-00C00C205365');
const ASF_PADDING = guid('1806D474-CADF-4509-A4BA-9AABCB96AAE8');

/**
 * 构造 PoC：Header Extension Object 里放一个 objectSize = 0 的 Padding 子对象。
 * Padding 分支在 AsfParser 里是显式 `ignore(remaining)`（remaining = -24），
 * 走的正是 advisory 描述的那条路径。
 */
function makeMalformedAsf({ extDataSize = 24 } = {}) {
  const inner = Buffer.alloc(24);          // 子对象：GUID(16) + Size(8) = 0
  ASF_PADDING.copy(inner, 0);
  inner.writeBigUInt64LE(0n, 16);

  const ext = Buffer.alloc(46);            // GUID(16)+Size(8)+reserved1(16)+reserved2(2)+extDataSize(4)
  ASF_HEADER_EXT.copy(ext, 0);
  ext.writeBigUInt64LE(BigInt(46 + inner.length), 16);
  ASF_HEADER.copy(ext, 24);                // reserved1（内容不被解析）
  ext.writeUInt16LE(0x0006, 40);           // reserved2
  ext.writeUInt32LE(extDataSize, 42);      // 必须 > 0，否则进不了循环

  const head = Buffer.alloc(30);           // GUID(16)+Size(8)+count(4)+reserved1(1)+reserved2(1)
  ASF_HEADER.copy(head, 0);
  head.writeBigUInt64LE(BigInt(30 + ext.length + inner.length), 16);
  head.writeUInt32LE(1, 24);
  head[28] = 0x01;
  head[29] = 0x02;

  return Buffer.concat([head, ext, inner]);
}

/** 在临时目录里落一个畸形 .wma（.wma ∈ AUDIO_EXTS，且被路由到 ASF 解析器） */
function writeMalformedWma() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-asf-guard-'));
  const target = path.join(dir, 'malformed.wma');
  fs.writeFileSync(target, makeMalformedAsf());
  return { dir, target };
}

test('素材自测：PoC 结构符合 advisory 描述（防素材被改坏后守卫变成空转）', () => {
  const buf = makeMalformedAsf();

  assert.strictEqual(buf.length, 100, 'advisory 描述的 PoC 为 ~100 字节');
  assert.ok(buf.subarray(0, 16).equals(ASF_HEADER), '必须以 ASF Header Object GUID 开头');
  assert.strictEqual(buf.readBigUInt64LE(16), 100n, 'Header Object 的 ObjectSize 应等于文件长度');
  assert.strictEqual(buf.readUInt32LE(24), 1, '应声明 1 个顶层子对象');

  // 顶层子对象就是 Header Extension Object
  assert.ok(buf.subarray(30, 46).equals(ASF_HEADER_EXT), '顶层子对象应为 Header Extension Object');
  assert.strictEqual(buf.readBigUInt64LE(46), 70n, 'Header Extension Object 应为 46 + 24 = 70 字节');
  assert.strictEqual(buf.readUInt32LE(72), 24, 'extensionDataSize 必须 > 0（否则进不了循环）');

  // 关键：扩展数据里的子对象 ObjectSize = 0 —— 这就是死循环触发器
  assert.ok(buf.subarray(76, 92).equals(ASF_PADDING), '内层子对象应为 Padding Object');
  assert.strictEqual(buf.readBigUInt64LE(92), 0n, '内层子对象 ObjectSize 必须为 0（触发器本体）');
});

test('守卫：畸形 .wma 不得让 parseFile / readAudioMetadata 挂死主进程', async (t) => {
  const { dir, target } = writeMalformedWma();
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, `
    const out = { parseFile: 'pending', readAudioMetadata: 'pending' };
    function done() {
      if (out.parseFile !== 'pending' && out.readAudioMetadata !== 'pending') {
        console.log(JSON.stringify(out));
        process.exit(0);
      }
    }
    (async () => {
      const mm = require(${JSON.stringify(require.resolve('music-metadata'))});
      try { await mm.parseFile(${JSON.stringify(target)}, { duration: true }); out.parseFile = 'resolved'; }
      catch (e) { out.parseFile = 'rejected:' + (e && e.message); }
      done();

      // 真实应用路径：扫描目录时走的就是它
      const { readAudioMetadata } = require(${JSON.stringify(require.resolve('../src/utils/localLibrary'))});
      try { await readAudioMetadata(${JSON.stringify(target)}); out.readAudioMetadata = 'resolved'; }
      catch (e) { out.readAudioMetadata = 'rejected:' + (e && e.message); }
      done();
    })();
  `);

  const started = Date.now();
  const res = spawnSync(process.execPath, [runner], { timeout: CHILD_TIMEOUT_MS, encoding: 'utf8' });
  const elapsed = Date.now() - started;
  const hung = res.signal === 'SIGTERM' || (res.status === null && elapsed >= CHILD_TIMEOUT_MS - 200);

  assert.strictEqual(
    hung, false,
    `解析畸形 .wma 时子进程在 ${CHILD_TIMEOUT_MS}ms 内未返回（CVE-2026-32256 回归：ASF 解析器死循环，` +
    `真实后果是扫描用户音乐文件夹时主进程永久假死）。stderr=${(res.stderr || '').trim().slice(0, 200)}`,
  );

  const out = JSON.parse((res.stdout || '').trim() || '{}');
  assert.notStrictEqual(out.parseFile, 'pending', 'parseFile 必须在本轮内落定（resolve 或 reject 均可，但不能悬着）');
  assert.notStrictEqual(out.readAudioMetadata, 'pending', 'readAudioMetadata 必须在本轮内落定');
});
