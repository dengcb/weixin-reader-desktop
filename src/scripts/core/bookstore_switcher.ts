/**
 * 书城切换浮层（macOS Cmd+Tab 语义，dev 需求定稿）。
 *
 * 交互：按住 Cmd/Ctrl + L 弹出全部启用书城（菜单顺序），按住期间反复按 L
 * 向后循环高亮（首按即高亮「当前站点的下一个」），松开修饰键的那一刻
 * 切换到高亮书城并关闭；Esc / 点击面板外取消，点击条目立即切换。
 *
 * 结构：纯控制器（本文件，不依赖 EventBus，happy-dom 可直测）+ 薄壳
 * Manager（bookstore_switcher_manager.ts 提供 IPC host）。远程站点页与
 * 本地阅读页共用同一 AppRuntime，一处注册双端生效。
 *
 * 主题：跟随系统深浅色双套样式（CSS 变量 + prefers-color-scheme 覆盖，
 * 色值遵循 docs/DESIGN_TOKENS.md）；毛玻璃仅作增强，面板自带实底 rgba，
 * 旧 WebKit（Safari 15 基线）无 backdrop-filter 也保持可读。
 */

import {
  attachKeyboardToSameOriginIframes,
  attachKeyUpToSameOriginIframes,
} from './iframe_keyboard';
import { injectCSS, removeCSS } from './utils';

export interface BookstoreEntry {
  id: string;
  name: string;
  /** 已过 safe_icon_url 白名单的 data URI / http(s) URL；缺失时渲染字母兜底块 */
  icon: string | null;
  /** 1-based 序号，与 ⌘1~7 快捷键一致；仅前 7 项渲染角标 */
  index: number;
}

export interface BookstoreListModel {
  entries: BookstoreEntry[];
  /** 当前站点在 entries 中的下标；-1 表示无当前站（指向 local/禁用站点） */
  currentIndex: number;
}

export interface BookstoreSwitcherHost {
  loadEntries(): Promise<BookstoreListModel>;
  commit(entry: BookstoreEntry): void;
}

export const BOOKSTORE_SWITCHER_ID = 'wxrd-bookstore-switcher';
export const BOOKSTORE_SWITCHER_STYLE_ID = `${BOOKSTORE_SWITCHER_ID}-style`;
/** 高亮驻留动画结束后才移除节点；快速重按需先取消该移除 */
const HIDE_ANIMATION_MS = 120;

