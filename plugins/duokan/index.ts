/*!
 * 多看插件（duokan.com）——裸站 + 翻页键桥接 + 双页对开默认。
 *
 * 多看网页阅读器（/reader/www/app.html?id=<bookId>）在横排模式（双页对开）
 * 下为预分页排版，自带 ←/→ 键翻页、阅读模式（单/双页 j-pattern）、目录
 * （j-toc）——按「站点插件最小打扰原则」不注入任何排版样式。
 *
 * 插件做三件事：
 * 1. 双页对开默认与保持：站点无偏好时默认 vertical_reader（单页滚动），
 *    入口点击一次 j-pattern 切到 horizontal_reader；站点在章节切换后会把
 *    模式重置回单页（不记住选择），观察器按「翻页后 8 秒窗口内的重置 =
 *    站点行为（自动修复，每次进页上限 5 次）；窗口外 = 用户手动切单页
 *    （尊重不干预）」区分。
 * 2. 双页门槛补偿：站点以 CSS 视口决定单/双页——宽 >1520 必双页；矮窗
 *    （高 ≤888）的「小屏」档也双页；「高 >888 且宽 ≤1520」的「大屏单页」
 *    档才是单页（页面盒由 JS 按图书元数据写死，CSS 覆盖只会得到裁切的
 *    半页，唯一下手处是视口）。窄高窗把 WebView 缩放微降一档让视口越过
 *    1520px（1512×982 的整窗恰好落在这档——「昨天双页今天单页」的根因）。
 *    缩放档位持久化为站点设置：zoom 仍是默认 1.0 视为自动档（每次进页
 *    重估，窗口变宽自动退出补偿），⌘±/⌘0 一旦动过即用户手动档，永不
 *    覆写，⌘0 复位回 1.0 即恢复自动。
 * 3. 翻页键桥接：把壳层拦截的 Space/PageUp/PageDown 桥接为站点已实测
 *    响应的合成 ←/→ 方向键（←/→ 壳层本就不拦截，由站点原生处理）。
 *
 * 另声明 nativeTheme：多看门户/书城/已购页自带暗色设计，壳层反色滤镜
 * 会与站点原生配色打架（反色不完全），深浅完全让位站点自身。
 *
 * 登录 Cookie（token/user_id，约 90 天持久）站点自身已持久化，
 * 无需掌阅式会话 Cookie 续期。
 */

import type {
  PluginAPI,
  PluginManifest,
  ReaderPlugin,
} from '../../src/scripts/core/plugin_types';
// api.log 是 console-only 实现（core/logger.ts），落文件诊断必须走 logToFile
import { logToFile, invoke } from '../../src/scripts/core/tauri';
import { setSiteReadinessProbe } from '../../src/scripts/core/site_switch_loading';
import {
  armReaderEntryWatchdog,
  stylesheetsReady,
} from '../shared/reader_entry_watchdog';

/// 章节切换模式重置守卫：翻页后此窗口内的单页视为站点重置（自动修复），
/// 窗口外的单页视为用户手动选择（尊重不干预）
const REARM_WINDOW_MS = 8000;
const REARM_MAX = 5;
/// 深链弹回守卫：站点阅读器有时无法校验深链入口，把 app.html 弹回首页
/// （壳层的 lastReaderUrl 因此被清，用户看到「进度没记住」）。正文页加载时
/// 留 sessionStorage 标记，10 秒内出现在非阅读页 = 弹回，自动导航回正文一次。
const READER_ENTRY_KEY = 'atreader-duokan-reader-entry';
const READER_ENTRY_TTL_MS = 10000;
/// 门槛补偿档位的插件存储键：记录自动补偿写入的 zoom，用于区分「自动档」
/// 与「用户手动档」（⌘± 只改站点设置，插件存储不动）。
const AUTO_ZOOM_KEY = 'spread-auto-zoom';
/// 补偿档位应用的延迟：让过 app_runtime 装配尾部的设置缩放应用（晚到者胜）。
const SPREAD_ZOOM_DELAY_MS = 600;

