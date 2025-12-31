/**
 * Unit Tests for OptimisticLock
 *
 * Tests the core optimistic locking mechanism:
 * - Version increment on update
 * - External load only with newer version
 * - Stale version rejection
 * - Concurrent update simulation
 */

import { describe, it, expect } from 'bun:test';
import { OptimisticLock } from '../optimistic_lock';

interface TestData {
  _version?: number;
  value: string;
  count: number;
}

describe('OptimisticLock', () => {
  it('should initialize with version 0', () => {
    const lock = new OptimisticLock<TestData>({ value: 'test', count: 0 }, 0);
    expect(lock.getVersion()).toBe(0);
    expect(lock.getData()).toEqual({ value: 'test', count: 0, _version: 0 });
  });

  it('should initialize with custom version', () => {
    const lock = new OptimisticLock<TestData>({ value: 'test', count: 0 }, 5);
    expect(lock.getVersion()).toBe(5);
  });

  it('should increment version on tryUpdate', () => {
    const lock = new OptimisticLock<TestData>({ value: 'test', count: 0 }, 0);
    const result = lock.tryUpdate({ value: 'updated' });

    expect(result.success).toBe(true);
    expect(result.version).toBe(1);
    expect(result.data).toEqual({ value: 'updated', count: 0, _version: 1 });
    expect(lock.getVersion()).toBe(1);
  });

  it('should increment version multiple times', () => {
    const lock = new OptimisticLock<TestData>({ value: 'test', count: 0 }, 0);

    const result1 = lock.tryUpdate({ value: 'v1' });
    expect(result1.version).toBe(1);

    const result2 = lock.tryUpdate({ value: 'v2' });
    expect(result2.version).toBe(2);

    const result3 = lock.tryUpdate({ count: 5 });
    expect(result3.version).toBe(3);

    expect(lock.getData()).toEqual({ value: 'v2', count: 5, _version: 3 });
  });

  it('should load external data with newer version', () => {
    const lock = new OptimisticLock<TestData>({ value: 'local', count: 0 }, 2);

    const loaded = lock.loadFromExternal({ value: 'external', count: 10 }, 5);

    expect(loaded).toBe(true);
    expect(lock.getVersion()).toBe(5);
    expect(lock.getData()).toEqual({ value: 'external', count: 10, _version: 5 });
  });

  it('should load external data with same version (idempotent)', () => {
    const lock = new OptimisticLock<TestData>({ value: 'local', count: 0 }, 2);

    const loaded = lock.loadFromExternal({ value: 'same', count: 5 }, 2);

    expect(loaded).toBe(true);
    expect(lock.getVersion()).toBe(2);
    expect(lock.getData()).toEqual({ value: 'same', count: 5, _version: 2 });
  });

  it('should reject external data with older version', () => {
    const lock = new OptimisticLock<TestData>({ value: 'local', count: 0 }, 5);

    const loaded = lock.loadFromExternal({ value: 'stale', count: 10 }, 2);

    expect(loaded).toBe(false);
    expect(lock.getVersion()).toBe(5); // Version unchanged
    expect(lock.getData()).toEqual({ value: 'local', count: 0, _version: 5 }); // Data unchanged
  });

  it('should correctly identify stale versions', () => {
    const lock = new OptimisticLock<TestData>({ value: 'test', count: 0 }, 5);

    expect(lock.isStale(10)).toBe(true);  // Newer
    expect(lock.isStale(5)).toBe(false);  // Same
    expect(lock.isStale(3)).toBe(false);  // Older
  });

  it('should force set data and version', () => {
    const lock = new OptimisticLock<TestData>({ value: 'test', count: 0 }, 0);

    lock.forceSet({ value: 'forced', count: 100 }, 999);

    expect(lock.getVersion()).toBe(999);
    expect(lock.getData()).toEqual({ value: 'forced', count: 100, _version: 999 });
  });

  // Simulate concurrent update scenario
  it('should handle concurrent update simulation', () => {
    // Simulate two separate lock instances representing two windows
    const lock1 = new OptimisticLock<TestData>({ value: 'shared', count: 0 }, 0);
    const lock2 = new OptimisticLock<TestData>({ value: 'shared', count: 0 }, 0);

    // Window 1: Update to version 1
    const result1 = lock1.tryUpdate({ value: 'window1-update' });
    expect(result1.version).toBe(1);

    // Window 2: Try to update (also goes to version 1 in reality)
    const result2 = lock2.tryUpdate({ value: 'window2-update' });
    expect(result2.version).toBe(1);

    // Backend receives Window 1's update first (version 1)
    // Then Window 2's update (also version 1) - Backend accepts or rejects based on timing

    // Simulate backend broadcast with version 1
    const backendData = result1.data;
    const backendVersion = result1.version;

    // Both windows load from backend
    lock1.loadFromExternal(backendData, backendVersion);
    lock2.loadFromExternal(backendData, backendVersion);

    // Now both have version 1 with Window 1's data
    expect(lock1.getVersion()).toBe(1);
    expect(lock2.getVersion()).toBe(1);
    expect(lock1.getData().value).toBe('window1-update');
    expect(lock2.getData().value).toBe('window1-update'); // Window 2's update was lost
  });

  // Test race condition prevention
  it('should prevent race condition with version check', () => {
    const lock = new OptimisticLock<TestData>({ value: 'test', count: 0 }, 10);

    // Simulate: Local update to version 11
    const localResult = lock.tryUpdate({ count: 1 });
    expect(localResult.version).toBe(11);

    // Simulate: Backend sends stale data (version 9)
    const staleLoaded = lock.loadFromExternal({ value: 'stale', count: 99 }, 9);
    expect(staleLoaded).toBe(false);

    // Local version and data should be unchanged
    expect(lock.getVersion()).toBe(11);
    expect(lock.getData().count).toBe(1);
    expect(lock.getData().value).toBe('test');
  });
});
