import type { ReadingSiteAdapter } from '../adapters/reading_site_adapter';
import type { SiteRegistry } from './site_registry';
import { getSiteRegistry } from './site_registry';

/**
 * 站点上下文类
 * 提供统一的站点检测和适配器访问,避免各管理器重复调用 getSiteRegistry()
 * 使用动态 getter 确保状态始终是最新的
 */
export class SiteContext {
  /** 站点注册表单例 */
  public readonly registry: SiteRegistry;

  constructor() {
    this.registry = getSiteRegistry();
  }

  /** 当前站点适配器(如果在支持的站点上) */
  get currentAdapter(): ReadingSiteAdapter | null {
    return this.registry.getCurrentAdapter();
  }

  /** 是否在阅读器页面 */
  get isReaderPage(): boolean {
    return this.registry.isReaderPage();
  }

  /** 是否在首页 */
  get isHomePage(): boolean {
    return this.registry.isHomePage();
  }

  /**
   * 获取当前站点 ID
   * 用于访问站点特定设置
   * @returns 站点 ID (如 'weread')，如果没有匹配的适配器则返回 'unknown'
   */
  get siteId(): string {
    const adapter = this.currentAdapter;
    return adapter?.id || 'unknown';
  }
}

/**
 * 创建站点上下文
 * @returns 当前的站点上下文
 */
export const createSiteContext = (): SiteContext => {
  return new SiteContext();
};
