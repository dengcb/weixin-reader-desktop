import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { PluginAPI, PluginManifest } from '../../src/scripts/core/plugin_types';
import { buildPinCookieString, IreaderPlugin, nextSiteBack } from './index';

const createApi = (settings: Record<string, unknown> = {}) => {
  const styleFiles: Record<string, string> = {
    'reader.css': 'body.atreader-ireader-paged { overflow: hidden !important; }',
    'wide.css': 'body.atreader-ireader-paged { --atreader-page-ratio: 90%; }',
    'dark.css': 'body.atreader-ireader-dark { background-color: #1b1d1f !important; }',
    'toolbar.css': '.atreader-ireader-toolbar { position: fixed; }',
    'progress.css': '.atreader-ireader-page-indicator { position: fixed; }',
  };
  const storage = new Map<string, unknown>();
  const injectedCss = new Map<string, string>();
  const toasts: string[] = [];
  const api = {
    style: {
      inject(id: string, css: string) { injectedCss.set(id, css); },
      remove(id: string) { injectedCss.delete(id); },
      has(id: string) { return injectedCss.has(id); },
      getFile(name: string) { return styleFiles[name] ?? null; },
      listFiles() { return Object.keys(styleFiles); },
    },
    settings: {
      get<T>(_key: string, defaultValue?: T) { return defaultValue as T; },
      async set() {},
      getAll() { return settings; },
      subscribe() { return () => undefined; },
    },
    storage: {
      get<T>(key: string) { return (storage.has(key) ? storage.get(key) : null) as T | null; },
      set(key: string, value: unknown) { storage.set(key, value); },
      remove(key: string) { storage.delete(key); },
      keys() { return Promise.resolve([...storage.keys()]); },
    },
    toast: { show(text: string) { toasts.push(text); } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as PluginAPI;
  return { api, injectedCss, storage, toasts };
};

const withManifestDomain = (plugin: IreaderPlugin, domain: string[]): void => {
  const site = plugin.manifest.site;
  const manifest: PluginManifest = {
    ...plugin.manifest,
    site: {
      domain,
      homeUrl: site?.homeUrl ?? 'https://pc.ireader.com/',
      readerPattern: site?.readerPattern ?? '/reader/\\d+',
    },
  };
  Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });
};

describe('buildPinCookieString', () => {
  it('保持原值并写入持久化属性（host-only、非 Secure 与站点原 cookie 一致）', () => {
    const cookie = buildPinCookieString('abc123');
    expect(cookie.startsWith('_zypps=abc123;')).toBe(true);
    expect(cookie).toContain('Max-Age=');
    expect(cookie).toContain('path=/');
    expect(cookie).not.toContain('Secure');
    expect(cookie).not.toContain('Domain=');
    expect(cookie).not.toContain('HttpOnly');
  });
});

describe('nextSiteBack', () => {
  const home = 'https://pc.ireader.com/';
  const bookshelf = 'https://pc.ireader.com/bookshelf';
  const reader = 'https://pc.ireader.com/reader/12391252';

  it('有站内上一页时回退到上一页并弹出当前页', () => {
    expect(nextSiteBack([bookshelf, reader], reader, home))
      .toEqual({ url: bookshelf, trail: [bookshelf] });
  });

  it('无轨迹、轨迹脏数据或上一页即当前页时清空并落首页', () => {
    expect(nextSiteBack([], reader, home)).toEqual({ url: home, trail: [] });
    expect(nextSiteBack([reader], reader, home)).toEqual({ url: home, trail: [] });
    expect(nextSiteBack([bookshelf, reader], 'https://pc.ireader.com/other', home))
      .toEqual({ url: home, trail: [] });
  });
});

