/**
 * 本地曲库目录监听（fs.watch，无第三方依赖）
 *
 * fs.watch 的事件本身不可靠（重复触发、rename 语义混乱、recursive
 * 仅部分平台支持），所以这里只把它当「有变动」的触发器：不解析事件
 * 内容，防抖合并后推送 local-library-changed；正确性由渲染层重走
 * scan-local-library（自带增量缓存）保证，watcher 只负责「何时提醒」。
 */
const fs = require('fs');

/**
 * @param {Object} deps
 * @param {(dir: string|null) => void} deps.emit 变动（防抖后）回调
 * @param {number} [deps.debounceMs] 防抖窗口，默认 1200ms
 * @param {Function} [deps.watch] fs.watch 替身（测试注入）
 * @param {Object} [deps.logger]
 */
function createLibraryWatcher({ emit, debounceMs = 1200, watch = fs.watch, logger }) {
  let _watcher = null;
  let _dir = null;
  let _timer = null;

  function _clear() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (_watcher) {
      try { _watcher.close(); } catch (_e) { /* close 允许失败 */ }
      _watcher = null;
    }
  }

  function _onChange() {
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => {
      _timer = null;
      try { emit(_dir); } catch (_e) { /* 推送失败不打断监听 */ }
    }, debounceMs);
  }

  /** 武装（或切换）监听目录；传空则停止监听 */
  function setDir(dir) {
    if (!dir) { stop(); return; }
    if (_dir === dir && _watcher) return;
    _clear();
    _dir = dir;
    try {
      try {
        _watcher = watch(dir, { recursive: true }, _onChange);
      } catch (_e) {
        // 平台不支持 recursive：降级只盯顶层（新增/删除文件仍会触发）
        _watcher = watch(dir, _onChange);
      }
      _watcher.on('error', (err) => {
        if (logger) logger.warn('[libraryWatcher] 监听出错，已停止:', err && err.message);
        _clear(); // 如目录被删除：watcher 失效即停，下次扫描成功会重新武装
        _dir = null;
      });
    } catch (e) {
      if (logger) logger.warn('[libraryWatcher] 无法监听目录:', e && e.message);
      _watcher = null;
      _dir = null;
    }
  }

  function stop() { _clear(); _dir = null; }

  return { setDir, stop, getDir: () => _dir };
}

module.exports = { createLibraryWatcher };
