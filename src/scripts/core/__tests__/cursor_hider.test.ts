import { afterEach, describe, expect, it } from 'bun:test';
import type { SiteContext } from '../site_context';
import { CursorHider } from '../../managers/turner/cursor_hider';

const context = (isReaderPage = true) => ({ isReaderPage }) as SiteContext;

afterEach(() => {
  document.documentElement.classList.remove('wxrd-hide-cursor');
  document.getElementById('wxrd-cursor-hide')?.remove();
});

describe('CursorHider state and cleanup', () => {
  it('starts one hide timer only on reader pages and clears it when disabled', () => {
    const hider = new CursorHider(context(true));
    hider.setEnabled(true);
    const timer = (hider as any).mouseHideTimer;
    expect(timer).not.toBeNull();

    hider.setEnabled(true);
    expect((hider as any).mouseHideTimer).not.toBe(timer);
    hider.setEnabled(false);
    expect((hider as any).mouseHideTimer).toBeNull();
    expect((hider as any).enabled).toBe(false);
    hider.destroy();
  });

  it('does not hide outside a reader and toggle remains inert after destruction', () => {
    const hider = new CursorHider(context(false));
    hider.setEnabled(true);
    hider.hideCursor();
    expect((hider as any).mouseHideTimer).toBeNull();
    expect(document.documentElement.classList.contains('wxrd-hide-cursor')).toBe(false);

    hider.destroy();
    hider.toggle();
    hider.hideCursor();
    expect((hider as any).enabled).toBe(false);
    expect(document.getElementById('wxrd-cursor-hide')).toBeNull();
  });

  it('replaces scroll locks and releases the lock timer during destruction', () => {
    const hider = new CursorHider(context(true));
    hider.setScrollLock(10_000);
    const first = (hider as any).scrollLockTimer;
    hider.setScrollLock(10_000);
    expect((hider as any).isScrollingOrSwiping).toBe(true);
    expect((hider as any).scrollLockTimer).not.toBe(first);

    hider.destroy();
    expect((hider as any).scrollLockTimer).toBeNull();
  });

  it('removes mouse listeners so later movement cannot restart work', () => {
    const hider = new CursorHider(context(true));
    hider.setEnabled(true);
    hider.destroy();

    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 100, screenY: 100 }));
    document.dispatchEvent(new MouseEvent('mousedown'));
    expect((hider as any).mouseHideTimer).toBeNull();
    expect((hider as any).onMouseMove).toBeNull();
    expect((hider as any).onMouseDown).toBeNull();
  });
});
