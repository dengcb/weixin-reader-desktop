import type { ReadingSiteAdapter } from '../adapters/reading_site_adapter';
import type { SiteRegistry } from './site_registry';
import { getSiteRegistry } from './site_registry';
import { log } from './logger';

/**
 * 站点上下文类
 * 提供统一的站点检测和适配器访问,避免各管理器重复调用 getSiteRegistry()
 * 使用动态 getter 确保状态始终是最新的
 * 这是一个单例类，所有管理器共享同一个实例
 */
export class SiteContext {
  /** 站点注册表单例 */
  public readonly registry: SiteRegistry;

  /** 缓存的双栏模式状态 */
  private _cachedIsDoubleColumn: boolean | null = null;

  /** 双栏模式变化的监听器 */
  private doubleColumnListeners: Set<(isDoubleColumn: boolean) => void> = new Set();

  /** MutationObserver 实例 */
  private doubleColumnObserver: MutationObserver | null = null;

  /** 是否已初始化 MutationObserver */
  private observerInitialized = false;

  /** 是否正在监听（控制 Observer 的启停） */
  private isObserving = false;

  /** 节流定时器 */
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  /** 节流间隔（毫秒）- 增加到 1000ms 以降低 CPU 占用 */
  private readonly THROTTLE_INTERVAL = 1000;

  // 单例实例
  private static instance: SiteContext | null = null;

  // 私有构造函数
  private constructor() {
    this.registry = getSiteRegistry();
    // 不再自动启动 Observer，改为按需调用 startObserving()
  }

  /**
   * 获取 SiteContext 单例实例
   */
  static getInstance(): SiteContext {
    if (!SiteContext.instance) {
      SiteContext.instance = new SiteContext();
    }
    return SiteContext.instance;
  }

  /**
   * 初始化双栏模式监听器
   * 监听 DOM 变化，当检测到双栏模式变化时通知所有监听器
   */
  private initDoubleColumnObserver() {
    log.info('[SiteContext] initDoubleColumnObserver: starting initialization');

    // 防止重复初始化
    if (this.observerInitialized) {
      log.info('[SiteContext] initDoubleColumnObserver: already initialized, skipping');
      return;
    }

    const startObserving = () => {
      const oldValue = this._cachedIsDoubleColumn;
      const newValue = this.detectDoubleColumn();

      // 如果值变了，通知所有监听器
      if (oldValue !== newValue) {
        this._cachedIsDoubleColumn = newValue;
        this.notifyDoubleColumnChange(newValue);
        log.info('[SiteContext] Double column mode changed:', newValue);
      }
    };

    // 初始化 observer 的函数
    const initObserver = () => {
      // 防止重复初始化
      if (this.observerInitialized) {
        return;
      }
      this.observerInitialized = true;

      log.info('[SiteContext] initObserver: MutationObserver initialized');

      // 使用 MutationObserver 监听 DOM 变化（带节流）
      const observer = new MutationObserver(() => {
        // 节流：限制检测频率，避免频繁触发
        if (this.throttleTimer) {
          return;
        }
        this.throttleTimer = setTimeout(() => {
          this.throttleTimer = null;
          startObserving();
        }, this.THROTTLE_INTERVAL);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,  // ← 关键修复：监听属性变化
        attributeFilter: ['class']  // ← 只监听 class 属性
      });

      this.doubleColumnObserver = observer;

      // 立即执行一次检测并缓存初始值
      const initialValue = this.detectDoubleColumn();
      this._cachedIsDoubleColumn = initialValue;
      log.info('[SiteContext] Initial double column value:', initialValue);
    };

    // 根据 DOM 加载状态决定何时初始化
    if (document.readyState === 'loading') {
      // DOM 还在加载，等待 DOMContentLoaded 事件
      log.info('[SiteContext] initDoubleColumnObserver: readyState is loading, waiting for DOMContentLoaded');
      document.addEventListener('DOMContentLoaded', initObserver);
    } else if (document.body) {
      // DOM 已加载且 body 存在，立即初始化
      log.info('[SiteContext] initDoubleColumnObserver: DOM ready and body exists, calling initObserver immediately');
      initObserver();
    } else {
      // 边缘情况：readyState 不是 loading 但 body 还不存在
      // 这通常发生在文档解析过程中，监听 DOMContentLoaded
      log.info('[SiteContext] initDoubleColumnObserver: DOM ready but body missing, waiting for DOMContentLoaded');
      document.addEventListener('DOMContentLoaded', initObserver);
    }
  }

