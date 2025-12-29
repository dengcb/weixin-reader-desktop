import { invoke, listen, waitForTauri } from '../core/tauri';
import { settingsStore, AppSettings } from '../core/settings_store';

export class MenuManager {
  private isReader = false;

  constructor() {
    this.init();
  }

  private async init() {
    await waitForTauri();
    
    // Ensure store is init (idempotent)
    await settingsStore.init();

    // 1. Listen for Menu Actions (from Rust)
    listen<string>('menu-action', (event) => {
      this.handleMenuAction(event.payload);
    });

    // 2. Listen for Route Changes (from AppManager)
    window.addEventListener('wxrd:route-changed', ((e: CustomEvent<{ isReader: boolean }>) => {
        this.isReader = e.detail.isReader;
        this.syncMenuState();
    }) as EventListener);

    // 3. Listen for Settings Changes (from Store)
    settingsStore.subscribe((settings) => {
        this.syncMenuState(settings);
        
        // Handle Zoom here as it's global
        if (settings.zoom) {
            invoke('set_zoom', { value: settings.zoom });
        }
    });
  }

  private syncMenuState(settings: AppSettings = settingsStore.get()) {
    const wideState = !!settings.readerWide;
    const toolbarState = !!settings.hideToolbar;
    const autoFlipState = !!settings.autoFlip?.active;

    const sync = (id: string, state: boolean, enabled: boolean) => {
        invoke('set_menu_item_enabled', { id, enabled }).then(() => {
            invoke('update_menu_state', { id, state });
        });
    };

    // Only enable these menu items if in Reader Mode
    sync('reader_wide', wideState, this.isReader);
    sync('hide_toolbar', toolbarState, this.isReader);
    sync('auto_flip', autoFlipState, this.isReader);
  }

  private handleMenuAction(action: string) {
    const settings = settingsStore.get();
    
    switch (action) {
      case 'reader_wide':
        {
            const newValue = !settings.readerWide;
            // Business Logic: If disabling wide, forcing hideToolbar off?
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
            const currentAutoFlip = settings.autoFlip || { active: false, interval: 30, keepAwake: true };
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
