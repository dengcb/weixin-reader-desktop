/**
 * Turner Manager - Manages page turning functionality
 *
 * Responsibilities:
 * - Auto page turning for single-column mode (smooth scrolling)
 * - Auto page turning for double-column mode (interval-based)
 * - Countdown display in title
 * - Mac trackpad two-finger horizontal swipe for page turning
 *
 * Listens to:
 * - 'ipc:route-changed' - Stop auto-flip when leaving reader page
 * - Settings store changes - Start/stop based on autoFlip setting
 * - 'wheel' event - Detect horizontal swipe gestures for page turning
 */

import { invoke } from '../core/tauri';
import { settingsStore, AppSettings } from '../core/settings_store';
import { getSiteRegistry } from '../core/site_registry';
import { ReadingSiteAdapter } from '../adapters/reading_site_adapter';
import { PageScroller } from '../utils/page_scroller';

type RouteChangedEvent = {
  isReader: boolean;
  url: string;
  pathname: string;
};

export class TurnerManager {
  // Auto Flip State
  private isActive = false;
  private intervalSeconds = 30;
  private keepAwake = false;
  private doubleTimer: ReturnType<typeof setInterval> | null = null;
  private singleRafId: number | null = null;
  private lastFrameTime = 0;
  private lastScrollTime = 0; // Throttle control
  private accumulatedMove = 0;
  private countdown = 30;
  private originalTitle: string | null = null;
  private appName: string = "微信阅读";
  private elapsedTime = 0;
  private siteRegistry = getSiteRegistry();
  private isProcessingUpdate = false;  // Prevent race conditions

  // Swipe Gesture State (Mac trackpad two-finger horizontal swipe)
  private swipeAccumulator = 0;
  private swipeThreshold = 120;
  private swipeResetTimer: ReturnType<typeof setTimeout> | null = null;
  private swipeCooldown = false;
  private isReader = false;

  // Bottom detection state (prevent multiple triggers)
  private bottomTriggered = false;

  constructor() {
    this.init();
  }

  private async init() {
    try {
      this.appName = await invoke<string>('get_app_name') || "微信阅读";
    } catch (e) {
      console.error("TurnerManager: Failed to get app name", e);
    }

    this.isReader = this.siteRegistry.isReaderPage();
    this.initSwipeGesture();

    settingsStore.subscribe((settings) => {
      this.updateState(settings);
    });

    window.addEventListener('ipc:route-changed', ((e: CustomEvent<RouteChangedEvent>) => {
      const isReader = e.detail.isReader;
      this.isReader = isReader;
      console.log('[TurnerManager] Route changed:', { isReader, isActive: this.isActive });
      if (!isReader) {
        if (this.isActive) {
          console.log('[TurnerManager] Stopping auto flip and clearing setting');
          this.stopAll();
          const currentSettings = settingsStore.get();
          if (currentSettings.autoFlip?.active) {
            settingsStore.update({
              autoFlip: { ...currentSettings.autoFlip, active: false }
            });
          }
        }
      }
    }) as EventListener);
  }

  // ==================== Swipe Gesture (Mac Trackpad) ====================

