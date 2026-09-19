/**
 * 收藏（红心）集成测试：main/ipc/playlist.js 的用户歌单 + 收藏 IPC
 *
 * 收藏不是独立存储，而是 userPlaylists 里 id 为 favorites 的系统歌单，
 * 所以本测试同时覆盖：系统歌单自举、按 source+id 增删切换、跨平台同 id
 * 不撞车、系统歌单不可删、以及 remove-from-user-playlist 的 source+id 修复。
 *
 * electron 用桩替代（同 libraryIpc.integration.test.js 的做法）：
 * 整个用例期间保持桩生效，因为 handler 内部会惰性 require('electron')。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const handlers = new Map();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-fav-'));

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: (name) => (name === 'userData' ? userDataDir : userDataDir) },
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

const { FAVORITES_ID, songKey } = ipcPlaylist;

// register.js 的传输层信封（见 test/ipc-envelope.test.js）：
// 本测试直调 ipcMain 包装器，模拟 preload 的解包还原
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

/** 每个用例前换一份干净的 userData，避免收藏状态在用例间泄漏 */
function fresh() {
  prefs.init(fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-fav-')));
}

const SONG_NETEASE = { id: 1001, source: 'netease', title: '夜曲', artist: '周杰伦' };
const SONG_QQ = { id: 1001, source: 'qq', title: '夜曲(QQ)', artist: '周杰伦' };
const SONG_KUGOU = { id: 9, source: 'kugou', title: '晴天', artist: '周杰伦' };

test('songKey: 同 id 不同平台产生不同键', () => {
  assert.notEqual(songKey(SONG_NETEASE), songKey(SONG_QQ));
  assert.equal(songKey(SONG_NETEASE), '1001:netease');
  assert.equal(songKey(SONG_QQ), '1001:qq');
});

test('get-user-playlists 自举收藏歌单，且重复调用不重复创建', async () => {
  fresh();
  const first = await invoke('get-user-playlists')();
  assert.equal(first.length, 1);
  assert.equal(first[0].id, FAVORITES_ID);
  assert.equal(first[0].system, true);
  assert.ok(Array.isArray(first[0].songs));

  const second = await invoke('get-user-playlists')();
  assert.equal(second.length, 1);
});

test('toggle-favorite: 首次添加，再次调用取消', async () => {
  fresh();
  await invoke('get-user-playlists')();

  const on = await invoke('toggle-favorite')(null, 'netease', '1001', SONG_NETEASE);
  assert.equal(on.success, true);
  assert.equal(on.favorited, true);
  assert.equal(on.playlist.songs.length, 1);
  assert.equal(on.playlist.songs[0].title, '夜曲');

  const off = await invoke('toggle-favorite')(null, 'netease', '1001', SONG_NETEASE);
  assert.equal(off.success, true);
  assert.equal(off.favorited, false);
  assert.equal(off.playlist.songs.length, 0);
});

test('toggle-favorite: 参数不完整被拒绝', async () => {
  fresh();
  assert.equal((await invoke('toggle-favorite')(null, '', '', SONG_NETEASE)).success, false);
  assert.equal((await invoke('toggle-favorite')(null, 'netease', '1', null)).success, false);
  assert.equal((await invoke('toggle-favorite')(null, 'netease', '1', 'not-an-object')).success, false);
});

test('toggle-favorite: 跨平台同 id 是两条独立收藏，取消一条不动另一条', async () => {
  fresh();
  await invoke('get-user-playlists')();

  await invoke('toggle-favorite')(null, 'netease', '1001', SONG_NETEASE);
  await invoke('toggle-favorite')(null, 'qq', '1001', SONG_QQ);

  const pls = await invoke('get-user-playlists')();
  const fav = pls.find(p => p.id === FAVORITES_ID);
  assert.equal(fav.songs.length, 2);

  const off = await invoke('toggle-favorite')(null, 'netease', '1001', SONG_NETEASE);
  assert.equal(off.favorited, false);
  assert.equal(off.playlist.songs.length, 1);
  assert.equal(off.playlist.songs[0].source, 'qq');
});

test('toggle-favorite: 同一首歌反复切换不会累积重复条目', async () => {
  fresh();
  await invoke('get-user-playlists')();
  for (let i = 0; i < 5; i++) {
    await invoke('toggle-favorite')(null, 'kugou', '9', SONG_KUGOU);
  }
  // 奇数次 → 已收藏，且只有一条
  const pls = await invoke('get-user-playlists')();
  const fav = pls.find(p => p.id === FAVORITES_ID);
  assert.equal(fav.songs.length, 1);
});

test('delete-user-playlist: 拒绝删除收藏歌单，普通歌单可删', async () => {
  fresh();
  await invoke('get-user-playlists')();
  const created = await invoke('save-user-playlist')(null, { name: '跑步歌单' });
  assert.equal(created.success, true);

  const denied = await invoke('delete-user-playlist')(null, FAVORITES_ID);
  assert.equal(denied.success, false);

  const ok = await invoke('delete-user-playlist')(null, created.playlist.id);
  assert.equal(ok.success, true);

  const pls = await invoke('get-user-playlists')();
  assert.equal(pls.length, 1);
  assert.equal(pls[0].id, FAVORITES_ID);
});

test('remove-from-user-playlist: 带 source 只删对应平台那条', async () => {
  fresh();
  await invoke('get-user-playlists')();
  const fav = (await invoke('get-user-playlists')()).find(p => p.id === FAVORITES_ID);
  await invoke('save-user-playlist')(null, {
    name: '混合', songs: [SONG_NETEASE, SONG_QQ],
  });
  const pl = (await invoke('get-user-playlists')()).find(p => p.name === '混合');

  const r = await invoke('remove-from-user-playlist')(null, pl.id, '1001', 'netease');
  assert.equal(r.success, true);
  assert.equal(r.playlist.songs.length, 1);
  assert.equal(r.playlist.songs[0].source, 'qq');
  assert.equal(fav.songs.length, 0);
});

test('remove-from-user-playlist: 不带 source 时退回按 id 匹配（兼容旧调用方）', async () => {
  fresh();
  await invoke('get-user-playlists')();
  const pl = (await invoke('save-user-playlist')(null, {
    name: '混合2', songs: [SONG_NETEASE, SONG_QQ],
  })).playlist;

  const r = await invoke('remove-from-user-playlist')(null, pl.id, '1001');
  assert.equal(r.success, true);
  assert.equal(r.playlist.songs.length, 0);
});

test('save-user-playlist: 更新已有歌单不丢失 system 标记', async () => {
  fresh();
  await invoke('get-user-playlists')();
  const fav = (await invoke('get-user-playlists')()).find(p => p.id === FAVORITES_ID);

  const r = await invoke('save-user-playlist')(null, {
    id: fav.id, name: '我喜欢的', desc: '改名后的收藏', songs: fav.songs,
  });
  assert.equal(r.success, true);
  assert.equal(r.playlist.name, '我喜欢的');
  assert.equal(r.playlist.system, true);
  assert.equal(r.playlist.id, FAVORITES_ID);
});
