import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { ProgressTracker } from '../../adapters/progress_tracker';
import { chapterManager, type ChapterData } from '../chapter_manager';
import { EventBus, Events } from '../event_bus';
import { getChapterUrl } from '../../utils/chapter';

const original = {
  fetch: globalThis.fetch,
  dateNow: Date.now,
  initialize: chapterManager.initialize,
  getBookId: chapterManager.getBookId,
  getChapters: chapterManager.getChapters,
  readNumericBookId: chapterManager.readNumericBookId,
  isLoggedIn: chapterManager.isLoggedIn,
  scaleAllMaxPages: chapterManager.scaleAllMaxPages,
};

const chapter = (
  chapterIdx: number,
  maxPages: number,
  maxOffset = maxPages * 100,
  title = `第${chapterIdx}章`,
): ChapterData => ({
  chapterUid: 10_000 + chapterIdx,
  chapterIdx,
  title,
  wordCount: 1_000,
  maxOffset,
  maxPages,
});

const trackers: ProgressTracker[] = [];
const createTracker = () => {
  history.replaceState({}, '', '/');
  const tracker = new ProgressTracker();
  trackers.push(tracker);
  return Object.assign(tracker as any, {
    currentBookToken: 'book-token',
    currentBookId: '822995',
  });
};

