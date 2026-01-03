
import { invoke } from '../../core/tauri';
import { injectCSS, removeCSS } from '../../core/utils';
import { SiteContext } from '../../core/site_context';
import { log } from '../../core/logger';

export class CursorHider {
  private mouseHideTimer: number | null = null;
  private isMouseHidden = false;
  private isScrollingOrSwiping = false; // Lock to prevent mouse wake-up during scroll
  private scrollLockTimer: number | null = null;
  private lastScreenX = 0;
  private lastScreenY = 0;
  private siteContext: SiteContext;

  // Store bound handlers for cleanup
  private onMouseMove: ((e: MouseEvent) => void) | null = null;
  private onMouseDown: ((e: MouseEvent) => void) | null = null;

  constructor(siteContext: SiteContext) {
    this.siteContext = siteContext;
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
      if (this.siteContext.isReaderPage) {
        this.mouseHideTimer = window.setTimeout(() => {
          this.hideCursor();
        }, 3000);
      }
    };

    let lastMoveTime = 0;
    this.onMouseMove = (e: MouseEvent) => {
        // 1. Ignore if strictly locked (during swipe/scroll)
        if (this.isScrollingOrSwiping) return;

        // 2. Strict check using Screen Coordinates
        const diffX = Math.abs(e.screenX - this.lastScreenX);
        const diffY = Math.abs(e.screenY - this.lastScreenY);

        if (diffX < 15 && diffY < 15) {
            return;
        }

        this.lastScreenX = e.screenX;
        this.lastScreenY = e.screenY;

        const now = Date.now();
        if (now - lastMoveTime > 200) {
            lastMoveTime = now;
            resetTimer();
        }
    };

    this.onMouseDown = resetTimer;

    document.addEventListener('mousemove', this.onMouseMove, false);
    document.addEventListener('mousedown', this.onMouseDown, false);
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
    if (!this.siteContext.isReaderPage) return;

    log.debug('[CursorHider] Hiding cursor');
    invoke('set_cursor_visible', { visible: false }).catch(e => log.error(e));
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
    log.debug('[CursorHider] Showing cursor');
    invoke('set_cursor_visible', { visible: true }).catch(e => log.error(e));
    document.documentElement.classList.remove('wxrd-hide-cursor');
    removeCSS('wxrd-cursor-hide');
    this.isMouseHidden = false;
  }

  public destroy() {
    this.showCursor();
    if (this.mouseHideTimer) {
      window.clearTimeout(this.mouseHideTimer);
      this.mouseHideTimer = null;
    }
    if (this.scrollLockTimer) {
      window.clearTimeout(this.scrollLockTimer);
      this.scrollLockTimer = null;
    }

    if (this.onMouseMove) {
        document.removeEventListener('mousemove', this.onMouseMove, false);
    }
    if (this.onMouseDown) {
        document.removeEventListener('mousedown', this.onMouseDown, false);
    }
  }
}
