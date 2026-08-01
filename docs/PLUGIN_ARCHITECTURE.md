# 插件化架构设计文档

本文档介绍微信读书桌面客户端的插件化架构，为第三方开发者提供插件开发指南。

> **版本历史**
> - v0.8.0: 引入插件化架构，支持 .atrd 插件包安装/卸载
> - v0.9.0: 新增可视化插件编辑器，支持应用内创建和编辑插件
> - v0.10.0: 外部插件运行时加载（Blob + 动态 import）；多站点「书店」切换菜单（站内导航 + 对勾）；按站点独立且全量保留的阅读进度记忆；manifest 图标内嵌（`icon` 字段 + `icon:fetch` 工具）；macOS 原生 Tracker 拦截；番茄小说作为首个官方外部插件范例（源码在 `plugins/`）

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                         Tauri 应用层                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    插件系统 (Plugin System)               │  │
│  │                                                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │  │
│  │  │ PluginLoader │  │PluginManager│  │  PluginAPI  │     │  │
│  │  │  插件加载器   │  │  插件管理器   │  │  插件接口   │     │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘     │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐  │
│  │   WeRead 插件    │ │   未来: 本地    │ │  第三方插件      │  │
│  │   (内置默认)     │ │   EPUB/TXT     │ │  (.atrd 安装)    │  │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 可安装插件系统

### 1. 插件包格式 (.atrd)

`.atrd` (AT Reader Data) 是艾特阅读专用的插件安装包格式，本质是 ZIP 压缩文件。

**选用理由**：避免与浏览器插件格式（.crx, .xpi）、常见压缩格式（.zip）产生混淆。

#### 包结构

```
my-plugin.atrd (ZIP)
├── manifest.json      # 必须：插件清单文件
├── plugin.js          # 必须：插件脚本（打包后）
├── icon.png           # 可选：插件图标（64x64 推荐）
└── assets/            # 可选：其他资源文件
    ├── style.css
    └── ...
```

### 2. manifest.json 完整规范

```json
{
  "id": "example-plugin",
  "name": "示例插件",
  "version": "1.0.0",
  "description": "插件功能描述",
  "author": "开发者名称",
  "sourceType": "script",
  
  "site": {
    "domain": "example.com",
    "homeUrl": "https://example.com/",
    "readerPattern": "/reader/"
  },
  
  "capabilities": {
    "script": true,
    "wideMode": false,
    "hideToolbar": false,
    "autoFlip": false
  },
  
  "configSchema": {
    "enableFeature": {
      "type": "boolean",
      "default": false,
      "label": "启用功能",
      "description": "详细说明（可选）"
    },
    "customValue": {
      "type": "string",
      "default": "",
      "label": "自定义值"
    },
    "advancedOption": {
      "type": "boolean",
      "default": false,
      "label": "高级选项",
      "condition": "enableFeature"
    }
  }
}
```

#### 字段说明

| 字段 | 必须 | 类型 | 说明 |
|------|------|------|------|
| `id` | ✅ | string | 插件唯一标识，用于存储和引用 |
| `name` | ✅ | string | 插件显示名称 |
| `version` | ✅ | string | 语义化版本号 (semver) |
| `description` | ❌ | string | 插件功能描述 |
| `author` | ❌ | string | 开发者名称 |
| `icon` | ❌ | string | 插件图标（推荐内嵌 base64 data URI，离线自包含；用 `bun run icon:fetch <id>` 自动抓取） |
| `sourceType` | ✅ | string | 插件类型：`script` / `web` / `local` |
| `builtin` | ❌ | boolean | 源码态标记；编译为 `.atrd` 时由 `build_plugin.ts` 自动改写为 `false`（外部插件） |
| `site` | ❌ | object | 网站配置（用于帮助菜单入口） |
| `site.domain` | ❌ | string/string[] | 匹配的域名 |
| `site.homeUrl` | ❌ | string | 网站首页 URL（显示在帮助菜单） |
| `site.readerPattern` | ❌ | string | 阅读页 URL 模式 |
| `capabilities` | ❌ | object | 插件声明的能力 |
| `configSchema` | ❌ | object | 配置项定义（自动生成设置 UI） |

