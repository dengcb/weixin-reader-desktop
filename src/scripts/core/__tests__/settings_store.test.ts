import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SettingsStore, type AppSettings } from '../settings_store';

const createDocument = (): AppSettings => ({
  schemaVersion: 2,
  _version: 0,
  global: {
    autoUpdate: true,
    lastPage: true,
    autoFlip: { active: false, interval: 15, keepAwake: true },
  },
  sites: { unknown: { readerWide: false } },
  pluginConfigs: { preserved: { value: 1 } },
});

let backend: AppSettings;
let conflictsRemaining = 0;
let failWrite = false;
let inFlight = 0;
let maxInFlight = 0;
const listeners = new Set<(event: { payload: AppSettings }) => void>();

const mergePatch = (patch: any): void => {
  backend = {
    ...backend,
    global: { ...backend.global, ...patch.global },
    sites: { ...backend.sites },
    pluginConfigs: { ...backend.pluginConfigs },
  };
  for (const [id, value] of Object.entries(patch.sites ?? {})) {
    backend.sites[id] = { ...backend.sites[id], ...(value as object) };
  }
  for (const [id, value] of Object.entries(patch.pluginConfigs ?? {})) {
    backend.pluginConfigs[id] = { ...backend.pluginConfigs[id], ...(value as object) };
  }
};

