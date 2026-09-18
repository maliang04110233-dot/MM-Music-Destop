/**
 * asar 冒烟测试 —— 断言「打进包里的东西」确实正确
 *
 * 为什么需要它
 * ------------
 * `electron-builder` 打包成功 **不等于** 内容正确。以下都会静默产出旧内容或残缺包：
 *   - scripts/postbuild.js 漏拷某个目录（该脚本靠「目录清单」手工维护）
 *   - 平台模块被 rollup 当成 external（vite.config.js 的 rollupOptions.external）
 *   - 新增平台文件没被 readdirSync 扫到（打包时机/路径问题）
 *   - 版本号忘了同步（package.json 与 package-lock.json 各存一份）
 * 这些在开发态全看不出来 —— 开发态跑的是 src/ 源码，不是 dist/ 产物。
 * 只有把包解开、逐文件比对，才能确认「用户拿到手的那个 exe」是对的。
 *
 * 用法
 * ----
 *   node scripts/smoke-asar.js [app.asar 路径]
 * 默认路径：<repo>/release/win-unpacked/resources/app.asar
 * 未指定且默认路径不存在时，自动在 .preview/ 下找最近一次打包产物。
 * 退出码：0 = 全通过，1 = 有断言失败，2 = 找不到 asar
 *
 * ⚠ @electron/asar 的两个路径坑（已封装进 read()，勿绕过）
 *   1. listPackage() 返回的路径带**前导反斜杠**（如 \dist\main\index.js）
 *   2. extractFile() 对「前导分隔符 + 正斜杠」的混合形态不认
 *   两者都会把「内容不对」误报成「文件不存在」，白白浪费排查时间。
 *
 * ⚠ 第三个坑：绝不要用 `npx asar extract-file` 读包内文件
 *   该子命令把内容写到「当前工作目录 + 包内路径」——
 *   `asar extract-file app.asar package.json` 会**静默覆盖仓库自己的
 *   package.json**（scripts / devDependencies / keywords 全丢，
 *   而 npm 依旧能跑，直到 `npm run build` 报 Missing script 才暴露；
 *   实测踩过，靠 git 恢复）。读包内文件一律用 asar.extractFile() 取 Buffer。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── 断言框架 ────────────────────────────────────────────
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** 归一化 asar 内路径：剥前导分隔符 + 统一正斜杠 */
function norm(p) {
  return String(p).replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

/**
 * 剥离 JS 注释后再做符号断言。
 * 必须如此：bundle 是压缩产物，若某行 `window.resetEq = resetEq;` 被注释掉，
 * 裸正则仍会命中注释文本，把「断链」误报成「已挂载」——守卫就白设了。
 * 块注释用等长空格替换以保留行结构。
 */
function stripJsComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** 定位 asar —— 显式参数 > release/ > .preview 下最新产物 */
function locateAsar() {
  const explicit = process.argv[2];
  if (explicit) return path.resolve(explicit);

  const release = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');
  if (fs.existsSync(release)) return release;

  // 退回 .preview/ 下形如 package-1.0.19/win-unpacked/... 的产物，取版本号最大的
  const preview = path.join(ROOT, '.preview');
  if (fs.existsSync(preview)) {
    const cands = fs.readdirSync(preview)
      .filter((d) => /^package-/.test(d))
      .sort()
      .reverse()
      .map((d) => path.join(preview, d, 'win-unpacked', 'resources', 'app.asar'))
      .filter((p) => fs.existsSync(p));
    if (cands.length) return cands[0];
  }
  return release;
}

let asar;
try {
  asar = require('@electron/asar');
} catch (_e) {
  console.error('缺少 @electron/asar —— 该包随 electron-builder 安装，请先 npm install');
  process.exit(2);
}

const ASAR = locateAsar();
if (!fs.existsSync(ASAR)) {
  console.error('找不到 asar:', ASAR);
  console.error('请先 npm run package，或显式传入路径：node scripts/smoke-asar.js <app.asar>');
  process.exit(2);
}

/** 读 asar 内文件（两种路径形态都试，见文件头说明） */
function read(posixRel) {
  const bare = norm(posixRel);
  for (const key of [bare.replace(/\//g, '\\'), bare]) {
    try { return asar.extractFile(ASAR, key).toString('utf8'); } catch (_e) { /* 试下一种 */ }
  }
  return null;
}

/**
 * 读包内二进制文件的原始字节。
 * 必须与 read() 分开：read() 会 toString('utf8')，二进制再转回来已经不是原字节
 * （PNG 里含非法 UTF-8 序列，转一圈会丢信息），做字节比对会永远不相等。
 */
function readBuffer(posixRel) {
  const bare = norm(posixRel);
  for (const key of [bare.replace(/\//g, '\\'), bare]) {
    try { return asar.extractFile(ASAR, key); } catch (_e) { /* 试下一种 */ }
  }
  return null;
}

// ── 开始 ────────────────────────────────────────────────
console.log('asar:', path.relative(ROOT, ASAR), `(${fs.statSync(ASAR).size} B)\n`);

const set = new Set(asar.listPackage(ASAR).map(norm));

// 1) 平台模块齐全 —— 期望清单**从 src 目录读**，不写死。
//    写死清单的话，新增平台时这里永远「通过」，等于没测。
const platformDir = path.join(ROOT, 'src', 'api', 'platforms');
const expectedPlatforms = fs.existsSync(platformDir)
  ? fs.readdirSync(platformDir).filter((f) => f.endsWith('.js') && f !== 'index.js')
  : [];
const missingPlatforms = expectedPlatforms.filter((f) => !set.has(`dist/api/platforms/${f}`));
check(
  `asar 含全部平台模块（src 中共 ${expectedPlatforms.length} 个）`,
  expectedPlatforms.length > 0 && missingPlatforms.length === 0,
  missingPlatforms.length ? '缺: ' + missingPlatforms.join(', ') : `${expectedPlatforms.length} 个`
);

// 2) postbuild 的目录清单：这些漏拷会导致运行期 require 失败（且只在打包后复现）
const mustCopy = [
  'dist/api/gateway.js',
  'dist/api/pluginRegistry.js',
  'dist/shared/dto.js',
  'dist/main/downloadQueue.js',
  'dist/main/ipc/search.js',
  'dist/utils/logger.js',
  'dist/utils/rejectionGuard.js',
  'dist/utils/urlGuard.js',
];
const missCopy = mustCopy.filter((p) => !set.has(p));
check('postbuild 拷贝的关键模块齐备', missCopy.length === 0,
  missCopy.length ? '缺: ' + missCopy.join(', ') : `${mustCopy.length} 个`);

// 3) 主进程 bundle 里归口确实被调用（不是只 require 了没接）
const mainJs = read('dist/main/index.js') || '';
check('dist/main/index.js 含 installRejectionGuard 调用',
  /installRejectionGuard/.test(mainJs), `${mainJs.length} B`);

// 4) 渲染层产物形态：源下拉只剩「全部」一个 option，其余由 IPC 清单动态生成。
//    v3 的关键契约 —— 若这里 >1，说明平台清单又被写回 HTML 了。
const html = read('dist/renderer/index.html') || '';
const sel = html.match(/<select[^>]*id="sourceSelect"[\s\S]*?<\/select>/);
const optCount = sel ? (sel[0].match(/<option/g) || []).length : -1;
check('dist/renderer/index.html 的 #sourceSelect 仅 1 个 option（平台清单改由 IPC 驱动）',
  optCount === 1, `options=${optCount}`);

// 5) 独立窗口样式：不在 Vite 入口内，靠 postbuild 单拷，最容易漏
check('asar 含 dist/renderer/styles/base.css（独立窗口样式依赖）',
  set.has('dist/renderer/styles/base.css'));

// 6) 版本号 —— package.json 必查；package-lock.json 缺失时**跳过而非失败**。
//
//    为什么 lock 缺失不算错：app-builder-lib 在 fileMatcher 的默认忽略清单里
//    硬编码排除了 package-lock.json（连同 yarn.lock / pnpm-lock.yaml /
//    bun.lock），优先级高于 build/config.cjs 的 files 数组 —— 想打也打不进去。
//    所以「包内版本一致」只能退化为「包内 package.json 版本 = 期望版本」，
//    由 scripts/version-bump.js 在源头保证它与 lock 同步。
//    若将来 builder 允许打入了（或换了打包器），下面自动升级为强断言。
const pkgJson = JSON.parse(read('package.json') || '{}');
const lockRaw = read('package-lock.json');
check('asar 内 package.json 版本非空', !!pkgJson.version, `pkg=${pkgJson.version}`);
if (lockRaw) {
  const lockJson = JSON.parse(lockRaw);
  check('asar 内 package.json / package-lock.json 版本一致',
    pkgJson.version === lockJson.version, `pkg=${pkgJson.version} lock=${lockJson.version}`);
} else {
  console.log('SKIP  asar 内 package-lock.json —— 被 app-builder-lib 强制排除，非缺陷');
}

// 7) 渲染层 bundle 存在且含本轮关键符号（防 bundle 被跳过）
const assets = [...set].filter((p) => /^dist\/renderer\/assets\/index-.*\.js$/.test(p));
const bundle = assets.length ? (read(assets[0]) || '') : '';
check('渲染层 bundle 含 refreshPlayerState（顶栏状态单一判据）',
  /refreshPlayerState/.test(bundle), assets[0] ? `${bundle.length} B` : '未找到 bundle');

// 8) 渲染层子模块若被 tree-shake 或 re-export 断链，其 window 挂载会静默失效，
//    而 vite build 照样成功 —— 这是「拆分真出事」的唯一兜底。
//    期望清单一律从源码的 export 面**推导**，不硬编码（否则以后加函数时永远通过）。
function exportedNamesOf(srcPath) {
  if (!fs.existsSync(srcPath)) return null;
  const src = fs.readFileSync(srcPath, 'utf8');
  const acc = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) acc.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) acc.add(n);
    }
  }
  return [...acc].sort();
}

const bundleNoComments = stripJsComments(bundle);
const RENDERER_JS = path.join(ROOT, 'src', 'renderer', 'js');

// 8a) EQ 簇 → player/eq.js：6 个函数须仍挂 window（HTML 有 8 处 onclick/oninput）
const eqNames = exportedNamesOf(path.join(RENDERER_JS, 'player', 'eq.js'));
if (eqNames) {
  const missing = eqNames.filter((n) => !new RegExp(`window\\.${n}\\s*=`).test(bundleNoComments));
  check(`渲染层 bundle 挂载了 player/eq.js 全部 ${eqNames.length} 个 EQ 函数（拆分未被 tree-shake）`,
    eqNames.length === 6 && missing.length === 0,
    missing.length ? '缺: ' + missing.join(', ') : eqNames.join(', '));
}

// 8b) syncTo* / 队列恢复 → player-sync.js：**不挂 window**，只被 app.js 内部调用。
//
//     ⚠️ 这里不能断言函数名 —— 压缩器会重命名「非 window 挂载」的模块内部函数
//     （实测：syncMiniPlayer 等 6 个标识符在 bundle 里全被改名，代码其实完好）。
//     早期版本正是这么写的，于是断言恒假、白报失败。正确的锚点是
//     **压缩不会改动的字符串字面量**：IPC 频道名字符串与用户可见文案。
//     它们一旦消失，说明这段逻辑真的被 tree-shake 掉了。
const SYNC_ANCHORS = [
  { label: 'syncMiniPlayer 频道', lit: 'syncMiniPlayer' },
  { label: 'syncDesktopLyric 频道', lit: 'syncDesktopLyric' },
  { label: 'trayUpdatePlayState 频道', lit: 'trayUpdatePlayState' },
  { label: 'playQueueRestored 频道', lit: 'onPlayQueueRestored' },
  { label: '队列恢复提示文案', lit: '恢复播放队列' },
  { label: '无歌占位文案', lit: '未在播放' },
];
const syncSrcPath = path.join(RENDERER_JS, 'player-sync.js');
if (fs.existsSync(syncSrcPath)) {
  const gone = SYNC_ANCHORS.filter((a) => !bundleNoComments.includes(a.lit));
  check(`渲染层 bundle 保留了 player-sync.js 的逻辑（以字符串字面量为锚，未被 tree-shake）`,
    gone.length === 0,
    gone.length ? '丢失: ' + gone.map((g) => g.label).join(', ') : `${SYNC_ANCHORS.length} 个锚点齐备`);
}

// 9) 打进去的图标必须是「当前 assets/ 里的那一份」。
//
//    ⚠️ 为什么不能只检查「asar 里有 icon.png」：
//    图标是 scripts/gen-icon.js 程序化生成的，改了脚本要**重新打包**才会生效。
//    release/ 里的 asar 完全可能还是几天前的旧产物（历史上真发生过），
//    里面躺着的正是带「图片由AI生成」水印的旧图标 —— 而所有测试都照样绿。
//    所以这里比对字节，确保包内图标与工作区图标一致。
const iconSrc = path.join(ROOT, 'assets', 'icon.png');
const iconInAsar = readBuffer('assets/icon.png');
if (fs.existsSync(iconSrc) && iconInAsar) {
  const same = Buffer.compare(fs.readFileSync(iconSrc), iconInAsar) === 0;
  check('asar 内 assets/icon.png 与工作区当前图标一致（防打进去旧图标）',
    same,
    same ? `${iconInAsar.length} B` : `包内 ${iconInAsar.length} B ≠ 工作区 ${fs.statSync(iconSrc).size} B —— 请重新打包`);
} else {
  check('asar 内 assets/icon.png 存在', false, '未找到');
}

// 9b) 包内图标不得含「AI 生成」水印元数据。
//     这是产品缺陷级检查：水印会随安装包发给最终用户。
if (iconInAsar) {
  let watermark = false;
  try {
    // 只扫 tEXt/iTXt/zTXt 文本块，按 UTF-8 解码
    let off = 8;
    while (off < iconInAsar.length - 8) {
      const len = iconInAsar.readUInt32BE(off);
      const type = iconInAsar.slice(off + 4, off + 8).toString('ascii');
      if (type === 'IEND') break;
      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        if (/AI\s*生成|AI-generated|图片由/i.test(iconInAsar.slice(off + 8, off + 8 + len).toString('utf8'))) {
          watermark = true;
        }
      }
      off += 12 + len;
    }
  } catch { /* 解析失败交给 check:icons 报 */ }
  check('asar 内图标不含「AI 生成」水印文案', !watermark,
    watermark ? '发现水印，会随安装包发给用户' : '无水印');
}

// ── 汇总 ────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log('  - ' + f.name);
}
process.exit(failed.length ? 1 : 0);
