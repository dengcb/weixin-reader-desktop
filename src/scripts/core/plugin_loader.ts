/**
 * Plugin Loader
 * 插件加载器
 * 
 * 负责加载、初始化和管理插件生命周期
 * - 加载内置插件
 * - 加载外部插件（未来支持）
 * - 管理插件生命周期
 */

import { log } from './logger';
import { cleanupPluginAPI, createPluginAPI } from './plugin_api';
import { getPluginRegistry } from './plugin_registry';
import { settingsStore } from './settings_store';
import { invoke } from './tauri';
import type { PluginManifest, ReaderPlugin } from './plugin_types';
import {
  createPluginSiteRuntime,
  type ReaderSiteRuntime,
} from './reader_site_runtime';

export class PluginLoader {
  private static instance: PluginLoader;
  
  /** 内置插件工厂函数列表 */
  private builtinFactories: Array<() => ReaderPlugin | ReaderSiteRuntime> = [];
  
  /** 是否已初始化 */
  private initialized = false;

  /** 当前外部插件包内可由插件代码读取的 CSS 文件。 */
  private externalStyleFiles = new Map<string, Readonly<Record<string, string>>>();
  private forcedPluginId: string | undefined;
  
  private constructor() {}
  
  /**
   * 获取单例实例
   */
  static getInstance(): PluginLoader {
    if (!PluginLoader.instance) {
      PluginLoader.instance = new PluginLoader();
    }
    return PluginLoader.instance;
  }
  
  /**
   * 注册内置插件工厂
   * @param factory 创建插件实例的工厂函数
   */
  registerBuiltin(factory: () => ReaderPlugin | ReaderSiteRuntime): void {
    if (!this.builtinFactories.includes(factory)) this.builtinFactories.push(factory);
  }
  
  /**
   * 初始化并加载所有插件
   */
  async initialize(forcedPluginId?: string): Promise<void> {
    if (this.initialized) {
      log.warn('[PluginLoader] Already initialized');
      return;
    }
    
    log.info('[PluginLoader] Initializing...');
    this.forcedPluginId = forcedPluginId;
    
    const registry = getPluginRegistry();
    
    // 1. 创建并注册所有内置插件（检查是否启用）
    for (const factory of this.builtinFactories) {
      try {
        const plugin = factory();
        const pluginId = plugin.manifest.id;
        
        // 检查是否启用
        const alwaysEnabled = plugin.manifest.builtin && plugin.manifest.sourceType === 'local';
        if (!alwaysEnabled && !settingsStore.isPluginEnabled(pluginId)) {
          log.info(`[PluginLoader] Skipping disabled builtin plugin: ${pluginId}`);
          // 工厂可能在构造时建立了站点内部监听（WeRead 进度桥接器）。
          plugin.onUnload();
          continue;
        }
        
        registry.register(plugin);
      } catch (e) {
        log.error('[PluginLoader] Failed to create builtin plugin', e);
      }
    }
    
    // 2. 强制本地运行时由可信页面独占，不读取任何远程网页插件代码。
    if (!this.forcedPluginId) await this.loadExternalPlugins();
    
    // 3. 自动激活匹配当前页面的插件
    if (forcedPluginId) registry.setActivePlugin(forcedPluginId);
    const activePlugin = registry.getActivePlugin();
    
    if (activePlugin) {
      await this.loadPlugin(activePlugin.plugin.manifest.id);
    } else {
      log.warn('[PluginLoader] No plugin matched current page');
    }
    
    this.initialized = true;
    
    const stats = registry.getStats();
    log.info(`[PluginLoader] Initialized. Total: ${stats.total}, Loaded: ${stats.loaded}, Web: ${stats.web}, Local: ${stats.local}`);
  }
  
