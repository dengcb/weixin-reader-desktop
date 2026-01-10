import { settingsStore } from '../core/settings_store';
import { createSiteContext, SiteContext } from '../core/site_context';
import { log } from '../core/logger';
import { EventBus, Events } from '../core/event_bus';
import { chapterManager } from '../core/chapter_manager';
import { showToast } from '../core/toast';

/**
 * RemoteManager - 极简蓝牙遥控器管理器
 *
 * 支持：iReader 遥控器、小米蓝牙遥控器
 */
export class RemoteManager {
  private siteContext: SiteContext;
  private enabled = false;
  private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;
  private menuKeyDebouncing = false;

  // 当前章节索引（从 URL 或 API 获取）
  private currentChapterIdx: number = -1;

  constructor() {
    this.siteContext = createSiteContext();
    this.init();
  }

  private init() {
    // 订阅设置
    settingsStore.subscribe((settings) => {
      const shouldEnable = settings.enableRemoteController !== false;
      if (shouldEnable && !this.enabled) this.enable();
      else if (!shouldEnable && this.enabled) this.disable();
    });

    // 初始检查
    const settings = settingsStore.get();
    if (settings.enableRemoteController !== false) this.enable();

    // 路由变化时初始化
    window.addEventListener('ipc:route-changed', () => this.tryInitialize());

    // 首次加载
    if (this.siteContext.isReaderPage) {
      this.tryInitialize();
    }

    log.info('[RemoteManager] 初始化完成');
  }

  /**
   * 尝试初始化章节数据
   */
  private async tryInitialize() {
    if (!this.siteContext.isReaderPage) return;

    // 等待页面加载
    let retries = 0;
    const maxRetries = 20;

    const check = async () => {
      // 提取 URL 路径作为 bookId
      const pathMatch = window.location.pathname.match(/\/web\/reader\/([^?#]+)/);
      if (!pathMatch) {
        if (++retries < maxRetries) setTimeout(check, 500);
        return;
      }

      // 第一次进入时，URL 就是 bookId（可能包含 k+chapterId，取 k 之前的部分）
      const fullPath = pathMatch[1];
      const kIndex = fullPath.indexOf('k');
      const bookIdSegment = kIndex > 0 ? fullPath.substring(0, kIndex) : fullPath;

      // 初始化 ChapterManager
      const success = await chapterManager.initialize(bookIdSegment);
      if (!success) {
        if (++retries < maxRetries) setTimeout(check, 500);
        else log.warn('[RemoteManager] 初始化失败');
        return;
      }

      // 尝试从 URL 获取当前章节
      this.updateCurrentChapterFromUrl();

      log.info(`[RemoteManager] 初始化成功，共 ${chapterManager.getChapters().length} 章`);
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
    // 检查登录状态
    if (!chapterManager.isLoggedIn()) {
      log.warn('[RemoteManager] 未登录，章节跳转暂停');
      return false;
    }

    if (!chapterManager.isInitialized()) {
      log.warn('[RemoteManager] 未初始化');
      return false;
    }

    // 先尝试从 URL 更新当前章节
    this.updateCurrentChapterFromUrl();

    if (this.currentChapterIdx < 0) {
      log.warn('[RemoteManager] 未知当前章节，请先翻页');
      return false;
    }

    const chapters = chapterManager.getChapters();
    const currentArrayIdx = chapters.findIndex(c => c.chapterIdx === this.currentChapterIdx);
    if (currentArrayIdx < 0) {
      log.warn('[RemoteManager] 找不到当前章节');
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
      log.error('[RemoteManager] 无法生成目标 URL');
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
    this.enabled = true;
    log.info('[RemoteManager] 已启用');
  }

  private disable() {
    if (!this.enabled) return;
    if (this.keyboardHandler) {
      window.removeEventListener('keydown', this.keyboardHandler);
      this.keyboardHandler = null;
    }
    this.enabled = false;
    log.info('[RemoteManager] 已禁用');
  }

  private performPageTurn(direction: 'forward' | 'backward') {
    const adapter = this.siteContext.currentAdapter;
    if (!adapter) return;

    EventBus.emit(Events.PAGE_TURN_DIRECTION, { direction });
    if (direction === 'forward') adapter.nextPage();
    else adapter.prevPage();
  }

  private setupKeyboardListener() {
    if (this.keyboardHandler) return;

    this.keyboardHandler = (e: KeyboardEvent) => {
      if (!this.siteContext.isReaderPage) return;

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      let handled = false;

      // PageUp/PageDown - 翻页
      if (e.code === 'PageUp') {
        this.performPageTurn('backward');
        handled = true;
      } else if (e.code === 'PageDown') {
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
      // Enter - 宽屏模式
      else if (e.code === 'Enter') {
        const current = settingsStore.get();
        settingsStore.update({ readerWide: !current.readerWide });
        handled = true;
      }
      // Home - 隐藏导航栏
      else if (e.code === 'Home') {
        const current = settingsStore.get();
        settingsStore.update({ hideNavbar: !current.hideNavbar });
        handled = true;
      }
      // 菜单键 - 隐藏工具栏
      else if (e.code === 'Unidentified' && e.keyCode === 0) {
        if (!this.menuKeyDebouncing) {
          const current = settingsStore.get();
          settingsStore.update({ hideToolbar: !current.hideToolbar });
          this.menuKeyDebouncing = true;
          setTimeout(() => { this.menuKeyDebouncing = false; }, 1000);
          handled = true;
        }
      }

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('keydown', this.keyboardHandler, { passive: false, capture: true });
  }

  destroy() {
    this.disable();
    log.info('[RemoteManager] 已销毁');
  }
}
