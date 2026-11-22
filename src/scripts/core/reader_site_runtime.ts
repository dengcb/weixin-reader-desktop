import manifest from '../../plugins/builtin/weread/manifest.json';
import { WeReadAdapter } from '../adapters/weread_adapter';
import { setupStylePanel } from '../adapters/weread_style_panel';
import { chapterManager } from './chapter_manager';
import type {
  BookProgress,
  PluginAPI,
  PluginManifest,
  PluginStyles,
  ReaderPlugin,
} from './plugin_types';

/**
 * Managers 唯一依赖的站点运行时接口。
 *
 * WeRead 通过旧适配器桥接，第三方站点通过 ReaderPlugin 桥接；页面行为的
 * 实现仍留在各自的适配器/插件中，核心层只负责生命周期和能力路由。
 */
export interface ReaderSiteRuntime extends ReaderPlugin {
  readonly id: string;
  readonly name: string;
  readonly styleOwner: 'manager' | 'plugin';

  getWideModeCSS(wide: boolean, wideWidthPercent?: number): string;
  getToolbarCSS(hide: boolean): string;
  getNavbarCSS?(hide: boolean): string;
  getDarkThemeCSS?(): string;
  getLightThemeCSS?(): string;
  clickNextChapter?(): void;
  isPaginated?(): boolean;
  prevChapter?(): boolean | Promise<boolean>;
  nextChapter?(): boolean | Promise<boolean>;
  back?(): void | Promise<void>;
  forward?(): void | Promise<void>;
  openReadingStyle?(): boolean | void;
  canOpenReadingStyle?(): boolean;
  canNavigateChapter?(): boolean;
  canNavigatePreviousChapter?(): boolean;
  canNavigateNextChapter?(): boolean;
}

class WeReadSiteRuntime implements ReaderSiteRuntime {
  readonly manifest = manifest as PluginManifest;
  readonly id = this.manifest.id;
  readonly name = this.manifest.name;
  readonly styleOwner = 'manager' as const;

  private adapter: WeReadAdapter | null = null;
  private stylePanelTeardown: (() => void) | null = null;

  private getAdapter(): WeReadAdapter {
    this.adapter ??= new WeReadAdapter();
    return this.adapter;
  }

  onLoad(api: PluginAPI): void {
    // WeRead 的样式继续由 StyleManager 应用，进度跟踪器由适配器构造函数启动。
    this.getAdapter();
    // 阅读样式面板（issue #3 纯白正文 / #4 行距段间距）：右侧工具栏注入入口按钮
    this.stylePanelTeardown = setupStylePanel(api);
  }

  onUnload(): void {
    this.stylePanelTeardown?.();
    this.stylePanelTeardown = null;
    this.adapter?.destroy?.();
    this.adapter = null;
  }

  matchesDomain(): boolean {
    const domains = this.manifest.site?.domain;
    const configured = Array.isArray(domains) ? domains : [domains];
    return configured.some(domain =>
      typeof domain === 'string'
      && (window.location.hostname === domain || window.location.hostname.endsWith(`.${domain}`))
    );
  }

  isReaderPage(): boolean {
    return this.getAdapter().isReaderPage();
  }

  isHomePage(): boolean {
    return this.getAdapter().isHomePage();
  }

  nextPage(): void | Promise<void> {
    return this.getAdapter().nextPage();
  }

  openReadingStyle(): boolean {
    const button = document.getElementById('wxrd-style-button') as HTMLButtonElement | null;
    if (!button) return false;
    const panel = document.getElementById('wxrd-style-panel') as HTMLElement | null;
    if (!panel || panel.hidden) button.click();
    return true;
  }