  /**
   * 加载指定插件
   * @param pluginId 插件 ID
   */
  async loadPlugin(pluginId: string): Promise<boolean> {
    const registry = getPluginRegistry();
    const registered = registry.get(pluginId);
    
    if (!registered) {
      log.error(`[PluginLoader] Plugin '${pluginId}' not found`);
      return false;
    }
    
    const { plugin } = registered;
    const manifest = plugin.manifest;

    // 检查插件是否启用（用户可能已卸载/禁用该插件）
    const alwaysEnabled = manifest.builtin && manifest.sourceType === 'local';
    if (!alwaysEnabled && !settingsStore.isPluginEnabled(pluginId)) {
      log.info(`[PluginLoader] Plugin '${pluginId}' is disabled by settings, skipping`);
      return false;
    }
    
    if (registered.state === 'loaded') {
      log.debug(`[PluginLoader] Plugin '${pluginId}' already loaded`);
      return true;
    }
    
    log.info(`[PluginLoader] Loading plugin: ${manifest.id} (${manifest.name})`);
    registry.updateState(pluginId, 'loading');
    
    try {
      // 创建插件专属的 API 实例
      const api = createPluginAPI(
        manifest,
        this.externalStyleFiles.get(pluginId) ?? {},
      );
      
      // 调用插件的 onLoad 生命周期方法
      plugin.onLoad(api);
      
      registry.updateState(pluginId, 'loaded');
      log.info(`[PluginLoader] Plugin loaded: ${manifest.id}`);
      
      return true;
    } catch (e) {
      // onLoad 可能在失败前已注册了事件或注入了样式。
      try { plugin.onUnload(); } catch (unloadError) {
        log.error(`[PluginLoader] Failed to roll back plugin '${pluginId}'`, unloadError);
      }
      cleanupPluginAPI(pluginId);
      const errorMsg = e instanceof Error ? e.message : String(e);
      registry.updateState(pluginId, 'error', errorMsg);
      log.error(`[PluginLoader] Failed to load plugin '${pluginId}'`, e);
      return false;
    }
  }
  
  /**
   * 卸载指定插件
   * @param pluginId 插件 ID
   */
  async unloadPlugin(pluginId: string): Promise<boolean> {
    const registry = getPluginRegistry();
    const registered = registry.get(pluginId);
    
    if (!registered) {
      log.error(`[PluginLoader] Plugin '${pluginId}' not found`);
      return false;
    }
    
    if (registered.state !== 'loaded') {
      log.debug(`[PluginLoader] Plugin '${pluginId}' not loaded`);
      return true;
    }
    
    log.info(`[PluginLoader] Unloading plugin: ${pluginId}`);
    
    let succeeded = true;
    try {
      registered.plugin.onUnload();
    } catch (e) {
      succeeded = false;
      log.error(`[PluginLoader] Failed to unload plugin '${pluginId}'`, e);
    } finally {
      cleanupPluginAPI(pluginId);
      registry.updateState(pluginId, 'unloaded');
    }
    log.info(`[PluginLoader] Plugin unloaded: ${pluginId}`);
    return succeeded;
  }
  
  /**
   * 重新加载指定插件
   * @param pluginId 插件 ID
   */
  async reloadPlugin(pluginId: string): Promise<boolean> {
    await this.unloadPlugin(pluginId);
    return this.loadPlugin(pluginId);
  }
  
  /**
   * 获取当前活动的插件
   */
  getActivePlugin(): ReaderSiteRuntime | null {
    const registry = getPluginRegistry();
    const active = registry.getActivePlugin();
    return active?.plugin || null;
  }
  
  /**
   * 检查当前页面是否是阅读页面
   */
  isReaderPage(): boolean {
    return getPluginRegistry().isReaderPage();
  }
  
  /**
   * 检查当前页面是否是首页
   */
  isHomePage(): boolean {
    return getPluginRegistry().isHomePage();
  }
  
  /**
   * 获取插件的样式
   */
  getPluginStyles(pluginId?: string) {
    const registry = getPluginRegistry();
    const registered = pluginId 
      ? registry.get(pluginId)
      : registry.getActivePlugin();
    
    if (!registered || registered.state !== 'loaded') {
      return null;
    }
    
    return registered.plugin.getStyles();
  }
  