// 运行时代码中不内联 manifest 的 base64 图标，避免插件编辑器顶部出现超长数据行。
const DUOKAN_RUNTIME_MANIFEST: PluginManifest = {
  id: 'duokan',
  name: '多看',
  version: '1.0.1',
  description: '多看网页版在线阅读（原生双页排版，桥接空格/翻页键）',
  author: '艾特阅读团队',
  homepage: 'https://github.com/dengcb/weixin-reader-desktop',
  sourceType: 'web',
  renderMode: 'webview',
  site: {
    domain: ['duokan.com'],
    homeUrl: 'https://www.duokan.com/pc/',
    readerPattern: '/reader/www/app\\.html',
  },
  capabilities: {
    autoFlip: true,
    nativeTheme: true,
  },
};

export class DuokanPlugin implements ReaderPlugin {
  readonly manifest = DUOKAN_RUNTIME_MANIFEST;

  private api: PluginAPI | null = null;
  private patternObserver: MutationObserver | null = null;
  private bodyWaitObserver: MutationObserver | null = null;
  private patternEnsured = false;
  private userChoseSingle = false;
  private rearmCount = 0;
  private lastFlipAt = 0;
  private clickRetryTimer: number | null = null;
  private reconcileTimer: number | null = null;
  private stuckTicks = 0;
  private roundTripUntil = 0;
  private spreadZoomTimer: number | null = null;

  onLoad(api: PluginAPI): void {
    this.api = api;
    this.ensureDoublePage();
    // 双页对开门槛补偿：阅读页 + 横排态时评估一次（见 evaluateSpreadZoom）
    this.scheduleSpreadZoom();
    this.guardDeepLinkBounce();
    // 进页失速看门狗 + 过场层就绪探针：站点 CSS/JS 偶发迟到（裸 HTML 天然
    // 单列白底，body.id 早在标记里就已存在）时重载一次。就绪判据 = 阅读器
    // 完成 .book_page 渲染。对账循环同样只在阅读页有意义。
    if (this.isReaderPage()) {
      this.startReconciler();
      const presented = (): boolean =>
        stylesheetsReady(document)
        && document.body?.id === 'horizontal_reader'
        && !!document.querySelector('.book_page, .j-pattern, .j-toc');
      setSiteReadinessProbe(presented);
      this.disarmWatchdog = armReaderEntryWatchdog({
        pluginId: 'duokan',
        isReady: presented,
        log: message => logToFile(`[Duokan] ${message}`),
      });
    }
  }

  onUnload(): void {
    this.disarmWatchdog?.();
    this.disarmWatchdog = null;
    this.patternObserver?.disconnect();
    this.patternObserver = null;
    this.bodyWaitObserver?.disconnect();
    this.bodyWaitObserver = null;
    this.stopClickRetry();
    this.stopReconciler();
    if (this.spreadZoomTimer !== null) {
      window.clearTimeout(this.spreadZoomTimer);
      this.spreadZoomTimer = null;
    }
    this.patternEnsured = false;
    this.userChoseSingle = false;
    this.rearmCount = 0;
    this.api = null;
  }

  isReaderPage(): boolean {
    return window.location.pathname === '/reader/www/app.html';
  }

  isHomePage(): boolean {
    const pathname = window.location.pathname;
    return pathname === '/' || pathname === '/pc/' || pathname === '/pc';
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
    this.dispatchFlip('ArrowRight');
  }

  prevPage(): void {
    this.dispatchFlip('ArrowLeft');
  }

  /*!
   * 深链弹回守卫：阅读页加载时记录完整 URL；若 10 秒内落到多看的非阅读页，
   * 判定为站点弹回（非用户操作），自动导航回正文深链一次。只重试一次：
   * 重试前清除标记，若站点再次弹回则放弃（此时用户的「返回书城」操作
   * 也不受影响——标记已在重试前清除）。
   */
  private disarmWatchdog: (() => void) | null = null;

  private guardDeepLinkBounce(): void {
    if (this.isReaderPage()) {
      try {
        sessionStorage.setItem(
          READER_ENTRY_KEY,
          JSON.stringify({ href: window.location.href, at: Date.now() }),
        );
      } catch {
        // sessionStorage 不可用（隐私模式等）：放弃弹回守卫
      }
      return;
    }
    let entry: { href?: string; at?: number } | null = null;
    try {
      entry = JSON.parse(sessionStorage.getItem(READER_ENTRY_KEY) ?? 'null');
    } catch {
      entry = null;
    }
    if (!entry?.href) return;
    const at = Number(entry.at);
    if (!Number.isFinite(at)) return;
    sessionStorage.removeItem(READER_ENTRY_KEY);
    if (Date.now() - at > READER_ENTRY_TTL_MS) return;
    if (entry.href === window.location.href) return;
    // 只把「落点=首页」判为站点弹回（实证的弹回特征）。10 秒内用户主动
    // 离开阅读页去其它任何页面（书城、个人页……）不再被劫持回正文
    //（2026-11 审计 L-P2-6）。
    if (!this.isHomePage()) return;
    logToFile(`[Duokan] deep-link bounce detected, restoring ${entry.href}`);
    window.location.href = entry.href;
  }

