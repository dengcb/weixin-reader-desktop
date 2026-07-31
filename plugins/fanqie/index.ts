/**
 * 番茄小说插件
 * Fanqie Novel Plugin for AT Reader
 *
 * 将番茄小说网站适配为标准阅读器插件。
 *
 * 合规说明：本插件仅做「呈现层」增强——注入 CSS 调整阅读排版、
 * 读取页面本就公开的章节元数据用于本地进度显示。
 * 不修改正文、不破解混淆字体、不抓取或导出任何内容。
 */

import type {
  ReaderPlugin,
  PluginManifest,
  PluginStyles,
  PluginAPI,
  BookProgress,
} from '../../src/scripts/core/plugin_types';

// 导入 manifest（构建时会被内联）
import manifest from './manifest.json';

// 样式常量
const STYLES = {
  // 宽屏模式：放宽阅读列宽度（番茄默认约 551px，偏窄）
  wide: {
    enabled: `
      .muye-reader-inner {
        max-width: 820px !important;
      }
    `,
    disabled: `
      .muye-reader-inner {
        max-width: 551px !important;
      }
    `,
  },
  // 沉浸模式：隐藏侧边浮动工具栏（加书架/目录/夜间/字号/下载/领红包）
  toolbar: {
    enabled: `
      .reader-toolbar {
        display: none !important;
      }
    `,
    disabled: `
      .reader-toolbar {
        display: flex !important;
      }
    `,
  },
};

/**
 * 章节元数据（读取自页面公开的 __INITIAL_STATE__）
 */
interface FanqieChapterData {
  bookId?: string;
  bookName?: string;
  itemId?: string;
  title?: string;
  /** 当前章节序号（真实排序） */
  realChapterOrder?: string;
  order?: string;
  /** 全书章节总数 */
  serialCount?: string;
  /** 本章字数 */
  chapterWordNumber?: string;
  /** 下一章 itemId */
  nextItemId?: string;
  /** 上一章 itemId */
  preItemId?: string;
}

/**
 * 番茄小说插件实现
 */
export class FanqiePlugin implements ReaderPlugin {
  readonly manifest: PluginManifest = manifest as PluginManifest;

  private api: PluginAPI | null = null;
  private cleanupFunctions: Array<() => void> = [];

  // ==================== 生命周期 ====================

  onLoad(api: PluginAPI): void {
    this.api = api;
    api.log.info('Fanqie plugin loaded');

    // 订阅设置变化
    const unsubscribe = api.settings.subscribe((settings) => {
      this.applySettings(settings);
    });
    this.cleanupFunctions.push(unsubscribe);

    // 应用初始设置
    this.applySettings(api.settings.getAll());
  }

  onUnload(): void {
    // 清理所有订阅和监听器
    this.cleanupFunctions.forEach((fn) => fn());
    this.cleanupFunctions = [];

    // 移除注入的样式
    if (this.api) {
      this.api.style.remove('wide');
      this.api.style.remove('toolbar');
      this.api.log.info('Fanqie plugin unloaded');
    }

    this.api = null;
  }

  // ==================== 路由检测 ====================

  isReaderPage(): boolean {
    return window.location.pathname.includes('/reader/');
  }

  isHomePage(): boolean {
    const pathname = window.location.pathname;
    return pathname === '/' || pathname === '' || pathname.startsWith('/library');
  }

  matchesDomain(): boolean {
    const hostname = window.location.hostname;
    const domains = Array.isArray(this.manifest.site?.domain)
      ? this.manifest.site.domain
      : [this.manifest.site?.domain];

    return domains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  }

  // ==================== 翻页控制 ====================
  // 番茄阅读页原生支持键盘左右键切章（页面提示：试试使用键盘左右键切章吧！）

  nextPage(): void {
    this.triggerKey('ArrowRight');
  }

  prevPage(): void {
    this.triggerKey('ArrowLeft');
  }

  private triggerKey(key: string): void {
    const event = new KeyboardEvent('keydown', {
      key: key,
      code: key,
      keyCode: key === 'ArrowRight' ? 39 : key === 'ArrowLeft' ? 37 : 0,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
  }

  // ==================== 样式提供 ====================

  getStyles(): PluginStyles {
    return {
      wideMode: STYLES.wide,
      toolbar: STYLES.toolbar,
    };
  }

  // ==================== 可选能力 ====================

  isAtBottom(): boolean {
    // 番茄为整页滚动、一章一页，使用滚动位置判断
    const totalHeight = document.documentElement.scrollHeight;
    const currentPos = window.innerHeight + window.scrollY;
    return currentPos >= totalHeight - 300;
  }

  getChapterProgress(): number {
    // 以「当前章节序号 / 全书章节数」估算全书进度（粗粒度，v1 够用）
    const cd = this.getChapterData();
    if (!cd) return 0;

    const order = parseInt(cd.realChapterOrder || cd.order || '0', 10);
    const total = parseInt(cd.serialCount || '0', 10);
    if (!total || total <= 0) return 0;

    return Math.min(100, Math.round((order / total) * 100));
  }

  async getBookProgress(): Promise<BookProgress | null> {
    // 只读页面本就公开的章节元数据，不调接口、不抓正文
    const cd = this.getChapterData();
    if (!cd) return null;

    const order = parseInt(cd.realChapterOrder || cd.order || '0', 10);
    const total = parseInt(cd.serialCount || '0', 10);

    return {
      progress: total > 0 ? Math.round((order / total) * 100) : 0,
      chapterIdx: order,
      summary: cd.bookName
        ? `${cd.bookName} · 第 ${order}/${total || '?'} 章`
        : undefined,
    };
  }

  getReaderMenuItems(): string[] {
    return ['reader_wide', 'hide_toolbar'];
  }

  // ==================== 私有方法 ====================

  private applySettings(settings: Record<string, any>): void {
    if (!this.api || !this.isReaderPage()) return;

    const styles = this.getStyles();

    // 宽屏模式
    if (styles.wideMode) {
      const css = settings.readerWide
        ? styles.wideMode.enabled
        : styles.wideMode.disabled;
      this.api.style.inject('wide', css);
    }

    // 工具栏（沉浸模式隐藏侧边工具栏）
    if (styles.toolbar) {
      const css = settings.hideToolbar
        ? styles.toolbar.enabled
        : styles.toolbar.disabled;
      this.api.style.inject('toolbar', css);
    }
  }

  /**
   * 读取当前章节元数据（来自页面公开的 __INITIAL_STATE__）
   * 仅读取排序/字数/导航指针等元信息，不触碰 content 正文字段。
   */
  private getChapterData(): FanqieChapterData | null {
    try {
      const state = (window as any).__INITIAL_STATE__;
      const cd = state?.reader?.chapterData;
      if (cd && typeof cd === 'object') {
        return cd as FanqieChapterData;
      }
    } catch {
      // 忽略读取错误
    }
    return null;
  }
}

/**
 * 插件工厂函数
 * 用于 PluginLoader 创建插件实例
 */
export const createFanqiePlugin = (): ReaderPlugin => new FanqiePlugin();

// 默认导出
export default FanqiePlugin;
