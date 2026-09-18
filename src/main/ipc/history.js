/**
 * 下载历史 IPC
 *
 * 注册：query-history / history-stats / clear-history / flush-history
 */

const { handle } = require('./register');
const history = require('../../utils/history');

function register() {
  handle('query-history', (_, opts) => history.query(opts || {}));
  handle('history-stats', () => history.stats());
  handle('clear-history', () => { history.clear(); return true; });
  handle('flush-history', () => { history.flush(); return true; });
}

module.exports = { register };
