import { ReadingSiteAdapter } from '../adapters/reading_site_adapter';

/**
 * 单例网站注册器
 * 负责管理所有阅读网站适配器的注册、检测和获取
 */
export class SiteRegistry {
  private static instance: SiteRegistry;
  private adapters: Map<string, ReadingSiteAdapter> = new Map();
  private currentAdapter: ReadingSiteAdapter | null = null;

  private constructor() {}

  /** 获取单例实例 */
  static getInstance(): SiteRegistry {
    if (!SiteRegistry.instance) {
      SiteRegistry.instance = new SiteRegistry();
    }
    return SiteRegistry.instance;
  }

  /**
   * 注册网站适配器
   */
  register(adapter: ReadingSiteAdapter): void {
    this.adapters.set(adapter.id, adapter);
    console.log(`[SiteRegistry] Registered adapter: ${adapter.name} (${adapter.id})`);
  }

  /**
   * 批量注册网站适配器
   */
  registerAll(adapters: ReadingSiteAdapter[]): void {
    adapters.forEach(adapter => this.register(adapter));
  }

  /**
   * 获取当前网站的适配器
   * 根据当前域名自动检测并返回对应的适配器
   */
  getCurrentAdapter(): ReadingSiteAdapter | null {
    // 如果已经有缓存的适配器，先检查是否还匹配
    if (this.currentAdapter) {
      const adapter = this.currentAdapter;
      if ('matchesCurrentDomain' in adapter && typeof adapter.matchesCurrentDomain === 'function') {
        if ((adapter as any).matchesCurrentDomain()) {
          return adapter;
        }
      }
    }

    // 遍历所有适配器查找匹配的
    for (const adapter of this.adapters.values()) {
      if ('matchesCurrentDomain' in adapter && typeof adapter.matchesCurrentDomain === 'function') {
        if ((adapter as any).matchesCurrentDomain()) {
          this.currentAdapter = adapter;
          console.log(`[SiteRegistry] Detected site: ${adapter.name}`);
          return adapter;
        }
      }
    }

    this.currentAdapter = null;
    console.warn('[SiteRegistry] No matching adapter found for current site');
    return null;
  }

  /**
   * 根据 ID 获取适配器
   */
  getAdapter(id: string): ReadingSiteAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * 获取所有已注册的适配器
   */
  getAllAdapters(): ReadingSiteAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * 检查当前页面是否是阅读页面
   */
  isReaderPage(): boolean {
    const adapter = this.getCurrentAdapter();
    return adapter ? adapter.isReaderPage() : false;
  }

  /**
   * 检查当前页面是否是首页
   */
  isHomePage(): boolean {
    const adapter = this.getCurrentAdapter();
    return adapter ? adapter.isHomePage() : false;
  }

  /**
   * 获取当前网站的菜单项
   * 返回仅在阅读页面时启用的菜单项 ID 数组
   */
  getReaderMenuItems(): string[] {
    const adapter = this.getCurrentAdapter();
    if (adapter && adapter.getReaderMenuItems) {
      return adapter.getReaderMenuItems();
    }
    // 默认菜单项
    return ['reader_wide', 'hide_toolbar', 'auto_flip'];
  }
}

// 导出单例获取函数
export const getSiteRegistry = () => SiteRegistry.getInstance();