  private initSwipeGesture() {
    window.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });
  }

  private handleWheel(e: WheelEvent) {
    if (!this.isReader) return;

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

    // if (Math.abs(deltaX) < 5) return;
    if (this.swipeCooldown) return;

    this.swipeAccumulator += deltaX;

    if (this.swipeResetTimer) {
      clearTimeout(this.swipeResetTimer);
    }
    this.swipeResetTimer = setTimeout(() => {
      this.swipeAccumulator = 0;
    }, 250);

    const THRESHOLD = 50;
    if (this.swipeAccumulator >= THRESHOLD) {
      console.log('[TurnerManager] Swipe left detected, next page');
      adapter.nextPage();
      this.swipeAccumulator = 0;
      this.startCooldown();
    } else if (this.swipeAccumulator <= -THRESHOLD) {
      console.log('[TurnerManager] Swipe right detected, prev page');
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

  private updateState(settings: AppSettings) {
    const autoFlip = settings.autoFlip || { active: false, interval: 15, keepAwake: true };
    const newActive = !!autoFlip.active;

    if (newActive && this.isProcessingUpdate) {
      return;
    }

    const newInterval = autoFlip.interval > 0 ? autoFlip.interval : 15;
    const newKeepAwake = !!autoFlip.keepAwake;

    console.log('[TurnerManager] updateState:', { newActive, newInterval, isActive: this.isActive });

    if (!newActive) {
      if (this.isActive) {
        this.isProcessingUpdate = true;
        this.stopAll();
        this.isActive = false;
        this.isProcessingUpdate = false;
      }
    } else {
      if (!this.isActive) {
        this.isProcessingUpdate = true;
        this.isActive = true;
        this.intervalSeconds = newInterval;
        this.keepAwake = newKeepAwake;
        this.start();
        setTimeout(() => { this.isProcessingUpdate = false; }, 100);
      } else if (this.intervalSeconds !== newInterval || this.keepAwake !== newKeepAwake) {
        this.isProcessingUpdate = true;
        this.stopAll();
        this.intervalSeconds = newInterval;
        this.keepAwake = newKeepAwake;
        this.isActive = true;
        this.start();
        setTimeout(() => { this.isProcessingUpdate = false; }, 100);
      }
    }
  }

  private start() {
    const adapter = this.siteRegistry.getCurrentAdapter();
    if (!adapter) {
      console.warn('[TurnerManager] No adapter found');
      return;
    }

    if (adapter.isDoubleColumn()) {
      this.startDoubleColumnLogic(adapter);
    } else {
      this.startSingleColumnLogic(adapter);
    }
  }

  private stopAll() {
    this.isActive = false;
    if (this.doubleTimer) { clearInterval(this.doubleTimer); this.doubleTimer = null; }
    if (this.singleRafId) { cancelAnimationFrame(this.singleRafId); this.singleRafId = null; }
    if (this.originalTitle) { document.title = this.originalTitle; this.originalTitle = null; }
    this.elapsedTime = 0;
  }

  private startDoubleColumnLogic(adapter: ReadingSiteAdapter) {
    if (this.doubleTimer) return;
    if (this.singleRafId) { cancelAnimationFrame(this.singleRafId); this.singleRafId = null; }

    this.countdown = this.intervalSeconds;
    if (!this.originalTitle) this.originalTitle = document.title;

    this.doubleTimer = setInterval(() => {
      if (!adapter.isDoubleColumn()) {
        this.stopAll();
        this.startSingleColumnLogic(adapter);
        return;
      }
      if (document.hidden && !this.keepAwake) return;

      this.countdown--;
      document.title = `${this.appName} - 自动翻页 - ${this.countdown} 秒`;

      if (this.countdown <= 0) {
        adapter.nextPage();
        this.countdown = this.intervalSeconds;
      }
    }, 1000);
  }

  private startSingleColumnLogic(adapter: ReadingSiteAdapter) {
    if (this.singleRafId) return;
    if (this.doubleTimer) { clearInterval(this.doubleTimer); this.doubleTimer = null; }

    this.countdown = this.intervalSeconds;
    this.elapsedTime = 0;
    if (!this.originalTitle) this.originalTitle = document.title;

    this.lastFrameTime = performance.now();
    this.lastScrollTime = performance.now();

    // 启动前先执行一次“暴力追赶”，强制加载全章内容
    PageScroller.preloadChapter().catch(console.error).then(() => {
      if (!this.isActive) {
        console.log('[TurnerManager] Preload finished but stopped, aborting RAF');
        return;
      }
      console.log('[TurnerManager] Preload complete, starting RAF loop');

      const loop = (time: number) => {
        if (adapter.isDoubleColumn()) {
          this.stopAll();
          this.startDoubleColumnLogic(adapter);
          return;
        }
        if (!this.isActive) {
          this.singleRafId = null;
          return;
        }

        let deltaTime = time - this.lastFrameTime;
        this.lastFrameTime = time;

        if (deltaTime > 1000) {
          deltaTime = 16;
          this.accumulatedMove = 0;
        } else if (deltaTime > 100) {
          deltaTime = Math.min(deltaTime, 50);
        }

        this.elapsedTime += deltaTime;
        if (this.elapsedTime >= 1000) {
          this.countdown--;
          this.elapsedTime -= 1000;
          document.title = `${this.appName} - 自动翻页 - ${this.countdown} 秒`;
        }

        if (document.hidden && !this.keepAwake) {
          this.singleRafId = requestAnimationFrame(loop);
          return;
        }

        // 降频增幅策略
        const timeSinceLastScroll = time - this.lastScrollTime;
        if (timeSinceLastScroll < 30) {
          this.singleRafId = requestAnimationFrame(loop);
          return;
        }
        this.lastScrollTime = time;

        const screenHeight = window.innerHeight;
        const validInterval = this.intervalSeconds > 0 ? this.intervalSeconds : 30;
        const speed = screenHeight / (validInterval * 1000);
        const move = speed * timeSinceLastScroll;

        this.accumulatedMove += move;
        if (this.accumulatedMove >= 1) {
          const pixelsToScroll = Math.floor(this.accumulatedMove);
          window.scrollBy(0, pixelsToScroll);
          this.accumulatedMove -= pixelsToScroll;

          const isAtBottom = adapter.isAtBottom();
          if (isAtBottom && !this.bottomTriggered) {
            console.log('[TurnerManager] Reached bottom, triggering next page');
            this.bottomTriggered = true;
            adapter.nextPage();
            if (typeof (adapter as any).clickNextChapter === 'function') {
               (adapter as any).clickNextChapter();
            }
            this.countdown = this.intervalSeconds;

            // 翻页后检测新内容
            PageScroller.waitForNewContent(() => {
              // 发现新内容，执行追赶
              PageScroller.preloadChapter().catch(console.error);
            });

            // 强制重置锁（1.2s后），防止死锁或连续触发
            setTimeout(() => {
              this.bottomTriggered = false;
            }, 1200);
          } else if (!isAtBottom) {
            this.bottomTriggered = false;
          }
        }
        this.singleRafId = requestAnimationFrame(loop);
      };

      this.singleRafId = requestAnimationFrame(loop);
    });
  }
}