  /**
   * 检测当前是否为双栏模式
   * 微信读书：检查 .wr_horizontalReader class
   * 其他站点：使用适配器的 isDoubleColumn 方法
   */
  private detectDoubleColumn(): boolean {
    const adapter = this.currentAdapter;

    if (!adapter) {
      return false;
    }

    // 微信读书特殊处理：检查 .wr_horizontalReader
    if (adapter.id === 'weread') {
      const element = document.querySelector('.wr_horizontalReader');
      return !!element;
    }

    // 其他站点使用适配器的方法
    if (adapter.isDoubleColumn) {
      return adapter.isDoubleColumn();
    }

    return false;
  }

  /**
   * 通知所有监听器双栏模式变化
   */
  private notifyDoubleColumnChange(isDoubleColumn: boolean) {
    log.info('[SiteContext] notifyDoubleColumnChange: notifying', this.doubleColumnListeners.size, 'listeners, isDoubleColumn=', isDoubleColumn);
    this.doubleColumnListeners.forEach(listener => {
      try {
        listener(isDoubleColumn);
      } catch (e) {
        log.error('[SiteContext] Error in double column listener:', e);
      }
    });
  }

  /**
   * 监听双栏模式变化
   */
  onDoubleColumnChange(callback: (isDoubleColumn: boolean) => void): () => void {
    this.doubleColumnListeners.add(callback);

    // 立即发送当前值给新注册的监听器（同步调用，无需额外调度）
    const currentValue = this.isDoubleColumn;
    try {
      callback(currentValue);
    } catch (e) {
      log.error('[SiteContext] Error in immediate double column callback:', e);
    }

    // 返回取消监听的函数
    return () => {
      this.doubleColumnListeners.delete(callback);
    };
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
   * 是否为双栏阅读模式
   * 使用缓存的值，避免每次调用都查询 DOM
   * MutationObserver 会自动更新缓存值
   */
  get isDoubleColumn(): boolean {
    // 如果有缓存值，直接返回
    if (this._cachedIsDoubleColumn !== null) {
      return this._cachedIsDoubleColumn;
    }
    // 如果还没有缓存（初始化前），执行一次检测
    const value = this.detectDoubleColumn();
    this._cachedIsDoubleColumn = value;
    return value;
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

  /**
   * 启动双栏模式监听（按需调用）
   * 由 IPCManager 在进入阅读页时调用
   */
  startObserving(): void {
    if (this.isObserving || this.observerInitialized) {
      log.info('[SiteContext] startObserving: already observing, skipping');
      return;
    }
    this.initDoubleColumnObserver();
    this.isObserving = true;
    log.info('[SiteContext] Observer started');
  }

  /**
   * 停止双栏模式监听
   * 由 IPCManager 在离开阅读页或进入后台时调用
   */
  stopObserving(): void {
    if (!this.isObserving) {
      log.info('[SiteContext] stopObserving: not observing, skipping');
      return;
    }

    if (this.doubleColumnObserver) {
      this.doubleColumnObserver.disconnect();
      log.info('[SiteContext] MutationObserver disconnected');
    }
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
      log.info('[SiteContext] Throttle timer cleared');
    }
    this.isObserving = false;
    log.info('[SiteContext] Observer stopped');
  }

  /**
   * 销毁实例，清理所有资源
   */
  destroy(): void {
    log.info('[SiteContext] Destroying instance');
    this.stopObserving();
    this.doubleColumnListeners.clear();
    this.doubleColumnObserver = null;
    this.observerInitialized = false;
    this._cachedIsDoubleColumn = null;
    log.info('[SiteContext] Instance destroyed');
  }
}

/**
 * 创建站点上下文（单例模式）
 * @returns 单例 SiteContext 实例
 */
export const createSiteContext = (): SiteContext => {
  return SiteContext.getInstance();
};
