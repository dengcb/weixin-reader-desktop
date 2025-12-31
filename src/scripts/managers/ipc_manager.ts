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

import { getSiteRegistry } from '../core/site_registry';
import { settingsStore } from '../core/settings_store';
import { invoke } from '../core/tauri';

type RouteChangedEvent = {
  isReader: boolean;
  url: string;
  pathname: string;
};

type TitleChangedEvent = {
  title: string;
};

export class IPCManager {
  private siteRegistry = getSiteRegistry();
  private currentIsReader = false;
  private initialized = false;  // Track if this is the initial check

  constructor() {
    this.init();
  }

  private async init() {
    // Wait for settings to be ready
    await settingsStore.init();

    // Start monitoring
    this.monitorRoute();
    this.monitorTitle();
  }

  private monitorRoute() {
    const checkRoute = () => {
      const currentUrl = window.location.href;
      const pathname = window.location.pathname;

      // Use SiteRegistry to detect if we're on a reader page
      const isReader = this.siteRegistry.isReaderPage();
      const currentAdapter = this.siteRegistry.getCurrentAdapter();

      console.log('[IPCManager] Route check:', {
        url: currentUrl,
        pathname,
        isReader,
        adapter: currentAdapter?.name || 'none',
        initialized: this.initialized
      });

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
    window.addEventListener('popstate', checkRoute);

    // Override history methods to detect SPA navigation
    const originalPushState = history.pushState;
    history.pushState = function(...args) {
      const result = originalPushState.apply(this, args);
      checkRoute();
      return result;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function(...args) {
      const result = originalReplaceState.apply(this, args);
      checkRoute();
      return result;
    };

    // Initial check
    checkRoute();
  }

  private handleLastPageSaving(isReader: boolean, currentUrl: string) {
    const settings = settingsStore.get();

    // Only save reader URL, never clear it during navigation
    // lastReaderUrl should persist across sessions for app restoration
    // It's only cleared when app closes (handled by Rust backend)
    if (settings.lastPage && isReader) {
      if (settings.lastReaderUrl !== currentUrl) {
        console.log('[IPCManager] Saving reader URL:', currentUrl);
        settingsStore.update({ lastReaderUrl: currentUrl });
      }
    }
  }

  private dispatchRouteChanged(isReader: boolean, url: string, pathname: string) {
    const detail: RouteChangedEvent = { isReader, url, pathname };

    // Dispatch legacy event for backward compatibility
    window.dispatchEvent(new CustomEvent('wxrd:route-changed', { detail }));

    // Dispatch new IPC event
    console.log('[IPCManager] Dispatching ipc:route-changed', detail);
    window.dispatchEvent(new CustomEvent('ipc:route-changed', { detail }));
  }

  private monitorTitle() {
    const target = document.querySelector('title');
    if (target) {
      const observer = new MutationObserver(() => {
        this.dispatchTitleChanged();
      });
      observer.observe(target, { childList: true, characterData: true, subtree: true });

      // Initial dispatch
      this.dispatchTitleChanged();
    }
  }

  private dispatchTitleChanged() {
    if (document.title && document.title.trim() !== '') {
      const detail: TitleChangedEvent = { title: document.title };

      // Dispatch new IPC event
      console.log('[IPCManager] Dispatching ipc:title-changed', detail);
      window.dispatchEvent(new CustomEvent('ipc:title-changed', { detail }));
    }
  }
}