const SWITCHER_CSS = `
#${BOOKSTORE_SWITCHER_ID} {
  --panel-bg: rgba(245, 245, 247, 0.72);
  --panel-border: rgba(0, 0, 0, 0.08);
  --panel-shadow: 0 24px 64px rgba(0, 0, 0, 0.18), 0 4px 16px rgba(0, 0, 0, 0.10);
  --name-color: #5f6368;
  --name-active-color: #1f2329;
  --badge-bg: rgba(0, 0, 0, 0.08);
  --badge-color: #1f2329;
  --active-bg: rgba(255, 255, 255, 0.70);
  --active-border: rgba(0, 0, 0, 0.06);
  --active-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
  --current-ring: #349f66;
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 距屏幕边缘的最小边距：padding 同时约束面板换行后的可视范围 */
  padding: 40px;
  z-index: 2147483647;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.1s ease;
}
@media (prefers-color-scheme: dark) {
  #${BOOKSTORE_SWITCHER_ID} {
    --panel-bg: rgba(28, 30, 32, 0.72);
    --panel-border: rgba(255, 255, 255, 0.10);
    --panel-shadow: 0 24px 64px rgba(0, 0, 0, 0.45), 0 4px 16px rgba(0, 0, 0, 0.30);
    --name-color: #a6aa9e;
    --name-active-color: #ffffff;
    --badge-bg: rgba(255, 255, 255, 0.14);
    --badge-color: #e8eaed;
    --active-bg: rgba(255, 255, 255, 0.18);
    --active-border: transparent;
    --active-shadow: none;
    --current-ring: #60c38e;
  }
}
#${BOOKSTORE_SWITCHER_ID}.wxrd-switcher-shown {
  opacity: 1;
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-panel {
  pointer-events: auto;
  display: flex;
  flex-wrap: wrap;
  align-content: center;
  justify-content: center;
  gap: 8px;
  max-width: min(720px, 100%);
  padding: 20px;
  border: 1px solid var(--panel-border);
  border-radius: 20px;
  background: var(--panel-bg);
  -webkit-backdrop-filter: blur(28px) saturate(1.4);
  backdrop-filter: blur(28px) saturate(1.4);
  box-shadow: var(--panel-shadow);
  transform: scale(0.96);
  transition: transform 0.12s cubic-bezier(0.2, 0.8, 0.2, 1);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
}
#${BOOKSTORE_SWITCHER_ID}.wxrd-switcher-shown .wxrd-switcher-panel {
  transform: scale(1);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-item {
  width: 96px;
  padding: 10px 4px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  font: inherit;
  color: var(--name-color);
  cursor: pointer;
  outline: none;
  -webkit-user-select: none;
  user-select: none;
  transition: background 0.12s ease, transform 0.12s ease,
    border-color 0.12s ease, box-shadow 0.12s ease, color 0.12s ease;
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-item.wxrd-switcher-active {
  background: var(--active-bg);
  border-color: var(--active-border);
  box-shadow: var(--active-shadow);
  transform: scale(1.05);
  color: var(--name-active-color);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-icon-wrap {
  position: relative;
  width: 64px;
  height: 64px;
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-icon {
  display: block;
  width: 64px;
  height: 64px;
  /* 部分站点 PNG 自带更大的圆角＋透明角（起点等），白色垫底会在角上露白；
     裁切弧必须大于图标自带弧（18px ≈ 64px 的 28%）才能把它们裁掉 */
  border-radius: 18px;
  object-fit: cover;
  /* 透明底图标在深色面板上的可读底色 */
  background: #ffffff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-icon-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: linear-gradient(135deg, #349f66, #223f2f);
  color: #ffffff;
  font-size: 30px;
  font-weight: 600;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-item.wxrd-switcher-current .wxrd-switcher-icon,
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-item.wxrd-switcher-current .wxrd-switcher-icon-fallback {
  outline: 2px solid var(--current-ring);
  outline-offset: 1px;
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-badge {
  position: absolute;
  top: -5px;
  left: -5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  box-sizing: border-box;
  border-radius: 8px;
  background: var(--badge-bg);
  color: var(--badge-color);
  font-size: 10px;
  line-height: 16px;
  font-weight: 600;
  text-align: center;
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-name {
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.2;
}
@media (prefers-reduced-motion: reduce) {
  #${BOOKSTORE_SWITCHER_ID},
  #${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-panel,
  #${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-item {
    transition: none;
  }
}
`;

type SwitcherState = 'idle' | 'pending' | 'visible';

export class BookstoreSwitcherController {
  private state: SwitcherState = 'idle';
  private entries: BookstoreEntry[] = [];
  private highlightIndex = 0;
  /** 加载结果中「当前站」的下标；-1 = 无当前站（渲染描边用） */
  private currentListIndex = -1;
  /** pending 期间叠加按下的 L 次数：列表就绪后一次性前进，语义与逐按一致 */
  private queuedAdvances = 0;
  private loadGeneration = 0;
  private hideTimer: number | null = null;
  private readonly view: Window;
  private readonly keydownHandler: (event: KeyboardEvent) => void;
  private readonly keyupHandler: (event: KeyboardEvent) => void;
  private readonly pointerHandler: (event: PointerEvent) => void;
  private readonly blurHandler: () => void;
  private readonly detachIframeKeyDown: () => void;
  private readonly detachIframeKeyUp: () => void;
  private destroyed = false;

