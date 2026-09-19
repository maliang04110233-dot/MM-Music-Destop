/**
 * MusicDL 播放器 — 均衡器（5 段 EQ / 预设曲线 / 偏好持久化）
 *
 * 依赖全局：api（由 app.js 经 window.api getter 注入）、DOM #audioPlayer / #eqPanel
 *
 * 增量77 起 EQ 真实接入音频链路：首次播放后恢复偏好并懒建
 * AudioContext → MediaElementSource → 5 × BiquadFilter（lowshelf/peaking×3/
 * highshelf）→ destination。_gains 数组是增益的唯一真身（图未建时也能
 * 记录手调值），BiquadFilter 只是它的镜像。图只在「有用户手势上下文」或
 * 首次 playing 事件时创建，AudioContext 挂了就整场生效——绝不静默劫持
 * 原生输出后又不 resume（那会导致无声）。
 * 持久化闭环：eqPreset（曲线名）+ eqBypass + eqGains（逐段手调值）三个
 * 偏好键在预设/手调/重置/bypass 四个动作里都会写，恢复时以 eqGains 为准。
 * test/eq-behaviour.test.js 由「现状钉」反转为「正向钉」守卫本实现。
 */

// ── EQ 5 段均衡器 ────────────────────────────────────
const EQ_BANDS = [
   { freq: 60,   label: '60Hz',   type: 'lowshelf' },
   { freq: 230,  label: '230Hz',  type: 'peaking' },
   { freq: 910,  label: '910Hz',  type: 'peaking' },
   { freq: 3600, label: '3.6kHz', type: 'peaking' },
   { freq: 14000,label: '14kHz',  type: 'highshelf' },
];
const eqFilters = []; // BiquadFilterNode[]，ensureEqGraph() 填充
let audioCtx = null;
const _gains = [0, 0, 0, 0, 0]; // 唯一真身：用户想要的每段 dB（-12..12）
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

const _clampGain = (v) => Math.max(-12, Math.min(12, Number(v) || 0));
const _effective = () => (eqBypassed ? _gains.map(() => 0) : _gains);
const _hasProfile = () => !eqBypassed && _gains.some((g) => g !== 0);

/** 把 _gains（含 bypass 语义）镜像到已存在的滤波器节点 */
function _mirrorToGraph() {
  const eff = _effective();
  eqFilters.forEach((f, i) => { f.gain.value = eff[i]; });
}

/**
 * 懒建音频图。只应在用户手势上下文或 playing 事件里调用——
 * 创建 AudioContext 后元素声音即被劫持进图，必须保证能 resume。
 * 返回是否已有可用图。
 */
function ensureEqGraph() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return true;
  }
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  const audio = typeof document !== 'undefined' && document.getElementById('audioPlayer');
  if (!AC || !audio) return false;
  try {
    audioCtx = new AC();
    let node = audioCtx.createMediaElementSource(audio);
    eqFilters.length = 0;
    for (const band of EQ_BANDS) {
      const f = audioCtx.createBiquadFilter();
      f.type = band.type;
      f.frequency.value = band.freq;
      f.Q.value = 1;
      node.connect(f);
      node = f;
      eqFilters.push(f);
    }
    node.connect(audioCtx.destination);
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    _mirrorToGraph();
    return true;
  } catch (e) {
    audioCtx = null;
    eqFilters.length = 0;
    return false;
  }
}

// ── 应用 EQ 预设 ──────────────────────────────────────
export function applyEqPreset(name) {
  const gains = EQ_PRESETS[name];
  if (!gains) return;
  currentEqPreset = name;
  eqBypassed = false;
  gains.forEach((g, i) => { _gains[i] = _clampGain(g); });
  ensureEqGraph();
  _mirrorToGraph();
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
  saveEqSettings();
}

export function toggleEqBypass() {
  eqBypassed = !eqBypassed;
  if (_hasProfile()) ensureEqGraph(); // 开启且有曲线才需要图
  _mirrorToGraph();
  // 更新 UI
  const btn = document.getElementById('eqBypassBtn');
  if (btn) {
    btn.textContent = eqBypassed ? '🔇 EQ关闭' : '🎚️ EQ开启';
    btn.classList.toggle('eq-bypassed', eqBypassed);
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
    const rawGains = await api.getPref('eqGains');
    if (name && EQ_PRESETS[name]) currentEqPreset = name;
    eqBypassed = bypass === true;
    const valid = Array.isArray(rawGains)
      && rawGains.length === EQ_BANDS.length
      && rawGains.every((g) => Number.isFinite(g));
    const gains = valid ? rawGains.map(_clampGain) : (EQ_PRESETS[currentEqPreset] || EQ_PRESETS.flat);
    gains.forEach((g, i) => { _gains[i] = g; });
    _mirrorToGraph();
    // UI 对齐持久化状态（重启后台词/滑块不再停留默认值）
    EQ_BANDS.forEach((_, i) => {
      const slider = document.getElementById('eq_' + i);
      const label = document.getElementById('eq_val_' + i);
      if (slider) slider.value = _gains[i];
      if (label) label.textContent = _gains[i] + 'dB';
    });
    const btn = document.getElementById('eqBypassBtn');
    if (btn) {
      btn.textContent = eqBypassed ? '🔇 EQ关闭' : '🎚️ EQ开启';
      btn.classList.toggle('eq-bypassed', eqBypassed);
    }
    document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('eq-preset-active'));
    document.querySelectorAll(`[data-eq-preset="${currentEqPreset}"]`).forEach(b => b.classList.add('eq-preset-active'));
  } catch (e) { /* silent */ }
}

// 启动恢复接线：EQ 图在「首次 playing」后建立——那时必有用户手势（点歌），
// AudioContext 不会被自动播放策略卡在 suspended 而憋死原生输出
export { restoreEqPresetSetting };

// ── EQ 设置持久化 ─────────────────────────────────────
function getEqGains() {
   return _gains.slice();
}

export function setEqBand(index, gain) {
   _gains[index] = _clampGain(gain);
   ensureEqGraph();
   _mirrorToGraph();
}

export function resetEq() {
   _gains.forEach((_, i) => { _gains[i] = 0; });
   _mirrorToGraph();
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
     await api.setPref('eqGains', getEqGains());
   } catch (_e) { /* EQ 保存失败使用默认 */ }
}

// ── 生命周期接线（渲染层才有；node 单测 import 不触发）──────────
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const boot = () => {
    restoreEqPresetSetting().then(() => {
      if (_hasProfile()) ensureEqGraph();
    }).catch(() => {});
  };
  const audio = document.getElementById('audioPlayer');
  if (audio) audio.addEventListener('playing', boot, { once: true });
  window.addEventListener('beforeunload', () => {
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
      eqFilters.length = 0;
    }
  });
}
