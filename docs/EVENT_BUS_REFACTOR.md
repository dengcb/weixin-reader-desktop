# 事件系统重构说明

## 问题分析

原有监听架构存在以下根本性问题：

1. **多次监听漏洞**：模块重复初始化时，监听器会叠加
2. **清理依赖人工**：每个模块都要手动管理 `destroy()`，容易遗漏
3. **初始化顺序问题**：A 监听 B，但 B 先发事件了，A 就收不到
4. **事件名称散落**：字符串分散在各处，容易拼写错误
5. **时序竞态问题**：多个监听器同时修改状态时，执行顺序不确定
6. **历史状态丢失**：无法主动查询过去发生的事件

## 新架构设计

### 核心文件

```
src/scripts/core/
├── event_bus.ts      # 事件总线（单例）
└── base_manager.ts   # 基础管理器类
```

### 1. EventBus（事件总线）

**职责**：统一的事件分发中心

**核心特性**：

- **自动去重**：同一回调只会注册一次（基于 callback 引用相等性）
- **自动清理**：模块销毁时自动清理其所有监听器
- **延迟订阅**：支持订阅"过去的事件"，解决初始化顺序问题
- **AbortSignal 支持**：信号取消时自动清理监听器
- **异常隔离**：单个监听器抛错不影响其他监听器
- **历史记录**：保留最近 10 次事件数据，支持主动查询
- **原子性保证**：先记录历史，再触发监听器，确保时序正确

**关键方法**：

```typescript
// 订阅事件
EventBus.on(event, callback, options): () => void

// 订阅事件（带历史回放）
EventBus.onWithHistory(event, callback, options): () => void

// 一次性订阅
EventBus.once(event, callback): () => void

// 触发事件
EventBus.emit(event, data)

// 获取最新历史数据
EventBus.getLatestEvent(event): T | null

// 获取所有历史记录
EventBus.getEventHistory(event): Array<{ data: T; timestamp: number }>

// 获取已知事件列表
EventBus.getKnownEvents(): string[]

// 清理模块的所有监听器
EventBus.cleanup(moduleId)

// 清除事件历史
EventBus.clearHistory(event?)
```

### 2. Events（事件名称常量）

所有事件名称统一定义，避免拼写错误：

```typescript
export const Events = {
  // 路由相关
  ROUTE_CHANGED: 'ipc:route-changed',
  CHAPTER_CHANGED: 'ipc:chapter-changed',

  // 标题相关
  TITLE_CHANGED: 'ipc:title-changed',

  // 进度相关
  PROGRESS_UPDATED: 'wxrd:progress-updated',
  PAGE_TURN_DIRECTION: 'wxrd:page-turn-direction',

  // 样式相关
  DOUBLE_COLUMN_CHANGED: 'wxrd:double-column-changed',

  // 设置相关
  SETTINGS_UPDATED: 'settings-updated',

  // Tauri 事件
  TAURI_WINDOW_EVENT: 'tauri://window-event',
} as const;
```

### 3. BaseManager（基础管理器）

**职责**：所有管理器的基类

**核心特性**：

- 自动生成唯一 `moduleId`（基于时间戳和随机数）
- 自动关联监听器到模块
- `destroy()` 时自动清理所有监听器
- 提供便捷的 `on()`, `onWithHistory()`, `once()`, `emit()` 方法

**使用示例**：

```typescript
class MyManager extends BaseManager {
  constructor() {
    super();
    this.init();
  }

  private init() {
    // 监听事件（自动关联到当前模块）
    this.on(Events.ROUTE_CHANGED, (data) => {
      console.log('路由变化:', data);
    });

    // 监听事件（带历史回放，解决初始化顺序问题）
    this.onWithHistory(Events.PROGRESS_UPDATED, (data) => {
      console.log('当前进度:', data);
    });

    // 一次性监听
    this.once(Events.CHAPTER_CHANGED, (data) => {
      console.log('章节首次切换:', data);
    });

    // 触发事件
    this.emit(Events.CUSTOM_EVENT, { foo: 'bar' });
  }

  destroy() {
    // super.destroy() 会自动清理所有监听器
    super.destroy();
  }
}
```

## 已修复的漏洞

EventBus 在实战中发现并修复了 7 个时序和健壮性漏洞：

### 漏洞 1：历史回放时回调抛错导致订阅失败

**问题**：`onWithHistory()` 回放历史时，如果回调抛异常，会导致订阅流程中断

**修复**：用 try-catch 包裹历史回放逻辑

```typescript
try {
  callback(latest.data);
  historyReplayed = true;
} catch (error) {
  console.error(`[EventBus] 历史回放时回调执行出错:`, error);
}
```

### 漏洞 2：once + onWithHistory 导致重复触发

