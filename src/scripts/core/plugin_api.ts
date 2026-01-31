/**
 * Plugin API Implementation
 * 插件 API 实现
 * 
 * 为每个插件创建独立的 API 实例，提供命名空间隔离
 */

import { injectCSS, removeCSS } from './utils';
import { settingsStore } from './settings_store';
import { EventBus } from './event_bus';
import { log as coreLog } from './logger';
import type {
  PluginAPI,
  StyleAPI,
  SettingsAPI,
  EventsAPI,
  MenuAPI,
  StorageAPI,
  LogAPI,
  ContentAPI,
  MenuItem,
  PluginManifest,
} from './plugin_types';

/**
 * 为插件创建 Style API
 * 样式 ID 自动添加插件前缀，避免冲突
 */
const createStyleAPI = (pluginId: string): StyleAPI => {
  const prefix = `plugin-${pluginId}-`;
  
  return {
    inject(id: string, css: string): void {
      injectCSS(`${prefix}${id}`, css);
    },
    
    remove(id: string): void {
      removeCSS(`${prefix}${id}`);
    },
    
    has(id: string): boolean {
      return !!document.getElementById(`${prefix}${id}`);
    },
  };
};

/**
 * 为插件创建 Settings API
 * 设置存储在 sites.[pluginId] 命名空间下
 */
const createSettingsAPI = (pluginId: string): SettingsAPI => {
  return {
    get<T>(key: string, defaultValue?: T): T {
      const siteSettings = settingsStore.getSite(pluginId);
      const value = (siteSettings as any)?.[key];
      return value !== undefined ? value : (defaultValue as T);
    },
    
    async set(key: string, value: any): Promise<void> {
      await settingsStore.updateSite(pluginId, { [key]: value });
    },
    
    getAll(): Record<string, any> {
      return settingsStore.getSite(pluginId) || {};
    },
    
    subscribe(callback: (settings: Record<string, any>) => void): () => void {
      return settingsStore.subscribe(() => {
        callback(settingsStore.getSite(pluginId) || {});
      });
    },
  };
};

/**
 * 为插件创建 Events API
 * 事件名自动添加插件前缀
 */
const createEventsAPI = (pluginId: string): EventsAPI => {
  const prefix = `plugin:${pluginId}:`;
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  
  return {
    on(event: string, handler: (...args: any[]) => void): () => void {
      const fullEvent = `${prefix}${event}`;
      
      if (!handlers.has(fullEvent)) {
        handlers.set(fullEvent, new Set());
      }
      handlers.get(fullEvent)!.add(handler);
      
      // 同时监听全局事件总线
      const unsubscribe = EventBus.on(fullEvent, handler);
      
      return () => {
        handlers.get(fullEvent)?.delete(handler);
        unsubscribe();
      };
    },
    
    emit(event: string, ...args: any[]): void {
      const fullEvent = `${prefix}${event}`;
      EventBus.emit(fullEvent, ...args);
    },
    
    once(event: string, handler: (...args: any[]) => void): () => void {
      const fullEvent = `${prefix}${event}`;
      
      const wrappedHandler = (...args: any[]) => {
        handler(...args);
        unsubscribe();
      };
      
      const unsubscribe = EventBus.on(fullEvent, wrappedHandler);
      return unsubscribe;
    },
  };
};

/**
 * 为插件创建 Menu API
 * 菜单项 ID 自动添加插件前缀
 */
