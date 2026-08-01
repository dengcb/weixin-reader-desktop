import { beforeEach, describe, expect, it } from 'bun:test';
import { EventBus } from '../event_bus';
import { PluginLoader } from '../plugin_loader';
import { PluginRegistry } from '../plugin_registry';
import type { PluginManifest, ReaderPlugin } from '../plugin_types';
import { settingsStore } from '../settings_store';

const manifest: PluginManifest = {
  id: 'lifecycle-plugin',
  name: 'Lifecycle Plugin',
  version: '1.0.0',
  sourceType: 'web',
  renderMode: 'webview',
  capabilities: {},
};

describe('plugin lifecycle cleanup', () => {
  beforeEach(() => {
    (PluginLoader as any).instance = undefined;
    (PluginRegistry as any).instance = undefined;
    EventBus['listeners'].clear();
    EventBus.clearHistory();
    document.getElementById('plugin-lifecycle-plugin-runtime')?.remove();
  });

  it('removes host-tracked styles and listeners after unload', async () => {
    let unloaded = 0;
    const plugin: ReaderPlugin = {
      manifest,
      onLoad: (api) => {
        api.style.inject('runtime', 'body{}');
        api.events.on('ping', () => undefined);
      },
      onUnload: () => { unloaded++; },
      matchesDomain: () => true,
      isReaderPage: () => true,
      isHomePage: () => false,
      nextPage: () => undefined,
      prevPage: () => undefined,
      getStyles: () => ({}),
    };
    const loader = PluginLoader.getInstance();
    const registry = PluginRegistry.getInstance();
    const previousEnabled = settingsStore.isPluginEnabled;
    settingsStore.isPluginEnabled = () => true;
    try {
      registry.register(plugin);
      await loader.loadPlugin(manifest.id);
      expect(document.getElementById('plugin-lifecycle-plugin-runtime')).not.toBeNull();
      expect(EventBus.getListenerCount()).toBe(1);
      await loader.unloadPlugin(manifest.id);
      expect(unloaded).toBe(1);
      expect(document.getElementById('plugin-lifecycle-plugin-runtime')).toBeNull();
      expect(EventBus.getListenerCount()).toBe(0);
    } finally {
      settingsStore.isPluginEnabled = previousEnabled;
      loader.destroy();
    }
  });

  it('rolls back resources when onLoad throws', async () => {
    const broken: ReaderPlugin = {
      manifest: { ...manifest, id: 'broken-lifecycle-plugin' },
      onLoad: (api) => {
        api.style.inject('partial', 'body{}');
        api.events.on('partial', () => undefined);
        throw new Error('load failed');
      },
      onUnload: () => undefined,
      matchesDomain: () => true,
      isReaderPage: () => true,
      isHomePage: () => false,
      nextPage: () => undefined,
      prevPage: () => undefined,
      getStyles: () => ({}),
    };
    const loader = PluginLoader.getInstance();
    const registry = PluginRegistry.getInstance();
    const previousEnabled = settingsStore.isPluginEnabled;
    settingsStore.isPluginEnabled = () => true;
    try {
      registry.register(broken);
      expect(await loader.loadPlugin(broken.manifest.id)).toBe(false);
      expect(document.getElementById('plugin-broken-lifecycle-plugin-partial')).toBeNull();
      expect(EventBus.getListenerCount()).toBe(0);
    } finally {
      settingsStore.isPluginEnabled = previousEnabled;
      loader.destroy();
    }
  });

  it('always revokes the dynamic module Blob URL', async () => {
    const loader = PluginLoader.getInstance();
    const originalRevoke = URL.revokeObjectURL;
    let revoked: string | null = null;
    URL.revokeObjectURL = (url: string) => {
      revoked = url;
      originalRevoke.call(URL, url);
    };
    try {
      const instance = await (loader as any).instantiateFromCode(`
        export default class RuntimePlugin {
          constructor() { this.manifest = { id: 'blob-runtime' }; }
        }
      `);
      expect(instance.manifest.id).toBe('blob-runtime');
      const revokedUrl: unknown = revoked;
      expect(typeof revokedUrl === 'string' && revokedUrl.startsWith('blob:')).toBe(true);
    } finally {
      URL.revokeObjectURL = originalRevoke;
      loader.destroy();
    }
  });

  it('hot reload replaces the instance without retaining old styles or listeners', async () => {
    const loader = PluginLoader.getInstance();
    const registry = PluginRegistry.getInstance();
    const previousEnabled = settingsStore.isPluginEnabled;
    const handled: number[] = [];
    const unloaded: number[] = [];
    let generation = 0;

    settingsStore.isPluginEnabled = () => true;
    loader.registerBuiltin(() => {
      const currentGeneration = ++generation;
      return {
        manifest,
        onLoad: (api) => {
          api.style.inject('runtime', `body{--plugin-generation:${currentGeneration}}`);
          api.events.on('ping', () => handled.push(currentGeneration));
        },
        onUnload: () => unloaded.push(currentGeneration),
        matchesDomain: () => true,
        isReaderPage: () => true,
        isHomePage: () => false,
        nextPage: () => undefined,
        prevPage: () => undefined,
        getStyles: () => ({}),
      };
    });

    try {
      await loader.initialize();
      const firstRuntime = registry.get(manifest.id)?.plugin;
      EventBus.emit(`plugin:${manifest.id}:ping`);
      expect(handled).toEqual([1]);

      await loader.hotReload();
      const secondRuntime = registry.get(manifest.id)?.plugin;
      expect(secondRuntime).not.toBe(firstRuntime);
      expect(unloaded).toEqual([1]);
      expect(EventBus.getListenerCount()).toBe(1);
      expect(document.getElementById('plugin-lifecycle-plugin-runtime')?.textContent).toContain('2');

      EventBus.emit(`plugin:${manifest.id}:ping`);
      expect(handled).toEqual([1, 2]);
    } finally {
      settingsStore.isPluginEnabled = previousEnabled;
      loader.destroy();
    }
  });
});
