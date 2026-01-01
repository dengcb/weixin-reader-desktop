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
import { getSiteRegistry } from '../core/site_registry';
import { ScrollState } from '../core/scroll_state';

// Session storage key to track if we've already restored in this session
const RESTORE_FLAG_KEY = 'wxrd_has_restored';
const SCROLL_RESTORED_KEY = 'wxrd_scroll_restored';

export class AppManager {
  private appName: string = "微信阅读";
  private siteRegistry = getSiteRegistry();

  constructor() {
    this.init();
  }

  private async init() {
    await waitForTauri();

    try {
      this.appName = await invoke<string>('get_app_name') || "微信阅读";
    } catch (e) {
      console.error("Failed to get app name:", e);
    }

    // Initialize Settings Store (if not already)
    await settingsStore.init();

    // Set up pagehide handler to clear autoFlip on exit
    // pagehide is more reliable than beforeunload for app exit
    window.addEventListener('pagehide', () => {
      this.clearAutoFlipOnExit();
    });

    // Also listen for visibility change as backup
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.clearAutoFlipOnExit();
      }
    });

    // DEBUG: Verify settings loaded from backend
    try {
      const backendSettings = await invoke<any>('get_settings');
      console.log('[AppManager] Backend settings:', JSON.stringify(backendSettings));
    } catch (e) {
      console.error('[AppManager] Failed to get backend settings:', e);
    }

    // Restore last page only on app startup (first time init)
    await this.restoreLastPage();

    // Restore scroll position if on reader page
    this.restoreScrollPosition();
  }

  private clearAutoFlipOnExit() {
    const settings = settingsStore.get();
    if (settings.autoFlip?.active) {
      console.log('[AppManager] Clearing autoFlip.active on exit');
      logToFile('[AppManager] Clearing autoFlip.active on exit');
      // Sync save to backend immediately
      invoke('save_settings', {
        settings: {
          autoFlip: {
            active: false,
            interval: settings.autoFlip.interval || 15,
            keepAwake: settings.autoFlip.keepAwake !== false
          }
        }
      });
    }
  }

  private async restoreLastPage() {
    // Check if we've already restored in this session
    const sessionFlag = sessionStorage.getItem(RESTORE_FLAG_KEY);
    logToFile(`[AppManager] Session flag: ${sessionFlag}`);

    if (sessionFlag === 'true') {
      logToFile('[AppManager] Already restored in this session, skipping');
      console.log('[AppManager] Already restored in this session, skipping');
      return;
    }

    const settings = settingsStore.get();
    const isReader = this.siteRegistry.isReaderPage();

    const logMsg = `[AppManager] restoreLastPage check: isReader=${isReader}, lastPage=${settings.lastPage}, lastReaderUrl=${settings.lastReaderUrl}`;
    logToFile(logMsg);
    console.log('[AppManager] restoreLastPage check:', {
      isReader,
      lastPage: settings.lastPage,
      lastReaderUrl: settings.lastReaderUrl
    });

    if (!isReader && settings.lastPage && settings.lastReaderUrl) {
      const navMsg = `[AppManager] Restoring last page: ${settings.lastReaderUrl}`;
      logToFile(navMsg);
      console.log('[AppManager] Restoring last page:', settings.lastReaderUrl);
      sessionStorage.setItem(RESTORE_FLAG_KEY, 'true');
      // Direct navigation (most reliable)
      window.location.href = settings.lastReaderUrl;
    } else {
      // Mark as restored even if we didn't navigate
      const skipMsg = `[AppManager] Marking as restored (no navigation needed): isReader=${isReader}, lastPage=${settings.lastPage}, hasUrl=${!!settings.lastReaderUrl}`;
      logToFile(skipMsg);
      console.log('[AppManager] Marking as restored (no navigation needed)');
      sessionStorage.setItem(RESTORE_FLAG_KEY, 'true');
    }
  }

  private restoreScrollPosition() {
    // Check if we've already restored scroll in this session (memory only)
    if (ScrollState.isRestorationComplete()) {
      console.log('[AppManager] Scroll already restored in this session, skipping');
      return;
    }

    const settings = settingsStore.get();
    const isReader = this.siteRegistry.isReaderPage();

    // Only restore if on reader page and has saved scroll position
    if (!isReader || !settings.lastPage || !settings.scrollPosition) {
      ScrollState.markRestorationComplete();
      return;
    }

    // Check if in single-column mode
    const adapter = this.siteRegistry.getCurrentAdapter();
    if (!adapter || adapter.isDoubleColumn()) {
      ScrollState.markRestorationComplete();
      return;
    }

    // Wait a bit for page to fully load before scrolling
    const targetScroll = settings.scrollPosition!;
    console.log('[AppManager] Planning to restore scroll position:', targetScroll);
    logToFile(`[AppManager] Planning to restore scroll position: ${targetScroll}`);

    // Chase Mode: Aggressively scroll to bottom to trigger lazy loading until we reach target
    let attempts = 0;
    const maxAttempts = 50; // Prevent infinite loops (e.g. 5 seconds at 100ms)

    const chaseScroll = () => {
      attempts++;
      const currentHeight = document.documentElement.scrollHeight;
      const viewportHeight = window.innerHeight;
      // 需要的最小高度：目标位置 + 视口高度（这样滚动后目标位置才能在屏幕顶部）
      const requiredHeight = targetScroll + viewportHeight;

      // Case 1: Page is long enough, just go to target
      if (currentHeight >= requiredHeight) {
        console.log(`[AppManager] Height sufficient (${currentHeight} >= ${requiredHeight}), restoring to ${targetScroll}`);
        window.scrollTo({ top: targetScroll, behavior: 'instant' });
        // Mark restore as complete so IPCManager can start saving
        ScrollState.markRestorationComplete();
        return;
      }

      // Case 2: Page is too short, scroll to bottom to trigger load
      if (attempts < maxAttempts) {
        console.log(`[AppManager] Chasing scroll: height ${currentHeight} < target ${targetScroll}, scrolling to bottom.`);
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
        console.log('[AppManager] Max restore attempts reached, giving up.');
        window.scrollTo({ top: targetScroll, behavior: 'instant' }); // Try one last time
        ScrollState.markRestorationComplete();
      }
    };

    // Start the chase after initial load
    setTimeout(chaseScroll, 500);
  }
}
