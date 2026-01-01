/**
 * Scroll State Manager
 *
 * CRITICAL MECHANISM: This module manages the mutual exclusion between:
 * 1. Initial scroll restoration (AppManager)
 * 2. Scroll position saving (IPCManager)
 * 3. Auto-scrolling (TurnerManager)
 *
 * Rule: No saving or auto-scrolling is allowed until restoration is complete.
 * This prevents the "scroll to bottom" loading chase from corrupting the saved user position.
 */

// Use a window global key to ensure state persists across module reloads if that happens,
// and effectively communicates between different parts of the app.
const RESTORED_KEY = '__wxrd_scroll_restored';

export class ScrollState {
  /**
   * Check if the initial scroll restoration process is finished.
   */
  static isRestorationComplete(): boolean {
    return !!(window as any)[RESTORED_KEY];
  }

  /**
   * Mark the restoration process as complete.
   * calling this allows IPCManager to start saving scroll positions again.
   */
  static markRestorationComplete() {
    if (!this.isRestorationComplete()) {
      console.log('[ScrollState] Restoration marked as complete - unlocking save/auto-scroll');
      (window as any)[RESTORED_KEY] = true;
    }
  }

  /**
   * Wait for restoration to complete (polling)
   * Useful for async startup sequences
   */
  static async waitForRestoration(timeoutMs = 2000): Promise<void> {
    if (this.isRestorationComplete()) return;

    return new Promise((resolve) => {
      const start = Date.now();
      
      const check = () => {
        if (this.isRestorationComplete()) {
          resolve();
          return;
        }
        
        if (Date.now() - start > timeoutMs) {
          console.warn(`[ScrollState] Timeout waiting for restoration (${timeoutMs}ms)`);
          resolve(); 
          return;
        }
        
        // Check every 100ms
        setTimeout(check, 100);
      };
      
      check();
    });
  }
}
