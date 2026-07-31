import { invoke, listen } from './tauri';
import { OptimisticLock } from './optimistic_lock';
import { log } from './logger';
import { createSiteContext } from './site_context';

/**
 * 站点特定设置
 * 每个网站独立存储，互不干扰
 */
export interface SiteSettings {
  readerWide?: boolean;
  hideToolbar?: boolean;
  hideNavbar?: boolean;
  lastReaderUrl?: string | null;
  scrollPosition?: number;  // Y scroll position for single-column mode
  readingProgress?: Record<string, number>; // URL-based scroll position storage
  autoFlip?: {
    active: boolean;
    interval: number;
    keepAwake: boolean;
  };
}

/**
 * 应用设置总结构
 * - global: 全局设置（所有网站共享）
 * - sites: 站点特定设置（按 siteId 隔离）
 * - pluginConfigs: 插件配置（按 pluginId 隔离）
 */
export interface AppSettings {
  _version?: number;  // Managed by OptimisticLock
  global?: {
    zoom?: number;
    autoUpdate?: boolean;
    lastPage?: boolean;  // 「阅读不停，自动记录」：是否恢复上次阅读页（正交于 rememberSite）
    rememberSite?: boolean;  // 「记住书店，好看再来」：是否恢复上次所在站点（关则每次进微信读书）
    lastSiteId?: string;  // 上次活跃的站点 ID（供启动时选站）
    hideCursor?: boolean;  // 是否隐藏光标
    enabledPlugins?: string[];  // 启用的插件列表，undefined = 全部启用（向后兼容）
  };
  sites?: {
    [siteId: string]: SiteSettings;
  };
  pluginConfigs?: {  // 插件配置（按 pluginId 隔离）
    [pluginId: string]: Record<string, any>;
  };
}

export type GlobalSettings = NonNullable<AppSettings['global']>;
export type MergedSettings = AppSettings & SiteSettings & GlobalSettings;


type SettingsListener = (settings: MergedSettings) => void;

export class SettingsStore {
  private static instance: SettingsStore;
  private lock: OptimisticLock<AppSettings> | null = null;
  private listeners: Set<SettingsListener> = new Set();
  private initialized = false;

  private constructor() {}

  /**
   * 迁移旧的扁平设置结构到新的嵌套结构
   * 检测旧格式（有 readerWide, hideToolbar 等顶层字段）并迁移到 sites.weread
   */
  private static migrateOldSettings(loaded: any): AppSettings {
    // 检测是否是旧格式（存在顶层的 readerWide 等字段）
    const isOldFormat = 'readerWide' in loaded || 'hideToolbar' in loaded || 'autoFlip' in loaded;

    if (!isOldFormat) {
      // 已经是新格式，直接返回
      return loaded as AppSettings;
    }

    log.info('[SettingsStore] Detected old settings format, migrating to new structure...');

    // 将旧的顶层设置迁移到 sites.weread
    const migratedSiteSettings: SiteSettings = {
      readerWide: loaded.readerWide,
      hideToolbar: loaded.hideToolbar,
      lastReaderUrl: loaded.lastReaderUrl,
      scrollPosition: loaded.scrollPosition,
      readingProgress: loaded.readingProgress,
      autoFlip: loaded.autoFlip
    };

    // 构建新格式
    const migrated: AppSettings = {
      _version: loaded._version || 0,
      global: {
        zoom: loaded.zoom,
        autoUpdate: loaded.autoUpdate,
        lastPage: loaded.lastPage
      },
      sites: {
        weread: migratedSiteSettings
      }
    };

    log.info('[SettingsStore] Migration complete');
    return migrated;
  }

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

      // Migrate old settings format if needed
      const migrated = SettingsStore.migrateOldSettings(loaded);
      const loadedVersion = migrated._version || 0;

      // Apply defaults for new nested structure
      const initialSettings: AppSettings = {
        _version: loadedVersion,
        global: {
          zoom: 0.75, // Chrome 默认缩放级别
          autoUpdate: true,
          lastPage: true,
          ...migrated.global
        },
        sites: migrated.sites || {}
      };