  /*!
   * 阅读页入口确保双页对开。三个时序/行为坑（2026-10-25 实证）：
   * 1. onLoad 在 documentStart 附近执行，<body> 可能尚未解析——观察
   *    document 等 body 就绪，绝不放弃。
   * 2. body.id 变为 vertical_reader 时 .j-pattern 按钮可能还没渲染——点击
   *    不能一锤子买卖，按钮未就绪就等下一轮变异再试。
   * 3. 站点在章节切换后会把模式重置回 vertical_reader（并不记住选择），
   *    且用户用站点按钮手动切单页也表现为同样的 id 变化——区分方式：
   *    翻页/切章后 8 秒窗口内的重置视为站点行为，自动修复（每次进页
   *    最多 5 次）；窗口外的单页视为用户手动选择，尊重并不再干预。
   */
  private ensureDoublePage(): void {
    if (!this.isReaderPage() || this.userChoseSingle) return;
    if (this.patternObserver) return;
    if (this.applyDoublePage()) {
      // SSR/首帧直接是 horizontal（站点记住了偏好）：修复成功也要常驻观察，
      // 否则章节切换被站点重置回 vertical 时无人接管——永久单列老 bug 根因
      this.attachPatternObserver(document.body);
      return;
    }
    const body = document.body;
    if (!body) {
      if (this.bodyWaitObserver) return;
      this.bodyWaitObserver = new MutationObserver(() => {
        if (document.body) {
          this.bodyWaitObserver?.disconnect();
          this.bodyWaitObserver = null;
          this.ensureDoublePage();
        }
      });
      this.bodyWaitObserver.observe(document, { childList: true });
      return;
    }
    this.attachPatternObserver(body);
  }

