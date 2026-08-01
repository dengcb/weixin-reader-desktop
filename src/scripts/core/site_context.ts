import { getPluginRegistry } from './plugin_registry';
import type { ReaderSiteRuntime } from './reader_site_runtime';
import { log } from './logger';

/** Managers 共享的当前站点上下文，站点来源唯一指向 PluginRegistry。 */
export class SiteContext {
  private static instance: SiteContext | null = null;
  private cachedIsDoubleColumn: boolean | null = null;
  private readonly doubleColumnListeners = new Set<(value: boolean) => void>();
  private doubleColumnObserver: MutationObserver | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private domReadyHandler: (() => void) | null = null;
  private isObserving = false;
  private readonly throttleInterval = 1000;

  private constructor() {}

  static getInstance(): SiteContext {
    if (!SiteContext.instance) SiteContext.instance = new SiteContext();
    return SiteContext.instance;
  }

  private observeBody(): void {
    if (!this.isObserving || !document.body) return;
    if (!this.doubleColumnObserver) {
      this.doubleColumnObserver = new MutationObserver(() => {
        if (this.throttleTimer) return;
        this.throttleTimer = setTimeout(() => {
          this.throttleTimer = null;
          this.refreshDoubleColumn();
        }, this.throttleInterval);
      });
    }
    this.doubleColumnObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    this.refreshDoubleColumn();
  }

  private refreshDoubleColumn(): void {
    const next = this.currentRuntime?.isDoubleColumn?.() ?? false;
    if (this.cachedIsDoubleColumn === next) return;
    this.cachedIsDoubleColumn = next;
    for (const listener of this.doubleColumnListeners) {
      try {
        listener(next);
      } catch (error) {
        log.error('[SiteContext] Double column listener failed', error);
      }
    }
  }

  get currentRuntime(): ReaderSiteRuntime | null {
    return getPluginRegistry().getActivePlugin()?.plugin ?? null;
  }

  get isReaderPage(): boolean { return this.currentRuntime?.isReaderPage() ?? false; }
  get isHomePage(): boolean { return this.currentRuntime?.isHomePage() ?? false; }

  get isDoubleColumn(): boolean {
    if (this.cachedIsDoubleColumn === null) {
      this.cachedIsDoubleColumn = this.currentRuntime?.isDoubleColumn?.() ?? false;
    }
    return this.cachedIsDoubleColumn;
  }

  get siteId(): string { return this.currentRuntime?.id ?? 'unknown'; }

  onDoubleColumnChange(callback: (value: boolean) => void): () => void {
    this.doubleColumnListeners.add(callback);
    callback(this.isDoubleColumn);
    return () => this.doubleColumnListeners.delete(callback);
  }

  startObserving(): void {
    if (this.isObserving) return;
    this.isObserving = true;
    if (document.body) {
      this.observeBody();
      return;
    }
    if (!this.domReadyHandler) {
      this.domReadyHandler = () => {
        this.domReadyHandler = null;
        this.observeBody();
      };
      document.addEventListener('DOMContentLoaded', this.domReadyHandler, { once: true });
    }
  }

  stopObserving(): void {
    if (!this.isObserving) return;
    this.isObserving = false;
    this.doubleColumnObserver?.disconnect();
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }

  invalidate(): void {
    this.cachedIsDoubleColumn = null;
    if (this.isObserving) this.refreshDoubleColumn();
  }

  destroy(): void {
    this.stopObserving();
    if (this.domReadyHandler) {
      document.removeEventListener('DOMContentLoaded', this.domReadyHandler);
      this.domReadyHandler = null;
    }
    this.doubleColumnObserver = null;
    this.doubleColumnListeners.clear();
    this.cachedIsDoubleColumn = null;
    SiteContext.instance = null;
  }
}

export const createSiteContext = (): SiteContext => SiteContext.getInstance();
