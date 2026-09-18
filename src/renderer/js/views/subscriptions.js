/**
 * 订阅更新视图
 *
 * 「我的歌单」右侧新 tab：展示已订阅的歌单/歌手、各自未读新歌，
 * 支持立即检查、自动下载开关、批量入队。
 *
 * 数据来源：api.subscribeList（主进程 subscriptions 引擎），
 * 主进程检查完成后经 'subscriptions-updated' 事件推送最新列表。
 *
 * 与 playlist.js 同风格：挂在 window 上供 HTML onclick / app.js 调用。
 */

let _subsLoaded = false;
let _subList = [];

async function loadSubscriptions() {
  try {
    _subList = await api.subscribeList() || [];
    _subsLoaded = true;
    renderSubscriptionPage(_subList);
    updateSubBadge(_subList);
  } catch (e) {
    logger.warn('[subscriptions] 加载失败:', e.message);
  }
}

function initSubscriptionView() {
  loadSubscriptions();
}

// ── 渲染 ───────────────────────────────────────────────

function _subTypeLabel(e) {
  return e.type === 'playlist' ? '歌单' : '歌手';
}

function _fmtTime(ts) {
  if (!ts) return '从未检查';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderSubscriptionPage(entries) {
  const wrap = document.getElementById('subList');
  if (!wrap) return;
  if (!entries.length) {
    wrap.innerHTML = `
      <div style="text-align:center;padding:48px 16px;color:var(--neon-dim);">
        <div style="font-size:36px;margin-bottom:12px;">📡</div>
        <div style="font-size:14px;margin-bottom:6px;">还没有订阅</div>
        <div style="font-size:12px;">打开任意歌单详情或歌手主页，点「订阅」即可在新歌发布时收到提醒</div>
      </div>`;
    return;
  }
  wrap.innerHTML = entries.map(e => {
    const unread = e.newCount || 0;
    return `
    <div class="sub-card ${unread ? 'sub-card-unread' : ''}">
      <div class="sub-card-head">
        <div class="sub-card-title">
          <span class="sub-kind">${_subTypeLabel(e)}</span>
          <span class="sub-name" title="${escAttr(e.name || e.targetId)}">${esc(e.name || e.targetId)}</span>
        </div>
        <div class="sub-card-actions">
          <button class="btn-sm" onclick="subscriptionRemove('${escAttr(e.key)}')">退订</button>
        </div>
      </div>
      <div class="sub-card-meta">
        <span>${esc(e.platform)}</span>
        <span>上次检查: ${_fmtTime(e.lastCheckedAt)}</span>
        ${e.lastCheckError ? `<span class="sub-error">⚠ ${esc(e.lastCheckError)}</span>` : ''}
        ${!e.hasSeeded ? '<span class="sub-seeded">待首次检查</span>' : ''}
      </div>
      <label class="sub-auto">
        <input type="checkbox" ${e.autoDownload ? 'checked' : ''} onchange="subscriptionToggleAuto('${escAttr(e.key)}', this.checked)">
        新歌自动下载
      </label>
      ${unread > 0 ? `
      <div class="sub-new">
        <div class="sub-new-head">
          <span>🆕 ${unread} 首新歌</span>
          <div class="sub-new-actions">
            <button class="btn-sm" onclick="subscriptionQueueNew('${escAttr(e.key)}')">全部入队</button>
            <button class="btn-sm" onclick="subscriptionMarkSeen('${escAttr(e.key)}')">已看完</button>
          </div>
        </div>
        <div class="sub-new-list">${(e.newSongs || []).slice(0, 10).map(s =>
          `<div class="sub-new-row"><span>${esc(s.title)}</span><span class="sub-new-artist">${esc(s.artist)}</span></div>`
        ).join('')}${unread > 10 ? '<div class="sub-new-more">…另有 ' + (unread - 10) + ' 首</div>' : ''}</div>
      </div>` : ''}
    </div>`;
  }).join('');
}

function updateSubBadge(entries) {
  const badge = document.getElementById('subBadge');
  if (!badge) return;
  const n = (entries || []).reduce((sum, e) => sum + (e.newCount || 0), 0);
  badge.textContent = n > 99 ? '99+' : (n || '');
  badge.style.display = n > 0 ? '' : 'none';
}

// ── 操作 ───────────────────────────────────────────────

/** 供歌单弹层 / 歌手主页的「订阅」按钮调用 */
async function subscriptionAdd(type, platform, targetId, name) {
  try {
    const r = await api.subscribeAdd(type, platform, String(targetId), name || '');
    if (r && r.success) {
      showToast(r.duplicated ? '已订阅过了' : `已订阅: ${name || targetId}`, 'success');
      if (_subsLoaded) loadSubscriptions();
      return true;
    }
    showToast((r && r.error) || '订阅失败', 'error');
  } catch (e) {
    showToast('订阅失败: ' + (e.message || e), 'error');
  }
  return false;
}

async function subscriptionRemove(key) {
  const r = await api.subscribeRemove(key);
  if (r && r.success) {
    showToast('已退订', 'info');
    loadSubscriptions();
  } else {
    showToast((r && r.error) || '退订失败', 'error');
  }
}

async function subscriptionToggleAuto(key, on) {
  await api.subscribeUpdate(key, { autoDownload: !!on });
  if (on) showToast('已开启自动下载：新歌将直接排入下载队列', 'info');
  loadSubscriptions();
}

async function subscriptionCheckNow() {
  const btn = document.getElementById('subCheckBtn');
  if (btn) { btn.disabled = true; btn.textContent = '检查中...'; }
  try {
    const r = await api.subscribeCheck();
    await loadSubscriptions();
    showToast(r && r.newTotal ? `检查完成，发现 ${r.newTotal} 首新歌` : '检查完成，暂无新歌', 'success');
  } catch (e) {
    showToast('检查失败: ' + (e.message || e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '立即检查'; }
  }
}

async function subscriptionMarkSeen(key) {
  await api.subscribeMarkSeen(key);
  loadSubscriptions();
}

async function subscriptionQueueNew(key) {
  const entry = _subList.find(e => e.key === key);
  const songs = entry && entry.newSongs;
  if (!songs || !songs.length) return;
  const saveDir = getState('saveDir');
  const payload = {
    songs: songs.map(s => ({ ...s, saveDir, quality: resolveQuality(s.source) })),
  };
  try {
    const r = await api.addPlaylistToQueue(payload);
    showToast(`已加入 ${r.queued} 首${r.skippedDownloaded ? `，跳过 ${r.skippedDownloaded} 首已下载` : ''}`, 'success');
  } catch (e) {
    showToast('批量加入失败: ' + (e.message || e), 'error');
  }
}

// ── 订阅按钮状态（歌单弹层 / 歌手主页）────────────────

function _isSubscribed(type, platform, targetId) {
  const key = `${type}:${platform}:${targetId}`;
  return _subList.some(e => e.key === key);
}

/** 弹层工具栏按钮：订阅当前打开的歌单（meta 由 openPlaylistModal 写入） */
async function subscribeCurrentPlaylist() {
  const meta = state.getPlaylistMeta && state.getPlaylistMeta();
  if (!meta || !meta.id) { showToast('歌单信息缺失', 'error'); return; }
  if (_subsLoaded && _isSubscribed('playlist', meta.platform, meta.id)) {
    showToast('已订阅该歌单', 'info');
    return;
  }
  const ok = await subscriptionAdd('playlist', meta.platform, meta.id, meta.name);
  if (ok) {
    const btn = document.getElementById('plSubscribeBtn');
    if (btn) btn.classList.add('sub-on');
  }
}

/** 歌手主页头部按钮：订阅当前歌手 */
async function subscribeCurrentSinger() {
  const singer = state.get('currentSinger');
  if (!singer || !singer.mid) { showToast('歌手信息缺失', 'error'); return; }
  const name = document.querySelector('.singer-detail-name');
  if (_subsLoaded && _isSubscribed('singer', singer.source, singer.mid)) {
    showToast('已订阅该歌手', 'info');
    return;
  }
  await subscriptionAdd('singer', singer.source, singer.mid, name ? name.textContent.trim() : '');
}

// ── 事件接线（主进程检查完成 → 静默刷新）────────────────
// 必须等 app.js init() 里 buildApi 之后再调：模块 import 期 window.api 还不存在

let _eventsWired = false;
function wireSubscriptionEvents() {
  if (_eventsWired) return;
  const a = window.api;
  if (!a || typeof a.onSubscriptionsUpdated !== 'function') return;
  _eventsWired = true;
  a.onSubscriptionsUpdated(() => {
    // 任意窗口打开时都刷徽章；页面打开时顺带重渲染
    loadSubscriptions();
  });
}

// ── window 桥接 ────────────────────────────────────────
window.initSubscriptionView = initSubscriptionView;
window.loadSubscriptions = loadSubscriptions;
window.renderSubscriptionPage = renderSubscriptionPage;
window.updateSubBadge = updateSubBadge;
window.subscriptionAdd = subscriptionAdd;
window.subscriptionRemove = subscriptionRemove;
window.subscriptionToggleAuto = subscriptionToggleAuto;
window.subscriptionCheckNow = subscriptionCheckNow;
window.subscriptionMarkSeen = subscriptionMarkSeen;
window.subscriptionQueueNew = subscriptionQueueNew;
window.subscribeCurrentPlaylist = subscribeCurrentPlaylist;
window.subscribeCurrentSinger = subscribeCurrentSinger;
window.wireSubscriptionEvents = wireSubscriptionEvents;
