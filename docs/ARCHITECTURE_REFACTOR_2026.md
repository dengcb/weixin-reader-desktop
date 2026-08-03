# 2026 架构重构记录

- 日期：2026-08-01
- 基线：`main` 分支，重构前 HEAD `448adb1`
- 优先级：架构统一 → 生命周期/内存 → Bug → 最低限度安全
- 人工验收：基础真机使用由项目维护者完成，未发现明显异常
- 目的：告诉后来维护者“为什么改、改了什么、哪些边界不能回退”

## 摘要

这次重构把原来并行存在的“站点适配器系统”和“插件系统”合并为一条运行时链路，并把设置文件并发、阅读位置存储、Manager 生命周期和 Tauri 权限收拢到明确的所有者。

最终结构：

```text
Rust 创建远程主窗口并注入 inject.js
  └─ inject.ts
      └─ AppRuntime
          ├─ SettingsStore
          ├─ PluginLoader / PluginRegistry
          │   └─ ReaderSiteRuntime
          ├─ SiteContext
          └─ Managers

Rust 持久化与系统能力
  ├─ SettingsRepository
  ├─ Reading Progress Repository
  ├─ Plugin Manager
  ├─ Menu / Monitor / Updater
  └─ Per-window Capabilities
```

## 重构前的主要问题

### 两套站点架构并行

- `SiteRegistry` 管理旧适配器。
- `PluginRegistry` / `PluginLoader` 管理插件。
- Managers 有时取 adapter，有时取 plugin。
- 微信读书适配器可能重复初始化，外部插件和旧系统可能重复注入样式。
- 新站点需要在多处接线，生命周期没有统一入口。

### 生命周期没有统一所有者

- 各 Manager 自行创建 listener、Tauri listen、Observer、timer、RAF 和订阅。
- 一部分 destroy 漏清理，一部分异步 listener 会在模块销毁后迟到注册。
- 插件热重载没有完整释放旧实例、样式、事件和 Blob URL。
- SiteContext Observer 停止后不能可靠恢复，SPA 与前后台切换可能叠加实例。

### 设置职责分散

- 前端 `SettingsStore` 同时承担状态、文件版本和并发策略。
- 客户端 `OptimisticLock` 无法真正保护 Rust 文件读写。
- 普通设置保存可能覆盖或删除 `pluginConfigs`。
- 插件配置有独立命令，绕开统一设置并发模型。
- 旧设置格式和损坏 JSON 的处理不统一。

### 阅读位置会放大内存与写入

URL 滚动位置保存在 settings 的大 Map 中。每次保存可能克隆前端 Map、序列化并重写整个设置文档；阅读 URL 越多，内存和 IO 成本越高。

### EventBus 与性能诊断长期积累

- 所有事件都可能进入历史，高频翻页事件没有回放价值。
- once 回调抛错时可能残留。
- 性能诊断复制并排序完整资源数组。
- 错误监听器和部分诊断线程存活时间过长。
- 日志轮转策略偏宽。

### Tauri 权限过宽

远程阅读网页和本地设置/编辑器窗口共用一个 Capability，包含 FS、Shell、Updater、Dialog、窗口创建和插件管理等能力。插件路径与压缩包边界也不够严格。

## 一、架构统一

### ReaderSiteRuntime

新增 `src/scripts/core/reader_site_runtime.ts`，作为所有 Manager 唯一可见的站点接口。

微信读书：

- 使用 `WeReadSiteRuntime` 桥接现有 `WeReadAdapter`。
- adapter 改为懒构造，其他域名不会启动微信读书 ProgressTracker。
- 页面行为和样式方法保持原实现；进度代码后续只在明确授权的硬约束外重构。
- 样式所有者为 Manager，避免与插件重复注入。

外部插件：

- 使用 `PluginSiteRuntime` 包装现有 `ReaderPlugin`。
- 生命周期和页面行为继续由插件实现。
- 样式所有者为插件。
- Fanqie 实现不因架构统一而改写。

