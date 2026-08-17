/**
 * App Manager - Application initialization and startup logic
 *
 * Responsibilities:
 * - Get app name from Tauri
 * - Restore last reader page on startup (if enabled)
 * - Clear autoFlip.active on app exit
 *
 * Note: Route monitoring is now handled by IPCManager
 */

import { waitForTauri, logToFile } from '../core/tauri';
import { settingsStore } from '../core/settings_store';
import { createSiteContext, SiteContext } from '../core/site_context';
import { ScrollState } from '../core/scroll_state';
import { log } from '../core/logger';
import { getReadingPosition } from '../core/reading_position';

// Session storage key to track if we've already restored in this session
const RESTORE_FLAG_KEY = 'wxrd_has_restored';

export const SCROLL_RESTORE_POLICY = Object.freeze({
  maxStalledAttempts: 50,
  retryDelayMs: 100,
  initialDelayMs: 500,
});

export type ScrollRestoreStep =
  | { kind: 'restore'; top: number }
  | { kind: 'chase'; top: number }
  | { kind: 'give-up'; top: number };

export const determineScrollRestoreStep = (
  currentHeight: number,
  viewportHeight: number,
  targetScroll: number,
  stalledAttempts: number,
): ScrollRestoreStep => {
  if (currentHeight >= targetScroll + viewportHeight) {
    return { kind: 'restore', top: targetScroll };
  }
  if (stalledAttempts < SCROLL_RESTORE_POLICY.maxStalledAttempts) {
    return { kind: 'chase', top: currentHeight };
  }
  return { kind: 'give-up', top: targetScroll };
};

export class AppManager {
  private siteContext: SiteContext;

  // Store references for cleanup
  private pagehideHandler: (() => void) | null = null;
  private visibilitychangeHandler: (() => void) | null = null;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly initAbortController = new AbortController();
  private destroyed = false;

  constructor() {
    this.siteContext = createSiteContext();
    this.init();
  }

  private async init() {
    await waitForTauri(this.initAbortController.signal);
    if (this.destroyed) return;

    // Initialize Settings Store (if not already)
    await settingsStore.init();
    if (this.destroyed) return;

    // Set up pagehide handler to clear autoFlip on exit
    // pagehide is more reliable than beforeunload for app exit
    this.pagehideHandler = () => {
      this.clearAutoFlipOnExit();
    };

    this.visibilitychangeHandler = () => {
      if (document.visibilityState === 'hidden') {
        this.clearAutoFlipOnExit();
      }
    };

    window.addEventListener('pagehide', this.pagehideHandler);
    document.addEventListener('visibilitychange', this.visibilitychangeHandler);

    // Restore last page only on app startup (first time init)
    await this.restoreLastPage();
    if (this.destroyed) return;

    // Restore scroll position if on reader page
    await this.restoreScrollPosition();
  }

  private clearAutoFlipOnExit() {
    const settings = settingsStore.get();
    if (settings.autoFlip?.active) {
      log.debug('[AppManager] Clearing autoFlip.active on exit');
      logToFile('[AppManager] Clearing autoFlip.active on exit');
      // Sync save to backend immediately using settingsStore to ensure correct structure
      settingsStore.update({
        autoFlip: {
          active: false,
          interval: settings.autoFlip.interval || 15,
          keepAwake: settings.autoFlip.keepAwake !== false
        }
      });
    }
  }

  private async restoreLastPage() {
    // Check if we've already restored in this session
    const sessionFlag = sessionStorage.getItem(RESTORE_FLAG_KEY);

    if (sessionFlag === 'true') {
      return;
    }

    const settings = settingsStore.get();
    const isReader = this.siteContext.isReaderPage;

    if (!isReader && settings.lastPage && settings.lastReaderUrl) {
      const navMsg = `[AppManager] Restoring last page: ${settings.lastReaderUrl}`;
      logToFile(navMsg);
      log.debug('[AppManager] Restoring last page:', settings.lastReaderUrl);
      sessionStorage.setItem(RESTORE_FLAG_KEY, 'true');
      // Direct navigation (most reliable)
      window.location.href = settings.lastReaderUrl;
    } else {
      // Mark as restored even if we didn't navigate
      sessionStorage.setItem(RESTORE_FLAG_KEY, 'true');
    }
  }

