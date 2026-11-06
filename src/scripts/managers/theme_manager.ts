import { injectCSS, removeCSS } from '../core/utils';
import { getPluginLoader } from '../core/plugin_loader';

export class ThemeManager {
  // Store references for cleanup
  private darkModeQuery: MediaQueryList | null = null;
  private darkModeChangeHandler: ((e: MediaQueryListEvent) => void) | null = null;
  private reevaluateHandler: (() => void) | null = null;

  constructor() {
    this.init();
  }

  // --- Dark Mode Logic ---
  private shouldEnableDarkMode() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /**
   * 站点在 manifest 声明 nativeTheme 时，深浅模式完全交给站点自身机制，
   * 壳层不得注入反色滤镜。该判定在「每次应用」时自查而非仅在装配时决定：
   * 初始化时序可能让本管理器在插件就绪前创建（站点是后启用/后安装的），
   * 一次性决策会让滤镜永久残留——根元素 filter 会破坏 WebKit 在 SPA 路由
   * 切换后的命中测试，表现为「点击链接无响应」。
   */
  private nativeThemeHandoff(): boolean {
    try {
      return getPluginLoader().getActivePlugin()?.manifest.capabilities.nativeTheme === true;
    } catch {
      return false;
    }
  }

  private applyTheme(isDark: boolean) {
    const isIframe = window.self !== window.top;
    const invertActive = isDark && !this.nativeThemeHandoff();
    // 反色激活标记：自有浮层（⌘L 书城切换、切换过场）据此二次反转抵消，
    // 不再被站点的反色滤镜一起反色（2026-11-06 用户报告）
    document.documentElement.classList.toggle('wxrd-theme-inverted', invertActive && !isIframe);

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
        background-color: #d3d3d3 !important;
      }
    `;

    const finalCss = isIframe ? cssContent : (cssRoot + cssContent);
    const id = 'wxrd-dark-mode-filter';

    if (this.nativeThemeHandoff()) {
      removeCSS(id);
      return;
    }

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
    this.darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.darkModeChangeHandler = (e) => {
      this.applyTheme(e.matches);
    };
    this.darkModeQuery.addEventListener('change', this.darkModeChangeHandler);
  }

  private init() {
      this.initDarkMode();
      // SPA 路由变化与插件启用/安装都可能改变「当前站点是否声明
      // nativeTheme」，订阅这两类信号随时自愈，避免一次性决策遗留滤镜。
      this.reevaluateHandler = () => this.applyTheme(this.shouldEnableDarkMode());
      // wxrd:route-changed 双订阅已移除（与 ipc:route-changed 同发，见
      // I-P1-4）；本管理器只订阅 ipc 版本。
      window.addEventListener('ipc:route-changed', this.reevaluateHandler);
      window.addEventListener('plugins-updated', this.reevaluateHandler);
  }

  public destroy() {
    // Remove dark mode change listener
    if (this.darkModeQuery && this.darkModeChangeHandler) {
      this.darkModeQuery.removeEventListener('change', this.darkModeChangeHandler);
      this.darkModeQuery = null;
      this.darkModeChangeHandler = null;
    }

    if (this.reevaluateHandler) {
      window.removeEventListener('ipc:route-changed', this.reevaluateHandler);
      window.removeEventListener('plugins-updated', this.reevaluateHandler);
      this.reevaluateHandler = null;
    }

    // Clean up injected CSS
    removeCSS('wxrd-dark-mode-filter');
  }
}
