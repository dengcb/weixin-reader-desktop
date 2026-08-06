import { afterEach, describe, expect, it } from 'bun:test';
import {
  FANQIE_PAGED_CLASS,
  FanqiePaginator,
  calculateSpreadMetrics,
} from './pagination';

const readerCss = await Bun.file(new URL('./styles/reader.css', import.meta.url)).text();
const progressCss = await Bun.file(new URL('./styles/progress.css', import.meta.url)).text();
const wideCss = await Bun.file(new URL('./styles/wide.css', import.meta.url)).text();
const navbarCss = await Bun.file(new URL('./styles/navbar.css', import.meta.url)).text();

describe('Fanqie spread pagination', () => {
  it('keeps one spread when content fits the visible two columns', () => {
    expect(calculateSpreadMetrics(1000, 1000, 64)).toEqual({
      pageCount: 1,
      pageStride: 1064,
    });
  });

  it('counts complete two-column spreads including the inter-spread gap', () => {
    // 两栏页宽 1000，栏间距 64；四栏内容总宽为 2064。
    expect(calculateSpreadMetrics(1000, 2064, 64)).toEqual({
      pageCount: 2,
      pageStride: 1064,
    });
  });

  it('creates a final spread for an odd trailing column', () => {
    // 三栏内容：最后一页只有左栏，右栏自然留白。
    expect(calculateSpreadMetrics(1000, 1532, 64)).toEqual({
      pageCount: 2,
      pageStride: 1064,
    });
  });

  it('uses a safe fallback for invalid measurements', () => {
    expect(calculateSpreadMetrics(0, 0, Number.NaN)).toEqual({
      pageCount: 1,
      pageStride: 0,
    });
  });
});

describe('Fanqie paginator DOM ownership', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.body.className = '';
  });

  it('clips the original content in a viewport and restores the DOM on destroy', () => {
    const host = document.createElement('section');
    const content = document.createElement('main');
    content.className = 'muye-reader-content';
    host.append(content);
    document.body.append(host);

    const paginator = new FanqiePaginator();
    paginator.enable();

    expect(document.body.classList.contains(FANQIE_PAGED_CLASS)).toBe(true);
    expect(content.parentElement?.className).toBe('atreader-fanqie-page-viewport');
    expect(host.querySelectorAll('.muye-reader-content')).toHaveLength(1);
    expect(document.querySelector('.atreader-fanqie-page-indicator')?.textContent)
      .toBe('1 / 1');
    expect((content.parentElement as HTMLElement).style.getPropertyValue('--atreader-page-height'))
      .toBe(`${Math.max(320, window.innerHeight - 48)}px`);

    paginator.destroy();

    expect(content.parentElement).toBe(host);
    expect(host.querySelector('.atreader-fanqie-page-viewport')).toBeNull();
    expect(document.querySelector('.atreader-fanqie-page-indicator')).toBeNull();
    expect(document.body.classList.contains(FANQIE_PAGED_CLASS)).toBe(false);
  });
});

describe('Fanqie spread shell styles', () => {
  it('expands the native reading background and keeps the toolbar outside the text', () => {
    expect(readerCss).toContain('.muye-reader .muye-reader-inner');
    expect(readerCss).toContain('width: var(--atreader-shell-width) !important');
    expect(readerCss).toContain('.muye-reader-box');
    expect(readerCss).toContain('.reader-toolbar');
    expect(readerCss).toContain('--atreader-page-ratio: 80%');
    expect(readerCss).toContain('--atreader-shell-width: var(--atreader-page-ratio)');
    expect(readerCss).toContain('--atreader-shell-padding: 56px');
    expect(readerCss).toContain('line-height: 1.85 !important');
    expect(readerCss).toContain('margin-bottom: 1.25em !important');
    expect(wideCss).toContain('--atreader-page-ratio: 90%');
    expect(wideCss).toContain('body.atreader-fanqie-paged');
    expect(wideCss).not.toContain('atreader-fanqie-wide');
    expect(readerCss).toContain('transition: none !important');
    expect(readerCss).not.toContain('transition: transform');
    expect(readerCss).not.toContain('.atreader-fanqie-page-indicator');
    expect(progressCss).toContain('[功能能力 6/6：进度追踪]');
    expect(progressCss).toContain('.atreader-fanqie-page-indicator');
    expect(readerCss).not.toMatch(/1240px|1400px/);
    expect(wideCss).not.toMatch(/1540px|1700px/);
  });

  it('compacts the complete chapter header when the navbar is hidden', () => {
    expect(navbarCss).toContain('.muye-reader-nav');
    expect(navbarCss).toContain('display: none !important');
    expect(navbarCss).toContain('.muye-reader-box');
    expect(navbarCss).toContain('padding-top: 3.6rem !important');
    expect(navbarCss).toContain('.muye-reader-subtitle');
    expect(navbarCss).toContain('.muye-reader-title');
    expect(navbarCss).toContain('font-size: 12px !important');
    expect(navbarCss).toContain('margin: 0 0 24px !important');
  });
});