### 唯一 Registry

删除旧 `SiteRegistry`。现在：

- `PluginRegistry` 是唯一运行时注册表。
- `PluginLoader` 是唯一创建、加载、卸载和热重载入口。
- `SiteContext.currentRuntime` 是 Manager 唯一站点来源。
- 稳定 `siteId` 始终等于 manifest ID。

删除内容包括：

- `src/scripts/core/site_registry.ts`
- 对应 `site_registry.test.ts`
- `src/scripts/adapters/index.ts`
- 旧适配器初始化路径

### AppRuntime

新增 `src/scripts/core/app_runtime.ts`，取代 `inject.ts` 中分散的初始化代码。

`inject.ts` 现在只做：

- 跳过不应注入的跨域子框架。
- 防止重复注入。
- 创建并初始化 `AppRuntime`。
- 初始化失败时销毁已创建资源。

`AppRuntime` 负责：

- 设置初始化。
- 内置/外部插件加载。
- 当前站点缩放。
- Managers 创建。
- 插件变更监听和串行热重载。
- 一次性性能采样。
- 页面销毁时逆序释放。

## 二、设置仓储

### schema v2

设置文档统一为：

```json
{
  "schemaVersion": 2,
  "_version": 0,
  "global": {},
  "sites": {},
  "pluginConfigs": {}
}
```

字段归属：

- `global`：自动更新、自动翻页、隐藏光标、站点恢复开关、启用插件列表。
- `sites[siteId]`：zoom、宽屏、工具栏、导航栏、最近阅读 URL。
- `pluginConfigs[pluginId]`：插件自定义配置。

### SettingsRepository

Rust `settings.rs` 成为唯一文件持久化边界：

- 读取、patch 和 Rust 内部单字段更新使用同一把锁。
- `patch_settings(expectedVersion, patch)` 比较版本。
- 成功返回完整最新文档，冲突返回后端最新文档。
- 写入同目录临时文件，flush、sync 后原子替换。
- Unix 下继续同步父目录。
- IO 失败明确返回，临时文件清理。
- 版本溢出拒绝写入。

前端 `SettingsStore` 只负责：

- 当前内存快照。
- global + 当前 site 的合并视图。
- 订阅。
- 乐观 UI 状态。
- 串行发送 patch。
- 冲突后刷新并只重试一次。
- IO 失败回滚。

删除 `OptimisticLock` 及其测试。并发控制不再假装由前端保护磁盘。

### 格式重置策略

旧 schema、版本不匹配、损坏 JSON 或结构不完整时，Rust 直接原子覆盖默认 schema v2：

- 不创建备份。
- 不迁移旧 settings 字段。
- 插件目录不删除。
- `enabledPlugins` 缺失表示所有已安装插件默认启用。

这是明确的数据策略，不要擅自恢复旧格式兼容分支。

## 三、阅读位置存储

新增 `src-tauri/src/reading_progress.rs` 和前端 `reading_position.ts`。

存储布局：

```text
{APP_CONFIG_DIR}/reading-progress/<siteId>/<sha256(url)>.json
```

特点：

- 前端只加载当前 URL 的一个数值。
- 保存只写当前 URL 的一个小文件。
- 不再克隆 URL → position 大 Map。
- 同目录临时文件、sync、原子替换。
- 每站点最多 10,000 个 URL；更新已有条目不受上限影响。
- 只允许 `main` 窗口调用。
- 当前 URL、请求 URL 必须同时属于 WeRead 或目标插件 manifest 域名。
- 卸载插件保留阅读位置。

滚动恢复的算法、阈值、重试参数和触发时机没有改变，只替换底层读写方式。

## 四、资源与内存

### Manager 生命周期

Manager 现在统一释放：

- DOM/window 监听器。
- Tauri `listen` 取消函数。
- MutationObserver。
- timeout、interval、RAF。
- SettingsStore/EventBus 订阅。
- 被覆盖的原生浏览器钩子。
- 注入的临时样式。

关键修复：

