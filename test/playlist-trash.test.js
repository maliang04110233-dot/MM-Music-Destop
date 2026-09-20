/**
 * 歌单回收站 + 撤销删除（增量156，审计 F2「删除必见影响 → 5 秒撤销 → 回收站兜底」第一层）
 *
 * 三层覆盖（沿用本仓惯例）：
 *  1. 纯函数：utils/playlistTrash.js 的挪站/放回/过期清，零 IO；
 *  2. 真 prefs 端到端：删→查站→撤销→冲突清理→启动清过期（electron 打桩，同 favorites.test.js）；
 *  3. 接线钉：主进程三个 handler 必须真的调纯函数、渲染层确认框必须点名影响、
 *     撤销必须走既有 save-user-playlist —— 契约三个频道的 args 形状逐字钉死，
 *     并反向钉「不许出现回收站新通道」。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  trashRemove, trashRestore, purgeExpired, TRASH_TTL_MS, MAX_TRASH,
} = require('../src/utils/playlistTrash');

const DAY = 24 * 60 * 60 * 1000;
const PL_A = { id: 'pl_a', name: 'A', songs: [{ id: 1, source: 'netease' }] };
const PL_B = { id: 'pl_b', name: 'B', songs: [] };

// ── 1. 纯函数 ─────────────────────────────────────────

test('trashRemove: 挪进回收站并盖 deletedAt，入参数组零突变', () => {
  const list = [PL_A, PL_B];
  const trash = [];
  const r = trashRemove(list, trash, 'pl_a', 1234);
  assert.deepEqual(r.playlists.map(p => p.id), ['pl_b']);
  assert.equal(r.trash.length, 1);
  assert.equal(r.trash[0].playlist, PL_A);
  assert.equal(r.trash[0].deletedAt, 1234);
  assert.equal(r.removed, PL_A);
  // 入参原封不动（调用方手里可能还有同一份引用）
  assert.equal(list.length, 2);
  assert.equal(trash.length, 0);
});

test('trashRemove: 找不到 id ⇒ removed=null 且两个数组原样退回', () => {
  const list = [PL_B];
  const r = trashRemove(list, [], 'nope', 1);
  assert.equal(r.removed, null);
  assert.equal(r.playlists, list);
});

test('trashRemove: 超上限只留最近 MAX_TRASH 条', () => {
  const big = Array.from({ length: MAX_TRASH }, (_, i) => ({ playlist: { id: 'x' + i }, deletedAt: i }));
  const r = trashRemove([PL_A], big, 'pl_a', 999);
  assert.equal(r.trash.length, MAX_TRASH);
  assert.equal(r.trash[0].playlist.id, 'pl_a');
  assert.equal(r.trash[MAX_TRASH - 1].playlist.id, 'x' + (MAX_TRASH - 2)); // 最老那条被挤掉
});

test('trashRestore: 放回队首、id 不变、条目离开回收站', () => {
  const tr = [{ playlist: PL_A, deletedAt: 5 }];
  const r = trashRestore([PL_B], tr, { ...PL_A, name: 'A 改名了' });
  assert.equal(r.restored, r.playlists[0]);
  assert.equal(r.playlists[0].id, 'pl_a');
  assert.equal(r.playlists[0].name, 'A 改名了'); // 以调用方递来的内容为准
  assert.equal(r.trash.length, 0);
  assert.equal(r.inPlaylist, false);
});

test('trashRestore: id 已在列表（云同步先带回来了）⇒ 只清条目，不重复插入', () => {
  const tr = [{ playlist: PL_A, deletedAt: 5 }];
  const list = [PL_A, PL_B];
  const r = trashRestore(list, tr, PL_A);
  assert.equal(r.restored, null);
  assert.equal(r.inPlaylist, true);
  assert.equal(r.playlists.length, 2);
  assert.equal(r.trash.length, 0);
});

test('trashRestore: 回收站里也没有 ⇒ 两个 false，调用方走原新建逻辑', () => {
  const r = trashRestore([PL_B], [], PL_A);
  assert.equal(r.restored, null);
  assert.equal(r.inPlaylist, false);
  assert.equal(r.playlists.length, 1);
});

test('trashRestore: 无 id 入参直接退回（撤销分支不该收到这种货）', () => {
  const list = [PL_B];
  const r = trashRestore(list, [{ playlist: { id: 'pl_b' }, deletedAt: 1 }], { name: '无名' });
  assert.equal(r.restored, null);
  assert.equal(r.playlists, list);
});

test('purgeExpired: 30 天整判过期（>=TTL 即清），脏条目按最老处理一并清', () => {
  const now = 1_000_000 * DAY;
  const fresh = { playlist: PL_A, deletedAt: now - TRASH_TTL_MS + 1 };
  const exact = { playlist: PL_B, deletedAt: now - TRASH_TTL_MS };
  const garbage = [{ playlist: PL_A }, { deletedAt: now }]; // 缺 deletedAt / 缺 playlist
  const r = purgeExpired([fresh, exact, ...garbage], now);
  assert.deepEqual(r.trash, [fresh]);
  assert.equal(r.purged.length, 3);
});

test('purgeExpired: 非数组入参退回空站（prefs 键被写坏也不炸启动）', () => {
  const r = purgeExpired(undefined, 1);
  assert.deepEqual(r.trash, []);
  assert.deepEqual(r.purged, []);
});

// ── 2. 真 prefs 端到端（electron 打桩，同 favorites.test.js） ──

const handlers = new Map();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-trash-'));

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: () => userDataDir },
      shell: { trashItem: async () => {}, showItemInFolder() {} },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true }),
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const prefs = require('../src/utils/prefs');
const ipcPlaylist = require('../src/main/ipc/playlist');
ipcPlaylist.register();

const { ENVELOPE_KEY } = require('../src/shared/ipcContract');
const invoke = (channel) => {
  const fn = handlers.get(channel);
  assert.ok(fn, `IPC handler 未注册: ${channel}`);
  return async (...args) => {
    const env = await fn(...args);
    if (env && typeof env === 'object' && env[ENVELOPE_KEY] === 1) {
      if (!env.ok) throw new Error(env.error);
      return env.data;
    }
    return env;
  };
};

function fresh() {
  prefs.init(fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-trash-')));
}

const getIds = async () => (await invoke('get-user-playlists')()).map(p => p.id);

test('端到端：删除→进回收站→撤销原 id 找回，全程零新通道', async () => {
  fresh();
  const created = await invoke('save-user-playlist')(null, { name: '下班听的', songs: [{ id: 7, source: 'netease', title: 'x' }] });
  assert.ok(created.success && created.playlist.id);
  const pl = created.playlist;

  const del = await invoke('delete-user-playlist')(null, pl.id);
  assert.equal(del.success, true);
  assert.ok(!(await getIds()).includes(pl.id), '列表里不该再看得见');
  const tr = prefs.get('playlistTrash');
  assert.equal(tr.length, 1);
  assert.equal(tr[0].playlist.id, pl.id);
  assert.ok(typeof tr[0].deletedAt === 'number');

  // 撤销 = 渲染层攥着副本走既有 save-user-playlist（模拟浏览器端传法）
  const back = await invoke('save-user-playlist')(null, pl);
  assert.equal(back.success, true);
  assert.equal(back.restored, true);
  assert.equal(back.playlist.id, pl.id, 'id 必须原样，收藏/封面等按 id 记的东西才不断链');
  assert.ok((await getIds()).includes(pl.id));
  assert.equal(prefs.get('playlistTrash').length, 0);
});

test('端到端：列表里已有同 id（云端先带回来）⇒ 保存走更新分支并顺手清掉回收站陈旧条目，不出现两份', async () => {
  fresh();
  const created = await invoke('save-user-playlist')(null, { name: '撞上云', songs: [] });
  const pl = created.playlist;
  await invoke('delete-user-playlist')(null, pl.id);
  // 模拟云同步把原歌单灌回 userPlaylists（回收站条目仍挂着）
  const list = prefs.get('userPlaylists');
  list.unshift(pl);
  prefs.set('userPlaylists', list);

  const r = await invoke('save-user-playlist')(null, pl);
  assert.equal(r.success, true);
  assert.equal((await getIds()).filter(id => id === pl.id).length, 1);
  assert.equal(prefs.get('playlistTrash').length, 0, '复活后的陈旧回收站条目必须被清掉');
});

test('端到端：收藏系统单依然删不动，且不会误进回收站', async () => {
  fresh();
  await invoke('get-user-playlists')();
  const r = await invoke('delete-user-playlist')(null, 'favorites');
  assert.equal(r.success, false);
  assert.match(r.error, /不能删除/);
  assert.ok((await getIds()).includes('favorites'));
  assert.ok(!prefs.get('playlistTrash'));
});

test('端到端：带陌生 id 的保存（导入场景）保持旧行为 —— 另发新 id 新建，不去回收站碰瓷', async () => {
  fresh();
  const r = await invoke('save-user-playlist')(null, { id: 'pl_from_elsewhere', name: '导入的', songs: [] });
  assert.equal(r.success, true);
  assert.notEqual(r.playlist.id, 'pl_from_elsewhere');
  assert.equal(r.restored, undefined);
});

test('端到端：register() 启动清过期 —— 31 天前的条目没了，新鲜的留着', async () => {
  fresh();
  const now = Date.now();
  prefs.set('playlistTrash', [
    { playlist: PL_A, deletedAt: now - 31 * DAY },
    { playlist: PL_B, deletedAt: now - DAY },
  ]);
  ipcPlaylist.register();
  const tr = prefs.get('playlistTrash');
  assert.equal(tr.length, 1);
  assert.equal(tr[0].playlist.id, 'pl_b');
});

// ── 3. 接线钉：链路不许断 ─────────────────────────────

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('主进程三个挂点：启动清过期 / 删除走 trashRemove / 保存分支走 trashRestore', () => {
  const src = read('src/main/ipc/playlist.js');
  assert.match(src, /require\('\.\.\/\.\.\/utils\/playlistTrash'\)/, '纯函数模块没接上');
  assert.match(src, /const \{ trashRemove, trashRestore, purgeExpired \}/);
  assert.match(src, /purgeExpired\(trashNow, Date\.now\(\)\)/, 'register() 里没做启动清过期');
  assert.match(src, /trashRemove\(playlists, _trash\(\), playlistId/, '删除 handler 又写回硬删 filter 了');
  assert.match(src, /trashRestore\(playlists, _trash\(\), playlist\)/, '保存 handler 没接撤销分支');
  assert.ok(!/playlists\.filter\(p => p\.id !== playlistId\)/.test(src), '硬删 filter 复活');
});

test('渲染层：确认框点名歌单与歌数，删除后走带「撤销」按钮的 toast，撤销复用 save-user-playlist', () => {
  const src = read('src/renderer/js/views/playlist.js');
  const fn = src.match(/async function deletePlaylist[\s\S]*?\n}\n/);
  assert.ok(fn, 'deletePlaylist 找不到了（改名/挪走时同步本测试）');
  assert.match(fn[0], /确认删除歌单「\$\{pl\.name\}」/, '确认框没点名歌单');
  assert.match(fn[0], /\$\{n\} 首歌/, '确认框没亮出影响范围（歌数）');
  assert.match(fn[0], /showActionToast\(\{/, '没走带按钮的 toast');
  assert.match(fn[0], /btnLabel: '撤销'/);
  assert.match(fn[0], /ttl: 5000/, '撤销窗口必须是 5 秒（审计 F2）');
  const undo = src.match(/async function undoDeletePlaylist[\s\S]*?\n}\n/);
  assert.ok(undo, 'undoDeletePlaylist 没了');
  assert.match(undo[0], /api\.saveUserPlaylist\(pl\)/, '撤销必须走既有保存通道，不许另开通道');
});

test('契约反向钉：三个频道 args 形状逐字未动，且没冒出回收站/撤销新通道', () => {
  const contract = read('src/shared/ipcContract.js');
  assert.match(contract, /'delete-user-playlist':\s*\{ invoke: MAIN, args: \[\['playlistId', t\.str\(64\)\]\] \}/);
  assert.match(contract, /'save-user-playlist':\s*\{ invoke: MAIN, args: \[\['playlist', t\.obj\(\)\]\] \}/);
  assert.match(contract, /'get-user-playlists':\s*\{ invoke: MAIN \}/);
  assert.ok(!/trash|recycle|undo/i.test(contract.replace(/\/\/.*$/gm, '')), '契约里出现了回收站/撤销类新通道 —— 撤销应走 save-user-playlist');
});

test('回收站是主进程内部键：不进 set-pref 白名单，也不进云同步的键清单', () => {
  const mainPrefs = read('src/main/ipc/prefs.js');
  assert.ok(!/'playlistTrash'/.test(mainPrefs), 'playlistTrash 不该出现在 set-pref 白名单（渲染层不该直接写它）');
  const sync = read('src/main/ipc/cloudSync.js');
  assert.ok(!/playlistTrash/.test(sync), '回收站不该被云同步 —— 撤销是本机 5 秒内的事');
});
