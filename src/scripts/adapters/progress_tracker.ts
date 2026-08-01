/**
 * 进度跟踪器 (新算法)
 *
 * 三级事件系统：
 * - HIGH: 进入阅读页 -> 初始化章节数据 + 获取初始进度
 * - MEDIUM: 章节切换 -> 修正算法 + 重置 turningPages
 * - LOW: 翻页 -> turningPages ± 1
 *
 * 数据源原则：
 * - ChapterManager 获取并有界缓存章节数据及校准结果
 * - 每次进入书籍都调用 getProgress API 获取已登录用户的初始位置
 * - 后续所有操作均为本地内存计算
 */

import { BaseManager, Events } from '../core/base_manager';
import { chapterManager, ChapterData } from '../core/chapter_manager';
import { getChapterUrl } from '../utils/chapter';

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

type InitializationRetryReason = 'metadata' | 'progress';

export class ProgressTracker extends BaseManager {
  // URL 中的书籍 token 用于识别 SPA 切书，数字 ID 用于官方进度 API。
  private currentBookToken: string | null = null;
  private currentBookId: string | null = null;
  private currentChapterIdx: number = 0;
  private currentProgress: number = 0;  // 当前进度 0-100

  // 每章已翻页数
  private turningPages: number = 0;

  // 同书重复事件只初始化一次；切书时用代次阻止旧异步结果回写。
  private initializingBookToken: string | null = null;
  private initializationGeneration = 0;
  private initializationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataRetryCount = 0;
  private progressRetryCount = 0;
  private readonly INITIALIZATION_RETRY_MS = 500;
  private readonly METADATA_RETRY_LIMIT = 20;
  private readonly PROGRESS_RETRY_LIMIT = 3;

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

