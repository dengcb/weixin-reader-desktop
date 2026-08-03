# 测试与验收指南

本文描述当前测试体系。最后核对日期：2026-08-03。

## 当前结果

| 层级 | 结果 | 说明 |
|---|---:|---|
| Bun DOM/契约测试 | 272 通过 | 32 个 TypeScript 测试文件，happy-dom + Tauri 静态契约 |
| Rust 单元测试 | 60 通过 | 设置、阅读位置、插件安全、命令边界、启动/菜单/更新与 Tauri mock |
| Rust 集成测试 | 6 通过 | `src-tauri/tests/plugin_test.rs` |
| 真机硬件测试 | 1 忽略 | 需要真实 macOS 显示会话 |
| 模拟 E2E | 6 通过 | Python Playwright + 临时 Chromium，本地 `test-page.html` |

数量是当前快照，不应当写成永久承诺；新增测试后同步本文。

## 必要质量门禁

从仓库根目录运行：

```bash
bun install --frozen-lockfile
bun run check:version
bun run typecheck
bun test
bun run check:ipc
bun run build
git diff --exit-code -- src/scripts/inject.js
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

门禁含义：

1. 依赖锁文件和版本声明一致。
2. TypeScript 严格检查无错误。
3. 前端架构、生命周期和 DOM 行为回归通过。
4. IPC handler、AppManifest、permission 和 Capability 一致。
5. `inject.js` 与 TypeScript 源码的生成结果一致，`dist/` 可构建。
6. Rust 测试通过；平台 job 继续验证实际 macOS 与 Windows 构建。

## Bun DOM 测试

### 环境

`bunfig.toml` 在运行测试前加载 `test/preload.ts`。preload 使用 `happy-dom` 提供：

- window、document、history、location。
- localStorage、sessionStorage。
- DOM Event、KeyboardEvent、WheelEvent。
- HTMLElement、MutationObserver 等浏览器对象。

类型由 `@types/bun` 提供。

### 测试文件

| 文件 | 重点 |
|---|---|
| `utils.test.ts` | CSS 注入/删除、键盘事件 |
| `scroll_state.test.ts` | 恢复完成标记、等待与超时 |
| `event_bus.test.ts` | 去重、once 异常、有限历史、模块和 AbortSignal 清理 |
| `plugin_api.test.ts` | 命名空间、样式、存储、设置字段归属、事件 |
| `plugin_registry.test.ts` | 注册、域名/扩展名匹配、活动运行时和状态 |
| `plugin_loader.test.ts` | 内置加载、启停、重载和错误处理 |
| `plugin_lifecycle.test.ts` | 样式/监听器释放、失败回滚、Blob URL、热重载残留 |
| `settings_store.test.ts` | schema v2、串行 patch、冲突重试、失败回滚、迟到 listener |
| `site_runtime.test.ts` | WeRead/外部插件统一上下文、样式/章节能力桥接、懒构造、Observer 重启 |
| `tauri.test.ts` | 动态 Tauri 桥接、等待/重试/中止和日志失败隔离 |
| `reading_position.test.ts` | 当前 URL 阅读位置 IPC 参数、空值和错误传播 |
| `base_manager.test.ts` | 模块 ID、订阅/history 清理和幂等销毁 |
| `chapter_manager.test.ts` | 章节 API、同书请求合并、20 本 LRU 缓存、迟到结果与中止清理、URL 和页数换算 |
| `ipc_manager.test.ts` | 初始阅读路由、SPA history hook、滚动保存/取消 |
| `menu_manager.test.ts` | 设置字段归属、原生菜单同步和 listener 释放 |
| `app_manager.test.ts` | 自动翻页退出复位、独立位置恢复和旧值降级 |
| `app_runtime.test.ts` | 逆序释放、热重载串行化和 generation 失效 |
| `remote_manager.test.ts` | 键盘映射、输入区隔离、捕获监听器释放 |
| `style_manager.test.ts` | manager/plugin 样式所有权、双栏规则和清理 |
| `turner_manager.test.ts` | 子组件协调、离开阅读页停翻与完整销毁 |
| `auto_flipper.test.ts` | 单栏恢复门禁、后台暂停、到底翻页和 timer 清理 |
| `cursor_hider.test.ts` | 启停、非阅读页保护、滚动锁和鼠标 listener 清理 |
| `progress_bar.test.ts` | 历史进度、DOM 重建、章节变化和销毁取消 |
| `progress_tracker.test.ts` | 官方进度初始化/重试/切书并发、经验公式、方向防抖、有符号页数、章节校准与跳章降级 |
| `toast.test.ts` | `textContent` 安全渲染、替换和动画后移除 |
| `manager_behavior.test.ts` | 滚动参数、翻页阈值、自动翻页进度事件、光标/主题清理 |
| `test/tauri_contract.test.ts` | 更新端点、窗口状态、窗口标签和 Capability 最小权限 |

### 运行方式

```bash
bun test
bun test src/scripts/core/__tests__/event_bus.test.ts
bun test src/scripts/core/__tests__/manager_behavior.test.ts
```

测试输出中有两类预期错误日志：EventBus 测试故意让回调抛错，以验证错误隔离和 once 清理；它们不代表测试失败，以最终 exit code 和 pass/fail 汇总为准。

`bun test --coverage` 当前快照为函数 72.00%、行 80.52%。这是“测试实际导入模块”的覆盖率，不是对仓库每个文件的完整覆盖；微信读书进度逻辑达到函数 91.30%、行 96.63%。

### 编写规则

- 每个测试清理 DOM、EventBus 历史、订阅、timer 和替换过的全局函数。
- Manager 生命周期测试必须显式调用 `destroy()`。
- 涉及异步注册时，覆盖“尚未注册完成就 destroy”的情况。
- 行为参数应测试精确值，例如滚动恢复重试、滑动阈值、光标延迟和自动翻页周期。
- 不要用关闭 TypeScript 严格选项来通过测试。
- 通过公共事件和运行时接口验证站点契约，避免测试直接改写生产实现。

## TypeScript 严格检查

`bun run typecheck` 运行 `scripts/typecheck.ts`，底层执行严格 `tsc --noEmit`。

全局仍开启：

- `strict`
- `noUnusedLocals`
- `noUnusedParameters`
- `noFallthroughCasesInSwitch`

3 个既有 TS6133 使用“文件 + 符号 + 可选行号”的精确白名单。脚本会同时拒绝：

- 新增的任何 TypeScript 错误。
- 新增的未使用符号。
- 白名单条目消失但脚本没有同步收紧。

不要改成忽略整个文件或关闭全局未使用检查。

## 关键行为回归

微信读书进度算法、适配器、WeRead 样式、Fanqie 页面行为和插件模板都允许正常维护，不使用源码 SHA 清单阻止修改。行为边界由针对性测试、类型检查、生成文件一致性检查和必要的真站验收共同保护。

### 微信读书进度经验公式硬约束

`progress_tracker.ts` 的初始化与页数估算来自长期真站试验，不按一般算法重写。维护时必须保留：

- 每次进入一本书，通过官方 `getProgress` 接口取得已登录用户的 `chapterIdx` 和 `chapterOffset`，并将该值作为底部进度条初始估值；任何失败分支都不能用零值覆盖已经成功取得的数据。
- `maxOffset = wordCount × 1.5 + 1000`。
- `maxPages = floor(maxOffset ÷ 800)`。
- 初始化 `progress = floor(chapterOffset ÷ maxOffset × 100)`。
- 初始化 `turningPages = floor(maxPages × progress ÷ 100)`。
- 翻页 `progress = round(turningPages ÷ maxPages × 100)`，保留负值和超过 100 的值作为跨章校准输入。
- 500ms 方向合并、至少 6 页、误差严格超过 20% 等参数均为经验值，不因代码风格或理论推导随意调整。

2026-08-02 经项目维护者授权，可在完全理解且保留上述硬约束的前提下重构相关代码。当前实现增加了基于 `chapterUid` 的相邻/目录跳转识别、进书重试、SPA 切书代次隔离，以及有界多书章节缓存。迟到请求不能覆盖新书，失败请求不能把成功的官方进度写成零；初始化顺序、四个公式和经验参数未改。

## Rust 测试

### 布局

Rust 核心测试与被测实现放在同一模块的 `#[cfg(test)]` 中，便于直接测试私有纯函数和持久化边界：

