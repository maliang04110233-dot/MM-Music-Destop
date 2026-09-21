/**
 * domStub 的一个家（增量193 收口，口径同 148/151/185「手抄清单必漏」）
 *
 * 来龙：182 → 186 → 193 三份测试各自手抄了一份"形状同前"的桩。193 给 welcome
 * 换掉内联 onclick（改 data-welcome + 事件委托）后，186 抄的那份立刻漏掉三件
 * 真 DOM 语义（innerHTML 解析钮、click 冒泡、querySelectorAll 寻焦），两个行为
 * 测当场炸 TypeError——漂移不是预言，是已经发生了。所以桩收进这一个家，
 * welcome/confirm 的键盘与点击契约测试一律从这里取。
 *
 * 承诺面 = 被测代码真正用到的 DOM 子集，多一个都不给：
 * ① innerHTML 赋值解析出 <button> 子元素（class/data-welcome/文本），钮序=模板序；
 * ② click 沿 parent 链冒泡（委托型宿主因此能收到钮点击）；
 * ③ querySelectorAll('button') 递归收后代（焦点陷阱的寻焦面）；
 * ④ document 监听分 capture/bubble 两队列，removeEventListener 按 (type,fn,capture) 摘除。
 * 182 的 confirm-dialog.test.js 仍自带一份（只喂 confirm 的 createElement 路径，
 * 未触及①②③），并入本家属独立小增量，此处不顺手扩大爆炸半径。
 */
import assert from 'node:assert/strict';

function stubEl(tag, doc) {
  const el = {
    tag, parent: null, children: [], className: '', textContent: '', attrs: {}, _l: {}, _html: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
      this.parent = null;
    },
    addEventListener(type, fn) { (this._l[type] ||= []).push(fn); },
    focus() { doc.activeElement = this; },
    click() {
      const ev = { type: 'click', target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      let node = this;
      while (node) {
        (node._l.click || []).forEach((fn) => fn(ev));
        node = node.parent;
      }
      return ev;
    },
    querySelectorAll(sel) {
      assert.equal(sel, 'button', '桩只承诺本契约用到的选择器');
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (c.tag === 'button') out.push(c); walk(c); } };
      walk(this);
      return out;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = v;
      const re = /<button([^>]*)>([^<]*)<\/button>/g;
      let m;
      while ((m = re.exec(v))) {
        const b = stubEl('button', doc);
        const cm = m[1].match(/class="([^"]*)"/);
        b.className = cm ? cm[1] : '';
        const dw = m[1].match(/data-welcome="([^"]*)"/);
        if (dw) b.attrs['data-welcome'] = dw[1];
        b.textContent = m[2].trim();
        b.parent = this;
        this.children.push(b);
      }
    },
  });
  return el;
}

export function makeDomStub() {
  const doc = {
    activeElement: null, _cap: [], _bub: [],
    createElement: (tag) => stubEl(tag, doc),
    addEventListener(type, fn, capture) { (capture ? doc._cap : doc._bub).push({ type, fn }); },
    removeEventListener(type, fn, capture) {
      const arr = capture ? doc._cap : doc._bub;
      const i = arr.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  doc.body = stubEl('body', doc);
  return doc;
}

export function findClass(el, cls) {
  if (el.className.split(/\s+/).includes(cls)) return el;
  for (const c of el.children) {
    const hit = findClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

// 相位语义与真 DOM 一致：document capture 按注册序 → 目标元素 → document 冒泡；
// stopImmediatePropagation 掐断同队列后续，stopPropagation 掐断后续相位。
export function dispatchKey(doc, key, target, shiftKey) {
  const ev = {
    key, type: 'keydown', target, shiftKey: !!shiftKey,
    defaultPrevented: false, propagationStopped: false, immediateStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediateStopped = true; this.propagationStopped = true; },
  };
  const run = (list) => {
    for (const l of list) {
      if (ev.immediateStopped) return;
      if (l.type === 'keydown') l.fn(ev);
    }
  };
  run([...doc._cap]);
  if (!ev.propagationStopped) run((target && target._l.keydown) || []);
  if (!ev.propagationStopped) run([...doc._bub]);
  return ev;
}

export const flush = () => new Promise((r) => setImmediate(r));
