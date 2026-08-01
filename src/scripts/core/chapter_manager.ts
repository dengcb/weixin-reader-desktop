import { log } from './logger';
import { getChapterUrl } from '../utils/chapter';

/**
 * 章节数据
 */
export interface ChapterData {
  chapterUid: number;
  chapterIdx: number;
  title: string;
  wordCount: number;
  maxOffset: number;
  maxPages: number;
}

export const CHAPTER_CACHE_LIMIT = 20;

interface ChapterApiItem {
  chapterUid: number;
  chapterIdx: number;
  title?: string;
  wordCount?: number;
}

interface ChapterLoad {
  promise: Promise<ChapterData[] | null>;
  controller: AbortController;
}

/**
 * ChapterManager - 章节数据管理器
 *
 * 核心原则：
 * 1. URL 中的书籍 token 是缓存键，数字型 ID 只用于当次 API 请求
 * 2. 同一本书的并发初始化共用一个请求
 * 3. 保留最近书籍的章节缓存和已校准页数，同时限制内存上限
 * 4. 登录状态实时检测，失败可重试，过期请求不会覆盖当前书籍
 */
class ChapterManager {
  private static instance: ChapterManager | null = null;

  // 当前活跃的 bookId（URL 路径 token）
  private bookId: string | null = null;

  // 当前活跃书籍的章节数据
  private chapters: ChapterData[] = [];

  // Map 的插入顺序同时用作 LRU 顺序。
  private chapterCache = new Map<string, ChapterData[]>();
  private inFlightLoads = new Map<string, ChapterLoad>();
  private latestRequestedBookId: string | null = null;
  private lifecycleGeneration = 0;

  private constructor() {}

  static getInstance(): ChapterManager {
    if (!ChapterManager.instance) {
      ChapterManager.instance = new ChapterManager();
    }
    return ChapterManager.instance;
  }

  /**
   * 初始化（第一次进入阅读页时调用）
   * @param bookId URL 路径中的 bookId（23-24 位字符串）
   */
  async initialize(bookId: string): Promise<boolean> {
    if (!bookId) return false;

    this.latestRequestedBookId = bookId;
    const generation = this.lifecycleGeneration;

    const cached = this.chapterCache.get(bookId);
    if (cached?.length) {
      this.activateBook(bookId, cached);
      this.touchCache(bookId, cached);
      log.info('[ChapterManager] 使用已缓存章节数据');
      return true;
    }

    // 检查登录状态，未登录时静默返回
    if (!this.isLoggedIn()) {
      return false;
    }

    let load = this.inFlightLoads.get(bookId);
    if (!load) {
      const numericId = this.readNumericBookId();
      if (!numericId) {
        log.warn('[ChapterManager] 无法获取数字型 ID，可能页面未完全加载');
        return false;
      }

      const controller = new AbortController();
      const promise = this.loadChapters(numericId, controller.signal);
      load = { promise, controller };
      this.inFlightLoads.set(bookId, load);
      void promise.finally(() => {
        if (this.inFlightLoads.get(bookId)?.promise === promise) {
          this.inFlightLoads.delete(bookId);
        }
      });
    }

    const loadedChapters = await load.promise;
    if (generation !== this.lifecycleGeneration || !loadedChapters?.length) {
      return false;
    }

    this.cacheBook(bookId, loadedChapters);

    // 请求期间如果已经进入另一本书，只保留缓存，不激活旧书。
    if (this.latestRequestedBookId !== bookId) {
      return false;
    }

    this.activateBook(bookId, loadedChapters);
    log.info(`[ChapterManager] 初始化成功，${loadedChapters.length} 章`);
    return true;
  }

