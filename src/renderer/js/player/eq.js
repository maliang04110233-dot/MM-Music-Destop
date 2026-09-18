/**
 * MusicDL 播放器 — 均衡器（5 段 EQ / 预设曲线 / 偏好持久化）
 *
 * 自 player.js 拆出：只负责 EQ 滑块与预设的 UI 状态，不参与音频播放控制。
 * 依赖全局：api（由 app.js 经 window.api getter 注入）
 *
 * ⚠️ 已知状态（本次拆分为等价迁移，未改变任何行为）：
 *   1. eqFilters 在仓库内不存在任何填充点（无 createBiquadFilter /
 *      createMediaElementSource），故恒为空数组；所有 `if (eqFilters[i])`
 *      分支永不进入 → 对声音零影响。UI 已如实标注。
 *   2. saveEqSettings 会写 prefs.eqGains，但 restoreEqPresetSetting 只读
 *      eqPreset / eqBypass，从不回读 eqGains → 手调单段的增益重启后丢失
 *      （滑块会回到最后一次预设曲线，而非用户手调值）。
 *   两条均由 test/eq-behaviour.test.js 以"现状钉住"方式守卫：修好任一
 *   行为会使其转红，从而强制显式决策，而非静默漂移。
 */

// ── EQ 5 段均衡器 ────────────────────────────────────
const EQ_BANDS = [
   { freq: 60,   label: '60Hz',   type: 'lowshelf' },
   { freq: 230,  label: '230Hz',  type: 'peaking' },
   { freq: 910,  label: '910Hz',  type: 'peaking' },
   { freq: 3600, label: '3.6kHz', type: 'peaking' },
   { freq: 14000,label: '14kHz',  type: 'highshelf' },
];
const eqFilters = []; // BiquadFilterNode[]
let eqBypassed = false; // EQ bypass state

// ── EQ 预设曲线 ───────────────────────────────────────
// 每条预设是 EQ_BANDS 对应索引的增益值 [60Hz, 230Hz, 910Hz, 3.6kHz, 14kHz] (dB)
const EQ_PRESETS = {
  flat:    [ 0,  0,  0,  0,  0],
  pop:     [ 2,  3,  1,  2,  3],
  rock:    [ 4,  2, -1,  1,  3],
  classic: [ 1,  1,  2,  2,  1],
  vocal:   [-1,  2,  4,  3,  0],
  dance:   [ 4,  1,  0,  0,  3],
  jazz:    [ 2,  3,  2,  1,  3],
  bass:    [ 6,  3, -1, -1,  0],
};
let currentEqPreset = 'flat';

// ── 应用 EQ 预设 ──────────────────────────────────────
export function applyEqPreset(name) {
  const gains = EQ_PRESETS[name];
  if (!gains) return;
  currentEqPreset = name;
  eqBypassed = false;
  EQ_BANDS.forEach((_, i) => {
    if (eqFilters[i]) {
      eqFilters[i].gain.value = gains[i];
    }
  });
  // 更新 UI 滑块
  const sliders = document.querySelectorAll('#eqPanel input[type=range]');
  const labels = document.querySelectorAll('#eqPanel [id^=eq_val_]');
  [...sliders].forEach((sl, i) => {
    if (gains[i] !== undefined) {
      sl.value = gains[i];
      if (labels[i]) labels[i].textContent = gains[i] + 'dB';
    }
  });
  // 更新预设按钮高亮
  document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('eq-preset-active'));
  document.querySelectorAll(`[data-eq-preset="${name}"]`).forEach(b => b.classList.add('eq-preset-active'));
  saveEqPresetSetting(name);
}
export function toggleEqBypass() {
  eqBypassed = !eqBypassed;
  const bypass = eqBypassed;
  EQ_BANDS.forEach((_, i) => {
    if (eqFilters[i]) {
      // bypass 时全部增益设为 0，恢复时还原为当前预设
      eqFilters[i].gain.value = bypass ? 0 : (EQ_PRESETS[currentEqPreset]?.[i] ?? 0);
    }
  });
  // 更新 UI
  const btn = document.getElementById('eqBypassBtn');
  if (btn) {
    btn.textContent = bypass ? '🔇 EQ关闭' : '🎚️ EQ开启';
    btn.classList.toggle('eq-bypassed', bypass);
  }
  // bypass 时不改滑块显示，只改按钮状态
  saveEqPresetSetting(currentEqPreset);
}

// ── 预设持久化 ────────────────────────────────────────
async function saveEqPresetSetting(name) {
  try {
    await api.setPref('eqPreset', name);
    await api.setPref('eqBypass', eqBypassed);
  } catch (e) { /* silent */ }
}

async function restoreEqPresetSetting() {
  try {
    const name = await api.getPref('eqPreset') || 'flat';
    const bypass = await api.getPref('eqBypass');
    if (name && EQ_PRESETS[name]) {
      currentEqPreset = name;
      eqBypassed = bypass === true;
      const gains = eqBypassed ? EQ_BANDS.map(() => 0) : EQ_PRESETS[name];
      EQ_BANDS.forEach((_, i) => {
        if (eqFilters[i]) eqFilters[i].gain.value = gains[i];
      });
    }
  } catch (e) { /* silent */ }
}

// 暴露给契约测试与未来的启动恢复接线（player.js 当前不调用它）
export { restoreEqPresetSetting };

// ── EQ 设置持久化 ─────────────────────────────────────
function getEqGains() {
   return eqFilters.map(f => f.gain.value);
}

export function setEqBand(index, gain) {
   if (eqFilters[index]) {
     eqFilters[index].gain.value = gain;
   }
}

export function resetEq() {
   eqFilters.forEach(f => { f.gain.value = 0; });
   // 更新 UI
   EQ_BANDS.forEach((_, i) => {
     const slider = document.getElementById('eq_' + i);
     const label = document.getElementById('eq_val_' + i);
     if (slider) slider.value = 0;
     if (label) label.textContent = '0dB';
   });
   saveEqSettings();
}

export async function saveEqSettings() {
   try {
     const gains = getEqGains();
     await api.setPref('eqGains', gains);
   } catch (_e) { /* EQ 保存失败使用默认 */ }
}
