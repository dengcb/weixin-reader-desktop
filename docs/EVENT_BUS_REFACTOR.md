# 事件与生命周期架构

本文描述现行的 `EventBus`、`BaseManager` 和资源释放规则。它们服务于 `AppRuntime` 的统一生命周期，而不是独立的“事件总线重构实验”。

## 文件与职责

| 文件 | 职责 |
|---|---|
| `src/scripts/core/event_bus.ts` | 事件订阅、有限历史、错误隔离、模块清理 |
| `src/scripts/core/base_manager.ts` | 为 Manager 提供 AbortSignal、moduleId 和自动订阅清理 |
| `src/scripts/core/app_runtime.ts` | 创建 Managers，页面销毁时逆序释放整个注入层 |
| `src/scripts/core/plugin_api.ts` | 登记并释放插件样式、插件事件和订阅 |
| `src/scripts/core/site_context.ts` | 管理可重启的 MutationObserver 和双栏订阅 |

## 事件分类

`Events` 中的核心事件：

| 事件 | 类型 | 是否保存历史 | 主要消费者 |
|---|---|---:|---|
| `ROUTE_CHANGED` | 状态 | 是 | Managers、ProgressTracker |
| `TITLE_CHANGED` | 状态 | 是 | 标题相关模块 |
| `PROGRESS_UPDATED` | 状态 | 是 | ProgressBar |
| `DOUBLE_COLUMN_CHANGED` | 状态 | 是 | 布局相关模块 |
| `SETTINGS_UPDATED` | 状态 | 是 | 设置同步 |
| `CHAPTER_CHANGED` | 瞬时 | 否 | ProgressTracker、ProgressBar |
| `PAGE_TURN_DIRECTION` | 瞬时 | 否 | ProgressTracker |
| `TAURI_WINDOW_EVENT` | 瞬时 | 否 | 窗口事件消费者 |

每个状态事件最多保留 10 条历史。瞬时翻页事件不保存历史，避免长时间阅读时积累无价值对象。

初始路由必须发布一次带历史的 `ROUTE_CHANGED`。这样应用启动时已经位于阅读页，晚创建的 Manager 也能立即进入正确状态。

## API

```typescript
EventBus.on(event, callback, options?): () => void
EventBus.onWithHistory(event, callback, options?): () => void
EventBus.once(event, callback): () => void
EventBus.emit(event, data)
EventBus.getLatestEvent(event)
EventBus.getEventHistory(event)
EventBus.cleanup(moduleId)
EventBus.clearHistory(event?)
EventBus.clearHistoryByPrefix(prefix)
EventBus.getListenerCount()
EventBus.getStats()
```

### onWithHistory

`onWithHistory` 会先同步回放最近状态，再订阅未来事件。历史回调抛错会被隔离，不影响订阅流程。

若同时指定 `once`，并且历史已经回放，则不会再注册未来监听器。

### once

once 监听器在调用用户回调之前从集合中移除。因此即使回调抛错或在回调中重入 `emit`，也只会执行一次。

### emit

`emit` 的顺序是：

1. 若属于状态事件，先记录有限历史。
2. 复制当前监听器集合。
3. 在回调前移除 once 监听器。
4. 分别执行回调并隔离异常。
5. 清除空监听器集合。

一个监听器抛错不会阻断同事件的其他监听器。

## BaseManager 用法

继承 `BaseManager` 的模块应优先使用辅助方法：

```typescript
class ExampleManager extends BaseManager {
  constructor() {
    super();
    this.onWithHistory(Events.ROUTE_CHANGED, route => {
      // 初始化时可立即收到最后一次路由状态
    });
  }

  destroy(): void {
    // 先释放本类拥有的 DOM、timer、observer 等资源
    super.destroy();
  }
}
```

`BaseManager` 为每个实例创建唯一 moduleId 和 AbortController。`destroy()` 会 abort 并调用 `EventBus.cleanup(moduleId)`。

## 非 EventBus 资源

EventBus 只能清理自己登记的监听器。以下资源仍必须由所有者保存句柄并释放：

- `window` / `document` / DOM `addEventListener`。
- Tauri `listen()` 返回的取消函数。
- `MutationObserver`。
- `setTimeout` / `setInterval`。
- `requestAnimationFrame`。
- `SettingsStore.subscribe()`。
- 动态模块的 Blob URL。
- 注入的 style 节点。
- 临时覆盖的 `window.open`、`matchMedia` 等原生钩子。

