
import { settingsStore, MergedSettings } from '../core/settings_store';
import { createSiteContext, SiteContext } from '../core/site_context';
import { CursorHider } from './turner/cursor_hider';
import { SwipeHandler } from './turner/swipe_handler';
import { AutoFlipper } from './turner/auto_flipper';
import { ProgressBar } from './turner/progress_bar';

type RouteChangedEvent = {
  isReader: boolean;
  url: string;
  pathname: string;
};

/**
 * Turner Manager - Manages page turning functionality
 *
 * Responsibilities:
 * - Coordinates AutoFlipper, CursorHider, SwipeHandler, and ProgressBar
 * - Manages settings updates
 * - Handles route changes
 */
export class TurnerManager {
  private cursorHider: CursorHider;
  private swipeHandler: SwipeHandler;
  private autoFlipper: AutoFlipper;
  private progressBar: ProgressBar;
  private siteContext: SiteContext;

  // Store references for cleanup
  private routeChangedHandler: ((e: Event) => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeDoubleColumn: (() => void) | null = null;

  constructor() {
    this.siteContext = createSiteContext();
    this.cursorHider = new CursorHider(this.siteContext);

    const onScrollLock = (duration?: number) => {
      this.cursorHider.setScrollLock(duration);
    };

    this.swipeHandler = new SwipeHandler(this.siteContext, onScrollLock);
    this.autoFlipper = new AutoFlipper(this.siteContext, onScrollLock);
    this.progressBar = new ProgressBar(this.siteContext);

    this.init();
  }

  private init() {
    this.unsubscribeSettings = settingsStore.subscribe((settings) => {
      this.updateState(settings);
    });

    // 监听双栏模式变化，更新进度条显示状态
    this.unsubscribeDoubleColumn = this.siteContext.onDoubleColumnChange(() => {
      this.updateProgressBarVisibility();
    });

    this.routeChangedHandler = ((e: CustomEvent<RouteChangedEvent>) => {
      const isReader = e.detail.isReader;

      // Update components if needed
      if (!isReader) {
        // Stop auto flip if leaving reader
        const currentSettings = settingsStore.get();
        if (currentSettings.autoFlip?.active) {
            this.autoFlipper.stopAll();
            // autoFlip 现在是全局配置
            settingsStore.updateGlobal({
              autoFlip: { ...currentSettings.autoFlip, active: false }
            });
        }
      }
    }) as EventListener;

    window.addEventListener('ipc:route-changed', this.routeChangedHandler);
  }

  private updateState(settings: MergedSettings) {
    this.autoFlipper.updateState(settings);
    this.cursorHider.setEnabled(!!settings.hideCursor);
    this.updateProgressBarVisibility();
  }

  private updateProgressBarVisibility() {
    // 更新进度条显示状态
    // 只有在双栏模式且隐藏导航栏时显示
    const settings = settingsStore.get();
    const isDoubleColumn = this.siteContext.isDoubleColumn;
    const hideNavbar = settings.hideNavbar === true;
    const shouldShowProgressBar = this.siteContext.siteId !== 'local' && isDoubleColumn && hideNavbar;

    this.progressBar.setVisibility(shouldShowProgressBar);
  }

  public destroy() {
    // Remove event listeners
    if (this.routeChangedHandler) {
      window.removeEventListener('ipc:route-changed', this.routeChangedHandler);
      this.routeChangedHandler = null;
    }

    // Destroy child components
    this.cursorHider.destroy();
    this.swipeHandler.destroy();
    this.autoFlipper.stopAll();
    this.progressBar.destroy();
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.unsubscribeDoubleColumn?.();
    this.unsubscribeDoubleColumn = null;
  }
}
