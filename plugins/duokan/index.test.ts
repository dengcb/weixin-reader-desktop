import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { PluginAPI, PluginManifest } from '../../src/scripts/core/plugin_types';
import { DuokanPlugin } from './index';

interface ApiStub {
  api: PluginAPI;
  storageMap: Map<string, unknown>;
  settingsMap: Map<string, unknown>;
}

const createApi = (): ApiStub => {
  const storageMap = new Map<string, unknown>();
  const settingsMap = new Map<string, unknown>();
  const api = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    style: {
      inject() {},
      remove() {},
      getFile: () => '',
    },
    storage: {
      get: async (key: string) => (storageMap.has(key) ? storageMap.get(key)! : null),
      set: async (key: string, value: unknown) => {
        storageMap.set(key, value);
      },
      remove: async (key: string) => {
        storageMap.delete(key);
      },
      keys: async () => [...storageMap.keys()],
    },
    settings: {
      get: (key: string, defaultValue?: unknown) =>
        settingsMap.has(key) ? settingsMap.get(key) : defaultValue,
      set: async (key: string, value: unknown) => {
        settingsMap.set(key, value);
      },
      getAll: () => Object.fromEntries(settingsMap),
      subscribe: () => () => {},
    },
    toast: { show() {} },
  } as unknown as PluginAPI;
  return { api, storageMap, settingsMap };
};

const withViewport = (width: number, height: number): void => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
};

const withManifestDomain = (plugin: DuokanPlugin, domain: string[]): void => {
  const site = plugin.manifest.site;
  const manifest: PluginManifest = {
    ...plugin.manifest,
    site: {
      domain,
      homeUrl: site?.homeUrl ?? 'https://www.duokan.com/pc/',
      readerPattern: site?.readerPattern ?? '/reader/www/app\\.html',
    },
  };
  Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });
};