#### configSchema 字段类型

| type | 说明 | 额外字段 |
|------|------|---------|
| `boolean` | 开关切换 | - |
| `string` | 文本输入 | - |
| `number` | 数字输入 | - |
| `select` | 下拉选择 | `options: [{value, label}]` |

**condition 字段**：可选，指定另一个配置项的 key，当该配置项为 true 时才显示此项。

### 3. 插件存储位置

安装后的插件存储在用户数据目录：

```
{APP_CONFIG_DIR}/
├── settings.json          # 应用设置（含 pluginConfigs）
└── plugins/               # 插件目录
    ├── example-plugin/    # 每个插件独立目录
    │   ├── manifest.json
    │   └── plugin.js
    └── another-plugin/
        └── ...
```

**配置存储结构** (settings.json)：

```json
{
  "global": { ... },
  "sites": { ... },
  "pluginConfigs": {
    "example-plugin": {
      "enableFeature": true,
      "customValue": "hello"
    }
  }
}
```

---

## 后端 API (Rust)

### 核心模块：plugin_manager.rs

路径：`src-tauri/src/plugin_manager.rs`

```rust
// 从 .atrd 文件安装插件
pub fn install_plugin_from_file<R: Runtime>(
    app: &AppHandle<R>, 
    file_path: &str
) -> Result<PluginInfo, String>

// 卸载插件
pub fn uninstall_plugin<R: Runtime>(
    app: &AppHandle<R>, 
    plugin_id: &str
) -> Result<(), String>

// 获取所有已安装的外部插件
pub fn get_installed_plugins<R: Runtime>(
    app: &AppHandle<R>
) -> Result<Vec<PluginInfo>, String>

// 读取插件配置
pub fn get_plugin_config<R: Runtime>(
    app: &AppHandle<R>, 
    plugin_id: &str
) -> Result<Value, String>

// 保存插件配置
pub fn save_plugin_config<R: Runtime>(
    app: &AppHandle<R>, 
    plugin_id: &str, 
    config: Value
) -> Result<(), String>

// 读取插件代码
pub fn get_plugin_code<R: Runtime>(
    app: &AppHandle<R>, 
    plugin_id: &str
) -> Result<String, String>
```

### Tauri 命令 (commands.rs)

前端通过 `invoke()` 调用：

```typescript
// 安装插件
await invoke('install_plugin', { path: '/path/to/plugin.atrd' });

// 卸载插件
await invoke('uninstall_plugin', { pluginId: 'example-plugin' });

// 获取已安装插件列表
const plugins = await invoke('get_installed_plugins');

// 获取插件配置
const config = await invoke('get_plugin_config', { pluginId: 'example-plugin' });

// 保存插件配置
await invoke('save_plugin_config', { 
  pluginId: 'example-plugin', 
  config: { enableFeature: true } 
});

// 获取插件代码
const code = await invoke('get_plugin_code', { pluginId: 'example-plugin' });
```

---

## 前端集成

### TypeScript 类型定义

路径：`src/scripts/core/plugin_types.ts`

```typescript
// 配置字段类型
export type ConfigFieldType = 'boolean' | 'string' | 'number' | 'select';

// 配置 Schema 字段定义
export interface ConfigSchemaField {
  type: ConfigFieldType;
  default: boolean | string | number;
  label: string;
  condition?: string;  // 条件显示
  options?: Array<{ value: string | number; label: string }>;  // select 选项
  description?: string;
}

// 完整配置 Schema
export type ConfigSchema = Record<string, ConfigSchemaField>;

// 已安装插件信息
export interface InstalledPluginInfo {
  id: string;
  version: string;
  installedAt: number;  // Unix 时间戳
  enabled: boolean;
  builtin?: boolean;
}

// 插件展示信息（合并 manifest + 状态）
export interface PluginDisplayInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  homeUrl?: string;
  builtin: boolean;
  enabled: boolean;
  capabilities: PluginCapabilities;
  configSchema?: ConfigSchema;
}
```

