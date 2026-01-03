import { getSiteRegistry } from './core/site_registry';
import { log } from './core/logger';
import { createAdapterInstances } from './adapters';
import { IPCManager } from './managers/ipc_manager';
import { AppManager } from './managers/app_manager';
import { TurnerManager } from './managers/turner_manager';
import { MenuManager } from './managers/menu_manager';
import { ThemeManager } from './managers/theme_manager';
import { StyleManager } from './managers/style_manager';

// Main Entry Point
(function () {
  // CRITICAL: Raw log FIRST - before any other code
  console.log('[Inject] Script loaded. Timestamp:', new Date().toISOString());
  console.log('[Inject] Window Location:', window.location.href);

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
    try {
      const adapterInstances = createAdapterInstances();
      if (!adapterInstances || adapterInstances.length === 0) {
        log.error('[Inject] No adapters found! Auto-discovery failed.');
      } else {
        log.info(`[Inject] Found ${adapterInstances.length} adapters:`, adapterInstances.map(a => a.id).join(', '));

        adapterInstances.forEach(adapter => {
          siteRegistry.register(adapter);
          const isMatch = adapter.matchesCurrentDomain ? adapter.matchesCurrentDomain() : false;
          log.debug(`[Inject] Registered adapter: ${adapter.name} (${adapter.id}) - Match: ${isMatch}`);
        });
      }
    } catch (e) {
      log.error('[Inject] Failed to register adapters', e);
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
    // All managers initialize independently and handle their own timing

    const safeInit = (name: string, fn: () => void) => {
      try {
        log.info(`[Inject] Initializing ${name}...`);
        fn();
        log.info(`[Inject] Initialized ${name}`);
      } catch (e) {
        log.error(`[Inject] Failed to initialize ${name}`, e);
      }
    };

    // 0. IPC Manager (Central Event Bus - Route & Title Monitoring)
    safeInit('IPCManager', () => new IPCManager());

    // 1. Menu Manager (Menu State Sync) - Highest priority
    safeInit('MenuManager', () => new MenuManager());

    // 2. All other managers - Initialize in sequence
    safeInit('AppManager', () => new AppManager());
    safeInit('TurnerManager', () => new TurnerManager());

    // Theme Manager (Dark Mode, Links, Zoom)
    // Always initialize managers, let them handle internal checks if possible,
    // OR keep the conditional logic but log it.
    if (!isReader) {
      safeInit('ThemeManager', () => new ThemeManager());
    } else {
      log.debug('[Inject] Skipping ThemeManager (Reader mode active)');
    }

    // Style Manager (Wide Mode, Hide Toolbar)
    // Always initialize StyleManager, it handles its own isReader check
    safeInit('StyleManager', () => new StyleManager());


    // Check SettingsStore status
    setTimeout(async () => {
      try {
        const { settingsStore } = await import('./core/settings_store');
        const settings = settingsStore.get();
        log.info('[Inject] Post-init settings check:', JSON.stringify(settings));
        log.info('[Inject] Current adapter:', siteRegistry.getCurrentAdapter()?.id);
        log.info('[Inject] Is Reader Page:', siteRegistry.isReaderPage());
      } catch (e) {
        log.error('[Inject] Failed to perform post-init check', e);
      }
    }, 2000);

  } catch (e) {
    console.error('[Inject] Critical error during initialization:', e);
    log.error('[Inject] Critical initialization error', e);
  }
})();
