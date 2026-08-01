import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { settingsStore, type MergedSettings } from '../settings_store';
import { TurnerManager } from '../../managers/turner_manager';

const originals = {
  get: settingsStore.get,
  subscribe: settingsStore.subscribe,
  updateGlobal: settingsStore.updateGlobal,
};

const settings = (partial: Partial<MergedSettings> = {}): MergedSettings => ({
  schemaVersion: 2,
  _version: 0,
  global: {},
  sites: {},
  pluginConfigs: {},
  hideNavbar: false,
  hideCursor: false,
  autoFlip: { active: false, interval: 15, keepAwake: true },
  ...partial,
});

const createBareManager = () => {
  let doubleColumn = true;
  const unsubscribeDouble = mock(() => undefined);
  const manager = Object.create(TurnerManager.prototype) as TurnerManager;
  const children = {
    cursorHider: {
      setEnabled: mock(() => undefined),
      destroy: mock(() => undefined),
    },
    swipeHandler: { destroy: mock(() => undefined) },
    autoFlipper: {
      updateState: mock(() => undefined),
      stopAll: mock(() => undefined),
    },
    progressBar: {
      setVisibility: mock(() => undefined),
      destroy: mock(() => undefined),
    },
  };
  Object.assign(manager as any, {
    ...children,
    siteContext: {
      get isDoubleColumn() { return doubleColumn; },
      onDoubleColumnChange: (listener: () => void) => {
        listener();
        return unsubscribeDouble;
      },
    },
    routeChangedHandler: null,
    unsubscribeSettings: null,
    unsubscribeDoubleColumn: null,
  });
  return {
    manager,
    children,
    unsubscribeDouble,
    setDoubleColumn: (value: boolean) => { doubleColumn = value; },
  };
};

describe('TurnerManager coordination', () => {
  beforeEach(() => {
    settingsStore.get = () => settings();
    settingsStore.subscribe = () => () => undefined;
    settingsStore.updateGlobal = mock(async () => undefined);
  });

  afterEach(() => {
    settingsStore.get = originals.get;
    settingsStore.subscribe = originals.subscribe;
    settingsStore.updateGlobal = originals.updateGlobal;
  });

  it('forwards settings and shows progress only for hidden-navbar double-column mode', () => {
    const { manager, children, setDoubleColumn } = createBareManager();
    settingsStore.get = () => settings({ hideNavbar: true, hideCursor: true });
    (manager as any).updateState(settings({ hideNavbar: true, hideCursor: true }));
    expect(children.autoFlipper.updateState).toHaveBeenCalledTimes(1);
    expect(children.cursorHider.setEnabled).toHaveBeenCalledWith(true);
    expect(children.progressBar.setVisibility).toHaveBeenLastCalledWith(true);

    setDoubleColumn(false);
    (manager as any).updateProgressBarVisibility();
    expect(children.progressBar.setVisibility).toHaveBeenLastCalledWith(false);

    setDoubleColumn(true);
    settingsStore.get = () => settings({ hideNavbar: false });
    (manager as any).updateProgressBarVisibility();
    expect(children.progressBar.setVisibility).toHaveBeenLastCalledWith(false);
  });

  it('stops automatic flipping and persists inactive state when leaving a reader', () => {
    const { manager, children } = createBareManager();
    const unsubscribeSettings = mock(() => undefined);
    settingsStore.subscribe = () => unsubscribeSettings;
    settingsStore.get = () => settings({
      autoFlip: { active: true, interval: 25, keepAwake: false },
    });
    (manager as any).init();

    window.dispatchEvent(new CustomEvent('ipc:route-changed', {
      detail: { isReader: false, url: 'https://example.com/', pathname: '/' },
    }));
    expect(children.autoFlipper.stopAll).toHaveBeenCalledTimes(1);
    expect(settingsStore.updateGlobal).toHaveBeenCalledWith({
      autoFlip: { active: false, interval: 25, keepAwake: false },
    });

    manager.destroy();
    expect(unsubscribeSettings).toHaveBeenCalledTimes(1);
  });

  it('destroys every child and both subscriptions', () => {
    const { manager, children, unsubscribeDouble } = createBareManager();
    const unsubscribeSettings = mock(() => undefined);
    Object.assign(manager as any, {
      unsubscribeSettings,
      unsubscribeDoubleColumn: unsubscribeDouble,
    });
    manager.destroy();

    expect(children.cursorHider.destroy).toHaveBeenCalledTimes(1);
    expect(children.swipeHandler.destroy).toHaveBeenCalledTimes(1);
    expect(children.autoFlipper.stopAll).toHaveBeenCalledTimes(1);
    expect(children.progressBar.destroy).toHaveBeenCalledTimes(1);
    expect(unsubscribeSettings).toHaveBeenCalledTimes(1);
    expect(unsubscribeDouble).toHaveBeenCalledTimes(1);
  });
});
