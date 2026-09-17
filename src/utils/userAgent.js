/**
 * 统一 User-Agent
 *
 * 曾经 playCache.js 与 api/request.js 各自硬编码一份 UA 字符串，
 * 版本会随时间悄悄过时且两处不同步（审计 L2：Chrome/124）。
 * 集中到这里，更新只改这一处。
 *
 * 版本取 Chrome Stable 真实构建号（2026-08 复核，当前稳定版 152，
 * 151.0.7922.221 为 2026-07-28 发布、8 月大部分时间的稳定构建）。
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.221 Safari/537.36';

module.exports = { USER_AGENT };
