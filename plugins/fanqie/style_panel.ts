/*!
 * 番茄小说「阅读样式」面板
 *
 * 把微信读书内置插件的样式按钮移植到番茄原生工具栏，并按番茄 DOM 渲染适配：
 * - 纯白正文开关 + 文字亮度三档 + 背景黑度三档（仅深色主题生效，直接定色，
 *   不用微信读书那套 canvas brightness 滤镜）。
 * - 行间距 / 段间距滑杆，默认值取番茄原生（行距 2.0、段距 1em）。
 * - 不含阅读宽度 / 进度高度（番茄由自身能力控制）。
 * 按钮 / 弹框 / 组件样式对照番茄原生工具栏（.reader-toolbar-item /
 * .font-slider-popover）取样复刻。设置存 pluginConfigs.fanqie。
 */

import type { PluginAPI } from '../../src/scripts/core/plugin_types';

const STYLE_BUTTON_ID = 'atreader-fanqie-style-button';
const STYLE_PANEL_ID = 'atreader-fanqie-style-panel';
const STYLE_UI_ID = 'fanqie-style-panel-ui';
const STYLE_READING_ID = 'fanqie-style-reading';
const STYLE_SPACING_ID = 'fanqie-style-spacing';

// 文字亮度档位 → 深色正文文字色（直接定值，默认标准）。
const TEXT_BRIGHTNESS_PRESETS = [
  { label: '柔和', value: 1.1 },
  { label: '标准', value: 1.35 },
  { label: '高亮', value: 2.2 },
] as const;
const DEFAULT_TEXT_BRIGHTNESS = 1.35;
const TEXT_BRIGHTNESS_COLORS: Record<number, string> = {
  1.1: '#9a9a9a',
  1.35: '#d8d8d8',
  2.2: '#ffffff',
};

// 背景黑度档位 → 深色书页底色（直接定值，默认深黑）。
const READING_BACKGROUND_PRESETS = [
  { label: '柔黑', value: '#232428' },
  { label: '深黑', value: '#16171a' },
  { label: '纯黑', value: '#000000' },
] as const;
const DEFAULT_READING_BACKGROUND = '#16171a';
const normalizeReadingBackground = (value: unknown): string =>
  READING_BACKGROUND_PRESETS.some(preset => preset.value === value)
    ? (value as string)
    : DEFAULT_READING_BACKGROUND;

// 番茄原生默认：正文 line-height 32px / font-size 16px = 2.0；段距 margin-bottom 1em。
const DEFAULT_LINE_HEIGHT = 2.0;
const DEFAULT_PARAGRAPH_SPACING = 1.0;

const isDarkTheme = (): boolean =>
  document.documentElement.getAttribute('muye-data-theme') === 'dark';

// 高特异性前缀：压过 reader.css 的 body.atreader-fanqie-paged .muye-reader-content p。
const CONTENT_P = 'html body .muye-reader-box .muye-reader-content p';
const CONTENT_BOX = 'html body .muye-reader-box';

const STYLE_BUTTON_ICON = `
  <svg class="reader-toolbar-item-icon" width="24" height="24" viewBox="0 0 24 24"
    fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5"
      stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="16" cy="7" r="2.1" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="8" cy="12" r="2.1" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="13" cy="17" r="2.1" stroke="currentColor" stroke-width="1.6"/>
  </svg>`;

export const setupFanqieStylePanel = (api: PluginAPI): (() => void) => {
  let disposed = false;
  let teardownPanel: (() => void) | null = null;

  const ensureButton = (): void => {
    if (disposed) return;
    if (teardownPanel) {
      if (document.getElementById(STYLE_BUTTON_ID)) return;
      teardownPanel();
      teardownPanel = null;
    }
    if (!location.pathname.includes('/reader/')) return;
    const host = document.querySelector('.reader-toolbar > div');
    if (!host) return;
    teardownPanel = mountPanel(api, host);
  };

  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();

  return () => {
    disposed = true;
    observer.disconnect();
    teardownPanel?.();
    teardownPanel = null;
  };
};