  private async loadChapters(numericId: string, signal: AbortSignal): Promise<ChapterData[] | null> {
    try {
      const response = await fetch(`https://weread.qq.com/web/book/chapterInfos?_=${Date.now()}`, {
        method: 'POST',
        credentials: 'include',
        signal,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify({ bookIds: [numericId] }),
      });

      if (!response.ok) {
        log.warn(`[ChapterManager] API 失败: ${response.status}`);
        return null;
      }

      const result = await response.json();

      // 检查 API 错误（可能未登录或权限问题）
      if (result.errCode && result.errCode !== 0) {
        // 静默处理常见错误码（-2010: 未登录, -2012: 权限不足）
        return null;
      }

      const bookData = result?.data?.[0];
      if (!bookData?.updated?.length) {
        return null;
      }

      // 按 chapterIdx 排序。下面两个经验公式是阅读进度协议，不得改变。
      return (bookData.updated as ChapterApiItem[])
        .map((c): ChapterData => ({
          chapterUid: c.chapterUid,
          chapterIdx: c.chapterIdx,
          title: c.title || '',
          wordCount: c.wordCount || 0,
          maxOffset: (c.wordCount || 0) * 1.5 + 1000,
          maxPages: Math.floor(((c.wordCount || 0) * 1.5 + 1000) / 800),
        }))
        .sort((a: ChapterData, b: ChapterData) => a.chapterIdx - b.chapterIdx);
    } catch (e) {
      if (signal.aborted) return null;
      log.error('[ChapterManager] 初始化失败', e);
      return null;
    }
  }

  private activateBook(bookId: string, chapters: ChapterData[]): void {
    this.bookId = bookId;
    this.chapters = chapters;
  }

  private touchCache(bookId: string, chapters: ChapterData[]): void {
    this.chapterCache.delete(bookId);
    this.chapterCache.set(bookId, chapters);
  }

  private cacheBook(bookId: string, chapters: ChapterData[]): void {
    this.touchCache(bookId, chapters);
    while (this.chapterCache.size > CHAPTER_CACHE_LIMIT) {
      let oldestEvictable: string | null = null;
      for (const key of this.chapterCache.keys()) {
        if (key !== this.bookId) {
          oldestEvictable = key;
          break;
        }
      }
      if (!oldestEvictable) break;
      this.chapterCache.delete(oldestEvictable);
    }
  }

  /**
   * 从页面 JSON-LD 读取数字型 bookId（不缓存，每次读取）
   */
  readNumericBookId(): string | null {
    const jsonLd = document.querySelector('script[type="application/ld+json"]');
    if (jsonLd?.textContent) {
      try {
        const data = JSON.parse(jsonLd.textContent);
        if (data['@Id']) return String(data['@Id']);
      } catch {}
    }
    return null;
  }

  // ========== Getter ==========

  getBookId(): string | null {
    return this.bookId;
  }

  getChapters(): ChapterData[] {
    return this.chapters;
  }

  getChapterByIdx(idx: number): ChapterData | undefined {
    return this.chapters.find(c => c.chapterIdx === idx);
  }

  isInitialized(): boolean {
    return this.bookId !== null && this.chapters.length > 0;
  }

  /**
   * 实时检测登录状态
   * 通过检查页面上的用户头像元素判断
   */
  isLoggedIn(): boolean {
    // 检查导航栏的用户头像（已登录时存在）
    const avatar = document.querySelector('.readerTopBar_avatar, .navBar_avatar, .wr_avatar');
    return avatar !== null;
  }

  /**
   * 生成章节 URL 片段（按需计算）
   */
  getChapterUrlSegment(chapterIdx: number): string | null {
    const chapter = this.getChapterByIdx(chapterIdx);
    if (!chapter) return null;
    return getChapterUrl(chapter.chapterUid);
  }

  /**
   * 生成完整的章节跳转 URL
   * 格式: https://weread.qq.com/web/reader/{bookId}{chapterSegment}
   * 注意: chapterSegment 已经以 k 开头
   */
  buildChapterUrl(chapterIdx: number): string | null {
    if (!this.bookId) return null;
    const chapterSegment = this.getChapterUrlSegment(chapterIdx);
    if (!chapterSegment) return null;
    return `https://weread.qq.com/web/reader/${this.bookId}${chapterSegment}`;
  }

  /**
   * 批量修正 maxPages
   */
  scaleAllMaxPages(scale: number): number {
    let count = 0;
    for (const ch of this.chapters) {
      const newMax = Math.floor(ch.maxPages * scale);
      if (newMax !== ch.maxPages && newMax > 0) {
        ch.maxPages = newMax;
        count++;
      }
    }
    return count;
  }

  reset(): void {
    this.lifecycleGeneration++;
    for (const load of this.inFlightLoads.values()) {
      load.controller.abort();
    }
    this.inFlightLoads.clear();
    this.chapterCache.clear();
    this.latestRequestedBookId = null;
    this.bookId = null;
    this.chapters = [];
  }
}

export const chapterManager = ChapterManager.getInstance();
