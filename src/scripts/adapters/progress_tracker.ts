/**
 * 进度跟踪器 (新算法)
 *
 * 三级事件系统：
 * - HIGH: 进入阅读页 -> 获取章节信息 + 初始进度
 * - MEDIUM: 章节切换 -> 修正算法 + 重置 turningPages
 * - LOW: 翻页 -> turningPages ± 1
 */

import { BaseManager, Events } from '../core/base_manager';

/**
 * 章节信息接口
 */
export interface ChapterInfo {
  chapterIdx: number;
  title: string;          // 章节标题（用于目录跳转匹配）
  wordCount: number;
  maxOffset: number;      // wordCount × 1.5 + 1000
  maxPages: number;       // maxOffset / 800 取整（双栏模式，一页包含左右两栏）
}

/**
 * 进度更新事件优先级
 */
enum EventPriority {
  HIGH = 3,    // 高优先级：进入阅读页
  MEDIUM = 2,  // 中优先级：章节切换
  LOW = 1,     // 低优先级：翻页
}

/**
 * 翻页方向
 */
enum PageDirection {
  FORWARD = 1,   // 向前（下一页）
  BACKWARD = -1, // 向后（上一页）
}

export class ProgressTracker extends BaseManager {
  // 书籍信息缓存
  private bookInfoCache: Map<string, ChapterInfo[]> = new Map();
  private currentBookId: string | null = null;
  private currentChapterIdx: number = 0;
  private currentProgress: number = 0;  // 当前进度 0-100

  // 每章已翻页数
  private turningPages: number = 0;

  // 防止重复初始化
  private isInitializing: boolean = false;

  // 事件优先级控制
  private lastEventPriority: EventPriority = EventPriority.LOW;
  private lastEventTime: number = 0;
  private readonly EVENT_DEBOUNCE_MS = 100;

  // 翻页方向追踪
  private pendingDirection: PageDirection | null = null;  // 局内变量: 500ms 内随便改
  private lastPageDirection: PageDirection | null = null;  // 局外变量: 500ms 结束后才更新，供章节切换判断
  private lastDirectionTime: number = 0;  // 记录最后一次翻页方向确认的时间
  private pageDirectionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DIRECTION_DEBOUNCE_MS = 500;

  // DOM 事件处理器（用于清理）
  private domReadyHandler: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor() {
    super();
    this.init();
  }

  private init(): void {
    // 监听路由变化事件（进入阅读页）
    this.onWithHistory(Events.ROUTE_CHANGED, (e: RouteChangedEvent) => {
      if (e.isReader) {
        const bookId = this.extractBookIdFromUrl(e.url);
        if (bookId) {
          if (this.currentBookId !== bookId) {
            this.onEnterReaderPage(bookId);
          }
        }
      }
    });

    // 监听章节切换事件
    this.on(Events.CHAPTER_CHANGED, (e: ChapterChangedEvent) => {
      if (this.currentBookId) {
        this.onChapterChange(this.currentBookId, e.url);
      }
    });

    // 监听翻页方向事件（来自 SwipeHandler 和键盘）
    this.on(Events.PAGE_TURN_DIRECTION, (data: { direction: 'forward' | 'backward' }) => {
      const pageDirection = data.direction === 'forward' ? PageDirection.FORWARD : PageDirection.BACKWARD;
      this.recordPageDirection(pageDirection);
    });

    // 监听 DOM 准备就绪
    this.domReadyHandler = () => {
      this.checkCurrentPage();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', this.domReadyHandler, { once: true });
    } else {
      this.domReadyHandler();
    }

    // 初始化翻页监听
    this.initPageTurnMonitor();
  }

  private checkCurrentPage() {
    const currentUrl = window.location.href;
    if (window.location.pathname.includes('/web/reader/')) {
      const bookId = this.extractBookIdFromUrl(currentUrl);
      if (bookId) {
        this.onEnterReaderPage(bookId);
      }
    }
  }

  // =====================================================
  // 事件处理
  // =====================================================