const mountPanel = (api: PluginAPI, host: Element): (() => void) => {
  const settings = api.settings;

  const button = document.createElement('div');
  button.id = STYLE_BUTTON_ID;
  button.className = 'reader-toolbar-item atreader-fanqie-style-toggle';
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  button.setAttribute('aria-label', '阅读样式');
  button.innerHTML = `${STYLE_BUTTON_ICON}<div>样式</div>`;

  const panel = document.createElement('div');
  panel.id = STYLE_PANEL_ID;
  panel.hidden = true;
  panel.innerHTML = `
    <div class="fq-style-title">阅读样式</div>
    <div class="fq-style-section">
      <label class="fq-toggle">
        <input type="checkbox" data-key="whiteText">
        <span class="fq-toggle-track"><span class="fq-toggle-thumb"></span></span>
        <span class="fq-toggle-label">纯白正文</span>
      </label>
      <div class="fq-field" data-row="brightness">
        <span>文字亮度</span>
        <div class="fq-segments" data-key="whiteTextBrightness">
          ${TEXT_BRIGHTNESS_PRESETS.map(p => `<button type="button" data-value="${p.value}">${p.label}</button>`).join('')}
        </div>
      </div>
      <div class="fq-field" data-row="background">
        <span>背景黑度</span>
        <div class="fq-segments" data-key="whiteTextBackground">
          ${READING_BACKGROUND_PRESETS.map(p => `<button type="button" data-value="${p.value}">${p.label}</button>`).join('')}
        </div>
      </div>
      <p class="fq-hint">仅深色主题生效</p>
    </div>
    <div class="fq-style-section">
      <div class="fq-field">
        <span>行间距 <output data-output="lineHeight"></output></span>
        <input type="range" data-key="lineHeight" min="1.4" max="2.6" step="0.05">
      </div>
      <div class="fq-field">
        <span>段间距 <output data-output="paragraphSpacing"></output></span>
        <input type="range" data-key="paragraphSpacing" min="0" max="2" step="0.1">
      </div>
      <button type="button" class="fq-reset" data-action="reset">恢复默认</button>
    </div>`;

  // 按钮与弹框包一层相对定位容器，弹框向工具栏左侧展开（同番茄字号弹层方向）。
  const wrap = document.createElement('div');
  wrap.className = 'atreader-fanqie-style-wrap';
  wrap.append(button, panel);
  host.append(wrap);

  const setPanelOpen = (open: boolean): void => {
    panel.hidden = !open;
    button.classList.toggle('atreader-active', open);
    button.setAttribute('aria-expanded', String(open));
  };
  const togglePanel = (): void => setPanelOpen(panel.hidden);
  button.addEventListener('click', togglePanel);
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      togglePanel();
    }
  });
  const closeOnOutside = (event: MouseEvent): void => {
    if (panel.hidden) return;
    if (panel.contains(event.target as Node) || button.contains(event.target as Node)) return;
    setPanelOpen(false);
  };
  document.addEventListener('click', closeOnOutside, true);

  // ==================== 设置 → 样式 ====================

  const applyReadingStyles = (config: Record<string, any>): void => {
    const dark = isDarkTheme();
    if (config.whiteText === true && dark) {
      const textColor = TEXT_BRIGHTNESS_COLORS[Number(config.whiteTextBrightness ?? DEFAULT_TEXT_BRIGHTNESS)]
        ?? TEXT_BRIGHTNESS_COLORS[DEFAULT_TEXT_BRIGHTNESS];
      const background = normalizeReadingBackground(config.whiteTextBackground);
      api.style.inject(STYLE_READING_ID, `
        ${CONTENT_BOX}, ${CONTENT_BOX} .muye-reader-content {
          background-color: ${background} !important;
        }
        ${CONTENT_BOX} .muye-reader-content, ${CONTENT_P} {
          color: ${textColor} !important;
        }`);
    } else {
      api.style.remove(STYLE_READING_ID);
    }

    // 行距 / 段距始终应用（默认即番茄原生值），高特异性压过 reader.css 硬编码。
    const lineHeight = Number(config.lineHeight ?? DEFAULT_LINE_HEIGHT) || DEFAULT_LINE_HEIGHT;
    const paragraphSpacing = Number(config.paragraphSpacing ?? DEFAULT_PARAGRAPH_SPACING);
    const spacing = Number.isFinite(paragraphSpacing) ? paragraphSpacing : DEFAULT_PARAGRAPH_SPACING;
    api.style.inject(STYLE_SPACING_ID, `
      ${CONTENT_P} {
        line-height: ${lineHeight} !important;
        margin-top: 0 !important;
        margin-bottom: ${spacing}em !important;
      }`);

    syncControls(config);
  };

  const syncControls = (config: Record<string, any>): void => {
    const whiteTextInput = panel.querySelector<HTMLInputElement>('input[data-key="whiteText"]');
    if (whiteTextInput) whiteTextInput.checked = config.whiteText === true;
    panel.dataset.whiteText = config.whiteText === true ? 'on' : 'off';

    const brightness = String(config.whiteTextBrightness ?? DEFAULT_TEXT_BRIGHTNESS);
    panel.querySelector('.fq-segments[data-key="whiteTextBrightness"]')
      ?.querySelectorAll('button').forEach(item => {
        item.classList.toggle('fq-selected', item.dataset.value === brightness);
      });
    const background = normalizeReadingBackground(config.whiteTextBackground);
    panel.querySelector('.fq-segments[data-key="whiteTextBackground"]')
      ?.querySelectorAll('button').forEach(item => {
        item.classList.toggle('fq-selected', item.dataset.value === background);
      });

    const defaults: Record<string, number> = {
      lineHeight: DEFAULT_LINE_HEIGHT,
      paragraphSpacing: DEFAULT_PARAGRAPH_SPACING,
    };
    panel.querySelectorAll<HTMLInputElement>('input[type="range"][data-key]').forEach(slider => {
      const key = slider.dataset.key!;
      const value = Number(config[key] ?? defaults[key]);
      slider.value = String(value);
      const output = panel.querySelector(`[data-output="${key}"]`);
      if (output) output.textContent = key === 'paragraphSpacing' ? `${value}em` : String(value);
    });
  };

  // ==================== 控件 → 设置 ====================

  panel.querySelector<HTMLInputElement>('input[data-key="whiteText"]')
    ?.addEventListener('change', (event) => {
      void settings.set('whiteText', (event.currentTarget as HTMLInputElement).checked);
    });

  panel.querySelector('.fq-segments[data-key="whiteTextBrightness"]')
    ?.addEventListener('click', (event) => {
      const value = (event.target as HTMLElement).closest('button')?.dataset.value;
      if (!value) return;
      void settings.set('whiteTextBrightness', Number(value));
    });

  panel.querySelector('.fq-segments[data-key="whiteTextBackground"]')
    ?.addEventListener('click', (event) => {
      const value = (event.target as HTMLElement).closest('button')?.dataset.value;
      if (!value) return;
      void settings.set('whiteTextBackground', value);
    });

  panel.querySelectorAll<HTMLInputElement>('input[type="range"][data-key]').forEach(slider => {
    const key = slider.dataset.key!;
    slider.addEventListener('input', () => {
      const output = panel.querySelector(`[data-output="${key}"]`);
      if (output) output.textContent = key === 'paragraphSpacing' ? `${slider.value}em` : slider.value;
    });
    slider.addEventListener('change', () => {
      void settings.set(key, Number(slider.value));
    });
  });

  panel.querySelector('[data-action="reset"]')?.addEventListener('click', () => {
    void settings.setMany({
      whiteText: false,
      whiteTextBrightness: DEFAULT_TEXT_BRIGHTNESS,
      whiteTextBackground: null,
      lineHeight: null,
      paragraphSpacing: null,
    });
  });

  const unsubscribe = settings.subscribe(applyReadingStyles);

  // 番茄主题切换（html[muye-data-theme]）可能不整页刷新，轻量轮询比对重跑。
  let lastDark = isDarkTheme();
  const themeWatcher = setInterval(() => {
    const next = isDarkTheme();
    if (next !== lastDark) {
      lastDark = next;
      applyReadingStyles(settings.getAll());
    }
  }, 800);

  applyReadingStyles(settings.getAll());
  api.style.inject(STYLE_UI_ID, PANEL_CSS);

  return () => {
    clearInterval(themeWatcher);
    unsubscribe();
    button.removeEventListener('click', togglePanel);
    document.removeEventListener('click', closeOnOutside, true);
    wrap.remove();
    api.style.remove(STYLE_UI_ID);
    api.style.remove(STYLE_READING_ID);
    api.style.remove(STYLE_SPACING_ID);
  };
};

