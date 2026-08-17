/**
 * IPC Manager - Central Event Bus (Refactored)
 *
 * Responsibilities:
 * - Monitor route changes (popstate, pushState, replaceState)
 * - Monitor title changes
 * - Monitor scroll position
 * - Dispatch events via EventBus
 *
 * Events dispatched:
 * - Events.ROUTE_CHANGED -> { isReader: boolean, url: string, pathname: string }
 * - Events.CHAPTER_CHANGED -> { url: string, pathname: string }
 * - Events.TITLE_CHANGED -> { title: string }
 */

import { createSiteContext, SiteContext } from '../core/site_context';
import { settingsStore } from '../core/settings_store';
import { invoke } from '../core/tauri';
import { ScrollState } from '../core/scroll_state';
import { log } from '../core/logger';
import { BaseManager, Events } from '../core/base_manager';
import { saveReadingPosition } from '../core/reading_position';

export type RouteChangedEvent = {
  isReader: boolean;
  url: string;
  pathname: string;
};

export type ChapterChangedEvent = {
  url: string;
  pathname: string;
};

export type TitleChangedEvent = {
  title: string;
};

export class IPCManager extends BaseManager {
  private siteContext: SiteContext;
  private currentIsReader = false;
  private lastSavedScrollY = 0;

  // Timers
  private scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private safetyTimeout: ReturnType<typeof setTimeout> | null = null;
  private titleRetryTimer: ReturnType<typeof setTimeout> | null = null;

  // Original History API methods
  private originalPushState: typeof history.pushState | null = null;
  private originalReplaceState: typeof history.replaceState | null = null;

  // Observer
  private titleObserver: MutationObserver | null = null;

  // 共享的路由检测函数
  private checkRouteHandler: (() => void) | null = null;
  private scrollHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;

  constructor() {
    super();
    this.siteContext = createSiteContext();
    this.init();
  }

  private async init() {
    await settingsStore.init();
    if (this.destroyed) return;

    // Safety fallback: Ensure scroll saving is enabled after 10 seconds
    this.safetyTimeout = setTimeout(() => {
      this.safetyTimeout = null;
      if (this.destroyed) return;
      if (!ScrollState.isRestorationComplete()) {
        log.warn('[IPCManager] Force enabling scroll save after timeout');
        ScrollState.markRestorationComplete();
      }
    }, 10000);

    // Start monitoring
    this.monitorRoute();
    this.monitorTitle();
    this.monitorScroll();
    this.monitorVisibility();
  }

  // =====================================================
  // Route Monitoring
  // =====================================================

  private monitorRoute() {
    // 创建共享的路由检测函数
    this.checkRouteHandler = this.createRouteHandler();

    // 监听导航事件
    window.addEventListener('popstate', this.checkRouteHandler);

    // Hook History API
    this.originalPushState = history.pushState;
    history.pushState = (...args) => {
      const result = this.originalPushState!.apply(history, args);
      this.checkRouteHandler!();
      return result;
    };

    this.originalReplaceState = history.replaceState;
    history.replaceState = (...args) => {
      const result = this.originalReplaceState!.apply(history, args);
      this.checkRouteHandler!();
      return result;
    };

    // 初始检查
    this.checkRouteHandler();
  }

  private createRouteHandler: () => (() => void) = () => {
    // 使用闭包保存状态，避免每次创建新函数
    let lastUrl = window.location.href;
    let lastIsReader = this.siteContext.isReaderPage;
    let lastTitle = document.title;
    let initial = true;

    return () => {
      const currentUrl = window.location.href;
      const pathname = window.location.pathname;
      const isReader = this.siteContext.isReaderPage;
      const currentTitle = document.title;

      // 检测路由变化（进入/离开阅读页）
      const routeChanged = initial || lastIsReader !== isReader;
      initial = false;
      lastIsReader = isReader;
      this.currentIsReader = isReader;

      // 检测章节切换（URL 变化 或 Title 变化）
      // 微信读书双栏模式下，切换章节时 URL 可能不变，只有 Title 变化
      const urlChanged = lastUrl !== currentUrl;
      const titleChanged = lastTitle !== currentTitle;
      const chapterChanged = isReader && (urlChanged || titleChanged);

      // 保存最后阅读页面
      this.handleLastPageSaving(isReader, currentUrl);

      // 分发事件
      if (routeChanged) {
        const eventData = { isReader, url: currentUrl, pathname };

        // 新系统：通过 EventBus
        this.emit(Events.ROUTE_CHANGED, eventData);

        // 兼容旧系统：同时发送到 window
        window.dispatchEvent(new CustomEvent('ipc:route-changed', { detail: eventData }));
        window.dispatchEvent(new CustomEvent('wxrd:route-changed', { detail: eventData }));

        // 控制 SiteContext MutationObserver 的启停
        if (isReader) {
          this.siteContext.startObserving();
          log.info('[IPCManager] Entered reader page, started SiteContext observer');
        } else {
          this.siteContext.stopObserving();
          log.info('[IPCManager] Left reader page, stopped SiteContext observer');
        }
      }

      if (chapterChanged) {
        const eventData = { url: currentUrl, pathname };

        // 新系统：通过 EventBus
        this.emit(Events.CHAPTER_CHANGED, eventData);

        // 兼容旧系统：同时发送到 window
        window.dispatchEvent(new CustomEvent('ipc:chapter-changed', { detail: eventData }));
      }

      lastUrl = currentUrl;
      lastTitle = currentTitle;
    };
  };

