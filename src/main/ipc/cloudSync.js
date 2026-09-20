/**
 * 云同步 IPC - 导出/导入所有用户数据
 *
 * 注册: export-all-data / import-all-data
 */

const { dialog } = require('electron');
const { handle } = require('./register');
const prefs = require('../../utils/prefs');
const { ALLOWED_PREF_KEYS } = require('./prefs');
const history = require('../../utils/history');
const secretStore = require('../../utils/secretStore');
const webdav = require('../../utils/webdav');
const { syncOnce } = require('../../utils/cloudSyncCore');
const { repairIds } = require('../../utils/syncMerge');
const approvedDirs = require('../approvedDirs');
const { DIR_PREF_KEYS } = approvedDirs;
const path = require('path');
const logger = require('../../utils/logger');
// 主进程即 UI 线程：文件 IO 必须异步
const fsa = require('../../utils/fsAsync');

// 不随备份走的键：凭证级数据（prefs.SECRET_KEYS，落盘是 safeStorage 密文，跨机
// 根本解不开，留在备份里只是把密钥材料抄进一个用户可能随手分享的文件）
// + 本机同步配置（WebDAV 连接参数、MCP 令牌）。
// 这份清单同时喂导出与导入两侧 —— 曾经导出侧另抄了一份 5 键字面量，漏掉了
// aiMusicApiKey，结果每次导出都把计费密钥密文写进备份，148 之后导入侧还会把
// 别机器的解不开的密文当本地配置装上。derive 之后新增凭证键自动两侧跟上。
const NONPORTABLE_PREF_KEYS = new Set([...prefs.SECRET_KEYS,
  'webdavUrl', 'webdavUser', 'webdavPass', 'webdavLastSyncAt', 'mcpToken']);

// 导入允许写入的 prefs 键：以 ipc/prefs.js 的 ALLOWED_PREF_KEYS 为唯一来源。
// 曾经这里也手抄过一份字面量清单，结果每加一个设置键就漂移一次——备份里明明
// 存着 换源排除平台/歌词逐曲覆写/倍速/队列完成后动作…，导入时被静默丢弃，
// 换机恢复完用户只看到"设置少了一半"。
const IMPORTABLE_PREF_KEYS = new Set([...ALLOWED_PREF_KEYS,
  // 主进程内部维护的数据键（导出时单独收集，导入时回写）
  'userPlaylists', 'activeDownloadTemplate']);
for (const k of NONPORTABLE_PREF_KEYS) IMPORTABLE_PREF_KEYS.delete(k);

// 导出前挑掉不可携键；返回剔除计数，便于导出侧如实报告
function pickExportablePrefs(raw) {
  const kept = {};
  let dropped = 0;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kept, dropped };
  for (const [key, value] of Object.entries(raw)) {
    if (NONPORTABLE_PREF_KEYS.has(key)) { dropped++; continue; }
    kept[key] = value;
  }
  return { kept, dropped };
}

// 从不可信备份里挑出可回写的 prefs 键。两道闸：白名单 + 目录键的已批准目录守卫
// （导入不等于授予任意目录读写权，被挡下的目录键计数以便如实报告）。
function pickImportablePrefs(raw) {
  const kept = {};
  let droppedDirs = 0;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kept, droppedDirs };
  for (const [key, value] of Object.entries(raw)) {
    if (!IMPORTABLE_PREF_KEYS.has(key)) continue;
    if (DIR_PREF_KEYS.has(key) && value && !approvedDirs.isApprovedDir(value)) {
      droppedDirs++;
      continue;
    }
    kept[key] = value;
  }
  return { kept, droppedDirs };
}