  private async restoreScrollPosition() {
    // Check if we've already restored scroll in this session (memory only)
    if (ScrollState.isRestorationComplete()) {
      return;
    }

    const settings = settingsStore.get();
    const isReader = this.siteContext.isReaderPage;

    // Only restore if on reader page and has saved scroll position
    const currentUrl = window.location.href;
    let targetScroll: number | null | undefined;
    try {
      targetScroll = await getReadingPosition(this.siteContext.siteId, currentUrl);
    } catch (error) {
      log.warn('[AppManager] Failed to read URL-specific position, using legacy value', error);
    }
    if (this.destroyed) return;
    targetScroll ??= settings.scrollPosition;

    if (!isReader || !settings.lastPage || targetScroll === undefined || targetScroll === null) {
      ScrollState.markRestorationComplete();
      return;
    }

    // Paginated runtimes persist a structural location and must not receive scroll restoration.
    if (this.siteContext.isPaginated) {
      ScrollState.markRestorationComplete();
      return;
    }

    // Wait a bit for page to fully load before scrolling
    log.debug('[AppManager] Planning to restore scroll position:', targetScroll, 'for URL:', currentUrl);
    logToFile(`[AppManager] Planning to restore scroll position: ${targetScroll} for URL: ${currentUrl}`);

    // Chase Mode: Aggressively scroll to bottom to trigger lazy loading until we reach target
    let attempts = 0;
    let lastHeight = 0;

    const chaseScroll = () => {
      if (this.destroyed) return;
      try {
        const currentHeight = document.documentElement.scrollHeight;
        const viewportHeight = window.innerHeight;

        // Check for growth/progress
        if (currentHeight > lastHeight) {
           attempts = 0; // Reset attempts if we are making progress
           lastHeight = currentHeight;
        } else {
           attempts++;
        }

        const step = determineScrollRestoreStep(
          currentHeight,
          viewportHeight,
          targetScroll,
          attempts,
        );

        // Case 1: Page is long enough, just go to target
        if (step.kind === 'restore') {
          log.debug(`[AppManager] Height sufficient (${currentHeight} >= ${targetScroll + viewportHeight}), restoring to ${targetScroll}`);
          window.scrollTo({ top: step.top, behavior: 'instant' });
          // Mark restore as complete so IPCManager can start saving
          ScrollState.markRestorationComplete();
          return;
        }

        // Case 2: Page is too short, scroll to bottom to trigger load
        if (step.kind === 'chase') {
          // Scroll to bottom
          window.scrollTo({ top: step.top, behavior: 'instant' });

          // Dispatch fake user events to trigger lazy loading
          document.dispatchEvent(new Event('scroll'));
          try {
              document.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
          } catch(e) {}

          // Check again quickly
          this.restoreTimer = setTimeout(chaseScroll, SCROLL_RESTORE_POLICY.retryDelayMs);
        } else {
          log.debug('[AppManager] Max restore attempts reached (stuck), giving up.');
          window.scrollTo({ top: step.top, behavior: 'instant' }); // Try one last time
          ScrollState.markRestorationComplete();
        }
      } catch (e) {
        log.error('[AppManager] Error during scroll restoration:', e);
        // Ensure we mark complete even on error
        ScrollState.markRestorationComplete();
      }
    };

    // Start the chase after initial load
    this.restoreTimer = setTimeout(chaseScroll, SCROLL_RESTORE_POLICY.initialDelayMs);
  }

  public destroy() {
    if (this.destroyed) return;
    // AppRuntime 的 pagehide 监听器可能先执行并移除本 Manager 的监听器；
    // 销毁入口本身也必须保持“离开页面即关闭自动翻页”的既有语义。
    this.clearAutoFlipOnExit();
    this.destroyed = true;
    this.initAbortController.abort();
    // Remove event listeners
    if (this.pagehideHandler) {
      window.removeEventListener('pagehide', this.pagehideHandler);
      this.pagehideHandler = null;
    }
    if (this.visibilitychangeHandler) {
      document.removeEventListener('visibilitychange', this.visibilitychangeHandler);
      this.visibilitychangeHandler = null;
    }
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
  }
}
