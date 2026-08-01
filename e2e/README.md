# 模拟 E2E 测试

本目录使用 Python + Playwright 在 `e2e/test-page.html` 上模拟 Tauri/WebView 行为。

## 覆盖

1. 阅读变宽切换。
2. 隐藏工具栏切换。
3. 自动翻页开关。
4. 导航离开阅读页后清除自动翻页。
5. 菜单状态同步。
6. 日志输出。

## 安装与运行

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install playwright
playwright install chromium
bun run test:e2e
```

也可直接运行：

```bash
python3 e2e/tests/test_reader_features.py
```

## 文件

```text
e2e/
├─ test-page.html
├─ tests/test_reader_features.py
└─ README.md
```

测试页提供模拟阅读 DOM、localStorage、Tauri `invoke` 和菜单事件；测试脚本启动 Chromium 并断言状态变化。

## 边界

这些测试不访问真实微信读书/Fanqie，也不启动完整 Tauri 应用，因此不能证明：

- 真实站点 DOM、登录和进度算法。
- 原生菜单、Capability/ACL。
- GitHub 签名更新。
- 窗口位置恢复或多显示器行为。
- 真机长期内存占用。

它们只用于锁定既有交互结果。完整质量门禁见 [测试与验收指南](../docs/TESTING.md)。