**问题**：使用 `onWithHistory({ once: true })` 时，历史回放触发一次，未来事件再触发一次

**修复**：如果历史已回放且 `once = true`，跳过未来订阅

```typescript
if (once && historyReplayed) {
  console.debug(`[EventBus] once + onWithHistory 且历史已回放，跳过订阅: ${event}`);
  return () => {}; // 返回空的取消函数
}
```

### 漏洞 3：已 aborted 的 signal 导致内存泄漏

**问题**：传入已经 `aborted` 的 `AbortSignal`，监听器仍会注册但永远不会被清理

**修复**：订阅时检查 signal 状态

```typescript
if (signal?.aborted) {
  console.debug(`[EventBus] Signal already aborted, skip subscription: ${event}`);
  return () => {}; // 返回空函数，避免后续调用出错
}
```

### 漏洞 4：监听器执行出错影响其他监听器

**问题**：一个监听器抛异常，后续监听器无法执行

**修复**：每个监听器用 try-catch 隔离

```typescript
for (const wrapper of listeners) {
  try {
    wrapper.callback(data);
  } catch (error) {
    console.error(`[EventBus] 事件 ${event} 的监听器执行出错:`, error);
  }
}
```

### 漏洞 5：emit 后立即 onWithHistory 拿不到数据

**问题**：触发事件后，在监听器内同步调用 `onWithHistory` 拿不到当前事件

**修复**：先记录历史，再触发监听器

```typescript
emit(event: string, data?: T): void {
  // 先记录历史
  this.recordHistory(event, data);

  // 再触发监听器
  const eventListeners = this.listeners.get(event);
  // ...
}
```

### 漏洞 6：无法主动查询历史状态

**问题**：只能被动等待事件触发，无法主动查询过去的状态

**修复**：新增公共 API

```typescript
// 获取最新事件数据
getLatestEvent<T = any>(event: string): T | null

// 获取所有历史记录
getEventHistory<T = any>(event: string): Array<{ data: T; timestamp: number }>

// 获取已知事件列表
getKnownEvents(): string[]
```

### 漏洞 7：重复订阅导致监听器叠加

**问题**：同一个 callback 可能被注册多次（例如模块重新初始化）

**修复**：只检查 callback 引用相等性，自动去重

```typescript
// 同一个回调函数只能注册一次，无论 moduleId 是什么
for (const existing of eventListeners) {
  if (existing.callback === callback) {
    console.debug(`[EventBus] 监听器已存在，跳过: ${event}`);
    return () => this.off(event, callback);
  }
}
```

## 解决的问题

### 1. 多次监听漏洞

**问题**：模块重复初始化时，监听器叠加

**解决**：EventBus 基于 callback 引用自动去重

```typescript
// 即使多次调用，只会注册一次
this.on(Events.ROUTE_CHANGED, this.handleRouteChange);
this.on(Events.ROUTE_CHANGED, this.handleRouteChange); // 自动跳过
```

### 2. 清理依赖人工

**问题**：每个模块都要手动管理 `destroy()`

**解决**：BaseManager 使用 `AbortSignal` 自动清理

```typescript
// 订阅时自动关联 signal
this.on(event, callback, {
  signal: this.abortController.signal,
});

// destroy 时自动触发 abort，取消所有监听器
this.abortController.abort();
```

### 3. 初始化顺序问题

**问题**：A 监听 B，但 B 先发事件了

**解决**：`onWithHistory()` 回放最近的事件

```typescript
// 订阅时立即收到最近的事件数据
this.onWithHistory(Events.ROUTE_CHANGED, (data) => {
  // 如果 ROUTE_CHANGED 已触发过，会立即用最近的数据调用
});
```

**典型场景**：ProgressBar 订阅进度更新

```typescript
// ProgressBar 初始化晚于 ProgressTracker
// 使用 onWithHistory 确保拿到最新进度
this.onWithHistory(Events.PROGRESS_UPDATED, (data: { progress: number }) => {
  this.latestProgress = data.progress;

  if (this.isVisible && this.progressBarElement) {
    this.progressBarElement.style.width = `${data.progress}%`;
  }
});
```

### 4. 事件名称拼写错误

**问题**：字符串分散在各处

**解决**：统一在 `Events` 中定义

```typescript
// 编译时检查，避免拼写错误
this.on(Events.ROUTE_CHANGED, handler);

// 而不是
window.addEventListener('ipc:route-changed', handler); // 容易拼写错误
```

### 5. 时序竞态问题

**问题**：监听器执行顺序不确定，可能读取到过期状态

**解决**：先记录历史，再触发监听器，保证原子性

