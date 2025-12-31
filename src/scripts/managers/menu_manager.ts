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
import { settingsStore, AppSettings } from '../core/settings_store';

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

  constructor() {
    this.init();
  }

  private async init() {
    // 1. Set up all event listeners FIRST
    listen<string>('menu-action', (event) => {
      this.handleMenuAction(event.payload);
    });

    window.addEventListener('ipc:route-changed', ((e: CustomEvent<RouteChangedEvent>) => {
      this.isReader = e.detail.isReader;
      this.updateMenuEnabledStatus();
    }) as EventListener);

    window.addEventListener('wxrd:route-changed', ((e: CustomEvent<{ isReader: boolean }>) => {
      this.isReader = e.detail.isReader;
      this.updateMenuEnabledStatus();
    }) as EventListener);

    // Listen for title changes and sync to window title
    window.addEventListener('ipc:title-changed', ((e: CustomEvent<TitleChangedEvent>) => {
      console.log('[MenuManager] Title changed:', e.detail.title);
      this.updateWindowTitle(e.detail.title);
    }) as EventListener);

    // 2. Wait for Tauri IPC to be ready
    await waitForTauriReady();

    // 3. Initialize isReader from current URL
    this.isReader = this.checkIsReader();

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
          console.error('[MenuManager] set_zoom failed:', e);
        }
      }

      await this.syncMenuState(settings);
    });

    // 6. Do initial sync manually
    await this.syncMenuState();
  }

  // Helper to check if currently on reader page
  private checkIsReader(): boolean {
    const currentUrl = window.location.href;
    const pathname = window.location.pathname;
    return pathname.includes('/web/reader/') ||
           currentUrl.includes('/web/reader/') ||
           pathname.startsWith('/reader') ||
           currentUrl.includes('reader');
  }

  // Only update enabled status based on reader mode
  private async updateMenuEnabledStatus() {
    if (!window.__TAURI__) return;

    try {
      // Reader-specific items
      await invoke('set_menu_item_enabled', { id: 'reader_wide', enabled: this.isReader });
      await invoke('set_menu_item_enabled', { id: 'hide_toolbar', enabled: this.isReader });
      await invoke('set_menu_item_enabled', { id: 'auto_flip', enabled: this.isReader });

      // Zoom items - always enabled
      await invoke('set_menu_item_enabled', { id: 'zoom_in', enabled: true });
      await invoke('set_menu_item_enabled', { id: 'zoom_out', enabled: true });
      await invoke('set_menu_item_enabled', { id: 'zoom_reset', enabled: true });
    } catch (e) {
      console.error('[MenuManager] Error updating menu enabled status:', e);
    }
  }

  // Update window title
  private async updateWindowTitle(title: string) {
    if (!window.__TAURI__) return;

    try {
      await invoke('set_title', { title });
    } catch (e) {
      console.error('[MenuManager] Error setting window title:', e);
    }
  }

  private async syncMenuState(settings: AppSettings = settingsStore.get()) {
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
      console.error('[MenuManager] Error updating menu state:', e);
    }
  }

  private handleMenuAction(action: string) {
    const settings = settingsStore.get();

    switch (action) {
      case 'reader_wide':
        {
          const newValue = !settings.readerWide;
          let updates: Partial<AppSettings> = { readerWide: newValue };
          if (!newValue && settings.hideToolbar) {
            updates.hideToolbar = false;
          }
          settingsStore.update(updates);
        }
        break;

      case 'hide_toolbar':
        settingsStore.update({ hideToolbar: !settings.hideToolbar });
        break;

      case 'auto_flip':
        {
          const currentAutoFlip = settings.autoFlip || { active: false, interval: 15, keepAwake: true };
          const newActive = !currentAutoFlip.active;
          settingsStore.update({
            autoFlip: { ...currentAutoFlip, active: newActive }
          });
        }
        break;

      case 'zoom_in':
        {
          let current = settings.zoom || 1.0;
          current = Math.round((current + 0.1) * 10) / 10;
          settingsStore.update({ zoom: current });
        }
        break;

      case 'zoom_out':
        {
          let current = settings.zoom || 1.0;
          current = Math.round((current - 0.1) * 10) / 10;
          if (current < 0.1) current = 0.1;
          settingsStore.update({ zoom: current });
        }
        break;

      case 'zoom_reset':
        settingsStore.update({ zoom: 1.0 });
        break;
    }
  }
}