  private handleLastPageSaving(_isReader: boolean, _currentUrl: string) {
    // 多站点：站点身份以「活跃插件」为准（旧适配器仅覆盖微信读书）
    const active = this.siteContext.currentRuntime;
    const siteId = active?.id;
    // 未匹配任何站点插件时不记录，避免污染
    if (!siteId) return;

    // 记录当前活跃站点（即使在首页也记录，便于启动选站）
    const global = settingsStore.get().global;
    if (global?.lastSiteId !== siteId) {
      settingsStore.updateGlobal({ lastSiteId: siteId });
      // 同步书店菜单对勾到当前站点
      invoke('set_active_bookstore', { siteId }).catch(() => {});
    }

    // 阅读页时保存该站点上次阅读页；离开阅读页时清除
    // 这样返回首页后切换书店，回来停在首页而不是跳回书里
    if (active!.isReaderPage()) {
      const url = window.location.href;
      const site = settingsStore.getSite(siteId);
      if (site.lastReaderUrl !== url) {
        settingsStore.updateSite(siteId, { lastReaderUrl: url });
      }
    } else {
      const site = settingsStore.getSite(siteId);
      if (site.lastReaderUrl) {
        settingsStore.updateSite(siteId, { lastReaderUrl: null });
      }
    }
  }

  // =====================================================
  // Title Monitoring
  // =====================================================

  private monitorTitle() {
    if (this.destroyed) return;
    const target = document.querySelector('title');
    if (!target) {
      // 页面可能还没加载完，延迟重试
      this.titleRetryTimer = setTimeout(() => {
        this.titleRetryTimer = null;
        this.monitorTitle();
      }, 500);
      return;
    }

    const dispatch = () => {
      if (document.title?.trim()) {
        const eventData = { title: document.title };

        // 新系统：通过 EventBus
        this.emit(Events.TITLE_CHANGED, eventData);

        // 兼容旧系统：同时发送到 window
        window.dispatchEvent(new CustomEvent('ipc:title-changed', { detail: eventData }));

        // Title 变化时调用共享的章节检测（微信读书双栏模式可能只改 Title）
        if (this.checkRouteHandler) {
          this.checkRouteHandler();
        }
      }
    };

    this.titleObserver = new MutationObserver(dispatch);
    this.titleObserver.observe(target, { childList: true, characterData: true, subtree: true });

    // 初始分发
    dispatch();
  }

  // =====================================================
  // Scroll Monitoring
  // =====================================================

  private monitorScroll() {
    this.scrollHandler = () => {
      // 只在阅读页且启用了 lastPage 时保存
      if (!this.currentIsReader) return;

      const settings = settingsStore.get();
      if (!settings.lastPage) return;

      // 分页阅读器自行保存结构化位置，只有滚动模式保存 window.scrollY。
      if (this.siteContext.isPaginated) return;

      // 恢复期间不保存
      if (!ScrollState.isRestorationComplete()) return;

      const scrollY = window.scrollY;

      // 变化超过 50px 才保存
      if (Math.abs(scrollY - this.lastSavedScrollY) < 50) return;

      // 防抖：500ms 无滚动后才保存
      if (this.scrollSaveTimer) {
        clearTimeout(this.scrollSaveTimer);
      }

      this.scrollSaveTimer = setTimeout(() => {
        this.scrollSaveTimer = null;
        if (this.destroyed) return;
        this.lastSavedScrollY = scrollY;
        const currentUrl = window.location.href;
        const active = this.siteContext.currentRuntime;
        const sid = active?.id;
        if (!sid) return;

        saveReadingPosition(sid, currentUrl, scrollY).catch((error) => {
          log.error('[IPCManager] Failed to save reading position', error);
        });
      }, 500);
    };

    window.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  // =====================================================
  // Visibility Monitoring (SiteContext Observer 控制)
  // =====================================================

  private monitorVisibility() {
    this.visibilityHandler = () => {
      if (document.hidden) {
        // 进入后台：停止 SiteContext Observer
        this.siteContext.stopObserving();
        log.info('[IPCManager] Document hidden, stopped SiteContext observer');
      } else {
        // 返回前台：如果在阅读页，重新启动 Observer
        if (this.currentIsReader) {
          this.siteContext.startObserving();
          log.info('[IPCManager] Document visible and on reader page, started SiteContext observer');
        }
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler();
  }

  // =====================================================
  // Cleanup
  // =====================================================

  destroy(): void {
    // 清理定时器
    if (this.scrollSaveTimer) {
      clearTimeout(this.scrollSaveTimer);
      this.scrollSaveTimer = null;
    }
    if (this.safetyTimeout) {
      clearTimeout(this.safetyTimeout);
      this.safetyTimeout = null;
    }
    if (this.titleRetryTimer) {
      clearTimeout(this.titleRetryTimer);
      this.titleRetryTimer = null;
    }

    if (this.checkRouteHandler) {
      window.removeEventListener('popstate', this.checkRouteHandler);
    }
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    // 恢复 History API
    if (this.originalPushState) {
      history.pushState = this.originalPushState;
      this.originalPushState = null;
    }
    if (this.originalReplaceState) {
      history.replaceState = this.originalReplaceState;
      this.originalReplaceState = null;
    }

    // 断开观察器
    if (this.titleObserver) {
      this.titleObserver.disconnect();
      this.titleObserver = null;
    }

    // 调用基类的清理（会自动清理所有事件监听器）
    super.destroy();
  }
}
