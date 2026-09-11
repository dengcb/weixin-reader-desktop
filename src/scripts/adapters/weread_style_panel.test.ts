import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { PluginAPI } from '../core/plugin_types';
import { setupStylePanel } from './weread_style_panel';

const createAPI = (initial: Record<string, unknown> = {}) => {
  const styles = new Map<string, string>();
  const set = mock(async (_key: string, _value: unknown) => undefined);
  const setMany = mock(async (_patch: Record<string, unknown>) => undefined);
  let listener: ((settings: Record<string, any>) => void) | null = null;
  const api = {
    style: {
      inject: mock((id: string, css: string) => { styles.set(id, css); }),
      remove: mock((id: string) => { styles.delete(id); }),
    },
    settings: {
      get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
      set,
      setMany,
      getAll: () => initial,
      subscribe: (callback: (settings: Record<string, any>) => void) => {
        listener = callback;
        return () => { listener = null; };
      },
    },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as PluginAPI;

  return {
    api,
    set,
    setMany,
    styles,
    updateSettings: (settings: Record<string, any>) => listener?.(settings),
  };
};

describe('WeRead 纯白正文背景黑度', () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    // 双清：先彻底清空（含前序同步测试迟到重建的 MutationObserver 残留面板），
    // 再设置干净的控件容器
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    history.replaceState({}, '', '/web/reader/test-book');
    document.body.innerHTML = '<div class="readerControls"></div>';
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('未设置背景档位时默认深黑', () => {
    const context = createAPI({ whiteText: true });
    teardown = setupStylePanel(context.api);

    const css = context.styles.get('wxrd-white-text');
    expect(css).toContain('background-color: #16171a !important');
  });

  it('阅读宽度默认关闭，可在 52% 到 98% 间按 2% 调节', () => {
    const context = createAPI();
    teardown = setupStylePanel(context.api);

    const slider = document.querySelector<HTMLInputElement>('input[data-key="wideWidthPercent"]');
    expect(slider?.min).toBe('52');
    expect(slider?.max).toBe('98');
    expect(slider?.step).toBe('2');
    expect(slider?.value).toBe('80');
    expect(document.querySelector('[data-output="wideWidthPercent"]')?.textContent).toBe('默认');
  });

  it('宽度值位于纯白正文下方、行间距上方', () => {
    const context = createAPI();
    teardown = setupStylePanel(context.api);

    const sections = Array.from(document.querySelectorAll('.wxrd-panel-section'))
      .map(section => section.textContent ?? '');
    expect(sections[0]).toContain('纯白正文');
    expect(sections[1]).toContain('阅读宽度');
    expect(sections[2]).toContain('行间距');
  });

  it('拖动时即时回显，松手后保存并启用自定义宽度', async () => {
    const context = createAPI();
    teardown = setupStylePanel(context.api);

    const slider = document.querySelector<HTMLInputElement>('input[data-key="wideWidthPercent"]')!;
    slider.value = '60';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector('[data-output="wideWidthPercent"]')?.textContent).toBe('60%');
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    // 目标值与「自定义宽度开」同一批写入：单次 setMany，避免两步链的中
    // 间态（多余一次重分页）与首步失败导致 readerWide 永不置位的静默无效
    expect(context.setMany).toHaveBeenCalledTimes(1);
    expect(context.setMany).toHaveBeenCalledWith({ wideWidthPercent: 60, readerWide: true });
    expect(context.set).not.toHaveBeenCalled();
  });

  it('注入的样式所有层同色同圆角，无直角缺口', () => {
    const context = createAPI({ whiteText: true, whiteTextBackground: '#18191b' });
    teardown = setupStylePanel(context.api);

    const css = context.styles.get('wxrd-white-text');
    // 五层容器全部上背景（含横排模式外层），圆角处才不会露出内层直角
    expect(css).toContain('.readerContent > .app_content:not(.app_content_in_reader)');
    expect(css).toContain('.wr_horizontalReader_app_content');
    expect(css).toContain('.readerChapterContent');
    expect(css).toContain('.renderTargetContainer');
    expect(css).toContain('.wr_canvasContainer');
    expect(css!.match(/background-color: #18191b !important/g)).toHaveLength(1);
    expect(css!.match(/border-radius: 16px !important/g)).toHaveLength(2);
  });

  it('点击背景档位写入对应色值且不联动文字亮度', async () => {
    const context = createAPI({ whiteText: true });
    teardown = setupStylePanel(context.api);

    document.querySelector<HTMLButtonElement>('button[data-value="#16171a"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(context.set).toHaveBeenCalledWith('whiteTextBackground', '#16171a');
    expect(context.set).not.toHaveBeenCalledWith('whiteTextBrightness', expect.anything());
  });

  it('持久化值经白名单校验，未知值回落默认深黑', () => {
    const context = createAPI({ whiteText: true, whiteTextBackground: 'red; color: transparent' });
    teardown = setupStylePanel(context.api);

    expect(context.styles.get('wxrd-white-text')).toContain('background-color: #16171a !important');
  });

  it('档位选中态回显当前设置', () => {
    const context = createAPI({ whiteText: true, whiteTextBackground: '#18191b' });
    teardown = setupStylePanel(context.api);

    const selected = document.querySelector('.wxrd-segments[data-key="whiteTextBackground"] button.wxrd-selected');
    expect(selected?.getAttribute('data-value')).toBe('#18191b');
  });

  it('恢复默认时清空背景档位', async () => {
    const context = createAPI({ whiteText: true, whiteTextBackground: '#16171a' });
    teardown = setupStylePanel(context.api);

    document.querySelector<HTMLButtonElement>('[data-action="reset-spacing"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    // 单次 setMany 提交全部 8 个键（替代 7 步链式 set）：任一环失败
    // 会留下部分应用状态且后续跳过
    expect(context.setMany).toHaveBeenCalledTimes(1);
    const patch = context.setMany.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch).toMatchObject({
      whiteText: false,
      whiteTextBackground: null,
      wideWidthPercent: 80,
      readerWide: false,
    });
    expect(context.set).not.toHaveBeenCalled();
  });

  describe('WeRead 底部进度条高度', () => {
    // 防御前序异步测试迟到触发的 MutationObserver 重建面板（重建面板的滑块无回显值）
    beforeEach(() => {
      document.querySelectorAll('.reader-font-control-panel-wrapper').forEach(e => e.remove());
    });

    it('未设置时保持原生观感，不注入覆盖样式', () => {
      const context = createAPI();
      teardown = setupStylePanel(context.api);

      expect(context.styles.has('wxrd-progress-height')).toBe(false);
      const slider = document.querySelector<HTMLInputElement>('input[data-key="progressBarHeight"]');
      expect(slider?.value).toBe('16');
      expect(document.querySelector('[data-output="progressBarHeight"]')?.textContent).toBe('16px');
    });

    it('设置后注入高度覆盖样式，非法值回落原生', () => {
      const context = createAPI({ progressBarHeight: 5 });
      teardown = setupStylePanel(context.api);
      expect(context.styles.get('wxrd-progress-height')).toContain('height: 5px !important');

      const bad = createAPI({ progressBarHeight: 99 });
      teardown = setupStylePanel(bad.api);
      expect(bad.styles.has('wxrd-progress-height')).toBe(false);
      document.querySelectorAll('#wxrd-style-panel').forEach(e => e.setAttribute('data-mark', 'from-bad-test'));
    });

    it('拖到 0 时注入零高度隐藏进度条', () => {
      const context = createAPI({ progressBarHeight: 0 });
      teardown = setupStylePanel(context.api);

      expect(context.styles.get('wxrd-progress-height')).toContain('height: 0px !important');
    });

    it('拖动松手后持久化高度值并回显', async () => {
      document.querySelectorAll('.reader-font-control-panel-wrapper').forEach(e => e.remove());
      const context = createAPI();
      teardown = setupStylePanel(context.api);

      const bars = [...document.querySelectorAll('input[data-key="progressBarHeight"]')];
      const slider = bars[bars.length - 1] as HTMLInputElement;
      slider.value = '8';
      slider.dispatchEvent(new Event('change', { bubbles: true }));

      expect(context.set).toHaveBeenCalledWith('progressBarHeight', 8);
      // 模拟设置广播后的回显（真实环境由 settings-updated 触发 syncControls）
      context.updateSettings({ progressBarHeight: 8 });
      expect(document.querySelector('[data-output="progressBarHeight"]')?.textContent).toBe('8px');
    });

    it('恢复默认写入 null 时不注入覆盖样式（Number(null) 陷阱回归）', () => {
      const context = createAPI({ progressBarHeight: null });
      teardown = setupStylePanel(context.api);

      expect(context.styles.has('wxrd-progress-height')).toBe(false);
      const slider = document.querySelector<HTMLInputElement>('input[data-key="progressBarHeight"]');
      expect(slider?.value).toBe('16');
      expect(document.querySelector('[data-output="progressBarHeight"]')?.textContent).toBe('16px');
    });

    it('恢复默认时清空进度高度', async () => {
      document.querySelectorAll('.reader-font-control-panel-wrapper').forEach(e => e.remove());
      const context = createAPI({ progressBarHeight: 8 });
      teardown = setupStylePanel(context.api);

      document.querySelector<HTMLButtonElement>('[data-action="reset-spacing"]')?.click();
      await new Promise(resolve => setTimeout(resolve, 0));

      const patch = context.setMany.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(patch?.progressBarHeight).toBeNull();
    });
  });
});
