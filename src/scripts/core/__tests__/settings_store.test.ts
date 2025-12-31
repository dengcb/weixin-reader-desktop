/**
 * Unit Tests for SettingsStore
 *
 * Tests the settings store singleton with optimistic locking:
 * - Initialization with defaults
 * - Get and update operations
 * - Subscribe/notify mechanism
 * - Integration with OptimisticLock
 * - Concurrent update handling
 * - Error handling and fallback
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SettingsStore } from '../settings_store';
import type { AppSettings } from '../settings_store';

// Mock settings storage (simulating backend)
let mockSettings: Partial<AppSettings> = {};
let mockVersion: number = 0;
const mockListeners = new Set<() => void>();

// Setup global window object for tests
function setupWindowMock() {
  (globalThis as any).window = {
    __TAURI__: {
      core: {
        invoke: async <T>(cmd: string, args?: any): Promise<T> => {
          if (cmd === 'get_settings') {
            // Return current mock state (dynamic, not static)
            return { ...mockSettings, _version: mockVersion } as T;
          }
          if (cmd === 'save_settings') {
            mockSettings = { ...args.settings };
            mockVersion = args.version || mockVersion + 1;
            return undefined as T;
          }
          throw new Error(`Unknown command: ${cmd}`);
        }
      },
      event: {
        listen: async (_event: string, handler: () => void | Promise<void>) => {
          mockListeners.add(handler as () => void);
          return () => mockListeners.delete(handler as () => void);
        }
      }
    }
  };
}

function cleanupWindowMock() {
  delete (globalThis as any).window;
}

describe('SettingsStore', () => {
  let store: SettingsStore;

  beforeEach(async () => {
    // Setup window mock
    setupWindowMock();

    // Reset mock state
    mockSettings = {};
    mockVersion = 0;
    mockListeners.clear();

    // Get fresh instance for each test by resetting internal state
    store = new SettingsStore();
  });

  afterEach(() => {
    // Clean up store state
    store['initialized'] = false;
    store['lock'] = null;
    store['listeners'].clear();
    // Reset singleton instance
    (SettingsStore as any).instance = undefined;

    // Cleanup window mock
    cleanupWindowMock();
  });

  describe('Initialization', () => {
    it('should initialize with default values when no settings exist', async () => {
      mockSettings = {};

      await store.init();

      const settings = store.get();
      expect(settings.readerWide).toBe(false);
      expect(settings.hideToolbar).toBe(false);
      expect(settings.zoom).toBe(0.8);
      expect(settings.lastPage).toBe(true);
      expect(settings.autoUpdate).toBe(true);
      expect(settings.autoFlip).toEqual({
        active: false,
        interval: 15,
        keepAwake: true
      });
    });

    it('should load existing settings and merge with defaults', async () => {
      mockSettings = {
        readerWide: true,
        zoom: 1.2,
        autoFlip: { active: true, interval: 30, keepAwake: false }
      };

      await store.init();

      const settings = store.get();
      expect(settings.readerWide).toBe(true);
      expect(settings.zoom).toBe(1.2);
      expect(settings.autoFlip.active).toBe(true);
      expect(settings.autoFlip.interval).toBe(30);
      expect(settings.autoFlip.keepAwake).toBe(false);
      // Unspecified fields should have defaults
      expect(settings.hideToolbar).toBe(false);
      expect(settings.lastPage).toBe(true);
    });

    it('should initialize optimistic lock with correct version', async () => {
      mockSettings = { readerWide: true };
      mockVersion = 5;

      await store.init();

      expect(store.get()._version).toBe(5);
    });

    it('should use fallback settings on load error', async () => {
      // Mock invoke to throw error
      (globalThis as any).window.__TAURI__.core.invoke = async () => {
        throw new Error('Failed to load settings');
      };

      await store.init();

      const settings = store.get();
      expect(settings.readerWide).toBe(false);
      expect(settings.zoom).toBe(0.8);
      expect(settings._version).toBe(0);

      // Restore original mock
      setupWindowMock();
    });
  });

  describe('Get Operation', () => {
    it('should return current settings', async () => {
      mockSettings = { readerWide: true, zoom: 1.5 };

      await store.init();
      const settings = store.get();

      expect(settings.readerWide).toBe(true);
      expect(settings.zoom).toBe(1.5);
    });

    it('should return empty object when not initialized', () => {
      const settings = store.get();
      expect(settings).toEqual({});
    });

    it('should return a copy of settings (not reference)', async () => {
      mockSettings = { readerWide: true };

      await store.init();
      const settings1 = store.get();
      const settings2 = store.get();

      // Modify returned object
      (settings1 as any).readerWide = false;

      // Original should be unchanged
      expect(settings2.readerWide).toBe(true);
    });
  });

  describe('Update Operation', () => {
    it('should update single setting', async () => {
      await store.init();
      await store.update({ readerWide: true });

      expect(store.get().readerWide).toBe(true);
      expect(mockSettings.readerWide).toBe(true);
    });

    it('should update multiple settings', async () => {
      await store.init();
      await store.update({
        readerWide: true,
        zoom: 1.2,
        hideToolbar: true
      });

      const settings = store.get();
      expect(settings.readerWide).toBe(true);
      expect(settings.zoom).toBe(1.2);
      expect(settings.hideToolbar).toBe(true);
    });

    it('should increment version on update', async () => {
      mockVersion = 3;
      await store.init();

      await store.update({ readerWide: true });

      expect(store.get()._version).toBe(4);
      expect(mockVersion).toBe(4);
    });

    it('should update nested autoFlip settings', async () => {
      await store.init();
      await store.update({
        autoFlip: { active: true, interval: 25, keepAwake: false }
      });

      expect(store.get().autoFlip).toEqual({
        active: true,
        interval: 25,
        keepAwake: false
      });
    });

    it('should merge autoFlip settings correctly', async () => {
      await store.init();
      // First update sets all autoFlip properties
      await store.update({
        autoFlip: { active: true, interval: 20, keepAwake: true }
      });

      // Second update should merge
      await store.update({
        autoFlip: { active: false, interval: 30, keepAwake: true }
      });

      expect(store.get().autoFlip).toEqual({
        active: false,
        interval: 30,
        keepAwake: true
      });
    });

    it('should ignore _version in partial update', async () => {
      await store.init();

      // Try to set _version explicitly (should be ignored)
      await store.update({ _version: 999 } as any);

      // Version should increment by 1, not jump to 999
      expect(store.get()._version).toBe(1);
    });

    it('should notify listeners after update', async () => {
      await store.init();

      let notified = false;
      let receivedSettings: AppSettings | undefined;

      store.subscribe((settings) => {
        notified = true;
        receivedSettings = settings;
      });

      await store.update({ readerWide: true });

      expect(notified).toBe(true);
      expect(receivedSettings?.readerWide).toBe(true);
    });

    it('should handle update error gracefully', async () => {
      await store.init();
      const oldVersion = store.get()._version;

      // Mock invoke to throw error on save
      (globalThis as any).window.__TAURI__.core.invoke = async (cmd: string) => {
        if (cmd === 'save_settings') {
          throw new Error('Save failed');
        }
        return {};
      };

      // Update should not throw, but version should revert
      await store.update({ readerWide: true });

      // Version should be reverted on error
      expect(store.get()._version).toBe(oldVersion);

      // Restore original mock
      setupWindowMock();
    });

    it('should not update when lock is not initialized', async () => {
      // Don't initialize the store
      const originalError = console.error;
      let errorCalled = false;
      console.error = (...args: any[]) => {
        errorCalled = true;
        originalError(...args);
      };

      await store.update({ readerWide: true });

      expect(errorCalled).toBe(true);
      expect(store.get()).toEqual({});

      console.error = originalError;
    });
  });

  describe('Subscribe/Notify Mechanism', () => {
    it('should notify subscriber immediately on subscription', async () => {
      await store.init();

      let receivedSettings: AppSettings | undefined;
      store.subscribe((settings) => {
        receivedSettings = settings;
      });

      expect(receivedSettings).toBeDefined();
      expect(receivedSettings?.readerWide).toBe(false);
    });

    it('should notify all subscribers on update', async () => {
      await store.init();

      const results: AppSettings[] = [];
      const unsubscribe1 = store.subscribe((s) => results.push(s));
      const unsubscribe2 = store.subscribe((s) => results.push(s));

      await store.update({ readerWide: true });

      expect(results.length).toBe(4); // 2 immediate + 2 on update
      expect(results.filter(r => r.readerWide === true).length).toBe(2);

      unsubscribe1();
      unsubscribe2();
    });

    it('should unsubscribe correctly', async () => {
      await store.init();

      let count = 0;
      const unsubscribe = store.subscribe(() => {
        count++;
      });

      await store.update({ readerWide: true });
      expect(count).toBe(2); // initial + update

      unsubscribe();

      await store.update({ hideToolbar: true });
      expect(count).toBe(2); // No new notification
    });

    it('should handle multiple subscribers independently', async () => {
      await store.init();

      const subscriber1Calls: string[] = [];
      const subscriber2Calls: string[] = [];

      store.subscribe((s) => subscriber1Calls.push(`sub1: ${s.zoom}`));
      store.subscribe((s) => subscriber2Calls.push(`sub2: ${s.readerWide}`));

      await store.update({ zoom: 1.5 });

      expect(subscriber1Calls.length).toBe(2); // initial + update
      expect(subscriber1Calls[1]).toBe('sub1: 1.5');
      expect(subscriber2Calls.length).toBe(2); // initial + update
      expect(subscriber2Calls[1]).toBe('sub2: false');
    });
  });

  describe('External Update Handling', () => {
    it('should load external settings when version is newer', async () => {
      mockVersion = 5;
      await store.init();

      // Simulate external update with newer version
      mockSettings = { readerWide: true, zoom: 2.0 };
      mockVersion = 10;

      // Trigger settings-updated event and await all handlers
      const promises = Array.from(mockListeners).map(listener => listener());
      await Promise.all(promises);

      // Settings should be updated to external version
      expect(store.get()._version).toBe(10);
      expect(store.get().readerWide).toBe(true);
    });

    it('should reject external settings when version is older', async () => {
      mockVersion = 10;
      await store.init();
      const beforeSettings = JSON.stringify(store.get());

      // Simulate external update with older version
      mockSettings = { readerWide: false };
      mockVersion = 5;

      // Trigger settings-updated event and await all handlers
      const promises = Array.from(mockListeners).map(listener => listener());
      await Promise.all(promises);

      // Settings should remain unchanged
      expect(JSON.stringify(store.get())).toBe(beforeSettings);
    });

    it('should handle same version idempotently', async () => {
      mockVersion = 5;
      await store.init();

      // Trigger event with same version and await all handlers
      const promises = Array.from(mockListeners).map(listener => listener());
      await Promise.all(promises);

      // Should not cause errors or version conflicts
      expect(store.get()._version).toBe(5);
    });
  });

  describe('Singleton Pattern', () => {
    it('should return same instance across multiple calls', () => {
      const instance1 = SettingsStore.getInstance();
      const instance2 = SettingsStore.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should maintain state across getInstance calls', async () => {
      const instance1 = SettingsStore.getInstance();
      await instance1.init();

      const instance2 = SettingsStore.getInstance();
      expect(instance2.get()).toEqual(instance1.get());
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty update', async () => {
      await store.init();
      const beforeVersion = store.get()._version;

      await store.update({});

      expect(store.get()._version).toBe(beforeVersion + 1);
    });

    it('should handle null lastReaderUrl', async () => {
      await store.init();
      await store.update({ lastReaderUrl: null });

      expect(store.get().lastReaderUrl).toBeNull();
    });

    it('should handle numeric zoom changes', async () => {
      await store.init();

      await store.update({ zoom: 1.5 });
      expect(store.get().zoom).toBe(1.5);

      await store.update({ zoom: 0.5 });
      expect(store.get().zoom).toBe(0.5);
    });

    it('should handle boolean toggle', async () => {
      await store.init();

      expect(store.get().readerWide).toBe(false);

      await store.update({ readerWide: true });
      expect(store.get().readerWide).toBe(true);

      await store.update({ readerWide: false });
      expect(store.get().readerWide).toBe(false);
    });
  });
});
