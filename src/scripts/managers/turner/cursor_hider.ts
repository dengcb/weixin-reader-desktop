
import { invoke } from '../../core/tauri';
import { injectCSS, removeCSS } from '../../core/utils';
import { getSiteRegistry } from '../../core/site_registry';

export class CursorHider {
  private mouseHideTimer: number | null = null;
  private isMouseHidden = false;
  private isScrollingOrSwiping = false; // Lock to prevent mouse wake-up during scroll
  private scrollLockTimer: number | null = null;
  private lastScreenX = 0;
  private lastScreenY = 0;
  private siteRegistry = getSiteRegistry();

  constructor() {
    this.init();
  }

  private init() {
    const resetTimer = () => {
      // 1. Show cursor immediately
      if (this.isMouseHidden) {
        this.showCursor();
      }

      // 2. Clear existing timer
      if (this.mouseHideTimer) {
        window.clearTimeout(this.mouseHideTimer);
        this.mouseHideTimer = null;
      }

      // 3. Only start timer if in Reader Mode
      if (this.siteRegistry.isReaderPage()) {
        this.mouseHideTimer = window.setTimeout(() => {
          this.hideCursor();
        }, 3000);
      }
    };

    let lastMoveTime = 0;
    document.addEventListener('mousemove', (e) => {
        // 1. Ignore if strictly locked (during swipe/scroll)
        if (this.isScrollingOrSwiping) return;

        // 2. Strict check using Screen Coordinates
        const diffX = Math.abs(e.screenX - this.lastScreenX);
        const diffY = Math.abs(e.screenY - this.lastScreenY);

        if (diffX < 50 && diffY < 50) {
            return;
        }

        this.lastScreenX = e.screenX;
        this.lastScreenY = e.screenY;

        console.log(`[CursorHider] Mouse wake-up triggered! diffX=${diffX}, diffY=${diffY}`);

        const now = Date.now();
        if (now - lastMoveTime > 200) {
            lastMoveTime = now;
            resetTimer();
        }
    }, false);

    document.addEventListener('mousedown', resetTimer, false);
    resetTimer();
  }

  public setScrollLock(duration = 200) {
    this.isScrollingOrSwiping = true;
    if (this.scrollLockTimer) {
        clearTimeout(this.scrollLockTimer);
    }
    this.scrollLockTimer = window.setTimeout(() => {
        this.isScrollingOrSwiping = false;
    }, duration);
  }

  public hideCursor() {
    if (this.isMouseHidden) return;
    if (!this.siteRegistry.isReaderPage()) return;

    console.log('[CursorHider] Hiding cursor');
    invoke('set_cursor_visible', { visible: false }).catch(e => console.error(e));
    document.documentElement.classList.add('wxrd-hide-cursor');
    injectCSS('wxrd-cursor-hide', `
      html.wxrd-hide-cursor,
      html.wxrd-hide-cursor * {
        cursor: none !important;
      }
    `);
    this.isMouseHidden = true;
  }

  public showCursor() {
    if (!this.isMouseHidden) return;
    console.log('[CursorHider] Showing cursor');
    invoke('set_cursor_visible', { visible: true }).catch(e => console.error(e));
    document.documentElement.classList.remove('wxrd-hide-cursor');
    removeCSS('wxrd-cursor-hide');
    this.isMouseHidden = false;
  }

  public reset() {
      this.showCursor();
      if (this.mouseHideTimer) {
          window.clearTimeout(this.mouseHideTimer);
          this.mouseHideTimer = null;
      }
  }
}
