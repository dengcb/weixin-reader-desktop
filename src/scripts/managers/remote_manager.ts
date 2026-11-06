import { settingsStore } from '../core/settings_store';
import { createSiteContext, SiteContext } from '../core/site_context';
import { log } from '../core/logger';
import { EventBus, Events } from '../core/event_bus';
import { chapterManager } from '../core/chapter_manager';
import { showToast } from '../core/toast';
import { invoke } from '../core/tauri';
import { attachKeyboardToSameOriginIframes } from '../core/iframe_keyboard';
import { closeReaderToc, openReaderToc } from '../core/reader_toc';
import {
  RemoteHidButtonEvent,
  RemoteHidPhase,
  subscribeRemoteHidButtons,
} from '../core/remote_hid_source';

const MENU_HOLD_MS = 500;
const MENU_CONTEXT_GUARD_MS = 1500;
/** 音量/返回/主页的「长按」判定阈值，与菜单键一致 */
const BUTTON_HOLD_MS = 500;

/**
 * RemoteManager - 极简蓝牙遥控器管理器
 *
 * 支持：iReader 遥控器、小米蓝牙遥控器
 */
export class RemoteManager {
  private siteContext: SiteContext;
  private enabled = false;
  private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;
  private keyupHandler: ((e: KeyboardEvent) => void) | null = null;
  private contextMenuHandler: ((e: MouseEvent) => void) | null = null;
  private detachIframeKeyboard: (() => void) | null = null;
  private unsubscribeRemoteHid: (() => void) | null = null;
  private menuHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private menuLongFired = false;
  private menuPressActive = false;
  private menuHidActive = false;
  /** 音量/返回/主页的按住计时（按钮 → 定时器）；长按触发即删，迟到 release 自然早退 */
  private holdTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastMenuKeyAt = 0;
  private lastMenuReleaseAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private initializationGeneration = 0;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeReaderCommand: (() => void) | null = null;
  private routeChangedHandler: (() => void) | null = null;
  /** 微信读书强制目录的选章事件（站点状态机未参与，需自导航） */
  private tocPickHandler: ((event: Event) => void) | null = null;

  // 当前章节索引（从 URL 或 API 获取）
  private currentChapterIdx: number = -1;

  constructor() {
    this.siteContext = createSiteContext();
    this.init();
  }

  private init() {
    // 订阅设置
    this.unsubscribeSettings = settingsStore.subscribe((settings) => {
      const shouldEnable = settings.enableRemoteController !== false;
      if (shouldEnable && !this.enabled) this.enable();
      else if (!shouldEnable && this.enabled) this.disable();
    });
    this.unsubscribeReaderCommand = EventBus.on<{ action: string }>(
      Events.READER_COMMAND,
      ({ action }) => {
        if (!this.siteContext.isReaderPage) return;
        if (action === 'reader_prev_page') this.performPageTurn('backward');
        else if (action === 'reader_next_page') this.performPageTurn('forward');
        else if (action === 'reader_prev_chapter') this.navigateChapter(-1);
        else if (action === 'reader_next_chapter') this.navigateChapter(1);
      },
    );

    // 初始检查
    const settings = settingsStore.get();
    if (settings.enableRemoteController !== false) this.enable();

    // 路由变化时初始化
    this.routeChangedHandler = () => this.tryInitialize();
    window.addEventListener('ipc:route-changed', this.routeChangedHandler);

    // 首次加载
    if (this.siteContext.isReaderPage) {
      this.tryInitialize();
    }

    // 微信读书强制目录：站点状态机没参与，点章节由这里匹配章节数据自导航
    this.tocPickHandler = (event: Event) => {
      if (this.siteContext.siteId !== 'weread') return;
      const title = (event as CustomEvent<{ title?: string }>).detail?.title;
      if (title) this.navigateToChapterTitle(title);
    };
    window.addEventListener('atreader:toc-chapter-pick', this.tocPickHandler);

    log.info('[RemoteManager] 初始化完成');
  }

