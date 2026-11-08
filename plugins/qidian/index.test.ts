import { afterEach, describe, expect, it } from 'bun:test';
import type { PluginAPI, PluginManifest } from '../../src/scripts/core/plugin_types';
import { QidianPlugin } from './index';

const READER_URL = '/chapter/1046978342/896610636/';
const CHAPTER_ID = '896610636';

const readerMarkup = (withCatalog = true) => {
  document.body.innerHTML = `
    <nav id="navbar"><a href="/">起点中文网</a></nav>
    <div id="reader">
      <div id="reader-content">
        <section id="r-breadcrumbs">首页 &gt; 测试之书</section>
        <section id="r-titlePage">测试之书</section>
        <div class="chapter-wrapper">
          <div class="relative">
            <div class="_moreComment_abc123">本章段评</div>
            <div class="print enable-review">
              <h1 class="title">2.淬体术（新书求各种支持） <span class="review">段评</span></h1>
              <div class="chapter-meta">测试之书 · 作者：测试作者</div>
              <main class="content" id="c-${CHAPTER_ID}">
                <p>正文第一段<span class="review">1</span></p>
                <p>正文第二段</p>
              </main>
            </div>
            <div class="nav-btn-group">
              <a class="nav-btn" href="/chapter/1046978342/869269049/">上一章</a>
              <a class="nav-btn" href="/book/1046978342/catalog/">目录</a>
              <a class="nav-btn" href="/chapter/1046978342/896726633/">下一章</a>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="left-container"></div>
    <div id="r-menu"><button type="button">目录</button></div>
    ${withCatalog ? `
      <div id="chapter-list">
        <a href="/chapter/1046978342/869269049/">第1章</a>
        <a href="/chapter/1046978342/${CHAPTER_ID}/">第2章</a>
        <a href="/chapter/1046978342/896726633/">第3章</a>
      </div>` : ''}
    <script id="vite-plugin-ssr_pageContext" type="application/json">${JSON.stringify({
      pageContext: {
        pageProps: {
          pageData: {
            bookInfo: { bookId: 1046978342, bookName: '测试之书' },
            chapterInfo: {
              chapterId: 896610636,
              chapterName: '2.淬体术（新书求各种支持）',
              chapterOrder: 2000,
              seq: 2,
              prev: 869269049,
              next: 896726633,
            },
          },
        },
      },
    })}</script>`;
};

const createApi = (settings: Record<string, unknown> = {}) => {
  const stored = new Map<string, unknown>();
  const toastMessages: string[] = [];
  const styleFiles: Record<string, string> = {
    'reader.css': 'body.atreader-qidian-paged { overflow: hidden; }',
    'progress.css': '.atreader-qidian-page-indicator { position: fixed; }',
    'wide.css': 'body.atreader-qidian-paged { --atreader-page-ratio: 90%; }',
    'toolbar.css': '#left-container, #r-menu { display: none; }',
    'navbar.css': '#navbar { display: none; }',
    'layout-toggle.css': '.atreader-qidian-layout-toggle { cursor: pointer; }',
  };
  const api = {
    style: {
      inject(id: string, css: string) {
        let style = document.getElementById(`test-${id}`) as HTMLStyleElement | null;
        if (!style) {
          style = document.createElement('style');
          style.id = `test-${id}`;
          document.head.append(style);
        }
        style.textContent = css;
      },
      remove(id: string) { document.getElementById(`test-${id}`)?.remove(); },
      has(id: string) { return document.getElementById(`test-${id}`) !== null; },
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
      async get<T>(key: string) { return (stored.get(key) as T | undefined) ?? null; },
      async set(key: string, value: unknown) { stored.set(key, value); },
      async remove(key: string) { stored.delete(key); },
      async keys() { return [...stored.keys()]; },
    },
    toast: { show(text: string) { toastMessages.push(text); } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as PluginAPI;
  return { api, stored, toastMessages };
};

/** 记录章节链接点击并阻止 happy-dom 触发导航。 */
const captureChapterClicks = (): { clicked: string[]; release: () => void } => {
  const clicked: string[] = [];
  const capture = (event: Event) => {
    const target = event.target as HTMLElement;
    if (target?.tagName === 'A') {
      clicked.push((target.textContent || '').trim());
      event.preventDefault();
    }
  };
  document.addEventListener('click', capture);
  return { clicked, release: () => document.removeEventListener('click', capture) };
};

const cleanupPage = () => {
  history.replaceState({}, '', '/');
  sessionStorage.clear();
  document.body.replaceChildren();
  document.body.className = '';
  document.head.querySelectorAll('style[id^="test-"]').forEach(style => style.remove());
};

describe('Qidian page detection', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
  });

  it('manifest 声明 nativeTheme，壳层不注入反色滤镜', () => {
    const plugin = new QidianPlugin();
    expect(plugin.manifest.capabilities.nativeTheme).toBe(true);
  });

  it('recognizes chapter pages only', () => {
    const plugin = new QidianPlugin();

    history.replaceState({}, '', READER_URL);
    expect(plugin.isReaderPage()).toBe(true);

    history.replaceState({}, '', '/chapter/1046978342/896610636');
    expect(plugin.isReaderPage()).toBe(true);

    history.replaceState({}, '', '/book/1046978342/');
    expect(plugin.isReaderPage()).toBe(false);

    history.replaceState({}, '', '/book/1046978342/catalog/');
    expect(plugin.isReaderPage()).toBe(false);

    history.replaceState({}, '', '/');
    expect(plugin.isReaderPage()).toBe(false);
    expect(plugin.isHomePage()).toBe(true);
  });
});

