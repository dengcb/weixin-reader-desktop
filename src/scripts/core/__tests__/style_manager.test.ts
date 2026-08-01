import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { PluginRegistry } from '../plugin_registry';
import type { ReaderSiteRuntime } from '../reader_site_runtime';
import { settingsStore, type MergedSettings } from '../settings_store';
import { SiteContext } from '../site_context';
import { StyleManager } from '../../managers/style_manager';

const originals = {
  get: settingsStore.get,
  subscribe: settingsStore.subscribe,
  matchMedia: window.matchMedia,
};

const baseSettings = (partial: Partial<MergedSettings> = {}): MergedSettings => ({
  schemaVersion: 2,
  _version: 0,
  global: {},
  sites: {},
  pluginConfigs: {},
  readerWide: true,
  hideToolbar: true,
  hideNavbar: true,
  ...partial,
});

const createRuntime = (styleOwner: 'manager' | 'plugin' = 'manager') => {
  let doubleColumn = true;
  const runtime = {
    id: 'style-reader',
    name: 'Style Reader',
    styleOwner,
    manifest: {
      id: 'style-reader',
      name: 'Style Reader',
      version: '1.0.0',
      sourceType: 'web',
      renderMode: 'webview',
      capabilities: {},
      site: {
        domain: 'example.com',
        homeUrl: 'https://example.com/',
        readerPattern: '/reader/',
      },
    },
    onLoad: () => undefined,
    onUnload: () => undefined,
    matchesDomain: () => true,
    isReaderPage: () => true,
    isHomePage: () => false,
    nextPage: () => undefined,
    prevPage: () => undefined,
    getStyles: () => ({}),
    isDoubleColumn: () => doubleColumn,
    isAtBottom: () => false,
    getWideModeCSS: mock((enabled: boolean) => `.wide { value: ${enabled}; }`),
    getToolbarCSS: mock((hidden: boolean) => `.toolbar { value: ${hidden}; }`),
    getNavbarCSS: mock((hidden: boolean) => `.navbar { value: ${hidden}; }`),
    getDarkThemeCSS: mock(() => 'body { background: dark; }'),
    getLightThemeCSS: mock(() => 'body { background: light; }'),
  } as unknown as ReaderSiteRuntime;
  return { runtime, setDoubleColumn: (value: boolean) => { doubleColumn = value; } };
};

describe('StyleManager ownership and cleanup', () => {
  let manager: StyleManager | null = null;
  let settingsListener: ((settings: MergedSettings) => void) | null = null;
  let unsubscribeCalls = 0;

  beforeEach(() => {
    document.head.querySelectorAll('style[id^="wxrd-"]').forEach(node => node.remove());
    (PluginRegistry as any).instance = undefined;
    (SiteContext as any).instance = null;
    settingsStore.get = () => baseSettings();
    settingsStore.subscribe = (listener) => {
      settingsListener = listener;
      return () => { unsubscribeCalls++; };
    };
    settingsListener = null;
    unsubscribeCalls = 0;
    window.matchMedia = (() => ({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: mock(() => undefined),
      removeEventListener: mock(() => undefined),
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })) as typeof window.matchMedia;
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    settingsStore.get = originals.get;
    settingsStore.subscribe = originals.subscribe;
    window.matchMedia = originals.matchMedia;
    SiteContext.getInstance().destroy();
    PluginRegistry.getInstance().clear();
    document.head.querySelectorAll('style[id^="wxrd-"]').forEach(node => node.remove());
  });

  it('applies manager-owned site styles and clears them when leaving the reader', () => {
    const { runtime } = createRuntime('manager');
    const registry = PluginRegistry.getInstance();
    registry.register(runtime);
    registry.setActivePlugin(runtime.id);

    manager = new StyleManager();
    expect(document.getElementById('wxrd-wide-mode')?.textContent).toContain('true');
    expect(document.getElementById('wxrd-hide-toolbar')?.textContent).toContain('true');
    expect(document.getElementById('wxrd-hide-navbar')?.textContent).toContain('true');
    expect(document.getElementById('wxrd-base-bg')?.textContent).toContain('background: dark');

    settingsStore.get = () => baseSettings({ readerWide: false, hideToolbar: false });
    settingsListener?.(settingsStore.get());
    expect(runtime.getWideModeCSS).toHaveBeenLastCalledWith(false);
    expect(runtime.getToolbarCSS).toHaveBeenLastCalledWith(false);

    window.dispatchEvent(new CustomEvent('ipc:route-changed', {
      detail: { isReader: false, url: window.location.href, pathname: '/' },
    }));
    expect(document.getElementById('wxrd-wide-mode')).toBeNull();
    expect(document.getElementById('wxrd-hide-toolbar')).toBeNull();
    expect(document.getElementById('wxrd-hide-navbar')).toBeNull();
  });

  it('does not duplicate plugin-owned styles and drops navbar CSS outside double-column mode', () => {
    const pluginOwned = createRuntime('plugin');
    let registry = PluginRegistry.getInstance();
    registry.register(pluginOwned.runtime);
    registry.setActivePlugin(pluginOwned.runtime.id);
    manager = new StyleManager();
    expect(document.getElementById('wxrd-wide-mode')).toBeNull();
    expect(pluginOwned.runtime.getWideModeCSS).not.toHaveBeenCalled();
    manager.destroy();
    manager = null;
    SiteContext.getInstance().destroy();
    registry.clear();

    (PluginRegistry as any).instance = undefined;
    const managerOwned = createRuntime('manager');
    registry = PluginRegistry.getInstance();
    registry.register(managerOwned.runtime);
    registry.setActivePlugin(managerOwned.runtime.id);
    manager = new StyleManager();
    expect(document.getElementById('wxrd-hide-navbar')?.textContent).toContain('true');

    managerOwned.setDoubleColumn(false);
    SiteContext.getInstance().startObserving();
    expect(document.getElementById('wxrd-hide-navbar')?.textContent).toBe('');
  });

  it('removes media, settings and site subscriptions during destroy', () => {
    const { runtime } = createRuntime('manager');
    const registry = PluginRegistry.getInstance();
    registry.register(runtime);
    registry.setActivePlugin(runtime.id);
    manager = new StyleManager();
    const media = (manager as any).darkModeQuery;

    manager.destroy();
    manager = null;
    expect(unsubscribeCalls).toBe(1);
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);
    expect(document.getElementById('wxrd-base-bg')).toBeNull();
  });
});
