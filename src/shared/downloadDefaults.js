/**
 * 默认目录名单一来源（2026-09 审计余项：魔法数字收表）
 *
 * 背景：'MusicDownloader' 目录名曾在 5 处各写各的，且基目录三套并行
 * （music / userData / home），导致 UI 展示的默认目录与文件真实落点不一致。
 * 规则：目录名字面量只允许出现在本文件；主进程各处一律 defaultDownloadDir(base)。
 */

const path = require('path');

const MUSIC_DIR_NAME = 'MusicDownloader';
const AI_SUBDIR_NAME = 'AI生成';

/** 在给定基目录（如 app.getPath('music')）下拼默认下载目录 */
function defaultDownloadDir(baseDir) {
  return path.join(baseDir, MUSIC_DIR_NAME);
}

module.exports = { MUSIC_DIR_NAME, AI_SUBDIR_NAME, defaultDownloadDir };