  /**
   * 高优先级事件：进入阅读页
   * - 获取章节信息（含 maxPages）
   * - 获取初始进度百分比
   * - 计算初始 turningPages
   */
  private async onEnterReaderPage(bookId: string): Promise<void> {
    if (!this.shouldExecuteEvent(EventPriority.HIGH)) {
      return;
    }

    if (!bookId) {
      console.error('[ProgressTracker] bookId 为空，无法初始化');
      return;
    }

    if (this.isInitializing) {
      return;
    }

    this.isInitializing = true;

    try {
      // 1. 获取并缓存章节信息（含 maxPages）
      const chapterInfos = await this.fetchAndCacheChapterInfo(bookId);
      if (!chapterInfos) {
        console.warn('[ProgressTracker] 无法获取章节信息');
        return;
      }

      // 2. 获取初始阅读进度（只执行一次）
      const readInfo = await this.fetchReadInfo(bookId);
      if (!readInfo || readInfo.chapterIdx === undefined || readInfo.chapterOffset === undefined) {
        console.warn('[ProgressTracker] 无法获取初始阅读进度');
        return;
      }

      this.currentBookId = bookId;
      this.currentChapterIdx = readInfo.chapterIdx;

      // 3. 计算初始进度百分比
      const currentChapterInfo = chapterInfos.find(ch => ch.chapterIdx === readInfo.chapterIdx);
      if (!currentChapterInfo) {
        console.warn(`[ProgressTracker] 找不到当前章节信息，chapterIdx=${readInfo.chapterIdx}`);
        return;
      }

      // 初始进度百分比 = (offset / maxOffset) 取整
      const initialProgressPercent = Math.floor((readInfo.chapterOffset / currentChapterInfo.maxOffset) * 100);
      this.currentProgress = initialProgressPercent;

      // 4. 计算初始 turningPages = maxPages × 进度百分比
      this.turningPages = Math.floor(currentChapterInfo.maxPages * (initialProgressPercent / 100));

      this.updateProgressBar(this.currentProgress);

    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * 中优先级事件：章节切换
   * - 修正算法：用 turningPages 修正全书 maxPages
   * - 重置 turningPages（向前=0，向回=该章maxPages）
   *
   * 核心原则：不依赖异步 API，只使用本地缓存 + 翻页方向判断
   */
  private async onChapterChange(bookId: string, newUrl: string): Promise<void> {
    if (!this.shouldExecuteEvent(EventPriority.MEDIUM)) {
      return;
    }

    if (!bookId) {
      console.warn('[ProgressTracker] 无法获取 bookId，跳过章节切换处理');
      return;
    }

    const chapterInfos = this.bookInfoCache.get(bookId);
    if (!chapterInfos) {
      console.warn('[ProgressTracker] 无章节信息缓存，无法处理章节切换');
      return;
    }

    // 判断方向：使用最后一次翻页方向（10秒内有效）
    const DIRECTION_VALID_MS = 10000; // 翻页方向 10 秒内有效
    const now = Date.now();
    const isDirectionValid = this.lastPageDirection !== null &&
                             (now - this.lastDirectionTime) < DIRECTION_VALID_MS;

    if (!isDirectionValid) {
      // 没有翻页方向或方向太旧 → 用户通过目录跳转
      // 重新调用 API 获取当前章节信息（这是唯一允许的异步调用）
      await this.reinitializeAfterJump(bookId);
      return;
    }

    const isForward = this.lastPageDirection === PageDirection.FORWARD;
    const oldChapterIdx = this.currentChapterIdx;

    // 执行修正算法（在重置之前）
    await this.applyCorrectionAlgorithm(bookId, oldChapterIdx, isForward);

    // 计算新章节索引（本地计算，不调用 API）
    let newChapterIdx: number;
    if (isForward) {
      newChapterIdx = oldChapterIdx + 1;
    } else {
      newChapterIdx = oldChapterIdx - 1;
    }

    // 从缓存查找新章节信息
    const newChapterInfo = chapterInfos.find(ch => ch.chapterIdx === newChapterIdx);
    if (!newChapterInfo) {
      console.warn(`[ProgressTracker] 找不到新章节信息: chapterIdx=${newChapterIdx}`);
      // 可能翻到了书的开头或结尾，忽略
      return;
    }

    // 更新当前章节
    this.currentChapterIdx = newChapterIdx;

    // 重置 turningPages
    if (isForward) {
      // 向前：turningPages = 0
      this.turningPages = 0;
      this.currentProgress = 0;
    } else {
      // 向回：turningPages = 该章 maxPages
      this.turningPages = newChapterInfo.maxPages;
      this.currentProgress = 100;
    }

    this.updateProgressBar(this.currentProgress);

    // 清除翻页方向（已使用）
    this.lastPageDirection = null;
    this.pendingDirection = null;  // 同时清除局内变量

    // 取消待执行的翻页处理，防止覆盖章节切换的进度
    if (this.pageDirectionTimer) {
      clearTimeout(this.pageDirectionTimer);
      this.pageDirectionTimer = null;
    }
  }

  /**
   * 目录跳转后重新初始化
   * 霸王硬上弓方案：从页面 Title 提取章节名，与缓存章节名匹配
   */
  private async reinitializeAfterJump(bookId: string): Promise<void> {
    const chapterInfos = this.bookInfoCache.get(bookId);
    if (!chapterInfos) {
      console.warn('[ProgressTracker] 无章节缓存，无法匹配');
      return;
    }

    // 等待 DOM Title 更新 (最多等待 1 秒)
    await this.waitForTitleUpdate();

    // 从页面 Title 提取章节名
    // 格式: "书名 - 章节名 - 作者名 - 微信读书"
    const pageTitle = document.title;

    // 遍历缓存，用短的章节名匹配长的页面标题
    let matchedChapter: ChapterInfo | null = null;
    for (const chapter of chapterInfos) {
      if (pageTitle.includes(chapter.title)) {
        matchedChapter = chapter;
        break;
      }
    }

    if (!matchedChapter) {
      console.warn('[ProgressTracker] 无法从 Title 匹配章节');
      return;
    }

    // 更新当前章节
    this.currentChapterIdx = matchedChapter.chapterIdx;

    // 目录跳转默认从该章节开头开始
    this.turningPages = 0;
    this.currentProgress = 0;

    this.updateProgressBar(this.currentProgress);
  }

  /**
   * 等待页面 Title 更新（最多 1 秒）
   */
  private async waitForTitleUpdate(): Promise<void> {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 10; // 100ms × 10 = 1 秒

      const checkTitle = () => {
        attempts++;

        // 检查 Title 是否包含章节分隔符 " - "
        if (document.title.includes(' - ') || attempts >= maxAttempts) {
          resolve();
        } else {
          setTimeout(checkTitle, 100);
        }
      };

      checkTitle();
    });
  }

