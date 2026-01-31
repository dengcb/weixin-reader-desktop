/**
 * Plugin Registry
 * 插件注册表
 * 
 * 管理所有已注册插件的单例类
 * - 注册/注销插件
 * - 根据域名/文件类型匹配插件
 * - 获取当前活动插件
 */

import { log } from './logger';
import type {
  ReaderPlugin,
  RegisteredPlugin,
  PluginState,
} from './plugin_types';

export class PluginRegistry {
  private static instance: PluginRegistry;
  
  /** 已注册的插件 Map<pluginId, RegisteredPlugin> */
  private plugins: Map<string, RegisteredPlugin> = new Map();
  
  /** 当前活动的插件（匹配当前页面的插件） */
  private activePlugin: RegisteredPlugin | null = null;
  
  private constructor() {}
  
  /**
   * 获取单例实例
   */
  static getInstance(): PluginRegistry {
    if (!PluginRegistry.instance) {
      PluginRegistry.instance = new PluginRegistry();
    }
    return PluginRegistry.instance;
  }
  
  /**
   * 注册插件
   * @param plugin 插件实例
   */
  register(plugin: ReaderPlugin): void {
    const id = plugin.manifest.id;
    
    if (this.plugins.has(id)) {
      log.warn(`[PluginRegistry] Plugin '${id}' already registered, skipping`);
      return;
    }
    
    const registered: RegisteredPlugin = {
      plugin,
      state: 'unloaded',
    };
    
    this.plugins.set(id, registered);
    log.info(`[PluginRegistry] Plugin registered: ${id} (${plugin.manifest.name})`);
  }
  
  /**
   * 注销插件
   * @param pluginId 插件 ID
   */
  unregister(pluginId: string): boolean {
    const registered = this.plugins.get(pluginId);
    
    if (!registered) {
      log.warn(`[PluginRegistry] Plugin '${pluginId}' not found`);
      return false;
    }
    
    // 如果插件已加载，先卸载
    if (registered.state === 'loaded') {
      try {
        registered.plugin.onUnload();
      } catch (e) {
        log.error(`[PluginRegistry] Error unloading plugin '${pluginId}'`, e);
      }
    }
    
    this.plugins.delete(pluginId);
    
    // 如果是当前活动插件，清除引用
    if (this.activePlugin?.plugin.manifest.id === pluginId) {
      this.activePlugin = null;
    }
    
    log.info(`[PluginRegistry] Plugin unregistered: ${pluginId}`);
    return true;
  }
  
  /**
   * 获取插件
   * @param pluginId 插件 ID
   */
  get(pluginId: string): RegisteredPlugin | undefined {
    return this.plugins.get(pluginId);
  }
  
  /**
   * 获取所有已注册的插件
   */
  getAll(): RegisteredPlugin[] {
    return Array.from(this.plugins.values());
  }
  
  /**
   * 获取所有 Web 类型插件
   */
  getWebPlugins(): RegisteredPlugin[] {
    return this.getAll().filter(p => p.plugin.manifest.sourceType === 'web');
  }
  
  /**
   * 获取所有 Local 类型插件
   */
  getLocalPlugins(): RegisteredPlugin[] {
    return this.getAll().filter(p => p.plugin.manifest.sourceType === 'local');
  }
  
  /**
   * 根据当前域名查找匹配的 Web 插件
   */
  findByDomain(): RegisteredPlugin | null {
    for (const registered of this.plugins.values()) {
      const { plugin } = registered;
      
      // 只检查 Web 类型插件
      if (plugin.manifest.sourceType !== 'web') continue;
      
      // 使用插件的 matchesDomain 方法
      if (plugin.matchesDomain()) {
        return registered;
      }
    }
    
    return null;
  }
  
  /**
   * 根据文件扩展名查找匹配的 Local 插件
   * @param extension 文件扩展名（如 '.epub'）
   */
  findByExtension(extension: string): RegisteredPlugin | null {
    const ext = extension.toLowerCase();
    
    for (const registered of this.plugins.values()) {
      const { plugin } = registered;
      
      // 只检查 Local 类型插件
      if (plugin.manifest.sourceType !== 'local') continue;
      
      const fileTypes = plugin.manifest.fileTypes;
      if (fileTypes?.extensions.includes(ext)) {
        return registered;
      }
    }
    
    return null;
  }
  
  /**
   * 获取当前活动的插件
   * 如果没有缓存，则尝试根据当前域名查找
   */
  getActivePlugin(): RegisteredPlugin | null {
    // 如果有缓存且仍然匹配，返回缓存
    if (this.activePlugin) {
      const plugin = this.activePlugin.plugin;
      if (plugin.manifest.sourceType === 'web' && plugin.matchesDomain()) {
        return this.activePlugin;
      }
    }
    
    // 尝试查找匹配的插件
    this.activePlugin = this.findByDomain();
    return this.activePlugin;
  }
  
  /**
   * 设置活动插件
   * @param pluginId 插件 ID
   */
  setActivePlugin(pluginId: string): boolean {
    const registered = this.plugins.get(pluginId);
    
    if (!registered) {
      log.warn(`[PluginRegistry] Cannot set active plugin: '${pluginId}' not found`);
      return false;
    }
    
    this.activePlugin = registered;
    log.info(`[PluginRegistry] Active plugin set: ${pluginId}`);
    return true;
  }
  
  /**
   * 更新插件状态
   */
  updateState(pluginId: string, state: PluginState, error?: string): void {
    const registered = this.plugins.get(pluginId);
    
    if (registered) {
      registered.state = state;
      registered.error = error;
      
      if (state === 'loaded') {
        registered.loadedAt = Date.now();
      }
    }
  }
  
  /**
   * 检查当前页面是否是阅读页面
   */
  isReaderPage(): boolean {
    const active = this.getActivePlugin();
    return active ? active.plugin.isReaderPage() : false;
  }
  
  /**
   * 检查当前页面是否是首页
   */
  isHomePage(): boolean {
    const active = this.getActivePlugin();
    return active ? active.plugin.isHomePage() : false;
  }
  
  /**
   * 获取插件统计信息
   */
  getStats(): {
    total: number;
    loaded: number;
    web: number;
    local: number;
    builtin: number;
  } {
    const all = this.getAll();
    return {
      total: all.length,
      loaded: all.filter(p => p.state === 'loaded').length,
      web: all.filter(p => p.plugin.manifest.sourceType === 'web').length,
      local: all.filter(p => p.plugin.manifest.sourceType === 'local').length,
      builtin: all.filter(p => p.plugin.manifest.builtin).length,
    };
  }
  
  /**
   * 清空所有插件
   * 用于测试或重置
   */
  clear(): void {
    // 先卸载所有已加载的插件
    for (const registered of this.plugins.values()) {
      if (registered.state === 'loaded') {
        try {
          registered.plugin.onUnload();
        } catch (e) {
          log.error(`[PluginRegistry] Error unloading plugin during clear`, e);
        }
      }
    }
    
    this.plugins.clear();
    this.activePlugin = null;
    log.info('[PluginRegistry] All plugins cleared');
  }
}

/**
 * 获取插件注册表单例
 */
export const getPluginRegistry = () => PluginRegistry.getInstance();
