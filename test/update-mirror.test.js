/**
 * 更新镜像兜底模块的回归测试
 *
 * 背景：自动更新的检查/下载走 api.github.com + github.com，
 * 部分网络（实测国内机器）间歇性断连，检查 3 连败、121MB 资产必挂。
 * 兜底策略：直连失败后按 app-update.yml 的 owner/repo 派生镜像 feed
 * （generic provider + 前缀式镜像），仓库名不许硬编码进镜像模块——
 * 单一真源仍是 build/config.cjs 的 publish 段（retry.test.js 同源约束）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const m = require(path.join(ROOT, 'src', 'main', 'updateMirror'));

test('parseGithubFeed: 从 app-update.yml 文本解析 owner/repo', () => {
  const yml = "owner: some-owner\nrepo: some-repo\nprovider: github\nreleaseType: release\n";
  assert.deepStrictEqual(m.parseGithubFeed(yml), { owner: 'some-owner', repo: 'some-repo' });
});

test('parseGithubFeed: 缺字段 / 非 github provider / 空输入返回 null', () => {
  assert.strictEqual(m.parseGithubFeed('provider: generic\nurl: https://example.com'), null);
  assert.strictEqual(m.parseGithubFeed('owner: o\n'), null);
  assert.strictEqual(m.parseGithubFeed(''), null);
  assert.strictEqual(m.parseGithubFeed(null), null);
});

test('buildMirrorFeeds: 生成 generic feed，URL 指向镜像前缀 + releases/latest/download/', () => {
  const feeds = m.buildMirrorFeeds({ owner: 'o', repo: 'r' }, ['https://ghproxy.net/']);
  assert.strictEqual(feeds.length, 1);
  assert.strictEqual(feeds[0].provider, 'generic');
  assert.strictEqual(feeds[0].url, 'https://ghproxy.net/https://github.com/o/r/releases/latest/download/');
});

test('buildMirrorFeeds: feed 缺失返回空数组（开发环境无 app-update.yml 时自然降级）', () => {
  assert.deepStrictEqual(m.buildMirrorFeeds(null), []);
  assert.deepStrictEqual(m.buildMirrorFeeds({ owner: 'o' }), []);
});

test('useMirrorFeed: 切 feed 同时关差分下载并固定 latest 通道', () => {
  const calls = [];
  const fake = { channel: null, disableDifferentialDownload: false, setFeedURL: (f) => calls.push(f) };
  const feed = { provider: 'generic', url: 'https://ghproxy.net/https://github.com/o/r/releases/latest/download/' };
  m.useMirrorFeed(fake, feed);
  assert.deepStrictEqual(calls, [feed]);
  assert.strictEqual(fake.disableDifferentialDownload, true);
  assert.strictEqual(fake.channel, 'latest');
});

test('守卫：镜像模块不硬编码仓库名/账号名（真源只能是 app-update.yml）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updateMirror.js'), 'utf8');
  assert.doesNotMatch(src, /maliang|MM-Music-Destop/i, '镜像模块出现硬编码仓库标识');
});

test('守卫：updater.js 的检查与下载都接了镜像兜底', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8');
  const hits = src.match(/await tryMirrorFeeds\(/g) || [];
  assert.ok(hits.length >= 2, `镜像兜底须在检查+下载两处接线，实际 ${hits.length}`);
  assert.match(src, /require\('\.\/updateMirror'\)/, 'updater.js 必须接 updateMirror 模块');
});
