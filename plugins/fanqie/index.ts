/*!
 * 番茄小说插件
 *
 * 仅增强网页呈现：CSS 多栏负责排版，代码负责整页位移和章节边界。
 * 不复制正文、不破解字体，也不抓取或导出内容。
 *
 * 插件编辑器中的六项“功能能力”均有实际控制入口：
 * 1. 双栏模式：分页器 + 原生工具栏单列/双栏按钮；
 * 2. 宽屏模式：按菜单状态注入 wide.css；
 * 3. 隐藏工具栏：按菜单状态注入 toolbar.css；
 * 4. 隐藏导航栏：按菜单状态注入 navbar.css；
 * 5. 章节导航：双栏时用上/下键切换上一章/下一章；
 * 6. 进度追踪：显示底部页码，关闭后同时回收页码占用的高度。
 */

import type {
  BookProgress,
  PluginAPI,
  PluginManifest,
  PluginStyles,
  ReaderPlugin,
} from '../../src/scripts/core/plugin_types';
import {
  FANQIE_PAGED_CLASS,
  FanqiePaginator,
} from './pagination';

const PREVIOUS_CHAPTER_FLAG = 'atreader-fanqie-open-previous-at-end';
const PREVIOUS_CHAPTER_FLAG_TTL = 15_000;
const WHEEL_THRESHOLD = 56;
const WHEEL_RESET_MS = 220;
const WHEEL_COOLDOWN_MS = 520;
const LAYOUT_PREFERENCE_KEY = 'double-column-enabled';

const SINGLE_COLUMN_ICON = `
  <svg class="reader-toolbar-item-icon" width="24" height="24" viewBox="0 0 24 24"
    fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="5" y="3.5" width="14" height="17" rx="2" stroke="currentColor" stroke-width="1.5"/>
    <path d="M8.5 8H15.5M8.5 11.5H15.5M8.5 15H14" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

const DOUBLE_COLUMN_ICON = `
  <svg class="reader-toolbar-item-icon" width="24" height="24" viewBox="0 0 24 24"
    fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="3.5" y="4" width="17" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/>
    <path d="M12 4.5V19.5M6.5 8H9.5M14.5 8H17.5M6.5 11.5H9.5M14.5 11.5H17.5"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

// 运行时代码中不内联 manifest 的 base64 图标，避免插件编辑器顶部出现超长数据行。
const FANQIE_RUNTIME_MANIFEST: PluginManifest = {
  id: 'fanqie',
  name: '番茄小说',
  version: '1.0.0',
  description: '番茄小说网站支持插件（官方范例）',
  author: '艾特阅读团队',
  homepage: 'https://github.com/dengcb/weixin-reader-desktop',
  sourceType: 'web',
  renderMode: 'webview',
  site: {
    domain: ['fanqienovel.com'],
    homeUrl: 'https://fanqienovel.com/',
    readerPattern: '/reader/',
  },
  capabilities: {
    wideMode: true,
    hideToolbar: true,
    autoFlip: true,
    chapterNav: true,
    progressTracker: true,
    doubleColumn: true,
    hideNavbar: true,
    hideCursor: true,
    remoteControl: true,
  },
};

type ChapterNavigationEvent = KeyboardEvent & {
  __atreaderChapterNavigation?: boolean;
};

interface FanqieChapterData {
  bookId?: string;
  bookName?: string;
  itemId?: string;
  title?: string;
  realChapterOrder?: string;
  order?: string;
  serialCount?: string;
  chapterWordNumber?: string;
  nextItemId?: string;
  preItemId?: string;
}

export class FanqiePlugin implements ReaderPlugin {
  readonly manifest = FANQIE_RUNTIME_MANIFEST;

  private api: PluginAPI | null = null;
  private paginator: FanqiePaginator | null = null;
  private cleanupFunctions: Array<() => void> = [];
  private restoreGeneration = 0;
  private positionReady = false;
  private wheelAccumulator = 0;
  private wheelResetTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelCooldown = false;
  private doubleColumnEnabled = true;
  private layoutToggleButton: HTMLDivElement | null = null;
  private toolbarObserver: MutationObserver | null = null;
  private toolbarSyncFrame: number | null = null;
  private toolbarBootstrapTimer: ReturnType<typeof setInterval> | null = null;