describe('Qidian reading progress', () => {
  afterEach(cleanupPage);

  it('derives book progress from the native catalog and SSR chapter data', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const plugin = new QidianPlugin();

    expect(plugin.getChapterProgress()).toBe(67);
    expect(await plugin.getBookProgress()).toEqual({
      progress: 67,
      chapterIdx: 2,
      summary: '测试之书 · 2.淬体术（新书求各种支持）',
    });
  });

  it('falls back to SSR chapter order when the catalog drawer is not rendered', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup(false);
    const plugin = new QidianPlugin();

    expect(plugin.getChapterProgress()).toBe(0);
    expect(await plugin.getBookProgress()).toEqual({
      chapterIdx: 2,
      summary: '测试之书 · 2.淬体术（新书求各种支持）',
    });
  });

  it('returns null when the page is not a chapter page', async () => {
    history.replaceState({}, '', '/book/1046978342/');
    document.body.innerHTML = '<main class="content"><p>简介</p></main>';
    const plugin = new QidianPlugin();

    expect(plugin.getChapterProgress()).toBe(0);
    expect(await plugin.getBookProgress()).toBeNull();
  });
});

describe('Qidian native toolbar layout toggle', () => {
  afterEach(cleanupPage);

  it('prepends the action button and cycles double, single, double', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api, stored } = createApi();
    const plugin = new QidianPlugin();

    plugin.onLoad(api);
    await Promise.resolve();

    const menu = document.getElementById('r-menu')!;
    const toggle = menu.firstElementChild as HTMLElement;
    expect(toggle.classList.contains('atreader-qidian-layout-toggle')).toBe(true);
    expect(toggle.lastElementChild?.textContent).toBe('单列');
    expect(document.body.classList.contains('atreader-qidian-paged')).toBe(true);
    expect(document.getElementById('test-progress')).not.toBeNull();
    expect(document.querySelector('.atreader-qidian-page-indicator')).not.toBeNull();

    toggle.click();
    expect(toggle.lastElementChild?.textContent).toBe('双栏');
    expect(document.body.classList.contains('atreader-qidian-paged')).toBe(false);
    expect(document.getElementById('test-progress')).toBeNull();
    expect(document.querySelector('.atreader-qidian-page-indicator')).toBeNull();
    expect(stored.get('double-column-enabled')).toBe(false);

    toggle.click();
    expect(toggle.lastElementChild?.textContent).toBe('单列');
    expect(document.body.classList.contains('atreader-qidian-paged')).toBe(true);
    expect(document.getElementById('test-progress')).not.toBeNull();

    plugin.onUnload();
    expect(document.querySelector('.atreader-qidian-layout-toggle')).toBeNull();
  });

  it('does not inject the button or pagination when the editor capability is off', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api } = createApi();
    const plugin = new QidianPlugin();
    const manifest: PluginManifest = {
      ...plugin.manifest,
      capabilities: { ...plugin.manifest.capabilities, doubleColumn: false },
    };
    Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });

    plugin.onLoad(api);
    await Promise.resolve();

    expect(document.querySelector('.atreader-qidian-layout-toggle')).toBeNull();
    expect(document.body.classList.contains('atreader-qidian-paged')).toBe(false);
    plugin.onUnload();
  });

  it('keeps the page indicator when progress tracking is off and stops position memory', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api, stored } = createApi();
    const plugin = new QidianPlugin();
    const manifest: PluginManifest = {
      ...plugin.manifest,
      capabilities: { ...plugin.manifest.capabilities, progressTracker: false },
    };
    Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });

    plugin.onLoad(api);
    await Promise.resolve();

    // 页码常显：进度追踪开关不再控制页码及其预留高度。
    expect(document.querySelector('.atreader-qidian-page-indicator')).not.toBeNull();
    expect(document.getElementById('test-progress')).not.toBeNull();

    // 位置记忆关闭：翻页不得写入 `spread:` 章节位置。
    plugin.nextPage();
    await Promise.resolve();
    expect([...stored.keys()].some(key => key.startsWith('spread:'))).toBe(false);

    plugin.onUnload();
  });

  it('hides the site navbar through the navbar style file', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api } = createApi({ hideNavbar: true });
    const plugin = new QidianPlugin();

    plugin.onLoad(api);
    await Promise.resolve();

    expect(document.getElementById('test-navbar')?.textContent)
      .toContain('#navbar { display: none; }');
    expect(plugin.getReaderMenuItems()).toContain('hide_navbar');
    plugin.onUnload();
    expect(document.getElementById('test-navbar')).toBeNull();
  });
});

