import { BaseSiteAdapter } from './reading_site_adapter';
import { ProgressTracker } from './progress_tracker';

/**
 * 微信读书网站适配器
 */
export class WeReadAdapter extends BaseSiteAdapter {
  readonly id = 'weread';
  readonly name = '微信读书';
  readonly domain = 'weread.qq.com';

  // ==================== 进度跟踪器 ====================
  private progressTracker: ProgressTracker | null = null;

  // 翻页监听相关
  private pageTurnMonitorInitialized: boolean = false;
  private lastPageTurnTime: number = 0;

  // 事件处理器引用（用于清理）
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private nextBtnHandler: (() => void) | null = null;
  private prevBtnHandler: (() => void) | null = null;

  constructor() {
    super();
    // 初始化进度跟踪器（会自动监听 ipc:route-changed 事件）
    this.progressTracker = new ProgressTracker();
    // 注意: 不再需要在构造函数中手动触发 onEnterReaderPage
    // 因为 IPCManager 会在初始化时发出 ipc:route-changed 事件
    // ProgressTracker 会监听该事件并自动处理
  }

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

  /**
   * 初始化翻页监听器 - 监听键盘和按钮点击
   */
  private initPageTurnMonitor(): void {
    if (this.pageTurnMonitorInitialized) {
      return;
    }
    this.pageTurnMonitorInitialized = true;

    // 监听键盘翻页
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        this.handlePageTurn();
      }
    };
    window.addEventListener('keydown', this.keydownHandler);

    // 监听翻页按钮点击
    const addButtonListener = () => {
      const nextBtn = document.querySelector('.renderTarget_pager_button_right');
      const prevBtn = document.querySelector('.renderTarget_pager_button');

      if (nextBtn && !this.nextBtnHandler) {
        this.nextBtnHandler = () => this.handlePageTurn();
        nextBtn.addEventListener('click', this.nextBtnHandler);
      }
      if (prevBtn && !this.prevBtnHandler) {
        this.prevBtnHandler = () => this.handlePageTurn();
        prevBtn.addEventListener('click', this.prevBtnHandler);
      }
    };

    // 页面加载后添加按钮监听
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', addButtonListener, { once: true });
    } else {
      addButtonListener();
    }
  }

  /**
   * 清理事件监听器（防止内存泄漏）
   */
  destroy(): void {
    // 清理键盘监听器
    if (this.keydownHandler) {
      window.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }

    // 清理按钮监听器
    if (this.nextBtnHandler) {
      const nextBtn = document.querySelector('.renderTarget_pager_button_right');
      if (nextBtn) {
        nextBtn.removeEventListener('click', this.nextBtnHandler);
      }
      this.nextBtnHandler = null;
    }

    if (this.prevBtnHandler) {
      const prevBtn = document.querySelector('.renderTarget_pager_button');
      if (prevBtn) {
        prevBtn.removeEventListener('click', this.prevBtnHandler);
      }
      this.prevBtnHandler = null;
    }

    // 清理进度跟踪器
    if (this.progressTracker) {
      this.progressTracker.destroy();
      this.progressTracker = null;
    }
  }

  /**
   * 处理翻页事件（带防抖）
   * 注：ProgressTracker 现在独立监听翻页事件，不需要此处调用
   */
  private handlePageTurn(): void {
    const now = Date.now();

    // 防抖：500ms 内只触发一次
    if (now - this.lastPageTurnTime < 500) {
      return;
    }

    this.lastPageTurnTime = now;

    // ProgressTracker 现在通过 EventBus 和 DOM 事件独立工作
    // 不再需要手动调用 onPageTurn
  }

  async nextPage(): Promise<void> {
    this.triggerKey('Right');
    this.handlePageTurn();
  }

  async prevPage(): Promise<void> {
    this.triggerKey('Left');
    this.handlePageTurn();
  }

  isDoubleColumn(): boolean {
    return !!document.querySelector('.wr_horizontalReader');
  }

  isAtBottom(): boolean {
    // 双栏模式使用页码判断
    if (this.isDoubleColumn()) {
      // TODO: 从进度跟踪器获取进度来判断
      return false;
    }
    // 单栏模式使用滚动位置判断
    const totalHeight = document.documentElement.scrollHeight;
    const currentPos = window.innerHeight + window.scrollY;
    return currentPos >= totalHeight - 300;
  }

  /**
   * 获取当前章节进度（0-100）
   */
  getChapterProgress(): number {
    if (!this.progressTracker) {
      return 0;
    }
    return this.progressTracker.getCurrentProgress();
  }

  /**
   * 从页面提取数字格式的 bookId
   * 微信读书有两种 bookId:
   * 1. URL 中的字符串格式: a57325c05c8ed3a57224187
   * 2. API 使用的数字格式: 822995
   */
  private extractNumericBookId(): string | null {
    // 方法1: 从 JSON-LD script 标签中提取
    const jsonLdScript = document.querySelector('script[type="application/ld+json"]');
    if (jsonLdScript && jsonLdScript.textContent) {
      try {
        const data = JSON.parse(jsonLdScript.textContent);
        if (data['@Id']) {
          return data['@Id'];
        }
      } catch (e) {
        // JSON 解析失败，继续尝试其他方法
      }
    }

    // 方法2: 从全局变量中提取（如果有的话）
    if ((window as any).bookId) {
      return String((window as any).bookId);
    }

    // 方法3: 从 URL 中提取（作为最后的备选）
    const urlMatch = window.location.pathname.match(/\/web\/reader\/([^/]+)/);
    if (urlMatch) {
      return urlMatch[1];
    }

    return null;
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
