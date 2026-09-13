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

import { getCurrentWindow, type Theme } from '@tauri-apps/api/window';
import { injectCSS, removeCSS } from '../core/utils';
import { detectWereadTheme } from '../core/weread_theme';
import {
  DEFAULT_WIDE_WIDTH_PERCENT,
  normalizeWideWidthPercent,
} from '../core/reader_width';
import { settingsStore, MergedSettings } from '../core/settings_store';
import { createSiteContext, SiteContext } from '../core/site_context';
import { log } from '../core/logger';
import { RouteChangedEvent } from './ipc_manager';

export class StyleManager {
  private isWide = false;
  private wideWidthPercent = DEFAULT_WIDE_WIDTH_PERCENT;
  private isHideToolbar = false;
  private isHideNavbar = false;
  private isReader = false;
  private siteContext: SiteContext;

  // Store references for cleanup
  private routeChangedHandler: ((e: Event) => void) | null = null;
  private legacyRouteChangedHandler: ((e: Event) => void) | null = null;
  private darkModeQuery: MediaQueryList | null = null;
  private darkModeHandler: ((e: MediaQueryListEvent | MediaQueryList) => void) | null = null;
  private pageThemeObserver: MutationObserver | null = null;
  private lastWindowTheme: Theme | null | undefined;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeDoubleColumn: (() => void) | null = null;

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
    this.unsubscribeSettings = settingsStore.subscribe(() => {
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

      // 阅读页与主页的背景兜底策略不同，路由切换时同步
      this.handleBaseBg();
      // v1.8.4 预审（BugHunter 高危项）：路由切换必须主动下发 set_theme——
      // 离页回 null / 入页按 cookie 接管原本押在 body 类变更副作用上，
      // 时机不可靠（主页永久钉死暗窗风险）。lastWindowTheme 去重兜底。
      this.syncWindowTheme();
    }) as EventListener;

    this.legacyRouteChangedHandler = ((e: CustomEvent<{ isReader: boolean }>) => {
      const wasReader = this.isReader;
      this.isReader = e.detail.isReader;

      // Clear reader-only styles when leaving reader page
      if (wasReader && !this.isReader) {
        log.debug('[StyleManager] Leaving reader page, clearing reader styles');
        this.clearReaderStyles();
      }

      // 阅读页与主页的背景兜底策略不同，路由切换时同步
      this.handleBaseBg();
      // v1.8.4 预审（BugHunter 高危项）：路由切换必须主动下发 set_theme——
      // 离页回 null / 入页按 cookie 接管原本押在 body 类变更副作用上，
      // 时机不可靠（主页永久钉死暗窗风险）。lastWindowTheme 去重兜底。
      this.syncWindowTheme();
    }) as EventListener;

    window.addEventListener('ipc:route-changed', this.routeChangedHandler);
    window.addEventListener('wxrd:route-changed', this.legacyRouteChangedHandler);

