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
import { createPluginAPI } from './plugin_api';
import { getPluginRegistry } from './plugin_registry';
import type { ReaderPlugin } from './plugin_types';

export class PluginLoader {
  private static instance: PluginLoader;
  
  /** 内置插件工厂函数列表 */
  private builtinFactories: Array<() => ReaderPlugin> = [];
  
  /** 是否已初始化 */
  private initialized = false;
  
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
  registerBuiltin(factory: () => ReaderPlugin): void {
    this.builtinFactories.push(factory);
  }
  
  /**
   * 初始化并加载所有插件
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      log.warn('[PluginLoader] Already initialized');
      return;
    }
    
    log.info('[PluginLoader] Initializing...');
    
    const registry = getPluginRegistry();
    
    // 1. 创建并注册所有内置插件
    for (const factory of this.builtinFactories) {
      try {
        const plugin = factory();
        registry.register(plugin);
      } catch (e) {
        log.error('[PluginLoader] Failed to create builtin plugin', e);
      }
    }
    
    // 2. 加载外部插件（未来实现）
    // await this.loadExternalPlugins();
    
    // 3. 自动激活匹配当前页面的插件
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
    
    if (registered.state === 'loaded') {
      log.debug(`[PluginLoader] Plugin '${pluginId}' already loaded`);
      return true;
    }
    
    const { plugin } = registered;
    const manifest = plugin.manifest;
    
    log.info(`[PluginLoader] Loading plugin: ${manifest.id} (${manifest.name})`);
    registry.updateState(pluginId, 'loading');
    
    try {
      // 创建插件专属的 API 实例
      const api = createPluginAPI(manifest);
      
      // 调用插件的 onLoad 生命周期方法
      plugin.onLoad(api);
      
      registry.updateState(pluginId, 'loaded');
      log.info(`[PluginLoader] Plugin loaded: ${manifest.id}`);
      
      return true;
    } catch (e) {
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
    
    try {
      registered.plugin.onUnload();
      registry.updateState(pluginId, 'unloaded');
      log.info(`[PluginLoader] Plugin unloaded: ${pluginId}`);
      return true;
    } catch (e) {
      log.error(`[PluginLoader] Failed to unload plugin '${pluginId}'`, e);
      return false;
    }
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
  getActivePlugin(): ReaderPlugin | null {
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
    method: keyof ReaderPlugin,
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
}

/**
 * 获取插件加载器单例
 */
export const getPluginLoader = () => PluginLoader.getInstance();
