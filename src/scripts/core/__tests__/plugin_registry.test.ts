/**
 * Unit Tests for Plugin Registry
 *
 * Tests the plugin registry:
 * - Singleton pattern
 * - Plugin registration and unregistration
 * - Plugin lookup by domain and extension
 * - Active plugin management
 * - Plugin state management
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { PluginRegistry } from '../plugin_registry';
import type { ReaderPlugin, PluginManifest } from '../plugin_types';

// Mock plugin factory
function createMockPlugin(
  id: string,
  sourceType: 'web' | 'local' | 'cloud' = 'web',
  options: {
    domain?: string;
    matchesDomain?: boolean;
    isReader?: boolean;
    isHome?: boolean;
    extensions?: string[];
    builtin?: boolean;
  } = {}
): ReaderPlugin {
  const {
    domain = 'example.com',
    matchesDomain = false,
    isReader = false,
    isHome = false,
    extensions = [],
    builtin = false,
  } = options;

  const manifest: PluginManifest = {
    id,
    name: `Mock Plugin ${id}`,
    version: '1.0.0',
    sourceType,
    builtin,
    site: sourceType === 'web' ? { domain: [domain] } : undefined,
    fileTypes: sourceType === 'local' ? { extensions } : undefined,
  };

  return {
    manifest,
    onLoad: () => {},
    onUnload: () => {},
    matchesDomain: () => matchesDomain,
    isReaderPage: () => isReader,
    isHomePage: () => isHome,
    nextPage: () => {},
    prevPage: () => {},
  };
}

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    // Reset singleton
    (PluginRegistry as any).instance = undefined;
    registry = PluginRegistry.getInstance();
  });

  afterEach(() => {
    registry.clear();
  });

  describe('Singleton Pattern', () => {
    it('should return same instance', () => {
      const instance1 = PluginRegistry.getInstance();
      const instance2 = PluginRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('Plugin Registration', () => {
    it('should register a plugin', () => {
      const plugin = createMockPlugin('test-plugin');
      registry.register(plugin);

      expect(registry.get('test-plugin')).toBeDefined();
      expect(registry.get('test-plugin')?.plugin).toBe(plugin);
    });

    it('should not register duplicate plugins', () => {
      const plugin1 = createMockPlugin('test-plugin');
      const plugin2 = createMockPlugin('test-plugin');

      registry.register(plugin1);
      registry.register(plugin2);

      expect(registry.getAll().length).toBe(1);
    });

    it('should set initial state to unloaded', () => {
      const plugin = createMockPlugin('test-plugin');
      registry.register(plugin);

      expect(registry.get('test-plugin')?.state).toBe('unloaded');
    });
  });

  describe('Plugin Unregistration', () => {
    it('should unregister a plugin', () => {
      const plugin = createMockPlugin('test-plugin');
      registry.register(plugin);

      const result = registry.unregister('test-plugin');

      expect(result).toBe(true);
      expect(registry.get('test-plugin')).toBeUndefined();
    });

    it('should return false for non-existent plugin', () => {
      const result = registry.unregister('non-existent');
      expect(result).toBe(false);
    });

    it('should call onUnload for loaded plugins', () => {
      let unloadCalled = false;
      const plugin = createMockPlugin('test-plugin');
      plugin.onUnload = () => { unloadCalled = true; };

      registry.register(plugin);
      registry.updateState('test-plugin', 'loaded');
      registry.unregister('test-plugin');

      expect(unloadCalled).toBe(true);
    });

    it('should clear active plugin if unregistered', () => {
      const plugin = createMockPlugin('test-plugin', 'web', { matchesDomain: true });
      registry.register(plugin);
      registry.setActivePlugin('test-plugin');

      registry.unregister('test-plugin');

      expect(registry.getActivePlugin()).toBeNull();
    });
  });

  describe('Plugin Lookup', () => {
    it('should find plugin by domain', () => {
      const plugin = createMockPlugin('weread', 'web', {
        domain: 'weread.qq.com',
        matchesDomain: true,
      });
      registry.register(plugin);

      const found = registry.findByDomain();
      expect(found?.plugin.manifest.id).toBe('weread');
    });

    it('should return null when no matching domain', () => {
      const plugin = createMockPlugin('test', 'web', { matchesDomain: false });
      registry.register(plugin);

      const found = registry.findByDomain();
      expect(found).toBeNull();
    });

    it('should find local plugin by extension', () => {
      const plugin = createMockPlugin('epub-reader', 'local', {
        extensions: ['.epub', '.mobi'],
      });
      registry.register(plugin);

      const found = registry.findByExtension('.epub');
      expect(found?.plugin.manifest.id).toBe('epub-reader');
    });

    it('should find extension case-insensitively', () => {
      const plugin = createMockPlugin('epub-reader', 'local', {
        extensions: ['.epub'],
      });
      registry.register(plugin);

      const found = registry.findByExtension('.EPUB');
      expect(found?.plugin.manifest.id).toBe('epub-reader');
    });

    it('should return null for unknown extension', () => {
      const plugin = createMockPlugin('epub-reader', 'local', {
        extensions: ['.epub'],
      });
      registry.register(plugin);

      const found = registry.findByExtension('.pdf');
      expect(found).toBeNull();
    });
  });

  describe('Plugin Filtering', () => {
    beforeEach(() => {
      registry.register(createMockPlugin('web1', 'web'));
      registry.register(createMockPlugin('web2', 'web'));
      registry.register(createMockPlugin('local1', 'local'));
    });

    it('should get all plugins', () => {
      expect(registry.getAll().length).toBe(3);
    });

    it('should get only web plugins', () => {
      const webPlugins = registry.getWebPlugins();
      expect(webPlugins.length).toBe(2);
      expect(webPlugins.every(p => p.plugin.manifest.sourceType === 'web')).toBe(true);
    });

    it('should get only local plugins', () => {
      const localPlugins = registry.getLocalPlugins();
      expect(localPlugins.length).toBe(1);
      expect(localPlugins[0].plugin.manifest.sourceType).toBe('local');
    });
  });

  describe('Active Plugin Management', () => {
    it('should set active plugin by ID', () => {
      const plugin = createMockPlugin('test-plugin', 'web', { matchesDomain: true });
      registry.register(plugin);

      const result = registry.setActivePlugin('test-plugin');

      expect(result).toBe(true);
      expect(registry.getActivePlugin()?.plugin.manifest.id).toBe('test-plugin');
    });

    it('should fail to set non-existent plugin as active', () => {
      const result = registry.setActivePlugin('non-existent');
      expect(result).toBe(false);
    });

    it('should auto-find active plugin by domain', () => {
      const plugin = createMockPlugin('weread', 'web', { matchesDomain: true });
      registry.register(plugin);

      const active = registry.getActivePlugin();
      expect(active?.plugin.manifest.id).toBe('weread');
    });
  });

  describe('Plugin State Management', () => {
    it('should update plugin state', () => {
      const plugin = createMockPlugin('test-plugin');
      registry.register(plugin);

      registry.updateState('test-plugin', 'loaded');

      expect(registry.get('test-plugin')?.state).toBe('loaded');
    });

    it('should set loadedAt timestamp when loaded', () => {
      const plugin = createMockPlugin('test-plugin');
      registry.register(plugin);

      const before = Date.now();
      registry.updateState('test-plugin', 'loaded');
      const after = Date.now();

      const loadedAt = registry.get('test-plugin')?.loadedAt;
      expect(loadedAt).toBeGreaterThanOrEqual(before);
      expect(loadedAt).toBeLessThanOrEqual(after);
    });

    it('should store error message on error state', () => {
      const plugin = createMockPlugin('test-plugin');
      registry.register(plugin);

      registry.updateState('test-plugin', 'error', 'Something went wrong');

      expect(registry.get('test-plugin')?.state).toBe('error');
      expect(registry.get('test-plugin')?.error).toBe('Something went wrong');
    });
  });

  describe('Page Detection', () => {
    it('should delegate isReaderPage to active plugin', () => {
      const plugin = createMockPlugin('test', 'web', {
        matchesDomain: true,
        isReader: true,
      });
      registry.register(plugin);

      expect(registry.isReaderPage()).toBe(true);
    });

    it('should delegate isHomePage to active plugin', () => {
      const plugin = createMockPlugin('test', 'web', {
        matchesDomain: true,
        isHome: true,
      });
      registry.register(plugin);

      expect(registry.isHomePage()).toBe(true);
    });

    it('should return false when no active plugin', () => {
      expect(registry.isReaderPage()).toBe(false);
      expect(registry.isHomePage()).toBe(false);
    });
  });

  describe('Statistics', () => {
    it('should return correct stats', () => {
      registry.register(createMockPlugin('web1', 'web', { builtin: true }));
      registry.register(createMockPlugin('web2', 'web'));
      registry.register(createMockPlugin('local1', 'local'));

      registry.updateState('web1', 'loaded');

      const stats = registry.getStats();

      expect(stats.total).toBe(3);
      expect(stats.loaded).toBe(1);
      expect(stats.web).toBe(2);
      expect(stats.local).toBe(1);
      expect(stats.builtin).toBe(1);
    });
  });

  describe('Clear', () => {
    it('should remove all plugins', () => {
      registry.register(createMockPlugin('plugin1'));
      registry.register(createMockPlugin('plugin2'));

      registry.clear();

      expect(registry.getAll().length).toBe(0);
    });

    it('should call onUnload for loaded plugins during clear', () => {
      let unloadCount = 0;
      const plugin1 = createMockPlugin('plugin1');
      const plugin2 = createMockPlugin('plugin2');
      plugin1.onUnload = () => { unloadCount++; };
      plugin2.onUnload = () => { unloadCount++; };

      registry.register(plugin1);
      registry.register(plugin2);
      registry.updateState('plugin1', 'loaded');
      registry.updateState('plugin2', 'loaded');

      registry.clear();

      expect(unloadCount).toBe(2);
    });

    it('should clear active plugin reference', () => {
      const plugin = createMockPlugin('test', 'web', { matchesDomain: true });
      registry.register(plugin);
      registry.setActivePlugin('test');

      registry.clear();

      expect(registry.getActivePlugin()).toBeNull();
    });
  });
});
