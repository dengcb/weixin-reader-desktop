/*!
 * 掌阅插件（pc.ireader.com）
 *
 * 掌阅 PC 阅读器为 Nuxt SPA 滚动流正文（.reader-content 纯文本 p），
 * 站点自身只有目录按钮，没有任何排版能力——本插件提供完整的阅读增强
 * （对标七猫插件，共享同一套 ColumnPaginator）：
 *
 * 1. 双栏模式：CSS 多栏分页（右工具栏「单双」键切换，偏好持久化）；
 * 2. 目录：工具栏「目录」键开关站点原生抽屉（开→点原生态关闭键，关→点目录键）；
 * 3. 深浅切换：站点仅有浅色，插件注入深色主题（「深浅」键切换）；
 * 4. 字体：工具栏「字体」键弹出左侧面板，滑杆调节字号（16~32 步进 2）
 *    与字形（粗=站方 509R / 中=506L / 细=504L，后两者为 CDN 反爬适配
 *    字重，私用码位已映射到字库内同字形）；
 * 5. 翻页：双栏时滚轮/←→ 为整页翻页；切章复用站点原生能力——
 *    站点监听 ←/→ 方向键切换 ?chapter=N 参数，插件的章节切换派发
 *    带标记的合成方向键（自身捕获器见到标记即放行，不会死循环）；
 * 6. 翻页溢出：← 在本章第一页溢出落上一章结尾，显式跳章落章首；
 * 7. 登录态持久化：会话 cookie _zypps 改写为持久 cookie（见下）；
 * 8. 站内返回：站点返回键与 ⌘[（菜单「后退」）走插件的站内轨迹回退，
 *    绝不跨书城——单窗口的 history 栈混有其他站点页面，站点返回键的
 *    history.back() 会把用户甩到微信读书等上一站。
 *
 * nativeTheme：深浅完全由本插件的深色主题控制，禁止壳层反色滤镜。
 * 不复制正文、不破解字体，也不抓取或导出内容。
 */

import type {
  BookProgress,
  PluginAPI,
  PluginManifest,
  PluginStyles,
  ReaderPlugin,
} from '../../src/scripts/core/plugin_types';
// api.log 是 console-only 实现（core/logger.ts），落文件诊断必须走 logToFile
import { logToFile, ensureFontCache } from '../../src/scripts/core/tauri';
import { setSiteReadinessProbe } from '../../src/scripts/core/site_switch_loading';
import {
  armReaderEntryWatchdog,
  stylesheetsReady,
} from '../shared/reader_entry_watchdog';
import {
  ColumnPaginator,
} from '../shared/column_paginator';

const IREADER_PAGED_CLASS = 'atreader-ireader-paged';
const IREADER_NO_TRANSITION_CLASS = 'atreader-ireader-no-transition';
const IREADER_DARK_CLASS = 'atreader-ireader-dark';
const IREADER_CONTENT_SELECTOR = '.reader-content';
const PREVIOUS_CHAPTER_FLAG = 'atreader-ireader-open-previous-at-end';
const CHAPTER_START_FLAG = 'atreader-ireader-open-chapter-at-start';
const CHAPTER_NAVIGATION_FLAG_TTL = 15_000;
const WHEEL_THRESHOLD = 56;
const WHEEL_RESET_MS = 220;
const WHEEL_COOLDOWN_MS = 520;
const SCROLLABLE_OVERFLOW_Y = new Set(['auto', 'scroll', 'overlay']);
const LAYOUT_PREFERENCE_KEY = 'double-column-enabled';
const DARK_PREFERENCE_KEY = 'dark-enabled';
const FONT_STEP_KEY = 'font-step';
const FONT_WEIGHT_KEY = 'font-weight-index';
/// 字号档位（px）。默认档 28px（index 6），滑杆范围 16~32、步进 2；
/// index 1（18px）为站点原生字号。
const FONT_STEPS = [16, 18, 20, 22, 24, 26, 28, 30, 32];
const FONT_DEFAULT_INDEX = 6;
const FONT_NATIVE_INDEX = 1;
/*!
 * 字形档位：0=粗（站方 509R 原字体，不注入任何字体），
 * 1=中（CDN 506L_pua，默认档），2=细（CDN 504L_pua）。两个 CDN 字体均已把
 * 反爬私用码位别名映射到字库内同字形（见 reader.css 说明）。
 */
const FONT_WEIGHTS = [
  { label: '粗', family: '', url: '' },
  {
    label: '中',
    family: 'FZYouH Mid',
    url: 'https://cdn.dengcb.net/fonts/FZYouH_506L_pua.ttf',
  },
  {
    label: '细',
    family: 'FZYouH Thin',
    url: 'https://cdn.dengcb.net/fonts/FZYouH_504L_pua.ttf',
  },
] as const;
const FONT_WEIGHT_DEFAULT_INDEX = 1;
/// 字体偏好版本：v2 起默认 28px/中。升级后首次加载重置一次旧偏好并盖戳，
/// 之后用户手动调节照常持久化。偏好存站点 localStorage，卸载重装不清除。
const FONT_PREFS_VERSION = 2;
const FONT_PREFS_VERSION_KEY = 'font-prefs-version';
const LOGIN_COOKIE = '_zypps';
/// 登录态持久化时长：180 天。每次页面加载都会重新续期。
const PIN_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/// 章节切换合成方向键的标记：本插件的捕获器见到即放行，交由站点原生切章。
const CHAPTER_NAV_FLAG = '__atreaderIreaderChapterNavigation';
/// 站内导航轨迹的 sessionStorage 键与容量上限（跨整页加载保留，站点域隔离）。
const TRAIL_STORAGE_KEY = 'atreader-ireader-trail';
const TRAIL_MAX_ENTRIES = 50;

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

