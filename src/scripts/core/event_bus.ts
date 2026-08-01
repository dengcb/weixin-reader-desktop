/**
 * 事件总线 - 统一的事件分发系统
 *
 * 设计原则：
 * 1. 自动去重：同一回调只会注册一次
 * 2. 自动清理：模块销毁时自动清理其所有监听器
 * 3. 延迟订阅：支持订阅"过去的事件"，解决初始化顺序问题
 * 4. 类型安全：完整的事件类型定义
 * 5. 健壮性：处理所有边界情况和时序问题
 */

export type BaseEventType = {
  [key: string]: any;
};

/**
 * 事件监听器选项
 */
export interface ListenerOptions {
  /** 是否只触发一次 */
  once?: boolean;
  /** 是否使用 WeakRef，当模块不存在时自动清理（需要模块支持） */
  weak?: boolean;
  /** 信号：用于批量取消监听 */
  signal?: AbortSignal;
}

/**
 * 事件监听器包装
 */
interface ListenerWrapper {
  callback: (...args: any[]) => void;
  once: boolean;
  moduleId: string | null;
}

/**
 * 事件总线单例
 */
class EventBusImpl {
  // 事件名 -> 监听器集合（使用 Set 自动去重）
  private listeners = new Map<string, Set<ListenerWrapper>>();

  // 事件历史（用于延迟订阅）
  private eventHistory = new Map<string, { data: any; timestamp: number }[]>();

  // 历史记录最大数量
  private readonly MAX_HISTORY = 10;

  // 只有状态事件需要延迟订阅；翻页等瞬时事件不保留。
  private readonly historyEvents = new Set([
    'ipc:route-changed',
    'ipc:title-changed',
    'wxrd:progress-updated',
    'wxrd:double-column-changed',
    'settings-updated',
  ]);

  // 当前模块 ID（用于自动关联监听器）
  private currentModuleId: string | null = null;

  /**
   * 设置当前模块上下文
   */
  setModuleContext(moduleId: string): void {
    this.currentModuleId = moduleId;
  }

  clearModuleContext(): void {
    this.currentModuleId = null;
  }

  /**
   * 订阅事件
   * @param event 事件名
   * @param callback 回调函数
   * @param options 选项
   * @param moduleId 模块 ID（用于清理）
   * @returns 取消订阅函数
   */
  on<T = any>(
    event: string,
    callback: (data: T) => void,
    options: ListenerOptions & { moduleId?: string } = {}
  ): () => void {
    const { once = false, signal, moduleId = this.currentModuleId } = options;

    // 🔧 修复漏洞 3：检查 signal 是否已经 aborted
    if (signal?.aborted) {
      console.debug(`[EventBus] Signal already aborted, skip subscription: ${event}`);
      return () => {}; // 返回空函数，避免后续调用出错
    }

    // 检查是否已存在相同的监听器
    let eventListeners = this.listeners.get(event);
    if (!eventListeners) {
      eventListeners = new Set();
      this.listeners.set(event, eventListeners);
    }

    // 创建包装器
    const wrapper: ListenerWrapper = {
      callback,
      once,
      moduleId: moduleId,  // 使用参数传入的 moduleId，而不是全局 context
    };

    // 🔧 修复漏洞 7：只检查 callback 是否相同，不检查 moduleId
    // 同一个回调函数只能注册一次，无论 moduleId 是什么
    for (const existing of eventListeners) {
      if (existing.callback === callback) {
        console.debug(`[EventBus] 监听器已存在，跳过: ${event}`);
        return () => this.off(event, callback);
      }
    }

    eventListeners.add(wrapper);

    // 如果提供了 signal，监听 abort 事件
    if (signal) {
      signal.addEventListener('abort', () => {
        this.off(event, callback);
      }, { once: true });
    }

    // 返回取消订阅函数
    return () => this.off(event, callback);
  }

  /**
   * 订阅事件（带历史回放）
   * 如果事件在订阅前已触发过，会立即用最近的数据调用回调
   *
   * 🔧 修复漏洞 2：once + onWithHistory 的特殊处理
   */
  onWithHistory<T = any>(
    event: string,
    callback: (data: T) => void,
    options: ListenerOptions & { moduleId?: string } = {}
  ): () => void {
    const { once = false } = options;

    // 🔧 修复漏洞 1：先尝试回放历史，捕获异常
    const history = this.eventHistory.get(event);
    let historyReplayed = false;

    if (history && history.length > 0) {
      const latest = history[history.length - 1];
      console.debug(`[EventBus] 回放历史事件: ${event}`, latest.data);

      historyReplayed = true;
      try {
        callback(latest.data);
      } catch (error) {
        console.error(`[EventBus] 历史回放时回调执行出错:`, error);
      }
    }

    // 🔧 修复漏洞 2：如果是 once 且已经回放了历史，不再订阅未来事件
    if (once && historyReplayed) {
      console.debug(`[EventBus] once + onWithHistory 且历史已回放，跳过订阅: ${event}`);
      return () => {}; // 返回空的取消函数
    }

    // 订阅未来的事件
    const unsubscribe = this.on(event, callback, options);

    return unsubscribe;
  }

  /**
   * 订阅一次性事件
   */
  once<T = any>(event: string, callback: (data: T) => void): () => void {
    return this.on(event, callback, { once: true });
  }

  /**
   * 取消订阅
   */
  off<T = any>(event: string, callback: (data: T) => void): void {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners) return;

