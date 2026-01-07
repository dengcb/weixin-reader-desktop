/**
 * Unit Tests for ScrollState
 *
 * Tests the scroll restoration mutual exclusion mechanism:
 * - Restoration state checking
 * - Restoration completion marking
 * - Async restoration waiting with timeout
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ScrollState } from '../scroll_state';

describe('ScrollState', () => {
  const RESTORED_KEY = '__wxrd_scroll_restored';

  beforeEach(() => {
    // 清理全局状态
    delete (window as any)[RESTORED_KEY];
  });

  afterEach(() => {
    // 清理全局状态
    delete (window as any)[RESTORED_KEY];
  });

  describe('isRestorationComplete', () => {
    it('should return false when restoration is not complete', () => {
      expect(ScrollState.isRestorationComplete()).toBe(false);
    });

    it('should return true when restoration is marked complete', () => {
      ScrollState.markRestorationComplete();
      expect(ScrollState.isRestorationComplete()).toBe(true);
    });

    it('should persist state across multiple calls', () => {
      ScrollState.markRestorationComplete();

      expect(ScrollState.isRestorationComplete()).toBe(true);
      expect(ScrollState.isRestorationComplete()).toBe(true);
      expect(ScrollState.isRestorationComplete()).toBe(true);
    });

    it('should return false after manual cleanup', () => {
      ScrollState.markRestorationComplete();
      expect(ScrollState.isRestorationComplete()).toBe(true);

      delete (window as any)[RESTORED_KEY];
      expect(ScrollState.isRestorationComplete()).toBe(false);
    });
  });

  describe('markRestorationComplete', () => {
    it('should set window global flag', () => {
      expect((window as any)[RESTORED_KEY]).toBeUndefined();

      ScrollState.markRestorationComplete();

      expect((window as any)[RESTORED_KEY]).toBe(true);
    });

    it('should be idempotent', () => {
      ScrollState.markRestorationComplete();
      const firstValue = (window as any)[RESTORED_KEY];

      ScrollState.markRestorationComplete();
      const secondValue = (window as any)[RESTORED_KEY];

      expect(firstValue).toBe(secondValue);
      expect(secondValue).toBe(true);
    });

    it('should allow restoration state to be checked immediately', () => {
      expect(ScrollState.isRestorationComplete()).toBe(false);

      ScrollState.markRestorationComplete();

      expect(ScrollState.isRestorationComplete()).toBe(true);
    });
  });

  describe('waitForRestoration', () => {
    it('should resolve immediately if already complete', async () => {
      ScrollState.markRestorationComplete();

      const start = Date.now();
      await ScrollState.waitForRestoration();
      const elapsed = Date.now() - start;

      // 应该几乎立即返回 (< 50ms)
      expect(elapsed).toBeLessThan(50);
    });

    it('should resolve when restoration completes during wait', async () => {
      const start = Date.now();

      // 在 200ms 后标记完成
      setTimeout(() => {
        ScrollState.markRestorationComplete();
      }, 200);

      await ScrollState.waitForRestoration(1000);
      const elapsed = Date.now() - start;

      // 应该在 200-300ms 之间完成 (200ms 延迟 + 轮询间隔)
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(400);
      expect(ScrollState.isRestorationComplete()).toBe(true);
    });

    it('should timeout after specified duration', async () => {
      const start = Date.now();
      const timeoutMs = 500;

      await ScrollState.waitForRestoration(timeoutMs);
      const elapsed = Date.now() - start;

      // 应该在 timeout 时间附近完成 (± 150ms)
      expect(elapsed).toBeGreaterThanOrEqual(timeoutMs);
      expect(elapsed).toBeLessThan(timeoutMs + 150);
    });

    it('should poll every 100ms', async () => {
      let pollCount = 0;
      const originalIsComplete = ScrollState.isRestorationComplete;

      // Mock isRestorationComplete 来计数轮询次数
      ScrollState.isRestorationComplete = function() {
        pollCount++;
        return originalIsComplete.call(ScrollState);
      };

      const timeoutMs = 500;
      await ScrollState.waitForRestoration(timeoutMs);

      // 应该轮询 5-6 次 (500ms / 100ms polling interval)
      expect(pollCount).toBeGreaterThanOrEqual(4);
      expect(pollCount).toBeLessThanOrEqual(7);

      // 恢复原函数
      ScrollState.isRestorationComplete = originalIsComplete;
    });

    it('should resolve without error on timeout', async () => {
      // 不应该抛出异常
      await expect(ScrollState.waitForRestoration(100)).resolves.toBeUndefined();
    });

    it('should handle concurrent waitForRestoration calls', async () => {
      const promises = [
        ScrollState.waitForRestoration(500),
        ScrollState.waitForRestoration(500),
        ScrollState.waitForRestoration(500),
      ];

      // 在 100ms 后标记完成
      setTimeout(() => {
        ScrollState.markRestorationComplete();
      }, 100);

      const results = await Promise.all(promises);

      // 所有 promise 都应该成功 resolve
      expect(results.length).toBe(3);
      results.forEach(result => expect(result).toBeUndefined());
    });

    it('should use default timeout of 2000ms', async () => {
      const start = Date.now();

      // 不提供 timeout 参数
      await ScrollState.waitForRestoration();
      const elapsed = Date.now() - start;

      // 应该使用默认的 2000ms timeout
      expect(elapsed).toBeGreaterThanOrEqual(2000);
      expect(elapsed).toBeLessThan(2150);
    });

    it('should stop polling after restoration is complete', async () => {
      let pollCount = 0;
      const originalIsComplete = ScrollState.isRestorationComplete;

      ScrollState.isRestorationComplete = function() {
        pollCount++;
        return originalIsComplete.call(ScrollState);
      };

      // 在 250ms 后标记完成
      setTimeout(() => {
        ScrollState.markRestorationComplete();
      }, 250);

      await ScrollState.waitForRestoration(2000);

      const finalPollCount = pollCount;

      // 等待额外的时间确保轮询已停止
      await new Promise(resolve => setTimeout(resolve, 300));

      // 轮询次数应该没有增加 (已停止轮询)
      expect(pollCount).toBe(finalPollCount);

      ScrollState.isRestorationComplete = originalIsComplete;
    });
  });

  describe('Integration - Restoration Lifecycle', () => {
    it('should simulate complete restoration flow', async () => {
      // 初始状态：未恢复
      expect(ScrollState.isRestorationComplete()).toBe(false);

      // 开始等待恢复
      const waitPromise = ScrollState.waitForRestoration(1000);

      // 模拟异步恢复过程
      setTimeout(() => {
        // 执行恢复逻辑
        // ...

        // 标记恢复完成
        ScrollState.markRestorationComplete();
      }, 150);

      // 等待恢复完成
      await waitPromise;

      // 最终状态：已恢复
      expect(ScrollState.isRestorationComplete()).toBe(true);
    });

    it('should prevent saving before restoration completes', async () => {
      // 模拟保存逻辑的检查
      function canSavePosition(): boolean {
        return ScrollState.isRestorationComplete();
      }

      // 恢复前不能保存
      expect(canSavePosition()).toBe(false);

      // 标记恢复完成
      ScrollState.markRestorationComplete();

      // 恢复后可以保存
      expect(canSavePosition()).toBe(true);
    });

    it('should allow auto-scroll only after restoration', () => {
      // 模拟自动滚动逻辑的检查
      function canAutoScroll(): boolean {
        return ScrollState.isRestorationComplete();
      }

      expect(canAutoScroll()).toBe(false);

      ScrollState.markRestorationComplete();

      expect(canAutoScroll()).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid mark and check calls', () => {
      for (let i = 0; i < 100; i++) {
        if (i === 50) {
          ScrollState.markRestorationComplete();
        }

        const isComplete = ScrollState.isRestorationComplete();

        if (i < 50) {
          expect(isComplete).toBe(false);
        } else {
          expect(isComplete).toBe(true);
        }
      }
    });

    it('should handle zero timeout gracefully', async () => {
      const start = Date.now();
      await ScrollState.waitForRestoration(0);
      const elapsed = Date.now() - start;

      // 应该立即 timeout
      expect(elapsed).toBeLessThan(150);
    });

    it('should handle very small timeout', async () => {
      const start = Date.now();
      await ScrollState.waitForRestoration(50);
      const elapsed = Date.now() - start;

      // 应该在 50-200ms 之间完成
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(elapsed).toBeLessThan(200);
    });

    it('should handle manual state corruption', () => {
      // 设置非 boolean 值
      (window as any)[RESTORED_KEY] = 'true';

      // 应该仍然返回 truthy
      expect(ScrollState.isRestorationComplete()).toBeTruthy();

      // 清理
      delete (window as any)[RESTORED_KEY];

      // 应该返回 false
      expect(ScrollState.isRestorationComplete()).toBe(false);
    });
  });
});
