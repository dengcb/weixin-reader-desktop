import { injectCSS } from '../core/utils';
import { settingsStore, AppSettings } from '../core/settings_store';

export class StyleManager {
  private isWide = false;
  private isHideToolbar = false;

  constructor() {
    this.init();
  }

  private init() {
    // 1. Theme Handling
    this.handleTheme();

    // 2. Subscribe to settings
    settingsStore.subscribe((settings) => {
        this.updateStyles(settings);
    });
  }

  private handleTheme() {
      // Define styles
      const DARK_BG = `
          html, body {
              background-color: #222222 !important;
          }
      `;
      
      const LIGHT_BG = `
          html, body {
              background-color: #ffffff !important;
          }
      `;

      // Function to apply theme
      const applyTheme = (e: MediaQueryList | MediaQueryListEvent) => {
          if (e.matches) {
              // Dark mode
              injectCSS('wxrd-base-bg', DARK_BG);
          } else {
              // Light mode
              injectCSS('wxrd-base-bg', LIGHT_BG);
          }
      };

      // Initial check
      const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      applyTheme(darkModeQuery);

      // Listen for changes
      darkModeQuery.addEventListener('change', applyTheme);
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
    const CSS_READER_WIDE = `
    /* 基础逻辑：宽屏模式 */
    .readerTopBar,
    body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
      width: 96% !important;
      max-width: calc(100vw - 224px) !important;
    }
    .app_content {
      max-width: calc(100vw - 224px) !important;
    }
    body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
      margin-left: calc(50vw - 80px) !important;
    }
  `;

  const CSS_READER_THIN = `
    /* 基础逻辑：窄屏模式 */
    .readerTopBar,
    body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
      width: 80% !important;
      max-width: calc(100vw - 424px) !important;
    }
    .app_content {
      max-width: calc(100vw - 424px) !important;
    }
    body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
      margin-left: calc(50vw - 180px) !important;
    }
  `;

  const CSS_HIDE_TOOLBAR = `
    /* 1. 基础逻辑：无论单栏双栏，都隐藏工具栏 */
    .readerControls {
      display: none !important;
    }

    /* 2. 双栏模式特有逻辑，请勿修改！！！ */
    .readerTopBar,
    body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
      max-width: calc(100vw - 124px) !important;
    }

    /* 3. 单栏模式特有逻辑，请勿删除！！！ */
    .app_content {
      max-width: calc(100vw - 124px) !important;
    }
  `;

  const CSS_SHOW_TOOLBAR = `
    /* 1. 基础逻辑：显示工具栏 */
    .readerControls {
      display: block !important;
    }

    /* 2. 双栏模式特有逻辑，请勿修改！！！ */
    .readerTopBar,
    body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
      max-width: calc(100vw - 224px) !important;
    }

    /* 3. 单栏模式特有逻辑，请勿删除！！！ */
    .app_content {
      max-width: calc(100vw - 224px) !important;
    }
    body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
      margin-left: calc(50vw - 80px) !important;
    }
  `;

    if (this.isWide) {
      injectCSS('wxrd-wide-mode', CSS_READER_WIDE);
    } else {
      injectCSS('wxrd-wide-mode', CSS_READER_THIN);
    }

    if (this.isHideToolbar) {
      injectCSS('wxrd-hide-toolbar', CSS_HIDE_TOOLBAR);
    } else {
      injectCSS('wxrd-hide-toolbar', CSS_SHOW_TOOLBAR);
    }
    window.dispatchEvent(new Event('resize'));
  }
}
