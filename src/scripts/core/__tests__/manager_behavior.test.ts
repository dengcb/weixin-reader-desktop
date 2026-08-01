import { afterEach, describe, expect, it, mock } from 'bun:test';
import { EventBus, Events } from '../event_bus';
import type { SiteContext } from '../site_context';
import type { MergedSettings } from '../settings_store';
import {
  determineScrollRestoreStep,
  SCROLL_RESTORE_POLICY,
} from '../../managers/app_manager';
import { ThemeManager } from '../../managers/theme_manager';
import { AUTO_FLIP_POLICY, AutoFlipper } from '../../managers/turner/auto_flipper';
import { CURSOR_POLICY, CursorHider } from '../../managers/turner/cursor_hider';
import { SWIPE_POLICY, SwipeHandler } from '../../managers/turner/swipe_handler';

const readerContext = (nextPage = mock(() => undefined), prevPage = mock(() => undefined)) => ({
  isReaderPage: true,
  isDoubleColumn: true,
  currentRuntime: {
    nextPage,
    prevPage,
  },
}) as unknown as SiteContext;

afterEach(() => {
  document.documentElement.classList.remove('wxrd-hide-cursor');
  document.getElementById('wxrd-cursor-hide')?.remove();
  document.getElementById('wxrd-dark-mode-filter')?.remove();
  EventBus.clearHistory();
});

describe('manager behavior regression guards', () => {
  it('locks the established restoration, swipe, cursor, and auto-flip timing policies', () => {
    expect(SCROLL_RESTORE_POLICY).toEqual({
      maxStalledAttempts: 50,
      retryDelayMs: 100,
      initialDelayMs: 500,
    });
    expect(SWIPE_POLICY).toEqual({
      threshold: 50,
      resetDelayMs: 250,
      cooldownMs: 800,
    });
    expect(CURSOR_POLICY).toEqual({
      hideDelayMs: 3000,
      defaultScrollLockMs: 200,
    });
    expect(AUTO_FLIP_POLICY).toEqual({
      doubleColumnTickMs: 1000,
      restorationRetryMs: 200,
      bottomResumeMs: 10000,
    });
  });

  it('turns exactly one page after the established accumulated horizontal-wheel threshold', () => {
    const nextPage = mock(() => undefined);
    const prevPage = mock(() => undefined);
    const lock = mock(() => undefined);
    const forward = new SwipeHandler(readerContext(nextPage, prevPage), lock);

    window.dispatchEvent(new WheelEvent('wheel', { deltaX: 25, cancelable: true }));
    window.dispatchEvent(new WheelEvent('wheel', { deltaX: 25, cancelable: true }));

    expect(nextPage).toHaveBeenCalledTimes(1);
    expect(prevPage).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledTimes(2);
    forward.destroy();

    const backward = new SwipeHandler(readerContext(nextPage, prevPage), lock);
    window.dispatchEvent(new WheelEvent('wheel', { deltaX: -50, cancelable: true }));
    expect(prevPage).toHaveBeenCalledTimes(1);
    expect(nextPage).toHaveBeenCalledTimes(1);
    backward.destroy();
  });

  it('publishes the forward page-turn event when auto flip advances a page', async () => {
    const nextPage = mock(() => undefined);
    const lock = mock(() => undefined);
    const directions: string[] = [];
    const unsubscribe = EventBus.on<{ direction: string }>(
      Events.PAGE_TURN_DIRECTION,
      ({ direction }) => directions.push(direction),
    );
    const flipper = new AutoFlipper(readerContext(nextPage), lock);

    flipper.updateState({
      autoFlip: { active: true, interval: 1, keepAwake: true },
    } as MergedSettings);
    await Bun.sleep(AUTO_FLIP_POLICY.doubleColumnTickMs + 100);

    flipper.stopAll();
    unsubscribe();
    expect(nextPage).toHaveBeenCalledTimes(1);
    expect(directions).toEqual(['forward']);
  });

  it('restores, chases lazy content, and gives up at the established scroll boundaries', () => {
    expect(determineScrollRestoreStep(1000, 200, 800, 0)).toEqual({
      kind: 'restore',
      top: 800,
    });
    expect(determineScrollRestoreStep(999, 200, 800, 49)).toEqual({
      kind: 'chase',
      top: 999,
    });
    expect(determineScrollRestoreStep(999, 200, 800, 50)).toEqual({
      kind: 'give-up',
      top: 800,
    });
  });

  it('removes cursor state and injected style during destruction', () => {
    const hider = new CursorHider(readerContext());
    hider.hideCursor();

    expect(document.documentElement.classList.contains('wxrd-hide-cursor')).toBe(true);
    expect(document.getElementById('wxrd-cursor-hide')).not.toBeNull();

    hider.destroy();
    expect(document.documentElement.classList.contains('wxrd-hide-cursor')).toBe(false);
    expect(document.getElementById('wxrd-cursor-hide')).toBeNull();
  });

  it('restores the native link/theme hooks during destruction', () => {
    const originalOpen = window.open;
    const originalMatchMedia = window.matchMedia;
    const addEventListener = mock(() => undefined);
    const removeEventListener = mock(() => undefined);
    window.matchMedia = (() => ({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })) as typeof window.matchMedia;
    const manager = new ThemeManager();

    expect(window.open).not.toBe(originalOpen);
    expect(document.getElementById('wxrd-dark-mode-filter')?.textContent).toContain('invert(1)');
    manager.destroy();

    expect(window.open).toBe(originalOpen);
    expect(document.getElementById('wxrd-dark-mode-filter')).toBeNull();
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    window.matchMedia = originalMatchMedia;
  });
});
