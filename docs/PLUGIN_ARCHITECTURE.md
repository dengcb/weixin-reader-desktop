# 插件与站点运行时架构

本文描述 2026-08-01 之后的现行架构。源码是真相；本文重点说明稳定接口、所有权和维护边界。

## 设计目标

- `PluginRegistry` / `PluginLoader` 是唯一站点来源，不再并行维护另一套站点注册器。
- 所有 Manager 只通过 `SiteContext.currentRuntime` 使用当前站点。
- 微信读书和外部插件最终都表现为 `ReaderSiteRuntime`，但各自保留已有页面行为和样式所有权。
- 插件热重载必须先释放旧实例的事件、样式和模块资源，再注册新实例。
- 远程阅读页面只能取得与当前 URL 唯一匹配的插件代码，不能使用插件管理、文件、更新器等本机能力。

## 总体结构

```text
inject.ts
  └─ AppRuntime                     注入层唯一生命周期所有者
      ├─ SettingsStore              前端状态、合并视图、订阅、串行 patch
      ├─ PluginLoader
      │   ├─ PluginRegistry         唯一运行时注册表
      │   ├─ WeReadSiteRuntime      桥接既有 WeReadAdapter
      │   └─ PluginSiteRuntime      包装外部 ReaderPlugin
      ├─ SiteContext                Managers 的唯一站点入口
      └─ Managers                   路由、菜单、样式、翻页、遥控、恢复

Rust
  ├─ SettingsRepository             设置锁、版本、原子持久化
  ├─ reading_progress.rs            独立 URL 滚动位置
  ├─ plugin_manager.rs              插件校验、安装、替换、卸载
  ├─ commands.rs                    窗口受限 IPC
  └─ capability files               按窗口划分权限
```

初始化顺序由 `AppRuntime.initialize()` 固定：

1. 初始化 `SettingsStore`。
2. 注册微信读书桥接器。
3. 调用 `get_runtime_plugin` 加载当前域名唯一匹配的外部插件。
4. 激活当前运行时并由 Rust 应用站点缩放。
5. 创建 Managers。
6. 监听 `plugins-updated`，串行执行热重载。
7. `pagehide` 时逆序销毁 Managers、插件、SiteContext、SettingsStore 和可丢弃事件历史。

## ReaderSiteRuntime

接口位于 `src/scripts/core/reader_site_runtime.ts`，在 `ReaderPlugin` 基础上统一以下能力：

| 能力 | 说明 |
|---|---|
| `id` / `name` / `manifest` | 稳定站点身份与清单 |
| `matchesDomain()` | 当前域名匹配 |
| `isReaderPage()` / `isHomePage()` | 页面状态判断 |
| `nextPage()` / `prevPage()` | 翻页 |
| `isDoubleColumn()` / `isAtBottom()` | 布局与滚动边界 |
| `getWideModeCSS()` 等 | 样式能力 |
| `getChapterProgress()` / `getBookProgress()` | 可选进度能力 |
| `onLoad()` / `onUnload()` | 生命周期 |
| `styleOwner` | `manager` 或 `plugin`，避免重复注入 |

### 微信读书桥接器

`WeReadSiteRuntime` 延迟创建 `WeReadAdapter`：只有域名匹配并加载微信读书运行时时才构造适配器，避免在其他网站启动微信读书的进度监听器。

- 页面判断、翻页、双栏检测和进度仍委托给现有适配器。
- 样式仍由 `StyleManager` 调用适配器的样式方法，`styleOwner = "manager"`。
- `onUnload()` 销毁适配器并释放进度跟踪器。
- 不在桥接层复制或修改微信读书进度算法。

### 外部插件包装器

`PluginSiteRuntime` 将已有 `ReaderPlugin` 包装为统一接口：

- 生命周期继续调用插件的 `onLoad` / `onUnload`。
- 样式取自插件的 `getStyles()`，`styleOwner = "plugin"`。
- 缺失的可选能力返回安全默认值。
- Fanqie 等外部插件实现不需要为统一架构重写。

## Registry、Loader 与 SiteContext

### PluginRegistry

注册表只保存 `ReaderSiteRuntime`：

- 按稳定插件 ID 注册，拒绝重复 ID。
- 根据当前域名选择唯一活动运行时。
- 保存 `unloaded`、`loading`、`loaded`、`error` 状态。
- 清空或注销已加载运行时时先调用 `onUnload()`。

### PluginLoader

加载器负责创建 API、运行插件生命周期和热重载：

- `onLoad()` 失败时尝试 `onUnload()` 并清理已经登记的资源。
- 卸载时无论插件回调是否抛错，都会清理插件 API 和注册状态。
- 外部代码用 Blob URL 动态 `import()`；无论成功失败都会立即 `URL.revokeObjectURL()`。
- 热重载顺序为：卸载旧实例 → 清理资源 → 清空注册表 → 创建新实例 → 加载当前域名匹配实例。
- `AppRuntime` 用串行队列和 generation 防止并发重载或销毁后复活。

### SiteContext

