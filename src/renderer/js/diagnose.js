/**
 * 下载失败诊断向导
 *
 * classifyFailure 是纯函数：优先按引擎回写的 errorCode 查表，
 * 未知码再按 error 文本关键词兜底（磁盘/网络/鉴权/VIP），永不返回空。
 * 弹层给出「原因 + 建议 + 可行动作」（前往设置 / 立即重试），
 * 与 download.js 的 errorTag 徽标互补：徽标说“是什么”，诊断说“怎么办”。
 *
 * 增量158 起弹层不再专属队列：按钮显隐收成 diagHeals 一处纯规则，
 * 具体动作由调用方那一页经 ctx 注入（队列 retryQueueItem / 历史 retryFromHistory）。
 */

/** 码表：cause=给用户看的原因，advice=下一步建议，heal=可一键执行的动作 */
const DIAG_TABLE = {
  VIP_REQUIRED: { cause: '该音质档位为平台 VIP 专享', advice: '在搜索结果右键「以此音质下载」选低一档，或到设置补 VIP 账号的 Cookie', heal: 'settings' },
  AUTH_EXPIRED: { cause: '平台 Cookie 已过期', advice: '到 设置 → 平台 Cookie 更新后点「立即重试」', heal: 'settings' },
  LOGIN_REQUIRED: { cause: '该平台需要登录才能取流', advice: '到 设置 填入已登录的 Cookie 后重试', heal: 'settings' },
  COPYRIGHT_RESTRICTED: { cause: '版权受限（地区限制或曲目下架）', advice: '换其他平台搜索同名版本，一般聚合搜索里会有替代源', heal: null },
  UNAVAILABLE: { cause: '曲目当前不可用', advice: '稍后重试；持续失败就换源搜索同名版本', heal: 'retry' },
  CDN_EMPTY: { cause: '平台 CDN 返回空数据（多为高峰期限流）', advice: '稍后再试，或用「定时下载」错峰到夜间自动入队', heal: null },
  NETWORK_TIMEOUT: { cause: '网络超时', advice: '检查网络/代理；不稳定时到设置把并发数调低再重试', heal: 'retry' },
  NO_AUDIO_STREAM: { cause: '找不到可播放的音频流（付费/加密/下架）', advice: '换一档音质或换源；本地库可用「音质扫描」核对已有文件', heal: null },
  UNKNOWN_PLATFORM: { cause: '链接所属平台暂不支持', advice: '确认链接来自支持列表内的平台', heal: null },
};

const KEYWORD_RULES = [
  { re: /ENOSPC|no space|空间不足/i, cause: '磁盘剩余空间不足', advice: '清理磁盘或到设置更换下载目录后重试', heal: 'settings' },
  { re: /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|网络/i, cause: '网络异常', advice: '检查网络/代理后点「立即重试」', heal: 'retry' },
  { re: /403|cookie|auth|登录|unauthorized/i, cause: '鉴权失败（Cookie 无效或缺失）', advice: '到 设置 → 平台 Cookie 更新后重试', heal: 'settings' },
  { re: /vip/i, cause: '需要 VIP 权限', advice: '换低一档音质下载，或在设置补 VIP Cookie', heal: 'settings' },
];

/**
 * 纯分类：errorCode 命中码表优先，否则关键词兜底，最后归「未分类」。
 * @returns {{code:string, cause:string, advice:string, heal:(string|null)}}
 */
export function classifyFailure(errorCode, errorText) {
  const code = errorCode ? String(errorCode) : '';
  if (DIAG_TABLE[code]) return { code, ...DIAG_TABLE[code] };
  const text = errorText ? String(errorText) : '';
  for (const r of KEYWORD_RULES) {
    if (r.re.test(text)) return { code: code || 'INFERRED', cause: r.cause, advice: r.advice, heal: r.heal };
  }
  return {
    code: code || 'UNKNOWN',
    cause: '未分类的失败',
    advice: '展开任务详情复制错误信息反馈；也可以直接点「立即重试」看是否为偶发',
    heal: 'retry',
  };
}