    for (const wrapper of eventListeners) {
      if (wrapper.callback === callback) {
        eventListeners.delete(wrapper);
        break;
      }
    }

    // 如果没有监听器了，清理
    if (eventListeners.size === 0) {
      this.listeners.delete(event);
    }
  }

  /**
   * 触发事件
   */
  emit<T = any>(event: string, data?: T): void {
    console.debug(`[EventBus] 触发事件: ${event}`, data);

    // 🔧 修复漏洞 5：先记录历史，再触发监听器
    // 这样监听器里同步调用 onWithHistory 也能拿到当前事件
    this.recordHistory(event, data);

    const eventListeners = this.listeners.get(event);
    if (!eventListeners || eventListeners.size === 0) {
      console.debug(`[EventBus] 事件 ${event} 没有监听器`);
      return;
    }

    // 复制一份，避免在遍历时修改
    const listeners = Array.from(eventListeners);

    for (const wrapper of listeners) {
      // once 必须在回调前移除，回调抛错或重入 emit 也不会残留。
      if (wrapper.once) eventListeners.delete(wrapper);
      try {
        wrapper.callback(data);
      } catch (error) {
        console.error(`[EventBus] 事件 ${event} 的监听器执行出错:`, error);
      }
    }

    if (eventListeners.size === 0) this.listeners.delete(event);
  }

  /**
   * 记录事件历史
   */
  private recordHistory(event: string, data: any): void {
    if (!this.historyEvents.has(event)) return;
    let history = this.eventHistory.get(event);
    if (!history) {
      history = [];
      this.eventHistory.set(event, history);
    }

    history.push({
      data,
      timestamp: Date.now(),
    });

    // 限制历史数量
    if (history.length > this.MAX_HISTORY) {
      history.shift();
    }
  }

  /**
   * 🔧 修复漏洞 6：添加公共 API 获取最近的历史数据
   * 允许用户主动查询历史状态
   */
  getLatestEvent<T = any>(event: string): T | null {
    const history = this.eventHistory.get(event);
    if (!history || history.length === 0) {
      return null;
    }
    return history[history.length - 1].data;
  }

  /**
   * 🔧 修复漏洞 6：获取事件的所有历史记录
   */
  getEventHistory<T = any>(event: string): Array<{ data: T; timestamp: number }> {
    const history = this.eventHistory.get(event);
    return history ? [...history] : []; // 返回副本，防止外部修改
  }

  /**
   * 清理指定模块的所有监听器
   */
  cleanup(moduleId: string): void {
    let cleaned = 0;

    for (const [event, listeners] of this.listeners) {
      for (const wrapper of listeners) {
        if (wrapper.moduleId === moduleId) {
          listeners.delete(wrapper);
          cleaned++;
        }
      }

      // 如果没有监听器了，清理
      if (listeners.size === 0) {
        this.listeners.delete(event);
      }
    }

    if (cleaned > 0) {
      console.debug(`[EventBus] 清理模块 ${moduleId} 的 ${cleaned} 个监听器`);
    }
  }

  /**
   * 清除事件历史
   */
  clearHistory(event?: string): void {
    if (event) {
      this.eventHistory.delete(event);
    } else {
      this.eventHistory.clear();
    }
  }

  clearHistoryByPrefix(prefix: string): void {
    for (const event of this.eventHistory.keys()) {
      if (event.startsWith(prefix)) this.eventHistory.delete(event);
    }
  }

  /**
   * 获取当前监听器数量（调试用）
   */
  getListenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) {
      count += listeners.size;
    }
    return count;
  }

  /**
   * 获取事件统计（调试用）
   */
  getStats(): { [event: string]: number } {
    const stats: { [event: string]: number } = {};
    for (const [event, listeners] of this.listeners) {
      stats[event] = listeners.size;
    }
    return stats;
  }

  /**
   * 🔧 新增：获取所有已记录过的事件名称
   */
  getKnownEvents(): string[] {
    return Array.from(this.eventHistory.keys());
  }
}

// 导出单例
export const EventBus = new EventBusImpl();

/**
 * 事件名称定义
 * 所有事件都在这里定义，避免拼写错误
 */
export const Events = {
  // ========== 路由相关 ==========
  /** 进入/离开阅读页 */
  ROUTE_CHANGED: 'ipc:route-changed',

  /** 章节切换（同本书内 URL 变化） */
  CHAPTER_CHANGED: 'ipc:chapter-changed',

  // ========== 标题相关 ==========
  /** 页面标题变化 */
  TITLE_CHANGED: 'ipc:title-changed',

  // ========== 进度相关 ==========
  /** 章节阅读进度更新 */
  PROGRESS_UPDATED: 'wxrd:progress-updated',

  /** 翻页方向（用于章节切换时的方向判断） */
  PAGE_TURN_DIRECTION: 'wxrd:page-turn-direction',

  // ========== 样式相关 ==========
  /** 双栏模式状态变化 */
  DOUBLE_COLUMN_CHANGED: 'wxrd:double-column-changed',

  // ========== 设置相关 ==========
  /** 设置更新 */
  SETTINGS_UPDATED: 'settings-updated',

  // ========== Tauri 事件 ==========
  /** Tauri 窗口事件 */
  TAURI_WINDOW_EVENT: 'tauri://window-event',
} as const;

export type EventName = typeof Events[keyof typeof Events];
