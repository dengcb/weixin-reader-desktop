/**
 * IPC Manager - Central Event Bus
 *
 * Responsibilities:
 * - Monitor route changes (popstate, pushState, replaceState)
 * - Monitor title changes
 * - Dispatch events to all subscribers
 *
 * Events dispatched:
 * - 'ipc:route-changed' -> { isReader: boolean, url: string, pathname: string }
 * - 'ipc:title-changed' -> { title: string }
 */

import { createSiteContext, SiteContext } from '../core/site_context';
import { settingsStore } from '../core/settings_store';
import { invoke } from '../core/tauri';
import { ScrollState } from '../core/scroll_state';
import { log } from '../core/logger';

export type RouteChangedEvent = {
  isReader: boolean;
  url: string;
  pathname: string;
};

export type TitleChangedEvent = {
  title: string;
};

export class IPCManager {
  private siteContext: SiteContext;
  private currentIsReader = false;
  private initialized = false;  // Track if this is the initial check
  private scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSavedScrollY = 0;

  // Store references for cleanup
  private checkRouteHandler: (() => void) | null = null;
  private titleObserver: MutationObserver | null = null;
  private scrollHandler: (() => void) | null = null;
  private safetyTimeout: ReturnType<typeof setTimeout> | null = null;

  // Store original History API methods for restoration
  private originalPushState: typeof history.pushState | null = null;
  private originalReplaceState: typeof history.replaceState | null = null;

  constructor() {
    this.siteContext = createSiteContext();
    this.init();
  }

  private async init() {
    // Wait for settings to be ready
    await settingsStore.init();

    // Safety fallback: Ensure scroll saving is enabled after 10 seconds
    // This prevents a bug in AppManager.restoreScrollPosition from permanently disabling save
    this.safetyTimeout = setTimeout(() => {
      if (!ScrollState.isRestorationComplete()) {
        log.warn('[IPCManager] Force enabling scroll save after timeout');
        ScrollState.markRestorationComplete();
      }
    }, 10000);

    // Start monitoring
    this.monitorRoute();
    this.monitorTitle();
    this.monitorScroll();
  }

  private monitorRoute() {
    this.checkRouteHandler = () => {
      const currentUrl = window.location.href;
      const pathname = window.location.pathname;

      // Use SiteContext to detect if we're on a reader page
      const isReader = this.siteContext.isReaderPage;

      // Detect route change
      const routeChanged = this.currentIsReader !== isReader;
      this.currentIsReader = isReader;

      // Always handle last page saving (save URL when on reader page)
      // Never clear URL during navigation - only app close should clear it
      this.handleLastPageSaving(isReader, currentUrl);

      // Dispatch route changed event if something changed
      if (routeChanged) {
        this.dispatchRouteChanged(isReader, currentUrl, pathname);
      }
    };

    // Listen to navigation events
    window.addEventListener('popstate', this.checkRouteHandler);

    // Override history methods to detect SPA navigation
    // Store original methods for cleanup
    this.originalPushState = history.pushState;
    history.pushState = (...args) => {
      const result = this.originalPushState!.apply(history, args);
      if (this.checkRouteHandler) this.checkRouteHandler();
      return result;
    };

    this.originalReplaceState = history.replaceState;
    history.replaceState = (...args) => {
      const result = this.originalReplaceState!.apply(history, args);
      if (this.checkRouteHandler) this.checkRouteHandler();
      return result;
    };

    // Initial check
    this.checkRouteHandler();
    // Dispatch initial route event to ensure listeners like StyleManager get the current state
    const currentUrl = window.location.href;
    const pathname = window.location.pathname;
    const isReader = this.siteContext.isReaderPage;
    this.dispatchRouteChanged(isReader, currentUrl, pathname);
  }

  private handleLastPageSaving(isReader: boolean, currentUrl: string) {
    const settings = settingsStore.get();

    // Only save reader URL, never clear it during navigation
    // lastReaderUrl should persist across sessions for app restoration
    // It's only cleared when app closes (handled by Rust backend)
    if (settings.lastPage && isReader) {
      if (settings.lastReaderUrl !== currentUrl) {
        settingsStore.update({ lastReaderUrl: currentUrl });
      }
    }
  }

  private dispatchRouteChanged(isReader: boolean, url: string, pathname: string) {
    const detail: RouteChangedEvent = { isReader, url, pathname };

    // Dispatch legacy event for backward compatibility
    window.dispatchEvent(new CustomEvent('wxrd:route-changed', { detail }));

    // Dispatch new IPC event
    window.dispatchEvent(new CustomEvent('ipc:route-changed', { detail }));
  }

  private monitorTitle() {
    const target = document.querySelector('title');
    if (target) {
      this.titleObserver = new MutationObserver(() => {
        this.dispatchTitleChanged();
      });
      this.titleObserver.observe(target, { childList: true, characterData: true, subtree: true });

      // Initial dispatch
      this.dispatchTitleChanged();
    }
  }

  private dispatchTitleChanged() {
    if (document.title && document.title.trim() !== '') {
      const detail: TitleChangedEvent = { title: document.title };

      // Dispatch new IPC event
      window.dispatchEvent(new CustomEvent('ipc:title-changed', { detail }));
    }
  }

  // ==================== Scroll Position Saving (Single-column mode) ====================

  private monitorScroll() {
    // Debounced scroll position saving for single-column reading mode
    this.scrollHandler = () => {
      // Only save in reader page and when lastPage is enabled
      if (!this.currentIsReader) return;

      const settings = settingsStore.get();
      if (!settings.lastPage) return;

      // Check if in single-column mode (not double-column)
      const adapter = this.siteContext.currentAdapter;
      if (!adapter || adapter.isDoubleColumn()) return;

      // Check if restore is complete (prevent overwriting during restore chase)
      if (!ScrollState.isRestorationComplete()) {
        return;
      }

      const scrollY = window.scrollY;

      // Only save if scroll position changed significantly (>50px)
      if (Math.abs(scrollY - this.lastSavedScrollY) < 50) return;

      // Debounce: save after 500ms of no scrolling
      if (this.scrollSaveTimer) {
        clearTimeout(this.scrollSaveTimer);
      }

      this.scrollSaveTimer = setTimeout(() => {
        this.lastSavedScrollY = scrollY;
        const currentUrl = window.location.href;

        // Get current progress map or create new one
        const currentProgress = settingsStore.get().readingProgress || {};

        // Update progress for current URL
        const newProgress = {
          ...currentProgress,
          [currentUrl]: scrollY
        };

        settingsStore.update({
          scrollPosition: scrollY, // Keep legacy field for backward compat
          readingProgress: newProgress
        });
      }, 500);
    };

    window.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  public destroy() {
    // Clear timers
    if (this.scrollSaveTimer) {
      clearTimeout(this.scrollSaveTimer);
      this.scrollSaveTimer = null;
    }
    if (this.safetyTimeout) {
      clearTimeout(this.safetyTimeout);
      this.safetyTimeout = null;
    }

    // Remove event listeners
    if (this.checkRouteHandler) {
      window.removeEventListener('popstate', this.checkRouteHandler);
      this.checkRouteHandler = null;
    }
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }

    // Restore original History API methods
    if (this.originalPushState) {
      history.pushState = this.originalPushState;
      this.originalPushState = null;
    }
    if (this.originalReplaceState) {
      history.replaceState = this.originalReplaceState;
      this.originalReplaceState = null;
    }

    // Disconnect observer
    if (this.titleObserver) {
      this.titleObserver.disconnect();
      this.titleObserver = null;
    }
  }
}
