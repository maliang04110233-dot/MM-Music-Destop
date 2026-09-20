/**
 * 不可逆操作确认弹层（增量174）
 *
 * 全应用「确认一下再动手」的唯一家：替换浏览器原生确认框——
 * 原生窗是系统灰白外观（与霓虹深色主题割裂）、带 file:// 技术标题行，
 * 还会把多行点名文案压平成一行（157/159 写的 F2 纪律 bullet 全被吃掉）。
 *
 * 分工：confirmDetails 是纯模型（文案归一化，node 可测）；
 * askConfirm 只管 DOM 与Promise，弹层样式全部在 overlays.css 的
 * .confirm-dialog* 类里（161 纪律：CSS 进 css 文件，JS 不裸写样式）。
 *
 * 同一时刻只有一个确认框：confirm 本来就是单例阻塞语义；
 * 双击/连按第二个调用复用同一个 Promise，不会出现两层弹层各等一次决定。
 */

export const CONFIRM_FALLBACK_TITLE = '确认执行该操作？';

/** 把调用方入参归一成弹层模型 { title, lines, okLabel, cancelLabel, danger } */
export function confirmDetails(opts) {
  let o = opts;
  if (o == null || typeof o === 'number' || typeof o === 'boolean') {
    o = { text: String(o ?? CONFIRM_FALLBACK_TITLE) };
  } else if (typeof o === 'string') {
    o = { text: o };
  }
  const raw = o.text != null ? String(o.text)
    : (o.title != null ? String(o.title) : CONFIRM_FALLBACK_TITLE);
  const parts = raw.split(/\r?\n/);
  // 显式给了 title 时，text 整段都是正文；否则首行当标题
  const hasTitle = o.title != null && String(o.title).trim() !== '';
  const title = hasTitle ? String(o.title).trim() : (parts[0].trim() || CONFIRM_FALLBACK_TITLE);
  const bodyLines = hasTitle ? parts : parts.slice(1);
  const lines = (Array.isArray(o.lines) && o.lines.length ? o.lines : bodyLines)
    .map((l) => String(l).trim())
    .filter(Boolean);
  return {
    title,
    lines,
    okLabel: o.okLabel || '确认',
    cancelLabel: o.cancelLabel || '取消',
    danger: o.danger === true,
  };
}

let _current = null; // { el, promise, done }

/**
 * 弹一个确认框，返回 Promise<boolean>（true=点确认，false=取消/Esc/点遮罩）。
 * 调用处必须 await——不 await 的确认框等于没有确认。
 */
export function askConfirm(opts) {
  if (_current) return _current.promise;
  const model = confirmDetails(opts);

  const overlay = document.createElement('div');
  overlay.className = 'confirm-dialog-overlay';
  const box = document.createElement('div');
  box.className = 'confirm-dialog' + (model.danger ? ' danger' : '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');

  const title = document.createElement('div');
  title.className = 'confirm-dialog-title';
  title.textContent = model.title;
  box.appendChild(title);

  if (model.lines.length) {
    const body = document.createElement('div');
    body.className = 'confirm-dialog-body';
    for (const line of model.lines) {
      const row = document.createElement('div');
      row.className = 'confirm-dialog-line';
      row.textContent = line; // 文案可能点名含尖括号的歌单/文件名，只走 textContent
      body.appendChild(row);
    }
    box.appendChild(body);
  }

  const footer = document.createElement('div');
  footer.className = 'confirm-dialog-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'setting-btn confirm-dialog-cancel';
  cancelBtn.textContent = model.cancelLabel;
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'setting-btn confirm-dialog-ok';
  okBtn.textContent = model.okLabel;
  footer.appendChild(cancelBtn);
  footer.appendChild(okBtn);
  box.appendChild(footer);
  overlay.appendChild(box);

  let done = null;
  const promise = new Promise((resolve) => { done = resolve; });
  _current = { el: overlay, promise, done };

  const close = (val) => {
    if (!_current) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    _current = null;
    done(val);
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(false); }
    else if (ev.key === 'Enter') { ev.preventDefault(); close(true); }
  };
  okBtn.addEventListener('click', () => close(true));
  cancelBtn.addEventListener('click', () => close(false));
  // 点遮罩=取消：危险级也允许——原生 confirm 点遮罩本就取消，不另设门槛
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(false); });
  document.addEventListener('keydown', onKey, true);

  document.body.appendChild(overlay);
  // 焦点给取消：键盘用户回车即确认、Esc/空格即离开，两条路都在指边
  cancelBtn.focus();
  return promise;
}
