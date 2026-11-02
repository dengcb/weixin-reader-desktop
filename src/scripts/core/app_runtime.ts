import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { builtinPluginFactories } from '../../plugins/builtin';
import { settleBootStyles } from '../core/boot_styles';
import { AppManager } from '../managers/app_manager';
import { BookstoreSwitcherManager } from '../managers/bookstore_switcher_manager';
import { IPCManager } from '../managers/ipc_manager';
import { LinkManager } from '../managers/link_manager';
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

    // 插件已接管样式注入，移除 documentStart 的首绘引导样式（内容相同，
    // 保留会在用户关闭开关后残留）。
    settleBootStyles();

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
    // 链接收敛是单窗口的全局策略，阅读页也要生效（七猫章节依赖 target 改写）。
    create('LinkManager', () => new LinkManager());
    create('TurnerManager', () => new TurnerManager());
    create('RemoteManager', () => new RemoteManager());
    // 书城切换浮层（macOS Cmd+Tab 语义）：远程站点页与本地阅读页共用
    create('BookstoreSwitcherManager', () => new BookstoreSwitcherManager());
    // 反色滤镜是给首页不支持深浅自适应的站点（微信读书、番茄小说）兜底的；
    // 站点在 manifest 声明 nativeTheme 时交给站点自身机制，不注入。
    const active = getPluginLoader().getActivePlugin();
    const nativeTheme = active?.manifest.capabilities.nativeTheme === true;
    if (!isReader && !nativeTheme) create('ThemeManager', () => new ThemeManager());
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
      // ThemeManager 监听的是 window 级 plugins-updated（设置/编辑器窗口经
      // Tauri emit 只能被 Tauri listen 收到），热重载路径需自行补发，否则
      // 反色滤镜残留到下一次路由变化（2026-11 审计 I-P1-1）。
      window.dispatchEvent(new Event('plugins-updated'));
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

  /*!
   * 慢加载取证（失败触发）：健康加载零输出；load 超过 3s 才落一行——远程
   * 对账「服务端慢 vs 客户端卡」的依据。被 tracker 拦截的资源失败不作为
   * 触发条件（带统计脚本的站点会页页误报），仅在命中时随行展示。
   */
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
          const loadMs = Math.round(nav?.loadEventEnd ?? 0);
          if (loadMs <= 3000) return;
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
            `load=${loadMs}ms ` +
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
    settleBootStyles();
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
