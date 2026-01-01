/**
 * 页面滚动工具类
 * 负责页面内容的滚动、预加载、锚点定位等底层操作
 */
export class PageScroller {
  /**
   * 寻找视口中心的锚点元素，用于位置恢复
   */
  static findAnchorElement(): { element: Element, top: number } | null {
    const x = window.innerWidth / 2;
    const y = Math.min(window.innerHeight * 0.3, 200);
    const element = document.elementFromPoint(x, y);
    if (element) {
      return { element, top: element.getBoundingClientRect().top };
    }
    return null;
  }

  /**
   * 恢复锚点位置
   */
  static restoreAnchorPosition(anchor: { element: Element, top: number }) {
    if (!anchor.element.isConnected) {
      console.warn('[PageScroller] Anchor element is detached, cannot restore position');
      return;
    }

    // Use instant behavior to prevent drift from smooth scrolling
    anchor.element.scrollIntoView({ behavior: 'instant', block: 'start' });
    window.scrollBy({ top: -anchor.top, behavior: 'instant' });
  }

  /**
   * 暴力追赶预加载
   * 同步循环滚动触发加载，无延迟
   */
  static async preloadChapter() {
    const startY = window.scrollY;
    console.log('[PageScroller] Starting preload chase');

    const anchor = this.findAnchorElement();
    const CHASE_STEP = 20000;
    const MAX_ATTEMPTS = 10;
    let attempts = 0;
    let lastHeight = 0;

    // 同步死循环追赶，不让出主线程
    while (attempts < MAX_ATTEMPTS) {
      // 这里的 .readerFooter 检测需要根据实际情况，如果它在 DOM 中不稳定，可以移除
      if (document.querySelector('.readerFooter')) break;

      const currentHeight = document.documentElement.scrollHeight; // Force Reflow

      if (attempts > 0 && currentHeight === lastHeight) break;

      lastHeight = currentHeight;
      attempts++;
      window.scrollTo(0, currentHeight + CHASE_STEP);
    }

    console.log('[PageScroller] Preload done, bouncing back');

    if (anchor) {
      this.restoreAnchorPosition(anchor);
    } else {
      window.scrollTo({ top: startY, behavior: 'instant' });
    }
  }

  /**
   * 等待新内容加载
   * @param onContentFound 发现新内容时的回调
   */
  static waitForNewContent(onContentFound: () => void) {
    const startHeight = document.documentElement.scrollHeight;
    let checks = 0;
    const MAX_CHECKS = 50; // 5s (50 * 100ms)

    const timer = setInterval(() => {
      checks++;
      const newHeight = document.documentElement.scrollHeight;

      if (newHeight !== startHeight) {
        clearInterval(timer);
        console.log('[PageScroller] New content detected');
        onContentFound();
      } else if (checks >= MAX_CHECKS) {
        clearInterval(timer);
        console.log('[PageScroller] Timeout waiting for content (no change)');
        // 超时不执行任何操作，直接结束
      }
    }, 100);
  }
}
