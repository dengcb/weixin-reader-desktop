import { afterEach, describe, expect, it } from 'bun:test';
import type { PluginManifest } from '../../src/scripts/core/plugin_types';
import { DedaoPlugin } from './index';

const withManifestDomain = (plugin: DedaoPlugin, domain: string[]): void => {
  const site = plugin.manifest.site;
  const manifest: PluginManifest = {
    ...plugin.manifest,
    site: {
      domain,
      homeUrl: site?.homeUrl ?? 'https://www.dedao.cn/',
      readerPattern: site?.readerPattern ?? '/ebook/reader',
    },
  };
  Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });
};

describe('DedaoPlugin', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
  });

  it('清单契约：裸站——仅声明 nativeTheme，无任何功能能力', () => {
    const plugin = new DedaoPlugin();
    expect(plugin.manifest.id).toBe('dedao');
    expect(plugin.manifest.site?.domain).toEqual(['dedao.cn']);
    expect(plugin.manifest.site?.homeUrl).toBe('https://www.dedao.cn/');
    expect(plugin.manifest.site?.readerPattern).toBe('/ebook/reader');
    expect(plugin.manifest.capabilities.nativeTheme).toBe(true);
    expect(plugin.manifest.capabilities.autoFlip).toBeUndefined();
    expect(plugin.manifest.capabilities.hideToolbar).toBeUndefined();
    expect(plugin.manifest.capabilities.hideNavbar).toBeUndefined();
    expect(plugin.manifest.capabilities.chapterNav).toBeUndefined();
    expect(plugin.getReaderMenuItems()).toEqual([]);
    expect(plugin.getStyles()).toEqual({});
  });

  it('域名匹配遵循 DNS label 后缀且不误匹配父串', () => {
    history.replaceState({}, '', '/ebook/reader');
    const plugin = new DedaoPlugin();
    const host = window.location.hostname;

    withManifestDomain(plugin, [host]);
    expect(plugin.matchesDomain()).toBe(true);
    withManifestDomain(plugin, [`sub.${host}`]);
    expect(plugin.matchesDomain()).toBe(false);
    withManifestDomain(plugin, ['dedao.cn']);
    expect(plugin.matchesDomain()).toBe(false);
  });

  it('阅读页与首页判定', () => {
    const plugin = new DedaoPlugin();
    history.replaceState({}, '', '/ebook/reader');
    expect(plugin.isReaderPage()).toBe(true);
    expect(plugin.isHomePage()).toBe(false);
    history.replaceState({}, '', '/ebook/detail?id=x');
    expect(plugin.isReaderPage()).toBe(false);
    history.replaceState({}, '', '/');
    expect(plugin.isHomePage()).toBe(true);
    expect(plugin.isReaderPage()).toBe(false);
  });

  it('nextPage/prevPage 合成方向键并注入 keyCode（遥控翻页桥接）', () => {
    history.replaceState({}, '', '/ebook/reader');
    const seen: KeyboardEvent[] = [];
    document.addEventListener('keydown', (event) => { seen.push(event); });

    const plugin = new DedaoPlugin();
    plugin.nextPage();
    plugin.prevPage();

    expect(seen.length).toBe(2);
    expect(seen[0].key).toBe('ArrowRight');
    expect(seen[1].key).toBe('ArrowLeft');
    expect(seen[0].keyCode).toBe(39);
    expect(seen[1].keyCode).toBe(37);
  });
});
