import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { settingsStore, type MergedSettings } from '../settings_store';
import { AppManager } from '../../managers/app_manager';

const originals = {
  get: settingsStore.get,
  update: settingsStore.update,
  tauri: window.__TAURI__,
};

const settings = (partial: Partial<MergedSettings> = {}): MergedSettings => ({
  schemaVersion: 2,
  _version: 0,
  global: {},
  sites: {},
  pluginConfigs: {},
  lastPage: true,
  scrollPosition: 55,
  autoFlip: { active: false, interval: 15, keepAwake: true },
  ...partial,
});

const bareManager = (siteContext: Record<string, unknown>): AppManager => {
  const manager = Object.create(AppManager.prototype) as AppManager;
  Object.assign(manager as any, {
    siteContext,
    pagehideHandler: null,
    visibilitychangeHandler: null,
    restoreTimer: null,
    initAbortController: new AbortController(),
    destroyed: false,
  });
  return manager;
};

describe('AppManager persistence lifecycle', () => {
  let invokeMock: ReturnType<typeof mock>;

  beforeEach(() => {
    sessionStorage.clear();
    delete (window as any).__wxrd_scroll_restored;
    settingsStore.get = () => settings();
    settingsStore.update = mock(async () => undefined);
    invokeMock = mock(async () => null);
    window.__TAURI__ = {
      core: { invoke: invokeMock },
      event: { listen: async () => () => undefined },
    } as any;
  });

  afterEach(() => {
    settingsStore.get = originals.get;
    settingsStore.update = originals.update;
    window.__TAURI__ = originals.tauri;
    sessionStorage.clear();
    delete (window as any).__wxrd_scroll_restored;
  });

  it('clears active automatic flipping while preserving its other options', () => {
    settingsStore.get = () => settings({
      autoFlip: { active: true, interval: 28, keepAwake: false },
    });
    const manager = bareManager({});
    (manager as any).clearAutoFlipOnExit();

    expect(settingsStore.update).toHaveBeenCalledWith({
      autoFlip: { active: false, interval: 28, keepAwake: false },
    });
  });

  it('does not write when automatic flipping is already inactive', () => {
    const manager = bareManager({});
    (manager as any).clearAutoFlipOnExit();
    expect(settingsStore.update).not.toHaveBeenCalled();
  });

  it('marks restoration complete when the page should not restore scroll', async () => {
    const manager = bareManager({
      isReaderPage: false,
      isDoubleColumn: false,
      isPaginated: false,
      siteId: 'demo',
    });
    await (manager as any).restoreScrollPosition();

    expect(invokeMock).toHaveBeenCalledWith('get_reading_position', {
      siteId: 'demo',
      url: window.location.href,
    });
    expect((window as any).__wxrd_scroll_restored).toBe(true);
    expect((manager as any).restoreTimer).toBeNull();
  });

  it('skips scrolling in paginated mode even with a saved position', async () => {
    invokeMock.mockImplementation(async () => 500);
    const manager = bareManager({
      isReaderPage: true,
      isDoubleColumn: true,
      isPaginated: true,
      siteId: 'demo',
    });
    await (manager as any).restoreScrollPosition();

    expect((window as any).__wxrd_scroll_restored).toBe(true);
    expect((manager as any).restoreTimer).toBeNull();
  });

  it('also skips legacy scroll restoration for a single-column paginator', async () => {
    invokeMock.mockImplementation(async () => 500);
    const manager = bareManager({
      isReaderPage: true,
      isDoubleColumn: false,
      isPaginated: true,
      siteId: 'local',
    });
    await (manager as any).restoreScrollPosition();

    expect((window as any).__wxrd_scroll_restored).toBe(true);
    expect((manager as any).restoreTimer).toBeNull();
  });

  it('prefers URL-specific position and schedules the established single-column chase', async () => {
    invokeMock.mockImplementation(async () => 800);
    const manager = bareManager({
      isReaderPage: true,
      isDoubleColumn: false,
      isPaginated: false,
      siteId: 'demo',
    });
    await (manager as any).restoreScrollPosition();

    expect((manager as any).restoreTimer).not.toBeNull();
    expect((window as any).__wxrd_scroll_restored).toBeUndefined();
    manager.destroy();
    expect((manager as any).restoreTimer).toBeNull();
    expect((manager as any).initAbortController.signal.aborted).toBe(true);
  });

  it('falls back to the legacy position when the URL repository read fails', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('unavailable');
    });
    settingsStore.get = () => settings({ scrollPosition: 700 });
    const manager = bareManager({
      isReaderPage: true,
      isDoubleColumn: false,
      isPaginated: false,
      siteId: 'demo',
    });
    await (manager as any).restoreScrollPosition();

    expect((manager as any).restoreTimer).not.toBeNull();
    manager.destroy();
  });
});