  // 目录跳转时的 Title 等待句柄。
  private titleWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private titleWaitResolve: (() => void) | null = null;
  private chapterChangeGeneration = 0;

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
        const bookToken = this.extractBookTokenFromUrl(e.url);
        if (bookToken) void this.onEnterReaderPage(bookToken);
      } else {
        this.leaveReaderPage();
      }
    });

    // 监听章节切换事件
    this.on(Events.CHAPTER_CHANGED, (e: ChapterChangedEvent) => {
      const bookToken = this.extractBookTokenFromUrl(e.url);
      if (!bookToken) return;

      // IPCManager 在阅读页内切换书籍时发布章节事件，这里必须走完整的官方进度初始化。
      if (this.currentBookToken !== bookToken) {
        void this.onEnterReaderPage(bookToken);
      } else if (this.currentBookId) {
        void this.onChapterChange(e.url);
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
      const bookToken = this.extractBookTokenFromUrl(currentUrl);
      if (bookToken) void this.onEnterReaderPage(bookToken);
    }
  }

  // =====================================================
  // 事件处理
  // =====================================================

  /**
   * 高优先级事件：进入阅读页
   * - 初始化章节数据（通过 ChapterManager）
   * - 调用 API 获取这次进入书籍的初始进度百分比
   * - 计算初始 turningPages
   */
  private async onEnterReaderPage(bookToken: string, retry = false): Promise<void> {
    if (!this.shouldExecuteEvent(EventPriority.HIGH)) {
      return;
    }

    if (!bookToken || this.destroyed) {
      return;
    }

    // 历史回放与 DOMContentLoaded 可能同时通知首次进入，同书只保留一个进度请求。
    if (this.initializingBookToken === bookToken) {
      return;
    }

    if (!retry) {
      this.cancelInitializationRetry();
      this.metadataRetryCount = 0;
      this.progressRetryCount = 0;
    }

    const generation = ++this.initializationGeneration;
    this.initializingBookToken = bookToken;
    let retryReason: InitializationRetryReason | null = null;

    // 切书初始化期间暂停旧书状态，避免用新书章节表计算旧书进度。
    if (this.currentBookToken !== bookToken) {
      this.chapterChangeGeneration++;
      this.currentBookToken = null;
      this.currentBookId = null;
      this.clearDirectionTracking();
      this.finishTitleWait();
    }

    try {
      // 1. 初始化章节数据
      const success = await chapterManager.initialize(bookToken);
      if (!this.isCurrentInitialization(generation, bookToken) || !success) {
        // ChapterManager 初始化失败（可能未登录），静默返回
        retryReason = 'metadata';
        return;
      }

      const chapterInfos = chapterManager.getChapters();
      if (!chapterInfos.length) {
        retryReason = 'metadata';
        return;
      }

      // 2. 获取已登录用户对本书的官方阅读进度。
      const numericBookId = chapterManager.readNumericBookId();
      if (!numericBookId) {
        retryReason = 'metadata';
        return;
      }

      const readInfo = await this.fetchReadInfo(numericBookId);
      if (!this.isCurrentInitialization(generation, bookToken) ||
          !readInfo || readInfo.chapterIdx === undefined || readInfo.chapterOffset === undefined) {
        if (this.isCurrentInitialization(generation, bookToken)) retryReason = 'progress';
        return;
      }

      // 3. 计算初始进度百分比
      const currentChapterInfo = chapterInfos.find(ch => ch.chapterIdx === readInfo.chapterIdx);
      if (!currentChapterInfo) {
        retryReason = 'metadata';
        return;
      }

      // 初始进度百分比 = (offset / maxOffset) 取整
      const initialProgressPercent = Math.floor((readInfo.chapterOffset / currentChapterInfo.maxOffset) * 100);
      this.currentProgress = initialProgressPercent;

      // 4. 计算初始 turningPages = maxPages × 进度百分比
      this.turningPages = Math.floor(currentChapterInfo.maxPages * (initialProgressPercent / 100));

      // 数据齐全后再一次性切换当前书籍，避免失败初始化留下半成品状态。
      this.currentBookToken = bookToken;
      this.currentBookId = numericBookId;
      this.currentChapterIdx = readInfo.chapterIdx;

      this.updateProgressBar(this.currentProgress);
      this.metadataRetryCount = 0;
      this.progressRetryCount = 0;

    } finally {
      if (generation === this.initializationGeneration && this.initializingBookToken === bookToken) {
        this.initializingBookToken = null;
        if (retryReason) this.scheduleInitializationRetry(bookToken, retryReason);
      }
    }
  }

  private isCurrentInitialization(generation: number, bookToken: string): boolean {
    return !this.destroyed &&
      generation === this.initializationGeneration &&
      this.initializingBookToken === bookToken;
  }

  private scheduleInitializationRetry(bookToken: string, reason: InitializationRetryReason): void {
    if (this.destroyed || this.extractBookTokenFromUrl(window.location.href) !== bookToken) return;

    if (reason === 'metadata') {
      if (++this.metadataRetryCount > this.METADATA_RETRY_LIMIT) return;
    } else if (++this.progressRetryCount > this.PROGRESS_RETRY_LIMIT) {
      return;
    }

    this.cancelInitializationRetry();
    this.initializationRetryTimer = setTimeout(() => {
      this.initializationRetryTimer = null;
      void this.onEnterReaderPage(bookToken, true);
    }, this.INITIALIZATION_RETRY_MS);
  }

  private cancelInitializationRetry(): void {
    if (this.initializationRetryTimer) {
      clearTimeout(this.initializationRetryTimer);
      this.initializationRetryTimer = null;
    }
  }

  private leaveReaderPage(): void {
    this.initializationGeneration++;
    this.chapterChangeGeneration++;
    this.initializingBookToken = null;
    this.currentBookToken = null;
    this.currentBookId = null;
    this.cancelInitializationRetry();
    this.metadataRetryCount = 0;
    this.progressRetryCount = 0;
    this.clearDirectionTracking();
    this.finishTitleWait();
  }

  /**
   * 中优先级事件：章节切换
   * - 修正算法：用 turningPages 修正全书 maxPages
   * - 重置 turningPages（向前=0，向回=该章maxPages）
   *
   * 核心原则：不依赖异步 API，只使用本地缓存 + 翻页方向判断
   */
  private async onChapterChange(newUrl: string): Promise<void> {
    if (!this.shouldExecuteEvent(EventPriority.MEDIUM)) {
      return;
    }

    const generation = ++this.chapterChangeGeneration;

    const chapterInfos = chapterManager.getChapters();
    if (!chapterInfos.length) {
      return;
    }

    const oldChapterIdx = this.currentChapterIdx;

    // URL 中有章节 ID 时优先用缓存的 chapterUid 精确判断。
    // 双栏模式可能只更新 Title、URL 不变，此时继续使用经验方向窗口。
    const urlChapter = this.findChapterFromUrl(newUrl, chapterInfos);
    const urlChapterDelta = urlChapter ? urlChapter.chapterIdx - oldChapterIdx : 0;

    // 判断方向：仍遵守经验所得的 500ms 方向确认结果（10秒内有效）。
    const DIRECTION_VALID_MS = 10000; // 翻页方向 10 秒内有效
    const now = Date.now();
    const isDirectionValid = this.lastPageDirection !== null &&
                             (now - this.lastDirectionTime) < DIRECTION_VALID_MS;

    // URL 未变化时可能只是双栏 Title 更新，不能把原章节 ID 当成跳章目标。
    const changedUrlChapter = urlChapterDelta !== 0 ? urlChapter : null;

    // 有明确目标章节 ID 时，用它校验“方向所预期的相邻章节”。没有已确认方向，
    // 或目标不是该方向的相邻章节，都视为目录/直接跳转，不校准离开的章节。
    if (changedUrlChapter) {
      const expectedDelta = this.lastPageDirection === PageDirection.FORWARD ? 1 : -1;
      if (!isDirectionValid || urlChapterDelta !== expectedDelta) {
        this.resetToJumpedChapter(changedUrlChapter);
        return;
      }
    }

    if (!isDirectionValid) {
      // 没有翻页方向或方向太旧 → 用户通过目录跳转
      // URL 没有可识别章节 ID 时，降级为 Title 匹配。
      await this.reinitializeAfterJump(generation);
      return;
    }

    const isForward = this.lastPageDirection === PageDirection.FORWARD;

    // 执行修正算法（在重置之前）
    this.applyCorrectionAlgorithm(oldChapterIdx, isForward);

    // 计算新章节索引（本地计算，不调用 API）
    const newChapterIdx = changedUrlChapter
      ? changedUrlChapter.chapterIdx
      : oldChapterIdx + (isForward ? 1 : -1);

    // 从缓存查找新章节信息
    const newChapterInfo = chapterInfos.find(ch => ch.chapterIdx === newChapterIdx);
    if (!newChapterInfo) {
      // 可能翻到了书的开头或结尾，静默忽略
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

    this.clearDirectionTracking();
  }

  /** 从阅读 URL 的章节片段反查已缓存的 chapterUid。 */
  private findChapterFromUrl(newUrl: string, chapterInfos: ChapterData[]): ChapterData | null {
    try {
      const pathname = new URL(newUrl, window.location.href).pathname;
      const pathMatch = pathname.match(/\/web\/reader\/([^?#]+)/);
      if (!pathMatch) return null;
      const fullPath = pathMatch[1];
      return chapterInfos.find(chapter => fullPath.endsWith(getChapterUrl(chapter.chapterUid))) ?? null;
    } catch {
      return null;
    }
  }

  /** 目录直跳已由章节 ID 确认时，不再依赖 Title。 */
  private resetToJumpedChapter(chapter: ChapterData): void {
    this.currentChapterIdx = chapter.chapterIdx;
    this.turningPages = 0;
    this.currentProgress = 0;
    this.updateProgressBar(this.currentProgress);
    this.clearDirectionTracking();
  }

  private clearDirectionTracking(): void {
    this.lastPageDirection = null;
    this.pendingDirection = null;
    this.lastDirectionTime = 0;
    if (this.pageDirectionTimer) {
      clearTimeout(this.pageDirectionTimer);
      this.pageDirectionTimer = null;
    }
  }

  /**
   * 目录跳转后重新初始化
   * 霸王硬上弓方案：从页面 Title 提取章节名，与缓存章节名匹配
   */
  private async reinitializeAfterJump(generation = this.chapterChangeGeneration): Promise<void> {
    const chapterInfos = chapterManager.getChapters();
    if (!chapterInfos.length) {
      return;
    }

    // 等待 DOM Title 更新 (最多等待 1 秒)
    await this.waitForTitleUpdate();
    if (this.destroyed || generation !== this.chapterChangeGeneration) return;

    // 从页面 Title 提取章节名
    // 格式: "书名 - 章节名 - 作者名 - 微信读书"
    const pageTitle = document.title;

    // 遍历缓存，用短的章节名匹配长的页面标题
    let matchedChapter: ChapterData | null = null;
    for (const chapter of chapterInfos) {
      if (chapter.title && pageTitle.includes(chapter.title)) {
        matchedChapter = chapter;
        break;
      }
    }

    if (!matchedChapter) {
      return;
    }

    // 更新当前章节
    this.currentChapterIdx = matchedChapter.chapterIdx;

    // 目录跳转默认从该章节开头开始
    this.turningPages = 0;
    this.currentProgress = 0;

    this.updateProgressBar(this.currentProgress);
    this.clearDirectionTracking();
  }

  /**
   * 等待页面 Title 更新（最多 1 秒）
   */
  private async waitForTitleUpdate(): Promise<void> {
    this.finishTitleWait();
    return new Promise((resolve) => {
      this.titleWaitResolve = resolve;
      let attempts = 0;
      const maxAttempts = 10; // 100ms × 10 = 1 秒

      const checkTitle = () => {
        attempts++;

        // 检查 Title 是否包含章节分隔符 " - "
        if (document.title.includes(' - ') || attempts >= maxAttempts) {
          this.finishTitleWait();
        } else {
          this.titleWaitTimer = setTimeout(checkTitle, 100);
        }
      };

      checkTitle();
    });
  }

  private finishTitleWait(): void {
    if (this.titleWaitTimer) {
      clearTimeout(this.titleWaitTimer);
      this.titleWaitTimer = null;
    }
    const resolve = this.titleWaitResolve;
    this.titleWaitResolve = null;
    resolve?.();
  }

  /**
   * 修正算法
   * 正着读和倒着读逻辑一样：根据实际页数修正全书的 maxPages
   */
  private applyCorrectionAlgorithm(oldChapterIdx: number, isForward: boolean): void {
    const chapterInfos = chapterManager.getChapters();
    if (!chapterInfos.length) {
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

      // 使用 ChapterManager 批量修正
      const modifiedCount = chapterManager.scaleAllMaxPages(scale);

      const percentage = ((modifiedCount / chapterInfos.length) * 100).toFixed(1);
      console.log(`[ProgressTracker] 修正完成: ${percentage}% 章节已修正 (${modifiedCount}/${chapterInfos.length}), 比例=${scale.toFixed(3)}`);
    }
  }

  // =====================================================
  // 翻页监听
  // =====================================================

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
      this.pageDirectionTimer = null;
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
    if (!this.currentBookToken || !this.currentBookId || chapterManager.getBookId() !== this.currentBookToken) {
      return;
    }

    // 检查登录状态
    if (!chapterManager.isLoggedIn()) {
      return;
    }

    const chapterInfos = chapterManager.getChapters();
    if (!chapterInfos.length) {
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

  private extractBookTokenFromUrl(url: string): string | null {
    let pathname: string;
    try {
      pathname = new URL(url, window.location.href).pathname;
    } catch {
      return null;
    }

    const match = pathname.match(/\/web\/reader\/([^/]+)/);
    if (!match) return null;
    const fullPath = match[1];
    const chapterMarker = fullPath.indexOf('k');
    return chapterMarker > 0 ? fullPath.substring(0, chapterMarker) : fullPath;
  }

  /**
   * 获取阅读进度（只用于这次进入书籍的初始化）
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

    } catch {
      // 未登录或网络错误时静默返回
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
    this.initializationGeneration++;
    this.chapterChangeGeneration++;
    this.initializingBookToken = null;
    this.cancelInitializationRetry();
    this.finishTitleWait();

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
import type { RouteChangedEvent } from '../managers/ipc_manager';
import type { ChapterChangedEvent } from '../managers/ipc_manager';