  constructor(
    private readonly host: BookstoreSwitcherHost,
    private readonly doc: Document = document,
    /** Windows 下 WebView2 会把 Ctrl 系键喂给内建加速器，需拦截传播（瞒天过海同构） */
    private readonly stopPagePropagation = false,
  ) {
    this.view = doc.defaultView ?? window;
    this.keydownHandler = (event) => this.onKeyDown(event);
    this.keyupHandler = (event) => this.onKeyUp(event);
    this.pointerHandler = (event) => this.onPointerDown(event);
    this.blurHandler = () => this.cancel();
    this.view.addEventListener('keydown', this.keydownHandler, true);
    this.view.addEventListener('keyup', this.keyupHandler, true);
    // pointerdown 挂 document（capture）：面板外的任何点击都先经过这里
    this.doc.addEventListener('pointerdown', this.pointerHandler, true);
    this.view.addEventListener('blur', this.blurHandler, true);
    // 微信读书正文渲染在同源 iframe 里，焦点落入后 keydown/keyup 都到不了
    // 顶层 window——浮层的生死两半都依赖转发。
    this.detachIframeKeyDown = attachKeyboardToSameOriginIframes(this.keydownHandler);
    this.detachIframeKeyUp = attachKeyUpToSameOriginIframes(this.keyupHandler);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadGeneration++;
    this.state = 'idle';
    this.view.removeEventListener('keydown', this.keydownHandler, true);
    this.view.removeEventListener('keyup', this.keyupHandler, true);
    this.doc.removeEventListener('pointerdown', this.pointerHandler, true);
    this.view.removeEventListener('blur', this.blurHandler, true);
    this.detachIframeKeyDown();
    this.detachIframeKeyUp();
    if (this.hideTimer) {
      this.view.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.doc.getElementById(BOOKSTORE_SWITCHER_ID)?.remove();
    removeCSS(BOOKSTORE_SWITCHER_STYLE_ID);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.destroyed) return;
    if (this.state === 'visible' && event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }
    const isTriggerKey = event.key?.toLowerCase() === 'l' || event.code === 'KeyL';
    if (!isTriggerKey) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    // 按住 L 不松的 OS 自动重复必须忽略，否则高亮疯狂循环
    if (event.repeat) return;
    event.preventDefault();
    if (this.stopPagePropagation) event.stopImmediatePropagation();
    if (this.state === 'visible') {
      this.advance();
      return;
    }
    if (this.state === 'pending') {
      this.queuedAdvances++;
      return;
    }
    this.state = 'pending';
    this.queuedAdvances = 0;
    this.open();
  }

  /** 加载列表并显示浮层，高亮「当前站点的下一个」。 */
  private open(): void {
    const generation = ++this.loadGeneration;
    void this.host.loadEntries().then((model) => {
      // 迟到的结果：销毁、已取消或修饰键已松开（keyup 时把 pending 拨回 idle）一律丢弃
      if (this.destroyed || generation !== this.loadGeneration) return;
      if (this.state !== 'pending') return;
      if (model.entries.length === 0) {
        this.state = 'idle';
        return;
      }
      this.entries = model.entries;
      this.currentListIndex = model.currentIndex;
      this.highlightIndex =
        model.currentIndex >= 0 && model.currentIndex < model.entries.length
          ? (model.currentIndex + 1) % model.entries.length
          : 0;
      while (this.queuedAdvances > 0) {
        this.queuedAdvances--;
        this.highlightIndex = (this.highlightIndex + 1) % this.entries.length;
      }
      this.renderPanel();
      this.state = 'visible';
      this.show();
    });
  }

  /** 遥控器 TV 长按：打开切换浮层（高亮下一个）。重复调用无副作用。 */
  startRemoteCycle(): void {
    if (this.destroyed || this.state !== 'idle') return;
    this.queuedAdvances = 0;
    this.state = 'pending';
    this.open();
  }

  /** 遥控器长按轮播：高亮前进一格。 */
  advanceRemote(): void {
    if (this.destroyed || this.state !== 'visible') return;
    this.advance();
  }

  /** 遥控器松手：切换到当前高亮；若尚未显示则取消。 */
  commitRemote(): void {
    if (this.destroyed) return;
    if (this.state === 'visible') {
      this.commitIndex(this.highlightIndex);
      return;
    }
    this.cancel();
  }

  cancelRemote(): void {
    this.cancel();
  }

  get isVisible(): boolean {
    return this.state === 'visible';
  }

  get isPending(): boolean {
    return this.state === 'pending';
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (this.destroyed || this.state === 'idle') return;
    // 只认「主修饰键全部松开」；按住期间 L 自身的 keyup 不做事
    if (event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    if (this.stopPagePropagation) event.stopImmediatePropagation();
    if (this.state === 'pending') {
      // 列表尚未就绪就已松手：不闪面板
      this.cancel();
      return;
    }
    this.commitIndex(this.highlightIndex);
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.destroyed || this.state !== 'visible') return;
    // 不用 instanceof Element：happy-dom 测试环境未把 Element 暴露为全局类
    const target = event.target as Element | null;
    if (target?.closest(`#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-panel`)) {
      return;
    }
    this.cancel();
  }

