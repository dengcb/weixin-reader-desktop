
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
  private timerStarted = false; // 跟踪定时器是否已启动
  private enabled = false; // 功能开关，默认关闭

  // Store bound handlers for cleanup
  private onMouseMove: ((e: MouseEvent) => void) | null = null;
  private onMouseDown: ((e: MouseEvent) => void) | null = null;

  constructor(siteContext: SiteContext) {
    this.siteContext = siteContext;
  }

  /**
   * 设置启用状态
   */
  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      if (!this.onMouseMove) {
        this.init();
      }
      // 立即启动定时器
      this.resetTimer();
    } else {
      this.showCursor();
      if (this.mouseHideTimer) {
        window.clearTimeout(this.mouseHideTimer);
        this.mouseHideTimer = null;
      }
    }
    log.debug(`[CursorHider] 隐藏光标功能: ${enabled ? '启用' : '禁用'}`);
  }

  /**
   * 切换启用状态
   */
  public toggle() {
    this.setEnabled(!this.enabled);
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

      // 3. Only start timer if enabled and in Reader Mode
      if (this.enabled && this.siteContext.isReaderPage) {
        this.mouseHideTimer = window.setTimeout(() => {
          this.hideCursor();
        }, 3000);
        this.timerStarted = true;
      }
    };

    // 保存为实例方法供 setEnabled 调用
    (this as any).resetTimer = resetTimer;

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
            // 首次移动鼠标时才启动定时器
            if (!this.timerStarted) {
              this.timerStarted = true;
            }
            resetTimer();
        }
    };

    this.onMouseDown = resetTimer;

    document.addEventListener('mousemove', this.onMouseMove, false);
    document.addEventListener('mousedown', this.onMouseDown, false);
    // 不再在初始化时立即调用 resetTimer()
    // 只有在用户移动鼠标后才开始 3 秒倒计时
  }

  private resetTimer() {
    // 由 init() 中的 resetTimer 引用调用
    if (!this.enabled) return;

    if (this.isMouseHidden) {
      this.showCursor();
    }

    if (this.mouseHideTimer) {
      window.clearTimeout(this.mouseHideTimer);
      this.mouseHideTimer = null;
    }

    if (this.siteContext.isReaderPage) {
      this.mouseHideTimer = window.setTimeout(() => {
        this.hideCursor();
      }, 3000);
      this.timerStarted = true;
    }
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
    document.documentElement.classList.remove('wxrd-hide-cursor');
    removeCSS('wxrd-cursor-hide');
    this.isMouseHidden = false;
  }

  public destroy() {
    this.showCursor();
    this.enabled = false;
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
