/**
 * Unit Tests for Boot Styles
 *
 * 首绘样式引导：壳内嵌快照（__ATREADER_BOOT__）在 documentStart 同步套用
 * 站点插件的导航/工具栏隐藏 CSS，插件系统就绪后移除。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { applyBootStyles, settleBootStyles } from '../boot_styles';

const NAVBAR_CSS = 'header { display: none !important; }';
const TOOLBAR_CSS = '.rail { display: none !important; }';

const setSnapshot = (snapshot: unknown): void => {
  (window as unknown as { __ATREADER_BOOT__?: unknown }).__ATREADER_BOOT__ = snapshot;
};

describe('boot styles', () => {
  afterEach(() => {
    settleBootStyles();
    delete (window as unknown as { __ATREADER_BOOT__?: unknown }).__ATREADER_BOOT__;
  });

  it('applies capability-gated styles for the matching site before first paint', () => {
    setSnapshot({
      siteSettings: { zread: { hideNavbar: true, hideToolbar: true } },
      plugins: [
        {
          id: 'zread',
          domains: ['example.com'],
          capabilities: { hideNavbar: true, hideToolbar: true },
          styles: { navbar: NAVBAR_CSS, toolbar: TOOLBAR_CSS },
        },
      ],
    });

    applyBootStyles();

    expect(document.getElementById('atreader-boot-navbar')?.textContent).toBe(NAVBAR_CSS);
    expect(document.getElementById('atreader-boot-toolbar')?.textContent).toBe(TOOLBAR_CSS);
  });

  it('ignores plugins whose domains do not match the host', () => {
    setSnapshot({
      siteSettings: { qidian: { hideNavbar: true } },
      plugins: [
        {
          id: 'qidian',
          domains: ['qidian.com'],
          capabilities: { hideNavbar: true },
          styles: { navbar: NAVBAR_CSS },
        },
      ],
    });

    applyBootStyles();

    expect(document.getElementById('atreader-boot-navbar')).toBeNull();
  });

  it('requires both the manifest capability and the site setting', () => {
    setSnapshot({
      siteSettings: {
        a: { hideNavbar: true },
        b: { hideNavbar: false },
      },
      plugins: [
        {
          id: 'a',
          domains: ['example.com'],
          capabilities: { hideNavbar: false },
          styles: { navbar: NAVBAR_CSS },
        },
        {
          id: 'b',
          domains: ['example.com'],
          capabilities: { hideNavbar: true },
          styles: { navbar: NAVBAR_CSS },
        },
      ],
    });

    applyBootStyles();

    expect(document.getElementById('atreader-boot-navbar')).toBeNull();
  });

  it('tolerates malformed snapshots and entries', () => {
    setSnapshot('not-an-object');
    expect(() => applyBootStyles()).not.toThrow();

    setSnapshot({ plugins: [null, { domains: 'oops' }, { id: 'zread', domains: ['zread.ai'] }] });
    expect(() => applyBootStyles()).not.toThrow();
    expect(document.getElementById('atreader-boot-navbar')).toBeNull();
  });

  it('settle removes boot styles and stays idempotent', () => {
    setSnapshot({
      siteSettings: { zread: { hideNavbar: true } },
      plugins: [
        {
          id: 'zread',
          domains: ['example.com'],
          capabilities: { hideNavbar: true },
          styles: { navbar: NAVBAR_CSS },
        },
      ],
    });
    applyBootStyles();
    expect(document.getElementById('atreader-boot-navbar')).not.toBeNull();

    settleBootStyles();
    expect(document.getElementById('atreader-boot-navbar')).toBeNull();

    settleBootStyles();
    expect(document.getElementById('atreader-boot-navbar')).toBeNull();
  });

  it('applies each style at most once per page', () => {
    setSnapshot({
      siteSettings: { zread: { hideNavbar: true } },
      plugins: [
        {
          id: 'zread',
          domains: ['example.com'],
          capabilities: { hideNavbar: true },
          styles: { navbar: NAVBAR_CSS },
        },
      ],
    });

    applyBootStyles();
    applyBootStyles();

    expect(document.querySelectorAll('#atreader-boot-navbar')).toHaveLength(1);
  });
});

describe('boot styles reader 引导', () => {
  const READER_CSS = '.paged main.content { visibility: hidden !important; }';
  const WIDE_CSS = '.paged { --atreader-page-ratio: 90%; }';
  const PAGED_CLASS = 'atreader-qidian-paged';

  const readerEntry = (): Record<string, unknown> => ({
    id: 'qidian',
    domains: ['example.com'],
    capabilities: { doubleColumn: true },
    pagedClass: PAGED_CLASS,
    // 与 qidian manifest 的 readerPattern 同形
    readerPattern: '/chapter/\\d+/\\d+',
    styles: { reader: READER_CSS, wide: WIDE_CSS },
  });

  afterEach(() => {
    settleBootStyles();
    document.body?.classList.remove(PAGED_CLASS);
    window.localStorage.clear();
    window.history.pushState(null, '', '/');
    delete (window as unknown as { __ATREADER_BOOT__?: unknown }).__ATREADER_BOOT__;
  });

  it('正文页且双栏偏好开启：注入 reader/wide 并挂分栏类，reader 先于 wide', () => {
    window.history.pushState(null, '', '/chapter/1023000/1');
    setSnapshot({ siteSettings: { qidian: { readerWide: true } }, plugins: [readerEntry()] });

    applyBootStyles();

    expect(document.getElementById('atreader-boot-reader')?.textContent).toBe(READER_CSS);
    expect(document.getElementById('atreader-boot-wide')?.textContent).toBe(WIDE_CSS);
    expect(document.body.classList.contains(PAGED_CLASS)).toBe(true);
    const ids = Array.from(document.querySelectorAll('style')).map(style => style.id);
    expect(ids.indexOf('atreader-boot-reader')).toBeLessThan(ids.indexOf('atreader-boot-wide'));
  });

  it('双栏偏好关闭（localStorage false）：不注入 reader、不挂类；wide 仍可引导单栏加宽', () => {
    window.history.pushState(null, '', '/chapter/1023000/1');
    window.localStorage.setItem('plugin_qidian_double-column-enabled', 'false');
    setSnapshot({ siteSettings: { qidian: { readerWide: true } }, plugins: [readerEntry()] });

    applyBootStyles();

    expect(document.getElementById('atreader-boot-reader')).toBeNull();
    expect(document.body.classList.contains(PAGED_CLASS)).toBe(false);
    expect(document.getElementById('atreader-boot-wide')?.textContent).toBe(WIDE_CSS);
  });

  it('readerWide 未开启：只注入 reader，不注入 wide', () => {
    window.history.pushState(null, '', '/chapter/1023000/1');
    setSnapshot({ siteSettings: { qidian: {} }, plugins: [readerEntry()] });

    applyBootStyles();

    expect(document.getElementById('atreader-boot-reader')).not.toBeNull();
    expect(document.getElementById('atreader-boot-wide')).toBeNull();
  });

  it('非正文页（pathname 不匹配）：不注入 reader、不挂类', () => {
    // 默认 pathname '/' 不匹配 /chapter/\d+/\d+
    setSnapshot({ siteSettings: { qidian: { readerWide: true } }, plugins: [readerEntry()] });

    applyBootStyles();

    expect(document.getElementById('atreader-boot-reader')).toBeNull();
    expect(document.getElementById('atreader-boot-wide')).toBeNull();
    expect(document.body.classList.contains(PAGED_CLASS)).toBe(false);
  });

  it('settle 只移除引导样式，分栏类留给插件 reconciler 处理', () => {
    window.history.pushState(null, '', '/chapter/1023000/1');
    setSnapshot({ siteSettings: { qidian: {} }, plugins: [readerEntry()] });
    applyBootStyles();

    settleBootStyles();

    expect(document.getElementById('atreader-boot-reader')).toBeNull();
    expect(document.getElementById('atreader-boot-wide')).toBeNull();
    expect(document.body.classList.contains(PAGED_CLASS)).toBe(true);
  });
});

describe('boot styles 首绘主题引导', () => {
  const themeEntry = (bootTheme: unknown): Record<string, unknown> => ({
    id: 'qimao',
    domains: ['example.com'],
    capabilities: {},
    bootTheme,
    styles: {},
  });
  const QIMAO_BOOT_THEME = {
    hostSelector: '.reader-layout-theme',
    storageKey: 'qimao_reader_setting_data',
    attr: 'data-theme',
    valuePath: 'theme',
  };

  const mountThemeHost = (): HTMLElement => {
    const host = document.createElement('div');
    host.className = 'reader-layout-theme';
    host.setAttribute('data-theme', 'default');
    document.body.append(host);
    return host;
  };

  afterEach(() => {
    settleBootStyles();
    document.body.replaceChildren();
    window.localStorage.clear();
    delete (window as unknown as { __ATREADER_BOOT__?: unknown }).__ATREADER_BOOT__;
  });

  it('存储主题与 SSR 默认不符时，宿主一出现即写入存储主题（首绘前）', () => {
    window.localStorage.setItem(
      'qimao_reader_setting_data',
      JSON.stringify({ theme: 'dark' }),
    );
    const host = mountThemeHost();
    setSnapshot({ plugins: [themeEntry(QIMAO_BOOT_THEME)] });

    applyBootStyles();

    expect(host.getAttribute('data-theme')).toBe('dark');
  });

  it('无站点主题偏好时不写属性（默认主题无需干预）', () => {
    const host = mountThemeHost();
    setSnapshot({ plugins: [themeEntry(QIMAO_BOOT_THEME)] });

    applyBootStyles();

    expect(host.getAttribute('data-theme')).toBe('default');
  });

  it('引导期内属性被重置回默认时补写；settle 后停手', async () => {
    window.localStorage.setItem(
      'qimao_reader_setting_data',
      JSON.stringify({ theme: 'dark' }),
    );
    const host = mountThemeHost();
    setSnapshot({ plugins: [themeEntry(QIMAO_BOOT_THEME)] });
    applyBootStyles();
    expect(host.getAttribute('data-theme')).toBe('dark');

    // 模拟水合重置回 SSR 默认值：守卫补写回存储主题
    host.setAttribute('data-theme', 'default');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(host.getAttribute('data-theme')).toBe('dark');

    settleBootStyles();
    host.setAttribute('data-theme', 'default');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(host.getAttribute('data-theme')).toBe('default');
  });

  it('宿主后于引导出现时（SSR 解析中）也能补上主题', async () => {
    window.localStorage.setItem(
      'qimao_reader_setting_data',
      JSON.stringify({ theme: 'dark' }),
    );
    setSnapshot({ plugins: [themeEntry(QIMAO_BOOT_THEME)] });
    applyBootStyles();

    const host = mountThemeHost();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(host.getAttribute('data-theme')).toBe('dark');
  });

  it('深色加深覆盖（night 样式）存在即随引导注入，与深浅主题选择器惰性共存', () => {
    const NIGHT_CSS = '.reader-layout-theme[data-theme=dark] { background-color: #0b0c0d !important; }';
    setSnapshot({ plugins: [themeEntry(QIMAO_BOOT_THEME)] });
    (window as unknown as { __ATREADER_BOOT__?: { plugins: Array<Record<string, unknown>> } })
      .__ATREADER_BOOT__!.plugins[0]!.styles = { night: NIGHT_CSS };

    applyBootStyles();

    expect(document.getElementById('atreader-boot-night')?.textContent).toBe(NIGHT_CSS);
  });
});