### 设置数据结构

路径：`src/scripts/core/settings_store.ts`

```typescript
export interface AppSettings {
  _version?: number;
  global?: {
    zoom?: number;
    autoUpdate?: boolean;
    lastPage?: boolean;
    hideCursor?: boolean;
    enabledPlugins?: string[];  // undefined = 全部启用
  };
  sites?: {
    [siteId: string]: SiteSettings;
  };
  pluginConfigs?: {  // 插件配置存储
    [pluginId: string]: Record<string, any>;
  };
}
```

### 设置界面 (settings.html)

插件管理界面实现要点：

1. **安装按钮**：使用 Tauri Dialog API 选择 .atrd 文件
2. **插件列表**：合并内置插件 + 外部插件
3. **配置面板**：根据 configSchema 自动生成 UI
4. **卸载按钮**：仅外部插件显示

```javascript
// 安装插件
document.getElementById('installPluginBtn').addEventListener('click', async () => {
  const { open } = tauri.dialog;
  const file = await open({
    multiple: false,
    filters: [{ name: 'AT Reader 插件', extensions: ['atrd'] }]
  });
  
  if (file) {
    await invoke('install_plugin', { path: file });
    // 刷新列表
    invoke('get_settings').then(renderPluginList);
  }
});

// 配置变更
async function handleConfigChange(e) {
  const input = e.target;
  const pluginId = input.dataset.plugin;
  const key = input.dataset.configKey;
  const value = input.checked;  // boolean 类型
  
  const currentConfig = await invoke('get_plugin_config', { pluginId });
  const newConfig = { ...currentConfig, [key]: value };
  await invoke('save_plugin_config', { pluginId, config: newConfig });
}
```

---

## 多站点「书店」切换 <sup>v0.10.0</sup>

### 设计理念

应用从「写死单站点（微信读书）」重构为「以**内置站点 + 插件声明站点**为数据源的多站点阅读器」。任何声明了 `site` 的外部插件（如番茄）安装后即成为一个可切换的「书店」。

### 「书店」菜单（menu.rs）

路径：`src-tauri/src/menu.rs`

- **条件出现**：仅当**存在至少一个外部插件站点**时才挂载顶级「书店」菜单；只有微信读书时隐藏（`build_bookstore_menu` 返回 `None`）。
- **站内切换**：菜单项 id 为 `switch_site_<siteId>`（如 `switch_site_weread`、`switch_site_fanqie`）。点击走**原生 webview 导航** `win.navigate(url)`，**不再**用 `opener.open_url`（外部浏览器）。
  - ⚠️ 早期实现用 `win.eval("window.location.href=...")`，会被繁忙的阅读页 JS 主线程排队阻塞（实测卡 18s），已改为原生 `navigate()`。
- **对勾（CheckMenuItem）**：当前站点前显示对勾。建菜单时用 `settings.global.lastSiteId` 决定初始勾选；切换后由前端 `ipc_manager` 调用命令 `set_active_bookstore(siteId)` 单选同步。
- **自动重建**：安装/卸载/编辑器安装插件后，`commands.rs` 调用 `refresh_app_menu`（内部 `menu::rebuild_full_menu`，带 macOS/Windows 的 `cfg` 守卫），「书店」菜单随外部插件增减即时出现/消失，**无需重启应用**。

### 关键约束：Tauri 远程 URL 白名单

**新站点的域名必须加入** `src-tauri/capabilities/default.json` 的 `remote.urls`，否则该站点页面上的 Tauri IPC（`invoke`/`listen`）整个不通——连锁导致外部插件加载失败、进度存不了、对勾不同步。番茄接入时新增了：

```json
"https://fanqienovel.com/*", "https://*.fanqienovel.com/*"
```

### 启动行为与「记住书店」开关

设置项「记住书店，好看再来」（存储键 `global.lastPage`，默认开）。注意：**「续读上次阅读页」始终生效**，开关只决定**是否记住站点**：

