import type { PluginAPI, PluginManifest, PluginStyles } from '../../../scripts/core/plugin_types';
import type { ReaderSiteRuntime } from '../../../scripts/core/reader_site_runtime';
import { getLocalReaderController } from '../../../scripts/core/local_runtime_bridge';
import manifest from './manifest.json';

export class LocalSiteRuntime implements ReaderSiteRuntime {
  readonly manifest = manifest as PluginManifest;
  readonly id = this.manifest.id;
  readonly name = this.manifest.name;
  readonly styleOwner = 'manager' as const;

  onLoad(api: PluginAPI): void { getLocalReaderController()?.attachPluginAPI(api); }
  onUnload(): void { getLocalReaderController()?.detachPluginAPI(); }
  matchesDomain(): boolean {
    return location.protocol === 'atreader:' || location.hostname === 'atreader.localhost';
  }
  isReaderPage(): boolean {
    return location.pathname === '/local-reader' && (getLocalReaderController()?.isReady() ?? false);
  }
  isHomePage(): boolean { return false; }
  isPaginated(): boolean { return true; }
  isDoubleColumn(): boolean { return getLocalReaderController()?.isDoubleColumn() ?? true; }
  isAtBottom(): boolean { return getLocalReaderController()?.isAtBottom() ?? false; }
  getChapterProgress(): number { return getLocalReaderController()?.getChapterProgress() ?? 0; }
  getChapters() { return getLocalReaderController()?.getChapters() ?? Promise.resolve([]); }
  nextPage(): void | Promise<void> { return getLocalReaderController()?.nextPage(); }
  prevPage(): void | Promise<void> { return getLocalReaderController()?.prevPage(); }
  nextChapter(): boolean | Promise<boolean> { return getLocalReaderController()?.nextChapter() ?? false; }
  prevChapter(): boolean | Promise<boolean> { return getLocalReaderController()?.prevChapter() ?? false; }
  back(): void | Promise<void> { return getLocalReaderController()?.back(); }
  forward(): void | Promise<void> { return getLocalReaderController()?.forward(); }
  getStyles(): PluginStyles { return {}; }
  getWideModeCSS(wide: boolean): string {
    return `:root { --local-reader-max-inline: ${wide ? '90%' : '80%'}; }`;
  }
  getToolbarCSS(hide: boolean): string {
    return hide ? '#localToolbar { opacity: 0; pointer-events: none; }' : '';
  }
  getNavbarCSS(hide: boolean): string {
    return hide ? '#localNavbar { transform: translateY(-100%); opacity: 0; pointer-events: none; }' : '';
  }
  getDarkThemeCSS(): string { return ''; }
  getLightThemeCSS(): string { return ''; }
  getReaderMenuItems(): string[] {
    return ['reader_wide', 'hide_cursor', 'hide_toolbar', 'hide_navbar', 'auto_flip'];
  }
}

export const createLocalSiteRuntime = (): ReaderSiteRuntime => new LocalSiteRuntime();