/// 供菜单「阅读 → 阅读样式」调用：面板未开时点击工具栏样式按钮打开。
/// 与微信读书 openReadingStyle 同构（按钮存在即返回 true，能力据此点亮菜单）。
export const openFanqieStylePanel = (): boolean => {
  const button = document.getElementById(STYLE_BUTTON_ID) as HTMLButtonElement | null;
  if (!button) return false;
  const panel = document.getElementById(STYLE_PANEL_ID) as HTMLElement | null;
  if (!panel || panel.hidden) button.click();
  return true;
};

// 面板样式：对照番茄原生工具栏取样（浅底 #fafafa / 深色 #262626、圆角 8px、
// 文字浅 #252525 / 深 #b3b3b3、滑杆粗圆轨道 rgba(0,0,0,.05)）。
const PANEL_CSS = `
.atreader-fanqie-style-wrap { position: relative; }
.atreader-fanqie-style-toggle { cursor: pointer; }
.atreader-fanqie-style-toggle.atreader-active { color: #eb5a46; }

#${STYLE_PANEL_ID} {
  position: absolute;
  right: calc(100% + 12px);
  top: 50%;
  transform: translateY(-50%);
  width: 268px;
  padding: 16px;
  border-radius: 8px;
  background: #fafafa;
  color: #252525;
  box-shadow: 0 2px 12px rgba(0, 0, 0, .08);
  z-index: 1000;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
html[muye-data-theme="dark"] #${STYLE_PANEL_ID} {
  background: #262626;
  color: #b3b3b3;
  box-shadow: 0 2px 12px rgba(0, 0, 0, .4);
}
#${STYLE_PANEL_ID} .fq-style-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
}
#${STYLE_PANEL_ID} .fq-style-section {
  padding: 12px 0;
  border-top: 1px solid rgba(0, 0, 0, .06);
}
html[muye-data-theme="dark"] #${STYLE_PANEL_ID} .fq-style-section {
  border-top-color: rgba(255, 255, 255, .08);
}
#${STYLE_PANEL_ID} .fq-style-section:first-of-type { border-top: 0; padding-top: 0; }
#${STYLE_PANEL_ID} .fq-field { margin-bottom: 12px; }
#${STYLE_PANEL_ID} .fq-field > span {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  margin-bottom: 8px;
}
#${STYLE_PANEL_ID} .fq-field output { opacity: .6; }

/* 纯白正文开关 */
#${STYLE_PANEL_ID} .fq-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  margin-bottom: 12px;
  font-size: 12px;
}
#${STYLE_PANEL_ID} .fq-toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; }
#${STYLE_PANEL_ID} .fq-toggle-track {
  width: 36px; height: 20px; padding: 2px; border-radius: 20px;
  background: rgba(0, 0, 0, .15); transition: background .16s; flex: none;
}
html[muye-data-theme="dark"] #${STYLE_PANEL_ID} .fq-toggle-track { background: rgba(255, 255, 255, .2); }
#${STYLE_PANEL_ID} .fq-toggle-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .25); transition: transform .16s;
}
#${STYLE_PANEL_ID} .fq-toggle input:checked + .fq-toggle-track { background: #eb5a46; }
#${STYLE_PANEL_ID} .fq-toggle input:checked + .fq-toggle-track .fq-toggle-thumb { transform: translateX(16px); }

/* 分段档位 */
#${STYLE_PANEL_ID} .fq-segments { display: flex; gap: 6px; }
#${STYLE_PANEL_ID} .fq-segments button {
  flex: 1; padding: 7px 0; border: 0; border-radius: 6px;
  background: rgba(0, 0, 0, .05); color: inherit; cursor: pointer;
  font-size: 12px; transition: background .16s, color .16s;
}
html[muye-data-theme="dark"] #${STYLE_PANEL_ID} .fq-segments button { background: rgba(255, 255, 255, .08); }
#${STYLE_PANEL_ID} .fq-segments button.fq-selected { background: #eb5a46; color: #fff; }
#${STYLE_PANEL_ID} .fq-hint { margin: 4px 0 0; font-size: 11px; opacity: .5; }
#${STYLE_PANEL_ID}:not([data-white-text="on"]) .fq-field[data-row="brightness"],
#${STYLE_PANEL_ID}:not([data-white-text="on"]) .fq-field[data-row="background"],
#${STYLE_PANEL_ID}:not([data-white-text="on"]) .fq-hint { opacity: .4; }

/* 滑杆：番茄 byte-slider 粗圆轨道风格 */
#${STYLE_PANEL_ID} input[type="range"] {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 24px; background: transparent; cursor: pointer; margin: 0;
}
#${STYLE_PANEL_ID} input[type="range"]::-webkit-slider-runnable-track {
  height: 24px; border-radius: 17px; background: rgba(0, 0, 0, .05);
}
html[muye-data-theme="dark"] #${STYLE_PANEL_ID} input[type="range"]::-webkit-slider-runnable-track {
  background: rgba(255, 255, 255, .08);
}
#${STYLE_PANEL_ID} input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 20px; height: 20px; margin-top: 2px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .3);
}
#${STYLE_PANEL_ID} .fq-reset {
  width: 100%; margin-top: 4px; padding: 8px 0; border: 0; border-radius: 6px;
  background: rgba(0, 0, 0, .05); color: inherit; cursor: pointer; font-size: 12px;
}
html[muye-data-theme="dark"] #${STYLE_PANEL_ID} .fq-reset { background: rgba(255, 255, 255, .08); }
`;