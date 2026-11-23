import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginAPI } from '../../src/scripts/core/plugin_types';
import { setupFanqieStylePanel } from './style_panel';

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

const createApi = (initial: Record<string, unknown> = {}) => {
  let config = { ...initial };
  let listener: ((config: Record<string, any>) => void) | null = null;
  const setCalls: Array<[string, unknown]> = [];
  const setManyCalls: Array<Record<string, unknown>> = [];
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
      css(id: string) { return document.getElementById(`test-${id}`)?.textContent ?? ''; },
    },
    settings: {
      getAll() { return config; },
      subscribe(cb: (config: Record<string, any>) => void) {
        listener = cb;
        return () => { listener = null; };
      },
      async set(key: string, value: unknown) { setCalls.push([key, value]); },
      async setMany(partial: Record<string, unknown>) { setManyCalls.push(partial); },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as PluginAPI;
  return {
    api,
    setCalls,
    setManyCalls,
    emit(next: Record<string, unknown>) { config = { ...config, ...next }; listener?.(config); },
  };
};

describe('番茄阅读样式面板', () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    history.replaceState({}, '', '/reader/123');
    document.documentElement.setAttribute('muye-data-theme', 'light');
    readerMarkup();
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    document.head.querySelectorAll('style[id^="test-"]').forEach(node => node.remove());
    document.documentElement.removeAttribute('muye-data-theme');
    document.body.replaceChildren();
    history.replaceState({}, '', '/');
  });

  it('工具栏挂载样式按钮，行距/段距默认用番茄原生值（2.0 / 1em）', () => {
    const { api } = createApi();
    teardown = setupFanqieStylePanel(api);

    const button = document.getElementById('atreader-fanqie-style-button');
    expect(button).not.toBeNull();
    expect(button?.classList.contains('reader-toolbar-item')).toBe(true);
    expect(button?.closest('.reader-toolbar > div')).not.toBeNull();

    const spacing = (api.style as any).css('fanqie-style-spacing');
    expect(spacing).toContain('line-height: 2 !important');
    expect(spacing).toContain('margin-bottom: 1em !important');
  });

  it('点击按钮切换弹框显隐', () => {
    const { api } = createApi();
    teardown = setupFanqieStylePanel(api);
    const button = document.getElementById('atreader-fanqie-style-button')!;
    const panel = document.getElementById('atreader-fanqie-style-panel')!;
    expect(panel.hidden).toBe(true);
    button.click();
    expect(panel.hidden).toBe(false);
    button.click();
    expect(panel.hidden).toBe(true);
  });

  it('纯白正文开启且深色主题：直接定文字色与底色；关闭则移除', () => {
    const { api, emit } = createApi();
    teardown = setupFanqieStylePanel(api);
    document.documentElement.setAttribute('muye-data-theme', 'dark');

    emit({ whiteText: true, whiteTextBrightness: 2.2, whiteTextBackground: '#000000' });
    const reading = (api.style as any).css('fanqie-style-reading');
    expect(reading).toContain('color: #ffffff !important');
    expect(reading).toContain('background-color: #000000 !important');

    emit({ whiteText: false });
    expect((api.style as any).has('fanqie-style-reading')).toBe(false);
  });

  it('浅色主题下纯白正文不生效', () => {
    const { api, emit } = createApi();
    teardown = setupFanqieStylePanel(api);
    document.documentElement.setAttribute('muye-data-theme', 'light');
    emit({ whiteText: true, whiteTextBrightness: 2.2, whiteTextBackground: '#000000' });
    expect((api.style as any).has('fanqie-style-reading')).toBe(false);
  });

  it('恢复默认清空纯白正文与行距段距（回到原生）', () => {
    const { api, setManyCalls } = createApi();
    teardown = setupFanqieStylePanel(api);
    const panel = document.getElementById('atreader-fanqie-style-panel')!;
    panel.querySelector<HTMLButtonElement>('[data-action="reset"]')!.click();
    expect(setManyCalls.length).toBe(1);
    expect(setManyCalls[0]).toMatchObject({
      whiteText: false,
      lineHeight: null,
      paragraphSpacing: null,
    });
  });

  it('卸载移除按钮与全部注入样式', () => {
    const { api } = createApi();
    const local = setupFanqieStylePanel(api);
    expect(document.getElementById('atreader-fanqie-style-button')).not.toBeNull();
    local();
    expect(document.getElementById('atreader-fanqie-style-button')).toBeNull();
    expect((api.style as any).has('fanqie-style-panel-ui')).toBe(false);
    expect((api.style as any).has('fanqie-style-spacing')).toBe(false);
  });
});