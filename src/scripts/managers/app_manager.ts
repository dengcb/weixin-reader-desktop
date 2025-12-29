import { invoke, waitForTauri } from '../core/tauri';
import { settingsStore } from '../core/settings_store';

export class AppManager {
  private appName: string = "微信阅读";

  constructor() {
    this.init();
  }

  private async init() {
    await waitForTauri();

    try {
        this.appName = await invoke<string>('get_app_name') || "微信阅读";
    } catch (e) {
        console.error("Failed to get app name:", e);
    }

    // Initialize Settings Store (if not already)
    await settingsStore.init();
    
    // Subscribe to settings for "Restore Last Page" logic on startup?
    // Actually, restore logic usually happens once on startup.
    this.restoreLastPage();

    // Start Monitoring
    this.monitorRoute();
    this.monitorTitle();
  }

  private restoreLastPage() {
    const settings = settingsStore.get();
    const isReader = window.location.href.includes('/web/reader/');
    
    if (!isReader && settings.rememberLastPage && settings.lastReaderUrl) {
        console.log("Restoring last page:", settings.lastReaderUrl);
        window.location.href = settings.lastReaderUrl;
    }
  }

  private monitorRoute() {
    const checkRoute = () => {
        const isReader = window.location.href.includes('/web/reader/');
        
        // Update Title
        this.updateTitle();

        // Save Last Page Logic
        const settings = settingsStore.get();
        if (settings.rememberLastPage) {
            if (isReader) {
                const currentUrl = window.location.href;
                if (settings.lastReaderUrl !== currentUrl) {
                    settingsStore.update({ lastReaderUrl: currentUrl });
                }
            } else {
                if (settings.lastReaderUrl) {
                    settingsStore.update({ lastReaderUrl: null });
                }
            }
        } else {
            if (settings.lastReaderUrl) {
                 settingsStore.update({ lastReaderUrl: null });
            }
        }
        
        // Notify Store about route context if needed?
        // Actually, Menu Controller needs to know if we are in Reader to enable/disable menu items.
        // We can dispatch a global event or have MenuController listen to route changes too.
        // Or better: AppManager updates a "Context" in SettingsStore? No, settings are for persistence.
        // Let's dispatch a lightweight event for Route Change that MenuManager can listen to.
        window.dispatchEvent(new CustomEvent('wxrd:route-changed', { detail: { isReader } }));
    };

    window.addEventListener('popstate', checkRoute);
    
    const originalPushState = history.pushState;
    history.pushState = function(...args) {
        const result = originalPushState.apply(this, args);
        checkRoute();
        return result;
    };
    
    const originalReplaceState = history.replaceState;
    history.replaceState = function(...args) {
        const result = originalReplaceState.apply(this, args);
        checkRoute();
        return result;
    };

    // Initial check
    checkRoute();
  }

  private monitorTitle() {
    const target = document.querySelector('title');
    if (target) {
        const observer = new MutationObserver(() => {
            this.updateTitle();
        });
        observer.observe(target, { childList: true, characterData: true, subtree: true });
    }
  }

  private updateTitle() {
      const currentPath = window.location.pathname;
      if (currentPath === '/') {
          invoke('set_title', { title: this.appName });
      } else {
          if (document.title && document.title.trim() !== "") {
              invoke('set_title', { title: document.title });
          }
      }
  }
}
