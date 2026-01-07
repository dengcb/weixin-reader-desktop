/**
 * Unit Tests for EventBus
 *
 * Tests the core event bus system:
 * - Event subscription and emission
 * - Automatic deduplication
 * - Once-only listeners
 * - History replay
 * - Module cleanup
 * - AbortSignal support
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventBus, Events } from '../event_bus';

describe('EventBus - Basic Subscription', () => {
  beforeEach(() => {
    // 清理所有监听器和历史
    EventBus['listeners'].clear();
    EventBus['eventHistory'].clear();
  });

  describe('on and emit', () => {
    it('should register and trigger event listeners', () => {
      let received: any = null;
      const callback = (data: any) => { received = data; };

      EventBus.on('test-event', callback);
      EventBus.emit('test-event', { value: 42 });

      expect(received).toEqual({ value: 42 });
    });

    it('should trigger multiple listeners for same event', () => {
      const results: number[] = [];

      EventBus.on('test-event', () => results.push(1));
      EventBus.on('test-event', () => results.push(2));
      EventBus.on('test-event', () => results.push(3));

      EventBus.emit('test-event');

      expect(results).toEqual([1, 2, 3]);
    });

    it('should pass data to all listeners', () => {
      const results: any[] = [];

      EventBus.on('test-event', (data) => results.push(data));
      EventBus.on('test-event', (data) => results.push(data));

      EventBus.emit('test-event', { message: 'hello' });

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ message: 'hello' });
      expect(results[1]).toEqual({ message: 'hello' });
    });

    it('should handle events with no data', () => {
      let called = false;
      EventBus.on('test-event', () => { called = true; });

      EventBus.emit('test-event');

      expect(called).toBe(true);
    });

    it('should not trigger listeners for different events', () => {
      let called = false;
      EventBus.on('event-a', () => { called = true; });

      EventBus.emit('event-b');

      expect(called).toBe(false);
    });

    it('should return unsubscribe function', () => {
      let callCount = 0;
      const callback = () => { callCount++; };

      const unsubscribe = EventBus.on('test-event', callback);

      EventBus.emit('test-event');
      expect(callCount).toBe(1);

      unsubscribe();
      EventBus.emit('test-event');
      expect(callCount).toBe(1); // 不再增加
    });
  });

  describe('Automatic Deduplication', () => {
    it('should not register same callback twice', () => {
      let callCount = 0;
      const callback = () => { callCount++; };

      EventBus.on('test-event', callback);
      EventBus.on('test-event', callback); // 重复注册

      EventBus.emit('test-event');

      expect(callCount).toBe(1); // 只调用一次
    });

    it('should allow different callbacks on same event', () => {
      const results: string[] = [];

      const callback1 = () => results.push('callback1');
      const callback2 = () => results.push('callback2');

      EventBus.on('test-event', callback1);
      EventBus.on('test-event', callback2);

      EventBus.emit('test-event');

      expect(results).toEqual(['callback1', 'callback2']);
    });

    it('should return valid unsubscribe from duplicate registration', () => {
      const callback = () => {};

      const unsubscribe1 = EventBus.on('test-event', callback);
      const unsubscribe2 = EventBus.on('test-event', callback);

      // 两次都应该返回有效的取消函数
      unsubscribe1();
      expect(EventBus.getListenerCount()).toBe(0);

      // 重新注册以确保状态正确
      EventBus.on('test-event', callback);
      unsubscribe2();
      expect(EventBus.getListenerCount()).toBe(0);
    });
  });

  describe('once', () => {
    it('should only trigger listener once', () => {
      let callCount = 0;
      const callback = () => { callCount++; };

      EventBus.once('test-event', callback);

      EventBus.emit('test-event');
      expect(callCount).toBe(1);

      EventBus.emit('test-event');
      expect(callCount).toBe(1); // 保持 1
    });

    it('should remove once listener after first trigger', () => {
      const callback = () => {};

      EventBus.once('test-event', callback);
      expect(EventBus.getListenerCount()).toBe(1);

      EventBus.emit('test-event');
      expect(EventBus.getListenerCount()).toBe(0);
    });

    it('should work with multiple once listeners', () => {
      const results: string[] = [];

      EventBus.once('test-event', () => results.push('first'));
      EventBus.once('test-event', () => results.push('second'));

      EventBus.emit('test-event');
      expect(results).toEqual(['first', 'second']);

      EventBus.emit('test-event');
      expect(results).toEqual(['first', 'second']); // 不再增加
    });

    it('should allow once and regular listeners together', () => {
      const onceCalls: number[] = [];
      const regularCalls: number[] = [];

      EventBus.once('test-event', () => onceCalls.push(1));
      EventBus.on('test-event', () => regularCalls.push(1));

      EventBus.emit('test-event');
      expect(onceCalls).toEqual([1]);
      expect(regularCalls).toEqual([1]);

      EventBus.emit('test-event');
      expect(onceCalls).toEqual([1]); // once 不再触发
      expect(regularCalls).toEqual([1, 1]); // regular 继续触发
    });
  });

  describe('off', () => {
    it('should remove specific listener', () => {
      const callback1 = () => {};
      const callback2 = () => {};

      EventBus.on('test-event', callback1);
      EventBus.on('test-event', callback2);

      expect(EventBus.getListenerCount()).toBe(2);

      EventBus.off('test-event', callback1);

      expect(EventBus.getListenerCount()).toBe(1);
    });

    it('should handle removing non-existent listener', () => {
      const callback = () => {};

      expect(() => EventBus.off('test-event', callback)).not.toThrow();
    });

    it('should clean up event when no listeners remain', () => {
      const callback = () => {};

      EventBus.on('test-event', callback);
      expect(EventBus.getStats()['test-event']).toBe(1);

      EventBus.off('test-event', callback);
      expect(EventBus.getStats()['test-event']).toBeUndefined();
    });
  });
});

describe('EventBus - History', () => {
  beforeEach(() => {
    EventBus['listeners'].clear();
    EventBus['eventHistory'].clear();
  });

  describe('onWithHistory', () => {
    it('should replay latest event data on subscription', () => {
      EventBus.emit('test-event', { value: 42 });

      let received: any = null;
      EventBus.onWithHistory('test-event', (data) => { received = data; });

      expect(received).toEqual({ value: 42 });
    });

    it('should not replay if no history exists', () => {
      let called = false;
      EventBus.onWithHistory('test-event', () => { called = true; });

      expect(called).toBe(false);
    });

    it('should receive future events after subscription', () => {
      EventBus.emit('test-event', { value: 1 });

      const results: any[] = [];
      EventBus.onWithHistory('test-event', (data) => results.push(data));

      expect(results).toEqual([{ value: 1 }]); // 立即回放

      EventBus.emit('test-event', { value: 2 });
      expect(results).toEqual([{ value: 1 }, { value: 2 }]); // + 未来事件
    });

    it('should replay only latest event', () => {
      EventBus.emit('test-event', { value: 1 });
      EventBus.emit('test-event', { value: 2 });
      EventBus.emit('test-event', { value: 3 });

      let received: any = null;
      EventBus.onWithHistory('test-event', (data) => { received = data; });

      expect(received).toEqual({ value: 3 });
    });

    it('should handle once with history', () => {
      EventBus.emit('test-event', { value: 42 });

      let callCount = 0;
      EventBus.onWithHistory('test-event', () => { callCount++; }, { once: true });

      // 历史已回放,不应该订阅未来事件
      expect(callCount).toBe(1);

      EventBus.emit('test-event');
      expect(callCount).toBe(1); // 保持 1
    });

    it('should handle once without history', () => {
      let callCount = 0;
      EventBus.onWithHistory('test-event', () => { callCount++; }, { once: true });

      expect(callCount).toBe(0); // 没有历史

      EventBus.emit('test-event');
      expect(callCount).toBe(1); // 触发一次

      EventBus.emit('test-event');
      expect(callCount).toBe(1); // 保持 1
    });

    it('should handle error in history replay gracefully', () => {
      EventBus.emit('test-event', { value: 42 });

      let futureCalled = false;

      // 第一个监听器会抛出错误
      EventBus.onWithHistory('test-event', () => {
        throw new Error('Intentional error');
      });

      // 等待历史回放完成

      // 第二个监听器应该仍然工作 (包括历史回放)
      EventBus.onWithHistory('test-event', () => {
        futureCalled = true;
      });

      // 第二个监听器的历史回放应该被触发
      expect(futureCalled).toBe(true);

      // 未来事件也能正常工作
      EventBus.emit('test-event');

      expect(futureCalled).toBe(true); // 仍然是 true (虽然被调用了两次)
    });
  });

  describe('getLatestEvent', () => {
    it('should return latest event data', () => {
      EventBus.emit('test-event', { value: 1 });
      EventBus.emit('test-event', { value: 2 });
      EventBus.emit('test-event', { value: 3 });

      const latest = EventBus.getLatestEvent('test-event');
      expect(latest).toEqual({ value: 3 });
    });

    it('should return null for non-existent event', () => {
      const latest = EventBus.getLatestEvent('non-existent');
      expect(latest).toBeNull();
    });

    it('should return null before any events', () => {
      const latest = EventBus.getLatestEvent('test-event');
      expect(latest).toBeNull();
    });
  });

  describe('getEventHistory', () => {
    it('should return full history', () => {
      EventBus.emit('test-event', { value: 1 });
      EventBus.emit('test-event', { value: 2 });
      EventBus.emit('test-event', { value: 3 });

      const history = EventBus.getEventHistory('test-event');

      expect(history).toHaveLength(3);
      expect(history[0].data).toEqual({ value: 1 });
      expect(history[1].data).toEqual({ value: 2 });
      expect(history[2].data).toEqual({ value: 3 });
    });

    it('should return empty array for non-existent event', () => {
      const history = EventBus.getEventHistory('non-existent');
      expect(history).toEqual([]);
    });

    it('should return copy of history (not reference)', () => {
      EventBus.emit('test-event', { value: 1 });

      const history1 = EventBus.getEventHistory('test-event');
      const history2 = EventBus.getEventHistory('test-event');

      expect(history1).not.toBe(history2);
      expect(history1).toEqual(history2);
    });

    it('should limit history to MAX_HISTORY entries', () => {
      // EventBus 最大历史记录是 10
      for (let i = 0; i < 15; i++) {
        EventBus.emit('test-event', { value: i });
      }

      const history = EventBus.getEventHistory('test-event');

      expect(history.length).toBeLessThanOrEqual(10);
      expect(history[history.length - 1].data.value).toBe(14); // 最新的是 14
    });
  });

  describe('clearHistory', () => {
    it('should clear specific event history', () => {
      EventBus.emit('test-event', { value: 1 });
      EventBus.emit('test-event', { value: 2 });

      EventBus.clearHistory('test-event');

      const latest = EventBus.getLatestEvent('test-event');
      expect(latest).toBeNull();
    });

    it('should clear all history when no event specified', () => {
      EventBus.emit('event-a', { value: 1 });
      EventBus.emit('event-b', { value: 2 });

      EventBus.clearHistory();

      expect(EventBus.getLatestEvent('event-a')).toBeNull();
      expect(EventBus.getLatestEvent('event-b')).toBeNull();
    });
  });
});

describe('EventBus - Module Cleanup', () => {
  beforeEach(() => {
    EventBus['listeners'].clear();
    EventBus['eventHistory'].clear();
  });

  it('should cleanup all listeners for a module', () => {
    const callback1 = () => {};
    const callback2 = () => {};
    const callback3 = () => {};

    EventBus.on('test-event', callback1, { moduleId: 'module-a' });
    EventBus.on('test-event', callback2, { moduleId: 'module-a' });
    EventBus.on('test-event', callback3, { moduleId: 'module-b' });

    expect(EventBus.getListenerCount()).toBe(3);

    EventBus.cleanup('module-a');

    expect(EventBus.getListenerCount()).toBe(1);
  });

  it('should cleanup across multiple events', () => {
    const callback1 = () => {};
    const callback2 = () => {};
    const callback3 = () => {};

    EventBus.on('event-a', callback1, { moduleId: 'module-a' });
    EventBus.on('event-b', callback2, { moduleId: 'module-a' });
    EventBus.on('event-c', callback3, { moduleId: 'module-b' });

    EventBus.cleanup('module-a');

    expect(EventBus.getListenerCount()).toBe(1);
  });

  it('should handle cleanup for non-existent module', () => {
    const callback = () => {};
    EventBus.on('test-event', callback, { moduleId: 'module-a' });

    expect(() => EventBus.cleanup('module-b')).not.toThrow();
    expect(EventBus.getListenerCount()).toBe(1);
  });
});

describe('EventBus - AbortSignal', () => {
  beforeEach(() => {
    EventBus['listeners'].clear();
    EventBus['eventHistory'].clear();
  });

  it('should cleanup listener when signal aborts', () => {
    const ac = new AbortController();
    let callCount = 0;
    const callback = () => { callCount++; };

    EventBus.on('test-event', callback, { signal: ac.signal });

    EventBus.emit('test-event');
    expect(callCount).toBe(1);

    ac.abort();
    EventBus.emit('test-event');
    expect(callCount).toBe(1); // 不再触发
  });

  it('should not register listener if signal already aborted', () => {
    const ac = new AbortController();
    ac.abort();

    const callback = () => {};
    EventBus.on('test-event', callback, { signal: ac.signal });

    expect(EventBus.getListenerCount()).toBe(0);
  });

  it('should handle multiple listeners with same signal', () => {
    const ac = new AbortController();
    let count1 = 0;
    let count2 = 0;

    EventBus.on('test-event', () => { count1++; }, { signal: ac.signal });
    EventBus.on('test-event', () => { count2++; }, { signal: ac.signal });

    EventBus.emit('test-event');
    expect(count1).toBe(1);
    expect(count2).toBe(1);

    ac.abort();

    EventBus.emit('test-event');
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });
});

describe('EventBus - Error Handling', () => {
  beforeEach(() => {
    EventBus['listeners'].clear();
    EventBus['eventHistory'].clear();
  });

  it('should isolate errors from other listeners', () => {
    const results: string[] = [];

    EventBus.on('test-event', () => {
      results.push('before-error');
    });

    EventBus.on('test-event', () => {
      throw new Error('Intentional error');
    });

    EventBus.on('test-event', () => {
      results.push('after-error');
    });

    EventBus.emit('test-event');

    // 所有监听器都应该执行 (除了抛错误的)
    expect(results).toEqual(['before-error', 'after-error']);
  });

  it('should handle listener that throws on every call', () => {
    let callCount = 0;

    EventBus.on('test-event', () => {
      callCount++;
      throw new Error('Always throws');
    });

    expect(() => EventBus.emit('test-event')).not.toThrow();
    expect(callCount).toBe(1);

    expect(() => EventBus.emit('test-event')).not.toThrow();
    expect(callCount).toBe(2);
  });

  it('should remove once listener even if it throws', () => {
    let callCount = 0;

    EventBus.once('test-event', () => {
      callCount++;
      throw new Error('Error in once listener');
    });

    EventBus.emit('test-event');
    expect(callCount).toBe(1);

    EventBus.emit('test-event');
    expect(callCount).toBe(1); // once 不再触发
  });
});

describe('EventBus - Utility Methods', () => {
  beforeEach(() => {
    EventBus['listeners'].clear();
    EventBus['eventHistory'].clear();
  });

  describe('getListenerCount', () => {
    it('should return 0 when no listeners', () => {
      expect(EventBus.getListenerCount()).toBe(0);
    });

    it('should count all listeners', () => {
      EventBus.on('event-a', () => {});
      EventBus.on('event-a', () => {});
      EventBus.on('event-b', () => {});

      expect(EventBus.getListenerCount()).toBe(3);
    });
  });

  describe('getStats', () => {
    it('should return empty object when no listeners', () => {
      expect(EventBus.getStats()).toEqual({});
    });

    it('should return listener counts per event', () => {
      EventBus.on('event-a', () => {});
      EventBus.on('event-a', () => {});
      EventBus.on('event-b', () => {});

      const stats = EventBus.getStats();

      expect(stats['event-a']).toBe(2);
      expect(stats['event-b']).toBe(1);
    });
  });

  describe('getKnownEvents', () => {
    it('should return events that have been emitted', () => {
      EventBus.emit('event-a', { data: 1 });
      EventBus.emit('event-b', { data: 2 });

      const known = EventBus.getKnownEvents();

      expect(known).toContain('event-a');
      expect(known).toContain('event-b');
    });

    it('should return empty array when no events emitted', () => {
      const known = EventBus.getKnownEvents();
      expect(known).toEqual([]);
    });

    it('should update as new events are emitted', () => {
      EventBus.emit('event-a', {});

      expect(EventBus.getKnownEvents()).toContain('event-a');

      EventBus.emit('event-b', {});

      expect(EventBus.getKnownEvents()).toContain('event-b');
    });
  });
});

describe('Events constants', () => {
  it('should have all required event names', () => {
    expect(Events.ROUTE_CHANGED).toBe('ipc:route-changed');
    expect(Events.CHAPTER_CHANGED).toBe('ipc:chapter-changed');
    expect(Events.TITLE_CHANGED).toBe('ipc:title-changed');
    expect(Events.PROGRESS_UPDATED).toBe('wxrd:progress-updated');
    expect(Events.PAGE_TURN_DIRECTION).toBe('wxrd:page-turn-direction');
    expect(Events.DOUBLE_COLUMN_CHANGED).toBe('wxrd:double-column-changed');
    expect(Events.SETTINGS_UPDATED).toBe('settings-updated');
    expect(Events.TAURI_WINDOW_EVENT).toBe('tauri://window-event');
  });

  it('should have consistent event naming', () => {
    const eventNames = Object.values(Events);

    // 所有事件名应该包含分隔符 (避免意外冲突)
    eventNames.forEach(name => {
      expect(name).toMatch(/[:-]/);
    });
  });
});

describe('EventBus - Integration Scenarios', () => {
  beforeEach(() => {
    EventBus['listeners'].clear();
    EventBus['eventHistory'].clear();
  });

  it('should support publish-subscribe pattern', () => {
    const subscriber1Data: any[] = [];
    const subscriber2Data: any[] = [];

    const unsubscribe1 = EventBus.on('news', (data) => subscriber1Data.push(data));
    const unsubscribe2 = EventBus.on('news', (data) => subscriber2Data.push(data));

    EventBus.emit('news', { headline: 'Breaking 1' });
    EventBus.emit('news', { headline: 'Breaking 2' });

    expect(subscriber1Data).toHaveLength(2);
    expect(subscriber2Data).toHaveLength(2);

    unsubscribe1();

    EventBus.emit('news', { headline: 'Breaking 3' });

    expect(subscriber1Data).toHaveLength(2); // 不再接收
    expect(subscriber2Data).toHaveLength(3); // 继续接收
  });

  it('should support event chaining', () => {
    const results: string[] = [];

    EventBus.on('step1', () => {
      results.push('step1');
      EventBus.emit('step2');
    });

    EventBus.on('step2', () => {
      results.push('step2');
      EventBus.emit('step3');
    });

    EventBus.on('step3', () => {
      results.push('step3');
    });

    EventBus.emit('step1');

    expect(results).toEqual(['step1', 'step2', 'step3']);
  });

  it('should handle emit during listener iteration', () => {
    const results: string[] = [];

    EventBus.on('test', () => {
      results.push('a');
      EventBus.emit('test'); // 递归触发
      results.push('b');
    });

    EventBus.on('test', () => {
      results.push('c');
    });

    EventBus.emit('test');

    // 由于复制了监听器数组,新的 emit 会在下一次迭代中触发
    // 第一次 emit: a, c
    // 递归 emit: a, c
    // 所以 a 的回调会执行两次
    expect(results).toContain('a');
    expect(results).toContain('b');
    expect(results).toContain('c');
  });
});
