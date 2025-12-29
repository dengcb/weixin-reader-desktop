import { invoke, listen } from './tauri';

export interface AppSettings {
  readerWide?: boolean;
  hideToolbar?: boolean;
  zoom?: number;
  autoFlip?: {
    active: boolean;
    interval: number;
    keepAwake: boolean;
  };
  rememberLastPage?: boolean;
  lastReaderUrl?: string | null;
  autoUpdate?: boolean;
}

type SettingsListener = (settings: AppSettings) => void;

class SettingsStore {
  private static instance: SettingsStore;
  private settings: AppSettings = {};
  private listeners: Set<SettingsListener> = new Set();
  private initialized = false;

  private constructor() {}

  public static getInstance(): SettingsStore {
    if (!SettingsStore.instance) {
      SettingsStore.instance = new SettingsStore();
    }
    return SettingsStore.instance;
  }

  public async init() {
    if (this.initialized) return;

    // Load initial settings
    try {
      const loaded = (await invoke<AppSettings>('get_settings')) || {};
      // Apply defaults
      this.settings = {
          readerWide: false,
          hideToolbar: false,
          zoom: 1.0,
          rememberLastPage: true,
          autoUpdate: true,
          ...loaded,
          autoFlip: {
              active: false,
              interval: 30,
              keepAwake: true,
              ...(loaded.autoFlip || {})
          }
      };
    } catch (e) {
      console.error('SettingsStore: Failed to load settings', e);
      this.settings = {
          readerWide: false,
          hideToolbar: false,
          zoom: 1.0,
          rememberLastPage: true,
          autoUpdate: true,
          autoFlip: { active: false, interval: 30, keepAwake: true }
      };
    }

    // Listen for updates from other windows (e.g. settings window)
    listen('settings-updated', async () => {
      // Reload fresh settings from backend
      const newSettings = (await invoke<AppSettings>('get_settings')) || {};
      // Apply defaults again to ensure consistency
      this.updateLocal({
          readerWide: false,
          hideToolbar: false,
          zoom: 1.0,
          rememberLastPage: true,
          autoUpdate: true,
          ...newSettings,
          autoFlip: {
              active: false,
              interval: 30,
              keepAwake: true,
              ...(newSettings.autoFlip || {})
          }
      });
    });

    this.initialized = true;
    this.notify();
  }

  public get(): AppSettings {
    return { ...this.settings };
  }

  public async update(partial: Partial<AppSettings>) {
    // 1. Update local
    this.settings = { ...this.settings, ...partial };
    
    // 2. Persist to backend
    // Note: 'save_settings' in backend does a shallow merge on top-level keys
    // If we update 'autoFlip' (nested), we must send the whole object or handle deep merge in Rust.
    // Our Rust implementation does shallow merge. 
    // So if we update `autoFlip`, we must provide the complete `autoFlip` object.
    try {
      await invoke('save_settings', { settings: partial });
    } catch (e) {
      console.error('SettingsStore: Failed to save settings', e);
    }

    // 3. Notify listeners
    this.notify();
  }

  public subscribe(listener: SettingsListener) {
    this.listeners.add(listener);
    // Notify immediately with current settings
    if (this.initialized) {
        listener(this.get());
    }
    return () => this.listeners.delete(listener);
  }

  private updateLocal(newSettings: AppSettings) {
    this.settings = newSettings;
    this.notify();
  }

  private notify() {
    const current = this.get();
    this.listeners.forEach(l => l(current));
  }
}

export const settingsStore = SettingsStore.getInstance();
