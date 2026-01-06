
import { SiteContext } from '../../core/site_context';
import { log } from '../../core/logger';
import { EventBus, Events } from '../../core/event_bus';

export class SwipeHandler {
  private swipeAccumulator = 0;
  private swipeResetTimer: ReturnType<typeof setTimeout> | null = null;
  private swipeCooldown = false;
  private siteContext: SiteContext;
  private onScrollLock: (duration?: number) => void;

  private handler: (e: WheelEvent) => void;

  constructor(siteContext: SiteContext, onScrollLock: (duration?: number) => void) {
    this.siteContext = siteContext;
    this.onScrollLock = onScrollLock;
    this.handler = (e: WheelEvent) => {
        // Set lock to prevent synthetic mousemove from waking up cursor
        this.onScrollLock();
        this.handleWheel(e);
    };
    this.init();
  }

  private init() {
    window.addEventListener('wheel', this.handler, { passive: false, capture: true });
  }

  private handleWheel(e: WheelEvent) {
    if (!this.siteContext.isReaderPage) return;

    // 仅在双栏模式下启用滚轮翻页
    if (!this.siteContext.isDoubleColumn) return;

    const adapter = this.siteContext.currentAdapter;
    if (!adapter) return;

    const deltaX = e.deltaX;
    const deltaY = e.deltaY;
    const isHorizontal = Math.abs(deltaX) > Math.abs(deltaY);

    if (isHorizontal) {
      e.preventDefault();
    } else {
      return;
    }

    if (this.swipeCooldown) return;
    if (Math.abs(deltaX) < 2) return;

    this.swipeAccumulator += deltaX;

    if (this.swipeResetTimer) {
      clearTimeout(this.swipeResetTimer);
    }
    this.swipeResetTimer = setTimeout(() => {
      this.swipeAccumulator = 0;
    }, 250);

    const THRESHOLD = 50;
    if (this.swipeAccumulator >= THRESHOLD) {
      log.debug('[SwipeHandler] Swipe left detected, next page');

      // 发送翻页方向事件（向前）
      EventBus.emit(Events.PAGE_TURN_DIRECTION, { direction: 'forward' });

      adapter.nextPage(); // 不再 await，让它在后台执行
      this.swipeAccumulator = 0;
      this.startCooldown();
    } else if (this.swipeAccumulator <= -THRESHOLD) {
      log.debug('[SwipeHandler] Swipe right detected, prev page');

      // 发送翻页方向事件（向后）
      EventBus.emit(Events.PAGE_TURN_DIRECTION, { direction: 'backward' });

      adapter.prevPage(); // 不再 await，让它在后台执行
      this.swipeAccumulator = 0;
      this.startCooldown();
    }
  }

  private startCooldown() {
    this.swipeCooldown = true;
    setTimeout(() => {
      this.swipeCooldown = false;
      this.swipeAccumulator = 0;
    }, 800);
  }

  public destroy() {
    if (this.swipeResetTimer) {
      clearTimeout(this.swipeResetTimer);
      this.swipeResetTimer = null;
    }

    // Remove the wheel event listener
    window.removeEventListener('wheel', this.handler, { capture: true });
  }
}
