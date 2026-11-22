/**
 * ReadingPercentManager — 阅读页标题行右端的全书大概进度徽章。
 *
 * 全局开关 showReadingPercent 开启且位于阅读页时，订阅进度/章节事件，
 * 调当前站点运行时的 getBookProgress() 取全书百分比渲染一个小号灰字徽章。
 * 微信读书挂正文面板右上（标题行右端），本地挂顶栏右端，其余站点固定右上角。
 * 比例由各站点自行计算（微信读书按章节字数加权，本地按篇幅加权，插件按章数），
 * 本 Manager 只负责显示，不参与任何进度算法。
 */

import { BaseManager, Events } from '../core/base_manager';
import { createSiteContext, SiteContext } from '../core/site_context';
import { settingsStore } from '../core/settings_store';
import { log } from '../core/logger';

const BADGE_ID = 'wxrd-reading-percent';
const REFRESH_THROTTLE_MS = 300;
// 锚点晚到（微信读书章节加载动画）或进度数据晚到（插件不发射进度事件，
// 页面数据异步就绪）时轮询补挂；有界放弃，避免无数据站点永久轮询。
const RETRY_LIMIT = 50;
const RETRY_INTERVAL_MS = 300;

type AnchorMode = 'navbar' | 'panel' | 'header' | 'fixed';
interface Anchor { parent: HTMLElement; mode: AnchorMode }

// 各插件正文标题行元素：徽章挂其右端，与标题行同水平线（对齐微信读书/本地）。
const PLUGIN_HEADER_SELECTORS: Record<string, string> = {
  fanqie: '.muye-reader-box-header',
  qimao: '.chapter-detail-wrap-info',
  qidian: '.chapter-wrapper .print',
};

export class ReadingPercentManager extends BaseManager {
  private siteContext: SiteContext;
  private badge: HTMLElement | null = null;
  private enabled = false;
  private isReader = false;
  private unsubscribeSettings: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;

  constructor() {
    super();
    this.siteContext = createSiteContext();
    this.init();
  }

  private init(): void {
    this.isReader = this.siteContext.isReaderPage;
    this.enabled = settingsStore.getGlobal().showReadingPercent === true;

    this.unsubscribeSettings = settingsStore.subscribe(() => {
      const next = settingsStore.getGlobal().showReadingPercent === true;
      const toggled = next !== this.enabled;
      this.enabled = next;
      if (toggled) {
        this.sync();
      } else if (this.enabled && this.isReader) {
        // 宽窄屏等布局设置变化时重新测量徽章边距。
        this.scheduleRefresh();
      }
    });

    this.onWithHistory(Events.ROUTE_CHANGED, (e: { isReader: boolean }) => {
      this.isReader = e.isReader;
      this.sync();
    });

    this.on(Events.PROGRESS_UPDATED, () => this.scheduleRefresh());
    this.on(Events.CHAPTER_CHANGED, () => this.scheduleRefresh());

    this.sync();
  }

  private sync(): void {
    if (this.enabled && this.isReader) {
      this.retryCount = 0;
      void this.refresh();
    } else {
      this.removeBadge();
    }
  }

  private scheduleRefresh(): void {
    if (!this.enabled || !this.isReader || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, REFRESH_THROTTLE_MS);
  }

  private async refresh(): Promise<void> {
    if (this.destroyed || !this.enabled || !this.isReader) return;
    const runtime = this.siteContext.currentRuntime;
    if (!runtime?.getBookProgress) {
      this.removeBadge();
      return;
    }
    let progress: number | undefined;
    try {
      const info = await runtime.getBookProgress();
      progress = info?.progress;
    } catch (error) {
      log.warn('[ReadingPercent] getBookProgress failed', error);
      return;
    }
    if (this.destroyed || !this.enabled || !this.isReader) return;
    if (typeof progress !== 'number' || !Number.isFinite(progress)) {
      // 插件页面数据异步就绪：暂时无比例时轮询重试，就绪后自动补挂。
      this.removeBadge();
      this.scheduleRetry();
      return;
    }
    this.renderBadge(Math.min(100, Math.max(0, Math.round(progress))));
  }

