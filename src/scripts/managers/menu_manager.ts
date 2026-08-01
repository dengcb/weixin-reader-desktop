/**
 * Menu Manager - Syncs menu state with frontend settings
 *
 * Responsibilities:
 * - Sync menu item checkmarks with settings
 * - Enable/disable menu items based on context
 * - Handle menu actions from Rust backend
 *
 * Listens to:
 * - 'ipc:route-changed' - Update menu enabled status
 * - 'menu-action' - Handle menu clicks from Rust
 * - Settings store changes - Sync menu checkmarks
 */

import { invoke, listen, waitForTauriReady } from '../core/tauri';
import { settingsStore, MergedSettings, SiteSettings } from '../core/settings_store';
import { createSiteContext, SiteContext } from '../core/site_context';
import { log } from '../core/logger';
import { showToast } from '../core/toast';

type TitleChangedEvent = {
  title: string;
};

export class MenuManager {
  private initialized = false;
  private siteContext: SiteContext;

  // Store references for cleanup
  private routeChangedHandler: ((e: Event) => void) | null = null;
  private legacyRouteChangedHandler: ((e: Event) => void) | null = null;
  private titleChangedHandler: ((e: Event) => void) | null = null;
  private unlistenMenuAction: (() => void) | null = null;
  private unlistenShowToast: (() => void) | null = null;
  private unlistenMenuRebuilt: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeDoubleColumn: (() => void) | null = null;
  private destroyed = false;
  private readonly initAbortController = new AbortController();

  constructor() {
    this.siteContext = createSiteContext();
    this.init();
  }

  private async init() {
    // 1. 设置事件监听器
    this.unlistenMenuAction = await listen<string>('menu-action', (event) => {
      this.handleMenuAction(event.payload);
    });
    if (this.destroyed) {
      this.unlistenMenuAction();
      this.unlistenMenuAction = null;
      return;
    }

    // 监听 Rust 端发来的 toast 事件（zoom 百分比提示）
    this.unlistenShowToast = await listen<string>('show-toast', (event) => {
      showToast(event.payload);
    });
    if (this.destroyed) {
      this.unlistenShowToast();
      this.unlistenShowToast = null;
      return;
    }

    this.routeChangedHandler = (() => {
      this.updateMenuEnabledStatus('route-changed');
    }) as EventListener;

    this.legacyRouteChangedHandler = (() => {
      this.updateMenuEnabledStatus('route-changed-legacy');
    }) as EventListener;

    this.titleChangedHandler = ((e: CustomEvent<TitleChangedEvent>) => {
      this.updateWindowTitle(e.detail.title);
    }) as EventListener;

    window.addEventListener('ipc:route-changed', this.routeChangedHandler);
    window.addEventListener('wxrd:route-changed', this.legacyRouteChangedHandler);
    window.addEventListener('ipc:title-changed', this.titleChangedHandler);

    // 监听菜单重建事件
    this.unlistenMenuRebuilt = await listen('menu-rebuilt', () => {
      log.info('[MenuManager] Menu rebuilt, resyncing state');
      this.syncMenuState();
    });
    if (this.destroyed) {
      this.unlistenMenuRebuilt();
      this.unlistenMenuRebuilt = null;
      return;
    }

    // 监听双栏模式变化
    this.unsubscribeDoubleColumn = this.siteContext.onDoubleColumnChange(async () => {
      await this.updateMenuEnabledStatus('double-column-change');
    });

    // 2. 等待 Tauri IPC 就绪
    await waitForTauriReady(this.initAbortController.signal);
    if (this.destroyed) return;

    // 3. 标记为已初始化
    this.initialized = true;

    // 5. 订阅设置变化
    this.unsubscribeSettings = settingsStore.subscribe(async (settings) => {
      // zoom 由 Rust 端菜单直接控制（按站点存储），前端不再 invoke set_zoom
      // 避免站点切换时前端用旧 siteId 的 zoom 覆盖新站点的缩放
      await this.syncMenuState(settings);
    });

    // 6. 执行初始同步
    await this.syncMenuState();
  }


  /**
   * 检测当前是否在阅读器页面
   * 使用 SiteContext 动态检测,避免硬编码路径判断
   */
  private checkIsReader(): boolean {
    return this.siteContext.isReaderPage;
  }

