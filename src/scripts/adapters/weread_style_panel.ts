/**
 * 微信读书阅读样式面板（issue #3 / #4）
 *
 * 右侧工具栏注入「样式」按钮，弹窗提供：
 * - 纯白正文（issue #3）：深色底（背景黑度三档）+ canvas brightness 提亮（微信读书暗色正文约
 *   RGB(155)；高亮档 2.2 提至纯白并锐化边缘，不可用 invert，反色后更暗）
 * - 行间距 / 段间距（issue #4）：命中已知正文类调整 DOM 排版层，
 *   微信读书随后将重排结果快照进 canvas。绝不粗粒度命中 #preRenderContent *，
 *   那会破坏预渲染/分页导致正文停在加载动画（issue 作者实测踩坑）。
 *
 * 设置经插件命名空间与站点偏好持久化（settings.json），
 * 样式变化走「单一控制点」applyReadingStyles 统一注入/移除。
 */

import type { PluginAPI } from '../core/plugin_types';
import {
  DEFAULT_WIDE_WIDTH_PERCENT,
  MAX_WIDE_WIDTH_PERCENT,
  MIN_WIDE_WIDTH_PERCENT,
  normalizeWideWidthPercent,
} from '../core/reader_width';

type LineHeightChoice = number | null;
type SpacingChoice = number | null;

/** 夜间正文背景档位：由浅到深排列（柔黑/深黑/纯黑）；柔黑需不亮于微信读书
 *  原生夜间底色（否则比不开启还白），深黑居中，纯黑最深；默认深黑。
 *  档位只换底色，文字亮度仍由独立三档控制，不做自动联动 */
const READING_BACKGROUND_PRESETS = [
  { label: '柔黑', value: '#18191b' },
  { label: '深黑', value: '#16171a' },
  { label: '纯黑', value: '#000000' },
] as const;
const DEFAULT_READING_BACKGROUND = '#16171a';

/** 背景档位白名单校验：持久化值只接受预设色；null/未知值回落深黑（默认档），
 *  防止被污染的存储值拼进 style 注入 */
const normalizeReadingBackground = (value: unknown): string =>
  READING_BACKGROUND_PRESETS.some(preset => preset.value === value)
    ? (value as string)
    : DEFAULT_READING_BACKGROUND;

/** 微信读书原生行距：官方 CSS 各 fontLevel 行高/字号比值恒定 ≈ 1.9
 *  （18/35、21/40、24/46、28/54、32/61、36/69、42/80，官方 wrwebnjlogic 9.css 实测） */
const DEFAULT_LINE_HEIGHT = 1.9;
/** 原生段间距：官方 p 规则 margin-bottom: 1em（相邻段折叠、末段归零） */
const DEFAULT_PARAGRAPH_SPACING = 1.0;

/** 底部进度条高度（px）：0 隐藏，16 为注入层默认高度；null/undefined 表示未设置
 *  （保持原生观感，不注入覆盖样式）。注意不可依赖 Number 隐式转换——Number(null) === 0
 *  会把「清除设置」误判为「高度 0」导致进度条消失 */
const DEFAULT_PROGRESS_BAR_HEIGHT = 16;
const normalizeProgressBarHeight = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > DEFAULT_PROGRESS_BAR_HEIGHT) return undefined;
  return numeric;
};

/** 官方正文段落选择器：测量层 preRenderContent + 渲染层 renderTargetContent 的 p，
 *  canvas 由测量层 DOM 快照而来，两者必须同步改。issue #4 时代的 .content/.quotation
 *  类名在当前版本已不存在（官方 CSS 无此规则），命中不了是上一版不生效的根因。 */
const CONTENT_PARAGRAPH_SELECTOR = [
  '.readerChapterContent .preRenderContent p',
  '.readerChapterContent .renderTargetContent p',
].join(',\n        ');

const STYLE_BUTTON_ID = 'wxrd-style-button';
const STYLE_PANEL_ID = 'wxrd-style-panel';

export const setupStylePanel = (api: PluginAPI): (() => void) => {
  const log = api.log;
  let teardown: (() => void) | null = null;
  let disposed = false;

  const ensureButton = (): void => {
    if (disposed) return;
    if (teardown) {
      // 按钮可能随 SPA 路由被移除，不在时重新注入
      if (document.getElementById(STYLE_BUTTON_ID)) return;
      teardown();
      teardown = null;
    }
    if (!location.pathname.includes('/web/reader/')) return;
    const controls = document.querySelector('.readerControls');
    if (!controls) return;
    teardown = mountPanel(api);
    log.info('[WeRead] 阅读样式面板已注入');
  };

  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();

  return () => {
    disposed = true;
    observer.disconnect();
    teardown?.();
    teardown = null;
  };
};

