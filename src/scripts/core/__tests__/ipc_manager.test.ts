import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventBus, Events } from '../event_bus';
import { PluginRegistry } from '../plugin_registry';
import { settingsStore } from '../settings_store';
import { SiteContext } from '../site_context';
import type { PluginManifest, ReaderPlugin } from '../plugin_types';
import { IPCManager } from '../../managers/ipc_manager';

const manifest: PluginManifest = {
  id: 'initial-reader',
  name: 'Initial Reader',
  version: '1.0.0',
  sourceType: 'web',
  renderMode: 'webview',
  capabilities: {},
  site: {
    domain: 'example.com',
    homeUrl: 'https://example.com/',
    readerPattern: '/reader/',
  },
};

let readerPage = true;

const plugin: ReaderPlugin = {
  manifest,
  onLoad: () => undefined,
  onUnload: () => undefined,
  matchesDomain: () => true,
  isReaderPage: () => readerPage,
  isHomePage: () => !readerPage,
  nextPage: () => undefined,
  prevPage: () => undefined,
  getStyles: () => ({}),
};

describe('IPCManager initial route', () => {
  let manager: IPCManager | null = null;
  const originals = {
    init: settingsStore.init,
    get: settingsStore.get,
    updateGlobal: settingsStore.updateGlobal,
    updateSite: settingsStore.updateSite,
    tauri: window.__TAURI__,
  };
  let invokeMock: ReturnType<typeof mock>;

  beforeEach(() => {
    (PluginRegistry as any).instance = undefined;
    (SiteContext as any).instance = null;
    readerPage = true;
    EventBus.clearHistory();
    const registry = PluginRegistry.getInstance();
    registry.register(plugin);
    registry.setActivePlugin(plugin.manifest.id);
    settingsStore.init = async () => undefined;
    settingsStore.get = () => ({
      schemaVersion: 2,
      _version: 0,
      global: { lastPage: true, lastSiteId: plugin.manifest.id },
      sites: {},
      pluginConfigs: {},
      lastPage: true,
      lastSiteId: plugin.manifest.id,
    });
    settingsStore.updateGlobal = mock(async () => undefined);
    settingsStore.updateSite = mock(async () => undefined);
    invokeMock = mock(async () => undefined);
    window.__TAURI__ = {
      core: { invoke: invokeMock },
      event: { listen: async () => () => undefined },
    } as any;
    delete (window as any).__wxrd_scroll_restored;
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    settingsStore.init = originals.init;
    settingsStore.get = originals.get;
    settingsStore.updateGlobal = originals.updateGlobal;
    settingsStore.updateSite = originals.updateSite;
    window.__TAURI__ = originals.tauri;
    SiteContext.getInstance().destroy();
    PluginRegistry.getInstance().clear();
    EventBus.clearHistory();
    delete (window as any).__wxrd_scroll_restored;
  });

  it('publishes a historical reader route when the first page is already a reader', async () => {
    manager = new IPCManager();
    await new Promise(resolve => setTimeout(resolve, 0));
    const initial = EventBus.getLatestEvent<{ isReader: boolean; url: string }>(
      Events.ROUTE_CHANGED,
    );
    expect(initial?.isReader).toBe(true);
    expect(initial?.url).toBe(window.location.href);
  });

  it('publishes route transitions, controls the observer, and restores History hooks', async () => {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const context = SiteContext.getInstance();
    const start = mock(context.startObserving.bind(context));
    const stop = mock(context.stopObserving.bind(context));
    context.startObserving = start;
    context.stopObserving = stop;
    const routes: boolean[] = [];
    const onRoute = (event: Event) => routes.push((event as CustomEvent).detail.isReader);
    window.addEventListener('ipc:route-changed', onRoute);

    manager = new IPCManager();
    await Bun.sleep(0);
    expect(history.pushState).not.toBe(originalPushState);
    expect(history.replaceState).not.toBe(originalReplaceState);
    expect(routes).toEqual([true]);
    expect(start).toHaveBeenCalled();

    readerPage = false;
    history.pushState({}, '', '/home');
    expect(routes).toEqual([true, false]);
    expect(stop).toHaveBeenCalled();

    manager.destroy();
    manager = null;
    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);
    window.removeEventListener('ipc:route-changed', onRoute);
  });

  it('saves a debounced single-column scroll only after restoration completes', async () => {
    manager = new IPCManager();
    await Bun.sleep(0);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 120 });

    window.dispatchEvent(new Event('scroll'));
    await Bun.sleep(520);
    expect(invokeMock).not.toHaveBeenCalledWith('save_reading_position', expect.anything());

    (window as any).__wxrd_scroll_restored = true;
    window.dispatchEvent(new Event('scroll'));
    await Bun.sleep(520);
    expect(invokeMock).toHaveBeenCalledWith('save_reading_position', {
      siteId: plugin.manifest.id,
      url: window.location.href,
      position: 120,
    });
  });

  it('cancels a pending scroll write during destruction', async () => {
    manager = new IPCManager();
    await Bun.sleep(0);
    (window as any).__wxrd_scroll_restored = true;
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 200 });
    window.dispatchEvent(new Event('scroll'));
    manager.destroy();
    manager = null;

    await Bun.sleep(520);
    expect(invokeMock).not.toHaveBeenCalledWith('save_reading_position', expect.anything());
  });
});
