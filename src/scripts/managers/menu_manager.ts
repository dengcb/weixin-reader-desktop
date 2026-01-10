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
import { settingsStore, AppSettings, MergedSettings, SiteSettings } from '../core/settings_store';
import { createSiteContext, SiteContext } from '../core/site_context';
import { log } from '../core/logger';
import { showToast } from '../core/toast';

type RouteChangedEvent = {
  isReader: boolean;
  url: string;
  pathname: string;
};

type TitleChangedEvent = {
  title: string;
};

export class MenuManager {
  private isReader = false;
  private initialized = false;
  private siteContext: SiteContext;

  // Store references for cleanup
  private routeChangedHandler: ((e: Event) => void) | null = null;
  private legacyRouteChangedHandler: ((e: Event) => void) | null = null;
  private titleChangedHandler: ((e: Event) => void) | null = null;
  private unlistenMenuAction: (() => void) | null = null;

  constructor() {
    this.siteContext = createSiteContext();
    this.init();
  }

  private async init() {
    // 1. 设置事件监听器
    this.unlistenMenuAction = await listen<string>('menu-action', (event) => {
      this.handleMenuAction(event.payload);
    });

    this.routeChangedHandler = ((e: CustomEvent<RouteChangedEvent>) => {
      this.isReader = e.detail.isReader;
      this.updateMenuEnabledStatus('route-changed');
    }) as EventListener;

    this.legacyRouteChangedHandler = ((e: CustomEvent<{ isReader: boolean }>) => {
      this.isReader = e.detail.isReader;
      this.updateMenuEnabledStatus('route-changed-legacy');
    }) as EventListener;

    this.titleChangedHandler = ((e: CustomEvent<TitleChangedEvent>) => {
      this.updateWindowTitle(e.detail.title);
    }) as EventListener;

    window.addEventListener('ipc:route-changed', this.routeChangedHandler);
    window.addEventListener('wxrd:route-changed', this.legacyRouteChangedHandler);
    window.addEventListener('ipc:title-changed', this.titleChangedHandler);

    // 监听菜单重建事件
    listen('menu-rebuilt', () => {
      log.info('[MenuManager] Menu rebuilt, resyncing state');
      this.syncMenuState();
    });

    // 监听双栏模式变化
    this.siteContext.onDoubleColumnChange(async (isDoubleColumn) => {
      await this.updateMenuEnabledStatus('double-column-change');
    });

    // 2. 等待 Tauri IPC 就绪
    await waitForTauriReady();

    // 3. 初始化 isReader 状态
    this.isReader = this.siteContext.isReaderPage;

    // 4. 标记为已初始化
    this.initialized = true;

    // 5. 订阅设置变化
    settingsStore.subscribe(async (settings) => {
      // 使用 Tauri 原生 set_zoom API（而不是 CSS zoom）
      // 让 Tauri 调用系统 webview 的缩放功能
      if (settings.zoom !== undefined) {
        try {
          await invoke('set_zoom', { value: settings.zoom });
        } catch (e) {
          log.error('[MenuManager] set_zoom failed:', e);
        }
      }
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

  // Only update enabled status based on reader mode
  private async updateMenuEnabledStatus(source: string = 'unknown') {
    if (!window.__TAURI__) return;

    const isReader = this.checkIsReader();

    try {
      // Reader-specific items
      await invoke('set_menu_item_enabled', { id: 'reader_wide', enabled: isReader });
      await invoke('set_menu_item_enabled', { id: 'hide_cursor', enabled: isReader });
      await invoke('set_menu_item_enabled', { id: 'hide_toolbar', enabled: isReader });
      // hide_navbar 和 hide_toolbar 一样，只在阅读器页面启用
      await invoke('set_menu_item_enabled', { id: 'hide_navbar', enabled: isReader });
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

    // 应用 Tauri 原生缩放（初始化时调用一次）
    if (settings.zoom !== undefined) {
      try {
        await invoke('set_zoom', { value: settings.zoom });
      } catch (e) {
        log.error('[MenuManager] set_zoom failed:', e);
      }
    }

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
          const updates = {
            autoFlip: { ...currentAutoFlip, active: newActive }
          };

          if (siteId !== 'unknown') {
            settingsStore.updateSite(siteId, updates);
          } else {
            settingsStore.update(updates);
          }
        }
        break;

      case 'zoom_in':
        {
          // Chrome 缩放级别: 0.5 → 0.67 → 0.75 → 0.8 → 0.9 → 1.0 → 1.1 → 1.25 → 1.5 → 1.75 → 2.0
          const zoomLevels = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];
          const current = settings.zoom || 0.75;

          // 找到下一个更大的级别
          let nextZoom = zoomLevels[zoomLevels.length - 1]; // 默认最大值
          for (const level of zoomLevels) {
            if (level > current) {
              nextZoom = level;
              break;
            }
          }

          settingsStore.updateGlobal({ zoom: nextZoom });
          showToast(Math.round(nextZoom * 100) + '%');
        }
        break;

      case 'zoom_out':
        {
          // Chrome 缩放级别: 0.5 → 0.67 → 0.75 → 0.8 → 0.9 → 1.0 → 1.1 → 1.25 → 1.5 → 1.75 → 2.0
          const zoomLevels = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];
          const current = settings.zoom || 0.75;

          // 找到下一个更小的级别
          let nextZoom = zoomLevels[0]; // 默认最小值
          for (let i = zoomLevels.length - 1; i >= 0; i--) {
            if (zoomLevels[i] < current) {
              nextZoom = zoomLevels[i];
              break;
            }
          }

          settingsStore.updateGlobal({ zoom: nextZoom });
          showToast(Math.round(nextZoom * 100) + '%');
        }
        break;

      case 'zoom_reset':
        settingsStore.updateGlobal({ zoom: 1.0 });
        showToast('100%');
        break;
    }
  }

  public destroy() {
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
  }
}
