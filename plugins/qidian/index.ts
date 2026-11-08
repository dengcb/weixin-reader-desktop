/*!
 * 起点中文插件
 *
 * 仅增强网页呈现：CSS 多栏负责排版，代码负责整页位移和章节边界。
 * 不复制正文、不破解字体，也不抓取或导出内容。
 *
 * 起点阅读页是 SSR 多页架构：每个章节都是一次全新文档加载，翻章直接
 * 点击站点底部自带的「上一章 / 下一章」链接；跨页阅读位置经
 * sessionStorage 标记与插件存储在新文档中恢复。
 *
 * 插件编辑器中的六项“功能能力”均有实际控制入口：
 * 1. 双栏模式：分页器 + 原生右侧工具栏单列/双栏按钮；
 * 2. 宽屏模式：按菜单状态注入 wide.css；
 * 3. 隐藏工具栏：按菜单状态注入 toolbar.css（左右浮动工具栏）；
 * 4. 隐藏导航栏：按菜单状态注入 navbar.css（站点顶部导航）；
 * 5. 章节导航：双栏时用上/下键切换上一章/下一章；
 * 6. 进度追踪：记录/恢复上次阅读位置；页码指示器常显，不受开关控制。
 */

import type {
  BookProgress,
  PluginAPI,
  PluginManifest,
  PluginStyles,
  ReaderPlugin,
} from '../../src/scripts/core/plugin_types';
import {
  ColumnPaginator,
  calculateSpreadMetrics,
} from '../shared/column_paginator';

export { calculateSpreadMetrics };

const QIDIAN_PAGED_CLASS = 'atreader-qidian-paged';
const QIDIAN_NO_TRANSITION_CLASS = 'atreader-qidian-no-transition';
const QIDIAN_CONTENT_SELECTOR = '.chapter-wrapper main.content';
const PREVIOUS_CHAPTER_FLAG = 'atreader-qidian-open-previous-at-end';
const CHAPTER_START_FLAG = 'atreader-qidian-open-chapter-at-start';
const CHAPTER_NAVIGATION_FLAG_TTL = 15_000;
const WHEEL_THRESHOLD = 56;
const WHEEL_RESET_MS = 220;
const WHEEL_COOLDOWN_MS = 520;
const SCROLLABLE_OVERFLOW_Y = new Set(['auto', 'scroll', 'overlay']);
const LAYOUT_PREFERENCE_KEY = 'double-column-enabled';
const CHAPTER_PATH_PATTERN = /^\/chapter\/\d+\/\d+\/?$/;

const SINGLE_COLUMN_ICON = `
  <svg width="24" height="24" viewBox="0 0 24 24"
    fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="5" y="3.5" width="14" height="17" rx="2" stroke="currentColor" stroke-width="1.5"/>
    <path d="M8.5 8H15.5M8.5 11.5H15.5M8.5 15H14" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

const DOUBLE_COLUMN_ICON = `
  <svg width="24" height="24" viewBox="0 0 24 24"
    fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="3.5" y="4" width="17" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/>
    <path d="M12 4.5V19.5M6.5 8H9.5M14.5 8H17.5M6.5 11.5H9.5M14.5 11.5H17.5"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

// 运行时代码中不内联 manifest 的 base64 图标，避免插件编辑器顶部出现超长数据行。
const QIDIAN_RUNTIME_MANIFEST: PluginManifest = {
  id: 'qidian',
  name: '起点中文',
  version: '1.0.0',
  description: '起点中文网网站支持插件（官方）',
  author: '艾特阅读团队',
  homepage: 'https://github.com/dengcb/weixin-reader-desktop',
  sourceType: 'web',
  renderMode: 'webview',
  site: {
    domain: ['qidian.com'],
    homeUrl: 'https://www.qidian.com/',
    readerPattern: '/chapter/\\d+/\\d+',
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
    // 非阅读页交还站点自身样式：全局反色滤镜在起点上会斑驳（行内背景图
    // 一刀切重转，白色弹层维持原样），站点无整站深色模式时保持默认浅色。
    nativeTheme: true,
  },
};

interface QidianPageData {
  bookInfo?: {
    bookId?: number | string;
    bookName?: string;
  };
  chapterInfo?: {
    chapterId?: number | string;
    chapterName?: string;
    chapterOrder?: number;
    seq?: number;
    prev?: number | string | null;
    next?: number | string | null;
    wordsCount?: number;
  };
}

interface QidianChapterData {
  bookId: string;
  bookName: string;
  chapterId: string;
  chapterName: string;
  chapterIndex: number;
  prevId: string;
  nextId: string;
}