- IPCManager、RemoteManager、MenuManager、StyleManager、ThemeManager 补齐清理。
- SettingsStore 能清理迟到的 Tauri listener，并在 destroy 后重新初始化。
- 自动翻页用 generation 阻止旧 RAF/timer 复活。
- AppManager destroy 主动清除 autoFlip，避免 pagehide 监听顺序导致遗漏。

### 微信读书章节与进度生命周期

`ChapterManager` 不再只保留一本书：

- URL 书籍 token 作为缓存键，最近 20 本书按 LRU 保留章节 ID、字数与已校准 `maxPages`。
- ProgressTracker 和 RemoteManager 同时初始化同书时共用一个 `chapterInfos` 请求。
- 页面 JSON-LD 尚未建立或请求失败后可重试，不再用永久失败标志锁死同书。
- 旧书请求迟到时可进入有界缓存，但不能替换当前新书；reset 会中止尚未完成的 fetch。

`ProgressTracker` 把 URL token 和官方数字 bookId 分开管理：

- 每次离开后重新进入书籍，都重新请求已登录用户的 `getProgress`。
- 首页历史回放与 DOM 就绪的重复通知只会发生一次官方进度请求。
- 页面元数据迟到时有界重试；每次重试、SPA 切书和 destroy 都有代次检查，迟到结果不回写。
- 切书初始化期间暂停旧书进度计算；Title 轮询、初始化重试和方向 timer 都在离开/destroy 时释放。
- 目录直跳优先用缓存 `chapterUid` 识别；只放弃未走完的离开章节校准，目标章仍继承全书比例并在完整走完后继续校准。

`maxOffset`、`maxPages`、初始/翻页 `progress`、`turningPages` 公式，以及 500ms 方向合并、6 页和 20% 阈值都没有改动。

### 插件热重载

热重载现在保证：

1. 调用旧插件 `onUnload()`。
2. 清理 Plugin API 登记的样式、事件和订阅。
3. 从注册表移除旧实例。
4. 动态 import 后无论成功失败都撤销 Blob URL。
5. 重新创建并加载当前域名匹配实例。
6. 销毁期间发生的迟到重载不会复活系统。

### SiteContext Observer

- 同时只保留一个 Observer。
- stop 后可以重新 observe。
- body 尚未建立时只注册一个 DOMContentLoaded 回调。
- SPA、前后台切换和插件热重载不会重复创建。
- 初始阅读页通过历史路由立即进入正确状态。

### EventBus

- 只有状态事件保留历史，每种最多 10 条。
- 章节/翻页等瞬时事件不保留历史。
- once 在调用回调前删除，异常或重入也不会残留。
- 回调异常互相隔离。
- moduleId、AbortSignal 和插件前缀均可批量清理。
- AppRuntime 销毁时清除可丢弃历史。

### 诊断和日志

- 性能诊断每页只采样一次。
- 错误监听器在采样完成后移除。
- 最慢资源使用前五名增量列表，不复制排序完整数组。
- 删除 Fanqie 五秒诊断线程。
- 删除启动时同步网络探测。
- 日志单文件 2 MiB，活动文件加最多两份轮转文件。

## 五、Bug 修复

### 初始路由

IPCManager 初始化时总是发布一次带历史的路由状态。解决启动就位于阅读页时 Observer 和 Managers 未启动的问题。

### 设置并发与插件配置

- 普通设置 patch 不再删除 `pluginConfigs`。
- 插件配置也经过同一个 Repository。
- Plugin API 返回 site 显示字段和插件自定义字段的合并视图。
- 已知显示字段写 `sites[id]`，自定义字段写 `pluginConfigs[id]`。
- 冲突重试失败后采用后端最新状态，不保留错误的乐观快照。

### 自动翻页进度条

手动和遥控翻页会发布 `PAGE_TURN_DIRECTION`，旧自动翻页没有发布，导致隐藏导航栏时底部进度条不同步。

