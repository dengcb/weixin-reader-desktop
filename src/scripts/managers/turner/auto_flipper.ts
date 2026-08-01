
import { invoke } from '../../core/tauri';
import { MergedSettings } from '../../core/settings_store';
import { SiteContext } from '../../core/site_context';
import { ScrollState } from '../../core/scroll_state';
import type { ReaderSiteRuntime } from '../../core/reader_site_runtime';
import { EventBus, Events } from '../../core/event_bus';
import { log } from '../../core/logger';

export const AUTO_FLIP_POLICY = Object.freeze({
  doubleColumnTickMs: 1000,
  restorationRetryMs: 200,
  bottomResumeMs: 10000,
});

export class AutoFlipper {
  private isActive = false;
  private intervalSeconds = 30;
  private keepAwake = false;
  private doubleTimer: ReturnType<typeof setInterval> | null = null;
  private singleRafId: number | null = null;
  private restorationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private bottomResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityResumeHandler: (() => void) | null = null;
  private lastFrameTime = 0;
  private lastScrollTime = 0;
  private accumulatedMove = 0;
  private countdown = 30;
  private originalTitle: string | null = null;
  private appName: string = "艾特阅读";
  private elapsedTime = 0;
  private siteContext: SiteContext;
  private bottomTriggered = false;
  private onScrollLock: (duration?: number) => void;
  private generation = 0; // Prevent zombie loops from resurrected RAFs

  constructor(siteContext: SiteContext, onScrollLock: (duration?: number) => void) {
    this.siteContext = siteContext;
    this.onScrollLock = onScrollLock;
    this.initAppName();
  }

  private async initAppName() {
    try {
      this.appName = await invoke<string>('get_app_name') || "艾特阅读";
    } catch (e) {
      this.appName = "艾特阅读";
    }
  }

