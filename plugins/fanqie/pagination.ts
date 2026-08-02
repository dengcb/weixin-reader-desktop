export const FANQIE_PAGED_CLASS = 'atreader-fanqie-paged';
export const FANQIE_NO_TRANSITION_CLASS = 'atreader-fanqie-no-transition';
export const FANQIE_CONTENT_SELECTOR = '.muye-reader-content';

const DEFAULT_COLUMN_GAP = 64;
const MIN_PAGE_HEIGHT = 320;
const PROGRESS_INDICATOR_INSET = 48;

export interface SpreadMetrics {
  pageCount: number;
  pageStride: number;
}

/**
 * CSS 多栏的相邻栏间距也存在于两组跨页之间，所以一整页的位移是
 * `容器宽度 + 一份栏间距`，而不是单纯的 clientWidth。
 */
export function calculateSpreadMetrics(
  clientWidth: number,
  scrollWidth: number,
  columnGap: number,
): SpreadMetrics {
  if (clientWidth <= 0 || scrollWidth <= 0) {
    return { pageCount: 1, pageStride: 0 };
  }
  const safeGap = Number.isFinite(columnGap) && columnGap >= 0
    ? columnGap
    : DEFAULT_COLUMN_GAP;
  const pageStride = clientWidth + safeGap;
  const pageCount = Math.max(1, Math.ceil((scrollWidth + safeGap) / pageStride));
  return { pageCount, pageStride };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

interface FanqiePaginatorOptions {
  onPositionChange?: (pageIndex: number, pageCount: number) => void;
  onChapterChange?: (chapterKey: string) => void;
  getChapterKey?: () => string;
}

/*!
 * @capability doubleColumn
 * [功能能力 1/6：双栏模式]
 * 只管理原页面 DOM 的“呈现方式”：不复制正文，也不读取正文文本。
 * 正文仍由番茄页面渲染，CSS columns 负责分栏，本类只计算整页位移。
 */
export class FanqiePaginator {
  private readonly onPositionChange?: FanqiePaginatorOptions['onPositionChange'];
  private readonly onChapterChange?: FanqiePaginatorOptions['onChapterChange'];
  private readonly getChapterKey: () => string;
  private content: HTMLElement | null = null;
  private viewport: HTMLDivElement | null = null;
  private indicator: HTMLDivElement | null = null;
  private bodyObserver: MutationObserver | null = null;
  private domReadyHandler: (() => void) | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private mutationTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private progressVisible = true;
  private pageIndex = 0;
  private pageCount = 1;
  private pageStride = 0;
  private positionRatio = 0;
  private chapterKey = '';
  private openAtEnd = false;
  private lastNotification = '';

  constructor(options: FanqiePaginatorOptions = {}) {
    this.onPositionChange = options.onPositionChange;
    this.onChapterChange = options.onChapterChange;
    this.getChapterKey = options.getChapterKey ?? (() => location.pathname + location.search);
  }

  isActive(): boolean {
    return this.enabled && document.body?.classList.contains(FANQIE_PAGED_CLASS) === true;
  }

  isAtLastPage(): boolean {
    return this.pageIndex >= this.pageCount - 1;
  }

  getPositionRatio(): number {
    return this.positionRatio;
  }

  /*!
   * @capability progressTracker
   * [功能能力 6/6：进度追踪]
   * 开启时创建底部“当前页 / 总页数”；关闭时移除页码，并触发重排回收 48px。
   */
  setProgressVisible(visible: boolean): void {
    if (visible === this.progressVisible) return;
    this.progressVisible = visible;
    if (visible && this.enabled && document.body) {
      this.ensureIndicator();
      this.updateIndicator();
    } else if (!visible) {
      this.indicator?.remove();
      this.indicator = null;
    }
    if (this.enabled) this.scheduleLayout();
  }

  enable(openAtEnd = false): void {
    this.openAtEnd ||= openAtEnd;
    if (this.enabled) {
      this.scheduleLayout();
      return;
    }
    this.enabled = true;
    this.initializeDocument();
  }

  disable(): void {
    if (!this.enabled) return;
    const ratio = this.getPositionRatio();
    this.enabled = false;
    this.clearTimers();
    this.bodyObserver?.disconnect();
    this.bodyObserver = null;
    if (this.domReadyHandler) {
      document.removeEventListener('DOMContentLoaded', this.domReadyHandler);
      this.domReadyHandler = null;
    }
    window.removeEventListener('resize', this.handleResize);
    document.body?.classList.remove(
      FANQIE_PAGED_CLASS,
      FANQIE_NO_TRANSITION_CLASS,
    );
    this.resetContent();
    this.indicator?.remove();
    this.indicator = null;
    this.chapterKey = '';
    this.pageIndex = 0;
    this.pageCount = 1;
    this.pageStride = 0;
    this.positionRatio = 0;
    this.lastNotification = '';

    window.requestAnimationFrame(() => {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: ratio * maxScroll, behavior: 'instant' });
    });
  }

  destroy(): void {
    this.disable();
  }

  nextPage(): boolean {
    if (!this.isActive() || !this.content) return false;
    if (this.pageIndex >= this.pageCount - 1) return false;
    this.setPage(this.pageIndex + 1, false);
    return true;
  }

  prevPage(): boolean {
    if (!this.isActive() || !this.content) return false;
    if (this.pageIndex <= 0) return false;
    this.setPage(this.pageIndex - 1, false);
    return true;
  }

  restorePosition(ratio: number): void {
    if (!Number.isFinite(ratio)) return;
    const safeRatio = clamp(ratio, 0, 1);
    const target = Math.round(safeRatio * (this.pageCount - 1));
    this.setPage(target, true);
    this.positionRatio = safeRatio;
  }

  requestOpenAtEnd(): void {
    this.openAtEnd = true;
  }

  private readonly handleResize = (): void => {
    if (!this.enabled) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.layout(false);
    }, 120);
  };

  private initializeDocument(): void {
    if (!document.body) {
      this.domReadyHandler = () => {
        this.domReadyHandler = null;
        this.initializeDocument();
      };
      document.addEventListener('DOMContentLoaded', this.domReadyHandler, { once: true });
      return;
    }

    document.body.classList.add(FANQIE_PAGED_CLASS);
    window.scrollTo({ top: 0, behavior: 'instant' });
    window.addEventListener('resize', this.handleResize);
    if (this.progressVisible) this.ensureIndicator();
    this.bodyObserver = new MutationObserver(() => {
      if (this.mutationTimer) clearTimeout(this.mutationTimer);
      this.mutationTimer = setTimeout(() => {
        this.mutationTimer = null;
        this.refreshContent();
      }, 80);
    });
    this.bodyObserver.observe(document.body, { childList: true, subtree: true });
    this.refreshContent();
  }

  private ensureIndicator(): void {
    if (this.indicator?.isConnected) return;
    this.indicator = document.createElement('div');
    this.indicator.className = 'atreader-fanqie-page-indicator';
    this.indicator.setAttribute('aria-live', 'polite');
    document.body?.append(this.indicator);
  }

  private refreshContent(): void {
    if (!this.enabled) return;
    const nextContent = document.querySelector<HTMLElement>(FANQIE_CONTENT_SELECTOR);
    const nextChapterKey = this.getChapterKey();
    const contentChanged = nextContent !== this.content;
    const chapterChanged = nextChapterKey !== this.chapterKey;

    if (contentChanged) {
      this.resetContent();
      this.bindContent(nextContent);
    }
    if (chapterChanged) {
      this.chapterKey = nextChapterKey;
      this.pageIndex = 0;
      this.positionRatio = 0;
      this.onChapterChange?.(nextChapterKey);
    }
    if (this.content) {
      this.layout(chapterChanged);
    }
  }

  private scheduleLayout(): void {
    window.requestAnimationFrame(() => this.refreshContent());
  }

  private layout(resetPosition: boolean): void {
    const content = this.content;
    const viewport = this.viewport;
    if (!this.enabled || !content?.isConnected || !viewport?.isConnected) return;

    const previousRatio = resetPosition
      ? (this.openAtEnd ? 1 : 0)
      : this.getPositionRatio();
    const top = Math.max(0, viewport.getBoundingClientRect().top);
    // 页码关闭后不保留不可见占位，让正文一直延伸到窗口底部。
    const bottomInset = this.progressVisible ? PROGRESS_INDICATOR_INSET : 0;
    const pageHeight = Math.max(MIN_PAGE_HEIGHT, window.innerHeight - top - bottomInset);
    viewport.style.setProperty('--atreader-page-height', `${Math.round(pageHeight)}px`);
    content.style.setProperty('--atreader-page-offset', '0px');

    const computedGap = Number.parseFloat(window.getComputedStyle(content).columnGap);
    const metrics = calculateSpreadMetrics(
      content.clientWidth,
      content.scrollWidth,
      computedGap,
    );
    this.pageCount = metrics.pageCount;
    this.pageStride = metrics.pageStride;
    const target = this.openAtEnd
      ? this.pageCount - 1
      : Math.round(previousRatio * (this.pageCount - 1));
    this.openAtEnd = false;
    this.setPage(target, true);
    this.positionRatio = clamp(previousRatio, 0, 1);
  }

  private setPage(index: number, instant: boolean): void {
    if (!this.content) return;
    this.pageIndex = clamp(index, 0, this.pageCount - 1);
    this.positionRatio = this.pageCount <= 1
      ? 0
      : this.pageIndex / (this.pageCount - 1);
    if (instant) document.body?.classList.add(FANQIE_NO_TRANSITION_CLASS);
    this.content.style.setProperty(
      '--atreader-page-offset',
      `${-this.pageIndex * this.pageStride}px`,
    );
    this.updateIndicator();
    if (instant) {
      window.requestAnimationFrame(() => {
        document.body?.classList.remove(FANQIE_NO_TRANSITION_CLASS);
      });
    }
  }

  private updateIndicator(): void {
    if (this.indicator) {
      this.indicator.textContent = `${this.pageIndex + 1} / ${this.pageCount}`;
    }
    const notification = `${this.pageIndex}:${this.pageCount}`;
    if (notification !== this.lastNotification) {
      this.lastNotification = notification;
      this.onPositionChange?.(this.pageIndex, this.pageCount);
    }
  }

  private bindContent(content: HTMLElement | null): void {
    const parent = content?.parentNode;
    if (!content || !parent) return;
    const viewport = document.createElement('div');
    viewport.className = 'atreader-fanqie-page-viewport';
    parent.insertBefore(viewport, content);
    viewport.append(content);
    this.viewport = viewport;
    this.content = content;
  }

  private resetContent(): void {
    if (!this.content) return;
    this.content.style.removeProperty('--atreader-page-offset');
    this.viewport?.style.removeProperty('--atreader-page-height');
    if (this.viewport?.parentNode && this.content.parentNode === this.viewport) {
      this.viewport.parentNode.insertBefore(this.content, this.viewport);
    }
    this.viewport?.remove();
    this.viewport = null;
    this.content = null;
  }

  private clearTimers(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.mutationTimer) clearTimeout(this.mutationTimer);
    this.resizeTimer = null;
    this.mutationTimer = null;
  }
}