const CATALOG_ICON = `
  <svg width="24" height="24" viewBox="0 0 24 24"
    fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h10" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

const MOON_ICON = `
  <svg width="24" height="24" viewBox="0 0 24 24"
    fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z" stroke="currentColor"
      stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;

const SUN_ICON = `
  <svg width="24" height="24" viewBox="0 0 24 24"
    fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.5"/>
    <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

const FONT_ICON = `
  <svg width="24" height="24" viewBox="0 0 24 24"
    fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 19 10.6 5h.8L17 19M6.2 13.6h8.4" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M20.2 9.5v6M17.9 11.8h4.6" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

// 运行时代码中不内联 manifest 的 base64 图标，避免插件编辑器顶部出现超长数据行。
const IREADER_RUNTIME_MANIFEST: PluginManifest = {
  id: 'ireader',
  name: '掌阅',
  version: '1.0.1',
  description: '掌阅 PC 网页版网站支持插件（官方）',
  author: '艾特阅读团队',
  homepage: 'https://github.com/dengcb/weixin-reader-desktop',
  sourceType: 'web',
  renderMode: 'webview',
  site: {
    domain: ['pc.ireader.com'],
    homeUrl: 'https://pc.ireader.com/',
    readerPattern: '/reader/\\d+',
  },
  capabilities: {
    wideMode: true,
    autoFlip: true,
    chapterNav: true,
    doubleColumn: true,
    hideToolbar: true,
    // 进度追踪：底部「当前页 / 总页数」指示器及其预留高度的总开关。
    progressTracker: true,
    // 深浅由本插件控制（深色主题样式），壳层不得注入反色滤镜。
    nativeTheme: true,
  },
};

/** 生成登录态持久化改写串。独立导出便于单测断言属性。 */
export function buildPinCookieString(value: string): string {
  return `${LOGIN_COOKIE}=${value}; Max-Age=${PIN_MAX_AGE_SECONDS}; path=/`;
}

/**
 * 计算站内回退决策。独立导出便于单测。
 * 轨迹栈顶约定为当前页：栈顶不符视为脏数据；有上一条且异于当前页则
 * 回退并弹出栈顶，否则清空落首页。
 */
export function nextSiteBack(
  trail: string[],
  currentUrl: string,
  homeUrl: string,
): { url: string; trail: string[] } {
  const top = trail[trail.length - 1];
  const target = trail.length >= 2 ? trail[trail.length - 2] : null;
  if (top === currentUrl && target && target !== currentUrl) {
    return { url: target, trail: trail.slice(0, -1) };
  }
  return { url: homeUrl, trail: [] };
}

export class IreaderPlugin implements ReaderPlugin {
  readonly manifest = IREADER_RUNTIME_MANIFEST;

  private api: PluginAPI | null = null;
  private paginator: ColumnPaginator | null = null;
  private diagnosticsTimers: number[] = [];
  private disarmWatchdog: (() => void) | null = null;
  private cleanupFunctions: Array<() => void> = [];
  private restoreGeneration = 0;
  private positionReady = false;
  private wheelAccumulator = 0;
  private wheelResetTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelCooldown = false;
  private doubleColumnEnabled = true;
  private darkEnabled = false;
  private fontStep = FONT_DEFAULT_INDEX;
  private weightIndex = FONT_WEIGHT_DEFAULT_INDEX;
  /**
   * 字体来源状态。face = 字节经 IPC 直供并以 FontFace(ArrayBuffer) 注册进
   * document.fonts（零网络，唯一可靠通道——WebKit 对页面内字体资源加载
   * 偶发整体拦截，远程 URL 与自定义协议子资源均不能幸免，2026-10-25 双重
   * 实证）；remote = @font-face 远程 URL 回退（无 Tauri/缓存失败时）。
   */
  private fontSourceState: 'idle' | 'face' | 'remote' | 'failed' = 'idle';
  private fontSourceUrl: string | null = null;
  private readonly registeredFontUrls = new Set<string>();
  private readonly fontFaceLoads = new Map<string, Promise<void>>();
  private toolbar: HTMLDivElement | null = null;
  private toolbarButtons: Record<string, HTMLButtonElement> = {};
  private fontPanel: HTMLDivElement | null = null;