| 开关 | 启动站点 | 阅读页 |
|------|---------|--------|
| 开 | `global.lastSiteId`（无则微信读书） | 该站点 `sites[siteId].lastReaderUrl`，无则该站点首页 |
| 关 | 强制微信读书 | 仍恢复微信读书的 `lastReaderUrl`，无则微信读书首页 |

启动 URL 解析在 `lib.rs`；站点首页由 `sites.rs` 的 `resolve_home_url(app, siteId)` 解析（weread 取常量，其它从已装插件 manifest 的 `site.homeUrl` 匹配）。

---

## 可视化插件编辑器 <sup>v0.9.0 新增</sup>

从 v0.9.0 开始，应用内置了可视化插件编辑器，无需外部 IDE 即可创建和编辑插件。

### 打开方式

```
设置 → 插件管理 → 新建插件
```

外部安装的插件也可以点击「编辑」按钮进行修改。

### 编辑器功能

| 区域 | 功能 |
|------|------|
| **左侧导航** | 基本信息、站点配置、功能能力、代码编辑、样式文件 |
| **中间表单** | 可视化配置插件属性 |
| **右侧预览** | 实时显示插件信息卡片 |

### 表单配置项

#### 基本信息
- 插件 ID（唯一标识，kebab-case 格式）
- 插件名称
- 版本号（semver 格式）
- 描述信息

#### 站点配置
- 源类型（Web 在线 / 本地文件）
- 目标域名
- 首页 URL
- 阅读页匹配模式
- 主页匹配模式

#### 功能能力
- 宽屏模式、深色模式
- 隐藏工具栏、隐藏导航栏
- 自动翻页、章节导航
- 进度追踪、双栏模式
- 隐藏光标、遥控器支持

### 代码编辑

编辑器支持多文件切换：

| 文件 | 用途 |
|------|------|
| `index.ts` | 插件主逻辑 |
| `wide.css` | 宽屏模式样式 |
| `toolbar.css` | 工具栏隐藏样式 |
| `theme.css` | 主题/深色模式样式 |

### 保存与安装

点击「保存并安装」按钮：
1. 编辑器将表单数据和代码打包为 `.atrd` 格式
2. 自动调用后端 API 安装插件
3. 插件立即出现在插件列表中

---

## 插件开发流程

### 1. 创建插件目录

```bash
mkdir my-plugin
cd my-plugin
```