describe('ProgressTracker established WeRead progress algorithm', () => {
  beforeEach(() => {
    EventBus.clearHistory();
    chapterManager.reset();
    chapterManager.initialize = mock(async () => true);
    chapterManager.getBookId = () => 'book-token';
    chapterManager.getChapters = () => [];
    chapterManager.readNumericBookId = () => '822995';
    chapterManager.isLoggedIn = () => true;
    chapterManager.scaleAllMaxPages = mock(() => 0);
    Date.now = original.dateNow;
    delete (window as any).bookId;
    document.title = '';
    document.querySelectorAll('script[type="application/ld+json"]').forEach(node => node.remove());
  });

  afterEach(() => {
    for (const tracker of trackers.splice(0)) tracker.destroy();
    globalThis.fetch = original.fetch;
    Date.now = original.dateNow;
    chapterManager.initialize = original.initialize;
    chapterManager.getBookId = original.getBookId;
    chapterManager.getChapters = original.getChapters;
    chapterManager.readNumericBookId = original.readNumericBookId;
    chapterManager.isLoggedIn = original.isLoggedIn;
    chapterManager.scaleAllMaxPages = original.scaleAllMaxPages;
    chapterManager.reset();
    EventBus.clearHistory();
    delete (window as any).bookId;
    document.title = '';
    document.querySelectorAll('script[type="application/ld+json"]').forEach(node => node.remove());
    history.replaceState({}, '', '/');
  });

  it('initializes from chapter metadata and the official progress response for this entry', async () => {
    const tracker = createTracker();
    const chapters = [chapter(4, 10, 1_000)];
    chapterManager.getChapters = () => chapters;
    const initialize = mock(async () => true);
    chapterManager.initialize = initialize;
    const fetchMock = mock(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      book: { chapterIdx: 4, chapterOffset: 456 },
    }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    history.replaceState({}, '', '/web/reader/a57325c05c8ed3a57224187kchapter');

    await tracker.onEnterReaderPage('a57325c05c8ed3a57224187');

    expect(initialize).toHaveBeenCalledWith('a57325c05c8ed3a57224187');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/web/book/getProgress?bookId=822995');
    expect(tracker.currentBookId).toBe('822995');
    expect(tracker.currentChapterIdx).toBe(4);
    expect(tracker.currentProgress).toBe(45);
    expect(tracker.turningPages).toBe(4);
    expect(EventBus.getLatestEvent<{ progress: number }>(Events.PROGRESS_UPDATED)).toEqual({ progress: 45 });
  });

  it('locks the official initialization response to the empirical page-estimation formulas end to end', async () => {
    const tracker = createTracker();
    chapterManager.initialize = original.initialize;
    chapterManager.getChapters = original.getChapters;
    chapterManager.readNumericBookId = original.readNumericBookId;
    chapterManager.isLoggedIn = original.isLoggedIn;
    chapterManager.scaleAllMaxPages = original.scaleAllMaxPages;
    document.body.innerHTML = `
      <div class="readerTopBar_avatar"></div>
      <script type="application/ld+json">${JSON.stringify({ '@Id': '123456' })}</script>
    `;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/chapterInfos')) {
        return new Response(JSON.stringify({
          errCode: 0,
          data: [{ updated: [{
            chapterUid: 11,
            chapterIdx: 1,
            title: '第一章',
            wordCount: 1_000,
          }] }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        errCode: 0,
        book: { chapterIdx: 1, chapterOffset: 1_250 },
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    history.replaceState({}, '', '/web/reader/a57325c05c8ed3a57224187');

    await tracker.onEnterReaderPage('a57325c05c8ed3a57224187');

    expect(chapterManager.getChapterByIdx(1)).toMatchObject({
      maxOffset: 2_500,
      maxPages: 3,
    });
    expect(tracker.currentProgress).toBe(50);
    expect(tracker.turningPages).toBe(1);
    expect(EventBus.getLatestEvent<{ progress: number }>(Events.PROGRESS_UPDATED)).toEqual({ progress: 50 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetches official progress again after leaving and re-entering the same book', async () => {
    const tracker = createTracker();
    const chapters = [chapter(4, 10, 1_000)];
    chapterManager.getChapters = () => chapters;
    const initialize = mock(async () => true);
    chapterManager.initialize = initialize;
    const fetchMock = mock(async () => new Response(JSON.stringify({
      book: { chapterIdx: 4, chapterOffset: 500 },
    }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await tracker.onEnterReaderPage('a57325c05c8ed3a57224187');
    tracker.leaveReaderPage();
    await tracker.onEnterReaderPage('a57325c05c8ed3a57224187');

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tracker.currentBookToken).toBe('a57325c05c8ed3a57224187');
    expect(tracker.currentProgress).toBe(50);
  });

  it('deduplicates simultaneous startup notifications for the same book', async () => {
    const tracker = createTracker();
    const chapters = [chapter(1, 10, 1_000)];
    chapterManager.getChapters = () => chapters;
    let finishInitialization!: (success: boolean) => void;
    const initialize = mock(() => new Promise<boolean>((resolve) => {
      finishInitialization = resolve;
    }));
    chapterManager.initialize = initialize;
    const fetchMock = mock(async () => new Response(JSON.stringify({
      book: { chapterIdx: 1, chapterOffset: 250 },
    }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = tracker.onEnterReaderPage('a57325c05c8ed3a57224187');
    const duplicate = tracker.onEnterReaderPage('a57325c05c8ed3a57224187');
    finishInitialization(true);
    await Promise.all([first, duplicate]);

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tracker.currentProgress).toBe(25);
  });

  it('retries initialization when page metadata was not ready, then keeps the official progress', async () => {
    const tracker = createTracker();
    const token = 'a57325c05c8ed3a57224187';
    history.replaceState({}, '', `/web/reader/${token}`);
    chapterManager.getChapters = () => [chapter(3, 10, 1_000)];
    const initialize = mock()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    chapterManager.initialize = initialize;
    const fetchMock = mock(async () => new Response(JSON.stringify({
      book: { chapterIdx: 3, chapterOffset: 700 },
    }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await tracker.onEnterReaderPage(token);
    expect(tracker.initializationRetryTimer).not.toBeNull();
    await Bun.sleep(530);

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tracker.initializationRetryTimer).toBeNull();
    expect(tracker.currentBookToken).toBe(token);
    expect(tracker.currentProgress).toBe(70);
    expect(tracker.turningPages).toBe(7);
  });

  it('does not let a late progress response from the previous book overwrite the new book', async () => {
    const tracker = createTracker();
    const firstChapters = [chapter(1, 10, 1_000)];
    const secondChapters = [chapter(2, 20, 2_000)];
    let activeChapters = firstChapters;
    let numericBookId = '111';
    chapterManager.initialize = mock(async () => true);
    chapterManager.getChapters = () => activeChapters;
    chapterManager.readNumericBookId = () => numericBookId;

    let resolveFirstProgress!: (response: Response) => void;
    const fetchMock = mock((input: RequestInfo | URL) => {
      if (String(input).includes('bookId=111')) {
        return new Promise<Response>((resolve) => {
          resolveFirstProgress = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({
        book: { chapterIdx: 2, chapterOffset: 1_000 },
      }), { status: 200 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = tracker.onEnterReaderPage('a1111111111111111111111');
    await Bun.sleep(0);
    activeChapters = secondChapters;
    numericBookId = '222';
    await tracker.onEnterReaderPage('b2222222222222222222222');
    resolveFirstProgress(new Response(JSON.stringify({
      book: { chapterIdx: 1, chapterOffset: 900 },
    }), { status: 200 }));
    await first;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tracker.currentBookToken).toBe('b2222222222222222222222');
    expect(tracker.currentBookId).toBe('222');
    expect(tracker.currentChapterIdx).toBe(2);
    expect(tracker.currentProgress).toBe(50);
    expect(tracker.turningPages).toBe(10);
  });

  it('treats a reader URL for another book as a full initialization, not a chapter correction', async () => {
    const tracker = createTracker();
    chapterManager.getChapters = () => [chapter(2, 20, 2_000)];
    chapterManager.readNumericBookId = () => '222';
    const initialize = mock(async () => true);
    chapterManager.initialize = initialize;
    const fetchMock = mock(async () => new Response(JSON.stringify({
      book: { chapterIdx: 2, chapterOffset: 1_000 },
    }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    Object.assign(tracker, {
      currentBookToken: 'a1111111111111111111111',
      currentBookId: '111',
      currentChapterIdx: 1,
    });
    const chapterChange = mock(async () => undefined);
    tracker.onChapterChange = chapterChange;

    EventBus.emit(Events.CHAPTER_CHANGED, {
      url: 'https://weread.qq.com/web/reader/b2222222222222222222222',
      pathname: '/web/reader/b2222222222222222222222',
    });
    await Bun.sleep(10);

    expect(initialize).toHaveBeenCalledWith('b2222222222222222222222');
    expect(chapterChange).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tracker.currentBookId).toBe('222');
    expect(tracker.currentProgress).toBe(50);
  });

  it('coalesces repeated direction signals for 500ms and lets the final direction win', async () => {
    const tracker = createTracker();
    chapterManager.getChapters = () => [chapter(2, 10)];
    Object.assign(tracker, {
      currentBookId: '822995',
      currentChapterIdx: 2,
      turningPages: 3,
    });

    tracker.recordPageDirection(1);
    tracker.recordPageDirection(1);
    await Bun.sleep(530);
    expect(tracker.turningPages).toBe(4);
    expect(tracker.currentProgress).toBe(40);
    expect(tracker.lastPageDirection).toBe(1);

    tracker.recordPageDirection(1);
    tracker.recordPageDirection(-1);
    await Bun.sleep(530);
    expect(tracker.turningPages).toBe(3);
    expect(tracker.currentProgress).toBe(30);
    expect(tracker.lastPageDirection).toBe(-1);
  });

  it('keeps overflow progress because it is correction input rather than display noise', () => {
    const tracker = createTracker();
    chapterManager.getChapters = () => [chapter(2, 10)];
    Object.assign(tracker, { currentChapterIdx: 2, turningPages: 13 });

    tracker.updateProgressFromTurningPages();
    expect(tracker.currentProgress).toBe(130);

    tracker.turningPages = -2;
    tracker.updateProgressFromTurningPages();
    expect(tracker.currentProgress).toBe(-20);
  });

  it('scales all cached chapters only when a sufficiently long chapter differs by over 20 percent', async () => {
    const tracker = createTracker();
    const chapters = [chapter(2, 10), chapter(3, 20)];
    chapterManager.getChapters = () => chapters;
    const scale = mock(() => chapters.length);
    chapterManager.scaleAllMaxPages = scale;

    tracker.turningPages = 15;
    tracker.applyCorrectionAlgorithm(2, true);
    expect(scale).toHaveBeenCalledWith(1.5);

    scale.mockClear();
    tracker.turningPages = 12;
    tracker.applyCorrectionAlgorithm(2, true);
    expect(scale).not.toHaveBeenCalled();

    scale.mockClear();
    chapters[0].maxPages = 5;
    tracker.turningPages = 10;
    tracker.applyCorrectionAlgorithm(2, true);
    expect(scale).not.toHaveBeenCalled();
  });

  it('derives backward actual pages from estimated pages minus the signed page counter', async () => {
    const tracker = createTracker();
    chapterManager.getChapters = () => [chapter(2, 10), chapter(3, 20)];
    const scale = mock(() => 2);
    chapterManager.scaleAllMaxPages = scale;
    tracker.turningPages = -5;

    tracker.applyCorrectionAlgorithm(2, false);

    expect(scale).toHaveBeenCalledWith(1.5);
  });

  it('resets the counter at the correct edge after adjacent forward and backward chapter changes', async () => {
    const tracker = createTracker();
    const chapters = [chapter(1, 8), chapter(2, 10), chapter(3, 12)];
    chapterManager.getChapters = () => chapters;
    const correct = mock(async () => undefined);
    tracker.applyCorrectionAlgorithm = correct;
    Object.assign(tracker, {
      currentBookId: '822995',
      currentChapterIdx: 2,
      turningPages: 9,
      lastPageDirection: 1,
      pendingDirection: 1,
      lastDirectionTime: Date.now(),
      pageDirectionTimer: setTimeout(() => undefined, 10_000),
    });

    await tracker.onChapterChange('/forward');
    expect(correct).toHaveBeenCalledWith(2, true);
    expect(tracker.currentChapterIdx).toBe(3);
    expect(tracker.turningPages).toBe(0);
    expect(tracker.currentProgress).toBe(0);
    expect(tracker.lastPageDirection).toBeNull();
    expect(tracker.pageDirectionTimer).toBeNull();

    Object.assign(tracker, {
      currentChapterIdx: 2,
      turningPages: 1,
      lastPageDirection: -1,
      pendingDirection: -1,
      lastDirectionTime: Date.now(),
    });
    await tracker.onChapterChange('/backward');
    expect(correct).toHaveBeenLastCalledWith(2, false);
    expect(tracker.currentChapterIdx).toBe(1);
    expect(tracker.turningPages).toBe(8);
    expect(tracker.currentProgress).toBe(100);
  });

  it('uses cached chapter IDs to confirm that a settled direction reached its adjacent chapter', async () => {
    const tracker = createTracker();
    const chapters = [chapter(1, 8), chapter(2, 10), chapter(3, 12)];
    chapterManager.getChapters = () => chapters;
    const correct = mock(async () => undefined);
    tracker.applyCorrectionAlgorithm = correct;
    Object.assign(tracker, {
      currentBookId: '822995',
      currentChapterIdx: 2,
      turningPages: 9,
      lastPageDirection: 1,
      lastDirectionTime: Date.now(),
    });
    const newUrl = `https://weread.qq.com/web/reader/book-token${getChapterUrl(chapters[2].chapterUid)}`;

    await tracker.onChapterChange(newUrl);

    expect(correct).toHaveBeenCalledWith(2, true);
    expect(tracker.currentChapterIdx).toBe(3);
    expect(tracker.turningPages).toBe(0);
    expect(tracker.currentProgress).toBe(0);
  });

  it('recognizes a non-adjacent cached chapter ID as a directory jump without calibrating', async () => {
    const tracker = createTracker();
    const chapters = [chapter(1, 8), chapter(2, 10), chapter(7, 12)];
    chapterManager.getChapters = () => chapters;
    const correct = mock(async () => undefined);
    const titleFallback = mock(async () => undefined);
    tracker.applyCorrectionAlgorithm = correct;
    tracker.reinitializeAfterJump = titleFallback;
    Object.assign(tracker, {
      currentBookId: '822995',
      currentChapterIdx: 2,
      turningPages: 9,
      lastPageDirection: 1,
      pendingDirection: 1,
      lastDirectionTime: Date.now(),
      pageDirectionTimer: setTimeout(() => undefined, 10_000),
    });
    const newUrl = `https://weread.qq.com/web/reader/book-token${getChapterUrl(chapters[2].chapterUid)}`;

    await tracker.onChapterChange(newUrl);

    expect(correct).not.toHaveBeenCalled();
    expect(titleFallback).not.toHaveBeenCalled();
    expect(tracker.currentChapterIdx).toBe(7);
    expect(tracker.turningPages).toBe(0);
    expect(tracker.currentProgress).toBe(0);
    expect(tracker.lastPageDirection).toBeNull();
    expect(tracker.pageDirectionTimer).toBeNull();
  });

  it('falls back to title matching when the direction is missing or older than ten seconds', async () => {
    const tracker = createTracker();
    chapterManager.getChapters = () => [
      chapter(1, 8, 800, '序章'),
      chapter(7, 12, 1_200, '雨夜来客'),
    ];
    const jump = mock(async () => undefined);
    tracker.reinitializeAfterJump = jump;
    tracker.lastPageDirection = 1;
    tracker.lastDirectionTime = Date.now() - 10_001;

    await tracker.onChapterChange('/catalog-jump');
    expect(jump).toHaveBeenCalledTimes(1);

    tracker.reinitializeAfterJump = ProgressTracker.prototype['reinitializeAfterJump'];
    tracker.waitForTitleUpdate = mock(async () => undefined);
    document.title = '测试书名 - 雨夜来客 - 作者 - 微信读书';
    await tracker.reinitializeAfterJump();
    expect(tracker.currentChapterIdx).toBe(7);
    expect(tracker.turningPages).toBe(0);
    expect(tracker.currentProgress).toBe(0);
  });

  it('suppresses lower-priority work only inside the 100ms arbitration window', () => {
    const tracker = createTracker();
    let now = 1_000;
    Date.now = () => now;

    expect(tracker.shouldExecuteEvent(3)).toBe(true);
    now = 1_050;
    expect(tracker.shouldExecuteEvent(1)).toBe(false);
    expect(tracker.shouldExecuteEvent(3)).toBe(true);
    now = 1_200;
    expect(tracker.shouldExecuteEvent(1)).toBe(true);
  });

  it('extracts a stable book token and removes the chapter suffix from reader URLs', () => {
    const tracker = createTracker();

    expect(tracker.extractBookTokenFromUrl(
      'https://weread.qq.com/web/reader/a57325c05c8ed3a57224187kchapter',
    )).toBe('a57325c05c8ed3a57224187');
    expect(tracker.extractBookTokenFromUrl('https://weread.qq.com/web/reader/a57325c05c8ed3a57224187')).toBe(
      'a57325c05c8ed3a57224187',
    );
    expect(tracker.extractBookTokenFromUrl('https://weread.qq.com/web/shelf')).toBeNull();
  });

  it('cancels pending direction work and DOM/EventBus listeners on destroy', async () => {
    const tracker = createTracker();
    chapterManager.getChapters = () => [chapter(2, 10)];
    const token = 'a57325c05c8ed3a57224187';
    history.replaceState({}, '', `/web/reader/${token}`);
    const initialize = mock(async () => false);
    chapterManager.initialize = initialize;
    Object.assign(tracker, { currentChapterIdx: 2, turningPages: 3 });
    await tracker.onEnterReaderPage(token);
    expect(tracker.initializationRetryTimer).not.toBeNull();
    tracker.recordPageDirection(1);
    document.title = 'title still loading';
    const titleWait = tracker.waitForTitleUpdate();
    expect(tracker.titleWaitTimer).not.toBeNull();

    tracker.destroy();
    trackers.splice(trackers.indexOf(tracker), 1);
    await titleWait;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    EventBus.emit(Events.PAGE_TURN_DIRECTION, { direction: 'forward' });
    await Bun.sleep(530);

    expect(tracker.pageDirectionTimer).toBeNull();
    expect(tracker.initializationRetryTimer).toBeNull();
    expect(tracker.titleWaitTimer).toBeNull();
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(tracker.turningPages).toBe(3);
  });
});