  /**
   * 修正算法
   * 正着读和倒着读逻辑一样：根据实际页数修正全书的 maxPages
   */
  private async applyCorrectionAlgorithm(bookId: string, oldChapterIdx: number, isForward: boolean): Promise<void> {
    const chapterInfos = this.bookInfoCache.get(bookId);
    if (!chapterInfos) {
      return;
    }

    const oldChapterInfo = chapterInfos.find(ch => ch.chapterIdx === oldChapterIdx);
    if (!oldChapterInfo) {
      return;
    }

    console.log(`[ProgressTracker] 修正算法检查 (${isForward ? '正读' : '倒读'}): turningPages=${this.turningPages}, maxPages=${oldChapterInfo.maxPages}`);

    // 条件 1: 章节页数必须 >= 6 页（页数太少误差大，不适合作为校准依据）
    if (oldChapterInfo.maxPages < 6) {
      console.log('[ProgressTracker] 章节页数 < 6，跳过修正');
      return;
    }

    // 计算实际页数（正读倒读逻辑一样）
    let actualMaxPages: number;
    if (isForward) {
      // 正读：turningPages 就是实际翻过的页数
      actualMaxPages = this.turningPages;
    } else {
      // 倒读：turningPages 可能是负数，实际页数 = maxPages - turningPages
      // 例如：估计 17 页，实际 20 页，turningPages = -3
      // actualMaxPages = 17 - (-3) = 20
      actualMaxPages = oldChapterInfo.maxPages - this.turningPages;
    }

    // 判断是否需要修正：实际与估计差异超过 20%
    const difference = Math.abs(actualMaxPages - oldChapterInfo.maxPages);
    const ratio = difference / oldChapterInfo.maxPages;

    if (ratio > 0.2) {
      // 按比例修正全书
      const scale = actualMaxPages / oldChapterInfo.maxPages;

      let modifiedCount = 0;
      for (const chapter of chapterInfos) {
        const newMaxPages = Math.floor(chapter.maxPages * scale);

        if (newMaxPages !== chapter.maxPages && newMaxPages > 0) {
          chapter.maxPages = newMaxPages;
          modifiedCount++;
        }
      }

      const percentage = ((modifiedCount / chapterInfos.length) * 100).toFixed(1);
      console.log(`[ProgressTracker] 修正完成: ${percentage}% 章节已修正 (${modifiedCount}/${chapterInfos.length}), 比例=${scale.toFixed(3)}`);
    }
  }