### 2. 编写 manifest.json

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "插件功能说明",
  "sourceType": "script",
  "site": {
    "domain": "target-site.com",
    "homeUrl": "https://target-site.com/",
    "readerPattern": "/read/"
  },
  "configSchema": {
    "myOption": {
      "type": "boolean",
      "default": false,
      "label": "我的选项"
    }
  }
}
```

### 3. 编写 plugin.js

```javascript
(function() {
  console.log('[MyPlugin] 插件已加载');
  
  // 获取配置（如果有）
  const config = window.__PLUGIN_CONFIG__ || {};
  
  if (config.myOption) {
    // 执行功能
  }
  
  // 监听路由变化
  // 注入样式
  // 等等...
})();
```

### 4. 抓取站点图标（可选，推荐）

用通用工具自动从站点抓图标并内嵌为 base64 data URI（离线自包含，不依赖 CDN）：

```bash
bun run icon:fetch <pluginId>            # 自动从 manifest 的 site.homeUrl 探测图标
bun run icon:fetch <pluginId> <iconUrl>  # 或手动指定图标地址
```

脚本（`src/scripts/fetch_plugin_icon.ts`）会 fetch 首页 HTML、正则解析 `<link rel="...icon">`（按 `apple-touch-icon > shortcut > icon` 优先级），抓取后写入 manifest 的 `icon` 字段。bun 服务端 fetch 无 CORS 限制。

### 5. 编译为 .atrd

用内置构建脚本（而非手动 zip）：

```bash
bun run build:plugin <pluginId>   # 编译单个插件
bun run build:plugin:all          # 编译全部
```

`build_plugin.ts` 会用 bun 把 `index.ts` 打包为自包含 ESM `plugin.js`（擦除类型导入、内联 manifest）、把 `builtin` 改为 `false`，再连同 manifest 一起 zip 为 `.atrd`。

**输入/输出目录：**
- 源码：优先 `plugins/<id>/`（外部插件开发工作区），回退 `src/plugins/builtin/<id>/`
- 产物：
  - 外部插件：`plugins/<id>/release/<id>.atrd`（随 plugins 目录上传 GitHub，用户可直接下载安装）
  - 内置插件：`release/plugins/<id>.atrd`（被 git 忽略，需手动分发）

> 💡 **外部插件产物为何在 `plugins/<id>/release/`**：小白用户从 GitHub clone 项目后，可以直接在插件目录找到预编译的 `.atrd` 文件并安装，无需自己打包。编译脚本会自动跳过 `release/` 子目录，避免"包中包"问题。

### 6. 测试安装

1. 运行应用 `bun start`
2. 打开 设置 → 插件管理
3. 点击「安装插件」
4. 选择 `my-plugin.atrd`
5. 验证插件出现在列表中
6. 展开配置面板，验证选项
7. 检查帮助菜单是否有网站入口

---

## 核心概念

### 1. 插件类型 (SourceType)

| 类型 | 说明 | 渲染模式 | 示例 |
|------|------|---------|------|
| `script` | 脚本注入 | WebView | 第三方扩展 |
| `web` | 在线阅读网站 | WebView | 微信读书、豆瓣阅读 |
| `local` | 本地文件 | 自定义渲染 | EPUB、TXT（规划中） |

### 2. 插件能力 (Capabilities)

```typescript
interface PluginCapabilities {
  script?: boolean;        // 脚本注入
  wideMode?: boolean;      // 宽屏模式
  hideToolbar?: boolean;   // 隐藏工具栏
  hideNavbar?: boolean;    // 隐藏导航栏
  autoFlip?: boolean;      // 自动翻页
  chapterNav?: boolean;    // 章节导航
  progressTracker?: boolean; // 进度追踪
  hideCursor?: boolean;    // 隐藏光标
  remoteControl?: boolean; // 遥控器支持
}
```

---

## 内置插件: 微信读书

### 功能清单

| 功能 | 状态 | 说明 |
|------|------|------|
| 宽屏模式 | ✅ | 扩展阅读区域至全屏 |
| 隐藏工具栏 | ✅ | 隐藏顶部工具栏 |
| 隐藏导航栏 | ✅ | 双栏模式下隐藏底部导航 |
| 自动翻页 | ✅ | 单栏滚动/双栏定时翻页 |
| 进度追踪 | ✅ | 实时显示章节阅读进度 |
| 章节导航 | ✅ | 遥控器上下键切换章节 |
| 双栏检测 | ✅ | 自动检测双栏/单栏模式 |
| 光标隐藏 | ✅ | 静止后自动隐藏鼠标 |

### 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `←` / `→` | 上一页 / 下一页 |
| `↑` / `↓` | 上一章 / 下一章（遥控器） |

---

## 未来规划

### 本地阅读插件 (LocalReaderPlugin)

支持本地电子书格式：

- **EPUB**: 标准电子书格式
- **TXT**: 纯文本格式
- **MOBI**: Kindle 格式（可选）

### 第三方网站适配

开发者可基于插件模板适配其他阅读网站：

- 豆瓣阅读
- 起点读书
- 番茄小说
- 等等...

---

## 外部插件运行时加载 <sup>v0.10.0</sup>

### 背景

早期 `plugin_loader.ts` 的 `loadExternalPlugins()` 是被注释掉的存根——前端只加载**内置插件**。外部 `.atrd`（如番茄）虽已装到磁盘、在设置列表与「书店」菜单可见（这些是 Rust 直接读插件目录），但其 `plugin.js` 从未在页面执行。导致在外部站点上 `getActivePlugin()` 返回 null，连锁造成：CSS 不生效、进度不工作、per-site 记忆存不进、书店「双对勾」。

### 实现（plugin_loader.ts）

`csp: null`（`tauri.conf.json`）——动态 `import()` / Blob 均放行。加载链路：

1. `invoke('get_installed_plugins')` 拿已装插件列表
2. 逐个尊重启用状态（`settingsStore.isPluginEnabled`）、跳过与内置重复注册的
3. `invoke('get_plugin_code', { pluginId })` 取 `plugin.js` 文本
4. `instantiateFromCode()`：`Blob` + 动态 `import(/* @vite-ignore */ url)` 加载 ESM，`new mod.default()` 得到实例，`registry.register(instance)`

**外部插件契约**：`index.ts` 必须 `export default` 其插件类（实现 `ReaderPlugin`），加载器以 `new mod.default()` 实例化。

**接线**：`initialize()` 和 `hotReload()` 都在激活插件前调用 `loadExternalPlugins()`。inject.ts 监听 `plugins-updated` 事件 → 安装/卸载后热重载即重新加载。

---

## 按站点进度记忆与稳定 siteId <sup>v0.10.0</sup>

不变量（已写入设计，防止后续回退）：

- **siteId = 插件 manifest 的 `id`**（作者指定的稳定字符串，如 `weread`/`fanqie`/`qidian`），**绝不用 1/2/3 位置序号**。前端 `getPluginLoader().getActivePlugin().manifest.id`、后端 `switch_site_<id>`、`sites[<id>]` 三者一致。
- **按站点独立且全量保留**：每个站点各自写 `sites[siteId].lastReaderUrl`，互不覆盖——所有书店的上次阅读页全量保留。`global.lastSiteId` 仅记「上次活跃站点」。
- **卸载不清进度**：`uninstall_plugin` 仅删插件文件目录，**禁止**清理 `sites[siteId]` 与 `pluginConfigs[siteId]`。因此卸载后重装同名插件，进度与配置自动接回。

写入方：`lastSiteId` / `lastReaderUrl` 由**前端 `ipc_manager` 单写**（用活跃插件 id + `isReaderPage()`），Rust 切换处理器不碰 settings，避免双写互盖。注意：`save_settings` 是顶层浅合并，写 `global` 子字段必须用 `settingsStore.updateGlobal()`（嵌套合并），不能整块替换 `global`。

---

## macOS 第三方追踪器拦截 <sup>v0.10.0</sup>

### 为何拦截（正当性声明 —— 必读）

这个功能的定性必须先说清楚，否则容易被误解为「拦截了网站的代码」：

- **拦的是什么**：仅仅是**第三方广告/统计追踪域名**（如百度统计 `hm.baidu.com`）——这些域名**不属于网站自己**，而是第三方数据采集商的服务，与阅读内容、页面功能零关。
- **拦它的原因**：它以**同步阻塞脚本**的形式放在 `<head>`，在部分网络环境（如代理对该域名丢包）下会卡死整页 HTML 解析长达 **~18 秒**，严重损害用户体验。拦截它是为了**让用户能正常、快速地浏览网站内容**。
- **绝不拦什么**（关键边界）：**不拦网站的任何自有代码、正文、图片、字体、内容 CDN、业务接口**。黑名单只含公认的纯统计/追踪域名，host 精确锤定，不会误伤网站功能。
- **性质类比**：等同于主流浏览器的「防追踪」、Safari 的智能防追踪（ITP）、以及各类广告拦截扩展——都是在**用户自己的浏览器内**为用户拦掉第三方追踪，是行业惯例且正当的用户侧行为，不涉及修改或盗用网站代码。

> 一句话：我们帮用户的浏览器拦掉拖垮页面的第三方广告追踪，和网站自己的代码/内容无关。

### 背景（实测闭环）

番茄 `<head>` 有同步阻塞的百度统计脚本 `hm.baidu.com/hm.js`（第三方域名，非番茄自有）。当用户开代理且代理对该域名 REJECT-DROP 时，请求干等 TCP 超时（约 18s），期间整页 HTML 解析被冻结——真机日志 `failed=["SCRIPT:https://hm.baidu.com/hm.js..."]`、`docResponse≈437ms` 但 `domInteractive≈18800ms`。微信读书无此类脚本 → 秒开。

### 实现（tracker_blocker.rs）

用 macOS 原生 **`WKContentRuleList`** 在 WKWebView 内拦掉纯统计/追踪域名，不依赖用户代理配置：

- `win.with_webview(|pw| ...)` → `pw.controller()` 拿 `WKUserContentController`
- `WKContentRuleListStore.defaultStore()` 异步编译规则 JSON（identifier `wxrd-tracker-block`），完成回调里 `addContentRuleList:`
- 依赖：项目已有 `objc 0.2` / `cocoa 0.26`，新增 `block = "0.1"` 构造完成回调 block
- 在 `lib.rs` 主窗口 `.build()` 后调 `tracker_blocker::install(&win)`；**非 macOS 为空实现**

**黑名单（保守纯统计/追踪，host 精确锤定，绝不拦内容 CDN / 网站自有代码）**：hm.baidu.com / hmcdn.baidu.com / *.cnzz.com / *.mmstat.com / *.umeng.{com,co} / *.umtrack.com / *.51.la / google-analytics / googletagmanager / tajs.qq.com / pingjs.qq.com / mta.qq.com（qq 统计精确锤定，**不影响 weread.qq.com**）。

> 维护黑名单的铁律：只能加入**公认的纯第三方统计/广告追踪域名**。任何可能承载网站自有内容、正文、图片、字体、业务接口的域名，**一律不得加入**。宁可漏拦，不可误拦。

**永远开启，无 UI 开关。** 实测效果：番茄 `domInteractive` 从 18808ms → ~870ms（提升 ≈20倍）。

> 已知限制：规则编译是异步的（数十毫秒），app 启动那一刻的首个页面可能来不及套用；但之后每次书店切换/页面加载都命中规则 → 秒开。

---

## 性能诊断探针

`inject.ts` 的 `reportLoadPerformance()`：每次页面加载完成后，把导航耗时与最慢/加载失败的资源写入日志文件（`logs/frontend-*.log`）：

```
[Perf] host=... docResponse=Xms domInteractive=Xms DCL=Xms load=Xms failed=[...] slowest=[...]
```

用于排查站点加载缓慢（如切换书店耗时过长）的真实原因：`docResponse` 大 → 网络/主文档慢；`docResponse` 小但 `domInteractive` 大 → 同步脚本阻塞解析（`failed`/`slowest` 里能看到元凶）。**平时无害，排查有用，保留。**

---

## 番茄小说：首个官方外部插件范例 <sup>v0.10.0</sup>

番茄作为「官方外部插件 + GitHub 开发范例」，演示用户如何自己写插件。

- **源码位置**：`plugins/fanqie/`（顶层 `plugins/` = 用户插件开发工作区；内置插件仍在 `src/plugins/builtin/`，当前只有微信读书）。类型直接深引主项目 `../../src/scripts/core/plugin_types`，约定用户在 clone 下来的项目内就地开发。
- **合规底线**：仅做「呈现层」增强——注入 CSS 调排版、读页面本就公开的章节元数据用于本地进度。**不修改正文、不破解混淆字体、不抓取或导出任何内容。**
- **实现要点**（`plugins/fanqie/index.ts`）：
  - 宽屏/沉浸 CSS：调 `.muye-reader-inner` 列宽、隐藏 `.reader-toolbar`（混淆字体 `.font-xxx` 碰都不碰）
  - 翻页：`←`/`→` 切章（番茄原生支持）
  - 进度：从 `__INITIAL_STATE__.reader.chapterData` 读 `realChapterOrder`/`serialCount`（公开元数据）

---

## 参考资料

- [Tauri v2 文档](https://v2.tauri.app/)
- [项目开发规范](../CLAUDE.md)
- [测试指南](./TESTING.md)
