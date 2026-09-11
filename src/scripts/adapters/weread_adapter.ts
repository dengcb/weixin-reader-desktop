import { BaseSiteAdapter } from './reading_site_adapter';
import { ProgressTracker } from './progress_tracker';
import { normalizeWideWidthPercent } from '../core/reader_width';

/**
 * 微信读书网站适配器
 */
export class WeReadAdapter extends BaseSiteAdapter {
  readonly id = 'weread';
  readonly name = '微信读书';
  readonly domain = 'weread.qq.com';

  // ==================== 进度跟踪器 ====================
  private progressTracker: ProgressTracker | null = null;

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

  getWideModeCSS(wide: boolean, wideWidthPercent?: number): string {
    const wideWidth = normalizeWideWidthPercent(wideWidthPercent);
    if (wide) {
      return `
        /* 微信读书 - 自定义阅读宽度 */
        html body .readerContent > .app_content:not(.app_content_in_reader),
        html body .readerContent > .app_content:not(.app_content_in_reader) > .readerTopBar {
          width: ${wideWidth}vw !important;
          max-width: ${wideWidth}vw !important;
        }
        html body .wr_horizontalReader_app_content > .readerTopBar,
        html body .wr_horizontalReader_app_content .readerChapterContent {
          width: ${wideWidth}vw !important;
          max-width: ${wideWidth}vw !important;
        }
        /* 外贴边仅限横排（双栏）：is-horizontal 标记当前布局；纵向单栏的工具栏
           定位结构不同，交还原生样式（一直好用） */
        body:has(.readerControls[is-horizontal="true"]) .readerControls {
          left: auto !important;
          /* 外贴边：right 相对正文容器（宽 = 宽度 vw），负值浮到容器右缘外侧的留白区
             （-72px = 工具栏宽 48 + 间距 24）；留白不足时与「贴视口右缘 24px」取更靠内者
             （max），渐进压正文但绝不出屏、保持可点 */
          right: max(-72px, calc(24px - (100 - ${wideWidth}) / 2 * 1vw)) !important;
          margin-left: 0 !important;
        }
        /* 纵向（单栏）：原生工具栏定位与正文宽度无耦合，宽屏时不会随 W 变动，
           正文变宽后被压在文字上。沿用窄屏分支已校准的公式并按 W 参数化：
           W=80 与窄屏公式逐字重合（开关切换不跳变，测试双向锚定）。
           外推精度依赖「百分比 margin 的包含块 ≈ 视口宽」，尚未真机
           DevTools 校准；若包含块更窄，误差按 |W-80| 放大——在 1440px
           常见窗宽下量级约为一个工具栏位，表现为视觉偏移而非功能失效。
           效果以真机验证为准（进行中）。 */
        body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
          margin-left: calc(${wideWidth / 2}% + 40px) !important;
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
          /* max-width: calc(100vw - 124px) !important; */
        }
      `;
    } else {
      return `
        /* 微信读书 - 显示工具栏 */
        .readerControls {
          display: block !important;
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
      body {
        background-color: #2c2c2c !important;
      }
    `;
  }

  getLightThemeCSS(): string {
    return `
      body {
        background-color: #f4f5f7 !important;
      }
    `;
  }

  // ==================== 翻页控制 ====================

  // 早期实现曾在此处监听键盘/翻页按钮并做 500ms 防抖，但从未被启动（init
  // 路径缺失），真实生效的一直是 ProgressTracker 自己的监听。方向记录统一
  // 在 ProgressTracker 内完成，适配器只负责触发合成按键。

  /**
   * 清理进度跟踪器（防止内存泄漏）
   */
  destroy(): void {
    if (this.progressTracker) {
      this.progressTracker.destroy();
      this.progressTracker = null;
    }
  }

  async nextPage(): Promise<void> {
    // 合成 Arrow 键会同时驱动微信读书翻页和 ProgressTracker 的方向记录
    this.triggerKey('Right');
  }

  async prevPage(): Promise<void> {
    this.triggerKey('Left');
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
