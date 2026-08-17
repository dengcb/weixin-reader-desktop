
import { SiteContext } from '../../core/site_context';
import { log } from '../../core/logger';
import { EventBus, Events } from '../../core/event_bus';

export const SWIPE_POLICY = Object.freeze({
  threshold: 50,
  resetDelayMs: 250,
  cooldownMs: 800,
});

export class SwipeHandler {
  private swipeAccumulator = 0;
  private swipeResetTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
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

    // 整页分页均支持横向手势；本地单列同样是分页而不是滚动。
    if (!this.siteContext.isPaginated) return;

    const runtime = this.siteContext.currentRuntime;
    if (!runtime) return;

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
    }, SWIPE_POLICY.resetDelayMs);

    if (this.swipeAccumulator >= SWIPE_POLICY.threshold) {
      log.debug('[SwipeHandler] Swipe left detected, next page');

      // 发送翻页方向事件（向前）
      EventBus.emit(Events.PAGE_TURN_DIRECTION, { direction: 'forward' });

      runtime.nextPage(); // 不再 await，让它在后台执行
      this.swipeAccumulator = 0;
      this.startCooldown();
    } else if (this.swipeAccumulator <= -SWIPE_POLICY.threshold) {
      log.debug('[SwipeHandler] Swipe right detected, prev page');

      // 发送翻页方向事件（向后）
      EventBus.emit(Events.PAGE_TURN_DIRECTION, { direction: 'backward' });

      runtime.prevPage(); // 不再 await，让它在后台执行
      this.swipeAccumulator = 0;
      this.startCooldown();
    }
  }

  private startCooldown() {
    this.swipeCooldown = true;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      this.swipeCooldown = false;
      this.swipeAccumulator = 0;
      this.cooldownTimer = null;
    }, SWIPE_POLICY.cooldownMs);
  }

  public destroy() {
    if (this.swipeResetTimer) {
      clearTimeout(this.swipeResetTimer);
      this.swipeResetTimer = null;
    }
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.swipeCooldown = false;

    // Remove the wheel event listener
    window.removeEventListener('wheel', this.handler, { capture: true });
  }
}