| 模块 | 重点 |
|---|---|
| `settings.rs` | 默认 schema、patch 保留、损坏重置、并发冲突、原子失败、版本溢出 |
| `reading_progress.rs` | URL hash、独立文件、siteId 校验、10,000 条上限 |
| `plugin_manager.rs` | ID/文件名/域名、路径穿越、ZIP symlink、文件数、替换回滚、卸载保留进度 |
| `commands.rs` | DNS label、编辑器文件边界、运行时插件窗口限制、真实 Tauri IPC metadata 分发 |
| `lib.rs` | 启动站点、启动 URL、rememberSite/lastPage 和站点缩放归属 |
| `menu.rs` | schema v2 菜单初值、缩放邻级与 mock App 菜单 |
| `monitor.rs` | 纯位置计算与显式真机测试 |
| `sites.rs` | 内置站点与已安装插件首页解析 |
| `update.rs` | schema v2 自动更新开关、定时策略、序列化与 managed state |
| `plugin_test.rs` | manifest/站点配置反序列化与基础结构 |

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml settings::
cargo test --manifest-path src-tauri/Cargo.toml plugin_manager::
cargo test --manifest-path src-tauri/Cargo.toml --test plugin_test
```

### 真机显示器测试

`monitor::tests::test_get_macos_display_names_not_empty` 标记为 ignored，因为无头 CI 或没有真实显示会话时不能给出可靠结论。

需要真机执行时：

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  monitor::tests::test_get_macos_display_names_not_empty \
  -- --ignored --nocapture
```

