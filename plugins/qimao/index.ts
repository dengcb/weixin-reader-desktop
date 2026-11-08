/*!
 * 七猫小说插件
 *
 * 仅增强网页呈现：CSS 多栏负责排版，代码负责整页位移和章节边界。
 * 不复制正文、不破解字体，也不抓取或导出内容。
 *
 * 七猫阅读页是 SSR 多页架构：每个章节都是一次全新文档加载，翻章直接
 * 点击站点自带的「上一章 / 下一章」链接；跨页阅读位置经 sessionStorage
 * 标记与插件存储在新文档中恢复。
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
// api.log 是 console-only 实现（core/logger.ts），落文件诊断必须走 logToFile
import { logToFile } from '../../src/scripts/core/tauri';
import { setSiteReadinessProbe } from '../../src/scripts/core/site_switch_loading';
import {
  armReaderEntryWatchdog,
  stylesheetsReady,
} from '../shared/reader_entry_watchdog';
import {
  ColumnPaginator,
  calculateSpreadMetrics,
} from '../shared/column_paginator';

export { calculateSpreadMetrics };

const QIMAO_PAGED_CLASS = 'atreader-qimao-paged';
const QIMAO_NO_TRANSITION_CLASS = 'atreader-qimao-no-transition';
const QIMAO_CONTENT_SELECTOR = '.chapter-detail-article';
const PREVIOUS_CHAPTER_FLAG = 'atreader-qimao-open-previous-at-end';
const CHAPTER_START_FLAG = 'atreader-qimao-open-chapter-at-start';
const CHAPTER_NAVIGATION_FLAG_TTL = 15_000;
const WHEEL_THRESHOLD = 56;
const WHEEL_RESET_MS = 220;
const WHEEL_COOLDOWN_MS = 520;
const SCROLLABLE_OVERFLOW_Y = new Set(['auto', 'scroll', 'overlay']);
const LAYOUT_PREFERENCE_KEY = 'double-column-enabled';
/// 正文字重三档（阅读设置 → 正文字体 → 可调 → 字重大小）。站点自身只有
/// 400 一档且字族是固定字面：可调档换成可权重选择的系统字族，见
/// buildAdjustableFontCss；站点自己的「系统 / 宋体」不受影响。
const FONT_WEIGHTS = [
  { label: '粗', value: 600 },
  { label: '中', value: 400 },
  { label: '细', value: 300 },
] as const;
const FONT_WEIGHT_DEFAULT_INDEX = 1;
const FONT_WEIGHT_KEY = 'font-weight-index';
/// 「正文字体 → 可调」开关：选中时用可权重选择的系统字族覆盖站点字族，
/// 并显示下方「字重大小」行（粗/中/细）。
const ADJUSTABLE_FONT_KEY = 'adjustable-font';
const READER_INDEX_PATTERN = /\/reader\/index\/\d+/;
const CHAPTER_PATH_PATTERN = /^\/shuku\/\d+-\d+/;
/// 七猫站点自己的阅读偏好存储键（主题/字号/字体，站点 JS 启动时应用到
/// .reader-layout-theme[data-theme] 与正文类模板）。开机守卫据此兜底
/// （见 startBootGuard）。
const QIMAO_READER_SETTING_KEY = 'qimao_reader_setting_data';
/// 开机守卫轮询窗口：300ms × 40 = 12s，覆盖站点冷启动慢的首次加载
const BOOT_GUARD_TICK_MS = 300;
const BOOT_GUARD_MAX_TICKS = 40;
/// 分页器绑定时机：等 Nuxt hydration 完成（Vue 2 hydrate 成功后移除
/// #__nuxt 上的 data-server-rendered）。提前包裹 SSR 正文会让 hydrate
/// 丢弃该子树、重建的元素丢失 class 与 data-v 作用域属性——站点按
///「主题 + scoped 属性」着色的正文会退回黑色（2026-11-05 夜间模式实证）。
/// 兜底上限：信号始终不出现（站点改版/非 Nuxt 页）时 9s 后照常绑定。
const HYDRATION_POLL_MS = 100;
const HYDRATION_WAIT_MAX_MS = 9_000;
const POST_HYDRATION_SETTLE_MS = 400;

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
const QIMAO_RUNTIME_MANIFEST: PluginManifest = {
  id: 'qimao',
  name: '七猫小说',
  version: '1.0.1',
  description: '七猫小说网站支持插件（官方）',
  author: '艾特阅读团队',
  homepage: 'https://github.com/dengcb/weixin-reader-desktop',
  sourceType: 'web',
  renderMode: 'webview',
  site: {
    domain: ['qimao.com'],
    homeUrl: 'https://www.qimao.com/',
    readerPattern: '/(reader/index/\\d+|shuku/\\d+-\\d+)',
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
    // 非阅读页交还站点自身样式：全局反色滤镜在七猫上会斑驳（行内背景图
    // 一刀切重转，白卡片维持原样），站点无整站深色模式时保持默认浅色。
    nativeTheme: true,
  },
};

export class QimaoPlugin implements ReaderPlugin {
  readonly manifest = QIMAO_RUNTIME_MANIFEST;

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
  private weightIndex = FONT_WEIGHT_DEFAULT_INDEX;
  private adjustableFont = false;
  private diagnosticsTimers: number[] = [];
  private disarmWatchdog: (() => void) | null = null;
  private layoutToggleButton: HTMLLIElement | null = null;
  private adjustableOption: HTMLElement | null = null;
  private adjustableRow: HTMLElement | null = null;
  private toolbarObserver: MutationObserver | null = null;
  private toolbarSyncFrame: number | null = null;
  private toolbarBootstrapTimer: ReturnType<typeof setInterval> | null = null;
  private bootGuardTimer: ReturnType<typeof setInterval> | null = null;
  private bootGuardTicks = 0;
  private desiredDoubleColumn = true;
  private paginatorBindArmed = false;
  private paginatorBindScheduled = false;
  private paginatorBindTimer: ReturnType<typeof setTimeout> | null = null;

  onLoad(api: PluginAPI): void {
    this.api = api;
    api.log.info('Qimao plugin loaded');

    this.paginator = new ColumnPaginator({
      pagedClass: QIMAO_PAGED_CLASS,
      noTransitionClass: QIMAO_NO_TRANSITION_CLASS,
      viewportClass: 'atreader-qimao-page-viewport',
      indicatorClass: 'atreader-qimao-page-indicator',
      contentSelector: QIMAO_CONTENT_SELECTOR,
      getChapterKey: () => this.getChapterKey(),
      onChapterChange: chapterKey => this.restoreChapterPosition(chapterKey),
      onAnomaly: detail => {
        logToFile(`[Qimao] anomaly ${detail} chapterKey=${this.getChapterKey()}`);
      },
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
    // 进页失速看门狗 + 过场层就绪探针。就绪判据 = 分页器绑定 + 正文段落
    // 存在（与七猫健康态一致；不要加背景色检查——他们正文容器本来就是
    // 透明的，背景在站点别处）。站点开机守卫同样只作用于阅读页。
    if (this.isReaderPage()) {
      const presented = (): boolean =>
        stylesheetsReady(document)
        && !!document.querySelector(`${QIMAO_CONTENT_SELECTOR} p`);
      setSiteReadinessProbe(presented);
      this.disarmWatchdog = armReaderEntryWatchdog({
        pluginId: 'qimao',
        isReady: presented,
        // 七猫是 SSR：正文不在首屏 HTML 里 = 该页已废（服务端内容缺失），
        // 失速判定不需要 10s 那么斯文——2026-10-25 实测用户在 9s 时自己切走，
        // 看门狗差 1 秒没来得及救。4s 立即重载一次。
        timeoutMs: 4000,
        log: message => logToFile(`[Qimao] ${message}`),
      });
      this.startBootGuard();
    }
    void this.restoreLayoutPreference(api);
  }

  onUnload(): void {
    this.restoreGeneration++;
    this.clearWheelState();
    this.disarmWatchdog?.();
    this.disarmWatchdog = null;
    for (const timer of this.diagnosticsTimers) window.clearTimeout(timer);
    this.diagnosticsTimers = [];
    if (this.paginatorBindTimer !== null) {
      clearTimeout(this.paginatorBindTimer);
      this.paginatorBindTimer = null;
    }
    this.paginatorBindScheduled = false;
    this.paginatorBindArmed = false;
    this.stopBootGuard();
    this.stopToolbarEnhancement();
    this.paginator?.destroy();
    this.paginator = null;
    document.body?.classList.remove(QIMAO_PAGED_CLASS);
    this.cleanupFunctions.forEach(cleanup => cleanup());
    this.cleanupFunctions = [];

    if (this.api) {
      for (const id of ['reader', 'wide', 'toolbar', 'navbar', 'progress', 'layout-toggle', 'theme-text', 'theme-night', 'font-adjustable']) {
        this.api.style.remove(id);
      }
      this.api.log.info('Qimao plugin unloaded');
    }
    this.api = null;
  }

  isReaderPage(): boolean {
    const pathname = window.location.pathname;
    return READER_INDEX_PATTERN.test(pathname) || CHAPTER_PATH_PATTERN.test(pathname);
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
        themeText: file('theme-text.css'),
        nightTone: file('theme-night.css'),
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

  /** 当前章在右侧目录中的位置；目录未渲染或不完整时返回 null。 */
  private getCatalogPosition(): { index: number; total: number } | null {
    const items = document.querySelectorAll('.qm-fixed-right li[class*="ref-catalog-li"]');
    const total = items.length;
    if (!total) return null;
    let index = -1;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].classList.contains('active')) {
        index = i;
        break;
      }
    }
    return index >= 0 ? { index, total } : null;
  }

  private getBookName(): string {
    const item = document.querySelector('.chapter-tips dd');
    return item ? (item.textContent || '').trim() : '';
  }

  getChapterProgress(): number {
    const position = this.getCatalogPosition();
    if (!position || position.total <= 0) return 0;
    return Math.min(
      100,
      Math.round(((position.index + 1) / position.total) * 100),
    );
  }

  async getBookProgress(): Promise<BookProgress | null> {
    const position = this.getCatalogPosition();
    if (!position) return null;
    const chapterIdx = position.index + 1;
    const bookName = this.getBookName();
    return {
      progress: position.total > 0
        ? Math.round((chapterIdx / position.total) * 100)
        : 0,
      chapterIdx,
      summary: bookName
        ? `${bookName} · 第 ${chapterIdx}/${position.total} 章`
        : undefined,
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
  /// 判定不依赖七猫弹窗的具体选择器：目标到 body 之间存在纵向可滚动
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

  /** 七猫翻章控件是站点自带的文字链接（底部「上一章 / 下一章」按钮）。 */
  private clickChapterLink(label: '上一章' | '下一章'): boolean {
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a'))
      .find(a => (a.textContent || '').trim().includes(label));
    if (!link) return false;
    link.click();
    return true;
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
      for (const id of ['reader', 'wide', 'toolbar', 'navbar', 'progress', 'layout-toggle', 'theme-text', 'theme-night', 'font-adjustable']) {
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
    // 主题文字色兜底不受能力开关影响：站点丢作用域属性时任何布局都要可读。
    this.applyStyleFile('theme-text', styles.custom?.themeText ?? '', true);
    // 深色主题底色加深（只覆盖站点 deep 主题，其他主题不受影响）。
    this.applyStyleFile('theme-night', styles.custom?.nightTone ?? '', true);
    // 「正文字体 → 可调」的字体/字重覆盖（未选可调时为空样式）。
    this.applyStyleFile('font-adjustable', this.buildAdjustableFontCss(), true);

    this.desiredDoubleColumn = doubleColumn;
    if (doubleColumn) this.enablePaginatorAfterHydration();
    else this.paginator?.disable();
    this.syncLayoutToggle();

    this.scheduleContentDiagnostics();
  }

  /*!
   * 等站点 hydrate 收尾再包裹正文（原因见 HYDRATION_POLL_MS 常量注释）。
   * 绑定只做一次：armed 之后布局切换直接 enable/disable。
   */
  private enablePaginatorAfterHydration(): void {
    const paginator = this.paginator;
    if (!paginator) return;
    if (this.paginatorBindArmed) {
      paginator.enable();
      return;
    }
    if (this.paginatorBindScheduled) return;
    this.paginatorBindScheduled = true;
    const startedAt = Date.now();
    const arm = (): void => {
      this.paginatorBindScheduled = false;
      this.paginatorBindTimer = null;
      this.paginatorBindArmed = true;
      if (this.desiredDoubleColumn) this.paginator?.enable();
    };
    const poll = (): void => {
      if (this.api === null) return; // 已卸载
      const root = document.getElementById('__nuxt');
      const hydrated = !root || !root.hasAttribute('data-server-rendered');
      if (hydrated || Date.now() - startedAt >= HYDRATION_WAIT_MAX_MS) {
        this.paginatorBindTimer = setTimeout(arm, POST_HYDRATION_SETTLE_MS);
        return;
      }
      this.paginatorBindTimer = setTimeout(poll, HYDRATION_POLL_MS);
    };
    poll();
  }

  private async restoreLayoutPreference(api: PluginAPI): Promise<void> {
    const [stored, storedWeight, storedAdjustable] = await Promise.all([
      api.storage.get<boolean>(LAYOUT_PREFERENCE_KEY),
      api.storage.get<number>(FONT_WEIGHT_KEY),
      api.storage.get<boolean>(ADJUSTABLE_FONT_KEY),
    ]);
    if (this.api !== api) return;
    const legacyValue = api.settings.get<boolean>('doubleColumn', true);
    this.doubleColumnEnabled = typeof stored === 'boolean' ? stored : legacyValue !== false;
    if (stored === null) {
      void api.storage.set(LAYOUT_PREFERENCE_KEY, this.doubleColumnEnabled);
    }
    if (typeof storedWeight === 'number'
      && storedWeight >= 0
      && storedWeight < FONT_WEIGHTS.length) {
      this.weightIndex = storedWeight;
    }
    this.adjustableFont = storedAdjustable === true;
    this.applySettings(api.settings.getAll());
  }

  /// 「可调」正文字体样式：站点字族 PingFangSC-Regular 是固定字面，取不到
  /// 细体；选中可调时换成可权重选择的系统字族（macOS: PingFang SC；
  /// Windows: 等线/微软雅黑栈，等线缺失时细档回落到常规字重）。
  /// 注意不要顺带改 font-size：站点把字号写在 p 自己的声明上，父级仍是
  /// 基字号，用 em/% 做补偿会按父级解析、把文字压小（2026-11 实证）。
  private buildAdjustableFontCss(): string {
    if (!this.adjustableFont) return '';
    const option = FONT_WEIGHTS[this.weightIndex] ?? FONT_WEIGHTS[FONT_WEIGHT_DEFAULT_INDEX];
    const stack = navigator.userAgent.includes('Windows')
      ? '"DengXian", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
      : '-apple-system, "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
    return `.chapter-detail-article p { font-family: ${stack} !important;`
      + ` font-weight: ${option.value} !important; }`;
  }

  /*!
   * 站点开机守卫（重断言两类「开机没写完」的站点状态，均为 2026-10-25
   * 真机/干净浏览器实证的同一类故障：站点 JS 冷启动偶发把模板应用跑丢）：
   *
   * 1. 阅读主题：七猫把主题（default/blue/yellow/green/red/dark）存在
   *    localStorage 的 qimao_reader_setting_data，由站点 JS 启动时写到
   *    .reader-layout-theme[data-theme]——偶发不落地，用户看到「设置过
   *    夜间但进页是白底」（壳层在七猫上不注入任何主题：manifest 声明
   *    nativeTheme 完全让位）。读站点自己的存储代写一次属性。
   * 2. 正文类模板：偶发正文元素一个类都没写（variant-inventory 实锤：
   *    .chapter-detail-wrap-content > DIV.(无类) > .article，健康形态是
   *    .chapter-detail-article.font-18）——站点排版 CSS 失效呈全宽单列，
   *    插件选择器/探针/分页器也全部失明。正文已渲染时按结构定位该元素，
   *    补写 chapter-detail-article 与存储推导的 font-N 字号类；类一回来，
   *    分页器完整性轮询与过场探针即刻恢复视野。
   *
   * 两项都只写「站点本该自己写的」属性/类，无结构改动；站点启动正常时
   * 全部空转收工。轮询 300ms × 40 = 12s 后放弃（超时说明是别的故障）。
   */
  private startBootGuard(): void {
    if (this.bootGuardTimer !== null) return;
    this.bootGuardTicks = 0;
    this.bootGuardTimer = setInterval(() => {
      this.bootGuardTicks++;
      if (this.bootGuardTicks > BOOT_GUARD_MAX_TICKS || !this.isReaderPage()) {
        this.stopBootGuard();
        return;
      }
      const themeDone = this.reassertThemeAttr();
      const articleDone = this.reassertArticleClass();
      if (themeDone && articleDone) this.stopBootGuard();
    }, BOOT_GUARD_TICK_MS);
  }

  /** @returns true = 该项已收工（已落地/代写完成/无事可做） */
  private reassertThemeAttr(): boolean {
    const host = document.querySelector<HTMLElement>('.reader-layout-theme');
    if (!host) return false; // 站点容器未挂载：继续等
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(QIMAO_READER_SETTING_KEY);
    } catch {
      return true; // 存储不可用：无从得知站点偏好
    }
    if (!stored) return true; // 无站点阅读偏好：主题本就是站点默认
    let theme: unknown;
    try {
      theme = JSON.parse(stored)?.theme;
    } catch {
      return true; // 存储格式非预期：不干预
    }
    if (typeof theme !== 'string' || theme.length === 0) return true;
    if (host.getAttribute('data-theme') === theme) return true; // 已自行落地
    host.setAttribute('data-theme', theme);
    logToFile(`[Qimao] boot guard reasserted data-theme=${theme}`);
    return true;
  }

  /** @returns true = 该项已收工（已就位/补写完成/正文未渲染不归本守卫管） */
  private reassertArticleClass(): boolean {
    // 正文未渲染（.article 不存在）= 内容缺失，是看门狗的管辖范围
    const inner = document.querySelector<HTMLElement>(
      '.chapter-detail-wrap-content .article',
    );
    if (!inner) return true;
    const article = inner.parentElement;
    if (!article) return true;
    if (article.classList.contains('chapter-detail-article')) return true; // 已就位
    // 结构不符（类元素不在预期容器下）：不动，避免误伤未知形态
    if (!article.parentElement?.classList.contains('chapter-detail-wrap-content')) {
      return true;
    }
    article.classList.add('chapter-detail-article');
    // 字号类从站点自身存储重建（font-18 等），缺失时站点字号样式不生效
    try {
      const size = JSON.parse(
        localStorage.getItem(QIMAO_READER_SETTING_KEY) ?? 'null',
      )?.fontSize;
      if (typeof size === 'string' && /^\d+$/.test(size)) {
        article.classList.add(`font-${size}`);
      }
    } catch {
      // 存储不可用：只补布局类
    }
    logToFile('[Qimao] boot guard reasserted chapter-detail-article (site class template missing)');
    return true;
  }

  private stopBootGuard(): void {
    if (this.bootGuardTimer !== null) {
      clearInterval(this.bootGuardTimer);
      this.bootGuardTimer = null;
    }
    this.bootGuardTicks = 0;
  }

  /*!
   * 失败取证采样：健康加载零输出；进页 5 秒后仍无正文（服务端内容缺失或
   * 类模板变体）才写一次诊断与变体结构采样——「正文可见但 nodes=0」时
   * variant-inventory 会给出正文实际所在结构，供分页器自适应绑定。
   */
  private scheduleContentDiagnostics(): void {
    if (this.diagnosticsTimers.length > 0) {
      for (const timer of this.diagnosticsTimers) window.clearTimeout(timer);
      this.diagnosticsTimers = [];
    }
    this.diagnosticsTimers.push(window.setTimeout(() => this.logContentDiagnostics(), 5000));
  }

  private logContentDiagnostics(): void {
    if (!this.api || !this.isReaderPage()) return;
    const contents = document.querySelectorAll<HTMLElement>(QIMAO_CONTENT_SELECTOR);
    if (contents.length > 0) return; // 健康态不打日志
    const themeHost = document.querySelector<HTMLElement>('.reader-layout-theme');
    let storedTheme: string | null = null;
    try {
      storedTheme = JSON.parse(localStorage.getItem(QIMAO_READER_SETTING_KEY) ?? 'null')?.theme ?? null;
    } catch {
      storedTheme = null;
    }
    const bg = document.body ? getComputedStyle(document.body).backgroundColor : '?';
    const stats = this.paginator?.getStats();
    logToFile(
      `[Qimao] diagnose nodes=0`
      + ` dataTheme=${themeHost?.getAttribute('data-theme') ?? '(no-host)'}`
      + ` storedTheme=${storedTheme ?? '(none)'}`
      + ` bg=${bg}`
      + ` pager=${stats ? JSON.stringify(stats) : 'null'}`,
    );
    this.logVariantInventory();
  }

  /*!
   * 变体取证：阅读页上正文选择器匹配为零，但站点自身可能已把正文渲染进
   * 另一套 DOM（2026-10-25 实锤一次：内容可见、主题正常、nodes=0，服务端
   * 状态粘滞约 1 分钟、重载无效后自愈）。把正文实际所在的结构采进日志
   * （最长文本段落的祖先链 + iframe + body 直接子元素），复现一次即可
   * 拿到分页器自适应绑定所需的全部结构信息。
   */
  private logVariantInventory(): void {
    const firstLongP = Array.from(document.querySelectorAll<HTMLElement>('p'))
      .find(p => (p.textContent || '').length > 100) ?? null;
    const chain: string[] = [];
    for (let node: HTMLElement | null = firstLongP, depth = 0;
      node && depth < 5;
      node = node.parentElement, depth++) {
      chain.push(`${node.tagName}.${String(node.className).slice(0, 80)}`);
    }
    const iframes = Array.from(document.querySelectorAll('iframe'))
      .map(f => (f.src || '').slice(0, 80))
      .join(' | ');
    const bodyChildren = Array.from(document.body?.children ?? [])
      .slice(0, 12)
      .map(c => `${c.tagName}.${String(c.className).slice(0, 40)}`)
      .join(' | ');
    logToFile(
      `[Qimao] variant-inventory`
      + ` firstP=${firstLongP ? (firstLongP.textContent || '').slice(0, 30) : '(none)'}`
      + ` chain=${chain.join(' < ') || '(none)'}`
      + ` iframes=${iframes || '(none)'}`
      + ` bodyChildren=${bodyChildren || '(none)'}`,
    );
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
    // 插件可能在 <body> 与七猫工具栏创建前加载，因此从文档根节点开始监听。
    this.toolbarObserver.observe(root, { childList: true, subtree: true });
    this.syncLayoutToggle();
    this.syncAdjustableFontPanel();
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
      this.syncAdjustableFontPanel();
    });
  }

  private syncLayoutToggle(): void {
    /*! @capability doubleColumn [功能能力 1/6：双栏模式] 只在能力开启时增强七猫原生工具栏。 */
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

    const host = document.querySelector<HTMLElement>('.qm-fixed-right');
    if (!host) {
      this.ensureToolbarBootstrap();
      return;
    }
    if (!this.layoutToggleButton) {
      const item = document.createElement('li');
      item.className = 'atreader-qimao-layout-toggle';
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.addEventListener('click', this.toggleLayoutMode);
      item.addEventListener('keydown', this.handleLayoutToggleKeydown);
      this.layoutToggleButton = item;
    }
    if (this.layoutToggleButton.parentElement !== host) {
      // 插入为首个条目：官方卡片的顶部圆角由首条目承担，末条目（举报）
      // 保持站点原生样式，底部圆角不会被抢走。
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
    text.className = 'title';
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

  /*!
   * 「阅读设置 → 正文字体」注入「可调」选项，并在其下方注入「字重大小」
   * 行（粗/中/细）。站点条目是 Vue 渲染的 scoped 节点：克隆现有条目，
   * 拿到同样的 class/作用域属性与主题配色，只挂我们自己的事件；面板每次
   * 重新渲染后由文档观察器补回（与右侧工具栏同一机制）。
   */
  private syncAdjustableFontPanel(): void {
    if (!this.isReaderPage()) return;
    const set = document.querySelector<HTMLElement>('.font-family-set');
    if (!set) {
      this.adjustableOption = null;
      this.adjustableRow = null;
      return;
    }
    const template = set.querySelector<HTMLElement>('.font-family-set-item');
    if (!template) return;

    if (!this.adjustableOption?.isConnected) {
      const option = template.cloneNode(true) as HTMLElement;
      option.classList.remove('active');
      option.classList.add('atreader-qimao-font-adjustable');
      option.textContent = '可调';
      option.addEventListener('click', this.enableAdjustableFont);
      set.append(option);
      this.adjustableOption = option;
      // 点站点自带的两项时退出「可调」；站点内部状态可能仍认为该项已选中
      // 而不再重写选中态，这里手动把选中态补到被点的项上。
      set.querySelectorAll<HTMLElement>('.font-family-set-item').forEach(item => {
        if (item === option || item.dataset.atreaderExitGuard === '1') return;
        item.dataset.atreaderExitGuard = '1';
        item.addEventListener('click', () => {
          this.disableAdjustableFont();
          this.markSiteFontItemActive(item);
        });
      });
    }

    // 面板「恢复默认」会重写全部阅读偏好：一起退出可调，避免覆盖样式把
    // 恢复结果又压回去。
    const panel = set.closest('.qm-mod.reader-setting') ?? set.closest('.qm-mod');
    const resetButton = panel?.querySelector<HTMLElement>('.qm-mod-th .qm-btn');
    if (resetButton && resetButton.dataset.atreaderExitGuard !== '1') {
      resetButton.dataset.atreaderExitGuard = '1';
      resetButton.addEventListener('click', this.disableAdjustableFont);
    }

    if (!this.adjustableRow?.isConnected) {
      const fontItem = set.closest('li');
      if (!fontItem) return;
      const row = fontItem.cloneNode(true) as HTMLElement;
      row.classList.add('atreader-qimao-weight-row');
      const dt = row.querySelector('dt');
      const dd = row.querySelector('dd');
      if (!dt || !dd) return;
      dt.textContent = '字重大小：';
      dd.className = 'font-family-set atreader-qimao-weight-set';
      dd.replaceChildren();
      FONT_WEIGHTS.forEach((weight, index) => {
        const item = template.cloneNode(true) as HTMLElement;
        item.classList.remove('active');
        item.classList.add('atreader-qimao-weight-option');
        item.textContent = weight.label;
        item.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          this.selectFontWeight(index);
        });
        dd.append(item);
      });
      fontItem.after(row);
      this.adjustableRow = row;
    }

    this.updateAdjustableFontPanel();
  }

  private updateAdjustableFontPanel(): void {
    if (this.adjustableOption) {
      this.adjustableOption.classList.toggle('active', this.adjustableFont);
      if (this.adjustableFont) {
        this.adjustableOption.parentElement
          ?.querySelectorAll('.font-family-set-item')
          .forEach(item => {
            if (item !== this.adjustableOption) item.classList.remove('active');
          });
      }
    }
    if (this.adjustableRow) {
      this.adjustableRow.style.display = this.adjustableFont ? '' : 'none';
      this.adjustableRow
        .querySelectorAll('.atreader-qimao-weight-option')
        .forEach((item, index) => item.classList.toggle('active', index === this.weightIndex));
      // 站点面板高度是定值（.qm-mod.reader-setting 设了固定 height），
      // 追加一行后会溢出背景；显示字重行时放开高度，退出可调后还原站点值。
      const panel = this.adjustableRow.closest<HTMLElement>('.qm-mod.reader-setting');
      if (panel) panel.style.height = this.adjustableFont ? 'auto' : '';
    }
  }

  private readonly enableAdjustableFont = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    const api = this.api;
    if (!api || this.adjustableFont) return;
    this.adjustableFont = true;
    void api.storage.set(ADJUSTABLE_FONT_KEY, true);
    this.applySettings(api.settings.getAll());
    this.updateAdjustableFontPanel();
  };

  private readonly disableAdjustableFont = (): void => {
    const api = this.api;
    if (!api || !this.adjustableFont) return;
    this.adjustableFont = false;
    void api.storage.set(ADJUSTABLE_FONT_KEY, false);
    this.applySettings(api.settings.getAll());
    this.updateAdjustableFontPanel();
  };

  private markSiteFontItemActive(target: HTMLElement): void {
    target.parentElement?.querySelectorAll<HTMLElement>('.font-family-set-item')
      .forEach(item => item.classList.toggle('active', item === target));
  }

  private selectFontWeight(index: number): void {
    const api = this.api;
    if (!api) return;
    this.weightIndex = index;
    void api.storage.set(FONT_WEIGHT_KEY, index);
    if (this.adjustableFont) this.applySettings(api.settings.getAll());
    this.updateAdjustableFontPanel();
  }

  private readonly handleLayoutToggleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.toggleLayoutMode();
  };

  private removeLayoutToggle(): void {
    this.layoutToggleButton?.remove();
    this.layoutToggleButton = null;
    this.adjustableOption?.remove();
    this.adjustableOption = null;
    this.adjustableRow?.remove();
    this.adjustableRow = null;
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
    return `${location.pathname}${location.search}`;
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
}

export default QimaoPlugin;
