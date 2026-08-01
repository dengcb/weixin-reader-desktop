import { afterEach, describe, expect, it } from 'bun:test';
import { BaseManager, Events } from '../base_manager';
import { EventBus } from '../event_bus';

class TestManager extends BaseManager {
  subscribe(callback: (value: number) => void): () => void {
    return this.on<number>(Events.PROGRESS_UPDATED, callback);
  }

  subscribeOnce(callback: (value: number) => void): () => void {
    return this.once<number>(Events.PROGRESS_UPDATED, callback);
  }

  subscribeWithHistory(callback: (value: number) => void): () => void {
    return this.onWithHistory<number>(Events.PROGRESS_UPDATED, callback);
  }

  publish(value: number): void {
    this.emit(Events.PROGRESS_UPDATED, value);
  }
}

afterEach(() => {
  EventBus.clearHistory();
});

describe('BaseManager lifecycle', () => {
  it('assigns stable unique module IDs', () => {
    const first = new TestManager();
    const second = new TestManager();
    expect(first.moduleId).toStartWith('TestManager_');
    expect(second.moduleId).toStartWith('TestManager_');
    expect(first.moduleId).not.toBe(second.moduleId);
    first.destroy();
    second.destroy();
  });

  it('cleans normal and once listeners on destroy', () => {
    const manager = new TestManager();
    const values: number[] = [];
    manager.subscribe(value => values.push(value));
    manager.subscribeOnce(value => values.push(value * 10));

    manager.publish(1);
    manager.publish(2);
    expect(values).toEqual([1, 10, 2]);

    manager.destroy();
    EventBus.emit(Events.PROGRESS_UPDATED, 3);
    expect(values).toEqual([1, 10, 2]);
    expect(manager.isDestroyed()).toBe(true);
  });

  it('replays state history and refuses new work after destruction', () => {
    EventBus.emit(Events.PROGRESS_UPDATED, 7);
    const manager = new TestManager();
    const values: number[] = [];
    manager.subscribeWithHistory(value => values.push(value));
    expect(values).toEqual([7]);

    manager.destroy();
    const cancel = manager.subscribe(value => values.push(value));
    manager.publish(8);
    expect(cancel()).toBeUndefined();
    expect(values).toEqual([7]);
  });

  it('is safe to destroy repeatedly without retaining listeners', () => {
    const manager = new TestManager();
    manager.subscribe(() => undefined);
    const before = EventBus.getListenerCount();
    expect(before).toBeGreaterThan(0);

    manager.destroy();
    manager.destroy();
    expect(EventBus.getListenerCount()).toBe(before - 1);
  });
});
