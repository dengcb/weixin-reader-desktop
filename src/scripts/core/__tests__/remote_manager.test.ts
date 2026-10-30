import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventBus } from '../event_bus';
import { settingsStore } from '../settings_store';
import { RemoteManager } from '../../managers/remote_manager';

const originals = {
  get: settingsStore.get,
  update: settingsStore.update,
  hadTauri: typeof (window as any).__TAURI__ !== 'undefined',
  tauri: (window as any).__TAURI__,
};

// invoke() 动态读 window.__TAURI__.core.invoke，mock 这个全局即可，
// 不需要碰 ES module 的只读导出。签名带 cmd/args 以便按命令返回不同值。
const tauriInvoke = mock(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined);
const installTauriMock = () => {
  (window as any).__TAURI__ = {
    core: { invoke: tauriInvoke },
    event: { listen: async () => () => {} },
  };
};
const uninstallTauriMock = () => {
  if (originals.hadTauri) (window as any).__TAURI__ = originals.tauri;
  else delete (window as any).__TAURI__;
};

const createManager = () => {
  const nextPage = mock(() => undefined);
  const prevPage = mock(() => undefined);
  const prevChapter = mock(() => true);
  const nextChapter = mock(() => true);
  const manager = Object.create(RemoteManager.prototype) as RemoteManager;
  Object.assign(manager as any, {
    siteContext: {
      isReaderPage: true,
      currentRuntime: { nextPage, prevPage, prevChapter, nextChapter },
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
  return { manager, nextPage, prevPage, prevChapter, nextChapter };
};

describe('RemoteManager keyboard contract', () => {
  beforeEach(() => {
    installTauriMock();
    tauriInvoke.mockClear();
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
    uninstallTauriMock();
    EventBus.clearHistory();
  });

  it('turns pages via the runtime without emitting a duplicate direction event', () => {
    const { manager, nextPage, prevPage } = createManager();

    const down = new KeyboardEvent('keydown', { code: 'PageDown', cancelable: true });
    window.dispatchEvent(down);
    const up = new KeyboardEvent('keydown', { code: 'PageUp', cancelable: true });
    window.dispatchEvent(up);

    expect(nextPage).toHaveBeenCalledTimes(1);
    expect(prevPage).toHaveBeenCalledTimes(1);
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    // 方向记录由 ProgressTracker 承担，遥控管理器不再发 PAGE_TURN_DIRECTION
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

  it('maps Enter to fullscreen toggle, Home and the menu key to setting fields', () => {
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

    expect(tauriInvoke).toHaveBeenCalledWith('simulate_menu_click', { action: 'toggle_fullscreen' });
    expect(settingsStore.update).toHaveBeenCalledWith({ hideNavbar: true });
    expect(settingsStore.update).toHaveBeenCalledWith({ hideToolbar: true });
    expect(settingsStore.update).toHaveBeenCalledTimes(2);
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

  it('does not recursively consume chapter keys emitted by the runtime bridge', () => {
    const { manager, prevChapter, nextChapter } = createManager();
    for (const code of ['ArrowUp', 'ArrowDown']) {
      const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
      Object.defineProperty(event, '__atreaderMenuChapterNavigation', { value: true });
      document.dispatchEvent(event);
    }

    expect(prevChapter).not.toHaveBeenCalled();
    expect(nextChapter).not.toHaveBeenCalled();
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

describe('RemoteManager HID button contract', () => {
  let hidListeners: Map<string, (event: { payload: any }) => void>;

  const emitHid = (button: string, phase: string) => {
    hidListeners.get('remote-hid-button')?.({
      payload: { button, phase, usage: 0 },
    });
  };

  beforeEach(() => {
    hidListeners = new Map();
    (window as any).__TAURI__ = {
      core: { invoke: tauriInvoke },
      event: {
        listen: async (event: string, handler: (event: { payload: any }) => void) => {
          hidListeners.set(event, handler);
          return () => {
            hidListeners.delete(event);
          };
        },
      },
    };
    tauriInvoke.mockClear();
    tauriInvoke.mockImplementation(async () => undefined);
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
    uninstallTauriMock();
    EventBus.clearHistory();
  });

  it('音量键仅阅读页翻页：Vol+ 上一页，Vol- 下一页', () => {
    const { manager, nextPage, prevPage } = createManager();
    emitHid('volume_up', 'press');
    emitHid('volume_down', 'press');
    expect(prevPage).toHaveBeenCalledTimes(1);
    expect(nextPage).toHaveBeenCalledTimes(1);

    (manager as any).siteContext.isReaderPage = false;
    emitHid('volume_up', 'press');
    expect(prevPage).toHaveBeenCalledTimes(1);
    manager.destroy();
  });

  it('电源键在任意页面触发摸鱼键', () => {
    const { manager } = createManager();
    (manager as any).siteContext.isReaderPage = false;
    emitHid('power', 'press');
    expect(tauriInvoke).toHaveBeenCalledWith('toggle_stealth', undefined);
    manager.destroy();
  });

  it('TV 键走菜单动作切换宽屏', () => {
    const { manager } = createManager();
    emitHid('tv', 'press');
    expect(tauriInvoke).toHaveBeenCalledWith('simulate_menu_click', { action: 'reader_wide' });
    manager.destroy();
  });

  it('返回键循环切换到下一个书城', async () => {
    tauriInvoke.mockImplementation(async (cmd: string) =>
      cmd === 'get_bookstore_list'
        ? [
            { index: 1, current: true },
            { index: 2, current: false },
          ]
        : undefined,
    );
    const { manager } = createManager();
    emitHid('back', 'press');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tauriInvoke).toHaveBeenCalledWith('switch_bookstore_by_index', { index: 2 });
    manager.destroy();
  });

  it('只有一个书城时返回键不切换', async () => {
    tauriInvoke.mockImplementation(async (cmd: string) =>
      cmd === 'get_bookstore_list' ? [{ index: 1, current: true }] : undefined,
    );
    const { manager } = createManager();
    emitHid('back', 'press');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tauriInvoke).not.toHaveBeenCalledWith('switch_bookstore_by_index', expect.anything());
    manager.destroy();
  });

  it('release 与未绑定按键不触发任何动作', () => {
    const { manager, nextPage, prevPage } = createManager();
    emitHid('volume_up', 'release');
    emitHid('power', 'release');
    emitHid('voice', 'press');
    emitHid('usage_0x99', 'press');
    expect(nextPage).not.toHaveBeenCalled();
    expect(prevPage).not.toHaveBeenCalled();
    expect(tauriInvoke).not.toHaveBeenCalledWith('toggle_stealth', undefined);
    expect(tauriInvoke).not.toHaveBeenCalledWith('simulate_menu_click', expect.anything());
    expect(tauriInvoke).not.toHaveBeenCalledWith('switch_bookstore_by_index', expect.anything());
    manager.destroy();
  });

  it('destroy 后取消 HID 订阅', async () => {
    const { manager, nextPage } = createManager();
    manager.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hidListeners.has('remote-hid-button')).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'PageDown' }));
    expect(nextPage).not.toHaveBeenCalled();
  });
});
