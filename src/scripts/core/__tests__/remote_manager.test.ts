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
    keyupHandler: null,
    contextMenuHandler: null,
    menuKeyDebouncing: false,
    menuDebounceTimer: null,
    lastMenuKeyAt: 0,
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
    const leakedMenuKeys: KeyboardEvent[] = [];
    const siteKeyListener = (event: KeyboardEvent) => leakedMenuKeys.push(event);
    window.addEventListener('keydown', siteKeyListener);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Home', cancelable: true }));
    const menuKey = new KeyboardEvent('keydown', {
      code: 'Unidentified',
      keyCode: 0,
      cancelable: true,
    });
    window.dispatchEvent(menuKey);
    const repeatedMenuKey = new KeyboardEvent('keydown', {
      code: 'Unidentified',
      keyCode: 0,
      cancelable: true,
    });
    window.dispatchEvent(repeatedMenuKey);

    expect(settingsStore.update).toHaveBeenCalledWith({ readerWide: true });
    expect(settingsStore.update).toHaveBeenCalledWith({ hideNavbar: true });
    expect(settingsStore.update).toHaveBeenCalledWith({ hideToolbar: true });
    expect(settingsStore.update).toHaveBeenCalledTimes(3);
    expect(menuKey.defaultPrevented).toBe(true);
    expect(repeatedMenuKey.defaultPrevented).toBe(true);
    expect(leakedMenuKeys).toEqual([]);
    window.removeEventListener('keydown', siteKeyListener);
    manager.destroy();
  });

  it('suppresses only the context menu caused by a recent remote menu key', () => {
    const { manager } = createManager();
    const ordinaryContextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    document.body.dispatchEvent(ordinaryContextMenu);
    expect(ordinaryContextMenu.defaultPrevented).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'Unidentified',
      keyCode: 0,
      cancelable: true,
    }));
    let leakedContextMenus = 0;
    const siteContextMenuListener = () => { leakedContextMenus++; };
    window.addEventListener('contextmenu', siteContextMenuListener);
    const remoteContextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    document.body.dispatchEvent(remoteContextMenu);
    expect(remoteContextMenu.defaultPrevented).toBe(true);
    expect(leakedContextMenus).toBe(0);

    (manager as any).lastMenuKeyAt = Date.now() - 2000;
    const laterContextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    document.body.dispatchEvent(laterContextMenu);
    expect(laterContextMenu.defaultPrevented).toBe(false);
    expect(leakedContextMenus).toBe(1);
    window.removeEventListener('contextmenu', siteContextMenuListener);
    manager.destroy();
  });

  it('maps the real macOS Xiaomi menu sequence to one immediate toolbar toggle', () => {
    const { manager } = createManager();
    const contextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 0,
      detail: 0,
      clientX: 1,
      clientY: 1,
    });
    document.body.dispatchEvent(contextMenu);
    const keyup = new KeyboardEvent('keyup', {
      key: '\u0010',
      code: 'Unidentified',
      keyCode: 0,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(keyup);

    expect(settingsStore.update).toHaveBeenCalledTimes(1);
    expect(settingsStore.update).toHaveBeenCalledWith({ hideToolbar: true });
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(keyup.defaultPrevented).toBe(true);
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

    (manager as any).lastMenuKeyAt = Date.now();
    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
  });
});
