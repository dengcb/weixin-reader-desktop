/**
 * 插件模板 - 主文件
 * Plugin Template - Main File
 * 
 * 这是一个标准的阅读器插件模板
 * 开发者可以基于此模板快速创建自己的插件
 * 
 * 使用方法：
 * 1. 复制整个 template 目录
 * 2. 修改 manifest.json 中的配置
 * 3. 实现下面的各个方法
 * 4. 在 styles/ 目录下添加 CSS 样式
 */

import type {
  ReaderPlugin,
  PluginManifest,
  PluginStyles,
  PluginAPI,
  BookProgress,
} from '../../scripts/core/plugin_types';

// 导入 manifest
import manifest from './manifest.json';

/**
 * 样式定义
 * 根据你的目标网站结构修改选择器和样式
 */
const STYLES = {
  // 宽屏模式样式
  wide: {
    enabled: `
      /* TODO: 添加宽屏模式启用时的 CSS */
      .reader-content {
        max-width: 100% !important;
      }
    `,
    disabled: `
      /* TODO: 添加宽屏模式禁用时的 CSS */
      .reader-content {
        max-width: 800px !important;
      }
    `,
  },
  
  // 工具栏样式
  toolbar: {
    enabled: `
      /* TODO: 添加隐藏工具栏的 CSS */
      .toolbar {
        display: none !important;
      }
    `,
    disabled: `
      /* TODO: 添加显示工具栏的 CSS */
      .toolbar {
        display: block !important;
      }
    `,
  },
  
  // 导航栏样式（可选）
  navbar: {
    enabled: `
      /* TODO: 添加隐藏导航栏的 CSS */
      .navbar {
        display: none !important;
      }
    `,
    disabled: `
      /* TODO: 添加显示导航栏的 CSS */
      .navbar {
        display: block !important;
      }
    `,
  },
  
  // 主题样式（可选）
  theme: {
    dark: `
      /* TODO: 添加深色主题 CSS */
      body {
        background-color: #1a1a1a !important;
        color: #e0e0e0 !important;
      }
    `,
    light: `
      /* TODO: 添加浅色主题 CSS */
      body {
        background-color: #ffffff !important;
        color: #333333 !important;
      }
    `,
  },
};

/**
 * 插件实现类
 */
export class MyPlugin implements ReaderPlugin {
  readonly manifest: PluginManifest = manifest as PluginManifest;
  
  private api: PluginAPI | null = null;
  private cleanupFunctions: Array<() => void> = [];
  
  // ==================== 生命周期方法 ====================
  
  /**
   * 插件加载时调用
   * 在这里初始化插件，订阅事件，设置监听器等
   */
  onLoad(api: PluginAPI): void {
    this.api = api;
    api.log.info(`${this.manifest.name} 插件已加载`);
    
    // 订阅设置变化
    const unsubscribe = api.settings.subscribe((settings) => {
      this.applySettings(settings);
    });
    this.cleanupFunctions.push(unsubscribe);
    
    // 应用初始设置
    this.applySettings(api.settings.getAll());
    
    // TODO: 添加其他初始化逻辑
  }
  
