import manifest from './manifest.json';
import { WeReadAdapter } from './weread_adapter';
import { setupStylePanel } from './weread_style_panel';
import { chapterManager } from './chapter_manager';
import { detectWereadTheme } from './weread_theme';
import { openToc, closeToc } from './toc';
import type { BookProgress, PluginAPI, PluginManifest, PluginStyles, ReaderPlugin } from '../../src/scripts/core/plugin_types';

export default class WeReadPlugin implements ReaderPlugin {
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
    this.getAdapter().start(api);
    // 阅读样式面板（issue #3 纯白正文 / #4 行距段间距）：右侧工具栏注入入口按钮
    this.stylePanelTeardown = setupStylePanel(api);
  }

  onUnload(): void {
    this.stylePanelTeardown?.();
    this.stylePanelTeardown = null;
    this.adapter?.destroy?.();
    this.adapter = null;
    chapterManager.reset();
    this.closeToc();
  }

  getWindowTheme() { return detectWereadTheme(); }
  openToc() { return openToc(); }
  closeToc() { return closeToc(); }
  getProgressPanel() {
    for (const selector of ['.renderTargetContainer', '.readerChapterContent']) {
      const panel = document.querySelector<HTMLElement>(selector);
      if (panel && panel.getBoundingClientRect().width > 0) return panel;
    }
    return null;
  }
  getProgressInset(parent: HTMLElement) {
    const rect = parent.getBoundingClientRect();
    const pager = document.querySelector('.renderTarget_pager');
    const inset = pager ? pager.getBoundingClientRect().left - rect.left : 0;
    return Math.round(inset > 0 ? inset : rect.width * 0.045);
  }
  prevChapter() { return this.navigate(-1); }
  nextChapter() { return this.navigate(1); }
  private navigate(direction: number) {
    const current = this.currentChapterPosition();
    if (current < 0) return false;
    const target = chapterManager.getChapters()[current + direction];
    const url = target && chapterManager.buildChapterUrl(target.chapterIdx);
    if (!url) return false;
    window.location.href = url;
    return true;
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

