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
import { injectCSS, removeCSS } from '../core/utils';
import { ScrollState } from '../core/scroll_state';

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

  // Mouse Auto-Hide State
  private mouseHideTimer: number | null = null;
  private isMouseHidden = false;
  private mouseAutoHideInitialized = false;
  private isScrollingOrSwiping = false; // Lock to prevent mouse wake-up during scroll
  private scrollLockTimer: number | null = null;

  // Screen position tracking to filter out synthetic mouse moves (e.g. caused by scrolling)
  private lastScreenX = 0;
  private lastScreenY = 0;

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
    this.initMouseAutoHide(); // Initialize mouse hiding and swipe gestures immediately

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
    // Moved to initMouseAutoHide to avoid duplicate listeners and ensure correct order
    // window.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });
  }

  // ==================== Mouse Auto-Hide ====================

  private initMouseAutoHide() {
    if (this.mouseAutoHideInitialized) return;
    this.mouseAutoHideInitialized = true;

    const resetTimer = () => {
      // 1. Show cursor immediately
      if (this.isMouseHidden) {
        this.showCursor();
      }

      // 2. Clear existing timer
      if (this.mouseHideTimer) {
        window.clearTimeout(this.mouseHideTimer);
        this.mouseHideTimer = null;
      }

      // 3. Only start timer if in Reader Mode
      if (this.isReader) {
        this.mouseHideTimer = window.setTimeout(() => {
          this.hideCursor();
        }, 3000);
      }
    };

    // Use capture phase to ensure we catch all events even if stopped propagation
    // Debounce slightly to avoid excessive processing on mousemove
    // UPDATE: User reported "capture: true" causes mouse to wake up on scroll/swipe
    // Reverting to "capture: false" (Bubble phase) like the Electron version
    // This allows the page/browser to filter out some synthetic events naturally
    let lastMoveTime = 0;
    document.addEventListener('mousemove', (e) => {
        // 1. Ignore if strictly locked (during swipe/scroll)
        if (this.isScrollingOrSwiping) return;

        // 2. Strict check using Screen Coordinates
        // In WebKit (Tauri/Safari), scrolling the page causes synthetic mousemove events
        // because the element under the cursor changes. However, screenX/Y (physical monitor coords)
        // do NOT change unless the physical mouse actually moves.

        // Use a threshold for screen coordinates as well (to prevent trackpad jitter during scroll)
        const diffX = Math.abs(e.screenX - this.lastScreenX);
        const diffY = Math.abs(e.screenY - this.lastScreenY);

        // Increased threshold to 50px to filter out system cursor redraws/drifts during heavy layout changes
        // User reported that 5px was better but still occasionally woke up cursor during auto-flip.
        if (diffX < 50 && diffY < 50) {
            // Physical mouse didn't move enough, ignore this event
            return;
        }

        // Update last known position
        this.lastScreenX = e.screenX;
        this.lastScreenY = e.screenY;

        console.log(`[TurnerManager] Mouse wake-up triggered! diffX=${diffX}, diffY=${diffY}`);

        const now = Date.now();
        if (now - lastMoveTime > 200) { // Throttle mousemove checks (200ms like old version)
            lastMoveTime = now;
            resetTimer();
        }
    }, false);

    document.addEventListener('mousedown', resetTimer, false);
    // REMOVED: document.addEventListener('keydown', resetTimer, false);
    // Rationale: Keyboard interaction (like arrow keys for turning) should NOT wake up the mouse.
    // User explicitly requested to fix "touching keyboard wakes up mouse".

    // Wheel event should NOT wake up the mouse (per user request)
    // It only handles page turning or scrolling logic
    // Use capture: true to ensure we catch it before any content logic stops propagation
    window.addEventListener('wheel', (e) => {
        // Set lock to prevent synthetic mousemove from waking up cursor
        this.setScrollLock();
        this.handleWheel(e);
    }, { passive: false, capture: true });

    // Initial trigger
    resetTimer();
  }

  private setScrollLock() {
    this.isScrollingOrSwiping = true;
    if (this.scrollLockTimer) {
        clearTimeout(this.scrollLockTimer);
    }
    // Release lock after scroll stops (approximate)
    this.scrollLockTimer = window.setTimeout(() => {
        this.isScrollingOrSwiping = false;
    }, 200);
  }

  private hideCursor() {
    if (this.isMouseHidden) return;
    if (!this.isReader) return;

    console.log('[TurnerManager] Hiding cursor (Native + CSS)');

    // 1. Native hide (strongest)
    invoke('set_cursor_visible', { visible: false }).catch(e => console.error(e));

    // 2. CSS hide (backup)
    document.documentElement.classList.add('wxrd-hide-cursor');
    injectCSS('wxrd-cursor-hide', `
      html.wxrd-hide-cursor,
      html.wxrd-hide-cursor * {
        cursor: none !important;
      }
    `);

    // 3. Removed Mask as per user request (too complex/buggy)

    this.isMouseHidden = true;
  }

  private showCursor() {
    if (!this.isMouseHidden) return;

    console.log('[TurnerManager] Showing cursor (Native + CSS)');

    // 1. Native show
    invoke('set_cursor_visible', { visible: true }).catch(e => console.error(e));

    // 2. CSS show
    document.documentElement.classList.remove('wxrd-hide-cursor');
    removeCSS('wxrd-cursor-hide');

    // 3. Removed Mask

    this.isMouseHidden = false;
  }

  private resetMouseState() {
    this.showCursor();
    if (this.mouseHideTimer) {
        window.clearTimeout(this.mouseHideTimer);
        this.mouseHideTimer = null;
    }
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

    // Ignore small movements (jitter)
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
        this.setScrollLock(); // Lock mouse input during page turn
        adapter.nextPage();
        this.countdown = this.intervalSeconds;
      }
    }, 1000);
  }

  private startSingleColumnLogic(adapter: ReadingSiteAdapter) {
    if (this.singleRafId) return;
    if (this.doubleTimer) { clearInterval(this.doubleTimer); this.doubleTimer = null; }

    // Wait for AppManager to finish restoring scroll position
    // This prevents capturing the wrong start position (0) or interfering with restore
    if (!ScrollState.isRestorationComplete()) {
      console.log('[TurnerManager] Waiting for scroll restore...');
      setTimeout(() => this.startSingleColumnLogic(adapter), 200);
      return;
    }

    this.countdown = this.intervalSeconds;
    this.elapsedTime = 0;
    if (!this.originalTitle) this.originalTitle = document.title;

    this.lastFrameTime = performance.now();
    this.lastScrollTime = performance.now();

    // Start RAF loop immediately (No preloading)
    this.singleRafId = requestAnimationFrame((time) => this.singleColumnLoop(time, adapter));
  }

  private singleColumnLoop(time: number, adapter: ReadingSiteAdapter) {
    // Double check active state
    if (!this.isActive) {
        this.singleRafId = null;
        return;
    }

    if (adapter.isDoubleColumn()) {
      this.stopAll();
      this.startDoubleColumnLogic(adapter);
      return;
    }

    let deltaTime = time - this.lastFrameTime;
    this.lastFrameTime = time;

    // Logic from archive: Handle frame jumps
    if (deltaTime > 100) {
      deltaTime = 16;
      this.accumulatedMove = 0;
    } else if (deltaTime > 50) {
      deltaTime = 50;
    }

    this.elapsedTime += deltaTime;
    if (this.elapsedTime >= 1000) {
      // Single column mode: Show percentage
      const scrollY = window.scrollY;
      const totalHeight = document.documentElement.scrollHeight;
      const viewportHeight = window.innerHeight;
      const maxScroll = Math.max(1, totalHeight - viewportHeight);
      const percentage = Math.min(100, Math.max(0, Math.round((scrollY / maxScroll) * 1000) / 10));

      this.elapsedTime -= 1000;
      document.title = `${this.appName} - 自动翻页 - 已读 ${percentage}%`;
    }

    if (document.hidden && !this.keepAwake) {
      this.singleRafId = requestAnimationFrame((t) => this.singleColumnLoop(t, adapter));
      return;
    }

    // Throttle scroll updates to ~30fps to reduce CPU/layout thrashing
    // But keep calculation high precision
    const timeSinceLastScroll = time - this.lastScrollTime;
    if (timeSinceLastScroll < 30) {
      this.singleRafId = requestAnimationFrame((t) => this.singleColumnLoop(t, adapter));
      return;
    }
    this.lastScrollTime = time;

    const screenHeight = window.innerHeight;
    const validInterval = this.intervalSeconds > 0 ? this.intervalSeconds : 30;
    const speed = screenHeight / (validInterval * 1000);
    const move = speed * timeSinceLastScroll;

    this.accumulatedMove += move;
    if (this.accumulatedMove >= 1) {
      this.isScrollingOrSwiping = true; // Lock mouse input during auto-scroll
      const pixelsToScroll = Math.floor(this.accumulatedMove);
      window.scrollBy(0, pixelsToScroll);
      this.accumulatedMove -= pixelsToScroll;

      const isAtBottom = adapter.isAtBottom();
      if (isAtBottom && !this.bottomTriggered) {
        console.log('[TurnerManager] Reached bottom, triggering next page');
        this.bottomTriggered = true;

        // Trigger next page
        adapter.nextPage();
        if (typeof (adapter as any).clickNextChapter === 'function') {
           (adapter as any).clickNextChapter();
        }

        // Stop current loop
        if (this.singleRafId) {
            cancelAnimationFrame(this.singleRafId);
            this.singleRafId = null;
        }

        // Wait 10s then restart
        console.log('[TurnerManager] Waiting 10s before resuming...');
        setTimeout(() => {
            this.bottomTriggered = false;
            // Only restart if still active
            if (this.isActive) {
                this.startSingleColumnLogic(adapter);
            }
        }, 10000);
        return;
      } else if (!isAtBottom) {
        this.bottomTriggered = false;
      }
    }

    this.singleRafId = requestAnimationFrame((t) => this.singleColumnLoop(t, adapter));
  }
}