describe('Qidian double-column chapter keyboard navigation', () => {
  afterEach(cleanupPage);

  it('maps up and down to the native chapter links when enabled', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api, toastMessages } = createApi();
    const plugin = new QidianPlugin();
    const { clicked, release } = captureChapterClicks();

    plugin.onLoad(api);
    await Promise.resolve();

    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
    document.body.dispatchEvent(up);
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    document.body.dispatchEvent(down);

    expect(clicked).toEqual(['上一章', '下一章']);
    expect(toastMessages).toEqual(['上一章', '下一章']);
    expect(up.defaultPrevented).toBe(true);
    expect(down.defaultPrevented).toBe(true);
    // 显式跳章落章首，不能复用 ← 翻页溢出的“落章尾”标记
    expect(sessionStorage.getItem('atreader-qidian-open-chapter-at-start')).not.toBeNull();
    expect(sessionStorage.getItem('atreader-qidian-open-previous-at-end')).toBeNull();

    plugin.onUnload();
    release();
  });

  it('falls through to chapter links when paging past the chapter boundary', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api } = createApi();
    const plugin = new QidianPlugin();
    const { clicked, release } = captureChapterClicks();

    plugin.onLoad(api);
    await Promise.resolve();

    plugin.nextPage();
    expect(clicked).toEqual(['下一章']);

    plugin.prevPage();
    expect(clicked).toEqual(['下一章', '上一章']);
    // ← 翻页溢出的连续阅读流：新章节应落在末尾而不是开头
    expect(sessionStorage.getItem('atreader-qidian-open-previous-at-end')).not.toBeNull();

    plugin.onUnload();
    release();
  });

  it('leaves arrows untouched when chapter navigation capability is off', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api } = createApi();
    const plugin = new QidianPlugin();
    const manifest: PluginManifest = {
      ...plugin.manifest,
      capabilities: { ...plugin.manifest.capabilities, chapterNav: false },
    };
    Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });
    const { clicked, release } = captureChapterClicks();

    plugin.onLoad(api);
    await Promise.resolve();

    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
    document.body.dispatchEvent(up);
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    document.body.dispatchEvent(down);

    expect(clicked).toEqual([]);
    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);

    plugin.onUnload();
    release();
  });
});

