import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { CHAPTER_CACHE_LIMIT, chapterManager } from '../chapter_manager';

const originalFetch = globalThis.fetch;

const addLoggedInPageState = (numericId = '123456') => {
  document.body.innerHTML = `
    <div class="readerTopBar_avatar"></div>
    <script type="application/ld+json">${JSON.stringify({ '@Id': numericId })}</script>
  `;
};

const successfulResponse = () => ({
  ok: true,
  json: async () => ({
    errCode: 0,
    data: [{
      updated: [
        { chapterUid: 22, chapterIdx: 2, title: '第二章', wordCount: 2000 },
        { chapterUid: 11, chapterIdx: 1, title: '第一章', wordCount: 1000 },
      ],
    }],
  }),
}) as Response;

describe('ChapterManager', () => {
  beforeEach(() => {
    chapterManager.reset();
    document.body.innerHTML = '';
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    chapterManager.reset();
    document.body.innerHTML = '';
    globalThis.fetch = originalFetch;
  });

  it('detects login and parses the numeric ID from JSON-LD', () => {
    expect(chapterManager.isLoggedIn()).toBe(false);
    expect(chapterManager.readNumericBookId()).toBeNull();

    addLoggedInPageState('987654');
    expect(chapterManager.isLoggedIn()).toBe(true);
    expect(chapterManager.readNumericBookId()).toBe('987654');
  });

  it('ignores malformed JSON-LD without throwing', () => {
    document.body.innerHTML = `
      <div class="navBar_avatar"></div>
      <script type="application/ld+json">{not-json</script>
    `;
    expect(chapterManager.readNumericBookId()).toBeNull();
  });

  it('loads, normalizes and sorts chapters from the production API shape', async () => {
    addLoggedInPageState();
    const fetchMock = mock(async () => successfulResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(chapterManager.initialize('book-token')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toStartWith('https://weread.qq.com/web/book/chapterInfos?_');
    expect(request.method).toBe('POST');
    expect(JSON.parse(String(request.body))).toEqual({ bookIds: ['123456'] });

    expect(chapterManager.getBookId()).toBe('book-token');
    expect(chapterManager.getChapters().map(chapter => chapter.chapterIdx)).toEqual([1, 2]);
    expect(chapterManager.getChapterByIdx(1)).toMatchObject({
      title: '第一章',
      maxOffset: 2500,
      maxPages: 3,
    });
    expect(chapterManager.isInitialized()).toBe(true);
  });

  it('does not fetch the same successfully initialized book twice', async () => {
    addLoggedInPageState();
    const fetchMock = mock(async () => successfulResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await chapterManager.initialize('same-book')).toBe(true);
    expect(await chapterManager.initialize('same-book')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows the same book to retry when its numeric ID was not ready yet', async () => {
    document.body.innerHTML = '<div class="wr_avatar"></div>';
    const fetchMock = mock(async () => successfulResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await chapterManager.initialize('missing-id')).toBe(false);
    addLoggedInPageState();
    expect(await chapterManager.initialize('missing-id')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent initialization of the same book into one request', async () => {
    addLoggedInPageState();
    let resolveResponse!: (response: Response) => void;
    const fetchMock = mock(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = chapterManager.initialize('same-book');
    const second = chapterManager.initialize('same-book');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse(successfulResponse());
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(chapterManager.getBookId()).toBe('same-book');
  });

  it('keeps the latest book active when an older request finishes late', async () => {
    addLoggedInPageState('111');
    let resolveFirst!: (response: Response) => void;
    const fetchMock = mock(async (_input: RequestInfo | URL, request?: RequestInit) => {
      const numericId = JSON.parse(String(request?.body)).bookIds[0];
      if (numericId === '111') {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return successfulResponse();
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const older = chapterManager.initialize('older-book');
    addLoggedInPageState('222');
    expect(await chapterManager.initialize('latest-book')).toBe(true);
    expect(chapterManager.getBookId()).toBe('latest-book');

    resolveFirst(successfulResponse());
    expect(await older).toBe(false);
    expect(chapterManager.getBookId()).toBe('latest-book');

    // 过期请求的结果仅进入有界缓存，回访时不再请求。
    expect(await chapterManager.initialize('older-book')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retains calibrated pages when revisiting a cached book', async () => {
    addLoggedInPageState('111');
    const fetchMock = mock(async () => successfulResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await chapterManager.initialize('first-book')).toBe(true);
    const originalPages = chapterManager.getChapterByIdx(1)!.maxPages;
    chapterManager.scaleAllMaxPages(2);

    addLoggedInPageState('222');
    expect(await chapterManager.initialize('second-book')).toBe(true);
    expect(await chapterManager.initialize('first-book')).toBe(true);
    expect(chapterManager.getChapterByIdx(1)!.maxPages).toBe(originalPages * 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds the per-book chapter cache with LRU eviction', async () => {
    const fetchMock = mock(async () => successfulResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    for (let index = 0; index <= CHAPTER_CACHE_LIMIT; index++) {
      addLoggedInPageState(String(index + 1));
      expect(await chapterManager.initialize(`book-${index}`)).toBe(true);
    }

    const cache = (chapterManager as any).chapterCache as Map<string, unknown>;
    expect(cache.size).toBe(CHAPTER_CACHE_LIMIT);
    expect(cache.has('book-0')).toBe(false);
    expect(cache.has(`book-${CHAPTER_CACHE_LIMIT}`)).toBe(true);

    addLoggedInPageState('999');
    expect(await chapterManager.initialize('book-0')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(CHAPTER_CACHE_LIMIT + 2);
  });

  it('rejects unauthenticated, HTTP-error, API-error and empty responses', async () => {
    globalThis.fetch = mock(async () => successfulResponse()) as unknown as typeof fetch;
    expect(await chapterManager.initialize('logged-out')).toBe(false);

    addLoggedInPageState();
    globalThis.fetch = mock(async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch;
    expect(await chapterManager.initialize('http-error')).toBe(false);

    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ errCode: -2010 }),
    }) as Response) as unknown as typeof fetch;
    expect(await chapterManager.initialize('api-error')).toBe(false);

    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ errCode: 0, data: [{ updated: [] }] }),
    }) as Response) as unknown as typeof fetch;
    expect(await chapterManager.initialize('empty')).toBe(false);
  });

  it('handles network exceptions and remains resettable', async () => {
    addLoggedInPageState();
    globalThis.fetch = mock(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    expect(await chapterManager.initialize('offline-book')).toBe(false);
    expect(chapterManager.getBookId()).toBeNull();
    chapterManager.reset();
    expect(chapterManager.getBookId()).toBeNull();
    expect(chapterManager.getChapters()).toEqual([]);
    expect(chapterManager.isInitialized()).toBe(false);
  });

  it('aborts pending chapter requests during reset and ignores their late result', async () => {
    addLoggedInPageState();
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, request?: RequestInit) => {
      requestSignal = request?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;

    const pending = chapterManager.initialize('pending-book');
    chapterManager.reset();

    expect(requestSignal?.aborted).toBe(true);
    expect(await pending).toBe(false);
    expect(chapterManager.getBookId()).toBeNull();
    expect(chapterManager.getChapters()).toEqual([]);
    expect((chapterManager as any).inFlightLoads.size).toBe(0);
  });

  it('builds chapter URLs and scales only positive page counts', async () => {
    addLoggedInPageState();
    globalThis.fetch = mock(async () => successfulResponse()) as unknown as typeof fetch;
    await chapterManager.initialize('book-token');

    const segment = chapterManager.getChapterUrlSegment(1);
    expect(segment).toStartWith('k');
    expect(chapterManager.getChapterUrlSegment(999)).toBeNull();
    expect(chapterManager.buildChapterUrl(1)).toBe(
      `https://weread.qq.com/web/reader/book-token${segment}`,
    );
    expect(chapterManager.buildChapterUrl(999)).toBeNull();

    const originalPages = chapterManager.getChapterByIdx(1)!.maxPages;
    expect(chapterManager.scaleAllMaxPages(2)).toBe(2);
    expect(chapterManager.getChapterByIdx(1)!.maxPages).toBe(originalPages * 2);
    expect(chapterManager.scaleAllMaxPages(0)).toBe(0);
  });
});
