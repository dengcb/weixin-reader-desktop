
import { settingsStore, AppSettings, MergedSettings } from '../core/settings_store';
import { createSiteContext, SiteContext } from '../core/site_context';
import { CursorHider } from './turner/cursor_hider';
import { SwipeHandler } from './turner/swipe_handler';
import { AutoFlipper } from './turner/auto_flipper';
import { log } from '../core/logger';

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
  private siteContext: SiteContext;

  // Store references for cleanup
  private routeChangedHandler: ((e: Event) => void) | null = null;

  constructor() {
    this.siteContext = createSiteContext();
    this.cursorHider = new CursorHider(this.siteContext);

    const onScrollLock = (duration?: number) => {
      this.cursorHider.setScrollLock(duration);
    };

    this.swipeHandler = new SwipeHandler(this.siteContext, onScrollLock);
    this.autoFlipper = new AutoFlipper(this.siteContext, onScrollLock);

    this.init();
  }

  private init() {
    settingsStore.subscribe((settings) => {
      this.updateState(settings);
    });

    this.routeChangedHandler = ((e: CustomEvent<RouteChangedEvent>) => {
      const isReader = e.detail.isReader;

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
    }) as EventListener;

    window.addEventListener('ipc:route-changed', this.routeChangedHandler);
  }

  private updateState(settings: MergedSettings) {
    this.autoFlipper.updateState(settings);
  }

  public destroy() {
    // Remove event listener
    if (this.routeChangedHandler) {
      window.removeEventListener('ipc:route-changed', this.routeChangedHandler);
      this.routeChangedHandler = null;
    }

    // Destroy child components
    this.cursorHider.destroy();
    this.swipeHandler.destroy();
    this.autoFlipper.stopAll();
  }
}
