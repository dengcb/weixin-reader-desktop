import { BaseSiteAdapter } from './reading_site_adapter';

/**
 * 微信读书网站适配器
 */
export class WeReadAdapter extends BaseSiteAdapter {
  readonly id = 'weread';
  readonly name = '微信读书';
  readonly domain = 'weread.qq.com';

  // ==================== 路由检测 ====================

  isReaderPage(): boolean {
    return this.matchesPath('/web/reader/');
  }

  isHomePage(): boolean {
    const pathname = window.location.pathname;
    return pathname === '/' || pathname === '/web' || pathname.startsWith('/web/shelf');
  }

  // ==================== 样式注入 ====================

  getWideModeCSS(wide: boolean): string {
    if (wide) {
      return `
        /* 微信读书 - 宽屏模式 */
        .readerTopBar,
        body:has(.readerControls[is-horizontal="true"]) .readerChapterContent,
        .app_content {
          width: 96% !important;
          max-width: calc(100vw - 224px) !important;
        }
        body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
          margin-left: calc(50vw - 80px) !important;
        }
      `;
    } else {
      return `
        /* 微信读书 - 窄屏模式 */
        .readerTopBar,
        body:has(.readerControls[is-horizontal="true"]) .readerChapterContent,
        .app_content {
          width: 80% !important;
          max-width: calc(100vw - 424px) !important;
        }
        body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
          margin-left: calc(50vw - 120px) !important;
        }
      `;
    }
  }

  getToolbarCSS(hide: boolean): string {
    if (hide) {
      return `
        /* 微信读书 - 隐藏工具栏 */
        .readerControls {
          display: none !important;
        }
        .readerTopBar,
        body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
          max-width: calc(100vw - 124px) !important;
        }
        .app_content {
          max-width: calc(100vw - 124px) !important;
        }
      `;
    } else {
      return `
        /* 微信读书 - 显示工具栏 */
        .readerControls {
          display: block !important;
        }
        .readerTopBar,
        body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
          max-width: calc(100vw - 224px) !important;
        }
        .app_content {
          max-width: calc(100vw - 224px) !important;
        }
      `;
    }
  }

  getDarkThemeCSS(): string {
    return `
      html, body {
        background-color: #222222 !important;
      }
    `;
  }

  getLightThemeCSS(): string {
    return `
      html, body {
        background-color: #ffffff !important;
      }
    `;
  }

  // ==================== 翻页控制 ====================

  nextPage(): void {
    this.triggerKey('Right');
  }

  prevPage(): void {
    this.triggerKey('Left');
  }

  isDoubleColumn(): boolean {
    return !!document.querySelector('.readerControls[is-horizontal="true"]');
  }

  isAtBottom(): boolean {
    const totalHeight = document.documentElement.scrollHeight;
    const currentPos = window.innerHeight + window.scrollY;
    // Increase threshold to 300px to trigger next page earlier and more reliably
    return currentPos >= totalHeight - 300;
  }

  // ==================== 章节导航 ====================

  getNextChapterSelector(): string {
    // 微信读书的下一章按钮选择器（根据实际情况调整）
    return '.readerFooter_button';
  }

  clickNextChapter(): void {
    // 微信读书点击下一章的实现
    const nextButton = document.querySelector(this.getNextChapterSelector()!) as HTMLElement;
    if (nextButton) {
      nextButton.click();
    }
  }

  // ==================== 菜单项 ====================

  getReaderMenuItems(): string[] {
    return ['reader_wide', 'hide_toolbar', 'auto_flip'];
  }
}
