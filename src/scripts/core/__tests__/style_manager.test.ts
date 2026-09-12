import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { PluginRegistry } from '../plugin_registry';
import { DEFAULT_WIDE_WIDTH_PERCENT } from '../reader_width';
import type { ReaderSiteRuntime } from '../reader_site_runtime';
import { settingsStore, type MergedSettings } from '../settings_store';
import { SiteContext } from '../site_context';
import { log } from '../logger';
import { StyleManager } from '../../managers/style_manager';

const originals = {
  get: settingsStore.get,
  subscribe: settingsStore.subscribe,
  matchMedia: window.matchMedia,
  tauri: (window as any).__TAURI__,
  tauriInternals: (window as any).__TAURI_INTERNALS__,
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

const createRuntime = (
  styleOwner: 'manager' | 'plugin' = 'manager',
  id = 'style-reader',
) => {
  let doubleColumn = true;
  const runtime = {
    id,
    name: 'Style Reader',
    styleOwner,
    manifest: {
      id,
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
  let themeInvoke = mock(async () => undefined);

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
    document.body.classList.remove('wr_whiteTheme');
    themeInvoke = mock(async () => undefined);
    (window as any).__TAURI__ = {
      __currentWindow: { label: 'main' },
      core: { invoke: themeInvoke },
      event: { listen: async () => () => undefined },
    };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      invoke: themeInvoke,
    };
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
    (window as any).__TAURI__ = originals.tauri;
    (window as any).__TAURI_INTERNALS__ = originals.tauriInternals;
    document.body.classList.remove('wr_whiteTheme');
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
    // 阅读页深浅完全由微信读书内切换按钮决定，系统主题不注入 base-bg（issue #18）
    expect(document.getElementById('wxrd-base-bg')).toBeNull();

    settingsStore.get = () => baseSettings({ readerWide: false, hideToolbar: false });
    settingsListener?.(settingsStore.get());
    expect(runtime.getWideModeCSS).toHaveBeenLastCalledWith(false, DEFAULT_WIDE_WIDTH_PERCENT);
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

  it('reapplies manager styles when the wide width changes', () => {
    const { runtime } = createRuntime('manager');
    const registry = PluginRegistry.getInstance();
    registry.register(runtime);
    registry.setActivePlugin(runtime.id);
    manager = new StyleManager();

    settingsStore.get = () => baseSettings({ wideWidthPercent: 94 });
    settingsListener?.(settingsStore.get());

    expect(runtime.getWideModeCSS).toHaveBeenLastCalledWith(true, 94);
  });

  it('follows the WeRead page theme and restores the system theme on destroy', async () => {
    const { runtime } = createRuntime('manager', 'weread');
    const registry = PluginRegistry.getInstance();
    registry.register(runtime);
    registry.setActivePlugin(runtime.id);

    manager = new StyleManager();
    expect(themeInvoke).toHaveBeenCalledWith(
      'plugin:window|set_theme',
      { label: 'main', value: 'dark' },
      undefined,
    );

    document.body.classList.add('wr_whiteTheme');
    await Bun.sleep(0);
    expect(themeInvoke).toHaveBeenLastCalledWith(
      'plugin:window|set_theme',
      { label: 'main', value: 'light' },
      undefined,
    );

    manager.destroy();
    manager = null;
    expect(themeInvoke).toHaveBeenLastCalledWith(
      'plugin:window|set_theme',
      { label: 'main', value: null },
      undefined,
    );
  });

  it('leaving the reader page restores the system theme follow (issue #18)', async () => {
    const { runtime } = createRuntime('manager', 'weread');
    const registry = PluginRegistry.getInstance();
    registry.register(runtime);
    registry.setActivePlugin(runtime.id);

    manager = new StyleManager();
    // 阅读页深色主题：body 无 wr_whiteTheme → 跟随为 dark
    expect(themeInvoke).toHaveBeenLastCalledWith(
      'plugin:window|set_theme',
      { label: 'main', value: 'dark' },
      undefined,
    );

    // 回到主页：runtime 判非阅读页 → 交还系统跟随（setTheme(null)），
    // 而不是把窗口钉死在 dark（回归：主页无 wr_whiteTheme 被误判）。
    // 主页真实类名是 wr_theme_light（添加它同时触发 body 类变更）
    runtime.isReaderPage = () => false;
    document.body.classList.add('wr_theme_light');
    await Bun.sleep(0);
    expect(themeInvoke).toHaveBeenLastCalledWith(
      'plugin:window|set_theme',
      { label: 'main', value: null },
      undefined,
    );

    manager.destroy();
    manager = null;
  });

  it('does not synchronize the native window theme from an iframe', () => {
    const topDescriptor = Object.getOwnPropertyDescriptor(window, 'top')!;
    Object.defineProperty(window, 'top', { value: {}, configurable: true });
    try {
      const { runtime } = createRuntime('manager', 'weread');
      const registry = PluginRegistry.getInstance();
      registry.register(runtime);
      registry.setActivePlugin(runtime.id);
      manager = new StyleManager();
      manager.destroy();
      manager = null;
      expect(themeInvoke).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'top', topDescriptor);
    }
  });

  it('logs native theme synchronization failures at debug level', async () => {
    const error = new Error('theme rejected');
    themeInvoke = mock(async () => { throw error; });
    (window as any).__TAURI_INTERNALS__.invoke = themeInvoke;
    const debug = spyOn(log, 'debug').mockImplementation(() => undefined);
    const { runtime } = createRuntime('manager', 'weread');
    const registry = PluginRegistry.getInstance();
    registry.register(runtime);
    registry.setActivePlugin(runtime.id);

    manager = new StyleManager();
    await Bun.sleep(0);
    expect(debug).toHaveBeenCalledWith(
      '[StyleManager] Failed to sync native window theme',
      error,
    );
    manager.destroy();
    manager = null;
    await Bun.sleep(0);
    debug.mockRestore();
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
