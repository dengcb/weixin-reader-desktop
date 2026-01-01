
import { invoke } from '../../core/tauri';
import { AppSettings } from '../../core/settings_store';
import { getSiteRegistry } from '../../core/site_registry';
import { ScrollState } from '../../core/scroll_state';
import { ReadingSiteAdapter } from '../../adapters/reading_site_adapter';

export class AutoFlipper {
  private isActive = false;
  private intervalSeconds = 30;
  private keepAwake = false;
  private doubleTimer: ReturnType<typeof setInterval> | null = null;
  private singleRafId: number | null = null;
  private lastFrameTime = 0;
  private lastScrollTime = 0;
  private accumulatedMove = 0;
  private countdown = 30;
  private originalTitle: string | null = null;
  private appName: string = "微信阅读";
  private elapsedTime = 0;
  private siteRegistry = getSiteRegistry();
  private bottomTriggered = false;
  private onScrollLock: (duration?: number) => void;

  constructor(onScrollLock: (duration?: number) => void) {
    this.onScrollLock = onScrollLock;
    this.initAppName();
  }

  private async initAppName() {
    try {
      this.appName = await invoke<string>('get_app_name') || "微信阅读";
    } catch (e) {
      console.error("AutoFlipper: Failed to get app name", e);
    }
  }

  public updateState(settings: AppSettings) {
    const autoFlip = settings.autoFlip || { active: false, interval: 15, keepAwake: true };
    const newActive = !!autoFlip.active;
    const newInterval = autoFlip.interval > 0 ? autoFlip.interval : 15;
    const newKeepAwake = !!autoFlip.keepAwake;

    if (!newActive) {
      if (this.isActive) {
        this.stopAll();
        this.isActive = false;
      }
    } else {
      if (!this.isActive || this.intervalSeconds !== newInterval || this.keepAwake !== newKeepAwake) {
        if (this.isActive) this.stopAll();
        this.isActive = true;
        this.intervalSeconds = newInterval;
        this.keepAwake = newKeepAwake;
        this.start();
      }
    }
  }

  public stopAll() {
    this.isActive = false;
    if (this.doubleTimer) { clearInterval(this.doubleTimer); this.doubleTimer = null; }
    if (this.singleRafId) { cancelAnimationFrame(this.singleRafId); this.singleRafId = null; }
    if (this.originalTitle) { document.title = this.originalTitle; this.originalTitle = null; }
    this.elapsedTime = 0;
  }

  private start() {
    const adapter = this.siteRegistry.getCurrentAdapter();
    if (!adapter) {
      console.warn('[AutoFlipper] No adapter found');
      return;
    }

    if (adapter.isDoubleColumn()) {
      this.startDoubleColumnLogic(adapter);
    } else {
      this.startSingleColumnLogic(adapter);
    }
  }

  private startDoubleColumnLogic(adapter: ReadingSiteAdapter) {
    if (this.doubleTimer) return;
    if (this.singleRafId) { cancelAnimationFrame(this.singleRafId); this.singleRafId = null; }

    this.countdown = this.intervalSeconds;
    if (!this.originalTitle) this.originalTitle = document.title;

    this.doubleTimer = setInterval(() => {
      if (!adapter.isDoubleColumn()) {
        this.stopAll();
        this.startSingleColumnLogic(adapter);
        return;
      }
      if (document.hidden && !this.keepAwake) return;

      this.countdown--;
      document.title = `${this.appName} - 自动翻页 - ${this.countdown} 秒`;

      if (this.countdown <= 0) {
        this.onScrollLock(); // Lock mouse input during page turn
        adapter.nextPage();
        this.countdown = this.intervalSeconds;
      }
    }, 1000);
  }

  private startSingleColumnLogic(adapter: ReadingSiteAdapter) {
    if (this.singleRafId) return;
    if (this.doubleTimer) { clearInterval(this.doubleTimer); this.doubleTimer = null; }

    if (!ScrollState.isRestorationComplete()) {
      console.log('[AutoFlipper] Waiting for scroll restore...');
      setTimeout(() => this.startSingleColumnLogic(adapter), 200);
      return;
    }

    this.countdown = this.intervalSeconds;
    this.elapsedTime = 0;
    if (!this.originalTitle) this.originalTitle = document.title;

    this.lastFrameTime = performance.now();
    this.lastScrollTime = performance.now();

    this.singleRafId = requestAnimationFrame((time) => this.singleColumnLoop(time, adapter));
  }

  private singleColumnLoop(time: number, adapter: ReadingSiteAdapter) {
    if (!this.isActive) {
        this.singleRafId = null;
        return;
    }

    if (adapter.isDoubleColumn()) {
      this.stopAll();
      this.startDoubleColumnLogic(adapter);
      return;
    }

    let deltaTime = time - this.lastFrameTime;
    this.lastFrameTime = time;

    if (deltaTime > 100) {
      deltaTime = 16;
      this.accumulatedMove = 0;
    } else if (deltaTime > 50) {
      deltaTime = 50;
    }

    this.elapsedTime += deltaTime;
    if (this.elapsedTime >= 1000) {
      const scrollY = window.scrollY;
      const totalHeight = document.documentElement.scrollHeight;
      const viewportHeight = window.innerHeight;
      const maxScroll = Math.max(1, totalHeight - viewportHeight);
      const percentage = Math.min(100, Math.max(0, Math.round((scrollY / maxScroll) * 1000) / 10));

      this.elapsedTime -= 1000;
      document.title = `${this.appName} - 自动翻页 - 已读 ${percentage}%`;
    }

    if (document.hidden && !this.keepAwake) {
      this.singleRafId = requestAnimationFrame((t) => this.singleColumnLoop(t, adapter));
      return;
    }

    const timeSinceLastScroll = time - this.lastScrollTime;
    if (timeSinceLastScroll < 30) {
      this.singleRafId = requestAnimationFrame((t) => this.singleColumnLoop(t, adapter));
      return;
    }
    this.lastScrollTime = time;

    const screenHeight = window.innerHeight;
    const validInterval = this.intervalSeconds > 0 ? this.intervalSeconds : 30;
    const speed = screenHeight / (validInterval * 1000);
    const move = speed * timeSinceLastScroll;

    this.accumulatedMove += move;
    if (this.accumulatedMove >= 1) {
      this.onScrollLock(); // Lock mouse input during auto-scroll
      const pixelsToScroll = Math.floor(this.accumulatedMove);
      window.scrollBy(0, pixelsToScroll);
      this.accumulatedMove -= pixelsToScroll;

      const isAtBottom = adapter.isAtBottom();
      if (isAtBottom && !this.bottomTriggered) {
        console.log('[AutoFlipper] Reached bottom, triggering next page');
        this.bottomTriggered = true;

        adapter.nextPage();
        if (typeof (adapter as any).clickNextChapter === 'function') {
           (adapter as any).clickNextChapter();
        }

        if (this.singleRafId) {
            cancelAnimationFrame(this.singleRafId);
            this.singleRafId = null;
        }

        console.log('[AutoFlipper] Waiting 10s before resuming...');
        setTimeout(() => {
            this.bottomTriggered = false;
            if (this.isActive) {
                this.startSingleColumnLogic(adapter);
            }
        }, 10000);
        return;
      } else if (!isAtBottom) {
        this.bottomTriggered = false;
      }
    }

    this.singleRafId = requestAnimationFrame((t) => this.singleColumnLoop(t, adapter));
  }
}
