import { createPluginAPI } from '../plugin_api';
import WeReadPlugin from '../../../../plugins/weread';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ProgressTracker } from '../../../../plugins/weread/progress_tracker';
import { chapterManager, type ChapterData } from '../../../../plugins/weread/chapter_manager';
import { EventBus } from '../event_bus';

const original = {
  getChapters: chapterManager.getChapters,
  getBookId: chapterManager.getBookId,
};

const chapter = (chapterIdx: number, wordCount: number): ChapterData => ({
  chapterUid: 10_000 + chapterIdx,
  chapterIdx,
  title: `第${chapterIdx}章`,
  wordCount,
  maxOffset: wordCount * 1.5 + 1000,
  maxPages: Math.floor((wordCount * 1.5 + 1000) / 800),
});

const trackers: ProgressTracker[] = [];
const createTracker = (chapterIdx: number, progress: number, token: string | null = 'book-token') => {
  const tracker = new ProgressTracker(createPluginAPI(new WeReadPlugin().manifest).reader!);
  trackers.push(tracker);
  return Object.assign(tracker as any, {
    currentBookToken: token,
    currentBookId: '822995',
    currentChapterIdx: chapterIdx,
    currentProgress: progress,
  }) as ProgressTracker;
};

describe('ProgressTracker.getBookPercent 全书大概比例（字数加权）', () => {
  beforeEach(() => {
    EventBus.clearHistory();
    chapterManager.getBookId = () => 'book-token';
    chapterManager.getChapters = () => [chapter(0, 1000), chapter(1, 2000), chapter(2, 1000)];
  });

  afterEach(() => {
    for (const tracker of trackers.splice(0)) tracker.destroy();
    chapterManager.getChapters = original.getChapters;
    chapterManager.getBookId = original.getBookId;
    EventBus.clearHistory();
  });

  it('当前章中点：前面字数全计 + 当前章字数×章内%', () => {
    const tracker = createTracker(1, 50);
    // (1000 + 2000×0.5) / 4000 = 50%
    expect(tracker.getBookPercent()).toBe(50);
  });

  it('书首为 0，书末为 100', () => {
    expect(createTracker(0, 0).getBookPercent()).toBe(0);
    expect(createTracker(2, 100).getBookPercent()).toBe(100);
  });

  it('章内进度超界夹取到 0..100 再参与计算', () => {
    // currentProgress=150 → 夹取 100：(1000+2000)/4000=75%
    expect(createTracker(1, 150).getBookPercent()).toBe(75);
    // currentProgress=-20 → 夹取 0：1000/4000=25%
    expect(createTracker(1, -20).getBookPercent()).toBe(25);
  });

  it('全书字数缺失时降级为章节序号比例', () => {
    chapterManager.getChapters = () => [chapter(0, 0), chapter(1, 0), chapter(2, 0)];
    // 第 2 章（position=1）/共 3 章 → round(2/3×100)=67
    expect(createTracker(1, 50).getBookPercent()).toBe(67);
  });

  it('未初始化、无章节数据或章节找不到时返回 null', () => {
    expect(createTracker(1, 50, null).getBookPercent()).toBeNull();
    chapterManager.getChapters = () => [];
    expect(createTracker(1, 50).getBookPercent()).toBeNull();
    chapterManager.getChapters = () => [chapter(0, 1000)];
    expect(createTracker(99, 50).getBookPercent()).toBeNull();
  });

  it('getBookPercent 是只读派生，不修改章内进度状态', () => {
    const tracker = createTracker(1, 50);
    tracker.getBookPercent();
    expect((tracker as any).currentProgress).toBe(50);
    expect((tracker as any).currentChapterIdx).toBe(1);
  });
});