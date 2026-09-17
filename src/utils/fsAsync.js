/**
 * 异步文件系统工具
 *
 * 为什么需要它：
 *   Electron 主进程同时承担 UI 消息循环。任何 fs.*Sync 都会在磁盘 IO 期间
 *   独占事件循环，直接表现为窗口卡死、动画掉帧、拖拽无响应。扫描本地库时
 *   「每首歌一次 statSync」会把几秒钟的冻结累积起来，是用户能直接感知的卡顿。
 *
 * 本模块把主进程常用的同步 fs 调用统一换成 fs.promises 版本，并约定：
 *   - 查询类（exists / statOrNull / sizeOf / tryReadText / readJson）
 *     永不抛错，缺失即返回 false / null —— 这类调用点原本就是
 *     `existsSync(x) ? ... : ...` 的形态，抛错只会污染调用方。
 *   - 变更类（ensureDir / removeQuiet / writeText / writeJson）
 *     只吞掉「目标不存在」这类幂等场景的错误，其它错误照常抛出。
 *
 * 何时仍该用同步 API：
 *   - 进程启动早期（app ready 之前），事件循环还没跑起来，异步没有意义；
 *   - 同步 flush 语义的配置写入（见 utils/prefs.js 的 flush）。
 *   这两类例外在 utils/atomicFile.js 里保留了同步变体。
 */

const fsp = require('fs').promises;

/** 参数是否是可用的路径字符串（IPC 入参可能来自渲染层，必须是防御性的） */
function _isPath(p) {
  return typeof p === 'string' && p.length > 0;
}

/**
 * 是否存在（替代 fs.existsSync）
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function exists(p) {
  if (!_isPath(p)) return false;
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 取 stat，失败返回 null（替代 `existsSync(x) ? statSync(x) : null`）
 * @param {string} p
 * @returns {Promise<import('fs').Stats|null>}
 */
async function statOrNull(p) {
  if (!_isPath(p)) return null;
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/**
 * 取文件字节数，失败返回 null
 * @param {string} p
 * @returns {Promise<number|null>}
 */
async function sizeOf(p) {
  const st = await statOrNull(p);
  return st ? st.size : null;
}

/**
 * 递归创建目录（幂等，已存在不抛错）
 * @param {string} p
 */
async function ensureDir(p) {
  if (!_isPath(p)) return;
  await fsp.mkdir(p, { recursive: true });
}

/**
 * 删除文件，忽略「不存在」与入参非法（替代 try { if (existsSync) unlinkSync } catch）
 * @param {string} p
 */
async function removeQuiet(p) {
  if (!_isPath(p)) return;
  try {
    await fsp.unlink(p);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/**
 * 读文本，失败返回 null
 * @param {string} p
 * @param {string} [encoding='utf8']
 * @returns {Promise<string|null>}
 */
async function tryReadText(p, encoding = 'utf8') {
  if (!_isPath(p)) return null;
  try {
    return await fsp.readFile(p, encoding);
  } catch {
    return null;
  }
}

/**
 * 读 JSON，缺失或解析失败返回 null
 * @param {string} p
 * @returns {Promise<*|null>}
 */
async function readJson(p) {
  const raw = await tryReadText(p);
  if (raw === null || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 写 JSON（非原子，用于可重建的数据；需要抗崩溃请用 atomicFile）
 * @param {string} p
 * @param {*} data
 * @param {number} [space=2]
 */
async function writeJson(p, data, space = 2) {
  await fsp.writeFile(p, JSON.stringify(data, null, space), 'utf8');
}

/**
 * 写文本
 * @param {string} p
 * @param {string|Buffer} data
 * @param {string} [encoding='utf8']
 */
async function writeText(p, data, encoding = 'utf8') {
  await fsp.writeFile(p, data, encoding);
}

/** 目录是否存在（且确实是目录） */
async function isDir(p) {
  const st = await statOrNull(p);
  return !!(st && st.isDirectory());
}

module.exports = {
  fsp,
  exists,
  statOrNull,
  sizeOf,
  ensureDir,
  removeQuiet,
  tryReadText,
  readJson,
  writeJson,
  writeText,
  isDir,
};