const createMenuAPI = (pluginId: string): MenuAPI => {
  const prefix = `plugin_${pluginId}_`;
  const registeredItems: MenuItem[] = [];
  
  return {
    register(items: MenuItem[]): void {
      items.forEach(item => {
        const prefixedItem = {
          ...item,
          id: `${prefix}${item.id}`,
        };
        registeredItems.push(prefixedItem);
        // TODO: 实际注册到 Rust 菜单系统
        coreLog.debug(`[PluginAPI] Menu item registered: ${prefixedItem.id}`);
      });
    },
    
    setEnabled(id: string, enabled: boolean): void {
      const fullId = `${prefix}${id}`;
      // TODO: 调用 Rust 设置菜单项状态
      coreLog.debug(`[PluginAPI] Menu item ${fullId} enabled: ${enabled}`);
    },
    
    setChecked(id: string, checked: boolean): void {
      const fullId = `${prefix}${id}`;
      // TODO: 调用 Rust 设置菜单项选中状态
      coreLog.debug(`[PluginAPI] Menu item ${fullId} checked: ${checked}`);
    },
    
    getReaderMenuIds(): string[] {
      return registeredItems
        .filter(item => item.id.includes('reader'))
        .map(item => item.id);
    },
  };
};

/**
 * 为插件创建 Storage API
 * 使用 Tauri Store 插件，数据存储在独立文件中
 */
const createStorageAPI = (pluginId: string): StorageAPI => {
  const storageKey = (key: string) => `plugin_${pluginId}_${key}`;
  
  // 使用 localStorage 作为临时存储
  // 未来可以切换到 Tauri Store 插件
  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        const value = localStorage.getItem(storageKey(key));
        return value ? JSON.parse(value) : null;
      } catch {
        return null;
      }
    },
    
    async set(key: string, value: any): Promise<void> {
      localStorage.setItem(storageKey(key), JSON.stringify(value));
    },
    
    async remove(key: string): Promise<void> {
      localStorage.removeItem(storageKey(key));
    },
    
    async keys(): Promise<string[]> {
      const prefix = storageKey('');
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) {
          keys.push(key.slice(prefix.length));
        }
      }
      return keys;
    },
  };
};

/**
 * 为插件创建 Log API
 * 日志自动添加插件前缀
 */
const createLogAPI = (pluginId: string): LogAPI => {
  const prefix = `[Plugin:${pluginId}]`;
  
  return {
    debug(...args: any[]): void {
      coreLog.debug(prefix, ...args);
    },
    info(...args: any[]): void {
      coreLog.info(prefix, ...args);
    },
    warn(...args: any[]): void {
      coreLog.warn(prefix, ...args);
    },
    error(...args: any[]): void {
      coreLog.error(prefix, ...args);
    },
  };
};

/**
 * 为插件创建 Content API
 * 用于 Local 类型插件渲染内容（当前为占位实现）
 */
const createContentAPI = (_pluginId: string): ContentAPI => {
  return {
    render(_html: string): void {
      // 未来实现：渲染 HTML 到阅读区域
      coreLog.warn('[ContentAPI] render() not implemented yet');
    },
    
    getContainer(): HTMLElement | null {
      // 尝试获取阅读区域容器
      return document.querySelector('.readerChapterContent') || 
             document.querySelector('#reader-container') ||
             document.body;
    },
    
    scrollTo(position: number): void {
      window.scrollTo({ top: position, behavior: 'smooth' });
    },
    
    getScrollPosition(): number {
      return window.scrollY;
    },
  };
};

/**
 * 为指定插件创建完整的 PluginAPI 实例
 * 每个插件获得独立的命名空间
 */
export const createPluginAPI = (manifest: PluginManifest): PluginAPI => {
  const pluginId = manifest.id;
  
  return {
    style: createStyleAPI(pluginId),
    settings: createSettingsAPI(pluginId),
    events: createEventsAPI(pluginId),
    menu: createMenuAPI(pluginId),
    storage: createStorageAPI(pluginId),
    log: createLogAPI(pluginId),
    content: createContentAPI(pluginId),
  };
};

/**
 * 获取全局事件总线（供跨插件通信使用）
 * 插件可以通过此方式监听框架级事件
 */
export const getGlobalEventBus = () => EventBus;

/**
 * 获取全局设置存储（只读访问）
 * 插件可以读取全局设置，但不能修改
 */
export const getGlobalSettings = () => {
  return {
    get: () => settingsStore.getGlobal(),
  };
};
