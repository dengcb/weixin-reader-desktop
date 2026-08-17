/**
 * Unit Tests for Plugin Loader
 *
 * Tests the plugin loader:
 * - Singleton pattern
 * - Plugin initialization and loading
 * - Plugin lifecycle (onLoad, onUnload)
 * - Plugin installation and uninstallation
 * - Method invocation with safety checks
 */

import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { PluginLoader } from '../plugin_loader';
import { PluginRegistry, getPluginRegistry } from '../plugin_registry';
import { settingsStore } from '../settings_store';
import { log } from '../logger';
import type { ReaderPlugin, PluginManifest } from '../plugin_types';
import { createPluginSiteRuntime } from '../reader_site_runtime';

// Mock plugin factory
function createMockPlugin(id: string): ReaderPlugin {
  const manifest: PluginManifest = {
    id,
    name: `Mock Plugin ${id}`,
    version: '1.0.0',
    sourceType: 'web',
    renderMode: 'webview',
    capabilities: {},
  };

  return {
    manifest,
    onLoad: () => {},
    onUnload: () => {},
    matchesDomain: () => false,
    isReaderPage: () => false,
    isHomePage: () => false,
    nextPage: () => {},
    prevPage: () => {},
    getStyles: () => ({}),
  };
}

describe('PluginLoader', () => {
  let loader: PluginLoader;
  let registry: PluginRegistry;

  beforeEach(async () => {
    // Reset singletons
    (PluginLoader as any).instance = undefined;
    (PluginRegistry as any).instance = undefined;
    
    loader = PluginLoader.getInstance();
    registry = getPluginRegistry();

    // Mock settingsStore
    spyOn(settingsStore, 'isPluginEnabled').mockReturnValue(true);
    spyOn(settingsStore, 'enablePlugin').mockResolvedValue(undefined);
    spyOn(settingsStore, 'disablePlugin').mockResolvedValue(undefined);
    
    // Silence logs
    spyOn(log, 'info').mockImplementation(() => {});
    spyOn(log, 'warn').mockImplementation(() => {});
    spyOn(log, 'error').mockImplementation(() => {});
    spyOn(log, 'debug').mockImplementation(() => {});
  });

  describe('Singleton Pattern', () => {
    it('should return same instance', () => {
      const instance1 = PluginLoader.getInstance();
      const instance2 = PluginLoader.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('Initialization', () => {
    it('should register and load builtin plugins', async () => {
      const mockPlugin = createMockPlugin('builtin-plugin');
      loader.registerBuiltin(() => mockPlugin);
      
      // Mock registry to return this plugin as active
      spyOn(registry, 'getActivePlugin').mockReturnValue({
        plugin: createPluginSiteRuntime(mockPlugin),
        state: 'unloaded'
      });

      await loader.initialize();

      expect(registry.get('builtin-plugin')).toBeDefined();
      expect(registry.get('builtin-plugin')?.state).toBe('loaded');
    });

    it('should not initialize twice', async () => {
      await loader.initialize();
      await loader.initialize();
      expect(log.warn).toHaveBeenCalled();
    });

    it('forces the built-in local runtime without loading external webpage plugins', async () => {
      const local = createMockPlugin('local');
      local.manifest.sourceType = 'local';
      local.manifest.renderMode = 'custom';
      local.manifest.builtin = true;
      loader.registerBuiltin(() => local);
      const externalSpy = spyOn(loader as any, 'loadExternalPlugins');
      spyOn(settingsStore, 'isPluginEnabled').mockReturnValue(false);

      await loader.initialize('local');

      expect(externalSpy).not.toHaveBeenCalled();
      expect(registry.get('local')?.state).toBe('loaded');
      expect(loader.getActivePlugin()?.id).toBe('local');
    });
  });

  describe('Loading and Unloading', () => {
    it('should load a registered plugin', async () => {
      const plugin = createMockPlugin('test-plugin');
      const onLoadSpy = spyOn(plugin, 'onLoad');
      registry.register(plugin);

      const result = await loader.loadPlugin('test-plugin');

      expect(result).toBe(true);
      expect(onLoadSpy).toHaveBeenCalled();
      expect(registry.get('test-plugin')?.state).toBe('loaded');
    });

    it('should not load a disabled plugin', async () => {
      const plugin = createMockPlugin('disabled-plugin');
      registry.register(plugin);
      
      spyOn(settingsStore, 'isPluginEnabled').mockReturnValue(false);

      const result = await loader.loadPlugin('disabled-plugin');

      expect(result).toBe(false);
      expect(registry.get('disabled-plugin')?.state).toBe('unloaded');
    });

    it('should unload a loaded plugin', async () => {
      const plugin = createMockPlugin('test-plugin');
      const onUnloadSpy = spyOn(plugin, 'onUnload');
      registry.register(plugin);
      await loader.loadPlugin('test-plugin');

      const result = await loader.unloadPlugin('test-plugin');

      expect(result).toBe(true);
      expect(onUnloadSpy).toHaveBeenCalled();
      expect(registry.get('test-plugin')?.state).toBe('unloaded');
    });

    it('should reload a plugin', async () => {
      const plugin = createMockPlugin('test-plugin');
      registry.register(plugin);
      
      const unloadSpy = spyOn(loader, 'unloadPlugin');
      const loadSpy = spyOn(loader, 'loadPlugin');

      await loader.reloadPlugin('test-plugin');

      expect(unloadSpy).toHaveBeenCalledWith('test-plugin');
      expect(loadSpy).toHaveBeenCalledWith('test-plugin');
    });
  });

  describe('Method Invocation', () => {
    it('should invoke method on active plugin', () => {
      const plugin = createMockPlugin('test-plugin');
      const nextSpy = spyOn(plugin, 'nextPage');
      
      registry.register(plugin);
      spyOn(registry, 'getActivePlugin').mockReturnValue({
        plugin: createPluginSiteRuntime(plugin),
        state: 'loaded'
      });

      loader.invokePluginMethod('nextPage');

      expect(nextSpy).toHaveBeenCalled();
    });

    it('should return null if no active plugin', () => {
      spyOn(registry, 'getActivePlugin').mockReturnValue(null);
      const result = loader.invokePluginMethod('nextPage');
      expect(result).toBeNull();
    });

    it('should catch errors during invocation', () => {
      const plugin = createMockPlugin('test-plugin');
      plugin.nextPage = () => { throw new Error('Plugin Error'); };
      
      registry.register(plugin);
      spyOn(registry, 'getActivePlugin').mockReturnValue({
        plugin: createPluginSiteRuntime(plugin),
        state: 'loaded'
      });

      const errorSpy = spyOn(log, 'error');
      const result = loader.invokePluginMethod('nextPage');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('Installation and Uninstallation', () => {
    it('should install plugin (enable + load)', async () => {
      const plugin = createMockPlugin('new-plugin');
      registry.register(plugin);
      
      const enableSpy = spyOn(settingsStore, 'enablePlugin');
      const loadSpy = spyOn(loader, 'loadPlugin').mockResolvedValue(true);

      const result = await loader.installPlugin('new-plugin');

      expect(result).toBe(true);
      expect(enableSpy).toHaveBeenCalledWith('new-plugin');
      expect(loadSpy).toHaveBeenCalledWith('new-plugin');
    });

    it('should uninstall plugin (unload + disable)', async () => {
      const plugin = createMockPlugin('old-plugin');
      registry.register(plugin);
      
      const unloadSpy = spyOn(loader, 'unloadPlugin').mockResolvedValue(true);
      const disableSpy = spyOn(settingsStore, 'disablePlugin');

      const result = await loader.uninstallPlugin('old-plugin');

      expect(result).toBe(true);
      expect(unloadSpy).toHaveBeenCalledWith('old-plugin');
      expect(disableSpy).toHaveBeenCalled();
    });
  });
});
