/**
 * 艾特阅读 - 插件系统入口
 * AT Reader - Plugin System Entry
 * 
 * 基于插件化架构，支持多阅读网站适配
 * 微信读书作为默认内置插件
 */

import { log } from './core/logger';
import { settingsStore } from './core/settings_store';
import { getPluginLoader } from './core/plugin_loader';
import { getPluginRegistry } from './core/plugin_registry';
import { builtinPluginFactories } from '../plugins/builtin';

// 旧适配器系统（向后兼容）
import { getSiteRegistry } from './core/site_registry';
import { createAdapterInstances } from './adapters';

// 管理器（核心功能）
import { IPCManager } from './managers/ipc_manager';
import { AppManager } from './managers/app_manager';
import { TurnerManager } from './managers/turner_manager';
import { MenuManager } from './managers/menu_manager';
import { ThemeManager } from './managers/theme_manager';
import { StyleManager } from './managers/style_manager';
import { RemoteManager } from './managers/remote_manager';

/**
 * 初始化旧适配器系统（向后兼容）
 * 管理器仍然依赖 SiteRegistry，需要保持工作
 */
function initLegacyAdapters(): void {
  const siteRegistry = getSiteRegistry();
  const adapters = createAdapterInstances();
  
  adapters.forEach(adapter => {
    siteRegistry.register(adapter);
  });
  
  log.info(`[Inject] Registered ${adapters.length} legacy adapters for compatibility`);
}

/**
 * 初始化插件系统
 */
async function initPluginSystem(): Promise<void> {
  const loader = getPluginLoader();
  const registry = getPluginRegistry();
  
  // 1. 注册所有内置插件工厂
  builtinPluginFactories.forEach(factory => {
    loader.registerBuiltin(factory);
  });
  
  log.info(`[Inject] Registered ${builtinPluginFactories.length} builtin plugins`);
  
  // 2. 初始化插件加载器（会自动加载匹配的插件）
  await loader.initialize();
  
  // 3. 获取当前活动的插件
  const activePlugin = loader.getActivePlugin();
  
  if (activePlugin) {
    log.info(`[Inject] Active plugin: ${activePlugin.manifest.name} (${activePlugin.manifest.id})`);
    log.info(`[Inject] Is reader page: ${loader.isReaderPage()}`);
  } else {
    log.warn('[Inject] No active plugin found for current page');
  }
  
  // 4. 输出统计信息
  const stats = registry.getStats();
  log.info(`[Inject] Plugin stats - Total: ${stats.total}, Loaded: ${stats.loaded}, Web: ${stats.web}`);
}

/**
 * 初始化管理器
 */
function initManagers(): void {
  const loader = getPluginLoader();
  const isReader = loader.isReaderPage();
  
  const safeInit = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      log.error(`[Inject] Failed to initialize ${name}`, e);
    }
  };
  
  // 按依赖顺序初始化管理器
  safeInit('IPCManager', () => new IPCManager());
  safeInit('MenuManager', () => new MenuManager());
  safeInit('AppManager', () => new AppManager());
  safeInit('TurnerManager', () => new TurnerManager());
  safeInit('RemoteManager', () => new RemoteManager());
  
  // ThemeManager 仅在非阅读器页面初始化
  if (!isReader) {
    safeInit('ThemeManager', () => new ThemeManager());
  }
  
  // StyleManager 始终初始化
  safeInit('StyleManager', () => new StyleManager());
}

/**
 * 暴露调试 API
 */
function exposeDebugAPI(): void {
  const loader = getPluginLoader();
  const registry = getPluginRegistry();
  
  // 暴露插件系统 API 供调试
  (window as any).pluginSystem = {
    loader,
    registry,
    getActivePlugin: () => loader.getActivePlugin(),
    getStats: () => registry.getStats(),
    getAllPlugins: () => registry.getAll(),
    reloadPlugin: (id: string) => loader.reloadPlugin(id),
  };
  
  // 兼容旧的测试 API
  const activePlugin = loader.getActivePlugin();
  if (activePlugin && activePlugin.manifest.id === 'weread') {
    (window as any).testWeReadAPI = () => {
      log.info('[Debug] WeRead plugin is active');
      return activePlugin;
    };
  }
  
  log.info('[Inject] Debug API exposed: window.pluginSystem');
}

/**
 * 主入口函数
 */
async function main(): Promise<void> {
  // 防止重复注入（兼容旧标志）
  if ((window as any).wxrd_injected || (window as any).atreader_injected) {
    return;
  }
  (window as any).wxrd_injected = true;
  (window as any).atreader_injected = true;
  
  log.info('[Inject] ==========================================');
  log.info('[Inject] AT Reader Plugin System v0.8.0');
  log.info(`[Inject] URL: ${window.location.href}`);
  log.info(`[Inject] Hostname: ${window.location.hostname}`);
  log.info(`[Inject] User Agent: ${navigator.userAgent}`);
  
  try {
    // 1. 初始化设置存储
    await settingsStore.init();
    log.info('[Inject] Settings store initialized');
    
    // 2. 初始化旧适配器系统（向后兼容，供管理器使用）
    initLegacyAdapters();
    
    // 3. 初始化插件系统
    await initPluginSystem();
    
    // 4. 初始化管理器
    initManagers();
    
    // 5. 暴露调试 API
    exposeDebugAPI();
    
    log.info('[Inject] Initialization complete!');
    log.info('[Inject] ==========================================');
    
  } catch (e) {
    console.error('[Inject] Critical error during initialization:', e);
    log.error('[Inject] Critical initialization error', e);
  }
}

// 执行主函数
main();
