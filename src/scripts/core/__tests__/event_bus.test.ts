import { beforeEach, describe, expect, it } from 'bun:test';
import { EventBus, Events } from '../event_bus';

beforeEach(() => {
  EventBus['listeners'].clear();
  EventBus.clearHistory();
  EventBus.clearModuleContext();
});

describe('EventBus', () => {
  it('subscribes, deduplicates, and unsubscribes callbacks', () => {
    const values: number[] = [];
    const callback = (value: number) => values.push(value);
    const unsubscribe = EventBus.on('demo', callback);
    EventBus.on('demo', callback);
    EventBus.emit('demo', 1);
    unsubscribe();
    EventBus.emit('demo', 2);
    expect(values).toEqual([1]);
  });

  it('removes once listeners before invoking a callback that throws', () => {
    let calls = 0;
    EventBus.once('demo', () => {
      calls++;
      throw new Error('expected');
    });
    EventBus.emit('demo');
    EventBus.emit('demo');
    expect(calls).toBe(1);
    expect(EventBus.getListenerCount()).toBe(0);
  });

  it('replays finite history for state events', () => {
    for (let index = 0; index < 15; index++) {
      EventBus.emit(Events.ROUTE_CHANGED, { index });
    }
    const replayed: Array<{ index: number }> = [];
    EventBus.onWithHistory(Events.ROUTE_CHANGED, (value) => replayed.push(value as { index: number }));
    expect(replayed[replayed.length - 1]).toEqual({ index: 14 });
    expect(EventBus.getEventHistory(Events.ROUTE_CHANGED)).toHaveLength(10);
  });

  it('does not retain transient page-turn history', () => {
    EventBus.emit(Events.PAGE_TURN_DIRECTION, { direction: 'forward' });
    expect(EventBus.getLatestEvent(Events.PAGE_TURN_DIRECTION)).toBeNull();
  });

  it('once with history is not registered again even if replay throws', () => {
    EventBus.emit(Events.ROUTE_CHANGED, { isReader: true });
    let calls = 0;
    EventBus.onWithHistory(Events.ROUTE_CHANGED, () => {
      calls++;
      throw new Error('expected');
    }, { once: true });
    EventBus.emit(Events.ROUTE_CHANGED, { isReader: false });
    expect(calls).toBe(1);
  });

  it('cleans listeners associated with a module context', () => {
    EventBus.setModuleContext('demo-module');
    EventBus.on('a', () => undefined);
    EventBus.on('b', () => undefined);
    EventBus.clearModuleContext();
    EventBus.cleanup('demo-module');
    expect(EventBus.getListenerCount()).toBe(0);
  });

  it('supports AbortSignal cleanup', () => {
    const controller = new AbortController();
    EventBus.on('demo', () => undefined, { signal: controller.signal });
    controller.abort();
    expect(EventBus.getListenerCount()).toBe(0);
  });

  it('does not register an already-aborted subscription', () => {
    const controller = new AbortController();
    controller.abort();
    const cancel = EventBus.on('demo', () => undefined, { signal: controller.signal });
    expect(EventBus.getListenerCount()).toBe(0);
    expect(cancel()).toBeUndefined();
  });

  it('reports listener statistics and removes empty event groups', () => {
    const first = () => undefined;
    const second = () => undefined;
    EventBus.on('first', first);
    EventBus.on('second', second);
    expect(EventBus.getStats()).toEqual({ first: 1, second: 1 });
    EventBus.off('first', first);
    expect(EventBus.getStats()).toEqual({ second: 1 });
    EventBus.off('second', second);
  });

  it('lists and selectively clears state history by event or prefix', () => {
    EventBus.emit(Events.ROUTE_CHANGED, { route: 1 });
    EventBus.emit(Events.TITLE_CHANGED, { title: 'Chapter' });
    EventBus.emit(Events.SETTINGS_UPDATED, { version: 2 });
    expect(EventBus.getKnownEvents().sort()).toEqual([
      Events.ROUTE_CHANGED,
      Events.SETTINGS_UPDATED,
      Events.TITLE_CHANGED,
    ].sort());

    EventBus.clearHistoryByPrefix('ipc:');
    expect(EventBus.getKnownEvents()).toEqual([Events.SETTINGS_UPDATED]);
    EventBus.clearHistory(Events.SETTINGS_UPDATED);
    expect(EventBus.getKnownEvents()).toEqual([]);
  });
});
