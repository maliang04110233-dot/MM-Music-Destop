/**
 * MusicDL 全局键盘快捷键
 * 
 * ES Module — export 供其他模块 import，同时保留 window 全局供 HTML onclick
 */

(function setupGlobalShortcuts() {
  document.addEventListener('keydown', handleKey);
})();

function handleKey(e) {
  // 输入框中不拦截（除了 Esc）
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
    || document.activeElement?.isContentEditable;
  const ctrlOrCmd = e.ctrlKey || e.metaKey;

  // ── Esc 关闭弹窗 ──
  if (e.key === 'Escape') {
    if (closeActiveModal()) {
      e.preventDefault();
      return;
    }
  }

  // ── ? 显示快捷键帮助（仅不在输入框时） ──
  if (e.key === '?' && !inInput) {
    showShortcutsHelp();
    e.preventDefault();
    return;
  }

  // 输入框中不处理其他快捷键
  if (inInput) return;

  // ── Ctrl/Cmd 组合快捷键 ──
  if (ctrlOrCmd) {
    const key = e.key.toLowerCase();

    // Ctrl+F 聚焦搜索
    if (key === 'f') {
      e.preventDefault();
      focusTab('search', 'searchInput');
      return;
    }
    // Ctrl+D 跳到下载
    if (key === 'd') {
      e.preventDefault();
      focusTab('download');
      return;
    }
    // Ctrl+L 跳到本地歌曲
    if (key === 'l') {
      e.preventDefault();
      focusTab('local');
      return;
    }
    // Ctrl+H 跳到历史
    if (key === 'h') {
      e.preventDefault();
      focusTab('history');
      return;
    }
    // Ctrl+G 跳到首页
    if (key === 'g') {
      e.preventDefault();
      focusTab('home');
      return;
    }

    // 切歌
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (typeof nextSong === 'function') nextSong();
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (typeof prevSong === 'function') prevSong();
      return;
    }

    // 音量
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      audio.volume = Math.min(1, audio.volume + 0.05);
      showVolumeToast();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      audio.volume = Math.max(0, audio.volume - 0.05);
      showVolumeToast();
      return;
    }
  }

  // ── Space 播放/暂停（不在输入框） ──
  if (e.key === ' ' && !inInput) {
    e.preventDefault();
    if (typeof togglePlay === 'function') togglePlay();
    return;
  }
}

function focusTab(tabName, focusElId) {
  // 'history' 已并入 download 页（历史子 tab）：落到 download 导航项
  const navName = tabName === 'history' ? 'download' : tabName;
  const btn = document.querySelector(`.nav-item[data-tab="${navName}"]`);
  if (btn && typeof switchTab === 'function') switchTab(tabName, btn);
  if (focusElId) {
    setTimeout(() => {
      const el = document.getElementById(focusElId);
      if (el) {
        el.focus();
        if (el.select) el.select();
      }
    }, 50);
  }
}

function closeActiveModal() {
  // 按优先级关闭：歌单弹窗 > ID3 编辑 > 设置
  const playlistModal = document.getElementById('playlistModal');
  if (playlistModal && !playlistModal.classList.contains('hidden')) {
    if (typeof closePlaylistModal === 'function') closePlaylistModal();
    return true;
  }
  const editOverlay = document.getElementById('editOverlay');
  if (editOverlay && !editOverlay.classList.contains('hidden')) {
    if (typeof closeEdit === 'function') closeEdit();
    return true;
  }
  const settingsOverlay = document.getElementById('settingsOverlay');
  if (settingsOverlay && !settingsOverlay.classList.contains('hidden')) {
    if (typeof closeSettings === 'function') closeSettings();
    return true;
  }
  return false;
}

// ── 音量提示 ──
let _volumeToastEl = null;
let _volumeToastTimer = null;
function showVolumeToast() {
  const pct = Math.round(audio.volume * 100);
  // 复用 toast 容器，简单一行
  const container = document.getElementById('toastContainer');
  if (!container) return;
  if (_volumeToastEl) {
    _volumeToastEl.textContent = `🔊 ${pct}%`;
  } else {
    _volumeToastEl = document.createElement('div');
    _volumeToastEl.className = 'toast toast-info';
    _volumeToastEl.textContent = `🔊 ${pct}%`;
    container.appendChild(_volumeToastEl);
  }
  clearTimeout(_volumeToastTimer);
  _volumeToastTimer = setTimeout(() => {
    if (_volumeToastEl) {
      _volumeToastEl.remove();
      _volumeToastEl = null;
    }
  }, 1200);
}

// ── 快捷键帮助弹窗 ──
export function showShortcutsHelp() {
  // 已有则不重复
  let overlay = document.getElementById('shortcutsHelp');
  if (overlay) {
    overlay.remove();
  }

  overlay = document.createElement('div');
  overlay.id = 'shortcutsHelp';
  overlay.className = 'shortcuts-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="shortcuts-panel">
      <div class="shortcuts-header">
        <span>⌨️ 快捷键</span>
        <button onclick="document.getElementById('shortcutsHelp').remove()">✕</button>
      </div>
      <div class="shortcuts-body">
        <div class="shortcut-group">
          <div class="shortcut-group-title">导航</div>
          <div class="shortcut-row"><span>聚焦搜索</span><kbd>Ctrl</kbd>+<kbd>F</kbd></div>
          <div class="shortcut-row"><span>跳到首页</span><kbd>Ctrl</kbd>+<kbd>G</kbd></div>
          <div class="shortcut-row"><span>跳到下载队列</span><kbd>Ctrl</kbd>+<kbd>D</kbd></div>
          <div class="shortcut-row"><span>跳到本地歌曲</span><kbd>Ctrl</kbd>+<kbd>L</kbd></div>
          <div class="shortcut-row"><span>跳到下载历史</span><kbd>Ctrl</kbd>+<kbd>H</kbd></div>
        </div>
        <div class="shortcut-group">
          <div class="shortcut-group-title">播放控制</div>
          <div class="shortcut-row"><span>播放/暂停</span><kbd>Space</kbd></div>
          <div class="shortcut-row"><span>下一首</span><kbd>Ctrl</kbd>+<kbd>→</kbd></div>
          <div class="shortcut-row"><span>上一首</span><kbd>Ctrl</kbd>+<kbd>←</kbd></div>
          <div class="shortcut-row"><span>音量+</span><kbd>Ctrl</kbd>+<kbd>↑</kbd></div>
          <div class="shortcut-row"><span>音量-</span><kbd>Ctrl</kbd>+<kbd>↓</kbd></div>
        </div>
        <div class="shortcut-group">
          <div class="shortcut-group-title">其他</div>
          <div class="shortcut-row"><span>关闭弹窗</span><kbd>Esc</kbd></div>
          <div class="shortcut-row"><span>显示/隐藏这个帮助</span><kbd>?</kbd></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

// ── 全局桥接 ──────────────────────────────────────────
window.showShortcutsHelp = showShortcutsHelp;