describe('Qidian wheel paging yields to native popup scrolling', () => {
  afterEach(cleanupPage);

  const appendCatalogPopup = (): HTMLElement => {
    // 模拟起点章节目录抽屉：浮层内一个纵向溢出的滚动列表
    const list = document.createElement('div');
    list.className = 'chapter-list-scroll';
    list.style.overflowY = 'auto';
    list.innerHTML = '<p>第一章</p><p>第二章</p><p>第三章</p>';
    const popup = document.createElement('div');
    popup.className = 'catalog-popup';
    popup.append(list);
    document.body.append(popup);
    Object.defineProperty(list, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true });
    return list;
  };

  it('lets the chapter drawer scroll instead of turning pages', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api } = createApi();
    const plugin = new QidianPlugin();

    plugin.onLoad(api);
    await Promise.resolve();

    const list = appendCatalogPopup();
    const popupWheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    list.firstElementChild!.dispatchEvent(popupWheel);
    expect(popupWheel.defaultPrevented).toBe(false);

    // 正文上的滚轮仍被翻页接管
    const contentWheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    document.querySelector('.chapter-wrapper main.content')!.dispatchEvent(contentWheel);
    expect(contentWheel.defaultPrevented).toBe(true);

    plugin.onUnload();
  });
});

describe('Qidian plugin shell styles', () => {
  it('targets the qidian reading containers from the style files', async () => {
    const read = (name: string): Promise<string> =>
      Bun.file(new URL(`./styles/${name}`, import.meta.url)).text();
    const readerCss = await read('reader.css');
    const wideCss = await read('wide.css');
    const toolbarCss = await read('toolbar.css');
    const navbarCss = await read('navbar.css');
    const progressCss = await read('progress.css');
    const layoutToggleCss = await read('layout-toggle.css');

    expect(readerCss).toContain('body.atreader-qidian-paged #reader-content');
    expect(readerCss).toContain('.atreader-qidian-page-viewport');
    // 起点正文晚于 didFinish 由客户端插入：未绑定进视口的正文必须先隐藏，
    // 否则插入到重绑之间会闪现原生单栏（先单列后双栏）。
    expect(readerCss).toContain(':is(.print, .enable-review) > main.content');
    expect(readerCss).toContain('visibility: hidden !important');
    expect(readerCss).toContain('column-count: 2 !important');
    expect(readerCss).toContain('--atreader-page-ratio: 80%');
    expect(readerCss).toContain('body.atreader-qidian-paged #left-container');
    expect(readerCss).toContain('body.atreader-qidian-paged #right-container');
    // 两侧控件贴书页边缘（偏移=书页留白），不得带像素补偿推进书页内部。
    expect(readerCss).toContain('left: calc((100% - var(--atreader-page-ratio)) / 2) !important');
    expect(readerCss).toContain('right: calc((100% - var(--atreader-page-ratio)) / 2) !important');
    expect(readerCss).not.toContain('+ 39px');
    expect(readerCss).not.toContain('+ 46px');
    expect(readerCss).toContain('transition: none !important');
    expect(readerCss).not.toContain('.atreader-qidian-page-indicator');
    expect(wideCss).toContain('--atreader-page-ratio: 90%');
    expect(wideCss).toContain('body.atreader-qidian-paged');
    expect(toolbarCss).toContain('#left-container');
    expect(toolbarCss).toContain('#r-menu');
    expect(navbarCss).toContain('#navbar');
    expect(navbarCss).toContain(':is(.print, .enable-review) h1.title');
    expect(navbarCss).toContain(':is(.print, .enable-review) > .tooltip-wrapper');
    expect(navbarCss).toContain('font-size: 12px !important');
    expect(navbarCss).toContain('margin: 0 0 24px !important');
    expect(navbarCss).toContain('h1.title + div');
    expect(progressCss).toContain('@foundation');
    expect(progressCss).toContain('页码常显');
    expect(progressCss).toContain('.atreader-qidian-page-indicator');
    expect(layoutToggleCss).toContain('.atreader-qidian-layout-toggle');
    expect(layoutToggleCss).toContain('width: 64px');
    expect(layoutToggleCss).toContain('var(--sheet-background-gray-50');
    expect(layoutToggleCss).toContain('fill: none !important');
  });
});
