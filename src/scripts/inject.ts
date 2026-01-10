import { getSiteRegistry } from './core/site_registry';
import { log } from './core/logger';
import { createAdapterInstances } from './adapters';
import { IPCManager } from './managers/ipc_manager';
import { AppManager } from './managers/app_manager';
import { TurnerManager } from './managers/turner_manager';
import { MenuManager } from './managers/menu_manager';
import { ThemeManager } from './managers/theme_manager';
import { StyleManager } from './managers/style_manager';
import { RemoteManager } from './managers/remote_manager';

// Main Entry Point
(function () {
  if ((window as any).wxrd_injected) {
    return;
  }
  (window as any).wxrd_injected = true;

  // ============================================
  // Step 1: Register Site Adapters (Auto-discovery)
  // ============================================
  try {
    const siteRegistry = getSiteRegistry();

    log.info(`[Inject] Starting injection on: ${window.location.href}`);
    log.info(`[Inject] Hostname: ${window.location.hostname}`);
    log.info(`[Inject] User Agent: ${navigator.userAgent}`);

    // 自动注册所有适配器
    const adapterInstances = (() => {
      try {
        return createAdapterInstances();
      } catch (e) {
        log.error('[Inject] Failed to create adapters', e);
        return [];
      }
    })();

    if (adapterInstances.length === 0) {
      log.error('[Inject] No adapters found! Auto-discovery failed.');
    } else {
      log.info(`[Inject] Found ${adapterInstances.length} adapters:`, adapterInstances.map(a => a.id).join(', '));

      adapterInstances.forEach(adapter => {
        siteRegistry.register(adapter);
        const isMatch = adapter.matchesCurrentDomain ? adapter.matchesCurrentDomain() : false;
        log.debug(`[Inject] Registered adapter: ${adapter.name} (${adapter.id}) - Match: ${isMatch}`);
      });
    }

    let currentAdapter = siteRegistry.getCurrentAdapter();

    // Debug info about location
    log.info(`[Inject] Location check - Href: ${window.location.href}, Hostname: ${window.location.hostname}`);

    // Fallback: If no adapter found, but we are running in the app, check for WeRead specifically
    if (!currentAdapter) {
      log.warn(`[Inject] No adapter matched hostname '${window.location.hostname}'`);

      // Try loose matching for WeRead
      if (window.location.hostname.includes('weread.qq.com') || window.location.href.includes('weread.qq.com')) {
         log.info('[Inject] Hostname contains weread.qq.com, forcing WeRead adapter');
         const weReadAdapter = adapterInstances.find(a => a.id === 'weread');
         if (weReadAdapter) {
           // Force this adapter
           weReadAdapter.matchesCurrentDomain = () => true;
           // Re-register to ensure the monkey-patch is effective if necessary,
           // though modifying the instance should be enough since it's passed by reference.
           currentAdapter = siteRegistry.getCurrentAdapter();
         }
      }
    }

    if (currentAdapter) {
      log.info(`[Inject] Detected site: ${currentAdapter.name} (isReader: ${siteRegistry.isReaderPage()})`);
    } else {
      log.error('[Inject] FATAL: No matching adapter found for current site. Feature injection will fail.');
    }

    const isReader = siteRegistry.isReaderPage();

    // ============================================
    // Step 2: Initialize Managers
    // ============================================
    // 简化初始化: 所有管理器按顺序初始化，各自处理时序问题

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

    // ============================================
    // Step 3: Expose Test APIs (开发测试用)
    // ============================================
    if (currentAdapter && currentAdapter.id === 'weread') {
      (window as any).testWeReadAPI = () => (currentAdapter as any).testBookInfo();
      log.info('[Inject] WeRead API 测试方法已暴露: window.testWeReadAPI()');
    }

  } catch (e) {
    console.error('[Inject] Critical error during initialization:', e);
    log.error('[Inject] Critical initialization error', e);
  }
})();