function _closeDiag() {
  const el = document.getElementById('diagOverlay');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

/** 「前往设置」点的是全局导航，任何页面都点得动，故由本模块自己实现 */
function _gotoSettings() {
  const btn = document.querySelector('.nav-item[data-tab="settings"]');
  if (btn && typeof window.switchTab === 'function') window.switchTab('settings', btn);
}

/**
 * 纯函数：诊断弹层该出现哪些按钮（显隐规则唯一一家）。
 * 「立即重试」还要看调用方那一页给没给重试动作 —— 队列给 retryQueueItem(taskId)，
 * 历史页给 retryFromHistory(六字段)。通用层不认识任何一页的动作，
 * 所以缺动作就少一个按钮，而不是弹一个点了没反应的按钮。
 * @param {{heal?: (string|null)}} d
 * @param {{retry?: Function}} [ctx]
 * @returns {Array<{label:string, primary:boolean, run:Function}>}
 */
export function diagHeals(d, ctx) {
  const heal = d ? d.heal : null;
  const out = [];
  if (heal === 'settings') out.push({ label: '前往设置', primary: true, run: _gotoSettings });
  if (ctx && typeof ctx.retry === 'function' && (heal === 'retry' || heal === 'settings')) {
    out.push({ label: '立即重试', primary: false, run: ctx.retry });
  }
  return out;
}

/** 通用入口：给一条带 error/errorCode 的记录弹诊断层，动作由页面经 ctx 注入 */
export function showDiagnosis(task, ctx) {
  if (!task) return;
  _renderDiag(task, classifyFailure(task.errorCode, task.error), ctx);
}

function _renderDiag(task, d, ctx) {
  _closeDiag();
  const overlay = document.createElement('div');
  overlay.id = 'diagOverlay';
  overlay.className = 'edit-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeDiag(); });

  const panel = document.createElement('div');
  panel.className = 'edit-panel';

  const header = document.createElement('div');
  header.className = 'edit-header';
  const title = document.createElement('span');
  title.className = 'edit-title';
  title.textContent = '🆘 失败诊断';
  const close = document.createElement('button');
  close.className = 'edit-close';
  close.textContent = '✕';
  close.addEventListener('click', _closeDiag);
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'edit-body';
  const songLabel = `${task.title || '未知曲目'}${task.artist ? ' · ' + task.artist : ''}`;
  const errLine = task.error ? String(task.error) : '';
  body.innerHTML =
    `<div class="sched-job"><div class="sched-job-lines">${esc(songLabel)}${task.source ? '（' + esc(String(task.source)) + '）' : ''}</div></div>` +
    `<div class="sched-job"><div class="sched-job-lines"><b>原因：</b>${esc(d.cause)}${d.code ? '　' + esc(d.code) : ''}</div></div>` +
    `<div class="sched-job"><div class="sched-job-lines"><b>建议：</b>${esc(d.advice)}</div></div>` +
    (errLine ? `<div class="sched-job"><div class="sched-job-lines"><b>原始错误：</b>${esc(errLine.slice(0, 200))}</div></div>` : '');

  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
  for (const h of diagHeals(d, ctx)) {
    const b = document.createElement('button');
    b.className = h.primary ? 'btn btn-primary' : 'btn';
    b.textContent = h.label;
    b.addEventListener('click', () => {
      _closeDiag();
      h.run();
    });
    foot.appendChild(b);
  }
  body.appendChild(foot);
  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

/** 入口：按 taskId 从队列快照找失败任务并弹诊断层 */
function diagnoseFailure(taskId) {
  const queue = (typeof getState === 'function' && getState('queueSnapshot')) || [];
  const task = queue.find(q => String(q.taskId) === String(taskId));
  if (!task) { showToast('任务已不在队列中', 'warn', 2000); return; }
  showDiagnosis(task, { retry: () => { if (typeof window.retryQueueItem === 'function') window.retryQueueItem(task.taskId); } });
}

/** 命令面板入口：诊断最近一个失败任务 */
function diagnoseLatestFailure() {
  const queue = (typeof getState === 'function' && getState('queueSnapshot')) || [];
  const failed = queue.filter(q => q.status === 'error');
  if (!failed.length) { showToast('队列里没有失败任务', 'info', 2000); return; }
  diagnoseFailure(failed[failed.length - 1].taskId);
}

/** 鉴权/VIP 类：自动重试没有意义，须先去设置处理 */
const AUTH_CODES = new Set(['VIP_REQUIRED', 'AUTH_EXPIRED', 'LOGIN_REQUIRED']);

/**
 * 纯聚合：error 任务按 classifyFailure 分组。
 * @returns {Array<{code,cause,advice,heal,songs:Array}>} 按数量降序
 */
export function groupFailures(items) {
  const groups = new Map();
  for (const it of items || []) {
    if (!it || it.status !== 'error') continue;
    const d = classifyFailure(it.errorCode, it.error);
    let g = groups.get(d.code);
    if (!g) { g = { ...d, songs: [] }; groups.set(d.code, g); }
    g.songs.push({ taskId: it.taskId, title: it.title || '未知曲目' });
  }
  return Array.from(groups.values()).sort((a, b) => b.songs.length - a.songs.length);
}

/** 可自动重试（非鉴权类）的任务总数 */
export function retryableFailureCount(groups) {
  return groups.reduce((n, g) => n + (AUTH_CODES.has(g.code) ? 0 : g.songs.length), 0);
}

function _closeFailReport() {
  const el = document.getElementById('failReportOverlay');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function _renderFailReport(groups) {
  _closeFailReport();
  const total = groups.reduce((n, g) => n + g.songs.length, 0);
  const overlay = document.createElement('div');
  overlay.id = 'failReportOverlay';
  overlay.className = 'edit-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeFailReport(); });

  const panel = document.createElement('div');
  panel.className = 'edit-panel';

  const header = document.createElement('div');
  header.className = 'edit-header';
  const title = document.createElement('span');
  title.className = 'edit-title';
  title.textContent = `🩹 失败诊断报告（${total} 首 · ${groups.length} 类原因）`;
  const close = document.createElement('button');
  close.className = 'edit-close';
  close.textContent = '✕';
  close.addEventListener('click', _closeFailReport);
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'edit-body';
  for (const g of groups) {
    const names = g.songs.slice(0, 6).map(s => s.title).join('、')
      + (g.songs.length > 6 ? ` 等 ${g.songs.length} 首` : '');
    const row = document.createElement('div');
    row.className = 'sched-job';
    row.innerHTML =
      `<div class="sched-job-lines"><b>${esc(g.cause)}</b> · ${g.songs.length} 首（${esc(g.code)}）</div>` +
      `<div class="sched-job-lines">${esc(g.advice)}</div>` +
      `<div class="sched-job-lines" style="opacity:.7">${esc(names)}</div>`;
    body.appendChild(row);
  }

  const retryable = retryableFailureCount(groups);
  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
  if (retryable > 0) {
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.textContent = `🔄 一键重试可恢复任务（${retryable}）`;
    b.addEventListener('click', async () => {
      _closeFailReport();
      let ok = 0;
      for (const g of groups) {
        if (AUTH_CODES.has(g.code)) continue;
        for (const s of g.songs) {
          try { const r = await api.retryDownload(s.taskId); if (r && r.ok) ok++; } catch (_e) { /* 单个失败不影响整体 */ }
        }
      }
      showToast(ok ? `已重试 ${ok} 项` : '重试未成功，可稍后再试', ok ? 'success' : 'warn', 3000);
    });
    foot.appendChild(b);
  }
  body.appendChild(foot);
  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

/** 入口：聚合队列里所有失败任务并弹报告 */
function openFailureReport() {
  const queue = (typeof getState === 'function' && getState('queueSnapshot')) || [];
  const groups = groupFailures(queue);
  if (!groups.length) { showToast('队列里没有失败任务', 'info', 2000); return; }
  _renderFailReport(groups);
}

if (typeof document !== 'undefined') {
  window.diagnoseFailure = diagnoseFailure;
  window.diagnoseLatestFailure = diagnoseLatestFailure;
  window.closeFailureDiag = _closeDiag;
  window.openFailureReport = openFailureReport;
  window.closeFailureReport = _closeFailReport;
}
