import { listen, invoke } from './tauri';
import { log } from './logger';
import { createSiteContext } from './site_context';

export interface SiteSettings {
  zoom?: number;
  readerWide?: boolean;
  hideToolbar?: boolean;
  hideNavbar?: boolean;
  lastReaderUrl?: string | null;
  scrollPosition?: number;
}

export interface GlobalSettings {
  autoUpdate?: boolean;
  lastPage?: boolean;
  rememberSite?: boolean;
  lastSiteId?: string;
  hideCursor?: boolean;
  enableRemoteController?: boolean;
  enabledPlugins?: string[];
  autoFlip?: {
    active: boolean;
    interval: number;
    keepAwake: boolean;
  };
}

export interface AppSettings {
  schemaVersion: 2;
  _version: number;
  global: GlobalSettings;
  sites: Record<string, SiteSettings>;
  pluginConfigs: Record<string, Record<string, any>>;
}

export type MergedSettings = AppSettings & SiteSettings & GlobalSettings;

interface SettingsPatch {
  global?: Partial<GlobalSettings>;
  sites?: Record<string, Partial<SiteSettings>>;
  pluginConfigs?: Record<string, Record<string, any>>;
}

type PatchOutcome =
  | { status: 'applied'; settings: AppSettings }
  | { status: 'conflict'; latest: AppSettings };

type SettingsListener = (settings: MergedSettings) => void;

const defaultDocument = (): AppSettings => ({
  schemaVersion: 2,
  _version: 0,
  global: {
    autoUpdate: true,
    lastPage: true,
    rememberSite: true,
    hideCursor: false,
    autoFlip: { active: false, interval: 15, keepAwake: true },
  },
  sites: {},
  pluginConfigs: {},
});

const normalizeDocument = (value: AppSettings | null | undefined): AppSettings => ({
  ...defaultDocument(),
  ...value,
  schemaVersion: 2,
  _version: value?._version ?? 0,
  global: { ...defaultDocument().global, ...(value?.global ?? {}) },
  sites: value?.sites ?? {},
  pluginConfigs: value?.pluginConfigs ?? {},
});

const applyPatch = (document: AppSettings, patch: SettingsPatch): AppSettings => {
  const sites = { ...document.sites };
  for (const [siteId, value] of Object.entries(patch.sites ?? {})) {
    sites[siteId] = { ...sites[siteId], ...value };
  }

  const pluginConfigs = { ...document.pluginConfigs };
  for (const [pluginId, value] of Object.entries(patch.pluginConfigs ?? {})) {
    pluginConfigs[pluginId] = { ...pluginConfigs[pluginId], ...value };
  }

  return {
    ...document,
    global: { ...document.global, ...patch.global },
    sites,
    pluginConfigs,
  };
};

export class SettingsStore {
  private static instance: SettingsStore;
  private document: AppSettings = defaultDocument();
  private listeners = new Set<SettingsListener>();
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private unlistenSettings: (() => void) | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor() {}

  public static getInstance(): SettingsStore {
    if (!SettingsStore.instance) SettingsStore.instance = new SettingsStore();
    return SettingsStore.instance;
  }

  public init(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializePromise) return this.initializePromise;

