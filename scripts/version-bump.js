#!/usr/bin/env node
/**
 * 递增版本号（patch）
 *
 * ⚠️ 现状说明：**没有任何 git hook 在调用本脚本**，版本号历史上一向靠手改。
 *    本脚本仅作为手动工具保留：`node scripts/version-bump.js`
 *    若将来希望提交时自动 bump，需自行在 .git/hooks/pre-commit 中接入。
 *
 * 行为：
 * - 读取 package.json 当前 version
 * - bump patch（1.0.0 → 1.0.1 → 1.0.2 …）
 * - 写回 package.json
 * - **同步 package-lock.json 的 version**
 *   （历史上 lock 曾长期落后于 package.json —— 1.0.12 停在 lock 里、
 *    package.json 已到 1.0.14，导致版本溯源混乱，故在此一并同步）
 * - 不做 git add，交给调用方处理索引
 *
 * 环境变量 SKIP_VERSION_BUMP=1 可跳过（供 hook 做递归保护）
 */
const fs = require('fs');
const path = require('path');

if (process.env.SKIP_VERSION_BUMP === '1') process.exit(0);

const pkgPath = path.join(__dirname, '..', 'package.json');
const lockPath = path.join(__dirname, '..', 'package-lock.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;

const parts = oldVersion.split('.').map(Number);
if (parts.length !== 3 || parts.some(Number.isNaN)) {
  console.error('[version-bump] 版本格式不合法:', oldVersion);
  process.exit(1);
}

// bump patch
parts[2] += 1;
const newVersion = parts.join('.');

if (newVersion === oldVersion) {
  console.log('[version-bump] 版本未变化:', oldVersion);
  process.exit(0);
}

pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// 同步 lock（两个 version 字段；缺 lock 或结构异常时告警但不阻断）
let lockSynced = false;
try {
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.version = newVersion;
    if (lock.packages && lock.packages['']) lock.packages[''].version = newVersion;
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    lockSynced = true;
  }
} catch (e) {
  console.warn('[version-bump] package-lock.json 同步失败（不影响版本号更新）:', e.message);
}

console.log(`[version-bump] ${oldVersion} → ${newVersion}${lockSynced ? '（package-lock.json 已同步）' : ''}`);
// 不在此处 git add（会干扰主 commit 的索引写入），由调用方自行处理
