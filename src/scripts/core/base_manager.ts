/**
 * 基础管理器类
 *
 * 所有管理器都应继承此类，获得：
 * 1. 自动生成的唯一 ID
 * 2. 自动事件监听器管理
 * 3. destroy 时自动清理
 * 4. 便捷的事件订阅方法
 */

import { EventBus, Events, type EventName, type ListenerOptions } from './event_bus';

let nextManagerId = 0;

/**
 * 抽象管理器基类
 */
export abstract class BaseManager {
  /**
   * 唯一模块 ID（用于事件监听器管理和清理）
   */
  public readonly moduleId: string;

  /**
   * 是否已销毁
   */
  protected destroyed = false;

  /**
   * AbortController（用于一次性取消所有异步操作）
   */
  protected abortController: AbortController | null = null;

  constructor() {
    // 生成唯一 ID：类名_序号
    const className = this.constructor.name;
    this.moduleId = `${className}_${++nextManagerId}`;

    // 创建 AbortController
    this.abortController = new AbortController();
  }

  /**
   * 订阅事件（自动关联到当前模块）
   * @returns 取消订阅函数
   */
  protected on<T = any>(
    event: EventName,
    callback: (data: T) => void,
    options?: Omit<ListenerOptions, 'signal' | 'moduleId'>
  ): () => void {
    if (this.destroyed) {
      console.warn(`[${this.moduleId}] 尝试在已销毁的模块上订阅事件: ${event}`);
      return () => {};
    }

    return EventBus.on(event, callback, {
      ...options,
      signal: this.abortController?.signal,
      moduleId: this.moduleId,  // 传入当前模块 ID
    });
  }

  /**
   * 订阅事件（带历史回放）
   * 如果事件在订阅前已触发过，会立即用最近的数据调用回调
   */
  protected onWithHistory<T = any>(
    event: EventName,
    callback: (data: T) => void
  ): () => void {
    if (this.destroyed) {
      console.warn(`[${this.moduleId}] 尝试在已销毁的模块上订阅事件: ${event}`);
      return () => {};
    }

    return EventBus.onWithHistory(event, callback, {
      signal: this.abortController?.signal,
      moduleId: this.moduleId,  // 传入当前模块 ID
    });
  }

  /**
   * 订阅一次性事件
   */
  protected once<T = any>(event: EventName, callback: (data: T) => void): () => void {
    return this.on(event, callback, { once: true });
  }

  /**
   * 触发事件
   */
  protected emit<T = any>(event: EventName, data?: T): void {
    if (this.destroyed) {
      console.warn(`[${this.moduleId}] 尝试在已销毁的模块上触发事件: ${event}`);
      return;
    }
    EventBus.emit(event, data);
  }

  /**
   * 销毁管理器
   * 子类可以 override 并调用 super.destroy()
   */
  destroy(): void {
    if (this.destroyed) {
      console.warn(`[${this.moduleId}] 模块已销毁，重复调用 destroy()`);
      return;
    }

    // 取消所有 AbortSignal
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // 清理事件总线中的所有监听器
    EventBus.cleanup(this.moduleId);

    this.destroyed = true;
  }

  /**
   * 检查是否已销毁
   */
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

// 单独导出 Events 和 EventBus，避免循环导入
export { Events } from './event_bus';
