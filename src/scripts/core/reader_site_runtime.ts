import manifest from '../../plugins/builtin/weread/manifest.json';
import { WeReadAdapter } from '../adapters/weread_adapter';
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

  getWideModeCSS(wide: boolean): string;
  getToolbarCSS(hide: boolean): string;
  getNavbarCSS?(hide: boolean): string;
  getDarkThemeCSS?(): string;
  getLightThemeCSS?(): string;
  clickNextChapter?(): void;
}

class WeReadSiteRuntime implements ReaderSiteRuntime {
  readonly manifest = manifest as PluginManifest;
  readonly id = this.manifest.id;
  readonly name = this.manifest.name;
  readonly styleOwner = 'manager' as const;

  private adapter: WeReadAdapter | null = null;

  private getAdapter(): WeReadAdapter {
    this.adapter ??= new WeReadAdapter();
    return this.adapter;
  }

  onLoad(_api: PluginAPI): void {
    // WeRead 的样式继续由 StyleManager 应用，进度跟踪器由适配器构造函数启动。
    this.getAdapter();
  }

  onUnload(): void {
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

  prevPage(): void | Promise<void> {
    return this.getAdapter().prevPage();
  }

  getStyles(): PluginStyles {
    return {};
  }

  getWideModeCSS(wide: boolean): string {
    return this.getAdapter().getWideModeCSS(wide);
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

  getBookProgress(): Promise<BookProgress | null> { return Promise.resolve(null); }

  clickNextChapter(): void {
    this.getAdapter().clickNextChapter?.();
  }

  getReaderMenuItems(): string[] {
    return this.getAdapter().getReaderMenuItems?.() ?? ['reader_wide', 'hide_toolbar', 'auto_flip'];
  }
}

class PluginSiteRuntime implements ReaderSiteRuntime {
  readonly styleOwner = 'plugin' as const;

  constructor(private readonly plugin: ReaderPlugin) {}

  get manifest(): PluginManifest { return this.plugin.manifest; }
  get id(): string { return this.plugin.manifest.id; }
  get name(): string { return this.plugin.manifest.name; }

  onLoad(api: PluginAPI): void { this.plugin.onLoad(api); }
  onUnload(): void { this.plugin.onUnload(); }
  matchesDomain(): boolean { return this.plugin.matchesDomain(); }
  isReaderPage(): boolean { return this.plugin.isReaderPage(); }
  isHomePage(): boolean { return this.plugin.isHomePage(); }
  nextPage(): void | Promise<void> { return this.plugin.nextPage(); }
  prevPage(): void | Promise<void> { return this.plugin.prevPage(); }
  getStyles(): PluginStyles { return this.plugin.getStyles(); }
  isDoubleColumn(): boolean { return this.plugin.isDoubleColumn?.() ?? false; }
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
  getReaderMenuItems(): string[] {
    return this.plugin.getReaderMenuItems?.() ?? ['reader_wide', 'hide_toolbar', 'auto_flip'];
  }

  getWideModeCSS(wide: boolean): string {
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

export const createPluginSiteRuntime = (plugin: ReaderPlugin): ReaderSiteRuntime =>
  new PluginSiteRuntime(plugin);

export const isReaderSiteRuntime = (plugin: ReaderPlugin): plugin is ReaderSiteRuntime =>
  'styleOwner' in plugin && 'getWideModeCSS' in plugin && 'getToolbarCSS' in plugin;