现在双栏定时翻页和单栏到底切章都在翻页前发布 forward 事件，再执行原有翻页逻辑。这个 Bug 修复只补齐事件路径；后续 ProgressTracker 生命周期重构仍保留原有初始公式、页数校准公式和经验参数。

### DOM 安全

设置页插件信息不再把 manifest 文本拼接进 `innerHTML`，改为 DOM API 和 `textContent`。静态受控图标模板仍可复用。

### 显示器测试

真实硬件探测改为显式 ignored 真机测试；普通单元测试只验证纯坐标计算，避免 CI 依赖开发机硬件。

### 自动更新开关

更新、下载、安装和重启流程保留。设置读取路径修正为 `global.autoUpdate`；旧代码读取根节点，可能导致关闭自动更新无效。

### 窗口状态

清理不存在的 `about`、`update` window-state 排除项，并取消全部 denylist。现在 `main`、`settings`、`plugin-editor`、`privacy`、`terms` 都按 label 分别保存和恢复位置、尺寸与窗口状态。

## 六、最低限度安全收口

### 插件路径

- 插件 ID 与文件名使用严格字符集和长度限制。
- 拒绝 `..`、绝对路径、路径分隔符和符号链接。
- 已安装目录规范化后必须位于插件根目录内。
- 读取、编辑、卸载和安装共用同一目录校验。

### .atrd

- 包文件和解压总大小：20 MiB。
- 文件数：128。
- 单文件：4 MiB。
- manifest：256 KiB。
- 路径深度：最多四层。
- 临时目录完整校验后替换。
- 安装失败保留或恢复旧版本。

### 编辑器和导出

- 编辑已安装插件只能写入固定插件目录。
- manifest ID 不允许在编辑时变化。
- 前端不能提供任意导出目录；Rust 原生对话框选择并写入。
- symlink 文件和目录被拒绝。

### Capability

删除共享的 `default.json` 和 `weread-api.json`，拆分：

- `main-runtime`
- `settings`
- `plugin-editor`
- `legal-documents`

远程阅读网页不再拥有 FS、Shell、Updater、Dialog、Opener、插件管理或窗口创建能力。

外部插件仍被视为用户信任的网页插件：可以访问匹配页面 DOM 和网络。这次没有引入签名、沙箱、权限弹窗或插件审核系统。

## 七、删除的代码和依赖

主要删除：

- `SiteRegistry` 与测试。
- `OptimisticLock` 与测试。
- 重复 adapter 导出/初始化。
- 未使用的 `PageScroller`。
- Vite 模板的 welcome、示例 assets、`main.ts`、`styles.css`。
- 未被调用的旧 Tauri 命令和生成 permissions。
- 复制生产逻辑、mock 过期的 Rust 测试文件。

移除不再使用的 Rust/Tauri 依赖：

- tauri-plugin-store
- tauri-plugin-shell
- tauri-plugin-http
- tauri-plugin-fs
- reqwest
- chrono
- dirs
- core-foundation-sys

保留：

- opener
- dialog
- window-state
- log
- updater
- zip
- sha2

## 八、兼容边界

项目曾基于重构前 HEAD `448adb1` 建立源码 SHA 清单。2026-08-03 取消该机制：单维护者项目中的正常源码修改不再被字节哈希阻断，兼容边界改由针对性测试、类型检查和真站验收保护。

官方进度初始化、`maxOffset`、`maxPages`、`progress`、`turningPages` 公式和所有经验参数保持不变。

受保护内容：

- 微信读书 `progress_tracker.ts`。
- 微信读书 `weread_adapter.ts`。
- WeRead 插件实现和 CSS。
- Fanqie 插件实现。
- 插件模板行为实现。

这些行为允许正常维护，但修改后必须用针对性测试和必要的真站验收确认结果。不得无意改变：

- 微信读书阅读进度算法及参数。
- 站点页面操作逻辑。
- 注入 CSS。
- 滚动恢复、翻页、光标、主题的既有参数和触发结果。

