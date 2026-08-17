import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { builtinPluginFactories } from '../../plugins/builtin';
import { AppManager } from '../managers/app_manager';
import { IPCManager } from '../managers/ipc_manager';
import { MenuManager } from '../managers/menu_manager';
import { RemoteManager } from '../managers/remote_manager';
import { StyleManager } from '../managers/style_manager';
import { ThemeManager } from '../managers/theme_manager';
import { TurnerManager } from '../managers/turner_manager';
import { log } from './logger';
import { EventBus } from './event_bus';
import { getPluginLoader } from './plugin_loader';
import { getPluginRegistry } from './plugin_registry';
import { createSiteContext } from './site_context';
import { settingsStore } from './settings_store';
import { invoke, logToFile } from './tauri';

type Disposable = { destroy(): void };

/** 注入层唯一的生命周期所有者。 */
export class AppRuntime {
  private readonly disposables: Disposable[] = [];
  private pluginsUnlisten: UnlistenFn | null = null;
  private pagehideHandler: (() => void) | null = null;
  private performanceCleanup: (() => void) | null = null;
  private destroyed = false;
  private reloadQueue: Promise<void> = Promise.resolve();
  private reloadGeneration = 0;

  constructor(private readonly forcedPluginId?: string) {}

  async initialize(): Promise<void> {
    if (this.destroyed) return;
    this.pagehideHandler = () => this.destroy();
    window.addEventListener('pagehide', this.pagehideHandler, { once: true });

    await settingsStore.init();
    if (this.destroyed) return;

    const loader = getPluginLoader();
    for (const factory of builtinPluginFactories) loader.registerBuiltin(factory);
    await loader.initialize(this.forcedPluginId);
    if (this.destroyed) {
      loader.destroy();
      return;
    }

    const active = loader.getActivePlugin();
    if (active) {
      await invoke('apply_site_zoom', { siteId: active.id }).catch(() => undefined);
      if (this.destroyed) {
        loader.destroy();
        return;
      }
    }

    this.createManagers(loader.isReaderPage());
    this.exposeDebugAPI();
    const pluginsUnlisten = await listen('plugins-updated', () => this.schedulePluginReload());
    if (this.destroyed) {
      pluginsUnlisten();
      return;
    }
    this.pluginsUnlisten = pluginsUnlisten;
    this.performanceCleanup = this.reportLoadPerformance();
  }

  private createManagers(isReader: boolean): void {
    const create = (name: string, factory: () => Disposable): void => {
      try {
        this.disposables.push(factory());
      } catch (error) {
        log.error(`[AppRuntime] Failed to initialize ${name}`, error);
      }
    };

    create('IPCManager', () => new IPCManager());
    create('MenuManager', () => new MenuManager());
    create('AppManager', () => new AppManager());
    create('TurnerManager', () => new TurnerManager());
    create('RemoteManager', () => new RemoteManager());
    if (!isReader) create('ThemeManager', () => new ThemeManager());
    create('StyleManager', () => new StyleManager());
  }

  private schedulePluginReload(): void {
    const generation = this.reloadGeneration;
    this.reloadQueue = this.reloadQueue.then(async () => {
      if (this.destroyed || generation !== this.reloadGeneration) return;
      await settingsStore.refresh();
      if (this.destroyed || generation !== this.reloadGeneration) return;
      await getPluginLoader().hotReload();
      if (this.destroyed || generation !== this.reloadGeneration) {
        getPluginLoader().destroy();
        return;
      }
      createSiteContext().invalidate();
      log.info('[AppRuntime] Plugin system hot reloaded');
    }).catch((error) => {
      log.error('[AppRuntime] Plugin hot reload failed', error);
    });
  }

  private exposeDebugAPI(): void {
    const loader = getPluginLoader();
    const registry = getPluginRegistry();
    (window as any).pluginSystem = {
      loader,
      getActivePlugin: () => loader.getActivePlugin(),
      getStats: () => registry.getStats(),
      getAllPlugins: () => registry.getAll(),
      reloadPlugin: (id: string) => loader.reloadPlugin(id),
      installPlugin: (id: string) => loader.installPlugin(id),
      uninstallPlugin: (id: string) => loader.uninstallPlugin(id),
      isPluginInstalled: (id: string) => loader.isPluginInstalled(id),
      hotReload: () => loader.hotReload(),
    };
  }

  private reportLoadPerformance(): () => void {
    const failedResources: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onError = (event: Event) => {
      const target = event.target as (HTMLElement & { src?: string; href?: string }) | null;
      if (target && (target.src || target.href) && failedResources.length < 5) {
        failedResources.push(`${target.tagName}:${String(target.src || target.href).slice(0, 90)}`);
      }
    };

    const report = () => {
      timer = setTimeout(() => {
        timer = null;
        window.removeEventListener('error', onError, true);
        try {
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
          const slowest: Array<{ url: string; ms: number }> = [];
          for (const entry of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
            const candidate = { url: entry.name.slice(0, 90), ms: Math.round(entry.duration) };
            const index = slowest.findIndex(item => candidate.ms > item.ms);
            if (index === -1) slowest.push(candidate);
            else slowest.splice(index, 0, candidate);
            if (slowest.length > 5) slowest.pop();
          }
          const line = `[Perf] host=${location.hostname} ` +
            `docResponse=${Math.round(nav?.responseEnd ?? -1)}ms ` +
            `domInteractive=${Math.round(nav?.domInteractive ?? -1)}ms ` +
            `DCL=${Math.round(nav?.domContentLoadedEventEnd ?? -1)}ms ` +
            `load=${Math.round(nav?.loadEventEnd ?? -1)}ms ` +
            `failed=${JSON.stringify(failedResources)} slowest=${JSON.stringify(slowest)}`;
          log.info(line);
          logToFile(line);
        } catch (error) {
          log.warn('[Perf] Failed to collect performance data', error);
        }
      }, 1500);
    };

    window.addEventListener('error', onError, true);
    if (document.readyState === 'complete') report();
    else window.addEventListener('load', report, { once: true });

    return () => {
      window.removeEventListener('error', onError, true);
      window.removeEventListener('load', report);
      if (timer) clearTimeout(timer);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.reloadGeneration++;
    if (this.pagehideHandler) {
      window.removeEventListener('pagehide', this.pagehideHandler);
      this.pagehideHandler = null;
    }
    this.performanceCleanup?.();
    this.performanceCleanup = null;
    this.pluginsUnlisten?.();
    this.pluginsUnlisten = null;
    for (const disposable of this.disposables.reverse()) {
      try { disposable.destroy(); } catch (error) { log.error('[AppRuntime] Destroy failed', error); }
    }
    this.disposables.length = 0;
    getPluginLoader().destroy();
    createSiteContext().destroy();
    settingsStore.destroy();
    EventBus.clearHistory();
    delete (window as any).pluginSystem;
  }
}