describe('DuokanPlugin', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
    document.body.id = '';
    document.body.replaceChildren();
    withViewport(1280, 720);
    sessionStorage.clear();
  });

  it('清单契约：裸站 + 翻页桥接——仅声明 autoFlip', () => {
    const plugin = new DuokanPlugin();
    expect(plugin.manifest.id).toBe('duokan');
    expect(plugin.manifest.site?.domain).toEqual(['duokan.com']);
    expect(plugin.manifest.site?.homeUrl).toBe('https://www.duokan.com/pc/');
    expect(plugin.manifest.site?.readerPattern).toBe('/reader/www/app\\.html');
    expect(plugin.manifest.capabilities.autoFlip).toBe(true);
    expect(plugin.manifest.capabilities.nativeTheme).toBe(true);
    expect(plugin.manifest.capabilities.doubleColumn).toBeUndefined();
    expect(plugin.manifest.capabilities.hideToolbar).toBeUndefined();
    expect(plugin.manifest.capabilities.chapterNav).toBeUndefined();
    expect(plugin.manifest.capabilities.progressTracker).toBeUndefined();
    expect(plugin.getReaderMenuItems()).toEqual(['auto_flip']);
    expect(plugin.getStyles()).toEqual({});
  });

  it('域名匹配遵循 DNS label 后缀且不误匹配父串', () => {
    history.replaceState({}, '', '/reader/www/app.html?id=x');
    const plugin = new DuokanPlugin();
    const host = window.location.hostname;

    withManifestDomain(plugin, [host]);
    expect(plugin.matchesDomain()).toBe(true);
    withManifestDomain(plugin, [`sub.${host}`]);
    expect(plugin.matchesDomain()).toBe(false);
    withManifestDomain(plugin, ['duokan.com']);
    expect(plugin.matchesDomain()).toBe(false);
  });

  it('阅读页与首页判定（带书号 query 也算阅读页）', () => {
    const plugin = new DuokanPlugin();
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    expect(plugin.isReaderPage()).toBe(true);
    expect(plugin.isHomePage()).toBe(false);
    history.replaceState({}, '', '/pc/');
    expect(plugin.isReaderPage()).toBe(false);
    expect(plugin.isHomePage()).toBe(true);
  });

  it('双页对开默认：单页态点击一次阅读模式键；窗口外的单页视为用户选择不再干预', async () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    document.body.id = 'vertical_reader';
    const patternClick = mock(() => undefined);
    const pattern = document.createElement('span');
    pattern.className = 'j-pattern';
    pattern.addEventListener('click', patternClick);
    document.body.append(pattern);

    const { api } = createApi();
    const plugin = new DuokanPlugin();
    // 注意：本测试环境的 MutationObserver 只交付 observe 同一任务内的变异
    //（happy-dom 限制，真实 WebKit 无此问题），断言前不做跨 tick 等待。
    plugin.onLoad(api);
    // 与翻页无关的单页（8 秒窗口外）：用户手动选择，尊重不再干预
    document.body.id = 'vertical_reader';
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(patternClick).toHaveBeenCalledTimes(1);
    plugin.onUnload();
  });

  it('章节切换后的模式重置：翻页 8 秒窗口内自动修复（上限 5 次）', async () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    document.body.id = 'horizontal_reader';
    const patternClick = mock(() => undefined);
    const pattern = document.createElement('span');
    pattern.className = 'j-pattern';
    pattern.addEventListener('click', patternClick);
    document.body.append(pattern);

    const { api } = createApi();
    const plugin = new DuokanPlugin();
    // 观察器在 onLoad 内挂载，同一任务内的 id 变更在本环境也能交付
    plugin.onLoad(api);
    expect(patternClick).not.toHaveBeenCalled();

    // 翻页建立 8 秒重置窗口，随后站点把模式重置回单页 → 自动修复一次
    plugin.nextPage();
    document.body.id = 'vertical_reader';
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(patternClick).toHaveBeenCalledTimes(1);
    plugin.onUnload();
  });

  it('双页对开默认：已是 horizontal_reader 时不点击', () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    document.body.id = 'horizontal_reader';
    const patternClick = mock(() => undefined);
    const pattern = document.createElement('span');
    pattern.className = 'j-pattern';
    pattern.addEventListener('click', patternClick);
    document.body.append(pattern);

    const { api } = createApi();
    const plugin = new DuokanPlugin();
    plugin.onLoad(api);
    expect(patternClick).not.toHaveBeenCalled();
    plugin.onUnload();
  });

  it('翻页桥接：阅读页上派发合成 ←/→ 方向键，非阅读页不派发', () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    const seen: Array<Record<string, unknown>> = [];
    const listener = (event: KeyboardEvent) => {
      seen.push({ type: event.type, key: event.key, defaultPrevented: event.defaultPrevented });
    };
    document.addEventListener('keydown', listener);
    document.addEventListener('keyup', listener);

    const plugin = new DuokanPlugin();
    plugin.nextPage();
    plugin.prevPage();
    document.removeEventListener('keydown', listener);
    document.removeEventListener('keyup', listener);
    // 注意：KeyboardEventInit 不含 keyCode/which（真实浏览器忽略，事件
    // keyCode===0）——桥接契约只承诺 key/type，站点读 e.key（L-P1-3）。
    expect(seen).toEqual([
      { type: 'keydown', key: 'ArrowRight', defaultPrevented: false },
      { type: 'keyup', key: 'ArrowRight', defaultPrevented: false },
      { type: 'keydown', key: 'ArrowLeft', defaultPrevented: false },
      { type: 'keyup', key: 'ArrowLeft', defaultPrevented: false },
    ]);

    history.replaceState({}, '', '/pc/');
    seen.length = 0;
    plugin.nextPage();
    expect(seen).toEqual([]);
  });

  it('双页门槛补偿：纯函数档位计算（宽>1520 与矮窗≤888 天然双页，窄高窗越槛）', () => {
    // 1512×982 整窗（大屏单页档）→ 0.98 微缩越槛
    expect(DuokanPlugin.spreadZoomFor(1512, 982)).toBe(0.98);
    expect(DuokanPlugin.spreadZoomFor(1400, 900)).toBe(0.91);
    // 0.85 缩放下限：1293 尚可越槛，1292 恰好压线（1520.0 不大于 1520）
    expect(DuokanPlugin.spreadZoomFor(1300, 900)).toBe(0.85);
    expect(DuokanPlugin.spreadZoomFor(1293, 900)).toBe(0.85);
    expect(DuokanPlugin.spreadZoomFor(1292, 900)).toBeNull();
    // 宽窗天然双页、矮窗（≤888）站点小屏档天然双页、极窄窗放不下、非法输入
    expect(DuokanPlugin.spreadZoomFor(1600, 982)).toBeNull();
    expect(DuokanPlugin.spreadZoomFor(1200, 800)).toBeNull();
    expect(DuokanPlugin.spreadZoomFor(1512, 888)).toBeNull();
    expect(DuokanPlugin.spreadZoomFor(1000, 982)).toBeNull();
    expect(DuokanPlugin.spreadZoomFor(Number.NaN, 982)).toBeNull();
    expect(DuokanPlugin.spreadZoomFor(1400, 0)).toBeNull();
    // 每一档都必须真的越过站点门槛
    for (let width = 1293; width <= 1520; width++) {
      const zoom = DuokanPlugin.spreadZoomFor(width, 982);
      expect(zoom).not.toBeNull();
      expect(width / (zoom as number)).toBeGreaterThan(1520);
    }
  });

  it('双页门槛补偿：默认 zoom 自动档写入站点设置并记录档位', async () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    document.body.id = 'horizontal_reader';
    withViewport(1512, 982);
    const { api, storageMap, settingsMap } = createApi();
    const plugin = new DuokanPlugin();
    plugin.onLoad(api);
    await (plugin as unknown as { evaluateSpreadZoom(): Promise<void> }).evaluateSpreadZoom();

    expect(settingsMap.get('zoom')).toBe(0.98);
    expect(storageMap.get('spread-auto-zoom')).toBe(0.98);
    plugin.onUnload();
  });

  it('双页门槛补偿：矮窗（站点小屏档天然双页）不补偿', async () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    document.body.id = 'horizontal_reader';
    withViewport(1200, 800);
    const { api, storageMap, settingsMap } = createApi();
    const plugin = new DuokanPlugin();
    plugin.onLoad(api);
    await (plugin as unknown as { evaluateSpreadZoom(): Promise<void> }).evaluateSpreadZoom();

    expect(settingsMap.has('zoom')).toBe(false);
    expect(storageMap.has('spread-auto-zoom')).toBe(false);
    plugin.onUnload();
  });

  it('双页门槛补偿：用户手动档（zoom≠1.0 且无自动记录）绝不覆写', async () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    document.body.id = 'horizontal_reader';
    withViewport(1512, 982);
    const { api, storageMap, settingsMap } = createApi();
    settingsMap.set('zoom', 0.9);
    const plugin = new DuokanPlugin();
    plugin.onLoad(api);
    await (plugin as unknown as { evaluateSpreadZoom(): Promise<void> }).evaluateSpreadZoom();

    expect(settingsMap.get('zoom')).toBe(0.9);
    expect(storageMap.has('spread-auto-zoom')).toBe(false);
    plugin.onUnload();
  });

  it('双页门槛补偿：zoom 与自动档记录不一致 = 用户已接管，清除记录', async () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    document.body.id = 'horizontal_reader';
    withViewport(1512, 982);
    const { api, storageMap, settingsMap } = createApi();
    settingsMap.set('zoom', 0.75);
    storageMap.set('spread-auto-zoom', 0.98);
    const plugin = new DuokanPlugin();
    plugin.onLoad(api);
    await (plugin as unknown as { evaluateSpreadZoom(): Promise<void> }).evaluateSpreadZoom();

    expect(storageMap.has('spread-auto-zoom')).toBe(false);
    expect(settingsMap.get('zoom')).toBe(0.75);
    plugin.onUnload();
  });

  it('双页门槛补偿：自动档在位且物理窗口变宽 → 释放补偿回 1.0', async () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    document.body.id = 'horizontal_reader';
    // 0.98 生效下物理窗口 1600×982：CSS 视口 = 物理 / 0.98
    withViewport(1633, 1002);
    const { api, storageMap, settingsMap } = createApi();
    settingsMap.set('zoom', 0.98);
    storageMap.set('spread-auto-zoom', 0.98);
    const plugin = new DuokanPlugin();
    plugin.onLoad(api);
    await (plugin as unknown as { evaluateSpreadZoom(): Promise<void> }).evaluateSpreadZoom();

    expect(settingsMap.get('zoom')).toBe(1.0);
    expect(storageMap.has('spread-auto-zoom')).toBe(false);
    plugin.onUnload();
  });

  it('双页门槛补偿：自动档在位且视口未变 → 幂等不动作', async () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    document.body.id = 'horizontal_reader';
    withViewport(1542, 1002);
    const { api, storageMap, settingsMap } = createApi();
    settingsMap.set('zoom', 0.98);
    storageMap.set('spread-auto-zoom', 0.98);
    const plugin = new DuokanPlugin();
    plugin.onLoad(api);
    await (plugin as unknown as { evaluateSpreadZoom(): Promise<void> }).evaluateSpreadZoom();

    expect(settingsMap.get('zoom')).toBe(0.98);
    expect(storageMap.get('spread-auto-zoom')).toBe(0.98);
    plugin.onUnload();
  });
});
