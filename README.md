<p align="center">
  <img src="title.svg" width="400">
</p>

<p align="center">
  <b>基于 Tauri v2 + Rust 的高性能微信阅读桌面客户端</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/release-v0.4.0-orange?style=flat-square" alt="Release">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
  <img src="https://img.shields.io/github/downloads/dengcb/weixin-reader-desktop/total" alt="Downloads">
  <img src="https://img.shields.io/badge/Tauri-v2-24C8D5?style=flat-square&logo=tauri&logoColor=white" alt="Tauri">
  <img src="https://img.shields.io/badge/Rust-1.92.0-1a1a1a?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Bun-1.3.5-1a1a1a?style=flat-square&logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/Platform-macOS-1a1a1a?style=flat-square&logo=apple&logoColor=white" alt="Platform">
</p>

非官方的微信读书桌面客户端，通过脚本注入方式增强官方 Web 端体验。相比原 Electron 版本，**安装包仅 ~5MB，运行时内存占用极低**。

## 特性

- **原生体验**：macOS 原生菜单、窗口状态持久化、原生快捷键支持
- **多显示器**：菜单动态显示其他显示器名称，一键移动窗口
- **阅读增强**：宽屏模式、深色模式、自动翻页、纯净阅读环境
- **自动更新**：静默检测、一键更新，始终保持最新版本
- **网络检测**：启动时自动检测连接状态，智能回退

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | TypeScript + Vite |
| 后端 | Rust + Tauri v2 |
| 构建 | Bun |
| 存储 | 单例模式 + 文件系统 |

### Tauri 插件

- `opener` - 外部链接处理
- `store` - 前端数据存储
- `window-state` - 窗口状态持久化
- `log` - 日志记录
- `updater` - 自动更新
- `shell` - Shell 命令执行

## 快速开始

### 环境准备

```bash
# 安装 Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 安装 Bun
curl -fsSL https://bun.sh/install | bash
```

### 开发

```bash
# 安装依赖
bun install

# 启动开发模式（自动同步版本 + 热重载）
bun start

# 仅构建注入脚本
bun run build:inject

# 完整构建
bun run build
```

### 调试构建

```bash
# 快速调试（ARM）
bun run debug

# 指定架构
bun run debug:arm    # Apple Silicon
bun run debug:intel  # Intel
```

### 发布打包

```bash
# 构建所有架构
bun run release:all

# 构建指定架构
bun run release:arm    # Apple Silicon
bun run release:intel  # Intel

# 清理发布文件
bun run release:clear
```

## 架构设计

### 核心架构：脚本注入模式

通过在微信读书官方页面注入脚本实现功能增强，保持与官方网站完全兼容。

### 前端模块化

**六大管理器**（`src/scripts/managers/`）：

- `AppManager` - 路由监听、标题更新、恢复阅读进度
- `MenuManager` - 菜单状态同步、Rust 通信
- `ThemeManager` - 深色模式、链接处理、缩放控制
- `StyleManager` - 宽屏模式、工具栏隐藏、样式注入
- `TurnerManager` - 鼠标滚轮翻页、自动翻页、防休眠
- `SettingManager` - 设置窗口生命周期管理

### Rust 后端

- `lib.rs` - 应用入口、插件初始化、网络检测、脚本注入
- `commands.rs` - IPC 命令定义
- `menu.rs` - 原生菜单构建、事件处理
- `monitor.rs` - 多显示器支持（窗口定位、显示器名称获取）
- `settings.rs` - 设置文件读写（浅合并策略）
- `update.rs` - 自动更新管理

### 独立窗口

- `settings.html` - 设置页面
- `about.html` - 关于页面
- `update.html` - 检查更新页面

## 版本管理

项目使用 `package.json` 作为单一版本源。修改版本后运行：

```bash
bun run sync-version
```

## 测试

### Rust 单元测试

```bash
# 运行所有测试
cd src-tauri
cargo test

# 运行特定测试
cargo test --test monitor_test
cargo test --test core_test
```

**测试覆盖**：
- `monitor_test.rs` - 多显示器功能（坐标转换、居中计算、边界检测）
- `core_test.rs` - 核心功能（设置序列化、版本格式、窗口计算）

### E2E 测试

使用 Playwright 测试前端功能：

```bash
# 安装依赖
pip3 install playwright
python3 -m playwright install chromium --with-deps

# 运行测试
bun run test:e2e
```

**测试覆盖**：
- 阅读变宽切换
- 隐藏工具栏切换
- 自动翻页切换
- 菜单状态同步
- 页面导航处理

## 免责声明

本项目仅为方便个人阅读使用的第三方客户端，与腾讯公司或微信读书团队无关。所有数据均通过官方 Web 端加载 (`weread.qq.com`)。

本项目**从未获取**任何用户隐私数据，**未进行**任何去广告或添加广告的操作，也**未从中获取**任何形式的收益。

---

<p align="center">
  <sub>Built with ❤️ using Rust & Tauri</sub>
</p>
