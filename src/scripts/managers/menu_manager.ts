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
    // 1. Set up all event listeners FIRST
    this.unlistenMenuAction = await listen<string>('menu-action', (event) => {
      this.handleMenuAction(event.payload);
    });

    this.routeChangedHandler = ((e: CustomEvent<RouteChangedEvent>) => {
      this.isReader = e.detail.isReader;
      this.updateMenuEnabledStatus();
    }) as EventListener;

    this.legacyRouteChangedHandler = ((e: CustomEvent<{ isReader: boolean }>) => {
      this.isReader = e.detail.isReader;
      this.updateMenuEnabledStatus();
    }) as EventListener;

    this.titleChangedHandler = ((e: CustomEvent<TitleChangedEvent>) => {
      this.updateWindowTitle(e.detail.title);
    }) as EventListener;

    window.addEventListener('ipc:route-changed', this.routeChangedHandler);
    window.addEventListener('wxrd:route-changed', this.legacyRouteChangedHandler);
    window.addEventListener('ipc:title-changed', this.titleChangedHandler);

    // 2. Wait for Tauri IPC to be ready
    await waitForTauriReady();

    // 3. Initialize isReader from SiteContext
    this.isReader = this.siteContext.isReaderPage;

    // 4. Mark as initialized BEFORE subscribing
    // This prevents the initial subscription callback from being blocked
    this.initialized = true;

    // 5. Subscribe to settings changes AFTER initialized is true
    settingsStore.subscribe(async (settings) => {
      // Handle Zoom first
      if (settings.zoom !== undefined) {
        try {
          await invoke('set_zoom', { value: settings.zoom });
        } catch (e) {
          log.error('[MenuManager] set_zoom failed:', e);
        }
      }

      await this.syncMenuState(settings);
    });

    // 6. Do initial sync manually
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
  private async updateMenuEnabledStatus() {
    if (!window.__TAURI__) return;

    const isReader = this.checkIsReader();
    const siteId = this.siteContext.siteId;
    log.debug('[MenuManager] Updating menu enabled status. isReader:', isReader, 'siteId:', siteId, 'URL:', window.location.href);

    try {
      // Reader-specific items
      await invoke('set_menu_item_enabled', { id: 'reader_wide', enabled: isReader });
      await invoke('set_menu_item_enabled', { id: 'hide_toolbar', enabled: isReader });
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
    const autoFlipState = !!settings.autoFlip?.active;

    // Update enabled status FIRST
    await this.updateMenuEnabledStatus();

    // Then update menu state (checkmark) for all items
    try {
      await invoke('update_menu_state', { id: 'reader_wide', state: wideState });
      await invoke('update_menu_state', { id: 'hide_toolbar', state: toolbarState });
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
          let current = settings.zoom || 1.0;
          current = Math.round((current + 0.1) * 10) / 10;
          settingsStore.updateGlobal({ zoom: current });
        }
        break;

      case 'zoom_out':
        {
          let current = settings.zoom || 1.0;
          current = Math.round((current - 0.1) * 10) / 10;
          if (current < 0.1) current = 0.1;
          settingsStore.updateGlobal({ zoom: current });
        }
        break;

      case 'zoom_reset':
        settingsStore.updateGlobal({ zoom: 1.0 });
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