  private resolveAnchor(): Anchor | null {
    const siteId = this.siteContext.siteId;
    if (siteId === 'local') {
      const navbar = document.querySelector<HTMLElement>('.local-navbar');
      return navbar ? { parent: navbar, mode: 'navbar' } : null;
    }
    if (siteId === 'weread') {
      // 顶层 frame 存在尺寸为 0 的隐藏面板副本，正文真面板在同源 iframe 内。
      // 只接受有实际宽度的面板，避免徽章挂到隐藏副本上贴死窗口角落。
      const candidates = [
        document.querySelector<HTMLElement>('.renderTargetContainer'),
        document.querySelector<HTMLElement>('.readerChapterContent'),
      ];
      for (const panel of candidates) {
        if (panel && panel.getBoundingClientRect().width > 0) {
          return { parent: panel, mode: 'panel' };
        }
      }
      return null;
    }
    const selector = PLUGIN_HEADER_SELECTORS[siteId];
    const header = selector ? document.querySelector<HTMLElement>(selector) : null;
    if (header && header.getBoundingClientRect().width > 0) {
      return { parent: header, mode: 'header' };
    }
    return { parent: document.body, mode: 'fixed' };
  }

  private renderBadge(progress: number): void {
    const anchor = this.resolveAnchor();
    if (!anchor) {
      this.scheduleRetry();
      return;
    }
    this.retryCount = 0;

    if (!this.badge) {
      this.badge = document.createElement('span');
      this.badge.id = BADGE_ID;
      this.badge.setAttribute('aria-hidden', 'true');
    }
    this.badge.textContent = `${progress}%`;
    this.applyStyle(this.badge, anchor.mode, anchor.parent);
    if (this.badge.parentElement !== anchor.parent) {
      anchor.parent.appendChild(this.badge);
    }
  }

  private applyStyle(badge: HTMLElement, mode: AnchorMode, parent: HTMLElement): void {
    const base = 'font-size:12px;line-height:1;color:#999;pointer-events:none;user-select:none;white-space:nowrap;';
    if (mode === 'navbar') {
      // 本地正文文字总宽 = 视口×ratio（宽屏 0.9 / 窄屏 0.8，居中），
      // 徽章右边距镜像文字右边距，随宽窄屏自适应贴边。
      const ratio = settingsStore.getSite('local').readerWide ? 0.9 : 0.8;
      const right = Math.round(window.innerWidth * (1 - ratio) / 2);
      badge.style.cssText = `${base}position:absolute;right:${right}px;top:50%;transform:translateY(-50%);`;
    } else if (mode === 'panel') {
      // 微信读书标题行是 canvas 绘制、无 DOM 节点，面板 padding 为 0。
      // 用底部 pager 的左边距运行时测量正文水平内边距（即标题行左边距），
      // 徽章右边距与之镜像；上边距按实测比例推算，与标题行同水平线。
      const panelRect = parent.getBoundingClientRect();
      const pager = document.querySelector('.renderTarget_pager');
      let inset = Math.round(panelRect.width * 0.045);
      if (pager) {
        const measured = pager.getBoundingClientRect().left - panelRect.left;
        if (measured > 0) inset = Math.round(measured);
      }
      const top = Math.round(inset * 2 / 3);
      badge.style.cssText = `${base}position:absolute;top:${top}px;right:${inset}px;z-index:9999;`;
    } else if (mode === 'header') {
      // 插件标题行：挂其右端，右边距镜像标题行左内边距。
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      const inset = Math.round(parseFloat(getComputedStyle(parent).paddingLeft) || 16);
      const parentRect = parent.getBoundingClientRect();
      // 矮头部（独立标题行）垂直居中；高容器（含整章正文）对齐内部标题子元素。
      let vertical = 'top:50%;transform:translateY(-50%);';
      if (parentRect.height > 100) {
        const titleChild = parent.querySelector('h1, h2, .chapter-title, .title');
        if (titleChild) {
          const childRect = titleChild.getBoundingClientRect();
          const top = Math.round(childRect.top - parentRect.top + (childRect.height - 12) / 2);
          vertical = `top:${top}px;`;
        }
      }
      badge.style.cssText = `${base}position:absolute;right:${inset}px;${vertical}z-index:9999;`;
    } else {
      badge.style.cssText = `${base}position:fixed;top:12px;right:18px;z-index:9999;`;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.retryCount >= RETRY_LIMIT) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.destroyed || !this.enabled || !this.isReader) return;
      this.retryCount++;
      void this.refresh();
    }, RETRY_INTERVAL_MS);
  }

  private removeBadge(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.badge?.remove();
    this.badge = null;
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.removeBadge();
    super.destroy();
  }
}