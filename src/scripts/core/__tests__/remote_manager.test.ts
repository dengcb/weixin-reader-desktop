import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventBus, Events } from '../event_bus';
import { settingsStore } from '../settings_store';
import { RemoteManager } from '../../managers/remote_manager';

const originals = {
  get: settingsStore.get,
  update: settingsStore.update,
};

const createManager = () => {
  const nextPage = mock(() => undefined);
  const prevPage = mock(() => undefined);
  const manager = Object.create(RemoteManager.prototype) as RemoteManager;
  Object.assign(manager as any, {
    siteContext: {
      isReaderPage: true,
      currentRuntime: { nextPage, prevPage },
    },
    enabled: true,
    keyboardHandler: null,
    menuKeyDebouncing: false,
    menuDebounceTimer: null,
    retryTimer: null,
    initializationGeneration: 0,
    unsubscribeSettings: null,
    routeChangedHandler: null,
    currentChapterIdx: -1,
  });
  (manager as any).setupKeyboardListener();
  return { manager, nextPage, prevPage };
};

describe('RemoteManager keyboard contract', () => {
  beforeEach(() => {
    settingsStore.get = () => ({
      schemaVersion: 2,
      _version: 0,
      global: {},
      sites: {},
      pluginConfigs: {},
      readerWide: false,
      hideNavbar: false,
      hideToolbar: false,
    });
    settingsStore.update = mock(async () => undefined);
    EventBus.clearHistory();
  });

  afterEach(() => {
    settingsStore.get = originals.get;
    settingsStore.update = originals.update;
    EventBus.clearHistory();
  });

  it('turns pages and emits direction before invoking the runtime', () => {
    const { manager, nextPage, prevPage } = createManager();
    const directions: string[] = [];
    const cancel = EventBus.on<{ direction: string }>(
      Events.PAGE_TURN_DIRECTION,
      event => directions.push(event.direction),
    );

    const down = new KeyboardEvent('keydown', { code: 'PageDown', cancelable: true });
    window.dispatchEvent(down);
    const up = new KeyboardEvent('keydown', { code: 'PageUp', cancelable: true });
    window.dispatchEvent(up);

    expect(directions).toEqual(['forward', 'backward']);
    expect(nextPage).toHaveBeenCalledTimes(1);
    expect(prevPage).toHaveBeenCalledTimes(1);
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    cancel();
    manager.destroy();
  });

  it('ignores editable targets and non-reader pages', () => {
    const { manager, nextPage } = createManager();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'PageDown',
      bubbles: true,
      cancelable: true,
    }));
    expect(nextPage).not.toHaveBeenCalled();

    (manager as any).siteContext.isReaderPage = false;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'PageDown' }));
    expect(nextPage).not.toHaveBeenCalled();
    manager.destroy();
    input.remove();
  });

  it('maps Enter, Home and the menu key to existing setting fields', () => {
    const { manager } = createManager();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Home', cancelable: true }));
    const menuKey = new KeyboardEvent('keydown', {
      code: 'Unidentified',
      keyCode: 0,
      cancelable: true,
    });
    window.dispatchEvent(menuKey);
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'Unidentified',
      keyCode: 0,
      cancelable: true,
    }));

    expect(settingsStore.update).toHaveBeenCalledWith({ readerWide: true });
    expect(settingsStore.update).toHaveBeenCalledWith({ hideNavbar: true });
    expect(settingsStore.update).toHaveBeenCalledWith({ hideToolbar: true });
    expect(settingsStore.update).toHaveBeenCalledTimes(3);
    expect(menuKey.defaultPrevented).toBe(true);
    manager.destroy();
  });

  it('consumes Numpad7 without changing state', () => {
    const { manager, nextPage, prevPage } = createManager();
    const event = new KeyboardEvent('keydown', { code: 'Numpad7', cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(nextPage).not.toHaveBeenCalled();
    expect(prevPage).not.toHaveBeenCalled();
    expect(settingsStore.update).not.toHaveBeenCalled();
    manager.destroy();
  });

  it('removes the capturing keyboard listener on destroy', () => {
    const { manager, nextPage } = createManager();
    manager.destroy();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'PageDown' }));
    expect(nextPage).not.toHaveBeenCalled();
  });
});