如果异步注册可能在销毁后才完成，必须使用 generation 或 destroyed 检查，并立即执行迟到的取消函数。

## AppRuntime 的释放顺序

`AppRuntime` 保存所有 Manager 的 `destroy()` 句柄，并在 `pagehide` 时：

1. 使热重载 generation 失效。
2. 移除 pagehide、性能采样和 Tauri 插件更新监听。
3. 逆序销毁 Managers。
4. 销毁 PluginLoader，触发活动插件 `onUnload()`。
5. 销毁 SiteContext。
6. 销毁 SettingsStore。
7. 清除可丢弃事件历史和调试全局。

销毁过程幂等；任一子模块销毁失败会记录错误，但不会阻止其他资源继续释放。

## 插件资源

插件通过 Plugin API 创建的资源由宿主登记：

- 样式 ID 自动加 `plugin-<id>-` 前缀。
- 事件自动加 `plugin:<id>:` 前缀。
- settings 订阅和事件取消函数进入插件清理集合。
- once 回调执行后会同时移除自己的清理记录。
- 卸载时清理全部登记资源和对应可丢弃历史。

插件自行直接创建的 DOM 监听器、Observer 或 timer 仍应在 `onUnload()` 中释放。

## SiteContext Observer

双栏观察器遵循以下不变量：

- 同时最多存在一个 `MutationObserver` 实例。
- `startObserving()` 重复调用不会重复绑定。
- `stopObserving()` 会 disconnect 并清掉 throttle timer，但保留可重新绑定能力。
- DOM 尚未准备好时只登记一个 `DOMContentLoaded` 回调。
- 插件热重载后 `invalidate()` 清除缓存并重新检测。
- 页面销毁时清空所有双栏订阅和单例引用。

## 翻页与进度事件

手动滑动、遥控/键盘和自动翻页都必须在执行站点翻页前发布：

```typescript
EventBus.emit(Events.PAGE_TURN_DIRECTION, { direction: 'forward' });
runtime.nextPage();
```

这条事件是 ProgressTracker 与底部进度条同步的公共契约。自动翻页曾只调用 `nextPage()`，导致隐藏导航栏时底部进度不刷新；现已统一到同一事件路径。不要把它改成历史事件。

## ProgressBar 的 DOM 自恢复

ProgressBar 使用 `onWithHistory(PROGRESS_UPDATED)` 缓存最近进度。微信读书重绘章节 DOM 后：

- 若进度条仍应显示但节点已丢失，重新创建。
- 新节点直接使用缓存值，不会先回到 0。
- 章节变化后使用既有 200 ms 延迟等待页面重绘。
- 销毁时取消 timer 并移除进度条节点。

这些只属于生命周期和 DOM 容错，不修改阅读进度算法。

## 性能规则

- 状态历史上限固定为 10；不要为高频瞬时事件开启历史。
- 回调去重依赖函数引用；需要取消订阅时保存稳定引用或返回的取消函数。
- 不在 EventBus 中保存大 DOM 节点、Response、完整资源列表等对象。
- 插件卸载时清理自己的事件前缀历史。
- AppRuntime 的性能诊断只采样一次，保留最慢五项，采样后立即移除错误监听器。

## 回归测试

相关测试：

- `event_bus.test.ts`：once 异常、历史回放、有限历史、瞬时事件、moduleId 和 AbortSignal。
- `plugin_lifecycle.test.ts`：样式、事件、Blob URL 和热重载残留。
- `site_runtime.test.ts`：初始站点、统一上下文、Observer 停止/恢复。
- `ipc_manager.test.ts`：初始阅读页历史路由。
- `manager_behavior.test.ts`：翻页、自动翻页进度事件、滚动、光标和主题生命周期。

运行：

```bash
bun test
bun run typecheck
```

## 维护检查表

新增或修改 Manager 时确认：

- 是否只通过 `SiteContext` 访问站点。
- 所有订阅是否保存取消函数或继承 BaseManager。
- 所有 timer、RAF、Observer 和 DOM listener 是否可释放。
- 异步初始化是否处理“注册完成前已经销毁”。
- 瞬时事件是否误加历史。
- once 回调抛错或重入时是否仍只执行一次。
- 热重载后旧插件样式、监听器和实例是否全部消失。
