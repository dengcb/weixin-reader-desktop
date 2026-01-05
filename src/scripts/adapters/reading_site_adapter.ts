/**
 * 阅读网站适配器接口
 * 所有阅读网站都需要实现这个接口，以提供统一的调用方式
 */
export interface ReadingSiteAdapter {
  /** 网站唯一标识 */
  readonly id: string;

  /** 网站名称 */
  readonly name: string;

  /** 匹配的域名（可以是字符串或字符串数组） */
  readonly domain: string | string[];

  // ==================== 路由检测 ====================

  /**
   * 检测当前页面是否是阅读页面
   */
  isReaderPage(): boolean;

  /**
   * 检测当前页面是否是首页
   */
  isHomePage(): boolean;

  // ==================== 样式注入 ====================

  /**
   * 获取宽屏模式 CSS
   * @param wide true=宽屏, false=窄屏
   */
  getWideModeCSS(wide: boolean): string;

  /**
   * 获取工具栏显示/隐藏 CSS
   * @param hide true=隐藏, false=显示
   */
  getToolbarCSS(hide: boolean): string;

  /**
   * 获取导航栏显示/隐藏 CSS（可选）
   * @param hide true=隐藏, false=显示
   */
  getNavbarCSS?(hide: boolean): string;

  /**
   * 获取深色主题 CSS（可选）
   */
  getDarkThemeCSS?(): string;

  /**
   * 获取浅色主题 CSS（可选）
   */
  getLightThemeCSS?(): string;

  // ==================== 翻页控制 ====================

  /**
   * 下一页
   */
  nextPage(): void;

  /**
   * 上一页
   */
  prevPage(): void;

  /**
   * 检测是否是双栏模式
   */
  isDoubleColumn(): boolean;

  /**
   * 检测是否滚动到页面底部
   */
  isAtBottom(): boolean;

  /**
   * 获取当前章节的阅读进度（百分比 0-100）（可选）
   * 双栏模式：根据当前页码/总页数计算
   * 单栏模式：根据滚动位置计算
   */
  getChapterProgress?(): number;

  // ==================== 章节导航 ====================

  /**
   * 获取下一张按钮的选择器（可选）
   */
  getNextChapterSelector?(): string;

  /**
   * 点击下一章按钮（可选）
   */
  clickNextChapter?(): void;

  // ==================== 菜单项 ====================

  /**
   * 获取网站特定的菜单项配置（可选）
   * 返回菜单项 ID 数组，这些菜单项仅在阅读页面时启用
   */
  getReaderMenuItems?(): string[];

  // ==================== 域名匹配 ====================

  /**
   * 检查适配器是否匹配当前域名（可选）
   * 用于动态检测当前页面应该使用哪个适配器
   */
  matchesCurrentDomain?(): boolean;
}

/**
 * 网站适配器配置选项
 */
export interface SiteAdapterOptions {
  /** 是否启用深色主题支持 */
  supportDarkTheme?: boolean;

  /** 是否支持自动翻页 */
  supportAutoFlip?: boolean;

  /** 是否支持章节导航 */
  supportChapterNav?: boolean;
}

/**
 * 基础适配器抽象类
 * 提供一些通用方法的默认实现
 */
export abstract class BaseSiteAdapter implements ReadingSiteAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly domain: string | string[];

  // 默认实现：通过域名匹配
  matchesCurrentDomain(): boolean {
    const hostname = window.location.hostname;
    const domains = Array.isArray(this.domain) ? this.domain : [this.domain];
    return domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  }

  // 默认实现：通过 URL 模式检测是否在阅读页
  protected matchesPath(pattern: string | RegExp): boolean {
    const pathname = window.location.pathname;
    const href = window.location.href;

    if (typeof pattern === 'string') {
      return pathname.includes(pattern) || href.includes(pattern);
    } else {
      return pattern.test(pathname) || pattern.test(href);
    }
  }

  // 默认实现：键盘翻页
  protected triggerKey(key: string): void {
    const event = new KeyboardEvent('keydown', {
      key: key,
      code: key === 'Right' ? 'ArrowRight' : key === 'Left' ? 'ArrowLeft' : key,
      keyCode: key === 'Right' ? 39 : key === 'Left' ? 37 : 0,
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(event);
  }

  // 默认实现：点击元素
  protected clickElement(selector: string): boolean {
    const element = document.querySelector(selector) as HTMLElement;
    if (element) {
      element.click();
      return true;
    }
    return false;
  }

  // 子类必须实现的抽象方法
  abstract isReaderPage(): boolean;
  abstract isHomePage(): boolean;
  abstract getWideModeCSS(wide: boolean): string;
  abstract getToolbarCSS(hide: boolean): string;
  abstract nextPage(): void;
  abstract prevPage(): void;
  abstract isDoubleColumn(): boolean;
  abstract isAtBottom(): boolean;
}