const mountPanel = (api: PluginAPI): (() => void) => {
  const settings = api.settings;

  const button = document.createElement('button');
  button.id = STYLE_BUTTON_ID;
  button.type = 'button';
  button.title = '阅读样式';
  button.className = 'readerControls_item';
  button.setAttribute('aria-label', '阅读样式');
  button.innerHTML = `
    <span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4.5" width="2" height="2" rx="1"/>
      <rect x="7" y="3" width="4" height="5" rx="1.5"/>
      <rect x="12" y="4.5" width="8" height="2" rx="1"/>
      <rect x="4" y="11" width="8" height="2" rx="1"/>
      <rect x="13" y="9.5" width="4" height="5" rx="1.5"/>
      <rect x="18" y="11" width="2" height="2" rx="1"/>
      <rect x="4" y="17.5" width="2" height="2" rx="1"/>
      <rect x="7" y="16" width="4" height="5" rx="1.5"/>
      <rect x="12" y="17.5" width="8" height="2" rx="1"/>
    </svg></span>`;

  const panel = document.createElement('div');
  panel.id = STYLE_PANEL_ID;
  // 外壳复用微信读书字体面板类（font-panel-content 系）获得原生视觉，
  // 定位由 wxrd 面板类接管（fixed 到工具栏左侧）
  panel.className = 'font-panel-content';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="font-panel-content-inner">
    <div class="font-panel-content-title">阅读样式</div>
    <div class="wxrd-panel-section">
      <label class="wxrd-toggle">
        <input type="checkbox" data-key="whiteText">
        <span>纯白正文</span>
      </label>
      <div class="wxrd-field" data-row="brightness">
        <span>文字亮度</span>
        <div class="wxrd-segments" data-key="whiteTextBrightness">
          <button type="button" data-value="1.1">柔和</button>
          <button type="button" data-value="1.35">标准</button>
          <button type="button" data-value="2.2">高亮</button>
        </div>
      </div>
      <div class="wxrd-field" data-row="background">
        <span>背景黑度</span>
        <div class="wxrd-segments" data-key="whiteTextBackground">
          ${READING_BACKGROUND_PRESETS.map(preset => `<button type="button" data-value="${preset.value}">${preset.label}</button>`).join('')}
        </div>
      </div>
      <p class="wxrd-hint">夜间：深色底 + 提亮文字；日间：无效；插图同步提亮</p>
    </div>
    <div class="wxrd-panel-section">
      <div class="wxrd-field">
        <span>阅读宽度 <output data-output="wideWidthPercent"></output></span>
        <input type="range" data-key="wideWidthPercent" min="${MIN_WIDE_WIDTH_PERCENT}" max="${MAX_WIDE_WIDTH_PERCENT}" step="2">
      </div>
      <div class="wxrd-field">
        <span>进度高度 <output data-output="progressBarHeight"></output></span>
        <input type="range" data-key="progressBarHeight" min="0" max="${DEFAULT_PROGRESS_BAR_HEIGHT}" step="1">
      </div>
    </div>
    <div class="wxrd-panel-section">
      <div class="wxrd-field">
        <span>行间距 <output data-output="lineHeight"></output></span>
        <input type="range" data-key="lineHeight" min="1.4" max="2.6" step="0.05">
      </div>
      <div class="wxrd-field">
        <span>段间距 <output data-output="paragraphSpacing"></output></span>
        <input type="range" data-key="paragraphSpacing" min="0" max="2" step="0.1">
      </div>
      <button type="button" class="wxrd-reset" data-action="reset-spacing">全部恢复默认</button>
    </div>
    </div>`;

  const controls = document.querySelector('.readerControls');
  controls?.append(button);
  // 官方同构：字体弹窗 = .readerControls 内的 reader-font-control-panel-wrapper
  // > .font-panel-content，定位（absolute bottom/right）与视觉全部由微信读书
  // 自身 CSS 生效，随布局引擎自动同步（resize 不飘移）
  const wrapper = document.createElement('div');
  wrapper.className = 'reader-font-control-panel-wrapper';
  wrapper.append(panel);
  controls?.append(wrapper);

  const closeOnOutside = (event: MouseEvent): void => {
    if (panel.hidden) return;
    if (panel.contains(event.target as Node) || button.contains(event.target as Node)) return;
    setPanelOpen(false);
  };

  const toggleButton = (): void => setPanelOpen(panel.hidden);

  const setPanelOpen = (open: boolean): void => {
    panel.hidden = !open;
    button.classList.toggle('wxrd-active', open);
    button.setAttribute('aria-expanded', String(open));
  };

  button.addEventListener('click', toggleButton);
  document.addEventListener('click', closeOnOutside, true);

  // ==================== 控件 → 设置（唯一写入口） ====================

  const whiteTextInput = panel.querySelector<HTMLInputElement>('input[data-key="whiteText"]')!;
  whiteTextInput.addEventListener('change', () => {
    void settings.set('whiteText', whiteTextInput.checked);
  });

  // 亮度档位（柔和/标准/高亮）：夜间 canvas 提亮倍数
  panel.querySelector('.wxrd-segments[data-key="whiteTextBrightness"]')
    ?.addEventListener('click', (event) => {
      const value = (event.target as HTMLElement).closest('button')?.dataset.value;
      if (!value) return;
      void settings.set('whiteTextBrightness', Number(value));
    });

  // 背景黑度档位（纯黑/深黑/柔黑）：夜间正文底色，与文字亮度相互独立
  panel.querySelector('.wxrd-segments[data-key="whiteTextBackground"]')
    ?.addEventListener('click', (event) => {
      const value = (event.target as HTMLElement).closest('button')?.dataset.value;
      if (!value) return;
      void settings.set('whiteTextBackground', value);
    });

  panel.querySelectorAll<HTMLInputElement>('input[type="range"][data-key]').forEach(slider => {
    const key = slider.dataset.key!;
    slider.addEventListener('input', () => {
      if (key !== 'wideWidthPercent' && key !== 'progressBarHeight') return;
      const output = panel.querySelector(`[data-output="${key}"]`);
      if (output) output.textContent = key === 'wideWidthPercent' ? `${slider.value}%` : `${slider.value}px`;
    });
    // change（松手）才写入：微信读书重分页成本高，拖动中不反复触发 resize
    slider.addEventListener('change', () => {
      const value = Number(slider.value);
      if (key === 'wideWidthPercent') {
        // 滑块代表显式选择：目标值与「自定义宽度开」同一批写入，避免两步链
        // 中间态（多一次重分页）与首步失败导致 readerWide 永不置位的静默无效
        void settings.setMany({ wideWidthPercent: value, readerWide: true });
        return;
      }
      void settings.set(key, value);
    });
  });

  panel.querySelector('[data-action="reset-spacing"]')?.addEventListener('click', () => {
    // 恢复默认 = 清空本面板全部设置（含纯白正文），回到微信读书原生观感。
    // 单次 setMany（site 段一写 + config 段一写）替代 7 步链式 set：
    // 链上任一环失败会留下部分应用状态且后续全部跳过
    void settings.setMany({
      whiteText: false,
      whiteTextBrightness: 1.35,
      whiteTextBackground: null,
      readerWide: false,
      wideWidthPercent: DEFAULT_WIDE_WIDTH_PERCENT,
      progressBarHeight: null,
      lineHeight: null,
      paragraphSpacing: null,
    });
  });

  // ==================== 设置 → 样式（单一控制点） ====================

  const applyReadingStyles = (config: Record<string, any>): void => {
    const whiteText = config.whiteText === true;
    if (whiteText) {
      const brightness = Number(config.whiteTextBrightness ?? 1.35) || 1.35;
      const background = normalizeReadingBackground(config.whiteTextBackground);
      // 夜间（无 wr_whiteTheme）：可选深色底 + canvas 提亮（155 灰 → 255 白）；
      // 日间（wr_whiteTheme）：纯白背景即可，正文 #0d141e 本已近黑（PS 吸管实测）
      // 不覆盖 body 背景：正文卡片与页面底色保留色差。
      // 五层容器必须同色同圆角：少注色一层，外层原生圆角缺口处会露出内层
      // 直角色块；各层同色后圆弧缝隙不可见，也无需 overflow:hidden（避免裁掉
      // 微信读书浮动 UI）。外层两个容器来自横排模式实测（app_content 系）。
      api.style.inject('wxrd-white-text', `
        body:not(.wr_whiteTheme) .readerContent > .app_content:not(.app_content_in_reader),
        body:not(.wr_whiteTheme) .wr_horizontalReader_app_content,
        body:not(.wr_whiteTheme) .readerChapterContent,
        body:not(.wr_whiteTheme) .renderTargetContainer,
        body:not(.wr_whiteTheme) .wr_canvasContainer {
          background-color: ${background} !important;
          border-radius: 16px !important;
        }
        body:not(.wr_whiteTheme) .wr_canvasContainer canvas {
          filter: brightness(${brightness}) !important;
        }
        body.wr_whiteTheme .readerContent > .app_content:not(.app_content_in_reader),
        body.wr_whiteTheme .wr_horizontalReader_app_content,
        body.wr_whiteTheme .readerChapterContent,
        body.wr_whiteTheme .renderTargetContainer,
        body.wr_whiteTheme .wr_canvasContainer {
          background-color: #fff !important;
          border-radius: 16px !important;
        }`);
    } else {
      api.style.remove('wxrd-white-text');
    }

    const progressBarHeight = normalizeProgressBarHeight(config.progressBarHeight);
    if (progressBarHeight !== undefined) {
      // 底部进度条高度覆盖：0 = 隐藏；全局注入使进度条 DOM 重建后依然命中
      api.style.inject('wxrd-progress-height', `
        #wxrd-progress-bar-container {
          height: ${progressBarHeight}px !important;
        }`);
    } else {
      api.style.remove('wxrd-progress-height');
    }

    const lineHeight = (config.lineHeight ?? null) as LineHeightChoice;
    const paragraphSpacing = (config.paragraphSpacing ?? null) as SpacingChoice;
    if (lineHeight !== null || paragraphSpacing !== null) {
      const lineHeightCss = lineHeight !== null
        ? `line-height: ${lineHeight} !important;`
        : '';
      // 官方段间距语义 = p 的 margin-bottom（相邻段折叠、末段归零），不用 margin-top
      const spacingCss = paragraphSpacing !== null
        ? `margin-bottom: ${paragraphSpacing}em !important;`
        : '';
      // 只命中正文段落：粗粒度 #preRenderContent * 会卡死预渲染（issue #4 实测）
      api.style.inject('wxrd-reading-spacing', `
        ${CONTENT_PARAGRAPH_SELECTOR} {
          ${lineHeightCss}
          ${spacingCss}
        }
        .readerChapterContent .preRenderContent p:last-child,
        .readerChapterContent .renderTargetContent p:last-child {
          margin-bottom: 0 !important;
        }`);
      // 触发微信读书重新分页（事件驱动，无延迟等待）
      window.dispatchEvent(new Event('resize'));
    } else {
      api.style.remove('wxrd-reading-spacing');
    }

    syncControls(config);
  };

  /** 控件状态回显当前设置 */
  const syncControls = (config: Record<string, any>): void => {
    whiteTextInput.checked = config.whiteText === true;
    panel.dataset.whiteText = config.whiteText === true ? 'on' : 'off';
    const brightness = String(config.whiteTextBrightness ?? 1.35);
    const brightnessGroup = panel.querySelector<HTMLElement>('.wxrd-segments[data-key="whiteTextBrightness"]');
    brightnessGroup?.querySelectorAll('button').forEach(item => {
      item.classList.toggle('wxrd-selected', item.dataset.value === brightness);
    });
    const background = normalizeReadingBackground(config.whiteTextBackground);
    const backgroundGroup = panel.querySelector<HTMLElement>('.wxrd-segments[data-key="whiteTextBackground"]');
    backgroundGroup?.querySelectorAll('button').forEach(item => {
      item.classList.toggle('wxrd-selected', item.dataset.value === background);
    });
    const defaults: Record<string, number> = {
      wideWidthPercent: DEFAULT_WIDE_WIDTH_PERCENT,
      progressBarHeight: DEFAULT_PROGRESS_BAR_HEIGHT,
      lineHeight: DEFAULT_LINE_HEIGHT,
      paragraphSpacing: DEFAULT_PARAGRAPH_SPACING,
    };
    panel.querySelectorAll<HTMLInputElement>('input[type="range"][data-key]').forEach(slider => {
      const key = slider.dataset.key!;
      const rawValue = config[key] ?? defaults[key];
      const value = key === 'wideWidthPercent'
        ? normalizeWideWidthPercent(rawValue)
        : key === 'progressBarHeight'
          ? (normalizeProgressBarHeight(rawValue) ?? DEFAULT_PROGRESS_BAR_HEIGHT)
          : rawValue;
      slider.value = String(value);
      const output = panel.querySelector(`[data-output="${key}"]`);
      if (output) {
        output.textContent = key === 'wideWidthPercent' && config.readerWide !== true
          ? '默认'
          : key === 'paragraphSpacing'
            ? `${value}em`
            : key === 'progressBarHeight'
              ? `${value}px`
              : key === 'wideWidthPercent'
                ? `${value}%`
                : String(value);
      }
    });
  };

  const unsubscribe = settings.subscribe(applyReadingStyles);
  applyReadingStyles(settings.getAll());

  // 面板样式（独立注入，随面板卸载移除）
  api.style.inject('wxrd-style-panel-ui', PANEL_UI_CSS);

  return () => {
    unsubscribe();
    button.removeEventListener('click', toggleButton);
    document.removeEventListener('click', closeOnOutside, true);
    button.remove();
    wrapper.remove();
    api.style.remove('wxrd-style-panel-ui');
    api.style.remove('wxrd-white-text');
    api.style.remove('wxrd-progress-height');
    api.style.remove('wxrd-reading-spacing');
  };
};

const PANEL_UI_CSS = `
/* 按钮与面板外壳均由微信读书官方 CSS 生效：
   .readerControls_item（48px 圆钮、主题底色、hover）
   .reader-font-control-panel-wrapper .font-panel-content（absolute 定位、
   440px、16px 圆角、#262628/#f4f5f7 主题底、阴影、底部对齐随布局同步）。
   此处只补 icon 槽位换 SVG 与面板内部控件。 */
