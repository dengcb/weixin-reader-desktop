import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { settingsStore, type MergedSettings } from '../settings_store';
import { MenuManager } from '../../managers/menu_manager';
import { EventBus, Events } from '../event_bus';

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
    siteContext: {
      siteId,
      isReaderPage,
      currentRuntime: siteId === 'unknown' ? null : {
        manifest: {
          capabilities: {
            wideMode: true,
            hideToolbar: false,
            hideNavbar: true,
          },
        },
      },
    },
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

  it('keeps automatic flip settings global', () => {
    settingsStore.get = () => settings({
      autoFlip: { active: true, interval: 20, keepAwake: false },
    });
    const manager = createBareManager();

    (manager as any).handleMenuAction('auto_flip');
    expect(settingsStore.updateGlobal).toHaveBeenCalledWith({
      autoFlip: { active: false, interval: 20, keepAwake: false },
    });
  });

  it('refuses reader actions after leaving the reader route', () => {
    settingsStore.get = () => settings({
      autoFlip: { active: false, interval: 15, keepAwake: true },
    });
    const manager = createBareManager('demo', false);

    (manager as any).handleMenuAction('auto_flip');
    (manager as any).handleMenuAction('reader_wide');

    expect(settingsStore.updateGlobal).not.toHaveBeenCalled();
    expect(settingsStore.updateSite).not.toHaveBeenCalled();
  });

  it('routes reading commands through the shared reader action channel', () => {
    const manager = createBareManager();
    const actions: string[] = [];
    const cancel = EventBus.on<{ action: string }>(
      Events.READER_COMMAND,
      payload => actions.push(payload.action),
    );

    for (const action of [
      'reader_prev_page',
      'reader_next_page',
      'reader_prev_chapter',
      'reader_next_chapter',
    ]) {
      (manager as any).handleMenuAction(action);
    }

    expect(actions).toEqual([
      'reader_prev_page',
      'reader_next_page',
      'reader_prev_chapter',
      'reader_next_chapter',
    ]);
    cancel();
  });

  it('opens the active runtime reading-style panel idempotently', () => {
    const manager = createBareManager();
    const openReadingStyle = mock(() => true);
    (manager as any).siteContext.currentRuntime.openReadingStyle = openReadingStyle;

    (manager as any).handleMenuAction('reader_style');

    expect(openReadingStyle).toHaveBeenCalledTimes(1);
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
      hideToolbar: false,
      hideNavbar: true,
      autoFlip: { active: true, interval: 15, keepAwake: true },
    }));

    const calls = invokeMock.mock.calls.map(([command, args]) => ({ command, args }));
    expect(calls.filter(call => call.command === 'set_menu_item_enabled')).toHaveLength(12);
    expect(calls).toContainEqual({
      command: 'update_menu_state',
      args: { id: 'reader_wide', state: true },
    });
    expect(calls).toContainEqual({
      command: 'update_menu_state',
      args: { id: 'auto_flip', state: true },
    });
  });

  it('reads active runtime capabilities only on reader pages', async () => {
    const invokeMock = mock(async (_command: string, _args?: Record<string, any>) => undefined);
    window.__TAURI__.core.invoke = invokeMock as any;
    const manager = createBareManager('demo', true);

    await (manager as any).updateMenuEnabledStatus('reader');
    let calls = invokeMock.mock.calls.map(([command, args]) => ({ command, args }));
    expect(calls.some(({ command }) => command === 'get_installed_plugins')).toBe(false);
    expect(calls).toContainEqual({
      command: 'set_menu_item_enabled',
      args: { id: 'reader_wide', enabled: true },
    });
    expect(calls).toContainEqual({
      command: 'set_menu_item_enabled',
      args: { id: 'hide_toolbar', enabled: false },
    });
    expect(calls).toContainEqual({
      command: 'set_menu_item_enabled',
      args: { id: 'hide_navbar', enabled: true },
    });

    invokeMock.mockClear();
    (manager as any).siteContext.isReaderPage = false;
    await (manager as any).updateMenuEnabledStatus('outside-reader');
    calls = invokeMock.mock.calls.map(([command, args]) => ({ command, args }));
    expect(calls.some(({ command }) => command === 'get_installed_plugins')).toBe(false);
    for (const id of ['reader_wide', 'hide_toolbar', 'hide_navbar', 'auto_flip', 'reader_prev_page', 'reader_next_page', 'reader_prev_chapter', 'reader_next_chapter', 'reader_style']) {
      expect(calls).toContainEqual({
        command: 'set_menu_item_enabled',
        args: { id, enabled: false },
      });
    }
  });

  it('leaves reader features disabled after a reader-to-home transition', async () => {
    const invokeMock = mock(async (_command: string, _args?: Record<string, any>) => undefined);
    window.__TAURI__.core.invoke = invokeMock as any;
    const manager = createBareManager('demo', true);

    await (manager as any).updateMenuEnabledStatus('reader');
    (manager as any).siteContext.isReaderPage = false;
    await (manager as any).updateMenuEnabledStatus('home');

    for (const id of ['reader_wide', 'hide_toolbar', 'hide_navbar', 'auto_flip', 'reader_prev_page', 'reader_next_page', 'reader_prev_chapter', 'reader_next_chapter', 'reader_style']) {
      const updates = invokeMock.mock.calls.filter(([command, args]) =>
        command === 'set_menu_item_enabled' && args?.id === id
      );
      expect(updates[updates.length - 1]?.[1]).toEqual({ id, enabled: false });
    }
  });

  it('updates the native title and is inert without Tauri', async () => {
    const invokeMock = window.__TAURI__.core.invoke as ReturnType<typeof mock>;
    const manager = createBareManager();
    await (manager as any).updateWindowTitle('第一章');
    expect(invokeMock).toHaveBeenCalledWith('set_title', { title: '第一章' });

    window.__TAURI__ = undefined as any;
    await expect((manager as any).updateMenuEnabledStatus()).resolves.toBeUndefined();
  });

  it('synchronizes the current document title after a cross-store page load', async () => {
    const invokeMock = window.__TAURI__.core.invoke as ReturnType<typeof mock>;
    const manager = createBareManager();
    document.title = '番茄小说';

    await (manager as any).syncCurrentDocumentTitle();

    expect(invokeMock).toHaveBeenCalledWith('set_title', { title: '番茄小说' });
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
