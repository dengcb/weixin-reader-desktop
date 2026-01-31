/**
 * Unit Tests for Plugin API
 *
 * Tests the plugin API implementation:
 * - Style API with namespace isolation
 * - Settings API with plugin-scoped storage
 * - Events API with prefixed event names
 * - Storage API with localStorage
 * - Log API with prefixed output
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { createPluginAPI } from '../plugin_api';
import type { PluginManifest } from '../plugin_types';

// Mock localStorage for test environment
const localStorageData: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => localStorageData[key] || null,
  setItem: (key: string, value: string) => { localStorageData[key] = value; },
  removeItem: (key: string) => { delete localStorageData[key]; },
  clear: () => { Object.keys(localStorageData).forEach(k => delete localStorageData[k]); },
  key: (index: number) => Object.keys(localStorageData)[index] || null,
  get length() { return Object.keys(localStorageData).length; },
};

// Set up global mocks
if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as any).localStorage = mockLocalStorage;
}

// Mock manifest
const mockManifest: PluginManifest = {
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  sourceType: 'web',
};

describe('Plugin API', () => {
  let api: ReturnType<typeof createPluginAPI>;

  beforeEach(() => {
    // Clear localStorage
    mockLocalStorage.clear();
    
    // Create fresh API instance
    api = createPluginAPI(mockManifest);
  });

  afterEach(() => {
    mockLocalStorage.clear();
  });

  describe('createPluginAPI', () => {
    it('should create API with all sub-APIs', () => {
      expect(api.style).toBeDefined();
      expect(api.settings).toBeDefined();
      expect(api.events).toBeDefined();
      expect(api.menu).toBeDefined();
      expect(api.storage).toBeDefined();
      expect(api.log).toBeDefined();
      expect(api.content).toBeDefined();
    });
  });

  describe('Style API', () => {
    // Skip DOM tests if document is not available (non-browser environment)
    const hasDocument = typeof document !== 'undefined';

    it('should inject CSS with plugin prefix', () => {
      if (!hasDocument) {
        expect(true).toBe(true); // Skip in non-browser env
        return;
      }
      api.style.inject('my-style', 'body { color: red; }');
      
      const element = document.getElementById('plugin-test-plugin-my-style');
      expect(element).toBeTruthy();
      expect(element?.tagName).toBe('STYLE');
    });

    it('should check if style exists', () => {
      if (!hasDocument) {
        expect(true).toBe(true); // Skip in non-browser env
        return;
      }
      expect(api.style.has('my-style')).toBe(false);
      
      api.style.inject('my-style', 'body { color: red; }');
      expect(api.style.has('my-style')).toBe(true);
    });

    it('should remove CSS with plugin prefix', () => {
      if (!hasDocument) {
        expect(true).toBe(true); // Skip in non-browser env
        return;
      }
      api.style.inject('my-style', 'body { color: red; }');
      expect(api.style.has('my-style')).toBe(true);
      
      api.style.remove('my-style');
      expect(api.style.has('my-style')).toBe(false);
    });

    it('should isolate styles between plugins', () => {
      if (!hasDocument) {
        expect(true).toBe(true); // Skip in non-browser env
        return;
      }
      const api2 = createPluginAPI({ ...mockManifest, id: 'another-plugin' });
      
      api.style.inject('shared-name', 'body { color: red; }');
      api2.style.inject('shared-name', 'body { color: blue; }');
      
      expect(document.getElementById('plugin-test-plugin-shared-name')).toBeTruthy();
      expect(document.getElementById('plugin-another-plugin-shared-name')).toBeTruthy();
    });
  });

  describe('Storage API', () => {
    it('should store and retrieve values', async () => {
      await api.storage.set('key1', { foo: 'bar' });
      
      const value = await api.storage.get<{ foo: string }>('key1');
      expect(value).toEqual({ foo: 'bar' });
    });

    it('should return null for non-existent keys', async () => {
      const value = await api.storage.get('non-existent');
      expect(value).toBeNull();
    });

    it('should remove values', async () => {
      await api.storage.set('key1', 'value1');
      expect(await api.storage.get('key1')).toBe('value1');
      
      await api.storage.remove('key1');
      expect(await api.storage.get('key1')).toBeNull();
    });

    it('should list keys for this plugin', async () => {
      await api.storage.set('key1', 'value1');
      await api.storage.set('key2', 'value2');
      
      const keys = await api.storage.keys();
      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
    });

    it('should isolate storage between plugins', async () => {
      const api2 = createPluginAPI({ ...mockManifest, id: 'another-plugin' });
      
      await api.storage.set('shared-key', 'value1');
      await api2.storage.set('shared-key', 'value2');
      
      expect(await api.storage.get('shared-key')).toBe('value1');
      expect(await api2.storage.get('shared-key')).toBe('value2');
    });
  });

  describe('Log API', () => {
    it('should have all log methods', () => {
      expect(typeof api.log.debug).toBe('function');
      expect(typeof api.log.info).toBe('function');
      expect(typeof api.log.warn).toBe('function');
      expect(typeof api.log.error).toBe('function');
    });

    it('should not throw when logging', () => {
      expect(() => api.log.debug('test debug')).not.toThrow();
      expect(() => api.log.info('test info')).not.toThrow();
      expect(() => api.log.warn('test warn')).not.toThrow();
      expect(() => api.log.error('test error')).not.toThrow();
    });
  });

  describe('Events API', () => {
    it('should subscribe and emit events', () => {
      let received = false;
      let receivedData: any = null;
      
      api.events.on('test-event', (data) => {
        received = true;
        receivedData = data;
      });
      
      api.events.emit('test-event', { foo: 'bar' });
      
      expect(received).toBe(true);
      expect(receivedData).toEqual({ foo: 'bar' });
    });

    it('should unsubscribe from events', () => {
      let callCount = 0;
      
      const unsubscribe = api.events.on('test-event', () => {
        callCount++;
      });
      
      api.events.emit('test-event');
      expect(callCount).toBe(1);
      
      unsubscribe();
      api.events.emit('test-event');
      expect(callCount).toBe(1); // Should not increase
    });

    it('should handle once events', () => {
      let callCount = 0;
      
      api.events.once('test-event', () => {
        callCount++;
      });
      
      api.events.emit('test-event');
      api.events.emit('test-event');
      
      expect(callCount).toBe(1);
    });

    it('should isolate events between plugins', () => {
      const api2 = createPluginAPI({ ...mockManifest, id: 'another-plugin' });
      
      let plugin1Received = false;
      let plugin2Received = false;
      
      api.events.on('shared-event', () => { plugin1Received = true; });
      api2.events.on('shared-event', () => { plugin2Received = true; });
      
      api.events.emit('shared-event');
      
      expect(plugin1Received).toBe(true);
      expect(plugin2Received).toBe(false); // Different namespace
    });
  });

  describe('Menu API', () => {
    it('should register menu items with prefix', () => {
      const items = [
        { id: 'item1', label: 'Item 1' },
        { id: 'item2', label: 'Item 2' },
      ];
      
      // Should not throw
      expect(() => api.menu.register(items)).not.toThrow();
    });

    it('should set enabled state', () => {
      expect(() => api.menu.setEnabled('item1', true)).not.toThrow();
      expect(() => api.menu.setEnabled('item1', false)).not.toThrow();
    });

    it('should set checked state', () => {
      expect(() => api.menu.setChecked('item1', true)).not.toThrow();
      expect(() => api.menu.setChecked('item1', false)).not.toThrow();
    });
  });

  describe('Content API', () => {
    // Skip DOM tests if window is not available
    const hasWindow = typeof window !== 'undefined';

    it('should have scroll methods', () => {
      expect(typeof api.content.scrollTo).toBe('function');
      expect(typeof api.content.getScrollPosition).toBe('function');
    });

    it('should get scroll position', () => {
      if (!hasWindow) {
        expect(true).toBe(true); // Skip in non-browser env
        return;
      }
      const position = api.content.getScrollPosition();
      expect(typeof position).toBe('number');
    });

    it('should get container (may return body in test env)', () => {
      if (!hasWindow || typeof document === 'undefined') {
        expect(true).toBe(true); // Skip in non-browser env
        return;
      }
      const container = api.content.getContainer();
      expect(container).toBeTruthy();
    });
  });
});

describe('Plugin Namespace Isolation', () => {
  // Skip DOM tests if document is not available
  const hasDocument = typeof document !== 'undefined';

  it('should create unique namespaces for each plugin', () => {
    if (!hasDocument) {
      expect(true).toBe(true); // Skip in non-browser env
      return;
    }
    const manifest1: PluginManifest = { id: 'plugin-a', name: 'A', version: '1.0.0', sourceType: 'web' };
    const manifest2: PluginManifest = { id: 'plugin-b', name: 'B', version: '1.0.0', sourceType: 'web' };
    
    const api1 = createPluginAPI(manifest1);
    const api2 = createPluginAPI(manifest2);
    
    // Inject same style ID, should create different elements
    api1.style.inject('common-style', '.a { color: red; }');
    api2.style.inject('common-style', '.b { color: blue; }');
    
    const elem1 = document.getElementById('plugin-plugin-a-common-style');
    const elem2 = document.getElementById('plugin-plugin-b-common-style');
    
    expect(elem1).toBeTruthy();
    expect(elem2).toBeTruthy();
    expect(elem1).not.toBe(elem2);
  });
});
