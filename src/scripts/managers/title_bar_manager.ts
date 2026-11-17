/**
 * TitleBarManager — 沉浸标题栏有效态联动。
 *
 * 合成「全局 immersiveTitleBar && 当前站点 hideNavbar && 阅读页」有效态，
 * 去重后调 Rust set_immersive_title_bar 执行平台窗口装饰切换；Windows 额外
 * 管理碰顶悬浮窗口控件（见 core/immersive_title_bar）。在线站点与本地阅读页
 * 共用（AppRuntime 两种形态都创建本管理器）。
 *
 * 销毁时恢复原生标题栏：离开阅读页/页面卸载后标题栏回窗，书架/首页不带沉浸态。
 */
import { settingsStore } from '../core/settings_store';
import { createSiteContext, type SiteContext } from '../core/site_context';
import { invoke } from '../core/tauri';
import { log } from '../core/logger';
import {
  computeImmersiveHidden,
  createWindowsTitleBar,
  type WindowsTitleBar,
} from '../core/immersive_title_bar';
import type { RouteChangedEvent } from './ipc_manager';

export class TitleBarManager {
  private siteContext: SiteContext;
  private isReader = false;
  /** 窗口初始为原生标题栏（可见），以此为去重基线，默认关闭时零启动 IPC。 */
  private lastHidden = false;
  private windowsTitleBar: WindowsTitleBar | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private routeChangedHandler: ((e: Event) => void) | null = null;
  private readonly isWindows = navigator.userAgent.includes('Windows');
  private destroyed = false;

  constructor() {
    this.siteContext = createSiteContext();
    this.init();
  }

  private init(): void {
    this.isReader = this.siteContext.isReaderPage;
    this.unsubscribeSettings = settingsStore.subscribe(() => this.apply());
    this.routeChangedHandler = ((e: CustomEvent<RouteChangedEvent>) => {
      this.isReader = e.detail.isReader;
      this.apply();
    }) as EventListener;
    window.addEventListener('ipc:route-changed', this.routeChangedHandler);
    this.apply();
  }

  private apply(): void {
    if (this.destroyed) return;
    const settings = settingsStore.get();
    const hidden = computeImmersiveHidden(
      settings.immersiveTitleBar,
      settings.hideNavbar,
      this.isReader,
    );
    if (hidden === this.lastHidden) return;
    this.lastHidden = hidden;
    invoke('set_immersive_title_bar', { hidden }).catch((error) => {
      log.error('[TitleBarManager] set_immersive_title_bar failed', error);
    });
    if (this.isWindows) {
      if (hidden) {
        this.windowsTitleBar = createWindowsTitleBar(document);
      } else {
        this.windowsTitleBar?.destroy();
        this.windowsTitleBar = null;
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.lastHidden) {
      invoke('set_immersive_title_bar', { hidden: false }).catch(() => undefined);
    }
    this.windowsTitleBar?.destroy();
    this.windowsTitleBar = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    if (this.routeChangedHandler) {
      window.removeEventListener('ipc:route-changed', this.routeChangedHandler);
      this.routeChangedHandler = null;
    }
  }
}