```typescript
// emit() 的执行顺序：
// 1. 先记录历史
this.recordHistory(event, data);

// 2. 再触发监听器
for (const wrapper of listeners) {
  wrapper.callback(data);
}

// 这样监听器内调用 getLatestEvent() 一定能拿到当前事件
```

### 6. 历史状态丢失

**问题**：无法查询过去发生的事件

**解决**：保留最近 10 次历史，提供查询 API

```typescript
// 主动查询最新进度
const latestProgress = EventBus.getLatestEvent(Events.PROGRESS_UPDATED);

// 查询所有历史记录
const history = EventBus.getEventHistory(Events.PROGRESS_UPDATED);
console.log(`最近 ${history.length} 次进度更新:`, history);

// 查询所有已知事件
const knownEvents = EventBus.getKnownEvents();
console.log('已触发的事件:', knownEvents);
```

## 迁移指南

### 旧代码

```typescript
class OldManager {
  private handler: ((e: Event) => void) | null = null;

  constructor() {
    this.handler = (e) => console.log(e.detail);
    window.addEventListener('ipc:route-changed', this.handler);
  }

  destroy() {
    if (this.handler) {
      window.removeEventListener('ipc:route-changed', this.handler);
    }
  }
}
```

### 新代码

```typescript
class NewManager extends BaseManager {
  constructor() {
    super();
    this.on(Events.ROUTE_CHANGED, (data) => {
      console.log(data);
    });
  }

  // destroy() 自动继承，无需手动实现
}
```

## 已重构的模块

- ✅ `IPCManager` - 路由、标题、滚动监听
- ✅ `ProgressTracker` - 进度跟踪（三级事件系统）
- ✅ `ProgressBar` - 进度条显示（onWithHistory 解决初始化问题）
- ✅ `SwipeHandler` - 手势翻页（emit 翻页方向事件）

## 待重构的模块

- `AppManager`
- `MenuManager`
- `ThemeManager`
- `StyleManager`
- `TurnerManager`

## 实战案例：ProgressBar 的 DOM 自恢复

ProgressBar 在章节切换时会被微信读书清理 DOM，需要自动重建：

```typescript
class ProgressBar extends BaseManager {
  private latestProgress: number = 0;

  private init() {
    // 使用 onWithHistory 确保拿到最新进度
    this.onWithHistory(Events.PROGRESS_UPDATED, (data: { progress: number }) => {
      this.latestProgress = data.progress;

      if (this.isVisible) {
        const existsInDom = document.getElementById('wxrd-progress-bar-container');

        if (!existsInDom) {
          // DOM 不存在，重新创建
          this.show();
        } else if (this.progressBarElement) {
          // DOM 存在，直接更新
          this.progressBarElement.style.width = `${data.progress}%`;
        }
      }
    });

    // 章节切换后延迟重建（等待微信读书 DOM 渲染）
    this.on(Events.CHAPTER_CHANGED, () => {
      if (this.isVisible) {
        setTimeout(() => {
          if (!document.getElementById('wxrd-progress-bar-container')) {
            this.show();
          }
        }, 200);
      }
    });
  }

  private show() {
    // 使用缓存的 latestProgress 创建进度条
    progressBar.style.width = `${this.latestProgress}%`;
  }
}
```

**关键点**：
1. 用 `latestProgress` 缓存最新值
2. 每次更新都检查 DOM 是否存在
3. 章节切换后延迟 200ms 重建（等待微信读书 DOM 渲染完成）

## 实战案例：ProgressTracker 的方向检测

ProgressTracker 需要知道翻页方向来修正进度，但不能依赖异步 API：

```typescript
class ProgressTracker extends BaseManager {
  private lastPageDirection: PageDirection | null = null;

  private init() {
    // 监听来自 SwipeHandler 和 KeyboardHandler 的方向事件
    this.on(Events.PAGE_TURN_DIRECTION, (data: { direction: 'forward' | 'backward' }) => {
      const pageDirection = data.direction === 'forward' ? PageDirection.FORWARD : PageDirection.BACKWARD;
      this.recordPageDirection(pageDirection);
    });
  }

  private recordPageDirection(direction: PageDirection): void {
    this.lastPageDirection = direction;

    // 500ms 后重置（防抖）
    if (this.directionResetTimer) {
      clearTimeout(this.directionResetTimer);
    }
    this.directionResetTimer = setTimeout(() => {
      this.lastPageDirection = null;
    }, 500);
  }

  private async onChapterChange(bookId: string, newUrl: string): Promise<void> {
    if (this.lastPageDirection === null) {
      // 没有方向 → 用户通过目录跳转
      await this.reinitializeAfterJump(bookId);
    } else {
      // 有方向 → 顺序翻页
      const isForward = this.lastPageDirection === PageDirection.FORWARD;
      const newChapterIdx = isForward ? this.currentChapterIdx + 1 : this.currentChapterIdx - 1;
      // ...
    }
  }
}
```

