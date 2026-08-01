# Rust 测试说明

Rust 测试以源码内单元测试为主，另保留 `src-tauri/tests/plugin_test.rs` 集成测试。

## 运行

从仓库根目录执行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --test plugin_test
cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture
```

当前结果（2026-08-01）：58 个单元测试、6 个集成测试通过；1 个真实 macOS 显示会话测试 ignored。

## 覆盖

- `settings.rs`：schema v2、并发版本 patch、原子写入与失败恢复。
- `reading_progress.rs`：按 URL 独立存储、siteId、数量上限、原子失败和真实 Tauri 窗口/域名 scope。
- `plugin_manager.rs`：路径、ZIP、symlink、异常包限制、替换回滚和卸载保留进度。
- `commands.rs`：运行时域名/窗口边界、编辑器写入防护和真实 Tauri IPC metadata 分发。
- `lib.rs` / `sites.rs`：启动站点、启动 URL、站点缩放归属和插件首页解析。
- `menu.rs`：schema v2 菜单初值、缩放邻级和 mock App 菜单。
- `update.rs`：自动更新设置、周期/超时、前端返回结构和 managed state。
- `monitor.rs`：纯坐标计算；真实显示器名称单独作为真机测试。
- `plugin_test.rs`：插件 manifest、站点配置和基础结构反序列化。

旧的 `commands_test.rs`、`core_test.rs`、`menu_test.rs` 等大量“复制生产逻辑再测试副本”的测试已经删除。新的测试应尽量放在被测模块内，直接验证生产私有函数和持久化边界。

## 真机测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  monitor::tests::test_get_macos_display_names_not_empty \
  -- --ignored --nocapture
```

无头 CI 不应运行该测试。普通单元测试不能证明实际显示器、窗口、远程 ACL、更新安装或原生菜单行为。

完整门禁见 [测试与验收指南](../../docs/TESTING.md)。
