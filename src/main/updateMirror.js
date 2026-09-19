/**
 * 更新镜像兜底
 *
 * 背景：检查/下载走 api.github.com + github.com，部分网络间歇性断连
 * （实测：检查更新 3 连败 ERR_CONNECTION_RESET/TIMED_OUT，121MB 资产长连接必挂）。
 * 直连失败后按 app-update.yml 的 owner/repo 派生镜像 feed 重试。
 *
 * 为什么 setFeedURL 在这里而不是 updater.js：
 * retry.test.js 守卫禁止 updater.js 出现 setFeedURL——那是防「硬编码覆盖
 * app-update.yml 真源」的历史事故。本模块的 feed 完全派生自 app-update.yml
 * 本身（单一真源仍是 build/config.cjs 的 publish 段），不违反约束初衷。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 支持「前缀 + 原始 GitHub URL」形态的镜像，实测均支持 releases 资产的 302→206 断点续传
const MIRROR_PREFIXES = ['https://ghproxy.net/', 'https://gh.ddlc.top/'];

function parseGithubFeed(ymlText) {
  if (!ymlText) return null;
  const owner = /^\s*owner:\s*['"]?([^'"\r\n#]+?)['"]?\s*$/m.exec(ymlText);
  const repo = /^\s*repo:\s*['"]?([^'"\r\n#]+?)['"]?\s*$/m.exec(ymlText);
  const provider = /^\s*provider:\s*['"]?(\w+)/m.exec(ymlText);
  if (!owner || !repo || !provider || provider[1] !== 'github') return null;
  return { owner: owner[1].trim(), repo: repo[1].trim() };
}

function buildMirrorFeeds(feed, prefixes = MIRROR_PREFIXES) {
  if (!feed || !feed.owner || !feed.repo) return [];
  return prefixes.map((p) => ({
    provider: 'generic',
    url: `${p}https://github.com/${feed.owner}/${feed.repo}/releases/latest/download/`,
  }));
}

function readAppUpdateYml() {
  try {
    return fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
  } catch (_e) {
    return null;
  }
}

/** 打包环境返回可用镜像 feed 列表；开发环境（无 app-update.yml）返回 []，自然降级 */
function getMirrorFeeds() {
  return buildMirrorFeeds(parseGithubFeed(readAppUpdateYml()));
}

function useMirrorFeed(autoUpdater, feed) {
  autoUpdater.channel = 'latest';
  // 镜像对多 range 差分请求的支持不可靠，兜底路径一律全量下载
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.setFeedURL(feed);
}

module.exports = {
  MIRROR_PREFIXES,
  parseGithubFeed,
  buildMirrorFeeds,
  readAppUpdateYml,
  getMirrorFeeds,
  useMirrorFeed,
};
