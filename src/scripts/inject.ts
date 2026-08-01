/**
 * 艾特阅读 - 插件系统入口
 * AT Reader - Plugin System Entry
 * 
 * 基于插件化架构，支持多阅读网站适配
 * 微信读书作为默认内置插件
 */

import { log } from './core/logger';
import { logToFile, invoke } from './core/tauri';
import { settingsStore } from './core/settings_store';
import { getPluginLoader } from './core/plugin_loader';
import { getPluginRegistry } from './core/plugin_registry';
import { builtinPluginFactories } from '../plugins/builtin';
import { listen } from '@tauri-apps/api/event';

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
    // 插件安装/卸载 API
    installPlugin: (id: string) => loader.installPlugin(id),
    uninstallPlugin: (id: string) => loader.uninstallPlugin(id),
    isPluginInstalled: (id: string) => loader.isPluginInstalled(id),
    // 热重载 API
    hotReload: () => loader.hotReload(),
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
 * 设置热重载监听器
 * 监听 plugins-updated 事件，自动刷新设置并重新加载插件系统
 */
async function setupHotReloadListener(): Promise<void> {
  const loader = getPluginLoader();
  
  await listen('plugins-updated', async () => {
    log.info('[Inject] Received plugins-updated event, hot reloading...');
    
    try {
      // 1. 刷新设置（从后端重新加载）
      await settingsStore.refresh();
      log.info('[Inject] Settings refreshed');
      
      // 2. 热重载插件系统
      await loader.hotReload();
      log.info('[Inject] Plugin system hot reloaded successfully');
      
    } catch (e) {
      log.error('[Inject] Hot reload failed', e);
    }
  });
  
  log.info('[Inject] Hot reload listener registered');
}

/**
 * 性能诊断：页面加载完成后，把导航耗时与最慢的 5 个资源写入日志文件
 * 用于排查站点加载缓慢（如切换书店耗时过长）的真实原因
 */
function reportLoadPerformance(): void {
  // 捕获加载失败的资源（失败请求不会进 resource timing，只能靠 error 事件拓名）
  const failedResources: string[] = [];
  window.addEventListener('error', (e) => {
    const t = e.target as any;
    if (t && t !== window && (t.src || t.href)) {
      failedResources.push(`${t.tagName}:${String(t.src || t.href).slice(0, 90)}`);
    }
  }, true);

  const report = () => {
    // 稍等片刻，让 load 后的资源计时尽量完整
    setTimeout(() => {
      try {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        const slowest = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
          .map(r => ({ url: r.name.slice(0, 90), ms: Math.round(r.duration) }))
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 5);
        const line =
          `[Perf] host=${location.hostname} ` +
          `docResponse=${Math.round(nav?.responseEnd ?? -1)}ms ` +
          `domInteractive=${Math.round(nav?.domInteractive ?? -1)}ms ` +
          `DCL=${Math.round(nav?.domContentLoadedEventEnd ?? -1)}ms ` +
          `load=${Math.round(nav?.loadEventEnd ?? -1)}ms ` +
          `failed=${JSON.stringify(failedResources.slice(0, 5))} ` +
          `slowest=${JSON.stringify(slowest)}`;
        log.info(line);
        logToFile(line);
      } catch (e) {
        log.warn('[Perf] Failed to collect performance data', e);
      }
    }, 1500);
  };
  if (document.readyState === 'complete') {
    report();
  } else {
    window.addEventListener('load', report, { once: true });
  }
}

/**
 * 主入口函数
 */
async function main(): Promise<void> {
  // 跨域 iframe 守卫：绝不在第三方跨域 iframe 中注入。
  //   典型场景：微信扫码登录框 open.weixin.qq.com（嵌在 weread 页面里的跨域 iframe）。
  //   Windows/WebView2 会把初始化脚本注入到所有子框架，我们的脚本一旦在该登录 iframe 内
  //   执行就会干扰微信自身逻辑，导致二维码空白（Mac/WKWebView 默认只注主框架，故无此问题）。
  //   合规上我们也不应在他人的 OAuth 登录框里运行任何脚本。同源 iframe 不受影响。
  if (window.self !== window.top) {
    try {
      // 跨域时访问 top.location.href 会抛 SecurityError
      void (window.top as Window).location.href;
    } catch {
      return;
    }
  }

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

    // 4. 通知 Rust 端按当前站点应用缩放（事件驱动，非延迟）
    const activePlugin = getPluginLoader().getActivePlugin();
    if (activePlugin?.manifest.id) {
      invoke('apply_site_zoom', { siteId: activePlugin.manifest.id }).catch(() => {});
    }

    // 5. 初始化管理器
    initManagers();

    // 6. 暴露调试 API
    exposeDebugAPI();

    // 7. 设置热重载监听器（插件安装/卸载后自动刷新）
    await setupHotReloadListener();

    // 7. 性能诊断：记录页面加载耗时与最慢资源（落盘到日志）
    reportLoadPerformance();
    
    log.info('[Inject] Initialization complete!');
    log.info('[Inject] ==========================================');
    
  } catch (e) {
    console.error('[Inject] Critical error during initialization:', e);
    log.error('[Inject] Critical initialization error', e);
  }
}

// 执行主函数
main();