    // 6. 监听双栏模式变化（集中管理）
    this.unsubscribeDoubleColumn = this.siteContext.onDoubleColumnChange((isDoubleColumn) => {
      log.debug('[StyleManager] Double column mode changed from SiteContext:', isDoubleColumn);
      this.applyStyles();
    });
  }

  private handleTheme() {
    this.darkModeHandler = () => {
      this.handleBaseBg();
      this.syncWindowTheme();
    };

    // Initial check
    this.darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.darkModeHandler(this.darkModeQuery);

    // Listen for changes
    this.darkModeQuery.addEventListener('change', this.darkModeHandler);

    if (document.body) {
      this.pageThemeObserver = new MutationObserver(() => this.syncWindowTheme());
      this.pageThemeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }
  }

  // 主页/书城的背景兜底跟随系统深浅；阅读页的深浅完全由微信读书内
  // 切换按钮决定（wr_whiteTheme），系统主题不得染指（issue #18 用户反馈：
  // 系统切深时浅色阅读页被强制染成 #2c2c2c）
  private handleBaseBg(): void {
    if (this.siteContext.isReaderPage) {
      removeCSS('wxrd-base-bg');
      return;
    }
    const runtime = this.siteContext.currentRuntime;
    const systemDark = this.darkModeQuery?.matches
      ?? window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (runtime?.styleOwner === 'manager' && runtime.getDarkThemeCSS && runtime.getLightThemeCSS) {
      injectCSS('wxrd-base-bg', systemDark ? runtime.getDarkThemeCSS() : runtime.getLightThemeCSS());
    } else {
      // Fallback to default theme
      const defaultCSS = systemDark
        ? 'html, body { background-color: #2c2c2c !important; }'
        : 'html, body { background-color: #f4f5f7 !important; }';
      injectCSS('wxrd-base-bg', defaultCSS);
    }
  }

  private currentWindowTheme(): Theme | null | undefined {
    if (this.siteContext.siteId !== 'weread') return undefined;
    // 非阅读页（主页/书城）的 body 用 wr_theme_light/dark 标记主题，没有
    // wr_whiteTheme——不能据此判 dark，否则 setTheme('dark') 会把 WebView
    // 外观钉死，劫持 matchMedia，主页的系统主题跟随与深色滤镜全部失真
    // （issue #18）。交还系统跟随（setTheme(null)）。
    if (!this.siteContext.isReaderPage) return null;
    // dev.16 真机取证（v1.8.4 合并收口）：新版微信读书阅读页【不存在】
    // body.wr_whiteTheme DOM 类（上游此判据恒返 'dark'，亮色阅读页被钉成暗窗，
    // 并与我们 weread_style_panel 的 cookie 联动产生 set_theme 双写竞速）。
    // 阅读页真信号 = cookie wr_theme；与 weread_style_panel 共用同一真相源。
    return detectWereadTheme();
  }

  private syncWindowTheme(): void {
    if (window.self !== window.top || !window.__TAURI__) return;
    const theme = this.currentWindowTheme();
    // 仅非 weread 站点不干预；null（恢复系统跟随）是有效指令，必须下发
    if (theme === undefined) return;
    if (theme === this.lastWindowTheme) return;
    this.lastWindowTheme = theme;
    this.setWindowTheme(theme);
  }

  private setWindowTheme(theme: Theme | null): void {
    try {
      void getCurrentWindow().setTheme(theme).catch((error) => {
        if (this.lastWindowTheme === theme) this.lastWindowTheme = undefined;
        log.debug('[StyleManager] Failed to sync native window theme', error);
      });
    } catch (error) {
      if (this.lastWindowTheme === theme) this.lastWindowTheme = undefined;
      log.debug('[StyleManager] Failed to sync native window theme', error);
    }
  }

  private updateStyles(settings: MergedSettings) {
    const newIsWide = !!settings.readerWide;
    const newWideWidthPercent = normalizeWideWidthPercent(settings.wideWidthPercent);
    const newIsHideToolbar = !!settings.hideToolbar;
    const newIsHideNavbar = !!settings.hideNavbar;

    if (
      newIsWide !== this.isWide
      || newWideWidthPercent !== this.wideWidthPercent
      || newIsHideToolbar !== this.isHideToolbar
      || newIsHideNavbar !== this.isHideNavbar
    ) {
      this.isWide = newIsWide;
      this.wideWidthPercent = newWideWidthPercent;
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

    const runtime = this.siteContext.currentRuntime;
    const isDoubleColumn = this.siteContext.isDoubleColumn;

    log.debug('[StyleManager] Applying styles. isDoubleColumn:', isDoubleColumn);

    if (runtime?.styleOwner === 'manager') {
      // Use adapter-specific CSS
      const wideCSS = runtime.getWideModeCSS(this.isWide, this.wideWidthPercent);
      const toolbarCSS = runtime.getToolbarCSS(this.isHideToolbar);
      // 导航栏隐藏样式仅在双栏模式下应用
      const navbarCSS = ((isDoubleColumn || runtime.isPaginated?.()) && runtime.getNavbarCSS)
        ? runtime.getNavbarCSS(this.isHideNavbar)
        : '';

      injectCSS('wxrd-wide-mode', wideCSS);
      injectCSS('wxrd-hide-toolbar', toolbarCSS);
      injectCSS('wxrd-hide-navbar', navbarCSS);
    } else if (!runtime) {
      // Fallback: no styles applied
      log.warn('[StyleManager] No site runtime found, styles not applied');
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
    this.pageThemeObserver?.disconnect();
    this.pageThemeObserver = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.unsubscribeDoubleColumn?.();
    this.unsubscribeDoubleColumn = null;

    // Clean up injected styles
    this.clearReaderStyles();
    removeCSS('wxrd-base-bg');
    if (window.self === window.top && window.__TAURI__ && this.lastWindowTheme) {
      this.lastWindowTheme = undefined;
      this.setWindowTheme(null);
    }
  }
}
