/**
 * 微信读书插件
 * WeRead Plugin for AT Reader
 * 
 * 将微信读书网站适配为标准阅读器插件
 */

import type {
  ReaderPlugin,
  PluginManifest,
  PluginStyles,
  PluginAPI,
  BookProgress,
} from '../../../scripts/core/plugin_types';

// 导入 manifest（构建时会被内联）
import manifest from './manifest.json';

// 样式常量
const STYLES = {
  wide: {
    enabled: `
      .readerTopBar,
      body:has(.readerControls[is-horizontal="true"]) .readerChapterContent,
      .app_content {
        width: 96% !important;
        max-width: calc(100vw - 224px) !important;
      }
      body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
        margin-left: calc(50vw - 80px) !important;
      }
    `,
    disabled: `
      .readerTopBar,
      body:has(.readerControls[is-horizontal="true"]) .readerChapterContent,
      .app_content {
        width: 80% !important;
        max-width: calc(100vw - 424px) !important;
      }
      body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
        margin-left: calc(40% + 40px) !important;
      }
    `,
  },
  toolbar: {
    enabled: `
      .readerControls {
        display: none !important;
      }
      .readerTopBar,
      .app_content,
      body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
        max-width: calc(100vw - 124px) !important;
      }
    `,
    disabled: `
      .readerControls {
        display: block !important;
      }
      .readerTopBar,
      .app_content,
      body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
        max-width: calc(100vw - 224px) !important;
      }
    `,
  },
  navbar: {
    enabled: `
      .readerTopBar,
      .renderTarget_pager {
        display: none !important;
      }
      body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
        margin-top: 24px !important;
        height: calc(100% - 48px) !important;
      }
    `,
    disabled: `
      .readerTopBar,
      .renderTarget_pager {
        display: flex !important;
      }
      body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
        margin-top: 72px !important;
        height: calc(100% - 132px) !important;
      }
    `,
  },
  theme: {
    dark: `body { background-color: #2c2c2c !important; }`,
    light: `body { background-color: #f4f5f7 !important; }`,
  },
};

/**
 * 微信读书插件实现
 */
export class WeReadPlugin implements ReaderPlugin {
  readonly manifest: PluginManifest = manifest as PluginManifest;
  
  private api: PluginAPI | null = null;
  private cleanupFunctions: Array<() => void> = [];
  
  // ==================== 生命周期 ====================
  
  onLoad(api: PluginAPI): void {
    this.api = api;
    api.log.info('WeRead plugin loaded');
    
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
    this.cleanupFunctions.forEach(fn => fn());
    this.cleanupFunctions = [];
    
    // 移除注入的样式
    if (this.api) {
      this.api.style.remove('wide');
      this.api.style.remove('toolbar');
      this.api.style.remove('navbar');
      this.api.style.remove('theme');
      this.api.log.info('WeRead plugin unloaded');
    }
    
    this.api = null;
  }
  
  // ==================== 路由检测 ====================
  
  isReaderPage(): boolean {
    return window.location.pathname.includes('/web/reader/');
  }
  
  isHomePage(): boolean {
    const pathname = window.location.pathname;
    return pathname === '/' || pathname === '/web' || pathname.startsWith('/web/shelf');
  }
  
  matchesDomain(): boolean {
    const hostname = window.location.hostname;
    const domains = Array.isArray(this.manifest.site?.domain) 
      ? this.manifest.site.domain 
      : [this.manifest.site?.domain];
    
    return domains.some(domain => 
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
  }
  
  // ==================== 翻页控制 ====================
  
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
      navbar: STYLES.navbar,
      theme: STYLES.theme,
    };
  }
  
  // ==================== 可选能力 ====================
  
  isDoubleColumn(): boolean {
    return !!document.querySelector('.wr_horizontalReader');
  }
  
  isAtBottom(): boolean {
    if (this.isDoubleColumn()) {
      // 双栏模式暂不支持
      return false;
    }
    // 单栏模式使用滚动位置判断
    const totalHeight = document.documentElement.scrollHeight;
    const currentPos = window.innerHeight + window.scrollY;
    return currentPos >= totalHeight - 300;
  }
  
  getChapterProgress(): number {
    // TODO: 从 ProgressTracker 获取
    return 0;
  }
  
  async getBookProgress(): Promise<BookProgress | null> {
    const bookId = this.getNumericBookId();
    if (!bookId) return null;
    
    try {
      const response = await fetch(
        `https://weread.qq.com/web/book/getProgress?bookId=${bookId}&_=${Date.now()}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
          },
        }
      );
      
      if (!response.ok) return null;
      
      const data = await response.json();
      if (data.errCode && data.errCode !== 0) return null;
      
      if (data.book) {
        return {
          progress: data.book.progress,
          chapterIdx: data.book.chapterIdx,
          chapterUid: data.book.chapterUid,
        };
      }
      
      return null;
    } catch (error) {
      this.api?.log.error('Failed to fetch book progress', error);
      return null;
    }
  }
  
  getReaderMenuItems(): string[] {
    return ['reader_wide', 'hide_toolbar', 'hide_navbar', 'auto_flip'];
  }
  
  // ==================== 私有方法 ====================
  
  private applySettings(settings: Record<string, any>): void {
    if (!this.api || !this.isReaderPage()) return;
    
    const styles = this.getStyles();
    
    // 宽屏模式
    if (styles.wideMode) {
      const css = settings.readerWide ? styles.wideMode.enabled : styles.wideMode.disabled;
      this.api.style.inject('wide', css);
    }
    
    // 工具栏
    if (styles.toolbar) {
      const css = settings.hideToolbar ? styles.toolbar.enabled : styles.toolbar.disabled;
      this.api.style.inject('toolbar', css);
    }
    
    // 导航栏（仅双栏模式）
    if (styles.navbar && this.isDoubleColumn()) {
      const css = settings.hideNavbar ? styles.navbar.enabled : styles.navbar.disabled;
      this.api.style.inject('navbar', css);
    }
  }
  
  private getNumericBookId(): string | null {
    // 方法1: 从 JSON-LD script 标签中提取
    const jsonLdScript = document.querySelector('script[type="application/ld+json"]');
    if (jsonLdScript?.textContent) {
      try {
        const data = JSON.parse(jsonLdScript.textContent);
        if (data['@Id']) {
          return data['@Id'];
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
    
    // 方法2: 从全局变量中提取
    if ((window as any).bookId) {
      return String((window as any).bookId);
    }
    
    return null;
  }
}

/**
 * 插件工厂函数
 * 用于 PluginLoader 创建插件实例
 */
export const createWeReadPlugin = (): ReaderPlugin => new WeReadPlugin();

// 默认导出
export default WeReadPlugin;
