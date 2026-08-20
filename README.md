<div align="center">

<img src="title.svg" width="480">

### 🚀 艾特阅读 · 基于 Tauri v2 + Rust 的高性能多站点桌面阅读客户端

**官方支持：微信读书 · 番茄小说 · 本地 TXT / EPUB 电子书**

<p>
  <a href="https://github.com/dengcb/weixin-reader-desktop/releases"><img src="https://img.shields.io/badge/release-v1.6.0-orange?style=flat-square" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/github/downloads/dengcb/weixin-reader-desktop/total?style=flat-square&color=green" alt="Downloads">
  <img src="https://img.shields.io/badge/Tauri-v2-24C8D5?style=flat-square&logo=tauri&logoColor=white" alt="Tauri">
  <img src="https://img.shields.io/badge/Platform-macOS-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-0078D4?style=flat-square" alt="Windows">
</p>

<p>
  <a href="https://reader.dengcb.com">官方主页</a> •
  <a href="#-选择理由">选择理由</a> •
  <a href="#-核心特性">核心特性</a> •
  <a href="#-快速开始">快速开始</a> •
  <a href="#-开发指南">开发指南</a> •
  <a href="#-技术架构">技术架构</a>
</p>

<img src="screen.jpg" width="960">

</div>

---

## 💡 选择理由

> 通过脚本注入方式增强官方 Web 端体验，完全兼容官方功能的同时提供更好的桌面体验

<table>
<colgroup>
<col style="width: 33%">
<col style="width: 33%">
<col style="width: 33%">
</colgroup>
<tr>
<td align="center">

### 📦 极致轻量

**安装包仅 ~5MB**<br>
内存占用低至 **100MB**<br>
相比 Electron 降低 **80%**
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;

</td>
<td align="center">

### ⚡ 原生性能

基于 **Rust + Tauri v2** 构建<br>
启动速度快<br>
CPU 占用低
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;

</td>
<td align="center">

### 🔒 安全可靠

完全开源<br>
无广告/无跟踪<br>
数据直连官方
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;

</td>
</tr>
</table>

---

## ✨ 核心特性

### 🖥 桌面体验

```
✓ macOS 原生菜单栏            ✓ 窗口位置/大小记忆
✓ 完整键盘快捷键               ✓ 恢复最后阅读页面
✓ 多显示器支持                 ✓ 一键移动窗口
```

### 📖 阅读增强

<table>
<colgroup>
<col style="width: 50%">
<col style="width: 50%">
</colgroup>
<tr>
<td>

**🎨 界面优化**
- 🌓 深色模式 - 护眼舒适
- 📺 宽屏模式 - 沉浸阅读
- 🧹 隐藏边栏 - 纯净界面
- 🔍 缩放控制 - 自由调节
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;

</td>
<td>

**⌨ 翻页控制**
- 🖱 触摸板双指滑动
- ⚡ 自动翻页（可调速）
- 👻 鼠标自动隐藏
- 🎯 精准进度显示
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;

</td>
</tr>
</table>

### 🔌 插件化架构 <sup>v0.8.0 历史性更新</sup>

> 全新可插拔式插件系统，支持第三方适配器与自定义脚本

```
✓ 支持 .atrd 插件包安装/卸载     ✓ 微信读书作为内置默认插件
✓ 标准化插件开发接口             ✓ 内置本地阅读(EPUB/TXT)插件
✓ 插件级命名空间隔离             ✓ 配置命名空间与独立阅读位置
```

### 🛠 可视化插件编辑器 <sup>v0.9.0 新增</sup>

> 内置插件开发工具，无需外部 IDE 即可创建和编辑插件

<table>
<colgroup>
<col style="width: 50%">
<col style="width: 50%">
</colgroup>
<tr>
<td>

**📝 表单式配置**
- 基本信息（ID、名称、版本、描述）
- 站点配置（域名、URL 模式）
- 功能能力（宽屏、深色、翻页等）
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;

</td>
<td>

**💻 代码编辑**
- TypeScript 语法高亮
- 多文件标签页切换
- 实时预览插件信息
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;

</td>
</tr>
</table>

```
路径: 设置 → 插件管理 → 新建插件
```

### 🏪 多站点书店切换 <sup>v1.0.0 新增</sup>

