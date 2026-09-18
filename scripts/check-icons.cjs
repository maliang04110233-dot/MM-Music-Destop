/**
 * check-icons.cjs — 图标与安装器图片的静态守卫
 *
 * 为什么需要这个脚本：
 *   `assets/icon.png` 曾经是一张 1024×1024 的 **AI 生成图**，右下角烧录了
 *   「图片由AI生成」水印，会随安装包一起发给最终用户；且整张图**全不透明**，
 *   圆外没有 alpha，Windows 任务栏 / macOS Dock / 桌面会显示成一块方角色板。
 *   这两个缺陷**都能通过 build 与全部测试**，没有任何自动检查会发现 ——
 *   所以必须专门守住。
 *
 * 本脚本只做静态检查，不启动 Electron、不依赖网络。
 *
 * 检查项：
 *   A. icon.png   —— 圆外必须透明；不得为「整张不透明」（方角）
 *   B. icon.png   —— 尺寸受控（避免又塞回 1MB 级大图）
 *   C. icon.ico   —— 结构合法（type=1）；含足够多的尺寸档位；含 16/32/48/256
 *   D. icon.ico   —— 各档位圆外透明（不能在缩放后变方角）
 *   E. 安装器 BMP —— 24bpp、BI_RGB、尺寸符合 NSIS 规范
 *   F. 全仓无「AI 生成」水印文案混入图片元数据（PNG tEXt 等文本块）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const BUILD = path.join(ROOT, 'build');

const failures = [];
const passes = [];

function ok(msg) {
  passes.push(msg);
}

function fail(msg) {
  failures.push(msg);
}

// ─────────────────────────────────────────────────────────────
// PNG 解码（只支持 8-bit RGBA / RGB，够用且不引依赖）
// ─────────────────────────────────────────────────────────────

function parsePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');

  let off = 8;
  let ihdr = null;
  const idat = [];
  const textChunks = [];

  while (off < buf.length - 8) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      // ⚠️ 必须按 UTF-8 解码，**不能用 latin1**。
      // 用 latin1 读中文会得到乱码（「图片由AI生成」→「å¾çç±AIçæ」），
      // 于是下面的水印正则永远匹配不上 —— 守卫静默失效，且不报任何错。
      // （本文件初版正犯此错，靠变异测试才发现。）
      textChunks.push(data.toString('utf8'));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (!ihdr) throw new Error('缺 IHDR');
  if (ihdr.bitDepth !== 8) throw new Error('仅支持 8-bit，实际 ' + ihdr.bitDepth);
  if (ihdr.interlace !== 0) throw new Error('不支持隔行 PNG');

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error('不支持的颜色类型 ' + ihdr.colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);

  // 逐行反滤波（PNG 的 5 种 filter）
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.from(line);

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: cur[x] = (cur[x] + a) & 0xff; break;
        case 2: cur[x] = (cur[x] + b) & 0xff; break;
        case 3: cur[x] = (cur[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[x] = (cur[x] + pred) & 0xff;
          break;
        }
        default: throw new Error('未知 filter ' + filter);
      }
    }
    cur.copy(out, y * stride);
    prev = cur;
  }

  return { ...ihdr, channels, data: out, textChunks };
}

/** 取某像素的 alpha（RGB 图视为全不透明） */
function alphaAt(img, x, y) {
  if (img.channels === 4) return img.data[(y * img.width + x) * 4 + 3];
  if (img.channels === 2) return img.data[(y * img.width + x) * 2 + 1];
  return 255;
}

// ─────────────────────────────────────────────────────────────
// A/B. icon.png
// ─────────────────────────────────────────────────────────────