  // =====================================================
  // 翻页监听
  // =====================================================

  private lastPageTurnTime = 0;
  private pageTurnMonitorInitialized = false;

  private initPageTurnMonitor(): void {
    if (this.pageTurnMonitorInitialized) {
      return;
    }
    this.pageTurnMonitorInitialized = true;

    // 监听键盘翻页
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        console.log('[ProgressTracker] 键盘右键 → 记录向前方向');
        this.recordPageDirection(PageDirection.FORWARD);
      } else if (e.key === 'ArrowLeft') {
        console.log('[ProgressTracker] 键盘左键 → 记录向后方向');
        this.recordPageDirection(PageDirection.BACKWARD);
      }
    };
    window.addEventListener('keydown', this.keydownHandler);
  }

  /**
   * 记录翻页方向
   * 防抖策略: 500ms 内收集所有按键，最后一次方向为赢家
   */
  private recordPageDirection(direction: PageDirection): void {
    // 更新局内变量（500ms 内随便改）
    this.pendingDirection = direction;

    // 重置定时器：每次按键都重置
    if (this.pageDirectionTimer) {
      clearTimeout(this.pageDirectionTimer);
    }

    this.pageDirectionTimer = setTimeout(() => {
      // 500ms 结束：把局内变量赋给局外变量
      if (this.pendingDirection !== null) {
        this.lastPageDirection = this.pendingDirection;
        this.lastDirectionTime = Date.now();
        this.pendingDirection = null;
      }
      // 执行翻页处理
      this.processPageTurn();
    }, this.DIRECTION_DEBOUNCE_MS);
  }

  /**
   * 处理翻页（已废弃,防抖逻辑已移至 recordPageDirection）
   */
  private handlePageTurn(): void {
    // 空实现,防抖已移到 recordPageDirection 中
  }

  /**
   * 处理翻页（更新 turningPages 和进度）
   * 注意：不在这里清除 lastPageDirection，保留给章节切换判断
   */
  private processPageTurn(): void {
    if (!this.shouldExecuteEvent(EventPriority.LOW)) {
      return;
    }

    if (this.lastPageDirection === null) {
      return;
    }

    // 更新 turningPages
    if (this.lastPageDirection === PageDirection.FORWARD) {
      this.turningPages++;
    } else {
      this.turningPages--;
    }

    // 注意：倒读时 turningPages 可以是负数，不要限制为 >= 0

    // 计算新进度
    this.updateProgressFromTurningPages();

    console.log(`[ProgressTracker] 翻页: direction=${this.lastPageDirection === PageDirection.FORWARD ? '向前' : '向回'}, ` +
                `turningPages=${this.turningPages}, progress=${this.currentProgress}%`);

    // 不再清除 lastPageDirection，保留给章节切换使用
  }

  /**
   * 根据 turningPages 计算进度
   * 不限制上下限，允许超过 100% 或低于 0%
   */
  private updateProgressFromTurningPages(): void {
    const chapterInfos = this.bookInfoCache.get(this.currentBookId!);
    if (!chapterInfos) {
      return;
    }

    const currentChapterInfo = chapterInfos.find(ch => ch.chapterIdx === this.currentChapterIdx);
    if (!currentChapterInfo) {
      return;
    }

    // 进度 = (turningPages / maxPages) × 100
    // 不限制 0-100 范围，允许负数和超过 100
    const newProgress = Math.round((this.turningPages / currentChapterInfo.maxPages) * 100);
    this.currentProgress = newProgress;
    this.updateProgressBar(this.currentProgress);
  }

  // =====================================================
  // 工具方法
  // =====================================================

  private shouldExecuteEvent(priority: EventPriority): boolean {
    const now = Date.now();
    if (now - this.lastEventTime < this.EVENT_DEBOUNCE_MS) {
      if (priority < this.lastEventPriority) {
        console.log(`[ProgressTracker] 事件被抑制：优先级=${priority}, 上次优先级=${this.lastEventPriority}`);
        return false;
      }
    }

    this.lastEventPriority = priority;
    this.lastEventTime = now;
    return true;
  }

  private extractBookIdFromUrl(url: string): string | null {
    const match = url.match(/\/web\/reader\/([^/]+)/);
    if (!match) {
      console.warn('[ProgressTracker] 无法从 URL 提取 bookId:', url);
      return null;
    }

    return this.getNumericBookId();
  }

  private getNumericBookId(): string | null {
    const jsonLdScript = document.querySelector('script[type="application/ld+json"]');
    if (jsonLdScript && jsonLdScript.textContent) {
      try {
        const data = JSON.parse(jsonLdScript.textContent);
        if (data['@Id']) {
          return String(data['@Id']);
        }
      } catch (e) {
        // 忽略
      }
    }

    if ((window as any).bookId) {
      return String((window as any).bookId);
    }

    return null;
  }

  /**
   * 获取并缓存章节信息
   */
  private async fetchAndCacheChapterInfo(bookId: string): Promise<ChapterInfo[] | null> {
    if (this.bookInfoCache.has(bookId)) {
      console.log(`[ProgressTracker] 从缓存读取章节信息，bookId: ${bookId}`);
      return this.bookInfoCache.get(bookId)!;
    }

    const cookies = document.cookie;
    const hasVid = cookies.includes('wr_vid') || cookies.includes('wr_localvid');

    if (!hasVid) {
      console.log('[ProgressTracker] 用户未登录，跳过获取章节信息');
      return null;
    }

    try {
      console.log(`[ProgressTracker] 从 API 获取章节信息，bookId: ${bookId}`);

      const response = await fetch('https://weread.qq.com/web/book/chapterInfos', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bookIds: [bookId],
          syncKeys: [0],
          teenmode: 0
        }),
      });

      if (!response.ok) {
        console.warn(`[ProgressTracker] 章节信息 API 请求失败: ${response.status}`);
        return null;
      }

      const data = await response.json();

      if (data.errCode && data.errCode !== 0) {
        console.warn(`[ProgressTracker] 章节信息 API 错误: ${data.errCode}`);
        return null;
      }

      if (data.data && data.data[0]) {
        const rawChapters = data.data[0].updated || [];

        const chapterInfos: ChapterInfo[] = rawChapters.map((ch: any) => {
          const maxOffset = ch.wordCount * 1.5 + 1000;
          const maxPages = Math.floor(maxOffset / 800);  // 双栏模式，一页包含左右两栏

          return {
            chapterIdx: ch.chapterIdx,
            title: ch.title || '',  // 缓存章节标题
            wordCount: ch.wordCount,
            maxOffset: maxOffset,
            maxPages: maxPages,
          };
        });

        this.bookInfoCache.set(bookId, chapterInfos);
        console.log(`[ProgressTracker] 成功缓存 ${chapterInfos.length} 个章节信息`);
        return chapterInfos;
      }

      return null;

    } catch (error: any) {
      console.error('[ProgressTracker] 获取章节信息失败:', error);
      return null;
    }
  }

  /**
   * 获取阅读进度（只用于初始化）
   */
  private async fetchReadInfo(bookId: string): Promise<{
    chapterIdx?: number;
    chapterOffset?: number;
  } | null> {
    try {
      const response = await fetch(`https://weread.qq.com/web/book/getProgress?bookId=${bookId}&_=${Date.now()}`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      if (data.errCode && data.errCode !== 0) {
        return null;
      }

      if (data.book) {
        return {
          chapterIdx: data.book.chapterIdx,
          chapterOffset: data.book.chapterOffset,
        };
      }

      return null;

    } catch (error: any) {
      console.error('[ProgressTracker] 获取阅读进度失败:', error);
      return null;
    }
  }

  private updateProgressBar(progress: number): void {
    console.log(`[ProgressTracker] 发送进度更新事件: ${progress}%`);
    this.emit(Events.PROGRESS_UPDATED, { progress });
  }

  // =====================================================
  // 公共 API
  // =====================================================

  getCurrentProgress(): number {
    return this.currentProgress;
  }

  // =====================================================
  // 清理
  // =====================================================

  destroy(): void {
    // 清理定时器
    if (this.pageDirectionTimer) {
      clearTimeout(this.pageDirectionTimer);
      this.pageDirectionTimer = null;
    }

    // 清理 DOM 事件监听器
    if (this.domReadyHandler) {
      document.removeEventListener('DOMContentLoaded', this.domReadyHandler);
      this.domReadyHandler = null;
    }

    if (this.keydownHandler) {
      window.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }

    // 调用基类清理
    super.destroy();
  }
}

// 类型导入（保持兼容）
import type { RouteChangedEvent } from '../../managers/ipc_manager';
import type { ChapterChangedEvent } from '../../managers/ipc_manager';
