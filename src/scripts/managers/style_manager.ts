/**
 * Style Manager - Manages CSS styles for reader mode
 *
 * Responsibilities:
 * - Apply/remove wide mode CSS
 * - Apply/remove hide toolbar CSS
 * - Handle dark/light theme
 *
 * Listens to:
 * - 'ipc:route-changed' - Clear styles when leaving reader page
 * - Settings store changes - Apply styles when settings change
 */

import { injectCSS, removeCSS } from '../core/utils';
import { settingsStore, AppSettings } from '../core/settings_store';
import { getSiteRegistry } from '../core/site_registry';

type RouteChangedEvent = {
  isReader: boolean;
  url: string;
  pathname: string;
};

export class StyleManager {
  private isWide = false;
  private isHideToolbar = false;
  private isReader = false;
  private siteRegistry = getSiteRegistry();

  constructor() {
    this.init();
  }

  private async init() {
    // 1. Check initial route
    this.isReader = this.siteRegistry.isReaderPage();

    // 2. IMPORTANT: If starting on non-reader page, clear any leftover reader styles
    // SettingsStore is already initialized by inject.ts
    if (!this.isReader) {
      console.log('[StyleManager] Starting on non-reader page, clearing any leftover reader styles');
      this.clearReaderStyles();
    }

    // 3. Theme Handling (always active)
    this.handleTheme();

    // 4. Subscribe to settings changes
    settingsStore.subscribe((settings) => {
      this.updateStyles(settings);
    });

    // 5. Listen to route changes from IPCManager
    window.addEventListener('ipc:route-changed', ((e: CustomEvent<RouteChangedEvent>) => {
      const wasReader = this.isReader;
      this.isReader = e.detail.isReader;

      // Clear reader-only styles when leaving reader page
      if (wasReader && !this.isReader) {
        console.log('[StyleManager] Leaving reader page, clearing reader styles');
        this.clearReaderStyles();
      }
    }) as EventListener);

    window.addEventListener('wxrd:route-changed', ((e: CustomEvent<{ isReader: boolean }>) => {
      const wasReader = this.isReader;
      this.isReader = e.detail.isReader;

      // Clear reader-only styles when leaving reader page
      if (wasReader && !this.isReader) {
        console.log('[StyleManager] Leaving reader page, clearing reader styles');
        this.clearReaderStyles();
      }
    }) as EventListener);
  }

  private handleTheme() {
    const applyTheme = (e: MediaQueryList | MediaQueryListEvent) => {
      const adapter = this.siteRegistry.getCurrentAdapter();

      if (adapter && adapter.getDarkThemeCSS && adapter.getLightThemeCSS) {
        const css = e.matches ? adapter.getDarkThemeCSS() : adapter.getLightThemeCSS();
        injectCSS('wxrd-base-bg', css);
      } else {
        // Fallback to default theme
        const defaultCSS = e.matches
          ? 'html, body { background-color: #222222 !important; }'
          : 'html, body { background-color: #ffffff !important; }';
        injectCSS('wxrd-base-bg', defaultCSS);
      }
    };

    // Initial check
    const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    applyTheme(darkModeQuery);

    // Listen for changes
    darkModeQuery.addEventListener('change', applyTheme);
  }

  // ==================== Mouse Auto-Hide ====================

  private mouseHideTimer: number | null = null;
  private isMouseHidden = false;

  private initMouseAutoHide() {
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

      // 3. Only start timer if in Reader Mode AND Fullscreen (optional, mimicking old behavior)
      // For now, let's just check if we are in reader mode to be safe, or always active.
      // The old version checked: isInReader() && window.isFullScreen()
      // Let's stick to reader mode for now to avoid side effects on home page.
      if (this.isReader) {
        this.mouseHideTimer = window.setTimeout(() => {
          this.hideCursor();
        }, 3000);
      }
    };

    window.addEventListener('mousemove', resetTimer);
    window.addEventListener('mousedown', resetTimer);
    window.addEventListener('keydown', resetTimer); // Also show on key press
    window.addEventListener('wheel', resetTimer);
  }

  private hideCursor() {
    if (this.isMouseHidden) return;
    
    // Check conditions again just in case
    if (!this.isReader) return;

    // Inject CSS class to hide cursor
    injectCSS('wxrd-cursor-hide', `
      body, body * {
        cursor: none !important;
      }
    `);
    this.isMouseHidden = true;
  }

  private showCursor() {
    if (!this.isMouseHidden) return;

    removeCSS('wxrd-cursor-hide');
    this.isMouseHidden = false;
  }

  private updateStyles(settings: AppSettings) {
    const newIsWide = !!settings.readerWide;
    const newIsHideToolbar = !!settings.hideToolbar;

    if (newIsWide !== this.isWide || newIsHideToolbar !== this.isHideToolbar) {
      this.isWide = newIsWide;
      this.isHideToolbar = newIsHideToolbar;
      this.applyStyles();
    }
  }

  private applyStyles() {
    // Only apply reader-specific styles when on reader page
    if (!this.isReader) {
      console.log('[StyleManager] Not on reader page, skipping reader styles');
      return;
    }

    const adapter = this.siteRegistry.getCurrentAdapter();

    if (adapter) {
      // Use adapter-specific CSS
      const wideCSS = adapter.getWideModeCSS(this.isWide);
      const toolbarCSS = adapter.getToolbarCSS(this.isHideToolbar);

      injectCSS('wxrd-wide-mode', wideCSS);
      injectCSS('wxrd-hide-toolbar', toolbarCSS);
    } else {
      // Fallback: no styles applied
      console.warn('[StyleManager] No adapter found, styles not applied');
    }

    window.dispatchEvent(new Event('resize'));
  }

  private clearReaderStyles() {
    // Remove wide mode CSS
    removeCSS('wxrd-wide-mode');
    // Remove hide toolbar CSS
    removeCSS('wxrd-hide-toolbar');

    console.log('[StyleManager] Reader styles cleared');
  }
}
