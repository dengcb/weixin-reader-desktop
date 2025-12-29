import { MenuManager } from './managers/menu_manager';
import { ThemeManager } from './managers/theme_manager';
import { StyleManager } from './managers/style_manager';
import { TurnerManager } from './managers/turner_manager';
import { SettingManager } from './managers/setting_manager';
import { AppManager } from './managers/app_manager';

// Main Entry Point
(function () {
  if ((window as any).wxrd_injected) {
    console.log('Weixin Reader Inject Script already loaded. Skipping.');
    return;
  }
  (window as any).wxrd_injected = true;

  console.log('Weixin Reader Inject Script Initializing...');

  const isReader = window.location.href.includes('/web/reader/');

  // 0. App Manager (Route, Title, Restore Last Page)
  // Should be first to handle route/title monitoring and context
  new AppManager();

  // 1. Menu Manager (Menu Actions -> Settings Store)
  new MenuManager();

  // 2. Theme Manager (Dark Mode, Links, Zoom)
  if (!isReader) {
    new ThemeManager();
  }

  // 3. Style Manager (Wide Mode, Toolbar)
  new StyleManager();

  // 4. Turner Manager (Wheel Turn, Auto Flip)
  new TurnerManager();

  // 5. Setting Manager (Window Management)
  new SettingManager();

  console.log('Weixin Reader Inject Script Loaded (Modular v2)');
})();