  onLoad(api: PluginAPI): void {
    this.api = api;
    api.log.info('Fanqie plugin loaded');
    this.fixViewport();

    this.paginator = new FanqiePaginator({
      getChapterKey: () => this.getChapterKey(),
      onChapterChange: chapterKey => this.restoreChapterPosition(chapterKey),
      onPositionChange: (pageIndex, pageCount) => {
        if (!this.positionReady || pageCount <= 0) return;
        const ratio = pageCount <= 1 ? 0 : pageIndex / (pageCount - 1);
        void this.api?.storage.set(this.positionStorageKey(this.getChapterKey()), ratio);
      },
    });

    window.addEventListener('keydown', this.handleKeyboard, { capture: true });
    window.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });
    this.cleanupFunctions.push(() => {
      window.removeEventListener('keydown', this.handleKeyboard, { capture: true });
      window.removeEventListener('wheel', this.handleWheel, { capture: true });
    });

    const routeChanged = () => this.applySettings(api.settings.getAll());
    window.addEventListener('ipc:route-changed', routeChanged);
    this.cleanupFunctions.push(() => window.removeEventListener('ipc:route-changed', routeChanged));

    const unsubscribe = api.settings.subscribe(settings => this.applySettings(settings));
    this.cleanupFunctions.push(unsubscribe);
    this.startToolbarEnhancement();
    this.applySettings(api.settings.getAll());
    void this.restoreLayoutPreference(api);
  }

  onUnload(): void {
    this.restoreGeneration++;
    this.clearWheelState();
    this.stopToolbarEnhancement();
    this.paginator?.destroy();
    this.paginator = null;
    document.body?.classList.remove(FANQIE_PAGED_CLASS);
    this.cleanupFunctions.forEach(cleanup => cleanup());
    this.cleanupFunctions = [];

    if (this.api) {
      for (const id of [
        'viewport',
        'reader',
        'wide',
        'toolbar',
        'navbar',
        'progress',
        'layout-toggle',
      ]) {
        this.api.style.remove(id);
      }
      this.api.log.info('Fanqie plugin unloaded');
    }
    this.api = null;
  }

  isReaderPage(): boolean {
    return window.location.pathname.includes('/reader/');
  }

  isHomePage(): boolean {
    const pathname = window.location.pathname;
    return pathname === '/' || pathname === '' || pathname.startsWith('/library');
  }

  matchesDomain(): boolean {
    const hostname = window.location.hostname;
    const domains = Array.isArray(this.manifest.site?.domain)
      ? this.manifest.site.domain
      : [this.manifest.site?.domain];
    return domains.some(domain =>
      typeof domain === 'string'
      && (hostname === domain || hostname.endsWith(`.${domain}`))
    );
  }

  nextPage(): void {
    if (this.paginator?.nextPage()) return;
    this.triggerChapterNavigation('ArrowRight');
  }

  prevPage(): void {
    if (this.paginator?.prevPage()) return;
    if (this.paginator?.isActive()) {
      sessionStorage.setItem(PREVIOUS_CHAPTER_FLAG, String(Date.now()));
    }
    this.triggerChapterNavigation('ArrowLeft');
  }

  getStyles(): PluginStyles {
    return {
      wideMode: {
        enabled: this.api?.style.getFile('wide.css') ?? '',
        disabled: '',
      },
      toolbar: {
        enabled: this.api?.style.getFile('toolbar.css') ?? '',
        disabled: '',
      },
      navbar: {
        enabled: this.api?.style.getFile('navbar.css') ?? '',
        disabled: '',
      },
      custom: {
        reader: this.api?.style.getFile('reader.css') ?? '',
        progress: this.api?.style.getFile('progress.css') ?? '',
        viewport: this.api?.style.getFile('viewport.css') ?? '',
        layoutToggle: this.api?.style.getFile('layout-toggle.css') ?? '',
      },
    };
  }

  isDoubleColumn(): boolean {
    return this.paginator?.isActive() ?? false;
  }

  isAtBottom(): boolean {
    if (this.paginator?.isActive()) return this.paginator.isAtLastPage();
    const totalHeight = document.documentElement.scrollHeight;
    return window.innerHeight + window.scrollY >= totalHeight - 300;
  }

  getChapterProgress(): number {
    const chapter = this.getChapterData();
    if (!chapter) return 0;
    const order = Number.parseInt(chapter.realChapterOrder || chapter.order || '0', 10);
    const total = Number.parseInt(chapter.serialCount || '0', 10);
    if (!total || total <= 0) return 0;
    return Math.min(100, Math.round((order / total) * 100));
  }

  async getBookProgress(): Promise<BookProgress | null> {
    const chapter = this.getChapterData();
    if (!chapter) return null;
    const order = Number.parseInt(chapter.realChapterOrder || chapter.order || '0', 10);
    const total = Number.parseInt(chapter.serialCount || '0', 10);
    return {
      progress: total > 0 ? Math.round((order / total) * 100) : 0,
      chapterIdx: order,
      summary: chapter.bookName
        ? `${chapter.bookName} · 第 ${order}/${total || '?'} 章`
        : undefined,
    };
  }

  getReaderMenuItems(): string[] {
    return ['reader_wide', 'hide_toolbar', 'hide_navbar', 'auto_flip'];
  }

  private readonly handleKeyboard = (event: KeyboardEvent): void => {
    const markedEvent = event as ChapterNavigationEvent;
    if (markedEvent.__atreaderChapterNavigation) return;

    const keyMatches = (key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => (
      event.key === key || event.code === key
    );
    if (!this.paginator?.isActive()) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target?.matches('input, textarea, select')) return;

    if (keyMatches('ArrowRight')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.nextPage();
    } else if (keyMatches('ArrowLeft')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.prevPage();
    /*!
     * @capability chapterNav
     * [功能能力 5/6：章节导航]
     * 这是纯交互能力，不需要 CSS；仅在双栏分页激活且能力开启时接管上下键。
    */
    } else if (
      keyMatches('ArrowUp')
      && this.manifest.capabilities.chapterNav === true
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      sessionStorage.setItem(PREVIOUS_CHAPTER_FLAG, String(Date.now()));
      this.triggerChapterNavigation('ArrowLeft');
    } else if (
      keyMatches('ArrowDown')
      && this.manifest.capabilities.chapterNav === true
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.triggerChapterNavigation('ArrowRight');
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.paginator?.isActive() || event.ctrlKey || event.metaKey) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.wheelCooldown || Math.abs(event.deltaY) < 1) return;

    this.wheelAccumulator += event.deltaY;
    if (this.wheelResetTimer) clearTimeout(this.wheelResetTimer);
    this.wheelResetTimer = setTimeout(() => {
      this.wheelResetTimer = null;
      this.wheelAccumulator = 0;
    }, WHEEL_RESET_MS);

    if (Math.abs(this.wheelAccumulator) < WHEEL_THRESHOLD) return;
    if (this.wheelAccumulator > 0) this.nextPage();
    else this.prevPage();
    this.wheelAccumulator = 0;
    this.wheelCooldown = true;
    this.wheelCooldownTimer = setTimeout(() => {
      this.wheelCooldownTimer = null;
      this.wheelCooldown = false;
    }, WHEEL_COOLDOWN_MS);
  };

  private triggerChapterNavigation(key: 'ArrowLeft' | 'ArrowRight'): void {
    const event = new KeyboardEvent('keydown', {
      key,
      code: key,
      keyCode: key === 'ArrowRight' ? 39 : 37,
      bubbles: true,
      cancelable: true,
    }) as ChapterNavigationEvent;
    Object.defineProperty(event, '__atreaderChapterNavigation', { value: true });
    document.dispatchEvent(event);
  }

  private applySettings(settings: Record<string, unknown>): void {
    if (!this.api) return;
    if (!this.isReaderPage()) {
      this.paginator?.disable();
      for (const id of ['reader', 'wide', 'toolbar', 'navbar', 'progress', 'layout-toggle']) {
        this.api.style.remove(id);
      }
      this.removeLayoutToggle();
      return;
    }

    const styles = this.getStyles();
    const readerCss = styles.custom?.reader ?? '';

    /*! @capability doubleColumn [功能能力 1/6：双栏模式] 能力开关是总开关，工具栏按钮负责临时切换。 */
    const hasDoubleColumn = this.manifest.capabilities.doubleColumn === true;
    const doubleColumn = hasDoubleColumn
      && this.doubleColumnEnabled
      && readerCss.trim().length > 0;
    /*! @capability wideMode [功能能力 2/6：宽屏模式] 菜单状态决定是否注入 wide.css。 */
    const wide = settings.readerWide === true;
    /*! @capability hideToolbar [功能能力 3/6：隐藏工具栏] 菜单状态决定是否注入 toolbar.css。 */
    const hideToolbar = settings.hideToolbar === true;
    /*! @capability hideNavbar [功能能力 4/6：隐藏导航栏] 同时要求清单能力和菜单状态开启。 */
    const hideNavbar = settings.hideNavbar === true
      && this.manifest.capabilities.hideNavbar === true;
    /*! @capability progressTracker [功能能力 6/6：进度追踪] 清单能力直接控制底部页码及其预留高度。 */
    const showProgress = this.manifest.capabilities.progressTracker === true;

    // 进度能力关闭时不创建底部页码，并让分页视口回收其 48px 预留区。
    this.paginator?.setProgressVisible(showProgress);

    // reader.css 提供 80% 基线；wide.css 必须随后注入，才能把同级规则覆盖为 90%。
    this.applyStyleFile('reader', readerCss, doubleColumn);
    this.applyStyleFile('wide', styles.wideMode?.enabled ?? '', wide);
    this.applyStyleFile('toolbar', styles.toolbar?.enabled ?? '', hideToolbar);
    this.applyStyleFile('navbar', styles.navbar?.enabled ?? '', hideNavbar);
    this.applyStyleFile(
      'progress',
      styles.custom?.progress ?? '',
      doubleColumn && showProgress,
    );
    this.applyStyleFile(
      'layout-toggle',
      styles.custom?.layoutToggle ?? '',
      hasDoubleColumn,
    );

    if (doubleColumn) this.paginator?.enable();
    else this.paginator?.disable();
    this.syncLayoutToggle();
  }

  private async restoreLayoutPreference(api: PluginAPI): Promise<void> {
    const stored = await api.storage.get<boolean>(LAYOUT_PREFERENCE_KEY);
    if (this.api !== api) return;
    const legacyValue = api.settings.get<boolean>('doubleColumn', true);
    this.doubleColumnEnabled = typeof stored === 'boolean' ? stored : legacyValue !== false;
    if (stored === null) {
      void api.storage.set(LAYOUT_PREFERENCE_KEY, this.doubleColumnEnabled);
    }
    this.applySettings(api.settings.getAll());
  }

  private startToolbarEnhancement(): void {
    if (this.toolbarObserver) return;
    const root = document.documentElement;
    if (!root) {
      this.ensureToolbarBootstrap();
      return;
    }
    this.toolbarObserver = new MutationObserver(() => {
      if (!this.layoutToggleButton?.isConnected) this.ensureToolbarBootstrap();
      this.scheduleToolbarSync();
    });
    // 插件可能在 <body> 与番茄工具栏创建前加载，因此从文档根节点开始监听。
    this.toolbarObserver.observe(root, { childList: true, subtree: true });
    this.syncLayoutToggle();
  }

  private stopToolbarEnhancement(): void {
    this.toolbarObserver?.disconnect();
    this.toolbarObserver = null;
    if (this.toolbarSyncFrame !== null) {
      window.cancelAnimationFrame(this.toolbarSyncFrame);
      this.toolbarSyncFrame = null;
    }
    this.stopToolbarBootstrap();
    this.removeLayoutToggle();
  }

  private ensureToolbarBootstrap(): void {
    if (this.toolbarBootstrapTimer !== null) return;
    if (!this.isReaderPage() || this.manifest.capabilities.doubleColumn !== true) return;
    // React 首屏挂载期间 DOM 可能连续替换；短间隔补偿确保按钮无需等到首次翻页。
    this.toolbarBootstrapTimer = setInterval(() => this.syncLayoutToggle(), 100);
  }

  private stopToolbarBootstrap(): void {
    if (this.toolbarBootstrapTimer === null) return;
    clearInterval(this.toolbarBootstrapTimer);
    this.toolbarBootstrapTimer = null;
  }

  private scheduleToolbarSync(): void {
    if (this.toolbarSyncFrame !== null) return;
    this.toolbarSyncFrame = window.requestAnimationFrame(() => {
      this.toolbarSyncFrame = null;
      this.syncLayoutToggle();
    });
  }

  private syncLayoutToggle(): void {
    /*! @capability doubleColumn [功能能力 1/6：双栏模式] 只在能力开启时增强番茄原生工具栏。 */
    const shouldShow = this.isReaderPage()
      && this.manifest.capabilities.doubleColumn === true;
    if (!shouldShow) {
      this.stopToolbarBootstrap();
      this.removeLayoutToggle();
      return;
    }

    if (this.layoutToggleButton?.isConnected) {
      this.stopToolbarBootstrap();
      this.updateLayoutToggle();
      return;
    }

    const host = document.querySelector<HTMLElement>('.reader-toolbar > div');
    if (!host) {
      this.ensureToolbarBootstrap();
      return;
    }
    if (!this.layoutToggleButton) {
      const button = document.createElement('div');
      button.className = 'reader-toolbar-item atreader-fanqie-layout-toggle';
      button.setAttribute('role', 'button');
      button.setAttribute('tabindex', '0');
      button.addEventListener('click', this.toggleLayoutMode);
      button.addEventListener('keydown', this.handleLayoutToggleKeydown);
      this.layoutToggleButton = button;
    }
    if (this.layoutToggleButton.parentElement !== host) {
      host.insertBefore(this.layoutToggleButton, host.firstElementChild);
    }
    this.stopToolbarBootstrap();
    this.updateLayoutToggle();
  }

  private updateLayoutToggle(): void {
    if (!this.layoutToggleButton) return;
    const switchToDoubleColumn = !this.doubleColumnEnabled;
    const label = switchToDoubleColumn ? '双栏' : '单列';
    if (this.layoutToggleButton.dataset.targetMode === label) return;
    this.layoutToggleButton.dataset.targetMode = label;
    this.layoutToggleButton.innerHTML = switchToDoubleColumn
      ? DOUBLE_COLUMN_ICON
      : SINGLE_COLUMN_ICON;
    this.layoutToggleButton.append(document.createElement('div'));
    this.layoutToggleButton.lastElementChild!.textContent = label;
    this.layoutToggleButton.setAttribute('aria-label', `切换为${label}阅读`);
    this.layoutToggleButton.setAttribute('title', `切换为${label}阅读`);
  }

  private readonly toggleLayoutMode = (): void => {
    const api = this.api;
    if (!api || this.manifest.capabilities.doubleColumn !== true) return;
    this.doubleColumnEnabled = !this.doubleColumnEnabled;
    void api.storage.set(LAYOUT_PREFERENCE_KEY, this.doubleColumnEnabled);
    this.applySettings(api.settings.getAll());
  };

  private readonly handleLayoutToggleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.toggleLayoutMode();
  };

  private removeLayoutToggle(): void {
    this.layoutToggleButton?.remove();
    this.layoutToggleButton = null;
  }

  private applyStyleFile(id: string, css: string, enabled: boolean): void {
    if (!this.api) return;
    if (enabled && css) this.api.style.inject(id, css);
    else this.api.style.remove(id);
  }

  private fixViewport(): void {
    if (!this.api) return;
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (viewportMeta) {
      const original = viewportMeta.getAttribute('content');
      viewportMeta.setAttribute(
        'content',
        'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no',
      );
      this.cleanupFunctions.push(() => {
        if (original === null) viewportMeta.removeAttribute('content');
        else viewportMeta.setAttribute('content', original);
      });
    }
    const css = this.api.style.getFile('viewport.css');
    if (css) this.api.style.inject('viewport', css);
  }

  private restoreChapterPosition(chapterKey: string): void {
    const api = this.api;
    const paginator = this.paginator;
    if (!api || !paginator) return;
    const generation = ++this.restoreGeneration;
    this.positionReady = false;

    if (this.consumePreviousChapterFlag()) {
      paginator.requestOpenAtEnd();
      this.positionReady = true;
      return;
    }

    void api.storage.get<number>(this.positionStorageKey(chapterKey))
      .then(ratio => {
        if (generation !== this.restoreGeneration || ratio === null) return;
        if (chapterKey !== this.getChapterKey()) return;
        paginator.restorePosition(ratio);
      })
      .finally(() => {
        if (generation === this.restoreGeneration) this.positionReady = true;
      });
  }

  private consumePreviousChapterFlag(): boolean {
    const raw = sessionStorage.getItem(PREVIOUS_CHAPTER_FLAG);
    sessionStorage.removeItem(PREVIOUS_CHAPTER_FLAG);
    const timestamp = Number(raw);
    return Number.isFinite(timestamp)
      && timestamp > 0
      && Date.now() - timestamp <= PREVIOUS_CHAPTER_FLAG_TTL;
  }

  private getChapterKey(): string {
    return `${location.pathname}${location.search}`;
  }

  private positionStorageKey(chapterKey: string): string {
    return `spread:${chapterKey}`;
  }

  private clearWheelState(): void {
    if (this.wheelResetTimer) clearTimeout(this.wheelResetTimer);
    if (this.wheelCooldownTimer) clearTimeout(this.wheelCooldownTimer);
    this.wheelResetTimer = null;
    this.wheelCooldownTimer = null;
    this.wheelAccumulator = 0;
    this.wheelCooldown = false;
  }

  private getChapterData(): FanqieChapterData | null {
    try {
      const state = (window as typeof window & {
        __INITIAL_STATE__?: { reader?: { chapterData?: unknown } };
      }).__INITIAL_STATE__;
      const chapterData = state?.reader?.chapterData;
      return chapterData && typeof chapterData === 'object'
        ? chapterData as FanqieChapterData
        : null;
    } catch {
      return null;
    }
  }
}

export default FanqiePlugin;
