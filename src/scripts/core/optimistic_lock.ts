/**
 * Optimistic Lock - Version-based concurrency control
 *
 * A simple but robust optimistic locking mechanism for managing state
 * that can be updated from multiple sources (frontend, backend, other windows).
 *
 * How it works:
 * 1. Each state has a version number (monotonically increasing)
 * 2. Local updates increment the version and send to backend
 * 3. Backend rejects updates with stale versions
 * 4. External updates only apply if their version is newer
 *
 * This prevents race conditions where concurrent updates overwrite each other.
 *
 * @example
 * const lock = new OptimisticLock({ data: "test" }, 0);
 *
 * // Local update
 * const result = lock.tryUpdate({ data: "updated" });
 * // result = { success: true, version: 1, data: { data: "updated" } }
 *
 * // External update from backend (only if version is newer)
 * lock.loadFromExternal({ data: "external" }, 2);
 * // lock.getData() = { data: "external" }, version = 2
 *
 * // Attempt to load stale external data (rejected)
 * lock.loadFromExternal({ data: "stale" }, 1);
 * // getData() still returns version 2 (stale version 1 was ignored)
 */

export type LockResult<T> = {
  success: boolean;
  version: number;
  data: T;
};

export class OptimisticLock<T extends { _version?: number }> {
  private data: T;
  private version: number;

  constructor(initialData: T, initialVersion: number = 0) {
    this.data = initialData;
    this.version = initialVersion;
    // Ensure version is set in data
    this.data._version = this.version;
  }

  /**
   * Get current data (readonly copy)
   */
  getData(): T {
    return { ...this.data };
  }

  /**
   * Get current version number
   */
  getVersion(): number {
    return this.version;
  }

  /**
   * Attempt a local update with optimistic locking
   *
   * @param partialUpdate - Partial data to update
   * @returns Result with success status, new version, and updated data
   *
   * @example
   * const result = lock.tryUpdate({ name: "new" });
   * if (result.success) {
   *   console.log("Updated to version", result.version);
   * }
   */
  tryUpdate(partialUpdate: Partial<T>): LockResult<T> {
    const newVersion = this.version + 1;

    // Apply update with new version
    const newData: T = {
      ...this.data,
      ...partialUpdate,
      _version: newVersion
    };

    // Update internal state
    this.data = newData;
    this.version = newVersion;

    return {
      success: true,
      version: newVersion,
      data: this.getData()
    };
  }

  /**
   * Load data from external source (backend, other window)
   * Only applies if external version is newer or equal (prevents losing updates)
   *
   * @param externalData - Data from external source
   * @param externalVersion - Version from external source
   * @returns true if data was loaded, false if rejected (stale version)
   *
   * @example
   * // Newer version - accepted
   * lock.loadFromExternal({ value: 5 }, 10); // true
   *
   * // Same version - accepted (idempotent)
   * lock.loadFromExternal({ value: 5 }, 5); // true
   *
   * // Older version - rejected
   * lock.loadFromExternal({ value: 3 }, 3); // false
   */
  loadFromExternal(externalData: T, externalVersion: number): boolean {
    // Only accept if external version is >= local version
    if (externalVersion >= this.version) {
      this.data = {
        ...externalData,
        _version: externalVersion
      };
      this.version = externalVersion;
      return true;
    }

    // Reject stale version
    return false;
  }

  /**
   * Check if local data is stale compared to external version
   *
   * @param externalVersion - Version to compare against
   * @returns true if local version is older than external
   */
  isStale(externalVersion: number): boolean {
    return externalVersion > this.version;
  }

  /**
   * Force set data and version (use with caution, only for initialization)
   *
   * @param data - New data
   * @param version - New version
   */
  forceSet(data: T, version: number): void {
    this.data = { ...data, _version: version };
    this.version = version;
  }
}