`SiteContext` 是所有 Manager 的站点门面：

- `currentRuntime` 只读自 `PluginRegistry`。
- 双栏状态使用单个可断开、可重新绑定的 `MutationObserver`。
- `startObserving()` 幂等；`stopObserving()` 后可以再次启动。
- 初始就是阅读页时，IPC 的历史路由会立即启动观察和相关 Manager 状态。

禁止新增 Manager 直接导入具体站点适配器或自行查找插件。

## 插件包与清单

`.atrd` 是 ZIP 容器。运行时安装包的最小结构：

```text
plugin.atrd
├─ manifest.json
└─ plugin.js            自包含 ESM，default export 插件类
```

样式或其他资源可随包携带，但运行时必须能找到常规文件 `manifest.json` 和 `plugin.js`。

常用清单示例：

```json
{
  "id": "example-reader",
  "name": "示例书店",
  "version": "1.0.0",
  "description": "示例插件",
  "author": "开发者",
  "homepage": "https://example.com/plugin",
  "sourceType": "web",
  "renderMode": "webview",
  "site": {
    "domain": ["example.com"],
    "homeUrl": "https://example.com/",
    "readerPattern": "/reader/"
  },
  "capabilities": {
    "wideMode": true,
    "hideToolbar": true,
    "hideNavbar": false,
    "autoFlip": true,
    "doubleColumn": true
  },
  "builtin": false
}
```

稳定约束：

- `id` 只能由小写 ASCII 字母、数字、`-`、`_` 组成，最长 64 字节。
- Web 插件必须提供合法的 `site.domain`、HTTP(S) `homeUrl` 和非空 `readerPattern`。
- `siteId` 永远等于 manifest 的 `id`，不能使用菜单顺序或临时编号。
- 外部插件必须 `export default` 一个实现 `ReaderPlugin` 的类。

完整接口类型见 `src/scripts/core/plugin_types.ts`，模板见 `src/plugins/template/`，Fanqie 示例见 `plugins/fanqie/`。面向社区的开发步骤、能力自声明、样式组织和验收清单见 [`PLUGIN_DEVELOPMENT.md`](./PLUGIN_DEVELOPMENT.md)。

## 安装、编辑和卸载

### 安装安全边界

Rust 在临时目录完成全部校验后才替换已安装版本：

- 包文件、解压后总大小上限均为 20 MiB。
- 最多 128 个条目，单文件最多 4 MiB，manifest 最多 256 KiB。
- 路径最多四层，拒绝绝对路径、`..`、路径穿越、非法文件名和 ZIP 符号链接。
- 插件根目录和已安装目录必须是真实目录，规范化后仍位于应用插件根目录内。
- 暂存版本校验失败不会覆盖旧版本；替换失败时恢复旧目录。

### 编辑与导出

- `save_plugin` 只能写入插件根目录下已安装插件的固定 ID 目录，manifest ID 不允许变化。
- 编辑器文件名必须是可移植的扁平文件名；CSS 写入插件的 `styles/` 子目录。
- `export_plugin` 由 Rust 打开原生保存对话框并直接写入，前端不能指定任意目录。
- 编辑器窗口只拥有加载、保存、导出和从编辑器安装插件的命令。
- 编辑器保存后的安装包 manifest 是运行时能力开关的权威来源；加载外部插件时会覆盖代码内的默认 manifest，使插件内部与宿主读取同一份能力配置。
- 插件管理页只负责安装、启停、编辑和卸载，不再展示与站点菜单重复的配置表单；需要暴露给用户的站内快捷操作应由插件注入匹配站点的原生界面。

### 卸载保留规则

卸载只删除插件代码目录，不删除：

- `settings.json` 中的 `sites[pluginId]`。
- `pluginConfigs[pluginId]`。
- `reading-progress/<pluginId>/`。

因此用同一 ID 重装插件后，配置和阅读位置可以自动接回。

## 运行时插件读取

远程主窗口不再枚举所有插件并逐个读取代码。`get_runtime_plugin()` 会：

1. 确认调用窗口是 `main`，且当前 URL 为 HTTP(S)。
2. 读取已安装并启用的插件。
3. 使用 DNS label 边界匹配当前 host。
4. 只返回唯一匹配插件的 manifest、代码和 `styles/` CSS；多个匹配视为错误。

宿主不主动从网络下载插件代码。返回的代码通过 Blob 动态导入并立即撤销 Blob URL。

第三方插件仍属于用户信任的网页插件：可以访问匹配页面的 DOM 和网络；Capability 只阻止它借宿主 IPC 操作插件管理、任意文件、更新器或创建窗口。

## Plugin API 与资源所有权

`createPluginAPI()` 为每个插件创建命名空间：

- `style`：style ID 自动带 `plugin-<id>-` 前缀，并登记清理。
- `events`：事件自动带 `plugin:<id>:` 前缀，订阅和 once 均登记清理。
- `settings`：读取 `sites[id]` 与 `pluginConfigs[id]` 的合并视图。
- `storage`：当前使用带插件前缀的 `localStorage`。
- `style.getFile()` / `style.listFiles()`：只读访问当前插件包 `styles/` 下的 CSS；插件仍须显式决定何时注入。
- `log`、`content`、`menu`：提供统一外观；menu 的动态注册仍是预留能力。

