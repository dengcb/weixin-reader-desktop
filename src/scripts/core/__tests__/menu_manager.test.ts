import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { settingsStore, type MergedSettings } from '../settings_store';
import { MenuManager } from '../../managers/menu_manager';

const originalTauri = window.__TAURI__;
const originals = {
  get: settingsStore.get,
  update: settingsStore.update,
  updateSite: settingsStore.updateSite,
  updateGlobal: settingsStore.updateGlobal,
};

const settings = (partial: Partial<MergedSettings> = {}): MergedSettings => ({
  schemaVersion: 2,
  _version: 0,
  global: {},
  sites: {},
  pluginConfigs: {},
  ...partial,
});

const createBareManager = (siteId = 'demo', isReaderPage = true): MenuManager => {
  const manager = Object.create(MenuManager.prototype) as MenuManager;
  Object.assign(manager as any, {
    initialized: true,
    siteContext: { siteId, isReaderPage },
    destroyed: false,
    initAbortController: new AbortController(),
    routeChangedHandler: null,
    legacyRouteChangedHandler: null,
    titleChangedHandler: null,
    unlistenMenuAction: null,
    unlistenShowToast: null,
    unlistenMenuRebuilt: null,
    unsubscribeSettings: null,
    unsubscribeDoubleColumn: null,
  });
  return manager;
};

describe('MenuManager behavior', () => {
  beforeEach(() => {
    settingsStore.update = mock(async () => undefined);
    settingsStore.updateSite = mock(async () => undefined);
    settingsStore.updateGlobal = mock(async () => undefined);
    window.__TAURI__ = {
      core: { invoke: mock(async () => undefined) },
      event: { listen: async () => () => undefined },
    } as any;
  });

  afterEach(() => {
    settingsStore.get = originals.get;
    settingsStore.update = originals.update;
    settingsStore.updateSite = originals.updateSite;
    settingsStore.updateGlobal = originals.updateGlobal;
    window.__TAURI__ = originalTauri;
  });

  it('routes site display actions to the active site', () => {
    settingsStore.get = () => settings({
      readerWide: true,
      hideToolbar: true,
      hideNavbar: false,
    });
    const manager = createBareManager();

    (manager as any).handleMenuAction('reader_wide');
    expect(settingsStore.updateSite).toHaveBeenCalledWith('demo', {
      readerWide: false,
      hideToolbar: false,
    });

    (manager as any).handleMenuAction('hide_toolbar');
    (manager as any).handleMenuAction('hide_navbar');
    expect(settingsStore.updateSite).toHaveBeenCalledWith('demo', { hideToolbar: false });
    expect(settingsStore.updateSite).toHaveBeenCalledWith('demo', { hideNavbar: true });
  });

  it('keeps cursor and automatic flip settings global', () => {
    settingsStore.get = () => settings({
      hideCursor: false,
      autoFlip: { active: true, interval: 20, keepAwake: false },
    });
    const manager = createBareManager();

    (manager as any).handleMenuAction('hide_cursor');
    (manager as any).handleMenuAction('auto_flip');
    expect(settingsStore.updateGlobal).toHaveBeenCalledWith({ hideCursor: true });
    expect(settingsStore.updateGlobal).toHaveBeenCalledWith({
      autoFlip: { active: false, interval: 20, keepAwake: false },
    });
  });

  it('uses the compatibility update path only when no site runtime exists', () => {
    settingsStore.get = () => settings({ hideToolbar: false });
    const manager = createBareManager('unknown');
    (manager as any).handleMenuAction('hide_toolbar');

    expect(settingsStore.update).toHaveBeenCalledWith({ hideToolbar: true });
    expect(settingsStore.updateSite).not.toHaveBeenCalled();
  });

  it('synchronizes enabled states and checkmarks through IPC', async () => {
    const invokeMock = window.__TAURI__.core.invoke as ReturnType<typeof mock>;
    const manager = createBareManager('demo', true);

    await (manager as any).syncMenuState(settings({
      readerWide: true,
      hideCursor: true,
      hideToolbar: false,
      hideNavbar: true,
      autoFlip: { active: true, interval: 15, keepAwake: true },
    }));

    const calls = invokeMock.mock.calls.map(([command, args]) => ({ command, args }));
    expect(calls.filter(call => call.command === 'set_menu_item_enabled')).toHaveLength(8);
    expect(calls).toContainEqual({
      command: 'update_menu_state',
      args: { id: 'reader_wide', state: true },
    });
    expect(calls).toContainEqual({
      command: 'update_menu_state',
      args: { id: 'auto_flip', state: true },
    });
  });

  it('updates the native title and is inert without Tauri', async () => {
    const invokeMock = window.__TAURI__.core.invoke as ReturnType<typeof mock>;
    const manager = createBareManager();
    await (manager as any).updateWindowTitle('第一章');
    expect(invokeMock).toHaveBeenCalledWith('set_title', { title: '第一章' });

    window.__TAURI__ = undefined as any;
    await expect((manager as any).updateMenuEnabledStatus()).resolves.toBeUndefined();
  });

  it('releases every registered cancellation exactly once', () => {
    const manager = createBareManager();
    const cancellations = Array.from({ length: 5 }, () => mock(() => undefined));
    Object.assign(manager as any, {
      unlistenMenuAction: cancellations[0],
      unlistenShowToast: cancellations[1],
      unlistenMenuRebuilt: cancellations[2],
      unsubscribeSettings: cancellations[3],
      unsubscribeDoubleColumn: cancellations[4],
    });

    manager.destroy();
    manager.destroy();
    for (const cancel of cancellations) expect(cancel).toHaveBeenCalledTimes(1);
    expect((manager as any).initAbortController.signal.aborted).toBe(true);
  });
});