  canOpenReadingStyle(): boolean { return true; }
  canNavigateChapter(): boolean { return chapterManager.isInitialized(); }
  private currentChapterPosition(): number {
    const match = window.location.pathname.match(/\/web\/reader\/([^?#]+)/);
    const fullPath = match?.[1];
    const marker = fullPath?.indexOf('k') ?? -1;
    if (!fullPath || marker <= 0) return -1;
    const segment = fullPath.slice(marker);
    return chapterManager.getChapters().findIndex(
      chapter => chapterManager.getChapterUrlSegment(chapter.chapterIdx) === segment,
    );
  }
  canNavigatePreviousChapter(): boolean { return this.currentChapterPosition() > 0; }
  canNavigateNextChapter(): boolean {
    const position = this.currentChapterPosition();
    return position >= 0 && position < chapterManager.getChapters().length - 1;
  }

  prevPage(): void | Promise<void> {
    return this.getAdapter().prevPage();
  }

  getStyles(): PluginStyles {
    return {};
  }

  getWideModeCSS(wide: boolean, wideWidthPercent?: number): string {
    return this.getAdapter().getWideModeCSS(wide, wideWidthPercent);
  }

  getToolbarCSS(hide: boolean): string {
    return this.getAdapter().getToolbarCSS(hide);
  }

  getNavbarCSS(hide: boolean): string {
    return this.getAdapter().getNavbarCSS?.(hide) ?? '';
  }

  getDarkThemeCSS(): string {
    return this.getAdapter().getDarkThemeCSS?.() ?? '';
  }

  getLightThemeCSS(): string {
    return this.getAdapter().getLightThemeCSS?.() ?? '';
  }

  isDoubleColumn(): boolean {
    return this.getAdapter().isDoubleColumn();
  }

  isAtBottom(): boolean {
    return this.getAdapter().isAtBottom();
  }

  getChapterProgress(): number {
    return this.getAdapter().getChapterProgress?.() ?? 0;
  }

  getBookProgress(): Promise<BookProgress | null> {
    return this.getAdapter().getBookProgress?.() ?? Promise.resolve(null);
  }

  clickNextChapter(): void {
    this.getAdapter().clickNextChapter?.();
  }

  getReaderMenuItems(): string[] {
    return this.getAdapter().getReaderMenuItems?.() ?? ['reader_wide', 'hide_toolbar', 'auto_flip'];
  }
}

class PluginSiteRuntime implements ReaderSiteRuntime {
  readonly styleOwner = 'plugin' as const;
  private readonly effectiveManifest: PluginManifest;

  constructor(
    private readonly plugin: ReaderPlugin,
    manifestOverride?: PluginManifest,
  ) {
    this.effectiveManifest = manifestOverride ?? plugin.manifest;
    if (manifestOverride) {
      // 安装包 manifest 是编辑器实际修改的文件，也应是运行时能力的权威来源。
      // 同步回插件实例，保证插件内部读取 this.manifest 时得到同一份配置。
      Object.defineProperty(plugin, 'manifest', {
        value: this.effectiveManifest,
        enumerable: true,
        configurable: true,
      });
    }
  }

  get manifest(): PluginManifest { return this.effectiveManifest; }
  get id(): string { return this.effectiveManifest.id; }
  get name(): string { return this.effectiveManifest.name; }

  onLoad(api: PluginAPI): void { this.plugin.onLoad(api); }
  onUnload(): void { this.plugin.onUnload(); }
  matchesDomain(): boolean { return this.plugin.matchesDomain(); }
  isReaderPage(): boolean { return this.plugin.isReaderPage(); }
  isHomePage(): boolean { return this.plugin.isHomePage(); }
  nextPage(): void | Promise<void> { return this.plugin.nextPage(); }
  prevPage(): void | Promise<void> { return this.plugin.prevPage(); }
  getStyles(): PluginStyles { return this.plugin.getStyles(); }
  isDoubleColumn(): boolean { return this.plugin.isDoubleColumn?.() ?? false; }
  isPaginated(): boolean { return this.plugin.isPaginated?.() ?? this.isDoubleColumn(); }
  isAtBottom(): boolean { return this.plugin.isAtBottom?.() ?? false; }
  getChapterProgress(): number { return this.plugin.getChapterProgress?.() ?? 0; }
  getBookProgress(): Promise<BookProgress | null> {
    return this.plugin.getBookProgress?.() ?? Promise.resolve(null);
  }
  getChapters() {
    return this.plugin.getChapters?.() ?? Promise.resolve([]);
  }
  getChapterUrl(chapterIdx: number): string | null {
    return this.plugin.getChapterUrl?.(chapterIdx) ?? null;
  }
  prevChapter(): boolean | Promise<boolean> {
    if (this.effectiveManifest.capabilities.chapterNav === false) return false;
    if (this.plugin.prevChapter) return this.plugin.prevChapter();
    if (this.effectiveManifest.capabilities.chapterNav !== true) return false;
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      code: 'ArrowUp',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, '__atreaderMenuChapterNavigation', { value: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  }
  nextChapter(): boolean | Promise<boolean> {
    if (this.effectiveManifest.capabilities.chapterNav === false) return false;
    if (this.plugin.nextChapter) return this.plugin.nextChapter();
    if (this.effectiveManifest.capabilities.chapterNav !== true) return false;
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, '__atreaderMenuChapterNavigation', { value: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  }
  back(): void | Promise<void> { return this.plugin.back?.(); }
  forward(): void | Promise<void> { return this.plugin.forward?.(); }
  openReadingStyle(): boolean | void { return this.plugin.openReadingStyle?.(); }
  canOpenReadingStyle(): boolean { return typeof this.plugin.openReadingStyle === 'function'; }
  canNavigateChapter(): boolean {
    return this.canNavigatePreviousChapter() || this.canNavigateNextChapter();
  }
  canNavigatePreviousChapter(): boolean {
    const declared = this.effectiveManifest.capabilities.chapterNav;
    if (declared === false) return false;
    return declared === true || typeof this.plugin.prevChapter === 'function';
  }
  canNavigateNextChapter(): boolean {
    const declared = this.effectiveManifest.capabilities.chapterNav;
    if (declared === false) return false;
    return declared === true || typeof this.plugin.nextChapter === 'function';
  }
  getReaderMenuItems(): string[] {
    return this.plugin.getReaderMenuItems?.() ?? ['reader_wide', 'hide_toolbar', 'auto_flip'];
  }

  getWideModeCSS(wide: boolean, _wideWidthPercent?: number): string {
    const styles = this.plugin.getStyles().wideMode;
    return styles ? (wide ? styles.enabled : styles.disabled) : '';
  }

  getToolbarCSS(hide: boolean): string {
    const styles = this.plugin.getStyles().toolbar;
    return styles ? (hide ? styles.enabled : styles.disabled) : '';
  }

  getNavbarCSS(hide: boolean): string {
    const styles = this.plugin.getStyles().navbar;
    return styles ? (hide ? styles.enabled : styles.disabled) : '';
  }

  getDarkThemeCSS(): string {
    return this.plugin.getStyles().theme?.dark ?? '';
  }

  getLightThemeCSS(): string {
    return this.plugin.getStyles().theme?.light ?? '';
  }
}

export const createWeReadSiteRuntime = (): ReaderSiteRuntime => new WeReadSiteRuntime();

export const createPluginSiteRuntime = (
  plugin: ReaderPlugin,
  manifestOverride?: PluginManifest,
): ReaderSiteRuntime => new PluginSiteRuntime(plugin, manifestOverride);

export const isReaderSiteRuntime = (plugin: ReaderPlugin): plugin is ReaderSiteRuntime =>
  'styleOwner' in plugin && 'getWideModeCSS' in plugin && 'getToolbarCSS' in plugin;
