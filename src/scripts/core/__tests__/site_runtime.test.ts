import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { PluginRegistry } from '../plugin_registry';
import {
  createPluginSiteRuntime,
  createWeReadSiteRuntime,
  isReaderSiteRuntime,
} from '../reader_site_runtime';
import { createSiteContext, SiteContext } from '../site_context';
import type { PluginAPI, PluginManifest, ReaderPlugin } from '../plugin_types';

const manifest: PluginManifest = {
  id: 'external-reader',
  name: 'External Reader',
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

const externalPlugin = (): ReaderPlugin => ({
  manifest,
  onLoad: () => undefined,
  onUnload: () => undefined,
  matchesDomain: () => true,
  isReaderPage: () => true,
  isHomePage: () => false,
  nextPage: () => undefined,
  prevPage: () => undefined,
  getStyles: () => ({
    wideMode: { enabled: '.wide{}', disabled: '.narrow{}' },
  }),
  isDoubleColumn: () => false,
});

describe('ReaderSiteRuntime and SiteContext', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    (PluginRegistry as any).instance = undefined;
    (SiteContext as any).instance = null;
    registry = PluginRegistry.getInstance();
  });

  afterEach(() => {
    createSiteContext().destroy();
    registry.clear();
  });

  it('routes WeRead and external plugins through the same context interface', () => {
    const weread = createWeReadSiteRuntime();
    const external = createPluginSiteRuntime(externalPlugin());
    // Happy DOM 的测试地址是 example.com；本用例只验证两类实现都经由
    // SiteContext 暴露统一接口，域名匹配另由注册表用例覆盖。
    weread.matchesDomain = () => true;
    registry.register(weread);
    registry.register(external);

    registry.setActivePlugin('weread');
    expect(createSiteContext().currentRuntime).toBe(weread);
    expect(createSiteContext().currentRuntime?.styleOwner).toBe('manager');

    registry.setActivePlugin('external-reader');
    expect(createSiteContext().currentRuntime).toBe(external);
    expect(createSiteContext().currentRuntime?.styleOwner).toBe('plugin');
    expect(createSiteContext().currentRuntime?.getWideModeCSS(true)).toBe('.wide{}');
    weread.onUnload();
  });

  it('does not construct the WeRead adapter while another domain is active', () => {
    const weread = createWeReadSiteRuntime();
    expect((weread as any).adapter).toBeNull();
    expect(weread.matchesDomain()).toBe(false);
    expect((weread as any).adapter).toBeNull();
    weread.onUnload();
  });

  it('delegates external plugin lifecycle, navigation, styles and chapter capabilities', async () => {
    const calls: string[] = [];
    const plugin: ReaderPlugin = {
      ...externalPlugin(),
      onLoad: () => { calls.push('load'); },
      onUnload: () => { calls.push('unload'); },
      nextPage: () => { calls.push('next'); },
      prevPage: () => { calls.push('prev'); },
      getStyles: () => ({
        wideMode: { enabled: 'wide-on', disabled: 'wide-off' },
        toolbar: { enabled: 'toolbar-off', disabled: 'toolbar-on' },
        navbar: { enabled: 'navbar-off', disabled: 'navbar-on' },
        theme: { dark: 'theme-dark', light: 'theme-light' },
      }),
      isDoubleColumn: () => true,
      isAtBottom: () => true,
      getChapterProgress: () => 42,
      getBookProgress: async () => ({ progress: 35 }),
      getChapters: async () => [{ id: 'chapter-7', index: 7, title: '第七章' }],
      getChapterUrl: chapterIdx => `/chapter/${chapterIdx}`,
      getReaderMenuItems: () => ['custom-action'],
    };
    const runtime = createPluginSiteRuntime(plugin);

    runtime.onLoad({} as PluginAPI);
    runtime.nextPage();
    runtime.prevPage();
    expect(runtime.getWideModeCSS(true)).toBe('wide-on');
    expect(runtime.getWideModeCSS(false)).toBe('wide-off');
    expect(runtime.getToolbarCSS(true)).toBe('toolbar-off');
    expect(runtime.getNavbarCSS?.(false)).toBe('navbar-on');
    expect(runtime.getDarkThemeCSS?.()).toBe('theme-dark');
    expect(runtime.getLightThemeCSS?.()).toBe('theme-light');
    expect(runtime.isDoubleColumn?.()).toBe(true);
    expect(runtime.isAtBottom?.()).toBe(true);
    expect(runtime.getChapterProgress?.()).toBe(42);
    expect(await runtime.getBookProgress?.()).toEqual({ progress: 35 });
    expect(await runtime.getChapters?.()).toEqual([{ id: 'chapter-7', index: 7, title: '第七章' }]);
    expect(runtime.getChapterUrl?.(7)).toBe('/chapter/7');
    expect(runtime.getReaderMenuItems?.()).toEqual(['custom-action']);
    runtime.onUnload();
    expect(calls).toEqual(['load', 'next', 'prev', 'unload']);
  });

  it('provides stable defaults when optional external capabilities are absent', async () => {
    const runtime = createPluginSiteRuntime(externalPlugin());

    expect(runtime.getToolbarCSS(true)).toBe('');
    expect(runtime.getNavbarCSS?.(true)).toBe('');
    expect(runtime.getDarkThemeCSS?.()).toBe('');
    expect(runtime.getLightThemeCSS?.()).toBe('');
    expect(runtime.isAtBottom?.()).toBe(false);
    expect(runtime.getChapterProgress?.()).toBe(0);
    expect(await runtime.getBookProgress?.()).toBeNull();
    expect(await runtime.getChapters?.()).toEqual([]);
    expect(runtime.getChapterUrl?.(1)).toBeNull();
    expect(runtime.getReaderMenuItems?.()).toEqual(['reader_wide', 'hide_toolbar', 'auto_flip']);
    expect(isReaderSiteRuntime(runtime)).toBe(true);
    expect(isReaderSiteRuntime(externalPlugin())).toBe(false);
  });

  it('uses the installed manifest as the runtime and plugin capability authority', () => {
    const plugin = externalPlugin();
    const installedManifest: PluginManifest = {
      ...manifest,
      version: '2.0.0',
      capabilities: { doubleColumn: true, wideMode: false },
    };
    const runtime = createPluginSiteRuntime(plugin, installedManifest);

    expect(runtime.manifest).toBe(installedManifest);
    expect(plugin.manifest).toBe(installedManifest);
    expect(runtime.manifest.version).toBe('2.0.0');
    expect(runtime.manifest.capabilities.doubleColumn).toBe(true);
  });

  it('reuses one MutationObserver across repeated stop and restart cycles', () => {
    const NativeObserver = globalThis.MutationObserver;
    let instances = 0;
    let observeCalls = 0;
    let disconnectCalls = 0;
    class ObserverStub {
      constructor(_callback: MutationCallback) { instances++; }
      observe() { observeCalls++; }
      disconnect() { disconnectCalls++; }
      takeRecords(): MutationRecord[] { return []; }
    }
    globalThis.MutationObserver = ObserverStub as unknown as typeof MutationObserver;
    try {
      registry.register(externalPlugin());
      registry.setActivePlugin('external-reader');
      const context = createSiteContext();
      context.startObserving();
      context.startObserving();
      context.stopObserving();
      context.startObserving();
      expect(instances).toBe(1);
      expect(observeCalls).toBe(2);
      expect(disconnectCalls).toBe(1);
    } finally {
      globalThis.MutationObserver = NativeObserver;
    }
  });
});