    const generation = this.lifecycleGeneration;
    const operation = this.initialize(generation);
    this.initializePromise = operation;
    const clearOperation = () => {
      if (this.initializePromise === operation) this.initializePromise = null;
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  private async initialize(generation: number): Promise<void> {
    await this.writeQueue;
    if (generation !== this.lifecycleGeneration) return;
    try {
      const document = normalizeDocument(await invoke<AppSettings>('get_settings'));
      if (generation !== this.lifecycleGeneration) return;
      this.document = document;
    } catch (error) {
      if (generation !== this.lifecycleGeneration) return;
      log.error('[SettingsStore] Failed to load settings', error);
      this.document = defaultDocument();
    }

    const unlisten = await listen<AppSettings>('settings-updated', ({ payload }) => {
      if (generation !== this.lifecycleGeneration) return;
      const incoming = normalizeDocument(payload);
      if (incoming._version > this.document._version) {
        this.document = incoming;
        this.notify();
      }
    });
    if (generation !== this.lifecycleGeneration) {
      unlisten();
      return;
    }
    this.unlistenSettings = unlisten;
    this.initialized = true;
    this.notify();
  }

  public get(): MergedSettings {
    const siteSettings = this.document.sites[createSiteContext().siteId] ?? {};
    return {
      ...this.document,
      ...this.document.global,
      ...siteSettings,
    };
  }

  public getGlobal(): GlobalSettings {
    return this.document.global;
  }

  public getSite(siteId: string): SiteSettings {
    return this.document.sites[siteId] ?? {};
  }

  public getPluginConfig(pluginId: string): Record<string, any> {
    return this.document.pluginConfigs[pluginId] ?? {};
  }

  public async updateGlobal(partial: Partial<GlobalSettings>): Promise<void> {
    return this.enqueuePatch({ global: partial });
  }

  public async updateSite(siteId: string, partial: Partial<SiteSettings>): Promise<void> {
    return this.enqueuePatch({ sites: { [siteId]: partial } });
  }

  public async updatePluginConfig(
    pluginId: string,
    partial: Record<string, any>,
  ): Promise<void> {
    return this.enqueuePatch({ pluginConfigs: { [pluginId]: partial } });
  }

  public getCurrentSiteSettings(): SiteSettings {
    return this.getSite(createSiteContext().siteId);
  }

  public async updateCurrentSite(partial: Partial<SiteSettings>): Promise<void> {
    return this.updateSite(createSiteContext().siteId, partial);
  }

  public async update(
    partial: Partial<AppSettings> & Partial<SiteSettings> & Partial<GlobalSettings>,
  ): Promise<void> {
    const globalKeys: (keyof GlobalSettings)[] = [
      'autoUpdate',
      'lastPage',
      'rememberSite',
      'lastSiteId',
      'hideCursor',
      'enableRemoteController',
      'enabledPlugins',
      'autoFlip',
    ];
    const siteKeys: (keyof SiteSettings)[] = [
      'zoom',
      'readerWide',
      'hideToolbar',
      'hideNavbar',
      'lastReaderUrl',
      'scrollPosition',
    ];
    const patch: SettingsPatch = {};

    if (partial.global) patch.global = partial.global;
    if (partial.sites) patch.sites = partial.sites;
    if (partial.pluginConfigs) patch.pluginConfigs = partial.pluginConfigs;

    for (const key of globalKeys) {
      const value = partial[key];
      if (value !== undefined) {
        patch.global = { ...patch.global, [key]: value };
      }
    }

    for (const key of siteKeys) {
      const value = partial[key];
      if (value !== undefined) {
        const siteId = createSiteContext().siteId;
        patch.sites = {
          ...patch.sites,
          [siteId]: { ...patch.sites?.[siteId], [key]: value },
        };
      }
    }

    return this.enqueuePatch(patch);
  }

  private enqueuePatch(patch: SettingsPatch): Promise<void> {
    const operation = this.writeQueue.then(() => this.persistPatch(patch));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async persistPatch(patch: SettingsPatch): Promise<void> {
    let stable = this.document;
    this.document = applyPatch(stable, patch);
    this.notify();

    try {
      let outcome = await this.sendPatch(stable._version, patch);
      if (outcome.status === 'conflict') {
        stable = normalizeDocument(outcome.latest);
        this.document = applyPatch(stable, patch);
        this.notify();
        outcome = await this.sendPatch(stable._version, patch);
      }

      if (outcome.status === 'conflict') {
        stable = normalizeDocument(outcome.latest);
        this.document = stable;
        this.notify();
        throw new Error('Settings changed again while retrying patch');
      }

      this.document = normalizeDocument(outcome.settings);
      this.notify();
    } catch (error) {
      this.document = stable;
      this.notify();
      log.error('[SettingsStore] Failed to persist settings patch', error);
      throw error;
    }
  }

  private sendPatch(expectedVersion: number, patch: SettingsPatch): Promise<PatchOutcome> {
    return invoke<PatchOutcome>('patch_settings', { expectedVersion, patch });
  }

  public subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    if (this.initialized) {
      try {
        listener(this.get());
      } catch (error) {
        log.error('[SettingsStore] Listener failed during initial delivery', error);
      }
    }
    return () => this.listeners.delete(listener);
  }

  public isPluginEnabled(pluginId: string): boolean {
    const enabledPlugins = this.getGlobal().enabledPlugins;
    return enabledPlugins === undefined || enabledPlugins.includes(pluginId);
  }

  public getEnabledPlugins(): string[] | undefined {
    return this.getGlobal().enabledPlugins;
  }

  public async enablePlugin(pluginId: string): Promise<void> {
    const current = this.getGlobal().enabledPlugins;
    if (current !== undefined && !current.includes(pluginId)) {
      await this.updateGlobal({ enabledPlugins: [...current, pluginId] });
    }
  }

  public async disablePlugin(pluginId: string, allPluginIds?: string[]): Promise<void> {
    const current = this.getGlobal().enabledPlugins ?? allPluginIds;
    if (!current) {
      log.warn('[SettingsStore] Cannot initialize enabled plugins without registry IDs');
      return;
    }
    await this.updateGlobal({ enabledPlugins: current.filter((id) => id !== pluginId) });
  }

  public async refresh(): Promise<void> {
    await this.writeQueue;
    this.document = normalizeDocument(await invoke<AppSettings>('get_settings'));
    this.notify();
  }

  public destroy(): void {
    this.lifecycleGeneration++;
    this.unlistenSettings?.();
    this.unlistenSettings = null;
    this.listeners.clear();
    this.initialized = false;
    this.initializePromise = null;
  }

  private notify(): void {
    const current = this.get();
    for (const listener of [...this.listeners]) {
      try {
        listener(current);
      } catch (error) {
        log.error('[SettingsStore] Listener failed', error);
      }
    }
  }
}

export const settingsStore = SettingsStore.getInstance();
