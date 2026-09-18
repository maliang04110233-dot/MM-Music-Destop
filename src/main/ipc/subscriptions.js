/**
 * 订阅更新 IPC
 *
 * 注册：subscribe-list / subscribe-add / subscribe-remove /
 *       subscribe-update / subscribe-check / subscribe-mark-seen
 *
 * 全部逻辑在 main/subscriptions.js，这里只做参数转发与结果包装。
 */

const subs = require('../subscriptions');
const { handle } = require('./register');

function register() {
  handle('subscribe-list', () => subs.list());

  handle('subscribe-add', (_, type, platform, targetId, name) => subs.add(type, platform, targetId, name));

  handle('subscribe-remove', (_, key) => subs.remove(key));

  handle('subscribe-update', (_, key, patch) => subs.update(key, patch));

  handle('subscribe-check', async () => subs.checkNow());

  handle('subscribe-mark-seen', (_, key) => subs.markSeen(key));
}

module.exports = { register };