设置字段归属：

| 字段 | 写入位置 |
|---|---|
| `zoom`、`readerWide`、`hideToolbar`、`hideNavbar` | `sites[pluginId]` |
| 插件自定义字段 | `pluginConfigs[pluginId]` |

插件应主动在 `onUnload()` 清理自行创建、未通过 Plugin API 登记的资源。宿主会兜底清理通过 API 注入的样式、订阅和可丢弃历史。

## 设置与阅读位置

设置文档固定为 schema v2：

```json
{
  "schemaVersion": 2,
  "_version": 0,
  "global": {},
  "sites": {},
  "pluginConfigs": {}
}
```

- `SettingsStore` 只维护前端状态、当前站点合并视图和订阅。
- 所有前端写入串行发送 `patch_settings(expectedVersion, patch)`。
- 后端冲突时返回最新文档；前端刷新后只重试原 patch 一次。
- Rust `SettingsRepository` 对读写使用同一把锁，临时文件写入、flush、sync 后原子替换。
- 旧 schema、损坏 JSON 或结构不完整会直接覆盖为默认设置；不创建备份，插件目录保留且默认启用。

URL 滚动位置不存进 settings：

```text
{APP_CONFIG_DIR}/reading-progress/<siteId>/<sha256(url)>.json
```

每个文件只保存当前 URL 的一个数值，写入同样使用临时文件和原子替换。每站点最多 10,000 条；更新已有条目不受上限影响。命令只允许主窗口在当前站点域名范围内调用。

## 多站点菜单与启动恢复

- 「书店」菜单仅在存在外部 Web 插件时显示。
- 菜单 ID 为 `switch_site_<siteId>`，当前站点使用单选对勾。
- 安装、卸载或编辑器安装后重建菜单并发布 `plugins-updated`。
- `global.rememberSite` 决定启动站点；`global.lastPage` 决定恢复阅读页还是站点首页，两个开关互不依赖。
- 离开阅读页时清除对应 `lastReaderUrl`；卸载插件不清配置或阅读位置。

## Capability 边界

| Capability | 窗口 | 能力 |
|---|---|---|
| `main-runtime` | 远程主窗口 | 阅读运行时、设置 patch、当前 URL 阅读位置、当前 URL 插件代码 |
| `settings` | 本地设置窗口 | 设置、插件管理、更新器、创建编辑器/法律窗口 |
| `plugin-editor` | 本地编辑器 | 已安装插件编辑、导出、安装 |
| `legal-documents` | 隐私与条款 | 仅 `core:default` |

远程 `main` 不拥有 FS、Shell、Updater、Dialog、Opener、任意窗口创建或插件管理命令。

## 开发与验收

```bash
bun run build:plugin <pluginId>
bun run build:plugin:all
bun run typecheck
bun test
bun run check:ipc
bun run build
```

外部插件源码优先放在 `plugins/<id>/`，构建产物位于 `plugins/<id>/release/<id>.atrd`。内置插件构建产物位于 `release/plugins/`。

构建产物 `plugin.js` 保留可读格式，便于在应用内「代码编辑」中直接维护；编辑器按已安装包的真实代码文件和 CSS 文件动态生成标签，避免保存不会生效的影子文件。

### 插件能力自声明规范

编辑器只验证开发者是否按规范声明实现位置，不判断目标网站上的功能是否真实可用。实际效果由用户使用、社区反馈和后续迭代验证。

- Manifest 中以布尔值声明支持的能力。
- 代码或 CSS 中用 `@capability <能力键>` 标出实现位置，例如 `@capability doubleColumn`。
- 为保证 Bun 编译后的 `plugin.js` 保留代码标记，代码使用 `/*! ... */` 注释；CSS 使用普通块注释即可。
- 不属于功能开关的基础 CSS 使用 `@foundation`。
- 入口代码必须非空并提供默认导出；CSS 可选，但存在的 CSS 必须非空并带 `@capability` 或 `@foundation`。
- Manifest 中开启的六项编辑器能力，必须至少在代码或样式中出现一次同名标记；该检查仅代表开发者自声明完整，不代表功能验收通过。

六项能力键固定为：`doubleColumn`、`wideMode`、`hideToolbar`、`hideNavbar`、`chapterNav`、`progressTracker`。官方番茄插件和新建插件模板均遵守此规范。

微信读书进度算法、适配器、WeRead CSS、Fanqie 页面行为和插件模板允许正常维护，通过针对性测试和必要的真站验收保护行为边界。

## 相关文档

- [事件与生命周期](./EVENT_BUS_REFACTOR.md)
- [Tauri 2.11 与 IPC](./TAURI_2_11_UPGRADE.md)
- [测试指南](./TESTING.md)
- [2026 架构重构记录](./ARCHITECTURE_REFACTOR_2026.md)
