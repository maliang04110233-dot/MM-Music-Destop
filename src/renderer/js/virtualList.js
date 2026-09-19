/**
 * 虚拟滚动组件 — 大列表性能优化
 *
 * 原理：只渲染可视区域 ± buffer 行的 DOM，滚动时动态替换内容
 * 内存：O(buffer) 而非 O(n)，10000 首歌只渲染 ~30 行 DOM
 *
 * 用法：
 *   const vs = new VirtualScroller(container, {
 *     itemHeight: 60,        // 每行高度（px）
 *     buffer: 10,            // 上下各多渲染 10 行
 *     renderItem: (item, idx) => `<div>...</div>`,  // 返回 HTML 字符串
 *     onItemClick: (item, idx, e) => {},            // 点击回调
 *   });
 *   vs.setData(songs);       // 设置数据
 *   vs.refresh();             // 强制重绘
 */

export class VirtualScroller {
  constructor(container, options = {}) {
    this.container = container;
    this.itemHeight = options.itemHeight || 60;
    this.buffer = options.buffer || 10;
    this.renderItem = options.renderItem || (() => '');
    this.onItemClick = options.onItemClick || null;

    this._data = [];
    this._scrollTop = 0;
    this._startIndex = 0;
    this._endIndex = 0;
    this._renderedItems = new Map(); // idx → DOM element
    this._placeholderTop = null;
    this._placeholderBottom = null;
    this._scrollContainer = null;
    this._renderFrame = null;

    this._init();
  }

  _init() {
    // 创建滚动容器
    this._scrollContainer = document.createElement('div');
    this._scrollContainer.style.cssText = 'overflow-y:auto;position:relative;width:100%;height:100%;';

    // 占位元素（撑开滚动高度）
    this._placeholderTop = document.createElement('div');
    this._placeholderTop.style.cssText = 'width:1px;pointer-events:none;';
    this._placeholderBottom = document.createElement('div');
    this._placeholderBottom.style.cssText = 'width:1px;pointer-events:none;';

    this._scrollContainer.appendChild(this._placeholderTop);
    this._scrollContainer.appendChild(this._placeholderBottom);

    // 渲染容器（absolute 定位）
    this._renderContainer = document.createElement('div');
    this._renderContainer.style.cssText = 'position:absolute;left:0;right:0;top:0;';
    this._scrollContainer.insertBefore(this._renderContainer, this._placeholderBottom);

    this.container.appendChild(this._scrollContainer);

    // 监听滚动
    this._scrollContainer.addEventListener('scroll', () => {
      this._scrollTop = this._scrollContainer.scrollTop;
      this._scheduleRender();
    });

    // 监听点击（事件委托）
    if (this.onItemClick) {
      this._scrollContainer.addEventListener('click', (e) => {
        const row = e.target.closest('[data-vs-idx]');
        if (row) {
          const idx = parseInt(row.dataset.vsIdx, 10);
          if (!isNaN(idx) && idx < this._data.length) {
            this.onItemClick(this._data[idx], idx, e);
          }
        }
      });
    }
  }

  /**
   * 设置数据并重绘
   * @param {Array} data
   */
  setData(data) {
    this._data = data || [];
    this._placeholderTop.style.height = '0px';
    this._placeholderBottom.style.height = (this._data.length * this.itemHeight) + 'px';
    this._scrollTop = this._scrollContainer.scrollTop;
    // 必须强制重绘：排序/过滤后可视区间不变时，非 force 的 _render 会早退，
    // 留下一屏旧行（本地库排序/过滤失效错位的根因）
    this._render(true);
  }

  /**
   * 强制重绘（数据原地修改后调用）
   */
  refresh() {
    this._render(true);
  }

  /**
   * 滚动到指定索引
   */
  scrollToIndex(idx) {
    const top = idx * this.itemHeight;
    this._scrollContainer.scrollTop = top;
  }

  /**
   * 获取当前可视区域的第一个索引
   */
  getVisibleRange() {
    return { start: this._startIndex, end: this._endIndex };
  }

  /**
   * 销毁
   */
  destroy() {
    if (this._renderFrame) cancelAnimationFrame(this._renderFrame);
    // M12: 宿主视图可能先以 innerHTML 覆盖了挂载容器（如 local.js 空态渲染），
    // 此时 _scrollContainer 已脱离 DOM，removeChild 会抛 NotFoundError
    if (this._scrollContainer && this._scrollContainer.parentNode) {
      this._scrollContainer.parentNode.removeChild(this._scrollContainer);
    }
    this._renderedItems.clear();
  }

  // ── 内部方法 ──────────────────────────────────────────

  _scheduleRender() {
    if (this._renderFrame) return;
    this._renderFrame = requestAnimationFrame(() => {
      this._renderFrame = null;
      this._render();
    });
  }

  _render(force = false) {
    const viewHeight = this._scrollContainer.clientHeight;
    const scrollTop = this._scrollTop;

    // 计算可视范围
    let start = Math.floor(scrollTop / this.itemHeight) - this.buffer;
    let end = Math.ceil((scrollTop + viewHeight) / this.itemHeight) + this.buffer;

    start = Math.max(0, start);
    end = Math.min(this._data.length, end);

    // 无变化则跳过（除非 force）
    if (!force && start === this._startIndex && end === this._endIndex) return;

    this._startIndex = start;
    this._endIndex = end;

    // 顶部占位
    this._placeholderTop.style.height = (start * this.itemHeight) + 'px';

    // 移除不在范围内的元素
    for (const [idx, el] of this._renderedItems) {
      if (idx < start || idx >= end) {
        this._renderContainer.removeChild(el);
        this._renderedItems.delete(idx);
      }
    }

    // 添加范围内的元素
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      if (!this._renderedItems.has(i)) {
        const el = this._createRow(this._data[i], i);
        fragment.appendChild(el);
        this._renderedItems.set(i, el);
      }
    }
    this._renderContainer.appendChild(fragment);
  }

  _createRow(item, idx) {
    const html = this.renderItem(item, idx);
    const wrapper = document.createElement('div');
    wrapper.dataset.vsIdx = idx;
    wrapper.style.cssText = `position:absolute;top:${idx * this.itemHeight}px;left:0;right:0;height:${this.itemHeight}px;`;
    wrapper.innerHTML = html;
    return wrapper;
  }
}

/**
 * 便捷函数：快速创建虚拟滚动列表
 */
export function createVirtualList(container, options) {
  return new VirtualScroller(container, options);
}