普通单元测试只验证可重复的纯计算逻辑，不把开发机硬件状态当作 CI 前提。

## IPC / Capability 一致性

`bun run check:ipc` 自动检查：

- `build.rs` AppManifest 与 `generate_handler![]` 完全一致。
- 23 个命令都有生成 permission。
- Capability permission 没有缺失或残留命令。
- `tauri.conf.json` 启用的 Capability 文件集合正确。
- `main-runtime` 的命令集合精确匹配阅读运行时白名单。
- 远程主窗口没有 FS、Shell、Updater、Dialog、Opener、窗口创建或插件管理能力。

新增命令后此检查失败时，不要绕过脚本；同步修改 handler、AppManifest、permission 和最小 Capability。

## 构建验证

`bun run build` 会：

1. 用 Bun 从 `src/scripts/inject.ts` 打包 `src/scripts/inject.js`。
2. 重建 `dist/`。
3. 复制本地窗口页面与图标。

禁止手工编辑 `inject.js`。任何 TypeScript 修改后都应重新构建，再检查工作区差异。

Rust 验证：

```bash
bun run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

## 模拟 E2E

`e2e/test-page.html` 提供模拟 Tauri/WebView 环境；`e2e/tests/test_reader_features.py` 使用 Playwright 验证：

1. 阅读变宽。
2. 隐藏工具栏。
3. 自动翻页开关。
4. 离开阅读页清除自动翻页。
5. 菜单状态同步。
6. 日志输出。

安装依赖并运行：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install playwright
playwright install chromium
bun run test:e2e
```

模拟 E2E 不访问真实微信读书或 Fanqie，也不证明 Tauri ACL、原生菜单、签名更新和硬件显示器行为。

## 真实验收边界

以下结论必须由人工或真机环境确认：

- 微信读书/Fanqie 的实际 DOM、样式和阅读进度算法。
- 远程页面 Tauri ACL 和 OAuth/登录。
- 打包后的 GitHub 更新检查、签名下载、安装和重启。
- 各窗口位置/尺寸恢复。
- 多显示器名称、移动和菜单重建。
- macOS 原生追踪器拦截效果。
- 长时间阅读后的内存曲线。

静态检查、本地单元测试和模拟 E2E 只能作为回归证据，不能替代这些验收。

## 提交前检查表

- [ ] TypeScript 严格检查通过。
- [ ] Bun 全量测试通过。
- [ ] IPC/Capability 一致性通过。
- [ ] `inject.js` 由构建生成。
- [ ] Rust test 通过。
- [ ] 文档中的接口、测试数量和文件名已同步。
- [ ] 真站/真机未验证项被明确标注。
