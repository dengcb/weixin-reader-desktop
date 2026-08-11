import { afterEach, describe, expect, it } from 'bun:test';
import type { PluginAPI, PluginManifest } from '../../src/scripts/core/plugin_types';
import { FanqiePlugin } from './index';
import { FANQIE_PAGED_CLASS } from './pagination';

const readerMarkup = () => {
  document.body.innerHTML = `
    <div class="muye-reader">
      <div class="muye-reader-inner">
        <div class="muye-reader-box">
          <div class="muye-reader-content"><p>正文</p></div>
        </div>
      </div>
    </div>
    <div class="reader-toolbar">
      <div><div class="reader-toolbar-item" id="bookshelf">加书架</div></div>
    </div>`;
};

const createApi = (settings: Record<string, unknown> = {}) => {
  const stored = new Map<string, unknown>();
  const toastMessages: string[] = [];
  const styleFiles: Record<string, string> = {
    'reader.css': 'body.atreader-fanqie-paged { overflow: hidden; }',
    'progress.css': '.atreader-fanqie-page-indicator { position: fixed; }',
    'wide.css': 'body.atreader-fanqie-paged { --atreader-page-ratio: 90%; }',
    'toolbar.css': '.reader-toolbar { display: none; }',
    'navbar.css': '.muye-reader-nav { display: none; }',
    'layout-toggle.css': '.atreader-fanqie-layout-toggle { cursor: pointer; }',
    'viewport.css': ':root { font-size: 10px; }',
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

describe('Fanqie native toolbar layout toggle', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
    sessionStorage.clear();
    document.body.replaceChildren();
    document.body.className = '';
    document.head.querySelectorAll('style[id^="test-"]').forEach(style => style.remove());
  });

  it('prepends the action button and cycles double, single, double', async () => {
    history.replaceState({}, '', '/reader/chapter-1');
    readerMarkup();
    const { api, stored } = createApi();
    const plugin = new FanqiePlugin();

    plugin.onLoad(api);
    await Promise.resolve();

    const toolbar = document.querySelector('.reader-toolbar > div')!;
    const toggle = toolbar.firstElementChild as HTMLElement;
    expect(toggle.classList.contains('atreader-fanqie-layout-toggle')).toBe(true);
    expect(toggle.lastElementChild?.textContent).toBe('单列');
    expect(document.body.classList.contains(FANQIE_PAGED_CLASS)).toBe(true);
    expect(document.getElementById('test-progress')).not.toBeNull();

    toggle.click();
    expect(toggle.lastElementChild?.textContent).toBe('双栏');
    expect(document.body.classList.contains(FANQIE_PAGED_CLASS)).toBe(false);
    expect(document.getElementById('test-progress')).toBeNull();
    expect(stored.get('double-column-enabled')).toBe(false);

    toggle.click();
    expect(toggle.lastElementChild?.textContent).toBe('单列');
    expect(document.body.classList.contains(FANQIE_PAGED_CLASS)).toBe(true);
    expect(document.getElementById('test-progress')).not.toBeNull();

    plugin.onUnload();
    expect(document.querySelector('.atreader-fanqie-layout-toggle')).toBeNull();
  });

  it('does not inject the button or pagination when the editor capability is off', async () => {
    history.replaceState({}, '', '/reader/chapter-2');
    readerMarkup();
    const { api } = createApi();
    const plugin = new FanqiePlugin();
    const manifest: PluginManifest = {
      ...plugin.manifest,
      capabilities: { ...plugin.manifest.capabilities, doubleColumn: false },
    };
    Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });

    plugin.onLoad(api);
    await Promise.resolve();

    expect(document.querySelector('.atreader-fanqie-layout-toggle')).toBeNull();
    expect(document.body.classList.contains(FANQIE_PAGED_CLASS)).toBe(false);
    plugin.onUnload();
  });

  it('injects during initial DOM mounting without waiting for a page turn', async () => {
    history.replaceState({}, '', '/reader/chapter-3');
    document.body.remove();
    const { api } = createApi();
    const plugin = new FanqiePlugin();

    plugin.onLoad(api);

    document.documentElement.append(document.createElement('body'));
    readerMarkup();
    await new Promise(resolve => setTimeout(resolve, 130));

    const toggle = document.querySelector('.reader-toolbar > div')?.firstElementChild;
    expect(toggle?.classList.contains('atreader-fanqie-layout-toggle')).toBe(true);
    expect(toggle?.lastElementChild?.textContent).toBe('单列');
    plugin.onUnload();
  });

  it('loads the stored wide style even when the plugin starts before body exists', async () => {
    history.replaceState({}, '', '/reader/chapter-wide');
    document.body.remove();
    const { api } = createApi({ readerWide: true });
    const plugin = new FanqiePlugin();

    plugin.onLoad(api);

    expect(document.getElementById('test-wide')?.textContent)
      .toContain('--atreader-page-ratio: 90%');
    const readerStyle = document.getElementById('test-reader')!;
    const wideStyle = document.getElementById('test-wide')!;
    expect(readerStyle.compareDocumentPosition(wideStyle) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0);
    document.documentElement.append(document.createElement('body'));
    plugin.onUnload();
  });

  it('hides the complete native navbar row and divider through the navbar style file', async () => {
    history.replaceState({}, '', '/reader/chapter-4');
    readerMarkup();
    const navbar = document.createElement('div');
    navbar.className = 'muye-reader-nav';
    navbar.innerHTML = '<div class="muye-reader-nav-inner">返回 书名</div>';
    document.body.prepend(navbar);
    const { api } = createApi({ hideNavbar: true });
    const plugin = new FanqiePlugin();

    plugin.onLoad(api);
    await Promise.resolve();

    expect(document.getElementById('test-navbar')?.textContent)
      .toContain('.muye-reader-nav { display: none; }');
    expect(plugin.getReaderMenuItems()).toContain('hide_navbar');
    plugin.onUnload();
    expect(document.getElementById('test-navbar')).toBeNull();
  });

  it('hides the page indicator and reclaims its bottom space when progress tracking is off', async () => {
    history.replaceState({}, '', '/reader/chapter-progress-hidden');
    readerMarkup();
    const { api } = createApi();
    const plugin = new FanqiePlugin();
    const manifest: PluginManifest = {
      ...plugin.manifest,
      capabilities: { ...plugin.manifest.capabilities, progressTracker: false },
    };
    Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });

    plugin.onLoad(api);
    await Promise.resolve();

    const viewport = document.querySelector<HTMLElement>('.atreader-fanqie-page-viewport');
    expect(document.querySelector('.atreader-fanqie-page-indicator')).toBeNull();
    expect(document.getElementById('test-progress')).toBeNull();
    expect(viewport?.style.getPropertyValue('--atreader-page-height'))
      .toBe(`${Math.max(320, window.innerHeight - 16)}px`);

    plugin.onUnload();
  });
});

