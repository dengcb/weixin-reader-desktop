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
import { settingsStore, AppSettings, SiteSettings, MergedSettings } from '../core/settings_store';
import { createSiteContext, SiteContext } from '../core/site_context';
import { log } from '../core/logger';
import { RouteChangedEvent } from './ipc_manager';

export class StyleManager {
  private isWide = false;
  private isHideToolbar = false;
  private isHideNavbar = false;
  private isReader = false;
  private siteContext: SiteContext;

  // Store references for cleanup
  private routeChangedHandler: ((e: Event) => void) | null = null;
  private legacyRouteChangedHandler: ((e: Event) => void) | null = null;
  private darkModeQuery: MediaQueryList | null = null;
  private darkModeHandler: ((e: MediaQueryListEvent | MediaQueryList) => void) | null = null;

  constructor() {
    this.siteContext = createSiteContext();
    this.init();
  }

  private async init() {
    // 1. Check initial route
    this.isReader = this.siteContext.isReaderPage;

    // 2. IMPORTANT: If starting on non-reader page, clear any leftover reader styles
    // SettingsStore is already initialized by inject.ts
    if (!this.isReader) {
      log.debug('[StyleManager] Starting on non-reader page, clearing any leftover reader styles');
      this.clearReaderStyles();
    }

    // 3. Theme Handling (always active)
    this.handleTheme();

    // 4. Subscribe to settings changes
    settingsStore.subscribe(() => {
      // Always get the full merged settings (including current site settings)
      this.updateStyles(settingsStore.get());
    });

    // Initialize styles with current settings immediately
    // Wait for settings to be loaded if not initialized
    this.updateStyles(settingsStore.get());

    // 5. Listen to route changes from IPCManager
    this.routeChangedHandler = ((e: CustomEvent<RouteChangedEvent>) => {
      const wasReader = this.isReader;
      this.isReader = e.detail.isReader;

      // Clear reader-only styles when leaving reader page
      if (wasReader && !this.isReader) {
        log.debug('[StyleManager] Leaving reader page, clearing reader styles');
        this.clearReaderStyles();
      }

      // Apply reader-only styles when entering reader page
      if (!wasReader && this.isReader) {
        log.debug('[StyleManager] Entering reader page, applying styles');
        this.applyStyles();
      }
    }) as EventListener;

    this.legacyRouteChangedHandler = ((e: CustomEvent<{ isReader: boolean }>) => {
      const wasReader = this.isReader;
      this.isReader = e.detail.isReader;

      // Clear reader-only styles when leaving reader page
      if (wasReader && !this.isReader) {
        log.debug('[StyleManager] Leaving reader page, clearing reader styles');
        this.clearReaderStyles();
      }
    }) as EventListener;

    window.addEventListener('ipc:route-changed', this.routeChangedHandler);
    window.addEventListener('wxrd:route-changed', this.legacyRouteChangedHandler);

    // 6. 监听双栏模式变化（集中管理）
    this.siteContext.onDoubleColumnChange((isDoubleColumn) => {
      log.debug('[StyleManager] Double column mode changed from SiteContext:', isDoubleColumn);
      this.applyStyles();
    });
  }

  private handleTheme() {
    this.darkModeHandler = (e: MediaQueryList | MediaQueryListEvent) => {
      const adapter = this.siteContext.currentAdapter;

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
    this.darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.darkModeHandler(this.darkModeQuery);

    // Listen for changes
    this.darkModeQuery.addEventListener('change', this.darkModeHandler);
  }

  private updateStyles(settings: MergedSettings) {
    const newIsWide = !!settings.readerWide;
    const newIsHideToolbar = !!settings.hideToolbar;
    const newIsHideNavbar = !!settings.hideNavbar;

    if (newIsWide !== this.isWide || newIsHideToolbar !== this.isHideToolbar || newIsHideNavbar !== this.isHideNavbar) {
      this.isWide = newIsWide;
      this.isHideToolbar = newIsHideToolbar;
      this.isHideNavbar = newIsHideNavbar;
      this.applyStyles();
    }
  }

  private applyStyles() {
    // Only apply reader-specific styles when on reader page
    if (!this.isReader) {
      return;
    }

    const adapter = this.siteContext.currentAdapter;
    const isDoubleColumn = this.siteContext.isDoubleColumn;

    log.debug('[StyleManager] Applying styles. isDoubleColumn:', isDoubleColumn);

    if (adapter) {
      // Use adapter-specific CSS
      const wideCSS = adapter.getWideModeCSS(this.isWide);
      const toolbarCSS = adapter.getToolbarCSS(this.isHideToolbar);
      // 导航栏隐藏样式仅在双栏模式下应用
      const navbarCSS = (isDoubleColumn && adapter.getNavbarCSS) ? adapter.getNavbarCSS(this.isHideNavbar) : '';

      injectCSS('wxrd-wide-mode', wideCSS);
      injectCSS('wxrd-hide-toolbar', toolbarCSS);
      injectCSS('wxrd-hide-navbar', navbarCSS);
    } else {
      // Fallback: no styles applied
      log.warn('[StyleManager] No adapter found, styles not applied');
    }

    window.dispatchEvent(new Event('resize'));
  }

  private clearReaderStyles() {
    // Remove wide mode CSS
    removeCSS('wxrd-wide-mode');
    // Remove hide toolbar CSS
    removeCSS('wxrd-hide-toolbar');
    // Remove hide navbar CSS
    removeCSS('wxrd-hide-navbar');
  }

  public destroy() {
    // Remove event listeners
    if (this.routeChangedHandler) {
      window.removeEventListener('ipc:route-changed', this.routeChangedHandler);
      this.routeChangedHandler = null;
    }
    if (this.legacyRouteChangedHandler) {
      window.removeEventListener('wxrd:route-changed', this.legacyRouteChangedHandler);
      this.legacyRouteChangedHandler = null;
    }

    // Remove media query listener
    if (this.darkModeQuery && this.darkModeHandler) {
      this.darkModeQuery.removeEventListener('change', this.darkModeHandler);
      this.darkModeQuery = null;
      this.darkModeHandler = null;
    }

    // Clean up injected styles
    this.clearReaderStyles();
    removeCSS('wxrd-base-bg');
  }
}