  /**
   * 执行插件方法（带安全检查）
   */
  invokePluginMethod<T>(
    method: keyof ReaderSiteRuntime,
    ...args: any[]
  ): T | null {
    const plugin = this.getActivePlugin();
    
    if (!plugin) {
      log.warn(`[PluginLoader] No active plugin for method '${String(method)}'`);
      return null;
    }
    
    const fn = plugin[method];
    
    if (typeof fn !== 'function') {
      log.warn(`[PluginLoader] Plugin method '${String(method)}' not found`);
      return null;
    }
    
    try {
      return (fn as Function).apply(plugin, args);
    } catch (e) {
      log.error(`[PluginLoader] Error invoking plugin method '${String(method)}'`, e);
      return null;
    }
  }
  
  // ==================== 插件安装/卸载 API ====================
  
  /**
   * 安装插件（启用 + 加载）
   * @param pluginId 插件 ID
   */
  async installPlugin(pluginId: string): Promise<boolean> {
    log.info(`[PluginLoader] Installing plugin: ${pluginId}`);
    
    // 1. 启用插件
    await settingsStore.enablePlugin(pluginId);
    
    // 2. 加载插件
    const loaded = await this.loadPlugin(pluginId);
    
    if (loaded) {
      log.info(`[PluginLoader] Plugin installed: ${pluginId}`);
    } else {
      log.warn(`[PluginLoader] Plugin enabled but not loaded: ${pluginId} (may need page refresh)`);
    }
    
    return loaded;
  }
  
  /**
   * 卸载插件（卸载运行时 + 禁用）
   * @param pluginId 插件 ID
   */
  async uninstallPlugin(pluginId: string): Promise<boolean> {
    log.info(`[PluginLoader] Uninstalling plugin: ${pluginId}`);
    
    // 1. 卸载运行时
    const unloaded = await this.unloadPlugin(pluginId);
    
    // 2. 禁用插件（需要传入所有插件 ID 以处理 undefined 情况）
    const registry = getPluginRegistry();
    const allPluginIds = registry.getAll().map(r => r.plugin.manifest.id);
    await settingsStore.disablePlugin(pluginId, allPluginIds);
    
    log.info(`[PluginLoader] Plugin uninstalled: ${pluginId}`);
    return unloaded;
  }
  
  /**
   * 检查插件是否已安装（启用状态）
   * @param pluginId 插件 ID
   */
  isPluginInstalled(pluginId: string): boolean {
    return settingsStore.isPluginEnabled(pluginId);
  }
  
  // ==================== 热重载 API ====================
  
  /**
   * 热重载插件系统
   * 卸载所有已加载插件，重新注册启用的插件，并加载匹配当前页面的插件
   */
  async hotReload(): Promise<void> {
    log.info('[PluginLoader] Hot reloading plugin system...');
    
    const registry = getPluginRegistry();
    
    // 1. 卸载所有已加载的插件
    const allRegistered = [...registry.getAll()];
    for (const registered of allRegistered) {
      if (registered.state === 'loaded') {
        await this.unloadPlugin(registered.plugin.manifest.id);
      }
    }
    
    // 2. 清空注册表
    registry.clear();
    
    // 3. 重新注册启用的内置插件
    for (const factory of this.builtinFactories) {
      try {
        const plugin = factory();
        const pluginId = plugin.manifest.id;
        
        const alwaysEnabled = plugin.manifest.builtin && plugin.manifest.sourceType === 'local';
        if (!alwaysEnabled && !settingsStore.isPluginEnabled(pluginId)) {
          log.info(`[PluginLoader] Skipping disabled plugin during hot reload: ${pluginId}`);
          plugin.onUnload();
          continue;
        }
        
        registry.register(plugin);
      } catch (e) {
        log.error('[PluginLoader] Failed to create plugin during hot reload', e);
      }
    }
    
    // 3.5 本地阅读页不读取外部网页插件。
    if (!this.forcedPluginId) await this.loadExternalPlugins();
    
    // 4. 自动激活匹配当前页面的插件
    if (this.forcedPluginId) registry.setActivePlugin(this.forcedPluginId);
    const activePlugin = registry.getActivePlugin();
    
    if (activePlugin) {
      await this.loadPlugin(activePlugin.plugin.manifest.id);
    } else {
      log.warn('[PluginLoader] No plugin matched current page after hot reload');
    }
    
    const stats = registry.getStats();
    log.info(`[PluginLoader] Hot reload complete. Total: ${stats.total}, Loaded: ${stats.loaded}`);
  }
  