describe('Fanqie double-column chapter keyboard navigation', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
    sessionStorage.clear();
    document.body.replaceChildren();
    document.body.className = '';
    document.head.querySelectorAll('style[id^="test-"]').forEach(style => style.remove());
  });

  it('maps up and down to native previous and next chapter keys when enabled', async () => {
    history.replaceState({}, '', '/reader/chapter-keyboard');
    readerMarkup();
    const { api, toastMessages } = createApi();
    const plugin = new FanqiePlugin();
    const nativeKeys: string[] = [];
    const captureNativeKey = (event: KeyboardEvent) => {
      if (event.target === document) nativeKeys.push(event.key);
    };
    document.addEventListener('keydown', captureNativeKey);

    plugin.onLoad(api);
    await Promise.resolve();

    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
    document.body.dispatchEvent(up);
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    document.body.dispatchEvent(down);

    expect(nativeKeys).toEqual(['ArrowLeft', 'ArrowRight']);
    expect(toastMessages).toEqual(['上一章', '下一章']);
    expect(up.defaultPrevented).toBe(true);
    expect(down.defaultPrevented).toBe(true);
    expect(sessionStorage.getItem('atreader-fanqie-open-previous-at-end')).not.toBeNull();

    plugin.onUnload();
    document.removeEventListener('keydown', captureNativeKey);
  });

  it('also recognizes standard direction codes when the key value is unavailable', async () => {
    history.replaceState({}, '', '/reader/chapter-keyboard-code');
    readerMarkup();
    const { api } = createApi();
    const plugin = new FanqiePlugin();
    const nativeKeys: string[] = [];
    const captureNativeKey = (event: KeyboardEvent) => {
      if (event.target === document) nativeKeys.push(event.key);
    };
    document.addEventListener('keydown', captureNativeKey);

    plugin.onLoad(api);
    await Promise.resolve();

    const up = new KeyboardEvent('keydown', { code: 'ArrowUp', cancelable: true });
    const down = new KeyboardEvent('keydown', { code: 'ArrowDown', cancelable: true });
    document.body.dispatchEvent(up);
    document.body.dispatchEvent(down);

    expect(nativeKeys).toEqual(['ArrowLeft', 'ArrowRight']);
    expect(up.defaultPrevented).toBe(true);
    expect(down.defaultPrevented).toBe(true);

    plugin.onUnload();
    document.removeEventListener('keydown', captureNativeKey);
  });

  it('leaves up and down untouched when chapter navigation capability is off', async () => {
    history.replaceState({}, '', '/reader/chapter-keyboard-disabled');
    readerMarkup();
    const { api } = createApi();
    const plugin = new FanqiePlugin();
    const manifest: PluginManifest = {
      ...plugin.manifest,
      capabilities: { ...plugin.manifest.capabilities, chapterNav: false },
    };
    Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });
    const nativeKeys: string[] = [];
    const captureNativeKey = (event: KeyboardEvent) => {
      if (event.target === document && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        nativeKeys.push(event.key);
      }
    };
    document.addEventListener('keydown', captureNativeKey);

    plugin.onLoad(api);
    await Promise.resolve();

    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    document.body.dispatchEvent(up);
    document.body.dispatchEvent(down);

    expect(nativeKeys).toEqual([]);
    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);

    plugin.onUnload();
    document.removeEventListener('keydown', captureNativeKey);
  });

  it('only enables chapter keys while double-column pagination is active', async () => {
    history.replaceState({}, '', '/reader/chapter-keyboard-single');
    readerMarkup();
    const { api } = createApi();
    const plugin = new FanqiePlugin();
    const nativeKeys: string[] = [];
    const captureNativeKey = (event: KeyboardEvent) => {
      if (event.target === document) nativeKeys.push(event.key);
    };
    document.addEventListener('keydown', captureNativeKey);

    plugin.onLoad(api);
    await Promise.resolve();
    (document.querySelector('.atreader-fanqie-layout-toggle') as HTMLElement).click();

    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    document.body.dispatchEvent(down);

    expect(nativeKeys).toEqual([]);
    expect(down.defaultPrevented).toBe(false);

    plugin.onUnload();
    document.removeEventListener('keydown', captureNativeKey);
  });
});
