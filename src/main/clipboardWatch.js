/**
 * 剪贴板音乐链接监听 —— 「复制即识别」
 *
 * 用户从各平台官方 App 复制分享文案后，无需回到本应用粘贴，
 * 观察器每 2.5s 本地嗅探一次剪贴板，命中链接就推事件给主窗口
 * 弹识别条；点击识别条走搜索页既有的 handleLinkInput 完整流程。
 *
 * 边界（刻意为之）：
 *  - 检测只用 parseMusicLink / detectShortLink（纯正则、零网络）——
 *    用户没点「查看」之前绝不因其剪贴板内容发起任何请求；
 *  - 同一段文本只提示一次（lastText 去重），忽略后不会再骚扰；
 *  - 超过 500 字符的文本由解析器按普通文本忽略（防误粘整篇文章刷屏）；
 *  - prefs.clipboardWatch === false 时直接跳过读取（设置页即时生效，
 *    无需专门的开关 IPC）。
 */

'use strict';

const { clipboard } = require('electron');
const prefs = require('../utils/prefs');
const logger = require('../utils/logger');
const { parseMusicLink, detectShortLink } = require('../utils/linkParser');
const { safeSend } = require('./context');

const TICK_MS = 2500;

let _timer = null;
let _lastText = null;      // 快路径：与上次原文相同直接跳过
const _seen = new Set();    // 已提示过的内容指纹（同一首歌换分享文案也不再重复弹）
const SEEN_MAX = 50;        // 有界环形：Set 保持插入序，超量逐出最早的

/** 纯函数核心：传入剪贴板文本，返回通知载荷或 null（供单测直驱） */
function inspect(text) {
  if (typeof text !== 'string' || !text || text === _lastText) return null;
  _lastText = text;
  const link = parseMusicLink(text);
  let payload = null;
  let key = null;
  if (link) {
    payload = {
      kind: 'link',
      platform: String(link.platform),
      type: String(link.type),
      id: String(link.id),
      raw: text.trim().slice(0, 500),
    };
    key = `link:${link.platform}:${link.type}:${link.id}`;
  } else {
    const host = detectShortLink(text);
    if (host) {
      payload = { kind: 'short', host, raw: text.trim().slice(0, 500) };
      key = `short:${host}:${payload.raw.slice(0, 64)}`;
    }
  }
  if (!payload) return null;
  if (_seen.has(key)) return null; // 提示过一次的内容不再骚扰
  _seen.add(key);
  if (_seen.size > SEEN_MAX) _seen.delete(_seen.values().next().value);
  return payload;
}

function _tick() {
  try {
    if (prefs.get('clipboardWatch') === false) return; // 默认开
    if (!clipboard || typeof clipboard.readText !== 'function') return;
    const payload = inspect(clipboard.readText());
    if (payload) safeSend('clipboard-link', payload);
  } catch (e) {
    logger.warn('[clipboardWatch] 嗅探失败:', e.message || e);
  }
}

function start() {
  if (_timer) return;
  _timer = setInterval(_tick, TICK_MS);
  if (_timer.unref) _timer.unref();
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  start,
  stop,
  _internal: {
    inspect,
    _tick,
    TICK_MS,
    reset: () => { _lastText = null; _seen.clear(); },
  },
};