  private attachPatternObserver(body: HTMLElement): void {
    if (this.patternObserver) return;
    // 观察器常驻：修复成功后继续监视章节切换的模式重置
    this.patternObserver = new MutationObserver(() => this.handleBodyIdChange());
    this.patternObserver.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id'],
    });
  }

  private handleBodyIdChange(): void {
    // 模式往返窗口内的 id 抖动（vertical→horizontal→vertical）是自家修复
    // 动作，走 rearm/单页尊重逻辑会互相打架（8s 窗外被误判为用户手动单页）
    if (Date.now() < this.roundTripUntil) return;
    if (!this.patternEnsured) {
      // 点击竞态：按钮未就绪时 applyDoublePage 不置 ensured，等下一次变异重试
      this.applyDoublePage();
      if ((document.body?.id ?? '') === 'vertical_reader') this.startClickRetry();
      return;
    }
    if ((document.body?.id ?? '') !== 'vertical_reader') {
      this.stopClickRetry();
      return;
    }
    const sinceFlip = Date.now() - this.lastFlipAt;
    if (sinceFlip > REARM_WINDOW_MS) {
      // 与翻页无关的单页：用户手动选择，尊重并不再干预
      this.userChoseSingle = true;
      this.stopClickRetry();
      this.patternObserver?.disconnect();
      this.patternObserver = null;
      return;
    }
    if (this.rearmCount >= REARM_MAX) return;
    this.rearmCount++;
    this.patternEnsured = false;
    this.applyDoublePage();
    this.startClickRetry();
  }

  /**
   * vertical 期间的点击重试环：站点把 .j-pattern 的点击处理器绑定完成之前，
   * 我们的合成点击是空响（body.id 已切 horizontal 但渲染仍是单页的死窗）。
   * 500ms 一次、上限 15s，一旦 body.id 回到 horizontal 即停。
   */
  private startClickRetry(): void {
    if (this.clickRetryTimer !== null) return;
    let ticks = 0;
    this.clickRetryTimer = window.setInterval(() => {
      ticks++;
      if (
        this.patternEnsured
        || (document.body?.id ?? '') !== 'vertical_reader'
        || ticks > 30
        || !this.isReaderPage()
      ) {
        this.stopClickRetry();
        return;
      }
      document.querySelector<HTMLElement>('.j-pattern')?.click();
    }, 500);
  }

  private stopClickRetry(): void {
    if (this.clickRetryTimer !== null) {
      window.clearInterval(this.clickRetryTimer);
      this.clickRetryTimer = null;
    }
  }

  /**
   * 对账循环（阅读页期间 1s 一拍）：修复两个无人接管的卡死态（2026-10-25
   * 实证「多看始终单列」）——
   * 1. 休眠态：入口 ensureDoublePage 在深链弹回路径上因 isReaderPage=false
   *    早退且永不重启，观察器没挂，后续 id 变化无人响应 → 补启动。
   * 2. ensured=false + horizontal 卡死：rearm 竞态中站点抢先恢复横排 id，
   *    点击重试环见横排即停、观察器等不到新变异，而 id 横排≠渲染双页
   *    （站点死窗：id 已切但渲染仍单页）。持续 3 拍仍卡 → 模式往返一次，
   *    强迫站点用已就绪的处理器重渲染双页。
   */
  private startReconciler(): void {
    if (this.reconcileTimer !== null) return;
    this.reconcileTimer = window.setInterval(() => this.reconcileTick(), 1000);
  }

  private stopReconciler(): void {
    if (this.reconcileTimer !== null) {
      window.clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.stuckTicks = 0;
    this.roundTripUntil = 0;
  }

  private reconcileTick(): void {
    if (!this.isReaderPage() || this.userChoseSingle || !document.body) {
      this.stuckTicks = 0;
      return;
    }
    if (!this.patternObserver && !this.bodyWaitObserver) {
      this.ensureDoublePage();
      this.stuckTicks = 0;
      return;
    }
    if (this.patternEnsured) {
      this.stuckTicks = 0;
      return;
    }
    const bodyId = document.body.id;
    if (bodyId === 'vertical_reader') {
      this.stuckTicks = 0;
      this.applyDoublePage();
      this.startClickRetry();
      return;
    }
    if (bodyId !== 'horizontal_reader') {
      this.stuckTicks = 0;
      return;
    }
    this.stuckTicks++;
    if (this.stuckTicks >= 3) {
      this.stuckTicks = 0;
      this.patternRoundTrip();
    }
  }

  /**
   * 模式往返：点击 j-pattern 切到 vertical 再切回 horizontal。两拍点击时
   * 处理器早已绑定完毕，站点必然按最终模式重渲染双页。往返期间
   * handleBodyIdChange 让路；若往返后仍是 vertical（按钮缺失点击空响），
   * 交还对账循环重试。
   */
  private patternRoundTrip(): void {
    logToFile('[Duokan] reconcile: ensured=false stuck with horizontal_reader, round-trip toggle');
    this.patternEnsured = true;
    this.lastFlipAt = Date.now();
    this.roundTripUntil = Date.now() + 1500;
    const toggle = (): void => document.querySelector<HTMLElement>('.j-pattern')?.click();
    toggle();
    window.setTimeout(() => {
      if (!this.isReaderPage()) return;
      toggle();
      if ((document.body?.id ?? '') === 'vertical_reader') this.patternEnsured = false;
    }, 600);
  }

  private applyDoublePage(): boolean {
    if (this.patternEnsured || !document.body) return false;
    const bodyId = document.body.id;
    if (bodyId === 'horizontal_reader') {
      this.patternEnsured = true;
      return true;
    }
    if (bodyId === 'vertical_reader') {
      const button = document.querySelector<HTMLElement>('.j-pattern');
      if (!button) return false;
      this.patternEnsured = true;
      button.click();
      return true;
    }
    return false;
  }

  private dispatchFlip(key: 'ArrowLeft' | 'ArrowRight'): void {
    if (!this.isReaderPage()) return;
    this.lastFlipAt = Date.now();
    // KeyboardEventInit 不含 keyCode/which（构造器静默忽略，实际 keyCode===0），
    // 需要 keyCode 时应用 defineProperty 显式注入（2026-11 审计 L-P1-3）。
    const init: KeyboardEventInit = {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', init));
    document.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /*!
   * 双页对开的视口门槛补偿。站点 CSS（reader_horizontal.css）以视口决定
   * 单/双页：宽 >1520 走默认块（每页 50% = 双页对开）；高 ≤888 的「小屏」
   * 档也是 50% 双页；「高 >888 且宽 ≤1520」的「大屏单页」档把页盒放大到
   * 100%（单页）。页面盒尺寸由 JS 按图书元数据内联写死，CSS 覆盖只会得到
   * 裁切的半页——唯一的双页入口是让视口越过门槛：WebView pageZoom 微降
   * 一档（缩放同时放大 CSS 宽高，矮窗靠宽度越槛，窄高窗越不过就尊重单页）。
   *
   * 档位持久化为站点 zoom 设置（zoom 是 webview 级属性，必须落盘才能扛住
   * 每次导航的设置重放——初版的一次性 localStorage 盖章在重开 app 后失效）。
   * 「站点 zoom 仍为 1.0」= 自动档：每次进页重估，窗口变宽自动退出补偿；
   * ⌘±/⌘0 动过即用户手动档，永不覆写；⌘0 复位 1.0 即恢复自动。手动档的
   * 判定依据是插件存储里记录的自动档位与站点设置值是否一致。
   */
  static spreadZoomFor(width: number, height: number): number | null {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    // 宽窗：默认块就是双页对开
    if (width > 1520) return null;
    // 矮窗：站点「小屏」媒体查询本身给 50% 双页
    if (height <= 888) return null;
    // 缩放下限 0.85：越不过 1520 门槛的窗口尊重单页（缩了也白缩）
    let zoom = Math.floor((width / 1520) * 100 - 1) / 100;
    if (zoom < 0.85) zoom = 0.85;
    return width / zoom > 1520 ? zoom : null;
  }

  private scheduleSpreadZoom(): void {
    if (!this.isReaderPage()) return;
    if (this.spreadZoomTimer !== null) window.clearTimeout(this.spreadZoomTimer);
    this.spreadZoomTimer = window.setTimeout(() => {
      this.spreadZoomTimer = null;
      void this.evaluateSpreadZoom();
    }, SPREAD_ZOOM_DELAY_MS);
  }

  private async evaluateSpreadZoom(): Promise<void> {
    const api = this.api;
    if (!api || !this.isReaderPage()) return;
    try {
      await this.applySpreadZoom(api);
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      logToFile(`[Duokan] spread zoom evaluation failed: ${detail}`);
    }
  }

  private async applySpreadZoom(api: PluginAPI): Promise<void> {
    const storedAuto = await api.storage.get<number>(AUTO_ZOOM_KEY);
    const userZoom = api.settings.get<number>('zoom', 1.0);
    if (storedAuto !== null && userZoom !== storedAuto) {
      // 站点 zoom 与自动档记录不一致：用户动过 ⌘±/⌘0，交还控制权
      await api.storage.remove(AUTO_ZOOM_KEY);
      return;
    }
    if (storedAuto === null && userZoom !== 1.0) {
      // 从未自动补偿过且用户有自己的缩放：手动档，绝不覆写
      return;
    }
    // innerWidth/innerHeight 是当前缩放后的值；换算回未缩放基准再评估
    const base = storedAuto !== null ? storedAuto : 1.0;
    const target = DuokanPlugin.spreadZoomFor(
      window.innerWidth * base,
      window.innerHeight * base,
    );
    if (target === base) return;
    if (target === null) {
      if (base === 1.0) return; // 天然双页或放不下：无事可做
      // 窗口变宽/变矮后不再需要补偿：恢复默认并清除自动档记录
      await api.storage.remove(AUTO_ZOOM_KEY);
      await api.settings.set('zoom', 1.0);
      invoke('apply_site_zoom', { siteId: this.manifest.id });
      logToFile('[Duokan] spread zoom released (viewport fits native double page)');
      return;
    }
    await api.storage.set(AUTO_ZOOM_KEY, target);
    await api.settings.set('zoom', target);
    invoke('apply_site_zoom', { siteId: this.manifest.id });
    logToFile(
      `[Duokan] spread zoom applied: ${target}`
      + ` (viewport ${window.innerWidth}x${window.innerHeight})`,
    );
  }

  getStyles() {
    return {};
  }

  getReaderMenuItems(): string[] {
    return ['auto_flip'];
  }
}

export default DuokanPlugin;