  public updateState(settings: MergedSettings) {
    const autoFlip = settings.autoFlip || { active: false, interval: 15, keepAwake: true };
    const newActive = !!autoFlip.active;
    const newInterval = autoFlip.interval > 0 ? autoFlip.interval : 15;
    const newKeepAwake = !!autoFlip.keepAwake;

    // Remove isProcessingUpdate check, handled by generation counter
    if (!newActive) {
      if (this.isActive) {
        this.stopAll();
        this.isActive = false;
      }
    } else {
      // Logic for changing state
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
    this.clearScheduledWork(true);
  }

  private clearScheduledWork(restoreTitle: boolean) {
    this.generation++; // Invalidate all pending loops
    if (this.doubleTimer) { clearInterval(this.doubleTimer); this.doubleTimer = null; }
    if (this.singleRafId) { cancelAnimationFrame(this.singleRafId); this.singleRafId = null; }
    if (this.restorationRetryTimer) {
      clearTimeout(this.restorationRetryTimer);
      this.restorationRetryTimer = null;
    }
    if (this.bottomResumeTimer) {
      clearTimeout(this.bottomResumeTimer);
      this.bottomResumeTimer = null;
    }
    if (this.visibilityResumeHandler) {
      document.removeEventListener('visibilitychange', this.visibilityResumeHandler);
      this.visibilityResumeHandler = null;
    }
    if (restoreTitle && this.originalTitle !== null) {
      // 恢复原生窗口标题为当前页面标题
      // document.title 从未被修改，始终是真实页面标题
      invoke('set_title', { title: document.title }).catch(() => {});
      this.originalTitle = null;
    }
    this.bottomTriggered = false;
    this.accumulatedMove = 0;
    this.elapsedTime = 0;
  }

  private switchMode(startNextMode: () => void) {
    // 模式切换只替换循环，不改变用户的“自动翻页已开启”状态。
    this.clearScheduledWork(false);
    startNextMode();
  }

  private start() {
    const runtime = this.siteContext.currentRuntime;
    if (!runtime) {
      log.warn('[AutoFlipper] No site runtime found');
      return;
    }

    if (this.siteContext.isDoubleColumn) {
      this.startDoubleColumnLogic(runtime);
    } else {
      this.startSingleColumnLogic(runtime);
    }
  }

  private startDoubleColumnLogic(adapter: ReaderSiteRuntime) {
    if (this.doubleTimer) return;
    if (this.singleRafId) { cancelAnimationFrame(this.singleRafId); this.singleRafId = null; }

    this.countdown = this.intervalSeconds;
    if (!this.originalTitle) this.originalTitle = document.title;
    const currentGeneration = this.generation;

    this.doubleTimer = setInterval(() => {
      if (!this.isActive || currentGeneration !== this.generation) return;
      // 检测是否切换到单栏模式
      if (!this.siteContext.isDoubleColumn) {
        this.switchMode(() => this.startSingleColumnLogic(adapter));
        return;
      }
      if (document.hidden && !this.keepAwake) return;

      this.countdown--;
      // 直接更新原生窗口标题栏，不修改 document.title
      // 避免 MutationObserver 误判为章节切换，干扰自动翻页
      invoke('set_title', { title: `${this.appName} - 自动翻页 - ${this.countdown} 秒` }).catch(() => {});

      if (this.countdown <= 0) {
        this.onScrollLock(); // Lock mouse input during page turn
        EventBus.emit(Events.PAGE_TURN_DIRECTION, { direction: 'forward' });
        adapter.nextPage();
        this.countdown = this.intervalSeconds;
      }
    }, AUTO_FLIP_POLICY.doubleColumnTickMs);
  }

  private startSingleColumnLogic(adapter: ReaderSiteRuntime) {
    if (this.singleRafId) return;
    if (this.doubleTimer) { clearInterval(this.doubleTimer); this.doubleTimer = null; }

    if (!ScrollState.isRestorationComplete()) {
      if (this.restorationRetryTimer) clearTimeout(this.restorationRetryTimer);
      this.restorationRetryTimer = setTimeout(() => {
        this.restorationRetryTimer = null;
        if (this.isActive) {
          this.startSingleColumnLogic(adapter);
        }
      }, AUTO_FLIP_POLICY.restorationRetryMs);
      return;
    }

    this.countdown = this.intervalSeconds;
    this.elapsedTime = 0;
    if (!this.originalTitle) this.originalTitle = document.title;

    this.lastFrameTime = performance.now();
    this.lastScrollTime = performance.now();

    const currentGen = this.generation;
    this.singleRafId = requestAnimationFrame((time) => this.singleColumnLoop(time, adapter, currentGen));
  }

  private singleColumnLoop(time: number, adapter: ReaderSiteRuntime, gen: number) {
    // 1. Check generation first - if generation changed, this loop is a zombie
    if (gen !== this.generation) {
      return;
    }

    if (!this.isActive) {
        this.singleRafId = null;
        return;
    }

    // 检测是否切换到双栏模式
    if (this.siteContext.isDoubleColumn) {
      this.switchMode(() => this.startDoubleColumnLogic(adapter));
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
      // 直接更新原生窗口标题栏，不修改 document.title
      invoke('set_title', { title: `${this.appName} - 自动翻页 - 已读 ${percentage}%` }).catch(() => {});
    }

    // 页面在后台且不需要保持唤醒时，暂停 RAF 循环以节省 CPU
    if (document.hidden && !this.keepAwake) {
      this.singleRafId = null;
      // 监听 visibilitychange 事件，页面恢复时重新启动循环
      this.visibilityResumeHandler = () => {
        if (!document.hidden) {
          if (this.visibilityResumeHandler) {
            document.removeEventListener('visibilitychange', this.visibilityResumeHandler);
            this.visibilityResumeHandler = null;
          }
          if (this.isActive && gen === this.generation) {
          this.startSingleColumnLogic(adapter);
          }
        }
      };
      document.addEventListener('visibilitychange', this.visibilityResumeHandler);
      return;
    }

    const timeSinceLastScroll = time - this.lastScrollTime;
    if (timeSinceLastScroll < 30) {
      this.singleRafId = requestAnimationFrame((t) => this.singleColumnLoop(t, adapter, gen));
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

      const isAtBottom = adapter.isAtBottom?.() ?? false;
      if (isAtBottom && !this.bottomTriggered) {
        log.debug('[AutoFlipper] Reached bottom, triggering next page');
        this.bottomTriggered = true;

        EventBus.emit(Events.PAGE_TURN_DIRECTION, { direction: 'forward' });
        adapter.nextPage();
        if (adapter.clickNextChapter) {
          adapter.clickNextChapter();
        }

        if (this.singleRafId) {
            cancelAnimationFrame(this.singleRafId);
            this.singleRafId = null;
        }

        this.bottomResumeTimer = setTimeout(() => {
            this.bottomResumeTimer = null;
            this.bottomTriggered = false;
            // Only resume if still active and generation matches
            if (this.isActive && this.generation === gen) {
                this.startSingleColumnLogic(adapter);
            }
        }, AUTO_FLIP_POLICY.bottomResumeMs);
        return;
      } else if (!isAtBottom) {
        this.bottomTriggered = false;
      }
    }

    this.singleRafId = requestAnimationFrame((t) => this.singleColumnLoop(t, adapter, gen));
  }
}