  /** 按目录项标题在 chapterManager 里找章并跳转（微信读书强制目录用）。 */
  private navigateToChapterTitle(title: string): void {
    const normalized = title.replace(/\s+/g, '');
    const chapters = chapterManager.getChapters();
    // 目录项带「第N章 」前缀，用去空白后缀匹配；同名章取最后一个
    let target: (typeof chapters)[number] | null = null;
    for (const chapter of chapters) {
      const chapterTitle = (chapter.title ?? '').replace(/\s+/g, '');
      if (chapterTitle.endsWith(normalized) || normalized.endsWith(chapterTitle)) {
        target = chapter;
      }
    }
    if (!target) {
      log.info(`[RemoteManager] 目录选章未匹配: ${title}`);
      return;
    }
    const url = chapterManager.buildChapterUrl(target.chapterIdx);
    if (!url) return;
    log.info(`[RemoteManager] 目录跳转: ${target.title}`);
    window.location.href = url;
  }

  /**
   * 尝试初始化章节数据
   */
  private async tryInitialize() {
    const generation = ++this.initializationGeneration;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.siteContext.isReaderPage) return;

    // 等待页面加载
    let retries = 0;
    const maxRetries = 20;

    const check = async () => {
      if (generation !== this.initializationGeneration) return;
      // 提取 URL 路径作为 bookId
      const pathMatch = window.location.pathname.match(/\/web\/reader\/([^?#]+)/);
      if (!pathMatch) {
        if (++retries < maxRetries) this.retryTimer = setTimeout(check, 500);
        return;
      }

      // 第一次进入时，URL 就是 bookId（可能包含 k+chapterId，取 k 之前的部分）
      const fullPath = pathMatch[1];
      const kIndex = fullPath.indexOf('k');
      const bookIdSegment = kIndex > 0 ? fullPath.substring(0, kIndex) : fullPath;

      // 初始化 ChapterManager
      const success = await chapterManager.initialize(bookIdSegment);
      if (generation !== this.initializationGeneration) return;
      if (!success) {
        // 可能未登录或页面未加载完成，静默重试
        if (++retries < maxRetries) this.retryTimer = setTimeout(check, 500);
        return;
      }

      // 尝试从 URL 获取当前章节
      this.updateCurrentChapterFromUrl();

      log.info(`[RemoteManager] 初始化成功，共 ${chapterManager.getChapters().length} 章`);
      window.dispatchEvent(new Event('atreader:capabilities-changed'));
    };

    check();
  }

  /**
   * 从 URL 更新当前章节索引
   */
  private updateCurrentChapterFromUrl() {
    const pathMatch = window.location.pathname.match(/\/web\/reader\/([^?#]+)/);
    if (!pathMatch) return;

    const fullPath = pathMatch[1];
    const kIndex = fullPath.indexOf('k');

    if (kIndex > 0) {
      // URL 有 chapterId，找到对应章节
      const chapterSegment = fullPath.substring(kIndex);
      const chapters = chapterManager.getChapters();

      for (const ch of chapters) {
        if (chapterManager.getChapterUrlSegment(ch.chapterIdx) === chapterSegment) {
          this.currentChapterIdx = ch.chapterIdx;
          log.info(`[RemoteManager] 当前章节: ${ch.title} (idx=${ch.chapterIdx})`);
          return;
        }
      }
    }

    // URL 没有 chapterId 或找不到匹配，等翻页后再更新
    log.info('[RemoteManager] 等待翻页后获取当前章节');
  }

  /**
   * 跳转章节
   */
  private navigateChapter(direction: number): boolean {
    const runtime = this.siteContext.currentRuntime;
    const navigate = direction < 0 ? runtime?.prevChapter : runtime?.nextChapter;
    if (navigate && runtime) {
      Promise.resolve(navigate.call(runtime)).then((changed) => {
        if (changed) showToast(direction < 0 ? '上一章' : '下一章');
      }).catch((error) => log.error('[RemoteManager] 本地章节切换失败', error));
      return true;
    }

    // 检查登录状态，未登录时静默返回
    if (!chapterManager.isLoggedIn()) {
      return false;
    }

    if (!chapterManager.isInitialized()) {
      return false;
    }

    // 先尝试从 URL 更新当前章节
    this.updateCurrentChapterFromUrl();

    if (this.currentChapterIdx < 0) {
      return false;
    }

    const chapters = chapterManager.getChapters();
    const currentArrayIdx = chapters.findIndex(c => c.chapterIdx === this.currentChapterIdx);
    if (currentArrayIdx < 0) {
      return false;
    }

    const targetArrayIdx = currentArrayIdx + direction;

    // 边界检查
    if (targetArrayIdx < 0) {
      log.info('[RemoteManager] 已是第一章');
      return false;
    }
    if (targetArrayIdx >= chapters.length) {
      log.info('[RemoteManager] 已是最后一章');
      return false;
    }

    const targetChapter = chapters[targetArrayIdx];
    const targetUrl = chapterManager.buildChapterUrl(targetChapter.chapterIdx);

    if (!targetUrl) {
      return false;
    }

    log.info(`[RemoteManager] 跳转: ${targetChapter.title}`);

    if (direction === -1) {
      showToast('上一章');
    } else if (direction === 1) {
      showToast('下一章');
    }

    window.location.href = targetUrl;
    return true;
  }

  private enable() {
    if (this.enabled) return;
    this.setupKeyboardListener();
    // 鼠标划选/点击站点 iframe 内正文后，键盘焦点进入 iframe 文档，顶层 window
    // 收不到按键（issue #5）；把同一处理器挂到全部同源 iframe，动态新增亦生效
    if (this.keyboardHandler) {
      this.detachIframeKeyboard = attachKeyboardToSameOriginIframes(this.keyboardHandler);
    }
    this.enabled = true;
    log.info('[RemoteManager] 已启用');
  }

  private disable() {
    if (!this.enabled) return;
    if (this.keyboardHandler) {
      window.removeEventListener('keydown', this.keyboardHandler, true);
      this.keyboardHandler = null;
    }
    if (this.contextMenuHandler) {
      window.removeEventListener('contextmenu', this.contextMenuHandler, true);
      this.contextMenuHandler = null;
    }
    if (this.keyupHandler) {
      window.removeEventListener('keyup', this.keyupHandler, true);
      this.keyupHandler = null;
    }
    if (this.detachIframeKeyboard) {
      this.detachIframeKeyboard();
      this.detachIframeKeyboard = null;
    }
    if (this.unsubscribeRemoteHid) {
      this.unsubscribeRemoteHid();
      this.unsubscribeRemoteHid = null;
    }
    this.lastMenuKeyAt = 0;
    this.enabled = false;
    log.info('[RemoteManager] 已禁用');
  }

  private performPageTurn(direction: 'forward' | 'backward') {
    const runtime = this.siteContext.currentRuntime;
    if (!runtime) return;

    // 方向记录统一由 ProgressTracker 的 keydown 监听承担：
    // nextPage()/prevPage() 会派发合成 Arrow 键事件（triggerKey），
    // 若在此处再 emit PAGE_TURN_DIRECTION，同一次翻页会被记录两次，
    // 快速连按时 100ms 优先级门还会把多余记录丢弃，导致进度计算偏慢。
    if (direction === 'forward') runtime.nextPage();
    else runtime.prevPage();
  }

  private setupKeyboardListener() {
    if (this.keyboardHandler) return;

    this.keyboardHandler = (e: KeyboardEvent) => {
      if (!this.siteContext.isReaderPage) return;
      if ((e as KeyboardEvent & { __atreaderMenuChapterNavigation?: boolean }).__atreaderMenuChapterNavigation) return;

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      let handled = false;

      // PageUp/PageDown - 翻页；Space - 下一页（阅读软件惯例）
      if (e.code === 'PageUp') {
        this.performPageTurn('backward');
        handled = true;
      } else if (e.code === 'PageDown') {
        this.performPageTurn('forward');
        handled = true;
      } else if (e.code === 'Space' && !e.shiftKey) {
        // Shift+Space 保留给浏览器原生行为（部分网页用它向上翻页）
        this.performPageTurn('forward');
        handled = true;
      }
      // Numpad7 - 忽略
      else if (e.code === 'Numpad7') {
        handled = true;
      }
      // 上下键 - 切换章节
      else if (e.code === 'ArrowUp') {
        handled = this.navigateChapter(-1);
      } else if (e.code === 'ArrowDown') {
        handled = this.navigateChapter(1);
      }
      // Enter - 切换全屏
      // 遥控器确认键：全屏是高频操作（阅读变宽是一次性设置，不宜占用此键）。
      // 全屏逻辑在 Rust 端 handle_menu_action("toggle_fullscreen")，
      // 含 Windows 全屏自动隐藏菜单栏的同步，跨平台行为一致。
      else if (e.code === 'Enter') {
        invoke('simulate_menu_click', { action: 'toggle_fullscreen' }).catch(() => {});
        handled = true;
      }
      // Home 键：系统路径只拦截（防默认滚动），功能统一走 HID home 的
      // press/release（短按显隐导航栏、长按回书城首页），避免双路径重复触发。
      else if (e.code === 'Home') {
        handled = true;
      }
      // 小米遥控器菜单键：首个未知信号立即切换工具栏；后续重复信号只负责阻止默认右键菜单。
      else if (e.code === 'Unidentified' && e.keyCode === 0) {
        this.handleRemoteMenuSignal('system');
        handled = true;
      }

      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };

    // macOS WebKit 将小米遥控器菜单键报告为左上角 (1,1) 的 contextmenu，
    // 松开后才补发 Unidentified keyup；壳在网页收到前完成识别和拦截。
    this.contextMenuHandler = (e: MouseEvent) => {
      if (!this.siteContext.isReaderPage) return;
      if (this.isRemoteMenuContextEvent(e)) {
        this.handleRemoteMenuSignal('system');
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (Date.now() - this.lastMenuKeyAt > MENU_CONTEXT_GUARD_MS) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    this.keyupHandler = (e: KeyboardEvent) => {
      if (!this.siteContext.isReaderPage || !this.isRemoteMenuKeyboardEvent(e)) return;
      this.handleRemoteMenuRelease('system');
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    window.addEventListener('keydown', this.keyboardHandler, { passive: false, capture: true });
    window.addEventListener('keyup', this.keyupHandler, { capture: true });
    window.addEventListener('contextmenu', this.contextMenuHandler, { capture: true });

    // 自有蓝牙识别层：只消费系统键盘路径给不到的按键（音量±/语音/返回/电源），
    // 既有键继续走上面的键盘事件路径，两条链路按 button 天然分工。
    this.unsubscribeRemoteHid = subscribeRemoteHidButtons((event) =>
      this.handleRemoteHidButton(event),
    );
  }

  private handleRemoteHidButton(event: RemoteHidButtonEvent) {
    if (event.button === 'menu') {
      if (event.phase === 'press') {
        this.menuHidActive = true;
        this.handleRemoteMenuSignal('hid');
      } else if (event.phase === 'release') {
        this.menuHidActive = false;
        this.handleRemoteMenuRelease('hid');
      }
      return;
    }
    const isReaderPage = this.siteContext.isReaderPage;
    switch (event.button) {
      // 音量±：短按翻页（阅读页），长按 0.5s 页面放大/缩小（同 ⌘+/⌘−）
      case 'volume_up':
        this.handleButtonHold(event.button, event.phase, isReaderPage,
          () => void invoke('simulate_menu_click', { action: 'zoom_in' }).catch(() => {}),
          () => this.performPageTurn('backward'));
        return;
      case 'volume_down':
        this.handleButtonHold(event.button, event.phase, isReaderPage,
          () => void invoke('simulate_menu_click', { action: 'zoom_out' }).catch(() => {}),
          () => this.performPageTurn('forward'));
        return;
      // 返回：短按切换阅读区域宽窄，长按 0.5s 页面恢复 100%（同 ⌘0）
      case 'back':
        this.handleButtonHold(event.button, event.phase, true,
          () => void invoke('simulate_menu_click', { action: 'zoom_reset' }).catch(() => {}),
          () => void invoke('simulate_menu_click', { action: 'reader_wide' }).catch(() => {}));
        return;
      // 主页：短按显隐顶部导航栏（仅阅读页，原系统键盘路径语义），
      // 长按 0.5s 回书架（manifest.site.shelf，缺省回退首页；任意页面）
      case 'home':
        this.handleButtonHold(event.button, event.phase, true,
          () => {
            // 站点弹回守卫（如多看）据此放行用户主动离开
            try { sessionStorage.setItem('atreader-home-nav', String(Date.now())); } catch {}
            void invoke('simulate_menu_click', { action: 'bookstore_shelf' }).catch(() => {});
          },
          () => {
            if (!isReaderPage) return;
            const current = settingsStore.get();
            settingsStore.update({ hideNavbar: !current.hideNavbar });
          });
        return;
      // 电源：摸鱼键（按下即触发，无长短按之分）
      case 'power':
        if (event.phase === 'press') {
          invoke('toggle_stealth').catch(() => {});
        }
        return;
    }
    // 未绑定动作且系统路径也给不到的键：记日志便于后续映射（voice 留给三期 ATVV）。
    if (event.phase === 'press') {
      if (event.button === 'voice' || event.button.startsWith('usage_')) {
        log.info(`[RemoteHid] 按键 ${event.button}（暂未绑定动作）`);
      }
    }
  }

  /**
   * 通用长按分流：按住 holdMs 触发 onLong（仅一次），松开时若长按未触发
   * 则执行 onShort。enabled=false 时整颗按键不响应（如非阅读页的音量键）。
   */
  private handleButtonHold(
    button: string,
    phase: RemoteHidPhase,
    enabled: boolean,
    onLong: () => void,
    onShort: () => void,
  ): void {
    if (phase === 'press') {
      if (!enabled || this.holdTimers.has(button)) return;
      const timer = setTimeout(() => {
        this.holdTimers.delete(button);
        onLong();
      }, BUTTON_HOLD_MS);
      this.holdTimers.set(button, timer);
      return;
    }
    const timer = this.holdTimers.get(button);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.holdTimers.delete(button);
    onShort();
  }

  private isRemoteMenuKeyboardEvent(e: KeyboardEvent): boolean {
    return e.code === 'Unidentified'
      && e.keyCode === 0
      && (e.key === '\u0010' || e.key === 'Unidentified' || e.key === '');
  }

  private isRemoteMenuContextEvent(e: MouseEvent): boolean {
    return e.type === 'contextmenu'
      && e.button === 2
      && e.buttons === 0
      && e.detail === 0
      && e.clientX === 1
      && e.clientY === 1;
  }

  /** 菜单键按下：短按在松开时显隐工具栏；按住 500ms 打开目录。 */
  private handleRemoteMenuSignal(source: 'hid' | 'system'): void {
    // 本地阅读器由自己的监听器处理，避免重复 toast/操作。
    if (this.siteContext.siteId === 'local') return;
    // 系统路径在 HID 按住期间不得抢先取消/重启计时。
    if (source === 'system' && this.menuHidActive) return;
    // 松开后迟到的系统 contextmenu 不再开启新一轮长按计时。
    if (
      source === 'system' &&
      !this.menuPressActive &&
      Date.now() - this.lastMenuReleaseAt < 300
    ) {
      return;
    }
    this.lastMenuKeyAt = Date.now();
    if (this.menuPressActive) return;
    this.menuPressActive = true;
    this.menuLongFired = false;
    this.menuHoldTimer = setTimeout(() => {
      this.menuHoldTimer = null;
      this.menuLongFired = true;
      const siteId = this.siteContext.siteId;
      if (!this.siteContext.isReaderPage) return;
      const outcome = openReaderToc(siteId);
      log.info(`[RemoteManager] 菜单长按 site=${siteId} outcome=${outcome}`);
      if (outcome === 'not-found') showToast('未找到目录入口');
    }, MENU_HOLD_MS);
  }

  private handleRemoteMenuRelease(source: 'hid' | 'system'): void {
    if (this.siteContext.siteId === 'local') return;
    // 系统 keyup 可能早于 HID release；HID 仍按住时以 HID 为准。
    if (source === 'system' && this.menuHidActive) return;
    if (!this.menuPressActive) return;
    this.menuPressActive = false;
    this.lastMenuReleaseAt = Date.now();
    if (this.menuHoldTimer !== null) {
      clearTimeout(this.menuHoldTimer);
      this.menuHoldTimer = null;
    }
    const longPress = this.menuLongFired;
    this.menuLongFired = false;
    if (longPress) return;
    // 目录展开时，单击改为收起目录（长按开 → 单击关，可循环）；
    // 目录没开时维持原语义：切换工具栏显隐。
    if (closeReaderToc(this.siteContext.siteId)) return;
    const current = settingsStore.get();
    settingsStore.update({ hideToolbar: !current.hideToolbar });
  }

  destroy() {
    this.initializationGeneration++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.menuHoldTimer) clearTimeout(this.menuHoldTimer);
    this.menuHoldTimer = null;
    for (const timer of this.holdTimers.values()) clearTimeout(timer);
    this.holdTimers.clear();
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.unsubscribeReaderCommand?.();
    this.unsubscribeReaderCommand = null;
    if (this.routeChangedHandler) {
      window.removeEventListener('ipc:route-changed', this.routeChangedHandler);
      this.routeChangedHandler = null;
    }
    if (this.tocPickHandler) {
      window.removeEventListener('atreader:toc-chapter-pick', this.tocPickHandler);
      this.tocPickHandler = null;
    }
    this.disable();
    chapterManager.reset();
    log.info('[RemoteManager] 已销毁');
  }
}
