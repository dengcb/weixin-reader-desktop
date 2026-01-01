
import { getSiteRegistry } from '../../core/site_registry';

export class SwipeHandler {
  private swipeAccumulator = 0;
  private swipeResetTimer: ReturnType<typeof setTimeout> | null = null;
  private swipeCooldown = false;
  private siteRegistry = getSiteRegistry();
  private onScrollLock: (duration?: number) => void;

  constructor(onScrollLock: (duration?: number) => void) {
    this.onScrollLock = onScrollLock;
    this.init();
  }

  private init() {
    window.addEventListener('wheel', (e) => {
        // Set lock to prevent synthetic mousemove from waking up cursor
        this.onScrollLock();
        this.handleWheel(e);
    }, { passive: false, capture: true });
  }

  private handleWheel(e: WheelEvent) {
    if (!this.siteRegistry.isReaderPage()) return;

    const adapter = this.siteRegistry.getCurrentAdapter();
    if (!adapter || !adapter.isDoubleColumn()) return;

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
      console.log('[SwipeHandler] Swipe left detected, next page');
      adapter.nextPage();
      this.swipeAccumulator = 0;
      this.startCooldown();
    } else if (this.swipeAccumulator <= -THRESHOLD) {
      console.log('[SwipeHandler] Swipe right detected, prev page');
      adapter.prevPage();
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
}
