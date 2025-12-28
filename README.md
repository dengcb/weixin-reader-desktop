# 微信读书桌面版 (Weixin Reader Desktop)

<p align="center">
  <b>基于 Tauri v2 + Rust 重构的高性能微信读书桌面客户端</b>
</p>

这是一个非官方的微信读书桌面客户端，旨在提供比 Web 版更原生、更沉浸的阅读体验。本项目是原 Electron 版本的重构版，使用 **Tauri v2** 和 **Rust** 重新开发，显著降低了内存占用并大幅减小了应用体积。

## ✨ 核心特性

- **极致轻量**：基于 Tauri 构建，安装包仅 ~5MB，运行时内存占用极低（相比 Electron 版本）。
- **原生体验**：
  - 适配 macOS 原生菜单栏（支持刷新、缩放、后退等操作）。
  - 自动保存窗口位置和大小。
  - 支持 Command+R 刷新，Command+[ 后退等原生快捷键。
- **阅读增强**：
  - **宽屏模式**：强制移除最大宽度限制，充分利用大屏幕空间。
  - **深色模式**：自动适配系统深色外观，或手动切换护眼模式。
  - **自动翻页**：支持键盘左右键翻页（模拟点击），优化翻页体验。
  - **样式注入**：通过 JS 注入隐藏无关元素（如下载提示），提供纯净阅读环境。

## 🛠 技术栈

- **Frontend**: Vanilla JavaScript (Script Injection)
- **Backend**: Rust (Tauri v2)
- **Build Tool**: Bun + Vite
- **State Management**: `tauri-plugin-store` (本地持久化)

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
bun run tauri dev
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
│   └── scripts/
│       └── inject.js      # 核心注入脚本（负责深色模式、宽屏、翻页逻辑）
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs         # 后端主入口，窗口创建与 IPC 通信
│   │   ├── menu.rs        # 原生菜单栏实现
│   │   └── main.rs        # Rust 程序入口
│   ├── tauri.conf.json    # Tauri 配置文件
│   └── Cargo.toml         # Rust 依赖配置
├── package.json           # 项目脚本配置
└── README.md
```

## ⚠️ 免责声明

本项目仅为方便个人阅读使用的第三方客户端，与腾讯公司或微信读书团队无关。所有数据均通过官方 Web 端加载 (`weread.qq.com`)。

---
*Created with ❤️ by Rust & Tauri*