  // Only update enabled status based on reader mode AND capabilities
  private async updateMenuEnabledStatus(_source: string = 'unknown') {
    if (!window.__TAURI__) return;

    const isReader = this.checkIsReader();

    // 读取当前站点的 capabilities
    // 微信读书（weread）是根站点，全部可用；外部插件从已安装副本读取（非构建时内联值）
    const siteId = this.siteContext.currentRuntime?.id ?? 'weread';
    const isWeread = siteId === 'weread';
    let capWide = true;
    let capToolbar = true;
    let capNavbar = true;
    if (!isWeread) {
      try {
        const plugins = await invoke<any[]>('get_installed_plugins');
        const plugin = plugins?.find((p) => p.id === siteId);
        const caps = plugin?.capabilities ?? {};
        capWide = !!(caps.wideMode);
        capToolbar = !!(caps.hideToolbar);
        capNavbar = !!(caps.hideNavbar);
      } catch {
        // invoke 失败时默认全可用（不阻塞菜单）
      }
    }

    try {
      // Reader-specific items: enabled = isReader AND capability allows it
      await invoke('set_menu_item_enabled', { id: 'reader_wide', enabled: isReader && capWide });
      await invoke('set_menu_item_enabled', { id: 'hide_cursor', enabled: isReader });
      await invoke('set_menu_item_enabled', { id: 'hide_toolbar', enabled: isReader && capToolbar });
      await invoke('set_menu_item_enabled', { id: 'hide_navbar', enabled: isReader && capNavbar });
      await invoke('set_menu_item_enabled', { id: 'auto_flip', enabled: isReader });

      // Zoom items - always enabled
      await invoke('set_menu_item_enabled', { id: 'zoom_in', enabled: true });
      await invoke('set_menu_item_enabled', { id: 'zoom_out', enabled: true });
      await invoke('set_menu_item_enabled', { id: 'zoom_reset', enabled: true });
    } catch (e) {
      log.error('[MenuManager] Error updating menu enabled status:', e);
    }
  }

  // Update window title
  private async updateWindowTitle(title: string) {
    if (!window.__TAURI__) return;

    try {
      await invoke('set_title', { title });
    } catch (e) {
      log.error('[MenuManager] Error setting window title:', e);
    }
  }

  private async syncMenuState(settings: MergedSettings = settingsStore.get()) {
    if (!this.initialized) return;

    const wideState = !!settings.readerWide;
    const toolbarState = !!settings.hideToolbar;
    const navbarState = !!settings.hideNavbar;
    const autoFlipState = !!settings.autoFlip?.active;

    // zoom 完全由 Rust 端控制（菜单 + 启动 + 书店切换），前端不参与

    // Update enabled status FIRST
    await this.updateMenuEnabledStatus('sync-menu-state');

    // Then update menu state (checkmark) for all items
    try {
      await invoke('update_menu_state', { id: 'reader_wide', state: wideState });
      await invoke('update_menu_state', { id: 'hide_cursor', state: !!settings.hideCursor });
      await invoke('update_menu_state', { id: 'hide_toolbar', state: toolbarState });
      await invoke('update_menu_state', { id: 'hide_navbar', state: navbarState });
      await invoke('update_menu_state', { id: 'auto_flip', state: autoFlipState });
    } catch (e) {
      log.error('[MenuManager] Error updating menu state:', e);
    }
  }

  private handleMenuAction(action: string) {
    const settings = settingsStore.get();
    const siteId = this.siteContext.siteId;

    log.debug('[MenuManager] Handling action:', action, 'siteId:', siteId);

    switch (action) {
      case 'reader_wide':
        {
          const newValue = !settings.readerWide;
          const updates: Partial<SiteSettings> = { readerWide: newValue };
          
          // Auto-show toolbar if disabling wide mode (UX preference)
          if (!newValue && settings.hideToolbar) {
            updates.hideToolbar = false;
          }
          
          if (siteId !== 'unknown') {
            settingsStore.updateSite(siteId, updates);
          } else {
            // Fallback for unknown sites (shouldn't happen on reader page)
            settingsStore.update(updates);
          }
        }
        break;

      case 'hide_toolbar':
        {
          if (siteId !== 'unknown') {
            settingsStore.updateSite(siteId, { hideToolbar: !settings.hideToolbar });
          } else {
            settingsStore.update({ hideToolbar: !settings.hideToolbar });
          }
        }
        break;

      case 'hide_navbar':
        {
          if (siteId !== 'unknown') {
            settingsStore.updateSite(siteId, { hideNavbar: !settings.hideNavbar });
          } else {
            settingsStore.update({ hideNavbar: !settings.hideNavbar });
          }
        }
        break;

      case 'hide_cursor':
        {
          settingsStore.updateGlobal({ hideCursor: !settings.hideCursor });
        }
        break;

      case 'auto_flip':
        {
          const currentAutoFlip = settings.autoFlip || { active: false, interval: 15, keepAwake: true };
          const newActive = !currentAutoFlip.active;
          // autoFlip 现在是全局配置
          settingsStore.updateGlobal({
            autoFlip: { ...currentAutoFlip, active: newActive }
          });
        }
        break;

    }
  }

  public destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.initAbortController.abort();
    // Remove window event listeners
    if (this.routeChangedHandler) {
      window.removeEventListener('ipc:route-changed', this.routeChangedHandler);
      this.routeChangedHandler = null;
    }
    if (this.legacyRouteChangedHandler) {
      window.removeEventListener('wxrd:route-changed', this.legacyRouteChangedHandler);
      this.legacyRouteChangedHandler = null;
    }
    if (this.titleChangedHandler) {
      window.removeEventListener('ipc:title-changed', this.titleChangedHandler);
      this.titleChangedHandler = null;
    }

    // Unlisten Tauri event
    if (this.unlistenMenuAction) {
      this.unlistenMenuAction();
      this.unlistenMenuAction = null;
    }
    this.unlistenShowToast?.();
    this.unlistenShowToast = null;
    this.unlistenMenuRebuilt?.();
    this.unlistenMenuRebuilt = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.unsubscribeDoubleColumn?.();
    this.unsubscribeDoubleColumn = null;
  }
}