#wxrd-style-button .icon {
  background: none !important;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* 图标四态色值 = 官方雪碧图 PNG 逐像素采样（icon_reader_catalogue_*）：
   夜间 #8c8c8e / hover #f0f0f2；日间 #858c96 / hover #212832（蓝灰系，非纯灰） */
#wxrd-style-button .icon svg {
  width: 22px;
  height: 22px;
  fill: #8c8c8e;
  transition: fill .2s;
}
.wr_whiteTheme #wxrd-style-button .icon svg {
  fill: #858c96;
}
#wxrd-style-button:hover .icon svg {
  fill: #f0f0f2;
}
.wr_whiteTheme #wxrd-style-button:hover .icon svg {
  fill: #212832;
}

/* 面板内容文字色对齐官方（title 官方已管：#eef0f4 / #212832） */
#wxrd-style-panel {
  color: #eef0f4;
  /* 官方外壳 padding:0 18px 24px，底部 24px 在本面板尾按钮下显得空，收窄 */
  padding-bottom: 12px;
}
.wr_whiteTheme #wxrd-style-panel {
  color: #212832;
}
#wxrd-style-panel .font-panel-content-inner {
  padding: 20px 4px 4px;
}

/* 内部控件 */
#wxrd-style-panel .wxrd-panel-section {
  padding: 14px 0 10px;
  border-top: 1px solid rgba(128, 128, 128, .22);
}
#wxrd-style-panel .wxrd-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 15px;
}
#wxrd-style-panel .wxrd-toggle input { accent-color: currentColor; width: 16px; height: 16px; }
#wxrd-style-panel .wxrd-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 18px;
  font-size: 14px;
}
#wxrd-style-panel .wxrd-field > span {
  display: flex;
  justify-content: space-between;
  opacity: .72;
}
#wxrd-style-panel .wxrd-field output { opacity: 1; }
#wxrd-style-panel input[type="range"] {
  width: 100%;
  accent-color: currentColor;
  margin: 0;
}
#wxrd-style-panel .wxrd-segments {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}
#wxrd-style-panel .wxrd-segments button {
  flex: 1;
  padding: 4px 0;
  border: 1px solid rgba(128, 128, 128, .35);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}
#wxrd-style-panel .wxrd-segments button.wxrd-selected {
  background: rgba(128, 128, 128, .25);
  border-color: rgba(128, 128, 128, .6);
}
#wxrd-style-panel .wxrd-hint {
  margin: 10px 0 0;
  font-size: 12px;
  opacity: .55;
}
#wxrd-style-panel .wxrd-reset {
  width: 100%;
  margin-top: 18px;
  padding: 6px 0;
  border: 1px solid rgba(128, 128, 128, .35);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 14px;
  cursor: pointer;
}
#wxrd-style-panel .wxrd-reset:hover { background: rgba(128, 128, 128, .12); }
#wxrd-style-panel .wxrd-field[data-row="brightness"],
#wxrd-style-panel .wxrd-field[data-row="background"] { margin-top: 10px; }
#wxrd-style-panel:not([data-white-text="on"]) .wxrd-field[data-row="brightness"],
#wxrd-style-panel:not([data-white-text="on"]) .wxrd-field[data-row="background"],
#wxrd-style-panel:not([data-white-text="on"]) .wxrd-hint {
  display: none;
}`;
