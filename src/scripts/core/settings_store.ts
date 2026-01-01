import { invoke, listen } from './tauri';
import { OptimisticLock } from './optimistic_lock';

export interface AppSettings {
  _version?: number;  // Managed by OptimisticLock
  readerWide?: boolean;
  hideToolbar?: boolean;
  zoom?: number;
  autoFlip?: {
    active: boolean;
    interval: number;
    keepAwake: boolean;
  };
  lastPage?: boolean;
  lastReaderUrl?: string | null;
  scrollPosition?: number;  // Y scroll position for single-column mode
  autoUpdate?: boolean;
}

type SettingsListener = (settings: AppSettings) => void;

export class SettingsStore {
  private static instance: SettingsStore;
  private lock: OptimisticLock<AppSettings> | null = null;
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
      const loadedVersion = loaded._version || 0;

      // Apply defaults
      const initialSettings: AppSettings = {
          _version: loadedVersion,
          readerWide: false,
          hideToolbar: false,
          zoom: 0.8,
          lastPage: true,
          autoUpdate: true,
          ...loaded,
          autoFlip: {
              active: false,
              interval: 15,
              keepAwake: true,
              ...(loaded.autoFlip || {})
          }
      };

      // Initialize optimistic lock
      this.lock = new OptimisticLock<AppSettings>(initialSettings, loadedVersion);
      console.log('[SettingsStore] Initialized optimistic lock with version:', loadedVersion);
    } catch (e) {
      console.error('SettingsStore: Failed to load settings', e);
      const fallbackSettings: AppSettings = {
          _version: 0,
          readerWide: false,
          hideToolbar: false,
          zoom: 0.8,
          lastPage: true,
          autoUpdate: true,
          autoFlip: { active: false, interval: 15, keepAwake: true }
      };
      this.lock = new OptimisticLock<AppSettings>(fallbackSettings, 0);
    }

    // Listen for updates from other windows (e.g. settings window)
    listen('settings-updated', async () => {
      if (!this.lock) return;

      // Reload fresh settings from backend
      const newSettings = (await invoke<AppSettings>('get_settings')) || {};
      const backendVersion = newSettings._version || 0;

      console.log('[SettingsStore] Received settings-updated event, backend version:', backendVersion, 'local version:', this.lock.getVersion());

      // Use optimistic lock to load external data
      const loaded = this.lock.loadFromExternal(newSettings, backendVersion);

      if (loaded) {
        console.log('[SettingsStore] Loaded newer version from backend:', backendVersion);
        this.notify();
      } else {
        console.log('[SettingsStore] Ignoring older version from backend:', backendVersion, '<', this.lock.getVersion());
      }
    });

    this.initialized = true;
    this.notify();
  }

  public get(): AppSettings {
    return this.lock ? this.lock.getData() : {};
  }

  public async update(partial: Partial<AppSettings>) {
    if (!this.lock) {
      console.error('[SettingsStore] Lock not initialized');
      return;
    }

    // Remove _version from partial (managed by lock)
    const { _version, ...partialWithoutVersion } = partial as any;

    // Use optimistic lock to perform update
    const result = this.lock.tryUpdate(partialWithoutVersion);

    console.log('[SettingsStore] Update: version', result.version - 1, '->', result.version, 'partial:', partialWithoutVersion);

    // Persist to backend with new version
    try {
      await invoke('save_settings', {
        settings: result.data,  // Send full settings with version
        version: result.version
      });
      console.log('[SettingsStore] Saved successfully with version:', result.version);
    } catch (e) {
      console.error('[SettingsStore] Failed to save settings', e);
      // Revert version on error
      this.lock.forceSet(result.data, result.version - 1);
    }

    // Notify listeners with updated data
    this.notify();
  }

  public subscribe(listener: SettingsListener) {
    this.listeners.add(listener);
    // Notify immediately with current settings
    if (this.initialized && this.lock) {
        listener(this.lock.getData());
    }
    return () => this.listeners.delete(listener);
  }

  private notify() {
    if (!this.lock) return;
    const current = this.lock.getData();
    this.listeners.forEach(l => l(current));
  }
}

export const settingsStore = SettingsStore.getInstance();