  onLoad(api: PluginAPI): void {
    this.api = api;
    api.log.info('Ireader plugin loaded');

    // 登录态持久化：会话 cookie 改写为持久 cookie（见 buildPinCookieString）。
    // SPA 内路由变化同时是「离开/进入阅读页」的唯一信号，需要重估样式注入。
    const routeChanged = () => {
      this.pinLoginCookie();
      this.applySettings(api.settings.getAll());
    };
    window.addEventListener('ipc:route-changed', routeChanged);
    window.addEventListener('wxrd:route-changed', routeChanged);
    this.cleanupFunctions.push(() => {
      window.removeEventListener('ipc:route-changed', routeChanged);
      window.removeEventListener('wxrd:route-changed', routeChanged);
    });
    this.pinTimer = window.setInterval(() => this.pinLoginCookie(), 2000);

    this.paginator = new ColumnPaginator({
      pagedClass: IREADER_PAGED_CLASS,
      noTransitionClass: IREADER_NO_TRANSITION_CLASS,
      viewportClass: 'atreader-ireader-page-viewport',
      indicatorClass: 'atreader-ireader-page-indicator',
      contentSelector: IREADER_CONTENT_SELECTOR,
      // wrap 绑定 = v1.0.0 结构：视口包裹层只做裁剪，高度/多栏/位移都在正文
      // 子元素上（裁剪框不随 transform 平移）。10-25 改成 self 绑定后裁剪与
      // 位移合并到正文自身，翻页时正文带着自己的裁剪框一起平移——第 1 页
      // 正常、其余页全空（2026-11 实证）。Nuxt 重渲染导致的正文重绑由分页
      // 器断连自愈轮询（400ms）兜底。
      bindMode: 'wrap',
      getChapterKey: () => this.getChapterKey(),
      onChapterChange: chapterKey => this.restoreChapterPosition(chapterKey),
      onAnomaly: detail => {
        logToFile(`[Ireader] anomaly ${detail} chapterKey=${this.getChapterKey()}`);
      },
      onPositionChange: (pageIndex, pageCount) => {
        if (!this.positionReady || pageCount <= 0) return;
        const ratio = pageCount <= 1 ? 0 : pageIndex / (pageCount - 1);
        void this.api?.storage.set(this.positionStorageKey(this.getChapterKey()), ratio);
      },
    });

    window.addEventListener('keydown', this.handleKeyboard, { capture: true });
    window.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });
    window.addEventListener('click', this.handleSiteBackClick, { capture: true });
    window.addEventListener('click', this.handlePanelOutsideClick, { capture: true });
    this.cleanupFunctions.push(() => {
      window.removeEventListener('keydown', this.handleKeyboard, { capture: true });
      window.removeEventListener('wheel', this.handleWheel, { capture: true });
      window.removeEventListener('click', this.handleSiteBackClick, { capture: true });
      window.removeEventListener('click', this.handlePanelOutsideClick, { capture: true });
    });
    this.installTrailTracker();

    // 进页失速看门狗 + 过场层就绪探针：站点 CSS 偶发迟到（正文存在但无样式
    // =裸页单列白底）。就绪判据必须含样式感知：裸页内容背景是透明的。
    if (this.isReaderPage()) {
      const presented = (): boolean =>
        stylesheetsReady(document)
        && !!document.querySelector(`${IREADER_CONTENT_SELECTOR} p`);
      setSiteReadinessProbe(presented);
      this.disarmWatchdog = armReaderEntryWatchdog({
        pluginId: 'ireader',
        isReady: presented,
        log: message => logToFile(`[Ireader] ${message}`),
      });
    }

    const unsubscribe = api.settings.subscribe(settings => this.applySettings(settings));
    this.cleanupFunctions.push(unsubscribe);
    this.applySettings(api.settings.getAll());
    void this.restorePreferences(api);
  }

  private pinTimer: number | null = null;

  onUnload(): void {
    this.restoreGeneration++;
    this.clearWheelState();
    this.disarmWatchdog?.();
    this.disarmWatchdog = null;
    for (const timer of this.diagnosticsTimers) window.clearTimeout(timer);
    this.diagnosticsTimers = [];
    if (this.pinTimer !== null) {
      window.clearInterval(this.pinTimer);
      this.pinTimer = null;
    }
    this.paginator?.destroy();
    this.paginator = null;
    document.body?.classList.remove(IREADER_PAGED_CLASS, IREADER_DARK_CLASS);
    this.removeToolbar();
    this.removeFontPanel();
    this.cleanupFunctions.forEach(cleanup => cleanup());
    this.cleanupFunctions = [];

    if (this.api) {
      for (const id of ['reader', 'wide', 'dark', 'font', 'toolbar', 'progress']) {
        this.api.style.remove(id);
      }
      this.api.log.info('Ireader plugin unloaded');
    }
    this.api = null;
  }

  isReaderPage(): boolean {
    return /^\/reader\/\d+/.test(window.location.pathname);
  }

  isHomePage(): boolean {
    const pathname = window.location.pathname;
    return pathname === '/' || pathname === '' || pathname === '/bookshelf';
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

  isDoubleColumn(): boolean {
    return this.paginator?.isActive() ?? false;
  }

  isAtBottom(): boolean {
    if (this.paginator?.isActive()) return this.paginator.isAtLastPage();
    const totalHeight = document.documentElement.scrollHeight;
    return window.innerHeight + window.scrollY >= totalHeight - 300;
  }

  getChapterProgress(): number {
    if (this.paginator?.isActive()) {
      return Math.round(this.paginator.getPositionRatio() * 100);
    }
    const totalHeight = document.documentElement.scrollHeight;
    if (totalHeight <= 0) return 0;
    return Math.min(100, Math.round((window.scrollY / totalHeight) * 100));
  }

  async getBookProgress(): Promise<BookProgress | null> {
    const match = /[?&]chapter=(\d+)/.exec(window.location.search);
    if (!match) return null;
    const chapterIdx = Number(match[1]);
    return { chapterIdx, summary: `第 ${chapterIdx} 章` };
  }

  getStyles(): PluginStyles {
    const file = (name: string): string => this.api?.style.getFile(name) ?? '';
    return {
      wideMode: {
        enabled: file('wide.css'),
        disabled: '',
      },
      custom: {
        reader: file('reader.css'),
        dark: file('dark.css'),
        font: this.buildFontCss(),
        toolbar: file('toolbar.css'),
        progress: file('progress.css'),
      },
    };
  }

  getReaderMenuItems(): string[] {
    return ['reader_wide', 'hide_toolbar', 'auto_flip'];
  }

  // ==================== 登录态持久化 ====================

  /*!
   * @capability 登录态持久化
   * 掌阅把登录凭据放在会话 cookie `_zypps`（无过期时间，进程退出即清除；
   * Chrome 完全退出同样会丢——实测）。每次页面加载/路由变化/2 秒周期把它
   * 原值改写为带 Max-Age 的持久 cookie，等价于浏览器「记住登录」。用户在
   * 站点退出登录时站点会删除该 cookie，插件见不到值就不会复活它。
   */
  private pinLoginCookie(): void {
    if (!this.matchesDomain()) return;
    const value = this.readCookieValue(LOGIN_COOKIE);
    if (!value) return;
    document.cookie = buildPinCookieString(value);
  }

  private readCookieValue(name: string): string | null {
    for (const pair of document.cookie.split(';')) {
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      if (pair.slice(0, separator).trim() === name) {
        return pair.slice(separator + 1);
      }
    }
    return null;
  }

  // ==================== 站内返回 ====================

  /*!
   * 单窗口壳的 history 栈混有其他书城页面，站点返回键的 history.back()
   * 会把用户甩出掌阅（跳到微信读书等上一站）。本插件自行维护同站轨迹：
   * 包装 pushState/replaceState + popstate，返回时沿轨迹回退，无轨迹落首页。
   * 菜单「后退」（⌘[）经 __ATREADER_RUNTIME__.back() 也走这里。
   */
  back(): void {
    this.goSiteBack();
  }

  private readonly handleSiteBackClick = (event: MouseEvent): void => {
    if (!this.isReaderPage()) return;
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target as HTMLElement | null;
    const title = target?.closest?.('.reader-header-title') ?? null;
    if (!title) return;
    const button = title.querySelector('button.zy-btn');
    if (!button || !button.contains(target as Node)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.goSiteBack();
  };

  private goSiteBack(): void {
    const homeUrl = this.manifest.site?.homeUrl ?? 'https://pc.ireader.com/';
    const decision = nextSiteBack(this.readTrail(), window.location.href, homeUrl);
    this.writeTrail(decision.trail);
    // 轨迹条目全部产自本站 location.href；同源校验防 sessionStorage 被站点脚本篡改。
    this.navigateTo(this.isSameOriginUrl(decision.url) ? decision.url : homeUrl);
  }

  private navigateTo(url: string): void {
    window.location.href = url;
  }

  private isSameOriginUrl(url: string): boolean {
    try {
      return new URL(url).origin === window.location.origin;
    } catch {
      return false;
    }
  }

  private installTrailTracker(): void {
    const resolveUrl = (url: string | URL | null | undefined): string => {
      if (url === null || url === undefined || url === '') return window.location.href;
      try {
        return new URL(url instanceof URL ? url.href : String(url), window.location.href).href;
      } catch {
        return window.location.href;
      }
    };
    const originalPush = history.pushState.bind(history);
    const originalReplace = history.replaceState.bind(history);
    history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
      originalPush(data, unused, url);
      this.recordTrail(resolveUrl(url), 'push');
    }) as typeof history.pushState;
    history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
      originalReplace(data, unused, url);
      this.recordTrail(resolveUrl(url), 'replace');
    }) as typeof history.replaceState;
    const onPopState = () => this.recordTrail(window.location.href, 'pop');
    window.addEventListener('popstate', onPopState);
    this.cleanupFunctions.push(() => {
      window.removeEventListener('popstate', onPopState);
      history.pushState = originalPush;
      history.replaceState = originalReplace;
    });
    this.recordTrail(window.location.href, 'seed');
  }

  private recordTrail(url: string, kind: 'push' | 'replace' | 'pop' | 'seed'): void {
    const trail = this.readTrail();
    if (kind === 'pop') {
      const index = trail.lastIndexOf(url);
      this.writeTrail(index >= 0 ? trail.slice(0, index + 1) : [url]);
      return;
    }
    if (kind === 'replace') {
      if (trail.length === 0) trail.push(url);
      else trail[trail.length - 1] = url;
      this.writeTrail(trail);
      return;
    }
    if (trail[trail.length - 1] === url) return;
    trail.push(url);
    this.writeTrail(trail);
  }

  private readTrail(): string[] {
    try {
      const parsed: unknown = JSON.parse(sessionStorage.getItem(TRAIL_STORAGE_KEY) ?? '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item): item is string => typeof item === 'string')
        .slice(-TRAIL_MAX_ENTRIES);
    } catch {
      return [];
    }
  }

  private writeTrail(trail: string[]): void {
    try {
      sessionStorage.setItem(
        TRAIL_STORAGE_KEY,
        JSON.stringify(trail.slice(-TRAIL_MAX_ENTRIES)),
      );
    } catch {
      // sessionStorage 不可用时轨迹仅当次会话无效，返回落首页兜底。
    }
  }

  // ==================== 翻页与章节 ====================

  private readonly handleKeyboard = (event: KeyboardEvent): void => {
    // 章节切换的合成方向键：放行给站点原生处理器。
    if ((event as KeyboardEvent & { [CHAPTER_NAV_FLAG]?: boolean })[CHAPTER_NAV_FLAG]) return;
    if (event.key === 'Escape' && this.fontPanel?.isConnected) {
      this.removeFontPanel();
      return;
    }
    if (!this.paginator?.isActive()) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target?.matches('input, textarea, select')) return;

    const keyMatches = (key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => (
      event.key === key || event.code === key
    );

    if (keyMatches('ArrowRight')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.nextPage();
    } else if (keyMatches('ArrowLeft')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.prevPage();
    } else if (
      keyMatches('ArrowUp')
      && this.manifest.capabilities.chapterNav === true
    ) {
      this.api?.toast.show('上一章');
      event.preventDefault();
      event.stopImmediatePropagation();
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
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('.atreader-ireader-toolbar, .atreader-ireader-font-panel')) return;
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

  private isWithinNativeScrollArea(target: EventTarget | null): boolean {
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

  /*!
   * @capability chapterNav
   * 切章复用站点原生能力：站点监听 ←/→ 方向键切换 ?chapter=N 参数。
   * 派发带标记的合成方向键——本插件捕获器见到标记即放行，不会自循环。
   */
  prevChapter(): boolean {
    return this.dispatchChapterArrow('ArrowLeft');
  }

  nextChapter(): boolean {
    return this.dispatchChapterArrow('ArrowRight');
  }

  private dispatchChapterArrow(key: 'ArrowLeft' | 'ArrowRight'): boolean {
    if (!this.isReaderPage()) return false;
    // KeyboardEventInit 不含 keyCode/which，塞进去会被构造器静默忽略
    // （事件实际 keyCode===0）；当前站点读 e.key，需要 keyCode 时应用
    // defineProperty 显式注入（2026-11 审计 L-P1-3）。
    const event = new KeyboardEvent('keydown', {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, CHAPTER_NAV_FLAG, { value: true });
    document.dispatchEvent(event);
    return true;
  }

  private getChapterKey(): string {
    return `${location.pathname}${location.search}`;
  }

  private positionStorageKey(chapterKey: string): string {
    return `spread:${chapterKey}`;
  }

  private restoreChapterPosition(chapterKey: string): void {
    const api = this.api;
    const paginator = this.paginator;
    if (!api || !paginator) return;
    const generation = ++this.restoreGeneration;
    this.positionReady = false;

    const openMode = this.consumeChapterOpenMode();
    if (openMode === 'end') {
      paginator.requestOpenAtEnd();
    }
    if (openMode !== null) {
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

  private clearWheelState(): void {
    if (this.wheelResetTimer) clearTimeout(this.wheelResetTimer);
    if (this.wheelCooldownTimer) clearTimeout(this.wheelCooldownTimer);
    this.wheelResetTimer = null;
    this.wheelCooldownTimer = null;
    this.wheelAccumulator = 0;
    this.wheelCooldown = false;
  }

  // ==================== 深浅与字体 ====================

  /*! 字号与字形均为默认时不注入任何样式，正文保持站点原生形态。 */
  private buildFontCss(): string {
    const rules: string[] = [];
    const weight = FONT_WEIGHTS[this.weightIndex];
    if (weight && weight.url) {
      rules.push(
        `.reader-content p { font-family: '${weight.family}', FZYouH, sans-serif !important; }`,
      );
      // @font-face 仅在远程 URL 回退路径需要；face 路径的字体已经字节直供
      // 注册进 document.fonts，不再走任何网络加载（见 ensureFontSource 说明）。
      if (this.fontSourceState === 'remote') {
        rules.push(
          `@font-face { font-family: '${weight.family}';`
          + ` src: url('${weight.url}') format('truetype'); font-display: swap; }`,
        );
      }
    }
    if (this.fontStep !== FONT_NATIVE_INDEX) {
      const size = FONT_STEPS[this.fontStep];
      if (size) {
        rules.push(
          `.reader-content p { font-size: ${size}px !important;`
          + ' line-height: 1.85 !important; margin-bottom: 1.25em !important; }',
        );
      }
    }
    return rules.join('\n');
  }

  /*! 站点原生态（18px + 粗）时不注入任何字体样式，正文保持站点原生形态。 */
  private isFontNative(): boolean {
    return this.fontStep === FONT_NATIVE_INDEX && this.weightIndex === 0;
  }

  /*!
   * 字体来源解析：Rust 侧 ensure_font_cache 下载并落盘（磁盘永久缓存，
   * 下载一次管终身），文件字节经 IPC 直交页面，FontFace(ArrayBuffer)
   * 程序化注册——绕开 WebKit 页面字体网络路径（2026-10-25 实证：远程 URL
   * 与 atreader:// 协议子资源都会被拦，document.fonts.check 恒 false）。
   * 无 Tauri/缓存失败时回退远程 URL @font-face（行为退回浏览器自下载）。
   */
  private async ensureFontSource(): Promise<void> {
    const weight = FONT_WEIGHTS[this.weightIndex];
    if (!weight?.url) return;
    // 本会话已注册：FontFace 持久存在于 document.fonts，零成本短路
    if (this.fontSourceState === 'face' && this.registeredFontUrls.has(weight.url)) return;
    // 无 Tauri 环境（happy-dom 测试/旧版壳）：远程 URL 回退，不发真实网络请求
    if (!window.__TAURI__) {
      this.applyFontSource(weight.url, 'remote');
      return;
    }
    const inflight = this.fontFaceLoads.get(weight.url);
    if (inflight) {
      await inflight;
      return;
    }
    const task = this.loadFontIntoDocument(weight.url, weight.family);
    this.fontFaceLoads.set(weight.url, task);
    try {
      await task;
    } finally {
      this.fontFaceLoads.delete(weight.url);
    }
  }

  private async loadFontIntoDocument(url: string, family: string): Promise<void> {
    try {
      const info = await ensureFontCache(url);
      if (!info?.dataBase64) throw new Error('font cache unavailable');
      // 用户在下载期间已切到其他字重：本次结果作废，由最新一轮流程接管
      if (FONT_WEIGHTS[this.weightIndex]?.url !== url) return;
      await this.registerFontFace(family, info.dataBase64);
      if (FONT_WEIGHTS[this.weightIndex]?.url !== url) return;
      this.registeredFontUrls.add(url);
      this.applyFontSource(url, 'face');
    } catch (error) {
      // 缓存命令失败（旧版壳无此命令 / 下载出错）：回退远程 URL。失败原样
      // 落日志，不靠推测。
      this.fontSourceState = 'failed';
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      logToFile(`[Ireader] font cache failed, fallback to remote: ${detail}`);
      if (FONT_WEIGHTS[this.weightIndex]?.url !== url) return;
      this.applyFontSource(url, 'remote');
    }
  }

  /*! 字节 → document.fonts 注册。data: fetch 由引擎一次性解码（5.8MB），
   * 比 JS 逐字符 atob 快且省内存；FontFace(ArrayBuffer) Safari 10+ 即支持。 */
  private async registerFontFace(family: string, dataBase64: string): Promise<void> {
    const response = await fetch(`data:font/ttf;base64,${dataBase64}`);
    if (!response.ok) throw new Error(`font data decode failed: ${response.status}`);
    const data = await response.arrayBuffer();
    const face = new FontFace(family, data);
    await face.load();
    document.fonts.add(face);
  }

  private applyFontSource(url: string, state: 'face' | 'remote'): void {
    // 变更守卫：applySettings → ensureFontSource → 本方法 → refreshFontSettings
    // → applySettings 会形成重入环；仅在来源真正变化时才重跑一轮样式应用
    if (this.fontSourceUrl === url && this.fontSourceState === state) return;
    this.fontSourceUrl = url;
    this.fontSourceState = state;
    this.refreshFontSettings();
  }

  private refreshFontSettings(): void {
    const api = this.api;
    if (!api) return;
    this.applySettings(api.settings.getAll());
  }

  /*!
   * 失败取证采样：健康加载零输出；进页 6 秒后若字体未就绪（check=false，
   * 字节注册路径失效的签名）或正文仍为空，才写一次诊断——「正文空白」与
   * 「字体失踪」的实锤时刻。
   */
  private scheduleContentDiagnostics(): void {
    if (this.diagnosticsTimers.length > 0) {
      for (const timer of this.diagnosticsTimers) window.clearTimeout(timer);
      this.diagnosticsTimers = [];
    }
    this.diagnosticsTimers.push(window.setTimeout(() => this.logContentDiagnostics(), 6000));
  }

  private logContentDiagnostics(): void {
    if (!this.api || !this.isReaderPage()) return;
    const content = document.querySelector<HTMLElement>(IREADER_CONTENT_SELECTOR);
    const indicator = document.querySelector<HTMLElement>('.atreader-ireader-page-indicator');
    const weight = FONT_WEIGHTS[this.weightIndex];
    const fontReady = weight?.family
      ? (document.fonts?.check(`28px '${weight.family}'`) ?? false)
      : true;
    const chars = content?.textContent?.length ?? 0;
    if (fontReady && chars > 0) return; // 健康态不打日志
    const stats = this.paginator?.getStats();
    // 站点框架重建会更换正文节点/类名：把当前 DOM 里相关 class 采出来对照
    const liveClasses = (document.body?.innerHTML.match(/class="[^"]*(?:reader|width|content)[^"]*"/g) ?? [])
      .slice(0, 10)
      .join(' | ');
    logToFile(
      `[Ireader] diagnose p=${content?.querySelectorAll('p').length ?? -1}`
      + ` chars=${chars}`
      + ` scrollWidth=${content?.scrollWidth ?? -1}`
      + ` pages=${indicator?.textContent ?? '?'}`
      + ` fonts=${document.fonts?.status ?? '?'} check=${fontReady}`
      + ` weight=${this.weightIndex} fontSrc=${this.fontSourceState}`
      + ` liveClasses=${liveClasses || '(none)'}`
      + ` pager=${stats ? JSON.stringify(stats) : 'null'}`,
    );
  }

  private readonly toggleDark = (): void => {
    const api = this.api;
    if (!api) return;
    this.darkEnabled = !this.darkEnabled;
    void api.storage.set(DARK_PREFERENCE_KEY, this.darkEnabled);
    this.applySettings(api.settings.getAll());
  };

  private readonly toggleFontPanel = (): void => {
    if (this.fontPanel?.isConnected) {
      this.removeFontPanel();
      return;
    }
    this.ensureFontPanel();
  };

  private ensureFontPanel(): void {
    if (this.fontPanel?.isConnected) return;
    const host = document.body;
    if (!host) return;
    const panel = document.createElement('div');
    panel.className = 'atreader-ireader-font-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '字体设置');

    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'label';
    sizeLabel.textContent = '字号';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = '0';
    sizeInput.max = String(FONT_STEPS.length - 1);
    sizeInput.step = '1';
    sizeInput.setAttribute('aria-label', '字号');
    const sizeValue = document.createElement('span');
    sizeValue.className = 'value';
    sizeInput.addEventListener('input', () => {
      const api = this.api;
      if (!api) return;
      const index = Number(sizeInput.value);
      if (!Number.isInteger(index) || index < 0 || index >= FONT_STEPS.length) return;
      this.fontStep = index;
      void api.storage.set(FONT_STEP_KEY, index);
      this.syncFontPanel();
      this.applySettings(api.settings.getAll());
    });

    const weightLabel = document.createElement('span');
    weightLabel.className = 'label';
    weightLabel.textContent = '字形';
    const weightInput = document.createElement('input');
    weightInput.type = 'range';
    weightInput.min = '0';
    weightInput.max = String(FONT_WEIGHTS.length - 1);
    weightInput.step = '1';
    weightInput.setAttribute('aria-label', '字形粗细');
    const ticks = document.createElement('div');
    ticks.className = 'ticks';
    for (const weight of FONT_WEIGHTS) {
      const tick = document.createElement('span');
      tick.textContent = weight.label;
      ticks.append(tick);
    }
    const weightWrap = document.createElement('div');
    weightWrap.className = 'slider-wrap';
    weightWrap.append(weightInput, ticks);
    const weightValue = document.createElement('span');
    weightValue.className = 'value';
    weightInput.addEventListener('input', () => {
      const api = this.api;
      if (!api) return;
      const index = Number(weightInput.value);
      if (!Number.isInteger(index) || index < 0 || index >= FONT_WEIGHTS.length) return;
      this.weightIndex = index;
      void api.storage.set(FONT_WEIGHT_KEY, index);
      this.syncFontPanel();
      this.applySettings(api.settings.getAll());
    });

    const sizeRow = document.createElement('div');
    sizeRow.className = 'row';
    sizeRow.append(sizeLabel, sizeInput, sizeValue);
    const weightRow = document.createElement('div');
    weightRow.className = 'row';
    weightRow.append(weightLabel, weightWrap, weightValue);
    panel.append(sizeRow, weightRow);

    this.fontPanel = panel;
    host.append(panel);
    this.syncFontPanel();
  }

  private syncFontPanel(): void {
    const panel = this.fontPanel;
    if (!panel) return;
    const sizeInput = panel.querySelector<HTMLInputElement>('input[aria-label="字号"]');
    const weightInput = panel.querySelector<HTMLInputElement>('input[aria-label="字形粗细"]');
    if (sizeInput && sizeInput.value !== String(this.fontStep)) {
      sizeInput.value = String(this.fontStep);
    }
    if (weightInput && weightInput.value !== String(this.weightIndex)) {
      weightInput.value = String(this.weightIndex);
    }
    const sizeValue = panel.querySelector<HTMLSpanElement>('.row .value');
    if (sizeValue) sizeValue.textContent = `${FONT_STEPS[this.fontStep]}px`;
    const weightValue = panel.querySelectorAll<HTMLSpanElement>('.row .value')[1];
    if (weightValue) weightValue.textContent = FONT_WEIGHTS[this.weightIndex].label;
  }

  private removeFontPanel(): void {
    this.fontPanel?.remove();
    this.fontPanel = null;
  }

  private readonly handlePanelOutsideClick = (event: MouseEvent): void => {
    if (!this.fontPanel?.isConnected) return;
    const target = event.target;
    if (target instanceof Node) {
      if (this.fontPanel.contains(target)) return;
      const fontButton = this.toolbarButtons.font;
      if (fontButton && fontButton.contains(target)) return;
    }
    this.removeFontPanel();
  };

  private readonly toggleLayoutMode = (): void => {
    const api = this.api;
    if (!api || this.manifest.capabilities.doubleColumn !== true) return;
    this.doubleColumnEnabled = !this.doubleColumnEnabled;
    void api.storage.set(LAYOUT_PREFERENCE_KEY, this.doubleColumnEnabled);
    this.applySettings(api.settings.getAll());
  };

  private async restorePreferences(api: PluginAPI): Promise<void> {
    const [layout, dark, font, weight, prefsVersion] = await Promise.all([
      api.storage.get<boolean>(LAYOUT_PREFERENCE_KEY),
      api.storage.get<boolean>(DARK_PREFERENCE_KEY),
      api.storage.get<number>(FONT_STEP_KEY),
      api.storage.get<number>(FONT_WEIGHT_KEY),
      api.storage.get<number>(FONT_PREFS_VERSION_KEY),
    ]);
    if (this.api !== api) return;
    const legacyLayout = api.settings.get<boolean>('doubleColumn', true);
    this.doubleColumnEnabled = typeof layout === 'boolean' ? layout : legacyLayout !== false;
    this.darkEnabled = dark === true;

    if (prefsVersion !== FONT_PREFS_VERSION) {
      // 偏好版本升级：重置为新默认（28px/中）并盖写旧值
      this.fontStep = FONT_DEFAULT_INDEX;
      this.weightIndex = FONT_WEIGHT_DEFAULT_INDEX;
      void api.storage.set(FONT_STEP_KEY, this.fontStep);
      void api.storage.set(FONT_WEIGHT_KEY, this.weightIndex);
      void api.storage.set(FONT_PREFS_VERSION_KEY, FONT_PREFS_VERSION);
      this.applySettings(api.settings.getAll());
      return;
    }

    this.fontStep = typeof font === 'number'
      && font >= 0
      && font < FONT_STEPS.length
      ? font
      : FONT_DEFAULT_INDEX;
    this.weightIndex = typeof weight === 'number'
      && weight >= 0
      && weight < FONT_WEIGHTS.length
      ? weight
      : FONT_WEIGHT_DEFAULT_INDEX;
    this.applySettings(api.settings.getAll());
  }

  // ==================== 右侧工具栏 ====================

  /*!
   * 目录键 = 开关：抽屉已开启（.directory-wrapper opacity > 0.5）时点击
   * 原生关闭键收起，否则点击站点目录按钮唤出。两个站点按钮即使被 CSS
   * 隐藏，编程点击仍会触发其处理器。
   */
  private readonly toggleCatalogDrawer = (): void => {
    const wrapper = document.querySelector('.reader-header .directory-wrapper');
    const opacity = wrapper
      ? Number.parseFloat(window.getComputedStyle(wrapper).opacity)
      : Number.NaN;
    if (Number.isFinite(opacity) && opacity > 0.5) {
      const close = document.querySelector<HTMLElement>('.reader-header .close-btn');
      if (close) {
        close.click();
        return;
      }
    }
    const button = Array.prototype.slice.call(
      document.querySelectorAll('.reader-header-action .zy-btn'),
    ).find((b: HTMLElement) => /目录/.test(b.textContent || ''));
    if (button) {
      (button as HTMLElement).click();
      return;
    }
    this.api?.toast.show('未找到目录');
  };

  private removeToolbar(): void {
    this.toolbar?.remove();
    this.toolbar = null;
    this.toolbarButtons = {};
  }

  private ensureToolbar(): void {
    if (this.toolbar?.isConnected) return;
    const host = document.body;
    if (!host) return;
    const toolbar = document.createElement('div');
    toolbar.className = 'atreader-ireader-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', '掌阅阅读工具栏');
    const buttons: Array<{ id: string; label: string; onClick: () => void }> = [
      { id: 'layout', label: '双栏', onClick: this.toggleLayoutMode },
      { id: 'catalog', label: '目录', onClick: this.toggleCatalogDrawer },
      { id: 'dark', label: '夜间', onClick: this.toggleDark },
      { id: 'font', label: '字体', onClick: this.toggleFontPanel },
    ];
    for (const item of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.role = item.id;
      button.setAttribute('aria-label', `${item.label}`);
      button.addEventListener('click', item.onClick);
      this.toolbarButtons[item.id] = button;
      toolbar.append(button);
    }
    this.toolbar = toolbar;
    host.append(toolbar);
    this.syncToolbar();
  }

  private syncToolbar(): void {
    if (!this.toolbar) return;
    const layoutButton = this.toolbarButtons.layout;
    if (layoutButton) {
      const label = this.doubleColumnEnabled ? '单栏' : '双栏';
      if (layoutButton.dataset.targetMode !== label) {
        layoutButton.dataset.targetMode = label;
        layoutButton.innerHTML = (this.doubleColumnEnabled ? SINGLE_COLUMN_ICON : DOUBLE_COLUMN_ICON)
          + `<span>${label}</span>`;
        layoutButton.setAttribute('aria-label', `切换为${label}阅读`);
      }
    }
    const darkButton = this.toolbarButtons.dark;
    if (darkButton) {
      const label = this.darkEnabled ? '日间' : '夜间';
      if (darkButton.dataset.targetMode !== label) {
        darkButton.dataset.targetMode = label;
        darkButton.innerHTML = (this.darkEnabled ? SUN_ICON : MOON_ICON)
          + `<span>${label}</span>`;
        darkButton.setAttribute('aria-label', `切换为${label}模式`);
      }
    }
    const catalogButton = this.toolbarButtons.catalog;
    if (catalogButton && !catalogButton.dataset.iconReady) {
      catalogButton.dataset.iconReady = '1';
      catalogButton.innerHTML = CATALOG_ICON + `<span>目录</span>`;
    }
    const fontButton = this.toolbarButtons.font;
    if (fontButton && !fontButton.dataset.iconReady) {
      fontButton.dataset.iconReady = '1';
      fontButton.innerHTML = FONT_ICON + `<span>字体</span>`;
      fontButton.setAttribute('aria-label', '字体设置');
    }
  }

  // ==================== 设置应用 ====================

  private applySettings(settings: Record<string, unknown>): void {
    if (!this.api) return;
    if (!this.isReaderPage()) {
      this.paginator?.disable();
      this.disarmWatchdog?.();
      this.disarmWatchdog = null;
      for (const id of ['reader', 'wide', 'dark', 'font', 'toolbar', 'progress']) {
        this.api.style.remove(id);
      }
      document.body?.classList.remove(IREADER_DARK_CLASS);
      this.removeToolbar();
      this.removeFontPanel();
      return;
    }

    const styles = this.getStyles();
    const readerCss = styles.custom?.reader ?? '';

    /*! @capability doubleColumn 能力开关是总开关，工具栏按钮负责临时切换。 */
    const hasDoubleColumn = this.manifest.capabilities.doubleColumn === true;
    const doubleColumn = hasDoubleColumn
      && this.doubleColumnEnabled
      && readerCss.trim().length > 0;
    /*! @capability wideMode 菜单状态决定是否注入 wide.css。 */
    const wide = settings.readerWide === true;
    /*! @capability hideToolbar 菜单状态决定是否隐藏插件工具栏。 */
    const hideToolbar = settings.hideToolbar === true
      && this.manifest.capabilities.hideToolbar === true;
    /*! @capability progressTracker 清单能力直接控制底部页码及其预留高度。 */
    const showProgress = this.manifest.capabilities.progressTracker === true;

    // 进度能力关闭时不创建底部页码，并让分页视口回收其 48px 预留区。
    this.paginator?.setProgressVisible(showProgress);

    this.applyStyleFile('reader', readerCss, doubleColumn);
    this.applyStyleFile('wide', styles.wideMode?.enabled ?? '', doubleColumn && wide);
    this.applyStyleFile('dark', styles.custom?.dark ?? '', this.darkEnabled);
    this.applyStyleFile('font', styles.custom?.font ?? '', !this.isFontNative());
    this.applyStyleFile('toolbar', styles.custom?.toolbar ?? '', true);
    this.applyStyleFile('progress', styles.custom?.progress ?? '', doubleColumn && showProgress);

    if (doubleColumn) this.paginator?.enable();
    else this.paginator?.disable();

    if (this.darkEnabled) document.body?.classList.add(IREADER_DARK_CLASS);
    else document.body?.classList.remove(IREADER_DARK_CLASS);

    this.ensureToolbar();
    this.toolbar?.classList.toggle('atreader-ireader-toolbar-hidden', hideToolbar);
    if (hideToolbar) this.removeFontPanel();
    this.syncToolbar();

    void this.ensureFontSource();
    this.scheduleContentDiagnostics();
  }

  private applyStyleFile(id: string, css: string, enabled: boolean): void {
    if (!this.api) return;
    if (enabled && css) this.api.style.inject(id, css);
    else this.api.style.remove(id);
  }
}

export default IreaderPlugin;