describe('IreaderPlugin', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.cookie = '_zypps=; Max-Age=0; path=/';
  });

  afterEach(() => {
    history.replaceState({}, '', '/');
    document.cookie = '_zypps=; Max-Age=0; path=/';
    sessionStorage.removeItem('atreader-ireader-trail');
    document.body?.classList.remove('atreader-ireader-dark');
    document.body.replaceChildren();
  });

  it('清单契约：阅读增强能力 + nativeTheme + 登录态持久化', () => {
    const plugin = new IreaderPlugin();
    expect(plugin.manifest.id).toBe('ireader');
    expect(plugin.manifest.site?.domain).toEqual(['pc.ireader.com']);
    expect(plugin.manifest.site?.homeUrl).toBe('https://pc.ireader.com/');
    expect(plugin.manifest.capabilities.nativeTheme).toBe(true);
    expect(plugin.manifest.capabilities.doubleColumn).toBe(true);
    expect(plugin.manifest.capabilities.wideMode).toBe(true);
    expect(plugin.manifest.capabilities.autoFlip).toBe(true);
    expect(plugin.manifest.capabilities.chapterNav).toBe(true);
    expect(plugin.manifest.capabilities.hideToolbar).toBe(true);
    expect(plugin.manifest.capabilities.progressTracker).toBe(true);
    expect(plugin.getReaderMenuItems()).toEqual(['reader_wide', 'hide_toolbar', 'auto_flip']);
  });

  it('域名匹配遵循 DNS label 后缀且不误匹配父串', () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const host = window.location.hostname;

    withManifestDomain(plugin, [host]);
    expect(plugin.matchesDomain()).toBe(true);
    withManifestDomain(plugin, [`sub.${host}`]);
    expect(plugin.matchesDomain()).toBe(false);
    withManifestDomain(plugin, ['ireader.com']);
    expect(plugin.matchesDomain()).toBe(false);
  });

  it('阅读页与首页判定', () => {
    const plugin = new IreaderPlugin();
    history.replaceState({}, '', '/reader/12382646?chapter=2');
    expect(plugin.isReaderPage()).toBe(true);
    expect(plugin.isHomePage()).toBe(false);
    history.replaceState({}, '', '/bookshelf');
    expect(plugin.isHomePage()).toBe(true);
    expect(plugin.isReaderPage()).toBe(false);
  });

  it('登录态持久化：会话 cookie 被改写为持久 cookie，值保持不变', () => {
    history.replaceState({}, '', '/reader/12382646');
    document.cookie = '_zypps=session-value-1; path=/';
    const plugin = new IreaderPlugin();
    plugin.onLoad(createApi().api);
    plugin.onUnload();
    expect(document.cookie).toContain('_zypps=session-value-1');
  });

  it('登录态持久化：无 cookie 时不写任何东西', () => {
    history.replaceState({}, '', '/reader/12382646');
    let observed = '';
    const originalCookie = Object.getOwnPropertyDescriptor(document, 'cookie');
    Object.defineProperty(document, 'cookie', {
      get() { return observed; },
      set(v: string) { observed += `${v};`; },
      configurable: true,
    });
    try {
      const plugin = new IreaderPlugin();
      plugin.onLoad(createApi().api);
      plugin.onUnload();
      expect(observed).not.toContain('_zypps=');
    } finally {
      if (originalCookie) Object.defineProperty(document, 'cookie', originalCookie);
    }
  });

  it('章节切换派发带标记的合成方向键（自身捕获器放行，交由站点原生切章）', () => {
    history.replaceState({}, '', '/reader/12382646?chapter=2');
    const seen: Array<Record<string, unknown>> = [];
    const listener = (event: KeyboardEvent) => {
      seen.push({
        key: event.key,
        flagged: Boolean((event as KeyboardEvent & { __atreaderIreaderChapterNavigation?: boolean }).__atreaderIreaderChapterNavigation),
      });
    };
    document.addEventListener('keydown', listener);

    const plugin = new IreaderPlugin();
    plugin.nextChapter();
    plugin.prevChapter();
    document.removeEventListener('keydown', listener);
    expect(seen).toEqual([
      { key: 'ArrowRight', flagged: true },
      { key: 'ArrowLeft', flagged: true },
    ]);
  });

  it('双栏激活时 ←/→ 被拦截转为翻页，带标记的切章键不受影响', () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const { api } = createApi({ readerWide: false });
    plugin.onLoad(api);
    const paginator = (plugin as unknown as { paginator: { nextPage(): boolean; isActive(): boolean } }).paginator!;
    const nextPage = mock(() => true);
    (paginator as unknown as { nextPage: () => boolean }).nextPage = nextPage as unknown as () => boolean;
    (paginator as unknown as { isActive: () => boolean }).isActive = mock(() => true);

    document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true,
    }));

    expect(nextPage).toHaveBeenCalledTimes(1);
    plugin.onUnload();
  });

  it('深浅切换：工具栏键写入 body 类与偏好存储，标签随状态切换', () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const { api, injectedCss, storage, toasts } = createApi({});
    plugin.onLoad(api);

    const darkButton = document.querySelector<HTMLButtonElement>('.atreader-ireader-toolbar button[data-role="dark"]');
    expect(darkButton).not.toBeNull();
    darkButton!.click();

    expect(document.body.classList.contains('atreader-ireader-dark')).toBe(true);
    expect(storage.get('dark-enabled')).toBe(true);
    expect(injectedCss.get('dark')).toContain('#1b1d1f');
    expect(darkButton!.textContent).toContain('日间');

    darkButton!.click();
    expect(document.body.classList.contains('atreader-ireader-dark')).toBe(false);
    expect(storage.get('dark-enabled')).toBe(false);

    plugin.onUnload();
    expect(toasts).toEqual([]);
  });

  it('字体键弹出面板：默认 28px/中字重，字号滑杆调节档位并注入样式', () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const { api, injectedCss, storage } = createApi({});
    plugin.onLoad(api);

    const fontButton = document.querySelector<HTMLButtonElement>('.atreader-ireader-toolbar button[data-role="font"]');
    expect(fontButton?.textContent).toContain('字体');
    fontButton!.click();
    const panel = document.querySelector('.atreader-ireader-font-panel');
    expect(panel).not.toBeNull();

    // 默认档：28px + 中（506L_pua），样式在面板打开前就已注入；
    // 无 Tauri 环境（测试）走远程 URL 回退，@font-face 引用远程字体
    expect(injectedCss.get('font')).toContain('font-size: 28px');
    expect(injectedCss.get('font')).toContain("font-family: 'FZYouH Mid', FZYouH, sans-serif");
    expect(injectedCss.get('font')).toContain('FZYouH_506L_pua.ttf');
    expect(storage.get('font-weight-index')).toBeUndefined();

    const sizeInput = panel!.querySelector<HTMLInputElement>('input[aria-label="字号"]')!;
    expect(sizeInput.max).toBe('8');
    sizeInput.value = '7';
    sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(storage.get('font-step')).toBe(7);
    expect(injectedCss.get('font')).toContain('font-size: 30px');
    expect(panel!.querySelector<HTMLElement>('.row .value')!.textContent).toBe('30px');

    sizeInput.value = '1';
    sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    // 18px 为站点原生字号：仅注入字形家族，不注入字号规则
    expect(injectedCss.get('font')).toContain('FZYouH Mid');
    expect(injectedCss.get('font')).not.toContain('font-size');
    plugin.onUnload();
  });

  it('字形滑杆切换字重：注入 @font-face 与字体家族，全默认时移除样式', () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const { api, injectedCss, storage } = createApi({});
    plugin.onLoad(api);

    const fontButton = document.querySelector<HTMLButtonElement>('.atreader-ireader-toolbar button[data-role="font"]');
    fontButton!.click();
    const panel = document.querySelector('.atreader-ireader-font-panel')!;
    const weightInput = panel.querySelector<HTMLInputElement>('input[aria-label="字形粗细"]')!;
    expect(weightInput.max).toBe('2');
    expect(panel.querySelectorAll('.ticks span').length).toBe(3);

    weightInput.value = '2';
    weightInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(storage.get('font-weight-index')).toBe(2);
    expect(injectedCss.get('font')).toContain('FZYouH_504L_pua.ttf');
    expect(injectedCss.get('font')).toContain("font-family: 'FZYouH Thin', FZYouH, sans-serif");
    expect(panel.querySelectorAll<HTMLElement>('.row .value')[1].textContent).toBe('细');

    weightInput.value = '1';
    weightInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(injectedCss.get('font')).toContain('FZYouH_506L_pua.ttf');

    // 回到粗档、字号 28：仅注入字号；字号回到 18 原生档才全部免注入
    const sizeInput = panel.querySelector<HTMLInputElement>('input[aria-label="字号"]')!;
    sizeInput.value = '6';
    sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    weightInput.value = '0';
    weightInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(storage.get('font-weight-index')).toBe(0);
    expect(injectedCss.get('font')).toContain('font-size: 28px');
    expect(injectedCss.get('font')).not.toContain('font-family');

    sizeInput.value = '1';
    sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(injectedCss.has('font')).toBe(false);
    plugin.onUnload();
  });

  it('点击面板外部或按 Escape 关闭面板；滚轮落在面板内不翻页', () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const { api } = createApi({});
    plugin.onLoad(api);
    const paginator = (plugin as unknown as { paginator: { isActive(): boolean; nextPage(): boolean } }).paginator!;
    (paginator as unknown as { isActive: () => boolean }).isActive = mock(() => true);
    const nextPage = mock(() => true);
    (paginator as unknown as { nextPage: () => boolean }).nextPage = nextPage as unknown as () => boolean;

    const fontButton = document.querySelector<HTMLButtonElement>('.atreader-ireader-toolbar button[data-role="font"]');
    fontButton!.click();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.atreader-ireader-font-panel')).toBeNull();

    fontButton!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.atreader-ireader-font-panel')).toBeNull();

    fontButton!.click();
    const panelAgain = document.querySelector('.atreader-ireader-font-panel')!;
    panelAgain.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    expect(nextPage).not.toHaveBeenCalled();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    void panelAgain;
    plugin.onUnload();
  });

  it('菜单「隐藏工具栏」开启时隐藏插件工具栏', () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const { api } = createApi({ hideToolbar: true });
    plugin.onLoad(api);
    expect(document.querySelector('.atreader-ireader-toolbar')?.classList.contains('atreader-ireader-toolbar-hidden')).toBe(true);

    plugin.onUnload();
  });

  it('双栏时注入页码指示器样式', () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const { api, injectedCss } = createApi({});
    plugin.onLoad(api);
    expect(injectedCss.get('progress')).toContain('.atreader-ireader-page-indicator');
    plugin.onUnload();
  });

  it('字体偏好迁移：升级后首次加载重置为新默认（28px/中）', async () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const { api, injectedCss, storage } = createApi({});
    storage.set('font-step', 2);
    storage.set('font-weight-index', 0);
    plugin.onLoad(api);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(storage.get('font-step')).toBe(6);
    expect(storage.get('font-weight-index')).toBe(1);
    expect(storage.get('font-prefs-version')).toBe(2);
    expect(injectedCss.get('font')).toContain('font-size: 28px');
    expect(injectedCss.get('font')).toContain("font-family: 'FZYouH Mid', FZYouH, sans-serif");
    expect(injectedCss.get('font')).toContain('FZYouH_506L_pua.ttf');
    plugin.onUnload();
  });

  it('进度追踪能力关闭：页码常显，位置记忆停止（spread: 不再写入）', () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const { api, injectedCss, storage } = createApi({});
    plugin.onLoad(api);
    expect(injectedCss.has('progress')).toBe(true);

    // 模拟插件编辑器把「进度追踪」关掉：壳层下发的 manifest 覆盖运行时清单
    const manifest: PluginManifest = {
      ...plugin.manifest,
      capabilities: { ...plugin.manifest.capabilities, progressTracker: false },
    };
    Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });

    window.dispatchEvent(new Event('ipc:route-changed'));
    // 页码常显：开关不再隐藏页码或回收底部预留。
    expect(injectedCss.has('progress')).toBe(true);

    // 位置记忆关闭：翻页不得写入 `spread:` 章节位置。
    plugin.nextPage();
    expect([...storage.keys()].some(key => key.startsWith('spread:'))).toBe(false);
    plugin.onUnload();
  });

  it('目录键开关原生抽屉：关态点目录按钮唤出，开态点关闭键收起', () => {
    history.replaceState({}, '', '/reader/12382646');
    const catalogClick = mock(() => undefined);
    const closeClick = mock(() => undefined);
    const action = document.createElement('div');
    action.className = 'reader-header-action';
    const button = document.createElement('button');
    button.className = 'zy-btn';
    button.textContent = '目录';
    button.addEventListener('click', catalogClick);
    action.append(button);
    const header = document.createElement('div');
    header.className = 'reader-header';
    const wrapper = document.createElement('div');
    wrapper.className = 'directory-wrapper';
    const directory = document.createElement('div');
    directory.className = 'directory';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'zy-btn close-btn';
    closeBtn.addEventListener('click', closeClick);
    directory.append(closeBtn);
    wrapper.append(directory);
    header.append(action, wrapper);
    document.body.append(header);

    const plugin = new IreaderPlugin();
    const { api } = createApi({});
    plugin.onLoad(api);

    const catalogKey = document.querySelector<HTMLButtonElement>('.atreader-ireader-toolbar button[data-role="catalog"]');
    catalogKey!.click();
    expect(catalogClick).toHaveBeenCalledTimes(1);
    expect(closeClick).not.toHaveBeenCalled();

    wrapper.style.opacity = '1';
    catalogKey!.click();
    expect(closeClick).toHaveBeenCalledTimes(1);
    expect(catalogClick).toHaveBeenCalledTimes(1);
    plugin.onUnload();
  });

  it('站点返回键被拦截为站内回退，不再触发站点自身的历史回退', () => {
    history.replaceState({}, '', '/reader/12382646');
    sessionStorage.setItem(
      'atreader-ireader-trail',
      JSON.stringify([`${window.location.origin}/bookshelf`, window.location.href]),
    );
    const siteHandler = mock(() => undefined);
    const title = document.createElement('div');
    title.className = 'reader-header-title';
    const button = document.createElement('button');
    button.className = 'zy-btn';
    button.addEventListener('click', siteHandler);
    title.append(button);
    document.body.append(title);

    const plugin = new IreaderPlugin();
    const { api } = createApi({});
    plugin.onLoad(api);
    const navigate = mock(() => undefined);
    (plugin as unknown as { navigateTo: (url: string) => void }).navigateTo
      = navigate as unknown as (url: string) => void;

    button.click();
    expect(navigate).toHaveBeenCalledWith(`${window.location.origin}/bookshelf`);
    expect(siteHandler).not.toHaveBeenCalled();
    plugin.onUnload();
  });

  it('菜单「后退」（⌘[）经 back() 走站内回退，无轨迹落首页', () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const { api } = createApi({});
    plugin.onLoad(api);
    const navigate = mock(() => undefined);
    (plugin as unknown as { navigateTo: (url: string) => void }).navigateTo
      = navigate as unknown as (url: string) => void;

    plugin.back();
    expect(navigate).toHaveBeenCalledWith('https://pc.ireader.com/');
    plugin.onUnload();
  });

  it('离开阅读页时移除样式与工具栏', () => {
    history.replaceState({}, '', '/reader/12382646');
    const plugin = new IreaderPlugin();
    const { api, injectedCss } = createApi({});
    plugin.onLoad(api);
    expect(document.querySelector('.atreader-ireader-toolbar')).not.toBeNull();

    history.replaceState({}, '', '/bookshelf');
    window.dispatchEvent(new Event('ipc:route-changed'));
    expect(document.querySelector('.atreader-ireader-toolbar')).toBeNull();
    expect(injectedCss.has('reader')).toBe(false);
    expect(injectedCss.has('dark')).toBe(false);
    plugin.onUnload();
  });
});