      // Initialize optimistic lock
      this.lock = new OptimisticLock<AppSettings>(initialSettings, loadedVersion);
      log.debug('[SettingsStore] Initialized optimistic lock with version:', loadedVersion);
    } catch (e) {
      log.error('SettingsStore: Failed to load settings', e);
      const fallbackSettings: AppSettings = {
        _version: 0,
        global: {
          zoom: 0.75, // Chrome 默认缩放级别
          autoUpdate: true,
          lastPage: true
        },
        sites: {}
      };
      this.lock = new OptimisticLock<AppSettings>(fallbackSettings, 0);
    }

    // Listen for updates from other windows (e.g. settings window)
    listen('settings-updated', async () => {
      if (!this.lock) return;

      // Reload fresh settings from backend
      const newSettings = (await invoke<AppSettings>('get_settings')) || {};
      const backendVersion = newSettings._version || 0;

      log.debug('[SettingsStore] Received settings-updated event, backend version:', backendVersion, 'local version:', this.lock.getVersion());

      // Use optimistic lock to load external data
      const loaded = this.lock.loadFromExternal(newSettings, backendVersion);

      if (loaded) {
        log.debug('[SettingsStore] Loaded newer version from backend:', backendVersion);
        this.notify();
      } else {
        log.debug('[SettingsStore] Ignoring older version from backend:', backendVersion, '<', this.lock.getVersion());
      }
    });

    this.initialized = true;
    this.notify();
  }

  /**
   * 获取设置
   * 为了向后兼容，返回一个包含扁平化站点设置的对象
   * 这样旧代码可以继续访问 settings.readerWide 等属性
   */
  public get(): MergedSettings {
    const rawSettings = this.lock ? this.lock.getData() : {};
    // 动态获取当前站点设置
    const siteId = createSiteContext().siteId;
    const siteSettings = rawSettings.sites?.[siteId] || {};

    // 合并全局设置和当前站点设置到顶层（向后兼容）
    return {
      ...rawSettings,
      ...rawSettings.global,
      ...siteSettings
    } as MergedSettings;
  }

  /**
   * 获取全局设置
   */
  public getGlobal(): NonNullable<AppSettings['global']> {
    const rawSettings = this.lock ? this.lock.getData() : {};
    return rawSettings.global || {};
  }

  /**
   * 获取指定站点的设置
   * @param siteId 站点 ID（如 'weread'）
   */
  public getSite(siteId: string): SiteSettings {
    const rawSettings = this.lock ? this.lock.getData() : {};
    return rawSettings.sites?.[siteId] || {};
  }

  /**
   * 更新全局设置
   */
  public async updateGlobal(partial: Partial<NonNullable<AppSettings['global']>>) {
    const current = this.get();
    await this.update({
      global: {
        ...current.global,
        ...partial
      }
    });
  }

  /**
   * 更新指定站点的设置
   * @param siteId 站点 ID（如 'weread'）
   * @param partial 部分设置更新
   */
  public async updateSite(siteId: string, partial: Partial<SiteSettings>) {
    const current = this.get();
    await this.update({
      sites: {
        ...current.sites,
        [siteId]: {
          ...current.sites?.[siteId],
          ...partial
        }
      }
    });
  }

  /**
   * 向后兼容：获取当前站点设置（默认 weread）
   * 这个方法帮助旧代码无缝过渡到新的站点隔离结构
   * @deprecated 建议使用 getSite(siteId) 并传入具体的站点 ID
   */
  public getCurrentSiteSettings(): SiteSettings {
    return this.getSite('weread');
  }

  /**
   * 向后兼容：更新当前站点设置（默认 weread）
   * 这个方法帮助旧代码无缝过渡到新的站点隔离结构
   * @deprecated 建议使用 updateSite(siteId, partial) 并传入具体的站点 ID
   */
  public async updateCurrentSite(partial: Partial<SiteSettings>) {
    return this.updateSite('weread', partial);
  }

  public async update(partial: Partial<AppSettings> & Partial<SiteSettings>) {
    if (!this.lock) {
      log.error('[SettingsStore] Lock not initialized');
      return;
    }

    // Remove _version from partial (managed by lock)
    const { _version, ...partialWithoutVersion } = partial as any;

    // 智能路由：区分全局设置和站点设置
    const globalFields = ['zoom', 'autoUpdate', 'lastPage'];
    const siteFields = ['readerWide', 'hideToolbar', 'hideNavbar', 'lastReaderUrl', 'scrollPosition', 'readingProgress', 'autoFlip'];

    const current = this.lock.getData();
    let needsUpdate = false;
    let updatedSettings = { ...current };

    // 处理嵌套的 global 和 sites 更新
    if ('global' in partialWithoutVersion) {
      updatedSettings.global = {
        ...current.global,
        ...partialWithoutVersion.global
      };
      needsUpdate = true;
    }

    if ('sites' in partialWithoutVersion) {
      updatedSettings.sites = {
        ...current.sites,
        ...partialWithoutVersion.sites
      };
      needsUpdate = true;
    }

    // 处理扁平字段（向后兼容）- 自动路由到正确的嵌套位置
    const flatUpdates: Record<string, any> = {};
    for (const key in partialWithoutVersion) {
      if (key !== 'global' && key !== 'sites') {
        flatUpdates[key] = partialWithoutVersion[key];
      }
    }

    if (Object.keys(flatUpdates).length > 0) {
      const globalUpdates: any = {};
      const siteUpdates: any = {};

      for (const key in flatUpdates) {
        if (globalFields.includes(key)) {
          globalUpdates[key] = flatUpdates[key];
        } else if (siteFields.includes(key)) {
          siteUpdates[key] = flatUpdates[key];
        }
      }

      if (Object.keys(globalUpdates).length > 0) {
        updatedSettings.global = {
          ...current.global,
          ...globalUpdates
        };
        needsUpdate = true;
      }

      if (Object.keys(siteUpdates).length > 0) {
        const siteId = createSiteContext().siteId;
        updatedSettings.sites = {
          ...current.sites,
          [siteId]: {
            ...current.sites?.[siteId],
            ...siteUpdates
          }
        };
        needsUpdate = true;
      }
    }

    if (!needsUpdate) return;

    // Use optimistic lock to perform update
    const result = this.lock.tryUpdate(updatedSettings);

    log.debug('[SettingsStore] Update: version', result.version - 1, '->', result.version, 'partial:', partialWithoutVersion);

    // Notify listeners immediately (optimistic UI update)
    this.notify();

    // Persist to backend with new version
    // IMPORTANT: Only save the clean nested structure (global, sites, _version)
    // Do NOT save flattened fields to prevent data pollution
    const cleanSettings: AppSettings = {
      _version: result.version,
      global: result.data.global,
      sites: result.data.sites
    };

    try {
      await invoke('save_settings', {
        settings: cleanSettings,  // Send only clean nested structure
        version: result.version
      });
      log.debug('[SettingsStore] Saved successfully with version:', result.version);
    } catch (e) {
      log.error('[SettingsStore] Failed to save settings', e);
      // Revert version on error
      this.lock.forceSet(result.data, result.version - 1);
      // Notify listeners of revert
      this.notify();
    }
  }

  public subscribe(listener: SettingsListener) {
    this.listeners.add(listener);
    // Notify immediately with current settings
    if (this.initialized && this.lock) {
        listener(this.get());
    }
    return () => this.listeners.delete(listener);
  }

  // ==================== 插件管理方法 ====================

  /**
   * 检查插件是否启用
   * undefined 表示全部启用（向后兼容旧版本）
   */
  public isPluginEnabled(pluginId: string): boolean {
    const enabledPlugins = this.getGlobal().enabledPlugins;
    if (enabledPlugins === undefined) return true;  // 兼容旧版：undefined = 全部启用
    return enabledPlugins.includes(pluginId);
  }

  /**
   * 获取启用的插件列表
   * @returns undefined 表示全部启用，数组表示只启用列表中的插件
   */
  public getEnabledPlugins(): string[] | undefined {
    return this.getGlobal().enabledPlugins;
  }

  /**
   * 启用插件
   * @param pluginId 插件 ID
   */
  public async enablePlugin(pluginId: string): Promise<void> {
    const global = this.getGlobal();
    const currentList = global.enabledPlugins;
    
    // 如果 undefined（全部启用），不需要操作
    if (currentList === undefined) return;
    
    if (!currentList.includes(pluginId)) {
      await this.updateGlobal({
        enabledPlugins: [...currentList, pluginId]
      });
    }
  }

  /**
   * 禁用插件
   * @param pluginId 插件 ID
   * @param allPluginIds 所有已注册的插件 ID 列表（当 enabledPlugins 为 undefined 时需要）
   */
  public async disablePlugin(pluginId: string, allPluginIds?: string[]): Promise<void> {
    const global = this.getGlobal();
    let currentList = global.enabledPlugins;
    
    // 如果 undefined，需要先初始化为所有插件 ID（排除要禁用的）
    if (currentList === undefined) {
      if (!allPluginIds) {
        log.warn('[SettingsStore] disablePlugin: allPluginIds required when enabledPlugins is undefined');
        // 如果没有提供 allPluginIds，只能设置为空数组（禁用所有）
        currentList = [];
      } else {
        currentList = allPluginIds;
      }
    }
    
    await this.updateGlobal({
      enabledPlugins: currentList.filter(id => id !== pluginId)
    });
  }

  /**
   * 强制刷新设置（从后端重新加载）
   * 用于热重载场景，确保获取最新的设置状态
   */
  public async refresh(): Promise<void> {
    if (!this.lock) return;
    
    const newSettings = (await invoke<AppSettings>('get_settings')) || {};
    const backendVersion = newSettings._version || 0;
    
    log.debug('[SettingsStore] Manual refresh, backend version:', backendVersion);
    
    // 强制加载后端数据
    this.lock.loadFromExternal(newSettings, backendVersion);
    this.notify();
  }

  private notify() {
    if (!this.lock) return;
    const current = this.get();
    this.listeners.forEach(l => l(current));
  }
}

export const settingsStore = SettingsStore.getInstance();