  /**
   * 插件卸载时调用
   * 在这里清理所有资源，移除事件监听器等
   */
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
      this.api.log.info(`${this.manifest.name} 插件已卸载`);
    }
    
    this.api = null;
  }
  
  // ==================== 路由检测方法 ====================
  
  /**
   * 检测当前页面是否是阅读页面
   * TODO: 根据目标网站的 URL 结构修改
   */
  isReaderPage(): boolean {
    const pattern = this.manifest.site?.readerPattern;
    if (!pattern) return false;
    return window.location.pathname.includes(pattern);
  }
  
  /**
   * 检测当前页面是否是首页
   * TODO: 根据目标网站的 URL 结构修改
   */
  isHomePage(): boolean {
    const pathname = window.location.pathname;
    return pathname === '/' || pathname === '/home';
  }
  
  /**
   * 检测当前域名是否匹配
   * 一般不需要修改
   */
  matchesDomain(): boolean {
    const hostname = window.location.hostname;
    const domains = Array.isArray(this.manifest.site?.domain) 
      ? this.manifest.site.domain 
      : [this.manifest.site?.domain];
    
    return domains.some(domain => 
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
  }
  
  // ==================== 翻页控制方法 ====================
  
  /**
   * 下一页
   * TODO: 根据目标网站的翻页方式修改
   */
  nextPage(): void {
    // 方式1：模拟键盘事件
    this.triggerKey('ArrowRight');
    
    // 方式2：点击按钮
    // this.clickElement('.next-page-button');
    
    // 方式3：滚动页面
    // window.scrollBy(0, window.innerHeight * 0.9);
  }
  
  /**
   * 上一页
   * TODO: 根据目标网站的翻页方式修改
   */
  prevPage(): void {
    // 方式1：模拟键盘事件
    this.triggerKey('ArrowLeft');
    
    // 方式2：点击按钮
    // this.clickElement('.prev-page-button');
    
    // 方式3：滚动页面
    // window.scrollBy(0, -window.innerHeight * 0.9);
  }
  
  // ==================== 样式提供方法 ====================
  
  /**
   * 获取插件样式集合
   */
  getStyles(): PluginStyles {
    return {
      wideMode: STYLES.wide,
      toolbar: STYLES.toolbar,
      navbar: STYLES.navbar,
      theme: STYLES.theme,
    };
  }
  
  // ==================== 可选能力方法 ====================
  
  /**
   * 检测是否为双栏模式
   * TODO: 根据目标网站的布局判断
   */
  isDoubleColumn(): boolean {
    // 示例：检查是否存在双栏阅读器元素
    return !!document.querySelector('.double-column-reader');
  }
  
  /**
   * 检测是否滚动到底部
   */
  isAtBottom(): boolean {
    const totalHeight = document.documentElement.scrollHeight;
    const currentPos = window.innerHeight + window.scrollY;
    return currentPos >= totalHeight - 100;
  }
  
  /**
   * 获取当前章节进度（0-100）
   * TODO: 根据目标网站的进度显示方式获取
   */
  getChapterProgress(): number {
    // 示例：从页面元素获取进度
    const progressEl = document.querySelector('.progress-text');
    if (progressEl) {
      const match = progressEl.textContent?.match(/(\d+)%/);
      if (match) return parseInt(match[1], 10);
    }
    
    // 备选：根据滚动位置计算
    const scrollTop = window.scrollY;
    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
    return scrollHeight > 0 ? Math.round((scrollTop / scrollHeight) * 100) : 0;
  }
  
  /**
   * 获取书籍进度（从 API）
   * TODO: 如果目标网站有进度 API，在这里实现
   */
  async getBookProgress(): Promise<BookProgress | null> {
    // 示例：从网站 API 获取进度
    // try {
    //   const response = await fetch('/api/book/progress');
    //   const data = await response.json();
    //   return {
    //     progress: data.progress,
    //     chapterIdx: data.chapterIdx,
    //   };
    // } catch (e) {
    //   return null;
    // }
    
    return null;
  }
  
  /**
   * 获取阅读器专用菜单项 ID
   */
  getReaderMenuItems(): string[] {
    return ['reader_wide', 'hide_toolbar', 'auto_flip'];
  }
  
  // ==================== 私有辅助方法 ====================
  
  /**
   * 应用设置
   */
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
    
    // 导航栏
    if (styles.navbar) {
      const css = settings.hideNavbar ? styles.navbar.enabled : styles.navbar.disabled;
      this.api.style.inject('navbar', css);
    }
  }
  
  /**
   * 模拟键盘按键
   */
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
  
  /**
   * 点击元素
   */
  private clickElement(selector: string): boolean {
    const element = document.querySelector(selector) as HTMLElement;
    if (element) {
      element.click();
      return true;
    }
    return false;
  }
}

/**
 * 插件工厂函数
 * 用于 PluginLoader 创建插件实例
 */
export const createMyPlugin = (): ReaderPlugin => new MyPlugin();

// 默认导出
export default MyPlugin;