> 以插件为数据源的多站点阅读器，一个壳切换多个书城

```
✓ 外部插件运行时加载               ✓「书店」菜单站内切换 + 当前站对勾
✓ 每个书店独立记住阅读进度          ✓ 卸载重装进度自动接回
✓ macOS 拦第三方追踪域名           ✓ 番茄小说官方插件内置支持
```

### 📚 本地电子书阅读 <sup>v1.6.0 新增</sup>

> 内置「本地书屋」：TXT / EPUB 开箱即读，文件不出本机

```
✓ TXT 中文章节智能切分             ✓ EPUB 多级目录折叠导航
✓ 双栏/单列切换与排版自定义        ✓ 阅读进度与章节位置记忆
✓ 深浅主题自由切换                 ✓ 沙箱渲染，禁用书籍内脚本
```

### 🔄 智能更新

- ✅ 启动后自动检测更新
- 📥 一键下载安装
- 🔔 新版本通知

---

## 🚀 快速开始

### 📥 下载安装

前往 [**Releases 页面**](https://github.com/dengcb/weixin-reader-desktop/releases/latest) 下载最新版本：

<table>
<tr>
<th width="40%">平台 / 芯片</th>
<th width="60%">下载文件</th>
</tr>
<tr>
<td>🍎 macOS Apple Silicon (M1/M2/M3/M4)</td>
<td><code>weixin-reader-x.x.x-macos-aarch64.dmg</code></td>
</tr>
<tr>
<td>💻 macOS Intel</td>
<td><code>weixin-reader-x.x.x-macos-x86_64.dmg</code></td>
</tr>
<tr>
<td>🪟 Windows x64 (Intel/AMD)</td>
<td><code>weixin-reader-x.x.x-windows-x86_64-setup.exe</code></td>
</tr>
<tr>
<td>🪟 Windows ARM64 (Snapdragon X)</td>
<td><code>weixin-reader-x.x.x-windows-aarch64-setup.exe</code></td>
</tr>
</table>

### 🪟 Windows 构建

正式版本通过 GitHub Actions 原生 runner 构建 x64 和 ARM64 两个 NSIS 安装包。需要自行打包的 Windows 开发者，在对应架构的 Windows 环境运行：

```bash
bun install --frozen-lockfile
# x64（Intel/AMD）
bun run tauri build --bundles nsis --target x86_64-pc-windows-msvc -- --locked
# ARM64（Snapdragon X 等）
bun run tauri build --bundles nsis --target aarch64-pc-windows-msvc -- --locked
```

---

## 🛠 开发指南

### 📋 环境准备

需要 [Rust](https://rustup.rs/) 和 [Bun](https://bun.sh/)：

```bash
git clone https://github.com/dengcb/weixin-reader-desktop.git
cd weixin-reader-desktop
bun install
```

### ⚡ 开发命令

```bash
# 🚀 启动开发模式（热重载 + 自动同步版本）
bun start

# 🔨 构建注入脚本
bun run build:inject

# 📦 完整构建
bun run build
```

### 🐛 调试构建

```bash
bun run debug        # 快速调试（ARM）
bun run debug:arm    # Apple Silicon
bun run debug:intel  # Intel
```

### 📤 发布打包

```bash
bun run release:all      # 正式构建 macOS ARM + Intel，生成发布元数据
bun run release:upload   # 创建 tag/draft、上传 macOS、触发 Windows x64 + ARM64 workflow
bun run release:status   # 查看 Windows workflow、资产、SHA-256 和 Authenticode
bun run release:publish  # 校验全部平台、生成 latest.json、输入完整 tag 后发布

bun run release:arm      # 单架构诊断构建，不能直接正式上传
bun run release:intel    # 单架构诊断构建，不能直接正式上传
bun run release:clear    # 清理本地发布文件
```

### ✅ 测试

```bash
bun test                                    # TypeScript 前端
cargo test --manifest-path src-tauri/Cargo.toml  # Rust 后端
```

CI 在每次 push 时自动执行完整的质量门禁（typecheck + test + build + IPC 检查 + inject.js 一致性校验）。

---

## 🏗 技术架构

### 📚 技术栈

<table>
<colgroup>
<col style="width: 15%">
<col style="width: 25%">
<col style="width: 60%">
</colgroup>
<tr>
<th>层级</th>
<th>技术</th>
<th>说明</th>
</tr>
<tr>
<td><b>前端</b></td>
<td>TypeScript + Bun</td>
<td>注入脚本开发、打包与 DOM 测试&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;</td>
</tr>
<tr>
<td><b>后端</b></td>
<td>Rust + Tauri v2</td>
<td>原生桌面能力与系统集成&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;</td>
</tr>
<tr>
<td><b>构建</b></td>
<td>Bun</td>
<td>极速包管理与脚本执行&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;</td>
</tr>
<tr>
<td><b>测试</b></td>
<td>Cargo + Bun Test</td>
<td>Rust、Bun DOM 与 Playwright 三层回归&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;</td>
</tr>
</table>

### 🎯 核心架构：脚本注入模式

```
┌──────────────────────────────────────────────────────────┐
│                      Tauri 应用                           │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────┐        IPC         ┌─────────────────┐  │
│  │             │◄──────────────────►│                 │  │
│  │  Rust 后端   │                    │  WebView 前端   │  │
│  │             │                    │                 │  │
│  │  • 原生菜单  │                    │  • inject.js    │  │
│  │  • 设置仓储  │                    │  • AppRuntime   │  │
│  │  • 多显示器  │                    │  • 状态同步      │  │
│  │  • 自动更新  │                    │                 │  │
│  │             │                    │                 │ │
│  └─────────────┘                    └────────┬────────┘ │
│                                              │          │
└──────────────────────────────────────────────│──────────┘
                                               │
                              ┌────────────────▼──────────────┐
                              │ 当前匹配的阅读网站（WeRead / 插件）│
                              └───────────────────────────────┘
```

### 🧩 前端运行时

`inject.ts` 只负责防重复注入并创建 `AppRuntime`。`AppRuntime` 是注入层唯一生命周期所有者，依次初始化设置、注册/加载插件、应用站点缩放、创建 Managers、监听插件热重载；页面销毁时按逆序释放资源。

站点能力统一为 `ReaderSiteRuntime`：微信读书通过桥接器委托给既有 `WeReadAdapter`，外部插件通过包装器接入。`PluginRegistry` / `PluginLoader` 是唯一站点来源，所有 Manager 只能经 `SiteContext` 获取当前运行时。

位于 `src/scripts/managers/` 目录：

<table>
<tr>
<th width="25%">管理器</th>
<th>核心职责</th>
</tr>
<tr>
<td><code>IPCManager</code></td>
<td>🎯 发布初始及后续路由、章节和标题状态</td>
</tr>
<tr>
<td><code>AppManager</code></td>
<td>🚀 恢复当前 URL 滚动位置，处理离开阅读页时的状态收口</td>
</tr>
<tr>
<td><code>MenuManager</code></td>
<td>📋 菜单状态同步，处理菜单动作</td>
</tr>
<tr>
<td><code>StyleManager</code></td>
<td>🎨 宽屏模式，隐藏工具栏，样式注入</td>
</tr>
<tr>
<td><code>ThemeManager</code></td>
<td>🌓 深色模式与外部链接处理</td>
</tr>
<tr>
<td><code>TurnerManager</code></td>
<td>📖 翻页控制器（含子模块：自动翻页、滑动翻页、鼠标隐藏）</td>
</tr>
<tr>
<td><code>RemoteManager</code></td>
<td>🎮 遥控器与键盘输入，统一发布翻页方向事件</td>
</tr>
</table>

核心层还包括：

- `AppRuntime`：初始化、热重载和逆序销毁。
- `PluginRegistry` / `PluginLoader`：唯一站点注册与生命周期入口。
- `SiteContext`：当前 `ReaderSiteRuntime` 与可重启的双栏观察器。
- `SettingsStore`：前端合并视图、串行 patch、订阅与冲突重试；不直接读写文件。
- `EventBus` / `BaseManager`：有限状态历史和资源自动清理；瞬时翻页事件不保留历史。

### 🦀 Rust 后端

位于 `src-tauri/src/` 目录：

<table>
<tr>
<th width="25%">模块</th>
<th>核心职责</th>
</tr>
<tr>
<td><code>lib.rs</code></td>
<td>🎯 应用入口，插件初始化，脚本注入</td>
</tr>
<tr>
<td><code>commands.rs</code></td>
<td>🔌 IPC 命令定义（前后端通信接口）</td>
</tr>
<tr>
<td><code>menu.rs</code></td>
<td>📋 原生菜单构建，事件处理，多站点「书店」切换</td>
</tr>
<tr>
<td><code>sites.rs</code></td>
<td>🏪 站点首页 URL 解析（内置 + 外部插件）</td>
</tr>
<tr>
<td><code>tracker_blocker.rs</code></td>
<td>🚫 macOS 原生拦截第三方追踪域名（不拦网站自有代码）</td>
</tr>
<tr>
<td><code>monitor.rs</code></td>
<td>🖥 多显示器支持，事件驱动检测</td>
</tr>
<tr>
<td><code>plugin_manager.rs</code></td>
<td>🔌 插件校验、安装、卸载与运行时代码读取</td>
</tr>
<tr>
<td><code>settings.rs</code></td>
<td>💾 schema v2 设置仓储、版本 patch、统一锁与原子替换</td>
</tr>
<tr>
<td><code>reading_progress.rs</code></td>
<td>📍 按站点/URL 独立保存滚动位置，每站点最多 10,000 条</td>
</tr>
<tr>
<td><code>update.rs</code></td>
<td>🔄 自动更新检查与安装</td>
</tr>
</table>

### 🔌 Tauri 插件

```
tauri-plugin-opener        → 外部链接处理
tauri-plugin-dialog        → 插件选择、导出与原生确认对话框
tauri-plugin-window-state  → 各窗口位置与尺寸持久化
tauri-plugin-log           → 2 MiB 单文件、最多 3 份日志
tauri-plugin-updater       → GitHub Release 更新检查、下载与重启安装
```

---

## 📖 文档

- 🔌 [第三方插件开发指南](docs/PLUGIN_DEVELOPMENT.md) - Manifest、自声明规范、代码与样式组织、构建测试和社区验收
- 🏗 [插件与站点架构](docs/PLUGIN_ARCHITECTURE.md) - `ReaderSiteRuntime`、插件运行时与开发约束
- 🔁 [事件与生命周期](docs/EVENT_BUS_REFACTOR.md) - EventBus、BaseManager 与资源清理规范
- 🔐 [Tauri 2.11 与 IPC](docs/TAURI_2_11_UPGRADE.md) - Capability 拆分和命令一致性规则
- 🧪 [测试指南](docs/TESTING.md) - 当前测试结构与必要质量门禁
- ✍️ [软件签名](docs/CODE_SIGNING_POLICY.md) - Windows 签名角色、来源与发布约束
- 📘 [2026 架构重构记录](docs/ARCHITECTURE_REFACTOR_2026.md) - 本次重构的动机、改动和兼容边界

---

## ⚠ 免责声明

> 本项目仅为个人学习和使用的第三方客户端，与腾讯公司及微信读书团队、字节跳动公司及番茄小说团队均无任何关联

<table>
<colgroup>
<col style="width: 33%">
<col style="width: 33%">
<col style="width: 33%">
</colgroup>
<tr>
<td align="center">

### ✅ 承诺

无隐私收集<br>
无广告植入<br>
无商业用途<br>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;

</td>
<td align="center">

### 🗄 数据来源

网页内容由官方站点直接加载<br>
**weread.qq.com · fanqienovel.com**<br>
本地电子书仅读取本机文件
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;

</td>
<td align="center">

### 🙏 声明

仅供学习交流<br>
请支持正版<br>
遵守相关法律法规<br>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;

</td>
</tr>
</table>

---

## 🙏 致谢

Windows 代码签名由 [SignPath Foundation](https://signpath.org/) 免费提供 —— 感谢他们为开源项目消除 SmartScreen "未知发布者" 警告。

本地 EPUB 阅读使用 [foliate-js](https://github.com/johnfactotum/foliate-js) 核心模块，采用 MIT License。第三方许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## 📄 开源协议

[MIT License](LICENSE) © 2026

---

<div align="center">

**Built with ❤ using Rust & Tauri**

<sub>如果这个项目对你有帮助，请给个 ⭐ Star 支持一下！</sub>

</div>