  // ==================== 外部插件加载 ====================

  /**
   * 加载所有已安装的外部插件（.atrd）
   * 从磁盘取插件代码，实例化后注册进插件系统（与内置插件同一激活路径）
   */
  private async loadExternalPlugins(): Promise<void> {
    const registry = getPluginRegistry();
    let runtimePlugin: {
      plugin: Pick<PluginManifest, 'id'> & Partial<PluginManifest>;
      code: string;
      styles?: Record<string, string>;
    } | null = null;
    try {
      runtimePlugin = await invoke('get_runtime_plugin');
    } catch (e) {
      log.error('[PluginLoader] get_runtime_plugin failed', e);
      return;
    }

    if (!runtimePlugin?.plugin?.id || typeof runtimePlugin.code !== 'string') return;
    const pluginId = runtimePlugin.plugin.id;
    if (registry.get(pluginId)) return;
    try {
      const instance = await this.instantiateFromCode(runtimePlugin.code);
      if (instance?.manifest.id === pluginId) {
        const installedManifest: PluginManifest = {
          ...instance.manifest,
          ...runtimePlugin.plugin,
          renderMode: runtimePlugin.plugin.renderMode ?? instance.manifest.renderMode,
          capabilities: runtimePlugin.plugin.capabilities ?? {},
        };
        this.externalStyleFiles.set(
          pluginId,
          Object.freeze({ ...(runtimePlugin.styles ?? {}) }),
        );
        registry.register(createPluginSiteRuntime(instance, installedManifest));
        log.info(`[PluginLoader] External plugin registered: ${pluginId}`);
      } else if (instance) {
        log.error(`[PluginLoader] Runtime plugin ID mismatch: expected '${pluginId}'`);
      } else {
        log.warn(`[PluginLoader] External plugin '${pluginId}' has no default export`);
      }
    } catch (e) {
      log.error(`[PluginLoader] Failed to load external plugin '${pluginId}'`, e);
    }
  }

  /**
   * 从插件代码文本实例化插件
   * 约定：外部插件 export default 其插件类（实现 ReaderPlugin）
   * 使用 Blob URL + 运行时变量 specifier 的动态 import，避免被打包器静态解析
   */
  private async instantiateFromCode(code: string): Promise<ReaderPlugin | null> {
    const blob = new Blob([code], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      const mod = await import(/* @vite-ignore */ url);
      const PluginClass = mod?.default;
      return typeof PluginClass === 'function' ? new PluginClass() : null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  destroy(): void {
    const registry = getPluginRegistry();
    for (const registered of registry.getAll()) {
      if (registered.state !== 'loaded') continue;
      try { registered.plugin.onUnload(); } catch (error) {
        log.error(`[PluginLoader] Failed to unload '${registered.plugin.id}' during destroy`, error);
      }
      cleanupPluginAPI(registered.plugin.id);
      registry.updateState(registered.plugin.id, 'unloaded');
    }
    registry.clear();
    this.externalStyleFiles.clear();
    this.initialized = false;
  }
}

/**
 * 获取插件加载器单例
 */
export const getPluginLoader = () => PluginLoader.getInstance();