  private advance(): void {
    if (this.entries.length === 0) return;
    this.highlightIndex = (this.highlightIndex + 1) % this.entries.length;
    this.updateHighlight();
  }

  private commitIndex(entryIndex: number): void {
    const entry = this.entries[entryIndex];
    this.state = 'idle';
    this.hide();
    if (entry) this.host.commit(entry);
  }

  private cancel(): void {
    if (this.state === 'pending') {
      // 使迟到结果作废
      this.loadGeneration++;
    }
    this.state = 'idle';
    this.hide();
  }

  private renderPanel(): void {
    injectCSS(BOOKSTORE_SWITCHER_STYLE_ID, SWITCHER_CSS);
    let root = this.doc.getElementById(BOOKSTORE_SWITCHER_ID);
    if (!root) {
      root = this.doc.createElement('div');
      root.id = BOOKSTORE_SWITCHER_ID;
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', '切换书城');
    }
    root.textContent = '';
    const panel = this.doc.createElement('div');
    panel.className = 'wxrd-switcher-panel';
    this.entries.forEach((entry, entryIndex) => {
      panel.appendChild(this.renderItem(entry, entryIndex, entryIndex === this.currentListIndex));
    });
    root.appendChild(panel);
    if (!root.parentNode) this.doc.body.appendChild(root);
    this.updateHighlight();
  }

  private renderItem(
    entry: BookstoreEntry,
    entryIndex: number,
    isCurrent: boolean,
  ): HTMLButtonElement {
    const item = this.doc.createElement('button');
    item.type = 'button';
    item.className = 'wxrd-switcher-item';
    item.dataset.siteId = entry.id;
    if (isCurrent) item.classList.add('wxrd-switcher-current');

    const iconWrap = this.doc.createElement('span');
    iconWrap.className = 'wxrd-switcher-icon-wrap';
    if (entry.icon) {
      const img = this.doc.createElement('img');
      img.className = 'wxrd-switcher-icon';
      img.src = entry.icon;
      img.alt = '';
      img.draggable = false;
      iconWrap.appendChild(img);
    } else {
      const fallback = this.doc.createElement('span');
      fallback.className = 'wxrd-switcher-icon-fallback';
      fallback.textContent = Array.from(entry.name)[0] ?? '·';
      iconWrap.appendChild(fallback);
    }
    if (entry.index >= 1 && entry.index <= 7) {
      const badge = this.doc.createElement('span');
      badge.className = 'wxrd-switcher-badge';
      badge.textContent = String(entry.index);
      iconWrap.appendChild(badge);
    }

    const name = this.doc.createElement('span');
    name.className = 'wxrd-switcher-name';
    name.textContent = entry.name;
    name.title = entry.name;

    item.appendChild(iconWrap);
    item.appendChild(name);
    item.addEventListener('click', () => {
      if (!this.destroyed && this.state === 'visible') this.commitIndex(entryIndex);
    });
    return item;
  }

  private updateHighlight(): void {
    const root = this.doc.getElementById(BOOKSTORE_SWITCHER_ID);
    if (!root) return;
    root.querySelectorAll('.wxrd-switcher-item').forEach((item, itemIndex) => {
      item.classList.toggle('wxrd-switcher-active', itemIndex === this.highlightIndex);
    });
  }

  private show(): void {
    if (this.hideTimer) {
      this.view.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const root = this.doc.getElementById(BOOKSTORE_SWITCHER_ID);
    if (!root) return;
    // 先强制一次样式计算再挂 shown 类，保证进出场过渡可靠触发
    void root.getBoundingClientRect().width;
    root.classList.add('wxrd-switcher-shown');
  }

  private hide(): void {
    const root = this.doc.getElementById(BOOKSTORE_SWITCHER_ID);
    if (!root) return;
    root.classList.remove('wxrd-switcher-shown');
    if (this.hideTimer) this.view.clearTimeout(this.hideTimer);
    this.hideTimer = this.view.setTimeout(() => {
      this.hideTimer = null;
      root.remove();
    }, HIDE_ANIMATION_MS);
  }
}
