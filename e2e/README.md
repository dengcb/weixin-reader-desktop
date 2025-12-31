# E2E 测试文档

## 概述

本目录包含微信读书桌面版的端到端（E2E）测试，使用 Python + Playwright 编写。

## 测试覆盖范围

### 1. 阅读变宽 (`test_reader_wide_toggle`)
- 测试阅读变宽模式可以正常切换
- 验证按钮状态同步
- 验证 CSS 类名正确应用

### 2. 隐藏工具栏 (`test_hide_toolbar_toggle`)
- 测试工具栏可以隐藏/显示
- 验证设置状态正确更新
- 验证 DOM 变化正确应用

### 3. 自动翻页 (`test_auto_flip_toggle`)
- 测试自动翻页开关功能
- 验证设置持久化

### 4. 导航处理 (`test_auto_flip_clears_on_navigation`)
- 测试页面切换时的状态处理

### 5. 菜单状态同步 (`test_menu_states_sync`)
- 验证所有菜单按钮状态与设置同步

### 6. 日志输出 (`test_log_output`)
- 验证操作日志正确记录

## 运行测试

### 前提条件

1. 安装 Python 3.11+
2. 安装 Playwright:

```bash
pip3 install playwright
python3 -m playwright install chromium --with-deps
```

### 运行所有测试

```bash
python3 e2e/tests/test_reader_features.py
```

### 运行单个测试

```bash
python3 -c "from e2e.tests.test_reader_features import test_reader_wide_toggle; test_reader_wide_toggle()"
```

## 测试架构

```
e2e/
├── test-page.html      # 模拟 Tauri 环境的测试页面
└── tests/
    └── test_reader_features.py  # Playwright 测试脚本
```

### 测试页面 (`test-page.html`)

这个 HTML 页面模拟了 Tauri 应用环境：

- **Mock Tauri API**: 提供 `window.__TAURI__` 对象
- **Mock Settings Store**: 模拟前端设置存储
- **模拟阅读器界面**: 包含工具栏、内容区等元素
- **交互按钮**: 用于测试各种功能

### 测试脚本 (`test_reader_features.py`)

使用 Playwright 进行浏览器自动化测试：

- 打开测试页面
- 模拟用户交互
- 验证 DOM 变化
- 检查设置状态

## 为什么使用这种方式？

由于 Tauri 应用使用原生 macOS 菜单，Playwright 无法直接与之交互。因此我们采用以下策略：

1. **创建测试页面** - 模拟应用的 WebView 内容
2. **Mock Tauri API** - 使测试可以在普通浏览器中运行
3. **测试前端逻辑** - 验证管理器的行为和状态管理

这种方式的优点：
- 快速运行，不需要启动完整的 Tauri 应用
- 易于调试，可以在浏览器中直接查看
- 可以持续集成（CI）

## 未来改进

可以添加的测试：

1. **多显示器功能测试** - 需要实际的多显示器环境
2. **自动更新功能测试** - 需要模拟 GitHub Releases API
3. **深色模式切换** - 测试主题切换
4. **缩放功能** - 测试页面缩放

## CI 集成

可以在 GitHub Actions 中运行这些测试：

```yaml
- name: Run E2E tests
  run: |
    pip3 install playwright
    python3 -m playwright install chromium --with-deps
    python3 e2e/tests/test_reader_features.py
```
