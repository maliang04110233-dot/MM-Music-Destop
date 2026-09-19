/**
 * 默认值收表回归（2026-09 审计余项：魔法数字收表）
 *
 * 审计发现同一「默认下载目录」在 5 处各写各的：
 *   - get-default-dir（UI 展示）与 index.js 启动建目录用 <music>/MusicDownloader
 *   - downloadQueue 实际落盘兜底却用 <userData>/MusicDownloader
 *   - downloadTemplates 路径校验兜底用 <home>/Music
 * 后果：用户没设过 saveDir 时，UI 显示的目录和文件真实落点不一致，
 * 模板校验还会把真实默认目录下的路径误判为越界。
 * 收表原则：目录名只允许出现在 src/shared/downloadDefaults.js 一处，
 * 其余地方一律引用它（渲染层无法 require CJS 的部分用等值钉防漂移）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readSrc = (...p) =>
  fs.readFileSync(path.join(ROOT, 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

/** 递归收集 src 下全部 .js 文件（相对 src 的路径片段数组） */
function walkJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, 'src', ...dir), { withFileTypes: true })) {
    const p = [...dir, e.name];
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 把 walkJs 返回的路径片段规整成相对 src 的平台路径（去掉首层空段） */
const relOf = (p) => path.join(...p.filter(Boolean));

// ── 共享模块本体行为 ─────────────────────────────────────

test('downloadDefaults: defaultDownloadDir 在给定基目录下拼 MusicDownloader', () => {
  const { MUSIC_DIR_NAME, AI_SUBDIR_NAME, defaultDownloadDir } =
    require('../src/shared/downloadDefaults');
  assert.strictEqual(MUSIC_DIR_NAME, 'MusicDownloader');
  assert.strictEqual(AI_SUBDIR_NAME, 'AI生成');
  assert.strictEqual(defaultDownloadDir(path.join('X:', 'music')),
    path.join('X:', 'music', 'MusicDownloader'));
});

// ── 字面量单一来源扫描 ───────────────────────────────────

test("'MusicDownloader' 字面量只允许出现在 shared/downloadDefaults.js", () => {
  const offenders = [];
  for (const p of walkJs([''])) {
    if (relOf(p) === path.join('shared', 'downloadDefaults.js')) continue;
    if (readSrc(...p).includes("'MusicDownloader'")) offenders.push(relOf(p));
  }
  assert.deepStrictEqual(offenders, [], '以下文件复制了目录名，应改引 downloadDefaults');
});

test("主进程禁止复制 'AI生成' 目录名（渲染层的同名文本是默认歌名，不在射程）", () => {
  const offenders = walkJs(['main'])
    .filter(p => readSrc(...p).includes("'AI生成'"))
    .map(p => p.join('/'));
  assert.deepStrictEqual(offenders, [], 'AI 子目录名应统一取自 downloadDefaults.AI_SUBDIR_NAME');
});

test("主进程禁止复制 '{artist} - {title}'（naming.js 已导出 DEFAULT_TEMPLATE）", () => {
  const bannedDir = path.join('main');
  const offenders = walkJs(['main'])
    .filter(p => readSrc(bannedDir, ...p.slice(1)).includes("'{artist} - {title}'"))
    .map(relOf);
  assert.deepStrictEqual(offenders, [], '主进程应 require naming.js 的 DEFAULT_TEMPLATE');
});

test('downloadTemplates: 路径校验兜底不得再用 home/Music（与真实默认目录脱节）', () => {
  const src = readSrc('main', 'ipc', 'downloadTemplates.js');
  assert.doesNotMatch(src, /getPath\('home'\)/,
    "校验兜底必须与落盘/展示同源（downloadDefaults），'home'+Music 是第三套默认");
});

// ── request.js 超时常量收表 ──────────────────────────────

test('request.js: 超时数值收进具名常量，禁止散落的裸数字', () => {
  const src = readSrc('api', 'request.js');
  assert.match(src, /const DEFAULT_TIMEOUT_MS = 15000;/);
  assert.match(src, /const PROBE_TIMEOUT_MS = 8000;/);
  assert.doesNotMatch(src, /options\.timeout \|\| 15000/, '应引用 DEFAULT_TIMEOUT_MS');
  assert.doesNotMatch(src, /opts\.timeout \|\| 8000/, '应引用 PROBE_TIMEOUT_MS');
});

// ── 死模块防复活 ─────────────────────────────────────────

test('utils/filename.js 死模块已删除（与 utils/naming.js 双模板体系二义）', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'utils', 'filename.js')),
    'filename.js 零引用且模板语法与 naming.js 冲突，不应复活');
});
