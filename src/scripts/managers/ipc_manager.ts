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
import { ScrollState } from '../core/scroll_state';
import { log } from '../core/logger';
import { BaseManager, Events, type EventName } from '../core/base_manager';

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
  private lastSavedReaderUrl = '';
  private lastSavedScrollY = 0;

  // Timers
  private scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private safetyTimeout: ReturnType<typeof setTimeout> | null = null;

  // Original History API methods
  private originalPushState: typeof history.pushState | null = null;
  private originalReplaceState: typeof history.replaceState | null = null;

  // Observer
  private titleObserver: MutationObserver | null = null;

  // 共享的路由检测函数
  private checkRouteHandler: (() => void) | null = null;

  constructor() {
    super();
    this.siteContext = createSiteContext();
    this.init();
  }

  private async init() {
    await settingsStore.init();

    // Safety fallback: Ensure scroll saving is enabled after 10 seconds
    this.safetyTimeout = setTimeout(() => {
      if (!ScrollState.isRestorationComplete()) {
        log.warn('[IPCManager] Force enabling scroll save after timeout');
        ScrollState.markRestorationComplete();
      }
    }, 10000);

    // Start monitoring
    this.monitorRoute();
    this.monitorTitle();
    this.monitorScroll();
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

    return () => {
      const currentUrl = window.location.href;
      const pathname = window.location.pathname;
      const isReader = this.siteContext.isReaderPage;
      const currentTitle = document.title;

      // 检测路由变化（进入/离开阅读页）
      const routeChanged = lastIsReader !== isReader;
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

  private handleLastPageSaving(isReader: boolean, currentUrl: string) {
    const settings = settingsStore.get();
    if (settings.lastPage && isReader) {
      if (settings.lastReaderUrl !== currentUrl) {
        settingsStore.update({ lastReaderUrl: currentUrl });
      }
    }
  }

  // =====================================================
  // Title Monitoring
  // =====================================================

  private monitorTitle() {
    const target = document.querySelector('title');
    if (!target) return;

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
    const scrollHandler = () => {
      // 只在阅读页且启用了 lastPage 时保存
      if (!this.currentIsReader) return;

      const settings = settingsStore.get();
      if (!settings.lastPage) return;

      // 单栏模式才保存滚动位置
      if (this.siteContext.isDoubleColumn) return;

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
        this.lastSavedScrollY = scrollY;
        const currentUrl = window.location.href;
        const currentProgress = settingsStore.get().readingProgress || {};

        settingsStore.update({
          scrollPosition: scrollY,
          readingProgress: { ...currentProgress, [currentUrl]: scrollY }
        });
      }, 500);
    };

    window.addEventListener('scroll', scrollHandler, { passive: true });
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
