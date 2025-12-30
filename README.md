<p align="center">
  <img src="title.svg" width="400px">
</p>

<p align="center">
  <b>基于 Tauri v2 + Rust 重构的高性能微信阅读桌面客户端</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/release-v0.3.0-orange?style=flat-square" alt="Release">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/Tauri-v2-24C8D5?style=flat-square&logo=tauri&logoColor=white" alt="Tauri">
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Bun-000000?style=flat-square&logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/Platform-macOS-000000?style=flat-square&logo=apple&logoColor=white" alt="Platform">
</p>

这是一个非官方的微信读书桌面客户端，旨在提供比 Web 版更原生、更沉浸的阅读体验。本项目是原 Electron 版本的重构版，使用 **Tauri v2** 和 **Rust** 重新开发，显著降低了内存占用并大幅减小了应用体积。

## ✨ 核心特性

- **极致轻量**：基于 Tauri 构建，安装包仅 ~5MB，运行时内存占用极低（相比 Electron 版本）。
- **原生体验**：
  - 适配 macOS 原生菜单栏（支持刷新、缩放、后退等操作）。
  - 自动保存窗口位置和大小，恢复中断的阅读进度。
  - 支持 Cmd+R 刷新，Cmd+[ 后退等原生快捷键。
- **阅读增强**：
  - **宽屏模式**：强制移除最大宽度限制，充分利用大屏幕空间。
  - **深色模式**：自动适配系统深色外观，提供沉浸式阅读体验。
  - **自动翻页**：支持自定义时间间隔自动翻页，防休眠逻辑。
  - **样式注入**：通过隐藏无关元素（如侧工具栏），提供纯净阅读环境。
- **模块化架构**：
  - 前端逻辑完全解耦（Core / Managers 分层设计）。
  - 后端 Rust 逻辑模块化（Settings / Commands / Menu 分离）。

## 🛠 技术栈

- **Frontend**: TypeScript (Script Injection)
- **Backend**: Rust (Tauri v2)
- **Build Tool**: Bun + Vite
- **State Management**: Singleton Store Pattern (Frontend) + File System (Backend)

## 🚀 快速开始

### 环境准备

确保你的开发环境已安装以下工具：
- [Rust](https://www.rust-lang.org/tools/install) (建议使用 stable 版本)
- [Bun](https://bun.sh/) (本项目指定包管理器)

### 安装依赖

```bash
# 安装前端依赖
bun install

# 安装 Rust 依赖（如果网络不佳，建议配置 cargo 国内源或使用 crm）
cd src-tauri
cargo check
cd ..
```

### 开发模式

启动开发服务器，支持热重载：

```bash
bun start
```

### 打包构建

本项目已配置自动化构建脚本，运行以下命令即可生成安装包：

```bash
bun run release
```
构建完成后，安装包（`.dmg` 或 `.app`）将自动复制到项目根目录的 `release/` 文件夹中。

## 📂 项目结构

```
├── src/
│   ├── scripts/
│   │   ├── core/              # 核心基础库
│   │   │   ├── settings_store.ts  # 设置状态管理 (Singleton)
│   │   │   ├── tauri.ts           # Tauri API 封装
│   │   │   └── utils.ts           # 通用工具函数
│   │   ├── managers/          # 业务逻辑模块
│   │   │   ├── app_manager.ts     # 应用级逻辑 (路由/标题/恢复进度)
│   │   │   ├── menu_manager.ts    # 菜单状态同步
│   │   │   ├── setting_manager.ts # 设置窗口管理
│   │   │   ├── style_manager.ts   # 样式注入与主题管理
│   │   │   ├── theme_manager.ts   # 链接与缩放处理
│   │   │   └── turner_manager.ts  # 自动翻页逻辑
│   │   ├── inject.ts          # 注入脚本入口 (编译为 inject.js)
│   │   └── sync_version.ts    # 版本号同步脚本
│   └── windows/               # 独立窗口页面
│       ├── about.html         # 关于页
│       ├── settings.html      # 设置页
│       └── update.html        # 检查更新页
├── src-tauri/
│   ├── src/
│   │   ├── commands.rs        # Tauri 命令定义 (IPC)
│   │   ├── lib.rs             # 库入口与插件配置
│   │   ├── main.rs            # 程序入口
│   │   ├── menu.rs            # 原生菜单构建逻辑
│   │   └── settings.rs        # 设置文件读写逻辑
│   └── tauri.conf.json        # Tauri 配置文件
├── package.json               # 项目脚本配置
└── README.md
```

## ⚠️ 免责声明

本项目仅为方便个人阅读使用的第三方客户端，与腾讯公司或微信读书团队无关。所有数据均通过官方 Web 端加载 (`weread.qq.com`)。

本项目**从未获取**任何用户隐私数据，**未进行**任何去广告或添加广告的操作，也**未从中获取**任何形式的收益。所有操作仅在本地客户端进行，纯粹为了提升阅读体验。

---
*Created with ❤️ by Rust & Tauri*
