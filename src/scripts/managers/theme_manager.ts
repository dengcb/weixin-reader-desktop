import { injectCSS, removeCSS } from '../core/utils';

export class ThemeManager {
  constructor() {
    this.init();
  }

  // --- Link Logic ---
  private initLinks() {
    // 代理 window.open
    window.open = function(url: string | URL | undefined, target?: string | undefined, features?: string | undefined) {
      if (url) {
        window.location.href = url.toString();
      }
      return null;
    };

    // 监听所有点击事件
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const link = target.closest('a');
      if (link && link.target === '_blank') {
          link.target = '_self';
      }
    }, true);
  }

  // --- Dark Mode Logic ---
  private shouldEnableDarkMode() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  private applyTheme(isDark: boolean) {
    const isIframe = window.self !== window.top;
    
    // CSS Filter Logic
    const cssContent = `
      img, video, canvas, svg {
        filter: invert(1) hue-rotate(180deg) !important;
      }
      [style*="background-image"] {
        filter: invert(1) hue-rotate(180deg) !important;
      }
      ::-webkit-scrollbar {
        background-color: #2c2c2c;
      }
      ::-webkit-scrollbar-track {
        background-color: #2c2c2c;
      }
      ::-webkit-scrollbar-thumb {
        background-color: #555;
        border-radius: 4px;
      }
    `;

    // 经典复刻：强制指定背景色 + 滤镜
    // 这与旧 Electron 版本 (WXRD-archive/src/preload.ts:42) 完全一致
    const cssRoot = `
      html {
        filter: invert(1) hue-rotate(180deg) !important;
        background-color: #e0e0e0 !important;
      }
    `;
    
    const finalCss = isIframe ? cssContent : (cssRoot + cssContent);
    const id = 'wxrd-dark-mode-filter';

    if (isDark) {
      injectCSS(id, finalCss);
    } else {
      removeCSS(id);
    }
  }

  private initDarkMode() {
    // 立即执行一次
    this.applyTheme(this.shouldEnableDarkMode());
    
    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      this.applyTheme(e.matches);
    });
  }

  private init() {
      this.initLinks();
      this.initDarkMode();
  }
}
