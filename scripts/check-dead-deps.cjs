#!/usr/bin/env node
/**
 * 死依赖检测 —— 复验 build/config.cjs 里那批 `!node_modules/xxx/**` 排除项
 * 是否仍然安全。
 *
 * 为什么需要这个脚本：
 *   build/config.cjs 排除了 jade 模版引擎依赖链（asar 减重 3.70 MB / 10.1%）。
 *   依据是「运行时从未加载 + 全仓无 require 引用」——但上游 SDK 一旦升级、
 *   或新增代码走了 jade 渲染的分支，排除项就会**静默**删掉运行时需要的包，
 *   而 npm 构建照样成功、大部分测试照样通过（因为测试不打包）。
 *   这类失效的症状是「用户机器上某个功能莫名其妙报 Cannot find module」。
 *   所以把它做成可复现检查，而不是一次性判断。
 *
 * 用法：
 *   node scripts/check-dead-deps.cjs           # 检查（CI 可跑）
 *   node scripts/check-dead-deps.cjs --verbose  # 打印运行时包全集
 *
 * 退出码：0 = 排除项仍安全；1 = 发现某个排除项被实际 require 了（必须处理）
 */

const Module = require('module');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

// ── 从 build/config.cjs 读取当前的排除清单（单一事实来源，不重复维护）──
function excludedPackages() {
  const cfgPath = path.join(ROOT, 'build', 'config.cjs');
  const src = fs.readFileSync(cfgPath, 'utf8');
  const filesBlock = /files\s*:\s*\[([\s\S]*?)\]/.exec(src);
  if (!filesBlock) throw new Error('无法在 build/config.cjs 中定位 files 数组');
  const pkgs = new Set();
  for (const m of filesBlock[1].matchAll(/['"]!node_modules\/(@[^/'"]+\/[^/'"]+|[^/'"]+)\/\*\*['"]/g)) {
    pkgs.add(m[1]);
  }
  return pkgs;
}

// ── 运行时插桩：记录 src/ 全部模块真正 require 了哪些第三方包 ──
function runtimePackages() {
  const origResolve = Module._resolveFilename;
  const stub = new Proxy({}, {
    get: (_, k) => {
      const noop = () => {};
      switch (k) {
        case 'app': return { getPath: () => '.', getVersion: () => '0.0.0', getAppPath: () => '.',
          getName: () => 'x', isPackaged: false, whenReady: () => Promise.resolve(),
          on: noop, quit: noop, requestSingleInstanceLock: () => true,
          commandLine: { appendSwitch: noop } };
        case 'ipcMain':
        case 'ipcRenderer': return { handle: noop, on: noop, removeHandler: noop,
          invoke: () => Promise.resolve(), send: noop };
        case 'contextBridge': return { exposeInMainWorld: noop };
        case 'BrowserWindow': return class { static getAllWindows() { return []; } };
        case 'Menu': return { setApplicationMenu: noop, buildFromTemplate: () => ({}) };
        case 'Tray': return class { setToolTip() {} setContextMenu() {} on() {} };
        case 'dialog': return { showOpenDialog: () => Promise.resolve({ canceled: true }),
          showMessageBox: () => Promise.resolve({}) };
        case 'shell': return { openExternal: noop, openPath: noop };
        case 'session': return { defaultSession: { webRequest: {
          onBeforeSendHeaders: noop, onHeadersReceived: noop } } };
        case 'screen': return { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) };
        case 'nativeTheme': return { shouldUseDarkColors: false, on: noop };
        case 'protocol': return { handle: noop };
        case 'net': return { fetch: () => Promise.resolve() };
        default: return () => ({});
      }
    },
  });
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return '\0electron-stub';
    return origResolve.call(this, request, ...rest);
  };
  require.cache['\0electron-stub'] = {
    id: '\0electron-stub', filename: '\0electron-stub', loaded: true, exports: stub,
  };

  const loaded = new Set();
  const origLoad = Module._load;
  Module._load = function (request, parent) {
    const p = pkgOf(request, parent);
    if (p) loaded.add(p);
    return origLoad.apply(this, arguments);
  };

  function pkgOf(request, parent) {
    if (typeof request !== 'string' || request === '\0electron-stub') return null;
    if (Module.builtinModules.includes(request)) return null;
    if (request.startsWith('.')) {
      const f = parent && parent.filename;
      const m = f && /[\\/]node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)[\\/]/.exec(f);
      return m ? m[1].replace(/\\/g, '/') : null;
    }
    if (/^[A-Za-z]:[\\/]/.test(request) || request.startsWith('/')) {
      const m = /[\\/]node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/.exec(request);
      return m ? m[1].replace(/\\/g, '/') : null;
    }
    const segs = request.replace(/\\/g, '/').split('/');
    return request.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
  }

  // 遍历 src/（renderer 由 vite 打包，不进 main bundle，单独按需引入）
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'src'));

  const failures = [];
  for (const f of files) {
    try { require(f); }
    catch (e) {
      // preload.js 需要真实 electron 的 contextBridge 形态；其依赖
      // 已被主进程链覆盖，失败不影响结论
      failures.push(path.relative(ROOT, f) + ' → ' + (e.message || e).split('\n')[0]);
    }
  }
  return { loaded, failures, fileCount: files.length };
}

function main() {
  const excluded = excludedPackages();
  if (!excluded.size) {
    console.log('build/config.cjs 中没有 !node_modules/** 排除项，无需检查。');
    return 0;
  }

  console.log('检查 ' + excluded.size + ' 个被排除的包 …\n');
  const { loaded, failures, fileCount } = runtimePackages();
  console.log('运行时插桩：遍历 src/ 下 ' + fileCount + ' 个模块，'
    + '实际加载第三方包 ' + loaded.size + ' 个');
  if (failures.length && VERBOSE) {
    console.log('（以下模块未能独立加载，其依赖已由主进程链覆盖）');
    failures.forEach(f => console.log('    ' + f));
  }
  if (VERBOSE) {
    console.log('\n运行时包全集：');
    console.log([...loaded].sort().map(s => '  ' + s).join('\n'));
  }

  const violations = [...excluded].filter(p => loaded.has(p)).sort();
  console.log('');
  if (violations.length) {
    console.error('✗ 发现被排除但运行时确实加载的包（' + violations.length + ' 个）：');
    violations.forEach(p => console.error('    ' + p));
    console.error('\n这些包从 build/config.cjs 的 files 排除项中移除，否则打包后运行会报 Cannot find module。');
    return 1;
  }

  console.log('✓ 全部 ' + excluded.size + ' 个排除项均未被运行时加载，排除仍然安全。');
  return 0;
}

process.exit(main());
