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

import { invoke, waitForTauri, logToFile } from '../core/tauri';
import { settingsStore } from '../core/settings_store';
import { createSiteContext, SiteContext } from '../core/site_context';
import { ScrollState } from '../core/scroll_state';
import { log } from '../core/logger';

// Session storage key to track if we've already restored in this session
const RESTORE_FLAG_KEY = 'wxrd_has_restored';
const SCROLL_RESTORED_KEY = 'wxrd_scroll_restored';

export class AppManager {
  private appName: string = "微信阅读";
  private siteContext: SiteContext;

  // Store references for cleanup
  private pagehideHandler: (() => void) | null = null;
  private visibilitychangeHandler: (() => void) | null = null;

  constructor() {
    this.siteContext = createSiteContext();
    this.init();
  }

  private async init() {
    await waitForTauri();

    try {
      this.appName = await invoke<string>('get_app_name') || "微信阅读";
    } catch (e) {
      log.error("Failed to get app name:", e);
    }

    // Initialize Settings Store (if not already)
    await settingsStore.init();

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

    // Restore scroll position if on reader page
    this.restoreScrollPosition();
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

  private restoreScrollPosition() {
    // Check if we've already restored scroll in this session (memory only)
    if (ScrollState.isRestorationComplete()) {
      return;
    }

    const settings = settingsStore.get();
    const isReader = this.siteContext.isReaderPage;

    // Only restore if on reader page and has saved scroll position
    const currentUrl = window.location.href;
    const progressMap = settings.readingProgress || {};
    const targetScroll = progressMap[currentUrl] ?? settings.scrollPosition;

    if (!isReader || !settings.lastPage || targetScroll === undefined || targetScroll === null) {
      ScrollState.markRestorationComplete();
      return;
    }

    // Check if in single-column mode
    if (this.siteContext.isDoubleColumn) {
      ScrollState.markRestorationComplete();
      return;
    }

    // Wait a bit for page to fully load before scrolling
    log.debug('[AppManager] Planning to restore scroll position:', targetScroll, 'for URL:', currentUrl);
    logToFile(`[AppManager] Planning to restore scroll position: ${targetScroll} for URL: ${currentUrl}`);

    // Chase Mode: Aggressively scroll to bottom to trigger lazy loading until we reach target
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds of *no progress* timeout
    let lastHeight = 0;

    const chaseScroll = () => {
      try {
        const currentHeight = document.documentElement.scrollHeight;
        const viewportHeight = window.innerHeight;
        // 需要的最小高度：目标位置 + 视口高度（这样滚动后目标位置才能在屏幕顶部）
        const requiredHeight = targetScroll + viewportHeight;

        // Check for growth/progress
        if (currentHeight > lastHeight) {
           attempts = 0; // Reset attempts if we are making progress
           lastHeight = currentHeight;
        } else {
           attempts++;
        }

        // Case 1: Page is long enough, just go to target
        if (currentHeight >= requiredHeight) {
          log.debug(`[AppManager] Height sufficient (${currentHeight} >= ${requiredHeight}), restoring to ${targetScroll}`);
          window.scrollTo({ top: targetScroll, behavior: 'instant' });
          // Mark restore as complete so IPCManager can start saving
          ScrollState.markRestorationComplete();
          return;
        }

        // Case 2: Page is too short, scroll to bottom to trigger load
        if (attempts < maxAttempts) {
          // Scroll to bottom
          window.scrollTo({ top: currentHeight, behavior: 'instant' });

          // Dispatch fake user events to trigger lazy loading
          document.dispatchEvent(new Event('scroll'));
          try {
              document.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
          } catch(e) {}

          // Check again quickly
          setTimeout(chaseScroll, 100);
        } else {
          log.debug('[AppManager] Max restore attempts reached (stuck), giving up.');
          window.scrollTo({ top: targetScroll, behavior: 'instant' }); // Try one last time
          ScrollState.markRestorationComplete();
        }
      } catch (e) {
        log.error('[AppManager] Error during scroll restoration:', e);
        // Ensure we mark complete even on error
        ScrollState.markRestorationComplete();
      }
    };

    // Start the chase after initial load
    setTimeout(chaseScroll, 500);
  }

  public destroy() {
    // Remove event listeners
    if (this.pagehideHandler) {
      window.removeEventListener('pagehide', this.pagehideHandler);
      this.pagehideHandler = null;
    }
    if (this.visibilitychangeHandler) {
      document.removeEventListener('visibilitychange', this.visibilitychangeHandler);
      this.visibilitychangeHandler = null;
    }
  }
}
