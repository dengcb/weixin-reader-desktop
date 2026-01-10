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

/**
 * ChapterManager - 极简章节数据管理器
 *
 * 核心原则：
 * 1. 第一次进入阅读页时，URL 路径就是 bookId，直接缓存
 * 2. 数字型 ID 只在调用 API 时从页面读取，不缓存
 * 3. 后续全部本地计算
 * 4. 登录状态实时检测
 */
class ChapterManager {
  private static instance: ChapterManager | null = null;

  // 缓存的 bookId（URL 路径，23-24 位字符串）
  private bookId: string | null = null;

  // 章节数据
  private chapters: ChapterData[] = [];

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
    // 如果已初始化同一本书，跳过
    if (this.bookId === bookId && this.chapters.length > 0) {
      log.info('[ChapterManager] 已初始化，跳过');
      return true;
    }

    // 1. 缓存 bookId
    this.bookId = bookId;
    log.info(`[ChapterManager] 缓存 bookId: ${bookId}`);

    // 2. 从页面获取数字型 ID（用于 API 调用）
    const numericId = this.readNumericBookId();
    if (!numericId) {
      log.error('[ChapterManager] 无法获取数字型 ID');
      return false;
    }

    // 3. 调用 API 获取章节数据
    try {
      const response = await fetch(`https://weread.qq.com/web/book/chapterInfos?_=${Date.now()}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify({ bookIds: [numericId] }),
      });

      if (!response.ok) {
        log.error(`[ChapterManager] API 失败: ${response.status}`);
        return false;
      }

      const result = await response.json();

      // 检查 API 错误（可能未登录）
      if (result.errCode && result.errCode !== 0) {
        log.warn(`[ChapterManager] API 错误: ${result.errCode}`);
        return false;
      }

      const bookData = result?.data?.[0];
      if (!bookData?.updated?.length) {
        log.warn('[ChapterManager] API 返回空数据');
        return false;
      }

      // 4. 处理章节数据，按 chapterIdx 排序
      this.chapters = bookData.updated
        .map((c: any): ChapterData => ({
          chapterUid: c.chapterUid,
          chapterIdx: c.chapterIdx,
          title: c.title || '',
          wordCount: c.wordCount || 0,
          maxOffset: (c.wordCount || 0) * 1.5 + 1000,
          maxPages: Math.floor(((c.wordCount || 0) * 1.5 + 1000) / 800),
        }))
        .sort((a: ChapterData, b: ChapterData) => a.chapterIdx - b.chapterIdx);

      log.info(`[ChapterManager] 初始化成功，${this.chapters.length} 章`);
      return true;

    } catch (e) {
      log.error('[ChapterManager] 初始化失败', e);
      return false;
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
}

export const chapterManager = ChapterManager.getInstance();
