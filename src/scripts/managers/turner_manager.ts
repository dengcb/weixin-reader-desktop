
import { settingsStore, AppSettings } from '../core/settings_store';
import { getSiteRegistry } from '../core/site_registry';
import { CursorHider } from './turner/cursor_hider';
import { SwipeHandler } from './turner/swipe_handler';
import { AutoFlipper } from './turner/auto_flipper';

type RouteChangedEvent = {
  isReader: boolean;
  url: string;
  pathname: string;
};

/**
 * Turner Manager - Manages page turning functionality
 *
 * Responsibilities:
 * - Coordinates AutoFlipper, CursorHider, and SwipeHandler
 * - Manages settings updates
 * - Handles route changes
 */
export class TurnerManager {
  private cursorHider: CursorHider;
  private swipeHandler: SwipeHandler;
  private autoFlipper: AutoFlipper;
  private siteRegistry = getSiteRegistry();
  private isProcessingUpdate = false;

  constructor() {
    this.cursorHider = new CursorHider();

    const onScrollLock = (duration?: number) => {
      this.cursorHider.setScrollLock(duration);
    };

    this.swipeHandler = new SwipeHandler(onScrollLock);
    this.autoFlipper = new AutoFlipper(onScrollLock);

    this.init();
  }

  private init() {
    settingsStore.subscribe((settings) => {
      this.updateState(settings);
    });

    window.addEventListener('ipc:route-changed', ((e: CustomEvent<RouteChangedEvent>) => {
      const isReader = e.detail.isReader;
      console.log('[TurnerManager] Route changed:', { isReader });

      // Update components if needed
      if (!isReader) {
        // Stop auto flip if leaving reader
        const currentSettings = settingsStore.get();
        if (currentSettings.autoFlip?.active) {
            this.autoFlipper.stopAll();
            settingsStore.update({
              autoFlip: { ...currentSettings.autoFlip, active: false }
            });
        }
      }
    }) as EventListener);
  }

  private updateState(settings: AppSettings) {
    if (this.isProcessingUpdate) return;
    this.isProcessingUpdate = true;

    try {
        this.autoFlipper.updateState(settings);
    } finally {
        setTimeout(() => { this.isProcessingUpdate = false; }, 100);
    }
  }
}