export class QidianPlugin implements ReaderPlugin {
  readonly manifest = QIDIAN_RUNTIME_MANIFEST;

  private api: PluginAPI | null = null;
  private paginator: ColumnPaginator | null = null;
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
  private chapterData: QidianChapterData | null = null;

  onLoad(api: PluginAPI): void {
    this.api = api;
    api.log.info('Qidian plugin loaded');

    this.paginator = new ColumnPaginator({
      pagedClass: QIDIAN_PAGED_CLASS,
      noTransitionClass: QIDIAN_NO_TRANSITION_CLASS,
      viewportClass: 'atreader-qidian-page-viewport',
      indicatorClass: 'atreader-qidian-page-indicator',
      contentSelector: QIDIAN_CONTENT_SELECTOR,
      getChapterKey: () => this.getChapterKey(),
      onChapterChange: chapterKey => this.restoreChapterPosition(chapterKey),
      onPositionChange: (pageIndex, pageCount) => {
        if (!this.positionReady || pageCount <= 0) return;
        if (!this.positionMemoryEnabled()) return;
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
    document.body?.classList.remove(QIDIAN_PAGED_CLASS);
    this.cleanupFunctions.forEach(cleanup => cleanup());
    this.cleanupFunctions = [];
    this.chapterData = null;

    if (this.api) {
      for (const id of ['reader', 'wide', 'toolbar', 'navbar', 'progress', 'layout-toggle']) {
        this.api.style.remove(id);
      }
      this.api.log.info('Qidian plugin unloaded');
    }
    this.api = null;
  }

  isReaderPage(): boolean {
    return CHAPTER_PATH_PATTERN.test(window.location.pathname);
  }

  isHomePage(): boolean {
    const pathname = window.location.pathname;
    return pathname === '/' || pathname === '';
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
    this.nextChapter();
  }

  prevPage(): void {
    if (this.paginator?.prevPage()) return;
    if (this.paginator?.isActive()) {
      sessionStorage.setItem(PREVIOUS_CHAPTER_FLAG, String(Date.now()));
    }
    this.prevChapter();
  }

  getStyles(): PluginStyles {
    const file = (name: string): string => this.api?.style.getFile(name) ?? '';
    return {
      wideMode: {
        enabled: file('wide.css'),
        disabled: '',
      },
      toolbar: {
        enabled: file('toolbar.css'),
        disabled: '',
      },
      navbar: {
        enabled: file('navbar.css'),
        disabled: '',
      },
      custom: {
        reader: file('reader.css'),
        progress: file('progress.css'),
        layoutToggle: file('layout-toggle.css'),
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

  /** 右侧目录抽屉被打开过时，站点会渲染全书章节链接，可用于全书进度。 */
  private getCatalogPosition(): { index: number; total: number } | null {
    const links = document.querySelectorAll<HTMLAnchorElement>(
      '#chapter-list a[href*="/chapter/"]',
    );
    const total = links.length;
    if (!total) return null;
    const chapterId = this.getChapterData()?.chapterId;
    if (!chapterId) return null;
    const needle = `/${chapterId}/`;
    for (let i = 0; i < links.length; i += 1) {
      if ((links[i].getAttribute('href') || '').includes(needle)) {
        return { index: i, total };
      }
    }
    return null;
  }

  getChapterProgress(): number {
    const position = this.getCatalogPosition();
    if (position && position.total > 0) {
      return Math.min(100, Math.round(((position.index + 1) / position.total) * 100));
    }
    if (this.paginator?.isActive()) {
      return Math.min(100, Math.round(this.paginator.getPositionRatio() * 100));
    }
    return 0;
  }

  async getBookProgress(): Promise<BookProgress | null> {
    const chapter = this.getChapterData();
    if (!chapter) return null;
    const position = this.getCatalogPosition();
    const chapterIdx = position ? position.index + 1 : chapter.chapterIndex;
    const summary = [chapter.bookName, chapter.chapterName]
      .filter(part => part.length > 0)
      .join(' · ');
    return {
      ...(position ? { progress: Math.round((chapterIdx / position.total) * 100) } : {}),
      ...(chapterIdx > 0 ? { chapterIdx } : {}),
      ...(summary ? { summary } : {}),
    };
  }

  getReaderMenuItems(): string[] {
    return ['reader_wide', 'hide_toolbar', 'hide_navbar', 'auto_flip'];
  }

  private readonly handleKeyboard = (event: KeyboardEvent): void => {
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
      this.api?.toast.show('上一章');
      event.preventDefault();
      event.stopImmediatePropagation();
      // 显式跳章应落在上一章开头（与微信读书、番茄、目录跳转一致）；
      // ← 在本章第一页的翻页溢出才落上一章结尾（PREVIOUS_CHAPTER_FLAG）。
      sessionStorage.setItem(CHAPTER_START_FLAG, String(Date.now()));
      this.prevChapter();
    } else if (
      keyMatches('ArrowDown')
      && this.manifest.capabilities.chapterNav === true
    ) {
      this.api?.toast.show('下一章');
      event.preventDefault();
      event.stopImmediatePropagation();
      this.nextChapter();
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.paginator?.isActive() || event.ctrlKey || event.metaKey) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (this.isWithinNativeScrollArea(event.target)) return;
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

  /// 章节目录等原生弹窗浮在正文上层时，滚轮应滚动弹窗自身的列表。
  /// 本插件的 wheel 监听在 window capture 阶段先于弹窗拿到事件，若不在此
  /// 放行，preventDefault 会吞掉弹窗的原生滚动并变成翻页（“滚动穿透”）。
  /// 判定不依赖起点弹窗的具体选择器：目标到 body 之间存在纵向可滚动
  /// （overflow-y 为 auto/scroll/overlay 且实际溢出）的祖先即视为弹窗内部。
  private isWithinNativeScrollArea(target: EventTarget | null): boolean {
    // 用 nodeType 而非 instanceof Element 判定元素节点，兼容宿主未暴露
    // Element 全局的注入环境（测试运行时）。
    const start = target && (target as Node).nodeType === Node.ELEMENT_NODE
      ? target as Element
      : null;
    for (let node = start; node; node = node.parentElement) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (SCROLLABLE_OVERFLOW_Y.has(overflowY) && node.scrollHeight > node.clientHeight) {
        return true;
      }
      if (node === document.body) return false;
    }
    return false;
  }

  /** 起点翻章控件是正文区下方的站点原生链接（上一章 / 下一章）。 */
  private clickChapterLink(label: '上一章' | '下一章'): boolean {
    const links = document.querySelectorAll<HTMLAnchorElement>('.nav-btn-group a.nav-btn');
    for (let i = 0; i < links.length; i += 1) {
      if ((links[i].textContent || '').trim().includes(label)) {
        links[i].click();
        return true;
      }
    }
    return false;
  }

  prevChapter(): boolean {
    return this.clickChapterLink('上一章');
  }

  nextChapter(): boolean {
    return this.clickChapterLink('下一章');
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
    // 页码指示器常显：progressTracker 开关只管位置记忆，不再控制页码。
    this.paginator?.setProgressVisible(true);

    // reader.css 提供 80% 基线；wide.css 必须随后注入，才能把同级规则覆盖为 90%。
    this.applyStyleFile('reader', readerCss, doubleColumn);
    this.applyStyleFile('wide', styles.wideMode?.enabled ?? '', wide);
    this.applyStyleFile('toolbar', styles.toolbar?.enabled ?? '', hideToolbar);
    this.applyStyleFile('navbar', styles.navbar?.enabled ?? '', hideNavbar);
    this.applyStyleFile('progress', styles.custom?.progress ?? '', doubleColumn);
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
    // 插件可能在 <body> 与起点右侧工具栏创建前加载，因此从文档根节点开始监听。
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
    // SSR 页面正文已就绪，但右侧工具栏可能在首屏脚本之后插入；短间隔补偿确保按钮无需等到首次翻页。
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
    /*! @capability doubleColumn [功能能力 1/6：双栏模式] 只在能力开启时增强起点原生工具栏。 */
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

    const host = document.getElementById('r-menu');
    if (!host) {
      this.ensureToolbarBootstrap();
      return;
    }
    if (!this.layoutToggleButton) {
      const button = document.createElement('div');
      button.className = 'atreader-qidian-layout-toggle';
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
    const text = document.createElement('span');
    text.textContent = label;
    this.layoutToggleButton.append(text);
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

  private restoreChapterPosition(chapterKey: string): void {
    const api = this.api;
    const paginator = this.paginator;
    if (!api || !paginator) return;
    const generation = ++this.restoreGeneration;
    this.positionReady = false;

    // 章首：分页器章节重置后默认就在第一页，跳过进度恢复即可；
    // 章尾：← 翻页溢出的连续阅读流，显式请求落在最后一页。
    const openMode = this.consumeChapterOpenMode();
    if (openMode === 'end') {
      paginator.requestOpenAtEnd();
    }
    if (openMode !== null) {
      this.positionReady = true;
      return;
    }

    // 进度追踪开关关闭：不恢复存储的章节位置（页码仍常显）。
    if (!this.positionMemoryEnabled()) {
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

  /// 消费章节打开模式标记：两个标记互斥，读取时一并清空，
  /// 防止 15 秒 TTL 内先后触发“跳章”和“翻页溢出”时旧标记误伤下一次章节加载。
  private consumeChapterOpenMode(): 'start' | 'end' | null {
    const startRaw = sessionStorage.getItem(CHAPTER_START_FLAG);
    const endRaw = sessionStorage.getItem(PREVIOUS_CHAPTER_FLAG);
    sessionStorage.removeItem(CHAPTER_START_FLAG);
    sessionStorage.removeItem(PREVIOUS_CHAPTER_FLAG);
    const isFresh = (raw: string | null): boolean => {
      const timestamp = Number(raw);
      return Number.isFinite(timestamp)
        && timestamp > 0
        && Date.now() - timestamp <= CHAPTER_NAVIGATION_FLAG_TTL;
    };
    if (isFresh(startRaw)) return 'start';
    if (isFresh(endRaw)) return 'end';
    return null;
  }

  private getChapterKey(): string {
    return window.location.pathname;
  }

  private positionStorageKey(chapterKey: string): string {
    return `spread:${chapterKey}`;
  }

  /*! @capability progressTracker [进度追踪] 开关只控制「记录/恢复上次阅读位置」；
   * 页码指示器常显，不再受此开关控制。 */
  private positionMemoryEnabled(): boolean {
    return this.manifest.capabilities.progressTracker === true;
  }

  private clearWheelState(): void {
    if (this.wheelResetTimer) clearTimeout(this.wheelResetTimer);
    if (this.wheelCooldownTimer) clearTimeout(this.wheelCooldownTimer);
    this.wheelResetTimer = null;
    this.wheelCooldownTimer = null;
    this.wheelAccumulator = 0;
    this.wheelCooldown = false;
  }

  /** 起点把章节信息随 SSR 注入页面，用于进度摘要，不参与正文渲染。 */
  private getChapterData(): QidianChapterData | null {
    if (this.chapterData) return this.chapterData;
    const pathMatch = window.location.pathname.match(/^\/chapter\/(\d+)\/(\d+)/);
    if (!pathMatch) return null;

    let bookId = pathMatch[1];
    let chapterId = pathMatch[2];
    let bookName = '';
    let chapterName = '';
    let chapterIndex = 0;
    let prevId = '';
    let nextId = '';

    const contextElement = document.getElementById('vite-plugin-ssr_pageContext');
    if (contextElement?.textContent) {
      try {
        const parsed = JSON.parse(contextElement.textContent) as {
          pageContext?: {
            pageProps?: {
              pageData?: {
                bookInfo?: QidianPageData['bookInfo'];
                chapterInfo?: QidianPageData['chapterInfo'];
              };
            };
          };
        };
        const pageData = parsed.pageContext?.pageProps?.pageData;
        const bookInfo = pageData?.bookInfo;
        const chapterInfo = pageData?.chapterInfo;
        if (bookInfo?.bookId) bookId = String(bookInfo.bookId);
        if (bookInfo?.bookName) bookName = bookInfo.bookName;
        if (chapterInfo?.chapterId) chapterId = String(chapterInfo.chapterId);
        if (chapterInfo?.chapterName) chapterName = chapterInfo.chapterName;
        if (Number(chapterInfo?.seq) > 0) chapterIndex = Number(chapterInfo?.seq);
        if (Number(chapterInfo?.prev) > 0) prevId = String(chapterInfo?.prev);
        if (Number(chapterInfo?.next) > 0) nextId = String(chapterInfo?.next);
      } catch {
        // SSR 数据缺失或格式变化时退回 URL 与 DOM。
      }
    }

    if (!chapterName) chapterName = this.getDomChapterTitle();
    if (!chapterIndex) {
      const order = chapterName.match(/^(\d+)[.、\s]/);
      if (order) chapterIndex = Number(order[1]);
    }

    this.chapterData = {
      bookId,
      bookName,
      chapterId,
      chapterName,
      chapterIndex,
      prevId,
      nextId,
    };
    return this.chapterData;
  }

  private getDomChapterTitle(): string {
    const title = document.querySelector<HTMLElement>('.chapter-wrapper h1.title');
    if (!title) return '';
    const clone = title.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.review').forEach(node => node.remove());
    return (clone.textContent || '').trim();
  }
}

export default QidianPlugin;