**关键点**：
1. 监听 `PAGE_TURN_DIRECTION` 事件（来自手势和键盘）
2. 用 500ms 防抖记录最后一次方向
3. 章节切换时，根据方向判断是顺序翻页还是目录跳转
4. **绝不调用异步 API**（"异步信息有毒"）

## 注意事项

### 1. DOM 事件仍需手动清理

EventBus 只管理自己的监听器，`window.addEventListener` 和 `document.addEventListener` 需要在 `destroy()` 中手动移除：

```typescript
class MyManager extends BaseManager {
  private wheelHandler = (e: WheelEvent) => { /* ... */ };

  constructor() {
    super();
    window.addEventListener('wheel', this.wheelHandler, { passive: false });
  }

  destroy() {
    window.removeEventListener('wheel', this.wheelHandler);
    super.destroy(); // 清理 EventBus 监听器
  }
}
```

### 2. MutationObserver 需手动断开

```typescript
class MyManager extends BaseManager {
  private observer: MutationObserver;

  constructor() {
    super();
    this.observer = new MutationObserver(() => { /* ... */ });
    this.observer.observe(document.body, { childList: true });
  }

  destroy() {
    this.observer.disconnect();
    super.destroy();
  }
}
```

### 3. 定时器需手动清理

```typescript
class MyManager extends BaseManager {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.timer = setTimeout(() => { /* ... */ }, 1000);
  }

  destroy() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    super.destroy();
  }
}
```

### 4. 避免在监听器内修改 EventBus 状态

不要在监听器内调用 `off()` 或 `cleanup()`，这会导致迭代器失效。如果需要自动移除，使用 `once: true`：

```typescript
// ❌ 错误：会导致迭代器失效
this.on(Events.SOME_EVENT, (data) => {
  this.off(Events.SOME_EVENT, callback); // 不要这样做
});

// ✅ 正确：使用 once
this.once(Events.SOME_EVENT, (data) => {
  // 自动移除
});
```

### 5. 回调函数引用要稳定

去重机制基于 callback 引用相等性，每次都创建新函数会导致重复注册：

```typescript
// ❌ 错误：每次都创建新函数
this.on(Events.SOME_EVENT, (data) => console.log(data));
this.on(Events.SOME_EVENT, (data) => console.log(data)); // 会重复注册

// ✅ 正确：使用稳定的引用
private handler = (data) => console.log(data);

this.on(Events.SOME_EVENT, this.handler);
this.on(Events.SOME_EVENT, this.handler); // 自动跳过
```

## 调试工具

```typescript
// 获取当前监听器统计
EventBus.getStats();
// { 'ipc:route-changed': 2, 'wxrd:progress-updated': 1 }

// 获取监听器总数
EventBus.getListenerCount();
// 3

// 获取所有已知事件
EventBus.getKnownEvents();
// ['ipc:route-changed', 'wxrd:progress-updated', 'wxrd:page-turn-direction']

// 获取最新事件数据
EventBus.getLatestEvent(Events.PROGRESS_UPDATED);
// { progress: 42 }

// 获取事件历史
EventBus.getEventHistory(Events.PROGRESS_UPDATED);
// [{ data: { progress: 30 }, timestamp: 1234567890 }, ...]
```

## 性能考虑

- **历史记录限制**：每个事件最多保留 10 条历史，防止内存泄漏
- **Set 自动去重**：使用 `Set` 存储监听器，查找和去重都是 O(1)
- **防抖机制**：`onWithHistory` 只回放一次，不会重复触发
- **复制数组**：`emit` 时复制监听器数组，允许在回调中修改订阅

## 设计哲学

1. **"异步信息有毒"**：永远不要依赖异步 API 的实时数据做判断，用本地状态 + 事件驱动
2. **"霸王硬上弓"**：当没有完美方案时，用启发式算法（如标题匹配）兜底
3. **健壮性优先**：所有边界情况都要处理，宁可多一层防御也不要让用户看到报错
4. **自动化优先**：能自动化的绝不依赖人工，能声明式的绝不写命令式代码
5. **向后兼容**：新增功能不影响旧代码，漏洞修复不改变公开 API

## 总结

EventBus 从一个简单的发布订阅模式演化成了一个健壮的事件系统，经过实战检验修复了 7 个漏洞，具备了：

- ✅ 自动去重
- ✅ 自动清理
- ✅ 历史回放
- ✅ 异常隔离
- ✅ 时序保证
- ✅ 主动查询
- ✅ 完整的类型安全

它是整个前端架构的基石，所有模块都应该迁移到 BaseManager + EventBus 模式。
