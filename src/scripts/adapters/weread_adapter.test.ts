import { describe, expect, it } from 'bun:test';
import { WeReadAdapter } from './weread_adapter';

const createAdapter = (): WeReadAdapter => Object.create(WeReadAdapter.prototype) as WeReadAdapter;

describe('WeReadAdapter 宽屏宽度', () => {
  it('同步调整正文画布和顶部栏，并将工具栏固定在视口右侧', () => {
    const css = createAdapter().getWideModeCSS(true, 60);

    expect(css).toContain('.readerContent > .app_content:not(.app_content_in_reader)');
    expect(css).toContain('width: 60vw !important');
    expect(css).toContain('.wr_horizontalReader_app_content .readerChapterContent');
    expect(css).toContain('right: max(-72px, calc(24px - (100 - 60) / 2 * 1vw)) !important');
    expect(css).toContain('left: auto !important');
    expect(css).toContain('margin-left: 0 !important');
    expect(css).not.toContain('html body .app_content,');
    expect(css).not.toContain('calc(100vw - 224px)');
    expect(css).not.toContain('min(');
  });

  it('纵向（单栏）宽屏时工具栏随宽度移动：W=80 与窄屏公式完全重合', () => {
    const css = createAdapter().getWideModeCSS(true, 60);
    // 纵向工具栏规则按 W 参数化：margin-left = calc(W/2 % + 40px)
    expect(css).toContain('body:has(.readerControls:not([is-horizontal="true"])) .readerControls');
    expect(css).toContain('margin-left: calc(30% + 40px) !important');

    // W=80（默认值）时与窄屏分支真机校准的 calc(40% + 40px) 完全重合，开关切换不跳变
    const css80 = createAdapter().getWideModeCSS(true, 80);
    expect(css80).toContain('margin-left: calc(40% + 40px) !important');

    // 跨分支不变量：宽屏 W=80 的工具栏声明与窄屏分支逐字一致（编码为显式断言）
    const narrow = createAdapter().getWideModeCSS(false);
    const wide80Rule = css80.match(/margin-left: calc\(40% \+ 40px\) !important/)?.[0];
    const narrowRule = narrow.match(/margin-left: calc\(40% \+ 40px\) !important/)?.[0];
    expect(wide80Rule).toBeDefined();
    expect(narrowRule).toBeDefined();
    expect(wide80Rule).toBe(narrowRule);

    // 每个宽度生成不同的纵向公式（随滑块连续变化）
    for (const width of [52, 76, 98]) {
      expect(createAdapter().getWideModeCSS(true, width))
        .toContain(`margin-left: calc(${width / 2}% + 40px) !important`);
    }
  });

  it('52% 到 98% 的滑块值均生成真实且不同的视口宽度', () => {
    const adapter = createAdapter();

    for (const width of [52, 76, 90, 98]) {
      expect(adapter.getWideModeCSS(true, width)).toContain(`width: ${width}vw !important`);
      // 外贴边 + 停住：每个宽度生成对应的贴边位置，留白不足时渐进压向正文
      expect(adapter.getWideModeCSS(true, width)).toContain(`right: max(-72px, calc(24px - (100 - ${width}) / 2 * 1vw)) !important`);
    }
  });

  it('缺失或非法值回退到 80%', () => {
    const adapter = createAdapter();

    expect(adapter.getWideModeCSS(true)).toContain('80vw');
    expect(adapter.getWideModeCSS(true, 39)).toContain('80vw');
    expect(adapter.getWideModeCSS(true, 51)).toContain('80vw');
    expect(adapter.getWideModeCSS(true, 99)).toContain('80vw');
  });

  it('窄屏样式仍固定为原生 80%，并保留真机校准的纵向工具栏公式', () => {
    const css = createAdapter().getWideModeCSS(false, 98);

    expect(css).toContain('width: 80% !important');
    // 锚定窄屏分支的工具栏公式：宽屏 W=80 外推与它逐字重合（开关切换不跳变）。
    // 该行若被误删，宽屏侧断言依然全绿，但真机切开关即跳变——故双侧都要锚定
    expect(css).toContain('margin-left: calc(40% + 40px) !important');
  });

  it('显示工具栏时不再限制阅读区最大宽度', () => {
    const css = createAdapter().getToolbarCSS(false);

    expect(css).not.toContain('max-width: calc(100vw - 224px)');
  });

  it('隐藏工具栏时暂不启用 124px 最大宽度限制', () => {
    const css = createAdapter().getToolbarCSS(true);
    const activeCSS = css.replace(/\/\*[\s\S]*?\*\//g, '');

    expect(css).toContain('display: none !important');
    expect(css).toContain('/* max-width: calc(100vw - 124px) !important; */');
    expect(activeCSS).not.toContain('max-width: calc(100vw - 124px)');
  });

  it('保留宽屏模式菜单作为恢复默认布局的入口', () => {
    expect(createAdapter().getReaderMenuItems()).toContain('reader_wide');
  });
});
