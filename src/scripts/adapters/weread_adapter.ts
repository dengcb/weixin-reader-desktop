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
          margin-left: calc(40% + 40px) !important;
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
        .app_content,
        body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
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
        .app_content,
        body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
          max-width: calc(100vw - 224px) !important;
        }
      `;
    }
  }

  getNavbarCSS(hide: boolean): string {
    if (hide) {
      return `
        /* 微信读书 - 隐藏导航栏 */
        .readerTopBar,
        .renderTarget_pager {
          display: none !important;
        }
        body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
          margin-top: 24px !important;
          height: calc(100% - 48px) !important;
        }
      `;
    } else {
      return `
        /* 微信读书 - 显示导航栏 */
        .readerTopBar,
        .renderTarget_pager {
          display: flex !important;
        }
        body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
          margin-top: 72px !important;
          height: calc(100% - 132px) !important;
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
    return !!document.querySelector('.wr_horizontalReader');
  }

  isAtBottom(): boolean {
    // 双栏模式使用页码判断
    if (this.isDoubleColumn()) {
      const progress = this.getChapterProgress();
      return progress >= 99;
    }
    // 单栏模式使用滚动位置判断
    const totalHeight = document.documentElement.scrollHeight;
    const currentPos = window.innerHeight + window.scrollY;
    return currentPos >= totalHeight - 300;
  }

  /**
   * 获取当前章节的阅读进度（百分比 0-100）
   * 仅支持双栏模式，单栏模式返回 0
   */
  getChapterProgress(): number {
    if (!this.isDoubleColumn()) {
      return 0;
    }

    // 双栏模式：从 DOM 中获取页码信息
    // 微信读书在双栏模式下会显示当前页/总页数
    const pageInfoElement = document.querySelector('.renderTargetPageInfo');
    if (pageInfoElement) {
      const text = pageInfoElement.textContent?.trim();
      if (text) {
        const match = text.match(/(\d+)\s*[\//]\s*(\d+)/);
        if (match) {
          const current = parseInt(match[1], 10);
          const total = parseInt(match[2], 10);
          if (total > 0) {
            return Math.round((current / total) * 100);
          }
        }
      }
    }

    // 备用方案：尝试分别获取当前页和总页数
    const currentEl = document.querySelector('.readerFooter_pageCurrent');
    const totalEl = document.querySelector('.readerFooter_pageTotal');
    if (currentEl && totalEl) {
      const current = parseInt(currentEl.textContent || '0', 10);
      const total = parseInt(totalEl.textContent || '1', 10);
      if (total > 0) {
        return Math.round((current / total) * 100);
      }
    }

    // 如果无法获取页码，返回 0
    return 0;
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