function register() {
  // 导出所有数据
  handle('export-all-data', async () => {
    try {
      const result = await dialog.showSaveDialog({
        title: '导出音乐下载器数据',
        defaultPath: `music-downloader-backup-${Date.now()}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      // 收集所有数据（键名与真实存储对齐：历史在 history.json，EQ 是 eqPreset/eqGains）
      const historyStats = history.stats();
      // WebDAV 凭证、MCP 令牌、AI 计费密钥不进备份：密码/令牌是 safeStorage 密文
      // （跨机不可解），url/user 属本机同步配置，带走只会让另一台设备误连
      const exportedPrefs = pickExportablePrefs(prefs.getAll ? prefs.getAll() : await getAllPrefs());
      const exportData = {
        version: 2,
        exportedAt: new Date().toISOString(),
        app: 'music-downloader',
        data: {
          prefs: exportedPrefs.kept,
          userPlaylists: prefs.get('userPlaylists') || [],
          downloadTemplates: prefs.get('downloadTemplates') || [],
          activeTemplate: prefs.get('activeDownloadTemplate') || null,
          // 真实下载/播放历史（history.json，此前导出的是永无人读的 prefs 废键）
          downloadHistory: history.query({ limit: history.MAX_ENTRIES }).items,
          historyTotal: historyStats.total,
          // EQ 设置（真实键名）
          eqPreset: prefs.get('eqPreset') || null,
          eqGains: prefs.get('eqGains') || null,
        },
      };

      await fsa.writeText(result.filePath, JSON.stringify(exportData, null, 2));
      return { success: true, path: result.filePath };
    } catch (e) {
      logger.warn('导出失败:', e);
      return { success: false, error: e.message };
    }
  });

  // 导入数据
  handle('import-all-data', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '导入音乐下载器数据',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });

      if (result.canceled || !result.filePaths?.length) {
        return { success: false, canceled: true };
      }

      const filePath = result.filePaths[0];
      const content = await fsa.tryReadText(filePath);
      if (content === null) {
        return { success: false, error: '无法读取所选文件' };
      }
      const importData = JSON.parse(content);

      // 验证格式
      if (!importData.app || !importData.data) {
        return { success: false, error: '文件格式无效，不是有效的备份文件' };
      }

      if (importData.app !== 'music-downloader') {
        return { success: false, error: '该文件来自其他应用，不匹配' };
      }

      const { data } = importData;
      const results = [];

      // 恢复歌单 / 模板 / 活动模板（真实存储键）
      // 备份文件是外部数据：id 修复后再入库（渲染层拿 id 拼 onclick）
      if (Array.isArray(data.userPlaylists)) {
        const playlists = repairIds(data.userPlaylists, 'pl');
        prefs.set('userPlaylists', playlists);
        results.push(`歌单: ${playlists.length} 个`);
      }

      if (Array.isArray(data.downloadTemplates)) {
        const templates = repairIds(data.downloadTemplates, 'tpl');
        prefs.set('downloadTemplates', templates);
        results.push(`下载模板: ${templates.length} 个`);
      }

      if (data.activeTemplate !== undefined) {
        prefs.set('activeDownloadTemplate', data.activeTemplate);
      }

      // 恢复下载历史（真实存储在 history.json；旧版备份里存在 prefs 里的
      // downloadHistory 键是废数据，此处只接受数组）
      if (Array.isArray(data.downloadHistory) && data.downloadHistory.length) {
        const imported = history.importEntries(data.downloadHistory);
        results.push(`下载历史: 导入 ${imported} 条`);
      }

      // 恢复 EQ 设置（真实键名 eqPreset/eqGains；兼容旧备份的 eqSettings 对象）
      if (data.eqPreset !== undefined || data.eqGains !== undefined) {
        if (data.eqPreset !== undefined) prefs.set('eqPreset', data.eqPreset);
        if (data.eqGains !== undefined) prefs.set('eqGains', data.eqGains);
        results.push('EQ 设置');
      } else if (data.eqSettings && typeof data.eqSettings === 'object') {
        prefs.set('eqPreset', data.eqSettings.preset);
        prefs.set('eqGains', data.eqSettings.gains);
        results.push('EQ 设置');
      }

      // 通用设置：只接受白名单键（导入文件内容不可信，防止注入未知键）
      if (data.prefs && typeof data.prefs === 'object') {
        const { kept, droppedDirs } = pickImportablePrefs(data.prefs);
        for (const [key, value] of Object.entries(kept)) prefs.set(key, value);
        const applied = Object.keys(kept).length;
        if (applied) results.push(`通用设置: ${applied} 项`);
        if (droppedDirs) results.push(`目录设置: ${droppedDirs} 项被忽略（需在设置中重新选择）`);
      }

      return {
        success: true,
        message: `导入成功:\n${results.join('\n')}`,
      };
    } catch (e) {
      logger.warn('导入失败:', e);
      return { success: false, error: e.message };
    }
  });

  // ── WebDAV 快照同步 ────────────────────────────────
  // 与上面的手动导出/导入不同：同步是可合并三类数据
  // （歌单/下载模板/下载历史）的双向并集，saveDir 等机器相关设置不参与。

  handle('cloud-sync-config-get', () => ({
    url: prefs.get('webdavUrl') || '',
    user: prefs.get('webdavUser') || '',
    hasPass: Boolean(prefs.get('webdavPass')),
    lastSyncAt: prefs.get('webdavLastSyncAt') || null,
  }));

  handle('cloud-sync-config-set', (_e, cfg) => {
    if (!cfg || typeof cfg !== 'object') return { success: false, error: '参数无效' };
    const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
    if (url) {
      let u = null;
      try { u = new URL(url); } catch (_) { /* fallthrough */ }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
        return { success: false, error: '同步地址必须是合法的 http(s) URL' };
      }
    }
    prefs.set('webdavUrl', url);
    prefs.set('webdavUser', typeof cfg.user === 'string' ? cfg.user.trim() : '');
    // pass 为 undefined 时保持原密码不变；空串表示清除
    if (typeof cfg.pass === 'string') {
      prefs.set('webdavPass', cfg.pass ? secretStore.encrypt(cfg.pass) : '');
    }
    return { success: true };
  });

  handle('cloud-sync-now', async () => {
    const config = {
      url: prefs.get('webdavUrl') || '',
      user: prefs.get('webdavUser') || '',
      pass: secretStore.decrypt(prefs.get('webdavPass') || ''),
    };
    const result = await syncOnce({
      config,
      localData: {
        userPlaylists: prefs.get('userPlaylists') || [],
        downloadTemplates: prefs.get('downloadTemplates') || [],
        downloadHistory: history.query({ limit: history.MAX_ENTRIES }).items,
      },
      fetchSnapshot: webdav.fetchSnapshot,
      pushSnapshot: webdav.pushSnapshot,
      applyMerged: (merged) => {
        prefs.set('userPlaylists', merged.userPlaylists);
        prefs.set('downloadTemplates', merged.downloadTemplates);
        // 历史走 importEntries 的 id+source upsert，天然幂等
        history.importEntries(merged.downloadHistory);
        history.flush();
      },
    });
    if (result.success) prefs.set('webdavLastSyncAt', Date.now());
    return result;
  });
}

async function getAllPrefs() {
  // prefs.js 可能没有 getAll，尝试直接读取
  try {
    const prefsPath = path.join(require('electron').app.getPath('userData'), 'prefs.json');
    const raw = await fsa.tryReadText(prefsPath);
    if (raw) return JSON.parse(raw);
  } catch (_) {
    // 忽略非 JSON 格式或文件缺失
  }
  return {};
}

module.exports = {
  register, IMPORTABLE_PREF_KEYS, NONPORTABLE_PREF_KEYS, pickImportablePrefs, pickExportablePrefs,
};
