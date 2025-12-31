import { getSiteRegistry } from './core/site_registry';
import { WeReadAdapter } from './adapters/weread_adapter';
import { IPCManager } from './managers/ipc_manager';
import { AppManager } from './managers/app_manager';
import { TurnerManager } from './managers/turner_manager';
import { MenuManager } from './managers/menu_manager';
import { ThemeManager } from './managers/theme_manager';
import { StyleManager } from './managers/style_manager';
import { SettingManager } from './managers/setting_manager';

// Main Entry Point
(function () {
  if ((window as any).wxrd_injected) {
    console.log('Weixin Reader Inject Script already loaded. Skipping.');
    return;
  }
  (window as any).wxrd_injected = true;

  console.log('Weixin Reader Inject Script Initializing...');

  // ============================================
  // Step 1: Register Site Adapters
  // ============================================
  const siteRegistry = getSiteRegistry();

  // Register WeRead (微信读书)
  siteRegistry.register(new WeReadAdapter());

  const currentAdapter = siteRegistry.getCurrentAdapter();
  if (currentAdapter) {
    console.log(`[Inject] Detected site: ${currentAdapter.name}`);
  } else {
    console.warn('[Inject] No matching adapter found for current site');
  }

  const isReader = siteRegistry.isReaderPage();

  // ============================================
  // Step 2: Initialize Managers
  // ============================================
  // All managers initialize independently and handle their own timing

  // 0. IPC Manager (Central Event Bus - Route & Title Monitoring)
  new IPCManager();

  // 1. Menu Manager (Menu State Sync) - Highest priority
  new MenuManager();

  // 2. All other managers - Initialize in sequence
  new AppManager();
  new TurnerManager();

  // Theme Manager (Dark Mode, Links, Zoom) - Only on non-reader pages
  if (!isReader) {
    new ThemeManager();
  }

  // Style Manager (Wide Mode, Hide Toolbar)
  new StyleManager();

  // Setting Manager (Settings Window)
  new SettingManager();

  console.log('Weixin Reader Inject Script Loaded (Modular v4 - IPCManager Architecture)');
})();
