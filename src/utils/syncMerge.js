/**
 * WebDAV 快照合并核心（纯函数，无 IO）
 *
 * 场景：多台设备共享一个 WebDAV 快照文件。同步 = 拉取远端 → 与本地合并 →
 * 合并结果既回写远端也回写本地。盲覆盖（现有 import-all-data 的行为）会让
 * 旧备份吞掉新数据，这里给每类数据定合并规则：
 *
 *   - 歌单     按 id 并集；同 id 以 updatedAt 较新者为基底，另一方独有的
 *              歌曲按 songKey(id:source) 并入。无墓碑机制 ⇒ 删歌/删歌单不跨
 *              设备传播，只会"复活"，与 lx-music-desktop 的 sync 行为一致，
 *              是快照合并方案共同的已知取舍（换取零冲突状态）。
 *   - 下载模板 按 id 并集；同 id updatedAt 新者胜（整条覆盖，无子结构）。
 *   - 历史记录 按 id+source 去重，finishedAt 新者胜；输出 finishedAt 倒序。
 *
 * songKey 与 main/ipc/playlist.js 保持同一规则：只按 id 会跨平台撞车。
 */

function songKey(s) {
  return String(s && s.id) + ':' + String((s && s.source) || '');
}

function _arr(x) {
  return Array.isArray(x) ? x : [];
}

function _ts(x, field = 'updatedAt') {
  const n = x && Number(x[field]);
  return Number.isFinite(n) ? n : 0;
}

function mergePlaylists(local, remote) {
  const out = _arr(local).filter(p => p && p.id != null).map(p => ({ ...p }));
  const byId = new Map(out.map(p => [String(p.id), p]));

  for (const r of _arr(remote)) {
    if (!r || r.id == null) continue;
    const key = String(r.id);
    const l = byId.get(key);
    if (!l) {
      const clone = { ...r };
      out.push(clone);
      byId.set(key, clone);
      continue;
    }
    // 较新者为基底（同值取本地），旧方独有歌曲并入
    const newer = _ts(r) > _ts(l) ? r : l;
    const older = newer === r ? l : r;
    const seen = new Set(_arr(newer.songs).map(songKey));
    const merged = _arr(newer.songs).concat(
      _arr(older.songs).filter(s => s && !seen.has(songKey(s))),
    );
    const base = { ...newer, songs: merged };
    out[out.indexOf(l)] = base;
    byId.set(key, base);
  }
  return out;
}

function mergeTemplates(local, remote) {
  const out = _arr(local).filter(t => t && t.id != null);
  const byId = new Map(out.map(t => [String(t.id), t]));
  for (const r of _arr(remote)) {
    if (!r || r.id == null) continue;
    const key = String(r.id);
    const l = byId.get(key);
    if (!l) {
      out.push(r);
      byId.set(key, r);
    } else if (_ts(r) > _ts(l)) {
      out[out.indexOf(l)] = r;
      byId.set(key, r);
    }
  }
  return out;
}

function mergeHistory(local, remote) {
  const byKey = new Map();
  for (const e of _arr(local).concat(_arr(remote))) {
    if (!e || e.id == null || !e.source) continue;
    const key = `${String(e.id)}:${e.source}`;
    const prev = byKey.get(key);
    if (!prev || _ts(e, 'finishedAt') > _ts(prev, 'finishedAt')) byKey.set(key, e);
  }
  return [...byKey.values()].sort((a, b) => _ts(b, 'finishedAt') - _ts(a, 'finishedAt'));
}

/**
 * 合并两份快照的 data 段（与 export-all-data 的 data 键对齐）
 */
function mergeSnapshotData(localData, remoteData) {
  const l = localData && typeof localData === 'object' ? localData : {};
  const r = remoteData && typeof remoteData === 'object' ? remoteData : {};
  return {
    userPlaylists: mergePlaylists(l.userPlaylists, r.userPlaylists),
    downloadTemplates: mergeTemplates(l.downloadTemplates, r.downloadTemplates),
    downloadHistory: mergeHistory(l.downloadHistory, r.downloadHistory),
  };
}

module.exports = { mergePlaylists, mergeTemplates, mergeHistory, mergeSnapshotData };