describe('SettingsStore', () => {
  let store: SettingsStore;

  beforeEach(async () => {
    backend = createDocument();
    conflictsRemaining = 0;
    failWrite = false;
    inFlight = 0;
    maxInFlight = 0;
    listeners.clear();
    (SettingsStore as any).instance = undefined;
    window.__TAURI__ = {
      core: {
        invoke: async (command: string, args?: Record<string, any>) => {
          if (command === 'get_settings') return structuredClone(backend);
          if (command !== 'patch_settings') throw new Error(`Unexpected command: ${command}`);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          try {
            if (failWrite) throw new Error('disk full');
            if (conflictsRemaining > 0) {
              conflictsRemaining--;
              backend = { ...backend, _version: backend._version + 1 };
              return { status: 'conflict', latest: structuredClone(backend) };
            }
            if (args?.expectedVersion !== backend._version) {
              return { status: 'conflict', latest: structuredClone(backend) };
            }
            mergePatch(args.patch);
            backend._version++;
            const snapshot = structuredClone(backend);
            for (const listener of listeners) listener({ payload: snapshot });
            return { status: 'applied', settings: snapshot };
          } finally {
            inFlight--;
          }
        },
      },
      event: {
        listen: async (_event: string, handler: (event: { payload: AppSettings }) => void) => {
          listeners.add(handler);
          return () => listeners.delete(handler);
        },
      },
      webviewWindow: { WebviewWindow: class {} },
    } as any;
    store = SettingsStore.getInstance();
    await store.init();
  });

  afterEach(() => {
    store.destroy();
    (SettingsStore as any).instance = undefined;
  });

  it('loads schema v2 and exposes the current site merged view', () => {
    expect(store.get().schemaVersion).toBe(2);
    expect(store.get().readerWide).toBe(false);
    expect(store.getPluginConfig('preserved')).toEqual({ value: 1 });
  });

  it('patches settings without deleting plugin configs', async () => {
    await store.updateGlobal({ hideCursor: true });
    expect(backend.global.hideCursor).toBe(true);
    expect(backend.pluginConfigs.preserved).toEqual({ value: 1 });
    expect(store.get()._version).toBe(1);
  });

  it('serializes frontend writes', async () => {
    await Promise.all([
      store.updateGlobal({ hideCursor: true }),
      store.updateSite('unknown', { readerWide: true }),
    ]);
    expect(maxInFlight).toBe(1);
    expect(backend.global.hideCursor).toBe(true);
    expect(backend.sites.unknown.readerWide).toBe(true);
  });

  it('refreshes after a conflict and retries the original patch once', async () => {
    conflictsRemaining = 1;
    await store.updateSite('unknown', { hideToolbar: true });
    expect(backend._version).toBe(2);
    expect(backend.sites.unknown.hideToolbar).toBe(true);
  });

  it('keeps the newest backend snapshot after the single retry also conflicts', async () => {
    conflictsRemaining = 2;
    await expect(store.updateGlobal({ hideCursor: true })).rejects.toThrow(
      'Settings changed again while retrying patch',
    );
    expect(backend._version).toBe(2);
    expect(store.get()._version).toBe(2);
    expect(store.getGlobal().hideCursor).toBe(false);
  });

  it('rolls optimistic state back when persistence fails', async () => {
    failWrite = true;
    await expect(store.updateGlobal({ hideCursor: true })).rejects.toThrow('disk full');
    expect(store.getGlobal().hideCursor).toBe(false);
  });

  it('stores plugin custom fields separately from site display settings', async () => {
    await store.updatePluginConfig('fanqie', { custom: 42 });
    await store.updateSite('fanqie', { readerWide: true });
    expect(backend.pluginConfigs.fanqie).toEqual({ custom: 42 });
    expect(backend.sites.fanqie).toEqual({ readerWide: true });
  });

  it('cancels a late settings listener and can initialize again after destruction', async () => {
    store.destroy();
    listeners.clear();
    (SettingsStore as any).instance = undefined;

    let resolveListen: ((unlisten: () => void) => void) | null = null;
    let lateUnlistenCalls = 0;
    window.__TAURI__.event.listen = async () => new Promise<() => void>((resolve) => {
      resolveListen = resolve;
    });

    store = SettingsStore.getInstance();
    const pendingInitialization = store.init();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(resolveListen).not.toBeNull();
    store.destroy();
    resolveListen!(() => { lateUnlistenCalls++; });
    await pendingInitialization;

    expect(lateUnlistenCalls).toBe(1);
    expect((store as any).initialized).toBe(false);

    window.__TAURI__.event.listen = async (_event, handler) => {
      listeners.add(handler as (event: { payload: AppSettings }) => void);
      return () => listeners.delete(handler as (event: { payload: AppSettings }) => void);
    };
    await store.init();
    expect((store as any).initialized).toBe(true);
    expect(listeners.size).toBe(1);
  });

  it('normalizes missing backend sections to safe schema-v2 defaults', async () => {
    store.destroy();
    (SettingsStore as any).instance = undefined;
    backend = {
      schemaVersion: 2,
      _version: 4,
      global: { autoUpdate: false },
    } as AppSettings;

    store = SettingsStore.getInstance();
    await store.init();
    expect(store.get()._version).toBe(4);
    expect(store.getGlobal()).toMatchObject({
      autoUpdate: false,
      lastPage: true,
      rememberSite: true,
    });
    expect(store.getSite('missing')).toEqual({});
    expect(store.getPluginConfig('missing')).toEqual({});
  });

  it('applies only newer settings events and notifies subscribers', () => {
    const snapshots: number[] = [];
    const unsubscribe = store.subscribe(settings => snapshots.push(settings._version));
    expect(snapshots).toEqual([0]);

    const handler = [...listeners][0];
    handler({ payload: { ...createDocument(), _version: 0 } });
    handler({ payload: {
      ...createDocument(),
      _version: 2,
      global: { ...createDocument().global, hideCursor: true },
    } });

    expect(snapshots).toEqual([0, 2]);
    expect(store.getGlobal().hideCursor).toBe(true);
    unsubscribe();
  });

  it('routes mixed compatibility updates by field ownership', async () => {
    await store.update({
      hideCursor: true,
      readerWide: true,
      global: { autoUpdate: false },
      sites: { another: { hideNavbar: true } },
      pluginConfigs: { demo: { custom: 'value' } },
    });

    expect(backend.global).toMatchObject({ hideCursor: true, autoUpdate: false });
    expect(backend.sites.unknown.readerWide).toBe(true);
    expect(backend.sites.another.hideNavbar).toBe(true);
    expect(backend.pluginConfigs.demo).toEqual({ custom: 'value' });
  });

  it('isolates listener failures so later listeners still run', async () => {
    let healthyCalls = 0;
    store.subscribe(() => {
      throw new Error('expected listener failure');
    });
    store.subscribe(() => {
      healthyCalls++;
    });

    await store.updateGlobal({ hideCursor: true });
    expect(healthyCalls).toBeGreaterThanOrEqual(2);
  });

  it('treats a missing enabled list as all enabled and can materialize it on disable', async () => {
    expect(store.isPluginEnabled('demo')).toBe(true);
    expect(store.getEnabledPlugins()).toBeUndefined();

    await store.enablePlugin('demo');
    expect(backend.global.enabledPlugins).toBeUndefined();

    await store.disablePlugin('demo', ['demo', 'other']);
    expect(backend.global.enabledPlugins).toEqual(['other']);
    expect(store.isPluginEnabled('demo')).toBe(false);
    expect(store.isPluginEnabled('other')).toBe(true);
  });

  it('does not duplicate an already enabled plugin', async () => {
    await store.updateGlobal({ enabledPlugins: ['demo'] });
    const versionBefore = backend._version;
    await store.enablePlugin('demo');
    expect(backend._version).toBe(versionBefore);
    expect(backend.global.enabledPlugins).toEqual(['demo']);
  });

  it('refreshes from the repository after queued writes settle', async () => {
    await store.updateGlobal({ hideCursor: true });
    backend = {
      ...backend,
      _version: backend._version + 1,
      global: { ...backend.global, autoUpdate: false },
    };
    await store.refresh();
    expect(store.getGlobal().hideCursor).toBe(true);
    expect(store.getGlobal().autoUpdate).toBe(false);
    expect(store.get()._version).toBe(2);
  });
});
