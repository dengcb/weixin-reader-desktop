/**
 * Turner Manager - Manages auto-flip functionality
 *
 * Responsibilities:
 * - Auto page turning for single-column mode (smooth scrolling)
 * - Auto page turning for double-column mode (interval-based)
 * - Countdown display in title
 *
 * Listens to:
 * - 'ipc:route-changed' - Stop auto-flip when leaving reader page
 * - Settings store changes - Start/stop based on autoFlip setting
 */

import { invoke } from '../core/tauri';
import { settingsStore, AppSettings } from '../core/settings_store';
import { getSiteRegistry } from '../core/site_registry';
import { ReadingSiteAdapter } from '../adapters/reading_site_adapter';

type RouteChangedEvent = {
  isReader: boolean;
  url: string;
  pathname: string;
};

export class TurnerManager {
  // Auto Flip State
  private isActive = false;
  private intervalSeconds = 30;
  private keepAwake = false;
  private doubleTimer: ReturnType<typeof setInterval> | null = null;
  private singleRafId: number | null = null;
  private lastFrameTime = 0;
  private accumulatedMove = 0;
  private countdown = 30;
  private originalTitle: string | null = null;
  private appName: string = "微信阅读";
  private elapsedTime = 0;
  private siteRegistry = getSiteRegistry();
  private isProcessingUpdate = false;  // Prevent race conditions

  constructor() {
    this.init();
  }

  private async init() {
    try {
      this.appName = await invoke<string>('get_app_name') || "微信阅读";
    } catch (e) {
      console.error("TurnerManager: Failed to get app name", e);
    }

    // SettingsStore is already initialized by inject.ts
    settingsStore.subscribe((settings) => {
      this.updateState(settings);
    });

    // Listen to route changes from IPCManager
    window.addEventListener('ipc:route-changed', ((e: CustomEvent<RouteChangedEvent>) => {
      const isReader = e.detail.isReader;
      console.log('[TurnerManager] Route changed:', { isReader, isActive: this.isActive });
      if (!isReader) {
        // Stop auto flip AND clear the active state when leaving reader
        if (this.isActive) {
          console.log('[TurnerManager] Stopping auto flip and clearing setting');
          this.stopAll();
          const currentSettings = settingsStore.get();
          if (currentSettings.autoFlip?.active) {
            console.log('[TurnerManager] Updating autoFlip.active to false');
            settingsStore.update({
              autoFlip: { ...currentSettings.autoFlip, active: false }
            });
          }
        }
      }
    }) as EventListener);
  }

  private updateState(settings: AppSettings) {
    // Prevent race conditions: if already processing, skip this update
    // unless it's a deactivation request (prioritize stopping over starting)
    const autoFlip = settings.autoFlip || { active: false, interval: 15, keepAwake: true };
    const newActive = !!autoFlip.active;

    // If trying to activate while already processing, skip to prevent race
    if (newActive && this.isProcessingUpdate) {
      console.log('[TurnerManager] Skipping update (already processing)');
      return;
    }

    const newInterval = autoFlip.interval > 0 ? autoFlip.interval : 15;
    const newKeepAwake = !!autoFlip.keepAwake;

    console.log('[TurnerManager] updateState called:', {
      autoFlip,
      newActive,
      newInterval,
      newKeepAwake,
      currentInterval: this.intervalSeconds,
      currentKeepAwake: this.keepAwake,
      currentIsActive: this.isActive,
      isProcessing: this.isProcessingUpdate
    });

    if (!newActive) {
      // Deactivation: always process, even if already processing
      if (this.isActive) {
        console.log('[TurnerManager] Stopping auto flip (deactivated)');
        this.isProcessingUpdate = true;
        this.stopAll();
        this.isActive = false;
        this.isProcessingUpdate = false;
      }
    } else {
      // Activation: check if not already active
      if (!this.isActive) {
        console.log('[TurnerManager] Starting auto flip (was inactive)');
        this.isProcessingUpdate = true;
        this.isActive = true;
        this.intervalSeconds = newInterval;
        this.keepAwake = newKeepAwake;
        this.start();
        // Don't clear isProcessingUpdate immediately - let start() complete
        setTimeout(() => { this.isProcessingUpdate = false; }, 100);
      } else if (this.intervalSeconds !== newInterval || this.keepAwake !== newKeepAwake) {
        console.log('[TurnerManager] Restarting auto flip with new params');
        this.isProcessingUpdate = true;
        this.stopAll();
        this.intervalSeconds = newInterval;
        this.keepAwake = newKeepAwake;
        this.start();
        setTimeout(() => { this.isProcessingUpdate = false; }, 100);
      } else {
        console.log('[TurnerManager] Already active with same params, ignoring');
      }
    }
  }