function checkIconPng() {
  const p = path.join(ASSETS, 'icon.png');
  if (!fs.existsSync(p)) {
    fail('assets/icon.png 不存在');
    return;
  }

  const buf = fs.readFileSync(p);
  const img = parsePNG(buf);

  // 尺寸受控：太大的 PNG 会白占安装包体积（历史上是 1024×1024 / 1.1MB）
  if (img.width > 1024 || img.height > 1024) {
    fail(`icon.png 尺寸 ${img.width}x${img.height} 过大（应 ≤1024）`);
  } else {
    ok(`icon.png 尺寸 ${img.width}x${img.height} 在合理范围`);
  }

  // 体积预算：程序化生成的图标应在几十 KB 量级；
  // 若哪天又换成照片级大图，这条会拦住。
  const sizeKB = buf.length / 1024;
  if (sizeKB > 300) {
    fail(`icon.png 体积 ${sizeKB.toFixed(0)} KB 超出 300 KB 预算（疑似又换回大图）`);
  } else {
    ok(`icon.png 体积 ${sizeKB.toFixed(0)} KB 在预算内`);
  }

  // 圆外透明：四角与四边中点必须全透明，否则是方角图标
  const probes = [
    ['左上角', 1, 1],
    ['右上角', img.width - 2, 1],
    ['左下角', 1, img.height - 2],
    ['右下角', img.width - 2, img.height - 2],
    ['上边中', Math.floor(img.width / 2), 1],
    ['下边中', Math.floor(img.width / 2), img.height - 2],
  ];
  const opaqueCorners = probes.filter(([, x, y]) => alphaAt(img, x, y) > 8);
  if (opaqueCorners.length > 0) {
    fail(
      `icon.png 四角/边缘不透明（方角图标会让系统显示成色板）：` +
        opaqueCorners.map(([n]) => n).join('、')
    );
  } else {
    ok('icon.png 圆外透明（无方角底板）');
  }

  // 中心必须不透明，否则图标是空的
  if (alphaAt(img, Math.floor(img.width / 2), Math.floor(img.height / 2)) < 200) {
    fail('icon.png 中心透明 —— 图标内容为空');
  } else {
    ok('icon.png 中心有不透明内容');
  }

  // 应存在足量半透明像素（抗锯齿边缘）；若完全没有，说明边缘是硬切，会有锯齿
  let semi = 0;
  for (let i = 3; i < img.data.length; i += img.channels) {
    const a = img.data[i];
    if (a > 8 && a < 247) semi++;
  }
  if (semi < 100) {
    fail(`icon.png 半透明像素仅 ${semi} 个 —— 圆缘缺抗锯齿，会有明显锯齿`);
  } else {
    ok(`icon.png 有 ${semi} 个半透明像素（圆缘抗锯齿正常）`);
  }

  // 元数据不得夹带「AI 生成」类水印文案
  const blob = img.textChunks.join(' ');
  if (/AI\s*生成|AI-generated|图片由/i.test(blob)) {
    fail('icon.png 元数据含「AI 生成」水印文案');
  } else {
    ok('icon.png 元数据无水印文案');
  }
}

// ─────────────────────────────────────────────────────────────
// C/D. icon.ico
// ─────────────────────────────────────────────────────────────

function checkIconIco() {
  const p = path.join(ASSETS, 'icon.ico');
  if (!fs.existsSync(p)) {
    fail('assets/icon.ico 不存在');
    return;
  }

  const buf = fs.readFileSync(p);
  if (buf.readUInt16LE(0) !== 0) fail('icon.ico 保留字段非 0');
  if (buf.readUInt16LE(2) !== 1) fail(`icon.ico type=${buf.readUInt16LE(2)}（应为 1）`);

  const count = buf.readUInt16LE(4);
  if (count < 4) {
    fail(`icon.ico 仅含 ${count} 个尺寸（过少，系统缩放会糊）`);
    return;
  }

  const sizes = [];
  const entries = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const size = buf[off] || 256;
    const bytes = buf.readUInt32LE(off + 8);
    const dataOff = buf.readUInt32LE(off + 12);
    sizes.push(size);
    entries.push({ size, dataOff, bytes });
  }

  // 关键档位必须齐备：16/32 用于任务栏与资源管理器，48 用于桌面，256 用于大图标
  const required = [16, 32, 48, 256];
  const missing = required.filter(s => !sizes.includes(s));
  if (missing.length) {
    fail(`icon.ico 缺少关键尺寸 ${missing.join('/')}`);
  } else {
    ok(`icon.ico 关键尺寸齐备（16/32/48/256），共 ${count} 档：${sizes.join('/')}`);
  }

  // 每档的 PNG 数据都要圆外透明
  const square = [];
  for (const e of entries) {
    let img;
    try {
      img = parsePNG(buf.slice(e.dataOff, e.dataOff + e.bytes));
    } catch (err) {
      fail(`icon.ico 的 ${e.size}x${e.size} 档解析失败：${err.message}`);
      continue;
    }
    const corner =
      alphaAt(img, 1, 1) > 8 ||
      alphaAt(img, img.width - 2, 1) > 8 ||
      alphaAt(img, 1, img.height - 2) > 8 ||
      alphaAt(img, img.width - 2, img.height - 2) > 8;
    if (corner) square.push(e.size);
  }
  if (square.length) {
    fail(`icon.ico 以下档位圆外不透明（方角）：${square.join('/')}`);
  } else {
    ok('icon.ico 全部档位圆外透明');
  }
}