自动翻页进度条修复本身只补齐公共翻页方向事件。ProgressTracker 的后续重构处理了初始化重试、迟到请求、SPA 切书、目录跳转和资源释放，但不改进度公式与经验参数。

## 九、自动更新保持项

更新器仍然：

- 启动 10 秒后静默检查。
- 每 24 小时检查。
- 从 `tauri.conf.json` 的 GitHub Release endpoints 获取 `latest.json`。
- 用既有公钥验证更新。
- 后台下载后等待重启，或手动下载后直接重启。
- 使用 `app.restart()` 应用更新。

变化仅有：

- 正确读取 `global.autoUpdate`。
- 更新命令只授权本地设置窗口，远程主页面不能调用。

## 十、测试与验收

新增或重写的回归覆盖：

- WeRead 桥接器与外部插件走同一 SiteContext。
- 非 WeRead 域名不构造 WeReadAdapter。
- 插件热重载无实例、Blob、监听器和样式残留。
- Observer 多次停止/恢复只有一个实例。
- 初始阅读页发布历史路由。
- 设置串行 patch、冲突、二次冲突、IO 回滚、插件配置保留。
- 阅读位置独立文件、上限和卸载保留。
- EventBus once 异常只执行一次。
- 自动翻页发布进度方向事件。
- 路径穿越、ZIP symlink、异常包、域名边界和编辑器 symlink 被拒绝。
- Manager 行为参数与销毁结果。
- IPC/Capability 命令集合自动一致性。
- Tauri mock 覆盖真实 IPC metadata 分发、远程窗口阅读位置 scope 和原生菜单构建。
- 启动 URL/站点缩放归属、schema v2 菜单初值和自动更新策略。
- 单栏自动翻页的恢复门禁、后台暂停、到底翻页及延迟任务释放。
- 微信读书进度算法的初始换算、500ms 方向合并、有符号页数、20% 校准阈值和目录跳转降级。
- 微信读书每次进书获取官方进度、页面信息迟到重试、同书请求合并、SPA 切书与旧请求代次隔离。
- ChapterManager 保留最近 20 本书的章节 ID 和校准页数，超限按 LRU 清理，destroy/reset 中止未完请求。
- 更新端点、窗口状态插件、有效窗口标签和远程 Capability 静态契约。

当时验证记录：

- TypeScript 严格检查，3 个精确 TS6133 兼容项。
- Bun 242 项，覆盖函数 72.00%、覆盖行 80.52%（按实际导入模块统计）。
- Rust 64 项，1 项真机显示测试 ignored。
- IPC/Capability 23 命令一致性。
- 前端构建。
- cargo test。
- 项目维护者人工使用验收。

## 十一、后来维护者的规则

1. 不要重新引入第二套站点注册器；新增站点接入 `ReaderSiteRuntime`。
2. Manager 不得直接依赖具体 adapter/plugin，只能通过 `SiteContext`。
3. 新资源必须有明确 owner 和 destroy 路径。
4. 插件热重载必须先卸载旧实例，再加载新实例。
5. 设置文件写入只能经过 `SettingsRepository`；前端只能 patch。
6. URL 阅读位置不能塞回 settings 大 Map。
7. 新 Tauri 命令必须同步 handler、AppManifest、permission、最小 Capability，并通过 `check:ipc`。
8. 远程主窗口不得获得插件管理、文件、更新器或窗口创建权限。
9. 不要手工编辑 `inject.js`，运行 `bun run build`。
10. 修改页面行为时运行针对性测试，并按影响完成真站验收。
11. 静态检查、模拟 E2E 和真机验收要分别报告，不能互相替代。
12. 修改架构、命令、设置 schema、测试数量或兼容边界后同步更新文档。

## 相关文档

- [插件与站点运行时架构](./PLUGIN_ARCHITECTURE.md)
- [事件与生命周期架构](./EVENT_BUS_REFACTOR.md)
- [Tauri 2.11、IPC 与窗口权限](./TAURI_2_11_UPGRADE.md)
- [测试与验收指南](./TESTING.md)