  private start() {
    console.log('[TurnerManager] start() called, isActive:', this.isActive);
    const adapter = this.siteRegistry.getCurrentAdapter();
    console.log('[TurnerManager] Adapter:', adapter?.name || 'none', 'isDoubleColumn:', adapter?.isDoubleColumn() || false);

    if (!adapter) {
      console.warn('[TurnerManager] No adapter found, auto flip not started');
      return;
    }

    if (adapter.isDoubleColumn()) {
      console.log('[TurnerManager] Starting double-column auto flip');
      this.startDoubleColumnLogic(adapter);
    } else {
      console.log('[TurnerManager] Starting single-column auto flip');
      this.startSingleColumnLogic(adapter);
    }
  }

  private stopAll() {
    this.isActive = false;
    if (this.doubleTimer) { clearInterval(this.doubleTimer); this.doubleTimer = null; }
    if (this.singleRafId) { cancelAnimationFrame(this.singleRafId); this.singleRafId = null; }
    if (this.originalTitle) { document.title = this.originalTitle; this.originalTitle = null; }
    this.elapsedTime = 0;
  }

  private startDoubleColumnLogic(adapter: ReadingSiteAdapter) {
    if (this.doubleTimer) return;
    if (this.singleRafId) { cancelAnimationFrame(this.singleRafId); this.singleRafId = null; }

    this.countdown = this.intervalSeconds;
    if (!this.originalTitle) this.originalTitle = document.title;

    console.log('[TurnerManager] Double-column: intervalSeconds=', this.intervalSeconds, 'keepAwake=', this.keepAwake);

    this.doubleTimer = setInterval(() => {
      if (!adapter.isDoubleColumn()) {
        console.log('[TurnerManager] Mode changed to single-column, switching logic');
        this.stopAll();
        this.startSingleColumnLogic(adapter);
        return;
      }
      if (document.hidden && !this.keepAwake) return;

      this.countdown--;
      document.title = `${this.appName} - 自动翻页 - ${this.countdown} 秒`;
      console.log('[TurnerManager] Double-column countdown:', this.countdown);

      if (this.countdown <= 0) {
        console.log('[TurnerManager] Double-column: triggering nextPage');
        adapter.nextPage();
        this.countdown = this.intervalSeconds;
      }
    }, 1000);

    console.log('[TurnerManager] Double-column timer started');
  }

  private startSingleColumnLogic(adapter: ReadingSiteAdapter) {
    if (this.singleRafId) return;
    if (this.doubleTimer) { clearInterval(this.doubleTimer); this.doubleTimer = null; }

    this.countdown = this.intervalSeconds;
    this.elapsedTime = 0;
    if (!this.originalTitle) this.originalTitle = document.title;

    this.lastFrameTime = performance.now();

    console.log('[TurnerManager] Single-column: intervalSeconds=', this.intervalSeconds, 'keepAwake=', this.keepAwake);

    const loop = (time: number) => {
      if (adapter.isDoubleColumn()) {
        console.log('[TurnerManager] Mode changed to double-column, switching logic');
        this.stopAll();
        this.startDoubleColumnLogic(adapter);
        return;
      }
      if (!this.isActive) {
        console.log('[TurnerManager] Single-column: isActive is false, stopping RAF');
        return;
      }

      let deltaTime = time - this.lastFrameTime;
      this.lastFrameTime = time;
      if (deltaTime > 100) deltaTime = 16;

      this.elapsedTime += deltaTime;
      if (this.elapsedTime >= 1000) {
        this.countdown--;
        this.elapsedTime -= 1000;
        document.title = `${this.appName} - 自动翻页 - ${this.countdown} 秒`;
        console.log('[TurnerManager] Single-column countdown:', this.countdown, 'elapsedTime:', this.elapsedTime);
      }

      if (document.hidden && !this.keepAwake) {
        this.singleRafId = requestAnimationFrame(loop);
        return;
      }

      const screenHeight = window.innerHeight;
      const validInterval = this.intervalSeconds > 0 ? this.intervalSeconds : 30;
      const speed = (screenHeight * 2) / (validInterval * 1000);
      const move = speed * deltaTime;

      this.accumulatedMove += move;
      if (this.accumulatedMove >= 1) {
        const pixelsToScroll = Math.floor(this.accumulatedMove);
        window.scrollBy(0, pixelsToScroll);
        this.accumulatedMove -= pixelsToScroll;

        // Check if at bottom
        if (adapter.isAtBottom()) {
          // Could trigger next chapter here if adapter supports it
          if (adapter.clickNextChapter) {
            adapter.clickNextChapter();
          }
        }
      }
      this.singleRafId = requestAnimationFrame(loop);
    };

    this.singleRafId = requestAnimationFrame(loop);
    console.log('[TurnerManager] Single-column RAF started');
  }
}
