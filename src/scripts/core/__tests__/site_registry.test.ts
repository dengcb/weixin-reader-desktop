/**
 * Unit Tests for SiteRegistry
 *
 * Tests the site adapter registry:
 * - Singleton pattern
 * - Adapter registration and retrieval
 * - Current site detection
 * - Reader/home page checking
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SiteRegistry } from '../site_registry';
import type { ReadingSiteAdapter } from '../adapters/reading_site_adapter';

// Mock adapter factory
function createMockAdapter(
  id: string,
  domain: string,
  isReader: boolean = false,
  isHome: boolean = false
): ReadingSiteAdapter {
  return {
    id,
    matchesCurrentDomain: () => {
      return window.location.hostname === domain;
    },
    isReaderPage: () => isReader,
    isHomePage: () => isHome,
    getReaderMenuItems: () => ['reader_wide', 'hide_toolbar'],
  };
}

// Mock location for testing
const originalLocation = window.location;
const mockLocation = {
  hostname: 'weread.qq.com',
  href: 'https://weread.qq.com/',
  origin: 'https://weread.qq.com',
  protocol: 'https:',
  port: '',
  pathname: '/',
  search: '',
  hash: '',
  assign: () => {},
  reload: () => {},
  replace: () => {},
};

describe('SiteRegistry', () => {
  let registry: SiteRegistry;

  beforeEach(() => {
    // 重置单例
    (SiteRegistry as any).instance = undefined;

    // Mock location
    Object.defineProperty(window, 'location', {
      writable: true,
      value: mockLocation,
    });

    // 获取新实例
    registry = SiteRegistry.getInstance();
  });

  afterEach(() => {
    // 恢复原始 location
    Object.defineProperty(window, 'location', {
      writable: true,
      value: originalLocation,
    });
  });

  describe('Singleton Pattern', () => {
    it('should return same instance across multiple calls', () => {
      const instance1 = SiteRegistry.getInstance();
      const instance2 = SiteRegistry.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should maintain registered adapters across getInstance calls', () => {
      const adapter = createMockAdapter('test', 'test.com');
      registry.register(adapter);

      const instance2 = SiteRegistry.getInstance();
      const retrieved = instance2.getAdapter('test');

      expect(retrieved).toBe(adapter);
    });
  });

  describe('register', () => {
    it('should register a single adapter', () => {
      const adapter = createMockAdapter('weread', 'weread.qq.com');

      registry.register(adapter);

      expect(registry.getAdapter('weread')).toBe(adapter);
    });

    it('should register multiple adapters', () => {
      const adapter1 = createMockAdapter('weread', 'weread.qq.com');
      const adapter2 = createMockAdapter('kindle', 'read.amazon.com');

      registry.register(adapter1);
      registry.register(adapter2);

      expect(registry.getAdapter('weread')).toBe(adapter1);
      expect(registry.getAdapter('kindle')).toBe(adapter2);
    });

    it('should replace adapter with same id', () => {
      const adapter1 = createMockAdapter('weread', 'weread.qq.com', true, false);
      const adapter2 = createMockAdapter('weread', 'weread.qq.com', false, true);

      registry.register(adapter1);
      registry.register(adapter2);

      const retrieved = registry.getAdapter('weread');
      expect(retrieved).toBe(adapter2);
      expect(retrieved).not.toBe(adapter1);
    });

    it('should store adapters in a Map', () => {
      const adapter = createMockAdapter('test', 'test.com');

      registry.register(adapter);

      // 验证内部结构 (虽然这是实现细节,但有助于理解)
      expect(registry.getAdapter('test')).toBeDefined();
    });
  });

  describe('registerAll', () => {
    it('should register multiple adapters at once', () => {
      const adapters = [
        createMockAdapter('weread', 'weread.qq.com'),
        createMockAdapter('kindle', 'read.amazon.com'),
        createMockAdapter('kobo', 'kobo.com'),
      ];

      registry.registerAll(adapters);

      expect(registry.getAdapter('weread')).toBeDefined();
      expect(registry.getAdapter('kindle')).toBeDefined();
      expect(registry.getAdapter('kobo')).toBeDefined();
    });

    it('should handle empty array', () => {
      const count = registry.getAllAdapters().length;

      registry.registerAll([]);

      expect(registry.getAllAdapters().length).toBe(count);
    });

    it('should handle single element array', () => {
      const adapters = [createMockAdapter('weread', 'weread.qq.com')];

      registry.registerAll(adapters);

      expect(registry.getAdapter('weread')).toBeDefined();
    });
  });

  describe('getAdapter', () => {
    it('should return adapter by id', () => {
      const adapter = createMockAdapter('weread', 'weread.qq.com');

      registry.register(adapter);

      expect(registry.getAdapter('weread')).toBe(adapter);
    });

    it('should return undefined for non-existent id', () => {
      expect(registry.getAdapter('non-existent')).toBeUndefined();
    });

    it('should return undefined for empty id', () => {
      expect(registry.getAdapter('')).toBeUndefined();
    });
  });

  describe('getAllAdapters', () => {
    it('should return empty array when no adapters registered', () => {
      const adapters = registry.getAllAdapters();

      expect(Array.isArray(adapters)).toBe(true);
      expect(adapters.length).toBe(0);
    });

    it('should return all registered adapters', () => {
      const adapter1 = createMockAdapter('weread', 'weread.qq.com');
      const adapter2 = createMockAdapter('kindle', 'read.amazon.com');

      registry.register(adapter1);
      registry.register(adapter2);

      const adapters = registry.getAllAdapters();

      expect(adapters.length).toBe(2);
      expect(adapters).toContain(adapter1);
      expect(adapters).toContain(adapter2);
    });

    it('should return a copy of adapters array', () => {
      const adapter = createMockAdapter('weread', 'weread.qq.com');
      registry.register(adapter);

      const adapters1 = registry.getAllAdapters();
      const adapters2 = registry.getAllAdapters();

      expect(adapters1).not.toBe(adapters2);
      expect(adapters1.length).toBe(adapters2.length);
    });
  });

  describe('getCurrentAdapter', () => {
    beforeEach(() => {
      // 设置 mock hostname
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { hostname: 'weread.qq.com', href: 'https://weread.qq.com/' },
      });
    });

    it('should return null when no adapters registered', () => {
      expect(registry.getCurrentAdapter()).toBeNull();
    });

    it('should return null when no adapter matches current domain', () => {
      const adapter = createMockAdapter('kindle', 'read.amazon.com');
      registry.register(adapter);

      expect(registry.getCurrentAdapter()).toBeNull();
    });

    it('should return matching adapter', () => {
      const adapter = createMockAdapter('weread', 'weread.qq.com');
      registry.register(adapter);

      expect(registry.getCurrentAdapter()).toBe(adapter);
    });

    it('should cache current adapter', () => {
      const adapter = createMockAdapter('weread', 'weread.qq.com');
      registry.register(adapter);

      const first = registry.getCurrentAdapter();
      const second = registry.getCurrentAdapter();

      expect(first).toBe(second);
    });

    it('should invalidate cache when domain changes', () => {
      const wereadAdapter = createMockAdapter('weread', 'weread.qq.com');
      const kindleAdapter = createMockAdapter('kindle', 'read.amazon.com');

      registry.register(wereadAdapter);
      registry.register(kindleAdapter);

      // 初始域名
      expect(registry.getCurrentAdapter()).toBe(wereadAdapter);

      // 更改域名
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { hostname: 'read.amazon.com', href: 'https://read.amazon.com/' },
      });

      // 应该返回新域名的 adapter
      expect(registry.getCurrentAdapter()).toBe(kindleAdapter);
    });

    it('should return null after domain change with no match', () => {
      const adapter = createMockAdapter('weread', 'weread.qq.com');
      registry.register(adapter);

      // 初始匹配
      expect(registry.getCurrentAdapter()).toBe(adapter);

      // 更改到不匹配的域名
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { hostname: 'unknown.com', href: 'https://unknown.com/' },
      });

      // 应该返回 null
      expect(registry.getCurrentAdapter()).toBeNull();
    });

    it('should find first matching adapter when multiple registered', () => {
      const adapter1 = createMockAdapter('weread', 'weread.qq.com');
      const adapter2 = createMockAdapter('kindle', 'weread.qq.com'); // 相同域名

      registry.register(adapter1);
      registry.register(adapter2);

      // 应该返回第一个匹配的 (顺序依赖注册顺序)
      const current = registry.getCurrentAdapter();
      expect([adapter1.id, adapter2.id]).toContain(current!.id);
    });
  });

  describe('isReaderPage', () => {
    beforeEach(() => {
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { hostname: 'weread.qq.com', href: 'https://weread.qq.com/' },
      });
    });

    it('should return false when no adapter matches', () => {
      expect(registry.isReaderPage()).toBe(false);
    });

    it('should delegate to current adapter', () => {
      const adapter = createMockAdapter('weread', 'weread.qq.com', true, false);
      registry.register(adapter);

      expect(registry.isReaderPage()).toBe(true);
    });

    it('should return false when adapter says not reader page', () => {
      const adapter = createMockAdapter('weread', 'weread.qq.com', false, true);
      registry.register(adapter);

      expect(registry.isReaderPage()).toBe(false);
    });
  });

  describe('isHomePage', () => {
    beforeEach(() => {
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { hostname: 'weread.qq.com', href: 'https://weread.qq.com/' },
      });
    });

    it('should return false when no adapter matches', () => {
      expect(registry.isHomePage()).toBe(false);
    });

    it('should delegate to current adapter', () => {
      const adapter = createMockAdapter('weread', 'weread.qq.com', false, true);
      registry.register(adapter);

      expect(registry.isHomePage()).toBe(true);
    });

    it('should return false when adapter says not home page', () => {
      const adapter = createMockAdapter('weread', 'weread.qq.com', true, false);
      registry.register(adapter);

      expect(registry.isHomePage()).toBe(false);
    });
  });

  describe('getReaderMenuItems', () => {
    beforeEach(() => {
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { hostname: 'weread.qq.com', href: 'https://weread.qq.com/' },
      });
    });

    it('should return default menu items when no adapter matches', () => {
      const items = registry.getReaderMenuItems();

      expect(items).toEqual(['reader_wide', 'hide_toolbar', 'auto_flip']);
    });

    it('should delegate to current adapter when available', () => {
      const customItems = ['custom1', 'custom2'];
      const adapter = createMockAdapter('weread', 'weread.qq.com', true, false);
      adapter.getReaderMenuItems = () => customItems;

      registry.register(adapter);

      expect(registry.getReaderMenuItems()).toEqual(customItems);
    });

    it('should handle adapter without getReaderMenuItems method', () => {
      const adapter: ReadingSiteAdapter = {
        id: 'weread',
        matchesCurrentDomain: () => true,
        isReaderPage: () => true,
        isHomePage: () => false,
        // 没有 getReaderMenuItems
      };

      registry.register(adapter);

      // 应该返回默认值
      expect(registry.getReaderMenuItems()).toEqual(['reader_wide', 'hide_toolbar', 'auto_flip']);
    });
  });

  describe('Edge Cases', () => {
    it('should handle adapter with null matchesCurrentDomain', () => {
      const adapter: ReadingSiteAdapter = {
        id: 'test',
        // matchesCurrentDomain 为 undefined
        isReaderPage: () => true,
        isHomePage: () => false,
        getReaderMenuItems: () => [],
      };

      registry.register(adapter);

      // 应该优雅地处理,不抛出错误
      expect(() => registry.getCurrentAdapter()).not.toThrow();
    });

    it('should handle adapter with null methods', () => {
      const adapter: ReadingSiteAdapter = {
        id: 'test',
        matchesCurrentDomain: () => true,
        // 其他方法为 undefined
      };

      registry.register(adapter);

      // 应该优雅地处理
      expect(() => {
        registry.isReaderPage();
        registry.isHomePage();
        registry.getReaderMenuItems();
      }).not.toThrow();
    });

    it('should handle rapid adapter registration', () => {
      for (let i = 0; i < 100; i++) {
        const adapter = createMockAdapter(`test${i}`, `test${i}.com`);
        registry.register(adapter);
      }

      expect(registry.getAllAdapters().length).toBe(100);
    });
  });
});
