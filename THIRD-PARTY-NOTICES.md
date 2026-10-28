# 第三方开源许可

本应用基于以下开源项目构建。各项目的完整许可文本已随应用内「设置 → 关于与更新 → 开源许可」页面提供（源文件 [`src/windows/licenses.html`](src/windows/licenses.html)），并随安装包分发。

## 总览

| 组件 | 版权声明 | 许可证 |
|---|---|---|
| Tauri | Copyright (c) 2017 - Present Tauri Apps Contributors | MIT OR Apache-2.0 |
| Rust | Copyright (c) The Rust Project Contributors | MIT OR Apache-2.0 |
| TypeScript | Copyright (c) Microsoft Corporation | Apache-2.0 |
| foliate-js | Copyright (c) 2022 John Factotum | MIT |
| pdf-extract | Copyright (c) 2019 Junrui Li | MIT |

## Tauri

- 项目：https://github.com/tauri-apps/tauri
- 用途：跨平台桌面应用壳（窗口、IPC、权限与打包）
- 协议：MIT OR Apache-2.0（双许可）

## Rust

- 项目：https://www.rust-lang.org/
- 用途：应用壳层与业务逻辑的实现语言及标准库
- 协议：MIT OR Apache-2.0（双许可）

## TypeScript

- 项目：https://www.typescriptlang.org/
- 用途：前端（注入层与本地阅读器）的开发语言
- 协议：Apache-2.0

## foliate-js

- 项目：https://github.com/johnfactotum/foliate-js
- 固定提交：`78914aef4466eb960965702401634c2cb348e9b1`
- Copyright (c) 2022 John Factotum
- 用途：本地 EPUB 与 MOBI/AZW3 阅读的解析与分页内核
- 协议：MIT License
- 完整许可文本：[`third-party/foliate-js/LICENSE`](third-party/foliate-js/LICENSE)

本项目集成 EPUB 与 MOBI/AZW3 解析及分页所需的核心模块（mobi.js 含两处就地修补，见文件头注释）；PDF 文字版提取使用 pdf-extract（纯 Rust）。

## pdf-extract

- 项目：https://github.com/jrmuizel/pdf-extract
- 用途：PDF 文字版文本提取（导入时提取为纯文本并缓存）
- 协议：MIT License


## 致谢

- Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). Windows 安装包的代码签名证书由 SignPath Foundation 免费提供，详见 [`docs/CODE_SIGNING_POLICY.md`](docs/CODE_SIGNING_POLICY.md)。
