import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventBus, Events } from '../event_bus';
import { ScrollState } from '../scroll_state';
import type { SiteContext } from '../site_context';
import type { MergedSettings } from '../settings_store';
import type { ReaderSiteRuntime } from '../reader_site_runtime';
import { AutoFlipper } from '../../managers/turner/auto_flipper';

const originalTauri = window.__TAURI__;
const originalScrollBy = window.scrollBy;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
let invokeMock = mock(async (_command: string) => undefined as unknown);

const runtime = (overrides: Partial<ReaderSiteRuntime> = {}) => ({
  nextPage: mock(() => undefined),
  prevPage: mock(() => undefined),
  ...overrides,
}) as unknown as ReaderSiteRuntime;

const context = (siteRuntime: ReaderSiteRuntime | null, doubleColumn = false) => ({
  currentRuntime: siteRuntime,
  isDoubleColumn: doubleColumn,
}) as unknown as SiteContext;

describe('AutoFlipper lifecycle and single-column loop', () => {
  beforeEach(() => {
    EventBus.clearHistory();
    delete (window as any).__wxrd_scroll_restored;
    invokeMock = mock(async command => command === 'get_app_name' ? '测试阅读器' : undefined);
    window.__TAURI__ = {
      core: { invoke: invokeMock as any },
      event: { listen: mock(async () => () => undefined) },
    };
  });

  afterEach(() => {
    EventBus.clearHistory();
    delete (window as any).__wxrd_scroll_restored;
    window.__TAURI__ = originalTauri;
    window.scrollBy = originalScrollBy;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    delete (document as any).hidden;
  });

  it('normalizes settings, starts only on meaningful changes, and stops idempotently', () => {
    const flipper = new AutoFlipper(context(null), mock(() => undefined));

    flipper.updateState({ autoFlip: { active: true, interval: 0, keepAwake: false } } as MergedSettings);
    expect((flipper as any).isActive).toBe(true);
    expect((flipper as any).intervalSeconds).toBe(15);
    expect((flipper as any).keepAwake).toBe(false);

    flipper.updateState({ autoFlip: { active: false, interval: 15, keepAwake: false } } as MergedSettings);
    flipper.stopAll();
    expect((flipper as any).isActive).toBe(false);
    expect((flipper as any).doubleTimer).toBeNull();
    expect((flipper as any).singleRafId).toBeNull();
  });

  it('waits for restoration in single-column mode and cancels the retry on stop', () => {
    const siteRuntime = runtime();
    const flipper = new AutoFlipper(context(siteRuntime), mock(() => undefined));

    flipper.updateState({ autoFlip: { active: true, interval: 5, keepAwake: true } } as MergedSettings);
    expect((flipper as any).restorationRetryTimer).not.toBeNull();
    expect((flipper as any).singleRafId).toBeNull();

    flipper.stopAll();
    expect((flipper as any).restorationRetryTimer).toBeNull();
  });

  it('turns the page and chapter once at the bottom, then releases all delayed work', () => {
    const nextPage = mock(() => undefined);
    const nextChapter = mock(() => undefined);
    const siteRuntime = runtime({
      nextPage,
      clickNextChapter: nextChapter,
      isAtBottom: () => true,
    });
    const lock = mock(() => undefined);
    const flipper = new AutoFlipper(context(siteRuntime), lock);
    const scrollBy = mock((_x: number, _y: number) => undefined);
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    globalThis.cancelAnimationFrame = mock(() => undefined);
    const directions: string[] = [];
    const cancel = EventBus.on<{ direction: string }>(
      Events.PAGE_TURN_DIRECTION,
      event => directions.push(event.direction),
    );
    Object.assign(flipper as any, {
      isActive: true,
      generation: 3,
      intervalSeconds: 5,
      lastFrameTime: 0,
      lastScrollTime: 0,
      accumulatedMove: 1,
      singleRafId: 7,
    });

    (flipper as any).singleColumnLoop(31, siteRuntime, 3);

    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy.mock.calls[0]?.[0]).toBe(0);
    expect(scrollBy.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(nextPage).toHaveBeenCalledTimes(1);
    expect(nextChapter).toHaveBeenCalledTimes(1);
    expect(directions).toEqual(['forward']);
    expect((flipper as any).bottomResumeTimer).not.toBeNull();
    flipper.stopAll();
    expect((flipper as any).bottomResumeTimer).toBeNull();
    cancel();
  });

  it('pauses background RAF work and resumes only after visibility returns', () => {
    ScrollState.markRestorationComplete();
    const siteRuntime = runtime({ isAtBottom: () => false });
    const siteContext = context(siteRuntime);
    const flipper = new AutoFlipper(siteContext, mock(() => undefined));
    const request = mock(() => 41);
    const cancel = mock(() => undefined);
    globalThis.requestAnimationFrame = request;
    globalThis.cancelAnimationFrame = cancel;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.assign(flipper as any, {
      isActive: true,
      keepAwake: false,
      generation: 0,
      lastFrameTime: 0,
      lastScrollTime: 0,
      singleRafId: 9,
    });

    (flipper as any).singleColumnLoop(31, siteRuntime, 0);
    expect((flipper as any).singleRafId).toBeNull();
    expect((flipper as any).visibilityResumeHandler).not.toBeNull();

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect((flipper as any).visibilityResumeHandler).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    flipper.stopAll();
    expect(cancel).toHaveBeenCalledWith(41);
  });

  it('restores the native title and invalidates zombie callbacks during stop', async () => {
    const flipper = new AutoFlipper(context(runtime()), mock(() => undefined));
    Object.assign(flipper as any, { isActive: true, originalTitle: '章节标题', generation: 4 });

    flipper.stopAll();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith('set_title', { title: document.title });
    expect((flipper as any).originalTitle).toBeNull();
    expect((flipper as any).generation).toBe(5);
  });
});
