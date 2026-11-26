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
 * 本地来源与外部插件共用此接口，核心层负责生命周期和能力路由。
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

class PluginSiteRuntime implements ReaderSiteRuntime {
  get styleOwner() { return this.plugin.styleOwner ?? 'plugin'; }
  getWindowTheme() { return this.plugin.getWindowTheme?.() ?? null; }
  openToc() { return this.plugin.openToc?.(); }
  closeToc() { return this.plugin.closeToc?.(); }
  get getProgressPanel() { return this.plugin.getProgressPanel?.bind(this.plugin); }
  get getProgressInset() { return this.plugin.getProgressInset?.bind(this.plugin); }
  clickNextChapter() { this.plugin.clickNextChapter?.(); }
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
    if (this.plugin.canNavigatePreviousChapter) return this.plugin.canNavigatePreviousChapter();
    return declared === true || typeof this.plugin.prevChapter === 'function';
  }
  canNavigateNextChapter(): boolean {
    const declared = this.effectiveManifest.capabilities.chapterNav;
    if (declared === false) return false;
    if (this.plugin.canNavigateNextChapter) return this.plugin.canNavigateNextChapter();
    return declared === true || typeof this.plugin.nextChapter === 'function';
  }
  getReaderMenuItems(): string[] {
    return this.plugin.getReaderMenuItems?.() ?? ['reader_wide', 'hide_toolbar', 'auto_flip'];
  }

  getWideModeCSS(wide: boolean, wideWidthPercent?: number): string {
    if (this.plugin.getWideModeCSS) return this.plugin.getWideModeCSS(wide, wideWidthPercent);
    const styles = this.plugin.getStyles().wideMode;
    return styles ? (wide ? styles.enabled : styles.disabled) : '';
  }

  getToolbarCSS(hide: boolean): string {
    if (this.plugin.getToolbarCSS) return this.plugin.getToolbarCSS(hide);
    const styles = this.plugin.getStyles().toolbar;
    return styles ? (hide ? styles.enabled : styles.disabled) : '';
  }

  getNavbarCSS(hide: boolean): string {
    if (this.plugin.getNavbarCSS) return this.plugin.getNavbarCSS(hide);
    const styles = this.plugin.getStyles().navbar;
    return styles ? (hide ? styles.enabled : styles.disabled) : '';
  }

  getDarkThemeCSS(): string {
    if (this.plugin.getDarkThemeCSS) return this.plugin.getDarkThemeCSS();
    return this.plugin.getStyles().theme?.dark ?? '';
  }

  getLightThemeCSS(): string {
    if (this.plugin.getLightThemeCSS) return this.plugin.getLightThemeCSS();
    return this.plugin.getStyles().theme?.light ?? '';
  }
}


export const createPluginSiteRuntime = (
  plugin: ReaderPlugin,
  manifestOverride?: PluginManifest,
): ReaderSiteRuntime => new PluginSiteRuntime(plugin, manifestOverride);

export const isReaderSiteRuntime = (plugin: ReaderPlugin): plugin is ReaderSiteRuntime =>
  'styleOwner' in plugin && 'getWideModeCSS' in plugin && 'getToolbarCSS' in plugin;
