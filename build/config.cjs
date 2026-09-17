/**
 * electron-builder 配置 — MusicDL
 *
 * 优化要点：
 * 1. ASAR 压缩打包（比 uncompressed 体积小 40%+）
 * 2. NSIS 安装程序：自定义路径/桌面快捷方式/中英文双语
 * 3. 输出目录独立：release/（避免 dist/ 与 Vite 构建产物冲突）
 * 4. 自动更新：GitHub Releases
 * 5. Linux/macOS 配置
 */
module.exports = {
  appId: 'com.musicdl.app',
  productName: 'MusicDL',
  copyright: 'Copyright © 2026 MusicDL',
  directories: {
    output: 'release',
  },

  // ── 文件包含/排除 ──────────────────────────────────
  // 精确列出 Vite 构建产物，避免递归包含 dist/ 自身
  files: [
    'dist/main/**/*',
    'dist/preload/**/*',
    'dist/renderer/**/*',
    'dist/api/**/*',
    'dist/utils/**/*',
    'dist/shared/**/*',
    'scripts/**/*',
    'assets/**/*',
    'package.json',
    '!**/test/**',
    '!**/__tests__/**',
    '!**/*.map',
    '!**/*.tsbuildinfo',
  ],

  // ── ASAR 压缩 ──────────────────────────────────────
  asar: true,
  asarUnpack: ['**/*.node'],
  compression: 'maximum',

  // ── Windows ────────────────────────────────────────
  win: {
    icon: 'assets/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    verifyUpdateCodeSignature: false,
  },

  // ── NSIS 安装程序 ──────────────────────────────────
  nsis: {
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'MusicDL',
    allowElevation: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: true,
    installerHeaderIcon: 'assets/icon.ico',
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico',
    license: 'LICENSE',
    installerLanguages: ['zh_CN', 'en_US'],
    // 品牌图片（NSIS 2.0 风格：顶部横幅 + 左侧边栏）
    installerHeader: 'build/installerHeader.bmp',
    installerSidebar: 'build/installerSidebar.bmp',
  },

  // ── Linux ──────────────────────────────────────────
  linux: {
    icon: 'assets',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    category: 'AudioVideo',
    desktop: {
      Name: 'MusicDL',
      Categories: 'Audio;Music;Player;',
      Icon: 'assets/icon.png',
    },
  },

  // ── macOS ──────────────────────────────────────────
  mac: {
    icon: 'assets/icon.png',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    category: 'public.app-category.music',
    artifactName: '${name}-${version}-${os}-${arch}.${ext}',
  },

  // ── 自动更新（GitHub Releases）─────────────────────
  publish: {
    provider: 'github',
    owner: 'maliang04110233-dot',
    repo: 'MM-Music-Destop',
    private: false,
    releaseType: 'release',
  },

  // ── 额外资源 ───────────────────────────────────────
  extraResources: [
    { from: 'scripts/', to: 'scripts/', filter: ['**/*'] },
  ],
};