// ─────────────────────────────────────────────────────────────
// E. 安装器 BMP
// ─────────────────────────────────────────────────────────────

function checkInstallerBmp() {
  const specs = [
    { file: 'installerHeader.bmp', w: 150, h: 57 },
    { file: 'installerSidebar.bmp', w: 164, h: 314 },
  ];

  for (const spec of specs) {
    const p = path.join(BUILD, spec.file);
    if (!fs.existsSync(p)) {
      fail(`build/${spec.file} 不存在`);
      continue;
    }
    const b = fs.readFileSync(p);

    if (b.slice(0, 2).toString('ascii') !== 'BM') {
      fail(`${spec.file} 不是 BMP（缺 BM 签名）`);
      continue;
    }

    const dataOff = b.readUInt32LE(10);
    const dibSize = b.readUInt32LE(14);
    const w = b.readInt32LE(18);
    const h = b.readInt32LE(22);
    const bpp = b.readUInt16LE(28);
    const compression = b.readUInt32LE(30);

    // NSIS 要求 24bpp 非压缩。历史上这两个文件是 8bpp 索引色，
    // 部分 NSIS 版本会渲染异常或直接拒绝。
    if (bpp !== 24) {
      fail(`${spec.file} 位深 ${bpp}bpp（NSIS 要求 24bpp）`);
    } else {
      ok(`${spec.file} 位深 24bpp`);
    }

    if (compression !== 0) {
      fail(`${spec.file} 压缩方式 ${compression}（NSIS 要求 BI_RGB=0）`);
    } else {
      ok(`${spec.file} 非压缩 BI_RGB`);
    }

    if (w !== spec.w || h !== spec.h) {
      fail(`${spec.file} 尺寸 ${w}x${h}（应为 ${spec.w}x${spec.h}）`);
    } else {
      ok(`${spec.file} 尺寸 ${w}x${h} 符合 NSIS 规范`);
    }

    if (dibSize !== 40) {
      fail(`${spec.file} DIB 头 ${dibSize} 字节（NSIS 兼容性最好的是 40）`);
    }

    // 文件长度应正好等于 头 + 像素（每行 4 字节对齐）
    const rowSize = Math.ceil((w * bpp) / 8 / 4) * 4;
    const expected = dataOff + rowSize * h;
    if (b.length !== expected) {
      fail(`${spec.file} 长度 ${b.length} 与推算 ${expected} 不符（可能被截断）`);
    } else {
      ok(`${spec.file} 长度与像素数据推算一致`);
    }
  }
}

// ─────────────────────────────────────────────────────────────

checkIconPng();
checkIconIco();
checkInstallerBmp();

console.log('\n图标与安装器图片检查\n');
for (const m of passes) console.log('  PASS  ' + m);
for (const m of failures) console.log('  FAIL  ' + m);

if (failures.length) {
  console.log(`\n${failures.length} 项未通过，${passes.length} 项通过。`);
  console.log('\n提示：图标由 scripts/gen-icon.js 程序化生成，直接重跑即可修复：');
  console.log('  node scripts/gen-icon.js');
  process.exit(1);
}

console.log(`\n全部 ${passes.length} 项通过。`);
